import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { zfsSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { TARGETCLI, ZFS, zvolExistsArgs } from '../../services/iscsi-mutate.js'

/**
 * Story cr.40 — the iSCSI verbs on the guard (docs/WAVE3-DESIGN.md §2.4, §8.2).
 * The H8 property, one race per "Missing" cell of the iSCSI rows: a fact that
 * would refuse (or change) the verb at the route, but only becomes true AFTER
 * the request was accepted — while the job waits in the queue — refuses the
 * job, and the executor shows no `targetcli` (and no `zfs destroy`).
 *
 * The job is held in the REAL queue, the pools-guard way: four placeholder
 * jobs fill the four slots, the accepted request is submitted behind them
 * (`queued`), the test changes the node's LIO tree, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). Every LIO state is the
 * captured tree `iscsi/configfs-live.manifest` (one target, 2 LUNs, 2 ACLs, one
 * portal, CHAP on, no session) or `iscsi/configfs-restore-empty.manifest` (the
 * same target with no LUNs), with these rewrites spelled out at the call site:
 *  - the target's IQN `iqn.2026-08.dev.anas.gtiscsi:target1` becomes
 *    `iqn.2026-08.dev.gtiscsi.anas:target1` — the same labels with `anas`
 *    last, ANAS's naming convention, so the captured target is ANAS-owned
 *    (`isAnasIqn`); every other byte is the capture's;
 *  - "an initiator logs in": the debian initiator's ACL `info` file becomes
 *    the captured logged-in text `iscsi/configfs-acl-info-loggedin.txt` (the
 *    same initiator, a connection on the target's one portal address);
 *  - "an ACL is added/removed": the `allowed2` (or debian) ACL subtree is
 *    deleted from the capture;
 *  - "the target is disabled": its `tpgt_1/enable` reads 0 instead of 1;
 *  - the zvol's snapshots: `zfs/zfs-snapshots-media.json` with the dataset
 *    `testpool/media` renamed to the LUN's `gtiscsi/vol1`; "no snapshots" is
 *    the same capture with its `datasets` map emptied.
 * The persisted half (`saveconfig.json`) is absent, as in pools-guard: the
 * target is the live tree alone, so a flip is exactly what the tree shows.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const CAPTURED_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const IQN = 'iqn.2026-08.dev.gtiscsi.anas:target1'
const DEBIAN = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
const ALLOWED2 = 'iqn.2026-08.dev.anas.gtiscsi:allowed2'
const ZVOL_PATH = '/dev/zvol/gtiscsi/vol1'
const ZVOL_DATASET = 'gtiscsi/vol1'
/** The captured LUN 0's unit serial. */
const LUN0_SERIAL = '9bc6e907-6015-4267-be4f-5a0617cb3d71'

/** The capture with the target's IQN made ANAS's (every occurrence). */
function owned(manifest: string): string {
  assert.ok(manifest.includes(CAPTURED_IQN))
  return manifest.split(CAPTURED_IQN).join(IQN)
}

const LIVE = owned(fixture('iscsi/configfs-live.manifest'))
const EMPTY = owned(fixture('iscsi/configfs-restore-empty.manifest'))

/** The captured logged-in `info`, newline-escaped the way the manifest stores values. */
const LOGGED_IN_INFO = fixture('iscsi/configfs-acl-info-loggedin.txt').trim().split('\\').join('\\\\').split('\n').join('\\n')

/** The debian initiator logs in. */
function loggedIn(manifest: string): string {
  return rewrite(
    manifest,
    `/acls/${DEBIAN}/info = No active iSCSI Session for Initiator Endpoint: ${DEBIAN}`,
    `/acls/${DEBIAN}/info = ${LOGGED_IN_INFO}`,
  )
}

/** The capture without one initiator's ACL subtree. */
function withoutAcl(manifest: string, initiator: string): string {
  const lines = manifest.split('\n')
  const kept = lines.filter(l => !l.includes(`/tpgt_1/acls/${initiator}`))
  assert.ok(kept.length < lines.length, `no ACL ${initiator} in the capture`)
  return kept.join('\n')
}

/** The target's TPG disabled. */
function disabled(manifest: string): string {
  return rewrite(manifest, '/tpgt_1/enable = 1', '/tpgt_1/enable = 0')
}

/** The target's TPG CHAP off. */
function noAuth(manifest: string): string {
  return rewrite(manifest, '/tpgt_1/attrib/authentication = 1', '/tpgt_1/attrib/authentication = 0')
}

/**
 * The capture with a second portal's `np` subtree added, spelled out exactly as
 * the captured `np/192.168.200.50:3260` (a directory plus its two value files).
 * Appended: the materializer treats the manifest as a set of nodes, not an order.
 */
function withPortal(manifest: string, address: string, port: number): string {
  const np = `iscsi/${IQN}/tpgt_1/np/${address}:${port}`
  return `${manifest}\nD ${np}\nF ${np}/cxgbit = 0\nF ${np}/iser = 0\n`
}

/** The capture without one `np` portal subtree. */
function withoutPortal(manifest: string, address: string, port: number): string {
  const lines = manifest.split('\n')
  const kept = lines.filter(l => !l.includes(`tpgt_1/np/${address}:${port}`))
  assert.ok(kept.length < lines.length, `no portal ${address}:${port} in the capture`)
  return kept.join('\n')
}

const SNAPSHOTS_CAPTURE = fixture('zfs/zfs-snapshots-media.json')
const ZVOL_SNAPSHOTS = SNAPSHOTS_CAPTURE.split('testpool/media').join(ZVOL_DATASET)
const NO_SNAPSHOTS = JSON.stringify({ ...JSON.parse(SNAPSHOTS_CAPTURE), datasets: {} })

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** A call that would mean a verb acted on LIO or on a backing. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return c.command === TARGETCLI || (c.command === ZFS && c.args[0] === 'destroy')
}

const targetUrl = `/v1/iscsi/targets/${encodeURIComponent(IQN)}`

describe('cr.40 — the iSCSI verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let configfs: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** `zfs list -t snapshot` of the zvol, as the node answers it now. */
  let snapshots = NO_SNAPSHOTS
  /** When set, every targetcli call waits for it (a job held mid-sequence). */
  let targetcliHold: Promise<void> | null = null
  /** When set, a targetcli whose joined argv starts with an entry fails with its stderr (injected, only echoed — never parsed). */
  let failTargetcli: { argv: string, stderr: string }[] = []

  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_STORAGE_CFG', 'ANAS_ISCSI_INITIATOR_NAME', 'ANAS_ISCSI_DEVICE_STAT']

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr40-race-'))
    configfs = join(dir, 'target')
    for (const k of ENV_KEYS)
      savedEnv[k] = process.env[k]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined)
        delete process.env[k]
      else
        process.env[k] = savedEnv[k]
    }
  })

  /** Point LIO at `manifest` (re-materialised: a flip is a whole new tree). */
  async function lio(manifest: string): Promise<void> {
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(manifest, configfs)
  }

  /** The dev mock over `manifest`; targetcli succeeds, the zvol's snapshot list is flippable. */
  async function serve(manifest: string): Promise<void> {
    snapshots = NO_SNAPSHOTS
    await lio(manifest)
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_ISCSI_INITIATOR_NAME = join(dir, 'absent-initiatorname.iscsi')
    // ident.2: the zvol's path IS the device the capture's LUN 0 serves (configfs says Major 230 Minor 16).
    process.env.ANAS_ISCSI_DEVICE_STAT = `${ZVOL_PATH}=230:16`
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    targetcliHold = null
    failTargetcli = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === TARGETCLI) {
        if (targetcliHold)
          await targetcliHold
        const fail = failTargetcli.find(f => args.join(' ').startsWith(f.argv))
        if (fail)
          return { stdout: '', stderr: fail.stderr, exitCode: 1 }
        return ok('')
      }
      // cr.64c item 8 / cr.64cr: the LUN add proves the zvol exists (`zvolExistsArgs`) before its
      // first targetcli act — every volume these tests add lives on the fixture pool, so the
      // pool's volumes all exist.
      if (command === ZFS && args.slice(0, -1).join(' ') === zvolExistsArgs('').slice(0, -1).join(' ') && args.at(-1)?.startsWith('gtiscsi/'))
        return { stdout: `${args.at(-1)}\n`, stderr: '', exitCode: 0 }
      if (command === ZFS && args.join(' ') === zfsSnapshotListArgs(ZVOL_DATASET).join(' '))
        return ok(snapshots)
      if (command === ZFS && args[0] === 'destroy')
        return ok('')
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown }

  function inject(req: Req, headers: Record<string, string> = {}) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.payload !== undefined ? JSON_HEADERS : IDENTITY_HEADERS), ...headers },
      ...(req.payload !== undefined ? { payload: JSON.stringify(req.payload) } : {}),
    })
  }

  /** Fill the four slots; returns their release. */
  function holdSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  /**
   * Send `req` (with its confirm when it is challenged) while all four slots
   * are held: the accepted job sits `queued`. Returns its id and the release.
   */
  async function acceptBehindFullQueue(req: Req): Promise<{ id: string, release: () => void }> {
    const release = holdSlots()
    let res = await inject(req)
    if (res.statusCode === 409 && res.headers['x-anas-confirm-code'])
      res = await inject(req, { 'x-anas-confirm': res.headers['x-anas-confirm-code'] as string })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
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

  /** Accept `req` at `before`, flip LIO to `after` while it waits, release, return the job. */
  async function race(req: Req, before: string, after: string): Promise<Job> {
    await serve(before)
    const { id, release } = await acceptBehindFullQueue(req)
    await lio(after)
    release()
    return finished(id)
  }

  // --- target update (§2.4: revision, sessions) ------------------------------

  /** Keep the debian ACL and drop CHAP; removes allowed2 from the full capture. */
  const UPDATE_KEEP_DEBIAN: Req = { method: 'PUT', url: targetUrl, payload: { auth: 'none', acls: [{ initiatorIqn: DEBIAN }] } }
  /** Keep allowed2 and drop CHAP; removes the debian ACL. */
  const UPDATE_KEEP_ALLOWED2: Req = { method: 'PUT', url: targetUrl, payload: { auth: 'none', acls: [{ initiatorIqn: ALLOWED2 }] } }

  it('control: with nothing changed the held update runs and diffs the target it was computed from', async () => {
    const job = await race(UPDATE_KEEP_DEBIAN, LIVE, LIVE)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isMutation).map(c => c.args.join(' ')), [
      `/iscsi/${IQN}/tpg1 set attribute authentication=0`,
      `/iscsi/${IQN}/tpg1/acls delete ${ALLOWED2}`,
      'saveconfig',
    ])
  })

  it('update: an ACL another operator ADDS while the job waits fails it STATE_CHANGED — the job never deletes what it did not see', async () => {
    const job = await race(UPDATE_KEEP_DEBIAN, withoutAcl(LIVE, ALLOWED2), LIVE)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, new RegExp(`^iSCSI target '${IQN.replace(/[.:]/g, '\\$&')}' changed since you confirmed`))
    assert.deepEqual(calls.filter(isMutation), [], 'no targetcli at all — allowed2 is still there')
  })

  it('update: an ACL the edit removes that someone else ALREADY removed fails it STATE_CHANGED before any targetcli (no half-run sequence)', async () => {
    const job = await race(UPDATE_KEEP_ALLOWED2, LIVE, withoutAcl(LIVE, DEBIAN))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('update: an initiator that logs in on an ACL the edit removes fails it STATE_CHANGED, naming the session nobody agreed to drop', async () => {
    const job = await race(UPDATE_KEEP_ALLOWED2, LIVE, loggedIn(LIVE))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    // D7: a multi-key scope keeps its labels, with the sides named `was:`/`now:`.
    assert.ok(job.error!.message.includes(`(was: live sessions this edit drops: none; live connections on portals this edit removes: none; now: live sessions this edit drops: ${DEBIAN}`), job.error!.message)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- revision dimensions C1/C2 (cr.40r): portals and auth -----------------

  it('revision: a portal ADDED to the tree while the job waits fails it STATE_CHANGED — no targetcli', async () => {
    const job = await race(UPDATE_KEEP_DEBIAN, LIVE, withPortal(LIVE, '10.99.99.1', 3260))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('revision: a portal REMOVED from the tree while the job waits fails it STATE_CHANGED — no targetcli', async () => {
    const job = await race(UPDATE_KEEP_DEBIAN, LIVE, withoutPortal(LIVE, '192.168.200.50', 3260))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('revision: CHAP toggled OFF in the tree while the job waits fails it STATE_CHANGED — no targetcli', async () => {
    const job = await race(UPDATE_KEEP_DEBIAN, LIVE, noAuth(LIVE))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // cr.66r (3) — the ruling (§2 Safety altitudes): a confirm signs the NAMES
  // of every field it writes, never a secret value. cr.40 signed the CHAP
  // area as a single `credentials` BOOLEAN and then dropped that boolean as
  // presentation-only, so a replay that swapped credentials rode the old
  // code unsigned and unchallenged. The signature now carries `credentialFields`:
  // per ACL, in canonical initiator order, the sorted NAMES of the credential
  // fields the edit writes — NAMES re-challenge on a field added or removed,
  // VALUES stay unsigned (a rotation with the same fields is the same
  // request), and no 409 sentence or store entry ever carries a secret.
  it('update: the confirm binds the edit — a resend with another ACL set is 409 CONFIRM_SCOPE_CHANGED naming it, credentials ride by NAME, no secret in the 409 (cr.66r)', async () => {
    await serve(loggedIn(LIVE))
    // Removing the logged-in ACL is the challenged edit.
    const first = await inject(UPDATE_KEEP_ALLOWED2)
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    // The mint wrote NO credential field; a replay that SETS a secret on the
    // same ACL set changes the signed names — it re-challenges, naming
    // credentialFields and printing names only. (Pre-cr.66r this answerd 202:
    // the credential field set was not signed at all.)
    const other: Req = { method: 'PUT', url: targetUrl, payload: { auth: 'none', acls: [{ initiatorIqn: ALLOWED2, chapUserid: 'operator', chapSecret: 'sekrit-pass12' }] } }
    const res = await inject(other, { 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string })
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['credentialFields'])
    assert.match(res.json().error.message, /credentialFields \{"iqn\.2026-08\.dev\.anas\.gtiscsi:allowed2":\[\]\}; this request has credentialFields \{"iqn\.2026-08\.dev\.anas\.gtiscsi:allowed2":\["chapSecret","chapUserid"\]\} — confirm again/, res.json().error.message)
    assert.equal(res.body.includes('sekrit-pass12'), false, res.body)

    // A different secret VALUE on the same ACL and the same fields is the
    // same request (the names match): a fresh code, then the rotation passes.
    const code2 = (await inject(other)).headers['x-anas-confirm-code'] as string
    assert.ok(code2)
    const rotated: Req = { method: 'PUT', url: targetUrl, payload: { auth: 'none', acls: [{ initiatorIqn: ALLOWED2, chapUserid: 'operator', chapSecret: 'sekrit-rotated-9' }] } }
    const pass = await inject(rotated, { 'x-anas-confirm': code2 })
    assert.equal(pass.statusCode, 202, pass.body)

    // A resend that also adds a portal (and carries a secret) is another
    // edit — minted from the SAME credential-bearing request, so only the
    // portal names differ (cr.66r: credentialFields is signed too, and here
    // it matches).
    const again = await inject(other)
    const widened: Req = {
      method: 'PUT',
      url: targetUrl,
      payload: {
        auth: 'none',
        acls: [{ initiatorIqn: ALLOWED2, chapUserid: 'operator', chapSecret: 'sekrit-pass12' }],
        portals: [{ address: '192.168.200.50', port: 3260 }, { address: '10.99.99.1', port: 3260 }],
      },
    }
    const scope = await inject(widened, { 'x-anas-confirm': again.headers['x-anas-confirm-code'] as string })
    assert.equal(scope.statusCode, 409)
    assert.equal(scope.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(scope.json().error.changed, ['portals'])
    assert.equal(scope.json().error.message, 'You confirmed with portals "unchanged"; this request has portals "10.99.99.1:3260, 192.168.200.50:3260" — confirm again')
    for (const body of [first.body, res.body, pass.body, again.body, scope.body])
      assert.equal(body.includes('sekrit'), false, body)
    assert.ok(scope.headers['x-anas-confirm-code'])
  })

  // --- target enable / disable (§2.4: Cap target) ---------------------------

  it('state: a disable the operator already made while the job waited fails it STATE_CHANGED — no targetcli', async () => {
    const job = await race({ method: 'POST', url: `${targetUrl}/state`, payload: { action: 'disable' } }, LIVE, disabled(LIVE))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('state: control — the held disable runs on the fresh target', async () => {
    const job = await race({ method: 'POST', url: `${targetUrl}/state`, payload: { action: 'disable' } }, LIVE, LIVE)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isMutation).map(c => c.args.join(' ')), [`/iscsi/${IQN}/tpg1 disable`, 'saveconfig'])
  })

  // --- target delete (§2.4: sessions, LUN count) ----------------------------

  const DELETE_TARGET: Req = { method: 'DELETE', url: targetUrl }

  it('delete: control — the empty, session-free target is deleted', async () => {
    const job = await race(DELETE_TARGET, EMPTY, EMPTY)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isMutation).map(c => c.args.join(' ')), [`/iscsi delete ${IQN}`, 'saveconfig'])
  })

  it('delete: an initiator that logs in while the delete waits refuses it with the route\'s own 409 sentence — nothing deleted', async () => {
    const job = await race(DELETE_TARGET, EMPTY, loggedIn(EMPTY))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /has 1 live session \(iqn\.1993-08\.org\.debian:01:ae3d2ec18ad\)\. Deleting it drops it/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('delete: LUNs mapped while the delete waits refuse it — nothing deleted', async () => {
    const job = await race(DELETE_TARGET, EMPTY, LIVE)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- LUN add (§2.4: index and ACL grants from the RT target, audit #34; backing) ---

  /** `configfs-restore-hole.manifest`: the same target with LUN 0 (gtiscsi_vol1) gone, LUN 1 kept. */
  const HOLE = owned(fixture('iscsi/configfs-restore-hole.manifest'))
  const addLun = (name: string, backing: string): Req => ({ method: 'POST', url: `${targetUrl}/luns`, payload: { name, kind: 'zvol', backing } })

  it('LUN add: a LUN and an ACL added while the job waited — it maps at the next FREE index of the target as it is NOW and grants BOTH ACLs', async () => {
    // At the request: LUN 1 only (index 0 free), one ACL. When the job runs:
    // LUNs 0 and 1, two ACLs.
    const job = await race(addLun('newlun', 'gtiscsi/vol9'), withoutAcl(HOLE, ALLOWED2), LIVE)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const argv = calls.filter(isMutation).map(c => c.args.join(' '))
    assert.ok(argv.includes(`/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newlun lun=2`), argv.join('\n'))
    assert.ok(argv.includes(`/iscsi/${IQN}/tpg1/acls/${DEBIAN} create 2 2`), argv.join('\n'))
    assert.ok(argv.includes(`/iscsi/${IQN}/tpg1/acls/${ALLOWED2} create 2 2`), argv.join('\n'))
    assert.equal((job.result as { index: number }).index, 2)
  })

  it('LUN add: the zvol exported by another LUN while the job waited refuses it — no targetcli', async () => {
    const job = await race(addLun('newlun', ZVOL_DATASET), HOLE, LIVE)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /\/dev\/zvol\/gtiscsi\/vol1 is already exported as a LUN on this node/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('LUN add: the name taken by a backstore created while the job waited refuses it — no targetcli', async () => {
    const job = await race(addLun('gtiscsi_vol1', 'gtiscsi/vol9'), HOLE, LIVE)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /A LUN named 'gtiscsi_vol1' already exists on this node/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- LUN add: a mid-sequence targetcli failure (cr.40r DEFECT-1) ----------

  it('LUN add: the map targetcli fails after the backstore exists — the job deletes the half-created backstore it made, never saves, and fails with the original error', async () => {
    await serve(HOLE)
    const { id, release } = await acceptBehindFullQueue(addLun('newlun', 'gtiscsi/vol9'))
    // The probe (cr.40r): the map dies after the backstore create, so the
    // backstore exists, no LUN is mapped, and only ANAS knows it was made.
    // The stderr is injected (echoed into the job error, never parsed).
    failTargetcli = [
      { argv: `/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newlun`, stderr: 'fabric: mapping newlun at lun 0 failed' },
    ]
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.ok(job.error!.message.includes('fabric: mapping newlun at lun 0 failed'), job.error!.message)
    const argv = calls.filter(isMutation).map(c => c.args.join(' '))
    assert.ok(argv.includes(`/backstores/block/newlun delete`), `no backstore-delete argv:\n${argv.join('\n')}`)
    assert.ok(argv.some(a => a.startsWith(`/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newlun`)), argv.join('\n'))
    assert.ok(!argv.includes('saveconfig'), `a half-created LUN must never be persisted:\n${argv.join('\n')}`)
  })

  it('LUN add: the backstore CREATE itself fails — nothing existed, so the cleanup finds no object and deletes nothing, and the job error is the create\'s alone', async () => {
    await serve(HOLE)
    const { id, release } = await acceptBehindFullQueue(addLun('newlun', 'gtiscsi/vol9'))
    // The flag is set BEFORE the create-and-map call (the restore's pattern),
    // so the cleanup's delete still RUNS for a create failure — and proves it
    // deletes nothing by finding no object: the injected "No such object" the
    // delete returns is swallowed by the tolerance, the job error stays the
    // create's, and nothing is mapped or persisted.
    failTargetcli = [
      { argv: '/backstores/block create name=newlun', stderr: 'backport_create_simple: offlining non-existing object' },
      { argv: '/backstores/block/newlun delete', stderr: 'No such object: /backstores/block/newlun' },
    ]
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.ok(job.error!.message.includes('backport_create_simple: offlining non-existing object'), job.error!.message)
    assert.ok(!job.error!.message.includes('could not be deleted'), `the tolerance for a never-created backstore must swallow the no-such-object delete:\n${job.error!.message}`)
    const argv = calls.filter(isMutation).map(c => c.args.join(' '))
    const deleteRan = argv.filter(a => a.startsWith('/backstores/block/newlun delete'))
    assert.equal(deleteRan.length, 1, `the cleanup must still try — and find nothing:\n${argv.join('\n')}`)
    assert.ok(!argv.some(a => a.startsWith(`/iscsi/${IQN}/tpg1/luns create`)), `nothing may be mapped:\n${argv.join('\n')}`)
    assert.ok(!argv.includes('saveconfig'), `a half-created LUN must never be persisted:\n${argv.join('\n')}`)
  })

  // --- LUN update (§2.4: sessions) -------------------------------------------

  const WRITE_CACHE_OFF: Req = { method: 'PUT', url: `${targetUrl}/luns/0`, payload: { writeBack: false } }

  it('LUN update: control — a write-cache change with no session runs', async () => {
    const job = await race(WRITE_CACHE_OFF, LIVE, LIVE)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(calls.some(c => c.command === TARGETCLI && c.args.join(' ').includes('emulate_write_cache=0')))
  })

  it('LUN update: an initiator that logs in while the job waits refuses a write-cache change (reverifyServedLun compares sessions) — no targetcli', async () => {
    const job = await race(WRITE_CACHE_OFF, LIVE, loggedIn(LIVE))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /LUN 0 of '.+' has 1 live session \(iqn\.1993-08\.org\.debian:01:ae3d2ec18ad\) now/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- LUN delete (§2.4: sessions, snapshot check; destroyBacking bound) ----

  const DELETE_LUN: Req = { method: 'DELETE', url: `${targetUrl}/luns/0` }
  const DELETE_LUN_AND_ZVOL: Req = { method: 'DELETE', url: `${targetUrl}/luns/0?destroyBacking=true` }

  it('LUN delete: control — a confirmed destroyBacking with nothing changed unmaps, deletes the backstore, destroys the zvol, saves', async () => {
    const job = await race(DELETE_LUN_AND_ZVOL, LIVE, LIVE)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(calls.filter(isMutation).map(c => `${c.command} ${c.args.join(' ')}`), [
      `${TARGETCLI} /iscsi/${IQN}/tpg1/luns delete lun0`,
      `${TARGETCLI} /backstores/block delete gtiscsi_vol1`,
      `${ZFS} destroy -- ${ZVOL_DATASET}`,
      `${TARGETCLI} saveconfig`,
    ])
  })

  it('LUN delete: a session that logs in between the confirm and the job refuses the delete — the route\'s sentence, nothing unmapped', async () => {
    const job = await race(DELETE_LUN, LIVE, loggedIn(LIVE))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^LUN 0 of '.+' has 1 live session \(iqn\.1993-08\.org\.debian:01:ae3d2ec18ad\)\. LIO would delete it anyway/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('LUN delete: a snapshot of the zvol taken between the confirm and the job refuses destroyBacking, naming it — nothing unmapped, no zfs destroy', async () => {
    await serve(LIVE)
    const { id, release } = await acceptBehindFullQueue(DELETE_LUN_AND_ZVOL)
    snapshots = ZVOL_SNAPSHOTS
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^The volume gtiscsi\/vol1 has 2 snapshots \(gtiscsi\/vol1@snap1, gtiscsi\/vol1@snap2\)/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('LUN delete: the job holds the target\'s key and the LUN\'s serial key, exclusive, while it runs — and its backing\'s key (cr.63)', async () => {
    await serve(LIVE)
    const go = pauseTargetcli()
    const first = await inject(DELETE_LUN)
    const res = await inject(DELETE_LUN, { 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === TARGETCLI))
    assert.deepEqual(queue().heldLocks(), [
      { key: `iscsi-target:${IQN}`, mode: 'exclusive', holders: [id] },
      { key: `iscsi-lun:${LUN0_SERIAL}`, mode: 'exclusive', holders: [id] },
      // cr.63 (review L17): the zvol's keys. This harness answers no `zpool
      // get guid` for gtiscsi, so the volume's pool is locked by its name key
      // alone, exclusive — §4.2's guid fallback (cr.33b), the dataset verbs'
      // own rule. The guid-keyed set is pinned in iscsi-backing-locks.test.ts.
      { key: 'zname:gtiscsi', mode: 'exclusive', holders: [id] },
    ])
    go()
    assert.equal((await finished(id)).status, 'completed')
    assert.deepEqual(queue().heldLocks(), [])
  })

  it('LUN delete: no code ⇒ 409 with a code for every form of destroyBacking that parses (the re-challenge precondition); the others are 400 — nothing runs, no job', async () => {
    await serve(LIVE)
    for (const qs of ['', '?destroyBacking=false', '?destroyBacking=0', '?destroyBacking=true', '?destroyBacking=1']) {
      const res = await inject({ method: 'DELETE', url: `${targetUrl}/luns/0${qs}` })
      assert.equal(res.statusCode, 409, `${qs}: ${res.body}`)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED', qs)
      assert.ok(res.headers['x-anas-confirm-code'], qs)
    }
    for (const qs of ['?destroyBacking=TRUE', '?destroyBacking=yes', '?destroyBacking=', '?destroyBacking=true&destroyBacking=false']) {
      const res = await inject({ method: 'DELETE', url: `${targetUrl}/luns/0${qs}` })
      assert.equal(res.statusCode, 400, `${qs}: ${res.body}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.filter(isMutation), [])
    assert.deepEqual(queue().list().filter(j => j.operation === 'iscsi.lun.delete'), [])
  })

  it('LUN delete: absent and an explicit false sign the same — a code minted for one confirms the other', async () => {
    await serve(LIVE)
    const first = await inject(DELETE_LUN)
    const res = await inject({ method: 'DELETE', url: `${targetUrl}/luns/0?destroyBacking=false` }, { 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string })
    assert.equal(res.statusCode, 202, res.body)
  })

  /** Hold every targetcli call until the returned release. */
  function pauseTargetcli(): () => void {
    let release!: () => void
    targetcliHold = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
  }

  it('locks: a target create holds the key of the IQN it creates while it runs', async () => {
    await serve(LIVE)
    const go = pauseTargetcli()
    const res = await inject({ method: 'POST', url: '/v1/iscsi/targets', payload: { name: 'newtarget', portals: [{ address: '192.168.200.50', port: 3261 }], acls: [{ initiatorIqn: DEBIAN }] } })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === TARGETCLI))
    const held = queue().heldLocks()
    assert.equal(held.length, 1)
    assert.match(held[0].key, /^iscsi-target:iqn\.\d{4}-\d{2}\..+\.anas:newtarget$/)
    assert.deepEqual([held[0].mode, held[0].holders], ['exclusive', [id]])
    go()
    assert.equal((await finished(id)).status, 'completed')
    assert.deepEqual(queue().heldLocks(), [])
  })

  it('locks: a target verb holds the target\'s key, exclusive, while it runs — a second verb on it waits for the LOCK, not a slot, then re-gates', async () => {
    await serve(LIVE)
    const go = pauseTargetcli()
    const res = await inject({ method: 'POST', url: `${targetUrl}/state`, payload: { action: 'disable' } })
    assert.equal(res.statusCode, 202, res.body)
    const first = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === TARGETCLI))
    assert.deepEqual(queue().heldLocks(), [{ key: `iscsi-target:${IQN}`, mode: 'exclusive', holders: [first] }])

    // The update's route door passes (nothing changed yet); its job waits.
    const second = await inject(UPDATE_KEEP_DEBIAN)
    assert.equal(second.statusCode, 202, second.body)
    const waiting = (second.json() as JobAccepted).job.id
    assert.equal(queue().get(waiting)?.status, 'queued')
    assert.equal(queue().get(waiting)?.progress, `waiting for iscsi.target.disable (job ${first}) on iSCSI target ${IQN}`)
    assert.equal(queue().list('running').length, 1, 'the waiting update holds none of the free slots')

    // The disable lands (the tree now reads disabled) and lets go: the update
    // re-reads, finds the revision it was computed from gone, and refuses.
    await lio(disabled(LIVE))
    go()
    assert.equal((await finished(first)).status, 'completed')
    const updated = await finished(waiting)
    assert.equal(updated.status, 'failed')
    assert.equal(updated.error?.code, 'STATE_CHANGED')
    assert.deepEqual(queue().heldLocks(), [])
  })
})
