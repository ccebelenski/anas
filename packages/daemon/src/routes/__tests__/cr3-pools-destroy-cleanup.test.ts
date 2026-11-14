import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { wholeDiskKernel } from '../../parsers/disk-by-id.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { poolRoutes } from '../pools.js'
import { capturedRootMountTable } from './pool-guard-reads.js'

/**
 * cr3.pools-disks — destroy with cleanup.
 *
 * POOLS-DISKS-H2 (the review probe): the GPT-zap guard called a disk
 * "exclusive" when its OTHER partition showed no FSTYPE in lsblk's udev-cached
 * answer (lsblk is not asked for PTTYPE; a raw open by qemu or LIO leaves no
 * child), then zapped the whole table. Each foreign partition is now read by
 * the classifier the AHR destroy uses (`blkid -p`, through
 * `classifyPartitionWithReason`): only a blank one lets the zap through.
 *
 * POOLS-DISKS-L10: the cleanup's `disk:` lock keys are the inventory's ids.
 */

const ZPOOL = '/usr/sbin/zpool'
const BY_ID = '/dev/disk/by-id/'
const POOL_GUID = '9183729100142233021'
const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }
const POOL = 'tank'
type HeldLock = ReturnType<JobQueue['heldLocks']>[number]

/** The captured blank-partition shape (zfs/blkid-p-blank-partition.txt): exit 0, PART_ENTRY_* only. */
const BLKID_BLANK: ExecResult = {
  stdout: '/dev/sdx2: PART_ENTRY_SCHEME="gpt" PART_ENTRY_UUID="f29fe9ef-413f-4fac-859c-635a4eb73548" PART_ENTRY_TYPE="0fc63daf-8483-4772-8e79-3d69d8477de4" PART_ENTRY_NUMBER="2" PART_ENTRY_OFFSET="1640448" PART_ENTRY_SIZE="819200" PART_ENTRY_DISK="8:48"\n',
  stderr: '',
  exitCode: 0,
}
/** A partition a VM partitioned itself: a nested table, no filesystem (PTTYPE, which lsblk was never asked for). */
const BLKID_NESTED_TABLE: ExecResult = {
  stdout: '/dev/sdx2: PTUUID="1a2b3c4d" PTTYPE="dos" PART_ENTRY_SCHEME="gpt" PART_ENTRY_UUID="f29fe9ef-413f-4fac-859c-635a4eb73548" PART_ENTRY_TYPE="0fc63daf-8483-4772-8e79-3d69d8477de4" PART_ENTRY_NUMBER="2" PART_ENTRY_OFFSET="1640448" PART_ENTRY_SIZE="819200" PART_ENTRY_DISK="8:48"\n',
  stderr: '',
  exitCode: 0,
}
/** blkid that could not read the device (util-linux 2.41's silent exit 2). */
const BLKID_UNREADABLE: ExecResult = { stdout: '', stderr: '', exitCode: 2 }

interface World {
  /** How the destroyed pool names its one leaf (ZFS's own by-id choice). */
  leafById: string
  /** The by-id listing lines (`<name> -> ../../<kernel>`). */
  listing: string[]
  /** `blkid -p` of the disk's OTHER partition (`/dev/<otherPart>`). */
  sdx2: ExecResult
  /** The other partition's kernel name (default `sdx2`). */
  otherPart?: string
}

async function destroyWithCleanup(w: World): Promise<{ job: Job, sgdisk: string[], locksAtDestroy: HeldLock[] }> {
  const status = JSON.stringify({ pools: { [POOL]: { name: POOL, state: 'ONLINE', pool_guid: '1', vdevs: { [POOL]: { name: POOL, vdev_type: 'root', state: 'ONLINE', vdevs: {
    [`${w.leafById}-part1`]: { name: `${w.leafById}-part1`, vdev_type: 'disk', state: 'ONLINE', path: `${BY_ID}${w.leafById}-part1` },
  } } } } } })
  const ex = new MockExecutor()
  ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: JSON.stringify({ pools: { [POOL]: { name: POOL, state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: status, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['destroy', '--', POOL], result: OK })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', BY_ID], result: { stdout: `${w.listing.map(l => `lrwxrwxrwx 1 root root 9 Jul 25 10:00 ${l}`).join('\n')}\n`, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', POOL], result: { stdout: `${POOL_GUID}\n`, stderr: '', exitCode: 0 } })
  const other = w.otherPart ?? 'sdx2'
  ex.addFixture({ command: '/usr/sbin/blkid', args: ['-p', `/dev/${other}`], result: w.sdx2 })
  // The leaf's label-guid check (the job matches the leaf to the pool first).
  ex.addFixture({ command: '/usr/sbin/blkid', result: { stdout: `${POOL_GUID}\n`, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: capturedRootMountTable(), stderr: '', exitCode: 0 } })
  // part2 shows no FSTYPE, no MOUNTPOINT and no children to lsblk.
  ex.addFixture({ command: '/usr/bin/lsblk', args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}${w.leafById}`], result: {
    stdout: JSON.stringify({ blockdevices: [{ name: 'sdx', type: 'disk', fstype: null, mountpoint: null, children: [
      { name: 'sdx1', type: 'part', fstype: null, mountpoint: null },
      { name: other, type: 'part', fstype: null, mountpoint: null },
    ] }] }),
    stderr: '',
    exitCode: 0,
  } })
  ex.addFixture({ command: ZPOOL, result: OK })
  ex.addFixture({ command: '/usr/sbin/wipefs', result: OK })
  ex.addFixture({ command: '/usr/sbin/sgdisk', result: OK })

  const jobQueue = new JobQueue()
  let locksAtDestroy: HeldLock[] = []
  const orig = ex.exec.bind(ex)
  ex.exec = async (command: string, args: string[]) => {
    if (command === ZPOOL && args[0] === 'destroy')
      locksAtDestroy = jobQueue.heldLocks()
    return orig(command, args)
  }

  const server = Fastify({ logger: false })
  await server.register(poolRoutes, { prefix: '/v1', executor: ex, jobQueue, confirmStore: new ConfirmStore() })
  const H = { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': randomUUID() }
  const first = await server.inject({ method: 'DELETE', url: `/v1/pools/${POOL}?cleanup=true`, headers: H })
  assert.equal(first.statusCode, 409, first.body)
  const res = await server.inject({ method: 'DELETE', url: `/v1/pools/${POOL}?cleanup=true`, headers: { ...H, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
  assert.equal(res.statusCode, 202, res.body)
  const id = (res.json() as { job: { id: string } }).job.id
  let job: Job | undefined
  for (let i = 0; i < 400; i++) {
    job = jobQueue.get(id)
    if (job?.status === 'completed' || job?.status === 'failed')
      break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await server.close()
  assert.ok(job)
  return { job, sgdisk: ex.calls.filter(c => c.command === '/usr/sbin/sgdisk').map(c => c.args.join(' ')), locksAtDestroy }
}

const ATA_LISTING = ['ata-SHARED -> ../../sdx', 'ata-SHARED-part1 -> ../../sdx1', 'ata-SHARED-part2 -> ../../sdx2']

describe('cr3 — destroy cleanup never zaps a disk another tenant uses (POOLS-DISKS-H2)', () => {
  it('a neighbouring partition holding a nested partition table keeps the disk\'s table (the review probe)', async () => {
    const { job, sgdisk } = await destroyWithCleanup({ leafById: 'ata-SHARED', listing: ATA_LISTING, sdx2: BLKID_NESTED_TABLE })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(sgdisk, [], 'no --zap-all')
    const result = job.result as { wiped?: string[], zapped?: string[], preserved?: { disk: string, reason: string }[] }
    assert.deepEqual(result.wiped, ['ata-SHARED-part1'], 'our own leaf is still wiped')
    assert.equal(result.zapped, undefined)
    assert.deepEqual(result.preserved, [{ disk: 'ata-SHARED', reason: 'shared' }])
  })

  it('a neighbouring partition blkid could not read keeps the table too — reported uncertain, with the classifier\'s sentence (re-review 5)', async () => {
    const { sgdisk, job } = await destroyWithCleanup({ leafById: 'ata-SHARED', listing: ATA_LISTING, sdx2: BLKID_UNREADABLE })
    assert.deepEqual(sgdisk, [])
    const preserved = (job.result as { preserved?: { disk: string, reason: string, detail?: string }[] }).preserved
    assert.equal(preserved?.length, 1)
    assert.equal(preserved![0].disk, 'ata-SHARED')
    assert.equal(preserved![0].reason, 'uncertain')
    assert.match(preserved![0].detail ?? '', /\/dev\/sdx2 answered blkid -p with nothing at all/)
  })

  it('control: a neighbouring partition blkid reads BLANK (the captured shape) lets the zap through', async () => {
    const { sgdisk, job } = await destroyWithCleanup({ leafById: 'ata-SHARED', listing: ATA_LISTING, sdx2: BLKID_BLANK })
    assert.deepEqual(sgdisk, ['--zap-all /dev/disk/by-id/ata-SHARED'])
    assert.deepEqual((job.result as { zapped?: string[] }).zapped, ['ata-SHARED'])
  })
})

describe('cr3 — ZFS\'s own reserved partition 9 never blocks the zap (node capture 2026-11-14)', () => {
  // The coordinator's capture on the ext4-root test node (ZFS 2.4.x,
  // util-linux 2.41): `blkid -p` on a whole-disk leaf's part9 exits 0 with
  // ONLY PART_ENTRY_* keys, type 6a945a3b-... (Solaris reserved), size 16384;
  // lsblk shows it fstype null. The UUID/offset/disk values are this test's.
  const PART9: ExecResult = {
    stdout: '/dev/sdx9: PART_ENTRY_SCHEME="gpt" PART_ENTRY_UUID="0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9" PART_ENTRY_TYPE="6a945a3b-1dd2-11b2-99a6-080020736631" PART_ENTRY_NUMBER="9" PART_ENTRY_OFFSET="7814019072" PART_ENTRY_SIZE="16384" PART_ENTRY_DISK="8:16"\n',
    stderr: '',
    exitCode: 0,
  }

  it('a disk holding the pool\'s part1 leaf and a blank part9 is exclusive — its table is zapped', async () => {
    const listing = ['ata-SHARED -> ../../sdx', 'ata-SHARED-part1 -> ../../sdx1', 'ata-SHARED-part9 -> ../../sdx9']
    const { sgdisk, job } = await destroyWithCleanup({ leafById: 'ata-SHARED', listing, sdx2: PART9, otherPart: 'sdx9' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(sgdisk, ['--zap-all /dev/disk/by-id/ata-SHARED'])
  })
})

describe('cr3 — the cleanup\'s disk keys are the inventory\'s ids (POOLS-DISKS-L10)', () => {
  it('a pool ZFS built on wwn- names locks the disk by the ata- id the inventory and the AHR verbs use', async () => {
    const listing = [
      'ata-DISK_X -> ../../sdx',
      'wwn-0x5000c500a1b2c3d4 -> ../../sdx',
      'ata-DISK_X-part1 -> ../../sdx1',
      'wwn-0x5000c500a1b2c3d4-part1 -> ../../sdx1',
      'ata-DISK_X-part2 -> ../../sdx2',
    ]
    const { locksAtDestroy, job } = await destroyWithCleanup({ leafById: 'wwn-0x5000c500a1b2c3d4', listing, sdx2: BLKID_BLANK })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const diskKeys = locksAtDestroy.filter(l => l.key.startsWith('disk:')).map(l => l.key)
    assert.deepEqual(diskKeys, ['disk:ata-DISK_X'])
  })
})

describe('cr3 — a numbered whole device is its own whole disk (POOLS-DISKS-L13)', () => {
  it('md127, loop0, nbd0, zd16 and dm-0 are whole devices; their p<N> partitions reduce to them', () => {
    for (const whole of ['md127', 'loop0', 'nbd0', 'zd16', 'dm-0', 'sr0'])
      assert.equal(wholeDiskKernel(whole), whole)
    assert.equal(wholeDiskKernel('md127p1'), 'md127')
    assert.equal(wholeDiskKernel('loop0p2'), 'loop0')
    assert.equal(wholeDiskKernel('zd16p1'), 'zd16')
  })

  it('control: the letter-named disks and the nvme / mmc forms are unchanged', () => {
    assert.equal(wholeDiskKernel('sdb1'), 'sdb')
    assert.equal(wholeDiskKernel('sdaa12'), 'sdaa')
    assert.equal(wholeDiskKernel('vda2'), 'vda')
    assert.equal(wholeDiskKernel('xvda1'), 'xvda')
    assert.equal(wholeDiskKernel('nvme0n1p3'), 'nvme0n1')
    assert.equal(wholeDiskKernel('mmcblk0p1'), 'mmcblk0')
    assert.equal(wholeDiskKernel('sdb'), 'sdb')
  })
})
