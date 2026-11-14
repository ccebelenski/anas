import type { PoolSummary, StatusSummary } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'
import { servePoolGuardReads } from './pool-guard-reads.js'

/**
 * cr3.pools-disks — the verb doors: POOLS-DISKS-M6 (raidz expand on a
 * degraded raidz), the raidz `log` refusal (node ground truth, ZFS 2.4.2),
 * the pool-name marker (operator ruling 2026-11-14) and POOLS-DISKS-L11
 * (GET /disks/:id/smart on a failed probe).
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const BY_ID = '/dev/disk/by-id/'
const RZ = 'testpool-rz'
const NEW_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4'
const D1 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'
const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

function headers(json = false) {
  return {
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-privileges': 'Sys.Audit,Sys.Modify',
    'x-anas-request-id': randomUUID(),
    ...(json ? { 'content-type': 'application/json' } : {}),
  }
}

type Srv = ReturnType<typeof createServer>
const mockOf = (server: Srv): MockExecutor => (server as unknown as { executor: MockExecutor }).executor

/** A 3-disk raidz1 pool (the review probe's world). */
function raidzStatus(degraded: boolean): string {
  return JSON.stringify({ pools: { [RZ]: {
    name: RZ,
    state: degraded ? 'DEGRADED' : 'ONLINE',
    pool_guid: '11',
    error_count: '0',
    vdevs: { [RZ]: { name: RZ, vdev_type: 'root', state: 'ONLINE', total_space: '1.38G', alloc_space: '280K', vdevs: {
      'raidz1-0': { name: 'raidz1-0', vdev_type: 'raidz', state: degraded ? 'DEGRADED' : 'ONLINE', total_space: '1.38G', alloc_space: '280K', vdevs: {
        d1: { name: 'd1', vdev_type: 'disk', state: 'ONLINE', devid: `${D1}-part1`, path: `${BY_ID}${D1}-part1` },
        d2: { name: 'd2', vdev_type: 'disk', state: degraded ? 'UNAVAIL' : 'ONLINE', devid: 'scsi-D2-part1', path: `${BY_ID}scsi-D2-part1` },
        d3: { name: 'd3', vdev_type: 'disk', state: 'ONLINE', devid: 'scsi-D3-part1', path: `${BY_ID}scsi-D3-part1` },
      } },
    } } },
  } } })
}

function raidzServer(degraded: boolean): Srv {
  const server = createServer({ mock: true, logger: false })
  serveBlankInventoryDisks(server, [NEW_DISK])
  const mock = mockOf(server)
  mock.clearFixtures()
  servePoolGuardReads(mock, RZ)
  mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: JSON.stringify({ pools: { [RZ]: { name: RZ, state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: raidzStatus(degraded), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, args: ['get', 'all', '-j'], result: { stdout: JSON.stringify({ pools: { [RZ]: { properties: { 'feature@raidz_expansion': { value: 'enabled', source: { type: 'LOCAL', data: '-' } } } } } }), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZFS, args: ['version'], result: { stdout: 'zfs-2.3.1-1\nzfs-kmod-2.3.1-1\n', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, result: OK })
  mock.addFixture({ command: ZFS, result: OK })
  return server
}

describe('cr3 — a degraded raidz is never widened (POOLS-DISKS-M6)', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function expand(srv: Srv) {
    return srv.inject({ method: 'POST', url: `/v1/pools/${RZ}/attach`, headers: headers(true), payload: JSON.stringify({ targetVdev: 'raidz1-0', newDiskId: NEW_DISK }) })
  }

  it('the door refuses 409 reason degraded with the read model\'s sentence — no zpool attach (the review probe)', async () => {
    server = raidzServer(true)
    const target = ((await server.inject({ method: 'GET', url: `/v1/pools/${RZ}/expansion`, headers: headers() })).json() as { data: { targets: { reason?: string, reasonDetail?: string }[] } }).data.targets[0]
    assert.equal(target.reason, 'degraded')
    const res = await expand(server)
    assert.equal(res.statusCode, 409, res.body)
    const { error } = res.json() as { error: { reason: string, message: string } }
    assert.equal(error.reason, 'degraded')
    assert.ok(error.message.startsWith(target.reasonDetail!), 'one sentence for the read model and the door')
    assert.ok(!mockOf(server).calls.some(c => c.command === ZPOOL && c.args[0] === 'attach'))
  })

  it('control: an ONLINE raidz expands (202)', async () => {
    server = raidzServer(false)
    const res = await expand(server)
    assert.equal(res.statusCode, 202, res.body)
  })
})

describe('cr3 — a raidz log vdev is refused at the boundary (node ground truth: ZFS refuses it)', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const DISKS = ['ata-CR3_LOG_1', 'ata-CR3_LOG_2', 'ata-CR3_LOG_3']

  it('create with a raidz log is 400 naming the rule — nothing run', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: headers(true),
      payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['ata-CR3_D1', 'ata-CR3_D2'] }], logVdevs: [{ type: 'raidz', disks: DISKS }] }),
    })
    assert.equal(res.statusCode, 400, res.body)
    assert.match((res.json() as { error: { message: string } }).error.message, /ZFS supports only single disks and mirrors as log devices/)
    assert.ok(!mockOf(server).calls.some(c => c.command === ZPOOL && c.args[0] === 'create'))
  })

  it('add of a raidz log vdev is 400; a mirror and a single-disk log stay allowed past this check', async () => {
    server = createServer({ mock: true, logger: false })
    serveBlankInventoryDisks(server, DISKS)
    const add = async (vdev: unknown) => server!.inject({ method: 'POST', url: '/v1/pools/testpool/vdevs', headers: headers(true), payload: JSON.stringify({ role: 'log', vdev }) })
    const raidz = await add({ type: 'raidz', disks: DISKS })
    assert.equal(raidz.statusCode, 400, raidz.body)
    assert.match(raidz.body, /cannot be raidz/)
    for (const vdev of [{ type: 'mirror', disks: DISKS.slice(0, 2) }, { type: 'stripe', disks: [DISKS[0]] }]) {
      const res = await add(vdev)
      assert.ok(!res.body.includes('log devices'), `${vdev.type}: ${res.body}`)
    }
  })
})

describe('cr3 — a pool whose name ANAS does not accept is listed with a marker (operator ruling 2026-11-14)', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** The seeded `zpool list -j` with a second pool renamed `tank.v2` (ZFS allows the `.`). */
  function listWithDottedPool(): ExecResult {
    const doc = JSON.parse(mockFixtures.zpoolList().stdout) as { pools: Record<string, { name: string }> }
    const copy = JSON.parse(JSON.stringify(doc.pools.testpool)) as { name: string }
    copy.name = 'tank.v2'
    doc.pools['tank.v2'] = copy
    return { stdout: JSON.stringify(doc), stderr: '', exitCode: 0 }
  }

  it('GET /pools carries `unmanaged` on tank.v2 with the rename sentence, and nothing on testpool', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: listWithDottedPool() })
    const pools = ((await server.inject({ method: 'GET', url: '/v1/pools', headers: headers() })).json() as { data: PoolSummary[] }).data
    const dotted = pools.find(p => p.name === 'tank.v2')
    assert.ok(dotted, 'the pool is still listed')
    assert.equal(dotted.unmanaged?.reason, 'pool-name')
    assert.match(dotted.unmanaged!.message, /ANAS does not manage a pool named 'tank\.v2'/)
    assert.match(dotted.unmanaged!.message, /zpool export 'tank\.v2', then zpool import 'tank\.v2' <new name>/)
    assert.equal(pools.find(p => p.name === 'testpool')?.unmanaged, undefined)
  })

  it('the dashboard brief carries the same marker', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: listWithDottedPool() })
    const status = ((await server.inject({ method: 'GET', url: '/v1/status', headers: headers() })).json() as { data: StatusSummary }).data
    assert.equal(status.pools.find(p => p.name === 'tank.v2')?.unmanaged?.reason, 'pool-name')
    assert.equal(status.pools.find(p => p.name === 'testpool')?.unmanaged, undefined)
  })
})

describe('cr3 — GET /disks/:id/smart never reads a failed probe as "not supported" (POOLS-DISKS-L11)', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const fixture = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/system', name), 'utf-8')

  async function smartOf(result: ExecResult) {
    server = createServer({ mock: true, logger: false })
    const disks = ((await server.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: { id: string, path: string }[] }).data
    const disk = disks[0]
    mockOf(server).prependFixture({ command: '/usr/sbin/smartctl', args: ['-n', 'standby', '-a', '--json', disk.path], result })
    return server.inject({ method: 'GET', url: `/v1/disks/${disk.id}/smart`, headers: headers() })
  }

  it('the captured open-device failure is 503 naming smartctl\'s sentence', async () => {
    const res = await smartOf({ stdout: fixture('smartctl-open-device-failed.json'), stderr: '', exitCode: 2 })
    assert.equal(res.statusCode, 503, res.body)
    assert.match(res.body, /Smartctl open device/)
  })

  it('output that is not smartctl\'s JSON is 503, never a 500', async () => {
    const res = await smartOf({ stdout: 'Segmentation fault', stderr: '', exitCode: 139 })
    assert.equal(res.statusCode, 503, res.body)
  })

  it('a report with SMART results but no smart_support block reads supported', async () => {
    const res = await smartOf({ stdout: JSON.stringify({ device: { name: '/dev/nvme0' }, smart_status: { passed: true }, nvme_smart_health_information_log: { percentage_used: 3, available_spare: 100 } }), stderr: '', exitCode: 0 })
    assert.equal(res.statusCode, 200, res.body)
    const data = (res.json() as { data: { supported: boolean, overallHealth: string } }).data
    assert.equal(data.supported, true)
    assert.equal(data.overallHealth, 'PASSED')
  })

  it('control: the captured report parses as before', async () => {
    const res = await smartOf({ stdout: fixture('smartctl.json'), stderr: '', exitCode: 0 })
    assert.equal(res.statusCode, 200, res.body)
  })
})
