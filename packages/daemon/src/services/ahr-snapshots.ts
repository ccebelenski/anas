import type { AhrPool, AhrSnapshot } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AhrSnapshotName } from '@anas/shared'
import {
  btrfsSubvolListArgs,
  btrfsSubvolListReadonlyArgs,
  btrfsSubvolListSnapshotsArgs,
  otimeToIso,
  parseBtrfsSubvolList,
} from '../parsers/btrfs-subvol-list.js'
import { run } from './ahr-exec.js'
import { diagnoseBusyPath, formatHolders } from './busy-diagnosis.js'

/**
 * AHR btrfs subvolume snapshots (story 11.12, docs/AHR-DESIGN.md §12).
 *
 * Layout: new pools carry `@data` (mounted at the pool mountpoint via
 * `subvol=@data`) and `@snapshots` (OUTSIDE the mounted tree). Because
 * snapshots live outside `@data`, they never nest into the data, and rollback
 * is a subvolume SWAP that destroys nothing.
 *
 * Operations that touch `@snapshots`/`@data` mount the filesystem TOP-LEVEL
 * (`subvolid=5`) on demand at a private runtime path and unmount after EVERY
 * op — nothing new stays mounted (a mount → op → finally-unmount pattern).
 * Listing is the exception: `btrfs subvolume list` enumerates the WHOLE
 * filesystem from any path in it, so it reads the live `@data` mount directly
 * with no extra mount.
 *
 * Sizes are absent everywhere — per-snapshot usage needs btrfs qgroups, OUT of
 * v1 (§12): no number beats a wrong/unlabeled one.
 */

const BTRFS = '/usr/bin/btrfs'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const MV = '/usr/bin/mv'
const FINDMNT = '/usr/bin/findmnt'

/** Leading-slash strip for a `subvol=/@data` value. */
const LEADING_SLASH_RE = /^\/+/
/** Trailing `.<ms>Z` of an ISO timestamp. */
const ISO_MILLIS_RE = /\.\d+Z$/
/** Colons in an ISO timestamp (stripped for a filesystem-safe path segment). */
const COLON_RE = /:/g

/** The `@data` subvolume — mounted at the pool mountpoint via `subvol=@data`. */
export const SUBVOL_DATA = '@data'
/** The `@snapshots` subvolume — the snapshot home, outside the mounted tree. */
export const SUBVOL_SNAPSHOTS = '@snapshots'

/** Default runtime base for the on-demand top-level mount (/run = tmpfs). */
export const DEFAULT_SUBVOL_RUNTIME_DIR = '/run/anas-ahr'

/** Options common to the snapshot service (tests point the runtime dir at a temp path). */
export interface AhrSnapshotOptions {
  /** Base dir for the on-demand top-level mountpoint. Default: env / /run/anas-ahr. */
  runtimeDir?: string
}

function runtimeBase(opts?: AhrSnapshotOptions): string {
  return opts?.runtimeDir ?? process.env.ANAS_AHR_SUBVOL_RUNTIME_DIR ?? DEFAULT_SUBVOL_RUNTIME_DIR
}

/** The LV device path of a pool (`/dev/<vg>/<lv>`). */
function lvDevice(pool: AhrPool): string {
  return `/dev/${pool.name}/${pool.lv.name}`
}

// ---- subvolLayout detection (topology + guards) -----------------------------

/**
 * The `subvol=` value from a mount's option string, e.g. "/@data" or "/".
 * Null when the option is absent (non-btrfs, or an old kernel that omits it).
 */
export function subvolFromMountOptions(options: string): string | null {
  for (const token of options.split(',')) {
    const eq = token.indexOf('=')
    if (eq > 0 && token.slice(0, eq) === 'subvol')
      return token.slice(eq + 1)
  }
  return null
}

/**
 * Whether a mount's options say it is the §12 subvolume layout — i.e. the
 * filesystem is mounted with `subvol=@data` (btrfs normalizes to `/@data`).
 * A flat pool mounts the top-level (`subvol=/`, `subvolid=5`) and returns
 * false. The mount is the source of truth (§5.3) — nothing is precomputed.
 */
export function isSubvolLayoutMount(options: string): boolean {
  const subvol = subvolFromMountOptions(options)
  if (subvol === null)
    return false
  const normalized = subvol.replace(LEADING_SLASH_RE, '') // "/@data" → "@data"
  return normalized === SUBVOL_DATA
}

// ---- On-demand top-level mount ----------------------------------------------

/**
 * Per-mountpoint-path serialization for the on-demand top-level mount. Two
 * concurrent snapshot jobs for the SAME pool would otherwise stack mounts on
 * the one `/run/anas-ahr/<pool>.toplevel` path (JobQueue concurrency is 4 and
 * the routes gate only on expansion intents) — the inner umount then leaves an
 * outer mount live, and any cleanup of the path would be operating over a
 * still-mounted btrfs top-level. Serializing on the mnt path makes stacking
 * impossible; distinct pools (distinct paths) still run concurrently. The map
 * holds at most one (non-rejecting) tail per path — bounded by pool count.
 */
const topLevelMountChains = new Map<string, Promise<unknown>>()

function serializeOnPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = topLevelMountChains.get(path) ?? Promise.resolve()
  const result = prev.then(task, task)
  topLevelMountChains.set(path, result.then(() => undefined, () => undefined))
  return result
}

/** Is `path` still an active mountpoint? (findmnt reads the kernel table only.) */
async function isStillMountpoint(executor: CommandExecutor, path: string): Promise<boolean> {
  const r = await executor.exec(FINDMNT, ['--mountpoint', path])
  return r.exitCode === 0
}

/**
 * Mount the pool's filesystem TOP-LEVEL (`subvolid=5`, so `@data`/`@snapshots`
 * are both reachable) at a private runtime path, run `fn`, and ALWAYS tear
 * down afterwards — nothing new stays mounted (§12). The runtime path is
 * pool-scoped under /run (tmpfs, root-owned).
 *
 * Teardown safety (data-loss critical): the mountpoint is NEVER recursively
 * removed — a recursive rm over a still-mounted btrfs top-level would unlink
 * pool DATA. Instead: umount, and only remove the directory with a
 * non-recursive `rmdir` (which cannot delete a non-empty/mounted dir — it just
 * fails harmlessly). If the umount fails AND the path is verifiably still a
 * mountpoint, the leak is surfaced LOUDLY (a job error) rather than swallowed,
 * and nothing is removed. Concurrent ops on the same pool are serialized so
 * two jobs can never stack mounts on the one path.
 */
export async function withTopLevelMount<T>(
  executor: CommandExecutor,
  pool: AhrPool,
  fn: (topLevelPath: string) => Promise<T>,
  opts?: AhrSnapshotOptions,
): Promise<T> {
  const mnt = join(runtimeBase(opts), `${pool.name}.toplevel`)
  return serializeOnPath(mnt, async () => {
    await mkdir(mnt, { recursive: true })
    await run(executor, MOUNT, ['-t', 'btrfs', '-o', 'subvolid=5', lvDevice(pool), mnt])

    let opError: unknown
    let result!: T
    let ok = false
    try {
      result = await fn(mnt)
      ok = true
    }
    catch (err) {
      opError = err
    }

    // Teardown. A failed unmount must not mask the op's own error, but a
    // genuinely leaked (still-mounted) path must surface loudly.
    const um = await executor.exec(UMOUNT, ['--', mnt])
    if (um.exitCode !== 0 && await isStillMountpoint(executor, mnt)) {
      // Do NOT remove anything — the top-level is still mounted; a recursive
      // wipe here is the data-loss the whole guard exists to prevent. Name the
      // holders keeping it mounted (story 3.29) so "free any holder" is actionable.
      const clause = formatHolders(await diagnoseBusyPath(executor, mnt))
      const holderSuffix = clause ? ` — ${clause}` : ''
      const leak = new Error(
        `failed to unmount the on-demand top-level mount at '${mnt}' for pool '${pool.name}' `
        + `(${um.stderr.trim() || `umount exited ${um.exitCode}`}) — it is still mounted; `
        + `left in place to protect pool data. Free any holder and retry.${holderSuffix}`,
      )
      if (!ok)
        throw opError // the op's own failure is the more informative one
      throw leak
    }
    // Unmounted (or the umount 'failure' was a transient the path already
    // cleared): non-recursive rmdir only — best-effort, never recursive.
    await rmdir(mnt).catch(() => {})
    if (!ok)
      throw opError
    return result
  })
}

// ---- Naming -----------------------------------------------------------------

/** A compact UTC stamp usable as a single path segment (no `:`), e.g. 2026-07-23T142301Z. */
function utcStamp(now: Date): string {
  return now.toISOString().replace(ISO_MILLIS_RE, 'Z').replace(COLON_RE, '')
}

/** The default snapshot name when the operator supplies none — a UTC timestamp. */
export function defaultSnapshotName(now: Date = new Date()): string {
  return utcStamp(now)
}

/** The auto-preserve name for a rollback's outgoing `@data` (§12): pre-rollback-<ts>. */
export function preRollbackName(now: Date = new Date()): string {
  return `pre-rollback-${utcStamp(now)}`
}

// ---- List (GET /v1/ahr/:name/snapshots) -------------------------------------

const SNAP_PREFIX = `${SUBVOL_SNAPSHOTS}/`

/**
 * List a pool's snapshots (§12). Enumerates EVERY direct `@snapshots/<name>`
 * child from the PLAIN `btrfs subvolume list` — not `-s` — because a
 * `pre-rollback-<ts>` preserve of a former `@data` is a plain subvolume, NOT
 * a btrfs "snapshot", and `-s` would omit exactly the state the rollback
 * confirm promises is kept. `-s` still supplies `otime` (createdAt, joined by
 * path — null for a plain preserve) and `-r` the read-only set (false for
 * the writable preserve). An unmounted pool has nothing to list.
 */
export async function listAhrSnapshots(
  executor: CommandExecutor,
  pool: AhrPool,
  opts?: AhrSnapshotOptions,
): Promise<AhrSnapshot[]> {
  if (!pool.mounted)
    return []
  return withListPath(executor, pool, async (path) => {
    const [allRes, snapRes, roRes] = await Promise.all([
      executor.exec(BTRFS, btrfsSubvolListArgs(path)),
      executor.exec(BTRFS, btrfsSubvolListSnapshotsArgs(path)),
      executor.exec(BTRFS, btrfsSubvolListReadonlyArgs(path)),
    ])
    // otime comes only from `-s` (snapshots) — join by path; a plain preserve
    // has no otime row, so its createdAt is null (never fabricated).
    const otimeByPath = new Map(
      snapRes.exitCode === 0
        ? parseBtrfsSubvolList(snapRes.stdout).map(s => [s.path, s.otime] as const)
        : [],
    )
    const readonlyPaths = new Set(
      roRes.exitCode === 0 ? parseBtrfsSubvolList(roRes.stdout).map(s => s.path) : [],
    )
    const out: AhrSnapshot[] = []
    if (allRes.exitCode !== 0)
      return out
    for (const sub of parseBtrfsSubvolList(allRes.stdout)) {
      if (!sub.path.startsWith(SNAP_PREFIX))
        continue
      const name = sub.path.slice(SNAP_PREFIX.length)
      if (name.includes('/') || !AhrSnapshotName.safeParse(name).success)
        continue // never our snapshot — skip rather than corrupt the list
      out.push({
        name,
        createdAt: otimeToIso(otimeByPath.get(sub.path) ?? null),
        readonly: readonlyPaths.has(sub.path),
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }, opts)
}

/**
 * The path `btrfs subvolume list` runs against: the live `@data` mount when the
 * pool is mounted with the subvolume layout (cheap — no extra mount); otherwise
 * the on-demand top-level mount. Listing sees the whole filesystem either way.
 */
async function withListPath<T>(
  executor: CommandExecutor,
  pool: AhrPool,
  fn: (path: string) => Promise<T>,
  opts?: AhrSnapshotOptions,
): Promise<T> {
  if (pool.mounted && pool.subvolLayout)
    return fn(pool.mountpoint)
  return withTopLevelMount(executor, pool, fn, opts)
}

// ---- Create (POST /v1/ahr/:name/snapshots) ----------------------------------

/**
 * Take a READ-ONLY snapshot of `@data` into `@snapshots/<name>` (§12). Mounts
 * the top-level on demand, snapshots, and unmounts. `name` is charset-validated
 * by the route (and again here at the boundary).
 */
export async function createAhrSnapshot(
  executor: CommandExecutor,
  pool: AhrPool,
  name: string,
  updateProgress: (message: string) => void,
  opts?: AhrSnapshotOptions,
): Promise<{ pool: string, snapshot: string }> {
  const snapName = AhrSnapshotName.parse(name)
  return withTopLevelMount(executor, pool, async (top) => {
    updateProgress(`Creating read-only snapshot @snapshots/${snapName}`)
    await run(executor, BTRFS, [
      'subvolume',
      'snapshot',
      '-r',
      join(top, SUBVOL_DATA),
      join(top, SUBVOL_SNAPSHOTS, snapName),
    ])
    return { pool: pool.name, snapshot: snapName }
  }, opts)
}

// ---- Delete (DELETE /v1/ahr/:name/snapshots/:snap) --------------------------

/**
 * Delete a snapshot (§12): `btrfs subvolume delete @snapshots/<name>`, under
 * an on-demand top-level mount. Confirm-gated at the route.
 */
export async function deleteAhrSnapshot(
  executor: CommandExecutor,
  pool: AhrPool,
  name: string,
  updateProgress: (message: string) => void,
  opts?: AhrSnapshotOptions,
): Promise<{ pool: string, deleted: string }> {
  const snapName = AhrSnapshotName.parse(name)
  return withTopLevelMount(executor, pool, async (top) => {
    updateProgress(`Deleting snapshot @snapshots/${snapName}`)
    await run(executor, BTRFS, ['subvolume', 'delete', join(top, SUBVOL_SNAPSHOTS, snapName)])
    return { pool: pool.name, deleted: snapName }
  }, opts)
}

// ---- Rollback (POST /v1/ahr/:name/snapshots/:snap/rollback) ------------------

/**
 * Roll the pool back to a snapshot (§12) — destroying NOTHING, ever:
 *
 *   unmount the pool mountpoint (brief)
 *     → mount top-level
 *       → PRESERVE the current `@data` by RENAME to `@snapshots/pre-rollback-<ts>`
 *         (instant — no copy; the replaced state is kept, never destroyed)
 *       → make a WRITABLE snapshot of the chosen snapshot the new `@data`
 *     → unmount top-level (finally)
 *   → remount the pool mountpoint (finally — fstab still carries subvol=@data)
 *
 * The preserve-rename happens BEFORE the swap; the pool mountpoint is always
 * remounted in a finally, even if the swap fails midway.
 */
export async function rollbackAhrSnapshot(
  executor: CommandExecutor,
  pool: AhrPool,
  name: string,
  updateProgress: (message: string) => void,
  opts?: AhrSnapshotOptions & { now?: Date },
): Promise<{ pool: string, rolledBackTo: string, preserved: string }> {
  const snapName = AhrSnapshotName.parse(name)
  const preserved = preRollbackName(opts?.now ?? new Date())

  if (pool.mounted) {
    updateProgress(`Unmounting ${pool.mountpoint}`)
    await run(executor, UMOUNT, ['--', pool.mountpoint], { busyPath: pool.mountpoint })
  }
  try {
    await withTopLevelMount(executor, pool, async (top) => {
      const dataPath = join(top, SUBVOL_DATA)
      const chosenPath = join(top, SUBVOL_SNAPSHOTS, snapName)
      const preservedPath = join(top, SUBVOL_SNAPSHOTS, preserved)
      // 1) Preserve the current @data — a btrfs subvolume is a directory entry,
      // so `mv` within the same filesystem is an instant RENAME. Nothing is
      // destroyed: the replaced state lives on as @snapshots/pre-rollback-<ts>.
      updateProgress(`Preserving current @data as @snapshots/${preserved}`)
      await run(executor, MV, ['--', dataPath, preservedPath])
      // 2) The swap: a WRITABLE snapshot of the chosen snapshot becomes @data.
      updateProgress(`Rolling @data back to @snapshots/${snapName}`)
      await run(executor, BTRFS, ['subvolume', 'snapshot', chosenPath, dataPath])
    }, opts)
  }
  finally {
    // Remount the pool mountpoint no matter what — a half-done rollback must
    // never leave the pool offline (fstab still has the subvol=@data entry).
    updateProgress(`Remounting ${pool.mountpoint}`)
    await executor.exec(MOUNT, ['--', pool.mountpoint])
  }
  return { pool: pool.name, rolledBackTo: snapName, preserved }
}
