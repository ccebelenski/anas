import { z } from 'zod'

/**
 * Task CADENCE — the structured schedule a scheduled-task store edits, shared by
 * every unit-store task kind (backup first, cloud sync next: rclone.2's
 * `TaskCadence` is this schema, and `BackupCadence` is the alias the backup
 * schemas keep so nothing that names it has to change).
 *
 * The contract half lives here (the shape + the `OnCalendar=` generator); the
 * run-time half — the biweekly parity gate and the overdue windows — is the
 * daemon's `services/backup-cadence.ts`, which both stores call.
 */

// ---- Cadence (16.10) -------------------------------------------------------
//
// A task's schedule stays a systemd `OnCalendar=` expression — `cadence` is the
// STRUCTURED form the UI edits, and when present the daemon GENERATES the
// expression from it (the cadence is then authoritative; see cadenceToOnCalendar
// and BackupTaskRequest). Absent cadence = a hand-written OnCalendar, which is
// what every task created before 16.10 carries — those keep working verbatim.
//
// ANAS adds run-time logic ONLY where OnCalendar cannot express the schedule:
//   weekly / monthly / custom → pure OnCalendar, NO gate. systemd's
//     `Persistent=true` is the missed-run heal there (it coalesces missed fires
//     into one catch-up, which is the correct behaviour for a backup).
//   biweekly → a WEEKLY timer plus an ISO-week parity gate in the daemon's run
//     path, because OnCalendar has no "every other week" (see backup-cadence.ts).

/**
 * Weekday abbreviations — deliberately systemd's OWN OnCalendar spelling, so a
 * generated expression is a plain join with no translation table in between.
 */
export const TaskWeekday = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
export type TaskWeekday = z.infer<typeof TaskWeekday>

/** ISO-8601 weekday order (Mon..Sun); generated expressions are always sorted. */
export const TASK_WEEKDAYS: readonly TaskWeekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * The cadence shapes ANAS can express structurally. `custom` is the raw
 * OnCalendar escape hatch — identical in behaviour to an absent cadence, and the
 * reason no existing task needs migrating.
 */
export const TaskCadenceKind = z.enum(['weekly', 'biweekly', 'monthly', 'custom'])
export type TaskCadenceKind = z.infer<typeof TaskCadenceKind>

/**
 * Which ISO-week parity a biweekly task runs in. EXPLICIT config, never derived
 * from a creation date: real biweekly fleets stagger their jobs across both
 * phases deliberately, and a migration must be able to state the phase it wants.
 */
export const TaskWeekParity = z.enum(['even', 'odd'])
export type TaskWeekParity = z.infer<typeof TaskWeekParity>

/** A 24-hour `HH:MM` fire time (the OnCalendar time component). */
export const TaskTimeOfDay = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour HH:MM time')
export type TaskTimeOfDay = z.infer<typeof TaskTimeOfDay>

/**
 * The structured schedule. Per-kind shape (enforced below, so an impossible
 * cadence cannot be stored):
 *   weekly    — 1..7 days, a time. Fires on each chosen weekday.
 *   biweekly  — exactly ONE day, a time, and an explicit ISO-week `parity`.
 *   monthly   — exactly ONE day, a time. Fires on that weekday's FIRST
 *               occurrence in the month.
 *   custom    — no days/time/parity; the task's raw `schedule` stands.
 */
export const TaskCadence = z
  .object({
    kind: TaskCadenceKind,
    /** Weekdays this cadence fires on (unused for `custom`). */
    days: z.array(TaskWeekday).max(7).default([]),
    /** Fire time, `HH:MM` (unused for `custom`). */
    time: TaskTimeOfDay.optional(),
    /** biweekly ONLY: which ISO-week parity actually runs. */
    parity: TaskWeekParity.optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [path] })
    }
    if (c.kind === 'custom') {
      if (c.days.length)
        issue('a custom cadence carries no weekdays — the raw schedule stands', 'days')
      return
    }
    if (!c.time)
      issue('a time (HH:MM) is required', 'time')
    if (c.kind === 'weekly' && c.days.length < 1)
      issue('choose at least one weekday', 'days')
    if (c.kind !== 'weekly' && c.days.length !== 1)
      issue(`a ${c.kind} cadence runs on exactly one weekday`, 'days')
    if (c.kind === 'biweekly' && !c.parity)
      issue('a biweekly cadence needs an explicit even/odd ISO-week parity', 'parity')
    if (c.kind !== 'biweekly' && c.parity)
      issue('week parity applies to a biweekly cadence only', 'parity')
  })
  // Normalise the weekdays on the way IN — deduped and in ISO order — so the
  // stored cadence and the expression generated from it can never disagree, and
  // two spellings of the same schedule are the same config.
  .transform(c => ({ ...c, days: TASK_WEEKDAYS.filter(d => c.days.includes(d)) }))
export type TaskCadence = z.infer<typeof TaskCadence>

/**
 * Translate a cadence into the systemd `OnCalendar=` expression that drives its
 * timer. Returns null for `custom` (the task's raw schedule is the expression).
 *
 * The generated forms — all validated against `systemd-analyze calendar`, and
 * re-validated by the daemon on every write:
 *   weekly    `Tue,Thu 02:00`          → Tue,Thu *-*-* 02:00:00
 *   biweekly  `Tue 02:00`              → Tue *-*-* 02:00:00 (the parity gate
 *                                        skips the off weeks — the timer cannot)
 *   monthly   `Sun *-*-01..07 02:00`   → the first Sun of each month (a 7-day
 *                                        window holds exactly one of each weekday)
 * Days are emitted deduped and in ISO order, so the same cadence always renders
 * the same string (a rewrite never churns the unit file).
 */
export function cadenceToOnCalendar(cadence: TaskCadence): string | null {
  if (cadence.kind === 'custom' || !cadence.time)
    return null
  const days = TASK_WEEKDAYS.filter(d => cadence.days.includes(d))
  if (!days.length)
    return null
  if (cadence.kind === 'monthly')
    return `${days[0]} *-*-01..07 ${cadence.time}`
  return `${days.join(',')} ${cadence.time}`
}
