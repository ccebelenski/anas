import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
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

const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

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

describe('pool properties endpoint: PUT /v1/pools/:name', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 202 with a job ref and the job completes', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { autotrim: 'on', autoexpand: 'off' } }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.set')
    assert.equal(body.job.createdBy, 'root@pam')
    assert.ok(body.job.id)

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.error, null)
  })

  it('sets failmode to a valid enum value', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { failmode: 'continue' } }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ properties: { autotrim: 'on' } }),
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/nosuchpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { autotrim: 'on' } }),
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('rejects an invalid pool name', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/1notapool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { autotrim: 'on' } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects an empty properties object', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: {} }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects a non-settable property (ashift is creation-only)', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { ashift: '12' } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /not settable/)
  })

  it('rejects an out-of-range value for a settable property', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { failmode: 'explode' } }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('fails the job when zpool set fails', async () => {
    server = createServer({ mock: true, logger: false })
    // MockExecutor returns the first matching fixture, so rebuild the set
    // with a failing zpool set instead of appending after the built-in success.
    const mock = (server as any).executor as MockExecutor
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['set', 'autotrim=on', 'testpool'],
      result: { stdout: '', stderr: 'cannot set property for \'testpool\': permission denied', exitCode: 1 },
    })

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ properties: { autotrim: 'on' } }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /permission denied/)
  })
})
