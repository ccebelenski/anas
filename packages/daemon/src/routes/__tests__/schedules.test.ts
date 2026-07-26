import type { Job, SnapshotScheduleStatus } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { parseServiceUnit } from '../../services/snapshot-schedule-units.js'

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function zpoolListJson(names: string[]): string {
  const pools: Record<string, unknown> = {}
  for (const name of names)
    pools[name] = { name, state: 'ONLINE', properties: {} }
  return JSON.stringify({ pools })
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

const SCHEDULE = {
  id: 'nightly-media',
  name: 'Nightly media',
  target: { kind: 'zfs' as const, dataset: 'testpool/media' },
  cadence: 'daily' as const,
  retention: { daily: 7 },
  recursive: false,
  enabled: true,
}

describe('snapshot schedule routes (Epic 17.3/17.4)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-schedules-'))
    prevEnv = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = dir
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool']), stderr: '', exitCode: 0 } })
    // systemctl (daemon-reload/enable/disable/show) + zfs (list/snapshot/destroy):
    // command-only success. zfs list -t snapshot returns empty → prune no-ops.
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    if (prevEnv === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = prevEnv
  })

  async function create(payload: unknown = SCHEDULE) {
    return server.inject({ method: 'POST', url: '/v1/schedules', headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  }

  it('POST creates a schedule → 202, writes the unit files with the embedded JSON', async () => {
    const res = await create()
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))

    const files = await readdir(dir)
    assert.ok(files.includes('anas-snap-nightly-media.service'))
    assert.ok(files.includes('anas-snap-nightly-media.timer'))
    assert.deepEqual(parseServiceUnit(await readFile(join(dir, 'anas-snap-nightly-media.service'), 'utf-8')), SCHEDULE)
    // The timer carries the cadence→OnCalendar translation.
    assert.match(await readFile(join(dir, 'anas-snap-nightly-media.timer'), 'utf-8'), /OnCalendar=daily/)
  })

  it('POST a duplicate id → 409', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await create()
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /already exists/)
  })

  it('POST with an invalid body → 400', async () => {
    const res = await create({ ...SCHEDULE, cadence: 'fortnightly' })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Invalid snapshot schedule/)
  })

  it('POST onto a non-existent pool → 400', async () => {
    const res = await create({ ...SCHEDULE, target: { kind: 'zfs', dataset: 'ghost/media' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /does not exist/)
  })

  it('POST without identity → 401', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/schedules', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(SCHEDULE) })
    assert.equal(res.statusCode, 401)
  })

  it('GET lists derived statuses; GET :id returns the schedule; 404 for unknown', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const list = await server.inject({ method: 'GET', url: '/v1/schedules' })
    assert.equal(list.statusCode, 200)
    const statuses = (list.json() as { data: SnapshotScheduleStatus[] }).data
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].schedule.id, 'nightly-media')

    const one = await server.inject({ method: 'GET', url: '/v1/schedules/nightly-media' })
    assert.equal(one.statusCode, 200)
    assert.equal(one.json().data.name, 'Nightly media')

    const missing = await server.inject({ method: 'GET', url: '/v1/schedules/nope' })
    assert.equal(missing.statusCode, 404)
  })

  it('PUT toggles enabled (rewrites units); id mismatch → 400; unknown → 404', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const put = await server.inject({ method: 'PUT', url: '/v1/schedules/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify({ ...SCHEDULE, enabled: false }) })
    assert.equal(put.statusCode, 202)
    const done = await waitForJob(server, put.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(parseServiceUnit(await readFile(join(dir, 'anas-snap-nightly-media.service'), 'utf-8'))?.enabled, false)

    const mismatch = await server.inject({ method: 'PUT', url: '/v1/schedules/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify({ ...SCHEDULE, id: 'other' }) })
    assert.equal(mismatch.statusCode, 400)

    const unknown = await server.inject({ method: 'PUT', url: '/v1/schedules/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ ...SCHEDULE, id: 'ghost' }) })
    assert.equal(unknown.statusCode, 404)
  })

  it('DELETE removes the units → 202; unknown → 404', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const del = await server.inject({ method: 'DELETE', url: '/v1/schedules/nightly-media', headers: IDENTITY })
    assert.equal(del.statusCode, 202)
    await waitForJob(server, del.json().job.id)
    assert.deepEqual(await readdir(dir), [])

    const again = await server.inject({ method: 'DELETE', url: '/v1/schedules/nightly-media', headers: IDENTITY })
    assert.equal(again.statusCode, 404)
  })

  it('POST :id/run fires take+prune → 202 job whose result is the take outcome', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(run.statusCode, 202)
    const done = await waitForJob(server, run.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const result = done.result as { schedule: string, taken: string, pruned: string[], skippedHeld: string[] }
    assert.equal(result.schedule, 'nightly-media')
    assert.match(result.taken, /^anas-daily-\d{4}-\d{2}-\d{2}T\d{6}Z$/)
    assert.deepEqual(result.pruned, [])
    assert.deepEqual(result.skippedHeld, [])
    // The take issued a `zfs snapshot testpool/media@anas-daily-…`.
    const snapCall = mockOf(server).calls.find(c => c.args[0] === 'snapshot')
    assert.ok(snapCall && snapCall.args.some(a => a.startsWith('testpool/media@anas-daily-')))
  })

  it('POST :id/run on an unknown schedule → 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/schedules/ghost/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.statusCode, 404)
  })
})
