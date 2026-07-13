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

describe('destroy endpoint: DELETE /v1/pools/:name', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
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
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.destroy')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('wipes the freed member disks when cleanup=true', async () => {
    server = createServer({ mock: true, logger: false })

    // The UI challenges WITHOUT cleanup (the checkbox is shown afterward), then
    // resends WITH cleanup=true. cleanup must NOT be part of the confirmation
    // signature, or the resend 409s — the bug this guards against.
    const first = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool?cleanup=true',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    // The job reports the (by-id) disks it wiped — the mock testpool has members.
    const result = job.result as { wiped?: string[] }
    assert.ok(Array.isArray(result.wiped) && result.wiped.length > 0, 'expected wiped disks in result')
  })

  it('rejects a wrong confirm code with 409 and a fresh code', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'bogus-code' },
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('blocks destroying the root pool with 409 PROTECTED_RESOURCE and no confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/rpool',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PROTECTED_RESOURCE')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('does not offer a confirm code even when the root pool is resent with one', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/rpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'anything' },
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PROTECTED_RESOURCE')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a non-root pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/nosuchpool',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })
})
