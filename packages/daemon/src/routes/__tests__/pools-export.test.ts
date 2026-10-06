import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
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

describe('ident.1 — pool export binds the pool guid', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Successive guid reads; `null` = the read fails (`zpool get` exits 1). */
  function serveWithGuids(guids: (string | null)[]): { calls: string[][] } {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    const calls: string[][] = []
    mock.exec = async (command: string, args: string[]) => {
      calls.push(args)
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'get -H -o value guid testpool') {
        const guid = guids.length > 1 ? guids.shift() : guids[0]
        return guid === null
          ? { stdout: '', stderr: 'cannot open \'testpool\': I/O error', exitCode: 1 }
          : { stdout: `${guid}\n`, stderr: '', exitCode: 0 }
      }
      return orig(command, args)
    }
    return { calls }
  }

  const exportReq = (code?: string) => server!.inject({
    method: 'POST',
    url: '/v1/pools/testpool/export',
    headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', ...(code ? { 'x-anas-confirm': code } : {}) },
    payload: '{}',
  })

  it('a pool swapped under the same name between challenge and resend → 409 IDENTITY_MISMATCH', async () => {
    const { calls } = serveWithGuids(['10', '20'])
    const first = await exportReq()
    assert.equal(first.statusCode, 409)
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.match(res.json().error.message, /guid 10 at the confirmation, guid 20 now/)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('the guid cannot be read at the gate → 409 CONFLICT, no confirm code, nothing exported', async () => {
    const { calls } = serveWithGuids([null])
    const res = await exportReq()
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /Could not read the guid of pool 'testpool' — refusing an export that cannot be bound to it/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('the guid cannot be read when the job runs → the job fails IDENTITY_MISMATCH and exports nothing', async () => {
    const { calls } = serveWithGuids(['10', '10', null])
    const first = await exportReq()
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.match(job.error?.message ?? '', /guid 10 at the confirmation, unreadable now/)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('a swap while the job is queued → the job fails IDENTITY_MISMATCH and exports nothing', async () => {
    const { calls } = serveWithGuids(['10', '10', '30'])
    const first = await exportReq()
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })
})
