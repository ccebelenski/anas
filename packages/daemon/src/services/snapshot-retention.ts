import type { RetentionBucket, RetentionPlan, RetentionPolicy, ScheduledSnapshot } from '@anas/shared'
import { parseScheduledName } from './snapshot-naming.js'

/**
 * The uniform retention engine (Epic 17) — pure computation, no I/O. Encodes
 * sanoid's proven retention model (docs/SCHEDULES-GROUND-TRUTH.md) so the
 * edge-case correctness is inherited rather than reinvented, and applies it
 * IDENTICALLY to ZFS and AHR snapshots (the uniformity principle):
 *
 *   1. Only ANAS-created snapshots (`source: 'anas'`, i.e. names that parse as
 *      `anas-<bucket>-<utc>`) are eligible. `source: 'other'` — replication
 *      bases, manual ZFS snapshots, AHR-manual snapshots — are NEVER pruned and
 *      appear in NONE of the plan's sets (outside ANAS retention entirely).
 *   2. HELD snapshots (`held: true` — a ZFS `zfs hold`, e.g. a replication base)
 *      are set aside into `skippedHeld`, retained regardless of policy and
 *      surfaced as intentionally kept. They do not count toward any bucket
 *      budget (the holds-vs-prune trap, GT-7). btrfs snapshots are never held.
 *   3. Each remaining snapshot is bucketed by the period encoded in its NAME.
 *      Within a bucket, the N newest (by the name's UTC timestamp) are kept;
 *      the rest are pruned. An absent bucket count is `0` (keep none).
 *   4. The most recent snapshot overall is ALWAYS kept, even if its bucket's
 *      count is `0` — sanoid's absolute always-keep-newest guarantee. "Most
 *      recent" is the newest snapshot at-or-before `now` (a future-dated,
 *      clock-skewed snapshot cannot claim the guarantee); if every eligible
 *      snapshot is future-dated, the newest overall is protected instead, so at
 *      least one snapshot always survives.
 */
export function planRetention(
  snapshots: ScheduledSnapshot[],
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionPlan {
  const anas = snapshots.filter(s => s.source === 'anas')
  const skippedHeld = anas.filter(s => s.held === true)
  const eligible = anas.filter(s => s.held !== true)

  // Decode each eligible snapshot's period + timestamp from its name.
  const decoded = eligible.map(snap => ({ snap, parsed: parseScheduledName(snap.name) }))

  const keep: ScheduledSnapshot[] = []
  const prune: ScheduledSnapshot[] = []

  // Group by the name-encoded bucket; keep the N newest per bucket.
  const byBucket = new Map<RetentionBucket, { snap: ScheduledSnapshot, ts: Date }[]>()
  for (const { snap, parsed } of decoded) {
    // An `anas`-sourced snapshot whose name does not parse is anomalous — keep
    // it defensively (we only ever prune names we can fully account for).
    if (!parsed) {
      keep.push(snap)
      continue
    }
    const group = byBucket.get(parsed.bucket) ?? []
    group.push({ snap, ts: parsed.timestamp })
    byBucket.set(parsed.bucket, group)
  }

  for (const [bucket, group] of byBucket) {
    group.sort((a, b) => b.ts.getTime() - a.ts.getTime()) // newest first
    const n = policy[bucket] ?? 0
    group.forEach((e, i) => (i < n ? keep : prune).push(e.snap))
  }

  // Always keep the most recent overall (sanoid's absolute guarantee).
  const dated = decoded.flatMap(d => (d.parsed ? [{ snap: d.snap, ts: d.parsed.timestamp }] : []))
  if (dated.length > 0) {
    const nowMs = now.getTime()
    const atOrBefore = dated.filter(e => e.ts.getTime() <= nowMs)
    const pool = atOrBefore.length > 0 ? atOrBefore : dated
    const newest = pool.reduce((max, e) => (e.ts.getTime() > max.ts.getTime() ? e : max))
    const idx = prune.indexOf(newest.snap)
    if (idx !== -1) {
      prune.splice(idx, 1)
      keep.push(newest.snap)
    }
  }

  return { keep, prune, skippedHeld }
}
