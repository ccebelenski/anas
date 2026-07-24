import type { AhrCapacity, AhrExpansionIntent, AhrPool, AhrReplacePair } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AhrExpansionPlan, AhrLayoutDisk, AhrReplacement } from '../services/ahr-layout.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { randomUUID } from 'node:crypto'
import { AhrExpandRequest, AhrReplaceRequest, DiskId, PoolName } from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { executeExpansion, executeReplace, projectExistingBands } from '../services/ahr-expand-exec.js'
import { AhrIntentConflictError, clearIntent, readIntent, writeIntent } from '../services/ahr-intent.js'
import { AhrPlanError, planExpansion } from '../services/ahr-layout.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

const GIB = 1024 ** 3

function fmtCapacity(bytes: number): string {
  const gib = bytes / GIB
  return gib >= 1024 ? `${(gib / 1024).toFixed(2)} TiB` : `${Math.round(gib * 10) / 10} GiB`
}

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

  /** Disk ids currently serving any band array of the pool. */
  function memberIds(pool: AhrPool): Set<string> {
    const out = new Set<string>()
    for (const arr of pool.arrays) {
      for (const m of arr.members)
        out.add(m.disk)
    }
    return out
  }

  /**
   * Assemble the approved disk set with sizes: current members resolve from
   * the pool itself; disks NEW to the pool resolve from the live inventory.
   * `requireAvailable` enforces the GT-12 safety exclusions for disks being
   * brought in fresh; resume relaxes it (a half-joined disk is no longer
   * 'available' but is still the operator's approved disk).
   */
  async function resolveApproved(
    pool: AhrPool,
    approvedIds: string[],
    requireAvailable: boolean,
  ): Promise<{ approved: AhrLayoutDisk[], problems: string[] }> {
    const approved: AhrLayoutDisk[] = []
    const problems: string[] = []
    const needInventory = approvedIds.some(id => !pool.disks.some(d => d.id === id))
    const inventory = needInventory ? await collectDisks(executor, diskIdentityCache) : []
    for (const id of approvedIds) {
      const poolDisk = pool.disks.find(d => d.id === id)
      if (poolDisk) {
        approved.push({ id, usableBytes: poolDisk.sizeBytes })
        continue
      }
      const inv = inventory.find(d => d.id === id)
      if (!inv) {
        problems.push(`disk '${id}' not found in the inventory`)
        continue
      }
      if (requireAvailable && inv.status !== 'available') {
        problems.push(`disk '${id}' is not available (status: ${inv.status}${inv.poolName ? `, pool '${inv.poolName}'` : ''})`)
        continue
      }
      approved.push({ id, usableBytes: inv.size })
    }
    return { approved, problems }
  }

  interface PlanBundle {
    plan: AhrExpansionPlan
    before: AhrCapacity
    after: AhrCapacity
  }

  /** Project the pool, run the §2.3 planner, and shape before → after. */
  function computePlan(pool: AhrPool, approved: AhrLayoutDisk[], replaced: AhrReplacement | undefined): PlanBundle {
    let existingBands
    try {
      existingBands = projectExistingBands(pool)
    }
    catch (err) {
      // Projection failures are refusals too — the pool's live geometry could
      // not be expressed as planner constraints.
      throw new AhrPlanError(err instanceof Error ? err.message : String(err))
    }
    const plan = planExpansion({
      poolName: pool.name,
      tier: pool.ahrType,
      existingBands,
      approvedDisks: approved,
      replaced,
    })
    const before = pool.capacity
    const after: AhrCapacity = {
      ...plan.preview.capacity,
      usedBytes: before.usedBytes,
      freeBytes: Math.max(0, plan.preview.capacity.usableBytes - before.usedBytes),
    }
    return { plan, before, after }
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
    const { approved, problems: diskProblems } = await resolveApproved(pool, [...approvedIds], true)
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
      `Usable capacity ${fmtCapacity(before.usableBytes)} → ${fmtCapacity(after.usableBytes)}${
        pendingDelta > 0 ? `; ${fmtCapacity(after.pendingBytes)} of capacity will be PENDING (physically present but locked — see below).` : '.'}`,
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

  /** Persist the intent (expect none) and submit the driving job. */
  function submitExpansion(
    pool: AhrPool,
    bundle: PlanBundle,
    intent: AhrExpansionIntent,
    identity: { user: string, uid: number, requestId?: string },
    operation: string,
    params: Record<string, unknown>,
    replace?: AhrReplacePair,
  ) {
    return jobQueue.submit(operation, { ...identity, params }, async (updateProgress) => {
      const input = { pool, intent, plan: bundle.plan }
      const outcome = replace
        ? await executeReplace(executor, { ...input, oldDiskId: replace.oldDiskId, newDiskId: replace.newDiskId }, updateProgress, { intentDir })
        : await executeExpansion(executor, input, updateProgress, { intentDir })
      if (!outcome.ok)
        throw new Error(outcome.error ?? 'expansion failed')
      return { before: bundle.before, after: bundle.after }
    })
  }

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
    const job = submitExpansion(pool, bundle, intent, identity, 'ahr.expand', {
      pool: pool.name,
      addDisks: body.addDisks ?? [],
      replace: replace ?? null,
    }, replace)
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

    // §5.3: resume = recompute-and-continue. The plan is recomputed from the
    // CURRENT topology + the intent's approved disk set; steps already
    // realized are detected as no-ops by the executor.
    const { approved, problems } = await resolveApproved(pool, intent.approvedDisks, false)
    if (problems.length > 0) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `${problems.join('; ')} — a missing disk is never treated as intent (§5.3); reattach it or Abandon the expansion.` } }
    }
    const replace: AhrReplacePair | undefined = intent.replacedDisk && intent.replacementDisk
      ? { oldDiskId: intent.replacedDisk, newDiskId: intent.replacementDisk }
      : undefined
    let bundle: PlanBundle
    try {
      bundle = computePlan(pool, approved, replace)
    }
    catch (err) {
      if (err instanceof AhrPlanError) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: err.message } }
      }
      throw err
    }

    const running: AhrExpansionIntent = { ...intent, state: 'running' }
    try {
      await writeIntent(pool.name, running, { dir: intentDir, expect: 'halted' })
    }
    catch (err) {
      if (err instanceof AhrIntentConflictError) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: err.message } }
      }
      throw err
    }
    const job = submitExpansion(pool, bundle, running, identity, 'ahr.expand.resume', { pool: pool.name, intent: intent.id }, replace)
    reply.code(202)
    return { job }
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
        `Current layout: ${layout}; usable ${fmtCapacity(pool.capacity.usableBytes)}${pool.capacity.pendingBytes > 0 ? `, ${fmtCapacity(pool.capacity.pendingBytes)} pending` : ''}.`,
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
    const job = submitExpansion(pool, bundle, intent, identity, 'ahr.replace', {
      pool: pool.name,
      oldDiskId: replace.oldDiskId,
      newDiskId: replace.newDiskId,
    }, replace)
    reply.code(202)
    return { job }
  })
}
