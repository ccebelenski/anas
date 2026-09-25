import type { DashboardWarning, Job, TaskCadence } from '@anas/shared'
import type { ZodType } from 'zod'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { CadenceGateDecision, TaskTrigger } from './backup-cadence.js'
import type { SystemdRunResult } from './systemd-status.js'
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK, cadenceToOnCalendar } from '@anas/shared'
import { decideCadenceRun, isTaskOverdue, overdueWindowMs } from './backup-cadence.js'
import { deriveRunResult as deriveSystemdRunResult, parseShow, parseSystemdTimestamp } from './systemd-status.js'
import { listServiceUnits, parseMarkedJson, runSystemctl, systemdTimersStampDir, unlinkQuiet } from './systemd-unit-store.js'

/**
 * The scheduled-TASK generics — everything a units-are-the-store task kind does
 * that is generic in all but its unit prefix (rclone.2 slice 1).
 *
 * `backup-units.ts` grew these first (Epic 16); cloud sync (`cloud-units.ts`)
 * needs the identical status derivation, journald reads, cadence gate, Run-Now
 * supervision and dashboard warnings. Copies diverge into bugs (single source of
 * truth), and DESIGN "Cloud sync — rclone" says it plainly: *"Extraction, not a
 * copy"*. So the generic half lives HERE and each store passes its
 * {@link TaskUnitKind} descriptor; the per-store half — unit RENDERING, the
 * canonical-JSON parse (each store has its own zod schema) and what a write
 * means — stays in the store, because those genuinely differ.
 *
 * **Shape: a descriptor as the first argument, not a curried factory.** Every
 * entry point takes `kind` explicitly (the pure ones — {@link classifyTrigger},
 * {@link isRunActive}, {@link runFailed}, {@link messageFromJournalLine},
 * {@link parseHelperResult}, {@link validateSchedule}, {@link effectiveSchedule}
 * — take none at all). A store's wrapper is then a one-line delegation with the
 * SAME signature it always had, a stack trace names the real function, and
 * nothing is captured in a closure. A factory would only have moved that same
 * one line into the factory call.
 *
 * This module is the systemd/journald half only: no store semantics, no
 * rendering, and (as everywhere in the unit stores) every derivation fails OPEN
 * so one unreadable source never blanks a view.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const JOURNALCTL = '/usr/bin/journalctl'
/** How many recent journald lines the detail view surfaces. */
const JOURNAL_TAIL = 200
/**
 * Slack when deciding whether a timer (rather than a hand) started this run.
 * systemd prints these timestamps at 1-second resolution, and the trigger always
 * precedes the start; 5s covers the granularity without spanning anything real.
 */
const TRIGGER_SLACK_MS = 5000
/** Trailing `=` of a marker token — trimmed for the skip warning's prose. */
const MARKER_EQUALS_RE = /=$/
/** journalctl `short-iso` numeric zone (`+0000`) → the ISO form Date.parse wants. */
const JOURNAL_TZ_RE = /([+-]\d{2})(\d{2})$/
/** journalctl syslog prefix without a `[pid]` bracket: `<ts> <host> <ident>: <msg>`. */
const JOURNAL_PREFIX_RE = /^\S+\s+\S+\s+\S+?:\s(.*)$/
/** A failure-ish message line. */
const FAILED_MSG_RE = /failed/i
/** ActiveState values that mean the oneshot service is still running. */
const RUN_ACTIVE_STATES = new Set(['activating', 'active', 'reloading'])
/** Supervision poll cadence. */
const SUPERVISE_POLL_MS = 2000
/** Generous ceiling — a real run can run long; mirrors the UI's 600s budget. */
const SUPERVISE_TIMEOUT_MS = 600000

/** Default systemd unit directory; overridable (env/dep) for tests. */
export const DEFAULT_SYSTEMD_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

/**
 * What distinguishes one task kind from another. Everything else in this module
 * is identical between them — which is the whole point of the descriptor.
 *
 * ⚠ PREFIXES MUST BE DISJOINT. The store reads itself by listing
 * `<prefix>*.service` (see {@link readAllTaskUnits}), so a prefix that is a
 * prefix of another kind's would make one store adopt the other's units — and
 * then rewrite them through its own schema. `anas-backup-` and `anas-cloud-`
 * are disjoint; any kind added later must be checked against every existing
 * one, not just the newest.
 */
export interface TaskUnitKind {
  /** Unit-name prefix, e.g. `anas-backup-` / `anas-cloud-`. MUST be disjoint from every other kind's. */
  prefix: string
  /** The service-file line carrying the canonical task JSON, e.g. `X-ANAS-Task=`. */
  marker: string
  /** The compiled runner the timer executes (used by the store's renderer). */
  runnerScript: string
  /** Dashboard warning category for this kind's failures/overdue. */
  warningCategory: DashboardWarning['category']
  /** Lowercase noun for prose: `<label> task 'x' is already running`. */
  label: string
  /** Sentence-case noun for a warning: `<title> task 'x' last run failed`. */
  title: string
  /** The UI view a warning points at: `check the <view> view`. */
  view: string
  /** The journald prefix this store's own warnings carry, e.g. `[backup]`. */
  logTag: string
  /**
   * Extra journal lines that are a REAL cause, preferred over systemd's generic
   * trailer the way a runner's own `Error:` line is (backup: the runner's
   * owner-coupling message). Optional — most kinds need none.
   */
  causeHints?: readonly RegExp[]
}

export function serviceUnitName(kind: TaskUnitKind, name: string): string {
  return `${kind.prefix}${name}.service`
}
export function timerUnitName(kind: TaskUnitKind, name: string): string {
  return `${kind.prefix}${name}.timer`
}

// --- Store plumbing that is byte-identical modulo the prefix -----------------
//
// Unit RENDERING stays per store — a `.service` body carries the store's own
// description, its own `ExecStart` and (backup) its own `LimitNOFILE=`, and
// there is nothing generic left once those are removed. Everything else here
// was byte-identical between the two stores modulo the prefix, the zod schema
// and the log tag (rclone.2 slice 2, on the slice-1 review's suggestion): the
// schema arrives as a PARAMETER (a descriptor field cannot carry a generic
// type), the tag as `kind.logTag`, and the write takes the two rendered texts.

/** Does a task's service file exist on disk? (the store is the files). */
export async function taskFileExists(kind: TaskUnitKind, dir: string, name: string): Promise<boolean> {
  try {
    await readFile(join(dir, serviceUnitName(kind, name)), 'utf-8')
    return true
  }
  catch {
    return false
  }
}

/** The verbatim `.service` + `.timer` unit text for a task ('' when absent). */
export async function readUnitTexts(
  kind: TaskUnitKind,
  dir: string,
  name: string,
): Promise<{ unit: string, timer: string }> {
  const [unit, timer] = await Promise.all([
    readFile(join(dir, serviceUnitName(kind, name)), 'utf-8').catch(() => ''),
    readFile(join(dir, timerUnitName(kind, name)), 'utf-8').catch(() => ''),
  ])
  return { unit, timer }
}

/**
 * Parse a store's canonical task JSON out of a `.service` unit body via its
 * `X-ANAS-Task=` line, zod-validated against the store's OWN schema. Null when
 * the marker is absent or the JSON does not validate — a unit we did not write
 * (or cannot read back) is never adopted.
 */
export function parseTaskUnit<T>(kind: TaskUnitKind, content: string, schema: ZodType<T>): T | null {
  return parseMarkedJson(content, kind.marker, schema)
}

/**
 * Every valid task parsed from this kind's `<prefix>*.service` files. An
 * unreadable or unparseable file is SKIPPED with a warning (fail-open: one bad
 * unit never blanks a store), tagged with the kind's own journald prefix.
 */
export async function readAllTaskUnits<T>(kind: TaskUnitKind, dir: string, schema: ZodType<T>): Promise<T[]> {
  const services = await listServiceUnits(dir, kind.prefix)
  const tasks: T[] = []
  for (const file of services) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      const task = parseTaskUnit(kind, content, schema)
      if (task)
        tasks.push(task)
      else
        console.warn(`${kind.logTag} skipping ${file}: no valid ${kind.marker.replace(MARKER_EQUALS_RE, '')} JSON`)
    }
    catch (err) {
      console.warn(`${kind.logTag} skipping ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return tasks
}

/** One task by name, or null if its service file is absent/invalid. */
export async function readTaskUnit<T>(
  kind: TaskUnitKind,
  dir: string,
  name: string,
  schema: ZodType<T>,
): Promise<T | null> {
  try {
    return parseTaskUnit(kind, await readFile(join(dir, serviceUnitName(kind, name)), 'utf-8'), schema)
  }
  catch {
    return null
  }
}

/**
 * Write (or rewrite) a task's service+timer from the texts its store RENDERED,
 * reload systemd, then bring the timer to match `enabled`. Throws on any
 * systemctl failure so the mutation surfaces it.
 */
export async function writeTaskUnitFiles(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  dir: string,
  task: { name: string, enabled: boolean },
  units: { service: string, timer: string },
): Promise<void> {
  await writeFile(join(dir, serviceUnitName(kind, task.name)), units.service, 'utf-8')
  await writeFile(join(dir, timerUnitName(kind, task.name)), units.timer, 'utf-8')

  await runSystemctl(executor, ['daemon-reload'])
  const timer = timerUnitName(kind, task.name)
  if (task.enabled)
    await runSystemctl(executor, ['enable', '--now', timer])
  else
    await runSystemctl(executor, ['disable', '--now', timer])
}

/**
 * Where systemd records a Persistent timer's last fire for ONE task: the
 * timers stamp dir (shared {@link systemdTimersStampDir}) + `stamp-<timer>` —
 * e.g. `/var/lib/systemd/timers/stamp-anas-backup-<name>.timer`. A stamp a
 * removed task left behind makes the task's re-creation fire at once (the
 * stamp reads as a missed run — SCHEDULES-GT-17), so removal deletes it.
 */
export function taskStampPath(kind: TaskUnitKind, name: string): string {
  return `${systemdTimersStampDir()}/stamp-${timerUnitName(kind, name)}`
}

/**
 * Remove a task: stop+disable the timer, delete both unit files AND the
 * timer's Persistent stamp, reset the units' failed state, reload systemd.
 * Deliberately touches NOTHING the task WROTE — snapshots already on a PBS
 * server, files already at a cloud remote, are left exactly as they are
 * (deleting a schedule is not deleting a backup).
 *
 * The stamp and the failed state are systemd's OWN bookkeeping about the task,
 * and leaving either behind poisons the task's NEXT life: a leftover stamp
 * makes the re-created timer fire immediately (`Persistent=true` reads the
 * stamp as a missed run — SCHEDULES-GT-17), and a removed oneshot that failed
 * stays in the failed state as a `not-found` ghost. The stamp unlink is the
 * scrub store's pattern (review R10); the `reset-failed` is new here (review
 * R2). It is issued as TWO calls — service first, then timer — each with its
 * exit IGNORED: one combined call is unproven against real systemd (whether a
 * not-loaded first unit short-circuits the rest of the argv), and a reset of
 * nothing must never fail the removal anyway.
 */
export async function removeTaskUnits(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  dir: string,
  name: string,
): Promise<void> {
  await executor.exec(SYSTEMCTL, ['disable', '--now', timerUnitName(kind, name)])
  await Promise.all([
    unlinkQuiet(join(dir, serviceUnitName(kind, name))),
    unlinkQuiet(join(dir, timerUnitName(kind, name))),
    unlinkQuiet(taskStampPath(kind, name)),
  ])
  // Best-effort: not failed / already gone is exactly the goal state.
  await executor.exec(SYSTEMCTL, ['reset-failed', serviceUnitName(kind, name)]).catch(() => undefined)
  await executor.exec(SYSTEMCTL, ['reset-failed', timerUnitName(kind, name)]).catch(() => undefined)
  await runSystemctl(executor, ['daemon-reload'])
}

/** The `stamp-` prefix systemd gives every Persistent timer's stamp file. */
const STAMP_FILE_PREFIX = 'stamp-'

/**
 * What the stamp sweep needs from a unit store: just its unit-name prefix.
 * The task stores pass their full {@link TaskUnitKind} descriptors (which
 * satisfy this structurally); the replication and snapshot-schedule stores,
 * which have no task-kind descriptor, pass their exported prefix constant.
 */
export interface TaskStampSource {
  /** Unit-name prefix, e.g. `anas-backup-` / `anas-repl-`. MUST be disjoint from every other source's. */
  prefix: string
}

/**
 * This process's start time — the default {@link startedAt}: stamps at or
 * after it are skipped, never swept. `uptime()` is measured from the real
 * process start, so this is exact no matter when the module loads.
 */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000

/**
 * The `.service` file NAMES in a unit dir, as a set — the unit stores' own
 * definition of "this task exists" ({@link listServiceUnits} reads the same
 * way). A not-listed service means the task is gone.
 *
 * Deliberately NOT {@link listServiceUnits} itself: that helper fails open to
 * [] on ANY error, which here would read "every task is gone" and WIDEN the
 * delete (review N2). An unreadable unit dir is not evidence of absence — so
 * only ENOENT (no unit dir at all: nothing exists) is quiet, and any other
 * read error throws to the boot caller, which logs it and starts anyway.
 */
async function listServiceUnitNames(unitDir: string): Promise<Set<string>> {
  let files: string[]
  try {
    files = await readdir(unitDir)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return new Set()
    throw err
  }
  return new Set(files.filter(f => f.endsWith('.service')))
}

/**
 * Sweep the stamp files of tasks that NO LONGER EXIST (SCHEDULES-GT-18): a
 * removed task used to leave its Persistent stamp behind, and re-creating a
 * task under that name inherited the stale last-trigger and fired at once
 * (SCHEDULES-GT-17). Every store's removal deletes its stamp now — the task
 * stores since 63532c8, the replication and snapshot-schedule stores since
 * this fix — and this sweep, one pass at daemon start, clears the orphans
 * already on a node (GT-18 counted 30-odd, the oldest from July). Runs in the
 * boot path next to the stale-probe sweep, and never in a mutation: at start
 * this process has no removal of its own in flight.
 *
 * Scope is tight, all four ways. (1) Only stamps whose timer name sits under
 * one of `sources`' prefixes are considered — the caller passes the unit
 * stores' own constants (task kinds and the bare prefix constants), never a
 * hard-coded list, so a store added later is swept the day it is passed and a
 * foreign `stamp-*.timer` (systemd ships some, other software may too) is
 * never touched. (2) A stamp FRESHER than the process start is skipped
 * (review R1): the sweep reads the dir listing and unlinks a beat later, and
 * a task created in that window writes its stamp at `enable --now` — deleting
 * it would hand a fresh task the immediate-fire it exists to prevent. (3) A
 * stamp whose task STILL EXISTS is the missed-run heal — `Persistent=true`
 * firing a catch-up run across a reboot is the point — so it is kept. The
 * existence test is the store's own: the task's `.service` unit lists in the
 * unit dir (review R3). A timer-only remnant of a half-removal is therefore
 * swept (its service is gone, the stamp can only fire a service systemd
 * cannot find) and a service-only remnant is kept (its task still runs).
 *
 * Returns the swept file names (the caller logs one line each). A missing
 * stamp dir is quiet (no stamps, nothing to sweep); an unreadable one THROWS —
 * the boot caller logs it and starts anyway, and per N2 an unreadable UNIT dir
 * throws too rather than reading as an empty store. One stubborn file is left
 * for the next boot rather than stopping the sweep.
 */
export async function sweepOrphanTaskStamps(
  sources: readonly TaskStampSource[],
  unitDir: string = DEFAULT_SYSTEMD_DIR,
  stampDir: string = systemdTimersStampDir(),
  startedAt: number = PROCESS_START_MS,
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(stampDir)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return []
    throw err
  }
  const services = await listServiceUnitNames(unitDir)
  const swept: string[] = []
  for (const file of entries) {
    if (!file.startsWith(STAMP_FILE_PREFIX) || !file.endsWith('.timer'))
      continue
    const unit = file.slice(STAMP_FILE_PREFIX.length, -'.timer'.length)
    if (!sources.some(source => unit.startsWith(source.prefix)))
      continue
    // Fresh stamp — possibly a create in flight; never ours to delete.
    try {
      if ((await stat(join(stampDir, file))).mtimeMs >= startedAt)
        continue
    }
    catch {
      // Vanished under us, or unreadable — either way not provably an orphan.
      continue
    }
    if (services.has(`${unit}.service`))
      continue
    try {
      await unlink(join(stampDir, file))
      swept.push(file)
    }
    catch {
      // Left for the next boot — one stubborn stamp must not stop the sweep.
    }
  }
  return swept
}

/**
 * Validate a schedule with `systemd-analyze calendar <expr>` — systemd is the
 * authority on OnCalendar syntax. Returns its stderr on failure so the caller
 * can 400 with it. Kind-independent: an OnCalendar expression is an OnCalendar
 * expression.
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

/** A task's schedule as the unit stores it: a raw expression, or a cadence. */
export interface ScheduledTask {
  /** The raw `OnCalendar=` expression (what a pre-cadence task carries). */
  schedule: string
  /** The structured cadence, when the task has one — then it is authoritative. */
  cadence?: TaskCadence
}

/**
 * The OnCalendar expression a task's timer actually gets. A structured cadence
 * GENERATES it (the cadence is authoritative — a hand-edited unit can never make
 * the timer disagree with the cadence it claims); a raw-schedule task keeps the
 * expression it was given verbatim. Note a BIWEEKLY cadence generates a WEEKLY
 * expression on purpose: systemd fires every week and the parity gate skips the
 * off ones (see backup-cadence.ts).
 */
export function effectiveSchedule(task: ScheduledTask): string {
  return (task.cadence ? cadenceToOnCalendar(task.cadence) : null) ?? task.schedule
}

// --- Status derivation ------------------------------------------------------
//
// The `systemctl show` parsing, systemd's timestamp forms, and the base
// ActiveState/Result → run-result map are the SHARED helpers in
// systemd-status.ts (one implementation across replication / backup / snapshot
// schedules / cloud). This layer adds the one thing those cannot know: a run
// that exited with the runner's deliberate-skip code.

/** A run's outcome: systemd's map plus the runners' deliberate skip. */
export type TaskRunResult = SystemdRunResult | 'skipped'

/**
 * Map a service's systemd state to a task run result — the shared oneshot map
 * plus the deliberate-skip code every ANAS task runner uses (75, EX_TEMPFAIL).
 * The unit declares that code as `SuccessExitStatus=`, so systemd reports
 * success (correctly — nothing went wrong) and `ExecMainStatus` is what
 * distinguishes "skipped on purpose" from "ran". No journal read, no second
 * state source.
 *
 * `enabled` is passed through to the shared map so a DISABLED task whose run
 * history systemd has garbage-collected reads `disabled` rather than the
 * default-valued `Result=success` (live-proof F9). A disabled unit that DID run
 * recently enough to still be loaded keeps its real result, skip code included.
 */
export function deriveTaskRunResult(
  props: Record<string, string>,
  ctx: { enabled?: boolean } = {},
): TaskRunResult {
  const base = deriveSystemdRunResult(props, ctx)
  if (base === 'success' && props.ExecMainStatus === String(BACKUP_SKIP_EXIT_CODE))
    return 'skipped'
  return base
}

/** The minimum a status derivation needs to know about a task. */
export interface TaskStatusSubject extends ScheduledTask {
  name: string
  enabled: boolean
}

export interface TaskStatus {
  lastRunResult: TaskRunResult
  lastRunAt: string | null
  nextRunAt: string | null
  overdue: boolean
  /**
   * When the task last completed real work (ISO), or null when there is no
   * record. Cheap when the last run itself succeeded; otherwise read from the
   * journal, and only for a cadence whose period makes staleness meaningful.
   */
  lastSuccessAt: string | null
  /**
   * Is the unit's service in a still-running state RIGHT NOW? Free — the same
   * `systemctl show` snapshot {@link deriveTaskStatus} already read (the
   * shared supervision's {@link isRunActive} on it). The status routes use it
   * to decide whether a running direct job's progress text belongs on the
   * payload (rclone.3 human-pass finding 2).
   */
  runActive: boolean
}

/**
 * Derive one task's LOCAL-ONLY status from persistent systemd state: the
 * service's last result + last-run time, and the timer's next elapse. Fail-open
 * to unknown/nulls per source.
 *
 * Overdue is CADENCE-AWARE (16.10): the timer-never-caught-up rule still applies
 * to every task, and a task with a structured cadence is additionally overdue
 * once a full period has passed with no successful run — measured against the
 * cadence's own period, so a biweekly off-week skip (a healthy no-op on a weekly
 * timer) never reads as overdue. `now` is injectable so tests need no wall clock.
 */
export async function deriveTaskStatus(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  task: TaskStatusSubject,
  now: number = Date.now(),
): Promise<TaskStatus> {
  const [serviceProps, nextRaw] = await Promise.all([
    showService(kind, executor, task.name),
    showTimerNext(kind, executor, task.name),
  ])

  const lastRunResult = deriveTaskRunResult(serviceProps, { enabled: task.enabled })
  const lastRunAt = parseSystemdTimestamp(serviceProps.ExecMainExitTimestamp)
    ?? parseSystemdTimestamp(serviceProps.InactiveEnterTimestamp)
  const nextRunAt = parseSystemdTimestamp(nextRaw)

  // A successful last run IS the last success — systemd already told us when.
  // Only when it wasn't (a skip, a failure, nothing yet) do we pay for a journal
  // read, and only when a cadence period makes the answer matter at all.
  let lastSuccessAt = lastRunResult === 'success' ? lastRunAt : null
  if (lastSuccessAt === null && overdueWindowMs(task.cadence) !== undefined)
    lastSuccessAt = await readLastSuccessAt(kind, executor, task.name)

  const overdue = isTaskOverdue({
    enabled: task.enabled,
    cadence: task.cadence,
    nextRunAt,
    lastSuccessAt,
    now,
  })

  return { lastRunResult, lastRunAt, nextRunAt, overdue, lastSuccessAt, runActive: isRunActive(serviceProps) }
}

async function showService(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
): Promise<Record<string, string>> {
  try {
    const r = await executor.exec(SYSTEMCTL, [
      'show',
      serviceUnitName(kind, name),
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

async function showTimerNext(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
): Promise<string | undefined> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['show', timerUnitName(kind, name), '-p', 'NextElapseUSecRealtime'])
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
export async function readRecentJournal(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
): Promise<string> {
  try {
    const r = await executor.exec(JOURNALCTL, [
      '-u',
      serviceUnitName(kind, name),
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

// --- Cadence gate inputs: last success + who triggered this run (16.10) ------

/** journalctl `short-iso` stamps its zone as `+0000`; Date.parse wants `+00:00`. */
function parseJournalTimestamp(line: string): string | null {
  const stamp = line.split(' ')[0]
  if (!stamp)
    return null
  const ms = Date.parse(stamp.replace(JOURNAL_TZ_RE, '$1:$2'))
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * When the task last completed REAL work, from the unit's own journal — the only
 * local record of a success that an off-week skip or a later failure has since
 * overwritten in systemd's last-result. Every ANAS task runner prints its result
 * JSON on completion, so the newest line whose result is `success` is the answer.
 *
 * LOCAL-ONLY by operator ruling: ANAS never asks a remote (a PBS server, a cloud
 * remote) when it last received data. The journal rotates, so null genuinely
 * means "no record" — and every caller treats that as "fail toward running / do
 * not cry overdue", never as evidence of a missed run. Fail-open to null.
 */
export async function readLastSuccessAt(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
): Promise<string | null> {
  const journal = await readRecentJournal(kind, executor, name)
  if (!journal)
    return null
  const lines = journal.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = messageFromJournalLine(lines[i])
    if (!msg.startsWith('{'))
      continue
    try {
      const obj = JSON.parse(msg) as { result?: TaskHelperResult }
      if (obj?.result?.status === 'success')
        return parseJournalTimestamp(lines[i])
    }
    catch {
      // Not the JSON result line — keep scanning.
    }
  }
  return null
}

/**
 * Which trigger started the run currently executing.
 *
 * The `direct` flag on POST /run does NOT answer this: BOTH a timer fire and a
 * UI Run-Now reach the daemon as `direct:true`, because Run-Now deliberately goes
 * through the task's own unit (16.5 Fix 1) and the unit's ExecStart is the same
 * either way. systemd itself is the authority instead — a timer stamps
 * `LastTriggerUSec` on the TIMER when it elapses, and a `systemctl start` by hand
 * does not. So: this run was scheduled iff the timer's last trigger is not older
 * than this invocation's start.
 *
 * Unknowable (never-fired timer, unreadable props) → 'manual', which leaves the
 * gate open: a redundant run is safe, a missed one is not.
 */
export function classifyTrigger(
  timerProps: Record<string, string>,
  serviceProps: Record<string, string>,
): TaskTrigger {
  const trigger = parseSystemdTimestamp(timerProps.LastTriggerUSec)
  const started = parseSystemdTimestamp(serviceProps.InactiveExitTimestamp)
  if (!trigger || !started)
    return 'manual'
  return Date.parse(trigger) + TRIGGER_SLACK_MS >= Date.parse(started) ? 'scheduled' : 'manual'
}

/** Read the two systemd props {@link classifyTrigger} needs (fail-open to manual). */
export async function deriveTriggerSource(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
): Promise<TaskTrigger> {
  const [timerProps, serviceProps] = await Promise.all([
    showProps(executor, timerUnitName(kind, name), 'LastTriggerUSec'),
    showProps(executor, serviceUnitName(kind, name), 'InactiveExitTimestamp'),
  ])
  return classifyTrigger(timerProps, serviceProps)
}

/** `systemctl show <unit> -p <props>` → a prop map (fail-open to {}). */
async function showProps(executor: CommandExecutor, unit: string, props: string): Promise<Record<string, string>> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['show', unit, '-p', props])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return {}
    return parseShow(r.stdout)
  }
  catch {
    return {}
  }
}

/**
 * Decide whether this fire of a task should actually do its work: the pure
 * cadence decision (backup-cadence.ts — reused verbatim, cadence logic has ONE
 * home) plus the two LOCAL reads it needs: who triggered the run, and when the
 * task last succeeded. The last-success lookup is done only when the decision
 * can still turn on it (an off-week biweekly fire), so an ordinary run costs
 * nothing extra.
 *
 * The kind's `label` rides along as the decision's NOUN, so a cloud sync's skip
 * journals "last successful cloud sync" and a backup's still journals "last
 * successful backup" — one decision, each kind's own words.
 */
export async function gateRun(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  task: { name: string, cadence?: TaskCadence },
  now: Date = new Date(),
): Promise<CadenceGateDecision> {
  const label = kind.label
  // Nothing but a biweekly cadence is gated, so nothing else pays for the two
  // systemd reads the trigger check costs.
  if (!task.cadence || task.cadence.kind !== 'biweekly')
    return decideCadenceRun({ cadence: task.cadence, trigger: 'scheduled', now, lastSuccessAt: null, label })

  const trigger = await deriveTriggerSource(kind, executor, task.name)
  // Cheap pre-check: on the task's own week (or a manual run) the last-success
  // time cannot change the answer, so it is never read.
  const cheap = decideCadenceRun({ cadence: task.cadence, trigger, now, lastSuccessAt: null, label })
  if (cheap.reason !== 'no-record')
    return cheap
  return decideCadenceRun({
    cadence: task.cadence,
    trigger,
    now,
    lastSuccessAt: await readLastSuccessAt(kind, executor, task.name),
    label,
  })
}

// --- Run-Now supervision (LOCAL-ONLY: systemd + journald) --------------------
//
// A manual Run-Now starts the task's OWN systemd unit (`systemctl start`) and
// supervises it to completion, so the run lands in systemd's last-result and the
// unit journal exactly like a scheduled one — one code path, one history. The
// supervision reads only systemd (`systemctl show`) + journald; it never
// contacts whatever the task talks to (the runner INSIDE the unit is the sole
// contact). The unit's own execution POSTs `/run` with `direct:true`, which runs
// the work in the daemon and NEVER re-enters systemctl — the recursion guard.

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

/** The fields every task runner's result JSON carries. Each kind adds its own. */
export interface TaskHelperResult {
  status?: string
  reason?: string
}

/**
 * A supervised run's KIND-INDEPENDENT outcome. The store maps it to its own
 * result shape: `helper` is the runner's result JSON exactly as the journal
 * carried it, so per-kind stats need no second parse and no callback here.
 */
export interface SupervisedRun<H extends TaskHelperResult = TaskHelperResult> {
  /** 'success' | 'skipped' (deliberate no-op) | 'running' (hit the ceiling). */
  status: 'success' | 'skipped' | 'running'
  /** True when the service was ALREADY running when Run-Now fired (no fresh start). */
  alreadyRunning: boolean
  /** Set ONLY on the ceiling: why we stopped watching (the run continues). */
  reason?: string
  /** The runner's own result JSON from the journal (null when there is none). */
  helper: H | null
}

/** Is a `systemctl show` snapshot in a still-running state? */
export function isRunActive(props: Record<string, string>): boolean {
  return RUN_ACTIVE_STATES.has(props.ActiveState ?? '')
}

/** The answer {@link readRunActive} gives the Run-Now doors. */
export interface RunActiveState {
  /** The unit's service is in a still-running state. */
  active: boolean
  /**
   * When the current invocation started (ISO), or null when systemd could not
   * say. Meaningful only when {@link RunActiveState.active} — a terminal run's
   * InactiveExitTimestamp is when it ENDED.
   */
  since: string | null
}

/**
 * Is this task's run executing right now, and since when? The one read the
 * Run-Now doors make BEFORE submitting the supervising job (rclone.3
 * human-pass finding 1): an already-running unit gets a 409 that names the run
 * instead of a second supervisor attaching to it. One `systemctl show` of the
 * two props the answer needs, fail-open to not-running — a systemd hiccup must
 * not wedge the button (and a redundant run was safe before this gate; it
 * still is, the supervision keeps its attach behaviour for the timer race).
 */
export async function readRunActive(
  executor: CommandExecutor,
  kind: TaskUnitKind,
  name: string,
): Promise<RunActiveState> {
  const props = await showProps(executor, serviceUnitName(kind, name), 'ActiveState,InactiveExitTimestamp')
  const active = isRunActive(props)
  return { active, since: active ? parseSystemdTimestamp(props.InactiveExitTimestamp) : null }
}

/**
 * The in-flight DIRECT run job for a task — the unit's own execution, whose
 * `updateProgress` carries the tool's live stats text (rclone's "copy: … of …
 * bytes, …, ETA …"). ONE lookup for the status routes (the payload's
 * `runningProgress`) and the Run-Now 409 (which quotes it, so the operator
 * sees what the running run is doing at the door). `undefined` when the queue
 * holds no such job — a supervised Run-Now or a timer fire already ended, the
 * daemon restarted (the queue is in-process state), or the run is being
 * supervised but has not reached the tool.
 *
 * `withParams` on {@link JobQueue.findActive} does the filtering: `direct` is
 * the recursion-guard flag the runner POSTs and a UI Run-Now omits, so it is
 * exactly what separates the job that does the work from the job that watches.
 */
export function runningDirectJob(
  jobQueue: JobQueue,
  operation: string,
  name: string,
): Job | undefined {
  return jobQueue.findActive(operation, name, 'task', { direct: true })
}

/** The running direct job's progress text, or null (no job, or nothing yet). */
export function runningDirectJobProgress(
  jobQueue: JobQueue,
  operation: string,
  name: string,
): string | null {
  const progress = runningDirectJob(jobQueue, operation, name)?.progress
  return typeof progress === 'string' && progress.length > 0 ? progress : null
}

/**
 * The Run-Now refusal for a run already in flight (rclone.3 human-pass finding
 * 1): it names the run and when it started, and says what continues it — the
 * supervising job that a second click would have submitted adds nothing. When
 * the task's own direct run is executing, its live progress rides after an
 * em-dash, so the refusal answers "it IS doing something" at the door.
 */
export function runningRunConflictMessage(
  kind: TaskUnitKind,
  name: string,
  run: RunActiveState,
  progress?: string | null,
): string {
  const since = run.since ? ` since ${run.since}` : ''
  const suffix = progress ? ` — ${progress}` : ''
  return `${kind.title} task '${name}' is already running${since}; `
    + `it continues under systemd — wait for it to finish${suffix}`
}

/**
 * Did a TERMINAL run fail? A oneshot's failure shows as ActiveState=failed, or a
 * non-success Result, or a non-zero ExecMainStatus (NOTES §7 confirms these
 * props). A benign no-op that exits 0 → NOT a failure here (Result=success), and
 * neither is the runner's deliberate-skip code, which the unit declares as
 * `SuccessExitStatus=` — a Run-Now that lands on an in-flight off-week fire must
 * report a skip, not a failure.
 */
export function runFailed(props: Record<string, string>): boolean {
  if (props.ActiveState === 'failed')
    return true
  if (props.Result && props.Result !== 'success')
    return true
  if (props.ExecMainStatus === String(BACKUP_SKIP_EXIT_CODE))
    return false
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
 * Recover the runner's result JSON from the unit journal — every ANAS task
 * runner prints `{ task, result }` to stdout on completion, so the skip
 * classification (and the per-kind stats) survive into the manual supervisor.
 * Returns null when no result line is present (e.g. a failure, which logs
 * stderr). The caller names the shape it expects; this only finds the line.
 */
export function parseHelperResult<H extends TaskHelperResult = TaskHelperResult>(journal: string): H | null {
  const lines = journal.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = messageFromJournalLine(lines[i])
    if (!msg.startsWith('{'))
      continue
    try {
      const obj = JSON.parse(msg) as { result?: H }
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
 * systemd's OWN lines about one of this kind's services — anything that names
 * `<prefix><task>.service`. systemd writes them in two shapes and BOTH are
 * boilerplate: the trailer it prefixes with the unit
 * (`anas-cloud-x.service: Failed with result 'exit-code'.`) and the sentence it
 * puts the unit INSIDE (`Failed to start anas-cloud-x.service - ANAS cloud sync
 * task x.`). Matching only the first shape let the second one win the failure
 * detail, so a guard refusal — whose own sentence says nothing about "failing"
 * — reached the operator as "Failed to start anas-cloud-x.service", the bare
 * failure DESIGN forbids (live proof rclone.2 slice 3). The unit's own output
 * is always the better answer; systemd is only the supervisor.
 */
const UNIT_LINE_RE_CACHE = new Map<string, RegExp>()
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g
function unitLineRegex(prefix: string): RegExp {
  let re = UNIT_LINE_RE_CACHE.get(prefix)
  if (!re) {
    re = new RegExp(`${prefix.replace(REGEX_METACHARS, '\\$&')}\\S*\\.service`)
    UNIT_LINE_RE_CACHE.set(prefix, re)
  }
  return re
}

/**
 * The client-safe failure detail from the unit journal: prefer the command's
 * verbatim `Error:` line (or one of the kind's own cause hints), then a
 * failure-ish line, and finally the last line the UNIT itself printed. systemd's
 * own lines about the unit are skipped at every step — they say a run failed,
 * never why. Never contains a secret (the tools ANAS runs keep credentials off
 * stderr, and secrets never reach an argv).
 */
export function failureDetailFromJournal(kind: TaskUnitKind, journal: string): string | null {
  const msgs = journal.split('\n').map(messageFromJournalLine).filter(Boolean)
  const hints = kind.causeHints ?? []
  // Prefer the command's / the runner's own verbatim `Error:` line (the real
  // cause) over systemd's generic "Failed with result …" trailer.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].startsWith('Error:') || hints.some(re => re.test(msgs[i])))
      return msgs[i]
  }
  // Next, any failure-ish line that is NOT systemd's boilerplate.
  const boilerplate = unitLineRegex(kind.prefix)
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (FAILED_MSG_RE.test(msgs[i]) && !boilerplate.test(msgs[i]))
      return msgs[i]
  }
  // Last resort: the last message line that is neither the result JSON nor
  // systemd's own boilerplate — i.e. the last thing the UNIT itself said. A
  // refusal sentence carries no "failed" anywhere in it, so this is the branch
  // every guard refusal lands in.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].startsWith('{') && !boilerplate.test(msgs[i]))
      return msgs[i]
  }
  return null
}

/** `systemctl show` the run props supervision keys on (fail-open to {}). */
async function showRunProps(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
): Promise<Record<string, string>> {
  try {
    const r = await executor.exec(SYSTEMCTL, [
      'show',
      serviceUnitName(kind, name),
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
 * shows why); returns success/skipped otherwise, carrying the runner's result
 * JSON for the store to map.
 */
async function classifyTerminalRun<H extends TaskHelperResult>(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
  props: Record<string, string>,
  alreadyRunning: boolean,
): Promise<SupervisedRun<H>> {
  const journal = await readRecentJournal(kind, executor, name)
  if (runFailed(props)) {
    throw new Error(
      failureDetailFromJournal(kind, journal) ?? `${kind.label} task '${name}' failed (see the recent journal)`,
    )
  }
  const helper = parseHelperResult<H>(journal)
  // Both skip flavours report as 'skipped' to the caller — a benign collision and
  // a gated off-week fire (which a Run-Now can only meet by landing on one
  // already in flight). The runner's own `reason` says which.
  const skipped = helper?.status === 'skipped' || helper?.status === BACKUP_SKIPPED_OFF_WEEK
  return { status: skipped ? 'skipped' : 'success', alreadyRunning, helper }
}

/**
 * Run a task NOW through its own systemd unit and supervise to completion. Starts
 * the service with `systemctl start --no-block` (so we own the timeout ceiling,
 * never hanging on a long run) then polls `systemctl show` until the run we care
 * about goes terminal, and reads the unit journal for the result detail.
 *
 * - A DISABLED task runs fine: `systemctl start` acts on the service regardless
 *   of the timer's enabled state (a manual run of a disabled task is legitimate).
 * - ALREADY RUNNING: we do NOT queue a second run — we supervise the in-flight
 *   one and flag `alreadyRunning` so the caller can say so plainly.
 * - CEILING: on timeout we report `status:'running'` truthfully (NOT a failure) —
 *   systemd carries the run on; the operator checks back later.
 * - FAILURE: throws (so the job fails) with the journal's client-safe error line.
 */
export async function superviseTaskRun<H extends TaskHelperResult = TaskHelperResult>(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  name: string,
  opts: SuperviseRunOptions = {},
): Promise<SupervisedRun<H>> {
  const pollIntervalMs = opts.pollIntervalMs ?? SUPERVISE_POLL_MS
  const timeoutMs = opts.timeoutMs ?? SUPERVISE_TIMEOUT_MS
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const progress = opts.onProgress ?? (() => {})
  const service = serviceUnitName(kind, name)

  // Pre-check: capture the current invocation + running state. If it is already
  // running, supervise THAT run rather than starting a second one.
  const pre = await showRunProps(kind, executor, name)
  const baseInvocation = pre.InvocationID ?? ''
  const alreadyRunning = isRunActive(pre)

  if (alreadyRunning) {
    progress(`${kind.label} task '${name}' is already running — waiting for it to finish`)
  }
  else {
    const started = await executor.exec(SYSTEMCTL, ['start', '--no-block', service])
    if (started.exitCode !== 0)
      throw new Error(started.stderr.trim() || `systemctl start ${service} exited with code ${started.exitCode}`)
    progress(`started ${kind.label} task '${name}'`)
  }

  const deadline = now() + timeoutMs
  let seenActive = alreadyRunning
  while (now() < deadline) {
    await sleep(pollIntervalMs)
    const props = await showRunProps(kind, executor, name)
    const active = isRunActive(props)
    if (active)
      seenActive = true
    // A fresh invocation that came and went (a fast finish we never caught active)
    // is also terminal — so a sub-poll skip is classified correctly. An
    // absent/empty InvocationID never counts as a change (a never-run unit).
    const inv = props.InvocationID ?? ''
    const invocationChanged = inv !== '' && inv !== baseInvocation
    if (!active && (seenActive || invocationChanged))
      return classifyTerminalRun<H>(kind, executor, name, props, alreadyRunning)
  }

  // Ceiling — the run is legitimately still going. Truthful, not a failure.
  // The sentence points at the row: the task status carries the running direct
  // job's live progress now (rclone.3 human-pass finding 2), so "check the
  // task again" names where the run actually shows.
  return {
    status: 'running',
    alreadyRunning,
    reason: `still running after ${Math.round(timeoutMs / 1000)}s — systemd continues it; the task row shows its progress until it ends`,
    helper: null,
  }
}

// --- Dashboard warnings -----------------------------------------------------

/** A minimal task-status shape the dashboard warning builder needs. */
export interface TaskWarningInput {
  name: string
  enabled: boolean
  lastRunResult: TaskRunResult
  overdue: boolean
}

/**
 * Dashboard warnings for failing/overdue tasks, in the kind's own category.
 * Warns ONLY on an ENABLED task whose last run failed OR which is silently
 * overdue — a benign no-op (a 'success' oneshot result) and disabled tasks never
 * warn (the replication policy). One warning per task; the ref is the task name.
 */
export function buildTaskWarnings(kind: TaskUnitKind, inputs: TaskWarningInput[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const s of inputs) {
    if (!s.enabled)
      continue
    if (s.lastRunResult === 'failure') {
      warnings.push({
        level: 'warning',
        category: kind.warningCategory,
        message: `${kind.title} task '${s.name}' last run failed — check the ${kind.view} view`,
        ref: s.name,
      })
    }
    else if (s.overdue) {
      warnings.push({
        level: 'warning',
        category: kind.warningCategory,
        message: `${kind.title} task '${s.name}' is overdue — check the ${kind.view} view`,
        ref: s.name,
      })
    }
  }
  return warnings
}

/**
 * Collect a kind's dashboard warnings from its task store, fail-open. `readTasks`
 * is the store's own reader (each kind parses its own canonical JSON); every
 * status read after that is this module's. Mirrors how replication/mount
 * warnings are wired into GET /v1/status.
 */
export async function collectTaskWarnings(
  kind: TaskUnitKind,
  executor: CommandExecutor,
  dir: string,
  readTasks: (dir: string) => Promise<TaskStatusSubject[]>,
): Promise<DashboardWarning[]> {
  try {
    const tasks = await readTasks(dir)
    const inputs = await Promise.all(
      tasks.map(async (task): Promise<TaskWarningInput> => {
        const st = await deriveTaskStatus(kind, executor, task)
        return { name: task.name, enabled: task.enabled, lastRunResult: st.lastRunResult, overdue: st.overdue }
      }),
    )
    return buildTaskWarnings(kind, inputs)
  }
  catch {
    return []
  }
}
