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
import { HELD_NAMES_TOTAL, PRUNED_NAMES_PER_DATASET, PRUNED_NAMES_TOTAL, SCHEDULE_STAMP_PROPERTY } from '@anas/shared'
import { run } from './ahr-exec.js'
import { createAhrSnapshot, deleteAhrSnapshot, listAhrSnapshots } from './ahr-snapshots.js'
import { formatScheduledName, isTransientRunSnapshot, parseScheduledName } from './snapshot-naming.js'
import { effectiveRetention, planRetention } from './snapshot-retention.js'
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
 *   |       | (ident.1: `-o anas:schedule=<id>`)      |                                        |
 *   | list  | `zfs list -t snapshot -Hp -o …`        | `listAhrSnapshots` over `@snapshots/*`  |
 *   | prune | `zfs destroy`, per dataset, only the    | `btrfs subvolume delete` the prune-set  |
 *   |       | snapshots stamped with this schedule    |                                        |
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
  /**
   * ZFS only (story ident.1): the firing schedule's id, stamped on every
   * snapshot the take creates as `anas:schedule=<id>` in the same atomic verb.
   * Absent = no stamp (AHR ignores it: btrfs has no user properties).
   */
  scheduleId?: string
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
 * canonical `anas-<bucket>-<utc>` at `opts.now`. ZFS: `zfs snapshot [-r]`,
 * stamped `-o anas:schedule=<id>` when `opts.scheduleId` is given (ident.1 —
 * the stamp is set by the same atomic verb on every snapshot it creates); AHR:
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
    const properties = opts?.scheduleId ? { [SCHEDULE_STAMP_PROPERTY]: opts.scheduleId } : undefined
    if (opts?.recursive === true && exclude.length > 0)
      await createZfsSnapshotExcluding(executor, { dataset: target.dataset, name, exclude, properties })
    else
      await createZfsSnapshot(executor, { dataset: target.dataset, name, recursive: opts?.recursive === true, properties })
  }
  else {
    const pool = requirePool(target, opts)
    await createAhrSnapshot(executor, pool, name, opts?.updateProgress ?? noop, opts)
  }
  return { target, name, bucket }
}

// ---- List -------------------------------------------------------------------

/**
 * The columns every ZFS schedule inventory reads: `creation` and `userrefs`
 * for retention and held-safety, `createtxg` for ordering evidence, and the
 * `anas:schedule` stamp (ident.1) — ZFS prints `-` where it is unset.
 */
const ZFS_INVENTORY_COLUMNS = `name,creation,userrefs,createtxg,${SCHEDULE_STAMP_PROPERTY}`

/** `zfs list` argv for a dataset's own snapshots with retention columns. */
export function zfsScheduledListArgs(dataset: string): string[] {
  // -H: no header, tab-delimited; -p: parsable (creation as epoch seconds,
  // userrefs as an exact integer). Direct-only (no -r) — scoped to this dataset.
  return ['list', '-t', 'snapshot', '-Hp', '-o', ZFS_INVENTORY_COLUMNS, dataset]
}

/**
 * Parse `zfs list -t snapshot -Hp -o name,creation,userrefs[,createtxg,anas:schedule]`
 * output into the uniform inventory shape. Each line is
 * `<pool/ds@label>\t<epoch>\t<userrefs>[\t<txg>\t<stamp>]`; source is `anas`
 * iff the label parses as our naming convention, `held` iff `userrefs > 0` (a
 * `zfs hold`), `createdAt` is the ISO-UTC of `creation`, and `schedule` is the
 * stamp when one is set (`-` = unset).
 */
export function parseZfsScheduledSnapshots(target: SnapshotTarget, stdout: string): ScheduledSnapshot[] {
  const out: ScheduledSnapshot[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line)
      continue
    const [full, creation, userrefs, , stamp] = line.split('\t')
    const at = full.indexOf('@')
    if (at === -1)
      continue
    const label = full.slice(at + 1)
    const parsed = parseScheduledName(label)
    const epoch = Number.parseInt(creation ?? '', 10)
    const held = Number.parseInt(userrefs ?? '', 10) > 0
    const schedule = stampOf(stamp)
    out.push({
      name: label,
      target,
      bucket: parsed?.bucket ?? null,
      createdAt: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null,
      held,
      source: parsed ? 'anas' : 'other',
      ...(schedule ? { schedule } : {}),
    })
  }
  return out
}

/** The `anas:schedule` column's value, or undefined when unset (`-`) or unread. */
function stampOf(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim()
  return v && v !== '-' ? v : undefined
}

/**
 * List `target`'s snapshots as the uniform inventory. ZFS reads
 * `zfs list -t snapshot` (held detection via `userrefs`, the ident.1 stamp);
 * AHR reads `@snapshots/*` via the 11.12 list (never held — btrfs snapshots
 * aren't ZFS-held). Both mark `source`/`bucket` from the naming convention.
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

// ---- Prune (AHR) --------------------------------------------------------------

/** The result of a prune run: what was destroyed, and what was retained held. */
export interface PruneResult {
  /** Snapshots actually destroyed. */
  pruned: ScheduledSnapshot[]
  /** Held snapshots retained (never destroyed) — surfaced as intentionally kept. */
  skippedHeld: ScheduledSnapshot[]
}

/**
 * Apply `policy` to an AHR pool's `@snapshots/` and delete the over-retention
 * snapshots (`btrfs subvolume delete` via the 11.12 primitive; btrfs snapshots
 * are never held). The plan comes from the uniform `planRetention` engine;
 * only ANAS-named snapshots of buckets the policy names are ever deleted.
 *
 * ZFS schedules prune through {@link pruneZfsSchedule}: since ident.1 a ZFS
 * prune is decided by the snapshot's `anas:schedule` stamp, which needs the
 * firing schedule and the other schedules on the node, not a bare policy.
 */
export async function pruneSnapshots(
  executor: CommandExecutor,
  target: SnapshotTarget,
  policy: RetentionPolicy,
  opts?: SnapshotServiceOptions,
): Promise<PruneResult> {
  if (target.kind === 'zfs')
    throw new Error('pruneSnapshots: ZFS schedules prune by stamp — use pruneZfsSchedule')
  const pool = requirePool(target, opts)
  const inventory = await listScheduledSnapshots(executor, target, opts)
  const plan = planRetention(inventory, policy, opts?.now ?? new Date())
  const progress = opts?.updateProgress ?? noop
  const pruned: ScheduledSnapshot[] = []
  for (const snap of plan.prune) {
    progress(`Deleting @snapshots/${snap.name}`)
    await deleteAhrSnapshot(executor, pool, snap.name, progress, opts)
    pruned.push(snap)
  }
  return { pruned, skippedHeld: [...plan.skippedHeld] }
}

// ---- Prune (ZFS): by stamp, per dataset (ident.1 over snapprune.1) -----------
//
// A ZFS schedule's prune reads its snapshots ONCE (the whole subtree for a
// recursive schedule, the target alone otherwise), plans PER DATASET, and
// destroys one snapshot at a time with a live `userrefs` re-check (never
// `destroy -r`: one held child snapshot would fail the whole verb).
//
// Ownership is the `anas:schedule` stamp the take sets (ident.1, audit #1):
// a snapshot is this schedule's iff it carries this schedule's id. A snapshot
// stamped with any other id (another schedule, a deleted one, a sender's on a
// received snapshot) is never a candidate. An UNSTAMPED `anas-<bucket>-*`
// snapshot (taken before 0.4.2, or by hand) is a candidate only where this
// schedule is the ONLY enabled schedule covering the dataset — the legacy
// convergence case; anywhere else it is left with a per-dataset note. That
// rule needs the complete schedule list, so when the list could not be read
// whole no unstamped snapshot is a candidate anywhere that run (fail-safe,
// noted {@link SCHEDULE_LIST_UNREADABLE}); stamped ones are still pruned —
// the stamp needs no list.
//
//   - target   — the schedule's policy ({@link effectiveRetention}) over its
//                candidates.
//   - sweep    — every other dataset a recursive schedule snapshots: the same
//                policy over the same kind of candidates. The stamp replaces
//                snapprune.1's most-generous-count rule: a child's own
//                schedule's snapshots carry the child schedule's id and are
//                never this schedule's to prune.
//   - excluded — a dataset under the target outside the sweep: the snapshots
//                this schedule stamped there before the exclude are destroyed
//                outright (held ones reported), PVE-owned or not — they are
//                ANAS's own leftovers. Unstamped ones are left with a note: the
//                stamp replaces the name + txg + creation witness rule.
//
// Buckets: a bucket absent from the policy is left alone (planRetention), and
// the schedule's own cadence bucket is always present (effectiveRetention).
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

/**
 * The note a dataset carries when the schedule-list fail-safe engaged (the
 * other schedules could not be read whole, so no unstamped snapshot there was
 * pruned). A run with any such note is a `warning`, never a quiet success
 * (snapshot-notify.ts).
 */
export const SCHEDULE_LIST_UNREADABLE = 'schedule list unreadable'

/** The note for unstamped snapshots on a dataset another enabled schedule also covers. */
export const UNSTAMPED_SHARED = 'unstamped, more than one schedule here'

/** The note for unstamped snapshots on a dataset outside this schedule's sweep. */
export const UNSTAMPED_OUTSIDE = 'unstamped, outside this schedule\'s sweep'

/** `zfs list` argv for a schedule's inventory: the whole tree (`-r`) or the dataset alone. */
export function zfsTreeSnapshotListArgs(dataset: string, recursive = true): string[] {
  // -r: the whole subtree in ONE read.
  return ['list', '-t', 'snapshot', '-Hp', '-o', ZFS_INVENTORY_COLUMNS, ...(recursive ? ['-r'] : []), dataset]
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
    const cols = line.split('\t')
    const full = cols[0]
    const at = full.indexOf('@')
    if (at === -1)
      continue
    const dataset = full.slice(0, at)
    const [snap] = parseZfsScheduledSnapshots({ kind: 'zfs', dataset }, line)
    if (!snap)
      continue
    const list = byDataset.get(dataset) ?? []
    list.push({ ...snap, createtxg: (cols[3] ?? '').trim() })
    byDataset.set(dataset, list)
  }
  return byDataset
}

/** One dataset's slice of a ZFS schedule's prune plan. */
export interface DatasetPrunePlan {
  dataset: string
  scope: PruneScope
  /** Snapshots to destroy, in plan order. */
  prune: TreeSnapshot[]
  /** Held snapshots the plan sets aside (retained, reported). */
  skippedHeld: TreeSnapshot[]
  /** Why snapshots of this schedule's buckets were left in place, when some were. */
  note?: string
}

/** What {@link planZfsSchedulePrune} needs to know about the world. */
export interface ZfsSchedulePruneInput {
  /** The ZFS schedule being fired. */
  schedule: SnapshotSchedule
  /** The schedule's inventory, per dataset ({@link parseZfsTreeSnapshots}). */
  inventory: Map<string, TreeSnapshot[]>
  /**
   * Every schedule on the node (read from the unit files; the fired one is
   * skipped by id), and whether that read was COMPLETE. When it was not, no
   * unstamped snapshot is a candidate anywhere.
   */
  others: ScheduleListRead
  now: Date
}

/**
 * The per-dataset prune plan of a ZFS schedule (ident.1 over snapprune.1) —
 * pure. See the section note above for ownership and the three scopes. The
 * target always comes first and is always present; other datasets appear
 * only when there is something to destroy or report.
 */
export function planZfsSchedulePrune(input: ZfsSchedulePruneInput): DatasetPrunePlan[] {
  const { schedule, inventory, now } = input
  if (schedule.target.kind !== 'zfs')
    return []
  const target = schedule.target.dataset
  const policy = effectiveRetention(schedule)
  const listComplete = input.others.complete
  const covering = input.others.schedules.filter(o => o.enabled && o.id !== schedule.id && o.target.kind === 'zfs')
  const plans: DatasetPrunePlan[] = []

  const datasets = [target, ...[...inventory.keys()].filter(ds => ds !== target && ds.startsWith(`${target}/`))]
  for (const dataset of datasets) {
    const anas = (inventory.get(dataset) ?? []).filter(s => s.source === 'anas' && !isTransientRunSnapshot(s.name))
    const stamped = anas.filter(s => s.schedule === schedule.id)
    const unstamped = anas.filter(s => s.schedule === undefined)
    // The unstamped snapshots this schedule's policy would plan — the ones a
    // note about leaving them is about (an absent bucket is never planned).
    const unstampedPlanned = unstamped.filter(s => s.bucket !== null && policy[s.bucket] !== undefined).length
    const scope: PruneScope = dataset === target ? 'target' : inSweep(schedule, dataset) ? 'sweep' : 'excluded'

    let plan: DatasetPrunePlan
    if (scope === 'excluded') {
      // Outside the sweep: this schedule's own stamped leftovers go outright.
      plan = {
        dataset,
        scope,
        prune: stamped.filter(s => s.held !== true),
        skippedHeld: stamped.filter(s => s.held === true),
      }
      if (unstampedPlanned > 0)
        plan.note = `${unstampedPlanned} left: ${UNSTAMPED_OUTSIDE}`
    }
    else {
      // The legacy convergence case: unstamped snapshots are this schedule's
      // only where it is the one enabled schedule covering the dataset, and
      // only when that can be known (a complete list).
      const legacy = listComplete && !covering.some(o => inSweep(o, dataset))
      const retention = planRetention(legacy ? [...stamped, ...unstamped] : stamped, policy, now)
      plan = {
        dataset,
        scope,
        prune: retention.prune as TreeSnapshot[],
        skippedHeld: retention.skippedHeld as TreeSnapshot[],
      }
      if (!legacy && unstampedPlanned > 0)
        plan.note = `${unstampedPlanned} left: ${listComplete ? UNSTAMPED_SHARED : SCHEDULE_LIST_UNREADABLE}`
    }
    if (scope === 'target' || plan.prune.length || plan.skippedHeld.length || plan.note)
      plans.push(plan)
  }
  return plans
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

/** A ZFS schedule prune's outcome: the flat lists plus the per-dataset breakdown. */
export interface RecursivePruneResult extends PruneResult {
  datasets: DatasetPruneResult[]
}

/**
 * Prune a ZFS schedule (ident.1 over snapprune.1): read its inventory once
 * (`-r` for a recursive schedule), plan per dataset
 * ({@link planZfsSchedulePrune}), then destroy one snapshot at a time,
 * re-checking `userrefs` immediately before each destroy — a snapshot held
 * since the read is reported in `skippedHeld`, never a failed destroy. A
 * refused destroy on a swept or excluded dataset is counted and noted there
 * and the prune goes on; on the target it throws. Progress is one line per
 * dataset (a first run after an upgrade can destroy thousands of snapshots).
 */
export async function pruneZfsSchedule(
  executor: CommandExecutor,
  schedule: SnapshotSchedule,
  opts: {
    others: ScheduleListRead
    now?: Date
    updateProgress?: (message: string) => void
  },
): Promise<RecursivePruneResult> {
  if (schedule.target.kind !== 'zfs')
    throw new Error('pruneZfsSchedule: ZFS schedules only')
  const progress = opts.updateProgress ?? noop
  const r = await run(executor, ZFS, zfsTreeSnapshotListArgs(schedule.target.dataset, schedule.recursive === true))
  const plans = planZfsSchedulePrune({
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
 * The fire result of a ZFS schedule: per-dataset counts, and the
 * destroyed and held names capped at {@link PRUNED_NAMES_PER_DATASET} per
 * dataset and at {@link PRUNED_NAMES_TOTAL} / {@link HELD_NAMES_TOTAL} in all
 * (`prunedCount`/`heldCount` and `datasets[]` carry the real counts). The first run after snapprune.1
 * can destroy thousands of child snapshots; this result is the job result,
 * the runner's journald line (LineMax 48 KiB) and the notification's input,
 * so it must stay small. A snapshot off the target is named
 * `<dataset>@<label>`, the target's by its bare label. A NON-recursive
 * schedule carries `datasets` only when its one entry has a note (ident.1:
 * unstamped snapshots left) — otherwise the totals say it all, as before.
 */
export function zfsRunResult(
  schedule: SnapshotSchedule,
  taken: string,
  prune: RecursivePruneResult,
): SnapshotScheduleRunResult {
  const target = schedule.target.kind === 'zfs' ? schedule.target.dataset : ''
  const named = (dataset: string, s: ScheduledSnapshot) => dataset === target ? s.name : `${dataset}@${s.name}`
  const perDataset = schedule.recursive === true || prune.datasets.some(d => d.note || d.refused)
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
    ...(perDataset
      ? {
          datasets: prune.datasets.map(d => ({
            dataset: d.dataset,
            scope: d.scope,
            pruned: d.pruned.length,
            held: d.skippedHeld.length,
            ...(d.refused ? { refused: d.refused } : {}),
            ...(d.note ? { note: d.note } : {}),
          })),
        }
      : {}),
  }
}
