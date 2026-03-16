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
  it('parses ONLINE mirror pool', () => {
    const result = parseZpoolStatus(loadFixture('zpool-status-online.json'))
    assert.equal(result.length, 1)
    const pool = result[0]
    assert.equal(pool.name, 'testpool')
    assert.equal(pool.state, 'ONLINE')
    assert.equal(pool.errorCount, 0)
    assert.equal(pool.health, undefined)

    // Vdev groups
    assert.equal(pool.vdevGroups.length, 1)
    const dataGroup = pool.vdevGroups[0]
    assert.equal(dataGroup.role, 'data')
    assert.equal(dataGroup.vdevs.length, 1)

    // Mirror vdev
    const mirror = dataGroup.vdevs[0]
    assert.equal(mirror.name, 'mirror-0')
    assert.equal(mirror.type, 'mirror')
    assert.equal(mirror.state, 'ONLINE')
    assert.equal(mirror.disks.length, 2)

    // Disks
    const disk1 = mirror.disks[0]
    assert.equal(disk1.id, 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1')
    assert.equal(disk1.state, 'ONLINE')
    assert.equal(disk1.readErrors, 0)
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
