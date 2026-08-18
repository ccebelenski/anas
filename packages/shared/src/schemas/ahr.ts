import { z } from 'zod'
import { AbsolutePath, DevicePath, DiskId, PoolName, UUID } from './common.js'

/**
 * AHR — ANAS Hybrid RAID wire shapes for /v1/ahr (Epic 11, AHR-DESIGN §3).
 *
 * SHR-style hybrid RAID over a fully open stack:
 *
 *   disks → GPT partitions (size-matched band slices)
 *         → one mdadm array per band  (redundancy lives HERE)
 *         → LVM: all arrays concatenated into one VG → one LV
 *         → btrfs on the single LV
 *
 * btrfs is the only filesystem — stated, not chosen: deliberately NO
 * filesystem field anywhere here, and btrfs-native RAID is never used
 * (redundancy is md's job, always). Planner computation lives in the daemon
 * (services/ahr-layout.ts).
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
 *
 * `inactive` is the band-level counterpart of the pool's `offline`: the md array
 * exists but CANNOT START (mdstat's `inactive` — "active, FAILED, Not Started",
 * the GT-8 all-spares assembly), so it serves nothing and takes its PV out of
 * the VG with it. It is read straight off mdstat's array header, never inferred
 * — the same single piece of evidence that carries the pool's `offline` verdict,
 * reported at the level it was observed.
 *
 * It used to report `degraded`: issue #18 shipped the pool state and left the
 * band alone as "no schema widening for a tone". The follow-up look found it is
 * not a tone. On the pve5 post-lockup shape r1 was genuinely active and degraded
 * while r2 and r3 could not start at all, and one amber word for both hid the
 * fact that matters most for recovery — WHICH bands failed to assemble. A band
 * that cannot start is a different fact from a band down a member, and the
 * daemon has always known which is which.
 */
export const ArrayState = z.enum([
  'clean',
  'degraded',
  'resyncing',
  'reshaping',
  'recovering',
  'inactive',
  'failed',
])
export type ArrayState = z.infer<typeof ArrayState>

/**
 * Whole-pool state, fused across md + LVM + btrfs. `AhrPoolState`, not the
 * design's `PoolState` — zfs.ts already exports one.
 *
 * `building` is the first-build state: EVERY band is syncing or queued and no
 * band has a faulty or absent member — a brand-new pool laying down redundancy
 * for the first time, or one rebuilding all of it with nothing failed. It is
 * activity, not fault, and is deliberately distinct from `rebuilding` (which
 * carries the "some redundancy is being restored" connotation) and from
 * `degraded`. A mixed-media pool spends its first hours-to-days here because md
 * serializes band syncs, so this state must NOT read as a failure (issue #7).
 *
 * `offline` is TOTAL UNAVAILABILITY, and it is deliberately NOT `degraded`: at
 * least one band md array cannot start (inactive / "FAILED, Not Started"), or
 * the pool's LV is not active — either way the concatenated volume is missing a
 * piece, the filesystem cannot be mounted, and NO data can be read. `degraded`
 * means reduced redundancy while still serving; a pool that serves nothing must
 * not wear the same badge. It therefore OUTRANKS degraded/building/rebuilding/
 * expanding/scrubbing/readonly in the fusion, and only `failed` (the LVM layer
 * missing outright) ranks above it (issue #18: after a node lockup a pool with
 * one band degraded and two bands not started reported `degraded`, which reads
 * as reduced-redundancy-but-functioning while the volume was in fact offline).
 */
export const AhrPoolState = z.enum([
  'healthy',
  'building',
  'degraded',
  'expanding',
  'rebuilding',
  'scrubbing',
  'offline',
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
  /**
   * Transient kernel device name (e.g. "md127") at read time. Convenience for
   * consumers that must correlate with /proc/mdstat — NEVER persist or key on
   * it (GT-2: kernel names reshuffle across operations and reboots).
   */
  kernelName: z.string().optional(),
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
  /**
   * For replace-disk: the incoming disk (also in approvedDisks). Persisted as
   * a pair with `replacedDisk` — resume recomputes the plan from this intent,
   * and the §2.3 planner needs the declared {old, new} PAIR to know which
   * approved disk substitutes the old member.
   */
  replacementDisk: DiskId.optional(),
  /** Capacity before the expansion (for the before → after presentation). */
  before: AhrCapacity,
  /** Reachable capacity after the expansion (never fresh-ideal capacity). */
  after: AhrCapacity,
  state: AhrExpansionState,
})
export type AhrExpansionIntent = z.infer<typeof AhrExpansionIntent>

/** An AHR pool (GET /v1/ahr/:name — the full §3 structure). */
export const AhrPool = z.object({
  /** Pool name — also the VG name and the md-name prefix. */
  name: PoolName,
  ahrType: AhrType,
  /**
   * Pool-scoped mountpoint of the btrfs filesystem (never /mnt/pve). When
   * `mounted` is false this carries the LV device path instead — always check
   * `mounted` before treating it as a directory.
   */
  mountpoint: AbsolutePath,
  /** Whether the filesystem is currently mounted. */
  mounted: z.boolean(),
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
  /**
   * Whether the pool carries the btrfs subvolume layout (§12): `@data`
   * (mounted at the mountpoint via `subvol=@data`) + `@snapshots` (outside the
   * mounted tree). `true` unlocks the snapshot verbs. Pools created before the
   * §12 design report `false` — a flat single-tree filesystem where snapshots
   * are unavailable; there is NO migration verb (destroy/recreate is the
   * migration). Read live from the mount's `subvol=` option — the system is the
   * source of truth (§5.3); an unmounted pool cannot advertise the layout and
   * reports `false`.
   */
  subvolLayout: z.boolean(),
  /** Operator advisories (unlock hints, degraded-band guidance, …). */
  advisories: z.array(z.string()),
  /**
   * The live expansion intent when one exists (§6.2): 'running' → show the
   * job's progress; 'halted' → surface Resume/Abandon loudly. Absent when no
   * expansion is in flight.
   */
  expansion: AhrExpansionIntent.optional(),
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

/**
 * POST /v1/ahr/layout/preview request: a disk selection + tier for the §2.1
 * dry-run. Disks are /v1/disks by-id identifiers; only disks whose inventory
 * status is 'available' are eligible (the daemon rejects anything in use,
 * foreign-labeled, or system — GT-12 made those exclusions safety-critical).
 */
export const AhrLayoutPreviewRequest = z.object({
  disks: z.array(DiskId).min(1),
  tier: AhrType,
})
export type AhrLayoutPreviewRequest = z.infer<typeof AhrLayoutPreviewRequest>

// ---- Create ----------------------------------------------------------------

/**
 * POST /v1/ahr request: create a pool from a disk selection + tier — WIPES
 * every listed disk (confirm-gated; the 409 warnings name each one). Disks are
 * /v1/disks by-id identifiers and must be status 'available' (GT-12: the
 * in-use/foreign-label exclusions are safety-critical). The tier is chosen
 * here forever — there is no AHR-1 → AHR-2 conversion.
 */
export const AhrCreateRequest = z.object({
  name: PoolName,
  tier: AhrType,
  disks: z.array(DiskId).min(1),
  /**
   * Optional mountpoint override; defaults to the pool-scoped
   * `/mnt/anas-ahr/<name>`. Never under /mnt/pve (§2.6 — PVE owns that
   * namespace); the route also refuses paths already mounted or claimed in
   * fstab.
   */
  mountpoint: AbsolutePath.optional(),
})
export type AhrCreateRequest = z.infer<typeof AhrCreateRequest>

/**
 * PUT /v1/ahr/:name/mountpoint — change where the pool mounts (the only
 * mutable pool identity; name/tier/arrays are fixed at creation). Same
 * constraints as the create-time override.
 */
export const AhrMountpointRequest = z.object({
  mountpoint: AbsolutePath,
})
export type AhrMountpointRequest = z.infer<typeof AhrMountpointRequest>

// ---- Expansion -------------------------------------------------------------

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

/** A declared disk substitution — the ONLY way a member may leave a pool. */
export const AhrReplacePair = z.object({
  /** The outgoing member disk (must currently serve at least one band). */
  oldDiskId: DiskId,
  /** The incoming disk (must be 'available' in the inventory). */
  newDiskId: DiskId,
})
export type AhrReplacePair = z.infer<typeof AhrReplacePair>

/**
 * POST /v1/ahr/:name/expand/plan and POST /v1/ahr/:name/expand request body:
 * grow the pool by adding disks, by a declared replacement, or both. At least
 * one of the two must be present — an empty request plans nothing.
 */
export const AhrExpandRequest = z.object({
  /** Disks to ADD to the pool (inventory status 'available' required). */
  addDisks: z.array(DiskId).optional(),
  /** A declared old → new substitution (§2.3: replace is never inferred). */
  replace: AhrReplacePair.optional(),
}).refine(
  r => (r.addDisks !== undefined && r.addDisks.length > 0) || r.replace !== undefined,
  'Provide addDisks and/or replace — an empty expansion request plans nothing',
)
export type AhrExpandRequest = z.infer<typeof AhrExpandRequest>

/**
 * POST /v1/ahr/:name/disk/:oldId/replace request body — the guided replace.
 * The outgoing disk is the URL parameter; the body names its substitute.
 */
export const AhrReplaceRequest = z.object({
  newDiskId: DiskId,
})
export type AhrReplaceRequest = z.infer<typeof AhrReplaceRequest>

// ---- Hot spares (story 11.11, §11) ------------------------------------------

/**
 * POST /v1/ahr/:name/spare request body — attach a pool-level hot spare
 * (confirm-gated: the disk is WIPED). A spare must cover EVERY band — its
 * §2.5-rounded usable size must reach the pool's top array boundary; a partial
 * spare is refused with the exact shortfall (§11: a spare that can't absorb
 * every failure is a false promise). Removal is DELETE /v1/ahr/:name/spare/:id
 * (confirm-gated — protection headroom drops), no body.
 */
export const AhrSpareRequest = z.object({
  diskId: DiskId,
})
export type AhrSpareRequest = z.infer<typeof AhrSpareRequest>

// ---- Snapshots (story 11.12, §12) -------------------------------------------

/**
 * A btrfs snapshot name — the label after `@snapshots/`. Charset-safe so it is
 * always a single, injection-proof path segment: starts alphanumeric, then
 * alphanumerics plus the safe punctuation `. _ - :` (a superset of the default
 * UTC-timestamp name and the auto `pre-rollback-<ts>` preserve name). No `/`
 * (never a nested path), no `@` (never addresses another subvolume), no `..`
 * (no traversal), no leading `-` (no option injection into `btrfs`).
 */
export const AhrSnapshotName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][\w.:-]*$/i, 'Must start alphanumeric and contain only letters, digits, and . _ - :')
export type AhrSnapshotName = z.infer<typeof AhrSnapshotName>

/**
 * One btrfs snapshot under `@snapshots` (§12). Sizes are deliberately absent —
 * per-snapshot usage needs btrfs qgroups, OUT of v1: showing an unlabeled or
 * wrong number is worse than showing none.
 */
export const AhrSnapshot = z.object({
  /** The snapshot label (the segment after `@snapshots/`). */
  name: AhrSnapshotName,
  /**
   * Creation time (btrfs subvolume `otime`), ISO 8601 local (no timezone — the
   * value btrfs reports). Null when btrfs did not record an otime for the
   * subvolume (older subvolumes) — never fabricated.
   */
  createdAt: z.string().nullable(),
  /**
   * Whether the snapshot is read-only. Operator snapshots are created read-only
   * (`btrfs subvolume snapshot -r`); the auto `pre-rollback-<ts>` preserve of a
   * former `@data` is writable (`readonly: false`).
   */
  readonly: z.boolean(),
})
export type AhrSnapshot = z.infer<typeof AhrSnapshot>

/**
 * POST /v1/ahr/:name/snapshots request: take a read-only snapshot of `@data`
 * into `@snapshots/<name>`. `name` is optional — the daemon defaults it to a
 * UTC timestamp (charset-safe by construction). Refused when the pool is
 * flat-layout (`subvolLayout: false`), has an expansion intent, or is in a bad
 * state — consistent with the other AHR verbs' guards.
 */
export const AhrCreateSnapshotRequest = z.object({
  name: AhrSnapshotName.optional(),
})
export type AhrCreateSnapshotRequest = z.infer<typeof AhrCreateSnapshotRequest>
