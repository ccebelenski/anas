import type { Disk } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskIdentityCache } from './disk-identity-cache.js'
import { isComposableDisk } from '@anas/shared'
import { collectDisks } from '../routes/disks.js'

/**
 * The JOB-TIME availability re-check for every AHR verb that wipes a disk
 * (story ident.3 (a), identity audit #3).
 *
 * The route checks availability when the request arrives; the job runs when
 * the queue reaches it — behind scrubs and backups, possibly hours later. In
 * between, the disk can become a Ceph OSD, join a ZFS pool, or be picked by
 * another create. So create and spare-attach ask the SAME inventory the route
 * asked (`collectDisks` + `isComposableDisk`, the one predicate) again inside
 * the job, before the first destructive command, and refuse with the route's
 * own phrasing when the answer changed. Nothing has been touched at that
 * point, so the job fails clean.
 */

/** Why one disk may not be wiped now, or null when it may. */
export function diskIneligibility(id: string, disk: Disk | undefined): string | null {
  if (!disk)
    return `disk '${id}' not found in the inventory`
  if (isComposableDisk(disk))
    return null
  return disk.handsOff
    ? `disk '${id}' is hands-off: ${disk.handsOffReason ?? disk.handsOff}`
    : `disk '${id}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})`
}

/**
 * Re-read the live inventory and throw — naming every disk that is no longer
 * available — unless ALL of `ids` still are.
 */
export async function requireComposableNow(
  executor: CommandExecutor,
  diskCache: DiskIdentityCache,
  ids: string[],
): Promise<void> {
  const inventory = await collectDisks(executor, diskCache)
  const problems = ids
    .map(id => diskIneligibility(id, inventory.find(d => d.id === id)))
    .filter((p): p is string => p !== null)
  if (problems.length > 0)
    throw new Error(`the disk selection changed since it was confirmed — nothing was touched: ${problems.join('; ')}`)
}
