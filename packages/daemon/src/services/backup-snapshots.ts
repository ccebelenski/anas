import type { AhrPool, BackupTransientSnapshot } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import { createAhrSnapshot, deleteAhrSnapshot, listAhrSnapshots, topLevelMountPath, withTopLevelMount } from './ahr-snapshots.js'
import { isTransientBackupSnapshot, parseTransientBackupSnapshot } from './snapshot-naming.js'
import { createZfsSnapshot, destroyZfsSnapshot, ZFS, zfsSnapshotFullName } from './zfs-snapshot.js'

/**
 * TRANSIENT SNAPSHOT LIFECYCLE for a snapshot-consistent backup run
 * (story backup2.3).
 *
 * The contract, in full:
 *
 *   - Named `anas-backup-<taskname>-<unix-seconds>` (plus a `__<subvolume>` tail
 *     for AHR's per-subvolume snapshots). The prefix is what makes them
 *     recognisable to their own sweep AND invisible to replication's base
 *     discovery and to schedules retention — see `snapshot-naming.ts`.
 *   - ZFS snapshots are taken **recursively**. A child dataset under the source
 *     is a separate filesystem; without `-r` its `.zfs/snapshot/<s>` would not
 *     exist and the expansion would have nothing to point at.
 *   - AHR takes **one snapshot per subvolume**, because a single read-only btrfs
 *     snapshot leaves every nested subvolume an empty placeholder that no client
 *     flag can rescue (GT-52/55).
 *   - **NO HOLDS.** A `zfs hold` on a transient would survive a crashed daemon
 *     and then block the operator's own `zfs destroy` with nothing in the UI to
 *     explain it. The run destroys what it made; a crash leaves a plainly-named,
 *     destroyable snapshot that the NEXT run of the same task sweeps.
 *   - **Destroyed in a `finally`** — success, failure, or timeout alike — and
 *     recursively, matching how they were taken.
 *   - **A stale sweep runs at every start**, scoped to THIS TASK'S OWN prefix. It
 *     never touches another task's transients (that task may be running right
 *     now) and never touches anything outside the prefix.
 *
 * Every verb here fails OPEN on the destroy side: a snapshot that could not be
 * destroyed is a WARNING on a completed backup, never a failed one. The data is
 * already safe; a leftover snapshot costs space and is nameable.
 */

/** The AHR options the runner threads through (runtime dir, mainly for tests). */
export type BackupSnapshotOptions = AhrSnapshotOptions

/** One transient snapshot the run is responsible for destroying. */
export interface TakenSnapshot extends BackupTransientSnapshot {
  /** AHR only: the resolved pool, so the destroy needs no second lookup. */
  pool?: AhrPool
}

function noop(): void {}

// ---------------------------------------------------------------------------
//  Take
// ---------------------------------------------------------------------------

/**
 * Take the ZFS transient snapshot for one source — always `-r`. The label is
 * the run's, shared by every dataset in the subtree, which is exactly what makes
 * `<child mountpoint>/.zfs/snapshot/<label>` predictable for the expansion.
 */
export async function takeZfsTransient(
  executor: CommandExecutor,
  dataset: string,
  label: string,
): Promise<TakenSnapshot> {
  await createZfsSnapshot(executor, { dataset, name: label, recursive: true })
  return {
    backend: 'zfs',
    name: label,
    target: dataset,
    full: zfsSnapshotFullName(dataset, label),
    recursive: true,
  }
}

/**
 * Take one AHR read-only snapshot. `subvolume` is the `@data`-relative path when
 * this snapshot covers a NESTED subvolume rather than `@data` itself.
 */
export async function takeAhrTransient(
  executor: CommandExecutor,
  pool: AhrPool,
  label: string,
  subvolume: string | undefined,
  updateProgress: (message: string) => void = noop,
  opts?: BackupSnapshotOptions,
): Promise<TakenSnapshot> {
  await createAhrSnapshot(executor, pool, label, updateProgress, {
    ...opts,
    ...(subvolume ? { subvolume } : {}),
  })
  return {
    backend: 'ahr',
    name: label,
    target: pool.name,
    full: `${pool.name}:@snapshots/${label}`,
    pool,
  }
}

// ---------------------------------------------------------------------------
//  Destroy (the `finally`)
// ---------------------------------------------------------------------------

/**
 * Destroy every snapshot the run took, in REVERSE order (children before the
 * recursive parent on AHR). Never throws: each failure becomes one warning line,
 * because a backup that already succeeded must not be reported as failed over a
 * snapshot that outlived it.
 */
export async function destroyTransients(
  executor: CommandExecutor,
  taken: TakenSnapshot[],
  updateProgress: (message: string) => void = noop,
  opts?: BackupSnapshotOptions,
): Promise<string[]> {
  const warnings: string[] = []
  // Reverse order: on AHR the nested-subvolume snapshots were taken after the
  // `@data` one, so they go first. Two steps on an array we own — `toReversed()`
  // is not in this package's TS lib target.
  const order = [...taken]
  order.reverse()
  for (const snap of order) {
    try {
      updateProgress(`destroying transient snapshot ${snap.full}`)
      if (snap.backend === 'zfs') {
        await destroyZfsSnapshot(executor, { dataset: snap.target, name: snap.name, recursive: true })
        continue
      }
      if (!snap.pool)
        throw new Error('the AHR pool for this snapshot is no longer resolvable')
      await deleteAhrSnapshot(executor, snap.pool, snap.name, updateProgress, opts)
    }
    catch (err) {
      warnings.push(
        `the transient backup snapshot ${snap.full} could not be destroyed: ${errText(err)} - `
        + `it is safe to destroy by hand, and the next run of this task sweeps it.`,
      )
    }
  }
  return warnings
}

// ---------------------------------------------------------------------------
//  Stale sweep (every run start)
// ---------------------------------------------------------------------------

/** `zfs list` argv for a dataset's own snapshot labels (direct, machine-parsable). */
export function zfsTransientListArgs(dataset: string): string[] {
  return ['list', '-t', 'snapshot', '-Hp', '-o', 'name', '-r', dataset]
}

/**
 * Which of `names` this run must sweep: transients of THIS task that are older
 * than this run's own label. Pure, so the scoping rule is directly testable.
 *
 * Two guards, both load-bearing:
 *   - the parsed task must equal `task` — another task's transient may belong to
 *     a run that is happening RIGHT NOW;
 *   - the timestamp must be strictly older than `before` — never this run's own
 *     snapshots, which are about to be used.
 * A name that carries the prefix but does not parse is left alone: it is
 * recognisably ours (so nothing else will prune it) but we cannot prove whose,
 * and a sweep is not the place to guess.
 */
export function staleTransients(names: string[], task: string, before: Date): string[] {
  const cutoff = before.getTime()
  return names.filter((name) => {
    const parsed = parseTransientBackupSnapshot(name)
    return parsed !== null && parsed.task === task && parsed.at.getTime() < cutoff
  })
}

/**
 * Sweep this task's stale ZFS transients on `dataset`. Recursive destroy, to
 * match how they were taken. Fails open — a sweep problem is a warning, never a
 * reason not to run the backup.
 */
export async function sweepZfsTransients(
  executor: CommandExecutor,
  dataset: string,
  task: string,
  before: Date,
  updateProgress: (message: string) => void = noop,
): Promise<string[]> {
  const warnings: string[] = []
  let labels: string[] = []
  try {
    const r = await executor.exec(ZFS, zfsTransientListArgs(dataset))
    if (r.exitCode !== 0)
      return warnings
    labels = r.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith(`${dataset}@`))
      .map(l => l.slice(dataset.length + 1))
  }
  catch {
    return warnings
  }
  for (const label of staleTransients(labels, task, before)) {
    try {
      updateProgress(`sweeping stale transient snapshot ${zfsSnapshotFullName(dataset, label)}`)
      await destroyZfsSnapshot(executor, { dataset, name: label, recursive: true })
    }
    catch (err) {
      warnings.push(`stale transient snapshot ${zfsSnapshotFullName(dataset, label)} could not be swept: ${errText(err)}`)
    }
  }
  return warnings
}

/** Sweep this task's stale AHR transients under `@snapshots`. Fails open. */
export async function sweepAhrTransients(
  executor: CommandExecutor,
  pool: AhrPool,
  task: string,
  before: Date,
  updateProgress: (message: string) => void = noop,
  opts?: BackupSnapshotOptions,
): Promise<string[]> {
  const warnings: string[] = []
  let names: string[] = []
  try {
    names = (await listAhrSnapshots(executor, pool, opts)).map(s => s.name)
  }
  catch {
    return warnings
  }
  for (const name of staleTransients(names, task, before)) {
    try {
      updateProgress(`sweeping stale transient snapshot ${pool.name}:@snapshots/${name}`)
      await deleteAhrSnapshot(executor, pool, name, updateProgress, opts)
    }
    catch (err) {
      warnings.push(`stale transient snapshot ${pool.name}:@snapshots/${name} could not be swept: ${errText(err)}`)
    }
  }
  return warnings
}

// ---------------------------------------------------------------------------
//  Holding several AHR top-level mounts open across one pbc invocation
// ---------------------------------------------------------------------------

/**
 * `@snapshots` lives OUTSIDE the mounted `@data` tree, so an AHR archive root is
 * only reachable while the pool's filesystem is mounted TOP-LEVEL. One pbc call
 * covers every archive of a task, so every AHR pool involved must be mounted at
 * once — this folds {@link withTopLevelMount} over the pools and tears every one
 * of them down on the way out, in the exact reverse order.
 *
 * ⚠ Nothing that itself calls `withTopLevelMount` for the same pool may run
 * inside `fn`: that helper serialises per mount path, so a nested call for the
 * same pool would wait on the outer one and deadlock. That is why the run takes
 * ALL its snapshots first and destroys them after, never inside.
 */
export async function withTopLevelMounts<T>(
  executor: CommandExecutor,
  pools: AhrPool[],
  fn: (byPool: Map<string, string>) => Promise<T>,
  opts?: BackupSnapshotOptions,
): Promise<T> {
  const byPool = new Map<string, string>()
  const step = async (index: number): Promise<T> => {
    if (index >= pools.length)
      return fn(byPool)
    return withTopLevelMount(executor, pools[index], async (top) => {
      byPool.set(pools[index].name, top)
      return step(index + 1)
    }, opts)
  }
  return step(0)
}

/**
 * Where an AHR pool's top-level mount WILL be, computed before anything is
 * mounted. The path is deterministic (`<runtime dir>/<pool>.toplevel`), which is
 * what lets the expansion plan — and therefore the whole argv — be built and
 * asserted before a single mount happens.
 */
export function plannedTopLevel(pool: AhrPool, opts?: BackupSnapshotOptions): string {
  return topLevelMountPath(pool, opts)
}

/** Is this a transient backup snapshot? Re-exported so callers need one import. */
export { isTransientBackupSnapshot }

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
