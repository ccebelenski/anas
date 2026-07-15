import type { Disk, DiskHealthStatus, VdevRole, VdevState } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { LSBLK_ARGS, parseLsblk } from '../parsers/lsblk.js'
import { parseSmartctl } from '../parsers/smartctl.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'

/** ZFS context for a pool-member disk, keyed by stable by-id. */
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
  const [lsblkResult, byIdResult, statusResult] = await Promise.all([
    executor.exec('/usr/bin/lsblk', LSBLK_ARGS),
    executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/']),
    executor.exec('/usr/sbin/zpool', ['status', '-jv']),
  ])

  const byIdMap = parseDiskByIdListing(byIdResult.stdout)

  // Rich ZFS context per disk (vdev/role/state/error counts), keyed by by-id.
  const poolInfo = new Map<string, PoolDiskInfo>()
  if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
    try {
      const pools = parseZpoolStatus(statusResult.stdout)
      for (const pool of pools) {
        for (const group of pool.vdevGroups) {
          for (const vdev of group.vdevs) {
            for (const disk of vdev.disks) {
              poolInfo.set(disk.id, {
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

  // parseLsblk only needs id→pool for its usage-status classification.
  const poolDisks = new Map<string, string>()
  for (const [id, info] of poolInfo)
    poolDisks.set(id, info.pool)

  const disks = parseLsblk(lsblkResult.stdout, byIdMap, poolDisks)

  // Lazy-load identity cache for all disks in parallel
  await diskIdentityCache.loadMany(disks.map(d => ({ id: d.id, path: d.path })))

  // Enrich each disk with cached identity, ZFS context, and derived health.
  return disks.map((d) => {
    const identity = diskIdentityCache.getCached(d.id)
    const smartHealthy = identity ? identity.smartHealthy : null
    const info = poolInfo.get(d.id)
    const zfsContext = info
      ? {
          vdevName: info.vdevName,
          vdevRole: info.role,
          zfsErrors: { read: info.read, write: info.write, checksum: info.checksum },
        }
      : { vdevName: null, vdevRole: null, zfsErrors: null }
    return {
      ...d,
      modelFamily: identity ? identity.modelFamily : null,
      formFactor: identity ? identity.formFactor : null,
      revision: identity?.firmwareVersion ?? d.revision,
      smartHealthy,
      ...zfsContext,
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
