import type { FastifyInstance } from 'fastify'
import type { Disk } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { parseLsblk, LSBLK_ARGS } from '../parsers/lsblk.js'
import { parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'
import { parseSmartctl } from '../parsers/smartctl.js'

export async function diskRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, diskIdentityCache: DiskIdentityCache },
) {
  const { executor, diskIdentityCache } = opts

  /** Fetch all disk data: lsblk, by-id mapping, and pool membership. */
  async function fetchDisks(): Promise<Disk[]> {
    const [lsblkResult, byIdResult, statusResult] = await Promise.all([
      executor.exec('/usr/bin/lsblk', LSBLK_ARGS),
      executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/']),
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
    ])

    const byIdMap = parseDiskByIdListing(byIdResult.stdout)

    const poolDisks = new Map<string, string>()
    if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
      try {
        const pools = parseZpoolStatus(statusResult.stdout)
        for (const pool of pools) {
          for (const group of pool.vdevGroups) {
            for (const vdev of group.vdevs) {
              for (const disk of vdev.disks) {
                poolDisks.set(disk.id, pool.name)
              }
            }
          }
        }
      }
      catch {
        // continue with empty pool map
      }
    }

    const disks = parseLsblk(lsblkResult.stdout, byIdMap, poolDisks)

    // Lazy-load identity cache for all disks in parallel
    await diskIdentityCache.loadMany(disks.map(d => ({ id: d.id, path: d.path })))

    // Enrich disks with cached identity
    return disks.map(d => {
      const identity = diskIdentityCache.getCached(d.id)
      if (!identity) return { ...d, modelFamily: null, formFactor: null }
      return {
        ...d,
        modelFamily: identity.modelFamily,
        formFactor: identity.formFactor,
        // Override revision with smartctl firmware if available (often more detailed)
        revision: identity.firmwareVersion ?? d.revision,
      }
    })
  }

  server.get('/disks', async (_request, reply) => {
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
