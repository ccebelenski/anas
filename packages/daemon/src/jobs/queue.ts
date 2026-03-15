import { randomUUID } from 'node:crypto'
import type { Job, JobStatus, JobRef } from '@anas/shared'
import type { AuditLogger } from '../audit/logger.js'

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
  private running = 0
  private audit?: AuditLogger

  constructor(opts?: { concurrency?: number; audit?: AuditLogger }) {
    this.concurrency = opts?.concurrency ?? 4
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

  /** List jobs, optionally filtered by status. */
  list(status?: JobStatus): Job[] {
    const all = Array.from(this.jobs.values()).map((r) => r.job)
    if (status) {
      return all.filter((j) => j.status === status)
    }
    return all
  }

  /** Try to run queued jobs up to the concurrency limit. */
  private drain(): void {
    for (const record of this.jobs.values()) {
      if (this.running >= this.concurrency) break
      if (record.job.status !== 'queued') continue

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
    } catch (err) {
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
    } finally {
      job.completedAt = new Date().toISOString()
      this.running--
      this.drain()
    }
  }
}
