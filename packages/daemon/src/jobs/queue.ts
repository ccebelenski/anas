import { randomUUID } from 'node:crypto'
import type { Job, JobStatus, JobRef } from '@anas/shared'

/** The function a job executes. Receives a progress callback. */
export type JobHandler = (
  updateProgress: (message: string) => void,
) => Promise<unknown>

/** Internal job record with the handler attached. */
interface JobRecord {
  job: Job
  handler: JobHandler
}

export class JobQueue {
  private jobs = new Map<string, JobRecord>()
  private concurrency: number
  private running = 0

  constructor(opts?: { concurrency?: number }) {
    this.concurrency = opts?.concurrency ?? 4
  }

  /** Submit a new job. Returns the JobRef for the 202 response. */
  submit(operation: string, createdBy: string, handler: JobHandler): JobRef {
    const id = randomUUID()
    const now = new Date().toISOString()

    const job: Job = {
      id,
      status: 'queued',
      operation,
      progress: null,
      createdAt: now,
      createdBy,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    }

    this.jobs.set(id, { job, handler })
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
    const { job, handler } = record

    const updateProgress = (message: string) => {
      job.progress = message
    }

    try {
      const result = await handler(updateProgress)
      job.status = 'completed'
      job.result = result ?? null
    } catch (err) {
      job.status = 'failed'
      job.error = {
        code: 'JOB_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    } finally {
      job.completedAt = new Date().toISOString()
      this.running--
      this.drain()
    }
  }
}
