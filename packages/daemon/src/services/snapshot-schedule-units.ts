import type { DashboardWarning, SnapshotCadence, SnapshotSchedule, SnapshotScheduleDetail, SnapshotScheduleStatus } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SnapshotSchedule as SnapshotScheduleSchema } from '@anas/shared'
import { DISABLED_HISTORY_NOTE } from './systemd-status.js'
// The unit-store plumbing (marker parse, dir listing, unlink/systemctl) is the
// ONE shared copy in systemd-unit-store.ts — snapshot was its second hand-copy.
import {
  listServiceUnitsChecked,
  parseMarkedJson,
  runSystemctl,
  systemdTimersStampDir,
  unlinkQuiet,
} from './systemd-unit-store.js'
import { deriveUnitRunStatus, readUnitJournal, toSystemdRunResult } from './unit-run-status.js'

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

export function cadenceToOnCalendar(cadence: SnapshotCadence): string {
  return CADENCE_ONCALENDAR[cadence]
}

// --- Runner argv -------------------------------------------------------------

/** The argv the timer passes to the runner (which POSTs the fire job + polls it). */
export function runnerArgs(schedule: SnapshotSchedule): string[] {
  return ['--id', schedule.id]
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Render the `.service` unit. The `X-ANAS-Schedule=` comment embeds the canonical
 * schedule JSON (single line) — the ONLY thing the parser reads back. ExecStart
 * is for systemd to actually run; it is never parsed by us. `Environment=TZ=UTC`
 * matches the snapshot naming's UTC stamp so a fire's clock is unambiguous.
 */
export function renderServiceUnit(schedule: SnapshotSchedule): string {
  const execStart = [RUNNER_NODE, RUNNER_SCRIPT, ...runnerArgs(schedule)].join(' ')
  // An EMPTY exclude list is the plain `-r` and is stored as no list at all, so
  // a recursive schedule saved by a UI that always sends the key (`[]` when
  // none) keeps a unit byte-identical to one that never had the field.
  const { exclude, ...withoutExclude } = schedule
  const stored = exclude && exclude.length > 0 ? schedule : withoutExclude
  return [
    '[Unit]',
    `Description=ANAS snapshot schedule ${schedule.name}`,
    `# ${SCHEDULE_MARKER}${JSON.stringify(stored)}`,
    '',
    '[Service]',
    'Type=oneshot',
    'Environment=TZ=UTC',
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/** Render the `.timer` unit for a schedule's cadence. */
export function renderTimerUnit(schedule: SnapshotSchedule): string {
  return [
    '[Unit]',
    `Description=ANAS snapshot timer ${schedule.name}`,
    '',
    '[Timer]',
    `OnCalendar=${cadenceToOnCalendar(schedule.cadence)}`,
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
 * The schedule store as read, with whether the read was COMPLETE: false when
 * the unit dir could not be listed or any `anas-snap-*.service` file could not
 * be read or parsed. `schedules` holds every valid one either way.
 */
export interface ScheduleListRead {
  schedules: SnapshotSchedule[]
  complete: boolean
}

/**
 * Read every schedule and say whether the list is whole (snapprune.1 review).
 * A destroy decision that rests on what other schedules say (who covers a
 * dataset, the most generous count) must not be made on a partial list — the
 * recursive prune checks `complete` and prunes only the target when it is false.
 * The skipped files still get their stderr note.
 */
export async function readScheduleList(dir: string): Promise<ScheduleListRead> {
  const listed = await listServiceUnitsChecked(dir, UNIT_PREFIX)
  let complete = listed.complete
  const schedules: SnapshotSchedule[] = []
  for (const file of listed.files) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      const schedule = parseServiceUnit(content)
      if (schedule) {
        schedules.push(schedule)
      }
      else {
        complete = false
        process.stderr.write(`[schedules] skipping ${file}: no valid X-ANAS-Schedule JSON\n`)
      }
    }
    catch (err) {
      complete = false
      process.stderr.write(`[schedules] skipping ${file}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  return { schedules, complete }
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
  await writeFile(join(dir, serviceUnitName(schedule.id)), renderServiceUnit(schedule), 'utf-8')
  await writeFile(join(dir, timerUnitName(schedule.id)), renderTimerUnit(schedule), 'utf-8')

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
 * Collect the dashboard 'schedule' warnings from the store, fail-open. Mirrors
 * how replication/backup warnings are wired into the dashboard aggregate.
 */
export async function collectScheduleWarnings(
  executor: CommandExecutor,
  dir: string,
): Promise<DashboardWarning[]> {
  try {
    return buildScheduleWarnings(await collectScheduleStatuses(executor, dir))
  }
  catch {
    return []
  }
}
