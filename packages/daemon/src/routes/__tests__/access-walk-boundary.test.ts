import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { findPathPattern, walkArgs, walkScopeFrom } from '../../services/access-walk.js'
import { mountIndex } from '../../services/nested-filesystems.js'

/**
 * Story nf.1 — the wave-3 node pass's D2 (docs/LIVE-PROOF-0.4.4-wave3.md):
 * a recursive permission apply walked into an NFS mount below the dataset
 * and chowned the NFS server's export, while the confirm named only the
 * child datasets. The rule now: a recursive apply never crosses a mount
 * boundary it did not name. Named child datasets are still walked (each from
 * its own mountpoint); every other mount is excluded from every argv and
 * named in the confirm as "not changed: <path> (<fstype>)".
 *
 * FIXTURES (ruling (l): fakes print captured output; every rewrite spelled out):
 *  - the mount table: the dev mock's capture `mounts/findmnt-full.json`
 *    (`findmnt --json` on the stunt node), rewritten AT THE CALL SITE:
 *      · the NFS row `/mnt/anas-nfs` (127.0.0.1:/srv/nfs/export1, nfs4) moved
 *        to `/testpool/media/nfs` — the record's mount under the dataset;
 *      · for the named-child case, the ZFS rows `/mnttest` (mnttest) and
 *        `/mnttest/data` (mnttest/data) renamed to `/testpool/media`
 *        (testpool/media) and `/testpool/media/a` (testpool/media/a).
 *  - the child datasets: `zfs list -r -H -o name,mountpoint,acltype` rows as
 *    `access.test.ts` builds them (a and b under the path, c elsewhere, d
 *    legacy, e none).
 *  - the liveness probe: the dev mock's healthy `timeout 2 stat -f` answer;
 *    the dead server is `timeout`'s exit 124 (mounts/stat-f-exit-codes.txt).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const FINDMNT_FULL = readFileSync(join(FIXTURES, 'mounts/findmnt-full.json'), 'utf-8')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const MP = '/testpool/media'
const NFS = `${MP}/nfs`
const CHILD_A = `${MP}/a`
const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const PERMISSION_COMMANDS = ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl', FIND]
const CHILDREN_ARGS = ['list', '-r', '-H', '-o', 'name,mountpoint,acltype', '--', 'testpool/media']
const CHILDREN = [
  'testpool/media\t/testpool/media\toff',
  'testpool/media/a\t/testpool/media/a\toff',
  'testpool/media/b\t/testpool/media/b\tposixacl',
  'testpool/media/c\t/srv/c\toff',
  'testpool/media/d\tlegacy\toff',
  'testpool/media/e\tnone\toff',
  '',
].join('\n')

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

/** The capture with its NFS mount moved under the dataset. */
const FINDMNT_NFS_UNDER = rewrite(FINDMNT_FULL, '"target": "/mnt/anas-nfs"', `"target": "${NFS}"`)
/** …and the capture's ZFS pool and child renamed onto testpool/media and its child a. */
const FINDMNT_NFS_AND_CHILD = [
  ['"target": "/mnttest/data"', `"target": "${CHILD_A}"`],
  ['"source": "mnttest/data"', '"source": "testpool/media/a"'],
  ['"target": "/mnttest"', `"target": "${MP}"`],
  ['"source": "mnttest"', '"source": "testpool/media"'],
].reduce((text, [from, to]) => rewrite(text, from, to), FINDMNT_NFS_UNDER)

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

interface Call { command: string, args: string[] }

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('nf.1 — a recursive apply never crosses a mount it did not name (wave-3 D2)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let calls: Call[] = []
  /** What `findmnt --json` and the liveness probe answer right now. */
  let findmnt = FINDMNT_NFS_UNDER
  let probe: ExecResult | null = null

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function serve(table: string): void {
    findmnt = table
    probe = null
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command: string, args: string[], opts?: unknown): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === FINDMNT && args.join(' ') === '--json')
        return ok(findmnt)
      if (command === '/usr/sbin/zfs' && args.join(' ') === CHILDREN_ARGS.join(' '))
        return ok(CHILDREN)
      if (command === '/usr/bin/timeout' && probe)
        return probe
      return orig(command, args, opts as never)
    }
  }

  const put = (body: unknown, code?: string) => server!.inject({
    method: 'PUT',
    url: '/v1/pools/testpool/datasets/media/access',
    headers: { ...JSON_HEADERS, ...(code ? { 'x-anas-confirm': code } : {}) },
    payload: JSON.stringify(body),
  })

  /** 409 + code, then the resend; returns the challenge body and the finished job. */
  async function confirmedJob(body: unknown): Promise<{ warnings: string[], job: Job }> {
    const first = await put(body)
    assert.equal(first.statusCode, 409, first.body)
    const warnings = (first.json().error as { warnings: string[] }).warnings
    const res = await put(body, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    return { warnings, job: await waitForJob(server!, (res.json() as JobAccepted).job.id) }
  }

  const walks = (): string[][] => calls.filter(c => c.command === FIND).map(c => c.args)

  const NAMED = {
    owner: 'nobody',
    entries: [
      { kind: 'owner', level: 'read-write' },
      { kind: 'owning-group', level: 'read' },
      { kind: 'everyone', level: 'read' },
      { kind: 'user', name: 'alice', level: 'read' },
    ],
    applyToExisting: true,
  }

  it('the record\'s repro: an NFS mount under the dataset is pruned from EVERY walk, and the confirm and the result name it', async () => {
    serve(FINDMNT_NFS_UNDER)
    const { warnings, job } = await confirmedJob(NAMED)
    assert.ok(warnings.includes(`It does not enter the other filesystems mounted under '${MP}' — not changed: ${NFS} (nfs4).`), JSON.stringify(warnings))
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual((job.result as { notChanged?: string[] }).notChanged, [`${NFS} (nfs4)`])

    // Four steps (chown, access ACL, default ACL, setgid; one root): every
    // one a bounded find that prunes the NFS mount and stays on its device.
    const all = walks()
    assert.equal(all.length, 4)
    for (const args of all) {
      assert.deepEqual(args.slice(0, 8), ['-P', MP, '-xdev', '(', '-path', NFS, ')', '-prune'], args.join(' '))
      // The mount appears ONLY as the pruned pattern — never as a start, never in an action.
      assert.equal(args.filter(a => a.includes(NFS)).length, 1, args.join(' '))
    }
    // No tool walks on its own (`-R` crosses mounts), and none names the mount.
    for (const c of calls.filter(c => PERMISSION_COMMANDS.includes(c.command) && c.command !== FIND))
      assert.ok(!c.args.includes('-R') && !c.args.some(a => a.includes(NFS)), `${c.command} ${c.args.join(' ')}`)
  })

  it('the chown argv, run for real on a scratch tree, never reaches the excluded mount — its own top directory included', () => {
    // The prune is a path pattern, so a directory stands in for the mount;
    // `-xdev` cannot be exercised without a real mount and is pinned above.
    const scope = walkScopeFrom(MP, mountIndex(FINDMNT_NFS_UNDER), [])
    const [root] = scope.roots
    const args = walkArgs(root, [], ['/usr/bin/chown', '-h', 'nobody'])
    const tree = mkdtempSync(join(tmpdir(), 'anas-nf1-'))
    try {
      for (const d of ['nfs/tree/d0', 'keep/sub'])
        mkdirSync(join(tree, d), { recursive: true })
      writeFileSync(join(tree, 'nfs/f0'), '')
      writeFileSync(join(tree, 'nfs/tree/d0/f0'), '')
      writeFileSync(join(tree, 'keep/sub/f'), '')
      const at = args.indexOf('-exec')
      const real = [...args.slice(0, at + 1), '/usr/bin/echo', '{}', '+'].map(a => a === MP ? tree : a.replace(MP, findPathPattern(tree)))
      const seen = execFileSync(FIND, real, { encoding: 'utf-8' }).trim().split(/\s+/)
      assert.ok(seen.includes(tree) && seen.includes(join(tree, 'keep/sub/f')), seen.join(' '))
      assert.equal(seen.filter(p => p === join(tree, 'nfs') || p.startsWith(`${join(tree, 'nfs')}/`)).length, 0, seen.join(' '))
    }
    finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  it('a named child dataset is still walked — from its own mountpoint — while the NFS mount stays out', async () => {
    serve(FINDMNT_NFS_AND_CHILD)
    const { warnings, job } = await confirmedJob(NAMED)
    assert.ok(warnings.includes(`It crosses the child datasets mounted under '${MP}': testpool/media/a (/testpool/media/a), testpool/media/b (/testpool/media/b).`), JSON.stringify(warnings))
    assert.ok(warnings.some(w => w.includes(`not changed: ${NFS} (nfs4)`)), JSON.stringify(warnings))
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const chown = walks().filter(a => a.includes('/usr/bin/chown'))
    assert.deepEqual(chown, [
      // The dataset: its own .zfs, the child (walked on its own) and the NFS mount pruned.
      ['-P', MP, '-xdev', '(', '-path', `${MP}/.zfs`, '-o', '-path', CHILD_A, '-o', '-path', NFS, ')', '-prune', '-o', '-exec', '/usr/bin/chown', '-h', 'nobody', '{}', '+'],
      // The child, from its own mountpoint, on its own device.
      ['-P', CHILD_A, '-xdev', '(', '-path', `${CHILD_A}/.zfs`, ')', '-prune', '-o', '-exec', '/usr/bin/chown', '-h', 'nobody', '{}', '+'],
    ])
    // Every step covers both roots.
    for (const tool of ['/usr/bin/chown', '/usr/bin/setfacl', '/usr/bin/chmod'])
      assert.ok(walks().some(a => a[1] === CHILD_A && a.includes(tool)), `${tool} walks the child`)
    assert.ok(!walks().some(a => a[1] === NFS), 'the NFS mount is never a walk root')
    // The child's ACLs were switched on first (a has acltype=off).
    assert.deepEqual((job.result as { childAclEnabled?: string[] }).childAclEnabled, ['testpool/media/a'])
  })

  it('a dead NFS server below the tree refuses the job before anything is changed', async () => {
    serve(FINDMNT_NFS_UNDER)
    const first = await put(NAMED)
    probe = { stdout: '', stderr: '', exitCode: 124 }
    const res = await put(NAMED, first.headers['x-anas-confirm-code'] as string)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, new RegExp(`^No permissions were changed: ${NFS} \\(nfs4\\), mounted under '${MP}', did not answer a 2 s liveness probe`))
    assert.equal(calls.some(c => PERMISSION_COMMANDS.includes(c.command)), false, 'no chown, chmod, setfacl or find ran')
    assert.equal(calls.some(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set'), false, 'no ACL switch flipped')
  })

  it('a mount that appears under the tree after the confirm moves the scope: the resend is refused, nothing runs', async () => {
    serve(FINDMNT_FULL)
    const first = await put(NAMED)
    assert.equal(first.statusCode, 409)
    assert.equal((first.json().error.warnings as string[]).some(w => w.includes('not changed')), false)
    findmnt = FINDMNT_NFS_UNDER
    const res = await put(NAMED, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'STATE_CHANGED')
    assert.ok((res.json().error.warnings as string[]).some(w => w.includes(`not changed: ${NFS} (nfs4)`)), res.body)
    assert.equal(calls.some(c => PERMISSION_COMMANDS.includes(c.command)), false)
  })

  it('an unreadable mount table refuses the recursive change at the door', async () => {
    serve('not json')
    const res = await put(NAMED)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /the mount table could not be read \(findmnt answered in an unknown shape\)/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })
})

describe('nf.1 — the walk scope (access-walk.ts)', () => {
  it('a btrfs root has no -xdev (subvolumes are not mounts); a mount inside an excluded one is never listed', () => {
    const table = JSON.stringify({ filesystems: [
      { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
      { target: '/mnt/anas-ahr/ahr0', source: '/dev/mapper/ahr0-ahr0--vol', fstype: 'btrfs', options: 'rw', children: [
        { target: '/mnt/anas-ahr/ahr0/ext', source: '127.0.0.1:/x', fstype: 'nfs4', options: 'rw', children: [
          { target: '/mnt/anas-ahr/ahr0/ext/deeper', source: 'tmpfs', fstype: 'tmpfs', options: 'rw' },
        ] },
      ] },
    ] })
    const scope = walkScopeFrom('/mnt/anas-ahr/ahr0', mountIndex(table), [])
    assert.deepEqual(scope.roots, [{ path: '/mnt/anas-ahr/ahr0', xdev: false, prune: ['/mnt/anas-ahr/ahr0/ext'] }])
    assert.deepEqual(scope.excluded, [{ target: '/mnt/anas-ahr/ahr0/ext', fstype: 'nfs4' }])
  })

  it('a ZFS child that is not the dataset mounted at its path is a stranger: excluded, not a root', () => {
    const table = JSON.stringify({ filesystems: [
      { target: '/tank', source: 'tank', fstype: 'zfs', options: 'rw', children: [
        { target: '/tank/b', source: 'otherpool/b', fstype: 'zfs', options: 'rw' },
      ] },
    ] })
    const scope = walkScopeFrom('/tank', mountIndex(table), [{ name: 'tank/b', mountpoint: '/tank/b' }])
    assert.deepEqual(scope.roots.map(r => r.path), ['/tank'])
    assert.deepEqual(scope.excluded, [{ target: '/tank/b', fstype: 'zfs' }])
    assert.deepEqual(scope.crossed, [])
  })

  it('a mountpoint with glob characters is pruned as itself', () => {
    assert.equal(findPathPattern('/tank/we[ir]d*?\\x'), '/tank/we\\[ir\\]d\\*\\?\\\\x')
    const args = walkArgs({ path: '/tank', xdev: true, prune: ['/tank/a*'] }, ['-type', 'd'], ['/usr/bin/chmod', 'g+s'])
    assert.deepEqual(args, ['-P', '/tank', '-xdev', '(', '-path', '/tank/a\\*', ')', '-prune', '-o', '-type', 'd', '-exec', '/usr/bin/chmod', 'g+s', '{}', '+'])
  })
})
