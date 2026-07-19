import type { BackupRunResult, BackupTask, DashboardWarning } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BackupTask as BackupTaskSchema } from '@anas/shared'

/**
 * Backup TASKS (Epic 16.3) — the systemd units ARE the store, exactly the
 * replication-units.ts pattern reapplied (NOTES §7 confirms it transfers almost
 * verbatim).
 *
 * Each task is an `anas-backup-<name>.service` + `.timer` pair. There is NO
 * second config source and NO custom scheduler: CRUD writes/rewrites/removes the
 * two unit files and drives `systemctl` to reload + enable/disable the timer.
 * The canonical BackupTask JSON is embedded in the service file as an
 * `X-ANAS-Task=` comment and is the SINGLE source of truth parsed back — we
 * never reverse-engineer it from ExecStart.
 *
 * The generated service carries `LimitNOFILE=<task.limitNofile>` (default 1024)
 * — pbc hoards file handles, worst in metadata mode (NOTES §5).
 *
 * Status is LOCAL-ONLY (operator ruling — ANAS never contacts the PBS server):
 * last result / next run / overdue from persistent systemd unit+timer state,
 * recent run detail from journald (labeled recent-only; it rotates). Every
 * derivation fails open so one broken source never blanks the view.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const JOURNALCTL = '/usr/bin/journalctl'
/** The timer executes this compiled runner (ships in dist — see backup-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/backup-task.js'
const UNIT_PREFIX = 'anas-backup-'
/** The service-file line that carries the canonical task JSON (as a comment). */
const TASK_MARKER = 'X-ANAS-Task='
/** Matches the X-ANAS-Task line (with or without a leading `# `), capturing JSON. */
const TASK_MARKER_RE = /^#?\s*X-ANAS-Task=(.*)$/
/** How many recent journald lines the detail view surfaces. */
const JOURNAL_TAIL = 200
/** systemd 'n/a' sentinel + a leading weekday name on a human timestamp. */
const NA_RE = /^n\/a$/i
const INFINITY_RE = /infinity/i
const WEEKDAY_PREFIX_RE = /^[A-Z][a-z]{2}\s+/

/** Default systemd unit directory; overridable (env/dep) for tests. */
export const DEFAULT_SYSTEMD_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

export function serviceUnitName(name: string): string {
  return `${UNIT_PREFIX}${name}.service`
}
export function timerUnitName(name: string): string {
  return `${UNIT_PREFIX}${name}.timer`
}

// --- Runner argv -------------------------------------------------------------

/** The argv the timer passes to the runner (which POSTs the run job + polls it). */
export function runnerArgs(task: BackupTask): string[] {
  return ['--name', task.name]
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Render the `.service` unit. The `X-ANAS-Task=` comment embeds the canonical
 * task JSON (single line) — the ONLY thing the parser reads back. ExecStart is
 * for systemd to actually run; it is never parsed by us. `LimitNOFILE=` is the
 * per-task fd backpressure knob (default 1024).
 */
export function renderServiceUnit(task: BackupTask): string {
  const execStart = [RUNNER_NODE, RUNNER_SCRIPT, ...runnerArgs(task)].join(' ')
  return [
    '[Unit]',
    `Description=ANAS backup task ${task.name}`,
    `# ${TASK_MARKER}${JSON.stringify(task)}`,
    '',
    '[Service]',
    'Type=oneshot',
    '# per-task file-handle backpressure (pbc hoards fds, worst in metadata mode)',
    `LimitNOFILE=${task.limitNofile}`,
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/** Render the `.timer` unit for a task's schedule. */
export function renderTimerUnit(task: BackupTask): string {
  return [
    '[Unit]',
    `Description=ANAS backup timer ${task.name}`,
    '',
    '[Timer]',
    `OnCalendar=${task.schedule}`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/**
 * Parse the canonical BackupTask out of a `.service` unit's body via its
 * `X-ANAS-Task=` line (with or without the leading `# `), zod-validated. Returns
 * null when the marker is absent or the JSON is invalid — the caller skips (and
 * warns about) such files, fail-open.
 */
export function parseServiceUnit(content: string): BackupTask | null {
  for (const line of content.split('\n')) {
    const m = line.match(TASK_MARKER_RE)
    if (!m)
      continue
    try {
      const parsed = BackupTaskSchema.safeParse(JSON.parse(m[1]))
      return parsed.success ? parsed.data : null
    }
    catch {
      return null
    }
  }
  return null
}

// --- Store: read ------------------------------------------------------------

/** All valid tasks parsed from `anas-backup-*.service` files (invalid → skipped). */
export async function readAllTasks(dir: string): Promise<BackupTask[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  }
  catch {
    return []
  }
  const services = files.filter(f => f.startsWith(UNIT_PREFIX) && f.endsWith('.service'))
  const tasks: BackupTask[] = []
  for (const file of services) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      const task = parseServiceUnit(content)
      if (task)
        tasks.push(task)
      else
        console.warn(`[backup] skipping ${file}: no valid X-ANAS-Task JSON`)
    }
    catch (err) {
      console.warn(`[backup] skipping ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return tasks
}

/** One task by name, or null if its service file is absent/invalid. */
export async function readTask(dir: string, name: string): Promise<BackupTask | null> {
  try {
    return parseServiceUnit(await readFile(join(dir, serviceUnitName(name)), 'utf-8'))
  }
  catch {
    return null
  }
}

/** Does a task's service file exist on disk? (the store is the files). */
export async function taskFileExists(dir: string, name: string): Promise<boolean> {
  try {
    await readFile(join(dir, serviceUnitName(name)), 'utf-8')
    return true
  }
  catch {
    return false
  }
}

/** The verbatim `.service` + `.timer` unit text for a task ('' when absent). */
export async function readUnitTexts(dir: string, name: string): Promise<{ unit: string, timer: string }> {
  const [unit, timer] = await Promise.all([
    readFile(join(dir, serviceUnitName(name)), 'utf-8').catch(() => ''),
    readFile(join(dir, timerUnitName(name)), 'utf-8').catch(() => ''),
  ])
  return { unit, timer }
}

// --- Store: validate + write + remove ---------------------------------------

/**
 * Validate a schedule with `systemd-analyze calendar <expr>` — systemd is the
 * authority on OnCalendar syntax. Returns its stderr on failure so the caller
 * can 400 with it.
 */
export async function validateSchedule(
  executor: CommandExecutor,
  schedule: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const r = await executor.exec(SYSTEMD_ANALYZE, ['calendar', schedule])
    if (r.exitCode === 0)
      return { ok: true }
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `invalid OnCalendar expression '${schedule}'` }
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Write (or rewrite) a task's service+timer, reload systemd, then bring the
 * timer to match `enabled`. Throws on any systemctl failure so the mutation
 * surfaces it.
 */
export async function writeTaskUnits(
  executor: CommandExecutor,
  dir: string,
  task: BackupTask,
): Promise<void> {
  await writeFile(join(dir, serviceUnitName(task.name)), renderServiceUnit(task), 'utf-8')
  await writeFile(join(dir, timerUnitName(task.name)), renderTimerUnit(task), 'utf-8')

  await runSystemctl(executor, ['daemon-reload'])
  const timer = timerUnitName(task.name)
  if (task.enabled)
    await runSystemctl(executor, ['enable', '--now', timer])
  else
    await runSystemctl(executor, ['disable', '--now', timer])
}

/**
 * Remove a task: stop+disable the timer, delete both unit files, reload systemd.
 * Deliberately touches NOTHING on the PBS server — snapshots already stored are
 * left exactly as they are (deleting a schedule is not deleting a backup).
 */
export async function removeTaskUnits(
  executor: CommandExecutor,
  dir: string,
  name: string,
): Promise<void> {
  await executor.exec(SYSTEMCTL, ['disable', '--now', timerUnitName(name)])
  await Promise.all([
    unlinkQuiet(join(dir, serviceUnitName(name))),
    unlinkQuiet(join(dir, timerUnitName(name))),
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

/** Parse `systemctl show` `key=value` lines into a map. */
function parseShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0)
      props[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return props
}

/**
 * Parse a systemd timestamp property to ISO, or null. On PVE 9 / systemd these
 * print a HUMAN date string ("Sun 2026-07-19 02:00:00 UTC"), NOT microseconds
 * (verified live) — handle both the µs form and the day-name-prefixed date.
 */
export function parseSystemdTimestamp(raw: string | undefined): string | null {
  if (!raw || raw === '0' || NA_RE.test(raw) || INFINITY_RE.test(raw))
    return null
  const usec = Number(raw)
  if (Number.isFinite(usec) && usec > 0) {
    const d = new Date(Math.floor(usec / 1000))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  // Strip a leading weekday name ("Sun ") — Date.parse dislikes it combined with
  // the "UTC" suffix on some engines; the rest parses cleanly.
  const cleaned = raw.replace(WEEKDAY_PREFIX_RE, '')
  const parsed = Date.parse(cleaned)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * Map a service's systemd state to a run result. A oneshot is 'activating' (or
 * 'active') while running; after it exits, Result carries the outcome and
 * ActiveState becomes 'failed' on failure.
 */
export function deriveRunResult(props: Record<string, string>): BackupRunResult {
  const active = props.ActiveState
  if (active === 'activating' || active === 'active' || active === 'reloading')
    return 'running'
  if (active === 'failed')
    return 'failure'
  const result = props.Result
  if (result === 'success')
    return 'success'
  if (result && result.length > 0)
    return 'failure'
  return 'unknown'
}

export interface BackupTaskStatus {
  lastRunResult: BackupRunResult
  lastRunAt: string | null
  nextRunAt: string | null
  overdue: boolean
}

/**
 * Derive one task's LOCAL-ONLY status from persistent systemd state: the
 * service's last result + last-run time, and the timer's next elapse. Overdue =
 * enabled AND the next elapse is in the past (a Persistent timer that never
 * caught up). Fail-open to unknown/nulls per source.
 */
export async function deriveTaskStatus(
  executor: CommandExecutor,
  task: BackupTask,
): Promise<BackupTaskStatus> {
  const [serviceProps, nextRaw] = await Promise.all([
    showService(executor, task.name),
    showTimerNext(executor, task.name),
  ])

  const lastRunResult = deriveRunResult(serviceProps)
  const lastRunAt = parseSystemdTimestamp(serviceProps.ExecMainExitTimestamp)
    ?? parseSystemdTimestamp(serviceProps.InactiveEnterTimestamp)
  const nextRunAt = parseSystemdTimestamp(nextRaw)

  let overdue = false
  if (task.enabled && nextRunAt) {
    const next = Date.parse(nextRunAt)
    if (!Number.isNaN(next) && next < Date.now())
      overdue = true
  }

  return { lastRunResult, lastRunAt, nextRunAt, overdue }
}

async function showService(executor: CommandExecutor, name: string): Promise<Record<string, string>> {
  try {
    const r = await executor.exec(SYSTEMCTL, [
      'show',
      serviceUnitName(name),
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

async function showTimerNext(executor: CommandExecutor, name: string): Promise<string | undefined> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['show', timerUnitName(name), '-p', 'NextElapseUSecRealtime'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return undefined
    return parseShow(r.stdout).NextElapseUSecRealtime
  }
  catch {
    return undefined
  }
}

/**
 * Recent journald output for a task's service, as a raw text blob (labeled
 * recent-only forensics — it rotates, older history simply ages out). Fail-open
 * to '' so a journald hiccup never breaks the detail view. The UI renders this
 * verbatim.
 */
export async function readRecentJournal(executor: CommandExecutor, name: string): Promise<string> {
  try {
    const r = await executor.exec(JOURNALCTL, [
      '-u',
      serviceUnitName(name),
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

// --- Dashboard warnings -----------------------------------------------------

/** A minimal task-status shape the dashboard warning builder needs. */
export interface BackupWarningInput {
  name: string
  enabled: boolean
  lastRunResult: BackupRunResult
  overdue: boolean
}

/**
 * Dashboard warnings for failing/overdue backup tasks (category 'backup'). Warns
 * ONLY on an ENABLED task whose last run failed OR which is silently overdue —
 * benign too-soon (a 'success' oneshot result) and disabled tasks never warn
 * (the replication policy). One warning per task; the ref is the task name.
 */
export function buildBackupWarnings(inputs: BackupWarningInput[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const s of inputs) {
    if (!s.enabled)
      continue
    if (s.lastRunResult === 'failure') {
      warnings.push({
        level: 'warning',
        category: 'backup',
        message: `Backup task '${s.name}' last run failed — check the Backup view`,
        ref: s.name,
      })
    }
    else if (s.overdue) {
      warnings.push({
        level: 'warning',
        category: 'backup',
        message: `Backup task '${s.name}' is overdue — check the Backup view`,
        ref: s.name,
      })
    }
  }
  return warnings
}

/**
 * Collect the dashboard 'backup' warnings from the task store, fail-open. Mirrors
 * how replication/mount warnings are wired into GET /v1/status.
 */
export async function collectBackupWarnings(
  executor: CommandExecutor,
  dir: string,
): Promise<DashboardWarning[]> {
  try {
    const tasks = await readAllTasks(dir)
    const inputs = await Promise.all(
      tasks.map(async (task): Promise<BackupWarningInput> => {
        const st = await deriveTaskStatus(executor, task)
        return { name: task.name, enabled: task.enabled, lastRunResult: st.lastRunResult, overdue: st.overdue }
      }),
    )
    return buildBackupWarnings(inputs)
  }
  catch {
    return []
  }
}
