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

  // ---- backup2.2: nested filesystems -------------------------------------
  //
  // The mock server already serves the mounts family's own `findmnt --json`
  // tree, which carries a REAL nested pair: the pool `/mnttest` with the child
  // dataset `/mnttest/data`. The walk is stubbed on its EXACT argv, so these
  // tests also pin the command the daemon runs.

  /** The exact `timeout <s> find …` argv the scan builds for a source path. */
  function walkArgs(path: string, timeoutSeconds = 20, maxDepth = 12): string[] {
    return [
      String(timeoutSeconds),
      '/usr/bin/find',
      '-P',
      path,
      '-xdev',
      '-maxdepth',
      String(maxDepth),
      '(',
      '-name',
      '.zfs',
      ')',
      '-prune',
      '-o',
      '-type',
      'd',
      '-printf',
      '%D\\t%p\\n',
    ]
  }

  /**
   * The walk result for `/mnttest`: the pool root (dev 66) plus its child
   * dataset (dev 67) — the shape the real capture produced for `/gtbackup`.
   * Registered on the EXACT argv so it beats the mock server's generic
   * `timeout … stat -f` liveness fixture.
   */
  function mockNestedWalk(timeoutSeconds = 20): void {
    mockOf(server).addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/mnttest', timeoutSeconds),
      result: { stdout: '66\t/mnttest\n66\t/mnttest/sub\n67\t/mnttest/data\n', stderr: '', exitCode: 0 },
    })
  }

  /**
   * The DESCENT an `all` choice needs: a second walk rooted at the boundary the
   * first one found, one depth level shallower (the budget is shared). Here
   * `/mnttest/data` has a further boundary of its own — the nested-inside-nested
   * case `--include-dev` must be told about explicitly.
   */
  function mockNestedDescent(timeoutSeconds = 20): void {
    const mock = mockOf(server)
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/mnttest/data', timeoutSeconds, 11),
      result: { stdout: '67\t/mnttest/data\n68\t/mnttest/data/deep\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/mnttest/data/deep', timeoutSeconds, 10),
      result: { stdout: '68\t/mnttest/data/deep\n', stderr: '', exitCode: 0 },
    })
  }

  const NESTED_TASK = {
    ...TASK,
    name: 'pool-task',
    archives: [{ name: 'pool', path: '/mnttest', excludes: [] }],
  }

  it('preview-nested scans a bare path and never contacts PBS (backup2.2)', async () => {
    mockNestedWalk()
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/preview-nested',
      headers: JSON_HEADERS,
      payload: { path: '/mnttest' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { archives: Array<{ path: string, includeNested: unknown, nested: Array<Record<string, unknown>> }> } }
    assert.equal(data.archives.length, 1)
    assert.equal(data.archives[0].path, '/mnttest')
    assert.equal(data.archives[0].includeNested, 'none')
    assert.deepEqual(data.archives[0].nested, [{
      path: '/mnttest/data',
      relativePath: 'data',
      kind: 'dataset',
      source: 'mnttest/data',
      fstype: 'zfs',
      included: false,
    }])
    // The one PBS-contact rule: this endpoint never calls the client at all.
    assert.ok(!mock.calls.some(c => c.command === PBC_CMD || c.command === '/usr/bin/prlimit'))
    // And the walk really is the bounded, symlink-free, directory-only form.
    const walk = mock.calls.find(c => c.command === '/usr/bin/timeout' && c.args.includes('-xdev'))
    assert.deepEqual(walk?.args, walkArgs('/mnttest'))
  })

  it('preview-nested reports coverage per archive, against each own choice', async () => {
    mockNestedWalk()
    mockNestedDescent()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/preview-nested',
      headers: JSON_HEADERS,
      payload: { archives: [
        { name: 'none', path: '/mnttest' },
        { name: 'all', path: '/mnttest', includeNested: 'all' },
        { name: 'listed', path: '/mnttest', includeNested: ['/mnttest/data'] },
      ] },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { archives: Array<{ archive: string, nested: Array<{ included: boolean }> }> } }
    assert.deepEqual(data.archives.map(a => a.archive), ['none', 'all', 'listed'])
    assert.equal(data.archives[0].nested[0].included, false)
    assert.equal(data.archives[1].nested[0].included, true)
    assert.equal(data.archives[2].nested[0].included, true)
    // `all` DESCENDED: the wizard shows the nested-inside-nested one too, which
    // `none` and a one-path list never needed to look for.
    assert.equal(data.archives[0].nested.length, 1)
    assert.equal(data.archives[2].nested.length, 1)
  })

  it('preview-nested with neither a path nor archives is a 400', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/preview-nested', headers: JSON_HEADERS, payload: {} })
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /Send a path/)
  })

  it('the task detail reports what is nested under each source and whether it is covered', async () => {
    await createRepo()
    await createTaskPayload(NESTED_TASK)
    mockNestedWalk()
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/pool-task', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.ok(data.nested, 'the detail carries the boundary scan')
    assert.equal(data.nested!.length, 1)
    assert.equal(data.nested![0].archive, 'pool')
    assert.equal(data.nested![0].nested[0].path, '/mnttest/data')
    assert.equal(data.nested![0].nested[0].kind, 'dataset')
    assert.equal(data.nested![0].nested[0].included, false)
  })

  it('a task that CHOOSES a nested path stores it and reports it covered', async () => {
    await createRepo()
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'pool-chosen',
      archives: [{ name: 'pool', path: '/mnttest', excludes: [], includeNested: ['/mnttest/data'] }],
    })
    mockNestedWalk()
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/pool-chosen', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.deepEqual(data.task.archives[0].includeNested, ['/mnttest/data'])
    assert.ok(data.unit.includes('includeNested'))
    assert.equal(data.nested![0].nested[0].included, true)
  })

  it('a task with NO nested choice stores no such key (the untouched-edit rule)', async () => {
    await createRepo()
    await createTaskPayload({ ...TASK, name: 'no-nested' })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/no-nested', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.equal(data.task.archives[0].includeNested, undefined)
    assert.ok(!data.unit.includes('includeNested'))
  })

  it('an includeNested path outside its archive is a 400 at the route boundary', async () => {
    await createRepo()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: { ...TASK, name: 'bad-nested', archives: [{ name: 'etc', path: '/etc', excludes: [], includeNested: ['/srv/other'] }] },
    })
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /not under the archive path/)
  })

  it('a run WARNS about every nested filesystem its choice omits (never silent)', async () => {
    await createRepo()
    await createTaskPayload(NESTED_TASK)
    // The run path gives the walk a longer budget than the wizard's.
    mockNestedWalk(60)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/pool-task/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    const result = job.result as { warnings?: string[], nested?: unknown[] }
    const omitted = result.warnings?.some(w => w.includes('/mnttest/data') && w.includes('empty directory'))
    assert.ok(omitted, JSON.stringify(result.warnings))
    assert.equal(result.nested?.length, 1)
  })

  it('an `all` archive reaches pbc as explicit --include-dev flags, never --all-file-systems', async () => {
    await createRepo()
    // backup2.3 note: the source is deliberately `/srv` — a plain directory on
    // the ext4 root, i.e. a LIVE archive. `--include-dev` is the contract for a
    // live root; a SNAPSHOTTABLE root (ZFS/AHR) expands into one archive per
    // nested filesystem instead, which the backup2.3 suite covers. Using a ZFS
    // path here would be testing the wrong branch.
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'pool-all',
      archives: [
        { name: 'pool', path: '/srv', excludes: [], includeNested: 'all' },
        // A second archive in the SAME invocation that asked for nothing: the
        // whole reason `all` is resolved per archive instead of being a flag.
        { name: 'etc', path: '/etc', excludes: [] },
      ],
    })
    const mock = mockOf(server)
    // /srv (on `/`, ext4) with a boundary and a nested-inside-nested boundary.
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/srv', 60),
      result: { stdout: '2049\t/srv\n2049\t/srv/sub\n3000\t/srv/data\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/srv/data', 60, 11),
      result: { stdout: '3000\t/srv/data\n3001\t/srv/data/deep\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/srv/data/deep', 60, 10),
      result: { stdout: '3001\t/srv/data/deep\n', stderr: '', exitCode: 0 },
    })
    // /etc has no boundary of its own in this tree.
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/etc', 60),
      result: { stdout: '2049\t/etc\n', stderr: '', exitCode: 0 },
    })
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/pool-all/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')

    const pbc = mock.calls.find(c => c.command === '/usr/bin/prlimit')
    assert.ok(pbc, 'pbc ran')
    assert.ok(!pbc.args.includes('--all-file-systems'), pbc.args.join(' '))
    const devs: string[] = []
    pbc.args.forEach((a, i) => {
      if (a === '--include-dev')
        devs.push(pbc.args[i + 1])
    })
    // Both boundaries under /srv, and NOTHING for the other archive.
    assert.deepEqual(devs, ['/srv/data', '/srv/data/deep'])

    // The run says on the record exactly which boundaries it crossed.
    const result = job.result as { includedNested?: Record<string, string[]>, warnings?: string[] }
    assert.deepEqual(result.includedNested, { pool: ['/srv/data', '/srv/data/deep'] })
    // Nothing was omitted, so no omission warning was raised.
    assert.ok(!(result.warnings ?? []).some(w => w.includes('empty directory')), JSON.stringify(result.warnings))
  })

  it('an `all` archive whose scan FAILS crosses nothing and says why (no silent partial)', async () => {
    await createRepo()
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'pool-all-timeout',
      archives: [{ name: 'pool', path: '/mnttest', excludes: [], includeNested: 'all' }],
    })
    // The first walk TIMES OUT after reporting one boundary: a partial answer.
    const mock = mockOf(server)
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/mnttest', 60),
      result: { stdout: '66\t/mnttest\n67\t/mnttest/data\n', stderr: '', exitCode: 124 },
    })
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/pool-all-timeout/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed', 'a failed scan never fails the backup')

    const pbc = mock.calls.find(c => c.command === '/usr/bin/prlimit')
    assert.ok(pbc && !pbc.args.includes('--include-dev'), pbc?.args.join(' '))
    assert.ok(!pbc.args.includes('--all-file-systems'))
    const result = job.result as { includedNested?: unknown, warnings?: string[] }
    assert.equal(result.includedNested, undefined)
    const said = (result.warnings ?? []).some(w => w.includes('\'all\' could not be resolved'))
    assert.ok(said, JSON.stringify(result.warnings))
  })

  // ---- backup2.3: snapshot-consistent runs --------------------------------
  //
  // `/mnttest` is a ZFS dataset in the mock findmnt tree, with the child dataset
  // `/mnttest/data` under it — so a run of a task rooted there is snapshot-mode,
  // and the child expands into a second archive.

  const ZFS_BIN = '/usr/sbin/zfs'

  /**
   * Every `zfs` verb succeeds; the sweep's snapshot list is `listStdout`
   * (empty = nothing stale). The list is registered on its EXACT argv because
   * the mock server carries its own command-only `/usr/sbin/zfs` fixture and a
   * command-only match registered earlier would otherwise win.
   */
  function mockZfs(listStdout = ''): void {
    const mock = mockOf(server)
    mock.addFixture({
      command: ZFS_BIN,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name', '-r', 'mnttest'],
      result: { stdout: listStdout, stderr: '', exitCode: 0 },
    })
    mock.addFixture({ command: ZFS_BIN, result: { stdout: '', stderr: '', exitCode: 0 } })
  }

  /** The zfs argv of one verb, in call order. */
  function zfsArgs(mock: MockExecutor, verb: string): string[][] {
    return mock.calls.filter(c => c.command === ZFS_BIN && c.args[0] === verb).map(c => c.args)
  }

  /** The pbc argv of the run (the outer prlimit call). */
  function pbcArgs(mock: MockExecutor): string[] {
    const call = mock.calls.find(c => c.command === '/usr/bin/prlimit')
    assert.ok(call, 'pbc ran')
    return call.args
  }

  /** `<name>.pxar:<root>` tokens, in order. */
  function archiveTokens(args: string[]): string[] {
    return args.filter(a => a.includes('.pxar:'))
  }

  it('a ZFS source is backed up FROM a recursive transient snapshot, and the snapshot is destroyed', async () => {
    await createRepo()
    await createTaskPayload({ ...NESTED_TASK, name: 'snap-zfs' })
    mockNestedWalk(60)
    mockZfs()
    const mock = mockOf(server)
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/snap-zfs/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')

    const snapshots = zfsArgs(mock, 'snapshot')
    assert.equal(snapshots.length, 1, JSON.stringify(snapshots))
    // ALWAYS -r: a child dataset is a separate filesystem and needs its own label.
    assert.equal(snapshots[0][1], '-r')
    assert.match(snapshots[0][2], /^mnttest@anas-backup-snap-zfs-\d+$/)
    const label = snapshots[0][2].split('@')[1]

    // Destroyed in the `finally`, recursively, matching how it was taken.
    assert.deepEqual(zfsArgs(mock, 'destroy'), [['destroy', '-r', `mnttest@${label}`]])

    // GT-51: reachable with the default `snapdir=hidden` — no property is set.
    assert.equal(mock.calls.filter(c => c.command === ZFS_BIN && c.args[0] === 'set').length, 0)

    const args = pbcArgs(mock)
    assert.ok(archiveTokens(args).every(tok => tok.includes(`/.zfs/snapshot/${label}`)), args.join(' '))

    const result = job.result as {
      consistency?: { consistency: string, backend?: string, target?: string }[]
      snapshots?: { full: string, recursive?: boolean }[]
      expansion?: { name: string, root: string }[]
    }
    assert.equal(result.consistency?.[0].consistency, 'snapshot')
    assert.equal(result.consistency?.[0].backend, 'zfs')
    assert.equal(result.consistency?.[0].target, 'mnttest')
    assert.deepEqual(result.snapshots?.map(s => s.full), [`mnttest@${label}`])
    assert.equal(result.snapshots?.[0].recursive, true)
    assert.equal(result.expansion?.[0].root, `/mnttest/.zfs/snapshot/${label}`)
  })

  it('the ROOT archive name and the --backup-id are IDENTICAL between live and snapshot mode', async () => {
    // The change-detection identity (GT-47/48): a snapshot-mode run that renamed
    // either would make the next run re-read the whole tree.
    await createRepo()
    const mock = mockOf(server)

    // LIVE run: /etc is on the ext4 root in the mock tree.
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'ident-live',
      archives: [{ name: 'data', path: '/etc', excludes: [] }],
    })
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/etc', 60),
      result: { stdout: '2049\t/etc\n', stderr: '', exitCode: 0 },
    })
    mock.calls.length = 0
    let res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/ident-live/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')
    const liveArgs = pbcArgs(mock)

    // SNAPSHOT run: the same archive NAME and the same backup-id, on ZFS.
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'ident-snap',
      archives: [{ name: 'data', path: '/mnttest', excludes: [] }],
    })
    mockNestedWalk(60)
    mockZfs()
    mock.calls.length = 0
    res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/ident-snap/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')
    const snapArgs = pbcArgs(mock)

    const idOf = (a: string[]): string => a[a.indexOf('--backup-id') + 1]
    assert.equal(idOf(snapArgs), idOf(liveArgs))
    const nameOf = (a: string[]): string => archiveTokens(a)[0].split('.pxar:')[0]
    assert.equal(nameOf(snapArgs), 'data')
    assert.equal(nameOf(liveArgs), 'data')
    // Only the ROOT moved; the name did not.
    assert.ok(archiveTokens(liveArgs)[0].endsWith(':/etc'))
    assert.match(archiveTokens(snapArgs)[0], /:\/mnttest\/\.zfs\/snapshot\//)
  })

  it('an included child dataset expands into its own archive: 1 nested filesystem -> 2 archive roots', async () => {
    await createRepo()
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'snap-expand',
      archives: [{ name: 'pool', path: '/mnttest', excludes: [], includeNested: ['/mnttest/data'] }],
    })
    mockNestedWalk(60)
    mockZfs()
    const mock = mockOf(server)
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/snap-expand/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')

    const args = pbcArgs(mock)
    const label = zfsArgs(mock, 'snapshot')[0][2].split('@')[1]
    assert.deepEqual(archiveTokens(args), [
      `pool.pxar:/mnttest/.zfs/snapshot/${label}`,
      `pool__data.pxar:/mnttest/data/.zfs/snapshot/${label}`,
    ])
    // `--include-dev` is meaningless under a snapshot root — the boundary is an
    // empty directory there, so the child got its OWN archive instead.
    assert.ok(!args.includes('--include-dev'), args.join(' '))
    assert.ok(!args.includes('--all-file-systems'))

    const result = job.result as { expansion?: { name: string, from: string, relativePath: string }[] }
    assert.deepEqual(result.expansion?.map(e => [e.name, e.from, e.relativePath]), [
      ['pool', 'pool', ''],
      ['pool__data', 'pool', 'data'],
    ])
  })

  it('a THREE-archive expansion emits one root per archive, deduped excludes, id unchanged', async () => {
    await createRepo()
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'snap-three',
      archives: [
        // Snapshot-mode with one included child → two roots.
        { name: 'pool', path: '/mnttest', excludes: ['/data/tmp', '*.swp'], includeNested: ['/mnttest/data'] },
        // Live archive in the SAME invocation → one root, untouched.
        { name: 'etc', path: '/etc', excludes: ['*.swp'] },
      ],
    })
    mockNestedWalk(60)
    mockZfs()
    const mock = mockOf(server)
    mock.addFixture({
      command: '/usr/bin/timeout',
      args: walkArgs('/etc', 60),
      result: { stdout: '2049\t/etc\n', stderr: '', exitCode: 0 },
    })
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/snap-three/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')

    const args = pbcArgs(mock)
    const label = zfsArgs(mock, 'snapshot')[0][2].split('@')[1]
    assert.deepEqual(archiveTokens(args), [
      `pool.pxar:/mnttest/.zfs/snapshot/${label}`,
      `pool__data.pxar:/mnttest/data/.zfs/snapshot/${label}`,
      'etc.pxar:/etc',
    ])
    // The anchored exclude was REBASED onto the child root it targets; the
    // unanchored one is depth-independent and emitted ONCE for the invocation.
    const excludes: string[] = []
    args.forEach((a, i) => {
      if (a === '--exclude')
        excludes.push(args[i + 1])
    })
    assert.deepEqual(excludes, ['*.swp', '/tmp'])
    // The identity never moves.
    assert.equal(args[args.indexOf('--backup-id') + 1], 'anas-pve')

    const result = job.result as { consistency?: { consistency: string }[] }
    assert.deepEqual(result.consistency?.map(c => c.consistency), ['snapshot', 'live'])
  })

  it('a stale sweep destroys THIS task\'s older transients and nobody else\'s', async () => {
    await createRepo()
    await createTaskPayload({ ...NESTED_TASK, name: 'snap-sweep' })
    mockNestedWalk(60)
    // A previous run of this task died before its `finally`; another task's run
    // may be in flight right now; a schedule snapshot and a manual one are not
    // ours at all.
    mockZfs([
      'mnttest@anas-backup-snap-sweep-1000000000',
      'mnttest@anas-backup-snap-sweep-1000000000__photos',
      'mnttest@anas-backup-other-task-1000000000',
      'mnttest@anas-daily-2026-08-20T020000Z',
      'mnttest@nightly',
      '',
    ].join('\n'))
    const mock = mockOf(server)
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/snap-sweep/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')

    const label = zfsArgs(mock, 'snapshot')[0][2].split('@')[1]
    assert.deepEqual(zfsArgs(mock, 'destroy'), [
      ['destroy', '-r', 'mnttest@anas-backup-snap-sweep-1000000000'],
      ['destroy', '-r', 'mnttest@anas-backup-snap-sweep-1000000000__photos'],
      // and this run's own, in the `finally`
      ['destroy', '-r', `mnttest@${label}`],
    ])
  })

  it('the run notification body carries the Consistency block and the archive roots', async () => {
    await createRepo()
    await createTaskPayload({
      ...NESTED_TASK,
      name: 'snap-notify',
      notify: 'always',
      archives: [{ name: 'pool', path: '/mnttest', excludes: [], includeNested: ['/mnttest/data'] }],
    })
    mockNestedWalk(60)
    mockZfs()
    const mock = mockOf(server)
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/snap-notify/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    assert.equal((await waitForJob(server, await jobIdFrom(res))).status, 'completed')

    const notify = mock.calls.find(c => c.command === '/usr/bin/pvesh' || c.args.some(a => a.includes('Consistency:')))
    assert.ok(notify, `no notification carried the body: ${mock.calls.map(c => c.command).join(' ')}`)
    const body = notify.args.find(a => a.includes('Consistency:')) as string
    assert.match(body, /Consistency:\n {2}pool: snapshot mnttest@anas-backup-snap-notify-\d+/)
    assert.match(body, /Archive roots:/)
    assert.match(body, /pool__data\.pxar <- \/mnttest\/data\/\.zfs\/snapshot\//)
    // The 16.12 ASCII rule still holds for the new block.
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x00-\x7F]/.test(body), body)
  })

  it('preview-nested returns the DERIVED consistency, read-only, on the same scan', async () => {
    mockNestedWalk()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/preview-nested',
      headers: JSON_HEADERS,
      payload: { path: '/mnttest', includeNested: 'none' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as {
      data: { archives: { consistency?: { consistency: string, backend?: string, target?: string, reason: string } }[] }
    }
    const c = data.archives[0].consistency
    assert.equal(c?.consistency, 'snapshot')
    assert.equal(c?.backend, 'zfs')
    assert.equal(c?.target, 'mnttest')
    assert.match(c?.reason ?? '', /recursive snapshot/)
  })

  it('the task detail carries the consistency per archive too', async () => {
    await createRepo()
    await createTaskPayload({ ...NESTED_TASK, name: 'detail-consistency' })
    mockNestedWalk()
    const res = await server.inject({
      method: 'GET',
      url: '/v1/backup/tasks/detail-consistency',
      headers: IDENTITY,
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.equal(data.nested?.[0].consistency?.consistency, 'snapshot')
    assert.equal(data.nested?.[0].consistency?.target, 'mnttest')
  })

  // ---- backup2.4: img archives -------------------------------------------
  //
  // `/mnttest` is the ZFS dataset `mnttest` in the mock findmnt tree, so
  // `/dev/zvol/mnttest/vol1` is a volume on a pool ANAS manages and
  // `/mnttest/images/lun.raw` is an image file on that dataset.

  const IMG_TASK = {
    name: 'nightly-lun',
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives: [{ name: 'lun0', path: '/dev/zvol/mnttest/vol1', excludes: [], kind: 'img' }],
    changeDetectionMode: 'default',
    schedule: '*-*-* 02:00:00',
    enabled: true,
  }

  it('preview-nested answers an img source WITHOUT walking anything', async () => {
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/preview-nested',
      headers: JSON_HEADERS,
      payload: { path: '/dev/zvol/mnttest/vol1', kind: 'img' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as {
      data: { archives: { nested: unknown[], includeNested: string, consistency?: { consistency: string, zvolDevice?: string, target?: string } }[] }
    }
    const scan = data.archives[0]
    assert.deepEqual(scan.nested, [])
    assert.equal(scan.includeNested, 'none')
    // A block image has no tree — the `find` walk never runs for it.
    assert.equal(mock.calls.some(c => c.command === '/usr/bin/timeout'), false)
    // And it still gets its derived consistency: the snapshot DEVICE.
    assert.equal(scan.consistency?.consistency, 'snapshot')
    assert.equal(scan.consistency?.target, 'mnttest/vol1')
    assert.equal(scan.consistency?.zvolDevice, '/dev/zvol/mnttest/vol1')
  })

  it('preview-nested answers an img archive list the same way', async () => {
    mockNestedWalk()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/preview-nested',
      headers: JSON_HEADERS,
      payload: {
        archives: [
          { name: 'pool', path: '/mnttest' },
          { name: 'lun0', path: '/mnttest/images/lun.raw', kind: 'img' },
        ],
      },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as {
      data: { archives: { path: string, nested: unknown[], consistency?: { consistency: string, relativePath?: string } }[] }
    }
    assert.equal(data.archives.length, 2)
    // The pxar row was walked; the image row was not, and reports no boundaries.
    assert.ok((data.archives[0].nested as unknown[]).length > 0)
    assert.deepEqual(data.archives[1].nested, [])
    // An image FILE follows the directory rules: its dataset's snapshot, with
    // the file's own relative path under the snapshot root.
    assert.equal(data.archives[1].consistency?.consistency, 'snapshot')
    assert.equal(data.archives[1].consistency?.relativePath, 'images/lun.raw')
  })

  it('the task detail carries kind and consistency for an img archive', async () => {
    await createRepo()
    await createTaskPayload(IMG_TASK)
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly-lun', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupTaskDetail }
    assert.equal(data.task.archives[0].kind, 'img')
    assert.equal(data.nested?.[0].consistency?.consistency, 'snapshot')
    assert.equal(data.nested?.[0].consistency?.zvolDevice, '/dev/zvol/mnttest/vol1')
    assert.deepEqual(data.nested?.[0].nested, [])
  })

  it('a create with excludes on an img archive is a 400, not a silent drop', async () => {
    await createRepo()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: { ...IMG_TASK, name: 'bad-img', archives: [{ name: 'lun0', path: '/dev/zvol/mnttest/vol1', excludes: ['*.tmp'], kind: 'img' }] },
    })
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /exclude patterns do not apply to an image/)
  })

  it('a direct run of an img task publishes snapdev, reads the snapshot device, and inherits back', async () => {
    await createRepo()
    await createTaskPayload(IMG_TASK)
    const mock = mockOf(server)
    // The sweep list for the VOLUME, and the snapdev property read.
    mock.addFixture({
      command: ZFS_BIN,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name', '-r', 'mnttest/vol1'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: ZFS_BIN,
      args: ['get', '-Hp', '-o', 'name,value,source', 'snapdev', 'mnttest/vol1'],
      result: { stdout: 'mnttest/vol1\thidden\tdefault\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({ command: ZFS_BIN, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/udevadm', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.calls.length = 0

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/nightly-lun/run',
      headers: JSON_HEADERS,
      payload: { direct: true },
    })
    // The snapdev node poll is a real (bounded) ~2 s wait, so this job needs a
    // longer leash than the default one-second one.
    const job = await waitForJob(server, await jobIdFrom(res), 500, 10)
    // The device node does not exist on a test host, so the run fails at the
    // publish step — which is exactly the branch that must still put the
    // property back. The failure names the node, not something unrelated.
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', /never appeared/)
    const verbs = [...zfsArgs(mock, 'set'), ...zfsArgs(mock, 'inherit')]
    assert.deepEqual(verbs, [
      ['set', 'snapdev=visible', 'mnttest/vol1'],
      ['inherit', 'snapdev', 'mnttest/vol1'],
    ])
    // And the transient snapshot the run took is destroyed all the same.
    assert.ok(
      zfsArgs(mock, 'destroy').some(a => a[2]?.startsWith('mnttest/vol1@anas-backup-nightly-lun-')),
      JSON.stringify(zfsArgs(mock, 'destroy')),
    )
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
