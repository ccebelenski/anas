import type { AhrPool, DashboardWarning } from '@anas/shared'
import type { JobQueue } from '../jobs/queue.js'
import { missingLvAdvisory, missingVgAdvisory, notMountedAdvisory } from './ahr-topology.js'

/**
 * Create-job status overlay for AHR pool reads (issue #7).
 *
 * The topology reader is pure system truth (§5.3): a pool whose VG/LV does not
 * exist reads `failed`, and that verdict is CORRECT — there really is no LVM
 * layer. What the system cannot say is WHY, and the difference matters
 * enormously to the operator:
 *
 *  - a create job is running right now and simply has not reached `vgcreate`
 *    yet — the pool is BUILDING, nothing is wrong, and the fix is to wait;
 *  - a create job died partway — the pool is genuinely wrecked, and the fix is
 *    to destroy the partial stack and retry.
 *
 * Both look identical on disk. The job queue is the one place that knows, and
 * jobs are the daemon's legitimate runtime state, so this consults it rather
 * than inventing a persisted create record. In-process only and deliberately
 * so: after a daemon restart the answer reverts to plain system truth
 * (`failed` + the missing-layer advisories), which is honest — ANAS no longer
 * knows whose wreckage it is.
 *
 * Read-only in both directions: the queue is never mutated, and a pool with no
 * matching job passes through completely untouched.
 */

/** The job operation name the create route submits under. */
export const AHR_CREATE_OPERATION = 'ahr.create'

/**
 * Appended to a failed create's error once its partial pool has been rolled
 * back (issue #11). It is operator-facing prose AND the flag this module reads
 * to know the disks are blank — so the advisory says RETRY, never "Destroy the
 * partial pool" (there is nothing left to destroy).
 *
 * One string, defined here where it is interpreted and imported by the create
 * service that writes it, so the two can never drift apart.
 */
export const ROLLED_BACK_MARKER = ' — partial pool was rolled back; disks are blank and create can be retried'

/**
 * The missing-layer advisories, which a create-in-flight or failed-create pool
 * would otherwise repeat as if they were independent findings. They restate the
 * job's own outcome, so the overlay drops them and leads with the real story.
 */
function missingLayerAdvisories(pool: string): Set<string> {
  return new Set([missingVgAdvisory(pool), missingLvAdvisory(pool), notMountedAdvisory(pool)])
}

/**
 * Overlay the pool's live `ahr.create` job onto a topology read.
 *
 *  - queued/running → state `building`, with the job's current progress line
 *    leading the advisories (the operator sees WHICH step is underway);
 *  - failed, with the wreckage still present (the pool still reads `failed`) →
 *    state stays `failed`, and the advisories lead with the job's actual error
 *    plus the concrete next step, instead of the missing-VG/LV noise;
 *  - completed, or no job at all → returned unchanged.
 *
 * A failed create whose pool now reads healthy (the operator rebuilt it, or the
 * failure was late and harmless) is left alone — a stale job must never
 * contradict a working pool.
 */
export function withAhrCreateStatus(pool: AhrPool, jobQueue?: JobQueue): AhrPool {
  const job = jobQueue?.findByOperation(AHR_CREATE_OPERATION, pool.name)
  if (!job)
    return pool

  const noise = missingLayerAdvisories(pool.name)
  const rest = pool.advisories.filter(a => !noise.has(a))

  if (job.status === 'queued' || job.status === 'running') {
    return {
      ...pool,
      state: 'building',
      advisories: [
        `pool '${pool.name}' is being created — ${job.progress ?? 'starting'}`,
        ...rest,
      ],
    }
  }

  if (job.status === 'failed' && pool.state === 'failed') {
    const step = job.progress ? ` at '${job.progress}'` : ''
    const message = job.error?.message ?? 'no error was recorded'
    // A pool still visible AFTER a successful rollback is the rare partial case
    // (e.g. the arrays went but the mdadm.conf unpin did not). The disks are
    // blank either way, so telling the operator to Destroy would be wrong — the
    // honest next step is to retry the create.
    const rolledBack = message.includes(ROLLED_BACK_MARKER)
    return {
      ...pool,
      advisories: [
        `creating this pool FAILED${step}: ${message}`,
        rolledBack
          ? `the partial pool was already rolled back — retry the create`
          : `the partial stack is still on the disks — Destroy pool '${pool.name}' and retry the create`,
        ...rest,
      ],
    }
  }

  return pool
}

/**
 * Dashboard cards for creates that failed and left NOTHING behind (issue #11).
 *
 * A successful rollback is the good outcome and also the invisible one: the
 * disks go blank, the pool vanishes from the topology, and an operator who was
 * not watching the create dialog would find no trace anywhere in the UI. The
 * hard requirement is that they always learn WHY a create failed, so the
 * failure is carded here even though there is no pool left to attach it to.
 *
 * Only creates whose pool is ABSENT from the live topology are carded — a pool
 * that still exists already gets the `failed` card plus the overlay's advisories
 * above, and carding both would say the same thing twice.
 *
 * Lifetime is the daemon's, like the rest of this overlay: the job queue is
 * in-process, so a restart clears these. That is an accepted limit, not a
 * silent one — a PVE notification fires at failure time through Proxmox's own
 * channel, which is what survives a restart.
 */
export function buildFailedCreateWarnings(livePools: string[], jobQueue?: JobQueue): DashboardWarning[] {
  if (!jobQueue)
    return []
  const present = new Set(livePools)
  const warnings: DashboardWarning[] = []
  for (const target of jobQueue.targetsByOperation(AHR_CREATE_OPERATION)) {
    if (present.has(target))
      continue
    // The LATEST job decides: a successful retry must silence the old failure.
    const job = jobQueue.findByOperation(AHR_CREATE_OPERATION, target)
    if (job?.status !== 'failed')
      continue
    const step = job.progress ? ` at '${job.progress}'` : ''
    warnings.push({
      // Not critical: nothing is broken and no data is at risk — the disks are
      // blank. It is a job that failed and needs the operator's attention.
      level: 'warning',
      category: 'ahr',
      message: `AHR pool '${target}' was NOT created — creating it failed${step}: ${job.error?.message ?? 'no error was recorded'}`,
      ref: target,
    })
  }
  return warnings
}
