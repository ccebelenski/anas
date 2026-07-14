import type { Job, JobAccepted, Snapshot } from '@anas/shared'
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

describe('snapshot routes (nested under datasets)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- GET list ----------------------------------------------------------
  describe('GET …/datasets/*path/snapshots', () => {
    it('returns the dataset snapshots newest-first', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/snapshots' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Snapshot[] }
      assert.deepEqual(data.map(s => s.snapshotName), ['snap2', 'snap1'])
      assert.equal(data[0].name, 'testpool/media@snap2')
      assert.equal(data[1].created, '2026-07-13T10:00:00.000Z')
    })

    it('returns 404 for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/nope/snapshots' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })
  })

  // --- GET detail --------------------------------------------------------
  describe('GET …/snapshots/:snap', () => {
    it('returns a single snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/snapshots/snap1' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Snapshot }
      assert.equal(data.name, 'testpool/media@snap1')
      assert.equal(data.referenced, 128 * 1024 * 1024)
    })

    it('returns 404 for an unknown snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/snapshots/nope' })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- POST create -------------------------------------------------------
  describe('POST …/datasets/*path/snapshots', () => {
    it('returns 202 and completes for a new snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'fresh' }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.snapshot')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { created: string }).created, 'testpool/media@fresh')
    })

    it('returns 409 when the snapshot already exists', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'snap1' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('rejects requests without identity headers', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'fresh' }),
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- PUT rename --------------------------------------------------------
  describe('PUT …/snapshots/:snap', () => {
    it('returns 202 and renames the snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ newName: 'renamed' }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.rename')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { to: string }).to, 'testpool/media@renamed')
    })

    it('returns 404 for an unknown snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/snapshots/nope',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ newName: 'renamed' }),
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- DELETE destroy (plain 202, no confirmation) -----------------------
  describe('DELETE …/snapshots/:snap', () => {
    it('returns a plain 202 (no confirm code) and destroys the snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 202)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.destroy')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { destroyed: string }).destroyed, 'testpool/media@snap1')
    })

    it('returns 404 for an unknown snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media/snapshots/nope',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- POST rollback (dangerous, confirmation gated) ---------------------
  describe('POST …/snapshots/:snap/rollback', () => {
    it('returns 409 CONFIRMATION_REQUIRED with warnings when unconfirmed', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      // snap2 is newer than snap1 → the warning surfaces that force is needed.
      const warnings = res.json().error.warnings as string[]
      assert.ok(warnings.some(w => w.includes('snap2')))
    })

    it('proceeds to 202 when resent with a valid code — and force is NOT in the signature', async () => {
      server = createServer({ mock: true, logger: false })
      // Challenge WITHOUT force...
      const first = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      // ...resend WITH force=true. If force were bound into the confirm
      // signature this would 409 again (the pool-destroy bug).
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback?force=true',
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.rollback')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { rolledBack: string }).rolledBack, 'testpool/media@snap1')
    })

    it('returns 404 for an unknown snapshot (before confirmation)', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/nope/rollback',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 404)
    })

    it('rejects requests without identity headers', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback',
        headers: {},
      })
      assert.equal(res.statusCode, 401)
    })
  })
})
