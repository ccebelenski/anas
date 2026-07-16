import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks } from '../disks.js'

/**
 * Regression suite for the device-identifier mismatch bug: on real hardware a
 * disk has several by-id names, ZFS's `devid` picks one, our disk parser picks
 * the highest-priority one, and the two need not be equal. The join must
 * canonicalize BOTH sides to the kernel device. These cases are exactly what a
 * single-by-id QEMU node can never reproduce.
 */

// Every by-id form for each physical disk → its kernel device. On real
// hardware a SATA disk exposes BOTH an ata-… and a wwn-… symlink.
const BY_ID_LISTING = [
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 ata-WDC_HET_0001 -> ../../sdb',
  'lrwxrwxrwx 1 root root 10 Jul 16 10:00 ata-WDC_HET_0001-part1 -> ../../sdb1',
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 wwn-0x50000000000001 -> ../../sdb',
  'lrwxrwxrwx 1 root root 10 Jul 16 10:00 wwn-0x50000000000001-part1 -> ../../sdb1',
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 ata-WDC_KERNEL_0002 -> ../../sdc',
  'lrwxrwxrwx 1 root root 10 Jul 16 10:00 ata-WDC_KERNEL_0002-part1 -> ../../sdc1',
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 scsi-SATA_DISK_0003 -> ../../sdd',
  'lrwxrwxrwx 1 root root 10 Jul 16 10:00 scsi-SATA_DISK_0003-part1 -> ../../sdd1',
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 wwn-0x50000000000003 -> ../../sdd',
  'lrwxrwxrwx 1 root root 13 Jul 16 10:00 nvme-Samsung_SSD_990_0004 -> ../../nvme0n1',
  'lrwxrwxrwx 1 root root 15 Jul 16 10:00 nvme-Samsung_SSD_990_0004-part1 -> ../../nvme0n1p1',
  'lrwxrwxrwx 1 root root 13 Jul 16 10:00 nvme-eui.00250000000004 -> ../../nvme0n1',
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 scsi-0QEMU_QEMU_HARDDISK_drive0 -> ../../sde',
  'lrwxrwxrwx 1 root root 10 Jul 16 10:00 scsi-0QEMU_QEMU_HARDDISK_drive0-part1 -> ../../sde1',
  'lrwxrwxrwx 1 root root 9 Jul 16 10:00 wwn-0x50000000000005 -> ../../sde',
  '',
].join('\n')

const LSBLK_JSON = JSON.stringify({
  blockdevices: [
    disk('sdb', 'WD-HET1'),
    disk('sdc', 'WD-KERNEL2'),
    disk('sdd', 'SATA3'),
    nvmeDisk('nvme0n1', 'NVME4'),
    disk('sde', 'QEMU5'),
  ],
})

function disk(name: string, serial: string) {
  return {
    'name': name,
    'type': 'disk',
    'size': 268435456000,
    'model': 'TEST DISK',
    'serial': serial,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 4096,
    'log-sec': 512,
    'children': [{ name: `${name}1`, type: 'part', size: 268300615680, fstype: 'zfs_member', mountpoint: null }],
  }
}

function nvmeDisk(name: string, serial: string) {
  return {
    'name': name,
    'type': 'disk',
    'size': 512110190592,
    'model': 'TEST NVME',
    'serial': serial,
    'tran': 'nvme',
    'fstype': null,
    'mountpoint': null,
    'rota': false,
    'phy-sec': 512,
    'log-sec': 512,
    'children': [{ name: `${name}p1`, type: 'part', size: 512000000000, fstype: 'zfs_member', mountpoint: null }],
  }
}

/** A single-disk (stripe) top-level vdev leaf. */
function leaf(fields: { name: string, path: string, devid?: string }) {
  return {
    name: fields.name,
    vdev_type: 'disk',
    state: 'ONLINE',
    path: fields.path,
    ...(fields.devid ? { devid: fields.devid } : {}),
    read_errors: '0',
    write_errors: '0',
    checksum_errors: '0',
    slow_ios: '0',
  }
}

// hetpool: a stripe whose leaves exercise every resolution path.
const ZPOOL_STATUS_JSON = JSON.stringify({
  pools: {
    hetpool: {
      name: 'hetpool',
      state: 'ONLINE',
      pool_guid: '111',
      error_count: '0',
      vdevs: {
        hetpool: {
          name: 'hetpool',
          vdev_type: 'root',
          state: 'ONLINE',
          read_errors: '0',
          write_errors: '0',
          checksum_errors: '0',
          vdevs: {
            // (1) HETEROGENEOUS: ZFS's devid is the wwn- form; our disk parser
            //     picks the higher-priority ata- form. Different strings.
            'sdb-leaf': leaf({
              name: 'wwn-0x50000000000001',
              path: '/dev/disk/by-id/wwn-0x50000000000001-part1',
              devid: 'wwn-0x50000000000001-part1',
            }),
            // (2) KERNEL-NAME leaf: no devid, kernel name + /dev/sdX1 path.
            'sdc-leaf': leaf({ name: 'sdc', path: '/dev/sdc1' }),
            // (3) PARTITION-suffix by-id leaf (scsi- form, -part1).
            'sdd-leaf': leaf({
              name: 'scsi-SATA_DISK_0003',
              path: '/dev/disk/by-id/scsi-SATA_DISK_0003-part1',
              devid: 'scsi-SATA_DISK_0003-part1',
            }),
            // (4) NVMe leaf → nvme0n1 (partition nvme0n1p1).
            'nvme-leaf': leaf({
              name: 'nvme-Samsung_SSD_990_0004',
              path: '/dev/disk/by-id/nvme-Samsung_SSD_990_0004-part1',
              devid: 'nvme-Samsung_SSD_990_0004-part1',
            }),
            // (R) REGRESSION: QEMU-style scsi- devid == our highest-priority id.
            'sde-leaf': leaf({
              name: 'scsi-0QEMU_QEMU_HARDDISK_drive0',
              path: '/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive0-part1',
              devid: 'scsi-0QEMU_QEMU_HARDDISK_drive0-part1',
            }),
          },
        },
      },
    },
  },
})

function makeExecutor(): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: LSBLK_JSON, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID_LISTING, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: ZPOOL_STATUS_JSON, stderr: '', exitCode: 0 } })
  // smartctl is left unfixtured → empty identity (fail-open), fine for join.
  return mock
}

async function collect(): Promise<Map<string, Disk>> {
  const mock = makeExecutor()
  const disks = await collectDisks(mock, new DiskIdentityCache(mock))
  return new Map(disks.map(d => [d.name, d]))
}

describe('collectDisks — disk↔pool join canonicalizes to the kernel device', () => {
  it('matches a HETEROGENEOUS disk (ZFS devid wwn-…, display id ata-…) to its pool', async () => {
    const byName = await collect()
    const sdb = byName.get('sdb')!
    assert.ok(sdb)
    // Display id is unchanged — still the highest-priority by-id (ata-…).
    assert.equal(sdb.id, 'ata-WDC_HET_0001')
    // …yet it IS matched to the pool, even though ZFS reported the wwn- form.
    // (Before the fix these two facts could not both hold — the join dropped.)
    assert.equal(sdb.poolName, 'hetpool')
    assert.equal(sdb.status, 'pool_member')
    assert.equal(sdb.vdevName, 'wwn-0x50000000000001')
    assert.equal(sdb.vdevRole, 'data')
  })

  it('matches a leaf referenced by kernel name (name: sdc, path: /dev/sdc1)', async () => {
    const byName = await collect()
    const sdc = byName.get('sdc')!
    assert.equal(sdc.poolName, 'hetpool')
    assert.equal(sdc.status, 'pool_member')
  })

  it('matches a partition-suffix by-id leaf (scsi-…-part1)', async () => {
    const byName = await collect()
    const sdd = byName.get('sdd')!
    assert.equal(sdd.poolName, 'hetpool')
    assert.equal(sdd.status, 'pool_member')
  })

  it('matches an nvme leaf (nvme-… → nvme0n1, partition nvme0n1p1)', async () => {
    const byName = await collect()
    const nvme = byName.get('nvme0n1')!
    assert.equal(nvme.poolName, 'hetpool')
    assert.equal(nvme.status, 'pool_member')
  })

  it('regression: a QEMU-style scsi- leaf (devid == highest-priority id) still matches', async () => {
    const byName = await collect()
    const sde = byName.get('sde')!
    assert.equal(sde.id, 'scsi-0QEMU_QEMU_HARDDISK_drive0')
    assert.equal(sde.poolName, 'hetpool')
    assert.equal(sde.status, 'pool_member')
  })

  it('every pool leaf resolves — no disk is left without pool membership', async () => {
    const byName = await collect()
    for (const name of ['sdb', 'sdc', 'sdd', 'nvme0n1', 'sde'])
      assert.equal(byName.get(name)!.poolName, 'hetpool', `${name} matched`)
  })
})
