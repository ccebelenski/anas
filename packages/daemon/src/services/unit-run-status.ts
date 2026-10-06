import type { CommandExecutor } from '../executor/types.js'
import type { RunResultContext, SystemdRunResult } from './systemd-status.js'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
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
 *
 * **A unit's journal starts when its unit file was created.** journald keys
 * history by unit NAME, so a task or schedule deleted and re-created under the
 * same name would otherwise inherit its predecessor's result lines (the timer
 * stamp is unlinked with the unit, the journal is not). Every journal read here
 * is bounded by the service unit file's BIRTH time ({@link readUnitFileBirth}):
 * the stores rewrite a unit in place (`writeFile` truncates the same inode), so
 * an edit keeps the birth time and the unit's history, while a delete + create
 * is a new file with a new birth time and starts clean.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'
/**
 * Where the stores write their units — the same default and override every
 * store's `DEFAULT_SYSTEMD_DIR` and the server's `systemdDir` use.
 */
const UNIT_FILE_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'
/** How many recent journald lines a journal read returns (the detail views show them verbatim). */
export const JOURNAL_TAIL = 200
/** The service properties a status derivation reads — the ONE list. */
export const SERVICE_STATUS_PROPS = 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'
/**
 * The timer properties a status derivation reads, in ONE `systemctl show`:
 * the next elapse for the row, and the last trigger the journal rung's guard
 * and the timer rung need — so a row never pays a second timer read.
 */
export const TIMER_STATUS_PROPS = 'NextElapseUSecRealtime,LastTriggerUSec'
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

/**
 * The instant a unit file came into being, in epoch ms: its birth time, or
 * its ctime on a filesystem that reports none (`birthtimeMs` 0). ext4, tmpfs
 * and OpenZFS 2.2+ all report a birth time, and an in-place rewrite keeps it;
 * only on a filesystem without one does an edit move the bound (to the edit),
 * which hides the pre-edit verdict until the next run rather than showing a
 * predecessor's.
 */
export function unitFileBirthMs(st: { birthtimeMs: number, ctimeMs: number }): number {
  return st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs
}

/** {@link unitFileBirthMs} of `<unitDir>/<unit>` (fail-open to null — no bound). */
export async function readUnitFileBirth(unit: string, unitDir: string = UNIT_FILE_DIR): Promise<number | null> {
  try {
    return unitFileBirthMs(await stat(join(unitDir, unit)))
  }
  catch {
    return null
  }
}

/**
 * The bounded recent journald tail of a service unit, `short-iso`, as a raw
 * text blob (labeled recent-only forensics — it rotates, older history simply
 * ages out), from the unit file's birth on (`--since @<s>`, see the module
 * note — a re-created unit never shows its predecessor's lines). Fail-open to
 * '' so a journald hiccup never breaks a view; an unreadable unit file reads
 * unbounded.
 */
export async function readUnitJournal(
  executor: CommandExecutor,
  unit: string,
  unitDir: string = UNIT_FILE_DIR,
): Promise<string> {
  try {
    const birth = await readUnitFileBirth(unit, unitDir)
    const since = birth === null ? [] : ['--since', `@${Math.floor(birth / 1000)}`]
    const r = await executor.exec(JOURNALCTL, ['-u', unit, ...since, '-n', String(JOURNAL_TAIL), '-o', 'short-iso', '--no-pager'])
    return r.exitCode === 0 ? r.stdout.trim() : ''
  }
  catch {
    return ''
  }
}

/**
 * A read made at most once: the first call starts it, every later call shares
 * the same promise. One status derivation hands this around so its rungs and a
 * kind's last-success lookup read the unit journal ONCE between them.
 */
export function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= read())
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
 * THE journal result-line scanner — every reader of a runner's result line
 * goes through it ({@link parseHelperResult}, {@link lastRunFromJournal},
 * {@link lastSuccessFromJournal}). Every ANAS runner prints
 * `{ "<task|schedule>": …, "result": { … } }` to stdout when a job ENDS; this
 * yields those lines newest-first with the line's own timestamp. A line whose
 * message is not JSON, or JSON without an object `result`, is skipped.
 */
function* resultLinesNewestFirst(journal: string): Generator<{ result: TaskHelperResult, at: string | null }> {
  if (!journal)
    return
  const lines = journal.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = messageFromJournalLine(lines[i])
    if (!msg.startsWith('{'))
      continue
    let obj: { result?: unknown } | null
    try {
      obj = JSON.parse(msg) as { result?: unknown } | null
    }
    catch {
      continue // Not the JSON result line — keep scanning.
    }
    if (obj && typeof obj === 'object' && obj.result && typeof obj.result === 'object')
      yield { result: obj.result as TaskHelperResult, at: parseJournalTimestamp(lines[i]) }
  }
}

/**
 * Recover the runner's result JSON from the unit journal, so the skip
 * classification (and the per-kind stats) survive into the manual supervisor.
 * Returns null when no result line is present (e.g. a failure, which logs
 * stderr). The caller names the shape it expects; this only finds the line.
 */
export function parseHelperResult<H extends TaskHelperResult = TaskHelperResult>(journal: string): H | null {
  const newest = resultLinesNewestFirst(journal).next()
  return newest.done ? null : newest.value.result as H
}

/** The newest runner result line in a journal tail: its run result, reason and timestamp. */
export interface JournalRunResult {
  status: UnitRunResult
  at: string | null
  reason?: string
}

/**
 * Map a runner's printed `result.status` to a run result — the ONE rule every
 * result-line reader applies. Every ANAS runner prints its result line only
 * for a job that ENDED (completed or cancelled); the snapshot and replication
 * runners print a job result that carries no `status` at all — so an absent
 * status is a completed run, a success.
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
 * The NEWEST runner result line of ANY status in a unit's journal tail, with
 * the line's own timestamp ({@link lastSuccessFromJournal} asks the narrower
 * question: the newest SUCCESS).
 */
export function lastRunFromJournal(journal: string): JournalRunResult | null {
  const newest = resultLinesNewestFirst(journal).next()
  if (newest.done)
    return null
  const { result, at } = newest.value
  return {
    status: runResultFromHelperStatus(result.status),
    at,
    ...(typeof result.reason === 'string' && result.reason ? { reason: result.reason } : {}),
  }
}

/**
 * When the newest SUCCESSFUL run's result line was printed — past any newer
 * skip, failure or cancel — or null when the tail holds none. Same scanner and
 * same status rule as {@link lastRunFromJournal} (an absent status counts as
 * a success).
 */
export function lastSuccessFromJournal(journal: string): string | null {
  for (const { result, at } of resultLinesNewestFirst(journal)) {
    if (runResultFromHelperStatus(result.status) === 'success')
      return at
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

/** What {@link deriveLastRun} reads. The journal is read only when a rung needs it. */
export interface LastRunSources {
  /** The service's {@link SERVICE_STATUS_PROPS} snapshot. */
  serviceProps: Record<string, string>
  /** The kind's own result over `serviceProps` (the systemd map, or the task map with skip/cancel). */
  liveResult: UnitRunResult
  /** The unit's recent journal tail (`short-iso`), fail-open to ''. */
  readJournal: () => Promise<string>
  /** The TIMER's raw `LastTriggerUSec` (from the same show as the next elapse), or undefined. */
  lastTriggerRaw: string | undefined
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
 * 4. **Nothing anywhere** → the kind's own result (never-run, unknown) with
 *    no time.
 *
 * A DISABLED unit with no live record answers `disabled` before rungs 2-3 are
 * consulted (the pre-taskstatus.1 presentation, F9): the row's enabled column
 * already says why there is no fresh verdict, and the detail carries the
 * history note.
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

  if (src.liveResult === 'disabled')
    return { lastRunResult: 'disabled', lastRunAt: null, source: 'none' }

  const fromJournal = lastRunFromJournal(await src.readJournal())
  const trigger = parseSystemdTimestamp(src.lastTriggerRaw)

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
   * the detail views and the task kinds' last-success lookup pass theirs
   * (a {@link readOnce}) so the unit is read once per row. Default: a fresh
   * {@link readUnitJournal} of the service, made only if a rung needs it.
   */
  readJournal?: () => Promise<string>
}

/**
 * Read and derive one unit's run status: the service snapshot and the timer's
 * {@link TIMER_STATUS_PROPS} in parallel (two `systemctl show`s per row, as
 * before taskstatus.1), then {@link deriveLastRun}, which reads the journal
 * only when no live record answers. The one entry point backup, cloud sync,
 * replication and snapshot schedules call.
 */
export async function deriveUnitRunStatus(
  executor: CommandExecutor,
  opts: UnitRunStatusOptions,
): Promise<UnitRunStatus> {
  const [serviceProps, timerProps] = await Promise.all([
    readServiceStatusProps(executor, opts.serviceUnit),
    showUnitProps(executor, opts.timerUnit, TIMER_STATUS_PROPS),
  ])
  const mapLive = opts.mapLive ?? deriveRunResult
  const last = await deriveLastRun({
    serviceProps,
    liveResult: mapLive(serviceProps, { enabled: opts.enabled }),
    readJournal: opts.readJournal ?? (() => readUnitJournal(executor, opts.serviceUnit)),
    lastTriggerRaw: timerProps.LastTriggerUSec,
  })
  return {
    ...last,
    nextRunAt: parseSystemdTimestamp(timerProps.NextElapseUSecRealtime),
    runActive: isRunActive(serviceProps),
    serviceProps,
  }
}
