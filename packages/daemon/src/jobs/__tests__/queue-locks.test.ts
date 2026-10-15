import type { Job } from '@anas/shared'
import type { LockClaim } from '../locks.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { AbandonedRegistry, CommandTimeoutError, currentLane } from '../../executor/deadline.js'
import { ProdExecutor } from '../../executor/prod.js'
import { LockTable, normaliseClaims } from '../locks.js'
import { JobQueue } from '../queue.js'

/**
 * Story cr.33 — per-object locks and the long lane in the job queue
 * (docs/WAVE3-DESIGN.md §4, §8.2 "Locks"). The queue is driven with gated
 * bodies: each job's body waits on a promise the test resolves, so the test
 * decides when a holder ends — the same pausable pattern the cr.32 race tests
 * use (placeholder jobs holding the slots until released).
 */

const SUBMITTER = { user: 'root@pam', uid: 0 }

const S = (key: string, what = `Pool '${key}'`): LockClaim => ({ key, mode: 'shared', what })
const X = (key: string, what = `Pool '${key}'`): LockClaim => ({ key, mode: 'exclusive', what })

/** A job body the test ends: `end()` completes it, `fail(err)` throws from it. */
interface Gate {
  body: () => Promise<unknown>
  end: () => void
  fail: (err: Error) => void
  started: boolean
}

function gate(): Gate {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const done = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  const g: Gate = {
    started: false,
    end: () => resolve(),
    fail: err => reject(err),
    body: async () => {
      g.started = true
      await done
      return null
    },
  }
  return g
}

/** `n` distinct gates (a filled array would share one). */
function gates(n: number): Gate[] {
  const out: Gate[] = []
  for (let i = 0; i < n; i++)
    out.push(gate())
  return out
}

/** Let finished bodies reach their `finally` and the queue drain again. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
}

function status(queue: JobQueue, id: string): Job['status'] | undefined {
  return queue.get(id)?.status
}

/** The queue's private slot counter — what "holds a slot" means. */
function slotsInUse(queue: JobQueue): number {
  return (queue as unknown as { running: number }).running
}

function submit(queue: JobQueue, op: string, g: Gate, locks: LockClaim[] = [], lane?: 'short' | 'long'): string {
  return queue.submit(op, SUBMITTER, g.body, { locks, ...(lane ? { lane } : {}) }).id
}

describe('cr.33 — lock modes', () => {
  it('shared + shared on one key run together', async () => {
    const queue = new JobQueue()
    const a = gate()
    const b = gate()
    const ida = submit(queue, 'zfs.snapshot', a, [S('zpool:g1')])
    const idb = submit(queue, 'zfs.snapshot', b, [S('zpool:g1')])
    assert.equal(status(queue, ida), 'running')
    assert.equal(status(queue, idb), 'running')
    assert.deepEqual(queue.heldLocks(), [{ key: 'zpool:g1', mode: 'shared', holders: [ida, idb] }])
    a.end()
    b.end()
    await tick()
  })

  it('shared then exclusive serialise, exclusive then exclusive serialise', async () => {
    for (const first of [S, X]) {
      const queue = new JobQueue()
      const a = gate()
      const b = gate()
      const ida = submit(queue, 'first', a, [first('zpool:g1')])
      const idb = submit(queue, 'zpool.destroy', b, [X('zpool:g1')])
      assert.equal(status(queue, ida), 'running')
      assert.equal(status(queue, idb), 'queued', `${first('k').mode} then exclusive: the exclusive waits`)
      assert.equal(b.started, false)
      a.end()
      await tick()
      assert.equal(status(queue, ida), 'completed')
      assert.equal(status(queue, idb), 'running', 'it starts when the holder ends')
      b.end()
      await tick()
    }
  })

  it('exclusive then shared serialise; different keys never wait for each other', async () => {
    const queue = new JobQueue()
    const a = gate()
    const b = gate()
    const c = gate()
    const ida = submit(queue, 'zpool.export', a, [X('zpool:g1')])
    const idb = submit(queue, 'zfs.snapshot', b, [S('zpool:g1')])
    const idc = submit(queue, 'zpool.export', c, [X('zpool:g2')])
    assert.equal(status(queue, ida), 'running')
    assert.equal(status(queue, idb), 'queued')
    assert.equal(status(queue, idc), 'running', 'another pool is another key')
    a.end()
    await tick()
    assert.equal(status(queue, idb), 'running')
    b.end()
    c.end()
    await tick()
  })

  it('a job naming one key twice gets the stronger mode, once', () => {
    assert.deepEqual(normaliseClaims([S('k', 'a'), X('k', 'b'), S('j')]), [X('k', 'a'), S('j')])
  })
})

describe('cr.33 — order: per-key FIFO, no starvation, no deadlock', () => {
  it('a queued exclusive blocks a LATER shared claim even though the holder is shared (FIFO)', async () => {
    const queue = new JobQueue()
    const s1 = gate()
    const x = gate()
    const s2 = gate()
    const ids1 = submit(queue, 'zfs.replicate', s1, [S('zpool:g1')])
    const idx = submit(queue, 'zpool.destroy', x, [X('zpool:g1')])
    const ids2 = submit(queue, 'zfs.snapshot', s2, [S('zpool:g1')])
    assert.equal(status(queue, ids1), 'running')
    assert.equal(status(queue, idx), 'queued')
    assert.equal(status(queue, ids2), 'queued', 'the later shared claim does not overtake the queued exclusive')
    assert.equal(queue.get(ids2)?.progress, `waiting for zpool.destroy (job ${idx}) on Pool 'zpool:g1'`)
    s1.end()
    await tick()
    assert.equal(status(queue, idx), 'running')
    assert.equal(status(queue, ids2), 'queued')
    x.end()
    await tick()
    assert.equal(status(queue, ids2), 'running')
    s2.end()
    await tick()
  })

  it('a stream of shared jobs does not starve a queued exclusive', async () => {
    const queue = new JobQueue({ concurrency: 8 })
    const first = gate()
    submit(queue, 'zfs.snapshot', first, [S('zpool:g1')])
    const x = gate()
    const idx = submit(queue, 'zpool.destroy', x, [X('zpool:g1')])
    const stream = gates(5)
    const ids = stream.map(g => submit(queue, 'zfs.snapshot', g, [S('zpool:g1')]))
    assert.ok(ids.every(id => status(queue, id) === 'queued'), 'none of the later shared jobs starts while the exclusive waits')
    first.end()
    await tick()
    assert.equal(status(queue, idx), 'running', 'the exclusive runs as soon as the shared holder ends')
    x.end()
    await tick()
    assert.ok(ids.every(id => status(queue, id) === 'running'), 'then the stream runs together')
    for (const g of stream)
      g.end()
    await tick()
  })

  it('grants are all-or-nothing: two jobs wanting each other\'s keys never deadlock, and a waiter holds no key', async () => {
    const queue = new JobQueue()
    const ha = gate()
    const hb = gate()
    const idha = submit(queue, 'hold.a', ha, [X('disk:A')])
    const idhb = submit(queue, 'hold.b', hb, [X('disk:B')])
    const j1 = gate()
    const j2 = gate()
    const id1 = submit(queue, 'want.ab', j1, [X('disk:A'), X('disk:B')])
    const id2 = submit(queue, 'want.ba', j2, [X('disk:B'), X('disk:A')])
    assert.equal(status(queue, id1), 'queued')
    assert.equal(status(queue, id2), 'queued')
    ha.end()
    await tick()
    // disk:A is free now, but j1 still waits for disk:B — and holds NOTHING.
    assert.equal(status(queue, id1), 'queued')
    assert.deepEqual(queue.heldLocks(), [{ key: 'disk:B', mode: 'exclusive', holders: [idhb] }])
    hb.end()
    await tick()
    assert.equal(status(queue, id1), 'running')
    assert.equal(status(queue, id2), 'queued')
    j1.end()
    await tick()
    assert.equal(status(queue, id2), 'running')
    j2.end()
    await tick()
    assert.equal(status(queue, idha), 'completed')
    assert.equal(status(queue, id2), 'completed')
  })
})

describe('cr.33 — slots', () => {
  it('a lock-waiting job never holds one of the 4 slots (asserted on `running`)', async () => {
    const queue = new JobQueue()
    const holder = gate()
    submit(queue, 'zpool.export', holder, [X('zpool:g1')])
    const waiters = gates(3)
    const waiting = waiters.map(g => submit(queue, 'zpool.destroy', g, [X('zpool:g1')]))
    assert.equal(slotsInUse(queue), 1, 'three lock-waiting jobs hold no slot')
    assert.equal(queue.list('running').length, 1)
    const others = gates(3)
    const ran = others.map(g => submit(queue, 'zfs.snapshot', g, [S('zpool:g2')]))
    assert.ok(ran.every(id => status(queue, id) === 'running'), 'three unrelated jobs take the three free slots')
    assert.equal(slotsInUse(queue), 4)
    assert.equal(queue.list('running').length, 4)
    assert.ok(waiting.every(id => status(queue, id) === 'queued'))
    // Full: an unrelated fifth waits for a SLOT, and says nothing about locks.
    const fifth = gate()
    const id5 = submit(queue, 'zfs.snapshot', fifth, [S('zpool:g3')])
    assert.equal(status(queue, id5), 'queued')
    assert.equal(queue.get(id5)?.progress, null)
    for (const g of [holder, ...others])
      g.end()
    await tick()
    assert.equal(status(queue, id5), 'running')
    assert.equal(status(queue, waiting[0]), 'running')
    for (const g of [fifth, ...waiters])
      g.end()
    await tick()
    await tick()
    await tick()
    assert.equal(slotsInUse(queue), 0)
  })

  it('long jobs fill at most 3 of the 4 slots; a short verb gets the fourth', async () => {
    const queue = new JobQueue()
    assert.equal(queue.longSlots, 3)
    const longs = gates(4)
    const ids = longs.map(g => submit(queue, 'backup.task.run', g, [], 'long'))
    assert.deepEqual(ids.map(id => status(queue, id)), ['running', 'running', 'running', 'queued'])
    assert.equal(slotsInUse(queue), 3)
    const short = gate()
    const idShort = submit(queue, 'zpool.destroy', short, [X('zpool:g1')])
    assert.equal(status(queue, idShort), 'running', 'the slot the long lane leaves free')
    longs[0].end()
    await tick()
    assert.equal(status(queue, ids[3]), 'running', 'a finished long job lets the next long one in')
    for (const g of [short, ...longs.slice(1)])
      g.end()
    await tick()
  })
})

describe('cr.33 — release', () => {
  it('a handler that throws releases its locks (the status settled first), and the waiter runs', async () => {
    const queue = new JobQueue()
    const a = gate()
    const b = gate()
    const ida = submit(queue, 'zpool.export', a, [X('zpool:g1'), X('zname:tank')])
    const idb = submit(queue, 'zpool.destroy', b, [X('zpool:g1')])
    a.fail(new Error('zpool export: pool is busy'))
    await tick()
    assert.equal(status(queue, ida), 'failed')
    assert.equal(status(queue, idb), 'running')
    assert.deepEqual(queue.heldLocks().map(l => l.key), ['zpool:g1'])
    b.end()
    await tick()
  })

  it('idle keys are deleted: a shared key lives while any holder does, and is gone after the last', async () => {
    const queue = new JobQueue()
    const a = gate()
    const b = gate()
    const ida = submit(queue, 'zfs.snapshot', a, [S('zpool:g1'), S('zfs:g1/a'), X('zfs:g1/a/b')])
    const idb = submit(queue, 'zfs.snapshot', b, [S('zpool:g1')])
    assert.equal(queue.heldLocks().length, 3)
    a.end()
    await tick()
    assert.equal(status(queue, ida), 'completed')
    assert.deepEqual(queue.heldLocks(), [{ key: 'zpool:g1', mode: 'shared', holders: [idb] }])
    b.end()
    await tick()
    assert.deepEqual(queue.heldLocks(), [], 'no key outlives its last holder')
  })

  it('the lock table on its own: release deletes an emptied key, and a conflicting grant throws', () => {
    const table = new LockTable()
    const job = { id: 'j1' } as Job
    table.grant(job, [X('k')])
    assert.throws(() => table.grant({ id: 'j2' } as Job, [S('k')]), /conflicts/)
    table.release('j1', [X('k')])
    assert.equal(table.size, 0)
  })

  it('a job whose child was abandoned keeps its locks until the child exits; the waiter names it', async () => {
    const registry = new AbandonedRegistry()
    const queue = new JobQueue({ abandoned: registry })
    const idh = queue.submit('zpool.export', SUBMITTER, async () => {
      // What the production executor does at the end of a deadline whose
      // SIGKILL did not land: list the child under the job, then reject.
      registry.add({ pid: 4242, label: 'zpool export', command: '/usr/sbin/zpool', args: ['export', '--', 'tank'], lane: 'job', jobId: currentLane().jobId, budgetMs: 300_000, since: new Date().toISOString() })
      throw new CommandTimeoutError('/usr/sbin/zpool', ['export', '--', 'tank'], 'job', 300_000, true, currentLane().jobId)
    }, { locks: [X('zpool:g1', 'Pool \'tank\'')] }).id
    const w = gate()
    const idw = submit(queue, 'zpool.destroy', w, [X('zpool:g1', 'Pool \'tank\'')])
    await tick()
    assert.equal(status(queue, idh), 'failed', 'the job itself ended')
    assert.equal(queue.get(idh)?.error?.code, 'TIMEOUT')
    assert.equal(queue.get(idh)?.holdsLocks, true)
    assert.equal(status(queue, idw), 'queued', 'the lock is still held')
    assert.equal(w.started, false)
    assert.equal(slotsInUse(queue), 0, 'neither the ended holder nor the waiter holds a slot')
    assert.equal(queue.get(idw)?.progress, `waiting for zpool.export (job ${idh}) on Pool 'tank' — that job has ended, but a command it ran could not be stopped and is still running`)
    registry.remove(4242) // the child finally exits
    await tick()
    assert.equal(queue.get(idh)?.holdsLocks, undefined)
    assert.equal(status(queue, idw), 'running')
    assert.equal(queue.get(idw)?.progress, null, 'the queue\'s waiting line goes when the job starts')
    w.end()
    await tick()
    assert.deepEqual(queue.heldLocks(), [])
  })

  it('end to end with the real executor: a child no signal stops keeps the lock until it exits', async () => {
    const registry = new AbandonedRegistry()
    // The no-op signaller stands in for uninterruptible sleep (cr.34's seam).
    const exec = new ProdExecutor({ termGraceMs: 50, killGraceMs: 50, registry, signalGroup: () => {} })
    const queue = new JobQueue({ abandoned: registry })
    const mark = `0.9${String(process.pid).padStart(7, '0')}${Math.floor(Math.random() * 1000)}`
    try {
      const idh = queue.submit('zpool.export', SUBMITTER, async () => {
        await exec.exec('/bin/sh', ['-c', `exec sleep ${mark}`], { timeoutMs: 100 })
      }, { locks: [X('zpool:g1')] }).id
      const w = gate()
      const idw = submit(queue, 'zpool.destroy', w, [X('zpool:g1')])
      for (let i = 0; i < 100 && status(queue, idh) !== 'failed'; i++)
        await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(status(queue, idh), 'failed')
      assert.equal(registry.forJob(idh).length, 1, 'the executor listed the child under this job')
      assert.equal(queue.get(idh)?.holdsLocks, true)
      assert.equal(status(queue, idw), 'queued')
      for (let i = 0; i < 200 && status(queue, idw) !== 'running'; i++)
        await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(status(queue, idw), 'running', 'the sleep exited, the lock went with it')
      assert.equal(registry.size, 0)
      w.end()
      await tick()
    }
    finally {
      try {
        execFileSync('/usr/bin/pkill', ['-KILL', '-f', `^sleep ${mark}$`])
      }
      catch {}
    }
  })

  it('the abandoned registry\'s wait: per job, resolved by that job\'s LAST child only', async () => {
    const registry = new AbandonedRegistry()
    const child = (pid: number, jobId?: string) => ({ pid, label: 'zpool status', command: '/usr/sbin/zpool', args: ['status'], lane: 'job' as const, ...(jobId ? { jobId } : {}), budgetMs: 1, since: new Date(0).toISOString() })
    await registry.whenJobClear('j1') // nothing listed: resolves at once
    registry.add(child(1, 'j1'))
    registry.add(child(2, 'j1'))
    registry.add(child(3, 'j2'))
    registry.add(child(4))
    let cleared = false
    void registry.whenJobClear('j1').then(() => {
      cleared = true
    })
    registry.remove(3)
    registry.remove(4)
    registry.remove(1)
    await tick()
    assert.equal(cleared, false, 'j1 still has a child running')
    assert.deepEqual(registry.forJob('j1').map(c => c.pid), [2])
    registry.remove(2)
    await tick()
    assert.equal(cleared, true)
  })

  it('a control job takes no locks', () => {
    const queue = new JobQueue()
    assert.throws(() => queue.submit('job.cancel', SUBMITTER, async () => null, { control: true, locks: [X('k')] }), /control job takes no locks/)
  })
})
