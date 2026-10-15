/**
 * System-mount facts (story cr.23) — the ONE reader of the live mount table
 * that answers "is any of this pool's storage mounted at a system path?".
 *
 * The well-known-name list this replaces (`rpool`/`bpool`) decided on what a
 * pool is CALLED; this decides on what it DOES: a filesystem of the pool sits
 * at one of the {@link SYSTEM_MOUNT_TARGETS} paths (cr.18's list, the single
 * source), and pulling the pool out from under one of those paths takes the
 * running node's OS with it — whatever the pool is named.
 *
 * `findmnt --json` is the source (PRINCIPLES §13, structured output): it reads
 * the kernel mount table (`/proc/self/mountinfo`), so it never touches a
 * mountpoint's filesystem and never hangs (parsers/findmnt.ts is the proven
 * backbone). Each mount whose target EQUALS a system-path entry (exact match,
 * per the ruling — `/var/lib/remote` is an ordinary data mount) is resolved
 * back to its pool:
 *
 *   - ZFS: fstype `zfs`, source is the dataset name — the pool is the head
 *     (`rpool/ROOT/pve-1` → `rpool`);
 *   - AHR: the pool's filesystem lives on LV `<pool>/<pool>-vol` (ahr-paths),
 *     reported as `/dev/<vg>/<lv>` or `/dev/mapper/<dm>` (device-mapper
 *     escapes `-` as `--`) with the btrfs-subvol `[/...]` suffix stripped via
 *     the ONE normalizer (ahr-topology's `stripSubvolSuffix`). Requiring the
 *     vol-LV convention (`lv === <vg>-vol`) is what keeps `/dev/mapper/pve-root`
 *     — the plain LVM root every ext4 PVE node has — from answering a pool.
 *
 * Fail-closed like every other fact in this codebase: `null` means the mount
 * table could NOT be read (command failed, garbage output) and the caller
 * tightens; an empty result is a READ answer of "no pool sits at a system
 * path". A missing fact may only tighten the gate, never loosen it.
 */
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { stripSubvolSuffix } from './ahr-topology.js'
import { SYSTEM_MOUNT_TARGETS } from './mounts.js'

const FINDMNT = '/usr/bin/findmnt'

/** Exact-match set over cr.18's list — the single source, never a copy. */
const SYSTEM_MOUNT_TARGET_SET: ReadonlySet<string> = new Set<string>(SYSTEM_MOUNT_TARGETS)

/**
 * Which pools hold storage at a system path, and the first such path seen for
 * each (so the refusal can NAME the fact that fired: "is mounted at /var").
 */
export interface SystemMountFacts {
  /** ZFS pool name -> system path one of its datasets is mounted at. */
  zfs: Map<string, string>
  /** AHR pool name -> system path its volume is mounted at. */
  ahr: Map<string, string>
}

/** `/dev/<vg>/<lv>` — an active device-mapper volume's canonical path. */
const DEV_PATH_RE = /^\/dev\/([^/]+)\/([^/]+)$/
/** `/dev/mapper/<vg-lv>` — the same volume by device-mapper name. */
const DEV_MAPPER_RE = /^\/dev\/mapper\/(.+)$/

/**
 * Decode a device-mapper name (`dmName`'s escaping: `-` → `--`, the FIRST
 * single `-` separates vg from lv). Null when there is no separator to split
 * on. Inverse of ahr-topology's `dmName` by construction.
 */
export function decodeDmName(dm: string): { vg: string, lv: string } | null {
  const sep = dm.indexOf('-')
  if (sep === -1)
    return null
  // `--` is a literal `-` inside a name; the first SINGLE `-` is the separator.
  let vg = ''
  let i = 0
  for (; i < dm.length; i++) {
    if (dm[i] !== '-') {
      vg += dm[i]
      continue
    }
    if (dm[i + 1] === '-') {
      vg += '-'
      i++
      continue
    }
    return { vg, lv: dm.slice(i + 1).replaceAll('--', '-') }
  }
  return null
}

/**
 * The AHR pool a mount source belongs to, or null. The pool's VG carries the
 * pool name and its data LV is `<pool>-vol` (ahrLvPath); anything else — a
 * plain LVM root (`pve/root`), a cache LV, a non-LVM device — is no AHR pool.
 * The btrfs subvol suffix goes through the ONE normalizer so §12 subvol-layout
 * pools resolve exactly like flat ones.
 */
export function ahrPoolFromMountSource(source: string): string | null {
  const s = stripSubvolSuffix(source)
  // Mapper first: `/dev/mapper/<dm>` ALSO matches the two-segment shape
  // (vg=`mapper`), and a VG may not be named `mapper` anyway.
  const mapper = DEV_MAPPER_RE.exec(s)
  if (mapper) {
    const decoded = decodeDmName(mapper[1])
    if (!decoded)
      return null
    return decoded.lv === `${decoded.vg}-vol` ? decoded.vg : null
  }
  const direct = DEV_PATH_RE.exec(s)
  if (!direct)
    return null
  return direct[2] === `${direct[1]}-vol` ? direct[1] : null
}

/**
 * The ZFS pool a `zfs`-fstype mount belongs to: the dataset head
 * (`rpool/ROOT/pve-1` → `rpool`). Empty source (a malformed row) answers null.
 */
export function zfsPoolFromMountSource(source: string): string | null {
  const pool = source.split('/')[0]
  return pool === '' ? null : pool
}

/**
 * The pure core: scan already-parsed findmnt nodes for mounts whose target is
 * EXACTLY a system path and resolve each source to its pool. Total; every
 * non-matching mount is simply not a fact.
 */
export function systemMountPoolsFromNodes(nodes: FindmntNode[]): SystemMountFacts {
  const zfs = new Map<string, string>()
  const ahr = new Map<string, string>()
  for (const node of nodes) {
    if (!SYSTEM_MOUNT_TARGET_SET.has(node.target))
      continue
    if (node.fstype === 'zfs') {
      const pool = zfsPoolFromMountSource(node.source)
      if (pool !== null && !zfs.has(pool))
        zfs.set(pool, node.target)
      continue
    }
    const pool = ahrPoolFromMountSource(node.source)
    if (pool !== null && !ahr.has(pool))
      ahr.set(pool, node.target)
  }
  return { zfs, ahr }
}

/**
 * Parse + scan a `findmnt --json` table. GARBAGE is UNREADABLE (null), not the
 * empty answer: `parseFindmnt` alone is total (bad JSON → `[]`), and a total
 * parse here would let a corrupt table READ as "no pool at a system path" —
 * missing facts may only tighten.
 */
export function systemMountPoolsFromJson(text: string): SystemMountFacts | null {
  try {
    JSON.parse(text)
  }
  catch {
    return null
  }
  return systemMountPoolsFromNodes(parseFindmnt(text))
}

/**
 * Read the live mount table and answer which pools hold storage at system
 * paths. `null` = UNREADABLE (exec failed or non-zero exit, or garbage
 * output) — the caller refuses its verb, fail closed. The args default to the
 * full table (`--json`); AHR routes pass `AHR_FINDMNT_ARGS` to reuse the
 * table shape their reads already use.
 */
export async function readSystemMountPools(
  exec: CommandExecutor,
  args: readonly string[] = ['--json'],
): Promise<SystemMountFacts | null> {
  try {
    const res = await exec.exec(FINDMNT, [...args])
    if (res.exitCode !== 0)
      return null
    return systemMountPoolsFromJson(res.stdout)
  }
  catch {
    return null
  }
}

/**
 * The AHR-side refusal (story cr.23): an AHR pool with storage at a system
 * path, or whose mount table could not be read, never gets destroyed or
 * remounted. The sentence names the fact that fired. AHR has no boot facts —
 * the mount table is its whole answer, so an unreadable table refuses.
 */
export function ahrSystemMountRefusal(
  pool: string,
  facts: SystemMountFacts | null,
): { reason: 'system-pool', message: string } | null {
  if (facts === null) {
    return {
      reason: 'system-pool',
      message: `AHR pool '${pool}' is treated as a system pool (the mount table is unreadable) — ANAS never destroys or remounts a system pool`,
    }
  }
  const target = facts.ahr.get(pool)
  if (target !== undefined) {
    return {
      reason: 'system-pool',
      message: `AHR pool '${pool}' is mounted at ${target} — ANAS never destroys or remounts a system pool`,
    }
  }
  return null
}
