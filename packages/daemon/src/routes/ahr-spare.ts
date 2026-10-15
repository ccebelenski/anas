import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { GuardSpec } from '../safety/guard.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { AhrSpareRequest, DiskId, isComposableDisk, PoolName } from '@anas/shared'
import { guardCheck, guardConfirm, guarded, sendRefusal } from '../safety/guard.js'
import { projectExistingBands } from '../services/ahr-expand-exec.js'
import { ahrGuard } from '../services/ahr-guard.js'
import { fmtBytes } from '../services/ahr-layout.js'
import { attachSpare, removeSpare, spareCoverage, spareShortfallMessage } from '../services/ahr-spare.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

/** One inventory disk, as `collectDisks` lists it. */
type InventoryDisk = Awaited<ReturnType<typeof collectDisks>>[number]

/**
 * The fields the spare confirms leave out of their signature (story cr.38,
 * WAVE3-DESIGN §5.2 rule 1): none. A test lists them.
 */
export const AHR_SPARE_ADD_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_SPARE_REMOVE_PRESENTATION_ONLY: Record<string, string> = {}

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

  // ---- the guard (story cr.38 session A, WAVE3-DESIGN §2.3 "spare add /
  // remove": the intent gate was request-time only). One gate list per verb
  // at the route and again in the job; the job holds the pool's key
  // exclusive and the spare disk's key. No spare verb asks the LUN question,
  // so the guard's LIO reads stay unused.
  const guard = ahrGuard({ executor, intentDir, iscsiPaths: () => ({}) })

  /** 409 while an expansion intent exists — band geometry is in flight (this pool's intent only, ident.3). */
  const spareIntentGate = guard.intentGate('spares can be changed once it completes or is abandoned')

  /** Parse the pool-name param, or 400 → null (the guard's view answers the 404). */
  function parsePoolName(raw: string, reply: FastifyReply): string | null {
    const parsed = PoolName.safeParse(raw)
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return parsed.data
  }

  /** The pool plus the picked disk as the inventory reads it now (null: not in the inventory). */
  type SpareAddObject = AhrPool & { disk: InventoryDisk | null }

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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    const base = guard.poolView(poolName, 'a spare attach')
    const spec: GuardSpec<SpareAddObject> = {
      operation: 'ahr.spare.add',
      object: {
        ...base,
        read: async (reads) => {
          const pool = await base.read(reads)
          if (!pool)
            return null
          const inventory = await reads.once('inventory', () => collectDisks(executor, diskIdentityCache))
          return { ...pool, disk: inventory.find(d => d.id === diskId) ?? null }
        },
      },
      gates: [
        spareIntentGate,
        async (pool) => {
          const already = pool.disks.find(d => d.id === diskId)
          return already
            ? { status: 400, code: 'VALIDATION_ERROR', message: `disk '${diskId}' is already part of pool '${pool.name}' (role: ${already.role})` }
            : null
        },
        // Only an 'available' inventory disk may become a spare (GT-12: the
        // in-use/foreign-label exclusions are safety-critical).
        async ({ disk }) => {
          if (!disk)
            return { status: 400, code: 'VALIDATION_ERROR', message: `disk '${diskId}' not found in the inventory` }
          if (!isComposableDisk(disk)) {
            return { status: 400, code: 'VALIDATION_ERROR', message: disk.handsOff
              ? `disk '${diskId}' is hands-off: ${disk.handsOffReason ?? disk.handsOff}`
              : `disk '${diskId}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})` }
          }
          return null
        },
        // §11 full-coverage rule: usable (rounded) ≥ the pool's top array
        // boundary — a partial spare is refused with the EXACT shortfall.
        async (pool) => {
          let topBoundaryBytes: number
          try {
            const bands = projectExistingBands(pool)
            if (bands.length === 0)
              throw new Error(`pool '${pool.name}' has no band arrays`)
            topBoundaryBytes = bands.at(-1)!.endBytes
          }
          catch (err) {
            return { status: 400, code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) }
          }
          const coverage = spareCoverage(topBoundaryBytes, pool.disk!.size)
          return coverage.ok ? null : { status: 400, code: 'VALIDATION_ERROR', message: spareShortfallMessage(diskId, coverage) }
        },
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { disks: [diskId] }),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object
    const disk = pool.disk!

    // Confirm gate (Principle 14): the concrete consequence — THIS disk is
    // wiped — plus what the spare buys and any slot hygiene that runs first.
    const bandCount = pool.arrays.length
    const hasFaulty = pool.arrays.some(a => a.members.some(m => m.memberState === 'faulty'))
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, diskId },
      address: ['pool'],
      presentationOnly: AHR_SPARE_ADD_PRESENTATION_ONLY,
      message: `Attaching '${diskId}' as a hot spare to pool '${pool.name}' WIPES the disk`,
      warnings: [
        `${diskId} (${disk.model ?? 'unknown model'}, ${fmtBytes(disk.size)}) will be completely erased and partitioned with the pool's band geometry`,
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
      { ...identity, params: { pool: poolName, diskId } },
      // The pool and the disk as the JOB read them. diskCache: the service
      // re-checks the disk is STILL available right before it wipes it
      // (ident.3 (a)) — a second line behind the gate the guard just re-ran.
      guarded(spec, pre, async (live, { updateProgress }) => attachSpare(executor, { pool: live, diskId, diskSizeBytes: live.disk!.size }, updateProgress, { diskCache: diskIdentityCache })),
      { locks: pre.locks },
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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.spare.remove',
      object: guard.poolView(poolName, 'a spare removal'),
      gates: [
        spareIntentGate,
        async pool => pool.disks.some(d => d.id === diskId)
          ? null
          : { status: 404, code: 'NOT_FOUND', message: `disk '${diskId}' is not part of pool '${pool.name}'` },
        // Story ident.3 (c): a slice md has put to work is a MEMBER, whatever
        // the disk was attached as — a spare that took over a rebuild carries
        // data now, and "removing the spare" would fail a live member out of
        // its band. The (S) flag on an active array is the only truth (the
        // role is fused from it, so a half-consumed spare reads `member` too).
        // 409: the request is well-formed, the pool's state refuses it. The
        // service asks md again.
        async (pool) => {
          const disk = pool.disks.find(d => d.id === diskId)!
          const activeIn = pool.arrays
            .filter(a => a.state !== 'inactive' && a.members.some(m => m.disk === diskId && m.memberState !== 'spare' && m.memberState !== 'faulty'))
            .map(a => `${pool.name}-r${a.band}`)
          return disk.role !== 'spare' || activeIn.length > 0
            ? { status: 409, code: 'CONFLICT', message: `disk '${diskId}' is an active MEMBER of pool '${pool.name}'${activeIn.length > 0 ? ` (${activeIn.join(', ')})` : ''}, not a spare: a spare that took over a rebuild carries data. Members leave only through Replace` }
            : null
        },
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { disks: [diskId] }),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object

    const remaining = pool.disks.filter(d => d.role === 'spare' && d.id !== diskId).length
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, diskId },
      address: ['pool', 'diskId'],
      presentationOnly: AHR_SPARE_REMOVE_PRESENTATION_ONLY,
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
      { ...identity, params: { pool: poolName, diskId } },
      guarded(spec, pre, async (live, { updateProgress }) => removeSpare(executor, { pool: live, diskId }, updateProgress)),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })
}
