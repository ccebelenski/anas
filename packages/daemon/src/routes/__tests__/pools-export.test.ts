import type { Job, JobAccepted } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

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

describe('export endpoint: POST /v1/pools/:name/export', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(Array.isArray(res.json().error.warnings) && res.json().error.warnings.length > 0)
    assert.ok(res.headers['x-anas-confirm-code'])
    assert.ok(res.headers['x-anas-confirm-expires'])
  })

  it('proceeds to 202 when resent with a valid confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.export')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('rejects a wrong confirm code with 409 and a fresh code', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'bogus-code' },
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('rejects a reused (single-use) confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(accepted.statusCode, 202)

    const reused = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(reused.statusCode, 409)
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/export',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })
})
