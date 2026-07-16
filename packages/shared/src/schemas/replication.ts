import { z } from 'zod'
import { PoolName } from './common.js'

/**
 * Replication (Epic 5.5) — stage 1: LOCAL one-shot snapshot replication
 * (`zfs send | zfs recv` on the same node).
 *
 * Design (EPICS 5.5.x, agreed 2026-07-16): stateless — the incremental base is
 * DISCOVERED at run time as the newest snapshot common to source and target
 * (never bookkept); the destination is created `readonly=on`; the incremental
 * base carries a `zfs hold` (tag `anas-repl`) so cleanup cannot sever the
 * chain; a broken chain means a FULL send and the caller must be told (with
 * bytes) before running. journald is forensics, never correctness.
 *
 * Two endpoints, both dataset-scoped:
 *   POST /pools/:name/datasets/<path>/replicate/plan → ReplicatePlan (dry-run,
 *        read-only: mode + exact estimated bytes from `zfs send -nvP`)
 *   POST /pools/:name/datasets/<path>/replicate      → 202 { job }
 */

/** Where a replication lands: a pool and optionally a dataset path within it
 *  (default: the source dataset's own path). Stage 1 is same-node only. */
export const ReplicationTarget = z.object({
  pool: PoolName,
  /** Target dataset path relative to the pool (no leading slash). Defaults to
   *  the source dataset's relative path. */
  dataset: z.string().optional(),
})
export type ReplicationTarget = z.infer<typeof ReplicationTarget>

/** Ask what a replication WOULD do (dry-run; mutates nothing). */
export const ReplicatePlanRequest = z.object({
  target: ReplicationTarget,
  /** Source snapshot to replicate up to (default: the newest snapshot). */
  snapshot: z.string().optional(),
})
export type ReplicatePlanRequest = z.infer<typeof ReplicatePlanRequest>

/** The dry-run answer — shown to the user before they commit. */
export const ReplicatePlan = z.object({
  /** 'incremental' when a common base snapshot exists on both sides. */
  mode: z.enum(['full', 'incremental']),
  /** The snapshot that will be sent (source-side name). */
  snapshot: z.string(),
  /** The common base snapshot (incremental mode only; name without dataset). */
  baseSnapshot: z.string().optional(),
  /** Exact stream size in bytes from `zfs send -nvP`. */
  estimatedBytes: z.number().nonnegative(),
  /** Whether the target dataset already exists. */
  targetExists: z.boolean(),
  /** True when the target exists but shares NO common snapshot — a full send
   *  cannot proceed without destroying the target (out of stage-1 scope; the
   *  UI must say so instead of offering the run). */
  targetDiverged: z.boolean(),
})
export type ReplicatePlan = z.infer<typeof ReplicatePlan>

/** Run a replication (202 → job). Same fields as the plan request, plus an
 *  optional snapshot-first convenience. */
export const ReplicateRequest = z.object({
  target: ReplicationTarget,
  /** Source snapshot to replicate up to (default: the newest snapshot). */
  snapshot: z.string().optional(),
  /** Create a fresh snapshot of the source first (name auto-generated like the
   *  snapshot dialog default), then replicate up to it. */
  snapshotFirst: z.boolean().optional(),
})
export type ReplicateRequest = z.infer<typeof ReplicateRequest>
