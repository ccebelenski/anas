import type { LockClaim } from '../locks.js'
import type { JobContext } from '../queue.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JobQueue } from '../queue.js'

/**
 * cr3.core CORE-L5: `drain()` must not be re-entered. A job body runs
 * synchronously from `drain` up to its first await; a body that gives its
 * locks back (`ctx.release()`), submits a job, or throws before that await
 * used to call `drain` again from inside the outer drain's loop. The nested
 * drain started the next waiting job; the outer loop then reached the same
 * job in its stale snapshot and started it a SECOND time (the reviewer's
 * probe: body starts { B: 1, C: 2 }).
 */

const WHO = { user: 'root@pam', uid: 0 }
const claim = (mode: 'shared' | 'exclusive'): LockClaim[] => [{ key: 'k', mode, what: 'K' }]

async function settle(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('cr3 CORE-L5: drain is not re-entered by a job body', () => {
  it('a body that releases its locks before its first await: the next waiting job starts once', async () => {
    const q = new JobQueue({ concurrency: 4 })
    const starts: Record<string, number> = {}
    let releaseA!: () => void
    q.submit('A', WHO, () => new Promise<void>((resolve) => {
      releaseA = resolve
    }), { locks: claim('exclusive') })
    const body = (name: string) => (_p: (m: string) => void, ctx: JobContext) => {
      starts[name] = (starts[name] ?? 0) + 1
      if (name === 'B')
        ctx.release()
      return new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    q.submit('B', WHO, body('B'), { locks: claim('shared') })
    q.submit('C', WHO, body('C'), { locks: claim('shared') })
    await settle(5)
    releaseA()
    await settle(80)
    assert.deepEqual(starts, { B: 1, C: 1 })
  })

  it('a body that throws before its first await: the job behind it starts once', async () => {
    const q = new JobQueue({ concurrency: 4 })
    const starts: Record<string, number> = {}
    let releaseA!: () => void
    q.submit('A', WHO, () => new Promise<void>((resolve) => {
      releaseA = resolve
    }), { locks: claim('exclusive') })
    q.submit('B', WHO, () => {
      starts.B = (starts.B ?? 0) + 1
      throw new Error('synchronous failure')
    }, { locks: claim('shared') })
    q.submit('C', WHO, () => {
      starts.C = (starts.C ?? 0) + 1
      return new Promise<void>(resolve => setTimeout(resolve, 20))
    }, { locks: claim('shared') })
    q.submit('D', WHO, () => {
      starts.D = (starts.D ?? 0) + 1
      return new Promise<void>(resolve => setTimeout(resolve, 20))
    }, { locks: claim('shared') })
    await settle(5)
    releaseA()
    await settle(120)
    assert.deepEqual(starts, { B: 1, C: 1, D: 1 })
  })

  it('a body that submits a job before its first await: every job starts exactly once', async () => {
    const q = new JobQueue({ concurrency: 4 })
    const starts: Record<string, number> = {}
    const count = (name: string) => {
      starts[name] = (starts[name] ?? 0) + 1
    }
    q.submit('A', WHO, () => {
      count('A')
      q.submit('A2', WHO, () => {
        count('A2')
        return new Promise<void>(resolve => setTimeout(resolve, 10))
      })
      return new Promise<void>(resolve => setTimeout(resolve, 10))
    })
    q.submit('B', WHO, () => {
      count('B')
      return new Promise<void>(resolve => setTimeout(resolve, 10))
    })
    await settle(60)
    assert.deepEqual(starts, { A: 1, A2: 1, B: 1 })
  })
})
