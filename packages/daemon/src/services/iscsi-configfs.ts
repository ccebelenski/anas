/**
 * The LIVE half of the iSCSI read model: `/sys/kernel/config/target/` (story
 * `iscsi.2`; ground truth `docs/ISCSI-GROUND-TRUTH.md`).
 *
 * configfs is a filesystem, so this is a structured read — one small file per
 * value, no command output parsed anywhere (Principle 13). `targetcli ls` is
 * never invoked: its output is a decorated tree meant for humans, it carries no
 * session information at all (GT-38), and everything it shows is in configfs.
 *
 * Layout (GT-13):
 *
 *   core/<plugin>_<index>/<backstore name>/   ← the plugin dir carries a CREATION
 *       udev_path                               INDEX (`iblock_0`, `fileio_1`) that
 *       info                                    moves with creation order. Never
 *       enable                                  hardcode it — glob every plugin dir.
 *       attrib/<name>
 *       wwn/vpd_unit_serial                   ← reads back WITH a
 *       wwn/product_id                          `T10 VPD Unit Serial Number: `
 *       wwn/vendor_id                           prefix. Strip it.
 *   iscsi/<IQN>/tpgt_<n>/
 *       enable, attrib/, auth/, param/
 *       acls/<initiator IQN>/{info,auth/*,lun_<n>/}
 *       lun/lun_<n>/<random alias> → symlink to the backstore
 *       np/<addr>:<port>/                     ← IPv6 np dirs are BRACKETED
 *       dynamic_sessions                      ← EMPTY under explicit ACLs (GT-38)
 *
 * Two facts drive the shape of this module:
 *
 *  - **Sessions come from `acls/<iqn>/info`, not `dynamic_sessions`.** The latter
 *    only lists sessions of dynamically generated ACLs
 *    (`generate_node_acls=1`), which ANAS never uses, so it is always empty
 *    (GT-38).
 *  - **Nothing in userspace names LIO as the holder of a backing device.**
 *    `fuser`, `lsof` and a device's sysfs `holders/` all find nothing (GT-41); the
 *    claim is visible only here, as `CLAIMED: IBLOCK` in a backstore's `info`
 *    plus its `udev_path`. {@link lunHoldingDevice} is that lookup, exported once
 *    so `busy-diagnosis.ts` (story `iscsi.6`) reuses it rather than growing a
 *    second copy.
 *
 * The configfs ROOT is injectable so the whole reader is testable against a
 * materialised fixture tree.
 *
 * FAIL-OPEN throughout: a node without the LIO stack has no
 * `/sys/kernel/config/target` at all, and every function here reports that as a
 * state (`present: false`, `null`, `[]`) rather than an error.
 */

import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** The configfs mount point of the LIO target core. */
export const CONFIGFS_TARGET_ROOT = '/sys/kernel/config/target'

/** Where the kernel exposes block-device geometry (a zvol's size lives here). */
export const SYS_CLASS_BLOCK = '/sys/class/block'

/** Sector size the kernel's `/sys/class/block/<dev>/size` is counted in. */
const SYSFS_SECTOR_BYTES = 512

/** The prefix `wwn/vpd_unit_serial` reads back with (GT-13). */
export const UNIT_SERIAL_PREFIX = 'T10 VPD Unit Serial Number: '

/**
 * LIO's sentinel for a CHAP credential that is NOT set.
 *
 * The kernel's node-ACL auth store reads the literal string `NULL` as a clear —
 * it drops the corresponding `NAF_*_IN_SET` flag — while a zero-length write
 * would store an EMPTY credential and mark it as set. That is why removing a
 * credential means writing `NULL` (`services/iscsi-mutate.ts`), and why a
 * credential file reading back `NULL` here must be reported as unset rather than
 * as a four-character secret.
 */
export const LIO_AUTH_NULL = 'NULL'

/** Is this configfs auth value "not set" — empty, or LIO's `NULL` sentinel? */
export function authUnset(value: string): boolean {
  return value === '' || value === LIO_AUTH_NULL
}

/** A bracketed IPv6 np directory: `[fd00:6774:0:1::1]:3260` (GT-13). */
const NP_IPV6_RE = /^\[(.+)\]:(\d+)$/

/** A bare IPv4 np directory: `192.168.200.50:3260`. */
const NP_IPV4_RE = /^[^[\]]+:\d+$/

/** `iBlock device: zd16` inside a block backstore's `info` (GT-41/GT-48). */
const IBLOCK_DEVICE_RE = /iBlock device:\s*(\S+)/

/** `CLAIMED: IBLOCK` inside a block backstore's `info` — the only claim marker. */
const CLAIMED_RE = /CLAIMED:\s*(\S+)/

/** `UDEV PATH: /dev/zvol/...` inside a block backstore's `info`. */
const INFO_UDEV_PATH_RE = /UDEV PATH:\s*(\S+)/

/** `Size: 1073741824` inside a fileio backstore's `info`. */
const INFO_SIZE_RE = /\bSize:\s*(\d+)/

/** `Status: ACTIVATED` — a backstore that is mapped and serving. */
const INFO_STATUS_RE = /Status:\s*(\S+)/

/** `LIO Session ID: 7   ISID: … TSIH: 24  SessionType: Normal` (GT-38). */
const SESSION_ID_RE = /LIO Session ID:\s*(\d+)/

/** `Session State: TARG_SESS_STATE_LOGGED_IN`. */
const SESSION_STATE_RE = /Session State:\s*(\S+)/

/** `InitiatorName: iqn.…`. */
const INITIATOR_NAME_RE = /InitiatorName:\s*(\S+)/

/** `InitiatorAlias: anas-pve`. */
const INITIATOR_ALIAS_RE = /InitiatorAlias:\s*(.*)/

/** `CID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN`. */
const CONNECTION_CID_RE = /^CID:\s*(\d+)\s+Connection State:\s*(\S+)/

/** `   Address 192.168.200.50 TCP  StatSN: 0x…`. */
const CONNECTION_ADDRESS_RE = /^\s*Address\s+(\S+)\s/

/** `lun_<n>` / `tpgt_<n>` directory names. */
const LUN_DIR_RE = /^lun_(\d+)$/
const TPGT_DIR_RE = /^tpgt_(\d+)$/

/** `core/<plugin>_<index>` — the index moves with creation order; never hardcoded. */
const PLUGIN_DIR_RE = /^(.+)_(\d+)$/

/** `File: /gtiscsi/images/lun2.raw` inside a fileio backstore's `info`. */
const INFO_FILE_RE = /\bFile:\s*(\S+)/

/** One trailing newline, as every configfs value file carries. */
const TRAILING_NEWLINE_RE = /\n$/

/** A plausible kernel device name — it is spliced into a sysfs path. */
const KERNEL_DEVICE_RE = /^[\w.:-]+$/

/** One or more trailing slashes on a path, stripped before comparison. */
const TRAILING_SLASH_RE = /\/+$/

/** The attribute subset ANAS surfaces (see `IscsiLunAttributes` in @anas/shared). */
const READ_ATTRIBUTES = [
  'emulate_tpu',
  'emulate_tpws',
  'block_size',
  'emulate_write_cache',
  'max_unmap_lba_count',
] as const

/**
 * Options for every reader here — the root is injectable so tests can point it
 *  at a materialised fixture tree instead of the running kernel.
 */
export interface ConfigfsOptions {
  /** configfs target root; defaults to {@link CONFIGFS_TARGET_ROOT}. */
  root?: string
  /** `/sys/class/block` root, for a block backstore's size; injectable for tests. */
  blockRoot?: string
}

/**
 * Normalise a backstore plugin name to ONE vocabulary. configfs names the block
 * plugin's directory `iblock_<n>` while saveconfig calls the same plugin
 * `block`; joining the two sources requires picking one, and saveconfig's is the
 * one `targetcli` itself takes on the command line.
 */
export function normalizePlugin(plugin: string): string {
  return plugin === 'iblock' ? 'block' : plugin
}

/** A live backstore under `core/<plugin>_<n>/<name>/`. */
export interface ConfigfsBackstore {
  /** Backstore name — the SCSI model string initiators see (GT-15). */
  name: string
  /** `iblock`, `fileio`, … — parsed out of the indexed plugin directory. */
  plugin: string
  /** The creation index in `core/<plugin>_<index>`. Informational only. */
  hbaIndex: number | null
  /** The stable backing path (`udev_path`). */
  udevPath: string
  /** Unit serial with the `T10 VPD Unit Serial Number: ` prefix stripped. */
  serial: string | null
  /** `wwn/product_id` — equals `name` while `emulate_model_alias=1`. */
  productId: string | null
  /** `wwn/vendor_id`, `LIO-ORG` on stock LIO. */
  vendorId: string | null
  /** The `enable` flag. */
  enabled: boolean | null
  /** `Status:` from `info` — `ACTIVATED` when mapped and serving. */
  status: string | null
  /** `CLAIMED: IBLOCK` from `info`; null for fileio (files are not claimed). */
  claimed: string | null
  /**
   * The kernel device name from `info` (`iBlock device: zd16`). Resolved AT POINT
   * OF USE only — these numbers move across a reboot and must never be stored or
   * matched (GT-48).
   */
  kernelDevice: string | null
  /** Size in bytes. fileio: from `info`. block: from `/sys/class/block`. */
  size: number | null
  /** The attribute subset ANAS surfaces, raw (`1`/`0` still numbers). */
  attributes: Record<string, number>
}

/** A live TPG LUN. */
export interface ConfigfsLun {
  index: number
  /** Backstore name from the LUN's symlink target; null when unresolvable. */
  backstoreName: string | null
  /** Backstore plugin dir (`iblock_0` → `iblock`) from the symlink target. */
  plugin: string | null
}

/** A live session, read from `acls/<initiator IQN>/info` (GT-38). */
export interface ConfigfsSession {
  initiatorIqn: string
  initiatorAlias: string | null
  sessionId: number | null
  state: string
  connections: { cid: number, address: string, state: string }[]
}

/** A live initiator ACL. Carries no secret — only `…CredentialsSet` booleans. */
export interface ConfigfsAcl {
  initiatorIqn: string
  chapUserid: string | null
  chapCredentialsSet: boolean
  mutualUserid: string | null
  mutualCredentialsSet: boolean
  authenticateTarget: boolean | null
  mappedLuns: number[]
  /** The session on this ACL, or null when `info` says there is none. */
  session: ConfigfsSession | null
}

/** A live network portal (an `np/<addr>:<port>` directory). */
export interface ConfigfsPortal {
  /** Bare address — brackets stripped from IPv6 (GT-13). */
  address: string
  port: number
  ipv6: boolean
}

/** A live TPG. */
export interface ConfigfsTpg {
  tag: number
  enabled: boolean
  authentication: boolean
  generateNodeAcls: boolean
  demoModeDiscovery: boolean
  portals: ConfigfsPortal[]
  luns: ConfigfsLun[]
  acls: ConfigfsAcl[]
  /**
   * `dynamic_sessions`, verbatim. Kept only so the emptiness GT-38 documents is
   * visible rather than assumed; sessions come from the ACLs.
   */
  dynamicSessionsRaw: string
}

/** A live target. */
export interface ConfigfsTarget {
  iqn: string
  tpgs: ConfigfsTpg[]
}

/** Everything live in the kernel target right now. */
export interface LioLiveState {
  /** Is the configfs target tree present at all? */
  present: boolean
  backstores: ConfigfsBackstore[]
  targets: ConfigfsTarget[]
}

/** The state of a node with no LIO stack. */
export const ABSENT_LIVE_STATE: LioLiveState = { present: false, backstores: [], targets: [] }

// ---------------------------------------------------------------------------
// Small fail-open filesystem helpers
// ---------------------------------------------------------------------------

/** Read a configfs value file; null on any failure. Trailing newline stripped. */
async function readValue(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).replace(TRAILING_NEWLINE_RE, '')
  }
  catch {
    return null
  }
}

/**
 * Read a configfs value as a trimmed string, treating "absent" and "empty" the
 * same. Needed because configfs `stat` reports every attribute file as 4096
 * bytes regardless of content — an `-s`-style size test is meaningless here, so
 * emptiness has to be decided from the CONTENT.
 */
async function readTrimmed(path: string): Promise<string> {
  return (await readValue(path))?.trim() ?? ''
}

/** Read a `1`/`0` configfs flag; null when absent or unparseable. */
async function readFlag(path: string): Promise<boolean | null> {
  const v = await readTrimmed(path)
  if (v === '')
    return null
  const n = Number(v)
  return Number.isFinite(n) ? n !== 0 : null
}

/** Read a numeric configfs value; null when absent or unparseable. */
async function readNumber(path: string): Promise<number | null> {
  const v = await readTrimmed(path)
  if (v === '')
    return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** List a directory's entries; [] on any failure (missing, unreadable). */
async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  }
  catch {
    return []
  }
}

/** Does a path exist? */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Pure parsers (exported so they can be tested against the captured text)
// ---------------------------------------------------------------------------

/**
 * Strip the `T10 VPD Unit Serial Number: ` prefix `wwn/vpd_unit_serial` reads
 * back with (GT-13). A value without the prefix is returned trimmed, so a future
 * kernel that drops it does not break the read.
 */
export function stripUnitSerialPrefix(raw: string): string {
  const t = raw.trim()
  return t.startsWith(UNIT_SERIAL_PREFIX) ? t.slice(UNIT_SERIAL_PREFIX.length).trim() : t
}

/** What a backstore's `info` file carries. The two plugins print different text. */
export interface BackstoreInfo {
  /** `Status: ACTIVATED` — mapped and serving. */
  status: string | null
  /** `CLAIMED: IBLOCK`; absent for fileio (a file is not "claimed"). */
  claimed: string | null
  /** `iBlock device: zd16` — the volatile kernel name (GT-48). Block only. */
  kernelDevice: string | null
  /** `UDEV PATH: …` / `File: …` — the stable backing path. */
  path: string | null
  /** `Size: 1073741824` — fileio only; block backstores do not report a size. */
  size: number | null
}

/**
 * Parse a backstore's configfs `info`. Two shapes, both real captures:
 *
 *   block:  Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512 …
 *                   iBlock device: zd16  UDEV PATH: /dev/zvol/gtiscsi/vol1  readonly: 0
 *             exclusive: 1
 *                   Major: 230 Minor: 16  CLAIMED: IBLOCK
 *
 *   fileio: Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384
 *                   TCM FILEIO ID: 0        File: /gtiscsi/images/lun2.raw  Size: 1073741824  Mode: O_DSYNC Async: 0
 *
 * Note what is NOT there: a block backstore reports no size. That is why a zvol
 * LUN's size comes from `/sys/class/block/<kernel>/size` instead.
 */
export function parseBackstoreInfo(text: string): BackstoreInfo {
  const status = INFO_STATUS_RE.exec(text)?.[1] ?? null
  const claimed = CLAIMED_RE.exec(text)?.[1] ?? null
  const kernelDevice = IBLOCK_DEVICE_RE.exec(text)?.[1] ?? null
  const udev = INFO_UDEV_PATH_RE.exec(text)?.[1] ?? null
  const file = INFO_FILE_RE.exec(text)?.[1] ?? null
  const sizeMatch = INFO_SIZE_RE.exec(text)?.[1]
  return {
    status,
    claimed,
    kernelDevice,
    path: udev ?? file,
    size: sizeMatch !== undefined ? Number(sizeMatch) : null,
  }
}

/**
 * Parse an `acls/<initiator IQN>/info` block into a session (GT-38).
 *
 * With no session the whole file is the single line
 * `No active iSCSI Session for Initiator Endpoint: <iqn>` → `null`.
 *
 * `targetcli sessions detail`'s `(NOT AUTHENTICATED)` label is not read from
 * anywhere: it reflects `authenticate_target`, not whether the initiator
 * authenticated, and a one-way-CHAP session prints it (GT-39).
 */
export function parseAclInfo(text: string, fallbackIqn: string): ConfigfsSession | null {
  if (text.includes('No active iSCSI Session'))
    return null
  const state = SESSION_STATE_RE.exec(text)?.[1]
  if (!state)
    return null

  const aliasRaw = INITIATOR_ALIAS_RE.exec(text)?.[1]?.trim()
  const sessionIdRaw = SESSION_ID_RE.exec(text)?.[1]

  const connections: { cid: number, address: string, state: string }[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const cid = CONNECTION_CID_RE.exec(lines[i].trim())
    if (!cid)
      continue
    // The address sits on the line AFTER the CID line; a connection with no
    // address line still counts (its address is simply unknown).
    let address = ''
    const next = lines[i + 1]
    if (next !== undefined) {
      const addr = CONNECTION_ADDRESS_RE.exec(next)
      if (addr)
        address = addr[1]
    }
    connections.push({ cid: Number(cid[1]), address, state: cid[2] })
  }

  return {
    initiatorIqn: INITIATOR_NAME_RE.exec(text)?.[1] ?? fallbackIqn,
    initiatorAlias: aliasRaw !== undefined && aliasRaw !== '' ? aliasRaw : null,
    sessionId: sessionIdRaw !== undefined ? Number(sessionIdRaw) : null,
    state,
    connections,
  }
}

/**
 * Parse an `np/` directory name into an address + port. IPv6 is BRACKETED there
 * (`[fd00:6774:0:1::1]:3260`, GT-13), IPv4 is bare — the same normalisation the
 * saveconfig parser does, applied to the other spelling of the same fact.
 */
export function parseNpDirName(name: string): ConfigfsPortal | null {
  const v6 = NP_IPV6_RE.exec(name)
  if (v6)
    return { address: v6[1], port: Number(v6[2]), ipv6: true }
  const v4 = NP_IPV4_RE.exec(name)
  if (v4) {
    // A bare name with several colons would be an unbracketed IPv6 form; LIO
    // does not write one, and splitting it would be a guess. Take the LAST colon
    // as the port separator so a stray form still yields an address.
    const lastColon = name.lastIndexOf(':')
    const address = name.slice(0, lastColon)
    const port = Number(name.slice(lastColon + 1))
    if (!Number.isFinite(port) || address.length === 0)
      return null
    return { address, port, ipv6: address.includes(':') }
  }
  return null
}

/**
 * Split an indexed plugin directory (`iblock_0`, `fileio_1`) into its plugin and
 * creation index. The index moves with creation order and must never be
 * hardcoded (GT-13) — it is parsed, not assumed.
 */
export function parsePluginDir(dir: string): { plugin: string, index: number | null } {
  const m = PLUGIN_DIR_RE.exec(dir)
  if (!m)
    return { plugin: dir, index: null }
  const n = Number(m[2])
  return { plugin: m[1], index: Number.isFinite(n) ? n : null }
}

/**
 * A LUN's backstore is named by a SYMLINK whose own name is the throwaway alias
 * (GT-12) — so the link name is ignored and the TARGET is read. The target is
 * relative and escapes the target root (`../../../../../../target/core/iblock_0/
 * gtiscsi_vol1`), so it is matched by its tail rather than resolved: resolution
 * would depend on where the tree is mounted, which is exactly what tests change.
 */
export function parseLunSymlinkTarget(target: string): { plugin: string, name: string } | null {
  const parts = target.split('/').filter(p => p.length > 0 && p !== '.' && p !== '..')
  const coreIdx = parts.lastIndexOf('core')
  if (coreIdx < 0 || parts.length < coreIdx + 3)
    return null
  const { plugin } = parsePluginDir(parts[coreIdx + 1])
  return { plugin, name: parts[coreIdx + 2] }
}

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

/** Read the size of a block device from sysfs (512-byte sectors → bytes). */
async function readBlockDeviceSize(kernelDevice: string, blockRoot: string): Promise<number | null> {
  // Guard the name: it is spliced into a path, and it comes from kernel text.
  if (!KERNEL_DEVICE_RE.test(kernelDevice))
    return null
  const sectors = await readNumber(join(blockRoot, kernelDevice, 'size'))
  return sectors === null ? null : sectors * SYSFS_SECTOR_BYTES
}

/** Read one backstore directory. */
async function readBackstore(
  coreDir: string,
  pluginDir: string,
  name: string,
  blockRoot: string,
): Promise<ConfigfsBackstore> {
  const dir = join(coreDir, pluginDir, name)
  const { plugin, index } = parsePluginDir(pluginDir)

  const [udevPathRaw, infoRaw, serialRaw, productId, vendorId, enabled] = await Promise.all([
    readValue(join(dir, 'udev_path')),
    readValue(join(dir, 'info')),
    readValue(join(dir, 'wwn', 'vpd_unit_serial')),
    readTrimmed(join(dir, 'wwn', 'product_id')),
    readTrimmed(join(dir, 'wwn', 'vendor_id')),
    readFlag(join(dir, 'enable')),
  ])

  const attributes: Record<string, number> = {}
  await Promise.all(READ_ATTRIBUTES.map(async (attr) => {
    const v = await readNumber(join(dir, 'attrib', attr))
    if (v !== null)
      attributes[attr] = v
  }))

  const info = infoRaw ? parseBackstoreInfo(infoRaw) : null
  const udevPath = (udevPathRaw ?? '').trim() || info?.path || ''

  // fileio reports its size in `info`; a block backstore reports none at all, so
  // its size comes from the kernel device sysfs entry — resolved here, at point
  // of use, and never stored (GT-48).
  let size = info?.size ?? null
  if (size === null && info?.kernelDevice)
    size = await readBlockDeviceSize(info.kernelDevice, blockRoot)

  return {
    name,
    plugin,
    hbaIndex: index,
    udevPath,
    serial: serialRaw !== null ? stripUnitSerialPrefix(serialRaw) : null,
    productId: productId === '' ? null : productId,
    vendorId: vendorId === '' ? null : vendorId,
    enabled,
    status: info?.status ?? null,
    claimed: info?.claimed ?? null,
    kernelDevice: info?.kernelDevice ?? null,
    size,
    attributes,
  }
}

/** Read every backstore under `core/`, skipping the ALUA bookkeeping dir. */
async function readBackstores(root: string, blockRoot: string): Promise<ConfigfsBackstore[]> {
  const coreDir = join(root, 'core')
  const out: ConfigfsBackstore[] = []
  for (const pluginDir of (await listDir(coreDir)).sort()) {
    // `core/alua` holds LU-group bookkeeping, not backstores.
    if (pluginDir === 'alua')
      continue
    for (const name of (await listDir(join(coreDir, pluginDir))).sort()) {
      // `hba_info` / `hba_mode` are files beside the backstore directories.
      if (!(await exists(join(coreDir, pluginDir, name, 'wwn'))))
        continue
      out.push(await readBackstore(coreDir, pluginDir, name, blockRoot))
    }
  }
  return out
}

/** Read the mapped LUN indexes of an ACL (its `lun_<n>` subdirectories). */
async function readMappedLuns(aclDir: string): Promise<number[]> {
  const out: number[] = []
  for (const entry of await listDir(aclDir)) {
    const m = LUN_DIR_RE.exec(entry)
    if (m)
      out.push(Number(m[1]))
  }
  return out.sort((a, b) => a - b)
}

/** Read one initiator ACL, including its session — and never its secrets. */
async function readAcl(aclsDir: string, initiatorIqn: string): Promise<ConfigfsAcl> {
  const dir = join(aclsDir, initiatorIqn)
  const authDir = join(dir, 'auth')

  const [chapUserid, mutualUserid, password, passwordMutual, authenticateTarget, infoRaw, mappedLuns]
    = await Promise.all([
      readTrimmed(join(authDir, 'userid')),
      readTrimmed(join(authDir, 'userid_mutual')),
      // Read ONLY to learn whether a secret is set — the value stops here and
      // never enters the returned object (GT-35). configfs stat sizes are always
      // 4096, so emptiness cannot be decided any other way.
      readTrimmed(join(authDir, 'password')),
      readTrimmed(join(authDir, 'password_mutual')),
      readFlag(join(authDir, 'authenticate_target')),
      readValue(join(dir, 'info')),
      readMappedLuns(dir),
    ])

  return {
    initiatorIqn,
    chapUserid: authUnset(chapUserid) ? null : chapUserid,
    chapCredentialsSet: !authUnset(password),
    mutualUserid: authUnset(mutualUserid) ? null : mutualUserid,
    mutualCredentialsSet: !authUnset(passwordMutual),
    authenticateTarget,
    mappedLuns,
    session: infoRaw !== null ? parseAclInfo(infoRaw, initiatorIqn) : null,
  }
}

/** Read one TPG LUN: its index and the backstore its symlink points at. */
async function readLun(lunDir: string, index: number): Promise<ConfigfsLun> {
  for (const entry of await listDir(lunDir)) {
    let target: string
    try {
      target = await readlink(join(lunDir, entry))
    }
    catch {
      continue // a regular file (alua_tg_pt_*), not the backstore link
    }
    const ref = parseLunSymlinkTarget(target)
    if (ref)
      return { index, backstoreName: ref.name, plugin: ref.plugin }
  }
  return { index, backstoreName: null, plugin: null }
}

/** Read one TPG. */
async function readTpg(targetDir: string, tpgtDir: string, tag: number): Promise<ConfigfsTpg> {
  const dir = join(targetDir, tpgtDir)

  const [enabled, authentication, generateNodeAcls, demoModeDiscovery, dynamicSessionsRaw]
    = await Promise.all([
      readFlag(join(dir, 'enable')),
      readFlag(join(dir, 'attrib', 'authentication')),
      readFlag(join(dir, 'attrib', 'generate_node_acls')),
      readFlag(join(dir, 'attrib', 'demo_mode_discovery')),
      readValue(join(dir, 'dynamic_sessions')),
    ])

  const portals: ConfigfsPortal[] = []
  for (const np of (await listDir(join(dir, 'np'))).sort()) {
    const portal = parseNpDirName(np)
    if (portal)
      portals.push(portal)
  }

  const luns: ConfigfsLun[] = []
  for (const entry of (await listDir(join(dir, 'lun'))).sort()) {
    const m = LUN_DIR_RE.exec(entry)
    if (m)
      luns.push(await readLun(join(dir, 'lun', entry), Number(m[1])))
  }
  luns.sort((a, b) => a.index - b.index)

  const aclsDir = join(dir, 'acls')
  const acls: ConfigfsAcl[] = []
  for (const initiator of (await listDir(aclsDir)).sort())
    acls.push(await readAcl(aclsDir, initiator))

  return {
    tag,
    enabled: enabled ?? false,
    authentication: authentication ?? false,
    generateNodeAcls: generateNodeAcls ?? false,
    demoModeDiscovery: demoModeDiscovery ?? false,
    portals,
    luns,
    acls,
    dynamicSessionsRaw: dynamicSessionsRaw ?? '',
  }
}

/** Read every iSCSI target and its TPGs. */
async function readTargets(root: string): Promise<ConfigfsTarget[]> {
  const iscsiDir = join(root, 'iscsi')
  const out: ConfigfsTarget[] = []
  for (const entry of (await listDir(iscsiDir)).sort()) {
    // `iscsi/` also holds `discovery_auth/`, `lio_version`, `cpus_allowed_list`.
    // A target directory is exactly one whose name is an iSCSI node name.
    if (!(entry.startsWith('iqn.') || entry.startsWith('eui.') || entry.startsWith('naa.')))
      continue
    const targetDir = join(iscsiDir, entry)
    const tpgs: ConfigfsTpg[] = []
    for (const tpgtDir of (await listDir(targetDir)).sort()) {
      const m = TPGT_DIR_RE.exec(tpgtDir)
      if (m)
        tpgs.push(await readTpg(targetDir, tpgtDir, Number(m[1])))
    }
    tpgs.sort((a, b) => a.tag - b.tag)
    out.push({ iqn: entry, tpgs })
  }
  return out
}

/**
 * Read the whole live LIO state. FAIL-OPEN: a node without the target stack has
 * no `/sys/kernel/config/target`, and that returns {@link ABSENT_LIVE_STATE}
 * rather than throwing — `installed: false` is a first-class state.
 */
export async function readConfigfs(opts?: ConfigfsOptions): Promise<LioLiveState> {
  const root = opts?.root ?? CONFIGFS_TARGET_ROOT
  const blockRoot = opts?.blockRoot ?? SYS_CLASS_BLOCK
  if (!(await exists(root)))
    return { ...ABSENT_LIVE_STATE }
  try {
    const [backstores, targets] = await Promise.all([
      readBackstores(root, blockRoot),
      readTargets(root),
    ])
    return { present: true, backstores, targets }
  }
  catch (err: unknown) {
    console.warn(`anasd: could not read ${root} for the iSCSI read layer:`, err)
    return { ...ABSENT_LIVE_STATE }
  }
}

// ---------------------------------------------------------------------------
// The busy-diagnosis seam (story iscsi.6 reuses this — one implementation)
// ---------------------------------------------------------------------------

/** Which LUN holds a backing device/file open. */
export interface LunHolder {
  targetIqn: string
  tpgTag: number
  lunIndex: number
  backstoreName: string
  plugin: string
  /** The backing path as configfs records it. */
  backingPath: string
  /** `CLAIMED: IBLOCK` when the kernel names the claim; null for fileio. */
  claimed: string | null
}

/**
 * Which LUN, if any, is holding `devPath` open.
 *
 * This is the ONLY way to answer that question. `fuser -m`, `lsof` and
 * `/sys/block/<dev>/holders/` all report nothing for a device LIO is serving
 * (GT-41), which is why a ZFS `dataset is busy` on a LUN-backed zvol currently
 * has no explanation attached. Exported here — once — so `busy-diagnosis.ts`
 * grows an LIO branch that CALLS this rather than a second copy of it.
 *
 * Matching is on the stable path (`/dev/zvol/<pool>/<vol>` or the image file),
 * never a `zdN` kernel name (GT-48). A directory argument also matches any LUN
 * backed by a file underneath it, which is what a busy `zpool export` or a busy
 * dataset destroy actually needs to explain (GT-40).
 *
 * FAIL-OPEN: no LIO, no match, or any read failure → `null`.
 */
export async function lunHoldingDevice(
  devPath: string,
  opts?: ConfigfsOptions,
): Promise<LunHolder | null> {
  const state = await readConfigfs(opts)
  return findLunHolder(state, devPath)
}

/**
 * The pure half of {@link lunHoldingDevice}, for callers that already hold a
 * live state (and for tests). Returns the first match; a backing object can be
 * mapped into several targets, and naming one is enough to explain a refusal.
 */
export function findLunHolder(state: LioLiveState, devPath: string): LunHolder | null {
  if (!state.present || devPath.length === 0)
    return null
  const wanted = devPath.replace(TRAILING_SLASH_RE, '') || '/'
  const byName = new Map(state.backstores.map(b => [b.name, b]))

  const matches = (backingPath: string): boolean => {
    if (backingPath.length === 0)
      return false
    // Exact device/file, or a file under the directory the caller named.
    return backingPath === wanted || (wanted !== '/' && backingPath.startsWith(`${wanted}/`))
  }

  for (const target of state.targets) {
    for (const tpg of target.tpgs) {
      for (const lun of tpg.luns) {
        if (!lun.backstoreName)
          continue
        const backstore = byName.get(lun.backstoreName)
        if (!backstore || !matches(backstore.udevPath))
          continue
        return {
          targetIqn: target.iqn,
          tpgTag: tpg.tag,
          lunIndex: lun.index,
          backstoreName: backstore.name,
          plugin: normalizePlugin(backstore.plugin),
          backingPath: backstore.udevPath,
          claimed: backstore.claimed,
        }
      }
    }
  }
  return null
}

/**
 * Human sentence for a LUN holder — ONE phrasing, used wherever it surfaces.
 *
 * Three places render it and they must not drift: the `busy-diagnosis` clause
 * appended to a ZFS `dataset is busy` (story `iscsi.6`), an `IscsiClaim.detail`
 * on `GET /v1/iscsi/claims`, and every held-by-LUN refusal body. The LUN's
 * NAME is in it because that is the SCSI model string the operator sees on the
 * initiator (GT-15) — "LUN 0" alone names nothing recognisable.
 */
export function describeLunHolder(holder: Pick<LunHolder, 'lunIndex' | 'backstoreName' | 'targetIqn' | 'backingPath'>): string {
  return `held by iSCSI LUN ${holder.lunIndex} '${holder.backstoreName}' of target ${holder.targetIqn} (${holder.backingPath})`
}

/** The backstore name a configfs path belongs to (the last path component). */
export function backstoreNameFromPath(path: string): string {
  return basename(path)
}
