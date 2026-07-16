import { z } from 'zod'
import { AbsolutePath, ShareName } from './common.js'

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

/**
 * An SMB share (a `[name]` stanza in smb.conf). ANAS lists ALL shares,
 * whether it or an admin created them (Principle 11).
 */
export const SmbShare = z.object({
  /** Share name = smb.conf section name, e.g. "media" */
  name: ShareName,
  /** Shared directory */
  path: AbsolutePath,
  comment: z.string().nullable(),
  browseable: z.boolean(),
  readOnly: z.boolean(),
  guestOk: z.boolean(),
  /** `valid users` — names may be users or @groups (resolved via getent) */
  validUsers: z.array(z.string()),
  /** `hosts allow` — host/subnet allow-list (per-share client access) */
  hostsAllow: z.array(z.string()),
  /** `hosts deny` */
  hostsDeny: z.array(z.string()),
  /**
   * Whether `path` currently exists on disk — a READ-TIME observation, never
   * stored state (the daemon stats the path when it lists the share). A share
   * whose backing storage is gone is stale: the definition outlives the path
   * and clients cannot use it. `false` = confirmed missing; `undefined` =
   * unknown (old daemon, or the stat failed, e.g. EACCES — never a false stale).
   */
  pathExists: z.boolean().optional(),
})
export type SmbShare = z.infer<typeof SmbShare>

/** SMB share detail = the share plus its live connections. */
export const SmbShareDetail = SmbShare.extend({
  connections: z.array(SmbConnection),
})
export type SmbShareDetail = z.infer<typeof SmbShareDetail>

/** Samba `[global]` settings ANAS surfaces (GET/PUT /v1/shares/smb/global). */
export const SmbGlobalConfig = z.object({
  workgroup: z.string(),
  serverString: z.string(),
  /** `interfaces` — which NICs/IPs/subnets smbd serves on (multi-NIC lever) */
  interfaces: z.array(z.string()),
  /** `bind interfaces only` — actually restrict smbd to `interfaces` */
  bindInterfacesOnly: z.boolean(),
})
export type SmbGlobalConfig = z.infer<typeof SmbGlobalConfig>

/** Create an SMB share (POST /v1/shares/smb). */
export const CreateSmbShareRequest = z.object({
  name: ShareName,
  path: AbsolutePath,
  comment: z.string().optional(),
  browseable: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  guestOk: z.boolean().optional(),
  validUsers: z.array(z.string()).optional(),
  hostsAllow: z.array(z.string()).optional(),
  hostsDeny: z.array(z.string()).optional(),
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
  /** e.g. "10.0.0.0/24", "*", "host.example.com" */
  spec: z.string(),
  /** e.g. ["rw", "sync", "no_subtree_check", "root_squash"] */
  options: z.array(z.string()),
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
