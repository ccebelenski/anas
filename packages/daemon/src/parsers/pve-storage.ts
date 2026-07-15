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
 * This parser is FAIL-OPEN by contract: a missing file (non-PVE / dev host) or
 * any parse error yields an empty map and must NEVER throw — GET /pools depends
 * on it and must succeed on hosts with no PVE.
 */

import type { PveStorageRef } from '@anas/shared'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default location of the PVE storage config on a Proxmox host. */
export const PVE_STORAGE_CFG = '/etc/pve/storage.cfg'

/**
 * A ZFS dataset's mountpoint, as needed to resolve a PVE `dir` storage back to
 * its pool. `pool` is the pool ROOT that owns `dataset` (e.g. dataset
 * `tank/backups` → pool `tank`). Supplied to {@link parsePveStorageCfg} /
 * {@link readPveStorages}; produced by {@link readZfsMountpoints}.
 */
export interface ZfsMountpoint {
  /** Absolute mountpoint, e.g. `/tank/backups`. */
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
 * Resolve a `dir` storage's absolute `path` onto a ZFS dataset. A path is on
 * ZFS iff it sits at or under a dataset's mountpoint; when several datasets
 * nest (e.g. `/tank` and `/tank/backups`), the LONGEST matching mountpoint —
 * the most specific dataset — wins. Returns the winning mountpoint entry, or
 * `null` when the path is on no ZFS dataset (e.g. `/var/lib/vz`).
 */
function matchMountpoint(path: string, mountpoints: ZfsMountpoint[]): ZfsMountpoint | null {
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
 * Parse the text of a storage.cfg into a map `poolRoot -> PveStorageRef[]`.
 *
 * `zfspool` stanzas are the PRIMARY signal: they carry the `pool <name>` line
 * that ties a storage to a ZFS pool. For each we read `pool <name>` and
 * `content <csv>`, key the ref by the pool root, and record the full dataset.
 *
 * `dir` stanzas are a SECONDARY signal (backup/iso/template storage). A dir has
 * `path <abspath>` + `content <csv>`; it is PVE-managed-on-ZFS iff its `path`
 * resolves onto a ZFS dataset's mountpoint. Resolution needs the mountpoint→pool
 * map, so it only happens when `mountpoints` is supplied — WITHOUT it, dir
 * stanzas are ignored (the original zfspool-only behavior, unchanged). When a
 * dir path matches, the ref is `{ type:'dir', dataset:<matched dataset> }` and
 * is keyed by that dataset's pool root.
 *
 * Edge cases:
 *  - Commented-out lines (leading `#`, after trimming) are skipped, so a
 *    `#zfspool: old` stanza never registers a phantom PVE storage.
 *  - `pool <name>` may be a dataset path (`tank/data`); we key by its root but
 *    keep the full path in `dataset`.
 *  - A `zfspool` stanza with no `pool` line is skipped (nothing to attach to).
 *  - A `dir` stanza with no `path` line, or whose path is on no ZFS dataset
 *    (e.g. `/var/lib/vz`), is skipped.
 *  - Nested datasets: the LONGEST matching mountpoint (most specific dataset)
 *    wins, so a dir under `/tank/backups` attaches to `tank/backups`, not `tank`.
 *  - Missing `content` yields an empty content array (still a valid ref).
 */
export function parsePveStorageCfg(
  text: string,
  mountpoints?: ZfsMountpoint[],
): Map<string, PveStorageRef[]> {
  const byPool = new Map<string, PveStorageRef[]>()

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
    // mountpoint map is supplied; otherwise dir stanzas are ignored.
    else if (current.type === 'dir' && current.path && mountpoints && mountpoints.length > 0) {
      const match = matchMountpoint(current.path, mountpoints)
      if (match) {
        pushRef(poolRoot(match.pool), {
          storage: current.id,
          type: 'dir',
          dataset: match.dataset,
          content: splitContent(current.content),
        })
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

  return byPool
}

/**
 * Read and parse the PVE storage config, FAIL-OPEN. A missing file (non-PVE or
 * dev host) or any read/parse error resolves to an empty map — never throws, so
 * GET /pools keeps working everywhere. Path is overridable for tests.
 *
 * Pass `mountpoints` (from {@link readZfsMountpoints}) to ALSO resolve `dir`
 * storages that live on a ZFS dataset (secondary signal). Omit it for the
 * original zfspool-only behavior — nothing extra is read or computed.
 */
export async function readPveStorages(
  path: string = PVE_STORAGE_CFG,
  mountpoints?: ZfsMountpoint[],
): Promise<Map<string, PveStorageRef[]>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  }
  catch (err: unknown) {
    // ENOENT is expected off-PVE and not worth a warning; anything else is.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`anasd: could not read ${path} for PVE storage detection:`, err)
    return new Map()
  }
  try {
    return parsePveStorageCfg(text, mountpoints)
  }
  catch (err: unknown) {
    console.warn(`anasd: could not parse ${path} for PVE storage detection:`, err)
    return new Map()
  }
}

/**
 * Parse `zfs list -H -o name,mountpoint` output into a mountpoint→pool map.
 *
 * `-H` gives tab-separated, header-less rows: `<dataset>\t<mountpoint>`. Rows
 * whose mountpoint is not a real path (`-` for volumes, `none`, `legacy`, or
 * empty) are dropped — they cannot host a `dir` storage. Pure and total: any
 * malformed row is skipped, never throws.
 */
export function parseZfsMountpoints(text: string): ZfsMountpoint[] {
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
    if (!dataset || !mountpoint || mountpoint === '-' || mountpoint === 'none' || mountpoint === 'legacy')
      continue
    out.push({ mountpoint, dataset, pool: poolRoot(dataset) })
  }
  return out
}

/**
 * List ZFS dataset mountpoints via `zfs list`, FAIL-OPEN. Used to resolve PVE
 * `dir` storages onto their pool. Any failure (no ZFS, command error) resolves
 * to an empty array — dir detection is a secondary signal and must never break
 * GET /pools. Uses execFile (args array, no shell).
 */
export async function readZfsMountpoints(): Promise<ZfsMountpoint[]> {
  try {
    const { stdout } = await execFileAsync('zfs', ['list', '-H', '-o', 'name,mountpoint'])
    return parseZfsMountpoints(stdout)
  }
  catch (err: unknown) {
    console.warn('anasd: could not list ZFS mountpoints for PVE dir detection:', err)
    return []
  }
}
