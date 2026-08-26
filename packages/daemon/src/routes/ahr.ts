import type { AhrPool } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { AhrLayoutDisk } from '../services/ahr-layout.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { AhrLayoutPreviewRequest, isComposableDisk, PoolName } from '@anas/shared'
import { withAhrCreateStatus } from '../services/ahr-create-status.js'
import { readIntent } from '../services/ahr-intent.js'
import { AhrPlanError, planFreshLayout } from '../services/ahr-layout.js'
import { readAhrPools, withExpansionIntent } from '../services/ahr-topology.js'
import { createIscsiClaimCache, heldByLun } from '../services/iscsi-held.js'
import { kernelInfo } from '../services/kernel-version.js'
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
  opts: {
    executor: CommandExecutor
    diskIdentityCache: DiskIdentityCache
    intentDir?: string
    /**
     * Job queue — consulted (never mutated) so a pool being built by a live
     * `ahr.create` reads `building` instead of the half-stack's `failed`
     * (issue #7). Optional: without it the read falls back to pure system truth.
     */
    jobQueue?: JobQueue
    /** iSCSI read-layer path overrides (story iscsi.6) — the heldByLun field. */
    iscsiPaths?: IscsiPaths
  },
) {
  const { executor, diskIdentityCache, intentDir, jobQueue } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}

  /**
   * Stamp `heldByLun` onto every AHR pool a LUN's image file lives on (story
   * iscsi.6) — the field the Hybrid RAID toolbar greys Destroy / Unmount /
   * Change mount from. ONE claims read for the whole list; additive, so a pool
   * nothing holds carries no field.
   */
  async function annotateHeldByLun(pools: AhrPool[]): Promise<AhrPool[]> {
    if (pools.length === 0)
      return pools
    const cache = createIscsiClaimCache(executor, iscsiPaths)
    if ((await cache.claims()).length === 0)
      return pools
    return Promise.all(pools.map(async (pool) => {
      const subject: { pool: string, path?: string } = { pool: pool.name }
      if (pool.mounted && pool.mountpoint.startsWith('/'))
        subject.path = pool.mountpoint
      const held = await heldByLun(cache, subject)
      return held ? { ...pool, heldByLun: held } : pool
    }))
  }

  // Attach the live expansion intent (§6.2: 'halted' must surface Resume/
  // Abandon loudly), then the live create job's status (issue #7). Best-effort —
  // a corrupt intent file must not take the read path down; the expansion routes
  // surface it properly on use.
  const withIntent = async (pool: AhrPool): Promise<AhrPool> => {
    try {
      const intent = await readIntent(pool.name, intentDir)
      return withAhrCreateStatus(withExpansionIntent(pool, intent), jobQueue)
    }
    catch {
      return withAhrCreateStatus(pool, jobQueue)
    }
  }

  // --- GET /ahr — list pools ----------------------------------------------
  server.get('/ahr', async () => {
    const pools = await Promise.all((await readAhrPools(executor)).map(withIntent))
    return { data: await annotateHeldByLun(pools) }
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
    return { data: (await annotateHeldByLun([await withIntent(pool)]))[0] }
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
    // logicalSectorSize rides along so the preview can label a mixed 4Kn/512e
    // selection (issue #8) — the composer's live feedback is where the operator
    // should learn about it, long before anything is wiped.
    const selected: AhrLayoutDisk[] = []
    for (const id of requestedIds) {
      const disk = inventory.find(d => d.id === id)
      if (!disk) {
        problems.push(`disk '${id}' not found`)
        continue
      }
      if (!isComposableDisk(disk)) {
        problems.push(disk.handsOff
          ? `disk '${id}' is hands-off: ${disk.handsOffReason ?? disk.handsOff}`
          : `disk '${id}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})`)
        continue
      }
      selected.push({ id: disk.id, usableBytes: disk.size, logicalSectorSize: disk.logicalSectorSize })
    }
    if (problems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${problems.join('; ')}` } }
    }

    try {
      return { data: planFreshLayout(selected, tier, kernelInfo()) }
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
