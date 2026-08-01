import type { AhrExpansionIntent, AhrPool, AhrReplacePair } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { PlanBundle } from '../services/ahr-expand-resume.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { randomUUID } from 'node:crypto'
import { AhrExpandRequest, AhrReplaceRequest, DiskId, PoolName } from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { executeReadd } from '../services/ahr-expand-exec.js'
// The §5.3 recompute-and-continue core is shared with the daemon boot scan
// (services/ahr-boot-scan.ts) — ONE implementation, no drift (single source).
import { computePlan, resolveApproved, resumeExpansion, submitExpansion } from '../services/ahr-expand-resume.js'
import { AhrIntentConflictError, clearIntent, readIntent, writeIntent } from '../services/ahr-intent.js'
import { AhrPlanError, fmtBytes } from '../services/ahr-layout.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { requireIdentity } from './identity.js'

export interface AhrExpandRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  diskIdentityCache: DiskIdentityCache
  /** AhrExpansionIntent store directory (§5.3 — the ONLY persisted state). */
  intentDir: string
}

/**
 * AHR expansion routes (Epic 11.6, docs/AHR-DESIGN.md §4/§5) — the mutation
 * surface of online growth:
 *
 *   POST /v1/ahr/:name/expand/plan       — compute before → after, NO mutation
 *   POST /v1/ahr/:name/expand            — execute (202 job / 409 confirm)
 *   POST /v1/ahr/:name/expand/resume     — recompute-and-continue a halted one
 *   POST /v1/ahr/:name/expand/abandon    — drop the intent, keep the layout
 *   POST /v1/ahr/:name/disk/:id/replace  — guided single-disk replace
 *
 * The §2.3 planner owns every layout decision; these routes only project the
 * live pool into its inputs, gate the dangerous transitions (§4 pre-checks +
 * Principle-14 confirms), persist the one intent record, and hand the plan to
 * the step executor as a job. Registered beside the read layer (routes/ahr.ts)
 * and the create/destroy/scrub routes (routes/ahr-mutate.ts).
 */
export async function ahrExpansionRoutes(server: FastifyInstance, opts: AhrExpandRouteOptions) {
  const { executor, jobQueue, confirmStore, diskIdentityCache, intentDir } = opts

  // ---- shared helpers ------------------------------------------------------

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
   * Disk ids currently serving any band array of the pool. Spare slices
   * (mdstat `(S)`, §11) are NOT membership: a hot spare never enters the
   * approved disk set and never counts toward band member totals.
   */
  function memberIds(pool: AhrPool): Set<string> {
    const out = new Set<string>()
    for (const arr of pool.arrays) {
      for (const m of arr.members) {
        if (m.memberState !== 'spare')
          out.add(m.disk)
      }
    }
    return out
  }

  /**
   * Validate an expand request body against the pool and produce the plan
   * inputs. Sends the error response and returns null on any refusal.
   */
  async function prepareExpand(
    pool: AhrPool,
    body: AhrExpandRequest,
    reply: FastifyReply,
  ): Promise<{ bundle: PlanBundle, approvedIds: string[], replace?: AhrReplacePair } | null> {
    const members = memberIds(pool)
    const problems: string[] = []
    const approvedIds = new Set(members)
    if (body.replace) {
      if (!members.has(body.replace.oldDiskId))
        problems.push(`disk '${body.replace.oldDiskId}' is not a member of pool '${pool.name}'`)
      if (members.has(body.replace.newDiskId))
        problems.push(`replacement disk '${body.replace.newDiskId}' is already a member of pool '${pool.name}'`)
      approvedIds.delete(body.replace.oldDiskId)
      approvedIds.add(body.replace.newDiskId)
    }
    for (const id of body.addDisks ?? []) {
      if (members.has(id))
        problems.push(`disk '${id}' is already a member of pool '${pool.name}'`)
      approvedIds.add(id)
    }
    if (problems.length > 0) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: problems.join('; ') } })
      return null
    }
    const { approved, problems: diskProblems } = await resolveApproved(executor, diskIdentityCache, pool, [...approvedIds], true)
    if (diskProblems.length > 0) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: diskProblems.join('; ') } })
      return null
    }
    try {
      const replaced = body.replace ? { oldDiskId: body.replace.oldDiskId, newDiskId: body.replace.newDiskId } : undefined
      return { bundle: computePlan(pool, approved, replaced), approvedIds: [...approvedIds], replace: body.replace }
    }
    catch (err) {
      if (err instanceof AhrPlanError) {
        // Planner refusals (incl. the §2.5 size pre-check) surface VERBATIM.
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
        return null
      }
      throw err
    }
  }

  /** §4 pre-check: never start a reshape on a degraded/failed/readonly pool. */
  function refuseDegraded(pool: AhrPool, reply: FastifyReply): boolean {
    const badArray = pool.arrays.find(a => a.state === 'degraded' || a.state === 'failed')
    if (badArray || pool.state === 'failed' || pool.state === 'readonly') {
      const what = badArray
        ? `array ${pool.name}-r${badArray.band} is ${badArray.state}`
        : `pool '${pool.name}' is ${pool.state}`
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Cannot expand: ${what}. Reshaping a degraded pool voluntarily enters the double-failure window (§4) — replace/rebuild first. This refusal has no confirm bypass.`,
      } })
      return true
    }
    return false
  }

  /** 409 when an expansion intent already exists for the pool. */
  async function refuseExistingIntent(pool: string, reply: FastifyReply): Promise<boolean> {
    const existing = await readIntent(pool, intentDir)
    if (existing) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool}' already has an expansion intent (state '${existing.state}') — Resume or Abandon it first.`,
      } })
      return true
    }
    return false
  }

  /** The Principle-14 confirm warnings for an expansion/replace. */
  function expansionWarnings(bundle: PlanBundle): string[] {
    const { before, after, plan } = bundle
    const pendingDelta = after.pendingBytes - before.pendingBytes
    return [
      `Usable capacity ${fmtBytes(before.usableBytes)} → ${fmtBytes(after.usableBytes)}${
        pendingDelta > 0 ? `; ${fmtBytes(after.pendingBytes)} of capacity will be PENDING (physically present but locked — see below).` : '.'}`,
      'The pool stays ONLINE during the reshape, but performance is reduced; on large arrays a reshape takes hours to DAYS.',
      'Do NOT remove disks while the expansion runs. Power loss is survivable (md checkpoints and resumes); pulling disks is not.',
      'A reshape cannot be cleanly cancelled once started.',
      ...plan.preview.warnings,
    ]
  }

  function buildIntent(bundle: PlanBundle, approvedIds: string[], replace?: AhrReplacePair): AhrExpansionIntent {
    return {
      id: randomUUID(),
      trigger: replace ? 'replace-disk' : 'add-disk',
      approvedDisks: approvedIds,
      ...(replace ? { replacedDisk: replace.oldDiskId, replacementDisk: replace.newDiskId } : {}),
      before: bundle.before,
      after: bundle.after,
      state: 'running',
    }
  }

  /** Deps for the shared expansion-driving job submitter. */
  const expansionDeps = { executor, jobQueue, intentDir }

  // ---- POST /ahr/:name/expand/plan — NO mutation ---------------------------
  server.post<{ Params: { name: string } }>('/ahr/:name/expand/plan', async (request, reply) => {
    const bodyParsed = AhrExpandRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid expand request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    const prepared = await prepareExpand(pool, bodyParsed.data, reply)
    if (!prepared)
      return
    const { bundle } = prepared
    return { data: {
      before: bundle.before,
      after: bundle.after,
      steps: bundle.plan.steps,
      warnings: bundle.plan.preview.warnings,
      // The resulting band layout — the wizard renders the same banded disk
      // bars as the create composer (§6.3 before→after visualization).
      bands: bundle.plan.preview.bands,
    } }
  })

  // ---- POST /ahr/:name/expand — execute (202 / 409 confirm) ----------------
  server.post<{ Params: { name: string } }>('/ahr/:name/expand', async (request, reply) => {
    const bodyParsed = AhrExpandRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid expand request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const body = bodyParsed.data
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (refuseDegraded(pool, reply))
      return
    if (await refuseExistingIntent(pool.name, reply))
      return
    // The plan is ALWAYS recomputed server-side — a client-side plan is a
    // preview, never an input.
    const prepared = await prepareExpand(pool, body, reply)
    if (!prepared)
      return
    const { bundle, approvedIds, replace } = prepared

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.expand',
      params: { pool: pool.name, addDisks: body.addDisks ?? [], replace: replace ?? null },
      message: `Expanding AHR pool '${pool.name}' starts an online reshape`,
      warnings: expansionWarnings(bundle),
    })) {
      return reply
    }

    const intent = buildIntent(bundle, approvedIds, replace)
    try {
      await writeIntent(pool.name, intent, { dir: intentDir, expect: 'absent' })
    }
    catch (err) {
      if (err instanceof AhrIntentConflictError) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: err.message } }
      }
      throw err
    }
    const job = submitExpansion(expansionDeps, {
      pool,
      bundle,
      intent,
      identity,
      operation: 'ahr.expand',
      params: { pool: pool.name, addDisks: body.addDisks ?? [], replace: replace ?? null },
      replace,
    })
    reply.code(202)
    return { job }
  })

  // ---- POST /ahr/:name/expand/resume — recompute-and-continue --------------
  server.post<{ Params: { name: string } }>('/ahr/:name/expand/resume', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    const intent = await readIntent(pool.name, intentDir)
    if (!intent || intent.state !== 'halted') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: intent
        ? `Pool '${pool.name}' has an expansion intent in state '${intent.state}' — only a halted expansion can be resumed.`
        : `Pool '${pool.name}' has no halted expansion to resume.` } }
    }

    // §5.3 recompute-and-continue via the SHARED resume core (identical to the
    // daemon boot-time re-attach path). Fail-closed reasons map to the
    // same HTTP codes/messages this route has always returned.
    const result = await resumeExpansion({
      pool,
      intent,
      executor,
      jobQueue,
      diskCache: diskIdentityCache,
      intentDir,
      identity,
    })
    if (!result.ok) {
      // A planner refusal (incl. the §2.5 size pre-check) is a 400; a missing
      // disk or an intent-store conflict is a 409 — unchanged surface.
      reply.code(result.reason === 'plan-error' ? 400 : 409)
      return { error: { code: result.reason === 'plan-error' ? 'VALIDATION_ERROR' : 'CONFLICT', message: result.message } }
    }
    reply.code(202)
    return { job: result.job }
  })

  // ---- POST /ahr/:name/expand/abandon — keep the layout, drop the intent ---
  server.post<{ Params: { name: string } }>('/ahr/:name/expand/abandon', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    const intent = await readIntent(pool.name, intentDir)
    if (!intent) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Pool '${pool.name}' has no expansion intent to abandon.` } }
    }
    if (intent.state === 'running') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Pool '${pool.name}' has an expansion currently being driven — it can only be abandoned once halted.` } }
    }

    const layout = pool.arrays.map(a => `${pool.name}-r${a.band} ${a.level}×${a.members.length}`).join(', ')
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.expand.abandon',
      params: { pool: pool.name, intent: intent.id },
      message: `Abandon the halted expansion of pool '${pool.name}'`,
      warnings: [
        `The pool KEEPS its current reachable layout — nothing is rolled back at the block layer.`,
        `Current layout: ${layout}; usable ${fmtBytes(pool.capacity.usableBytes)}${pool.capacity.pendingBytes > 0 ? `, ${fmtBytes(pool.capacity.pendingBytes)} pending` : ''}.`,
        `Steps that already completed (grown arrays, added capacity) remain in effect; the remaining steps simply never run.`,
        `The approved disk set (${intent.approvedDisks.join(', ')}) is forgotten.`,
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit('ahr.expand.abandon', { ...identity, params: { pool: pool.name, intent: intent.id } }, async (updateProgress) => {
      updateProgress(`Abandoning expansion intent ${intent.id}`)
      await clearIntent(pool.name, intentDir)
      return { abandoned: pool.name }
    })
    reply.code(202)
    return { job }
  })

  // ---- POST /ahr/:name/disk/:oldId/replace — guided replace ----------------
  server.post<{ Params: { name: string, oldId: string } }>('/ahr/:name/disk/:oldId/replace', async (request, reply) => {
    const oldParsed = DiskId.safeParse(request.params.oldId)
    if (!oldParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid disk id: ${oldParsed.error.issues[0]?.message}` } }
    }
    const bodyParsed = AhrReplaceRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid replace request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseExistingIntent(pool.name, reply))
      return

    const replace: AhrReplacePair = { oldDiskId: oldParsed.data, newDiskId: bodyParsed.data.newDiskId }
    // prepareExpand validates membership + availability and runs the §2.5
    // size pre-check via the planner (its refusal surfaces verbatim as 400).
    const prepared = await prepareExpand(pool, { replace }, reply)
    if (!prepared)
      return
    const { bundle, approvedIds } = prepared

    const bands = pool.arrays.filter(a => a.members.some(m => m.disk === replace.oldDiskId)).map(a => a.band)
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.replace',
      params: { pool: pool.name, oldDiskId: replace.oldDiskId, newDiskId: replace.newDiskId },
      message: `Replacing disk '${replace.oldDiskId}' in pool '${pool.name}'`,
      warnings: [
        `Every band of ${replace.oldDiskId} (band${bands.length === 1 ? '' : 's'} ${bands.join(', ')}) is copied onto ${replace.newDiskId} at rebuild speed — hours on large disks. The pool stays online and fully redundant throughout (live copy via mdadm --replace).`,
        'Do NOT remove either disk until the replace completes.',
        ...expansionWarnings(bundle),
        `Afterwards ${replace.oldDiskId} is retired (md superblocks zeroed, partition table zapped) — only if it is still present and healthy; a dead disk is left alone.`,
      ],
    })) {
      return reply
    }

    const intent = buildIntent(bundle, approvedIds, replace)
    try {
      await writeIntent(pool.name, intent, { dir: intentDir, expect: 'absent' })
    }
    catch (err) {
      if (err instanceof AhrIntentConflictError) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: err.message } }
      }
      throw err
    }
    const job = submitExpansion(expansionDeps, {
      pool,
      bundle,
      intent,
      identity,
      operation: 'ahr.replace',
      params: { pool: pool.name, oldDiskId: replace.oldDiskId, newDiskId: replace.newDiskId },
      replace,
    })
    reply.code(202)
    return { job }
  })

  // ---- POST /ahr/:name/disk/:id/readd — the returned-disk verb (11.9) ------
  server.post<{ Params: { name: string, id: string } }>('/ahr/:name/disk/:id/readd', async (request, reply) => {
    const idParsed = DiskId.safeParse(request.params.id)
    if (!idParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid disk id: ${idParsed.error.issues[0]?.message}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    // Never interleave a member rejoin with a running/halted expansion.
    if (await refuseExistingIntent(pool.name, reply))
      return
    if (pool.arrays.some(a => a.sync?.action === 'reshape')) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `pool '${pool.name}' is reshaping — wait for the reshape to finish before re-adding a member` } }
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.readd',
      params: { pool: pool.name, diskId: idParsed.data },
      message: `Re-adding disk '${idParsed.data}' to pool '${pool.name}'`,
      warnings: [
        'With the write-intent bitmap this is a fast differential catch-up (only regions written while the disk was away).',
        'If md refuses the shortcut (stale member), it falls back to a FULL rebuild of that slice — redundancy is only restored when the rebuild completes.',
        'Do NOT remove any disk until the recovery finishes.',
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.readd',
      { ...identity, params: { pool: pool.name, diskId: idParsed.data } },
      async updateProgress => executeReadd(executor, { pool, diskId: idParsed.data }, updateProgress),
    )
    reply.code(202)
    return { job }
  })
}
