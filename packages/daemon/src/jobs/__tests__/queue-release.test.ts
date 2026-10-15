import type { Job } from '@anas/shared'
import type { GuardSpec } from '../../safety/guard.js'
import type { LockClaim } from '../locks.js'
import type { JobContext } from '../queue.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AbandonedRegistry, currentLane } from '../../executor/deadline.js'
import { guardCheck, guarded } from '../../safety/guard.js'
import { JobQueue } from '../queue.js'

/**
 * Story cr.38 session B — a long job gives its locks back while it only
 * watches kernel work, and takes them back before its next act step
 * (docs/WAVE3-DESIGN.md §3.2 "Long jobs re-guard per act step", §4.3, §4.4).
 *
 * The queue is driven with steered bodies: each job body runs a script of
 * `release` / `reacquire` / wait points the test opens one at a time, so the
 * test decides exactly when a job lets go and when it asks again.
 */

const SUBMITTER = { user: 'root@pam', uid: 0 }
const X = (key: string, what = `AHR pool '${key}'`): LockClaim => ({ key, mode: 'exclusive', what })
const S = (key: string, what = `AHR pool '${key}'`): LockClaim => ({ key, mode: 'shared', what })

/** Let bodies reach their next await and the queue drain again. */
async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++)
    await new Promise(resolve => setImmediate(resolve))
}

/** A promise the test opens. */
function latch(): { wait: Promise<void>, open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

function status(queue: JobQueue, id: string): Job['status'] | undefined {
  return queue.get(id)?.status
}

/** The queue's private slot counter — what "holds a slot" means. */
function slotsInUse(queue: JobQueue): number {
  return (queue as unknown as { running: number }).running
}

function holders(queue: JobQueue, key: string): string[] {
  return queue.heldLocks().find(l => l.key === key)?.holders ?? []
}

/** A plain job that holds its claims until `end()`. */
function holdJob(queue: JobQueue, op: string, locks: LockClaim[]): { id: string, end: () => void, started: () => boolean } {
  const l = latch()
  let started = false
  const id = queue.submit(op, SUBMITTER, async () => {
    started = true
    await l.wait
    return null
  }, { locks }).id
  return { id, end: l.open, started: () => started }
}

/**
 * A long job: acts (holding its locks), releases, watches until `waitDone`,
 * re-acquires (recording when it got them back), acts again until `actDone`
 * (default: at once), ends.
 */
function longJob(queue: JobQueue, op: string, locks: LockClaim[], opts: { holdAfter?: boolean } = {}) {
  const waitDone = latch()
  const actDone = latch()
  if (!opts.holdAfter)
    actDone.open()
  const events: string[] = []
  let ctx!: JobContext
  const id = queue.submit(op, SUBMITTER, async (_p, c) => {
    ctx = c
    events.push('act 1')
    c.release()
    events.push('released')
    await waitDone.wait
    events.push('reacquiring')
    await c.reacquire()
    events.push('reacquired')
    await actDone.wait
    return null
  }, { locks, lane: 'long' }).id
  return { id, events, finishWait: waitDone.open, finishAct: actDone.open, ctx: () => ctx }
}

describe('cr.38 — release(): a long job lets go of its locks while it watches', () => {
  it('a release hands the key to the job waiting for it; the releasing job keeps its slot', async () => {
    const queue = new JobQueue()
    const a = longJob(queue, 'ahr.expand', [X('ahr:vg1')])
    const b = holdJob(queue, 'ahr.snapshot.rollback', [X('ahr:vg1')])
    await tick()
    assert.deepEqual(a.events, ['act 1', 'released'])
    assert.equal(status(queue, b.id), 'running', 'the waiter got the key the long job gave back')
    assert.deepEqual(holders(queue, 'ahr:vg1'), [b.id])
    assert.equal(status(queue, a.id), 'running', 'the long job is still running (watching)')
    assert.equal(slotsInUse(queue), 2, 'the watching job keeps its slot; the waiter took a second one')
    b.end()
    a.finishWait()
    await tick()
  })

  it('a job with no claims, or one already released, is unchanged by release() and reacquire() resolves at once for it', async () => {
    const queue = new JobQueue()
    let reached = false
    const id = queue.submit('test.nolocks', SUBMITTER, async (_p, c) => {
      c.release()
      c.release()
      await c.reacquire()
      reached = true
      return null
    }).id
    await tick()
    assert.equal(reached, true)
    assert.equal(status(queue, id), 'completed')
  })
})

describe('cr.38 — reacquire(): back through the same FIFO, like a new job', () => {
  it('waits for the job that took the key, names it in its progress line, and holds the key again after', async () => {
    const queue = new JobQueue()
    const a = longJob(queue, 'ahr.expand', [X('ahr:vg1', 'AHR pool \'tank\'')])
    await tick()
    const b = holdJob(queue, 'ahr.spare.add', [X('ahr:vg1', 'AHR pool \'tank\'')])
    await tick()
    assert.equal(status(queue, b.id), 'running')
    a.finishWait()
    await tick()
    assert.deepEqual(a.events, ['act 1', 'released', 'reacquiring'], 'the re-acquire waits while another job holds the key')
    assert.equal(queue.get(a.id)?.progress, `waiting for ahr.spare.add (job ${b.id}) on AHR pool 'tank'`)
    assert.deepEqual(holders(queue, 'ahr:vg1'), [b.id], 'a waiting re-acquire holds nothing')
    b.end()
    await tick()
    assert.deepEqual(a.events, ['act 1', 'released', 'reacquiring', 'reacquired'])
    assert.equal(status(queue, a.id), 'completed')
    assert.equal(queue.get(a.id)?.progress, null, 'the queue takes its waiting line back')
    assert.deepEqual(queue.heldLocks(), [], 'and releases the re-acquired key at the end')
  })

  it('queues BEHIND a job that was already waiting for the key (FIFO), never in front of it', async () => {
    const queue = new JobQueue()
    const a = longJob(queue, 'ahr.expand', [X('ahr:vg1')])
    await tick()
    const b = holdJob(queue, 'ahr.cache.attach', [X('ahr:vg1')])
    const c = holdJob(queue, 'ahr.spare.add', [X('ahr:vg1')])
    await tick()
    assert.equal(status(queue, b.id), 'running')
    assert.equal(status(queue, c.id), 'queued', 'c waits behind b')
    a.finishWait() // a asks again while c is already waiting
    await tick()
    b.end()
    await tick()
    assert.equal(status(queue, c.id), 'running', 'c waited first, so c goes first')
    assert.ok(!a.events.includes('reacquired'), 'a is behind c')
    assert.equal(queue.get(a.id)?.progress, `waiting for ahr.spare.add (job ${c.id}) on AHR pool 'ahr:vg1'`)
    c.end()
    await tick()
    assert.ok(a.events.includes('reacquired'))
  })

  it('a job submitted AFTER the re-acquire does not overtake it on the key, even a shared one', async () => {
    const queue = new JobQueue()
    const a = longJob(queue, 'ahr.expand', [X('ahr:vg1')], { holdAfter: true })
    await tick()
    const b = holdJob(queue, 'ahr.cache.attach', [X('ahr:vg1')])
    await tick()
    a.finishWait()
    await tick()
    const d = holdJob(queue, 'ahr.snapshot.create', [S('ahr:vg1')])
    await tick()
    b.end()
    await tick()
    assert.ok(a.events.includes('reacquired'), 'the re-acquire was first in line')
    assert.equal(status(queue, d.id), 'queued', 'the later shared claim waits for the re-acquired exclusive one')
    assert.deepEqual(holders(queue, 'ahr:vg1'), [a.id])
    a.finishAct()
    await tick()
    assert.equal(status(queue, a.id), 'completed')
    await tick()
    assert.equal(status(queue, d.id), 'running')
    d.end()
    await tick()
  })

  it('a later job does not take a FREE key that a waiting re-acquire also needs (per-key FIFO across all its keys)', async () => {
    const queue = new JobQueue()
    const a = longJob(queue, 'ahr.replace', [X('ahr:vg1'), X('disk:NEW')], { holdAfter: true })
    await tick()
    const b = holdJob(queue, 'ahr.cache.attach', [X('disk:NEW')])
    await tick()
    a.finishWait() // a waits: disk:NEW is b's; ahr:vg1 is free
    await tick()
    const d = holdJob(queue, 'ahr.snapshot.create', [S('ahr:vg1')])
    await tick()
    assert.equal(status(queue, d.id), 'queued', 'd would overtake a on ahr:vg1')
    assert.equal(queue.get(d.id)?.progress, `waiting for ahr.replace (job ${a.id}) on AHR pool 'ahr:vg1'`)
    b.end()
    await tick()
    assert.ok(a.events.includes('reacquired'))
    a.finishAct()
    await tick()
    assert.equal(status(queue, d.id), 'running')
    d.end()
    await tick()
  })

  it('grants are still all-or-nothing: a re-acquire of two keys holds neither while one is taken', async () => {
    const queue = new JobQueue()
    const a = longJob(queue, 'ahr.replace', [X('ahr:vg1'), X('disk:NEW')])
    await tick()
    const b = holdJob(queue, 'ahr.cache.attach', [X('disk:NEW')])
    await tick()
    a.finishWait()
    await tick()
    assert.deepEqual(holders(queue, 'ahr:vg1'), [], 'the free key is not taken while the other is busy')
    assert.deepEqual(holders(queue, 'disk:NEW'), [b.id])
    b.end()
    await tick()
    assert.ok(a.events.includes('reacquired'))
  })

  it('a re-acquire the body never awaited dies with the job: the table never grants locks to an ended job', async () => {
    const queue = new JobQueue()
    const waitDone = latch()
    const id = queue.submit('ahr.expand', SUBMITTER, async (_p, c) => {
      c.release()
      await waitDone.wait
      void c.reacquire()
      throw new Error('the step failed')
    }, { locks: [X('ahr:vg1')] }).id
    await tick()
    const b = holdJob(queue, 'ahr.spare.add', [X('ahr:vg1')])
    await tick()
    waitDone.open()
    await tick()
    assert.equal(status(queue, id), 'failed')
    b.end()
    await tick()
    assert.deepEqual(queue.heldLocks(), [], 'nobody holds the key once both jobs ended')
  })
})

describe('cr.38 — an abandoned child keeps the locks held across a release (§4.4)', () => {
  function abandonedChild(registry: AbandonedRegistry, pid: number): void {
    registry.add({ pid, label: 'mdadm --grow', command: '/usr/sbin/mdadm', args: ['--grow'], lane: 'job', jobId: currentLane().jobId, budgetMs: 300_000, since: new Date().toISOString() })
  }

  it('release() while a command the job ran is still running keeps the key until that command exits', async () => {
    const registry = new AbandonedRegistry()
    const queue = new JobQueue({ abandoned: registry })
    const waitDone = latch()
    const id = queue.submit('ahr.expand', SUBMITTER, async (_p, c) => {
      abandonedChild(registry, 5151)
      c.release()
      await waitDone.wait
      return null
    }, { locks: [X('ahr:vg1')] }).id
    await tick()
    const b = holdJob(queue, 'ahr.spare.add', [X('ahr:vg1')])
    await tick()
    assert.deepEqual(holders(queue, 'ahr:vg1'), [id], 'the release is deferred: the child is still changing the pool')
    assert.equal(status(queue, b.id), 'queued')
    registry.remove(5151)
    await tick()
    assert.deepEqual(holders(queue, 'ahr:vg1'), [b.id], 'the child exited; the deferred release ran')
    b.end()
    waitDone.open()
    await tick()
  })

  it('a re-acquire while the release is still deferred keeps the locks — the later child exit does not drop them', async () => {
    const registry = new AbandonedRegistry()
    const queue = new JobQueue({ abandoned: registry })
    const waitDone = latch()
    const actAgain = latch()
    let reacquired = false
    const id = queue.submit('ahr.expand', SUBMITTER, async (_p, c) => {
      abandonedChild(registry, 6161)
      c.release()
      await waitDone.wait
      await c.reacquire()
      reacquired = true
      await actAgain.wait
      return null
    }, { locks: [X('ahr:vg1')] }).id
    await tick()
    waitDone.open()
    await tick()
    assert.equal(reacquired, true, 'still held, so the re-acquire resolves at once')
    registry.remove(6161)
    await tick()
    assert.deepEqual(holders(queue, 'ahr:vg1'), [id], 'the job acts again under the key; the child exit released nothing')
    actAgain.open()
    await tick()
    assert.deepEqual(queue.heldLocks(), [])
  })
})

describe('cr.38 — the guard\'s reguard() re-acquires before it re-reads and re-gates', () => {
  it('a long job that released waits for the job holding the key, then re-gates against what that job did', async () => {
    const queue = new JobQueue()
    /** The object's live state: the test's other job changes it while the long job watches. */
    const world = { busy: false }
    const spec: GuardSpec<{ busy: boolean }> = {
      operation: 'ahr.expand',
      object: {
        what: 'AHR pool \'tank\'',
        read: async () => ({ ...world }),
        id: async () => ({ vg: 'vg1' }),
        unbound: () => 'unbound',
      },
      gates: [async o => o.busy ? { status: 409, code: 'CONFLICT', message: 'AHR pool \'tank\' is busy now' } : null],
      locks: async () => [X('ahr:vg1')],
    }
    const pre = await guardCheck(spec)
    assert.ok(!('refusal' in pre))
    const waitDone = latch()
    const acted: string[] = []
    const id = queue.submit(spec.operation, SUBMITTER, guarded(spec, pre, async (_o, ctx) => {
      acted.push('step 1')
      ctx.release()
      await waitDone.wait
      await ctx.reguard()
      acted.push('step 2')
      return null
    }), { locks: pre.locks }).id
    await tick()
    const other = holdJob(queue, 'ahr.cache.attach', [X('ahr:vg1')])
    await tick()
    assert.equal(status(queue, other.id), 'running')
    waitDone.open()
    await tick()
    assert.equal(status(queue, id), 'running', 'the reguard waits for the key before it reads anything')
    world.busy = true // what the other job did to the pool
    other.end()
    await tick()
    assert.equal(status(queue, id), 'failed')
    assert.equal(queue.get(id)?.error?.code, 'CONFLICT')
    assert.equal(queue.get(id)?.error?.message, 'AHR pool \'tank\' is busy now')
    assert.deepEqual(acted, ['step 1'], 'step 2 never ran')
  })
})
