import type { AccessEntry, AccessLevel, DatasetAccess, ErrorCode, MountpointPermissions, SetAccessRequest, ShareAccessGrantResult } from '@anas/shared'
import type { CommandExecutor, ExecOptions } from '../executor/types.js'
import type { LockClaim } from '../jobs/locks.js'
import type { ParsedAcl } from '../parsers/getfacl.js'
import type { Gate, GuardReads, GuardSpec, Refusal } from '../safety/guard.js'
import type { WalkScope } from './access-walk.js'
import type { IscsiPaths } from './iscsi.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DatasetPath, isPathWithin } from '@anas/shared'
import { isFindmntTable } from '../parsers/findmnt.js'
import { levelToAclPerms, levelToOctalDigit, modeDigitToLevel, parseGetfacl, permsToLevel } from '../parsers/getfacl.js'
import { parsePveMountPaths, PVE_STORAGE_CFG } from '../parsers/pve-storage.js'
import { parseDatasetGet, parseZfsList, zfsListArgs } from '../parsers/zfs-list.js'
import { ahrPoolClaims, zfsDatasetClaims } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { notChangedList, walkArgs, walkScopeFrom } from './access-walk.js'
import { heldByLunOnce } from './iscsi-held.js'
import { probeMount } from './mounts.js'
import { isProbeableKind, kindOfMount, mountIndex } from './nested-filesystems.js'
import { loadPveFootprint, pveDescendantsUnlistedMessage, pveRecursiveRefusalMessage } from './pve-footprint.js'
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
//   - the recursive walk: `setfacl -R`/`chown -R`/`chmod -R` (and
//     `find -type d` for the directories' setgid) walk the directory
//     tree. On ZFS that includes child datasets mounted beneath (the
//     PVE-descendant refusal guards it, and a named grant switches their
//     ACLs on first — {@link enableChildAcls}); on AHR it sweeps every subvolume
//     under `@data` as one tree, and `@snapshots` is a sibling OUTSIDE the
//     mountpoint (AHR-DESIGN §12), so it is never entered;
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
 * so its commands run with no deadline (the job lane's 300 s would stop a
 * legitimate walk half-way). The non-recursive forms keep the lane default.
 *
 * Story nf.1 (wave-3 D2) keeps that and bounds the one way a walk could hang
 * that has nothing to do with the tree's size: since the walk no longer
 * enters other filesystems, the only foreign entry it still reads is the
 * MOUNTPOINT of a mount below the target (find lstats an entry before the
 * prune that skips it, GT amendment 16) — and a dead NFS/CIFS server hangs
 * that lstat for ever. The job probes every such remote mount first and
 * refuses before changing anything ({@link refuseDeadRemotes}).
 */
const TREE_WALK: ExecOptions = {
  timeoutMs: null,
  longRunning: 'recursive chown/setfacl/chmod/find over a whole tree: hours on a large dataset',
}
const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const GETENT = '/usr/bin/getent'

/** The base-three access kinds (mode bits), in owner/group/everyone order. */
type BaseKind = 'owner' | 'owning-group' | 'everyone'

/** Levels for the base three principals, resolved from mode bits or a request. */
interface BaseLevels {
  'owner': AccessEntry['level']
  'owning-group': AccessEntry['level']
  'everyone': AccessEntry['level']
}

/** Whitespace splitter for `stat` output (owner group mode). */
const WHITESPACE_RE = /\s+/

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
export interface ShareAccessTarget { kind: 'share', path: string, home: ShareHome }

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
}

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
  return { path: t.path }
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
  return [
    orphanFlag({ kind: 'owner', level: levels.owner }, ownerOrphan),
    orphanFlag({ kind: 'owning-group', level: levels['owning-group'] }, groupOrphan),
    { kind: 'everyone', level: levels.everyone },
  ]
}

/** Base three levels → 3-digit octal mode string (e.g. `750`). */
function levelsToMode(levels: BaseLevels): string {
  return `${levelToOctalDigit(levels.owner)}${levelToOctalDigit(levels['owning-group'])}${levelToOctalDigit(levels.everyone)}`
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

/** A named (user/group) AccessEntry — kind narrowed, name guaranteed present. */
type NamedEntry = AccessEntry & { kind: 'user' | 'group', name: string }

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
function buildAclSpec(base: BaseLevels, named: NamedEntry[], recursive: boolean): string {
  const p = (level: AccessEntry['level']) => levelToAclPerms(level, recursive)
  const specs = [
    `u::${p(base.owner)}`,
    `g::${p(base['owning-group'])}`,
    `o::${p(base.everyone)}`,
  ]
  for (const n of named)
    specs.push(`${n.kind === 'user' ? 'u' : 'g'}:${n.name}:${p(n.level)}`)
  specs.push(recursive ? 'm::rwX' : 'm::rwx')
  return specs.join(',')
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

export interface AccessServiceOptions {
  executor: CommandExecutor
  /** iSCSI read-layer overrides — the held-by-LUN gate on AHR targets. */
  iscsiPaths?: IscsiPaths
  /** storage.cfg override; defaults to ANAS_STORAGE_CFG, then the real path. */
  pveStorageCfg?: string
}

export type AccessService = ReturnType<typeof createAccessService>

export function createAccessService(opts: AccessServiceOptions) {
  const { executor } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}

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
   * Is `getfacl`/`setfacl` present (the `acl` package)? Feature-detect, then
   * memoize: whether the package is installed does not change at runtime, so we
   * probe `getfacl --version` once per service instead of on every access
   * request. A fresh server (each `createServer()`) builds a fresh service and
   * so a fresh cache. A cached Promise avoids a concurrent double-probe.
   */
  let aclSupportedCache: Promise<boolean> | null = null
  function aclSupported(): Promise<boolean> {
    aclSupportedCache ??= executor.exec(GETFACL, ['--version']).then(r => r.exitCode === 0)
    return aclSupportedCache
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
  async function resolveShareTarget(path: string): Promise<ShareAccessTarget> {
    const home = await resolveSelfServiceTarget(executor, path)
    if (home?.kind === 'zfs')
      return { kind: 'share', path, home: { kind: 'zfs', dataset: home.dataset } }
    if (home?.kind === 'ahr') {
      const r = home.poolRecord
      return { kind: 'share', path, home: { kind: 'ahr', pool: home.pool, record: { name: r.name, mountpoint: r.mountpoint, mounted: r.mounted }, ...(r.vg.uuid ? { vgUuid: r.vg.uuid } : {}) } }
    }
    return { kind: 'share', path, home: null }
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
  async function zfsRecursiveRefusal(poolName: string, fullName: string): Promise<string | null> {
    const datasets = await listDatasetsOrNull(poolName)
    if (!datasets)
      return pveDescendantsUnlistedMessage('permission change', fullName)
    const descendant = (await loadPveFootprint(executor)).ownedDescendant(datasets, fullName)
    return descendant ? pveRecursiveRefusalMessage('Recursive permission change', fullName, descendant) : null
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
  async function pathOwnershipRefusal(dir: string): Promise<string | null> {
    const paths = await pveStoragePaths()
    if (!paths)
      return storageUnreadableMessage(dir)
    for (const [storagePath, storage] of paths) {
      if (isPathWithin(storagePath, dir))
        return `'${dir}' is inside '${storagePath}', the path of PVE storage '${storage}' — its permissions are PVE's to manage`
    }
    return null
  }

  /** A recursive walk over a non-ZFS directory that holds a PVE storage's path below it. */
  async function pathRecursiveRefusal(dir: string): Promise<string | null> {
    const paths = await pveStoragePaths()
    if (!paths)
      return storageUnreadableMessage(dir)
    for (const [storagePath, storage] of paths) {
      if (storagePath !== dir && isPathWithin(dir, storagePath))
        return `Recursive permission change of '${dir}' would include ${storagePath} — the path of PVE storage '${storage}'`
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
    const bad = (message: string): AccessFailure => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } })

    if (t.kind === 'share' && t.home?.kind === 'zfs') {
      // The share backstop's own answer (pvepool.1): a path on an owned
      // dataset, or inside a dir storage's path on ZFS.
      const claim = (await loadPveFootprint(executor)).sharePathClaim(dir)
      if (claim)
        return bad(claim.kind === 'dataset' ? claim.ownership.reason : `'${dir}' is inside '${claim.path}', a path PVE storage '${claim.storage}' claims`)
    }
    else {
      const owned = await pathOwnershipRefusal(dir)
      if (owned)
        return bad(owned)
    }

    if (req.applyToExisting === true) {
      if (t.kind === 'share' && t.home?.kind === 'zfs') {
        const poolName = t.home.dataset.split('/')[0]
        const refusal = await zfsRecursiveRefusal(poolName, t.home.dataset)
        if (refusal)
          return bad(refusal)
      }
      const refusal = await pathRecursiveRefusal(dir)
      if (refusal)
        return bad(refusal)
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
    const scope = walkScopeFrom(dir, mountIndex(r.stdout), children)
    const crossed = new Set(scope.crossed.map(c => c.name))
    return { walk: { ...scope, children: children.filter(c => crossed.has(c.name)) } }
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
      warnings.push(`The walk includes the image of iSCSI LUN ${held.index} '${held.name}' of target ${held.targetIqn} (${held.backingPath}): its owner, mode and ACL change, its contents do not.`)
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

    // A principal whose uid/gid no longer resolves shows as a bare number
    // (getfacl/stat print the numeric id) — an orphan from a delete outside
    // ANAS. Flag it so the UI can render "unknown (uid N)".
    const ownerOrphan = isNumericId(perm.owner)
    const groupOrphan = isNumericId(perm.group)

    if (enabled && supported) {
      // ACLs are live: read the full ACL and map it to entries.
      const r = await executor.exec(GETFACL, ['-pcE', dir])
      if (r.exitCode === 0 && r.stdout.trim()) {
        const acl = parseGetfacl(r.stdout)
        entries = [
          orphanFlag({ kind: 'owner', level: permsToLevel(acl.owner) }, ownerOrphan),
          orphanFlag({ kind: 'owning-group', level: permsToLevel(acl.owningGroup) }, groupOrphan),
          { kind: 'everyone', level: permsToLevel(acl.everyone) },
          // Named entries; mask + default entries are managed, not shown.
          ...acl.named.map((n): AccessEntry =>
            orphanFlag({ kind: n.type, name: n.name, level: permsToLevel(n.perms) }, isNumericId(n.name))),
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

    const recursive = req.applyToExisting === true

    const requestedNamed = (req.entries ?? []).filter(isNamed)
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
      ? { roots: walk.roots, excluded: walk.excluded, children: walk.children.map(c => [c.name, c.mountpoint, c.acltype]) }
      : null
    const revision = createHash('sha256')
      .update(JSON.stringify({ dir, perm: [perm.owner, perm.group, perm.mode], supported, enabled, acl: aclRead, ...(walkFacts ? { walk: walkFacts } : {}) }))
      .digest('hex')

    // Desired base three: a supplied entry overrides the current level, so a
    // partial request never silently drops an unmentioned base principal. The
    // fallback "current" level must be the REAL current level: when ACLs are
    // live, take it from the actual ACL (`group::` etc.) — the mode's group
    // digit is the ACL MASK (rwx), not the owning-group level, so reading it as
    // the group level would silently escalate an omitted owning-group to
    // read-write. With no ACLs, the mode bits ARE the truth.
    const current: BaseLevels = liveAcl
      ? {
          'owner': permsToLevel(liveAcl.owner),
          'owning-group': permsToLevel(liveAcl.owningGroup),
          'everyone': permsToLevel(liveAcl.everyone),
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
    const preservedNamed: NamedEntry[] = (baseChanged && requestedNamed.length === 0 && !clearNamed)
      ? (liveAcl?.named ?? []).map(n => ({ kind: n.type, name: n.name, level: permsToLevel(n.perms) }))
      : []
    const named = requestedNamed.length > 0 ? requestedNamed : preservedNamed
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
        hasNamed,
        aclAutoEnabled,
        clearAcls,
        walk,
        revision,
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

  /** Execute a plan — the body of every `fs.setAccess` job (and of the share grant). */
  async function runSetAccess(plan: SetAccessPlan, updateProgress: (msg: string) => void): Promise<Record<string, unknown>> {
    const { req, dir: mountpoint, recursive, hasNamed, supported, enabled, base, named, clearAcls, baseChanged, aclAutoEnabled } = plan
    const ident = identityFields(plan.target)

    // Named grants need the acl package. Gate BEFORE any mutation so a
    // missing tool never leaves a half-applied state. (Only a REQUESTED
    // grant can hit this — preserved entries imply a readable live ACL.)
    if (hasNamed && !supported)
      throw new Error('The acl package (setfacl) is not installed; named user/group grants require it. Install it (apt install acl), or grant owner/group/everyone only.')

    // Story nf.1 (wave-3 D2): a recursive plan carries the walk it confirmed.
    // Every recursive command below is a `find` over its roots, bounded by
    // `-xdev` and the pruned mounts (see access-walk.ts) — never `-R`, which
    // crosses every mount below the directory. A dead remote mount among the
    // ones left alone refuses here, before anything is touched.
    const walk = recursive ? plan.walk : null
    if (recursive && !walk)
      throw new Error(`No permissions were changed: the plan for '${mountpoint}' carries no walk scope — refusing a recursive change that could cross other filesystems`)
    if (walk)
      await refuseDeadRemotes(walk, mountpoint)
    /** Run one recursive step over every walk root; `label` names it in a failure. */
    const walkStep = async (label: string, select: string[], action: string[]): Promise<void> => {
      for (const root of walk!.roots) {
        const args = walkArgs(root, select, action)
        updateProgress(`find ${args.join(' ')}`)
        const r = await executor.exec(FIND, args, TREE_WALK)
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `${label} over '${root.path}' exited with code ${r.exitCode}`)
      }
    }
    const notChanged = walk && walk.excluded.length > 0 ? { notChanged: notChangedList(walk.excluded) } : {}

    // 0) A recursive named grant on ZFS crosses every child dataset mounted
    // under the directory; one with ACLs off would fail the walk's `setfacl`
    // part-way. Switch them on first, before any permission changes (ruling
    // 2026-10-11).
    const aclDataset = aclDatasetOf(plan.target)
    const childAclEnabled = walk && hasNamed && aclDataset !== null
      ? await enableChildAcls(walk.children, updateProgress)
      : null

    // 1) Ownership.
    if (plan.ownerChanged || plan.groupChanged) {
      const spec = plan.ownerChanged && plan.groupChanged
        ? `${req.owner}:${req.group}`
        : plan.ownerChanged
          ? `${req.owner}`
          : `:${req.group}`
      if (walk) {
        // `-h`: a link's own owner, as `chown -R` (-P) changes it — never
        // the file it points at, which may sit outside the tree.
        await walkStep('chown', [], [CHOWN, '-h', spec])
      }
      else {
        const args = [spec, mountpoint]
        updateProgress(`chown ${args.join(' ')}`)
        const r = await executor.exec(CHOWN, args)
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `chown exited with code ${r.exitCode}`)
      }
    }

    if (hasNamed) {
      // 2) Enable POSIX ACLs on the dataset if not already (side effect). ZFS
      // only: a filesystem with native ACLs is always `enabled`.
      if (!enabled && aclDataset !== null) {
        updateProgress(`zfs set acltype=posixacl xattr=sa ${aclDataset}`)
        const r = await executor.exec(ZFS, ['set', '--', 'acltype=posixacl', 'xattr=sa', aclDataset])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `zfs set acltype=posixacl exited with code ${r.exitCode}`)
      }

      // 3) Set the access ACL DECLARATIVELY so dropped principals disappear.
      // The mountpoint alone: `--set` replaces the whole ACL. The recursive
      // walk: `-b -m` is the same replacement (`-b` drops every extended
      // entry, `-m` writes the spec), but setfacl resolves the spec's `X`
      // against each file's own permissions after `-b` instead of against an
      // empty ACL — so a file that already carries execute keeps it and a
      // plain file gets none. `--set` with an all-`X` spec would strip
      // execute from every file in the tree.
      const spec = buildAclSpec(base, named, recursive)
      if (walk) {
        // Links filtered out: setfacl -R skips the links it meets, but one
        // named as an argument is followed.
        await walkStep('setfacl -b -m', ['!', '-type', 'l'], [SETFACL, '-b', '-m', spec])
      }
      else {
        const setArgs = ['--set', spec, mountpoint]
        updateProgress(`setfacl ${setArgs.join(' ')}`)
        const setR = await executor.exec(SETFACL, setArgs)
        if (setR.exitCode !== 0)
          throw new Error(setR.stderr.trim() || `setfacl --set exited with code ${setR.exitCode}`)
      }

      // 4) Matching DEFAULT ACL so new files inherit the grants. `setfacl -R
      // -d --set` writes the default entries on directories only and passes
      // over regular files with exit 0 (0.4.3 live proof §3: the files carry
      // no `default:` lines and the job completed). The spec is always the
      // lowercase form — see {@link buildAclSpec}.
      const defSpec = buildAclSpec(base, named, false)
      if (walk) {
        // Directories only — what `setfacl -R -d` wrote anyway (above).
        await walkStep('setfacl -d --set', ['-type', 'd'], [SETFACL, '-d', '--set', defSpec])
      }
      else {
        const defArgs = ['-d', '--set', defSpec, mountpoint]
        updateProgress(`setfacl ${defArgs.join(' ')}`)
        const defR = await executor.exec(SETFACL, defArgs)
        if (defR.exitCode !== 0)
          throw new Error(defR.stderr.trim() || `setfacl -d --set exited with code ${defR.exitCode}`)
      }

      // 5) setgid on directories so new files take the directory's group,
      // completing inheritance. Directories ONLY: `chmod -R g+s` marks every
      // regular file setgid as well (0.4.3 live proof §3: a root-owned 0755
      // binary ended `-rwxrwsr-x`, a setgid-root executable). The recursive
      // form is the same bounded walk as every step, `-type d` only.
      if (walk) {
        await walkStep('find -type d -exec chmod g+s', ['-type', 'd'], [CHMOD, 'g+s'])
      }
      else {
        const gidArgs = ['g+s', mountpoint]
        updateProgress(`chmod ${gidArgs.join(' ')}`)
        const gidR = await executor.exec(CHMOD, gidArgs)
        if (gidR.exitCode !== 0)
          throw new Error(gidR.stderr.trim() || `chmod g+s exited with code ${gidR.exitCode}`)
      }

      const result: Record<string, unknown> = { ...ident, aclEnabled: true, aclAutoEnabled, namedCount: named.length, ...notChanged }
      // The child datasets whose ACLs were switched on (present whenever the
      // walk was checked for them — an empty list says none needed it).
      if (childAclEnabled)
        result.childAclEnabled = childAclEnabled
      return result
    }

    // No named entries to apply → mode bits, plus an EXPLICIT ACL clear.
    // Strip the requested-away ACLs first so the mode bits are the whole
    // truth. This runs only for `clearNamed: true` — never inferred.
    if (clearAcls) {
      if (walk) {
        await walkStep('setfacl -b -k', ['!', '-type', 'l'], [SETFACL, '-b', '-k'])
      }
      else {
        const clearArgs = ['-b', '-k', mountpoint]
        updateProgress(`setfacl ${clearArgs.join(' ')}`)
        const clearR = await executor.exec(SETFACL, clearArgs)
        if (clearR.exitCode !== 0)
          throw new Error(clearR.stderr.trim() || `setfacl -b -k exited with code ${clearR.exitCode}`)
      }
      // Also drop the setgid bit we set for ACL inheritance — with the
      // named grants gone there is nothing to inherit, and a leftover
      // setgid would make the reported mode (e.g. 2775 vs 775) misleading.
      // A recursive clear that ALSO sets the base levels folds `g-s` into
      // that one mode chmod below (one `-R` walk instead of two); every
      // other shape needs its own call. The recursive `g-s` reaches regular
      // files on purpose: it repairs trees an earlier recursive grant marked
      // setgid file by file (before 0.4.3 that step ran `chmod -R g+s`).
      if (walk && !baseChanged) {
        await walkStep('chmod g-s', ['!', '-type', 'l'], [CHMOD, 'g-s'])
      }
      else if (!walk) {
        const gsArgs = ['g-s', mountpoint]
        updateProgress(`chmod ${gsArgs.join(' ')}`)
        const unsetR = await executor.exec(CHMOD, gsArgs)
        if (unsetR.exitCode !== 0)
          throw new Error(unsetR.stderr.trim() || `chmod g-s exited with code ${unsetR.exitCode}`)
      }
    }
    if (baseChanged) {
      // Recursive: symbolic perms with capital `X` so execute is applied only
      // to directories (and already-executable files), never sprinkled onto
      // plain data files. When we cleared ACLs, append `,g-s` so the setgid
      // bit is removed in the SAME recursive walk (the `=` clauses set the
      // base perms, `g-s` strips setgid). Non-recursive: numeric octal is
      // correct — the mountpoint is always a directory — and the setgid-clear
      // above stays its own cheap call. GNU chmod takes the comma-separated
      // clauses mixing `=` and `-` (`u=rwX,g=rX,o=,g-s`), and its `X` is
      // decided by each file's mode BEFORE the change, so an executable keeps
      // execute and a plain file gets none (checked on scratch files with
      // coreutils 9.10; the 0.4.3 live proof did not run this shape).
      const mode = recursive
        ? (clearAcls ? `${levelsToSymbolic(base)},g-s` : levelsToSymbolic(base))
        : levelsToMode(base)
      if (walk) {
        // Links filtered out: chmod follows a link named as an argument.
        await walkStep(`chmod ${mode}`, ['!', '-type', 'l'], [CHMOD, mode])
      }
      else {
        const modeArgs = [mode, mountpoint]
        updateProgress(`chmod ${modeArgs.join(' ')}`)
        const modeR = await executor.exec(CHMOD, modeArgs)
        if (modeR.exitCode !== 0)
          throw new Error(modeR.stderr.trim() || `chmod ${mode} exited with code ${modeR.exitCode}`)
      }
    }

    return { ...ident, aclEnabled: enabled, aclAutoEnabled: false, namedCount: 0, clearedNamed: clearAcls, ...notChanged }
  }

  // --- The guard (story cr.37) ---------------------------------------------------

  /** The resolution refused (404 unknown / volume / unmounted, 400 a bad path). */
  const resolvedGate: Gate<AccessObject> = async o => o.resolveFailure ? failureRefusal(o.resolveFailure) : null

  /** The plan could not read the directory (404). */
  const plannedGate: Gate<AccessObject> = async o => o.planFailure ? failureRefusal(o.planFailure) : null

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
   * The lock claims (cr.33 §4.2) a set-access job takes: exclusive on a ZFS
   * dataset (`zfs:<pool guid>/<path>`, its ancestors shared), shared on an AHR
   * pool (`ahr:<vg uuid>`), each with the pool's name key shared. A pool whose
   * key cannot be read is locked by its name key, exclusive (§4.2's fallback,
   * which that shared name key meets — cr.33b). A share path on neither has no key.
   */
  async function accessClaims(t: AccessTarget | null, reads: GuardReads): Promise<LockClaim[]> {
    const dataset = t ? aclDatasetOf(t) : null
    if (dataset !== null) {
      const pool = dataset.split('/')[0]
      const guid = (await reads.once(`pool-guid:${pool}`, () => readPoolGuid(executor, pool)))?.guid
      return zfsDatasetClaims(guid, dataset, 'exclusive')
    }
    const ahr = t?.kind === 'ahr'
      ? { pool: t.pool, vgUuid: t.vgUuid }
      : t?.kind === 'share' && t.home?.kind === 'ahr' ? { pool: t.home.pool, vgUuid: t.home.vgUuid } : null
    if (ahr)
      return ahrPoolClaims(ahr.pool, ahr.vgUuid, 'shared')
    return []
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
      gates: [...(opts.before ?? []), resolvedGate, pathGate(req), plannedGate],
      locks: (o, _bound, reads) => accessClaims(o.target, reads),
    }
  }

  // --- The share grant (access.1) ------------------------------------------------

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

    const liveNamed: NamedEntry[] = acc.entries.filter(isNamed).map(e => ({ kind: e.kind, name: e.name, level: e.level }))
    const merged: NamedEntry[] = liveNamed.map((e) => {
      const w = wanted.find(x => x.kind === e.kind && x.name === e.name)
      return w ? { ...e, level: maxLevel(e.level, w.level) } : e
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
    entries.push(...merged.map(e => ({ kind: e.kind, name: e.name, level: e.level })))
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
   * would. Never throws — the share is created or updated whatever happens
   * here, and the outcome (with the gate's or the command's own sentence) rides
   * on the job result.
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
    opts: { recursiveConfirmed: boolean },
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
      const ran = await runSetAccess(plan, updateProgress)
      const children = Array.isArray(ran.childAclEnabled) ? { childAclEnabled: ran.childAclEnabled as string[] } : {}
      return outcome('applied', { granted, ...children })
    }
    catch (err) {
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
