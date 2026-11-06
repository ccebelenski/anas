import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsScrubRunning } from '../btrfs-scrub-running.js'

// scrub.r2 (GitHub #82): phase 2 of the AHR scrub — a day or more on a real
// pool — and a `btrfs scrub` started outside ANAS both read idle, because only
// the md checks were consulted. This is the btrfs side of the same cell.
describe('btrfsScrubRunning — the checksum pass in flight (scrub.r2)', () => {
  const BTRFS = '/usr/bin/btrfs'
  const MP = '/mnt/anas-ahr/ahr0'
  // REAL capture from the production node, 2026-11-06 — the scrub the failed
  // #81 run left behind, read while it was still running.
  const RUNNING_GT = [
    'UUID:             bbdda205-bc4a-418d-808f-763278b2e6f5',
    'Scrub started:    Fri Nov  6 00:36:16 2026',
    'Status:           running',
    'Duration:         0:00:05',
    'Time left:        45:59:25',
    'ETA:              Sat Nov  7 22:35:46 2026',
    'Total to scrub:   66.63TiB',
    'Bytes scrubbed:   2.06GiB  (0.00%)',
    'Rate:             422.00MiB/s',
    'Error summary:    no errors found',
    '',
  ].join('\n')

  function statusExecutor(result: { stdout: string, stderr?: string, exitCode: number }): MockExecutor {
    const ex = new MockExecutor()
    ex.addFixture({ command: BTRFS, args: ['scrub', 'status', MP], result: { stderr: '', ...result } })
    return ex
  }

  it('a running scrub reports the btrfs phase with btrfs\'s own percent (real capture)', async () => {
    assert.deepEqual(await btrfsScrubRunning(statusExecutor({ stdout: RUNNING_GT, exitCode: 0 }), MP), { phase: 'btrfs-checksums', percent: 0 })
  })

  it('an interrupted scrub is not a running one', async () => {
    // Same shape, `interrupted`, and no `Bytes scrubbed` line at all.
    const stdout = RUNNING_GT.replace('Status:           running', 'Status:           interrupted').replace('Bytes scrubbed:   2.06GiB  (0.00%)\n', '')
    assert.equal(await btrfsScrubRunning(statusExecutor({ stdout, exitCode: 0 }), MP), null)
  })

  it('a status read that fails answers null, not a throw (fail-open)', async () => {
    assert.equal(await btrfsScrubRunning(statusExecutor({ stdout: '', stderr: 'ERROR: not mounted', exitCode: 1 }), MP), null)
    const throwing = new MockExecutor()
    throwing.addFixture({ command: BTRFS, args: ['scrub', 'status', MP], throws: new Error('ENOENT: no btrfs') })
    assert.equal(await btrfsScrubRunning(throwing, MP), null)
  })

  // The fold of review POSSIBLE 2: with no deadline of its own this
  // request-lane call inherited the lane's 10 s (up to ~17 s when the child
  // ignores SIGTERM) — one sick pool stalling every `GET /scrub` row against
  // a 10 s panel poll. The call now carries 3 s, and a hung read still answers
  // null (fail-open holds for the ANSWER; the deadline is what keeps the
  // LATENCY fail-open too).
  it('the status read carries its own 3 s deadline, not the lane\'s', async () => {
    const ex = statusExecutor({ stdout: RUNNING_GT, exitCode: 0 })
    await btrfsScrubRunning(ex, MP)
    const call = ex.deadlines.find(d => d.command === BTRFS && d.args[0] === 'scrub')
    assert.ok(call, JSON.stringify(ex.deadlines))
    assert.equal(call.budgetMs, 3000)
    assert.equal(call.source, 'call')
  })

  it('a hung status read answers null, like any other failed read', async () => {
    const hung = new MockExecutor()
    hung.addFixture({ command: BTRFS, args: ['scrub', 'status', MP], timesOut: {} })
    assert.equal(await btrfsScrubRunning(hung, MP), null)
  })

  it('a running scrub whose status names no percentage still reports the phase', async () => {
    const stdout = RUNNING_GT.replace('Bytes scrubbed:   2.06GiB  (0.00%)\n', '')
    assert.deepEqual(await btrfsScrubRunning(statusExecutor({ stdout, exitCode: 0 }), MP), { phase: 'btrfs-checksums' })
  })
})
