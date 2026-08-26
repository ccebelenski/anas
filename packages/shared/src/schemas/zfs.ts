import { z } from 'zod'
import { AbsolutePath, DevicePath, ISODateTime, PoolName } from './common.js'
import { IscsiHeldByLun } from './iscsi.js'

// --- Enums ---

/** ZFS pool-level states */
export const PoolState = z.enum([
  'ONLINE',
  'DEGRADED',
  'FAULTED',
  'OFFLINE',
  'REMOVED',
  'UNAVAIL',
  'SUSPENDED',
])
export type PoolState = z.infer<typeof PoolState>

/** Vdev/disk states (pools suspend, vdevs don't) */
export const VdevState = z.enum([
  'ONLINE',
  'DEGRADED',
  'FAULTED',
  'OFFLINE',
  'REMOVED',
  'UNAVAIL',
  'AVAIL',
  'INUSE',
])
export type VdevState = z.infer<typeof VdevState>

/** ZFS vdev topology types */
export const VdevType = z.enum([
  'disk',
  'mirror',
  'raidz',
  'raidz2',
  'raidz3',
  'draid',
  'draid2',
  'draid3',
  'replacing',
  'spare',
])
export type VdevType = z.infer<typeof VdevType>

/** Vdev role — our concept, not ZFS's. ZFS uses position, we're explicit. */
export const VdevRole = z.enum([
  'data',
  'log',
  'cache',
  'spare',
  'special',
  'dedup',
])
export type VdevRole = z.infer<typeof VdevRole>

/** Scan operation type */
export const ScanFunction = z.enum(['SCRUB', 'RESILVER'])
export type ScanFunction = z.infer<typeof ScanFunction>

/** Scan operation state */
export const ScanState = z.enum(['SCANNING', 'FINISHED', 'CANCELED', 'NONE'])
export type ScanState = z.infer<typeof ScanState>

// --- Read models (API responses) ---

/** A leaf disk within a pool's vdev topology */
export const PoolDisk = z.object({
  /** by-id identifier, e.g. "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1" */
  id: z.string(),
  /** Full device path, e.g. "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1-part1" */
  path: DevicePath,
  state: VdevState,
  readErrors: z.number().int().nonnegative(),
  writeErrors: z.number().int().nonnegative(),
  checksumErrors: z.number().int().nonnegative(),
  slowIos: z.number().int().nonnegative(),
})
export type PoolDisk = z.infer<typeof PoolDisk>

/** A vdev (mirror, raidz, etc.) containing one or more disks */
export const Vdev = z.object({
  /** ZFS vdev name, e.g. "mirror-0", "raidz1-0" */
  name: z.string(),
  type: VdevType,
  state: VdevState,
  /** Allocated space in bytes */
  allocated: z.number().nonnegative().optional(),
  /** Total usable space in bytes */
  size: z.number().nonnegative().optional(),
  readErrors: z.number().int().nonnegative(),
  writeErrors: z.number().int().nonnegative(),
  checksumErrors: z.number().int().nonnegative(),
  /** Leaf disks in this vdev */
  disks: z.array(PoolDisk),
})
export type Vdev = z.infer<typeof Vdev>

/** Vdevs grouped by role — data, log, cache, spare, special, dedup */
export const VdevGroup = z.object({
  role: VdevRole,
  vdevs: z.array(Vdev),
})
export type VdevGroup = z.infer<typeof VdevGroup>

/** Scan (scrub or resilver) status */
export const ScanStatus = z.object({
  function: ScanFunction,
  state: ScanState,
  startedAt: ISODateTime,
  /** null if scan is still in progress */
  finishedAt: ISODateTime.nullable(),
  /** Total bytes to examine */
  totalBytes: z.number().nonnegative(),
  /** Bytes examined so far */
  examinedBytes: z.number().nonnegative(),
  /** Bytes processed (repaired) */
  processedBytes: z.number().nonnegative(),
  /** Errors found during scan */
  errors: z.number().int().nonnegative(),
  /** Progress 0–100, derived from examined/total */
  percentComplete: z.number().min(0).max(100),
})
export type ScanStatus = z.infer<typeof ScanStatus>

/** Health message shown when a pool is not ONLINE */
export const PoolHealthMessage = z.object({
  /** ZFS message ID, e.g. "ZFS-8000-HC" */
  msgId: z.string().optional(),
  /** Human-readable status description */
  status: z.string(),
  /** Recommended action */
  action: z.string(),
  /** URL for more info */
  moreInfo: z.string().url().optional(),
})
export type PoolHealthMessage = z.infer<typeof PoolHealthMessage>

export const PveStorageRef = z.object({
  /** PVE storage id, e.g. 'local-zfs' or 'datapool'. */
  storage: z.string(),
  /** PVE storage type that references the pool. */
  type: z.enum(['zfspool', 'dir', 'zfs']),
  /** The pool/dataset the storage points at (zfspool `pool` line), if any. */
  dataset: z.string().optional(),
  /** PVE content types this storage serves (images, rootdir, backup, iso, …). */
  content: z.array(z.string()),
})
export type PveStorageRef = z.infer<typeof PveStorageRef>

/** Pool summary for list views (GET /v1/pools) */
export const PoolSummary = z.object({
  name: PoolName,
  state: PoolState,
  /** Total pool size in bytes */
  size: z.number().nonnegative(),
  /** Allocated space in bytes */
  allocated: z.number().nonnegative(),
  /** Free space in bytes */
  free: z.number().nonnegative(),
  /** Fragmentation percentage 0–100 */
  fragmentation: z.number().min(0).max(100),
  /** Capacity percentage 0–100 */
  capacity: z.number().min(0).max(100),
  /** Dedup ratio as a float (1.0 = no dedup) */
  dedupRatio: z.number().nonnegative(),
  /** Whether a scan (scrub/resilver) is currently running */
  scanRunning: z.boolean(),
  /**
   * Scan operation type — present ONLY while a scan runs. Lets the UI offer
   *  "Stop Scrub" for a SCRUB but not a RESILVER (a resilver cannot be stopped).
   */
  scanFunction: ScanFunction.optional(),
  /** Any member device of the pool supports discard (TRIM). Gates the Trim action. */
  trimSupported: z.boolean().default(false),
  /**
   * The pool has supported-but-disabled features (a `zpool upgrade` would enable
   *  them). Gates the Upgrade action.
   */
  upgradeAvailable: z.boolean().default(false),
  /** Health message, present only when pool is not ONLINE */
  health: PoolHealthMessage.optional(),
  /**
   * The pool ROOT dataset's mountpoint (story 3.27) — a filesystem path, or the
   * literal `legacy`/`none`/`-` when the root is not mounted at a directory.
   * Read from `zfs get mountpoint <pool>`; absent on old daemons that predate
   * the Mount column (the UI then renders nothing). Mirrors AHR's `mountpoint`.
   */
  mountpoint: z.string().optional(),
  /**
   * Whether the pool root dataset is currently mounted. Mirrors AHR's `mounted`;
   *  drives the "(not mounted)" presentation in the pool grid's Mount column.
   */
  mounted: z.boolean().optional(),
  /**
   * PVE storages referencing this pool (read-only, from /etc/pve/storage.cfg).
   *  Empty ⇒ not PVE-managed.
   */
  pveStorages: z.array(PveStorageRef).default([]),
  /**
   * An iSCSI LUN currently holds something on this pool (story `iscsi.6`) — a
   * zvol served as a block backstore, or an image file on one of its datasets.
   * Destroy and Export are refused while it does. Present only when something
   * holds it; an older daemon omits it (version-skew ruling: no field ⇒ no
   * gating).
   */
  heldByLun: IscsiHeldByLun.optional(),
})
export type PoolSummary = z.infer<typeof PoolSummary>

/** Selected pool properties as typed fields */
export const PoolProperties = z.object({
  ashift: z.number().int(),
  autoexpand: z.boolean(),
  autoreplace: z.boolean(),
  autotrim: z.boolean(),
  failmode: z.enum(['wait', 'continue', 'panic']),
  /** Full property bag for advanced users (property name → value string) */
  all: z.record(z.string(), z.string()).optional(),
})
export type PoolProperties = z.infer<typeof PoolProperties>

/** Full pool detail (GET /v1/pools/:name) */
export const PoolDetail = z.object({
  name: PoolName,
  state: PoolState,
  /** Pool GUID as string (64-bit, exceeds JS safe integer range) */
  guid: z.string(),
  /** Total pool size in bytes */
  size: z.number().nonnegative(),
  allocated: z.number().nonnegative(),
  free: z.number().nonnegative(),
  fragmentation: z.number().min(0).max(100),
  capacity: z.number().min(0).max(100),
  dedupRatio: z.number().nonnegative(),
  /** Health message, present only when pool is not ONLINE */
  health: PoolHealthMessage.optional(),
  /** Total error count for the pool */
  errorCount: z.number().int().nonnegative(),
  /** Error details from zpool status -v (file list or error message) */
  errorDetail: z.string().optional(),
  /** Vdevs grouped by role */
  vdevGroups: z.array(VdevGroup),
  /** Last or current scan status, null if no scan has ever run */
  scan: ScanStatus.nullable(),
  /** Pool properties */
  properties: PoolProperties,
  /**
   * The pool ROOT dataset's mountpoint (story 3.27) — a path, or the literal
   *  `legacy`/`none`/`-`. Read from `zfs get mountpoint <pool>`; absent on old
   *  daemons. Prefilled into the Change mount prompt. Mirrors AHR's `mountpoint`.
   */
  mountpoint: z.string().optional(),
  /** Whether the pool root dataset is currently mounted (mirrors AHR's `mounted`). */
  mounted: z.boolean().optional(),
  /**
   * PVE storages referencing this pool (read-only, from /etc/pve/storage.cfg).
   *  Empty ⇒ not PVE-managed.
   */
  pveStorages: z.array(PveStorageRef).default([]),
})
export type PoolDetail = z.infer<typeof PoolDetail>

// --- Write models (API requests) ---

/**
 * Vdev specification for pool creation or expansion.
 *  'stripe' is our synthetic type — means individual disk vdevs (no redundancy).
 */
export const VdevSpec = z
  .object({
    type: z.enum(['mirror', 'raidz', 'raidz2', 'raidz3', 'stripe']),
    /** Disk by-id identifiers */
    disks: z.array(z.string()).min(1),
  })
  .check((ctx) => {
    const minDisks: Record<string, number> = {
      mirror: 2,
      raidz: 3,
      raidz2: 4,
      raidz3: 5,
      stripe: 1,
    }
    const min = minDisks[ctx.value.type]
    if (ctx.value.disks.length < min) {
      ctx.issues.push({
        code: 'custom',
        message: `${ctx.value.type} requires at least ${min} disk(s), got ${ctx.value.disks.length}`,
        path: ['disks'],
        input: ctx.value.disks,
      })
    }
  })
export type VdevSpec = z.infer<typeof VdevSpec>

/** Create a new ZFS pool (POST /v1/pools) */
export const CreatePoolRequest = z.object({
  name: PoolName,
  /** Data vdevs (required, at least one) */
  dataVdevs: z.array(VdevSpec).min(1),
  /** Log (ZIL) vdevs */
  logVdevs: z.array(VdevSpec).optional(),
  /**
   * Special allocation-class vdevs (metadata / small blocks). Redundant vdevs,
   *  not bare disks — their loss loses the WHOLE pool, so the daemon rejects a
   *  non-redundant (stripe) special vdev at its boundary (story 3.22).
   */
  specialVdevs: z.array(VdevSpec).optional(),
  /**
   * Dedup allocation-class vdevs (the dedup table). Redundant vdevs, not bare
   *  disks — same pool-wide-loss risk as special vdevs (story 3.22).
   */
  dedupVdevs: z.array(VdevSpec).optional(),
  /** Cache (L2ARC) disk IDs — always individual disks */
  cacheDisks: z.array(z.string()).optional(),
  /** Hot spare disk IDs — always individual disks */
  spareDisks: z.array(z.string()).optional(),
  /** Properties to set at creation time */
  properties: z
    .object({
      ashift: z.number().int().min(9).max(16).optional(),
      autoexpand: z.boolean().optional(),
      autoreplace: z.boolean().optional(),
      autotrim: z.boolean().optional(),
    })
    .optional(),
  /** Mount point override (default: /<poolname>) */
  mountpoint: AbsolutePath.optional(),
  /** Force creation (bypasses some safety checks) */
  force: z.boolean().optional(),
})
export type CreatePoolRequest = z.infer<typeof CreatePoolRequest>

/**
 * PUT /v1/pools/:name/mountpoint — change where a pool's root dataset mounts
 * (story 3.27, retconned from AHR's mountpoint flow). The ZFS mountpoint is a
 * native dataset property, so the job is `zfs set mountpoint=<path> <pool>`
 * (ZFS unmounts/remounts itself — NO fstab writes). Child datasets that inherit
 * their mountpoint move with the pool root; a child with its OWN explicit
 * mountpoint stays put. Same collision/reserved constraints as the create-time
 * override; `legacy`/`none` are refused (not absolute paths) — this is the
 * mounted-pool flow only. Mirrors AhrMountpointRequest. ANAS-managed pools only
 * (PVE-managed pools are hands-off per story 3.25 and the route 400s for them).
 */
export const PoolMountpointRequest = z.object({
  mountpoint: AbsolutePath,
})
export type PoolMountpointRequest = z.infer<typeof PoolMountpointRequest>

/** Update pool properties (PUT /v1/pools/:name) */
export const UpdatePoolPropertiesRequest = z.object({
  properties: z
    .record(z.string(), z.string())
    .refine(
      obj => Object.keys(obj).length > 0,
      'At least one property must be specified',
    ),
})
export type UpdatePoolPropertiesRequest = z.infer<typeof UpdatePoolPropertiesRequest>

/** Start or stop a scrub (POST /v1/pools/:name/scrub) */
export const ScrubRequest = z.object({
  action: z.enum(['start', 'stop']).default('start'),
})
export type ScrubRequest = z.infer<typeof ScrubRequest>

/** Trim a pool's SSDs (POST /v1/pools/:name/trim) — Epic 4.12. */
export const TrimPoolRequest = z.object({
  action: z.enum(['start', 'cancel']).default('start'),
})
export type TrimPoolRequest = z.infer<typeof TrimPoolRequest>

// Pool feature-flag upgrade (POST /v1/pools/:name/upgrade) needs no body — it
// enables all supported features on the pool. One-way; the UI must warn.

/** Export a pool (POST /v1/pools/:name/export) */
export const ExportPoolRequest = z
  .object({
    force: z.boolean().optional(),
  })
  .optional()
export type ExportPoolRequest = z.infer<typeof ExportPoolRequest>

/** Import a pool (POST /v1/pools/import) */
export const ImportPoolRequest = z
  .object({
    /** Pool name to import */
    name: z.string().optional(),
    /** Pool GUID to import */
    guid: z.string().optional(),
    /** Force import */
    force: z.boolean().optional(),
    /** Alternative root */
    altroot: AbsolutePath.optional(),
  })
  .refine(data => data.name || data.guid, 'Either name or guid must be specified')
export type ImportPoolRequest = z.infer<typeof ImportPoolRequest>

/**
 * Add a vdev to an existing pool (POST /v1/pools/:name/vdevs).
 *
 * `role` selects the vdev class (default 'data' so pre-role callers still
 * validate). data/log/special/dedup are redundant vdevs and carry a `vdev`
 * (VdevSpec); cache/spare are always bare disks and carry `disks` (string[]).
 * The check enforces exactly the right field per role. The special/dedup
 * redundancy rule (no stripe — its loss loses the whole pool) is enforced at
 * the daemon boundary, not here.
 */
export const AddVdevRequest = z
  .object({
    /** Vdev class. Omitted ⇒ 'data' (backward-compatible with { vdev }). */
    role: VdevRole.default('data'),
    /** Redundant vdev spec — for data/log/special/dedup roles. */
    vdev: VdevSpec.optional(),
    /** Bare disk IDs — for cache/spare roles (always individual disks). */
    disks: z.array(z.string()).optional(),
  })
  .check((ctx) => {
    const { role, vdev, disks } = ctx.value
    const bare = role === 'cache' || role === 'spare'
    if (bare) {
      if (!disks || disks.length < 1) {
        ctx.issues.push({
          code: 'custom',
          message: `${role} vdev requires at least one disk in 'disks'`,
          path: ['disks'],
          input: disks,
        })
      }
      if (vdev) {
        ctx.issues.push({
          code: 'custom',
          message: `${role} vdev takes bare 'disks', not a 'vdev' spec`,
          path: ['vdev'],
          input: vdev,
        })
      }
    }
    else {
      if (!vdev) {
        ctx.issues.push({
          code: 'custom',
          message: `${role} vdev requires a 'vdev' spec`,
          path: ['vdev'],
          input: vdev,
        })
      }
      if (disks) {
        ctx.issues.push({
          code: 'custom',
          message: `${role} vdev takes a 'vdev' spec, not bare 'disks'`,
          path: ['disks'],
          input: disks,
        })
      }
    }
  })
export type AddVdevRequest = z.infer<typeof AddVdevRequest>

/**
 * Attach/replace a leaf OR widen a raidz vdev (POST /v1/pools/:name/attach).
 *
 * Story 3.31 — drop-location is intent. The request carries EXACTLY ONE target:
 *  - `existingDiskId` (a leaf by-id) → `zpool attach`/`replace` on that leaf:
 *      • replace=false → add a mirror LEG (+redundancy, no capacity)
 *      • replace=true  → swap a failed/old device
 *  - `targetVdev` (a raidz vdev NAME, e.g. "raidz1-0") → RAIDZ EXPANSION: the
 *      SAME `zpool attach` verb aimed at the VDEV widens it by one disk
 *      (+capacity, reflow). NEW in 3.31; version/flag/busy-gated at the daemon.
 *
 * ONE disk per attach — OpenZFS has no atomic multi-disk widen.
 */
export const AttachDiskRequest = z
  .object({
    /** Existing leaf to mirror-attach-to or replace (by-id). Leaf target. */
    existingDiskId: z.string().optional(),
    /** Target raidz vdev NAME to widen (raidz-expand). Mutually excl. with existingDiskId. */
    targetVdev: z.string().optional(),
    /** New disk to add (by-id). */
    newDiskId: z.string(),
    /** true = replace (leaf only); false = attach mirror leg / raidz-expand. */
    replace: z.boolean().default(false),
  })
  .check((ctx) => {
    const { existingDiskId, targetVdev, replace } = ctx.value
    const hasLeaf = existingDiskId !== undefined && existingDiskId !== ''
    const hasVdev = targetVdev !== undefined && targetVdev !== ''
    if (hasLeaf === hasVdev) {
      ctx.issues.push({
        code: 'custom',
        message: 'exactly one of existingDiskId (mirror-attach/replace) or targetVdev (raidz-expand) is required',
        path: ['existingDiskId'],
        input: existingDiskId,
      })
    }
    if (replace && hasVdev) {
      ctx.issues.push({
        code: 'custom',
        message: 'replace targets a leaf device (existingDiskId), never a raidz vdev',
        path: ['replace'],
        input: replace,
      })
    }
  })
export type AttachDiskRequest = z.infer<typeof AttachDiskRequest>

// --- Story 3.31: full pool expansion — eligibility/verdict read models -------

/** What a disk dropped onto a target vdev does. */
export const ExpansionOpKind = z.enum(['attach-leg', 'raidz-expand'])
export type ExpansionOpKind = z.infer<typeof ExpansionOpKind>

/**
 * Why an expansion target is refused — the UI turns this into a guiding message.
 *  - `version`     node's OpenZFS module is < 2.3.0 (no raidz expansion)
 *  - `flag`        pool's feature@raidz_expansion is disabled (offer zpool upgrade)
 *  - `busy`        a resilver or raidz-expansion reflow is in progress
 *  - `degraded`    a raidz can't be widened while degraded
 *  - `unsupported` the vdev type can't be expanded this way (e.g. draid)
 */
export const ExpansionGateReason = z.enum(['version', 'flag', 'busy', 'degraded', 'unsupported'])
export type ExpansionGateReason = z.infer<typeof ExpansionGateReason>

/** The node's raidz-expansion capability: module version × pool feature flag. */
export const ExpansionCapability = z.object({
  /** Detected local OpenZFS module version, e.g. "2.3.1"; null if undetectable. */
  zfsVersion: z.string().nullable(),
  /** Module is ≥ 2.3.0 (raidz expansion landed in OpenZFS 2.3.0). */
  moduleSupported: z.boolean(),
  /** Pool's feature@raidz_expansion state. */
  featureState: z.enum(['disabled', 'enabled', 'active', 'unknown']),
  /** feature is enabled or active (usable). */
  featureEnabled: z.boolean(),
  /** Both module + feature satisfied — raidz expansion is possible on this pool. */
  raidzExpandAvailable: z.boolean(),
})
export type ExpansionCapability = z.infer<typeof ExpansionCapability>

/** An in-progress resilver or raidz reflow that blocks any new expansion. */
export const ExpansionBusyState = z.object({
  busy: z.boolean(),
  /** The operation in progress — present only when busy. */
  operation: z.enum(['resilver', 'raidz-expand']).optional(),
  /** Progress 0–100 — present when derivable. */
  percentComplete: z.number().min(0).max(100).optional(),
  /** The vdev being reflowed (raidz-expand only), when known. */
  vdev: z.string().optional(),
})
export type ExpansionBusyState = z.infer<typeof ExpansionBusyState>

/**
 * Per top-level DATA vdev: what a disk-drop here does and whether it's allowed.
 * Capacity figures are raidz-expand only and are ESTIMATES (see advisories) —
 * live-verify on real hardware.
 */
export const ExpansionTarget = z.object({
  /** vdev name, e.g. "mirror-0", "raidz1-0", or a single-disk vdev's leaf name. */
  vdevName: z.string(),
  vdevType: VdevType,
  /** The operation a disk-drop performs here. */
  kind: ExpansionOpKind,
  allowed: z.boolean(),
  /** Refusal reason — present only when !allowed. */
  reason: ExpansionGateReason.optional(),
  /** Guiding message when refused (states the fix). */
  reasonDetail: z.string().optional(),
  /**
   * raidz-expand only: usable bytes of ONE added data column — the naive "+1
   * disk" figure the UI must NOT present as the whole truth (see honest gain).
   */
  naiveUsableGainBytes: z.number().nonnegative().optional(),
  /**
   * raidz-expand only: the HONEST realized usable gain — LESS than naive because
   * existing blocks keep their pre-expansion parity ratio until rewritten. An
   * ESTIMATE; omitted when the vdev's allocation is unknown.
   */
  honestUsableGainBytes: z.number().nonnegative().optional(),
  /** Advisories: rewrite-to-realize, wide-raidz1 widening, wasted excess, etc. */
  advisories: z.array(z.string()).default([]),
})
export type ExpansionTarget = z.infer<typeof ExpansionTarget>

/**
 * GET /v1/pools/:name/expansion — the composer's expansion eligibility (READ,
 * no mutation). One `targets` entry per top-level data vdev (the drag-drop
 * targets), plus the node capability and any blocking busy state.
 */
export const PoolExpansionReport = z.object({
  pool: PoolName,
  capability: ExpansionCapability,
  busy: ExpansionBusyState,
  targets: z.array(ExpansionTarget),
})
export type PoolExpansionReport = z.infer<typeof PoolExpansionReport>
