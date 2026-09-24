import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks, resolveLeafKernel } from '../disks.js'

/**
 * vdevs.1 consumer audit (GitHub #66), consumer (b): the Disks inventory joins
 * each physical disk to its ZFS context (pool / vdev / role / state / error
 * counts). While the status parser dropped the pool-level sections, a disk
 * whose only membership was a log, special or dedup vdev carried NO context at
 * all — a faulted special member showed no errors and raised no disk warning.
 *
 * The fixture is the stunt-node capture the live proof rebuilds: ONE disk
 * carrying six partitions, one per vdev class. That is also the case the join
 * has to decide — the disk row carries one context, and it must be the one that
 * most deserves it (the fault first, class gravity only as a tie-break).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures/zfs')

const ALL_CLASSES = readFileSync(join(FIXTURES, 'zpool-status-all-vdev-classes-2.4.4.json'), 'utf-8')

/**
 * The by-id listing for that disk, in the shape of the stunt node's own (the
 * capture's leaves are bare kernel names — the pool was built on /dev/sdbN — so
 * the join has to go through the kernel path, not this map).
 */
const BY_ID_LISTING = [
  'lrwxrwxrwx 1 root root 9 Sep 24 06:20 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9 -> ../../sdb',
  ...[1, 2, 3, 4, 5, 6].map(n =>
    `lrwxrwxrwx 1 root root 10 Sep 24 06:20 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9-part${n} -> ../../sdb${n}`),
  '',
].join('\n')

const LSBLK_JSON = JSON.stringify({
  blockdevices: [{
    'name': 'sdb',
    'type': 'disk',
    'size': 2147483648,
    'model': 'QEMU HARDDISK',
    'serial': 'ANAS_HOT9',
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'children': [1, 2, 3, 4, 5, 6].map(n => ({
      name: `sdb${n}`,
      type: 'part',
      size: 209715200,
      fstype: 'zfs_member',
      mountpoint: null,
    })),
  }],
})

/** Rewrite one leaf of the captured status so a class can be made unhealthy. */
function statusWith(edit: (pool: Record<string, any>) => void): string {
  const parsed = JSON.parse(ALL_CLASSES)
  edit(parsed.pools.gt66)
  return JSON.stringify(parsed)
}

async function collect(statusJson: string): Promise<Map<string, Disk>> {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: LSBLK_JSON, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID_LISTING, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-partuuid/'], result: { stdout: '', stderr: '', exitCode: 1 } })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: statusJson, stderr: '', exitCode: 0 } })
  const disks = await collectDisks(mock, new DiskIdentityCache(mock))
  return new Map(disks.map(d => [d.name, d]))
}

describe('Disks inventory — a partition-backed vdev class carries its context (vdevs.1)', () => {
  it('the disk holding the SPECIAL leaf carries pool, vdev, role and error counts', async () => {
    const sdb = (await collect(ALL_CLASSES)).get('sdb')!
    assert.equal(sdb.poolName, 'gt66')
    assert.equal(sdb.status, 'pool_member')
    assert.equal(sdb.vdevRole, 'special')
    assert.equal(sdb.vdevName, 'special')
    assert.deepEqual(sdb.zfsErrors, { read: 0, write: 0, checksum: 0 })
    assert.equal(sdb.healthStatus, 'healthy')
  })

  it('a FAULTED special member wins the row over its healthy siblings — with its errors', async () => {
    const status = statusWith((pool) => {
      pool.special.sdb5.state = 'FAULTED'
      pool.special.sdb5.read_errors = 3
      pool.special.sdb5.checksum_errors = 11
    })
    const sdb = (await collect(status)).get('sdb')!
    assert.equal(sdb.vdevRole, 'special')
    assert.deepEqual(sdb.zfsErrors, { read: 3, write: 0, checksum: 11 })
    // A disk row carries the vdev STATE only fused into healthStatus (the Disk
    // schema has no vdevState field) — this is the warning the inventory never
    // used to raise for a special member.
    assert.equal(sdb.healthStatus, 'critical')
  })

  it('an OFFLINE log member wins over every ONLINE class on the same disk', async () => {
    const status = statusWith((pool) => {
      pool.logs.sdb2.state = 'OFFLINE'
    })
    const sdb = (await collect(status)).get('sdb')!
    assert.equal(sdb.vdevRole, 'log')
    assert.equal(sdb.vdevName, 'logs')
    assert.equal(sdb.healthStatus, 'warning')
  })

  it('the DEDUP class alone still carries the row when it is the only membership', async () => {
    const status = statusWith((pool) => {
      delete pool.special
      delete pool.logs
      delete pool.l2cache
      delete pool.spares
      pool.vdevs.gt66.vdevs = {}
    })
    const sdb = (await collect(status)).get('sdb')!
    assert.equal(sdb.poolName, 'gt66')
    assert.equal(sdb.vdevRole, 'dedup')
    assert.equal(sdb.vdevName, 'dedup')
  })
})

describe('resolveLeafKernel — short kernel-name leaves resolve to their disk (vdevs.1)', () => {
  // A pool built on the command line from /dev/sdbN gets bare kernel names in
  // `zpool status`; the Disks join has to reduce them to the whole disk itself.
  const empty = new Map<string, string>()
  const table: [string, string, string | null][] = [
    ['sdb2', '', 'sdb'],
    ['sdb', '', 'sdb'],
    ['sda', '', 'sda'],
    ['sda15', '', 'sda'],
    ['nvme0n1p2', '', 'nvme0n1'],
    ['nvme0n1', '', 'nvme0n1'],
    ['mmcblk0p1', '', 'mmcblk0'],
    ['mmcblk0', '', 'mmcblk0'],
    ['vdb1', '', 'vdb'],
    // Neither a known by-id nor a kernel name — no cross-reference, no guess.
    ['not-a-device', '', null],
  ]

  for (const [id, path, want] of table) {
    it(`${id}${path ? ` (path ${path})` : ''} → ${want}`, () => {
      assert.equal(resolveLeafKernel(id, path, empty), want)
    })
  }

  it('the kernel PATH resolves the same way when the id is unhelpful', () => {
    assert.equal(resolveLeafKernel('12345', '/dev/sdb5', empty), 'sdb')
    assert.equal(resolveLeafKernel('12345', '/dev/nvme0n1p2', empty), 'nvme0n1')
    assert.equal(resolveLeafKernel('12345', '/dev/mmcblk0p1', empty), 'mmcblk0')
  })
})
