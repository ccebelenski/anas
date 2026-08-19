import type { SnapshotSchedule as SnapshotScheduleT } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapshotSchedule } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { ANAS_SNAPSHOT_NOTIFY_TEMPLATE } from '../pve-notify.js'
import {
  buildSnapshotNotifyBody,
  notifyScheduleRun,
  retentionSummaryLine,
  snapshotNotifyOutcome,
  snapshotNotifyTitle,
  snapshotTargetLine,
} from '../snapshot-notify.js'
import { shouldNotifyUnattended, unattendedSeverity } from '../unattended-notify.js'

/**
 * Snapshot schedule run notifications (story 9.4) — the failure-only gate, the
 * outcome mapping, and the body an operator reads instead of the run.
 */

const PERL = '/usr/bin/perl'

function makeSchedule(over: Partial<SnapshotScheduleT> = {}): SnapshotScheduleT {
  return SnapshotSchedule.parse({
    id: 'nightly-media',
    name: 'Nightly media',
    target: { kind: 'zfs', dataset: 'testpool/media' },
    cadence: 'daily',
    retention: { daily: 7, weekly: 4 },
    recursive: false,
    enabled: true,
    ...over,
  })
}

describe('snapshot schedule notifications — the failure-only gate (9.4)', () => {
  it('a failure notifies; a success (and everything else) stays silent', () => {
    assert.equal(shouldNotifyUnattended('failure'), true)
    assert.equal(shouldNotifyUnattended('success'), false)
  })

  it('outcome: an error is a failure, a completed take+prune is not', () => {
    const schedule = makeSchedule()
    assert.equal(snapshotNotifyOutcome({ schedule, error: 'cannot create snapshot' }), 'failure')
    assert.equal(snapshotNotifyOutcome({
      schedule,
      result: { schedule: 'nightly-media', taken: 'anas-daily-2026-08-19T020000Z', pruned: [], skippedHeld: [] },
    }), 'success')
  })

  it('severity is the routing signal PVE matches on', () => {
    assert.equal(unattendedSeverity('failure'), 'error')
    assert.equal(unattendedSeverity('success'), 'info')
  })

  it('the title names the schedule and the verdict (the subject template renders it)', () => {
    assert.equal(snapshotNotifyTitle(makeSchedule(), 'failure'), 'snapshot schedule \'Nightly media\' FAILED')
  })

  it('the target line spells out either backend, never truncated', () => {
    assert.equal(snapshotTargetLine({ kind: 'zfs', dataset: 'testpool/media' }), 'ZFS dataset testpool/media')
    assert.equal(snapshotTargetLine({ kind: 'ahr', pool: 'bay1' }), 'AHR pool bay1')
  })

  it('the retention summary reads in words, and says so when policy keeps nothing', () => {
    assert.equal(retentionSummaryLine({ hourly: 24, daily: 30, monthly: 12 }), '24 hourly / 30 daily / 12 monthly')
    assert.match(retentionSummaryLine({}), /nothing kept by policy/)
  })
})

describe('snapshot schedule notifications — the body (9.4)', () => {
  it('a failure body carries the schedule, the target, the cadence and the error verbatim', () => {
    const body = buildSnapshotNotifyBody({
      schedule: makeSchedule(),
      error: 'cannot create snapshot \'testpool/media@anas-daily-…\': out of space',
      elapsedMs: 95_000,
    })
    assert.match(body, /Schedule:\s+Nightly media \(nightly-media\)/)
    assert.match(body, /Target:\s+ZFS dataset testpool\/media/)
    assert.match(body, /Result:\s+FAILED/)
    assert.match(body, /Duration:\s+1m 35s \(job elapsed\)/)
    assert.match(body, /Cadence:\s+daily/)
    assert.match(body, /Retention:\s+7 daily \/ 4 weekly/)
    assert.ok(body.includes('cannot create snapshot \'testpool/media@anas-daily-…\': out of space'))
  })

  it('an AHR schedule\'s body names the pool, and a disabled/recursive schedule says so', () => {
    const body = buildSnapshotNotifyBody({
      schedule: makeSchedule({ target: { kind: 'ahr', pool: 'bay1' }, recursive: true, enabled: false }),
      error: 'btrfs subvolume snapshot failed: Read-only file system',
    })
    assert.match(body, /Target:\s+AHR pool bay1/)
    assert.match(body, /Cadence:\s+daily, recursive \(schedule disabled\)/)
    assert.ok(body.includes('Read-only file system'))
  })

  it('a completed run\'s body names what it took and pruned, and no error', () => {
    const body = buildSnapshotNotifyBody({
      schedule: makeSchedule(),
      result: {
        schedule: 'nightly-media',
        taken: 'anas-daily-2026-08-19T020000Z',
        pruned: ['anas-daily-2026-08-12T020000Z'],
        skippedHeld: ['anas-daily-2026-08-11T020000Z'],
      },
    })
    assert.match(body, /Result:\s+success/)
    assert.match(body, /Snapshot:\s+anas-daily-2026-08-19T020000Z/)
    assert.match(body, /Pruned:\s+anas-daily-2026-08-12T020000Z/)
    assert.match(body, /Held:\s+anas-daily-2026-08-11T020000Z \(retained, never pruned\)/)
    assert.ok(!body.includes('Error:'), 'a success body names no error')
  })
})

describe('snapshot schedule notifications — emission (9.4)', () => {
  function mockPerl(exitCode = 0): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: exitCode ? 'no target' : '', exitCode } })
    return executor
  }

  it('a failed run emits `error` through the anas-snapshot template', async () => {
    const executor = mockPerl()
    await notifyScheduleRun(executor, { schedule: makeSchedule(), error: 'out of space' })
    assert.equal(executor.calls.length, 1)
    const call = executor.calls[0]
    assert.equal(call.command, PERL)
    assert.ok(call.args[1].includes(ANAS_SNAPSHOT_NOTIFY_TEMPLATE))
    assert.equal(call.args[2], 'error')
    assert.equal(call.args[3], 'snapshot schedule \'Nightly media\' FAILED')
    assert.ok(call.args[4].includes('out of space'))
  })

  it('a successful run costs nothing at all — no exec (an hourly schedule is not spam)', async () => {
    const executor = mockPerl()
    await notifyScheduleRun(executor, {
      schedule: makeSchedule(),
      result: { schedule: 'nightly-media', taken: 'anas-daily-2026-08-19T020000Z', pruned: [], skippedHeld: [] },
    })
    assert.deepEqual(executor.calls, [])
  })

  it('a delivery failure is swallowed — best-effort by contract', async () => {
    const executor = mockPerl(255)
    await assert.doesNotReject(notifyScheduleRun(executor, { schedule: makeSchedule(), error: 'boom' }))
  })
})
