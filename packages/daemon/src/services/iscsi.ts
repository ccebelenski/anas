/**
 * The iSCSI read layer: persisted + live, joined (story `iscsi.2`).
 *
 * `parsers/lio-saveconfig.ts` reads what a boot restore WILL rebuild;
 * `services/iscsi-configfs.ts` reads what the kernel is serving NOW. Neither is
 * the answer on its own — the whole point of the iSCSI epic's boot work is that
 * they can disagree while systemd reports success (GT-20/GT-21) — so every view
 * here is built from the UNION of the two, with each item saying which sides it
 * appeared on (`present`, `persisted`).
 *
 * Everything is fail-open. A node with no `targetcli-fb` has neither source, and
 * that is reported as `installed: false` with empty collections, never as an
 * error: most PVE nodes serve no block storage and the rest of ANAS must not
 * care.
 *
 * Cost discipline (Principle 7): when neither source has a target, nothing else
 * is read at all — no `storage.cfg`, no `zfs list`, no `ip addr`, no AHR
 * topology. The AHR topology read in particular happens only when a LUN is
 * backed by a file that resolved onto no ZFS dataset.
 */

import type {
  IscsiAcl,
  IscsiAvailability,
  IscsiLun,
  IscsiLunAttributes,
  IscsiPortal,
  IscsiSession,
  IscsiTargetDetail,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { LioSaveconfig, SaveconfigStorageObject } from '../parsers/lio-saveconfig.js'
import type { ConfigfsAcl, ConfigfsBackstore, ConfigfsPortal, LioLiveState } from './iscsi-configfs.js'
import type { OwnershipInputs, OwnershipLun } from './iscsi-ownership.js'
import { stat } from 'node:fs/promises'
import { anasTargetName } from '@anas/shared'
import { LIO_SAVECONFIG_PATH, readLioSaveconfig, storageObjectsByName } from '../parsers/lio-saveconfig.js'
import { PVE_STORAGE_CFG, readPveStorages, readZfsMountpoints } from '../parsers/pve-storage.js'
import { readAhrPools } from './ahr-topology.js'
import { CONFIGFS_TARGET_ROOT, normalizePlugin, readConfigfs } from './iscsi-configfs.js'
import { classifyBacking, deriveOwnership } from './iscsi-ownership.js'

/** `/usr/bin/ip` — the REAL binary on Debian/PVE (`/usr/sbin/ip` is a symlink). */
const IP = '/usr/bin/ip'

export { normalizePlugin }

/** Every path the iSCSI read layer touches, injectable end to end for tests. */
export interface IscsiPaths {
  /** configfs target root; defaults to `/sys/kernel/config/target`. */
  configfsRoot?: string
  /** `/sys/class/block` root (a zvol LUN's size). */
  blockRoot?: string
  /** LIO's persisted config; defaults to `/etc/rtslib-fb-target/saveconfig.json`. */
  saveconfigPath?: string
  /** PVE's storage.cfg; defaults to `/etc/pve/storage.cfg`. */
  pveStorageCfg?: string
}

/** Everything one iSCSI read needs, gathered once and shared by all four routes. */
export interface IscsiReadContext {
  live: LioLiveState
  /** Null when saveconfig.json is absent or unparseable. */
  persisted: LioSaveconfig | null
  inputs: OwnershipInputs
  /**
   * Addresses this node's interfaces currently carry. NULL means "could not be
   * read" — which is NOT the same as "none", and is why a portal's
   * `carriedByInterface` is nullable (GT-24 says LIO will never tell us).
   */
  nodeAddresses: Set<string> | null
}

/**
 * Availability from a gathered context — the honest "is LIO even here" shape.
 *
 * **Kernel modules are not ANAS's to manage, and there is no load-on-first-use
 * to arrange** (story `iscsi.5`, GT-4). `targetctl restore` with no saved config
 * loads `target_core_mod` alone; the FIRST `targetcli` invocation that touches a
 * backstore or a fabric loads the lot — `target_core_user`, `uio`,
 * `target_core_pscsi`, `target_core_file`, `target_core_iblock`,
 * `iscsi_target_mod` — including the two plugins ANAS never uses, because rtslib
 * probes every backstore plugin it has. That is rtslib's behaviour, it is
 * all-or-nothing, and nothing on ANAS's side can make it lazy. So ANAS loads no
 * module itself (no `modprobe` anywhere in this codebase), builds nothing, and
 * the reason below says so rather than implying a knob exists.
 */
export function iscsiAvailability(ctx: IscsiReadContext): IscsiAvailability {
  const configfsPresent = ctx.live.present
  const saveconfigPresent = ctx.persisted !== null
  const installed = configfsPresent || saveconfigPresent
  if (installed)
    return { installed, configfsPresent, saveconfigPresent }
  return {
    installed,
    configfsPresent,
    saveconfigPresent,
    reason: 'The LIO iSCSI target stack is not present on this node (no configfs target tree and no saved configuration) '
      + '— install targetcli-fb and python3-rtslib-fb to serve block storage. Installing them costs nothing at rest: '
      + 'the target kernel modules arrive with the first real targetcli call, and rtslib loads every backstore plugin '
      + 'at once — there is no load-on-first-use to arrange, and ANAS never loads one itself.',
  }
}

/** Parse `ip -j addr` into the set of addresses this node carries. */
export function parseIpAddrJson(stdout: string): Set<string> {
  const out = new Set<string>()
  let doc: unknown
  try {
    doc = JSON.parse(stdout)
  }
  catch {
    return out
  }
  if (!Array.isArray(doc))
    return out
  for (const link of doc) {
    if (typeof link !== 'object' || link === null)
      continue
    const addrInfo = (link as { addr_info?: unknown }).addr_info
    if (!Array.isArray(addrInfo))
      continue
    for (const a of addrInfo) {
      if (typeof a !== 'object' || a === null)
        continue
      const local = (a as { local?: unknown }).local
      if (typeof local === 'string' && local.length > 0)
        out.add(local.toLowerCase())
    }
  }
  return out
}

/**
 * Read the node's own addresses, FAIL-OPEN to null. `ip -j addr` is structured
 * output (Principle 13) and args go through the executor as an array.
 */
export async function readNodeAddresses(executor: CommandExecutor): Promise<Set<string> | null> {
  try {
    const r = await executor.exec(IP, ['-j', 'addr'])
    if (r.exitCode !== 0 || r.stdout.trim() === '')
      return null
    const set = parseIpAddrJson(r.stdout)
    return set.size > 0 ? set : null
  }
  catch {
    return null
  }
}

/** Does a backing path resolve right now? Null when the check itself failed. */
async function backingExists(path: string): Promise<boolean | null> {
  if (!path.startsWith('/'))
    return null
  try {
    await stat(path)
    return true
  }
  catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT / ENOTDIR are a real answer: the backing object is gone (a `zfs
    // rename` under a live LUN leaves exactly this, GT-40). Anything else
    // (EACCES, EIO) is "we do not know", not "missing".
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null
  }
}

/**
 * Gather every source one iSCSI read needs.
 *
 * Reads in stages so a node with no targets costs two `stat`s: configfs and
 * saveconfig first, and only if something is there do the PVE/ZFS/interface
 * reads happen.
 */
export async function readIscsiContext(
  executor: CommandExecutor,
  paths: IscsiPaths = {},
): Promise<IscsiReadContext> {
  const [live, persisted] = await Promise.all([
    readConfigfs({ root: paths.configfsRoot ?? CONFIGFS_TARGET_ROOT, blockRoot: paths.blockRoot }),
    readLioSaveconfig(paths.saveconfigPath ?? LIO_SAVECONFIG_PATH),
  ])

  const empty: IscsiReadContext = {
    live,
    persisted,
    inputs: { pveStorages: new Map(), zfsMountpoints: [] },
    nodeAddresses: null,
  }

  const hasTargets = live.targets.length > 0 || (persisted?.targets.length ?? 0) > 0
  if (!hasTargets)
    return empty

  const [zfsMountpoints, nodeAddresses] = await Promise.all([
    readZfsMountpoints(),
    readNodeAddresses(executor),
  ])
  const pveStorages = await readPveStorages(paths.pveStorageCfg ?? PVE_STORAGE_CFG, zfsMountpoints)

  const inputs: OwnershipInputs = { pveStorages, zfsMountpoints }

  // AHR topology is the expensive read (mdstat + LVM + btrfs), so it happens
  // only when a LUN is backed by a FILE that resolved onto no ZFS dataset — the
  // only case where an AHR pool could be the answer.
  const needsAhr = collectBackingPaths(live, persisted).some((p) => {
    if (p.startsWith('/dev/'))
      return false
    return classifyBacking(p, inputs).kind === 'foreign'
  })
  if (needsAhr) {
    try {
      const pools = await readAhrPools(executor)
      inputs.ahrMountpoints = new Map(
        pools.filter(p => p.mountpoint.length > 0).map(p => [p.name, p.mountpoint]),
      )
    }
    catch {
      // Fail-open: without AHR topology a file on an AHR pool reads as foreign,
      // which is a hands-off badge, not a broken screen.
    }
  }

  return { live, persisted, inputs, nodeAddresses }
}

/** Every distinct backing path either source knows about. */
function collectBackingPaths(live: LioLiveState, persisted: LioSaveconfig | null): string[] {
  const out = new Set<string>()
  for (const b of live.backstores) {
    if (b.udevPath)
      out.add(b.udevPath)
  }
  for (const s of persisted?.storageObjects ?? []) {
    if (s.dev)
      out.add(s.dev)
  }
  return [...out]
}

/** Attributes from configfs (the authoritative view — GT-12). */
function attributesFromLive(b: ConfigfsBackstore): IscsiLunAttributes {
  const a = b.attributes
  const out: IscsiLunAttributes = {}
  if (a.emulate_tpu !== undefined)
    out.emulateTpu = a.emulate_tpu !== 0
  if (a.emulate_tpws !== undefined)
    out.emulateTpws = a.emulate_tpws !== 0
  if (a.block_size !== undefined)
    out.blockSize = a.block_size
  if (a.emulate_write_cache !== undefined)
    out.writeBack = a.emulate_write_cache !== 0
  if (a.max_unmap_lba_count !== undefined)
    out.maxUnmapLbaCount = a.max_unmap_lba_count
  return out
}

/**
 * Attributes from saveconfig — the fallback for a LUN with no live counterpart.
 * The saveconfig `attributes{}` set is NOT the same set as configfs's (GT-12),
 * so this is used only when there is nothing live to read.
 */
export function attributesFromPersisted(s: SaveconfigStorageObject): IscsiLunAttributes {
  const a = s.attributes
  const out: IscsiLunAttributes = {}
  if (a.emulate_tpu !== undefined)
    out.emulateTpu = a.emulate_tpu !== 0
  if (a.emulate_tpws !== undefined)
    out.emulateTpws = a.emulate_tpws !== 0
  if (a.block_size !== undefined)
    out.blockSize = a.block_size
  if (a.emulate_write_cache !== undefined)
    out.writeBack = a.emulate_write_cache !== 0
  else if (s.writeBack !== null)
    out.writeBack = s.writeBack
  if (a.max_unmap_lba_count !== undefined)
    out.maxUnmapLbaCount = a.max_unmap_lba_count
  return out
}

/** Key a portal by its normalised address and port. */
function portalKey(address: string, port: number): string {
  return `${address.toLowerCase()}:${port}`
}

function buildPortal(p: ConfigfsPortal | { address: string, port: number, ipv6: boolean, iser?: boolean | null, offload?: boolean | null }, nodeAddresses: Set<string> | null): IscsiPortal {
  const portal: IscsiPortal = {
    address: p.address,
    port: p.port,
    family: p.ipv6 ? 'inet6' : 'inet',
    // Null, not false, when the node's addresses are unknown: "we could not
    // check" must never render as "the address is gone".
    carriedByInterface: nodeAddresses === null ? null : nodeAddresses.has(p.address.toLowerCase()),
  }
  const iser = (p as { iser?: boolean | null }).iser
  if (iser !== undefined && iser !== null)
    portal.iser = iser
  const offload = (p as { offload?: boolean | null }).offload
  if (offload !== undefined && offload !== null)
    portal.offload = offload
  return portal
}

function buildAclFromLive(a: ConfigfsAcl): IscsiAcl {
  const acl: IscsiAcl = {
    initiatorIqn: a.initiatorIqn,
    chapUserid: a.chapUserid,
    chapCredentialsSet: a.chapCredentialsSet,
    mutualUserid: a.mutualUserid,
    mutualCredentialsSet: a.mutualCredentialsSet,
    mappedLuns: a.mappedLuns,
  }
  if (a.authenticateTarget !== null)
    acl.authenticateTarget = a.authenticateTarget
  return acl
}

/**
 * Build the full detail for every target either source knows about.
 *
 * The union is deliberate: a target that is live but not persisted would vanish
 * at the next boot, and a target that is persisted but not live is a restore
 * that did not happen. Both are things an operator needs to see, so neither is
 * silently dropped.
 */
export async function buildIscsiTargets(ctx: IscsiReadContext): Promise<IscsiTargetDetail[]> {
  const persistedByIqn = new Map((ctx.persisted?.targets ?? []).map(t => [t.iqn, t]))
  const liveByIqn = new Map(ctx.live.targets.map(t => [t.iqn, t]))
  const persistedStorage = ctx.persisted ? storageObjectsByName(ctx.persisted) : new Map<string, SaveconfigStorageObject>()
  const liveStorage = new Map(ctx.live.backstores.map(b => [b.name, b]))

  const iqns = [...new Set([...liveByIqn.keys(), ...persistedByIqn.keys()])]
  iqns.sort()
  const out: IscsiTargetDetail[] = []

  for (const iqn of iqns) {
    const liveTarget = liveByIqn.get(iqn)
    const persistedTarget = persistedByIqn.get(iqn)
    // ANAS creates exactly one TPG per target; a foreign target may have more,
    // and the first (lowest tag) is the one the summary describes.
    const liveTpg = liveTarget?.tpgs[0]
    const persistedTpg = persistedTarget?.tpgs[0]
    const tpgTag = liveTpg?.tag ?? persistedTpg?.tag ?? 1

    // --- portals: union, live first ---------------------------------------
    const portals = new Map<string, IscsiPortal>()
    for (const p of liveTpg?.portals ?? [])
      portals.set(portalKey(p.address, p.port), buildPortal(p, ctx.nodeAddresses))
    for (const p of persistedTpg?.portals ?? []) {
      const key = portalKey(p.address, p.port)
      if (!portals.has(key))
        portals.set(key, buildPortal(p, ctx.nodeAddresses))
    }

    // --- ACLs: union, live first ------------------------------------------
    const acls = new Map<string, IscsiAcl>()
    for (const a of liveTpg?.acls ?? [])
      acls.set(a.initiatorIqn, buildAclFromLive(a))
    for (const a of persistedTpg?.acls ?? []) {
      if (!acls.has(a.initiatorIqn)) {
        acls.set(a.initiatorIqn, {
          initiatorIqn: a.initiatorIqn,
          chapUserid: a.chapUserid,
          chapCredentialsSet: a.chapCredentialsSet,
          mutualUserid: a.mutualUserid,
          mutualCredentialsSet: a.mutualCredentialsSet,
          mappedLuns: a.mappedLuns,
        })
      }
    }

    // --- sessions: from the live ACLs' `info` (GT-38) ----------------------
    const sessions: IscsiSession[] = []
    for (const a of liveTpg?.acls ?? []) {
      if (!a.session)
        continue
      sessions.push({
        initiatorIqn: a.session.initiatorIqn,
        initiatorAlias: a.session.initiatorAlias,
        targetIqn: iqn,
        tpgTag,
        sessionId: a.session.sessionId,
        state: a.session.state,
        connections: a.session.connections,
        mappedLuns: a.mappedLuns,
      })
    }

    // --- LUNs: union by index ---------------------------------------------
    const lunIndexes = new Set<number>()
    for (const l of liveTpg?.luns ?? [])
      lunIndexes.add(l.index)
    for (const l of persistedTpg?.luns ?? [])
      lunIndexes.add(l.index)

    const liveLunByIndex = new Map((liveTpg?.luns ?? []).map(l => [l.index, l]))
    const persistedLunByIndex = new Map((persistedTpg?.luns ?? []).map(l => [l.index, l]))

    const luns: IscsiLun[] = []
    const sortedLunIndexes = [...lunIndexes]
    sortedLunIndexes.sort((a, b) => a - b)
    for (const index of sortedLunIndexes) {
      const liveLun = liveLunByIndex.get(index)
      const persistedLun = persistedLunByIndex.get(index)
      const name = liveLun?.backstoreName ?? persistedLun?.backstoreName ?? ''
      const liveBackstore = name ? liveStorage.get(name) : undefined
      const persistedBackstore = name ? persistedStorage.get(name) : undefined

      const plugin = normalizePlugin(
        liveBackstore?.plugin ?? liveLun?.plugin ?? persistedBackstore?.plugin ?? persistedLun?.plugin ?? '',
      )
      const backingPath = liveBackstore?.udevPath || persistedBackstore?.dev || ''
      // The existence check comes FIRST because the classification depends on
      // it: a backing that resolves onto nothing ANAS manages is `foreign` only
      // when it is actually THERE. When it is not, it is `unresolved` — the
      // boot-restore hole — and that must not cost the target its ownership
      // (story `iscsi.5`, live-proof F2).
      const exists = backingPath ? await backingExists(backingPath) : null
      const classification = classifyBacking(backingPath, ctx.inputs, exists)

      const lun: IscsiLun = {
        index,
        name,
        // A backing that positively resolves onto storage ANAS does not manage
        // is `foreign`; one that resolves onto nothing at all is `unresolved`; a
        // zvol/file whose path has merely gone stale keeps its kind and reports
        // `backingExists: false` instead (GT-40).
        kind: classification.kind,
        plugin,
        backingPath,
        size: liveBackstore?.size ?? persistedBackstore?.size ?? null,
        // Serial: live first, but the persisted `wwn` is the SAME string — it is
        // what a restore replays, which is why a reboot preserves identity for
        // free (GT-19).
        serial: liveBackstore?.serial ?? persistedBackstore?.wwn ?? null,
        attributes: liveBackstore
          ? attributesFromLive(liveBackstore)
          : persistedBackstore
            ? attributesFromPersisted(persistedBackstore)
            : {},
        connectedInitiators: sessions
          .filter(s => s.mappedLuns.includes(index))
          .map(s => s.initiatorIqn),
        present: liveLun !== undefined && liveBackstore !== undefined,
        backingExists: exists,
      }
      if (classification.pool)
        lun.pool = classification.pool
      if (classification.dataset)
        lun.dataset = classification.dataset
      luns.push(lun)
    }

    // --- ownership ---------------------------------------------------------
    const ownershipLuns: OwnershipLun[] = luns.map(l => ({
      name: l.name,
      backingPath: l.backingPath,
      backingExists: l.backingExists,
    }))
    const ownership = deriveOwnership(iqn, ownershipLuns, ctx.inputs)

    const portalList = [...portals.values()]
    out.push({
      iqn,
      name: anasTargetName(iqn),
      ownership: ownership.ownership,
      ownershipReason: ownership.reason,
      ownershipDetail: ownership.detail,
      tpgTag,
      enabled: liveTpg?.enabled ?? persistedTpg?.enable ?? false,
      portals: portalList,
      lunCount: luns.length,
      aclCount: acls.size,
      sessionCount: sessions.length,
      security: {
        authentication: liveTpg?.authentication ?? persistedTpg?.authentication ?? false,
        generateNodeAcls: liveTpg?.generateNodeAcls ?? persistedTpg?.generateNodeAcls ?? false,
        demoModeDiscovery: liveTpg?.demoModeDiscovery ?? persistedTpg?.demoModeDiscovery ?? false,
      },
      present: liveTarget !== undefined,
      persisted: persistedTarget !== undefined,
      missingLunCount: luns.filter(l => !l.present).length,
      portalsWithoutInterfaceCount: portalList.filter(p => p.carriedByInterface === false).length,
      luns,
      acls: [...acls.values()],
      sessions,
    })
  }

  return out
}

/** Every live session on the node, flattened out of the target details. */
export function collectIscsiSessions(targets: IscsiTargetDetail[]): IscsiSession[] {
  return targets.flatMap(t => t.sessions)
}

/** Drop the detail arrays — the grid row shape. */
export function toTargetSummary(detail: IscsiTargetDetail) {
  const { luns: _luns, acls: _acls, sessions: _sessions, ...summary } = detail
  return summary
}
