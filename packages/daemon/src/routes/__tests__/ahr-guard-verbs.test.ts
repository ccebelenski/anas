import type { AhrExpansionIntent, Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { ahrPoolClaims } from '../../safety/guard.js'
import { createServer } from '../../server.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS } from '../../services/ahr-topology.js'
import {
  AHR_CREATE_PRESENTATION_ONLY,
  AHR_DESTROY_PRESENTATION_ONLY,
  AHR_MOUNTPOINT_PRESENTATION_ONLY,
  AHR_REMOUNT_PRESENTATION_ONLY,
} from '../ahr-mutate.js'

/**
 * Story cr.38 session A — the SHORT AHR verbs on the guard (WAVE3-DESIGN §2.3,
 * §8.2). The H8 property per "Missing" cell: a gate that would refuse at the
 * route but only becomes true AFTER the operator confirmed — while the job
 * waits in the queue — refuses the job, and the mock executor shows no
 * mutating argv.
 *
 * The job is held in the REAL queue (the cr.32 pattern, pools-guard.test.ts):
 * four placeholder jobs fill the four slots, the confirmed request is
 * submitted behind them (`queued`), the test changes the node's state, then
 * releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). The pool is the dev
 * mock's `ahr0` (fixtures/ahr, the stage-0 captures). Each state flip serves a
 * capture, with the one rewrite it needs spelled out at the call site:
 *  - LIO: `iscsi/configfs-restore-empty.manifest` (a target, no LUNs) at the
 *    confirm; `iscsi/configfs-live.manifest` with its fileio LUN's image
 *    re-pointed from `/gtiscsi/images/lun2.raw` onto the pool's mountpoint
 *    when the job runs.
 *  - the mount table: `ahr/findmnt-ahr0.json` at the confirm; the same capture
 *    with the pool's one row moved from `/mnt/anas-ahr/ahr0` to `/var` (a
 *    system path) when the job runs; `ro` in place of `rw` in that row's
 *    options for the remount verb (btrfs forced read-only).
 *  - the expansion intent and /etc/fstab are the daemon's own files, written
 *    in the shape the daemon writes them.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

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

const MOUNTPOINT = '/mnt/anas-ahr/ahr0'

const LIO_NO_LUNS = fixture('iscsi/configfs-restore-empty.manifest')
const LIO_LUN_ON_AHR0 = rewrite(
  fixture('iscsi/configfs-live.manifest'),
  'udev_path = /gtiscsi/images/lun2.raw',
  `udev_path = ${MOUNTPOINT}/images/lun2.raw`,
)

const FINDMNT_AHR0 = fixture('ahr/findmnt-ahr0.json')
const FINDMNT_AHR0_AT_VAR = rewrite(FINDMNT_AHR0, `"target": "${MOUNTPOINT}"`, '"target": "/var"')
const RW_OPTIONS = '"options": "rw,relatime,space_cache=v2,subvolid=5,subvol=/"'
const RO_OPTIONS = '"options": "ro,relatime,space_cache=v2,subvolid=5,subvol=/"'
const FINDMNT_AHR0_RO = rewrite(FINDMNT_AHR0, RW_OPTIONS, RO_OPTIONS)
const FINDMNT_AHR0_RO_AT_VAR = rewrite(FINDMNT_AHR0_RO, `"target": "${MOUNTPOINT}"`, '"target": "/var"')

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** Commands that change a disk, an array, the VG/LV stack, a mount or a subvolume. */
const MUTATING = new Set([
  'umount',
  'mount',
  'lvremove',
  'vgremove',
  'pvremove',
  'lvconvert',
  'lvcreate',
  'lvextend',
  'vgextend',
  'vgreduce',
  'vgcreate',
  'pvcreate',
  'sgdisk',
  'wipefs',
  'partx',
  'mkfs.btrfs',
  'mv',
])
/** mdadm reads; every other mdadm argv acts. */
const MDADM_READS = new Set(['--detail', '--examine', '-D', '-E', '--query'])

function isAhrMutation(c: { command: string, args: string[] }): boolean {
  const cmd = basename(c.command)
  if (MUTATING.has(cmd))
    return true
  if (cmd === 'mdadm')
    return !MDADM_READS.has(c.args[0] ?? '')
  if (cmd === 'btrfs')
    return c.args[0] === 'subvolume' && ['snapshot', 'delete', 'create'].includes(c.args[1] ?? '')
  if (cmd === 'systemctl')
    return c.args[0] === 'daemon-reload'
  return false
}

interface Verb {
  name: string
  method: 'POST' | 'PUT' | 'DELETE'
  url: string
  headers: Record<string, string>
  payload?: string
}
const DESTROY: Verb = { name: 'destroy', method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS }
/**
 * The move's target: under the test's TMPDIR, because the move job creates the
 * directory for real before it mounts (the mock runs no mount, the mkdir is fs).
 */
const NEW_MP = join(tmpdir(), `anas-cr38-move-${process.pid}`)
const MOVE: Verb = { name: 'mountpoint', method: 'PUT', url: '/v1/ahr/ahr0/mountpoint', headers: JSON_HEADERS, payload: JSON.stringify({ mountpoint: NEW_MP }) }
const REMOUNT: Verb = { name: 'remount', method: 'POST', url: '/v1/ahr/ahr0/remount', headers: IDENTITY_HEADERS }

describe('cr.38 — the short AHR verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let configfs: string
  let fstab: string
  let intentDir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** What `findmnt` (the AHR table shape) answers right now; a test flips it while the job waits. */
  let findmnt = FINDMNT_AHR0
  /** A command (by basename) that does not return until `until` settles — to look at a job mid-act. */
  let pauseAt: { command: string, until: Promise<void> } | null = null

  const ENV_KEYS = ['ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_STORAGE_CFG', 'ANAS_FSTAB_PATH', 'ANAS_AHR_INTENT_DIR'] as const
  const savedEnv: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr38-race-'))
    configfs = join(dir, 'target')
    fstab = join(dir, 'fstab')
    intentDir = join(dir, 'intent')
    for (const key of ENV_KEYS)
      savedEnv[key] = process.env[key]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    await rm(NEW_MP, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  /** The dev mock, its LIO tree the LUN-less capture, the AHR mount table routed through `findmnt`. */
  async function serve(initialFindmnt = FINDMNT_AHR0): Promise<void> {
    findmnt = initialFindmnt
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(LIO_NO_LUNS, configfs)
    await writeFile(fstab, `/dev/ahr0/ahr0-vol ${MOUNTPOINT} btrfs nofail 0 0\n`)
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_FSTAB_PATH = fstab
    process.env.ANAS_AHR_INTENT_DIR = intentDir
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (basename(command) === 'findmnt' && args.join(' ') === AHR_FINDMNT_ARGS.join(' '))
        return ok(findmnt)
      if (pauseAt && basename(command) === pauseAt.command)
        await pauseAt.until
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** A LUN's image file appears on the pool (the captured LIO tree, re-pointed). */
  async function lunAppears(): Promise<void> {
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(LIO_LUN_ON_AHR0, configfs)
  }

  /**
   * Challenge, then resend with the code while all four slots are held: the
   * confirmed job is accepted and sits `queued`. Returns its id and the
   * release for the slots.
   */
  async function confirmBehindFullQueue(verb: Verb): Promise<{ id: string, release: () => void }> {
    const first = await server!.inject({ method: verb.method, url: verb.url, headers: verb.headers, payload: verb.payload })
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED', first.body)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const res = await server!.inject({
      method: verb.method,
      url: verb.url,
      headers: { ...verb.headers, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
      payload: verb.payload,
    })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the confirmed job waits behind the held slots')
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

  /** Release the slots, wait for the job, and assert it refused with `code` and acted on nothing. */
  async function refusedInJob(id: string, release: () => void, code: string, message: RegExp): Promise<Job> {
    const fstabBefore = await readFile(fstab, 'utf-8')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error?.code, code, JSON.stringify(job.error))
    assert.match(job.error!.message, message)
    assert.deepEqual(calls.filter(isAhrMutation), [], 'no mutating argv')
    assert.equal(await readFile(fstab, 'utf-8'), fstabBefore, '/etc/fstab untouched')
    return job
  }

  function runningIntent(): AhrExpansionIntent {
    const cap = { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 }
    return { id: randomUUID(), trigger: 'add-disk', approvedDisks: ['ata-x'], before: cap, after: cap, state: 'running' }
  }

  // --- control ---------------------------------------------------------------

  it('control: with nothing changed the held destroy, move and remount run and act — the harness does not refuse on its own', async () => {
    for (const [verb, initial] of [[DESTROY, FINDMNT_AHR0], [MOVE, FINDMNT_AHR0], [REMOUNT, FINDMNT_AHR0_RO]] as const) {
      await serve(initial)
      const { id, release } = await confirmBehindFullQueue(verb)
      release()
      const job = await finished(id)
      // The remount's own post-mount verification reads the table again and
      // finds it still read-only (nothing heals in a mock): the job got past
      // every gate and ACTED, which is all the control asserts.
      if (verb === REMOUNT)
        assert.match(job.error?.message ?? '', /STILL read-only/, JSON.stringify(job))
      else
        assert.equal(job.status, 'completed', `${verb.name}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(isAhrMutation), `${verb.name} acted`)
      await server!.close()
      server = undefined
    }
  })

  // --- destroy: in-flight, intent, system pool, LUN-held -----------------------

  it('destroy: a LUN that appears between the confirm and the job refuses it — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(DESTROY)
    await lunAppears()
    await refusedInJob(id, release, 'CONFLICT', /^Destroying AHR pool 'ahr0' is refused: it is held by iSCSI LUN/)
  })

  it('destroy: the pool mounted at a system path between the confirm and the job refuses it — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(DESTROY)
    findmnt = FINDMNT_AHR0_AT_VAR
    await refusedInJob(id, release, 'CONFLICT', /mounted at \/var — ANAS never destroys or remounts a system pool/)
  })

  it('destroy: an expansion driven between the confirm and the job refuses it — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(DESTROY)
    await writeIntent('ahr0', runningIntent(), { dir: intentDir })
    await refusedInJob(id, release, 'CONFLICT', /expansion being driven right now/)
  })

  it('destroy: an AHR job submitted on the pool between the confirm and the job refuses it (never its own record) — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(DESTROY)
    let endScrub!: () => void
    const scrub = queue().submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'ahr0' } }, () => new Promise<void>((resolve) => {
      endScrub = resolve
    }))
    const job = await refusedInJob(id, release, 'CONFLICT', new RegExp(`has a ahr\\.scrub job in flight \\(job ${scrub.id}\\)`))
    assert.ok(!job.error!.message.includes(id), 'the destroy never counts itself')
    endScrub?.()
  })

  // --- destroy: a corrupt intent file is a ruling, not a hole ------------------

  /** The intent dir exists only once the daemon writes an intent; give it one. */
  async function corruptIntent(): Promise<void> {
    await mkdir(intentDir, { recursive: true })
    await writeFile(join(intentDir, 'ahr0.json'), 'this is not an intent file')
  }

  it('a corrupt intent file does not block destroy — deliberate, see the runningIntentGate comment (refusing would strand the pool)', async () => {
    await serve()
    const first = await server!.inject({ method: DESTROY.method, url: DESTROY.url, headers: DESTROY.headers })
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED', first.body)
    // The file exists but decodes to nothing — the running-intent gate's
    // deliberate read-as-none: only a state of 'running' that is THIS pool's
    // may refuse, and an undecodable file must not make the pool undestroyable.
    await corruptIntent()
    const res = await server!.inject({ method: DESTROY.method, url: DESTROY.url, headers: { ...DESTROY.headers, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(calls.some(isAhrMutation), 'the destroy acted — the corrupt file did not stop it')
  })

  it('a corrupt intent file is disclosed at the destroy confirm (deliberate is not silent)', async () => {
    await serve()
    await corruptIntent()
    const res = await server!.inject({ method: DESTROY.method, url: DESTROY.url, headers: DESTROY.headers })
    assert.equal(res.statusCode, 409, res.body)
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED', res.body)
    assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    const line = body.error.warnings.find(w => w.includes('expansion-intent file'))
    assert.match(line ?? '', /could not be read/)
    assert.match(line ?? '', /treated as no expansion/)
    assert.match(line ?? '', /removed with the pool/)
  })

  it('a corrupt intent file that appears while the destroy job waits is reported on its result (cr.24 ruling (j))', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(DESTROY)
    // The confirm was computed over an absent intent file; the corruption that
    // lands while the job waits is a NEW advisory the confirm did not list —
    // and the destroy still runs (the ruling above), told ON the result.
    await corruptIntent()
    release()
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const line = (job.result as { warnings?: string[] }).warnings?.find(w => w.includes('expansion-intent file'))
    assert.match(line ?? '', /could not be read/)
  })

  // --- mountpoint: every gate (system pool new) --------------------------------

  it('mountpoint: a LUN that appears between the confirm and the job refuses the move — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(MOVE)
    await lunAppears()
    await refusedInJob(id, release, 'CONFLICT', /^Changing the mountpoint of AHR pool 'ahr0' is refused: it is held by iSCSI LUN/)
  })

  it('mountpoint: the pool mounted at a system path between the confirm and the job refuses the move — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(MOVE)
    findmnt = FINDMNT_AHR0_AT_VAR
    await refusedInJob(id, release, 'CONFLICT', /mounted at \/var/)
  })

  it('mountpoint: an fstab line that claims the target between the confirm and the job refuses the move — no mutating argv', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(MOVE)
    await writeFile(fstab, `/dev/ahr0/ahr0-vol ${MOUNTPOINT} btrfs nofail 0 0\n//nas/share ${NEW_MP} cifs nofail 0 0\n`)
    await refusedInJob(id, release, 'CONFLICT', new RegExp(`'${NEW_MP}' is already claimed in fstab`))
  })

  it('mountpoint: a system pool at the confirm is now the route\'s hard 409 (cr.38 adds the gate)', async () => {
    await serve(FINDMNT_AHR0_AT_VAR)
    const res = await server!.inject({ method: MOVE.method, url: MOVE.url, headers: MOVE.headers, payload: MOVE.payload })
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.reason, 'system-pool')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  // --- remount: read-only state, cache, system pool, LUN-held ------------------

  it('remount: a LUN that appears between the confirm and the job refuses it — no mutating argv', async () => {
    await serve(FINDMNT_AHR0_RO)
    const { id, release } = await confirmBehindFullQueue(REMOUNT)
    await lunAppears()
    await refusedInJob(id, release, 'CONFLICT', /^Remounting AHR pool 'ahr0' is refused: it is held by iSCSI LUN/)
  })

  it('remount: the pool mounted at a system path between the confirm and the job refuses it — no mutating argv', async () => {
    await serve(FINDMNT_AHR0_RO)
    const { id, release } = await confirmBehindFullQueue(REMOUNT)
    findmnt = FINDMNT_AHR0_RO_AT_VAR
    await refusedInJob(id, release, 'CONFLICT', /mounted at \/var/)
  })

  it('remount: a pool remounted read-write elsewhere between the confirm and the job is not cycled — no mutating argv', async () => {
    await serve(FINDMNT_AHR0_RO)
    const { id, release } = await confirmBehindFullQueue(REMOUNT)
    findmnt = FINDMNT_AHR0
    await refusedInJob(id, release, 'CONFLICT', /mounted read-write — there is nothing to remount/)
  })

  // --- the bound confirm and the locks -----------------------------------------

  it('a mountpoint confirm signs the target: a resend with another path answers CONFIRM_SCOPE_CHANGED, nothing submitted', async () => {
    await serve()
    const first = await server!.inject({ method: MOVE.method, url: MOVE.url, headers: MOVE.headers, payload: MOVE.payload })
    const code = first.headers['x-anas-confirm-code'] as string
    const other = await server!.inject({ method: 'PUT', url: MOVE.url, headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: JSON.stringify({ mountpoint: '/srv/elsewhere' }) })
    assert.equal(other.statusCode, 409, other.body)
    assert.equal(other.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.match(other.json().error.message, new RegExp(`mountpoint "${NEW_MP}"; this request has mountpoint "/srv/elsewhere"`))
    assert.equal(queue().list().length, 0)
  })

  it('the jobs hold the pool\'s lock keys: destroy the name key and every disk it wipes, the move the target path', async () => {
    for (const [verb, expected] of [
      // The capture's `vgs` carries no vg_uuid column (fixtures/ahr/NOTES.md:
      // captured before ident.3 added it), so the pool is locked by its name
      // key — §4.2's fallback — plus what each verb adds.
      [DESTROY, ['ahrname:ahr0', 'disk:ata-WDC_WD2003FZEX-00SRLA0_WD-12345678', 'disk:ata-WDC_WD2003FZEX-00SRLA0_WD-23456789', 'disk:ata-WDC_WD2003FZEX-00SRLA0_WD-34567890']],
      [MOVE, ['ahrname:ahr0', `mount:${NEW_MP}`]],
    ] as const) {
      await serve()
      let unpause!: () => void
      pauseAt = {
        command: 'umount',
        until: new Promise<void>((resolve) => {
          unpause = resolve
        }),
      }
      const first = await server!.inject({ method: verb.method, url: verb.url, headers: verb.headers, payload: verb.payload })
      const res = await server!.inject({ method: verb.method, url: verb.url, headers: { ...verb.headers, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string }, payload: verb.payload })
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as JobAccepted).job.id
      for (let i = 0; i < 400 && !calls.some(c => basename(c.command) === 'umount'); i++)
        await new Promise(resolve => setTimeout(resolve, 5))
      const held = queue().heldLocks().filter(l => l.holders.includes(id)).map(l => l.key)
      held.sort()
      assert.deepEqual(held, [...expected], `${verb.name} holds its keys while it acts`)
      unpause()
      await finished(id)
      pauseAt = null
      await server!.close()
      server = undefined
    }
  })

  it('every short AHR confirm signs the whole request — no presentation-only fields', () => {
    assert.deepEqual(AHR_CREATE_PRESENTATION_ONLY, {})
    assert.deepEqual(AHR_MOUNTPOINT_PRESENTATION_ONLY, {})
    assert.deepEqual(AHR_REMOUNT_PRESENTATION_ONLY, {})
    assert.deepEqual(AHR_DESTROY_PRESENTATION_ONLY, {})
  })
})

/**
 * §4.2's AHR keys. The captured `vgs` (fixtures/ahr) predates the vg_uuid
 * column, so the route tests above all exercise the name-key fallback; this
 * pins the builder for the pool the column names.
 */
describe('cr.38 — ahrPoolClaims, the AHR twin of poolClaims', () => {
  it('the VG UUID key in the verb\'s mode, the name key only for a namespace verb', () => {
    assert.deepEqual(ahrPoolClaims('tank', 'VGU-1', 'shared').map(c => `${c.key} ${c.mode}`), ['ahr:VGU-1 shared'])
    assert.deepEqual(ahrPoolClaims('tank', 'VGU-1', 'exclusive').map(c => `${c.key} ${c.mode}`), ['ahr:VGU-1 exclusive'])
    assert.deepEqual(ahrPoolClaims('tank', 'VGU-1', 'exclusive', { namespace: true }).map(c => `${c.key} ${c.mode}`), ['ahr:VGU-1 exclusive', 'ahrname:tank exclusive'])
  })

  it('an unreadable VG UUID falls back to the name key, exclusive, whatever the verb asked', () => {
    for (const vgUuid of [null, undefined, ''])
      assert.deepEqual(ahrPoolClaims('tank', vgUuid, 'shared').map(c => `${c.key} ${c.mode}`), ['ahrname:tank exclusive'])
  })
})
