import type { BackupTaskEntry, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

/**
 * Story ident.2 (audit #14): a PBS backup group belongs to ONE task. The prune
 * after a run acts on `host/<backupId>` in the task's repository + effective
 * namespace, so two tasks in one group prune each other's snapshots — which is
 * what the old default (the bare hostname, also what a plain host backup of the
 * node writes) produced for every task left at it.
 */

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

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

describe('ident.2 — one PBS group per backup task', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in saved))
      saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backupgroup-'))
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    setEnv('ANAS_NODENAME', 'nas.example.com')
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemd-analyze', result: { stdout: 'Normalized form: *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    const repo = await server.inject({
      method: 'POST',
      url: '/v1/backup/repos',
      headers: JSON_HEADERS,
      payload: {
        expectedVersion: 0,
        repo: { name: 'pbs-main', host: '127.0.0.1', port: 8007, datastore: 'store1', authType: 'token', tokenId: 'root@pam!anas', fingerprint: 'cc:b8:a0', secret: 's' },
      },
    })
    assert.equal(repo.statusCode, 202)
    const { job } = repo.json() as { job: { id: string } }
    assert.equal((await waitForJob(server, job.id)).status, 'completed')
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
      delete saved[k]
    }
  })

  function task(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'pictures',
      repository: 'pbs-main',
      backupId: 'pictures',
      archives: [{ name: 'pics', path: '/tank/pictures', excludes: [] }],
      changeDetectionMode: 'default',
      schedule: '*-*-* 02:00:00',
      enabled: true,
      ...over,
    }
  }

  async function post(payload: Record<string, unknown>) {
    return server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload })
  }

  async function created(payload: Record<string, unknown>): Promise<void> {
    const res = await post(payload)
    assert.equal(res.statusCode, 202, res.body)
    const { job } = res.json() as { job: { id: string } }
    assert.equal((await waitForJob(server, job.id)).status, 'completed')
  }

  async function storedId(name: string): Promise<string | undefined> {
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    return data.find(e => e.task.name === name)?.task.backupId
  }

  it('a new task sent with no backup-id gets <host>-<task>', async () => {
    const { backupId: _omit, ...noId } = task()
    await created(noId)
    assert.equal(await storedId('pictures'), 'nas-pictures')
  })

  it('an empty backup-id is treated as none', async () => {
    await created(task({ backupId: '' }))
    assert.equal(await storedId('pictures'), 'nas-pictures')
  })

  it('creating a task in a group another task writes is a 409 naming that task', async () => {
    await created(task({ backupId: 'nas' }))
    const res = await post(task({ name: 'documents', backupId: 'nas', archives: [{ name: 'docs', path: '/tank/docs', excludes: [] }] }))
    assert.equal(res.statusCode, 409)
    const err = (res.json() as { error: { reason: string, message: string } }).error
    assert.equal(err.reason, 'backup-group-in-use')
    assert.match(err.message, /Backup task 'pictures' already writes the group host\/nas in repository 'pbs-main'/)
  })

  it('the same id in another namespace is another group — accepted', async () => {
    await created(task({ backupId: 'nas' }))
    await created(task({ name: 'documents', backupId: 'nas', namespace: 'docs' }))
  })

  it('an edit that keeps its own group is accepted; moving INTO a used group is refused', async () => {
    await created(task({ backupId: 'nas' }))
    await created(task({ name: 'documents', backupId: 'docs' }))
    // Moving documents into pictures' group: refused.
    const into = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/documents', headers: JSON_HEADERS, payload: task({ name: 'documents', backupId: 'nas' }) })
    assert.equal(into.statusCode, 409)
    // An edit of pictures that keeps its own group: accepted.
    const keep = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/pictures', headers: JSON_HEADERS, payload: task({ backupId: 'nas', schedule: '*-*-* 03:00:00' }) })
    assert.equal(keep.statusCode, 202, keep.body)
  })
})
