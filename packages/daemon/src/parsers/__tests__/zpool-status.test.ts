import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PoolDetail } from '@anas/shared'
import { parseZpoolStatus } from '../zpool-status.js'

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
})
