import type { AhrPool } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { AhrLayoutPreviewRequest, PoolName } from '@anas/shared'
import { readIntent } from '../services/ahr-intent.js'
import { AhrPlanError, planFreshLayout } from '../services/ahr-layout.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { collectDisks } from './disks.js'

/**
 * AHR read layer (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — the non-mutating
 * half of /v1/ahr:
 *
 *   GET  /v1/ahr                 — list AHR pools
 *   GET  /v1/ahr/:name           — full pool detail (the §3 structure)
 *   POST /v1/ahr/layout/preview  — §2.1 dry-run for a disk selection + tier
 *
 * Everything here is reconstructed live from the system (services/
 * ahr-topology.ts) — no registry, no shadow state (§5.3). The preview is
 * PURE computation over the /v1/disks inventory: no mutation, ever.
 * Mutation routes (create/expand/replace/scrub/destroy — all jobs, all
 * confirm-gated) live separately in routes/ahr-mutate.ts.
 */
export async function ahrRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, diskIdentityCache: DiskIdentityCache, intentDir?: string },
) {
  const { executor, diskIdentityCache, intentDir } = opts

  // Attach the live expansion intent (§6.2: 'halted' must surface Resume/
  // Abandon loudly). Best-effort — a corrupt intent file must not take the
  // read path down; the expansion routes surface it properly on use.
  const withIntent = async (pool: AhrPool): Promise<AhrPool> => {
    try {
      const intent = await readIntent(pool.name, intentDir)
      return intent ? { ...pool, expansion: intent } : pool
    }
    catch {
      return pool
    }
  }

  // --- GET /ahr — list pools ----------------------------------------------
  server.get('/ahr', async () => {
    return { data: await Promise.all((await readAhrPools(executor)).map(withIntent)) }
  })

  // --- GET /ahr/:name — full pool detail ----------------------------------
  server.get<{ Params: { name: string } }>('/ahr/:name', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const pool = (await readAhrPools(executor)).find(p => p.name === nameParsed.data)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${nameParsed.data}' not found` } }
    }
    return { data: await withIntent(pool) }
  })

  // --- POST /ahr/layout/preview — dry-run, NO mutation ---------------------
  server.post('/ahr/layout/preview', async (request, reply) => {
    const bodyParsed = AhrLayoutPreviewRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid layout preview request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { disks: requestedIds, tier } = bodyParsed.data

    // Resolve every requested disk against the live inventory. Only status
    // 'available' disks are eligible — in-use, foreign-labeled, pool-member,
    // and system disks are rejected by name with their reason (GT-12: these
    // exclusions are safety-critical, not cosmetic).
    const inventory = await collectDisks(executor, diskIdentityCache)
    const problems: string[] = []
    const selected: { id: string, usableBytes: number }[] = []
    for (const id of requestedIds) {
      const disk = inventory.find(d => d.id === id)
      if (!disk) {
        problems.push(`disk '${id}' not found`)
        continue
      }
      if (disk.status !== 'available') {
        problems.push(`disk '${id}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})`)
        continue
      }
      selected.push({ id: disk.id, usableBytes: disk.size })
    }
    if (problems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${problems.join('; ')}` } }
    }

    try {
      return { data: planFreshLayout(selected, tier) }
    }
    catch (err) {
      if (err instanceof AhrPlanError) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: err.message } }
      }
      throw err
    }
  })
}
