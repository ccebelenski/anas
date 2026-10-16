import type { AhrDestroyTarget } from '../ahr-destroy.js'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AhrPool } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { destroyAhrPool } from '../ahr-destroy.js'
import { AHR_LSBLK_ARGS } from '../ahr-topology.js'

/**
 * AHR destroy — full-teardown command sequence, the half-destroyed idempotent
 * re-run (every step checks-then-acts), and the partlabel sweep that reaches
 * members no array claims any more (issue #16).
 */

const GIB = 1024 ** 3
const SMALL = 'ata-ANAS_SMALL_2G'
const BIG = 'ata-ANAS_BIG_3G'
/** A member that dropped out of every array — present, claimed by nothing. */
const DETACHED = 'ata-ANAS_DETACHED_3G'
/** A member disk that is not attached at all. */
const GONE = 'ata-ANAS_GONE_3G'
/** The read-cache SSD (ahrcache.1 §13) — role 'cache', no member partitions. */
const CACHE = 'ata-ANAS_CACHE_SSD'
const UUID_T2 = '11111111:22222222:33333333:44444444'
const UUID_FOREIGN = '99999999:99999999:99999999:99999999'
const MOUNTPOINT = '/mnt/test-ahr/t2'
/** The Previous Versions @snapshots mount (smbsvc.1) — sibling of the pool mount base. */
const SNAP_MOUNT = '/mnt/anas-ahr-snapshots/t2'

const FSTAB_SEED = [
  '# static file system information',
  'UUID=abc / ext4 errors=remount-ro 0 1',
  `/dev/t2/t2-vol ${MOUNTPOINT} btrfs nofail 0 0`,
  '',
].join('\n')

const CONF_SEED = [
  '# mdadm.conf — hand comment survives',
  `ARRAY /dev/md/foreign metadata=1.2 UUID=${UUID_FOREIGN}`,
  `ARRAY /dev/md/t2-r1 metadata=1.2 UUID=${UUID_T2}`,
  'PROGRAM /usr/local/bin/anas-md-event',
  '',
].join('\n')

const MDSTAT_LIVE = [
  'Personalities : [raid1] ',
  'md127 : active raid1 sdd1[1] sdc1[0]',
  '      2086912 blocks super 1.2 [2/2] [UU]',
  '      ',
  'unused devices: <none>',
  '',
].join('\n')

const MDSTAT_EMPTY = 'Personalities : [raid1] \nunused devices: <none>\n'

const EXPORT_T2_R1 = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=${UUID_T2}\nMD_DEVNAME=t2-r1\nMD_NAME=t2-r1\n`

function pool(mountpoint = MOUNTPOINT): AhrPool {
  return AhrPool.parse({
    name: 't2',
    ahrType: 'ahr1',
    mountpoint,
    mounted: !mountpoint.startsWith('/dev/'),
    disks: [
      { id: SMALL, sizeBytes: 2 * GIB, usableBytes: 2 * GIB, model: 'SMALL', serial: 'S1', role: 'member', partitions: [{ device: `/dev/disk/by-id/${SMALL}-part1`, band: 1, sizeBytes: 2 * GIB - 1024 ** 2 }] },
      { id: BIG, sizeBytes: 3 * GIB, usableBytes: 3 * GIB, model: 'BIG', serial: 'S2', role: 'member', partitions: [{ device: `/dev/disk/by-id/${BIG}-part1`, band: 1, sizeBytes: 2 * GIB - 1024 ** 2 }] },
    ],
    arrays: [{
      device: '/dev/md/t2-r1',
      band: 1,
      level: 'raid1',
      heightBytes: 2 * GIB,
      members: [
        { disk: SMALL, partition: `/dev/disk/by-id/${SMALL}-part1`, memberState: 'in_sync' },
        { disk: BIG, partition: `/dev/disk/by-id/${BIG}-part1`, memberState: 'in_sync' },
      ],
      state: 'clean',
    }],
    vg: { name: 't2', sizeBytes: 2 * GIB, freeBytes: 0 },
    lv: { name: 't2-vol', sizeBytes: 2 * GIB },
    capacity: { rawBytes: 5 * GIB, usableBytes: 2 * GIB, usedBytes: 0, freeBytes: 2 * GIB, redundancyOverheadBytes: 2 * GIB, unprotectedWastedBytes: GIB, pendingBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
  })
}

/**
 * `pool()` with a writethrough read cache attached (ahrcache.1 §13): the cache
 * disk joins the disk set with role 'cache' and `partitions: []` — its slice
 * backs no band, and that single fact is what puts it on destroy's wipe list.
 */
function cachedPool(): AhrPool {
  const base = pool()
  return AhrPool.parse({
    ...base,
    disks: [
      ...base.disks,
      { id: CACHE, sizeBytes: GIB, usableBytes: GIB, model: 'SSD', serial: 'S3', role: 'cache', partitions: [] },
    ],
    cache: { devices: [CACHE], sizeBytes: GIB, mode: 'writethrough', policy: 'smq', state: 'healthy' },
  })
}

function report(kind: 'lv' | 'vg' | 'pv', rows: object[]): string {
  return JSON.stringify({ report: [{ [kind]: rows }] })
}

/** `ls -la /dev/disk/by-id/` — whole-disk + `-part1` links for each id given. */
function byIdListing(disks: { id: string, kernel: string, parts: number }[]): string {
  const lines = ['total 0']
  for (const disk of disks) {
    lines.push(`lrwxrwxrwx 1 root root 9 Aug  9 10:00 ${disk.id} -> ../../${disk.kernel}`)
    for (let n = 1; n <= disk.parts; n++)
      lines.push(`lrwxrwxrwx 1 root root 10 Aug  9 10:00 ${disk.id}-part${n} -> ../../${disk.kernel}${n}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * An `lsblk AHR_LSBLK_ARGS` tree of plain partitioned disks (no md/LVM nodes).
 * A labelled slice reads `linux_raid_member` (a cache slice `LVM2_member`), an
 * unlabelled one `ext4` — or every slice reads blank with `blank: true`, the
 * state a re-run finds after an earlier pass zeroed the superblocks.
 */
function lsblkTree(disks: { kernel: string, parts: (string | null)[] }[], opts: { blank?: boolean } = {}): string {
  return JSON.stringify({
    blockdevices: disks.map(disk => ({
      name: disk.kernel,
      size: 3 * GIB,
      type: 'disk',
      fstype: null,
      mountpoint: null,
      partlabel: null,
      children: disk.parts.map((partlabel, i) => ({
        name: `${disk.kernel}${i + 1}`,
        size: GIB,
        type: 'part',
        fstype: opts.blank ? null : partlabel === null ? 'ext4' : partlabel.includes('-cache') ? 'LVM2_member' : 'linux_raid_member',
        mountpoint: null,
        partlabel,
      })),
    })),
  })
}

/**
 * `mdadm --examine --export <partition>` answers (story ident.3): the md UUID
 * INSIDE each partition is what destroy acts on. `null` = no superblock.
 */
function addExamine(executor: MockExecutor, entries: [string, string | null][]): void {
  for (const [device, uuid] of entries) {
    executor.addFixture({
      command: '/usr/sbin/mdadm',
      args: ['--examine', '--export', device],
      result: uuid === null
        ? { stdout: '', stderr: `mdadm: No md superblock detected on ${device}.`, exitCode: 1 }
        : { stdout: `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_NAME=t2-r1\nMD_UUID=${uuid}\n`, stderr: '', exitCode: 0 },
    })
  }
}

/** The pool's own two member partitions, carrying the pool's superblock. */
const T2_MEMBER_EXAMINE: [string, string][] = [
  [`/dev/disk/by-id/${SMALL}-part1`, UUID_T2],
  [`/dev/disk/by-id/${BIG}-part1`, UUID_T2],
]

/** The pool's own two member disks, exactly as the live system reports them. */
const T2_BY_ID = byIdListing([
  { id: SMALL, kernel: 'sdc', parts: 1 },
  { id: BIG, kernel: 'sdd', parts: 1 },
])
const T2_LSBLK = lsblkTree([
  { kernel: 'sdc', parts: ['t2-d1-b1'] },
  { kernel: 'sdd', parts: ['t2-d2-b1'] },
])

/** Register the disk-truth reads the scrub phase makes (by-id listing + lsblk). */
function addDiskReads(executor: MockExecutor, byId: string, lsblk: string): void {
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: byId, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: { stdout: lsblk, stderr: '', exitCode: 0 } })
}

/** The live-array world of `pool()`: t2-r1 on md127, LVM stack present. */
function liveStackExecutor(): MockExecutor {
  const executor = new MockExecutor()
  addExamine(executor, T2_MEMBER_EXAMINE)
  executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
  return executor
}

/**
 * `blkid -p` on a partition with nothing on it (cr.57: `classifyPartition`
 * asks it once `mdadm --examine` finds no superblock) — the captured blank
 * line `fixtures/zfs/blkid-p-blank-partition.txt` (exit 0, only
 * `PART_ENTRY_*` keys), for every partition the test asks about.
 */
function addBlankBlkid(executor: MockExecutor): void {
  const line = readFileSync(join(import.meta.dirname, '../../fixtures/zfs/blkid-p-blank-partition.txt'), 'utf8')
  executor.addFixture({ command: '/usr/sbin/blkid', argsMatch: a => a.length === 2 && a[0] === '-p', result: { stdout: line, stderr: '', exitCode: 0 } })
}

/** Every command that only READS — the acts are what remains. */
function acts(executor: MockExecutor): { command: string, args: string[] }[] {
  return executor.calls.filter(c =>
    !(c.command === '/usr/bin/cat' || c.command === '/usr/bin/findmnt' || c.command === '/usr/bin/lsblk' || c.command === '/usr/sbin/blkid'
      || c.command === '/usr/bin/ls' || c.command === '/usr/sbin/lvs' || c.command === '/usr/sbin/vgs'
      || c.command === '/usr/sbin/pvs' || (c.command === '/usr/sbin/mdadm' && (c.args[0] === '--detail' || c.args[0] === '--examine'))),
  )
}

describe('destroyAhrPool (Epic 11 + AHR)', () => {
  let dir: string
  let fstabPath: string
  let confPath: string
  const progress: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-destroy-'))
    fstabPath = join(dir, 'fstab')
    confPath = join(dir, 'mdadm.conf')
    progress.length = 0
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('tears the full stack down in order and unpins the conf', async () => {
    await writeFile(fstabPath, FSTAB_SEED)
    await writeFile(confPath, CONF_SEED)
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: {
      stdout: JSON.stringify({ filesystems: [{ target: MOUNTPOINT, source: '/dev/mapper/t2-t2--vol', fstype: 'btrfs', options: 'rw' }] }),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: '-wi-a-----', lv_size: String(2 * GIB) }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: '1', lv_count: '1', vg_size: String(2 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }]), stderr: '', exitCode: 0 } })
    // The live disk truth the scrub phase reads: both member disks attached,
    // every partition on them labeled for this pool and carrying its superblock.
    addDiskReads(executor, T2_BY_ID, T2_LSBLK)
    addExamine(executor, T2_MEMBER_EXAMINE)
    for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    // A healthy teardown reports exactly the pool name: every labeled partition
    // belonged to a disk membership already covered, so the sweep found nothing
    // to add and says nothing (issue #16 — it speaks up only when it acts).
    assert.deepEqual(result, { destroyed: 't2' })

    // The mutation sequence, top-down (reads interleave; assert the acts).
    assert.deepEqual(acts(executor), [
      { command: '/usr/bin/umount', args: [MOUNTPOINT] },
      { command: '/usr/bin/systemctl', args: ['daemon-reload'] },
      { command: '/usr/sbin/lvremove', args: ['-y', 't2/t2-vol'] },
      { command: '/usr/sbin/vgremove', args: ['-y', 't2'] },
      { command: '/usr/sbin/pvremove', args: ['-y', '/dev/md127'] },
      { command: '/usr/sbin/mdadm', args: ['--stop', '/dev/md127'] },
      { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${SMALL}`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${BIG}`] },
      { command: '/usr/sbin/update-initramfs', args: ['-u'] },
    ])

    // fstab: only the pool line removed, the rest byte-preserved.
    const fstab = await readFile(fstabPath, 'utf8')
    assert.ok(!fstab.includes('/dev/t2/t2-vol'))
    assert.ok(fstab.includes('UUID=abc / ext4'))

    // mdadm.conf: our ARRAY unpinned, and because it was the last AHR-shaped
    // pin, ANAS's own PROGRAM hook retires with it (cr.31b). The foreign
    // ARRAY — which never was ANAS's — and the hand comment survive.
    const conf = await readFile(confPath, 'utf8')
    assert.ok(!conf.includes(UUID_T2))
    assert.ok(conf.includes(UUID_FOREIGN))
    assert.ok(!conf.includes('PROGRAM /usr/local/bin/anas-md-event'))
    assert.ok(conf.includes('hand comment survives'))
  })

  /**
   * ahrcache.1 §13: a CACHED pool's LV is a dm-cache TARGET, and `lvremove`
   * REFUSES one. Before the uncache step, destroy stopped dead right there —
   * after the pool was already unmounted and its fstab line removed — leaving a
   * half-destroyed pool whose VG, LV and arrays were all still standing.
   */
  it('a CACHED pool is uncached before lvremove, and the cache disk is zapped with the rest', async () => {
    await writeFile(fstabPath, FSTAB_SEED)
    await writeFile(confPath, CONF_SEED)
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: {
      stdout: JSON.stringify({ filesystems: [{ target: MOUNTPOINT, source: '/dev/mapper/t2-t2--vol', fstype: 'btrfs', options: 'rw' }] }),
      stderr: '',
      exitCode: 0,
    } })
    // `Cwi-aoC---` — the live cached shape from the stunt node (GT-18). The
    // cache volume itself is the HIDDEN `_cvol` and never appears here.
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: 'Cwi-aoC---', lv_size: String(2 * GIB) }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: '2', lv_count: '1', vg_size: String(2 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [
      { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      { pv_name: '/dev/sde1', vg_name: 't2', pv_size: String(GIB), pv_free: '0' },
    ]), stderr: '', exitCode: 0 } })
    addDiskReads(
      executor,
      byIdListing([
        { id: SMALL, kernel: 'sdc', parts: 1 },
        { id: BIG, kernel: 'sdd', parts: 1 },
        { id: CACHE, kernel: 'sde', parts: 1 },
      ]),
      lsblkTree([
        { kernel: 'sdc', parts: ['t2-d1-b1'] },
        { kernel: 'sdd', parts: ['t2-d2-b1'] },
        { kernel: 'sde', parts: ['t2-cache1'] },
      ]),
    )
    addExamine(executor, T2_MEMBER_EXAMINE)
    for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(executor, cachedPool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(result, { destroyed: 't2' })

    const sequence = acts(executor)
    assert.deepEqual(sequence, [
      { command: '/usr/bin/umount', args: [MOUNTPOINT] },
      { command: '/usr/bin/systemctl', args: ['daemon-reload'] },
      // THE fix: the cache is released before the volume can be removed.
      { command: '/usr/sbin/lvconvert', args: ['--config', 'devices/allow_mixed_block_sizes=1', '-y', '--uncache', 't2/t2-vol'] },
      { command: '/usr/sbin/lvremove', args: ['-y', 't2/t2-vol'] },
      { command: '/usr/sbin/vgremove', args: ['-y', 't2'] },
      { command: '/usr/sbin/pvremove', args: ['-y', '/dev/md127'] },
      { command: '/usr/sbin/pvremove', args: ['-y', '/dev/sde1'] },
      { command: '/usr/sbin/mdadm', args: ['--stop', '/dev/md127'] },
      { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${SMALL}`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${BIG}`] },
      // The cache slice needs no step of its own: the cache disk is in the
      // pool's disk set with role 'cache', and its slice was a PV of THIS
      // pool's VG when destroy started (ident.3) — so it is zapped with the rest.
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${CACHE}`] },
      { command: '/usr/sbin/update-initramfs', args: ['-u'] },
    ])
  })

  it('an UNCACHED pool issues no lvconvert at all', async () => {
    // The sibling of the test above, and the reason the uncache is conditional:
    // `lvconvert --uncache` on a plain linear LV is an error, not a no-op.
    await writeFile(fstabPath, FSTAB_SEED)
    await writeFile(confPath, CONF_SEED)
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: '-wi-ao----', lv_size: String(2 * GIB) }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
    addDiskReads(executor, T2_BY_ID, T2_LSBLK)
    for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.equal(executor.calls.some(c => c.command === '/usr/sbin/lvconvert'), false)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvremove').length, 1)
  })

  it('re-run on a half-destroyed pool: every absent layer is skipped, not an error', async () => {
    // Post-destroy world: nothing mounted, no fstab line, no LVM, no arrays,
    // conf already unpinned — only the disks (and possibly stale superblocks)
    // remain addressable.
    await writeFile(fstabPath, '# empty\n')
    await writeFile(confPath, `ARRAY /dev/md/foreign metadata=1.2 UUID=${UUID_FOREIGN}\n`)
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_EMPTY, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
    // The earlier pass zeroed every superblock: the slices are empty and
    // carry only this pool's labels — the state that must still be finished.
    addDiskReads(executor, T2_BY_ID, lsblkTree([
      { kernel: 'sdc', parts: ['t2-d1-b1'] },
      { kernel: 'sdd', parts: ['t2-d2-b1'] },
    ], { blank: true }))
    addBlankBlkid(executor)
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: 'Unrecognised md component device', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(result, { destroyed: 't2' })

    const commands = executor.calls.map(c => c.command)
    for (const never of ['/usr/bin/umount', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/bin/systemctl', '/usr/sbin/update-initramfs'])
      assert.ok(!commands.includes(never), `${never} must not run on a half-destroyed pool`)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
    // Nothing proves a superblock is there to zero (ident.3: only the pool's
    // own are zeroed) — but the empty, pool-labelled tables are still dropped,
    // so the re-run finishes what the first pass started.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--zero-superblock').length, 0)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/sgdisk' && c.args[0] === '--zap-all').length, 2)
    // The foreign pin and the fstab were untouched.
    assert.equal(await readFile(confPath, 'utf8'), `ARRAY /dev/md/foreign metadata=1.2 UUID=${UUID_FOREIGN}\n`)
    assert.equal(await readFile(fstabPath, 'utf8'), '# empty\n')
  })

  it('unmounted-but-persisted pool: the fstab line is still found by LV spec', async () => {
    await writeFile(fstabPath, FSTAB_SEED)
    await writeFile(confPath, '')
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_EMPTY, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })

    // Topology reports the LV device path as "mountpoint" when unmounted.
    await destroyAhrPool(executor, pool('/dev/t2/t2-vol'), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })

    const fstab = await readFile(fstabPath, 'utf8')
    assert.ok(!fstab.includes('/dev/t2/t2-vol'))
    assert.ok(!executor.calls.some(c => c.command === '/usr/bin/umount'))
  })

  /**
   * smbsvc.1: enabling Previous Versions on an AHR share adds ONE read-only
   * `@snapshots` fstab line at /mnt/anas-ahr-snapshots/<pool> — SAME LV spec as
   * the pool's own line — and the design keeps that mount across enable/disable
   * on purpose. Destroy must take it with the pool: a still-mounted one holds
   * the LV open (lvremove would fail the job), and a surviving line would dangle
   * across a pool that no longer exists. The one place the "the mount stays"
   * ruling ends.
   */
  it('a Previous Versions @snapshots mount is unmounted and its fstab line goes with the pool', async () => {
    await writeFile(fstabPath, [
      '# static file system information',
      'UUID=abc / ext4 errors=remount-ro 0 1',
      `/dev/t2/t2-vol ${MOUNTPOINT} btrfs nofail 0 0`,
      `/dev/t2/t2-vol ${SNAP_MOUNT} btrfs ro,nofail,subvol=@snapshots 0 0`,
      '',
    ].join('\n'))
    await writeFile(confPath, '')
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_EMPTY, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: {
      stdout: JSON.stringify({ filesystems: [
        { target: MOUNTPOINT, source: '/dev/mapper/t2-t2--vol', fstype: 'btrfs', options: 'rw,subvol=/@data' },
        { target: SNAP_MOUNT, source: '/dev/mapper/t2-t2--vol', fstype: 'btrfs', options: 'ro,subvol=/@snapshots' },
      ] }),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/umount', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(result, { destroyed: 't2' })

    // BOTH mounts go — pool mountpoint first, then the @snapshots sibling —
    // before the LVM teardown reads the LV.
    assert.deepEqual(
      executor.calls.filter(c => c.command === '/usr/bin/umount').map(c => c.args[0]),
      [MOUNTPOINT, SNAP_MOUNT],
    )
    assert.ok(progress.some(m => m.includes(SNAP_MOUNT) && m.includes('@snapshots')))
    // Both fstab lines (same spec, two mountpoints) are gone; the rest survives.
    const fstab = await readFile(fstabPath, 'utf8')
    assert.ok(!fstab.includes('/dev/t2/t2-vol'))
    assert.ok(fstab.includes('UUID=abc / ext4'))
  })

  it('an unmounted pool with a still-mounted @snapshots mount: only the @snapshots unmount runs, its line still removed', async () => {
    // Topology reports the LV device path as "mountpoint" when the pool is not
    // mounted — but the @snapshots mount is independent of that state (it stays
    // across disable). Destroy must still unmount it and take both lines.
    await writeFile(fstabPath, [
      'UUID=abc / ext4 errors=remount-ro 0 1',
      `/dev/t2/t2-vol ${SNAP_MOUNT} btrfs ro,nofail,subvol=@snapshots 0 0`,
      '',
    ].join('\n'))
    await writeFile(confPath, '')
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_EMPTY, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: {
      stdout: JSON.stringify({ filesystems: [
        { target: SNAP_MOUNT, source: '/dev/mapper/t2-t2--vol', fstype: 'btrfs', options: 'ro,subvol=/@snapshots' },
      ] }),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/umount', result: { stdout: '', stderr: '', exitCode: 0 } })

    await destroyAhrPool(executor, pool('/dev/t2/t2-vol'), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })

    // The pool mountpoint is not mounted (nothing to unmount there) — but the
    // @snapshots mount is, and holding the LV open would fail the lvremove.
    assert.deepEqual(
      executor.calls.filter(c => c.command === '/usr/bin/umount').map(c => c.args[0]),
      [SNAP_MOUNT],
    )
    const fstab = await readFile(fstabPath, 'utf8')
    assert.ok(!fstab.includes('/dev/t2/t2-vol'))
    assert.ok(fstab.includes('UUID=abc / ext4'))
  })

  /**
   * Issue #16 (pve5, 2026-08-09). chiaahr2 was destroyed while member d4 had
   * dropped out of all three band arrays: its four attached siblings were fully
   * blanked, and d4 kept EVERYTHING — three partitions, live md superblocks
   * (events 10617/3/5986) and its `chiaahr2-d4-b*` labels. mdadm's incremental
   * assembly then resurrected ghost inactive arrays (md125/md127) at the next
   * boot, which blocked the clean re-add with `ADD_NEW_DISK not supported`.
   *
   * The gap was structural: destroy derived its whole wipe list from CURRENT
   * array membership, and a dropped-out member — the likeliest state for a disk
   * in a pool being destroyed after trouble — appears nowhere in it.
   */
  describe('partlabel sweep — members no array claims (issue #16)', () => {
    beforeEach(async () => {
      await writeFile(fstabPath, '# empty\n')
      await writeFile(confPath, CONF_SEED)
    })

    it('a detached member is found by its labels: superblocks zeroed, exclusive disk zapped', async () => {
      const executor = liveStackExecutor()
      addDiskReads(
        executor,
        byIdListing([
          { id: SMALL, kernel: 'sdc', parts: 1 },
          { id: BIG, kernel: 'sdd', parts: 1 },
          { id: DETACHED, kernel: 'sde', parts: 2 },
        ]),
        // sde carries this pool's labels and NOTHING else — the pve5 shape.
        lsblkTree([
          { kernel: 'sdc', parts: ['t2-d1-b1'] },
          { kernel: 'sdd', parts: ['t2-d2-b1'] },
          { kernel: 'sde', parts: ['t2-d3-b1', 't2-d3-b2'] },
        ]),
      )
      // Its superblocks still name THIS pool's array (the UUID pinned in the
      // conf) — what makes them the pool's to zero, not the labels.
      addExamine(executor, [[`/dev/disk/by-id/${DETACHED}-part1`, UUID_T2], [`/dev/disk/by-id/${DETACHED}-part2`, UUID_T2]])
      executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
      for (const command of ['/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
        executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

      const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })

      // The detached disk gets the SAME acts, in the same order, as an attached
      // member — after the membership-derived scrub, before the conf unpin.
      assert.deepEqual(acts(executor), [
        { command: '/usr/sbin/mdadm', args: ['--stop', '/dev/md127'] },
        { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${SMALL}-part1`] },
        { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${BIG}-part1`] },
        { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${SMALL}`] },
        { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${BIG}`] },
        { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${DETACHED}-part1`] },
        { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${DETACHED}-part2`] },
        { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${DETACHED}`] },
        { command: '/usr/sbin/update-initramfs', args: ['-u'] },
      ])
      // What the sweep did is REPORTED — the operator learns a disk membership
      // never mentioned was scrubbed.
      assert.deepEqual(result, {
        destroyed: 't2',
        sweptPartitions: [`/dev/disk/by-id/${DETACHED}-part1`, `/dev/disk/by-id/${DETACHED}-part2`],
        sweptDisks: [DETACHED],
      })
      assert.ok(progress.some(m => m.includes(`${DETACHED}-part1`) && m.includes('no array claims')))
      assert.ok(progress.some(m => m.includes(`Zapping partition table on ${DETACHED}`)))
    })

    it('a swept disk carrying anything else keeps its partition table', async () => {
      const executor = liveStackExecutor()
      addDiskReads(
        executor,
        byIdListing([
          { id: SMALL, kernel: 'sdc', parts: 1 },
          { id: BIG, kernel: 'sdd', parts: 1 },
          { id: DETACHED, kernel: 'sde', parts: 2 },
        ]),
        // sde2 is somebody else's — the disk is no longer exclusively this pool's.
        lsblkTree([
          { kernel: 'sdc', parts: ['t2-d1-b1'] },
          { kernel: 'sdd', parts: ['t2-d2-b1'] },
          { kernel: 'sde', parts: ['t2-d3-b1', null] },
        ]),
      )
      addExamine(executor, [[`/dev/disk/by-id/${DETACHED}-part1`, UUID_T2], [`/dev/disk/by-id/${DETACHED}-part2`, null]])
      executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
      for (const command of ['/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
        executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

      const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })

      // The superblock is gone — which is what closes the ghost-assembly hole —
      // but the GPT stays: ANAS is a guest on a disk it no longer solely owns.
      assert.deepEqual(result, {
        destroyed: 't2',
        sweptPartitions: [`/dev/disk/by-id/${DETACHED}-part1`],
        preservedDisks: [DETACHED],
      })
      assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/sgdisk' && c.args[1] === `/dev/disk/by-id/${DETACHED}`))
      assert.ok(progress.some(m => m.includes(`Leaving the partition table on ${DETACHED}`)))
    })

    it('a member that is NOT attached is reported, never silently skipped', async () => {
      const executor = liveStackExecutor()
      // GONE has no by-id entry at all: the disk is not in the machine.
      addDiskReads(executor, T2_BY_ID, T2_LSBLK)
      // Its scrub commands would fail exactly like this against a path that does
      // not exist — which is why they must not be attempted.
      executor.addFixture({ command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${GONE}`], result: { stdout: '', stderr: `Problem opening /dev/disk/by-id/${GONE} for reading!`, exitCode: 2 } })
      executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
      for (const command of ['/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
        executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

      const target: AhrDestroyTarget = {
        ...pool(),
        disks: [...pool().disks, { id: GONE, partitions: [{ device: `/dev/disk/by-id/${GONE}-part1` }] }],
      }
      const result = await destroyAhrPool(executor, target, m => progress.push(m), { fstabPath, mdadmConfPath: confPath })

      assert.deepEqual(result, { destroyed: 't2', absentDisks: [GONE] })
      // Said out loud: what cannot be scrubbed comes back with the disk.
      assert.ok(progress.some(m =>
        m.includes(GONE) && m.includes('no /dev/disk/by-id entry') && m.includes('CANNOT be scrubbed')))
      // Nothing was attempted against the absent disk; the attached two are
      // still fully scrubbed, and the teardown completes.
      assert.ok(!executor.calls.some(c => c.args.some(a => a.includes(GONE))))
      assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--zero-superblock').length, 2)
      assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/sgdisk' && c.args[0] === '--zap-all').length, 2)
    })
  })
})

/**
 * Story ident.3 — destroy acts on identity, never on a name. A foreign
 * `media-r1` beside a pool `media` (hand-built, or moved in from another node)
 * carries every name destroy used to match on.
 */
describe('destroyAhrPool — identity, not names (ident.3)', () => {
  let dir: string
  let fstabPath: string
  let confPath: string
  const progress: string[] = []
  const FOREIGN_DISK = 'ata-FOREIGN_MEDIA'

  const MDSTAT_OURS_AND_FOREIGN = [
    'Personalities : [raid1] ',
    'md127 : active raid1 sdd1[1] sdc1[0]',
    '      2086912 blocks super 1.2 [2/2] [UU]',
    '      ',
    'md9 : active raid1 sdf1[1] sde1[0]',
    '      2086912 blocks super 1.2 [2/2] [UU]',
    '      ',
    'unused devices: <none>',
    '',
  ].join('\n')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-destroy-ident-'))
    fstabPath = join(dir, 'fstab')
    confPath = join(dir, 'mdadm.conf')
    progress.length = 0
    await writeFile(fstabPath, '# empty\n')
    await writeFile(confPath, CONF_SEED)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function world(): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_OURS_AND_FOREIGN, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    // The foreign one is named EXACTLY like our band 1 — only its UUID differs.
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md9'], result: { stdout: `MD_LEVEL=raid1\nMD_UUID=${UUID_FOREIGN}\nMD_NAME=otherbox:t2-r1\n`, stderr: '', exitCode: 0 } })
    addExamine(executor, [
      ...T2_MEMBER_EXAMINE,
      [`/dev/disk/by-id/${FOREIGN_DISK}-part1`, UUID_FOREIGN],
    ])
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [
      { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      // The foreign array is a PV of ITS OWN volume group.
      { pv_name: '/dev/md9', vg_name: 'media', pv_size: String(2 * GIB), pv_free: '0' },
    ]), stderr: '', exitCode: 0 } })
    addDiskReads(
      executor,
      byIdListing([
        { id: SMALL, kernel: 'sdc', parts: 1 },
        { id: BIG, kernel: 'sdd', parts: 1 },
        { id: FOREIGN_DISK, kernel: 'sde', parts: 1 },
      ]),
      // The foreign member even carries a `t2-*` LABEL (a pool of the same
      // name, built on another node) — still not ours: its superblock says so.
      lsblkTree([
        { kernel: 'sdc', parts: ['t2-d1-b1'] },
        { kernel: 'sdd', parts: ['t2-d2-b1'] },
        { kernel: 'sde', parts: ['t2-d1-b1'] },
      ]),
    )
    for (const command of ['/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
    return executor
  }

  it('a same-named FOREIGN array is never stopped, its partitions never zeroed, its disk never zapped', async () => {
    const executor = world()
    const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })

    assert.deepEqual(acts(executor), [
      { command: '/usr/sbin/pvremove', args: ['-y', '/dev/md127'] },
      { command: '/usr/sbin/mdadm', args: ['--stop', '/dev/md127'] },
      { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${SMALL}`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${BIG}`] },
      { command: '/usr/sbin/update-initramfs', args: ['-u'] },
    ])
    assert.ok(!executor.calls.some(c => c.args.includes('/dev/md9') && c.command !== '/usr/sbin/mdadm'), 'no LVM act on the foreign PV')
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop' && c.args[1] === '/dev/md9'))
    assert.ok(!executor.calls.some(c => c.args.some(a => a.includes(FOREIGN_DISK)) && c.args[0] !== '--examine'))
    assert.deepEqual(result, { destroyed: 't2', preservedDisks: [FOREIGN_DISK], foreignArrays: ['/dev/md9'] })
    assert.ok(progress.some(m => m.includes('/dev/md9') && m.includes('not this pool')))
    // Only OUR pin left the conf.
    const conf = await readFile(confPath, 'utf8')
    assert.ok(!conf.includes(UUID_T2))
    assert.ok(conf.includes(UUID_FOREIGN))
  })

  it('the expansion intent goes with the pool when the caller names its directory', async () => {
    const intentDir = join(dir, 'intent')
    await mkdir(intentDir)
    await writeFile(join(intentDir, 't2.json'), '{}')
    await destroyAhrPool(world(), pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath, intentDir })
    assert.equal(existsSync(join(intentDir, 't2.json')), false)
  })

  it('a cache slice that is a PV of ANOTHER volume group is not this pool\'s to zap', async () => {
    // pool() with a cache disk whose `t2-cache1` slice LVM counts in `media`.
    const target: AhrDestroyTarget = { ...pool(), disks: [...pool().disks, { id: CACHE, partitions: [] }] }
    const ex = new MockExecutor()
    ex.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    addExamine(ex, T2_MEMBER_EXAMINE)
    ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [
      { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      { pv_name: '/dev/sde1', vg_name: 'media', pv_size: String(GIB), pv_free: '0' },
    ]), stderr: '', exitCode: 0 } })
    addDiskReads(
      ex,
      byIdListing([{ id: SMALL, kernel: 'sdc', parts: 1 }, { id: BIG, kernel: 'sdd', parts: 1 }, { id: CACHE, kernel: 'sde', parts: 1 }]),
      lsblkTree([{ kernel: 'sdc', parts: ['t2-d1-b1'] }, { kernel: 'sdd', parts: ['t2-d2-b1'] }, { kernel: 'sde', parts: ['t2-cache1'] }]),
    )
    addExamine(ex, [[`/dev/disk/by-id/${CACHE}-part1`, null]])
    for (const command of ['/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      ex.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(ex, target, m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.ok(!ex.calls.some(c => c.command === '/usr/sbin/sgdisk' && c.args.includes(`/dev/disk/by-id/${CACHE}`)), 'the other VG\'s cache disk keeps its GPT')
    assert.ok(!ex.calls.some(c => c.command === '/usr/sbin/pvremove' && c.args.includes('/dev/sde1')))
    assert.deepEqual(result.preservedDisks, [CACHE])
  })

  it('the failed-create rollback stops the arrays IT created, though nothing pins them yet', async () => {
    await writeFile(confPath, '') // the create died before its pin step
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    for (const command of ['/usr/sbin/lvs', '/usr/sbin/vgs'])
      executor.addFixture({ command, result: { stdout: report(command.endsWith('lvs') ? 'lv' : 'vg', []), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
    addDiskReads(executor, T2_BY_ID, T2_LSBLK)
    for (const command of ['/usr/sbin/sgdisk', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    // Without the UUIDs it created, nothing proves md127 is the rollback's…
    const blind = await destroyAhrPool(executor, { ...pool(), disksWipedByCaller: true }, m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.ok(!executor.calls.some(c => c.args[0] === '--stop'))
    assert.deepEqual(blind.foreignArrays, ['/dev/md127'])
    // …with them, it is stopped, and its own wiped disks are scrubbed.
    executor.calls.length = 0
    await destroyAhrPool(executor, { ...pool(), disksWipedByCaller: true, createdArrayUuids: [UUID_T2] }, m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.ok(executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop' && c.args[1] === '/dev/md127'))
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--zero-superblock').length, 2)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/sgdisk' && c.args[0] === '--zap-all').length, 2)
  })
})

/**
 * Code review H6 — the LVM-teardown gate. Destroy keys the LV/VG/PV layer by
 * the pool NAME; it may act only when every PV of that VG is, ON THE DISKS, a
 * device the pool owns (an array ident.3 identified, or an ahrcache.1 cache
 * slice). A foreign VG of the same name — PVE's `pve`, a pool moved in from
 * another node — is refused whole, and the md teardown that follows must not
 * run either (LVM tears down BEFORE md; a refusal aborts before any md --stop).
 */
describe('destroyAhrPool — the LVM teardown gate (H6)', () => {
  let dir: string
  let fstabPath: string
  let confPath: string
  const progress: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-destroy-h6-'))
    fstabPath = join(dir, 'fstab')
    confPath = join(dir, 'mdadm.conf')
    progress.length = 0
    await writeFile(fstabPath, FSTAB_SEED)
    await writeFile(confPath, CONF_SEED)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** The pool's live world: its own array via the conf pin, disks readable. */
  function world(): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    addDiskReads(executor, T2_BY_ID, T2_LSBLK)
    // The pool's fstab line is present, so a teardown that passes the gate
    // daemon-reloads after removing it (cr.31 D2: never before the gate).
    executor.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    return executor
  }

  /**
   * cr.31 D2 (live proof wave 1b R2-D2) — the review's node shape: a hand-built
   * md array `t2-r1` pinned the way `mdadm --detail --scan >> mdadm.conf` pins
   * any array, beside a FOREIGN VG `t2` on another device whose LV is mounted
   * from the operator's own fstab line. The topology takes that LV's mount as
   * the pool's mountpoint, so before cr.31 the refused destroy had already
   * unmounted it, deleted the line and daemon-reloaded.
   */
  describe('cr.31 D2: a refused destroy changes NOTHING — no umount, no fstab edit, no daemon-reload', () => {
    const FOREIGN_MP = '/mnt/anasproof-fgn'
    const FOREIGN_FSTAB = [
      '# static file system information',
      'UUID=abc / ext4 errors=remount-ro 0 1',
      `/dev/t2/lv0 ${FOREIGN_MP} ext4 defaults,nofail 0 0`,
      '',
    ].join('\n')

    function foreignWorld(pvRows: { pv_name: string, vg_name: string, pv_size: string, pv_free: string }[]): MockExecutor {
      const executor = new MockExecutor()
      executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
      addDiskReads(executor, T2_BY_ID, T2_LSBLK)
      addExamine(executor, T2_MEMBER_EXAMINE)
      executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: {
        stdout: JSON.stringify({ filesystems: [{ target: FOREIGN_MP, source: '/dev/mapper/t2-lv0', fstype: 'ext4', options: 'rw' }] }),
        stderr: '',
        exitCode: 0,
      } })
      executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: String(pvRows.filter(r => r.vg_name === 't2').length), lv_count: '1', vg_size: String(GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', pvRows), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', [{ lv_name: 'lv0', vg_name: 't2', lv_attr: '-wi-ao----', lv_size: String(GIB) }]), stderr: '', exitCode: 0 } })
      // Every act would succeed — the only thing standing between the job and
      // the operator's mount is the gate.
      for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgreduce', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
        executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
      return executor
    }

    for (const [label, pvRows] of [
      ['the foreign VG on its own device, the pinned array beside it', [
        { pv_name: '/dev/loop4', vg_name: 't2', pv_size: String(GIB), pv_free: '0' },
        { pv_name: '/dev/md127', vg_name: '', pv_size: String(2 * GIB), pv_free: String(2 * GIB) },
      ]],
      ['the pinned array joined to the foreign VG (the hand-added PV shape)', [
        { pv_name: '/dev/loop4', vg_name: 't2', pv_size: String(GIB), pv_free: '0' },
        { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      ]],
    ] as const) {
      it(`${label}: refused, and the mount, fstab and conf are untouched`, async () => {
        await writeFile(fstabPath, FOREIGN_FSTAB)
        const executor = foreignWorld([...pvRows])
        await assert.rejects(
          destroyAhrPool(executor, pool(FOREIGN_MP), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
          /volume group 't2' contains physical volume \/dev\/loop4 — not this pool's arrays or cache slices/,
        )
        // Nothing but reads ran: no umount, no daemon-reload, no LVM/md/disk act.
        assert.deepEqual(acts(executor), [])
        assert.ok(!progress.some(p => /Unmounting|Removing \/etc\/fstab/.test(p)), progress.join(' | '))
        assert.equal(await readFile(fstabPath, 'utf8'), FOREIGN_FSTAB, 'fstab byte-identical')
        assert.equal(await readFile(confPath, 'utf8'), CONF_SEED, 'mdadm.conf byte-identical')
      })
    }

    it('an unreadable fstab stops the destroy before the unmount, too', async () => {
      const executor = foreignWorld([{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }])
      await rm(fstabPath)
      await mkdir(fstabPath) // reading a directory throws EISDIR — not ENOENT
      await assert.rejects(destroyAhrPool(executor, pool(FOREIGN_MP), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }))
      assert.deepEqual(acts(executor), [])
    })
  })

  it('a VG named like the pool that also holds a FOREIGN PV is refused — no lvremove/vgremove/pvremove, no md stop', async () => {
    const executor = world()
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: '2', lv_count: '2', vg_size: String(3 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [
      { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      // PVE's VM-disk partition, or an operator's hand-added PV — not a band array, not a pool cache slice.
      { pv_name: '/dev/sdz3', vg_name: 't2', pv_size: String(GIB), pv_free: '0' },
    ]), stderr: '', exitCode: 0 } })
    // No lvs fixture — the gate must refuse before LVM is even listed.

    await assert.rejects(
      destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
      /volume group 't2' contains physical volume \/dev\/sdz3/,
    )
    for (const never of ['/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/lvconvert'])
      assert.ok(!executor.calls.some(c => c.command === never), `${never} must not run on a foreign-PV VG`)
    // The md layer must not be torn down either: destroy removes LVM BEFORE the
    // arrays are stopped, so a refused LVM layer aborts before any --stop.
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--zero-superblock'))
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/sgdisk' && c.args[0] === '--zap-all'))
  })

  it('an md PV of the VG that is ANOTHER pool\'s array is foreign too', async () => {
    const executor = world()
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: '1', lv_count: '1', vg_size: String(2 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [
      // md9 is the OTHER pool's array — it carries the pool's name convention
      // only if a pool of the same name built it on another node.
      { pv_name: '/dev/md9', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
    ]), stderr: '', exitCode: 0 } })

    await assert.rejects(
      destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
      /contains physical volume \/dev\/md9/,
    )
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/lvremove'))
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
  })

  it('an unreadable `pvs` REFUSES the LVM teardown (fail closed)', async () => {
    const executor = world()
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: '', stderr: 'pvs: internal error', exitCode: 5 } })

    await assert.rejects(
      destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
      /cannot read LVM physical volumes/,
    )
    for (const never of ['/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove'])
      assert.ok(!executor.calls.some(c => c.command === never), `${never} must not run on an unprovable VG`)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
  })

  /**
   * cr.31b (fail closed): an unreadable `lvs` was read as "no LVs", and the
   * teardown went on — `vgremove -y` then removed the LVs itself, skipping the
   * uncache step the LV loop owns, and the job claimed a teardown it never
   * performed. Now the failing read stops the destroy before any act.
   */
  it('an unreadable `lvs` stops the destroy before any act (fail closed, cr.31b)', async () => {
    const executor = world()
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: '1', lv_count: '1', vg_size: String(2 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: '', stderr: '  Can\'t get production state for volume group "t2"', exitCode: 5 } })
    // Every act WOULD succeed — the only thing standing between the job and
    // the teardown is the failed read.
    for (const command of ['/usr/bin/umount', '/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgreduce', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/mdadm', '/usr/sbin/update-initramfs'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    await assert.rejects(
      destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
      /cannot read LVM logical volumes before destroying 't2' \(lvs: Can't get production state for volume group "t2"\) — stopping before any change/,
    )
    // Nothing but reads ran: no umount, no daemon-reload, no LVM/md/disk act.
    assert.deepEqual(acts(executor), [])
    assert.ok(!progress.some(p => /Unmounting|Removing \/etc\/fstab/.test(p)), progress.join(' | '))
    assert.equal(await readFile(fstabPath, 'utf8'), FSTAB_SEED, 'fstab byte-identical')
    assert.equal(await readFile(confPath, 'utf8'), CONF_SEED, 'mdadm.conf byte-identical')
  })

  it('a cached pool\'s PROVEN cache slice passes the gate, and the cached teardown still runs in order', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    addDiskReads(
      executor,
      byIdListing([
        { id: SMALL, kernel: 'sdc', parts: 1 },
        { id: BIG, kernel: 'sdd', parts: 1 },
        { id: CACHE, kernel: 'sde', parts: 1 },
      ]),
      lsblkTree([
        { kernel: 'sdc', parts: ['t2-d1-b1'] },
        { kernel: 'sdd', parts: ['t2-d2-b1'] },
        // The cache slice is labelled — the gate's ahrcache.1 recognition.
        { kernel: 'sde', parts: ['t2-cache1'] },
      ]),
    )
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: '2', lv_count: '1', vg_size: String(3 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', [
      { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      { pv_name: '/dev/sde1', vg_name: 't2', pv_size: String(GIB), pv_free: '0' },
    ]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: 'Cwi-aoC---', lv_size: String(2 * GIB) }]), stderr: '', exitCode: 0 } })
    addExamine(executor, T2_MEMBER_EXAMINE)
    for (const command of ['/usr/bin/systemctl', '/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    await destroyAhrPool(executor, cachedPool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    // The cache-target LV is still uncached first, then the LV/VG/PV go.
    assert.ok(executor.calls.some(c => c.command === '/usr/sbin/lvconvert' && c.args.includes('--uncache') && c.args.includes('t2/t2-vol')))
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvremove').length, 1)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/pvremove').length, 2)
  })

  // ---- cr.22 ------------------------------------------------------------------

  const MIXED = ['--config', 'devices/allow_mixed_block_sizes=1']
  const ok = (stdout = ''): { stdout: string, stderr: string, exitCode: number } => ({ stdout, stderr: '', exitCode: 0 })
  /** The dead-cache shape of lvm-pvs-cache-missing.json, on t2: the band named, the cache PV `[unknown]`. */
  const DEAD_CACHE_PVS = report('pv', [
    { pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
    { pv_name: '[unknown]', vg_name: 't2', pv_size: String(GIB), pv_free: '0', dev_size: '0' },
  ])

  /** world() plus the acts a full teardown needs, and the LVM reads given. */
  function teardownWorld(lvm: { pvs: { stdout: string, stderr: string, exitCode: number }[], vgs: { stdout: string, stderr: string, exitCode: number }[], lvs: string }): MockExecutor {
    const executor = world()
    executor.addFixture({ command: '/usr/sbin/pvs', results: lvm.pvs })
    executor.addFixture({ command: '/usr/sbin/vgs', results: lvm.vgs })
    executor.addFixture({ command: '/usr/sbin/lvs', result: ok(lvm.lvs) })
    addExamine(executor, T2_MEMBER_EXAMINE)
    for (const command of ['/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgreduce', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: ok() })
    return executor
  }
  const T2_VGS = ok(report('vg', [{ vg_name: 't2', pv_count: '2', lv_count: '1', vg_size: String(3 * GIB), vg_free: '0' }]))
  const CACHED_LV = report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: 'Cwi-aoC-p-', lv_size: String(2 * GIB) }])

  it('cr.22: a dead cache device — uncache, lvremove, `vgreduce --removemissing`, vgremove, and `pvremove` names only /dev/md127', async () => {
    // LVM as it moves: the missing row stays until the vgreduce; after the
    // vgremove the band is an orphan PV.
    const executor = teardownWorld({
      pvs: [ok(DEAD_CACHE_PVS), ok(DEAD_CACHE_PVS), ok(DEAD_CACHE_PVS), ok(report('pv', [{ pv_name: '/dev/md127', vg_name: '', pv_size: String(2 * GIB), pv_free: String(2 * GIB) }]))],
      vgs: [T2_VGS, T2_VGS],
      lvs: CACHED_LV,
    })
    await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    const lvmActs = acts(executor).filter(c => ['/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgreduce', '/usr/sbin/vgremove', '/usr/sbin/pvremove'].includes(c.command))
    assert.deepEqual(lvmActs, [
      { command: '/usr/sbin/lvconvert', args: [...MIXED, '-y', '--uncache', 't2/t2-vol'] },
      { command: '/usr/sbin/lvremove', args: ['-y', 't2/t2-vol'] },
      { command: '/usr/sbin/vgreduce', args: [...MIXED, '--removemissing', 't2'] },
      { command: '/usr/sbin/vgremove', args: ['-y', 't2'] },
      { command: '/usr/sbin/pvremove', args: ['-y', '/dev/md127'] },
    ])
    assert.ok(progress.includes('Dropping the missing devices from volume group t2'))
  })

  it('cr.22: `pvremove` is NEVER given `[unknown]`, even when `pvs` still lists the missing row (the review\'s observation)', async () => {
    // A static pvs answer — exactly what the review's probe saw: the old pass
    // took every row of the VG, `[unknown]` included.
    const executor = teardownWorld({ pvs: [ok(DEAD_CACHE_PVS)], vgs: [T2_VGS], lvs: CACHED_LV })
    await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(executor.calls.filter(c => c.command === '/usr/sbin/pvremove').map(c => c.args), [['-y', '/dev/md127']])
  })

  it('cr.22: `pvremove` skips a PV the gate did not prove and a PV another VG holds', async () => {
    const before = report('pv', [{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }])
    const executor = teardownWorld({
      pvs: [ok(before), ok(before), ok(before), ok(report('pv', [
        { pv_name: '/dev/md127', vg_name: '', pv_size: String(2 * GIB), pv_free: '0' },
        // An orphan PV nobody proved, and a PV of someone else's VG.
        { pv_name: '/dev/sdz3', vg_name: '', pv_size: String(GIB), pv_free: '0' },
        { pv_name: '/dev/sdy1', vg_name: 'other', pv_size: String(GIB), pv_free: '0' },
      ]))],
      vgs: [ok(report('vg', [{ vg_name: 't2', pv_count: '1' }]))],
      lvs: report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: '-wi-a-----', lv_size: String(2 * GIB) }]),
    })
    await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(executor.calls.filter(c => c.command === '/usr/sbin/pvremove').map(c => c.args), [['-y', '/dev/md127']])
    // No missing PV: no vgreduce at all.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/vgreduce').length, 0)
  })

  it('cr.22: the pool\'s own array is not pvremoved once ANOTHER VG holds it (pvremove is never sent at a PV in use)', async () => {
    const before = report('pv', [{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }])
    const executor = teardownWorld({
      pvs: [ok(before), ok(before), ok(before), ok(report('pv', [{ pv_name: '/dev/md127', vg_name: 'other', pv_size: String(2 * GIB), pv_free: '0' }]))],
      vgs: [ok(report('vg', [{ vg_name: 't2', pv_count: '1' }]))],
      lvs: report('lv', []),
    })
    await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/pvremove').length, 0)
  })

  it('cr.22: the review\'s shape — a VG of nothing but `[unknown]` rows — refuses before any LVM or md act', async () => {
    const executor = world()
    executor.addFixture({ command: '/usr/sbin/vgs', result: T2_VGS })
    executor.addFixture({ command: '/usr/sbin/pvs', result: ok(report('pv', [
      { pv_name: '[unknown]', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' },
      { pv_name: '[unknown]', vg_name: 't2', pv_size: String(GIB), pv_free: '0' },
    ])) })
    await assert.rejects(
      destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
      /volume group 't2' has no physical volume that is this pool's own array or cache slice/,
    )
    for (const never of ['/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgreduce', '/usr/sbin/vgremove', '/usr/sbin/pvremove'])
      assert.ok(!executor.calls.some(c => c.command === never), never)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
  })

  it('cr.22: `vgs` unreadable after the LVs are gone stops before vgremove/pvremove instead of skipping the vgremove', async () => {
    const before = report('pv', [{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }])
    const executor = teardownWorld({
      pvs: [ok(before)],
      vgs: [ok(report('vg', [{ vg_name: 't2', pv_count: '1' }])), { stdout: '', stderr: 'vgs: locking failed', exitCode: 5 }],
      lvs: report('lv', [{ lv_name: 't2-vol', vg_name: 't2', lv_attr: '-wi-a-----', lv_size: String(2 * GIB) }]),
    })
    await assert.rejects(
      destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath }),
      /cannot read LVM volume groups before removing 't2' \(vgs: vgs: locking failed\) — stopping before vgremove/,
    )
    for (const never of ['/usr/sbin/vgremove', '/usr/sbin/pvremove'])
      assert.ok(!executor.calls.some(c => c.command === never), never)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
  })
})

/**
 * Story cr.31 D1 (docs/LIVE-PROOF-0.4.4-wave1b.md R2-D1, shipped since
 * ahrcache.1): `LVS_ARGS` carries the SEGMENT fields cache_mode/cache_policy, so
 * `lvs` lists a multi-segment LV once per segment, and destroy sent `lvremove`
 * per ROW — the second one failed "Failed to find logical volume" and the job
 * died after the unmount, the fstab edit and the first lvremove, with the VG and
 * arrays standing. The `lvs` replies here are the stunt-node captures
 * (fixtures/ahr/lvs-multiseg-*.json, lvs-cached-multiseg-origin.json) with the
 * throwaway VG name `cr31seg` renamed to this world's `t2`; `LVS_ARGS` prints no
 * device column, so the reply is the same whichever PVs the segments sit on (two
 * bands, or one band an expansion grew in place). `lvremove` answers as real LVM
 * does: the first call removes the LV, a second one fails.
 */
describe('destroyAhrPool — a multi-segment LV is removed once, in one job (cr.31 D1)', () => {
  let dir: string
  let fstabPath: string
  let confPath: string
  const progress: string[] = []
  const FIXTURES = join(import.meta.dirname, '../../fixtures/ahr')
  const capture = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8').replaceAll('cr31seg', 't2')
  const okRes = { stdout: '', stderr: '', exitCode: 0 }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-destroy-cr31-'))
    fstabPath = join(dir, 'fstab')
    confPath = join(dir, 'mdadm.conf')
    progress.length = 0
    await writeFile(fstabPath, FSTAB_SEED)
    await writeFile(confPath, CONF_SEED)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function world(lvsJson: string, cached: boolean): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
    addExamine(executor, T2_MEMBER_EXAMINE)
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: {
      stdout: JSON.stringify({ filesystems: [{ target: MOUNTPOINT, source: '/dev/mapper/t2-t2--vol', fstype: 'btrfs', options: 'rw' }] }),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson, stderr: '', exitCode: 0 } })
    const pvRows = [{ pv_name: '/dev/md127', vg_name: 't2', pv_size: String(2 * GIB), pv_free: '0' }]
    if (cached)
      pvRows.push({ pv_name: '/dev/sde1', vg_name: 't2', pv_size: String(GIB), pv_free: '0' })
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', [{ vg_name: 't2', pv_count: String(pvRows.length), lv_count: '1', vg_size: String(3 * GIB), vg_free: '0' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', pvRows), stderr: '', exitCode: 0 } })
    addDiskReads(
      executor,
      byIdListing([{ id: SMALL, kernel: 'sdc', parts: 1 }, { id: BIG, kernel: 'sdd', parts: 1 }, ...(cached ? [{ id: CACHE, kernel: 'sde', parts: 1 }] : [])]),
      lsblkTree([{ kernel: 'sdc', parts: ['t2-d1-b1'] }, { kernel: 'sdd', parts: ['t2-d2-b1'] }, ...(cached ? [{ kernel: 'sde', parts: ['t2-cache1'] }] : [])]),
    )
    // Real LVM: the LV is gone after the first lvremove; a second one fails.
    executor.addFixture({ command: '/usr/sbin/lvremove', results: [okRes, { stdout: '', stderr: '  Failed to find logical volume "t2/t2-vol"', exitCode: 5 }] })
    for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvconvert', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: okRes })
    return executor
  }

  const TEARDOWN_TAIL = [
    { command: '/usr/sbin/vgremove', args: ['-y', 't2'] },
    { command: '/usr/sbin/pvremove', args: ['-y', '/dev/md127'] },
  ]
  const MD_TAIL = [
    { command: '/usr/sbin/mdadm', args: ['--stop', '/dev/md127'] },
    { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${SMALL}-part1`] },
    { command: '/usr/sbin/mdadm', args: ['--zero-superblock', `/dev/disk/by-id/${BIG}-part1`] },
    { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${SMALL}`] },
    { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${BIG}`] },
  ]

  for (const [label, file, rows] of [
    ['an uncached two-band pool (2 segment rows)', 'lvs-multiseg-two-bands.json', 2],
    ['an expanded pool (3 segment rows)', 'lvs-multiseg-expanded.json', 3],
  ] as const) {
    it(`${label}: one lvremove, and the job runs to the end`, async () => {
      const lvsJson = capture(file)
      assert.equal(JSON.parse(lvsJson).report[0].lv.length, rows, 'the capture carries one row per segment')
      const executor = world(lvsJson, false)
      const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
      assert.deepEqual(result, { destroyed: 't2' })
      assert.deepEqual(acts(executor), [
        { command: '/usr/bin/umount', args: [MOUNTPOINT] },
        { command: '/usr/bin/systemctl', args: ['daemon-reload'] },
        { command: '/usr/sbin/lvremove', args: ['-y', 't2/t2-vol'] },
        ...TEARDOWN_TAIL,
        ...MD_TAIL,
        { command: '/usr/sbin/update-initramfs', args: ['-u'] },
      ])
      assert.equal(progress.filter(p => p === 'Removing logical volume t2/t2-vol').length, 1)
    })
  }

  it('a cached pool over a three-segment origin (one row): uncache, one lvremove, to the end', async () => {
    const executor = world(capture('lvs-cached-multiseg-origin.json'), true)
    const result = await destroyAhrPool(executor, cachedPool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(result, { destroyed: 't2' })
    const lvm = acts(executor).filter(c => ['/usr/sbin/lvconvert', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove'].includes(c.command))
    assert.deepEqual(lvm, [
      { command: '/usr/sbin/lvconvert', args: ['--config', 'devices/allow_mixed_block_sizes=1', '-y', '--uncache', 't2/t2-vol'] },
      { command: '/usr/sbin/lvremove', args: ['-y', 't2/t2-vol'] },
      ...TEARDOWN_TAIL,
      { command: '/usr/sbin/pvremove', args: ['-y', '/dev/sde1'] },
    ])
    assert.ok(executor.calls.some(c => c.command === '/usr/sbin/update-initramfs'), 'the job reached its last step')
  })
})
