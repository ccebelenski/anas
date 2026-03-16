/**
 * Parser for `/dev/disk/by-id/` symlink listing.
 * Maps kernel device names to stable by-id identifiers.
 */

import type { ByIdMap } from './lsblk.js'

/** by-id name priority: prefer more specific identifiers */
const PREFIX_PRIORITY: Record<string, number> = {
  nvme: 4,
  scsi: 3,
  ata: 2,
  wwn: 1,
}

/**
 * Parse the output of `ls -la /dev/disk/by-id/` into a kernel-name → by-id mapping.
 * Each kernel device gets the highest-priority by-id name.
 * Partition entries (ending in -partN) are excluded — we want whole-disk IDs.
 */
export function parseDiskByIdListing(output: string): ByIdMap {
  const map = new Map<string, { id: string; priority: number }>()

  for (const line of output.split('\n')) {
    // Format: "lrwxrwxrwx 1 root root 9 Mar 15 22:12 scsi-0QEMU... -> ../../sdb"
    // Or simpler format from ls without -l: "scsi-0QEMU... -> ../../sdb"
    const match = line.match(/(\S+)\s+->\s+(?:\.\.\/)*(\S+)$/)
    if (!match) continue

    const byIdName = match[1]
    const target = match[2]

    // Skip partition entries
    if (byIdName.match(/-part\d+$/)) continue

    // Extract kernel name (e.g. "sdb" from "../../sdb")
    const kernelName = target.replace(/^(?:\.\.\/)*/, '')

    // Calculate priority
    const prefix = byIdName.split('-')[0]
    const priority = PREFIX_PRIORITY[prefix] ?? 0

    const existing = map.get(kernelName)
    if (!existing || priority > existing.priority) {
      map.set(kernelName, { id: byIdName, priority })
    }
  }

  const result: ByIdMap = new Map()
  for (const [kernelName, { id }] of map) {
    result.set(kernelName, id)
  }
  return result
}
