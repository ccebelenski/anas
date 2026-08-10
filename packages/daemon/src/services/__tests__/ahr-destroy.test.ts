import type { AhrDestroyTarget } from '../ahr-destroy.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const UUID_T2 = '11111111:22222222:33333333:44444444'
const UUID_FOREIGN = '99999999:99999999:99999999:99999999'
const MOUNTPOINT = '/mnt/test-ahr/t2'

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

/** An `lsblk AHR_LSBLK_ARGS` tree of plain partitioned disks (no md/LVM nodes). */
function lsblkTree(disks: { kernel: string, parts: (string | null)[] }[]): string {
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
        fstype: partlabel === null ? 'ext4' : 'linux_raid_member',
        mountpoint: null,
        partlabel,
      })),
    })),
  })
}

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
  executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: report('lv', []), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: report('vg', []), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: report('pv', []), stderr: '', exitCode: 0 } })
  return executor
}

/** Every command that only READS — the acts are what remains. */
function acts(executor: MockExecutor): { command: string, args: string[] }[] {
  return executor.calls.filter(c =>
    !(c.command === '/usr/bin/cat' || c.command === '/usr/bin/findmnt' || c.command === '/usr/bin/lsblk'
      || c.command === '/usr/bin/ls' || c.command === '/usr/sbin/lvs' || c.command === '/usr/sbin/vgs'
      || c.command === '/usr/sbin/pvs' || (c.command === '/usr/sbin/mdadm' && c.args[0] === '--detail')),
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
    // every partition on them labeled for this pool.
    addDiskReads(executor, T2_BY_ID, T2_LSBLK)
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

    // mdadm.conf: our ARRAY unpinned; foreign ARRAY, PROGRAM, comment survive.
    const conf = await readFile(confPath, 'utf8')
    assert.ok(!conf.includes(UUID_T2))
    assert.ok(conf.includes(UUID_FOREIGN))
    assert.ok(conf.includes('PROGRAM /usr/local/bin/anas-md-event'))
    assert.ok(conf.includes('hand comment survives'))
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
    // zero-superblock now fails (nothing there) — tolerated by design.
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: 'Unrecognised md component device', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(result, { destroyed: 't2' })

    const commands = executor.calls.map(c => c.command)
    for (const never of ['/usr/bin/umount', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/bin/systemctl', '/usr/sbin/update-initramfs'])
      assert.ok(!commands.includes(never), `${never} must not run on a half-destroyed pool`)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
    // The always-safe scrubbing still happens.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--zero-superblock').length, 2)
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
