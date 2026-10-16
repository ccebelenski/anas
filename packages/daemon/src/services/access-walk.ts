import type { FindmntNode } from '../parsers/findmnt.js'
import { isPathWithin } from '@anas/shared'
import { normalizePath } from './nested-filesystems.js'

// ============================================================================
// The recursive permission walk's boundary (story nf.1, wave-3 node pass D2).
//
// A recursive apply (`applyToExisting`) used to run `chown -R`, `setfacl -R`
// and `chmod -R` on the target's directory. None of the three stops at a
// mount: on the node the walk entered an NFS mount below a dataset and
// rewrote ownership on the NFS SERVER's export, while the confirm had named
// only the child datasets. The rule now: a recursive apply never crosses a
// mount boundary it did not name.
//
// The tools' own boundary options (man pages of the versions the node runs —
// GNU findutils 4.10, coreutils 9, acl 2.3):
//   - find(1) `-xdev`: "Don't descend directories on other filesystems."
//     It still EVALUATES the boundary directory itself (the root of the other
//     filesystem), so an action would reach the NFS export's top directory;
//     every mount below a walk root is therefore also `-prune`d by path
//     ("-prune True; if the file is a directory, do not descend into it.").
// Every action runs as `-execdir … {} +`, never `-exec` (review H2,
// 2026-10-16). `-exec` runs the batch on the full paths collected when find
// LISTED them; between a listing and the batch a write-capable user can swap
// a listed DIRECTORY for a symlink (`d -> /etc`), the kernel traverses it
// when the tool resolves the absolute operand, and the action lands outside
// the tree — the review's simulation put a named recursive grant on a victim
// file through exactly that swap. `-execdir` closes the swap at its root:
// find(1) runs each batch "in the subdirectory that contains the files",
// reaching that directory through the handle it OPENED during the descent (a
// renamed or swapped name cannot move an open fd), and every member arrives
// as `./name` relative to that handle — never as an absolute path, so
// nothing outside the opened directory is addressable at all. Batches never
// mix directories ("the set of files passed is always restricted such that
// they all live under the same directory"), and the `+` form's exit-status
// rule is unchanged: a failing invocation fails find.
//
// The final component gets its no-follow too — each tool in its own way:
//   - chown(1) `-h, --no-dereference`: "affect … the symbolic link itself
//     rather than the file to which the link refers" — what `chown -R`'s
//     default `-P` did to a link it met, and never the referent;
//   - setfacl(1) `-P, --physical`: do not follow symbolic-link operands —
//     one is REFUSED (an error, so a swapped-in link fails the job loudly
//     instead of being followed);
//   - chmod has no operand no-follow option on Linux (GNU chmod's `-h`
//     affects only the `-R` traversal — and there is no lchmod here anyway),
//     so a chmod batch's members are filtered by find's OWN type test,
//     evaluated per entry ahead of `-execdir`: `! -type l` for the mode and
//     `g-s` steps, `-type d` for setgid (which under find's `-P` already
//     excludes links). No chmod invocation can receive a member find typed
//     as anything but the kind it selects.
//   - chown(1), chmod(1) and setfacl(1) `-R` have no one-filesystem option,
//     so all three stay find-driven with `-xdev` and the prunes; none is
//     ever run with `-R` (that is what crossed mounts).
//
// Exit status is unchanged from `-exec … {} +`: "If any invocation with the
// `+' form returns a non-zero value as exit status, then find returns a
// non-zero exit status" — a failing action still fails the job.
//
// Child ZFS datasets the confirm names are still included: each is a walk
// root of its own (`-xdev` keeps every root inside its own dataset). Every
// other mount under the target is excluded and named in the confirm.
//
// btrfs is the one exception to `-xdev`: a btrfs subvolume carries its own
// `st_dev` and has NO mount line (BACKUP-RESTORE-GROUND-TRUTH GT-52/53, the
// reason `services/nested-filesystems.ts` walks by st_dev), so `-xdev` would
// stop at every subvolume of an AHR pool's `@data` — which the walk has always
// swept as one tree. A root on btrfs is bounded by the pruned mount paths
// alone.
// ============================================================================

/** One directory a walk starts from, and how it is bounded. */
export interface WalkRoot {
  path: string
  /** `-xdev` — false only on btrfs (subvolumes are not mounts). */
  xdev: boolean
  /** Paths `-prune`d: every mount directly below this root, plus a ZFS root's `.zfs`. */
  prune: string[]
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
  const rootPaths = [base, ...[...namedMounted].filter(p => !hidden(p)).sort()]
  const roots = rootPaths.map((path): WalkRoot => {
    const own = mountOf(path, mounts)
    const below = outermost(under.filter(t => t !== path && isPathWithin(path, t)))
    const zfsRoot = own !== undefined && own.target === path && own.fstype === 'zfs'
    return {
      path,
      xdev: own?.fstype !== 'btrfs',
      prune: [...(zfsRoot ? [`${path === '/' ? '' : path}/.zfs`] : []), ...below],
    }
  })
  return {
    roots,
    excluded: excludedTargets.map(target => ({ target, fstype: mounts.get(target)?.fstype ?? 'unknown' })),
    crossed: children.filter(c => !hidden(c.mountpoint)).map(c => ({ name: c.name, mountpoint: c.mountpoint })),
  }
}

/**
 * The `find` argv for one walk root: `-P` (never follow a link), the start,
 * `-xdev` (a global option, so ahead of every test), the pruned paths, then
 * the selection and the action. `select` filters what the action sees
 * (`! -type l`, `-type d`) and is what keeps a chmod batch — the one tool
 * with no operand no-follow — free of every member find did not type in;
 * `action` is the command and its options, run as `-execdir … {} +` so each
 * batch executes relative to the directory find opened (H2 — see the header).
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

/** `/w3s7/a/nfs (nfs4), /w3s7/a/tmp (tmpfs)` — the confirm's and the result's list. */
export function notChangedList(excluded: ExcludedMount[]): string[] {
  return excluded.map(e => `${e.target} (${e.fstype})`)
}
