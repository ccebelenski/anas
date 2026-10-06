import type { CommandExecutor } from '../executor/types.js'
import type { RunResultContext, SystemdRunResult } from './systemd-status.js'
import { BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { deriveRunResult, hasRetainedRunHistory, parseShow, parseSystemdTimestamp } from './systemd-status.js'

/**
 * A scheduled unit's RUN STATUS — last run, verdict, next run, running — for
 * every units-as-store kind: backup and cloud sync (task-units.ts), snapshot
 * schedules (snapshot-schedule-units.ts) and replication (replication-units.ts).
 *
 * taskstatus.1: each store used to carry its own copy of the `systemctl show`
 * property list, the exit-then-inactive timestamp fallback and the result map,
 * so a reboot (systemd keeps no service runtime property across a boot) made
 * every row read "never run" in four places at once. Everything that derivation
 * needs lives HERE once: the property lists, the reads, the journal result-line
 * parse, the precedence (live props → journal result line → timer
 * `LastTriggerUSec` → never), the cancelled-reason note and running detection.
 * A store passes its unit names and, where its vocabulary differs, its own
 * live-result map; what is genuinely per kind (a task's cadence-aware overdue,
 * a schedule's exit code, replication's ZFS lag) stays in the store, on top.
 *
 * Every read fails OPEN, so one unreadable source never blanks a row. Nothing
 * is persisted (stateless — systemd and journald are the record).
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'
/** How many recent journald lines a journal read returns (the detail views show them verbatim). */
export const JOURNAL_TAIL = 200
/** The service properties a status derivation reads — the ONE list. */
export const SERVICE_STATUS_PROPS = 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'
/**
 * Slack between two systemd/journald instants printed at 1-second resolution
 * (a timer trigger vs a run's start or its result line); 5s covers the
 * granularity without spanning anything real.
 */
export const TRIGGER_SLACK_MS = 5000
/** ActiveState values that mean the oneshot service is still running. */
const RUN_ACTIVE_STATES = new Set(['activating', 'active', 'reloading'])
/** journalctl `short-iso` numeric zone (`+0000`) → the ISO form Date.parse wants. */
const JOURNAL_TZ_RE = /([+-]\d{2})(\d{2})$/
/** journalctl syslog prefix without a `[pid]` bracket: `<ts> <host> <ident>: <msg>`. */
const JOURNAL_PREFIX_RE = /^\S+\s+\S+\s+\S+?:\s(.*)$/

/**
 * A run's outcome in the widest vocabulary any kind uses: the systemd map plus
 * `skipped` (a deliberate off-week no-op) and `cancelled` (rclone.5). Replication
 * and snapshot schedules carry the narrower {@link SystemdRunResult}
 * (see {@link toSystemdRunResult}).
 */
export type UnitRunResult = SystemdRunResult | 'skipped' | 'cancelled'

/** The runner's result JSON as far as the status derivation reads it. */
export interface TaskHelperResult {
  status?: string
  reason?: string
}

// --- Reads -------------------------------------------------------------------

/** `systemctl show <unit> -p <props>` → a prop map (fail-open to {}). */
export async function showUnitProps(executor: CommandExecutor, unit: string, props: string): Promise<Record<string, string>> {
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

/** The service's {@link SERVICE_STATUS_PROPS} snapshot (fail-open to {}). */
export function readServiceStatusProps(executor: CommandExecutor, serviceUnit: string): Promise<Record<string, string>> {
  return showUnitProps(executor, serviceUnit, SERVICE_STATUS_PROPS)
}

/** The timer's raw `NextElapseUSecRealtime` (fail-open to undefined). */
export async function readTimerNextRaw(executor: CommandExecutor, timerUnit: string): Promise<string | undefined> {
  return (await showUnitProps(executor, timerUnit, 'NextElapseUSecRealtime')).NextElapseUSecRealtime
}

/** The timer's raw `LastTriggerUSec` — persistent across a boot via the stamp file (fail-open to undefined). */
export async function readTimerLastTrigger(executor: CommandExecutor, timerUnit: string): Promise<string | undefined> {
  return (await showUnitProps(executor, timerUnit, 'LastTriggerUSec')).LastTriggerUSec
}

/**
 * The bounded recent journald tail of a service unit, `short-iso`, as a raw
 * text blob (labeled recent-only forensics — it rotates, older history simply
 * ages out). Fail-open to '' so a journald hiccup never breaks a view.
 */
export async function readUnitJournal(executor: CommandExecutor, unit: string): Promise<string> {
  try {
    const r = await executor.exec(JOURNALCTL, ['-u', unit, '-n', String(JOURNAL_TAIL), '-o', 'short-iso', '--no-pager'])
    return r.exitCode === 0 ? r.stdout.trim() : ''
  }
  catch {
    return ''
  }
}

// --- Pure parsing ------------------------------------------------------------

/** Is a `systemctl show` snapshot in a still-running state? */
export function isRunActive(props: Record<string, string>): boolean {
  return RUN_ACTIVE_STATES.has(props.ActiveState ?? '')
}

/** journalctl `short-iso` line → its timestamp as ISO, or null. */
export function parseJournalTimestamp(line: string): string | null {
  const stamp = line.split(' ')[0]
  if (!stamp)
    return null
  const ms = Date.parse(stamp.replace(JOURNAL_TZ_RE, '$1:$2'))
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
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

/** The newest runner result line in a journal tail: its run result, reason and timestamp. */
export interface JournalRunResult {
  status: UnitRunResult
  at: string | null
  reason?: string
}

/**
 * Map a runner's printed `result.status` to a run result. Every ANAS runner
 * prints its result line only for a job that ENDED (completed or cancelled);
 * the snapshot and replication runners print a job result that carries no
 * `status` at all — so an absent status is a completed run, a success.
 */
function runResultFromHelperStatus(status: unknown): UnitRunResult {
  if (status === undefined || status === null || status === 'success')
    return 'success'
  if (status === 'skipped' || status === BACKUP_SKIPPED_OFF_WEEK)
    return 'skipped'
  if (status === 'cancelled')
    return 'cancelled'
  if (status === 'failure' || status === 'failed')
    return 'failure'
  return 'unknown'
}

/**
 * The NEWEST runner result line of ANY status in a unit's journal tail —
 * `{ "<task|schedule>": …, "result": { … } }` — with the line's own timestamp.
 * (`readLastSuccessAt` asks the narrower question: the newest SUCCESS.)
 */
export function lastRunFromJournal(journal: string): JournalRunResult | null {
  if (!journal)
    return null
  const lines = journal.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = messageFromJournalLine(lines[i])
    if (!msg.startsWith('{'))
      continue
    try {
      const obj = JSON.parse(msg) as { result?: unknown }
      if (!obj || typeof obj !== 'object' || !obj.result || typeof obj.result !== 'object')
        continue
      const result = obj.result as TaskHelperResult
      return {
        status: runResultFromHelperStatus(result.status),
        at: parseJournalTimestamp(lines[i]),
        ...(typeof result.reason === 'string' && result.reason ? { reason: result.reason } : {}),
      }
    }
    catch {
      // Not the JSON result line — keep scanning.
    }
  }
  return null
}

/** The note a last run known only from the timer's stamp carries. */
export function resultNotRetainedNote(at: string): string {
  // The daemon runs TZ=UTC; minute resolution is what the grids show.
  return `ran at ${at.slice(0, 16).replace('T', ' ')} UTC; result not retained across the reboot`
}

/**
 * Narrow a {@link UnitRunResult} to the systemd vocabulary the replication and
 * snapshot-schedule rows carry. Their runners never print `skipped` or
 * `cancelled`; should a line ever say so, the row reads `unknown` rather than a
 * value its schema refuses.
 */
export function toSystemdRunResult(r: UnitRunResult): SystemdRunResult {
  return r === 'skipped' || r === 'cancelled' ? 'unknown' : r
}

// --- The derivation ----------------------------------------------------------

/** Which precedence rung answered a {@link LastRun}. */
export type LastRunSource = 'live' | 'journal' | 'timer' | 'none'

/** A unit's last run as the status rows show it. */
export interface LastRun {
  lastRunResult: UnitRunResult
  lastRunAt: string | null
  /** One line when the result needs one: a cancel's "cancelled by …", or why there is no verdict. */
  lastRunNote?: string
  source: LastRunSource
}

/** What {@link deriveLastRun} reads. The two readers run only when the rung needs them. */
export interface LastRunSources {
  /** The service's {@link SERVICE_STATUS_PROPS} snapshot. */
  serviceProps: Record<string, string>
  /** The kind's own result over `serviceProps` (the systemd map, or the task map with skip/cancel). */
  liveResult: UnitRunResult
  /** The unit's recent journal tail (`short-iso`), fail-open to ''. */
  readJournal: () => Promise<string>
  /** The TIMER's raw `LastTriggerUSec`, fail-open to undefined. */
  readLastTrigger: () => Promise<string | undefined>
}

/**
 * Does systemd hold THIS boot's record of a run? An exit/inactive timestamp,
 * or a unit running or failed right now. systemd keeps no service runtime
 * property across a boot: after a reboot every oneshot answers with empty
 * timestamps and the default-valued `Result=success`.
 */
function hasLiveRunRecord(props: Record<string, string>): boolean {
  return hasRetainedRunHistory(props) || isRunActive(props) || props.ActiveState === 'failed'
}

/**
 * A unit's last run and verdict, by precedence (taskstatus.1):
 *
 * 1. **Live service properties** (a run since boot, or one in flight) → the
 *    kind's own result, the exit (else inactive-enter) timestamp, and a
 *    cancelled run's "cancelled by …" from the runner's result line.
 * 2. **The journal's newest runner result line**, any status → its time and
 *    status (a cancel's `reason` as the note). Guarded by the timer: when the
 *    timer last fired AFTER that line was printed, the newer run printed no
 *    result (a failed run logs stderr only), so the line is not the last run
 *    and rung 3 answers instead.
 * 3. **The timer's `LastTriggerUSec`** → that time, result `unknown`, note
 *    "ran at <time>; result not retained across the reboot" — a run happened,
 *    its verdict is gone, and the row says exactly that.
 * 4. **Nothing anywhere** → the kind's own result (never-run, disabled,
 *    unknown) with no time.
 */
export async function deriveLastRun(src: LastRunSources): Promise<LastRun> {
  const props = src.serviceProps
  if (hasLiveRunRecord(props)) {
    const lastRunAt = parseSystemdTimestamp(props.ExecMainExitTimestamp)
      ?? parseSystemdTimestamp(props.InactiveEnterTimestamp)
    // A cancelled row's tooltip says who and when; the runner printed exactly
    // that sentence as its result's `reason`, so the journal is where it is.
    const note = src.liveResult === 'cancelled'
      ? parseHelperResult(await src.readJournal())?.reason
      : undefined
    return { lastRunResult: src.liveResult, lastRunAt, ...(note ? { lastRunNote: note } : {}), source: 'live' }
  }

  const [journal, triggerRaw] = await Promise.all([src.readJournal(), src.readLastTrigger()])
  const fromJournal = lastRunFromJournal(journal)
  const trigger = parseSystemdTimestamp(triggerRaw)

  if (fromJournal?.at) {
    const newerTrigger = trigger !== null && Date.parse(trigger) > Date.parse(fromJournal.at) + TRIGGER_SLACK_MS
    if (!newerTrigger) {
      const note = fromJournal.status === 'cancelled' ? fromJournal.reason : undefined
      return { lastRunResult: fromJournal.status, lastRunAt: fromJournal.at, ...(note ? { lastRunNote: note } : {}), source: 'journal' }
    }
  }
  if (trigger)
    return { lastRunResult: 'unknown', lastRunAt: trigger, lastRunNote: resultNotRetainedNote(trigger), source: 'timer' }
  return { lastRunResult: src.liveResult, lastRunAt: null, source: 'none' }
}

/** A unit's whole run status — what every kind's row is built from. */
export interface UnitRunStatus extends LastRun {
  nextRunAt: string | null
  /** The service is in a still-running state right now (same snapshot, free). */
  runActive: boolean
  /** The `systemctl show` snapshot it was derived from (kinds layer exit codes etc. on it). */
  serviceProps: Record<string, string>
}

/** How a kind hands its units to {@link deriveUnitRunStatus}. */
export interface UnitRunStatusOptions {
  serviceUnit: string
  timerUnit: string
  /** Whether the task/schedule is enabled (its timer installed) — the F9 disabled/never-run split. */
  enabled: boolean
  /** The kind's live-result map; default the shared systemd map. */
  mapLive?: (props: Record<string, string>, ctx: RunResultContext) => UnitRunResult
  /**
   * The journal read, when the caller already has (or will need) the tail —
   * the detail views pass theirs so the unit is read once. Default: a fresh
   * {@link readUnitJournal} of the service, made only if a rung needs it.
   */
  readJournal?: () => Promise<string>
}

/**
 * Read and derive one unit's run status: the service snapshot and the timer's
 * next elapse in parallel, then {@link deriveLastRun}. The one entry point
 * backup, cloud sync, replication and snapshot schedules call.
 */
export async function deriveUnitRunStatus(
  executor: CommandExecutor,
  opts: UnitRunStatusOptions,
): Promise<UnitRunStatus> {
  const [serviceProps, nextRaw] = await Promise.all([
    readServiceStatusProps(executor, opts.serviceUnit),
    readTimerNextRaw(executor, opts.timerUnit),
  ])
  const mapLive = opts.mapLive ?? deriveRunResult
  const last = await deriveLastRun({
    serviceProps,
    liveResult: mapLive(serviceProps, { enabled: opts.enabled }),
    readJournal: opts.readJournal ?? (() => readUnitJournal(executor, opts.serviceUnit)),
    readLastTrigger: () => readTimerLastTrigger(executor, opts.timerUnit),
  })
  return {
    ...last,
    nextRunAt: parseSystemdTimestamp(nextRaw),
    runActive: isRunActive(serviceProps),
    serviceProps,
  }
}
