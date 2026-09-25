import { z } from 'zod'
import { AbsolutePath, DevicePath, DiskId, PoolName, UUID } from './common.js'
import { IscsiHeldByLun } from './iscsi.js'

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

/**
 * A disk's role in the pool.
 *
 * `cache` is the lvmcache read-cache disk (§13): it carries ONE GPT slice that
 * is a PV of the pool VG, it is never an md member, and it holds no only-copy
 * of anything. It is listed here so the pool owns its whole disk set — the
 * /v1/disks inventory attributes the disk to this pool from exactly this role
 * (GT-22: before ahrcache.1 it read `other`, unattributed), and destroy's wipe
 * list sweeps it with the members.
 */
export const AhrDiskRole = z.enum(['member', 'spare', 'cache'])
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
  /**
   * BAND slices carved on this disk (unused top capacity has no slice). A
   * `cache` disk reports `[]` — its one slice backs no band, and describing it
   * as a band slice would be a lie the whole band-math stack reads. The cache
   * slice is reported once, in {@link AhrCache}, where its size belongs.
   */
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

// ---- Read cache (story ahrcache.1, §13) -------------------------------------

/**
 * The pool's read-cache health — read from `dmsetup status` on EVERY AHR read,
 * never from `lvs`.
 *
 * `lvs` keeps reporting the last counters it read after the cache device dies
 * (GT-23: stale, not absent), and a pool that cannot serve a single byte then
 * presents as a warm, healthy cache. `dmsetup status` answers with one token —
 * `cache Error` (GT-19) — and that is the only honest health signal there is.
 * `lvs` stays the source of truth for MODE and POLICY, which do not rot.
 *
 * `absent` means the pool LV is not a cache target: no cache was ever attached,
 * one was detached, or a failed one was uncached.
 *
 * `inactive` means the pool LV IS a cache target but is not active (lv_attr
 * field 5 is `-`), so device-mapper has no table to ask and the cache's health
 * cannot be read at all — typically a VG left partial by a band array that did
 * not assemble, with the cache device perfectly healthy. It is not a verdict on
 * the cache: `failed` needs evidence the CACHE is the problem (a failure word
 * from `dmsetup status`, or the cache PV's device gone), and an inactive volume
 * supplies neither. No recovery acts on it; the pool's own offline advisory
 * says why the volume is down. (An inactive volume whose cache PV IS missing
 * reads `failed` — LVM refuses to activate a partial cached LV, which is the
 * boot-time shape of a dead cache SSD.)
 */
export const AhrCacheState = z.enum(['healthy', 'failed', 'absent', 'inactive'])
export type AhrCacheState = z.infer<typeof AhrCacheState>

/**
 * The read cache in front of an AHR pool (§13, GitHub #63) — lvmcache in
 * **writethrough** mode over one GPT slice per cache disk, linear across them.
 *
 * Writethrough is the whole safety story and it is not configurable: every
 * write lands on the pool before it is acknowledged, so the cache never holds
 * the only copy of anything and `cache_dirty_blocks` is zero by construction.
 * Losing the cache device loses no data — it costs reads until the cache is
 * dropped. Writeback and `--type writecache` are not exposed (EPICS §2 ruling).
 *
 * The COUNTERS are present only while `state === 'healthy'`. They are omitted
 * outright on a failed or absent cache rather than reported as zeros or as the
 * last values `lvs` happens to remember — a stale number presented as live is
 * the failure GT-23 caught.
 */
export const AhrCache = z.object({
  /**
   * The cache disks by-id, in VG order. Empty when the cache device is GONE
   * (a failed cache whose PV reads `[unknown]`) — the id cannot be recovered
   * from a disk that is not there, and inventing one would be worse than
   * saying nothing.
   */
  devices: z.array(DiskId),
  /**
   * Flash dedicated to the cache, in bytes: the sum of the cache PVs' sizes.
   * Read from the PVs rather than from the cache LV because a PV reports its
   * size even when its device is missing, so the figure survives a failure.
   */
  sizeBytes: z.number().int().nonnegative(),
  /** Always `writethrough` — the only mode ANAS attaches (§13 ruling). */
  mode: z.literal('writethrough'),
  /**
   * dm-cache replacement policy as `lvs` reports it (the kernel default is
   * `smq`). Read, never chosen: ANAS passes no policy to `lvconvert`.
   * `dmsetup table` renders smq as `mq` — the kernel module registers under
   * both names — so `lvs` is the value to present.
   */
  policy: z.string(),
  state: AhrCacheState,
  /**
   * The cache PV's DEVICE is gone: a PV of the pool VG reads `[unknown]` in
   * `pvs` while every band is accounted for by its own named md PV, so the
   * nameless one can only be the cache's. Present (`true`) only then; omitted
   * otherwise. It always comes with `state: 'failed'` — a cache whose device is
   * gone fails the first read that reaches it, even while `dmsetup status`
   * still prints healthy counters on an idle pool — and it is what lets a
   * recovery say "missing" rather than "failed" about a device that is simply
   * not there.
   */
  deviceMissing: z.literal(true).optional(),
  /** Reads served from flash since the cache was attached. Healthy only. */
  hits: z.number().int().nonnegative().optional(),
  /** Reads that missed the cache. Healthy only. */
  misses: z.number().int().nonnegative().optional(),
  /** Cache blocks holding data. Healthy only. */
  usedBlocks: z.number().int().nonnegative().optional(),
  /** Cache blocks in total. Healthy only. */
  totalBlocks: z.number().int().nonnegative().optional(),
  /**
   * Dirty cache blocks. Zero by construction in writethrough — a non-zero
   * value is a bug, not a state the UI should normalize. Healthy only.
   */
  dirtyBlocks: z.number().int().nonnegative().optional(),
})
export type AhrCache = z.infer<typeof AhrCache>

/**
 * POST /v1/ahr/:name/cache request body — attach a read cache over the named
 * disks (one GPT slice each, linear across them).
 *
 * NOT confirm-gated: nothing that holds an only copy is destroyed. The disks
 * must be inventory-'available' (the shared composable-disk predicate), which
 * already means they carry no data ANAS can see. A ROTATING disk is legal —
 * the response advises once that it adds a seek rather than speed, and does
 * not argue further.
 */
export const AttachAhrCacheRequest = z.object({
  /**
   * One or more cache disks, each listed ONCE. A repeat is a 400 rather than a
   * silently-deduplicated list: the executor cuts one `<pool>-cache<n>` slice
   * per entry, so a duplicate would try to partition the same disk twice under
   * two ordinals — and the second cut lands on a disk the first already made a
   * live PV, which is the HELD-disk case GT-21 says does not publish.
   */
  disks: z.array(DiskId).min(1).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'the same cache disk is listed more than once' },
  ),
})
export type AttachAhrCacheRequest = z.infer<typeof AttachAhrCacheRequest>

/**
 * `POST /v1/ahr/:name/cache/event` request body — the udev hook reporting that
 * a disk carrying one of this pool's `<pool>-cache<n>` slices was REMOVED
 * (ahrcache.1 slice 2, AHR-DESIGN §13 "Resolved 2026-09-24").
 *
 * The endpoint is a REPORT, not a command: the daemon decides for itself,
 * from `dmsetup status`, whether the cache is actually failed and whether
 * there is any recovery to run. Everything in this body is context for the
 * journal and the notification — the body can never make the daemon uncache a
 * healthy pool, which is what keeps a local event script from being a lever.
 */
export const AhrCacheEventRequest = z.object({
  /**
   * What happened. One value today; the field exists so a later event kind is
   * an additive value rather than a second endpoint.
   */
  event: z.literal('device-removed'),
  /**
   * The GPT label of the slice that went away (`<pool>-cache<n>`), as udev
   * reports it in `ID_PART_ENTRY_NAME`. Used only to NAME the device in the
   * notification when the disk is gone and its by-id can no longer be
   * resolved — a disk that is not there cannot be asked what it was called,
   * and inventing an id would be worse than naming the slice.
   */
  slice: z.string().min(1).max(128).optional(),
  /** The kernel device name udev saw (`sdd1`) — journal context only. */
  kernel: z.string().min(1).max(64).optional(),
})
export type AhrCacheEventRequest = z.infer<typeof AhrCacheEventRequest>

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
  /**
   * The filesystem is mounted READ-ONLY (ahrcache.1 slice 2). btrfs forces
   * this on itself after an I/O error aborts a metadata transaction — the
   * aftermath of a cache device dying under a write (GT-19). The pool is still
   * readable; nothing can be written to it until it is remounted.
   *
   * This is a SEPARATE field from `state: 'readonly'` on purpose. `state` is a
   * fused verdict with a precedence ladder (`failed` and `offline` outrank
   * `readonly`), so a pool can be read-only AND report some other state — and
   * a UI that gated the Remount verb on the badge would hide the one verb that
   * fixes it. This answers the narrow question the verb asks, and nothing else.
   *
   * Optional for the version-skew ruling: a daemon that predates slice 2 omits
   * it, and a consumer that sees no field must read "this daemon cannot tell
   * me", never "the pool is writable".
   */
  mountedReadOnly: z.boolean().optional(),
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
  /**
   * The read cache (§13). Always present on a live read — `state: 'absent'`
   * with no devices when the pool has none. Optional in the SCHEMA for the
   * version-skew ruling: a daemon that predates ahrcache.1 omits it, and a
   * consumer that sees no field must read "this daemon cannot tell me", never
   * "there is no cache".
   */
  cache: AhrCache.optional(),
  /** Operator advisories (unlock hints, degraded-band guidance, …). */
  advisories: z.array(z.string()),
  /**
   * The live expansion intent when one exists (§6.2): 'running' → show the
   * job's progress; 'halted' → surface Resume/Abandon loudly. Absent when no
   * expansion is in flight.
   */
  expansion: AhrExpansionIntent.optional(),
  /**
   * An iSCSI LUN currently holds an image file on this pool (story `iscsi.6`).
   * A file on the btrfs volume IS the AHR block object, so Destroy, Unmount and
   * Change mount are refused while a LUN serves one. Present only when something
   * holds it; an older daemon omits it (version-skew ruling: no field ⇒ no
   * gating).
   */
  heldByLun: IscsiHeldByLun.optional(),
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

/**
 * The zero-gain detail of an expansion plan (ahrexpand.1, AHR-DESIGN §5.2):
 * present exactly when the plan's reachable target adds no usable capacity —
 * one disk replaced above a band boundary the planner cannot use yet, or a
 * disk set the planner cannot use. The numbers are derived from the plan,
 * never hard-coded.
 *
 * `unlockSize` is a BAND BOUNDARY — the top of the band that is still short of
 * members — because nothing between boundaries can help: they are immutable
 * (AHR-DESIGN §2.3). `unlockGain` is what reaching it delivers, modelled the
 * way the plan itself is shaped: a replace is unlocked by replacing another
 * member (the bay-limited §5.2 case — the band's member count never changes,
 * so only bands above the current top boundary form or grow), an addition by
 * adding another disk. `unlockGain` is 0 when no single boundary delivers
 * anything — a same-size replacement — and then `shortfall` says nothing about
 * unlocking rather than quoting a gain of nothing.
 */
export const AhrExpansionZeroGain = z.object({
  /** The operator-facing shortfall: what is locked, and what unlocks it. */
  shortfall: z.string().min(1),
  /** The band boundary in bytes the next disk must reach (see above). */
  unlockSize: z.number().int().nonnegative(),
  /** Usable bytes reaching `unlockSize` delivers — 0 when nothing does. */
  unlockGain: z.number().int().nonnegative(),
})
export type AhrExpansionZeroGain = z.infer<typeof AhrExpansionZeroGain>

/**
 * POST /v1/ahr/:name/expand/plan response — the before → after preview the
 * expansion wizard renders (NO mutation). `usableGain`/`zeroGain` are
 * additive: an older daemon omits them (version-skew ruling: no field ⇒ the
 * UI falls back to the before → after comparison), never to a different
 * meaning. `zeroGain` is present exactly when `usableGain` is 0.
 */
export const AhrExpansionPlanResponse = z.object({
  before: AhrCapacity,
  after: AhrCapacity,
  steps: z.array(AhrExpansionStep),
  warnings: z.array(z.string()),
  /** The resulting band layout (the wizard's before → after bars). */
  bands: z.array(AhrPreviewBand),
  /** Usable bytes this plan would actually add (0 when none — see `zeroGain`). */
  usableGain: z.number().int().nonnegative().optional(),
  /** Present exactly when `usableGain` is 0: the shortfall and the unlock. */
  zeroGain: AhrExpansionZeroGain.optional(),
})
export type AhrExpansionPlanResponse = z.infer<typeof AhrExpansionPlanResponse>

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

// ---- Scrub result (story selfheal.3, §4) ------------------------------------

/**
 * One 64 KiB btrfs stripe the kernel named in a scrub warning (GT-3).
 *
 * `logical` is the filesystem-logical bytenr the kernel printed; `offset` is
 * the byte offset WITHIN the file, which kernel 7.0 reports 64 KiB-aligned —
 * it names the stripe, not the failing 4 KiB block. `length` is the length the
 * kernel printed for the error (4096 on the drill), kept verbatim rather than
 * rounded up to the stripe it actually covers.
 */
export const AhrScrubStripe = z.object({
  logical: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
})
export type AhrScrubStripe = z.infer<typeof AhrScrubStripe>

/**
 * One corrupt file an AHR scrub attributed — the answer to "WHAT is corrupt",
 * which `Error summary: csum=2` never gives (story selfheal.3).
 *
 * `path` is the full path on the node: `<mountpoint>/<subvolume>/<kernel path>`.
 * The kernel prints a subvolume-relative path plus a numeric `root`, so the
 * subvolume id is resolved (`btrfs inspect-internal subvolid-resolve`) and the
 * resolved name kept in `subvolume` — null when it could not be resolved (the
 * subvolume was deleted since the scrub), in which case `path` is the raw
 * subvolume-relative one the kernel printed and `missing` is true.
 *
 * `badBlocks` are 4 KiB FILE block indexes (offset/4096), found by reading each
 * of the 16 blocks inside a named stripe with O_DIRECT — the kernel names the
 * stripe but not the block (GT-3), so the block is evidence ANAS gathered, not
 * something the kernel said. An empty array means no block inside the named
 * stripe read back with an error: the file was repaired, rewritten or removed
 * between the scrub and the probe — never assumed to be a lie about the stripe.
 * That reading holds for an UNCOMPRESSED finding. A compressed one says so with
 * `compressed`/`extentBlocks` (selfheal.8 — the kernel's `offset` is
 * extent-relative there, so the stripe the kernel names is not the range that
 * was probed), and one whose corrupt block could not be named at all says so
 * with `unidentified` instead of leaving an empty list that reads as "nothing
 * found".
 */
export const AhrScrubFinding = z.object({
  path: z.string(),
  /** The resolved subvolume (`@data`), or null when the id no longer resolves. */
  subvolume: z.string().nullable(),
  inode: z.number().int().nonnegative(),
  /** Every stripe the kernel named for this file, in the order it named them. */
  stripes: z.array(AhrScrubStripe),
  /** 4 KiB file block indexes that read back with an error. */
  badBlocks: z.array(z.number().int().nonnegative()),
  /**
   * The corrupt extent is COMPRESSED (selfheal.8). The kernel's scrub warning
   * then reports `offset` relative to the extent, not to the file, so the
   * stripe it names cannot be probed directly: the extent's real file range is
   * resolved from its EXTENT_DATA item and THAT range is probed — one bad
   * on-disk sector of a compressed blob makes every block of the logical extent
   * read back EIO (GT-9b), so the failing blocks are the whole extent.
   */
  compressed: z.boolean().optional(),
  /**
   * The corrupt extent's file block range: `first` is its first 4 KiB file
   * block, `count` its length in 4 KiB blocks. Repair is handed `first` — the
   * engine repairs a compressed blob when given any block of the extent.
   */
  extentBlocks: z.object({
    first: z.number().int().nonnegative(),
    count: z.number().int().positive(),
  }).optional(),
  /**
   * The corruption is real (the kernel named this file) but no bad block could
   * be named: the extent covering the error could not be resolved, or nothing
   * in the resolved range read back with an error. An empty `badBlocks` alone
   * would read as "repaired, rewritten or removed" — which is a reading that
   * only holds when the probe knew where to look.
   */
  unidentified: z.boolean().optional(),
  /**
   * Why the block could not be named — the operator's reason, verbatim.
   *
   * Present WITH a non-empty `badBlocks` too: the blocks named are real, and
   * the reason says why the rest of the file's stripes named none.
   */
  reason: z.string().optional(),
  /**
   * At least one stripe of this file was probed WITHOUT the mapping — at the
   * offset the kernel printed, because the btrfs-tree chain could not be
   * followed (selfheal.5's helper unavailable, or a per-stripe resolve error).
   *
   * The blocks in `badBlocks` are still real (an EIO at a file offset is an
   * EIO), but the SEARCH WINDOW is unverified: for a compressed extent the
   * kernel's offset names the wrong 64 KiB, so bad blocks outside it would not
   * have been found. Additive and optional — a daemon that knew nothing of it
   * simply omits it. The UI shows the blocks AND says the window could not be
   * verified (with `reason`), so a repair of those blocks is not read as a
   * repair of the whole file.
   */
  probedUnverified: z.boolean().optional(),
  /**
   * The path does not exist any more (deleted between the scrub and the probe,
   * or an unresolvable subvolume). The finding is still reported — the kernel
   * saw the error — but no blocks were probed.
   */
  missing: z.boolean().optional(),
  /**
   * The file is OUTSIDE the pool's mounted tree. A scrub covers the whole
   * filesystem, and an AHR pool in the §12 layout mounts `@data` while
   * `@snapshots` sits beside it — so a corrupt block in a snapshot is a real,
   * expected finding with no path under the mountpoint. `path` is then
   * filesystem-relative (`@snapshots/<name>/…`) and nothing was probed: it is
   * reachable only through a top-level mount the scrub job does not take.
   * Distinct from `missing`, which means the file is gone.
   */
  outsideMount: z.boolean().optional(),
})
export type AhrScrubFinding = z.infer<typeof AhrScrubFinding>

/**
 * One band's phase-1 parity verdict, carried into the result (design review
 * 2026-09-14, D1): `mismatch_cnt > 0` on a band whose phase 2 finds nothing is
 * the PARITY-ONLY ROT case, and the per-band verdict phase 1 already computes
 * must survive into the result — otherwise the "phase 2 will name the files"
 * promise dies silently when phase 2 has nothing to name.
 *
 * `band` is the band label the scrub uses everywhere else
 * (`<pool>-r<band>`); `array` is the md device the check ran on; `mismatchCnt`
 * is the counter as md finalized it.
 *
 * `bandIndex` is the SAME band as a number — what `POST /ahr/:name/
 * parity-rewrite` names in its body (selfheal.10) and what the rewrite's
 * evidence gate matches on. It is carried rather than parsed back out of the
 * label: the scrub has the index in hand when it writes the row, and a
 * consumer digging it out of `<pool>-r<n>` with a regex would be a second,
 * breakable definition of the same fact.
 */
export const AhrScrubParityMismatch = z.object({
  band: z.string().min(1),
  bandIndex: z.number().int().positive(),
  array: z.string().min(1),
  mismatchCnt: z.number().int().nonnegative(),
  /**
   * The band's md level (sixth pass). ADDITIVE and optional — a result from an
   * older daemon omits it, and a consumer that cannot tell which level a band
   * is must not offer Rewrite parity for it.
   *
   * It is here because `mismatch_cnt` means two different things. On RAID5/6 a
   * mismatching stripe is parity that disagrees with the data, and the
   * data-intact case has a verb (selfheal.10). On RAID1 md counts legs that
   * disagree with each other and `repair` copies the FIRST in-sync leg over the
   * rest — a coin flip that overwrites the good copy half the time. A mirror
   * mismatch is arbitrated per block by Repair from parity, never by md repair.
   */
  level: ArrayLevel.optional(),
})
export type AhrScrubParityMismatch = z.infer<typeof AhrScrubParityMismatch>

/**
 * A band this scrub did NOT check (design review 2026-09-14, D8). `band` is
 * the same label form as {@link AhrScrubParityMismatch.band}; `reason` is the
 * operator-facing why, verbatim from the phase-1 walk.
 */
export const AhrScrubSkippedBand = z.object({
  band: z.string().min(1),
  reason: z.string().min(1),
})
export type AhrScrubSkippedBand = z.infer<typeof AhrScrubSkippedBand>

/**
 * Metadata (DUP) copies btrfs corrected from their mirror during one window
 * (story selfheal.12, GT-20).
 *
 * The kernel logs one `read error corrected` line per metadata read it could
 * not checksum and served from the mirror copy instead — and a RW mount or a
 * read repairs the rotten copy as a side effect, so `btrfs scrub` reports
 * nothing. The line is the only durable evidence that a member is returning
 * bad metadata, so the scrub and the repair both count it in the journal
 * window they already read. `devices` are the member paths the corrected reads
 * were served from — the disks whose SMART data to check.
 */
export const AhrMetadataCorrected = z.object({
  /** Corrected metadata reads seen in the window, one per kernel line. */
  count: z.number().int().nonnegative(),
  /** The member devices the corrected reads were served from, first-seen order. */
  devices: z.array(z.string().min(1)),
})
export type AhrMetadataCorrected = z.infer<typeof AhrMetadataCorrected>

/**
 * The result of an AHR scrub job (POST /v1/ahr/:name/scrub).
 *
 * Everything past `checkedArrays` is story selfheal.3 and OPTIONAL: a result
 * from an older daemon (or a clean scrub, which attributes nothing) parses
 * unchanged, and the UI renders the verdict it always rendered.
 *
 * The honesty pair is `errorsReported` vs `errorsAttributed`. The kernel's
 * scrub warnings are rate-limited, so under many errors the journal carries
 * FEWER lines than the scrub's own `Error summary` counted. ANAS reports both
 * numbers rather than presenting the attributed list as the whole story.
 */
export const AhrScrubResult = z.object({
  scrubbed: PoolName,
  /** btrfs `Error summary:` line when errors were found, else null (raw, verbatim). */
  btrfsErrors: z.string().nullable(),
  /**
   * How many bands the scrub ACTUALLY checked (design review 2026-09-14, D8)
   * — never the pool's array count, which a band md never started, took
   * another sync op on, or froze under makes a lie. What was skipped is said
   * in `bandsSkipped`; `checkedArrays + bandsSkipped.length` is the pool's
   * array count.
   */
  checkedArrays: z.number().int().nonnegative(),
  /**
   * The bands whose phase-1 check ran and delivered a verdict (D8). Present
   * on every result from a daemon that records it; absent from an older one.
   */
  bandsChecked: z.array(z.string()).optional(),
  /**
   * The bands NOT checked, each with its why (D8) — md never started the
   * check, took a resync/recover/reshape instead, froze, hit the wait
   * ceiling, or its device would not resolve. A non-empty list rides the
   * scrub notification and the Scrubs row: a check that silently skipped a
   * band reads as coverage it does not have.
   */
  bandsSkipped: z.array(AhrScrubSkippedBand).optional(),
  /**
   * The phase-1 parity verdicts that counted mismatches (D1). When phase 2
   * attributes NO corrupt file against these, the rot is PARITY-ONLY: data
   * passed every checksum, the parity (or Q) member is what disagrees, and
   * nothing in ANAS repairs it — the second notification and the Scrubs
   * indicator say so. Absent from an older daemon.
   */
  parityMismatches: z.array(AhrScrubParityMismatch).optional(),
  /** The corrupt files, grouped per file, capped at the first 200 (see `truncated`). */
  findings: z.array(AhrScrubFinding).optional(),
  /** Total errors the btrfs scrub summary counted (the sum of its `key=N` counters). */
  errorsReported: z.number().int().nonnegative().optional(),
  /** Kernel warnings that named a path — what the findings above are built from. */
  errorsAttributed: z.number().int().nonnegative().optional(),
  /**
   * Kernel scrub errors with NO path: read/IO errors, super-block errors, and
   * metadata whose owner the kernel could not name. Counted, never attributed;
   * the raw evidence stays in `btrfsErrors`.
   */
  unattributed: z.number().int().nonnegative().optional(),
  /** True when more files were attributed than the 200 the list carries. */
  truncated: z.boolean().optional(),
  /**
   * Metadata (DUP) copies btrfs corrected from their mirror during this
   * scrub's journal window (selfheal.12, GT-20). Optional and additive — a
   * result from an older daemon omits it, and a window that read nothing
   * simply leaves it off.
   */
  metadataCorrected: AhrMetadataCorrected.optional(),
})
export type AhrScrubResult = z.infer<typeof AhrScrubResult>
