import { z } from 'zod'
import { AbsolutePath, DevicePath, ISODateTime, PoolName } from './common.js'

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
  /** Health message, present only when pool is not ONLINE */
  health: PoolHealthMessage.optional(),
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
  /** Vdevs grouped by role */
  vdevGroups: z.array(VdevGroup),
  /** Last or current scan status, null if no scan has ever run */
  scan: ScanStatus.nullable(),
  /** Pool properties */
  properties: PoolProperties,
})
export type PoolDetail = z.infer<typeof PoolDetail>

// --- Write models (API requests) ---

/** Vdev specification for pool creation or expansion.
 *  'stripe' is our synthetic type — means individual disk vdevs (no redundancy). */
export const VdevSpec = z
  .object({
    type: z.enum(['mirror', 'raidz', 'raidz2', 'raidz3', 'stripe']),
    /** Disk by-id identifiers */
    disks: z.array(z.string()).min(1),
  })
  .check(ctx => {
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

/** Add a vdev to an existing pool (POST /v1/pools/:name/vdevs) */
export const AddVdevRequest = z.object({
  vdev: VdevSpec,
})
export type AddVdevRequest = z.infer<typeof AddVdevRequest>

/** Attach or replace a disk in a mirror (POST /v1/pools/:name/attach) */
export const AttachDiskRequest = z.object({
  /** Existing disk to attach to or replace */
  existingDiskId: z.string(),
  /** New disk to add */
  newDiskId: z.string(),
  /** true = replace, false = attach to mirror */
  replace: z.boolean().default(false),
})
export type AttachDiskRequest = z.infer<typeof AttachDiskRequest>
