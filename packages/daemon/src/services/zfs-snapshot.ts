import type { CommandExecutor, ExecResult } from '../executor/types.js'

/**
 * The ONE place ANAS creates or destroys a ZFS snapshot (extracted for story
 * backup2.3, single-source rule).
 *
 * Before this module the same two-line `zfs snapshot [-r] <ds>@<name>` argv
 * lived in three unrelated files — the datasets route, the snapshot-schedule
 * service, and replication's snapshot-first branch — and backup2.3 was about to
 * make it four. Three copies of an argv is three places for `-r` to be spelled
 * differently; the helper makes the argv a fact with one definition and the
 * callers pass intent (`recursive`) instead of assembling flags.
 *
 * Deliberately thin: it builds argv, execs, and throws the command's own stderr
 * on a non-zero exit. It does NOT decide whether a snapshot should exist, does
 * not check for collisions, and does not name anything — those are the callers'
 * concerns and stay where the policy lives (409-on-exists in the route, the
 * `anas-<bucket>-<utc>` convention in snapshot-naming, the transient prefix in
 * the backup runner).
 */

export const ZFS = '/usr/sbin/zfs'

/** Which snapshot, and whether the verb recurses into child datasets. */
export interface ZfsSnapshotOptions {
  /** The dataset (or volume) the snapshot belongs to, e.g. `tank/media`. */
  dataset: string
  /** The label after the `@`, e.g. `anas-daily-2026-07-26T142301Z`. */
  name: string
  /**
   * `-r`: snapshot / destroy the whole subtree in one atomic-per-pool verb.
   * For a snapshot-consistent backup this is a correctness requirement — a
   * child dataset under the source is its own filesystem, and without `-r` its
   * `.zfs/snapshot/<name>` would simply not exist.
   */
  recursive?: boolean
}

/** `<dataset>@<name>` — the full ZFS snapshot identifier. */
export function zfsSnapshotFullName(dataset: string, name: string): string {
  return `${dataset}@${name}`
}

/** The `zfs snapshot [-r] <dataset>@<name>` argv. */
export function createZfsSnapshotArgs(opts: ZfsSnapshotOptions): string[] {
  return ['snapshot', ...(opts.recursive ? ['-r'] : []), zfsSnapshotFullName(opts.dataset, opts.name)]
}

/** The `zfs destroy [-r] <dataset>@<name>` argv. */
export function destroyZfsSnapshotArgs(opts: ZfsSnapshotOptions): string[] {
  return ['destroy', ...(opts.recursive ? ['-r'] : []), zfsSnapshotFullName(opts.dataset, opts.name)]
}

/**
 * The message a failed `zfs` verb throws: its own stderr when it said anything,
 * else a named exit code. This is the routes' long-standing wording
 * (`zfs snapshot exited with code 1`), kept verbatim so the extraction changes
 * no operator-visible string.
 */
function failure(verb: string, r: ExecResult): Error {
  return new Error(r.stderr.trim() || `zfs ${verb} exited with code ${r.exitCode}`)
}

/** Create one snapshot. Throws the command's stderr on failure. */
export async function createZfsSnapshot(
  executor: CommandExecutor,
  opts: ZfsSnapshotOptions,
): Promise<{ snapshot: string }> {
  const r = await executor.exec(ZFS, createZfsSnapshotArgs(opts))
  if (r.exitCode !== 0)
    throw failure('snapshot', r)
  return { snapshot: zfsSnapshotFullName(opts.dataset, opts.name) }
}

/** Destroy one snapshot. Throws the command's stderr on failure. */
export async function destroyZfsSnapshot(
  executor: CommandExecutor,
  opts: ZfsSnapshotOptions,
): Promise<{ snapshot: string }> {
  const r = await executor.exec(ZFS, destroyZfsSnapshotArgs(opts))
  if (r.exitCode !== 0)
    throw failure('destroy', r)
  return { snapshot: zfsSnapshotFullName(opts.dataset, opts.name) }
}
