import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapshotSchedule } from '../schemas/schedules.js'

/**
 * Story snaptime.1 (#83): a snapshot schedule's fire shape — the time of day,
 * the weekday, the day of the month and (yearly) the month. All four are
 * ADDITIVE and optional, and the rules for which cadence may carry which live
 * in one shared helper, so the request body and the stored unit JSON hold the
 * same ones.
 */
const BASE = {
  id: 'nightly-tank',
  name: 'Nightly tank',
  target: { kind: 'zfs', dataset: 'tank' },
  cadence: 'daily',
  retention: { daily: 7 },
  enabled: true,
}

function firstIssue(input: unknown): { path?: PropertyKey[], message: string } | undefined {
  const r = SnapshotSchedule.safeParse(input)
  return r.success ? undefined : r.error.issues[0]
}

function firstMessage(input: unknown): string | undefined {
  return firstIssue(input)?.message
}

describe('SnapshotSchedule fire shape (snaptime.1)', () => {
  it('a stored schedule without the fields parses to exactly today\'s object', () => {
    const r = SnapshotSchedule.safeParse(BASE)
    assert.ok(r.success)
    assert.deepEqual(r.data, { ...BASE, notify: 'on-failure' })
    assert.equal('time' in r.data, false)
    assert.equal('weekday' in r.data, false)
    assert.equal('dayOfMonth' in r.data, false)
    assert.equal('month' in r.data, false)
    // And the stored JSON keeps exactly today's shape: a schedule saved before
    // the fields existed must render and parse back byte-identically.
    assert.equal(JSON.stringify(SnapshotSchedule.parse(BASE)), JSON.stringify({ ...BASE, notify: 'on-failure' }))
  })

  it('accepts time on daily, weekly, monthly and yearly', () => {
    for (const cadence of ['daily', 'weekly', 'monthly', 'yearly'] as const) {
      const r = SnapshotSchedule.safeParse({ ...BASE, cadence, time: '01:30' })
      assert.ok(r.success, `${cadence}: ${r.error?.issues[0]?.message}`)
      assert.equal(r.data.time, '01:30')
    }
  })

  it('refuses time on frequently and hourly, naming the interval it actually fires on', () => {
    assert.equal(
      firstMessage({ ...BASE, cadence: 'frequently', time: '01:30' }),
      'A schedule that fires every 15 minutes has no time of day',
    )
    assert.equal(
      firstMessage({ ...BASE, cadence: 'hourly', time: '01:30' }),
      'An hourly schedule has no time of day — it fires every hour',
    )
  })

  it('refuses weekday on anything but weekly', () => {
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'weekly', weekday: 'Thu' }).success, true)
    for (const cadence of ['frequently', 'hourly', 'daily', 'monthly', 'yearly'] as const)
      assert.equal(firstMessage({ ...BASE, cadence, weekday: 'Thu' }), 'Weekday applies to a weekly schedule only')
  })

  it('accepts dayOfMonth on monthly AND yearly, refuses it elsewhere', () => {
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'monthly', dayOfMonth: 15 }).success, true)
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'yearly', dayOfMonth: 17 }).success, true)
    for (const cadence of ['frequently', 'hourly', 'daily', 'weekly'] as const)
      assert.equal(firstMessage({ ...BASE, cadence, dayOfMonth: 15 }), 'Day of the month applies to a monthly or yearly schedule only')
  })

  it('dayOfMonth is 1 to 31: 31 accepted, 32 and 0 and 1.5 refused', () => {
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'monthly', dayOfMonth: 31 }).success, true)
    assert.ok(firstIssue({ ...BASE, cadence: 'monthly', dayOfMonth: 32 }) !== undefined)
    assert.ok(firstIssue({ ...BASE, cadence: 'monthly', dayOfMonth: 0 }) !== undefined)
    assert.ok(firstIssue({ ...BASE, cadence: 'monthly', dayOfMonth: 1.5 }) !== undefined)
  })

  it('month is yearly only, 1 to 12', () => {
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'yearly', month: 1 }).success, true)
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'yearly', month: 12 }).success, true)
    assert.ok(firstIssue({ ...BASE, cadence: 'yearly', month: 0 }) !== undefined)
    assert.ok(firstIssue({ ...BASE, cadence: 'yearly', month: 13 }) !== undefined)
    for (const cadence of ['frequently', 'hourly', 'daily', 'weekly', 'monthly'] as const)
      assert.equal(firstMessage({ ...BASE, cadence, month: 6 }), 'Month applies to a yearly schedule only')
  })

  it('time is a 24-hour HH:MM: 00:00 and 23:59 accepted, 24:00 / 1:30 / 01:60 refused', () => {
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, time: '00:00' }).success, true)
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, time: '23:59' }).success, true)
    for (const time of ['24:00', '1:30', '01:60'])
      assert.equal(firstMessage({ ...BASE, time }), 'a 24-hour HH:MM time')
  })

  it('null is a legal CLEAR on any cadence and never trips a shape rule', () => {
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'hourly', time: null }).success, true)
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'daily', weekday: null, dayOfMonth: null }).success, true)
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'weekly', weekday: null, time: null }).success, true)
    // A monthly schedule clearing a month is a legal request: the clear is
    // applied before the cadence rule would ever see a value.
    assert.equal(SnapshotSchedule.safeParse({ ...BASE, cadence: 'monthly', month: null }).success, true)
  })
})
