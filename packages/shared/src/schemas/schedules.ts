import { z } from 'zod'
import { DatasetPath, ISODateTime, PoolName } from './common.js'
import { ScanFunction } from './zfs.js'

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

// ============================================================================
// Stage 2 — the schedule STORE, its systemd-derived status, and periodic scrub.
//
// A snapshot schedule's systemd timer+service pair IS the store (the Epic 5.5
// replication task-store pattern): the SnapshotSchedule above is embedded in the
// `.service` unit as an `X-ANAS-Schedule=` comment and is the single source of
// truth parsed back. Status is DERIVED from systemd (never stored), exactly like
// a replication/backup task.
// ============================================================================

/**
 * A schedule's last-run outcome, mapped from the oneshot service's systemd
 * state. Mirrors the replication/backup task run-result vocabulary so the
 * Schedules grid reads identically to those views.
 */
export const ScheduleRunResult = z.enum(['success', 'failure', 'running', 'unknown'])
export type ScheduleRunResult = z.infer<typeof ScheduleRunResult>

/**
 * One snapshot schedule's live status, derived from persistent systemd state:
 * the service's last result + last-run time, and the timer's next elapse.
 * `overdue` = enabled AND the next elapse is in the past (a Persistent timer that
 * never caught up). The uniform row the Schedules grid renders (17.3).
 */
export const SnapshotScheduleStatus = z.object({
  schedule: SnapshotSchedule,
  lastRunResult: ScheduleRunResult,
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  overdue: z.boolean(),
})
export type SnapshotScheduleStatus = z.infer<typeof SnapshotScheduleStatus>

/**
 * One schedule's DETAIL — the status fields plus the last run's exit code, the
 * unit files as written, and a recent journald blob. Mirrors the backup task
 * detail ({@link BackupTaskDetail}): last-run logs + exit status are surfaced the
 * SAME way for a snapshot schedule as for a backup task (parallel construction).
 * The exit code is systemd's `ExecMainStatus`; `journal` is a bounded, recent-only
 * `journalctl -u anas-snap-<id>.service` tail (older history is not retained).
 */
export const SnapshotScheduleDetail = z.object({
  schedule: SnapshotSchedule,
  lastRunResult: ScheduleRunResult,
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  overdue: z.boolean(),
  /** The last run's exit code (systemd `ExecMainStatus`); null when never run. */
  lastRunExitCode: z.number().int().nullable(),
  /** The `.service` unit file, verbatim (config-is-the-API transparency). */
  unit: z.string(),
  /** The `.timer` unit file, verbatim. */
  timer: z.string(),
  /** Recent runs' raw journald output (may be empty; older history not retained). */
  journal: z.string().optional(),
})
export type SnapshotScheduleDetail = z.infer<typeof SnapshotScheduleDetail>

/**
 * The result of firing a schedule once (take + prune) — the fire endpoint's job
 * result and what the timer's runner prints to journald. `pruned`/`skippedHeld`
 * are snapshot labels; `skippedHeld` are the held snapshots retained despite
 * policy (the holds-vs-prune trap, GT-7) — surfaced, never a failed destroy.
 */
export const SnapshotScheduleRunResult = z.object({
  schedule: ScheduleId,
  /** The label of the snapshot just taken (`anas-<bucket>-<utc>`). */
  taken: z.string(),
  /** Labels of the snapshots pruned by retention. */
  pruned: z.array(z.string()),
  /** Labels of held snapshots retained despite policy (surfaced as intentional). */
  skippedHeld: z.array(z.string()),
})
export type SnapshotScheduleRunResult = z.infer<typeof SnapshotScheduleRunResult>

// ---- Periodic scrub (uniform surface, filesystem-native backend) ------------

/**
 * A periodic-scrub target: a ZFS pool or an AHR pool. Both are pool-level (the
 * uniform "periodic scrub: on/off (monthly)" surface); only `kind` decides the
 * backend the toggle drives.
 */
export const ScrubTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zfs'), pool: PoolName }),
  z.object({ kind: z.literal('ahr'), pool: PoolName }),
])
export type ScrubTarget = z.infer<typeof ScrubTarget>

/**
 * The filesystem-native mechanism behind a pool's periodic scrub:
 * - `zfs-property` — PVE's monthly cron, per-pool-gated by the pool root's
 *   `org.debian:periodic-scrub` ZFS property (ANAS flips the property).
 * - `mdcheck-timer` — mdadm's shipped `mdcheck_start`/`mdcheck_continue` systemd
 *   timers (ANAS enables/disables them). NODE-GLOBAL: mdcheck verifies every md
 *   array on the host, so this toggle governs md checks for ALL AHR pools at
 *   once — the one place the uniform surface diverges from ZFS's per-pool knob.
 */
export const ScrubMechanism = z.enum(['zfs-property', 'mdcheck-timer'])
export type ScrubMechanism = z.infer<typeof ScrubMechanism>

/**
 * The LAST COMPLETED verify pass on a pool, as the filesystem itself recorded
 * it — the verdict half of the Scrubs screen (17.3: authoritative state from
 * "ZFS reality … `zpool status` scrub dates"). ZFS keeps exactly one scan record
 * per pool and prints its finished form as the familiar
 * `scrub repaired 0B in 05:23:11 with 0 errors on Sun Aug  3 …` line; ANAS
 * surfaces those same facts structured, computed from nothing else.
 *
 * SANCTIONED DIVERGENCE (visible, never hidden): md keeps NO completion record
 * of its own, so an AHR pool's `lastScrub` is ALWAYS null and the screen says so
 * in words. ANAS does not mine journald for one and does not write a state file
 * to manufacture one — the system is the source of truth, and when it records
 * nothing we report nothing (Principle 11).
 */
export const LastScrub = z.object({
  /** Which pass completed — ZFS keeps the most recent scrub OR resilver, not one of each. */
  function: ScanFunction,
  /**
   * How it ended. `FINISHED` ran to completion; `CANCELED` was stopped early
   * (`zpool scrub -s`) and therefore verified only part of the pool — its
   * "0 errors" is not a clean bill of health and must not be rendered as one.
   */
  state: z.enum(['FINISHED', 'CANCELED']),
  /** When the pass ended (ZFS `end_time`) — the "on <date>" of the scan line. */
  finishedAt: ISODateTime,
  /** Wall-clock length of the pass (end − start) — the "in 05:23:11" figure. */
  durationSeconds: z.number().int().nonnegative(),
  /** Bytes repaired by the pass — ZFS's `processed`, the "repaired 0B" figure. */
  repairedBytes: z.number().nonnegative(),
  /** Errors the pass found — the "with 0 errors" figure. */
  errors: z.number().int().nonnegative(),
})
export type LastScrub = z.infer<typeof LastScrub>

/**
 * A pool's periodic-scrub state, uniform across ZFS and AHR. `cadence` is
 * `monthly` for both (ZFS: PVE's 2nd-Sunday cron; AHR: mdcheck's 1st-Sunday
 * timer) — custom cadences are a later refinement (SCHEDULES-DESIGN §Scrub).
 * `note` carries the mechanism caveat (e.g. mdcheck's node-global scope).
 */
export const PeriodicScrubState = z.object({
  target: ScrubTarget,
  enabled: z.boolean(),
  cadence: z.literal('monthly'),
  mechanism: ScrubMechanism,
  note: z.string().optional(),
  /**
   * The last completed verify pass, or null when the filesystem records none —
   * a ZFS pool never scrubbed, and EVERY AHR pool (see {@link LastScrub}).
   */
  lastScrub: LastScrub.nullable(),
})
export type PeriodicScrubState = z.infer<typeof PeriodicScrubState>

/** Toggle a pool's periodic scrub on/off. */
export const ScrubToggleRequest = z.object({ enabled: z.boolean() })
export type ScrubToggleRequest = z.infer<typeof ScrubToggleRequest>
