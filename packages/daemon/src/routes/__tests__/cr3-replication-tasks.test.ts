import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { parseServiceUnit } from '../../services/replication-units.js'

/**
 * cr3 (the EPICS candidate recorded at rrep.2, now built): a replication task
 * PUT that OMITS `snapshotFirst`, `enabled` or `notify` keeps the stored value
 * (the §2 dialog contract, the rule `recursive`/`exclude` already follow).
 * Before, the shape parse filled each omitted key with its schema default, so
 * a schedule-only edit re-enabled a disabled task, turned snapshot-first back
 * on and reset an `always` notification to `on-failure`.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const STORED = {
  name: 'nightly-media',
  source: { pool: 'testpool', dataset: 'media' },
  target: { pool: 'backup', dataset: 'media' },
  schedule: 'daily',
  snapshotFirst: false,
  enabled: false,
  notify: 'always',
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('cr3 — a replication task PUT keeps what the body omits', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-repltasks-'))
    prevEnv = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = dir
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: JSON.stringify({ pools: { testpool: { name: 'testpool', state: 'ONLINE', properties: {} }, backup: { name: 'backup', state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 } })
    for (const cal of ['daily', 'weekly'])
      mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', cal], result: { stdout: 'Normalized form: x\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks', headers: JSON_HEADERS, payload: JSON.stringify(STORED) })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await waitForJob(server, res.json().job.id)).status, 'completed')
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    if (prevEnv === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = prevEnv
  })

  async function put(body: Record<string, unknown>) {
    const res = await server.inject({ method: 'PUT', url: '/v1/replication/tasks/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify(body) })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    return parseServiceUnit(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'))
  }

  it('a schedule-only edit keeps snapshotFirst false, enabled false and notify always', async () => {
    const { snapshotFirst: _sf, enabled: _en, notify: _no, ...rest } = STORED
    const stored = await put({ ...rest, schedule: 'weekly' })
    assert.equal(stored?.schedule, 'weekly')
    assert.equal(stored?.snapshotFirst, false)
    assert.equal(stored?.enabled, false)
    assert.equal(stored?.notify, 'always')
  })

  it('a failing local `zpool list` refuses a create with its own line, never "Source pool ... does not exist"', async () => {
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: '', stderr: 'internal error: failed to initialize ZFS library', exitCode: 1 } })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks', headers: JSON_HEADERS, payload: JSON.stringify({ ...STORED, name: 'second' }) })
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(res.json().error.message, 'Could not list the pools on this node: internal error: failed to initialize ZFS library')
  })

  it('a key that IS sent still stands (true, true, on-failure)', async () => {
    const stored = await put({ ...STORED, snapshotFirst: true, enabled: true, notify: 'on-failure' })
    assert.equal(stored?.snapshotFirst, true)
    assert.equal(stored?.enabled, true)
    assert.equal(stored?.notify, 'on-failure')
  })
})
