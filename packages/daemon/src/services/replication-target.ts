import type { ReplicationTarget } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { PveFootprint } from './pve-footprint.js'
import type { PoolExistence, ResolvedLocation, Transport } from './replication-transport.js'
import { execZpool, parseZpoolList, zfsUnavailableReason } from '../parsers/zpool-list.js'
import { pveNamingGuardMessage } from './pve-footprint.js'

/** C0 control characters and DEL: a quoted failure line carries none. */
// eslint-disable-next-line no-control-regex
const LOCAL_FAILURE_CONTROL_RE = /[\x00-\x1F\x7F]/g

/** `zpool list`'s legacy answer on a node with no pools (non-zero exit). */
const NO_POOLS_AVAILABLE = 'no pools available'

/** The longest failure line a sentence carries (repl.r2's cut). */
const LOCAL_FAILURE_LINE_MAX = 300

/** The first non-empty stderr line of a failed local command, or its exit status. */
function localFailureLine(r: ExecResult, command: string): string {
  const line = r.stderr.split('\n').map(l => l.replace(LOCAL_FAILURE_CONTROL_RE, ' ').trim()).find(Boolean)
  if (line === undefined)
    return `${command} exited ${r.exitCode}`
  return line.length > LOCAL_FAILURE_LINE_MAX ? `${line.slice(0, LOCAL_FAILURE_LINE_MAX)}...` : line
}

/**
 * Does `pool` exist on THIS node — three-valued, as the remote probe has been
 * since repl.r2 (cr3: "a read that failed never reads as absent"). Exit 0 is
 * the node's answer (no output = no pools); a non-zero exit, a thrown spawn or
 * an answer the parser refuses is `{ ok: false }` with the first line of
 * stderr, and the guard says "Could not list the pools on this node: <line>",
 * never "Target pool '<pool>' does not exist". Before, the routes' local
 * probes read a failing `zpool list` as "no pools".
 */
export async function readLocalPoolExistence(executor: CommandExecutor, pool: string): Promise<PoolExistence> {
  let r: ExecResult
  try {
    // cr3.followup: through the wave's one reader, so a node without ZFS
    // (no zpool, or the module absent) is told apart from a failed read.
    r = await execZpool(executor, ['list', '-j'])
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const zfsMissing = zfsUnavailableReason(r)
  if (zfsMissing)
    return { ok: true, exists: false, zfsUnavailable: zfsMissing }
  // The legacy shape of "this node has no pools" (older `zpool list`): a
  // non-zero exit whose whole stderr is exactly `no pools available`. It is
  // the node's answer, not a failure (review 2 of cr3; OpenZFS 2.4's `-j`
  // exits 0 with nothing on stdout instead, read below).
  if (r.exitCode !== 0 && r.stderr.trim() === NO_POOLS_AVAILABLE)
    return { ok: true, exists: false }
  if (r.exitCode !== 0)
    return { ok: false, error: localFailureLine(r, 'zpool list') }
  if (!r.stdout.trim())
    return { ok: true, exists: false }
  try {
    return { ok: true, exists: parseZpoolList(r.stdout).some(p => p.name === pool) }
  }
  catch (err) {
    return { ok: false, error: `unreadable zpool list output: ${err instanceof Error ? err.message : String(err)}` }
  }
}

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

/**
 * Does the target pool exist — locally (`zpool list`) or on the peer/remote
 * (`ssh zpool list`)? The answer is three-valued (repl.r2): the remote can say
 * "yes", "no", or "I did not answer" with the ssh failure's own line, and the
 * guard must keep the third apart from the second. The LOCAL probe answers
 * the same three values ({@link readLocalPoolExistence}, cr3): a failing local
 * `zpool list` is "could not list", never "no pool".
 */
export async function targetPoolExists(
  transport: Transport,
  placement: TargetPlacement,
  pool: string,
  localPoolExists: (pool: string) => Promise<PoolExistence>,
): Promise<PoolExistence> {
  return placement.isRemote
    ? transport.remotePoolExists(placement.resolved, pool)
    : localPoolExists(pool)
}

export interface TargetGuardDeps {
  /** Stage-3 SSH transport — location resolution + remote `zpool list`. */
  transport: Transport
  /**
   * Does this pool exist on THIS node (`zpool list`)? `{ ok: true, exists }`
   * is the node's answer; `{ ok: false, error }` is a probe that could not
   * answer — the remote transport since repl.r2, the local read
   * ({@link readLocalPoolExistence}) since cr3 — and is never "absent".
   */
  poolExists: (pool: string) => Promise<PoolExistence>
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

/**
 * The guard deps for ONE gate pass over many target names (rrep.2 fold P2):
 * `poolExists` is asked at most once per pool name for the lifetime of the
 * returned deps, so a recursive pass over a tree of N datasets reads
 * `zpool list` once, not N times. The ANSWER is shared, failure included —
 * a read that said "no" (or threw) refuses every dataset of the pass, as it
 * refused the first (fail-closed) — and a probe that DID NOT ANSWER
 * (repl.r2) is stored as that answer, never retried into a different one and
 * never turned into "does not exist". Make a fresh one per pass: a memo kept
 * across requests would be a cached fact.
 */
export function memoisePoolExists(deps: TargetGuardDeps): TargetGuardDeps {
  const asked = new Map<string, Promise<PoolExistence>>()
  return {
    ...deps,
    poolExists: (pool: string) => {
      let answer = asked.get(pool)
      if (answer === undefined) {
        answer = deps.poolExists(pool)
        asked.set(pool, answer)
      }
      return answer
    },
  }
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
  const where = placement.isRemote ? ` on ${target.location?.kind} '${target.location?.name}'` : ''
  const pool = await targetPoolExists(deps.transport, placement, target.pool, deps.poolExists)
  if (!pool.ok) {
    // repl.r2: a peer/remote that did not answer is NOT a missing pool. The
    // refusal carries what its ssh said, so the operator is sent to the remote
    // (its key, its sshd) rather than to look for a pool that is there.
    // cr3: the local twin says where too — "on this node".
    return { ok: false, message: `Could not list the pools${where || ' on this node'}: ${pool.error}` }
  }
  if (!pool.exists)
    return { ok: false, message: `Target pool '${target.pool}' does not exist${where}${pool.zfsUnavailable ? `: ${pool.zfsUnavailable}` : ''}` }

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
