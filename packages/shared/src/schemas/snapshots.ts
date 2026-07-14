import { z } from 'zod'
import { ISODateTime, PoolName, SnapshotName } from './common.js'

// --- Read model ---

/**
 * A ZFS snapshot (GET /v1/pools/:name/datasets/*path/snapshots).
 * Returned newest-first; the UI shows the top few inline and offers a popup
 * for the full list (no server-side paging for MVP — one dataset's snapshots
 * are a small payload even at a few thousand).
 */
export const Snapshot = z.object({
  /** Full name, e.g. "tank/media@nightly-2026-07-14" */
  name: z.string(),
  /** Parent dataset, e.g. "tank/media" */
  dataset: z.string(),
  /** The label after '@', e.g. "nightly-2026-07-14" */
  snapshotName: z.string(),
  pool: PoolName,
  /** Creation time, ISO 8601 (parsed from zfs's human string) */
  created: ISODateTime,
  /** Space uniquely held by this snapshot, in bytes */
  used: z.number().nonnegative(),
  /** Space this snapshot references, in bytes */
  referenced: z.number().nonnegative(),
})
export type Snapshot = z.infer<typeof Snapshot>

// --- Write models ---

/** Create a snapshot (POST …/snapshots). `name` is the label after '@'. */
export const CreateSnapshotRequest = z.object({
  name: SnapshotName,
  /** Also snapshot child datasets recursively (`zfs snapshot -r`) */
  recursive: z.boolean().optional(),
})
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequest>

/** Rename a snapshot (PUT …/snapshots/:snap). `newName` is the new label. */
export const RenameSnapshotRequest = z.object({
  newName: SnapshotName,
})
export type RenameSnapshotRequest = z.infer<typeof RenameSnapshotRequest>

/**
 * Clone a snapshot into a new writable dataset (POST …/snapshots/:snap/clone).
 * `target` is the full ZFS name of the dataset to create (e.g. "tank/restored")
 * — it must not already exist. `zfs clone <snapshot> <target>`.
 */
export const CloneSnapshotRequest = z.object({
  target: z.string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9_][\w.:-]*(?:\/[\w.:-]+)*$/i, 'must be a valid ZFS dataset name (pool/path)'),
})
export type CloneSnapshotRequest = z.infer<typeof CloneSnapshotRequest>

// Rollback (POST …/snapshots/:snap/rollback) and destroy (DELETE) need no body:
// the snapshot is identified by the URL. Rollback is dangerous and goes through
// the confirmation flow; snapshot destroy is a plain 202 (removes a recovery
// point only, not live data).
