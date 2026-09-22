import type { Job, JobAccepted, PoolDetail, PoolSummary } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
  'content-type': 'application/json',
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

// Story 3.26 — the pool ROOT is a first-class dataset. It must accept the same
// snapshot + property-set operations any child dataset does. The empty wildcard
// (trailing slash) targets the root; the root's rel-path is the empty string.
describe('pool-root dataset operations (3.26)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('sets a property on the pool root (empty path → pool name)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/',
      headers: IDENTITY_HEADERS,
      payload: JSON.stringify({ properties: { compression: 'lz4' } }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zfs.set')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    // The zfs set targets the bare pool name, not `testpool/`.
    assert.equal((job.result as { dataset: string }).dataset, 'testpool')
  })

  it('creates a snapshot on the pool root, non-recursive by default', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/snapshots',
      headers: IDENTITY_HEADERS,
      payload: JSON.stringify({ name: 'rootsnap' }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zfs.snapshot')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    // A single snapshot of the root — recursion is not defaulted on the root
    // (the PVE-collision hazard called out in 3.26).
    assert.equal((job.result as { created: string }).created, 'testpool@rootsnap')
  })

  it('returns the root dataset mountpoint for the shares flow', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/' })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { name: string, mountpoint?: string } }
    assert.equal(data.name, 'testpool')
    assert.ok(data.mountpoint, 'root dataset detail includes a mountpoint')
  })
})

// Story 3.25 — every PoolSummary carries a pveStorages array (empty off-PVE,
// where /etc/pve/storage.cfg is absent — fail-open).
describe('PVE storage detection on pools (3.25)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('GET /pools includes a pveStorages array on every pool', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({ method: 'GET', url: '/v1/pools' })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: PoolSummary[] }
    assert.ok(data.length > 0)
    for (const pool of data)
      assert.ok(Array.isArray(pool.pveStorages), `${pool.name} has a pveStorages array`)
  })
})

// --- pvepool.1 review fix 3: pool payloads carry the ROOT dataset's ownership
// verdict, from the same per-request footprint as pveStorages — a system pool
// and the config-unreadable state become visible in the grid; an ANAS pool
// carries no `pve` at all.
describe('pool-root PVE ownership on Pool payloads (pvepool.1 review fix 3)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevCfg: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pools-pve-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (prevCfg === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = prevCfg
  })

  it('an ANAS pool carries NO `pve` — list and detail', async () => {
    server = createServer({ mock: true, logger: false })
    const list = await server.inject({ method: 'GET', url: '/v1/pools' })
    assert.equal(list.statusCode, 200)
    const { data: pools } = list.json() as { data: PoolSummary[] }
    assert.ok(pools.length > 0)
    for (const pool of pools)
      assert.equal(pool.pve, undefined, `${pool.name} has no pve field`)

    const detail = await server.inject({ method: 'GET', url: '/v1/pools/testpool' })
    assert.equal(detail.statusCode, 200)
    assert.equal((detail.json() as { data: PoolDetail }).data.pve, undefined)
  })

  it('a system pool carries its boot-tree verdict on list and detail', async () => {
    server = createServer({ mock: true, logger: false })
    // Readable boot facts: testpool boots this node (exact-args match wins over
    // the mock server's command-only zpool catch-all).
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'testpool\ttestpool/ROOT/pve-1\n', stderr: '', exitCode: 0 },
    })

    const list = await server.inject({ method: 'GET', url: '/v1/pools' })
    assert.equal(list.statusCode, 200)
    const { data: pools } = list.json() as { data: PoolSummary[] }
    const summary = pools.find(p => p.name === 'testpool')
    assert.equal(summary?.pve?.kind, 'system')
    assert.match(summary?.pve?.reason ?? '', /testpool/)
    // The pool ROOT sits ABOVE the boot tree (rpool/ROOT is the umbrella), so
    // its non-guest children remain ANAS's.
    assert.equal(summary?.pve?.childrenManageable, true)

    const detail = await server.inject({ method: 'GET', url: '/v1/pools/testpool' })
    assert.equal(detail.statusCode, 200)
    const poolDetail = (detail.json() as { data: PoolDetail }).data
    assert.equal(poolDetail.pve?.kind, 'system')
    assert.equal(poolDetail.pve?.childrenManageable, true)
  })

  it('an UNREADABLE storage.cfg marks every pool config-unreadable — list and detail', async () => {
    // The env override points at a DIRECTORY: readFile rejects EISDIR — any
    // non-ENOENT failure stands in for pmxcfs (/etc/pve) being down.
    process.env.ANAS_STORAGE_CFG = dir
    server = createServer({ mock: true, logger: false })

    const list = await server.inject({ method: 'GET', url: '/v1/pools' })
    assert.equal(list.statusCode, 200)
    const { data: pools } = list.json() as { data: PoolSummary[] }
    assert.ok(pools.length > 0)
    for (const pool of pools) {
      assert.equal(pool.pve?.kind, 'config-unreadable', pool.name)
      assert.match(pool.pve?.reason ?? '', /unreadable/)
    }

    const detail = await server.inject({ method: 'GET', url: '/v1/pools/testpool' })
    assert.equal(detail.statusCode, 200)
    const poolDetail = (detail.json() as { data: PoolDetail }).data
    assert.equal(poolDetail.pve?.kind, 'config-unreadable')
    // Nothing can be judged — no pool root's children are manageable either.
    assert.equal(poolDetail.pve?.childrenManageable, false)
  })
})
