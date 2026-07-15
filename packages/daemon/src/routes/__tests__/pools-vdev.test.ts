import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const BY_ID = '/dev/disk/by-id/'
const DISK_A = 'ata-WDC_WD2003FZEX-00SRLA0_WD-45678901'
const DISK_B = 'ata-WDC_WD2003FZEX-00SRLA0_WD-56789012'

/** Poll a job until it reaches a terminal state. */
async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Wrap the mock executor's exec to record every command/args pair. */
function spyExecutor(server: ReturnType<typeof createServer>): { calls: { command: string, args: string[] }[] } {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const calls: { command: string, args: string[] }[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return { calls }
}

describe('add-vdev endpoint: POST /v1/pools/:name/vdevs', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 202, completes the job, and runs zpool add with the mirror keyword', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.add')
    assert.equal(body.job.createdBy, 'root@pam')

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.error, null)

    const addCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add')
    assert.ok(addCall, 'zpool add was invoked')
    assert.deepEqual(addCall!.args, [
      'add',
      'testpool',
      'mirror',
      `${BY_ID}${DISK_A}`,
      `${BY_ID}${DISK_B}`,
    ])
  })

  it('runs zpool add with bare disks for a stripe vdev (no redundancy keyword)', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'stripe', disks: [DISK_A] } }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const addCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add')
    assert.ok(addCall)
    assert.deepEqual(addCall!.args, ['add', 'testpool', `${BY_ID}${DISK_A}`])
  })

  it('adds a log vdev with the log keyword (role: log)', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'log', vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')

    const addCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add')
    assert.deepEqual(addCall!.args, [
      'add',
      'testpool',
      'log',
      'mirror',
      `${BY_ID}${DISK_A}`,
      `${BY_ID}${DISK_B}`,
    ])
  })

  it('adds bare cache disks (role: cache, no redundancy keyword)', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'cache', disks: [DISK_A] }),
    })

    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)

    const addCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add')
    assert.deepEqual(addCall!.args, ['add', 'testpool', 'cache', `${BY_ID}${DISK_A}`])
  })

  it('adds bare spare disks (role: spare)', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'spare', disks: [DISK_A] }),
    })

    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)

    const addCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add')
    assert.deepEqual(addCall!.args, ['add', 'testpool', 'spare', `${BY_ID}${DISK_A}`])
  })

  it('adds a redundant special vdev with the special keyword (role: special)', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'special', vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)

    const addCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add')
    assert.deepEqual(addCall!.args, [
      'add',
      'testpool',
      'special',
      'mirror',
      `${BY_ID}${DISK_A}`,
      `${BY_ID}${DISK_B}`,
    ])
  })

  it('rejects a striped (non-redundant) special vdev with 400 — never invokes zpool add', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'special', vdev: { type: 'stripe', disks: [DISK_A] } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.ok(!spy.calls.some(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'add'))
  })

  it('rejects a striped (non-redundant) dedup vdev with 400', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'dedup', vdev: { type: 'stripe', disks: [DISK_A] } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects a cache role carrying a vdev spec instead of bare disks', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'cache', vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('rejects a vdev spec that violates the minimum disk count', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: [DISK_A] } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects an invalid pool name', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/1notapool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('fails the job when zpool add fails', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['add', 'testpool', 'mirror', `${BY_ID}${DISK_A}`, `${BY_ID}${DISK_B}`],
      result: { stdout: '', stderr: 'cannot add to testpool: mismatched replication level', exitCode: 1 },
    })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: [DISK_A, DISK_B] } }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /mismatched replication level/)
  })
})
