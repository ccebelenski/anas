import type { Job } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CancelMeta, JobQueue } from '../jobs/queue.js'
import { JobStatus } from '@anas/shared'
import { cancelRefusalMessage } from '../jobs/queue.js'
import { ConfirmStore } from '../safety/confirm.js'
import { confirmGate } from '../safety/gate.js'
import { requireIdentity } from './identity.js'

/**
 * A duration as the cancel headline says it: "2 h 14 m", "3 m 5 s", "12 s".
 * Two units at most — the operator is deciding whether to stop a run, not
 * reading a stopwatch.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (d > 0)
    return `${d} d ${h} h`
  if (h > 0)
    return `${h} h ${m} m`
  if (m > 0)
    return `${m} m ${sec} s`
  return `${sec} s`
}

/**
 * The confirm headline for a cancel (rclone.5): what is running, for how long,
 * how far it got, and that the cancel stops it where it is. A job that names
 * itself (a task run) is named; any other cancellable job is named by its
 * operation.
 */
export function cancelHeadline(job: Job, meta: CancelMeta, now: number = Date.now()): string {
  const subject = meta.subject ?? `Job '${job.operation}'`
  const started = job.startedAt ? Date.parse(job.startedAt) : Number.NaN
  const elapsed = Number.isNaN(started) ? '' : ` for ${formatElapsed(now - started)}`
  const progress = typeof job.progress === 'string' && job.progress.trim() ? ` — ${job.progress.trim()}` : ''
  return `${subject} has been running${elapsed}${progress}; cancelling stops it here`
}

export async function jobRoutes(
  server: FastifyInstance,
  /**
   * `confirmStore` is the daemon's one store in production (server.ts); a
   * test that registers these routes only for the reads may omit it and gets
   * a private one — codes minted there are verified there.
   */
  opts: { jobQueue: JobQueue, confirmStore?: ConfirmStore },
) {
  const { jobQueue } = opts
  const confirmStore = opts.confirmStore ?? new ConfirmStore()

  /** GET /v1/jobs — list jobs, optionally filtered by ?status= */
  server.get<{
    Querystring: { status?: string }
  }>('/jobs', async (request, reply) => {
    const { status } = request.query

    if (status) {
      const parsed = JobStatus.safeParse(status)
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid status filter: must be one of ${JobStatus.options.join(', ')}`,
          },
        })
      }
      return { data: jobQueue.list(parsed.data) }
    }

    return { data: jobQueue.list() }
  })

  /** GET /v1/jobs/:id — job detail */
  server.get<{
    Params: { id: string }
  }>('/jobs/:id', async (request, reply) => {
    const job = jobQueue.get(request.params.id)

    if (!job) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Job '${request.params.id}' not found`,
        },
      })
    }

    return { job }
  })

  /**
   * POST /v1/jobs/:id/cancel — stop a running job (rclone.5), confirm-gated
   * like every irreversible verb: the first call answers 409 with
   * `X-Anas-Confirm-Code` and a headline naming the run, how long it has been
   * going and how far it got (plus, when the job gives one, what a cancel
   * leaves behind); the replay with the code submits the cancel as a job of
   * its own that runs the target's hook. A job that is not running, or that
   * registered no hook, is refused with its sentence BEFORE a code is minted —
   * a dialog for a cancel that cannot happen is worse than the refusal.
   *
   * The cancel job is a CONTROL job (it runs at once, outside the concurrency
   * limit): it would otherwise queue behind the very run it is meant to stop.
   * It fails with the hook's reason when the run could not be stopped — and
   * the run then continues.
   */
  server.post<{
    Params: { id: string }
  }>('/jobs/:id/cancel', async (request, reply) => {
    const id = request.params.id
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const target = jobQueue.cancelTarget(id)
    if ('reason' in target) {
      if (target.reason === 'not-found') {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: cancelRefusalMessage(target, id) } }
      }
      reply.code(409)
      return {
        error: {
          code: target.reason === 'not-cancellable' ? 'NOT_CANCELLABLE' : 'CONFLICT',
          message: cancelRefusalMessage(target, id),
        },
      }
    }

    const headline = cancelHeadline(target.job, target.meta)
    const warnings = [headline, ...(target.meta.consequence ? [target.meta.consequence] : [])]
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'job.cancel',
      params: { id },
      message: headline,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'job.cancel',
      { ...identity, params: { id, operation: target.job.operation } },
      async () => {
        const by = await jobQueue.cancel(id, identity.user)
        return { cancelled: id, operation: target.job.operation, cancelledBy: by.user, cancelledAt: by.at }
      },
      { control: true },
    )
    reply.code(202)
    return { job }
  })
}
