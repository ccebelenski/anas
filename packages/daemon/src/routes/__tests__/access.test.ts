import type { AccessEntry, DatasetAccess, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { WalkRun } from './real-path-echo.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants as FS_CONSTANTS, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SetAccessRequest } from '@anas/shared'
import { zfsListArgs } from '../../parsers/zfs-list.js'
import { createServer as createDevServer } from '../../server.js'
import { PINNED_DIR } from '../../services/access.js'
import { echoRealPaths, pinnedPaths, walkRuns } from './real-path-echo.js'

/** cr3.shares H2: the dev server, with `realpath -e` naming each plain test directory as itself. */
const createServer = (...a: Parameters<typeof createDevServer>): ReturnType<typeof createDevServer> => echoRealPaths(createDevServer(...a))

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

interface Call { command: string, args: string[] }
interface Stub { command: string, args?: string[], result: ExecResult }

/**
 * Wrap the mock executor to (a) record every command/args issued and (b) return
 * canned results for chosen commands (stubs) before delegating. This lets a test
 * pose the dataset as acltype=posixacl (or off), with specific getfacl output,
 * that the fixed dev fixtures can't model — while still asserting the exact
 * setfacl/chmod/chown/zfs argument arrays the route constructs.
 */
function installExecutor(server: ReturnType<typeof createServer>, stubs: Stub[] = []): Call[] {
  const mock = (server as any).executor as MockExecutor
  const calls: Call[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[], opts?: Parameters<MockExecutor['exec']>[2]): Promise<ExecResult> => {
    calls.push({ command, args })
    const stub = stubs.find(s =>
      s.command === command
      && (s.args === undefined
        || (s.args.length === args.length && s.args.every((a, i) => a === args[i]))),
    )
    if (stub)
      return stub.result
    return orig(command, args, opts)
  }
  return calls
}

const ACLTYPE_MEDIA = ['get', '-Hp', '-o', 'value', 'acltype', '--', 'testpool/media']
const MP = '/testpool/media'

/**
 * cr3.shares, fourth review: a recursive apply is ONE run of the walk helper
 * (anas-acl-walk) over the pinned roots — the dev mock answers it and these
 * tests read the job the writer sent ({@link walkRuns}). Every step's spec is
 * a field of that job; the helper itself is proven for real in
 * services/__tests__/access-acl-walk.test.ts.
 */
function walkJob(): WalkRun['job'] {
  const runs = walkRuns()
  assert.equal(runs.length, 1, `one walk: ${JSON.stringify(runs)}`)
  return runs[0].job
}

/** The steps a walk job asks for, by name. */
function walkSteps(job: WalkRun['job']): string[] {
  return Object.keys(job).filter(k => k !== 'roots' && k !== 'tools').sort()
}

const HELPER = fileURLToPath(new URL('../../services/anas-acl-walk.pl', import.meta.url))
/** Linux's O_PATH (asm-generic/fcntl.h; node's fs.constants does not carry it). */
const O_PATH = 0o10000000

/**
 * Run the REAL helper with a recorded job's steps over `dir` (opened at fd 3,
 * exactly as the writer hands a root over); `tools` replaces the job's.
 */
function runHelperOn(job: WalkRun['job'], dir: string, tools?: WalkRun['job']['tools']): Record<string, unknown> {
  const fd = openSync(dir, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW)
  try {
    const st = statSync(dir)
    const { chown: _chown, ...steps } = job
    const real = { ...steps, roots: [{ fd: 3, path: dir, dev: st.dev, ino: st.ino }], tools: tools ?? job.tools }
    const r = spawnSync('perl', [HELPER], { input: JSON.stringify(real), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe', fd] })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    return JSON.parse(r.stdout) as Record<string, unknown>
  }
  finally {
    closeSync(fd)
  }
}

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function find(calls: Call[], command: string, pred: (a: string[]) => boolean): string[] | undefined {
  return calls.find(c => c.command === command && pred(c.args))?.args
}

interface Put { method: 'PUT', url: string, headers: Record<string, string>, payload: string }

/**
 * Operator ruling 2026-10-11: a recursive apply (`applyToExisting`) is a
 * Level 2 dangerous operation. The first PUT answers 409 + X-Anas-Confirm-Code
 * (asserted here); the resend with the code is the response returned.
 */
async function injectConfirmed(server: ReturnType<typeof createServer>, opts: Put) {
  const first = await server.inject(opts)
  assert.equal(first.statusCode, 409, first.body)
  assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
  const code = first.headers['x-anas-confirm-code']
  assert.ok(typeof code === 'string' && code.length > 0, 'the 409 carries X-Anas-Confirm-Code')
  return server.inject({ ...opts, headers: { ...opts.headers, 'x-anas-confirm': code } })
}

describe('access routes', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- GET /access -------------------------------------------------------
  describe('GET /v1/pools/:name/datasets/*path/access', () => {
    it('maps a live POSIX ACL into base + named entries', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclSupported, true)
      assert.equal(data.aclEnabled, true)
      assert.equal(data.owner, 'root')
      assert.ok(data.aclText && data.aclText.includes('user::rwx'))

      const byKind = (kind: string, name?: string) =>
        data.entries.find((e: AccessEntry) => e.kind === kind && e.name === name)
      assert.equal(byKind('owner')?.level, 'read-write') // user::rwx
      assert.equal(byKind('owning-group')?.level, 'read') // group::r-x
      assert.equal(byKind('everyone')?.level, 'none') // other::---
      assert.equal(byKind('user', 'alice')?.level, 'read-write') // user:alice:rwx
    })

    it('flags a named entry whose uid no longer resolves as unresolved', async () => {
      server = createServer({ mock: true, logger: false })
      // A user deleted outside ANAS leaves a bare-numeric ACL entry.
      installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(
          'user::rwx\nuser:1002:r-x\ngroup::r-x\nmask::rwx\nother::---\n',
        ) },
      ])

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      const orphan = data.entries.find((e: AccessEntry) => e.kind === 'user' && e.name === '1002')
      assert.ok(orphan, 'numeric named entry present')
      assert.equal(orphan?.unresolved, true)
      assert.equal(orphan?.level, 'read')
    })

    it('derives base three from mode bits when ACLs are disabled', async () => {
      server = createServer({ mock: true, logger: false })
      // acltype fixture is 'off' → mode-only path; stat fixture is 755.
      installExecutor(server)

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclEnabled, false)
      assert.equal(data.aclText, null)
      assert.equal(data.entries.length, 3)
      assert.equal(data.entries.find(e => e.kind === 'owner')?.level, 'read-write') // 7
      assert.equal(data.entries.find(e => e.kind === 'owning-group')?.level, 'read') // 5
      assert.equal(data.entries.find(e => e.kind === 'everyone')?.level, 'read') // 5
    })

    it('404s for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/nope/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
    })

    it('404s for a non-filesystem (volume / unmounted) dataset', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{
        command: '/usr/sbin/zfs',
        args: ['get', '-j', 'all', '--', 'testpool/vol'],
        result: ok(JSON.stringify({ datasets: { 'testpool/vol': { name: 'testpool/vol', type: 'VOLUME', properties: {} } } })),
      }])
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/vol/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
      assert.match(res.json().error.message, /not a mounted filesystem/)
    })
  })

  // --- PUT /access: base-only (mode bits) --------------------------------
  describe('PUT /v1/pools/:name/datasets/*path/access — base only', () => {
    it('issues a single chmod and no ACL commands', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'fs.setAccess')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      // owner=rwx(7), group=r-x(5), everyone=---(0) → 750
      assert.deepEqual(find(calls, '/usr/bin/chmod', () => true), ['750', '--', PINNED_DIR])
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
    })

    it('recursive base-only chmod uses symbolic X, not a blanket numeric +x', async () => {
      // A recursive Read grant must not sprinkle execute onto plain data files:
      // the base-only chmod uses capital X so only directories gain execute.
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server) // acltype 'off' → base-only path

      const res = await injectConfirmed(server, {
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          entries: [
            { kind: 'owner', level: 'read-write' },
            { kind: 'owning-group', level: 'read' },
            { kind: 'everyone', level: 'read' },
          ],
          applyToExisting: true,
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      // Symbolic mode with X (owner rwX, group rX, other rX) — never a numeric octal.
      assert.equal(walkJob().mode, 'u=rwX,g=rX,o=rX')
      assert.deepEqual(walkSteps(walkJob()), ['mode'])
      assert.equal(calls.some(c => c.command === '/usr/bin/chmod' && isPermissionWrite(c)), false, 'no chmod -R: the walk is the helper (nf.1, fourth review)')
      assert.equal(find(calls, '/usr/bin/chmod', a => /^[0-7]{3,4}$/.test(a[0] ?? '')), undefined)
    })
  })

  // --- PUT /access: base-level fallback reads the real ACL, not the mask --
  describe('PUT /v1/pools/:name/datasets/*path/access — ACL mask fallback', () => {
    it('an omitted owning-group falls back to group::, not the ACL mask', async () => {
      // acltype=posixacl, group::r-x (read) but mask::rwx so the mode group digit
      // is 7 (rwx). A PUT that omits owning-group must keep it at read (g::r-x),
      // NOT escalate it to read-write by reading the mask digit off the mode.
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        // stat reports mode 775 — group digit 7 is the MASK, not group::.
        { command: '/usr/bin/stat', args: ['-c', '%U %G %a', MP], result: ok('root root 775\n') },
        // Live ACL: real owning-group level is r-x (read), mask is rwx.
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(
          'user::rwx\ngroup::r-x\nmask::rwx\nother::---\n',
        ) },
      ])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        // Omits owning-group; includes a named entry so the setfacl --set path runs.
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'everyone', level: 'none' },
          { kind: 'user', name: 'alice', level: 'read-write' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      const setArgs = find(calls, '/usr/bin/setfacl', a => a[0] === '--set')
      assert.ok(setArgs, 'setfacl --set was issued')
      const spec = setArgs![1]
      assert.ok(spec.includes('g::r-x'), `spec keeps group at read: ${spec}`)
      assert.ok(!spec.includes('g::rwx'), `spec must NOT escalate group to rwx: ${spec}`)
      assert.equal(spec, 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx')
    })
  })

  // --- PUT /access: add a named user on an acltype=off dataset ------------
  describe('PUT /v1/pools/:name/datasets/*path/access — named grant', () => {
    it('enables acltype, sets the access + default ACL, and sets setgid', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server) // acltype fixture 'off'

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
          { kind: 'user', name: 'alice', level: 'read-write' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
      assert.equal((job.result as { aclAutoEnabled: boolean }).aclAutoEnabled, true)

      // acltype auto-enabled first.
      assert.deepEqual(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), ['set', '--', 'acltype=posixacl', 'xattr=sa', 'testpool/media'])

      const expectSpec = 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx'
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', expectSpec, '--', PINNED_DIR])
      // cr3.shares M3: the default ACL gains only the principal granted.
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-d'), ['-d', '-m', 'u:alice:rwx,m::rwx', '--', PINNED_DIR])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g+s')), ['g+s', '--', PINNED_DIR])
    })

    it('fails the job clearly when the acl package is absent', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['--version'], result: { stdout: '', stderr: 'not found', exitCode: 127 } }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [{ kind: 'user', name: 'alice', level: 'read-write' }] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /acl package/)
    })

    it('cr.53 L27: a FAILED acl-package probe answers the request but is NOT cached — the next request probes again and the grant runs', async () => {
      server = createServer({ mock: true, logger: false })
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const orig = mock.exec.bind(mock)
      let probes = 0
      // Every probe fails until the flip — then every probe answers, the shape
      // of a fork/EAGAIN blip that ends. `packagePresent` flips between requests
      // so both halves are deterministic (plan and job see the same answer).
      let packagePresent = false
      const calls: Call[] = []
      mock.exec = async (command, args) => {
        calls.push({ command, args })
        if (command === '/usr/bin/getfacl' && args.length === 1 && args[0] === '--version') {
          probes++
          if (!packagePresent)
            return { stdout: '', stderr: 'mock: transient probe failure', exitCode: 127 }
          return ok('getfacl 2.3.2\n')
        }
        return orig(command, args)
      }
      const put = () => server!.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [{ kind: 'user', name: 'alice', level: 'read-write' }] }),
      })

      // The failed probe answers THIS request: a named grant needs the acl package.
      const first = await put()
      assert.equal(first.statusCode, 202)
      const job1 = await waitForJob(server, (first.json() as JobAccepted).job.id)
      assert.equal(job1.status, 'failed')
      assert.match(job1.error!.message, /acl package/)

      // And nothing was cached: the next request probes again, sees the package, and grants.
      // (Under the old cache-everything memo this job failed `/acl package/` forever.)
      packagePresent = true
      const second = await put()
      assert.equal(second.statusCode, 202)
      const job2 = await waitForJob(server, (second.json() as JobAccepted).job.id)
      assert.equal(job2.status, 'completed', JSON.stringify(job2.error))
      assert.ok(probes >= 2, 'the second request probed again — the failure was not memoized')
      assert.ok(calls.some(c => c.command === '/usr/bin/setfacl'), 'the grant ran its setfacl argv')
    })
  })

  // --- PUT /access: remove all named entries (back to mode bits) ----------
  // Removal is EXPLICIT (#37): `clearNamed: true`. An entries list that simply
  // carries no named row means "not changing the grants" — see the regression
  // suite below for why an empty list must never be read as "delete them all".
  describe('PUT /v1/pools/:name/datasets/*path/access — remove named', () => {
    it('clears the ACL then chmods when clearNamed is requested on an ACL dataset', async () => {
      server = createServer({ mock: true, logger: false })
      // Pose the dataset as posixacl with a live named entry (server fixture
      // getfacl -pcE returns alice), so the explicit clear must strip it.
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ clearNamed: true, entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
      assert.equal((job.result as { clearedNamed: boolean }).clearedNamed, true)

      // cr3.shares M3: the access ACL becomes its base three alone (the new
      // levels: 7,5,5 — no chmod needed), and ONLY the removed principal leaves
      // the default ACL (`-n`: its mask as found); nothing else is cleared. The
      // directory carries no setgid bit (755), so none is dropped.
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', 'u::rwx,g::r-x,o::r-x', '--', PINNED_DIR])
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a.includes('-x')), ['-n', '-d', '-x', 'u:alice', '--', PINNED_DIR])
      assert.equal(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), undefined)
      assert.equal(find(calls, '/usr/bin/chmod', () => true), undefined)
    })

    it('recursively clears the ACL then folds setgid-drop into a single chmod walk', async () => {
      server = createServer({ mock: true, logger: false })
      // Same posixacl dataset with a live named entry, but applyToExisting so the
      // whole subtree is walked. The setgid-clear must ride along with the mode
      // chmod (one `-R` traversal), not be a second independent recursive walk.
      installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await injectConfirmed(server, {
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ clearNamed: true, entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
        ], applyToExisting: true }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      // The ACL clear (setfacl -b -k) and the mode, in ONE walk: the base
      // perms only — cr3.shares N3 (third review): a clear never removes
      // setgid (ANAS cannot tell its own from an administrator's). Was:
      // `u=rwX,g=rX,o=rX,g-s`.
      const walked = walkJob()
      assert.deepEqual(walkSteps(walked), ['clear', 'mode'])
      assert.equal(walked.clear, true)
      assert.equal(walked.mode, 'u=rwX,g=rX,o=rX')
      assert.equal(JSON.stringify(walked).includes('g-s'), false, 'no g-s anywhere')
    })
  })

  // --- #37: named grants are never destroyed by omission ------------------
  //
  // The bug: the Permissions dialog's pre-fill failed open (warn + null), the
  // window stayed live with hard-coded defaults and an EMPTY named grid, and
  // Apply sent that empty list. The daemon read "no named entries + base
  // changed" as "delete every named grant", stripped the ACL, and reported the
  // job as a success. The contract now: absence is not intent.
  describe('PUT /v1/pools/:name/datasets/*path/access — implicit-clear guard (#37)', () => {
    it('a base-only update with no named entries LEAVES existing named ACLs alone', async () => {
      server = createServer({ mock: true, logger: false })
      // posixacl dataset whose live ACL grants alice rwx (server fixture).
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        // The payload the fail-open dialog used to send, with one base level
        // actually moved (everyone ---  -> read; cr3.shares M3: an edit that
        // moves nothing runs no command at all).
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      // NOTHING is stripped: no `setfacl -b`, no setgid drop.
      assert.equal(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), undefined)
      assert.equal(find(calls, '/usr/bin/chmod', a => a.includes('g-s')), undefined)
      // alice survives, restated in the declarative set alongside the new base
      // levels — and the base lands on `g::`, not on the ACL mask a chmod would
      // have moved instead.
      const spec = find(calls, '/usr/bin/setfacl', a => a[0] === '--set')
      assert.deepEqual(spec, ['--set', 'u::rwx,g::r-x,o::r-x,u:alice:rwx,m::rwx', '--', PINNED_DIR])
      assert.equal((job.result as { namedCount: number }).namedCount, 1)
    })

    it('an owner-only update touches neither the ACL nor the mode bits', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ owner: 'media' }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      assert.deepEqual(find(calls, '/usr/bin/chown', () => true), ['media', '--', PINNED_DIR])
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      assert.equal(find(calls, '/usr/bin/chmod', () => true), undefined)
    })

    it('the request schema requires an explicit flag for a destructive clear', async () => {
      // Class guard: a list-valued field whose emptiness would destroy data must
      // never carry that meaning implicitly. Asserted on the SCHEMA so a future
      // field that infers "clear" from an empty list is caught here.
      const noFlag = SetAccessRequest.parse({ entries: [{ kind: 'owner', level: 'read' }] })
      assert.equal(noFlag.clearNamed, undefined, 'an empty named list carries no clear intent')
      assert.equal(SetAccessRequest.parse({ clearNamed: true }).clearNamed, true)
      // The flag and named entries are contradictory — refused at the boundary.
      const contradiction = SetAccessRequest.safeParse({
        clearNamed: true,
        entries: [{ kind: 'user', name: 'alice', level: 'read' }],
      })
      assert.equal(contradiction.success, false)
    })

    it('an unreadable getfacl is reported as degraded, not as healthy ACLs', async () => {
      server = createServer({ mock: true, logger: false })
      // acltype says posixacl but the ACL itself cannot be read.
      installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } },
      ])

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclDegraded, true, 'the degradation is surfaced')
      // The entries are a mode-bit approximation with no named grants in them —
      // reporting aclEnabled:true would invite the client to apply that as truth.
      assert.equal(data.aclEnabled, false)
      assert.equal(data.entries.length, 3)
    })

    // cr.37 review (D1): the write plan refuses on the same unreadable ACL the
    // GET reports as degraded and the share grant refuses on. Planning from
    // the mode bits would let a named request run `setfacl --set` / `-R -b -m`
    // and strip every named grant nobody read.
    it('a named grant is refused when the ACL cannot be read — an unreadable getfacl never plans a write', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } },
      ])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [{ kind: 'user', name: 'alice', level: 'read-write' }] }),
      })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.match(res.json().error.message, /Could not read the POSIX ACLs/)
      // Nothing ran — no strip, no chown, no chmod.
      assert.equal(calls.some(c => ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl', '/usr/bin/find', '/usr/bin/perl'].includes(c.command)), false, JSON.stringify(calls))
    })

    it('a base-only update is refused too — its levels would be computed off the ACL mask', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } },
      ])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
        ] }),
      })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(calls.some(c => ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl', '/usr/bin/find', '/usr/bin/perl'].includes(c.command)), false, JSON.stringify(calls))
    })
  })

  // --- PUT /access: applyToExisting recurses ------------------------------
  describe('PUT /v1/pools/:name/datasets/*path/access — applyToExisting', () => {
    it('walks chown and setfacl (access + default) in one helper run, directories only for g+s, using X for read', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server) // acltype 'off'

      const res = await injectConfirmed(server, {
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          owner: 'media',
          entries: [
            { kind: 'owner', level: 'read-write' },
            { kind: 'owning-group', level: 'read' },
            { kind: 'everyone', level: 'read' },
            { kind: 'user', name: 'alice', level: 'read' },
          ],
          applyToExisting: true,
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      // ONE walk (the helper applies each step to files and directories, the
      // default ACL and setgid to directories only — access-acl-walk.test.ts).
      const walked = walkJob()
      assert.deepEqual(walkSteps(walked), ['acl', 'chown', 'defaultAcl', 'setgid'])
      assert.deepEqual(walked.roots.map(r => [r.fd, r.path]), [[3, MP]])
      assert.deepEqual(walked.tools, { chown: '/usr/bin/chown', chmod: '/usr/bin/chmod', setfacl: '/usr/bin/setfacl' })
      assert.equal(walked.chown, 'media')
      // Recursive → every execute bit is capital X, the mask too, so plain
      // files gain no execute; `-b -m` resolves X per file against its own bits.
      assert.equal(walked.acl, 'u::rwX,g::r-X,o::r-X,u:alice:r-X,m::rwX')
      // The default ACL sits on directories only: the lowercase form is what is stored.
      assert.equal(walked.defaultAcl, 'u::rwx,g::r-x,o::r-x,u:alice:r-x,m::rwx')
      assert.equal(walked.setgid, true)
      assert.equal(find(calls, '/usr/bin/chmod', a => a.includes('g+s')), undefined, 'no chmod g+s over the whole tree')
      // No tool walks on its own: `-R` crosses every mount (nf.1).
      assert.equal(calls.some(c => ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl'].includes(c.command) && c.args.includes('-R')), false)
    })

    it('a recursive read-write grant carries no lowercase x and never sets setgid on a regular file', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await injectConfirmed(server, {
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          entries: [
            { kind: 'owner', level: 'read-write' },
            { kind: 'owning-group', level: 'read-write' },
            { kind: 'everyone', level: 'read' },
            { kind: 'user', name: 'alice', level: 'read-write' },
            { kind: 'group', name: 'media', level: 'read-write' },
          ],
          applyToExisting: true,
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')

      // (a) One literal x in the walk's spec turns every X into x (live proof
      // 0.4.3 §3x): the access spec of the recursive walk has none.
      const walked = walkJob()
      const walkSpec = walked.acl ?? ''
      assert.equal(walkSpec, 'u::rwX,g::rwX,o::r-X,u:alice:rwX,g:media:rwX,m::rwX')
      assert.equal(walkSpec.includes('x'), false, `no lowercase x in ${walkSpec}`)
      assert.equal(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), undefined, 'the walk never uses --set (it would strip execute from executables)')

      // (b) The only setgid change is the walk's directories-only step: no
      // chmod anywhere carries g+s.
      assert.equal(calls.some(c => c.command === '/usr/bin/chmod' && c.args.includes('g+s')), false, 'no chmod g+s over the tree')
      assert.equal(walked.setgid, true, 'the setgid step ran')

      // (c) Run that job's steps with the REAL helper over a real tree: the
      // directories get setgid, the regular files (plain and executable) do
      // not.
      const root = mkdtempSync(join(tmpdir(), 'anas-setgid-'))
      try {
        mkdirSync(join(root, 'sub'))
        writeFileSync(join(root, 'plain.txt'), 'data\n', { mode: 0o644 })
        writeFileSync(join(root, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
        writeFileSync(join(root, 'sub', 'inner.txt'), 'data\n', { mode: 0o644 })
        // The walk starts at the pinned descriptor: `root` opened at fd 3.
        runHelperOn({ ...walked, acl: undefined, defaultAcl: undefined }, root)
        const SETGID = 0o2000
        assert.ok(statSync(root).mode & SETGID, 'the top directory is setgid')
        assert.ok(statSync(join(root, 'sub')).mode & SETGID, 'a subdirectory is setgid')
        for (const f of ['plain.txt', 'tool', join('sub', 'inner.txt')])
          assert.equal(statSync(join(root, f)).mode & SETGID, 0, `${f} is not setgid`)
        assert.equal(statSync(join(root, 'plain.txt')).mode & 0o7777, 0o644, 'a plain file keeps its mode')
      }
      finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  // --- cr.53 (review H2), fourth review: the walk acts on pinned descriptors ----
  // A path-addressed batch can be redirected by swapping a LISTED entry for a
  // symlink between the listing and the tool — the review's simulation landed
  // a named recursive grant on a file outside the tree; `-execdir`'s `./name`
  // still resolved the name again (fourth review: acl 2.3.2 `setfacl -P`
  // followed the swap, coreutils 9.7 `chmod -h` raced). The walk is now
  // anas-acl-walk: each entry opened O_PATH|O_NOFOLLOW where it was listed,
  // proven by fstat, every tool handed /proc/self/fd/N. The races themselves
  // run in services/__tests__/access-acl-walk.test.ts.
  describe('cr.53 H2 — the recursive walk acts on pinned descriptors, never on a name', () => {
    const RECURSIVE_GRANT = {
      owner: 'media',
      entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'owning-group', level: 'read' },
        { kind: 'everyone', level: 'read' },
        { kind: 'user', name: 'alice', level: 'read' },
      ],
      applyToExisting: true,
    }

    /** The confirmed recursive apply; its recorded commands. */
    async function recursiveApply(): Promise<Call[]> {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await injectConfirmed(server, {
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify(RECURSIVE_GRANT),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
      return calls
    }

    it('the walk is ONE helper run over the pinned root; no tool walks on its own, and the job carries no option a tool could follow a link with', async () => {
      const calls = await recursiveApply()
      const runs = walkRuns()
      assert.equal(runs.length, 1)
      assert.equal(runs[0].inheritedFds, 1, 'the root goes over as its pinned descriptor (fd 3)')
      assert.deepEqual(runs[0].job.roots.map(r => [r.fd, r.path]), [[3, MP]])
      assert.equal(calls.some(c => ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl', '/usr/bin/find'].includes(c.command)), false, 'no tool and no find ran outside the walk')
      for (const k of walkSteps(runs[0].job))
        assert.ok(!String(runs[0].job[k as keyof WalkRun['job']]).startsWith('-'), `${k} is a spec, never an option`)
    })

    it('run for real: every tool is handed the pinned descriptor of an entry inside the tree — the outside target of a planted symlink is never reached', async () => {
      await recursiveApply()
      const job = walkJob()
      const base = mkdtempSync(join(tmpdir(), 'anas-h2-'))
      try {
        const root = join(base, 'walk-root')
        mkdirSync(join(root, 'sub'), { recursive: true })
        writeFileSync(join(root, 'sub', 'file'), 'data\n')
        writeFileSync(join(base, 'victim'), 'secret\n', { mode: 0o600 })
        // The H2 shapes: a link to an outside file and a link to an outside
        // directory (what a swapped subdirectory becomes).
        symlinkSync(join(base, 'victim'), join(root, 'link-out'))
        symlinkSync(base, join(root, 'dir-out'))
        // The REAL helper, the job's steps, the tools swapped for a recorder
        // that prints what each operand resolves to in ITS process.
        const recorder = join(base, 'record.sh')
        const log = join(base, 'log')
        writeFileSync(recorder, `#!/bin/sh\nseen=0\nfor a in "$@"; do\n  [ "$seen" = 1 ] && readlink "$a" >> '${log}'\n  [ "$a" = "--" ] && seen=1\ndone\nexit 0\n`)
        chmodSync(recorder, 0o755)
        const report = runHelperOn(job, root, { chown: recorder, chmod: recorder, setfacl: recorder })
        assert.equal((report.skipped as { links: number }).links, 2, 'both links were counted and skipped')
        const rpRoot = realpathSync(root)
        const reached = readFileSync(log, 'utf-8').trim().split('\n')
        assert.ok(reached.length > 0)
        for (const p of reached) {
          assert.ok(p === rpRoot || p.startsWith(`${rpRoot}/`), `every operand is inside the tree: ${p}`)
          assert.ok(!p.includes('victim'), `the outside file is never reached: ${p}`)
        }
        const unique = [...new Set(reached)]
        unique.sort()
        assert.deepEqual(unique, [rpRoot, join(rpRoot, 'sub'), join(rpRoot, 'sub', 'file')])
      }
      finally {
        rmSync(base, { recursive: true, force: true })
      }
    })

    // What the helper relies on, pinned on this host's tools: a tool handed
    // /proc/self/fd/N of an O_PATH|O_NOFOLLOW descriptor acts on THAT inode
    // — the name it was opened by can be renamed away and replaced by a link
    // to a victim in between, and the victim is never touched (setfacl and
    // chmod; chown needs root). Captured 2026-11-14 with acl 2.4.0 /
    // coreutils 9.11 (this host) and acl 2.3.2 / coreutils 9.7 (the PVE 9
    // versions, run from a scratch build): identical.
    it('a tool handed /proc/self/fd/N reaches the pinned inode even after its name was swapped for a link to a victim', () => {
      const base = mkdtempSync(join(tmpdir(), 'anas-opath-'))
      try {
        writeFileSync(join(base, 'victim'), 'secret\n', { mode: 0o600 })
        writeFileSync(join(base, 'entry'), 'data\n', { mode: 0o600 })
        const fd = openSync(join(base, 'entry'), O_PATH | FS_CONSTANTS.O_NOFOLLOW)
        try {
          // The swap, after the open: the entry renamed away, a link to the victim in its place.
          renameSync(join(base, 'entry'), join(base, 'moved'))
          symlinkSync(join(base, 'victim'), join(base, 'entry'))
          const io = { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe', fd] as ('pipe' | number)[] }
          assert.equal(spawnSync('/usr/bin/setfacl', ['-b', '-m', 'u:nobody:rwx', '--', '/proc/self/fd/3'], io).status, 0)
          assert.equal(spawnSync('/usr/bin/chmod', ['0640', '--', '/proc/self/fd/3'], io).status, 0)
        }
        finally {
          closeSync(fd)
        }
        assert.ok(spawnSync('/usr/bin/getfacl', ['-pcE', join(base, 'moved')], { encoding: 'utf-8' }).stdout.includes('nobody'), 'the pinned inode got the ACL')
        assert.equal(statSync(join(base, 'moved')).mode & 0o7777, 0o640, 'and the mode')
        assert.equal(spawnSync('/usr/bin/getfacl', ['-pcE', join(base, 'victim')], { encoding: 'utf-8' }).stdout.includes('nobody'), false, 'the victim has no ACL')
        assert.equal(statSync(join(base, 'victim')).mode & 0o7777, 0o600, 'the victim keeps its mode')
      }
      finally {
        rmSync(base, { recursive: true, force: true })
      }
    })
  })

  // --- cr.53 (review L16): names are validated at the boundary -------------
  describe('cr.53 L16 — an injection-shaped name never reaches an argv', () => {
    async function putAccess(body: unknown): Promise<{ statusCode: number, body: string }> {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify(body),
      })
      // Route matching may read the dataset list (the wildcard-tail
      // ambiguity check runs before the handler); nothing that CHANGES
      // anything may run.
      assert.equal(calls.some(c => ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl', '/usr/bin/find', '/usr/bin/perl'].includes(c.command)
        || (c.command === '/usr/sbin/zfs' && c.args[0] === 'set')), false, JSON.stringify(calls))
      return { statusCode: res.statusCode, body: res.body }
    }

    it('400s the review\'s owner probe (--reference=/etc/shadow) before anything runs', async () => {
      const res = await putAccess({ owner: '--reference=/etc/shadow' })
      assert.equal(res.statusCode, 400)
      assert.equal(JSON.parse(res.body).error.code, 'VALIDATION_ERROR')
    })

    it('400s the review\'s entry-name probe (a spec-delimiter name smuggling an extra o::)', async () => {
      const res = await putAccess({
        entries: [
          { kind: 'everyone', level: 'none' },
          { kind: 'user', name: 'media:r-x,o::rwx,u:nobody', level: 'read-write' },
        ],
      })
      assert.equal(res.statusCode, 400)
      assert.equal(JSON.parse(res.body).error.code, 'VALIDATION_ERROR')
    })
  })
})

// ============================================================================
// Operator rulings 2026-10-11 on the recursive apply (access.1/access.2):
//   ruling 1 — `applyToExisting` is confirm-gated at the daemon (409 +
//              X-Anas-Confirm-Code), asked after every refusal;
//   ruling 3 — on ZFS, `setfacl -R` crosses child datasets mounted under the
//              path; a recursive NAMED grant switches POSIX ACLs on for each
//              child that has them off BEFORE any permission is touched.
// ============================================================================

/** `zfs list -r -H -o name,mountpoint,acltype -- testpool/media` — the walk's children. */
const CHILDREN_ARGS = ['list', '-r', '-H', '-o', 'name,mountpoint,acltype', '--', 'testpool/media']
/**
 * a: mounted under the path, ACLs off (enabled first);
 * b: mounted under the path, already posixacl (untouched);
 * c: mounted elsewhere, d: legacy, e: none (not reached by -R, ignored).
 */
const CHILDREN = [
  'testpool/media\t/testpool/media\toff',
  'testpool/media/a\t/testpool/media/a\toff',
  'testpool/media/b\t/testpool/media/b\tposixacl',
  'testpool/media/c\t/srv/c\toff',
  'testpool/media/d\tlegacy\toff',
  'testpool/media/e\tnone\toff',
  '',
].join('\n')

const NAMED_RECURSIVE = {
  entries: [
    { kind: 'owner', level: 'read-write' },
    { kind: 'owning-group', level: 'read' },
    { kind: 'everyone', level: 'none' },
    { kind: 'user', name: 'alice', level: 'read' },
  ],
  applyToExisting: true,
}

function putMedia(body: unknown): Put {
  return {
    method: 'PUT',
    url: '/v1/pools/testpool/datasets/media/access',
    headers: JSON_HEADERS,
    payload: JSON.stringify(body),
  }
}

/** Every permission-changing command — a tool, or the walk helper (perl); the ACL switch is `zfs set`, asserted separately. */
const PERMISSION_COMMANDS = ['/usr/bin/chown', '/usr/bin/chmod', '/usr/bin/setfacl', '/usr/bin/find', '/usr/bin/perl']
function isPermissionWrite(c: { command: string, args: string[] }): boolean {
  return PERMISSION_COMMANDS.includes(c.command)
}

function datasetRow(name: string): [string, unknown] {
  return [name, {
    name,
    type: 'FILESYSTEM',
    pool: 'testpool',
    properties: {
      used: { value: '1M', source: { type: 'NONE', data: '-' } },
      available: { value: '1G', source: { type: 'NONE', data: '-' } },
      referenced: { value: '1M', source: { type: 'NONE', data: '-' } },
      mountpoint: { value: `/${name}`, source: { type: 'DEFAULT', data: '-' } },
      type: { value: 'filesystem', source: { type: 'NONE', data: '-' } },
    },
  }]
}

describe('recursive apply — the confirm gate and child datasets (rulings 2026-10-11)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('recursive: the first PUT is a 409 + X-Anas-Confirm-Code whose headline says what happens; nothing runs', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) }])
    const res = await server.inject(putMedia(NAMED_RECURSIVE))
    assert.equal(res.statusCode, 409)
    assert.ok(res.headers['x-anas-confirm-code'], 'X-Anas-Confirm-Code')
    assert.ok(res.headers['x-anas-confirm-expires'], 'X-Anas-Confirm-Expires')
    const err = res.json().error as { code: string, message: string, warnings: string[] }
    assert.equal(err.code, 'CONFIRMATION_REQUIRED')
    assert.equal(err.message, `Applying to existing files rewrites the permissions of every file and directory under '${MP}'`)
    // The walk's reach on THIS target: the children it crosses (a, b — never
    // c, d, e) and the one whose ACLs are switched on first (a).
    assert.ok(err.warnings.includes(`It crosses the child datasets mounted under '${MP}': testpool/media/a (/testpool/media/a), testpool/media/b (/testpool/media/b).`), JSON.stringify(err.warnings))
    assert.ok(err.warnings.includes('POSIX ACLs (acltype=posixacl) are switched on first for testpool/media/a, as for \'testpool/media\' itself.'), JSON.stringify(err.warnings))
    assert.ok(err.warnings.some(w => /cannot be undone/.test(w)))
    assert.equal(err.warnings.some(w => /subvolume/.test(w)), false, 'no AHR sentence on ZFS')
    assert.equal(calls.some(c => isPermissionWrite(c)), false, 'nothing ran')
    assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined, 'no ACL switch flipped')
  })

  it('recursive: an unreadable ACL is refused BEFORE any confirm is offered, and nothing runs (D1)', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [
      { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
      { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } },
    ])
    const res = await server.inject(putMedia(NAMED_RECURSIVE))
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFLICT', 'the ACL refusal, never a confirm offer')
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a refusal never offers a confirm')
    assert.equal(calls.some(c => isPermissionWrite(c)), false, JSON.stringify(calls))
  })

  it('recursive: a non-recursive PUT is not gated', async () => {
    server = createServer({ mock: true, logger: false })
    installExecutor(server)
    const res = await server.inject(putMedia({ ...NAMED_RECURSIVE, applyToExisting: false }))
    assert.equal(res.statusCode, 202)
    // Let the job finish inside this test (its pin must not land in the next).
    await waitForJob(server, (res.json() as JobAccepted).job.id)
  })

  it('child dataset with ACLs off → enabled first, then the walk applies; the result lists it', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) }])
    const res = await injectConfirmed(server, putMedia(NAMED_RECURSIVE))
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
    const enableA = calls.findIndex(c => c.command === '/usr/sbin/zfs' && c.args.join(' ') === 'set -- acltype=posixacl xattr=sa testpool/media/a')
    assert.ok(enableA >= 0, 'acltype switched on for the child')
    const firstPermission = calls.findIndex(c => isPermissionWrite(c))
    assert.ok(firstPermission > enableA, `the child is enabled before any permission changes (enable #${enableA}, first permission #${firstPermission})`)
    assert.ok(walkJob().acl, 'the walk ran')
    assert.deepEqual((job.result as { childAclEnabled?: string[] }).childAclEnabled, ['testpool/media/a'])
  })

  it('the target\'s own ACL switch, and every child\'s, comes before the walk (fifth review (f))', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) }])
    const res = await injectConfirmed(server, putMedia(NAMED_RECURSIVE))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const at = (target: string) => calls.findIndex(c => c.command === '/usr/sbin/zfs' && c.args.join(' ') === `set -- acltype=posixacl xattr=sa ${target}`)
    const walk = calls.findIndex(c => c.command === '/usr/bin/perl')
    assert.ok(at('testpool/media/a') >= 0 && at('testpool/media') > at('testpool/media/a'), 'the child first, then the target')
    assert.ok(walk > at('testpool/media'), `the target's switch (#${at('testpool/media')}) precedes the walk (#${walk})`)
  })

  it('child dataset already posixacl → untouched', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) }])
    const res = await injectConfirmed(server, putMedia(NAMED_RECURSIVE))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
    assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set' && a.includes('testpool/media/b')), undefined)
  })

  it('child dataset mounted elsewhere (or legacy / none) → ignored', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) }])
    const res = await injectConfirmed(server, putMedia(NAMED_RECURSIVE))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
    for (const child of ['testpool/media/c', 'testpool/media/d', 'testpool/media/e'])
      assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set' && a.includes(child)), undefined, child)
    // The switches flipped are exactly the child under the path and the target itself.
    assert.deepEqual(calls.filter(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set').map(c => c.args.at(-1)), ['testpool/media/a', 'testpool/media'])
  })

  it('a recursive change with NO named entry needs no ACLs: no child is switched on', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) }])
    const res = await injectConfirmed(server, putMedia({ owner: 'media', applyToExisting: true }))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.deepEqual(pinnedPaths(), [MP], 'cr3: the writer pinned exactly the planned directory')
    assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
    assert.equal((job.result as { childAclEnabled?: string[] }).childAclEnabled, undefined)
  })

  it('child enable fails → nothing applied, the child is named', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [
      { command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) },
      { command: '/usr/sbin/zfs', args: ['set', '--', 'acltype=posixacl', 'xattr=sa', 'testpool/media/a'], result: { stdout: '', stderr: 'cannot set property for \'testpool/media/a\': permission denied', exitCode: 1 } },
    ])
    const res = await injectConfirmed(server, putMedia({ ...NAMED_RECURSIVE, owner: 'media' }))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /child dataset 'testpool\/media\/a' \(mounted at \/testpool\/media\/a\) — no permissions were changed/)
    assert.match(job.error!.message, /permission denied/)
    assert.equal(calls.some(c => isPermissionWrite(c)), false, 'no chown, chmod or setfacl ran')
    assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set' && a.at(-1) === 'testpool/media'), undefined, 'the target\'s own switch was not flipped either')
  })

  it('the walk cannot start after the ACL switches ran: the failure says they were switched, never "no permission was changed" (sixth review (d))', async () => {
    server = createServer({ mock: true, logger: false })
    installExecutor(server, [
      { command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) },
      { command: '/usr/bin/perl', result: { stdout: '', stderr: 'Can\'t open perl script "/opt/anas/packages/daemon/dist/services/anas-acl-walk.pl": Permission denied\n', exitCode: 2 } },
    ])
    const res = await injectConfirmed(server, putMedia(NAMED_RECURSIVE))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /^The permission walk could not be started: .* — the walk changed no file or folder; POSIX ACLs were already switched on for testpool\/media\/a, testpool\/media$/)
    assert.doesNotMatch(job.error!.message, /no permission was changed/)
  })

  it('the helper refuses after the ACL switches ran: the failure says they were switched (sixth review (d))', async () => {
    server = createServer({ mock: true, logger: false })
    installExecutor(server, [
      { command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(CHILDREN) },
      { command: '/usr/bin/perl', result: { stdout: '{"refused":"the job names no roots"}\n', stderr: '', exitCode: 2 } },
    ])
    const res = await injectConfirmed(server, putMedia(NAMED_RECURSIVE))
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error!.message, 'The walk changed no file or folder (POSIX ACLs were already switched on for testpool/media/a, testpool/media): the job names no roots')
  })

  it('the child list cannot be read → the recursive change is refused before any confirm, and nothing runs (nf.1)', async () => {
    // Since nf.1 the plan reads the walk's scope (the children it crosses, the
    // mounts it leaves alone) — a scope that cannot be named is refused at
    // the door, named grant or not, before a confirm is ever offered.
    server = createServer({ mock: true, logger: false })
    const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: { stdout: '', stderr: 'boom', exitCode: 1 } }])
    const res = await server.inject(putMedia(NAMED_RECURSIVE))
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.equal(res.json().error.message, `Could not tell which filesystems a recursive change of '${MP}' would cross: the child datasets of 'testpool/media' could not be listed — refusing it until they can be read`)
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a refusal never offers a confirm')
    assert.equal(calls.some(c => isPermissionWrite(c)), false)
    assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
  })

  it('a PVE-owned descendant → refused before anything is written (no confirm, no switch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anas-access-pve-'))
    const saved = process.env.ANAS_STORAGE_CFG
    writeFileSync(join(dir, 'storage.cfg'), 'zfspool: local-zfs\n\tpool testpool/media/vm\n\tcontent images,rootdir\n', 'utf8')
    process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
    try {
      server = createServer({ mock: true, logger: false })
      const nested = JSON.stringify({
        output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
        datasets: Object.fromEntries([datasetRow('testpool'), datasetRow('testpool/media'), datasetRow('testpool/media/vm')]),
      })
      const calls = installExecutor(server, [
        { command: '/usr/sbin/zfs', args: zfsListArgs('testpool'), result: ok(nested) },
        { command: '/usr/sbin/zfs', args: CHILDREN_ARGS, result: ok(`${CHILDREN}testpool/media/vm\t/testpool/media/vm\toff\n`) },
      ])
      const res = await server.inject(putMedia(NAMED_RECURSIVE))
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.code, 'PVE_MANAGED')
      assert.match(res.json().error.message, /Recursive permission change of 'testpool\/media' would include testpool\/media\/vm/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a refusal never offers a confirm')
      // nf.1: the plan READS the child list (the walk's scope) with the
      // directory's other facts; the refusal still comes before any write.
      assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
      assert.equal(calls.some(c => isPermissionWrite(c)), false)
    }
    finally {
      if (saved === undefined)
        delete process.env.ANAS_STORAGE_CFG
      else
        process.env.ANAS_STORAGE_CFG = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
