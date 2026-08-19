import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { lastScrubFromScan, parseLastScrubs, parseScrubScans, parseZpoolStatus, scrubRunningFromScan } from '../zpool-status.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs')

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}

describe('parseZpoolStatus', () => {
  it('parses ONLINE mirror pool with spare', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-online.json'))
    assert.equal(result.length, 1)
    const pool = result[0]
    assert.equal(pool.name, 'testpool')
    assert.equal(pool.state, 'ONLINE')
    assert.equal(pool.errorCount, 0)
    assert.equal(pool.health, undefined)

    // Data group — two mirrors
    const dataGroup = pool.vdevGroups.find(g => g.role === 'data')
    assert.ok(dataGroup)
    assert.equal(dataGroup.vdevs.length, 2)

    const mirror0 = dataGroup.vdevs[0]
    assert.equal(mirror0.name, 'mirror-0')
    assert.equal(mirror0.type, 'mirror')
    assert.equal(mirror0.state, 'ONLINE')
    assert.equal(mirror0.disks.length, 2)

    const mirror1 = dataGroup.vdevs[1]
    assert.equal(mirror1.name, 'mirror-1')
    assert.equal(mirror1.disks.length, 2)

    // Spare group
    const spareGroup = pool.vdevGroups.find(g => g.role === 'spare')
    assert.ok(spareGroup)
    assert.equal(spareGroup.vdevs[0].disks.length, 1)
    assert.equal(spareGroup.vdevs[0].disks[0].state, 'AVAIL')
  })

  it('parses ONLINE pool with finished scrub', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-online.json'))
    const pool = result[0]
    assert.ok(pool.scan)
    assert.equal(pool.scan.function, 'SCRUB')
    assert.equal(pool.scan.state, 'FINISHED')
    assert.ok(pool.scan.finishedAt)
    assert.ok(pool.scan.startedAt)
    assert.equal(pool.scan.errors, 0)
    assert.equal(pool.scan.percentComplete, 100)
  })

  it('parses fresh ONLINE pool (no scan)', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-online-fresh.json'))
    const pool = result[0]
    assert.equal(pool.scan, null)
  })

  it('parses DEGRADED pool with OFFLINE disk', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-degraded.json'))
    const pool = result[0]
    assert.equal(pool.state, 'DEGRADED')
    assert.ok(pool.health)
    assert.ok(pool.health.status.includes('taken offline'))

    const mirror = pool.vdevGroups[0].vdevs[0]
    assert.equal(mirror.state, 'DEGRADED')

    const offlineDisk = mirror.disks.find(d => d.state === 'OFFLINE')
    assert.ok(offlineDisk)
    assert.equal(offlineDisk.id, 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT2')
  })

  it('parses DEGRADED pool with REMOVED disk', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-degraded-removed.json'))
    const pool = result[0]
    assert.equal(pool.state, 'DEGRADED')

    const removedDisk = pool.vdevGroups[0].vdevs[0].disks.find(d => d.state === 'REMOVED')
    assert.ok(removedDisk)
  })

  it('parses SUSPENDED pool with errors', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-suspended.json'))
    const pool = result[0]
    assert.equal(pool.state, 'SUSPENDED')
    assert.equal(pool.errorCount, 4)
    assert.ok(pool.health)
    assert.ok(pool.health.msgId)
    assert.ok(pool.health.moreInfo)

    // Verify non-zero error counts on disks
    const mirror = pool.vdevGroups[0].vdevs[0]
    assert.ok(mirror.writeErrors > 0)
    const disk1 = mirror.disks.find(d => d.id === 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1')
    assert.ok(disk1)
    assert.ok(disk1.readErrors > 0 || disk1.writeErrors > 0)
  })

  it('parses pool with standing-by spare', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-with-spare.json'))
    const pool = result[0]
    assert.equal(pool.state, 'ONLINE')

    // Should have data group + spare group
    const dataGroup = pool.vdevGroups.find(g => g.role === 'data')
    const spareGroup = pool.vdevGroups.find(g => g.role === 'spare')
    assert.ok(dataGroup)
    assert.ok(spareGroup)
    assert.equal(spareGroup.vdevs[0].disks.length, 1)
    assert.equal(spareGroup.vdevs[0].disks[0].id, 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT3')
  })

  it('parses pool with activated spare', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-spare-active.json'))
    const pool = result[0]
    assert.equal(pool.state, 'DEGRADED')

    // Spare group should show INUSE
    const spareGroup = pool.vdevGroups.find(g => g.role === 'spare')
    assert.ok(spareGroup)
    const spareDisk = spareGroup.vdevs[0].disks[0]
    assert.equal(spareDisk.state, 'INUSE')

    // Data group should have the spare-1 virtual vdev
    const dataGroup = pool.vdevGroups.find(g => g.role === 'data')
    assert.ok(dataGroup)
    const mirror = dataGroup.vdevs[0]
    // Mirror contains spare-1 vdev which has the replaced + spare disks
    assert.ok(mirror.disks.length >= 2)
  })

  it('parses verbose (-v) error details', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-suspended-verbose.json'))
    const pool = result[0]
    assert.equal(pool.errorCount, 4)
    assert.ok(pool.errorDetail)
    assert.ok(pool.errorDetail.length > 0)
  })

  it('parses ONLINE raidz pool', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-raidz.json'))
    const pool = result[0]
    assert.equal(pool.name, 'testpool-rz')
    assert.equal(pool.state, 'ONLINE')

    const raidz = pool.vdevGroups[0].vdevs[0]
    assert.equal(raidz.type, 'raidz')
    assert.equal(raidz.disks.length, 3)
  })

  it('parses DEGRADED raidz pool', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-raidz-degraded.json'))
    const pool = result[0]
    assert.equal(pool.state, 'DEGRADED')

    const raidz = pool.vdevGroups[0].vdevs[0]
    assert.equal(raidz.state, 'DEGRADED')
    const removedDisk = raidz.disks.find(d => d.state === 'REMOVED')
    assert.ok(removedDisk)
  })

  it('parses pool with in-progress scrub', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-scrubbing.json'))
    const pool = result[0]
    assert.ok(pool.scan)
    assert.equal(pool.scan.function, 'SCRUB')
    assert.equal(pool.scan.state, 'SCANNING')
    assert.equal(pool.scan.finishedAt, null)
    assert.ok(pool.scan.totalBytes > 0)
  })

  it('parses pool with finished resilver', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-resilvering.json'))
    const pool = result[0]
    assert.ok(pool.scan)
    assert.equal(pool.scan.function, 'RESILVER')
    assert.equal(pool.scan.state, 'FINISHED')
  })

  it('outputs validate against PoolDetail schema (structural spot-check)', () => {
    // Verify key fields match the expected types from PoolDetail
    const fixtures = [
      'zpool-status-online.json',
      'zpool-status-degraded.json',
      'zpool-status-suspended.json',
      'zpool-status-raidz.json',
    ]
    for (const f of fixtures) {
      const pools = parseZpoolStatus(loadFixture(f))
      for (const pool of pools) {
        assert.equal(typeof pool.name, 'string')
        assert.ok(pool.name.length > 0)
        assert.equal(typeof pool.state, 'string')
        assert.equal(typeof pool.guid, 'string')
        assert.equal(typeof pool.errorCount, 'number')
        assert.ok(Array.isArray(pool.vdevGroups))
        for (const group of pool.vdevGroups) {
          assert.equal(typeof group.role, 'string')
          for (const vdev of group.vdevs) {
            assert.equal(typeof vdev.name, 'string')
            assert.equal(typeof vdev.type, 'string')
            for (const disk of vdev.disks) {
              assert.equal(typeof disk.id, 'string')
              assert.equal(typeof disk.readErrors, 'number')
            }
          }
        }
      }
    }
  })

  // Regression: on a real system `zpool status -jv` reports the leaf `name` as
  // the KERNEL device ("sdb"), which is unstable and must never be the disk's
  // identity. The stable by-id comes from `devid`. If parseDisk used `name`,
  // the disk list could not match pool members to by-id and would class active
  // pool disks as 'available' (a real bug — a user could pick in-use disks).
  it('derives disk id from the stable by-id (devid), never the kernel name', () => {
    const status = {
      pools: {
        tank: {
          name: 'tank',
          vdev_type: 'root',
          pool_guid: '1',
          state: 'ONLINE',
          vdevs: {
            'mirror-0': {
              name: 'mirror-0',
              vdev_type: 'mirror',
              state: 'ONLINE',
              vdevs: {
                // Leaf named by the (unstable) kernel device, with the by-id in devid.
                sdb: {
                  name: 'sdb',
                  vdev_type: 'disk',
                  state: 'ONLINE',
                  path: '/dev/sdb1',
                  devid: 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1-part1',
                },
              },
            },
          },
        },
      },
    }
    const [pool] = parseZpoolStatus(JSON.stringify(status))
    const disk = pool.vdevGroups[0].vdevs[0].disks[0]
    assert.equal(disk.id, 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1')
    assert.notEqual(disk.id, 'sdb')
  })
})

// The verdict half of the same scan record: what the Scrubs screen reports as
// "last scrub". Every completed form ZFS can print, from the real captures where
// they exist and from the canonical fixture where producing one would mean
// damaging a pool (repairs / errors / cancel — see its `_comment`).
describe('lastScrubFromScan — the completed-pass verdict', () => {
  it('a finished clean scrub: repaired 0, 0 errors, real duration + end date', () => {
    const [pool] = parseZpoolStatus(loadFixture('zpool-status-online.json'))
    const last = lastScrubFromScan(pool.scan)
    assert.ok(last)
    assert.equal(last.function, 'SCRUB')
    assert.equal(last.state, 'FINISHED')
    assert.equal(last.repairedBytes, 0)
    assert.equal(last.errors, 0)
    assert.equal(last.finishedAt, '2026-03-15T02:09:34.000Z')
    // 02:00:00 → 02:09:34 = 9m34s, the "in 00:09:34" ZFS prints.
    assert.equal(last.durationSeconds, 574)
  })

  it('a finished scrub that repaired bytes and found errors reports both', () => {
    const byPool = parseLastScrubs(loadFixture('zpool-status-scrub-verdicts.json'))
    const last = byPool.get('repairpool')
    assert.ok(last)
    assert.equal(last.state, 'FINISHED')
    assert.equal(last.repairedBytes, 1572864) // ZFS `processed` "1.50M"
    assert.equal(last.errors, 2)
    assert.equal(last.durationSeconds, 19391) // 02:00:00 → 07:23:11
  })

  it('a canceled scrub is reported as canceled (a partial pass, not a clean bill)', () => {
    const byPool = parseLastScrubs(loadFixture('zpool-status-scrub-verdicts.json'))
    const last = byPool.get('cancelpool')
    assert.ok(last)
    assert.equal(last.state, 'CANCELED')
    assert.equal(last.errors, 0)
    assert.equal(last.finishedAt, '2026-08-03T02:41:07.000Z')
    assert.equal(last.durationSeconds, 2467)
  })

  it('a finished resilver is reported as a resilver, not a scrub', () => {
    const [pool] = parseZpoolStatus(loadFixture('zpool-status-resilvering.json'))
    const last = lastScrubFromScan(pool.scan)
    assert.ok(last)
    assert.equal(last.function, 'RESILVER')
    assert.equal(last.state, 'FINISHED')
    assert.equal(last.repairedBytes, 18432) // "18K"
  })

  it('a scrub still in progress has no verdict yet → null', () => {
    const [pool] = parseZpoolStatus(loadFixture('zpool-status-scrubbing.json'))
    assert.equal(pool.scan?.state, 'SCANNING')
    assert.equal(lastScrubFromScan(pool.scan), null)
  })

  it('a pool with no scan record ("none requested") → null, never fabricated', () => {
    const [pool] = parseZpoolStatus(loadFixture('zpool-status-online-fresh.json'))
    assert.equal(pool.scan, null)
    assert.equal(lastScrubFromScan(pool.scan), null)
  })

  it('a NONE scan state → null', () => {
    assert.equal(lastScrubFromScan({
      function: 'SCRUB',
      state: 'NONE',
      startedAt: '2026-08-03T02:00:00.000Z',
      finishedAt: '2026-08-03T02:00:00.000Z',
      totalBytes: 0,
      examinedBytes: 0,
      processedBytes: 0,
      errors: 0,
      percentComplete: 0,
    }), null)
  })

  it('an unrecorded start time yields duration 0, not a 56-year scrub', () => {
    const last = lastScrubFromScan({
      function: 'SCRUB',
      state: 'FINISHED',
      // What parseScanStats substitutes when ZFS recorded no start time.
      startedAt: new Date(0).toISOString(),
      finishedAt: '2026-08-03T02:41:07.000Z',
      totalBytes: 0,
      examinedBytes: 0,
      processedBytes: 0,
      errors: 0,
      percentComplete: 0,
    })
    assert.ok(last)
    assert.equal(last.durationSeconds, 0)
  })

  it('parseLastScrubs keys every pool in one status read', () => {
    const byPool = parseLastScrubs(loadFixture('zpool-status-scrub-verdicts.json'))
    assert.deepEqual([...byPool.keys()], ['repairpool', 'cancelpool'])
  })
})

// The OTHER half of the same record (Epic 17 stage 6): while a pass runs there
// is no verdict yet, and the Scrubs screen shows the progress instead of going
// quiet. Same scan record, same single status read — nothing new is executed.
describe('scrubRunningFromScan — the pass in flight', () => {
  it('a running scrub is reported with its function and percent', () => {
    const [pool] = parseZpoolStatus(loadFixture('zpool-status-scrubbing.json'))
    const running = scrubRunningFromScan(pool.scan)
    assert.ok(running)
    assert.equal(running.function, 'SCRUB')
    // examined == to_examine in this capture (a tiny pool caught at the end).
    assert.equal(running.percent, 100)
    // ZFS's scan record carries NO rate and NO time-to-go — we do not invent them.
    assert.equal(running.speedBytesSec, undefined)
    assert.equal(running.etaSeconds, undefined)
  })

  it('a mid-pass scan reports the derived percentage', () => {
    const running = scrubRunningFromScan({
      function: 'SCRUB',
      state: 'SCANNING',
      startedAt: '2026-08-03T02:00:00.000Z',
      finishedAt: null,
      totalBytes: 1000,
      examinedBytes: 432,
      processedBytes: 0,
      errors: 0,
      percentComplete: 43.2,
    })
    assert.deepEqual(running, { function: 'SCRUB', percent: 43.2 })
  })

  it('a running RESILVER is named as one (it is not a scrub, and cannot be stopped)', () => {
    const running = scrubRunningFromScan({
      function: 'RESILVER',
      state: 'SCANNING',
      startedAt: '2026-08-03T02:00:00.000Z',
      finishedAt: null,
      totalBytes: 1000,
      examinedBytes: 100,
      processedBytes: 0,
      errors: 0,
      percentComplete: 10,
    })
    assert.equal(running?.function, 'RESILVER')
  })

  it('nothing to examine → no percent at all (0% would read as a stalled pass)', () => {
    const running = scrubRunningFromScan({
      function: 'SCRUB',
      state: 'SCANNING',
      startedAt: '2026-08-03T02:00:00.000Z',
      finishedAt: null,
      totalBytes: 0,
      examinedBytes: 0,
      processedBytes: 0,
      errors: 0,
      percentComplete: 0,
    })
    assert.deepEqual(running, { function: 'SCRUB' })
  })

  it('a finished pass and a pool with no scan record are both "not running"', () => {
    const [finished] = parseZpoolStatus(loadFixture('zpool-status-online.json'))
    assert.equal(scrubRunningFromScan(finished.scan), null)
    const [fresh] = parseZpoolStatus(loadFixture('zpool-status-online-fresh.json'))
    assert.equal(scrubRunningFromScan(fresh.scan), null)
  })

  it('parseScrubScans reads BOTH halves per pool from one status read', () => {
    // Running: progress, and deliberately no verdict (the previous pass's
    // record is already overwritten — ZFS keeps exactly one).
    const scanning = parseScrubScans(loadFixture('zpool-status-scrubbing.json')).get('testpool-rz')
    assert.equal(scanning?.running?.function, 'SCRUB')
    assert.equal(scanning?.lastScrub, null)

    // Idle: the stage-5 verdict, untouched, and nothing running.
    const verdicts = parseScrubScans(loadFixture('zpool-status-scrub-verdicts.json'))
    assert.deepEqual([...verdicts.keys()], ['repairpool', 'cancelpool'])
    assert.equal(verdicts.get('repairpool')?.running, null)
    assert.equal(verdicts.get('repairpool')?.lastScrub?.errors, 2)
    assert.equal(verdicts.get('cancelpool')?.lastScrub?.state, 'CANCELED')

    // Never scrubbed, never scrubbing: both halves honestly absent.
    const fresh = parseScrubScans(loadFixture('zpool-status-online-fresh.json'))
    assert.deepEqual([...fresh.values()], [{ lastScrub: null, running: null }])
  })
})
