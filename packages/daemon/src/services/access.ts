import type { AccessEntry, AccessLevel, AccessWalkReport, DatasetAccess, ErrorCode, MountpointPermissions, SetAccessRequest, ShareAccessGrantResult } from '@anas/shared'
import type { FileHandle } from 'node:fs/promises'
import type { CommandExecutor, ExecOptions, ExecResult } from '../executor/types.js'
import type { LockClaim } from '../jobs/locks.js'
import type { JobContext } from '../jobs/queue.js'
import type { ParsedAcl, ParsedAclSet } from '../parsers/getfacl.js'
import type { Gate, GuardReads, GuardSpec, Refusal } from '../safety/guard.js'
import type { WalkScope } from './access-walk.js'
import type { IscsiPaths } from './iscsi.js'
import { createHash } from 'node:crypto'
import { constants as FS_CONSTANTS } from 'node:fs'
import { access, lstat, open, readFile, readlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessWalkReport as AccessWalkReportSchema, DatasetPath, isPathWithin } from '@anas/shared'
import { ChildCancel } from '../jobs/child-cancel.js'
import { JobCancelledError } from '../jobs/queue.js'
import { parseBtrfsSubvolList } from '../parsers/btrfs-subvol-list.js'
import { isFindmntTable } from '../parsers/findmnt.js'
import { parseGroups, parsePasswd } from '../parsers/getent.js'
import { effectivePerms, levelToAclPerms, levelToOctalDigit, modeDigitToLevel, parseGetfacl, permsToLevel } from '../parsers/getfacl.js'
import { parsePveMountPaths, PVE_STORAGE_CFG } from '../parsers/pve-storage.js'
import { parseDatasetGet, parseZfsList, zfsListArgs } from '../parsers/zfs-list.js'
import { ahrPoolClaims, zfsDatasetClaims } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { mountedSubvolume, mountRowOf, nestedSubvolumes, notChangedList, subvolumeRelPath, walkScopeFrom } from './access-walk.js'
import { heldByLunOnce, heldHolderPhrase } from './iscsi-held.js'
import { probeMount } from './mounts.js'
import { isProbeableKind, kindOfMount, mountIndex, normalizePath } from './nested-filesystems.js'
import { loadPveFootprint, pveDescendantsUnlistedMessage, pveRecursiveRefusalMessage } from './pve-footprint.js'
import { cannotSeeMessage, probeSharePath } from './share-path.js'
import { resolveSelfServiceTarget } from './share-selfservice.js'

// ============================================================================
// The permissions writer (Epic 4.7.2, lifted for access.1/access.2).
//
// ONE mechanism behind every Permissions dialog and the share-create grant:
// the base three principals (owner / owning-group / everyone) are POSIX mode
// bits, extra named principals are POSIX ACL entries (see parsers/getfacl.ts
// for the level ↔ perms mapping). The routes differ only in how they name the
// directory — a ZFS dataset (or pool root), an AHR pool, or a share path —
// and the target resolver below is the one place that says where the
// filesystems differ:
//
//   - the ACL switch: ZFS has `acltype` (auto-enabled with `zfs set` on the
//     first named grant); btrfs (AHR) and other Linux filesystems carry POSIX
//     ACLs natively, so there is no switch and never a `zfs set`;
//   - the recursive walk (anas-acl-walk, cr3.shares fourth review) walks
//     the directory tree and stops at every other device. On ZFS each
//     child dataset mounted beneath that the confirm names is a root of its
//     own (the PVE-descendant refusal guards it, and a named grant switches
//     their ACLs on first — {@link enableChildAcls}); on AHR each nested
//     subvolume under `@data` is a root of its own, and `@snapshots` is a
//     sibling OUTSIDE the mountpoint (AHR-DESIGN §12), so it is never entered;
//   - PVE territory: a ZFS dataset asks the footprint service; a non-ZFS
//     directory asks storage.cfg's `path`/`mountpoint` keys directly.
// ============================================================================

const ZFS = '/usr/sbin/zfs'
const STAT = '/usr/bin/stat'
const CHOWN = '/usr/bin/chown'
const CHMOD = '/usr/bin/chmod'
const GETFACL = '/usr/bin/getfacl'
const SETFACL = '/usr/bin/setfacl'

/**
 * cr.34: a RECURSIVE apply walks the whole tree — hours on a large dataset —
 * so the walk runs with no deadline (the job lane's 300 s would stop a
 * legitimate walk half-way); the job's cancel stops it instead (cr3.shares,
 * fourth review: the helper's whole process group). The non-recursive forms
 * keep the lane default.
 *
 * Story nf.1 (wave-3 D2) keeps that and bounds the one way a walk could hang
 * that has nothing to do with the tree's size: the walk never enters another
 * filesystem, but it still lstats the MOUNTPOINT of a mount below the target
 * (that is how it sees the other device) — and a dead NFS/CIFS server hangs
 * that lstat for ever. The job probes every such remote mount first and
 * refuses before changing anything ({@link refuseDeadRemotes}).
 */
// The reason literal is pinned by __tests__/null-sites.test.ts.
const TREE_WALK: ExecOptions = {
  timeoutMs: null,
  longRunning: 'recursive chown/setfacl/chmod walk over a whole tree: hours on a large dataset',
}
const FINDMNT = '/usr/bin/findmnt'
const BTRFS = '/usr/bin/btrfs'
/** `btrfs subvolume list` reads metadata only; a minute is far beyond any pool. */
const BTRFS_LIST_TIMEOUT_MS = 60_000
const PERL = '/usr/bin/perl'
/** perl's answer when it cannot open the script it was given (it ran nothing of it). */
const PERL_CANNOT_OPEN_RE = /^Can't open perl script/
/**
 * The recursive permission walk (cr3.shares, fourth review). It ships beside
 * this module: the release build copies services/anas-acl-walk.pl next to the
 * compiled services (root-owned, under the install prefix), and a dev run
 * reads it from the source tree, so there is one path rule for both.
 */
export const ANAS_ACL_WALK = join(dirname(fileURLToPath(import.meta.url)), 'anas-acl-walk.pl')
const GETENT = '/usr/bin/getent'

/** The base-three access kinds (mode bits), in owner/group/everyone order. */
type BaseKind = 'owner' | 'owning-group' | 'everyone'

/** Levels for the base three principals, resolved from mode bits or a request. */
interface BaseLevels {
  'owner': AccessEntry['level']
  'owning-group': AccessEntry['level']
  'everyone': AccessEntry['level']
}

/** The base principals, in spec order. */
const BASE_KINDS = ['owner', 'owning-group', 'everyone'] as const

/** Whitespace splitter for `stat` output (owner group mode). */
const WHITESPACE_RE = /\s+/

/** What every pinned single-directory write names: the directory the daemon opened (fd 3 in the child). */
export const PINNED_DIR = '/proc/self/fd/3'

/** One opened directory a write job acts through (cr3.shares H2). */
export interface PinnedDir {
  fd: number
  close: () => Promise<void>
}

/**
 * The pin's filesystem calls — a seam so a unit test standing on a path that
 * does not exist on the test host can stand in an opened directory. Production
 * never replaces it.
 */
export const accessDirIo = {
  /** Open a directory without following a final symlink. */
  open: (path: string) => open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW),
  /** The kernel's name for an opened descriptor (`/proc/self/fd/N`). */
  readlink: (path: string) => readlink(path),
  /** lstat a path component (the share-path symlink rule). */
  lstat: (path: string) => lstat(path),
  /** The opened descriptor's own identity (N1). */
  fstat: (handle: FileHandle) => handle.stat(),
  /** Resolves when the walk helper's script can be read (fifth review D1). */
  readable: (path: string) => access(path, FS_CONSTANTS.R_OK),
  /** The mount table with its mount ids (fifth review D6). */
  mountinfo: () => readFile('/proc/self/mountinfo', 'utf8'),
}

/** A mountinfo field's octal escapes (`\040` for a space). */
const MOUNTINFO_ESCAPE_RE = /\\([0-7]{3})/g

/**
 * The mount id of the mount VISIBLE at each target (fifth review D6), from
 * /proc/self/mountinfo (proc(5): field 1 the mount id, 2 its parent's, 5 the
 * mount point, octal-escaped): of the mounts at one target, the one no other
 * mount there stacks on. Null for a target the table does not show.
 */
export function mountIdsAt(mountinfo: string, targets: string[]): (number | null)[] {
  const at = new Map<string, { id: number, parent: number }[]>()
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ')
    if (f.length < 5)
      continue
    const target = f[4].replace(MOUNTINFO_ESCAPE_RE, (_m, o: string) => String.fromCharCode(Number.parseInt(o, 8)))
    at.set(target, [...(at.get(target) ?? []), { id: Number(f[0]), parent: Number(f[1]) }])
  }
  return targets.map((t) => {
    const here = at.get(t) ?? []
    const top = here.filter(m => !here.some(o => o.parent === m.id))
    return top.length === 1 ? top[0].id : null
  })
}

/**
 * cr3.shares H2: open the planned directory ONCE — `O_DIRECTORY|O_NOFOLLOW`,
 * so a final component that is a symlink fails the open — and prove that the
 * descriptor is the planned real path: the kernel's name for it must equal
 * the path itself (an earlier component swapped for a link between the check
 * and the open lands the descriptor elsewhere, and its name says so; the
 * mounts pin, services/mounts.ts openMountTarget, proves a mountpoint the
 * same way). Every tool then names `/proc/self/fd/3`, which the kernel
 * resolves to exactly this directory whatever the path names afterwards.
 */
async function pinDir(dir: string, expected?: DirId): Promise<PinnedDir> {
  const want = normalizePath(dir)
  let handle: Awaited<ReturnType<typeof accessDirIo.open>>
  try {
    handle = await accessDirIo.open(want)
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error'
    throw new Error(`No permissions were changed: '${want}' could not be opened as a plain directory (${code}) — a symbolic link in its place is refused`)
  }
  let name: string | null
  try {
    name = await accessDirIo.readlink(`/proc/self/fd/${handle.fd}`)
  }
  catch {
    name = null
  }
  if (name !== want) {
    await handle.close()
    throw new Error(`No permissions were changed: the directory opened for '${want}' is ${name === null ? 'unnamed' : `'${name}'`} — a component of the path was swapped for a symbolic link after the check`)
  }
  // N1 (third review): the readlink proves a PATH; the device and inode
  // prove the OBJECT is the one the plan read (a directory replaced by
  // another of the same name since refuses here).
  if (expected) {
    const st = await accessDirIo.fstat(handle).catch(() => null)
    if (!st || st.dev !== expected.dev || st.ino !== expected.ino) {
      await handle.close()
      throw new Error(`No permissions were changed: '${want}' is no longer the directory the change was planned for (it was replaced since) — reload and apply again`)
    }
  }
  return { fd: handle.fd, close: () => handle.close() }
}

/** How many symbolic links one resolution follows before it gives up (the kernel's own bound). */
const MAX_LINKS = 40

/**
 * cr3.shares H2 (second review): the ONE resolution of a configured path,
 * walked component by component by the daemon itself — the OpenSSH
 * "safe path" rule. `.`, `..` and repeated `/` are normalised as the walk
 * goes; every component is `lstat`-ed, and a symbolic link is followed
 * (readlink) ONLY when the link itself is owned by root AND every directory
 * from `/` down to the one holding it is root-owned and writable by neither
 * group nor others (a sticky bit does not make a writable directory safe):
 * only then can no share user have planted or swapped it. Any other link
 * refuses, naming the link and why. The result R is the real path: the PVE
 * gates judge it, and the writes act on it through a descriptor proven to
 * BE it ({@link pinDir}) — the pin covers the non-link components, the only
 * ones a share user can still swap. No second resolution, no mount table.
 */
export async function safeResolve(configured: string): Promise<{ real: string } | { refusal: string }> {
  const queue = configured.split('/').filter(Boolean)
  const real: string[] = []
  const safeDirs = new Map<string, string | null>()
  /** Why the directory `dir` (a real path) may not hold a trusted link, or null. */
  const unsafeDir = async (dir: string): Promise<string | null> => {
    if (safeDirs.has(dir))
      return safeDirs.get(dir)!
    const st = await accessDirIo.lstat(dir).catch(() => null)
    const why = !st
      ? `'${dir}' could not be read`
      : st.uid !== 0
        ? `'${dir}' is owned by uid ${st.uid}, not root`
        : (st.mode & 0o022) !== 0
            ? `'${dir}' is writable by its group or by everyone`
            : null
    safeDirs.set(dir, why)
    return why
  }
  let links = 0
  while (queue.length > 0) {
    const comp = queue.shift()!
    if (comp === '.')
      continue
    if (comp === '..') {
      real.pop()
      continue
    }
    const here = `/${[...real, comp].join('/')}`
    const st = await accessDirIo.lstat(here).catch((err: NodeJS.ErrnoException) => err)
    if (st instanceof Error)
      return { refusal: `'${configured}' could not be resolved: '${here}' ${st.code === 'ENOENT' ? 'does not exist' : `could not be read (${st.code ?? st.message})`}` }
    if (!st.isSymbolicLink()) {
      real.push(comp)
      continue
    }
    if (++links > MAX_LINKS)
      return { refusal: `'${configured}' could not be resolved: more than ${MAX_LINKS} symbolic links` }
    let why: string | null = st.uid !== 0 ? `it is owned by uid ${st.uid}, not root` : null
    if (why === null) {
      for (let i = 0; i <= real.length && why === null; i++)
        why = await unsafeDir(`/${real.slice(0, i).join('/')}`)
    }
    if (why !== null)
      return { refusal: `'${configured}' runs through the symbolic link '${here}', which a share user could have planted or swapped (${why}) — ANAS follows a link only when root owns it and every directory above it is root's and writable by no one else; point the share at the real directory instead` }
    const target = await accessDirIo.readlink(here).catch(() => null)
    if (target === null)
      return { refusal: `'${configured}' could not be resolved: the link '${here}' could not be read` }
    if (target.startsWith('/'))
      real.length = 0
    queue.unshift(...target.split('/').filter(Boolean))
  }
  return { real: `/${real.join('/')}` }
}

// ============================================================================
// Targets
// ============================================================================

/** Where a share path lives — the home its ACL switch and gates come from. */
export type ShareHome
  = | { kind: 'zfs', dataset: string }
    | { kind: 'ahr', pool: string, record: { name: string, mountpoint: string, mounted: boolean }, vgUuid?: string }
    | null

/** The ZFS target: a mounted filesystem dataset (or the pool-root dataset). */
export interface ZfsAccessTarget { kind: 'zfs', dataset: string, mountpoint: string }
/** The AHR target: the pool's `@data` mount (or the flat top level). */
export interface AhrAccessTarget {
  kind: 'ahr'
  pool: string
  mountpoint: string
  record: { name: string, mountpoint: string, mounted: boolean }
  /** The pool's LVM VG UUID — its lock key (cr.33 §4.2); absent when LVM did not report it. */
  vgUuid?: string
}
/** A share's path, resolved onto its home (ZFS dataset, AHR pool, or neither). */
/**
 * A share path's target. `path` is the REAL path (cr3.shares H2: `realpath -e`
 * of the configured one — the gates judge it and the writes pin it);
 * `configuredPath` is the path as smb.conf / exports names it, present when
 * it differs, so the symlink rule can be asked of it.
 */
export interface ShareAccessTarget { kind: 'share', path: string, home: ShareHome, configuredPath?: string, /** The safe-path walk's refusal, when it refused. */ pathRefusal?: string }

export type AccessTarget = ZfsAccessTarget | AhrAccessTarget | ShareAccessTarget

/** A descendant dataset mounted under a recursive walk's directory. */
interface ChildDataset { name: string, mountpoint: string, acltype: string }

/**
 * What a recursive apply walks (story nf.1, wave-3 D2; see `access-walk.ts`):
 * the roots and their bounds, the mounts it leaves alone, and the child
 * datasets it crosses (with their `acltype`, for the ACL switch).
 */
export interface PlanWalk extends WalkScope {
  children: ChildDataset[]
  /**
   * cr3.shares N1 (third review): each root's device and inode as the plan
   * saw them, index for index with `roots` — the pin compares its descriptor
   * with them, so a root replaced by another directory of the same name
   * refuses before any write.
   */
  rootIds: DirId[]
  /**
   * Fifth review D6: the identity of each excluded mount, index for index
   * with `excluded`, as the plan read it (null when it could not be read) —
   * the walk's boundaries are matched against these, never against a count.
   */
  excludedIds: (ExcludedIdentity | null)[]
}

/**
 * An excluded mount as the plan saw it (fifth review D6): its mount id
 * (mountinfo), and WHERE it sits — the inode of the directory holding its
 * mountpoint and the mountpoint's name. A mount id is reused once its mount
 * is gone (the re-run of the review's probe: a tmpfs mounted at another name
 * after the excluded one was unmounted got the same id AND the same anonymous
 * device number), and a mountpoint cannot be renamed while mounted, so the
 * three together name this mount at this place. The device is not part of
 * it: on btrfs, stat(2) reports a subvolume's own anonymous device, never the
 * mount table's major:minor.
 */
export interface ExcludedIdentity { mnt: number, parent: number, leaf: string }

/** A directory's identity: its device and inode. */
export interface DirId { dev: number, ino: number }

/** The directory the writer acts on. */
export function targetDir(t: AccessTarget): string {
  return t.kind === 'share' ? t.path : t.mountpoint
}

/**
 * The ZFS dataset whose `acltype` governs the target, or null when the
 * filesystem carries POSIX ACLs natively (btrfs, ext4, xfs — no switch, and
 * never a `zfs set` on a non-ZFS target).
 */
export function aclDatasetOf(t: AccessTarget): string | null {
  if (t.kind === 'zfs')
    return t.dataset
  if (t.kind === 'share' && t.home?.kind === 'zfs')
    return t.home.dataset
  return null
}

/** Which filesystem family backs the target (the dialog states the differences). */
export function targetBacking(t: AccessTarget): 'zfs' | 'ahr' | 'other' {
  if (t.kind === 'zfs')
    return 'zfs'
  if (t.kind === 'ahr')
    return 'ahr'
  return t.home?.kind ?? 'other'
}

/**
 * The identity fields a job's params and result lead with. The ZFS shape is
 * the pre-lift one, key order included (`{ dataset, mountpoint, … }`).
 */
function identityFields(t: AccessTarget): Record<string, string> {
  if (t.kind === 'zfs')
    return { dataset: t.dataset, mountpoint: t.mountpoint }
  if (t.kind === 'ahr')
    return { pool: t.pool, mountpoint: t.mountpoint }
  // cr3.shares (second review): `path` is what the operator named (the
  // share's configured path); the real path the writer stood on rides beside
  // it, additively, when the two differ.
  return t.configuredPath !== undefined ? { path: t.configuredPath, resolvedPath: t.path } : { path: t.path }
}

/** "Mountpoint '<x>'" or "Share path '<x>'" — the 404 when the directory cannot be stat'ed. */
function unreadableMessage(t: AccessTarget): string {
  return t.kind === 'share'
    ? `Share path '${t.path}' could not be read`
    : `Mountpoint '${t.mountpoint}' could not be read`
}

// ============================================================================
// Pure level helpers (moved verbatim from routes/datasets.ts)
// ============================================================================

/** Split a stat mode (e.g. `755`, `2770`) into its owner/group/other levels. */
function baseLevelsFromMode(mode: string): BaseLevels {
  // Keep the low three digits; a leading setuid/setgid/sticky digit is ignored
  // for level reporting (setgid is managed separately for ACL inheritance).
  const digits = mode.slice(-3).padStart(3, '0')
  const digit = (i: number) => Number.parseInt(digits[i], 10) || 0
  return {
    'owner': modeDigitToLevel(digit(0)),
    'owning-group': modeDigitToLevel(digit(1)),
    'everyone': modeDigitToLevel(digit(2)),
  }
}

const NUMERIC_ID_RE = /^\d+$/
/** A bare-numeric principal token means the uid/gid did not resolve to a name. */
function isNumericId(name: string): boolean {
  return NUMERIC_ID_RE.test(name)
}

/** Tag an entry as an orphan (unresolved uid/gid) when `orphan` is true. */
function orphanFlag(entry: AccessEntry, orphan: boolean): AccessEntry {
  return orphan ? { ...entry, unresolved: true } : entry
}

/** The base-three AccessEntry list derived from mode bits (mode-only datasets). */
function baseEntriesFromMode(mode: string, ownerOrphan = false, groupOrphan = false): AccessEntry[] {
  const levels = baseLevelsFromMode(mode)
  const digits = mode.slice(-3).padStart(3, '0')
  const bits = (i: number): string => {
    const d = Number.parseInt(digits[i], 8) || 0
    return `${d & 4 ? 'r' : '-'}${d & 2 ? 'w' : '-'}${d & 1 ? 'x' : '-'}`
  }
  return [
    orphanFlag({ kind: 'owner', level: levels.owner, perms: bits(0) }, ownerOrphan),
    orphanFlag({ kind: 'owning-group', level: levels['owning-group'], perms: bits(1) }, groupOrphan),
    { kind: 'everyone', level: levels.everyone, perms: bits(2) },
  ]
}

/** Does a `stat %a` mode carry the setgid bit (`2775`)? */
function hasSetgid(mode: string): boolean {
  return mode.length >= 4 && (Number.parseInt(mode[mode.length - 4], 8) & 2) !== 0
}

/**
 * cr3.shares M3: the 3-digit mode for a base-level edit, every digit the
 * request did not move keeping its LIVE value (`0751`, others moved to none
 * → `750`; owner moved → `751` keeps others' traverse bit).
 */
function levelsToModeKeeping(levels: BaseLevels, moved: readonly BaseKind[], liveMode: string): string {
  const live = liveMode.slice(-3).padStart(3, '0')
  return BASE_KINDS.map((kind, i) => moved.includes(kind) ? String(levelToOctalDigit(levels[kind])) : live[i]).join('')
}

/**
 * One principal's symbolic perms for a RECURSIVE chmod. Uses capital `X` so
 * execute lands only on directories (and files that already have it) — a
 * blanket numeric octal (`levelsToMode`) would sprinkle +x onto every plain
 * data file on a recursive Read grant. none → `` (empty), read → `rX`,
 * read-write → `rwX`.
 */
function levelToSymbolicPerms(level: AccessEntry['level']): string {
  switch (level) {
    case 'none': return ''
    case 'read': return 'rX'
    case 'read-write': return 'rwX'
  }
}

/** Base three levels → a symbolic chmod mode (`u=rwX,g=rX,o=`) for a recursive apply. */
function levelsToSymbolic(levels: BaseLevels): string {
  return `u=${levelToSymbolicPerms(levels.owner)},g=${levelToSymbolicPerms(levels['owning-group'])},o=${levelToSymbolicPerms(levels.everyone)}`
}

/**
 * A named (user/group) AccessEntry — kind narrowed, name guaranteed present.
 * `perms` (cr3.shares M3) is the exact perms field to write instead of the
 * level's canonical one: the principal's LIVE effective perms, carried when
 * the request leaves its level as it reads (a preserved entry, or a requested
 * one at the level the editor showed), so an Apply never rewrites what the
 * operator did not touch (`-w-`, `r--`, `--x`, a mask-clamped grant).
 */
type NamedEntry = AccessEntry & { kind: 'user' | 'group', name: string, perms?: string }

/** The same override for the base three (cr3.shares M3). */
type BasePerms = Partial<Record<BaseKind, string>>

/** What a request does to the named principals, against what was read (cr3.shares M3). */
interface NamedDelta {
  added: NamedEntry[]
  changed: NamedEntry[]
  removed: NamedEntry[]
}

/** Every execute bit as `X` — a recursive spec carries no literal `x` (see buildAclSpec). */
const EXEC_BIT_RE = /x/g

function isNamed(e: AccessEntry): e is NamedEntry {
  return (e.kind === 'user' || e.kind === 'group') && e.name !== undefined
}

/**
 * Build a `setfacl` spec declaratively from the base three levels plus the
 * named entries. The mask is the union (`rwx`) so no principal is masked below
 * its stated level — the reported level stays truthful.
 *
 * `recursive` is the spec for the walk over existing files: every execute bit
 * is the capital `X`, the mask included (`m::rwX`). setfacl resolves `X`
 * against the ACL it is building, so one literal `x` anywhere in the spec
 * makes every `X` resolve to `x` — the 0.4.3 live proof (§3, §3x) saw a
 * recursive apply leave every plain file `-rwxrwsr-x`. With `X` throughout a
 * plain file gets `rw-`/`r--` and a mask of `rw-`, a directory gets `rwx`/`r-x`.
 *
 * The DEFAULT (inheritance) ACL always takes the non-recursive form: default
 * entries exist only on directories, where `X` resolves to `x` anyway, so the
 * lowercase spec states exactly what is stored and is the same on a recursive
 * and a mountpoint-only apply. A file created with an ordinary `open()` does
 * not inherit execute from it: the kernel masks the inherited entries with
 * the creating call's mode (0666 for an ordinary file).
 */
function buildAclSpec(base: BaseLevels, named: NamedEntry[], recursive: boolean, basePerms: BasePerms = {}, liveMask?: string | null): string {
  const p = (level: AccessEntry['level'], kept?: string) => kept !== undefined
    ? (recursive ? kept.replace(EXEC_BIT_RE, 'X') : kept)
    : levelToAclPerms(level, recursive)
  const specs = [
    `u::${p(base.owner, basePerms.owner)}`,
    `g::${p(base['owning-group'], basePerms['owning-group'])}`,
    `o::${p(base.everyone, basePerms.everyone)}`,
  ]
  for (const n of named)
    specs.push(`${n.kind === 'user' ? 'u' : 'g'}:${n.name}:${p(n.level, n.perms)}`)
  if (liveMask === undefined || liveMask === null) {
    specs.push(recursive ? 'm::rwX' : 'm::rwx')
    return specs.join(',')
  }
  // cr3.shares M3: one directory's LIVE mask as found — kept when every
  // group-class entry fits inside it, else the narrowest that fits them all
  // (their union). Either way no principal's effective access moves except
  // the ones the request moved, and the reported levels stay truthful. (No
  // live mask — a first grant — is the managed `m::rwx`.)
  const groupClass = [specs[1], ...specs.slice(3)].map(e => e.slice(e.lastIndexOf(':') + 1))
  const union = ['r', 'w', 'x'].map((bit, i) => groupClass.some(g => g[i] === bit) ? bit : '-').join('')
  const fits = liveMask !== null && [...union].every((c, i) => c === '-' || liveMask[i] === c)
  specs.push(`m::${fits ? liveMask : union}`)
  return specs.join(',')
}

/**
 * cr3.shares M3: a MINIMAL access ACL spec — the base three alone, no named
 * entry and no mask — for the explicit clear of one directory. A principal
 * whose level the request leaves keeps its live bits (`group::` at what the
 * mask let it do, so dropping the mask never widens it).
 */
function buildBaseSpec(base: BaseLevels, basePerms: BasePerms): string {
  const p = (kind: BaseKind) => basePerms[kind] ?? levelToAclPerms(base[kind], false)
  return `u::${p('owner')},g::${p('owning-group')},o::${p('everyone')}`
}

/** True when the dataset has POSIX ACLs in effect (ZFS may print `posix`). */
function isPosixAcl(acltype: string): boolean {
  return acltype === 'posixacl' || acltype === 'posix'
}

/** The share fields a grant answers to (the stanza, or a request laid over it). */
export interface GrantShare { validUsers: string[], guestOk: boolean, readOnly: boolean }

/** Samba `valid users` group prefixes: `@` (NIS netgroup, then Unix group), `+` (Unix group), `&` (NIS). */
const GROUP_PREFIX_RE = /^[@+&]+/
/** A `%` substitution (`%U`, `%S`, …) names nobody until a client connects. */
const MACRO_RE = /%/

/**
 * The share's `valid users` list → the principals a grant names. `@x`, `+x`,
 * `&x` (and their combinations) are the group `x`; a bare name is a user. An
 * entry carrying a `%` macro names nobody in particular and is skipped
 * (reported back, never guessed at).
 */
export function sharePrincipals(validUsers: string[]): { principals: { kind: 'user' | 'group', name: string }[], skipped: string[] } {
  const principals: { kind: 'user' | 'group', name: string }[] = []
  const skipped: string[] = []
  for (const raw of validUsers) {
    const entry = raw.trim()
    if (!entry)
      continue
    const name = entry.replace(GROUP_PREFIX_RE, '')
    if (!name || MACRO_RE.test(name)) {
      skipped.push(entry)
      continue
    }
    const kind = name === entry ? 'user' : 'group'
    if (!principals.some(p => p.kind === kind && p.name === name))
      principals.push({ kind, name })
  }
  return { principals, skipped }
}

const LEVEL_RANK: Record<AccessLevel, number> = { 'none': 0, 'read': 1, 'read-write': 2 }

/** The higher of two levels — a grant never lowers what a principal already has. */
export function maxLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
}

// ============================================================================
// Results
// ============================================================================

/** A refusal the route sends as-is (status + the standard error body). */
export interface AccessFailure {
  status: 400 | 404 | 409
  body: { error: { code: string, message: string, reason?: string } }
}

export type AccessOutcome<T> = { ok: true, value: T } | { ok: false, failure: AccessFailure }

function fail(status: AccessFailure['status'], code: string, message: string): { ok: false, failure: AccessFailure } {
  return { ok: false, failure: { status, body: { error: { code, message } } } }
}

/** Everything the writer decided before the job; the job only executes it. */
export interface SetAccessPlan {
  target: AccessTarget
  dir: string
  req: SetAccessRequest
  recursive: boolean
  ownerChanged: boolean
  groupChanged: boolean
  baseChanged: boolean
  clearNamed: boolean
  supported: boolean
  enabled: boolean
  base: BaseLevels
  named: NamedEntry[]
  preservedNamedCount: number
  /**
   * cr3.shares M3: the live perms each base principal keeps — present for a
   * principal whose level the request leaves as it reads, so its exact bits
   * are restated rather than the level's canonical ones.
   */
  basePerms: BasePerms
  /** cr3.shares M3: the base principals whose level the request moves. */
  baseDelta: BaseKind[]
  /** cr3.shares M3: the named principals the request adds, moves or removes. */
  delta: NamedDelta
  /** The directory's mode as read (`stat %a`, a leading special digit included). */
  liveMode: string
  /** The live default ACL, or null when the directory has none (or ACLs are off). */
  liveDefault: ParsedAclSet | null
  /** The live access ACL's mask, or null when it has none (or ACLs are off). */
  liveMask: string | null
  hasNamed: boolean
  aclAutoEnabled: boolean
  clearAcls: boolean
  /**
   * Story nf.1 (wave-3 D2): the walk a recursive plan runs — read with the
   * plan and part of its revision, so the job walks exactly the scope the
   * confirm named, or refuses STATE_CHANGED. Null for a non-recursive plan.
   */
  walk: PlanWalk | null
  /**
   * Story cr.37: the revision of the state this plan was computed from — a
   * sha256 over the directory, its owner/group/mode, the ACL switch and the
   * live ACL text. The job re-reads it and refuses STATE_CHANGED when it
   * moved: the plan restates the named grants it READ, so running it over
   * an ACL entry added since would silently delete that entry (F4).
   */
  revision: string
  /** cr3.shares: the revision a GET of the editor reports for the same state (no walk facts). */
  readRevision: string
  /** cr3.shares N1: the directory's device and inode when planned (the pin must match). */
  dirId: DirId
}

/**
 * The editor's read revision (cr3.shares, second review): a hash of the
 * facts a GET shows and a plan is computed from — the directory, its owner,
 * group and mode, the ACL switch and the live `getfacl -pcE` answer — the
 * same facts the plan's route-to-job revision binds, without the walk.
 */
function accessReadRevision(dir: string, perm: MountpointPermissions, supported: boolean, enabled: boolean, aclRead: { exitCode: number, stdout: string } | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ dir, perm: [perm.owner, perm.group, perm.mode], supported, enabled, acl: aclRead }))
    .digest('hex')
}

/**
 * Story cr.37 (WAVE3-DESIGN §5.2 rule 1): the set-access request fields the
 * recursive confirm does NOT sign. None: owner, group, entries, clearNamed
 * and applyToExisting each change what the walk writes. The access tests pin
 * the list.
 */
export const SET_ACCESS_PRESENTATION_ONLY: Record<string, string> = {}

/** A set-access request with every field spelled out, so an omitted flag and its default sign the same. */
export function signedAccessRequest(req: SetAccessRequest): Record<string, unknown> {
  return {
    owner: req.owner ?? null,
    group: req.group ?? null,
    entries: req.entries ?? null,
    clearNamed: req.clearNamed === true,
    applyToExisting: req.applyToExisting === true,
  }
}

/**
 * What a set-access guard reads (cr.37): the resolved target and the plan
 * computed against its live state — or the refusal either produced, which
 * the spec's gates answer in the route's order.
 */
export interface AccessObject {
  target: AccessTarget | null
  resolveFailure: AccessFailure | null
  plan: SetAccessPlan | null
  planFailure: AccessFailure | null
}

/** An {@link AccessFailure} as a guard {@link Refusal}. */
function failureRefusal(f: AccessFailure): Refusal {
  const { code, message, reason } = f.body.error
  return { status: f.status, code: code as ErrorCode, message, ...(reason ? { reason } : {}) }
}

// ============================================================================
// The service
// ============================================================================

/**
 * A PVE-territory gate's refusal and WHICH fact it states (cr.47b):
 * `pveOwned: true` — PVE owns the object or something in its tree, the one
 * fact that answers 409 PVE_MANAGED at every door; `pveOwned: false` — the
 * daemon cannot SEE the answer (unreadable storage.cfg, unlistable subtree),
 * a different fact that keeps its 400. The doors map the flag; the helpers
 * never invent the status.
 */
export interface TerritoryRefusal {
  message: string
  pveOwned: boolean
}

export interface AccessServiceOptions {
  executor: CommandExecutor
  /** iSCSI read-layer overrides — the held-by-LUN gate on AHR targets. */
  iscsiPaths?: IscsiPaths
  /** storage.cfg override; defaults to ANAS_STORAGE_CFG, then the real path. */
  pveStorageCfg?: string
  /**
   * The walk helper run for "apply to existing files" (default
   * {@link ANAS_ACL_WALK}, the copy beside this module); a test may name
   * another script.
   */
  aclWalkScript?: string
}

export type AccessService = ReturnType<typeof createAccessService>

export function createAccessService(opts: AccessServiceOptions) {
  const { executor } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}
  const aclWalkScript = opts.aclWalkScript ?? ANAS_ACL_WALK

  /** Stat a directory for owner/group/mode, or null if it can't be read. */
  async function statMountpoint(mountpoint: string): Promise<MountpointPermissions | null> {
    const r = await executor.exec(STAT, ['-c', '%U %G %a', mountpoint])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    const [owner, group, mode] = r.stdout.trim().split(WHITESPACE_RE)
    if (!owner || !group || !mode)
      return null
    return { owner, group, mode }
  }

  /**
   * Is `getfacl`/`setfacl` present (the `acl` package)? Feature-detect via
   * `getfacl --version` and memoize ONLY the positive answer (cr.53 L27):
   * a probe that exits non-zero answers "absent" for THIS call but is not
   * cached, because a failed probe is not always a fact about the package —
   * a transient one (fork/EAGAIN under load) cached for the process lifetime
   * would have every later plan skip the ACL read and plan from the mode
   * bits, the mask hazard the unreadable-ACL refusal (composePlan) exists to
   * prevent. A true answer is stable (packages do not appear at runtime),
   * cached, and its Promise lets concurrent callers share one probe; a false
   * answer costs one re-probe per call until it succeeds or the daemon
   * restarts.
   */
  let aclSupportedCache: Promise<boolean> | null = null
  function aclSupported(): Promise<boolean> {
    if (aclSupportedCache !== null)
      return aclSupportedCache
    const probe = executor.exec(GETFACL, ['--version']).then((r) => {
      if (r.exitCode !== 0 && aclSupportedCache === probe)
        aclSupportedCache = null
      return r.exitCode === 0
    }, (err: unknown) => {
      if (aclSupportedCache === probe)
        aclSupportedCache = null
      throw err
    })
    aclSupportedCache = probe
    return probe
  }

  /** The dataset's `acltype` value (`off`, `posixacl`, …); '' if unreadable. */
  async function getAcltype(dataset: string): Promise<string> {
    // cr.21: `--` ends option parsing so `dataset` is always the operand.
    const r = await executor.exec(ZFS, ['get', '-Hp', '-o', 'value', 'acltype', '--', dataset])
    return r.exitCode === 0 ? r.stdout.trim() : ''
  }

  /** POSIX ACLs in effect on the target: ZFS asks `acltype`; anything else has them natively. */
  async function aclOn(t: AccessTarget): Promise<boolean> {
    const ds = aclDatasetOf(t)
    return ds === null ? true : isPosixAcl(await getAcltype(ds))
  }

  // --- ZFS target resolution ------------------------------------------------

  /** Pool + wildcard tail → full dataset name, or the 400 for a bad path. */
  function zfsFullName(poolName: string, path: string): AccessOutcome<string> {
    if (!path)
      return { ok: true, value: poolName }
    const pathParsed = DatasetPath.safeParse(path)
    if (!pathParsed.success)
      return fail(400, 'VALIDATION_ERROR', `Invalid dataset path: ${pathParsed.error.issues[0]?.message}`)
    return { ok: true, value: `${poolName}/${pathParsed.data}` }
  }

  /**
   * Resolve the pool + wildcard tail to a mounted-filesystem mountpoint for the
   * access editor. 404 for an unknown dataset, a volume, or an unmounted
   * filesystem — access applies to a real directory.
   */
  async function resolveZfsTarget(poolName: string, path: string): Promise<AccessOutcome<ZfsAccessTarget>> {
    const name = zfsFullName(poolName, path)
    if (!name.ok)
      return name
    const fullName = name.value
    // cr.21: `--` ends option parsing so `fullName` is always the operand.
    const r = await executor.exec(ZFS, ['get', '-j', 'all', '--', fullName])
    const parsed = r.exitCode === 0 && r.stdout.trim() ? parseDatasetGet(r.stdout, fullName) : null
    if (!parsed)
      return fail(404, 'NOT_FOUND', `Dataset '${fullName}' not found`)
    if (parsed.base.type !== 'filesystem' || !parsed.base.mountpoint)
      return fail(404, 'NOT_FOUND', `Dataset '${fullName}' is not a mounted filesystem`)
    return { ok: true, value: { kind: 'zfs', dataset: fullName, mountpoint: parsed.base.mountpoint } }
  }

  /** A share path → its home (the ONE path resolver the self-service decisions use). */
  async function resolveShareTarget(configured: string): Promise<ShareAccessTarget> {
    // cr3.shares H2: the target is the REAL path from the one safe-path walk
    // ({@link safeResolve}); the configured one rides along. A path the walk
    // refuses stays as configured and carries the refusal — the plan answers it.
    // N7 (third review): the component walk runs lstat/readlink in this
    // process, and a dead hard mount on the path would block a libuv thread
    // for ever — so the path first gets the share-path family's bounded child
    // probe (`timeout 2 stat -f`); one that does not answer is refused.
    const probe = await probeSharePath(executor, configured)
    const walked = probe.state === 'not-answering'
      ? { refusal: `'${configured}' is not answering (${probe.detail ?? 'no answer'}) — the storage under it, usually a network mount, is hung; nothing was read or changed` }
      : await safeResolve(configured)
    const real = 'real' in walked ? walked.real : null
    const path = real ?? configured
    const extra = {
      ...(real !== null && real !== normalizePath(configured) ? { configuredPath: configured } : {}),
      ...('refusal' in walked ? { pathRefusal: walked.refusal } : {}),
    }
    const home = await resolveSelfServiceTarget(executor, path)
    if (home?.kind === 'zfs')
      return { kind: 'share', path, home: { kind: 'zfs', dataset: home.dataset }, ...extra }
    if (home?.kind === 'ahr') {
      const r = home.poolRecord
      return { kind: 'share', path, home: { kind: 'ahr', pool: home.pool, record: { name: r.name, mountpoint: r.mountpoint, mounted: r.mounted }, ...(r.vg.uuid ? { vgUuid: r.vg.uuid } : {}) }, ...extra }
    }
    return { kind: 'share', path, home: null, ...extra }
  }

  // --- PVE territory ----------------------------------------------------------

  /** The pool's flat dataset list, or null when the probe FAILED (never "no descendants"). */
  async function listDatasetsOrNull(poolName: string) {
    const r = await executor.exec(ZFS, zfsListArgs(poolName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    return parseZfsList(r.stdout)
  }

  /**
   * Story ident.1 (audit #20): the refusal for a RECURSIVE permission change
   * (chown/chmod/setfacl `-R`) whose tree holds a PVE-owned descendant — the
   * same `ownedDescendant` question a recursive destroy or snapshot asks —
   * or null when there is none. An unreadable dataset list refuses (a walk the
   * daemon cannot see through is never allowed).
   */
  async function zfsRecursiveRefusal(poolName: string, fullName: string): Promise<TerritoryRefusal | null> {
    const datasets = await listDatasetsOrNull(poolName)
    if (!datasets)
      return { message: pveDescendantsUnlistedMessage('permission change', fullName), pveOwned: false }
    const descendant = (await loadPveFootprint(executor)).ownedDescendant(datasets, fullName)
    return descendant
      ? { message: pveRecursiveRefusalMessage('Recursive permission change', fullName, descendant), pveOwned: descendant.ownership.kind !== 'config-unreadable' }
      : null
  }

  /**
   * storage.cfg's filesystem paths (`path` of dir/nfs/cifs storages,
   * `mountpoint` of zfspool storages) → storage id, for a NON-ZFS directory —
   * the ZFS side asks the footprint service instead. ENOENT is a node without
   * PVE (no paths); any other read failure is UNKNOWN and answers null, which
   * the gates read as a refusal (missing facts may only tighten).
   */
  async function pveStoragePaths(): Promise<Map<string, string> | null> {
    const file = opts.pveStorageCfg ?? process.env.ANAS_STORAGE_CFG ?? PVE_STORAGE_CFG
    try {
      return parsePveMountPaths(await readFile(file, 'utf8'))
    }
    catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Map() : null
    }
  }

  function storageUnreadableMessage(dir: string): string {
    return `Could not read the PVE storage configuration — refusing the permission change on '${dir}' until it can be read`
  }

  /** A non-ZFS directory that sits at or under a PVE storage's path is PVE's to manage. */
  async function pathOwnershipRefusal(dir: string): Promise<TerritoryRefusal | null> {
    const paths = await pveStoragePaths()
    if (!paths)
      return { message: storageUnreadableMessage(dir), pveOwned: false }
    for (const [storagePath, storage] of paths) {
      if (isPathWithin(storagePath, dir))
        return { message: `'${dir}' is inside '${storagePath}', the path of PVE storage '${storage}' — its permissions are PVE's to manage`, pveOwned: true }
    }
    return null
  }

  /** A recursive walk over a non-ZFS directory that holds a PVE storage's path below it. */
  async function pathRecursiveRefusal(dir: string): Promise<TerritoryRefusal | null> {
    const paths = await pveStoragePaths()
    if (!paths)
      return { message: storageUnreadableMessage(dir), pveOwned: false }
    for (const [storagePath, storage] of paths) {
      if (storagePath !== dir && isPathWithin(dir, storagePath))
        return { message: `Recursive permission change of '${dir}' would include ${storagePath} — the path of PVE storage '${storage}'`, pveOwned: true }
    }
    return null
  }

  /**
   * The gates for an AHR or share target, in the order the ZFS route asks
   * them: PVE ownership of the directory (400), then — only for
   * `applyToExisting` — PVE territory beneath it (400). The ZFS route keeps
   * its own pre-lift ordering ({@link zfsRecursiveRefusal} + the footprint's
   * `ownershipOf`); this is the same question asked of a path.
   *
   * No held-by-LUN refusal (operator ruling 2026-10-11): a permission change
   * does not touch a LUN image's contents, the ZFS editor never gated a
   * dataset holding an image file, and the gate left an AHR pool that holds a
   * LUN without any writable share. The LUN is disclosed in the recursive
   * apply's confirm instead ({@link recursiveConfirm}).
   */
  async function guardPathTarget(t: AhrAccessTarget | ShareAccessTarget, req: SetAccessRequest): Promise<AccessFailure | null> {
    const dir = targetDir(t)
    // cr.47b: a PVE-territory FACT answers 409 PVE_MANAGED (the one answer,
    // reason `pve-managed`); a fact the daemon cannot see (unreadable
    // storage.cfg, unlistable subtree) is a DIFFERENT fact and keeps 400.
    const pveFail = (message: string): AccessFailure => ({ status: 409, body: { error: { code: 'PVE_MANAGED', reason: 'pve-managed', message } } })
    const bad = (message: string): AccessFailure => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } })
    const fail = (r: TerritoryRefusal): AccessFailure => (r.pveOwned ? pveFail(r.message) : bad(r.message))

    if (t.kind === 'share') {
      // The share backstop's own answer (pvepool.1): a path on an owned
      // dataset, or inside a dir storage's path on ZFS. The config-unreadable
      // verdict is the cannot-see fact (cr.47b) and keeps its 400. cr3.shares
      // M4: asked whatever home the path resolved onto — a failed `zfs list`
      // resolves a path on an owned dataset onto NO home — and any answer
      // other than a claim or a positive "no claim" is the footprint saying
      // it could not see, refused 400.
      const verdict = (await loadPveFootprint(executor)).sharePathVerdict(dir)
      if (verdict.kind === 'claim') {
        const claim = verdict.claim
        if (claim.kind === 'dataset')
          return claim.ownership.kind === 'config-unreadable' ? bad(claim.ownership.reason) : pveFail(claim.ownership.reason)
        return pveFail(`'${dir}' is inside '${claim.path}', a path PVE storage '${claim.storage}' claims`)
      }
      if (verdict.kind !== 'no-claim') {
        const reason = (verdict as { reason?: unknown }).reason
        return bad(cannotSeeMessage('Share path', dir, typeof reason === 'string' && reason ? reason : 'the footprint could not be read'))
      }
    }
    if (t.kind !== 'share' || t.home?.kind !== 'zfs') {
      const owned = await pathOwnershipRefusal(dir)
      if (owned)
        return fail(owned)
    }

    if (req.applyToExisting === true) {
      if (t.kind === 'share' && t.home?.kind === 'zfs') {
        const poolName = t.home.dataset.split('/')[0]
        const refusal = await zfsRecursiveRefusal(poolName, t.home.dataset)
        if (refusal)
          return fail(refusal)
      }
      const refusal = await pathRecursiveRefusal(dir)
      if (refusal)
        return fail(refusal)
    }
    return null
  }

  // --- The recursive walk on ZFS: child datasets ------------------------------------

  /**
   * The child datasets a recursive walk from `dir` enters (operator ruling
   * 2026-10-11): `setfacl -R`/`chown -R`/`chmod -R` cross into every
   * descendant of `dataset` MOUNTED under `dir`. A descendant whose mountpoint
   * is `legacy`, `none`, or somewhere outside `dir` is not reached by the walk
   * and is left out. Null when the list cannot be read.
   */
  async function childDatasetsUnder(dataset: string, dir: string): Promise<ChildDataset[] | null> {
    const r = await executor.exec(ZFS, ['list', '-r', '-H', '-o', 'name,mountpoint,acltype', '--', dataset])
    if (r.exitCode !== 0)
      return null
    const children: ChildDataset[] = []
    for (const line of r.stdout.split('\n')) {
      const [name, mountpoint, acltype] = line.split('\t')
      if (!name || !mountpoint || name === dataset || !name.startsWith(`${dataset}/`))
        continue
      if (!mountpoint.startsWith('/') || mountpoint === dir || !isPathWithin(dir, mountpoint))
        continue
      children.push({ name, mountpoint, acltype: (acltype ?? '').trim() })
    }
    return children
  }

  /**
   * The walk a recursive apply on `t` runs (story nf.1, wave-3 D2): the
   * mount table (`findmnt --json`, which reads /proc/self/mountinfo and never
   * touches a filesystem) and, on ZFS, the child datasets the walk crosses.
   * Both are needed to say what the walk enters and what it leaves alone, so
   * either one unreadable is an answer of its own — the plan refuses rather
   * than walk a scope it cannot name.
   */
  async function readWalk(t: AccessTarget, dir: string): Promise<{ walk: PlanWalk } | { unreadable: string }> {
    const ds = aclDatasetOf(t)
    const children = ds !== null ? await childDatasetsUnder(ds, dir) : []
    if (!children)
      return { unreadable: `the child datasets of '${ds}' could not be listed` }
    const r = await executor.exec(FINDMNT, ['--json'])
    if (r.exitCode !== 0 || !isFindmntTable(r.stdout))
      return { unreadable: `the mount table could not be read (findmnt ${r.exitCode !== 0 ? `exited ${r.exitCode}` : 'answered in an unknown shape'})` }
    const mounts = mountIndex(r.stdout)
    // D2 (third review): the nested btrfs subvolumes of the tree are walk
    // roots of their own (each has its own device number, where the walk
    // stops) — read with the plan. Fourth review: a list that answered
    // nothing usable is a FAILED read, never "no subvolumes" (the walk would
    // then leave every nested subvolume unchanged): bounded by a deadline,
    // every line must parse, and a mount of a subvolume must find that
    // subvolume itself in the list.
    let subvolumes: string[] = []
    const own = mountRowOf(dir, mounts)
    if (own?.fstype === 'btrfs') {
      const cannot = (why: string): { unreadable: string } => ({ unreadable: `the btrfs subvolumes under '${dir}' could not be listed (btrfs subvolume list ${why})` })
      const list = await executor.exec(BTRFS, ['subvolume', 'list', own.target], { timeoutMs: BTRFS_LIST_TIMEOUT_MS }).catch((err: unknown) => err instanceof Error ? err : new Error(String(err)))
      if (list instanceof Error)
        return cannot(`did not answer: ${list.message}`)
      if (list.exitCode !== 0)
        return cannot(`exited ${list.exitCode}`)
      const parsed = parseBtrfsSubvolList(list.stdout)
      if (parsed.length !== list.stdout.split('\n').filter(l => l.trim() !== '').length)
        return cannot('answered lines it could not read')
      const mounted = mountedSubvolume(own)
      if (mounted !== '' && !parsed.some(v => subvolumeRelPath(v.path) === mounted))
        return cannot(`did not list the mounted subvolume '${mounted}' itself`)
      subvolumes = nestedSubvolumes(parsed.map(v => v.path), own, dir)
    }
    const scope = walkScopeFrom(dir, mounts, children, subvolumes)
    const crossed = new Set(scope.crossed.map(c => c.name))
    // N1: every root's identity, as the plan sees it now.
    const rootIds: DirId[] = []
    for (const root of scope.roots) {
      const st = await accessDirIo.lstat(root.path).catch(() => null)
      if (!st || !st.isDirectory())
        return { unreadable: `the walk root '${root.path}' could not be read` }
      rootIds.push({ dev: st.dev, ino: st.ino })
    }
    // Fifth review D6: each excluded mount's identity, as the plan sees it —
    // its mount id from the mount table, the directory holding its
    // mountpoint by lstat (inside the walked tree: never the mount).
    const table = await accessDirIo.mountinfo().catch(() => '')
    const ids = mountIdsAt(table, scope.excluded.map(e => e.target))
    const excludedIds: (ExcludedIdentity | null)[] = []
    for (const [i, e] of scope.excluded.entries()) {
      const id = ids[i]
      const parent = id !== null ? await accessDirIo.lstat(dirname(e.target)).catch(() => null) : null
      excludedIds.push(id !== null && parent ? { mnt: id, parent: parent.ino, leaf: basename(e.target) } : null)
    }
    return { walk: { ...scope, children: children.filter(c => crossed.has(c.name)), rootIds, excludedIds } }
  }

  /**
   * Before the walk touches anything: every NFS/CIFS mount it leaves alone
   * gets the mounts family's ONE liveness probe (`timeout 2 stat -f`). The
   * walk never enters such a mount, but it still lstats the mountpoint while
   * it reads the parent directory, and a dead server hangs that lstat for
   * ever — with the dataset's lock held (wave-3 N2b). A dead one refuses the
   * job, naming it; an inconclusive probe is not a refusal (as in the
   * nested-filesystem scan). Armed automounts are never probed (Epic 18).
   */
  async function refuseDeadRemotes(walk: PlanWalk, dir: string): Promise<void> {
    const remotes = walk.excluded.filter(e => isProbeableKind(kindOfMount({ target: e.target, source: '', fstype: e.fstype, options: '' })))
    for (const mount of remotes) {
      const probe = await probeMount(executor, mount.target).catch(() => null)
      if (probe?.state === 'unreachable')
        throw new Error(`No permissions were changed: ${mount.target} (${mount.fstype}), mounted under '${dir}', did not answer a 2 s liveness probe. The walk does not enter it, but it reads its mountpoint and would hang there with the lock held — unmount it or bring its server back, then apply again`)
    }
  }

  /**
   * Before a recursive apply with named entries on a ZFS target: switch POSIX
   * ACLs on for every child dataset the walk enters that has them off — the
   * SAME rule the target gets on its first named grant — BEFORE any permission
   * is touched. A child with `acltype=off` would otherwise make the walk's
   * `setfacl` fail part-way, after the parent (and every child before it) was
   * already rewritten. Returns the children it enabled; throws, naming the
   * child, when an enable fails (nothing else has run). The children are the
   * plan's (nf.1: read with the plan, bound by its revision).
   */
  async function enableChildAcls(children: ChildDataset[], updateProgress: (msg: string) => void): Promise<string[]> {
    const enabled: string[] = []
    for (const child of children) {
      if (isPosixAcl(child.acltype))
        continue
      updateProgress(`zfs set acltype=posixacl xattr=sa ${child.name}`)
      // cr.21: `--` ahead of every operand (the property VALUES are derived too).
      const r = await executor.exec(ZFS, ['set', '--', 'acltype=posixacl', 'xattr=sa', child.name])
      if (r.exitCode !== 0) {
        const already = enabled.length > 0 ? ` POSIX ACLs were already switched on for ${enabled.join(', ')}.` : ''
        throw new Error(`Could not switch POSIX ACLs on for child dataset '${child.name}' (mounted at ${child.mountpoint}) — no permissions were changed.${already} ${r.stderr.trim() || `zfs set exited with code ${r.exitCode}`}`)
      }
      enabled.push(child.name)
    }
    return enabled
  }

  // --- The recursive apply's confirm (Principle 14, Level 2) ---------------------

  /**
   * The confirm a recursive apply (`applyToExisting`) carries on every door —
   * the editor's PUT on a dataset, an AHR pool or a share path, and the SMB
   * share create/edit grant (operator ruling 2026-10-11). The headline says
   * what will happen; the warnings say what the walk reaches on THIS target:
   * the child datasets it crosses on ZFS (and which get ACLs switched on
   * first), the subvolume sweep on AHR, and any iSCSI LUN image under the
   * path. The signature is the resource only (`fs.setAccess.recursive` + the
   * target), like every other confirm.
   */
  async function recursiveConfirm(t: AccessTarget, opts: { named: boolean, walk?: PlanWalk | null }): Promise<{ operation: string, params: Record<string, unknown>, message: string, warnings: string[] }> {
    const dir = targetDir(t)
    const warnings: string[] = []
    const ds = aclDatasetOf(t)
    // Story nf.1: the walk the plan read (and its revision binds). A caller
    // without one gets a fresh read; an unreadable one is said, never guessed.
    const read = opts.walk ? { walk: opts.walk } : await readWalk(t, dir)
    if ('unreadable' in read) {
      warnings.push(`ANAS could not tell which filesystems the walk would cross under '${dir}' (${read.unreadable}); the change will be refused until it can.`)
    }
    else {
      const { children, excluded } = read.walk
      if (ds !== null && children.length > 0) {
        warnings.push(`It crosses the child datasets mounted under '${dir}': ${children.map(c => `${c.name} (${c.mountpoint})`).join(', ')}.`)
        const off = children.filter(c => !isPosixAcl(c.acltype)).map(c => c.name)
        if (opts.named && off.length > 0)
          warnings.push(`POSIX ACLs (acltype=posixacl) are switched on first for ${off.join(', ')}, as for '${ds}' itself.`)
      }
      // Wave-3 D2: every other filesystem mounted below is left alone, and said so.
      if (excluded.length > 0)
        warnings.push(`It does not enter the other filesystems mounted under '${dir}' — not changed: ${notChangedList(excluded).join(', ')}.`)
    }
    if (targetBacking(t) === 'ahr')
      warnings.push('On a Hybrid RAID pool it sweeps every subvolume under the pool\'s data as one tree; the pool\'s snapshots are not touched.')
    const held = await heldByLunOnce(executor, { path: dir }, iscsiPaths)
    if (held)
      warnings.push(`The walk includes the image of ${held.unmapped === true ? heldHolderPhrase(held) : `iSCSI LUN ${held.index} '${held.name}' of target ${held.targetIqn}`} (${held.backingPath}): its owner, mode and ACL change, its contents do not.`)
    warnings.push('The current permissions are not recorded anywhere, so this cannot be undone.')
    const params: Record<string, unknown> = t.kind === 'zfs'
      ? { dataset: t.dataset }
      : t.kind === 'ahr' ? { pool: t.pool } : { path: t.path }
    return {
      operation: 'fs.setAccess.recursive',
      params,
      message: `Applying to existing files rewrites the permissions of every file and directory under '${dir}'`,
      warnings,
    }
  }

  // --- Read ---------------------------------------------------------------------

  /** The layered access state of the target's directory (GET …/access). */
  async function readAccess(t: AccessTarget): Promise<AccessOutcome<DatasetAccess>> {
    const dir = targetDir(t)
    const perm = await statMountpoint(dir)
    if (!perm)
      return fail(404, 'NOT_FOUND', unreadableMessage(t))

    const supported = await aclSupported()
    const enabled = await aclOn(t)

    let entries: AccessEntry[]
    let aclText: string | null = null
    /** acltype says posixacl, but the ACL itself could not be read (#37). */
    let aclDegraded = false
    /** The `getfacl -pcE` answer, exactly as a plan reads it (the read revision). */
    let aclRead: { exitCode: number, stdout: string } | null = null

    // A principal whose uid/gid no longer resolves shows as a bare number
    // (getfacl/stat print the numeric id) — an orphan from a delete outside
    // ANAS. Flag it so the UI can render "unknown (uid N)".
    const ownerOrphan = isNumericId(perm.owner)
    const groupOrphan = isNumericId(perm.group)

    if (enabled && supported) {
      // ACLs are live: read the full ACL and map it to entries.
      const r = await executor.exec(GETFACL, ['-pcE', dir])
      aclRead = { exitCode: r.exitCode, stdout: r.stdout }
      if (r.exitCode === 0 && r.stdout.trim()) {
        const acl = parseGetfacl(r.stdout)
        // cr3.shares M3: a group-class entry reads as what the mask lets it
        // do — a hand-written mask can clamp a grant below its text. Each row
        // carries its live bits (`perms`, second review) so a CUSTOM row
        // (`-w-`, `r--`) is shown as such, never as a level it is not.
        const g = effectivePerms(acl.owningGroup, acl.mask)
        entries = [
          orphanFlag({ kind: 'owner', level: permsToLevel(acl.owner), perms: acl.owner }, ownerOrphan),
          orphanFlag({ kind: 'owning-group', level: permsToLevel(g), perms: g }, groupOrphan),
          { kind: 'everyone', level: permsToLevel(acl.everyone), perms: acl.everyone },
          // Named entries; mask + default entries are managed, not shown.
          ...acl.named.map((n): AccessEntry => {
            const eff = effectivePerms(n.perms, acl.mask)
            return orphanFlag({ kind: n.type, name: n.name, level: permsToLevel(eff), perms: eff }, isNumericId(n.name))
          }),
        ]
      }
      else {
        // ACLs enabled but unreadable. The mode bits are all we have, so the
        // entries below are an APPROXIMATION and any named grants are missing
        // from them. Say so (aclDegraded) and stop claiming healthy ACLs —
        // a client that believed `aclEnabled: true` here would present an empty
        // named list as the truth and let the operator "apply" it (#37).
        aclDegraded = true
        entries = baseEntriesFromMode(perm.mode, ownerOrphan, groupOrphan)
      }
      // Raw ACL text (with header, no effective comments) for the Advanced panel.
      const raw = await executor.exec(GETFACL, ['-pE', dir])
      aclText = raw.exitCode === 0 ? raw.stdout : null
    }
    else {
      // No ACLs: the base three come straight from the mode bits.
      entries = baseEntriesFromMode(perm.mode, ownerOrphan, groupOrphan)
    }

    const data: DatasetAccess = {
      owner: perm.owner,
      group: perm.group,
      aclSupported: supported,
      aclEnabled: enabled && !aclDegraded,
      entries,
      aclText,
      // cr3.shares (second review): what this read saw, for `expectedRevision`.
      revision: accessReadRevision(dir, perm, supported, enabled, aclRead),
    }
    if (aclDegraded)
      data.aclDegraded = true
    return { ok: true, value: data }
  }

  // --- Write --------------------------------------------------------------------

  /**
   * Plan a set-access request against the target's CURRENT state (stat, the
   * feature-detect, the ACL switch, the live ACL) — the reads happen outside
   * the job, like the pre-lift route did. The caller has already asked the
   * gates; this answers the 404 for an unreadable directory and the 409 for
   * an unreadable ACL (D1 below).
   */
  async function planSetAccess(t: AccessTarget, req: SetAccessRequest): Promise<AccessOutcome<SetAccessPlan>> {
    const dir = targetDir(t)
    const perm = await statMountpoint(dir)
    if (!perm)
      return fail(404, 'NOT_FOUND', unreadableMessage(t))
    // cr3.shares H2: a share path is resolved ONCE, by the safe-path walk
    // (resolveShareTarget); a dataset or pool mountpoint must already be its
    // own real path. The writes then pin R.
    if (t.kind === 'share' && t.pathRefusal)
      return fail(409, 'CONFLICT', t.pathRefusal)
    if (t.kind !== 'share') {
      const walked = await safeResolve(dir)
      if ('refusal' in walked)
        return fail(409, 'CONFLICT', walked.refusal)
      if (walked.real !== normalizePath(dir))
        return fail(409, 'CONFLICT', `'${dir}' resolves to '${walked.real}' — a mountpoint must be its own real path; nothing was changed`)
    }
    // N1 (third review): the directory's identity, which the pin must match.
    const dirStat = await accessDirIo.lstat(normalizePath(dir)).catch(() => null)
    if (!dirStat || !dirStat.isDirectory())
      return fail(404, 'NOT_FOUND', unreadableMessage(t))
    const dirId: DirId = { dev: dirStat.dev, ino: dirStat.ino }

    const recursive = req.applyToExisting === true

    const requestedNamed = (req.entries ?? []).filter(isNamed)
    // N4 (third review): one principal, one row — two rows naming the same
    // user (or group) two ways, a name and its numeric id, are refused. The
    // ids come from the same nsswitch lookup the share grant uses (getent);
    // a name that does not resolve is not a duplicate of anything.
    if (requestedNamed.length >= 2) {
      const seen = new Map<string, string>()
      for (const e of requestedNamed) {
        const id = await principalId(e.kind, e.name)
        if (id === null)
          continue
        const key = `${e.kind}:${id}`
        const first = seen.get(key)
        if (first !== undefined)
          return fail(400, 'VALIDATION_ERROR', `'${first}' and '${e.name}' name the same ${e.kind} (${e.kind === 'user' ? 'uid' : 'gid'} ${id}) — a principal may appear only once`)
        seen.set(key, e.name)
      }
    }
    const baseChanged = req.entries !== undefined
    /** Named grants are stripped ONLY on an explicit request (#37). */
    const clearNamed = req.clearNamed === true

    // owner/group only when actually changing (respect the current identity).
    const ownerChanged = req.owner !== undefined && req.owner !== perm.owner
    const groupChanged = req.group !== undefined && req.group !== perm.group

    // Plan reads (feature-detect + current ACL state) outside the job.
    const supported = await aclSupported()
    const enabled = await aclOn(t)

    // When ACLs are live, read the ACL once up front and reuse it for BOTH the
    // base-level fallback and the named grants we must preserve — one getfacl.
    let liveAcl: ParsedAcl | null = null
    let aclRead: { exitCode: number, stdout: string } | null = null
    if (enabled && supported) {
      const r = await executor.exec(GETFACL, ['-pcE', dir])
      aclRead = { exitCode: r.exitCode, stdout: r.stdout }
      if (r.exitCode === 0 && r.stdout.trim()) {
        liveAcl = parseGetfacl(r.stdout)
      }
      else {
        // cr.37 review (D1): ACLs enabled but unreadable. readAccess marks
        // that aclDegraded and composeGrant refuses it — the write plan is the
        // one door that must not keep planning from the mode bits: a named
        // request would run `setfacl -R -b -m` (or `--set`) and strip every
        // grant nobody read, and a base-only edit would compute levels off the
        // mode whose group digit is the ACL MASK. Refuse the way the guard's
        // unbound read refuses (409 CONFLICT): the operator fixes the read.
        return fail(409, 'CONFLICT', `Could not read the POSIX ACLs of '${dir}', so the existing grants are unknown — refusing a change that would replace them`)
      }
    }
    // Story nf.1 (wave-3 D2): a recursive plan reads the walk it will run —
    // the roots, the mounts it leaves alone, the child datasets it crosses —
    // and refuses when it cannot (a scope nobody can name is not confirmed).
    let walk: PlanWalk | null = null
    if (recursive) {
      const read = await readWalk(t, dir)
      if ('unreadable' in read)
        return fail(409, 'CONFLICT', `Could not tell which filesystems a recursive change of '${dir}' would cross: ${read.unreadable} — refusing it until they can be read`)
      walk = read.walk
    }

    // Story cr.37: every fact the plan below is computed from, as one hash.
    // nf.1: the walk's scope with it, so a child dataset or a mount that
    // appears under the target after the confirm moves the revision and the
    // job refuses STATE_CHANGED instead of walking what nobody confirmed.
    const walkFacts = walk
      ? { roots: walk.roots, rootIds: walk.rootIds, excluded: walk.excluded, excludedIds: walk.excludedIds, children: walk.children.map(c => [c.name, c.mountpoint, c.acltype]) }
      : null
    const revision = createHash('sha256')
      .update(JSON.stringify({ dir, dirId, perm: [perm.owner, perm.group, perm.mode], supported, enabled, acl: aclRead, ...(walkFacts ? { walk: walkFacts } : {}) }))
      .digest('hex')
    // cr3.shares (second review): the same facts without the walk — what a
    // GET of the editor saw (its `revision`), compared to `expectedRevision`.
    const readRevision = accessReadRevision(dir, perm, supported, enabled, aclRead)

    // Desired base three: a supplied entry overrides the current level, so a
    // partial request never silently drops an unmentioned base principal. The
    // fallback "current" level must be the REAL current level: when ACLs are
    // live, take it from the actual ACL (`group::` etc.) — the mode's group
    // digit is the ACL MASK (rwx), not the owning-group level, so reading it as
    // the group level would silently escalate an omitted owning-group to
    // read-write. With no ACLs, the mode bits ARE the truth.
    //
    // cr3.shares M3: and the real level is the EFFECTIVE one — `group::` and
    // every named entry as the live mask lets them act, so an Apply that
    // restates them with the managed `m::rwx` never hands a clamped principal
    // a bit it could not use.
    const livePerms: Record<BaseKind, string> | null = liveAcl
      ? { 'owner': liveAcl.owner, 'owning-group': effectivePerms(liveAcl.owningGroup, liveAcl.mask), 'everyone': liveAcl.everyone }
      : null
    const current: BaseLevels = livePerms
      ? {
          'owner': permsToLevel(livePerms.owner),
          'owning-group': permsToLevel(livePerms['owning-group']),
          'everyone': permsToLevel(livePerms.everyone),
        }
      : baseLevelsFromMode(perm.mode)
    const levelOf = (kind: BaseKind) => req.entries?.find(e => e.kind === kind)?.level ?? current[kind]
    const base: BaseLevels = {
      'owner': levelOf('owner'),
      'owning-group': levelOf('owning-group'),
      'everyone': levelOf('everyone'),
    }

    // A base-only edit PRESERVES the live named grants — it never deletes them
    // by omission (#37). Restating them in the declarative `setfacl --set` is
    // also the only correct way to move the base levels on an ACL'd directory:
    // a plain chmod would write the ACL MASK, not `group::`. When there is
    // nothing to preserve (no live ACL, or the caller asked to clear) this list
    // is empty and the mode-bit path below runs as before.
    //
    // cr3.shares M3: restated at their EFFECTIVE perms, verbatim — never
    // through the three-level abstraction, which turned `-w-` into `rwx`,
    // `r--` into `r-x` and `--x` (traverse) into `---`.
    const liveNamed: NamedEntry[] = (liveAcl?.named ?? []).map((n) => {
      const eff = effectivePerms(n.perms, liveAcl?.mask)
      return { kind: n.type, name: n.name, level: permsToLevel(eff), perms: eff }
    })
    const preservedNamed: NamedEntry[] = (baseChanged && requestedNamed.length === 0 && !clearNamed)
      ? liveNamed
      : []
    // A requested entry left at the level the editor showed for it keeps its
    // live perms too: adding one principal changes nobody else's bits.
    //
    // cr3.shares (third review D3): nothing the edit did not name moves —
    // custom rows (`--x` traverse, a `-wx` drop box) included. The panel
    // echoes the bits the GET gave for every row whose level control the
    // operator did not change; a row whose echoed bits ARE the live ones
    // keeps them. A row is restated at its level only when the body carries
    // no bits for it (an older panel, the API) or a level that differs from
    // what the read showed.
    const keptNamed = requestedNamed.map((e): NamedEntry => {
      const { perms: sent, ...entry } = e
      const live = liveNamed.find(n => n.kind === e.kind && n.name === e.name)
      if (live && ((sent !== undefined && sent === live.perms && permsToLevel(live.perms) === e.level) || live.perms === levelToAclPerms(e.level, false)))
        return { ...entry, perms: live.perms }
      return entry
    })
    const named = keptNamed.length > 0 ? keptNamed : preservedNamed
    // A base principal whose level the request leaves as it reads keeps its
    // live perms in the ACL spec.
    const basePerms: BasePerms = {}
    if (livePerms) {
      for (const kind of BASE_KINDS) {
        if (base[kind] === current[kind])
          basePerms[kind] = livePerms[kind]
      }
    }
    // cr3.shares M3 (review): the write is decided from the DIFFERENCE between
    // what the editor read and what it sent — the panel always sends every
    // row, so the mere presence of a row says nothing. A level left as read
    // is no change; a named row absent from a request that names any is a
    // removal (a request with none keeps them, #37).
    const namedKey = (n: { kind: string, name: string }): string => `${n.kind}:${n.name}`
    const liveByKey = new Map(liveNamed.map(n => [namedKey(n), n]))
    const sentKeys = new Set(keptNamed.map(namedKey))
    const delta: NamedDelta = {
      added: keptNamed.filter(n => !liveByKey.has(namedKey(n))),
      changed: keptNamed.filter(n => liveByKey.has(namedKey(n)) && liveByKey.get(namedKey(n))!.perms !== (n.perms ?? levelToAclPerms(n.level, false))),
      // An explicit clear removes every named principal; a request that names
      // some removes the ones it no longer names; one that names none keeps them.
      removed: clearNamed ? liveNamed : keptNamed.length > 0 ? liveNamed.filter(n => !sentKeys.has(namedKey(n))) : [],
    }
    const baseDelta = BASE_KINDS.filter(kind => base[kind] !== current[kind])
    const hasNamed = named.length > 0
    // Only a ZFS target has a switch to flip (never `zfs set` on anything else).
    const aclAutoEnabled = hasNamed && supported && !enabled

    // Strip the named ACL entries only when the caller explicitly said so.
    // (An ACL that could not be read never reaches here — the plan refuses
    // above, D1 — so the acltype check is all this needs.)
    const clearAcls = clearNamed && supported && enabled

    return {
      ok: true,
      value: {
        target: t,
        dir,
        req,
        recursive,
        ownerChanged,
        groupChanged,
        baseChanged,
        clearNamed,
        supported,
        enabled,
        base,
        named,
        preservedNamedCount: preservedNamed.length,
        basePerms,
        baseDelta,
        delta,
        liveMode: perm.mode,
        liveDefault: liveAcl?.default ?? null,
        liveMask: liveAcl?.mask ?? null,
        hasNamed,
        aclAutoEnabled,
        clearAcls,
        walk,
        dirId,
        revision,
        readRevision,
      },
    }
  }

  /** The `fs.setAccess` job's audit params (the ZFS shape is the pre-lift one). */
  function jobParams(plan: SetAccessPlan): Record<string, unknown> {
    return {
      ...identityFields(plan.target),
      ownerChanged: plan.ownerChanged,
      groupChanged: plan.groupChanged,
      baseChanged: plan.baseChanged,
      namedCount: plan.named.length,
      preservedNamedCount: plan.preservedNamedCount,
      clearNamed: plan.clearNamed,
      applyToExisting: plan.recursive,
      aclAutoEnabled: plan.aclAutoEnabled,
    }
  }

  /**
   * Execute a plan — the body of every `fs.setAccess` job (and of the share
   * grant). `ctx` is the job's cancel seam: a recursive walk registers its
   * cancel there (cr3.shares, fourth review).
   */
  async function runSetAccess(plan: SetAccessPlan, updateProgress: (msg: string) => void, ctx?: JobContext): Promise<Record<string, unknown>> {
    // cr3.shares H2: every single-directory write (chown, setfacl, chmod)
    // acts on ONE descriptor of the directory, opened no-follow and proven to
    // be the planned real path, handed to each tool as /proc/self/fd/3 — a
    // name swapped for a symlink after the check can no longer redirect a
    // root write (chmod has no no-follow form of its own).
    // Pinned BEFORE the first write, so a swapped path refuses with nothing
    // done (the zfs acltype switch included): the one directory, or EVERY
    // root a recursive walk starts from (second review: an unpinned walk lost
    // 481 of 537 races). Every write of ownership, mode or ACL reaches the
    // filesystem only through one of these descriptors.
    const pins: PinnedDir[] = []
    try {
      if (plan.recursive) {
        for (const [i, root] of (plan.walk?.roots ?? []).entries())
          pins.push(await pinDir(root.path, plan.walk?.rootIds[i]))
      }
      else {
        pins.push(await pinDir(plan.dir, plan.dirId))
      }
      const pinnedExec = async (cmd: string, args: string[]): Promise<ExecResult> =>
        executor.exec(cmd, [...args.slice(0, -1), PINNED_DIR], { inheritedFds: [pins[0].fd] })
      return await runSetAccessWrites(plan, updateProgress, pinnedExec, pins, ctx)
    }
    finally {
      for (const pin of pins)
        await pin.close()
    }
  }

  async function runSetAccessWrites(
    plan: SetAccessPlan,
    updateProgress: (msg: string) => void,
    pinnedExec: (cmd: string, args: string[]) => Promise<ExecResult>,
    pins: PinnedDir[],
    ctx?: JobContext,
  ): Promise<Record<string, unknown>> {
    const { req, dir: mountpoint, recursive, hasNamed, supported, base, named, clearAcls, baseChanged, aclAutoEnabled, basePerms } = plan
    const ident = identityFields(plan.target)

    // Named grants need the acl package. Gate BEFORE any mutation so a
    // missing tool never leaves a half-applied state. (Only a REQUESTED
    // grant can hit this — preserved entries imply a readable live ACL.)
    if (hasNamed && !supported)
      throw new Error('The acl package (setfacl) is not installed; named user/group grants require it. Install it (apt install acl), or grant owner/group/everyone only.')

    // cr3.shares M3: the one directory is written from the DIFFERENCE the
    // plan measured (runSingleDir); below is the recursive walk — the
    // explicit tree rewrite "apply to existing files" asked for.
    if (!recursive)
      return runSingleDir(plan, updateProgress, pinnedExec)

    // Story nf.1 (wave-3 D2): a recursive plan carries the walk it confirmed:
    // its roots (the target, each named child dataset, each nested btrfs
    // subvolume — every one pinned above) and the mounts it leaves alone. A
    // dead remote mount among those refuses here, before anything is touched.
    const walk = plan.walk
    if (!walk)
      throw new Error(`No permissions were changed: the plan for '${mountpoint}' carries no walk scope — refusing a recursive change that could cross other filesystems`)
    await refuseDeadRemotes(walk, mountpoint)
    // Fifth review D1: a helper that is not there (or cannot be read) is said
    // as such, before anything — the ACL switches included — has changed.
    const unreadable = await accessDirIo.readable(aclWalkScript).then(() => null, (err: NodeJS.ErrnoException) => err.code ?? 'error')
    if (unreadable !== null)
      throw new Error(`The permission walk could not be started: '${aclWalkScript}' cannot be read (${unreadable}) — no permission was changed`)
    const notChanged = walk.excluded.length > 0 ? { notChanged: notChangedList(walk.excluded) } : {}

    // 0) A recursive named grant on ZFS crosses every child dataset mounted
    // under the directory; one with ACLs off would refuse the walk's
    // `setfacl` there. Switch them on first, then the target's own, before
    // any permission changes (ruling 2026-10-11).
    const aclDataset = aclDatasetOf(plan.target)
    const childAclEnabled = hasNamed && aclDataset !== null
      ? await enableChildAcls(walk.children, updateProgress)
      : null
    // The datasets switched so far, in order: a walk that then cannot start
    // says they were (sixth review (d)).
    const switched = [...(childAclEnabled ?? [])]
    if (hasNamed && !plan.enabled && aclDataset !== null) {
      // Enable POSIX ACLs on the dataset if not already (side effect). ZFS
      // only: a filesystem with native ACLs is always `enabled`.
      updateProgress(`zfs set acltype=posixacl xattr=sa ${aclDataset}`)
      const r = await executor.exec(ZFS, ['set', '--', 'acltype=posixacl', 'xattr=sa', aclDataset])
      if (r.exitCode !== 0)
        throw new Error(r.stderr.trim() || `zfs set acltype=posixacl exited with code ${r.exitCode}`)
      switched.push(aclDataset)
    }

    // THE WALK (cr3.shares, fourth review): one run of anas-acl-walk over
    // every pinned root. It never resolves a name twice and never follows a
    // link: each entry is opened O_PATH|O_NOFOLLOW where it was listed,
    // proven by fstat, and every tool names its descriptor (see the helper's
    // header). Each entry gets these steps, in this order, through the same
    // tools and specs as before:
    //
    //   step          entries                 tool
    //   chown         files + directories     chown <owner[:group]>
    //   acl           files + directories     setfacl -b -m <spec, capital X>
    //   defaultAcl    directories             setfacl -d --set <spec>
    //   setgid        directories             chmod g+s
    //   clear         files + directories     setfacl -b -k
    //   mode          files + directories     chmod <u=..,g=..,o=.. with X>
    //
    // Only regular files and directories are touched (third review N2); no
    // step removes setgid (N3). An entry on another device is never entered
    // or touched — the boundary is the device, never a name (third review
    // D2, fourth review D-A).
    const ownerSpec = plan.ownerChanged || plan.groupChanged
      ? (plan.ownerChanged && plan.groupChanged ? `${req.owner}:${req.group}` : plan.ownerChanged ? `${req.owner}` : `:${req.group}`)
      : null
    const steps = hasNamed
      // `-b -m` resolves the spec's `X` against each file's own permissions,
      // so a file that already carries execute keeps it and a plain file
      // gets none; the DEFAULT ACL takes the lowercase spec (buildAclSpec).
      ? { acl: buildAclSpec(base, named, recursive, basePerms), defaultAcl: buildAclSpec(base, named, false), setgid: true }
      // No named entries → an EXPLICIT ACL clear (`clearNamed: true`, never
      // inferred) and the mode bits, symbolic with capital `X` so execute
      // lands only on directories (and already-executable files).
      : { ...(clearAcls ? { clear: true } : {}), ...(baseChanged ? { mode: levelsToSymbolic(base) } : {}) }
    const ran = ownerSpec !== null || Object.keys(steps).length > 0
      ? await runAclWalk(walk, pins, { ...(ownerSpec !== null ? { chown: ownerSpec } : {}), ...steps }, updateProgress, switched, ctx)
      : null
    const walked = ran ? { walk: ran.report, ...ran.verdict } : {}

    if (hasNamed) {
      const result: Record<string, unknown> = { ...ident, aclEnabled: true, aclAutoEnabled, namedCount: named.length, ...notChanged, ...walked }
      // The child datasets whose ACLs were switched on (present whenever the
      // walk was checked for them — an empty list says none needed it).
      if (childAclEnabled)
        result.childAclEnabled = childAclEnabled
      return result
    }
    return { ...ident, aclEnabled: plan.enabled, aclAutoEnabled: false, namedCount: 0, clearedNamed: clearAcls, ...notChanged, ...walked }
  }

  /**
   * Run anas-acl-walk over the pinned roots (cr3.shares, fourth review). The
   * job goes in on stdin, the roots as inherited descriptors 3, 4, ... in
   * plan order; the helper answers one JSON line of counts. A refusal
   * (exit 2) changed nothing; a walk that stopped part-way (exit 3, a
   * signal, an unreadable answer) is a failure that says how far it got; a
   * completed walk that skipped a swapped entry, met an error, did not enter
   * a directory for depth, found an entry gone before it could open it
   * (sixth review) or met a filesystem the plan did not name is
   * INCOMPLETE — the job completes and says so, with the counts. A cancel
   * stops the helper's whole process group. `switched` names the datasets
   * whose POSIX ACLs were switched on before the walk: a walk that cannot
   * start says so instead of "no permission was changed".
   */
  async function runAclWalk(
    walk: PlanWalk,
    pins: PinnedDir[],
    ops: { chown?: string, acl?: string, defaultAcl?: string, setgid?: boolean, clear?: boolean, mode?: string },
    updateProgress: (msg: string) => void,
    switched: string[],
    ctx?: JobContext,
  ): Promise<{ report: AccessWalkReport, verdict: { incomplete?: true, message?: string } }> {
    const unchanged = switched.length === 0
      ? 'no permission was changed'
      : `the walk changed no file or folder; POSIX ACLs were already switched on for ${switched.join(', ')}`
    const job = {
      roots: walk.roots.map((root, i) => ({ fd: 3 + i, path: root.path, dev: walk.rootIds[i].dev, ino: walk.rootIds[i].ino, zfs: root.zfsRoot === true })),
      tools: { chown: CHOWN, chmod: CHMOD, setfacl: SETFACL },
      ...ops,
    }
    updateProgress(`anas-acl-walk over ${walk.roots.map(r => r.path).join(', ')}: ${Object.keys(ops).join(', ')}`)
    const cancel = new ChildCancel(ctx, 'the permission walk', {
      subject: `The permission walk over '${walk.roots[0]?.path ?? ''}'`,
      consequence: 'The files and folders the walk already reached keep their new permissions; the rest keep their old ones.',
    }, { ladder: 'read' })
    let r: ExecResult
    try {
      r = await executor.exec(PERL, [aclWalkScript], { ...TREE_WALK, stdin: JSON.stringify(job), inheritedFds: pins.map(p => p.fd), onSpawn: cancel.onSpawn })
    }
    catch (err) {
      // Nothing ran: the interpreter could not be started (ENOENT, EACCES).
      const code = (err as NodeJS.ErrnoException).code
      if (code !== undefined)
        throw new Error(`The permission walk could not be started: '${PERL}' could not be run (${code}) — ${unchanged}`)
      throw err
    }
    // Fifth review D1: a cancel is a cancel only when one was ASKED for and
    // the hook stopped the child — never any non-zero exit (the executor
    // announces every child it spawns, so `stoppedOnPurpose()` alone is true
    // for a refusal, a crash or an OOM kill too).
    if (r.exitCode !== 0 && cancel.requested() && cancel.stoppedOnPurpose()) {
      const by = cancel.cancellation()
      throw new JobCancelledError(`the permission walk was stopped${by ? ` by ${by.user} at ${by.at}` : ''}: the files and folders it already reached keep their new permissions`)
    }
    const line = r.stdout.trim().split('\n').at(-1) ?? ''
    let parsed: unknown = null
    try {
      parsed = JSON.parse(line)
    }
    catch {}
    const report = AccessWalkReportSchema.safeParse(parsed)
    if (!report.success) {
      const said = r.stderr.trim().split('\n')[0] ?? ''
      // perl's own refusal to load the script: it ran nothing of it.
      if (r.exitCode !== 0 && PERL_CANNOT_OPEN_RE.test(said))
        throw new Error(`The permission walk could not be started: '${aclWalkScript}' could not be opened (${said}) — ${unchanged}`)
      if (r.signal)
        throw new Error(`The permission walk was killed (${r.signal}) before it finished — some files may already have been changed; apply again to finish`)
      throw new Error(`The permission walk ended without a readable report (exit ${r.exitCode}) — some files may already have been changed. ${said}`.trim())
    }
    const rep = report.data
    if (rep.refused !== undefined) {
      throw new Error(switched.length === 0
        ? `No permissions were changed: ${rep.refused}`
        : `The walk changed no file or folder (POSIX ACLs were already switched on for ${switched.join(', ')}): ${rep.refused}`)
    }
    if (r.exitCode !== 0 || rep.aborted !== undefined || rep.done !== true)
      throw new Error(`The permission walk stopped part-way: ${rep.aborted ?? `exit ${r.exitCode}`} — ${walkSummary(rep)}`)
    return { report: rep, verdict: walkVerdict(rep, walk) }
  }

  /** The counts a person reads: what was reached. */
  function walkSummary(rep: AccessWalkReport): string {
    return `${rep.visited.files} file(s) and ${rep.visited.dirs} folder(s) reached`
  }

  /**
   * INCOMPLETE (cr3.shares, fourth and fifth reviews): anything the walk had
   * to leave out that the confirmation did not name. Boundaries are matched
   * by IDENTITY (fifth review D6): a boundary whose mount id is one the plan
   * excluded is expected; any other boundary — a filesystem nobody named, a
   * nested subvolume nobody listed, one the report could not carry — is
   * reported, and so is an excluded mount the walk never met (unmounted,
   * replaced, or hidden). Every sentence is derived from counts that add up
   * (fifth review D3); when the helper could not check that they do, the
   * message says so instead of "everything else was changed".
   */
  function walkVerdict(rep: AccessWalkReport, walk: PlanWalk): { incomplete?: true, message?: string } {
    const why: string[] = []
    const list = (names: string[]): string => names.length > 0 ? ` (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', and more' : ''})` : ''
    const named = (...kinds: string[]): string => list(rep.notes.filter(n => kinds.includes(n.kind)).map(n => n.name))
    const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
    if (rep.swapped > 0)
      why.push(`${plural(rep.swapped, 'entry', 'entries')} changed while the walk read ${rep.swapped === 1 ? 'it and was' : 'them and were'} not touched${named('swapped')}`)
    const failedSteps = Object.entries(rep.failed).filter(([, n]) => n > 0)
    const failedTotal = failedSteps.reduce((t, [, n]) => t + n, 0)
    if (failedTotal > 0)
      why.push(`${failedTotal} change(s) failed (${failedSteps.map(([step, n]) => `${step}: ${n} of ${(rep.changed[step] ?? 0) + n}`).join(', ')})${list(rep.notes.filter(n => n.kind === 'error' && n.op !== undefined && n.op in rep.failed).map(n => n.name))}`)
    const unreadable = rep.errors - failedTotal - rep.notEntered
    if (unreadable > 0)
      why.push(`${plural(unreadable, 'entry', 'entries')} could not be read and ${unreadable === 1 ? 'was' : 'were'} not touched${list(rep.notes.filter(n => n.kind === 'error' && !(n.op !== undefined && n.op in rep.failed)).map(n => n.name))}`)
    if (rep.tooDeep > 0)
      why.push(`${plural(rep.tooDeep, 'folder', 'folders')} nested deeper than ${rep.maxDepth} levels ${rep.tooDeep === 1 ? 'was' : 'were'} not entered${named('tooDeep')}`)
    if (rep.notEntered > 0)
      why.push(`${plural(rep.notEntered, 'folder', 'folders')} could not be entered${named('notEntered')}`)
    if (rep.changing > 0)
      why.push(`${plural(rep.changing, 'folder', 'folders')} changed while ${rep.changing === 1 ? 'it was' : 'they were'} walked, so entries added or renamed there may have been missed${named('changing')}`)
    if (rep.overrun > 0)
      why.push(`${plural(rep.overrun, 'folder', 'folders')} kept changing and ${rep.overrun === 1 ? 'was' : 'were'} not finished${named('overrun')}`)
    // Sixth review: a name gone before the walk could open it is a delete or
    // a move, and a move into a folder the walk had finished is never met.
    if (rep.vanished > 0) {
      why.push(rep.vanished === 1
        ? `1 entry disappeared while the walk read it${named('vanished')}; if it was moved rather than deleted it may not have been changed`
        : `${rep.vanished} entries disappeared while the walk read them${named('vanished')}; any that were moved rather than deleted may not have been changed`)
    }
    // Boundaries, by identity: the mount id and the place.
    const met = new Set<number>()
    const unnamed: string[] = []
    for (const b of rep.boundaries) {
      const i = walk.excludedIds.findIndex(id => id !== null && id !== undefined
        && id.mnt === b.mnt && id.parent === b.parent && id.leaf === b.leaf)
      if (i >= 0)
        met.add(i)
      else
        unnamed.push(b.name)
    }
    const unnamedCount = unnamed.length + rep.boundariesDropped
    if (unnamedCount > 0)
      why.push(`${plural(unnamedCount, 'folder', 'folders')} on another filesystem that the confirmation did not name ${unnamedCount === 1 ? 'was' : 'were'} not entered${list(unnamed)}`)
    const notMet = walk.excluded.filter((_e, i) => !met.has(i)).map(e => e.target)
    if (notMet.length > 0)
      why.push(`${plural(notMet.length, 'filesystem', 'filesystems')} the confirmation named as left alone ${notMet.length === 1 ? 'was' : 'were'} not where the walk looked (unmounted or replaced since), so what is there now was walked as part of the tree or left out${list(notMet)}`)
    if (!rep.accounted)
      why.push(`its counts do not add up${rep.accountingError ? ` (${rep.accountingError})` : ''}, so some entries may not have been changed`)
    if (why.length === 0)
      return {}
    // What WAS done, per step, from counts the helper checked add up.
    const done = Object.keys(rep.changed).filter(step => (rep.changed[step] ?? 0) + (rep.failed[step] ?? 0) > 0).map(step => `${step} ${rep.changed[step] ?? 0} of ${(rep.changed[step] ?? 0) + (rep.failed[step] ?? 0)}`)
    const rest = rep.accounted
      ? `Changed: ${done.length > 0 ? done.join(', ') : 'nothing'} (${walkSummary(rep)})`
      : `It reached ${rep.visited.files} file(s) and ${rep.visited.dirs} folder(s)`
    return { incomplete: true, message: `INCOMPLETE: the walk finished, but ${why.join('; ')}. ${rest}; apply again to retry the rest.` }
  }

  /**
   * cr3.shares M3 (review): one directory, written from the DIFFERENCE
   * between what the editor read and what it sent (the plan's `baseDelta`
   * and `delta`), never from which rows the request happens to carry:
   *
   *  - a principal whose level is unchanged keeps its live bits (the ACL
   *    spec restates them verbatim, at what the mask let them do);
   *  - the access ACL is rewritten only when a base level or a named
   *    principal moved; the mode bits only when a base level moved, a digit
   *    left as read keeping its live value (`0751` keeps others' traverse);
   *  - the DEFAULT ACL (see writeDefault) follows only what moved; the
   *    implied moves, the complete list: (i) a grant on a directory with NO
   *    default ACL establishes one (base entries + that principal) and sets
   *    setgid; (ii) the "other" digit of the mode when Everyone changes;
   *    (iii) the group digit falling back from the mask to `g::` when the
   *    last named principal is cleared; (iv) the base entries of an existing
   *    default ACL follow a base change. A clear never removes setgid (N3);
   *  - an Apply that changes nothing runs NO command and says so
   *    (`nothingChanged: true`).
   *
   * Every write names the pinned descriptor (H2).
   */
  async function runSingleDir(
    plan: SetAccessPlan,
    updateProgress: (msg: string) => void,
    pinnedExec: (cmd: string, args: string[]) => Promise<ExecResult>,
  ): Promise<Record<string, unknown>> {
    const { req, dir, base, named, hasNamed, enabled, clearAcls, basePerms, baseDelta, delta, liveMode, liveDefault, aclAutoEnabled } = plan
    const ident = identityFields(plan.target)
    let writes = 0
    const run = async (cmd: string, args: string[], label: string): Promise<void> => {
      updateProgress(`${label} ${args.join(' ')}`)
      const r = await pinnedExec(cmd, args)
      if (r.exitCode !== 0)
        throw new Error(r.stderr.trim() || `${label} ${args[0]} exited with code ${r.exitCode}`)
      writes++
    }
    const said = (result: Record<string, unknown>): Record<string, unknown> =>
      // N6 (third review): the path the operator named, not the resolved one.
      writes === 0 ? { ...result, nothingChanged: true, message: `Nothing to change: '${plan.target.kind === 'share' ? plan.target.configuredPath ?? dir : dir}' already has these permissions` } : result

    // 1) Ownership. cr.53 (L16): `--` ends option parsing.
    if (plan.ownerChanged || plan.groupChanged) {
      const spec = plan.ownerChanged && plan.groupChanged
        ? `${req.owner}:${req.group}`
        : plan.ownerChanged ? `${req.owner}` : `:${req.group}`
      await run(CHOWN, [spec, '--', dir], 'chown')
    }

    const tag = (n: NamedEntry): string => `${n.kind === 'user' ? 'u' : 'g'}:${n.name}`
    const namedMoved = delta.added.length + delta.changed.length + delta.removed.length > 0
    const inDefault = new Set((liveDefault?.named ?? []).map(n => `${n.type === 'user' ? 'u' : 'g'}:${n.name}`))
    const BASE_TAG: Record<BaseKind, string> = { 'owner': 'u:', 'owning-group': 'g:', 'everyone': 'o:' }

    /**
     * The DEFAULT ACL (second review): only what moved, and only where the
     * directory has a default ACL — except a grant on a directory without
     * one, which establishes it (its base entries + that principal) and
     * sets setgid. A base level that moved restates the SAME base entry of an
     * existing default, so files created afterwards get what the editor
     * shows. A changed principal touches its default entry only when it has
     * one; a removed one is dropped (`-n`: the default mask as found). Each
     * `-m` recalculates the default mask, so every OTHER default entry the
     * old mask clamped is restated at what it could do — it gains nothing.
     */
    const writeDefault = async (): Promise<void> => {
      const mods: string[] = []
      if (liveDefault) {
        for (const kind of baseDelta)
          mods.push(`${BASE_TAG[kind]}:${levelToAclPerms(base[kind], false)}`)
        for (const n of [...delta.added, ...delta.changed.filter(c => inDefault.has(tag(c)))])
          mods.push(`${tag(n)}:${n.perms ?? levelToAclPerms(n.level, false)}`)
      }
      else {
        for (const n of delta.added)
          mods.push(`${tag(n)}:${n.perms ?? levelToAclPerms(n.level, false)}`)
      }
      if (mods.length > 0) {
        const touched = new Set(mods.map(m => m.slice(0, m.lastIndexOf(':'))))
        const clampFix: string[] = []
        if (liveDefault?.mask !== undefined) {
          for (const n of liveDefault.named) {
            const t = `${n.type === 'user' ? 'u' : 'g'}:${n.name}`
            const eff = effectivePerms(n.perms, liveDefault.mask)
            if (eff !== n.perms && !touched.has(t))
              clampFix.push(`${t}:${eff}`)
          }
          const g = effectivePerms(liveDefault.owningGroup, liveDefault.mask)
          if (g !== liveDefault.owningGroup && !touched.has('g:'))
            clampFix.push(`g::${g}`)
        }
        // A default ACL established here carries the managed `m::rwx`, as a
        // first grant always wrote it (SMB inheritance, RF1).
        await run(SETFACL, ['-d', '-m', [...mods, ...clampFix, ...(liveDefault ? [] : ['m::rwx'])].join(','), '--', dir], 'setfacl')
      }
      const drops = delta.removed.map(tag).filter(t => inDefault.has(t))
      if (drops.length > 0)
        await run(SETFACL, ['-n', '-d', '-x', drops.join(','), '--', dir], 'setfacl')
      // setgid: only when THIS edit established the default ACL.
      if (!liveDefault && delta.added.length > 0 && !hasSetgid(liveMode))
        await run(CHMOD, ['g+s', '--', dir], 'chmod')
    }

    if (hasNamed) {
      if (baseDelta.length > 0 || namedMoved) {
        // 2) POSIX ACLs on (ZFS only), then the access ACL, declaratively:
        // the spec restates everyone the request left alone at their live bits.
        const aclDataset = aclDatasetOf(plan.target)
        if (!enabled && aclDataset !== null) {
          updateProgress(`zfs set acltype=posixacl xattr=sa ${aclDataset}`)
          const r = await executor.exec(ZFS, ['set', '--', 'acltype=posixacl', 'xattr=sa', aclDataset])
          if (r.exitCode !== 0)
            throw new Error(r.stderr.trim() || `zfs set acltype=posixacl exited with code ${r.exitCode}`)
          writes++
        }
        await run(SETFACL, ['--set', buildAclSpec(base, named, false, basePerms, plan.liveMask), '--', dir], 'setfacl')
        // 3) The default ACL and setgid (see writeDefault).
        await writeDefault()
      }
      return said({ ...ident, aclEnabled: true, aclAutoEnabled: aclAutoEnabled && writes > 0, namedCount: named.length })
    }

    // No named entries left: an EXPLICIT clear (clearNamed) replaces the
    // access ACL with its base three alone (no named entry, no mask — each
    // base principal at what it could do, or at its new level), and drops
    // ONLY the removed principals from the default ACL: anything else the
    // default holds stays as found. The setgid bit is left as found.
    if (clearAcls) {
      // N3 (third review): a clear never removes setgid — ANAS cannot tell
      // the bit it set from one an administrator set, and a leftover setgid
      // on a directory is harmless.
      await run(SETFACL, ['--set', buildBaseSpec(base, basePerms), '--', dir], 'setfacl')
      await writeDefault()
      return said({ ...ident, aclEnabled: enabled, aclAutoEnabled: false, namedCount: 0, clearedNamed: true })
    }
    if (baseDelta.length > 0) {
      await run(CHMOD, [levelsToModeKeeping(base, baseDelta, liveMode), '--', dir], 'chmod')
      await writeDefault()
    }
    return said({ ...ident, aclEnabled: enabled, aclAutoEnabled: false, namedCount: 0, clearedNamed: clearAcls })
  }

  // --- The guard (story cr.37) ---------------------------------------------------

  /** The resolution refused (404 unknown / volume / unmounted, 400 a bad path). */
  const resolvedGate: Gate<AccessObject> = async o => o.resolveFailure ? failureRefusal(o.resolveFailure) : null

  /** The plan could not read the directory (404). */
  const plannedGate: Gate<AccessObject> = async o => o.planFailure ? failureRefusal(o.planFailure) : null

  /**
   * cr3.shares (second review, coordinator ruling): an Apply made from a
   * stale read. The editor's GET reports the revision of what it saw; a PUT
   * that sends it back is refused when the directory no longer reads the
   * same — another edit in between (a `u:nobody` added) would otherwise be
   * undone by a body that never showed it. A PUT without one behaves as before.
   */
  function staleReadGate(req: SetAccessRequest): Gate<AccessObject> {
    return async o => req.expectedRevision !== undefined && o.plan && o.plan.readRevision !== req.expectedRevision
      ? { status: 409, code: 'STATE_CHANGED', message: 'The permissions changed since the editor read them — nothing was changed; reload and apply again' }
      : null
  }

  /** An AHR or share target's PVE gates ({@link guardPathTarget}); a ZFS target brings its own. */
  function pathGate(req: SetAccessRequest): Gate<AccessObject> {
    return async (o) => {
      if (!o.target || o.target.kind === 'zfs')
        return null
      const refused = await guardPathTarget(o.target, req)
      return refused ? failureRefusal(refused) : null
    }
  }

  /**
   * `access:<normalised dir>` — exclusive; the permission writer's OWN path
   * key (cr.53 L20, following the guard's path-key family — `mount:<path>`,
   * `share:nfs:<path>` in safety/guard.ts). Every claim set below carries it,
   * so two applies on one directory serialise whatever the directory sits
   * on: the pool keys alone left two recursive applies on one AHR directory
   * (`ahr:<uuid>` is SHARED for access) or on one plain path (no key at all)
   * walking the same files at once — each restating the ACL from the plan it
   * made before the other's changes, the second silently undoing the first.
   */
  function accessPathClaim(dir: string): LockClaim {
    const key = normalizePath(dir)
    return { key: `access:${key}`, mode: 'exclusive', what: `the permissions of ${key}` }
  }

  /**
   * The lock claims (cr.33 §4.2) a set-access job takes: the exclusive
   * `access:<dir>` path key (cr.53 L20) on every home, plus exclusive on a
   * ZFS dataset (`zfs:<pool guid>/<path>`, its ancestors shared), shared on
   * an AHR pool (`ahr:<vg uuid>`), each with the pool's name key shared. A
   * pool whose key cannot be read is locked by its name key, exclusive
   * (§4.2's fallback, which that shared name key meets — cr.33b). A share
   * path on neither now has the path key.
   */
  async function accessClaims(t: AccessTarget | null, reads: GuardReads): Promise<LockClaim[]> {
    const pathClaim = t ? [accessPathClaim(targetDir(t))] : []
    const dataset = t ? aclDatasetOf(t) : null
    if (dataset !== null) {
      const pool = dataset.split('/')[0]
      const guid = (await reads.once(`pool-guid:${pool}`, () => readPoolGuid(executor, pool)))?.guid
      return [...pathClaim, ...zfsDatasetClaims(guid, dataset, 'exclusive')]
    }
    const ahr = t?.kind === 'ahr'
      ? { pool: t.pool, vgUuid: t.vgUuid }
      : t?.kind === 'share' && t.home?.kind === 'ahr' ? { pool: t.home.pool, vgUuid: t.home.vgUuid } : null
    if (ahr)
      return [...pathClaim, ...ahrPoolClaims(ahr.pool, ahr.vgUuid, 'shared')]
    return pathClaim
  }

  /**
   * The ONE guard spec of `fs.setAccess` (story cr.37, WAVE3-DESIGN §2.1/§2.3/
   * §2.5 "set access" rows, F4), for every door: the datasets editor, the AHR
   * editor and a share's Permissions. The object is the target resolved now
   * and the plan computed against its live state; the revision is the hash of
   * that state ({@link SetAccessPlan.revision}). The route binds it (with the
   * whole request, for a recursive confirm); the job re-resolves, re-plans and
   * refuses STATE_CHANGED when the revision moved — an ACL entry added after
   * the plan is never deleted by a plan that did not know it. Gates, in the
   * order the routes always asked them: the door's own (`before`: the ZFS
   * ownership and recursive refusals, asked before the resolution so an owned
   * volume answers 400 rather than 404), the resolution, the path gates of an
   * AHR or share target, the directory read.
   */
  function setAccessGuardSpec(opts: {
    what: string
    /** How the confirm and the job params address the target: `{ dataset }`, `{ pool }`, `{ path }`. */
    address: Record<string, string>
    req: SetAccessRequest
    resolve: () => Promise<AccessOutcome<AccessTarget>>
    before?: Gate<AccessObject>[]
  }): GuardSpec<AccessObject> {
    const { what, address, req } = opts
    return {
      operation: 'fs.setAccess',
      object: {
        what,
        read: async () => {
          const target = await opts.resolve()
          if (!target.ok)
            return { target: null, resolveFailure: target.failure, plan: null, planFailure: null }
          const planned = await planSetAccess(target.value, req)
          return planned.ok
            ? { target: target.value, resolveFailure: null, plan: planned.value, planFailure: null }
            : { target: target.value, resolveFailure: null, plan: null, planFailure: planned.failure }
        },
        id: async () => ({ ...address }),
        revision: async o => o.plan?.revision ?? null,
        unbound: () => `Could not read the permissions of ${what} — refusing a change that cannot be bound to them`,
      },
      gates: [...(opts.before ?? []), resolvedGate, pathGate(req), plannedGate, staleReadGate(req)],
      locks: (o, _bound, reads) => accessClaims(o.target, reads),
    }
  }

  // --- The share grant (access.1) ------------------------------------------------

  /**
   * A user's uid or a group's gid through nsswitch (`getent passwd|group
   * <name or id>`), or null when it does not resolve or cannot be read.
   */
  async function principalId(kind: 'user' | 'group', name: string): Promise<number | null> {
    const r = await executor.exec(GETENT, [kind === 'user' ? 'passwd' : 'group', name]).catch(() => null)
    if (!r || r.exitCode !== 0)
      return null
    const numeric = NUMERIC_ID_RE.test(name) ? Number(name) : null
    if (kind === 'user') {
      const hit = parsePasswd(r.stdout).find(u => u.name === name || u.uid === numeric)
      return hit ? hit.uid : null
    }
    const hit = parseGroups(r.stdout).find(g => g.name === name || g.gid === numeric)
    return hit ? hit.gid : null
  }

  /** Does a user/group name resolve through nsswitch (`getent`; exit 0 = yes)? */
  async function principalResolves(kind: 'user' | 'group', name: string): Promise<boolean> {
    const r = await executor.exec(GETENT, [kind === 'user' ? 'passwd' : 'group', name])
    return r.exitCode === 0
  }

  /**
   * The editor with its form pre-filled (access.1): read the target exactly as
   * the dialog does, then add the share's principals. Every selected user or
   * group gets a named entry at `level`, guest access gives Everyone `level`,
   * owner and owning group are untouched, every existing named entry is kept,
   * and nobody is ever LOWERED (a principal already above `level` keeps what it
   * has — a grant adds access, it never revokes). Returns the request the
   * editor would send and, per principal, the level it ends with (the kept one
   * where that is higher than `level`), or a reason why nothing can be granted.
   */
  async function composeGrant(
    t: AccessTarget,
    principals: { kind: 'user' | 'group', name: string }[],
    guest: boolean,
    level: AccessLevel,
    applyToExisting: boolean,
  ): Promise<{ ok: true, request: SetAccessRequest | null, granted: AccessEntry[], skipped: string[] } | { ok: false, message: string }> {
    const current = await readAccess(t)
    if (!current.ok)
      return { ok: false, message: current.failure.body.error.message }
    const acc = current.value
    // The same rule as the dialog's failed pre-fill (#37): a writer that does
    // not know the current named grants never offers to restate them.
    if (acc.aclDegraded)
      return { ok: false, message: `POSIX ACLs on '${targetDir(t)}' could not be read, so the existing grants are unknown — nothing was granted. Fix the ACL read, then use Permissions` }

    const skipped: string[] = []
    const wanted: NamedEntry[] = []
    for (const p of principals) {
      if (await principalResolves(p.kind, p.name))
        wanted.push({ kind: p.kind, name: p.name, level })
      else
        skipped.push(`${p.kind === 'group' ? '@' : ''}${p.name}`)
    }

    // cr3.shares (fourth review D-D): every row the grant does not RAISE keeps
    // the live bits the read gave it (`perms`), exactly as the editor echoes
    // an untouched row (third review D3) — a custom `u:4242:--x` traverse
    // entry stays `--x`; it is never restated at its level (`---`). A row
    // the grant raises is written at its new level.
    const liveNamed: NamedEntry[] = acc.entries.filter(isNamed).map(e => ({ kind: e.kind, name: e.name, level: e.level, ...(e.perms !== undefined ? { perms: e.perms } : {}) }))
    const merged: NamedEntry[] = liveNamed.map((e) => {
      const w = wanted.find(x => x.kind === e.kind && x.name === e.name)
      if (!w || maxLevel(e.level, w.level) === e.level)
        return e
      const { perms: _kept, ...raised } = e
      return { ...raised, level: w.level }
    })
    for (const w of wanted) {
      if (!merged.some(e => e.kind === w.kind && e.name === w.name))
        merged.push(w)
    }

    // `granted` reports the level each principal ENDS with — the kept level
    // when the never-lower rule kept a higher one (a read-only edit keeps an
    // existing read-write entry), not the level the share asked for.
    const granted: AccessEntry[] = wanted.map((w) => {
      const kept = merged.find(e => e.kind === w.kind && e.name === w.name)
      return { kind: w.kind, name: w.name, level: kept?.level ?? w.level }
    })
    const entries: AccessEntry[] = []
    if (guest) {
      const everyone = maxLevel(acc.entries.find(e => e.kind === 'everyone')?.level ?? 'none', level)
      entries.push({ kind: 'everyone', level: everyone })
      granted.push({ kind: 'everyone', level: everyone })
    }
    if (wanted.length === 0 && !guest)
      return { ok: true, request: null, granted: [], skipped }
    entries.push(...merged.map(e => ({ kind: e.kind, name: e.name, level: e.level, ...(e.perms !== undefined ? { perms: e.perms } : {}) })))
    const request: SetAccessRequest = { entries }
    if (applyToExisting)
      request.applyToExisting = true
    return { ok: true, request, granted, skipped }
  }

  /**
   * The disclosure sentence for a share that asks for guest access but lists
   * valid users: Samba checks the guest account against `valid users` too and
   * admits no guest on such a share (proven on the test node: every anonymous
   * connection refused at tree connect), so the grant did not raise Everyone.
   * Rides on EVERY outcome of that grant — applied, nothing, refused, failed —
   * so the user is told whoever the gate was that spoke.
   */
  const GUEST_NOTE = 'Guest access was not granted on the folder: the share lists valid users, so no guest can connect to it.'
  function guestNoteFor(share: GrantShare): { guestNote?: string } {
    return share.guestOk && share.validUsers.length > 0 ? { guestNote: GUEST_NOTE } : {}
  }

  /**
   * Everything the share-path grant decides before it writes anything: resolve
   * the path, ask the SAME gates the editor's PUT asks, compose the pre-filled
   * request and plan it. Either a finished outcome (refused with the gate's
   * sentence, nothing to do, a failed read) or a plan ready to run. The share
   * routes ask this BEFORE raising the recursive confirm, so the confirm is
   * asked after every refusal (operator ruling 2026-10-11, live proof F3), and
   * the job asks it again on the stanza as written.
   */
  async function prepareShareGrant(
    path: string,
    share: GrantShare,
    applyToExisting: boolean,
  ): Promise<{ done: ShareAccessGrantResult } | { plan: SetAccessPlan, granted: AccessEntry[], skipped: string[] }> {
    const level: AccessLevel = share.readOnly ? 'read' : 'read-write'
    const { principals, skipped: unparsed } = sharePrincipals(share.validUsers)
    // Operator ruling 2026-10-11: Samba admits NO guest on a share whose
    // `valid users` list is non-empty (it checks the guest account against
    // the list too), so there the Everyone grant serves no guest and only
    // opens the folder to every local account. Guest access counts only when
    // the RAW list is empty — a `%` macro or an unresolvable name is still an
    // entry Samba checks — so this is judged before `sharePrincipals` parses.
    const guest = share.guestOk && share.validUsers.length === 0
    const guestNote = guestNoteFor(share)
    const outcome = (status: ShareAccessGrantResult['status'], extra: Partial<ShareAccessGrantResult> = {}): { done: ShareAccessGrantResult } =>
      ({ done: { status, path, granted: [], skipped: unparsed, applyToExisting, ...extra, ...guestNote } })
    try {
      const target = await resolveShareTarget(path)
      const refused = await guardPathTarget(target, { applyToExisting })
      if (refused)
        return outcome('refused', { message: refused.body.error.message })
      const composed = await composeGrant(target, principals, guest, level, applyToExisting)
      if (!composed.ok)
        return outcome('refused', { message: composed.message })
      const skipped = [...unparsed, ...composed.skipped]
      if (!composed.request)
        return outcome('nothing', { skipped })
      const planned = await planSetAccess(target, composed.request)
      if (!planned.ok)
        return outcome('refused', { message: planned.failure.body.error.message, skipped })
      return { plan: planned.value, granted: composed.granted, skipped }
    }
    catch (err) {
      return outcome('failed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Run the share-path grant inside a share job (access.1): prepare it (see
   * {@link prepareShareGrant}) and execute the plan exactly as the editor's job
   * would. The share is created or updated whatever happens here, and the
   * outcome (with the gate's or the command's own sentence) rides on the job
   * result. It throws one thing only: the {@link JobCancelledError} of a
   * cancel asked for while the grant ran (fifth review D1), so the job ends
   * cancelled with the share saved; every other failure is the 'failed'
   * outcome.
   *
   * `recursiveConfirmed` says whether the request took the recursive confirm.
   * The route skips the confirm when the grant would be refused or would do
   * nothing; if the job then finds a recursive apply that WOULD run (the path
   * changed in between), it refuses rather than rewrite a tree nobody confirmed.
   */
  async function grantOnSharePath(
    path: string,
    share: GrantShare,
    applyToExisting: boolean,
    updateProgress: (msg: string) => void,
    opts: { recursiveConfirmed: boolean, ctx?: JobContext },
  ): Promise<ShareAccessGrantResult> {
    const prepared = await prepareShareGrant(path, share, applyToExisting)
    if ('done' in prepared)
      return prepared.done
    const { plan, granted, skipped } = prepared
    const guestNote = guestNoteFor(share)
    const outcome = (status: ShareAccessGrantResult['status'], extra: Partial<ShareAccessGrantResult> = {}): ShareAccessGrantResult =>
      ({ status, path, granted: [], skipped, applyToExisting, ...extra, ...guestNote })
    if (plan.recursive && !opts.recursiveConfirmed)
      return outcome('refused', { message: `Applying to existing files under '${path}' was not confirmed: when the request was checked, the grant would not have run. Nothing was granted; use Permissions on the share to apply it` })
    try {
      updateProgress(`granting access on ${path}`)
      const ran = await runSetAccess(plan, updateProgress, opts.ctx)
      const children = Array.isArray(ran.childAclEnabled) ? { childAclEnabled: ran.childAclEnabled as string[] } : {}
      // cr3.shares (fourth review): a walk that had to leave something out says so.
      const incomplete = ran.incomplete === true ? { incomplete: true, message: String(ran.message) } : {}
      return outcome('applied', { granted, ...children, ...incomplete })
    }
    catch (err) {
      // Fifth review D1: a cancel stays a cancel (the share is saved; the job
      // ends cancelled, not "failed").
      if (err instanceof JobCancelledError)
        throw err
      return outcome('failed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    statMountpoint,
    aclSupported,
    prepareShareGrant,
    grantOnSharePath,
    zfsFullName,
    resolveZfsTarget,
    resolveShareTarget,
    zfsRecursiveRefusal,
    guardPathTarget,
    recursiveConfirm,
    readAccess,
    planSetAccess,
    jobParams,
    runSetAccess,
    composeGrant,
    setAccessGuardSpec,
  }
}
