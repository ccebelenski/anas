import type { DashboardWarning, SnapshotCadence, SnapshotSchedule, SnapshotScheduleDetail, SnapshotScheduleStatus } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SnapshotSchedule as SnapshotScheduleSchema } from '@anas/shared'
import { deriveRunResult, parseShow, parseSystemdTimestamp } from './systemd-status.js'

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
const JOURNALCTL = '/usr/bin/journalctl'
/** The timer executes this compiled runner (ships in dist — see snapshot-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/snapshot-task.js'
const UNIT_PREFIX = 'anas-snap-'
/** How many recent journald lines the detail view surfaces (mirrors backup). */
const JOURNAL_TAIL = 200
/** The service-file line that carries the canonical schedule JSON (as a comment). */
const SCHEDULE_MARKER = 'X-ANAS-Schedule='
/** Matches the X-ANAS-Schedule line (with or without a leading `# `), capturing JSON. */
const SCHEDULE_MARKER_RE = /^#?\s*X-ANAS-Schedule=(.*)$/

/** Default systemd unit directory; overridable (env/dep) for tests. */
export const DEFAULT_SYSTEMD_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

export function serviceUnitName(id: string): string {
  return `${UNIT_PREFIX}${id}.service`
}
export function timerUnitName(id: string): string {
  return `${UNIT_PREFIX}${id}.timer`
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
  return [
    '[Unit]',
    `Description=ANAS snapshot schedule ${schedule.name}`,
    `# ${SCHEDULE_MARKER}${JSON.stringify(schedule)}`,
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
  for (const line of content.split('\n')) {
    const m = line.match(SCHEDULE_MARKER_RE)
    if (!m)
      continue
    try {
      const parsed = SnapshotScheduleSchema.safeParse(JSON.parse(m[1]))
      return parsed.success ? parsed.data : null
    }
    catch {
      return null
    }
  }
  return null
}

// --- Store: read ------------------------------------------------------------

/** All valid schedules parsed from `anas-snap-*.service` files (invalid → skipped). */
export async function readAllSchedules(dir: string): Promise<SnapshotSchedule[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  }
  catch {
    return []
  }
  const services = files.filter(f => f.startsWith(UNIT_PREFIX) && f.endsWith('.service'))
  const schedules: SnapshotSchedule[] = []
  for (const file of services) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      const schedule = parseServiceUnit(content)
      if (schedule)
        schedules.push(schedule)
      else
        process.stderr.write(`[schedules] skipping ${file}: no valid X-ANAS-Schedule JSON\n`)
    }
    catch (err) {
      process.stderr.write(`[schedules] skipping ${file}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  return schedules
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
 * Remove a schedule: stop+disable the timer, delete both unit files, reload
 * systemd. Deliberately touches NOTHING in ZFS/btrfs — the snapshots the schedule
 * created are left exactly as they are (deleting a schedule is not deleting its
 * snapshots).
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
  ])
  await runSystemctl(executor, ['daemon-reload'])
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  }
  catch {
    // Missing file is fine — the goal state (absent) already holds.
  }
}

async function runSystemctl(executor: CommandExecutor, args: string[]): Promise<void> {
  const r = await executor.exec(SYSTEMCTL, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `systemctl ${args.join(' ')} exited with code ${r.exitCode}`)
}

// --- Status derivation ------------------------------------------------------

/**
 * Pure: compute one schedule's status (and the last run's exit code) from
 * already-fetched systemd props. Extracted so the list (status) and the detail
 * (status + exit code + units + journal) derive from ONE implementation
 * (single-source-of-truth). `overdue` = enabled AND the next elapse is in the
 * past (a Persistent timer that never caught up). The exit code is meaningful
 * only once the service has actually run — null before the first fire.
 */
function computeStatus(
  schedule: SnapshotSchedule,
  serviceProps: Record<string, string>,
  nextRaw: string | undefined,
): { status: SnapshotScheduleStatus, lastRunExitCode: number | null } {
  const lastRunResult = deriveRunResult(serviceProps)
  const lastRunAt = parseSystemdTimestamp(serviceProps.ExecMainExitTimestamp)
    ?? parseSystemdTimestamp(serviceProps.InactiveEnterTimestamp)
  const nextRunAt = parseSystemdTimestamp(nextRaw)

  let overdue = false
  if (schedule.enabled && nextRunAt) {
    const next = Date.parse(nextRunAt)
    if (!Number.isNaN(next) && next < Date.now())
      overdue = true
  }

  // `ExecMainStatus` reads 0 before the unit has ever run — only surface it once
  // there is evidence of a run (a recorded exit time or a settled result).
  const ranAtLeastOnce = lastRunAt !== null || lastRunResult === 'success' || lastRunResult === 'failure'
  const lastRunExitCode = ranAtLeastOnce ? parseExecMainStatus(serviceProps) : null

  return { status: { schedule, lastRunResult, lastRunAt, nextRunAt, overdue }, lastRunExitCode }
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
 * Derive one schedule's status from persistent systemd state: the service's last
 * result + last-run time, and the timer's next elapse. `overdue` = enabled AND
 * the next elapse is in the past (a Persistent timer that never caught up).
 * Fail-open to unknown/nulls per source — one broken source never blanks the row.
 */
export async function deriveScheduleStatus(
  executor: CommandExecutor,
  schedule: SnapshotSchedule,
): Promise<SnapshotScheduleStatus> {
  const [serviceProps, nextRaw] = await Promise.all([
    showService(executor, schedule.id),
    showTimerNext(executor, schedule.id),
  ])
  return computeStatus(schedule, serviceProps, nextRaw).status
}

/**
 * Derive one schedule's DETAIL — the status plus the last run's exit code, the
 * unit files as written, and a recent journald blob. Mirrors the backup task
 * detail (routes/backup.ts + services/backup-units.ts): the SAME last-run
 * logs + exit-status surface for a snapshot schedule as for a backup task.
 * Fail-open per source (units/journal degrade to '' — never throws).
 */
export async function deriveScheduleDetail(
  executor: CommandExecutor,
  dir: string,
  schedule: SnapshotSchedule,
): Promise<SnapshotScheduleDetail> {
  const [serviceProps, nextRaw, units, journal] = await Promise.all([
    showService(executor, schedule.id),
    showTimerNext(executor, schedule.id),
    readScheduleUnitTexts(dir, schedule.id),
    readRecentJournal(executor, schedule.id),
  ])
  const { status, lastRunExitCode } = computeStatus(schedule, serviceProps, nextRaw)
  return {
    ...status,
    lastRunExitCode,
    unit: units.unit,
    timer: units.timer,
    ...(journal ? { journal } : {}),
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
 * exit status. Bounded and recent-only (older history is not retained), exactly
 * like the backup detail (services/backup-units.ts readRecentJournal): same args
 * shape (`-u <svc> -n 200 -o short-iso --no-pager`), same fail-open-to-'' contract.
 */
export async function readRecentJournal(executor: CommandExecutor, id: string): Promise<string> {
  try {
    const r = await executor.exec(JOURNALCTL, [
      '-u',
      serviceUnitName(id),
      '-n',
      String(JOURNAL_TAIL),
      '-o',
      'short-iso',
      '--no-pager',
    ])
    return r.exitCode === 0 ? r.stdout.trim() : ''
  }
  catch {
    return ''
  }
}

async function showService(executor: CommandExecutor, id: string): Promise<Record<string, string>> {
  try {
    const r = await executor.exec(SYSTEMCTL, [
      'show',
      serviceUnitName(id),
      '-p',
      'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp',
    ])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return {}
    return parseShow(r.stdout)
  }
  catch {
    return {}
  }
}

async function showTimerNext(executor: CommandExecutor, id: string): Promise<string | undefined> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['show', timerUnitName(id), '-p', 'NextElapseUSecRealtime'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return undefined
    return parseShow(r.stdout).NextElapseUSecRealtime
  }
  catch {
    return undefined
  }
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
