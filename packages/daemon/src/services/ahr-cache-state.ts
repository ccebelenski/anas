import type { AhrCache } from '@anas/shared'
import type { DmStatusLine } from '../parsers/dmsetup.js'
import type { LvmLv, LvmPv } from '../parsers/lvm-report.js'
import { dmCacheHealth } from '../parsers/dmsetup.js'
import { lvIsCacheTarget } from '../parsers/lvm-report.js'

/**
 * AHR read cache — naming conventions and the pool's `cache` block (story
 * ahrcache.1, AHR-DESIGN §13). A LEAF module: pure string and record math over
 * parser output, no exec, no fs, no imports from any other service.
 *
 * It lives apart from ahr-cache.ts (the executor) for the reason ahr-paths.ts
 * does: the TOPOLOGY reader needs these facts on every read, the executor
 * needs `readDiskTree` from the expansion path, and the expansion path already
 * depends on the topology reader. Shared facts belong below both consumers.
 */

/** sgdisk type code for an LVM physical volume (GUID E6D6D379-…). */
export const SGDISK_LVM_TYPE = '8E00'

/** lvm's placeholder for a PV whose device is missing (GT-19's `pvs` output). */
export const UNKNOWN_PV_NAME = '[unknown]'

/** The cache LV of a pool: `<pool>-cache`, beside the pool's `<pool>-vol`. */
export function cacheLvName(pool: string): string {
  return `${pool}-cache`
}

/**
 * Deterministic GPT label of one cache slice: `<pool>-cache<n>`, `n` 1-based
 * in attach order. Deliberately NOT the `<pool>-d<n>-b<band>` member shape — a
 * cache slice backs no band, and the band recognizer must never match it.
 */
export function cachePartitionLabel(pool: string, n: number): string {
  return `${pool}-cache${n}`
}

const CACHE_LABEL_TAIL_RE = /^cache(\d+)$/

/** The `-partN` tail of a by-id partition path. */
const PART_SUFFIX_RE = /-part\d+$/

/**
 * The exact inverse of {@link cachePartitionLabel}: the slice ordinal a GPT
 * label encodes, or null when the label is not a cache slice of `pool`.
 * Prefix-then-tail rather than an interpolated regex, so a pool name is never
 * compiled as a pattern (the same discipline as `matchPartitionLabel`).
 *
 * This is the ONE place that knows what a cache slice looks like on disk. It
 * is what lets detach find a slice LVM has already forgotten, and what keeps
 * the disk attributed to its pool right up until the slice is deleted (GT-22).
 */
export function matchCachePartitionLabel(pool: string, label: string): number | null {
  if (!label.startsWith(`${pool}-`))
    return null
  const m = label.slice(pool.length + 1).match(CACHE_LABEL_TAIL_RE)
  return m ? Number.parseInt(m[1], 10) : null
}

/**
 * Whether an lvm PV name is one of the pool's BAND arrays. Every AHR band PV
 * is an md device by construction (`/dev/md127` as lvm canonicalizes it, or
 * the `/dev/md/<pool>-r<N>` pin) — so a PV in the pool VG that is not one is
 * the cache's. That is §13's classification rule, stated as a predicate.
 */
export function isMdPvName(name: string): boolean {
  return name.startsWith('/dev/md')
}

// ---- The pool's `cache` block ----------------------------------------------

/** The minimum of an lsblk partition record this module reads. */
export interface CachePartInfo {
  partlabel: string | null
  size: number
  disk: { name: string }
}

/** Everything {@link buildAhrCacheState} needs, all of it already read. */
export interface CacheStateInput {
  poolName: string
  /** The pool's `<pool>-vol` row, when `lvs` listed it. */
  lv: LvmLv | undefined
  /** Every PV `pvs` reported (the whole node's — filtered here). */
  pvs: LvmPv[]
  /** How many band arrays the pool has — the missing-PV discriminator. */
  bandCount: number
  /** `lsblk`'s partitions by kernel name (the topology reader's index). */
  partsByKernel: Map<string, CachePartInfo>
  /** kernel disk name → by-id (the topology reader's map). */
  byIdMap: Map<string, string>
  /**
   * The pool LV's `dmsetup status` line, or null when it was not read (the
   * reader only asks when the LV is a cache target) or could not be parsed.
   * THE health source: `lvs` counters go stale rather than absent on a dead
   * cache (GT-23), so they are never the verdict.
   */
  dmStatus: DmStatusLine | null
}

/** What {@link buildAhrCacheState} found. */
export interface CacheFacts {
  /** The wire block for `AhrPool.cache`. */
  cache: AhrCache
  /**
   * by-id of every disk this pool's cache occupies — PV-derived and
   * label-derived alike, so a half-attached or half-detached slice still
   * attributes its disk to the pool (and still rides destroy's wipe list).
   */
  diskIds: string[]
}

/**
 * Build the pool's `cache` block from state the topology reader already holds.
 * PURE — no commands, no clock, no I/O.
 *
 * The verdict comes from `dmsetup status` and nothing else:
 *   `cache Error` ⇒ failed · any other `cache` target ⇒ healthy · else absent.
 * The counters ride only on `healthy`; on a failed cache `lvs` still reports
 * the last numbers it read (GT-23), and presenting those as live is precisely
 * the mis-reading this story exists to fix.
 */
export function buildAhrCacheState(input: CacheStateInput): CacheFacts {
  const { poolName, lv, pvs, bandCount, partsByKernel, byIdMap, dmStatus } = input
  const isCacheTarget = lv !== undefined && lvIsCacheTarget(lv.attr)

  const inVg = pvs.filter(p => p.vgName === poolName)
  const namedCachePvs = inVg.filter(p => !isMdPvName(p.name) && p.name !== UNKNOWN_PV_NAME)
  // A PV whose device is gone reads `[unknown]`, and a missing BAND PV looks
  // exactly the same. It is counted as the cache's only on evidence: the LV is
  // a cache target AND every band already has its own named md PV, so the
  // nameless one cannot be a band's. Without that test a pool with an
  // unassembled band would report a failed cache it never had.
  const bandPvCount = inVg.filter(p => isMdPvName(p.name)).length
  const unknownPvs = isCacheTarget && bandPvCount >= bandCount
    ? inVg.filter(p => p.name === UNKNOWN_PV_NAME)
    : []

  // by-id of each named cache PV's disk. LVM canonicalizes to the kernel path
  // (`/dev/sdd1`), so the slice is looked up in the lsblk index and resolved to
  // its whole disk; a by-id path is stripped of its `-partN` tail directly.
  const fromPvs: string[] = []
  for (const pv of namedCachePvs) {
    const id = pvDiskId(pv.name, partsByKernel, byIdMap)
    if (id !== null)
      fromPvs.push(id)
  }

  // Slices LVM has forgotten (or has not adopted yet) still belong to the pool:
  // the GPT label is the on-disk truth, and it survives `pvremove` and
  // `wipefs` — only `sgdisk -d` ends it (GT-22).
  const fromLabels: string[] = []
  let labeledBytes = 0
  for (const part of partsByKernel.values()) {
    if (part.partlabel === null || matchCachePartitionLabel(poolName, part.partlabel) === null)
      continue
    const id = byIdMap.get(part.disk.name)
    if (id !== undefined && !fromLabels.includes(id))
      fromLabels.push(id)
    labeledBytes += part.size
  }

  const diskIds = [...new Set([...fromPvs, ...fromLabels])]
  const state = dmCacheHealth(dmStatus) ?? 'absent'
  // Size from the PVs: a PV reports its size even when its device is missing,
  // so the figure survives the failure the block exists to report. With no PV
  // at all (a slice cut but not yet adopted) the on-disk slice size stands in.
  const pvBytes = [...namedCachePvs, ...unknownPvs].reduce((sum, p) => sum + p.sizeBytes, 0)

  const counters = state === 'healthy' && lv
    ? {
        ...(lv.cacheReadHits !== null ? { hits: lv.cacheReadHits } : {}),
        ...(lv.cacheReadMisses !== null ? { misses: lv.cacheReadMisses } : {}),
        ...(lv.cacheUsedBlocks !== null ? { usedBlocks: lv.cacheUsedBlocks } : {}),
        ...(lv.cacheTotalBlocks !== null ? { totalBlocks: lv.cacheTotalBlocks } : {}),
        ...(lv.cacheDirtyBlocks !== null ? { dirtyBlocks: lv.cacheDirtyBlocks } : {}),
      }
    : {}

  return {
    cache: {
      devices: diskIds,
      sizeBytes: pvBytes > 0 ? pvBytes : labeledBytes,
      mode: 'writethrough',
      policy: lv?.cachePolicy ?? '',
      state,
      ...counters,
    },
    diskIds,
  }
}

/** by-id of the whole disk an lvm PV path sits on, or null when unresolvable. */
function pvDiskId(
  pvName: string,
  partsByKernel: Map<string, CachePartInfo>,
  byIdMap: Map<string, string>,
): string | null {
  if (pvName.startsWith('/dev/disk/by-id/')) {
    const id = pvName.slice('/dev/disk/by-id/'.length)
    return id.replace(PART_SUFFIX_RE, '')
  }
  const kernel = pvName.startsWith('/dev/') ? pvName.slice('/dev/'.length) : pvName
  const disk = partsByKernel.get(kernel)?.disk.name
  return disk !== undefined ? (byIdMap.get(disk) ?? disk) : null
}

/**
 * The pool-level advisory a FAILED cache raises (GT-19: every read on the pool
 * returns EIO within the second, promoted or not — dm-cache does not fall
 * through to the origin). One sentence, the fact and the verb.
 */
export function cacheFailedAdvisory(pool: string): string {
  return `cache device failed on '${pool}'; reads fail until the cache is detached (Detach cache — no data is lost, writethrough holds nothing)`
}

/** The one advisory a rotating cache disk earns. Stated once, then dropped. */
export function rotatingCacheAdvisory(diskIds: string[]): string {
  return `${diskIds.join(', ')} ${diskIds.length === 1 ? 'is a rotating disk' : 'are rotating disks'}: `
    + `a rotating cache adds a seek, not speed`
}
