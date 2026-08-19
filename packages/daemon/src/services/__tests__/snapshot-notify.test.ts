import type { SnapshotSchedule as SnapshotScheduleT } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapshotSchedule } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { ANAS_SNAPSHOT_NOTIFY_TEMPLATE } from '../pve-notify.js'
import {
  buildSnapshotNotifyBody,
  notifyScheduleRun,
  pruneSummaryLine,
  retentionSummaryLine,
  snapshotNotifyOutcome,
  snapshotNotifyTitle,
  snapshotTargetLine,
} from '../snapshot-notify.js'
import { notifySeverity, shouldNotify } from '../unattended-notify.js'

/**
 * Snapshot schedule run notifications (story 9.4, extended to FULL backup parity
 * 2026-08-19) — the per-schedule mode gate, the four-outcome mapping, and the
 * body an operator reads instead of the run.
 */

const PERL = '/usr/bin/perl'
/** Every notification string we build must survive the PVE→delivery pipeline. */
const ASCII_ONLY = /^[\x20-\x7E\n]*$/

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

const CLEAN_RUN = {
  schedule: 'nightly-media',
  taken: 'anas-daily-2026-08-19T020000Z',
  pruned: ['anas-daily-2026-08-12T020000Z'],
  skippedHeld: [],
}
const HELD_RUN = { ...CLEAN_RUN, skippedHeld: ['anas-daily-2026-08-11T020000Z'] }

describe('snapshot schedule notifications — the mode gate (9.4)', () => {
  it('the full matrix: both modes x all four outcomes', () => {
    // `always` mails every real run; `on-failure` only what went wrong; a skip
    // (no unattended family produces one today) is silent in both.
    assert.equal(shouldNotify('always', 'success'), true)
    assert.equal(shouldNotify('always', 'warning'), true)
    assert.equal(shouldNotify('always', 'failure'), true)
    assert.equal(shouldNotify('always', 'skip'), false)
    assert.equal(shouldNotify('on-failure', 'success'), false)
    assert.equal(shouldNotify('on-failure', 'warning'), true)
    assert.equal(shouldNotify('on-failure', 'failure'), true)
    assert.equal(shouldNotify('on-failure', 'skip'), false)
  })

  it('the default mode is the QUIET one — a schedule can fire every 15 minutes', () => {
    assert.equal(makeSchedule().notify, 'on-failure')
  })

  it('a schedule stored before the field existed reads back as on-failure', () => {
    // Version skew: 518a0e3 shipped no `notify` at all, so every unit written
    // then must keep exactly the failure-only behaviour it had.
    const parsed = SnapshotSchedule.parse({
      id: 'legacy',
      name: 'Legacy',
      target: { kind: 'zfs', dataset: 'testpool/old' },
      cadence: 'hourly',
      retention: { hourly: 24 },
      enabled: true,
    })
    assert.equal(parsed.notify, 'on-failure')
  })

  it('outcome: error = failure, held-and-unprunable = warning, clean = success', () => {
    const schedule = makeSchedule()
    assert.equal(snapshotNotifyOutcome({ schedule, error: 'cannot create snapshot' }), 'failure')
    assert.equal(snapshotNotifyOutcome({ schedule, result: HELD_RUN }), 'warning')
    assert.equal(snapshotNotifyOutcome({ schedule, result: CLEAN_RUN }), 'success')
  })

  it('severity is the routing signal PVE matches on', () => {
    assert.equal(notifySeverity('failure'), 'error')
    assert.equal(notifySeverity('warning'), 'warning')
    assert.equal(notifySeverity('success'), 'info')
  })

  it('the title names the schedule and the verdict (the subject template renders it)', () => {
    const s = makeSchedule()
    assert.equal(snapshotNotifyTitle(s, 'failure'), 'snapshot schedule \'Nightly media\' FAILED')
    assert.equal(snapshotNotifyTitle(s, 'warning'), 'snapshot schedule \'Nightly media\' completed with warnings')
    assert.equal(snapshotNotifyTitle(s, 'success'), 'snapshot schedule \'Nightly media\' succeeded')
  })

  it('the target line spells out either backend, never truncated', () => {
    assert.equal(snapshotTargetLine({ kind: 'zfs', dataset: 'testpool/media' }), 'ZFS dataset testpool/media')
    assert.equal(snapshotTargetLine({ kind: 'ahr', pool: 'bay1' }), 'AHR pool bay1')
  })

  it('the retention summary reads in words, and says so when policy keeps nothing', () => {
    assert.equal(retentionSummaryLine({ hourly: 24, daily: 30, monthly: 12 }), '24 hourly / 30 daily / 12 monthly')
    assert.match(retentionSummaryLine({}), /nothing kept by policy/)
  })

  it('the prune summary counts what happened, and names held snapshots as kept', () => {
    assert.equal(pruneSummaryLine(CLEAN_RUN), '1 destroyed')
    assert.equal(pruneSummaryLine(HELD_RUN), '1 destroyed, 1 held (kept despite policy)')
  })
})

describe('snapshot schedule notifications — the body (9.4)', () => {
  it('a failure body carries the schedule, the target, the cadence and the error verbatim', () => {
    const body = buildSnapshotNotifyBody({
      schedule: makeSchedule(),
      error: 'cannot create snapshot \'testpool/media@anas-daily\': out of space',
      elapsedMs: 95_000,
    })
    assert.match(body, /Schedule:\s+Nightly media \(nightly-media\)/)
    assert.match(body, /Target:\s+ZFS dataset testpool\/media/)
    assert.match(body, /Result:\s+FAILED/)
    assert.match(body, /Duration:\s+1m 35s \(job elapsed\)/)
    assert.match(body, /Cadence:\s+daily/)
    assert.match(body, /Retention:\s+7 daily \/ 4 weekly/)
    assert.ok(body.includes('cannot create snapshot \'testpool/media@anas-daily\': out of space'))
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

  it('a SUCCESS body is a full receipt: snapshot taken, what prune did, duration', () => {
    const body = buildSnapshotNotifyBody({
      schedule: makeSchedule(),
      result: CLEAN_RUN,
      elapsedMs: 4_000,
    })
    assert.match(body, /Result:\s+success/)
    assert.match(body, /Snapshot:\s+anas-daily-2026-08-19T020000Z/)
    assert.match(body, /Duration:\s+4s \(job elapsed\)/)
    assert.match(body, /Pruned:\s+1 destroyed/)
    assert.ok(body.includes('anas-daily-2026-08-12T020000Z'), 'the destroyed snapshot is named')
    assert.ok(!body.includes('Error:'), 'a success body names no error')
    assert.ok(!body.includes('Held'), 'nothing was held, so nothing is said about holds')
  })

  it('a WARNING body says so and lists the held snapshots retention could not prune', () => {
    const body = buildSnapshotNotifyBody({ schedule: makeSchedule(), result: HELD_RUN })
    assert.match(body, /Result:\s+completed with warnings/)
    assert.match(body, /Pruned:\s+1 destroyed, 1 held \(kept despite policy\)/)
    assert.ok(body.includes('Held (retained, never pruned):'))
    assert.ok(body.includes('anas-daily-2026-08-11T020000Z'))
  })

  it('the body ends on the facts — no closing pointer to the UI', () => {
    const body = buildSnapshotNotifyBody({ schedule: makeSchedule(), result: CLEAN_RUN })
    assert.ok(!body.includes('Snapshots view'), 'no editorial closing line')
    assert.match(body.trimEnd(), /Retention:\s+7 daily \/ 4 weekly$/)
  })

  it('every body is pure ASCII — the delivery pipeline mangles anything else', () => {
    for (const ctx of [
      { schedule: makeSchedule(), result: CLEAN_RUN, elapsedMs: 1_000 },
      { schedule: makeSchedule(), result: HELD_RUN },
      { schedule: makeSchedule({ target: { kind: 'ahr' as const, pool: 'bay1' }, enabled: false }), error: 'boom' },
    ]) {
      assert.match(buildSnapshotNotifyBody(ctx), ASCII_ONLY)
      assert.match(snapshotNotifyTitle(ctx.schedule, snapshotNotifyOutcome(ctx)), ASCII_ONLY)
    }
  })
})

describe('snapshot schedule notifications — emission (9.4)', () => {
  function mockPerl(exitCode = 0): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: exitCode ? 'no target' : '', exitCode } })
    return executor
  }

  it('a failed run emits `error` through the anas-snapshot template, in BOTH modes', async () => {
    for (const notify of ['on-failure', 'always'] as const) {
      const executor = mockPerl()
      await notifyScheduleRun(executor, { schedule: makeSchedule({ notify }), error: 'out of space' })
      assert.equal(executor.calls.length, 1)
      const call = executor.calls[0]
      assert.equal(call.command, PERL)
      assert.ok(call.args[1].includes(ANAS_SNAPSHOT_NOTIFY_TEMPLATE))
      assert.equal(call.args[2], 'error')
      assert.equal(call.args[3], 'snapshot schedule \'Nightly media\' FAILED')
      assert.ok(call.args[4].includes('out of space'))
    }
  })

  it('an `always` schedule mails a good fire as `info`', async () => {
    const executor = mockPerl()
    await notifyScheduleRun(executor, { schedule: makeSchedule({ notify: 'always' }), result: CLEAN_RUN })
    assert.equal(executor.calls.length, 1)
    assert.equal(executor.calls[0].args[2], 'info')
    assert.equal(executor.calls[0].args[3], 'snapshot schedule \'Nightly media\' succeeded')
  })

  it('an `on-failure` schedule costs a good fire nothing at all — no exec', async () => {
    const executor = mockPerl()
    await notifyScheduleRun(executor, { schedule: makeSchedule({ notify: 'on-failure' }), result: CLEAN_RUN })
    assert.deepEqual(executor.calls, [])
  })

  it('a held-and-unprunable fire mails `warning` even on `on-failure`', async () => {
    const executor = mockPerl()
    await notifyScheduleRun(executor, { schedule: makeSchedule({ notify: 'on-failure' }), result: HELD_RUN })
    assert.equal(executor.calls.length, 1)
    assert.equal(executor.calls[0].args[2], 'warning')
    assert.equal(executor.calls[0].args[3], 'snapshot schedule \'Nightly media\' completed with warnings')
  })

  it('a delivery failure is swallowed — best-effort by contract', async () => {
    const executor = mockPerl(255)
    await assert.doesNotReject(notifyScheduleRun(executor, { schedule: makeSchedule(), error: 'boom' }))
  })
})
