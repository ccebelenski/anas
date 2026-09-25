import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { dmsetupStatusArgs } from '../../parsers/dmsetup.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ahrBootScan } from '../ahr-boot-scan.js'
import { AHR_CACHE_LSBLK_ARGS } from '../ahr-cache.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../ahr-topology.js'

/**
 * The BOOT rung of the read-cache recovery (story ahrcache.1 slice 2,
 * AHR-DESIGN §13 "Resolved 2026-09-24", branch (d) of `ahrBootScan`).
 *
 * The case: the node boots with the cache SSD dead. LVM REFUSES to activate a
 * pool LV whose cache metadata is missing — "Refusing activation of partial
 * LV", in normal mode AND under `--activationmode degraded` (GT §18) — so the
 * volume is inactive and the fstab mount failed. And if it HAD activated, every
 * read would return EIO: dm-cache does not fall through to the origin (GT-19).
 *
 * So a pool must never come up serving EIO. The rung runs the same recovery the
 * udev event runs, THEN activates and mounts — in that order, which is the
 * single fact this file exists to pin.
 *
 * Three worlds over a one-band pool `tank`:
 *   'missing'  cache target, cache PV `[unknown]`, volume inactive, unmounted
 *   'healthy'  a live, working cache — must be left completely alone
 *   'bandsdown' cache PV AND the band's md PV missing → the guard refuses
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const LV_SIZE = 2143289344
const BAND_SIZE = 2 * GIB - MIB
const DISK_SIZE = 2 * GIB + 8 * MIB
const MOUNTPOINT = '/mnt/anas-ahr/tank'
const DM_NAME = 'tank-tank--vol'
const LVS_STATE_ARGS = ['--reportformat', 'json', '--units', 'b', '--nosuffix']

const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'

const MDSTAT = `Personalities : [raid1]
md127 : active raid1 sdr1[1] sdq1[0]
      2096128 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`
const MD_EXPORT = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n`

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

type World = 'missing' | 'healthy' | 'bandsdown'

function ahrLsblkJson(world: World): string {
  // A pool whose partial LV could not activate is not mounted — that is the
  // whole reason this rung exists.
  const lvmNode = { name: DM_NAME, type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: world === 'healthy' ? MOUNTPOINT : null, partlabel: null }
  const member = (kernel: string, id: string, n: number) => ({
    name: kernel,
    type: 'disk',
    size: DISK_SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH DISK',
    serial: id,
    children: [{
      name: `${kernel}1`,
      type: 'part',
      size: BAND_SIZE,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: `tank-d${n}-b1`,
      children: [{ name: 'md127', type: 'raid1', size: 2096128 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })
  const disks: unknown[] = [member('sdq', X, 1), member('sdr', Y, 2)]
  if (world === 'healthy') {
    disks.push({
      name: 'sds',
      type: 'disk',
      size: 4 * GIB,
      fstype: null,
      mountpoint: null,
      partlabel: null,
      model: 'SYNTH SSD',
      serial: 'ata-TANK_C',
      children: [{ name: 'sds1', type: 'part', size: 4 * GIB - MIB, fstype: 'LVM2_member', mountpoint: null, partlabel: 'tank-cache1' }],
    })
  }
  return JSON.stringify({ blockdevices: disks })
}

function inventoryLsblkJson(): string {
  const flat = (kernel: string, id: string) => ({
    'name': kernel,
    'type': 'disk',
    'size': DISK_SIZE,
    'model': 'SYNTH DISK',
    'serial': id,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'children': [{ name: `${kernel}1`, type: 'part', size: BAND_SIZE, fstype: 'linux_raid_member', mountpoint: null }],
  })
  return JSON.stringify({ blockdevices: [flat('sdq', X), flat('sdr', Y)] })
}

function lvsJson(world: World): string {
  // `Cwi` = a cache-target LV. Field 5 is the activation state: `a` active,
  // `-` not. A partial cached LV cannot activate, so it reads `-`, and the
  // trailing `p` says a PV of it is missing.
  const attr = world === 'healthy' ? 'Cwi-aoC---' : 'Cwi---C-p-'
  return JSON.stringify({
    report: [{
      lv: [{
        lv_name: 'tank-vol',
        vg_name: 'tank',
        lv_attr: attr,
        lv_size: String(LV_SIZE),
        cache_mode: 'writethrough',
        cache_policy: 'smq',
        cache_total_blocks: '8000',
        cache_used_blocks: '3870',
        cache_read_hits: '25632',
        cache_read_misses: '3585',
        cache_dirty_blocks: '0',
      }],
    }],
  })
}

function pvsJson(world: World): string {
  const rows: Record<string, string>[] = []
  if (world === 'bandsdown')
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: '0' })
  else
    rows.push({ pv_name: '/dev/md127', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: String(LV_SIZE + 2 * MIB) })
  if (world === 'healthy')
    rows.push({ pv_name: '/dev/sds1', vg_name: 'tank', pv_size: String(4 * GIB - MIB), pv_free: '0', dev_size: String(4 * GIB) })
  else
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(4 * GIB - MIB), pv_free: '0', dev_size: '0' })
  return JSON.stringify({ report: [{ pv: rows }] })
}

const DM_STATUS: Record<World, string> = {
  // An INACTIVE LV is not in the device-mapper table at all: dmsetup exits
  // non-zero with prose, and the reader gets no line to judge. Over a
  // cache-target LV that reads `failed`, never `absent` — the deliberate
  // asymmetry in `buildAhrCacheState` (GT-23's failure shape).
  missing: 'Device does not exist.\n',
  bandsdown: 'Device does not exist.\n',
  healthy: '0 4186624 cache 8 24/2048 128 8/8000 152 28 0 0 0 8 0 2 metadata2 writethrough 2 migration_threshold 2048 mq 10 random_threshold 0 sequential_threshold 0 discard_promote_adjustment 0 read_promote_adjustment 0 write_promote_adjustment 0 rw - \n',
}

const BY_ID_LISTING = [
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${X} -> ../../sdq`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${X}-part1 -> ../../sdq1`,
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${Y} -> ../../sdr`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${Y}-part1 -> ../../sdr1`,
  'lrwxrwxrwx 1 root root 9 Sep 24 20:00 ata-TANK_C -> ../../sds',
  'lrwxrwxrwx 1 root root 10 Sep 24 20:00 ata-TANK_C-part1 -> ../../sds1',
  '',
].join('\n')

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

function buildExecutor(world: World): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: ok(ahrLsblkJson(world)) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: ok(inventoryLsblkJson()) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_CACHE_LSBLK_ARGS], result: ok(ahrLsblkJson(world)) })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_LISTING) })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] })) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_STATE_ARGS, result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok(pvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs(DM_NAME), result: world === 'healthy'
    ? ok(DM_STATUS[world])
    : { stdout: '', stderr: DM_STATUS[world], exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: ok(JSON.stringify({
    filesystems: world === 'healthy'
      ? [{ target: MOUNTPOINT, source: `/dev/mapper/${DM_NAME}`, fstype: 'btrfs', options: 'rw,relatime,subvol=/@data' }]
      : [],
  })) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', MOUNTPOINT], result: ok(BTRFS_USAGE) })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/lvconvert', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/vgreduce', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/vgchange', result: ok('') })
  executor.addFixture({ command: '/usr/bin/mount', result: ok('') })
  return executor
}

/** The rung's own commands, in order — everything it can mutate. */
function rungCalls(executor: MockExecutor): string[][] {
  return executor.calls
    .filter(c => ['/usr/sbin/lvconvert', '/usr/sbin/vgreduce', '/usr/sbin/vgchange', '/usr/bin/mount'].includes(c.command))
    .map(c => [c.command, ...c.args])
}

describe('ahr-boot-scan branch (d) — a cached pool whose cache PV is missing', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-boot-cache-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('recovers BEFORE it mounts — uncache, removemissing, activate, mount', async () => {
    const executor = buildExecutor('missing')
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, ['tank'])

    // THE order this rung exists for. A pool must never come up serving EIO,
    // so the cache is gone before anything tries to use the filesystem.
    assert.deepEqual(rungCalls(executor), [
      ['/usr/sbin/lvconvert', '--config', 'devices/allow_mixed_block_sizes=1', '-y', '--uncache', 'tank/tank-vol'],
      ['/usr/sbin/vgreduce', '--config', 'devices/allow_mixed_block_sizes=1', '--removemissing', 'tank'],
      // LVM refused to activate the partial LV, so the volume has to be brought
      // up now that it is whole again.
      ['/usr/sbin/vgchange', '-ay', 'tank'],
      // By LV device path: fstab supplies the mountpoint and every option the
      // pool's own line carries. The rung never invents a mount.
      ['/usr/bin/mount', '--', '/dev/tank/tank-vol'],
    ])
  })

  it('notifies that the pool came up uncached', async () => {
    const executor = buildExecutor('missing')
    await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    const perl = executor.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(perl, 'a notification was emitted')
    const [, , severity, title, body] = perl!.args
    assert.equal(severity, 'warning')
    assert.equal(title, 'AHR read cache missing: tank')
    assert.match(body, /was missing when pool 'tank' was activated/)
    assert.match(body, /reads are restored uncached and no data was lost/)
    // Nothing was written while the pool was down, so btrfs is not read-only
    // and the Remount sentence would be a false alarm.
    assert.ok(!body.includes('READ-ONLY'), body)
  })

  it('leaves a HEALTHY cached pool completely alone', async () => {
    const executor = buildExecutor('healthy')
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, [])
    // `dmsetup status` is the one signal that can tell a working cache from a
    // dead one — `lvs` counters go stale rather than absent (GT-23), and this
    // world's `lvs` row carries the same warm numbers the failed ones do.
    assert.deepEqual(rungCalls(executor), [])
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 0)
  })

  it('does not even read the topology when no LV is a cache target', async () => {
    // The cheap gate: one `lvs`. The overwhelming majority of daemon starts
    // have no cache on the node, and the topology read the rung needs is a
    // dozen commands — mdstat, a `mdadm --detail` per array, two lsblk trees,
    // the by-id listing, vgs/lvs/pvs, findmnt and a btrfs usage read.
    // Built from scratch, with only the md pass's fixtures plus a plain,
    // uncached `lvs` answer — so anything the rung reads beyond that shows up
    // as a call the mock never answered.
    const executorNoCache = new MockExecutor()
    executorNoCache.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
    executorNoCache.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
    executorNoCache.addFixture({ command: '/usr/sbin/lvs', args: LVS_STATE_ARGS, result: ok(JSON.stringify({
      report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }],
    })) })

    const report = await ahrBootScan(executorNoCache, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, [])
    // No lsblk, no pvs, no findmnt — the expensive read never happened.
    for (const cmd of ['/usr/bin/lsblk', '/usr/sbin/pvs', '/usr/bin/findmnt', '/usr/sbin/vgs'])
      assert.equal(executorNoCache.calls.filter(c => c.command === cmd).length, 0, cmd)
  })

  it('REFUSES --removemissing while a band PV is also missing, and says why', async () => {
    const executor = buildExecutor('bandsdown')
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, [])

    // GT-19: a stopped band array reads `[unknown]` exactly as a dead cache
    // device does, and `--removemissing` drops EVERY absent PV. At boot this is
    // not a theoretical case — a node that lost the cache SSD may well have
    // lost a band's disk in the same event.
    const calls = rungCalls(executor)
    assert.ok(!calls.some(c => c[0] === '/usr/sbin/vgreduce'), JSON.stringify(calls))
    assert.ok(!calls.some(c => c[0] === '/usr/bin/mount'), JSON.stringify(calls))

    const perl = executor.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(perl, 'the operator is told the automatic repair did not happen')
    assert.equal(perl!.args[2], 'error')
    assert.equal(perl!.args[3], 'AHR read cache recovery FAILED: tank')
    assert.match(perl!.args[4], /a stopped band array is indistinguishable/)
    assert.match(perl!.args[4], /cannot serve reads until the cache is removed/)
  })

  it('never takes the daemon down when the rung throws', async () => {
    // Fail-soft is the whole posture of this scan: a start-up repair that
    // cannot proceed logs, notifies and returns — it never rejects.
    const broken = new MockExecutor()
    broken.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
    broken.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
    broken.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: ok(ahrLsblkJson('missing')) })
    broken.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: ok(inventoryLsblkJson()) })
    broken.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_LISTING) })
    broken.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] })) })
    broken.addFixture({ command: '/usr/sbin/lvs', result: ok(lvsJson('missing')) })
    broken.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok(pvsJson('missing')) })
    broken.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs(DM_NAME), result: { stdout: '', stderr: 'Device does not exist.\n', exitCode: 1 } })
    broken.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: ok(JSON.stringify({ filesystems: [] })) })
    broken.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
    broken.addFixture({ command: '/usr/bin/perl', result: ok('') })
    broken.addFixture({ command: '/usr/sbin/lvconvert', result: { stdout: '', stderr: 'Failed to uncache tank/tank-vol.', exitCode: 5 } })

    const report = await ahrBootScan(broken, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, [])
    const perl = broken.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(perl)
    assert.match(perl!.args[4], /Failed to uncache tank\/tank-vol\./)
  })
})
