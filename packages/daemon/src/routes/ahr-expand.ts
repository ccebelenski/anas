import type { AhrExpansionIntent, AhrExpansionPlanResponse, AhrPool, AhrReplacePair } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { GuardSpec } from '../safety/guard.js'
import type { PlanBundle } from '../services/ahr-expand-resume.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { randomUUID } from 'node:crypto'
import { AhrExpandRequest, AhrReplaceRequest, DiskId, PoolName } from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { guardCheck, guardConfirm, guarded, refusalBody, sendRefusal } from '../safety/guard.js'
import { executeReadd } from '../services/ahr-expand-exec.js'
// The §5.3 recompute-and-continue core is shared with the daemon boot scan
// (services/ahr-boot-scan.ts) — ONE implementation, no drift (single source).
import { computePlan, resolveApproved, resumeExpansion, submitExpansion } from '../services/ahr-expand-resume.js'
import { ahrGuard, expansionStateRefusal } from '../services/ahr-guard.js'
import { poolIntentIdentity } from '../services/ahr-identity.js'
import { AhrIntentConflictError, clearIntent, readPoolIntent, writeIntent } from '../services/ahr-intent.js'
import { AhrPlanError, expansionGain, fmtBytes } from '../services/ahr-layout.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { requireIdentity } from './identity.js'

/**
 * The fields the abandon confirm leaves out of its signature (story cr.38,
 * WAVE3-DESIGN §5.2 rule 1): none. A test lists them.
 */
export const AHR_ABANDON_PRESENTATION_ONLY: Record<string, string> = {}

/** The fields the re-add confirm leaves out of its signature (cr.38 session B): none. */
export const AHR_READD_PRESENTATION_ONLY: Record<string, string> = {}

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
  // The guard's shared AHR pieces (story cr.38): abandon and re-add run on
  // them here; expand, resume and replace run on the expansion job's spec
  // (`expansionGuard`, services/ahr-expand-resume.ts — the boot re-attach
  // submits the same job). No verb here asks the LUN question, so the
  // guard's LIO reads stay unused.
  const guard = ahrGuard({ executor, intentDir, iscsiPaths: () => ({}) })

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

  /**
   * §4 pre-check: never start a reshape on a degraded/inactive/failed/readonly/
   * offline pool.
   *
   * `inactive` and `offline` are named explicitly rather than left to the
   * degraded catch: a band that cannot start used to report `degraded` and was
   * caught by this gate on that word alone, and an `offline` pool whose only
   * fault is an inactive LV never had a bad ARRAY to catch it at all. Both are
   * spelled out so the refusal survives the state split.
   */
  function refuseDegraded(pool: AhrPool, reply: FastifyReply): boolean {
    // One function at both doors (cr.38): the expand job re-runs it before
    // every act step (`expansionGuard`).
    const refusal = expansionStateRefusal(pool)
    if (!refusal)
      return false
    reply.code(refusal.status).send(refusalBody(refusal))
    return true
  }

  /** 409 when an expansion intent already exists for the pool. */
  async function refuseExistingIntent(pool: AhrPool, reply: FastifyReply): Promise<boolean> {
    // This pool's intent only (story ident.3): one an earlier pool of the same
    // name left behind is stale — it refuses nothing, and the new intent
    // replaces it ({@link persistNewIntent}).
    const existing = (await readPoolIntent(pool, intentDir)).intent
    if (existing) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool.name}' already has an expansion intent (state '${existing.state}') — Resume or Abandon it first.`,
      } })
      return true
    }
    return false
  }

  /**
   * Write a NEW intent for the pool (expand / replace). A stale intent filed
   * under the name — an earlier pool's — is removed first, so the
   * expectation-guarded write ('absent') still refuses a genuine double-expand
   * race and only that.
   */
  async function persistNewIntent(pool: AhrPool, intent: AhrExpansionIntent): Promise<void> {
    const { stale } = await readPoolIntent(pool, intentDir)
    if (stale)
      await clearIntent(pool.name, intentDir)
    await writeIntent(pool.name, intent, { dir: intentDir, expect: 'absent' })
  }

  /**
   * The usable-capacity delta this plan actually delivers (ahrexpand.1) —
   * ONE computation shared by the plan preview and both mutation gates, so
   * the number the operator sees before clicking and the number the 409
   * refuses on can never disagree.
   */
  function gainFor(pool: AhrPool, bundle: PlanBundle, replace?: AhrReplacePair) {
    return expansionGain({
      // Planner-vs-planner (§5.2): the live volume can lag its own band math
      // after an abandoned expansion, and that owed growth is not this plan's.
      beforeUsableBytes: bundle.beforeUsableBytes,
      after: bundle.after,
      bands: bundle.plan.preview.bands,
      warnings: bundle.plan.preview.warnings,
      tier: pool.ahrType,
      stepCount: bundle.plan.steps.length,
      introducedDiskIds: bundle.introducedDiskIds,
      replaced: replace,
    })
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

  function buildIntent(pool: AhrPool, bundle: PlanBundle, approvedIds: string[], replace?: AhrReplacePair): AhrExpansionIntent {
    return {
      id: randomUUID(),
      trigger: replace ? 'replace-disk' : 'add-disk',
      approvedDisks: approvedIds,
      ...(replace ? { replacedDisk: replace.oldDiskId, replacementDisk: replace.newDiskId } : {}),
      before: bundle.before,
      after: bundle.after,
      state: 'running',
      // WHOSE intent this is (story ident.3): the file is keyed by name, and a
      // later pool of the same name must read it as stale, never as its own.
      ...poolIntentIdentity(pool),
    }
  }

  /** Deps for the shared expansion-driving job submitter. */
  const expansionDeps = { executor, jobQueue, intentDir, diskCache: diskIdentityCache }

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
    // ahrexpand.1: the preview names the usable gain BEFORE the operator
    // clicks — and when the plan adds none, the shortfall and the unlock, so
    // the zero-gain 409 the Execute would hit is never a surprise.
    const gain = gainFor(pool, bundle, prepared.replace)
    const response: AhrExpansionPlanResponse = {
      before: bundle.before,
      after: bundle.after,
      steps: bundle.plan.steps,
      warnings: bundle.plan.preview.warnings,
      // The resulting band layout — the wizard renders the same banded disk
      // bars as the create composer (§6.3 before→after visualization).
      bands: bundle.plan.preview.bands,
      usableGain: gain.usableGain,
      ...(gain.zeroGain ? { zeroGain: gain.zeroGain } : {}),
    }
    return { data: response }
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
    if (await refuseExistingIntent(pool, reply))
      return
    // The plan is ALWAYS recomputed server-side — a client-side plan is a
    // preview, never an input.
    const prepared = await prepareExpand(pool, body, reply)
    if (!prepared)
      return
    const { bundle, approvedIds, replace } = prepared

    // ahrexpand.1: a plan whose reachable target adds no usable capacity is
    // refused UP FRONT — the guiding 409 states the shortfall and what
    // unlocks it (§5.2), instead of a sub-second "success" that did nothing.
    // The confirm code is the bypass for the honest zero-gain cases an
    // operator may still want (replacing a failing disk with one of the same
    // size) — the gate itself is unchanged, only its message.
    const zeroGain = gainFor(pool, bundle, replace).zeroGain
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.expand',
      params: { pool: pool.name, addDisks: body.addDisks ?? [], replace: replace ?? null },
      message: zeroGain
        ? zeroGain.shortfall
        : `Expanding AHR pool '${pool.name}' starts an online reshape`,
      warnings: expansionWarnings(bundle),
    })) {
      return reply
    }

    const intent = buildIntent(pool, bundle, approvedIds, replace)
    // cr.28: the privilege is checked BEFORE the intent is persisted — a
    // refusal at submit would otherwise strand an intent with no driver.
    jobQueue.authorize('ahr.expand', identity)
    try {
      await persistNewIntent(pool, intent)
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
    const intent = (await readPoolIntent(pool, intentDir)).intent
    if (!intent || intent.state !== 'halted') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: intent
        ? `Pool '${pool.name}' has an expansion intent in state '${intent.state}' — only a halted expansion can be resumed.`
        : `Pool '${pool.name}' has no halted expansion to resume.` } }
    }

    // Story ident.3 (d): resume drives disks the operator approved when the
    // expansion STARTED — possibly days ago. Every one of them is re-checked
    // now (a disk new to the pool must still be available, or carry nothing
    // but this pool's own half-joined slices), and the operator confirms the
    // disks it is about to partition, before anything is written.
    const { problems } = await resolveApproved(executor, diskIdentityCache, pool, intent.approvedDisks, false)
    if (problems.length > 0) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `${problems.join('; ')} — a missing disk is never treated as intent (§5.3); reattach it or Abandon the expansion.` } }
    }
    const joining = intent.approvedDisks.filter(id => !pool.disks.some(d => d.id === id))
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.expand.resume',
      params: { pool: pool.name, intent: intent.id, approvedDisks: intent.approvedDisks },
      message: `Resume the halted expansion of pool '${pool.name}'`,
      warnings: [
        ...joining.map(id => `${id} joins the pool: it is partitioned with the pool's band slices, and anything else on it is lost`),
        'The plan is recomputed from the pool as it is now; steps that already completed are skipped.',
        'The pool stays ONLINE during the reshape, but performance is reduced; on large arrays a reshape takes hours to DAYS.',
        'Do NOT remove disks while the expansion runs.',
      ],
    })) {
      return reply
    }

    // §5.3 recompute-and-continue via the SHARED resume core (identical to the
    // daemon boot-time re-attach path). Fail-closed reasons map to the
    // same HTTP codes/messages this route has always returned.
    // cr.28: checked before resume flips the intent halted→running.
    jobQueue.authorize('ahr.expand.resume', identity)
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
  // Story cr.38 (§2.3 "abandon": `clearIntent` checks neither id nor state).
  // The intent the operator confirmed is bound as the request's REVISION, and
  // the job re-reads it under the pool's key: an intent that was resumed
  // (running again) refuses, and one replaced by another expansion's — a new
  // id — fails STATE_CHANGED instead of being deleted on the strength of a
  // confirm that never saw it.
  server.post<{ Params: { name: string } }>('/ahr/:name/expand/abandon', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const parsed = PoolName.safeParse(request.params.name)
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } }
    }
    const poolName = parsed.data

    const base = guard.poolView(poolName, 'an abandon')
    const spec: GuardSpec<AhrPool & { intent: AhrExpansionIntent | null }> = {
      operation: 'ahr.expand.abandon',
      object: {
        ...base,
        read: async (reads) => {
          const pool = await base.read(reads)
          return pool ? { ...pool, intent: (await guard.reads.intent(reads, pool)).intent } : null
        },
        revision: async o => o.intent?.id ?? null,
        unbound: part => part === 'revision'
          ? `Pool '${poolName}' has no expansion intent to abandon.`
          : base.unbound(part),
      },
      gates: [
        async o => !o.intent
          ? { status: 409, code: 'CONFLICT', message: `Pool '${o.name}' has no expansion intent to abandon.` }
          : null,
        async o => o.intent?.state === 'running'
          ? { status: 409, code: 'CONFLICT', message: `Pool '${o.name}' has an expansion currently being driven — it can only be abandoned once halted.` }
          : null,
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object
    const intent = pool.intent!

    const layout = pool.arrays.map(a => `${pool.name}-r${a.band} ${a.level}×${a.members.length}`).join(', ')
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName },
      address: ['pool'],
      presentationOnly: AHR_ABANDON_PRESENTATION_ONLY,
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

    const job = jobQueue.submit(
      'ahr.expand.abandon',
      { ...identity, params: { pool: pool.name, intent: intent.id } },
      guarded(spec, pre, async (live, { updateProgress }) => {
        updateProgress(`Abandoning expansion intent ${live.intent!.id}`)
        await clearIntent(live.name, intentDir)
        return { abandoned: live.name }
      }),
      { locks: pre.locks },
    )
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
    if (await refuseExistingIntent(pool, reply))
      return

    const replace: AhrReplacePair = { oldDiskId: oldParsed.data, newDiskId: bodyParsed.data.newDiskId }
    // prepareExpand validates membership + availability and runs the §2.5
    // size pre-check via the planner (its refusal surfaces verbatim as 400).
    const prepared = await prepareExpand(pool, { replace }, reply)
    if (!prepared)
      return
    const { bundle, approvedIds } = prepared

    const bands = pool.arrays.filter(a => a.members.some(m => m.disk === replace.oldDiskId)).map(a => a.band)
    // ahrexpand.1 — the guided replace is a REPAIR verb, so it keeps its own
    // headline: swapping a failing disk for one of the same size is the point,
    // not a mistake. The zero-gain fact is stated ONCE, as a warning, and the
    // headline swap stays on ahr.expand where growth IS the intent.
    const zeroGain = gainFor(pool, bundle, replace).zeroGain
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.replace',
      params: { pool: pool.name, oldDiskId: replace.oldDiskId, newDiskId: replace.newDiskId },
      message: `Replacing disk '${replace.oldDiskId}' in pool '${pool.name}'`,
      warnings: [
        ...(zeroGain ? [zeroGain.shortfall] : []),
        `Every band of ${replace.oldDiskId} (band${bands.length === 1 ? '' : 's'} ${bands.join(', ')}) is copied onto ${replace.newDiskId} at rebuild speed — hours on large disks. The pool stays online and fully redundant throughout (live copy via mdadm --replace).`,
        'Do NOT remove either disk until the replace completes.',
        ...expansionWarnings(bundle),
        `Afterwards ${replace.oldDiskId} is retired (md superblocks zeroed, partition table zapped) — only if it is still present and healthy; a dead disk is left alone.`,
      ],
    })) {
      return reply
    }

    const intent = buildIntent(pool, bundle, approvedIds, replace)
    // cr.28: the privilege is checked BEFORE the intent is persisted — a
    // refusal at submit would otherwise strand an intent with no driver.
    jobQueue.authorize('ahr.replace', identity)
    try {
      await persistNewIntent(pool, intent)
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
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    const diskId = idParsed.data

    // Story cr.38 session B (§2.3 "readd": the intent was not re-checked in
    // the job). One gate list at both doors — no expansion intent (a member
    // rejoin is never interleaved with a running or halted expansion) and no
    // reshape in flight — re-run when the job starts and again before every
    // band's re-add, under the pool's key and the disk's, with the keys given
    // back while md recovers each band.
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.readd',
      object: guard.poolView(poolName, 'a re-add'),
      gates: [
        guard.intentGate('Resume or Abandon it first; a member rejoin is never interleaved with an expansion'),
        async pool => pool.arrays.some(a => a.sync?.action === 'reshape')
          ? { status: 409, code: 'CONFLICT', message: `pool '${pool.name}' is reshaping — wait for the reshape to finish before re-adding a member` }
          : null,
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { disks: [diskId] }),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, diskId },
      address: ['pool', 'diskId'],
      presentationOnly: AHR_READD_PRESENTATION_ONLY,
      message: `Re-adding disk '${diskId}' to pool '${poolName}'`,
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
      { ...identity, params: { pool: poolName, diskId } },
      guarded(spec, pre, async (live, ctx) => executeReadd(executor, { pool: live, diskId }, ctx.updateProgress, {
        hooks: { release: ctx.release, reguard: ctx.reguard },
      })),
      { locks: pre.locks, lane: 'long' },
    )
    reply.code(202)
    return { job }
  })
}
