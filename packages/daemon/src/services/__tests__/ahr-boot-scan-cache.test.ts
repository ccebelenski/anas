import type { AhrCapacity } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { dmsetupStatusArgs } from '../../parsers/dmsetup.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ahrBootScan } from '../ahr-boot-scan.js'
import { AHR_CACHE_LSBLK_ARGS } from '../ahr-cache.js'
import { writeIntent } from '../ahr-intent.js'
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
 * Five worlds over a one-band pool `tank`:
 *   'missing'   cache target, cache PV `[unknown]`, volume inactive, unmounted
 *   'healthy'   a live, working cache — must be left completely alone
 *   'bandsdown' cache PV AND the band's md PV missing, volume inactive —
 *               nothing proves which nameless PV is the cache's → `inactive`,
 *               left alone (ahrcache.1 review)
 *   'bandonly'  the band's md PV missing, the cache SSD present and named,
 *               volume inactive — the review finding's own shape → left alone
 *   'present'   the cache device PRESENT but dm reports it failed, volume
 *               active and mounted → recovered, and described as FAILED,
 *               never as a missing device
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const LV_SIZE = 2143289344
const BAND_SIZE = 2 * GIB - MIB
const DISK_SIZE = 2 * GIB + 8 * MIB
const MOUNTPOINT = '/mnt/anas-ahr/tank'
/** The pool's LV device path — the fstab spec of the pool's OWN line. */
const AHR_LV_PATH = '/dev/tank/tank-vol'
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

/** An empty capacity record — the intent's before/after are not read by the cache rung. */
const CAP: AhrCapacity = { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 }

type World = 'missing' | 'healthy' | 'bandsdown' | 'bandonly' | 'present'

/** The cache SSD and its `tank-cache1` slice are attached and named in `pvs`. */
function cachePresent(world: World): boolean {
  return world === 'healthy' || world === 'bandonly' || world === 'present'
}

/** The pool volume is active and mounted. */
function volumeUp(world: World): boolean {
  return world === 'healthy' || world === 'present'
}

function ahrLsblkJson(world: World): string {
  // A pool whose partial LV could not activate is not mounted — that is the
  // whole reason this rung exists.
  const lvmNode = { name: DM_NAME, type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: volumeUp(world) ? MOUNTPOINT : null, partlabel: null }
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
  if (cachePresent(world)) {
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
  const attr = volumeUp(world) ? 'Cwi-aoC---' : 'Cwi---C-p-'
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
  if (world === 'bandsdown' || world === 'bandonly')
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: '0' })
  else
    rows.push({ pv_name: '/dev/md127', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: String(LV_SIZE + 2 * MIB) })
  if (cachePresent(world))
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
  bandonly: 'Device does not exist.\n',
  present: '0 4186624 cache Fail\n',
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
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs(DM_NAME), result: volumeUp(world)
    ? ok(DM_STATUS[world])
    : { stdout: '', stderr: DM_STATUS[world], exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: ok(JSON.stringify({
    filesystems: volumeUp(world)
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
  let realMp: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-boot-cache-'))
    // tank-r1 is ANAS-pinned (story ident.3 — a pool's arrays are its own by
    // their pinned UUIDs).
    process.env.ANAS_MDADM_CONF = join(dir, 'mdadm.conf')
    await writeFile(process.env.ANAS_MDADM_CONF, 'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\n')
    // cr.52r D3: the cache-recover rung mounts a DOWN pool DIRECTLY through the
    // pool's REAL mountpoint, which it reads from the pool's OWN fstab line
    // (the topology can only report the LV device path while unmounted). The
    // test pool therefore has a real line at a real directory under the
    // tmpdir — the exact pool line ANAS writes at creation (ahrFstabEntry).
    realMp = join(dir, 'tank')
    await mkdir(realMp, { recursive: true })
    const poolLine = `${AHR_LV_PATH} ${realMp} btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s 0 0\n`
    process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
    await writeFile(process.env.ANAS_FSTAB_PATH, poolLine)
  })
  afterEach(async () => {
    delete process.env.ANAS_MDADM_CONF
    delete process.env.ANAS_FSTAB_PATH
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
      // cr.52r D3: the pool's OWN fstab line is mounted DIRECTLY through a
      // directory the daemon opened — the kernel resolves /proc/self/fd/3 to
      // the pool's real mountpoint. The rung never invents a mount.
      // cr.52s-e: the line (written above) keeps `nofail` and the iSCSI
      // ordering pair; the direct mount's `-o` carries only `subvol=@data`.
      ['/usr/bin/mount', '-c', '-t', 'btrfs', '-o', 'subvol=@data', '--', AHR_LV_PATH, '/proc/self/fd/3/.'],
    ])
    // The inherited fd resolves to the pool's REAL mountpoint directory from
    // its own fstab line — never the LV device path the topology read.
    const mountCall = executor.calls.find(c => c.command === '/usr/bin/mount')!
    assert.equal(mountCall.fdPaths?.[0], realMp)
  })

  it('cr.52s-a (review defect 6) — the re-attach mounts with the line\'s OWN options, not ANAS\'s defaults', async () => {
    // The operator's line carries noatime and compression; cr.52r's rung
    // rebuilt ANAS's default entry and mounted without them (the pre-cr.52r
    // `mount -- <lv>` took them from fstab).
    await writeFile(process.env.ANAS_FSTAB_PATH!, `${AHR_LV_PATH} ${realMp} btrfs noatime,compress=zstd:3,subvol=@data 0 0\n`)
    const executor = buildExecutor('missing')
    await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    const mountCall = executor.calls.find(c => c.command === '/usr/bin/mount')!
    assert.deepEqual(mountCall.args, ['-c', '-t', 'btrfs', '-o', 'noatime,compress=zstd:3,subvol=@data', '--', AHR_LV_PATH, '/proc/self/fd/3/.'])
    assert.equal(mountCall.fdPaths?.[0], realMp)
  })

  it('cr.52r P2 — a pool whose STORED mountpoint now resolves into /etc: the boot re-attach REFUSES, logs and leaves it — no mount', async () => {
    // The pool's own fstab line says its mountpoint is `realMp`; the tree
    // swerved since it was written — `realMp` is now a symlink to /etc. The
    // boot re-attach must gate the stored path like any door, and a refusal on
    // the boot path is a log, never a throw — the daemon must not take itself
    // down over one bad re-attach.
    await rm(realMp, { recursive: true, force: true })
    await symlink('/etc', realMp)

    const lines: string[] = []
    const executor = buildExecutor('missing')
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.deepEqual(report.cacheRecovered, ['tank'], 'the rung still reports the pool')
    // uncache, removemissing, activate — and NO mount (the path refused).
    assert.deepEqual(rungCalls(executor), [
      ['/usr/sbin/lvconvert', '--config', 'devices/allow_mixed_block_sizes=1', '-y', '--uncache', 'tank/tank-vol'],
      ['/usr/sbin/vgreduce', '--config', 'devices/allow_mixed_block_sizes=1', '--removemissing', 'tank'],
      ['/usr/sbin/vgchange', '-ay', 'tank'],
    ])
    assert.ok(lines.some(l => l.includes('rung=mount result=refused')), lines.join('\n'))
  })

  /** Every notification the scan emitted, as [severity, title, body]. */
  function notices(executor: MockExecutor): string[][] {
    return executor.calls.filter(c => c.command === '/usr/bin/perl').map(c => c.args.slice(2, 5))
  }

  it('cr.52s-a (review defect 7) — a re-attach whose mountpoint directory is MISSING logs the mount failure; the cache recovery stays reported as done', async () => {
    // The pool's line names a directory that does not exist (the open throws).
    // cr.52r threw this into the cache-recover catch: "cache recovery FAILED …
    // Detach the cache" after the cache had already been dropped.
    const gone = join(dir, 'gone', 'tank')
    await writeFile(process.env.ANAS_FSTAB_PATH!, `${AHR_LV_PATH} ${gone} btrfs nofail,subvol=@data 0 0\n`)
    const lines: string[] = []
    const executor = buildExecutor('missing')
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.deepEqual(report.cacheRecovered, ['tank'], 'the cache WAS dropped — reported as recovered')
    assert.ok(lines.some(l => l.startsWith('ahr.boot pool=tank rung=mount result=failed detail=') && l.includes('does not exist as a directory')), lines.join('\n'))
    assert.ok(!lines.some(l => l.includes('rung=cache-recover result=failed')), lines.join('\n'))
    const titles = notices(executor).map(n => n[1])
    assert.ok(!titles.some(t => /cache recovery FAILED/.test(t!)), titles.join(' | '))
    const unmounted = notices(executor).find(n => n[1] === 'AHR pool not re-mounted: tank')
    assert.ok(unmounted, titles.join(' | '))
    assert.match(unmounted![2]!, /dropped pool 'tank''s failed read cache/)
    assert.match(unmounted![2]!, /mounting it at '.*gone\/tank' failed: Mountpoint .* does not exist as a directory/)
  })

  it('cr.52s-a (review defect 7) — mount(8) exiting non-zero is the same: logged as the mount\'s failure, recovery reported done', async () => {
    const lines: string[] = []
    const executor = buildExecutor('missing')
    executor.prependFixture({ command: '/usr/bin/mount', result: { stdout: '', stderr: 'mount: wrong fs type, bad option, bad superblock', exitCode: 32 } })
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.deepEqual(report.cacheRecovered, ['tank'])
    assert.ok(lines.includes('ahr.boot pool=tank rung=mount result=failed detail=mount: wrong fs type, bad option, bad superblock'), lines.join('\n'))
    assert.ok(!notices(executor).some(n => /cache recovery FAILED/.test(n[1]!)))
  })

  it('cr.52s-a (P1) — an UNREADABLE fstab logs its own reason, never no-fstab-entry, and mounts nothing', async () => {
    await rm(process.env.ANAS_FSTAB_PATH!)
    await mkdir(process.env.ANAS_FSTAB_PATH!) // EISDIR on read
    const lines: string[] = []
    const executor = buildExecutor('missing')
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.deepEqual(report.cacheRecovered, ['tank'])
    assert.ok(lines.some(l => l.startsWith('ahr.boot pool=tank rung=mount result=skipped fstab=unreadable read=')), lines.join('\n'))
    assert.ok(!lines.some(l => l.includes('no-fstab-entry')), lines.join('\n'))
    assert.ok(!executor.calls.some(c => c.command === '/usr/bin/mount'), 'no mount')
    assert.ok(notices(executor).some(n => n[1] === 'AHR pool not re-mounted: tank' && /could not be read/.test(n[2]!)))
  })

  it('cr.52s-a — a readable fstab with NO line for the pool logs no-fstab-entry and invents no mount', async () => {
    await writeFile(process.env.ANAS_FSTAB_PATH!, `/dev/other/other-vol ${join(dir, 'other')} btrfs nofail 0 0\n`)
    const lines: string[] = []
    const executor = buildExecutor('missing')
    await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.ok(lines.includes('ahr.boot pool=tank rung=mount result=no-fstab-entry'), lines.join('\n'))
    assert.ok(!executor.calls.some(c => c.command === '/usr/bin/mount'), 'no mount')
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

  it('cache PV AND a band PV nameless, volume inactive: NOTHING proves a dead cache — left alone', async () => {
    // Before the ahrcache.1 review this read `failed` (no dm answer over a
    // cache target), and the rung uncached a partial VG and announced a
    // missing cache device. With a band PV also `[unknown]`, nothing says which
    // nameless PV is the cache's (GT-19), and an inactive volume has no dm
    // table to ask. The band is the operator's problem first.
    const executor = buildExecutor('bandsdown')
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, [])
    assert.deepEqual(rungCalls(executor), [])
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 0)
  })

  it('a BAND down and the cache SSD healthy (the review finding): not recovered, no cache notification', async () => {
    const executor = buildExecutor('bandonly')
    const lines: string[] = []
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.deepEqual(report.cacheRecovered, [])
    assert.deepEqual(rungCalls(executor), [], 'no uncache of a partial VG over a working SSD')
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 0, 'and no claim that the SSD is missing')
    // An inactive volume has no dm table: the reader does not ask.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/dmsetup').length, 0)
  })

  it('a cache that is PRESENT but failed is recovered and described as failed, not missing', async () => {
    const executor = buildExecutor('present')
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.cacheRecovered, ['tank'])
    const perl = executor.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(perl)
    assert.equal(perl!.args[3], 'AHR read cache failed: tank')
    assert.ok(!perl!.args[4].includes('was missing'), perl!.args[4])
    // Mounted and active: nothing to activate or mount afterwards.
    assert.ok(!rungCalls(executor).some(c => c[0] === '/usr/sbin/vgchange' || c[0] === '/usr/bin/mount'))
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

/**
 * Story cr.38 (WAVE3-DESIGN §4.4 "work outside the queue"): with the daemon's
 * queue injected, the boot cache rung is a JOB — the detach operation, the
 * pool's lock key, the pool re-read and the evidence re-asked under it — and
 * never runs inline beside a cache verb an operator submitted while the scan
 * was still walking md.
 */
describe('ahr-boot-scan branch (d) — the rung is a job with its keys (cr.38)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr38-boot-cache-'))
    process.env.ANAS_MDADM_CONF = join(dir, 'mdadm.conf')
    await writeFile(process.env.ANAS_MDADM_CONF, 'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\n')
  })
  afterEach(async () => {
    delete process.env.ANAS_MDADM_CONF
    await rm(dir, { recursive: true, force: true })
  })

  it('submits ahr.cache.detach (trigger boot), holds the pool\'s key while it acts, and recovers exactly as the inline rung did', async () => {
    const inline = buildExecutor('missing')
    await ahrBootScan(inline, { intentDir: dir, log: () => {} })

    const executor = buildExecutor('missing')
    const queue = new JobQueue()
    const heldAtUncache: string[][] = []
    const orig = executor.exec.bind(executor)
    executor.exec = async (command, args, opts) => {
      if (command === '/usr/sbin/lvconvert')
        heldAtUncache.push(queue.heldLocks().map(l => `${l.key} ${l.mode}`))
      return orig(command, args, opts)
    }
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: queue })
    assert.deepEqual(report.cacheRecovered, ['tank'])

    const jobs = queue.list().filter(j => j.operation === 'ahr.cache.detach')
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].status, 'completed', JSON.stringify(jobs[0].error))
    assert.equal(jobs[0].createdBy, 'system:boot-cache')
    // The suite's `vgs` carries no vg_uuid: the pool is locked by its name key (§4.2 fallback).
    assert.deepEqual(heldAtUncache, [['ahrname:tank exclusive']])
    assert.deepEqual(rungCalls(executor), rungCalls(inline), 'the same rung, in the same order')
  })

  it('a cache that is no longer failed when the job runs is left alone — the job refuses STATE_CHANGED, nothing uncached', async () => {
    const missing = buildExecutor('missing')
    const healthy = buildExecutor('healthy')
    let healed = false
    const executor = new MockExecutor()
    executor.exec = async (command, args, opts) => (healed ? healthy : missing).exec(command, args, opts)
    const queue = new JobQueue()
    // Hold all four slots so the rung's job waits after the scan read the pool.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const lines: string[] = []
    const scan = ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l), jobQueue: queue })
    for (let i = 0; i < 400 && !queue.list().some(j => j.operation === 'ahr.cache.detach'); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    const job = queue.list().find(j => j.operation === 'ahr.cache.detach')
    assert.equal(job?.status, 'queued')
    // The SSD came back and dm-cache reads healthy again before the job ran.
    healed = true
    release()
    const report = await scan
    assert.deepEqual(report.cacheRecovered, [])
    assert.equal(queue.get(job!.id)?.status, 'failed')
    assert.equal(queue.get(job!.id)?.error?.code, 'STATE_CHANGED')
    assert.deepEqual(rungCalls(missing), [], 'nothing acted before the heal')
    assert.deepEqual(rungCalls(healthy), [], 'nothing acted after it')
    assert.ok(lines.some(l => /rung=cache-recover result=refused/.test(l)), lines.join('\n'))
  })
})

/**
 * Story cr.61 (review M8, L19). Two ways the boot rung used to say nothing:
 *
 *  - the AHR topology unreadable while a VG carries a cache — the rung logged
 *    a skip and notified nobody, so a cache SSD that died while the udev rung
 *    was refused for the same unreadable topology went unreported;
 *  - an expansion intent on the pool — the udev door and the operator's
 *    detach refuse under any intent (`vgreduce --removemissing` must not run
 *    while the VG's shape is in flight), and the boot rung did not ask.
 */
describe('ahr-boot-scan branch (d) — the skips the rung must not keep silent or skip (cr.61)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr61-boot-cache-'))
    process.env.ANAS_MDADM_CONF = join(dir, 'mdadm.conf')
    await writeFile(process.env.ANAS_MDADM_CONF, 'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\n')
  })
  afterEach(async () => {
    delete process.env.ANAS_MDADM_CONF
    await rm(dir, { recursive: true, force: true })
  })

  /** The md view answers mdstat, but `mdadm --detail` of the array fails: readAhrPools throws (D12). */
  function unreadableTopology(lvs: string): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: '', stderr: 'mdadm: cannot open /dev/md127: Input/output error\n', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_STATE_ARGS, result: ok(lvs) })
    executor.addFixture({ command: '/usr/bin/perl', result: ok('') })
    executor.addFixture({ command: '/usr/sbin/lvconvert', result: ok('') })
    executor.addFixture({ command: '/usr/sbin/vgreduce', result: ok('') })
    executor.addFixture({ command: '/usr/sbin/vgchange', result: ok('') })
    executor.addFixture({ command: '/usr/bin/mount', result: ok('') })
    return executor
  }

  it('topology unreadable and a VG carries a cache: the operator is told, once per cached VG, and nothing acts (M8)', async () => {
    const executor = unreadableTopology(lvsJson('missing'))
    const lines: string[] = []
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l), jobQueue: new JobQueue() })
    assert.deepEqual(report.cacheRecovered, [])
    assert.deepEqual(rungCalls(executor), [], 'no recovery on a pool the scan could not read')
    assert.ok(lines.some(l => /cache-rung=skipped reason=topology-unreadable vgs=tank /.test(l)), lines.join('\n'))
    const perl = executor.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(perl.length, 1, 'one notification for the one cached VG')
    const [, , severity, title, body] = perl[0].args
    assert.equal(severity, 'warning')
    assert.equal(title, 'AHR read cache not checked: tank')
    // It names the unreadable read, and claims only what is known.
    assert.match(body, /could not read the AHR pools at start-up \(.*mdadm --detail --export \/dev\/md127/)
    assert.match(body, /could not check whether that cache has failed/)
    assert.match(body, /automatic recovery of a failed or missing cache device did not run/)
    assert.ok(!/recovery FAILED|whose device is missing/.test(body), body)
  })

  it('topology unreadable and NO VG carries a cache: nothing to tell', async () => {
    const executor = unreadableTopology(JSON.stringify({
      report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }],
    }))
    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: new JobQueue() })
    assert.deepEqual(report.cacheRecovered, [])
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 0)
  })

  /** An expansion intent on `tank`, HALTED so branch (b) leaves it alone and only the cache rung is asked. */
  async function tankIntent(): Promise<void> {
    await writeIntent('tank', {
      id: '00000000-0000-4000-8000-000000000061',
      trigger: 'add-disk',
      approvedDisks: [X],
      before: CAP,
      after: CAP,
      state: 'halted',
    }, { dir })
  }

  it('a failed cache on a pool with an expansion intent is SKIPPED, as the udev and operator doors skip it (L19)', async () => {
    await tankIntent()
    const executor = buildExecutor('missing')
    const queue = new JobQueue()
    const lines: string[] = []
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l), jobQueue: queue })
    assert.deepEqual(report.cacheRecovered, [])
    assert.deepEqual(rungCalls(executor), [], 'no uncache, no removemissing while the VG shape is in flight')
    assert.equal(queue.list().filter(j => j.operation === 'ahr.cache.detach').length, 0, 'no job submitted')
    assert.ok(lines.some(l => /pool=tank rung=cache-recover result=skipped detail=Pool 'tank' has an expansion intent \(state 'halted'\)/.test(l)), lines.join('\n'))
  })

  it('the inline rung (no queue injected) asks the same intent gate', async () => {
    await tankIntent()
    const executor = buildExecutor('missing')
    const lines: string[] = []
    const report = await ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l) })
    assert.deepEqual(report.cacheRecovered, [])
    assert.deepEqual(rungCalls(executor), [])
    assert.ok(lines.some(l => /pool=tank rung=cache-recover result=skipped detail=Pool 'tank' has an expansion intent/.test(l)), lines.join('\n'))
  })

  it('an intent written while the rung\'s job waits is seen by the job\'s own re-gate — nothing uncached', async () => {
    const executor = buildExecutor('missing')
    const queue = new JobQueue()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const lines: string[] = []
    const scan = ahrBootScan(executor, { intentDir: dir, log: l => lines.push(l), jobQueue: queue })
    for (let i = 0; i < 400 && !queue.list().some(j => j.operation === 'ahr.cache.detach'); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    const job = queue.list().find(j => j.operation === 'ahr.cache.detach')
    assert.equal(job?.status, 'queued')
    await tankIntent()
    release()
    const report = await scan
    assert.deepEqual(report.cacheRecovered, [])
    assert.equal(queue.get(job!.id)?.status, 'failed')
    assert.match(queue.get(job!.id)?.error?.message ?? '', /has an expansion intent/)
    assert.deepEqual(rungCalls(executor), [])
  })
})
