import type { AhrPool, BackupArchiveConsistency, CloudSyncRunResult, CloudSyncTask } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { BackupSnapshotOptions, TakenSnapshot } from './backup-snapshots.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { readdir, stat } from 'node:fs/promises'
import { readAhrPools } from './ahr-topology.js'
import { deriveConsistency, readConsistencyFacts } from './backup-consistency.js'
import { snapshotRoot } from './backup-expansion.js'
import {
  destroyTransients,
  plannedTopLevel,
  sweepAhrTransients,
  sweepZfsTransients,
  takeAhrTransient,
  takeZfsTransient,
  withTopLevelMounts,
} from './backup-snapshots.js'
import { scanNestedFilesystems } from './nested-filesystems.js'
import { RCLONE, rcloneBaseArgs } from './rclone-config.js'
import { assertNoSecretValues } from './secret-argv.js'
import { formatTransientCloudSnapshot, parseTransientCloudSnapshot } from './snapshot-naming.js'
import { guardSourcePath, readSourceGuardFacts } from './source-guard.js'

/**
 * Cloud sync RUN logic (story rclone.2) — the guards, the transient snapshot,
 * the one `rclone copy|sync` invocation, its JSON-log progress and the
 * exit-code policy. The backup runner's opposite number, built from the SAME
 * parts wherever the parts are the same: the consistency derivation, the
 * transient snapshot lifecycle, the boundary scan and the argv guard are all
 * the existing shared modules, called with cloud sync's own label prefix.
 *
 * Ground truth this is built on (DESIGN "Cloud sync — rclone", 2026-09-23,
 * rclone 1.60.1 — do NOT contradict):
 *   - `--use-json-log` emits ONE JSON object per line on STDERR, and one
 *     carrying a `stats` object at every `--stats` interval with `bytes`,
 *     `totalBytes`, `transfers`, `checks`, `deletes`, `errors`, `eta`, `speed`
 *     and `fatalError`. stdout stays empty.
 *   - A `sync` from an EMPTY source deletes the whole destination. That is the
 *     catastrophe this module guards up front; `copy` never deletes and has no
 *     such guard.
 *   - Exit codes: `0` and `9` (nothing to transfer) COMPLETE. Everything else
 *     fails — including `6`, "less serious errors", which means files are
 *     missing at the destination. A missing file is a failure, not a warning.
 *   - Every credential lives in the config file rclone is pointed at, so
 *     NOTHING secret is ever built into this argv.
 */

/** rclone's "everything transferred" exit code. */
const EXIT_OK = 0
/** rclone's "nothing to transfer" exit code — a complete run that moved nothing. */
const EXIT_NOTHING_TO_TRANSFER = 9
/** "Less serious errors": some files did not make it. A FAILURE here (DESIGN). */
const EXIT_SOME_FILES_FAILED = 6

/** The stats cadence. 30s is quiet in the journal and live enough for a job. */
const STATS_INTERVAL = '30s'

/**
 * The JSON-log + stats flags every run carries. `--stats-log-level NOTICE`
 * is what makes the interval stats appear in the log at rclone's default
 * verbosity; without it the objects exist only at `-v`.
 */
export const RCLONE_LOG_ARGS = [
  '--use-json-log',
  '--stats',
  STATS_INTERVAL,
  '--stats-log-level',
  'NOTICE',
] as const

// ---------------------------------------------------------------------------
//  argv
// ---------------------------------------------------------------------------

/** `<remote>:<path>` as rclone takes it — an empty path IS the remote's root. */
export function rcloneDestination(task: Pick<CloudSyncTask, 'remote' | 'path'>): string {
  return `${task.remote}:${task.path}`
}

/**
 * The full rclone argv for one run. PURE, so the whole command a task would
 * issue is assertable without running anything.
 *
 * `--exclude` patterns are NOT rebased onto the snapshot root the way a pbc
 * exclude has to be: an rclone filter rule is relative to the source root by
 * definition, so the same pattern means the same thing whether the root is the
 * live tree or its snapshot.
 */
export function buildRcloneArgs(task: CloudSyncTask, configFile: string, source: string): string[] {
  const args: string[] = [
    task.mode,
    source,
    rcloneDestination(task),
    ...rcloneBaseArgs(configFile),
    ...RCLONE_LOG_ARGS,
  ]
  if (task.bwlimit)
    args.push('--bwlimit', task.bwlimit)
  for (const pattern of task.excludes)
    args.push('--exclude', pattern)
  return args
}

// ---------------------------------------------------------------------------
//  The JSON log
// ---------------------------------------------------------------------------

/** One `stats` object as rclone emits it (absent fields read as 0). */
export interface RcloneStats {
  bytes: number
  totalBytes: number
  transfers: number
  checks: number
  deletes: number
  errors: number
  elapsedTime: number
  /** Seconds remaining, when rclone could estimate them. */
  eta: number | null
  fatalError: boolean
}

const ZERO_STATS: RcloneStats = {
  bytes: 0,
  totalBytes: 0,
  transfers: 0,
  checks: 0,
  deletes: 0,
  errors: 0,
  elapsedTime: 0,
  eta: null,
  fatalError: false,
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Pull a `stats` object out of one parsed log object, or null when it has none. */
export function statsOf(entry: Record<string, unknown>): RcloneStats | null {
  const raw = entry.stats
  if (typeof raw !== 'object' || raw === null)
    return null
  const s = raw as Record<string, unknown>
  return {
    bytes: num(s.bytes),
    totalBytes: num(s.totalBytes),
    transfers: num(s.transfers),
    checks: num(s.checks),
    deletes: num(s.deletes),
    errors: num(s.errors),
    elapsedTime: num(s.elapsedTime),
    eta: typeof s.eta === 'number' && Number.isFinite(s.eta) ? s.eta : null,
    fatalError: s.fatalError === true,
  }
}

/**
 * The error line a `level:"error"` log object amounts to, verbatim and named:
 * rclone reports the object it failed on separately from the message, and an
 * error that does not say WHICH file is half an answer.
 */
export function errorLineOf(entry: Record<string, unknown>): string | null {
  if (entry.level !== 'error' && entry.level !== 'critical')
    return null
  const msg = typeof entry.msg === 'string' ? entry.msg.trim() : ''
  if (!msg)
    return null
  const object = typeof entry.object === 'string' ? entry.object.trim() : ''
  return object ? `${object}: ${msg}` : msg
}

/** What one finished (or in-flight) read of rclone's log amounts to. */
export interface RcloneLogState {
  /** The most recent stats object — the LAST one is the run's result. */
  stats: RcloneStats | null
  /** Error-level lines, in order. */
  errorLines: string[]
  /** Lines that were not JSON at all (a panic, a pre-logger message). */
  rawLines: string[]
}

/**
 * A line-buffered reader for rclone's NDJSON stderr. `onStderr` hands over
 * CHUNKS, which split lines wherever the pipe happened to break, so the
 * buffering has to live here rather than in every caller.
 */
export class RcloneLogReader {
  private buffer = ''
  readonly errorLines: string[] = []
  readonly rawLines: string[] = []
  stats: RcloneStats | null = null

  /**
   * Feed a chunk. Returns EVERY stats object this chunk completed, in order —
   * the caller publishes one progress line per object, which is DESIGN's
   * contract ("each `stats` object updates the job's progress"). A live run
   * completes at most one per chunk (they arrive `--stats` apart); a buffered
   * replay can complete several at once and must not silently drop the earlier
   * ones.
   */
  push(chunk: string): RcloneStats[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // The tail is whatever came after the last newline — an incomplete line.
    this.buffer = lines.pop() ?? ''
    const fresh: RcloneStats[] = []
    for (const line of lines) {
      const stats = this.line(line)
      if (stats)
        fresh.push(stats)
    }
    return fresh
  }

  /** Consume whatever is left in the buffer (a final line with no newline). */
  flush(): RcloneStats[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest)
      return []
    const stats = this.line(rest)
    return stats ? [stats] : []
  }

  private line(raw: string): RcloneStats | null {
    const text = raw.trim()
    if (!text)
      return null
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) {
        this.rawLines.push(text)
        return null
      }
      entry = parsed as Record<string, unknown>
    }
    catch {
      this.rawLines.push(text)
      return null
    }
    const error = errorLineOf(entry)
    if (error)
      this.errorLines.push(error)
    const stats = statsOf(entry)
    if (stats)
      this.stats = stats
    return stats
  }

  state(): RcloneLogState {
    return { stats: this.stats, errorLines: [...this.errorLines], rawLines: [...this.rawLines] }
  }
}

/** Read a whole captured log at once (the buffered path, and the tests'). */
export function readRcloneLog(text: string): RcloneLogState {
  const reader = new RcloneLogReader()
  reader.push(text)
  reader.flush()
  return reader.state()
}

/**
 * The final stats a whole run reported. Kept separate from the reader so the
 * result shape has ONE source, whether the log arrived in chunks or at once.
 */
export function finalStats(log: RcloneLogState): RcloneStats {
  return log.stats ?? ZERO_STATS
}

/**
 * One stats object as a job-progress line. rclone's OWN numbers, each with its
 * label — no unit guessing and nothing derived, so what the operator reads is
 * what rclone reported.
 */
export function statsProgressLine(mode: string, stats: RcloneStats): string {
  const parts = [
    `${stats.bytes} of ${stats.totalBytes} bytes`,
    `${stats.transfers} transferred`,
    `${stats.checks} checked`,
    `${stats.deletes} deleted`,
    `${stats.errors} errors`,
  ]
  if (stats.eta !== null)
    parts.push(`ETA ${stats.eta}s`)
  return `${mode}: ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------
//  Exit-code policy
// ---------------------------------------------------------------------------

/** Did this exit code COMPLETE the run? Only 0 and 9 (DESIGN). */
export function rcloneRunCompleted(exitCode: number): boolean {
  return exitCode === EXIT_OK || exitCode === EXIT_NOTHING_TO_TRANSFER
}

/**
 * The failure message for a non-completing exit: rclone's own error lines when
 * it logged any, else its raw output, else the bare code. ASCII only — this
 * text becomes the job's error AND the notification body's Error block.
 */
export function rcloneFailureMessage(mode: string, exitCode: number, log: RcloneLogState): string {
  const detail = log.errorLines.length
    ? log.errorLines.join('; ')
    : (log.rawLines.at(-1) ?? '')
  // Exit 6 is rclone's "less serious errors", which in practice means some
  // files did not make it. ANAS calls that a failed run, and says why plainly.
  const meaning = exitCode === EXIT_SOME_FILES_FAILED
    ? ' - some files could not be transferred and are missing at the destination'
    : ''
  return `rclone ${mode} failed (exit ${exitCode})${meaning}${detail ? `: ${detail}` : ''}`
}

// ---------------------------------------------------------------------------
//  Guards
// ---------------------------------------------------------------------------

/** The `sync`-with-an-empty-source refusal, in DESIGN's own words. */
export function emptySourceRefusal(source: string, configFile: string, destination: string): string {
  return `${source} is empty and this task syncs - an empty source in sync mode would delete everything `
    + `at the destination, so the run is refused. Use copy mode, or, if the source really is meant to be `
    + `empty, empty the remote by hand first: rclone --config ${configFile} purge ${destination}`
}

/** The source must be a DIRECTORY that exists — rclone syncs trees, not devices. */
export function missingSourceRefusal(source: string): string {
  return `${source} does not exist or is not a directory - a cloud sync task copies a directory tree`
}

// ---------------------------------------------------------------------------
//  The run
// ---------------------------------------------------------------------------

export interface CloudRunDeps {
  task: CloudSyncTask
  /** Where ANAS's own rclone.conf lives (every invocation names it). */
  paths: RcloneConfigPaths
  /** The fstab the source guard reads (the Mounts path, overridable for tests). */
  fstabPath: string
  /** Passed through to the consistency derivation (the PVE storage.cfg override). */
  consistencyOptions?: { pveStorageCfg?: string }
  /** AHR snapshot/runtime-dir options, threaded through to the transient helpers. */
  snapshotOptions?: BackupSnapshotOptions
  /** Injectable clock — the transient label and the sweep cutoff. */
  now?: Date
  /**
   * Plain secret values in scope for the argv guard. There are none in a cloud
   * sync run — rclone reads every credential from the config file, and a remote
   * NAME is not a secret — so this is normally empty and the guard is the
   * structural backstop that would fire if that ever stopped being true.
   */
  secrets?: string[]
}

/**
 * Run one cloud sync. Returns a result for a completed run; THROWS on a guard
 * refusal or a real failure, so the job fails and systemd's last-result stays
 * truthful.
 *
 * The order is load-bearing:
 *   1. source guard (configured-but-unmounted) and the existence check — before
 *      anything is read, and before a `sync` can see an empty mountpoint;
 *   2. the empty-source refusal, `sync` only;
 *   3. the boundary scan (informational — nested filesystems are NOT included);
 *   4. consistency derivation, then the transient snapshot: sweep this task's
 *      own stale ones first, take, point rclone at the snapshot path;
 *   5. ONE rclone invocation, its JSON log read live for progress;
 *   6. destroy the transient in a `finally` — success, failure or throw alike.
 */
export async function runCloudSync(
  executor: CommandExecutor,
  deps: CloudRunDeps,
  updateProgress: (message: string) => void,
): Promise<CloudSyncRunResult> {
  const { task } = deps
  const destination = rcloneDestination(task)
  const now = deps.now ?? new Date()
  const warnings: string[] = []

  updateProgress(`starting cloud sync ${task.name}: ${task.source} -> ${destination} (${task.mode})`)

  // ---- 1. Source guards --------------------------------------------------
  // The unmounted-mount check runs FIRST: it is the one that explains an empty
  // directory, and it is the only one that can answer without touching the path.
  const guardFacts = await readSourceGuardFacts(executor, deps.fstabPath)
  const refusal = guardSourcePath(task.source, guardFacts)
  if (refusal)
    throw new Error(refusal)

  // The source must be a DIRECTORY that exists and can be listed. A `stat` is
  // safe here BECAUSE the unmounted-mount guard already ran — that is the one
  // case where the path could sit on a filesystem that is not there.
  const stats = await stat(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (stats instanceof Error || !stats.isDirectory())
    throw new Error(missingSourceRefusal(task.source))
  const listed = await readdir(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (listed instanceof Error) {
    // Readable-directory problems (EACCES, EIO) are their own thing: saying
    // "does not exist" would send the operator looking for the wrong fault.
    throw new Error(`${task.source} could not be listed: ${listed.message}`)
  }
  const entries = listed

  // ---- 2. The catastrophic shape ----------------------------------------
  if (task.mode === 'sync' && entries.length === 0)
    throw new Error(emptySourceRefusal(task.source, deps.paths.configFile, destination))

  // ---- 3. What will NOT come along ---------------------------------------
  // Informational only, and fail-open: a scan problem never fails a run. A
  // snapshot captures ONE filesystem, so every nested one under the source is
  // left out — the dialog says so before save, and the run says so again.
  let nested: string[] = []
  try {
    const scan = await scanNestedFilesystems(executor, task.source, { includeNested: 'none' })
    nested = scan.nested.map(n => n.path)
  }
  catch {
    // fail open — the run is not about the scan
  }
  if (nested.length)
    updateProgress(`${nested.length} nested filesystem(s) under ${task.source} are not included: ${nested.join(' ')}`)

  // ---- 4. Consistency + the transient snapshot ---------------------------
  const facts = await readConsistencyFacts(executor, readAhrPools, deps.consistencyOptions ?? {})
  const consistency = deriveConsistency(task.source, facts)
  updateProgress(`source consistency: ${consistency.consistency} - ${consistency.reason}`)

  const taken: TakenSnapshot[] = []
  let result: CloudSyncRunResult

  try {
    const plan = await prepareSource(executor, deps, consistency, facts.ahrPools, now, updateProgress, taken, warnings)
    const args = buildRcloneArgs(task, deps.paths.configFile, plan.source)
    // The executor-side argv backstop, uniform with every other rclone call
    // ANAS makes. Nothing secret is in scope here (see `deps.secrets`), so it
    // normally has nothing to check — which is the point of a backstop.
    assertNoSecretValues(args, deps.secrets ?? [])

    updateProgress(`rclone ${task.mode} ${plan.source} -> ${destination}`)
    const run = plan.pool
      ? await withTopLevelMounts(executor, [plan.pool], async () => execRclone(executor, args, task.mode, updateProgress), deps.snapshotOptions)
      : await execRclone(executor, args, task.mode, updateProgress)

    if (!rcloneRunCompleted(run.exitCode))
      throw new Error(rcloneFailureMessage(task.mode, run.exitCode, run.log))

    const stats = finalStats(run.log)
    result = {
      status: 'success',
      mode: task.mode,
      consistency,
      source: plan.source,
      destination,
      ...(plan.label ? { snapshot: snapshotFullName(consistency, plan.label) } : {}),
      bytes: stats.bytes,
      totalBytes: stats.totalBytes,
      transfers: stats.transfers,
      checks: stats.checks,
      deletes: stats.deletes,
      errors: stats.errors,
      elapsed: stats.elapsedTime,
      errorLines: run.log.errorLines,
      ...(nested.length ? { nested } : {}),
    }
  }
  finally {
    // Success, failure or refusal alike. A destroy that fails is a WARNING on
    // an otherwise-good run, never a reason to call a finished sync failed.
    warnings.push(...await destroyTransients(executor, taken, updateProgress, deps.snapshotOptions))
  }

  if (warnings.length)
    result.warnings = warnings
  return result
}

/** `<dataset>@<label>` / `<pool>:@snapshots/<label>` — the snapshot, named in full. */
function snapshotFullName(consistency: BackupArchiveConsistency, label: string): string {
  return consistency.backend === 'ahr'
    ? `${consistency.target}:@snapshots/${label}`
    : `${consistency.target}@${label}`
}

/** What the rclone invocation will actually read, and what had to be taken for it. */
interface SourcePlan {
  /** The path rclone is pointed at — the snapshot path, or the live tree. */
  source: string
  /** The transient label, when one was taken. */
  label?: string
  /** The AHR pool whose top-level mount must be held open across the run. */
  pool?: AhrPool
}

/**
 * Sweep, take and resolve the snapshot path for a snapshottable source — or
 * hand back the live tree when the derivation said `live`. Pushes what it took
 * onto `taken`, which the caller's `finally` destroys.
 *
 * A ZVOL source cannot reach here: the existence check above requires a
 * directory, so `/dev/zvol/...` is refused long before the derivation's zvol
 * branch could matter.
 */
async function prepareSource(
  executor: CommandExecutor,
  deps: CloudRunDeps,
  consistency: BackupArchiveConsistency,
  ahrPools: AhrPool[],
  now: Date,
  updateProgress: (message: string) => void,
  taken: TakenSnapshot[],
  warnings: string[],
): Promise<SourcePlan> {
  const { task } = deps
  if (consistency.consistency !== 'snapshot' || !consistency.target)
    return { source: task.source }

  const label = formatTransientCloudSnapshot(task.name, now)
  // The sweep is scoped to THIS KIND's prefix AND this task's name: a backup
  // task's transients belong to a run that may be happening right now.
  const sweep = { parse: parseTransientCloudSnapshot }

  if (consistency.backend === 'zfs') {
    const dataset = consistency.target
    warnings.push(...await sweepZfsTransients(executor, dataset, task.name, now, updateProgress, sweep))
    updateProgress(`snapshotting ${dataset}@${label} (recursive)`)
    taken.push(await takeZfsTransient(executor, dataset, label))
    const source = snapshotRoot(consistency, label)
    if (!source)
      throw new Error(`the snapshot path for ${task.source} could not be resolved`)
    return { source, label }
  }

  const pool = ahrPools.find(p => p.name === consistency.target)
  if (!pool)
    throw new Error(`AHR pool '${consistency.target}' is no longer resolvable`)
  warnings.push(...await sweepAhrTransients(executor, pool, task.name, now, updateProgress, deps.snapshotOptions, sweep))
  updateProgress(`snapshotting AHR pool '${pool.name}' as @snapshots/${label}`)
  taken.push(await takeAhrTransient(executor, pool, label, undefined, updateProgress, deps.snapshotOptions))
  // `@snapshots` lives OUTSIDE the mounted `@data` tree, so the path is only
  // reachable while the pool is mounted top-level — which is why the caller
  // wraps the rclone call in `withTopLevelMounts` for exactly this pool.
  const source = snapshotRoot(consistency, label, plannedTopLevel(pool, deps.snapshotOptions))
  if (!source)
    throw new Error(`the snapshot path for ${task.source} could not be resolved`)
  return { source, label, pool }
}

/**
 * One rclone invocation, its NDJSON stderr read AS IT ARRIVES so the job's
 * progress moves during the run rather than at the end of it. `execFile`, no
 * shell, argv array — the whole command is the array `buildRcloneArgs` built.
 */
async function execRclone(
  executor: CommandExecutor,
  args: string[],
  mode: string,
  updateProgress: (message: string) => void,
): Promise<{ exitCode: number, log: RcloneLogState }> {
  const reader = new RcloneLogReader()
  const r = await executor.exec(RCLONE, args, {
    onStderr: (chunk) => {
      for (const stats of reader.push(chunk))
        updateProgress(statsProgressLine(mode, stats))
    },
  })
  for (const stats of reader.flush())
    updateProgress(statsProgressLine(mode, stats))
  const log = reader.state()
  // A mock (or an executor that buffers without teeing) hands the whole log
  // back only in `stderr`; re-reading it there is idempotent for a live run,
  // whose reader has already consumed the same bytes from the chunks.
  if (!log.stats && !log.errorLines.length && r.stderr)
    return { exitCode: r.exitCode, log: readRcloneLog(r.stderr) }
  return { exitCode: r.exitCode, log }
}
