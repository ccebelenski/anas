import type { PoolDetail, PoolSummary } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { PoolName, ScrubRequest, UpdatePoolPropertiesRequest } from '@anas/shared'
import { parseZpoolGet } from '../parsers/zpool-get.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseZpoolStatus, parseZpoolStatusPool } from '../parsers/zpool-status.js'
import { requireIdentity } from './identity.js'

export async function poolRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, jobQueue: JobQueue },
) {
  const { executor, jobQueue } = opts

  server.get('/pools', async (_request, _reply) => {
    const [listResult, statusResult] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
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

  server.get<{ Params: { name: string } }>('/pools/:name', async (request, reply) => {
    const poolName = request.params.name

    const [statusResult, listResult, getResult] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['get', 'all', '-j']),
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
}
