/**
 * AHR on-disk geometry (Epic 11 + AHR, docs/AHR-DESIGN.md §2.6) — PURE.
 *
 * Given a disk's §2.5-rounded usable size and its band slice assignments (from
 * the planners in ahr-layout.ts), produce the exact sgdisk partition spec.
 * Nothing here touches the system; the mutation layer consumes the specs.
 *
 * The rules encoded (ground truth GT-4, verified live in stage 0):
 *  - GPT, partition 1 starts at 1 MiB (never at the band-0 boundary of 0).
 *  - sgdisk END positions are INCLUSIVE: an interior slice [B_{i-1}, B_i) is
 *    expressed as start + `+size` — NEVER as an end "at" boundary B, which
 *    would overlap the next partition by one sector.
 *  - The disk's TOPMOST assigned slice clamps to the last usable sector
 *    (sgdisk end `0`) — the backup GPT eats the final 33 sectors, so a slice
 *    nominally ending at the disk's end can't be sized literally.
 *  - §2.6: unused regions get NO partition. A topmost assigned slice that ends
 *    BELOW the disk's usable size is sized exactly (`+size`), leaving the
 *    region above raw for future re-banding.
 *  - Partition type FD00 (Linux RAID), deterministic labels
 *    `<pool>-d<n>-b<band>`.
 */

const MIB = 1024 ** 2

/** Every AHR partition table starts its first slice at 1 MiB (GT-4). */
export const AHR_PARTITION_START_BYTES = MIB

/** sgdisk type code for Linux RAID partitions (GUID A19D880F-…). */
export const SGDISK_RAID_TYPE = 'FD00'

/**
 * The explicit `--data-offset` policy (§2.6 / GT-5): the mdadm DEFAULT varies
 * with member size, so ANAS pins a deterministic, generous offset at array
 * creation — the headroom is load-bearing for backup-file-free reshapes (§5.1).
 *
 * CALIBRATED on the stunt node 2026-07-24 (GT-5 closed; mdadm 4.4, 512K chunk,
 * `--bitmap=internal` as production). Two facts drove the tiers:
 *  1. mdadm's NATIVE data offset plateaus at **264192 sectors (129 MiB)** for
 *     every member ≥ 128 GiB — empirically constant 256 GiB → 15.6 TiB, and the
 *     mdadm headroom algorithm (128 MiB cap, halved only below 128 GiB) makes it
 *     constant to 20 TiB and beyond. The old 128 MiB pin sat 1 MiB UNDER mdadm's
 *     own choice — stingier than the default it replaced. Below the knee mdadm
 *     halves (64 GiB → 133120 s / 65 MiB; ~1–2 GiB members → 2048–4096 s).
 *  2. Offset consumed per backup-file-free grow does NOT accumulate linearly:
 *     a 4-member RAID5 pinned at 8192 s (4 MiB) shifted to 4096 s on the FIRST
 *     grow (4→5) then held at 4096 s across 5→6 and 6→7 — one bounded ~2 MiB
 *     shift (chunk-scaled critical section), not GT-6's feared cumulative drain.
 *
 * So the budget question resolves in favour of a **generous round pin ≥ native**:
 *  - Members ≥ 128 GiB (all production TB-scale disks; mdadm's own plateau knee):
 *    **256 MiB**. Dominates native (129 MiB) with margin, is a clean power-of-two,
 *    funds effectively unlimited grows (shift floors ~2 MiB), and wastes
 *    0.00128 % on a 20 TB disk — irrelevant, per §2.5's floor-to-GiB doctrine.
 *  - Members < 128 GiB (small/test members below mdadm's plateau, e.g. the 2 GiB
 *    stunt pool): **4 MiB**. Backup-file-free grow proven at this offset (floors
 *    ~2 MiB); kept small so the offset stays affordable on tiny members. This is
 *    the value existing small pools (stunt `tank`) were minted with — unchanged.
 *
 * Existing pools keep whatever offset they were CREATED with (on-disk, immutable,
 * legitimately divergent per member after grows — GT-6); these tiers bind only
 * newly created arrays.
 */
export const AHR_DATA_OFFSET = {
  /**
   * Member-partition size at which the large offset kicks in (mdadm's own
   *  native-plateau knee — at/above it mdadm would itself reserve 129 MiB).
   */
  largeMemberThresholdBytes: 128 * 1024 ** 3,
  /** Offset for members ≥ the threshold (≥ native 129 MiB, generous round). */
  largeBytes: 256 * MIB,
  /** Offset for smaller members (below mdadm's plateau; proven grow-capable). */
  smallBytes: 4 * MIB,
} as const

/** The pinned data offset in bytes for a member partition of the given size. */
export function ahrDataOffsetBytes(memberSizeBytes: number): number {
  return memberSizeBytes >= AHR_DATA_OFFSET.largeMemberThresholdBytes
    ? AHR_DATA_OFFSET.largeBytes
    : AHR_DATA_OFFSET.smallBytes
}

/**
 * The mdadm `--data-offset=` argument for a member partition, in sectors
 * (512-byte units, mdadm's `s` suffix — unambiguous across mdadm's
 * default-unit quirks).
 */
export function ahrDataOffsetArg(memberSizeBytes: number): string {
  return `--data-offset=${ahrDataOffsetBytes(memberSizeBytes) / 512}s`
}

/** Deterministic partition label: `<pool>-d<n>-b<band>` (stage-0 convention). */
export function partitionLabel(pool: string, diskNumber: number, band: number): string {
  return `${pool}-d${diskNumber}-b${band}`
}

/** The `d<n>-b<band>` tail of a member label, once the pool prefix is stripped. */
const LABEL_TAIL_RE = /^d(\d+)-b(\d+)$/

/**
 * The exact inverse of {@link partitionLabel}: the disk ordinal and band a GPT
 * partition label encodes, or null when the label is not a member label of
 * `pool`. Prefix-then-tail rather than an interpolated regex, so a pool name is
 * never compiled as a pattern.
 *
 * This is the one place that knows what "a member partition of pool X" looks
 * like on disk, and it is the ONLY way to recognize a member partition that no
 * array currently claims — the destroy sweep's whole premise (issue #16).
 */
export function matchPartitionLabel(pool: string, label: string): { diskNumber: number, band: number } | null {
  if (!label.startsWith(`${pool}-`))
    return null
  const m = label.slice(pool.length + 1).match(LABEL_TAIL_RE)
  if (!m)
    return null
  return { diskNumber: Number.parseInt(m[1], 10), band: Number.parseInt(m[2], 10) }
}

/** One band slice assigned to this disk by the planner ([startBytes, endBytes)). */
export interface AhrBandSlice {
  /** Band index (1-based, append-only across pool life). */
  band: number
  /** Lower band boundary in bytes (band 1 starts at 0). */
  startBytes: number
  /** Upper band boundary in bytes. */
  endBytes: number
}

/** One partition of the resulting sgdisk spec. */
export interface AhrPartitionSpec {
  /** GPT partition number (1-based, in band order). */
  number: number
  /** Band index this slice backs. */
  band: number
  /** Partition label, `<pool>-d<n>-b<band>`. */
  label: string
  /** Actual on-disk start (band 1's slice is displaced to 1 MiB). */
  startBytes: number
  /**
   * Exact partition size, or null when the slice clamps to the last usable
   * sector (sgdisk end position `0`) — the disk's topmost slice.
   */
  sizeBytes: number | null
  /** The complete sgdisk argument triplet: -n <spec> -t <type> -c <label>. */
  sgdiskArgs: string[]
}

/** Thrown for geometry that cannot be legally expressed. */
export class AhrGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AhrGeometryError'
  }
}

/** Render a byte position/size as sgdisk MiB notation (`1024M`). */
function mib(bytes: number, what: string): string {
  if (bytes % MIB !== 0)
    throw new AhrGeometryError(`${what} (${bytes} bytes) is not 1 MiB-aligned — band boundaries must be MiB-aligned (GT-4)`)
  return `${bytes / MIB}M`
}

/**
 * Compute the sgdisk partition spec for one disk from its assigned band
 * slices. Slices must be the planner's per-disk assignment: contiguous from
 * byte 0 upward (a disk participates in band i only if it reaches B_i, so its
 * bands are always 1..k from the bottom).
 *
 * Regression-locked against the exact stage-0 geometry (see the test file).
 */
export function planDiskPartitions(input: {
  poolName: string
  /** Ordinal of this disk within the pool (the `d<n>` of the label). */
  diskNumber: number
  /** §2.5-rounded usable size of the disk. */
  diskUsableBytes: number
  /**
   * RAW disk size, when known. When the raw size leaves clear room past the
   * rounded boundary, the topmost slice is sized EXACTLY to the boundary
   * instead of clamping to the disk's end — the §2.5 rounding slack stays
   * unpartitioned, so a clamped slice can never exceed the band height and
   * skew reporting. Without a raw size the topmost slice falls back to the
   * clamp (safe, GT-4).
   */
  diskRawBytes?: number
  slices: AhrBandSlice[]
}): AhrPartitionSpec[] {
  const { poolName, diskNumber, diskUsableBytes, diskRawBytes } = input
  const slices = [...input.slices]
  slices.sort((a, b) => a.startBytes - b.startBytes)
  if (slices.length === 0)
    return []

  // Validate the slice chain: contiguous from 0, ascending, within the disk.
  let expectedStart = 0
  for (const s of slices) {
    if (s.startBytes !== expectedStart)
      throw new AhrGeometryError(`slice for band ${s.band} starts at ${s.startBytes}, expected ${expectedStart} — per-disk slices must be contiguous from 0`)
    if (s.endBytes <= s.startBytes)
      throw new AhrGeometryError(`slice for band ${s.band} has a non-positive height`)
    if (s.endBytes > diskUsableBytes)
      throw new AhrGeometryError(`slice for band ${s.band} ends at ${s.endBytes}, beyond the disk's usable ${diskUsableBytes} bytes`)
    expectedStart = s.endBytes
  }

  return slices.map((slice, i) => {
    const number = i + 1
    const label = partitionLabel(poolName, diskNumber, slice.band)
    // Band 1's slice starts at 1 MiB, not 0 (GPT header + alignment, GT-4).
    const startBytes = Math.max(slice.startBytes, AHR_PARTITION_START_BYTES)

    // The disk's topmost slice — and ONLY a slice that nominally reaches the
    // disk's end — clamps to the last usable sector (end token `0`). A final
    // slice ending below that is sized exactly, leaving the region above it
    // unpartitioned (§2.6: raw for future re-banding). When the RAW size is
    // known and leaves ≥2 MiB past the boundary (GPT tail is ~17 KiB), the
    // exact size is used even at the rounded end — rounding slack stays raw.
    const rawLeavesRoom = diskRawBytes !== undefined && diskRawBytes - slice.endBytes >= 2 * 1024 * 1024
    const clampsToEnd = i === slices.length - 1 && slice.endBytes >= diskUsableBytes && !rawLeavesRoom
    const sizeBytes = clampsToEnd ? null : slice.endBytes - startBytes
    const endToken = clampsToEnd ? '0' : `+${mib(sizeBytes!, `size of band ${slice.band} slice`)}`

    return {
      number,
      band: slice.band,
      label,
      startBytes,
      sizeBytes,
      sgdiskArgs: [
        '-n',
        `${number}:${mib(startBytes, `start of band ${slice.band} slice`)}:${endToken}`,
        '-t',
        `${number}:${SGDISK_RAID_TYPE}`,
        '-c',
        `${number}:${label}`,
      ],
    }
  })
}
