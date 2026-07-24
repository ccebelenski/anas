import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diskstatsToIoStats, parseDiskstats } from '../diskstats.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
const load = (name: string): string => readFileSync(join(fixturesDir, name), 'utf-8')

// The two genuine snapshots captured on the stunt node (pool `tank`) ~1s apart
// with an 80 MiB direct write in between — see fixtures/ahr/NOTES.md.
const t0 = load('diskstats-tank-t0.txt')
const t1 = load('diskstats-tank-t1.txt')

describe('parseDiskstats — real /proc/diskstats fixture', () => {
  it('parses read/write counters keyed by kernel device name', () => {
    const stats = parseDiskstats(t0)
    // The pool LV (dm-0), band md arrays, whole disks + partitions are all present.
    const dm0 = stats.get('dm-0')
    assert.ok(dm0, 'dm-0 present')
    assert.equal(dm0!.readIos, 66614)
    assert.equal(dm0!.readSectors, 14885008)
    assert.equal(dm0!.readTicksMs, 33653)
    assert.equal(dm0!.writeIos, 1604)
    assert.equal(dm0!.writeSectors, 59024)
    assert.equal(dm0!.writeTicksMs, 7464)

    const md127 = stats.get('md127')
    assert.ok(md127, 'md127 (band r1) present')
    assert.equal(md127!.writeSectors, 56587)

    // A partition line (member slice) parses like any other device.
    const sdf1 = stats.get('sdf1')
    assert.ok(sdf1, 'sdf1 present')
    assert.equal(sdf1!.writeSectors, 4187941)
  })

  it('skips lines without the 8 base value columns and non-numeric rows', () => {
    const stats = parseDiskstats('   9     127 md127 1 2 3 4 5 6 7 8 9 10 11\nbogus header line\n8 0 sdx a b c d e f g h\n\n')
    assert.equal(stats.size, 1)
    assert.ok(stats.has('md127'))
    assert.ok(!stats.has('sdx'), 'non-numeric value row dropped')
  })
})

describe('diskstatsToIoStats — delta → rate derivation', () => {
  it('derives throughput, IOPS and await from the two real snapshots', () => {
    const prev = parseDiskstats(t0)
    const cur = parseDiskstats(t1)
    const windowMs = 1000 // fixture window is ~1s; assert against a fixed 1s.

    // dm-0 (the pool LV) absorbed the 80 MiB write: wr_sectors 59024 → 224032.
    const io = diskstatsToIoStats(prev.get('dm-0'), cur.get('dm-0')!, windowMs)
    const wSectorsDelta = 224032 - 59024
    assert.equal(io.writeBytesPerSec, wSectorsDelta * 512) // 165008 * 512 = ~80 MiB/s
    assert.ok(io.writeBytesPerSec > 80 * 1024 * 1024, 'roughly 80 MiB/s write')
    // Write await = wr_ticks-delta / wr_ios-delta, ms → ns.
    const wIosDelta = 1723 - 1604
    const wTicksDelta = 9125 - 7464
    assert.equal(io.writeLatencyNs, (wTicksDelta / wIosDelta) * 1e6)
    assert.ok(io.writeIops > 0)
    // A tiny read delta still yields a positive read await (never NaN).
    assert.ok(io.readLatencyNs !== null && io.readLatencyNs > 0)
  })

  it('an idle device (md126, no delta) reports zeros and null await, never NaN', () => {
    const prev = parseDiskstats(t0)
    const cur = parseDiskstats(t1)
    const io = diskstatsToIoStats(prev.get('md126'), cur.get('md126')!, 1000)
    assert.equal(io.readBytesPerSec, 0)
    assert.equal(io.writeBytesPerSec, 0)
    assert.equal(io.readIops, 0)
    assert.equal(io.writeIops, 0)
    // Zero io-delta → await omitted (null), NOT 0/0 = NaN.
    assert.equal(io.readLatencyNs, null)
    assert.equal(io.writeLatencyNs, null)
  })

  it('a missing prior sample yields zero rates and null await (never NaN)', () => {
    const cur = parseDiskstats(t1)
    const io = diskstatsToIoStats(undefined, cur.get('dm-0')!, 1000)
    assert.equal(io.writeBytesPerSec, 0)
    assert.equal(io.writeIops, 0)
    assert.equal(io.writeLatencyNs, null)
    assert.equal(io.readLatencyNs, null)
  })

  it('guards a counter wraparound / reset (negative delta) to zero', () => {
    const prev = { device: 'sdz', readIos: 100, readSectors: 5000, readTicksMs: 900, writeIos: 200, writeSectors: 9000, writeTicksMs: 800 }
    // cur counters are LOWER than prev (a reset / unsigned wrap).
    const cur = { device: 'sdz', readIos: 5, readSectors: 40, readTicksMs: 3, writeIos: 2, writeSectors: 10, writeTicksMs: 1 }
    const io = diskstatsToIoStats(prev, cur, 1000)
    assert.equal(io.readBytesPerSec, 0)
    assert.equal(io.writeBytesPerSec, 0)
    assert.equal(io.readIops, 0)
    assert.equal(io.writeIops, 0)
    // No positive io-delta after the guard → await null, never a negative or NaN.
    assert.equal(io.readLatencyNs, null)
    assert.equal(io.writeLatencyNs, null)
  })

  it('a non-positive window clamps rates to zero (no divide-by-zero)', () => {
    const prev = parseDiskstats(t0)
    const cur = parseDiskstats(t1)
    const io = diskstatsToIoStats(prev.get('dm-0'), cur.get('dm-0')!, 0)
    assert.equal(io.readBytesPerSec, 0)
    assert.equal(io.writeBytesPerSec, 0)
    assert.equal(io.readIops, 0)
    assert.equal(io.writeIops, 0)
  })
})
