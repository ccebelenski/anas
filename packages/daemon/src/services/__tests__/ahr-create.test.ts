import type { MockFixture } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { AHR_ISCSI_ORDERING_OPTION, createAhrPool, ensureAhrTargetOrdering } from '../ahr-create.js'
import { LVM_MIXED_BLOCK_ARGS } from '../ahr-exec.js'

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
    assert.deepEqual(executor.calls, [
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
      { command: '/usr/bin/udevadm', args: ['settle'] },
      // Ghost-clearing (11.8 live-proof catch): old superblocks INSIDE the new
      // partitions can be resurrected by udev incremental assembly — resolve
      // each partition, check holders, wipe partition signatures, resettle.
      { command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/bin/ls', args: ['/sys/class/block/sdx1/holders'] },
      { command: '/usr/sbin/wipefs', args: ['-a', `/dev/disk/by-id/${SMALL}-part1`] },
      { command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/bin/ls', args: ['/sys/class/block/sdy1/holders'] },
      { command: '/usr/sbin/wipefs', args: ['-a', `/dev/disk/by-id/${BIG}-part1`] },
      { command: '/usr/bin/udevadm', args: ['settle'] },
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
      // The fresh array is wiped before ANYTHING reads it (issue #17): stale
      // LVM PV labels sit at the md data offset, INSIDE the member partitions.
      { command: '/usr/sbin/wipefs', args: ['-a', '/dev/md/t2-r1'] },
      // Pin (UUID read) THEN initramfs (ARRAY_PIN_REQUIRES_INITRAMFS).
      { command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t2-r1'] },
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
      // unmount — then the pool mounts subvol=@data.
      { command: '/usr/bin/mount', args: ['-t', 'btrfs', '-o', 'subvolid=5', '/dev/t2/t2-vol', join(mountBase, 't2')] },
      { command: '/usr/bin/btrfs', args: ['subvolume', 'create', join(mountBase, 't2', '@data')] },
      { command: '/usr/bin/btrfs', args: ['subvolume', 'create', join(mountBase, 't2', '@snapshots')] },
      { command: '/usr/bin/umount', args: ['--', join(mountBase, 't2')] },
      { command: '/usr/bin/systemctl', args: ['daemon-reload'] },
      { command: '/usr/bin/mount', args: ['--', join(mountBase, 't2')] },
      executor.calls.at(-1)!, // perl notify — argv asserted below
    ])
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
    assert.ok(fstab.includes(`/dev/t2/t2-vol ${join(mountBase, 't2')} btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service 0 0`), fstab)

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
      const executor = t3Executor([
        { command: '/usr/sbin/mkfs.btrfs', result: { stdout: '', stderr: 'mkfs.btrfs: unable to open /dev/t3/t3-vol', exitCode: 1 } },
        // The LVM layer now EXISTS, so destroy must find and remove it.
        { command: '/usr/sbin/lvs', result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 't3-vol', vg_name: 't3', lv_size: '5.00g' }] }] }), stderr: '', exitCode: 0 } },
        { command: '/usr/sbin/vgs', result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 't3', vg_size: '5.00g', vg_free: '0 ' }] }] }), stderr: '', exitCode: 0 } },
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
    assert.ok(after.includes(`/mnt/anas-ahr/lpahr btrfs nofail,subvol=@data,${AHR_ISCSI_ORDERING_OPTION} 0 0`), after)
    // The OTHER AHR pool has no LUN, so its line is byte-identical.
    assert.ok(after.includes('/dev/other/other-vol /mnt/anas-ahr/other btrfs nofail,subvol=@data 0 0'), after)
    assert.ok(after.includes('UUID=abc / ext4 errors=remount-ro 0 1'), after)
    assert.ok(executor.calls.some(c => c.args.includes('daemon-reload')), 'the mount unit is regenerated')
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
