/**
 * Parser for `/etc/pve/storage.cfg` — the Proxmox VE storage definition file.
 *
 * ANAS reads this file (never writes it — guest philosophy) purely to recognise
 * which ZFS pools PVE already manages (Epic 3.25). The result is a map from a
 * pool ROOT name to the PVE storages that reference it, attached read-only to
 * each PoolSummary/PoolDetail so the UI can flag PVE-managed pools and keep its
 * hands off them.
 *
 * The file is a set of blank-line-separated stanzas:
 *
 *     zfspool: datapool
 *     \tpool datapool
 *     \tcontent images,rootdir
 *     \tmountpoint /datapool
 *     \tnodes anas-pve
 *
 *     dir: local
 *     \tpath /var/lib/vz
 *     \tcontent vztmpl,snippets,backup,rootdir,images,iso
 *
 * A stanza header (`<type>: <id>`) sits at column 0; its keys are indented.
 *
 * ENOENT (a missing file — a non-PVE / dev host) is FAIL-OPEN: an empty map,
 * never a throw, so GET /pools keeps working on hosts with no PVE. ANY OTHER
 * read failure returns `null` (see {@link readPveStorages}) — unreadable is a
 * DIFFERENT answer from absent, and a missing fact may only TIGHTEN a
 * hands-off gate, never loosen one (pvepool.1 review fix 1).
 */

import type { PveStorageRef } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from './findmnt.js'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseFindmnt } from './findmnt.js'

const execFileAsync = promisify(execFile)

/** Default location of the PVE storage config on a Proxmox host. */
export const PVE_STORAGE_CFG = '/etc/pve/storage.cfg'

/** The zfs binary the executor-routed mountpoint read runs ({@link readZfsMountpoints}). */
const ZFS_BIN = '/usr/sbin/zfs'

/** The findmnt binary the mountpoint read runs for `legacy`/`none` targets. */
const FINDMNT_BIN = '/usr/bin/findmnt'

/**
 * A ZFS dataset's mountpoint, as needed to resolve a PVE `dir` storage back to
 * its pool. `pool` is the pool ROOT that owns `dataset` (e.g. dataset
 * `tank/backups` → pool `tank`). Supplied to {@link parsePveStorageCfg} /
 * {@link readPveStorages}; produced by {@link readZfsMountpoints}.
 */
export interface ZfsMountpoint {
  /**
   * Absolute mountpoint, e.g. `/tank/backups` — or the target findmnt reports
   * for a `legacy`/`none` dataset that IS mounted (its `zfs list` mountpoint
   * is a marker, not a path). `''` when the dataset's mountpoint is
   * `legacy`/`none` and no live mount is known: the row stays in the table
   * (the dataset remains visible to the parse) but can never win a
   * {@link matchMountpoint} (pvepool.1 review fix 5).
   */
  mountpoint: string
  /** Full ZFS dataset name, e.g. `tank/backups`. */
  dataset: string
  /** Pool root that owns the dataset, e.g. `tank`. */
  pool: string
}

/** A stanza header line: `<type>: <id>` at column 0 (not indented). */
const HEADER_RE = /^(\w+):\s+(\S+)\s*$/

/**
 * An indented `key value` line: first token is the key, the rest the value.
 * One mandatory separator; any extra whitespace rides into the value and is
 * trimmed off by the caller (a single `\s` keeps the pattern backtrack-free).
 */
const KEY_VALUE_RE = /^(\S+)\s(.*)$/

/** Trailing carriage return (CRLF files) — stripped, indentation preserved. */
const TRAILING_CR_RE = /\r$/

/** One or more trailing slashes on a path (normalised away before comparison). */
const TRAILING_SLASH_RE = /\/+$/

/** The pool ROOT is the segment before the first '/' (e.g. `tank/data` → `tank`). */
function poolRoot(dataset: string): string {
  return dataset.split('/')[0]
}

/** Split a `content` CSV (`images,rootdir`) into a trimmed, empty-free array. */
function splitContent(content: string | undefined): string[] {
  return content
    ? content.split(',').map(c => c.trim()).filter(Boolean)
    : []
}

/** Strip trailing slashes from an absolute path (but keep the root `/` itself). */
function stripTrailingSlash(path: string): string {
  return path.replace(TRAILING_SLASH_RE, '') || '/'
}

/**
 * Is `path` equal to, or nested under, mountpoint `mp`? Both are compared as
 * normalised absolute paths. The root mountpoint `/` contains every absolute
 * path; any other `mp` contains `path` only when `path` is `mp` or begins with
 * `mp + '/'` (so `/tank` does NOT swallow `/tank-other`).
 */
function isUnder(path: string, mp: string): boolean {
  if (mp === '/')
    return path.startsWith('/')
  return path === mp || path.startsWith(`${mp}/`)
}

/**
 * Is `path` hosted by a ZFS filesystem, per the findmnt mount table? The
 * LONGEST-PREFIX mount containing the path decides — the filesystem actually
 * serving the path (a nested non-ZFS mount shadows the ZFS mount above it).
 *
 * Returns `null` when the table is unavailable — UNKNOWN, and the caller
 * tightens whatever gate this feeds (missing facts may only tighten). A
 * READABLE table that answers ext4 (e.g. `/` over `/var/lib/vz`) is a READ
 * answer — the path is on no ZFS filesystem, and the 2026-09-22 caveat-emptor
 * ruling (EPICS §2) allows a share there. Stacked mounts at one target (an
 * autofs placeholder and the real fs) count as ZFS-backed when ANY of the
 * longest-prefix mounts is zfs. Pure and total.
 */
export function pathOnZfsFilesystem(path: string, nodes: FindmntNode[] | null): boolean | null {
  if (nodes === null)
    return null
  const target = stripTrailingSlash(path)
  let bestLen = -1
  let zfs = false
  for (const n of nodes) {
    if (!n.target)
      continue
    const t = stripTrailingSlash(n.target)
    if (!isUnder(target, t))
      continue
    if (t.length > bestLen) {
      bestLen = t.length
      zfs = n.fstype === 'zfs'
    }
    else if (t.length === bestLen && n.fstype === 'zfs') {
      zfs = true
    }
  }
  // A readable table that names no containing mount (unreachable on a real
  // host — findmnt always lists `/`) answers "no ZFS filesystem here".
  return bestLen < 0 ? false : zfs
}

/**
 * The ONE longest-prefix path → dataset resolver: resolve an absolute path
 * onto the ZFS dataset that hosts it. A path is on ZFS iff it sits at or under
 * a dataset's mountpoint; when several datasets nest (e.g. `/tank` and
 * `/tank/backups`), the LONGEST matching mountpoint — the most specific
 * dataset — wins. Returns the winning mountpoint entry, or `null` when the
 * path is on no ZFS dataset (e.g. `/var/lib/vz`).
 *
 * Three consumers ask it (pvepool.1 review fixes): `parsePveStorageCfg`
 * resolves a `dir` storage's path, {@link readZfsMountpoints}' callers resolve
 * an iSCSI file backing, and the footprint service's `datasetOfPath` resolves
 * a share path — there is no second copy of this loop anywhere (the
 * single-source-of-truth rule; iscsi-ownership's private copy was folded into
 * this one).
 */
export function matchMountpoint(path: string, mountpoints: ZfsMountpoint[]): ZfsMountpoint | null {
  const target = stripTrailingSlash(path)
  let best: ZfsMountpoint | null = null
  let bestLen = -1
  for (const mp of mountpoints) {
    if (!mp.mountpoint)
      continue
    const canonical = stripTrailingSlash(mp.mountpoint)
    if (isUnder(target, canonical) && canonical.length > bestLen) {
      best = mp
      bestLen = canonical.length
    }
  }
  return best
}

/**
 * What one read of a storage.cfg answers (pvepool.1 review fix 5): the
 * pool-keyed refs PLUS the `dir` storages whose configured `path` resolved onto
 * no ZFS dataset. The unresolved dirs keep their configured `path` (they have
 * no dataset to key by) — the share-path backstop matches a share against those
 * paths directly, the same path rule mounts and restore use, so a `legacy`
 * dataset with no live mount still tightens instead of opening. The parser is
 * TOTAL — every unresolvable dir lands here; the footprint service filters the
 * list down to the ZFS-BACKED ones for its share gate (a non-ZFS path such as
 * `/var/lib/vz` is allowed, caveat emptor — EPICS §2, ruled 2026-09-22).
 */
export interface PveStorageParse {
  /** `poolRoot -> PveStorageRef[]` (resolved refs only). */
  byPool: Map<string, PveStorageRef[]>
  /** `dir` storages whose path resolved onto no dataset (see above). */
  unresolvedDirs: { storage: string, path: string }[]
}

/**
 * Parse the text of a storage.cfg into a {@link PveStorageParse}.
 *
 * `zfspool` stanzas are the PRIMARY signal: they carry the `pool <name>` line
 * that ties a storage to a ZFS pool. For each we read `pool <name>` and
 * `content <csv>`, key the ref by the pool root, and record the full dataset.
 *
 * `dir` stanzas are a SECONDARY signal (backup/iso/template storage). A dir has
 * `path <abspath>` + `content <csv>`; it is PVE-managed-on-ZFS iff its `path`
 * resolves onto a ZFS dataset's mountpoint. Resolution needs the mountpoint
 * table, so it only happens when `mountpoints` is supplied — WITHOUT it, dir
 * stanzas are ignored (the original zfspool-only behavior, unchanged) and
 * `unresolvedDirs` stays empty. When a dir path matches, the ref is
 * `{ type:'dir', dataset:<matched dataset> }` keyed by that dataset's pool
 * root; when it matches NOTHING (a `legacy`/`none` dataset with no live mount,
 * or a path on a non-ZFS filesystem — e.g. `/var/lib/vz`), the dir lands in
 * `unresolvedDirs` with its configured `path` (pvepool.1 review fix 5).
 *
 * Edge cases:
 *  - Commented-out lines (leading `#`, after trimming) are skipped, so a
 *    `#zfspool: old` stanza never registers a phantom PVE storage.
 *  - `pool <name>` may be a dataset path (`tank/data`); we key by its root but
 *    keep the full path in `dataset`.
 *  - A `zfspool` stanza with no `pool` line is skipped (nothing to attach to).
 *  - A `dir` stanza with no `path` line is skipped.
 *  - Nested datasets: the LONGEST matching mountpoint (most specific dataset)
 *    wins, so a dir under `/tank/backups` attaches to `tank/backups`, not `tank`.
 *  - Missing `content` yields an empty content array (still a valid ref).
 */
export function parsePveStorageCfg(
  text: string,
  mountpoints?: ZfsMountpoint[],
): PveStorageParse {
  const byPool = new Map<string, PveStorageRef[]>()
  const unresolvedDirs: { storage: string, path: string }[] = []

  const pushRef = (root: string, ref: PveStorageRef) => {
    const list = byPool.get(root)
    if (list)
      list.push(ref)
    else
      byPool.set(root, [ref])
  }

  interface Stanza { type: string, id: string, pool?: string, path?: string, content?: string }
  let current: Stanza | null = null

  const flush = () => {
    if (!current)
      return
    // zfspool: the pool line names the ZFS pool directly (primary signal).
    if (current.type === 'zfspool' && current.pool) {
      pushRef(poolRoot(current.pool), {
        storage: current.id,
        type: 'zfspool',
        dataset: current.pool,
        content: splitContent(current.content),
      })
    }
    // dir: resolve the path onto a ZFS dataset (secondary signal). Only when a
    // mountpoint table is supplied (even an empty one — then nothing resolves);
    // without one, dir stanzas are ignored (the zfspool-only mode). A path that
    // matches no dataset keeps its configured path in `unresolvedDirs` instead
    // of vanishing — the share-path backstop needs it (pvepool.1 review fix 5).
    else if (current.type === 'dir' && current.path && mountpoints) {
      const match = matchMountpoint(current.path, mountpoints)
      if (match) {
        pushRef(poolRoot(match.pool), {
          storage: current.id,
          type: 'dir',
          dataset: match.dataset,
          content: splitContent(current.content),
        })
      }
      else {
        unresolvedDirs.push({ storage: current.id, path: current.path })
      }
    }
    current = null
  }

  for (const rawLine of text.split('\n')) {
    // Strip trailing CR (CRLF files) but preserve leading indentation, which
    // distinguishes a stanza header (column 0) from an indented key line.
    const line = rawLine.replace(TRAILING_CR_RE, '')
    const trimmed = line.trim()

    if (trimmed === '') {
      flush() // blank line ends the current stanza
      continue
    }
    if (trimmed.startsWith('#'))
      continue // whole-line comment (incl. commented-out stanzas)

    const header = HEADER_RE.exec(line)
    if (header) {
      // A new stanza header — flush any stanza still open (files may omit the
      // trailing blank line between stanzas).
      flush()
      current = { type: header[1], id: header[2] }
      continue
    }

    // Indented `key value` line belonging to the current stanza.
    if (!current)
      continue
    const kv = KEY_VALUE_RE.exec(trimmed)
    if (!kv)
      continue // a bare key with no value — nothing we consume
    const [, key, value] = kv
    if (key === 'pool')
      current.pool = value.trim()
    else if (key === 'path')
      current.path = value.trim()
    else if (key === 'content')
      current.content = value.trim()
  }
  flush() // final stanza (no trailing blank line)

  return { byPool, unresolvedDirs }
}

/**
 * Read and parse the PVE storage config. The ABSENT file (ENOENT — a non-PVE
 * or dev host) is FAIL-OPEN: an empty parse (no refs, no unresolved dirs), no
 * warning, exactly the posture GET /pools has always had off-PVE. ANY OTHER
 * read failure (EACCES, EIO, ENOTCONN — pmxcfs down, a hung cluster fs)
 * returns `null`: UNREADABLE, which is a different answer from absent, and
 * which the ownership service treats as "every pool may be PVE's until this
 * can be read" (pvepool.1 review fix 1 — an unreadable config must never read
 * as "no PVE storages", or every guest dataset turns manageable). A READ file
 * that parses to nothing still yields an (empty) parse — the parser is total.
 * Path is overridable for tests.
 *
 * Pass `mountpoints` (from {@link readZfsMountpoints}) to ALSO resolve `dir`
 * storages that live on a ZFS dataset (secondary signal) and to report the
 * ones that do not resolve ({@link PveStorageParse.unresolvedDirs}). `null`
 * (that read failed) resolves dir stanzas the same way as omitting it — they
 * are skipped. Omit it for the original zfspool-only behavior.
 */
let storagesReadWarned = false

export async function readPveStorages(
  path: string = PVE_STORAGE_CFG,
  mountpoints?: ZfsMountpoint[] | null,
): Promise<PveStorageParse | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  }
  catch (err: unknown) {
    // ENOENT is expected off-PVE and not worth a warning; anything else means
    // the answer is UNKNOWN, not "no storages" — say so once per process, not
    // once per request (journald must not flood on a dead pmxcfs).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { byPool: new Map(), unresolvedDirs: [] }
    if (!storagesReadWarned) {
      storagesReadWarned = true
      console.warn(`anasd: could not read ${path} for PVE storage detection — treated as UNREADABLE (ownership gates tighten) until it can be read:`, err)
    }
    return null
  }
  try {
    return parsePveStorageCfg(text, mountpoints ?? undefined)
  }
  catch (err: unknown) {
    console.warn(`anasd: could not parse ${path} for PVE storage detection:`, err)
    return { byPool: new Map(), unresolvedDirs: [] }
  }
}

/**
 * The datasets findmnt reports as zfs MOUNTS, keyed by dataset (the mount's
 * `source`) — the target each one is actually mounted at. A `legacy`/`none`
 * dataset's `zfs list` mountpoint is a marker, not a path; when such a dataset
 * IS mounted (fstab, a manual mount), findmnt knows where (pvepool.1 review
 * fix 5). Non-zfs mounts are not datasets this table tracks. Pure and total:
 * first target wins per dataset, malformed rows yield nothing.
 */
export function zfsMountTargets(nodes: FindmntNode[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of nodes) {
    if (n.fstype === 'zfs' && n.source && n.target && !out.has(n.source))
      out.set(n.source, n.target)
  }
  return out
}

/**
 * Parse `zfs list -H -o name,mountpoint` output into the dataset→mountpoint
 * table.
 *
 * `-H` gives tab-separated, header-less rows: `<dataset>\t<mountpoint>`. Volumes
 * (`-`) and malformed rows are dropped — a block device cannot host a `dir`
 * storage. A `none`/`legacy` mountpoint is NOT dropped (pvepool.1 review fix
 * 5): the dataset stays in the table so a `dir` storage on it is visible, with
 * its mountpoint taken from `mountedTargets` (findmnt — see
 * {@link zfsMountTargets}) when the dataset is live, else `''` (kept but never
 * matchable). Pure and total: any malformed row is skipped, never throws.
 */
export function parseZfsMountpoints(text: string, mountedTargets: Map<string, string> = new Map()): ZfsMountpoint[] {
  const out: ZfsMountpoint[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.trim() === '')
      continue
    const tab = line.indexOf('\t')
    if (tab < 0)
      continue
    const dataset = line.slice(0, tab).trim()
    const mountpoint = line.slice(tab + 1).trim()
    if (!dataset || mountpoint === '-' || mountpoint === '')
      continue
    const resolved = mountpoint === 'none' || mountpoint === 'legacy'
      ? (mountedTargets.get(dataset) ?? '')
      : mountpoint
    out.push({ mountpoint: resolved, dataset, pool: poolRoot(dataset) })
  }
  return out
}

/**
 * List ZFS dataset mountpoints via `zfs list`, resolving the targets of
 * `legacy`/`none` datasets from `findmnt` (pvepool.1 review fix 5 — their
 * `zfs list` mountpoint is a marker, and a live fstab mount is the only
 * evidence of where they actually sit). Used to resolve PVE `dir` storages
 * onto their pool (and, via the footprint service's `datasetOfPath`, a share
 * path onto its dataset). A missing `zfs` binary (ENOENT — a non-ZFS host) is
 * FAIL-OPEN: an empty array, no warning. ANY OTHER failure (nonzero exit,
 * spawn trouble) returns `null` — UNREADABLE, the same three-valued posture
 * as {@link readPveStorages}: callers tighten whatever gate the mountpoints
 * feed instead of reading "no ZFS datasets" (pvepool.1 review fix 1). A
 * findmnt failure only degrades the legacy/none resolution (those rows stay
 * unresolvable, `''`), never the table itself. Uses execFile (args array, no
 * shell).
 *
 * When an {@link CommandExecutor} is supplied the read goes THROUGH it — the
 * footprint service always passes its executor, so the read is mock-driven in
 * tests and captured by the real daemon's argv discipline; without one the
 * read runs directly (the pre-existing callers: mounts.ts, iscsi.ts).
 */
let mountpointsReadWarned = false

/** What one full mountpoint read answers (pvepool.1 caveat-emptor ruling). */
export interface ZfsMountpointsRead {
  /** The dataset→mountpoint table (`zfs list` + findmnt-resolved legacy/none rows). */
  mountpoints: ZfsMountpoint[]
  /**
   * The findmnt mount table — ALL filesystems, not just the zfs ones — when
   * that read succeeded, else `null`. The footprint service asks
   * {@link pathOnZfsFilesystem} over it to tell a `dir` storage's unresolved
   * path on a ZFS filesystem (claimed) from one on ext4 (allowed, caveat
   * emptor). `null` is UNKNOWN: callers tighten, never loosen.
   */
  findmntNodes: FindmntNode[] | null
}

/**
 * The FULL read behind {@link readZfsMountpoints}: the same mountpoint table
 * PLUS the findmnt table and its availability, which the share-path backstop's
 * ZFS-backed test needs ({@link pathOnZfsFilesystem}). Same three-valued
 * posture: `null` when the `zfs list` side fails, a findmnt failure only
 * degrades legacy/none resolution and reports `findmntNodes: null`.
 */
export async function readZfsMountpointsFull(zfsOrExec: string | CommandExecutor = 'zfs'): Promise<ZfsMountpointsRead | null> {
  const exec = typeof zfsOrExec === 'object' ? zfsOrExec : undefined
  const zfs = typeof zfsOrExec === 'string' ? zfsOrExec : 'zfs'
  try {
    let stdout: string
    let mountedTargets = new Map<string, string>()
    let findmntNodes: FindmntNode[] | null = null
    if (exec) {
      // A non-zero exit is UNREADABLE (never "no datasets") — the direct
      // execFileAsync below rejects on one, so the executor path must too.
      const [zfsResult, findmntResult] = await Promise.all([
        exec.exec(ZFS_BIN, ['list', '-H', '-o', 'name,mountpoint']),
        exec.exec(FINDMNT_BIN, ['--json']),
      ])
      if (zfsResult.exitCode !== 0)
        throw new Error(`zfs list exited ${zfsResult.exitCode}: ${zfsResult.stderr.trim()}`)
      stdout = zfsResult.stdout
      if (findmntResult.exitCode === 0)
        findmntNodes = parseFindmnt(findmntResult.stdout)
    }
    else {
      // allSettled: the zfs side's rejection (ENOENT / nonzero) is the
      // three-valued signal; a findmnt hiccup only loses the legacy/none
      // resolution, never the table.
      const [zfsResult, findmntResult] = await Promise.allSettled([
        execFileAsync(zfs, ['list', '-H', '-o', 'name,mountpoint']),
        execFileAsync(FINDMNT_BIN, ['--json']),
      ])
      if (zfsResult.status === 'rejected')
        throw zfsResult.reason
      stdout = zfsResult.value.stdout
      if (findmntResult.status === 'fulfilled')
        findmntNodes = parseFindmnt(findmntResult.value.stdout)
    }
    if (findmntNodes !== null)
      mountedTargets = zfsMountTargets(findmntNodes)
    return { mountpoints: parseZfsMountpoints(stdout, mountedTargets), findmntNodes }
  }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { mountpoints: [], findmntNodes: null }
    if (!mountpointsReadWarned) {
      mountpointsReadWarned = true
      console.warn('anasd: could not list ZFS mountpoints for PVE dir detection — treated as UNREADABLE, not empty:', err)
    }
    return null
  }
}

/**
 * The ZFS dataset mountpoint table only — the shape the pre-existing callers
 * (mounts, iSCSI) consume. The footprint service asks {@link readZfsMountpointsFull}
 * instead, for the findmnt table beside it. See there for the semantics.
 */
export async function readZfsMountpoints(zfsOrExec: string | CommandExecutor = 'zfs'): Promise<ZfsMountpoint[] | null> {
  return (await readZfsMountpointsFull(zfsOrExec))?.mountpoints ?? null
}

/**
 * Parse storage.cfg into a map `absolute-mount-path -> storage id` for the
 * Mounts inventory's HANDS-OFF tagging (Epic 18). A PVE `nfs`/`cifs` storage
 * lands its mount at `path /mnt/pve/<id>` and shows in findmnt as an ordinary
 * remote mount — the ONLY way to recognise it is to cross-reference this file
 * (NOTES §3; never shell `pvesm status`). We collect the `path` of every
 * remote/dir storage and the `mountpoint` of every zfspool storage; the caller
 * matches a findmnt target against these paths (and the `/mnt/pve/` prefix).
 *
 * Pure and total: commented-out lines are skipped, malformed input yields an
 * empty map, never throws.
 */
export function parsePveMountPaths(text: string): Map<string, string> {
  const byPath = new Map<string, string>()
  let id: string | null = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#'))
      continue

    const header = HEADER_RE.exec(line)
    if (header) {
      id = header[2]
      continue
    }
    if (!id)
      continue
    const kv = KEY_VALUE_RE.exec(trimmed)
    if (!kv)
      continue
    const [, key, value] = kv
    // `path` (dir/nfs/cifs storages) and `mountpoint` (zfspool) both name an
    // absolute filesystem path PVE owns.
    if ((key === 'path' || key === 'mountpoint') && value.trim().startsWith('/'))
      byPath.set(stripTrailingSlash(value.trim()), id)
  }
  return byPath
}

/**
 * Read storage.cfg and return the PVE-owned mount-path → storage-id map,
 * FAIL-OPEN (missing file / parse error → empty map, never throws). Path is
 * overridable for tests.
 */
export async function readPveMountPaths(path: string = PVE_STORAGE_CFG): Promise<Map<string, string>> {
  try {
    return parsePveMountPaths(await readFile(path, 'utf8'))
  }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`anasd: could not read ${path} for PVE mount tagging:`, err)
    return new Map()
  }
}

// --- PBS storages (Epic 16.8: piggyback on PVE's PBS credentials) -----------

/**
 * A `pbs` storage stanza from storage.cfg — the read-only view ANAS needs to
 * offer it as a tier-1 backup repository. Ground truth (stunt node, `pvesm add
 * pbs`, 2026-07-19): the stanza keys are `server`, `datastore`, `username`,
 * `fingerprint`, optional `namespace`, optional `port`, plus a PVE-managed
 * `content backup`. The AUTH STYLE is not a key — it is inferred from the
 * username: a `user@realm!tokenname` (contains `!`) is token auth, otherwise
 * password auth. The SECRET is NOT here — it lives in
 * /etc/pve/priv/storage/<id>.pw and is read only at exec/test time.
 */
export interface PbsStorageDef {
  /** Storage id (the `pbs: <id>` header). */
  id: string
  /** PBS server host/IP (`server` key). */
  server: string
  /** TCP port (`port` key); absent → the pbc default (8007). */
  port?: number
  /** Datastore name (`datastore` key). */
  datastore: string
  /** Auth identity (`username` key): `user@realm` or `user@realm!tokenname`. */
  username?: string
  /** Pinned cert fingerprint (`fingerprint` key), sha256 colon-hex. */
  fingerprint?: string
  /** Optional PBS namespace within the datastore (`namespace` key). */
  namespace?: string
}

/** Default location of the PVE per-storage secret files (the `.pw` files). */
export const PVE_PRIV_STORAGE_DIR = '/etc/pve/priv/storage'

/**
 * Parse every `pbs` stanza out of a storage.cfg into {@link PbsStorageDef}s.
 *
 * Pure and total (matches the other parsers here): commented-out lines are
 * skipped, stanzas are blank-line- or header-separated, the final stanza needs
 * no trailing blank line, and malformed input yields fewer entries — never
 * throws. A stanza missing `server` or `datastore` is skipped (unusable).
 */
export function parsePbsStorages(text: string): PbsStorageDef[] {
  const out: PbsStorageDef[] = []

  interface Stanza {
    type: string
    id: string
    server?: string
    datastore?: string
    username?: string
    fingerprint?: string
    namespace?: string
    port?: string
  }
  let current: Stanza | null = null

  const flush = () => {
    if (current && current.type === 'pbs' && current.server && current.datastore) {
      const def: PbsStorageDef = {
        id: current.id,
        server: current.server,
        datastore: current.datastore,
      }
      if (current.port !== undefined) {
        const p = Number(current.port)
        if (Number.isInteger(p) && p > 0 && p <= 65535)
          def.port = p
      }
      if (current.username)
        def.username = current.username
      if (current.fingerprint)
        def.fingerprint = current.fingerprint
      if (current.namespace)
        def.namespace = current.namespace
      out.push(def)
    }
    current = null
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    const trimmed = line.trim()

    if (trimmed === '') {
      flush()
      continue
    }
    if (trimmed.startsWith('#'))
      continue

    const header = HEADER_RE.exec(line)
    if (header) {
      flush()
      current = { type: header[1], id: header[2] }
      continue
    }

    if (!current)
      continue
    const kv = KEY_VALUE_RE.exec(trimmed)
    if (!kv)
      continue
    const [, key, value] = kv
    const v = value.trim()
    if (key === 'server')
      current.server = v
    else if (key === 'datastore')
      current.datastore = v
    else if (key === 'username')
      current.username = v
    else if (key === 'fingerprint')
      current.fingerprint = v
    else if (key === 'namespace')
      current.namespace = v
    else if (key === 'port')
      current.port = v
  }
  flush()

  return out
}

/**
 * Read storage.cfg and return its `pbs` storage definitions, FAIL-OPEN (missing
 * file / parse error → empty array, never throws). Path is overridable for
 * tests. ANAS NEVER writes this file — it is read purely to offer the storage as
 * a hands-off tier-1 backup repository (Epic 16.8).
 */
export async function readPbsStorages(path: string = PVE_STORAGE_CFG): Promise<PbsStorageDef[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`anasd: could not read ${path} for PVE PBS storage detection:`, err)
    return []
  }
  try {
    return parsePbsStorages(text)
  }
  catch (err: unknown) {
    console.warn(`anasd: could not parse ${path} for PVE PBS storage detection:`, err)
    return []
  }
}
