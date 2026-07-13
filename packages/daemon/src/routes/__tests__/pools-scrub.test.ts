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

describe('scrub endpoint: POST /v1/pools/:name/scrub', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 202 with a job ref and the job completes', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/scrub',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.scrub')
    assert.equal(body.job.createdBy, 'root@pam')
    assert.ok(body.job.id)

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.error, null)
  })

  it('accepts an explicit stop action', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/scrub',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'stop' }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/scrub',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/scrub',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('rejects an invalid pool name', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/1notapool/scrub',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects an invalid scrub action', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/scrub',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'pause' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('fails the job when zpool scrub fails', async () => {
    server = createServer({ mock: true, logger: false })
    // MockExecutor returns the first matching fixture, so rebuild the set
    // with a failing scrub instead of appending after the built-in success.
    const mock = (server as any).executor as MockExecutor
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['scrub', 'testpool'],
      result: { stdout: '', stderr: 'cannot scrub testpool: currently scrubbing', exitCode: 1 },
    })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/scrub',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /currently scrubbing/)
  })
})
