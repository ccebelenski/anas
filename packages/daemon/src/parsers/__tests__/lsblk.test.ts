import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDiskByIdListing } from '../disk-by-id.js'
import { parseLsblk } from '../lsblk.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/system')

function loadJson(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}
function loadText(name: string) {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseLsblk', () => {
  it('parses all physical disks', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const names = disks.map(d => d.name)
    assert.ok(names.includes('sda'))
    assert.ok(names.includes('sdb'))
    assert.ok(names.includes('sdf'))
    assert.equal(disks.length, 6)
  })

  it('identifies system disk', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sda = disks.find(d => d.name === 'sda')
    assert.ok(sda)
    assert.equal(sda.status, 'system')
  })

  it('identifies pool member disks', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    // poolDisks is keyed by KERNEL name (the caller canonicalizes zpool-status
    // leaves to their kernel device before handing the map to parseLsblk).
    const poolDisks = new Map([
      ['sdb', 'testpool'],
      ['sdc', 'testpool'],
    ])
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap, poolDisks)

    const sdb = disks.find(d => d.name === 'sdb')
    assert.ok(sdb)
    assert.equal(sdb.status, 'pool_member')
    assert.equal(sdb.poolName, 'testpool')
  })

  it('identifies available (unused) disks', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sdf = disks.find(d => d.name === 'sdf')
    assert.ok(sdf)
    assert.equal(sdf.status, 'available')
    assert.equal(sdf.poolName, null)
  })

  it('does NOT mark a disk with a leftover zfs_member label as available', () => {
    // A disk freed from a destroyed/exported pool keeps a zfs_member label but
    // is in no active pool. It must be classed 'other' (not empty), so the
    // vdev-creation picker never offers it — the user must wipe it first.
    const input = {
      blockdevices: [{
        name: 'sdz',
        type: 'disk',
        size: 512_000_000,
        children: [
          { name: 'sdz1', fstype: 'zfs_member', mountpoint: null },
          { name: 'sdz9', fstype: null, mountpoint: null },
        ],
      }],
    }
    const [disk] = parseLsblk(JSON.stringify(input), new Map())
    assert.equal(disk.status, 'other')
    assert.notEqual(disk.status, 'available')
  })

  it('parses disk properties correctly', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sdb = disks.find(d => d.name === 'sdb')
    assert.ok(sdb)
    assert.equal(sdb.size, 268435456000)
    assert.ok(sdb.model?.includes('WDC'))
    assert.equal(sdb.serial, 'WD-12345678')
    assert.equal(sdb.transport, 'sata')
    assert.equal(sdb.rotational, true)
  })

  it('parses partitions', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sda = disks.find(d => d.name === 'sda')
    assert.ok(sda)
    assert.ok(sda.partitions.length >= 2)

    const rootPart = sda.partitions.find(p => p.mountpoint === '/')
    assert.ok(rootPart)
    assert.equal(rootPart.fstype, 'ext4')
  })

  it('all sizes are numbers', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    for (const disk of disks) {
      assert.equal(typeof disk.size, 'number')
      for (const part of disk.partitions) {
        assert.equal(typeof part.size, 'number')
      }
    }
  })
})

/**
 * Issue #29: a Ceph OSD disk is IN USE and must classify 'ceph_osd', not fall
 * through to 'other' (which reads as leftover partitions). The fixture is the
 * live shape from a converged PVE/Ceph node — LVM2_member disk, Ceph LV
 * beneath — with the four cases the two-signal detection has to separate.
 */
describe('parseLsblk — Ceph OSD disks (issue #29)', () => {
  function cephDisks() {
    const disks = parseLsblk(loadJson('lsblk-ceph.json'), new Map())
    return new Map(disks.map(d => [d.name, d]))
  }

  it('a whole-disk OSD (ceph_bluestore LV) reads ceph_osd', () => {
    const nvme0 = cephDisks().get('nvme0n1')!
    assert.ok(nvme0)
    assert.equal(nvme0.status, 'ceph_osd')
    // Ceph names no pool ANAS can see — the ZFS/AHR fields stay null.
    assert.equal(nvme0.poolName, null)
    assert.equal(nvme0.ahrArray, null)
  })

  it('a ceph-- LV with no bluestore label (DB/WAL device) still reads ceph_osd', () => {
    const nvme1 = cephDisks().get('nvme1n1')!
    assert.equal(nvme1.status, 'ceph_osd')
  })

  it('an OSD on a partition reads ceph_osd (the walk nests part → lvm)', () => {
    const sdb = cephDisks().get('sdb')!
    assert.equal(sdb.status, 'ceph_osd')
  })

  it('a plain LVM2_member disk with a non-ceph VG stays other', () => {
    const sdc = cephDisks().get('sdc')!
    assert.equal(sdc.status, 'other')
  })

  it('a system disk carrying a Ceph LV is still system (system wins)', () => {
    const sda = cephDisks().get('sda')!
    assert.equal(sda.status, 'system')
  })

  it('a ZFS pool claim outranks the Ceph signal', () => {
    // Impossible in practice, but the ladder must be deterministic: a live pool
    // membership is authoritative over an on-disk Ceph signature.
    const disks = parseLsblk(loadJson('lsblk-ceph.json'), new Map(), new Map([['nvme0n1', 'tank']]))
    const nvme0 = disks.find(d => d.name === 'nvme0n1')!
    assert.equal(nvme0.status, 'pool_member')
    assert.equal(nvme0.poolName, 'tank')
  })

  it('a node with no Ceph is unaffected — zero matches', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)
    assert.equal(disks.filter(d => d.status === 'ceph_osd').length, 0)
  })
})
