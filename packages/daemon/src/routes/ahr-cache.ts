import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { AttachAhrCacheRequest, isComposableDisk, PoolName } from '@anas/shared'
import { attachAhrCache, detachAhrCache } from '../services/ahr-cache.js'
import { readIntent } from '../services/ahr-intent.js'
import { fmtBytes } from '../services/ahr-layout.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

export interface AhrCacheRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  diskIdentityCache: DiskIdentityCache
  /** AhrExpansionIntent store directory (both verbs refuse mid-expansion). */
  intentDir: string
}

/**
 * AHR read-cache routes (story ahrcache.1, docs/AHR-DESIGN.md §13/§4):
 *
 *   POST   /v1/ahr/:name/cache  — attach a writethrough read cache (202 job)
 *   DELETE /v1/ahr/:name/cache  — detach it (202 job)
 *
 * NEITHER IS CONFIRM-GATED, and that is a decision, not an omission
 * (Principle 14 draws the line at destroying something). A writethrough cache
 * never holds the only copy of a byte: attach wipes disks the inventory
 * already reports `available`, and detach drops a volume whose entire contents
 * are also on the pool. There is nothing a confirm code could protect.
 *
 * Both are jobs (Principle 4), both audited through the queue like every other
 * AHR mutation, and both refuse while an expansion intent exists — the same
 * gate the spare verbs use, for the same reason: the VG's shape is in flight
 * and the expansion executor grows the pool LV into whatever free extents it
 * finds.
 *
 * A ROTATING cache disk is ALLOWED. The response carries one advisory sentence
 * and the request proceeds — it is the operator's disk and their call.
 */
export async function ahrCacheRoutes(server: FastifyInstance, opts: AhrCacheRouteOptions) {
  const { executor, jobQueue, diskIdentityCache, intentDir } = opts

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

  /** 409 while an expansion intent exists — the VG's shape is in flight. */
  async function refuseExistingIntent(pool: string, reply: FastifyReply): Promise<boolean> {
    const existing = await readIntent(pool, intentDir)
    if (existing) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool}' has an expansion intent (state '${existing.state}') — the cache can be changed once it completes or is abandoned.`,
      } })
      return true
    }
    return false
  }

  // ---- POST /ahr/:name/cache — attach ---------------------------------------
  server.post<{ Params: { name: string } }>('/ahr/:name/cache', async (request, reply) => {
    const bodyParsed = AttachAhrCacheRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid cache attach request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { disks: requestedIds } = bodyParsed.data
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseExistingIntent(pool.name, reply))
      return

    // Already cached: attaching a second cache to one LV is not a thing LVM
    // does, and silently no-op'ing would read as success.
    if (pool.cache && pool.cache.state !== 'absent') {
      reply.code(409)
      return { error: {
        code: 'CONFLICT',
        message: `AHR pool '${pool.name}' already has a read cache (${pool.cache.devices.join(', ') || 'device missing'}, ${fmtBytes(pool.cache.sizeBytes)}, state '${pool.cache.state}'). Detach it before attaching another`,
      } }
    }
    // A pool whose volume is not assembled has nothing to put a cache in front
    // of, and `lvconvert` would fail on an inactive LV after the disks were
    // already sliced. Refuse now, while nothing has been touched.
    if (pool.state === 'offline' || pool.state === 'failed') {
      reply.code(409)
      return { error: {
        code: 'CONFLICT',
        message: `AHR pool '${pool.name}' is ${pool.state}: its volume is not assembled, so there is nothing to cache. See the Hybrid RAID view`,
      } }
    }

    // A LEFTOVER slice of THIS pool's own cache, on a pool that has no cache
    // any more: the `<pool>-cache<n>` slice of a device that died and has since
    // come back (it returns carrying an outdated PV label — §13). The disk
    // reads `ahr_member`/`cache` because of that slice, so both the
    // already-in-the-pool test and `isComposableDisk` would refuse it, and the
    // operator would have no product path back to a disk ANAS itself marked.
    // Re-attaching to it is exactly the right move: `ensureCachePv` reuses the
    // slice and `wipefs -a`s the stale signature off it before `pvcreate`.
    // (Detaching also works and hands the disk back — see the DELETE route.)
    const reclaimable = new Set(pool.cache?.state === 'absent' ? pool.cache.devices : [])

    // Otherwise only 'available' inventory disks may become a cache (GT-12:
    // the in-use/foreign-label exclusions are safety-critical, not cosmetic).
    const inventory = await collectDisks(executor, diskIdentityCache)
    const problems: string[] = []
    const selected: { id: string, size: number, model: string | null, rotational: boolean }[] = []
    for (const id of requestedIds) {
      const poolDisk = pool.disks.find(d => d.id === id)
      if (poolDisk && !reclaimable.has(id)) {
        problems.push(`disk '${id}' is already part of pool '${pool.name}' (role: ${poolDisk.role})`)
        continue
      }
      const disk = inventory.find(d => d.id === id)
      if (!disk) {
        problems.push(`disk '${id}' not found in the inventory`)
        continue
      }
      if (!isComposableDisk(disk) && !reclaimable.has(id)) {
        problems.push(disk.handsOff
          ? `disk '${id}' is hands-off: ${disk.handsOffReason ?? disk.handsOff}`
          : `disk '${id}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})`)
        continue
      }
      selected.push({ id: disk.id, size: disk.size, model: disk.model, rotational: disk.rotational })
    }
    if (problems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible cache disk selection: ${problems.join('; ')}` } }
    }

    // The ONE advisory a rotating pick earns — stated as a fact, then dropped.
    // It rides the job RESULT's `warnings`, the established home for an
    // advisory on a 202 route (backup.repo.update): the 202 body is
    // `{ job }` and nothing else, by schema.
    const rotationalIds = selected.filter(d => d.rotational).map(d => d.id)

    const job = jobQueue.submit(
      'ahr.cache.attach',
      { ...identity, params: { pool: pool.name, disks: selected.map(d => d.id) } },
      async updateProgress => attachAhrCache(
        executor,
        { pool, diskIds: selected.map(d => d.id), rotationalIds },
        updateProgress,
      ),
    )
    reply.code(202)
    return { job }
  })

  // ---- DELETE /ahr/:name/cache — detach -------------------------------------
  server.delete<{ Params: { name: string } }>('/ahr/:name/cache', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseExistingIntent(pool.name, reply))
      return

    // Nothing to detach. TWO things count as something: a live cache target,
    // and a `<pool>-cache<n>` slice still sitting on a disk with no cache
    // target above it — the leftover a died-and-returned cache device carries
    // back (§13). The second is why the test is not simply `state !== absent`:
    // that slice is the ONLY thing keeping the disk out of the inventory
    // (GT-22), and detach is the verb that deletes it.
    //
    // The test is on the CACHE, never on the pool's health: detaching a FAILED
    // cache IS the recovery, so a pool returning EIO on every read must reach
    // the job (`lvconvert --uncache` works with the device absent and the pool
    // mounted — GT-20).
    if (!pool.cache || (pool.cache.state === 'absent' && pool.cache.devices.length === 0)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${pool.name}' has no read cache to detach` } }
    }

    const job = jobQueue.submit(
      'ahr.cache.detach',
      { ...identity, params: { pool: pool.name } },
      async updateProgress => detachAhrCache(executor, { pool }, updateProgress),
    )
    reply.code(202)
    return { job }
  })
}
