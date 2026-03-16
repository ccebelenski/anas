import { z } from 'zod'
import { DevicePath } from './common.js'

// --- Enums ---

/** How a disk is currently being used */
export const DiskUsageStatus = z.enum([
  'available',
  'pool_member',
  'system',
  'other',
])
export type DiskUsageStatus = z.infer<typeof DiskUsageStatus>

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
  /** by-id identifier (API resource ID), e.g. "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1" */
  id: z.string(),
  /** Kernel device name, e.g. "sdb" */
  name: z.string(),
  /** Full device path, e.g. "/dev/sdb" */
  path: DevicePath,
  /** Size in bytes */
  size: z.number().nonnegative(),
  /** Disk model string */
  model: z.string().nullable(),
  /** Serial number */
  serial: z.string().nullable(),
  /** Transport type: "sata", "nvme", "sas", "usb", etc. */
  transport: z.string().nullable(),
  /** Rotational disk (HDD=true, SSD/NVMe=false) */
  rotational: z.boolean(),
  /** Current usage status */
  status: DiskUsageStatus,
  /** If pool_member, which pool */
  poolName: z.string().nullable(),
  /** Partitions on this disk */
  partitions: z.array(DiskPartition),
})
export type Disk = z.infer<typeof Disk>

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
