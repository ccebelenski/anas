import type { Job, JobAccepted } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BackupTask, CloudSyncTask, ReplicationTask, SnapshotSchedule } from '@anas/shared'
import { createServer } from '../../server.js'
import { parseServiceUnit as parseBackupServiceUnit, writeTaskUnits as writeBackupTask } from '../../services/backup-units.js'
import { writeTaskUnits as writeCloudTask } from '../../services/cloud-units.js'
import { writeTaskUnits as writeReplicationTask } from '../../services/replication-units.js'
import { writeScheduleUnits } from '../../services/snapshot-schedule-units.js'

/**
 * Story cr.41 — the task/schedule/registry verbs on the guard
 * (docs/WAVE3-DESIGN.md §2.4, §3.3 Unit-store row, §4.2, the operator's cr.41 Q1
 * ruling). One race per "Missing" cell: a state that refuses at the route but
 * becomes true only AFTER the request was accepted — while the job waits in the
 * queue — refuses the job, and the mock executor / the unit store show nothing
 * was done.
 *
 * The job is held in the REAL queue the shares-smb-guard way: four placeholder
 * jobs fill the four slots, the request is accepted behind them (`queued`), the
 * test flips the fixture (a unit file is removed, a run's unit turns active, a
 * referencing task lands, the registry version moves), then releases the slots.
 *
 * FIXTURES (ruling (l): fakes serve captured output): tasks/schedules are
 * written through the stores' OWN writers (their bytes), then removed for the
 * vanished races; the "run active" races flip a `systemctl show` answer to
 * `ActiveState=active`; the registries are the stores' own files.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

const ZPOOL = '/usr/sbin/zpool'
const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** The `zpool list -j` fixture a LOCAL replication target's guard reads (sibling idiom, replication-tasks.test.ts). */
function zpoolListJson(names: string[]): string {
  const pools: Record<string, unknown> = {}
  for (const name of names)
    pools[name] = { name, state: 'ONLINE', properties: {} }
  return JSON.stringify({ pools })
}

/** A store writer's executor: every systemctl the writer runs succeeds. */
const QUIET: CommandExecutor = { exec: async () => ok('') } as unknown as CommandExecutor

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const BACKUP_TASK = {
  name: 'media-nightly',
  repository: 'pbs-main',
  backupId: 'anas-pve',
  archives: [{ name: 'media', path: '/testpool/media/photos', excludes: [] }],
  schedule: '*-*-* 02:00:00',
  enabled: true,
}
const CLOUD_TASK = {
  name: 'offsite',
  source: '/testpool/media',
  remote: 'gt',
  path: 'pve1/media',
  schedule: 'Tue *-*-* 02:00:00',
}
/** Remote target — the remove-reference race's referencing task. */
const REPLICATION_TASK_REMOTE = {
  name: 'repl-nas1',
  source: { pool: 'testpool', dataset: 'media' },
  target: { pool: 'nas1root', location: { kind: 'remote', name: 'nas1' } },
  schedule: '*-*-* 02:00:00',
}
/** Local target — the update/delete doors (their request-time target guard is transport-based for remotes). */
const REPLICATION_TASK_LOCAL = {
  name: 'repl-nas1',
  source: { pool: 'testpool', dataset: 'media' },
  target: { pool: 'backup', dataset: 'media' },
  schedule: '*-*-* 02:00:00',
}
const SCHEDULE = {
  id: 'nightly-media',
  name: 'Nightly media',
  target: { kind: 'zfs', dataset: 'testpool/media' },
  cadence: 'daily',
  retention: { daily: 7 },
  recursive: false,
  enabled: true,
}

const REPO = {
  repo: {
    name: 'pbs-main',
    host: '10.0.0.5',
    port: 8007,
    datastore: 'storage1',
    authType: 'password',
    username: 'root@pam',
    secret: 'swordfish',
  },
  expectedVersion: 0,
}

/** The one rclone section the cloud remote delete races reference. */
const GT_SECTION = '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = rclonegt\npass = mock-obscured\n'

describe('cr.41 — a task/schedule/registry state that flips while the job waits refuses the job', () => {
  let dir: string
  let systemdDir: string
  let reposFile: string
  let credsDir: string
  let rcloneConf: string
  let remotesFile: string
  let server: ReturnType<typeof createServer> | undefined
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in saved))
      saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr41-'))
    systemdDir = join(dir, 'units')
    await import('node:fs/promises').then(fs => fs.mkdir(systemdDir, { recursive: true }))
    reposFile = join(dir, 'backup-repos.json')
    credsDir = join(dir, 'creds')
    rcloneConf = join(dir, 'rclone.conf')
    remotesFile = join(dir, 'remotes.json')
    setEnv('ANAS_SYSTEMD_DIR', systemdDir)
    setEnv('ANAS_BACKUP_REPOS_FILE', reposFile)
    setEnv('ANAS_BACKUP_CREDS_DIR', credsDir)
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    setEnv('ANAS_RCLONE_CONFIG', rcloneConf)
    setEnv('ANAS_REMOTES_FILE', remotesFile)
    setEnv('ANAS_REPL_KEY', join(dir, 'repl_key'))
    setEnv('ANAS_REPL_KNOWN_HOSTS', join(dir, 'known_hosts'))
    setEnv('ANAS_PVE_MEMBERS', join(dir, 'members.json'))
    setEnv('ANAS_STORAGE_CFG', join(dir, 'storage.cfg'))
    await writeFile(join(dir, 'members.json'), JSON.stringify({ nodename: 'node1', nodelist: { node1: {} } }), 'utf-8')
    // The task create/update doors validate schedules with the real
    // `systemd-analyze calendar`, and a job that WRITES units drives systemctl;
    // the dev mock answers nothing foor either. The replication PUT door also
    // asks `zpool list -j` about the SOURCE and the LOCAL target — prepended so
    // it beats the dev server's seeded single-pool result (whose 'backup' does
    // not exist).
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { prependFixture: (f: unknown) => void, addFixture: (f: unknown) => void } }).executor
    mock.prependFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(zpoolListJson(['testpool', 'backup'])) })
    mock.addFixture({ command: SYSTEMD_ANALYZE, result: ok('') })
    mock.addFixture({ command: SYSTEMCTL, result: ok('') })
    await server.ready()
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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

  interface Req { method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown }

  async function send(req: Req) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: req.payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS,
      ...(req.payload === undefined ? {} : { payload: JSON.stringify(req.payload) }),
    })
  }

  /** Accept a verb behind the held slots; it waits `queued`. Returns { id, release }. */
  async function acceptedBehindFullQueue(req: Req): Promise<{ id: string, release: () => void }> {
    const release = holdSlots()
    const res = await send(req)
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

  async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), what)
  }

  async function untilAsync(cond: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await cond())
        return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(await cond(), what)
  }

  function taskActiveFixture(service: string, props: string): void {
    const mock = (server as unknown as { executor: { addFixture: (f: unknown) => void } }).executor
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', service, '-p', props],
      result: ok(`ActiveState=active\nInactiveExitTimestamp=Mon 2026-10-12 02:00:00 UTC\n`),
    })
  }

  /** A `systemctl show` that CANNOT answer: non-zero exit, no stdout (cr.41b's fail-closed read). */
  function systemctlUnreadableFixture(service: string, props: string): void {
    const mock = (server as unknown as { executor: { addFixture: (f: unknown) => void } }).executor
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', service, '-p', props],
      result: { stdout: '', stderr: 'Failed to load unit: systemd could not load the unit', exitCode: 1 },
    })
  }

  /** Hand-edit a unit's marker line so the canonical JSON no longer parses (cr.41b). */
  async function corruptTaskMarker(unitPath: string, marker: string): Promise<void> {
    const text = await readFile(unitPath, 'utf-8')
    assert.ok(text.includes(marker), `unit ${unitPath} carries the marker`)
    await writeFile(unitPath, text.replace(marker, `${marker}broken:`), 'utf-8')
  }

  async function writeTaskFiles(prefix: string, name: string): Promise<void> {
    const fs = await import('node:fs/promises')
    await fs.rm(join(systemdDir, `${prefix}${name}.service`), { force: true })
    await fs.rm(join(systemdDir, `${prefix}${name}.timer`), { force: true })
  }

  /** Register the backup repo the create/update doors' request-time check wants. */
  async function registerRepo(): Promise<number> {
    const res = await send({ method: 'POST', url: '/v1/backup/repos', payload: REPO })
    assert.equal(res.statusCode, 202, res.body)
    await untilAsync(async () => (await registryRepos()).names.includes('pbs-main'), 'repo registered')
    return (await registryRepos()).version
  }

  /** Seed the rclone remote the cloud create/update door's request-time check wants. */
  async function seedRcloneRemote(): Promise<void> {
    await writeFile(rcloneConf, GT_SECTION, 'utf-8')
  }

  /** Seed the replication remotes registry the replication create/update door wants. */
  async function seedRemoteRegistry(): Promise<void> {
    await writeFile(remotesFile, JSON.stringify({
      version: 0,
      updatedBy: '',
      updatedAt: '2026-10-15T00:00:00.000Z',
      remotes: [{ name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }],
    }), 'utf-8')
  }

  /** The registries' own readers, for "nothing was done" assertions. */
  async function registryRepos(): Promise<{ version: number, names: string[] }> {
    const text = await readFile(reposFile, 'utf-8').catch(() => '')
    if (!text)
      return { version: 0, names: [] }
    const parsed = JSON.parse(text) as { version: number, repos: { name: string }[] }
    return { version: parsed.version, names: parsed.repos.map(r => r.name) }
  }

  async function registryRemotes(): Promise<{ version: number, names: string[] }> {
    const text = await readFile(remotesFile, 'utf-8').catch(() => '')
    if (!text)
      return { version: 0, names: [] }
    const parsed = JSON.parse(text) as { version: number, remotes: { name: string }[] }
    return { version: parsed.version, names: parsed.remotes.map(r => r.name) }
  }

  // --- Unit-store races: a vanished task / schedule refuses the queued edit ---

  it('backup: an update whose task was deleted while it waited refuses — no resurrection, no rewrite', async () => {
    await registerRepo()
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse(BACKUP_TASK))
    const { id, release } = await acceptedBehindFullQueue({
      method: 'PUT',
      url: '/v1/backup/tasks/media-nightly',
      payload: { ...BACKUP_TASK, enabled: false },
    })
    await writeTaskFiles('anas-backup-', 'media-nightly')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.ok(!(await readFile(join(systemdDir, 'anas-backup-media-nightly.service'), 'utf-8').catch(() => undefined)), 'the task unit was not re-created')
  })

  it('cloud: an update whose task was deleted while it waited refuses', async () => {
    await seedRcloneRemote()
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse(CLOUD_TASK))
    const { id, release } = await acceptedBehindFullQueue({
      method: 'PUT',
      url: '/v1/cloud/tasks/offsite',
      payload: { ...CLOUD_TASK, path: 'pve1/media2' },
    })
    await writeTaskFiles('anas-cloud-', 'offsite')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.ok(!(await readFile(join(systemdDir, 'anas-cloud-offsite.service'), 'utf-8').catch(() => undefined)), 'the task unit was not re-created')
  })

  it('replication: an update whose task was deleted while it waited refuses', async () => {
    await seedRemoteRegistry()
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse(REPLICATION_TASK_LOCAL))
    const { id, release } = await acceptedBehindFullQueue({
      method: 'PUT',
      url: '/v1/replication/tasks/repl-nas1',
      payload: { ...REPLICATION_TASK_LOCAL, schedule: '*-*-* 03:00:00' },
    })
    await writeTaskFiles('anas-repl-', 'repl-nas1')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.ok(!(await readFile(join(systemdDir, 'anas-repl-repl-nas1.service'), 'utf-8').catch(() => undefined)), 'the task unit was not re-created')
  })

  it('replication: an update whose unit was EDITED while it waited refuses STATE_CHANGED — the revision binds the stored bytes, the concurrent edit survives', async () => {
    // §2.4 unit-store row (§3.3): the update is bound to the unit's bytes (its
    // X-ANAS-Task JSON changes them), so an edit landed between the request and
    // the job is not silently overwritten — it is refused, nothing written.
    await seedRemoteRegistry()
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse(REPLICATION_TASK_LOCAL))
    const { id, release } = await acceptedBehindFullQueue({
      method: 'PUT',
      url: '/v1/replication/tasks/repl-nas1',
      payload: { ...REPLICATION_TASK_LOCAL, schedule: '*-*-* 03:00:00' },
    })
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse({ ...REPLICATION_TASK_LOCAL, schedule: '*-*-* 04:00:00' }))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    const text = await readFile(join(systemdDir, 'anas-repl-repl-nas1.service'), 'utf-8')
    assert.ok(text.includes('"schedule":"*-*-* 04:00:00"'), 'the concurrent edit\'s value is stored, not the update\'s')
  })

  it('schedule: an update whose schedule was deleted while it waited refuses', async () => {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse(SCHEDULE))
    const { id, release } = await acceptedBehindFullQueue({
      method: 'PUT',
      url: '/v1/schedules/nightly-media',
      payload: { ...SCHEDULE, enabled: false },
    })
    await writeTaskFiles('anas-snap-', 'nightly-media')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.ok(!(await readFile(join(systemdDir, 'anas-snap-nightly-media.service'), 'utf-8').catch(() => undefined)), 'the schedule unit was not re-created')
  })

  it('schedule: a FIRE whose schedule was deleted while it waited refuses — no snapshot was taken', async () => {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse(SCHEDULE))
    const { id, release } = await acceptedBehindFullQueue({ method: 'POST', url: '/v1/schedules/nightly-media/run', payload: {} })
    await writeTaskFiles('anas-snap-', 'nightly-media')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
  })

  // --- Q1: a delete during an ACTIVE run refuses at the route AND in the job ---

  it('backup: a delete while the run is active (the unit systemd reports running) refuses at the route, naming the run and how to cancel', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse(BACKUP_TASK))
    taskActiveFixture('anas-backup-media-nightly.service', 'ActiveState,InactiveExitTimestamp')
    const res = await send({ method: 'DELETE', url: '/v1/backup/tasks/media-nightly' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /media-nightly/)
    assert.match(error.message, /still running/)
    assert.match(error.message, /anas-backup-media-nightly\.service/)
    assert.match(error.message, /Cancel run/)
    // Nothing was deleted.
    assert.ok(await readFile(join(systemdDir, 'anas-backup-media-nightly.service'), 'utf-8'))
  })

  it('backup: a delete whose run became active while the job waited refuses IN the job', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse(BACKUP_TASK))
    const { id, release } = await acceptedBehindFullQueue({ method: 'DELETE', url: '/v1/backup/tasks/media-nightly' })
    taskActiveFixture('anas-backup-media-nightly.service', 'ActiveState,InactiveExitTimestamp')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /still running/)
    assert.ok(await readFile(join(systemdDir, 'anas-backup-media-nightly.service'), 'utf-8'), 'the task was not removed')
  })

  it('cloud: a delete whose run became active while the job waited refuses IN the job', async () => {
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse(CLOUD_TASK))
    const { id, release } = await acceptedBehindFullQueue({ method: 'DELETE', url: '/v1/cloud/tasks/offsite' })
    taskActiveFixture('anas-cloud-offsite.service', 'ActiveState,InactiveExitTimestamp')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'CONFLICT')
    assert.ok(await readFile(join(systemdDir, 'anas-cloud-offsite.service'), 'utf-8'), 'the task was not removed')
  })

  it('replication: a delete while the unit is active refuses at the route', async () => {
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse(REPLICATION_TASK_LOCAL))
    taskActiveFixture('anas-repl-repl-nas1.service', 'ActiveState')
    const res = await send({ method: 'DELETE', url: '/v1/replication/tasks/repl-nas1' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /still running/)
    assert.match(error.message, /anas-repl-repl-nas1\.service/)
    assert.ok(await readFile(join(systemdDir, 'anas-repl-repl-nas1.service'), 'utf-8'))
  })

  it('schedule: a delete while the fire is active (a schedule.run job is in flight) refuses at the route, naming the job', async () => {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse(SCHEDULE))
    // An in-flight schedule.run job: its first `zfs snapshot` is parked.
    let park!: () => void
    const held = new Promise<void>((resolve) => {
      park = resolve
    })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command, args, opts) => {
      if (command === '/usr/sbin/zfs' && args[0] === 'snapshot')
        await held
      return orig(command, args, opts)
    }
    const fired = await send({ method: 'POST', url: '/v1/schedules/nightly-media/run', payload: {} })
    assert.equal(fired.statusCode, 202, fired.body)
    const fireId = (fired.json() as JobAccepted).job.id
    await until(() => queue().get(fireId)?.status === 'running', 'the fire runs')
    const res = await send({ method: 'DELETE', url: '/v1/schedules/nightly-media' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /nightly-media/)
    assert.match(error.message, /still running/)
    assert.match(error.message, /job /)
    assert.match(error.message, /Cancel run/)
    park()
    assert.ok(await readFile(join(systemdDir, 'anas-snap-nightly-media.service'), 'utf-8'))
  })

  // --- Registries: a reference that lands while the job waits re-runs ---------

  it('backup repo: the secret is written AFTER the CAS — a version moved while the create waited leaves no secret behind', async () => {
    const { id, release } = await acceptedBehindFullQueue({
      method: 'POST',
      url: '/v1/backup/repos',
      payload: REPO,
    })
    // Another node moved the registry while the job queued.
    await writeFile(reposFile, JSON.stringify({ version: 1, updatedBy: 'other', updatedAt: '2026-10-15T00:00:00.000Z', repos: [] }), 'utf-8')
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    const { version, names } = await registryRepos()
    assert.equal(version, 1, 'the registry was not overwritten by the lost CAS')
    assert.deepEqual(names, [])
    // No secret file ANYWHERE in the creds dir — the secret is only ever
    // written after the CAS wins (its file is `backup-repo-<name>.secret`;
    // checking the whole dir, not one guessed path).
    const creds = await readdir(credsDir, { recursive: true }).catch(() => [] as string[])
    assert.deepEqual(creds, [], 'no secret file was written for the lost CAS')
  })

  it('backup repo: the IN_USE check re-runs in the job — a task created while the remove waited refuses, repo intact', async () => {
    // Register the repo first (version 0 → 1).
    const version = await registerRepo()

    const { id, release } = await acceptedBehindFullQueue({
      method: 'DELETE',
      url: `/v1/backup/repos/pbs-main?expectedVersion=${version}`,
    })
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse(BACKUP_TASK))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'IN_USE')
    const reg = await registryRepos()
    assert.equal(reg.version, version)
    assert.ok(reg.names.includes('pbs-main'), 'the repo was not removed')
  })

  it('replication remote: the referencing-task check re-runs in the job — a task created while the remove waited refuses, remote intact', async () => {
    // Seed the registry with version 0 and the one remote.
    await seedRemoteRegistry()

    const { id, release } = await acceptedBehindFullQueue({ method: 'DELETE', url: '/v1/replication/remotes/nas1?expectedVersion=0' })
    // The reference check must find a task that TARGETS the remote — the local
    // task would not be a referencing task and the removal would succeed.
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse(REPLICATION_TASK_REMOTE))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'VALIDATION_ERROR')
    const remotes = await registryRemotes()
    assert.equal(remotes.version, 0)
    assert.ok(remotes.names.includes('nas1'), 'the remote was not removed')
  })

  it('cloud remote: the reference checks re-run in the job — a task created while the remove waited refuses, remote intact', async () => {
    await seedRcloneRemote()
    const { id, release } = await acceptedBehindFullQueue({ method: 'DELETE', url: '/v1/cloud/remotes/gt' })
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse(CLOUD_TASK))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.equal(job.error?.code, 'CONFLICT')
    const text = await readFile(rcloneConf, 'utf-8')
    assert.match(text, /\[gt\]/, 'the remote section was not removed')
  })

  // --- Creates: the name key serialises, the job re-checks existence ----------

  it('backup: two creates of one name — the second waits for the first, then re-checks and refuses, one unit written', async () => {
    // Register the repo the create's request-time guard checks against.
    await registerRepo()

    const { id, release } = await acceptedBehindFullQueue({
      method: 'POST',
      url: '/v1/backup/tasks',
      payload: BACKUP_TASK,
    })
    // A second create of the SAME name is accepted while the first waits (the
    // route's existence read sees nothing yet), and must serialise behind the
    // first under the task key. It differs in one field (the schedule) so the
    // surviving unit's stored JSON proves WHICH create won.
    const second = await send({ method: 'POST', url: '/v1/backup/tasks', payload: { ...BACKUP_TASK, schedule: '*-*-* 03:00:00' } })
    assert.equal(second.statusCode, 202, second.body)
    const secondId = (second.json() as JobAccepted).job.id
    assert.equal(queue().get(secondId)?.status, 'queued', 'the second create waits behind the first')
    release()

    const first = await finished(id)
    const loser = await finished(secondId)
    assert.equal(first.status, 'completed', JSON.stringify(first.error))
    assert.equal(loser.status, 'failed', JSON.stringify(loser.error))
    assert.equal(loser.error?.code, 'CONFLICT')
    assert.match(loser.error!.message, /already exists/)
    // Exactly one service unit; the losing create did not overwrite it. The
    // unit's X-ANAS-Task JSON is the FIRST create's — it carries the first
    // request's schedule, not the second's.
    const files = await (await import('node:fs/promises')).readdir(systemdDir)
    const backups = files.filter(f => f === 'anas-backup-media-nightly.service')
    assert.equal(backups.length, 1)
    const text = await readFile(join(systemdDir, 'anas-backup-media-nightly.service'), 'utf-8')
    const stored = parseBackupServiceUnit(text)
    assert.equal(stored?.name, 'media-nightly')
    assert.equal(stored?.schedule, BACKUP_TASK.schedule, 'the surviving unit is the first create\'s, not the second\'s')
  })

  // --- cr.41b: a unit that no longer parses is invisible but still deletable ---
  //
  // The list skips an unparseable unit with a warning, so before cr.41b a
  // delete whose object was the PARSED task answered 404 on exactly the unit
  // the operator needs to remove (a hand edit; a task an older ANAS wrote in a
  // shape the current schema refuses). The delete verbs' object is the unit AS
  // STORED: a `.service` on disk reads present, and DELETE answers 202.

  it('backup: a corrupted X-ANAS-Task unit is not in the list, and DELETE removes its units (cr.41b)', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse(BACKUP_TASK))
    const servicePath = join(systemdDir, 'anas-backup-media-nightly.service')
    const timerPath = join(systemdDir, 'anas-backup-media-nightly.timer')
    await corruptTaskMarker(servicePath, 'X-ANAS-Task=')

    const list = await send({ method: 'GET', url: '/v1/backup/tasks' })
    assert.equal(list.statusCode, 200, list.body)
    const names = (list.json() as { data: { task: { name: string } }[] }).data.map(e => e.task.name)
    assert.ok(!names.includes('media-nightly'), 'the corrupted task is skipped by the list')

    const res = await send({ method: 'DELETE', url: '/v1/backup/tasks/media-nightly' })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(!(await readFile(servicePath, 'utf-8').catch(() => undefined)), 'the service unit was removed')
    assert.ok(!(await readFile(timerPath, 'utf-8').catch(() => undefined)), 'the timer unit was removed')
  })

  it('cloud: a corrupted X-ANAS-Task unit is not in the list, and DELETE removes its units (cr.41b)', async () => {
    await seedRcloneRemote()
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse(CLOUD_TASK))
    const servicePath = join(systemdDir, 'anas-cloud-offsite.service')
    const timerPath = join(systemdDir, 'anas-cloud-offsite.timer')
    await corruptTaskMarker(servicePath, 'X-ANAS-Task=')

    const list = await send({ method: 'GET', url: '/v1/cloud/tasks' })
    assert.equal(list.statusCode, 200, list.body)
    const names = (list.json() as { data: { name: string }[] }).data.map(e => e.name)
    assert.ok(!names.includes('offsite'), 'the corrupted task is skipped by the list')

    const res = await send({ method: 'DELETE', url: '/v1/cloud/tasks/offsite' })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(!(await readFile(servicePath, 'utf-8').catch(() => undefined)), 'the service unit was removed')
    assert.ok(!(await readFile(timerPath, 'utf-8').catch(() => undefined)), 'the timer unit was removed')
  })

  it('replication: a corrupted X-ANAS-Task unit is not in the list, and DELETE removes its units (cr.41b)', async () => {
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse(REPLICATION_TASK_LOCAL))
    const servicePath = join(systemdDir, 'anas-repl-repl-nas1.service')
    const timerPath = join(systemdDir, 'anas-repl-repl-nas1.timer')
    await corruptTaskMarker(servicePath, 'X-ANAS-Task=')

    const list = await send({ method: 'GET', url: '/v1/replication/tasks' })
    assert.equal(list.statusCode, 200, list.body)
    const names = (list.json() as { data: { task: { name: string } }[] }).data.map(e => e.task.name)
    assert.ok(!names.includes('repl-nas1'), 'the corrupted task is skipped by the list')

    const res = await send({ method: 'DELETE', url: '/v1/replication/tasks/repl-nas1' })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(!(await readFile(servicePath, 'utf-8').catch(() => undefined)), 'the service unit was removed')
    assert.ok(!(await readFile(timerPath, 'utf-8').catch(() => undefined)), 'the timer unit was removed')
  })

  it('schedule: a corrupted X-ANAS-Schedule unit is not in the list, and DELETE removes its units (cr.41b)', async () => {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse(SCHEDULE))
    const servicePath = join(systemdDir, 'anas-snap-nightly-media.service')
    const timerPath = join(systemdDir, 'anas-snap-nightly-media.timer')
    await corruptTaskMarker(servicePath, 'X-ANAS-Schedule=')

    const list = await send({ method: 'GET', url: '/v1/schedules' })
    assert.equal(list.statusCode, 200, list.body)
    const ids = (list.json() as { data: { schedule: { id: string } }[] }).data.map(e => e.schedule.id)
    assert.ok(!ids.includes('nightly-media'), 'the corrupted schedule is skipped by the list')

    const res = await send({ method: 'DELETE', url: '/v1/schedules/nightly-media' })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(!(await readFile(servicePath, 'utf-8').catch(() => undefined)), 'the service unit was removed')
    assert.ok(!(await readFile(timerPath, 'utf-8').catch(() => undefined)), 'the timer unit was removed')
  })

  // --- cr.41b: the delete's active-run gate fails closed ----------------------
  //
  // The active-run read used to fail open to "not running" on an unreadable
  // `systemctl show`, so a delete proceeded over a run it could not see. The
  // delete gate now FAILS CLOSED: no answer → 409 CONFLICT saying the run state
  // could not be read and nothing was deleted (a guard fails loud). The
  // status/dashboard readers keep their fail-open reads — only the mutation
  // this would delete under is strict.

  it('backup: a delete whose run state systemd cannot read refuses — the gate fails closed (cr.41b)', async () => {
    await writeBackupTask(QUIET, systemdDir, BackupTask.parse(BACKUP_TASK))
    systemctlUnreadableFixture('anas-backup-media-nightly.service', 'ActiveState,InactiveExitTimestamp')
    const res = await send({ method: 'DELETE', url: '/v1/backup/tasks/media-nightly' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /run state from systemd/)
    assert.match(error.message, /nothing was deleted/)
    assert.ok(await readFile(join(systemdDir, 'anas-backup-media-nightly.service'), 'utf-8'), 'the task was not removed')
  })

  it('cloud: a delete whose run state systemd cannot read refuses — the gate fails closed (cr.41b)', async () => {
    await writeCloudTask(QUIET, systemdDir, CloudSyncTask.parse(CLOUD_TASK))
    systemctlUnreadableFixture('anas-cloud-offsite.service', 'ActiveState,InactiveExitTimestamp')
    const res = await send({ method: 'DELETE', url: '/v1/cloud/tasks/offsite' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /run state from systemd/)
    assert.match(error.message, /nothing was deleted/)
    assert.ok(await readFile(join(systemdDir, 'anas-cloud-offsite.service'), 'utf-8'), 'the task was not removed')
  })

  it('replication: a delete whose run state systemd cannot read refuses — the gate fails closed (cr.41b)', async () => {
    await writeReplicationTask(QUIET, systemdDir, ReplicationTask.parse(REPLICATION_TASK_LOCAL))
    systemctlUnreadableFixture('anas-repl-repl-nas1.service', 'ActiveState')
    const res = await send({ method: 'DELETE', url: '/v1/replication/tasks/repl-nas1' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /run state from systemd/)
    assert.match(error.message, /nothing was deleted/)
    assert.ok(await readFile(join(systemdDir, 'anas-repl-repl-nas1.service'), 'utf-8'), 'the task was not removed')
  })

  it('schedule: a delete whose run state systemd cannot read refuses — the gate fails closed (cr.41b)', async () => {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse(SCHEDULE))
    systemctlUnreadableFixture('anas-snap-nightly-media.service', 'ActiveState')
    const res = await send({ method: 'DELETE', url: '/v1/schedules/nightly-media' })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /run state from systemd/)
    assert.match(error.message, /nothing was deleted/)
    assert.ok(await readFile(join(systemdDir, 'anas-snap-nightly-media.service'), 'utf-8'), 'the schedule was not removed')
  })
})
