import { z } from 'zod'
import { AbsolutePath, SingleLine } from './common.js'

/**
 * A filesystem-version token (NFS `vers`, CIFS `vers`): either digits separated
 * by dots — e.g. "4.2", "3.1.1", "3", "1.0" — or the literal `default`, a
 * documented mount.cifs(8) token (its actual default: negotiate the highest
 * SMB2+ version both ends support). Only `default` is admitted as a non-numeric
 * word; mount.nfs has no such literal, so nothing else is added. This is written
 * verbatim as `vers=<value>` into an fstab option list and a `mount -o`
 * argument, so the shape stays injection-hard — no commas (which would forge a
 * `4.2,exec` extra option), no whitespace, no shell metacharacters, no control
 * characters.
 */
export const MountVers = z
  .string()
  .regex(/^(?:default|\d+(?:\.\d+)*)$/, 'Version must be numeric dotted (e.g. "4.2", "3.1.1") or "default"')

/**
 * An octal permission mode (CIFS `file_mode=` / `dir_mode=`): 3 or 4 octal
 * digits, e.g. "755", "0644". Written verbatim as a `mount -o` option token —
 * the strict octal shape forecloses comma-based option injection (e.g. the
 * `0644,exec` payload) and control characters.
 */
export const MountMode = z
  .string()
  .regex(/^[0-7]{3,4}$/, 'Mode must be 3–4 octal digits (e.g. "755", "0644")')

/**
 * A charset name for CIFS `iocharset=` (e.g. "utf8", "iso8859-1"). Constrained to
 * the character set of a real charset token — letters, digits, and `. _ -` — so
 * it stays injection-hard (no commas → no `utf8,exec` option forgery, no
 * whitespace, no control characters) when written verbatim as a mount option.
 */
export const MountCharset = z
  .string()
  .regex(/^[\w.-]+$/, 'Charset must be a plain token (e.g. "utf8", "iso8859-1")')

// ---- Curated common-tier option enums (mount.cifs(8) / nfs(5)) ---------------

/**
 * CIFS `cache=` mode (mount.cifs(8)): `strict` (protocol-correct, the kernel
 * default since 3.7), `loose` (relaxed, faster on a single client), `none` (no
 * client caching). The common knob a NAS user actually turns.
 */
export const MountCifsCache = z.enum(['strict', 'loose', 'none'])
export type MountCifsCache = z.infer<typeof MountCifsCache>

/**
 * CIFS `sec=` authentication flavour (mount.cifs(8)). The real-world set:
 * `ntlmssp` (the modern default), `ntlmv2`/`ntlmv2i`, legacy `ntlm`/`ntlmi`,
 * Kerberos `krb5`/`krb5i`, `ntlmsspi`, and `none` (null session). Exotic tails
 * (e.g. multi-flavour lists) stay in passthrough.
 */
export const MountCifsSec = z.enum([
  'ntlmssp',
  'ntlmsspi',
  'ntlmv2',
  'ntlmv2i',
  'ntlm',
  'ntlmi',
  'krb5',
  'krb5i',
  'none',
])
export type MountCifsSec = z.infer<typeof MountCifsSec>

/** NFS `proto=` transport (nfs(5)): `tcp` (default), `udp`, `rdma`. */
export const MountNfsProto = z.enum(['tcp', 'udp', 'rdma'])
export type MountNfsProto = z.infer<typeof MountNfsProto>

/**
 * NFS `sec=` security flavour (nfs(5)): `sys` (default AUTH_SYS), Kerberos
 * `krb5`/`krb5i`/`krb5p`, and `none`. A multi-flavour colon list stays in
 * passthrough (single-flavour is the common case).
 */
export const MountNfsSec = z.enum(['sys', 'krb5', 'krb5i', 'krb5p', 'none'])
export type MountNfsSec = z.infer<typeof MountNfsSec>

/** NFS `lookupcache=` mode (nfs(5)): `all` (default), `none`, `pos`, `positive`. */
export const MountLookupCache = z.enum(['all', 'none', 'pos', 'positive'])
export type MountLookupCache = z.infer<typeof MountLookupCache>

/**
 * A `sec=` value accepted at the flat-request boundary — the union of the NFS and
 * CIFS flavours (the request is one type, so the daemon narrows by fstype before
 * assigning; an out-of-tier value is dropped rather than mis-applied).
 */
export const MountSec = z.union([MountNfsSec, MountCifsSec])
export type MountSec = z.infer<typeof MountSec>

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
 * Field names track the UI contract. Options are a STRUCTURED KNOWN TIER
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
 * ruling): ANAS is a NAS layer, not a manager of local Linux mounts. Local
 * filesystems appear in the inventory (observe) but the local-drive path is
 * ZFS or AHR (Epic 11) — never generic mounts.
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
  /** noexec — forbid direct execution of binaries (data-share hardening). */
  noexec: z.boolean(),
  /** _netdev — order after network-online.target (default-on for nfs/cifs). */
  netdev: z.boolean(),
})
export type MountCommonOptions = z.infer<typeof MountCommonOptions>

/** NFS-specific options. vers defaults to 4.2, hard default. */
export const MountNfsOptions = z.object({
  vers: MountVers.optional(),
  /** hard (true) vs soft (false) recovery. Absent ⇒ mount.nfs default (hard). */
  hard: z.boolean().optional(),
  timeo: z.number().int().positive().optional(),
  retrans: z.number().int().nonnegative().optional(),
  rsize: z.number().int().positive().optional(),
  wsize: z.number().int().positive().optional(),
  /** `proto=` transport (tcp/udp/rdma). */
  proto: MountNfsProto.optional(),
  /** `sec=` security flavour (sys/krb5/krb5i/krb5p/none). */
  sec: MountNfsSec.optional(),
  /** `noac` — disable attribute caching (true ⇒ noac; absent ⇒ ac default). */
  noac: z.boolean().optional(),
  /** `actimeo=<n>` — attribute-cache lifetime, seconds. */
  actimeo: z.number().int().nonnegative().optional(),
  /** `nconnect=<n>` — parallel transport connections (1–16; modern throughput). */
  nconnect: z.number().int().positive().max(16).optional(),
  /** `bg` — retry the mount in the background (true ⇒ bg; absent ⇒ fg default). */
  bg: z.boolean().optional(),
  /** `lookupcache=` mode (all/none/pos/positive). */
  lookupcache: MountLookupCache.optional(),
})
export type MountNfsOptions = z.infer<typeof MountNfsOptions>

/** CIFS-specific options (vers defaults to 3.1.1). Credentials are separate. */
export const MountCifsOptions = z.object({
  vers: MountVers.optional(),
  /** `domain=` — single-line (written verbatim as a mount option token). */
  domain: SingleLine.optional(),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  /** `file_mode=` — octal only (forecloses `0644,exec` option injection). */
  fileMode: MountMode.optional(),
  /** `dir_mode=` — octal only. */
  dirMode: MountMode.optional(),
  /** `cache=` client-caching mode (strict/loose/none). */
  cache: MountCifsCache.optional(),
  /** `mfsymlinks` — support Minshall+French symlinks on servers without Unix ext. */
  mfsymlinks: z.boolean().optional(),
  /** `forceuid` — always apply the `uid=` owner, ignoring any the server returns. */
  forceuid: z.boolean().optional(),
  /** `forcegid` — always apply the `gid=` group, ignoring any the server returns. */
  forcegid: z.boolean().optional(),
  /** `noserverino` — generate inode numbers locally (true ⇒ noserverino; absent ⇒ serverino default). */
  noserverino: z.boolean().optional(),
  /** `nobrl` — do not send byte-range lock requests (some legacy apps need this). */
  nobrl: z.boolean().optional(),
  /** `actimeo=<n>` — attribute-cache lifetime, seconds. */
  actimeo: z.number().int().nonnegative().optional(),
  /** `rsize=<n>` — maximum read size, bytes. */
  rsize: z.number().int().positive().optional(),
  /** `wsize=<n>` — maximum write size, bytes. */
  wsize: z.number().int().positive().optional(),
  /** `sec=` authentication flavour (ntlmssp/ntlmv2/krb5/…). */
  sec: MountCifsSec.optional(),
  /** `iocharset=` — local charset for path conversion (e.g. utf8). */
  iocharset: MountCharset.optional(),
})
export type MountCifsOptions = z.infer<typeof MountCifsOptions>

/**
 * Inline CIFS credentials EXTRACTED from a hand-written fstab entry — the
 * `username=` / `password=` (and `domain=`) tokens some operators place directly
 * in the option list (a plaintext-secret anti-pattern; 18.5 forbids it). The
 * parser lifts them OUT of `passthrough` into this structured channel so the
 * plaintext password never rides the verbatim passthrough into a response.
 *
 * Held TRANSIENTLY, daemon-side only: it is NEVER serialized back into an fstab
 * line (`buildOptionTokens` ignores it) and the `password` is REDACTED (or the
 * whole channel dropped) before any value crosses the API boundary. Its sole
 * purpose is to MIGRATE the secret to the protected 0600 creds file on the next
 * operator-initiated save. `password` present ⇒ the plaintext secret still lives
 * inline and should be migrated.
 */
export const MountInlineCredentials = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  domain: z.string().optional(),
})
export type MountInlineCredentials = z.infer<typeof MountInlineCredentials>

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
  /**
   * fs_spec (device / `//host/share` / `host:/export`). Single-line — written
   *  verbatim as field 1 of an /etc/fstab line and as a `mount` argument.
   */
  spec: SingleLine,
  mountpoint: AbsolutePath,
  fstype: z.string(),
  options: MountOptions,
  /** CIFS credentials file referenced (`credentials=…`) — path only, never the secret. */
  credentialsFile: z.string().optional(),
  /**
   * Inline plaintext CIFS credentials lifted out of a hand-written fstab options
   * list (`username=`/`password=`/`domain=`). TRANSIENT, daemon-only — never
   * serialized back to fstab, password REDACTED/stripped before any response.
   * Drives one-time migration to the protected creds file on the next save.
   */
  inlineCredentials: MountInlineCredentials.optional(),
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
  /**
   * Remote host, parsed from the fstab spec / findmnt source (the inverse of the
   * write-side `buildSpec`). Present for remote kinds only (nfs/cifs) — the edit
   * dialog round-trips this back into the Server field. For CIFS `//host/share`
   * it is `host`; for NFS `host:/export` (incl. `[ipv6]:/export`) it is `host`.
   */
  server: z.string().optional(),
  /**
   * Remote path parsed from the spec — the NFS export (`/srv/export1`) or the
   * CIFS share (`share`, possibly multi-segment `share/sub`). Remote kinds only.
   */
  remotePath: z.string().optional(),
  /** x-systemd.automount configured. */
  automount: z.boolean(),
  /** Disabled-without-delete: fstab line marker-commented (`#ANAS `). Intentional. */
  disabled: z.boolean(),
  /** PVE-owned (read-only storage.cfg) — HANDS-OFF; every mutation is rejected. */
  pveManaged: z.boolean(),
  /** The owning PVE storage id, when pveManaged. */
  pveStorage: z.string().optional(),
  /**
   * ANAS Hybrid RAID (AHR) pool persistence — HANDS-OFF here; managed from the
   * Hybrid RAID view, and every Mounts mutation is rejected. Derived from the
   * ANAS-managed mdadm.conf ARRAY pins (§2.6): a pinned pool's LV spec
   * (`/dev/<pool>/<pool>-vol`) matched against the fstab entry — never the
   * mountpoint (operator-configurable).
   */
  ahrManaged: z.boolean(),
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

/**
 * CIFS credentials — WRITE-ONLY. Never returned in any response. All three
 * fields are written verbatim as `key=value` lines into a per-mount 0600 creds
 * file, so each must be single-line: a control character (newline especially)
 * would forge an extra creds line. Every printable password character — spaces,
 * punctuation, symbols — is preserved; only control characters (which a
 * line-based creds file cannot represent anyway) are rejected.
 */
export const MountCredentials = z.object({
  username: SingleLine.pipe(z.string().min(1)),
  password: SingleLine.pipe(z.string().min(1)),
  domain: SingleLine.optional(),
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
  noexec: z.boolean().optional(),
  /** _netdev — order after the network is up. Defaults on for remote when omitted. */
  netdev: z.boolean().optional(),
  /** x-systemd.idle-timeout seconds (automount). */
  idleTimeout: z.number().int().positive().optional(),
  // nfs
  vers: MountVers.optional(),
  hard: z.boolean().optional(),
  timeo: z.number().int().positive().optional(),
  retrans: z.number().int().nonnegative().optional(),
  rsize: z.number().int().positive().optional(),
  wsize: z.number().int().positive().optional(),
  proto: MountNfsProto.optional(),
  noac: z.boolean().optional(),
  nconnect: z.number().int().positive().max(16).optional(),
  bg: z.boolean().optional(),
  lookupcache: MountLookupCache.optional(),
  /** attribute-cache lifetime (seconds) — shared by nfs & cifs. */
  actimeo: z.number().int().nonnegative().optional(),
  /** authentication flavour — narrowed to the fstype's tier by the daemon. */
  sec: MountSec.optional(),
  // cifs
  domain: SingleLine.optional(),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  fileMode: MountMode.optional(),
  dirMode: MountMode.optional(),
  cache: MountCifsCache.optional(),
  mfsymlinks: z.boolean().optional(),
  forceuid: z.boolean().optional(),
  forcegid: z.boolean().optional(),
  noserverino: z.boolean().optional(),
  nobrl: z.boolean().optional(),
  iocharset: MountCharset.optional(),
})
export type MountRequestOptions = z.infer<typeof MountRequestOptions>

/** Create a mount (POST /v1/mounts): write fstab (if persistent) + mount now. */
export const CreateMountRequest = z.object({
  type: MountType,
  /** Remote host (NFS/CIFS). Single-line — folded into the fstab `spec`. */
  server: SingleLine.optional(),
  /**
   * NFS export path (`/srv/nfs/export1`) or CIFS share name (`anastest`).
   *  Single-line — folded into the fstab `spec`.
   */
  remotePath: SingleLine.optional(),
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
 * credential rotation. The mountpoint (identity), type, and source are fixed —
 * and so is `persistent`: an edit acts ON the fstab entry, so persistence is
 * edit-time IDENTITY (like type/server), not an editable field. It stays on
 * CreateMountRequest only; a body that still carries it is ignored (stripped).
 */
export const UpdateMountRequest = z.object({
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
  server: SingleLine.pipe(z.string().min(1)),
  /** NFS export path or CIFS share name. */
  remotePath: SingleLine.optional(),
  /** Version to request (NFS "4.2" default, CIFS "3.1.1" default). */
  vers: MountVers.optional(),
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
