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
//   - chown(1) and chmod(1) have no one-filesystem option (`-R` with
//     `-H`/`-L`/`-P` decides symlinks only), so both are driven from find
//     with `-exec … {} +`. chown gets `-h` ("affect symbolic links instead of
//     any referenced file") — what `chown -R` (`-P` "the default") does to a
//     link it meets. chmod "ignores symbolic links encountered during
//     recursive directory traversals" but FOLLOWS one named on its command
//     line, so links are filtered out (`! -type l`) before it.
//   - setfacl(1) `-R` "Apply operations to all files and directories
//     recursively" — no mount option either; `-P, --physical` rejects symlink
//     arguments (an error, not a skip), so setfacl is driven from find too,
//     with links filtered out: setfacl -R's own default is to "skip symbolic
//     links encountered in subdirectories".
//   - `-exec command {} +`: "If any invocation with the `+' form returns a
//     non-zero value as exit status, then find returns a non-zero exit
//     status" — a failure still fails the job.
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
 * (`! -type l`, `-type d`); `action` is the command and its options, run as
 * `-exec … {} +`.
 */
export function walkArgs(root: WalkRoot, select: string[], action: string[]): string[] {
  const args = ['-P', root.path]
  if (root.xdev)
    args.push('-xdev')
  if (root.prune.length > 0) {
    const terms = root.prune.flatMap((p, i) => [...(i > 0 ? ['-o'] : []), '-path', findPathPattern(p)])
    args.push('(', ...terms, ')', '-prune', '-o')
  }
  args.push(...select, '-exec', ...action, '{}', '+')
  return args
}

/** `/w3s7/a/nfs (nfs4), /w3s7/a/tmp (tmpfs)` — the confirm's and the result's list. */
export function notChangedList(excluded: ExcludedMount[]): string[] {
  return excluded.map(e => `${e.target} (${e.fstype})`)
}
