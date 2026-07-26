import type { ScheduledSnapshot, SnapshotTarget } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatScheduledName } from '../snapshot-naming.js'
import { planRetention } from '../snapshot-retention.js'

const TARGET: SnapshotTarget = { kind: 'zfs', dataset: 'tank/media' }

/** Build an ANAS-scheduled snapshot in `bucket` at an ISO instant. */
function anas(bucket: Parameters<typeof formatScheduledName>[0], iso: string, over: Partial<ScheduledSnapshot> = {}): ScheduledSnapshot {
  const name = formatScheduledName(bucket, new Date(iso))
  return {
    name,
    target: TARGET,
    bucket,
    createdAt: new Date(iso).toISOString(),
    held: false,
    source: 'anas',
    ...over,
  }
}

/** Build a foreign (non-ANAS) snapshot. */
function other(name: string, over: Partial<ScheduledSnapshot> = {}): ScheduledSnapshot {
  return { name, target: TARGET, bucket: null, createdAt: null, held: false, source: 'other', ...over }
}

const names = (snaps: ScheduledSnapshot[]): string[] => snaps.map(s => s.name).sort()

// A "now" comfortably after every fixture instant below.
const NOW = new Date('2026-07-27T00:00:00.000Z')

describe('planRetention — per-bucket keep-N', () => {
  it('keeps the N newest of a bucket, prunes the rest', () => {
    const snaps = [
      anas('daily', '2026-07-26T00:00:00Z'),
      anas('daily', '2026-07-25T00:00:00Z'),
      anas('daily', '2026-07-24T00:00:00Z'),
      anas('daily', '2026-07-23T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 2 }, NOW)
    assert.deepEqual(names(plan.keep), names([snaps[0], snaps[1]]))
    assert.deepEqual(names(plan.prune), names([snaps[2], snaps[3]]))
    assert.deepEqual(plan.skippedHeld, [])
  })

  it('keeps independently per bucket', () => {
    const snaps = [
      anas('hourly', '2026-07-26T10:00:00Z'),
      anas('hourly', '2026-07-26T09:00:00Z'),
      anas('hourly', '2026-07-26T08:00:00Z'),
      anas('daily', '2026-07-26T00:00:00Z'),
      anas('daily', '2026-07-25T00:00:00Z'),
      anas('weekly', '2026-07-20T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { hourly: 2, daily: 1, weekly: 1 }, NOW)
    // hourly: keep 2 newest (10,09), prune 08. daily: keep 1 (26), prune 25.
    // weekly: keep 1 (20).
    assert.deepEqual(
      names(plan.keep),
      names([snaps[0], snaps[1], snaps[3], snaps[5]]),
    )
    assert.deepEqual(names(plan.prune), names([snaps[2], snaps[4]]))
  })
})

describe('planRetention — always keep the most recent overall', () => {
  it('rescues the newest even when its bucket count is 0', () => {
    const snaps = [
      anas('daily', '2026-07-26T00:00:00Z'), // newest overall
      anas('daily', '2026-07-25T00:00:00Z'),
      anas('hourly', '2026-07-24T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 0, hourly: 0 }, NOW)
    // Everything would prune, but the newest overall survives.
    assert.deepEqual(names(plan.keep), [snaps[0].name])
    assert.deepEqual(names(plan.prune), names([snaps[1], snaps[2]]))
  })

  it('an all-zero policy over one bucket keeps exactly the newest', () => {
    const snaps = [
      anas('weekly', '2026-07-26T00:00:00Z'),
      anas('weekly', '2026-07-19T00:00:00Z'),
      anas('weekly', '2026-07-12T00:00:00Z'),
    ]
    const plan = planRetention(snaps, {}, NOW) // no counts at all → all 0
    assert.deepEqual(names(plan.keep), [snaps[0].name])
    assert.equal(plan.prune.length, 2)
  })

  it('the newest overall may live in a different bucket than the largest count', () => {
    const snaps = [
      anas('yearly', '2026-07-26T00:00:00Z'), // newest overall, but yearly=0
      anas('daily', '2026-07-25T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 5, yearly: 0 }, NOW)
    assert.deepEqual(names(plan.keep), names(snaps)) // daily kept by count, yearly by newest-rule
    assert.deepEqual(plan.prune, [])
  })
})

describe('planRetention — held snapshots (holds-vs-prune)', () => {
  it('sets held snapshots aside into skippedHeld, never prunes them', () => {
    const snaps = [
      anas('daily', '2026-07-26T00:00:00Z'),
      anas('daily', '2026-07-25T00:00:00Z'),
      anas('daily', '2026-07-22T00:00:00Z', { held: true }), // oldest, HELD (replication base)
    ]
    const plan = planRetention(snaps, { daily: 1 }, NOW)
    // daily=1 keeps only the newest eligible (26). The held one is NOT pruned
    // and NOT counted — it is retained as skippedHeld. The 25th prunes.
    assert.deepEqual(names(plan.keep), [snaps[0].name])
    assert.deepEqual(names(plan.prune), [snaps[1].name])
    assert.deepEqual(names(plan.skippedHeld), [snaps[2].name])
  })

  it('a held snapshot does not consume a bucket keep slot', () => {
    const snaps = [
      anas('daily', '2026-07-26T00:00:00Z', { held: true }),
      anas('daily', '2026-07-25T00:00:00Z'),
      anas('daily', '2026-07-24T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 1 }, NOW)
    // held one is aside; among the 2 eligible, keep 1 (25), prune 24.
    assert.deepEqual(names(plan.skippedHeld), [snaps[0].name])
    assert.deepEqual(names(plan.keep), [snaps[1].name])
    assert.deepEqual(names(plan.prune), [snaps[2].name])
  })
})

describe('planRetention — source filter', () => {
  it('never prunes (or keeps) an other-source snapshot', () => {
    const snaps = [
      other('nightly-2026-07-14'), // manual
      other('anasrepl-base', { held: true }), // replication base
      anas('daily', '2026-07-26T00:00:00Z'),
      anas('daily', '2026-07-25T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 1 }, NOW)
    const all = [...plan.keep, ...plan.prune, ...plan.skippedHeld]
    // Neither foreign snapshot appears anywhere in the plan.
    assert.ok(!all.some(s => s.source === 'other'))
    assert.deepEqual(names(plan.keep), [snaps[2].name])
    assert.deepEqual(names(plan.prune), [snaps[3].name])
  })
})

describe('planRetention — edge cases', () => {
  it('empty inventory → empty plan', () => {
    assert.deepEqual(planRetention([], { daily: 5 }, NOW), { keep: [], prune: [], skippedHeld: [] })
  })

  it('all snapshots in one bucket, generous count keeps them all', () => {
    const snaps = Array.from({ length: 5 }, (_, i) =>
      anas('hourly', `2026-07-26T0${i}:00:00Z`))
    const plan = planRetention(snaps, { hourly: 10 }, NOW)
    assert.equal(plan.keep.length, 5)
    assert.equal(plan.prune.length, 0)
  })

  it('keep-N boundary: exactly N keeps all, N-1 prunes the oldest', () => {
    const snaps = [
      anas('daily', '2026-07-26T00:00:00Z'),
      anas('daily', '2026-07-25T00:00:00Z'),
      anas('daily', '2026-07-24T00:00:00Z'),
    ]
    assert.equal(planRetention(snaps, { daily: 3 }, NOW).prune.length, 0)
    const plan2 = planRetention(snaps, { daily: 2 }, NOW)
    assert.deepEqual(names(plan2.prune), [snaps[2].name]) // oldest at the boundary
  })

  it('a future-dated snapshot does not claim the always-keep-newest guarantee', () => {
    // The clock is BEFORE the "future" snapshot; a legitimate at-or-before-now
    // snapshot is the one protected when all counts are 0.
    const now = new Date('2026-07-26T12:00:00Z')
    const snaps = [
      anas('daily', '2026-07-27T00:00:00Z'), // future (clock skew)
      anas('daily', '2026-07-26T00:00:00Z'), // newest at-or-before now
      anas('daily', '2026-07-25T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 0 }, now)
    // The at-or-before-now newest (26) is the protected one, not the future 27.
    assert.deepEqual(names(plan.keep), [snaps[1].name])
    assert.ok(plan.prune.some(s => s.name === snaps[0].name)) // future one still prunes
  })

  it('when every eligible snapshot is future-dated, the newest overall still survives', () => {
    const now = new Date('2026-07-01T00:00:00Z')
    const snaps = [
      anas('daily', '2026-07-26T00:00:00Z'),
      anas('daily', '2026-07-25T00:00:00Z'),
    ]
    const plan = planRetention(snaps, { daily: 0 }, now)
    assert.deepEqual(names(plan.keep), [snaps[0].name]) // absolute guarantee holds
    assert.equal(plan.prune.length, 1)
  })
})
