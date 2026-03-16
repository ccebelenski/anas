import { z } from 'zod'

// --- Reusable validators ---

/** ZFS pool name: alphanumeric, underscore, hyphen. No path separators. */
export const PoolName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z][\w-]*$/i, 'Must start with a letter and contain only alphanumeric, underscore, or hyphen')

/** ZFS dataset path within a pool (e.g. "media/movies") */
export const DatasetPath = z
  .string()
  .min(1)
  .regex(/^[\w-]+(?:\/[\w-]+)*$/, 'Invalid dataset path')

/** Snapshot name */
export const SnapshotName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w:.-]+$/, 'Invalid snapshot name')

/** SMB share name */
export const ShareName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w-]+$/, 'Must be alphanumeric with underscores or hyphens')

/** Absolute filesystem path, no traversal */
export const AbsolutePath = z
  .string()
  .startsWith('/', 'Must be an absolute path')
  .refine(p => !p.includes('..'), 'Path traversal not allowed')

/** Device path (must start with /dev/) */
export const DevicePath = z
  .string()
  .startsWith('/dev/', 'Must be a device path')
  .refine(p => !p.includes('..'), 'Path traversal not allowed')

/** ISO 8601 datetime string */
export const ISODateTime = z.string().datetime()

/** UUID (v4) */
export const UUID = z.string().uuid()

/** Disk by-id identifier, e.g. "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1" */
export const DiskId = z.string().min(1).regex(/^[\w.-]+$/, 'Invalid disk by-id identifier')
