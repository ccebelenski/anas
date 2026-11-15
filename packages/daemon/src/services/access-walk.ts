import type { FindmntNode } from '../parsers/findmnt.js'
import { lstat as fsLstat } from 'node:fs/promises'
import { posix } from 'node:path'
import { isPathWithin } from '@anas/shared'
import { lineBreakRemedy, subvolumesBelowMount } from '../parsers/btrfs-subvol-list.js'
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
// The identity scan's find(1) argv (a READ of uids, gids and ACL entries)
// is built in identity-ids.ts from this module's scope; this module exports
// no find builder that takes an action (cr3.nodefix review R4: `-exec`
// re-resolves every operand, safe only for a read).
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

/** What the subvolume confirmation needs of an lstat (node's `fs.promises.lstat`; a test serves its own). */
export type SubvolumeLstat = (path: string) => Promise<{ dev: number, ino: number, isDirectory: () => boolean, isSymbolicLink: () => boolean }>

/**
 * btrfs gives every subvolume's root directory this inode number
 * (BTRFS_FIRST_FREE_OBJECTID); captured, cr3.nodefix review R2
 * (fixtures/ahr/btrfs-subvol-list-newline-names.txt): subvolume roots are
 * inode 256 each on a device number of its own, ordinary folders are not.
 */
const SUBVOLUME_ROOT_INO = 256

/**
 * Why `path` (under the mount `target`) is not a subvolume root, or null
 * when it is. Every component from the mount down is lstat'ed in turn, so no
 * symbolic link is ever followed: each must be a folder, and the last must
 * be inode 256 on another device than the folder holding it.
 */
async function notASubvolume(path: string, target: string, lstat: SubvolumeLstat): Promise<string | null> {
  const rel = posix.relative(target, path)
  if (rel === '' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel))
    return `${path} is not under the mount`
  let cur = target
  let parent: Awaited<ReturnType<SubvolumeLstat>>
  try {
    parent = await lstat(target)
  }
  catch (err) {
    return `the mount ${target} could not be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`
  }
  for (const part of rel.split('/')) {
    cur = posix.join(cur, part)
    let st: Awaited<ReturnType<SubvolumeLstat>>
    try {
      st = await lstat(cur)
    }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? `${cur} does not exist` : `${cur} could not be read (${code ?? String(err)})`
    }
    if (st.isSymbolicLink())
      return `${cur} is a symbolic link`
    if (!st.isDirectory())
      return `${cur} is not a folder`
    if (cur === path && (st.ino !== SUBVOLUME_ROOT_INO || st.dev === parent.dev))
      return `${cur} is a plain folder, not a subvolume`
    parent = st
  }
  return null
}

/**
 * cr3.nodefix review R2: {@link subvolumesBelowMount}, every placement
 * confirmed against the filesystem before anything acts on it. The list is
 * text a user can shape (a subvolume name may hold a line break and so forge
 * a whole line), so each placed path must BE a subvolume root under the
 * mount ({@link notASubvolume}); one that is not refuses the whole reading,
 * naming it and what to do. The ONE reading both consumers use: the
 * permission walk's plan ({@link nestedSubvolumes}) and the cloud snapshot's
 * exclusions (cloud-runner.ts).
 */
export async function confirmedSubvolumesBelowMount(
  stdout: string,
  mount: { target: string, options: string },
  lstat: SubvolumeLstat = fsLstat,
): Promise<{ below: { path: string, subvol: string }[] } | { problem: string }> {
  const read = subvolumesBelowMount(stdout, mount)
  if ('problem' in read)
    return read
  for (const b of read.below) {
    const why = await notASubvolume(b.path, mount.target, lstat)
    if (why !== null)
      return { problem: `named ${b.path} as a subvolume, and ${why}; a subvolume deleted or moved while the list was read does this, and so does one whose name ANAS cannot read: ${lineBreakRemedy(mount.target)}` }
  }
  return read
}

/**
 * The nested btrfs subvolumes under `dir`, as absolute paths (third review
 * D2 — each is a root of the permission walk), from the plain `btrfs
 * subvolume list <mountpoint>` of the filesystem `dir` is on. Where each
 * one lies on the mount is {@link subvolumesBelowMount}'s answer (cr3.nodefix
 * D2: on an AHR mount, `subvol=/@data`, a nested `@data/sv` prints as `sv`;
 * this used to keep only paths starting `@data/`, which a subvolume mount
 * never prints, so no nested subvolume was ever a root). Subvolumes outside
 * the mounted one (`@snapshots`) and outside `dir` drop out. A list it cannot
 * place, or a placement the filesystem does not confirm (review R2), is the
 * `problem` the plan refuses on.
 */
export async function nestedSubvolumes(stdout: string, own: FindmntNode, dir: string, lstat?: SubvolumeLstat): Promise<string[] | { problem: string }> {
  const read = await confirmedSubvolumesBelowMount(stdout, own, lstat)
  if ('problem' in read)
    return read
  const base = normalizePath(dir)
  return read.below.map(b => normalizePath(b.path)).filter(abs => abs !== base && isPathWithin(base, abs))
}

/** The mount row of the filesystem `path` sits on (exported for the plan's subvolume read). */
export function mountRowOf(path: string, mounts: Map<string, FindmntNode>): FindmntNode | undefined {
  return mountOf(path, mounts)
}

/** `/w3s7/a/nfs (nfs4), /w3s7/a/tmp (tmpfs)` — the confirm's and the result's list. */
export function notChangedList(excluded: ExcludedMount[]): string[] {
  return excluded.map(e => `${e.target} (${e.fstype})`)
}
