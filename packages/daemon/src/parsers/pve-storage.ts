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
import { readFile } from 'node:fs/promises'

/** Default location of the PVE storage config on a Proxmox host. */
export const PVE_STORAGE_CFG = '/etc/pve/storage.cfg'

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

/** The pool ROOT is the segment before the first '/' (e.g. `tank/data` → `tank`). */
function poolRoot(dataset: string): string {
  return dataset.split('/')[0]
}

/**
 * Parse the text of a storage.cfg into a map `poolRoot -> PveStorageRef[]`.
 *
 * Only `zfspool` stanzas are emitted today — they carry the `pool <name>` line
 * that ties a storage to a ZFS pool, which is the signal 3.25 needs. For each
 * such stanza we read `pool <name>` and `content <csv>`, key the ref by the
 * pool root, and record the full dataset the storage points at.
 *
 * Edge cases:
 *  - Commented-out lines (leading `#`, after trimming) are skipped, so a
 *    `#zfspool: old` stanza never registers a phantom PVE storage.
 *  - `pool <name>` may be a dataset path (`tank/data`); we key by its root but
 *    keep the full path in `dataset`.
 *  - A `zfspool` stanza with no `pool` line is skipped (nothing to attach to).
 *  - Missing `content` yields an empty content array (still a valid ref).
 *  - EXTENSION POINT (deferred, Epic 3.26+): `dir` storages whose `path` sits on
 *    a ZFS mountpoint are a SECONDARY (backup/iso) signal for a pool. Resolving a
 *    dir path back to its pool needs the mountpoint→pool map, so it is not done
 *    here yet; `zfspool` is the primary signal and all 3.25 needs now.
 */
export function parsePveStorageCfg(text: string): Map<string, PveStorageRef[]> {
  const byPool = new Map<string, PveStorageRef[]>()

  interface Stanza { type: string, id: string, pool?: string, content?: string }
  let current: Stanza | null = null

  const flush = () => {
    if (!current)
      return
    // Only zfspool stanzas with a pool line map to a ZFS pool today.
    if (current.type === 'zfspool' && current.pool) {
      const root = poolRoot(current.pool)
      const ref: PveStorageRef = {
        storage: current.id,
        type: 'zfspool',
        dataset: current.pool,
        content: current.content
          ? current.content.split(',').map(c => c.trim()).filter(Boolean)
          : [],
      }
      const list = byPool.get(root)
      if (list)
        list.push(ref)
      else
        byPool.set(root, [ref])
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
 */
export async function readPveStorages(path: string = PVE_STORAGE_CFG): Promise<Map<string, PveStorageRef[]>> {
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
    return parsePveStorageCfg(text)
  }
  catch (err: unknown) {
    console.warn(`anasd: could not parse ${path} for PVE storage detection:`, err)
    return new Map()
  }
}
