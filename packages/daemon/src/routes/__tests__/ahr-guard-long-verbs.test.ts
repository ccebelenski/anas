import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { currentLane } from '../../executor/deadline.js'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { forgetIssuedChecks } from '../../services/selfheal-syncop.js'
import {
  AHR_MIRROR_RECONCILE_PRESENTATION_ONLY,
  AHR_PARITY_REWRITE_PRESENTATION_ONLY,
  AHR_REPAIR_PRESENTATION_ONLY,
  ahrMutationRoutes,
  repairFindmntArgs,
} from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

/**
 * Story cr.38 session B — the LONG AHR verbs on the guard: scrub, repair,
 * parity rewrite and mirror reconcile (WAVE3-DESIGN §2.3, §8.2). One race
 * test per "Missing" cell of their rows: the operator's request passes the
 * route (and its confirm), the job waits in the REAL queue behind four held
 * slots, the node changes, the slots are released — and the job refuses with
 * the gate's code before it issues anything that acts (no `mdadm --action=`,
 * no `btrfs scrub start`, no repair snapshot).
 *
 * FIXTURES (ruling (l): fakes print captured output). The pool is the dev
 * mock's `ahr0` (fixtures/ahr, the stage-0 captures, through `mockFixtures`).
 * The flips:
 *  - /proc/mdstat: `mdstat-clean.txt` with md127's sdc1 marked `(F)` and its
 *    slots `[3/2] [U_U]` (a member of r1 failed: the pool reads degraded) —
 *    the kernel's faulty-member shape `mdstat-reshape-degraded.txt` captured
 *    (`sdb1[0](F)`, `[5/4] [_UUUU]`). Not `mdstat-disks2-faulty.txt`: that
 *    file prints the slots as `[2/3]`, raid_disks and working swapped, which
 *    the parser reads as healthy; or `mdstat-clean.txt` with the
 *    kernel's queued-check marker under md127 — the `resync=PENDING` line
 *    the kernel prints under an array whose check waits its turn (the shape
 *    `mdstat-initial-recovery.txt` carries as `resync=DELAYED`) — so a check
 *    nobody in this daemon issued is on the node while the pool itself still
 *    reads healthy, which isolates the node-wide gate from the state gate;
 *  - `mdadm --detail --export` of r1: `mdadm-export-r1.txt` with its MD_UUID
 *    replaced — the band array re-created under the same name;
 *  - the repair file's `realpath -e`: a symlink swapped in, now resolving
 *    outside the pool;
 *  - LIO: `iscsi/configfs-restore-empty.manifest` → `configfs-live.manifest`
 *    with its fileio LUN re-pointed at the repair file and the captured
 *    logged-in ACL info (`configfs-acl-info-loggedin.txt`).
 *
 * The `vgs` capture predates the `vg_uuid` column ident.3 added (`-o
 * +vg_uuid`, fixtures/ahr/NOTES.md), which would lock the pool by its name
 * key alone, exclusive — §4.2's fallback, under which the four verbs never
 * run side by side and the in-process race below could not happen. The
 * column is appended to the capture in LVM's own UUID format, so the pool is
 * locked the way a current node locks it: `ahr:<vg uuid>`, shared.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')
const result = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const MOUNTPOINT = '/mnt/anas-ahr/ahr0'
const FILE = `${MOUNTPOINT}/movies/a.mkv`

const MDSTAT_CLEAN = fixture('ahr/mdstat-clean.txt')
const MDSTAT_DEGRADED = rewrite(
  rewrite(MDSTAT_CLEAN, 'md127 : active raid5 sdd1[3] sdc1[1] sdb1[0]', 'md127 : active raid5 sdd1[3] sdc1[1](F) sdb1[0]'),
  'algorithm 2 [3/3] [UUU]',
  'algorithm 2 [3/2] [U_U]',
)
const MDSTAT_PENDING_CHECK = rewrite(
  MDSTAT_CLEAN,
  '2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]\n',
  '2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]\n      \tresync=PENDING\n',
)
const R1_EXPORT = mockFixtures.ahrMdadmExportR1().stdout
const R1_UUID = /^MD_UUID=(.+)$/m.exec(R1_EXPORT)![1]
const R1_RECREATED = rewrite(R1_EXPORT, `MD_UUID=${R1_UUID}`, 'MD_UUID=0badc0de:0badc0de:0badc0de:0badc0de')

const VG_UUID = 'Wq3hGd-0N1a-7c2Q-Yk5e-PZ3x-l8Rr-T6vB9m'
const VGS_WITH_UUID = rewrite(mockFixtures.ahrVgs().stdout, '"vg_free":"0 "}', `"vg_free":"0 ", "vg_uuid":"${VG_UUID}"}`)

const IDENTITY = { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-request-id': randomUUID(), 'x-anas-privileges': 'Sys.Audit,Sys.Modify' }
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/** The proof both band verbs stand on: a completed scrub, clean checksums, mismatches on r1 (raid5) and r2 (raid1). */
const SCRUB_WITH_MISMATCHES = {
  scrubbed: 'ahr0',
  btrfsErrors: null,
  checkedArrays: 2,
  parityMismatches: [
    { band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' },
    { band: 'ahr0-r2', bandIndex: 2, array: '/dev/md/ahr0-r2', mismatchCnt: 128, level: 'raid1' },
  ],
}

/** md's sysfs for one band (the ahr-mutate suite's shapes for r1 and r2). */
const SYSFS: Record<string, Record<string, string>> = {
  md127: { 'level': 'raid5', 'chunk_size': '524288', 'layout': '2', 'raid_disks': '3', 'sync_action': 'idle', 'last_sync_action': 'check', 'sync_min': '0', 'sync_max': 'max', 'sync_completed': '2089984 / 2089984', 'mismatch_cnt': '8', 'degraded': '0', 'array_state': 'clean', 'reshape_position': 'none', 'rd0/offset': '2048', 'rd0/size': '1044992', 'rd0/state': 'in_sync', 'rd1/offset': '2048', 'rd1/size': '1044992', 'rd1/state': 'in_sync', 'rd2/offset': '2048', 'rd2/size': '1044992', 'rd2/state': 'in_sync' },
  md126: { 'level': 'raid1', 'chunk_size': '0', 'layout': '0', 'raid_disks': '2', 'sync_action': 'idle', 'last_sync_action': 'check', 'sync_min': '0', 'sync_max': 'max', 'sync_completed': '1046400 / 1046400', 'mismatch_cnt': '128', 'degraded': '0', 'array_state': 'clean', 'reshape_position': 'none', 'rd0/offset': '2048', 'rd0/size': '523200', 'rd0/state': 'in_sync', 'rd1/offset': '2048', 'rd1/size': '523200', 'rd1/state': 'in_sync' },
}

/** A command that acts on the pool: an md sync action, a btrfs scrub start, a repair's snapshot or write. */
function acts(c: { command: string, args: string[] }): boolean {
  if (c.command.endsWith('mdadm'))
    return (c.args[0] ?? '').startsWith('--action=')
  if (c.command.endsWith('btrfs'))
    return (c.args[0] === 'scrub' && c.args[1] === 'start') || (c.args[0] === 'subvolume' && c.args[1] === 'snapshot')
  return c.command.endsWith('/dd') || c.command.endsWith('/tee')
}

interface Verb { name: string, url: string, payload?: string, confirm: boolean }
const SCRUB: Verb = { name: 'scrub', url: '/v1/ahr/ahr0/scrub', confirm: false }
const REPAIR: Verb = { name: 'repair', url: '/v1/ahr/ahr0/repair', payload: JSON.stringify({ files: [{ path: FILE, blocks: [300] }] }), confirm: true }
const REWRITE: Verb = { name: 'parity rewrite', url: '/v1/ahr/ahr0/parity-rewrite', payload: JSON.stringify({ band: 1 }), confirm: true }
const RECONCILE: Verb = { name: 'mirror reconcile', url: '/v1/ahr/ahr0/mirror-reconcile', payload: JSON.stringify({ band: 2 }), confirm: true }

// A gate that stops refusing can leave a held job waiting on a latch the
// failed test never opens; the suite's deadline turns that into a failure.
describe('cr.38 session B — scrub, repair, parity rewrite and mirror reconcile re-gate in the job (ruling (j))', { timeout: 120_000 }, () => {
  let dir: string
  let configfs: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>
  /** What `cat /proc/mdstat` answers right now; a test flips it while the job waits. */
  let mdstat = MDSTAT_CLEAN
  /** Hold the Nth mdstat read from now until `until` settles (a route paused mid-check). */
  let pause: { count: number, reached: () => void, until: Promise<void> } | null = null
  /** Hold every command a job issues (its re-check and its body) until `until` settles: the job stays in flight. */
  let holdJob: { id: string, until: Promise<void> } | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr38b-long-'))
    configfs = join(dir, 'target')
    await materializeConfigfsManifest(fixture('iscsi/configfs-restore-empty.manifest'), configfs)
    for (const [kernel, knobs] of Object.entries(SYSFS)) {
      const sys = join(dir, 'sys/block', kernel, 'md')
      for (const key of Object.keys(knobs)) {
        await mkdir(dirname(join(sys, key)), { recursive: true })
        await writeFile(join(sys, key), `${knobs[key]}\n`)
      }
    }
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = dir
    forgetIssuedChecks()
    mdstat = MDSTAT_CLEAN
    pause = null
    holdJob = null

    executor = new MockExecutor()
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md/ahr0-r1'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md/ahr0-r2'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', '/dev/md/ahr0-r1'], result: result('/dev/md127\n') })
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', '/dev/md/ahr0-r2'], result: result('/dev/md126\n') })
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: result(VGS_WITH_UUID) })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs(MOUNTPOINT), result: mockFixtures.ahrBtrfsUsage() })
    // D12 confinement: the mountpoint and the pool's LV resolve, the FILE sits on that LV.
    executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', MOUNTPOINT], result: result(`${MOUNTPOINT}\n`) })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', '/dev/ahr0/ahr0-vol'], result: result('/dev/dm-9\n') })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', FILE], result: result(`${FILE}\n`) })
    executor.addFixture({ command: '/usr/bin/findmnt', args: repairFindmntArgs(FILE), result: result('/dev/ahr0/ahr0-vol\n') })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', FILE], result: result('4096\n') })
    const orig = executor.exec.bind(executor)
    executor.exec = async (command, args, opts) => {
      if (holdJob && currentLane().jobId === holdJob.id)
        await holdJob.until
      if (command === '/usr/bin/cat' && args.join(' ') === MDSTAT_CAT_ARGS.join(' ')) {
        executor.calls.push({ command, args })
        const p = pause
        if (p && --p.count === 0) {
          pause = null
          p.reached()
          await p.until
        }
        return result(mdstat)
      }
      return orig(command, args, opts)
    }

    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      scrubPollIntervalMs: 1,
      iscsiPaths: {
        configfsRoot: configfs,
        saveconfigPath: join(dir, 'absent-saveconfig.json'),
        pveStorageCfg: join(dir, 'absent-storage.cfg'),
        blockRoot: join(dir, 'absent-block'),
      },
    })
    // The proof the band verbs need: one completed scrub with both bands' counts.
    jobQueue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'ahr0' } }, async () => SCRUB_WITH_MISMATCHES)
    for (let i = 0; i < 200 && !jobQueue.findLastCompleted('ahr.scrub', 'ahr0'); i++)
      await new Promise(resolve => setImmediate(resolve))
  })

  afterEach(async () => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function send(verb: Verb, code?: string) {
    return server.inject({ method: 'POST', url: verb.url, headers: { ...(verb.payload ? JSON_HEADERS : IDENTITY), ...(code ? { 'x-anas-confirm': code } : {}) }, payload: verb.payload })
  }

  async function challenge(verb: Verb): Promise<string> {
    const first = await send(verb)
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED', first.body)
    return first.headers['x-anas-confirm-code'] as string
  }

  /** Four placeholder jobs hold every slot; returns their release. */
  function holdSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      jobQueue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  /** The (confirmed) request accepted and queued behind the held slots. */
  async function acceptedBehindFullQueue(verb: Verb): Promise<{ id: string, release: () => void }> {
    const code = verb.confirm ? await challenge(verb) : undefined
    const release = holdSlots()
    const res = await send(verb, code)
    assert.equal(res.statusCode, 202, res.body)
    const id = res.json().job.id as string
    assert.equal(jobQueue.get(id)?.status, 'queued', 'the job waits behind the held slots')
    return { id, release }
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 1000; i++) {
      const job = jobQueue.get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  async function refusedInJob(id: string, release: () => void, code: string, message: RegExp): Promise<Job> {
    const before = executor.calls.length
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error?.code, code, JSON.stringify(job.error))
    assert.match(job.error!.message, message)
    assert.deepEqual(executor.calls.slice(before).filter(acts), [], 'nothing that acts was issued')
    return job
  }

  // --- control ---------------------------------------------------------------

  it('control: with nothing changed the held scrub and parity rewrite pass their re-check and go on to act', async () => {
    for (const verb of [SCRUB, REWRITE]) {
      const { id, release } = await acceptedBehindFullQueue(verb)
      const before = executor.calls.length
      release()
      await finished(id)
      assert.ok(executor.calls.slice(before).some(acts), `${verb.name} acted`)
    }
  })

  // --- the node-wide md check (N10), every verb -------------------------------

  for (const verb of [SCRUB, REPAIR, REWRITE, RECONCILE]) {
    it(`${verb.name}: an md check nobody in this daemon issued, queued on a band between the request and the job, refuses the job`, async () => {
      const { id, release } = await acceptedBehindFullQueue(verb)
      mdstat = MDSTAT_PENDING_CHECK
      await refusedInJob(id, release, 'CONFLICT', /^an md check is running on ahr0-r1 \(started outside this job or by a previous daemon\)/)
    })
  }

  // --- the state roll-up: repair, parity rewrite, mirror reconcile -------------

  for (const verb of [REPAIR, REWRITE, RECONCILE]) {
    it(`${verb.name}: a member failing between the confirm and the job refuses it on the state roll-up`, async () => {
      const { id, release } = await acceptedBehindFullQueue(verb)
      mdstat = MDSTAT_DEGRADED
      await refusedInJob(id, release, 'CONFLICT', /^AHR pool 'ahr0' is degraded: a reconstruction needs every other member of the stripe/)
    })
  }

  // --- the band's identity: parity rewrite and mirror reconcile bind the array UUID

  it('parity rewrite: band r1 re-created as another array between the confirm and the job — IDENTITY_MISMATCH', async () => {
    const { id, release } = await acceptedBehindFullQueue(REWRITE)
    executor.prependFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: result(R1_RECREATED) })
    await refusedInJob(id, release, 'IDENTITY_MISMATCH', /AHR pool 'ahr0'/)
  })

  it('parity rewrite: a code minted before band r1 was re-created is no code for the new array — the resend is challenged again', async () => {
    const code = await challenge(REWRITE)
    executor.prependFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: result(R1_RECREATED) })
    const res = await send(REWRITE, code)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH', res.body)
    assert.equal(jobQueue.list().filter(j => j.operation === 'ahr.parity-rewrite').length, 0)
  })

  // --- repair: confinement and the LUN session ---------------------------------

  it('repair: the file swapped for a symlink out of the pool between the confirm and the job — STATE_CHANGED, nothing written', async () => {
    const { id, release } = await acceptedBehindFullQueue(REPAIR)
    executor.prependFixture({ command: '/usr/bin/realpath', args: ['-e', FILE], result: result('/etc/shadow\n') })
    await refusedInJob(id, release, 'STATE_CHANGED', /AHR pool 'ahr0' changed since you confirmed/)
  })

  it('repair: an initiator logging in to a LUN the file backs between the confirm and the job refuses it — lun-session-active', async () => {
    const { id, release } = await acceptedBehindFullQueue(REPAIR)
    const info = fixture('iscsi/configfs-acl-info-loggedin.txt').trimEnd().replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
    let manifest = rewrite(fixture('iscsi/configfs-live.manifest'), 'udev_path = /gtiscsi/images/lun2.raw', `udev_path = ${FILE}`)
    manifest = manifest.replace(/F (iscsi\/[^\n]*acls\/iqn\.1993-08[^\n]*\/info) = [^\n]*/, `F $1 = ${info}`)
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(manifest, configfs)
    const job = await refusedInJob(id, release, 'CONFLICT', /backs iSCSI LUN .* logged in right now/)
    assert.match(job.error!.message, /This refusal has no confirm bypass/)
  })

  // --- the in-process exclusion: the race two routes can run -------------------

  /**
   * The newer request passes its route's family gate, then pauses at its
   * node-wide read; the OLDER request runs its route and is submitted first;
   * the newer is submitted second. In the job only an OLDER family job counts:
   * the newer refuses naming it, the older is not refused by the newer.
   */
  async function race(older: Verb, newer: Verb): Promise<void> {
    const newerCode = newer.confirm ? await challenge(newer) : undefined
    const release = holdSlots()
    let reached!: () => void
    const atPause = new Promise<void>((resolve) => {
      reached = resolve
    })
    let unpause!: () => void
    // The newer route's 2nd mdstat read is its node-wide check — after its family gate passed.
    pause = { count: 2, reached, until: new Promise<void>((resolve) => {
      unpause = resolve
    }) }
    const newerRes = send(newer, newerCode)
    await atPause
    const olderCode = older.confirm ? await challenge(older) : undefined
    const olderRes = await send(older, olderCode)
    assert.equal(olderRes.statusCode, 202, olderRes.body)
    // The older job stays in flight (every command it issues waits) until
    // the newer one has been judged — the window the exclusion is about.
    let endOlder!: () => void
    holdJob = { id: olderRes.json().job.id as string, until: new Promise<void>((resolve) => {
      endOlder = resolve
    }) }
    unpause()
    const newerDone = await newerRes
    assert.equal(newerDone.statusCode, 202, `the newer request passed its route before the older job existed: ${newerDone.body}`)
    const olderId = olderRes.json().job.id as string
    const newerId = newerDone.json().job.id as string
    const job = await refusedInJob(newerId, release, 'CONFLICT', new RegExp(`in flight on AHR pool 'ahr0' \\(job ${olderId}\\)`))
    assert.ok(!job.error!.message.includes(newerId), 'the job never counts itself')
    endOlder()
    const olderJob = await finished(olderId)
    assert.ok(!(olderJob.error?.message ?? '').includes(newerId), `the older job is not refused by the newer: ${JSON.stringify(olderJob.error)}`)
  }

  it('scrub: an older repair submitted while the scrub\'s route was mid-check refuses the scrub in its job; the repair runs', async () => {
    await race(REPAIR, SCRUB)
  })

  it('repair: an older scrub submitted while the repair\'s route was mid-check refuses the repair in its job; the scrub runs', async () => {
    await race(SCRUB, REPAIR)
  })

  it('parity rewrite: an older repair submitted while the rewrite\'s route was mid-check refuses the rewrite in its job', async () => {
    await race(REPAIR, REWRITE)
  })

  it('mirror reconcile: an older scrub submitted while the reconcile\'s route was mid-check refuses the reconcile in its job', async () => {
    await race(SCRUB, RECONCILE)
  })

  it('the OLDER job is not refused by a newer one still in flight when its own re-check runs — only one of the two is ever refused', async () => {
    // As `race`, but the NEWER job is the one held in flight while the older
    // re-checks: the older must go on (counting a newer job would refuse
    // both — the newer by its own re-check, the older by this one).
    const newerCode = await challenge(REPAIR)
    const release = holdSlots()
    let reached!: () => void
    const atPause = new Promise<void>((resolve) => {
      reached = resolve
    })
    let unpause!: () => void
    pause = { count: 2, reached, until: new Promise<void>((resolve) => {
      unpause = resolve
    }) }
    const newerRes = send(REPAIR, newerCode)
    await atPause
    const olderRes = await send(SCRUB)
    assert.equal(olderRes.statusCode, 202, olderRes.body)
    unpause()
    const newerDone = await newerRes
    assert.equal(newerDone.statusCode, 202, newerDone.body)
    const olderId = olderRes.json().job.id as string
    const newerId = newerDone.json().job.id as string
    let endNewer!: () => void
    holdJob = { id: newerId, until: new Promise<void>((resolve) => {
      endNewer = resolve
    }) }
    release()
    const olderJob = await finished(olderId)
    assert.ok(!(olderJob.error?.message ?? '').includes(newerId), `the older scrub went on: ${JSON.stringify(olderJob.error)}`)
    assert.ok(executor.calls.some(acts), 'and acted')
    assert.equal(jobQueue.get(newerId)?.status, 'running', 'the newer was in flight the whole time')
    endNewer()
    await finished(newerId)
  })

  // --- the locks ---------------------------------------------------------------

  it('every long verb holds the pool\'s key SHARED, in the long lane', async () => {
    // The repair last: its completed run (nothing examinable in a mock) would
    // be the newest proof the band verbs read, and it proves nothing.
    for (const verb of [SCRUB, REWRITE, RECONCILE, REPAIR]) {
      const { id, release } = await acceptedBehindFullQueue(verb)
      const record = (jobQueue as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[], lane: string }> }).jobs.get(id)!
      assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [`ahr:${VG_UUID} shared`, 'ahrname:ahr0 shared'], verb.name)
      assert.equal(record.lane, 'long', verb.name)
      release()
      await finished(id)
    }
  })

  it('every long-verb confirm signs the whole request — no presentation-only fields', () => {
    assert.deepEqual(AHR_REPAIR_PRESENTATION_ONLY, {})
    assert.deepEqual(AHR_PARITY_REWRITE_PRESENTATION_ONLY, {})
    assert.deepEqual(AHR_MIRROR_RECONCILE_PRESENTATION_ONLY, {})
  })
})
