import type { BackupCadence } from '@anas/shared'

/**
 * Backup task CADENCE logic (Epic 16.10) — the run-time half of the structured
 * schedule. The other half is the contract itself (`BackupCadence` +
 * `cadenceToOnCalendar` in @anas/shared): the timer expression is GENERATED from
 * the cadence, so everything here is what systemd's calendar cannot express.
 *
 * Exactly one thing qualifies: BIWEEKLY. `OnCalendar=` has no "every other
 * week", so a biweekly task runs on a WEEKLY timer and this module decides, on
 * each scheduled fire, whether the current ISO week is the task's week.
 *
 *   - weekly / monthly / custom are NOT gated at all. They are pure OnCalendar,
 *     and `Persistent=true` on the timer is their missed-run heal (systemd
 *     coalesces missed fires into one catch-up — correct for a backup).
 *   - Parity is EXPLICIT config, never derived from a creation date: the six
 *     real cron jobs this story replaces stagger their phases deliberately, and
 *     the migration has to be able to say which phase it wants.
 *   - The gate applies to SCHEDULED fires only. A Run Now is explicit user
 *     intent and always runs.
 *
 * Everything here is pure: `now` is always passed in, so tests drive both
 * parities and the heal window without touching the wall clock.
 */

/** One ISO week. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** A biweekly task's full period — the heal threshold and its overdue window. */
export const BIWEEKLY_PERIOD_MS = 2 * WEEK_MS
/**
 * Grace added to a cadence's period before it reads overdue. A fire happens at a
 * fixed clock time, so half a day past a full period means a scheduled run was
 * definitively missed rather than merely pending.
 */
const OVERDUE_SLACK_MS = 12 * 60 * 60 * 1000
/** A month's longest span — a monthly cadence must not cry wolf in a long month. */
const MONTH_MAX_MS = 31 * 24 * 60 * 60 * 1000

/**
 * The ISO-8601 week number of a date, with `date +%V` semantics: weeks start on
 * Monday, and week 1 is the week containing the year's first Thursday.
 *
 * Computed from the LOCAL calendar date, because that is what `date +%V` reports
 * and what an `OnCalendar=` fire time means — a 02:00 local fire can fall in a
 * different UTC week, and reading the week in UTC would flip the parity of an
 * entire task for operators west of Greenwich. The local Y/M/D is re-anchored
 * into UTC so the day arithmetic itself stays DST-proof.
 */
export function isoWeekNumber(now: Date): number {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  // Shift to the Thursday of this week (Mon=1..Sun=7): the year owning that
  // Thursday is the ISO week-year, by definition.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + 4 - isoDay)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7)
}

/** Whether a date falls in an even or odd ISO week. */
export function isoWeekParity(now: Date): 'even' | 'odd' {
  return isoWeekNumber(now) % 2 === 0 ? 'even' : 'odd'
}

/** How a run was triggered. Only a scheduled fire is ever gated. */
export type BackupTrigger = 'scheduled' | 'manual'

export interface CadenceGateInput {
  /** The task's cadence (absent = a raw OnCalendar task: never gated). */
  cadence?: BackupCadence
  trigger: BackupTrigger
  now: Date
  /**
   * When the task last completed a real backup (LOCAL-ONLY: systemd + journald).
   * null = no record — the journal rotated, or the task has never run.
   */
  lastSuccessAt: string | null
}

/**
 * Why a scheduled fire ran (or did not). Every value is journal-visible text, so
 * the operator can always read the decision back off the run.
 */
export type CadenceGateReason
  = | 'ungated' //     not a biweekly task — OnCalendar alone is the schedule
    | 'manual' //      Run Now: explicit user intent, never gated
    | 'on-week' //     the ISO week matches the configured parity
    | 'heal' //        off week, but a full period passed without a success
    | 'no-record' //   off week, no last-success record — fail toward running
    | 'off-week' //    the only outcome that skips

export interface CadenceGateDecision {
  run: boolean
  reason: CadenceGateReason
  /** Human detail, logged on the run and surfaced as the skip's reason. */
  detail: string
}

/**
 * Decide whether a fire should actually back up.
 *
 * Heal rule (biweekly only): run regardless of parity when the last SUCCESSFUL
 * run is older than one full period. Because parity is fixed config, a heal
 * produces at most ONE shortened 7-day interval and then re-locks to the
 * configured phase — the phase never flips. This also covers an on-week run that
 * FAILED (not merely missed): the next off-week fire retries it, since the
 * failure left the last success more than a period behind.
 *
 * With no last-success record at all (fresh task, rotated journal) it runs: a
 * redundant backup is safe, a missed one is not.
 */
export function decideCadenceRun(input: CadenceGateInput): CadenceGateDecision {
  const { cadence, trigger, now, lastSuccessAt } = input
  // Nothing to gate: the timer expression already IS the schedule.
  if (!cadence || cadence.kind !== 'biweekly' || !cadence.parity) {
    return { run: true, reason: 'ungated', detail: 'schedule is expressed entirely by the timer' }
  }
  if (trigger !== 'scheduled')
    return { run: true, reason: 'manual', detail: 'run started by hand — the off-week gate applies to scheduled fires only' }

  const week = isoWeekNumber(now)
  const parity = week % 2 === 0 ? 'even' : 'odd'
  const weekText = `ISO week ${week} is ${parity}, this task runs ${cadence.parity} weeks`
  if (parity === cadence.parity)
    return { run: true, reason: 'on-week', detail: weekText }

  if (!lastSuccessAt) {
    return {
      run: true,
      reason: 'no-record',
      detail: `${weekText}, but no successful run is on record — running rather than risk a missed backup`,
    }
  }
  const last = Date.parse(lastSuccessAt)
  if (Number.isNaN(last)) {
    return { run: true, reason: 'no-record', detail: `${weekText}, but the last-success time could not be read — running` }
  }
  const elapsed = now.getTime() - last
  if (elapsed > BIWEEKLY_PERIOD_MS) {
    return {
      run: true,
      reason: 'heal',
      detail: `${weekText} — but the last successful backup was ${formatDays(elapsed)} ago, `
        + 'more than a full period: running now, then back on the configured week',
    }
  }
  return {
    run: false,
    reason: 'off-week',
    detail: `${weekText} — skipped (off week); last successful backup ${formatDays(elapsed)} ago`,
  }
}

/** `1.5 days` / `13 hours` — enough precision to read a heal decision back. */
function formatDays(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 48)
    return `${Math.round(hours)} hours`
  return `${(hours / 24).toFixed(1)} days`
}

/**
 * How long a cadence may go without a successful run before it reads overdue —
 * one full period plus slack. Returns undefined for a raw-OnCalendar task, whose
 * period ANAS genuinely does not know: those keep the timer-only rule they have
 * always had.
 *
 * The biweekly window is the 14-day PERIOD, not the weekly timer that drives it
 * — which is exactly why an off-week skip never makes a healthy task read
 * overdue (16.7's "past its schedule without a successful run counts as failed"
 * measured against the real cadence).
 */
export function overdueWindowMs(cadence?: BackupCadence): number | undefined {
  if (!cadence)
    return undefined
  switch (cadence.kind) {
    case 'weekly':
      return WEEK_MS + OVERDUE_SLACK_MS
    case 'biweekly':
      return BIWEEKLY_PERIOD_MS + OVERDUE_SLACK_MS
    case 'monthly':
      return MONTH_MAX_MS + OVERDUE_SLACK_MS
    default:
      return undefined
  }
}

export interface OverdueInput {
  enabled: boolean
  cadence?: BackupCadence
  /** The timer's next elapse (ISO), or null when systemd reports none. */
  nextRunAt: string | null
  /** Last SUCCESSFUL run (ISO), or null when there is no record. */
  lastSuccessAt: string | null
  now: number
}

/**
 * Is an enabled task overdue? Two independent, honest signals:
 *  1. The timer's next elapse is in the PAST — a Persistent timer that never
 *     caught up (the pre-16.10 rule, cadence-independent, still first).
 *  2. A cadence with a KNOWN period has gone longer than that period without a
 *     successful run.
 * A disabled task is never overdue, and an unknown last-success never manufactures
 * one (fail-open: no record is not evidence of a missed backup).
 */
export function isTaskOverdue(input: OverdueInput): boolean {
  if (!input.enabled)
    return false
  if (input.nextRunAt) {
    const next = Date.parse(input.nextRunAt)
    if (!Number.isNaN(next) && next < input.now)
      return true
  }
  const window = overdueWindowMs(input.cadence)
  if (window === undefined || !input.lastSuccessAt)
    return false
  const last = Date.parse(input.lastSuccessAt)
  return !Number.isNaN(last) && input.now - last > window
}
