import type { AhrLayoutPreview, AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrRoutes } from '../ahr.js'

// Every disk in the stock mock inventory is in use (system / testpool member /
// spare) — a testpool mirror member for the ineligibility tests:
const POOL_MEMBER = 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678'

// For the eligible-selection paths, a self-contained inventory with genuinely
// blank disks (the stage-0 2/3/4 shape at TB scale).
const BLANK_A = 'ata-ANAS_TEST_BLANK_A'
const BLANK_B = 'ata-ANAS_TEST_BLANK_B'
const BLANK_C = 'ata-ANAS_TEST_BLANK_C'
const TB = 1000 ** 4

/** A bare Fastify server with ONLY ahrRoutes and a controlled disk inventory. */
async function previewServer() {
  const executor = new MockExecutor()
  const lsblk = {
    blockdevices: [
      { 'name': 'sdx', 'type': 'disk', 'size': 2 * TB, 'model': 'BLANK A', 'serial': 'A', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
      { 'name': 'sdy', 'type': 'disk', 'size': 3 * TB, 'model': 'BLANK B', 'serial': 'B', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
      { 'name': 'sdz', 'type': 'disk', 'size': 4 * TB, 'model': 'BLANK C', 'serial': 'C', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
    ],
  }
  const byId = [
    `lrwxrwxrwx 1 root root 9 Jul 22 22:43 ${BLANK_A} -> ../../sdx`,
    `lrwxrwxrwx 1 root root 9 Jul 22 22:43 ${BLANK_B} -> ../../sdy`,
    `lrwxrwxrwx 1 root root 9 Jul 22 22:43 ${BLANK_C} -> ../../sdz`,
    '',
  ].join('\n')
  executor.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: JSON.stringify(lsblk), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: byId, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 0 } })
  // smartctl identity probes fail-open (unregistered → 127) via the cache.
  const server = Fastify({ logger: false })
  await server.register(ahrRoutes, { prefix: '/v1', executor, diskIdentityCache: new DiskIdentityCache(executor) })
  return server
}

describe('AHR routes (Epic 11 + AHR — read layer)', () => {
  let server: ReturnType<typeof createServer>

  beforeEach(() => {
    server = createServer({ mock: true, logger: false })
  })
  afterEach(async () => {
    await server.close()
  })

  describe('GET /v1/ahr', () => {
    it('lists the mock pool reconstructed from the stage-0 fixtures', async () => {
      const res = await server.inject({ method: 'GET', url: '/v1/ahr' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: AhrPool[] }
      assert.equal(data.length, 1)
      assert.equal(data[0].name, 'ahr0')
      assert.equal(data[0].ahrType, 'ahr1')
      assert.equal(data[0].state, 'healthy')
      assert.equal(data[0].arrays.length, 2)
    })
  })

  describe('GET /v1/ahr/:name', () => {
    it('returns the full §3 pool detail', async () => {
      const res = await server.inject({ method: 'GET', url: '/v1/ahr/ahr0' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: AhrPool }
      assert.equal(data.mountpoint, '/mnt/anas-ahr/ahr0')
      assert.equal(data.vg.name, 'ahr0')
      assert.equal(data.lv.name, 'ahr0-vol')
      // Used/free are READ from btrfs (GT-14), never precomputed.
      assert.equal(data.capacity.usedBytes, 294912)
      assert.equal(data.capacity.freeBytes, 2387869696)
      // Disks keyed by by-id (GT-2) — the mock by-id listing's WD ids.
      assert.ok(data.disks.every(d => d.id.startsWith('ata-')))
    })

    it('404s for an unknown pool', async () => {
      const res = await server.inject({ method: 'GET', url: '/v1/ahr/nope' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('400s for an invalid pool name', async () => {
      const res = await server.inject({ method: 'GET', url: '/v1/ahr/9bad' })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })
  })

  describe('POST /v1/ahr/layout/preview (mock inventory — everything in use)', () => {
    it('rejects a disk that is in use, naming its status', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/ahr/layout/preview',
        payload: { disks: [POOL_MEMBER], tier: 'ahr1' },
      })
      assert.equal(res.statusCode, 400)
      const { error } = res.json()
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.ok(error.message.includes(POOL_MEMBER))
      assert.ok(error.message.includes('pool_member'))
    })

    it('rejects an unknown disk id', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/ahr/layout/preview',
        payload: { disks: ['nvme-DOES_NOT_EXIST'], tier: 'ahr2' },
      })
      assert.equal(res.statusCode, 400)
      assert.ok(res.json().error.message.includes('not found'))
    })

    it('rejects a malformed body', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/ahr/layout/preview',
        payload: { disks: [], tier: 'raid5' },
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })
  })
})

describe('POST /v1/ahr/layout/preview (available disks)', () => {
  it('previews the 2+3+4 TB AHR-1 worked example (§2.2 band math)', async () => {
    const server = await previewServer()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/ahr/layout/preview',
      payload: { disks: [BLANK_A, BLANK_B, BLANK_C], tier: 'ahr1' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: AhrLayoutPreview }
    assert.equal(data.minDisksMet, true)
    // Three bands: raid5×3, raid1×2, and the wasted top slice of the 4 TB.
    assert.equal(data.bands.length, 3)
    assert.deepEqual(data.bands.map(b => b.level), ['raid5', 'raid1', null])
    assert.equal(data.bands[2].protected, false)
    assert.ok(data.warnings.some(w => w.includes('unprotected')))
    await server.close()
  })

  it('previews a single disk as fully unprotected (min-disks not met)', async () => {
    const server = await previewServer()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/ahr/layout/preview',
      payload: { disks: [BLANK_A], tier: 'ahr1' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: AhrLayoutPreview }
    assert.equal(data.minDisksMet, false)
    assert.equal(data.capacity.usableBytes, 0)
    assert.ok(data.capacity.unprotectedWastedBytes > 0)
    await server.close()
  })

  it('rejects duplicate disk ids via the planner', async () => {
    const server = await previewServer()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/ahr/layout/preview',
      payload: { disks: [BLANK_A, BLANK_A], tier: 'ahr1' },
    })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error.message.includes('duplicate'))
    await server.close()
  })
})
