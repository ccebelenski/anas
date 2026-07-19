import type { BackupTaskDetail, BackupTaskEntry, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

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

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

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
    assert.equal(data.repos.length, 1)
    const repo = data.repos[0]
    assert.equal(repo.name, 'pbs-main')
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

  it('POST /backup/tasks/:name/run runs pbc and completes with parsed progress', async () => {
    await createRepo()
    await createTask()
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/nightly-etc/run', headers: JSON_HEADERS, payload: {} })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, await jobIdFrom(res))
    assert.equal(job.status, 'completed')
    const result = job.result as { status: string, archives: string[] }
    assert.equal(result.status, 'success')
    assert.ok(result.archives.some(l => l.startsWith('etc.pxar:')))
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
})
