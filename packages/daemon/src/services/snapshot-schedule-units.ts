import type { DashboardWarning, SnapshotCadence, SnapshotFireShape, SnapshotSchedule, SnapshotScheduleDetail, SnapshotScheduleStatus } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SNAPSHOT_FIRE_DEFAULTS, SnapshotDayOfMonth, snapshotFireShapeIssues, SnapshotMonth, SnapshotSchedule as SnapshotScheduleSchema, TaskTimeOfDay, TaskWeekday } from '@anas/shared'
import { DISABLED_HISTORY_NOTE } from './systemd-status.js'
// The unit-store plumbing (marker parse, dir listing, unlink/systemctl) is the
// ONE shared copy in systemd-unit-store.ts — snapshot was its second hand-copy.
import {
  listServiceUnitsChecked,
  markerRegex,
  parseMarkedJson,
  quoteExecArg,
  refuseControlChars,
  runSystemctl,
  systemdTimersStampDir,
  unlinkQuiet,
} from './systemd-unit-store.js'
import { deriveUnitRunStatus, readUnitJournal, showReadFailed, toSystemdRunResult } from './unit-run-status.js'

/**
 * Snapshot SCHEDULES (Epic 17.3/17.4/17.5) — the systemd units ARE the store,
 * the Epic 5.5 replication task-store pattern reapplied (see
 * services/replication-units.ts and services/backup-units.ts — this is the same
 * shape a third time, so the helpers are shared where they were duplicated).
 *
 * Each schedule is an `anas-snap-<id>.service` + `.timer` pair. There is NO
 * second config source and NO custom scheduler (the standing scheduling ruling):
 * CRUD writes/rewrites/removes the two unit files and drives `systemctl` to
 * reload + enable/disable the timer. The canonical SnapshotSchedule JSON is
 * embedded in the service file as an `X-ANAS-Schedule=` comment and is the SINGLE
 * source of truth parsed back — we never reverse-engineer it from ExecStart.
 *
 * The .service fires the compiled runner (dist/snapshot-task.js), which POSTs the
 * schedule's fire endpoint (take + prune) over the daemon socket — one code path
 * for the timer AND a manual Run-Now, exactly like replication/backup. `cadence`
 * (a retention bucket) is translated to `OnCalendar=` here; `Persistent=true`
 * catches runs missed across a reboot (a NAS reboots; a daily snapshot due while
 * off fires on next boot — cron can't). Status is DERIVED from systemd, never
 * stored (Principle 7), and every derivation fails open to nulls/'unknown'.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
/** The timer executes this compiled runner (ships in dist — see snapshot-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/snapshot-task.js'
const UNIT_PREFIX = 'anas-snap-'
/**
 * This store's unit-name prefix, exported for the boot sweep of orphan timer
 * stamps ({@link sweepOrphanTaskStamps} takes bare prefixes too). Same constant
 * as `UNIT_PREFIX` — one home, two names, because the sweep needs the prefix
 * and nothing else about this store.
 */
export const SNAPSHOT_UNIT_PREFIX = UNIT_PREFIX
/** The service-file line that carries the canonical schedule JSON (as a comment). */
const SCHEDULE_MARKER = 'X-ANAS-Schedule='

/** Every `%` in a unit value (systemd expands `%n`, `%H`, ... as specifiers). */
const PERCENT_RE = /%/g
/** The run of backslashes a value ends with. */
const TRAILING_BACKSLASHES_RE = /\\+$/

/**
 * The schedule name as a unit-file `Description=` value (cr3
 * DATASETS-SCHEDULES-L8): systemd expands `%` specifiers there (`100%n`
 * rendered as `100anas-snap-<id>.service`), so `%` is written `%%`; and a
 * line that ends in an odd number of backslashes CONTINUES onto the next
 * line (the marker comment below it was swallowed into the description), so
 * one more backslash is added — an even run is not a continuation (checked
 * with `systemd-analyze verify`, systemd 262). The JSON marker keeps the name
 * exactly as typed; only the human description is escaped.
 */
export function unitDescriptionText(name: string): string {
  const escaped = name.replace(PERCENT_RE, '%%')
  const run = escaped.match(TRAILING_BACKSLASHES_RE)?.[0].length ?? 0
  return run % 2 === 1 ? `${escaped}\\` : escaped
}

/** Default systemd unit directory; overridable (env/dep) for tests. */
export const DEFAULT_SYSTEMD_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

export function serviceUnitName(id: string): string {
  return `${UNIT_PREFIX}${id}.service`
}
export function timerUnitName(id: string): string {
  return `${UNIT_PREFIX}${id}.timer`
}

/**
 * Where systemd records a Persistent timer's last fire for ONE schedule: the
 * timers stamp dir (shared {@link systemdTimersStampDir}) + `stamp-<timer>` —
 * e.g. `/var/lib/systemd/timers/stamp-anas-snap-<id>.timer`. A stamp a removed
 * schedule leaves behind makes the schedule's re-creation fire at once (the
 * stamp reads as a missed run — SCHEDULES-GT-17), so removal deletes it.
 */
export function snapshotStampPath(id: string): string {
  return `${systemdTimersStampDir()}/stamp-${timerUnitName(id)}`
}

// --- Cadence → OnCalendar ----------------------------------------------------

/**
 * Translate a schedule's `cadence` (a retention bucket) into a systemd
 * `OnCalendar=` expression. The bucket that fires the snapshot is also the bucket
 * it is retained in (`anas-<bucket>-<utc>`), so cadence and retention stay
 * aligned by construction. Every value is a systemd calendar SHORTCUT except
 * `frequently`, which has no shortcut and maps to a 15-minute interval (sanoid's
 * default frequent period). All six were verified against `systemd-analyze
 * calendar` on the stunt node (systemd 257).
 */
const CADENCE_ONCALENDAR: Record<SnapshotCadence, string> = {
  frequently: '*:0/15', // every 15 minutes — normalized `*-*-* *:00/15:00`
  hourly: 'hourly', //     *-*-* *:00:00
  daily: 'daily', //       *-*-* 00:00:00
  weekly: 'weekly', //     Mon *-*-* 00:00:00
  monthly: 'monthly', //   *-*-01 00:00:00
  yearly: 'yearly', //     *-01-01 00:00:00
}

/**
 * The one calendar fact ANAS holds: the length of each month in a common year
 * (index 0 = January, 11 = December). Its ONLY job is choosing between the two
 * spellings of a day that a month may lack — `*-MM-DD` when the month always
 * has the day, `*-MM~01` (that month's last day) when it may not. February's 28
 * is why the 29th is always the last-day form, leap years included. No date is
 * ever computed here (no `Date`, no arithmetic on a calendar): systemd is the
 * calendar, and these twelve numbers are all the code needs to pick its form.
 */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** A day or month as the two-digit `OnCalendar=` field (`1` → `01`). */
function twoDigit(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The `OnCalendar=` lines a MONTHLY schedule gets (story snaptime.1, #83): one
 * line for a day every month has, two for a day February lacks, and the
 * last-day form alone for the 31st. Each was checked with `systemd-analyze
 * calendar` on the test node (2026-11-13, systemd 257):
 *
 *   day 1-28  `*-*-DD HH:MM:00`
 *   day 29-30 `*-*-DD HH:MM:00` AND `*-02~01 HH:MM:00` (February's last day)
 *   day 31    `*-*~01 HH:MM:00` (the last day of EVERY month)
 *
 * `*-*-31` is never written: systemd SKIPS a month that lacks the day, so asked
 * in November it would next elapse on 31 December. `*-*~01` does what the field
 * means — a month shorter than the day fires on its last day.
 */
function monthlyOnCalendar(dayOfMonth: number, time: string): string[] {
  const day = twoDigit(dayOfMonth)
  if (dayOfMonth >= 31)
    return [`*-*~01 ${time}:00`]
  const line = `*-*-${day} ${time}:00`
  // 29 and 30 exist in every month but February, whose last day is a second
  // expression: on a leap year's 29 February the two lines name the same
  // instant and its timer fires once.
  return dayOfMonth >= 29 ? [line, `*-02~01 ${time}:00`] : [line]
}

/**
 * The `OnCalendar=` expression a YEARLY schedule gets (story snaptime.1, #83):
 * `*-MM-DD HH:MM:00` when that month always has the day, and that month's
 * last-day form `*-MM~01 HH:MM:00` when it may not (29-31 February, 31 in a
 * 30-day month) — checked with `systemd-analyze calendar` on the test node
 * (2026-11-13): `*-06-17` normalises to itself and `*-04~01` elapses 30 April.
 */
function yearlyOnCalendar(month: number, dayOfMonth: number, time: string): string {
  const mm = twoDigit(month)
  if (dayOfMonth <= MONTH_LENGTHS[month - 1])
    return `*-${mm}-${twoDigit(dayOfMonth)} ${time}:00`
  return `*-${mm}~01 ${time}:00`
}

/** The four fire fields with their schema fences — the generator's last gate re-asks each one. */
const FIRE_FIELD_FENCES = {
  time: TaskTimeOfDay,
  weekday: TaskWeekday,
  dayOfMonth: SnapshotDayOfMonth,
  month: SnapshotMonth,
} as const
type FireFieldName = keyof typeof FIRE_FIELD_FENCES
const FIRE_FIELD_NAMES = Object.keys(FIRE_FIELD_FENCES) as FireFieldName[]

/**
 * The fire fields that actually move the schedule off its default instant:
 * set, valid, and not equal to the default (a `null` clear and an explicit
 * `00:00` / `Mon` / 1 / January are all the schedule that has no field).
 *
 * THE RENDERER IS A HARD BOUNDARY (cr.51; review of snaptime.1): every value
 * that would reach an `OnCalendar=` line is parsed HERE by the same schema
 * fence the API boundaries hold, so a corrupt in-memory schedule — a string
 * where a number belongs, a newline, `NaN`, 1.5, day 0, month 13, `99:99` —
 * throws before anything is rendered. Nothing but `HH:MM`, a weekday
 * abbreviation and two bounded integers can come out of this function.
 */
function effectiveFireFields(schedule: SnapshotFireShape): { time?: string, weekday?: string, dayOfMonth?: number, month?: number } {
  const out: Record<string, string | number> = {}
  for (const field of FIRE_FIELD_NAMES) {
    const value = schedule[field]
    if (value == null)
      continue
    const parsed = FIRE_FIELD_FENCES[field].safeParse(value)
    if (!parsed.success)
      throw new Error(`Snapshot schedule cannot fire: invalid ${field}`)
    if (parsed.data !== SNAPSHOT_FIRE_DEFAULTS[field])
      out[field] = parsed.data
  }
  return out
}

/**
 * The `OnCalendar=` LINES a schedule's timer gets — the ONE generator for both
 * the shortcut words and the field-bearing forms (story snaptime.1, #83). One
 * element for every schedule but a monthly one whose day is the 29th or 30th,
 * which carries two (the day, and February's last day).
 *
 * A schedule with NONE of `time`/`weekday`/`dayOfMonth`/`month` set renders
 * today's shortcut word BYTE-IDENTICALLY, so an upgrade rewrites no existing
 * timer. With any of them set, the long form is spelled with absent parts at
 * their defaults (time `00:00`, weekday `Mon`, day 1, month January) — every
 * expression below was checked with `systemd-analyze calendar` on the test node
 * (2026-11-13), and each normalises to itself:
 *
 *   daily    `*-*-* HH:MM:00`        weekly   `<Day> *-*-* HH:MM:00`
 *   monthly  see {@link monthlyOnCalendar}
 *   yearly   `*-MM-DD HH:MM:00`, or `*-MM~01 HH:MM:00` for a day the month lacks
 *
 * Fail loud on anything the writer must never hand systemd (the cr.51r
 * argument below): a cadence outside the enum, or a field the cadence refuses
 * — a corrupt in-memory schedule. `OnCalendar=undefined` would write a timer
 * systemd rejects at every daemon-reload, silently never firing; the writer
 * refuses BEFORE the first write instead.
 */
export function cadenceToOnCalendar(schedule: SnapshotFireShape): string[] {
  const { cadence } = schedule
  const expr: string | undefined = CADENCE_ONCALENDAR[cadence]
  if (expr === undefined)
    throw new Error(`Unknown snapshot cadence: ${String(cadence)}`)
  const issues = snapshotFireShapeIssues(schedule)
  if (issues.length > 0)
    throw new Error(`Snapshot schedule cannot fire: ${issues[0].message}`)
  // Validate, and drop what equals its default: a schedule whose fields all
  // sit at their defaults IS the shortcut word's schedule, byte for byte.
  const fire = effectiveFireFields(schedule)
  // frequently/hourly carry no time of day (the shape check above refused any
  // field they had), so they always keep their shortcut word.
  if (Object.keys(fire).length === 0 || cadence === 'frequently' || cadence === 'hourly')
    return [expr]
  const time = fire.time ?? SNAPSHOT_FIRE_DEFAULTS.time
  switch (cadence) {
    case 'daily':
      return [`*-*-* ${time}:00`]
    case 'weekly':
      return [`${fire.weekday ?? SNAPSHOT_FIRE_DEFAULTS.weekday} *-*-* ${time}:00`]
    case 'monthly':
      return monthlyOnCalendar(fire.dayOfMonth ?? SNAPSHOT_FIRE_DEFAULTS.dayOfMonth, time)
    case 'yearly':
      return [yearlyOnCalendar(fire.month ?? SNAPSHOT_FIRE_DEFAULTS.month, fire.dayOfMonth ?? SNAPSHOT_FIRE_DEFAULTS.dayOfMonth, time)]
  }
}

// --- Runner argv -------------------------------------------------------------

/** The argv the timer passes to the runner (which POSTs the fire job + polls it). */
export function runnerArgs(schedule: SnapshotSchedule): string[] {
  return ['--id', schedule.id]
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Drop every CLEARED fire field (`null`) from a schedule bound for the store
 * (story snaptime.1, #83). A PUT clears a stored
 * `time`/`weekday`/`dayOfMonth`/`month` by sending `null`; the store holds
 * ABSENCE, never a null, so a stored
 * schedule parses back to a shape indistinguishable from one saved before the
 * field existed. Applied by {@link renderServiceUnit} — the one place the
 * stored JSON is made — so both the mutation and every reader get it.
 */
function withoutClearedFireFields(schedule: SnapshotSchedule): SnapshotSchedule {
  const { time, weekday, dayOfMonth, month, ...rest } = schedule
  // A cleared field (`null`) and a field at its default are both stored as
  // ABSENCE: the same schedule has one stored form, so a dialog saved
  // unchanged rewrites neither unit.
  const set = <T>(value: T | null | undefined, fallback: T): value is T => value != null && value !== fallback
  return {
    ...rest,
    ...(set(time, SNAPSHOT_FIRE_DEFAULTS.time) ? { time } : {}),
    ...(set(weekday, SNAPSHOT_FIRE_DEFAULTS.weekday) ? { weekday } : {}),
    ...(set(dayOfMonth, SNAPSHOT_FIRE_DEFAULTS.dayOfMonth) ? { dayOfMonth } : {}),
    ...(set(month, SNAPSHOT_FIRE_DEFAULTS.month) ? { month } : {}),
  }
}

/**
 * Render the `.service` unit. The `X-ANAS-Schedule=` comment embeds the canonical
 * schedule JSON (single line) — the ONLY thing the parser reads back. ExecStart
 * is for systemd to actually run; it is never parsed by us. `Environment=TZ=UTC`
 * matches the snapshot naming's UTC stamp so a fire's clock is unambiguous.
 *
 * Injection refusal (cr.51 / review C1): every interpolated value is asked
 * before anything is rendered. `name` lands in `Description=` (systemd merges
 * repeated sections, so a newline there forges a directive — the C1 proof ran
 * `ExecStartPre=` as root); `id` lands in ExecStart via {@link quoteExecArg}.
 * The marker JSON is safe by construction (`JSON.stringify` escapes every
 * control character onto its one line). `cadence` is a closed enum mapped to
 * fixed calendar strings, and the fire fields (snaptime.1) are validated by
 * the shared schema at both boundaries and refused for control characters by
 * {@link cadenceToOnCalendar} — no free text reaches `OnCalendar=`.
 */
export function renderServiceUnit(schedule: SnapshotSchedule): string {
  refuseControlChars(schedule.name, 'schedule name')
  const execStart = [RUNNER_NODE, RUNNER_SCRIPT, ...runnerArgs(schedule).map(quoteExecArg)].join(' ')
  // A `null` fire field is a PUT's CLEAR instruction, never a stored value
  // (snaptime.1): dropped here, the ONE place the stored JSON is made, so a
  // schedule and every API reply that reads it back carry the field ABSENT —
  // exactly what a schedule saved before the field existed carries.
  const normalized = withoutClearedFireFields(schedule)
  // An EMPTY exclude list is the plain `-r` and is stored as no list at all, so
  // a recursive schedule saved by a UI that always sends the key (`[]` when
  // none) keeps a unit byte-identical to one that never had the field.
  const { exclude, ...withoutExclude } = normalized
  const stored = exclude && exclude.length > 0 ? normalized : withoutExclude
  return [
    '[Unit]',
    `Description=ANAS snapshot schedule ${unitDescriptionText(schedule.name)}`,
    `# ${SCHEDULE_MARKER}${JSON.stringify(stored)}`,
    '',
    '[Service]',
    'Type=oneshot',
    'Environment=TZ=UTC',
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/**
 * Render the `.timer` unit for a schedule's cadence (same name refusal —
 * cr.51). One `OnCalendar=` directive per generated line, in the generator's
 * order: a monthly 29th or 30th carries two (the day, and February's last day),
 * everything else one, so a schedule written before the day existed keeps a
 * timer byte-identical to today's.
 */
export function renderTimerUnit(schedule: SnapshotSchedule): string {
  refuseControlChars(schedule.name, 'schedule name')
  return [
    '[Unit]',
    `Description=ANAS snapshot timer ${unitDescriptionText(schedule.name)}`,
    '',
    '[Timer]',
    ...cadenceToOnCalendar(schedule).map(line => `OnCalendar=${line}`),
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/**
 * Parse the canonical SnapshotSchedule out of a `.service` unit's body via its
 * `X-ANAS-Schedule=` line (with or without the leading `# `), zod-validated.
 * Returns null when the marker is absent or the JSON is invalid — the caller
 * skips (and warns about) such files, fail-open.
 */
export function parseServiceUnit(content: string): SnapshotSchedule | null {
  return parseMarkedJson(content, SCHEDULE_MARKER, SnapshotScheduleSchema)
}

// --- Store: read ------------------------------------------------------------

/**
 * An `anas-snap-*.service` file the store could NOT read back (cr.51r / review
 * possible 1): no marker, a marker whose JSON does not parse or validate, a
 * marker naming an id that does not match the file, or a file that could not
 * be read. Such a unit is invisible to the parsed list while its timer keeps
 * firing (the C1 proof's poisoned unit did exactly this) — so it is COLLECTED
 * and surfaced, never silently skipped (the cr.35 unreadable-is-never-empty
 * convention).
 */
export interface UnparseableScheduleUnit {
  /** The unit file's NAME, as listed in the unit dir. */
  file: string
  /** Why it could not be read back — one clause, fits the card and the journal line. */
  reason: string
}

/**
 * The schedule store as read, with whether the read was COMPLETE: false when
 * the unit dir could not be listed or any `anas-snap-*.service` file could not
 * be read or parsed. `schedules` holds every valid one either way, and
 * `unparseable` names every file that did not parse back, with its reason.
 */
export interface ScheduleListRead {
  schedules: SnapshotSchedule[]
  complete: boolean
  unparseable: UnparseableScheduleUnit[]
}

/** Does the content carry a marker line at all (the reason text says which half failed)? */
function hasMarkerLine(content: string): boolean {
  const re = markerRegex(SCHEDULE_MARKER)
  return content.split('\n').some(line => re.test(line))
}

/**
 * Read every schedule and say whether the list is whole (snapprune.1 review).
 * A destroy decision that rests on what other schedules say (who covers a
 * dataset, the most generous count) must not be made on a partial list — the
 * recursive prune checks `complete` and prunes only the target when it is false.
 * The skipped files still get their stderr note, and (cr.51r) every one of
 * them is also RETURNED as an `unparseable` entry so the dashboard and the
 * daemon-start journal can name it — a unit we cannot read is never silently
 * empty. A marker whose id does not match the file name is one of them: the
 * unit claims to be a schedule the file name contradicts, so neither the list
 * nor a delete-by-id can be trusted to own it.
 */
export async function readScheduleList(dir: string): Promise<ScheduleListRead> {
  const listed = await listServiceUnitsChecked(dir, UNIT_PREFIX)
  let complete = listed.complete
  const schedules: SnapshotSchedule[] = []
  const unparseable: UnparseableScheduleUnit[] = []
  for (const file of listed.files) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      const schedule = parseServiceUnit(content)
      if (schedule) {
        const expectedId = file.slice(UNIT_PREFIX.length, -'.service'.length)
        if (schedule.id === expectedId) {
          schedules.push(schedule)
          continue
        }
        complete = false
        const reason = `its X-ANAS-Schedule id '${schedule.id}' does not match the file name`
        unparseable.push({ file, reason })
        process.stderr.write(`[schedules] skipping ${file}: ${reason}\n`)
        continue
      }
      complete = false
      const reason = hasMarkerLine(content)
        ? 'its X-ANAS-Schedule JSON does not parse or validate'
        : 'no X-ANAS-Schedule marker'
      unparseable.push({ file, reason })
      process.stderr.write(`[schedules] skipping ${file}: ${reason}\n`)
    }
    catch (err) {
      complete = false
      const reason = err instanceof Error ? err.message : String(err)
      unparseable.push({ file, reason })
      process.stderr.write(`[schedules] skipping ${file}: ${reason}\n`)
    }
  }
  return { schedules, complete, unparseable }
}

/** All valid schedules parsed from `anas-snap-*.service` files (invalid → skipped). */
export async function readAllSchedules(dir: string): Promise<SnapshotSchedule[]> {
  return (await readScheduleList(dir)).schedules
}

/** One schedule by id, or null if its service file is absent/invalid. */
export async function readSchedule(dir: string, id: string): Promise<SnapshotSchedule | null> {
  try {
    return parseServiceUnit(await readFile(join(dir, serviceUnitName(id)), 'utf-8'))
  }
  catch {
    return null
  }
}

/** Does a schedule's service file exist on disk? (the store is the files). */
export async function scheduleFileExists(dir: string, id: string): Promise<boolean> {
  try {
    await readFile(join(dir, serviceUnitName(id)), 'utf-8')
    return true
  }
  catch {
    return false
  }
}

// --- Store: write + remove --------------------------------------------------

/**
 * Write (or rewrite) a schedule's service+timer, reload systemd, then bring the
 * timer to match `enabled` (`enable --now` / `disable --now`). Throws on any
 * systemctl failure so the mutation surfaces it.
 */
export async function writeScheduleUnits(
  executor: CommandExecutor,
  dir: string,
  schedule: SnapshotSchedule,
): Promise<void> {
  // Render BOTH before writing anything (cr.51): a refusal must leave the unit
  // dir exactly as it was — no half-written pair.
  const serviceText = renderServiceUnit(schedule)
  const timerText = renderTimerUnit(schedule)
  await writeFile(join(dir, serviceUnitName(schedule.id)), serviceText, 'utf-8')
  await writeFile(join(dir, timerUnitName(schedule.id)), timerText, 'utf-8')

  await runSystemctl(executor, ['daemon-reload'])
  const timer = timerUnitName(schedule.id)
  if (schedule.enabled)
    await runSystemctl(executor, ['enable', '--now', timer])
  else
    await runSystemctl(executor, ['disable', '--now', timer])
}

/**
 * Remove a schedule: stop+disable the timer, delete both unit files AND the
 * timer's Persistent stamp, reset the units' failed state, reload systemd.
 * Deliberately touches NOTHING in ZFS/btrfs — the snapshots the schedule
 * created are left exactly as they are (deleting a schedule is not deleting its
 * snapshots).
 *
 * The stamp and the failed state are systemd's OWN bookkeeping about the
 * schedule, and leaving either behind poisons the schedule's NEXT life: a
 * leftover stamp makes the re-created timer fire immediately (`Persistent=true`
 * reads the stamp as a missed run — SCHEDULES-GT-17), and a removed oneshot
 * that failed stays in the failed state as a `not-found` ghost. Same shape as
 * the task stores' `removeTaskUnits`: the stamp unlinked beside the unit
 * files, and `systemctl reset-failed` issued as TWO calls (service, then
 * timer), each with its exit IGNORED — a reset of nothing must never fail the
 * removal.
 */
export async function removeScheduleUnits(
  executor: CommandExecutor,
  dir: string,
  id: string,
): Promise<void> {
  // Best-effort disable first (ignore failure — the unit may already be gone).
  await executor.exec(SYSTEMCTL, ['disable', '--now', timerUnitName(id)])
  await Promise.all([
    unlinkQuiet(join(dir, serviceUnitName(id))),
    unlinkQuiet(join(dir, timerUnitName(id))),
    unlinkQuiet(snapshotStampPath(id)),
  ])
  // Best-effort: not failed / already gone is exactly the goal state.
  await executor.exec(SYSTEMCTL, ['reset-failed', serviceUnitName(id)]).catch(() => undefined)
  await executor.exec(SYSTEMCTL, ['reset-failed', timerUnitName(id)]).catch(() => undefined)
  await runSystemctl(executor, ['daemon-reload'])
}

// --- Status derivation ------------------------------------------------------

/**
 * Compute one schedule's status (and the last run's exit code) from the shared
 * run-status derivation (unit-run-status.ts, taskstatus.1). The list (status)
 * and the detail (status + exit code + units + journal) derive from this ONE
 * implementation. What is the schedule's own, layered on top:
 *
 * - `overdue` = enabled AND the next elapse is in the past (a Persistent timer
 *   that never caught up).
 * - The exit code is systemd's `ExecMainStatus`, meaningful only when THIS
 *   boot's service properties answered the last run — after a reboot the
 *   property reads its default 0, which is no evidence of anything, so a last
 *   run recovered from the journal or the timer stamp carries none.
 */
async function computeStatus(
  executor: CommandExecutor,
  schedule: SnapshotSchedule,
  readJournal?: () => Promise<string>,
): Promise<{ status: SnapshotScheduleStatus, lastRunExitCode: number | null }> {
  // `enabled` is passed to the shared map so a DISABLED schedule whose run
  // history systemd garbage-collected reads `disabled`, not the default-valued
  // `Result=success` (live-proof F9 — same hole, same fix, all three stores).
  const run = await deriveUnitRunStatus(executor, {
    serviceUnit: serviceUnitName(schedule.id),
    timerUnit: timerUnitName(schedule.id),
    enabled: schedule.enabled,
    ...(readJournal ? { readJournal } : {}),
  })
  const lastRunResult = toSystemdRunResult(run.lastRunResult)
  const { lastRunAt, nextRunAt } = run

  let overdue = false
  if (schedule.enabled && nextRunAt) {
    const next = Date.parse(nextRunAt)
    if (!Number.isNaN(next) && next < Date.now())
      overdue = true
  }

  // `ExecMainStatus` reads 0 before the unit has ever run — only surface it once
  // there is evidence of a run (a recorded exit time or a settled result).
  const ranAtLeastOnce = lastRunAt !== null || lastRunResult === 'success' || lastRunResult === 'failure'
  const lastRunExitCode = run.source === 'live' && ranAtLeastOnce ? parseExecMainStatus(run.serviceProps) : null

  return {
    status: {
      schedule,
      lastRunResult,
      lastRunAt,
      nextRunAt,
      overdue,
      ...(run.lastRunNote ? { lastRunNote: run.lastRunNote } : {}),
      // cr3.followup: a `systemctl show` that could not answer is a failed
      // read, never the `unknown` result it derives to.
      ...(showReadFailed(run.serviceProps) ? { statusUnreadable: true as const } : {}),
    },
    lastRunExitCode,
  }
}

/** Parse a service's `ExecMainStatus` (the last run's exit code) → number or null. */
function parseExecMainStatus(props: Record<string, string>): number | null {
  const raw = props.ExecMainStatus
  if (raw === undefined || raw === '')
    return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

/**
 * Derive one schedule's status from persistent systemd state (see
 * {@link computeStatus}). Fail-open per source — one broken source never
 * blanks the row.
 */
export async function deriveScheduleStatus(
  executor: CommandExecutor,
  schedule: SnapshotSchedule,
): Promise<SnapshotScheduleStatus> {
  return (await computeStatus(executor, schedule)).status
}

/**
 * Derive one schedule's DETAIL — the status plus the last run's exit code, the
 * unit files as written, and a recent journald blob. Mirrors the backup task
 * detail (routes/backup.ts + services/backup-units.ts): the SAME last-run
 * logs + exit-status surface for a snapshot schedule as for a backup task.
 * Fail-open per source (units/journal degrade to '' — never throws). The
 * journal is read once and shared with the status derivation.
 */
export async function deriveScheduleDetail(
  executor: CommandExecutor,
  dir: string,
  schedule: SnapshotSchedule,
): Promise<SnapshotScheduleDetail> {
  const journalRead = readRecentJournal(executor, schedule.id)
  const [{ status, lastRunExitCode }, units, journal] = await Promise.all([
    computeStatus(executor, schedule, () => journalRead),
    readScheduleUnitTexts(dir, schedule.id),
    journalRead,
  ])
  return {
    ...status,
    lastRunExitCode,
    unit: units.unit,
    timer: units.timer,
    ...(journal ? { journal } : {}),
    // F9 — say WHY there is no result to show, on the one screen that has room
    // for the sentence. The journald tail below it is the only history a
    // disabled schedule has left, and it is already labelled recent-only.
    ...(status.lastRunResult === 'disabled' ? { statusNote: DISABLED_HISTORY_NOTE } : {}),
  }
}

/** The verbatim `.service` + `.timer` unit text for a schedule ('' when absent). */
export async function readScheduleUnitTexts(
  dir: string,
  id: string,
): Promise<{ unit: string, timer: string }> {
  const [unit, timer] = await Promise.all([
    readFile(join(dir, serviceUnitName(id)), 'utf-8').catch(() => ''),
    readFile(join(dir, timerUnitName(id)), 'utf-8').catch(() => ''),
  ])
  return { unit, timer }
}

/**
 * Recent journald output for a schedule's oneshot service — the run's own log +
 * exit status. Bounded and recent-only (older history is not retained) — the
 * ONE journal read every unit kind shares (unit-run-status.ts readUnitJournal).
 */
export function readRecentJournal(executor: CommandExecutor, id: string): Promise<string> {
  return readUnitJournal(executor, serviceUnitName(id))
}

/** Derive statuses for every schedule in the store (fail-open per schedule). */
export async function collectScheduleStatuses(
  executor: CommandExecutor,
  dir: string,
): Promise<SnapshotScheduleStatus[]> {
  const schedules = await readAllSchedules(dir)
  return Promise.all(schedules.map(s => deriveScheduleStatus(executor, s)))
}

// --- Dashboard warnings (17.7) ----------------------------------------------

/**
 * Dashboard warnings for failing/overdue snapshot schedules (category
 * 'schedule'). Warns ONLY on an ENABLED schedule whose last run failed OR which
 * is silently overdue — healthy/idle and disabled schedules never warn (the
 * replication/backup policy). One warning per schedule; the ref is the id.
 */
export function buildScheduleWarnings(statuses: SnapshotScheduleStatus[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const s of statuses) {
    if (!s.schedule.enabled)
      continue
    if (s.lastRunResult === 'failure') {
      warnings.push({
        level: 'warning',
        category: 'schedule',
        message: `Snapshot schedule '${s.schedule.name}' last run failed — check the Snapshots view`,
        ref: s.schedule.id,
      })
    }
    else if (s.overdue) {
      warnings.push({
        level: 'warning',
        category: 'schedule',
        message: `Snapshot schedule '${s.schedule.name}' is overdue — check the Snapshots view`,
        ref: s.schedule.id,
      })
    }
  }
  return warnings
}

/**
 * cr.51r (review possible 1): one card per `anas-snap-*.service` the store
 * could not read back. The unit is invisible to the Schedules view (it does
 * not parse) while its timer keeps firing — the card names the FILE (the only
 * handle the operator has) and says how to get rid of it. `DELETE
 * /schedules/:id` still removes such a unit (cr.41b binds the delete to the
 * unit on disk, not the parsed schedule), so the Schedules view's delete can
 * reach it when the id is readable; "or by hand" covers the rest.
 */
export function buildUnparseableScheduleWarnings(units: UnparseableScheduleUnit[]): DashboardWarning[] {
  return units.map(u => ({
    level: 'warning',
    category: 'schedule',
    message: `Schedule unit ${u.file} could not be read (${u.reason}); its timer may still fire. Delete it from the Schedules view or by hand`,
    ref: u.file,
  }))
}

/**
 * Collect the dashboard 'schedule' warnings from the store. Mirrors how
 * replication/backup warnings are wired into the dashboard aggregate. One
 * store read feeds both halves (cr.51r): the failed/overdue cards over the
 * parsed schedules, and one card per unparseable unit file.
 *
 * cr3 INVENTED-STATE-H1: a read that failed THROWS, so the dashboard marks
 * the section unavailable (`readDashboardSection` marks only a throw or a
 * timeout). It used to catch everything and answer `[]` — "no schedule
 * warning" — as a successful read: a failed schedule's card disappeared. The
 * unit directory that could not be listed throws too (a per-file failure is
 * already its own card).
 */
export async function collectScheduleWarnings(
  executor: CommandExecutor,
  dir: string,
  /**
   * cr3.followup: the dashboard's partial-read callback, as the task stores'
   * `collectTaskWarnings` takes it. With it, a section where SOME schedules'
   * status could not be read keeps its readable warnings and says what it
   * could not see. Without it, or when NO schedule could be read, it throws
   * (never "all clear").
   */
  incomplete?: (reason: string) => void,
): Promise<DashboardWarning[]> {
  const read = await readScheduleList(dir)
  if (!read.complete && read.unparseable.length === 0) {
    // The directory itself could not be listed. One that does not EXIST
    // holds no unit (an absent store is an empty one); any other failure is
    // a read that did not see.
    const absent = await stat(dir).then(() => false, (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
    if (!absent)
      throw new Error(`the schedule unit directory ${dir} could not be listed`)
  }
  const statuses = await Promise.all(read.schedules.map(s => deriveScheduleStatus(executor, s)))
  // cr3.followup: a row whose status could not be read derives `unknown`,
  // which warns about nothing — the section would read all clear.
  const unread = statuses.filter(s => s.statusUnreadable).map(s => s.schedule.name)
  const readable = statuses.filter(s => !s.statusUnreadable)
  if (unread.length) {
    const reason = `systemd could not be asked about snapshot schedule${unread.length === 1 ? '' : 's'} ${unread.map(n => `'${n}'`).join(', ')}`
    if (readable.length === 0 || !incomplete)
      throw new Error(reason)
    incomplete(reason)
  }
  return [...buildScheduleWarnings(readable), ...buildUnparseableScheduleWarnings(read.unparseable)]
}
