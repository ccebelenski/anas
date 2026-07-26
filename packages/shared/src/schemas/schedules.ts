import { z } from 'zod'
import { DatasetPath, PoolName } from './common.js'

// ============================================================================
// Uniform snapshot schedules (Epic 17 — Schedules; docs/SCHEDULES-DESIGN.md).
//
// The guiding principle: ZFS and AHR function EXACTLY THE SAME with respect to
// snapshots, scrubbing, and pruning — one uniform user experience — even though
// the underlying mechanisms differ. A schedule targets either a ZFS dataset or
// an AHR pool; ANAS takes/prunes/lists snapshots through one policy and one set
// of shapes, dispatching to the filesystem-appropriate backend behind them.
//
// Stage 1 (this file) is the uniform CORE: the schedule descriptor, the
// retention policy + plan, and the inventory shape. The systemd timer/schedule
// store, routes, scrub toggle, and UI are later stages. `cadence` here is a
// PLACEHOLDER descriptor — the timer stage owns the systemd OnCalendar
// translation; it is not modelled fully yet.
//
// Retention is LEARNED from sanoid (docs/SCHEDULES-GROUND-TRUTH.md): keep-N per
// named period bucket, always keep the most recent, prune only our own
// (naming-convention-scoped) snapshots, never a held one.
// ============================================================================

/**
 * The six retention period buckets, learned from sanoid. Every ANAS-scheduled
 * snapshot belongs to exactly one — recorded in its name (`anas-<bucket>-<utc>`)
 * by the cadence that created it. Retention keeps the N newest per bucket.
 */
export const RetentionBucket = z.enum([
  'frequently',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
])
export type RetentionBucket = z.infer<typeof RetentionBucket>

/**
 * A schedule's cadence — a PLACEHOLDER descriptor for stage 1. It names the
 * bucket a fired snapshot is taken into; the timer stage will translate it to a
 * concrete systemd `OnCalendar=` expression. Modelled as the bucket enum for
 * now (a `daily` cadence takes `anas-daily-<utc>` snapshots).
 */
export const SnapshotCadence = RetentionBucket
export type SnapshotCadence = z.infer<typeof SnapshotCadence>

/**
 * Keep-N per period bucket (learned from sanoid). Each value is the number of
 * that bucket's snapshots to retain; an absent bucket is treated as `0` (keep
 * none of that period — the newest overall is still always kept). `0` means
 * "prune this period down to nothing" (sanoid's off/prune semantic, GT-7),
 * subject to the always-keep-most-recent-overall guarantee.
 */
export const RetentionPolicy = z.object({
  frequently: z.number().int().nonnegative().optional(),
  hourly: z.number().int().nonnegative().optional(),
  daily: z.number().int().nonnegative().optional(),
  weekly: z.number().int().nonnegative().optional(),
  monthly: z.number().int().nonnegative().optional(),
  yearly: z.number().int().nonnegative().optional(),
})
export type RetentionPolicy = z.infer<typeof RetentionPolicy>

/**
 * A snapshot schedule's target: either a ZFS dataset or an AHR pool. This is
 * the discriminant the uniform take/prune/list services dispatch on — the ONE
 * place the two filesystems diverge.
 */
export const SnapshotTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('zfs'),
    /** Full ZFS dataset path (pool-qualified, e.g. `tank/media`). */
    dataset: DatasetPath,
  }),
  z.object({
    kind: z.literal('ahr'),
    /** AHR pool name (the btrfs pool whose `@data` is snapshotted). */
    pool: PoolName,
  }),
])
export type SnapshotTarget = z.infer<typeof SnapshotTarget>

/** Schedule identifier — a stable, filename-safe slug. */
export const ScheduleId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][\w.-]*$/i, 'Must start alphanumeric and contain only letters, digits, and . _ -')
export type ScheduleId = z.infer<typeof ScheduleId>

/**
 * A snapshot schedule: take a snapshot of `target` on `cadence`, keeping it per
 * `retention`. The uniform record the Schedules screen edits — identical for a
 * ZFS dataset and an AHR pool; only `target.kind` decides the backend.
 */
export const SnapshotSchedule = z.object({
  /** Stable identifier (also the systemd unit instance name, later stage). */
  id: ScheduleId,
  /** Human label shown in the grid. */
  name: z.string().min(1),
  target: SnapshotTarget,
  /** How often a snapshot is taken (placeholder descriptor — see SnapshotCadence). */
  cadence: SnapshotCadence,
  retention: RetentionPolicy,
  /** ZFS: `zfs snapshot -r` (recurse into children). AHR: n/a (whole @data). */
  recursive: z.boolean().optional(),
  /** Whether the schedule is active (a disabled schedule keeps but never takes). */
  enabled: z.boolean(),
})
export type SnapshotSchedule = z.infer<typeof SnapshotSchedule>

/**
 * Where a snapshot came from. `anas` = created by an ANAS schedule (matches the
 * `anas-<bucket>-<utc>` naming convention) — the ONLY snapshots retention is
 * allowed to prune. `other` = a replication base, a manual ZFS snapshot, or an
 * AHR-manual snapshot — surfaced in the inventory but NEVER pruned by us.
 */
export const SnapshotSource = z.enum(['anas', 'other'])
export type SnapshotSource = z.infer<typeof SnapshotSource>

/**
 * One snapshot in the uniform inventory — the shape both backends produce. For
 * an `anas` snapshot the `bucket` and the timestamp are decoded from the name;
 * for an `other` snapshot `bucket` is null (it belongs to no ANAS period).
 */
export const ScheduledSnapshot = z.object({
  /** Snapshot label (ZFS: the part after `@`; AHR: the `@snapshots/` child name). */
  name: z.string().min(1),
  target: SnapshotTarget,
  /** ANAS retention period from the name, or null for `other` snapshots. */
  bucket: RetentionBucket.nullable(),
  /**
   * Creation time. ZFS: from `creation` (a proper ISO-UTC instant). AHR: the
   * btrfs `otime` (local, no timezone — as reported), or null when btrfs
   * recorded none. Never fabricated.
   */
  createdAt: z.string().nullable(),
  /**
   * Whether the snapshot is protected from destroy. ZFS: `userrefs > 0` (a
   * `zfs hold` — e.g. a replication base). AHR: always false (btrfs snapshots
   * are not ZFS-held). A held snapshot is never pruned — it is surfaced as
   * intentionally retained.
   */
  held: z.boolean().optional(),
  source: SnapshotSource,
})
export type ScheduledSnapshot = z.infer<typeof ScheduledSnapshot>

/**
 * The outcome of applying a retention policy to an inventory:
 * - `keep` — ANAS snapshots retained by the policy (incl. the always-kept newest).
 * - `prune` — ANAS snapshots to destroy (never a held one; never an `other` one).
 * - `skippedHeld` — held ANAS snapshots set aside, retained regardless of policy
 *   and surfaced as intentionally kept (the holds-vs-prune trap, GT-7).
 *
 * `other`-source snapshots appear in NONE of these sets — they are outside ANAS
 * retention entirely.
 */
export const RetentionPlan = z.object({
  keep: z.array(ScheduledSnapshot),
  prune: z.array(ScheduledSnapshot),
  skippedHeld: z.array(ScheduledSnapshot),
})
export type RetentionPlan = z.infer<typeof RetentionPlan>
