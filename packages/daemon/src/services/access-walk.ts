import type { FindmntNode } from '../parsers/findmnt.js'
import { isPathWithin } from '@anas/shared'
import { normalizePath } from './nested-filesystems.js'

// ============================================================================
// The recursive permission walk's scope (story nf.1, wave-3 node pass D2).
//
// A recursive apply (`applyToExisting`) used to run `chown -R`, `setfacl -R`
// and `chmod -R` on the target's directory. None of the three stops at a
// mount: on the node the walk entered an NFS mount below a dataset and
// rewrote ownership on the NFS SERVER's export, while the confirm had named
// only the child datasets. The rule: a recursive apply never crosses a mount
// boundary it did not name.
//
// THE WRITE PATH (cr3.shares, fourth review) no longer runs find(1) at all.
// find names each entry as `./name` and every tool resolved that name again
// when it ran; a share user who swapped the name for a symbolic link in
// between redirected the write — acl 2.3.2 `setfacl -P` followed the link,
// coreutils 9.7 `chmod -h` raced, and GNU find's `-fstype btrfs` matched
// nothing on btrfs, so a recursive AHR apply changed nothing and said it
// had. The walk is now services/anas-acl-walk.pl: every entry is opened
// O_PATH|O_NOFOLLOW where it was listed and proven by fstat, every tool
// names that descriptor, and the boundary is the device number. What this
// module still decides for the writer is the SCOPE: the roots (the target,
// each named child dataset, each nested btrfs subvolume — `btrfs subvolume
// list`, read with the plan, each pinned like every root), the mounts left
// alone (named in the confirm and the result) and the child datasets
// crossed.
//
// {@link walkArgs} below is the find(1) argv of the identity scan
// (identity-ids.ts), a READ of uids, gids and ACL entries — `-P`, `-xdev`,
// every mount below a root `-prune`d by path, each action `-execdir ... {} +`
// (find(1): runs "in the subdirectory that contains the files", every member
// as `./name`). Nothing it runs writes.
// ============================================================================

/** One directory a walk starts from, and how it is bounded. */
export interface WalkRoot {
  path: string
  /** The identity scan's `-xdev` (identity-ids.ts sets it per filesystem). */
  xdev: boolean
  /** The identity scan's `-prune`d paths: every mount directly below this root, plus a ZFS root's `.zfs`. */
  prune: string[]
  /**
   * The root is a ZFS dataset's mountpoint: the permission walk skips the
   * `.zfs` control directory at its top (cr3.shares, fourth review).
   */
  zfsRoot?: boolean
}

/** A mount under the target that the walk does not enter. */
export interface ExcludedMount { target: string, fstype: string }

/** What a recursive apply walks, and what it leaves alone. */
export interface WalkScope {
  /** The target's directory first, then each named child dataset that is mounted where the confirm says. */
  roots: WalkRoot[]
  /** Every other mount under the target, outermost only (a mount inside one is never reached). */
  excluded: ExcludedMount[]
  /** The named child datasets the walk crosses (not hidden under an excluded mount). */
  crossed: { name: string, mountpoint: string }[]
}

/** Leading slashes of a subvolume path. */
const LEADING_SLASHES_RE = /^\/+/

/** `find -path` takes a glob: a mountpoint's `*`, `?`, `[`, `]` and `\` must match themselves. */
const GLOB_META_RE = /[*?[\]\\]/g

/** A path as a `find -path` pattern that matches exactly that path. */
export function findPathPattern(path: string): string {
  return path.replace(GLOB_META_RE, m => `\\${m}`)
}

/** The findmnt row of the filesystem `path` sits on (the longest mount target containing it). */
function mountOf(path: string, mounts: Map<string, FindmntNode>): FindmntNode | undefined {
  let best: FindmntNode | undefined
  for (const [target, node] of mounts) {
    if (isPathWithin(target, path) && (!best || target.length > best.target.length))
      best = node
  }
  return best
}

/** The targets in `paths` that no other target in `paths` contains. */
function outermost(paths: string[]): string[] {
  return paths.filter(p => !paths.some(q => q !== p && isPathWithin(q, p))).sort()
}

/**
 * The walk's scope from the mount table (`findmnt --json`, through
 * `mountIndex`, which already drops `.zfs/snapshot` automounts) and the child
 * datasets the confirm names (`zfs list` under the target's dataset; none for
 * a target that is not on ZFS). A child counts as a walk root only when the
 * mount table shows THAT dataset mounted at its mountpoint — anything else
 * mounted there is a stranger and is excluded.
 */
export function walkScopeFrom(
  dir: string,
  mounts: Map<string, FindmntNode>,
  children: { name: string, mountpoint: string }[],
  subvolumes: string[] = [],
): WalkScope {
  const base = normalizePath(dir)
  const under = [...mounts.keys()].filter(t => t !== base && isPathWithin(base, t))
  const namedMounted = new Set(children
    .filter((c) => {
      const row = mounts.get(c.mountpoint)
      return row !== undefined && row.fstype === 'zfs' && row.source === c.name && under.includes(c.mountpoint)
    })
    .map(c => c.mountpoint))
  const excludedTargets = outermost(under.filter(t => !namedMounted.has(t)))
  const hidden = (path: string): boolean => excludedTargets.some(e => isPathWithin(e, path))
  // Nested btrfs subvolumes of the walked tree are roots of their own (each
  // has its own device number, where the walk stops), unless an excluded
  // mount hides them.
  const subvolRoots = subvolumes
    .map(normalizePath)
    .filter(p => p !== base && isPathWithin(base, p) && !hidden(p) && !namedMounted.has(p))
  const rootPaths = [base, ...[...namedMounted, ...subvolRoots].filter(p => !hidden(p)).sort()]
  const roots = rootPaths.map((path): WalkRoot => {
    const own = mountOf(path, mounts)
    const below = outermost(under.filter(t => t !== path && isPathWithin(path, t)))
    const zfsRoot = own !== undefined && own.target === path && own.fstype === 'zfs'
    return {
      path,
      xdev: true,
      prune: [...(zfsRoot ? [`${path === '/' ? '' : path}/.zfs`] : []), ...below],
      ...(zfsRoot ? { zfsRoot: true } : {}),
    }
  })
  return {
    roots,
    excluded: excludedTargets.map(target => ({ target, fstype: mounts.get(target)?.fstype ?? 'unknown' })),
    crossed: children.filter(c => !hidden(c.mountpoint)).map(c => ({ name: c.name, mountpoint: c.mountpoint })),
  }
}

/**
 * The identity scan's `find` argv for one walk root (identity-ids.ts — a
 * READ): `-P` (never follow a link), the start, `-xdev` when the root has it
 * (a global option, so ahead of every test), the pruned paths, then the
 * selection and the action, run as `-execdir ... {} +`.
 */
export function walkArgs(root: WalkRoot, select: string[], action: string[]): string[] {
  const args = ['-P', root.path]
  if (root.xdev)
    args.push('-xdev')
  if (root.prune.length > 0) {
    const terms = root.prune.flatMap((p, i) => [...(i > 0 ? ['-o'] : []), '-path', findPathPattern(p)])
    args.push('(', ...terms, ')', '-prune', '-o')
  }
  args.push(...select, '-execdir', ...action, '{}', '+')
  return args
}

/**
 * The nested btrfs subvolumes under `dir`, as absolute paths (third review
 * D2 — each is a root of the permission walk): `btrfs subvolume list <mountpoint>` names every subvolume of the
 * filesystem relative to its top level; the mount's own `subvol=` option says
 * which of them is mounted at `own.target`, so a subvolume below it maps onto
 * the mounted tree. Subvolumes outside the mounted one (`@snapshots`) are not
 * under `dir` and drop out.
 */
export function nestedSubvolumes(paths: string[], own: FindmntNode, dir: string): string[] {
  const mounted = mountedSubvolume(own)
  const base = normalizePath(dir)
  const out: string[] = []
  for (const p of paths) {
    const rel = p.replace(LEADING_SLASHES_RE, '')
    if (mounted !== '' && !rel.startsWith(`${mounted}/`))
      continue
    const abs = normalizePath(`${own.target}/${mounted === '' ? rel : rel.slice(mounted.length + 1)}`)
    if (abs !== base && isPathWithin(base, abs))
      out.push(abs)
  }
  return out
}

/**
 * The subvolume a btrfs mount shows, relative to the top level, without a
 * leading slash (`@data`; `''` for the top level itself) — from the mount's
 * `subvol=` option.
 */
export function mountedSubvolume(own: FindmntNode): string {
  const opt = own.options.split(',').find(o => o.startsWith('subvol='))
  return (opt ? opt.slice('subvol='.length) : '/').replace(LEADING_SLASHES_RE, '')
}

/** A subvolume path as `btrfs subvolume list` prints it, without a leading slash. */
export function subvolumeRelPath(path: string): string {
  return path.replace(LEADING_SLASHES_RE, '')
}

/** The mount row of the filesystem `path` sits on (exported for the plan's subvolume read). */
export function mountRowOf(path: string, mounts: Map<string, FindmntNode>): FindmntNode | undefined {
  return mountOf(path, mounts)
}

/** `/w3s7/a/nfs (nfs4), /w3s7/a/tmp (tmpfs)` — the confirm's and the result's list. */
export function notChangedList(excluded: ExcludedMount[]): string[] {
  return excluded.map(e => `${e.target} (${e.fstype})`)
}
