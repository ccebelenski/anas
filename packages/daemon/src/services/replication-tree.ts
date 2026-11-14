import { DatasetPath } from '@anas/shared'
import { isTransientRunSnapshot } from './snapshot-naming.js'
import { isAtOrUnder, sweepSet } from './zfs-snapshot.js'

/**
 * The pure planner of recursive replication (rrep.1a, #84): captured tree
 * listings in, a per-dataset send plan or a full list of refusals out. No
 * executor, no fs, no clock — every listing in {@link TreeFacts} was ALREADY
 * READ by the caller (parsers/zfs-tree.ts, after an exit-code check), so this
 * function never sees a failed read and never guesses at one. The one thing it
 * cannot see from a listing alone is a ROW that should be there: a swept
 * dataset missing its `keystatus` row, or a planned target missing its
 * `written` row, is a refusal (`Could not read ...`, see
 * {@link unreadableRow}), never a silent "unencrypted" or "0" — the same rule
 * the parsers hold for unreadable lines.
 *
 * EPICS rrep.1 rules R2 (one sweep — the SAME {@link sweepSet} the snapshot
 * schedules use), R4 (one snapshot name S across the tree), R5b–g (names,
 * placement, keys, per-dataset base), R8 (target-only datasets listed, never
 * destroyed). R0/R3/R10/R12 are the schema's and the run branch's.
 */

export interface TreeFacts {
  sourceRoot: string
  targetRoot: string
  exclude: string[]
  /** true when the target is on this node (placement rule R5c applies). */
  localTarget: boolean
  sourceTree: string[]
  /** dataset -> snapshot names, NEWEST FIRST (parsers/zfs-tree.ts). */
  sourceSnaps: Map<string, string[]>
  /** dataset -> property -> value; the planner reads `keystatus`. */
  sourceProps: Map<string, Record<string, string>>
  /** [] when the target root does not exist. */
  targetTree: string[]
  targetSnaps: Map<string, string[]>
  /** the planner reads `written` (R5g). */
  targetProps: Map<string, Record<string, string>>
}

export interface PlannedDataset {
  dataset: string
  target: string
  mode: 'full' | 'incremental'
  baseSnapshot?: string
}

export interface SkippedDataset {
  dataset: string
  message: string
}

export type TreePlan
  = | {
    ok: true
    snapshot: string
    datasets: PlannedDataset[]
    skipped: SkippedDataset[]
    targetOnly: string[]
    /**
     * Swept datasets whose copy is ALREADY at S (target has S, unmodified, and
     * no newer common base — there is nothing to send). Listed, not planned,
     * not refused. Added for rrep.1a (the brief left it open, leaning yes):
     * the operator whose nightly run says "9 datasets, 0 sent" must be able
     * to see the 9 that needed nothing, or "nothing to do" and "nothing
     * happened" are the same screen. SOURCE dataset names, like `skipped`.
     */
    upToDate: string[]
    /**
     * Of `upToDate`, the copies whose holds are left as they are (review of
     * cr3, {@link decideBase} rule 1): the target's newest snapshot is a
     * backup/cloud transient the source still has, and the next send starts
     * from it. Absent when there is none.
     */
    holdsKept?: string[]
  }
  | { ok: false, refusals: string[] }

/** The refusal for a row the caller's own listing should have contained. */
function unreadableRow(prop: string, dataset: string): string {
  return `Could not read '${prop}' of '${dataset}' — refusing the recursive replication`
}

/**
 * What ONE existing target copy needs to receive S — the ONE rule the
 * single-dataset run (`discover`, routes/replication.ts) and the recursive
 * planner below both ask (review of cr3: they must agree). Both lists are
 * NEWEST FIRST in the order ZFS took the snapshots in (createtxg): the
 * source's, and the target's OWN order. ZFS (no `-F`, which ANAS never
 * passes) receives `-i @B` when @B is on the target and the target is
 * unmodified since its newest snapshot, whose content then equals @B's
 * (fixtures/zfs/replication-tree/README.md: a replica holding a
 * destination-only snapshot received its incremental). Where the target
 * HAS changed, ZFS's own refusal arbitrates and the run's failure sentence
 * names the rollback ({@link modifiedTargetHint}).
 *
 *   1. The target has S (any name, transient or not) → up to date. The
 *      newest NON-transient snapshot both have that is newer than S, if any,
 *      is `newerCommon` (the chain's base is already past S: no hold moves).
 *      `keepHolds` when the target's newest snapshot is a backup/cloud
 *      transient the source still has, newer than S: the NEXT snapshot is
 *      sent from it (rule 2), so the holds are left as they are (an older
 *      build may have held that transient; moving the hold off it would let
 *      the backup run's cleanup destroy it on the source).
 *   2. The target's newest snapshot is a transient T the source still has,
 *      older than S → the base is T for THIS send (the caller then settles the
 *      hold on S, which releases it from T on both sides) — the stream ZFS
 *      receives whether or not T carried changes. Newer than S → refused
 *      (the target is past S).
 *   3. (review 3 of cr3: deleted) A transient the source does not have —
 *      an older build's leftover, or a backup/cloud run on the TARGET node of
 *      the replica — is treated like any target-only snapshot: the later
 *      rules pick the base and ZFS's own accept/refuse arbitrates.
 *   4. A non-transient snapshot both have that is newer than S → refused
 *      (`newerOnTarget`): the target is past S.
 *   5. The newest non-transient source snapshot older than S that the target
 *      has → the base.
 *   6. Any snapshot both have (a transient included) → refused NAMING it;
 *      "remove the target dataset" is never said while one exists.
 *   7. Nothing in common → diverged.
 */
export type BaseDecision
  = | { kind: 'upToDate', newerCommon?: string, keepHolds?: true, keepHoldsOn?: string }
    | { kind: 'incremental', base: string, transientBase?: true }
    | { kind: 'refuse', message: string, newerCommon?: string }
    | { kind: 'diverged' }

/** ZFS's refusal of an incremental into a target written after its newest snapshot (the stderr wraps between "modified" and "since"). */
const TARGET_MODIFIED_RE = /has been modified\s+since most recent snapshot/

/**
 * The hint ADDED to a failed receive's sentence when ZFS says the target was
 * modified since its most recent snapshot (review 3 of cr3). The raw stderr
 * stays in the sentence; this only names what changed and the one remedy:
 * the target's snapshots newer than the base (by name, `targetSnaps` newest
 * first) and a rollback to the base after releasing any hold on them —
 * ground truth on the node pair 2026-11-14 (ZFS 2.4.2): destroying the newer
 * snapshot does NOT make the receive succeed, the rollback does. Empty when
 * the stderr is anything else.
 */
export function modifiedTargetHint(stderr: string, target: string, base: string | undefined, targetSnaps: string[]): string {
  if (base === undefined || !TARGET_MODIFIED_RE.test(stderr))
    return ''
  const i = targetSnaps.indexOf(base)
  const newer = i <= 0 ? [] : targetSnaps.slice(0, i)
  const named = newer.slice(0, 5).map(n => `'@${n}'`).join(', ') + (newer.length > 5 ? ', ...' : '')
  const holds = newer.length > 0
    ? `release any hold on ${newer.length === 1 ? 'that snapshot' : 'those snapshots'} ('zfs holds ${target}@${newer[0]}' lists them; 'zfs release <tag> <snapshot>' for each), then `
    : ''
  return `the target was written to after '@${base}'${newer.length > 0 ? ` and has newer snapshot(s) ${named}` : ''}; to continue the chain, on the target ${holds}roll it back to '@${base}' ('zfs rollback -r ${target}@${base}', which destroys the snapshots newer than it there and anything written since)`
}

/** The sentence of the one diverged case: nothing in common at all. */
export function divergedMessage(target: string): string {
  return `Target '${target}' has diverged — no common snapshot; remove the target dataset or replicate to a new path`
}

export function decideBase(sourceSnaps: string[], targetSnaps: string[], S: string, ctx: { target: string, where?: string }): BaseDecision {
  const where = ctx.where ?? ''
  const onSource = new Set(sourceSnaps)
  const sIdx = sourceSnaps.indexOf(S)
  const newerOnSource = (name: string): boolean => {
    const i = sourceSnaps.indexOf(name)
    return i !== -1 && sIdx !== -1 && i < sIdx
  }
  const targetNewest = targetSnaps[0]
  const newerCommon = sIdx <= 0
    ? undefined
    : sourceSnaps.slice(0, sIdx).find(n => !isTransientRunSnapshot(n) && targetSnaps.includes(n))
  const transientAhead = targetNewest !== undefined && targetNewest !== S && isTransientRunSnapshot(targetNewest)

  // 1. Up to date.
  if (targetSnaps.includes(S)) {
    const keep = transientAhead && onSource.has(targetNewest) && newerOnSource(targetNewest)
    return { kind: 'upToDate', ...(newerCommon ? { newerCommon } : {}), ...(keep ? { keepHolds: true as const, keepHoldsOn: targetNewest } : {}) }
  }

  // 2. The target's newest snapshot is a transient the source still has.
  //    (A transient the source does NOT have falls through: review 3 of cr3.)
  if (transientAhead && onSource.has(targetNewest)) {
    if (!newerOnSource(targetNewest))
      return { kind: 'incremental', base: targetNewest, transientBase: true }
    return { kind: 'refuse', message: `Target '${ctx.target}'${where} already has '@${targetNewest}' (a backup or cloud run's snapshot), which is newer than '@${S}' — replicate a newer snapshot` }
  }

  // 4. The target is already past S.
  if (newerCommon !== undefined)
    return { kind: 'refuse', newerCommon, message: `Target '${ctx.target}'${where} already has '@${newerCommon}', which is newer than '@${S}' — replicate '@${newerCommon}' or a later snapshot` }

  // 5. The base.
  const base = sIdx === -1 ? undefined : sourceSnaps.slice(sIdx + 1).find(n => !isTransientRunSnapshot(n) && targetSnaps.includes(n))
  if (base !== undefined)
    return { kind: 'incremental', base }

  // 6. Something in common that is not a base: name it, never "diverged".
  const common = sourceSnaps.filter(n => targetSnaps.includes(n))
  if (common.length > 0) {
    const named = common.slice(0, 3).map(n => `'@${n}'`).join(', ')
    const c = common[0]
    return {
      kind: 'refuse',
      message: `Target '${ctx.target}'${where} cannot receive '@${S}': its newest snapshot '@${targetNewest}' is not a base for it, and the snapshot(s) it shares with the source (${named}${common.length > 3 ? ', ...' : ''}) are not either — the target has not diverged; nothing was sent. On the target, roll it back to '@${c}' ('zfs rollback -r ${ctx.target}@${c}', which destroys the snapshots newer than it there) and the next run continues from '@${c}', or replicate to a new path`,
    }
  }

  // 7. Nothing in common.
  return { kind: 'diverged' }
}

/**
 * A source name's target name: swap the root prefix (root -> targetRoot).
 * ONE definition (rrep.1b fold 2, single source of truth): the planner, the
 * gate's target guard and the route's run loop all map names through here.
 */
export function treeTargetName(sourceRoot: string, targetRoot: string, dataset: string): string {
  return targetRoot + dataset.slice(sourceRoot.length)
}

/**
 * R5b's NAME half (rrep.2: the planner's rule 4, callable alone so the task's
 * create/update gate asks the same question the run does): every dataset's
 * target name must be a legal dataset a remote `zfs recv` will accept — 255
 * bytes at most, and a `DatasetPath`. Pure over the names given; the caller
 * decides WHICH datasets this run reasons about (the planner drops the skipped
 * subtrees first: a dataset rule 7 skips produces no entry, no plan and no
 * refusal). Returns one refusal sentence per offending dataset, in the order
 * given; `[]` means every name fits.
 */
export function treeTargetNameRefusals(sourceRoot: string, targetRoot: string, datasets: string[]): string[] {
  const refusals: string[] = []
  for (const dataset of datasets) {
    const t = treeTargetName(sourceRoot, targetRoot, dataset)
    if (t.length > 255 || !DatasetPath.safeParse(t).success)
      refusals.push(`'${dataset}' cannot be replicated: its target name '${t}' is longer than ZFS allows (255) or contains characters ANAS does not pass to a remote command`)
  }
  return refusals
}

/**
 * R5c — PLACEMENT (rrep.2: the planner's rule 5, callable alone for the task
 * gate). Local targets only (a remote node cannot be "inside" this node's
 * source tree). Equal roots are the FIRST sentence here too — the existing
 * same-dataset target guard keeps refusing the create. A target the operator
 * EXCLUDED is their explicit answer to the self-copy problem, so an excluded
 * container does not refuse. At most ONE sentence (the two cases are exclusive
 * in practice: a target strictly inside the source is not also a container of
 * it, and equal roots take the first branch).
 */
export function treePlacementRefusals(input: {
  sourceRoot: string
  targetRoot: string
  exclude: string[]
  localTarget: boolean
}): string[] {
  const { sourceRoot, targetRoot, exclude, localTarget } = input
  if (!localTarget)
    return []
  if (isAtOrUnder(targetRoot, sourceRoot) && !exclude.some(ex => isAtOrUnder(targetRoot, ex)))
    return [`The target '${targetRoot}' is inside the source tree '${sourceRoot}' — a recursive replication would copy its own replica; choose a target outside it, or exclude the dataset that contains it`]
  if (isAtOrUnder(sourceRoot, targetRoot))
    return [`The source '${sourceRoot}' is inside the target tree '${targetRoot}'`]
  return []
}

/**
 * The per-dataset plan for a recursive replication, or EVERY reason the run
 * cannot happen (rules 3–8 collected in one pass, so the operator fixes them
 * once; rules 1–2 return at once — without the root or without S there is no
 * plan to add to).
 */
export function planTreeReplication(facts: TreeFacts): TreePlan {
  const { sourceRoot, targetRoot, exclude, localTarget } = facts
  const refusals: string[] = []

  // 1. The listing must be the root's own (a `-r` listing starts at its
  //    operand; anything else means we listed the wrong thing).
  if (facts.sourceTree[0] !== sourceRoot)
    return { ok: false, refusals: [`Source '${sourceRoot}' was not in its own listing — refusing the recursive replication`] }

  // 2. R4: S is the newest NON-transient snapshot of the ROOT (the list is
  //    newest-first), and the one name every dataset in the run is sent at.
  const rootSnaps = facts.sourceSnaps.get(sourceRoot) ?? []
  const S = rootSnaps.find(n => !isTransientRunSnapshot(n))
  if (S === undefined)
    return { ok: false, refusals: [`Dataset '${sourceRoot}' has no snapshots — take a recursive snapshot of it, or let its recursive schedule run`] }

  // 3. R2: the sweep is the schedule's sweepSet — target first, excluded
  //    subtrees dropped — never a second definition of "what is covered".
  const sweep = sweepSet({ target: { kind: 'zfs', dataset: sourceRoot }, recursive: true, exclude }, facts.sourceTree)
  /** A source name's target name: swap the root prefix (root -> targetRoot). */
  const targetName = (dataset: string): string => treeTargetName(sourceRoot, targetRoot, dataset)
  const targetTreeSet = new Set(facts.targetTree)
  const holdsS = (dataset: string): boolean => (facts.sourceSnaps.get(dataset) ?? []).includes(S)

  // 7-first pass (its refusals still come at rule 7's place below): R5d says
  //    a dataset without S whose target does not exist yet is skipped WITH
  //    EVERYTHING UNDER IT, and those datasets "produce no entry, no plan and
  //    no refusal" — including of rules 4, 6 and 8, which therefore cannot
  //    run over them. The skip set needs only the two listings, so it is
  //    settled here; rule 7's own refusals are collected in rule order.
  const skipped: SkippedDataset[] = []
  /** Roots of skipped subtrees; isAtOrUnder covers the dataset itself. */
  const skipSubtrees: string[] = []
  for (const dataset of sweep) {
    if (skipSubtrees.some(sk => isAtOrUnder(dataset, sk)))
      continue
    if (holdsS(dataset))
      continue
    if (targetTreeSet.has(targetName(dataset)))
      continue
    skipped.push({
      dataset,
      message: `'${dataset}' has no '@${S}' (created after that snapshot?) — skipped with everything below it; it is sent once a recursive snapshot of '${sourceRoot}' includes it`,
    })
    skipSubtrees.push(dataset)
  }
  const invisible = (dataset: string): boolean => skipSubtrees.some(sk => isAtOrUnder(dataset, sk))

  // 4. R5b (name half): every target name must be a legal dataset the remote
  //    `zfs recv` will accept — {@link treeTargetNameRefusals}, the same
  //    function the task gate asks (rrep.2).
  refusals.push(...treeTargetNameRefusals(sourceRoot, targetRoot, sweep.filter(dataset => !invisible(dataset))))

  // 5. R5c: placement — {@link treePlacementRefusals}, shared with the task
  //    gate (rrep.2).
  refusals.push(...treePlacementRefusals({ sourceRoot, targetRoot, exclude, localTarget }))

  // 6. R5f: a swept, not-skipped dataset must be unencrypted or have its key
  //    loaded; a missing keystatus ROW is the unreadable refusal, not "-".
  //    (A dataset rule 7 will also refuse still gets its key checked here:
  //    the operator fixes everything in one pass.)
  for (const dataset of sweep) {
    if (invisible(dataset))
      continue
    const status = facts.sourceProps.get(dataset)?.keystatus
    if (status === undefined)
      refusals.push(unreadableRow('keystatus', dataset))
    else if (status !== '-' && status !== 'available')
      refusals.push(`'${dataset}' is encrypted and its key is not loaded — load it or exclude the dataset`)
  }

  // 7. R5d, refusal half: no S but the target copy EXISTS means the tree was
  //    snapshotted non-recursively or this dataset was snapshotted alone —
  //    there is no name to send it at.
  for (const dataset of sweep) {
    if (invisible(dataset) || holdsS(dataset))
      continue
    refusals.push(`'${dataset}' has no '@${S}', the newest snapshot of '${sourceRoot}' — recursive replication sends one snapshot name across the tree; take a recursive snapshot of '${sourceRoot}' (or let its recursive schedule run), or exclude '${dataset}'`)
  }

  // 8. R5g + R5e: per dataset, full vs incremental vs up-to-date.
  const datasets: PlannedDataset[] = []
  const upToDate: string[] = []
  const holdsKept: string[] = []
  const plannedFull = new Set<string>()
  for (const dataset of sweep) {
    if (invisible(dataset) || !holdsS(dataset))
      continue
    const t = targetName(dataset)
    if (!targetTreeSet.has(t)) {
      // Full send. Its parent must already exist on the target or be created
      // by this very run earlier in this same sweep order.
      const slash = t.lastIndexOf('/')
      const parent = slash === -1 ? null : t.slice(0, slash)
      if (dataset !== sourceRoot && parent !== null && !targetTreeSet.has(parent) && !plannedFull.has(parent)) {
        refusals.push(`'${t}' cannot be created: its parent does not exist on the target and is not part of this run`)
        continue
      }
      datasets.push({ dataset, target: t, mode: 'full' })
      plannedFull.add(t)
      continue
    }
    const written = facts.targetProps.get(t)?.written
    // `''`/`'-'`/junk parse to NaN: unreadable, never a silent 0 (Number('')
    // IS 0 — hence the length guard).
    const modified = written === undefined || written.length === 0 ? Number.NaN : Number(written)
    if (!Number.isFinite(modified)) {
      refusals.push(unreadableRow('written', t))
      continue
    }
    if (modified > 0) {
      refusals.push(`Target '${t}' has been modified since its last replicated snapshot — a receive would fail; roll it back to that snapshot, or remove it`)
      continue
    }
    // A copy that already holds S has nothing to send — asked BEFORE the base
    // search, or a run resumed after a part-way stop would plan an incremental
    // for every dataset the stopped run finished (review of rrep.1a; the
    // receive of such a stream says "already exists; ignoring" and exits 0 on
    // OpenZFS 2.4 — ground truth 2026-11-14 — so it was waste, not breakage,
    // but R6's "continues from each dataset's own base" means: skip these).
    // (review of cr3) The ONE base rule, shared with the single-dataset run.
    const decision = decideBase(facts.sourceSnaps.get(dataset) ?? [], facts.targetSnaps.get(t) ?? [], S, { target: t })
    if (decision.kind === 'upToDate') {
      upToDate.push(dataset)
      if (decision.keepHolds)
        holdsKept.push(dataset)
      continue
    }
    if (decision.kind === 'incremental') {
      datasets.push({ dataset, target: t, mode: 'incremental', baseSnapshot: decision.base })
      continue
    }
    refusals.push(decision.kind === 'refuse' ? decision.message : divergedMessage(t))
  }

  if (refusals.length > 0)
    return { ok: false, refusals }

  // 9. R8: datasets the target has that this run does not cover — LISTED,
  //    never destroyed, never even a warning: they are somebody else's data.
  const covered = new Set(sweep.map(targetName))
  const targetOnly = facts.targetTree.filter(name => isAtOrUnder(name, targetRoot) && !covered.has(name))

  return { ok: true, snapshot: S, datasets, skipped, targetOnly, upToDate, ...(holdsKept.length > 0 ? { holdsKept } : {}) }
}
