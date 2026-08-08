import type { AhrPool } from '@anas/shared'
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
    return {
      ...pool,
      advisories: [
        `creating this pool FAILED${step}: ${job.error?.message ?? 'no error was recorded'}`,
        `the partial stack is still on the disks — Destroy pool '${pool.name}' and retry the create`,
        ...rest,
      ],
    }
  }

  return pool
}
