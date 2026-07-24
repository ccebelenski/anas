import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { createAhrPool } from '../ahr-create.js'

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

  function creationExecutor(): MockExecutor {
    const executor = new MockExecutor()
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
      // Pin (UUID read) THEN initramfs (ARRAY_PIN_REQUIRES_INITRAMFS).
      { command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/t2-r1'] },
      { command: '/usr/sbin/update-initramfs', args: ['-u'] },
      { command: '/usr/sbin/pvcreate', args: ['/dev/md/t2-r1'] },
      { command: '/usr/sbin/vgcreate', args: ['t2', '/dev/md/t2-r1'] },
      { command: '/usr/sbin/lvcreate', args: ['-y', '-l', '100%FREE', '-n', 't2-vol', 't2'] },
      // btrfs is always single-data/dup-metadata — never btrfs-RAID.
      { command: '/usr/sbin/mkfs.btrfs', args: ['-L', 't2', '-d', 'single', '-m', 'dup', '/dev/t2/t2-vol'] },
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
    assert.ok(fstab.includes(`/dev/t2/t2-vol ${join(mountBase, 't2')} btrfs nofail,subvol=@data 0 0`))

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
    assert.deepEqual(vgcreate.args, ['t3', '/dev/md/t3-r1', '/dev/md/t3-r2'])

    const conf = await readFile(confPath, 'utf8')
    assert.ok(conf.includes(UUID_R1))
    assert.ok(conf.includes(UUID_R2))
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
})
