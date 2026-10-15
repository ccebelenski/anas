import type { Disk, ExpansionTarget, PoolDetail, PoolExpansionReport, PoolSummary, PveOwnership, VdevSpec } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ParsedPoolStatus } from '../parsers/zpool-status.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Advisory, Gate, GuardReads, GuardSpec } from '../safety/guard.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { PveFootprint } from '../services/pve-footprint.js'
import { AddVdevRequest, AttachDiskRequest, CreatePoolRequest, DestroyPoolQuery, ExportPoolRequest, ImportPoolRequest, isComposableDisk, isRemovableVdevRole, PoolMountpointRequest, PoolName, pveStoragePath, RemoveVdevRequest, ScrubRequest, TrimPoolRequest, UpdatePoolPropertiesRequest } from '@anas/shared'
import { parseByIdToKernel, parseByIdToKernelFull, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { hasMount } from '../parsers/fstab.js'
import { PVE_STORAGE_CFG } from '../parsers/pve-storage.js'
import { parseZpoolFeature, parseZpoolGet } from '../parsers/zpool-get.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parsePoolBusyState, parseZpoolStatus, parseZpoolStatusPool } from '../parsers/zpool-status.js'
import { parseZpoolUpgrade } from '../parsers/zpool-upgrade.js'
import { confirmGate } from '../safety/gate.js'
import { guardCheck, guardConfirm, guarded, sendRefusal } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { enrichBusyError } from '../services/busy-diagnosis.js'
import { readConfig } from '../services/config-writer.js'
import { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { configfsOptionsFrom, createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import { poolReferenceKey, poolReferenceWarning, poolUnreadableWarning, readPoolReferences } from '../services/pool-references.js'
import { loadPveFootprint, systemPoolRefusalFrom } from '../services/pve-footprint.js'
import { buildCapability, buildExpansionTargets, busyDetail, detectLocalZfsVersion, RAIDZ_EXPANSION_FEATURE, raidzParity } from '../services/zfs-expansion.js'
import { syncZfsImportUnit } from '../services/zfs-import-unit.js'
import { isVdevRefusal, resolveLeafDevice, unknownVdevMessage } from '../services/zfs-vdev-leaf.js'
import { NON_REMOVABLE_VDEV_MESSAGE, resolveVdev, stillPresentMessage, unreadablePoolMessage, vdevStillPresent } from '../services/zfs-vdev-remove.js'
import { collectDisks, resolveLeafKernel } from './disks.js'
import { requireIdentity } from './identity.js'

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'
const LSBLK = '/usr/bin/lsblk'
const BLKID = '/usr/sbin/blkid'
const FINDMNT = '/usr/bin/findmnt'
/** findmnt args for live-mount collision checks (matches the AHR precedent). */
const FINDMNT_ARGS = ['--json', '--real']

const BY_ID_PREFIX = '/dev/disk/by-id/'
const PART_BY_ID_RE = /-part\d+$/
/** `/dev/sdb1`, `/dev/nvme0n1p2` — a leaf ZFS named by its kernel device. */
const KERNEL_DEV_PATH_RE = /^\/dev\/([a-z0-9]+)$/
const TRAILING_CR_RE = /\r$/
const TRAILING_SLASHES_RE = /\/+$/
/** ZFS vdev names (raidz1-0, mirror-0, …) — charset guard for raidz-expand. */
const VDEV_NAME_RE = /^[\w-]+$/
/**
 * How long a vdev-remove job waits for the vdev to leave `zpool status` (story
 * vdevs.2). `zpool remove` of a log exits as soon as the ZIL flush is under
 * way, so a re-read straight afterwards can still show it.
 */
const VDEV_REMOVE_SETTLE_MS = 10_000
/** Gap between the settle re-reads. */
const VDEV_REMOVE_POLL_MS = 250

/** The advisory key of the LIO-unreadable disclosure (export/destroy confirms). */
const LIO_UNREADABLE_KEY = 'lio-unreadable'
/** Fail-open is not fail-silent (D3): what the confirm says when the claims read broke. */
const LIO_UNREADABLE_WARNING = 'ANAS could not check whether an iSCSI LUN is served from this pool — the LIO configuration was unreadable. If this node serves iSCSI, verify by hand before confirming.'

/**
 * Story cr.32 (WAVE3-DESIGN §5.2 rule 1): the request fields the export and
 * destroy confirms do NOT sign, each with its reason. None: every field
 * changes what the job does. `pools-guard.test.ts` pins both lists.
 */
export const POOL_EXPORT_PRESENTATION_ONLY: Record<string, string> = {}
export const POOL_DESTROY_PRESENTATION_ONLY: Record<string, string> = {}

/** A destroyed pool's vdev leaf, resolved for disk hygiene (story 3.14). */
interface PoolLeaf {
  /**
   * Identity of the ACTUAL vdev device — WITH any `-partN` suffix, because that
   * is where ZFS wrote its four labels (two front, two back). `labelclear`/
   * `wipefs` must target this, not the whole disk: the parser's `disk.id`
   * already strips `-partN`, which would mis-target the whole-disk device and
   * leave the partition's labels intact. A by-id name where ZFS gave one, else
   * the kernel name. Reported back to the caller, so it names what was cleaned.
   */
  leafId: string
  /** The leaf's REAL device path — labelclear + wipefs target. */
  leafPath: string
  /**
   * Identity of the WHOLE disk (leafId minus its partition suffix). Absent for
   * a leaf ZFS names by any other path (by-partuuid, by-path, by-vdev, …):
   * that string cannot be reduced to a disk, so the job asks `lsblk`
   * (ident.1, audit #2 — never the stripped by-id whole disk).
   */
  wholeDiskId?: string
  /** The WHOLE disk's REAL device path — the GPT-zap and ownership-probe target. */
  wholeDiskPath?: string
  /** The leaf's vdev state from `zpool status` (ident.1: only ONLINE leaves are cleaned). */
  state?: string
  /**
   * The leaf's KERNEL partition name when ZFS named the device directly
   * (`/dev/sdb1`) rather than through by-id. The ownership guard resolves our
   * own partitions through the by-id map; a leaf that never had a by-id needs
   * this instead, or every partition of the disk reads as a stranger's.
   */
  leafKernel?: string
}

/**
 * EVERY leaf of EVERY vdev class of a pool — data, log, cache, spare, special
 * and dedup alike. The one `vdevGroups` walk both the destroy cleanup and the
 * pool-list trim probe share, so "which classes count as leaves" is decided in
 * ONE place (vdevs.1 consumer audit, GitHub #66: a leaf of a log, special or
 * dedup vdev was invisible while the parser dropped those sections, and each
 * consumer would have had to learn about them separately).
 *
 * Exported for the consumer-audit tests.
 */
export function allVdevLeaves(pool: ParsedPoolStatus): LeafRef[] {
  const leaves: LeafRef[] = []
  for (const group of pool.vdevGroups) {
    for (const vdev of group.vdevs) {
      for (const disk of vdev.disks)
        leaves.push({ id: disk.id, path: disk.path, state: disk.state })
    }
  }
  return leaves
}

/**
 * Resolve a destroyed pool's leaves for cleanup. The leaf's real device node is
 * `disk.path` (`…-part1` for a partition vdev, the whole-disk by-id for a bare-
 * disk vdev); prefer it so labelclear hits the partition that actually holds the
 * labels. The whole disk is derived by stripping the trailing `-partN` from the
 * by-id name — uniform and nvme-safe (never a `sdb`+`1` / `nvme0n1`+`p1` concat).
 *
 * A pool built on the command line from `/dev/sdX` names has NO by-id anywhere
 * in `zpool status`: ZFS reports the kernel path and the kernel name. Composing
 * `/dev/disk/by-id/sdb1` out of that names nothing, so the cleanup used to fail
 * on every leaf of such a pool and leave the disk labelled (vdevs.1 live proof).
 * Those leaves are addressed by their kernel device instead, whole disk
 * included, through the same partition-suffix reduction the disk join uses.
 *
 * Any OTHER leaf path (by-partuuid, by-path, by-vdev, a mapper node) is used
 * exactly as ZFS reports it (story ident.1, audit #2). The old fallback read
 * the parser's id — already stripped of `-partN` — as a by-id name, so a
 * by-partuuid partition leaf resolved to the WHOLE disk and `wipefs -a`
 * erased its partition table. Such a leaf carries no whole disk here; the job
 * resolves it with `lsblk` before the zap guard.
 *
 * Exported for the consumer-audit tests.
 */
export function leavesFromStatus(pool: ParsedPoolStatus): PoolLeaf[] {
  return allVdevLeaves(pool).map(({ path, state }) => {
    const st = state ? { state } : {}
    if (path.startsWith(BY_ID_PREFIX)) {
      const leafId = path.slice(BY_ID_PREFIX.length)
      const wholeDiskId = leafId.replace(PART_BY_ID_RE, '')
      return {
        leafId,
        leafPath: `${BY_ID_PREFIX}${leafId}`,
        wholeDiskId,
        wholeDiskPath: `${BY_ID_PREFIX}${wholeDiskId}`,
        ...st,
      }
    }
    const kernel = KERNEL_DEV_PATH_RE.exec(path)?.[1]
    if (kernel) {
      const wholeDiskId = wholeDiskKernel(kernel)
      return {
        leafId: kernel,
        leafPath: `/dev/${kernel}`,
        wholeDiskId,
        wholeDiskPath: `/dev/${wholeDiskId}`,
        leafKernel: kernel,
        ...st,
      }
    }
    // Any other path: as given — never reduced to a guessed whole disk.
    return { leafId: path, leafPath: path, ...st }
  })
}

interface LsblkLeafRaw { name?: string, pkname?: string | null, type?: string }

/**
 * Resolve a leaf ZFS names by a path that is neither by-id nor a kernel name
 * (ident.1): `lsblk -J -o NAME,PKNAME,TYPE <path>` follows the symlink to the
 * kernel device. A partition's whole disk is its PKNAME; a whole-disk leaf is
 * its own. Null when lsblk cannot say — the disk is then never zapped.
 */
export function parseLsblkLeaf(json: string): { kernel: string, wholeKernel: string } | null {
  let dev: LsblkLeafRaw | undefined
  try {
    dev = (JSON.parse(json) as { blockdevices?: LsblkLeafRaw[] }).blockdevices?.[0]
  }
  catch {
    return null
  }
  if (!dev?.name)
    return null
  if (dev.type === 'part')
    return dev.pkname ? { kernel: dev.name, wholeKernel: dev.pkname } : null
  return { kernel: dev.name, wholeKernel: dev.name }
}

/** Whole-disk ownership verdict for the destroy-cleanup GPT-zap guard. */
type DiskOwnership = 'exclusive' | 'shared' | 'uncertain'

interface LsblkOwnChild { name?: string, type?: string, fstype?: string | null, mountpoint?: string | null, children?: unknown[] }

/**
 * SAFETY-CRITICAL guard: is a whole disk EXCLUSIVELY the destroyed pool's, so
 * its GPT can be zapped, or is it SHARED physical media that must be left intact?
 *
 * Enumerate the disk's partitions (structured `lsblk -J`). Every partition that
 * is NOT one of this pool's just-cleared leaves is examined for foreign use — a
 * mountpoint, any filesystem/RAID/LVM/zpool signature, or an active device-mapper
 * child. ANY such partition ⇒ `shared` (never zap; the neighbour's data is
 * untouchable). ZFS's own blank reserved `-part9` carries none of these, so it
 * does not block the zap. If the probe errors or can't be parsed ⇒ `uncertain`,
 * and the CONSERVATIVE default leaves the disk partitioned.
 */
async function evaluateDiskOwnership(
  executor: CommandExecutor,
  wholeDiskPath: string,
  diskLeaves: PoolLeaf[],
  byIdToKernel: Map<string, string>,
): Promise<DiskOwnership> {
  // Kernel names of OUR leaves on this disk — excluded from the foreign scan.
  // A leaf ZFS named by its kernel device carries that name itself; every other
  // leaf resolves through the by-id map.
  const ourKernels = new Set<string>()
  for (const leaf of diskLeaves) {
    const kernel = byIdToKernel.get(leaf.leafId) ?? leaf.leafKernel
    if (kernel)
      ourKernels.add(kernel)
  }

  const probe = await executor.exec(LSBLK, ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', wholeDiskPath])
  if (probe.exitCode !== 0)
    return 'uncertain'

  let dev: { children?: LsblkOwnChild[] } | undefined
  try {
    const parsed = JSON.parse(probe.stdout) as { blockdevices?: { children?: LsblkOwnChild[] }[] }
    dev = parsed.blockdevices?.[0]
  }
  catch {
    return 'uncertain'
  }
  if (!dev)
    return 'uncertain'

  for (const child of dev.children ?? []) {
    if (child.type !== 'part' || !child.name)
      continue
    if (ourKernels.has(child.name))
      continue // ours — already labelcleared + wiped, never foreign.
    const inUse
      = (child.mountpoint != null && child.mountpoint !== '')
        || (child.fstype != null && child.fstype !== '')
        || (Array.isArray(child.children) && child.children.length > 0)
    if (inUse)
      return 'shared'
  }
  return 'exclusive'
}

/** The pool root dataset's mountpoint + mounted flag (story 3.27). */
interface PoolMount {
  /** The `mountpoint` property value: a path, or `legacy`/`none`/`-`. */
  mountpoint: string
  /** Whether the `mounted` property reports `yes`. */
  mounted: boolean
}

/**
 * Parse `zfs list -H -o name,mountpoint,mounted` into a dataset-name →
 * {mountpoint, mounted} map. Tab-separated, header-less rows. Pure and total:
 * malformed rows are skipped, never throws. Keyed by full dataset name so the
 * caller looks up a pool root by its bare name.
 */
export function parsePoolMountpoints(text: string): Map<string, PoolMount> {
  const out = new Map<string, PoolMount>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.trim() === '')
      continue
    const parts = line.split('\t')
    if (parts.length < 3)
      continue
    const name = parts[0].trim()
    if (!name)
      continue
    out.set(name, { mountpoint: parts[1].trim(), mounted: parts[2].trim() === 'yes' })
  }
  return out
}

/** Read every dataset's mountpoint + mounted flag, FAIL-OPEN (→ empty map). */
async function readPoolMountpoints(executor: CommandExecutor): Promise<Map<string, PoolMount>> {
  const res = await executor.exec(ZFS, ['list', '-H', '-o', 'name,mountpoint,mounted'])
  return res.exitCode === 0 ? parsePoolMountpoints(res.stdout) : new Map()
}

/**
 * A pool's descendant datasets that set their OWN explicit mountpoint (source
 * `local`/`received`) — these do NOT inherit the pool root, so a `zfs set
 * mountpoint` on the root leaves them where they are (story 3.27 confirm text).
 * Reads `zfs get -Hp -r -o name,value,source mountpoint <pool>`; FAIL-OPEN.
 */
async function readExplicitChildMountpoints(
  executor: CommandExecutor,
  poolName: string,
): Promise<{ name: string, value: string }[]> {
  const res = await executor.exec(ZFS, ['get', '-Hp', '-r', '-o', 'name,value,source', 'mountpoint', '--', poolName])
  if (res.exitCode !== 0)
    return []
  const out: { name: string, value: string }[] = []
  for (const rawLine of res.stdout.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.trim() === '')
      continue
    const parts = line.split('\t')
    if (parts.length < 3)
      continue
    const [name, value, source] = parts.map(p => p.trim())
    // The root itself is not a child; only 'local'/'received' are explicit
    // (inherited/default/`-` all track the pool root and move with it).
    if (!name || name === poolName)
      continue
    if (source.startsWith('local') || source.startsWith('received'))
      out.push({ name, value })
  }
  return out
}

/**
 * lsblk args to probe per-device discard support (Epic 4.12 trim gating).
 *  `-b` bytes, `-J` JSON, `-n` no headings, `-o NAME,DISC-GRAN`. A device is
 *  discard-capable iff its DISC-GRAN (discard granularity) is greater than 0.
 */
export const LSBLK_DISCARD_ARGS = ['-Jbno', 'NAME,DISC-GRAN']

/**
 * A leaf device reference from a pool's topology — enough to resolve it to a
 *  whole-disk kernel name via {@link resolveLeafKernel}.
 */
interface LeafRef {
  id: string
  path: string
  /** The leaf's vdev state (ONLINE, DEGRADED, UNAVAIL, …). */
  state?: string
}

interface LsblkDiscardRaw {
  'name': string
  'disc-gran'?: number | string | null
  'children'?: LsblkDiscardRaw[]
}

/**
 * Parse `lsblk -Jbno NAME,DISC-GRAN` into the set of whole-disk KERNEL names
 * whose discard granularity is > 0 (i.e. the device supports TRIM/discard).
 * Partitions are reduced to their whole disk so the set keys the same way
 * {@link resolveLeafKernel} canonicalizes pool leaves. Fail-open: malformed
 * output yields an empty set.
 */
export function parseDiscardCapableKernels(lsblkJson: string): Set<string> {
  const capable = new Set<string>()
  let data: { blockdevices?: LsblkDiscardRaw[] }
  try {
    data = JSON.parse(lsblkJson)
  }
  catch {
    return capable
  }
  const walk = (dev: LsblkDiscardRaw): void => {
    if ((Number(dev['disc-gran']) || 0) > 0)
      capable.add(wholeDiskKernel(dev.name))
    for (const child of dev.children ?? [])
      walk(child)
  }
  for (const dev of data.blockdevices ?? [])
    walk(dev)
  return capable
}

/**
 * Whether ANY leaf of a pool lives on a discard-capable device. Each leaf is
 * canonicalized to its whole-disk kernel name (the identity both zpool-status
 * and lsblk agree on — see resolveLeafKernel) and tested against the capable
 * set. Unresolvable leaves are simply skipped — never throws.
 */
export function poolTrimSupported(
  leaves: LeafRef[],
  byIdToKernel: Map<string, string>,
  capableKernels: Set<string>,
): boolean {
  for (const leaf of leaves) {
    const kernel = resolveLeafKernel(leaf.id, leaf.path, byIdToKernel)
    if (kernel && capableKernels.has(kernel))
      return true
  }
  return false
}

/**
 * Map a disk by-id identifier to its stable /dev/disk/by-id path. The id is
 * the validated basename: every request path to here passes the DiskId
 * schema (no `/`, no whitespace — cr.12) and the live inventory check, so
 * this cannot be steered out of the by-id directory (review H4).
 */
function byIdPath(id: string): string {
  return `/dev/disk/by-id/${id}`
}

/**
 * The result of the composability pre-flight (cr.12): the named per-disk
 * problems, or WHY the inventory could not be read. Two altitudes — bad
 * disks are a 400 naming them; an unreadable inventory fails CLOSED as a
 * 409 with reason 'unreadable' (the attach route's unreadable-status idiom).
 */
type ComposableCheck = { problems: string[] } | { unreadable: string }

/**
 * Whether a vdev spec carries redundancy. Every VdevSpec type except our
 * synthetic 'stripe' (bare disks, no redundancy keyword) has a per-type minimum
 * enforced by the schema (mirror ≥ 2, raidzN at its min), so "not a stripe" is a
 * sufficient redundancy test. Used to reject a special/dedup vdev whose loss
 * would take the whole pool (story 3.22).
 */
function isRedundantSpec(vdev: { type: string }): boolean {
  return vdev.type !== 'stripe'
}

/**
 * Build the `zpool create` argument array from a validated CreatePoolRequest.
 *
 * A data vdev contributes its redundancy keyword followed by its disk paths
 * (mirror → ['mirror', d1, d2], raidz2 → ['raidz2', ...]); 'stripe' is our
 * synthetic type meaning individual disks — no keyword, just the paths.
 * Log vdevs follow a single 'log' keyword (each mirrored/striped in turn);
 * cache and spare disks follow their 'cache'/'spare' keywords as plain disks.
 */
function buildCreateArgs(req: CreatePoolRequest): string[] {
  const args: string[] = ['create']

  if (req.force)
    args.push('-f')

  const p = req.properties
  if (p) {
    if (p.ashift !== undefined)
      args.push('-o', `ashift=${p.ashift}`)
    if (p.autoexpand !== undefined)
      args.push('-o', `autoexpand=${p.autoexpand ? 'on' : 'off'}`)
    if (p.autoreplace !== undefined)
      args.push('-o', `autoreplace=${p.autoreplace ? 'on' : 'off'}`)
    if (p.autotrim !== undefined)
      args.push('-o', `autotrim=${p.autotrim ? 'on' : 'off'}`)
  }
  // Story 3.31a: ANAS-created pools default to autoexpand=on so a later
  // replace-with-larger realizes the grown capacity automatically. Still
  // overridable — only defaulted when the request said nothing about it.
  if (p?.autoexpand === undefined)
    args.push('-o', 'autoexpand=on')

  if (req.mountpoint)
    args.push('-m', req.mountpoint)

  // cr.12: `--` ends option parsing before the pool name; the vdev-class
  // keywords (mirror/raidz/…) are operand-level to zpool and still parse
  // after it (proven against the real binary).
  args.push('--', req.name)

  // Data vdevs carry no class keyword; the redundant allocation classes
  // (log/special/dedup) and the bare-disk classes (cache/spare) follow, in the
  // order zpool expects. Redundancy for special/dedup is enforced by the caller
  // (isRedundantSpec) before this runs.
  for (const vdev of req.dataVdevs)
    args.push(...vdevSpecArgs(vdev))
  pushClassVdevs(args, 'log', req.logVdevs)
  pushClassVdevs(args, 'special', req.specialVdevs)
  pushClassVdevs(args, 'dedup', req.dedupVdevs)
  pushDiskClass(args, 'cache', req.cacheDisks)
  pushDiskClass(args, 'spare', req.spareDisks)

  return args
}

/**
 * The argv fragment for one vdev spec: its redundancy keyword (mirror/raidzN)
 * unless it's the synthetic 'stripe' (bare disks, no keyword), then the by-id
 * disk paths. THE single source of the "stripe → bare, else keyword" rule that
 * both pool-create and add-vdev depend on.
 */
function vdevSpecArgs(vdev: VdevSpec): string[] {
  const args: string[] = []
  if (vdev.type !== 'stripe')
    args.push(vdev.type)
  for (const id of vdev.disks)
    args.push(byIdPath(id))
  return args
}

/**
 * Append a redundant allocation class (log/special/dedup): the class keyword
 *  once, then each vdev's spec args. No-op when the list is empty.
 */
function pushClassVdevs(args: string[], keyword: string, vdevs: VdevSpec[] | undefined): void {
  if (!vdevs || vdevs.length === 0)
    return
  args.push(keyword)
  for (const vdev of vdevs)
    args.push(...vdevSpecArgs(vdev))
}

/** Append a bare-disk class (cache/spare): the keyword then plain disk paths. */
function pushDiskClass(args: string[], keyword: string, disks: string[] | undefined): void {
  if (!disks || disks.length === 0)
    return
  args.push(keyword)
  for (const id of disks)
    args.push(byIdPath(id))
}

/** An importable pool discovered by a `zpool import` scan. */
interface ImportablePool {
  name: string
  guid: string
  state: string
}

/**
 * Parse the human-readable output of `zpool import` (no args).
 *
 * `zpool import` scan has no structured/JSON output across supported OpenZFS
 * versions, so a text parse is the only option here (documented deviation from
 * "prefer structured output" — there is none). Each importable pool is a block:
 *
 *     pool: tank
 *       id: 12345678901234567890
 *    state: ONLINE
 *   action: The pool can be imported using its name or numeric identifier.
 *   config:
 *     ...topology...
 *
 * We extract the pool: / id: / state: header fields of each block.
 */
function parseImportScan(stdout: string): ImportablePool[] {
  const pools: ImportablePool[] = []
  let current: Partial<ImportablePool> | null = null

  const push = () => {
    if (current && current.name) {
      pools.push({
        name: current.name,
        guid: current.guid ?? '',
        state: current.state ?? '',
      })
    }
  }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon === -1)
      continue // topology/config lines have no "key: value" shape
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'pool') {
      // New block starts — flush the previous one.
      push()
      current = { name: value }
    }
    else if (current && key === 'id') {
      current.guid = value
    }
    else if (current && key === 'state') {
      current.state = value
    }
  }
  push()

  return pools
}

/**
 * The pool's `pve` stamp the panel reads to grey out pool verbs: PVE's own
 * ownership of the pool root, or — cr.23 — a pool the one system-pool rule
 * flags only by FACTS the ownership read does not see (a filesystem mounted
 * at a system path, or both fact sources unreadable). Without this the panel
 * offered Export/Destroy on a pool the daemon then refused. Its children stay
 * manageable: only the pool-level verbs are refused for such a pool.
 */
export function poolStamp(pve: PveFootprint, pool: string): PveOwnership | null {
  const owned = pve.ownershipOf(pool)
  if (owned !== null || !pve.isSystemPool(pool))
    return owned
  return { kind: 'system', reason: systemPoolRefusalFrom(pve, pool).message, childrenManageable: true }
}

export async function poolRoutes(
  server: FastifyInstance,
  opts: {
    executor: CommandExecutor
    jobQueue: JobQueue
    confirmStore: ConfirmStore
    /**
     * /etc/fstab location (config IS the API) — for mountpoint collision checks.
     *  Defaults to /etc/fstab; overridable via the env-driven server wiring.
     */
    fstabPath?: string
    /**
     * smb.conf path (story cr.24) — the Export/Destroy confirms read it to name
     * SMB shares that reference the pool. Defaults in the wiring; when absent
     * the SMB-share reference kind is not checked.
     */
    smbConfPath?: string
    /**
     * /etc/exports path (story cr.24) — the NFS-export reference kind. Absent ⇒
     * not checked.
     */
    exportsPath?: string
    /**
     * The systemd unit-store dir (story cr.24) — backup/cloud/replication tasks
     * and the snapshot/scrub schedules that reference the pool. Absent ⇒ the
     * unit-store kinds are not checked.
     */
    systemdDir?: string
    /**
     * storage.cfg path for PVE-managed detection (story 3.25). Defaults to the
     *  real PVE file; overridable so the hands-off guard is testable.
     */
    pveStoragePath?: string
    /**
     * iSCSI read-layer path overrides (story iscsi.6) — the held-by-LUN gate on
     * Destroy/Export reads configfs. Defaults to the real host locations.
     */
    iscsiPaths?: IscsiPaths
    /**
     * The disk inventory's identity cache, shared with the Disks screen. The
     * disk-composability pre-flight (the AHR composer's twin) reads the
     * inventory through it; when the wiring does not hand one over, a local
     * instance is built — identity is immutable per disk, so a second cache
     * only re-reads what it has not seen, never diverges.
     */
    diskIdentityCache?: DiskIdentityCache
    /**
     * How long the vdev-remove job waits for a removed vdev to disappear from
     * `zpool status` before it calls the removal failed (story vdevs.2). A log
     * removal flushes the ZIL first, so the vdev can linger for a moment after
     * `zpool remove` has already exited 0. Defaults to 10 s; the env override
     * keeps the failure path testable without a ten-second test.
     */
    vdevRemoveSettleMs?: number
  },
) {
  const { executor, jobQueue, confirmStore } = opts
  const fstabPath = opts.fstabPath ?? '/etc/fstab'
  const vdevRemoveSettleMs = opts.vdevRemoveSettleMs ?? VDEV_REMOVE_SETTLE_MS
  const pveCfgPath = opts.pveStoragePath ?? PVE_STORAGE_CFG
  const iscsiPaths = opts.iscsiPaths ?? {}
  const diskIdentityCache = opts.diskIdentityCache ?? new DiskIdentityCache(executor)

  /**
   * The paths the pool owns (story cr.24) — every dataset's mountpoint, read
   * FRESH each call so the confirm door and the job see the pool as it is now
   * (the job-time re-read is the whole point of ruling (j)). Only path
   * mountpoints count: `legacy`/`none`/`-` have no path a reference points at.
   */
  async function poolOwnedPaths(poolName: string): Promise<string[]> {
    const mounts = await readPoolMountpoints(executor)
    const paths: string[] = []
    for (const [dataset, m] of mounts) {
      if ((dataset === poolName || dataset.startsWith(`${poolName}/`)) && m.mountpoint.startsWith('/'))
        paths.push(m.mountpoint)
    }
    return paths
  }

  /**
   * The ONE "what references this pool" answer (story cr.24). The reference
   * sources come from the same paths the share/backup/schedule/mount routes
   * edit; absent options leave a source unchecked (never unreadable).
   */
  async function poolReferences(poolName: string) {
    return readPoolReferences({
      executor,
      pool: poolName,
      paths: await poolOwnedPaths(poolName),
      // A `mountpoint=legacy` dataset of the pool mounted through fstab is the
      // pool's own filesystem, never a mount beneath it (cr.31 D3).
      ownMounts: { zfsDatasets: true },
      ...(opts.smbConfPath ? { smbConfPath: opts.smbConfPath } : {}),
      ...(opts.exportsPath ? { exportsPath: opts.exportsPath } : {}),
      ...(opts.systemdDir ? { systemdDir: opts.systemdDir } : {}),
      ...(opts.fstabPath ? { fstabPath } : {}),
    })
  }

  /**
   * The disk-composability pre-flight (the AHR composer's twin, same message
   * shape): resolve every requested disk against the live inventory and name
   * any that ANAS knows must not be composed into a pool.
   *
   * Why ZFS needs what AHR always had: `handsOff: 'iscsi-served-here'` marks the
   * GT-43 loop-back disk — the node's own LUN coming back over its own
   * initiator — and `status` marks everything else that is not genuinely blank.
   * `zpool` itself cannot see either; handed such a disk it would happily build
   * storage on top of itself. One refusal per disk, joined `; `-style.
   *
   * A disk the inventory does NOT know is refused (cr.12 / review H4, matching
   * the AHR composer): the UI only ever offers inventory ids, so an id that
   * does not resolve is either a typo or hostile input, and handing it to
   * `zpool` as `/dev/disk/by-id/<id>` to fail from the job is the worse
   * answer. An inventory that cannot be read FAILS CLOSED — the same altitude
   * the attach route takes for an unreadable `zpool status` (vdevs.2): nothing
   * about the request is wrong, the node could not answer, so it is a 409 with
   * reason 'unreadable' and no bypass. Callers distinguish the two through
   * {@link ComposableCheck}.
   */
  async function composableDiskProblems(ids: string[]): Promise<ComposableCheck> {
    let inventory: Disk[]
    try {
      inventory = await collectDisks(executor, diskIdentityCache, iscsiPaths)
    }
    catch (err: unknown) {
      const detail = err instanceof Error && err.message ? err.message : String(err)
      return { unreadable: `disk inventory could not be read (${detail})` }
    }
    const problems: string[] = []
    for (const id of ids) {
      const disk = inventory.find(d => d.id === id)
      if (!disk) {
        problems.push(`disk '${id}' not found`)
        continue
      }
      if (!isComposableDisk(disk)) {
        problems.push(disk.handsOff
          ? `disk '${id}' is hands-off: ${disk.handsOffReason ?? disk.handsOff}`
          : `disk '${id}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})`)
      }
    }
    return { problems }
  }

  /** Every disk id a create request names, across all six vdev classes. */
  function createRequestDiskIds(req: CreatePoolRequest): string[] {
    return [
      ...req.dataVdevs.flatMap(v => v.disks),
      ...(req.logVdevs ?? []).flatMap(v => v.disks),
      ...(req.specialVdevs ?? []).flatMap(v => v.disks),
      ...(req.dedupVdevs ?? []).flatMap(v => v.disks),
      ...(req.cacheDisks ?? []),
      ...(req.spareDisks ?? []),
    ]
  }

  /** Stamp `heldByLun` onto every pool a LUN holds — one read for the grid. */
  async function annotatePoolsHeldByLun(pools: PoolSummary[]): Promise<void> {
    if (pools.length === 0)
      return
    const cache = createIscsiClaimCache(executor, iscsiPaths)
    if ((await cache.claims()).length === 0)
      return
    for (const pool of pools) {
      const held = await heldByLun(cache, { pool: pool.name })
      if (held)
        pool.heldByLun = held
    }
  }

  /**
   * The PVE footprint, loaded once per request (story pvepool.1). The ONE
   * answerer for "does PVE own this pool/dataset?" — it replaces the old
   * pool-level `poolPveStorages` helper and carries the system-pool boot facts
   * the hard refusals below need.
   */
  function pveFootprint() {
    return loadPveFootprint(executor, { pveStorageCfg: pveCfgPath })
  }

  /**
   * The hard no-bypass 409 when the pool is a system pool (story cr.23: boot
   * facts or the live mount table). The sentence names the FACT that fired.
   */
  async function systemPoolBlock(poolName: string) {
    const pve = await pveFootprint()
    if (!pve.isSystemPool(poolName))
      return null
    return systemPoolRefusalFrom(pve, poolName)
  }

  /**
   * The ONE pre-flight the two vdev-shape routes stand behind — adding a vdev
   * and removing one reshape the same topology, so they ask the same two
   * questions: the system-pool 409 (this node's boot filesystem, no bypass),
   * then the PVE-ownership 400. PVE owns the topology of the pools it manages;
   * ANAS does not reshape them (story pvepool.1). Export and destroy ask the
   * same facts through their guard gates (cr.32: `poolSystemGate`,
   * `poolPveGate`, the latter a 409 PVE_MANAGED that also covers a storage
   * nested in the pool); moving these two routes onto the guard is cr.36.
   *
   * Answers the error body to return — the reply code is already set — or null
   * when the request may proceed.
   */
  async function vdevTopologyGate(poolName: string, reply: FastifyReply): Promise<object | null> {
    const systemBlock = await systemPoolBlock(poolName)
    if (systemBlock) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: systemBlock.reason, message: systemBlock.message } }
    }
    const pve = await pveFootprint()
    const owned = pve.ownershipOf(poolName)
    if (owned) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: owned.reason } }
    }
    return null
  }

  /**
   * Every leaf of a pool, for disk cleanup (labelclear + zap) and for the
   * destroy confirm's bound scope (cr.32). Null when `zpool status` cannot be
   * read or does not list the pool — UNREADABLE, never "no leaves": a
   * cleanup destroy is then refused rather than bound to an empty set.
   */
  async function readPoolLeaves(poolName: string): Promise<PoolLeaf[] | null> {
    const statusResult = await executor.exec(ZPOOL, ['status', '-jv'])
    if (statusResult.exitCode !== 0)
      return null
    const pool = parseZpoolStatusPool(statusResult.stdout, poolName)
    return pool ? leavesFromStatus(pool) : null
  }

  // -------------------------------------------------------------------------
  // The guard specs for pool export and destroy (story cr.32, WAVE3-DESIGN
  // §3, ruling (j)). The route and the job run the SAME gate list against
  // facts each door reads for itself: exists, system pool, PVE ownership,
  // held by an iSCSI LUN. The cr.24 references stay advisories.
  // -------------------------------------------------------------------------

  /** The per-run reads the pool gates share (one per guard run, never across doors). */
  const poolReads = {
    list: (reads: GuardReads) => reads.once('zpool-list', () => executor.exec(ZPOOL, ['list', '-j'])),
    footprint: (reads: GuardReads) => reads.once('pve-footprint', () => pveFootprint()),
    claims: (reads: GuardReads) => reads.once('iscsi-claims', async () => createIscsiClaimCache(executor, iscsiPaths)),
    leaves: (reads: GuardReads, pool: string) => reads.once(`pool-leaves:${pool}`, () => readPoolLeaves(pool)),
  }

  /** The object a pool verb acts on: a pool `zpool list` names now. */
  interface PoolObject { name: string }

  /**
   * The SYSTEM-POOL gate (stories pvepool.1 + cr.23): the pool holds this
   * node's boot filesystem or one of its filesystems sits at a system path —
   * a hard 409, no confirm bypass, decided on facts (boot properties, the
   * live mount table), never on the pool's name.
   */
  const poolSystemGate: Gate<PoolObject> = async (pool, reads) => {
    const pve = await poolReads.footprint(reads)
    if (!pve.isSystemPool(pool.name))
      return null
    const refusal = systemPoolRefusalFrom(pve, pool.name)
    return { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message }
  }

  /**
   * The PVE-OWNERSHIP gate (cr.32; EPICS §2 "PVE territory is read-only and
   * hands-off", DESIGN pvepool.1 "pool-level actions on a PVE pool stay
   * hands-off"): a hard 409 PVE_MANAGED, no confirm bypass, when PVE owns the
   * pool root OR any storage PVE keeps on the pool — exporting or destroying
   * the pool takes a nested storage root (`tank/vmdata`) and every guest disk
   * under it just the same. Both questions go to the ONE ownership answer
   * (`ownershipOf`, the shared `pveOwnership` predicate); the storage paths
   * are the candidates the recursive-verb guard already takes. The panel
   * greys Export/Destroy on the same pools (any `pveStorages`).
   */
  const poolPveGate: Gate<PoolObject> = async (pool, reads) => {
    const pve = await poolReads.footprint(reads)
    const storagePaths = (pve.storagesByPool.get(pool.name) ?? [])
      .map(ref => pveStoragePath(ref, pool.name))
      .filter((path): path is string => path !== undefined)
    const owned = pve.ownershipOf(pool.name) ?? pve.ownedDescendant(storagePaths, pool.name)?.ownership ?? null
    if (!owned)
      return null
    return {
      status: 409,
      code: 'PVE_MANAGED',
      reason: 'pve-managed',
      message: `Pool '${pool.name}' is PVE territory: ${owned.reason}. Exporting or destroying a pool PVE uses is left to PVE — `
        + `remove the storage in PVE (Datacenter → Storage) first if the pool is meant to go. This refusal has no confirm bypass.`,
    }
  }

  /**
   * The HELD-BY-LUN gate (story iscsi.6): a LUN serving anything on the pool
   * makes export and destroy unsafe NOW — a hard 409, no confirm bypass.
   * ZFS does not reliably refuse `zpool destroy` over a claimed zvol, and its
   * `busy` for an export names nothing `fuser` can find (GT-40/41). Fail-open:
   * no LIO ⇒ nothing held; an unreadable LIO tree is disclosed as an advisory.
   */
  function poolLunGate(action: 'Exporting' | 'Destroying'): Gate<PoolObject> {
    return async (pool, reads) => {
      const held = await heldByLun(await poolReads.claims(reads), { pool: pool.name })
      if (!held)
        return null
      const refusal = heldByLunRefusal(`pool '${pool.name}'`, action, held)
      return { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message }
    }
  }

  /**
   * What still references the pool (story cr.24): one advisory per reference
   * and per unreadable source, plus the LIO-unreadable disclosure (D3: a
   * broken claims read fail-opens to "nothing held", which a node genuinely
   * serving a LUN would look exactly like). Warn, never refuse; the job
   * reports any the confirm did not list.
   */
  async function poolAdvisories(pool: PoolObject, reads: GuardReads): Promise<Advisory[]> {
    const read = await poolReferences(pool.name)
    const advisories: Advisory[] = [
      ...read.refs.map(ref => ({ key: `ref:${poolReferenceKey(ref)}`, warning: poolReferenceWarning(ref) })),
      ...read.unreadableSources.map(src => ({ key: `unreadable:${src.kind}`, warning: poolUnreadableWarning(src, pool.name) })),
    ]
    if (await (await poolReads.claims(reads)).readFailed())
      advisories.push({ key: LIO_UNREADABLE_KEY, warning: LIO_UNREADABLE_WARNING })
    return advisories
  }

  /**
   * The guard spec of a pool-level verb. `cleanup` (destroy only) binds the
   * leaves the cleanup would wipe as the confirm's scope: a leaf added between
   * the challenge and the job changes what the operator agreed to wipe.
   */
  function poolGuardSpec(poolName: string, verb: 'export' | 'destroy', cleanup = false): GuardSpec<PoolObject> {
    const action = verb === 'export' ? 'Exporting' : 'Destroying'
    const noun = verb === 'export' ? 'an export' : 'a destroy'
    return {
      operation: verb === 'export' ? 'zpool.export' : 'zpool.destroy',
      object: {
        what: `Pool '${poolName}'`,
        read: async (reads) => {
          const list = await poolReads.list(reads)
          const pools = list.exitCode === 0 ? parseZpoolList(list.stdout) : []
          return pools.some(p => p.name === poolName) ? { name: poolName } : null
        },
        // Story ident.1: the pool's guid — an export/import swap under the
        // same name is a different pool.
        id: pool => readPoolGuid(executor, pool.name),
        ...(cleanup
          ? {
              scope: async (pool: PoolObject, reads: GuardReads) => {
                const leaves = await poolReads.leaves(reads, pool.name)
                return leaves ? { leaves: leaves.map(l => l.leafId).sort().join(', ') } : null
              },
            }
          : {}),
        scopeLabels: { leaves: 'the disks to wipe' },
        unbound: part => part === 'scope'
          ? `Could not read the member disks of pool '${poolName}' — refusing a destroy with cleanup that cannot be bound to them`
          : `Could not read the guid of pool '${poolName}' — refusing ${noun} that cannot be bound to it`,
      },
      gates: [poolSystemGate, poolPveGate, poolLunGate(action)],
      advisories: poolAdvisories,
    }
  }

  /**
   * ident.1: give every leaf that names no whole disk (a by-partuuid, by-path
   * or by-vdev path) its kernel device and whole disk from `lsblk`, read
   * while the pool still exists. Unresolvable leaves keep no whole disk and
   * are never zapped.
   */
  async function resolveLeafDisks(leaves: PoolLeaf[]): Promise<PoolLeaf[]> {
    const out: PoolLeaf[] = []
    for (const leaf of leaves) {
      if (leaf.wholeDiskId) {
        out.push(leaf)
        continue
      }
      const r = await executor.exec(LSBLK, ['-J', '-o', 'NAME,PKNAME,TYPE', leaf.leafPath])
      const dev = r.exitCode === 0 ? parseLsblkLeaf(r.stdout) : null
      out.push(dev
        ? { ...leaf, leafKernel: dev.kernel, wholeDiskId: dev.wholeKernel, wholeDiskPath: `/dev/${dev.wholeKernel}` }
        : leaf)
    }
    return out
  }

  server.get('/pools', async (_request, _reply) => {
    const [listResult, statusResult, byIdResult, lsblkDiscardResult, upgradeResult, pve, poolMounts] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
      // by-id → kernel map, to canonicalize pool leaves for the discard probe.
      executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/']),
      // Per-device discard capability (Epic 4.12 Trim gating). Fail-open.
      executor.exec('/usr/bin/lsblk', LSBLK_DISCARD_ARGS),
      // Pools with supported-but-disabled features (Epic 4.12 Upgrade gating).
      // `zpool upgrade` (no args) has no -j; text-parsed. Fail-open.
      executor.exec('/usr/sbin/zpool', ['upgrade']),
      // Read-only PVE storage detection (Epic 3.25). Fail-open: off-PVE hosts
      // and parse errors yield an empty map, so this never breaks GET /pools.
      // The footprint service reads storage.cfg WITH the ZFS mountpoint map
      // (dir storages resolve) and the boot facts (system pools).
      pveFootprint(),
      // The pool ROOT dataset's mountpoint + mounted flag (story 3.27 — the
      // grid's Mount column). Fail-open: an old/absent zfs leaves the field off.
      readPoolMountpoints(executor),
    ])

    // If no pools exist, zpool list exits non-zero with no stdout
    if (listResult.exitCode !== 0 && !listResult.stdout.trim()) {
      return { data: [] }
    }

    const listData = parseZpoolList(listResult.stdout)
    const statusData = statusResult.exitCode === 0
      ? parseZpoolStatus(statusResult.stdout)
      : []

    // Build a lookup from status data
    const statusByName = new Map(statusData.map(s => [s.name, s]))

    // Trim capability (Epic 4.12): resolve each pool's leaves to their whole-disk
    // kernel name and ask lsblk whether that device advertises discard. All
    // fail-open — a failed probe just leaves trimSupported false.
    const byIdToKernel = byIdResult.exitCode === 0
      ? parseByIdToKernel(byIdResult.stdout)
      : new Map<string, string>()
    const capableKernels = lsblkDiscardResult.exitCode === 0
      ? parseDiscardCapableKernels(lsblkDiscardResult.stdout)
      : new Set<string>()

    // Upgrade availability (Epic 4.12): pools with disabled features. `zpool
    // upgrade` exits 0 whether or not any pool needs upgrading; a non-zero exit
    // (probe failure) → empty set → all upgradeAvailable false.
    const upgradablePools = upgradeResult.exitCode === 0
      ? parseZpoolUpgrade(upgradeResult.stdout)
      : new Set<string>()

    // Collect a pool's leaf devices (id + path) from its parsed topology — the
    // SAME all-classes walk the destroy cleanup uses, so a pool whose only
    // discard-capable device sits in a log/special/dedup vdev is still read as
    // trim-capable (vdevs.1 consumer audit).
    const leavesOf = (status: (typeof statusData)[number] | undefined): LeafRef[] =>
      status ? allVdevLeaves(status) : []

    // Merge list (sizes) with status (state, scan, health) into PoolSummary
    const pools: PoolSummary[] = listData.map((pool) => {
      const status = statusByName.get(pool.name)
      const scanning = status?.scan?.state === 'SCANNING'
      const mount = poolMounts.get(pool.name)
      // Pool-root PVE ownership (pvepool.1 review fix 3): the SAME per-request
      // footprint as pveStorages asks about the pool's ROOT dataset, so a
      // system pool, a bare-path storage root, a dir storage on the root, and
      // the config-unreadable state are all visible in the grid. An ANAS pool
      // root is outside the footprint and carries no `pve` at all.
      const pveOwned = poolStamp(pve, pool.name)
      return {
        ...pool,
        state: status?.state ?? pool.state,
        scanRunning: scanning,
        // scanFunction is meaningful only while a scan is actually running — the
        // UI keys "Stop Scrub" (SCRUB only, never a RESILVER) off it.
        ...(scanning && status?.scan && { scanFunction: status.scan.function }),
        trimSupported: poolTrimSupported(leavesOf(status), byIdToKernel, capableKernels),
        upgradeAvailable: upgradablePools.has(pool.name),
        ...(status?.health && { health: status.health }),
        // Pool root mountpoint (story 3.27) — the Mount column. Absent ⇒ omitted.
        ...(mount && { mountpoint: mount.mountpoint, mounted: mount.mounted }),
        pveStorages: pve.storagesByPool.get(pool.name) ?? [],
        ...(pveOwned && { pve: pveOwned }),
      }
    })

    // Story iscsi.6: which pools a LUN is holding, so the grid can grey Destroy
    // and Export with the reason in the tooltip rather than letting the operator
    // discover it from a 409. ONE claims read for the whole grid — never one per
    // row — and additive: a pool nothing holds carries no field at all.
    await annotatePoolsHeldByLun(pools)

    return { data: pools }
  })

  server.get<{ Params: { name: string } }>('/pools/:name', async (request, reply) => {
    const poolName = request.params.name

    const [statusResult, listResult, getResult, pve, poolMounts] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['get', 'all', '-j']),
      // Read-only PVE storage detection (Epic 3.25) — fail-open (see GET /pools).
      // The footprint service always passes the ZFS mountpoint map, so a `dir`
      // storage backed by a dataset resolves here too (pvepool.1).
      pveFootprint(),
      // Pool root mountpoint + mounted flag (story 3.27) — fail-open.
      readPoolMountpoints(executor),
    ])

    // Parse status for this specific pool
    const status = statusResult.exitCode === 0
      ? parseZpoolStatusPool(statusResult.stdout, poolName)
      : null

    if (!status) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // Parse list data and find this pool
    const listData = listResult.exitCode === 0
      ? parseZpoolList(listResult.stdout)
      : []
    const listPool = listData.find(p => p.name === poolName)

    // Parse properties
    const properties = getResult.exitCode === 0
      ? parseZpoolGet(getResult.stdout, poolName)
      : null

    if (!listPool || !properties) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // Pool-root PVE ownership (pvepool.1 review fix 3) — the same per-request
    // footprint asks about the pool's ROOT dataset, so the detail view carries
    // the same verdict the list does. Absent for an ANAS pool.
    const pveOwned = poolStamp(pve, poolName)

    const detail: PoolDetail = {
      name: poolName,
      state: status.state,
      guid: status.guid,
      size: listPool.size,
      allocated: listPool.allocated,
      free: listPool.free,
      fragmentation: listPool.fragmentation,
      capacity: listPool.capacity,
      dedupRatio: listPool.dedupRatio,
      ...(status.health && { health: status.health }),
      errorCount: status.errorCount,
      ...(status.errorDetail && { errorDetail: status.errorDetail }),
      vdevGroups: status.vdevGroups,
      scan: status.scan,
      properties,
      // Pool root mountpoint (story 3.27) — prefills the Change mount prompt.
      ...(poolMounts.get(poolName) && {
        mountpoint: poolMounts.get(poolName)!.mountpoint,
        mounted: poolMounts.get(poolName)!.mounted,
      }),
      pveStorages: pve.storagesByPool.get(poolName) ?? [],
      ...(pveOwned && { pve: pveOwned }),
    }

    return { data: detail }
  })

  server.post<{ Params: { name: string } }>('/pools/:name/scrub', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = ScrubRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid scrub request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { action } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const args = action === 'stop'
      ? ['scrub', '-s', '--', poolName]
      : ['scrub', '--', poolName]

    const job = jobQueue.submit(
      'zpool.scrub',
      { ...identity, params: { pool: poolName, action } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool scrub exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Trim a pool's SSDs (Epic 4.12). Trim is a safe online operation like scrub —
  // no confirmation gate. `start` issues a trim; `cancel` (-c) stops one.
  server.post<{ Params: { name: string } }>('/pools/:name/trim', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = TrimPoolRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid trim request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { action } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const args = action === 'cancel'
      ? ['trim', '-c', '--', poolName]
      : ['trim', '--', poolName]

    const job = jobQueue.submit(
      'zpool.trim',
      { ...identity, params: { pool: poolName, action } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool trim exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Upgrade a pool's feature flags (Epic 4.12) — one-way. Enabling feature flags
  // is IRREVERSIBLE: the pool may no longer import on an older ZFS or another OS,
  // so this is confirmation-gated like destroy.
  server.post<{ Params: { name: string } }>('/pools/:name/upgrade', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.upgrade',
      params: { pool: poolName },
      message: `Upgrading pool '${poolName}' enables new ZFS feature flags`,
      warnings: [
        'Enabling feature flags is one-way — the pool may no longer be importable on older ZFS versions or other systems.',
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'zpool.upgrade',
      { ...identity, params: { pool: poolName } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', ['upgrade', '--', poolName])
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool upgrade exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Whitelist of user-settable pool properties and their allowed values
  // (Principle 5 — structured operations, not command passthrough). Booleans
  // are expressed to zpool as 'on'/'off'. ashift is creation-only and is
  // deliberately absent so a request to change it is rejected as invalid.
  const SETTABLE_POOL_PROPS: Record<string, readonly string[]> = {
    autoexpand: ['on', 'off'],
    autoreplace: ['on', 'off'],
    autotrim: ['on', 'off'],
    failmode: ['wait', 'continue', 'panic'],
  }

  server.put<{ Params: { name: string } }>('/pools/:name', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = UpdatePoolPropertiesRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid property update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { properties } = bodyParsed.data

    // Reject any property that is not settable (e.g. ashift) or any
    // out-of-range value before we touch the system.
    for (const [prop, value] of Object.entries(properties)) {
      const allowed = SETTABLE_POOL_PROPS[prop]
      if (!allowed) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Property '${prop}' is not settable` } }
      }
      if (!allowed.includes(value)) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid value '${value}' for property '${prop}'` } }
      }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const changes = Object.entries(properties)

    const job = jobQueue.submit(
      'zpool.set',
      { ...identity, params: { pool: poolName, properties } },
      async (updateProgress) => {
        for (const [prop, value] of changes) {
          updateProgress(`Setting ${prop}=${value} on ${poolName}`)
          // cr.12: deliberately NO `--` here — `zpool set` rejects it outright
          // (probed: "invalid option '-'"). Injection is bounded by the
          // SETTABLE_POOL_PROPS whitelist + PoolName param validation.
          const result = await executor.exec('/usr/sbin/zpool', ['set', `${prop}=${value}`, poolName])
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || `zpool set ${prop}=${value} exited with code ${result.exitCode}`)
          }
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Change a pool's mountpoint (story 3.27 — retconned from AHR's mountpoint
  // flow, parallel construction). The ZFS mountpoint is a NATIVE dataset
  // property, so the mechanics differ honestly from AHR: the job is `zfs set
  // mountpoint=<path> <pool>` — ZFS unmounts and remounts itself and NO fstab is
  // written anywhere. Child datasets that inherit their mountpoint move with the
  // pool root; a child with its own explicit mountpoint stays put. Confirm-gated
  // (409 → 202). ANAS-managed pools only: a PVE-managed pool (story 3.25) is
  // hands-off and this route 400s for it.
  server.put<{ Params: { name: string } }>('/pools/:name/mountpoint', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = PoolMountpointRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mountpoint request: ${bodyParsed.error.issues[0]?.message}` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // SYSTEM-POOL GUARD (stories pvepool.1 + cr.23): the pool holds this
    // node's boot filesystem or its storage sits at a system path — a hard
    // 409 with NO confirm bypass, before anything else is negotiated.
    const pve = await pveFootprint()
    if (pve.isSystemPool(poolName)) {
      const refusal = systemPoolRefusalFrom(pve, poolName)
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } }
    }

    // SCOPE GUARD (story 3.25): PVE owns this pool's storage — ANAS keeps its
    // hands off the mountpoint. A hard 400, never a confirm (mirrors the grid's
    // disabled Change mount action for PVE-managed pools).
    const pveStorages = pve.storagesByPool.get(poolName) ?? []
    if (pveStorages.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Pool '${poolName}' is managed by PVE (${pveStorages.map(s => s.storage).join(', ')}) — ANAS keeps its mountpoint hands-off (story 3.25)` } }
    }

    const mp = bodyParsed.data.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'
    if (mp === '/mnt/pve' || mp.startsWith('/mnt/pve/') || mp === '/') {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `mountpoint '${bodyParsed.data.mountpoint}' is reserved — /mnt/pve belongs to PVE (story 3.25) and / is not a pool mountpoint` } }
    }

    const poolMounts = await readPoolMountpoints(executor)
    const current = poolMounts.get(poolName)
    const currentMp = current?.mountpoint ?? null
    if (currentMp === mp) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `'${mp}' is already this pool's mountpoint` } }
    }

    // Collision checks (identical to the AHR precedent): live mounts, fstab
    // claims, and any OTHER pool's mountpoint.
    const findmntRes = await executor.exec(FINDMNT, FINDMNT_ARGS)
    const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
    if (mounts.some(m => m.target === mp)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `'${mp}' is already a mountpoint — pick an unused path` } }
    }
    if (hasMount(await readConfig(fstabPath), mp)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `'${mp}' is already claimed in fstab — pick an unused path` } }
    }
    for (const [name, m] of poolMounts) {
      if (name !== poolName && m.mountpoint === mp) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already pool '${name}' mountpoint — pick an unused path` } }
      }
    }

    // Child datasets that inherit the pool root move with it; those with their
    // OWN explicit mountpoint stay put. The confirm text states both honestly.
    const explicitChildren = await readExplicitChildMountpoints(executor, poolName)
    const fromLabel = currentMp ?? `pool '${poolName}'`
    const warnings = [
      `Child datasets that inherit their mountpoint move with the pool root — their paths change from under '${fromLabel}' to under '${mp}'.`,
      current?.mounted === false
        ? `Pool '${poolName}' is not currently mounted; ZFS will set the property and mount it at '${mp}'.`
        : `ZFS briefly unmounts the pool and its inheriting datasets during the change — open files there will block it (retry after closing them).`,
    ]
    if (explicitChildren.length > 0) {
      const list = explicitChildren.slice(0, 5).map(c => `${c.name} → ${c.value}`).join(', ')
      const more = explicitChildren.length > 5 ? `, and ${explicitChildren.length - 5} more` : ''
      warnings.push(`${explicitChildren.length} child dataset(s) set their own explicit mountpoint (${list}${more}) — these stay where they are.`)
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.mountpoint',
      params: { pool: poolName, mountpoint: mp },
      message: `Changing pool '${poolName}' mountpoint${currentMp ? ` from '${currentMp}'` : ''} to '${mp}' remounts it and its inheriting datasets`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'zpool.mountpoint',
      { ...identity, params: { pool: poolName, mountpoint: mp } },
      async () => {
        // ZFS-native: `zfs set mountpoint` unmounts and remounts the dataset (and
        // every inheriting descendant) itself — no fstab, no manual mount/umount.
        const result = await executor.exec(ZFS, ['set', '--', `mountpoint=${mp}`, poolName])
        if (result.exitCode !== 0) {
          // `zfs set mountpoint` unmounts to move — a busy pool blocks it; name
          // the holders (3.29). Path comes from the ZFS error (`cannot unmount`).
          const base = result.stderr.trim() || `zfs set mountpoint exited with code ${result.exitCode}`
          throw new Error(await enrichBusyError(executor, base, undefined, configfsOptionsFrom(iscsiPaths)))
        }
        return { pool: poolName, mountpoint: mp }
      },
    )

    reply.code(202)
    return { job }
  })

  server.post('/pools', async (request, reply) => {
    const bodyParsed = CreatePoolRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    // SAFETY (story 3.22): a special or dedup vdev holds pool-wide metadata — if
    // it dies, the whole pool is lost. Reject a non-redundant (stripe) one at the
    // boundary; we never pass -f to force it. Defense-in-depth behind the
    // composer's own gating.
    for (const cls of ['special', 'dedup'] as const) {
      const vdevs = cls === 'special' ? req.specialVdevs : req.dedupVdevs
      for (const vdev of vdevs ?? []) {
        if (!isRedundantSpec(vdev)) {
          reply.code(400)
          return { error: { code: 'VALIDATION_ERROR', message: `A ${cls} vdev must be redundant (mirror or raidz) — a single-disk or striped ${cls} vdev would risk the entire pool` } }
        }
      }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 409 if a pool of that name already exists — the system is the source of truth.
    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const existing = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (existing.some(p => p.name === req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Pool '${req.name}' already exists` } }
    }

    // Mountpoint override (story 3.27): identical checks to the AHR create path —
    // never in PVE's namespace, never a path already mounted, claimed in fstab,
    // or serving another pool. `-m` is passed verbatim to `zpool create`; ZFS
    // owns the mount. (AbsolutePath already refused relative paths and
    // `legacy`/`none` at parse — this is the mounted-pool flow only.)
    if (req.mountpoint !== undefined) {
      const mp = req.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'
      if (mp === '/mnt/pve' || mp.startsWith('/mnt/pve/') || mp === '/') {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `mountpoint '${req.mountpoint}' is reserved — /mnt/pve belongs to PVE (story 3.25) and / is not a pool mountpoint` } }
      }
      const findmntRes = await executor.exec(FINDMNT, FINDMNT_ARGS)
      const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
      if (mounts.some(m => m.target === mp)) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already a mountpoint — pick an unused path` } }
      }
      if (hasMount(await readConfig(fstabPath), mp)) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already claimed in fstab — pick an unused path` } }
      }
      const poolMounts = await readPoolMountpoints(executor)
      for (const [name, m] of poolMounts) {
        if (m.mountpoint === mp) {
          reply.code(409)
          return { error: { code: 'CONFLICT', message: `'${mp}' is already pool '${name}' mountpoint — pick an unused path` } }
        }
      }
      req.mountpoint = mp
    }

    // SAFETY (the AHR composer's twin, D4 + cr.12): every requested disk must
    // resolve in the inventory AND be composable. The GT-43 loop-back LUN is
    // blank SCSI as far as the kernel and zpool can see — only the inventory's
    // hands-off tag knows — and a non-available disk would be clobbered by the
    // create. An id the inventory does not know is refused too (H4); an
    // inventory that cannot be read fails CLOSED. Both refusals land BEFORE
    // the job, naming the disk and the reason.
    const check = await composableDiskProblems(createRequestDiskIds(req))
    if ('unreadable' in check) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'unreadable', message: `${check.unreadable}; refusing to compose disks it cannot identify` } }
    }
    const diskProblems = check.problems
    if (diskProblems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${diskProblems.join('; ')}` } }
    }

    // cr.12 (H4 step 4): `-f` on create is a label-overwrite — confirm-gated
    // like upgrade. The code binds to operation + pool name; a request without
    // force never reaches the gate and behaves exactly as before.
    if (req.force) {
      if (!confirmGate(confirmStore, request, reply, {
        operation: 'zpool.create',
        params: { pool: req.name },
        message: `Force-creating pool '${req.name}' is destructive`,
        warnings: [
          'Forcing the create overwrites any existing filesystem or pool labels on the selected disks.',
        ],
      })) {
        return reply
      }
    }

    const args = buildCreateArgs(req)

    const job = jobQueue.submit(
      'zpool.create',
      { ...identity, params: { pool: req.name, vdevs: req.dataVdevs.length } },
      async () => {
        // cr.34 (WAVE3-DESIGN §6.3): `zpool create` discards every device
        // first (no -K) — minutes on large SSDs; 30 min, not the job's 300 s.
        const result = await executor.exec('/usr/sbin/zpool', args, { timeoutMs: 1_800_000 })
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool create exited with code ${result.exitCode}`)
        }
        // PVE parity (PVE/API2/Disks/ZFS.pm, their fix for Proxmox bug #2554) and
        // issue #22: zpool.cache alone is not a reliable boot import, so enable
        // the pool's own zfs-import@<pool>.service as a second, independent path.
        // Best-effort — the pool exists, so a systemctl hiccup only warns.
        const warning = await syncZfsImportUnit(executor, req.name, 'enable')
        return warning ? { warnings: [warning] } : null
      },
    )

    reply.code(202)
    return { job }
  })

  // --- Story 3.7: scan for importable pools (read, synchronous) -----------
  // GET /pools/import lists pools available to import (`zpool import` no args).
  // A read, not a mutation, so it returns 200 { data } synchronously — no job.
  server.get('/pools/import', async (_request, _reply) => {
    const scanResult = await executor.exec('/usr/sbin/zpool', ['import'])
    // `zpool import` with no importable pools exits non-zero with no stdout.
    if (scanResult.exitCode !== 0 && !scanResult.stdout.trim()) {
      return { data: [] }
    }
    return { data: parseImportScan(scanResult.stdout) }
  })

  // --- Story 3.7: import a pool by name or guid ---------------------------
  server.post('/pools/import', async (request, reply) => {
    const bodyParsed = ImportPoolRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid import request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const target = req.name ?? req.guid!

    // cr.12 (H4 step 4): `-f` on import can mount a pool that is still ACTIVE
    // on another host — confirm-gated like upgrade. The code binds to
    // operation + target (name or guid); a request without force never
    // reaches the gate and behaves exactly as before.
    if (req.force) {
      if (!confirmGate(confirmStore, request, reply, {
        operation: 'zpool.import',
        params: { target },
        message: `Force-importing '${target}' can corrupt a pool that is still active elsewhere`,
        warnings: [
          'Forcing the import may import a pool that is active on another host, which can corrupt it.',
        ],
      })) {
        return reply
      }
    }

    const args = ['import']
    if (req.force)
      args.push('-f')
    if (req.altroot)
      args.push('-R', req.altroot)
    args.push('--', target)

    const job = jobQueue.submit(
      'zpool.import',
      { ...identity, params: { target, force: req.force ?? false } },
      async () => {
        // PVE parity (PVE/API2/Disks/ZFS.pm, their fix for Proxmox bug #2554) and
        // issue #22: an imported pool needs its zfs-import@<pool>.service enabled
        // too — zpool.cache alone is not a reliable boot import. The request may
        // target a name OR a guid, and a guid import never tells us the name, so
        // the newly imported pool(s) are the DIFF of the pool list across the
        // import (falling back to the requested name if the diff comes up empty).
        const before = await listPoolNames()

        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool import exited with code ${result.exitCode}`)
        }

        const after = await listPoolNames()
        const imported = after.filter(name => !before.includes(name))
        const pools = imported.length > 0 ? imported : (req.name ? [req.name] : [])

        // Best-effort — the pool is imported, so a systemctl hiccup only warns.
        const warnings: string[] = []
        for (const pool of pools) {
          const warning = await syncZfsImportUnit(executor, pool, 'enable')
          if (warning)
            warnings.push(warning)
        }
        return warnings.length > 0 ? { warnings } : null
      },
    )

    reply.code(202)
    return { job }
  })

  /** Names of the currently imported pools ([] when the listing fails). */
  async function listPoolNames(): Promise<string[]> {
    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    return pools.map(p => p.name)
  }

  async function poolExists(poolName: string): Promise<boolean> {
    return (await listPoolNames()).includes(poolName)
  }

  // Add a vdev to an existing pool (stories 3.11, 3.21, 3.22). Expands the pool
  // by appending a new top-level vdev in the requested role/class. `stripe` is
  // our synthetic type — bare disks with no redundancy keyword; every other type
  // prepends its ZFS keyword. cache/spare carry bare `disks`; data/log/special/
  // dedup carry a redundant `vdev` (data may still be a bare stripe).
  //   data    → zpool add <pool> [<type>] <disks…>
  //   log     → zpool add <pool> log [<type>] <disks…>
  //   special → zpool add <pool> special <type> <disks…>   (redundant only)
  //   dedup   → zpool add <pool> dedup <type> <disks…>      (redundant only)
  //   cache   → zpool add <pool> cache <disks…>
  //   spare   → zpool add <pool> spare <disks…>
  server.post<{ Params: { name: string } }>('/pools/:name/vdevs', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = AddVdevRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid add-vdev request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { role, vdev, disks } = bodyParsed.data

    // SAFETY (story 3.22): a special/dedup vdev whose loss loses the whole pool
    // must be redundant. Reject a stripe (or single-disk) one at the boundary;
    // never pass -f. Mirrors the create-path check.
    if ((role === 'special' || role === 'dedup') && vdev && !isRedundantSpec(vdev)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `A ${role} vdev must be redundant (mirror or raidz) — a single-disk or striped ${role} vdev would risk the entire pool` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // The same topology gate the remove route asks — adding a vdev reshapes a
    // pool exactly as removing one does, and a PVE-managed pool is hands-off
    // either way.
    const gate = await vdevTopologyGate(poolName, reply)
    if (gate)
      return gate

    // SAFETY (D4 — the create path's inventory pre-flight, shared, cr.12): a
    // hands-off (loop-back LUN) or non-available disk must not be composed in,
    // whatever the role, and an id the inventory does not know is refused too;
    // an unreadable inventory fails CLOSED. Refused before the job.
    const candidateIds = role === 'cache' || role === 'spare' ? (disks ?? []) : vdev!.disks
    const check = await composableDiskProblems(candidateIds)
    if ('unreadable' in check) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'unreadable', message: `${check.unreadable}; refusing to compose disks it cannot identify` } }
    }
    const diskProblems = check.problems
    if (diskProblems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${diskProblems.join('; ')}` } }
    }

    // Build the argv by role. The schema guarantees cache/spare carry `disks`
    // and data/log/special/dedup carry `vdev`.
    let args: string[]
    let jobDisks: string[]
    let jobType: string
    if (role === 'cache' || role === 'spare') {
      const diskIds = disks ?? []
      args = ['add', '--', poolName, role, ...diskIds.map(byIdPath)]
      jobDisks = diskIds
      jobType = role
    }
    else {
      const v = vdev!
      const head = ['add', '--', poolName]
      // log/special/dedup prepend their class keyword; data has none.
      if (role === 'log' || role === 'special' || role === 'dedup')
        head.push(role)
      // vdevSpecArgs applies the shared stripe→bare / else→keyword rule + disks.
      args = [...head, ...vdevSpecArgs(v)]
      jobDisks = v.disks
      jobType = v.type
    }

    const job = jobQueue.submit(
      'zpool.add',
      { ...identity, params: { pool: poolName, role, type: jobType, disks: jobDisks } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool add exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Remove a cache, log or spare vdev (story vdevs.2) — the add path's twin.
  // ZFS drops these three classes instantly: the L2ARC is a throw-away copy,
  // the ZIL flushes and logging reverts into the pool, and an unused spare
  // holds nothing. So this is a PLAIN job — no confirm code, nothing is
  // destroyed. data/special/dedup removal is device evacuation, a different
  // operation ANAS does not offer, and it is refused up front with one
  // sentence.
  //
  // The request names ONE vdev the way the pool view shows it — a leaf (by-id
  // name, by-id partition basename, or short kernel name) or a top-level vdev
  // name (`mirror-1`, a mirrored log). The daemon resolves that against the
  // pool's own `zpool status` and hands `zpool remove` the token ZFS itself
  // reports, so the argv never carries a name the user typed.
  server.post<{ Params: { name: string } }>('/pools/:name/vdevs/remove', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = RemoveVdevRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remove-vdev request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const requestedVdev = bodyParsed.data.vdev

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // The shared topology gate: system pool, then PVE ownership.
    const gate = await vdevTopologyGate(poolName, reply)
    if (gate)
      return gate

    const statusResult = await executor.exec(ZPOOL, ['status', '-jv'])
    const status = statusResult.exitCode === 0
      ? parseZpoolStatusPool(statusResult.stdout, poolName)
      : null
    if (!status) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const lookup = resolveVdev(status, requestedVdev)
    if (!lookup) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: unknownVdevMessage(poolName, requestedVdev) } }
    }
    // A name the pool carries but must not act on: it fits more than one leaf
    // (a split by-id device), or it is a spare ZFS has put to work.
    if (isVdevRefusal(lookup)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: lookup.message } }
    }
    const resolved = lookup
    if (!isRemovableVdevRole(resolved.role)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: NON_REMOVABLE_VDEV_MESSAGE } }
    }

    const { role, token } = resolved
    const job = jobQueue.submit(
      'zpool.remove',
      { ...identity, params: { pool: poolName, vdev: requestedVdev, role } },
      async () => {
        const result = await executor.exec(ZPOOL, ['remove', '--', poolName, token])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zpool remove exited with code ${result.exitCode}`)

        // `zpool remove` of a log returns while the ZIL is still flushing, so a
        // straight re-read can still show the vdev. Poll until the POOL ITSELF
        // says it is gone, or say plainly that it did not (Principle 11 — the
        // system answers, we do not assume the command's exit code did).
        //
        // The loop FAILS CLOSED: a `zpool status` that exits non-zero, or one
        // whose output no longer carries the pool, is not an answer — it is a
        // read we could not make, and reporting success on it would tell the
        // operator the vdev came out when nothing verified that. Only a pool
        // that answers and no longer carries the token completes the job.
        const deadline = Date.now() + vdevRemoveSettleMs
        for (;;) {
          const after = await executor.exec(ZPOOL, ['status', '-jv'])
          let failure: string
          if (after.exitCode !== 0) {
            failure = unreadablePoolMessage(poolName, after.stderr.trim() || `zpool status exited with code ${after.exitCode}`)
          }
          else {
            const parsed = parseZpoolStatusPool(after.stdout, poolName)
            if (parsed && !vdevStillPresent(parsed, resolved))
              return { pool: poolName, vdev: requestedVdev, role }
            failure = parsed
              ? stillPresentMessage(poolName, requestedVdev)
              : unreadablePoolMessage(poolName, 'zpool status no longer reports the pool')
          }
          if (Date.now() >= deadline)
            throw new Error(failure)
          await new Promise(resolve => setTimeout(resolve, VDEV_REMOVE_POLL_MS))
        }
      },
    )

    reply.code(202)
    return { job }
  })

  // Expansion eligibility (story 3.31, READ). For each top-level DATA vdev the
  // composer gets what a dropped disk would do (attach-leg vs raidz-expand),
  // whether it's allowed, the guiding refusal reason, and — for raidz — the
  // HONEST usable-gain estimate. Disk-independent (the gain of adding one disk
  // ≥ the column size depends only on the vdev, not which disk), so this needs
  // no candidate disk. Fail-soft reads throughout.
  server.get<{ Params: { name: string } }>('/pools/:name/expansion', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const [statusResult, getResult, version] = await Promise.all([
      executor.exec(ZPOOL, ['status', '-jv']),
      executor.exec(ZPOOL, ['get', 'all', '-j']),
      detectLocalZfsVersion(executor),
    ])

    const status = statusResult.exitCode === 0
      ? parseZpoolStatusPool(statusResult.stdout, poolName)
      : null
    if (!status) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const featureValue = getResult.exitCode === 0
      ? parseZpoolFeature(getResult.stdout, poolName, RAIDZ_EXPANSION_FEATURE)
      : null
    const capability = buildCapability(version, featureValue)
    const busy = statusResult.exitCode === 0
      ? parsePoolBusyState(statusResult.stdout, poolName)
      : { busy: false }
    const targets: ExpansionTarget[] = buildExpansionTargets(status, poolName, capability, busy)

    const report: PoolExpansionReport = { pool: poolName, capability, busy, targets }
    return { data: report }
  })

  // Attach/replace a leaf OR widen a raidz vdev (stories 3.12 + 3.31). The
  // request carries exactly one target — drop-location is intent:
  //   existingDiskId + replace=false → `zpool attach <pool> <leaf> <new>`  (mirror leg, +redundancy)
  //   existingDiskId + replace=true  → `zpool replace <pool> <old> <new>` (+ online -e realizes a larger disk)
  //   targetVdev                     → `zpool attach <pool> <raidz-vdev> <new>` (RAIDZ EXPANSION, +capacity)
  // Gates (3.31): raidz-expand needs OpenZFS ≥ 2.3.0 AND feature@raidz_expansion;
  // mirror-attach AND raidz-expand refuse while a resilver/reflow is in progress
  // (mirrors the AHR degraded-refusal altitude — a hard 409, no confirm bypass).
  server.post<{ Params: { name: string } }>('/pools/:name/attach', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = AttachDiskRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid attach request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { existingDiskId, targetVdev, newDiskId, replace } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // SAFETY (D4 — the create path's inventory pre-flight, shared, cr.12): the
    // NEW disk must resolve in the inventory AND be composable — a loop-back
    // LUN, a non-available disk or an id the inventory does not know must not
    // become a mirror leg, a replacement or a raidz-expansion column, and an
    // unreadable inventory fails CLOSED. The EXISTING leaf is deliberately not
    // checked: it is already a pool member, so the inventory (honestly)
    // reports it as anything but available, and that must never refuse a
    // legitimate attach or replace — it is identified from the pool's own
    // status instead, below.
    const check = await composableDiskProblems([newDiskId])
    if ('unreadable' in check) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'unreadable', message: `${check.unreadable}; refusing to ${replace ? 'replace' : 'attach to'} a device it cannot identify` } }
    }
    const diskProblems = check.problems
    if (diskProblems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${diskProblems.join('; ')}` } }
    }

    const newPath = byIdPath(newDiskId)

    // ---- RAIDZ EXPANSION path (targetVdev present) -------------------------
    if (targetVdev !== undefined) {
      if (!VDEV_NAME_RE.test(targetVdev)) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid vdev name '${targetVdev}'` } }
      }

      const [statusResult, getResult, version] = await Promise.all([
        executor.exec(ZPOOL, ['status', '-jv']),
        executor.exec(ZPOOL, ['get', 'all', '-j']),
        detectLocalZfsVersion(executor),
      ])
      const status = statusResult.exitCode === 0 ? parseZpoolStatusPool(statusResult.stdout, poolName) : null
      if (!status) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
      }

      // The target must be an existing raidz DATA vdev.
      const dataGroup = status.vdevGroups.find(g => g.role === 'data')
      const vdev = dataGroup?.vdevs.find(v => v.name === targetVdev)
      if (!vdev) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Vdev '${targetVdev}' not found in pool '${poolName}'` } }
      }
      if (raidzParity(vdev.type) === null) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Vdev '${targetVdev}' is a ${vdev.type}, not a raidz — raidz expansion needs a raidz vdev (attach a mirror leg via existingDiskId instead)` } }
      }

      // GATE 1 (version): raidz expansion landed in OpenZFS 2.3.0.
      const featureValue = getResult.exitCode === 0 ? parseZpoolFeature(getResult.stdout, poolName, RAIDZ_EXPANSION_FEATURE) : null
      const capability = buildCapability(version, featureValue)
      if (!capability.moduleSupported) {
        reply.code(409)
        return { error: { code: 'CONFLICT', reason: 'version', message: `RAIDZ expansion needs OpenZFS ≥ 2.3.0; this node runs ${capability.zfsVersion ?? 'an undetectable version'}. This refusal has no confirm bypass.` } }
      }
      // GATE 1b (flag): feature@raidz_expansion must be enabled/active.
      if (!capability.featureEnabled) {
        reply.code(409)
        return { error: { code: 'CONFLICT', reason: 'flag', message: `Pool '${poolName}' has feature@raidz_expansion ${capability.featureState}. Enable it first with: zpool upgrade ${poolName}` } }
      }
      // GATE 2 (busy): no new expansion while a resilver/reflow runs.
      const busy = parsePoolBusyState(statusResult.stdout, poolName)
      if (busy.busy) {
        reply.code(409)
        return { error: { code: 'CONFLICT', reason: 'busy', message: busyDetail(busy, poolName) } }
      }

      const job = jobQueue.submit(
        'zpool.raidz-expand',
        { ...identity, params: { pool: poolName, vdev: targetVdev, newDisk: newDiskId } },
        async () => {
          // SAME `zpool attach` verb aimed at the raidz VDEV NAME (not a leaf).
          const result = await executor.exec(ZPOOL, ['attach', '--', poolName, targetVdev, newPath])
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `zpool attach (raidz expand) exited with code ${result.exitCode}`)
          return { pool: poolName, vdev: targetVdev, expanded: newDiskId }
        },
      )
      reply.code(202)
      return { job }
    }

    // ---- LEAF path: mirror-attach or replace (story 3.12) ------------------
    //
    // ONE `zpool status` read answers both questions this path asks: whether
    // the pool is busy, and which device the existing leaf actually is.
    const leafStatusResult = await executor.exec(ZPOOL, ['status', '-jv'])

    // GATE 2 (busy) applies to a mirror-attach too — never start a second
    // resilver-inducing op mid-resilver/reflow. Replace is exempt (you may be
    // replacing the very disk that is degraded).
    if (!replace && leafStatusResult.exitCode === 0) {
      const busy = parsePoolBusyState(leafStatusResult.stdout, poolName)
      if (busy.busy) {
        reply.code(409)
        return { error: { code: 'CONFLICT', reason: 'busy', message: busyDetail(busy, poolName) } }
      }
    }

    // The request names the existing leaf the way the pool view shows it: a
    // by-id disk id, a by-id partition basename (`ata-SSD-part1`), a short
    // kernel name, or the full device path. Resolve it against the pool's own
    // status so `zpool replace`/`attach` is handed the device ZFS itself
    // reports (story vdevs.1 fix batch): on a split SSD — log on -part1, cache
    // on -part2, data on -part3 — every leaf carries the SAME stripped by-id
    // id, `/dev/disk/by-id/<disk>` is a device the pool does not have, and
    // guessing at one of the three would replace the wrong one. A name that
    // fits several leaves is refused with its candidates, exactly as the remove
    // route refuses it.
    //
    // A status we CANNOT read fails CLOSED (vdevs.2 hardening). It used to fall
    // back to `byIdPath(existingDiskId)` — a spelling the pool may not carry at
    // all, and on a partition-backed device a spelling that names a DIFFERENT
    // member than the one the operator picked. `zpool replace` aimed at a
    // substituted device destroys the data on it, and that is not a risk to run
    // on a read that did not happen. Both leaf verbs name an existing leaf —
    // the mirror-attach names the leaf it mirrors, the schema requires it — so
    // neither proceeds unidentified, and the attach's busy gate above is
    // likewise not skipped on an unread status. The refusal is a 409 with its
    // reason: nothing about the request is wrong, the node could not answer.
    const leafStatus = leafStatusResult.exitCode === 0
      ? parseZpoolStatusPool(leafStatusResult.stdout, poolName)
      : null
    if (!leafStatus) {
      const detail = leafStatusResult.exitCode === 0
        ? `zpool status no longer reports the pool`
        : leafStatusResult.stderr.trim() || `zpool status exited with code ${leafStatusResult.exitCode}`
      const verb = replace ? 'replace' : 'attach to'
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'unreadable', message: `pool ${poolName}'s status could not be read (${detail}); refusing to ${verb} a device it cannot identify` } }
    }
    const leaf = resolveLeafDevice(leafStatus, existingDiskId!)
    if (!leaf) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: unknownVdevMessage(poolName, existingDiskId!) } }
    }
    if (isVdevRefusal(leaf)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: leaf.message } }
    }
    const existingPath = leaf.path

    const args = replace
      ? ['replace', '--', poolName, existingPath, newPath]
      : ['attach', '--', poolName, existingPath, newPath]

    const job = jobQueue.submit(
      replace ? 'zpool.replace' : 'zpool.attach',
      { ...identity, params: { pool: poolName, existingDisk: existingDiskId, newDisk: newDiskId, replace } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          const verb = replace ? 'replace' : 'attach'
          throw new Error(result.stderr.trim() || `zpool ${verb} exited with code ${result.exitCode}`)
        }
        // Story 3.31a: after a replace, realize any grown capacity on the NEW
        // device even on autoexpand=off pools. `zpool online -e` expands the
        // device to its full size; a no-op when the replacement is not larger.
        // Guest philosophy: we only online -e the specific device we replaced —
        // we never flip the pool's autoexpand property. Best-effort: a failure
        // here does not fail the (already-succeeded) replace.
        if (replace)
          await executor.exec('/usr/sbin/zpool', ['online', '-e', '--', poolName, newPath])
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  server.post<{ Params: { name: string } }>('/pools/:name/export', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = ExportPoolRequest.safeParse(request.body ?? undefined)
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid export request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { force } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.32: the one guard spec both doors run — exists, the
    // system-pool hard 409 (pvepool.1 + cr.23: exporting it takes the running
    // node's root away), the held-by-LUN hard 409 (iscsi.6) — and the cr.24
    // references as advisories.
    const spec = poolGuardSpec(poolName, 'export')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Story cr.24: name what STILL references the pool so the operator
    // decides with the facts (warn, never refuse). The generic "it becomes
    // unavailable" line stays only when nothing specific was found; the
    // unreadable-source sentences say what could not be checked.
    const referenceWarnings = pre.advisories.filter(a => a.key !== LIO_UNREADABLE_KEY)
    const warnings = [
      ...(referenceWarnings.length === 0
        ? [`Exporting '${poolName}' makes the pool and all its datasets unavailable until it is re-imported.`]
        : []),
      ...pre.advisories.map(a => a.warning),
    ]

    // Story cr.32 (M3): the code signs the whole validated request — `force`
    // included — plus the pool's guid (ident.1). A resend with another
    // `force` is 409 CONFIRM_SCOPE_CHANGED; an export/import swap under the
    // same name is 409 IDENTITY_MISMATCH.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, force },
      address: ['pool'],
      presentationOnly: POOL_EXPORT_PRESENTATION_ONLY,
      message: `Exporting pool '${poolName}' has consequences`,
      warnings,
    })) {
      return reply
    }

    const args = force ? ['export', '-f', '--', poolName] : ['export', '--', poolName]

    const job = jobQueue.submit(
      'zpool.export',
      { ...identity, params: { pool: poolName, force, guid: pre.bound.id.guid } },
      // Ruling (j): the job re-reads the pool, compares the guid and re-runs
      // every gate above before `zpool export`; a refusal fails the job with
      // the gate's own code and sentence and nothing runs.
      guarded(spec, pre, async (_pool, ctx) => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          // ZFS's `pool or dataset is busy` names nothing `fuser` can find
          // (GT-41) — the LIO branch of the diagnosis does.
          const base = result.stderr.trim() || `zpool export exited with code ${result.exitCode}`
          throw new Error(await enrichBusyError(executor, base, undefined, configfsOptionsFrom(iscsiPaths)))
        }

        // pools.r1 (audit #22, review M6): create/import enable the pool's
        // zfs-import@<pool>.service and destroy disables it; export must disable
        // it too — an exported pool answers `zpool import <pool>` at boot with a
        // plain failure, so the enabled unit fails every boot until the pool
        // comes back (twelve such units found on one real node). Re-import
        // re-enables. The root/boot pool can never get here: the system-pool
        // gate refuses it at both doors. Best-effort — the pool is already
        // exported; a hiccup here is a warning, never a failed job.
        const unitWarning = await syncZfsImportUnit(executor, poolName, 'disable')

        // Story cr.24 (ruling (j)): what references the pool now that the
        // confirm did not list — the operator confirmed an export, so the
        // record says what was still pointing at it when it ran.
        const resultWarnings: string[] = []
        if (unitWarning)
          resultWarnings.push(unitWarning)
        resultWarnings.push(...ctx.newAdvisories)
        return resultWarnings.length > 0 ? { warnings: resultWarnings } : null
      }),
    )

    reply.code(202)
    return { job }
  })

  // Destroy a pool (story 3.14) — the dangerous one. Refused outright for a
  // system pool, a PVE pool or a pool a LUN serves (no override); otherwise
  // confirmation-gated.
  server.delete<{ Params: { name: string }, Querystring: Record<string, unknown> }>('/pools/:name', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    // Opt-in disk hygiene (PVE's "Clean Up Disks"): after destroy, wipe each
    // freed member so it comes back pristine and immediately reusable. The
    // flag is normalised (absent ≡ `false`) before the confirm signs it.
    const { cleanup } = DestroyPoolQuery.parse(request.query ?? {})

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.32: exists, system pool, PVE ownership, held by a LUN — the
    // same list the job re-runs — and, with cleanup, the leaves it would wipe
    // bound as the confirm's scope.
    const spec = poolGuardSpec(poolName, 'destroy', cleanup)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const warnings = [
      `Destroying '${poolName}' is irreversible — all data in the pool is permanently lost.`,
      `Every dataset, snapshot, and volume in '${poolName}' will be destroyed.`,
    ]
    if (cleanup) {
      warnings.push(`The pool's disks will be wiped clean (existing ZFS labels removed).`)
      // What is bound is what was shown (WAVE3-DESIGN §5.2 rule 2).
      warnings.push(`Disks to wipe: ${pre.bound.scope?.leaves || 'none'}.`)
    }
    // Story cr.24: what STILL references the pool, one warning per reference
    // and per unreadable source, then the LIO-unreadable disclosure (warn,
    // never refuse).
    warnings.push(...pre.advisories.map(a => a.warning))

    // Story cr.32 (M3): `cleanup` is bound. The confirm window re-challenges
    // in place when the box is ticked (cr.44), so the code always matches the
    // request it confirms; a resend whose code was minted with the other value
    // is 409 CONFIRM_SCOPE_CHANGED naming `cleanup`, with a fresh code.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, cleanup },
      address: ['pool'],
      presentationOnly: POOL_DESTROY_PRESENTATION_ONLY,
      message: `Destroying pool '${poolName}' permanently erases all its data`,
      warnings,
    })) {
      return reply
    }

    const guid = pre.bound.id.guid
    const job = jobQueue.submit(
      'zpool.destroy',
      { ...identity, params: { pool: poolName, cleanup, guid } },
      // Ruling (j): guid, the bound leaf set and every gate are re-checked
      // against facts read now; a refusal fails the job before anything runs.
      guarded(spec, pre, async (_pool, ctx) => {
        const { updateProgress } = ctx
        const newRefWarnings = ctx.newAdvisories

        // The member leaves BEFORE destroy — the pool must still exist to
        // enumerate them. These are the leaves the guard just compared with
        // the confirmed set (same read); resolve every leaf that names no disk.
        const leaves = cleanup ? await resolveLeafDisks((await poolReads.leaves(ctx.reads, poolName)) ?? []) : []

        const result = await executor.exec(ZPOOL, ['destroy', '--', poolName])
        if (result.exitCode !== 0) {
          // A busy destroy fails to unmount a dataset — name the holders (3.29).
          // The path comes from the ZFS error itself (`cannot unmount '<path>'`).
          const base = result.stderr.trim() || `zpool destroy exited with code ${result.exitCode}`
          throw new Error(await enrichBusyError(executor, base, undefined, configfsOptionsFrom(iscsiPaths)))
        }

        // PVE parity (PVE/API2/Disks/ZFS.pm, their fix for Proxmox bug #2554) and
        // issue #22: the create/import path enables zfs-import@<pool>.service, so
        // destroy disables it — otherwise the unit outlives the pool and fails at
        // every boot. A system pool can never get here (the gate refuses it at
        // both doors), so this never touches a boot pool's unit.
        // Best-effort: the pool is already gone.
        const unitWarning = await syncZfsImportUnit(executor, poolName, 'disable')
        const unitWarnings = unitWarning ? [unitWarning] : []

        if (!(cleanup && leaves.length > 0)) {
          const warnings = [...unitWarnings, ...newRefWarnings]
          return { destroyed: poolName, ...(warnings.length > 0 ? { warnings } : {}) }
        }
        // Opt-in disk hygiene ("Clean Up Disks"). All best-effort: the pool is
        // already destroyed, so nothing here may fail the job — every failure is
        // REPORTED in the result instead.
        //
        // (1) Per LEAF: `zpool labelclear` is ZFS's native all-four-labels clear
        //     (front AND back of the vdev device — where `wipefs -a` alone leaves
        //     the trailing pair, so the disk still reads as zfs_member). wipefs
        //     follows as belt-and-suspenders.
        // (2) Per WHOLE DISK: zap the GPT so the disk stops reading as
        //     `partitioned` and the inventory / AHR composer offer it again — but
        //     ONLY when the disk is EXCLUSIVELY this pool's. A shared disk (any
        //     foreign in-use partition) is left partitioned; conservative on any
        //     ownership-probe error. labelclear always runs BEFORE any zap.
        const byIdListing = await executor.exec('/usr/bin/ls', ['-la', BY_ID_PREFIX])
        const byIdToKernel = byIdListing.exitCode === 0
          ? parseByIdToKernelFull(byIdListing.stdout)
          : new Map<string, string>()

        // Story ident.1 (audit #2): a leaf is cleaned only when it is ONLINE
        // (a stale path on a faulted or missing leaf can name another disk
        // after a reshuffle) and its on-disk ZFS label says it belongs to the
        // pool just destroyed — `blkid -p` reports a zfs_member's pool guid as
        // UUID (the vdev's own as UUID_SUB). Anything else is skipped with a
        // note: never fail open.
        const wiped: string[] = []
        const wipedFailed: string[] = []
        const skipped: { leaf: string, reason: string }[] = []
        /** Leaves proven this pool's by their label — the only ones a zap may follow. */
        const matched: PoolLeaf[] = []
        for (const leaf of leaves) {
          if (leaf.state && leaf.state !== 'ONLINE') {
            skipped.push({ leaf: leaf.leafId, reason: `not cleaned: the leaf was ${leaf.state}` })
            continue
          }
          const label = await executor.exec(BLKID, ['-p', '-s', 'UUID', '-o', 'value', leaf.leafPath])
          const labelGuid = label.exitCode === 0 ? label.stdout.trim() : ''
          if (labelGuid !== guid) {
            skipped.push({
              leaf: leaf.leafId,
              reason: labelGuid
                ? `not cleaned: its ZFS label names pool guid ${labelGuid}, not ${guid}`
                : `not cleaned: no ZFS label of pool guid ${guid} found on it`,
            })
            continue
          }
          matched.push(leaf)
          updateProgress(`Clearing ZFS labels on ${leaf.leafId}`)
          // The leaf path is pool-status-sourced, not user input; `--` is
          // defense-in-depth against a crafted on-disk label path (probed).
          const labelclear = await executor.exec(ZPOOL, ['labelclear', '-f', '--', leaf.leafPath])
          const wipe = await executor.exec(WIPEFS, ['-a', '--force', leaf.leafPath])
          if (labelclear.exitCode === 0 && wipe.exitCode === 0)
            wiped.push(leaf.leafId)
          else
            wipedFailed.push(leaf.leafId)
        }

        // Group the MATCHED leaves by whole disk (dedup: many leaves on one
        // disk ⇒ one zap). A leaf whose disk could not be resolved is never
        // zapped; a disk with a skipped leaf still reads as in use (its label
        // is intact) to the ownership probe and is preserved.
        const byWholeDisk = new Map<string, PoolLeaf[]>()
        for (const leaf of matched) {
          if (!leaf.wholeDiskId || !leaf.wholeDiskPath) {
            skipped.push({ leaf: leaf.leafId, reason: 'disk not zapped: its whole disk could not be resolved' })
            continue
          }
          const list = byWholeDisk.get(leaf.wholeDiskId) ?? []
          list.push(leaf)
          byWholeDisk.set(leaf.wholeDiskId, list)
        }

        const zapped: string[] = []
        const preserved: { disk: string, reason: 'shared' | 'uncertain' }[] = []
        for (const [wholeDiskId, diskLeaves] of byWholeDisk) {
          const wholeDiskPath = diskLeaves[0].wholeDiskPath!
          const ownership = await evaluateDiskOwnership(executor, wholeDiskPath, diskLeaves, byIdToKernel)
          if (ownership !== 'exclusive') {
            preserved.push({ disk: wholeDiskId, reason: ownership })
            continue
          }
          updateProgress(`Zapping GPT on ${wholeDiskId}`)
          await executor.exec(SGDISK, ['--zap-all', wholeDiskPath])
          await executor.exec(WIPEFS, ['-a', wholeDiskPath])
          zapped.push(wholeDiskId)
        }

        const cleanupResult: {
          destroyed: string
          wiped?: string[]
          wipedFailed?: string[]
          zapped?: string[]
          preserved?: { disk: string, reason: 'shared' | 'uncertain' }[]
          skipped?: { leaf: string, reason: string }[]
          warnings?: string[]
        } = { destroyed: poolName }
        const warningsOut = [...unitWarnings, ...newRefWarnings, ...skipped.map(k => `${k.leaf}: ${k.reason}`)]
        if (warningsOut.length > 0)
          cleanupResult.warnings = warningsOut
        if (skipped.length > 0)
          cleanupResult.skipped = skipped
        if (wiped.length > 0)
          cleanupResult.wiped = wiped
        if (wipedFailed.length > 0)
          cleanupResult.wipedFailed = wipedFailed
        if (zapped.length > 0)
          cleanupResult.zapped = zapped
        if (preserved.length > 0)
          cleanupResult.preserved = preserved
        return cleanupResult
      }),
    )

    reply.code(202)
    return { job }
  })
}
