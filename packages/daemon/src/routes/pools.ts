import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { PoolSummary } from '@anas/shared'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'

export async function poolRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor },
) {
  const { executor } = opts

  server.get('/pools', async (_request, reply) => {
    const [listResult, statusResult] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['status', '-j']),
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

    // Merge list (sizes) with status (state, scan, health) into PoolSummary
    const pools: PoolSummary[] = listData.map((pool) => {
      const status = statusByName.get(pool.name)
      return {
        ...pool,
        state: status?.state ?? pool.state,
        scanRunning: status?.scan?.state === 'SCANNING',
        ...(status?.health && { health: status.health }),
      }
    })

    return { data: pools }
  })
}
