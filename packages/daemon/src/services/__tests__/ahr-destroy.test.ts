import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AhrPool } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { destroyAhrPool } from '../ahr-destroy.js'

/**
 * AHR destroy — full-teardown command sequence and the half-destroyed
 * idempotent re-run (every step checks-then-acts).
 */

const GIB = 1024 ** 3
const SMALL = 'ata-ANAS_SMALL_2G'
const BIG = 'ata-ANAS_BIG_3G'
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
    advisories: [],
  })
}

function report(kind: 'lv' | 'vg' | 'pv', rows: object[]): string {
  return JSON.stringify({ report: [{ [kind]: rows }] })
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
    for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await destroyAhrPool(executor, pool(), m => progress.push(m), { fstabPath, mdadmConfPath: confPath })
    assert.deepEqual(result, { destroyed: 't2' })

    // The mutation sequence, top-down (reads interleave; assert the acts).
    const acts = executor.calls.filter(c =>
      !(c.command === '/usr/bin/cat' || c.command === '/usr/bin/findmnt'
        || c.command === '/usr/sbin/lvs' || c.command === '/usr/sbin/vgs' || c.command === '/usr/sbin/pvs'
        || (c.command === '/usr/sbin/mdadm' && c.args[0] === '--detail')),
    )
    assert.deepEqual(acts, [
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
})
