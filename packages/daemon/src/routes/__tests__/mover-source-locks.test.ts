import type { Job, JobAccepted } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
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
import { createServer } from '../../server.js'
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
const TESTPOOL_GUID = '5823146802312415237'

/** Replace exactly `count` occurrences of `from` in a capture. */
function rewrite(text: string, from: string, to: string, count = 1): string {
  assert.equal(text.split(from).length, count + 1, `capture has not exactly ${count} '${from}'`)
  return text.split(from).join(to)
}

const FINDMNT_MEDIA = rewrite(rewrite(fixture('mounts/findmnt-full.json'), '"/mnttest/data"', '"/testpool/media"'), '"mnttest/data"', '"testpool/media"')
const STORAGE_ON_MEDIA = rewrite(rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool/media\n'), '\tmountpoint /datapool\n', '\tmountpoint /testpool/media\n')

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

  /** The dev mock, its findmnt the re-pointed capture, every command recorded, the mover's job bodies parkable. */
  async function serve(mover: string, table: string | null = FINDMNT_MEDIA): Promise<void> {
    calls = []
    findmnt = table
    parkedOp = mover
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
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function inject(verb: { method: Verb['method'], url: string, payload?: unknown }, confirm?: string) {
    const headers: Record<string, string> = { ...IDENTITY_HEADERS }
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
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true } })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'backup.task.run', DESTROY_RECURSIVE, pveClaimsMedia)
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
      'mount:/testpool/media shared',
    ])
    assertRefusedByPve(job, DESTROY_RECURSIVE)
  })

  it('backup: a source whose filesystem cannot be resolved (unreadable mount table) takes no key, and the run says so in its progress line', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse({
      name: 'media-nightly',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'media', path: '/testpool/media/photos', excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }))
    await serve('backup.task.run', null)
    const res = await inject({ method: 'POST', url: '/v1/backup/tasks/media-nightly/run', payload: { direct: true } })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    await until(() => queue().get(runId)?.status === 'running')
    const record = (queue() as unknown as { jobs: Map<string, { claims: unknown[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims, [])
    assert.equal(queue().get(runId)?.progress, `backup task 'media-nightly': /testpool/media/photos: no lock on the source - the mount table could not be read, so its filesystem is unknown`)
  })

  it('backup: the Run-Now supervisor takes no source claim (it waits for the direct run its unit submits)', async () => {
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

  it('cloud: the direct run holds its source\'s dataset shared; a snapshot rename accepted meanwhile waits and re-gates — no zfs rename', async () => {
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse({
      name: 'offsite',
      source: '/testpool/media',
      remote: 'gt',
      path: 'pve1/media',
      schedule: 'Tue *-*-* 02:00:00',
    }))
    await serve('cloud.task.run')
    const res = await inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', payload: { direct: true } })
    assert.equal(res.statusCode, 202, res.body)
    const runId = (res.json() as JobAccepted).job.id
    const job = await race(runId, 'cloud.task.run', RENAME_SNAP1, pveClaimsMedia)
    // The claims the run held (pinned after the race, so a run that holds none fails on the race itself).
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(runId)!
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
      'mount:/testpool/media shared',
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
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), [
      `zfs:${TESTPOOL_GUID}/media shared`,
      `zfs:${TESTPOOL_GUID} shared`,
      `zpool:${TESTPOOL_GUID} shared`,
      'zname:testpool shared',
    ])
    assertRefusedByPve(job, ROLLBACK_FORCE)
  })
})
