import type { AhrCapacity, AhrExpansionIntent, AhrPool, AhrReplacePair, JobRef } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { AhrExpansionPlan, AhrLayoutDisk, AhrReplacement } from './ahr-layout.js'
import type { DiskIdentityCache } from './disk-identity-cache.js'
import { collectDisks } from '../routes/disks.js'
import { executeExpansion, executeReplace, projectExistingBands } from './ahr-expand-exec.js'
import { AhrIntentConflictError, writeIntent } from './ahr-intent.js'
import { AhrPlanError, planExpansion } from './ahr-layout.js'
import { spareCoverageWarnings } from './ahr-spare.js'

/**
 * The shared AHR expansion resume core (Epic 11.6, docs/AHR-DESIGN.md §5.3,
 * GT-8). ONE implementation of the §5.3 recompute-and-continue sequence —
 *
 *   resolveApproved → computePlan → writeIntent(halted→running) → submit job
 *
 * — reused by BOTH the operator verb (POST /ahr/:name/expand/resume in
 * routes/ahr-expand.ts) and the daemon-start boot-time re-attach
 * (services/ahr-boot-scan.ts). Extracting it is deliberate: the two callers
 * MUST behave identically (single source of truth), so the boot path can never
 * drift from the route path's fail-closed prechecks.
 *
 * Fail-closed is the contract: a missing approved disk (§5.3 — a missing disk
 * is NEVER treated as intent) or a planner refusal returns `{ ok: false }` with
 * a reason, and NO mutation is submitted. The caller maps the reason to its own
 * surface (HTTP status for the route; halt + PVE warning for the boot scan).
 */

/** Projected before → after capacity plus the recomputed §2.3 plan. */
export interface PlanBundle {
  plan: AhrExpansionPlan
  before: AhrCapacity
  after: AhrCapacity
}

/**
 * Assemble the approved disk set with sizes: current members resolve from the
 * pool itself; disks NEW to the pool resolve from the live inventory.
 * `requireAvailable` enforces the GT-12 safety exclusions for disks being
 * brought in fresh; resume relaxes it (a half-joined disk is no longer
 * 'available' but is still the operator's approved disk).
 */
export async function resolveApproved(
  executor: CommandExecutor,
  diskCache: DiskIdentityCache,
  pool: AhrPool,
  approvedIds: string[],
  requireAvailable: boolean,
): Promise<{ approved: AhrLayoutDisk[], problems: string[] }> {
  const approved: AhrLayoutDisk[] = []
  const problems: string[] = []
  const needInventory = approvedIds.some(id => !pool.disks.some(d => d.id === id))
  const inventory = needInventory ? await collectDisks(executor, diskCache) : []
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

/** Project the pool, run the §2.3 planner, and shape before → after. */
export function computePlan(pool: AhrPool, approved: AhrLayoutDisk[], replaced: AhrReplacement | undefined): PlanBundle {
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
  // §11 expansion coupling: a spare that cannot reach the post-expansion top
  // band is named in the PLAN warnings, before any confirm — it keeps covering
  // the existing bands, but the new band gets no auto-rebuild.
  plan.preview.warnings.push(...spareCoverageWarnings(
    pool.disks.filter(d => d.role === 'spare').map(d => ({ id: d.id, usableBytes: d.usableBytes })),
    plan.preview.bands,
  ))
  const before = pool.capacity
  const after: AhrCapacity = {
    ...plan.preview.capacity,
    usedBytes: before.usedBytes,
    freeBytes: Math.max(0, plan.preview.capacity.usableBytes - before.usedBytes),
  }
  return { plan, before, after }
}

/** Collaborators the driving job needs (shared by every expansion caller). */
export interface ExpansionDeps {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** AhrExpansionIntent store directory (§5.3 — the ONLY persisted state). */
  intentDir: string
}

/**
 * Submit the driving job for an expansion/replace/resume. The plan is already
 * recomputed; the executor detects already-realized steps as no-ops (§5.1
 * detect-then-delta). Used by every expansion entry point (initial expand,
 * guided replace, operator resume, boot re-attach) so the job shape is one.
 */
export function submitExpansion(
  deps: ExpansionDeps,
  args: {
    pool: AhrPool
    bundle: PlanBundle
    intent: AhrExpansionIntent
    identity: { user: string, uid: number, requestId?: string }
    operation: string
    params: Record<string, unknown>
    replace?: AhrReplacePair
  },
): JobRef {
  const { executor, jobQueue, intentDir } = deps
  const { pool, bundle, intent, identity, operation, params, replace } = args
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

/** Why an auto-/operator resume could not proceed (all fail closed). */
export type ResumeFailure = 'not-halted' | 'missing-disk' | 'plan-error' | 'conflict'

/** Discriminated result of {@link resumeExpansion}. */
export type ResumeResult
  = | { ok: true, job: JobRef, bundle: PlanBundle }
    | { ok: false, reason: ResumeFailure, message: string }

export interface ResumeExpansionInput extends ExpansionDeps {
  /** The live pool topology (already loaded by the caller). */
  pool: AhrPool
  /** The halted intent to continue. */
  intent: AhrExpansionIntent
  diskCache: DiskIdentityCache
  identity: { user: string, uid: number, requestId?: string }
}

/**
 * §5.3 recompute-and-continue: recompute the plan from the CURRENT topology +
 * the intent's approved disk set, flip the intent halted→running, and submit
 * the driving job. Idempotent and FAIL-CLOSED — a missing approved disk or a
 * planner refusal returns `{ ok: false, reason }` and submits NOTHING.
 *
 * Precondition: the on-disk intent is 'halted' (the boot path flips a stale
 * 'running' orphan to 'halted' first, then calls this). The halted→running
 * write is expectation-guarded, so a concurrent mutation can never double-drive.
 */
export async function resumeExpansion(input: ResumeExpansionInput): Promise<ResumeResult> {
  const { pool, intent, executor, jobQueue, diskCache, intentDir, identity } = input

  if (intent.state !== 'halted')
    return { ok: false, reason: 'not-halted', message: `expansion intent for pool '${pool.name}' is in state '${intent.state}', not halted` }

  // §5.3: resume = recompute-and-continue. Plan is recomputed from the CURRENT
  // topology + the intent's approved disk set; realized steps are executor no-ops.
  const { approved, problems } = await resolveApproved(executor, diskCache, pool, intent.approvedDisks, false)
  if (problems.length > 0)
    return { ok: false, reason: 'missing-disk', message: `${problems.join('; ')} — a missing disk is never treated as intent (§5.3); reattach it or Abandon the expansion.` }

  const replace: AhrReplacePair | undefined = intent.replacedDisk && intent.replacementDisk
    ? { oldDiskId: intent.replacedDisk, newDiskId: intent.replacementDisk }
    : undefined

  let bundle: PlanBundle
  try {
    bundle = computePlan(pool, approved, replace)
  }
  catch (err) {
    if (err instanceof AhrPlanError)
      return { ok: false, reason: 'plan-error', message: err.message }
    throw err
  }

  const running: AhrExpansionIntent = { ...intent, state: 'running' }
  try {
    await writeIntent(pool.name, running, { dir: intentDir, expect: 'halted' })
  }
  catch (err) {
    if (err instanceof AhrIntentConflictError)
      return { ok: false, reason: 'conflict', message: err.message }
    throw err
  }

  const job = submitExpansion({ executor, jobQueue, intentDir }, {
    pool,
    bundle,
    intent: running,
    identity,
    operation: 'ahr.expand.resume',
    params: { pool: pool.name, intent: intent.id },
    replace,
  })
  return { ok: true, job, bundle }
}
