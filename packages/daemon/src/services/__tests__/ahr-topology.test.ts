import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, readAhrPools } from '../ahr-topology.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}
function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

const HOT1 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'
const HOT2 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT2'
const HOT3 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT3'

/** The stage-0 phase-A pool `ahr0`, healthy and mounted. */
function healthyExecutor(overrides?: { mdstat?: string, findmnt?: string }): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(overrides?.mdstat ?? loadFixture('mdstat-clean.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(loadFixture('mdadm-export-r1.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(loadFixture('mdadm-export-r2.txt')) })
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(loadFixture('lsblk-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(loadFixture('disk-by-id-ahr.txt')) })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(loadFixture('lvm-vgs.json')) })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(loadFixture('lvm-lvs.json')) })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(overrides?.findmnt ?? loadFixture('findmnt-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(loadFixture('btrfs-usage.txt')) })
  return mock
}

describe('readAhrPools', () => {
  it('reconstructs the healthy stage-0 pool end to end', async () => {
    const pools = await readAhrPools(healthyExecutor())
    assert.equal(pools.length, 1)
    const pool = pools[0]

    assert.equal(pool.name, 'ahr0')
    assert.equal(pool.ahrType, 'ahr1')
    assert.equal(pool.state, 'healthy')
    assert.equal(pool.mountpoint, '/mnt/anas-ahr/ahr0')
    assert.deepEqual(pool.advisories, [])

    // Arrays: deterministic names, bands ascending, levels from --export.
    assert.equal(pool.arrays.length, 2)
    const [r1, r2] = pool.arrays
    assert.equal(r1.device, '/dev/md/ahr0-r1')
    assert.equal(r1.band, 1)
    assert.equal(r1.level, 'raid5')
    assert.equal(r1.state, 'clean')
    assert.equal(r1.members.length, 3)
    assert.ok(r1.members.every(m => m.memberState === 'in_sync'))
    assert.equal(r1.heightBytes, 1072693248)
    assert.equal(r2.device, '/dev/md/ahr0-r2')
    assert.equal(r2.level, 'raid1')
    assert.equal(r2.members.length, 2)

    // Everything keyed by by-id, never kernel names (GT-2).
    assert.deepEqual(pool.disks.map(d => d.id), [HOT1, HOT2, HOT3])
    const d2 = pool.disks.find(d => d.id === HOT2)!
    assert.equal(d2.sizeBytes, 1610612736)
    assert.equal(d2.usableBytes, 1024 ** 3) // §2.5 floor-to-GiB
    assert.equal(d2.role, 'member')
    assert.deepEqual(d2.partitions.map(p => p.band), [1, 2])
    assert.equal(d2.partitions[0].device, `/dev/disk/by-id/${HOT2}-part1`)
    // sdd3 was partitioned but has no array yet — banded via its partlabel.
    const d3 = pool.disks.find(d => d.id === HOT3)!
    assert.deepEqual(d3.partitions.map(p => p.band), [1, 2, 3])

    // VG/LV from the lvm reports.
    assert.equal(pool.vg.name, 'ahr0')
    assert.equal(pool.vg.sizeBytes, Math.round(2.49 * 1024 ** 3))
    assert.equal(pool.lv.name, 'ahr0-vol')

    // Capacity: raw on rounded sizes; used/free READ from btrfs (GT-14).
    assert.equal(pool.capacity.rawBytes, 4 * 1024 ** 3)
    assert.equal(pool.capacity.usableBytes, Math.round(2.49 * 1024 ** 3))
    assert.equal(pool.capacity.usedBytes, 294912)
    assert.equal(pool.capacity.freeBytes, 2387869696)
    assert.equal(pool.capacity.pendingBytes, 0)
    assert.ok(pool.capacity.redundancyOverheadBytes > 0)
  })

  it('reports the drilled degraded-reshape state (phase C1)', async () => {
    // Only md127 identifies as an AHR array here (the other kernels have no
    // export fixture) — defensive-parse tolerance for unidentifiable arrays.
    const mock = healthyExecutor({ mdstat: loadFixture('mdstat-reshape-degraded.txt') })
    const pools = await readAhrPools(mock)
    assert.equal(pools.length, 1)
    const pool = pools[0]
    const r1 = pool.arrays.find(a => a.band === 1)!

    // Degraded wins the single-state slot; sync still carries the reshape.
    assert.equal(r1.state, 'degraded')
    assert.ok(r1.sync)
    assert.equal(r1.sync.action, 'reshape')
    assert.equal(r1.sync.percent, 0.4)
    assert.equal(r1.sync.speedBytesSec, 1024 * 1024)
    assert.equal(r1.sync.etaSeconds, 16.7 * 60)
    const faulty = r1.members.filter(m => m.memberState === 'faulty')
    assert.equal(faulty.length, 1)
    assert.equal(pool.state, 'degraded')
    assert.ok(pool.advisories.some(a => a.includes('degraded')))
  })

  it('surfaces the GT-8 inactive-all-spares state as degraded + advisory', async () => {
    const mock = healthyExecutor({ mdstat: loadFixture('mdstat-inactive-spares.txt') })
    const pools = await readAhrPools(mock)
    const pool = pools[0]
    const r1 = pool.arrays[0]
    // No new schema state — degraded, with the advisory naming the condition.
    assert.equal(r1.state, 'degraded')
    assert.ok(r1.members.every(m => m.memberState === 'spare'))
    assert.equal(pool.state, 'degraded')
    assert.ok(pool.advisories.some(a => a.includes('INACTIVE')))
  })

  it('treats auto-read-only as healthy (GT-9)', async () => {
    const mdstat = [
      'Personalities : [raid1] [raid5]',
      'md127 : active (auto-read-only) raid5 sdd1[3] sdc1[1] sdb1[0]',
      '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
      '',
      'md126 : active (auto-read-only) raid1 sdd2[1] sdc2[0]',
      '      523200 blocks super 1.2 [2/2] [UU]',
      '',
      'unused devices: <none>',
    ].join('\n')
    const pools = await readAhrPools(healthyExecutor({ mdstat }))
    assert.equal(pools[0].state, 'healthy')
    assert.ok(pools[0].arrays.every(a => a.state === 'clean'))
  })

  it('reports a read-only btrfs mount as pool state readonly', async () => {
    const findmnt = JSON.stringify({
      filesystems: [{
        target: '/mnt/anas-ahr/ahr0',
        source: '/dev/mapper/ahr0-ahr0--vol',
        fstype: 'btrfs',
        options: 'ro,relatime,space_cache=v2,subvolid=5,subvol=/',
      }],
    })
    const pools = await readAhrPools(healthyExecutor({ findmnt }))
    assert.equal(pools[0].state, 'readonly')
    assert.ok(pools[0].advisories.some(a => a.includes('READ-ONLY')))
  })

  it('falls back to the lsblk mountpoint when findmnt yields nothing', async () => {
    const pools = await readAhrPools(healthyExecutor({ findmnt: '' }))
    assert.equal(pools[0].mountpoint, '/mnt/anas-ahr/ahr0')
    assert.equal(pools[0].capacity.usedBytes, 294912)
  })

  it('returns [] when mdstat is unreadable or has no AHR arrays', async () => {
    const noMd = new MockExecutor()
    noMd.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'No such file', exitCode: 1 } })
    assert.deepEqual(await readAhrPools(noMd), [])

    // Arrays exist but none carries an AHR name — foreign, not ours to report.
    const foreign = new MockExecutor()
    foreign.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(loadFixture('mdstat-clean.txt')) })
    foreign.addFixture({ command: '/usr/sbin/mdadm', result: ok('MD_LEVEL=raid1\nMD_DEVNAME=foreign0\nMD_NAME=otherhost:foreign0\n') })
    assert.deepEqual(await readAhrPools(foreign), [])
  })
})
