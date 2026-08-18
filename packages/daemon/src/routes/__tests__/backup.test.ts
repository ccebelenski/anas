import type { BackupRepoResponse, BackupTaskDetail, BackupTaskEntry, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { isoWeekParity } from '../../services/backup-cadence.js'

/** A real `pbs` stanza (ground truth 16.8) — a password-auth PVE-defined repo. */
const PVE_STORAGE_CFG = [
  'dir: local',
  '\tpath /var/lib/vz',
  '\tcontent backup',
  '',
  'pbs: anastest-pw',
  '\tdatastore anastest-store',
  '\tserver 127.0.0.1',
  '\tcontent backup',
  '\tfingerprint cc:b8:a0:35:60:b9:5f:77:10:e8:c2:62:ce:1e:dd:08:b8:03:0a:82:f7:62:09:bf:e8:f5:44:7e:8b:3e:2c:1d',
  '\tnamespace anastest',
  '\tusername root@pam',
  '',
].join('\n')

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/** A real pbc backup transcript on STDERR (SURPRISE C: stdout is empty). */
const PBC_BACKUP_STDERR = [
  'Starting backup: [anastest]:host/anas-pve/2026-07-19T01:07:07Z',
  'Client name: anas-pve',
  'Upload directory \'/etc\' to \'root@pam@localhost:8007:anastest-store\' as etc.pxar.didx',
  'etc.pxar: had to backup 82.957 KiB of 82.957 KiB (compressed 81.043 KiB) in 0.01 s (average 13.322 MiB/s)',
  'Uploaded backup catalog (516 B)',
  'Duration: 0.12s',
  'End Time: Sun Jul 19 01:07:07 2026',
].join('\n')

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string, attempts = 100, delayMs = 10): Promise<Job> {
  for (let i = 0; i < attempts; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** The exact args `superviseRun` reads with `systemctl show` (a scriptable seam). */
const SUPERVISE_SHOW_ARGS = ['show', 'anas-backup-nightly-etc.service', '-p', 'ActiveState,Result,ExecMainStatus,InvocationID']

/** A unit-journal blob carrying the backup-task helper's result JSON (Fix 1). */
const HELPER_JOURNAL = [
  '2026-07-19T01:07:07+0000 anas-pve anas-backup-nightly-etc[999]: {"task":"nightly-etc","result":{"status":"success","archives":["etc.pxar: had to backup 82.957 KiB of 82.957 KiB"]}}',
  '2026-07-19T01:07:07+0000 anas-pve systemd[1]: anas-backup-nightly-etc.service: Deactivated successfully.',
].join('\n')

async function jobIdFrom(res: { json: () => unknown }): Promise<string> {
  const { job } = res.json() as { job?: { id: string } }
  assert.ok(job?.id, 'expected a job ref')
  return job.id
}

describe('backup routes (Epic 16)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backuproutes-'))
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    // Tier-1 (PVE-defined) repos: a read-only storage.cfg + a per-storage .pw
    // (bare secret + trailing newline, ground truth 16.8). ANAS never writes them.
    setEnv('ANAS_STORAGE_CFG', join(dir, 'storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    await writeFile(join(dir, 'storage.cfg'), PVE_STORAGE_CFG)
    await mkdir(join(dir, 'priv-storage'), { recursive: true })
    await writeFile(join(dir, 'priv-storage', 'anastest-pw.pw'), 'AnasPbsTest123\n')
    server = createServer({ mock: true, logger: false })
    // Systemctl (daemon-reload / enable / disable) + systemd-analyze + journalctl
    // + pbc, so unit writes, schedule validation, detail, and Run-Now succeed.
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemd-analyze', result: { stdout: 'Normalized form: *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/journalctl', result: { stdout: 'recent run output', stderr: '', exitCode: 0 } })
    // pbc runs wrapped in prlimit — the fd cap must bind pbc itself, not the
    // task unit (live-proof finding A). The mock keys on the outer command.
    mock.addFixture({ command: '/usr/bin/prlimit', result: { stdout: '', stderr: PBC_BACKUP_STDERR, exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
    }
  })

  const REPO = {
    name: 'pbs-main',
    host: '127.0.0.1',
    port: 8007,
    datastore: 'store1',
    authType: 'token' as const,
    tokenId: 'root@pam!anas',
    fingerprint: 'cc:b8:a0',
    secret: 'token-secret-value',
  }

  async function createRepo(): Promise<void> {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo: REPO, expectedVersion: 0 } })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
  }

  const TASK = {
    name: 'nightly-etc',
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives: [{ name: 'etc', path: '/etc', excludes: [] }],
    changeDetectionMode: 'metadata',
    mode: 'metadata', // legacy alias — the daemon must accept either
    schedule: '*-*-* 02:00:00',
    enabled: true,
  }

  async function createTask(): Promise<void> {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: TASK })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
  }

  it('POST /backup/repos registers a repo; GET returns it with credentialsSet (no secret)', async () => {
    await createRepo()
    const res = await server.inject({ method: 'GET', url: '/v1/backup/repos', headers: IDENTITY })
    const { data } = res.json() as { data: { version: number, repos: Array<Record<string, unknown>> } }
    assert.equal(data.version, 1)
    // The registered repo (source:anas) — a tier-1 pve:<id> repo also appears.
    const repo = data.repos.find(r => r.name === 'pbs-main')!
    assert.ok(repo, 'expected the registered repo')
    assert.equal(repo.source, 'anas')
    assert.equal(repo.credentialsSet, true)
    assert.equal('secret' in repo, false)
  })

  it('POST /backup/repos without a secret is a 400 (nothing stored yet)', async () => {
    const { secret, ...noSecret } = REPO
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo: noSecret, expectedVersion: 0 } })
    assert.equal(res.statusCode, 400)
  })

  it('POST /backup/repos with a stale expectedVersion 409s', async () => {
    await createRepo()
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo: { ...REPO, name: 'other' }, expectedVersion: 0 } })
    assert.equal(res.statusCode, 409)
  })

  it('POST /backup/tasks accepts the legacy `mode` alias; GET joins the datastore', async () => {
    await createRepo()
    await createTask()
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    assert.equal(data.length, 1)
    assert.equal(data[0].task.name, 'nightly-etc')
    assert.equal(data[0].task.changeDetectionMode, 'metadata')
    assert.equal(data[0].task.datastore, 'store1') // joined from the repo
  })

  it('POST /backup/tasks for an unregistered repo is a 400', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: TASK })
    assert.equal(res.statusCode, 400)
  })

  it('GET /backup/tasks/:name returns the unit/timer text + recent journal', async () => {
    await createRepo()
    await createTask()
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly-etc', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.match(data.unit, /LimitNOFILE=1024/)
    assert.match(data.unit, /X-ANAS-Task=/)
    assert.match(data.timer, /OnCalendar=/)
    assert.equal(data.journal, 'recent run output')
  })

  it('POST /run { direct:true } runs pbc IN the daemon (the unit\'s own exec) — never systemctl', async () => {
    await createRepo()
    await createTask()
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: { direct: true } })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    const result = job.result as { status: string, archives: string[] }
    assert.equal(result.status, 'success')
    assert.ok(result.archives.some(l => l.startsWith('etc.pxar:')))
    // The direct path executes pbc (via prlimit) and NEVER starts the unit — the
    // recursion guard. It is the unit's OWN work, not a manual supervise.
    assert.ok(mock.calls.some(c => c.command === '/usr/bin/prlimit'))
    assert.equal(mock.calls.some(c => c.command === '/usr/bin/systemctl' && c.args[0] === 'start'), false)
  })

  it('POST /run (no direct) starts the unit and supervises it to a systemd result (Fix 1)', async () => {
    await createRepo()
    await createTask()
    const mock = mockOf(server)
    // Script the `systemctl show` transition the supervisor polls: pre-check
    // inactive (invocation OLD) → a fresh invocation that has already finished
    // (fast success). The journal carries the helper's result JSON.
    mock.addFixture({
      command: '/usr/bin/systemctl',
      args: SUPERVISE_SHOW_ARGS,
      results: [
        { stdout: 'ActiveState=inactive\nResult=success\nInvocationID=OLD\n', stderr: '', exitCode: 0 },
        { stdout: 'ActiveState=inactive\nResult=success\nExecMainStatus=0\nInvocationID=NEW\n', stderr: '', exitCode: 0 },
      ],
    })
    mock.addFixture({ command: '/usr/bin/journalctl', args: ['-u', 'anas-backup-nightly-etc.service', '-n', '200', '-o', 'short-iso', '--no-pager'], result: { stdout: HELPER_JOURNAL, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: {} })
    assert.equal(res.statusCode, 202)
    // supervise sleeps ~2s per poll → allow a longer window.
    const job = await waitForJob(server, await jobIdFrom(res), 400, 25)
    assert.equal(job.status, 'completed')
    const result = job.result as { status: string, archives?: string[] }
    assert.equal(result.status, 'success')
    assert.ok(result.archives!.some(l => l.startsWith('etc.pxar:')))
    // It went through the unit (systemctl start), NOT a direct pbc exec.
    assert.ok(mock.calls.some(c => c.command === '/usr/bin/systemctl' && c.args[0] === 'start'))
    assert.equal(mock.calls.some(c => c.command === '/usr/bin/prlimit'), false)
  })

  // ---- Retention (story 16.11) -------------------------------------------
  // Prune runs AFTER a successful backup, with exactly the task's keep flags.
  // Ground truth: fixtures/backup/prune-*.txt (2026-08-17).

  /** Three entries of the real `prune --output-format json` array (2 keep, 1 remove). */
  const PRUNE_JSON = JSON.stringify([
    { 'backup-id': 'anas-pve', 'backup-time': 1750712754, 'backup-type': 'host', 'keep': false, 'ns': 'anastest', 'protected': false },
    { 'backup-id': 'anas-pve', 'backup-time': 1786914356, 'backup-type': 'host', 'keep': true, 'ns': 'anastest', 'protected': false },
    { 'backup-id': 'anas-pve', 'backup-time': 1787000792, 'backup-type': 'host', 'keep': true, 'ns': 'anastest', 'protected': false },
  ])
  const PBC_CMD = '/usr/bin/proxmox-backup-client'
  const RETAINED_TASK = { ...TASK, name: 'retained', retention: { keepLast: 2, keepDaily: 7 } }
  /**
   * The exact prlimit-wrapped pbc BACKUP argv for RETAINED_TASK — an args-exact
   * fixture, because the suite's command-only prlimit fixture (a success) would
   * otherwise win and no failure/skip could be scripted.
   */
  const RETAINED_BACKUP_ARGS = [
    '--nofile=1024:1024',
    '--',
    PBC_CMD,
    'backup',
    'etc.pxar:/etc',
    '--backup-id',
    'anas-pve',
    '--change-detection-mode=metadata',
  ]

  async function createTaskPayload(payload: Record<string, unknown>): Promise<void> {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
  }

  /** Every pbc prune invocation the mock recorded. */
  function pruneCalls(mock: MockExecutor): { command: string, args: string[] }[] {
    return mock.calls.filter(c => c.command === PBC_CMD && c.args[0] === 'prune')
  }

  it('a successful run prunes with EXACTLY the configured keeps + json output', async () => {
    await createRepo()
    await createTaskPayload(RETAINED_TASK)
    const mock = mockOf(server)
    mock.addFixture({ command: PBC_CMD, result: { stdout: PRUNE_JSON, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    const result = job.result as { status: string, prune?: { kept: number, removed: number, dryRun: boolean }, warnings?: string[] }
    assert.equal(result.status, 'success')
    assert.equal(result.prune!.kept, 2)
    assert.equal(result.prune!.removed, 1)
    assert.equal(result.prune!.dryRun, false)
    assert.equal(result.warnings, undefined)
    assert.deepEqual(pruneCalls(mock), [{
      command: PBC_CMD,
      args: ['prune', 'host/anas-pve', '--keep-last', '2', '--keep-daily', '7', '--output-format', 'json'],
    }])
  })

  it('a prune FAILURE never fails the job — it completes with a warning', async () => {
    await createRepo()
    await createTaskPayload(RETAINED_TASK)
    const mock = mockOf(server)
    mock.addFixture({ command: PBC_CMD, result: { stdout: '', stderr: 'Error: ENOENT: No such file or directory', exitCode: 255 } })
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    // The backup data is safe — the job COMPLETES, carrying the prune problem.
    assert.equal(job.status, 'completed')
    const result = job.result as { status: string, prune?: unknown, warnings?: string[] }
    assert.equal(result.status, 'success')
    assert.equal(result.prune, undefined)
    assert.match(result.warnings![0], /Backup succeeded, but the retention prune did not run/)
    assert.match(result.warnings![0], /group or the namespace/)
  })

  it('a task with NO retention never invokes prune at all', async () => {
    await createRepo()
    await createTask()
    const mock = mockOf(server)
    mock.addFixture({ command: PBC_CMD, result: { stdout: PRUNE_JSON, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.deepEqual(pruneCalls(mock), [])
  })

  it('a FAILED backup never prunes (the job fails, retention is untouched)', async () => {
    await createRepo()
    await createTaskPayload(RETAINED_TASK)
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/prlimit', args: RETAINED_BACKUP_ARGS, result: { stdout: '', stderr: 'Error: no such datastore \'store1\'', exitCode: 255 } })
    mock.addFixture({ command: PBC_CMD, result: { stdout: PRUNE_JSON, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'failed')
    assert.deepEqual(pruneCalls(mock), [])
  })

  it('a SKIPPED run never prunes (nothing new landed)', async () => {
    await createRepo()
    await createTaskPayload(RETAINED_TASK)
    const mock = mockOf(server)
    // The benign 1-second collision — the same shape a cadence skip takes: a
    // run that backed nothing up must not touch retention.
    mock.addFixture({ command: '/usr/bin/prlimit', args: RETAINED_BACKUP_ARGS, result: { stdout: '', stderr: 'Error: backup timestamp is older than last backup.', exitCode: 255 } })
    mock.addFixture({ command: PBC_CMD, result: { stdout: PRUNE_JSON, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { status: string }).status, 'skipped')
    assert.deepEqual(pruneCalls(mock), [])
  })

  it('POST /backup/tasks rejects a zero or negative keep', async () => {
    await createRepo()
    for (const retention of [{ keepLast: 0 }, { keepDaily: -1 }, { keepWeekly: 1.5 }]) {
      const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: { ...TASK, name: 'bad-keep', retention } })
      assert.equal(res.statusCode, 400, JSON.stringify(retention))
    }
  })

  it('an all-blank retention is stored as NO retention (never an empty policy)', async () => {
    await createRepo()
    await createTaskPayload({ ...TASK, name: 'blank-keep', retention: {} })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/blank-keep', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.equal(data.task.retention, undefined)
    assert.ok(!data.unit.includes('retention'))
  })

  it('prune-preview dry-runs the SAVED task and returns the keep/remove list', async () => {
    await createRepo()
    await createTaskPayload(RETAINED_TASK)
    const mock = mockOf(server)
    mock.addFixture({ command: PBC_CMD, result: { stdout: PRUNE_JSON, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/prune-preview', headers: JSON_HEADERS, payload: {} })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { verdict: string, result?: { kept: number, removed: number, dryRun: boolean, snapshots: unknown[] } } }
    assert.equal(data.verdict, 'ok')
    assert.equal(data.result!.kept, 2)
    assert.equal(data.result!.removed, 1)
    assert.equal(data.result!.dryRun, true)
    assert.equal(data.result!.snapshots.length, 3)
    // Non-mutating: --dry-run is always present on the preview path.
    assert.ok(pruneCalls(mock)[0].args.includes('--dry-run'))
  })

  it('prune-preview accepts an INLINE spec, so an unsaved task can be previewed', async () => {
    await createRepo()
    const mock = mockOf(server)
    mock.addFixture({ command: PBC_CMD, result: { stdout: PRUNE_JSON, stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/not-saved-yet/prune-preview',
      headers: JSON_HEADERS,
      payload: { repository: 'pbs-main', backupId: 'pictures', namespace: 'anastest', retention: { keepMonthly: 3 } },
    })
    assert.equal(res.statusCode, 200)
    assert.equal((res.json() as { data: { verdict: string } }).data.verdict, 'ok')
    assert.deepEqual(pruneCalls(mock)[0].args, [
      'prune',
      'host/pictures',
      '--ns',
      'anastest',
      '--keep-monthly',
      '3',
      '--dry-run',
      '--output-format',
      'json',
    ])
  })

  it('prune-preview verdicts: ENOENT is honestly "group or namespace"; no privilege is named', async () => {
    await createRepo()
    await createTaskPayload(RETAINED_TASK)
    const mock = mockOf(server)
    mock.addFixture({ command: PBC_CMD, results: [
      { stdout: '', stderr: 'Error: ENOENT: No such file or directory', exitCode: 255 },
      { stdout: '', stderr: 'Error: permission check failed - missing Datastore.Modify|Datastore.Prune on /datastore/store1/anastest', exitCode: 255 },
    ] })
    const first = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/prune-preview', headers: JSON_HEADERS, payload: {} })
    const firstData = (first.json() as { data: { verdict: string, detail: string } }).data
    assert.equal(firstData.verdict, 'not-found')
    assert.match(firstData.detail, /group or the namespace/)

    const second = await server.inject({ method: 'POST', url: '/v1/backup/tasks/retained/prune-preview', headers: JSON_HEADERS, payload: {} })
    const secondData = (second.json() as { data: { verdict: string, detail: string } }).data
    assert.equal(secondData.verdict, 'permission')
    assert.match(secondData.detail, /Datastore\.Prune/)
  })

  it('prune-preview without any keep is a 400 (a keep-all prune is never run)', async () => {
    await createRepo()
    await createTask()
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/prune-preview', headers: JSON_HEADERS, payload: {} })
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /at least one retention keep/)
  })

  it('DELETE /backup/repos refuses (409) while a task references it', async () => {
    await createRepo()
    await createTask()
    const res = await server.inject({ method: 'DELETE', url: '/v1/backup/repos/pbs-main?expectedVersion=1', headers: IDENTITY })
    assert.equal(res.statusCode, 409)
    assert.match((res.json() as { error: { message: string } }).error.message, /still used by backup task/)
  })

  it('DELETE /backup/tasks removes the units (202) and the task disappears', async () => {
    await createRepo()
    await createTask()
    const del = await server.inject({ method: 'DELETE', url: '/v1/backup/tasks/nightly-etc', headers: IDENTITY })
    assert.equal(del.statusCode, 202)
    await waitForJob(server, await jobIdFrom(del))
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    assert.equal((res.json() as { data: unknown[] }).data.length, 0)
  })

  it('a mutation without identity headers is rejected', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: { 'content-type': 'application/json' }, payload: { repo: REPO, expectedVersion: 0 } })
    assert.ok(res.statusCode === 401 || res.statusCode === 403)
  })

  // ---- Tier 1: PVE-defined repositories (Epic 16.8) ----------------------

  it('GET /backup/repos surfaces the PVE storage as a hands-off pve:<id> repo', async () => {
    await createRepo() // a tier-2 repo, so both tiers appear together
    const res = await server.inject({ method: 'GET', url: '/v1/backup/repos', headers: IDENTITY })
    const { data } = res.json() as { data: { version: number, repos: BackupRepoResponse[] } }
    assert.equal(data.version, 1) // registry version is unaffected by tier-1
    const pve = data.repos.find(r => r.source === 'pve')!
    assert.ok(pve, 'expected a source:pve repo')
    assert.equal(pve.name, 'pve:anastest-pw')
    assert.equal(pve.host, '127.0.0.1')
    assert.equal(pve.datastore, 'anastest-store')
    assert.equal(pve.namespace, 'anastest')
    assert.equal(pve.authType, 'password') // inferred: username has no ! suffix
    assert.equal(pve.username, 'root@pam')
    assert.equal(pve.credentialsSet, true) // the .pw file exists
    assert.equal('secret' in pve, false) // never returned
    // the registered repo is still there and marked source:anas
    assert.ok(data.repos.some(r => r.name === 'pbs-main' && r.source === 'anas'))
  })

  it('PUT /backup/repos/pve:<id> is a 400 hands-off refusal', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/backup/repos/pve:anastest-pw',
      headers: JSON_HEADERS,
      payload: { repo: { ...REPO, name: 'anastest-pw' }, expectedVersion: 0 },
    })
    assert.equal(res.statusCode, 400)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'PVE_MANAGED')
  })

  it('DELETE /backup/repos/pve:<id> is a 400 hands-off refusal', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/v1/backup/repos/pve:anastest-pw?expectedVersion=0', headers: IDENTITY })
    assert.equal(res.statusCode, 400)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'PVE_MANAGED')
  })

  it('POST /backup/tasks accepts a pve:<id> repository and joins its datastore', async () => {
    const pveTask = { ...TASK, name: 'pve-nightly', repository: 'pve:anastest-pw' }
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: pveTask })
    assert.equal(res.statusCode, 202)
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')
    const list = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = list.json() as { data: BackupTaskEntry[] }
    const entry = data.find(e => e.task.name === 'pve-nightly')!
    assert.equal(entry.task.repository, 'pve:anastest-pw')
    assert.equal(entry.task.datastore, 'anastest-store') // joined from the PVE storage
  })

  it('POST /backup/repos/test resolves a pve:<id> repo (404 only when it does not exist)', async () => {
    const ok = await server.inject({ method: 'POST', url: '/v1/backup/repos/test', headers: JSON_HEADERS, payload: { name: 'pve:anastest-pw' } })
    assert.equal(ok.statusCode, 200) // resolved (a real stage verdict, not a 404)
    assert.ok((ok.json() as { data: { stage: string } }).data.stage)
    const missing = await server.inject({ method: 'POST', url: '/v1/backup/repos/test', headers: JSON_HEADERS, payload: { name: 'pve:nope' } })
    assert.equal(missing.statusCode, 404)
  })

  it('POST /backup/repos/test accepts a namespace OVERRIDE with the { name } form (Fix 2)', async () => {
    await createRepo()
    // The wizard verifies the TASK's effective namespace against a REGISTERED
    // repo via the { name } form + a `namespace` override. Assert the endpoint
    // accepts that shape and returns a staged verdict (not a 400/404). The daemon
    // does its OWN dns/tcp/tls before pbc, so against a non-listening 127.0.0.1
    // this short-circuits at 'tcp' — the end-to-end 'namespace' verdict is
    // live-proven on the stunt node's real PBS. This guards the wiring: the
    // override is a first-class field on the { name } path, no host required.
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/repos/test',
      headers: JSON_HEADERS,
      payload: { name: 'pbs-main', namespace: 'task-ns' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { stage: string } }
    assert.ok(data.stage) // a real staged verdict came back
  })

  it('POST /run { direct:true } resolves the .pw secret at exec and completes', async () => {
    const pveTask = { ...TASK, name: 'pve-run', repository: 'pve:anastest-pw' }
    const create = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: pveTask })
    await waitForJob(server, await jobIdFrom(create))
    // The direct path is the unit's own exec — it reads the .pw secret at run time.
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/pve-run/run', headers: JSON_HEADERS, payload: { direct: true } })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { status: string }).status, 'success')
  })

  // ==========================================================================
  //  Cadence (16.10) — structured schedules end to end
  // ==========================================================================

  /** Make the daemon see this run as a TIMER fire (see classifyTrigger). */
  function scheduleTrigger(name: string, when: Date): void {
    const stamp = when.toUTCString()
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/systemctl', args: ['show', `anas-backup-${name}.timer`, '-p', 'LastTriggerUSec'], result: { stdout: `LastTriggerUSec=${stamp}\n`, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemctl', args: ['show', `anas-backup-${name}.service`, '-p', 'InactiveExitTimestamp'], result: { stdout: `InactiveExitTimestamp=${stamp}\n`, stderr: '', exitCode: 0 } })
  }

  /** The ISO week this test process is in — used to pick an on/off week fire. */
  function weekParity(d: Date): 'even' | 'odd' {
    return isoWeekParity(d)
  }

  const CADENCE_TASK = {
    name: 'pictures',
    repository: 'pbs-main',
    backupId: 'pictures',
    archives: [{ name: 'pictures', path: '/srv/pictures', excludes: [] }],
    changeDetectionMode: 'default',
    enabled: true,
  }

  it('POST /backup/tasks with a cadence GENERATES the OnCalendar and validates it with systemd', async () => {
    await createRepo()
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      // No `schedule` at all: the UI sends the cadence and the daemon derives the
      // expression — the generator lives in exactly one place.
      payload: { ...CADENCE_TASK, cadence: { kind: 'weekly', days: ['Thu', 'Tue'], time: '02:00' } },
    })
    assert.equal(res.statusCode, 202)
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')
    // systemd is the authority on the GENERATED expression too, not just typed ones.
    assert.ok(mock.calls.some(c => c.command === '/usr/bin/systemd-analyze'
      && c.args[0] === 'calendar' && c.args[1] === 'Tue,Thu 02:00'))

    const detail = await server.inject({ method: 'GET', url: '/v1/backup/tasks/pictures', headers: IDENTITY })
    const { data } = detail.json() as { data: BackupTaskDetail }
    assert.equal(data.task.schedule, 'Tue,Thu 02:00')
    assert.deepEqual(data.task.cadence, { kind: 'weekly', days: ['Tue', 'Thu'], time: '02:00' })
    assert.match(data.timer, /OnCalendar=Tue,Thu 02:00/)
    assert.match(data.unit, /SuccessExitStatus=75/)
  })

  it('an invalid cadence is a 400 before anything is written', async () => {
    await createRepo()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      // biweekly without an explicit parity — the phase is never guessed.
      payload: { ...CADENCE_TASK, cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00' } },
    })
    assert.equal(res.statusCode, 400)
  })

  it('a biweekly OFF-WEEK scheduled fire completes as a visible skip — no pbc, no failure', async () => {
    await createRepo()
    const now = new Date()
    // Configure the phase we are NOT in, so this fire is deliberately an off week.
    const parity = weekParity(now) === 'even' ? 'odd' : 'even'
    const create = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: { ...CADENCE_TASK, cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00', parity } },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(create))).status, 'completed')

    scheduleTrigger('pictures', now)
    // A successful run 7 days ago: within one period, so the heal must NOT fire.
    const mock = mockOf(server)
    const lastSuccess = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString().replace('.000Z', '+0000')
    mock.addFixture({
      command: '/usr/bin/journalctl',
      args: ['-u', 'anas-backup-pictures.service', '-n', '200', '-o', 'short-iso', '--no-pager'],
      result: { stdout: `${lastSuccess} pve anas-backup-pictures[900]: {"task":"pictures","result":{"status":"success","archives":[]}}`, stderr: '', exitCode: 0 },
    })
    mock.calls.length = 0

    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/pictures/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    // A skip is a COMPLETED job with its own status — not a failure, and not a
    // success that pretends a backup happened.
    assert.equal(job.status, 'completed')
    const result = job.result as { status: string, reason: string }
    assert.equal(result.status, 'skipped-off-week')
    assert.match(result.reason, /off week/)
    assert.equal(mock.calls.some(c => c.command === '/usr/bin/prlimit'), false) // pbc never ran
  })

  it('an ON-WEEK scheduled fire of the same task backs up normally', async () => {
    await createRepo()
    const now = new Date()
    const parity = weekParity(now)
    const create = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: { ...CADENCE_TASK, cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00', parity } },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(create))).status, 'completed')
    scheduleTrigger('pictures', now)

    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/pictures/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { status: string }).status, 'success')
  })

  it('Run Now bypasses the gate: an off-week task started by hand still backs up', async () => {
    await createRepo()
    const now = new Date()
    const parity = weekParity(now) === 'even' ? 'odd' : 'even'
    const create = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: { ...CADENCE_TASK, cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00', parity } },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(create))).status, 'completed')
    // The timer last fired 8 hours ago; THIS run started now → started by hand.
    scheduleTrigger('pictures', new Date(now.getTime() - 8 * 3600_000))

    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/pictures/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { status: string }).status, 'success')
  })

  it('a heal runs an off-week fire when a full period passed with no success', async () => {
    await createRepo()
    const now = new Date()
    const parity = weekParity(now) === 'even' ? 'odd' : 'even'
    const create = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: { ...CADENCE_TASK, cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00', parity } },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(create))).status, 'completed')
    scheduleTrigger('pictures', now)
    // Last success 15 days ago — an on-week fire was missed or failed.
    const mock = mockOf(server)
    const lastSuccess = new Date(now.getTime() - 15 * 24 * 3600_000).toISOString().replace('.000Z', '+0000')
    mock.addFixture({
      command: '/usr/bin/journalctl',
      args: ['-u', 'anas-backup-pictures.service', '-n', '200', '-o', 'short-iso', '--no-pager'],
      result: { stdout: `${lastSuccess} pve anas-backup-pictures[900]: {"task":"pictures","result":{"status":"success","archives":[]}}`, stderr: '', exitCode: 0 },
    })

    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/pictures/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { status: string }).status, 'success')
  })

  it('a pre-16.10 raw-schedule task is untouched end to end', async () => {
    await createRepo()
    await createTask() // TASK carries `schedule` and no cadence
    const detail = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly-etc', headers: IDENTITY })
    const { data } = detail.json() as { data: BackupTaskDetail }
    assert.equal(data.task.schedule, '*-*-* 02:00:00')
    assert.equal(data.task.cadence, undefined)
    assert.match(data.timer, /OnCalendar=\*-\*-\* 02:00:00/)
    // Its scheduled fire is never gated — no cadence, nothing to gate.
    scheduleTrigger('nightly-etc', new Date())
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal((job.result as { status: string }).status, 'success')
  })

  // ==========================================================================
  //  Run notifications (16.12) — the emission matrix at the ONE emission point
  // ==========================================================================
  // Every real run (timer fire AND UI Run Now) reaches the daemon's run job
  // through the task's own unit, so this branch is where the notification is
  // emitted — one site, both triggers.

  const PERL = '/usr/bin/perl'

  /** Every PVE notification the run emitted (severity, title, body). */
  function notifications(mock: MockExecutor): { severity: string, title: string, body: string, perl: string }[] {
    return mock.calls
      .filter(c => c.command === PERL)
      .map(c => ({ perl: c.args[1], severity: c.args[2], title: c.args[3], body: c.args[4] }))
  }

  function allowNotify(exitCode = 0): MockExecutor {
    const mock = mockOf(server)
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: exitCode ? 'no target configured' : '', exitCode } })
    return mock
  }

  it('a successful run notifies `info` with the archive lines in the body (mode: always)', async () => {
    await createRepo()
    await createTask() // no `notify` in the payload → the schema default, always
    const mock = allowNotify()
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'info')
    assert.match(sent[0].title, /backup 'nightly-etc' succeeded/)
    // The detail that replaces the cron mail: target, group, and pbc's own lines.
    assert.match(sent[0].body, /Repository:\s+pbs-main:store1/)
    assert.match(sent[0].body, /Backup ID:\s+host\/anas-pve/)
    assert.ok(sent[0].body.includes('etc.pxar: had to backup 82.957 KiB'))
    assert.match(sent[0].body, /Duration:\s+0\.12s/)
    // Backup events carry their own template + matcher type.
    assert.ok(sent[0].perl.includes('anas-backup'))
  })

  it('a successful run of an ON-FAILURE task is silent', async () => {
    await createRepo()
    await createTaskPayload({ ...TASK, name: 'quiet', notify: 'on-failure' })
    const mock = allowNotify()
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/quiet/run', headers: JSON_HEADERS, payload: { direct: true } })
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')
    assert.deepEqual(notifications(mock), [])
  })

  it('completed-with-warnings notifies `warning` in BOTH modes, warnings verbatim', async () => {
    await createRepo()
    for (const notify of ['always', 'on-failure'] as const) {
      const name = `warned-${notify}`
      await createTaskPayload({ ...RETAINED_TASK, name, notify })
      const mock = allowNotify()
      // The prune fails AFTER a good backup (16.11) — the job completes carrying it.
      mock.addFixture({ command: PBC_CMD, result: { stdout: '', stderr: 'Error: ENOENT: No such file or directory', exitCode: 255 } })
      mock.calls.length = 0
      const res = await server.inject({ method: 'POST', url: `/v1/backup/tasks/${name}/run`, headers: JSON_HEADERS, payload: { direct: true } })
      const job = await waitForJob(server, await jobIdFrom(res))
      assert.equal(job.status, 'completed', notify)
      const sent = notifications(mock)
      assert.equal(sent.length, 1, notify)
      assert.equal(sent[0].severity, 'warning', notify)
      assert.match(sent[0].title, /completed with warnings/)
      assert.match(sent[0].body, /Backup succeeded, but the retention prune did not run/)
      // The backup itself still reports its archives — the operator sees both.
      assert.ok(sent[0].body.includes('etc.pxar: had to backup 82.957 KiB'))
      await server.inject({ method: 'DELETE', url: `/v1/backup/tasks/${name}`, headers: JSON_HEADERS })
    }
  })

  it('a FAILED run notifies `error` in BOTH modes, carrying the real error', async () => {
    await createRepo()
    for (const notify of ['always', 'on-failure'] as const) {
      const name = `failing-${notify}`
      await createTaskPayload({ ...TASK, name, notify })
      const mock = allowNotify()
      mock.addFixture({ command: '/usr/bin/prlimit', args: RETAINED_BACKUP_ARGS, result: { stdout: '', stderr: 'Error: no such datastore \'store1\'', exitCode: 255 } })
      mock.calls.length = 0
      const res = await server.inject({ method: 'POST', url: `/v1/backup/tasks/${name}/run`, headers: JSON_HEADERS, payload: { direct: true } })
      const job = await waitForJob(server, await jobIdFrom(res))
      assert.equal(job.status, 'failed', notify)
      const sent = notifications(mock)
      assert.equal(sent.length, 1, notify)
      assert.equal(sent[0].severity, 'error', notify)
      assert.match(sent[0].title, /FAILED/)
      assert.ok(sent[0].body.includes('Error: no such datastore \'store1\''))
      await server.inject({ method: 'DELETE', url: `/v1/backup/tasks/${name}`, headers: JSON_HEADERS })
    }
  })

  it('an off-week SKIP notifies in NEITHER mode (the gate produced no run)', async () => {
    await createRepo()
    const now = new Date()
    const parity = weekParity(now) === 'even' ? 'odd' : 'even'
    for (const notify of ['always', 'on-failure'] as const) {
      const name = `skipper-${notify}`
      const create = await server.inject({
        method: 'POST',
        url: '/v1/backup/tasks',
        headers: JSON_HEADERS,
        payload: { ...CADENCE_TASK, name, notify, cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00', parity } },
      })
      assert.equal((await waitForJob(server, await jobIdFrom(create))).status, 'completed')
      scheduleTrigger(name, now)
      const mock = allowNotify()
      // A success 7 days ago: inside one period, so the heal must not fire.
      const lastSuccess = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString().replace('.000Z', '+0000')
      mock.addFixture({
        command: '/usr/bin/journalctl',
        args: ['-u', `anas-backup-${name}.service`, '-n', '200', '-o', 'short-iso', '--no-pager'],
        result: { stdout: `${lastSuccess} pve anas-backup-${name}[900]: {"task":"${name}","result":{"status":"success","archives":[]}}`, stderr: '', exitCode: 0 },
      })
      mock.calls.length = 0
      const res = await server.inject({ method: 'POST', url: `/v1/backup/tasks/${name}/run`, headers: JSON_HEADERS, payload: { direct: true } })
      const job = await waitForJob(server, await jobIdFrom(res))
      assert.equal((job.result as { status: string }).status, 'skipped-off-week', notify)
      assert.deepEqual(notifications(mock), [], notify)
    }
  })

  it('a notification that cannot be delivered never fails the run job (best-effort)', async () => {
    await createRepo()
    await createTask()
    const mock = allowNotify(255) // perl runs, PVE has no target → non-zero exit
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: { direct: true } })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { status: string }).status, 'success')
    assert.equal(notifications(mock).length, 1)
  })

  it('the notify mode rides the unit JSON and round-trips through an edit', async () => {
    await createRepo()
    await createTaskPayload({ ...TASK, name: 'moody', notify: 'on-failure' })
    const first = await server.inject({ method: 'GET', url: '/v1/backup/tasks/moody', headers: IDENTITY })
    const stored = (first.json() as { data: BackupTaskDetail }).data
    assert.equal(stored.task.notify, 'on-failure')
    assert.match(stored.unit, /"notify":"on-failure"/)
    // Editing back to always rewrites the same single source of truth.
    const edit = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/moody', headers: JSON_HEADERS, payload: { ...TASK, name: 'moody', notify: 'always' } })
    assert.equal((await waitForJob(server, await jobIdFrom(edit))).status, 'completed')
    const second = await server.inject({ method: 'GET', url: '/v1/backup/tasks/moody', headers: IDENTITY })
    assert.equal((second.json() as { data: BackupTaskDetail }).data.task.notify, 'always')
  })

  it('a task saved with no notify mode at all defaults to always (pre-16.12 shape)', async () => {
    await createRepo()
    await createTask()
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    assert.equal(data[0].task.notify, 'always')
  })
})
