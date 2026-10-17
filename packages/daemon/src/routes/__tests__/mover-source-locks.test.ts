import type { Job, JobAccepted } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import type { LockClaim } from '../../jobs/locks.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BackupTask, CloudSyncTask, SnapshotSchedule } from '@anas/shared'
import { currentLane } from '../../executor/deadline.js'
import { VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { TASK_RUNNER_USER } from '../../runner-poll.js'
import { scheduleClaim, taskClaim } from '../../safety/guard.js'
import { createServer } from '../../server.js'
import { AHR_FINDMNT_ARGS } from '../../services/ahr-topology.js'
import { writeTaskUnits as writeBackupTask } from '../../services/backup-units.js'
import { writeTaskUnits as writeCloudTask } from '../../services/cloud-units.js'
import { writeScheduleUnits } from '../../services/snapshot-schedule-units.js'

/**
 * Story cr.33b DD1 — data movers hold SHARED claims on their source for the
 * run (docs/WAVE3-DESIGN.md §4.3): "the operator gets 'waiting for
 * zfs.replicate (job …)' instead of a send that dies mid-stream".
 *
 * One race per mover: the run is accepted and holds its claims (its job body
 * is parked at its first command); a destroy, rename or rollback of its
 * source is then accepted (confirmed where the verb confirms) and must sit
 * `queued` with the progress line naming the run; the node's state changes
 * while it waits; the run is let go. The verb then runs its job-time gates —
 * after the run's last command — against the state as it is NOW, and refuses
 * with no mutating argv. One control shows a verb whose gates still pass runs
 * after the run (it waited, it was not refused).
 *
 * cr.33c adds the two races the cr.33b review found missing: an AHR-pool
 * source (the ahr: + mount keys, with an AHR destroy waiting, plus the
 * cr.33c-F1 case where an unreadable AHR topology leaves the run claimed by
 * its mount only and says so), and a SNAPSHOT rename of the source dataset
 * (rename is X on the dataset key, §4.2).
 *
 * FIXTURES (ruling (l): fakes print captured output):
 *  - the dev mock's ZFS world (testpool, testpool/media with snap1/snap2, the
 *    `zpool get guid` line);
 *  - `mounts/findmnt-full.json` (the mock's own mount tree) with its
 *    `mnttest/data` ZFS row re-pointed to `testpool/media` at /testpool/media
 *    — the row a backup or cloud source on that dataset sits on;
 *  - PVE: no storage.cfg at the request; `pve/storage.cfg` with its zfspool
 *    storage re-pointed from `datapool` to `testpool/media` while the verb
 *    waits (the cr.37 harness's flip: the dataset became PVE's).
 * The task, schedule and repo units are written through the stores' own
 * writers (the run door reads them; their create doors are not under test).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string => readFileSync(join(__dirname, '../../fixtures', rel), 'utf-8')

const ZFS = '/usr/sbin/zfs'
const FINDMNT = '/usr/bin/findmnt'
const CAT = '/usr/bin/cat'
const MDADM = '/usr/sbin/mdadm'
const VGS = '/usr/sbin/vgs'
const PRLIMIT = '/usr/bin/prlimit'
const TESTPOOL_GUID = '5823146802312415237'

/** Replace exactly `count` occurrences of `from` in a capture. */
function rewrite(text: string, from: string, to: string, count = 1): string {
  assert.equal(text.split(from).length, count + 1, `capture has not exactly ${count} '${from}'`)
  return text.split(from).join(to)
}

const FINDMNT_MEDIA = rewrite(rewrite(fixture('mounts/findmnt-full.json'), '"/mnttest/data"', '"/testpool/media"'), '"mnttest/data"', '"testpool/media"')
const STORAGE_ON_MEDIA = rewrite(rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool/media\n'), '\tmountpoint /datapool\n', '\tmountpoint /testpool/media\n')

// --- cr.33c F4: the AHR world ------------------------------------------------
// The dev mock's AHR pool `ahr0` replayed as a BACKUP SOURCE. The dev cap
// seeds the same answers the real node has (mdstat, mdadm exports, lsblk,
// vgs/lvs/pvs, findmnt, btrfs usage); the two pieces only THIS file supplies
// are the VG UUID — the cap's `lvm-vgs.json` comes without the `vg_uuid`
// column, leaving the pool's live `ahr:` key unset — and the mount TABLE the
// source PATH resolves through (`findmnt-full.json` has no ahr0 btrfs row).
const AHR_VG_UUID = 'c4Wd2E-1lQp-KdV8-fQ2k-3HbN-9zQe-Lx7T9a'
const AHR_SOURCE = '/mnt/anas-ahr/ahr0/shares/media'
const AHR_VGS_WITH_UUID = ((): string => {
  const parsed = JSON.parse(fixture('ahr/lvm-vgs.json')) as {
    report: { vg: { vg_name: string, vg_uuid?: string }[] }[]
  }
  const row = parsed.report[0].vg.find(v => v.vg_name === 'ahr0')
  assert.ok(row, 'the dev mock lvm-vgs.json has an ahr0 VG')
  row.vg_uuid = AHR_VG_UUID
  return JSON.stringify(parsed)
})()

/** `findmnt-full` with the AHR pool's btrfs row added — a source path on the pool resolves. */
const FINDMNT_AHR = ((): string => {
  const parsed = JSON.parse(FINDMNT_MEDIA) as { filesystems: { children?: { target: string, source: string, fstype: string, options: string }[] }[] }
  parsed.filesystems[0].children!.push({
    target: '/mnt/anas-ahr/ahr0',
    source: '/dev/mapper/ahr0-ahr0--vol',
    fstype: 'btrfs',
    options: 'rw,relatime,space_cache=v2,subvolid=5,subvol=/',
  })
  return JSON.stringify(parsed)
})()

/** The dev mock's backup registry + secret, so a direct run can genuinely COMPLETE. */
async function registerBackupRepo(): Promise<void> {
  await writeFile(process.env.ANAS_BACKUP_REPOS_FILE!, JSON.stringify({
    version: 1,
    updatedBy: 'root@pam',
    updatedAt: '2026-10-15T10:00:00Z',
    repos: [{ name: 'pbs-main', host: 'localhost', port: 8007, datastore: 'store', authType: 'token', tokenId: 'any' }],
  }))
  await mkdir(process.env.ANAS_BACKUP_CREDS_DIR!, { recursive: true })
  await writeFile(join(process.env.ANAS_BACKUP_CREDS_DIR!, 'backup-repo-pbs-main.secret'), 'token-secret\n')
}

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const MUTATING_ZFS = new Set(['destroy', 'rollback', 'rename'])

interface Verb {
  name: string
  operation: string
  method: 'POST' | 'DELETE' | 'PUT'
  url: string
  payload?: unknown
}
const DESTROY_RECURSIVE: Verb = { name: 'recursive destroy', operation: 'zfs.destroy', method: 'DELETE', url: '/v1/pools/testpool/datasets/media?recursive=true' }
const ROLLBACK: Verb = { name: 'rollback', operation: 'zfs.rollback', method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots/snap2/rollback' }
const ROLLBACK_FORCE: Verb = { name: 'forced rollback', operation: 'zfs.rollback', method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback?force=true' }
const RENAME_SNAP1: Verb = { name: 'rename', operation: 'zfs.rename', method: 'PUT', url: '/v1/pools/testpool/datasets/media/snapshots/snap1', payload: { newName: 'renamed' } }
/** The AHR pool destroy — X on `ahr:<vg uuid>` and `ahrname:<name>`. */
const AHR_DESTROY: Verb = { name: 'AHR destroy', operation: 'ahr.destroy', method: 'DELETE', url: '/v1/ahr/ahr0' }

/** A store writer's executor: every systemctl the writer runs succeeds. */
const QUIET: CommandExecutor = { exec: async () => ok('') } as unknown as CommandExecutor

describe('cr.33b — a data mover holds its source; a destroy, rename or rollback waits for the run, then re-gates', () => {
  let dir: string
  let systemdDir: string
  let storageCfg: string
  let server: ReturnType<typeof createServer> | undefined
  /** Every command, with the operation of the job it ran in ('' outside a job). */
  let calls: { op: string, command: string, args: string[] }[] = []
  /** The operation whose job bodies are parked, and the release. */
  let parkedOp = ''
  let park: Promise<void> = Promise.resolve()
  let unpark: () => void = () => {}
  /** What `findmnt --json` answers; null = the read fails. */
  let findmnt: string | null = FINDMNT_MEDIA
  /** What the AHR topology read's `findmnt --json --real` answers; undefined = the mock cap, null = the read fails. */
  let ahrFindmnt: string | null | undefined
  /** `cat /proc/mdstat` THROWS — `readAhrPools` fails open (cr.33c F1). */
  let ahrBroken = false
  /** `mdadm --detail --export /dev/md127` EXITS 1 with empty stdout (D12 mode A). */
  let ahrDetailBroken = false
  /** The ahr0 VG answers WITH its UUID — the pool's live `ahr:<uuid>` key. */
  let ahrUuid = false
  /** `prlimit` answers success — the direct backup's pbc run completes. */
  let prlimitOk = false
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in saved))
      saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr33b-'))
    systemdDir = join(dir, 'systemd')
    await mkdir(systemdDir, { recursive: true })
    storageCfg = join(dir, 'storage.cfg')
    setEnv('ANAS_SYSTEMD_DIR', systemdDir)
    setEnv('ANAS_STORAGE_CFG', storageCfg)
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    setEnv('ANAS_RCLONE_CONFIG', join(dir, 'rclone.conf'))
    setEnv('ANAS_ISCSI_CONFIGFS', join(dir, 'absent-configfs'))
    setEnv('ANAS_ISCSI_SAVECONFIG', join(dir, 'absent-saveconfig.json'))
    setEnv('ANAS_ISCSI_SYS_BLOCK', join(dir, 'absent-block'))
  })

  afterEach(async () => {
    unpark()
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /**
   * The dev mock, its findmnt the re-pointed capture, every command recorded,
   * the mover's job bodies parkable. The AHR world follows the ahr0 cap: the
   * VG UUID answer and the pbc completion are opt-in (`ahrUuid`, `prlimitOk`),
   * `ahrBroken` makes `cat /proc/mdstat` THROW (cr.33c F1's spawn shape), and
   * `ahrDetailBroken` makes one array's `--detail --export` EXIT 1 (cr.33d
   * D12's failed-read shape) — both reach `readAhrPools`'s unreadable fact.
   */
  async function serve(
    mover: string,
    table: string | null = FINDMNT_MEDIA,
    opts: { ahrFindmnt?: string | null, ahrBroken?: boolean, ahrDetailBroken?: boolean, ahrUuid?: boolean, prlimitOk?: boolean } = {},
  ): Promise<void> {
    calls = []
    findmnt = table
    parkedOp = mover
    ahrFindmnt = opts.ahrFindmnt
    ahrBroken = opts.ahrBroken ?? false
    ahrDetailBroken = opts.ahrDetailBroken ?? false
    ahrUuid = opts.ahrUuid ?? false
    prlimitOk = opts.prlimitOk ?? false
    park = new Promise<void>((resolve) => {
      unpark = resolve
    })
    server = createServer({ mock: true, logger: false })
    const jobs = queue()
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command, args, opts) => {
      const jobId = currentLane().jobId
      const op = jobId ? (jobs.get(jobId)?.operation ?? '') : ''
      if (op === parkedOp)
        await park
      calls.push({ op, command, args })
      if (command === FINDMNT && args.length === 1 && args[0] === '--json')
        return findmnt === null ? { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 } : ok(findmnt)
      if (command === FINDMNT && args.length === AHR_FINDMNT_ARGS.length && args.every((a, i) => a === AHR_FINDMNT_ARGS[i])) {
        return ahrFindmnt === null
          ? { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 }
          : (ahrFindmnt !== undefined ? ok(ahrFindmnt) : orig(command, args, opts))
      }
      if (command === CAT && ahrBroken && args.length === MDSTAT_CAT_ARGS.length && args.every((a, i) => a === MDSTAT_CAT_ARGS[i]))
        throw new Error('mock: /proc/mdstat is unreadable')
      if (command === MDADM && ahrDetailBroken && args.length === mdadmDetailExportArgs('/dev/md127').length && args.every((a, i) => a === mdadmDetailExportArgs('/dev/md127')[i]))
        return { stdout: '', stderr: 'mdadm: cannot open /dev/md127: injected by the w2b node pass', exitCode: 1 }
      if (command === VGS && ahrUuid && args.length === VGS_ARGS.length && args.every((a, i) => a === VGS_ARGS[i]))
        return ok(AHR_VGS_WITH_UUID)
      if (command === PRLIMIT && prlimitOk)
        return ok('')
      return orig(command, args, opts)
    }
    await server.ready()
  }

  /** `runner`: the request comes from the task's own runner (cr.56: the only identity `direct:true` is taken from). */
  function inject(verb: { method: Verb['method'], url: string, payload?: unknown, runner?: boolean }, confirm?: string) {
    const headers: Record<string, string> = { ...IDENTITY_HEADERS, ...(verb.runner ? { 'x-anas-user': TASK_RUNNER_USER } : {}) }
    if (verb.payload !== undefined)
      headers['content-type'] = 'application/json'
    if (confirm)
      headers['x-anas-confirm'] = confirm
    return server!.inject({
      method: verb.method,
      url: verb.url,
      headers,
      ...(verb.payload !== undefined ? { payload: JSON.stringify(verb.payload) } : {}),
    })
  }

  /** Accept the verb (confirmed when it challenges); returns its job id. */
  async function accept(verb: Verb): Promise<string> {
    let res = await inject(verb)
    if (res.statusCode === 409 && res.json().error.code === 'CONFIRMATION_REQUIRED')
      res = await inject(verb, res.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, `${verb.name}: ${res.body}`)
    return (res.json() as JobAccepted).job.id
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
  }

  async function finished(id: string): Promise<Job> {
    await until(() => ['completed', 'failed', 'cancelled'].includes(queue().get(id)?.status ?? ''))
    return queue().get(id)!
  }

  /**
   * The race: the run (already accepted, parked) holds its claims; `verb` is
   * accepted and waits for it, named; `flip` changes the node; the run goes.
   * Returns the verb's finished job.
   */
  async function race(runId: string, mover: string, verb: Verb, flip: () => Promise<void>): Promise<Job> {
    await until(() => queue().get(runId)?.status === 'running')
    const id = await accept(verb)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queue().get(id)?.status, 'queued', `${verb.name} waits for the ${mover} run`)
    assert.equal(queue().get(id)?.progress, `waiting for ${mover} (job ${runId}) on Dataset 'testpool/media'`)
    await flip()
    unpark()
    const job = await finished(id)
    assert.ok(['completed', 'failed'].includes((await finished(runId)).status))
    // It WAITED: every command the verb's job ran came after the run's last.
    const lastRun = calls.map(c => c.op).lastIndexOf(mover)
    const firstVerb = calls.findIndex(c => c.op === verb.operation)
    assert.ok(lastRun >= 0 && firstVerb > lastRun, `${verb.name}'s job-time reads (${firstVerb}) come after the run's last command (${lastRun})`)
    return job
  }

  const pveClaimsMedia = async (): Promise<void> => {
    await writeFile(storageCfg, STORAGE_ON_MEDIA)
  }

  const mutations = (op: string) => calls.filter(c => c.op === op && c.command === ZFS && MUTATING_ZFS.has(c.args[0]))

  function assertRefusedByPve(job: Job, verb: Verb): void {
    assert.equal(job.status, 'failed', `${verb.name}: ${JSON.stringify(job.error)}`)
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(mutations(verb.operation), [], `${verb.name} ran no mutating zfs argv`)
  }

  it('replication: the run holds testpool/media shared; a rollback accepted meanwhile waits for the send and re-gates (PVE claimed the dataset) — no zfs rollback', async () => {
    await serve('zfs.replicate')
    const res = await inject({ method: 'POST', url: '/v1/pools/testpool/datasets/media/replicate', payload: { target: { pool: 'testpool', dataset: 'replica/media' } } })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'zfs.replicate', ROLLBACK, pveClaimsMedia)
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
    ])
    assertRefusedByPve(job, ROLLBACK)
  })

  it('replication (control): with nothing changed, a recursive destroy accepted meanwhile runs after the send — it waited, it was not refused', async () => {
    await serve('zfs.replicate')
    const res = await inject({ method: 'POST', url: '/v1/pools/testpool/datasets/media/replicate', payload: { target: { pool: 'testpool', dataset: 'replica/media' } } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await race((res.json() as JobAccepted).job.id, 'zfs.replicate', DESTROY_RECURSIVE, async () => {})
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(mutations('zfs.destroy').length, 1)
  })

  it('cr.47 (c): a snapshot destroy under a running send of the same dataset does NOT wait — shared beside shared (ZFS busy-protects the snapshot the send reads); a dataset destroy still waits (the tests above)', async () => {
    await serve('zfs.replicate')
    const res = await inject({ method: 'POST', url: '/v1/pools/testpool/datasets/media/replicate', payload: { target: { pool: 'testpool', dataset: 'replica/media' } } })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await until(() => queue().get(runId)?.status === 'running')
    // Delete an UNRELATED old snapshot while the send is parked.
    const snapped = await inject({ method: 'DELETE', url: '/v1/pools/testpool/datasets/media/snapshots/snap1' })
    assert.equal(snapped.statusCode, 202, snapped.body)
    const snapId = (snapped.json() as JobAccepted).job.id
    // The snapshot destroy takes the dataset SHARED — the same mode the send
    // holds — so it is granted without waiting (the rename above stays exclusive:
    // the node proved `zfs rename -r` is stopped by neither a hold nor a send).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(snapId)!
    assert.equal(record.claims.find(c => c.key === `zfs:${TESTPOOL_GUID}/media`)?.mode, 'shared')
    await until(() => queue().get(snapId)?.status === 'completed')
    assert.equal(queue().get(snapId)?.status, 'completed', JSON.stringify(queue().get(snapId)?.error))
    assert.equal(queue().get(runId)?.status, 'running', 'the send is still parked — the destroy did not wait behind it')
    unpark()
    assert.ok(['completed', 'failed'].includes((await finished(runId)).status))
    assert.equal(mutations('zfs.destroy').length, 1, 'the snapshot destroy ran its zfs destroy argv')
  })

  it('backup: the direct run holds its source\'s dataset and mount shared; a recursive destroy accepted meanwhile waits and re-gates — no zfs destroy', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: '/testpool/media/photos', excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run')
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'backup.task.run', DESTROY_RECURSIVE, pveClaimsMedia)
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    // The direct run's OWN `task:backup:<name>` claim (cr.41) rides with its
    // source claims.
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
      'mount:/testpool/media shared',
      'task:backup:media-nightly shared',
    ])
    assertRefusedByPve(job, DESTROY_RECURSIVE)
  })

  it('backup: a source whose filesystem cannot be resolved (unreadable mount table) takes no source key — only the task\'s own key — and the run says so in its progress line', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: '/testpool/media/photos', excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run', null)
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await until(() => queue().get(runId)?.status === 'running')
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => c.key), ['task:backup:media-nightly'])
    assert.equal(queue().get(runId)?.progress, `backup task 'media-nightly': /testpool/media/photos: no lock on the source - the mount table could not be read, so its filesystem is unknown`)
  })

  it('backup: the Run-Now supervisor holds NO key at all — not the source, and not the task key (cr.41: only ONE of the supervisor/direct pair may claim the task, or a queued delete deadlocks them under per-key FIFO)', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: '/testpool/media/photos', excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run')
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: {} })
    assert.equal(res.statusCode, 202, res.body)
    const record = (queue() as unknown as { jobs: Map<string, { claims: unknown[] }> }).jobs.get((res.json() as JobAccepted).job.id)!
    assert.deepEqual(record.claims, [])
  })

  it('cloud: the Run-Now supervisor holds NO key at all — not the source, and not the task key (cr.41, backup parity)', async () => {
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse({
      name: 'offsite',
      source: '/testpool/media',
      remote: 'gt',
      path: 'pve1/media',
      schedule: 'Tue *-*-* 02:00:00',
    }))
    await serve('cloud.task.run')
    const res = await inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', payload: {} })
    assert.equal(res.statusCode, 202, res.body)
    const record = (queue() as unknown as { jobs: Map<string, { claims: unknown[] }> }).jobs.get((res.json() as JobAccepted).job.id)!
    assert.deepEqual(record.claims, [])
  })

  it('cloud: the direct run holds its source\'s dataset shared; a snapshot rename accepted meanwhile waits and re-gates — no zfs rename', async () => {
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse({
      name: 'offsite',
      source: '/testpool/media',
      remote: 'gt',
      path: 'pve1/media',
      schedule: 'Tue *-*-* 02:00:00',
    }))
    await serve('cloud.task.run')
    const res = await inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'cloud.task.run', RENAME_SNAP1, pveClaimsMedia)
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    // The direct run's OWN `task:cloud:<name>` claim (cr.41) rides with its
    // source claims.
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
      'mount:/testpool/media shared',
      'task:cloud:offsite shared',
    ])
    assertRefusedByPve(job, RENAME_SNAP1)
  })

  it('snapshot schedule: the fire holds its target shared; a forced rollback accepted meanwhile waits and re-gates — no zfs rollback', async () => {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse({
      id: 'nightly-media',
      name: 'Nightly media',
      target: { kind: 'zfs', dataset: 'testpool/media' },
      cadence: 'daily',
      retention: { daily: 7 },
      recursive: false,
      enabled: true,
    }))
    await serve('schedule.run')
    const res = await inject({ method: 'POST', url: '/v1/schedules/nightly-media/run' })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'schedule.run', ROLLBACK_FORCE, pveClaimsMedia)
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    // The fire's own `schedule:<id>` claim (cr.41) rides with its source claims.
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
      'schedule:nightly-media shared',
    ])
    assertRefusedByPve(job, ROLLBACK_FORCE)
  })

  it('cr.33c F5: a SNAPSHOT rename of the SOURCE dataset — rename is X on the dataset key (§4.2) — accepted while a replication send reads it waits for the send and re-gates — no zfs rename', async () => {
    await serve('zfs.replicate')
    const res = await inject({ method: 'POST', url: '/v1/pools/testpool/datasets/media/replicate', payload: { target: { pool: 'testpool', dataset: 'replica/media' } } })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'zfs.replicate', RENAME_SNAP1, pveClaimsMedia)
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
    ])
    assertRefusedByPve(job, RENAME_SNAP1)
  })

  it('cr.33c F4 (a): the direct backup run on an AHR-pool source holds its ahr: keys and mount shared; an AHR destroy accepted meanwhile waits for the run and re-gates (an unreadable mount table reads as a system pool) — the pool survives', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: AHR_SOURCE, excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run', FINDMNT_AHR, { ahrUuid: true })
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await until(() => queue().get(runId)?.status === 'running')
    const id = await accept(AHR_DESTROY)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queue().get(id)?.status, 'queued', 'the AHR destroy waits for the backup run')
    assert.equal(queue().get(id)?.progress, `waiting for backup.task.run (job ${runId}) on AHR pool 'ahr0'`)
    // The flip: cr.23 — an UNREADABLE mount table reads as a system pool, so
    // the destroy's job-time re-gate refuses instead of tearing the pool down.
    ahrFindmnt = null
    unpark()
    const job = await finished(id)
    assert.ok(['completed', 'failed'].includes((await finished(runId)).status))
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `ahr:${AHR_VG_UUID} shared`,
      'ahrname:ahr0 shared',
      'mount:/mnt/anas-ahr/ahr0 shared',
      'task:backup:media-nightly shared',
    ])
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /treated as a system pool/)
    // It WAITED: every command the destroy's job ran came after the run's last.
    const lastRun = calls.map(c => c.op).lastIndexOf('backup.task.run')
    const firstVerb = calls.findIndex(c => c.op === 'ahr.destroy')
    assert.ok(lastRun >= 0 && firstVerb > lastRun, `the destroy's job-time reads (${firstVerb}) come after the run's last command (${lastRun})`)
  })

  it('cr.33c F4 (b): an UNREADABLE AHR topology (cr.33c F1) leaves the direct run claimed by its mount only — the unlocked sentence names the AHR topology, the claim set has no ahr: key, and the run still completes', async () => {
    await registerBackupRepo()
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: AHR_SOURCE, excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run', FINDMNT_AHR, { ahrBroken: true, prlimitOk: true })
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await until(() => queue().get(runId)?.status === 'running')
    // Only the mount the path sits on and the task's own key — the ahr: lock
    // could not be taken, and the progress line says exactly why.
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => c.key), ['mount:/mnt/anas-ahr/ahr0', 'task:backup:media-nightly'])
    assert.equal(
      queue().get(runId)?.progress,
      `backup task 'media-nightly': ${AHR_SOURCE}: no lock on the source - the AHR topology could not be read, so it is unknown whether the filesystem is an ANAS AHR pool`,
    )
    unpark()
    assert.equal((await finished(runId)).status, 'completed')
  })

  it('cr.33d (a): a `--detail --export` that EXITS 1 for one array (D12 mode A) reaches the SAME unreadable fact the spawn failure does — the run holds no ahr: key, the unlocked sentence names the AHR topology, and the run still completes', async () => {
    await registerBackupRepo()
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: AHR_SOURCE, excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run', FINDMNT_AHR, { ahrDetailBroken: true, prlimitOk: true })
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await until(() => queue().get(runId)?.status === 'running')
    // The exit-code shape is indistinguishable from the throw here — the run is
    // claimed by its mount only and says why (the ahr: lock could not be taken).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => c.key), ['mount:/mnt/anas-ahr/ahr0', 'task:backup:media-nightly'])
    assert.equal(
      queue().get(runId)?.progress,
      `backup task 'media-nightly': ${AHR_SOURCE}: no lock on the source - the AHR topology could not be read, so it is unknown whether the filesystem is an ANAS AHR pool`,
    )
    unpark()
    assert.equal((await finished(runId)).status, 'completed')
  })

  // --- cr.56 (review M2): the job's own re-read decides the keys it needs ----
  //
  // The paused-queue race: an UPDATE of the task or schedule holds its key
  // exclusive (a stand-in job here, holding exactly the claim the update
  // takes, so the edit can land at a chosen moment); the run is accepted
  // behind it — its route reads the OLD object and computes its claims from
  // it — and waits; the object is edited; the holder lets go. The run's job
  // re-reads the object, recomputes its claims with the route's own builder,
  // and refuses STATE_CHANGED naming what moved and what it holds no lock
  // on, before any mover argv. Controls: an edit that needs no new key runs.

  /** Park the queue on `claim` (as an update holding the task or schedule key does); returns the release. */
  function holdKey(claim: LockClaim): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    queue().submit('test.hold', { user: 'test', uid: 0 }, async () => {
      await held
    }, { locks: [claim] })
    return release
  }

  const PBC = '/usr/bin/proxmox-backup-client'
  const RCLONE = '/usr/bin/rclone'
  /** Did the run's job reach its mover (pbc through prlimit, rclone copy/sync, a zfs snapshot)? */
  const moverRan = (op: string): boolean => calls.some(c => c.op === op && (
    c.command === PRLIMIT || c.command === PBC
    || (c.command === RCLONE && (c.args[0] === 'copy' || c.args[0] === 'sync'))
    || (c.command === ZFS && c.args[0] === 'snapshot')))

  async function backupTask(path: string): Promise<void> {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path, excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
  }

  /** Accept the runner's direct run behind the held key; returns its job id, asserted waiting. */
  async function directRunWaiting(url: string): Promise<string> {
    const res = await inject({ method: 'POST', url, payload: { direct: true }, runner: true })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queue().get(runId)?.status, 'queued', 'the run waits behind the key holder')
    return runId
  }

  it('cr.56 M2 backup: an archive path edited onto another filesystem while the direct run waits → STATE_CHANGED naming the paths and the unheld mount, and no pbc argv', async () => {
    await registerBackupRepo()
    await backupTask('/testpool/media/photos')
    await serve('none', FINDMNT_MEDIA, { prlimitOk: true })
    const release = holdKey(taskClaim('backup', 'media-nightly', 'exclusive'))
    const runId = await directRunWaiting('/v1/backup/tasks/media-nightly/run')
    // The update's write: the archive moves to the NFS mount the run holds no key on.
    await backupTask('/mnt/anas-nfs/photos')
    release()
    const job = await finished(runId)
    assert.equal(job.status, 'failed', JSON.stringify(job.result))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `Backup task 'media-nightly' changed while this run waited (archive paths were /testpool/media/photos; `
    + `now /mnt/anas-nfs/photos) — the run holds no lock on the mount at /mnt/anas-nfs, so nothing was done; run it again`)
    assert.equal(moverRan('backup.task.run'), false, 'no pbc argv')
  })

  it('cr.56 M2 backup: the SAME archive path whose filesystem moved (the dataset\'s mount went away) while the run waited → STATE_CHANGED — why the claims are recomputed, not the paths bound', async () => {
    await registerBackupRepo()
    await backupTask('/testpool/media/photos')
    await serve('none', FINDMNT_MEDIA, { prlimitOk: true })
    const release = holdKey(taskClaim('backup', 'media-nightly', 'exclusive'))
    const runId = await directRunWaiting('/v1/backup/tasks/media-nightly/run')
    // The capture as it was before the re-point: no testpool/media row, so the
    // path now lives on the root filesystem.
    findmnt = fixture('mounts/findmnt-full.json')
    release()
    const job = await finished(runId)
    assert.equal(job.status, 'failed', JSON.stringify(job.result))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `Backup task 'media-nightly' changed while this run waited (archive paths /testpool/media/photos now resolve `
    + `to a different filesystem) — the run holds no lock on the mount at /, so nothing was done; run it again`)
    assert.equal(moverRan('backup.task.run'), false, 'no pbc argv')
  })

  it('cr.56 M2 backup (control): an archive path edited within the SAME dataset needs no new key — the run backs up the edited path', async () => {
    await registerBackupRepo()
    await backupTask('/testpool/media/photos')
    await serve('none', FINDMNT_MEDIA, { prlimitOk: true })
    const release = holdKey(taskClaim('backup', 'media-nightly', 'exclusive'))
    const runId = await directRunWaiting('/v1/backup/tasks/media-nightly/run')
    await backupTask('/testpool/media/music')
    release()
    const job = await finished(runId)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // The run's transient snapshot of testpool/media, read at the EDITED path.
    const pbc = calls.filter(c => c.op === 'backup.task.run' && c.command === PRLIMIT)
    assert.equal(pbc.length, 1)
    assert.match(pbc[0].args[4], /^media\.pxar:\/testpool\/media\/\.zfs\/snapshot\/anas-backup-media-nightly-\d+\/music$/)
  })

  it('cr.56 M2 cloud: the source edited onto another filesystem while the direct run waits → STATE_CHANGED naming the source and the unheld mount, and no rclone copy/sync', async () => {
    const task = (source: string) => writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse({
      name: 'offsite',
      source,
      remote: 'gt',
      path: 'pve1/media',
      schedule: 'Tue *-*-* 02:00:00',
    }))
    await task('/testpool/media')
    await serve('none')
    const release = holdKey(taskClaim('cloud', 'offsite', 'exclusive'))
    const runId = await directRunWaiting('/v1/cloud/tasks/offsite/run')
    await task('/mnt/anas-nfs')
    release()
    const job = await finished(runId)
    assert.equal(job.status, 'failed', JSON.stringify(job.result))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `Cloud sync task 'offsite' changed while this run waited (source was /testpool/media; now /mnt/anas-nfs) `
    + `— the run holds no lock on the mount at /mnt/anas-nfs, so nothing was done; run it again`)
    assert.equal(moverRan('cloud.task.run'), false, 'no rclone copy/sync argv')
  })

  it('cr.56 M2 schedule: the schedule deleted and re-created under its id onto another dataset while the fire waits → STATE_CHANGED naming the target and the unheld dataset, and no zfs snapshot', async () => {
    const schedule = (dataset: string) => writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse({
      id: 'nightly-media',
      name: 'Nightly media',
      target: { kind: 'zfs', dataset },
      cadence: 'daily',
      retention: { daily: 7 },
      recursive: false,
      enabled: true,
    }))
    await schedule('testpool/media')
    await serve('none')
    // The schedule key exclusive: a delete (or the create after it) holding it.
    const release = holdKey(scheduleClaim('nightly-media', 'exclusive'))
    const res = await inject({ method: 'POST', url: '/v1/schedules/nightly-media/run' })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queue().get(runId)?.status, 'queued', 'the fire waits behind the key holder')
    // An edit cannot retarget (PUT refuses it); delete + create under the same id can.
    await schedule('testpool/vm-100-disk-0')
    release()
    const job = await finished(runId)
    assert.equal(job.status, 'failed', JSON.stringify(job.result))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    // cr.64a: the GUARD's own lock recompute answers this race before the
    // door's in-body check does — same STATE_CHANGED, same unheld-object tail,
    // no snapshot argv — so the parenthetical is the guard's claim-set
    // sentence, not the door's bespoke `target was …; now …` one (which stays
    // as the door's own dead-if-reached check until schedules.ts folds).
    assert.equal(job.error?.message, `Snapshot schedule 'nightly-media' changed while this run waited (lock claims were `
    + `zfs:${TESTPOOL_GUID}/media, zfs:${TESTPOOL_GUID}, zpool:${TESTPOOL_GUID}, zname:testpool, schedule:nightly-media; `
    + `now zfs:${TESTPOOL_GUID}/vm-100-disk-0, zfs:${TESTPOOL_GUID}, zpool:${TESTPOOL_GUID}, zname:testpool, schedule:nightly-media) `
    + `— the run holds no lock on Dataset 'testpool/vm-100-disk-0', so nothing was done; run it again`)
    assert.equal(moverRan('schedule.run'), false, 'no zfs snapshot argv')
  })
})
