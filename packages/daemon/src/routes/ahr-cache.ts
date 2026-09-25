import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { AhrCacheEventRequest, AttachAhrCacheRequest, isComposableDisk, PoolName } from '@anas/shared'
import { attachAhrCache, detachAhrCache, findCacheSlices, notifyCacheRecoveryFailed, recoverFailedAhrCache } from '../services/ahr-cache.js'
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

/** The cache verbs exclude each other AND themselves, per pool, at submit. */
const CACHE_EXCLUSIVE_OPERATIONS = ['ahr.cache.attach', 'ahr.cache.detach'] as const

/**
 * AHR read-cache routes (story ahrcache.1, docs/AHR-DESIGN.md §13/§4):
 *
 *   POST   /v1/ahr/:name/cache        — attach a writethrough read cache (202)
 *   DELETE /v1/ahr/:name/cache        — detach it (202 job)
 *   POST   /v1/ahr/:name/cache/event  — the udev hook reporting that a cache
 *                                       disk was removed; runs the automatic
 *                                       recovery as a job (202), or answers
 *                                       200 when there is nothing to recover
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
 *
 * Both also refuse while a cache job of EITHER verb is already in flight on the
 * pool, through the job queue's own record — the pattern the repair/scrub pair
 * uses. The queue runs four jobs at a time and there is no per-pool AHR lock,
 * so two attaches would interleave their detect-then-delta reads: the second
 * sees the slice the first just cut, decides its own delta from it, and on any
 * failure its rollback (the detach sequence) uncaches the cache the first one
 * had just made live.
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

  /**
   * 409 while another cache verb is in flight on this pool. `findActive` — not
   * `findByOperation`, which answers with the LATEST job of an operation
   * whatever its status and so lets a finished job hide a running one. The
   * queue is in memory, so after a daemon restart this honestly answers
   * "nothing in flight"; the verbs' own detect-then-delta steps are the
   * backstop, and no shadow state is introduced to paper over it.
   */
  function refuseCacheJobInFlight(pool: string, reply: FastifyReply): boolean {
    const active = jobQueue.findActive(CACHE_EXCLUSIVE_OPERATIONS, pool, 'pool')
    if (!active)
      return false
    reply.code(409).send({ error: {
      code: 'CONFLICT',
      message: `A cache ${active.operation === 'ahr.cache.attach' ? 'attach' : 'detach'} is already in flight on AHR pool '${pool}' (job ${active.id}). Wait for it to finish`,
    } })
    return true
  }

  /**
   * 409 while an expansion intent exists — the VG's shape is in flight. The
   * sentence after the dash names what the CALLER should do about it: attach
   * and detach can wait for the expansion, while the event route skips the
   * recovery and the rung comes round again on its own.
   */
  async function refuseExistingIntent(pool: string, reply: FastifyReply, consequence?: string): Promise<boolean> {
    const existing = await readIntent(pool, intentDir)
    if (existing) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool}' has an expansion intent (state '${existing.state}') — ${consequence ?? 'the cache can be changed once it completes or is abandoned'}.`,
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
    if (refuseCacheJobInFlight(pool.name, reply))
      return

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
    // Already cached: attaching a second cache to one LV is not a thing LVM
    // does, and silently no-op'ing would read as success. AFTER the state
    // check on purpose: an offline pool with a cache is refused for being
    // offline, because "detach it first" would send the operator nowhere.
    if (pool.cache && pool.cache.state !== 'absent') {
      reply.code(409)
      return { error: {
        code: 'CONFLICT',
        message: `AHR pool '${pool.name}' already has a read cache (${pool.cache.devices.join(', ') || 'device missing'}, ${fmtBytes(pool.cache.sizeBytes)}, state '${pool.cache.state}'). Detach it before attaching another`,
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
    if (refuseCacheJobInFlight(pool.name, reply))
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
    // An OFFLINE pool's volume is not assembled, and the cache is released by
    // `lvconvert --uncache`, which needs an active volume — the job would fail
    // on raw LVM stderr after the progress line said it was removing the cache.
    // Scoped to a LIVE cache target on purpose: a mere leftover `<pool>-cache<n>`
    // slice (§13's died-and-returned device) is handed back with `sgdisk -d`
    // alone, which asks nothing of LVM, so that detach still runs.
    if (pool.state === 'offline' && pool.cache.state !== 'absent') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${pool.name}' is offline: bring the pool online first — the cache is released by uncache, which needs an active volume. See the Hybrid RAID view for which band arrays cannot start` } }
    }

    const job = jobQueue.submit(
      'ahr.cache.detach',
      { ...identity, params: { pool: pool.name } },
      async updateProgress => detachAhrCache(executor, { pool }, updateProgress),
    )
    reply.code(202)
    return { job }
  })

  // ---- POST /ahr/:name/cache/event — the udev auto-uncache rung -------------
  /**
   * A disk carrying one of this pool's `<pool>-cache<n>` slices was REMOVED —
   * reported by `/usr/local/bin/anas-cache-event`, which a udev rule runs on
   * the slice's removal (slice 2, §13 "Resolved 2026-09-24"; the
   * `anas-md-event.sh` pattern, one level up: md's hook only logs and notifies,
   * this one has a repair to run and so has to reach the daemon).
   *
   * AN EVENT, NEVER A POLLER. dm-cache does not fall through to the origin
   * (GT-19): the instant the cache device goes, EVERY read on the pool returns
   * EIO within the second, promoted or not. A poller's interval would be the
   * length of the outage. udev knows in the same second the kernel does.
   *
   * AUTHENTICATION is the socket, exactly as for every other mutation
   * (Principle 9): `/run/anas/anasd.sock` is mode 0600 and owned by root, so a
   * caller that reached this handler is local root, and the X-Anas-* identity
   * headers are trusted BECAUSE of that. The event script sends the same
   * headers the systemd task runners send, under its own user string, so the
   * job's audit record names the rung that raised it rather than a person.
   *
   * THE BODY IS A REPORT, NOT A COMMAND. Nothing in it can make the daemon
   * uncache a healthy pool: the verdict comes from this node's own reads — the
   * pool's `cache.state` (dm-cache's own failure word, or the cache PV's device
   * gone under the band guard) and a fresh label sweep that finds no
   * `<pool>-cache<n>` slice left on any disk. The body only supplies the slice
   * LABEL, which is used to NAME the device in the notification once the disk
   * is gone and its by-id can no longer be resolved.
   *
   * IDEMPOTENT by construction: a second event on an already-uncached pool
   * finds `cache.state: 'absent'`, answers 200 with `recovered: false`, and
   * runs nothing. udev re-runs rules and a disk can generate several removal
   * events; neither may cost the pool a second job.
   */
  server.post<{ Params: { name: string } }>('/ahr/:name/cache/event', async (request, reply) => {
    const bodyParsed = AhrCacheEventRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid cache event: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return

    // The expansion-intent gate both verbs apply, for the same reason: the VG's
    // shape is in flight and the recovery's `vgreduce --removemissing` must not
    // run under it. The rung loses nothing by skipping — udev re-raises the
    // event (a removal can generate several) and the boot rung re-runs the
    // recovery at the next daemon start.
    if (await refuseExistingIntent(pool.name, reply, 'the automatic cache recovery is skipped; it re-runs on the next event or at the next daemon start'))
      return

    // A cache job already in flight IS the recovery (a detach submitted by the
    // operator a second earlier does the same three commands). Answering 409
    // rather than queueing a second one is the same rule both verbs follow, and
    // here it also absorbs the duplicate-event case the queue would otherwise
    // see as two distinct requests.
    if (refuseCacheJobInFlight(pool.name, reply))
      return

    // The verdict, from this node's own reads. Recovery needs evidence that the
    // cache is broken or its device gone, and there are two kinds:
    //
    //  1. `cache.state: 'failed'` — dm-cache reporting a failure word, an ACTIVE
    //     cache target whose `dmsetup status` cannot be read (the GT-23
    //     asymmetry in `buildAhrCacheState`), or the cache PV's device gone: an
    //     `[unknown]` PV in the VG while every band has its own named md PV.
    //  2. A cache target that still reads `healthy`, and NO disk left carrying
    //     one of the pool's `<pool>-cache<n>` slices (a fresh lsblk sweep).
    //
    // Why the second exists, and why `healthy` alone is not the answer: dm-cache
    // enters Fail only after an I/O on the cache device fails. A removal on an
    // IDLE pool therefore arrives while `dmsetup status` still prints healthy
    // counters; nothing raises the event again, and the pool returns EIO from
    // its first read. The event is itself the fact that a device went away, so
    // the verdict accepts "the slice's disk is gone" as evidence. When LVM has
    // already noticed, (1) catches it through the `[unknown]` PV; the sweep
    // covers the moment in which it has not.
    //
    // THE IDLE-PULL SHAPE IS NOT IN GT-19, which measured the removal under a
    // running read load (dm had already failed when the event arrived). The
    // stunt-node evaluation must cover it: attach a cache, run NO I/O, detach
    // the SSD, then issue the first read — the event must have uncached the
    // pool before that read, and the read must succeed.
    //
    // `inactive` is deliberately not in either kind: an inactive cached volume
    // is usually a band that did not assemble, and uncaching a partial VG is
    // not this rung's call (the boot rung and the operator own that shape).
    let recover = pool.cache?.state === 'failed'
    let cause: 'missing' | 'failed' = pool.cache?.deviceMissing === true ? 'missing' : 'failed'
    if (!recover && pool.cache?.state === 'healthy') {
      try {
        if ((await findCacheSlices(executor, pool.name)).length === 0) {
          recover = true
          cause = 'missing'
        }
      }
      catch (err) {
        // An unreadable sweep is no evidence either way: log it and answer on
        // what the pool read said. The boot rung re-checks at the next start.
        request.log.warn({ pool: pool.name, err: err instanceof Error ? err.message : String(err) }, 'ahr.cache event: label sweep unreadable')
      }
    }
    if (!recover) {
      reply.code(200)
      return { data: {
        pool: pool.name,
        recovered: false,
        cacheState: pool.cache?.state ?? 'absent',
        detail: `the read cache on AHR pool '${pool.name}' reads '${pool.cache?.state ?? 'absent'}' — nothing to recover`,
      } }
    }

    const job = jobQueue.submit(
      // The DETACH operation on purpose, not a third one: it is the same work,
      // and the in-flight guard above is keyed on the operation pair. A new
      // name would make an event and an operator detach invisible to each other.
      'ahr.cache.detach',
      { ...identity, params: { pool: pool.name, trigger: 'udev-device-removed' } },
      async (updateProgress) => {
        try {
          return await recoverFailedAhrCache(
            executor,
            { pool, sliceLabel: bodyParsed.data.slice ?? null, reason: 'failed' },
            updateProgress,
          )
        }
        catch (err) {
          // A FAILED auto-recovery is not silent: this rung runs with nobody at
          // a keyboard, so the failure is announced exactly as the boot rung
          // announces its own (parallel construction), and the job still fails
          // on the original error.
          await notifyCacheRecoveryFailed(executor, pool.name, 'udev', err instanceof Error ? err.message : String(err), cause)
          throw err
        }
      },
    )
    reply.code(202)
    return { job }
  })
}
