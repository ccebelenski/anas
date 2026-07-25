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

const SYMLINK_RE = /(\S+)\s+->\s+(?:\.\.\/)*(\S+)$/
const PARTITION_RE = /-part\d+$/
const RELATIVE_PREFIX_RE = /^(?:\.\.\/)*/
const NVME_PART_RE = /^(nvme\d+n\d+)p\d+$/
const SCSI_PART_RE = /^(\D+)\d+$/

/**
 * Reduce a kernel partition name to its whole-disk parent:
 *   sdb1 → sdb, sda15 → sda, nvme0n1p1 → nvme0n1.
 * A whole-disk name (no partition suffix) is returned unchanged.
 */
export function wholeDiskKernel(kernel: string): string {
  const nvme = kernel.match(NVME_PART_RE)
  if (nvme)
    return nvme[1]
  const scsi = kernel.match(SCSI_PART_RE)
  if (scsi)
    return scsi[1]
  return kernel
}

/**
 * Parse `ls -la /dev/disk/by-id/` into a COMPLETE by-id-name → kernel-name map.
 *
 * Unlike {@link parseDiskByIdListing} (which keeps only the single highest-
 * priority by-id per kernel device), this keeps EVERY by-id form — every
 * `ata-…`, `wwn-…`, `scsi-…`, `nvme-…` name maps to its whole-disk kernel
 * device. This is the join key used to cross-reference `zpool status` leaves
 * (whose `devid`/`path` may pick a DIFFERENT by-id form than our disk parser
 * would) against physical disks: both sides canonicalize to the kernel device.
 *
 * Partition suffixes are stripped on both sides: the by-id key loses its
 * `-partN` and the kernel target is reduced to its whole disk, so
 * `wwn-0x…-part1 -> ../../sdb1` contributes `wwn-0x…` → `sdb`.
 */
export function parseByIdToKernel(output: string): Map<string, string> {
  const map = new Map<string, string>()

  for (const line of output.split('\n')) {
    const match = line.match(SYMLINK_RE)
    if (!match)
      continue

    const byIdName = match[1].replace(PARTITION_RE, '')
    const kernelName = wholeDiskKernel(match[2].replace(RELATIVE_PREFIX_RE, ''))

    // First (whole-disk) entry wins; partition entries for the same by-id
    // resolve to the same kernel, so order is immaterial.
    if (!map.has(byIdName))
      map.set(byIdName, kernelName)
  }

  return map
}

/**
 * Like {@link parseByIdToKernel} but PARTITION-GRANULAR: keeps the `-partN`
 * suffix on BOTH sides, mapping each full by-id (`…-part1`) to its full kernel
 * partition (`sdb1`, `nvme0n1p1`). Whole-disk entries map to whole-disk kernels.
 *
 * The destroy-cleanup ownership guard uses this to identify EXACTLY which
 * partitions of a whole disk were the destroyed pool's leaves — so it can zap
 * the GPT only when every other partition is unclaimed. It never string-concats
 * a kernel partition name (the `sdb`+`1` vs `nvme0n1`+`p1` trap); the mapping is
 * read straight from the by-id symlink targets, which are already nvme-safe.
 */
export function parseByIdToKernelFull(output: string): Map<string, string> {
  const map = new Map<string, string>()

  for (const line of output.split('\n')) {
    const match = line.match(SYMLINK_RE)
    if (!match)
      continue

    const byIdName = match[1]
    const kernelName = match[2].replace(RELATIVE_PREFIX_RE, '')

    // First occurrence wins; duplicate by-id names resolve to the same kernel.
    if (!map.has(byIdName))
      map.set(byIdName, kernelName)
  }

  return map
}

/**
 * Parse the output of `ls -la /dev/disk/by-id/` into a kernel-name → by-id mapping.
 * Each kernel device gets the highest-priority by-id name.
 * Partition entries (ending in -partN) are excluded — we want whole-disk IDs.
 */
export function parseDiskByIdListing(output: string): ByIdMap {
  const map = new Map<string, { id: string, priority: number }>()

  for (const line of output.split('\n')) {
    // Format: "lrwxrwxrwx 1 root root 9 Mar 15 22:12 scsi-0QEMU... -> ../../sdb"
    // Or simpler format from ls without -l: "scsi-0QEMU... -> ../../sdb"
    const match = line.match(SYMLINK_RE)
    if (!match)
      continue

    const byIdName = match[1]
    const target = match[2]

    // Skip partition entries
    if (PARTITION_RE.test(byIdName))
      continue

    // Extract kernel name (e.g. "sdb" from "../../sdb")
    const kernelName = target.replace(RELATIVE_PREFIX_RE, '')

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
