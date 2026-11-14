import type { PveOwnership, ReplicationTarget, ReplicationTargetDrift } from '@anas/shared'
import type { PveFootprint } from './pve-footprint.js'
import type { BaseHeld, RecordedDrift, TargetStateRead, ZfsRunner } from './replication-drift.js'
import type { TargetGuardDeps } from './replication-target.js'
import type { TreeDriftCheck, TreeFacts, TreePlan } from './replication-tree.js'
import { excludeShapeIssue, SnapshotName } from '@anas/shared'
import { pveRecursiveRefusalMessage } from './pve-footprint.js'
import { judgeTargetState, readTargetState, recordOf } from './replication-drift.js'
import { guardReplicationTarget, memoisePoolExists } from './replication-target.js'
import { planTreeReplication, treeDriftChecks, treeTargetName } from './replication-tree.js'
import { sweepSet } from './zfs-snapshot.js'

/**
 * The gates AROUND the recursive planner (rrep.1b, #84, R5):
 *
 *  a. the request's excludes — the shared shape rule refuses; an entry
 *     that is not in the source tree is INERT (rrep.2 fold E1, ruled:
 *     parallel construction with a snapshot schedule's runner — the dataset
 *     is not there, so nothing unintended can be replicated; a typo is
 *     caught where the list is entered, at the task door) and is reported
 *     back as `excludeMissing`, a note, never a refusal;
 *  b. R5a — no swept dataset is PVE-owned, on a footprint the CALLER loaded
 *     fresh (nothing here loads its own: the route and the job each load one
 *     and pass it in, ruling (j));
 *  c. the pure planner ({@link planTreeReplication}), whose refusals pass
 *     through verbatim — and every snapshot name its plan carries must pass
 *     the shared `SnapshotName` schema, before anything is held or sent;
 *  d. R5b's local half — every target name this run TOUCHES (planned receives
 *     and up-to-date copies alike) is judged by the ONE target guard, with that
 *     dataset's own source and target names. A remote target skips this (its
 *     storage.cfg is neither readable nor ours).
 *
 * `a` and `b` refuse BEFORE the planner is consulted: a run whose sweep is
 * PVE's territory must not have its listing reasoned over at all. The result
 * carries the sweep the route locks (R9) so "what this run covers" stays one
 * definition (the schedule's {@link sweepSet}).
 */

export interface TreeGateRefusal {
  message: string
  /**
   * The PVE verdict behind an ownership refusal — the route answers it through
   * `ownershipRefusal` (409 PVE_MANAGED, or 400 when the config is unreadable),
   * exactly as the single-dataset door does. Absent for every other sentence.
   */
  ownership?: PveOwnership
}

/** A passed gate: the plan, the sweep the route locks, and the inert excludes. */
export interface TreeGatePass {
  ok: true
  plan: Extract<TreePlan, { ok: true }>
  sweep: string[]
  /**
   * The exclude entries the source tree does not hold (fold E1): inert, in
   * the request's order; `[]` when every entry names a live dataset.
   */
  excludeMissing: string[]
  /** repl.drift: the `exposed` sentences — the run sends and warns with each. */
  driftWarnings: string[]
  /** repl.drift: the `unknown` sentences — the run sends and notes each. */
  driftNotes: string[]
  /** repl.drift: what the run records about its changed or writable copies. */
  driftRecords: RecordedDrift[]
}

export type TreeGateResult
  = | TreeGatePass
    | {
      ok: false
      refusals: TreeGateRefusal[]
      /** repl.drift: set when the refusals are the drift's (changed copies) — the run records them. */
      driftRecords?: RecordedDrift[]
    }

export interface TreeGateDeps {
  /** The footprint the caller loaded FRESH for this pass. */
  pve: PveFootprint
  /** The target-side guard deps (services/replication-target.ts). */
  guard: TargetGuardDeps
  /**
   * repl.drift: how a copy's own `written@<base>,readonly` and the holds of
   * its base are read. Absent, the drift is not judged in this pass (the
   * route's pass at the request: the job judges it, so a changed copy fails
   * the JOB, which records it for the dashboard).
   */
  drift?: TreeDriftDeps
}

export interface TreeDriftDeps {
  /** `zfs <args>` where the target lives. */
  runTarget: ZfsRunner
  /** ` on <kind> '<name>'`, or '' for this node. */
  where: string
  /** Whether `@base` carries the run's hold on each side. */
  readHeld: (dataset: string, target: string, base: string) => Promise<BaseHeld>
}

/**
 * repl.drift: every existing copy judged against its base — `modified`
 * refuses the run (ZFS would refuse that receive), `exposed` and `unknown`
 * let it go ahead with a warning or a note. A copy whose newest snapshot is
 * its base is judged from the tree read alone.
 */
async function judgeTreeDrift(deps: TreeDriftDeps | undefined, checks: TreeDriftCheck[]): Promise<{ refusals: string[], warnings: string[], notes: string[], records: RecordedDrift[], drifts: ReplicationTargetDrift[] }> {
  const out = { refusals: [] as string[], warnings: [] as string[], notes: [] as string[], records: [] as RecordedDrift[], drifts: [] as ReplicationTargetDrift[] }
  if (deps === undefined)
    return out
  for (const check of checks) {
    let read: TargetStateRead
    if (check.known)
      read = { ok: true, written: check.known.written, readonly: check.known.readonly }
    else
      read = await readTargetState(deps.runTarget, check.target, check.base)
    const drift = await judgeTargetState(read, {
      target: check.target,
      where: deps.where,
      base: check.base,
      targetSnaps: check.targetSnaps,
      sends: check.sends,
      readHeld: () => deps.readHeld(check.dataset, check.target, check.base),
    })
    out.drifts.push(drift)
    const record = recordOf(drift, { sealed: check.sends })
    if (record)
      out.records.push(record)
    if (drift.state === 'modified')
      out.refusals.push(drift.message!)
    else if (drift.state === 'exposed')
      out.warnings.push(drift.message!)
    else if (drift.state === 'unknown')
      out.notes.push(drift.message!)
  }
  return out
}

/**
 * repl.drift P1: the RUN's per-copy judgement, asked by a READ (a recursive
 * task's status and the daily check), so a changed child is seen where the
 * run would see it — the same planner, the same checks, the same judge, no
 * second implementation. Nothing is received by a read, so no copy is judged
 * as one this run seals (`sends: false`). Not ok when the tree cannot be
 * planned (a malformed exclude list, or a plan the run would refuse): the
 * refusals are the run's own sentences, and the caller says the copies could
 * not be checked (review 2, defect 1: a read that could not see never says
 * clean).
 */
export async function judgeTreeTargets(deps: TreeDriftDeps, facts: TreeFacts): Promise<{ ok: true, drifts: ReplicationTargetDrift[] } | { ok: false, refusals: string[] }> {
  const shape = excludeShapeIssue(facts.sourceRoot, true, facts.exclude, 'replication')
  if (shape)
    return { ok: false, refusals: [shape] }
  // The planner sees only the LIVE excludes (gate step c's rule).
  const liveExclude = facts.exclude.filter(name => facts.sourceTree.includes(name))
  const plan = planTreeReplication(liveExclude.length === facts.exclude.length ? facts : { ...facts, exclude: liveExclude })
  if (!plan.ok)
    return { ok: false, refusals: plan.refusals }
  const checks = treeDriftChecks(facts, plan).map(c => ({ ...c, sends: false }))
  return { ok: true, drifts: (await judgeTreeDrift(deps, checks)).drifts }
}

/**
 * R5a's sentence, stated once: the ownership reason plus the two ways out.
 * Exported for the TASK's create/update gate (rrep.2), which refuses an
 * owned sweep member with the very sentence the run refuses it with.
 */
export function ownedMessage(sourceRoot: string, hit: { name: string, ownership: PveOwnership }): string {
  return `${pveRecursiveRefusalMessage('Recursive replication', sourceRoot, hit)} — exclude it, or replicate a dataset below it`
}

/**
 * The sentence for a snapshot name outside the shared SnapshotName pattern
 * (fold 3, review H): legal to ZFS, poison to the run — the hold/send/recv
 * verbs reach a remote shell, which splits `ds@nightly 2` into two arguments.
 */
function snapshotNameUnusableMessage(name: string, sourceRoot: string): string {
  return `Snapshot '${name}' has a name ANAS does not pass to a remote command (a space or another character outside letters, digits and _ - . :) — rename it with 'zfs rename', or take a new recursive snapshot of '${sourceRoot}'`
}

/**
 * Run gates a–d over already-read facts. Async only for gate d's per-target
 * guard; every decision is the caller's footprint and the pure planner.
 */
export async function gateTreeRun(
  deps: TreeGateDeps,
  input: { facts: TreeFacts, target: ReplicationTarget },
): Promise<TreeGateResult> {
  const { facts, target } = input
  const sourceRoot = facts.sourceRoot
  const refusals: TreeGateRefusal[] = []

  // a. The request's excludes: the shared shape rule refuses (a list with a
  //    non-child entry is malformed). An entry the source tree does not hold
  //    is INERT (fold E1): the sweep below already ignores it, and the run
  //    reports it as a note. Existence is the task door's question, asked
  //    where the list is entered ("unless already stored", R10).
  const shape = excludeShapeIssue(sourceRoot, true, facts.exclude, 'replication')
  if (shape)
    refusals.push({ message: shape })
  const excludeMissing = shape ? [] : facts.exclude.filter(name => !facts.sourceTree.includes(name))

  // b. R5a: PVE owns nothing this run would write. The root itself is checked
  //    beside the sweep (ownedDescendant only walks strict descendants).
  const rootOwned = deps.pve.ownershipOf(sourceRoot)
  if (rootOwned)
    refusals.push({ message: ownedMessage(sourceRoot, { name: sourceRoot, ownership: rootOwned }), ownership: rootOwned })
  const sweep = sweepSet({ target: { kind: 'zfs', dataset: sourceRoot }, recursive: true, exclude: facts.exclude }, facts.sourceTree)
  const ownedHit = deps.pve.ownedDescendant(sweep, sourceRoot)
  if (ownedHit)
    refusals.push({ message: ownedMessage(sourceRoot, ownedHit), ownership: ownedHit.ownership })

  if (refusals.length > 0)
    return { ok: false, refusals }

  // c. The planner decides everything else; its own refusals pass through.
  // The planner sees only the LIVE excludes. A vanished entry is inert for the
  // sweep either way, but placement (rule 5) EXCUSES a local target that sits
  // under an excluded dataset: an exclude that no longer exists must not
  // excuse a target inside the source tree (found while folding E1 — such a
  // run reached the first receive and failed there).
  const liveExclude = facts.exclude.filter(name => !excludeMissing.includes(name))
  const plan = planTreeReplication(liveExclude.length === facts.exclude.length ? facts : { ...facts, exclude: liveExclude })
  if (!plan.ok)
    return { ok: false, refusals: plan.refusals.map(message => ({ message })) }
  // repl.drift: every copy this run receives into or finds up to date is
  // judged against its base before anything is held or sent. A changed copy
  // refuses the run (ZFS would refuse its receive); its sentence names it.
  const drift = await judgeTreeDrift(deps.drift, treeDriftChecks(facts, plan))
  if (drift.refusals.length > 0)
    return { ok: false, refusals: drift.refusals.map(message => ({ message })), driftRecords: drift.records.filter(r => r.state === 'modified') }

  // c2. The names the plan will put into send/hold/recv argv must pass the
  //     shared SnapshotName schema (fold 3, review H): ZFS accepts a space in
  //     a snapshot name, the remote shell does not — `zfs hold -- <tag>
  //     ds@nightly 2` splits into a hold of 'ds@nightly' plus a stray '2'.
  //     Asked before gate d, before anything is held or sent, local or remote
  //     alike. One refusal per offending NAME (a shared base is one sentence).
  const unusableNames = new Set<string>()
  if (!SnapshotName.safeParse(plan.snapshot).success)
    unusableNames.add(plan.snapshot)
  for (const planned of plan.datasets) {
    if (planned.baseSnapshot !== undefined && !SnapshotName.safeParse(planned.baseSnapshot).success)
      unusableNames.add(planned.baseSnapshot)
  }
  if (unusableNames.size > 0) {
    for (const name of unusableNames)
      refusals.push({ message: snapshotNameUnusableMessage(name, sourceRoot) })
    return { ok: false, refusals }
  }

  // d. R5b's local half, per target name this run TOUCHES: every planned
  //    receive AND every up-to-date copy — the job places its holds on an
  //    up-to-date copy's TARGET snapshot too, so an owned target there is the
  //    same violation (fold 2, review I2). Skipped datasets are never written
  //    or held, so they are not judged. The footprint the caller loaded is
  //    handed to the guard, so this pass adds no second load.
  if (facts.localTarget) {
    // Fold P2: the target pool's existence is asked ONCE for this pass,
    // not once per touched dataset.
    const guardDeps: TargetGuardDeps = memoisePoolExists({ ...deps.guard, pveFootprintPreloaded: deps.pve })
    const touched = [
      ...plan.datasets.map(d => ({ sourceFull: d.dataset, targetFull: d.target })),
      ...plan.upToDate.map(dataset => ({
        sourceFull: dataset,
        targetFull: treeTargetName(facts.sourceRoot, facts.targetRoot, dataset),
      })),
    ]
    for (const { sourceFull, targetFull } of touched) {
      const guard = await guardReplicationTarget(guardDeps, { target, sourceFull, targetFull })
      if (!guard.ok)
        refusals.push({ message: guard.message })
    }
    if (refusals.length > 0)
      return { ok: false, refusals }
  }

  return { ok: true, plan, sweep, excludeMissing, driftWarnings: drift.warnings, driftNotes: drift.notes, driftRecords: drift.records }
}
