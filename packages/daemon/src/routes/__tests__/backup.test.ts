import type { BackupRepoResponse, BackupTaskDetail, BackupTaskEntry, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

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
})
