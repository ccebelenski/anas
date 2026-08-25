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
  /**
   * VOLUMES (zvols) only — the iscsi epic, story iscsi.3. All three are
   * optional and additive (version-skew ruling): an older daemon simply omits
   * them and the UI degrades to what it already drew. They are absent on
   * filesystems, never zero-filled, so "absent" and "0" never get confused.
   *
   * `volsize` is the exported logical size in bytes — the number the initiator
   * sees. It is NOT `used`: a sparse volume's `used` is what has actually been
   * written, a thick one's is `volsize` plus the refreservation overhead.
   */
  volsize: z.number().int().nonnegative().optional(),
  /** Volumes only: the volume block size in bytes (create-only in ZFS). */
  volblocksize: z.number().int().nonnegative().optional(),
  /**
   * Volumes only: thin-provisioned? Derived from `refreservation` — ZFS has no
   * `sparse` property, it is the ABSENCE of a refreservation that makes a
   * volume thin. A thick volume never shows reclaim in `used` (the
   * refreservation holds the space), so this flag is what makes "thin"
   * meaningful in the UI.
   */
  sparse: z.boolean().optional(),
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

/**
 * ZFS `recordsize` in bytes: a power of two between 512 and 16M — exactly what
 * ZFS itself accepts. Validated here (Principles 6 + 14) so a blanked UI field
 * or a careless client is refused at the boundary with a 400 instead of
 * reaching `zfs set recordsize=0`, which ZFS rejects mid-apply (#43).
 */
export const RecordSize = z
  .number()
  .int()
  .min(512, 'recordsize must be at least 512 bytes')
  .max(16 * 1024 * 1024, 'recordsize must be at most 16M')
  .refine(n => (n & (n - 1)) === 0, 'recordsize must be a power of two')
export type RecordSize = z.infer<typeof RecordSize>

/**
 * ZFS `volsize` in bytes (story iscsi.3). A byte COUNT, never a human string —
 * the dialog does the unit arithmetic. The 1 MiB floor is ANAS's, not ZFS's:
 * ZFS itself would happily make a 64 KiB "disk", which is never what anyone
 * means. ZFS rounds the value up to a multiple of `volblocksize`, so the
 * created volume can be marginally larger than asked.
 */
export const VolSize = z
  .number()
  .int('volsize must be a whole number of bytes')
  .min(1024 * 1024, 'volsize must be at least 1 MiB')
export type VolSize = z.infer<typeof VolSize>

/**
 * ZFS `volblocksize` in bytes: a power of two between 512 and 1M — exactly what
 * ZFS accepts. Validated here (Principles 6 + 14) so a bad value is a 400 at
 * the boundary rather than a `zfs create` that dies half-way. NO default is
 * encoded: `volblocksize` is create-only and ZFS owns the default, so the
 * dialog READS the running default off an existing volume (`zfs get`) instead
 * of this file asserting one that a future OpenZFS could change.
 */
export const VolBlockSize = z
  .number()
  .int('volblocksize must be a whole number of bytes')
  .min(512, 'volblocksize must be at least 512 bytes')
  .max(1024 * 1024, 'volblocksize must be at most 1M')
  .refine(n => (n & (n - 1)) === 0, 'volblocksize must be a power of two')
export type VolBlockSize = z.infer<typeof VolBlockSize>

/**
 * Node-observed ZFS defaults, returned alongside the dataset list so the Create
 * dialog can STATE the default instead of hard-coding one (story iscsi.3).
 * Additive and optional (version-skew ruling) — an older daemon omits the whole
 * object and the dialog says "ZFS default" with no number.
 */
export const DatasetListDefaults = z.object({
  /**
   * ZFS's own default `volblocksize` in bytes, read from an existing volume
   * whose value is DEFAULT-sourced. `null` when the pool has no volume to read
   * it from — an honest absence, never a guess.
   */
  volblocksize: z.number().int().positive().nullable(),
})
export type DatasetListDefaults = z.infer<typeof DatasetListDefaults>

/**
 * Create a dataset (POST /v1/pools/:name/datasets). `path` is relative to the
 * pool. A volume is a dataset of another TYPE, not another resource: the same
 * endpoint, the same body, with `type: 'volume'` plus the three zvol fields.
 *
 * `type` is optional and absent means `filesystem`, so an older client's body
 * (which has no `type` at all) is still exactly a filesystem create — the
 * version-skew rule cuts both ways.
 */
export const CreateDatasetRequest = z
  .object({
    path: DatasetPath,
    /** `volume` creates a zvol; absent/`filesystem` is the pre-iscsi.3 behaviour. */
    type: DatasetType.optional(),
    /** Volumes only, REQUIRED for one: the exported size in bytes. */
    volsize: VolSize.optional(),
    /** Volumes only: block size. Omitted then ZFS's own default applies. */
    volblocksize: VolBlockSize.optional(),
    /** Volumes only: thin-provision it (`zfs create -s`, no refreservation). */
    sparse: z.boolean().optional(),
    properties: z
      .object({
        compression: z.string().optional(),
        recordsize: RecordSize.optional(),
        quota: z.number().nonnegative().optional(),
        reservation: z.number().nonnegative().optional(),
        mountpoint: AbsolutePath.optional(),
      })
      .optional(),
  })
  .superRefine((req, ctx) => {
    const isVolume = req.type === 'volume'
    if (isVolume) {
      if (req.volsize === undefined) {
        ctx.addIssue({ code: 'custom', path: ['volsize'], message: 'a volume needs a volsize' })
      }
      // A zvol has no mountpoint, no recordsize and no quota — ZFS does not
      // even list those properties on one (verified against a real volume).
      // Refuse them here rather than letting `zfs create` fail mid-apply.
      const p = req.properties
      if (p?.mountpoint !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['properties', 'mountpoint'], message: 'a volume has no mountpoint' })
      }
      if (p?.recordsize !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['properties', 'recordsize'], message: 'recordsize does not apply to a volume — use volblocksize' })
      }
      if (p?.quota !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['properties', 'quota'], message: 'quota does not apply to a volume — volsize is its size' })
      }
    }
    else {
      for (const key of ['volsize', 'volblocksize', 'sparse'] as const) {
        if (req[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} applies only to type 'volume'` })
        }
      }
    }
  })
export type CreateDatasetRequest = z.infer<typeof CreateDatasetRequest>

/** Update dataset properties (PUT /v1/pools/:name/datasets/*path). */
export const UpdateDatasetPropertiesRequest = z.object({
  properties: z
    .object({
      compression: z.string().optional(),
      recordsize: RecordSize.optional(),
      quota: z.number().nonnegative().optional(),
      reservation: z.number().nonnegative().optional(),
      refquota: z.number().nonnegative().optional(),
      refreservation: z.number().nonnegative().optional(),
      atime: z.boolean().optional(),
      sync: z.enum(['standard', 'always', 'disabled']).optional(),
      readonly: z.boolean().optional(),
      dedup: z.string().optional(),
      /**
       * VOLUMES only (story iscsi.3): GROW the volume. `zfs set volsize=` is
       * live under a LUN — the initiator rescans and sees the new size. The
       * schema can only enforce the floor and the byte-count shape; whether a
       * given value is a grow or a SHRINK depends on the current size, so the
       * shrink refusal lives at the daemon boundary (assertVolumeMutable).
       * ZFS would silently truncate, which is why this is refused outright
       * rather than confirm-gated.
       */
      volsize: VolSize.optional(),
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
