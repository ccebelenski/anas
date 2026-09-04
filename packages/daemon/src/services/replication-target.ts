import type { ReplicationTarget } from '@anas/shared'
import type { ResolvedLocation, Transport } from './replication-transport.js'

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
 *  - the story 3.25 PVE-managed exclusion and the replicate-onto-itself check
 *    are LOCAL-ONLY facts: we neither can nor should read a remote's
 *    storage.cfg, and a peer's `backup/media` is a different machine's dataset,
 *    never the source we are reading from.
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
   * Story 3.25 boundary guard: is this LOCAL pool PVE-managed (referenced by
   *  /etc/pve/storage.cfg)? Fail-open (non-PVE host / unreadable config →
   *  false). Only ever asked about a local pool.
   */
  isPveManagedPool: (pool: string) => Promise<boolean>
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

  // Story 3.25: never create datasets on a PVE-managed pool. LOCAL targets only
  // — a remote's storage.cfg is neither readable nor ours to read.
  if (!placement.isRemote && (await deps.isPveManagedPool(target.pool)))
    return { ok: false, message: `Target pool '${target.pool}' is PVE-managed — ANAS does not create datasets there` }

  // Replicating a dataset onto itself is meaningless — again LOCAL only: the
  // same name on a peer is a different machine's dataset.
  if (!placement.isRemote && targetFull === sourceFull)
    return { ok: false, message: `Cannot replicate '${sourceFull}' onto itself — choose a different target dataset` }

  return { ok: true, placement }
}
