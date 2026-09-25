import type { Job, JobRef, JobStatus } from '@anas/shared'
import type { AuditLogger } from '../audit/logger.js'
import { randomUUID } from 'node:crypto'

/** The function a job executes. Receives a progress callback. */
export type JobHandler = (
  updateProgress: (message: string) => void,
) => Promise<unknown>

/** Metadata about who submitted the job, for audit logging. */
export interface JobSubmitter {
  user: string
  uid: number
  requestId?: string
  params?: Record<string, unknown>
}

/** Internal job record with the handler attached. */
interface JobRecord {
  job: Job
  handler: JobHandler
  submitter: JobSubmitter
}

export class JobQueue {
  private jobs = new Map<string, JobRecord>()
  private concurrency: number
  private maxRetained: number
  private running = 0
  private audit?: AuditLogger

  constructor(opts?: { concurrency?: number, maxRetained?: number, audit?: AuditLogger }) {
    this.concurrency = opts?.concurrency ?? 4
    this.maxRetained = opts?.maxRetained ?? 1000
    this.audit = opts?.audit
  }

  /** Submit a new job. Returns the JobRef for the 202 response. */
  submit(
    operation: string,
    submitter: JobSubmitter,
    handler: JobHandler,
  ): JobRef {
    const id = randomUUID()
    const now = new Date().toISOString()

    const job: Job = {
      id,
      status: 'queued',
      operation,
      progress: null,
      createdAt: now,
      createdBy: submitter.user,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    }

    this.jobs.set(id, { job, handler, submitter })

    this.audit?.submitted({
      user: submitter.user,
      uid: submitter.uid,
      operation,
      params: submitter.params,
      requestId: submitter.requestId,
    })

    this.drain()

    return {
      id: job.id,
      status: job.status,
      operation: job.operation,
      createdAt: job.createdAt,
      createdBy: job.createdBy,
    }
  }

  /** Get a job by ID, or undefined if not found. */
  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job
  }

  /**
   * The most recently submitted job for `operation` that named `target` under
   * `paramKey` (`params.name` by default) — the in-process correlation from a
   * job back to the resource it acts on. The key is a parameter because not
   * every family calls its subject `name`: an image restore names its LUN's
   * target as `params.target` (story `iscsi.8`, live-proof F12).
   *
   * Submitter params are deliberately NOT on the wire `Job` shape, so this is
   * the only way a read path can ask "is a create running for THIS pool?".
   * That question has no answer in the system itself (a half-built stack looks
   * identical whether a job is still driving it or died an hour ago), and jobs
   * are the daemon's one legitimate piece of runtime state — no shadow state is
   * introduced, and after a restart the answer honestly reverts to "unknown".
   */
  findByOperation(operation: string, target: string, paramKey: string = 'name'): Job | undefined {
    let latest: Job | undefined
    // Map iteration is insertion order, so a later job with an equal timestamp
    // still wins.
    for (const record of this.jobs.values()) {
      if (record.job.operation !== operation || record.submitter.params?.[paramKey] !== target)
        continue
      if (!latest || record.job.createdAt >= latest.createdAt)
        latest = record.job
    }
    return latest
  }

  /**
   * The OLDEST job still in flight (queued or running) for any of `operations`
   * that named `target` — "is one of these running on this pool right now?".
   *
   * {@link findByOperation} cannot answer that: it returns the LATEST job per
   * operation whatever its status, so a completed job submitted after a running
   * one HIDES the running one, and a mutual-exclusion check built on it lets
   * the second job through (a scrub starting on top of a repair that has md's
   * `rmw_level` and `sync_min`/`sync_max` turned aside). Status is the filter
   * here, and the answer is a job that is actually in flight or nothing.
   */
  findActive(
    operations: string | readonly string[],
    target: string,
    paramKey: string = 'name',
    /** Extra submitter-param key/values a match must ALSO carry (e.g. `{ direct: true }`). */
    withParams?: Record<string, unknown>,
  ): Job | undefined {
    const wanted = new Set(typeof operations === 'string' ? [operations] : operations)
    for (const record of this.jobs.values()) {
      if (!wanted.has(record.job.operation) || record.submitter.params?.[paramKey] !== target)
        continue
      if (withParams) {
        const params = record.submitter.params ?? {}
        const matched = Object.entries(withParams).every(([k, v]) => params[k] === v)
        if (!matched)
          continue
      }
      if (record.job.status === 'queued' || record.job.status === 'running')
        return record.job
    }
    return undefined
  }

  /**
   * The most recently submitted job for `operation` on `target` that actually
   * COMPLETED — "what did the last successful run of this say?".
   *
   * {@link findByOperation} answers with the latest job whatever its status, so
   * a scrub that failed two minutes ago hides the good one before it. The
   * parity rewrite (selfheal.10) stands entirely on the evidence of the last
   * COMPLETED two-phase scrub — the band's parity mismatch count with a clean
   * phase 2 — and a failed or running job carries no such verdict.
   *
   * In memory like the rest of the queue: after a daemon restart the honest
   * answer is "no evidence", and the rewrite refuses rather than assuming.
   */
  findLastCompleted(operation: string, target: string, paramKey: string = 'name'): Job | undefined {
    let latest: Job | undefined
    for (const record of this.jobs.values()) {
      if (record.job.operation !== operation || record.job.status !== 'completed')
        continue
      if (record.submitter.params?.[paramKey] !== target)
        continue
      if (!latest || record.job.createdAt >= latest.createdAt)
        latest = record.job
    }
    return latest
  }

  /**
   * Every distinct `params.name` target seen for `operation`, in first-submitted
   * order. Pairs with {@link findByOperation} for "what has this operation been
   * asked to do, and how did the latest attempt on each end up?" — the question
   * behind surfacing a failed create whose pool no longer exists.
   */
  targetsByOperation(operation: string): string[] {
    const targets = new Set<string>()
    for (const record of this.jobs.values()) {
      const target = record.submitter.params?.name
      if (record.job.operation === operation && typeof target === 'string' && target.length > 0)
        targets.add(target)
    }
    return [...targets]
  }

  /** List jobs, optionally filtered by status. */
  list(status?: JobStatus): Job[] {
    const all = Array.from(this.jobs.values(), r => r.job)
    if (status) {
      return all.filter(j => j.status === status)
    }
    return all
  }

  /** Evict oldest completed/failed jobs when over maxRetained. */
  private evict(): void {
    if (this.jobs.size <= this.maxRetained)
      return

    for (const [id, record] of this.jobs) {
      if (this.jobs.size <= this.maxRetained)
        break
      if (record.job.status === 'completed' || record.job.status === 'failed')
        this.jobs.delete(id)
    }
  }

  /** Try to run queued jobs up to the concurrency limit. */
  private drain(): void {
    for (const record of this.jobs.values()) {
      if (this.running >= this.concurrency)
        break
      if (record.job.status !== 'queued')
        continue

      this.running++
      record.job.status = 'running'
      record.job.startedAt = new Date().toISOString()

      this.execute(record)
    }
  }

  private async execute(record: JobRecord): Promise<void> {
    const { job, handler, submitter } = record
    const startTime = Date.now()

    const updateProgress = (message: string) => {
      job.progress = message
    }

    try {
      const result = await handler(updateProgress)
      job.status = 'completed'
      job.result = result ?? null

      this.audit?.finished(
        {
          user: submitter.user,
          uid: submitter.uid,
          operation: job.operation,
          params: submitter.params,
          requestId: submitter.requestId,
        },
        { status: 'completed', durationMs: Date.now() - startTime },
      )
    }
    catch (err) {
      job.status = 'failed'
      const message = err instanceof Error ? err.message : String(err)
      job.error = { code: 'JOB_FAILED', message }

      this.audit?.finished(
        {
          user: submitter.user,
          uid: submitter.uid,
          operation: job.operation,
          params: submitter.params,
          requestId: submitter.requestId,
        },
        { status: 'failed', durationMs: Date.now() - startTime, error: message },
      )
    }
    finally {
      job.completedAt = new Date().toISOString()
      this.running--
      this.evict()
      this.drain()
    }
  }
}
