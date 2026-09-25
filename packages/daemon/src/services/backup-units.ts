import type { BackupArchiveConsistency, BackupExpandedArchive, BackupPruneResult, BackupRunResult, BackupTask, BackupTransientSnapshot, DashboardWarning } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { BackupTrigger, CadenceGateDecision } from './backup-cadence.js'
import type { RunActiveState, SuperviseRunOptions, TaskHelperResult, TaskUnitKind } from './task-units.js'
import { BACKUP_SKIP_EXIT_CODE, BackupTask as BackupTaskSchema } from '@anas/shared'
import { DISABLED_HISTORY_NOTE, parseSystemdTimestamp } from './systemd-status.js'
// The systemd/journald half — status derivation, journal reads, the cadence
// gate, Run-Now supervision, dashboard warnings — and the store plumbing (the
// marked-JSON parse, the dir read, the write + enable/disable) are the ONE
// prefix-parameterised copy in task-units.ts, which cloud sync's store calls
// with its own descriptor (rclone.2). Everything below hands it
// BACKUP_UNIT_KIND and keeps the signature backup's callers have always
// imported.
import {
  buildTaskWarnings,
  collectTaskWarnings,
  deriveTaskRunResult,
  deriveTaskStatus as deriveTaskStatusGeneric,
  deriveTriggerSource as deriveTriggerSourceGeneric,
  effectiveSchedule as effectiveScheduleGeneric,
  failureDetailFromJournal as failureDetailFromJournalGeneric,
  gateRun as gateRunGeneric,
  parseHelperResult as parseHelperResultGeneric,
  parseTaskUnit,
  readAllTaskUnits,
  readLastSuccessAt as readLastSuccessAtGeneric,
  readRecentJournal as readRecentJournalGeneric,
  readRunActive as readRunActiveGeneric,
  readTaskUnit,
  readUnitTexts as readUnitTextsGeneric,
  removeTaskUnits as removeTaskUnitsGeneric,
  runningDirectJobFields as runningDirectJobFieldsGeneric,
  runningDirectJobProgress as runningDirectJobProgressGeneric,
  runningRunConflictMessage as runningRunConflictMessageGeneric,
  serviceUnitName as serviceUnitNameGeneric,
  superviseTaskRun,
  taskFileExists as taskFileExistsGeneric,
  timerUnitName as timerUnitNameGeneric,
  writeTaskUnitFiles,
} from './task-units.js'

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
 *
 * **What is backup's and what is every task kind's.** This module keeps what is
 * genuinely backup's: the unit TEXT it renders, the BackupTask schema it parses
 * back, and the per-archive result a pbc run produces. The systemd/journald
 * machinery around that — status, journal reads, the biweekly gate, Run-Now
 * supervision, warnings — is `task-units.ts`, parameterised by
 * {@link BACKUP_UNIT_KIND}. Public API unchanged: every export below has the
 * signature and behaviour it had before the extraction.
 */

/** The timer executes this compiled runner (ships in dist — see backup-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/backup-task.js'
const UNIT_PREFIX = 'anas-backup-'
/** The service-file line that carries the canonical task JSON (as a comment). */
const TASK_MARKER = 'X-ANAS-Task='
/** The runner's owner-coupling failure message (a real, actionable cause). */
const OWNER_MISMATCH_MSG_RE = /owner mismatch/i

/** Backup's descriptor — the ONE place this store's identity is written down. */
export const BACKUP_UNIT_KIND: TaskUnitKind = {
  prefix: UNIT_PREFIX,
  marker: TASK_MARKER,
  runnerScript: RUNNER_SCRIPT,
  warningCategory: 'backup',
  label: 'backup',
  title: 'Backup',
  view: 'Backup',
  logTag: '[backup]',
  causeHints: [OWNER_MISMATCH_MSG_RE],
}

export { DEFAULT_SYSTEMD_DIR, isRunActive, messageFromJournalLine, runFailed, validateSchedule } from './task-units.js'

export function serviceUnitName(name: string): string {
  return serviceUnitNameGeneric(BACKUP_UNIT_KIND, name)
}
export function timerUnitName(name: string): string {
  return timerUnitNameGeneric(BACKUP_UNIT_KIND, name)
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
 *
 * `SuccessExitStatus=` declares the runner's deliberate-skip code (16.10): a
 * biweekly off-week fire did nothing ON PURPOSE, so systemd must record success
 * (no dashboard warning, no failed unit) while `ExecMainStatus` still tells the
 * status derivation that no backup was taken. Emitted for every task so the unit
 * shape stays uniform — pbc itself only ever exits 0 or 255.
 */
export function renderServiceUnit(task: BackupTask): string {
  const execStart = [RUNNER_NODE, BACKUP_UNIT_KIND.runnerScript, ...runnerArgs(task)].join(' ')
  return [
    '[Unit]',
    `Description=ANAS backup task ${task.name}`,
    `# ${TASK_MARKER}${JSON.stringify(task)}`,
    '',
    '[Service]',
    'Type=oneshot',
    '# per-task file-handle backpressure (pbc hoards fds, worst in metadata mode)',
    `LimitNOFILE=${task.limitNofile}`,
    '# a deliberate skip (biweekly off week) is a success, not a failure',
    `SuccessExitStatus=${BACKUP_SKIP_EXIT_CODE}`,
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/**
 * The OnCalendar expression a task's timer actually gets — a cadence generates
 * it, a raw-schedule task keeps its expression verbatim (see task-units.ts,
 * where the rule is shared with every other task kind).
 */
export function effectiveSchedule(task: BackupTask): string {
  return effectiveScheduleGeneric(task)
}

/** Render the `.timer` unit for a task's schedule. */
export function renderTimerUnit(task: BackupTask): string {
  return [
    '[Unit]',
    `Description=ANAS backup timer ${task.name}`,
    '',
    '[Timer]',
    `OnCalendar=${effectiveSchedule(task)}`,
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
  return parseTaskUnit(BACKUP_UNIT_KIND, content, BackupTaskSchema)
}

// --- Store: read ------------------------------------------------------------

/** All valid tasks parsed from `anas-backup-*.service` files (invalid → skipped). */
export async function readAllTasks(dir: string): Promise<BackupTask[]> {
  return readAllTaskUnits(BACKUP_UNIT_KIND, dir, BackupTaskSchema)
}

/** One task by name, or null if its service file is absent/invalid. */
export async function readTask(dir: string, name: string): Promise<BackupTask | null> {
  return readTaskUnit(BACKUP_UNIT_KIND, dir, name, BackupTaskSchema)
}

/** Does a task's service file exist on disk? (the store is the files). */
export async function taskFileExists(dir: string, name: string): Promise<boolean> {
  return taskFileExistsGeneric(BACKUP_UNIT_KIND, dir, name)
}

/** The verbatim `.service` + `.timer` unit text for a task ('' when absent). */
export async function readUnitTexts(dir: string, name: string): Promise<{ unit: string, timer: string }> {
  return readUnitTextsGeneric(BACKUP_UNIT_KIND, dir, name)
}

// --- Store: write + remove ---------------------------------------------------

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
  return writeTaskUnitFiles(BACKUP_UNIT_KIND, executor, dir, task, {
    service: renderServiceUnit(task),
    timer: renderTimerUnit(task),
  })
}

/**
 * Remove a task: stop+disable the timer, delete both unit files AND the
 * timer's Persistent stamp, reset the failed-state ghost, reload systemd
 * (task-units.ts — SCHEDULES-GT-17/18). Deliberately touches NOTHING on the
 * PBS server — snapshots already stored are left exactly as they are (deleting
 * a schedule is not deleting a backup).
 */
export async function removeTaskUnits(
  executor: CommandExecutor,
  dir: string,
  name: string,
): Promise<void> {
  return removeTaskUnitsGeneric(BACKUP_UNIT_KIND, executor, dir, name)
}

// --- Status derivation ------------------------------------------------------
//
// Re-exported here so this module stays the one import a backup caller needs:
// `parseSystemdTimestamp` + the disabled-history note come from
// systemd-status.ts, everything else from task-units.ts.

export { DISABLED_HISTORY_NOTE, parseSystemdTimestamp }

/**
 * Map a service's systemd state to a backup run result: the shared oneshot map
 * plus the runner's deliberate-skip code (task-units.ts — every ANAS task
 * runner uses the same one, declared on the unit as `SuccessExitStatus=`).
 */
export function deriveRunResult(
  props: Record<string, string>,
  ctx: { enabled?: boolean } = {},
): BackupRunResult {
  return deriveTaskRunResult(props, ctx)
}

export interface BackupTaskStatus {
  lastRunResult: BackupRunResult
  lastRunAt: string | null
  nextRunAt: string | null
  overdue: boolean
  /**
   * When the task last completed a real backup (ISO), or null when there is no
   * record. Cheap when the last run itself succeeded; otherwise read from the
   * journal, and only for a cadence whose period makes staleness meaningful.
   */
  lastSuccessAt: string | null
  /** The unit's service is still running right now (task-units.ts — free off the same `systemctl show`). */
  runActive: boolean
  /** "cancelled by <user> at <time>" for a cancelled last run, from the journal (rclone.5). */
  lastRunNote?: string
}

/**
 * Derive one task's LOCAL-ONLY status from persistent systemd state (see
 * task-units.ts: last result + last-run time from the service, next elapse from
 * the timer, cadence-aware overdue, fail-open per source).
 */
export async function deriveTaskStatus(
  executor: CommandExecutor,
  task: BackupTask,
  now: number = Date.now(),
): Promise<BackupTaskStatus> {
  return deriveTaskStatusGeneric(BACKUP_UNIT_KIND, executor, task, now)
}

/**
 * Recent journald output for a task's service, as a raw text blob (labeled
 * recent-only forensics — it rotates). Fail-open to ''.
 */
export async function readRecentJournal(executor: CommandExecutor, name: string): Promise<string> {
  return readRecentJournalGeneric(BACKUP_UNIT_KIND, executor, name)
}

/**
 * When the task last completed a REAL backup, from the unit's own journal — the
 * only local record of a success that an off-week skip or a later failure has
 * since overwritten in systemd's last-result. LOCAL-ONLY by operator ruling: the
 * PBS server is never asked. Fail-open to null.
 */
export async function readLastSuccessAt(executor: CommandExecutor, name: string): Promise<string | null> {
  return readLastSuccessAtGeneric(BACKUP_UNIT_KIND, executor, name)
}

// --- Cadence gate inputs: last success + who triggered this run (16.10) ------

export { classifyTrigger } from './task-units.js'

/** Read the two systemd props `classifyTrigger` needs (fail-open to manual). */
export async function deriveTriggerSource(executor: CommandExecutor, name: string): Promise<BackupTrigger> {
  return deriveTriggerSourceGeneric(BACKUP_UNIT_KIND, executor, name)
}

/**
 * Decide whether this fire of a task should actually back up: the pure cadence
 * decision (backup-cadence.ts) plus the two LOCAL reads it needs — who triggered
 * the run, and when the task last succeeded.
 */
export async function gateRun(
  executor: CommandExecutor,
  task: BackupTask,
  now: Date = new Date(),
): Promise<CadenceGateDecision> {
  return gateRunGeneric(BACKUP_UNIT_KIND, executor, task, now)
}

// --- Run-Now supervision (LOCAL-ONLY: systemd + journald, never PBS) ---------

/**
 * The Run-Now door's pre-check (rclone.3 human-pass finding 1, backup parity):
 * is this task's run executing right now, and since when — the generic half in
 * task-units.ts, handed this store's descriptor.
 */
export async function readRunActive(executor: CommandExecutor, name: string): Promise<RunActiveState> {
  return readRunActiveGeneric(executor, BACKUP_UNIT_KIND, name)
}

/**
 * The in-flight DIRECT run job's live progress text (pbc's own lines), or
 * null — the ONE lookup the status payload's `runningProgress` and the Run-Now
 * 409 both use.
 */
export function runningDirectJobProgress(jobQueue: JobQueue, name: string): string | null {
  return runningDirectJobProgressGeneric(jobQueue, 'backup.task.run', name)
}

/**
 * The status payload's running-run fields — `runningProgress` and the direct
 * job's `runningJobId` (rclone.5: what Cancel run targets) — from ONE lookup.
 */
export function runningDirectJobFields(jobQueue: JobQueue, name: string): { runningProgress?: string, runningJobId?: string } {
  return runningDirectJobFieldsGeneric(jobQueue, 'backup.task.run', name)
}

/** The Run-Now refusal sentence for a run already in flight (kind baked in). */
export function runningRunConflictMessage(name: string, run: RunActiveState, progress?: string | null): string {
  return runningRunConflictMessageGeneric(BACKUP_UNIT_KIND, name, run, progress)
}

export type { SuperviseRunOptions }

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
  /** Retention prune counts recovered from the helper's result (16.11). */
  prune?: BackupPruneResult
  /** Completed-with-warning detail (e.g. a prune that failed after a good backup). */
  warnings?: string[]
  /**
   * Nested filesystems the run actually CROSSED, per archive (backup2.2). The
   * positive half of the never-silent contract: `warnings` names what was left
   * out, this names what was taken in. Live-proof wave 1 found it recovered by
   * the direct (unit) path and dropped by the supervised one.
   */
  includedNested?: Record<string, string[]>
  /**
   * backup2.3's three facts — what each source's consistency was DERIVED to be,
   * which transient snapshots existed while the run read, and which archive
   * roots the client was actually handed. DESIGN.md promises the run result
   * carries all three; live-proof wave 2 found the supervised Run-Now path
   * dropping them (the same omission wave 1 caught for `includedNested`), so a
   * UI Run-Now could not tell a snapshot run from a live one.
   */
  consistency?: BackupArchiveConsistency[]
  snapshots?: BackupTransientSnapshot[]
  expansion?: BackupExpandedArchive[]
}

/** The shape the backup-task helper prints as JSON (its `job.result`). */
interface HelperResult extends TaskHelperResult {
  status?: string
  archives?: string[]
  target?: string
  nofileWarning?: string
  reason?: string
  prune?: BackupPruneResult
  warnings?: string[]
  includedNested?: Record<string, string[]>
  consistency?: BackupArchiveConsistency[]
  snapshots?: BackupTransientSnapshot[]
  expansion?: BackupExpandedArchive[]
}

/**
 * Recover the helper's result JSON from the unit journal — the backup-task
 * helper prints `{ task, result }` to stdout on completion, so the
 * too-soon/skipped classification (and the per-archive stats) survive into the
 * manual supervisor. Returns null when no result line is present.
 */
export function parseHelperResult(journal: string): HelperResult | null {
  return parseHelperResultGeneric<HelperResult>(journal)
}

/**
 * The client-safe failure detail from the unit journal: prefer pbc's verbatim
 * `Error:` line (or the runner's thrown owner/failed message), else the last
 * non-JSON message line. Never contains a secret (pbc's stderr never does).
 */
export function failureDetailFromJournal(journal: string): string | null {
  return failureDetailFromJournalGeneric(BACKUP_UNIT_KIND, journal)
}

/**
 * Run a task NOW through its own systemd unit and supervise to completion
 * (task-units.ts owns the start/poll/classify loop). What stays backup's is the
 * MAPPING below: the helper's per-archive stats, retention counts, nested
 * boundary facts and consistency records are pbc's, not every task kind's.
 */
export async function superviseRun(
  executor: CommandExecutor,
  name: string,
  opts: SuperviseRunOptions = {},
): Promise<SuperviseRunResult> {
  const run = await superviseTaskRun<HelperResult>(BACKUP_UNIT_KIND, executor, name, opts)
  const helper = run.helper
  const result: SuperviseRunResult = { status: run.status, alreadyRunning: run.alreadyRunning }
  if (helper?.archives?.length)
    result.archives = helper.archives
  if (helper?.target)
    result.target = helper.target
  if (helper?.nofileWarning)
    result.nofileWarning = helper.nofileWarning
  // Retention (16.11): the counts — and a prune that failed after a SUCCESSFUL
  // backup — travel through the helper's result JSON, so a UI Run-Now surfaces
  // them exactly like a scheduled run's journal does.
  if (helper?.prune)
    result.prune = helper.prune
  if (helper?.warnings?.length)
    result.warnings = helper.warnings
  // backup2.2: what the run DID cross travels the same way the omissions do —
  // a Run-Now must not report only half the boundary story.
  if (helper?.includedNested && Object.keys(helper.includedNested).length)
    result.includedNested = helper.includedNested
  // backup2.3: consistency / transient snapshots / expansion travel the same
  // way. An absent field stays ABSENT — never an empty array.
  if (helper?.consistency?.length)
    result.consistency = helper.consistency
  if (helper?.snapshots?.length)
    result.snapshots = helper.snapshots
  if (helper?.expansion?.length)
    result.expansion = helper.expansion
  // Both skip flavours report as 'skipped' — the benign too-soon collision and a
  // gated off-week fire (which a Run-Now can only meet by landing on one already
  // in flight). The helper's own `reason` says which; `run.reason` is set only
  // when supervision hit its ceiling.
  if (helper?.reason)
    result.reason = helper.reason
  else if (run.reason)
    result.reason = run.reason
  else if (result.status === 'skipped')
    result.reason = 'snapshot timestamp collision (1-second resolution) — nothing new to back up yet'
  return result
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
  return buildTaskWarnings(BACKUP_UNIT_KIND, inputs)
}

/**
 * Collect the dashboard 'backup' warnings from the task store, fail-open. Mirrors
 * how replication/mount warnings are wired into GET /v1/status.
 */
export async function collectBackupWarnings(
  executor: CommandExecutor,
  dir: string,
): Promise<DashboardWarning[]> {
  return collectTaskWarnings(BACKUP_UNIT_KIND, executor, dir, readAllTasks)
}
