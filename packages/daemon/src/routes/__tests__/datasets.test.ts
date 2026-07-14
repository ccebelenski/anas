import type { Dataset, DatasetDetail, Job, JobAccepted } from '@anas/shared'
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

describe('datasets routes', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- GET list ----------------------------------------------------------
  describe('GET /v1/pools/:name/datasets', () => {
    it('returns the flat dataset list (filesystems + volumes)', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      const names = data.map(d => d.name).sort()
      assert.deepEqual(names, ['testpool', 'testpool/media', 'testpool/vm-100-disk-0'])
    })

    it('returns 404 for a pool that does not exist', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/nosuchpool/datasets' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })
  })

  // --- GET detail --------------------------------------------------------
  describe('GET /v1/pools/:name/datasets/*path', () => {
    it('returns full detail with properties and mountpoint permissions', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetDetail }
      assert.equal(data.name, 'testpool/media')
      assert.equal(data.properties.compression, 'zstd')
      assert.equal(data.properties.recordsize, 128 * 1024)
      assert.deepEqual(data.permissions, { owner: 'root', group: 'root', mode: '755' })
      assert.deepEqual(data.associatedShares, [])
    })

    it('returns 404 for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/nope' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })
  })

  // --- POST create -------------------------------------------------------
  describe('POST /v1/pools/:name/datasets', () => {
    it('returns 202 and completes for a new dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'projects', properties: { compression: 'lz4', quota: 1073741824 } }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.create')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
    })

    it('returns 409 when the dataset already exists', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'media' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('rejects requests without identity headers', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'projects' }),
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- PUT update properties --------------------------------------------
  describe('PUT /v1/pools/:name/datasets/*path', () => {
    it('returns 202 and applies property changes', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'zstd', atime: false, quota: 0 } }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.set')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      const result = job.result as { applied: string[] }
      assert.ok(result.applied.includes('quota=none'))
      assert.ok(result.applied.includes('atime=off'))
    })

    it('returns 404 for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/nope',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'lz4' } }),
      })
      assert.equal(res.statusCode, 404)
    })

    it('rejects an empty property set', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: {} }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- PUT permissions ---------------------------------------------------
  describe('PUT /v1/pools/:name/datasets/*path/permissions', () => {
    it('returns 202 and runs chown/chmod on the mountpoint', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/permissions',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ owner: 'media', group: 'media', mode: '2770', recursive: true }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'fs.setPermissions')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      const result = job.result as { mountpoint: string }
      assert.equal(result.mountpoint, '/testpool/media')
    })

    it('rejects an invalid mode', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/permissions',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ mode: '9999' }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- DELETE destroy ----------------------------------------------------
  describe('DELETE /v1/pools/:name/datasets/*path', () => {
    it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
    })

    it('proceeds to 202 when resent with a valid code — and recursive is NOT in the signature', async () => {
      server = createServer({ mock: true, logger: false })
      // Challenge WITHOUT recursive (chosen after the challenge is issued)...
      const first = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      // ...then resend WITH recursive=true. If recursive were bound into the
      // confirm signature this would 409 again (the pool-destroy bug).
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media?recursive=true',
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.destroy')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
    })

    it('returns 404 for a dataset that does not exist', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/nope',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 404)
    })
  })
})
