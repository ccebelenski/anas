import type { Disk, DiskHealthStatus, VdevRole, VdevState } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { parseByIdToKernel, parseDiskByIdListing, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { LSBLK_ARGS, parseLsblk } from '../parsers/lsblk.js'
import { parseSmartctl } from '../parsers/smartctl.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'
import { readAhrPools } from '../services/ahr-topology.js'

const BY_ID_PATH_RE = /^\/dev\/disk\/by-id\/(.+)$/
const KERNEL_PATH_RE = /^\/dev\/([a-z0-9]+)$/
const PART_SUFFIX_RE = /-part\d+$/
const BARE_KERNEL_RE = /^(?:sd|vd|hd)[a-z]+\d*$|^nvme\d+n\d+/

/**
 * Resolve a `zpool status` leaf to its whole-disk KERNEL name so both sides of
 * the disk↔pool join canonicalize to the same key. A leaf's ZFS-chosen by-id
 * (its `devid`) is often a DIFFERENT form than the highest-priority by-id our
 * disk parser picks (e.g. ZFS says `wwn-0x…`, we display `ata-WDC…`); keying on
 * the by-id therefore drops the match on real hardware. The kernel device is
 * the one identity both agree on.
 *
 * Precedence, mirroring `zpool-status`'s own `diskId()` inputs:
 *   1. the leaf `id` (its `devid`, or a by-id derived from `path`/`name`),
 *      looked up in the complete by-id → kernel map;
 *   2. the leaf `path`: a `/dev/disk/by-id/<x>` form is stripped + mapped; a
 *      `/dev/sdX[N]` / `/dev/nvmeXnY[pN]` form is reduced to its parent kernel;
 *   3. the leaf `id` treated as a bare kernel name.
 * Returns null when nothing resolves — that leaf simply won't cross-reference.
 */
export function resolveLeafKernel(
  id: string,
  path: string,
  byIdToKernel: Map<string, string>,
): string | null {
  // 1. id is the leaf's devid (or by-id from path/name) in the common case.
  const fromId = byIdToKernel.get(id.replace(PART_SUFFIX_RE, ''))
  if (fromId)
    return fromId

  // 2. fall back to the raw path.
  if (path) {
    const byIdPath = path.match(BY_ID_PATH_RE)
    if (byIdPath) {
      const fromPath = byIdToKernel.get(byIdPath[1].replace(PART_SUFFIX_RE, ''))
      if (fromPath)
        return fromPath
    }
    const kernelPath = path.match(KERNEL_PATH_RE)
    if (kernelPath)
      return wholeDiskKernel(kernelPath[1])
  }

  // 3. id may itself be a bare kernel name (ZFS had nothing better).
  if (BARE_KERNEL_RE.test(id))
    return wholeDiskKernel(id)

  return null
}

/** AHR context for a member disk, keyed by whole-disk kernel name. */
interface AhrDiskInfo {
  /** The AHR pool this disk belongs to. */
  pool: string
  /** Band-array label — the AHR parallel to a ZFS vdev name (see Disk.ahrArray). */
  array: string
}

/**
 * The `Disk.ahrArray` band label for one AHR member disk: a single-band disk
 * reads "r1", a disk spanning bands reads the range "r1-r3", and a hot spare
 * (which slices every band but carries no active membership) reads "spare".
 * Bands are contiguous from the bottom up by AHR construction (§2.6), so a
 * first→last range is faithful.
 */
export function ahrBandLabel(bands: number[], role: 'member' | 'spare'): string {
  if (role === 'spare')
    return 'spare'
  const unique = [...new Set(bands)]
  if (unique.length === 0)
    return 'AHR'
  if (unique.length === 1)
    return `r${unique[0]}`
  // Only the span matters for the label; take min/max directly (no sort).
  return `r${Math.min(...unique)}-r${Math.max(...unique)}`
}

/** ZFS context for a pool-member disk, keyed by whole-disk kernel name. */
interface PoolDiskInfo {
  pool: string
  vdevName: string
  role: VdevRole
  state: VdevState
  read: number
  write: number
  checksum: number
}

/**
 * Fuse SMART pass/fail with live ZFS state into one health level — the signal
 * PVE's disk view never combines. Cheap: uses already-collected data, no extra
 * smartctl call per disk.
 */
export function computeHealth(
  smartHealthy: boolean | null,
  info: PoolDiskInfo | undefined,
): DiskHealthStatus {
  if (smartHealthy === false)
    return 'critical'
  if (info) {
    if (info.state === 'FAULTED' || info.state === 'UNAVAIL' || info.state === 'REMOVED'
      || info.read > 0 || info.write > 0) {
      return 'critical'
    }
    if (info.state === 'OFFLINE' || info.state === 'DEGRADED' || info.checksum > 0)
      return 'warning'
    // In a pool, ONLINE, no errors — ZFS and SMART agree it's fine.
    return 'healthy'
  }
  // Not in a pool: only SMART tells us anything.
  return smartHealthy === true ? 'healthy' : 'unknown'
}

/**
 * Fetch all disk data: lsblk, by-id mapping, and pool membership, enriched with
 * cached identity + the fused SMART/ZFS `healthStatus`. Standalone (not a route
 * closure) so the Disks view AND the Dashboard status endpoint share ONE health
 * computation rather than diverging (Epic 2 reuse).
 */
export async function collectDisks(
  executor: CommandExecutor,
  diskIdentityCache: DiskIdentityCache,
): Promise<Disk[]> {
  const [lsblkResult, byIdResult, statusResult, ahrPools] = await Promise.all([
    executor.exec('/usr/bin/lsblk', LSBLK_ARGS),
    executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/']),
    executor.exec('/usr/sbin/zpool', ['status', '-jv']),
    // Single-source AHR membership from the topology reader (never re-parse
    // mdstat here). Fail-soft: an AHR read error (or md absent) yields no AHR
    // membership and disks fall through to their existing status — the disks
    // endpoint must never crash because AHR is unreadable.
    readAhrPools(executor).catch(() => []),
  ])

  const byIdMap = parseDiskByIdListing(byIdResult.stdout)
  // Complete by-id → kernel map (every ata-/wwn-/scsi-/nvme- form), used to
  // canonicalize both the zpool-status leaves and the physical disks to the
  // same kernel device before joining. See resolveLeafKernel.
  const byIdToKernel = parseByIdToKernel(byIdResult.stdout)

  // Rich ZFS context per disk (vdev/role/state/error counts), keyed by the
  // whole-disk KERNEL name — the identity both zpool-status and lsblk share.
  const poolInfo = new Map<string, PoolDiskInfo>()
  if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
    try {
      const pools = parseZpoolStatus(statusResult.stdout)
      for (const pool of pools) {
        for (const group of pool.vdevGroups) {
          for (const vdev of group.vdevs) {
            for (const disk of vdev.disks) {
              const kernel = resolveLeafKernel(disk.id, disk.path, byIdToKernel)
              if (!kernel)
                continue
              poolInfo.set(kernel, {
                pool: pool.name,
                vdevName: vdev.name,
                role: group.role,
                state: disk.state,
                read: disk.readErrors,
                write: disk.writeErrors,
                checksum: disk.checksumErrors,
              })
            }
          }
        }
      }
    }
    catch {
      // continue with empty pool map
    }
  }

  // parseLsblk needs kernel-name → pool for its usage-status classification.
  const poolDisks = new Map<string, string>()
  for (const [kernel, info] of poolInfo)
    poolDisks.set(kernel, info.pool)

  // AHR membership per disk, keyed by the SAME whole-disk kernel name the
  // disk↔pool join uses (d.name). readAhrPools reports disks by their by-id;
  // canonicalize each to its kernel via the complete by-id → kernel map so both
  // AHR and physical disks agree on one identity (GT-2). A band member lives on
  // a partition, but AhrDisk already resolves to the whole disk + its band
  // slices — we read the bands straight off it, no partition re-parsing.
  const ahrInfo = new Map<string, AhrDiskInfo>()
  for (const pool of ahrPools) {
    for (const disk of pool.disks) {
      const kernel = byIdToKernel.get(disk.id) ?? disk.id
      const bands = disk.partitions.map(p => p.band)
      ahrInfo.set(kernel, { pool: pool.name, array: ahrBandLabel(bands, disk.role) })
    }
  }

  const disks = parseLsblk(lsblkResult.stdout, byIdMap, poolDisks)

  // Lazy-load identity cache for all disks in parallel
  await diskIdentityCache.loadMany(disks.map(d => ({ id: d.id, path: d.path })))

  // Enrich each disk with cached identity, ZFS context, and derived health.
  return disks.map((d) => {
    const identity = diskIdentityCache.getCached(d.id)
    const smartHealthy = identity ? identity.smartHealthy : null
    // Pool context joins on the kernel name (d.name), NOT the display by-id
    // (d.id) — the by-id ZFS reports and the by-id we display can differ.
    const info = poolInfo.get(d.name)
    const zfsContext = info
      ? {
          vdevName: info.vdevName,
          vdevRole: info.role,
          zfsErrors: { read: info.read, write: info.write, checksum: info.checksum },
        }
      : { vdevName: null, vdevRole: null, zfsErrors: null }
    // AHR membership (never a ZFS pool member at the same time — ZFS wins if,
    // impossibly, both claim a disk). An AHR member is 'ahr_member' + its pool
    // + band label, parallel to how a ZFS member becomes 'pool_member'. Fusing
    // AHR array error state into healthStatus is OUT of scope here (a separate
    // parity item), so healthStatus stays SMART-derived for AHR members.
    const ahr = info ? undefined : ahrInfo.get(d.name)
    const ahrContext = ahr
      ? { status: 'ahr_member' as const, poolName: ahr.pool, ahrArray: ahr.array }
      : {}
    return {
      ...d,
      modelFamily: identity ? identity.modelFamily : null,
      formFactor: identity ? identity.formFactor : null,
      revision: identity?.firmwareVersion ?? d.revision,
      smartHealthy,
      ...zfsContext,
      ...ahrContext,
      healthStatus: computeHealth(smartHealthy, info),
    }
  })
}

export async function diskRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, diskIdentityCache: DiskIdentityCache },
) {
  const { executor, diskIdentityCache } = opts

  /** Fetch all disk data: lsblk, by-id mapping, and pool membership. */
  async function fetchDisks(): Promise<Disk[]> {
    return collectDisks(executor, diskIdentityCache)
  }

  server.get('/disks', async (_request, _reply) => {
    const disks = await fetchDisks()
    return { data: disks }
  })

  server.get<{ Params: { id: string } }>('/disks/:id', async (request, reply) => {
    const { id } = request.params
    const disks = await fetchDisks()
    const disk = disks.find(d => d.id === id)

    if (!disk) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Disk '${id}' not found` } }
    }

    return { data: disk }
  })

  server.get<{ Params: { id: string } }>('/disks/:id/smart', async (request, reply) => {
    const { id } = request.params
    const disks = await fetchDisks()
    const disk = disks.find(d => d.id === id)

    if (!disk) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Disk '${id}' not found` } }
    }

    const smartResult = await executor.exec('/usr/sbin/smartctl', [
      '-a',
      '--json',
      disk.path,
    ])

    const smartData = parseSmartctl(smartResult.stdout)
    return { data: smartData }
  })
}
