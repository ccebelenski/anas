import type { Disk, PoolSummary, StatusSummary, Telemetry } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { isComposableDisk } from '@anas/shared'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { arcFromSnapshots, dashboardRoutes, readDashboardSection } from '../dashboard.js'
import { handsOffContext } from '../disks.js'
import { LSBLK_DISCARD_ARGS } from '../pools.js'

/**
 * cr3.pools-disks — a read that failed never reads as absent, empty, healthy,
 * idle or zero (EPICS *cr3*; reviews INVENTED-STATE-H1, -H2, -L11, -L12 and
 * POOLS-DISKS-M4). Each world below is the seeded mock with ONE read made to
 * fail the way a real command fails — a non-zero exit with an error on
 * stderr, never a timeout (the timeout path is cr.35's, pinned elsewhere).
 */

const ZPOOL = '/usr/sbin/zpool'
const FAIL_LIST: ExecResult = { stdout: '', stderr: 'internal error: Bad file descriptor', exitCode: 1 }
const FAIL_STATUS: ExecResult = { stdout: '', stderr: 'internal error: failed to read pool status', exitCode: 1 }

function headers() {
  return {
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-privileges': 'Sys.Audit,Sys.Modify',
    'x-anas-request-id': randomUUID(),
  }
}

type Srv = ReturnType<typeof createServer>

function mockOf(server: Srv): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function getJson<T>(server: Srv, url: string): Promise<{ statusCode: number, body: T }> {
  const res = await server.inject({ method: 'GET', url, headers: headers() })
  return { statusCode: res.statusCode, body: res.json() as T }
}

describe('cr3 — GET /v1/status: a collector whose read failed makes its section unavailable', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a failed `zpool list -j` is the pools section UNAVAILABLE with a card naming the read, never "No pools"', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: FAIL_LIST })
    const { body } = await getJson<{ data: StatusSummary }>(server, '/v1/status')
    assert.deepEqual(body.data.pools, [])
    assert.ok(body.data.unavailable?.includes('pools'), `pools is listed unavailable: ${JSON.stringify(body.data.unavailable)}`)
    const card = body.data.warnings.find(w => w.category === 'unavailable' && w.message.startsWith('Pool status'))
    assert.ok(card, 'the pools card is there')
    assert.match(card.message, /zpool list -j could not be read \(exit 1: internal error: Bad file descriptor\)/)
  })

  it('a failed `zpool status -jv` keeps the listed pools with scanRunning null, and cards pools AND disks', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const { body } = await getJson<{ data: StatusSummary }>(server, '/v1/status')
    const pool = body.data.pools.find(p => p.name === 'testpool')
    assert.ok(pool, 'the listed pool is still shown (its state is zpool list\'s own health column)')
    assert.equal(pool.scanRunning, null, 'whether a scan runs is unknown, never idle')
    assert.ok(body.data.unavailable?.includes('pools'))
    assert.ok(body.data.unavailable?.includes('disks'))
    const disksCard = body.data.warnings.find(w => w.category === 'unavailable' && w.message.startsWith('Disk health'))
    assert.ok(disksCard && /zpool status -jv could not be read/.test(disksCard.message), disksCard?.message)
  })

  it('a FAULTED leaf whose disk passes SMART never counts healthy when `zpool status` failed (the review probe)', async () => {
    // Control: the status answers with one leaf FAULTED — that disk is critical.
    server = createServer({ mock: true, logger: false })
    const seeded = await mockOf(server).exec(ZPOOL, ['status', '-jv'])
    const json = JSON.parse(seeded.stdout) as Record<string, unknown>
    let faulted = ''
    const walk = (o: unknown): void => {
      if (!o || typeof o !== 'object' || faulted)
        return
      const node = o as Record<string, unknown>
      if (node.vdev_type === 'disk' && node.state === 'ONLINE') {
        node.state = 'FAULTED'
        faulted = String(node.name)
        return
      }
      for (const k of Object.keys(node)) walk(node[k])
    }
    walk(json)
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: JSON.stringify(json), stderr: '', exitCode: 0 } })
    const control = (await getJson<{ data: StatusSummary }>(server, '/v1/status')).body.data
    assert.ok((control.disks.critical ?? 0) >= 1, `control: the faulted leaf is critical (${faulted})`)
    await server.close()

    // The same world with the status read failing: nothing it could not judge is healthy.
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const disks = (await getJson<{ data: Disk[] }>(server, '/v1/disks')).body.data
    for (const d of disks) {
      if (d.status === 'ahr_member')
        continue // md's own answer stands; the mock world puts AHR on sdb-sdd
      assert.notEqual(d.healthStatus, 'healthy', `${d.name} (${d.status}) is not healthy from SMART alone`)
    }
    const status = (await getJson<{ data: StatusSummary }>(server, '/v1/status')).body.data
    assert.equal(status.disks.healthy, disks.filter(d => d.healthStatus === 'healthy').length)
  })

  it('a failed `zpool status` leaves NO disk `available` (pickers offer only what isComposableDisk accepts)', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const disks = (await getJson<{ data: Disk[] }>(server, '/v1/disks')).body.data
    assert.ok(disks.length > 0)
    for (const d of disks) {
      assert.notEqual(d.status, 'available', `${d.name} is not offered`)
      assert.equal(isComposableDisk(d), false, `${d.name} is not composable`)
    }
    assert.ok(disks.some(d => d.status === 'unknown'), 'a disk ZFS could not be asked about reads unknown')
  })

  it('an inventory that could not be read at all: every disk count is null, never zero', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: '', stderr: 'lsblk: failed to access sysfs directory', exitCode: 1 } })
    const { body } = await getJson<{ data: StatusSummary }>(server, '/v1/status')
    assert.deepEqual(body.data.disks, { total: null, healthy: null, warning: null, critical: null, unknown: null })
    assert.ok(body.data.unavailable?.includes('disks'))
  })

  it('the honest no-pools status (OpenZFS 2.4.x `zpool_do_status` -j: exit 0, `pools:{}`) leaves a blank disk `available` (control)', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: '{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}\n', stderr: '', exitCode: 0 } })
    const disks = (await getJson<{ data: Disk[] }>(server, '/v1/disks')).body.data
    assert.ok(!disks.some(d => d.status === 'unknown'))
  })

  it('an unreadable smb.conf is a null count and an incomplete shares section, never "0 shares"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anas-cr3-shares-'))
    try {
      // A directory where the config should be: readFile fails EISDIR (not
      // ENOENT, which is the honest "no shares yet").
      mkdirSync(join(dir, 'smb.conf'))
      const ex = new MockExecutor()
      const srv = Fastify({ logger: false })
      await srv.register(dashboardRoutes, {
        prefix: '/v1',
        executor: ex,
        jobQueue: new JobQueue(),
        diskIdentityCache: new DiskIdentityCache(ex),
        smbConfPath: join(dir, 'smb.conf'),
        exportsPath: join(dir, 'exports'),
        systemdDir: join(dir, 'systemd'),
        fstabPath: join(dir, 'fstab'),
      })
      const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: headers() })
      const data = (res.json() as { data: StatusSummary }).data
      await srv.close()
      assert.equal(data.shares.smbCount, null)
      assert.equal(data.shares.nfsCount, 0, 'a missing /etc/exports is the honest zero')
      assert.ok(data.unavailable?.includes('shares'))
      // The replication task store (the unit dir is absent here) could not be
      // listed: its section is unavailable, never "no failed tasks".
      assert.ok(data.unavailable?.includes('replication'))
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3 — readDashboardSection: a reported unreadable is unavailable, the value kept', () => {
  it('incomplete(reason) marks the section with the reason and keeps the value', async () => {
    const r = await readDashboardSection(new MockExecutor(), 1000, 'pools', [] as number[], async (_exec, incomplete) => {
      incomplete('zpool status -jv could not be read (exit 1)')
      return [1, 2]
    })
    assert.deepEqual(r.value, [1, 2])
    assert.deepEqual(r.unavailable, { section: 'pools', reason: 'zpool status -jv could not be read (exit 1)' })
  })

  it('a throw is the fallback plus the error as the reason', async () => {
    const r = await readDashboardSection(new MockExecutor(), 1000, 'mounts', [] as string[], async () => {
      throw new Error('findmnt exited 1')
    })
    assert.deepEqual(r.value, [])
    assert.equal(r.unavailable?.section, 'mounts')
    assert.match(r.unavailable!.reason, /findmnt exited 1/)
  })

  it('a read that reports nothing is available', async () => {
    const r = await readDashboardSection(new MockExecutor(), 1000, 'jobs', 0, async () => 7)
    assert.deepEqual(r, { value: 7 })
  })
})

describe('cr3 — GET /v1/telemetry: no invented vdev state, role or ARC (INVENTED-STATE-H2, -L11)', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a failed `zpool status` leaves every vdev without role or state — never ONLINE / data', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: ZPOOL, args: ['iostat', '-plv', '--', 'testpool', '1', '2'], result: mockFixtures.zpoolIostat() })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    mock.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const t = (await getJson<{ data: Telemetry }>(server, '/v1/telemetry')).body.data
    const pool = t.pools.find(p => p.name === 'testpool')
    assert.ok(pool && pool.vdevs.length > 0)
    for (const v of pool.vdevs) {
      assert.equal(v.state, undefined, `${v.name} has no state`)
      assert.equal(v.role, undefined, `${v.name} has no role`)
      assert.equal(v.type, 'mirror', 'the type is read from the vdev name ZFS composes')
    }
  })

  it('unreadable arcstats is a null ARC, never 0% of 0 B', () => {
    assert.equal(arcFromSnapshots(null, null), null)
    assert.equal(arcFromSnapshots('x', null), null)
  })
})

describe('cr3 — the pool readers: unreadable is 503, never [] or 404 (POOLS-DISKS-M4, INVENTED-STATE-M8, -L12)', () => {
  let server: Srv | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('GET /pools with a failed `zpool list` is 503 UNAVAILABLE naming the read', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: FAIL_LIST })
    const res = await getJson<{ error: { code: string, message: string } }>(server, '/v1/pools')
    assert.equal(res.statusCode, 503)
    assert.equal(res.body.error.code, 'UNAVAILABLE')
    assert.match(res.body.error.message, /zpool list -j could not be read/)
  })

  it('a pool whose reads all answered carries real booleans — Scrub, Trim and Upgrade stay offered (control)', async () => {
    server = createServer({ mock: true, logger: false })
    // The seeded mock world does not answer the discard read; a node always
    // does. Its shape: `lsblk -Jbno NAME,DISC-GRAN` (pools-trim-supported's).
    mockOf(server).prependFixture({ command: '/usr/bin/lsblk', args: LSBLK_DISCARD_ARGS, result: { stdout: JSON.stringify({ blockdevices: [{ 'name': 'sdb', 'disc-gran': 0 }] }), stderr: '', exitCode: 0 } })
    const res = await getJson<{ data: PoolSummary[] }>(server, '/v1/pools')
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.data.length > 0)
    for (const pool of res.body.data) {
      assert.equal(typeof pool.scanRunning, 'boolean', `${pool.name}.scanRunning`)
      assert.equal(typeof pool.trimSupported, 'boolean', `${pool.name}.trimSupported`)
      assert.equal(typeof pool.upgradeAvailable, 'boolean', `${pool.name}.upgradeAvailable`)
    }
    const status = (await getJson<{ data: StatusSummary }>(server, '/v1/status')).body.data
    for (const pool of status.pools)
      assert.equal(typeof pool.scanRunning, 'boolean', `/status ${pool.name}.scanRunning`)
    for (const [k, v] of Object.entries(status.disks))
      assert.equal(typeof v, 'number', `/status disks.${k}`)
  })

  it('GET /pools with no pools (OpenZFS 2.4.x `zpool_do_list` -j: exit 0, nothing printed) is the honest []', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await getJson<{ data: PoolSummary[] }>(server, '/v1/pools')
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data, [])
  })

  it('GET /pools with a failed status: scanRunning and trimSupported are null, never false', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const res = await getJson<{ data: PoolSummary[] }>(server, '/v1/pools')
    assert.equal(res.statusCode, 200)
    const pool = res.body.data.find(p => p.name === 'testpool')
    assert.ok(pool)
    assert.equal(pool.scanRunning, null)
    assert.equal(pool.trimSupported, null)
  })

  it('GET /pools with an unparseable discard table: trimSupported is null, never false', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: '/usr/bin/lsblk', args: LSBLK_DISCARD_ARGS, result: { stdout: 'garbage', stderr: '', exitCode: 0 } })
    const res = await getJson<{ data: PoolSummary[] }>(server, '/v1/pools')
    assert.equal(res.body.data.find(p => p.name === 'testpool')?.trimSupported, null)
  })

  it('GET /pools with a failed `zpool upgrade`: upgradeAvailable is null, never false', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['upgrade'], result: { stdout: '', stderr: 'internal error', exitCode: 1 } })
    const res = await getJson<{ data: PoolSummary[] }>(server, '/v1/pools')
    const pool = res.body.data.find(p => p.name === 'testpool')
    assert.ok(pool)
    assert.equal(pool.upgradeAvailable, null)
  })

  it('GET /pools/:name with a failed status is 503, never 404 for a live pool', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const res = await getJson<{ error: { code: string, message: string } }>(server, '/v1/pools/testpool')
    assert.equal(res.statusCode, 503)
    assert.equal(res.body.error.code, 'UNAVAILABLE')
    assert.match(res.body.error.message, /zpool status -jv could not be read/)
  })

  it('GET /pools/:name with a failed `zpool get all` is 503, never 404', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['get', 'all', '-j'], result: { stdout: '', stderr: 'internal error', exitCode: 1 } })
    const res = await getJson<{ error: { code: string } }>(server, '/v1/pools/testpool')
    assert.equal(res.statusCode, 503)
  })

  it('GET /pools/:name for a pool neither readable listing names is still 404', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await getJson<{ error: { code: string } }>(server, '/v1/pools/nosuchpool')
    assert.equal(res.statusCode, 404)
  })

  it('GET /pools/:name/expansion with a failed status is 503, never 404', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: FAIL_STATUS })
    const res = await getJson<{ error: { code: string } }>(server, '/v1/pools/testpool/expansion')
    assert.equal(res.statusCode, 503)
  })

  it('GET /pools/import with a failed scan is 503; zpool\'s "no pools available to import" is []', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['import'], result: { stdout: '', stderr: 'internal error: cannot read the device scan', exitCode: 1 } })
    const failed = await getJson<{ error: { code: string } }>(server, '/v1/pools/import')
    assert.equal(failed.statusCode, 503)
    assert.equal(failed.body.error.code, 'UNAVAILABLE')
    await server.close()

    server = createServer({ mock: true, logger: false })
    // OpenZFS 2.4.x `zpool_do_import`, nothing importable: exit 0, the sentence on stderr.
    mockOf(server).prependFixture({ command: ZPOOL, args: ['import'], result: { stdout: '', stderr: 'no pools available to import\n', exitCode: 0 } })
    const empty = await getJson<{ data: unknown[] }>(server, '/v1/pools/import')
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.body.data, [])
  })
})

describe('cr3 — a failed read of this node\'s LUNs only tightens the hands-off mark (iSCSI review)', () => {
  const iscsiDisk = { transport: 'iscsi', serial: '9bc6e907-6015-4f6a-9a50-1234567890ab', model: 'lun0' }

  it('an iSCSI disk is hands-off `iscsi-unverified` when the served serials could not be read', () => {
    const ctx = handsOffContext(iscsiDisk, null)
    assert.equal(ctx.handsOff, 'iscsi-unverified')
    assert.match(ctx.handsOffReason!, /could not read the LUNs this node serves/)
  })

  it('a local disk is never marked by that failure', () => {
    assert.deepEqual(handsOffContext({ transport: 'sata', serial: 'X', model: 'Y' }, null), {})
  })

  it('a readable empty set marks nothing (control)', () => {
    assert.deepEqual(handsOffContext(iscsiDisk, new Set()), {})
  })
})
