import type { Job } from '@anas/shared'
import type { AuditLogger } from '../../audit/logger.js'
import type { CancelHook, JobContext } from '../queue.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { assertRunNotCancelled, ChildCancel } from '../child-cancel.js'
import { JobCancelledError, JobFailedDespiteCancelError, JobQueue } from '../queue.js'

/**
 * The job queue's correlation queries.
 *
 * `findByOperation` answers "how did the latest attempt on this resource end?"
 * and `findActive` answers "is one of these running on it right now?" — two
 * different questions, and the second one is what a mutual-exclusion gate has
 * to ask (review R7). Asking the first let a newer TERMINAL job hide an older
 * running one, and the exclusion silently stopped holding.
 */

async function noop(): Promise<void> {}
async function forever(): Promise<void> {
  return new Promise(() => {})
}

/** Let the queue drain so submitted jobs reach their terminal state. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('JobQueue.findActive', () => {
  it('finds a job still in flight for the operation and target', () => {
    const queue = new JobQueue()
    const ref = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    assert.equal(queue.findActive('ahr.repair', 'tank')?.id, ref.id)
    assert.equal(queue.findActive('ahr.repair', 'other'), undefined)
    assert.equal(queue.findActive('ahr.scrub', 'tank'), undefined)
  })

  it('is NOT hidden by a newer terminal job for the same pool', async () => {
    const queue = new JobQueue()
    const running = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, noop)
    await settle()

    // The question the old gate asked answers with the FINISHED job…
    assert.equal(queue.findByOperation('ahr.repair', 'tank')?.status, 'completed')
    // …while the repair is still running, and this is the one that says so.
    assert.equal(queue.findActive('ahr.repair', 'tank')?.id, running.id)
  })

  it('answers for a SET of operations, and ignores terminal ones', async () => {
    const queue = new JobQueue()
    queue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'tank' } }, noop)
    await settle()
    assert.equal(queue.findActive(['ahr.scrub', 'ahr.repair'], 'tank'), undefined)

    const running = queue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    assert.equal(queue.findActive(['ahr.scrub', 'ahr.repair'], 'tank')?.id, running.id)
  })

  it('queued counts as in flight — the gate is at SUBMIT, not at start', () => {
    const queue = new JobQueue({ concurrency: 1 })
    queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'a' } }, forever)
    const queued = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'b' } }, forever)
    assert.equal(queue.get(queued.id)?.status, 'queued')
    assert.equal(queue.findActive('ahr.repair', 'b')?.id, queued.id)
  })

  it('matches on the named param key, and never on a job with no params', () => {
    const queue = new JobQueue()
    const ref = queue.submit('backup.restore.image', { user: 'u', uid: 0, params: { target: 'iqn.x' } }, forever)
    assert.equal(queue.findActive('backup.restore.image', 'iqn.x', 'target')?.id, ref.id)
    assert.equal(queue.findActive('backup.restore.image', 'iqn.x'), undefined, 'the default key is params.name')
    queue.submit('ahr.repair', { user: 'u', uid: 0 }, forever)
    assert.equal(queue.findActive('ahr.repair', ''), undefined)
  })

  it('returns the OLDEST job still in flight when several are', () => {
    const queue = new JobQueue()
    const first = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    queue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    assert.equal(queue.findActive(['ahr.scrub', 'ahr.repair'], 'tank')?.id, first.id)
  })
})

/**
 * rclone.5 — cancellation. A running job may register ONE hook from inside its
 * body; `cancel` runs it once, and when it reports the work stopped the job
 * ends `cancelled` whatever the body does next. A job with no hook, or one that
 * already ended, is refused with its sentence.
 */
describe('JobQueue.cancel (rclone.5)', () => {
  /** A body that registers `hook`, then waits until `release` is called. */
  function cancellable(hook: CancelHook): { handler: (p: (m: string) => void, ctx: JobContext) => Promise<unknown>, release: (err?: Error) => void, seen: () => JobContext | undefined } {
    let release: (err?: Error) => void = () => {}
    let ctxSeen: JobContext | undefined
    return {
      handler: async (_p, ctx) => {
        ctxSeen = ctx
        ctx.onCancel(hook, { subject: 'Cloud sync task \'photos\'' })
        await new Promise<void>((resolve, reject) => {
          release = err => (err ? reject(err) : resolve())
        })
        return { status: 'success' }
      },
      release: err => release(err),
      seen: () => ctxSeen,
    }
  }

  it('runs the hook ONCE and the job ends `cancelled` with who and when', async () => {
    const queue = new JobQueue()
    let calls = 0
    const body: ReturnType<typeof cancellable> = cancellable(async () => {
      calls++
      // The signal stops the child — the body's exec then ends (here: throws).
      body.release(new Error('rclone exited 130'))
    })
    const ref = queue.submit('cloud.task.run', { user: 'root@pam', uid: 0, params: { task: 'photos', direct: true } }, body.handler)
    await settle()
    const by = await queue.cancel(ref.id, 'alice@pve')
    await settle()
    assert.equal(calls, 1)
    assert.equal(by.user, 'alice@pve')
    const job = queue.get(ref.id)!
    assert.equal(job.status, 'cancelled')
    assert.equal(job.error, null, 'a cancel is not a failure')
    const result = job.result as { status: string, reason: string, cancelledBy: string }
    assert.equal(result.status, 'cancelled')
    assert.equal(result.cancelledBy, 'alice@pve')
    assert.match(result.reason, /^cancelled by alice@pve at \d{4}-\d{2}-\d{2}T/)
    assert.ok(job.completedAt)
  })

  it('the body sees the cancellation while it unwinds (so it can skip its notification)', async () => {
    const queue = new JobQueue()
    let seenDuring: unknown = 'unset'
    const body: ReturnType<typeof cancellable> = cancellable(async () => {
      seenDuring = body.seen()?.cancellation()
      body.release()
    })
    const ref = queue.submit('cloud.task.run', { user: 'root@pam', uid: 0 }, body.handler)
    await settle()
    assert.equal(body.seen()?.cancellation(), null, 'no cancel yet')
    await queue.cancel(ref.id, 'alice@pve')
    await settle()
    assert.equal((seenDuring as { user: string }).user, 'alice@pve')
    // A body that even COMPLETED after the accepted cancel still ends cancelled.
    assert.equal(queue.get(ref.id)?.status, 'cancelled')
  })

  it('a job with no hook is refused as not cancellable — and keeps running', async () => {
    const queue = new JobQueue()
    const ref = queue.submit('pool.scrub', { user: 'u', uid: 0 }, forever)
    await settle()
    const target = queue.cancelTarget(ref.id)
    assert.ok('reason' in target && target.reason === 'not-cancellable')
    await assert.rejects(queue.cancel(ref.id, 'alice@pve'), /cannot be cancelled — it registers no way to stop its work/)
    assert.equal(queue.get(ref.id)?.status, 'running')
  })

  it('a finished job is refused with its final state in the sentence', async () => {
    const queue = new JobQueue()
    const ok = queue.submit('cloud.task.run', { user: 'u', uid: 0 }, noop)
    const bad = queue.submit('cloud.task.run', { user: 'u', uid: 0 }, async () => {
      throw new Error('boom')
    })
    await settle()
    await assert.rejects(queue.cancel(ok.id, 'alice@pve'), /is not running — it already ended completed/)
    await assert.rejects(queue.cancel(bad.id, 'alice@pve'), /is not running — it already ended failed/)
    const t = queue.cancelTarget(ok.id)
    assert.ok('reason' in t && t.reason === 'finished')
  })

  it('an unknown job is not-found', async () => {
    const queue = new JobQueue()
    const t = queue.cancelTarget('nope')
    assert.ok('reason' in t && t.reason === 'not-found')
    await assert.rejects(queue.cancel('nope', 'u'), /Job 'nope' not found/)
  })

  it('a hook that cannot stop the work fails the cancel and the job carries on', async () => {
    const queue = new JobQueue()
    const body = cancellable(async () => {
      throw new Error('rclone (pid 4000) did not stop after two SIGINTs 10 s apart — the run continues')
    })
    const ref = queue.submit('cloud.task.run', { user: 'u', uid: 0 }, body.handler)
    await settle()
    await assert.rejects(queue.cancel(ref.id, 'alice@pve'), /did not stop after two SIGINTs/)
    await settle()
    assert.equal(queue.get(ref.id)?.status, 'running')
    assert.equal(body.seen()?.cancellation(), null, 'the cancellation is withdrawn')
    // …and when the run later finishes on its own, it is a normal completion.
    body.release()
    await settle()
    assert.equal(queue.get(ref.id)?.status, 'completed')
  })

  it('a second cancel while the first is in flight is refused as in progress', async () => {
    const queue = new JobQueue()
    let finish: () => void = () => {}
    const body = cancellable(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const ref = queue.submit('cloud.task.run', { user: 'u', uid: 0 }, body.handler)
    await settle()
    const first = queue.cancel(ref.id, 'alice@pve')
    await assert.rejects(queue.cancel(ref.id, 'bob@pve'), /is already being cancelled \(cancelled by alice@pve at /)
    finish()
    body.release()
    await first
    await settle()
    assert.equal(queue.get(ref.id)?.status, 'cancelled')
  })

  it('a body that reports its WATCHED work was cancelled ends `cancelled`, not failed', async () => {
    const queue = new JobQueue()
    const ref = queue.submit('cloud.task.run', { user: 'u', uid: 0 }, async () => {
      throw new JobCancelledError('cancelled by alice@pve at 2026-09-25T14:02:11.000Z')
    })
    await settle()
    const job = queue.get(ref.id)!
    assert.equal(job.status, 'cancelled')
    assert.equal(job.error, null)
    assert.equal((job.result as { reason: string }).reason, 'cancelled by alice@pve at 2026-09-25T14:02:11.000Z')
  })

  it('audits `job.cancelled` naming the user who cancelled and the submitter', async () => {
    const lines: { event: string, user: string, submittedBy?: string, reason?: string }[] = []
    const audit = {
      submitted() {},
      finished() {},
      cancelled(entry: { user: string }, c: { cancelledBy?: string, reason: string }) {
        lines.push({ event: 'job.cancelled', user: c.cancelledBy ?? entry.user, submittedBy: entry.user, reason: c.reason })
      },
    } as unknown as AuditLogger
    const queue = new JobQueue({ audit })
    const body: ReturnType<typeof cancellable> = cancellable(async () => body.release())
    const ref = queue.submit('cloud.task.run', { user: 'root@pam', uid: 0 }, body.handler)
    await settle()
    await queue.cancel(ref.id, 'alice@pve')
    await settle()
    assert.equal(lines.length, 1)
    assert.equal(lines[0].user, 'alice@pve')
    assert.equal(lines[0].submittedBy, 'root@pam')
    assert.match(lines[0].reason ?? '', /^cancelled by alice@pve at /)
  })

  it('a CONTROL job runs at once, even with every slot held', async () => {
    const queue = new JobQueue({ concurrency: 1 })
    queue.submit('cloud.task.run', { user: 'u', uid: 0 }, forever)
    const queued = queue.submit('cloud.task.run', { user: 'u', uid: 0 }, forever)
    const control = queue.submit('job.cancel', { user: 'u', uid: 0 }, noop, { control: true })
    await settle()
    assert.equal(queue.get(queued.id)?.status, 'queued', 'the ordinary job still waits for the slot')
    assert.equal(queue.get(control.id)?.status, 'completed', 'the control job did not')
    assert.equal(queue.get(queued.id)?.status, 'queued', 'and it never consumed the slot')
  })
})

/**
 * rclone.5 review — the verdict an ACCEPTED cancel leads to. The route bodies'
 * catch appears here in its exact shape (child-cancel.ts and the queue are the
 * units under test): a cancel with no signal delivered never swallows a
 * failure, and a body whose watched work was cancelled ends `cancelled`.
 */
describe('an accepted cancel and the job verdict (rclone.5 review)', () => {
  const TOOL = '/usr/bin/tool'

  async function terminal(queue: JobQueue, id: string): Promise<Job> {
    for (let i = 0; i < 200; i++) {
      const job = queue.get(id)
      if (job && job.status !== 'queued' && job.status !== 'running')
        return job
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  /** A run body shaped like the route bodies': hook at once, then a gated pre-flight. */
  function runBody(
    work: (cancel: ChildCancel) => Promise<unknown>,
    ready: () => void,
    gated: Promise<void>,
  ) {
    return async (_progress: (m: string) => void, ctx: JobContext): Promise<unknown> => {
      const cancel = new ChildCancel(ctx, 'rclone', {}, { waitMs: 20 })
      ready()
      await gated
      return work(cancel)
    }
  }

  it('a run that fails to spawn (ENOENT) after an accepted cancel ends FAILED, with the cancel in the reason', async () => {
    const mock = new MockExecutor().addFixture({
      command: TOOL,
      throws: Object.assign(new Error('spawn /usr/bin/tool ENOENT'), { code: 'ENOENT' }),
    })
    const queue = new JobQueue()
    let release: () => void = () => {}
    const gated = new Promise<void>((r) => {
      release = r
    })
    let up: () => void = () => {}
    const hookIsUp = new Promise<void>((r) => {
      up = r
    })
    const ref = queue.submit(
      'cloud.task.run',
      { user: 'root@pam', uid: 0, params: { task: 'photos', direct: true } },
      runBody(async (cancel) => {
        try {
          return await mock.exec(TOOL, [], { onSpawn: cancel.onSpawn })
        }
        catch (err) {
          if (err instanceof JobCancelledError || (cancel.requested() && cancel.stoppedOnPurpose()))
            return null
          const message = err instanceof Error ? err.message : String(err)
          if (cancel.requested())
            throw new JobFailedDespiteCancelError(message)
          throw err
        }
      }, () => up(), gated),
    )
    await hookIsUp
    await queue.cancel(ref.id, 'alice@pve') // accepted at once: there is no child yet
    release()
    const job = await terminal(queue, ref.id)
    assert.equal(job.status, 'failed')
    assert.match(
      job.error?.message ?? '',
      /^spawn \/usr\/bin\/tool ENOENT \(a cancel was requested at .+ but the run failed before it could be stopped\)$/,
    )
  })

  it('a cancel accepted before the child spawns ends the run CANCELLED at the next boundary — no exec, no signal', async () => {
    const mock = new MockExecutor().addFixture({ command: TOOL, live: {} })
    const queue = new JobQueue()
    let release: () => void = () => {}
    const gated = new Promise<void>((r) => {
      release = r
    })
    let up: () => void = () => {}
    const hookIsUp = new Promise<void>((r) => {
      up = r
    })
    const ref = queue.submit(
      'cloud.task.run',
      { user: 'root@pam', uid: 0, params: { task: 'photos', direct: true } },
      runBody(async (cancel) => {
        assertRunNotCancelled(cancel, 'the rclone run') // the pre-flight boundary, as the route wires it
        return mock.exec(TOOL, [], { onSpawn: cancel.onSpawn })
      }, () => up(), gated),
    )
    await hookIsUp
    await queue.cancel(ref.id, 'alice@pve') // accepted while the body is still in its pre-flight
    release()
    const job = await terminal(queue, ref.id)
    assert.equal(job.status, 'cancelled')
    assert.match((job.result as { reason: string }).reason, /^cancelled by alice@pve at /)
    assert.equal(mock.calls.length, 0, 'the exec never happened')
    assert.equal(mock.signals.length, 0, 'nothing was ever signalled')
  })
})
