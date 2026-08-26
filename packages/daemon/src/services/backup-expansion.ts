import type {
  BackupArchiveConsistency,
  BackupExpandedArchive,
  BackupIncludeNested,
  BackupNestedEntry,
  BackupNestedScan,
} from '@anas/shared'
import { expandedArchiveName, isPathWithin } from '@anas/shared'
import { isUnwalkableKind, normalizePath, relativeTo } from './nested-filesystems.js'

/**
 * ARCHIVE EXPANSION for a snapshot-consistent run (story backup2.3).
 *
 * A snapshot captures ONE filesystem. That is true on both backends and it is
 * the reason this module exists:
 *
 *   - ZFS: `zfs snapshot -r <ds>@<s>` gives every descendant dataset its own
 *     snapshot under the same label, but each of those is reachable only through
 *     that dataset's OWN `.zfs/snapshot/<s>` — a walk of the parent's snapshot
 *     sees the child's mountpoint as an empty directory.
 *   - AHR/btrfs: worse, and proven (GT-52/55). A read-only snapshot of `@data`
 *     leaves every nested subvolume as an EMPTY PLACEHOLDER, and
 *     `--all-file-systems` cannot rescue it — there is nothing under the
 *     placeholder to recurse into. Backing up a single `@data` snapshot would
 *     SILENTLY LOSE every nested subvolume.
 *
 * So one configured archive becomes N+1 archives at run time: the root, plus one
 * per nested filesystem the backup2.2 scan reports as INCLUDED. `includeNested`
 * still decides WHICH children are included — `none` yields the root archive
 * alone (with backup2.2's existing "stored as an empty directory" warnings),
 * `all` / a path list yields the expansion.
 *
 * TWO INVARIANTS THAT ARE NOT NEGOTIABLE:
 *
 *   1. **The ROOT archive keeps its configured name, byte for byte**, and the
 *      task's `--backup-id` is untouched. That pair is what preserves pbc's
 *      change-detection reference across the live→snapshot switch — proven in
 *      GT-47/48/49/50: inodes are identical, `st_dev` is not part of the
 *      reference, and the first snapshot-mode run reused 100% and uploaded zero
 *      bytes. Rename the root archive and a 10 TB source is re-read.
 *   2. **Child names are deterministic**: `<name>__<relative path with / → _>`,
 *      sanitised to PBS's `[A-Za-z0-9_-]`. The same task always produces the
 *      same set, so the previous run's reference matches this run's.
 */

/** One archive to expand, with everything the plan needs about it. */
export interface ExpansionInput {
  archive: { name: string, path: string, excludes: string[], includeNested?: BackupIncludeNested }
  /** The derived consistency (backup-consistency.ts). */
  consistency: BackupArchiveConsistency
  /** The backup2.2 boundary scan for this source (absent = nothing to expand). */
  scan?: BackupNestedScan
  /** This run's transient snapshot label (`anas-backup-<task>-<ts>`). */
  snapshot: string
  /** AHR only: the on-demand top-level mount path of the archive's pool. */
  topLevel?: string
}

/** What one expansion pass produced. */
export interface ExpansionPlan {
  /** The archives pbc is handed, root first, children in path order. */
  archives: BackupExpandedArchive[]
  /** Honest notes — a nested filesystem that could not come along, a rebase. */
  warnings: string[]
  /**
   * AHR only: the `@data`-relative subvolume paths that need their OWN read-only
   * snapshot, keyed by the snapshot label to give them. The runner takes these
   * BEFORE it mounts anything for the run (GT-52 — one `@data` snapshot is not
   * enough).
   */
  ahrSubvolumeSnapshots: { label: string, subvolume: string }[]
}

/** `<a>/<b>` with exactly one separator; an empty `b` yields `a`. */
function joinPath(a: string, b: string): string {
  const base = normalizePath(a)
  if (!b)
    return base
  return base === '/' ? `/${b}` : `${base}/${b}`
}

/**
 * The absolute root of the ROOT archive under this run's snapshot.
 *
 *   ZFS: `<dataset mountpoint>/.zfs/snapshot/<s>/<relative>`. GT-51 — reachable
 *        with the default `snapdir=hidden`; no property is changed.
 *   AHR: `<top-level mount>/@snapshots/<s>/<relative>` — `@snapshots` lives
 *        OUTSIDE the mounted `@data` tree (Epic 11 §12), so the run mounts the
 *        filesystem top-level on demand to reach it.
 */
export function snapshotRoot(consistency: BackupArchiveConsistency, snapshot: string, topLevel?: string): string | null {
  const relative = consistency.relativePath ?? ''
  if (consistency.backend === 'zfs' && consistency.mountpoint)
    return joinPath(joinPath(consistency.mountpoint, `.zfs/snapshot/${snapshot}`), relative)
  if (consistency.backend === 'ahr' && topLevel)
    return joinPath(joinPath(topLevel, `@snapshots/${snapshot}`), relative)
  return null
}

/**
 * Can this nested filesystem come along as its OWN archive root under the given
 * backend? Only a filesystem the run's snapshot verb actually covered can.
 *
 *   ZFS — a child DATASET of the snapshotted dataset. `zfs snapshot -r` gave it
 *         the same label, so `<child mountpoint>/.zfs/snapshot/<s>` exists. A
 *         dataset from a DIFFERENT pool that happens to be mounted underneath
 *         was NOT covered by our recursive snapshot, and is refused by name.
 *   AHR — a btrfs subvolume; the run takes a separate ro snapshot of each.
 *
 * Everything else (remote mounts, foreign local filesystems, pmxcfs, armed
 * automounts) is NOT snapshottable and cannot be reached from a snapshot root
 * at all — see {@link planExpansion}'s warning.
 */
export function isSnapshottableChild(entry: BackupNestedEntry, consistency: BackupArchiveConsistency): boolean {
  if (consistency.backend === 'zfs') {
    if (entry.kind !== 'dataset' || !entry.source || !consistency.target)
      return false
    // The recursive snapshot covered `<target>` and its descendants only.
    return entry.source.startsWith(`${consistency.target}/`)
  }
  if (consistency.backend === 'ahr')
    return entry.kind === 'subvolume'
  return false
}

/**
 * The expanded roots one archive produces, and the AHR subvolume snapshots they
 * need. Root first, then the included children in path order.
 *
 * `includeNested` decides membership — this function never second-guesses it. A
 * child the choice does NOT cover is simply absent (backup2.2's own warnings
 * already say it will be stored as an empty directory); a child the choice DOES
 * cover but the snapshot could not capture gets an explicit warning here,
 * because that omission is new with snapshot mode and nothing else would report
 * it.
 */
export function planExpansion(input: ExpansionInput): ExpansionPlan {
  const { archive, consistency, scan, snapshot, topLevel } = input
  const warnings: string[] = []
  const ahrSubvolumeSnapshots: { label: string, subvolume: string }[] = []

  const root = snapshotRoot(consistency, snapshot, topLevel)
  if (consistency.consistency !== 'snapshot' || !root) {
    // Live archive: exactly one root, the configured path, no expansion at all.
    return {
      archives: [{ name: archive.name, from: archive.name, root: normalizePath(archive.path), relativePath: '', excludes: [...archive.excludes] }],
      warnings,
      ahrSubvolumeSnapshots,
    }
  }

  const source = normalizePath(archive.path)
  // The scan's own `included` flag is the authority, NOT a fresh read of
  // `includeNested`: `resolveNestedIncludes` already corrected it to false
  // wherever an `all` choice could not be fully resolved (a truncated or failed
  // walk), and the run crossed nothing there. Recomputing from the stored choice
  // would expand children this run deliberately did not cross.
  const included = (scan?.nested ?? []).filter(n => n.included)

  // The root archive KEEPS ITS NAME (change-detection continuity, GT-47/48).
  const expanded: (BackupExpandedArchive & { livePath: string })[] = [
    { name: archive.name, from: archive.name, root, relativePath: '', excludes: [], livePath: source },
  ]
  const taken = new Set<string>([archive.name])

  for (const entry of included) {
    const relative = relativeTo(source, entry.path)
    if (!relative)
      continue
    if (!isSnapshottableChild(entry, consistency)) {
      const fs = consistency.backend === 'ahr' ? 'btrfs' : 'ZFS'
      const hint = isUnwalkableKind(entry.kind) ? ' Back a remote mount up as its own archive if you need it.' : ''
      warnings.push(
        `archive '${archive.name}': nested filesystem ${entry.path} (${entry.kind}) is included by the task, but a ${fs} snapshot does not capture it - under the snapshot root it is an empty directory and no client flag can reach the live mount from there. It was NOT backed up by this run.${hint}`,
      )
      continue
    }
    const name = uniqueName(expandedArchiveName(archive.name, relative), taken)
    taken.add(name)
    if (consistency.backend === 'ahr') {
      // GT-52: one ro snapshot per subvolume, because a single `@data` snapshot
      // leaves each nested one an empty placeholder.
      const subvolume = relativeTo(consistency.mountpoint ?? source, entry.path)
      const label = `${snapshot}__${suffixOf(name, archive.name)}`
      ahrSubvolumeSnapshots.push({ label, subvolume })
      expanded.push({
        name,
        from: archive.name,
        root: joinPath(topLevel as string, `@snapshots/${label}`),
        relativePath: relative,
        excludes: [],
        livePath: entry.path,
      })
      continue
    }
    // ZFS: the child dataset's own `.zfs/snapshot/<s>` — the recursive snapshot
    // gave it the same label (GT-51: reachable with `snapdir=hidden`).
    expanded.push({
      name,
      from: archive.name,
      root: joinPath(entry.path, `.zfs/snapshot/${snapshot}`),
      relativePath: relative,
      excludes: [],
      livePath: entry.path,
    })
  }

  // Excludes: each pattern lands on the root it belongs to.
  const rebased = rebaseExcludes(source, archive.excludes, expanded)
  warnings.push(...rebased.warnings)
  for (const e of expanded)
    e.excludes = rebased.byName[e.name] ?? []

  return {
    archives: expanded.map(({ livePath: _livePath, ...rest }) => rest),
    warnings,
    ahrSubvolumeSnapshots,
  }
}

/** `<name>__<suffix>` → `<suffix>` (the AHR snapshot label's tail). */
function suffixOf(expandedName: string, archiveName: string): string {
  return expandedName.startsWith(`${archiveName}__`) ? expandedName.slice(archiveName.length + 2) : expandedName
}

/**
 * Keep a derived name unique within one task. Two distinct nested paths can
 * sanitise to the same string (`a/b` and `a-b` both become `a_b` only if the
 * charset filter hits, but `a/b` and `a_b` collide outright), so a collision
 * takes a numeric suffix — still deterministic, still in PBS's charset.
 */
function uniqueName(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate))
    return candidate
  for (let n = 2; n < 1000; n++) {
    const next = `${candidate}-${n}`
    if (!taken.has(next))
      return next
  }
  return `${candidate}-${taken.size}`
}

/** Which expanded root an exclude pattern belongs to, and how it reads there. */
export interface RebasedExcludes {
  /** Expanded archive name → the patterns that apply to it. */
  byName: Record<string, string[]>
  warnings: string[]
}

/** A pattern anchored to the archive root (pbc: a leading `/`). */
const ANCHORED_RE = /^\//

/**
 * Rebase an archive's excludes onto the roots the expansion produced.
 *
 * pbc distinguishes two pattern shapes and so do we:
 *   - ANCHORED (`/cache/tmp`) — relative to the ARCHIVE ROOT. After expansion
 *     the pattern's real target may live inside a CHILD root, where the same
 *     path is spelled differently; it is rebased onto that child and dropped
 *     from the parent (under the parent's snapshot root the child is an empty
 *     directory, so the original spelling matches nothing there anyway).
 *   - UNANCHORED (`*.tmp`, `**‌/cache`) — matches at any depth, so it applies to
 *     EVERY root the archive expanded into, verbatim.
 *
 * HONESTY NOTE (pre-existing, Epic 16): `--exclude` is a per-INVOCATION flag —
 * ANAS puts every archive of a task in one `backup` call, so every pattern is
 * seen by every archive. Rebasing therefore makes an anchored pattern REACH its
 * intended root; it cannot stop the rebased spelling from also being offered to
 * the others. A rebase that changes the pattern says so in a warning rather than
 * quietly hoping the two never collide.
 */
export function rebaseExcludes(
  source: string,
  patterns: string[],
  roots: { name: string, livePath: string }[],
): RebasedExcludes {
  const byName: Record<string, string[]> = {}
  const warnings: string[] = []
  for (const r of roots)
    byName[r.name] = []
  if (!roots.length)
    return { byName, warnings }

  const base = normalizePath(source)
  const rootEntry = roots[0]

  for (const pattern of patterns) {
    if (!ANCHORED_RE.test(pattern)) {
      // Depth-independent: every root sees it, unchanged.
      for (const r of roots)
        byName[r.name].push(pattern)
      continue
    }
    const absolute = joinPath(base, pattern.replace(ANCHORED_RE, ''))
    // The DEEPEST child root that contains the pattern's target owns it.
    let owner = rootEntry
    for (const r of roots) {
      if (r === rootEntry)
        continue
      if (isPathWithin(r.livePath, absolute) && r.livePath.length > owner.livePath.length)
        owner = r
    }
    if (owner === rootEntry) {
      byName[rootEntry.name].push(pattern)
      continue
    }
    const rebasedPattern = `/${relativeTo(owner.livePath, absolute)}`
    byName[owner.name].push(rebasedPattern)
    warnings.push(
      `exclude '${pattern}' targets ${absolute}, which snapshot mode backs up as its own archive '${owner.name}' - `
      + `it is passed as '${rebasedPattern}'. proxmox-backup-client applies --exclude per invocation, so the rebased `
      + `pattern is offered to every archive in this run.`,
    )
  }
  return { byName, warnings }
}
