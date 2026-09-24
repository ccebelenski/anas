import type { VdevRole, VdevType } from '@anas/shared'
import type { ParsedPoolStatus } from '../parsers/zpool-status.js'
import { basename } from 'node:path'

/**
 * Story vdevs.2 — resolving the ONE vdev a remove request names against the
 * pool's parsed status, and the refusal sentences that go with it.
 *
 * Kept out of the route so the lookup can be exercised directly over a
 * `ParsedPoolStatus`: the interesting shapes (a by-id partition-backed split
 * SSD, a spare ZFS has put to work, a section holding two leaves) are not all
 * carried by the shipped fixtures, and a hand-built status pins the resolution
 * itself rather than a whole HTTP round trip. The route and the tests ask the
 * SAME function either way — one answer, one place.
 */

/**
 * Top-level vdev types that GROUP their leaves. Removing one leaf of a mirrored
 * log is not what `zpool remove` does — the whole `mirror-N` comes out — so a
 * leaf inside one of these resolves to its parent.
 */
const GROUPING_VDEV_TYPES = new Set<VdevType>([
  'mirror',
  'raidz',
  'raidz2',
  'raidz3',
  'draid',
  'draid2',
  'draid3',
])

/**
 * The synthetic container names the status parser gives a pool-level section's
 * bare leaves (`parsePoolVdevSection`). `zpool remove` would never accept one
 * as a device argument — the LEAF is the removable unit — so a request naming a
 * container names nothing the pool carries.
 */
const SECTION_CONTAINER_NAMES = new Set(['logs', 'cache', 'spares', 'special', 'dedup'])

/**
 * The refusal for a vdev class `zpool remove` cannot take out instantly. Stated
 * once, quoted verbatim by the route and shown verbatim by the dialog.
 */
export const NON_REMOVABLE_VDEV_MESSAGE
  = 'data, special and dedup vdevs cannot be removed here — their removal is device evacuation, which ANAS does not offer'

/** The refusal for a name the pool does not carry. */
export function unknownVdevMessage(pool: string, vdev: string): string {
  return `pool ${pool} carries no vdev '${vdev}'`
}

/**
 * The refusal for a name that fits more than one leaf. A split device — one SSD
 * partitioned into a log and a cache — carries two leaves whose by-id DISK
 * identity is the same string (the `-partN` suffix is what tells them apart),
 * so a request naming the disk names both, and guessing would take out the SLOG
 * of an operator who picked the L2ARC (GitHub #66 layout).
 */
export function ambiguousVdevMessage(pool: string, vdev: string, candidates: string[]): string {
  return `'${vdev}' names more than one device in pool ${pool} (${candidates.join(', ')}) — name the one you mean by its device`
}

/** The refusal for a spare ZFS has already put to work. */
export function spareInUseMessage(vdev: string, host: string): string {
  return `spare ${vdev} is in use by ${host} — ZFS releases it when the replaced disk returns or is detached`
}

/** The job's failure sentence when the vdev is still there after the remove. */
export function stillPresentMessage(pool: string, vdev: string): string {
  return `zpool remove reported success but '${vdev}' is still part of pool ${pool}`
}

/** The job's failure sentence when the pool never answered after the remove. */
export function unreadablePoolMessage(pool: string, detail: string): string {
  return `zpool remove exited 0 but pool ${pool} could not be read back: ${detail}`
}

/** One vdev of the pool, resolved from the name a request named it by. */
export interface ResolvedVdev {
  /** The class it belongs to — the removable/refused decision is made on this. */
  role: VdevRole
  /** The top-level vdev it is (or belongs to), as the pool view shows it. */
  vdev: string
  /** Exactly what `zpool remove <pool> …` is handed. */
  token: string
}

/** A name the pool DOES carry but must not act on, with the sentence to say. */
export interface VdevRefusal {
  refusal: true
  message: string
}

/** What a lookup answers: the one vdev, a refusal sentence, or nothing. */
export type VdevLookup = ResolvedVdev | VdevRefusal | null

export function isVdevRefusal(lookup: VdevLookup): lookup is VdevRefusal {
  return lookup !== null && 'refusal' in lookup
}

/** The three spellings a leaf answers to: its path, its basename, its id. */
function namesLeaf(disk: { id: string, path: string }, name: string): boolean {
  return disk.path === name || basename(disk.path) === name || disk.id === name
}

/** How a candidate reads in the ambiguity sentence: `cache ata-SSD-part2`. */
function describeCandidate(hit: ResolvedVdev): string {
  return `${hit.role} ${basename(hit.token)}`
}

/**
 * Find the vdev `name` refers to anywhere in the pool's topology: a top-level
 * vdev name (`mirror-1`), a leaf's by-id id, a leaf's device-path basename, or
 * a leaf's full device path.
 *
 * The token handed to `zpool remove` is what `zpool status` shows for the thing
 * that actually comes out: the parent `mirror-N` for a leaf inside a mirrored
 * log, otherwise the leaf's own device path as the parser carries it (which
 * keeps a `-partN` suffix the id has stripped).
 *
 * Three answers, never a guess:
 *   - ONE leaf matches → that leaf (or its grouping parent);
 *   - SEVERAL leaves match → a refusal naming the candidates, because a by-id
 *     partition-backed split device gives its leaves the same `disk.id`;
 *   - a leaf that is ALSO listed in the spares section is a spare ZFS has put
 *     to work: it is skipped in the data walk (it is not a member of the vdev
 *     it patches, and that vdev is certainly not what comes out) and refused
 *     with its own sentence.
 *
 * Cache and spare devices are never matched by their SECTION name — the parser
 * groups a section's bare leaves under a synthetic container vdev
 * (`cache`/`spares`/`logs`/`special`/`dedup`) that ZFS itself would not accept
 * as a device argument, so the leaf is always the removable unit.
 */
export function resolveVdev(status: ParsedPoolStatus, name: string): VdevLookup {
  // Every leaf the spares section lists, by device path — the one spelling that
  // is unique per leaf (`id` collides across partitions of one disk).
  const sparePaths = new Set<string>()
  for (const group of status.vdevGroups) {
    if (group.role !== 'spare')
      continue
    for (const vdev of group.vdevs) {
      for (const disk of vdev.disks) sparePaths.add(disk.path)
    }
  }

  const matches: ResolvedVdev[] = []
  const seen = new Set<string>()
  let inUseSpareHost: string | null = null

  for (const group of status.vdevGroups) {
    for (const vdev of group.vdevs) {
      for (const disk of vdev.disks) {
        if (!namesLeaf(disk, name))
          continue
        // The same leaf under a data vdev AND in the spares section: an active
        // spare. Remember what it is standing in for, and do not read it as a
        // member of the vdev it is patching.
        if (group.role !== 'spare' && sparePaths.has(disk.path)) {
          inUseSpareHost ??= vdev.name
          continue
        }
        const hit: ResolvedVdev = GROUPING_VDEV_TYPES.has(vdev.type)
          ? { role: group.role, vdev: vdev.name, token: vdev.name }
          : { role: group.role, vdev: vdev.name, token: disk.path }
        const key = `${hit.role}|${hit.vdev}|${hit.token}`
        if (seen.has(key))
          continue
        seen.add(key)
        matches.push(hit)
      }
    }
  }

  if (matches.length > 1)
    return { refusal: true, message: ambiguousVdevMessage(status.name, name, matches.map(describeCandidate)) }
  if (inUseSpareHost)
    return { refusal: true, message: spareInUseMessage(name, inUseSpareHost) }
  if (matches.length === 1)
    return matches[0]

  for (const group of status.vdevGroups) {
    for (const vdev of group.vdevs) {
      if (vdev.name === name && !SECTION_CONTAINER_NAMES.has(vdev.name))
        return { role: group.role, vdev: vdev.name, token: vdev.name }
    }
  }

  return null
}

/**
 * Is the thing `zpool remove` was handed still part of the pool? Asked of the
 * status read back after the command, so the settle loop never re-runs the
 * ambiguity logic against a topology that has changed underneath it: it asks
 * about the exact token, which is either a top-level vdev name or a leaf's
 * device path.
 */
export function vdevStillPresent(status: ParsedPoolStatus, resolved: ResolvedVdev): boolean {
  for (const group of status.vdevGroups) {
    for (const vdev of group.vdevs) {
      if (vdev.name === resolved.token)
        return true
      for (const disk of vdev.disks) {
        if (disk.path === resolved.token)
          return true
      }
    }
  }
  return false
}
