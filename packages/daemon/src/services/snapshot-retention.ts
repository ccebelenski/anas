import type { RetentionBucket, RetentionPlan, RetentionPolicy, ScheduledSnapshot } from '@anas/shared'
import { isTransientRunSnapshot, parseScheduledName } from './snapshot-naming.js'

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
 *      never take a bucket slot: the keep/prune decision is made over the
 *      UNHELD snapshots only, so a hold never shrinks retention depth (the
 *      holds-vs-prune trap, GT-7). Which held snapshots to REPORT is a second,
 *      as-if-unheld plan over all of them: a held snapshot that plan would
 *      prune goes to `skippedHeld` (retained, surfaced as intentionally kept);
 *      one it would keep is kept silently — replication holds its newest sent
 *      snapshot, which the policy keeps anyway, and that must not make every
 *      run a warning. btrfs snapshots are never held.
 *   3. Each remaining snapshot is bucketed by the period encoded in its NAME.
 *      Within a bucket, the N newest (by the name's UTC timestamp) are kept;
 *      the rest are pruned. A bucket ABSENT from the policy is left alone
 *      (story ident.1, audit #1): its snapshots are kept and take no part in
 *      the plan — a "minimal" policy never erases a sibling schedule's
 *      hourlies. (`0` is still "keep none"; a schedule's own cadence bucket is
 *      made present by the caller — {@link effectiveRetention}.)
 *   4. The most recent snapshot overall is ALWAYS kept, even if its bucket's
 *      count is `0` — sanoid's absolute always-keep-newest guarantee. "Most
 *      recent" is the newest snapshot at-or-before `now` (a future-dated,
 *      clock-skewed snapshot cannot claim the guarantee); if every eligible
 *      snapshot is future-dated, the newest overall is protected instead, so at
 *      least one snapshot always survives. Snapshots of absent buckets are not
 *      eligible, so the guarantee is over the planned buckets.
 *
 * ⚠ TRANSIENT BACKUP SNAPSHOTS ARE OUTSIDE RETENTION ENTIRELY (backup2.3). A
 * snapshot-consistent backup run takes `anas-backup-<task>-<ts>`, backs up from
 * it and destroys it in a `finally` — the run owns that lifetime end to end.
 * They are dropped BEFORE anything else here, so they never occupy a bucket
 * slot, never displace a real snapshot from a keep budget, never claim the
 * always-keep-newest guarantee, and are never handed to `zfs destroy` by a
 * prune. The predicate is the one shared with replication (snapshot-naming.ts).
 */
export function planRetention(
  snapshots: ScheduledSnapshot[],
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionPlan {
  const durable = snapshots.filter(s => !isTransientRunSnapshot(s.name))
  const anas = durable.filter(s => s.source === 'anas')
  // Rule 3's absent-bucket half: a snapshot of a bucket the policy does not
  // name is kept, outside the plan (an unparseable `anas` name is kept by
  // keepOrPrune, so it stays in the planned set to land there).
  const absent = anas.filter(s => !inPolicy(s, policy))
  const planned = anas.filter(s => inPolicy(s, policy))
  const held = planned.filter(s => s.held === true)

  // (1) The decision: unheld snapshots only — a held one never takes a slot.
  const decision = keepOrPrune(planned.filter(s => s.held !== true), policy, now)
  if (held.length === 0)
    return { keep: [...decision.keep, ...absent], prune: decision.prune, skippedHeld: [] }

  // (2) The report: which held snapshots an as-if-unheld plan would prune.
  const asIfUnheld = keepOrPrune(planned, policy, now)
  const skippedHeld = asIfUnheld.prune.filter(s => s.held === true)
  const silent = held.filter(s => !skippedHeld.includes(s))
  return { keep: [...decision.keep, ...silent, ...absent], prune: decision.prune, skippedHeld }
}

/**
 * Is `snap`'s name-encoded bucket one the policy names (any count, `0`
 * included)? A name that does not parse counts as planned — keepOrPrune keeps
 * it defensively.
 */
function inPolicy(snap: ScheduledSnapshot, policy: RetentionPolicy): boolean {
  const parsed = parseScheduledName(snap.name)
  return !parsed || policy[parsed.bucket] !== undefined
}

/**
 * The policy a schedule prunes its own snapshots with (story ident.1): its
 * retention, with its OWN cadence bucket made present (`0` when absent). The
 * absent-bucket rule leaves a bucket the policy does not name alone — right for
 * a sibling's snapshots, wrong for the ones this schedule takes, which would
 * then grow without bound (an hourly schedule on the "minimal" daily/weekly
 * preset). With the cadence bucket at `0` such a schedule keeps its newest, as
 * before.
 */
export function effectiveRetention(schedule: { cadence: RetentionBucket, retention: RetentionPolicy }): RetentionPolicy {
  if (schedule.retention[schedule.cadence] !== undefined)
    return schedule.retention
  return { ...schedule.retention, [schedule.cadence]: 0 }
}

/**
 * Rules 3 and 4 over `eligible` (ANAS-sourced, durable): the N newest per
 * name-encoded bucket, plus the always-kept newest overall.
 */
function keepOrPrune(
  eligible: ScheduledSnapshot[],
  policy: RetentionPolicy,
  now: Date,
): { keep: ScheduledSnapshot[], prune: ScheduledSnapshot[] } {
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
    const n = policy[bucket] ?? 0 // present by construction (planRetention filtered absent buckets)
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

  return { keep, prune }
}
