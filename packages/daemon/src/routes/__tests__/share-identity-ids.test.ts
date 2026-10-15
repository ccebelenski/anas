import type { Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { shareIdentityRoutes } from '../share-identity.js'

/**
 * Story cr.29 (ruled 2026-10-15): create user / create group pass an explicit
 * `-u`/`-g`. The operator's id is used as given — refused only when an account
 * holds it (or outside the band, the schema's 400) and NEVER checked for files;
 * otherwise ANAS picks the next free id above the highest in-band account,
 * moving past ids that own something under the paths it manages, and refuses
 * when a source of that check cannot be read. The create's guard takes the
 * id's `uid:`/`gid:` key and two creates at once never get the same id.
 *
 * FIXTURES (ruling (l)):
 *  - accounts: `accuser` (uid 1004, primary gid 100) rebuilt from the
 *    stunt-node capture `id accuser` in docs/LIVE-PROOF-0.4.3-access.md §1
 *    exactly as share-identity-guard.test.ts does; `users` (gid 100) from the
 *    same capture; `accgroup` (gid 1005) is that `users` line rewritten.
 *  - `findmnt --json`: fixtures/mounts/findmnt-full.json (stunt node, 18.1).
 *  - smb.conf: fixtures/samba/smb.conf with [media]'s `path = /tank/media`
 *    rewritten to `/mnttest/data` (the captured ZFS dataset), so one share is
 *    on ZFS and [backups] (`/tank/backups`) on the ext4 root.
 *  - /etc/exports: fixtures/nfs/etc-exports (`/srv/nfs/media`,
 *    `/srv/nfs/backups`, both on the ext4 root).
 *  - `zfs userspace -o name`: no capture under fixtures/; the -o name form of
 *    probe P06's row (`POSIX User\t0\t512\t1` → `0`), the number rewritten —
 *    see services/__tests__/identity-ids.test.ts.
 *  - `find … -print -quit`: one path line on a match, nothing otherwise.
 *  - `getent passwd <n>` / `getent group <n>`: the line, or exit 2 for a
 *    number nobody holds (getent(1)).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const LIVE_PROOF = readFileSync(join(__dirname, '../../../../../docs/LIVE-PROOF-0.4.3-access.md'), 'utf-8')

function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const ID_LINE = LIVE_PROOF.split('\n')[LIVE_PROOF.split('\n').indexOf('$ id accuser; pdbedit -L | grep accuser') + 1]
const ID = /^uid=(\d+)\((\w+)\) gid=(\d+)\((\w+)\)/.exec(ID_LINE)!
assert.ok(ID, ID_LINE)
const ACCUSER = `${ID[2]}:x:${ID[1]}:${ID[3]}::/home/${ID[2]}:/usr/sbin/nologin`
const USERS = `${ID[4]}:x:${ID[3]}:`
const ACCGROUP = rewrite(USERS, 'users:x:100:', 'accgroup:x:1005:')
assert.equal(ACCUSER, 'accuser:x:1004:100::/home/accuser:/usr/sbin/nologin')

const SMB_CONF = rewrite(readFileSync(join(FIXTURES, 'samba/smb.conf'), 'utf-8'), 'path = /tank/media', 'path = /mnttest/data')
const EXPORTS = readFileSync(join(FIXTURES, 'nfs/etc-exports'), 'utf-8')
const FINDMNT_FULL = readFileSync(join(FIXTURES, 'mounts/findmnt-full.json'), 'utf-8')
const P06 = readFileSync(join(__dirname, '../../../../../docs/probes/wave2/06-identity-allocation.txt'), 'utf-8')
const NAME_COLUMN = P06.split('\n').find(l => l.startsWith('POSIX User\t'))!.split('\t')[1]
assert.equal(NAME_COLUMN, '0')

const GETENT = '/usr/bin/getent'
const ZFS = '/usr/sbin/zfs'
const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const USERADD = '/usr/sbin/useradd'
const GROUPADD = '/usr/sbin/groupadd'

const HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
  'content-type': 'application/json',
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const ABSENT: ExecResult = { stdout: '', stderr: '', exitCode: 2 }

interface Call { command: string, args: string[] }

describe('cr.29 — create passes an explicit uid / gid', () => {
  let dir: string
  let app: FastifyInstance | undefined
  let queue: JobQueue
  let calls: Call[]
  /** What the node answers right now; a test changes these. */
  let passwd: string[]
  let groups: string[]
  /** `zfs userspace|groupspace` per dataset. */
  let space: Record<string, number[]>
  /** find root → id → first path. */
  let owned: Record<string, Record<number, string>>
  /** A command → a failing answer. */
  let broken: (c: Call) => ExecResult | undefined
  /** Held until released: a test parks a command here. */
  let gate: ((c: Call) => Promise<void> | undefined) | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr29-'))
    await writeFile(join(dir, 'smb.conf'), SMB_CONF)
    await writeFile(join(dir, 'exports'), EXPORTS)
    passwd = ['root:x:0:0:root:/root:/bin/bash', ACCUSER]
    groups = ['root:x:0:', USERS, ACCGROUP]
    space = { 'mnttest': [0], 'mnttest/data': [0] }
    owned = {}
    broken = () => undefined
    gate = undefined
    calls = []
    const executor = new MockExecutor()
    executor.exec = async (command: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> => {
      const call = { command, args }
      calls.push(call)
      await gate?.(call)
      const fail = broken(call)
      if (fail)
        return fail
      if (command === GETENT) {
        const a = args[0] === '-s' ? args.slice(2) : args
        const lines = a[0] === 'passwd' ? passwd : a[0] === 'group' ? groups : []
        if (a[1] === undefined)
          return ok(`${lines.map(l => `${l}\n`).join('')}`)
        // By name, or by number (field 3) — getent accepts both keys.
        const line = lines.find(l => l.split(':')[0] === a[1] || l.split(':')[2] === a[1])
        return line ? ok(`${line}\n`) : ABSENT
      }
      if (command === ZFS && args[0] === 'list')
        return ok(Object.keys(space).map(d => `${d}\n`).join(''))
      if (command === ZFS && (args[0] === 'userspace' || args[0] === 'groupspace'))
        return ok((space[args.at(-1)!] ?? []).map(id => `${NAME_COLUMN.replace('0', String(id))}\n`).join(''))
      if (command === FINDMNT)
        return ok(FINDMNT_FULL)
      if (command === FIND) {
        const at = args.includes('-uid') ? args.indexOf('-uid') : args.indexOf('-gid')
        const hit = owned[args[1]]?.[Number(args[at + 1])]
        return ok(hit ? `${hit}\n` : '')
      }
      if (command === '/usr/bin/pdbedit')
        return ok('')
      return ok('')
    }
    queue = new JobQueue()
    app = Fastify({ logger: false })
    await app.register(shareIdentityRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: queue,
      confirmStore: new ConfirmStore(),
      smbConfPath: join(dir, 'smb.conf'),
      exportsPath: join(dir, 'exports'),
      smbpasswdAvailable: async () => true,
    })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(dir, { recursive: true, force: true })
  })

  function post(url: string, body: unknown) {
    return app!.inject({ method: 'POST', url, headers: HEADERS, payload: JSON.stringify(body) })
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue.get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  async function created(url: string, body: unknown): Promise<Job> {
    const res = await post(url, body)
    assert.equal(res.statusCode, 202, res.body)
    return finished((res.json() as JobAccepted).job.id)
  }

  const argvOf = (command: string): string[][] => calls.filter(c => c.command === command).map(c => c.args)
  const walked = (): boolean => calls.some(c => c.command === FIND || (c.command === ZFS && c.args[0] !== 'list'))

  // --- A free id is used ---------------------------------------------------

  it('a free id is used: the next uid above the highest in-band account (accuser 1004) → useradd -u 1005', async () => {
    const job = await created('/v1/identity/users', { name: 'alice' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1005', 'alice']])
    assert.deepEqual(job.result, { created: 'alice', uid: 1005, smbEnabled: false })
    // It looked: the ZFS accounting of both filesystems and a bounded find of
    // every non-ZFS share root (smb.conf [backups] and every export), once
    // at the route and once more in the job.
    const roots = ['/export/legacy', '/srv/nfs/backups', '/srv/nfs/media', '/srv/nfs/my documents', '/tank/backups']
    assert.deepEqual(calls.filter(c => c.command === FIND).map(c => c.args[1]).sort(), [...roots, ...roots].sort())
    assert.ok(calls.some(c => c.command === ZFS && c.args.join(' ') === 'userspace -H -p -n -o name -t posixuser -- mnttest/data'))
  })

  it('a free gid is used the same way: groupadd -g 1006 (accgroup holds 1005)', async () => {
    const job = await created('/v1/identity/groups', { name: 'media' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(GROUPADD), [['-g', '1006', 'media']])
    assert.deepEqual(job.result, { created: 'media', gid: 1006 })
    assert.ok(calls.some(c => c.command === ZFS && c.args[0] === 'groupspace'))
    assert.ok(calls.some(c => c.command === FIND && c.args.includes('-gid')))
  })

  // --- An id that owns something is skipped ------------------------------

  it('an id that owns a file under a share root is skipped (find), and one ZFS accounts for is skipped too', async () => {
    owned = { '/tank/backups': { 1005: '/tank/backups/2026/old-alice.tar' } }
    space = { 'mnttest': [0], 'mnttest/data': [0, 1006] }
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1007', 'alice']])
  })

  it('the job\'s progress names what the skipped ids still own', async () => {
    owned = { '/tank/backups': { 1005: '/tank/backups/x' } }
    let line = ''
    const releaseAdd = parkUseradd()
    const res = await post('/v1/identity/users', { name: 'alice' })
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === USERADD))
    line = queue.get(id)?.progress ?? ''
    releaseAdd()
    await finished(id)
    assert.equal(line, `Creating share user 'alice' with uid 1006 (uid 1005 still owns '/tank/backups/x')`)
  })

  // --- Explicit ids --------------------------------------------------------

  it('an explicit id an account holds is refused, naming the holder; no useradd / groupadd', async () => {
    const u = await post('/v1/identity/users', { name: 'alice', uid: 1004 })
    assert.equal(u.statusCode, 409)
    assert.equal(u.json().error.reason, 'id-in-use')
    assert.equal(u.json().error.message, `uid 1004 already belongs to user 'accuser'. Nothing was created. Give another User ID, or leave it empty and ANAS picks a free one.`)
    const g = await post('/v1/identity/groups', { name: 'media', gid: 1005 })
    assert.equal(g.statusCode, 409)
    assert.equal(g.json().error.message, `gid 1005 already belongs to group 'accgroup'. Nothing was created. Give another Group ID, or leave it empty and ANAS picks a free one.`)
    assert.deepEqual([...argvOf(USERADD), ...argvOf(GROUPADD)], [])
  })

  it('an explicit id is NOT refused for owning files (re-creating a deleted account is the point) — and is never checked', async () => {
    space = { 'mnttest': [0], 'mnttest/data': [0, 1010] }
    owned = { '/tank/backups': { 1010: '/tank/backups/bob' } }
    const job = await created('/v1/identity/users', { name: 'bob', uid: 1010 })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1010', 'bob']])
    assert.equal(walked(), false, 'no zfs userspace, no find for an explicit id')
    const g = await created('/v1/identity/groups', { name: 'team', gid: 1010 })
    assert.equal(g.status, 'completed', JSON.stringify(g.error))
    assert.deepEqual(argvOf(GROUPADD), [['-g', '1010', 'team']])
  })

  it('an explicit id outside the share band is a 400 naming the band (UID_MAX 60000 included)', async () => {
    for (const uid of [999, 60000, 0]) {
      const res = await post('/v1/identity/users', { name: 'alice', uid })
      assert.equal(res.statusCode, 400, `uid ${uid}`)
      assert.match(res.json().error.message, /from 1000 to 59999 \(the share band\)/)
    }
    assert.deepEqual(argvOf(USERADD), [])
  })

  // --- Fail closed -----------------------------------------------------------

  it('a check that cannot run refuses 409 naming what could not be read, and points at the explicit id; no useradd', async () => {
    const cases: [(c: Call) => ExecResult | undefined, string][] = [
      [c => c.command === FINDMNT ? { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 } : undefined, 'the mount table (findmnt: findmnt: cannot read /proc/self/mountinfo)'],
      [c => c.command === ZFS && c.args[0] === 'userspace' ? { stdout: '', stderr: `cannot get used/quota for mnttest: dataset is busy`, exitCode: 1 } : undefined, `ZFS's per-user accounting of 'mnttest' (zfs userspace: cannot get used/quota for mnttest: dataset is busy)`],
      [c => c.command === FIND ? { stdout: '', stderr: `find: '/tank/backups/x': Input/output error`, exitCode: 1 } : undefined, `the files under '/tank/backups' (find: find: '/tank/backups/x': Input/output error)`],
      [c => c.command === GETENT && c.args[1] === '1005' ? { stdout: '', stderr: '', exitCode: 1 } : undefined, 'the account database (getent passwd 1005: exit code 1)'],
    ]
    for (const [fail, what] of cases) {
      broken = fail
      const res = await post('/v1/identity/users', { name: 'alice' })
      assert.equal(res.statusCode, 409, what)
      assert.equal(res.json().error.reason, 'id-check-unreadable')
      assert.equal(res.json().error.message, `ANAS could not check which uid is free: it could not read ${what}. Nothing was created. To create the user without this check, give its User ID explicitly (an id you give is not checked for files).`)
    }
    assert.deepEqual(argvOf(USERADD), [])
    assert.deepEqual(queue.list(), [], 'no job was submitted')
  })

  it('an unreadable smb.conf or /etc/exports refuses too (the share roots are unknown)', async () => {
    await rm(join(dir, 'exports'))
    await writeFile(join(dir, 'exports'), '')
    // A directory where the file should be: readFile fails with EISDIR (not an absent file).
    await rm(join(dir, 'smb.conf'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'smb.conf'))
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /it could not read smb\.conf \(the SMB share paths\)/)
    assert.deepEqual(argvOf(USERADD), [])
  })

  // --- Races -------------------------------------------------------------------

  it('two creates at once get different ids (both decide while the other is still checking)', async () => {
    // Hold every find until BOTH requests are walking: each has read the same
    // accounts and is checking the same first candidate.
    let arrived = 0
    let open!: () => void
    const both = new Promise<void>((resolve) => {
      open = resolve
    })
    gate = (c) => {
      if (c.command !== FIND)
        return undefined
      if (++arrived === 2)
        open()
      return both
    }
    const releaseAdd = parkUseradd()
    const [a, b] = await Promise.all([
      post('/v1/identity/users', { name: 'alice' }),
      post('/v1/identity/users', { name: 'bob' }),
    ])
    assert.equal(a.statusCode, 202, a.body)
    assert.equal(b.statusCode, 202, b.body)
    // The two jobs hold different uid keys (they can run side by side).
    await until(() => argvOf(USERADD).length === 2)
    const keys = queue.heldLocks().map(l => l.key).filter(k => k.startsWith('uid:')).sort()
    assert.deepEqual(keys, ['uid:1005', 'uid:1006'])
    releaseAdd()
    const uids = await Promise.all([a, b].map(async r => (await finished((r.json() as JobAccepted).job.id)).result as { uid: number }))
    assert.deepEqual(uids.map(r => r.uid).sort(), [1005, 1006])
    assert.deepEqual(argvOf(USERADD).map(a => a[a.indexOf('-u') + 1]).sort(), ['1005', '1006'])
  })

  it('an explicit id already promised to an unfinished create is refused at the route', async () => {
    const releaseAdd = parkUseradd()
    const first = await post('/v1/identity/users', { name: 'alice', uid: 1020 })
    assert.equal(first.statusCode, 202, first.body)
    const second = await post('/v1/identity/users', { name: 'bob', uid: 1020 })
    assert.equal(second.statusCode, 409)
    assert.equal(second.json().error.message, 'uid 1020 is being given to another user by a create that has not finished. Nothing was created.')
    // …and the pick steps over it as well.
    const third = await post('/v1/identity/users', { name: 'carol' })
    assert.equal(third.statusCode, 202, third.body)
    releaseAdd()
    await finished((first.json() as JobAccepted).job.id)
    const carol = await finished((third.json() as JobAccepted).job.id)
    assert.equal((carol.result as { uid: number }).uid, 1005)
  })

  it('the promise ends with the job: a failed create frees its id for the next one', async () => {
    broken = c => c.command === USERADD ? { stdout: '', stderr: 'useradd: cannot lock /etc/passwd; try again later.', exitCode: 1 } : undefined
    const failed = await created('/v1/identity/users', { name: 'alice' })
    assert.equal(failed.status, 'failed')
    broken = () => undefined
    const job = await created('/v1/identity/users', { name: 'alice' })
    assert.equal((job.result as { uid: number }).uid, 1005)
  })

  // --- The job door (ruling (j)) -------------------------------------------------

  it('a picked uid that an account takes while the job waits fails the job CONFLICT; no useradd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 202, res.body)
    passwd = [...passwd, 'zed:x:1005:100::/home/zed:/usr/sbin/nologin']
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, `uid 1005 was given meanwhile to user 'zed'. Nothing was created. Create it again and ANAS picks another.`)
    assert.deepEqual(argvOf(USERADD), [])
  })

  it('a picked uid that comes to own a file while the job waits fails the job STATE_CHANGED; no useradd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 202, res.body)
    space = { 'mnttest': [0, 1005], 'mnttest/data': [0] }
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `uid 1005 owns the ZFS filesystem 'mnttest' now (it owned nothing when the request was checked). Nothing was created. Create it again and ANAS picks another.`)
    assert.deepEqual(argvOf(USERADD), [])
  })

  it('an explicit uid an account takes while the job waits fails the job; files are still never checked', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice', uid: 1030 })
    assert.equal(res.statusCode, 202, res.body)
    passwd = [...passwd, 'zed:x:1030:100::/home/zed:/usr/sbin/nologin']
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^uid 1030 was given meanwhile to user 'zed'\. Nothing was created\. Give another User ID/)
    assert.equal(walked(), false)
  })

  // --- helpers that need the queue ---------------------------------------------

  /** Fill the queue's four slots; the returned function releases them. */
  function holdSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  /** Park every useradd until released. */
  function parkUseradd(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const before = gate
    gate = c => c.command === USERADD ? held : before?.(c)
    return release
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
  }
})
