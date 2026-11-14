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
  }
  | { ok: false, refusals: string[] }

/** The refusal for a row the caller's own listing should have contained. */
function unreadableRow(prop: string, dataset: string): string {
  return `Could not read '${prop}' of '${dataset}' — refusing the recursive replication`
}

/**
 * Decide full vs incremental for ONE dataset — the per-dataset restatement of
 * the single-dataset `discover` in routes/replication.ts (the rule, not an
 * import: the route works on parsed `Snapshot` objects and discovers the
 * newest snapshot itself, while here S came from the tree's root, and uniting
 * the two is the next story's job). Same rule over plain name lists, newest
 * first: the base is the newest SOURCE snapshot older than S (after S in the
 * list) that is not a transient run snapshot and that the target's list also
 * has — transients ignored on the target side too, backup2.3's reason.
 * No base splits into "up to date" vs "diverged" in the caller.
 */
function findBase(sourceSnaps: string[], targetSnaps: string[], S: string): string | undefined {
  const targetNames = new Set(targetSnaps.filter(n => !isTransientRunSnapshot(n)))
  const idx = sourceSnaps.indexOf(S)
  // S missing from the source list is the caller's rule-7 question, not this one.
  if (idx === -1)
    return undefined
  return sourceSnaps.slice(idx + 1).find(n => !isTransientRunSnapshot(n) && targetNames.has(n))
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
    if ((facts.targetSnaps.get(t) ?? []).includes(S)) {
      upToDate.push(dataset)
      continue
    }
    const base = findBase(facts.sourceSnaps.get(dataset) ?? [], facts.targetSnaps.get(t) ?? [], S)
    if (base !== undefined) {
      datasets.push({ dataset, target: t, mode: 'incremental', baseSnapshot: base })
      continue
    }
    refusals.push(`Target '${t}' has diverged — no common snapshot; remove the target dataset or replicate to a new path`)
  }

  if (refusals.length > 0)
    return { ok: false, refusals }

  // 9. R8: datasets the target has that this run does not cover — LISTED,
  //    never destroyed, never even a warning: they are somebody else's data.
  const covered = new Set(sweep.map(targetName))
  const targetOnly = facts.targetTree.filter(name => isAtOrUnder(name, targetRoot) && !covered.has(name))

  return { ok: true, snapshot: S, datasets, skipped, targetOnly, upToDate }
}
