import type { SpawnedChild } from '../types.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  AbandonedRegistry,
  commandLabel,
  CommandTimeoutError,
  LANE_BUDGET_MS,
  parseTimeoutWrapper,
  resolveDeadline,
  runInLane,
  TIMEOUT_WRAPPER_MARGIN_MS,
} from '../deadline.js'
import { MockExecutor } from '../mock.js'
import { ProdExecutor } from '../prod.js'

/**
 * cr.34 — executor deadlines, with the REAL `ProdExecutor` on `/bin/sh`
 * children (WAVE3-DESIGN §8.2). The four cases are the ones probe P02
 * (docs/probes/wave3/02-exec-timeout-semantics.txt, exec-timeout-semantics.mjs)
 * measured against Node's `execFile` timeout:
 *
 *   A  a child that exits on SIGTERM — on time;
 *   B  a child that IGNORES SIGTERM — execFile's callback never fired;
 *   C  a grandchild holding the pipe — execFile ORPHANED it;
 *   D  detached + a process-GROUP SIGTERM — prompt, nothing left behind;
 *
 * plus the normal exit, and the child no signal can stop (uninterruptible
 * sleep, modelled by a no-op group signaller) that the executor must give up
 * on instead of waiting for.
 *
 * The production grace periods are 5 s and 2 s; these tests inject 300 ms and
 * 200 ms with 200 ms budgets so the whole file runs in a few seconds.
 */

const SH = '/bin/sh'
const BUDGET = 200
const TERM_GRACE = 300
const KILL_GRACE = 200

function fastExecutor(extra: ConstructorParameters<typeof ProdExecutor>[0] = {}): ProdExecutor {
  return new ProdExecutor({ termGraceMs: TERM_GRACE, killGraceMs: KILL_GRACE, registry: new AbandonedRegistry(), ...extra })
}

/** A `sleep` duration no other process on the host is running: the marker pgrep looks for. */
function marker(base: number): string {
  return `${base}.${String(process.pid).padStart(7, '0')}${Math.floor(Math.random() * 1000)}`
}

/** Pids of `sleep <mark>` processes still alive (empty when none). */
function alive(mark: string): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', `^sleep ${mark}$`]).toString().trim().split('\n').filter(Boolean)
  }
  catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

/** Kill whatever a failed test left behind (never the runner itself). */
function reap(mark: string): void {
  for (const pid of alive(mark)) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    }
    catch {}
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond())
      return true
    await new Promise(r => setTimeout(r, 20))
  }
  return cond()
}

/** Run `fn`, return what it rejected with and how long that took. */
async function rejection(fn: () => Promise<unknown>): Promise<{ err: unknown, ms: number }> {
  const t0 = Date.now()
  try {
    await fn()
  }
  catch (err) {
    return { err, ms: Date.now() - t0 }
  }
  assert.fail('expected the call to reject')
}

describe('cr.34 deadlines — P02\'s cases on the real executor', () => {
  it('a normal exit inside the budget resolves exactly as before (exit code, stdout, no timeout)', async () => {
    const registry = new AbandonedRegistry()
    const exec = fastExecutor({ registry })
    const t0 = Date.now()
    const r = await exec.exec(SH, ['-c', 'sleep 0.3; echo done; exit 3'], { timeoutMs: 1500 })
    assert.equal(r.exitCode, 3)
    assert.equal(r.stdout, 'done\n')
    assert.ok(Date.now() - t0 < 1500, 'settled by the child, not by the deadline')
    assert.equal(registry.size, 0)
  })

  it('case A: a child that exits on SIGTERM is stopped at the deadline and the call REJECTS (never an exit code)', async () => {
    const mark = marker(30)
    try {
      const { err, ms } = await rejection(() => fastExecutor().exec(SH, ['-c', `exec sleep ${mark}`], { timeoutMs: BUDGET }))
      assert.ok(err instanceof CommandTimeoutError, `rejected with ${String(err)}`)
      assert.equal(err.abandoned, false)
      assert.equal(err.budgetMs, BUDGET)
      assert.equal(err.jobErrorCode, 'TIMEOUT')
      // TERM was enough: settled inside the TERM grace, long before KILL.
      assert.ok(ms >= BUDGET && ms < BUDGET + TERM_GRACE, `settled after ${ms} ms`)
      assert.deepEqual(alive(mark), [])
    }
    finally {
      reap(mark)
    }
  })

  it('case B: a child that IGNORES SIGTERM is SIGKILLed and the call settles (execFile left it pending forever)', async () => {
    const mark = marker(31)
    try {
      // The ignored disposition is inherited by the `sleep` — the whole group
      // ignores TERM, as P02's case B script does.
      const { err, ms } = await rejection(() => fastExecutor().exec(SH, ['-c', `trap "" TERM; sleep ${mark}; true`], { timeoutMs: BUDGET }))
      assert.ok(err instanceof CommandTimeoutError, `rejected with ${String(err)}`)
      // The SIGKILL stopped it: nothing abandoned, nothing left running.
      assert.equal(err.abandoned, false)
      assert.ok(ms >= BUDGET + TERM_GRACE, `it took the SIGKILL step (settled after ${ms} ms)`)
      assert.ok(await until(() => alive(mark).length === 0, 1000), `sleep ${mark} survived: ${alive(mark).join(',')}`)
    }
    finally {
      reap(mark)
    }
  })

  it('case C: a grandchild holding the pipe dies with its parent — not orphaned (P02: execFile left it running)', async () => {
    const mark = marker(3)
    try {
      const { err } = await rejection(() => fastExecutor().exec(SH, ['-c', `sleep ${mark} & exec sleep 30`], { timeoutMs: BUDGET }))
      assert.ok(err instanceof CommandTimeoutError)
      assert.ok(await until(() => alive(mark).length === 0, 500), `grandchild orphaned: sleep ${mark} pid ${alive(mark).join(',')}`)
    }
    finally {
      reap(mark)
    }
  })

  it('case D: the detached group\'s SIGTERM ends the call promptly even with a grandchild on the pipe', async () => {
    const mark = marker(3)
    try {
      const { err, ms } = await rejection(() => fastExecutor().exec(SH, ['-c', `sleep ${mark} & exec sleep 30`], { timeoutMs: BUDGET }))
      assert.ok(err instanceof CommandTimeoutError)
      assert.equal(err.abandoned, false)
      // P02 case D: close ~4 ms after the group SIGTERM. Here: inside the TERM
      // grace — the group signal reached every holder of the pipe at once.
      assert.ok(ms < BUDGET + TERM_GRACE, `settled after ${ms} ms`)
    }
    finally {
      reap(mark)
    }
  })

  it('a child no signal can stop settles ANYWAY as abandoned, is listed, and leaves the list when it exits', async () => {
    const registry = new AbandonedRegistry()
    const mark = marker(2)
    // The no-op signaller is the spawn seam standing in for uninterruptible
    // sleep: neither TERM nor KILL reaches the child.
    const exec = fastExecutor({ registry, signalGroup: () => {} })
    try {
      const { err, ms } = await rejection(() => runInLane({ lane: 'job', jobId: 'job-42' }, () =>
        exec.exec(SH, ['-c', `exec sleep ${mark}`], { timeoutMs: BUDGET })))
      assert.ok(err instanceof CommandTimeoutError)
      assert.equal(err.abandoned, true)
      assert.match(err.message, /could not be stopped/)
      assert.ok(ms >= BUDGET + TERM_GRACE + KILL_GRACE && ms < 1500, `settled after ${ms} ms, before the child's own exit`)
      const listed = registry.list()
      assert.equal(listed.length, 1)
      assert.equal(listed[0].label, 'sh')
      assert.equal(listed[0].command, SH)
      assert.deepEqual(listed[0].args, ['-c', `exec sleep ${mark}`])
      assert.equal(listed[0].lane, 'job')
      assert.equal(listed[0].jobId, 'job-42')
      assert.equal(listed[0].budgetMs, BUDGET)
      assert.ok(alive(mark).length > 0, 'the abandoned child is really still running')
      // The child's own exit (sleep 2.x) clears the entry.
      assert.ok(await until(() => registry.size === 0, 3000), 'the entry left the registry when the child exited')
    }
    finally {
      reap(mark)
    }
  })
})

describe('cr.34 deadlines — every door has one', () => {
  it('the teeing exec path (onStderr) is bounded too', async () => {
    const seen: string[] = []
    const { err } = await rejection(() => fastExecutor().exec(SH, ['-c', 'echo progress >&2; exec sleep 30'], {
      timeoutMs: BUDGET,
      onStderr: c => seen.push(c),
    }))
    assert.ok(err instanceof CommandTimeoutError)
    assert.deepEqual(seen, ['progress\n'])
  })

  it('pipeline: the deadline covers both processes and is named after the producer', async () => {
    const { err } = await rejection(() => fastExecutor().pipeline(SH, ['-c', 'exec sleep 30'], '/usr/bin/cat', [], { timeoutMs: BUDGET }))
    assert.ok(err instanceof CommandTimeoutError)
    assert.equal(err.command, SH)
  })

  it('pipeline: each child left stuck is recorded under its own argv, not the producer\'s', async () => {
    const added: string[] = []
    class Spy extends AbandonedRegistry {
      override add(child: Parameters<AbandonedRegistry['add']>[0]): void {
        added.push(`${child.label} ${child.args.join(' ')}`.trim())
        super.add(child)
      }
    }
    const mark = marker(2)
    try {
      const exec = fastExecutor({ registry: new Spy(), signalGroup: () => {} })
      const { err } = await rejection(() => exec.pipeline(SH, ['-c', `exec sleep ${mark}`], '/usr/bin/cat', [], { timeoutMs: BUDGET }))
      assert.ok(err instanceof CommandTimeoutError)
      assert.equal(err.abandoned, true)
      assert.equal(err.label, 'sh')
      assert.deepEqual(added, [`sh -c exec sleep ${mark}`, 'cat'])
    }
    finally {
      reap(mark)
    }
  })

  it('execToStream: bounded, and it honours onSpawn (an image restore can be signalled)', async () => {
    const spawned: SpawnedChild[] = []
    const { err } = await rejection(() => fastExecutor().execToStream(SH, ['-c', 'exec sleep 30'], { path: '/dev/null', flags: 'w' }, {
      timeoutMs: BUDGET,
      onSpawn: c => spawned.push(c),
    }))
    assert.ok(err instanceof CommandTimeoutError)
    assert.equal(spawned.length, 1)
    assert.ok(spawned[0].pid > 0)
    assert.equal(spawned[0].exited(), true)
  })

  it('execToStream: onSpawn\'s handle stops a running child (the cancel ladder reaches restores)', async () => {
    const exec = fastExecutor()
    const r = await exec.execToStream(SH, ['-c', 'exec sleep 30'], { path: '/dev/null', flags: 'w' }, {
      onSpawn: (c) => {
        c.kill('SIGINT')
      },
    })
    assert.equal(r.exitCode, 1)
    assert.equal(r.signal, 'SIGINT')
  })

  it('timeoutMs: null runs without a deadline; without a longRunning reason it is refused before anything spawns', async () => {
    const exec = fastExecutor({ laneBudgetsMs: { background: 50 } })
    const r = await exec.exec(SH, ['-c', 'sleep 0.2; echo ok'], { timeoutMs: null, longRunning: 'a test of the opt-out' })
    assert.equal(r.stdout, 'ok\n')
    await assert.rejects(
      () => exec.exec(SH, ['-c', 'echo never'], { timeoutMs: null } as never),
      /requires a longRunning reason/,
    )
  })

  it('no per-call budget: the LANE decides (a request-lane call gets the request budget)', async () => {
    const exec = fastExecutor({ laneBudgetsMs: { request: BUDGET } })
    const { err } = await rejection(() => runInLane({ lane: 'request' }, () => exec.exec(SH, ['-c', 'exec sleep 30'])))
    assert.ok(err instanceof CommandTimeoutError)
    assert.equal(err.lane, 'request')
    assert.equal(err.budgetMs, BUDGET)
  })

  it('a /usr/bin/timeout wrapper keeps its own deadline: the executor sits above it, so exit 124 still arrives', async () => {
    // Lane budget far BELOW the wrapper's 1 s: without the wrapper rule this
    // call would be a CommandTimeoutError, not timeout's own 124.
    const exec = fastExecutor({ laneBudgetsMs: { background: 100 } })
    const r = await exec.exec('/usr/bin/timeout', ['0.3', 'sleep', '5'])
    assert.equal(r.exitCode, 124)
  })
})

describe('cr.34 deadline policy (pure)', () => {
  it('lane defaults: request 10 s, job and background 300 s; no store is background', () => {
    assert.deepEqual({ ...LANE_BUDGET_MS }, { request: 10_000, job: 300_000, background: 300_000 })
    assert.equal(resolveDeadline('/usr/sbin/zpool', ['status']).lane, 'background')
    assert.equal(resolveDeadline('/usr/sbin/zpool', ['status']).budgetMs, 300_000)
    const r = runInLane({ lane: 'request' }, () => resolveDeadline('/usr/sbin/zpool', ['status']))
    assert.deepEqual(r, { lane: 'request', budgetMs: 10_000, source: 'lane' })
    const j = runInLane({ lane: 'job', jobId: 'j1' }, () => resolveDeadline('/usr/sbin/zpool', ['create']))
    assert.deepEqual(j, { lane: 'job', jobId: 'j1', budgetMs: 300_000, source: 'lane' })
  })

  it('the lane survives awaits and timers inside the store', async () => {
    const lane = await runInLane({ lane: 'job', jobId: 'j2' }, async () => {
      await new Promise(r => setTimeout(r, 5))
      return resolveDeadline('/usr/bin/true', []).jobId
    })
    assert.equal(lane, 'j2')
  })

  it('a per-call budget wins over the lane; bad options are programming errors', () => {
    assert.equal(runInLane({ lane: 'request' }, () => resolveDeadline('/x', [], { timeoutMs: 1_800_000 })).budgetMs, 1_800_000)
    assert.throws(() => resolveDeadline('/x', [], { timeoutMs: 0 }), /positive/)
    assert.throws(() => resolveDeadline('/x', [], { timeoutMs: Number.NaN }), /positive/)
    assert.throws(() => resolveDeadline('/x', [], { timeoutMs: null, longRunning: ' ' }), /requires a longRunning reason/)
    assert.throws(() => resolveDeadline('/x', [], { timeoutMs: 5, longRunning: 'why' }), /only meaningful/)
  })

  it('/usr/bin/timeout: the wrapper\'s duration (+ kill-after) + the margin, in any lane', () => {
    const at = (args: string[]): number | null => runInLane({ lane: 'request' }, () => resolveDeadline('/usr/bin/timeout', args).budgetMs)
    assert.equal(at(['120', '/usr/bin/rclone', 'sync']), 120_000 + TIMEOUT_WRAPPER_MARGIN_MS)
    assert.equal(at(['-s', 'KILL', '5', '/usr/bin/realpath', '-e', '--', '/x']), 5_000 + TIMEOUT_WRAPPER_MARGIN_MS)
    assert.equal(at(['-k', '3', '2', 'stat']), 5_000 + TIMEOUT_WRAPPER_MARGIN_MS)
    assert.equal(at(['--kill-after=1m', '30s', 'x']), 90_000 + TIMEOUT_WRAPPER_MARGIN_MS)
    assert.equal(at(['--preserve-status', '1.5', 'x']), 1_500 + TIMEOUT_WRAPPER_MARGIN_MS)
    // Unreadable: the lane default, never a guess.
    assert.equal(at(['soon', 'x']), 10_000)
    assert.equal(parseTimeoutWrapper(['-s', 'KILL', '5', '/usr/bin/realpath'])?.commandIndex, 3)
  })

  it('the error names the command that hung (through a timeout wrapper) and its budget', () => {
    assert.equal(commandLabel('/usr/sbin/zpool', ['status', '-jv']), 'zpool status')
    assert.equal(commandLabel('/usr/sbin/zpool', ['-H', 'list']), 'zpool')
    assert.equal(commandLabel('/usr/bin/timeout', ['30', '/usr/bin/proxmox-backup-client', 'catalog', 'shell']), 'proxmox-backup-client catalog')
    const req = new CommandTimeoutError('/usr/sbin/zpool', ['status'], 'request', 10_000, false)
    assert.match(req.message, /^'zpool status' did not finish within 10 s and was stopped/)
    assert.doesNotMatch(req.message, /unknown state/)
    const job = new CommandTimeoutError('/usr/sbin/zpool', ['create', 'tank'], 'job', 1_800_000, true, 'j9')
    assert.match(job.message, /within 1800 s and could not be stopped/)
    assert.match(job.message, /unknown state — check it before retrying/)
    assert.equal(job.jobId, 'j9')
  })
})

describe('cr.34 MockExecutor parity', () => {
  it('records each call\'s deadline as production would resolve it, lane included', async () => {
    const mock = new MockExecutor()
    await runInLane({ lane: 'request' }, () => mock.exec('/usr/sbin/zpool', ['list']))
    await runInLane({ lane: 'job', jobId: 'j3' }, () => mock.pipeline('/usr/sbin/zfs', ['send', 'a@b'], '/usr/sbin/zfs', ['recv', 'c'], { timeoutMs: null, longRunning: 'data mover' }))
    assert.deepEqual(mock.deadlines, [
      { command: '/usr/sbin/zpool', args: ['list'], lane: 'request', budgetMs: 10_000, source: 'lane' },
      { command: '/usr/sbin/zfs', args: ['send', 'a@b'], lane: 'job', jobId: 'j3', budgetMs: null, source: 'call', longRunning: 'data mover' },
    ])
  })

  it('a timesOut fixture rejects with the CommandTimeoutError the real executor would raise', async () => {
    const mock = new MockExecutor().addFixture({ command: '/usr/sbin/zpool', timesOut: { abandoned: true } })
    const err = await runInLane({ lane: 'request' }, () => mock.exec('/usr/sbin/zpool', ['status'])).catch((e: unknown) => e)
    assert.ok(err instanceof CommandTimeoutError)
    assert.equal(err.budgetMs, 10_000)
    assert.equal(err.abandoned, true)
  })

  it('refuses a null budget without a reason, like production', async () => {
    await assert.rejects(() => new MockExecutor().exec('/x', [], { timeoutMs: null } as never), /requires a longRunning reason/)
  })
})
