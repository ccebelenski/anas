import { z } from 'zod'
import { AbsolutePath, ShareName, SingleLine } from './common.js'

// ============================================================================
// SMB (Samba) — shares are managed by surgical in-place edits to smb.conf.
// ============================================================================

/** One live SMB connection to a share (from `smbstatus`). */
export const SmbConnection = z.object({
  /** Authenticated user, or 'guest' */
  user: z.string(),
  /** Client machine (hostname or IP) */
  machine: z.string(),
})
export type SmbConnection = z.infer<typeof SmbConnection>

// ---------------------------------------------------------------------------
// Self-service features on SMB shares (smbsvc.1–3, DESIGN "Self-service on
// SMB shares"). Each feature is pure surgical smb.conf wiring of a Samba VFS
// module set; the `vfs objects` line is COMPOSED from the enabled set, and
// every feature key is a managed parameter. All three schemas are cut once
// here — smbsvc.2 (recycle) and smbsvc.3 (Time Machine) reuse them.
// ---------------------------------------------------------------------------

/**
 * Which snapshot schedule bucket a share's Previous Versions exposes. The
 * daemon picks it (the finest cadence scheduled on the share's backing
 * dataset/pool, `daily` when none) and the stanza is the store: the value is
 * parsed back from `shadow:format = anas-<bucket>-…` on every read — never
 * kept anywhere else (Principle 11).
 */
export const PreviousVersionsState = z.object({ bucket: z.string().min(1) })
export type PreviousVersionsState = z.infer<typeof PreviousVersionsState>

/** Purge age for the recycle bin, in days; `null` = never purge. */
export const RecyclePurgeDays = z.union([
  z.literal(7),
  z.literal(14),
  z.literal(30),
  z.literal(90),
  z.null(),
])
export type RecyclePurgeDays = z.infer<typeof RecyclePurgeDays>

export const RecycleState = z.object({ purgeDays: RecyclePurgeDays })
export type RecycleState = z.infer<typeof RecycleState>

/** Time Machine size cap in bytes (the `fruit:time machine max size` value). */
export const TimeMachineState = z.object({ maxSize: z.number().int().positive() })
export type TimeMachineState = z.infer<typeof TimeMachineState>

/**
 * The self-service feature set a request SETS. Each field is three-valued per
 * the §2 dialog↔daemon contract: value = set, `null` = clear, omitted = keep.
 * `previousVersions.enabled=false` is the explicit "turn it off" that the
 * boolean needs (there is no value to hold).
 */
export const PreviousVersionsRequest = z.object({ enabled: z.boolean() }).nullable()
export type PreviousVersionsRequest = z.infer<typeof PreviousVersionsRequest>

/** Request shape for the recycle bin: a value sets it (purge age, `null` inside = never). */
export const RecycleRequest = z.object({ purgeDays: RecyclePurgeDays }).nullable()
export type RecycleRequest = z.infer<typeof RecycleRequest>

/** Request shape for the Time Machine target (cap in bytes). */
export const TimeMachineRequest = TimeMachineState.nullable()
export type TimeMachineRequest = z.infer<typeof TimeMachineRequest>

/**
 * An SMB share (a `[name]` stanza in smb.conf). ANAS lists ALL shares,
 * whether it or an admin created them (Principle 11).
 */
export const SmbShare = z.object({
  /** Share name = smb.conf section name, e.g. "media" */
  name: ShareName,
  /** Shared directory */
  path: AbsolutePath,
  /**
   * `comment` — free text, but single-line (a newline would forge extra
   *  smb.conf parameters). Spaces/punctuation (e.g. "Bob's share") are fine.
   */
  comment: SingleLine.nullable(),
  browseable: z.boolean(),
  readOnly: z.boolean(),
  guestOk: z.boolean(),
  /**
   * `valid users` — names may be users or @groups (resolved via getent).
   *  Each entry is single-line (no control chars / smb.conf line injection).
   */
  validUsers: z.array(SingleLine),
  /** `hosts allow` — host/subnet allow-list (per-share client access) */
  hostsAllow: z.array(SingleLine),
  /** `hosts deny` */
  hostsDeny: z.array(SingleLine),
  /**
   * Whether `path` currently exists on disk — a READ-TIME observation, never
   * stored state (the daemon stats the path when it lists the share). A share
   * whose backing storage is gone is stale: the definition outlives the path
   * and clients cannot use it. `false` = confirmed missing; `undefined` =
   * unknown (old daemon, or the stat failed, e.g. EACCES — never a false stale).
   */
  pathExists: z.boolean().optional(),
  /**
   * The share's `vfs objects` module list, parsed from the stanza — absent
   * when the stanza carries no such line. Read-only information (what the
   * config says), and the input {@link hasCustomVfsObjects} answers from.
   */
  vfsObjects: z.array(z.string()).optional(),
  /**
   * Previous Versions (smbsvc.1), derived FROM the stanza (`shadow:format`).
   * Present iff the feature is on. Absent = off / not configured here.
   */
  previousVersions: PreviousVersionsState.optional(),
  /** Recycle bin (smbsvc.2), derived from the stanza + its purge marker. */
  recycle: RecycleState.optional(),
  /** Time Machine target (smbsvc.3, beta), derived from the fruit keys. */
  timeMachine: TimeMachineState.optional(),
})
export type SmbShare = z.infer<typeof SmbShare>

/** SMB share detail = the share plus its live connections. */
export const SmbShareDetail = SmbShare.extend({
  connections: z.array(SmbConnection),
})
export type SmbShareDetail = z.infer<typeof SmbShareDetail>

/** Samba `[global]` settings ANAS surfaces (GET/PUT /v1/shares/smb/global). */
export const SmbGlobalConfig = z.object({
  /** `workgroup` — single-line (written verbatim as a `[global]` parameter). */
  workgroup: SingleLine,
  /** `server string` — single-line; may contain spaces and `%v`-style macros. */
  serverString: SingleLine,
  /**
   * `interfaces` — which NICs/IPs/subnets smbd serves on (multi-NIC lever).
   *  Each entry is single-line — they are space-joined into the `interfaces`
   *  line, so a newline would forge another `[global]` parameter.
   */
  interfaces: z.array(SingleLine),
  /** `bind interfaces only` — actually restrict smbd to `interfaces` */
  bindInterfacesOnly: z.boolean(),
})
export type SmbGlobalConfig = z.infer<typeof SmbGlobalConfig>

/** Create an SMB share (POST /v1/shares/smb). */
export const CreateSmbShareRequest = z.object({
  name: ShareName,
  path: AbsolutePath,
  comment: SingleLine.optional(),
  browseable: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  guestOk: z.boolean().optional(),
  validUsers: z.array(SingleLine).optional(),
  hostsAllow: z.array(SingleLine).optional(),
  hostsDeny: z.array(SingleLine).optional(),
  /**
   * Self-service features (smbsvc.1–3): value = set, `null` = clear, omitted
   * = keep (the §2 dialog↔daemon contract). Enabling is refused on a share
   * with a custom `vfs objects` line and on a path with nothing to expose.
   */
  previousVersions: PreviousVersionsRequest.optional(),
  recycle: RecycleRequest.optional(),
  timeMachine: TimeMachineRequest.optional(),
})
export type CreateSmbShareRequest = z.infer<typeof CreateSmbShareRequest>

/** Update an SMB share (PUT /v1/shares/smb/:name) — any subset of options. */
export const UpdateSmbShareRequest = CreateSmbShareRequest
  .partial()
  .omit({ name: true })
export type UpdateSmbShareRequest = z.infer<typeof UpdateSmbShareRequest>

/** Update SMB global config (PUT /v1/shares/smb/global). */
export const UpdateSmbGlobalConfigRequest = SmbGlobalConfig.partial()
export type UpdateSmbGlobalConfigRequest = z.infer<typeof UpdateSmbGlobalConfigRequest>

// ============================================================================
// NFS — exports are managed by surgical in-place edits to /etc/exports.
// ============================================================================

/** One client entry on an export: a host/subnet spec and its options. */
export const NfsClient = z.object({
  /**
   * e.g. "10.0.0.0/24", "*", "host.example.com". Single-line — it is written
   *  verbatim into an /etc/exports line; a control char would corrupt the file.
   */
  spec: SingleLine,
  /**
   * e.g. ["rw", "sync", "no_subtree_check", "root_squash"]. Each option is
   *  single-line (no control chars / exports line injection).
   */
  options: z.array(SingleLine),
})
export type NfsClient = z.infer<typeof NfsClient>

/** An NFS export (a line in /etc/exports): a path shared to ≥1 client. */
export const NfsExport = z.object({
  path: AbsolutePath,
  clients: z.array(NfsClient).min(1),
  /**
   * Whether `path` currently exists on disk — a READ-TIME observation, never
   * stored state (the daemon stats the path when it lists the export). An
   * export whose backing storage is gone is stale: the line outlives the path
   * and clients cannot use it. `false` = confirmed missing; `undefined` =
   * unknown (old daemon, or the stat failed, e.g. EACCES — never a false stale).
   */
  pathExists: z.boolean().optional(),
})
export type NfsExport = z.infer<typeof NfsExport>

/** Create an NFS export (POST /v1/shares/nfs). */
export const CreateNfsExportRequest = z.object({
  path: AbsolutePath,
  clients: z.array(NfsClient).min(1),
})
export type CreateNfsExportRequest = z.infer<typeof CreateNfsExportRequest>

/** Update an NFS export (PUT /v1/shares/nfs/:path) — replaces the client list. */
export const UpdateNfsExportRequest = z.object({
  clients: z.array(NfsClient).min(1),
})
export type UpdateNfsExportRequest = z.infer<typeof UpdateNfsExportRequest>

// --- Unified list (the single "Shares" view) ---

/** A row in the unified Shares grid — SMB share or NFS export, tagged. */
export const ShareEntry = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('smb'), share: SmbShare, activeConnections: z.number().int().nonnegative() }),
  z.object({ protocol: z.literal('nfs'), export: NfsExport }),
])
export type ShareEntry = z.infer<typeof ShareEntry>
