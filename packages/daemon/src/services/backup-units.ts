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

// --- Run-Now supervision (LOCAL-ONLY: systemd + journald, never PBS) ---------
//
// A manual Run-Now starts the task's OWN systemd unit (`systemctl start`) and
// supervises it to completion, so the run lands in systemd's last-result and the
// unit journal exactly like a scheduled one — one code path, one history. The
// supervision reads only systemd (`systemctl show`) + journald; it never contacts
// the PBS server (the runner INSIDE the unit is the sole server contact). The
// unit's own execution (the backup-task helper) POSTs `/run` with `direct:true`,
// which runs pbc in the daemon and NEVER re-enters systemctl — the recursion
// guard.

/** ActiveState values that mean the oneshot service is still running. */
const RUN_ACTIVE_STATES = new Set(['activating', 'active', 'reloading'])
/** Supervision poll cadence. */
const SUPERVISE_POLL_MS = 2000
/** Generous ceiling — a real backup can run long; mirrors the UI's 600s budget. */
const SUPERVISE_TIMEOUT_MS = 600000
/** journalctl syslog prefix without a `[pid]` bracket: `<ts> <host> <ident>: <msg>`. */
const JOURNAL_PREFIX_RE = /^\S+\s+\S+\s+\S+?:\s(.*)$/
/** The runner's owner-coupling failure message (a real, actionable cause). */
const OWNER_MISMATCH_MSG_RE = /owner mismatch/i
/** A failure-ish message line. */
const FAILED_MSG_RE = /failed/i
/** systemd's own `<unit>.service: …` boilerplate (skip in favor of the real cause). */
const SYSTEMD_UNIT_LINE_RE = /^anas-backup-\S+\.service:/

export interface SuperviseRunOptions {
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number
  /** Ceiling in ms before reporting still-running (default 600000). */
  timeoutMs?: number
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock (tests advance it). */
  now?: () => number
  /** Job-progress callback (never carries a secret). */
  onProgress?: (message: string) => void
}

export interface SuperviseRunResult {
  /** 'success' | 'skipped' (benign too-soon) | 'running' (hit the ceiling). */
  status: 'success' | 'skipped' | 'running'
  /** True when the service was ALREADY running when Run-Now fired (no fresh start). */
  alreadyRunning: boolean
  /** Per-archive stats recovered from the helper's journal result JSON. */
  archives?: string[]
  /** The `Starting backup: …` target line, when recovered. */
  target?: string
  /** The metadata-mode low-fd warning, when the run emitted it. */
  nofileWarning?: string
  /** Why a run did nothing (too-soon) or is still running (ceiling). */
  reason?: string
}

/** The shape the backup-task helper prints as JSON (its `job.result`). */
interface HelperResult {
  status?: string
  archives?: string[]
  target?: string
  nofileWarning?: string
  reason?: string
}

/** Is a `systemctl show` snapshot in a still-running state? */
export function isRunActive(props: Record<string, string>): boolean {
  return RUN_ACTIVE_STATES.has(props.ActiveState ?? '')
}

/**
 * Did a TERMINAL run fail? A oneshot's failure shows as ActiveState=failed, or a
 * non-success Result, or a non-zero ExecMainStatus (NOTES §7 confirms these
 * props). Benign too-soon exits 0 → NOT a failure here (Result=success).
 */
export function runFailed(props: Record<string, string>): boolean {
  if (props.ActiveState === 'failed')
    return true
  if (props.Result && props.Result !== 'success')
    return true
  if (props.ExecMainStatus && props.ExecMainStatus !== '0')
    return true
  return false
}

/** Strip journalctl's syslog prefix (`… unit[pid]: `) to the bare message. */
export function messageFromJournalLine(line: string): string {
  const idx = line.indexOf(']: ')
  if (idx >= 0)
    return line.slice(idx + 3).trim()
  // Fallback for a prefix without a pid bracket: "<ts> <host> <ident>: <msg>".
  const m = line.match(JOURNAL_PREFIX_RE)
  return (m ? m[1] : line).trim()
}

/**
 * Recover the helper's result JSON from the unit journal — the backup-task helper
 * prints `{ task, result }` to stdout on completion, so the too-soon/skipped
 * classification (and the per-archive stats) survive into the manual supervisor.
 * Returns null when no result line is present (e.g. a failure, which logs stderr).
 */
export function parseHelperResult(journal: string): HelperResult | null {
  const lines = journal.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = messageFromJournalLine(lines[i])
    if (!msg.startsWith('{'))
      continue
    try {
      const obj = JSON.parse(msg) as { result?: HelperResult }
      if (obj && typeof obj === 'object' && obj.result)
        return obj.result
    }
    catch {
      // Not the JSON result line — keep scanning.
    }
  }
  return null
}

/**
 * The client-safe failure detail from the unit journal: prefer pbc's verbatim
 * `Error:` line (or the runner's thrown owner/failed message), else the last
 * non-JSON message line. Never contains a secret (pbc's stderr never does).
 */
export function failureDetailFromJournal(journal: string): string | null {
  const msgs = journal.split('\n').map(messageFromJournalLine).filter(Boolean)
  // Prefer pbc's / the runner's own verbatim `Error:` line (the real cause) over
  // systemd's generic "Failed with result …" trailer.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].startsWith('Error:') || OWNER_MISMATCH_MSG_RE.test(msgs[i]))
      return msgs[i]
  }
  // Next, any failure-ish line that is NOT systemd's boilerplate.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (FAILED_MSG_RE.test(msgs[i]) && !SYSTEMD_UNIT_LINE_RE.test(msgs[i]))
      return msgs[i]
  }
  // Last resort: the last non-JSON message line.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].startsWith('{'))
      return msgs[i]
  }
  return null
}

/** `systemctl show` the run props supervision keys on (fail-open to {}). */
async function showRunProps(executor: CommandExecutor, name: string): Promise<Record<string, string>> {
  try {
    const r = await executor.exec(SYSTEMCTL, [
      'show',
      serviceUnitName(name),
      '-p',
      'ActiveState,Result,ExecMainStatus,InvocationID',
    ])
    return parseShow(r.stdout)
  }
  catch {
    return {}
  }
}

/**
 * A terminal (stopped) run → its outcome. Reads the unit journal for the detail:
 * THROWS with the journal's error line on failure (so the job fails and the UI
 * shows why); returns success/skipped otherwise, carrying the helper's recovered
 * stats and the benign too-soon reason.
 */
async function classifyTerminalRun(
  executor: CommandExecutor,
  name: string,
  props: Record<string, string>,
  alreadyRunning: boolean,
): Promise<SuperviseRunResult> {
  const journal = await readRecentJournal(executor, name)
  if (runFailed(props)) {
    throw new Error(failureDetailFromJournal(journal) ?? `backup task '${name}' failed (see the recent journal)`)
  }
  const helper = parseHelperResult(journal)
  const status: SuperviseRunResult['status'] = helper?.status === 'skipped' ? 'skipped' : 'success'
  const result: SuperviseRunResult = { status, alreadyRunning }
  if (helper?.archives?.length)
    result.archives = helper.archives
  if (helper?.target)
    result.target = helper.target
  if (helper?.nofileWarning)
    result.nofileWarning = helper.nofileWarning
  if (helper?.reason)
    result.reason = helper.reason
  else if (status === 'skipped')
    result.reason = 'snapshot timestamp collision (1-second resolution) — nothing new to back up yet'
  return result
}

/**
 * Run a task NOW through its own systemd unit and supervise to completion. Starts
 * the service with `systemctl start --no-block` (so we own the timeout ceiling,
 * never hanging on a long backup) then polls `systemctl show` until the run we
 * care about goes terminal, and reads the unit journal for the result detail.
 *
 * - A DISABLED task runs fine: `systemctl start` acts on the service regardless
 *   of the timer's enabled state (a manual run of a disabled task is legitimate).
 * - ALREADY RUNNING: we do NOT queue a second run — we supervise the in-flight
 *   one and flag `alreadyRunning` so the caller can say so plainly.
 * - CEILING: on timeout we report `status:'running'` truthfully (NOT a failure) —
 *   systemd carries the backup on; the operator checks back later.
 * - FAILURE: throws (so the job fails) with the journal's client-safe error line.
 */
export async function superviseRun(
  executor: CommandExecutor,
  name: string,
  opts: SuperviseRunOptions = {},
): Promise<SuperviseRunResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? SUPERVISE_POLL_MS
  const timeoutMs = opts.timeoutMs ?? SUPERVISE_TIMEOUT_MS
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const progress = opts.onProgress ?? (() => {})
  const service = serviceUnitName(name)

  // Pre-check: capture the current invocation + running state. If it is already
  // running, supervise THAT run rather than starting a second one.
  const pre = await showRunProps(executor, name)
  const baseInvocation = pre.InvocationID ?? ''
  const alreadyRunning = isRunActive(pre)

  if (alreadyRunning) {
    progress(`backup task '${name}' is already running — waiting for it to finish`)
  }
  else {
    const started = await executor.exec(SYSTEMCTL, ['start', '--no-block', service])
    if (started.exitCode !== 0)
      throw new Error(started.stderr.trim() || `systemctl start ${service} exited with code ${started.exitCode}`)
    progress(`started backup task '${name}'`)
  }

  const deadline = now() + timeoutMs
  let seenActive = alreadyRunning
  while (now() < deadline) {
    await sleep(pollIntervalMs)
    const props = await showRunProps(executor, name)
    const active = isRunActive(props)
    if (active)
      seenActive = true
    // A fresh invocation that came and went (a fast finish we never caught active)
    // is also terminal — so a sub-poll too-soon skip is classified correctly. An
    // absent/empty InvocationID never counts as a change (a never-run unit).
    const inv = props.InvocationID ?? ''
    const invocationChanged = inv !== '' && inv !== baseInvocation
    if (!active && (seenActive || invocationChanged))
      return classifyTerminalRun(executor, name, props, alreadyRunning)
  }

  // Ceiling — the backup is legitimately still running. Truthful, not a failure.
  return {
    status: 'running',
    alreadyRunning,
    reason: `still running after ${Math.round(timeoutMs / 1000)}s — systemd continues it; check the task again shortly`,
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
