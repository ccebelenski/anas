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
 * pool column, with every value cell `-`; only the pools the command was asked
 * about tell a pool row from one of those headers.
 */
describe('parseZpoolIostat — vdev-class section headers (vdevs.1)', () => {
  const classesText = readFileSync(
    join(fixturesDir, 'zpool-iostat-plv-all-vdev-classes-2.4.4.txt'),
    'utf-8',
  )

  it('without the pool names a section header reads as a pool (the old behaviour)', () => {
    const [sample] = parseZpoolIostat(classesText)
    const pools = sample.filter(n => n.depth === 0).map(n => n.name)
    assert.deepEqual(pools, ['gtvdev', 'dedup', 'special', 'logs', 'cache'])
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

  it('a pool that happens to be NAMED like a section is still a pool', () => {
    // The argument is the pools we asked about, so the name collision resolves
    // the honest way round — `special` is a pool here, not a header.
    const [sample] = parseZpoolIostat(classesText, new Set(['gtvdev', 'special']))
    assert.deepEqual(sample.filter(n => n.depth === 0).map(n => n.name), ['gtvdev', 'special'])
  })
})
