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
import { AuditLogger } from '../../audit/logger.js'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { GROUP_CREATE_PRESENTATION_ONLY, shareIdentityRoutes, USER_CREATE_PRESENTATION_ONLY } from '../share-identity.js'

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
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
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
  /** `pdbedit -L` answers (`name:uid:comment` lines); empty = no entry. */
  let passdb: string[]
  /** `zfs userspace|groupspace` per dataset. */
  let space: Record<string, number[]>
  /** find root → id → first path. */
  let owned: Record<string, Record<number, string>>
  /** A command → a failing answer. */
  let broken: (c: Call) => ExecResult | undefined
  /** Held until released: a test parks a command here. */
  let gate: ((c: Call) => Promise<void> | undefined) | undefined
  /** The daemon's log lines (pino JSON), the audit lines among them. */
  let logLines: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr29-'))
    await writeFile(join(dir, 'smb.conf'), SMB_CONF)
    await writeFile(join(dir, 'exports'), EXPORTS)
    passwd = ['root:x:0:0:root:/root:/bin/bash', ACCUSER]
    groups = ['root:x:0:', USERS, ACCGROUP]
    passdb = []
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
        return args[0] === '-L' ? ok(passdb.map(l => `${l}\n`).join('')) : ok('')
      return ok('')
    }
    logLines = []
    app = Fastify({ logger: { level: 'info', stream: { write: (line: string) => {
      logLines.push(line)
    } } } })
    // The real audit logger (audit/logger.ts) over the app's pino: what
    // journald receives is these JSON lines.
    queue = new JobQueue({ audit: new AuditLogger(app.log) })
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

  it('a free id is used: the next uid above the highest in-band account (accuser 1004) that no group holds as its gid (accgroup 1005, cr.29c) → useradd -u 1006', async () => {
    const job = await created('/v1/identity/users', { name: 'alice' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1006', 'alice']])
    assert.deepEqual(job.result, { created: 'alice', uid: 1006, smbEnabled: false })
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
    owned = { '/tank/backups': { 1006: '/tank/backups/2026/old-alice.tar' } }
    space = { 'mnttest': [0], 'mnttest/data': [0, 1007] }
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1008', 'alice']])
  })

  it('the job\'s progress names what the skipped ids still own', async () => {
    owned = { '/tank/backups': { 1006: '/tank/backups/x' } }
    let line = ''
    const releaseAdd = parkUseradd()
    const res = await post('/v1/identity/users', { name: 'alice' })
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === USERADD))
    line = queue.get(id)?.progress ?? ''
    releaseAdd()
    await finished(id)
    assert.equal(line, `Creating share user 'alice' with uid 1007 (uid 1006 still owns '/tank/backups/x')`)
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

  it('cr.29c (1): an explicit id that owns files gets NO ownership confirm — the create is accepted at once, nothing walked', async () => {
    // Both sources say uid 1010 / gid 1011 own something; neither is read.
    space = { 'mnttest': [0], 'mnttest/data': [0, 1010, 1011] }
    owned = { '/tank/backups': { 1010: '/tank/backups/bob', 1011: '/tank/backups/team' } }
    for (const [url, body] of [['/v1/identity/users', { name: 'bob', uid: 1010 }], ['/v1/identity/groups', { name: 'team', gid: 1011 }]] as const) {
      const res = await post(url, body)
      assert.equal(res.statusCode, 202, res.body)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, `${url}: no confirm code minted`)
      await finished((res.json() as JobAccepted).job.id)
    }
    assert.equal(walked(), false, 'no zfs userspace/groupspace, no find for an explicit id')
  })

  it('an explicit id outside the share band is a 400 naming the band', async () => {
    for (const uid of [999, 60001, 0]) {
      const res = await post('/v1/identity/users', { name: 'alice', uid })
      assert.equal(res.statusCode, 400, `uid ${uid}`)
      assert.match(res.json().error.message, /from 1000 to 60000 \(the share band\)/)
    }
    assert.deepEqual(argvOf(USERADD), [])
  })

  it('cr.29c (7): the band\'s top, login.defs UID_MAX / GID_MAX 60000, is a share id — given explicitly it is created', async () => {
    const u = await created('/v1/identity/users', { name: 'alice', uid: 60000 })
    assert.equal(u.status, 'completed', JSON.stringify(u.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '60000', 'alice']])
    const g = await created('/v1/identity/groups', { name: 'team', gid: 60000 })
    assert.equal(g.status, 'completed', JSON.stringify(g.error))
    assert.deepEqual(argvOf(GROUPADD), [['-g', '60000', 'team']])
  })

  // --- cr.29c (2): uid N where a group already has gid N ---------------------
  //
  // ANAS creates users with `useradd -N` (identity.1c): no private group is
  // made, the primary group is the default GROUP=100 (`useradd -D`, probe
  // P06). USERGROUPS_ENAB (yes on PVE, P06) does not apply with -N
  // (useradd(8): "The default behavior (if the -g, -N, and -U options are not
  // specified) is defined by the USERGROUPS_ENAB variable"). What remains of
  // the ruling's case is uid N and gid N belonging to two unrelated accounts:
  // that is the confirm.

  function postConfirmed(url: string, body: unknown, code: string) {
    return app!.inject({ method: 'POST', url, headers: { ...HEADERS, 'x-anas-confirm': code }, payload: JSON.stringify(body) })
  }

  it('cr.29c (2): an explicit uid a group holds as its gid is a 409 confirm naming the group; the resend with the code creates it, still -N', async () => {
    const first = await post('/v1/identity/users', { name: 'alice', uid: 1005 })
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.equal(first.json().error.message, `Create user 'alice' with uid 1005?`)
    assert.deepEqual(first.json().error.warnings, [
      `Group 'accgroup' already has gid 1005. User 'alice' will get uid 1005 with primary group gid 100 (the default), so uid 1005 and gid 1005 will belong to two unrelated accounts. To avoid it, give another User ID, choose 'accgroup' as the primary group, or leave the User ID empty and ANAS picks one no group holds as its gid.`,
    ])
    const code = first.headers['x-anas-confirm-code']
    assert.equal(typeof code, 'string')
    assert.deepEqual(argvOf(USERADD), [], 'nothing created before the confirm')
    assert.deepEqual(queue.list(), [], 'no job before the confirm')

    // The challenge dropped the id promise: the resend is not "being given to another".
    const res = await postConfirmed('/v1/identity/users', { name: 'alice', uid: 1005 }, code as string)
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1005', 'alice']])
  })

  it('cr.29c (2): the code binds what holds the number — a resend after the holder changed is asked again', async () => {
    const first = await post('/v1/identity/users', { name: 'alice', uid: 1005 })
    const code = first.headers['x-anas-confirm-code'] as string
    // The holder changed between the challenge and the resend.
    groups = groups.map(l => l === ACCGROUP ? 'renamed:x:1005:' : l)
    const again = await postConfirmed('/v1/identity/users', { name: 'alice', uid: 1005 }, code)
    assert.equal(again.statusCode, 409)
    assert.equal(again.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.match(again.json().error.message, /what holds the same number changed since you confirmed/)
    assert.deepEqual(argvOf(USERADD), [])
  })

  it('cr.29c (2): a group that takes gid N while the job waits fails the job STATE_CHANGED; no useradd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice', uid: 1030 })
    assert.equal(res.statusCode, 202, res.body)
    groups = [...groups, 'late:x:1030:']
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, /^Since the request was checked: Group 'late' already has gid 1030\. .* Nothing was created; create it again to confirm\.$/)
    assert.deepEqual(argvOf(USERADD), [])
  })

  it('cr.29c (2): the SMB password VALUE is the one unsigned field of the user create confirm, and never reaches its sentences', async () => {
    // cr.66r re-pins the title: what stays unsigned is the VALUE; the signed
    // request carries `smbPasswordSet` (the presence) beside it — see the
    // cr.66r test below for that half.
    assert.deepEqual(Object.keys(USER_CREATE_PRESENTATION_ONLY), ['smbPassword'])
    assert.deepEqual(GROUP_CREATE_PRESENTATION_ONLY, {})
    const first = await post('/v1/identity/users', { name: 'alice', uid: 1005, smbPassword: 'Secret-one-1' })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    // Another password AND full name on the resend: the sentence names the full name, never a password.
    const again = await postConfirmed('/v1/identity/users', { name: 'alice', uid: 1005, smbPassword: 'Secret-two-2', fullName: 'Alice' }, code)
    assert.equal(again.statusCode, 409)
    assert.equal(again.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.match(again.json().error.message, /fullName/)
    assert.equal(again.body.includes('Secret-'), false, again.body)
  })

  // cr.66r (4) — the ruling (§2 Safety altitudes): a confirm signs the NAMES
  // of every field it writes, never a secret value. The create signed the
  // request with the password dropped; nothing about the password was signed
  // at all. The signed request now carries `smbPasswordSet` beside it: adding
  // a password to a create minted without one re-challenges by NAME, and a
  // rotation with the same presence stays the same request.
  it('cr.66r (4): a resend that ADDS an SMB password re-challenges naming smbPasswordSet; a rotation with the same presence passes; no 409 carries a password', async () => {
    const first = await post('/v1/identity/users', { name: 'alice', uid: 1005 })
    assert.equal(first.statusCode, 409, first.body)
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    // The mint wrote no SMB password; this resend writes one — a field added
    // is a scope change, named by NAME.
    const added = await postConfirmed('/v1/identity/users', { name: 'alice', uid: 1005, smbPassword: 'Secret-added-1' }, code)
    assert.equal(added.statusCode, 409, added.body)
    assert.equal(added.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(added.json().error.changed, ['smbPasswordSet'])
    assert.match(added.json().error.message, /You confirmed with smbPasswordSet off; this request has smbPasswordSet on — confirm again/, added.json().error.message)
    for (const res of [first, added])
      assert.equal(res.body.includes('Secret-added-1'), false, res.body)

    // A rotation with the SAME presence: the values are never signed, so the
    // fresh code passes and the job runs (smbpasswd gets the password on
    // stdin, never argv). The static mock only knows what it was handed, so
    // the gate hook simulates what useradd and smbpasswd bring to the node —
    // the job's identity.3 verification must see the new account and its
    // fresh passdb entry.
    gate = async (c) => {
      if (c.command === USERADD)
        passwd = [...passwd, 'alice:x:1005:1005::/home/alice:/usr/sbin/nologin']
      if (c.command === '/usr/bin/smbpasswd')
        passdb = ['alice:1005:alice']
    }
    const code2 = (await post('/v1/identity/users', { name: 'alice', uid: 1005, smbPassword: 'Secret-one-1' })).headers['x-anas-confirm-code'] as string
    assert.ok(code2)
    const rotated = await postConfirmed('/v1/identity/users', { name: 'alice', uid: 1005, smbPassword: 'Secret-two-2' }, code2)
    assert.equal(rotated.statusCode, 202, rotated.body)
    const job = await finished((rotated.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1005', 'alice']])
    // No reply, job record or recorded argv carries either password.
    for (const [label, text] of [
      [`job`, JSON.stringify(job)],
      ...calls.map((c, i) => [`exec ${i}`, JSON.stringify(c)] as const),
    ] as const) {
      assert.equal(text.includes('Secret-one-1'), false, `${label} carried the minted password`)
      assert.equal(text.includes('Secret-two-2'), false, `${label} carried the rotated password`)
    }
  })

  // --- cr.29c (3): an explicit primary group on Add -------------------------

  it('cr.29c (3): a primary group the request names is passed as useradd -g <its gid> beside -N, and its gid key is taken', async () => {
    const releaseAdd = parkUseradd()
    const res = await post('/v1/identity/users', { name: 'alice', primaryGroup: 'accgroup' })
    assert.equal(res.statusCode, 202, res.body)
    await until(() => argvOf(USERADD).length === 1)
    assert.ok(queue.heldLocks().some(l => l.key === 'gid:1005'), JSON.stringify(queue.heldLocks()))
    releaseAdd()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1006', '-g', '1005', 'alice']])
  })

  it('cr.29c (3): uid N with the group of gid N as its primary group is coherent — no same-number confirm', async () => {
    const job = await created('/v1/identity/users', { name: 'alice', uid: 1005, primaryGroup: 'accgroup' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD), [['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1005', '-g', '1005', 'alice']])
  })

  it('cr.29c (3): the default primary group (users, gid 100) may be named; a system group is refused, an unknown one is a 400', async () => {
    const job = await created('/v1/identity/users', { name: 'alice', primaryGroup: 'users' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(USERADD).at(-1)!.slice(-3), ['-g', '100', 'alice'])
    const root = await post('/v1/identity/users', { name: 'bob', primaryGroup: 'root' })
    assert.equal(root.statusCode, 409)
    assert.equal(root.json().error.code, 'SYSTEM_ACCOUNT')
    assert.match(root.json().error.message, /^Group 'root' \(gid 0\) is a system group, so it cannot be a share user's primary group\./)
    const none = await post('/v1/identity/users', { name: 'bob', primaryGroup: 'nosuch' })
    assert.equal(none.statusCode, 400)
    assert.equal(none.json().error.message, 'Unknown primary group: nosuch')
    const bad = await post('/v1/identity/users', { name: 'bob', primaryGroup: '-g0' })
    assert.equal(bad.statusCode, 400, 'the schema refuses a name that is not an identity name')
    assert.equal(argvOf(USERADD).length, 1)
  })

  it('cr.29c (3): a primary group whose gid changed while the job waited fails the job STATE_CHANGED; no useradd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice', primaryGroup: 'accgroup' })
    assert.equal(res.statusCode, 202, res.body)
    groups = groups.map(l => l === ACCGROUP ? 'accgroup:x:1040:' : l)
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `Group 'accgroup' has gid 1040 now (it had gid 1005 when the request was checked). Nothing was created; create the user again.`)
    assert.deepEqual(argvOf(USERADD), [])
  })

  // --- cr.29c (5): groups alike ----------------------------------------------
  //
  // An explicit gid a group holds is refused — cr.29's 'an explicit id an
  // account holds is refused' above (gid 1005 / accgroup) stays the proof.

  it('cr.29c (5): an explicit gid equal to a user\'s uid whose primary group is another gid is a 409 confirm naming the user; the resend creates it', async () => {
    const first = await post('/v1/identity/groups', { name: 'team', gid: 1004 })
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.equal(first.json().error.message, `Create group 'team' with gid 1004?`)
    assert.deepEqual(first.json().error.warnings, [
      `User 'accuser' already has uid 1004, and its primary group is gid 100. Group 'team' will get gid 1004, so uid 1004 and gid 1004 will belong to two unrelated accounts: 'team' looks like the private group of 'accuser' without being it. To avoid it, give another Group ID, or leave it empty and ANAS picks one no user holds as its uid.`,
    ])
    assert.deepEqual(argvOf(GROUPADD), [])
    const res = await postConfirmed('/v1/identity/groups', { name: 'team', gid: 1004 }, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await finished((res.json() as JobAccepted).job.id)).status, 'completed')
    assert.deepEqual(argvOf(GROUPADD), [['-g', '1004', 'team']])
  })

  it('cr.29c (5): a gid equal to the uid of a user whose primary gid IS that number is its private group — no confirm', async () => {
    // `getent passwd` line shape of accuser (the capture), uid/gid rewritten:
    // a user whose primary group gid 1050 no longer exists.
    passwd = [...passwd, rewrite(ACCUSER, 'accuser:x:1004:100:', 'orphan:x:1050:1050:')]
    const res = await post('/v1/identity/groups', { name: 'orphan', gid: 1050 })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await finished((res.json() as JobAccepted).job.id)).status, 'completed')
    assert.deepEqual(argvOf(GROUPADD), [['-g', '1050', 'orphan']])
  })

  it('cr.29c (5): a picked gid steps over a number a user holds as its uid', async () => {
    passwd = [...passwd, rewrite(ACCUSER, 'accuser:x:1004:', 'bob:x:1006:')]
    const job = await created('/v1/identity/groups', { name: 'media' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(argvOf(GROUPADD), [['-g', '1007', 'media']])
  })

  it('cr.29c (5): a user that takes uid N while the group job waits fails the job STATE_CHANGED; no groupadd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/groups', { name: 'team', gid: 1030 })
    assert.equal(res.statusCode, 202, res.body)
    passwd = [...passwd, 'zed:x:1030:100::/home/zed:/usr/sbin/nologin']
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, /^Since the request was checked: User 'zed' already has uid 1030, and its primary group is gid 100\. /)
    assert.deepEqual(argvOf(GROUPADD), [])
  })

  // --- cr.29c (6): the audit line ------------------------------------------------

  it('cr.29c (6): a create\'s journald audit line carries the uid / gid used and whether it was explicit or picked', async () => {
    const audit = (operation: string) => logLines
      .map(l => JSON.parse(l) as { audit?: boolean, event?: string, operation?: string, params?: Record<string, unknown> })
      .filter(l => l.audit === true && l.event === 'job.submitted' && l.operation === operation)
      .map(l => l.params)
    await created('/v1/identity/users', { name: 'alice' })
    await created('/v1/identity/users', { name: 'bob', uid: 1010, primaryGroup: 'accgroup' })
    assert.deepEqual(audit('identity.user.add'), [
      { user: 'alice', uid: 1006, explicit: false, smbEnabled: false },
      { user: 'bob', uid: 1010, explicit: true, primaryGroup: 'accgroup', primaryGid: 1005, smbEnabled: false },
    ])
    // gid 1006: the fake's account lists do not grow with useradd.
    await created('/v1/identity/groups', { name: 'media' })
    await created('/v1/identity/groups', { name: 'team', gid: 1020 })
    assert.deepEqual(audit('identity.group.add'), [
      { group: 'media', gid: 1006, explicit: false },
      { group: 'team', gid: 1020, explicit: true },
    ])
    // The finished line carries the same params.
    const done = logLines.map(l => JSON.parse(l) as { event?: string, params?: { uid?: number, explicit?: boolean } }).filter(l => l.event === 'job.completed' && l.params?.uid === 1010)
    assert.equal(done.length, 1)
    assert.equal(done[0].params?.explicit, true)
  })

  // --- Fail closed -----------------------------------------------------------

  it('a check that cannot run refuses 409 naming what could not be read, and points at the explicit id; no useradd', async () => {
    const cases: [(c: Call) => ExecResult | undefined, string][] = [
      [c => c.command === FINDMNT ? { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 } : undefined, 'the mount table (findmnt: findmnt: cannot read /proc/self/mountinfo)'],
      [c => c.command === ZFS && c.args[0] === 'userspace' ? { stdout: '', stderr: `cannot get used/quota for mnttest: dataset is busy`, exitCode: 1 } : undefined, `ZFS's per-user accounting of 'mnttest' (zfs userspace: cannot get used/quota for mnttest: dataset is busy)`],
      [c => c.command === FIND ? { stdout: '', stderr: `find: '/tank/backups/x': Input/output error`, exitCode: 1 } : undefined, `the files under '/tank/backups' (find: find: '/tank/backups/x': Input/output error)`],
      [c => c.command === GETENT && c.args.join(' ') === 'passwd 1006' ? { stdout: '', stderr: '', exitCode: 1 } : undefined, 'the account database (getent passwd 1006: exit code 1)'],
      // cr.29c: the candidate's by-number group lookup (is gid 1006 a group's?).
      [c => c.command === GETENT && c.args.join(' ') === 'group 1006' ? { stdout: '', stderr: '', exitCode: 1 } : undefined, 'the account database (getent group 1006: exit code 1)'],
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
    assert.deepEqual(keys, ['uid:1006', 'uid:1007'])
    releaseAdd()
    const uids = await Promise.all([a, b].map(async r => (await finished((r.json() as JobAccepted).job.id)).result as { uid: number }))
    assert.deepEqual(uids.map(r => r.uid).sort(), [1006, 1007])
    assert.deepEqual(argvOf(USERADD).map(a => a[a.indexOf('-u') + 1]).sort(), ['1006', '1007'])
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
    assert.equal((carol.result as { uid: number }).uid, 1006)
  })

  it('the promise ends with the job: a failed create frees its id for the next one', async () => {
    broken = c => c.command === USERADD ? { stdout: '', stderr: 'useradd: cannot lock /etc/passwd; try again later.', exitCode: 1 } : undefined
    const failed = await created('/v1/identity/users', { name: 'alice' })
    assert.equal(failed.status, 'failed')
    broken = () => undefined
    const job = await created('/v1/identity/users', { name: 'alice' })
    assert.equal((job.result as { uid: number }).uid, 1006)
  })

  // --- The job door (ruling (j)) -------------------------------------------------

  it('a picked uid that an account takes while the job waits fails the job CONFLICT; no useradd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 202, res.body)
    passwd = [...passwd, 'zed:x:1006:100::/home/zed:/usr/sbin/nologin']
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, `uid 1006 was given meanwhile to user 'zed'. Nothing was created. Create it again and ANAS picks another.`)
    assert.deepEqual(argvOf(USERADD), [])
  })

  it('a picked uid that comes to own a file while the job waits fails the job STATE_CHANGED; no useradd', async () => {
    const release = holdSlots()
    const res = await post('/v1/identity/users', { name: 'alice' })
    assert.equal(res.statusCode, 202, res.body)
    space = { 'mnttest': [0, 1006], 'mnttest/data': [0] }
    release()
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `uid 1006 owns the ZFS filesystem 'mnttest' now (it owned nothing when the request was checked). Nothing was created. Create it again and ANAS picks another.`)
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
