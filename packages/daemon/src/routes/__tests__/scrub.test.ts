import type { Job, PeriodicScrubState } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

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

describe('periodic scrub routes — ZFS property (Epic 17.5)', () => {
  let server: ReturnType<typeof createServer>

  beforeEach(() => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['tank', 'rpool']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'value', 'org.debian:periodic-scrub', 'tank'], result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'value', 'org.debian:periodic-scrub', 'rpool'], result: { stdout: 'disable\n', stderr: '', exitCode: 0 } })
    // zfs set + any other zfs: command-only success. AHR reads fail (unmocked) →
    // ahrPoolNames fail-opens to [] so GET returns only the ZFS pools.
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
  })

  it('GET /scrub reports each ZFS pool uniformly (default on; disable → off)', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const states = (res.json() as { data: PeriodicScrubState[] }).data
    const byPool = new Map(states.map(s => [s.target.pool, s]))
    assert.equal(byPool.get('tank')?.enabled, true)
    assert.equal(byPool.get('rpool')?.enabled, false)
    assert.ok(states.every(s => s.mechanism === 'zfs-property' && s.cadence === 'monthly'))
  })

  it('PUT /scrub/zfs/:pool flips the property (202 job)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: false }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const setCall = mockOf(server).calls.find(c => c.args[0] === 'set')
    assert.ok(setCall && setCall.args.includes('org.debian:periodic-scrub=disable') && setCall.args.includes('tank'))
  })

  it('PUT /scrub/zfs/:pool for an unknown pool → 404', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 404)
  })

  it('PUT /scrub/zfs/:pool with a bad body → 400', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ on: 'yes' }) })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /scrub/ahr/:pool for an unknown AHR pool → 404 (AHR reads fail-open to [])', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 404)
  })
})

describe('periodic scrub routes — AHR mdcheck timers (Epic 17.5)', () => {
  let server: ReturnType<typeof createServer>

  beforeEach(() => {
    // Default mock fixtures replay AHR pool `ahr0`; add a command-only systemctl
    // success so the mdcheck enable/disable + is-enabled resolve (exact fixtures
    // still win). is-enabled command-only returns empty → read = off.
    server = createServer({ mock: true, logger: false })
    mockOf(server).addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
  })

  it('GET /scrub includes the AHR pool with the node-global mdcheck note', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const ahr = (res.json() as { data: PeriodicScrubState[] }).data.find(s => s.target.kind === 'ahr')
    assert.ok(ahr, 'expected an AHR scrub state')
    assert.equal(ahr!.mechanism, 'mdcheck-timer')
    assert.match(ahr!.note ?? '', /node-global/)
  })

  it('PUT /scrub/ahr/ahr0 toggles the node mdcheck timers (202 job)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const call = mockOf(server).calls.find(c => c.args[0] === 'enable' && c.args.includes('mdcheck_start.timer'))
    assert.ok(call && call.args.includes('mdcheck_continue.timer'))
  })
})
