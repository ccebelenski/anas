import type { AhrLayoutPreview, AhrPool } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { createServer } from '../../server.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
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

/**
 * Register the dev-mock AHR topology (the stage-0 `ahr0` pool) on an executor,
 * reusing the SAME fixture loader the mock server uses — so a route test can
 * bring its own JobQueue without re-stating fixture bytes.
 */
function mockAhrTopologyExecutor(executor: MockExecutor): MockExecutor {
  executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
  executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
  executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
  executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
  executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
  executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })
  return executor
}

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

    // Issue #7: the read routes consult the job queue so a pool mid-create
    // reads BUILDING rather than the half-built stack's honest-but-alarming
    // `failed`. Wired end to end here — the mock pool is healthy, so a running
    // create for it proves only the plumbing, which is the part that breaks.
    it('a running ahr.create for the pool surfaces as BUILDING with its progress', async () => {
      const executor = new MockExecutor()
      const jobQueue = new JobQueue()
      jobQueue.submit(
        'ahr.create',
        { user: 'test', uid: 0, params: { name: 'ahr0' } },
        async (updateProgress) => {
          updateProgress('Creating array ahr0-r2 (raid1×2)')
          return new Promise(() => {})
        },
      )
      const app = Fastify({ logger: false })
      await app.register(ahrRoutes, {
        prefix: '/v1',
        executor: mockAhrTopologyExecutor(executor),
        diskIdentityCache: new DiskIdentityCache(executor),
        jobQueue,
      })
      try {
        const res = await app.inject({ method: 'GET', url: '/v1/ahr' })
        const { data } = res.json() as { data: AhrPool[] }
        assert.equal(data[0].state, 'building')
        assert.equal(data[0].advisories[0], `pool 'ahr0' is being created — Creating array ahr0-r2 (raid1×2)`)
      }
      finally {
        await app.close()
      }
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

// ---- D12: an unreadable topology fails loud, never a silent []/404 ----------
// The node pass injected these exact failures: mdadm --detail --export for one
// ARRAY exits 1 (mode A), or cat /proc/mdstat fails (mode b); the wrinkle is
// that only a FAILED read is unreadable — a READABLE foreign array is "not
// ours" and the readable controls stay green.
describe('D12 — /ahr read failure shapes', () => {
  const MDADM = '/usr/sbin/mdadm'
  const CAT = '/usr/bin/cat'
  /** A mock server whose executor answers one read differently (else the dev-mock cap). */
  async function faultedServer(
    override: (command: string, args: string[]) => ExecResult | undefined | Promise<ExecResult | undefined>,
  ): Promise<ReturnType<typeof createServer>> {
    const s = createServer({ mock: true, logger: false })
    const mock = (s as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command, args, opts) => (await override(command, args)) ?? orig(command, args, opts)
    return s
  }

  const ahrDetailFault: (command: string, args: string[]) => ExecResult | undefined = (command, args) =>
    command === MDADM && args[0] === '--detail' && args[1] === '--export' && args[2] === '/dev/md127'
      ? { stdout: '', stderr: 'mdadm: cannot open /dev/md127: injected by the w2b node pass', exitCode: 1 }
      : undefined

  it('(a) `mdadm --detail --export /dev/md127` exit 1 — GET /ahr answers 503 naming the read, never []', async () => {
    const server = await faultedServer(ahrDetailFault)
    const res = await server.inject({ method: 'GET', url: '/v1/ahr' })
    assert.equal(res.statusCode, 503)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'UNAVAILABLE')
    assert.match(error.message, /the AHR topology could not be read/)
    assert.match(error.message, /mdadm --detail --export \/dev\/md127/)
    await server.close()
  })

  it('(a) the same read — GET /ahr/:name answers 503, never a 404', async () => {
    const server = await faultedServer(ahrDetailFault)
    const res = await server.inject({ method: 'GET', url: '/v1/ahr/ahr0' })
    assert.equal(res.statusCode, 503)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'UNAVAILABLE')
    await server.close()
  })

  it('(b) `cat /proc/mdstat` exit 1 — GET /ahr answers 503 naming the read', async () => {
    const server = await faultedServer((command, args) =>
      command === CAT && args[0] === '/proc/mdstat'
        ? { stdout: '', stderr: 'cat: /proc/mdstat: injected by the w2b node pass', exitCode: 1 }
        : undefined)
    const res = await server.inject({ method: 'GET', url: '/v1/ahr' })
    assert.equal(res.statusCode, 503)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'UNAVAILABLE')
    assert.match(error.message, /the AHR topology could not be read/)
    assert.match(error.message, /cat \/proc\/mdstat/)
    await server.close()
  })

  it('(c) a READABLE topology with a foreign md array beside the ANAS pools — GET /ahr lists the ANAS pools only (no regression)', async () => {
    const foreign = [
      'md40 : active raid1 sdy1[1] sdx1[0]',
      '      1047552 blocks super 1.2 [2/2] [UU]',
      '',
      'unused devices: <none>',
    ].join('\n')
    const mdstatWithForeign = mockFixtures.ahrMdstat().stdout.replace('unused devices: <none>', foreign)
    const server = await faultedServer(async (command, args) => {
      if (command === CAT && args[0] === '/proc/mdstat')
        return { stdout: mdstatWithForeign, stderr: '', exitCode: 0 }
      if (command === MDADM && args[0] === '--detail' && args[1] === '--export' && args[2] === '/dev/md40')
        return { stdout: 'MD_LEVEL=raid1\nMD_DEVICES=2\nMD_DEVNAME=foreign0\nMD_NAME=otherhost:foreign0\n', stderr: '', exitCode: 0 }
      return undefined
    })
    const res = await server.inject({ method: 'GET', url: '/v1/ahr' })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: AhrPool[] }
    assert.deepEqual(data.map(p => p.name), ['ahr0'])
    await server.close()
  })

  it('(d) a SPAWN failure (EACCES) still answers 500 with its own code — only a typed unreadable read is the 503 (cr.33c pinned)', async () => {
    const server = await faultedServer(async (command, args) => {
      if (command === MDADM && args[0] === '--detail' && args[1] === '--export' && args[2] === '/dev/md126')
        throw Object.assign(new Error('spawn /usr/sbin/mdadm EACCES'), { code: 'EACCES' })
      return undefined
    })
    const res = await server.inject({ method: 'GET', url: '/v1/ahr' })
    assert.equal(res.statusCode, 500)
    assert.equal((res.json() as { code: string }).code, 'EACCES')
    await server.close()
  })
})
