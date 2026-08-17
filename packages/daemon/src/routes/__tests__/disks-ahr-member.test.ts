import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks } from '../disks.js'

/**
 * Issue #3 regression: AHR (mdadm-backed) member disks must classify as
 * 'ahr_member' — grouped by their AHR pool + band array — NOT fall through to
 * 'other' as they did when the disks endpoint only knew ZFS membership. The AHR
 * membership is sourced from readAhrPools (single source), so this reuses the
 * stage-0 `ahr0` AHR fixtures verbatim and layers on a flat disks-view world
 * that ALSO carries a ZFS pool member, a Ceph OSD (issue #29) and a
 * genuinely-free disk, proving the classifications coexist and that the AHR
 * enrichment claims only its own disks.
 *
 * The `ahr0` pool (from the fixtures): sdb slices band 1 only, sdc bands 1–2,
 * sdd bands 1–3 (band 3 is a labeled-but-not-yet-arrayed slice).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ahrFixtures = join(__dirname, '../../fixtures/ahr')
function ahrFixture(name: string): string {
  return readFileSync(join(ahrFixtures, name), 'utf-8')
}
function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

// The disks-view FLAT lsblk (LSBLK_ARGS) — physical disks only. The three AHR
// members carry raid-member partitions (so, absent the AHR classification, they
// would read 'other'); sde is a ZFS pool member; sdf is genuinely blank.
function flatPart(name: string, fstype: string | null) {
  return { name, type: 'part', size: 1072676352, fstype, mountpoint: null }
}
function flatDisk(name: string, serial: string, parts: object[]) {
  return {
    'name': name,
    'type': 'disk',
    'size': 1073741824,
    'model': 'QEMU HARDDISK',
    'serial': serial,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'wwn': null,
    'vendor': 'QEMU',
    'rev': '2.5+',
    'children': parts,
  }
}

const FLAT_LSBLK = JSON.stringify({
  blockdevices: [
    flatDisk('sdb', 'ANAS_HOT1', [flatPart('sdb1', 'linux_raid_member')]),
    flatDisk('sdc', 'ANAS_HOT2', [flatPart('sdc1', 'linux_raid_member'), flatPart('sdc2', 'linux_raid_member')]),
    flatDisk('sdd', 'ANAS_HOT3', [
      flatPart('sdd1', 'linux_raid_member'),
      flatPart('sdd2', 'linux_raid_member'),
      flatPart('sdd3', null),
    ]),
    // A ZFS pool member — must still classify 'pool_member', not AHR.
    flatDisk('sde', 'ZFS_MEMBER', [flatPart('sde1', 'zfs_member')]),
    // A genuinely blank disk — must stay 'available'.
    flatDisk('sdf', 'BLANK', []),
    // A Ceph OSD (issue #29) — the AHR enrichment must not stomp it.
    flatDisk('sdg', 'CEPH_OSD', [{
      name: 'sdg1',
      type: 'part',
      size: 1072676352,
      fstype: 'LVM2_member',
      mountpoint: null,
      children: [{
        name: 'ceph--aaaaaaaa--1111--2222--3333--444444444444-osd--block--bbbbbbbb--5555--6666--7777--888888888888',
        type: 'lvm',
        size: 1072676352,
        fstype: 'ceph_bluestore',
        mountpoint: null,
      }],
    }]),
  ],
})

// by-id listing: the AHR fixture's three disks + sde/sdf for the ZFS/free disks.
const BY_ID = `${ahrFixture('disk-by-id-ahr.txt').trimEnd()}
lrwxrwxrwx 1 root root   9 Jul 22 22:43 scsi-0QEMU_QEMU_HARDDISK_ZFS_MEMBER -> ../../sde
lrwxrwxrwx 1 root root  10 Jul 22 22:44 scsi-0QEMU_QEMU_HARDDISK_ZFS_MEMBER-part1 -> ../../sde1
lrwxrwxrwx 1 root root   9 Jul 22 22:43 scsi-0QEMU_QEMU_HARDDISK_BLANK -> ../../sdf
`

// A single-disk (stripe) ZFS pool 'tank' whose leaf is sde (kernel-name path).
const ZPOOL_STATUS = JSON.stringify({
  pools: {
    tank: {
      name: 'tank',
      state: 'ONLINE',
      pool_guid: '9',
      error_count: '0',
      vdevs: {
        tank: {
          name: 'tank',
          vdev_type: 'root',
          state: 'ONLINE',
          read_errors: '0',
          write_errors: '0',
          checksum_errors: '0',
          vdevs: {
            'sde-leaf': {
              name: 'sde',
              vdev_type: 'disk',
              state: 'ONLINE',
              path: '/dev/sde1',
              read_errors: '0',
              write_errors: '0',
              checksum_errors: '0',
              slow_ios: '0',
            },
          },
        },
      },
    },
  },
})

function makeExecutor(opts: { breakAhr?: boolean } = {}): MockExecutor {
  const mock = new MockExecutor()
  // --- disks-view reads ---
  mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: ok(FLAT_LSBLK) })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID) })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: ok(ZPOOL_STATUS) })
  // --- AHR topology reads (readAhrPools) — the stage-0 ahr0 fixtures ---
  // breakAhr makes mdstat unreadable so readAhrPools bails (fail-soft path).
  mock.addFixture({
    command: '/usr/bin/cat',
    args: MDSTAT_CAT_ARGS,
    result: opts.breakAhr ? { stdout: '', stderr: 'boom', exitCode: 1 } : ok(ahrFixture('mdstat-clean.txt')),
  })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(ahrFixture('mdadm-export-r1.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(ahrFixture('mdadm-export-r2.txt')) })
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(ahrFixture('lsblk-ahr0.json')) })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(ahrFixture('lvm-vgs.json')) })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(ahrFixture('lvm-lvs.json')) })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(ahrFixture('findmnt-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(ahrFixture('btrfs-usage.txt')) })
  // smartctl left unfixtured → empty identity (fail-open), fine for classification.
  return mock
}

async function collect(): Promise<Map<string, Disk>> {
  const mock = makeExecutor()
  const disks = await collectDisks(mock, new DiskIdentityCache(mock))
  return new Map(disks.map(d => [d.name, d]))
}

describe('collectDisks — AHR members classify as ahr_member (issue #3)', () => {
  it('an AHR member on a single band reads ahr_member + pool + "r1"', async () => {
    const sdb = (await collect()).get('sdb')!
    assert.ok(sdb)
    assert.equal(sdb.status, 'ahr_member')
    assert.equal(sdb.poolName, 'ahr0')
    assert.equal(sdb.ahrArray, 'r1')
    // ZFS-only fields stay null for an AHR member (visible divergence).
    assert.equal(sdb.vdevName, null)
    assert.equal(sdb.vdevRole, null)
    assert.equal(sdb.zfsErrors, null)
  })

  it('an AHR member spanning bands reads the band range, never "other"', async () => {
    const byName = await collect()
    const sdc = byName.get('sdc')!
    assert.equal(sdc.status, 'ahr_member')
    assert.equal(sdc.poolName, 'ahr0')
    assert.equal(sdc.ahrArray, 'r1-r2')

    const sdd = byName.get('sdd')!
    assert.equal(sdd.status, 'ahr_member')
    assert.equal(sdd.poolName, 'ahr0')
    assert.equal(sdd.ahrArray, 'r1-r3')
  })

  it('a ZFS pool member still classifies pool_member, not ahr_member', async () => {
    const sde = (await collect()).get('sde')!
    assert.equal(sde.status, 'pool_member')
    assert.equal(sde.poolName, 'tank')
    assert.equal(sde.ahrArray, null)
  })

  it('a genuinely blank disk stays available (AHR never widens the free set)', async () => {
    const sdf = (await collect()).get('sdf')!
    assert.equal(sdf.status, 'available')
    assert.equal(sdf.poolName, null)
    assert.equal(sdf.ahrArray, null)
  })

  it('a Ceph OSD stays ceph_osd through the AHR enrichment (issue #29)', async () => {
    const sdg = (await collect()).get('sdg')!
    assert.equal(sdg.status, 'ceph_osd')
    assert.equal(sdg.poolName, null)
    assert.equal(sdg.ahrArray, null)
  })

  it('fail-soft: an AHR read error leaves members as their pre-AHR status', async () => {
    // Break the AHR read (mdstat unreadable) — collectDisks must not crash and
    // the former-AHR disks fall through to 'other' exactly as before the fix.
    const mock = makeExecutor({ breakAhr: true })
    const disks = await collectDisks(mock, new DiskIdentityCache(mock))
    const byName = new Map(disks.map(d => [d.name, d]))
    assert.equal(byName.get('sdb')!.status, 'other')
    assert.equal(byName.get('sdb')!.ahrArray, null)
    // ZFS + free classification are unaffected by the AHR failure.
    assert.equal(byName.get('sde')!.status, 'pool_member')
    assert.equal(byName.get('sdf')!.status, 'available')
  })
})
