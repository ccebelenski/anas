import type { VdevRole } from '@anas/shared'
import type { ParsedPoolStatus } from '../parsers/zpool-status.js'
import type { VdevRefusal } from './zfs-vdev-leaf.js'
import { GROUPING_VDEV_TYPES } from '@anas/shared'
import { ambiguousVdevMessage, describeCandidate, matchPoolLeaves } from './zfs-vdev-leaf.js'

export { ambiguousVdevMessage, isVdevRefusal, unknownVdevMessage } from './zfs-vdev-leaf.js'
export type { VdevRefusal } from './zfs-vdev-leaf.js'

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
 * The grouping types live ONCE in `@anas/shared` (GROUPING_VDEV_TYPES — the
 * same set the dashboard's topology join asks). A leaf inside one of them
 * resolves to its parent: removing one leg of a mirrored log is not what
 * `zpool remove` does — the whole `mirror-N` comes out.
 */

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

/** What a lookup answers: the one vdev, a refusal sentence, or nothing. */
export type VdevLookup = ResolvedVdev | VdevRefusal | null

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

  for (const { role, vdev, disk } of matchPoolLeaves(status, name)) {
    // The same leaf under a data vdev AND in the spares section: an active
    // spare. Remember what it is standing in for, and do not read it as a
    // member of the vdev it is patching.
    if (role !== 'spare' && sparePaths.has(disk.path)) {
      inUseSpareHost ??= vdev.name
      continue
    }
    const hit: ResolvedVdev = GROUPING_VDEV_TYPES.has(vdev.type)
      ? { role, vdev: vdev.name, token: vdev.name }
      : { role, vdev: vdev.name, token: disk.path }
    const key = `${hit.role}|${hit.vdev}|${hit.token}`
    if (seen.has(key))
      continue
    seen.add(key)
    matches.push(hit)
  }

  if (matches.length > 1) {
    return {
      refusal: true,
      message: ambiguousVdevMessage(status.name, name, matches.map(m => describeCandidate(m.role, m.token))),
    }
  }
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
