import type { SpawnedChild } from '../../executor/types.js'
import type { CancelHook, CancelMeta, JobCancellation, JobContext } from '../queue.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { ProdExecutor } from '../../executor/prod.js'
import { assertRunNotCancelled, CANCEL_SIGNAL_WAIT_MS, ChildCancel, stopChild } from '../child-cancel.js'
import { JobCancelledError } from '../queue.js'

/**
 * rclone.5 — the ONE cancel hook the cloud and backup direct runs register:
 * SIGINT, wait, a second SIGINT, wait, then fail with the reason (the run
 * continues). Driven over the mock executor's live children, whose `kill`
 * the mock records, and once over a real process.
 */

const TOOL = '/usr/bin/tool'
/** Short waits: the ladder's timing is the parameter, not the subject. */
const FAST = { waitMs: 20 }

/** Spawn one live mock child and hand back its handle + the exec's promise. */
async function liveChild(mock: MockExecutor): Promise<{ child: SpawnedChild, done: Promise<unknown> }> {
  let child: SpawnedChild | undefined
  const done = mock.exec(TOOL, [], { onSpawn: (c) => {
    child = c
  } })
  await new Promise(r => setImmediate(r))
  assert.ok(child, 'the live fixture handed over a child')
  return { child, done }
}

/** A minimal job context: the hook it received, and a settable cancellation. */
function fakeCtx(): { ctx: JobContext, hook: () => CancelHook | undefined, meta: () => CancelMeta | undefined, set: (c: JobCancellation | null) => void } {
  let hook: CancelHook | undefined
  let meta: CancelMeta | undefined
  let cancellation: JobCancellation | null = null
  return {
    ctx: {
      onCancel: (h, m) => {
        hook = h
        meta = m
      },
      cancellation: () => cancellation,
      updateDetail: () => {},
    },
    hook: () => hook,
    meta: () => meta,
    set: (c) => {
      cancellation = c
    },
  }
}

describe('stopChild — the SIGINT ladder (rclone.5)', () => {
  it('the default wait is 10 s per signal', () => {
    assert.equal(CANCEL_SIGNAL_WAIT_MS, 10_000)
  })

  it('one SIGINT that the child obeys is the whole cancel', async () => {
    const mock = new MockExecutor().addFixture({ command: TOOL, live: { signalsToExit: 1 } })
    const { child, done } = await liveChild(mock)
    const t0 = Date.now()
    await stopChild(child, 'rclone', { waitMs: 2000 })
    assert.ok(Date.now() - t0 < 1000, 'returned on the exit, not on the wait')
    assert.deepEqual(mock.signals.map(s => s.signal), ['SIGINT'])
    const r = await done as { signal?: string }
    assert.equal(r.signal, 'SIGINT')
  })

  it('a child still alive after the wait gets a SECOND SIGINT, and stops', async () => {
    const mock = new MockExecutor().addFixture({ command: TOOL, live: { signalsToExit: 2 } })
    const { child } = await liveChild(mock)
    await stopChild(child, 'rclone', FAST)
    assert.deepEqual(mock.signals.map(s => s.signal), ['SIGINT', 'SIGINT'])
    assert.equal(child.exited(), true)
  })

  it('a child that survives both fails the cancel with the reason — and is left running', async () => {
    const mock = new MockExecutor().addFixture({ command: TOOL, live: { signalsToExit: Number.POSITIVE_INFINITY } })
    const { child } = await liveChild(mock)
    await assert.rejects(
      stopChild(child, 'rclone', FAST),
      /rclone \(pid \d+\) did not stop after two SIGINTs 0 s apart — the run continues/,
    )
    assert.deepEqual(mock.signals.map(s => s.signal), ['SIGINT', 'SIGINT'], 'never a SIGKILL')
    assert.equal(child.exited(), false, 'the run continues')
    mock.finishLive()
  })

  it('a child that cannot be signalled fails the cancel — the run continues on its own (rclone.5 review)', async () => {
    const mock = new MockExecutor().addFixture({ command: TOOL, live: {} })
    const { child } = await liveChild(mock)
    mock.finishLive()
    await new Promise(r => setImmediate(r))
    await assert.rejects(
      stopChild(child, 'rclone', FAST),
      /rclone \(pid \d+\) could not be signalled \(it may have already exited\); the run continues on its own/,
    )
    assert.equal(mock.signals.length, 0)
  })

  it('reaches a REAL process through the production executor (SIGINT, exit observed)', async () => {
    const exec = new ProdExecutor()
    let child: SpawnedChild | undefined
    const done = exec.exec('/usr/bin/sleep', ['30'], { onSpawn: (c) => {
      child = c
    } })
    assert.ok(child && typeof child.pid === 'number', 'onSpawn handed over the pid')
    await stopChild(child, 'sleep', { waitMs: 5000 })
    const r = await done
    assert.equal(r.signal, 'SIGINT', 'sleep died of the SIGINT the ladder sent')
    assert.equal(child.exited(), true)
  })
})

describe('ChildCancel — wiring the hook to the job (rclone.5)', () => {
  it('registers ONE hook with the subject and consequence the 409 headline shows', () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', { subject: 'Cloud sync task \'photos\'', consequence: 'x' }, FAST)
    assert.ok(f.hook())
    assert.deepEqual(f.meta(), { subject: 'Cloud sync task \'photos\'', consequence: 'x' })
    assert.equal(cancel.requested(), false)
  })

  it('the hook stops the child the exec handed over', async () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    const mock = new MockExecutor().addFixture({ command: TOOL, live: {} })
    const done = mock.exec(TOOL, [], { onSpawn: cancel.onSpawn })
    await new Promise(r => setImmediate(r))
    const by = { user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' }
    f.set(by)
    await f.hook()!(by)
    assert.deepEqual(mock.signals.map(s => s.signal), ['SIGINT'])
    await done
    assert.equal(cancel.requested(), true)
  })

  it('a cancel accepted BEFORE the child exists stops it the moment it spawns', async () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    const by = { user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' }
    f.set(by)
    await f.hook()!(by) // nothing to signal yet: accepted at once
    const mock = new MockExecutor().addFixture({ command: TOOL, live: {} })
    const r = await mock.exec(TOOL, [], { onSpawn: cancel.onSpawn })
    assert.deepEqual(mock.signals.map(s => s.signal), ['SIGINT'])
    assert.equal(r.signal, 'SIGINT')
  })

  it('no job context (a caller outside the queue) = nothing registered, nothing requested', () => {
    const cancel = new ChildCancel(undefined, 'rclone')
    assert.equal(cancel.requested(), false)
  })

  it('signalled() is false until a SIGINT actually went out, and true after one did (rclone.5 review)', async () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    assert.equal(cancel.signalled(), false, 'nothing delivered before anything ran')
    const mock = new MockExecutor().addFixture({ command: TOOL, live: {} })
    const done = mock.exec(TOOL, [], { onSpawn: cancel.onSpawn })
    await new Promise(r => setImmediate(r))
    const by = { user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' }
    f.set(by)
    await f.hook()!(by)
    assert.equal(cancel.signalled(), true, 'the hook delivered the SIGINT')
    await done
  })

  it('signalled() stays FALSE when the hook failed — a run that ended on its own was not stopped on purpose', async () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    const mock = new MockExecutor().addFixture({ command: TOOL, live: {} })
    const done = mock.exec(TOOL, [], { onSpawn: cancel.onSpawn })
    await new Promise(r => setImmediate(r))
    mock.finishLive()
    await new Promise(r => setImmediate(r))
    f.set({ user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' })
    await assert.rejects(
      f.hook()!({ user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' }),
      /could not be signalled/,
    )
    assert.equal(cancel.signalled(), false, 'no signal was ever delivered')
    assert.equal(cancel.requested(), true, 'the cancellation is still recorded as requested')
    await done
  })

  it('signalled() stays FALSE when the hook resolved with no child at all (accepted before the spawn)', async () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    f.set({ user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' })
    await f.hook()!({ user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' })
    assert.equal(cancel.signalled(), false, 'there was nothing to signal')
    assert.equal(cancel.requested(), true)
  })
})

describe('assertRunNotCancelled — the pre-flight boundary (rclone.5 review)', () => {
  it('passes when no cancel is pending or accepted', () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    assert.doesNotThrow(() => assertRunNotCancelled(cancel, 'the rclone run'))
  })

  it('throws the cancellation with the step it skipped when one was accepted', () => {
    const f = fakeCtx()
    const cancel = new ChildCancel(f.ctx, 'rclone', {}, FAST)
    const by = { user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' }
    f.set(by)
    assert.throws(
      () => assertRunNotCancelled(cancel, 'the transient snapshot'),
      (err: unknown) => err instanceof JobCancelledError
        && err.message === 'cancelled by alice@pve at 2026-09-25T14:02:11.000Z before the transient snapshot',
    )
  })
})
