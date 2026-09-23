import type { ReplicationTarget } from '@anas/shared'
import type { PveFootprint } from './pve-footprint.js'
import type { ResolvedLocation, Transport } from './replication-transport.js'
import { pveNamingGuardMessage } from './pve-footprint.js'

/**
 * WHERE a replication target lives, and whether it may be written to.
 *
 * This is the ONE implementation of the target-side guards (Epic 5.5). It used
 * to exist twice: once in the one-shot `…/replicate` handler, which learned
 * about peers and remotes in stage 3, and once — copied from stage 1 and never
 * updated — in the recurring-task routes, which kept judging EVERY target
 * against this node's own `zpool list`. A task pointed at a peer's pool was
 * rejected with a 400 saying the pool does not exist, because it does not exist
 * HERE (issue #46). Both callers now share this module, so the two paths cannot
 * drift apart again.
 *
 * The rules, in order:
 *  - the location must RESOLVE (a peer must be a known cluster node, a remote
 *    must be registered) — an unresolvable one is the caller's 400;
 *  - the target POOL must exist where the target actually lives: locally via
 *    `zpool list`, on a peer/remote via `ssh zpool list`;
 *  - the PVE footprint exclusion (pvepool.1 — the TARGET DATASET is judged, not
 *    the pool) and the replicate-onto-itself check are LOCAL-ONLY facts: we
 *    neither can nor should read a remote's storage.cfg, and a peer's
 *    `backup/media` is a different machine's dataset, never the source we are
 *    reading from.
 */

/** A target that lives on this node, or on a resolved peer/remote. */
export type TargetPlacement
  = | { isRemote: false }
    | { isRemote: true, resolved: ResolvedLocation }

export type PlacementResult
  = | { ok: true, placement: TargetPlacement }
    | { ok: false, error: string }

/**
 * Resolve where the target pool lives. An absent location (or `local`) is this
 * node; a peer/remote is looked up through the transport (members file /
 * registry) and an unresolvable one is a 400-worthy error.
 */
export async function resolveTargetPlacement(
  transport: Transport,
  target: ReplicationTarget,
): Promise<PlacementResult> {
  const kind = target.location?.kind ?? 'local'
  if (kind === 'local')
    return { ok: true, placement: { isRemote: false } }
  const res = await transport.resolveLocation(target.location!)
  if (!res.ok)
    return { ok: false, error: res.error }
  return { ok: true, placement: { isRemote: true, resolved: res.resolved } }
}

/** Does the target pool exist — locally (`zpool list`) or on the peer/remote (`ssh zpool list`)? */
export async function targetPoolExists(
  transport: Transport,
  placement: TargetPlacement,
  pool: string,
  localPoolExists: (pool: string) => Promise<boolean>,
): Promise<boolean> {
  return placement.isRemote
    ? transport.remotePoolExists(placement.resolved, pool)
    : localPoolExists(pool)
}

export interface TargetGuardDeps {
  /** Stage-3 SSH transport — location resolution + remote `zpool list`. */
  transport: Transport
  /** Does this pool exist on THIS node (`zpool list`)? */
  poolExists: (pool: string) => Promise<boolean>
  /**
   * PVE footprint ownership (story pvepool.1): the ONE service that answers
   * "is this dataset PVE's?", loaded fresh per guard run. Only consulted for a
   * LOCAL target — a remote's storage.cfg is neither readable nor ours to read.
   */
  pveFootprint: () => Promise<PveFootprint>
  /**
   * A footprint the caller ALREADY loaded (pvepool.1 review fix 4) — consulted
   * in place of `pveFootprint()` so one request loads the footprint exactly
   * once: the snapshotFirst run shares its source check's load with this
   * guard. Absent → the loader is used as before (plan, recurring tasks).
   */
  pveFootprintPreloaded?: PveFootprint
}

export interface TargetGuardInput {
  target: ReplicationTarget
  /** The full source dataset name (always local). */
  sourceFull: string
  /** The resolved full target dataset name (pool + relative path). */
  targetFull: string
}

export type TargetGuardResult
  = | { ok: true, placement: TargetPlacement }
    | { ok: false, message: string }

/**
 * Run every target-side guard in the context of the target's own LOCATION.
 * Returns the resolved placement on success (callers need it to talk to the
 * remote), or the exact 400 message on the first failure.
 */
export async function guardReplicationTarget(
  deps: TargetGuardDeps,
  input: TargetGuardInput,
): Promise<TargetGuardResult> {
  const { target, sourceFull, targetFull } = input
  const placed = await resolveTargetPlacement(deps.transport, target)
  if (!placed.ok)
    return { ok: false, message: placed.error }
  const { placement } = placed

  // We replicate INTO an existing pool, never create one — and "existing" is
  // asked of the machine the target lives on, not of this one.
  if (!(await targetPoolExists(deps.transport, placement, target.pool, deps.poolExists))) {
    const where = placement.isRemote ? ` on ${target.location?.kind} '${target.location?.name}'` : ''
    return { ok: false, message: `Target pool '${target.pool}' does not exist${where}` }
  }

  // PVE footprint ownership (story pvepool.1): never write into PVE's
  // territory — but ONLY the dataset itself is judged, not the pool. A target
  // dataset PVE owns (a storage root, a guest volume, a dir-storage tree, the
  // boot tree) is refused with the predicate's reason; a target whose NAME
  // PVE would inventory as a guest disk on its next scan trips the naming
  // guard. A sibling dataset on a PVE pool is a legitimate target. LOCAL
  // targets only — a remote's storage.cfg is neither readable nor ours to read.
  if (!placement.isRemote) {
    // pvepool.1 review fix 4: a caller that already loaded the footprint for
    // its own pre-job check passes it in — one load per request, not one per
    // guard.
    const pve = deps.pveFootprintPreloaded ?? await deps.pveFootprint()
    const owned = pve.ownershipOf(targetFull)
    if (owned)
      return { ok: false, message: `Replication target '${targetFull}' is PVE-owned — ${owned.reason}` }
    const claim = pve.claimedByPve(targetFull)
    if (claim)
      return { ok: false, message: pveNamingGuardMessage(claim.storage, targetFull) }
  }

  // Replicating a dataset onto itself is meaningless — again LOCAL only: the
  // same name on a peer is a different machine's dataset.
  if (!placement.isRemote && targetFull === sourceFull)
    return { ok: false, message: `Cannot replicate '${sourceFull}' onto itself — choose a different target dataset` }

  return { ok: true, placement }
}
