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
