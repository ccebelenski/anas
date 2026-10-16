import type { AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { LockClaim } from '../jobs/locks.js'
import { ahrPoolClaims, mountClaim, zfsDatasetClaims } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { readFilesystemFacts, sourceFilesystemOf } from './backup-consistency.js'
import { normalizeMountpointPath } from './mounts.js'

/**
 * The SHARED claims a data mover holds on its source for the run (story
 * cr.33b, docs/WAVE3-DESIGN.md §4.3): "data movers (replication, backup,
 * cloud, restores) hold shared claims on their source for the run, which only
 * exclude a destroy, rollback or rename of that dataset". A destroy, rename or
 * rollback accepted while the run holds them waits in the queue — its progress
 * line names the run — and runs its job-time gates once the run is done,
 * instead of pulling the filesystem out from under a send.
 *
 * The keys are the ones the destructive verbs take, built by the same
 * builders (`safety/guard.ts`), so the two sides cannot drift:
 *  - a ZFS dataset (replication source, snapshot-schedule target, a backup or
 *    cloud path on a dataset, a zvol image source): `zfs:<pool guid>/<path>`
 *    shared, its ancestors and the pool shared, the pool's name key shared —
 *    or, when the pool guid cannot be read, the name key exclusive (§4.2's
 *    fallback, one rule with the dataset verbs);
 *  - an AHR pool (a path on its `@data`): `ahr:<vg uuid>` shared, the name key
 *    shared (or exclusive when the VG UUID is unreadable);
 *  - the mount the path sits on: `mount:<target>` shared, so an unmount,
 *    disable or remove of an fstab mount a backup reads through waits for it.
 *
 * A PATH is resolved to its filesystem the way the backup consistency
 * derivation already does it (`sourceFilesystemOf` beside `deriveConsistency`
 * in backup-consistency.ts: the zvol device form, then the longest mount-table
 * target containing the path) — one resolver, not a second one. A path whose
 * filesystem cannot be identified (unreadable mount table, no row contains it)
 * takes no key; the run says so in its progress line ({@link SourceClaims.unlocked}).
 * The AHR read is the same fail-open (cr.33c F1): when the topology cannot be
 * read, a path on a btrfs mount keeps the mount key — claimed by what it could
 * read — but holds no `ahr:` key, and says so, because it cannot be told
 * whether that btrfs mount is an ANAS pool a destroy might take.
 *
 * What these claims do NOT cover, by design of this story: the filesystems
 * NESTED under a backup source that the run expands into child archives
 * (backup2.2/2.3), a cloud sync crossing into a nested mount, and the
 * descendants a recursive snapshot schedule sweeps — each is its own dataset or
 * mount, and only the root's keys are taken. A recursive destroy of the root
 * still waits (it takes the root exclusive).
 */

/** The claims, and a sentence per source that could not be resolved to a filesystem. */
export interface SourceClaims {
  claims: LockClaim[]
  /** One sentence per source the run holds no key on (empty when every source resolved). */
  unlocked: string[]
}

const POOL_PART_END = /[/@#]/

/** The pool a dataset, snapshot or bookmark name lives in. */
function poolOf(dataset: string): string {
  return dataset.split(POOL_PART_END)[0]
}

/**
 * Read each distinct pool's guid once; null when the read failed — including a
 * read that THREW (a deadline): a run's door must not turn into a 503 over a
 * lock key, so the dataset falls back to the name key, exclusive.
 */
async function poolGuids(executor: CommandExecutor, datasets: readonly string[]): Promise<Map<string, string | null>> {
  const guids = new Map<string, string | null>()
  for (const dataset of datasets) {
    const pool = poolOf(dataset)
    if (guids.has(pool))
      continue
    try {
      guids.set(pool, (await readPoolGuid(executor, pool))?.guid ?? null)
    }
    catch {
      guids.set(pool, null)
    }
  }
  return guids
}

/**
 * The shared claims on ZFS datasets a run reads (a replication source, a
 * snapshot schedule's target): {@link zfsDatasetClaims} per dataset, shared,
 * with the pool guid read now (the guid fallback is the dataset verbs' own).
 */
export async function datasetSourceClaims(executor: CommandExecutor, datasets: readonly string[]): Promise<LockClaim[]> {
  const guids = await poolGuids(executor, datasets)
  return datasets.flatMap(d => zfsDatasetClaims(guids.get(poolOf(d)), d, 'shared'))
}

/** The shared claims on an AHR pool a run reads (a snapshot schedule's AHR target). */
export function ahrSourceClaims(pool: string, vgUuid: string | null | undefined): LockClaim[] {
  return ahrPoolClaims(pool, vgUuid, 'shared')
}

/**
 * The shared claims on the filesystems the source PATHS of a backup or cloud
 * run live on. Reads the mount table and the AHR topology once (fail-open: an
 * unreadable read resolves nothing, and every path is reported unlocked), and
 * each ZFS pool's guid once.
 */
export async function pathSourceClaims(
  executor: CommandExecutor,
  paths: readonly string[],
  readAhrPools: (executor: CommandExecutor) => Promise<AhrPool[]>,
): Promise<SourceClaims> {
  if (paths.length === 0)
    return { claims: [], unlocked: [] }
  const facts = await readFilesystemFacts(executor, readAhrPools)
  const resolved = paths.map(path => ({ path, fs: sourceFilesystemOf(path, facts) }))
  const guids = await poolGuids(executor, resolved.flatMap(r => (r.fs?.kind === 'zfs' ? [r.fs.dataset] : [])))
  const claims: LockClaim[] = []
  const unlocked: string[] = []
  for (const { path, fs } of resolved) {
    if (!fs) {
      unlocked.push(facts.mounts.size === 0
        ? `${path}: no lock on the source - the mount table could not be read, so its filesystem is unknown`
        : `${path}: no lock on the source - no mount table entry contains it, so its filesystem is unknown`)
      continue
    }
    // cr.33c F1: an unreadable AHR topology leaves a btrfs mount unresolved to
    // `other` (its pool cannot be named) — the run keeps the mount key, holds
    // no `ahr:` key, and says so, exactly like the mount-table failure: the
    // btrfs mount might be ANAS's, and an `ahr:` key it should have held would
    // have made a destroy accepted beside the run wait for it.
    if (facts.ahrUnreadable && fs.kind === 'other' && facts.mounts.get(fs.mountpoint)?.fstype === 'btrfs') {
      unlocked.push(`${path}: no lock on the source - the AHR topology could not be read, so it is unknown whether the filesystem is an ANAS AHR pool`)
    }
    if (fs.kind === 'zfs')
      claims.push(...zfsDatasetClaims(guids.get(poolOf(fs.dataset)), fs.dataset, 'shared'))
    else if (fs.kind === 'ahr')
      claims.push(...ahrSourceClaims(fs.pool.name, fs.pool.vg.uuid))
    if (fs.mountpoint !== undefined)
      claims.push(mountClaim(normalizeMountpointPath(fs.mountpoint), 'shared'))
  }
  return { claims, unlocked }
}

/** The progress line a run writes when some source holds no key (null when all do). */
export function unlockedSourcesLine(unlocked: readonly string[]): string | null {
  return unlocked.length ? unlocked.join('; ') : null
}
