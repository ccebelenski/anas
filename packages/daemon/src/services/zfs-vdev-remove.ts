import type { VdevRole, VdevType } from '@anas/shared'
import type { ParsedPoolStatus } from '../parsers/zpool-status.js'

/**
 * Story vdevs.2 — resolving the ONE vdev a remove request names against the
 * pool's parsed status, and the two refusal sentences that go with it.
 *
 * Kept out of the route so the lookup can be tested over a `ParsedPoolStatus`
 * built by hand: the parser on main does not yet surface the `logs`/`special`/
 * `dedup` sections (that is story vdevs.1, landing in parallel), so a fixture
 * round-trip could not cover those roles yet. The route and the tests ask the
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
 * The refusal for a vdev class `zpool remove` cannot take out instantly. Stated
 * once, quoted verbatim by the route and shown verbatim by the dialog.
 */
export const NON_REMOVABLE_VDEV_MESSAGE
  = 'data, special and dedup vdevs cannot be removed here — their removal is device evacuation, which ANAS does not offer'

/** The refusal for a name the pool does not carry. */
export function unknownVdevMessage(pool: string, vdev: string): string {
  return `pool ${pool} carries no vdev '${vdev}'`
}

/** The job's failure sentence when the vdev is still there after the remove. */
export function stillPresentMessage(pool: string, vdev: string): string {
  return `zpool remove reported success but '${vdev}' is still part of pool ${pool}`
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

/** The last path segment of a device path (`/dev/disk/by-id/x-part1` → `x-part1`). */
function basename(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
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
 * Cache and spare devices are never matched by their SECTION name — the parser
 * groups an L2ARC or the spare list under a synthetic container vdev
 * (`cache`/`spares`) that ZFS itself would not accept as a device argument, and
 * neither class is ever mirrored, so the leaf is always the removable unit.
 */
export function resolveVdev(status: ParsedPoolStatus, name: string): ResolvedVdev | null {
  for (const group of status.vdevGroups) {
    for (const vdev of group.vdevs) {
      for (const disk of vdev.disks) {
        if (disk.id !== name && disk.path !== name && basename(disk.path) !== name)
          continue
        return GROUPING_VDEV_TYPES.has(vdev.type)
          ? { role: group.role, vdev: vdev.name, token: vdev.name }
          : { role: group.role, vdev: vdev.name, token: disk.path }
      }
    }
  }

  for (const group of status.vdevGroups) {
    if (group.role === 'cache' || group.role === 'spare')
      continue
    for (const vdev of group.vdevs) {
      if (vdev.name === name)
        return { role: group.role, vdev: vdev.name, token: vdev.name }
    }
  }

  return null
}
