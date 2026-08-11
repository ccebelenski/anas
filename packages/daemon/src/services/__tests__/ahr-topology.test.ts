import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { isPvUnderSized, PV_UNDERSIZE_MARGIN_BYTES } from '../ahr-layout.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, buildAhrWarnings, readAhrPools, withExpansionIntent } from '../ahr-topology.js'

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
function healthyExecutor(overrides?: { mdstat?: string, findmnt?: string, lsblk?: string, byId?: string }): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(overrides?.mdstat ?? loadFixture('mdstat-clean.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(loadFixture('mdadm-export-r1.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(loadFixture('mdadm-export-r2.txt')) })
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(overrides?.lsblk ?? loadFixture('lsblk-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(overrides?.byId ?? loadFixture('disk-by-id-ahr.txt')) })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(loadFixture('lvm-vgs.json')) })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(loadFixture('lvm-lvs.json')) })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(overrides?.findmnt ?? loadFixture('findmnt-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(loadFixture('btrfs-usage.txt')) })
  return mock
}

// ---- Hot-spare world (§11): ahr0 + a 2 GiB spare disk sde (HOT4) -----------

const HOT4 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4'

/** lsblk-ahr0.json + the spare disk sde with its two labeled band slices. */
function lsblkWithSpare(): string {
  const tree = JSON.parse(loadFixture('lsblk-ahr0.json')) as { blockdevices: unknown[] }
  tree.blockdevices.push({
    name: 'sde',
    size: 2147483648,
    type: 'disk',
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'QEMU HARDDISK',
    serial: 'ANAS_HOT4',
    children: [
      { name: 'sde1', size: 1072693248, type: 'part', fstype: 'linux_raid_member', mountpoint: null, partlabel: 'ahr0-d4-b1' },
      { name: 'sde2', size: 536854016, type: 'part', fstype: 'linux_raid_member', mountpoint: null, partlabel: 'ahr0-d4-b2' },
    ],
  })
  return JSON.stringify(tree)
}

const BY_ID_WITH_SPARE = `${loadFixture('disk-by-id-ahr.txt').trimEnd()}
lrwxrwxrwx 1 root root   9 Jul 23 10:00 ${HOT4} -> ../../sde
lrwxrwxrwx 1 root root  10 Jul 23 10:00 ${HOT4}-part1 -> ../../sde1
lrwxrwxrwx 1 root root  10 Jul 23 10:00 ${HOT4}-part2 -> ../../sde2
`

/** mdstat-clean with sde's slices attached as (S) spares to both arrays. */
const MDSTAT_WITH_SPARE = [
  'Personalities : [raid0] [raid1] [raid4] [raid5] [raid6] [raid10] [linear] ',
  'md126 : active raid1 sde2[2](S) sdd2[1] sdc2[0]',
  '      523200 blocks super 1.2 [2/2] [UU]',
  '',
  'md127 : active raid5 sde1[4](S) sdd1[3] sdc1[1] sdb1[0]',
  '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
  '',
  'unused devices: <none>',
].join('\n')

/** The consumed-spare shape (§11): sde1 rebuilt IN, sdb1 still attached (F). */
const MDSTAT_SPARE_CONSUMED = [
  'Personalities : [raid0] [raid1] [raid4] [raid5] [raid6] [raid10] [linear] ',
  'md126 : active raid1 sde2[2](S) sdd2[1] sdc2[0]',
  '      523200 blocks super 1.2 [2/2] [UU]',
  '',
  'md127 : active raid5 sde1[4] sdd1[3] sdc1[1] sdb1[0](F)',
  '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
  '',
  'unused devices: <none>',
].join('\n')

/** Mid-failover: md is rebuilding onto the spare, the faulty slot remains. */
const MDSTAT_SPARE_REBUILDING = [
  'Personalities : [raid0] [raid1] [raid4] [raid5] [raid6] [raid10] [linear] ',
  'md126 : active raid1 sde2[2](S) sdd2[1] sdc2[0]',
  '      523200 blocks super 1.2 [2/2] [UU]',
  '',
  'md127 : active raid5 sde1[4] sdd1[3] sdc1[1] sdb1[0](F)',
  '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]',
  '      [>....................]  recovery =  1.9% (20472/1044992) finish=0.8min speed=20472K/sec',
  '',
  'unused devices: <none>',
].join('\n')

// ---- The pve5 world: two real pools in one mdstat ---------------------------
// The LIVE pve5 capture behind two failure stories — the mixed-media first
// build (issues #7/#9) and the post-lockup multi-tier failure (issue #18).
// ONE fixture world, so the two cannot describe the same node differently.
// lsblk/by-id are deliberately EMPTY here: this world exercises md + LVM state
// fusion, and the reader must survive disks it cannot resolve.

/** Band index → kernel array, exactly as captured (r1 is the TALLEST band). */
const PVE5_ARRAYS: Record<string, string> = {
  '/dev/md126': 'chiaahr2-r1',
  '/dev/md125': 'chiaahr2-r2',
  '/dev/md124': 'chiaahr2-r3',
  '/dev/md127': 'chiaahr-r1',
}

/** vgs carrying BOTH real pools; `partial` marks chiaahr2's VG missing PVs. */
function pve5Vgs(partial = false): string {
  return JSON.stringify({
    report: [{ vg: [
      { vg_name: 'chiaahr2', pv_count: '3', lv_count: '1', snap_count: '0', vg_attr: partial ? 'wz-pn-' : 'wz--n-', vg_size: '55.00t', vg_free: '0 ' },
      { vg_name: 'chiaahr', pv_count: '1', lv_count: '1', snap_count: '0', vg_attr: 'wz--n-', vg_size: '80.04t', vg_free: '0 ' },
    ] }],
    log: [],
  })
}

/**
 * lvs for both pools. `chiaahr2Attr` is the load-bearing knob: `-wi-a-----` is
 * the healthy form (state field = `a`), `-wi-----p-` is what an LV over a
 * partial VG reports — NOT active (field 5 = `-`) and flagged partial (`p`).
 */
function pve5Lvs(chiaahr2Attr = '-wi-a-----'): string {
  return JSON.stringify({
    report: [{ lv: [
      { lv_name: 'chiaahr2-vol', vg_name: 'chiaahr2', lv_attr: chiaahr2Attr, lv_size: '55.00t' },
      { lv_name: 'chiaahr-vol', vg_name: 'chiaahr', lv_attr: '-wi-a-----', lv_size: '80.04t' },
    ] }],
    log: [],
  })
}

/**
 * A canonical md superblock UUID (mdadm's 8:8:8:8 hex form) derived from the
 * kernel number, so an mdadm.conf ARRAY pin can actually name one of these
 * arrays — the conf parser only accepts the canonical shape.
 */
function pve5Uuid(dev: string): string {
  const hextet = `${dev.slice(-3)}00000`
  return [hextet, hextet, hextet, hextet].join(':')
}

function pve5Executor(overrides?: { mdstat?: string, vgs?: string, lvs?: string }): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({
    command: '/usr/bin/cat',
    args: MDSTAT_CAT_ARGS,
    result: ok(overrides?.mdstat ?? loadFixture('mdstat-initial-recovery-delayed-raid5.txt')),
  })
  for (const [dev, name] of Object.entries(PVE5_ARRAYS)) {
    mock.addFixture({
      command: '/usr/sbin/mdadm',
      args: mdadmDetailExportArgs(dev),
      result: ok(`MD_LEVEL=raid5\nMD_METADATA=1.2\nMD_UUID=${pve5Uuid(dev)}\nMD_NAME=pve5:${name}\n`),
    })
  }
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok('{"blockdevices":[]}') })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok('') })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(overrides?.vgs ?? pve5Vgs()) })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(overrides?.lvs ?? pve5Lvs()) })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok('') })
  return mock
}

/** The `chiaahr2` pool as this world's fixtures describe it. */
async function pve5Pool(overrides?: { mdstat?: string, vgs?: string, lvs?: string }) {
  const pools = await readAhrPools(pve5Executor(overrides))
  const pool = pools.find(p => p.name === 'chiaahr2')
  assert.ok(pool, 'the pool must be reported')
  return pool
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
    assert.equal(r1.heightBytes, 1072676352) // MIN member slice (md semantics) — the clamped member is larger
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

  it('surfaces the GT-8 inactive-all-spares state as an OFFLINE pool + advisory', async () => {
    const mock = healthyExecutor({ mdstat: loadFixture('mdstat-inactive-spares.txt') })
    const pools = await readAhrPools(mock)
    const pool = pools[0]
    const r1 = pool.arrays[0]
    // The BAND keeps its degraded state (no new array-level state for this) with
    // the advisory naming the condition and the recovery ladder…
    assert.equal(r1.state, 'degraded')
    assert.ok(r1.members.every(m => m.memberState === 'spare'))
    assert.ok(pool.advisories.some(a => a.includes('INACTIVE')))
    // …but the POOL is offline, not degraded (issue #18): a band that cannot
    // start takes its PV with it, so the concatenated volume serves nothing.
    assert.equal(pool.state, 'offline')
    // Only md127 is in this mdstat, so md IS the whole membership story: one
    // band, and it cannot start.
    assert.ok(pool.advisories[0].includes('1 of 1 band array cannot start (ahr0-r1)'), pool.advisories[0])
    // An inactive array lists EVERY member as (S) — that must never relabel
    // real members as pool-level hot spares (§11 role fusion).
    assert.ok(pool.disks.every(d => d.role === 'member'))
  })

  describe('hot spares (§11)', () => {
    function spareExecutor(mdstat: string): MockExecutor {
      return healthyExecutor({ mdstat, lsblk: lsblkWithSpare(), byId: BY_ID_WITH_SPARE })
    }

    it('reports the spare disk as role spare with its slices, EXCLUDED from rawBytes', async () => {
      const pools = await readAhrPools(spareExecutor(MDSTAT_WITH_SPARE))
      assert.equal(pools.length, 1)
      const pool = pools[0]
      assert.equal(pool.state, 'healthy')

      const spare = pool.disks.find(d => d.id === HOT4)!
      assert.equal(spare.role, 'spare')
      assert.deepEqual(spare.partitions.map(p => p.band), [1, 2])
      assert.deepEqual(pool.disks.filter(d => d.role === 'member').map(d => d.id), [HOT1, HOT2, HOT3])

      // Spare capacity contributes NO usable bytes: rawBytes is exactly the
      // healthy-world value (member disks only, §2.5-rounded).
      assert.equal(pool.capacity.rawBytes, 4 * 1024 ** 3)
      // (S) members are reported as such on the arrays.
      const r1 = pool.arrays.find(a => a.band === 1)!
      assert.equal(r1.members.filter(m => m.memberState === 'spare').length, 1)
      assert.deepEqual(pool.advisories, [])
    })

    it('after failover the consumed spare yields the §11 advisory — and does NOT read degraded', async () => {
      const pools = await readAhrPools(spareExecutor(MDSTAT_SPARE_CONSUMED))
      const pool = pools[0]
      const r1 = pool.arrays.find(a => a.band === 1)!
      // Every raid slot is back in sync — redundancy is intact; the lingering
      // faulty device is bookkeeping, not degradation (dashboard must not card).
      assert.equal(r1.state, 'clean')
      assert.equal(pool.state, 'healthy')
      const advisory = pool.advisories.find(a => a.includes('spare consumed'))
      assert.ok(advisory, JSON.stringify(pool.advisories))
      assert.match(advisory!, /spare consumed by band 1/)
      assert.match(advisory!, /add a new spare/)
      assert.match(advisory!, /remove\/replace the failed disk/)
      assert.ok(advisory!.includes(HOT1), 'names the failed disk')
    })

    it('mid-failover (rebuilding onto the spare) is recovering — NOT degraded — with the consumed advisory', async () => {
      // md auto-failover rebuild: redundancy is being restored with no operator
      // in the loop (§11, story 11.11), so the band reads `recovering` and the
      // pool `rebuilding` — it must NOT card as a degraded failure (§10). The
      // consumed-spare advisory carries the eventual "replace the failed disk".
      const pools = await readAhrPools(spareExecutor(MDSTAT_SPARE_REBUILDING))
      const pool = pools[0]
      const r1 = pool.arrays.find(a => a.band === 1)!
      assert.equal(r1.state, 'recovering')
      assert.ok(r1.sync)
      assert.equal(r1.sync.action, 'recover')
      assert.equal(pool.state, 'rebuilding')
      assert.ok(pool.advisories.some(a => a.includes('spare consumed by band 1')))
      // The consumed advisory REPLACES the generic degraded one for this band.
      assert.ok(!pool.advisories.some(a => a.includes('is degraded')))
      // A rebuilding pool contributes NO dashboard card (only failures card).
      assert.deepEqual(buildAhrWarnings([pool]), [])
    })
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

  it('subvolLayout follows the mount subvol= option (§12)', async () => {
    // The stage-0 fixture is FLAT (subvol=/): pre-§12, snapshots unavailable.
    const flat = await readAhrPools(healthyExecutor())
    assert.equal(flat[0].subvolLayout, false)

    // A pool mounted subvol=@data carries the §12 subvolume layout. The source
    // MUST carry findmnt's real `[/@data]` subvolume suffix (live-captured
    // 2026-07-23): the exact-match mount lookup has to strip it, or the pool
    // falls through to the options-less lsblk fallback and reads as flat.
    const findmnt = JSON.stringify({
      filesystems: [{
        target: '/mnt/anas-ahr/ahr0',
        source: '/dev/mapper/ahr0-ahr0--vol[/@data]',
        fstype: 'btrfs',
        options: 'rw,relatime,space_cache=v2,subvolid=256,subvol=/@data',
      }],
    })
    const subvol = await readAhrPools(healthyExecutor({ findmnt }))
    assert.equal(subvol[0].subvolLayout, true)
    assert.equal(subvol[0].state, 'healthy')
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

  // Bug #2 (code review): a `<pool>-r<N>`-NAMED bare md array (e.g. a hand-built
  // `media-r1`) must NOT be claimed as an AHR pool unless there is evidence
  // ANAS built it — the matching LVM VG, or an ANAS-authored mdadm.conf pin.
  // Otherwise it cards critical and DELETE offers to zero its superblocks.
  describe('foreign name-collision ownership gate', () => {
    const MEDIA_UUID = 'dddddddd:dddddddd:dddddddd:dddddddd'
    // A bare `media-r1` array — NO `media` VG in the vgs fixture (only ahr0).
    const MEDIA_MDSTAT = `Personalities : [raid1]
md40 : active raid1 sdy1[1] sdx1[0]
      1047552 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`
    const MEDIA_EXPORT = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=${MEDIA_UUID}\nMD_DEVNAME=media-r1\nMD_NAME=anas-pve:media-r1\n`

    function foreignExecutor(): MockExecutor {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(MEDIA_MDSTAT) })
      mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md40'), result: ok(MEDIA_EXPORT) })
      mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok('{"blockdevices":[]}') })
      mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok('') })
      // vgs/lvs have ONLY ahr0 — no `media` VG or LV.
      mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(loadFixture('lvm-vgs.json')) })
      mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(loadFixture('lvm-lvs.json')) })
      mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok('') })
      return mock
    }

    let confDir: string
    beforeEach(async () => {
      confDir = await mkdtemp(join(tmpdir(), 'ahr-conf-'))
    })
    afterEach(async () => {
      await rm(confDir, { recursive: true, force: true })
    })

    it('does NOT report a VG-less, unpinned name-collision array', async () => {
      const confPath = join(confDir, 'mdadm.conf')
      await writeFile(confPath, '# nothing ANAS pinned here\nMAILADDR root\n')
      const pools = await readAhrPools(foreignExecutor(), confPath)
      assert.deepEqual(pools, [], 'a bare foreign media-r1 is never claimed as pool "media"')
    })

    it('STILL reports a failed pool whose VG is gone but whose array is pinned', async () => {
      // The ANAS-authored marker: an ARRAY pin by the array's UUID. VG is gone
      // (not in the vgs fixture) → the pool is genuinely FAILED, which is
      // exactly what must stay visible/reportable.
      const confPath = join(confDir, 'mdadm.conf')
      await writeFile(confPath, `ARRAY /dev/md/media-r1 metadata=1.2 UUID=${MEDIA_UUID}\n`)
      const pools = await readAhrPools(foreignExecutor(), confPath)
      assert.equal(pools.length, 1)
      assert.equal(pools[0].name, 'media')
      assert.equal(pools[0].state, 'failed', 'pinned-but-VG-gone reports as failed, not hidden')
    })
  })

  // --- What the UI pill tone leans on --------------------------------------
  // Both AHR surfaces neutral-tone a `recovering` band when the POOL reads
  // `building` (11.19). These lock which side of that line each real situation
  // falls on — the amber cases are load-bearing.
  describe('pool `building` vs a genuine post-failure rebuild', () => {
    it('a rebuild onto a spare with the DEAD DISK STILL ATTACHED stays amber', async () => {
      // The (F) member is what gives it away: isBuildingMembership sees a
      // faulty member, so the pool is `rebuilding`, and the UI keeps amber.
      const pool = (await readAhrPools(healthyExecutor({ mdstat: MDSTAT_SPARE_REBUILDING })))[0]
      assert.equal(pool.arrays.find(a => a.band === 1)!.state, 'recovering')
      assert.notEqual(pool.state, 'building', 'a post-failure rebuild must NOT read as a build')
      assert.equal(pool.state, 'rebuilding')
    })

    it('KNOWN LIMIT: a PULLED disk rebuilding onto a spare is indistinguishable', async () => {
      // mdstat cannot separate these two situations:
      //   fresh build   md127 : active raid5 sdd1[3] sdc1[1] sdb1[0]  [3/2] [UU_]
      //   pulled+spare  md127 : active raid5 sde1[4] sdd1[3] sdc1[1]  [3/2] [_UU]
      // Same device count, same slot count, NO (F) in either — md simply stops
      // listing a disk that is gone, and readAhrPools never emits memberState
      // 'missing'. So when EVERY band is in this shape the pool reads
      // `building` and the UI shows a neutral pill for what is really a
      // degraded rebuild. Asserted here so the limitation is visible and
      // locked rather than discovered later.
      //
      // Issue #15 is what the ADVISORY does about it: it can only report the
      // observation ("syncing onto <disk> — no fault recorded"), never the old
      // "building redundancy — no action needed", which was a confident verdict
      // on the one question the kernel cannot answer — and the exactly wrong one
      // for this shape.
      const pulled = [
        'Personalities : [raid0] [raid1] [raid4] [raid5] [raid6] [raid10] [linear] ',
        'md126 : active raid1 sde2[2] sdd2[1]',
        '      523200 blocks super 1.2 [2/1] [_U]',
        '      \tresync=DELAYED',
        '',
        'md127 : active raid5 sde1[4] sdd1[3] sdc1[1]',
        '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]',
        '      [>....................]  recovery =  1.9% (20472/1044992) finish=0.8min speed=20472K/sec',
        '',
        'unused devices: <none>',
      ].join('\n')
      const pool = (await readAhrPools(healthyExecutor({ mdstat: pulled })))[0]
      assert.equal(pool.state, 'building', 'documents the limit — NOT an endorsement')

      // The wording is what has to hold up in BOTH readings of this mdstat.
      const r1 = pool.advisories.find(a => a.includes('ahr0-r1'))
      assert.ok(r1, JSON.stringify(pool.advisories))
      assert.match(r1!, /syncing onto sde — no fault recorded$/)
      const r2 = pool.advisories.find(a => a.includes('ahr0-r2'))
      assert.ok(r2, JSON.stringify(pool.advisories))
      assert.match(r2!, /sync queued behind another band — no fault recorded$/)
      for (const advisory of pool.advisories) {
        assert.ok(!advisory.includes('no action needed'), `over-claims: ${advisory}`)
        assert.ok(!advisory.includes('building redundancy'), `over-claims: ${advisory}`)
      }
    })
  })

  // --- Reporting nits from the live stage halt (issue #13) -------------------
  describe('stranded-capacity reporting (issue #13)', () => {
    /** ahr0 with the given PV rows. */
    function pvExecutor(rows: { name: string, size: number, devSize: number }[]): MockExecutor {
      const mock = healthyExecutor()
      mock.addFixture({
        command: '/usr/sbin/pvs',
        result: ok(JSON.stringify({ report: [{ pv: rows.map(r => ({
          pv_name: r.name,
          vg_name: 'ahr0',
          pv_size: String(r.size),
          pv_free: '0',
          dev_size: String(r.devSize),
        })) }] })),
      })
      return mock
    }

    /** md127's PV covers only half its (grown) array — genuinely stranded. */
    function stalePvExecutor(): MockExecutor {
      return pvExecutor([
        { name: '/dev/md127', size: 1000000 * 1024, devSize: 2089984 * 1024 },
        { name: '/dev/md126', size: 523200 * 1024, devSize: 523200 * 1024 },
      ])
    }

    it('capacity inside the arrays but below LVM is PENDING, not unprotected waste', async () => {
      const pool = (await readAhrPools(stalePvExecutor()))[0]
      // It sits under full RAID5 redundancy — calling it "unprotected" was a lie.
      assert.ok(pool.capacity.pendingBytes > 0, 'the stranded capacity must be reported as pending')
      assert.ok(
        pool.advisories.some(a => a.includes('not yet handed up to LVM') && a.includes('the capacity is protected')),
        `expected a below-LVM advisory, got: ${JSON.stringify(pool.advisories)}`,
      )
    })

    it('a pool whose PVs cover their arrays reports no stranded capacity', async () => {
      const pool = (await readAhrPools(healthyExecutor()))[0]
      assert.ok(!pool.advisories.some(a => a.includes('not yet handed up to LVM')))
    })

    // A healthy, fully-resized PV is ALWAYS a few MiB under its device (LVM
    // metadata area + physical-extent rounding). A bare `pv_size < dev_size`
    // read that as stranded capacity and produced, on a brand-new pool with no
    // expansion at all, the nonsensical advisory "0 GiB is grown into the RAID
    // arrays but not yet handed up to LVM — resume or re-run the expansion".
    // Real pve5 numbers, 2026-08-09, all four PVs healthy and fully sized.
    it('the few-MiB metadata delta of a HEALTHY PV is not stranded capacity', async () => {
      const pool = (await readAhrPools(pvExecutor([
        // Δ ~4.0 MiB — the largest of the four observed.
        { name: '/dev/md127', size: 32005014159360, devSize: 32005018353664 },
        // Δ ~3.0 MiB.
        { name: '/dev/md126', size: 11999597559808, devSize: 11999600705536 },
      ])))[0]

      assert.equal(pool.capacity.pendingBytes, 0, 'a metadata sliver is not pending capacity')
      assert.ok(
        !pool.advisories.some(a => a.includes('not yet handed up to LVM')),
        `a healthy pool must stay quiet, got: ${JSON.stringify(pool.advisories)}`,
      )
    })

    it('every observed pve5 delta stays below the margin', async () => {
      // The full live set, including the unrelated healthy pool chiaahr.
      const observed: [number, number][] = [
        [11999597559808, 11999600705536], // md124 chiaahr2  Δ ~3.0 MiB
        [17996177211392, 17996179832832], // md125 chiaahr2  Δ ~2.5 MiB
        [32005014159360, 32005018353664], // md126 chiaahr2  Δ ~4.0 MiB
        [88002797764608, 88002799861760], // md127 chiaahr   Δ ~2.0 MiB
      ]
      for (const [size, devSize] of observed) {
        assert.ok(devSize - size < PV_UNDERSIZE_MARGIN_BYTES, `Δ ${devSize - size} must be under the margin`)
        assert.equal(isPvUnderSized(size, devSize), false)
      }
      // …and the margin is an order of magnitude clear of the worst of them.
      assert.ok(PV_UNDERSIZE_MARGIN_BYTES > 10 * (32005018353664 - 32005014159360))
    })

    it('a multi-GiB delta IS stranded, and says so with real numbers', async () => {
      const pool = (await readAhrPools(pvExecutor([
        // The stage-test shape: 2 GiB stranded below LVM on one band.
        { name: '/dev/md127', size: 4 * 1024 ** 3, devSize: 6 * 1024 ** 3 },
        { name: '/dev/md126', size: 11999597559808, devSize: 11999600705536 },
      ])))[0]

      assert.equal(pool.capacity.pendingBytes, 2 * 1024 ** 3)
      const advisory = pool.advisories.find(a => a.includes('not yet handed up to LVM'))
      assert.ok(advisory, 'a genuine stranded state must still be reported')
      // Never the "0 GiB" that started this.
      assert.match(advisory, /^2 GiB is grown into the RAID arrays/)
    })
  })

  // --- A halted expansion says so on the POOL, not only on the dashboard -----
  describe('halted-expansion advisory mirrors the card (issue #13)', () => {
    const intent = {
      id: '11111111-2222-3333-4444-555555555555',
      trigger: 'add-disk' as const,
      approvedDisks: ['ata-A', 'ata-B'],
      before: { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
      after: { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
    }

    it('a HALTED intent adds a pool advisory alongside the dashboard card', async () => {
      const pool = (await readAhrPools(healthyExecutor()))[0]
      assert.deepEqual(pool.advisories, [], 'the base pool is quiet')

      const halted = withExpansionIntent(pool, { ...intent, state: 'halted' })
      // The card existed while advisories[] came back EMPTY — the Hybrid RAID
      // view showed a stalled expansion with nothing to say about it.
      assert.ok(halted.advisories.some(a => a.includes('expansion is HALTED') && a.includes('Resume') && a.includes('Abandon')))
      assert.equal(buildAhrWarnings([halted]).length, 1, 'and the card is still raised')
    })

    it('a RUNNING intent attaches but does not advise (it rides the jobs strip)', async () => {
      const pool = (await readAhrPools(healthyExecutor()))[0]
      const running = withExpansionIntent(pool, { ...intent, state: 'running' })
      assert.equal(running.expansion?.state, 'running')
      assert.deepEqual(running.advisories, [])
      assert.deepEqual(buildAhrWarnings([running]), [])
    })

    it('no intent leaves the pool untouched', async () => {
      const pool = (await readAhrPools(healthyExecutor()))[0]
      assert.equal(withExpansionIntent(pool, null), pool)
    })
  })

  // --- The mixed-media first build (issues #7 + #9) --------------------------
  // Driven by the LIVE pve5 capture: three `chiaahr2` bands building at once,
  // md126 running the recovery and md124/md125 QUEUED behind it. A queued sync
  // prints no progress line, so those two sit at `[3/2]`/`[4/3]` — which used
  // to read as degraded arrays with failed disks on a pool minutes old.
  describe('mixed-media first build (issues #7, #9)', () => {
    it('a QUEUED band is recovering, not degraded — no failed disk is claimed', async () => {
      const pool = await pve5Pool()
      const byBand = new Map(pool.arrays.map(a => [a.band, a]))

      // The running one: md has a progress line, and always did read right.
      assert.equal(byBand.get(1)!.state, 'recovering')
      assert.equal(byBand.get(1)!.sync?.action, 'recover')

      // The queued ones: `[4/3]` and `[3/2]` with NO progress line. This is the
      // regression — both used to be 'degraded'.
      assert.equal(byBand.get(2)!.state, 'recovering', 'band 2 is queued, not faulted')
      assert.equal(byBand.get(3)!.state, 'recovering', 'band 3 is queued, not faulted')
      // A queued band has no sync{} to report — there is no progress to show.
      assert.equal(byBand.get(2)!.sync, undefined)

      // No member is faulty anywhere: nothing failed, nothing to replace.
      assert.ok(pool.arrays.every(a => a.members.every(m => m.memberState !== 'faulty')))
    })

    it('the queued bands advise what md is doing, never "replace the failed disk"', async () => {
      const pool = await pve5Pool()
      assert.ok(
        !pool.advisories.some(a => a.includes('replace the failed disk')),
        'a pool with no fault recorded must never be told to replace a disk',
      )
      for (const band of [2, 3]) {
        assert.ok(
          pool.advisories.some(a => a.includes(`chiaahr2-r${band}`) && a.includes('sync queued behind another band') && a.includes('no fault recorded')),
          `band ${band} must be described as queued, stating only what is known`,
        )
      }
    })

    // Issue #15: the advisory may state the OBSERVATION and nothing more. mdstat
    // cannot tell a first build from a rebuild onto a spare whose dead disk was
    // PULLED, so "building redundancy — no action needed" was a confident claim
    // the system has no evidence for — and exactly wrong for the pulled case.
    it('a syncing band states the observation — never "no action needed"', async () => {
      const pool = await pve5Pool()
      const running = pool.advisories.find(a => a.includes('chiaahr2-r1'))
      assert.ok(running, JSON.stringify(pool.advisories))
      assert.match(running!, /syncing onto sdd — no fault recorded$/)
      for (const advisory of pool.advisories) {
        assert.ok(!advisory.includes('no action needed'), `over-claims: ${advisory}`)
        assert.ok(!advisory.includes('building redundancy'), `over-claims: ${advisory}`)
      }
    })

    it('the pool fuses to BUILDING, and cards nothing', async () => {
      const pool = await pve5Pool()
      assert.equal(pool.state, 'building')

      // Activity, not fault: the §10 "only failures card" policy must stay
      // silent for the whole multi-day build.
      assert.deepEqual(buildAhrWarnings([pool]), [])
    })

    it('the unrelated clean pool in the same mdstat stays healthy', async () => {
      const pools = await readAhrPools(pve5Executor())
      const other = pools.find(p => p.name === 'chiaahr')
      assert.ok(other)
      assert.equal(other.state, 'healthy', 'one pool building must not colour another')
    })

    it('a GENUINE fault still reads degraded, with the replace-disk advisory', async () => {
      // Same capture, but band 2 now carries a faulted member — the shape a
      // real disk failure makes. The queued marker must NOT launder it.
      const withFault = loadFixture('mdstat-initial-recovery-delayed-raid5.txt')
        .replace('sdd2[4] sdl2[2] sdb2[1] sdo2[0]', 'sdd2[4] sdl2[2] sdb2[1](F) sdo2[0]')
      const pool = await pve5Pool({ mdstat: withFault })
      const band2 = pool.arrays.find(a => a.band === 2)!

      assert.equal(band2.state, 'degraded')
      assert.ok(band2.members.some(m => m.memberState === 'faulty'))
      assert.ok(pool.advisories.some(a => a.includes('chiaahr2-r2') && a.includes('replace the failed disk')))
      // One faulted band is enough to deny the whole pool the building label.
      assert.equal(pool.state, 'degraded')
      assert.equal(buildAhrWarnings([pool])[0]?.level, 'warning')
    })

    it('a MISSING member still reads degraded — fewer members than raid slots', async () => {
      // The other real-fault shape: the disk is gone entirely, so there is no
      // `(F)` to find. Slot count is the only evidence, and it must still bite.
      const withMissing = loadFixture('mdstat-initial-recovery-delayed-raid5.txt')
        .replace('sdd2[4] sdl2[2] sdb2[1] sdo2[0]', 'sdd2[4] sdl2[2] sdo2[0]')
      const pool = await pve5Pool({ mdstat: withMissing })

      assert.equal(pool.arrays.find(a => a.band === 2)!.state, 'degraded')
      assert.equal(pool.state, 'degraded')
      assert.ok(buildAhrWarnings([pool])[0]?.message.includes('is missing a member'))
    })
  })

  // --- The post-lockup multi-tier failure (issue #18) ------------------------
  // The pve5 incident of 2026-08-09: after a node lockup chiaahr2 came up with
  // band r1 active but down a member, bands r2 and r3 INACTIVE ("active,
  // FAILED, Not Started"), the VG partial and the LV not active — the volume
  // was OFFLINE and its data unreachable, while the badge said "degraded".
  describe('post-lockup multi-tier failure (issue #18)', () => {
    /** The incident, exactly: 1 band degraded + 2 bands unstartable + LV down. */
    function incident() {
      return pve5Pool({
        mdstat: loadFixture('mdstat-inactive-bands-post-lockup.txt'),
        vgs: pve5Vgs(true),
        lvs: pve5Lvs('-wi-----p-'),
      })
    }

    it('the pool reads OFFLINE, never degraded', async () => {
      const pool = await incident()
      // THE REGRESSION: this pool used to report 'degraded', which reads as
      // reduced-redundancy-but-functioning. Nothing was being served at all.
      assert.equal(pool.state, 'offline')
      // The bands still describe themselves truthfully at their own level
      // (11.19): r1 IS degraded, and r2/r3 are the GT-8 inactive shape.
      const byBand = new Map(pool.arrays.map(a => [a.band, a]))
      assert.equal(byBand.get(1)!.state, 'degraded')
      for (const band of [2, 3])
        assert.ok(byBand.get(band)!.members.every(m => m.memberState === 'spare'), `band ${band} is inactive (all members (S))`)
    })

    it('the advisory names WHICH bands cannot start, and says the data is unavailable', async () => {
      const pool = await incident()
      const advisory = pool.advisories[0]
      assert.ok(advisory.startsWith(`pool 'chiaahr2' is OFFLINE — `), `the verdict leads the list, got: ${advisory}`)
      // Counted AND named — bands ascending, ids never truncated.
      assert.ok(advisory.includes('2 of 3 band arrays cannot start (chiaahr2-r2, chiaahr2-r3)'), advisory)
      // The other half of the evidence: the volume itself is down.
      assert.ok(advisory.includes(`the logical volume 'chiaahr2-vol' is not active`), advisory)
      assert.ok(advisory.includes('the filesystem cannot be mounted and its data is unavailable'), advisory)
      // A cause we have NOT earned is never invented: an inactive array can be
      // the recoverable GT-8 all-spares assembly, and the per-array advisories
      // are what carry the recovery ladder.
      assert.ok(!advisory.includes('missing members'), advisory)
      for (const band of [2, 3])
        assert.ok(pool.advisories.some(a => a.includes(`chiaahr2-r${band}`) && a.includes('INACTIVE')), `band ${band} keeps its own INACTIVE advisory`)
    })

    it('the dashboard cards it CRITICAL, with the same sentence the view shows', async () => {
      const pool = await incident()
      const warnings = buildAhrWarnings([pool])
      assert.equal(warnings.length, 1, 'ONE card per pool')
      const w = warnings[0]
      assert.equal(w.level, 'critical', 'total unavailability is not a warning')
      assert.equal(w.category, 'ahr')
      assert.equal(w.ref, 'chiaahr2')
      // One wording, two altitudes: the card is the pool's own advisory with the
      // subject supplied by the card, so headline and detail cannot disagree.
      assert.equal(
        w.message,
        `AHR pool 'chiaahr2' ${pool.advisories[0].slice(`pool 'chiaahr2' `.length)}; see the Hybrid RAID view`,
      )
    })

    it('an offline pool does not colour the healthy pool beside it', async () => {
      const pools = await readAhrPools(pve5Executor({
        mdstat: loadFixture('mdstat-inactive-bands-post-lockup.txt'),
        vgs: pve5Vgs(true),
        lvs: pve5Lvs('-wi-----p-'),
      }))
      const other = pools.find(p => p.name === 'chiaahr')
      assert.ok(other)
      assert.equal(other.state, 'healthy')
      assert.equal(buildAhrWarnings(pools).length, 1, 'only the offline pool cards')
    })

    describe('precedence: offline outranks every state below it', () => {
      it('beats degraded — one unstartable band is enough, LV or no LV', async () => {
        // Band r1 down a member and r3 unstartable, but the LV still reads
        // active: the md evidence ALONE must carry the offline verdict.
        const pool = await pve5Pool({ mdstat: loadFixture('mdstat-inactive-bands-post-lockup.txt') })
        assert.equal(pool.arrays.find(a => a.band === 1)!.state, 'degraded')
        assert.equal(pool.state, 'offline')
        const advisory = pool.advisories[0]
        assert.ok(advisory.includes('2 of 3 band arrays cannot start'), advisory)
        assert.ok(!advisory.includes('logical volume'), 'an active LV is not claimed as evidence')
      })

      it('beats building — the whole first build is moot if the volume is down', async () => {
        // The unmodified issue #7 capture: all three bands building, which fuses
        // to 'building' and cards NOTHING. Flip ONLY the LV to inactive and the
        // pool is offline — a build that cannot be reached is not "activity".
        assert.equal((await pve5Pool()).state, 'building')
        const pool = await pve5Pool({ lvs: pve5Lvs('-wi-----p-') })
        assert.equal(pool.state, 'offline')
        assert.equal(buildAhrWarnings([pool])[0]?.level, 'critical')
      })

      it('is outranked only by `failed` — a missing LVM layer has no volume to call offline', async () => {
        // The VG is gone entirely, so there is nothing left to be offline: the
        // pool is `failed`, and its missing-layer advisories already say why.
        // (Kept visible by the ANAS-authored mdadm.conf pin on band r1.)
        const confDir = await mkdtemp(join(tmpdir(), 'ahr-conf-'))
        try {
          const confPath = join(confDir, 'mdadm.conf')
          await writeFile(confPath, `ARRAY /dev/md/chiaahr2-r1 metadata=1.2 UUID=${pve5Uuid('/dev/md126')}\n`)
          const pools = await readAhrPools(pve5Executor({
            mdstat: loadFixture('mdstat-inactive-bands-post-lockup.txt'),
            vgs: JSON.stringify({ report: [{ vg: [] }], log: [] }),
            lvs: JSON.stringify({ report: [{ lv: [] }], log: [] }),
          }), confPath)
          const pool = pools.find(p => p.name === 'chiaahr2')
          assert.ok(pool, 'a pinned pool stays visible even with its VG gone')
          assert.equal(pool.state, 'failed')
          assert.ok(!pool.advisories.some(a => a.includes('is OFFLINE')), 'no offline verdict without a volume')
        }
        finally {
          await rm(confDir, { recursive: true, force: true })
        }
      })
    })
  })
})
