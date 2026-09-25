import type { Job, JobAccepted } from '@anas/shared'
import type { AuditLogger } from '../../audit/logger.js'
import type { CancelHook } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { cancelHeadline, formatElapsed, jobRoutes } from '../jobs.js'

/**
 * rclone.5 — `POST /v1/jobs/:id/cancel`, confirm-gated like every irreversible
 * verb: the first call answers 409 with `X-Anas-Confirm-Code` and the headline
 * (subject, elapsed time, progress) plus the job's consequence sentence; the
 * replay with the code submits the cancel job, which runs the target's hook.
 * A finished or hook-less job is refused with its sentence before any code is
 * minted.
 */

function headers(user = 'alice@pve'): Record<string, string> {
  return {
    'x-anas-user': user,
    'x-anas-user-uid': '0',
    'x-anas-request-id': randomUUID(),
  }
}

interface AuditLine { event: string, user: string, operation: string, submittedBy?: string }

async function build() {
  const lines: AuditLine[] = []
  const audit = {
    submitted(e: { user: string, operation: string }) {
      lines.push({ event: 'job.submitted', user: e.user, operation: e.operation })
    },
    finished(e: { user: string, operation: string }, r: { status: string }) {
      lines.push({ event: `job.${r.status}`, user: e.user, operation: e.operation })
    },
    cancelled(e: { user: string, operation: string }, c: { cancelledBy?: string }) {
      lines.push({ event: 'job.cancelled', user: c.cancelledBy ?? e.user, submittedBy: e.user, operation: e.operation })
    },
  } as unknown as AuditLogger
  const jobQueue = new JobQueue({ audit })
  const server = Fastify({ logger: false })
  await server.register(jobRoutes, { prefix: '/v1', jobQueue, confirmStore: new ConfirmStore() })
  return { server, jobQueue, lines }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await new Promise(r => setImmediate(r))
}

async function waitTerminal(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = jobQueue.get(id)
    if (job && job.status !== 'queued' && job.status !== 'running')
      return job
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

/**
 * A running "cloud sync run": it registers a hook (whose SIGINT ends the
 * body's exec — here, a promise the hook resolves) and reports progress.
 */
function submitRun(jobQueue: JobQueue, hook?: CancelHook): { id: string, calls: () => number } {
  let calls = 0
  let stop: () => void = () => {}
  const ref = jobQueue.submit('cloud.task.run', { user: 'root@pam', uid: 0, params: { task: 'photos', direct: true } }, async (progress, ctx) => {
    ctx.onCancel(hook ?? (async () => {
      calls++
      stop()
    }), {
      subject: 'Cloud sync task \'photos\'',
      consequence: 'Files already copied stay at the destination. A sync run stopped part-way leaves the destination between two states until the next run completes.',
    })
    progress('copy: 1203 of 9800 bytes, 3 transferred, 0 checked, 0 deleted, 0 errors, ETA 60s')
    await new Promise<void>((resolve) => {
      stop = resolve
    })
    throw new Error('rclone copy failed (exit 130)')
  })
  return { id: ref.id, calls: () => calls }
}

describe('formatElapsed / cancelHeadline (rclone.5)', () => {
  it('says a duration in at most two units', () => {
    assert.equal(formatElapsed(12_000), '12 s')
    assert.equal(formatElapsed(185_000), '3 m 5 s')
    assert.equal(formatElapsed((2 * 3600 + 14 * 60 + 9) * 1000), '2 h 14 m')
    assert.equal(formatElapsed((26 * 3600) * 1000), '1 d 2 h')
    assert.equal(formatElapsed(-5), '0 s')
  })

  it('names the task, the elapsed time and the progress, and says what cancelling does', () => {
    const job = {
      id: 'x',
      status: 'running',
      operation: 'cloud.task.run',
      progress: 'copy: 1203 of 9800 bytes',
      createdAt: '2026-09-25T10:00:00.000Z',
      createdBy: 'root@pam',
      startedAt: '2026-09-25T10:00:00.000Z',
      completedAt: null,
      result: null,
      error: null,
    } as Job
    const now = Date.parse('2026-09-25T12:14:00.000Z')
    assert.equal(
      cancelHeadline(job, { subject: 'Cloud sync task \'photos\'' }, now),
      'Cloud sync task \'photos\' has been running for 2 h 14 m — copy: 1203 of 9800 bytes; cancelling stops it here',
    )
    // Any other cancellable job is named by its operation; no progress, no dash.
    assert.equal(
      cancelHeadline({ ...job, progress: null }, {}, now),
      'Job \'cloud.task.run\' has been running for 2 h 14 m; cancelling stops it here',
    )
  })
})

describe('POST /v1/jobs/:id/cancel (rclone.5)', () => {
  it('first call: 409 with a confirm code, the headline and the consequence — and nothing is cancelled', async () => {
    const { server, jobQueue } = await build()
    const run = submitRun(jobQueue)
    await settle()
    const res = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers() })
    assert.equal(res.statusCode, 409)
    assert.ok(res.headers['x-anas-confirm-code'], 'a confirm code')
    const err = (res.json() as { error: { code: string, message: string, warnings: string[] } }).error
    assert.equal(err.code, 'CONFIRMATION_REQUIRED')
    assert.match(err.message, /^Cloud sync task 'photos' has been running for \d+ s — copy: 1203 of 9800 bytes, 3 transferred, 0 checked, 0 deleted, 0 errors, ETA 60s; cancelling stops it here$/)
    assert.equal(err.warnings[0], err.message, 'the dialog shows the headline')
    assert.match(err.warnings[1], /^Files already copied stay at the destination\. A sync run stopped part-way/)
    assert.equal(run.calls(), 0, 'no hook ran on the unconfirmed call')
    assert.equal(jobQueue.get(run.id)?.status, 'running')
    await server.close()
  })

  it('the replay with the code submits the cancel job, which runs the hook once and ends the run `cancelled`', async () => {
    const { server, jobQueue, lines } = await build()
    const run = submitRun(jobQueue)
    await settle()
    const first = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers() })
    const code = String(first.headers['x-anas-confirm-code'])
    const res = await server.inject({
      method: 'POST',
      url: `/v1/jobs/${run.id}/cancel`,
      headers: { ...headers(), 'x-anas-confirm': code },
    })
    assert.equal(res.statusCode, 202, res.body)
    const cancelJob = (res.json() as JobAccepted).job
    assert.equal(cancelJob.operation, 'job.cancel')
    const done = await waitTerminal(jobQueue, cancelJob.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal((done.result as { cancelledBy: string }).cancelledBy, 'alice@pve')

    const target = await waitTerminal(jobQueue, run.id)
    assert.equal(run.calls(), 1, 'the hook ran exactly once')
    assert.equal(target.status, 'cancelled')
    assert.match((target.result as { reason: string }).reason, /^cancelled by alice@pve at /)
    assert.equal(target.error, null)
    // The audit trail: the cancel job itself, and job.cancelled naming who.
    assert.ok(lines.some(l => l.event === 'job.submitted' && l.operation === 'job.cancel' && l.user === 'alice@pve'))
    const cancelled = lines.find(l => l.event === 'job.cancelled')
    assert.deepEqual(cancelled, { event: 'job.cancelled', user: 'alice@pve', submittedBy: 'root@pam', operation: 'cloud.task.run' })
    // A code is single-use: the same code again is a fresh 409, not a second cancel.
    const again = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: { ...headers(), 'x-anas-confirm': code } })
    assert.equal(again.statusCode, 409)
    await server.close()
  })

  it('a hook that cannot stop the run fails the cancel job with the reason; the run continues', async () => {
    const { server, jobQueue } = await build()
    const run = submitRun(jobQueue, async () => {
      throw new Error('rclone (pid 4242) did not stop after two SIGINTs 10 s apart — the run continues')
    })
    await settle()
    const first = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers() })
    const res = await server.inject({
      method: 'POST',
      url: `/v1/jobs/${run.id}/cancel`,
      headers: { ...headers(), 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) },
    })
    assert.equal(res.statusCode, 202)
    const done = await waitTerminal(jobQueue, (res.json() as JobAccepted).job.id)
    assert.equal(done.status, 'failed')
    assert.match(done.error?.message ?? '', /did not stop after two SIGINTs 10 s apart — the run continues/)
    assert.equal(jobQueue.get(run.id)?.status, 'running')
    await server.close()
  })

  it('a job with no hook: 409 not-cancellable with the sentence, no confirm code', async () => {
    const { server, jobQueue } = await build()
    const ref = jobQueue.submit('pool.scrub', { user: 'u', uid: 0 }, () => new Promise(() => {}))
    await settle()
    const res = await server.inject({ method: 'POST', url: `/v1/jobs/${ref.id}/cancel`, headers: headers() })
    assert.equal(res.statusCode, 409)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    const err = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(err.code, 'NOT_CANCELLABLE')
    assert.match(err.message, /\(pool\.scrub\) cannot be cancelled — it registers no way to stop its work; wait for it to finish/)
    await server.close()
  })

  it('a finished job: 409 with its final state, no confirm code', async () => {
    const { server, jobQueue } = await build()
    const ref = jobQueue.submit('cloud.task.run', { user: 'u', uid: 0 }, async () => ({}))
    await settle()
    const res = await server.inject({ method: 'POST', url: `/v1/jobs/${ref.id}/cancel`, headers: headers() })
    assert.equal(res.statusCode, 409)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    assert.match((res.json() as { error: { message: string } }).error.message, /is not running — it already ended completed/)
    await server.close()
  })

  it('an unknown job is 404; a request without identity is 401', async () => {
    const { server } = await build()
    const missing = await server.inject({ method: 'POST', url: '/v1/jobs/nope/cancel', headers: headers() })
    assert.equal(missing.statusCode, 404)
    const anon = await server.inject({ method: 'POST', url: '/v1/jobs/nope/cancel' })
    assert.equal(anon.statusCode, 401)
    await server.close()
  })

  it('GET /v1/jobs?status=cancelled is a valid filter', async () => {
    const { server } = await build()
    const res = await server.inject({ method: 'GET', url: '/v1/jobs?status=cancelled' })
    assert.equal(res.statusCode, 200)
    await server.close()
  })
})
