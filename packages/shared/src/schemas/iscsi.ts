import { z } from 'zod'
import { hasControlChars, ISODateTime, SingleLine } from './common.js'

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
 *
 * The naming authority of an `iqn.` name needs at least TWO labels, because
 * that is what **rtslib itself** enforces before it will create the target:
 * its wwn pattern is `iqn.<yyyy>-<mm>.<label>(.<label>)+`, so a
 * single-label authority like `iqn.2026-08.anas:vmstore` is rejected by the
 * layer underneath ANAS. Accepting it here would only move the failure from a
 * clear 400 to an opaque `targetcli` exit 1 half-way through a create.
 */
const ISCSI_NAME_RE
  = /^(?:iqn\.\d{4}-\d{2}\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[a-z0-9._:-]+)?|eui\.[0-9a-f]{16}|naa\.[0-9a-f]{16}(?:[0-9a-f]{16})?)$/

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
    'Must be an iSCSI name: iqn.YYYY-MM.<reversed domain, at least two labels>[:<unique>], eui.<16 hex>, or naa.<16|32 hex>',
  )

/**
 * The naming-authority label ANAS appends to make an IQN self-identifying.
 *
 * There is no shadow state and no marker file: a target either LOOKS like one
 * ANAS generated or it does not. The convention is one line —
 *
 *     authority = reverse('anas.' + <node name>)
 *     iqn.<yyyy-mm>.<authority>:<target name>
 *
 * — so the node `nas.example.com` yields
 * `iqn.2026-08.com.example.nas.anas:vmstore` and the domainless node `nas`
 * yields `iqn.2026-08.nas.anas:vmstore`. The node's SHORT name is a label like
 * any other, not a missing domain: dropping it would leave the single-label
 * authority `anas`, which **rtslib refuses to create** (its wwn pattern demands
 * at least two labels), so the domainless case has to carry the hostname to be
 * legal at all.
 *
 * Recognition is date-agnostic and node-agnostic — it only asks whether the
 * authority's LAST label is `anas` — which matters because the node's name and
 * the creation month are both things a stateless daemon must not have to
 * remember. A node that is renamed keeps serving the targets it created.
 */
export const ANAS_IQN_AUTHORITY_LABEL = 'anas'

/**
 * The label that stands in for a node whose name yielded nothing usable — an
 * empty hostname, or one made entirely of characters an IQN label cannot carry.
 * It exists so the authority always has the two labels rtslib requires; it is
 * not expected to be reached on a real node.
 */
export const ANAS_IQN_FALLBACK_NODE_LABEL = 'node'

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
 * The naming authority ANAS uses for a node: the node's name reversed with
 * `anas` appended.
 *
 * `nodeName` is the whole thing the node calls itself — `nas` or
 * `nas.example.com`, whichever `hostname()` gives — not just a domain part.
 * Non-conforming labels are dropped rather than smuggled into an IQN, and if
 * that leaves nothing at all the fallback label keeps the authority legal (see
 * {@link ANAS_IQN_FALLBACK_NODE_LABEL}).
 */
export function anasIqnAuthority(nodeName?: string | null): string {
  // Built reversed as we go (`unshift`), which is the whole point of an IQN
  // naming authority: `nas.example.com` is written `com.example.nas`.
  const reversed: string[] = []
  for (const raw of (nodeName ?? '').toLowerCase().split('.')) {
    const label = raw.trim()
    if (label.length > 0 && IQN_LABEL_RE.test(label))
      reversed.unshift(label)
  }
  if (reversed.length === 0)
    reversed.push(ANAS_IQN_FALLBACK_NODE_LABEL)
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
export function anasIqn(name: string, opts?: { nodeName?: string | null, date?: Date }): string {
  const d = opts?.date ?? new Date()
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  return `iqn.${yyyy}-${mm}.${anasIqnAuthority(opts?.nodeName)}:${name}`
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
 * an `iqn.` name whose naming authority ends in the label `anas`, carries at
 * least one label BEFORE it (the node's own name — and the minimum rtslib will
 * create), and has a non-empty unique string. Half of the ownership derivation;
 * the other half is that every LUN's backing object sits on ANAS-managed
 * storage.
 *
 * Recognition deliberately ignores WHICH node label precedes `anas`: a node that
 * has been renamed, or a pool imported from a sibling node, still shows its ANAS
 * targets as ANAS targets. The alternative would be a stored node name, which is
 * the shadow state Principle 11 forbids.
 */
export function isAnasIqn(iqn: string): boolean {
  const parts = splitIqn(iqn)
  if (!parts || parts.unique.length === 0)
    return false
  const labels = parts.authority.split('.')
  return labels.length >= 2 && labels.at(-1) === ANAS_IQN_AUTHORITY_LABEL
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
 * - `backing-unresolved`      — ANAS's IQN, but at least one LUN's backing resolves
 *                               onto nothing right now (the boot-restore hole). Still
 *                               `anas`: see below.
 * - `no-luns`                 — ANAS's IQN with no LUNs at all — a target just created,
 *                               or one whose whole pool was late at boot (GT-21). Still
 *                               `anas`.
 * - `iqn-not-anas`            — the IQN was not generated by ANAS.
 * - `backing-pve-storage`     — a LUN's backing object is on a PVE-managed pool/dataset.
 * - `backing-pve-guest-disk`  — a LUN's backing object is a PVE guest volume (`vm-N-disk-M`).
 * - `backing-not-anas-storage` — a LUN's backing object is on storage ANAS does not manage.
 *
 * The last three are the ONLY reasons that make a target foreign, and that is
 * the rule of story `iscsi.5`: **the ANAS IQN convention is authoritative for
 * `anas`, and only a backing that POSITIVELY resolves onto PVE-managed or
 * non-ANAS storage takes a target away.** An absence proves nothing about
 * ownership — a pool that is not imported yet, an image on a mount that has not
 * come up, a target that has no LUNs at all are all ANAS's problem to fix, and
 * handing them a hands-off badge would take away the tools at exactly the moment
 * they are needed.
 */
export const IscsiOwnershipReason = z.enum([
  'anas-managed',
  'backing-unresolved',
  'no-luns',
  'iqn-not-anas',
  'backing-pve-storage',
  'backing-pve-guest-disk',
  'backing-not-anas-storage',
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
 * What a LUN is backed by, in ANAS's own vocabulary. Four tiers, and the last
 * two are deliberately NOT the same thing (story `iscsi.5`, live-proof F2):
 *
 * - `zvol`       — a ZFS volume, `/dev/zvol/<pool>/<vol>` (the `block` plugin).
 * - `file`       — a raw image on a dataset or an AHR pool (the `fileio` plugin).
 * - `foreign`    — a backing that POSITIVELY resolves onto something ANAS does
 *                  not manage: a plain block device, a pscsi/ramdisk backstore,
 *                  a file on non-ANAS storage. It is there, and it is not ours.
 * - `unresolved` — a backing that resolves onto NO known storage right now: the
 *                  pool is exported, the dataset is gone, the image file is
 *                  absent. This is the boot-restore hole, not a foreign object,
 *                  and it must never be read as one — a file LUN on an exported
 *                  pool used to flip its own ANAS target to hands-off, which is
 *                  precisely the state the operator needs the tools for.
 *
 * The dividing line is existence, not naming: `unresolved` is only ever reported
 * when the backing path has actually been checked and is NOT there.
 */
export const IscsiLunKind = z.enum(['zvol', 'file', 'foreign', 'unresolved'])
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
 * A target that restored with NONE of its LUNs — the whole-pool-late case
 * (GT-21): the target comes up, the TPG is enabled, all three portals listen,
 * an initiator logs in successfully and sees no disks at all. systemd reported
 * success throughout.
 *
 * It is a separate finding from the per-LUN holes it is made of, because the
 * consequence is different in kind: one missing LUN is a disk that vanished,
 * every missing LUN is a target that is lying about being ready.
 */
export const IscsiTargetServingNothing = z.object({
  targetIqn: z.string(),
  tpgTag: z.number().int().nonnegative(),
  /** How many LUNs the SAVED configuration has for this target. */
  persistedLunCount: z.number().int().nonnegative(),
  /** Is the TPG accepting logins while it has nothing behind it? */
  enabled: z.boolean(),
})
export type IscsiTargetServingNothing = z.infer<typeof IscsiTargetServingNothing>

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
 * Shaped so `collectIscsiWarnings` (story `iscsi.5`, `services/iscsi-warnings.ts`)
 * can turn it into dashboard cards without re-reading anything: each array
 * element already carries its own target reference and enough facts to render a
 * sentence.
 *
 * `degraded` is the guard `iscsi.4`/`iscsi.5` need before ever running
 * `saveconfig`: a save over an incomplete restore persists the hole and the LUN
 * is gone for good (GT-22). It is also the ONLY state in which
 * `POST /v1/iscsi/health/repair` has anything to do.
 */
export const IscsiHealth = IscsiAvailability.extend({
  missingLuns: z.array(IscsiMissingLun),
  /** Targets that came up with none of their saved LUNs (GT-21). */
  targetsServingNothing: z.array(IscsiTargetServingNothing),
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

// ===========================================================================
// Mutations (story `iscsi.4`) — the iSCSI menu's write half
// ===========================================================================
//
// Everything below is a REQUEST shape. Two rules run through all of them:
//
//  1. **No secret ever comes back.** A CHAP secret travels one way only. The
//     read shapes above carry `chapCredentialsSet` / `mutualCredentialsSet`
//     booleans and nothing else, and the daemon writes the secret straight into
//     configfs — never onto `targetcli`'s argv, never into journald (GT-35).
//  2. **value / null / omitted mean set / clear / keep** (the standing
//     dialog↔daemon ruling), applied per field. A collection field
//     (`portals`, `acls`) present at all is the COMPLETE desired set; absent
//     keeps what is there. That is what lets an untouched edit send nothing.

/** The 12–16 byte CHAP secret range initiators enforce and LIO does not. */
export const ISCSI_CHAP_SECRET_MIN_BYTES = 12
export const ISCSI_CHAP_SECRET_MAX_BYTES = 16

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * A CHAP secret, 12–16 bytes.
 *
 * LIO validates the length **not at all** — 1, 7, 8, 12, 16 and 20-character
 * secrets were all accepted and written to configfs verbatim (GT-34). The
 * 12–16-byte rule is a CLIENT rule (Windows enforces it, and an initiator that
 * refuses an 8-byte secret is indistinguishable from a wrong one at the target),
 * so if ANAS wants it, ANAS has to be the one enforcing it. It does, here, at
 * the boundary — once, for every caller.
 *
 * Measured in BYTES, not characters: the secret is written as UTF-8 into a
 * configfs file, and 16 characters of non-ASCII would overrun an initiator's
 * 16-byte field.
 */
export const IscsiChapSecret = z
  .string()
  .refine(s => !hasControlChars(s), 'Control characters are not allowed in a CHAP secret')
  .refine(
    s => utf8Length(s) >= ISCSI_CHAP_SECRET_MIN_BYTES && utf8Length(s) <= ISCSI_CHAP_SECRET_MAX_BYTES,
    `A CHAP secret must be ${ISCSI_CHAP_SECRET_MIN_BYTES}–${ISCSI_CHAP_SECRET_MAX_BYTES} bytes (initiators enforce this range; the target does not)`,
  )

/**
 * A CHAP username. NOT a secret — it crosses the wire in the clear during the
 * CHAP exchange — but it is written into a configfs value file, so it is held
 * to printable non-space ASCII.
 */
export const IscsiChapUserid = z
  .string()
  .min(1)
  .max(255)
  // Printable ASCII, space excluded: U+0021 '!' through U+007E '~'. Spelled with
  // the escapes rather than the literal range so the bounds are unambiguous.
  .regex(/^[\u0021-\u007E]+$/, 'A CHAP username must be printable ASCII with no spaces')

/**
 * How a target authenticates its initiators.
 *
 * - `none`        — ACLs only. An initiator not in the ACL list is refused at
 *                   login (`generate_node_acls=0`, LIO's default and the only
 *                   mode ANAS uses — GT-31).
 * - `chap`        — one-way CHAP: the initiator proves itself to the target.
 * - `mutual-chap` — both directions; LIO flips `authenticate_target` itself the
 *                   moment a mutual secret is written (GT-32).
 *
 * Under explicit ACLs the credentials live on the ACL, not the TPG: setting
 * `authentication=1` makes LIO ignore TPG-level userid/password entirely, and a
 * login with no PER-ACL credentials is refused even when the TPG carries a valid
 * pair (GT-32).
 */
export const IscsiAuthMode = z.enum(['none', 'chap', 'mutual-chap'])
export type IscsiAuthMode = z.infer<typeof IscsiAuthMode>

// ---------------------------------------------------------------------------
// Portal addresses
// ---------------------------------------------------------------------------

/** A dotted-quad shape; the range check is done per octet below. */
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** A bracketed literal, `[…]` — how LIO STORES an IPv6 portal (GT-12/GT-13). */
const BRACKET_RE = /^\[(.+)\]$/

/** IPv6 link-local, `fe80::/10` — LIO refuses to create a portal on one (GT-25). */
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f]{0,2}:/i

/** IPv4 link-local, `169.254.0.0/16`. */
const IPV4_LINK_LOCAL_RE = /^169\.254\./

/** One IPv6 hextet. */
const HEXTET_RE = /^[0-9a-f]{1,4}$/i

/** The wildcard addresses a portal must never be bound to (the threat model). */
const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::'])

function isIpv4(s: string): boolean {
  if (!IPV4_RE.test(s))
    return false
  return s.split('.').every((o) => {
    const n = Number(o)
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === o
  })
}

/**
 * A pragmatic IPv6 literal check: hex groups separated by colons, at most one
 * `::` elision, an optional trailing dotted-quad, and no zone id (LIO has no
 * scope-id support, which is exactly why link-local fails — GT-25).
 */
function isIpv6(s: string): boolean {
  if (!s.includes(':') || s.includes('%'))
    return false
  const elisions = s.split('::').length - 1
  if (elisions > 1)
    return false
  const [head, tail] = elisions === 1 ? s.split('::') : [s, '']
  const split = (segment: string): string[] => (segment === '' ? [] : segment.split(':'))
  const all = [...split(head), ...split(tail)]
  if (all.includes(''))
    return false
  let groups = all.length
  const last = all.at(-1)
  if (last !== undefined && last.includes('.')) {
    // A trailing dotted-quad occupies two hextets (`::ffff:192.0.2.1`).
    if (!isIpv4(last))
      return false
    groups += 1
    all.pop()
  }
  if (!all.every(p => HEXTET_RE.test(p)))
    return false
  return elisions === 1 ? groups <= 7 : groups === 8
}

/** Strip the brackets LIO stores an IPv6 portal with. Idempotent. */
export function unbracketAddress(address: string): string {
  const trimmed = address.trim()
  return BRACKET_RE.exec(trimmed)?.[1] ?? trimmed
}

/** The family of an IP literal (bare or bracketed), or null when it is not one. */
export function ipFamily(address: string): 'inet' | 'inet6' | null {
  const bare = unbracketAddress(address)
  if (isIpv4(bare))
    return 'inet'
  if (isIpv6(bare))
    return 'inet6'
  return null
}

/**
 * A portal address: an IP LITERAL this node carries, never a hostname (LIO
 * binds addresses).
 *
 * Three things are refused here rather than downstream:
 *
 *  - **A hostname.** `targetcli` would resolve it and bind whatever came back,
 *    which is not a decision a storage target should make silently.
 *  - **A wildcard** (`0.0.0.0`, `::`). This is the epic's threat model in one
 *    line — a portal is bound to a CHOSEN address. It is also exactly what
 *    `auto_add_default_portal` creates behind ANAS's back on target create
 *    (GT-8), and which the create sequence deletes.
 *  - **A link-local address.** LIO refuses it outright ("Could not create
 *    NetworkPortal in configFS", exit 1) because it has no scope-id support
 *    (GT-25), so refusing it here turns an opaque failure into a sentence.
 *
 * The value is NORMALISED to the bare form: LIO stores an IPv6 portal bracketed
 * and an IPv4 one bare (GT-12), so brackets are stripped once, here.
 */
export const IscsiPortalAddress = z
  .string()
  .min(1)
  .max(64)
  .transform(s => unbracketAddress(s))
  .refine(
    s => !WILDCARD_ADDRESSES.has(s),
    'A portal must be bound to a specific address, never the wildcard — pick one of this node\'s addresses',
  )
  .refine(
    s => ipFamily(s) !== null,
    'Must be an IPv4 or IPv6 address literal (a portal binds an address, not a hostname)',
  )
  .refine(
    s => !IPV6_LINK_LOCAL_RE.test(s) && !IPV4_LINK_LOCAL_RE.test(s),
    'A link-local address cannot carry an iSCSI portal (LIO has no scope-id support and refuses it)',
  )

/** The IANA iSCSI port; LIO defaults to it and so does ANAS. */
export const ISCSI_DEFAULT_PORT = 3260

/** One requested network portal. */
export const IscsiPortalRequest = z.object({
  address: IscsiPortalAddress,
  port: z.number().int().min(1).max(65535).default(ISCSI_DEFAULT_PORT),
})
export type IscsiPortalRequest = z.infer<typeof IscsiPortalRequest>

// ---------------------------------------------------------------------------
// ACLs
// ---------------------------------------------------------------------------

/**
 * One explicit initiator ACL, as requested.
 *
 * The four credential fields follow the standing per-field contract exactly:
 * a **value** sets, **null** clears, and an **omitted** field keeps whatever is
 * there. That is what makes a secret rotation optional on an edit — the dialog
 * leaves the password box blank and simply does not send the key, the mounts
 * precedent — while still allowing an explicit "take the CHAP credentials off
 * this initiator" without deleting and recreating the ACL, which would drop its
 * session instantly and silently (GT-36).
 */
export const IscsiAclRequest = z.object({
  initiatorIqn: IscsiIqn,
  chapUserid: IscsiChapUserid.nullable().optional(),
  /** WRITE-ONLY. Never returned; written straight to configfs, never argv. */
  chapSecret: IscsiChapSecret.nullable().optional(),
  mutualUserid: IscsiChapUserid.nullable().optional(),
  /** WRITE-ONLY. Never returned; written straight to configfs, never argv. */
  mutualSecret: IscsiChapSecret.nullable().optional(),
})
export type IscsiAclRequest = z.infer<typeof IscsiAclRequest>

/** What an ACL must carry to be able to log in under a given auth mode. */
export interface IscsiAclCredentialState {
  chapUserid?: string | null
  chapSecret?: string | null
  mutualUserid?: string | null
  mutualSecret?: string | null
}

/**
 * Does this ACL carry what `auth` needs to be usable?
 *
 * Shared by the create-time schema refinement (nothing is stored yet, so the
 * request has to be complete) and by the daemon's edit path (where an omitted
 * secret means the stored one still stands), so "CHAP is on but this initiator
 * can never log in" is one rule, not two.
 */
export function aclSatisfiesAuth(acl: IscsiAclCredentialState, auth: IscsiAuthMode): boolean {
  if (auth === 'none')
    return true
  const oneWay = !!acl.chapUserid && !!acl.chapSecret
  if (auth === 'chap')
    return oneWay
  return oneWay && !!acl.mutualUserid && !!acl.mutualSecret
}

/** The sentence a caller gets when an ACL could not log in under `auth`. */
export function aclAuthRequirement(auth: IscsiAuthMode): string {
  return auth === 'mutual-chap'
    ? 'mutual CHAP needs a username and a secret in BOTH directions on every initiator ACL'
    : 'CHAP needs a username and a secret on every initiator ACL — under explicit ACLs LIO ignores TPG-level credentials entirely'
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * `POST /v1/iscsi/targets`.
 *
 * `name` is the user-facing half; the IQN is GENERATED from it by `anasIqn` and
 * is immutable afterwards — LIO has no rename (GT-10), so a "rename" is a new
 * target and the dialog says so.
 */
export const CreateIscsiTargetRequest = z
  .object({
    name: IscsiTargetName,
    /** At least one — a target with no portal listens nowhere. */
    portals: z.array(IscsiPortalRequest).min(1, 'A target needs at least one portal'),
    auth: IscsiAuthMode.default('none'),
    acls: z.array(IscsiAclRequest).default([]),
  })
  .superRefine((req, ctx) => {
    const seen = new Set<string>()
    for (const p of req.portals) {
      const key = `${p.address.toLowerCase()}:${p.port}`
      if (seen.has(key))
        ctx.addIssue({ code: 'custom', path: ['portals'], message: `Portal ${p.address}:${p.port} is listed twice` })
      seen.add(key)
    }
    const iqns = new Set<string>()
    for (const a of req.acls) {
      if (iqns.has(a.initiatorIqn))
        ctx.addIssue({ code: 'custom', path: ['acls'], message: `Initiator ${a.initiatorIqn} is listed twice` })
      iqns.add(a.initiatorIqn)
      if (!aclSatisfiesAuth(a, req.auth)) {
        ctx.addIssue({
          code: 'custom',
          path: ['acls'],
          message: `Initiator ${a.initiatorIqn} would never be able to log in: ${aclAuthRequirement(req.auth)}`,
        })
      }
    }
  })
export type CreateIscsiTargetRequest = z.infer<typeof CreateIscsiTargetRequest>

/**
 * `PUT /v1/iscsi/targets/:iqn`.
 *
 * Every field is optional and OMISSION MEANS KEEP, so an untouched edit sends
 * `{}` and rewrites nothing. A collection that IS present is the complete
 * desired set — the daemon diffs it against the live one and issues only the
 * creates and deletes that differ, because an ACL delete is not a metadata edit:
 * it drops that initiator's session instantly and destroys its CHAP credentials
 * (GT-36).
 */
export const UpdateIscsiTargetRequest = z
  .object({
    portals: z.array(IscsiPortalRequest).min(1, 'A target needs at least one portal').optional(),
    acls: z.array(IscsiAclRequest).optional(),
    auth: IscsiAuthMode.optional(),
  })
  .superRefine((req, ctx) => {
    const seen = new Set<string>()
    for (const p of req.portals ?? []) {
      const key = `${p.address.toLowerCase()}:${p.port}`
      if (seen.has(key))
        ctx.addIssue({ code: 'custom', path: ['portals'], message: `Portal ${p.address}:${p.port} is listed twice` })
      seen.add(key)
    }
    const iqns = new Set<string>()
    for (const a of req.acls ?? []) {
      if (iqns.has(a.initiatorIqn))
        ctx.addIssue({ code: 'custom', path: ['acls'], message: `Initiator ${a.initiatorIqn} is listed twice` })
      iqns.add(a.initiatorIqn)
    }
  })
export type UpdateIscsiTargetRequest = z.infer<typeof UpdateIscsiTargetRequest>

/**
 * `POST /v1/iscsi/targets/:iqn/state` — the TPG `enable` flag.
 *
 * `disable` refuses NEW logins and makes discovery return nothing, but the
 * portal socket stays open and an established session keeps running (GT-37); the
 * UI says so rather than implying the target went away.
 */
export const IscsiTargetStateRequest = z.object({
  action: z.enum(['enable', 'disable']),
})
export type IscsiTargetStateRequest = z.infer<typeof IscsiTargetStateRequest>

// ---------------------------------------------------------------------------
// LUNs
// ---------------------------------------------------------------------------

/** How many characters of a LUN name a standard INQUIRY actually shows (GT-15). */
export const ISCSI_LUN_NAME_INQUIRY_CHARS = 16

/**
 * A LUN's name — and therefore the SCSI MODEL STRING every initiator sees.
 *
 * This is not an internal handle. With `emulate_model_alias=1` and targetcli's
 * `export_backstore_name_as_model=true`, the backstore name is what INQUIRY
 * reports as the product identification, what `lsblk MODEL` shows on the
 * initiator, and part of the VPD 0x83 T10 designator `<name>:<serial>` (GT-15).
 * Standard INQUIRY pads it to 16 characters, so only the first 16 are visible
 * there — longer names are legal and useful in the ANAS UI, just truncated in
 * that one field.
 *
 * It is also a configfs directory name, hence the conservative alphabet.
 */
export const IscsiLunName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][\w.-]*$/i,
    'Must start with a letter or digit and contain only letters, digits, underscore, dot or hyphen',
  )

/**
 * The logical block size an initiator sees. Settable ONLY before the backstore
 * is mapped — on an activated one `set attribute block_size=` fails with
 * `[Errno 22] Invalid argument` (GT-27) — so it is a create-time choice and
 * read-only thereafter. Omitted keeps LIO's 512.
 */
export const IscsiBlockSize = z.union([
  z.literal(512),
  z.literal(1024),
  z.literal(2048),
  z.literal(4096),
])
export type IscsiBlockSize = z.infer<typeof IscsiBlockSize>

/** The two backing kinds ANAS creates. `foreign` is a READ verdict, never a request. */
export const IscsiLunCreateKind = z.enum(['zvol', 'file'])
export type IscsiLunCreateKind = z.infer<typeof IscsiLunCreateKind>

/**
 * `POST /v1/iscsi/targets/:iqn/luns`.
 *
 * `backing` means one of two things, and the kind says which:
 *
 *  - `zvol` — an EXISTING ANAS-managed ZFS volume, named as a dataset
 *    (`tank/vol1`) or as its stable device path (`/dev/zvol/tank/vol1`). A PVE
 *    guest volume (`vm-101-disk-0`) and anything on a PVE-managed pool are never
 *    eligible. `size` must be absent: a zvol already has one, and growing it is
 *    the PUT.
 *  - `file` — the ZFS dataset or AHR pool that will HOST a new sparse raw image
 *    (`tank/images`, `ahrpool`, or an absolute directory). `size` is required
 *    and then fixed: a fileio backstore's size is set at creation and cannot be
 *    changed in place (GT-29), which is why the PUT recreates it.
 */
export const AddIscsiLunRequest = z
  .object({
    name: IscsiLunName,
    kind: IscsiLunCreateKind,
    backing: SingleLine.pipe(z.string().min(1).max(4096)),
    /** `file` only: the image size in bytes. */
    size: z.number().int().positive().optional(),
    blockSize: IscsiBlockSize.optional(),
  })
  .superRefine((req, ctx) => {
    if (req.kind === 'file' && req.size === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: 'An image-file LUN needs a size — a fileio backstore\'s size is fixed at creation and can only be changed by recreating it',
      })
    }
    if (req.kind === 'zvol' && req.size !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: 'A zvol LUN takes its size from the volume — grow the volume instead',
      })
    }
    if (req.backing.includes('..'))
      ctx.addIssue({ code: 'custom', path: ['backing'], message: 'Path traversal is not allowed' })
  })
export type AddIscsiLunRequest = z.infer<typeof AddIscsiLunRequest>

/**
 * `PUT /v1/iscsi/targets/:iqn/luns/:n` — grow, or change the write cache.
 *
 * A SHRINK is refused: ZFS truncates a zvol silently even under a live session
 * (GT-40), and a fileio recreate at a smaller size throws away whatever was past
 * the new end. There is no safe way to take blocks away from a block device from
 * the outside, so that is a Level 1 refusal with no confirm bypass.
 */
export const UpdateIscsiLunRequest = z
  .object({
    /** The new size in BYTES. Must be ≥ the current size. */
    size: z.number().int().positive().optional(),
    /**
     * `emulate_write_cache`. LIO ships fileio with write-back ON — an unflushed
     * write is lost on a crash (GT-26) — so ANAS creates every LUN with it OFF
     * and only an explicit, warned choice turns it back on.
     */
    writeBack: z.boolean().optional(),
  })
  .refine(
    req => req.size !== undefined || req.writeBack !== undefined,
    'Nothing to change — send a size or a writeBack',
  )
export type UpdateIscsiLunRequest = z.infer<typeof UpdateIscsiLunRequest>

/** Boolean-ish query flag (a query string carries `?flag=true`, not a boolean). */
export const IscsiQueryFlag = z
  .union([z.boolean(), z.enum(['true', '1', 'false', '0'])])
  .transform(v => v === true || v === 'true' || v === '1')

/**
 * `DELETE /v1/iscsi/targets/:iqn/luns/:n`.
 *
 * Unmapping and deleting the backstore always happens. `destroyBacking` also
 * destroys the object underneath — the zvol or the image file — and is
 * confirm-gated, because that is the one irreversible half.
 */
export const DeleteIscsiLunQuery = z.object({
  destroyBacking: IscsiQueryFlag.default(false),
})
export type DeleteIscsiLunQuery = z.infer<typeof DeleteIscsiLunQuery>

// ---------------------------------------------------------------------------
// The cross-feature seam (story `iscsi.6` consumes this)
// ---------------------------------------------------------------------------

/**
 * One backing object a LUN currently holds — the answer to "is this zvol / image
 * / dataset held by a LUN?" that Pools, Datasets, AHR and Mounts need before they
 * destroy, rename, roll back or unmount anything.
 *
 * It is a shared shape rather than a daemon-private one because `iscsi.6` turns
 * it into refusal text in several places, and a rendered sentence must not be
 * written twice.
 */
export const IscsiClaim = z.object({
  /** The stable backing path: `/dev/zvol/<pool>/<vol>` or the image file. */
  backingPath: z.string(),
  kind: IscsiLunKind,
  /** The ZFS pool the object sits on, when it resolves onto one. */
  pool: z.string().optional(),
  /** The ZFS dataset (the zvol itself, or the image's dataset). */
  dataset: z.string().optional(),
  targetIqn: z.string(),
  tpgTag: z.number().int().nonnegative(),
  lunIndex: z.number().int().nonnegative(),
  backstoreName: z.string(),
  /** Initiator IQNs with a live session mapping this LUN. */
  connectedInitiators: z.array(z.string()),
  /** One sentence naming the holder, ready to append to a refusal. */
  detail: z.string(),
})
export type IscsiClaim = z.infer<typeof IscsiClaim>

/** `iscsiClaims()` — every backing object currently mapped into a LUN. */
export const IscsiClaimList = IscsiAvailability.extend({
  claims: z.array(IscsiClaim),
})
export type IscsiClaimList = z.infer<typeof IscsiClaimList>
