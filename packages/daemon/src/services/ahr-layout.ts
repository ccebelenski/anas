import type {
  AhrExpansionStep,
  AhrLayoutPreview,
  AhrPreviewBand,
  AhrType,
  ArrayLevel,
} from '@anas/shared'
import type { KernelInfo } from './kernel-version.js'
import { MD_MIXED_LBS_MIN_KERNEL_TEXT } from './kernel-version.js'

/**
 * AHR layout computation (Epic 11 + AHR, docs/AHR-DESIGN.md §2) — PURE.
 *
 * Two different algorithms live here, and the difference is the point:
 *
 *  - {@link planFreshLayout} (§2.1) — fresh-create banding: sort disks, slice
 *    at every distinct size, one array per band. Applies ONLY at pool creation.
 *  - {@link planExpansion} (§2.3) — the incremental planner: existing bands are
 *    immutable constraints. A fresh layout for the post-expansion disk set is
 *    generally UNREACHABLE (boundaries between populated bands cannot move),
 *    so the planner computes the reachable target and the ordered §5.1 step
 *    list to get there. It reports reachable capacity, never fresh-ideal.
 *
 * Nothing here touches the system: no exec, no fs, no md/LVM. The
 * system-facing layer (ahr-expand-exec.ts) feeds these functions live
 * topology and executes the steps.
 */

// ---- Constants -------------------------------------------------------------

/**
 * Replacement-slack rounding granularity (§2.5): every disk's usable size is
 * floored to this before any band math, so a nominally-same replacement disk
 * (which can be tens of MB smaller) always fits (AHR-DESIGN §9.2).
 */
export const AHR_SIZE_GRANULARITY_BYTES = 1024 ** 3

/** Minimum disk count per tier (2 → RAID1 possible; 4 → RAID6 possible). */
export const AHR_MIN_DISKS: Record<AhrType, number> = { ahr1: 2, ahr2: 4 }

/** Members needed before a band can form a protected array, per tier. */
const MIN_BAND_MEMBERS: Record<AhrType, number> = { ahr1: 2, ahr2: 4 }

/** Disk-equivalents lost to redundancy in a protected band, per tier. */
const PARITY_DISKS: Record<AhrType, number> = { ahr1: 1, ahr2: 2 }

// ---- Inputs & errors -------------------------------------------------------

/** A candidate disk as the layout algorithms see it. */
export interface AhrLayoutDisk {
  /** Disk by-id identifier. */
  id: string
  /** Usable size in bytes (pre-rounding; both planners floor it via §2.5). */
  usableBytes: number
  /**
   * Logical sector size in bytes from the inventory (`lsblk LOG-SEC`) — 512 on
   * 512n/512e disks, 4096 on 4Kn. Optional: absent/null is treated as 512, the
   * overwhelmingly common case, so callers that do not care (the expansion
   * planner's size math) need not thread it. Used ONLY to label a mixed-geometry
   * selection (issue #8) — it never changes band boundaries.
   */
  logicalSectorSize?: number | null
}

/** Assumed logical block size when the inventory did not report one. */
export const AHR_DEFAULT_LOGICAL_BLOCK_BYTES = 512

/**
 * How far a PV may sit below its underlying device before ANAS calls it
 * UNDER-SIZED (i.e. an array that grew whose PV was never resized, issue #13).
 *
 * A healthy, fully-resized PV is ALWAYS a little smaller than its device: the
 * LVM metadata area at `pe_start` plus physical-extent rounding legitimately
 * eat a sliver. Ground truth, pve5 2026-08-09, all four PVs fully sized and
 * healthy (dev_size − pv_size):
 *
 *   /dev/md124  chiaahr2   ~3.0 MiB
 *   /dev/md125  chiaahr2   ~2.5 MiB
 *   /dev/md126  chiaahr2   ~4.0 MiB
 *   /dev/md127  chiaahr    ~2.0 MiB
 *
 * So the test must be STRUCTURAL, never `pv_size < dev_size` — the same lesson
 * as issue #4's delivered-capacity shortfall margin. 1 GiB is deliberately
 * generous against the observed 2–4 MiB: genuine stranded capacity is
 * band-height scale (GiBs to TiBs — the stage case was 2 GiB per band), and
 * sub-GiB never matters for capacity accounting. Being an order of magnitude
 * clear of the noise is worth more than precision we have no use for.
 */
export const PV_UNDERSIZE_MARGIN_BYTES = AHR_SIZE_GRANULARITY_BYTES

/**
 * Whether a PV is meaningfully smaller than the device beneath it — the ONE
 * predicate behind both the resume planner's pv-resize catch-up and the
 * topology reader's stranded-capacity accounting, so the two can never disagree
 * about what "stranded" means.
 */
export function isPvUnderSized(pvSizeBytes: number, deviceSizeBytes: number): boolean {
  if (pvSizeBytes <= 0 || deviceSizeBytes <= 0)
    return false
  return deviceSizeBytes - pvSizeBytes >= PV_UNDERSIZE_MARGIN_BYTES
}

/**
 * Opening words of the mixed-logical-block-size advisory. Exported so the
 * create route can lift that ONE warning out of the layout's warning list into
 * the confirm gate without re-deriving the condition — the planner stays the
 * single place that decides whether a selection is mixed.
 */
export const MIXED_SECTOR_WARNING_PREFIX = 'mixed sector geometries'

/**
 * One existing band array as an immutable planner constraint (§2.3): its
 * boundary, level, and current membership. Projected from the live pool
 * (AhrArray + partition tables) by the system-facing layer. Only bands that
 * actually carry an array appear here — an unused (wasted/pending) top slice
 * has no array, no partitions, and therefore no constraint.
 */
export interface ExistingBand {
  /** Band index (1-based; new bands strictly append after the highest). */
  band: number
  /** Lower boundary in bytes (band 1 starts at 0). */
  startBytes: number
  /** Upper boundary in bytes — immutable for the life of the pool. */
  endBytes: number
  level: ArrayLevel
  /** by-id of every current member disk. */
  members: string[]
}

/** A declared disk replacement (the ONLY way a member may leave the pool). */
export interface AhrReplacement {
  /** The outgoing member (must NOT be in the approved set). */
  oldDiskId: string
  /** The incoming disk (must be in the approved set). */
  newDiskId: string
}

/** The §2.3 planner's output: ordered §5.1 steps + the resulting layout. */
export interface AhrExpansionPlan {
  steps: AhrExpansionStep[]
  preview: AhrLayoutPreview
}

/**
 * Thrown when a plan cannot be computed legally — malformed constraints, a
 * member disk absent from the approved set (NEVER treated as intent to
 * shrink), or a replacement disk too small for the bands it must join.
 */
export class AhrPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AhrPlanError'
  }
}

// ---- §2.5 rounding ---------------------------------------------------------

/**
 * Floor a disk's usable size to the layout granularity (§2.5). All band
 * boundaries are computed on rounded sizes — this is the replacement-slack
 * guarantee, traded for a sliver of capacity.
 */
export function floorToGranularity(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return 0
  return Math.floor(bytes / AHR_SIZE_GRANULARITY_BYTES) * AHR_SIZE_GRANULARITY_BYTES
}

// ---- Shared helpers --------------------------------------------------------

/** Array level for a band of `members` disks, or null when unusable (§2.1). */
function levelFor(tier: AhrType, members: number): ArrayLevel | null {
  if (tier === 'ahr1') {
    if (members >= 3)
      return 'raid5'
    if (members === 2)
      return 'raid1'
    return null
  }
  return members >= 4 ? 'raid6' : null
}

/**
 * The single canonical AHR size formatter, shared by every AHR confirm
 * dialog, warning, and notification.
 *
 * Convention: GiB below 1024 GiB, TiB at or above, at most two decimals with
 * trailing zeros dropped — "3.64 TiB pending", "2 GiB", never "3724 GiB" or
 * a noisy "2.00 GiB". Two decimals at TiB scale keeps ~10 GiB of resolution;
 * dropping trailing zeros keeps whole-disk sizes clean in operator strings.
 */
export function fmtBytes(bytes: number): string {
  const gib = bytes / AHR_SIZE_GRANULARITY_BYTES
  if (gib >= 1024)
    return `${Math.round((gib / 1024) * 100) / 100} TiB`
  return `${Math.round(gib * 100) / 100} GiB`
}

interface RoundedDisk {
  id: string
  roundedBytes: number
  logicalBlockBytes: number
}

/** Round + sanity-check a disk list (duplicate ids are a caller bug). */
function roundDisks(disks: AhrLayoutDisk[], context: string): RoundedDisk[] {
  const seen = new Set<string>()
  return disks.map((d) => {
    if (seen.has(d.id))
      throw new AhrPlanError(`duplicate disk id '${d.id}' in ${context}`)
    seen.add(d.id)
    return {
      id: d.id,
      roundedBytes: floorToGranularity(d.usableBytes),
      logicalBlockBytes: d.logicalSectorSize && d.logicalSectorSize > 0
        ? d.logicalSectorSize
        : AHR_DEFAULT_LOGICAL_BLOCK_BYTES,
    }
  })
}

interface Region {
  startBytes: number
  endBytes: number
  members: RoundedDisk[]
}

/**
 * §2.1 banding of the capacity ABOVE `floorBytes`: boundaries at every
 * distinct rounded size > floorBytes; a band's members are the disks tall
 * enough to reach its upper boundary.
 */
function bandRegionsAbove(disks: RoundedDisk[], floorBytes: number): Region[] {
  const boundaries = [...new Set(disks.map(d => d.roundedBytes).filter(s => s > floorBytes))]
  boundaries.sort((a, b) => a - b)
  const regions: Region[] = []
  let start = floorBytes
  for (const end of boundaries) {
    regions.push({ startBytes: start, endBytes: end, members: disks.filter(d => d.roundedBytes >= end) })
    start = end
  }
  return regions
}

/**
 * The mixed-logical-block-size advisory (issue #8), or null when every
 * protected band lands on the same block size.
 *
 * An md array inherits `max(logical_block_size)` of its members, so a band
 * containing a 4Kn disk is 4096 while a band of 512e disks only is 512. LVM
 * refuses such a VG by default; ANAS passes `allow_mixed_block_sizes=1`
 * (services/ahr-exec.ts) and SAYS SO here rather than letting the operator meet
 * it as a post-wipe job failure. Only PROTECTED bands count — an unprotected
 * band carries no array and therefore no PV.
 *
 * On a kernel that CAN assemble such an array this is advisory — the mix
 * changes nothing about the layout, and btrfs's 4 KiB sector size satisfies the
 * stacked LV either way. On a kernel that cannot, it THROWS: see the gate note
 * on `kernel` in {@link planFreshLayout}.
 *
 * Pure: the kernel is passed IN (a value, never a system read from here).
 */
function mixedBlockSizeWarning(
  perBandInput: { band: number, protectedBand: boolean, members: RoundedDisk[] }[],
  kernel: KernelInfo | undefined,
): string | null {
  const perBand = perBandInput
    .map(b => ({
      band: b.band,
      protectedBand: b.protectedBand,
      blockBytes: b.members.reduce((max, d) => Math.max(max, d.logicalBlockBytes), 0),
    }))
    .filter(b => b.protectedBand && b.blockBytes > 0)
  const distinct = [...new Set(perBand.map(b => b.blockBytes))]
  if (distinct.length < 2)
    return null
  distinct.sort((a, b) => b - a)
  const sizes = distinct.join('/')

  // REFUSE below the floor. md on a pre-6.19 kernel has no configurable LBS, so
  // what such a kernel does with these arrays is unproven — and the operation
  // this gates WIPES DISKS. Refusing costs the operator a disk swap or a kernel
  // upgrade; gambling costs them the array. This fires at plan time, so it
  // lands as a 400 before any confirm code is minted and long before any disk
  // is touched. A uniform-geometry layout is unaffected on every kernel.
  if (kernel && !kernel.supportsMixedLbs) {
    throw new AhrPlanError(
      `this layout mixes ${sizes}-byte logical blocks, which needs kernel `
      + `${MD_MIXED_LBS_MIN_KERNEL_TEXT}+ (running: ${kernel.release}) — `
      + `upgrade the kernel or use disks with matching sector geometry`,
    )
  }

  const detail = perBand.map(b => `band ${b.band}: ${b.blockBytes}`).join(', ')
  // One factual line about the floor. Naming THIS node's kernel carries the
  // portability fact implicitly — cluster nodes can differ — without a lecture.
  const note = kernel
    ? ` These disks require kernel ${MD_MIXED_LBS_MIN_KERNEL_TEXT}+ to assemble (this node: ${kernel.release}).`
    : ` These disks require kernel ${MD_MIXED_LBS_MIN_KERNEL_TEXT}+ to assemble.`
  return `${MIXED_SECTOR_WARNING_PREFIX} (${distinct.join('-byte and ')}-byte logical blocks) — `
    + `the bands will have differing logical block sizes (${detail}); the LVM stack is built with `
    + `allow_mixed_block_sizes, and btrfs uses a 4 KiB sector size either way.${note}`
}

/** The min-disk warning text (mirrors the UI advisor copy). */
function minDisksWarning(tier: AhrType): string {
  return tier === 'ahr1'
    ? '1-disk fault tolerance (AHR-1) needs at least 2 disks'
    : '2-disk fault tolerance (AHR-2) needs at least 4 disks'
}

/**
 * Assemble the labeled capacity breakdown. The identity
 * `raw = usable + overhead + wasted + pending` holds exactly (on rounded
 * sizes): whatever raw capacity is neither usable, parity, nor pending is
 * unprotected — the §2.4 wasted slices of a fresh layout, or capacity
 * stranded between immovable boundaries in an expansion.
 */
function buildCapacity(bands: AhrPreviewBand[], rawBytes: number, pendingBytes: number): AhrLayoutPreview['capacity'] {
  let usableBytes = 0
  let redundancyOverheadBytes = 0
  for (const b of bands) {
    if (b.protected) {
      usableBytes += b.usableBytes
      redundancyOverheadBytes += b.heightBytes * b.memberCount - b.usableBytes
    }
  }
  const unprotectedWastedBytes = rawBytes - usableBytes - redundancyOverheadBytes - pendingBytes
  return {
    rawBytes,
    usableBytes,
    usedBytes: 0,
    freeBytes: usableBytes,
    redundancyOverheadBytes,
    unprotectedWastedBytes,
    pendingBytes,
  }
}

// ---- §2.1 fresh-create banding ---------------------------------------------

/**
 * Compute the fresh-create layout (§2.1) for a disk selection + tier — the
 * dry-run behind POST /v1/ahr/layout/preview and the composer's live feedback.
 *
 * Applies ONLY at pool creation: once arrays exist, band boundaries are
 * historical facts and expansion goes through {@link planExpansion}.
 *
 * Unusable bands (too few members — including the inherent §2.4 wasted top
 * slice of the largest disk under AHR-1) are kept in the band list, labeled
 * `protected: false`, and their capacity is reported as
 * `unprotectedWastedBytes` with a warning naming the unlock condition — never
 * silently dropped.
 *
 * `kernel` gates mixed logical block sizes (§4): a layout whose protected bands
 * would not all share one LBS THROWS {@link AhrPlanError} on a kernel below the
 * md configurable-LBS floor, which every caller already maps to a 400. Passing
 * it is a value, not a system read — this module never touches the host.
 */
export function planFreshLayout(disks: AhrLayoutDisk[], tier: AhrType, kernel?: KernelInfo): AhrLayoutPreview {
  const rounded = roundDisks(disks, 'disk selection')
  const rawBytes = rounded.reduce((sum, d) => sum + d.roundedBytes, 0)
  const warnings: string[] = []

  const regions = bandRegionsAbove(rounded, 0)
  const bands: AhrPreviewBand[] = regions.map((region, i) => {
    const memberCount = region.members.length
    const level = levelFor(tier, memberCount)
    const heightBytes = region.endBytes - region.startBytes
    return {
      band: i + 1,
      range: { startBytes: region.startBytes, endBytes: region.endBytes },
      memberCount,
      level,
      heightBytes,
      usableBytes: level === null ? 0 : heightBytes * (memberCount - PARITY_DISKS[tier]),
      protected: level !== null,
    }
  })

  const minDisksMet = disks.length >= AHR_MIN_DISKS[tier]
  if (!minDisksMet)
    warnings.push(minDisksWarning(tier))
  for (const b of bands) {
    if (!b.protected) {
      const needed = MIN_BAND_MEMBERS[tier] - b.memberCount
      warnings.push(
        `${fmtBytes(b.heightBytes * b.memberCount)} of unprotected capacity in band ${b.band} `
        + `(${fmtBytes(b.range.startBytes)}–${fmtBytes(b.range.endBytes)}) is unusable until `
        + `${needed} more disk${needed === 1 ? '' : 's'} of ≥${fmtBytes(b.range.endBytes)} ${needed === 1 ? 'is' : 'are'} added`,
      )
    }
  }
  const mixed = mixedBlockSizeWarning(
    bands.map((b, i) => ({ band: b.band, protectedBand: b.protected, members: regions[i].members })),
    kernel,
  )
  if (mixed)
    warnings.push(mixed)

  return { bands, capacity: buildCapacity(bands, rawBytes, 0), warnings, minDisksMet }
}

// ---- §2.3 incremental expansion planner ------------------------------------

/** Validate the existing-band constraints: contiguous from 0, ascending. */
function validateExistingBands(bands: ExistingBand[]): ExistingBand[] {
  const sorted = [...bands]
  sorted.sort((a, b) => a.band - b.band)
  let expectedStart = 0
  let prevIndex = 0
  for (const b of sorted) {
    if (b.band <= prevIndex)
      throw new AhrPlanError(`existing band indices must be strictly increasing (band ${b.band})`)
    if (b.startBytes !== expectedStart)
      throw new AhrPlanError(`existing band ${b.band} starts at ${b.startBytes}, expected ${expectedStart} — arrays must be contiguous from 0`)
    if (b.endBytes <= b.startBytes)
      throw new AhrPlanError(`existing band ${b.band} has a non-positive height`)
    if (b.members.length === 0)
      throw new AhrPlanError(`existing band ${b.band} has no members`)
    expectedStart = b.endBytes
    prevIndex = b.band
  }
  return sorted
}

/**
 * The incremental expansion planner (§2.3). Existing bands are IMMUTABLE
 * constraints; the only legal moves are:
 *
 *  - `array-grow`   — add members to an existing band's array (same level),
 *  - `array-convert`— RAID1×2 → RAID5×3+ when the member count crosses the
 *                     threshold (AHR-1 only; a distinct mdadm level-change
 *                     reshape, not a grow),
 *  - `array-create` — new arrays in new bands strictly ABOVE the current top
 *                     array boundary.
 *
 * Existing boundaries never move, existing bands never shrink, band indices
 * strictly append (§2.6 naming invariant). The full step list follows §5.1
 * pipeline order: partitions first, each md mutation followed by its
 * `reshape-wait`, then ONE pv/vg/lv/fs tail — the filesystem grows last,
 * only after the block device beneath it.
 *
 * REFUSES (AhrPlanError) any input where an existing member is absent from the
 * approved disk set: a missing disk is NEVER treated as intent to shrink
 * (§5.3). The only legal substitution is an explicit {@link AhrReplacement}.
 *
 * Pure: recomputed on every run/resume from (existing bands + approved disks);
 * step statuses all start `pending` — the executor detects done work.
 */
export function planExpansion(input: {
  poolName: string
  tier: AhrType
  existingBands: ExistingBand[]
  approvedDisks: AhrLayoutDisk[]
  replaced?: AhrReplacement
  /**
   * The running kernel, for the mixed-LBS gate (§4). Passed IN so this module
   * stays pure; omitted only by unit tests that are not exercising the gate.
   */
  kernel?: KernelInfo
}): AhrExpansionPlan {
  const { poolName, tier, replaced } = input
  const existing = validateExistingBands(input.existingBands)
  if (existing.length === 0)
    throw new AhrPlanError('expansion requires at least one existing band array — fresh creation uses planFreshLayout')

  const approved = roundDisks(input.approvedDisks, 'approved disk set')
  const approvedById = new Map(approved.map(d => [d.id, d]))
  if (replaced) {
    if (!approvedById.has(replaced.newDiskId))
      throw new AhrPlanError(`replacement disk '${replaced.newDiskId}' is not in the approved disk set`)
    if (approvedById.has(replaced.oldDiskId))
      throw new AhrPlanError(`replaced disk '${replaced.oldDiskId}' must not remain in the approved disk set`)
  }

  const mdName = (band: number): string => `md/${poolName}-r${band}`
  const warnings: string[] = []
  const bands: AhrPreviewBand[] = []
  const partitionBands = new Map<string, number[]>() // disk id → new slice band indices
  const mdSteps: Omit<AhrExpansionStep, 'index'>[] = []
  const pvSteps: Omit<AhrExpansionStep, 'index'>[] = []
  // Post-expansion membership per band — what the mixed-geometry check reads.
  const bandMembers: { band: number, protectedBand: boolean, members: RoundedDisk[] }[] = []

  const addSlice = (diskId: string, band: number): void => {
    const list = partitionBands.get(diskId) ?? []
    list.push(band)
    partitionBands.set(diskId, list)
  }

  // --- Existing bands: grow / convert (never shrink, never move) -----------
  for (const band of existing) {
    // Membership after the (only legal) substitution: the declared replacement.
    const effectiveMembers = band.members.map(m => replaced && m === replaced.oldDiskId ? replaced.newDiskId : m)
    for (const member of effectiveMembers) {
      const disk = approvedById.get(member)
      if (!disk) {
        throw new AhrPlanError(
          `disk '${member}' is a member of band ${band.band} but is absent from the approved disk set — `
          + `a missing disk is never treated as intent to shrink; approve the disk or declare a replacement`,
        )
      }
      if (disk.roundedBytes < band.endBytes) {
        throw new AhrPlanError(
          `disk '${disk.id}' (${fmtBytes(disk.roundedBytes)} usable after rounding) is too small for `
          + `band ${band.band} which ends at ${fmtBytes(band.endBytes)} (§2.5 replacement-slack check)`,
        )
      }
    }

    const heightBytes = band.endBytes - band.startBytes
    const oldCount = band.members.length
    const newMembers = approved.filter(d => d.roundedBytes >= band.endBytes)
    const newCount = newMembers.length
    if (newCount < oldCount)
      throw new AhrPlanError(`band ${band.band} would shrink from ${oldCount} to ${newCount} members — existing bands never shrink`)

    // Disks that become members of this band now need its slice partitioned —
    // that's every post-plan member that wasn't an ORIGINAL member (the
    // replacement disk is physically new even though it inherits membership).
    const original = new Set(band.members)
    for (const d of newMembers) {
      if (!original.has(d.id))
        addSlice(d.id, band.band)
    }

    const converts = tier === 'ahr1' && band.level === 'raid1' && newCount >= 3
    const level: ArrayLevel = converts ? 'raid5' : band.level
    if (converts) {
      mdSteps.push({ kind: 'array-convert', target: mdName(band.band), status: 'pending', detail: `raid1×${oldCount} → raid5×${newCount}` })
      mdSteps.push({ kind: 'reshape-wait', target: mdName(band.band), status: 'pending' })
      pvSteps.push({ kind: 'pv-resize', target: mdName(band.band), status: 'pending' })
    }
    else if (newCount > oldCount) {
      mdSteps.push({ kind: 'array-grow', target: mdName(band.band), status: 'pending', detail: `${band.level}×${oldCount} → ${band.level}×${newCount}` })
      mdSteps.push({ kind: 'reshape-wait', target: mdName(band.band), status: 'pending' })
      pvSteps.push({ kind: 'pv-resize', target: mdName(band.band), status: 'pending' })
    }

    bands.push({
      band: band.band,
      range: { startBytes: band.startBytes, endBytes: band.endBytes },
      memberCount: newCount,
      level,
      heightBytes,
      usableBytes: heightBytes * (newCount - PARITY_DISKS[tier]),
      protected: true,
    })
    bandMembers.push({ band: band.band, protectedBand: true, members: newMembers })
  }

  // --- New bands: strictly ABOVE the current top array boundary -------------
  const topBoundary = existing.at(-1)!.endBytes
  let nextBand = existing.at(-1)!.band + 1
  let pendingBytes = 0
  let createdCount = 0
  for (const region of bandRegionsAbove(approved, topBoundary)) {
    const band = nextBand++
    const memberCount = region.members.length
    const level = levelFor(tier, memberCount)
    const heightBytes = region.endBytes - region.startBytes
    if (level !== null) {
      // Every member needs this slice — capacity above the old top boundary
      // was never partitioned (unused slices are left raw precisely so the
      // planner is free to band this region however the new disks dictate).
      for (const d of region.members)
        addSlice(d.id, band)
      mdSteps.push({
        kind: 'array-create',
        target: mdName(band),
        status: 'pending',
        detail: `${level}×${memberCount}, band ${fmtBytes(region.startBytes)}–${fmtBytes(region.endBytes)}`,
      })
      mdSteps.push({ kind: 'reshape-wait', target: mdName(band), status: 'pending' })
      pvSteps.push({ kind: 'pv-create', target: mdName(band), status: 'pending' })
      createdCount++
    }
    else {
      // Physically present but locked (§5.2): report it as pending, with the
      // concrete unlock condition — never as silent missing capacity.
      const bandRaw = heightBytes * memberCount
      pendingBytes += bandRaw
      const needed = MIN_BAND_MEMBERS[tier] - memberCount
      warnings.push(
        `${fmtBytes(bandRaw)} of new capacity is pending — no new usable space until `
        + `${needed} more disk${needed === 1 ? '' : 's'} of ≥${fmtBytes(region.endBytes)} ${needed === 1 ? 'is' : 'are'} added`,
      )
    }
    bands.push({
      band,
      range: { startBytes: region.startBytes, endBytes: region.endBytes },
      memberCount,
      level,
      heightBytes,
      usableBytes: level === null ? 0 : heightBytes * (memberCount - PARITY_DISKS[tier]),
      protected: level !== null,
    })
    bandMembers.push({ band, protectedBand: level !== null, members: region.members })
  }

  // --- Mixed sector geometries (issue #8) — the SAME label create shows ----
  // Parallel construction: an expansion that introduces a 4Kn disk into a 512e
  // pool (or vice versa) lands the operator in exactly the geometry the create
  // path warns about, so it must say the same thing at the same moment — the
  // plan preview and the confirm gate, before anything is touched.
  const mixed = mixedBlockSizeWarning(bandMembers, input.kernel)
  if (mixed)
    warnings.push(mixed)

  // --- Stranded capacity: disks that end BETWEEN immovable boundaries -------
  // (e.g. an approved 2.5 TB disk against existing 2/3 TB boundaries: the
  // 2–2.5 slice can never join the 2–3 band). Labeled, never silently dropped.
  const bandEnds = bands.map(b => b.range.endBytes)
  for (const d of approved) {
    if (d.roundedBytes > 0 && !bandEnds.includes(d.roundedBytes)) {
      const covered = Math.max(0, ...bandEnds.filter(e => e <= d.roundedBytes))
      const stranded = d.roundedBytes - covered
      warnings.push(
        `disk '${d.id}': ${fmtBytes(stranded)} is stranded above the ${fmtBytes(covered)} boundary — `
        + `existing band boundaries are immutable, so this capacity cannot be used`,
      )
    }
  }

  // --- §5.1 step assembly: partitions → md (+reshape-wait) → one tail -------
  const steps: Omit<AhrExpansionStep, 'index'>[] = []
  const partitionDiskIds = [...partitionBands.keys()]
  partitionDiskIds.sort()
  for (const diskId of partitionDiskIds) {
    const sliceBands = partitionBands.get(diskId)!.sort((a, b) => a - b)
    steps.push({
      kind: 'partition',
      target: diskId,
      status: 'pending',
      detail: `slice${sliceBands.length === 1 ? '' : 's'} for band${sliceBands.length === 1 ? '' : 's'} ${sliceBands.join(', ')}`,
    })
  }
  steps.push(...mdSteps)
  steps.push(...pvSteps)
  if (createdCount > 0)
    steps.push({ kind: 'vg-extend', target: poolName, status: 'pending', detail: `add ${createdCount} PV${createdCount === 1 ? '' : 's'}` })
  if (pvSteps.length > 0) {
    steps.push({ kind: 'lv-extend', target: `${poolName}-vol`, status: 'pending' })
    steps.push({ kind: 'fs-grow', target: `${poolName}-vol`, status: 'pending' })
  }

  const rawBytes = approved.reduce((sum, d) => sum + d.roundedBytes, 0)
  const preview: AhrLayoutPreview = {
    bands,
    capacity: buildCapacity(bands, rawBytes, pendingBytes),
    warnings,
    minDisksMet: approved.length >= AHR_MIN_DISKS[tier],
  }
  return { steps: steps.map((s, index) => ({ index, ...s })), preview }
}
