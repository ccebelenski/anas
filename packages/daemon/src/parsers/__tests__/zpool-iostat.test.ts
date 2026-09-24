import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { nodeToIoStats, parseZpoolIostat } from '../zpool-iostat.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/telemetry')
const iostatText = readFileSync(join(fixturesDir, 'zpool-iostat-plv.txt'), 'utf-8')

describe('parseZpoolIostat', () => {
  const samples = parseZpoolIostat(iostatText)

  it('splits the output into two samples (since-boot + interval)', () => {
    assert.equal(samples.length, 2)
  })

  it('positions rows in the pool → vdev → disk tree by indentation', () => {
    const s = samples[0]
    const testpool = s.find(n => n.name === 'testpool')!
    assert.equal(testpool.depth, 0)
    assert.equal(testpool.pool, 'testpool')
    assert.equal(testpool.vdev, undefined)

    const mirror0 = s.find(n => n.name === 'mirror-0')!
    assert.equal(mirror0.depth, 1)
    assert.equal(mirror0.pool, 'testpool')
    assert.equal(mirror0.vdev, undefined)

    const sdb = s.find(n => n.name === 'sdb')!
    assert.equal(sdb.depth, 2)
    assert.equal(sdb.pool, 'testpool')
    assert.equal(sdb.vdev, 'mirror-0')

    // A by-id leaf under mirror-1 keeps its raw name and correct vdev.
    const hot4 = s.find(n => n.name === 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4')!
    assert.equal(hot4.depth, 2)
    assert.equal(hot4.vdev, 'mirror-1')
  })

  it('extracts ops/bandwidth/total_wait columns from the first (busy) sample', () => {
    const s = samples[0]
    const testpool = s.find(n => n.name === 'testpool')!
    assert.deepEqual(testpool.ops, { read: 0, write: 1 })
    assert.deepEqual(testpool.bandwidth, { read: 894, write: 5290 })
    assert.deepEqual(testpool.totalWait, { read: 4045660, write: 540882 })

    const sdb = s.find(n => n.name === 'sdb')!
    assert.deepEqual(sdb.bandwidth, { read: 209, write: 944 })
    assert.deepEqual(sdb.totalWait, { read: 3695578, write: 536826 })
  })

  it('maps `-` latency cells to null (and rates to 0) in the idle second sample', () => {
    const s = samples[1]
    const testpool = s.find(n => n.name === 'testpool')!
    assert.deepEqual(testpool.ops, { read: 0, write: 0 })
    assert.deepEqual(testpool.bandwidth, { read: 0, write: 0 })
    assert.deepEqual(testpool.totalWait, { read: null, write: null })

    const sdb = s.find(n => n.name === 'sdb')!
    assert.equal(sdb.totalWait.read, null)
    assert.equal(sdb.totalWait.write, null)
  })
})

describe('nodeToIoStats — column → IoStats mapping', () => {
  it('maps bandwidth→bytes/s, ops→IOPS, total_wait→latency ns', () => {
    const [sample] = parseZpoolIostat(iostatText)
    const sdb = sample.find(n => n.name === 'sdb')!
    assert.deepEqual(nodeToIoStats(sdb), {
      readBytesPerSec: 209,
      writeBytesPerSec: 944,
      readIops: 0,
      writeIops: 0,
      readLatencyNs: 3695578,
      writeLatencyNs: 536826,
    })
  })

  it('null latency survives the mapping for an idle device', () => {
    const samples = parseZpoolIostat(iostatText)
    const sdb = samples[1].find(n => n.name === 'sdb')!
    const io = nodeToIoStats(sdb)
    assert.equal(io.readLatencyNs, null)
    assert.equal(io.writeLatencyNs, null)
    assert.equal(io.readBytesPerSec, 0)
  })
})

/**
 * Stunt-node capture (ZFS 2.4.4, 2026-09-24) of a pool carrying all six vdev
 * classes on six partitions of one disk — the shape GitHub #66 reported. The
 * class sections (`logs`, `cache`, `special`, `dedup`) print UNINDENTED, in the
 * pool column, with every value cell `-`. That SHAPE is what tells a header
 * from a pool row: a pool always carries its capacity numbers.
 */
describe('parseZpoolIostat — vdev-class section headers (vdevs.1)', () => {
  const classesText = readFileSync(
    join(fixturesDir, 'zpool-iostat-plv-all-vdev-classes-2.4.4.txt'),
    'utf-8',
  )

  it('a header is told by its shape even when no pool names are given', () => {
    const [sample] = parseZpoolIostat(classesText)
    const pools = sample.filter(n => n.depth === 0).map(n => n.name)
    assert.deepEqual(pools, ['gtvdev'])
  })

  it('naming the pool folds every section under it, its devices as vdevs', () => {
    const [sample] = parseZpoolIostat(classesText, new Set(['gtvdev']))
    assert.deepEqual(sample.filter(n => n.depth === 0).map(n => n.name), ['gtvdev'])
    for (const node of sample)
      assert.equal(node.pool, 'gtvdev', `${node.name} belongs to gtvdev`)
    // One vdev row per class that has I/O — the spare has no row at all.
    assert.deepEqual(
      sample.filter(n => n.depth === 1).map(n => n.name),
      ['sdb1', 'sdb6', 'sdb5', 'sdb2', 'sdb3'],
    )
  })

  it('the section header itself is dropped — it carries no statistics', () => {
    const [sample] = parseZpoolIostat(classesText, new Set(['gtvdev']))
    for (const name of ['logs', 'cache', 'special', 'dedup'])
      assert.equal(sample.find(n => n.name === name), undefined, `${name} dropped`)
  })

  /**
   * A pool may legitimately be called `logs`, `cache`, `special` or `dedup`.
   * Guarding on the NAME broke such a pool outright: its row was read as a
   * section header, its statistics were dropped and its vdevs were attributed
   * to whichever pool printed before it. The shape guard cannot: this text is
   * the capture's own layout with a second pool NAMED `logs` — carrying real
   * numbers, and carrying a real `logs` section of its own (vdevs.1 fix
   * batch 2).
   */
  const namedLikeSectionText = [
    '                        capacity                         operations                         bandwidth                   total_wait               disk_wait              syncq_wait              asyncq_wait            scrub        trim     rebuild',
    'pool                  alloc             free             read            write             read            write        read       write        read       write        read       write        read       write        wait        wait        wait',
    '----------  ---------------  ---------------  ---------------  ---------------  ---------------  ---------------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------',
    'gtvdev               167424       1241346560                0                1            10596            35135     1460516      384704     1460516      288528         733        5473           -      213831           -           -           -',
    '  sdb1                    0        402653184                0                0             2649             8283     1685211      409071     1685211      409071         877         427           -           -           -           -           -',
    'logs                      -                -                -                -                -                -           -           -           -           -           -           -           -           -           -           -           -',
    '  sdb2                    0        201326592                0                0             2649             8238     1685211      615468     1685211      598372         713       25961           -           -           -           -           -',
    'logs                  12288        536870912                0                2             4096            16384      900000      300000      900000      250000         500        1200           -           -           -           -           -',
    '  sdc1                    0        536870912                0                2             4096            16384      900000      300000      900000      250000         500        1200           -           -           -           -           -',
    'logs                      -                -                -                -                -                -           -           -           -           -           -           -           -           -           -           -           -',
    '  sdc2                    0        201326592                0                0              512              256      100000       50000      100000       50000         100         200           -           -           -           -           -',
    '----------  ---------------  ---------------  ---------------  ---------------  ---------------  ---------------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------  ----------',
  ].join('\n')

  it('a pool genuinely NAMED logs keeps its row — the header is the all-`-` one', () => {
    const [sample] = parseZpoolIostat(namedLikeSectionText, new Set(['gtvdev', 'logs']))
    assert.deepEqual(sample.filter(n => n.depth === 0).map(n => n.name), ['gtvdev', 'logs'])

    // The pool row carries the statistics it printed.
    const pool = sample.find(n => n.depth === 0 && n.name === 'logs')!
    assert.equal(pool.ops.write, 2)
    assert.equal(pool.bandwidth.read, 4096)

    // Its own devices belong to it — including the one under its `logs`
    // section header, which is dropped as a header while the pool stands.
    assert.deepEqual(
      sample.filter(n => n.pool === 'logs').map(n => n.name),
      ['logs', 'sdc1', 'sdc2'],
    )
    assert.equal(sample.find(n => n.name === 'sdb2')!.pool, 'gtvdev')
  })

  it('the shape guard works with no pool names at all', () => {
    const [sample] = parseZpoolIostat(namedLikeSectionText)
    assert.deepEqual(sample.filter(n => n.depth === 0).map(n => n.name), ['gtvdev', 'logs'])
  })
})
