import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { computeArcTelemetry, hitRatio, parseArcstats } from '../arcstats.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/telemetry')
const arcstatsText = readFileSync(join(fixturesDir, 'arcstats.txt'), 'utf-8')

describe('parseArcstats', () => {
  it('extracts the counters we need from the real fixture', () => {
    const s = parseArcstats(arcstatsText)
    assert.equal(s.hits, 2017834)
    assert.equal(s.misses, 7927)
    assert.equal(s.size, 11328792)
    assert.equal(s.c, 128246272)
    assert.equal(s.cMax, 3030138880)
    // No L2ARC in this fixture.
    assert.equal(s.l2Hits, 0)
    assert.equal(s.l2Misses, 0)
    assert.equal(s.l2Size, 0)
  })

  it('missing counters read as 0 (graceful degradation)', () => {
    const s = parseArcstats('hits 4 5\n')
    assert.equal(s.hits, 5)
    assert.equal(s.misses, 0)
    assert.equal(s.cMax, 0)
  })
})

describe('hitRatio — window with lifetime fallback', () => {
  it('uses the window delta when there were accesses', () => {
    // 75 hits / (75 + 25) misses over the window
    assert.equal(hitRatio(75, 25, 999, 999), 0.75)
  })

  it('falls back to the lifetime ratio when the window was idle', () => {
    assert.equal(hitRatio(0, 0, 3, 1), 0.75)
  })

  it('is 0 when neither window nor lifetime saw an access', () => {
    assert.equal(hitRatio(0, 0, 0, 0), 0)
  })

  it('clamps to 0–1', () => {
    assert.ok(hitRatio(10, 0, 10, 0) <= 1)
    assert.ok(hitRatio(0, 10, 0, 10) >= 0)
  })
})

describe('computeArcTelemetry — two snapshots', () => {
  it('rate over the window, sizes from the later snapshot, L2 null when absent', () => {
    const prev = parseArcstats('hits 4 100\nmisses 4 100\nsize 4 10\nc 4 20\nc_max 4 30\nl2_size 4 0\n')
    const cur = parseArcstats('hits 4 175\nmisses 4 125\nsize 4 11\nc 4 21\nc_max 4 31\nl2_size 4 0\n')
    const arc = computeArcTelemetry(prev, cur)
    assert.equal(arc.hitRatio, 0.75) // Δhits 75 / (Δhits 75 + Δmisses 25)
    assert.equal(arc.size, 11)
    assert.equal(arc.target, 21)
    assert.equal(arc.max, 31)
    assert.equal(arc.l2, null)
  })

  it('surfaces L2ARC when a cache device exists (l2_size > 0)', () => {
    const prev = parseArcstats('hits 4 0\nmisses 4 0\nl2_hits 4 10\nl2_misses 4 10\nl2_size 4 4096\n')
    const cur = parseArcstats('hits 4 0\nmisses 4 0\nl2_hits 4 40\nl2_misses 4 20\nl2_size 4 4096\n')
    const arc = computeArcTelemetry(prev, cur)
    assert.ok(arc.l2)
    assert.equal(arc.l2.size, 4096)
    assert.equal(arc.l2.hitRatio, 0.75) // Δ30 / (Δ30 + Δ10)
  })

  it('lifetime fallback for the fixture when prev === cur (idle window)', () => {
    const s = parseArcstats(arcstatsText)
    const arc = computeArcTelemetry(s, s)
    assert.ok(Math.abs(arc.hitRatio - 2017834 / (2017834 + 7927)) < 1e-9)
    assert.equal(arc.l2, null)
  })
})
