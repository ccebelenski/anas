import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CreateSmbShareRequest } from '@anas/shared'
import { addShare, removeShare } from '../../parsers/smb-conf.js'
import { createServer } from '../../server.js'

/**
 * Story cr.43 — the SMB share verbs on the guard (docs/WAVE3-DESIGN.md §2.5,
 * §3, §4.2, ruling (j)). The H8 property: a state that refuses at the route
 * but becomes true only AFTER the request was accepted — while the job waits
 * in the queue — refuses the job, and the mock executor shows no mutating
 * argv (`systemctl reload smbd`) and smb.conf keeps its bytes.
 *
 * The job is held in the REAL queue: four placeholder jobs fill the four
 * slots, the request is accepted behind them (`queued`), the test changes the
 * file, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes serve captured output): `samba/smb.conf`; a
 * vanished stanza is the daemon's own `removeShare` of it, a hand edit one
 * token changed in a captured line.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const SYSTEMCTL = '/usr/bin/systemctl'
const TESTPARM = '/usr/bin/testparm'
const GETFACL = '/usr/bin/getfacl'
const STAT = '/usr/bin/stat'

const WRITERS = new Set(['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown', '/usr/bin/find'])

/** The paths the grant tests aim at: a create's target and `[backups]`'s own. */
const PHOTOS_DIR = '/tank/photos'
const BACKUPS_DIR = '/tank/backups'

/** The live ACL of the grant directories (acl/NOTES.md), before and after an entry lands. */
const ACL_NO_NAMED = fixture('acl/getfacl-pcE-dir-no-named.txt')
const ACL_NAMED_USER = fixture('acl/getfacl-pcE-dir-named-user.txt')

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const SMB = 'media'
const SMB_NOT_FOUND = `SMB share '${SMB}' not found`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const SMB_CONF = fixture('samba/smb.conf')
/** `[media]` as an operator hand-edited it (one token in the comment). */
const SMB_CONF_HAND_EDITED = rewrite(SMB_CONF, 'comment = Media library', 'comment = Media library (hand)')

/** A call that would mean an SMB verb acted on the node. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return c.command === SYSTEMCTL
}

/** A call that would mean the grant wrote a permission (cr.43 step 5). */
function isWrite(c: { command: string, args: string[] }): boolean {
  return WRITERS.has(c.command)
}

const ENV_KEYS = ['SMB_CONF_PATH', 'ANAS_FSTAB_PATH', 'ANAS_SYSTEMD_DIR', 'ANAS_STORAGE_CFG'] as const

describe('cr.43 — SMB share verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let paths: { smb: string, fstab: string, systemd: string }
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** The live ACL of the grant directories; a race test flips it. */
  let acl = ACL_NO_NAMED
  /** A command that does not return until the test releases it. */
  const paused = new Map<string, Promise<void>>()
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr43-smb-'))
    paths = { smb: join(dir, 'smb.conf'), fstab: join(dir, 'fstab'), systemd: join(dir, 'units') }
    for (const key of ENV_KEYS)
      saved[key] = process.env[key]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined)
        delete process.env[key]
      else
        process.env[key] = saved[key]
    }
  })

  /** The dev mock over a private copy of the capture; commands can pause. */
  async function serve(smbConf = SMB_CONF): Promise<void> {
    paused.clear()
    acl = ACL_NO_NAMED
    await writeFile(paths.smb, smbConf)
    await mkdir(paths.systemd, { recursive: true })
    process.env.SMB_CONF_PATH = paths.smb
    process.env.ANAS_FSTAB_PATH = paths.fstab
    process.env.ANAS_SYSTEMD_DIR = paths.systemd
    // Hermetic: a node without PVE storage (cr.32 review) — the grant's path
    // gates read storage.cfg, and the answer must never come from this host.
    process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      // cr.43 step 5: the grant directories answer with the live capture.
      if (command === GETFACL && args[0] === '-pcE' && (args[1] === PHOTOS_DIR || args[1] === BACKUPS_DIR))
        return ok(acl)
      if (command === STAT && (args[2] === PHOTOS_DIR || args[2] === BACKUPS_DIR))
        return ok('root root 755\n')
      const hold = paused.get(command)
      if (hold)
        await hold
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** Fill the four slots; the next accepted job waits `queued` until the release. */
  function holdSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown }

  function send(req: Req, code?: string) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS), ...(code ? { 'x-anas-confirm': code } : {}) },
      ...(req.payload === undefined ? {} : { payload: JSON.stringify(req.payload) }),
    })
  }

  /** Send; answer a 409 confirm challenge with its code; return the accepted job's id. */
  async function accepted(req: Req): Promise<string> {
    let res = await send(req)
    if (res.statusCode === 409 && res.headers['x-anas-confirm-code'])
      res = await send(req, res.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    return (res.json() as JobAccepted).job.id
  }

  /** Accept the request while the four slots are held: it waits `queued`. */
  async function acceptedBehindFullQueue(req: Req): Promise<{ id: string, release: () => void }> {
    const release = holdSlots()
    const id = await accepted(req)
    assert.equal(queue().get(id)?.status, 'queued', 'the accepted job waits behind the held slots')
    return { id, release }
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  /** Wait until a condition holds (a paused command has been reached). */
  async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (cond())
        return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`condition never became true: ${what}`)
  }

  const create = (body: Record<string, unknown>): Req => ({ method: 'POST', url: '/v1/shares/smb', payload: body })
  const update = (name: string, body: Record<string, unknown>): Req => ({ method: 'PUT', url: `/v1/shares/smb/${name}`, payload: body })
  const remove = (name: string): Req => ({ method: 'DELETE', url: `/v1/shares/smb/${name}` })

  // -------------------------------------------------------------------------
  // The harness acts when nothing changes
  // -------------------------------------------------------------------------

  it('control: with nothing changed the held edit and remove run and reload — the harness does not refuse on its own', async () => {
    for (const req of [update(SMB, { readOnly: true }), remove('backups')]) {
      await serve()
      const { id, release } = await acceptedBehindFullQueue(req)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'completed', `${req.method} ${req.url}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(isMutation), `${req.method} ${req.url} reloaded smbd`)
      await server!.close()
      server = undefined
    }
  })

  // -------------------------------------------------------------------------
  // Item 1: the vanished share — the update
  // -------------------------------------------------------------------------

  it('an edit whose stanza is removed while it waits fails NOT_FOUND — no reload, the file keeps the vanished bytes', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(update(SMB, { readOnly: true }))
    // An operator deletes the stanza (the daemon's own editor) while the job waits.
    const vanished = removeShare(await readFile(paths.smb, 'utf8'), SMB)
    await writeFile(paths.smb, vanished)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'NOT_FOUND', JSON.stringify(job.error))
    assert.equal(job.error?.message, SMB_NOT_FOUND)
    assert.deepEqual(calls.filter(isMutation), [], 'smbd never reloaded')
    assert.equal(await readFile(paths.smb, 'utf8'), vanished, 'smb.conf untouched by the refused job')
  })

  it('an edit whose stanza is hand-edited while it waits fails STATE_CHANGED — the hand edit survives, nothing written', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(update(SMB, { readOnly: true }))
    await writeFile(paths.smb, SMB_CONF_HAND_EDITED)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED', JSON.stringify(job.error))
    assert.equal(job.error?.message, `SMB share '${SMB}' changed since you confirmed — nothing was done; reload and confirm again`)
    assert.deepEqual(calls.filter(isMutation), [], 'smbd never reloaded')
    assert.equal(await readFile(paths.smb, 'utf8'), SMB_CONF_HAND_EDITED, 'the operator\'s edit is not overwritten by a merge of the old stanza')
  })

  // -------------------------------------------------------------------------
  // Item 1: the vanished share — the remove
  // -------------------------------------------------------------------------

  it('a remove whose stanza is deleted after the confirm fails NOT_FOUND — no reload, the file keeps the vanished bytes', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(remove(SMB))
    // The stanza goes after the confirm rode and while the job waits.
    const vanished = removeShare(await readFile(paths.smb, 'utf8'), SMB)
    await writeFile(paths.smb, vanished)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'NOT_FOUND', JSON.stringify(job.error))
    assert.equal(job.error?.message, SMB_NOT_FOUND)
    assert.deepEqual(calls.filter(isMutation), [], 'smbd never reloaded')
    assert.equal(await readFile(paths.smb, 'utf8'), vanished, 'smb.conf untouched by the refused job')
  })

  // -------------------------------------------------------------------------
  // Item 2: the duplicate — the create
  // -------------------------------------------------------------------------

  it('a create whose stanza is added while it waits fails CONFLICT — no reload, the hand stanza stands and no duplicate is written', async () => {
    await serve()
    const body = { name: 'photos', path: '/tank/photos' }
    const { id, release } = await acceptedBehindFullQueue(create(body))
    // Another writer composes [photos] onto the file (the daemon's own
    // composer) while the create's job waits.
    const handAdded = addShare(await readFile(paths.smb, 'utf8'), CreateSmbShareRequest.parse(body))
    await writeFile(paths.smb, handAdded)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
    assert.equal(job.error?.message, `SMB share 'photos' already exists`)
    assert.deepEqual(calls.filter(isMutation), [], 'smbd never reloaded')
    assert.equal(await readFile(paths.smb, 'utf8'), handAdded, 'smb.conf keeps the hand stanza as it was')
    assert.equal(handAdded.split('[photos]').length - 1, 1, 'the refused create added no second [photos]')
  })

  // -------------------------------------------------------------------------
  // Item 4: `share:smb:<section>`, exclusive, case-folded, for every verb
  // -------------------------------------------------------------------------

  it('every verb holds share:smb:<section> exclusive while it acts — the key case-folded, as Samba matches section names', async () => {
    const cases: Array<{ req: Req, key: string }> = [
      { req: create({ name: 'photos', path: '/tank/photos' }), key: 'share:smb:photos' },
      { req: update(SMB, { readOnly: true }), key: `share:smb:${SMB}` },
      // The route accepts 'Media'; Samba's match is case-insensitive, so the
      // key folds to the same `share:smb:media` the lowercase request takes.
      { req: update('Media', { readOnly: true }), key: `share:smb:${SMB}` },
      { req: remove(SMB), key: `share:smb:${SMB}` },
    ]
    for (const { req, key } of cases) {
      await serve()
      let release!: () => void
      paused.set(SYSTEMCTL, new Promise<void>((resolve) => {
        release = resolve
      }))
      const id = await accepted(req)
      await until(() => calls.some(isMutation), 'the reload call is reached')
      assert.deepEqual(queue().heldLocks(), [{ key, mode: 'exclusive', holders: [id] }], `${req.method} ${req.url}`)
      release()
      assert.equal((await finished(id)).status, 'completed', `${req.method} ${req.url}`)
      assert.deepEqual(queue().heldLocks(), [], 'released')
      await server!.close()
      server = undefined
    }
  })

  it('an add of the same share under another spelling waits for the first add\'s LOCK, then fails CONFLICT — one stanza is ever written', async () => {
    await serve()
    let releaseWrite!: () => void
    // Pause the first add INSIDE its write (the testparm validation of the
    // candidate): smb.conf still has no [photos], so the second add's route
    // gate passes — its job then contends on the same case-folded key.
    paused.set(TESTPARM, new Promise<void>((resolve) => {
      releaseWrite = resolve
    }))
    const firstId = await accepted(create({ name: 'photos', path: '/tank/photos' }))
    await until(() => calls.some(c => c.command === TESTPARM), 'the first add\'s write is reached')
    const secondId = await accepted(create({ name: 'Photos', path: '/tank/photos2' }))
    assert.equal(queue().get(secondId)?.status, 'queued')
    // The line names the share the WAITING request asked for ('Photos') —
    // same folded key, the operator's own spelling.
    assert.equal(queue().get(secondId)?.progress, `waiting for smb.share.add (job ${firstId}) on SMB share 'Photos'`)
    assert.equal(queue().list('running').length, 1, 'the waiting add holds none of the free slots')
    paused.clear()
    releaseWrite()
    assert.equal((await finished(firstId)).status, 'completed')
    // The job's re-run of the existence gate (case-folded, as the file is
    // read): the second add refuses CONFLICT and writes nothing.
    const second = await finished(secondId)
    assert.equal(second.status, 'failed')
    assert.equal(second.error?.code, 'CONFLICT', JSON.stringify(second.error))
    assert.equal(second.error?.message, `SMB share 'Photos' already exists`)
    const text = await readFile(paths.smb, 'utf8')
    assert.equal(text.split(/\[photos\]/i).length - 1, 1, 'exactly one [photos] stanza in smb.conf')
    assert.ok(!text.includes('/tank/photos2'), 'the refused add wrote no line of its own')
    assert.deepEqual(queue().heldLocks(), [])
  })

  // -------------------------------------------------------------------------
  // cr.43 step 5: the create/edit grant rides the revision-bound access spec
  // (cr.37) — an ACL that moves while the job waits fails STATE_CHANGED
  // before any setfacl, chown or chmod argv runs
  //
  // Guest grants (no valid users) so the composition needs no name
  // resolution: the entry the plan restates is Everyone. The live ACL is
  // `acl/getfacl-pcE-dir-no-named.txt` at the bind and
  // `acl/getfacl-pcE-dir-named-user.txt` once an entry landed — two real
  // captures of one directory before and after `setfacl -m u:nobody:r-x`.
  // -------------------------------------------------------------------------

  it('control: a held create with a guest grant runs the grant when nothing moved — the harness binds without refusing on its own', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(create({ name: 'photos', path: PHOTOS_DIR, guestOk: true, grantAccess: {} }))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const grant = (job.result as { grant?: { status: string, message?: string } }).grant
    assert.equal(grant?.status, 'applied', grant?.message)
    assert.ok(calls.some(isWrite), 'the grant wrote the folder permissions')
    assert.ok((await readFile(paths.smb, 'utf8')).includes('[photos]'), 'the share was created')
  })

  it('a create whose ACL gains an entry while it waits fails STATE_CHANGED — no write argv, no stanza, no reload', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(create({ name: 'photos', path: PHOTOS_DIR, guestOk: true, grantAccess: {} }))
    // Someone else's `setfacl -m u:nobody:r-x` lands while the job waits.
    acl = ACL_NAMED_USER
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED', JSON.stringify(job.error))
    assert.equal(job.error?.message, `Share path '${PHOTOS_DIR}' changed since you confirmed — nothing was done; reload and confirm again`)
    // The grant's plan restated an ACL that no longer matches — no setfacl,
    // chmod, chown or find argv ran, and the job door stopped the share too.
    assert.deepEqual(calls.filter(isWrite), [], 'no setfacl, chmod, chown or find ran')
    assert.deepEqual(calls.filter(isMutation), [], 'smbd never reloaded')
    assert.equal(await readFile(paths.smb, 'utf8'), SMB_CONF, 'no [photos] stanza was written')
  })

  it('an edit whose ACL gains an entry while it waits fails STATE_CHANGED — the stanza keeps its bytes, nothing written', async () => {
    await serve()
    // `[backups]` has no valid users, so the guest toggle composes a grant,
    // and the guest change is what makes the edit run it (editRunsGrant).
    const { id, release } = await acceptedBehindFullQueue(update('backups', { guestOk: true, grantAccess: {} }))
    acl = ACL_NAMED_USER
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED', JSON.stringify(job.error))
    assert.equal(job.error?.message, `Share path '${BACKUPS_DIR}' changed since you confirmed — nothing was done; reload and confirm again`)
    assert.deepEqual(calls.filter(isWrite), [], 'no setfacl, chmod, chown or find ran')
    assert.deepEqual(calls.filter(isMutation), [], 'smbd never reloaded')
    assert.equal(await readFile(paths.smb, 'utf8'), SMB_CONF, 'the [backups] stanza keeps its bytes — no guest line either')
  })

  it('recursive: the grant confirm signs the composed grant — a resent edit of the entries is CONFIRM_SCOPE_CHANGED naming them', async () => {
    await serve()
    const body = { name: 'photos', path: PHOTOS_DIR, guestOk: true, grantAccess: { applyToExisting: true } }
    const first = await send(create(body))
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.equal(first.json().error.message, `Applying to existing files rewrites the permissions of every file and directory under '${PHOTOS_DIR}'`)
    assert.ok(first.headers['x-anas-confirm-code'], 'the 409 carries X-Anas-Confirm-Code')
    assert.deepEqual(calls.filter(isWrite), [], 'nothing behind the challenge')
    // The same door, a DIFFERENT composed grant: a read-only share asks
    // Everyone read, not Everyone read-write. The signature covers the
    // composed entries, so the old code never rides it.
    const res = await send(create({ ...body, readOnly: true }), first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['entries'])
    assert.deepEqual(calls.filter(isWrite), [], 'nothing was written for the scope-changed resend')
    assert.equal(await readFile(paths.smb, 'utf8'), SMB_CONF, 'no share was created behind the refused confirm')
  })
})
