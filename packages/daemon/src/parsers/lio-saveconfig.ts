/**
 * Parser for `/etc/rtslib-fb-target/saveconfig.json` — LIO's PERSISTED target
 * configuration, the file `targetctl restore` rebuilds the kernel target from at
 * every boot (story `iscsi.2`; ground truth `docs/ISCSI-GROUND-TRUTH.md`).
 *
 * This is a structured read of a JSON file, never `targetcli ls` (Principle 13).
 * It is the "configured" half of the read model; configfs
 * (`services/iscsi-configfs.ts`) is the "live" half, and their difference is
 * what `/v1/iscsi/health` reports.
 *
 * Shape (GT-11): three top-level keys — `fabric_modules` (empty in practice),
 * `storage_objects[]`, `targets[]`. A storage object carries `name`, `plugin`
 * (`block` | `fileio`), `dev`, `wwn`, `readonly`, `write_back`, a full
 * `attributes{}` map, `alua_tpgs[]`, and — fileio only — `size` and `aio`. A
 * target carries `wwn` (the IQN), `fabric`, `parameters{}` and `tpgs[]`; a TPG
 * carries `tag`, `enable`, `attributes{}`, `parameters{}`, `luns[]`,
 * `node_acls[]`, `portals[]`.
 *
 * The traps this parser exists to absorb (GT-12):
 *
 *  1. **Bracketed IPv6.** A v6 portal's `ip_address` is stored WITH brackets
 *     (`"[fd00:6774:0:1::1]"`); v4 is bare. Anything that compares a portal
 *     address against a node address must normalise first, so we normalise here,
 *     once, and hand out bare addresses.
 *  2. **`alias` is never identity.** `luns[].alias` and
 *     `node_acls[].mapped_luns[].alias` are random 10-hex strings regenerated on
 *     every create. They are not read into the model at all.
 *  3. **CHAP secrets are plaintext** (`chap_password`, `chap_mutual_password` —
 *     note the JSON key names differ from targetcli's `set auth password=` /
 *     `mutual_password=`). They MUST NOT leave this parser: only
 *     `chapCredentialsSet` / `mutualCredentialsSet` booleans do.
 *  4. **`attributes{}` here is not `get attribute` output.** The saveconfig set
 *     differs from both the configfs `attrib/` set and targetcli's `get
 *     attribute` view (e.g. `emulate_3pc`). Attributes for DISPLAY are read from
 *     configfs; the ones read here exist to describe what a restore would
 *     rebuild, and for the persisted-vs-live diff.
 *  5. **`dev` is the backing path** (`/dev/zvol/<pool>/<vol>`, or the image
 *     file) — the same string configfs calls `udev_path`. It is what makes LIO
 *     survive a reboot: a `zdN` kernel name would not (GT-48). It can also go
 *     STALE — `zfs rename` under a live LUN succeeds silently and leaves this
 *     pointing at nothing (GT-40).
 *  6. **`wwn` is the SCSI unit serial** — the one string every initiator (and
 *     every PVE volid) identifies the LUN by (GT-14/GT-45).
 *
 * FAIL-OPEN by contract: a missing file (no LIO on this node) or unparseable
 * content yields `null` from the reader and never throws.
 */

import { readFile } from 'node:fs/promises'

/** Default location of LIO's persisted configuration on a Debian/PVE node. */
export const LIO_SAVECONFIG_PATH = '/etc/rtslib-fb-target/saveconfig.json'

/** A bracketed address, `[…]` — how saveconfig stores an IPv6 portal (GT-12). */
const BRACKETED_RE = /^\[(.+)\]$/

/** A backstore reference: `/backstores/<plugin>/<name>`. */
const STORAGE_OBJECT_RE = /^\/backstores\/([^/]+)\/(.+)$/

/** A persisted backstore (a `storage_objects[]` entry). */
export interface SaveconfigStorageObject {
  /** Backstore name — also the SCSI model string initiators see (GT-15). */
  name: string
  /** `block` | `fileio` (LIO also has pscsi/ramdisk/user; ANAS creates neither). */
  plugin: string
  /** Backing path: `/dev/zvol/<pool>/<vol>` for block, the image file for fileio. */
  dev: string
  /** The SCSI unit serial. Create-only in LIO; the whole identity contract. */
  wwn: string | null
  /** fileio only: the LUN size in bytes, fixed at creation (GT-29). */
  size: number | null
  /** The `write_back` flag as persisted (fileio ships this ON — GT-26). */
  writeBack: boolean | null
  /** The `readonly` flag as persisted (block only). */
  readOnly: boolean | null
  /** fileio only: the `aio` flag. */
  aio: boolean | null
  /** The raw `attributes{}` map, verbatim. NOT the `get attribute` set (GT-12). */
  attributes: Record<string, number>
}

/** A persisted network portal, address already normalised (brackets stripped). */
export interface SaveconfigPortal {
  /** Bare address — brackets stripped from IPv6. */
  address: string
  port: number
  /** True when the stored form was bracketed, i.e. an IPv6 portal. */
  ipv6: boolean
  iser: boolean | null
  offload: boolean | null
}

/** A persisted LUN mapping (TPG LUN → backstore). `alias` is deliberately absent. */
export interface SaveconfigLun {
  index: number
  /** The raw `storage_object` string, e.g. `/backstores/block/gtiscsi_vol1`. */
  storageObject: string
  /** Backstore name parsed out of `storageObject`, or null when malformed. */
  backstoreName: string | null
  /** Backstore plugin parsed out of `storageObject`, or null when malformed. */
  plugin: string | null
}

/**
 * A persisted initiator ACL. Carries NO secret: the plaintext `chap_password` /
 * `chap_mutual_password` keys are reduced to booleans and dropped here.
 */
export interface SaveconfigAcl {
  initiatorIqn: string
  chapUserid: string | null
  chapCredentialsSet: boolean
  mutualUserid: string | null
  mutualCredentialsSet: boolean
  /** TPG LUN indexes mapped into this ACL (`mapped_luns[].tpg_lun`). */
  mappedLuns: number[]
}

/** A persisted TPG. */
export interface SaveconfigTpg {
  tag: number
  enable: boolean
  /** `authentication=1` — CHAP enforced. */
  authentication: boolean
  /** `generate_node_acls=1` — LIO demo mode. */
  generateNodeAcls: boolean
  /** `demo_mode_discovery=1` — SendTargets discovery open to anyone (GT-31). */
  demoModeDiscovery: boolean
  /** True when the TPG itself carries a CHAP secret (ignored under explicit ACLs). */
  tpgCredentialsSet: boolean
  portals: SaveconfigPortal[]
  luns: SaveconfigLun[]
  acls: SaveconfigAcl[]
}

/** A persisted target. */
export interface SaveconfigTarget {
  /** The IQN (LIO calls it `wwn` here). */
  iqn: string
  fabric: string
  tpgs: SaveconfigTpg[]
}

/** The whole persisted configuration. */
export interface LioSaveconfig {
  storageObjects: SaveconfigStorageObject[]
  targets: SaveconfigTarget[]
}

/** An empty configuration — what an installed-but-unused LIO persists (GT-11). */
export const EMPTY_SAVECONFIG: LioSaveconfig = { storageObjects: [], targets: [] }

/**
 * Normalise a portal address: strip the brackets LIO wraps an IPv6 address in
 * (`"[fd00:6774:0:1::1]"` → `"fd00:6774:0:1::1"`), leave IPv4 alone. An address
 * that merely CONTAINS a colon and is unbracketed (the form targetcli prints on
 * create, `fd00:6774:0:1::1:3260`, GT-25) is still recognised as IPv6 for the
 * `ipv6` flag but is never re-split — the port comes from its own field.
 */
export function normalizePortalAddress(raw: string): { address: string, ipv6: boolean } {
  const trimmed = raw.trim()
  const bracketed = BRACKETED_RE.exec(trimmed)
  if (bracketed)
    return { address: bracketed[1], ipv6: true }
  return { address: trimmed, ipv6: trimmed.includes(':') }
}

/** Split `/backstores/<plugin>/<name>` into its parts; null when malformed. */
export function parseStorageObjectRef(ref: string): { plugin: string, name: string } | null {
  const m = STORAGE_OBJECT_RE.exec(ref)
  return m ? { plugin: m[1], name: m[2] } : null
}

/** A JSON value we treat as a record without asserting its shape. */
type Json = Record<string, unknown>

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/**
 * True when a value is a non-empty secret string. The VALUE is never returned —
 * this is the only thing the parser is allowed to learn from a `chap_password`.
 */
function secretPresent(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0
}

/** A `1`/`0` attribute read as a boolean; null when absent or non-numeric. */
function attrFlag(attrs: Record<string, number>, key: string): boolean | null {
  const v = attrs[key]
  return typeof v === 'number' ? v !== 0 : null
}

/** Copy only the numeric entries of an `attributes{}` map. */
function numericAttributes(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(v))
    return out
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' && Number.isFinite(val))
      out[k] = val
  }
  return out
}

function parseStorageObject(raw: unknown): SaveconfigStorageObject | null {
  if (!isRecord(raw))
    return null
  const name = asString(raw.name)
  const plugin = asString(raw.plugin)
  const dev = asString(raw.dev)
  // A storage object without a name, a plugin or a backing path cannot be
  // matched to anything live; skipping it is more honest than inventing fields.
  if (!name || !plugin || dev === null)
    return null
  return {
    name,
    plugin,
    dev,
    wwn: asString(raw.wwn),
    size: asNumber(raw.size),
    writeBack: asBoolean(raw.write_back),
    readOnly: asBoolean(raw.readonly),
    aio: asBoolean(raw.aio),
    attributes: numericAttributes(raw.attributes),
  }
}

function parsePortal(raw: unknown): SaveconfigPortal | null {
  if (!isRecord(raw))
    return null
  const rawAddress = asString(raw.ip_address)
  const port = asNumber(raw.port)
  if (rawAddress === null || port === null)
    return null
  const { address, ipv6 } = normalizePortalAddress(rawAddress)
  if (address.length === 0)
    return null
  return { address, port, ipv6, iser: asBoolean(raw.iser), offload: asBoolean(raw.offload) }
}

function parseLun(raw: unknown): SaveconfigLun | null {
  if (!isRecord(raw))
    return null
  const index = asNumber(raw.index)
  const storageObject = asString(raw.storage_object)
  if (index === null || storageObject === null)
    return null
  // `raw.alias` is deliberately NOT read: it is a random 10-hex string
  // regenerated on every create and is never identity (GT-12).
  const ref = parseStorageObjectRef(storageObject)
  return {
    index,
    storageObject,
    backstoreName: ref?.name ?? null,
    plugin: ref?.plugin ?? null,
  }
}

function parseAcl(raw: unknown): SaveconfigAcl | null {
  if (!isRecord(raw))
    return null
  const initiatorIqn = asString(raw.node_wwn)
  if (!initiatorIqn)
    return null
  const mappedLuns: number[] = []
  for (const m of asArray(raw.mapped_luns)) {
    if (!isRecord(m))
      continue
    const tpgLun = asNumber(m.tpg_lun)
    if (tpgLun !== null)
      mappedLuns.push(tpgLun)
  }
  return {
    initiatorIqn,
    chapUserid: asString(raw.chap_userid),
    // The secret itself stops here — only its presence travels on (GT-12/GT-35).
    chapCredentialsSet: secretPresent(raw.chap_password),
    mutualUserid: asString(raw.chap_mutual_userid),
    mutualCredentialsSet: secretPresent(raw.chap_mutual_password),
    mappedLuns: mappedLuns.sort((a, b) => a - b),
  }
}

function parseTpg(raw: unknown): SaveconfigTpg | null {
  if (!isRecord(raw))
    return null
  const tag = asNumber(raw.tag)
  if (tag === null)
    return null
  const attrs = numericAttributes(raw.attributes)
  return {
    tag,
    enable: asBoolean(raw.enable) ?? false,
    authentication: attrFlag(attrs, 'authentication') ?? false,
    generateNodeAcls: attrFlag(attrs, 'generate_node_acls') ?? false,
    demoModeDiscovery: attrFlag(attrs, 'demo_mode_discovery') ?? false,
    tpgCredentialsSet: secretPresent(raw.chap_password),
    portals: asArray(raw.portals).map(parsePortal).filter((p): p is SaveconfigPortal => p !== null),
    luns: asArray(raw.luns).map(parseLun).filter((l): l is SaveconfigLun => l !== null),
    acls: asArray(raw.node_acls).map(parseAcl).filter((a): a is SaveconfigAcl => a !== null),
  }
}

function parseTarget(raw: unknown): SaveconfigTarget | null {
  if (!isRecord(raw))
    return null
  const iqn = asString(raw.wwn)
  if (!iqn)
    return null
  return {
    iqn,
    fabric: asString(raw.fabric) ?? 'iscsi',
    tpgs: asArray(raw.tpgs).map(parseTpg).filter((t): t is SaveconfigTpg => t !== null),
  }
}

/**
 * Parse the text of a `saveconfig.json` into the persisted model.
 *
 * Total: malformed entries are dropped, not thrown on — a half-readable
 * saveconfig still tells us most of what a restore will rebuild, and a throw
 * here would take `/v1/iscsi/*` down with it. Throws only on JSON that does not
 * parse at all; {@link readLioSaveconfig} absorbs even that.
 */
export function parseLioSaveconfig(text: string): LioSaveconfig {
  const doc: unknown = JSON.parse(text)
  if (!isRecord(doc))
    return { ...EMPTY_SAVECONFIG }
  return {
    storageObjects: asArray(doc.storage_objects)
      .map(parseStorageObject)
      .filter((s): s is SaveconfigStorageObject => s !== null),
    targets: asArray(doc.targets)
      .map(parseTarget)
      .filter((t): t is SaveconfigTarget => t !== null),
  }
}

/**
 * Read and parse LIO's persisted configuration, FAIL-OPEN.
 *
 * Returns `null` when the file is absent (no LIO on this node — the normal case
 * on most PVE hosts) or when its content will not parse. Never throws: every
 * iSCSI read must keep working on a node that serves no block storage.
 */
export async function readLioSaveconfig(path: string = LIO_SAVECONFIG_PATH): Promise<LioSaveconfig | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  }
  catch (err: unknown) {
    // ENOENT is the expected state on a node without targetcli-fb.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`anasd: could not read ${path} for the iSCSI read layer:`, err)
    return null
  }
  try {
    return parseLioSaveconfig(text)
  }
  catch (err: unknown) {
    console.warn(`anasd: could not parse ${path} for the iSCSI read layer:`, err)
    return null
  }
}

/** Index a saveconfig's storage objects by backstore name. */
export function storageObjectsByName(cfg: LioSaveconfig): Map<string, SaveconfigStorageObject> {
  return new Map(cfg.storageObjects.map(s => [s.name, s]))
}
