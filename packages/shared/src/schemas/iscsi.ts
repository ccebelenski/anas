import { z } from 'zod'
import { hasControlChars, ISODateTime } from './common.js'

/**
 * iSCSI — block storage (iscsi epic, story `iscsi.2`: schemas + the READ layer).
 *
 * ANAS is the TARGET side only: a generic, standards-compliant iSCSI target on
 * LIO (the kernel target), driven by `targetcli-fb`. The read model has two
 * sources and they disagree on purpose:
 *
 *   - `/etc/rtslib-fb-target/saveconfig.json` — what is PERSISTED, i.e. what
 *     `targetctl restore` will rebuild at the next boot;
 *   - `/sys/kernel/config/target/` (configfs) — what is LIVE in the kernel now.
 *
 * Their difference is not noise, it is the product: a boot restore whose backing
 * device was missing reports systemd SUCCESS and silently drops the LUN
 * (docs/ISCSI-GROUND-TRUTH.md GT-20/GT-21), so the only way to know is to diff
 * the two. {@link IscsiHealth} is that diff.
 *
 * Nothing in this file ever carries a CHAP secret. LIO stores them in plaintext
 * in both sources (GT-12/GT-35); the read layer reduces them to
 * `credentialsSet` booleans before they leave the parser.
 */

// ---------------------------------------------------------------------------
// iSCSI names (IQNs) and the ANAS naming convention
// ---------------------------------------------------------------------------

/**
 * An iSCSI node name. RFC 3720 defines three formats and ANAS must be able to
 * READ all of them — a foreign target or a third-party initiator may use any —
 * even though ANAS only ever GENERATES the `iqn.` form:
 *
 *   iqn.YYYY-MM.<reversed domain>[:<unique string>]
 *   eui.<16 hex digits>
 *   naa.<16 or 32 hex digits>
 *
 * iSCSI names are case-insensitive but are required to be transmitted (and are
 * stored by LIO) in lowercase, so the pattern is lowercase-only. The 223-byte
 * cap is RFC 3720 §3.2.6. No control characters: the name is written verbatim
 * into a configfs directory name and a `targetcli` argument.
 */
const ISCSI_NAME_RE
  = /^(?:iqn\.\d{4}-\d{2}\.[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[a-z0-9._:-]+)?|eui\.[0-9a-f]{16}|naa\.[0-9a-f]{16}(?:[0-9a-f]{16})?)$/

/** A single legal IQN naming-authority label (a DNS label, lowercased). */
const IQN_LABEL_RE = /^[a-z0-9-]+$/

/** The `yyyy-mm` date field of an `iqn.` name. */
const IQN_DATE_RE = /^\d{4}-\d{2}$/

export const IscsiIqn = z
  .string()
  .min(1)
  .max(223, 'An iSCSI name is at most 223 characters (RFC 3720 §3.2.6)')
  .refine(s => !hasControlChars(s), 'Control characters are not allowed')
  .refine(
    s => ISCSI_NAME_RE.test(s),
    'Must be an iSCSI name: iqn.YYYY-MM.<reversed domain>[:<unique>], eui.<16 hex>, or naa.<16|32 hex>',
  )

/**
 * The naming-authority label ANAS appends to make an IQN self-identifying.
 *
 * There is no shadow state and no marker file: a target either LOOKS like one
 * ANAS generated or it does not. The convention is
 *
 *     iqn.<yyyy-mm>.<authority>:<name>
 *     authority = 'anas'                     (node has no domain)
 *               | '<reversed node domain>.anas'
 *
 * so `nas.example.com` yields `iqn.2026-08.com.example.nas.anas:vmstore` and a
 * domainless node yields `iqn.2026-08.anas:vmstore`. Recognition is
 * date-agnostic and domain-agnostic — it only asks whether the authority's last
 * label is `anas` — which matters because the node's domain and the creation
 * month are both things ANAS must not have to remember.
 */
export const ANAS_IQN_AUTHORITY_LABEL = 'anas'

/**
 * A user-facing target name — the `:<name>` half of an ANAS-generated IQN. Kept
 * to the lowercase iSCSI-name alphabet minus `:` and `.` so a name can never
 * forge extra IQN structure, and so the generated IQN round-trips through
 * {@link isAnasIqn}.
 */
export const IscsiTargetName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'Must start with a lowercase letter or digit and contain only lowercase letters, digits, or hyphens',
  )

/**
 * The naming authority ANAS uses for a node: the node's DNS domain reversed
 * with `.anas` appended, or the bare label `anas` when the node has no domain.
 * Non-conforming domain labels are dropped rather than smuggled into an IQN.
 */
export function anasIqnAuthority(domain?: string | null): string {
  // Built reversed as we go (`unshift`), which is the whole point of an IQN
  // naming authority: `nas.example.com` is written `com.example.nas`.
  const reversed: string[] = []
  for (const raw of (domain ?? '').toLowerCase().split('.')) {
    const label = raw.trim()
    if (label.length > 0 && IQN_LABEL_RE.test(label))
      reversed.unshift(label)
  }
  if (reversed.length === 0)
    return ANAS_IQN_AUTHORITY_LABEL
  reversed.push(ANAS_IQN_AUTHORITY_LABEL)
  return reversed.join('.')
}

/**
 * Generate the IQN for a new ANAS target. `date` defaults to now — the
 * `yyyy-mm` field is the date the naming authority was owned, which for our
 * purposes is creation time. Deterministic given its inputs, so the CREATE
 * story (`iscsi.4`) can generate and the READ layer can recognise with the same
 * one definition (there is no rename in LIO — GT-10 — so the IQN, once created,
 * is the target's identity for life).
 */
export function anasIqn(name: string, opts?: { domain?: string | null, date?: Date }): string {
  const d = opts?.date ?? new Date()
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  return `iqn.${yyyy}-${mm}.${anasIqnAuthority(opts?.domain)}:${name}`
}

/** Split an IQN into its `yyyy-mm`, authority and unique-string parts. */
function splitIqn(iqn: string): { date: string, authority: string, unique: string } | null {
  if (!iqn.startsWith('iqn.'))
    return null
  const rest = iqn.slice(4)
  const firstDot = rest.indexOf('.')
  if (firstDot < 0)
    return null
  const date = rest.slice(0, firstDot)
  if (!IQN_DATE_RE.test(date))
    return null
  const tail = rest.slice(firstDot + 1)
  const colon = tail.indexOf(':')
  if (colon < 0)
    return { date, authority: tail, unique: '' }
  return { date, authority: tail.slice(0, colon), unique: tail.slice(colon + 1) }
}

/**
 * Does this IQN follow the ANAS naming convention? True when the name parses as
 * an `iqn.` name whose naming authority's LAST label is `anas` and which carries
 * a non-empty unique string. Half of the ownership derivation — the other half
 * is that every LUN's backing object sits on ANAS-managed storage.
 */
export function isAnasIqn(iqn: string): boolean {
  const parts = splitIqn(iqn)
  if (!parts || parts.unique.length === 0)
    return false
  const labels = parts.authority.split('.')
  return labels.at(-1) === ANAS_IQN_AUTHORITY_LABEL
}

/** The user-facing target name inside an ANAS IQN, or null for a foreign one. */
export function anasTargetName(iqn: string): string | null {
  if (!isAnasIqn(iqn))
    return null
  return splitIqn(iqn)?.unique ?? null
}

// ---------------------------------------------------------------------------
// Zvol device paths — one definition, several readers
// ---------------------------------------------------------------------------

/**
 * `/dev/zvol/` — the STABLE zvol path prefix. A zvol's `/dev/zdN` kernel name
 * moves across a reboot (GT-48), so this is the only spelling ANAS stores,
 * matches or hands to another program. Defined here because three unrelated
 * readers need it: iSCSI ownership (`classifyBacking`), the backup consistency
 * derivation (an `img` archive whose source is a zvol, backup2.4), and the
 * snapshot-device path the backup runner publishes with `snapdev`.
 */
export const ZVOL_PATH_PREFIX = '/dev/zvol/'

/** Trailing slashes, stripped before a zvol path is turned into a dataset. */
const ZVOL_TRAILING_SLASH_RE = /\/+$/

/**
 * The ZFS dataset behind a `/dev/zvol/<pool>/<vol>` path, or null when the path
 * is not a zvol path at all. Pure string arithmetic — the path is never stat'ed
 * (the hang rule), and a bare `/dev/zvol/<pool>` with no volume is not a volume.
 */
export function zvolDatasetFromPath(path: string): string | null {
  if (!path.startsWith(ZVOL_PATH_PREFIX))
    return null
  const dataset = path.slice(ZVOL_PATH_PREFIX.length).replace(ZVOL_TRAILING_SLASH_RE, '')
  // `<pool>` alone is a directory of volumes, not a volume.
  if (!dataset || !dataset.includes('/'))
    return null
  return dataset
}

/** The stable device path of a zvol dataset (`tank/vol1` → `/dev/zvol/tank/vol1`). */
export function zvolDevicePath(dataset: string): string {
  return `${ZVOL_PATH_PREFIX}${dataset}`
}

// ---------------------------------------------------------------------------
// Ownership — derived, never stored (Principle 11; the 3.25 PVE-tagging pattern)
// ---------------------------------------------------------------------------

/**
 * Who a target belongs to. `anas` means ANAS generated it AND every LUN's
 * backing object lives on storage ANAS manages; everything else is `foreign` and
 * hands-off, exactly like a PVE-managed pool.
 */
export const IscsiOwnership = z.enum(['anas', 'foreign'])
export type IscsiOwnership = z.infer<typeof IscsiOwnership>

/**
 * WHY a target got the ownership it got — the derivation is shown, never
 * asserted, so the UI can explain a hands-off badge instead of just wearing it.
 *
 * - `anas-managed`            — the IQN is ANAS's and every LUN is on ANAS storage.
 * - `iqn-not-anas`            — the IQN was not generated by ANAS.
 * - `backing-pve-storage`     — a LUN's backing object is on a PVE-managed pool/dataset.
 * - `backing-pve-guest-disk`  — a LUN's backing object is a PVE guest volume (`vm-N-disk-M`).
 * - `backing-not-anas-storage` — a LUN's backing object is on storage ANAS does not manage.
 * - `no-luns`                 — the target has no LUNs at all, so nothing ties it to ANAS storage.
 */
export const IscsiOwnershipReason = z.enum([
  'anas-managed',
  'iqn-not-anas',
  'backing-pve-storage',
  'backing-pve-guest-disk',
  'backing-not-anas-storage',
  'no-luns',
])
export type IscsiOwnershipReason = z.infer<typeof IscsiOwnershipReason>

/** The ownership verdict plus the deciding fact, in words. */
export const IscsiOwnershipTag = z.object({
  ownership: IscsiOwnership,
  reason: IscsiOwnershipReason,
  /** One sentence naming the fact that decided it (an IQN, a LUN, a path). */
  detail: z.string(),
})
export type IscsiOwnershipTag = z.infer<typeof IscsiOwnershipTag>

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

/**
 * A network portal: the address:port a TPG listens on.
 *
 * `address` is NORMALISED — LIO stores an IPv6 portal bracketed
 * (`"[fd00:6774:0:1::1]"` in saveconfig, `np/[fd00:…]:3260` in configfs) and an
 * IPv4 one bare (GT-12/GT-13), so any comparison against a node address has to
 * strip the brackets first. They are stripped here, once.
 *
 * `carriedByInterface` answers the question LIO refuses to: a portal binds to an
 * address that does not exist, reports `[OK]`, survives the interface being
 * deleted and the service being restarted, and never logs a word (GT-24). It is
 * `null` when the node's addresses could not be read (fail-open, not "gone").
 */
export const IscsiPortal = z.object({
  /** Bare address — brackets stripped from IPv6. */
  address: z.string(),
  port: z.number().int().positive(),
  family: z.enum(['inet', 'inet6']),
  /** True when some interface on this node currently carries `address`. */
  carriedByInterface: z.boolean().nullable(),
  /** LIO's iSER flag; present in every portal record, unused by ANAS. */
  iser: z.boolean().optional(),
  /** LIO's offload flag; present in every portal record, unused by ANAS. */
  offload: z.boolean().optional(),
})
export type IscsiPortal = z.infer<typeof IscsiPortal>

// ---------------------------------------------------------------------------
// LUNs and backstores
// ---------------------------------------------------------------------------

/**
 * What a LUN is backed by, in ANAS's own vocabulary:
 *
 * - `zvol`    — a ZFS volume, `/dev/zvol/<pool>/<vol>` (the `block` plugin).
 * - `file`    — a raw image file on a dataset or an AHR pool (the `fileio` plugin).
 * - `foreign` — anything else: a plain block device, a pscsi/ramdisk backstore,
 *               or a path ANAS cannot resolve onto storage it knows.
 */
export const IscsiLunKind = z.enum(['zvol', 'file', 'foreign'])
export type IscsiLunKind = z.infer<typeof IscsiLunKind>

/** The backstore plugins LIO exposes. ANAS only ever creates the first two. */
export const ISCSI_BACKSTORE_PLUGINS = ['block', 'fileio', 'pscsi', 'ramdisk', 'user'] as const

/**
 * The attribute subset ANAS surfaces and (from `iscsi.4`) sets. LIO carries ~35
 * attributes per backstore; these five are the ones that change what an
 * initiator sees or what the storage does:
 *
 * - `emulateTpu` / `emulateTpws` — thin reclaim (UNMAP / WRITE SAME). Both ship
 *   OFF on both kinds (GT-26).
 * - `blockSize` — settable only BEFORE the backstore is mapped (GT-27), so it is
 *   a create-time choice and read-only thereafter.
 * - `writeBack` — the write cache. `fileio` ships write-back ON (GT-26), which
 *   is a crash-data-loss default, so the value has to be visible.
 * - `maxUnmapLbaCount` — the fileio default of 8192 (4 MiB) makes a whole-device
 *   discard fail outright (GT-30).
 *
 * Every field is optional: attributes are read from configfs, and a backstore
 * whose backing device went missing at boot restore has no configfs object at
 * all. Later daemons may add fields here; a client must tolerate that.
 */
export const IscsiLunAttributes = z.object({
  emulateTpu: z.boolean().optional(),
  emulateTpws: z.boolean().optional(),
  blockSize: z.number().int().positive().optional(),
  writeBack: z.boolean().optional(),
  maxUnmapLbaCount: z.number().int().nonnegative().optional(),
})
export type IscsiLunAttributes = z.infer<typeof IscsiLunAttributes>

/**
 * One LUN of one target.
 *
 * `serial` is the load-bearing field. LIO derives every identity an initiator
 * sees — the SCSI unit serial, the NAA WWN, both `/dev/disk/by-id` links, and
 * therefore **the PVE volid of any VM disk on this LUN** — from the backstore's
 * `wwn` (GT-14/GT-45). `wwn` is a CREATE-ONLY parameter with no `set` verb
 * (GT-16), and attributes are NOT carried across a recreate either (GT-18), so
 * every path that recreates a backstore has to replay `{serial, attributes}`.
 * That is why both travel together in this shape.
 *
 * `name` is not decoration: with `emulate_model_alias=1` and
 * `export_backstore_name_as_model=true` the backstore name IS the SCSI model
 * string the initiator reports and part of the VPD 0x83 designator (GT-15).
 *
 * `backingPath` is always the STABLE path (`/dev/zvol/<pool>/<vol>`, or the
 * image file). A `zdN` kernel name is never stored or matched — those numbers
 * move across a reboot (GT-48).
 */
export const IscsiLun = z.object({
  /** LUN number within the TPG — the `n` in `/v1/iscsi/targets/:iqn/luns/:n`. */
  index: z.number().int().nonnegative(),
  /** Backstore name = the SCSI model string initiators see. */
  name: z.string(),
  kind: IscsiLunKind,
  /** LIO backstore plugin (`block`, `fileio`, …) — see ISCSI_BACKSTORE_PLUGINS. */
  plugin: z.string(),
  /** Stable backing path: `/dev/zvol/<pool>/<vol>` or the image file. */
  backingPath: z.string(),
  /** Size in bytes; null when it could not be determined. */
  size: z.number().int().nonnegative().nullable(),
  /** SCSI unit serial (the backstore `wwn`), `T10 VPD…` prefix stripped. */
  serial: z.string().nullable(),
  attributes: IscsiLunAttributes,
  /** Initiator IQNs with a live session that maps this LUN. */
  connectedInitiators: z.array(z.string()),
  /**
   * Is the backstore live in configfs? False means the persisted config has this
   * LUN but the kernel does not — the GT-21 restore hole.
   */
  present: z.boolean(),
  /**
   * Does `backingPath` resolve on this node? A `zfs rename` under a live LUN
   * succeeds silently and leaves a dangling `udev_path` (GT-40), so a LUN whose
   * backing path does not resolve is BROKEN, not foreign. `null` when unchecked.
   */
  backingExists: z.boolean().nullable(),
  /** The ZFS pool the backing object lives on, when it resolves onto one. */
  pool: z.string().optional(),
  /** The ZFS dataset (zvol or the file's dataset), when it resolves onto one. */
  dataset: z.string().optional(),
})
export type IscsiLun = z.infer<typeof IscsiLun>

// ---------------------------------------------------------------------------
// Initiator ACLs
// ---------------------------------------------------------------------------

/**
 * An explicit initiator ACL. Under explicit ACLs — the only mode ANAS uses —
 * CHAP lives on the ACL, not the TPG (GT-32).
 *
 * There is NO secret here and there never will be. LIO keeps CHAP secrets in
 * plaintext in configfs and in saveconfig.json (GT-12/GT-35); the parser reduces
 * them to `credentialsSet` booleans and drops the values on the floor.
 */
export const IscsiAcl = z.object({
  initiatorIqn: z.string(),
  /** Incoming (one-way) CHAP username. Not a secret — sent in the clear. */
  chapUserid: z.string().nullable(),
  /** True when an incoming CHAP secret is set. NEVER the secret itself. */
  chapCredentialsSet: z.boolean(),
  /** Mutual (target-authenticates-to-initiator) CHAP username. */
  mutualUserid: z.string().nullable(),
  /** True when a mutual CHAP secret is set. NEVER the secret itself. */
  mutualCredentialsSet: z.boolean(),
  /**
   * LIO's `authenticate_target` flag — set automatically when a mutual secret is
   * written. Absent when the flag could not be read.
   */
  authenticateTarget: z.boolean().optional(),
  /** TPG LUN indexes mapped into this ACL. */
  mappedLuns: z.array(z.number().int().nonnegative()),
})
export type IscsiAcl = z.infer<typeof IscsiAcl>

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One TCP connection inside a session. */
export const IscsiSessionConnection = z.object({
  cid: z.number().int().nonnegative(),
  address: z.string(),
  /** Raw LIO connection state, e.g. `TARG_CONN_STATE_LOGGED_IN`. */
  state: z.string(),
})
export type IscsiSessionConnection = z.infer<typeof IscsiSessionConnection>

/**
 * A live iSCSI session, read from `acls/<initiator IQN>/info`.
 *
 * NOT from `dynamic_sessions` — that file only lists sessions of dynamically
 * generated ACLs (`generate_node_acls=1`), which ANAS never uses, so under the
 * design ANAS has chosen it is always empty (GT-38).
 *
 * `targetcli sessions detail`'s `(NOT AUTHENTICATED)` label is deliberately NOT
 * surfaced: it reflects `authenticate_target` (mutual CHAP), not whether the
 * initiator authenticated, and a one-way-CHAP session prints it (GT-39).
 */
export const IscsiSession = z.object({
  initiatorIqn: z.string(),
  /** InitiatorAlias — cosmetic, chosen by the initiator. */
  initiatorAlias: z.string().nullable(),
  targetIqn: z.string(),
  tpgTag: z.number().int().nonnegative(),
  /** LIO session id; null when the info block did not carry one. */
  sessionId: z.number().int().nonnegative().nullable(),
  /** Raw LIO session state, e.g. `TARG_SESS_STATE_LOGGED_IN`. */
  state: z.string(),
  connections: z.array(IscsiSessionConnection),
  /** TPG LUN indexes this initiator's ACL maps. */
  mappedLuns: z.array(z.number().int().nonnegative()),
})
export type IscsiSession = z.infer<typeof IscsiSession>

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** TPG-level switches that decide who can see and reach the target. */
export const IscsiTargetSecurity = z.object({
  /** `authentication=1` — CHAP enforced (per-ACL under explicit ACLs). */
  authentication: z.boolean(),
  /** `generate_node_acls=1` — LIO demo mode. ANAS never turns this on. */
  generateNodeAcls: z.boolean(),
  /** `demo_mode_discovery=1` — SendTargets discovery open to anyone (GT-31). */
  demoModeDiscovery: z.boolean(),
})
export type IscsiTargetSecurity = z.infer<typeof IscsiTargetSecurity>

/** The grid row: one target, enough to list it without reading its detail. */
export const IscsiTargetSummary = z.object({
  iqn: z.string(),
  /** The `:<name>` half for an ANAS target; null for a foreign one. */
  name: z.string().nullable(),
  ownership: IscsiOwnership,
  ownershipReason: IscsiOwnershipReason,
  /** One sentence explaining the ownership verdict. */
  ownershipDetail: z.string(),
  /** TPG tag — ANAS creates exactly one TPG per target (tag 1). */
  tpgTag: z.number().int().nonnegative(),
  /** TPG `enable` flag: 0 refuses new logins (the listener stays — GT-37). */
  enabled: z.boolean(),
  portals: z.array(IscsiPortal),
  lunCount: z.number().int().nonnegative(),
  aclCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  security: IscsiTargetSecurity,
  /** Live in configfs? False = persisted but not restored. */
  present: z.boolean(),
  /** Persisted in saveconfig.json? False = live but would not survive a boot. */
  persisted: z.boolean(),
  /** Count of this target's saveconfig LUNs with no configfs counterpart. */
  missingLunCount: z.number().int().nonnegative(),
  /** Count of this target's portals no live interface carries. */
  portalsWithoutInterfaceCount: z.number().int().nonnegative(),
})
export type IscsiTargetSummary = z.infer<typeof IscsiTargetSummary>

/** The detail window: the summary plus everything hanging off the target. */
export const IscsiTargetDetail = IscsiTargetSummary.extend({
  luns: z.array(IscsiLun),
  acls: z.array(IscsiAcl),
  sessions: z.array(IscsiSession),
})
export type IscsiTargetDetail = z.infer<typeof IscsiTargetDetail>

// ---------------------------------------------------------------------------
// Availability — "not installed" is a first-class state, never an error
// ---------------------------------------------------------------------------

/**
 * Whether the LIO stack is even here. A node without `targetcli-fb` has no
 * configfs target tree and no saveconfig.json; every iSCSI read reports that
 * honestly and returns empty collections rather than failing, so the rest of
 * ANAS keeps working on a node that serves no block storage.
 */
export const IscsiAvailability = z.object({
  /** True when the LIO target stack is usable (configfs target tree present). */
  installed: z.boolean(),
  /** Is `/sys/kernel/config/target/` present? */
  configfsPresent: z.boolean(),
  /** Is `/etc/rtslib-fb-target/saveconfig.json` present and parseable? */
  saveconfigPresent: z.boolean(),
  /** One sentence when `installed` is false; absent otherwise. */
  reason: z.string().optional(),
})
export type IscsiAvailability = z.infer<typeof IscsiAvailability>

/** `GET /v1/iscsi/targets`. */
export const IscsiTargetList = IscsiAvailability.extend({
  targets: z.array(IscsiTargetSummary),
})
export type IscsiTargetList = z.infer<typeof IscsiTargetList>

/** `GET /v1/iscsi/sessions` — every live session on the node. */
export const IscsiSessionList = IscsiAvailability.extend({
  sessions: z.array(IscsiSession),
})
export type IscsiSessionList = z.infer<typeof IscsiSessionList>

// ---------------------------------------------------------------------------
// Health — the saveconfig ⟷ configfs diff
// ---------------------------------------------------------------------------

/**
 * A LUN that `saveconfig.json` records but configfs does not have: the boot
 * restore skipped it because its backing device was missing, and reported
 * SUCCESS anyway (GT-20/GT-21). Nothing in systemd catches this; the diff is the
 * only detector.
 */
export const IscsiMissingLun = z.object({
  targetIqn: z.string(),
  tpgTag: z.number().int().nonnegative(),
  lunIndex: z.number().int().nonnegative(),
  backstoreName: z.string(),
  plugin: z.string(),
  /** The backing path the restore could not open. */
  backingPath: z.string(),
  /** Does that path exist now? Null when it could not be checked. */
  backingExists: z.boolean().nullable(),
})
export type IscsiMissingLun = z.infer<typeof IscsiMissingLun>

/**
 * A configured portal whose address no interface on this node carries. LIO binds
 * such a portal happily, shows it `[OK]`, keeps it across a service restart and
 * never logs a word (GT-24) — so ANAS computes this by diffing the configured
 * addresses against the node's own.
 */
export const IscsiPortalWithoutInterface = z.object({
  targetIqn: z.string(),
  tpgTag: z.number().int().nonnegative(),
  address: z.string(),
  port: z.number().int().positive(),
})
export type IscsiPortalWithoutInterface = z.infer<typeof IscsiPortalWithoutInterface>

/**
 * A live/persisted divergence that is NOT a missing LUN: something exists in the
 * kernel that the persisted config does not describe (it would vanish at the
 * next boot), or the persisted backing path no longer matches the live one.
 */
export const IscsiForeignChangeKind = z.enum([
  'target-not-persisted',
  'target-not-restored',
  'lun-not-persisted',
  'backing-path-changed',
  'portal-not-persisted',
  'portal-not-restored',
])
export type IscsiForeignChangeKind = z.infer<typeof IscsiForeignChangeKind>

export const IscsiForeignChange = z.object({
  kind: IscsiForeignChangeKind,
  targetIqn: z.string(),
  /** One sentence naming what differs. */
  detail: z.string(),
})
export type IscsiForeignChange = z.infer<typeof IscsiForeignChange>

/**
 * `GET /v1/iscsi/health` — the persisted ⟷ live diff.
 *
 * Shaped so a later `collectIscsiWarnings` (story `iscsi.5`, which owns the
 * dashboard wiring) can turn it into warnings without re-reading anything: each
 * array element already carries its own target reference and a rendered
 * sentence. `iscsi.2` deliberately does NOT wire the dashboard.
 *
 * `degraded` is the guard `iscsi.4`/`iscsi.5` need before ever running
 * `saveconfig`: a save over an incomplete restore persists the hole and the LUN
 * is gone for good (GT-22).
 */
export const IscsiHealth = IscsiAvailability.extend({
  missingLuns: z.array(IscsiMissingLun),
  portalsWithoutInterface: z.array(IscsiPortalWithoutInterface),
  foreignChanges: z.array(IscsiForeignChange),
  /**
   * True when the live config is known to be an INCOMPLETE restore (any missing
   * LUN). While this is true nothing may run `saveconfig`.
   */
  degraded: z.boolean(),
  /**
   * True when the node's interface addresses could not be read, so
   * `portalsWithoutInterface` is "unknown", not "none" (fail-open).
   */
  interfacesUnknown: z.boolean(),
  checkedAt: ISODateTime,
})
export type IscsiHealth = z.infer<typeof IscsiHealth>
