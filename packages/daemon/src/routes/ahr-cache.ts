import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { Gate, GuardReads, GuardSpec } from '../safety/guard.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { AhrCacheEventRequest, AttachAhrCacheRequest, isComposableDisk, PoolName } from '@anas/shared'
import { guardCheck, guarded, sendRefusal } from '../safety/guard.js'
import { attachAhrCache, detachAhrCache, findCacheSlices, notifyCacheRecoveryFailed, recoverFailedAhrCache } from '../services/ahr-cache.js'
import { ahrGuard } from '../services/ahr-guard.js'
import { requirePoolVg } from '../services/ahr-identity.js'
import { fmtBytes } from '../services/ahr-layout.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

export interface AhrCacheRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  diskIdentityCache: DiskIdentityCache
  /** AhrExpansionIntent store directory (both verbs refuse mid-expansion). */
  intentDir: string
}

const BLKID = '/usr/sbin/blkid'

/** One `KEY="value"` pair of a `blkid -p` line — the signature it names (TYPE, PTTYPE, …). */
const SIGNATURE_RE = /\b(TYPE|PTTYPE|USAGE)="([^"]*)"/g

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

  // ---- the guard (story cr.38 session A, WAVE3-DESIGN §2.3 "cache attach"
  // and "cache detach / event": intent and state were request-time only;
  // attach never re-checked a disk and changed the VG without `requirePoolVg`).
  // Each verb runs one gate list at the route and again in the job, and each
  // job holds the pool's key exclusive (§4.2) plus every disk it writes. The
  // in-flight answer below stays a request-time courtesy: two cache jobs on
  // one pool now also serialise on that key, and the second one's re-run
  // gates see what the first did.
  // No cache verb asks the LUN question, so the guard's LIO reads stay unused.
  const guard = ahrGuard({ executor, intentDir, iscsiPaths: () => ({}) })

  /** Parse the pool-name param, or 400 → null (the guard's view answers the 404). */
  function parsePoolName(raw: string, reply: FastifyReply): string | null {
    const parsed = PoolName.safeParse(raw)
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return parsed.data
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
   * THE VG IS THE POOL'S (cr.22 finding 3, applied to attach by cr.38): the
   * attach `vgextend`s the VG named like the pool, which is only right when
   * that VG is provably the pool's — a named PV that is one of its band
   * arrays. A same-named VG moved in from another node, or PVE's own, refuses
   * before a slice is cut. Fail closed: an unreadable `pvs`/`vgs` refuses.
   */
  const poolVgGate: Gate<AhrPool> = async (pool) => {
    try {
      await requirePoolVg(executor, pool.name, { arrays: pool.arrays.map(a => ({ pool: pool.name, band: a.band, kernelName: a.kernelName })) })
      return null
    }
    catch (err) {
      return { status: 409, code: 'CONFLICT', reason: 'foreign-vg', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The attach's disk pick, judged against the inventory and the pool read NOW. */
  interface CachePick {
    selected: { id: string, size: number, model: string | null, rotational: boolean }[]
    /** The picked disks that carry this pool's own leftover `<pool>-cache<n>` slice (§13). */
    reclaimable: string[]
    problems: string[]
  }
  type AttachObject = AhrPool & { pick: CachePick }

  /**
   * Resolve every requested disk. A LEFTOVER slice of THIS pool's own cache,
   * on a pool that has no cache any more, is the `<pool>-cache<n>` slice of a
   * device that died and has since come back (it returns carrying an outdated
   * PV label — §13). The disk reads `ahr_member`/`cache` because of that
   * slice, so both the already-in-the-pool test and `isComposableDisk` would
   * refuse it, and the operator would have no product path back to a disk
   * ANAS itself marked. Re-attaching to it is exactly the right move:
   * `ensureCachePv` reuses the slice and `wipefs -a`s the stale signature off
   * it before `pvcreate`. Otherwise only 'available' inventory disks may
   * become a cache (GT-12: the in-use/foreign-label exclusions are
   * safety-critical, not cosmetic).
   */
  async function pickCacheDisks(pool: AhrPool, requestedIds: string[], reads: GuardReads): Promise<CachePick> {
    const reclaimable = new Set(pool.cache?.state === 'absent' ? pool.cache.devices : [])
    const inventory = await reads.once('inventory', () => collectDisks(executor, diskIdentityCache))
    const problems: string[] = []
    const selected: CachePick['selected'] = []
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
    return { selected, reclaimable: requestedIds.filter(id => reclaimable.has(id)), problems }
  }

  /**
   * THE SIGNATURE GATE (cr.38, §2.3 "cache attach refuses a disk with any
   * signature"). The inventory's `available` comes from lsblk, which reads
   * udev's cached probe; `blkid -p` probes the device itself, so a filesystem,
   * RAID or partition-table signature udev has not reported yet still stops
   * the wipe. Captured semantics (BACKUP-RESTORE-GROUND-TRUTH, `blkid -p`):
   * exit 0 with a `KEY="value"` line = a signature; exit 2 and no output =
   * none. Anything else is unreadable and refuses (fail closed). A reclaimed
   * leftover slice's disk is exempt: its GPT carrying the pool's own slice is
   * the reason it was picked.
   *
   * A partition table ALONE (`PTTYPE`, no content `TYPE`) is not refused: it
   * is what ANAS's own detach leaves behind (the slice deleted from the GPT,
   * GT-22), and the inventory calls that disk available — refusing it would
   * make attach → detach → attach impossible without a hand wipe. The
   * attach's own first step re-reads the table and refuses one that still
   * has a partition ("refusing to partition a disk that is not empty").
   */
  async function signatureProblems(pick: CachePick, reads: GuardReads): Promise<{ problems: string[] } | { unreadable: string }> {
    const problems: string[] = []
    for (const disk of pick.selected) {
      if (pick.reclaimable.includes(disk.id))
        continue
      const dev = `/dev/disk/by-id/${disk.id}`
      const res = await reads.once(`blkid:${disk.id}`, () => executor.exec(BLKID, ['-p', dev]))
      if (res.exitCode === 2)
        continue
      if (res.exitCode !== 0)
        return { unreadable: `could not probe '${disk.id}' for signatures (blkid exited ${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim().split('\n')[0]}` : ''})` }
      const pairs = Array.from(res.stdout.matchAll(SIGNATURE_RE), m => [m[1], m[2]] as const)
      if (pairs.length > 0 && pairs.every(([key]) => key === 'PTTYPE'))
        continue
      const found = pairs.map(([key, value]) => `${key}=${value}`)
      problems.push(`disk '${disk.id}' carries a signature (${found.join(', ') || res.stdout.trim()}) that the inventory did not show — clear it first if the disk is really free`)
    }
    return { problems }
  }

  /** The intent gate's sentence for the operator verbs. */
  const cacheIntentGate = guard.intentGate('the cache can be changed once it completes or is abandoned')

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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    const base = guard.poolView(poolName, 'a cache attach')
    const spec: GuardSpec<AttachObject> = {
      operation: 'ahr.cache.attach',
      object: {
        ...base,
        read: async (reads) => {
          const pool = await base.read(reads)
          return pool ? { ...pool, pick: await pickCacheDisks(pool, requestedIds, reads) } : null
        },
      },
      gates: [
        cacheIntentGate,
        // A pool whose volume is not assembled has nothing to put a cache in
        // front of, and `lvconvert` would fail on an inactive LV after the
        // disks were already sliced.
        async pool => pool.state === 'offline' || pool.state === 'failed'
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' is ${pool.state}: its volume is not assembled, so there is nothing to cache. See the Hybrid RAID view` }
          : null,
        // Already cached: attaching a second cache to one LV is not a thing LVM
        // does, and silently no-op'ing would read as success. AFTER the state
        // check on purpose: an offline pool with a cache is refused for being
        // offline, because "detach it first" would send the operator nowhere.
        async pool => pool.cache && pool.cache.state !== 'absent'
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' already has a read cache (${pool.cache.devices.join(', ') || 'device missing'}, ${fmtBytes(pool.cache.sizeBytes)}, state '${pool.cache.state}'). Detach it before attaching another` }
          : null,
        async pool => pool.pick.problems.length > 0
          ? { status: 400, code: 'VALIDATION_ERROR', message: `Ineligible cache disk selection: ${pool.pick.problems.join('; ')}` }
          : null,
        async (pool, reads) => {
          const check = await signatureProblems(pool.pick, reads)
          if ('unreadable' in check)
            return { status: 409, code: 'CONFLICT', reason: 'unreadable', message: `${check.unreadable}; refusing to wipe a disk it cannot probe` }
          return check.problems.length > 0
            ? { status: 400, code: 'VALIDATION_ERROR', message: `Ineligible cache disk selection: ${check.problems.join('; ')}` }
            : null
        },
        poolVgGate,
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { disks: requestedIds }),
    }
    // A request-time courtesy (the lock is what serialises), asked before the
    // pool is read so a busy pool answers at once.
    if (refuseCacheJobInFlight(poolName, reply))
      return
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'ahr.cache.attach',
      { ...identity, params: { pool: poolName, disks: pre.object.pick.selected.map(d => d.id) } },
      // The pool and the pick as the JOB read them. The ONE advisory a
      // rotating pick earns — stated as a fact, then dropped — rides the job
      // RESULT's `warnings` (backup.repo.update's idiom: the 202 body is
      // `{ job }` and nothing else, by schema).
      guarded(spec, pre, async (live, { updateProgress }) => attachAhrCache(
        executor,
        {
          pool: live,
          diskIds: live.pick.selected.map(d => d.id),
          rotationalIds: live.pick.selected.filter(d => d.rotational).map(d => d.id),
        },
        updateProgress,
      )),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // ---- DELETE /ahr/:name/cache — detach -------------------------------------
  server.delete<{ Params: { name: string } }>('/ahr/:name/cache', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.cache.detach',
      object: guard.poolView(poolName, 'a cache detach'),
      gates: [
        cacheIntentGate,
        // Nothing to detach. TWO things count as something: a live cache
        // target, and a `<pool>-cache<n>` slice still sitting on a disk with
        // no cache target above it — the leftover a died-and-returned cache
        // device carries back (§13). The second is why the test is not simply
        // `state !== absent`: that slice is the ONLY thing keeping the disk out
        // of the inventory (GT-22), and detach is the verb that deletes it.
        //
        // The test is on the CACHE, never on the pool's health: detaching a
        // FAILED cache IS the recovery, so a pool returning EIO on every read
        // must reach the job (`lvconvert --uncache` works with the device
        // absent and the pool mounted — GT-20).
        async pool => !pool.cache || (pool.cache.state === 'absent' && pool.cache.devices.length === 0)
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' has no read cache to detach` }
          : null,
        // An OFFLINE pool's volume is not assembled, and the cache is released
        // by `lvconvert --uncache`, which needs an active volume. Scoped to a
        // LIVE cache target on purpose: a mere leftover slice is handed back
        // with `sgdisk -d` alone, which asks nothing of LVM.
        async pool => pool.state === 'offline' && pool.cache && pool.cache.state !== 'absent'
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' is offline: bring the pool online first — the cache is released by uncache, which needs an active volume. See the Hybrid RAID view for which band arrays cannot start` }
          : null,
      ],
      // The cache disks lose their slice: their `disk:` keys with the pool's.
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { disks: pool.cache?.devices ?? [] }),
    }
    if (refuseCacheJobInFlight(poolName, reply))
      return
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'ahr.cache.detach',
      { ...identity, params: { pool: poolName } },
      guarded(spec, pre, async (live, { updateProgress }) => detachAhrCache(executor, { pool: live }, updateProgress)),
      { locks: pre.locks },
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
   * A JOB WITH ITS KEYS (cr.38, §4.4 "work outside the queue"): the recovery
   * is submitted like every other AHR verb — the pool's key exclusive, the
   * intent gate re-run in the job, and the verdict asked AGAIN against the
   * pool the job reads, so a cache an operator detached (or re-attached
   * healthy) while the event waited is never uncached on stale evidence.
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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    // The expansion-intent gate both verbs apply, for the same reason: the VG's
    // shape is in flight and the recovery's `vgreduce --removemissing` must not
    // run under it. The rung loses nothing by skipping — udev re-raises the
    // event (a removal can generate several) and the boot rung re-runs the
    // recovery at the next daemon start.
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.cache.detach',
      object: guard.poolView(poolName, 'a cache recovery'),
      gates: [guard.intentGate('the automatic cache recovery is skipped; it re-runs on the next event or at the next daemon start')],
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // A cache job already in flight IS the recovery (a detach submitted by the
    // operator a second earlier does the same three commands). Answering 409
    // rather than queueing a second one is the same rule both verbs follow, and
    // here it also absorbs the duplicate-event case the queue would otherwise
    // see as two distinct requests.
    if (refuseCacheJobInFlight(poolName, reply))
      return

    const verdict = await cacheRecoveryVerdict(pre.object, (err) => {
      // An unreadable sweep is no evidence either way: log it and answer on
      // what the pool read said. The boot rung re-checks at the next start.
      request.log.warn({ pool: poolName, err: err instanceof Error ? err.message : String(err) }, 'ahr.cache event: label sweep unreadable')
    })
    if (!verdict.recover) {
      reply.code(200)
      return { data: nothingToRecover(pre.object) }
    }

    const job = jobQueue.submit(
      // The DETACH operation on purpose, not a third one: it is the same work,
      // and the in-flight guard above is keyed on the operation pair. A new
      // name would make an event and an operator detach invisible to each other.
      'ahr.cache.detach',
      { ...identity, params: { pool: poolName, trigger: 'udev-device-removed' } },
      guarded(spec, pre, async (live, { updateProgress }) => {
        // The verdict again, on the pool as the job read it.
        const now = await cacheRecoveryVerdict(live, () => {})
        if (!now.recover)
          return nothingToRecover(live)
        try {
          return await recoverFailedAhrCache(
            executor,
            { pool: live, sliceLabel: bodyParsed.data.slice ?? null, reason: 'failed' },
            updateProgress,
          )
        }
        catch (err) {
          // A FAILED auto-recovery is not silent: this rung runs with nobody at
          // a keyboard, so the failure is announced exactly as the boot rung
          // announces its own (parallel construction), and the job still fails
          // on the original error.
          await notifyCacheRecoveryFailed(executor, live.name, 'udev', err instanceof Error ? err.message : String(err), now.cause)
          throw err
        }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  /** The event's "nothing to recover" answer (the route's 200 body and the job's result). */
  function nothingToRecover(pool: AhrPool) {
    return {
      pool: pool.name,
      recovered: false,
      cacheState: pool.cache?.state ?? 'absent',
      detail: `the read cache on AHR pool '${pool.name}' reads '${pool.cache?.state ?? 'absent'}' — nothing to recover`,
    }
  }

  /**
   * The verdict, from this node's own reads. Recovery needs evidence that the
   * cache is broken or its device gone, and there are two kinds:
   *
   *  1. `cache.state: 'failed'` — dm-cache reporting a failure word, an ACTIVE
   *     cache target whose `dmsetup status` cannot be read (the GT-23
   *     asymmetry in `buildAhrCacheState`), or the cache PV's device gone: an
   *     `[unknown]` PV in the VG while every band has its own named md PV.
   *  2. A cache target that still reads `healthy`, and NO disk left carrying
   *     one of the pool's `<pool>-cache<n>` slices (a fresh lsblk sweep).
   *
   * Why the second exists, and why `healthy` alone is not the answer: dm-cache
   * enters Fail only after an I/O on the cache device fails. A removal on an
   * IDLE pool therefore arrives while `dmsetup status` still prints healthy
   * counters; nothing raises the event again, and the pool returns EIO from
   * its first read. The event is itself the fact that a device went away, so
   * the verdict accepts "the slice's disk is gone" as evidence. When LVM has
   * already noticed, (1) catches it through the `[unknown]` PV; the sweep
   * covers the moment in which it has not.
   *
   * THE IDLE-PULL SHAPE IS NOT IN GT-19, which measured the removal under a
   * running read load (dm had already failed when the event arrived). The
   * stunt-node evaluation must cover it: attach a cache, run NO I/O, detach
   * the SSD, then issue the first read — the event must have uncached the
   * pool before that read, and the read must succeed.
   *
   * `inactive` is deliberately not in either kind: an inactive cached volume
   * is usually a band that did not assemble, and uncaching a partial VG is
   * not this rung's call (the boot rung and the operator own that shape).
   */
  async function cacheRecoveryVerdict(pool: AhrPool, onSweepError: (err: unknown) => void): Promise<{ recover: boolean, cause: 'missing' | 'failed' }> {
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
        onSweepError(err)
      }
    }
    return { recover, cause }
  }
}
