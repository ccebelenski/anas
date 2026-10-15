import type { Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
 * Story cr.42 — the identity verbs on the guard (docs/WAVE3-DESIGN.md §2.5,
 * the identity row is the acceptance list; §3.3 "User / group": the id is
 * the uid / gid; §5.1 "User / group delete": the confirm binds it; §8.2).
 * The H8 property: a state that would refuse at the route but becomes true
 * only AFTER the request was accepted — while the job waits in the queue —
 * refuses the job, and the fake executor shows no mutating argv. One race
 * test per "Missing" cell of the row:
 *
 *  - uid/gid equality (the job used the request-time uid): a user or group
 *    deleted and re-created under the same name → IDENTITY_MISMATCH, for the
 *    deletes and for every other verb on an existing account;
 *  - share references: a share that starts naming the user or group;
 *  - primary group: an account whose primary group becomes the group;
 *
 * plus what came with putting the verbs on the guard: the SMB password's
 * passdb-owner gate and the create's "already exists" re-run in the job, the
 * delete confirm bound to the uid at the route, an smb.conf the job cannot
 * read when the confirm could, and the lock keys every verb takes.
 *
 * The job is held in the REAL queue (the pools-guard pattern): four
 * placeholder jobs fill the four slots, the request is accepted behind them
 * (`queued`), the test changes the node's state, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). There is NO `getent`
 * or `pdbedit` capture under `fixtures/` (the brief assumed one). The
 * closest captured output is the stunt-node transcript checked in as
 * docs/LIVE-PROOF-0.4.3-access.md §1, read from that file below:
 *  - `id accuser; pdbedit -L | grep accuser` → `uid=1004(accuser)
 *    gid=100(users) groups=100(users)` and `accuser:1004:` (the passdb line
 *    is used verbatim);
 *  - `testparm -s --section-name=accz` → the `[accz]` stanza with
 *    `valid users = accuser` that the daemon wrote (a share that names the
 *    user, verbatim; for the group, its one value rewritten to `@accgroup`).
 * The `getent passwd accuser` line is REBUILT from the `id` capture plus the
 * argv the daemon's create ran (`useradd -N -M -s /usr/sbin/nologin`, no
 * `-c`): `accuser:x:1004:100::/home/accuser:/usr/sbin/nologin`; the group
 * line from its `gid=100(users)` (`users:x:100:`). No share-band group was
 * ever captured: `accgroup` is that `users` line with its name and gid
 * rewritten (`accgroup:x:1005:`). Every later flip is one rewrite of these,
 * spelled out at its call site. The base smb.conf is `samba/smb.conf` (the
 * one the cr.39 race tests serve).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const LIVE_PROOF = readFileSync(join(__dirname, '../../../../../docs/LIVE-PROOF-0.4.3-access.md'), 'utf-8')

/** The output lines of `$ <command>` in the live-proof transcript (up to the next blank line). */
function captured(command: string): string[] {
  const marker = `$ ${command}\n`
  const at = LIVE_PROOF.indexOf(marker)
  assert.notEqual(at, -1, `no '${command}' in the live proof`)
  const rest = LIVE_PROOF.slice(at + marker.length).replace(/^\n+/, '')
  return rest.slice(0, rest.indexOf('\n\n')).split('\n')
}

/** Replace exactly one occurrence of `from`. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const [ID_ACCUSER, PDBEDIT_ACCUSER] = captured('id accuser; pdbedit -L | grep accuser')
const ID = /^uid=(\d+)\((\w+)\) gid=(\d+)\((\w+)\)/.exec(ID_ACCUSER)!
assert.ok(ID, ID_ACCUSER)
assert.equal(PDBEDIT_ACCUSER, 'accuser:1004:')
/** `getent passwd accuser`, rebuilt from the `id` capture and the daemon's useradd argv. */
const ACCUSER = `${ID[2]}:x:${ID[1]}:${ID[3]}::/home/${ID[2]}:/usr/sbin/nologin`
/** `getent group users`, rebuilt from the same capture. */
const USERS = `${ID[4]}:x:${ID[3]}:`
/** A share-band group: the `users` line with its name and gid rewritten (no capture exists). */
const ACCGROUP = rewrite(USERS, 'users:x:100:', 'accgroup:x:1005:')

/** `accuser` deleted and re-created under the same name: the next free uid. */
const ACCUSER_RECREATED = rewrite(ACCUSER, ':1004:', ':1006:')
/** `accgroup` deleted and re-created: the next free gid. */
const ACCGROUP_RECREATED = rewrite(ACCGROUP, ':1005:', ':1007:')
/** `usermod -g accgroup accuser`: accuser's primary group becomes accgroup. */
const ACCUSER_IN_ACCGROUP = rewrite(ACCUSER, ':1004:100:', ':1004:1005:')
/** Another account, `Accuser` (uid 1006), whose SMB entry Samba finds for `accuser` case-folded. */
const ACCUSER_OTHER_CASE = rewrite(ACCUSER_RECREATED, 'accuser:x:', 'Accuser:x:').replace('/home/accuser', '/home/Accuser')
const PDBEDIT_OTHER_CASE = rewrite(PDBEDIT_ACCUSER, 'accuser:1004:', 'Accuser:1006:')

const TESTPARM_ACCZ = captured('testparm -s --section-name=accz 2>/dev/null').join('\n')
assert.match(TESTPARM_ACCZ, /^\[accz\]\n\tpath = \/accz\n.*\n\tvalid users = accuser$/)
const SMB_CONF = readFileSync(join(FIXTURES, 'samba/smb.conf'), 'utf-8')
/** The share the daemon wrote for accuser, appended. */
const SMB_CONF_NAMES_ACCUSER = `${SMB_CONF}\n${TESTPARM_ACCZ}\n`
/** The same share, its one value naming the group. */
const SMB_CONF_NAMES_ACCGROUP = `${SMB_CONF}\n${rewrite(TESTPARM_ACCZ, 'valid users = accuser', 'valid users = @accgroup')}\n`

const GETENT = '/usr/bin/getent'
const PDBEDIT = '/usr/bin/pdbedit'
const USERADD = '/usr/sbin/useradd'
const USERMOD = '/usr/sbin/usermod'
const USERDEL = '/usr/sbin/userdel'
const GROUPADD = '/usr/sbin/groupadd'
const GROUPDEL = '/usr/sbin/groupdel'
const GPASSWD = '/usr/bin/gpasswd'
const SMBPASSWD = '/usr/bin/smbpasswd'
const FINDMNT = '/usr/bin/findmnt'
/** cr.29: a create walks the smb.conf share roots; the stunt node's captured mount table (story 18.1) puts /tank on the ext4 root. */
const FINDMNT_FULL = readFileSync(join(FIXTURES, 'mounts/findmnt-full.json'), 'utf-8')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
/** `getent <db> <name>` for a name the database does not hold: exit 2, nothing printed. */
const ABSENT: ExecResult = { stdout: '', stderr: '', exitCode: 2 }

interface Call { command: string, args: string[] }

/** A call that would mean an identity verb acted on the node. */
function isMutation(c: Call): boolean {
  return [USERADD, USERMOD, USERDEL, GROUPADD, GROUPDEL, GPASSWD, SMBPASSWD].includes(c.command)
    || (c.command === PDBEDIT && c.args[0] === '-x')
}

interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, confirm?: boolean }

const DELETE_USER: Req = { method: 'DELETE', url: '/v1/identity/users/accuser', confirm: true }
const DELETE_GROUP: Req = { method: 'DELETE', url: '/v1/identity/groups/accgroup', confirm: true }
const DISABLE_USER: Req = { method: 'PUT', url: '/v1/identity/users/accuser', body: { enabled: false } }
const ENABLE_USER: Req = { method: 'PUT', url: '/v1/identity/users/accuser', body: { enabled: true } }
const SET_PASSWORD: Req = { method: 'POST', url: '/v1/identity/users/accuser/smb-password', body: { password: 'Acc-proof-1' } }
const ADD_MEMBER: Req = { method: 'PUT', url: '/v1/identity/groups/accgroup/members', body: { add: ['accuser'] } }

describe('cr.42 — identity verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let smbConfPath: string
  let app: FastifyInstance | undefined
  let queue: JobQueue
  let calls: Call[] = []
  /** What the node answers right now; a test flips these while the job waits. */
  let passwd: string[] = []
  let groups: string[] = []
  let pdbedit = ''
  /**
   * `getent passwd` (the enumeration) fails: exit 1, nothing printed. No
   * capture of a failing NSS read exists; exit 1 is what getent(1) documents
   * for a database it cannot serve.
   */
  let passwdUnreadable = false

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr42-'))
    smbConfPath = join(dir, 'smb.conf')
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(dir, { recursive: true, force: true })
  })

  /** `getent <db>` / `getent <db> <name>` over the lines the node holds now. */
  function getent(lines: string[], name: string | undefined): ExecResult {
    if (name === undefined)
      return ok(`${lines.join('\n')}\n`)
    const line = lines.find(l => l.split(':')[0] === name)
    return line ? ok(`${line}\n`) : ABSENT
  }

  /** The identity routes over a node holding accuser, users and accgroup, and the base smb.conf. */
  async function serve(): Promise<void> {
    passwd = [ACCUSER]
    groups = [USERS, ACCGROUP]
    pdbedit = `${PDBEDIT_ACCUSER}\n`
    passwdUnreadable = false
    calls = []
    await writeFile(smbConfPath, SMB_CONF)
    const executor = new MockExecutor()
    executor.exec = async (command: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === GETENT) {
        // `-s files` reads the local DB: every account here is local.
        const a = args[0] === '-s' ? args.slice(2) : args
        if (a[0] === 'passwd' && a[1] === undefined && passwdUnreadable)
          return { stdout: '', stderr: '', exitCode: 1 }
        if (a[0] === 'passwd')
          return getent(passwd, a[1])
        if (a[0] === 'group')
          return getent(groups, a[1])
        return ok('')
      }
      if (command === FINDMNT)
        return ok(FINDMNT_FULL)
      if (command === PDBEDIT && args[0] === '-L')
        return ok(pdbedit)
      return ok('')
    }
    queue = new JobQueue()
    app = Fastify({ logger: false })
    await app.register(shareIdentityRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: queue,
      confirmStore: new ConfirmStore(),
      smbConfPath,
      exportsPath: join(dir, 'exports'),
      smbpasswdAvailable: async () => true,
    })
  }

  function send(req: Req, confirm?: string) {
    return app!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.body !== undefined ? JSON_HEADERS : IDENTITY_HEADERS), ...(confirm ? { 'x-anas-confirm': confirm } : {}) },
      ...(req.body !== undefined ? { payload: JSON.stringify(req.body) } : {}),
    })
  }

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

  /**
   * (Challenge and) send the request while all four slots are held: the job
   * is accepted and sits `queued`. Returns its id and the release.
   */
  async function behindFullQueue(req: Req): Promise<{ id: string, release: () => void }> {
    let code: string | undefined
    if (req.confirm) {
      const first = await send(req)
      assert.equal(first.statusCode, 409, first.body)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      code = first.headers['x-anas-confirm-code'] as string
    }
    const release = holdSlots()
    const res = await send(req, code)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue.get(id)?.status, 'queued', 'the accepted job waits behind the held slots')
    return { id, release }
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

  it('control: with nothing changed every held verb runs and acts — the harness does not refuse on its own', async () => {
    for (const [req, acts] of [
      [DELETE_USER, USERDEL],
      [DELETE_GROUP, GROUPDEL],
      [DISABLE_USER, USERMOD],
      [SET_PASSWORD, SMBPASSWD],
      [ADD_MEMBER, GPASSWD],
    ] as const) {
      await serve()
      const { id, release } = await behindFullQueue(req)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'completed', `${req.method} ${req.url}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(c => c.command === acts), `${acts} ran`)
      await app!.close()
      app = undefined
    }
  })

  it('a user deleted and re-created under the same name between the confirm and the job: the delete fails IDENTITY_MISMATCH, nothing removed', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_USER)
    passwd = [ACCUSER_RECREATED]
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.equal(job.error?.message, `User 'accuser' is not the one that was confirmed (uid 1004 at the confirmation, uid 1006 now) — nothing was done; confirm again`)
    assert.deepEqual(calls.filter(isMutation), [], 'no pdbedit -x, no userdel')
  })

  it('a group deleted and re-created under the same name between the confirm and the job: the delete fails IDENTITY_MISMATCH, no groupdel', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_GROUP)
    groups = [USERS, ACCGROUP_RECREATED]
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.match(job.error!.message, /^Group 'accgroup' is not the one that was confirmed \(gid 1005 at the confirmation, gid 1007 now\)/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('every other verb on an existing account compares the uid / gid too (disable, enable, SMB password, members)', async () => {
    for (const [req, flip, idWas, idNow] of [
      [DISABLE_USER, () => { passwd = [ACCUSER_RECREATED] }, 'uid 1004', 'uid 1006'],
      [ENABLE_USER, () => { passwd = [ACCUSER_RECREATED] }, 'uid 1004', 'uid 1006'],
      [SET_PASSWORD, () => { passwd = [ACCUSER_RECREATED] }, 'uid 1004', 'uid 1006'],
      [ADD_MEMBER, () => { groups = [USERS, ACCGROUP_RECREATED] }, 'gid 1005', 'gid 1007'],
    ] as const) {
      await serve()
      const { id, release } = await behindFullQueue(req)
      flip()
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed', `${req.method} ${req.url}`)
      assert.equal(job.error?.code, 'IDENTITY_MISMATCH', `${req.method} ${req.url}`)
      assert.match(job.error!.message, new RegExp(`\\(${idWas} at the confirmation, ${idNow} now\\)`))
      assert.deepEqual(calls.filter(isMutation), [], `${req.method} ${req.url}: no mutating argv`)
      await app!.close()
      app = undefined
    }
  })

  it('a share that starts naming the user between the confirm and the job refuses the delete (referenced-by-share), nothing removed', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_USER)
    await writeFile(smbConfPath, SMB_CONF_NAMES_ACCUSER)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, `User 'accuser' is referenced by share(s): accz (valid users). Remove it from those share parameters first. This refusal has no confirm bypass.`)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('a share that starts naming the group (@group) between the confirm and the job refuses the delete, no groupdel', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_GROUP)
    await writeFile(smbConfPath, SMB_CONF_NAMES_ACCGROUP)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^Group 'accgroup' is referenced by share\(s\): accz \(valid users\)\./)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('an account whose primary group becomes the group between the confirm and the job refuses the delete (primary-group-in-use), no groupdel', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_GROUP)
    passwd = [ACCUSER_IN_ACCGROUP]
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, `Group 'accgroup' is the primary group of: accuser. Change their primary group (or remove the users) first. This refusal has no confirm bypass.`)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('an account database the job cannot read refuses the group delete UNAVAILABLE (the primary-group gate fails closed), no groupdel', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_GROUP)
    passwdUnreadable = true
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'UNAVAILABLE')
    assert.equal(job.error?.message, `ANAS could not read the account database (getent passwd), so it cannot check that group 'accgroup' is nobody's primary group — nothing was done`)
    assert.deepEqual(calls.filter(isMutation), [])

    // The same at the request: 503, no confirm code.
    const res = await send(DELETE_GROUP)
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('the same states at the request are the route\'s hard 409s — the job and the route share the gates', async () => {
    await serve()
    await writeFile(smbConfPath, SMB_CONF_NAMES_ACCUSER)
    const user = await send(DELETE_USER)
    assert.equal(user.statusCode, 409)
    assert.equal(user.json().error.reason, 'referenced-by-share')
    assert.equal(user.headers['x-anas-confirm-code'], undefined)

    await writeFile(smbConfPath, SMB_CONF)
    passwd = [ACCUSER_IN_ACCGROUP]
    const group = await send(DELETE_GROUP)
    assert.equal(group.statusCode, 409)
    assert.equal(group.json().error.reason, 'primary-group-in-use')
    assert.equal(group.headers['x-anas-confirm-code'], undefined)
    assert.equal(queue.list().length, 0)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('an SMB entry of ANOTHER account that Samba would find for the user appears while the password job waits: refused, smbpasswd never runs', async () => {
    await serve()
    const { id, release } = await behindFullQueue(SET_PASSWORD)
    // `Accuser` (uid 1006) gets its SMB password; accuser's own entry is gone.
    passwd = [ACCUSER, ACCUSER_OTHER_CASE]
    pdbedit = `${PDBEDIT_OTHER_CASE}\n`
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /entry for 'accuser' is stored as 'Accuser', which belongs to another account \(uid 1006\)/)
    assert.deepEqual(calls.filter(isMutation), [], 'the password never lands on the other account')
  })

  it('a create whose name is taken while its job waits fails CONFLICT, no useradd', async () => {
    await serve()
    passwd = []
    pdbedit = ''
    const { id, release } = await behindFullQueue({ method: 'POST', url: '/v1/identity/users', body: { name: 'accuser', smbPassword: 'Acc-proof-1' } })
    passwd = [ACCUSER]
    pdbedit = `${PDBEDIT_ACCUSER}\n`
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, `User 'accuser' already exists`)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('an smb.conf the confirm could read and the job cannot fails the delete STATE_CHANGED, nothing removed', async () => {
    for (const req of [DELETE_USER, DELETE_GROUP]) {
      await serve()
      const { id, release } = await behindFullQueue(req)
      // A directory where the file was: the read fails (EISDIR), it is not absent.
      await rm(smbConfPath)
      await mkdir(smbConfPath)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed', req.url)
      assert.equal(job.error?.code, 'STATE_CHANGED', req.url)
      assert.match(job.error!.message, /^ANAS could not read smb\.conf when the job ran, so it cannot check that no share names (user 'accuser'|group 'accgroup') \(it could at the confirmation\)/)
      assert.deepEqual(calls.filter(isMutation), [], req.url)
      await app!.close()
      app = undefined
      await rm(smbConfPath, { recursive: true, force: true })
    }
  })

  it('an smb.conf unreadable already at the confirm is disclosed there and the confirmed job runs', async () => {
    await serve()
    await rm(smbConfPath)
    await mkdir(smbConfPath)
    const first = await send(DELETE_USER)
    assert.equal(first.statusCode, 409)
    assert.ok((first.json().error.warnings as string[]).some(w => w.startsWith('ANAS could not read smb.conf')))
    const res = await send(DELETE_USER, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })
})

describe('cr.42 — the delete confirm binds the uid / gid', () => {
  let dir: string
  let app: FastifyInstance | undefined
  let queue: JobQueue
  let passwd: string[] = []
  let groups: string[] = []
  const calls: Call[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr42-confirm-'))
    const smbConfPath = join(dir, 'smb.conf')
    await writeFile(smbConfPath, readFileSync(join(FIXTURES, 'samba/smb.conf'), 'utf-8'))
    passwd = [ACCUSER]
    groups = [USERS, ACCGROUP]
    calls.length = 0
    const executor = new MockExecutor()
    executor.exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === GETENT) {
        const a = args[0] === '-s' ? args.slice(2) : args
        const lines = a[0] === 'passwd' ? passwd : a[0] === 'group' ? groups : []
        if (a[1] === undefined)
          return ok(`${lines.join('\n')}\n`)
        const line = lines.find(l => l.split(':')[0] === a[1])
        return line ? ok(`${line}\n`) : ABSENT
      }
      if (command === PDBEDIT && args[0] === '-L')
        return ok(`${PDBEDIT_ACCUSER}\n`)
      return ok('')
    }
    queue = new JobQueue()
    app = Fastify({ logger: false })
    await app.register(shareIdentityRoutes, { prefix: '/v1', executor, jobQueue: queue, confirmStore: new ConfirmStore(), smbConfPath, exportsPath: join(dir, 'exports'), smbpasswdAvailable: async () => true })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(dir, { recursive: true, force: true })
  })

  function del(url: string, confirm?: string) {
    return app!.inject({ method: 'DELETE', url, headers: { ...IDENTITY_HEADERS, ...(confirm ? { 'x-anas-confirm': confirm } : {}) } })
  }

  it('a code minted for uid 1004 does not delete the re-created accuser (uid 1006): 409 IDENTITY_MISMATCH naming both, a fresh code', async () => {
    const first = await del('/v1/identity/users/accuser')
    assert.equal(first.statusCode, 409)
    passwd = [ACCUSER_RECREATED]
    const res = await del('/v1/identity/users/accuser', first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.equal(res.json().error.message, `User 'accuser' is not the one that was confirmed (uid 1004 at the confirmation, uid 1006 now) — nothing was done; confirm again`)
    assert.deepEqual(res.json().error.confirmed, { uid: '1004' })
    assert.deepEqual(res.json().error.current, { uid: '1006' })
    assert.equal(queue.list().length, 0)

    // The fresh code is bound to the account that is there now.
    const again = await del('/v1/identity/users/accuser', res.headers['x-anas-confirm-code'] as string)
    assert.equal(again.statusCode, 202, again.body)
  })

  it('the group delete code binds the gid the same way', async () => {
    const first = await del('/v1/identity/groups/accgroup')
    assert.equal(first.statusCode, 409)
    groups = [USERS, ACCGROUP_RECREATED]
    const res = await del('/v1/identity/groups/accgroup', first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.deepEqual(res.json().error.confirmed, { gid: '1005' })
    assert.equal(queue.list().length, 0)
    assert.ok(!calls.some(isMutation))
  })

  it('the challenge still names the uid it binds in its warnings', async () => {
    const first = await del('/v1/identity/users/accuser')
    const warnings = first.json().error.warnings as string[]
    assert.equal(warnings[0], `User 'accuser' (uid 1004) will be removed from the system`)
  })
})

describe('cr.42 — identity verbs take their lock keys', () => {
  let dir: string
  let app: FastifyInstance | undefined
  let queue: JobQueue
  let passwd: string[] = []
  const calls: Call[] = []
  const paused = new Map<string, Promise<void>>()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr42-locks-'))
    const smbConfPath = join(dir, 'smb.conf')
    await writeFile(smbConfPath, await readFile(join(FIXTURES, 'samba/smb.conf'), 'utf-8'))
    passwd = [ACCUSER]
    const groups = [USERS, ACCGROUP]
    calls.length = 0
    paused.clear()
    const executor = new MockExecutor()
    executor.exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === GETENT) {
        const a = args[0] === '-s' ? args.slice(2) : args
        const lines = a[0] === 'passwd' ? passwd : a[0] === 'group' ? groups : []
        if (a[1] === undefined)
          return ok(`${lines.join('\n')}\n`)
        const line = lines.find(l => l.split(':')[0] === a[1])
        return line ? ok(`${line}\n`) : ABSENT
      }
      if (command === FINDMNT)
        return ok(FINDMNT_FULL)
      if (command === PDBEDIT && args[0] === '-L')
        return ok(passwd.includes(ACCUSER) ? `${PDBEDIT_ACCUSER}\n` : '')
      const hold = paused.get(command)
      if (hold)
        await hold
      return ok('')
    }
    queue = new JobQueue()
    app = Fastify({ logger: false })
    await app.register(shareIdentityRoutes, { prefix: '/v1', executor, jobQueue: queue, confirmStore: new ConfirmStore(), smbConfPath, exportsPath: join(dir, 'exports'), smbpasswdAvailable: async () => true })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(dir, { recursive: true, force: true })
  })

  function pause(command: string): () => void {
    let release!: () => void
    paused.set(command, new Promise<void>((resolve) => {
      release = resolve
    }))
    return release
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
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

  async function confirmedDelete(url: string): Promise<string> {
    const first = await app!.inject({ method: 'DELETE', url, headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const res = await app!.inject({ method: 'DELETE', url, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
    assert.equal(res.statusCode, 202, res.body)
    return (res.json() as JobAccepted).job.id
  }

  it('a user delete holds uid:<n> and the name key while it runs; a disable of the same user waits for the LOCK (no slot) and then finds the user gone', async () => {
    const releaseDel = pause(USERDEL)
    const delId = await confirmedDelete('/v1/identity/users/accuser')
    await until(() => calls.some(c => c.command === USERDEL))
    assert.deepEqual(queue.heldLocks(), [
      { key: 'uid:1004', mode: 'exclusive', holders: [delId] },
      { key: 'idname:accuser', mode: 'exclusive', holders: [delId] },
    ])

    // The route door passes (accuser is still there); the job waits for uid:1004.
    const res = await app!.inject({ method: 'PUT', url: '/v1/identity/users/accuser', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: false }) })
    assert.equal(res.statusCode, 202, res.body)
    const disableId = (res.json() as JobAccepted).job.id
    assert.equal(queue.get(disableId)?.status, 'queued')
    assert.equal(queue.get(disableId)?.progress, `waiting for identity.user.delete (job ${delId}) on user 'accuser' (uid 1004)`)
    assert.equal(queue.list('running').length, 1, 'the waiting disable holds none of the free slots')

    passwd = [] // userdel took the account off the node
    releaseDel()
    assert.equal((await finished(delId)).status, 'completed')
    const disabled = await finished(disableId)
    assert.equal(disabled.status, 'failed')
    assert.equal(disabled.error?.code, 'IDENTITY_MISMATCH')
    assert.match(disabled.error!.message, /\(uid 1004 at the confirmation, unreadable now\)/)
    assert.ok(!calls.some(c => c.command === USERMOD), 'usermod never ran')
    assert.deepEqual(queue.heldLocks(), [])
  })

  it('a group delete holds gid:<n> and the name key; a members edit holds gid:<n> only', async () => {
    const releaseDel = pause(GROUPDEL)
    const delId = await confirmedDelete('/v1/identity/groups/accgroup')
    await until(() => calls.some(c => c.command === GROUPDEL))
    assert.deepEqual(queue.heldLocks().map(l => [l.key, l.mode]), [['gid:1005', 'exclusive'], ['idname:accgroup', 'exclusive']])
    releaseDel()
    assert.equal((await finished(delId)).status, 'completed')

    const releaseMembers = pause(GPASSWD)
    const res = await app!.inject({ method: 'PUT', url: '/v1/identity/groups/accgroup/members', headers: JSON_HEADERS, payload: JSON.stringify({ add: ['accuser'] }) })
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === GPASSWD))
    assert.deepEqual(queue.heldLocks().map(l => [l.key, l.mode]), [['gid:1005', 'exclusive']])
    releaseMembers()
    assert.equal((await finished(id)).status, 'completed')
  })

  it('a create holds the case-folded name key, its uid:<n> (cr.29) and the gid of every group it joins; a disable / SMB password holds uid:<n> only', async () => {
    passwd = []
    const releaseAdd = pause(USERADD)
    const res = await app!.inject({ method: 'POST', url: '/v1/identity/users', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'AccUser', groups: ['accgroup'] }) })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === USERADD))
    assert.deepEqual(queue.heldLocks().map(l => [l.key, l.mode]), [['idname:accuser', 'exclusive'], ['uid:1000', 'exclusive'], ['gid:1005', 'exclusive']])
    releaseAdd()
    assert.equal((await finished(id)).status, 'completed')

    passwd = [ACCUSER]
    for (const [method, url, body, command] of [
      ['PUT', '/v1/identity/users/accuser', { enabled: false }, USERMOD],
      ['POST', '/v1/identity/users/accuser/smb-password', { password: 'Acc-proof-1' }, SMBPASSWD],
    ] as const) {
      calls.length = 0
      const release = pause(command)
      const r = await app!.inject({ method, url, headers: JSON_HEADERS, payload: JSON.stringify(body) })
      const jobId = (r.json() as JobAccepted).job.id
      await until(() => calls.some(c => c.command === command))
      assert.deepEqual(queue.heldLocks().map(l => [l.key, l.mode]), [['uid:1004', 'exclusive']], url)
      release()
      assert.equal((await finished(jobId)).status, 'completed', url)
      paused.delete(command)
    }
  })
})
