import type { AhrCache } from '@anas/shared'
import type { DmStatusLine } from '../parsers/dmsetup.js'
import type { LvmLv, LvmPv } from '../parsers/lvm-report.js'
import { dmCacheHealth } from '../parsers/dmsetup.js'
import { lvIsActive, lvIsCacheTarget } from '../parsers/lvm-report.js'

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
/** The same tail, capturing N. */
const PART_TAIL_RE = /-part(\d+)$/

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
 * the `/dev/md/<pool>-r<N>` pin). A PV in the pool VG that is NOT one is the
 * cache's only when it sits on a `<pool>-cache<n>` slice — a named PV with no
 * such label is someone else's (see {@link buildAhrCacheState}).
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
  /** GPT partition number, when lsblk's name carried one — resolves a by-id PV path. */
  partNumber?: number | null
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
   * reader only asks when the LV is an ACTIVE cache target — an inactive LV
   * has no dm table to ask) or could not be parsed.
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
   * A PV counts only when it sits on one of this pool's `<pool>-cache<n>`
   * slices: this list is what destroy zaps, and destroy must never reach a
   * disk ANAS did not label.
   */
  diskIds: string[]
  /**
   * Named PVs of the pool VG that are neither a band array nor on one of this
   * pool's cache slices — a PV an operator added by hand. Not ours: never a
   * pool disk, never on a wipe list, surfaced as an advisory only.
   */
  foreignPvs: string[]
  /**
   * The cache PV's device is gone: an `[unknown]` PV under the band guard.
   * The evidence both automatic rungs act on, and the fact that makes a
   * recovery's notification say "missing" instead of "failed".
   */
  deviceMissing: boolean
}

/**
 * Build the pool's `cache` block from state the topology reader already holds.
 * PURE — no commands, no clock, no I/O.
 *
 * The verdict, in order:
 *   - not a cache target                         ⇒ absent
 *   - the cache PV's device is gone (see below)  ⇒ failed
 *   - the pool LV is not active                  ⇒ inactive
 *   - `dmsetup status`: a failure word ⇒ failed · a real status line ⇒ healthy
 * The counters ride only on `healthy`; on a failed cache `lvs` still reports
 * the last numbers it read (GT-23), and presenting those as live is precisely
 * the mis-reading this story exists to fix.
 *
 * `failed` always rests on evidence that the CACHE is the problem:
 *  - A MISSING DEVICE outranks dmsetup. On an idle pool dm-cache only enters
 *    `Fail` once an I/O reaches the dead device, so right after the pull
 *    `dmsetup status` still prints healthy counters while the pool's first
 *    read will return EIO. A `[unknown]` PV under the band guard is the cache
 *    device gone, whatever dm says yet.
 *  - An INACTIVE volume has no dm table, and "Device does not exist" from
 *    dmsetup says nothing about the cache: the usual cause is a band array
 *    that did not assemble, with the cache SSD fine. That reads `inactive`,
 *    never `failed` — a `failed` here sent the boot rung to uncache a partial
 *    VG and announce a missing cache device that was sitting right there.
 *
 * ONE asymmetry, and it is deliberate: when the LV is an ACTIVE cache target
 * but dmsetup gave no legible answer — the command failed, the line did not
 * parse — the verdict is `failed`, never `absent`. `absent` claims there is no
 * cache, and the pool then reads healthy while potentially serving EIO to
 * every read: the exact GT-23 failure. An active cache target whose health
 * cannot be read is a cache whose health is not known to be good.
 */
export function buildAhrCacheState(input: CacheStateInput): CacheFacts {
  const { poolName, lv, pvs, bandCount, partsByKernel, byIdMap, dmStatus } = input
  const isCacheTarget = lv !== undefined && lvIsCacheTarget(lv.attr)

  const inVg = pvs.filter(p => p.vgName === poolName)
  // A named non-md PV is the cache's only when it sits on one of OUR labelled
  // slices — the rule detach already follows (guest philosophy: we own what we
  // labelled). Anything else in the VG is an operator's PV: it must never be
  // reported as a pool disk, because pool.disks is destroy's wipe list.
  const namedCachePvs: LvmPv[] = []
  const foreignPvs: string[] = []
  for (const pv of inVg) {
    if (isMdPvName(pv.name) || pv.name === UNKNOWN_PV_NAME)
      continue
    const label = pvPartition(pv.name, partsByKernel, byIdMap)?.partlabel ?? null
    if (label !== null && matchCachePartitionLabel(poolName, label) !== null)
      namedCachePvs.push(pv)
    else
      foreignPvs.push(pv.name)
  }
  // A PV whose device is gone reads `[unknown]`, and a missing BAND PV looks
  // exactly the same. It is counted as the cache's only on evidence: the LV is
  // a cache target AND every band already has its own named md PV, so the
  // nameless one cannot be a band's. Without that test a pool with an
  // unassembled band would report a failed cache it never had.
  const bandPvCount = inVg.filter(p => isMdPvName(p.name)).length
  const unknownPvs = isCacheTarget && bandPvCount >= bandCount
    ? inVg.filter(p => p.name === UNKNOWN_PV_NAME)
    : []

  const deviceMissing = unknownPvs.length > 0

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
  // See the doc comment for the order. `lvIsActive` null (no attr) reads as
  // active: an `inactive` verdict is never manufactured from a missing column.
  const lvActive = lv !== undefined && lvIsActive(lv.attr) !== false
  let state: AhrCache['state']
  if (!isCacheTarget)
    state = 'absent'
  else if (deviceMissing)
    state = 'failed'
  else if (!lvActive)
    state = 'inactive'
  else
    state = dmCacheHealth(dmStatus) ?? 'failed'
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
      ...(deviceMissing ? { deviceMissing: true as const } : {}),
      ...counters,
    },
    diskIds,
    foreignPvs,
    deviceMissing,
  }
}

/**
 * The lsblk record of the partition an lvm PV path names, or null when the PV
 * is not a partition lsblk can see (a whole disk, a dm device, a device that
 * is gone). Kernel path first — lvm canonicalizes to it — then the by-id
 * `<disk>-partN` form, resolved through the by-id map and the part number.
 */
function pvPartition(
  pvName: string,
  partsByKernel: Map<string, CachePartInfo>,
  byIdMap: Map<string, string>,
): CachePartInfo | null {
  if (pvName.startsWith('/dev/disk/by-id/')) {
    const tail = pvName.slice('/dev/disk/by-id/'.length)
    const m = tail.match(PART_TAIL_RE)
    if (!m)
      return null
    const diskId = tail.slice(0, m.index)
    const partNumber = Number.parseInt(m[1], 10)
    const kernelDisk = [...byIdMap.entries()].find(([, id]) => id === diskId)?.[0]
    if (kernelDisk === undefined)
      return null
    return [...partsByKernel.values()].find(p => p.disk.name === kernelDisk && p.partNumber === partNumber) ?? null
  }
  const kernel = pvName.startsWith('/dev/') ? pvName.slice('/dev/'.length) : pvName
  return partsByKernel.get(kernel) ?? null
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

/**
 * The pool-level advisory for PVs in the pool VG that ANAS did not put there
 * (ahrcache.1 review): named, not md, and on no `<pool>-cache<n>` slice. They
 * are left alone by every verb, which is exactly why the operator is told —
 * each clause is what a verb will or will not do to them. The expansion clause
 * is `lvextend -l +100%FREE` with no PV list: it takes free extents wherever
 * the VG has them.
 */
export function foreignVgPvAdvisory(pool: string, pvNames: string[]): string {
  const one = pvNames.length === 1
  return `volume group '${pool}' also holds ${pvNames.join(', ')}, which ${one ? 'is' : 'are'} neither a band array nor one of this pool's cache slices. `
    + `ANAS leaves ${one ? 'it' : 'them'} alone: Detach cache does not remove ${one ? 'it' : 'them'} from the volume group, and Destroy removes the volume group `
    + `and leaves ${one ? 'it as a physical volume' : 'them as physical volumes'} with no volume group. `
    + `An expansion grows the pool volume into any free space ${one ? 'it has' : 'they have'}`
}

/**
 * The sentence the auto-uncache rung says — in the notification body, in the
 * job progress and in the journal (ahrcache.1 slice 2, §13 "Resolved").
 *
 * PURE string math, one home, because the three surfaces must agree word for
 * word: an operator reading the mail and then the pool detail is reading the
 * same event, and two phrasings of it read as two events.
 *
 * `device` is what the daemon can still HONESTLY call the cache disk. When the
 * disk is gone its by-id cannot be recovered — a disk that is not there cannot
 * be asked what it was called — so the caller falls back to the GPT label udev
 * reported, and to nothing at all when even that is unknown.
 *
 * `readOnly` is the second fact and the one that costs the operator something:
 * `--uncache` restores READS in the same second (GT-20), but it cannot undo
 * btrfs's forced-readonly flag, and `mount -o remount,rw` is refused after an
 * error (GT-20 again). Only umount + mount — the Remount verb — brings writes
 * back, so the notification says so rather than leaving the pool looking fixed.
 */
export function cacheRecoveryNotification(input: {
  pool: string
  device: string | null
  readOnly: boolean
  /** `missing` at activation (the boot rung), `failed` under a live pool. */
  reason: 'failed' | 'missing'
}): { title: string, body: string } {
  const { pool, device, readOnly, reason } = input
  const subject = device === null ? 'The cache device' : `Cache device ${device}`
  const verb = reason === 'failed'
    ? `failed on pool '${pool}'`
    : `was missing when pool '${pool}' was activated`
  const body = `${subject} ${verb}. ANAS removed the cache automatically (lvconvert --uncache); `
    + `reads are restored uncached and no data was lost — a writethrough cache never holds the only copy of a byte.${
      readOnly
        ? ' The filesystem was forced READ-ONLY by the I/O error, so writes are stopped until the pool is remounted:'
        + ' use Remount in the Hybrid RAID view (it unmounts and mounts the pool, which breaks open share handles).'
        : ''
    } The cache disk stays out of the pool until it is attached again.`
  return {
    title: reason === 'failed' ? `AHR read cache failed: ${pool}` : `AHR read cache missing: ${pool}`,
    body,
  }
}

/** The one advisory a rotating cache disk earns. Stated once, then dropped. */
export function rotatingCacheAdvisory(diskIds: string[]): string {
  return `${diskIds.join(', ')} ${diskIds.length === 1 ? 'is a rotating disk' : 'are rotating disks'}: `
    + `a rotating cache adds a seek, not speed`
}

/**
 * The pool a `<pool>-cache<n>` GPT label belongs to, or null when the label is
 * not one of ours. The inverse of {@link cachePartitionLabel} from the other
 * side than {@link matchCachePartitionLabel}: that one asks "is this label pool
 * P's?", this one asks "whose is it?" — the question the udev hook has, holding
 * a label and no pool name.
 *
 * Deliberately strict about the tail: a band-member slice (`<pool>-d<n>-b<m>`)
 * must never resolve to a pool here, or a member disk's removal would enter the
 * cache recovery rung instead of md's own. The shipped udev rule already cannot
 * match one; this is the second door.
 */
export function poolOfCacheLabel(label: string): string | null {
  const at = label.lastIndexOf('-cache')
  if (at <= 0)
    return null
  const pool = label.slice(0, at)
  return matchCachePartitionLabel(pool, label) === null ? null : pool
}
