import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import { parseLsblk, LSBLK_ARGS } from '../parsers/lsblk.js'
import { parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'
import { parseSmartctl } from '../parsers/smartctl.js'

export async function diskRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor },
) {
  const { executor } = opts

  /** Fetch all disk data: lsblk, by-id mapping, and pool membership. */
  async function fetchDisks() {
    const [lsblkResult, byIdResult, statusResult] = await Promise.all([
      executor.exec('/usr/bin/lsblk', LSBLK_ARGS),
      executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/']),
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
    ])

    const byIdMap = parseDiskByIdListing(byIdResult.stdout)

    // Build a Map<diskId, poolName> from zpool status vdev trees
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
        // zpool status returned unexpected output — continue with empty pool map
      }
    }

    return parseLsblk(lsblkResult.stdout, byIdMap, poolDisks)
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

    // smartctl returns non-zero exit codes for various conditions
    // (e.g. bit 0 = command parse error, bit 2 = disk open error)
    // but still produces valid JSON output in most cases
    const smartData = parseSmartctl(smartResult.stdout)
    return { data: smartData }
  })
}
