import { z } from 'zod'
import { AbsolutePath, DevicePath, DiskId, PoolName, UUID } from './common.js'

/**
 * AHR — ANAS Hybrid RAID (Epic 11 + AHR, docs/AHR-DESIGN.md §3).
 *
 * SHR-style hybrid RAID as orchestration over a fully open stack:
 *
 *   disks → GPT partitions (size-matched band slices)
 *         → one mdadm array per band  (redundancy lives HERE)
 *         → LVM: all arrays concatenated into one VG → one LV
 *         → btrfs on the single LV
 *
 * btrfs is the only filesystem — stated, not chosen. There is deliberately NO
 * filesystem field anywhere in these shapes (AHR-DESIGN "deliberate
 * exclusions"), and btrfs is never configured for btrfs-native RAID: redundancy
 * is md's job, always.
 *
 * These are the wire shapes for `/v1/ahr`; the layout/planner computation that
 * produces the preview and step shapes lives in the daemon
 * (services/ahr-layout.ts). Validated at both boundaries, like everything else.
 */

// ---- Enums -----------------------------------------------------------------

/**
 * The fault-tolerance tier, chosen at pool creation (no later conversion):
 * `ahr1` = 1-disk fault tolerance (RAID1/RAID5 bands), `ahr2` = 2-disk fault
 * tolerance (RAID6 bands). UI copy leads with the meaning, not the acronym.
 */
export const AhrType = z.enum(['ahr1', 'ahr2'])
export type AhrType = z.infer<typeof AhrType>

/** mdadm level of one band array. AHR-1 uses raid1/raid5; AHR-2 uses raid6. */
export const ArrayLevel = z.enum(['raid1', 'raid5', 'raid6'])
export type ArrayLevel = z.infer<typeof ArrayLevel>

/**
 * One band array's state. Initial RAID5/6 sync after create reports as
 * `resyncing` — UI copy presents that as "building — pool usable now",
 * distinct from degraded.
 */
export const ArrayState = z.enum([
  'clean',
  'degraded',
  'resyncing',
  'reshaping',
  'recovering',
  'failed',
])
export type ArrayState = z.infer<typeof ArrayState>

/**
 * Whole-pool state, fused across md + LVM + btrfs. Named `AhrPoolState` (the
 * design calls it PoolState) because zfs.ts already exports the ZFS `PoolState`.
 */
export const AhrPoolState = z.enum([
  'healthy',
  'degraded',
  'expanding',
  'rebuilding',
  'scrubbing',
  'failed',
  'readonly',
])
export type AhrPoolState = z.infer<typeof AhrPoolState>

/** One member partition's state within a band array (mdadm's view). */
export const AhrMemberState = z.enum([
  'in_sync',
  'faulty',
  'spare',
  'rebuilding',
  'missing',
])
export type AhrMemberState = z.infer<typeof AhrMemberState>

/** A disk's role in the pool. */
export const AhrDiskRole = z.enum(['member', 'spare'])
export type AhrDiskRole = z.infer<typeof AhrDiskRole>

/** What a running md sync thread is doing (from /proc/mdstat + --detail). */
export const AhrSyncAction = z.enum(['resync', 'reshape', 'recover', 'check'])
export type AhrSyncAction = z.infer<typeof AhrSyncAction>

// ---- Pool composition ------------------------------------------------------

/** One band slice on a disk (a GPT partition backing one band array member). */
export const AhrDiskPartition = z.object({
  /** Partition device path, e.g. "/dev/sdb2". */
  device: DevicePath,
  /** Band index this slice belongs to (1-based, append-only across pool life). */
  band: z.number().int().positive(),
  /** Slice size in bytes (the band height). */
  sizeBytes: z.number().int().nonnegative(),
})
export type AhrDiskPartition = z.infer<typeof AhrDiskPartition>

/** A disk participating in an AHR pool. */
export const AhrDisk = z.object({
  /** by-id identifier (API resource ID), shared with /v1/disks. */
  id: DiskId,
  /** Raw device size in bytes. */
  sizeBytes: z.number().int().nonnegative(),
  /**
   * Usable size in bytes AFTER the §2.5 replacement-slack rounding (floored to
   * the layout granularity). All band math runs on this, never on sizeBytes,
   * so a nominally-same replacement disk always fits.
   */
  usableBytes: z.number().int().nonnegative(),
  /** Disk model string. */
  model: z.string().nullable(),
  /** Serial number. */
  serial: z.string().nullable(),
  /** Role in the pool. */
  role: AhrDiskRole,
  /** Band slices carved on this disk (unused top capacity has no slice). */
  partitions: z.array(AhrDiskPartition),
})
export type AhrDisk = z.infer<typeof AhrDisk>

/** One member of a band array. */
export const AhrArrayMember = z.object({
  /** Disk by-id the member partition lives on. */
  disk: DiskId,
  /** Member partition device path. */
  partition: DevicePath,
  /** mdadm member state. */
  memberState: AhrMemberState,
})
export type AhrArrayMember = z.infer<typeof AhrArrayMember>

/** Progress of a running sync/reshape/recover/check on one array. */
export const AhrArraySync = z.object({
  action: AhrSyncAction,
  /** Percent complete (0–100). */
  percent: z.number().min(0).max(100),
  /** Current throughput in bytes/second. */
  speedBytesSec: z.number().nonnegative(),
  /** Estimated seconds remaining. */
  etaSeconds: z.number().nonnegative(),
})
export type AhrArraySync = z.infer<typeof AhrArraySync>

/**
 * One band array (one mdadm array per band). Arrays are named deterministically
 * `md/<pool>-r<band>` and are never renumbered, shrunk, or re-sliced — band
 * indices strictly append across the pool's life (§2.6 naming invariant).
 */
export const AhrArray = z.object({
  /** md device path, e.g. "/dev/md/tank-r1". */
  device: DevicePath,
  /** Band index (1-based, bottom-up, append-only). */
  band: z.number().int().positive(),
  level: ArrayLevel,
  /** Band height in bytes (per-member slice size). */
  heightBytes: z.number().int().nonnegative(),
  members: z.array(AhrArrayMember),
  state: ArrayState,
  /** Present while a sync thread runs on this array. */
  sync: AhrArraySync.optional(),
})
export type AhrArray = z.infer<typeof AhrArray>

/**
 * The labeled capacity breakdown the UI renders — never a bare number. The
 * fields partition the (rounded) raw capacity exactly:
 *
 *   rawBytes = usableBytes + redundancyOverheadBytes
 *            + unprotectedWastedBytes + pendingBytes
 *
 * All values are computed on §2.5-rounded disk sizes; real numbers will be
 * slightly lower still (md metadata + data-offset overhead — ground-truth
 * stage captures the constants).
 */
export const AhrCapacity = z.object({
  /** Sum of all member disks' rounded usable bytes. */
  rawBytes: z.number().int().nonnegative(),
  /** Bytes available to the filesystem. */
  usableBytes: z.number().int().nonnegative(),
  /** Bytes in use on the filesystem. */
  usedBytes: z.number().int().nonnegative(),
  /** Bytes free on the filesystem. */
  freeBytes: z.number().int().nonnegative(),
  /** Bytes spent on md parity/mirror redundancy in protected bands. */
  redundancyOverheadBytes: z.number().int().nonnegative(),
  /**
   * Capacity in band slices that cannot be protected with the current disks
   * (§2.4 wasted top slice, or capacity stranded between immovable existing
   * boundaries). Labeled, never silently dropped.
   */
  unprotectedWastedBytes: z.number().int().nonnegative(),
  /**
   * Capacity physically present but not yet usable because too few disks cross
   * a boundary — the §5.2 "unlock" state after an expansion. Zero outside
   * expansion contexts.
   */
  pendingBytes: z.number().int().nonnegative(),
})
export type AhrCapacity = z.infer<typeof AhrCapacity>

/** An AHR pool (GET /v1/ahr/:name — the full §3 structure). */
export const AhrPool = z.object({
  /** Pool name — also the VG name and the md-name prefix. */
  name: PoolName,
  ahrType: AhrType,
  /** Pool-scoped mountpoint of the btrfs filesystem (never /mnt/pve). */
  mountpoint: AbsolutePath,
  disks: z.array(AhrDisk),
  arrays: z.array(AhrArray),
  /** The one VG per pool (PVs are the md devices in band order). */
  vg: z.object({
    name: PoolName,
    sizeBytes: z.number().int().nonnegative(),
    freeBytes: z.number().int().nonnegative(),
  }),
  /** The one LV (`<pool>-vol`) carrying the btrfs filesystem. */
  lv: z.object({
    name: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }),
  capacity: AhrCapacity,
  state: AhrPoolState,
  /** Operator advisories (unlock hints, degraded-band guidance, …). */
  advisories: z.array(z.string()),
})
export type AhrPool = z.infer<typeof AhrPool>

// ---- Layout preview (dry-run, no mutation) ---------------------------------

/** One band row of a layout preview. */
export const AhrPreviewBand = z.object({
  /** Band index (1-based, bottom-up). */
  band: z.number().int().positive(),
  /** The band's byte range [startBytes, endBytes) on every member disk. */
  range: z.object({
    startBytes: z.number().int().nonnegative(),
    endBytes: z.number().int().nonnegative(),
  }),
  /** Disks tall enough to participate in this band. */
  memberCount: z.number().int().nonnegative(),
  /** Array level, or null when the band is unusable (too few members). */
  level: ArrayLevel.nullable(),
  /** Band height in bytes (endBytes − startBytes). */
  heightBytes: z.number().int().nonnegative(),
  /** Usable bytes this band contributes (0 when unprotected). */
  usableBytes: z.number().int().nonnegative(),
  /** Whether the band forms a redundant array. */
  protected: z.boolean(),
})
export type AhrPreviewBand = z.infer<typeof AhrPreviewBand>

/**
 * Dry-run layout for a disk selection + tier (POST /v1/ahr/layout/preview and
 * the composer's live feedback) — NO mutation.
 */
export const AhrLayoutPreview = z.object({
  bands: z.array(AhrPreviewBand),
  capacity: AhrCapacity,
  /** Human-readable advisories (wasted-slice label, unlock hints, min-disk). */
  warnings: z.array(z.string()),
  /** Whether the selection meets the tier's minimum disk count (2 / 4). */
  minDisksMet: z.boolean(),
})
export type AhrLayoutPreview = z.infer<typeof AhrLayoutPreview>

// ---- Expansion -------------------------------------------------------------

/** What kicked off an expansion. */
export const AhrExpansionTrigger = z.enum(['add-disk', 'replace-disk'])
export type AhrExpansionTrigger = z.infer<typeof AhrExpansionTrigger>

/** Lifecycle of an expansion intent. */
export const AhrExpansionState = z.enum(['running', 'halted', 'done', 'abandoned'])
export type AhrExpansionState = z.infer<typeof AhrExpansionState>

/**
 * The ONLY persisted expansion state (§5.3): the disk set the operator
 * approved, nothing more. Steps are never persisted — the planner recomputes
 * the reachable target from (existing bands + approvedDisks) on every run and
 * resume. A missing disk is NEVER treated as intent to shrink; only an intent
 * naming `replacedDisk` may substitute a member.
 */
export const AhrExpansionIntent = z.object({
  id: UUID,
  trigger: AhrExpansionTrigger,
  /** The full post-expansion disk set the operator approved. */
  approvedDisks: z.array(DiskId),
  /** For replace-disk: the outgoing member (its replacement is in approvedDisks). */
  replacedDisk: DiskId.optional(),
  /** Capacity before the expansion (for the before → after presentation). */
  before: AhrCapacity,
  /** Reachable capacity after the expansion (never fresh-ideal capacity). */
  after: AhrCapacity,
  state: AhrExpansionState,
})
export type AhrExpansionIntent = z.infer<typeof AhrExpansionIntent>

/**
 * Step kinds, in §5.1 pipeline order: partition first, one md mutation per
 * band each followed by reshape-wait, then a single pv/vg/lv/fs tail — the
 * filesystem is only ever grown LAST, after the block device beneath it.
 * `array-convert` is the RAID1→RAID5 level-change reshape (§2.3) — a distinct
 * mdadm operation with its own failure modes, not an `array-grow`.
 */
export const AhrExpansionStepKind = z.enum([
  'partition',
  'array-create',
  'array-grow',
  'array-convert',
  'reshape-wait',
  'pv-create',
  'pv-resize',
  'vg-extend',
  'lv-extend',
  'fs-grow',
])
export type AhrExpansionStepKind = z.infer<typeof AhrExpansionStepKind>

/** Execution status of one step. */
export const AhrStepStatus = z.enum(['pending', 'running', 'done', 'failed'])
export type AhrStepStatus = z.infer<typeof AhrStepStatus>

/**
 * One step of an expansion plan — derived, never persisted (§5.3): recomputed
 * by the planner on every run/resume, and each step detects current state so a
 * re-run is a no-op for completed work.
 */
export const AhrExpansionStep = z.object({
  /** Position in the ordered plan (0-based). */
  index: z.number().int().nonnegative(),
  kind: AhrExpansionStepKind,
  /**
   * What the step acts on: a disk by-id for `partition`, the md name
   * (`md/<pool>-r<band>`) for array/pv steps, the VG/LV name for the tail.
   */
  target: z.string().min(1),
  status: AhrStepStatus,
  /** Human-readable specifics, e.g. "raid1×2 → raid5×3". */
  detail: z.string().optional(),
})
export type AhrExpansionStep = z.infer<typeof AhrExpansionStep>
