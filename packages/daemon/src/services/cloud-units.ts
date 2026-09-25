import type { CloudSyncTask, DashboardWarning } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { CadenceGateDecision, TaskTrigger } from './backup-cadence.js'
import type { SuperviseRunOptions, TaskHelperResult, TaskRunResult, TaskUnitKind } from './task-units.js'
import { BACKUP_SKIP_EXIT_CODE, CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { DISABLED_HISTORY_NOTE, parseSystemdTimestamp } from './systemd-status.js'
// Everything generic lives in task-units.ts and is handed CLOUD_UNIT_KIND: the
// status derivation, the journald reads, the biweekly gate, Run-Now
// supervision, the dashboard warnings AND the store plumbing (marked-JSON
// parse, dir read, write + enable/disable). What stays HERE is what is
// genuinely cloud sync's — the unit TEXT this store renders and the
// CloudSyncTask schema it parses back.
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
  readTaskUnit,
  readUnitTexts as readUnitTextsGeneric,
  removeTaskUnits as removeTaskUnitsGeneric,
  serviceUnitName as serviceUnitNameGeneric,
  superviseTaskRun,
  taskFileExists as taskFileExistsGeneric,
  timerUnitName as timerUnitNameGeneric,
  writeTaskUnitFiles,
} from './task-units.js'

/**
 * Cloud sync TASKS (story rclone.2) — the fifth unit store, built on the ONE
 * prefix-parameterised helper the backup store already uses.
 *
 * Each task is an `anas-cloud-<name>.service` + `.timer` pair. There is NO
 * second config source and NO custom scheduler: CRUD writes/rewrites/removes
 * the two unit files and drives `systemctl` to reload + enable/disable the
 * timer. The canonical CloudSyncTask JSON is embedded in the service file as an
 * `X-ANAS-Task=` comment and is the SINGLE source of truth parsed back — we
 * never reverse-engineer it from ExecStart.
 *
 * Status is LOCAL-ONLY (the backup ruling, reapplied — ANAS never asks a cloud
 * remote when it last received data): last result / next run / overdue from
 * persistent systemd unit+timer state, recent run detail from journald (labeled
 * recent-only; it rotates). Every derivation fails open.
 *
 * Public API mirrors `backup-units.ts` function for function, on purpose
 * (parallel construction): a reader who knows one store knows the other.
 */

/** The timer executes this compiled runner (ships in dist — see cloud-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/cloud-task.js'
const UNIT_PREFIX = 'anas-cloud-'
/** The service-file line that carries the canonical task JSON (as a comment). */
const TASK_MARKER = 'X-ANAS-Task='
/**
 * rclone's own failure lines — a real, actionable cause, preferred over
 * systemd's generic "Failed with result" trailer. Every `NewFs` failure (an
 * unreachable host, bad credentials, an unknown remote) prints one of these.
 */
const RCLONE_FAILURE_MSG_RE = /Failed to (?:copy|sync|create file system|lsjson)/i

/**
 * Cloud sync's descriptor — the ONE place this store's identity is written
 * down.
 *
 * ⚠ `prefix` MUST stay disjoint from every other kind's (see `TaskUnitKind`):
 * the store reads itself by listing `anas-cloud-*.service`, and a prefix that
 * overlapped backup's would make each store adopt — and then rewrite — the
 * other's units. `anas-cloud-` and `anas-backup-` share no prefix relation in
 * either direction.
 */
export const CLOUD_UNIT_KIND: TaskUnitKind = {
  prefix: UNIT_PREFIX,
  marker: TASK_MARKER,
  runnerScript: RUNNER_SCRIPT,
  warningCategory: 'cloud',
  label: 'cloud sync',
  title: 'Cloud sync',
  view: 'Cloud Sync',
  logTag: '[cloud]',
  causeHints: [RCLONE_FAILURE_MSG_RE],
}

export { DEFAULT_SYSTEMD_DIR, isRunActive, messageFromJournalLine, runFailed, validateSchedule } from './task-units.js'

export function serviceUnitName(name: string): string {
  return serviceUnitNameGeneric(CLOUD_UNIT_KIND, name)
}
export function timerUnitName(name: string): string {
  return timerUnitNameGeneric(CLOUD_UNIT_KIND, name)
}

// --- Runner argv -------------------------------------------------------------

/** The argv the timer passes to the runner (which POSTs the run job + polls it). */
export function runnerArgs(task: { name: string }): string[] {
  return ['--name', task.name]
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Render the `.service` unit. The `X-ANAS-Task=` comment embeds the canonical
 * task JSON (single line) — the ONLY thing the parser reads back. ExecStart is
 * for systemd to actually run; it is never parsed by us.
 *
 * `SuccessExitStatus=` declares the runner's deliberate-skip code: a biweekly
 * off-week fire did nothing ON PURPOSE, so systemd must record success (no
 * dashboard warning, no failed unit) while `ExecMainStatus` still tells the
 * status derivation that no sync ran. Emitted for every task so the unit shape
 * stays uniform.
 *
 * No `LimitNOFILE=` here: that knob is pbc's fd-hoarding problem, and a knob
 * nobody needs is a knob nobody should be able to set.
 */
export function renderServiceUnit(task: CloudSyncTask): string {
  const execStart = [RUNNER_NODE, CLOUD_UNIT_KIND.runnerScript, ...runnerArgs(task)].join(' ')
  return [
    '[Unit]',
    `Description=ANAS cloud sync task ${task.name}`,
    `# ${TASK_MARKER}${JSON.stringify(task)}`,
    '',
    '[Service]',
    'Type=oneshot',
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
export function effectiveSchedule(task: CloudSyncTask): string {
  return effectiveScheduleGeneric(task)
}

/** Render the `.timer` unit for a task's schedule. */
export function renderTimerUnit(task: CloudSyncTask): string {
  return [
    '[Unit]',
    `Description=ANAS cloud sync timer ${task.name}`,
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
 * Parse the canonical CloudSyncTask out of a `.service` unit's body via its
 * `X-ANAS-Task=` line (with or without the leading `# `), zod-validated.
 * Returns null when the marker is absent or the JSON is invalid — the caller
 * skips (and warns about) such files, fail-open.
 */
export function parseServiceUnit(content: string): CloudSyncTask | null {
  return parseTaskUnit(CLOUD_UNIT_KIND, content, CloudSyncTaskSchema)
}

// --- Store: read ------------------------------------------------------------

/** All valid tasks parsed from `anas-cloud-*.service` files (invalid → skipped). */
export async function readAllTasks(dir: string): Promise<CloudSyncTask[]> {
  return readAllTaskUnits(CLOUD_UNIT_KIND, dir, CloudSyncTaskSchema)
}

/** One task by name, or null if its service file is absent/invalid. */
export async function readTask(dir: string, name: string): Promise<CloudSyncTask | null> {
  return readTaskUnit(CLOUD_UNIT_KIND, dir, name, CloudSyncTaskSchema)
}

/** Does a task's service file exist on disk? (the store is the files). */
export async function taskFileExists(dir: string, name: string): Promise<boolean> {
  return taskFileExistsGeneric(CLOUD_UNIT_KIND, dir, name)
}

/** The verbatim `.service` + `.timer` unit text for a task ('' when absent). */
export async function readUnitTexts(dir: string, name: string): Promise<{ unit: string, timer: string }> {
  return readUnitTextsGeneric(CLOUD_UNIT_KIND, dir, name)
}

/**
 * The names of the tasks that reference `remote` — the hard 409 the remotes
 * DELETE door asks for (rclone.1 shipped the check against an empty store;
 * this is the real one). Fail-open to none: an unreadable unit dir is an empty
 * store everywhere else in this module, and a delete is already a deliberate
 * act the operator can repeat.
 */
export async function tasksReferencingRemote(dir: string, remote: string): Promise<string[]> {
  const tasks = await readAllTasks(dir)
  return tasks.filter(t => t.remote === remote).map(t => t.name).sort()
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
  task: CloudSyncTask,
): Promise<void> {
  return writeTaskUnitFiles(CLOUD_UNIT_KIND, executor, dir, task, {
    service: renderServiceUnit(task),
    timer: renderTimerUnit(task),
  })
}

/**
 * Remove a task: stop+disable the timer, delete both unit files AND the
 * timer's Persistent stamp, reset the failed-state ghost, reload systemd
 * (task-units.ts — SCHEDULES-GT-17/18). Deliberately touches NOTHING at the
 * remote — files already copied there stay exactly as they are (deleting a
 * schedule is not deleting data).
 */
export async function removeTaskUnits(
  executor: CommandExecutor,
  dir: string,
  name: string,
): Promise<void> {
  return removeTaskUnitsGeneric(CLOUD_UNIT_KIND, executor, dir, name)
}

// --- Status derivation ------------------------------------------------------

export { DISABLED_HISTORY_NOTE, parseSystemdTimestamp }

/**
 * Map a service's systemd state to a cloud sync run result: the shared oneshot
 * map plus the runner's deliberate-skip code (task-units.ts — every ANAS task
 * runner uses the same one, declared on the unit as `SuccessExitStatus=`).
 */
export function deriveRunResult(
  props: Record<string, string>,
  ctx: { enabled?: boolean } = {},
): TaskRunResult {
  return deriveTaskRunResult(props, ctx)
}

export interface CloudTaskStatus {
  lastRunResult: TaskRunResult
  lastRunAt: string | null
  nextRunAt: string | null
  overdue: boolean
  /** When the task last completed a real sync (ISO), or null when there is no record. */
  lastSuccessAt: string | null
}

/**
 * Derive one task's LOCAL-ONLY status from persistent systemd state (see
 * task-units.ts: last result + last-run time from the service, next elapse from
 * the timer, cadence-aware overdue, fail-open per source).
 */
export async function deriveTaskStatus(
  executor: CommandExecutor,
  task: CloudSyncTask,
  now: number = Date.now(),
): Promise<CloudTaskStatus> {
  return deriveTaskStatusGeneric(CLOUD_UNIT_KIND, executor, task, now)
}

/** Recent journald output for a task's service (labeled recent-only). Fail-open to ''. */
export async function readRecentJournal(executor: CommandExecutor, name: string): Promise<string> {
  return readRecentJournalGeneric(CLOUD_UNIT_KIND, executor, name)
}

/** When the task last completed a REAL sync, from the unit's own journal. Fail-open to null. */
export async function readLastSuccessAt(executor: CommandExecutor, name: string): Promise<string | null> {
  return readLastSuccessAtGeneric(CLOUD_UNIT_KIND, executor, name)
}

// --- Cadence gate inputs ----------------------------------------------------

export { classifyTrigger } from './task-units.js'

/** Read the two systemd props `classifyTrigger` needs (fail-open to manual). */
export async function deriveTriggerSource(executor: CommandExecutor, name: string): Promise<TaskTrigger> {
  return deriveTriggerSourceGeneric(CLOUD_UNIT_KIND, executor, name)
}

/**
 * Decide whether this fire of a task should actually sync: the pure cadence
 * decision (backup-cadence.ts) plus the two LOCAL reads it needs — who
 * triggered the run, and when the task last succeeded. The decision's prose
 * says "cloud sync", not "backup" (the descriptor's `label`).
 */
export async function gateRun(
  executor: CommandExecutor,
  task: CloudSyncTask,
  now: Date = new Date(),
): Promise<CadenceGateDecision> {
  return gateRunGeneric(CLOUD_UNIT_KIND, executor, task, now)
}

// --- Run-Now supervision (LOCAL-ONLY: systemd + journald) -------------------

export type { SuperviseRunOptions }

export interface CloudSuperviseRunResult {
  /** 'success' | 'skipped' (deliberate off-week) | 'running' (hit the ceiling). */
  status: 'success' | 'skipped' | 'running'
  /** True when the service was ALREADY running when Run-Now fired (no fresh start). */
  alreadyRunning: boolean
  /** Why a run did nothing, or is still running (the ceiling). */
  reason?: string
  /**
   * The run's own numbers, recovered from the helper's journal result JSON —
   * so a UI Run-Now reports exactly what a scheduled run's journal shows.
   */
  run?: CloudHelperResult
}

/** The shape the cloud-task helper prints as JSON (its `job.result`). */
export interface CloudHelperResult extends TaskHelperResult {
  status?: string
  reason?: string
  mode?: string
  source?: string
  destination?: string
  snapshot?: string
  bytes?: number
  totalBytes?: number
  transfers?: number
  checks?: number
  deletes?: number
  errors?: number
  elapsed?: number
  errorLines?: string[]
  warnings?: string[]
}

/** Recover the helper's result JSON from the unit journal (null when absent). */
export function parseHelperResult(journal: string): CloudHelperResult | null {
  return parseHelperResultGeneric<CloudHelperResult>(journal)
}

/**
 * The client-safe failure detail from the unit journal: prefer rclone's own
 * failure line (or the runner's thrown message), else the last non-JSON message
 * line. Never contains a secret — a remote NAME is not a secret and no option
 * value ever reaches an argv or rclone's log.
 */
export function failureDetailFromJournal(journal: string): string | null {
  return failureDetailFromJournalGeneric(CLOUD_UNIT_KIND, journal)
}

/**
 * Run a task NOW through its own systemd unit and supervise it to completion
 * (task-units.ts owns the start/poll/classify loop). What stays cloud sync's is
 * the MAPPING below: rclone's counters are this store's, not every kind's.
 */
export async function superviseRun(
  executor: CommandExecutor,
  name: string,
  opts: SuperviseRunOptions = {},
): Promise<CloudSuperviseRunResult> {
  const run = await superviseTaskRun<CloudHelperResult>(CLOUD_UNIT_KIND, executor, name, opts)
  const result: CloudSuperviseRunResult = { status: run.status, alreadyRunning: run.alreadyRunning }
  if (run.helper)
    result.run = run.helper
  if (run.helper?.reason)
    result.reason = run.helper.reason
  else if (run.reason)
    result.reason = run.reason
  return result
}

// --- Dashboard warnings -----------------------------------------------------

/** A minimal task-status shape the dashboard warning builder needs. */
export interface CloudWarningInput {
  name: string
  enabled: boolean
  lastRunResult: TaskRunResult
  overdue: boolean
}

/**
 * Dashboard warnings for failing/overdue cloud sync tasks (category 'cloud').
 * Warns ONLY on an ENABLED task whose last run failed OR which is silently
 * overdue — a deliberate skip and a disabled task never warn.
 */
export function buildCloudWarnings(inputs: CloudWarningInput[]): DashboardWarning[] {
  return buildTaskWarnings(CLOUD_UNIT_KIND, inputs)
}

/** Collect the dashboard 'cloud' warnings from the task store, fail-open. */
export async function collectCloudWarnings(
  executor: CommandExecutor,
  dir: string,
): Promise<DashboardWarning[]> {
  return collectTaskWarnings(CLOUD_UNIT_KIND, executor, dir, readAllTasks)
}
