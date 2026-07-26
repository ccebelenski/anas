import type { PoolDetail, PoolSummary, VdevSpec } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ParsedPoolStatus } from '../parsers/zpool-status.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { AddVdevRequest, AttachDiskRequest, CreatePoolRequest, ExportPoolRequest, ImportPoolRequest, PoolMountpointRequest, PoolName, ScrubRequest, TrimPoolRequest, UpdatePoolPropertiesRequest } from '@anas/shared'
import { parseByIdToKernel, parseByIdToKernelFull, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { hasMount } from '../parsers/fstab.js'
import { PVE_STORAGE_CFG, readPveStorages, readZfsMountpoints } from '../parsers/pve-storage.js'
import { parseZpoolGet } from '../parsers/zpool-get.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseZpoolStatus, parseZpoolStatusPool } from '../parsers/zpool-status.js'
import { parseZpoolUpgrade } from '../parsers/zpool-upgrade.js'
import { confirmGate } from '../safety/gate.js'
import { isRootPool } from '../safety/root-pool.js'
import { enrichBusyError } from '../services/busy-diagnosis.js'
import { readConfig } from '../services/config-writer.js'
import { resolveLeafKernel } from './disks.js'
import { requireIdentity } from './identity.js'

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'
const LSBLK = '/usr/bin/lsblk'
const FINDMNT = '/usr/bin/findmnt'
/** findmnt args for live-mount collision checks (matches the AHR precedent). */
const FINDMNT_ARGS = ['--json', '--real']

const BY_ID_PREFIX = '/dev/disk/by-id/'
const PART_BY_ID_RE = /-part\d+$/
const TRAILING_CR_RE = /\r$/
const TRAILING_SLASHES_RE = /\/+$/

/** A destroyed pool's vdev leaf, resolved for disk hygiene (story 3.14). */
interface PoolLeaf {
  /**
   * by-id of the ACTUAL vdev device — WITH any `-partN` suffix, because that is
   * where ZFS wrote its four labels (two front, two back). `labelclear`/`wipefs`
   * must target this, not the whole disk: the parser's `disk.id` already strips
   * `-partN`, which would mis-target the whole-disk device and leave the
   * partition's labels intact.
   */
  leafId: string
  /** `/dev/disk/by-id/<leafId>` — labelclear + wipefs target. */
  leafPath: string
  /** by-id of the WHOLE disk (leafId minus `-partN`) — the GPT-zap target. */
  wholeDiskId: string
}

/**
 * Resolve a destroyed pool's leaves for cleanup. The leaf's real device node is
 * `disk.path` (`…-part1` for a partition vdev, the whole-disk by-id for a bare-
 * disk vdev); prefer it so labelclear hits the partition that actually holds the
 * labels. `wholeDiskId` is derived by stripping the trailing `-partN` from the
 * by-id name — uniform and nvme-safe (never a `sdb`+`1` / `nvme0n1`+`p1` concat).
 */
function leavesFromStatus(pool: ParsedPoolStatus): PoolLeaf[] {
  const leaves: PoolLeaf[] = []
  for (const group of pool.vdevGroups) {
    for (const vdev of group.vdevs) {
      for (const disk of vdev.disks) {
        const leafId = disk.path.startsWith(BY_ID_PREFIX)
          ? disk.path.slice(BY_ID_PREFIX.length)
          : disk.id
        leaves.push({
          leafId,
          leafPath: `${BY_ID_PREFIX}${leafId}`,
          wholeDiskId: leafId.replace(PART_BY_ID_RE, ''),
        })
      }
    }
  }
  return leaves
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
  wholeDiskId: string,
  diskLeaves: PoolLeaf[],
  byIdToKernel: Map<string, string>,
): Promise<DiskOwnership> {
  // Kernel names of OUR leaves on this disk — excluded from the foreign scan.
  const ourKernels = new Set<string>()
  for (const leaf of diskLeaves) {
    const kernel = byIdToKernel.get(leaf.leafId)
    if (kernel)
      ourKernels.add(kernel)
  }

  const probe = await executor.exec(LSBLK, ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID_PREFIX}${wholeDiskId}`])
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
  const res = await executor.exec(ZFS, ['get', '-Hp', '-r', '-o', 'name,value,source', 'mountpoint', poolName])
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

/** Map a disk by-id identifier to its stable /dev/disk/by-id path. */
function byIdPath(id: string): string {
  return `/dev/disk/by-id/${id}`
}

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

  if (req.properties) {
    const p = req.properties
    if (p.ashift !== undefined)
      args.push('-o', `ashift=${p.ashift}`)
    if (p.autoexpand !== undefined)
      args.push('-o', `autoexpand=${p.autoexpand ? 'on' : 'off'}`)
    if (p.autoreplace !== undefined)
      args.push('-o', `autoreplace=${p.autoreplace ? 'on' : 'off'}`)
    if (p.autotrim !== undefined)
      args.push('-o', `autotrim=${p.autotrim ? 'on' : 'off'}`)
  }

  if (req.mountpoint)
    args.push('-m', req.mountpoint)

  args.push(req.name)

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
     * storage.cfg path for PVE-managed detection (story 3.25). Defaults to the
     *  real PVE file; overridable so the hands-off guard is testable.
     */
    pveStoragePath?: string
  },
) {
  const { executor, jobQueue, confirmStore } = opts
  const fstabPath = opts.fstabPath ?? '/etc/fstab'
  const pveCfgPath = opts.pveStoragePath ?? PVE_STORAGE_CFG

  /** The PVE storages that reference a pool (story 3.25) — empty ⇒ ANAS-managed. */
  async function poolPveStorages(poolName: string): Promise<{ storage: string }[]> {
    const storages = await readPveStorages(pveCfgPath, await readZfsMountpoints())
    return storages.get(poolName) ?? []
  }

  /** Every leaf disk of a pool resolved for disk cleanup (labelclear + zap). */
  async function poolMemberLeaves(poolName: string): Promise<PoolLeaf[]> {
    const statusResult = await executor.exec(ZPOOL, ['status', '-jv'])
    if (statusResult.exitCode !== 0)
      return []
    const pool = parseZpoolStatusPool(statusResult.stdout, poolName)
    if (!pool)
      return []
    return leavesFromStatus(pool)
  }

  server.get('/pools', async (_request, _reply) => {
    const [listResult, statusResult, byIdResult, lsblkDiscardResult, upgradeResult, pveStorages, poolMounts] = await Promise.all([
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
      // Passing the ZFS mountpoint map also catches `dir` storages backed by a
      // ZFS dataset (backup/iso), not just `zfspool` entries.
      readPveStorages(pveCfgPath, await readZfsMountpoints()),
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

    // Collect a pool's leaf devices (id + path) from its parsed topology.
    const leavesOf = (status: (typeof statusData)[number] | undefined): LeafRef[] => {
      const leaves: LeafRef[] = []
      if (!status)
        return leaves
      for (const group of status.vdevGroups) {
        for (const vdev of group.vdevs) {
          for (const disk of vdev.disks)
            leaves.push({ id: disk.id, path: disk.path })
        }
      }
      return leaves
    }

    // Merge list (sizes) with status (state, scan, health) into PoolSummary
    const pools: PoolSummary[] = listData.map((pool) => {
      const status = statusByName.get(pool.name)
      const scanning = status?.scan?.state === 'SCANNING'
      const mount = poolMounts.get(pool.name)
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
        pveStorages: pveStorages.get(pool.name) ?? [],
      }
    })

    return { data: pools }
  })

  server.get<{ Params: { name: string } }>('/pools/:name', async (request, reply) => {
    const poolName = request.params.name

    const [statusResult, listResult, getResult, pveStorages, poolMounts] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['get', 'all', '-j']),
      // Read-only PVE storage detection (Epic 3.25) — fail-open (see GET /pools).
      readPveStorages(pveCfgPath),
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
      pveStorages: pveStorages.get(poolName) ?? [],
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
      ? ['scrub', '-s', poolName]
      : ['scrub', poolName]

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
      ? ['trim', '-c', poolName]
      : ['trim', poolName]

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
        const result = await executor.exec('/usr/sbin/zpool', ['upgrade', poolName])
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

    // SCOPE GUARD (story 3.25): PVE owns this pool's storage — ANAS keeps its
    // hands off the mountpoint. A hard 400, never a confirm (mirrors the grid's
    // disabled Change mount action for PVE-managed pools).
    const pveStorages = await poolPveStorages(poolName)
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
        const result = await executor.exec(ZFS, ['set', `mountpoint=${mp}`, poolName])
        if (result.exitCode !== 0) {
          // `zfs set mountpoint` unmounts to move — a busy pool blocks it; name
          // the holders (3.29). Path comes from the ZFS error (`cannot unmount`).
          const base = result.stderr.trim() || `zfs set mountpoint exited with code ${result.exitCode}`
          throw new Error(await enrichBusyError(executor, base))
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

    const args = buildCreateArgs(req)

    const job = jobQueue.submit(
      'zpool.create',
      { ...identity, params: { pool: req.name, vdevs: req.dataVdevs.length } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool create exited with code ${result.exitCode}`)
        }
        return null
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
    const args = ['import']
    if (req.force)
      args.push('-f')
    if (req.altroot)
      args.push('-R', req.altroot)
    args.push(target)

    const job = jobQueue.submit(
      'zpool.import',
      { ...identity, params: { target, force: req.force ?? false } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool import exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  async function poolExists(poolName: string): Promise<boolean> {
    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    return pools.some(p => p.name === poolName)
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

    // Build the argv by role. The schema guarantees cache/spare carry `disks`
    // and data/log/special/dedup carry `vdev`.
    let args: string[]
    let jobDisks: string[]
    let jobType: string
    if (role === 'cache' || role === 'spare') {
      const diskIds = disks ?? []
      args = ['add', poolName, role, ...diskIds.map(byIdPath)]
      jobDisks = diskIds
      jobType = role
    }
    else {
      const v = vdev!
      const head = ['add', poolName]
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

  // Attach or replace a disk (story 3.12). AttachDiskRequest.replace selects the
  // operation: false → `zpool attach` (add a mirror leg to an existing device),
  // true → `zpool replace` (swap a failed/old device for a new one).
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
    const { existingDiskId, newDiskId, replace } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const existingPath = byIdPath(existingDiskId)
    const newPath = byIdPath(newDiskId)
    const args = replace
      ? ['replace', poolName, existingPath, newPath]
      : ['attach', poolName, existingPath, newPath]

    const job = jobQueue.submit(
      replace ? 'zpool.replace' : 'zpool.attach',
      { ...identity, params: { pool: poolName, existingDisk: existingDiskId, newDisk: newDiskId, replace } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          const verb = replace ? 'replace' : 'attach'
          throw new Error(result.stderr.trim() || `zpool ${verb} exited with code ${result.exitCode}`)
        }
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
    const force = bodyParsed.data?.force ?? false

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // No cheap signal for active shares yet (Epics 6–7) — warn generically that
    // the pool becomes unavailable. Share-aware warnings land with share support.
    const warnings = [
      `Exporting '${poolName}' makes the pool and all its datasets unavailable until it is re-imported.`,
    ]

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.export',
      params: { pool: poolName },
      message: `Exporting pool '${poolName}' has consequences`,
      warnings,
    })) {
      return reply
    }

    const args = force ? ['export', '-f', poolName] : ['export', poolName]

    const job = jobQueue.submit(
      'zpool.export',
      { ...identity, params: { pool: poolName, force } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool export exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Destroy a pool (story 3.14) — the dangerous one. Blocked outright for the
  // root/boot pool (Level 1, no override); otherwise confirmation-gated.
  server.delete<{ Params: { name: string }, Querystring: { cleanup?: string } }>('/pools/:name', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    // Opt-in disk hygiene (PVE's "Clean Up Disks"): after destroy, wipe each
    // freed member so it comes back pristine and immediately reusable.
    const cleanup = request.query.cleanup === 'true' || request.query.cleanup === '1'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Level 1 block: the root/boot pool can never be destroyed, no override.
    // Checked before existence — protection is unconditional, and a root pool
    // is always present anyway.
    if (isRootPool(poolName)) {
      reply.code(409)
      return { error: { code: 'PROTECTED_RESOURCE', message: `Cannot destroy the root pool '${poolName}'` } }
    }

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const warnings = [
      `Destroying '${poolName}' is irreversible — all data in the pool is permanently lost.`,
      `Every dataset, snapshot, and volume in '${poolName}' will be destroyed.`,
    ]
    if (cleanup)
      warnings.push(`The pool's disks will be wiped clean (existing ZFS labels removed).`)

    // The confirmation protects "destroy this pool" — `cleanup` is NOT part of
    // the signature. The checkbox is chosen after the challenge is issued, so
    // binding cleanup here would make the confirmed request (cleanup=true)
    // mismatch the code minted for the challenge (cleanup=false) and 409 again.
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.destroy',
      params: { pool: poolName },
      message: `Destroying pool '${poolName}' permanently erases all its data`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'zpool.destroy',
      { ...identity, params: { pool: poolName, cleanup } },
      async (updateProgress) => {
        // Capture the member leaves by stable by-id BEFORE destroy — the pool
        // must still exist to enumerate them.
        const leaves = cleanup ? await poolMemberLeaves(poolName) : []

        const result = await executor.exec(ZPOOL, ['destroy', poolName])
        if (result.exitCode !== 0) {
          // A busy destroy fails to unmount a dataset — name the holders (3.29).
          // The path comes from the ZFS error itself (`cannot unmount '<path>'`).
          const base = result.stderr.trim() || `zpool destroy exited with code ${result.exitCode}`
          throw new Error(await enrichBusyError(executor, base))
        }

        if (!(cleanup && leaves.length > 0))
          return { destroyed: poolName }

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

        const wiped: string[] = []
        const wipedFailed: string[] = []
        for (const leaf of leaves) {
          updateProgress(`Clearing ZFS labels on ${leaf.leafId}`)
          const labelclear = await executor.exec(ZPOOL, ['labelclear', '-f', leaf.leafPath])
          const wipe = await executor.exec(WIPEFS, ['-a', '--force', leaf.leafPath])
          if (labelclear.exitCode === 0 && wipe.exitCode === 0)
            wiped.push(leaf.leafId)
          else
            wipedFailed.push(leaf.leafId)
        }

        // Group leaves by whole disk (dedup: many leaves on one disk ⇒ one zap).
        const byWholeDisk = new Map<string, PoolLeaf[]>()
        for (const leaf of leaves) {
          const list = byWholeDisk.get(leaf.wholeDiskId) ?? []
          list.push(leaf)
          byWholeDisk.set(leaf.wholeDiskId, list)
        }

        const zapped: string[] = []
        const preserved: { disk: string, reason: 'shared' | 'uncertain' }[] = []
        for (const [wholeDiskId, diskLeaves] of byWholeDisk) {
          const ownership = await evaluateDiskOwnership(executor, wholeDiskId, diskLeaves, byIdToKernel)
          if (ownership !== 'exclusive') {
            preserved.push({ disk: wholeDiskId, reason: ownership })
            continue
          }
          updateProgress(`Zapping GPT on ${wholeDiskId}`)
          await executor.exec(SGDISK, ['--zap-all', `${BY_ID_PREFIX}${wholeDiskId}`])
          await executor.exec(WIPEFS, ['-a', `${BY_ID_PREFIX}${wholeDiskId}`])
          zapped.push(wholeDiskId)
        }

        const cleanupResult: {
          destroyed: string
          wiped?: string[]
          wipedFailed?: string[]
          zapped?: string[]
          preserved?: { disk: string, reason: 'shared' | 'uncertain' }[]
        } = { destroyed: poolName }
        if (wiped.length > 0)
          cleanupResult.wiped = wiped
        if (wipedFailed.length > 0)
          cleanupResult.wipedFailed = wipedFailed
        if (zapped.length > 0)
          cleanupResult.zapped = zapped
        if (preserved.length > 0)
          cleanupResult.preserved = preserved
        return cleanupResult
      },
    )

    reply.code(202)
    return { job }
  })
}
