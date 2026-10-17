import type { MockExecutor as MockExecutorType } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AhrPool } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { destroyAhrPool } from '../ahr-destroy.js'
import { AHR_LSBLK_ARGS } from '../ahr-topology.js'

/**
 * cr.64cr item 6, at the job that consumes the verdict: an AHR destroy's
 * partition-table rule over a slice `blkid -p` could not OPEN.
 *
 * blkid exits 2 both for "nothing found" and for "could not open the device"
 * (`blkid: error: <dev>: Permission denied`, the captured `fixtures/ahr/blkid-
 * p-permission-denied.stderr.txt`). cr.64c moved destroy onto the shared
 * classifiers and dropped its udev FSTYPE second witness, so an unreadable
 * slice carrying the pool's own label read `blank` → `blank-ours`, and the
 * disk's whole GPT was zapped over a partition nobody had read (review of
 * cr.64c, possible 1). The harness is the review's probe-destroy shape.
 */

const FIX = new URL('../../fixtures/', import.meta.url).pathname
const GIB = 1024 ** 3
const SMALL = 'ata-ANAS_SMALL_2G'
const BIG = 'ata-ANAS_BIG_3G'
const UUID_T2 = '11111111:22222222:33333333:44444444'
const MOUNTPOINT = '/mnt/test-ahr/t2'
const CONF = `ARRAY /dev/md/t2-r1 metadata=1.2 UUID=${UUID_T2}\n`
const MDSTAT_LIVE = 'Personalities : [raid1] \nmd127 : active raid1 sdd1[1] sdc1[0]\n      2086912 blocks super 1.2 [2/2] [UU]\n      \nunused devices: <none>\n'
const EXPORT_T2_R1 = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=${UUID_T2}\nMD_DEVNAME=t2-r1\nMD_NAME=t2-r1\n`
const UNREADABLE = `/dev/disk/by-id/${SMALL}-part2`
const DENIED = readFileSync(join(FIX, 'ahr/blkid-p-permission-denied.stderr.txt'), 'utf-8').replace('/dev/nvme0n1p1', UNREADABLE)

function pool(): AhrPool {
  return AhrPool.parse({
    name: 't2',
    ahrType: 'ahr1',
    mountpoint: MOUNTPOINT,
    mounted: true,
    disks: [
      { id: SMALL, sizeBytes: 2 * GIB, usableBytes: 2 * GIB, model: 'SMALL', serial: 'S1', role: 'member', partitions: [{ device: `/dev/disk/by-id/${SMALL}-part1`, band: 1, sizeBytes: 2 * GIB - 1024 ** 2 }] },
      { id: BIG, sizeBytes: 3 * GIB, usableBytes: 3 * GIB, model: 'BIG', serial: 'S2', role: 'member', partitions: [{ device: `/dev/disk/by-id/${BIG}-part1`, band: 1, sizeBytes: 2 * GIB - 1024 ** 2 }] },
    ],
    arrays: [{ device: '/dev/md/t2-r1', band: 1, level: 'raid1', heightBytes: 2 * GIB, members: [
      { disk: SMALL, partition: `/dev/disk/by-id/${SMALL}-part1`, memberState: 'in_sync' },
      { disk: BIG, partition: `/dev/disk/by-id/${BIG}-part1`, memberState: 'in_sync' },
    ], state: 'clean' }],
    vg: { name: 't2', sizeBytes: 2 * GIB, freeBytes: 0 },
    lv: { name: 't2-vol', sizeBytes: 2 * GIB },
    capacity: { rawBytes: 5 * GIB, usableBytes: 2 * GIB, usedBytes: 0, freeBytes: 2 * GIB, redundancyOverheadBytes: 2 * GIB, unprotectedWastedBytes: GIB, pendingBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
  })
}

const report = (kind: string, rows: object[]): string => JSON.stringify({ report: [{ [kind]: rows }] })
const BY_ID = `${[
  'total 0',
  `lrwxrwxrwx 1 root root 9 Aug  9 10:00 ${SMALL} -> ../../sdc`,
  `lrwxrwxrwx 1 root root 10 Aug  9 10:00 ${SMALL}-part1 -> ../../sdc1`,
  `lrwxrwxrwx 1 root root 10 Aug  9 10:00 ${SMALL}-part2 -> ../../sdc2`,
  `lrwxrwxrwx 1 root root 9 Aug  9 10:00 ${BIG} -> ../../sdd`,
  `lrwxrwxrwx 1 root root 10 Aug  9 10:00 ${BIG}-part1 -> ../../sdd1`,
].join('\n')}\n`
const LSBLK = JSON.stringify({
  blockdevices: [
    { name: 'sdc', size: 3 * GIB, type: 'disk', fstype: null, mountpoint: null, partlabel: null, children: [
      { name: 'sdc1', size: GIB, type: 'part', fstype: 'linux_raid_member', mountpoint: null, partlabel: 't2-d1-b1' },
      // A slice carrying the POOL's own label whose content no probe could read.
      { name: 'sdc2', size: GIB, type: 'part', fstype: null, mountpoint: null, partlabel: 't2-d1-b2' },
    ] },
    { name: 'sdd', size: 3 * GIB, type: 'disk', fstype: null, mountpoint: null, partlabel: null, children: [
      { name: 'sdd1', size: GIB, type: 'part', fstype: 'linux_raid_member', mountpoint: null, partlabel: 't2-d2-b1' },
    ] },
  ],
})

function executor(): MockExecutorType {
  const e = new MockExecutor()
  e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_LIVE, stderr: '', exitCode: 0 } })
  e.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_T2_R1, stderr: '', exitCode: 0 } })
  e.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
  for (const k of ['lv', 'vg', 'pv'])
    e.addFixture({ command: `/usr/sbin/${k}s`, result: { stdout: report(k, []), stderr: '', exitCode: 0 } })
  e.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID, stderr: '', exitCode: 0 } })
  e.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: { stdout: LSBLK, stderr: '', exitCode: 0 } })
  for (const disk of [SMALL, BIG]) {
    e.addFixture({ command: '/usr/sbin/mdadm', args: ['--examine', '--export', `/dev/disk/by-id/${disk}-part1`], result: { stdout: `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_NAME=t2-r1\nMD_UUID=${UUID_T2}\n`, stderr: '', exitCode: 0 } })
  }
  e.addFixture({ command: '/usr/sbin/mdadm', args: ['--examine', '--export', UNREADABLE], result: { stdout: '', stderr: `mdadm: cannot open ${UNREADABLE}: Permission denied`, exitCode: 1 } })
  e.addFixture({ command: '/usr/sbin/blkid', args: ['-p', UNREADABLE], result: { stdout: '', stderr: DENIED, exitCode: 2 } })
  e.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
  for (const c of ['/usr/sbin/sgdisk', '/usr/sbin/update-initramfs'])
    e.addFixture({ command: c, result: { stdout: '', stderr: '', exitCode: 0 } })
  return e
}

describe('cr.64cr — destroy keeps the GPT of a disk with a slice blkid could not open', () => {
  let dir: string
  let fstab: string
  let conf: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cr64cr-d-'))
    fstab = join(dir, 'fstab')
    conf = join(dir, 'mdadm.conf')
    await writeFile(fstab, '# empty\n')
    await writeFile(conf, CONF)
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('the pool-labelled slice whose blkid -p answered exit 2 + Permission denied is not judged blank: that disk keeps its table, the other is zapped', async () => {
    const e = executor()
    const progress: string[] = []
    await destroyAhrPool(e, pool(), m => progress.push(m), { fstabPath: fstab, mdadmConfPath: conf })
    const zaps = e.calls.filter(c => c.command === '/usr/sbin/sgdisk').map(c => c.args.join(' '))
    assert.deepEqual(zaps, [`--zap-all /dev/disk/by-id/${BIG}`], zaps.join('\n'))
    assert.ok(progress.includes(`Leaving the partition table on ${SMALL} — it carries partitions that are not this pool's (${UNREADABLE}); only the pool's own slices were cleared`), progress.join('\n'))
  })
})
