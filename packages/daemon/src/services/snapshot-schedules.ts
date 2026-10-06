import type {
  AhrPool,
  PruneScope,
  RetentionBucket,
  RetentionPolicy,
  ScheduledSnapshot,
  SnapshotSchedule,
  SnapshotScheduleRunResult,
  SnapshotTarget,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import type { ScheduleListRead } from './snapshot-schedule-units.js'
import { HELD_NAMES_TOTAL, PRUNED_NAMES_PER_DATASET, PRUNED_NAMES_TOTAL } from '@anas/shared'
import { run } from './ahr-exec.js'
import { createAhrSnapshot, deleteAhrSnapshot, listAhrSnapshots } from './ahr-snapshots.js'
import { formatScheduledName, isTransientRunSnapshot, parseScheduledName } from './snapshot-naming.js'
import { planRetention } from './snapshot-retention.js'
import { createZfsSnapshot, createZfsSnapshotExcluding, destroyZfsSnapshot, inSweep, isSnapshotAlreadyGone, zfsSnapshotFullName } from './zfs-snapshot.js'

/**
 * Uniform snapshot take/prune/list (Epic 17, stage 1). ONE service surface that
 * the operator drives IDENTICALLY for a ZFS dataset and an AHR pool; the only
 * place the two filesystems diverge is the dispatch on `target.kind`:
 *
 *   | verb  | ZFS                                    | AHR (reuses 11.12 primitives)          |
 *   |-------|----------------------------------------|----------------------------------------|
 *   | take  | `zfs snapshot [-r] <ds>@anas-<b>-<utc>` | ro btrfs snapshot `@data → @snapshots/…`|
 *   |       | (snapx.1 exclude: one call, many names) |                                        |
 *   | list  | `zfs list -t snapshot -Hp -o …`        | `listAhrSnapshots` over `@snapshots/*`  |
 *   | prune | `zfs destroy` the plan's prune-set     | `btrfs subvolume delete` the prune-set  |
 *   |       | (snapprune.1 recursive: per dataset)   |                                        |
 *
 * The retention decision is the SAME `planRetention` engine for both; only the
 * take/list/destroy primitives are backend-specific. Every function shares one
 * signature shape `(executor, target, …, opts?)` — the uniformity principle at
 * the code layer, not just the UI.
 *
 * Held-safety (ZFS): the engine already excludes held snapshots, and prune
 * re-checks `userrefs` immediately before each destroy (belt-and-suspenders) —
 * a held snapshot is never handed to `zfs destroy`, it is reported as retained.
 */

const ZFS = '/usr/sbin/zfs'

/**
 * Options common to the uniform snapshot services. `pool` is REQUIRED when the
 * target is an AHR pool (it carries the resolved 11.12 topology the btrfs
 * primitives need); it is ignored for ZFS. `runtimeDir` is the AHR on-demand
 * mount base (tests point it at a temp path).
 */
export interface SnapshotServiceOptions extends AhrSnapshotOptions {
  /** Resolved AHR pool — REQUIRED when `target.kind === 'ahr'`. */
  pool?: AhrPool
  /** ZFS only: recurse into child datasets (`zfs snapshot -r`). */
  recursive?: boolean
  /**
   * ZFS + `recursive` only (story snapx.1): child datasets skipped with their
   * subtrees. Empty/absent = the literal `zfs snapshot -r`; non-empty = the
   * expanded tree taken in ONE atomic `zfs snapshot` call.
   */
  exclude?: string[]
  /** Progress sink (default no-op) — mirrors the AHR snapshot verbs. */
  updateProgress?: (message: string) => void
  /** Clock for the name's UTC stamp and retention `now` (default: real time). */
  now?: Date
}

function noop(): void {}

/**
 * Resolve the AHR pool for an AHR target from opts, asserting it matches. Throws
 * a clear error if a caller dispatches an AHR target without its resolved pool
 * (a programming error — the route resolves the pool before calling).
 */
function requirePool(target: Extract<SnapshotTarget, { kind: 'ahr' }>, opts?: SnapshotServiceOptions): AhrPool {
  const pool = opts?.pool
  if (!pool)
    throw new Error(`AHR snapshot target '${target.pool}' requires the resolved pool in opts.pool`)
  if (pool.name !== target.pool)
    throw new Error(`opts.pool '${pool.name}' does not match AHR target '${target.pool}'`)
  return pool
}

// ---- Take -------------------------------------------------------------------

/** The result of taking one scheduled snapshot. */
export interface TakeSnapshotResult {
  target: SnapshotTarget
  /** The created snapshot label (`anas-<bucket>-<utc>`). */
  name: string
  bucket: RetentionBucket
}

/**
 * Take one ANAS-scheduled snapshot of `target` into `bucket`. The name is the
 * canonical `anas-<bucket>-<utc>` at `opts.now`. ZFS: `zfs snapshot [-r]`; AHR:
 * a read-only btrfs snapshot of `@data` (reusing the 11.12 primitive).
 */
export async function takeSnapshot(
  executor: CommandExecutor,
  target: SnapshotTarget,
  bucket: RetentionBucket,
  opts?: SnapshotServiceOptions,
): Promise<TakeSnapshotResult> {
  const name = formatScheduledName(bucket, opts?.now ?? new Date())
  if (target.kind === 'zfs') {
    // The ONE zfs-snapshot verb (backup2.3's extraction): identical argv, shared
    // with the datasets route, replication's snapshot-first and the backup runner.
    // snapx.1: a recursive schedule with an exclude list expands the tree and
    // takes the rest in one atomic call; without one it stays the literal `-r`.
    const exclude = opts?.exclude ?? []
    if (opts?.recursive === true && exclude.length > 0)
      await createZfsSnapshotExcluding(executor, { dataset: target.dataset, name, exclude })
    else
      await createZfsSnapshot(executor, { dataset: target.dataset, name, recursive: opts?.recursive === true })
  }
  else {
    const pool = requirePool(target, opts)
    await createAhrSnapshot(executor, pool, name, opts?.updateProgress ?? noop, opts)
  }
  return { target, name, bucket }
}

// ---- List -------------------------------------------------------------------

/** `zfs list` argv for a dataset's own snapshots with retention columns. */
export function zfsScheduledListArgs(dataset: string): string[] {
  // -H: no header, tab-delimited; -p: parsable (creation as epoch seconds,
  // userrefs as an exact integer). Direct-only (no -r) — scoped to this dataset.
  return ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', dataset]
}

/**
 * Parse `zfs list -t snapshot -Hp -o name,creation,userrefs` output into the
 * uniform inventory shape. Each line is `<pool/ds@label>\t<epoch>\t<userrefs>`;
 * source is `anas` iff the label parses as our naming convention, `held` iff
 * `userrefs > 0` (a `zfs hold`), and `createdAt` is the ISO-UTC of `creation`.
 */
export function parseZfsScheduledSnapshots(target: SnapshotTarget, stdout: string): ScheduledSnapshot[] {
  const out: ScheduledSnapshot[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line)
      continue
    const [full, creation, userrefs] = line.split('\t')
    const at = full.indexOf('@')
    if (at === -1)
      continue
    const label = full.slice(at + 1)
    const parsed = parseScheduledName(label)
    const epoch = Number.parseInt(creation ?? '', 10)
    const held = Number.parseInt(userrefs ?? '', 10) > 0
    out.push({
      name: label,
      target,
      bucket: parsed?.bucket ?? null,
      createdAt: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null,
      held,
      source: parsed ? 'anas' : 'other',
    })
  }
  return out
}

/**
 * List `target`'s snapshots as the uniform inventory. ZFS reads
 * `zfs list -t snapshot` (held detection via `userrefs`); AHR reads
 * `@snapshots/*` via the 11.12 list (never held — btrfs snapshots aren't
 * ZFS-held). Both mark `source`/`bucket` from the naming convention.
 */
export async function listScheduledSnapshots(
  executor: CommandExecutor,
  target: SnapshotTarget,
  opts?: SnapshotServiceOptions,
): Promise<ScheduledSnapshot[]> {
  if (target.kind === 'zfs') {
    const r = await run(executor, ZFS, zfsScheduledListArgs(target.dataset))
    return parseZfsScheduledSnapshots(target, r.stdout)
  }
  const pool = requirePool(target, opts)
  const snaps = await listAhrSnapshots(executor, pool, opts)
  return snaps.map((s) => {
    const parsed = parseScheduledName(s.name)
    return {
      name: s.name,
      target,
      bucket: parsed?.bucket ?? null,
      createdAt: s.createdAt,
      held: false, // btrfs snapshots are not ZFS-held
      source: parsed ? 'anas' : 'other',
    } satisfies ScheduledSnapshot
  })
}

// ---- Prune ------------------------------------------------------------------

/** The result of a prune run: what was destroyed, and what was retained held. */
export interface PruneResult {
  /** Snapshots actually destroyed. */
  pruned: ScheduledSnapshot[]
  /** Held snapshots retained (never destroyed) — surfaced as intentionally kept. */
  skippedHeld: ScheduledSnapshot[]
}

/** Live `userrefs` of one ZFS snapshot — the belt-and-suspenders held re-check. */
async function zfsIsHeld(executor: CommandExecutor, full: string): Promise<boolean> {
  const r = await executor.exec(ZFS, ['list', '-t', 'snapshot', '-Hp', '-o', 'userrefs', full])
  if (r.exitCode !== 0)
    return false
  return Number.parseInt(r.stdout.trim(), 10) > 0
}

/**
 * Destroy one scheduled ZFS snapshot; a snapshot that is ALREADY GONE counts
 * as destroyed. Two same-bucket schedules firing in the same minute (systemd
 * coalesces timers) race: a parent's recursive prune destroys a child
 * snapshot the child's own run planned from its earlier read, and ZFS answers
 * the second destroy with "could not find any snapshots to destroy". The
 * snapshot is gone, which is exactly what the plan asked for — no error, no
 * warning. Every other refusal throws as before.
 */
async function destroyScheduledZfsSnapshot(executor: CommandExecutor, dataset: string, name: string): Promise<void> {
  try {
    await destroyZfsSnapshot(executor, { dataset, name })
  }
  catch (err) {
    if (!isSnapshotAlreadyGone(err))
      throw err
  }
}

/**
 * Apply `policy` to `target` and destroy the over-retention snapshots. The plan
 * comes from the uniform `planRetention` engine; only ANAS-named snapshots are
 * ever destroyed, never a held one, never an `other`-source one.
 *
 * ZFS: each destroy is preceded by a live `userrefs` re-check — a snapshot held
 * since the inventory was read (e.g. a replication run just took a hold) is NOT
 * destroyed but reported in `skippedHeld`. AHR: `btrfs subvolume delete` via the
 * 11.12 primitive (btrfs snapshots are never held).
 */
export async function pruneSnapshots(
  executor: CommandExecutor,
  target: SnapshotTarget,
  policy: RetentionPolicy,
  opts?: SnapshotServiceOptions,
): Promise<PruneResult> {
  const inventory = await listScheduledSnapshots(executor, target, opts)
  const plan = planRetention(inventory, policy, opts?.now ?? new Date())

  const pruned: ScheduledSnapshot[] = []
  const skippedHeld = [...plan.skippedHeld]
  const progress = opts?.updateProgress ?? noop

  if (target.kind === 'zfs') {
    for (const snap of plan.prune) {
      const full = zfsSnapshotFullName(target.dataset, snap.name)
      if (await zfsIsHeld(executor, full)) {
        skippedHeld.push({ ...snap, held: true })
        continue
      }
      progress(`Destroying ${full}`)
      await destroyScheduledZfsSnapshot(executor, target.dataset, snap.name)
      pruned.push(snap)
    }
  }
  else {
    const pool = requirePool(target, opts)
    for (const snap of plan.prune) {
      progress(`Deleting @snapshots/${snap.name}`)
      await deleteAhrSnapshot(executor, pool, snap.name, progress, opts)
      pruned.push(snap)
    }
  }

  return { pruned, skippedHeld }
}

// ---- Prune across a recursive schedule's sweep (snapprune.1) ------------------
//
// A recursive schedule takes `-r` (or the snapx.1 expansion) across a subtree,
// so retention must reach every dataset it snapshots — before snapprune.1 only
// the target was pruned and every child kept every snapshot ever taken. The
// prune below reads the whole tree ONCE, plans PER DATASET, and destroys one
// snapshot at a time with the live `userrefs` re-check (never `destroy -r`:
// one held child snapshot would fail the whole verb).
//
//   - target   — exactly the plan a non-recursive schedule gets (the
//                schedule's full policy over the target's ANAS snapshots);
//                unchanged by snapprune.1.
//   - sweep    — every other dataset the schedule snapshots: only THIS
//                schedule's bucket is planned (a child can be the target of
//                its own daily/monthly schedule, whose snapshots this
//                schedule must never prune), keeping the MOST GENEROUS count
//                any enabled schedule covering that dataset with the same
//                bucket asks for — never more aggressive than any of them,
//                whichever fires first. That count cannot be known from a
//                partial schedule list, so when the list could not be read
//                whole, swept children are not pruned on that run (noted).
//   - excluded — a dataset under the target outside the sweep: snapshots this
//                schedule took before the exclude are out of its scope and
//                are destroyed outright — but only those it provably took
//                (see "Provenance" below), so a replication target's
//                received `anas-*` snapshots are never touched. Left alone
//                entirely when another enabled schedule covers the dataset
//                with the same bucket (its retention owns them) — and left
//                alone entirely when the schedule list could not be read
//                whole (an unreadable/unparseable unit may be exactly that
//                covering schedule: fail safe, destroy nothing there). A
//                PVE-owned dataset is treated the same way (a provably-own
//                snapshot is ANAS's leftover, not PVE's data).
//
// Already gone: a destroy ZFS answers "could not find any snapshots to
// destroy" counts as pruned in every scope (a same-minute schedule got there
// first — destroyScheduledZfsSnapshot).
//
// Refused destroys: on a swept or excluded dataset a destroy ZFS refuses (a
// clone made from the snapshot depends on it) is noted on that dataset and
// the prune goes on — a clone would otherwise fail every run forever; the
// run completes with warnings. On the TARGET a refusal fails the run, as a
// failed prune always has.
//
// Provenance (excluded scope only): a snapshot on an excluded dataset is this
// schedule's iff an ANAS-named WITNESS still in the sweep has the same name,
// the same `createtxg` AND the same `creation` second — one `zfs snapshot
// -r`/multi-name call is one txg and one creation time across the tree. Only
// `source === 'anas'` snapshots act as witnesses. Name + txg alone is weaker:
// two takes inside one txg window share a txg, and a `zfs receive` could land
// in the txg of a take. Residual: a snapshot with the same name created in the
// same txg AND the same second as our take (a receive or a hand-made snapshot
// timed exactly onto it) still matches — accepted; nothing finer is on disk.

/**
 * The note a swept or excluded dataset carries when the schedule-list
 * fail-safe engaged (the other schedules could not be read whole, so nothing
 * there was pruned). A run with any such note is a `warning`, never a quiet
 * success (snapshot-notify.ts).
 */
export const SCHEDULE_LIST_UNREADABLE = 'schedule list unreadable'

/** `zfs list` argv for every snapshot in a tree, with the provenance column. */
export function zfsTreeSnapshotListArgs(dataset: string): string[] {
  // -r: the whole subtree in ONE read; createtxg ties a snapshot to the take
  // that made it (every snapshot of one atomic take shares the txg).
  return ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs,createtxg', '-r', dataset]
}

/** One snapshot in a tree inventory: the uniform shape plus its `createtxg`. */
export interface TreeSnapshot extends ScheduledSnapshot {
  /** The txg the snapshot was created in (string, as ZFS prints it); '' when unread. */
  createtxg: string
}

/**
 * Parse {@link zfsTreeSnapshotListArgs} output into per-dataset inventories,
 * keyed by dataset in listing order. Each snapshot's `target` names ITS OWN
 * dataset, so a plan over it reads exactly like a single-dataset plan.
 */
export function parseZfsTreeSnapshots(stdout: string): Map<string, TreeSnapshot[]> {
  const byDataset = new Map<string, TreeSnapshot[]>()
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line)
      continue
    const [full, creation, userrefs, createtxg] = line.split('\t')
    const at = full.indexOf('@')
    if (at === -1)
      continue
    const dataset = full.slice(0, at)
    const [snap] = parseZfsScheduledSnapshots({ kind: 'zfs', dataset }, [full, creation ?? '', userrefs ?? ''].join('\t'))
    if (!snap)
      continue
    const list = byDataset.get(dataset) ?? []
    list.push({ ...snap, createtxg: (createtxg ?? '').trim() })
    byDataset.set(dataset, list)
  }
  return byDataset
}

/** One dataset's slice of a recursive prune plan. */
export interface DatasetPrunePlan {
  dataset: string
  scope: PruneScope
  /** Snapshots to destroy, in plan order. */
  prune: TreeSnapshot[]
  /** Held snapshots the plan sets aside (retained, reported). */
  skippedHeld: TreeSnapshot[]
  /** Why snapshots of this schedule's bucket were left in place, when some were. */
  note?: string
}

/** What {@link planRecursivePrune} needs to know about the world. */
export interface RecursivePruneInput {
  /** The recursive ZFS schedule being fired. */
  schedule: SnapshotSchedule
  /** The target tree's snapshots, per dataset ({@link parseZfsTreeSnapshots}). */
  inventory: Map<string, TreeSnapshot[]>
  /**
   * Every schedule on the node (read from the unit files; the fired one is
   * skipped by id), and whether that read was COMPLETE. When it was not, only
   * the target is pruned: no snapshot on a swept child or an excluded dataset
   * is destroyed.
   */
  others: ScheduleListRead
  now: Date
}

/** This schedule's bucket snapshots on one dataset (ANAS-named, never transient). */
function bucketSnapshots(snaps: TreeSnapshot[], bucket: RetentionBucket): TreeSnapshot[] {
  return snaps.filter(s => s.source === 'anas' && s.bucket === bucket && !isTransientRunSnapshot(s.name))
}

/**
 * A snapshot's provenance key — name + `createtxg` + `creation` (seconds, as
 * `createdAt`) — or null when either column was unread (never matches).
 */
function provenanceKey(s: TreeSnapshot): string | null {
  if (!s.createtxg || !s.createdAt)
    return null
  return `${s.name}\u0000${s.createtxg}\u0000${s.createdAt}`
}

/**
 * The per-dataset prune plan of a recursive ZFS schedule (snapprune.1) —
 * pure. See the section note above for the three scopes. Datasets with
 * nothing to report are left out; the target always comes first.
 */
export function planRecursivePrune(input: RecursivePruneInput): DatasetPrunePlan[] {
  const { schedule, inventory, now } = input
  if (schedule.target.kind !== 'zfs')
    return []
  const target = schedule.target.dataset
  const bucket = schedule.cadence
  const others = input.others.schedules.filter(o => o.enabled && o.id !== schedule.id && o.cadence === bucket && o.target.kind === 'zfs')
  const listComplete = input.others.complete
  const plans: DatasetPrunePlan[] = []

  // Provenance: every (label, createtxg, creation) of an ANAS snapshot still
  // present in the sweep, read before anything is destroyed.
  const taken = new Set<string>()
  for (const [dataset, snaps] of inventory) {
    if (!inSweep(schedule, dataset))
      continue
    for (const s of snaps) {
      const key = provenanceKey(s)
      if (s.source === 'anas' && key)
        taken.add(key)
    }
  }

  const targetSnaps = inventory.get(target) ?? []
  const targetPlan = planRetention(targetSnaps, schedule.retention, now)
  plans.push({
    dataset: target,
    scope: 'target',
    prune: targetPlan.prune as TreeSnapshot[],
    skippedHeld: targetPlan.skippedHeld as TreeSnapshot[],
  })

  for (const [dataset, snaps] of inventory) {
    if (dataset === target || !dataset.startsWith(`${target}/`))
      continue
    const mine = bucketSnapshots(snaps, bucket)
    if (mine.length === 0)
      continue

    if (inSweep(schedule, dataset)) {
      // The most generous count below is unknowable on a partial list (the
      // unread unit may ask for more): leave the child for this run.
      if (!listComplete) {
        plans.push({ dataset, scope: 'sweep', prune: [], skippedHeld: [], note: `${mine.length} left: ${SCHEDULE_LIST_UNREADABLE}` })
        continue
      }
      // The most generous same-bucket count among the enabled schedules
      // covering this dataset (this one included).
      let keep = schedule.retention[bucket] ?? 0
      for (const o of others) {
        if (inSweep(o, dataset))
          keep = Math.max(keep, o.retention[bucket] ?? 0)
      }
      const plan = planRetention(mine, { [bucket]: keep }, now)
      if (plan.prune.length || plan.skippedHeld.length) {
        plans.push({
          dataset,
          scope: 'sweep',
          prune: plan.prune as TreeSnapshot[],
          skippedHeld: plan.skippedHeld as TreeSnapshot[],
        })
      }
      continue
    }

    // Outside the sweep: an excluded dataset or something beneath one.
    if (!listComplete) {
      plans.push({ dataset, scope: 'excluded', prune: [], skippedHeld: [], note: `${mine.length} left: ${SCHEDULE_LIST_UNREADABLE}` })
      continue
    }
    const coveredBy = others.find(o => inSweep(o, dataset))
    if (coveredBy) {
      plans.push({ dataset, scope: 'excluded', prune: [], skippedHeld: [], note: `${mine.length} left to schedule '${coveredBy.id}'` })
      continue
    }
    const ours = mine.filter((s) => {
      const key = provenanceKey(s)
      return key !== null && taken.has(key)
    })
    const foreign = mine.length - ours.length
    const plan: DatasetPrunePlan = {
      dataset,
      scope: 'excluded',
      prune: ours.filter(s => s.held !== true),
      skippedHeld: ours.filter(s => s.held === true),
    }
    if (foreign > 0)
      plan.note = `${foreign} left: not taken by this schedule`
    plans.push(plan)
  }
  return plans
}

/** One dataset's prune outcome (the run result's per-dataset counts). */
export interface DatasetPruneResult {
  dataset: string
  scope: PruneScope
  pruned: ScheduledSnapshot[]
  skippedHeld: ScheduledSnapshot[]
  /** Destroys ZFS refused here (swept/excluded only — on the target one fails the run). */
  refused: number
  note?: string
}

/** A recursive prune's outcome: the flat lists plus the per-dataset breakdown. */
export interface RecursivePruneResult extends PruneResult {
  datasets: DatasetPruneResult[]
}

/**
 * Prune a recursive ZFS schedule across its sweep (snapprune.1): read the
 * tree's snapshots once, plan per dataset ({@link planRecursivePrune}), then
 * destroy one snapshot at a time, re-checking `userrefs` immediately before
 * each destroy — a snapshot held since the read is reported in
 * `skippedHeld`, never a failed destroy. A refused destroy on a swept or
 * excluded dataset is counted and noted there and the prune goes on; on the
 * target it throws. Progress is one line per dataset (a first run after an
 * upgrade can destroy thousands of snapshots).
 */
export async function pruneRecursiveSchedule(
  executor: CommandExecutor,
  schedule: SnapshotSchedule,
  opts: {
    others: ScheduleListRead
    now?: Date
    updateProgress?: (message: string) => void
  },
): Promise<RecursivePruneResult> {
  if (schedule.target.kind !== 'zfs')
    throw new Error('pruneRecursiveSchedule: ZFS schedules only')
  const progress = opts.updateProgress ?? noop
  const r = await run(executor, ZFS, zfsTreeSnapshotListArgs(schedule.target.dataset))
  const plans = planRecursivePrune({
    schedule,
    inventory: parseZfsTreeSnapshots(r.stdout),
    others: opts.others,
    now: opts.now ?? new Date(),
  })

  const datasets: DatasetPruneResult[] = []
  for (const plan of plans) {
    const pruned: ScheduledSnapshot[] = []
    const skippedHeld: ScheduledSnapshot[] = [...plan.skippedHeld]
    let refused = 0
    let refusedWhy = ''
    for (const snap of plan.prune) {
      const full = zfsSnapshotFullName(plan.dataset, snap.name)
      if (await zfsIsHeld(executor, full)) {
        skippedHeld.push({ ...snap, held: true })
        continue
      }
      try {
        await destroyScheduledZfsSnapshot(executor, plan.dataset, snap.name)
      }
      catch (err) {
        // Off the target a refusal (a clone depends on the snapshot) is noted
        // and the prune goes on; on the target it fails the run, as a failed
        // prune always has.
        if (plan.scope === 'target')
          throw err
        refused++
        refusedWhy ||= (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
        continue
      }
      pruned.push(snap)
    }
    const refusedNote = refused
      ? `${refused} left: destroy refused: ${refusedWhy}${refused > 1 ? ` (and ${refused - 1} more)` : ''}`
      : undefined
    const notes = [plan.note, refusedNote].filter(Boolean)
    const note = notes.length ? notes.join('; ') : undefined
    if (pruned.length || skippedHeld.length || note) {
      const parts = [`${pruned.length} destroyed`]
      if (skippedHeld.length)
        parts.push(`${skippedHeld.length} held`)
      if (note)
        parts.push(note)
      progress(`Pruned ${plan.dataset} (${plan.scope}): ${parts.join(', ')}`)
    }
    datasets.push({ dataset: plan.dataset, scope: plan.scope, pruned, skippedHeld, refused, ...(note ? { note } : {}) })
  }
  return {
    pruned: datasets.flatMap(d => d.pruned),
    skippedHeld: datasets.flatMap(d => d.skippedHeld),
    datasets,
  }
}

/**
 * The fire result of a recursive ZFS schedule: per-dataset counts, and the
 * destroyed and held names capped at {@link PRUNED_NAMES_PER_DATASET} per
 * dataset and at {@link PRUNED_NAMES_TOTAL} / {@link HELD_NAMES_TOTAL} in all
 * (`prunedCount`/`heldCount` and `datasets[]` carry the real counts). The first run after snapprune.1
 * can destroy thousands of child snapshots; this result is the job result,
 * the runner's journald line (LineMax 48 KiB) and the notification's input,
 * so it must stay small. A snapshot off the target is named
 * `<dataset>@<label>`, the target's by its bare label.
 */
export function recursiveRunResult(
  schedule: SnapshotSchedule,
  taken: string,
  prune: RecursivePruneResult,
): SnapshotScheduleRunResult {
  const target = schedule.target.kind === 'zfs' ? schedule.target.dataset : ''
  const named = (dataset: string, s: ScheduledSnapshot) => dataset === target ? s.name : `${dataset}@${s.name}`
  return {
    schedule: schedule.id,
    taken,
    pruned: prune.datasets
      .flatMap(d => d.pruned.slice(0, PRUNED_NAMES_PER_DATASET).map(s => named(d.dataset, s)))
      .slice(0, PRUNED_NAMES_TOTAL),
    prunedCount: prune.pruned.length,
    skippedHeld: prune.datasets
      .flatMap(d => d.skippedHeld.slice(0, PRUNED_NAMES_PER_DATASET).map(s => named(d.dataset, s)))
      .slice(0, HELD_NAMES_TOTAL),
    heldCount: prune.skippedHeld.length,
    datasets: prune.datasets.map(d => ({
      dataset: d.dataset,
      scope: d.scope,
      pruned: d.pruned.length,
      held: d.skippedHeld.length,
      ...(d.refused ? { refused: d.refused } : {}),
      ...(d.note ? { note: d.note } : {}),
    })),
  }
}
