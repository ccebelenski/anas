import type { BackupCadence } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BackupCadence as BackupCadenceSchema, BackupTaskRequest, cadenceToOnCalendar } from '@anas/shared'
import {
  BIWEEKLY_PERIOD_MS,
  decideCadenceRun,
  isoWeekNumber,
  isoWeekParity,
  isTaskOverdue,
  overdueWindowMs,
} from '../backup-cadence.js'

/**
 * Backup cadence (Epic 16.10) — the structured schedule and the one thing
 * OnCalendar cannot express (biweekly), tested purely: `now` is always passed in,
 * so both ISO-week parities and the heal window are driven without a wall clock.
 */

/** Local-constructor dates, so a test never depends on the runner's timezone. */
function at(y: number, m: number, d: number, hh = 2, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0)
}

function cadence(over: Partial<BackupCadence> & { kind: BackupCadence['kind'] }): BackupCadence {
  return BackupCadenceSchema.parse({ days: [], ...over })
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('backup cadence — ISO week numbering (date +%V semantics)', () => {
  // Ground truth: `date -d <date> +%V` on the dev host (systemd 259 / coreutils),
  // including both hard cases — a year that starts mid-week and a December date
  // that already belongs to the NEXT ISO year.
  const GROUND_TRUTH: [Date, number][] = [
    [at(2026, 1, 1), 1],
    [at(2026, 1, 4), 1], //   Sunday still belongs to week 1
    [at(2026, 1, 5), 2], //   Monday opens week 2
    [at(2026, 2, 3), 6],
    [at(2026, 8, 11), 33],
    [at(2026, 8, 17), 34],
    [at(2026, 8, 18), 34],
    [at(2026, 8, 24), 35],
    [at(2026, 12, 31), 53],
    [at(2027, 1, 1), 53], //  still last year's week 53
    [at(2021, 1, 1), 53], //  ditto, across a leap-week year
    [at(2024, 12, 30), 1], // already week 1 of 2025
  ]

  it('matches `date +%V` on every ground-truth date', () => {
    for (const [date, week] of GROUND_TRUTH)
      assert.equal(isoWeekNumber(date), week, date.toDateString())
  })

  it('parity follows the week number', () => {
    assert.equal(isoWeekParity(at(2026, 8, 17)), 'even') // week 34
    assert.equal(isoWeekParity(at(2026, 8, 24)), 'odd') //  week 35
  })

  it('reads the LOCAL calendar date — a 02:00 fire is in the week the operator sees', () => {
    // 2026-08-24 02:00 local is week 35 wherever the runner sits; computing the
    // week in UTC would flip an entire task's parity west of Greenwich.
    assert.equal(isoWeekNumber(at(2026, 8, 24, 2, 0)), 35)
    assert.equal(isoWeekNumber(at(2026, 8, 23, 23, 30)), 34)
  })
})

describe('backup cadence — cadence → OnCalendar (the generator is the contract)', () => {
  // Every expression below was run through the real `systemd-analyze calendar`
  // (systemd 259) and normalized as noted; the daemon re-validates each generated
  // string with systemd on every write, so this stays honest.
  it('weekly renders the chosen weekdays in ISO order', () => {
    // Normalized form: Tue,Thu *-*-* 02:00:00
    assert.equal(cadenceToOnCalendar(cadence({ kind: 'weekly', days: ['Thu', 'Tue'], time: '02:00' })), 'Tue,Thu 02:00')
    assert.equal(cadenceToOnCalendar(cadence({ kind: 'weekly', days: ['Sun'], time: '23:45' })), 'Sun 23:45')
    assert.equal(
      cadenceToOnCalendar(cadence({ kind: 'weekly', days: ['Sun', 'Sat', 'Mon', 'Wed'], time: '00:30' })),
      'Mon,Wed,Sat,Sun 00:30',
    )
  })

  it('biweekly renders a WEEKLY expression — the parity gate skips the off weeks', () => {
    // Normalized form: Tue *-*-* 02:00:00. systemd has no "every other week"; the
    // timer fires weekly and the daemon gate does the rest.
    assert.equal(cadenceToOnCalendar(cadence({ kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'even' })), 'Tue 02:00')
    assert.equal(cadenceToOnCalendar(cadence({ kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'odd' })), 'Tue 02:00')
  })

  it('monthly renders the FIRST such weekday of the month', () => {
    // Normalized form: Sun *-*-01..07 02:00:00 — a 7-day window holds exactly one
    // of each weekday, so this fires once a month.
    assert.equal(cadenceToOnCalendar(cadence({ kind: 'monthly', days: ['Sun'], time: '02:00' })), 'Sun *-*-01..07 02:00')
  })

  it('custom generates nothing — the raw schedule stands', () => {
    assert.equal(cadenceToOnCalendar(cadence({ kind: 'custom' })), null)
  })

  it('the request schema DERIVES schedule from a cadence (one generator, not two)', () => {
    const base = {
      name: 'nightly-etc',
      repository: 'pbs-main',
      backupId: 'anas-pve',
      archives: [{ name: 'etc', path: '/etc', excludes: [] }],
      enabled: true,
    }
    // The UI never sends a schedule for a structured cadence — and if it sends a
    // stale one, the cadence still wins.
    const parsed = BackupTaskRequest.parse({ ...base, cadence: { kind: 'weekly', days: ['Tue', 'Thu'], time: '02:00' } })
    assert.equal(parsed.schedule, 'Tue,Thu 02:00')
    const stale = BackupTaskRequest.parse({ ...base, schedule: 'daily', cadence: { kind: 'monthly', days: ['Sun'], time: '02:00' } })
    assert.equal(stale.schedule, 'Sun *-*-01..07 02:00')
    // No cadence: the raw expression is untouched (every pre-16.10 task).
    assert.equal(BackupTaskRequest.parse({ ...base, schedule: '*-*-* 02:00:00' }).schedule, '*-*-* 02:00:00')
  })

  it('rejects impossible cadences at the schema (not in the daemon by hand)', () => {
    const bad = [
      { kind: 'weekly', days: [], time: '02:00' }, //                  no weekday
      { kind: 'weekly', days: ['Tue'] }, //                            no time
      { kind: 'biweekly', days: ['Tue'], time: '02:00' }, //           no parity
      { kind: 'biweekly', days: ['Tue', 'Thu'], time: '02:00', parity: 'even' }, // two days
      { kind: 'monthly', days: ['Tue'], time: '02:00', parity: 'even' }, // parity is biweekly-only
      { kind: 'weekly', days: ['Tue'], time: '2:00' }, //              not HH:MM
      { kind: 'weekly', days: ['Tue'], time: '24:00' }, //             not a real time
    ]
    for (const c of bad)
      assert.equal(BackupCadenceSchema.safeParse(c).success, false, JSON.stringify(c))
  })
})

describe('backup cadence — the biweekly parity gate', () => {
  const EVEN = cadence({ kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'even' })
  const ODD = cadence({ kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'odd' })
  const EVEN_WEEK = at(2026, 8, 18) // ISO week 34
  const ODD_WEEK = at(2026, 8, 25) //  ISO week 35

  it('runs on its own week, both parities', () => {
    const even = decideCadenceRun({ cadence: EVEN, trigger: 'scheduled', now: EVEN_WEEK, lastSuccessAt: iso(EVEN_WEEK, -7) })
    assert.equal(even.run, true)
    assert.equal(even.reason, 'on-week')
    const odd = decideCadenceRun({ cadence: ODD, trigger: 'scheduled', now: ODD_WEEK, lastSuccessAt: iso(ODD_WEEK, -7) })
    assert.equal(odd.run, true)
    assert.equal(odd.reason, 'on-week')
  })

  it('skips its off week — visibly, and never as a failure', () => {
    for (const [c, now] of [[EVEN, ODD_WEEK], [ODD, EVEN_WEEK]] as const) {
      const d = decideCadenceRun({ cadence: c, trigger: 'scheduled', now, lastSuccessAt: iso(now, -7) })
      assert.equal(d.run, false)
      assert.equal(d.reason, 'off-week')
      assert.match(d.detail, /skipped \(off week\)/)
      assert.match(d.detail, /ISO week \d+/) // the decision is readable off the journal
    }
  })

  it('heals: an off-week fire runs when the last success is older than a full period', () => {
    // A missed on-week fire: 15 days since the last success, and this is the off week.
    const d = decideCadenceRun({ cadence: EVEN, trigger: 'scheduled', now: ODD_WEEK, lastSuccessAt: iso(ODD_WEEK, -15) })
    assert.equal(d.run, true)
    assert.equal(d.reason, 'heal')
    // …and the phase does NOT flip: parity is fixed config, so the very next
    // even-week fire is still an ordinary on-week run.
    const after = decideCadenceRun({ cadence: EVEN, trigger: 'scheduled', now: at(2026, 9, 1), lastSuccessAt: iso(ODD_WEEK, 0) })
    assert.equal(after.reason, 'on-week')
  })

  it('heals after a FAILED on-week run, not only a missed one', () => {
    // Success at week 32, week-34 fire failed (so no success recorded), week 35 is
    // the off week — 21 days of no successful backup → run.
    const d = decideCadenceRun({ cadence: EVEN, trigger: 'scheduled', now: ODD_WEEK, lastSuccessAt: iso(ODD_WEEK, -21) })
    assert.equal(d.run, true)
    assert.equal(d.reason, 'heal')
  })

  it('an off week 7 days after a success is a plain skip (one period, not two)', () => {
    const d = decideCadenceRun({ cadence: EVEN, trigger: 'scheduled', now: ODD_WEEK, lastSuccessAt: iso(ODD_WEEK, -7) })
    assert.equal(d.run, false)
  })

  it('no last-success record → RUNS (a redundant backup is safe, a missed one is not)', () => {
    for (const last of [null, 'not-a-date']) {
      const d = decideCadenceRun({ cadence: EVEN, trigger: 'scheduled', now: ODD_WEEK, lastSuccessAt: last })
      assert.equal(d.run, true)
      assert.equal(d.reason, 'no-record')
    }
  })

  it('Run Now bypasses the gate — only scheduled fires are gated', () => {
    const d = decideCadenceRun({ cadence: EVEN, trigger: 'manual', now: ODD_WEEK, lastSuccessAt: iso(ODD_WEEK, -1) })
    assert.equal(d.run, true)
    assert.equal(d.reason, 'manual')
  })

  it('weekly / monthly / custom / no cadence are never gated (pure OnCalendar)', () => {
    const ungated = [
      cadence({ kind: 'weekly', days: ['Tue', 'Thu'], time: '02:00' }),
      cadence({ kind: 'monthly', days: ['Sun'], time: '02:00' }),
      cadence({ kind: 'custom' }),
      undefined,
    ]
    for (const c of ungated) {
      const d = decideCadenceRun({ cadence: c, trigger: 'scheduled', now: ODD_WEEK, lastSuccessAt: null })
      assert.equal(d.run, true, JSON.stringify(c))
      assert.equal(d.reason, 'ungated')
    }
  })

  it('the heal threshold is exactly one biweekly period', () => {
    assert.equal(BIWEEKLY_PERIOD_MS, 14 * DAY_MS)
  })
})

describe('backup cadence — cadence-aware overdue (16.7 measured against the real period)', () => {
  const BIWEEKLY = cadence({ kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'even' })
  const now = at(2026, 8, 25).getTime()
  const future = new Date(now + DAY_MS).toISOString()

  it('a biweekly task 8 days after its last success is NOT overdue', () => {
    // 8 days in, an off-week fire has skipped — that is the cadence working, not a
    // missed backup. The weekly timer's next elapse is still in the future.
    assert.equal(isTaskOverdue({
      enabled: true,
      cadence: BIWEEKLY,
      nextRunAt: future,
      lastSuccessAt: new Date(now - 8 * DAY_MS).toISOString(),
      now,
    }), false)
  })

  it('a biweekly task 15+ days after its last success IS overdue', () => {
    for (const days of [15, 20]) {
      assert.equal(isTaskOverdue({
        enabled: true,
        cadence: BIWEEKLY,
        nextRunAt: future,
        lastSuccessAt: new Date(now - days * DAY_MS).toISOString(),
        now,
      }), true, `${days} days`)
    }
  })

  it('the pre-16.10 rule still stands: a next elapse in the past is overdue', () => {
    assert.equal(isTaskOverdue({
      enabled: true,
      nextRunAt: new Date(now - 1000).toISOString(),
      lastSuccessAt: null,
      now,
    }), true)
  })

  it('a raw-schedule task keeps the timer-only rule (ANAS does not know its period)', () => {
    assert.equal(overdueWindowMs(undefined), undefined)
    assert.equal(overdueWindowMs(cadence({ kind: 'custom' })), undefined)
    assert.equal(isTaskOverdue({
      enabled: true,
      nextRunAt: future,
      lastSuccessAt: new Date(now - 90 * DAY_MS).toISOString(),
      now,
    }), false)
  })

  it('a disabled task is never overdue, and no record never manufactures one', () => {
    assert.equal(isTaskOverdue({ enabled: false, cadence: BIWEEKLY, nextRunAt: null, lastSuccessAt: new Date(now - 60 * DAY_MS).toISOString(), now }), false)
    assert.equal(isTaskOverdue({ enabled: true, cadence: BIWEEKLY, nextRunAt: future, lastSuccessAt: null, now }), false)
  })

  it('each cadence carries its own window: one period plus slack', () => {
    assert.ok(overdueWindowMs(cadence({ kind: 'weekly', days: ['Tue'], time: '02:00' }))! > 7 * DAY_MS)
    assert.ok(overdueWindowMs(BIWEEKLY)! > 14 * DAY_MS)
    assert.ok(overdueWindowMs(BIWEEKLY)! < 15 * DAY_MS)
    assert.ok(overdueWindowMs(cadence({ kind: 'monthly', days: ['Sun'], time: '02:00' }))! > 31 * DAY_MS)
  })
})

/** An ISO timestamp `days` from `base` (negative = in the past). */
function iso(base: Date, days: number): string {
  return new Date(base.getTime() + days * DAY_MS).toISOString()
}
