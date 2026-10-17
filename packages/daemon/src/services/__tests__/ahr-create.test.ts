import type { MockFixture } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { AHR_ISCSI_DEVICE_TIMEOUT_OPTION, AHR_ISCSI_ORDERING_OPTION, changeAhrMountpoint, createAhrPool, ensureAhrTargetOrdering, remountAhrPool } from '../ahr-create.js'
import { LVM_MIXED_BLOCK_ARGS } from '../ahr-exec.js'
import { AHR_FINDMNT_ARGS } from '../ahr-topology.js'

/**
 * AHR create — exact command-sequence (argv) regression against the small
 * 2-disk AHR-1 pool, plus the 3-disk multi-band shape. The sgdisk geometry
 * triplets, the explicit --data-offset on every mdadm --create, the
 * pin-then-initramfs ordering, and the fstab round-trip are all locked here.
 */

const GIB = 1024 ** 3
const SMALL = 'ata-ANAS_SMALL_2G'
const BIG = 'ata-ANAS_BIG_3G'
const MID = 'ata-ANAS_MID_3G'
const UUID_R1 = 'aaaaaaaa:bbbbbbbb:cccccccc:dddddddd'
const UUID_R2 = '11111111:22222222:33333333:44444444'

const FSTAB_SEED = [
  '# static file system information',
  'UUID=abc / ext4 errors=remount-ro 0 1',
  '',
].join('\n')

function okOnly(executor: MockExecutor, commands: string[]): void {
  for (const command of commands)
    executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
}

describe('createAhrPool (Epic 11 + AHR)', () => {
  let dir: string
  let fstabPath: string
  let confPath: string
  let mountBase: string
  const progress: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-create-'))
    fstabPath = join(dir, 'fstab')
    confPath = join(dir, 'mdadm.conf')
    mountBase = join(dir, 'mnt')
    // cr.52s-f F6: the create makes the mountpoint THROUGH ITS OPENED PARENT and
    // never chains — the base exists up front, as /mnt/anas-ahr does on a node.
    await mkdir(mountBase)
    await writeFile(fstabPath, FSTAB_SEED)
    progress.length = 0
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * `priority` fixtures are registered FIRST so they win: the mock resolves a
   * command-only fixture by first registration, so a failure injected after the
   * blanket success list would simply never match.
   */
  function creationExecutor(priority: MockFixture[] = []): MockExecutor {
    const executor = new MockExecutor()
    for (const fixture of priority)
      executor.addFixture(fixture)
    // H6: the name-occupancy check reads /proc/mdstat, the partition labels and
    // LVM volume groups — a real node always answers these. Empty mdstat (no
    // live arrays), no labels, no VG of the new name.
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: 'Personalities : []\nunused devices: <none>\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/lsblk', args: ['-J', '-o', 'NAME,PARTLABEL'], result: { stdout: JSON.stringify({ blockdevices: [] }), stderr: '', exitCode: 0 } })
    okOnly(executor, [
      '/usr/sbin/wipefs',
      '/usr/sbin/sgdisk',
      '/usr/bin/udevadm',
      '/usr/sbin/pvcreate',
      '/usr/sbin/vgcreate',
      '/usr/sbin/lvcreate',
      '/usr/sbin/mkfs.btrfs',
      '/usr/bin/btrfs', // subvolume create @data / @snapshots (§12)
      '/usr/sbin/update-initramfs',
      '/usr/bin/systemctl',
      '/usr/bin/mount',
      '/usr/bin/umount', // top-level unmount after carving the subvolumes
      '/usr/bin/perl',
      '/usr/sbin/mdadm', // --create / fallback
      '/usr/sbin/vgs', // the occupancy check (empty report = no VG)
      '/usr/sbin/pvs', // the rollback teardown's gate (empty report)
      // The rollback teardown's LV read — a real `lvs` lists every LV on the
      // host and answers 0 even with no VGs, and since cr.31b an unreadable
      // one STOPS the destroy (fail closed) instead of reading as "no LVs".
      '/usr/sbin/lvs',
    ])
    return executor
  }

  it('2-disk AHR-1: the exact end-to-end argv sequence', async () => {
    const executor = creationExecutor()
    executor.addFixture({
      command: '/usr/sbin/mdadm',
      args: ['--detail', '--export', '/dev/md/t2-r1'],
      result: { stdout: `MD_NAME=t2-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 },
    })
    // Ghost-clearing pass: partitions resolve to kernel names with no md holders.
    executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${SMALL}-part1`], result: { stdout: '/dev/sdx1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${BIG}-part1`], result: { stdout: '/dev/sdy1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/ls', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await createAhrPool(
      executor,
      // Deliberately unsorted input — the service orders ascending by size.
      { name: 't2', tier: 'ahr1', disks: [{ id: BIG, usableBytes: 3 * GIB }, { id: SMALL, usableBytes: 2 * GIB }] },
      m => progress.push(m),
      { fstabPath, mdadmConfPath: confPath, mountBase },
    )

    assert.deepEqual(result, { created: 't2', mountpoint: join(mountBase, 't2'), arrays: ['t2-r1'] })
    // The two MOUNT calls additionally carry the inherited O_PATH fd (cr.52r D3)
    // — compare command+args here, and pin the fd's resolved path below.
    assert.deepEqual(executor.calls.map(c => ({ command: c.command, args: c.args })), [
      // Job-time name re-check (ident.3, H6): no live `t2-r<N>` array, no pin,
      // no `t2-*` partition label, no VG named `t2` — read before the first
      // destructive command.
      { command: '/usr/bin/cat', args: ['/proc/mdstat'] },
      { command: '/usr/bin/lsblk', args: ['-J', '-o', 'NAME,PARTLABEL'] },
      { command: '/usr/sbin/vgs', args: VGS_ARGS },
      // wipe + partition, ascending size order (§2.1); only the protected
      // band gets a slice (§2.6) — BIG's 2–3 GiB region stays raw.
      { command: '/usr/sbin/wipefs', args: ['-a', `/dev/disk/by-id/${SMALL}`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${SMALL}`] },
      // SMALL's slice reaches its end → clamps to last-usable (end token 0, GT-4).
      { command: '/usr/sbin/sgdisk', args: ['-n', '1:1M:0', '-t', '1:FD00', '-c', '1:t2-d1-b1', `/dev/disk/by-id/${SMALL}`] },
      { command: '/usr/sbin/wipefs', args: ['-a', `/dev/disk/by-id/${BIG}`] },
      { command: '/usr/sbin/sgdisk', args: ['--zap-all', `/dev/disk/by-id/${BIG}`] },
      // BIG's slice ends below its usable size → exact +size (2048M − 1M start).
      { command: '/usr/sbin/sgdisk', args: ['-n', '1:1M:+2047M', '-t', '1:FD00', '-c', '1:t2-d2-b1', `/dev/disk/by-id/${BIG}`] },
      { command: '/usr/bin/udevadm', args: ['settle', '--timeout=60'] },
      // Ghost-clearing (11.8 live-proof catch): old superblocks INSIDE the new
      // partitions can be resurrected by udev incremental assembly — resolve
      // each partition, check holders, wipe partition signatures, resettle.
      { command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/bin/ls', args: ['/sys/class/block/sdx1/holders'] },
      { command: '/usr/sbin/wipefs', args: ['-a', `/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/bin/ls', args: ['/sys/class/block/sdy1/holders'] },
      { command: '/usr/sbin/wipefs', args: ['-a', `/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/bin/udevadm', args: ['settle', '--timeout=60'] },
      // One array, explicit data offset (4 MiB = 8192 sectors for a <512 GiB member).
      { command: '/usr/sbin/mdadm', args: [
        '--create',
        '/dev/md/t2-r1',
        '--level=raid1',
        '--raid-devices=2',
        '--metadata=1.2',
        '--name=t2-r1',
        '--data-offset=8192s',
        '--bitmap=internal',
        '--run',
        `/dev/disk/by-id/${SMALL}-part1`,
        `/dev/disk/by-id/${BIG}-part1`,
      ] },
      // The array's identity, read at once from the device just created
      // (ident.3) — a rollback before the pin still knows which array is ours.
      { command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t2-r1'] },
      // The fresh array is wiped before ANYTHING ELSE reads it (issue #17):
      // stale LVM PV labels sit at the md data offset, INSIDE the members.
      { command: '/usr/sbin/wipefs', args: ['-a', '/dev/md/t2-r1'] },
      // Pin THEN initramfs (ARRAY_PIN_REQUIRES_INITRAMFS).
      { command: '/usr/sbin/update-initramfs', args: ['-u'] },
      // Every LVM call carries allow_mixed_block_sizes (issue #8): AHR bands
      // legitimately differ in logical block size on mixed media, and LVM
      // refuses that by default — after the disks are already wiped.
      { command: '/usr/sbin/pvcreate', args: [...LVM_MIXED_BLOCK_ARGS, '/dev/md/t2-r1'] },
      { command: '/usr/sbin/vgcreate', args: [...LVM_MIXED_BLOCK_ARGS, 't2', '/dev/md/t2-r1'] },
      { command: '/usr/sbin/lvcreate', args: [...LVM_MIXED_BLOCK_ARGS, '-y', '-l', '100%FREE', '-n', 't2-vol', 't2'] },
      // btrfs is always single-data/dup-metadata — never btrfs-RAID — and its
      // sector size is EXPLICIT, not inherited from the CPU page size (it is
      // what keeps a mixed-block-size LV mountable).
      { command: '/usr/sbin/mkfs.btrfs', args: ['-L', 't2', '-d', 'single', '-m', 'dup', '--sectorsize', '4096', '/dev/t2/t2-vol'] },
      // §12 subvolume layout: mount the top-level, carve @data + @snapshots,
      // unmount — then the pool mounts subvol=@data. cr.52r D3: both mounts go
      // through the daemon-OPENED directory (target /proc/self/fd/3, `-c`), with
      // the child inheriting the O_PATH fd.
      { command: '/usr/bin/mount', args: ['-c', '-t', 'btrfs', '-o', 'subvolid=5', '--', '/dev/t2/t2-vol', '/proc/self/fd/3/.'] },
      { command: '/usr/bin/btrfs', args: ['subvolume', 'create', join(mountBase, 't2', '@data')] },
      { command: '/usr/bin/btrfs', args: ['subvolume', 'create', join(mountBase, 't2', '@snapshots')] },
      { command: '/usr/bin/umount', args: ['--', join(mountBase, 't2')] },
      { command: '/usr/bin/systemctl', args: ['daemon-reload'] },
      // cr.52s-e: the ANAS-default LINE (asserted below) carries `nofail` and
      // the iSCSI ordering pair; the direct mount's `-o` carries only `subvol=@data`.
      { command: '/usr/bin/mount', args: ['-c', '-t', 'btrfs', '-o', 'subvol=@data', '--', '/dev/t2/t2-vol', '/proc/self/fd/3/.'] },
      executor.calls.at(-1)!, // perl notify — argv asserted below
    ])
    // cr.52r D3: the inherited fd of BOTH mounts resolves to the pool's
    // mountpoint directory (the kernel target /proc/self/fd/3 is that dir).
    for (const m of executor.calls.filter(c => c.command === '/usr/bin/mount'))
      assert.equal(m.fdPaths?.[0], join(mountBase, 't2'), 'mount fd resolves to the pool mountpoint')
    const notify = executor.calls.at(-1)!
    assert.equal(notify.command, '/usr/bin/perl')
    assert.equal(notify.args[2], 'info')
    assert.equal(notify.args[3], 'AHR pool created')

    // fstab round-trip: seed preserved byte-for-byte, one appended line, nofail.
    const fstab = await readFile(fstabPath, 'utf8')
    assert.ok(fstab.startsWith(FSTAB_SEED.trimEnd()))
    // fstab carries subvol=@data (§12) so the mountpoint mounts the data subvolume.
    // The line carries the LIO boot-ordering option from `iscsi.8`: an AHR
    // pool's `nofail` mount has no static anchor a drop-in can name, and losing
    // that race makes LIO create a 0-byte placeholder at an image LUN's path.
    // It also carries the O3 device-timeout so a pool that never assembles gives
    // up its `.device` job instead of holding the boot for the 90 s default.
    assert.ok(fstab.includes(`/dev/t2/t2-vol ${join(mountBase, 't2')} btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s 0 0`), fstab)

    // mdadm.conf gained the ARRAY pin + the monitor PROGRAM hook.
    const conf = await readFile(confPath, 'utf8')
    assert.ok(conf.includes('/dev/md/t2-r1'))
    assert.ok(conf.includes(UUID_R1))
    assert.ok(conf.includes('PROGRAM /usr/local/bin/anas-md-event'))

    // The mountpoint directory was created.
    assert.ok((await stat(join(mountBase, 't2'))).isDirectory())

    assert.ok(progress.length >= 8, `progress updates at each stage (got ${progress.length})`)
  })

  it('3-disk AHR-1 (2+3+4 GiB): multi-band geometry, per-band arrays, both pins', async () => {
    const executor = creationExecutor()
    executor.addFixture({
      command: '/usr/sbin/mdadm',
      args: ['--detail', '--export', '/dev/md/t3-r1'],
      result: { stdout: `MD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 },
    })
    executor.addFixture({
      command: '/usr/sbin/mdadm',
      args: ['--detail', '--export', '/dev/md/t3-r2'],
      result: { stdout: `MD_UUID=${UUID_R2}\n`, stderr: '', exitCode: 0 },
    })

    const result = await createAhrPool(
      executor,
      { name: 't3', tier: 'ahr1', disks: [
        { id: SMALL, usableBytes: 2 * GIB },
        { id: MID, usableBytes: 3 * GIB },
        { id: BIG, usableBytes: 4 * GIB },
      ] },
      m => progress.push(m),
      { fstabPath, mdadmConfPath: confPath, mountBase },
    )
    assert.deepEqual(result.arrays, ['t3-r1', 't3-r2'])

    const sgdisk = executor.calls.filter(c => c.command === '/usr/sbin/sgdisk' && c.args[0] === '-n')
    assert.deepEqual(sgdisk.map(c => c.args), [
      // d1 (2 GiB): band-1 slice clamps to its end.
      ['-n', '1:1M:0', '-t', '1:FD00', '-c', '1:t3-d1-b1', `/dev/disk/by-id/${SMALL}`],
      // d2 (3 GiB): band-1 exact, band-2 clamps (its topmost slice reaches its end).
      ['-n', '1:1M:+2047M', '-t', '1:FD00', '-c', '1:t3-d2-b1', '-n', '2:2048M:0', '-t', '2:FD00', '-c', '2:t3-d2-b2', `/dev/disk/by-id/${MID}`],
      // d3 (4 GiB): band-1 + band-2 exact; the 3–4 GiB wasted top band gets
      // NO partition (§2.6 — stays raw for future re-banding).
      ['-n', '1:1M:+2047M', '-t', '1:FD00', '-c', '1:t3-d3-b1', '-n', '2:2048M:+1024M', '-t', '2:FD00', '-c', '2:t3-d3-b2', `/dev/disk/by-id/${BIG}`],
    ])

    const creates = executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--create')
    assert.deepEqual(creates.map(c => c.args), [
      ['--create', '/dev/md/t3-r1', '--level=raid5', '--raid-devices=3', '--metadata=1.2', '--name=t3-r1', '--data-offset=8192s', '--bitmap=internal', '--run', `/dev/disk/by-id/${SMALL}-part1`, `/dev/disk/by-id/${MID}-part1`, `/dev/disk/by-id/${BIG}-part1`],
      ['--create', '/dev/md/t3-r2', '--level=raid1', '--raid-devices=2', '--metadata=1.2', '--name=t3-r2', '--data-offset=8192s', '--bitmap=internal', '--run', `/dev/disk/by-id/${MID}-part2`, `/dev/disk/by-id/${BIG}-part2`],
    ])
    // Every --create carries an explicit --data-offset (GT-5).
    assert.ok(creates.every(c => c.args.some(a => a.startsWith('--data-offset='))))

    const vgcreate = executor.calls.find(c => c.command === '/usr/sbin/vgcreate')!
    assert.deepEqual(vgcreate.args, [...LVM_MIXED_BLOCK_ARGS, 't3', '/dev/md/t3-r1', '/dev/md/t3-r2'])

    const conf = await readFile(confPath, 'utf8')
    assert.ok(conf.includes(UUID_R1))
    assert.ok(conf.includes(UUID_R2))
  })

  // Issue #8: the multi-band shape above is exactly the one that breaks when a
  // 4Kn disk is in the mix — band 1 becomes a 4096-block array and band 2 a
  // 512-block one, and vgcreate refuses AFTER the wipe and the mdadm --create.
  // The flag is not decoration on one call; every LVM verb must carry it.
  it('EVERY LVM call carries allow_mixed_block_sizes (issue #8)', async () => {
    const executor = creationExecutor()
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t3-r1'], result: { stdout: `MD_NAME=t3-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t3-r2'], result: { stdout: `MD_NAME=t3-r2\nMD_UUID=${UUID_R2}\n`, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', result: { stdout: '/dev/sdx1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/ls', result: { stdout: '', stderr: '', exitCode: 0 } })

    await createAhrPool(
      executor,
      {
        name: 't3',
        tier: 'ahr1',
        // A genuinely mixed selection: the 4 GiB disk reports 4Kn.
        disks: [
          { id: SMALL, usableBytes: 2 * GIB },
          { id: MID, usableBytes: 3 * GIB },
          { id: BIG, usableBytes: 4 * GIB, logicalSectorSize: 4096 },
        ],
      },
      m => progress.push(m),
      { fstabPath, mdadmConfPath: confPath, mountBase },
    )

    for (const command of ['/usr/sbin/pvcreate', '/usr/sbin/vgcreate', '/usr/sbin/lvcreate']) {
      const calls = executor.calls.filter(c => c.command === command)
      assert.ok(calls.length > 0, `${command} was never called`)
      for (const call of calls) {
        assert.deepEqual(
          call.args.slice(0, LVM_MIXED_BLOCK_ARGS.length),
          LVM_MIXED_BLOCK_ARGS,
          `${command} must lead with ${LVM_MIXED_BLOCK_ARGS.join(' ')}`,
        )
      }
    }

    // btrfs states its sector size rather than inheriting the CPU page size —
    // 4096 is what satisfies the 4Kn band's logical block size.
    const mkfs = executor.calls.find(c => c.command === '/usr/sbin/mkfs.btrfs')!
    assert.deepEqual(mkfs.args.slice(-3), ['--sectorsize', '4096', '/dev/t3/t3-vol'])
  })

  // Issue #17 (pve5, 2026-08-09): recreating a just-destroyed pool with the same
  // deterministic geometry died at `pvcreate` — "Can't initialize physical volume
  // "/dev/md126" of volume group "chiaahr2" without -ff". The dead pool's PV
  // label + VG metadata sit at the md DATA OFFSET, inside the member partitions,
  // which no partition- or disk-level wipe reaches and which destroy's `pvremove`
  // could not see (its arrays were dead, so LVM never listed those PVs at all).
  // Wiping each fresh md device closes the whole resurrection class.
  it('wipes every fresh md device BEFORE pvcreate (issue #17)', async () => {
    const executor = creationExecutor()
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t3-r1'], result: { stdout: `MD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t3-r2'], result: { stdout: `MD_UUID=${UUID_R2}\n`, stderr: '', exitCode: 0 } })

    await createAhrPool(
      executor,
      { name: 't3', tier: 'ahr1', disks: [
        { id: SMALL, usableBytes: 2 * GIB },
        { id: MID, usableBytes: 3 * GIB },
        { id: BIG, usableBytes: 4 * GIB },
      ] },
      m => progress.push(m),
      { fstabPath, mdadmConfPath: confPath, mountBase },
    )

    // Per band: created → wiped → handed to LVM, in that order.
    for (const mdDev of ['/dev/md/t3-r1', '/dev/md/t3-r2']) {
      const created = executor.calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--create' && c.args[1] === mdDev)
      const wiped = executor.calls.findIndex(c => c.command === '/usr/sbin/wipefs' && c.args.at(-1) === mdDev)
      const pvcreate = executor.calls.findIndex(c => c.command === '/usr/sbin/pvcreate' && c.args.at(-1) === mdDev)
      assert.ok(created >= 0, `${mdDev} was created`)
      assert.ok(wiped >= 0, `${mdDev} was wiped — a fresh array can hold only residue`)
      assert.ok(pvcreate >= 0, `${mdDev} became a PV`)
      assert.ok(created < wiped, `${mdDev}: the wipe follows the array creation`)
      assert.ok(wiped < pvcreate, `${mdDev}: the wipe precedes pvcreate — after it, LVM has already found the old VG`)
    }
    // Unconditional by design: nothing probes first (a device ANAS created one
    // command ago can hold nothing but stale residue), so there is no dry-run
    // inspection pass to make the wipe conditional on.
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/wipefs' && c.args.includes('-n')))
  })

  it('refuses when no protected band is possible', async () => {
    const executor = creationExecutor()
    await assert.rejects(
      createAhrPool(
        executor,
        { name: 'bad', tier: 'ahr2', disks: [{ id: SMALL, usableBytes: 2 * GIB }, { id: BIG, usableBytes: 3 * GIB }] },
        () => {},
        { fstabPath, mdadmConfPath: confPath, mountBase },
      ),
      /no protected band/,
    )
    assert.equal(executor.calls.length, 0) // nothing was touched
  })

  // --- Automatic rollback of a failed create (issue #11) --------------------
  // Create WIPES the selected disks as its first destructive act, so from that
  // instant the disks hold only what this attempt built — which is what makes
  // tearing it down automatically safe. Every failure below leaves the disks
  // blank and the create retryable.
  describe('rollback on failure', () => {
    const T3_DISKS = [
      { id: SMALL, usableBytes: 2 * GIB },
      { id: MID, usableBytes: 3 * GIB },
      { id: BIG, usableBytes: 4 * GIB },
    ]

    /**
     * The 3-disk/2-band world, with both band UUIDs readable for pinning.
     * `priority` fixtures are injected ahead of the blanket success list.
     */
    function t3Executor(priority: MockFixture[] = []): MockExecutor {
      const executor = creationExecutor(priority)
      executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t3-r1'], result: { stdout: `MD_NAME=t3-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t3-r2'], result: { stdout: `MD_NAME=t3-r2\nMD_UUID=${UUID_R2}\n`, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/realpath', result: { stdout: '/dev/sdx1\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/ls', result: { stdout: '', stderr: '', exitCode: 0 } })
      return executor
    }

    const create = (executor: MockExecutor) => createAhrPool(
      executor,
      { name: 't3', tier: 'ahr1', disks: T3_DISKS },
      m => progress.push(m),
      { fstabPath, mdadmConfPath: confPath, mountBase },
    )

    /**
     * Progress lines the ROLLBACK emitted. Keyed off the 'Rollback: ' prefix
     * rather than argv, because create's own wipe also runs `sgdisk --zap-all` —
     * counting raw calls cannot tell the two apart.
     */
    function rollbackSteps(): string[] {
      return progress.filter(m => m.startsWith('Rollback: ')).map(m => m.slice('Rollback: '.length))
    }

    // The real-world case: issue #8's vgcreate refusal, one minute in, with the
    // arrays already pinned and their initial sync already running.
    it('THE CASE: failure at the LVM step rolls back, and the SAME create then succeeds', async () => {
      const executor = t3Executor([{
        command: '/usr/sbin/vgcreate',
        result: { stdout: '', stderr: 'Devices have inconsistent logical block sizes (4096 and 512).', exitCode: 5 },
      }])

      await assert.rejects(create(executor), (err: Error) => {
        // The ORIGINAL diagnosis leads — the annotation only says what became
        // of the partial pool.
        assert.match(err.message, /^Devices have inconsistent logical block sizes/)
        assert.match(err.message, /partial pool was rolled back; disks are blank and create can be retried/)
        return true
      })

      // The system is clean: every disk zapped by the ROLLBACK (not just by the
      // create's own wipe), and no ANAS pins left behind.
      const steps = rollbackSteps()
      assert.deepEqual(
        steps.filter(m => m.startsWith('Zapping partition table on')),
        [`Zapping partition table on ${SMALL}`, `Zapping partition table on ${MID}`, `Zapping partition table on ${BIG}`],
      )
      assert.ok(steps.includes('Zeroing md superblocks'))
      assert.ok(steps.includes('Unpinning arrays from mdadm.conf'))
      const afterRollback = await readFile(confPath, 'utf8')
      assert.ok(!afterRollback.includes(UUID_R1), 'band 1 pin must be gone')
      assert.ok(!afterRollback.includes(UUID_R2), 'band 2 pin must be gone')
      // The pin removal must reach early boot too.
      assert.ok(steps.includes('Updating initramfs (mdadm.conf changed)'))
      // fstab is untouched — the failure came long before the mount stage.
      assert.equal(await readFile(fstabPath, 'utf8'), FSTAB_SEED)
      // The operator is told through PVE's own channel, not just job history.
      const notify = executor.calls.filter(c => c.command === '/usr/bin/perl')
      assert.equal(notify.at(-1)!.args[2], 'warning')
      assert.equal(notify.at(-1)!.args[3], 'AHR pool creation failed')

      // IDEMPOTENCY: the same call, same params, against the rolled-back system.
      progress.length = 0
      const result = await create(t3Executor())
      assert.deepEqual(result, { created: 't3', mountpoint: join(mountBase, 't3'), arrays: ['t3-r1', 't3-r2'] })
      assert.deepEqual(rollbackSteps(), [], 'the retry must not roll anything back')
      const afterRetry = await readFile(confPath, 'utf8')
      assert.ok(afterRetry.includes(UUID_R1) && afterRetry.includes(UUID_R2), 'the retry re-pins both bands')
    })

    it('failure MID-BAND-CREATION rolls back the bands already built', async () => {
      // Band 1 is created; band 2's mdadm --create fails.
      const executor = t3Executor([{
        command: '/usr/sbin/mdadm',
        args: [
          '--create',
          '/dev/md/t3-r2',
          '--level=raid1',
          '--raid-devices=2',
          '--metadata=1.2',
          '--name=t3-r2',
          '--data-offset=8192s',
          '--bitmap=internal',
          '--run',
          `/dev/disk/by-id/${MID}-part2`,
          `/dev/disk/by-id/${BIG}-part2`,
        ],
        result: { stdout: '', stderr: 'mdadm: cannot open /dev/disk/by-id/x: Device or resource busy', exitCode: 1 },
      }])

      await assert.rejects(create(executor), /Device or resource busy[\s\S]*rolled back/)

      const steps = rollbackSteps()
      // Nothing was pinned yet (pinArrays runs after ALL bands), so the unpin +
      // initramfs step must correctly NO-OP rather than fail.
      assert.equal(await readFile(confPath, 'utf8').catch(() => ''), '')
      assert.ok(!steps.includes('Unpinning arrays from mdadm.conf'))
      // The disks are still scrubbed — partitions and the one built band.
      assert.equal(steps.filter(m => m.startsWith('Zapping partition table on')).length, 3)
      assert.ok(steps.includes('Zeroing md superblocks'))
    })

    it('failure at mkfs rolls back the whole stack including LVM', async () => {
      const EMPTY_MDSTAT = 'Personalities : []\nunused devices: <none>\n'
      const LIVE_MDSTAT = 'Personalities : [raid1]\nmd127 : active raid1 sdx1[1] sdy1[0]\n      1047552 blocks super 1.2 [2/2] [UU]\n\nmd126 : active raid1 sdy2[1] sdz2[0]\n      1047552 blocks super 1.2 [2/2] [UU]\n\nunused devices: <none>\n'
      const executor = t3Executor([
        // mdstat answers EMPTY for the create's own name check (the arrays do
        // not exist yet) and LIVE for the rollback — the gate proves the VG's
        // PVs (/dev/md/t3-r1/r2) are the pool's arrays via the ident.3 read.
        { command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, results: [
          { stdout: EMPTY_MDSTAT, stderr: '', exitCode: 0 },
          { stdout: LIVE_MDSTAT, stderr: '', exitCode: 0 },
        ] },
        { command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: `MD_NAME=t3-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md126'], result: { stdout: `MD_NAME=t3-r2\nMD_UUID=${UUID_R2}\n`, stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/mkfs.btrfs', result: { stdout: '', stderr: 'mkfs.btrfs: unable to open /dev/t3/t3-vol', exitCode: 1 } },
        // The LVM layer now EXISTS, so destroy must find and remove it. vgs
        // answers EMPTY to the create's OWN name check (no VG yet) and the VG
        // to the rollback (the pool's own, built after the name check).
        { command: '/usr/sbin/vgs', results: [
          { stdout: JSON.stringify({ report: [{ vg: [] }] }), stderr: '', exitCode: 0 },
          { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 't3', vg_size: '5.00g', vg_free: '0 ' }] }] }), stderr: '', exitCode: 0 },
        ] },
        { command: '/usr/sbin/lvs', result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 't3-vol', vg_name: 't3', lv_size: '5.00g' }] }] }), stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/pvs', result: { stdout: JSON.stringify({ report: [{ pv: [{ pv_name: '/dev/md/t3-r1', vg_name: 't3' }, { pv_name: '/dev/md/t3-r2', vg_name: 't3' }] }] }), stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/lvremove', result: { stdout: '', stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/vgremove', result: { stdout: '', stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/pvremove', result: { stdout: '', stderr: '', exitCode: 0 } },
      ])

      await assert.rejects(create(executor), /unable to open[\s\S]*rolled back/)

      // Top-down teardown: LV, then VG, then both PVs.
      assert.ok(executor.calls.some(c => c.command === '/usr/sbin/lvremove' && c.args.includes('t3/t3-vol')))
      assert.ok(executor.calls.some(c => c.command === '/usr/sbin/vgremove' && c.args.includes('t3')))
      assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/pvremove').length, 2)
      // Pins existed by this stage, so they must be removed.
      assert.ok(rollbackSteps().includes('Unpinning arrays from mdadm.conf'))
      assert.ok(!(await readFile(confPath, 'utf8')).includes(UUID_R1))
    })

    it('failure during PARTITIONING still rolls back — including the half-done disk', async () => {
      // The first disk is zapped, then its partitioning fails.
      const executor = t3Executor([{
        command: '/usr/sbin/sgdisk',
        results: [
          { stdout: '', stderr: '', exitCode: 0 }, // --zap-all on disk 1
          { stdout: '', stderr: 'sgdisk: could not create partition', exitCode: 4 },
          { stdout: '', stderr: '', exitCode: 0 }, // everything after (the rollback's zaps)
        ],
      }])

      await assert.rejects(create(executor), /could not create partition[\s\S]*rolled back/)

      // The disk whose partitioning failed is recorded and zapped — a disk left
      // half-touched is exactly what must not survive.
      assert.ok(rollbackSteps().includes(`Zapping partition table on ${SMALL}`))
      // Only the disk reached so far is in the ledger; the untouched two are not.
      assert.equal(rollbackSteps().filter(m => m.startsWith('Zapping partition table on')).length, 1)
      // No arrays were ever made, so no --stop was attempted.
      assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
    })

    it('a failure BEFORE anything destructive is NOT annotated — there was nothing to undo', async () => {
      const executor = creationExecutor()
      await assert.rejects(
        createAhrPool(
          executor,
          { name: 'bad', tier: 'ahr2', disks: [{ id: SMALL, usableBytes: 2 * GIB }, { id: BIG, usableBytes: 3 * GIB }] },
          () => {},
          { fstabPath, mdadmConfPath: confPath, mountBase },
        ),
        (err: Error) => {
          assert.match(err.message, /no protected band/)
          assert.ok(!err.message.includes('rolled back'), 'no rollback claim when nothing was touched')
          return true
        },
      )
      assert.equal(executor.calls.length, 0)
    })

    it('when the ROLLBACK also fails, both errors surface — original first', async () => {
      const executor = t3Executor([
        { command: '/usr/sbin/vgcreate', result: { stdout: '', stderr: 'vgcreate exploded', exitCode: 5 } },
        // Create's own six sgdisk calls succeed; the rollback's first zap does not.
        { command: '/usr/sbin/sgdisk', results: [
          { stdout: '', stderr: '', exitCode: 0 },
          { stdout: '', stderr: '', exitCode: 0 },
          { stdout: '', stderr: '', exitCode: 0 },
          { stdout: '', stderr: '', exitCode: 0 },
          { stdout: '', stderr: '', exitCode: 0 },
          { stdout: '', stderr: '', exitCode: 0 },
          { stdout: '', stderr: 'sgdisk: device is busy', exitCode: 2 },
        ] },
      ])

      await assert.rejects(create(executor), (err: Error) => {
        // The original diagnosis is still the headline — it is what went wrong.
        assert.match(err.message, /^vgcreate exploded/)
        assert.match(err.message, /rollback ALSO FAILED: sgdisk: device is busy/)
        assert.match(err.message, /must be destroyed manually before retrying/)
        assert.ok(!err.message.includes('disks are blank'), 'must never claim blank disks it could not blank')
        return true
      })
      const notify = executor.calls.filter(c => c.command === '/usr/bin/perl')
      assert.equal(notify.at(-1)!.args[2], 'warning')
    })

    // Code review H6: the rollback reuses destroyAhrPool, and destroy must not
    // tear down a volume group whose PVs are not the pool's. The failure below
    // happens BEFORE vgcreate — the pool's OWN LVM stack was never built — and
    // a FOREIGN VG of the same name (appearing after the create's name check,
    // the race this gate exists for) must survive untouched.
    it('a failure BEFORE vgcreate with a pre-existing FOREIGN VG of the same name: no LVM teardown of it (H6)', async () => {
      const EMPTY_VGS = JSON.stringify({ report: [{ vg: [] }] })
      const FOREIGN_VGS = JSON.stringify({ report: [{ vg: [{ vg_name: 't3' }] }] })
      const FOREIGN_PVS = JSON.stringify({ report: [{ pv: [
        { pv_name: '/dev/sdz3', vg_name: 't3', vg_size: '1g' },
        { pv_name: '/dev/sdz4', vg_name: 't3', vg_size: '1g' },
      ] }] })
      const executor = t3Executor([
        // update-initramfs fails AFTER the wipe + arrays + pins, BEFORE vgcreate.
        { command: '/usr/sbin/update-initramfs', result: { stdout: '', stderr: 'update-initramfs: failure', exitCode: 1 } },
        // vgs answers EMPTY to the create's OWN name check (the VG appears
        // after it), then FOREIGN to the rollback.
        { command: '/usr/sbin/vgs', results: [
          { stdout: EMPTY_VGS, stderr: '', exitCode: 0 },
          { stdout: FOREIGN_VGS, stderr: '', exitCode: 0 },
        ] },
        { command: '/usr/sbin/pvs', result: { stdout: FOREIGN_PVS, stderr: '', exitCode: 0 } },
      ])

      await assert.rejects(create(executor), (err: Error) => {
        assert.match(err.message, /^update-initramfs: failure/)
        // The rollback REFUSED, naming the VG and the foreign PV — not silent.
        assert.match(err.message, /rollback ALSO FAILED: volume group 't3' contains physical volumes? \/dev\/sdz3, \/dev\/sdz4/)
        return true
      })
      // No LVM teardown ran — and no md stop either: destroy tears down LVM
      // BEFORE md, and the refused LVM layer aborts the whole teardown.
      for (const never of ['/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/lvconvert'])
        assert.ok(!executor.calls.some(c => c.command === never), `${never} must not touch the foreign VG`)
      assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--stop'))
    })
  })

  // cr.52s-f F6: the service-side half of the no-chain rule (the route gate is
  // the first door; this is the second — the same `createMountpointThrough-
  // OpenedParent` the remote create uses, through the opened parent fd).
  it('refuses a mountpoint whose PARENT is missing — never a mkdir chain (cr.52s-f F6)', async () => {
    const executor = creationExecutor()
    executor.addFixture({
      command: '/usr/sbin/mdadm',
      args: ['--detail', '--export', '/dev/md/t2-r1'],
      result: { stdout: `MD_NAME=t2-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 },
    })
    executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${SMALL}-part1`], result: { stdout: '/dev/sdx1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${BIG}-part1`], result: { stdout: '/dev/sdy1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/ls', result: { stdout: '', stderr: '', exitCode: 0 } })
    const missingBase = join(dir, 'no-base')
    await assert.rejects(
      createAhrPool(
        executor,
        { name: 't2', tier: 'ahr1', disks: [{ id: BIG, usableBytes: 3 * GIB }, { id: SMALL, usableBytes: 2 * GIB }] },
        m => progress.push(m),
        { fstabPath, mdadmConfPath: confPath, mountBase: missingBase },
      ),
      /parent '.*no-base' does not exist/,
    )
    // The refusal is the whole point: NO chain of directories was made (the
    // `mkdir(recursive)` this call replaced would have built `no-base` and the
    // leaf — through any symlink someone had planted at `no-base`).
    assert.equal(await stat(missingBase).then(() => true, () => false), false, 'no chain was created')
    assert.equal(executor.calls.some(c => c.command === '/usr/bin/mount'), false, 'nothing was ever mounted at the refused path')
  })

  it('an EXISTING leaf directory is success, not a re-create (cr.52s-f F6)', async () => {
    const executor = creationExecutor()
    executor.addFixture({
      command: '/usr/sbin/mdadm',
      args: ['--detail', '--export', '/dev/md/t2-r1'],
      result: { stdout: `MD_NAME=t2-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 },
    })
    executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${SMALL}-part1`], result: { stdout: '/dev/sdx1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${BIG}-part1`], result: { stdout: '/dev/sdy1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/ls', result: { stdout: '', stderr: '', exitCode: 0 } })
    await mkdir(join(mountBase, 't2')) // an empty leaf the operator (or an old attempt) left
    const result = await createAhrPool(
      executor,
      { name: 't2', tier: 'ahr1', disks: [{ id: BIG, usableBytes: 3 * GIB }, { id: SMALL, usableBytes: 2 * GIB }] },
      m => progress.push(m),
      { fstabPath, mdadmConfPath: confPath, mountBase },
    )
    assert.equal(result.mountpoint, join(mountBase, 't2'), 'the create proceeds at an existing directory leaf')
  })
})

/**
 * Story `iscsi.8` point 3: the boot-ordering option on an EXISTING pool's line,
 * added the moment an image LUN is placed on it and never before.
 *
 * The migration is deliberately not a sweep: a pool that will never hold a LUN
 * is left exactly as the operator (or an older ANAS) wrote it. ANAS is a guest
 * in /etc/fstab.
 */
describe('ensureAhrTargetOrdering - the surgical add for a pool that predates iscsi.8', () => {
  let dir: string
  let fstabPath: string
  let executor: MockExecutor

  const OLD_LINE = '/dev/lpahr/lpahr-vol /mnt/anas-ahr/lpahr btrfs nofail,subvol=@data 0 0'
  const SEED = [
    '# static file system information',
    'UUID=abc / ext4 errors=remount-ro 0 1',
    OLD_LINE,
    '/dev/other/other-vol /mnt/anas-ahr/other btrfs nofail,subvol=@data 0 0',
    '',
  ].join('\n')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-ordering-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, SEED)
    executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('adds the option to that pool line only, and reloads the generator', async () => {
    const changed = await ensureAhrTargetOrdering(executor, fstabPath, { name: 'lpahr', mountpoint: '/mnt/anas-ahr/lpahr' })
    assert.equal(changed, true)
    const after = await readFile(fstabPath, 'utf8')
    assert.ok(after.includes(`/mnt/anas-ahr/lpahr btrfs nofail,subvol=@data,${AHR_ISCSI_ORDERING_OPTION},${AHR_ISCSI_DEVICE_TIMEOUT_OPTION} 0 0`), after)
    // The OTHER AHR pool has no LUN, so its line is byte-identical.
    assert.ok(after.includes('/dev/other/other-vol /mnt/anas-ahr/other btrfs nofail,subvol=@data 0 0'), after)
    assert.ok(after.includes('UUID=abc / ext4 errors=remount-ro 0 1'), after)
    assert.ok(executor.calls.some(c => c.args.includes('daemon-reload')), 'the mount unit is regenerated')
  })

  // Live-proof O3: a pool whose device never appears held rtslib-fb-targetctl and
  // multi-user.target for the 90 s DefaultTimeoutStartSec. The `.device` job is
  // what waits, so the bound rides on the SAME line as the ordering edge — and it
  // is added surgically, next to `before=`, with the rest of the line untouched.
  it('carries the O3 device-timeout alongside the ordering edge, surgically', async () => {
    await ensureAhrTargetOrdering(executor, fstabPath, { name: 'lpahr', mountpoint: '/mnt/anas-ahr/lpahr' })
    const after = await readFile(fstabPath, 'utf8')
    const line = after.split('\n').find(l => l.includes('/mnt/anas-ahr/lpahr'))
    assert.ok(line, 'the pool line is present')
    assert.ok(line.includes(AHR_ISCSI_DEVICE_TIMEOUT_OPTION), `device-timeout is on the line: ${line}`)
    assert.equal(AHR_ISCSI_DEVICE_TIMEOUT_OPTION, 'x-systemd.device-timeout=45s')
    // Surgical: the pre-existing options and the LV spec/columns are preserved,
    // the two ANAS tokens are appended in create-time order, and nothing else on
    // the line moved.
    assert.equal(
      line,
      `${OLD_LINE.replace('nofail,subvol=@data', `nofail,subvol=@data,${AHR_ISCSI_ORDERING_OPTION},${AHR_ISCSI_DEVICE_TIMEOUT_OPTION}`)}`,
    )
  })

  it('is a byte-identical no-op on the second LUN', async () => {
    await ensureAhrTargetOrdering(executor, fstabPath, { name: 'lpahr', mountpoint: '/mnt/anas-ahr/lpahr' })
    const once = await readFile(fstabPath, 'utf8')
    const changed = await ensureAhrTargetOrdering(executor, fstabPath, { name: 'lpahr', mountpoint: '/mnt/anas-ahr/lpahr' })
    assert.equal(changed, false)
    assert.equal(await readFile(fstabPath, 'utf8'), once)
  })

  it('finds the line by LV spec when the pool is mounted somewhere else', async () => {
    const changed = await ensureAhrTargetOrdering(executor, fstabPath, { name: 'lpahr', mountpoint: '/somewhere/else' })
    assert.equal(changed, true)
    assert.ok((await readFile(fstabPath, 'utf8')).includes(AHR_ISCSI_ORDERING_OPTION))
  })

  it('a pool with no fstab line changes nothing and never throws', async () => {
    const changed = await ensureAhrTargetOrdering(executor, fstabPath, { name: 'ghost', mountpoint: '/mnt/anas-ahr/ghost' })
    assert.equal(changed, false)
    assert.equal(await readFile(fstabPath, 'utf8'), SEED)
  })

  it('an unreadable fstab is not fatal - adding a LUN must not fail over ordering', async () => {
    const changed = await ensureAhrTargetOrdering(executor, join(dir, 'no-such-file'), { name: 'lpahr', mountpoint: '/x' })
    assert.equal(changed, false)
  })
})

describe('changeAhrMountpoint — the move never chains a missing parent (cr.52s-f F6)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-move-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a new mountpoint whose parent is missing — no chain, and it never mounts at one', async () => {
    const moveFstab = join(dir, 'fstab')
    await writeFile(moveFstab, '/dev/tank/tank-vol /mnt/old-here btrfs nofail 0 0\n')
    const executor = new MockExecutor()
    for (const command of ['/usr/bin/umount', '/usr/bin/mount', '/usr/bin/systemctl'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
    await assert.rejects(
      changeAhrMountpoint(
        executor,
        { name: 'tank', mountpoint: '/mnt/old-here', mounted: true, subvolLayout: true },
        join(dir, 'no-parent', 'moved'),
        () => {},
        { fstabPath: moveFstab },
      ),
      /parent '.*no-parent' does not exist/,
    )
    // The old `mkdir(recursive)` built the whole chain (through a planted
    // symlink at `no-parent` as root); the opened-parent rule builds none of it.
    assert.equal(await stat(join(dir, 'no-parent')).then(() => true, () => false), false, 'no chain was created')
    assert.equal(executor.calls.some(c => c.command === '/usr/bin/mount'), false, 'the refused move never mounted at a path it could not make')
  })
})

describe('remountAhrPool — the result is VERIFIED, never assumed (cr.52s-f F7)', () => {
  // The umount/mount pair can SUCCEED and still land read-only (the fault is
  // still there); until now nothing in the suite pinned either half of that
  // check — the exact fault-attributed sentence, or the clean rw resolution.
  let dir: string
  let mp: string
  let fstabPath: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-remount-verify-'))
    // The remount mounts through the daemon-opened directory — a real dir.
    mp = join(dir, 'mnt')
    await mkdir(mp)
    // A file that READS and holds no line for the pool (an unreadable fstab
    // would refuse before the unmount — that half is pinned in ahr-own-line).
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, '# nothing for tank\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A verb that works (umount/mount exit 0) and a mount table answering with `options`. */
  function verifyExecutor(options: string): MockExecutor {
    const executor = new MockExecutor()
    for (const command of ['/usr/bin/umount', '/usr/bin/mount'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({
      command: '/usr/bin/findmnt',
      args: [...AHR_FINDMNT_ARGS],
      result: { stdout: JSON.stringify({ filesystems: [{ target: mp, source: '/dev/tank/tank-vol', fstype: 'btrfs', options }] }), stderr: '', exitCode: 0 },
    })
    return executor
  }

  it('the remount that lands read-only again fails with the exact STILL-read-only sentence', async () => {
    const executor = verifyExecutor('ro,relatime,space_cache=v2,subvol=/@data')
    await assert.rejects(
      remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, () => {}, { fstabPath }),
      (err: Error) => {
        assert.equal(
          err.message,
          'pool \'tank\' mounted again but is STILL read-only. btrfs re-applies the flag when the fault that caused it is still present — check the pool\'s read cache and its band arrays in the Hybrid RAID view, and `dmesg` for the BTRFS error that names the device',
          err.message,
        )
        return true
      },
    )
  })

  it('the remount that lands read-write resolves readOnly: false', async () => {
    const executor = verifyExecutor('rw,relatime,space_cache=v2,subvol=/@data')
    const result = await remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, () => {}, { fstabPath })
    assert.deepEqual(result, { mountpoint: mp, readOnly: false })
    // The pair it ran: the umount, then the direct mount of the pool's LV.
    assert.deepEqual(executor.calls.filter(c => c.command === '/usr/bin/umount' || c.command === '/usr/bin/mount').map(c => c.command), ['/usr/bin/umount', '/usr/bin/mount'])
  })
})
