import { z } from 'zod'
import { AbsolutePath, DatasetPath, PoolName } from './common.js'

// --- Enums ---

/** ZFS dataset kind. Snapshots are their own resource (Epic 5), not listed here. */
export const DatasetType = z.enum(['filesystem', 'volume'])
export type DatasetType = z.infer<typeof DatasetType>

// --- Read models ---

/**
 * Dataset summary — one node in the pool's dataset tree (GET
 * /v1/pools/:name/datasets). The tree is built from the flat `zfs list -j`
 * output by splitting names on '/'.
 */
export const Dataset = z.object({
  /** Full ZFS name, e.g. "tank/media/movies" */
  name: z.string(),
  pool: PoolName,
  type: DatasetType,
  /** Space used by this dataset and its descendants, in bytes */
  used: z.number().nonnegative(),
  /** Space available to this dataset, in bytes */
  available: z.number().nonnegative(),
  /** Space referenced by this dataset alone, in bytes */
  referenced: z.number().nonnegative(),
  /** Mountpoint, or null for volumes / unmounted */
  mountpoint: z.string().nullable(),
  /** Current compressor, e.g. "lz4", "zstd", "off" */
  compression: z.string(),
  /** Achieved compression ratio (1.0 = none) */
  compressratio: z.number().nonnegative(),
  /** Quota in bytes, 0 = none */
  quota: z.number().nonnegative(),
  /**
   * Protocols currently sharing this dataset's mountpoint (Epic 4.4 / 15.4).
   * Optional so the flat feed degrades when shares can't be read — the UI
   * simply omits the SMB/NFS badges. Sourced by matching smb.conf / exports
   * paths against the mountpoint, gathered once for the whole list (not N+1).
   */
  sharedOver: z.array(z.enum(['smb', 'nfs'])).optional(),
  /**
   * Number of snapshots of this dataset (Epic 5 / 15.4). Optional so the flat
   * feed degrades when snapshots can't be read — the UI omits the count chip.
   * Tallied from one recursive `zfs list -t snapshot` pass (not N+1).
   */
  snapshotCount: z.number().int().nonnegative().optional(),
})
export type Dataset = z.infer<typeof Dataset>

/** Settable-ish dataset properties surfaced as typed fields. */
export const DatasetProperties = z.object({
  compression: z.string(),
  /** Record size in bytes (filesystem) */
  recordsize: z.number().int().nonnegative(),
  /** Bytes, 0 = none */
  quota: z.number().nonnegative(),
  reservation: z.number().nonnegative(),
  refquota: z.number().nonnegative(),
  refreservation: z.number().nonnegative(),
  atime: z.boolean(),
  /** "off" | "on" | "verify" | … (advanced, guarded in UI) */
  dedup: z.string(),
  sync: z.enum(['standard', 'always', 'disabled']),
  readonly: z.boolean(),
  /** Full property bag (name → value string) for advanced users */
  all: z.record(z.string(), z.string()).optional(),
})
export type DatasetProperties = z.infer<typeof DatasetProperties>

/** POSIX ownership/mode of a dataset's mountpoint (from stat; Epic 4.7). */
export const MountpointPermissions = z.object({
  owner: z.string(),
  group: z.string(),
  /** Octal mode, e.g. "0755" */
  mode: z.string(),
})
export type MountpointPermissions = z.infer<typeof MountpointPermissions>

/**
 * A share (SMB or NFS) serving this dataset's mountpoint (Epic 4.4). Sourced by
 * matching smb.conf / /etc/exports paths against the mountpoint — so admin-made
 * shares surface too (Principle 11). `name` is the SMB share name or the NFS
 * export path.
 */
export const AssociatedShare = z.object({
  protocol: z.enum(['smb', 'nfs']),
  name: z.string(),
})
export type AssociatedShare = z.infer<typeof AssociatedShare>

/** Full dataset detail (GET /v1/pools/:name/datasets/*path). */
export const DatasetDetail = Dataset.extend({
  properties: DatasetProperties,
  /** null for volumes / unmounted datasets */
  permissions: MountpointPermissions.nullable(),
  /** SMB/NFS shares serving this dataset's mountpoint (Epic 4.4) */
  associatedShares: z.array(AssociatedShare),
})
export type DatasetDetail = z.infer<typeof DatasetDetail>

// --- Write models ---

/** Create a dataset (POST /v1/pools/:name/datasets). `path` is relative to the pool. */
export const CreateDatasetRequest = z.object({
  path: DatasetPath,
  properties: z
    .object({
      compression: z.string().optional(),
      recordsize: z.number().int().nonnegative().optional(),
      quota: z.number().nonnegative().optional(),
      reservation: z.number().nonnegative().optional(),
      mountpoint: AbsolutePath.optional(),
    })
    .optional(),
})
export type CreateDatasetRequest = z.infer<typeof CreateDatasetRequest>

/** Update dataset properties (PUT /v1/pools/:name/datasets/*path). */
export const UpdateDatasetPropertiesRequest = z.object({
  properties: z
    .object({
      compression: z.string().optional(),
      recordsize: z.number().int().nonnegative().optional(),
      quota: z.number().nonnegative().optional(),
      reservation: z.number().nonnegative().optional(),
      refquota: z.number().nonnegative().optional(),
      refreservation: z.number().nonnegative().optional(),
      atime: z.boolean().optional(),
      sync: z.enum(['standard', 'always', 'disabled']).optional(),
      readonly: z.boolean().optional(),
      dedup: z.string().optional(),
    })
    .refine(p => Object.keys(p).length > 0, 'at least one property required'),
})
export type UpdateDatasetPropertiesRequest = z.infer<typeof UpdateDatasetPropertiesRequest>

/** Set POSIX permissions on a dataset mountpoint (Epic 4.7 — MVP, POSIX only). */
export const SetPermissionsRequest = z
  .object({
    /** System user name (resolved via getent — local or directory) */
    owner: z.string().optional(),
    /** System group name (via getent) */
    group: z.string().optional(),
    /** Octal mode, 3 or 4 digits */
    mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
    /** Apply recursively to descendants */
    recursive: z.boolean().optional(),
  })
  .refine(
    p => p.owner !== undefined || p.group !== undefined || p.mode !== undefined,
    'set at least one of owner, group, mode',
  )
export type SetPermissionsRequest = z.infer<typeof SetPermissionsRequest>

// Identity models (SystemUser/SystemGroup, ShareUser, …) live in identity.js —
// they are shared by the getent pickers here and the Epic 8 management surface.
