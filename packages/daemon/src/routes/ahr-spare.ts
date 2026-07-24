import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { AhrSpareRequest, DiskId, PoolName } from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { projectExistingBands } from '../services/ahr-expand-exec.js'
import { readIntent } from '../services/ahr-intent.js'
import { attachSpare, removeSpare, spareCoverage, spareShortfallMessage } from '../services/ahr-spare.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

const GIB = 1024 ** 3

function fmtSize(bytes: number): string {
  const gib = bytes / GIB
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TiB` : `${gib.toFixed(1)} GiB`
}

export interface AhrSpareRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  diskIdentityCache: DiskIdentityCache
  /** AhrExpansionIntent store directory (attach/remove refuse mid-expansion). */
  intentDir: string
}

/**
 * AHR hot-spare routes (story 11.11, docs/AHR-DESIGN.md §11/§4):
 *
 *   POST   /v1/ahr/:name/spare      — attach a full-coverage spare
 *                                     (202 job / 409 confirm — the disk is WIPED)
 *   DELETE /v1/ahr/:name/spare/:id  — remove a spare
 *                                     (202 job / 409 confirm — headroom drops)
 *
 * The §11 full-coverage rule is enforced here BEFORE the confirm: a spare's
 * rounded usable size must reach the pool's top array boundary, or the
 * request is refused with the exact shortfall. Both verbs refuse while an
 * expansion intent exists — the band geometry is in flight and the expansion
 * executor owns spare coverage of new bands.
 */
export async function ahrSpareRoutes(server: FastifyInstance, opts: AhrSpareRouteOptions) {
  const { executor, jobQueue, confirmStore, diskIdentityCache, intentDir } = opts

  async function loadPool(rawName: string, reply: FastifyReply): Promise<AhrPool | null> {
    const parsed = PoolName.safeParse(rawName)
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    const pool = (await readAhrPools(executor)).find(p => p.name === parsed.data)
    if (!pool) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: `AHR pool '${parsed.data}' not found` } })
      return null
    }
    return pool
  }

  /** 409 while an expansion intent exists — band geometry is in flight. */
  async function refuseExistingIntent(pool: string, reply: FastifyReply): Promise<boolean> {
    const existing = await readIntent(pool, intentDir)
    if (existing) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool}' has an expansion intent (state '${existing.state}') — spares can be changed once it completes or is abandoned.`,
      } })
      return true
    }
    return false
  }

  // ---- POST /ahr/:name/spare — attach (409 confirm: the disk is WIPED) -----
  server.post<{ Params: { name: string } }>('/ahr/:name/spare', async (request, reply) => {
    const bodyParsed = AhrSpareRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid spare request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { diskId } = bodyParsed.data
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseExistingIntent(pool.name, reply))
      return

    const already = pool.disks.find(d => d.id === diskId)
    if (already) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `disk '${diskId}' is already part of pool '${pool.name}' (role: ${already.role})` } }
    }

    // Only an 'available' inventory disk may become a spare (GT-12: the
    // in-use/foreign-label exclusions are safety-critical).
    const inventory = await collectDisks(executor, diskIdentityCache)
    const disk = inventory.find(d => d.id === diskId)
    if (!disk) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `disk '${diskId}' not found in the inventory` } }
    }
    if (disk.status !== 'available') {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `disk '${diskId}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})` } }
    }

    // §11 full-coverage rule: usable (rounded) ≥ the pool's top array
    // boundary — a partial spare is refused with the EXACT shortfall.
    let topBoundaryBytes: number
    try {
      const bands = projectExistingBands(pool)
      if (bands.length === 0)
        throw new Error(`pool '${pool.name}' has no band arrays`)
      topBoundaryBytes = bands.at(-1)!.endBytes
    }
    catch (err) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
    const coverage = spareCoverage(topBoundaryBytes, disk.size)
    if (!coverage.ok) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: spareShortfallMessage(diskId, coverage) } }
    }

    // Confirm gate (Principle 14): the concrete consequence — THIS disk is
    // wiped — plus what the spare buys and any slot hygiene that runs first.
    const bandCount = pool.arrays.length
    const hasFaulty = pool.arrays.some(a => a.members.some(m => m.memberState === 'faulty'))
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.spare.add',
      params: { pool: pool.name, diskId },
      message: `Attaching '${diskId}' as a hot spare to pool '${pool.name}' WIPES the disk`,
      warnings: [
        `${diskId} (${disk.model ?? 'unknown model'}, ${fmtSize(disk.size)}) will be completely erased and partitioned with the pool's band geometry`,
        `The spare covers every band (${bandCount} array${bandCount === 1 ? '' : 's'}): when a member fails, md starts the rebuild onto it immediately — no operator action needed`,
        ...(hasFaulty
          ? ['Faulty slots whose device is gone are removed from the arrays first (slot hygiene); a faulty disk that is still attached is left for Re-add or Replace']
          : []),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.spare.add',
      { ...identity, params: { pool: pool.name, diskId } },
      async updateProgress => attachSpare(executor, { pool, diskId, diskSizeBytes: disk.size }, updateProgress),
    )
    reply.code(202)
    return { job }
  })

  // ---- DELETE /ahr/:name/spare/:id — remove (409 confirm: headroom drops) --
  server.delete<{ Params: { name: string, id: string } }>('/ahr/:name/spare/:id', async (request, reply) => {
    const idParsed = DiskId.safeParse(request.params.id)
    if (!idParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid disk id: ${idParsed.error.issues[0]?.message}` } }
    }
    const diskId = idParsed.data
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseExistingIntent(pool.name, reply))
      return

    const disk = pool.disks.find(d => d.id === diskId)
    if (!disk) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `disk '${diskId}' is not part of pool '${pool.name}'` } }
    }
    if (disk.role !== 'spare') {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `disk '${diskId}' is a MEMBER of pool '${pool.name}', not a spare — members leave only through Replace` } }
    }

    const remaining = pool.disks.filter(d => d.role === 'spare' && d.id !== diskId).length
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.spare.remove',
      params: { pool: pool.name, diskId },
      message: `Removing hot spare '${diskId}' from pool '${pool.name}' drops its protection headroom`,
      warnings: [
        remaining === 0
          ? `Pool '${pool.name}' will have NO hot spare: the next member failure waits for a manual Replace instead of rebuilding automatically`
          : `Pool '${pool.name}' will have ${remaining} hot spare${remaining === 1 ? '' : 's'} left`,
        `The spare's slices are removed from every band array and the disk is wiped clean (md superblocks zeroed, partition table zapped)`,
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.spare.remove',
      { ...identity, params: { pool: pool.name, diskId } },
      async updateProgress => removeSpare(executor, { pool, diskId }, updateProgress),
    )
    reply.code(202)
    return { job }
  })
}
