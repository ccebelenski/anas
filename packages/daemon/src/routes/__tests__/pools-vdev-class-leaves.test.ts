import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseZpoolStatus } from '../../parsers/zpool-status.js'
import { allVdevLeaves, leavesFromStatus, parseDiscardCapableKernels, poolTrimSupported } from '../pools.js'

/**
 * vdevs.1 consumer audit (GitHub #66), consumers (a) and (f): both the destroy
 * cleanup and the pool-list trim probe walk `vdevGroups` for a pool's leaves.
 * While the parser dropped the pool-level `logs` / `special` / `dedup` sections
 * those walks silently returned DATA leaves only — a destroyed pool left its
 * log, special and dedup partitions carrying live ZFS labels, and a pool whose
 * only SSD sat in a special vdev read as trim-incapable. One shared walk
 * (`allVdevLeaves`) now answers "which leaves does this pool have" for both.
 *
 * Fixture: `zpool-status-all-vdev-classes-2.4.4.json` — the stunt-node capture
 * of one pool carrying all six classes, one partition each (ZFS 2.4.4).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures/zfs')

function statusFixture(name: string) {
  return parseZpoolStatus(JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8')))
}

describe('vdev-class leaves — every class counts as a leaf (vdevs.1)', () => {
  const [pool] = statusFixture('zpool-status-all-vdev-classes-2.4.4.json')

  it('allVdevLeaves returns all SIX leaves, one per vdev class', () => {
    const leaves = allVdevLeaves(pool)
    assert.equal(leaves.length, 6)
    assert.deepEqual(leaves.map(l => l.id).sort(), ['sdb1', 'sdb2', 'sdb3', 'sdb4', 'sdb5', 'sdb6'])
    // Paths travel with the ids — the destroy cleanup targets the partition,
    // not the whole disk.
    assert.deepEqual(leaves.map(l => l.path).sort(), [
      '/dev/sdb1',
      '/dev/sdb2',
      '/dev/sdb3',
      '/dev/sdb4',
      '/dev/sdb5',
      '/dev/sdb6',
    ])
  })

  it('destroy cleanup (leavesFromStatus) resolves all six for labelclear', () => {
    const leaves = leavesFromStatus(pool)
    assert.equal(leaves.length, 6)
    // The special and dedup members are in the cleanup set — the ones a destroy
    // used to leave labelled, so the disk still read as a zfs_member.
    const ids = leaves.map(l => l.leafId)
    assert.ok(ids.includes('sdb5'), 'special leaf cleaned')
    assert.ok(ids.includes('sdb6'), 'dedup leaf cleaned')
    assert.ok(ids.includes('sdb2'), 'log leaf cleaned')
  })

  it('a kernel-name leaf is addressed by its kernel device, not a made-up by-id', () => {
    // This pool was built on the command line from /dev/sdbN: there is no by-id
    // anywhere in `zpool status`, so `/dev/disk/by-id/sdb1` names nothing and
    // the cleanup used to fail on every leaf, leaving the disk labelled.
    const leaves = leavesFromStatus(pool)
    assert.deepEqual(leaves.map(l => l.leafPath).sort(), [
      '/dev/sdb1',
      '/dev/sdb2',
      '/dev/sdb3',
      '/dev/sdb4',
      '/dev/sdb5',
      '/dev/sdb6',
    ])
    // All six sit on ONE disk, so the GPT is zapped once, on the real device.
    assert.deepEqual([...new Set(leaves.map(l => l.wholeDiskPath))], ['/dev/sdb'])
    assert.deepEqual([...new Set(leaves.map(l => l.wholeDiskId))], ['sdb'])
    // …and each leaf knows its kernel partition, which is what the ownership
    // guard needs to tell our own partitions from a stranger's.
    assert.deepEqual(leaves.map(l => l.leafKernel).sort(), [
      'sdb1',
      'sdb2',
      'sdb3',
      'sdb4',
      'sdb5',
      'sdb6',
    ])
  })

  it('a by-id leaf is still addressed by its by-id path, partition suffix kept', () => {
    const byIdPool = parseZpoolStatus(JSON.stringify({
      pools: {
        byidpool: {
          name: 'byidpool',
          state: 'ONLINE',
          pool_guid: '3',
          vdevs: {
            byidpool: {
              name: 'byidpool',
              vdev_type: 'root',
              state: 'ONLINE',
              vdevs: {
                'ata-DISK_A': {
                  name: 'ata-DISK_A',
                  vdev_type: 'disk',
                  state: 'ONLINE',
                  path: '/dev/disk/by-id/ata-DISK_A-part1',
                  devid: 'ata-DISK_A-part1',
                },
              },
            },
          },
        },
      },
    }))[0]
    const [leaf] = leavesFromStatus(byIdPool)
    assert.equal(leaf.leafPath, '/dev/disk/by-id/ata-DISK_A-part1')
    assert.equal(leaf.wholeDiskPath, '/dev/disk/by-id/ata-DISK_A')
    assert.equal(leaf.wholeDiskId, 'ata-DISK_A')
    assert.equal(leaf.leafKernel, undefined)
  })

  it('a mirrored log contributes BOTH its legs', () => {
    const [mirrored] = statusFixture('zpool-status-mirrored-log-partitions-2.4.4.json')
    const logGroup = mirrored.vdevGroups.find(g => g.role === 'log')!
    assert.equal(logGroup.vdevs[0].disks.length, 2)
    const ids = allVdevLeaves(mirrored).map(l => l.id)
    for (const leg of logGroup.vdevs[0].disks)
      assert.ok(ids.includes(leg.id), `log leg ${leg.id} is a leaf`)
  })
})

describe('pool-list trim probe reaches non-data classes (vdevs.1 consumer f)', () => {
  /**
   * A pool whose DATA vdev is on a spinning disk and whose special vdev is on an
   * SSD: `trimSupported` can only be true if the leaf walk reaches the special
   * vdev. This is the shape that makes the gap visible — with a data-only walk
   * the answer is false and the Pools grid greys Trim on a pool that supports it.
   */
  const status = parseZpoolStatus(JSON.stringify({
    pools: {
      mixed: {
        name: 'mixed',
        state: 'ONLINE',
        pool_guid: '7',
        vdevs: {
          mixed: {
            name: 'mixed',
            vdev_type: 'root',
            state: 'ONLINE',
            vdevs: {
              'ata-HDD_B': {
                name: 'ata-HDD_B',
                vdev_type: 'disk',
                state: 'ONLINE',
                path: '/dev/disk/by-id/ata-HDD_B-part1',
                devid: 'ata-HDD_B-part1',
              },
            },
          },
        },
        special: {
          'ata-SSD_A': {
            name: 'ata-SSD_A',
            vdev_type: 'disk',
            state: 'ONLINE',
            class: 'special',
            path: '/dev/disk/by-id/ata-SSD_A-part1',
            devid: 'ata-SSD_A-part1',
          },
        },
      },
    },
  }))[0]

  const byId = new Map<string, string>([['ata-SSD_A', 'sda'], ['ata-HDD_B', 'sdb']])
  const capable = parseDiscardCapableKernels(JSON.stringify({
    blockdevices: [
      { 'name': 'sda', 'disc-gran': 512, 'children': [{ 'name': 'sda1', 'disc-gran': 512 }] },
      { 'name': 'sdb', 'disc-gran': 0, 'children': [{ 'name': 'sdb1', 'disc-gran': 0 }] },
    ],
  }))

  it('a pool whose only discard-capable device is its SPECIAL vdev reads trim-capable', () => {
    assert.equal(poolTrimSupported(allVdevLeaves(status), byId, capable), true)
  })

  it('…and the data leaf alone would not have said so', () => {
    const dataOnly = status.vdevGroups.find(g => g.role === 'data')!.vdevs.flatMap(v => v.disks.map(d => ({ id: d.id, path: d.path })))
    assert.equal(poolTrimSupported(dataOnly, byId, capable), false)
  })
})
