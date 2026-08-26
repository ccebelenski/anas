import { z } from 'zod'
import { DevicePath } from './common.js'
import { VdevRole } from './zfs.js'

// --- Enums ---

/** How a disk is currently being used */
export const DiskUsageStatus = z.enum([
  'available',
  'pool_member',
  // AHR (ANAS Hybrid RAID / mdadm-backed) member — a distinct, honest value:
  // AHR membership is NOT ZFS pool membership (different tech, visible
  // divergence). Like `pool_member`, it means the disk is IN USE — never
  // offered as available.
  'ahr_member',
  // Ceph OSD member — the disk backs a Ceph OSD (bluestore block, or a
  // dedicated DB/WAL device). Distinct from `pool_member` because it is NOT
  // ZFS (different tech, visible divergence). Like the other membership
  // values it means the disk is IN USE — never offered as available.
  'ceph_osd',
  'system',
  'other',
])
export type DiskUsageStatus = z.infer<typeof DiskUsageStatus>

/**
 * Why a disk ANAS can see is nonetheless hands-off (story `iscsi.6`).
 *
 * `iscsi-served-here` — the disk arrived over the iSCSI transport and its SCSI
 * serial is one of THIS node's own LUN serials: the node's initiator is logged
 * in to the node's own target. `lsblk` reports a perfectly blank SCSI disk
 * (GT-43) and nothing in the inventory can tell it apart from a real remote
 * array — pooling it would build storage on top of itself.
 *
 * An enum rather than a boolean so a second reason can be added without a new
 * field, and so the UI badge can key off the reason rather than parse prose.
 */
export const DiskHandsOffTag = z.enum(['iscsi-served-here'])
export type DiskHandsOffTag = z.infer<typeof DiskHandsOffTag>

/** Derived disk-health level (fuses SMART pass/fail with ZFS error counts) */
export const DiskHealthStatus = z.enum([
  'healthy',
  'warning',
  'critical',
  'unknown',
])
export type DiskHealthStatus = z.infer<typeof DiskHealthStatus>

/** Overall SMART health assessment */
export const SmartHealth = z.enum(['PASSED', 'FAILED', 'UNKNOWN'])
export type SmartHealth = z.infer<typeof SmartHealth>

// --- Read models ---

/** A partition on a disk */
export const DiskPartition = z.object({
  /** Partition name, e.g. "sdb1" */
  name: z.string(),
  /** Size in bytes */
  size: z.number().nonnegative(),
  /** Filesystem type, e.g. "zfs_member", "ext4" */
  fstype: z.string().nullable(),
  /** Mount point if mounted */
  mountpoint: z.string().nullable(),
})
export type DiskPartition = z.infer<typeof DiskPartition>

/** A storage disk (GET /v1/disks) */
export const Disk = z.object({
  /** by-id identifier (API resource ID), e.g. "ata-WDC_WD2003FZEX-00SRLA0_WD-12345678" */
  id: z.string(),
  /** Kernel device name, e.g. "sdb" */
  name: z.string(),
  /** Full device path, e.g. "/dev/sdb" */
  path: DevicePath,
  /** Size in bytes */
  size: z.number().nonnegative(),
  /** Disk model string */
  model: z.string().nullable(),
  /** Human-readable model family, e.g. "Western Digital Red Pro" */
  modelFamily: z.string().nullable(),
  /** Serial number */
  serial: z.string().nullable(),
  /** Vendor string */
  vendor: z.string().nullable(),
  /** Firmware revision */
  revision: z.string().nullable(),
  /** Form factor, e.g. "2.5 inches", "3.5 inches" */
  formFactor: z.string().nullable(),
  /** Transport type: "sata", "nvme", "sas", "usb", etc. */
  transport: z.string().nullable(),
  /** Rotational disk (HDD=true, SSD/NVMe=false) */
  rotational: z.boolean(),
  /** Physical sector size in bytes */
  physicalSectorSize: z.number().int().nullable(),
  /** Logical sector size in bytes */
  logicalSectorSize: z.number().int().nullable(),
  /** World Wide Name */
  wwn: z.string().nullable(),
  /** SMART health: true=passed, false=failed, null=not supported or unknown */
  smartHealthy: z.boolean().nullable(),
  /** Current usage status */
  status: DiskUsageStatus,
  /** If pool_member, the ZFS pool; if ahr_member, the AHR pool this disk is in */
  poolName: z.string().nullable(),
  /** If pool_member, the vdev this disk belongs to, e.g. "mirror-0" */
  vdevName: z.string().nullable(),
  /**
   * If ahr_member, the band-array label this disk participates in — the AHR
   * parallel to a ZFS member's `vdevName`. A single-band disk reads "r1"; a
   * disk spanning bands reads a range like "r1-r3"; a hot spare reads "spare".
   * Null for every non-AHR disk (kept off the ZFS-documented `vdevName`).
   */
  ahrArray: z.string().nullable(),
  /** If pool_member, the vdev's role (data/log/cache/spare/special/dedup) */
  vdevRole: VdevRole.nullable(),
  /** Live ZFS error counts for this disk (null unless a pool member) */
  zfsErrors: z
    .object({
      read: z.number().int().nonnegative(),
      write: z.number().int().nonnegative(),
      checksum: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * Derived disk health, fusing SMART pass/fail with live ZFS error counts:
   * - critical: SMART FAILED, or read/write errors, or a faulted vdev state
   * - warning: checksum errors (silent corruption ZFS is repairing)
   * - healthy: SMART passed (or n/a) and no ZFS errors
   * - unknown: no usable signal (SMART unsupported, not in a pool)
   */
  healthStatus: DiskHealthStatus,
  /** Partitions on this disk */
  partitions: z.array(DiskPartition),
  /**
   * Hands-off tag (story `iscsi.6`) — the disk is a real, blank SCSI device
   * from the kernel's point of view, so `status` stays honest, but ANAS knows
   * something about it the inventory cannot see and must not offer it for
   * composition. Additive and optional: absent means nothing is claiming it,
   * and an older daemon omits it entirely (version-skew ruling).
   */
  handsOff: DiskHandsOffTag.optional(),
  /** Why the disk is hands-off — one sentence, ready for a badge tooltip. */
  handsOffReason: z.string().optional(),
})
export type Disk = z.infer<typeof Disk>

/**
 * May this disk be offered for composition — a ZFS vdev, an AHR band, a spare?
 *
 * TWO conditions, and they answer different questions. `status === 'available'`
 * is the BLOCK LAYER's answer: the disk is blank, no partitions, no labels, no
 * pool. `handsOff === undefined` is ANAS's: nothing outside the block layer is
 * claiming it. A LUN this node serves to its own initiator satisfies the first
 * and fails the second (story `iscsi.6`, GT-43) — `lsblk` sees a pristine SCSI
 * disk and cannot possibly know it is a zvol on the same box.
 *
 * ONE predicate, called by every candidacy check (composer, AHR composer, spare
 * picker, expansion resume) rather than each re-deriving "available means…".
 */
export function isComposableDisk(disk: Pick<Disk, 'status'> & { handsOff?: DiskHandsOffTag }): boolean {
  return disk.status === 'available' && disk.handsOff === undefined
}

/** A single SMART attribute (SATA/SAS) */
export const SmartAttribute = z.object({
  id: z.number().int(),
  name: z.string(),
  value: z.number().int(),
  worst: z.number().int(),
  threshold: z.number().int(),
  rawValue: z.number(),
  /** true if value <= threshold (attribute is failing) */
  failing: z.boolean(),
})
export type SmartAttribute = z.infer<typeof SmartAttribute>

/** SMART health data for a disk (GET /v1/disks/:id/smart) */
export const SmartData = z.object({
  /** Whether the disk supports SMART */
  supported: z.boolean(),
  /** Whether SMART is enabled */
  enabled: z.boolean(),
  /** Overall health assessment */
  overallHealth: SmartHealth,
  /** Temperature in Celsius */
  temperature: z.number().nullable(),
  /** Power-on hours */
  powerOnHours: z.number().int().nullable(),
  /** SMART attributes (SATA/SAS disks) */
  attributes: z.array(SmartAttribute),
  /** NVMe: percentage of life used (0–100) */
  nvmePercentageUsed: z.number().min(0).max(100).nullable(),
  /** NVMe: available spare percentage (0–100) */
  nvmeAvailableSpare: z.number().min(0).max(100).nullable(),
})
export type SmartData = z.infer<typeof SmartData>
