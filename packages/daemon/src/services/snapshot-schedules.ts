import type {
  AhrPool,
  RetentionBucket,
  RetentionPolicy,
  ScheduledSnapshot,
  SnapshotTarget,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import { run } from './ahr-exec.js'
import { createAhrSnapshot, deleteAhrSnapshot, listAhrSnapshots } from './ahr-snapshots.js'
import { formatScheduledName, parseScheduledName } from './snapshot-naming.js'
import { planRetention } from './snapshot-retention.js'
import { createZfsSnapshot, destroyZfsSnapshot, zfsSnapshotFullName } from './zfs-snapshot.js'

/**
 * Uniform snapshot take/prune/list (Epic 17, stage 1). ONE service surface that
 * the operator drives IDENTICALLY for a ZFS dataset and an AHR pool; the only
 * place the two filesystems diverge is the dispatch on `target.kind`:
 *
 *   | verb  | ZFS                                    | AHR (reuses 11.12 primitives)          |
 *   |-------|----------------------------------------|----------------------------------------|
 *   | take  | `zfs snapshot [-r] <ds>@anas-<b>-<utc>` | ro btrfs snapshot `@data → @snapshots/…`|
 *   | list  | `zfs list -t snapshot -Hp -o …`        | `listAhrSnapshots` over `@snapshots/*`  |
 *   | prune | `zfs destroy` the plan's prune-set     | `btrfs subvolume delete` the prune-set  |
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
      await destroyZfsSnapshot(executor, { dataset: target.dataset, name: snap.name })
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
