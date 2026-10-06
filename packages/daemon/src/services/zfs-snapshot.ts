import type { SnapshotSchedule } from '@anas/shared'
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
  /**
   * `-o <prop>=<value>` set on every snapshot the call creates (story ident.1:
   * a scheduled take stamps `anas:schedule=<id>`). ZFS applies the `-o` list
   * to each snapshot of the one atomic verb, `-r` children and every name of
   * a multi-name call included. Snapshot-only: a destroy ignores it.
   */
  properties?: Record<string, string>
}

/** `-o k=v` pairs for a create, in key order (stable argv). */
function propertyArgs(properties?: Record<string, string>): string[] {
  if (!properties)
    return []
  return Object.keys(properties).sort().flatMap(k => ['-o', `${k}=${properties[k]}`])
}

/** `<dataset>@<name>` — the full ZFS snapshot identifier. */
export function zfsSnapshotFullName(dataset: string, name: string): string {
  return `${dataset}@${name}`
}

/** The `zfs snapshot [-r] [-o k=v]… <dataset>@<name>` argv. */
export function createZfsSnapshotArgs(opts: ZfsSnapshotOptions): string[] {
  return ['snapshot', ...(opts.recursive ? ['-r'] : []), ...propertyArgs(opts.properties), zfsSnapshotFullName(opts.dataset, opts.name)]
}

/**
 * The `zfs snapshot <a>@<name> <b>@<name> …` argv (story snapx.1): several
 * snapshots named in ONE invocation. ZFS takes every snapshot named in one
 * call atomically (one transaction group), so a recursive schedule with an
 * exclude list keeps the same consistency guarantee as `-r`.
 */
export function createZfsSnapshotsArgs(datasets: string[], name: string, properties?: Record<string, string>): string[] {
  return ['snapshot', ...propertyArgs(properties), ...datasets.map(ds => zfsSnapshotFullName(ds, name))]
}

/** `zfs list -H -o name -r -t filesystem,volume <dataset>` — the tree a recursive snapshot covers. */
export function zfsTreeListArgs(dataset: string): string[] {
  return ['list', '-H', '-o', 'name', '-r', '-t', 'filesystem,volume', dataset]
}

/** Is `name` the dataset `root` itself or anywhere beneath it? */
export function isAtOrUnder(name: string, root: string): boolean {
  return name === root || name.startsWith(`${root}/`)
}

/**
 * The datasets a recursive snapshot of `target` covers once `exclude` is
 * applied (story snapx.1): `target` first, then every listed strict
 * descendant in listing order, minus each excluded dataset AND its whole
 * subtree. Pure: an exclude entry that names nothing in the list is simply
 * inert (rejecting it is the route's job), and anything in `descendants`
 * outside `target`'s tree is ignored.
 */
export function expandSnapshotTargets(descendants: string[], target: string, exclude: string[]): string[] {
  const out = [target]
  for (const name of descendants) {
    if (name === target || !name.startsWith(`${target}/`))
      continue
    if (exclude.some(ex => isAtOrUnder(name, ex)))
      continue
    out.push(name)
  }
  return out
}

/** What a schedule's sweep depends on — its target, `recursive` and `exclude`. */
export type SweepSchedule = Pick<SnapshotSchedule, 'target' | 'recursive' | 'exclude'>

/**
 * Does `schedule` snapshot `dataset`? (snapprune.1) The schedule's SWEEP, as a
 * predicate: a ZFS schedule covers its target; a recursive one also covers
 * every descendant that is not inside an excluded subtree. An AHR schedule
 * covers no ZFS dataset. Pure — no listing is needed to answer it, which is
 * what lets prune ask it of OTHER schedules' sweeps.
 */
export function inSweep(schedule: SweepSchedule, dataset: string): boolean {
  if (schedule.target.kind !== 'zfs')
    return false
  const target = schedule.target.dataset
  if (dataset === target)
    return true
  if (schedule.recursive !== true || !dataset.startsWith(`${target}/`))
    return false
  return !(schedule.exclude ?? []).some(ex => isAtOrUnder(dataset, ex))
}

/**
 * The datasets a schedule snapshots, given its target's listed tree — the ONE
 * definition the take, the create/run guard and the prune share (snapprune.1).
 * Non-recursive: the target alone. Recursive: {@link expandSnapshotTargets}
 * (target first, excluded subtrees dropped). AHR: none.
 */
export function sweepSet(schedule: SweepSchedule, descendants: string[]): string[] {
  if (schedule.target.kind !== 'zfs')
    return []
  if (schedule.recursive !== true)
    return [schedule.target.dataset]
  return expandSnapshotTargets(descendants, schedule.target.dataset, schedule.exclude ?? [])
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

/**
 * What `zfs destroy <ds>@<snap>` prints when the snapshot is not there
 * (OpenZFS 2.4, verified on the stunt node: "could not find any snapshots to
 * destroy; check snapshot names.").
 */
const SNAPSHOT_GONE_RE = /could not find any snapshots to destroy/i

/**
 * Did a destroy fail only because the snapshot is already gone? Takes the
 * error {@link destroyZfsSnapshot} threw (its message is the stderr).
 */
export function isSnapshotAlreadyGone(err: unknown): boolean {
  return SNAPSHOT_GONE_RE.test(err instanceof Error ? err.message : String(err))
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

/**
 * Take a recursive snapshot of `dataset` that skips the `exclude` subtrees
 * (story snapx.1). With no exclusions this IS {@link createZfsSnapshot} with
 * `recursive: true` — the literal `zfs snapshot -r`, byte-identical argv.
 * Otherwise: list the tree (`zfs list -H -o name -r -t filesystem,volume`),
 * drop the excluded subtrees ({@link expandSnapshotTargets}), and take every
 * remaining snapshot in ONE atomic `zfs snapshot` call. Returns the full
 * snapshot names taken (`-r` reports just the target's, as before).
 */
export async function createZfsSnapshotExcluding(
  executor: CommandExecutor,
  opts: { dataset: string, name: string, exclude: string[], properties?: Record<string, string> },
): Promise<{ snapshots: string[] }> {
  if (opts.exclude.length === 0) {
    const r = await createZfsSnapshot(executor, { dataset: opts.dataset, name: opts.name, recursive: true, properties: opts.properties })
    return { snapshots: [r.snapshot] }
  }
  const listed = await executor.exec(ZFS, zfsTreeListArgs(opts.dataset))
  if (listed.exitCode !== 0)
    throw failure('list', listed)
  const descendants = listed.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const datasets = expandSnapshotTargets(descendants, opts.dataset, opts.exclude)
  const r = await executor.exec(ZFS, createZfsSnapshotsArgs(datasets, opts.name, opts.properties))
  if (r.exitCode !== 0)
    throw failure('snapshot', r)
  return { snapshots: datasets.map(ds => zfsSnapshotFullName(ds, opts.name)) }
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
