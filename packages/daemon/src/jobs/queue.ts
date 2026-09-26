import type { Job, JobRef, JobStatus } from '@anas/shared'
import type { AuditLogger } from '../audit/logger.js'
import { randomUUID } from 'node:crypto'

/** Who cancelled a job, and when (rclone.5). */
export interface JobCancellation {
  user: string
  /** ISO time the cancel was requested. */
  at: string
}

/**
 * A job's cancel hook (rclone.5). Resolves once the job's work has stopped
 * (the child it runs is gone); THROWS with the reason when it could not stop
 * it — the cancel then fails and the job carries on as though nothing had
 * been asked.
 */
export type CancelHook = (by: JobCancellation) => Promise<void>

/** What a job says about itself when it registers a hook — the 409 headline's words. */
export interface CancelMeta {
  /** The subject the headline names, e.g. "Cloud sync task 'photos'". */
  subject?: string
  /** The one sentence saying what a cancel leaves behind (the dialog shows it). */
  consequence?: string
}

/**
 * The second argument every job body receives (rclone.5): the cancel seam.
 * A body that can be stopped registers ONE hook when it starts; a body that
 * never does is not cancellable, and the cancel route says so.
 */
export interface JobContext {
  /** Register (or replace) this job's cancel hook. */
  onCancel: (hook: CancelHook, meta?: CancelMeta) => void
  /**
   * The cancellation requested for this job — pending while the hook runs,
   * then accepted — or null. A body reads it where it would otherwise report
   * a failure: a run stopped on purpose must not notify as failed.
   */
  cancellation: () => JobCancellation | null
  /**
   * Publish structured live detail on the job (rclone.6, ADDITIVE): the
   * text `updateProgress` carries stays exactly what it was — this is the
   * typed companion a poller reads beside it (`GET /v1/jobs/:id` returns the
   * job's `detail`). The queue stores what it is given verbatim; the shape is
   * the publishing job family's business (cloud sync: `CloudRunDetail`).
   */
  updateDetail: (detail: unknown) => void
}

/** The function a job executes. Receives a progress callback and the cancel seam. */
export type JobHandler = (
  updateProgress: (message: string) => void,
  ctx: JobContext,
) => Promise<unknown>

/**
 * Thrown by a job body whose WATCHED work was cancelled elsewhere (rclone.5):
 * the UI Run-Now supervisor sees its task's unit end with the runner's cancel
 * exit code. The queue ends the job `cancelled` with this message as the
 * reason — never `failed`.
 */
export class JobCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobCancelledError'
  }
}

/**
 * Thrown by a job body whose run FAILED even though a cancel had already been
 * accepted for it (rclone.5 review): the child the cancel was accepted to stop
 * never existed — a missing binary rejects the exec before anything spawned —
 * so there was nothing to stop and the honest verdict is the failure. The
 * queue ends the job `failed` with the body's error and remembers the accepted
 * cancel in the reason, instead of the `cancelled` row a mask would give.
 */
export class JobFailedDespiteCancelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobFailedDespiteCancelError'
  }
}

/** The sentence a cancelled job's result carries: "cancelled by <user> at <time>". */
export function cancelledReason(by: JobCancellation): string {
  return `cancelled by ${by.user} at ${by.at}`
}

/** Why a cancel could not run — the route turns each into its 404/409 sentence. */
export type CancelRefusal
  = | { reason: 'not-found' }
    | { reason: 'finished', job: Job }
    | { reason: 'not-cancellable', job: Job }
    | { reason: 'in-progress', job: Job, by: JobCancellation }

/** What the cancel route needs to know about a job before it asks for confirmation. */
export interface CancelTarget {
  job: Job
  meta: CancelMeta
}

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
  /** Control jobs run at once, outside the concurrency limit (see `submit`). */
  control?: boolean
  /** The body's cancel hook, once it registered one (rclone.5). */
  cancelHook?: CancelHook
  cancelMeta?: CancelMeta
  /** A requested cancellation — set while the hook runs, kept once it succeeded. */
  cancelling?: JobCancellation
  /** The hook's run, awaited by `execute` before it settles the job's status. */
  cancelRun?: Promise<void>
  /** True once the hook succeeded: the job ends `cancelled` however its body ends. */
  cancelled?: boolean
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

  /**
   * Submit a new job. Returns the JobRef for the 202 response.
   *
   * `control: true` (rclone.5) starts the job AT ONCE, outside the concurrency
   * limit, and does not occupy a slot. It exists for one job: the cancel of a
   * running job. A cancel queued behind the very runs it is meant to stop
   * (a Run-Now holds two slots — its supervisor and the direct run) would wait
   * for them; it is short and bounded (two signal waits), so it never needs a
   * slot of its own.
   */
  submit(
    operation: string,
    submitter: JobSubmitter,
    handler: JobHandler,
    opts: { control?: boolean } = {},
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
      detail: null,
    }

    const record: JobRecord = { job, handler, submitter, ...(opts.control ? { control: true } : {}) }
    this.jobs.set(id, record)

    this.audit?.submitted({
      user: submitter.user,
      uid: submitter.uid,
      operation,
      params: submitter.params,
      requestId: submitter.requestId,
    })

    if (record.control)
      this.start(record)
    else
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

  /**
   * Can this job be cancelled right now, and what does it say about itself?
   * The route's pre-flight — asked BEFORE a confirm code is minted, so a
   * finished or hook-less job gets its 409 sentence instead of a dialog.
   */
  cancelTarget(id: string): CancelTarget | CancelRefusal {
    const record = this.jobs.get(id)
    if (!record)
      return { reason: 'not-found' }
    const { job } = record
    if (job.status !== 'queued' && job.status !== 'running')
      return { reason: 'finished', job }
    if (!record.cancelHook)
      return { reason: 'not-cancellable', job }
    if (record.cancelling)
      return { reason: 'in-progress', job, by: record.cancelling }
    return { job, meta: record.cancelMeta ?? {} }
  }

  /**
   * Cancel a running job (rclone.5): run its hook ONCE and, when the hook
   * reports the work stopped, end the job `cancelled` whatever its body does
   * next (the body's own `finally` still runs — a transient snapshot is still
   * destroyed). Resolves with the cancellation; THROWS with the refusal's or
   * the hook's reason — a hook that could not stop the work leaves the job
   * running exactly as before, and a later cancel may try again.
   */
  async cancel(id: string, user: string): Promise<JobCancellation> {
    const target = this.cancelTarget(id)
    if ('reason' in target)
      throw new Error(cancelRefusalMessage(target, id))
    const record = this.jobs.get(id) as JobRecord
    const by: JobCancellation = { user, at: new Date().toISOString() }
    record.cancelling = by
    const hook = record.cancelHook as CancelHook
    const run = hook(by)
    // The job's own settle awaits THIS chain, so the verdict is recorded on it
    // (not after the caller's await) — a body that ends the instant its child
    // dies can never be settled before the cancel is.
    record.cancelRun = run.then(
      () => {
        record.cancelled = true
      },
      () => {
        record.cancelling = undefined
        record.cancelRun = undefined
      },
    )
    await run
    return by
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
      if (record.job.status === 'completed' || record.job.status === 'failed' || record.job.status === 'cancelled')
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
      this.start(record)
    }
  }

  /** Mark a record running and execute it (the slot, if any, is the caller's). */
  private start(record: JobRecord): void {
    record.job.status = 'running'
    record.job.startedAt = new Date().toISOString()
    this.execute(record)
  }

  private async execute(record: JobRecord): Promise<void> {
    const { job, handler, submitter } = record
    const startTime = Date.now()

    const updateProgress = (message: string) => {
      job.progress = message
    }
    const ctx: JobContext = {
      onCancel: (hook, meta) => {
        record.cancelHook = hook
        record.cancelMeta = meta ?? {}
      },
      cancellation: () => record.cancelling ?? null,
      updateDetail: (detail) => {
        job.detail = detail
      },
    }

    let outcome: { ok: true, result: unknown } | { ok: false, err: unknown }
    try {
      outcome = { ok: true, result: await handler(updateProgress, ctx) }
    }
    catch (err) {
      outcome = { ok: false, err }
    }
    // A cancel whose hook is still deciding settles the job's status first:
    // the body usually ends BECAUSE the hook's signal stopped its child.
    if (record.cancelRun)
      await record.cancelRun

    try {
      // A body that failed BEFORE the child an accepted cancel was waiting for
      // ever existed marks its error (rclone.5 review): the verdict is that
      // failure — with the cancel remembered in the reason — never a cancelled
      // row for a run that never got going. Checked BEFORE the cancelled
      // verdict below, which is why the marker exists at all.
      if (!outcome.ok && outcome.err instanceof JobFailedDespiteCancelError)
        throw outcome.err
      if (record.cancelled && record.cancelling) {
        this.finishCancelled(record, cancelledReason(record.cancelling), startTime, record.cancelling)
        return
      }
      if (!outcome.ok && outcome.err instanceof JobCancelledError) {
        this.finishCancelled(record, outcome.err.message, startTime)
        return
      }
      if (!outcome.ok)
        throw outcome.err
      const result = outcome.result
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
      const base = err instanceof Error ? err.message : String(err)
      // The marker's suffix (rclone.5 review): the accepted cancel is part of
      // the run's story, so the reason tells it — a cancel that was asked for
      // and then had nothing to stop. `cancelling` is still set here (it is
      // only cleared when the hook itself fails, which is not this path).
      const message = err instanceof JobFailedDespiteCancelError && record.cancelling
        ? `${base} (a cancel was requested at ${record.cancelling.at} but the run failed before it could be stopped)`
        : base
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
      if (!record.control)
        this.running--
      this.evict()
      this.drain()
    }
  }

  /**
   * End a job `cancelled`: the result says who and when (or what the body
   * reported), the error stays null — a cancel is not a failure — and the
   * audit line is `job.cancelled` naming the user who cancelled.
   */
  private finishCancelled(record: JobRecord, reason: string, startTime: number, by?: JobCancellation): void {
    const { job, submitter } = record
    job.status = 'cancelled'
    job.error = null
    job.result = {
      status: 'cancelled',
      reason,
      ...(by ? { cancelledBy: by.user, cancelledAt: by.at } : {}),
    }
    this.audit?.cancelled(
      {
        user: submitter.user,
        uid: submitter.uid,
        operation: job.operation,
        params: submitter.params,
        requestId: submitter.requestId,
      },
      { durationMs: Date.now() - startTime, reason, ...(by ? { cancelledBy: by.user } : {}) },
    )
  }
}

/** The sentence for a refused cancel — the same words the route's 404/409 carry. */
export function cancelRefusalMessage(refusal: CancelRefusal, id: string): string {
  switch (refusal.reason) {
    case 'not-found':
      return `Job '${id}' not found`
    case 'finished':
      return `Job '${id}' (${refusal.job.operation}) is not running — it already ended ${refusal.job.status}`
    case 'not-cancellable':
      // A QUEUED job has no hook yet — the body registers one when it starts —
      // so it is refused, but with its own sentence (rclone.5 review): "has
      // been running" would be a lie about a run that has not started.
      if (refusal.job.status === 'queued' && refusal.job.startedAt === null)
        return `Job '${id}' (${refusal.job.operation}) is queued and has not started — it can be cancelled once it starts`
      return `Job '${id}' (${refusal.job.operation}) cannot be cancelled — it registers no way to stop its work; wait for it to finish`
    case 'in-progress':
      return `Job '${id}' (${refusal.job.operation}) is already being cancelled (${cancelledReason(refusal.by)})`
  }
}
