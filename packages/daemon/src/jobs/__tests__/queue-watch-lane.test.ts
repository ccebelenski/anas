import type { Job } from '@anas/shared'
import type { JobLane, LockClaim } from '../queue.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JobQueue } from '../queue.js'

/**
 * Story cr.49 (ruled 2026-10-15) — the watch lane. A Run-Now supervisor only
 * watches the unit it started; the unit submits the DIRECT run back to the
 * daemon as a long-lane job. Before cr.49 the supervisor rode the long lane
 * too, so three Run Nows filled the long lane (3 of the 4 slots) with
 * supervisors and their own direct runs waited until the supervisors gave up
 * (600 s). Now a supervisor is an ordinary queue job in the `watch` lane: its
 * own slots beyond the 4, no lock claims.
 *
 * Driven with gated bodies (the queue-locks.test.ts pattern): each body waits
 * on a promise the test resolves.
 */

const SUBMITTER = { user: 'root@pam', uid: 0 }

const S = (key: string): LockClaim => ({ key, mode: 'shared', what: `Dataset '${key}'` })

interface Gate {
  body: () => Promise<unknown>
  end: () => void
}

function gate(): Gate {
  let resolve!: () => void
  const done = new Promise<void>((res) => {
    resolve = res
  })
  return {
    end: () => resolve(),
    body: async () => {
      await done
      return null
    },
  }
}

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

/** The queue's private counters — what "holds a slot" means. */
function counters(queue: JobQueue): { running: number, runningLong: number, runningWatch: number } {
  const q = queue as unknown as { running: number, runningLong: number, runningWatch: number }
  return { running: q.running, runningLong: q.runningLong, runningWatch: q.runningWatch }
}

function submit(queue: JobQueue, op: string, g: Gate, lane?: JobLane, locks: LockClaim[] = []): string {
  return queue.submit(op, SUBMITTER, g.body, { locks, ...(lane ? { lane } : {}) }).id
}

describe('cr.49 — the watch lane', () => {
  it('three Run Nows and their direct runs all run at once: no direct run waits behind its supervisor', async () => {
    const queue = new JobQueue()
    // Each supervisor does what the real one does in shape: it "starts the
    // unit" (here: submits the direct run the unit would submit back, long
    // lane, shared claims on its source) and then WATCHES it until it ends.
    const runs = gates(3)
    const directIds: string[] = []
    const supervisorIds = runs.map((run, i) => queue.submit(
      'backup.task.run',
      { ...SUBMITTER, params: { task: `t${i}` } },
      async () => {
        const id = queue.submit(
          'backup.task.run',
          { ...SUBMITTER, params: { task: `t${i}`, direct: true } },
          run.body,
          { lane: 'long', locks: [S(`zfs:g${i}/src`)] },
        ).id
        directIds.push(id)
        // Bounded like the real one (its 600 s ceiling): a run that never
        // starts must fail this test, not hang it.
        for (let poll = 0; poll < 1000; poll++) {
          if (status(queue, id) !== 'queued' && status(queue, id) !== 'running')
            return { watched: id, ended: status(queue, id) }
          await new Promise(resolve => setImmediate(resolve))
        }
        return { watched: id, ended: 'still running at the ceiling' }
      },
      { lane: 'watch' },
    ).id)
    await tick()

    assert.deepEqual(supervisorIds.map(id => status(queue, id)), ['running', 'running', 'running'])
    assert.equal(directIds.length, 3)
    assert.deepEqual(
      directIds.map(id => status(queue, id)),
      ['running', 'running', 'running'],
      'every direct run started while its supervisor watches — none queued behind a supervisor',
    )
    assert.ok(directIds.every(id => queue.get(id)?.startedAt !== null))
    assert.deepEqual(counters(queue), { running: 3, runningLong: 3, runningWatch: 3 })

    // The runs end; each supervisor sees its run end and completes.
    for (const run of runs)
      run.end()
    await tick()
    await tick()
    assert.deepEqual(directIds.map(id => status(queue, id)), ['completed', 'completed', 'completed'])
    assert.deepEqual(supervisorIds.map(id => status(queue, id)), ['completed', 'completed', 'completed'])
    assert.deepEqual(counters(queue), { running: 0, runningLong: 0, runningWatch: 0 })
  })

  it('the 4 regular slots and the long cap are unchanged with the watch lane full', async () => {
    const queue = new JobQueue()
    assert.equal(queue.longSlots, 3)
    assert.equal(queue.watchSlots, 8)
    const watchers = gates(8)
    const watchIds = watchers.map(g => submit(queue, 'cloud.task.run', g, 'watch'))
    assert.ok(watchIds.every(id => status(queue, id) === 'running'))
    assert.equal(counters(queue).running, 0, 'eight watch jobs hold none of the 4 slots')

    // The long cap: 3 of 4, exactly as before.
    const longs = gates(4)
    const longIds = longs.map(g => submit(queue, 'zfs.replicate', g, 'long'))
    assert.deepEqual(longIds.map(id => status(queue, id)), ['running', 'running', 'running', 'queued'])
    // The fourth slot is the short verbs', and there is only one of it.
    const shorts = gates(2)
    const shortIds = shorts.map(g => submit(queue, 'zfs.snapshot', g))
    assert.deepEqual(shortIds.map(id => status(queue, id)), ['running', 'queued'])
    assert.deepEqual(counters(queue), { running: 4, runningLong: 3, runningWatch: 8 })

    // A ninth watcher waits for a WATCH slot; it never takes a regular one.
    const ninth = gate()
    const id9 = submit(queue, 'cloud.task.run', ninth, 'watch')
    assert.equal(status(queue, id9), 'queued')
    assert.equal(queue.get(id9)?.progress, null, 'a slot wait names no lock')
    // Freeing a regular slot does not start it; freeing a watch slot does.
    shorts[0].end()
    await tick()
    assert.equal(status(queue, shortIds[1]), 'running', 'the freed short slot goes to the queued short verb')
    assert.equal(status(queue, id9), 'queued')
    watchers[0].end()
    await tick()
    assert.equal(status(queue, id9), 'running')
    assert.equal(status(queue, longIds[3]), 'queued', 'a freed watch slot is not a long slot')
    assert.deepEqual(counters(queue), { running: 4, runningLong: 3, runningWatch: 8 })

    for (const g of [ninth, ...watchers.slice(1), ...longs, ...shorts.slice(1)])
      g.end()
    await tick()
    await tick()
    assert.deepEqual(counters(queue), { running: 0, runningLong: 0, runningWatch: 0 })
  })

  it('a watch job with lock claims is refused at submit, and nothing is queued', () => {
    const queue = new JobQueue()
    assert.throws(
      () => queue.submit('backup.task.run', SUBMITTER, async () => null, { lane: 'watch', locks: [S('zfs:g1/src')] }),
      /watch-lane job takes no locks/,
    )
    assert.equal(queue.list().length, 0)
    // An empty claim list is no claim: the Run-Now door passes `source.claims`,
    // which is [] for a supervisor.
    const id = queue.submit('backup.task.run', SUBMITTER, async () => null, { lane: 'watch', locks: [] }).id
    assert.equal(status(queue, id), 'running')
  })

  it('a watch job is an ordinary job: same record, poll and cancel refusal as any other', async () => {
    const queue = new JobQueue({ watchSlots: 1 })
    const g = gate()
    const ref = queue.submit('cloud.task.run', { ...SUBMITTER, params: { task: 'photos' } }, g.body, { lane: 'watch' })
    assert.equal(ref.status, 'running')
    assert.equal(queue.get(ref.id)?.operation, 'cloud.task.run')
    assert.equal(queue.findActive('cloud.task.run', 'photos', 'task')?.id, ref.id)
    assert.equal(queue.list('running').length, 1)
    // A body that registers no hook is not cancellable — the same refusal any lane gets.
    assert.equal((queue.cancelTarget(ref.id) as { reason?: string }).reason, 'not-cancellable')
    g.end()
    await tick()
    assert.equal(status(queue, ref.id), 'completed')
  })
})
