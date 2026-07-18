import { z } from 'zod'
import { AbsolutePath } from './common.js'

/**
 * Mounts (Epic 18) — external & local storage.
 *
 * Pure management (18.5 design): ANAS writes /etc/fstab (surgical round-trip)
 * and calls `mount`/`umount`; the kernel, `mount.nfs`/`mount.cifs`, and
 * systemd's fstab generator do the work. There is NO mount daemon and NO shadow
 * state — `configured` is the fstab line, `actual` is `findmnt`, `state` is a
 * `timeout`-guarded probe. PVE-owned mounts (read-only `storage.cfg` parse)
 * appear tagged hands-off and reject every mutation.
 *
 * Field names track the Stage-3 UI contract. Options are a STRUCTURED KNOWN TIER
 * (common / NFS / CIFS) plus a verbatim passthrough for everything unrecognized
 * — a hand-edited entry keeps its exotica across an edit to an unrelated field.
 *
 * CIFS credentials are WRITE-ONLY through the API: request schemas carry
 * username/password/domain; response schemas carry username/domain + a `set`
 * boolean — never the secret. Credentials live in per-mount 0600 root-only files
 * under /etc/anas/creds/.
 */

// ---- Enums -------------------------------------------------------------------

/** Kind of a mount, disambiguated from findmnt `source`/`fstype`. */
export const MountKind = z.enum(['nfs', 'cifs', 'local', 'zfs', 'bind', 'autofs', 'other'])
export type MountKind = z.infer<typeof MountKind>

/**
 * The mount types ANAS can CREATE or mutate — remote shares ONLY (operator
 * ruling 2026-07-18): ANAS is a NAS layer, not a manager of local Linux
 * mounts. Local filesystems appear in the inventory (observe) but the
 * local-drive path is ZFS (later md/SHR, Epic 11) — never generic mounts.
 */
export const MountType = z.enum(['nfs', 'cifs'])
export type MountType = z.infer<typeof MountType>

/**
 * Liveness state (18.5). `unmounted` comes from findmnt ONLY (an empty
 * mountpoint's `stat -f` exits 0 describing the underlying fs — it cannot detect
 * unmounted); `ok`/`stale`/`unreachable` come from `timeout 2 stat -f` on a
 * mount findmnt confirms is present. `armed` = an x-systemd.automount placeholder
 * with nothing yet mounted (a distinct healthy state, never `unreachable`).
 */
export const MountState = z.enum(['ok', 'stale', 'unreachable', 'unmounted', 'armed', 'disabled', 'unknown'])
export type MountState = z.infer<typeof MountState>

/** Preflight diagnosis verdict (POST /v1/mounts/test). */
export const MountTestVerdict = z.enum([
  'ok',
  'unreachable',
  'auth-failed',
  'not-found',
  'protocol-mismatch',
])
export type MountTestVerdict = z.infer<typeof MountTestVerdict>

// ---- Structured option tiers (the persistence model) -------------------------

/** Common options (any fstype). `nofail` is FORCED on every ANAS-written entry. */
export const MountCommonOptions = z.object({
  /** ro (true) vs rw (false). */
  readOnly: z.boolean(),
  /** nofail — an absent device/server never blocks boot. Forced true by ANAS. */
  nofail: z.boolean(),
  /** noauto — not mounted at boot / on `mount -a`. */
  noauto: z.boolean(),
  /** x-systemd.automount — mount on first access (the flaky-link toggle). */
  automount: z.boolean(),
  /** x-systemd.idle-timeout=<n> seconds (automount only). */
  automountIdleTimeout: z.number().int().positive().optional(),
  /** noatime. */
  noatime: z.boolean(),
  /** nosuid — default-on for remote mounts. */
  nosuid: z.boolean(),
  /** nodev — default-on for remote mounts. */
  nodev: z.boolean(),
  /** _netdev — order after network-online.target (default-on for nfs/cifs). */
  netdev: z.boolean(),
})
export type MountCommonOptions = z.infer<typeof MountCommonOptions>

/** NFS-specific options. vers defaults to 4.2, hard default. */
export const MountNfsOptions = z.object({
  vers: z.string().optional(),
  hard: z.boolean().optional(),
  timeo: z.number().int().positive().optional(),
  retrans: z.number().int().nonnegative().optional(),
  rsize: z.number().int().positive().optional(),
  wsize: z.number().int().positive().optional(),
})
export type MountNfsOptions = z.infer<typeof MountNfsOptions>

/** CIFS-specific options (vers defaults to 3.1.1). Credentials are separate. */
export const MountCifsOptions = z.object({
  vers: z.string().optional(),
  domain: z.string().optional(),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  fileMode: z.string().optional(),
  dirMode: z.string().optional(),
})
export type MountCifsOptions = z.infer<typeof MountCifsOptions>

/** The full structured-option bundle (all tiers), as parsed from fstab. */
export const MountOptions = z.object({
  common: MountCommonOptions,
  nfs: MountNfsOptions.optional(),
  cifs: MountCifsOptions.optional(),
  /** Verbatim comma-joined options not recognized into a tier (round-tripped). */
  passthrough: z.string(),
})
export type MountOptions = z.infer<typeof MountOptions>

/**
 * One structured /etc/fstab entry (the persistence model). Identity is the
 * mountpoint (field 2). The raw line is preserved byte-for-byte by the parser;
 * this is the interpreted view returned as `configuredOptions`/`entry`.
 */
export const MountEntry = z.object({
  spec: z.string(),
  mountpoint: AbsolutePath,
  fstype: z.string(),
  options: MountOptions,
  /** CIFS credentials file referenced (`credentials=…`) — path only, never the secret. */
  credentialsFile: z.string().optional(),
  dump: z.number().int().nonnegative(),
  pass: z.number().int().nonnegative(),
  /** Disabled-without-delete: the line is commented with the `#ANAS ` marker. */
  disabled: z.boolean().optional(),
})
export type MountEntry = z.infer<typeof MountEntry>

// ---- Inventory (GET /v1/mounts) ----------------------------------------------

/** A row in the Mounts inventory — fstab (configured) ∪ findmnt (actual). */
export const MountSummary = z.object({
  mountpoint: AbsolutePath,
  /** findmnt source, or the fstab spec when not currently mounted. */
  source: z.string(),
  /** Kind, disambiguated (nfs/cifs/local/zfs/…). */
  type: MountKind,
  /** Raw findmnt/fstab fstype, e.g. "nfs4", "cifs", "ext4". */
  fstype: z.string(),
  /** Liveness state. */
  state: MountState,
  /** Present in the kernel mount table (findmnt). */
  mounted: z.boolean(),
  /** Persisted in /etc/fstab. */
  persistent: z.boolean(),
  /** NFS or CIFS. */
  remote: z.boolean(),
  /** x-systemd.automount configured. */
  automount: z.boolean(),
  /** Disabled-without-delete: fstab line marker-commented (`#ANAS `). Intentional. */
  disabled: z.boolean(),
  /** PVE-owned (read-only storage.cfg) — HANDS-OFF; every mutation is rejected. */
  pveManaged: z.boolean(),
  /** The owning PVE storage id, when pveManaged. */
  pveStorage: z.string().optional(),
  readOnly: z.boolean(),
  /** Capacity (bytes) from the guarded `stat -f` (null when unmounted/unreachable). */
  size: z.number().nonnegative().nullable().optional(),
  used: z.number().nonnegative().nullable().optional(),
})
export type MountSummary = z.infer<typeof MountSummary>

// ---- Detail (GET /v1/mounts/:mountpoint) -------------------------------------

/** systemd mount-unit state (supplementary — NEVER the health verdict). */
export const MountUnit = z.object({
  /** Escaped unit name, e.g. `mnt-anas\x2dnfs.mount`. */
  name: z.string(),
  loadState: z.string().optional(),
  activeState: z.string().optional(),
  subState: z.string().optional(),
  result: z.string().optional(),
})
export type MountUnit = z.infer<typeof MountUnit>

/** Liveness detail: the state plus a human explanation. */
export const MountHealth = z.object({
  state: MountState,
  detail: z.string().optional(),
})
export type MountHealth = z.infer<typeof MountHealth>

/** Capacity from the guarded `stat -f` (all bytes; percent 0–100). */
export const MountCapacity = z.object({
  size: z.number().nonnegative(),
  used: z.number().nonnegative(),
  available: z.number().nonnegative(),
  percent: z.number().min(0).max(100),
})
export type MountCapacity = z.infer<typeof MountCapacity>

/** CIFS credentials presence — username/domain only, never the secret. */
export const MountCredentialsInfo = z.object({
  set: z.boolean(),
  username: z.string().optional(),
  domain: z.string().optional(),
})
export type MountCredentialsInfo = z.infer<typeof MountCredentialsInfo>

/** Mount detail = summary + fstab line + effective options + unit + creds. */
export const MountDetail = MountSummary.extend({
  /** The fstab line exactly as written (undefined when not persisted). */
  fstabLine: z.string().optional(),
  /** The structured fstab options (undefined when not persisted). */
  configuredOptions: MountOptions.optional(),
  /** The structured fstab entry (undefined when not persisted). */
  entry: MountEntry.optional(),
  /** Effective (kernel) options from findmnt (undefined when unmounted). */
  effectiveOptions: z.string().optional(),
  /** systemd unit state — supplementary; a `failed` nofail unit is EXPECTED. */
  unit: MountUnit.optional(),
  /** Liveness verdict + detail. */
  health: MountHealth,
  /** Capacity, when the mount answered the probe. */
  capacity: MountCapacity.optional(),
  /** CIFS credentials presence — never the secret. */
  credentials: MountCredentialsInfo.optional(),
  /** Advisory strings for the UI (e.g. soft-corruption / SMB1 warnings). */
  warnings: z.array(z.string()),
})
export type MountDetail = z.infer<typeof MountDetail>

// ---- Requests ----------------------------------------------------------------

/** CIFS credentials — WRITE-ONLY. Never returned in any response. */
export const MountCredentials = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  domain: z.string().optional(),
})
export type MountCredentials = z.infer<typeof MountCredentials>

/**
 * Flat request options (UI contract). All optional; the server enforces defaults
 * — `nofail` forced, `_netdev`/`nosuid`/`nodev` for remote, vers defaults. The
 * UI never sends `nofail`.
 */
export const MountRequestOptions = z.object({
  // common
  ro: z.boolean().optional(),
  noatime: z.boolean().optional(),
  nosuid: z.boolean().optional(),
  nodev: z.boolean().optional(),
  /** x-systemd.idle-timeout seconds (automount). */
  idleTimeout: z.number().int().positive().optional(),
  // nfs
  vers: z.string().optional(),
  hard: z.boolean().optional(),
  timeo: z.number().int().positive().optional(),
  retrans: z.number().int().nonnegative().optional(),
  rsize: z.number().int().positive().optional(),
  wsize: z.number().int().positive().optional(),
  // cifs
  domain: z.string().optional(),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  fileMode: z.string().optional(),
  dirMode: z.string().optional(),
})
export type MountRequestOptions = z.infer<typeof MountRequestOptions>

/** Create a mount (POST /v1/mounts): write fstab (if persistent) + mount now. */
export const CreateMountRequest = z.object({
  type: MountType,
  /** Remote host (NFS/CIFS). */
  server: z.string().optional(),
  /** NFS export path (`/srv/nfs/export1`) or CIFS share name (`anastest`). */
  remotePath: z.string().optional(),
  mountpoint: AbsolutePath,
  /** Write an /etc/fstab entry (default true). */
  persistent: z.boolean().default(true),
  /** x-systemd.automount (default false). */
  automount: z.boolean().default(false),
  /** Run `mount` now (default true). */
  mountNow: z.boolean().default(true),
  options: MountRequestOptions.optional(),
  /** Verbatim extra mount options (round-tripped in passthrough). */
  extraOptions: z.string().optional(),
  /** CIFS credentials (write-only) — required to authenticate a CIFS mount. */
  credentials: MountCredentials.optional(),
})
export type CreateMountRequest = z.infer<typeof CreateMountRequest>

/**
 * Update a mount (PUT /v1/mounts/:mountpoint): surgical fstab rewrite + remount;
 * credential rotation. The mountpoint (identity), type, and source are fixed.
 */
export const UpdateMountRequest = z.object({
  persistent: z.boolean().optional(),
  automount: z.boolean().optional(),
  options: MountRequestOptions.optional(),
  extraOptions: z.string().optional(),
  /** Rotate CIFS credentials (write-only). */
  credentials: MountCredentials.optional(),
})
export type UpdateMountRequest = z.infer<typeof UpdateMountRequest>

/**
 * Mount / unmount without touching the fstab entry (POST
 * /v1/mounts/:mountpoint/state). A persisted mount can thus be temporarily
 * unmounted and remounted; unmount-busy → 409 confirm (force/lazy behind the gate).
 */
export const MountStateRequest = z.object({
  action: z.enum(['mount', 'unmount', 'disable', 'enable']),
})
export type MountStateRequest = z.infer<typeof MountStateRequest>

// ---- Preflight test (POST /v1/mounts/test) -----------------------------------

/** Diagnose a remote mount before commit: DNS → port → guarded probe mount. */
export const MountTestRequest = z.object({
  type: z.enum(['nfs', 'cifs']),
  server: z.string().min(1),
  /** NFS export path or CIFS share name. */
  remotePath: z.string().optional(),
  /** Version to request (NFS "4.2" default, CIFS "3.1.1" default). */
  vers: z.string().optional(),
  /** CIFS credentials for the auth probe (write-only). */
  credentials: MountCredentials.optional(),
})
export type MountTestRequest = z.infer<typeof MountTestRequest>

/** The staged diagnosis — says WHAT failed, not just that it did. */
export const MountTestResult = z.object({
  verdict: MountTestVerdict,
  /** Human detail (stderr excerpt / errno). Never contains the secret. */
  detail: z.string().optional(),
  /** How far the probe got before the verdict. */
  stage: z.enum(['dns', 'tcp', 'mount']),
  /** DNS resolved. */
  dnsResolved: z.boolean(),
  /** TCP reached on 2049 (NFS) / 445 (CIFS). */
  portReachable: z.boolean(),
})
export type MountTestResult = z.infer<typeof MountTestResult>
