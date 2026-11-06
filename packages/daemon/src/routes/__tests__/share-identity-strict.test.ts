import type { Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * Story cr.58 — the 2026-10-16 review's M4, M5, L1 and L2
 * (docs/CODE-REVIEW-2026-10-16.md), each finding's scenario rebuilt over the
 * real routes and a fake executor, at the route door and (where a job runs)
 * at the job door while the job waits in the real queue (the cr.42 pattern:
 * four held slots, the request accepted `queued`, the node flipped, slots
 * released):
 *
 *  - M4: a `pdbedit -L` that fails is not "no entry" — the gates and the jobs
 *    of create, SMB password, enable, disable and delete refuse 503 /
 *    fail UNAVAILABLE with a sentence naming the read, and no
 *    usermod / smbpasswd / `pdbedit -x` / userdel / useradd argv runs; the
 *    list GETs keep failing open;
 *  - M5: a SAME-case orphan entry refuses a create that sets no SMB password;
 *  - L1: a members edit gates each MEMBER, not only the group;
 *  - L2: a Proxmox VE `@pam` login is a system account at every user door.
 *    identity.5 (#78, ruled 2026-10-29) re-pinned cr.58's other criterion:
 *    membership of root / sudo / adm / wheel / admin made an in-band account
 *    a system account; it no longer does — an in-band account is a share
 *    account whatever groups it sits in.
 *
 * FIXTURES (ruling (l)): the account and passdb lines are the stunt-node
 * capture in docs/LIVE-PROOF-0.4.3-access.md §1 (`id accuser; pdbedit -L |
 * grep accuser` → `uid=1004(accuser) gid=100(users)`, `accuser:1004:`), the
 * passwd line rebuilt from it and the daemon's useradd argv exactly as
 * share-identity-guard.test.ts does; the orphan shape `<name>:4294967295:`
 * is identity.3's stunt-node reproduction (share-identity.test.ts); the PVE
 * user list is the stunt node's captured /etc/pve/user.cfg
 * (docs/probes/wave2-node/out/captures/user.cfg). NO capture of a FAILING
 * `pdbedit -L` exists: the fake answers exit 1 with the review's probe
 * stderr (`tdb locked`), and no stdout. The sudo / root group lines are
 * Debian's base-passwd numbers (`sudo:x:27:`, `root:x:0:`; the same gid the
 * cr.3 tests use for sudo). Every rewrite is spelled out where it is made.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIVE_PROOF = readFileSync(join(__dirname, '../../../../../docs/LIVE-PROOF-0.4.3-access.md'), 'utf-8')
const USER_CFG = readFileSync(join(__dirname, '../../../../../docs/probes/wave2-node/out/captures/user.cfg'), 'utf-8')

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
/** Debian base-passwd: the root and sudo groups. */
const ROOT_GROUP = 'root:x:0:'
const SUDO = 'sudo:x:27:'
/** root's account (Debian base-passwd). */
const ROOT = 'root:x:0:0:root:/root:/bin/bash'

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
const FINDMNT_FULL = readFileSync(join(__dirname, '../../fixtures/mounts/findmnt-full.json'), 'utf-8')

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
/** The review's probe: `pdbedit -L` exits 1 "tdb locked" (no capture of a failing pdbedit exists). */
const PDBEDIT_LOCKED: ExecResult = { stdout: '', stderr: 'tdb locked\n', exitCode: 1 }
/** cr.58r P1: the same transient tdb lock, hitting `smbpasswd -d/-e` instead. */
const SMBPASSWD_LOCKED: ExecResult = { stdout: '', stderr: 'tdb locked\n', exitCode: 1 }

interface Call { command: string, args: string[] }

/** A call that would mean an identity verb acted on the node. */
function isMutation(c: Call): boolean {
  return [USERADD, USERMOD, USERDEL, GROUPADD, GROUPDEL, GPASSWD, SMBPASSWD].includes(c.command)
    || (c.command === PDBEDIT && c.args[0] === '-x')
}

interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, confirm?: boolean }

const DELETE_USER: Req = { method: 'DELETE', url: '/v1/identity/users/accuser', confirm: true }
const DISABLE_USER: Req = { method: 'PUT', url: '/v1/identity/users/accuser', body: { enabled: false } }
const ENABLE_USER: Req = { method: 'PUT', url: '/v1/identity/users/accuser', body: { enabled: true } }
const SET_PASSWORD: Req = { method: 'POST', url: '/v1/identity/users/accuser/smb-password', body: { password: 'Acc-proof-1' } }

describe('cr.58 — identity gates and jobs read strictly; a members edit gates each member; @pam logins are system accounts', () => {
  let dir: string
  let app: FastifyInstance | undefined
  let queue: JobQueue
  let calls: Call[] = []
  /** What the node answers right now; a test flips these while a job waits. */
  let passwd: string[] = []
  let groups: string[] = []
  let pdbedit = ''
  /** Everything the server's pino logger wrote (JSON lines). */
  let logLines: string[] = []
  /** `pdbedit -L` fails (exit 1, `tdb locked`). */
  let pdbeditFails = false
  /** `smbpasswd -d/-e` fails (exit 1, `tdb locked`) — cr.58r P1. */
  let smbpasswdFails = false
  /** `getent group` exits non-zero with PARTIAL stdout — cr.58r P2 (the review's EXTRA1 shape). */
  let groupsPartial: string | undefined
  /** `pdbedit -x` fails (exit 1) — cr.58r P3. */
  let pdbeditXFails = false

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr58-'))
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

  /**
   * The identity routes over a node holding accuser, users and accgroup, the
   * captured passdb line and an smb.conf naming nobody. `userCfg`: the text
   * of /etc/pve/user.cfg (default: the stunt node's capture — root@pam only).
   */
  async function serve(opts: { userCfg?: string } = {}): Promise<void> {
    passwd = [ROOT, ACCUSER]
    groups = [ROOT_GROUP, SUDO, USERS, ACCGROUP]
    pdbedit = `${PDBEDIT_ACCUSER}\n`
    pdbeditFails = false
    smbpasswdFails = false
    groupsPartial = undefined
    pdbeditXFails = false
    calls = []
    const smbConfPath = join(dir, 'smb.conf')
    await writeFile(smbConfPath, '[global]\n\tworkgroup = WORKGROUP\n')
    const pveUserCfgPath = join(dir, 'user.cfg')
    await writeFile(pveUserCfgPath, opts.userCfg ?? USER_CFG)
    const executor = new MockExecutor()
    executor.exec = async (command: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === GETENT) {
        // `-s files` reads the local DB: every account here is local.
        const a = args[0] === '-s' ? args.slice(2) : args
        if (a[0] === 'passwd')
          return getent(passwd, a[1])
        if (a[0] === 'group') {
          // cr.58r P2: a `getent group` that ran and exited non-zero with a
          // PARTIAL listing (the review's EXTRA1: the sudo line cut off
          // mid-members-list, so the admin's membership is missing from what
          // was printed).
          if (groupsPartial !== undefined && a[1] === undefined)
            return { stdout: groupsPartial, stderr: '', exitCode: 1 }
          return getent(groups, a[1])
        }
        return ok('')
      }
      if (command === FINDMNT)
        return ok(FINDMNT_FULL)
      if (command === PDBEDIT && args[0] === '-L')
        return pdbeditFails ? PDBEDIT_LOCKED : ok(pdbedit)
      if (command === PDBEDIT && args[0] === '-x' && pdbeditXFails)
        return { stdout: '', stderr: 'tdb locked\n', exitCode: 1 }
      if (command === SMBPASSWD && smbpasswdFails)
        return SMBPASSWD_LOCKED
      if (command === USERADD) {
        // The account now exists (useradd -u <uid> … <name>), and `pdbedit -L`
        // prints the uid Samba resolves for a stored name AT LISTING TIME
        // (parsers/pdbedit.ts), so an unmapped entry under that name maps.
        const name = args.at(-1)!
        const uid = args[args.indexOf('-u') + 1]!
        passwd.push(rewrite(rewrite(ACCUSER, ':1004:', `:${uid}:`), 'accuser:x:', `${name}:x:`).replace('/home/accuser', `/home/${name}`))
        pdbedit = pdbedit.split('\n').map(l => l === `${name}:4294967295:` ? `${name}:${uid}:` : l).join('\n')
      }
      return ok('')
    }
    queue = new JobQueue()
    // A capturing logger: the identity.3 journal line is the one thing the
    // orphan pre-drop path (M5) promises that no argv can show.
    logLines = []
    const stream = {
      write: (line: string) => {
        logLines.push(line)
      },
    } as unknown as NodeJS.WritableStream
    app = Fastify({ logger: { level: 'info', stream } })
    await app.register(shareIdentityRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: queue,
      confirmStore: new ConfirmStore(),
      smbConfPath,
      exportsPath: join(dir, 'exports'),
      pveUserCfgPath,
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

  /** (Challenge and) send the request while all four slots are held: the job sits `queued`. */
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

  const UNREADABLE = /^ANAS could not read Samba's password database \(pdbedit -L: tdb locked\), so it cannot check /

  // --- M4 -------------------------------------------------------------------

  it('M4 control: with the passdb readable, disable / enable / delete / SMB password run their SMB step', async () => {
    for (const [req, smbArgv] of [
      [DISABLE_USER, [SMBPASSWD, '-d', 'accuser']],
      [ENABLE_USER, [SMBPASSWD, '-e', 'accuser']],
      [DELETE_USER, [PDBEDIT, '-x', '-u', 'accuser']],
      [SET_PASSWORD, [SMBPASSWD, '-a', '-s', 'accuser']],
    ] as const) {
      await serve()
      const { id, release } = await behindFullQueue(req)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'completed', `${req.method} ${req.url}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(c => [c.command, ...c.args].join(' ') === smbArgv.join(' ')), `${smbArgv.join(' ')} ran`)
      await app!.close()
      app = undefined
    }
  })

  it('M4: a pdbedit -L that fails at the request is a 503 naming the read — disable, enable, delete, SMB password and create; no job, no confirm code', async () => {
    for (const [req, check] of [
      [DISABLE_USER, `whether 'accuser' has SMB access to disable`],
      [ENABLE_USER, `whether 'accuser' has SMB access to enable`],
      [DELETE_USER, `whether 'accuser' has an SMB password entry to remove before userdel`],
      [SET_PASSWORD, `that the SMB entry 'accuser' would write is not another account's. The password was NOT changed`],
      [{ method: 'POST', url: '/v1/identity/users', body: { name: 'newuser' } } as Req, `whether an SMB entry already answers to 'newuser'. The user was NOT created`],
    ] as const) {
      await serve()
      pdbeditFails = true
      const res = await send(req)
      assert.equal(res.statusCode, 503, `${req.method} ${req.url}: ${res.body}`)
      assert.equal(res.json().error.code, 'UNAVAILABLE')
      assert.equal(res.json().error.message, `ANAS could not read Samba's password database (pdbedit -L: tdb locked), so it cannot check ${check} — nothing was done`)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(queue.list().length, 0)
      assert.deepEqual(calls.filter(isMutation), [])
      await app!.close()
      app = undefined
    }
  })

  it('M4 (the review\'s disable): pdbedit fails while the disable waits — the job fails UNAVAILABLE before usermod, never a usermod without its smbpasswd -d', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DISABLE_USER)
    pdbeditFails = true
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'UNAVAILABLE')
    assert.match(job.error!.message, UNREADABLE)
    assert.deepEqual(calls.filter(isMutation), [], 'no usermod --expiredate 1, no smbpasswd -d')
  })

  it('M4 (the review\'s delete): pdbedit fails between the confirm and the job — the job fails UNAVAILABLE, no pdbedit -x and no userdel', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_USER)
    pdbeditFails = true
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'UNAVAILABLE')
    assert.equal(job.error?.message, `ANAS could not read Samba's password database (pdbedit -L: tdb locked), so it cannot check whether 'accuser' has an SMB password entry to remove before userdel — nothing was done`)
    assert.deepEqual(calls.filter(isMutation), [], 'no orphan entry is left behind a userdel')
  })

  it('M4 (the review\'s SMB password): Name over the folded entry of uid 1005 with pdbedit failing — 503 at the route, and a failed job when it fails while waiting; smbpasswd never runs', async () => {
    // `Name` (uid 1006) and `name` (uid 1005): accuser's line with name and
    // uid rewritten twice; the passdb holds `name:1005:` (the captured line
    // rewritten) — the entry Samba finds for `Name`, case-folded.
    const NAME = rewrite(rewrite(ACCUSER, ':1004:', ':1006:'), 'accuser:x:', 'Name:x:').replace('/home/accuser', '/home/Name')
    const LOWER = rewrite(rewrite(ACCUSER, ':1004:', ':1005:'), 'accuser:x:', 'name:x:').replace('/home/accuser', '/home/name')
    const req: Req = { method: 'POST', url: '/v1/identity/users/Name/smb-password', body: { password: 'Acc-proof-1' } }

    await serve()
    passwd = [ROOT, NAME, LOWER]
    pdbedit = `${rewrite(PDBEDIT_ACCUSER, 'accuser:1004:', 'name:1005:')}\n`
    // Readable: the owner gate refuses (identity.3) — the M4 scenario is the
    // same request with the read failing.
    const owned = await send(req)
    assert.equal(owned.statusCode, 409)
    assert.equal(owned.json().error.reason, 'passdb-entry-owned')
    pdbeditFails = true
    const res = await send(req)
    assert.equal(res.statusCode, 503)
    assert.match(res.json().error.message, UNREADABLE)
    assert.deepEqual(calls.filter(isMutation), [])

    // At the job door: accepted while the passdb held only Name's own (no) entry,
    // then `name:1005:` appears and pdbedit starts failing — refused, not written.
    pdbeditFails = false
    pdbedit = ''
    const { id, release } = await behindFullQueue(req)
    pdbedit = `${rewrite(PDBEDIT_ACCUSER, 'accuser:1004:', 'name:1005:')}\n`
    pdbeditFails = true
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'UNAVAILABLE')
    assert.match(job.error!.message, UNREADABLE)
    assert.deepEqual(calls.filter(isMutation), [], 'uid 1005\'s SMB password is never overwritten')
  })

  it('M4: a create whose passdb read fails while it waits fails UNAVAILABLE, no useradd', async () => {
    await serve()
    const { id, release } = await behindFullQueue({ method: 'POST', url: '/v1/identity/users', body: { name: 'newuser' } })
    pdbeditFails = true
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'UNAVAILABLE')
    assert.match(job.error!.message, UNREADABLE)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('M4: the list GETs still fail open — a failing pdbedit lists every user with smbEnabled false', async () => {
    await serve()
    pdbeditFails = true
    const res = await app!.inject({ method: 'GET', url: '/v1/identity/users', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const data = res.json().data as { name: string, smbEnabled: boolean }[]
    assert.deepEqual(data.map(u => [u.name, u.smbEnabled]), [['root', false], ['accuser', false]])
    const one = await app!.inject({ method: 'GET', url: '/v1/identity/users/accuser', headers: IDENTITY_HEADERS })
    assert.equal(one.statusCode, 200)
    assert.equal(one.json().data.smbEnabled, false)
  })

  // --- M5 -------------------------------------------------------------------

  /**
   * accuser deleted at the CLI with its SMB entry left behind (what M4's
   * fail-open delete used to manufacture): no account, and the captured
   * passdb line with its uid unmapped — identity.3's orphan shape.
   */
  const ORPHAN_ACCUSER = `${rewrite(PDBEDIT_ACCUSER, 'accuser:1004:', 'accuser:4294967295:')}\n`
  const CREATE_ACCUSER: Req = { method: 'POST', url: '/v1/identity/users', body: { name: 'accuser' } }

  it('M5 (the review\'s create): a SAME-case orphan entry refuses a create with no SMB password — 409 passdb-orphan naming the takeover and the fix, no useradd', async () => {
    await serve()
    passwd = [ROOT]
    pdbedit = ORPHAN_ACCUSER
    const res = await send(CREATE_ACCUSER)
    assert.equal(res.statusCode, 409)
    const { error } = res.json() as { error: { code: string, reason: string, message: string } }
    assert.equal(error.code, 'CONFLICT')
    assert.equal(error.reason, 'passdb-orphan')
    assert.equal(error.message, `Samba's password database holds an orphan entry stored as 'accuser' (its account no longer exists). A new account named 'accuser' would take it over, and log in over SMB with the deleted account's password. Set an SMB password in this dialog to replace it, or remove it first with: pdbedit -x -u accuser. The user was NOT created.`)
    assert.equal(queue.list().length, 0)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('M5: the same-case orphan appearing while the create waits refuses the job, no useradd', async () => {
    await serve()
    passwd = [ROOT]
    pdbedit = ''
    const { id, release } = await behindFullQueue(CREATE_ACCUSER)
    pdbedit = ORPHAN_ACCUSER
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^Samba's password database holds an orphan entry stored as 'accuser'/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('M5: with an SMB password the create goes ahead and sets the NEW password on a FRESH entry (useradd, pdbedit -x of the orphan, then smbpasswd -a; verified exact-case)', async () => {
    await serve()
    passwd = [ROOT]
    pdbedit = ORPHAN_ACCUSER
    const res = await send({ ...CREATE_ACCUSER, body: { name: 'accuser', smbPassword: 'Acc-proof-1' } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // cr.58r P3: the orphan is DROPPED before smbpasswd -a — `smbpasswd -a`
    // on the existing entry would have kept its old attributes (a `D` flag
    // included), leaving the new account's SMB entry disabled.
    const muts = calls.filter(isMutation).map(c => [c.command, ...c.args])
    assert.deepEqual(muts.map(m => m[0]), [USERADD, PDBEDIT, SMBPASSWD])
    assert.deepEqual(muts[1], [PDBEDIT, '-x', '-u', 'accuser'])
    assert.deepEqual(muts[2], [SMBPASSWD, '-a', '-s', 'accuser'])
    assert.equal((job.result as { smbEntryReplaced?: string }).smbEntryReplaced, 'accuser')
    // a639a58c3 (node pass F2): the pre-drop journals the identity.3 replace
    // sentence EXACTLY ONCE — cr.58r's drop ahead of `smbpasswd -a` made
    // setSmbPasswordVerified's own mismatch branch unreachable on this path,
    // so without this line a removed entry left no journal record at all.
    const identityLines = logLines.filter(l => l.includes('identity: SMB passdb entry'))
    assert.equal(identityLines.length, 1, logLines.join(''))
    assert.match(identityLines[0], /identity: SMB passdb entry stored as 'accuser' did not match account 'accuser' \(uid \d+\); replaced it \(pdbedit -x -u accuser, then smbpasswd -a accuser\)/)
  })

  // --- L2 -------------------------------------------------------------------

  /** `usermod -aG sudo accuser`: a hand-made admin login, still uid 1004 (in the band). */
  const SUDO_ACCUSER = rewrite(SUDO, 'sudo:x:27:', 'sudo:x:27:accuser')
  /** The captured user.cfg with accuser made a PVE login: its root@pam line rewritten, appended. */
  const ROOT_PAM = USER_CFG.split('\n').find(l => l.startsWith('user:root@pam:'))!
  const USER_CFG_ACCUSER = `${USER_CFG}${rewrite(ROOT_PAM, 'user:root@pam:', 'user:accuser@pam:')}\n`
  const USER_VERBS = [DISABLE_USER, ENABLE_USER, DELETE_USER, SET_PASSWORD]
  const SUFFIX = `System accounts (uid/gid below 1000 or above 60000, or a Proxmox VE @pam login) are managed outside ANAS.`

  /** Send a verb through to its job (a delete through its confirm code); the finished job. */
  async function run(req: Req): Promise<Job> {
    let code: string | undefined
    if (req.confirm) {
      const first = await send(req)
      assert.equal(first.statusCode, 409, first.body)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      code = first.headers['x-anas-confirm-code'] as string
    }
    const res = await send(req, code)
    assert.equal(res.statusCode, 202, `${req.method} ${req.url}: ${res.body}`)
    return finished((res.json() as JobAccepted).job.id)
  }

  /** The act each user verb ends in (the passdb holds accuser, so the SMB steps run too). */
  const VERB_ACT: Array<[Req, string[]]> = [
    [DISABLE_USER, [USERMOD, '--expiredate', '1', 'accuser']],
    [ENABLE_USER, [USERMOD, '--expiredate', '', 'accuser']],
    [DELETE_USER, [USERDEL, 'accuser']],
    [SET_PASSWORD, [SMBPASSWD, '-a', '-s', 'accuser']],
  ]

  it('identity.5 (#78): an in-band sudo member is a share account — disable, enable, delete and SMB password all run', async () => {
    for (const [req, act] of VERB_ACT) {
      await serve()
      groups = [ROOT_GROUP, SUDO_ACCUSER, USERS, ACCGROUP]
      const job = await run(req)
      assert.equal(job.status, 'completed', `${req.method} ${req.url}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.filter(isMutation).some(c => [c.command, ...c.args].join(' ') === act.join(' ')), `${act.join(' ')} ran: ${JSON.stringify(calls.filter(isMutation))}`)
      await app!.close()
      app = undefined
    }
  })

  it('L2: a Proxmox VE @pam login is a system account at every user verb; the stunt node\'s own user.cfg (root@pam only) refuses nobody in the band', async () => {
    for (const req of USER_VERBS) {
      await serve({ userCfg: USER_CFG_ACCUSER })
      const res = await send(req)
      assert.equal(res.statusCode, 409, `${req.method} ${req.url}: ${res.body}`)
      assert.equal(res.json().error.code, 'SYSTEM_ACCOUNT')
      assert.equal(res.json().error.message, `User 'accuser' (uid 1004) is a system account: it is a Proxmox VE login ('accuser@pam'). ${SUFFIX}`)
      assert.deepEqual(calls.filter(isMutation), [])
      await app!.close()
      app = undefined
    }
    // The captured user.cfg as it is: root@pam is its only pam login.
    await serve()
    const res = await send(DISABLE_USER)
    assert.equal(res.statusCode, 202, res.body)
  })

  it('identity.5: a root-group PRIMARY gid no longer makes an in-band account a system account — gid 0 included, the disable runs', async () => {
    await serve()
    passwd = [ROOT, rewrite(ACCUSER, ':1004:100:', ':1004:0:')]
    const job = await run(DISABLE_USER)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(c => c.command === USERMOD).map(c => c.args), [['--expiredate', '1', 'accuser']])
  })

  it('identity.5: the account becoming a @pam login while the delete waits refuses the job SYSTEM_ACCOUNT — no pdbedit -x, no userdel; joining sudo while it waits does not', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_USER)
    await writeFile(join(dir, 'user.cfg'), USER_CFG_ACCUSER)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'SYSTEM_ACCOUNT')
    assert.equal(job.error?.message, `User 'accuser' (uid 1004) is a system account: it is a Proxmox VE login ('accuser@pam'). ${SUFFIX}`)
    assert.deepEqual(calls.filter(isMutation), [])
    await app!.close()
    app = undefined

    await serve()
    const sudo = await behindFullQueue(DELETE_USER)
    groups = [ROOT_GROUP, SUDO_ACCUSER, USERS, ACCGROUP]
    sudo.release()
    const done = await finished(sudo.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.deepEqual(calls.filter(c => c.command === USERDEL).map(c => c.args), [['accuser']])
  })

  // --- L1 -------------------------------------------------------------------

  /** Debian base-passwd: pveproxy's account. */
  const WWW_DATA = 'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin'
  const members = (body: { add?: string[], remove?: string[] }): Req => ({ method: 'PUT', url: '/v1/identity/groups/accgroup/members', body })
  const MEMBERS_SUFFIX = (verb: string) => ` It cannot be ${verb} group 'accgroup' here.`

  it('L1 (the review\'s probe): adding root and www-data to a share group is 409 SYSTEM_ACCOUNT naming the member, no gpasswd', async () => {
    for (const [add, message] of [
      [['root', 'www-data'], `User 'root' (uid 0) is a system account. System accounts (uid/gid below 1000 or above 60000) are managed outside ANAS.${MEMBERS_SUFFIX('added to')}`],
      [['www-data'], `User 'www-data' (uid 33) is a system account. System accounts (uid/gid below 1000 or above 60000) are managed outside ANAS.${MEMBERS_SUFFIX('added to')}`],
    ] as const) {
      await serve()
      passwd = [ROOT, WWW_DATA, ACCUSER]
      const res = await send(members({ add: [...add] }))
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.code, 'SYSTEM_ACCOUNT')
      assert.equal(res.json().error.message, message)
      assert.equal(queue.list().length, 0)
      assert.deepEqual(calls.filter(isMutation), [])
      await app!.close()
      app = undefined
    }
  })

  it('identity.5 (L1 re-pinned): an in-band sudo member is added to a share group (gpasswd -a); removing root from it is still 409; a stale unresolvable name is still removable', async () => {
    await serve()
    groups = [ROOT_GROUP, SUDO_ACCUSER, USERS, ACCGROUP]
    const sudoer = await send(members({ add: ['accuser'] }))
    assert.equal(sudoer.statusCode, 202, sudoer.body)
    const added = await finished((sudoer.json() as JobAccepted).job.id)
    assert.equal(added.status, 'completed', JSON.stringify(added.error))
    assert.deepEqual(calls.filter(isMutation).map(c => [c.command, ...c.args]), [[GPASSWD, '-a', 'accuser', 'accgroup']])
    calls = []

    groups = [ROOT_GROUP, SUDO, USERS, rewrite(ACCGROUP, 'accgroup:x:1005:', 'accgroup:x:1005:root,gone')]
    const root = await send(members({ remove: ['root'] }))
    assert.equal(root.statusCode, 409)
    assert.match(root.json().error.message, /^User 'root' \(uid 0\) is a system account\..* It cannot be removed from group 'accgroup' here\.$/)
    assert.deepEqual(calls.filter(isMutation), [])

    // `gone` resolves to no account: removing a stale member line stays allowed.
    const stale = await send(members({ remove: ['gone'] }))
    assert.equal(stale.statusCode, 202, stale.body)
    const job = await finished((stale.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isMutation).map(c => [c.command, ...c.args]), [[GPASSWD, '-d', 'gone', 'accgroup']])
  })

  it('identity.5 (L1 control re-pinned): a plain share user is still added (gpasswd -a); and the member becoming a @pam login while the edit waits refuses the job, no gpasswd', async () => {
    await serve()
    const res = await send(members({ add: ['accuser'] }))
    assert.equal(res.statusCode, 202, res.body)
    const done = await finished((res.json() as JobAccepted).job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.deepEqual(calls.filter(isMutation).map(c => [c.command, ...c.args]), [[GPASSWD, '-a', 'accuser', 'accgroup']])

    calls = []
    const { id, release } = await behindFullQueue(members({ add: ['accuser'] }))
    await writeFile(join(dir, 'user.cfg'), USER_CFG_ACCUSER)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'SYSTEM_ACCOUNT')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('L2 fails closed: a user.cfg that cannot be read (a directory where the file was) is a 503, nothing done', async () => {
    await serve()
    const cfg = join(dir, 'user.cfg')
    await rm(cfg)
    await mkdir(cfg)
    const res = await send(DISABLE_USER)
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().error.message, `ANAS could not read Proxmox VE's user list (${cfg}), so it cannot check that user 'accuser' is not a system account — nothing was done`)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- cr.58r (the review's four possibles, fixed) --------------------------

  it('cr.58r P1: a failing smbpasswd -d/-e fails the job BEFORE usermod — no half-done disable/enable', async () => {
    // The §2 no-partial-op ruling: the SMB step (the one that can fail on a
    // transient tdb lock) runs FIRST, so its failure leaves both halves
    // untouched. The old order ran usermod --expiredate first: a locked tdb
    // then left the unix account disabled with its SMB access live.
    for (const [req, smbArgv, usermodArgs] of [
      [DISABLE_USER, ['-d', 'accuser'], ['--expiredate', '1', 'accuser']],
      [ENABLE_USER, ['-e', 'accuser'], ['--expiredate', '', 'accuser']],
    ] as const) {
      await serve()
      const { id, release } = await behindFullQueue(req)
      smbpasswdFails = true
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed', `${req.method} ${req.url}`)
      assert.match(job.error?.message ?? '', /tdb locked/, 'the job names the failing step')
      assert.deepEqual(
        calls.filter(isMutation).map(c => [c.command, ...c.args]),
        [[SMBPASSWD, ...smbArgv]],
        `only smbpasswd ran — no usermod ${usermodArgs.join(' ')}`,
      )
      await app!.close()
      app = undefined
    }
  })

  it('cr.58r P1 (delete, the order that was already right): pdbedit -x before userdel — a failed drop runs no userdel', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DELETE_USER)
    pdbeditXFails = true
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', /tdb locked/)
    assert.deepEqual(
      calls.filter(isMutation).map(c => [c.command, ...c.args]),
      [[PDBEDIT, '-x', '-u', 'accuser']],
      'pdbedit -x ran and failed; userdel never ran',
    )
  })

  /**
   * The review's EXTRA1 shape: `getent group` ran and exited non-zero with a
   * PARTIAL listing — the sudo line cut off mid-members-list (`accuse`). A
   * fail-open read (the old `exitCode !== 0 && !stdout`) parses what was
   * printed; the strict read answers null and the gate refuses 503 naming
   * the database, like `passdbForGuard` does for a failed `pdbedit -L`.
   *
   * identity.5 moved what this pins: group membership is no longer a
   * system-account criterion, so the user verbs read no group listing at all
   * (disable, enable, delete and SMB password: the band, the account, the
   * passdb and user.cfg). The strict read remains where the listing still
   * decides something — a create's uid pick steps around every gid
   * (cr.29c) — and that is where P2 now refuses.
   */
  const GROUPS_CUT = `${ROOT_GROUP}\n${rewrite(SUDO, 'sudo:x:27:', 'sudo:x:27:accuse')}`

  /** A full `getent group` listing (with or without `-s files`) — not a by-name lookup. */
  const isGroupListing = (c: Call): boolean => c.command === GETENT && (c.args.join(' ') === 'group' || c.args.join(' ') === '-s files group')

  it('cr.58r P2 (identity.5 re-pinned): a getent group exiting non-zero with partial output is unreadable — a create 503s at its uid pick; the disable reads no group listing and runs', async () => {
    await serve()
    passwd = [ROOT]
    pdbedit = ''
    groupsPartial = GROUPS_CUT
    const create = await send(CREATE_ACCUSER)
    assert.equal(create.statusCode, 503, create.body)
    assert.equal(create.json().error.code, 'UNAVAILABLE')
    assert.equal(create.json().error.message, 'ANAS could not read the group database (getent group), so it cannot check which uid no group holds as its gid — nothing was done')
    assert.equal(queue.list().length, 0)
    assert.deepEqual(calls.filter(isMutation), [])
    await app!.close()
    app = undefined

    await serve()
    groupsPartial = GROUPS_CUT
    const job = await run(DISABLE_USER)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isGroupListing), [], 'no user verb reads the group listing')
  })

  it('cr.58r P2 (identity.5 re-pinned): the partial getent group appearing while the disable waits does not fail it — the job reads no group listing, usermod runs', async () => {
    await serve()
    const { id, release } = await behindFullQueue(DISABLE_USER)
    groupsPartial = GROUPS_CUT
    release()
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isGroupListing), [])
    assert.deepEqual(calls.filter(c => c.command === USERMOD).map(c => c.args), [['--expiredate', '1', 'accuser']])
  })

  it('cr.58r P3: a failed pdbedit -x of the orphan fails the create job BEFORE smbpasswd -a — no password written on the stale entry', async () => {
    await serve()
    passwd = [ROOT]
    pdbedit = ORPHAN_ACCUSER
    pdbeditXFails = true
    const res = await send({ ...CREATE_ACCUSER, body: { name: 'accuser', smbPassword: 'Acc-proof-1' } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(
      job.error?.message ?? '',
      /was created, but setting the SMB password failed: removing the orphan SMB entry stored as 'accuser' failed: tdb locked/,
    )
    const muts = calls.filter(isMutation).map(c => [c.command, ...c.args])
    assert.deepEqual(muts.map(m => m[0]), [USERADD, PDBEDIT], 'smbpasswd never ran on the stale entry')
    assert.deepEqual(muts[1], [PDBEDIT, '-x', '-u', 'accuser'])
  })

  it('cr.58r P4 (the review\'s EXTRA3): create refuses a name that is a @pam login in user.cfg with no unix account — 409 SYSTEM_ACCOUNT, no useradd', async () => {
    await serve({ userCfg: USER_CFG_ACCUSER })
    // The dormant shape: the login exists in user.cfg, the account does not.
    passwd = [ROOT]
    pdbedit = ''
    const res = await send(CREATE_ACCUSER)
    assert.equal(res.statusCode, 409, res.body)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'SYSTEM_ACCOUNT')
    assert.equal(error.message, `'accuser' is a Proxmox VE login ('accuser@pam' in ${join(dir, 'user.cfg')}) with no Unix account — a dormant PVE admin login. Creating the Unix account it maps to is PVE user management, outside ANAS. The user was NOT created.`)
    assert.equal(queue.list().length, 0)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('cr.58r P4: the @pam login appearing in user.cfg while the create waits fails the job SYSTEM_ACCOUNT, no useradd', async () => {
    await serve()
    passwd = [ROOT]
    pdbedit = ''
    const { id, release } = await behindFullQueue(CREATE_ACCUSER)
    await writeFile(join(dir, 'user.cfg'), USER_CFG_ACCUSER)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'SYSTEM_ACCOUNT')
    assert.match(job.error!.message, /^'accuser' is a Proxmox VE login \('accuser@pam'/)
    assert.deepEqual(calls.filter(isMutation), [])
  })
})
