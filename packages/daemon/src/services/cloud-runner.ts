import type { AhrPool, BackupArchiveConsistency, CloudRunDetail, CloudRunRecentEvent, CloudSyncRunResult, CloudSyncTask } from '@anas/shared'
import type { CommandExecutor, SpawnedChild } from '../executor/types.js'
import type { BackupSnapshotOptions, TakenSnapshot } from './backup-snapshots.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { readdir, stat } from 'node:fs/promises'
import { CLOUD_STATS_INTERVAL_SECS } from '@anas/shared'
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

/**
 * The stats cadence. 5s (rclone.6 — was 30s): the run viewer, the task row's
 * tiny spark and the dashboard strip all move on it, and `speedSamples` is
 * 60 of these — the last 5 minutes of throughput. The journal noise it adds
 * costs nothing: the runner's log stream goes to the daemon's pipe, not
 * journald. The number lives in `@anas/shared` (`CLOUD_STATS_INTERVAL_SECS`)
 * beside the stalled rule that converts trailing zero samples into seconds —
 * the argv value and the rule cannot drift.
 */
const STATS_INTERVAL = `${CLOUD_STATS_INTERVAL_SECS}s`

/**
 * The executor's retention cap for an rclone run. The arithmetic that makes
 * 256 MiB the right generosity: at `--stats 5s` rclone writes about 5.75 MB
 * of stats JSON per day of run time (the 1.15 MB/day DESIGN ground truth for
 * `--stats 30s`, 2026-09-23, scaled by the cadence), so a 10 TB copy at
 * `--bwlimit 8M` (~15 days) writes ~90 MB — and dying at the 10 MiB default
 * with a half-copied destination would be the worst kind of failure. 256 MiB
 * covers ~45 days of stats plus the `-v` per-file events (one line each — a
 * million-file tree is ~200 MB, the one shape that approaches the cap). The
 * tee path retains none of it anyway (only the last 64 KiB tail); this cap
 * governs stdout, which is empty, and exists so a future stderr-retaining
 * path cannot reintroduce the death by default.
 */
export const RCLONE_MAX_BUFFER = 256 * 1024 * 1024

/**
 * The JSON-log + verbosity + stats flags every run carries. `-v` (rclone.6)
 * adds one JSON event per finished file — the `recent` ring's source — and
 * makes `--stats-log-level NOTICE` redundant for the stats themselves (they
 * appear at `-v` regardless), but it stays: one flag list for the run and the
 * preview (which shares this argv and simply ignores the per-file events) is
 * the point.
 */
export const RCLONE_LOG_ARGS = [
  '--use-json-log',
  '-v',
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
 *
 * `dryRun` (the rclone.2 addendum's preview) appends `--dry-run` to the SAME
 * command a run would issue — one builder, no preview-specific argv copy.
 */
export function buildRcloneArgs(
  task: Pick<CloudSyncTask, 'mode' | 'remote' | 'path' | 'bwlimit' | 'excludes'>,
  configFile: string,
  source: string,
  opts: { dryRun?: boolean } = {},
): string[] {
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
  if (opts.dryRun)
    args.push('--dry-run')
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
  /** rclone.6 — the destination-side total, for the viewer's files bar. */
  totalTransfers: number
  checks: number
  totalChecks: number
  deletes: number
  errors: number
  elapsedTime: number
  /**
   * Seconds remaining, as rclone estimates them — parsed verbatim and used
   * only for the progress TEXT ("ETA 45s"), never for the run detail's `eta`
   * (review batch A 2026-09-25: rclone's averaging loop can freeze mid-run).
   */
  eta: number | null
  fatalError: boolean
  /**
   * rclone.6 — bytes/second, as the stats object reports it. Parsed verbatim
   * but NOT displayed: it is an exponentially weighted average that decays
   * toward zero without reaching it on a stall and stops being averaged once
   * only checks remain, so the detail derives its own samples from the byte
   * deltas instead (review batch A, 2026-09-25).
   */
  speed: number
  /**
   * rclone.6 — the in-flight files the object names, verbatim from
   * `transferring[]` (at most one per `--transfers` worker). Parsed for the
   * run viewer; the result-building path ignores it.
   */
  transferring: RcloneTransferringFile[]
}

/** One in-flight file, as a stats object's `transferring[]` carries it. */
export interface RcloneTransferringFile {
  name: string
  size: number
  bytes: number
  percentage: number
  speed: number
  eta: number | null
}

const ZERO_STATS: RcloneStats = {
  bytes: 0,
  totalBytes: 0,
  transfers: 0,
  totalTransfers: 0,
  checks: 0,
  totalChecks: 0,
  deletes: 0,
  errors: 0,
  elapsedTime: 0,
  eta: null,
  fatalError: false,
  speed: 0,
  transferring: [],
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One `transferring[]` entry, or null when it is not the shape rclone sends. */
function transferringOf(raw: unknown): RcloneTransferringFile | null {
  if (typeof raw !== 'object' || raw === null)
    return null
  const t = raw as Record<string, unknown>
  if (typeof t.name !== 'string' || t.name === '')
    return null
  return {
    name: t.name,
    size: num(t.size),
    bytes: num(t.bytes),
    percentage: num(t.percentage),
    speed: num(t.speed),
    eta: typeof t.eta === 'number' && Number.isFinite(t.eta) ? t.eta : null,
  }
}

/** Pull a `stats` object out of one parsed log object, or null when it has none. */
export function statsOf(entry: Record<string, unknown>): RcloneStats | null {
  const raw = entry.stats
  if (typeof raw !== 'object' || raw === null)
    return null
  const s = raw as Record<string, unknown>
  const transferring: RcloneTransferringFile[] = []
  if (Array.isArray(s.transferring)) {
    for (const t of s.transferring) {
      const f = transferringOf(t)
      if (f)
        transferring.push(f)
    }
  }
  return {
    bytes: num(s.bytes),
    totalBytes: num(s.totalBytes),
    transfers: num(s.transfers),
    totalTransfers: num(s.totalTransfers),
    checks: num(s.checks),
    totalChecks: num(s.totalChecks),
    deletes: num(s.deletes),
    errors: num(s.errors),
    elapsedTime: num(s.elapsedTime),
    eta: typeof s.eta === 'number' && Number.isFinite(s.eta) ? s.eta : null,
    fatalError: s.fatalError === true,
    speed: num(s.speed),
    transferring,
  }
}

// --- Per-file events (rclone.6 — the `-v` stream) ---------------------------

/** The per-file kinds the run detail's `recent` ring keeps. */
export type RcloneFileEventKind = 'copied' | 'updated' | 'deleted' | 'error'

/** One finished (or failed) file, as the `-v` stream reports it. */
export interface RcloneFileEvent {
  name: string
  kind: RcloneFileEventKind
  /** The error's message, verbatim (error events only). */
  message?: string
}

/**
 * The `-v` event messages rclone 1.60 emits per finished file, and the kind
 * each maps to (GT 2026-09-25, captured on the node — `fixtures/rclone/
 * run-copy-1.60.1.log`). Every Copied shape reads `copied`: a replace says
 * "Copied (replaced existing)", a server-side copy "Copied (server-side
 * copy)", a multi-threaded one "Multi-thread Copied (...)". A modtime touch
 * reads "Updated modification time in destination" and is NOT a file
 * transfer, so nothing maps to `updated` — the kind stays in the schema for
 * forward compatibility, but 1.60 never produces it. Anything else an
 * info-level object says about a file is not one of the viewer's kinds and
 * is ignored.
 */
const FILE_EVENT_MSGS: [prefix: string, kind: RcloneFileEventKind][] = [
  ['Copied', 'copied'],
  ['Multi-thread Copied', 'copied'],
  ['Deleted', 'deleted'],
]

/**
 * The per-file event one log object amounts to, or null when it is none:
 * an info-level object naming a file with one of the messages above, or an
 * error-level object (which is ALSO an error line — the caller pushes it to
 * both). An error names the file it failed on WHEN rclone says one; the
 * retry summary lines ("Attempt 1/3 failed with ...") carry no `object`, and
 * they must still reach `recent`/`lastError`, so those events carry
 * `name: ''` (GT: `run-error-objectless-1.60.1.log`).
 */
export function fileEventOf(entry: Record<string, unknown>): RcloneFileEvent | null {
  const msg = typeof entry.msg === 'string' ? entry.msg.trim() : ''
  if (!msg)
    return null
  const object = typeof entry.object === 'string' ? entry.object.trim() : ''
  if (entry.level === 'error' || entry.level === 'critical')
    return { name: object, kind: 'error', message: msg }
  if (!object || entry.level !== 'info')
    return null
  for (const [prefix, kind] of FILE_EVENT_MSGS) {
    if (msg.startsWith(prefix))
      return { name: object, kind }
  }
  return null
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

/**
 * The cap on the would-be-delete NAMES the reader keeps. A whole-tree delete
 * can name millions of files, and the operator reading the answer wants a
 * sample with the count, not a wall of names — so the reader stops collecting
 * names at the cap while `skippedDeleteCount` keeps counting. Defined HERE,
 * next to the code that enforces it, and re-exported by `cloud-preview.ts`:
 * the reader and the answer must never disagree about the number.
 */
export const DELETED_FILES_CAP = 200

/** What one finished (or in-flight) read of rclone's log amounts to. */
export interface RcloneLogState {
  /** The most recent stats object — the LAST one is the run's result. */
  stats: RcloneStats | null
  /** Error-level lines, in order. */
  errorLines: string[]
  /** Lines that were not JSON at all (a panic, a pre-logger message). */
  rawLines: string[]
  /**
   * The `object` names of `skipped: delete` lines, in order — the would-be
   * deletes a `--dry-run` reports (GT 2026-09-24: every would-be delete is
   * exactly such an object). A real run prints none, so this stays empty
   * there and the preview's `deletedFiles` has one source.
   *
   * CAPPED at {@link DELETED_FILES_CAP} names: the reader is fed by a live
   * child's stderr, so an uncapped array would let a whole-tree delete grow
   * the daemon's heap by the destination's file count. The number is
   * {@link skippedDeleteCount}, which is never capped.
   */
  skippedDeletes: string[]
  /**
   * How many `skipped: delete` lines were read, whether or not their names
   * were kept — the honest total behind the capped {@link skippedDeletes}.
   */
  skippedDeleteCount: number
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
  /**
   * rclone.6 — called with every per-file event a completed line amounts to
   * (a finished file, or an error naming one). Optional: the preview keeps
   * none. A live run completes at most one per chunk, like the stats objects.
   */
  onFileEvent?: (event: RcloneFileEvent) => void
  /**
   * The `object` of the first {@link DELETED_FILES_CAP} `skipped: delete`
   * lines (a dry run's would-be deletes). The names stop at the cap; the
   * count does not.
   */
  readonly skippedDeletes: string[] = []
  /** Every `skipped: delete` line read, capped names or not. */
  skippedDeleteCount = 0
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
    const fileEvent = fileEventOf(entry)
    if (fileEvent)
      this.onFileEvent?.(fileEvent)
    // A would-be delete: rclone's `--dry-run` reports each one as a
    // `skipped: delete` object naming the file (`skipped: copy` lines are the
    // would-be TRANSFERS — rclone counts them in `stats.transfers`, so they
    // are not collected here twice).
    // The NAMES stop at the cap (an unbounded array here would grow with the
    // destination's file count, fed by a live child); the COUNT never does.
    if (entry.skipped === 'delete' && typeof entry.object === 'string' && entry.object.trim() !== '') {
      this.skippedDeleteCount++
      if (this.skippedDeletes.length < DELETED_FILES_CAP)
        this.skippedDeletes.push(entry.object.trim())
    }
    const stats = statsOf(entry)
    if (stats)
      this.stats = stats
    return stats
  }

  state(): RcloneLogState {
    return {
      stats: this.stats,
      errorLines: [...this.errorLines],
      rawLines: [...this.rawLines],
      skippedDeletes: [...this.skippedDeletes],
      skippedDeleteCount: this.skippedDeleteCount,
    }
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
//  The live run DETAIL (rclone.6)
// ---------------------------------------------------------------------------

/** The `recent` ring's cap — the last 50 per-file events. */
export const RECENT_RING_CAP = 50
/** The `speedSamples` ring's cap — the last 60 byte-delta samples, i.e. 5 min at 5s. */
export const SPEED_RING_CAP = 60

/**
 * Builds the {@link CloudRunDetail} a direct run job publishes on itself,
 * fed by the same log stream that drives the progress text: one
 * {@link onStats} per completed stats object, one {@link onEvent} per
 * finished/failed file. Every counter is rclone's own; the throughput
 * figures are NOT — the samples are derived HERE, from the byte deltas
 * between consecutive stats objects, because rclone's own `speed` is an
 * exponentially weighted average that decays toward zero but never reaches
 * it on a stall, and its averaging loop stops 60 s after the transferring
 * set empties and never restarts (review batch A, 2026-09-25). The rings
 * are capped so a multi-day run's daemon heap stays flat.
 */
export class CloudRunDetailTracker {
  private startedMs: number
  private latest: RcloneStats | null = null
  private readonly recent: CloudRunRecentEvent[] = []
  /**
   * The daemon's own throughput samples: per stats object AFTER the first,
   * `(bytes - prevBytes) / (elapsedTime - prevElapsed)` — 0 when the elapsed
   * delta is <= 0 or bytes did not grow. One per stats tick, so on a stall
   * they read exactly 0 and the shared stalled rule can fire.
   */
  private readonly speedSamples: number[] = []
  private lastError: string | undefined

  constructor(startedAt: Date = new Date()) {
    this.startedMs = startedAt.getTime()
  }

  /** The run's start, as the detail publishes it. */
  get startedAt(): string {
    return new Date(this.startedMs).toISOString()
  }

  /** Feed one completed stats object (the counters + the sample ring). */
  onStats(stats: RcloneStats): void {
    const prev = this.latest
    this.latest = stats
    if (prev) {
      const dElapsed = stats.elapsedTime - prev.elapsedTime
      const dBytes = stats.bytes - prev.bytes
      this.speedSamples.push(dElapsed > 0 && dBytes > 0 ? dBytes / dElapsed : 0)
      while (this.speedSamples.length > SPEED_RING_CAP)
        this.speedSamples.shift()
    }
  }

  /** Feed one per-file event (the `recent` ring; an error also names `lastError`). */
  onEvent(event: RcloneFileEvent, at: string = new Date().toISOString()): void {
    const entry: CloudRunRecentEvent = {
      name: event.name,
      kind: event.kind,
      at,
      ...(event.message ? { message: event.message } : {}),
    }
    this.recent.push(entry)
    while (this.recent.length > RECENT_RING_CAP)
      this.recent.shift()
    if (event.kind === 'error' && event.message) {
      // An object-less error line has no name to prefix — its message alone
      // is the last error (the "Attempt 1/3 failed" retry summaries).
      this.lastError = event.name ? `${event.name}: ${event.message}` : event.message
    }
  }

  /**
   * The detail's ETA: remaining bytes over the mean of the last 12 samples,
   * in seconds — null until at least 3 samples exist and that mean is
   * positive. Never rclone's own `eta` (see the class doc).
   */
  private eta(): number | null {
    if (this.speedSamples.length < 3)
      return null
    const window = this.speedSamples.slice(-12)
    const avg = window.reduce((sum, v) => sum + v, 0) / window.length
    if (!(avg > 0))
      return null
    const remaining = this.latest ? this.latest.totalBytes - this.latest.bytes : 0
    return Math.max(0, remaining) / avg
  }

  /** The detail as it stands right now — a fresh object every call. */
  detail(now: number = Date.now()): CloudRunDetail {
    const s = this.latest ?? ZERO_STATS
    return {
      startedAt: this.startedAt,
      elapsedMs: Math.max(0, now - this.startedMs),
      speed: this.speedSamples.at(-1) ?? 0,
      eta: this.eta(),
      bytes: s.bytes,
      totalBytes: s.totalBytes,
      transfers: s.transfers,
      totalTransfers: s.totalTransfers,
      checks: s.checks,
      totalChecks: s.totalChecks,
      deletes: s.deletes,
      errors: s.errors,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      // Snapshots, not live references: every poll hands the published object
      // to the wire on its own, so a poll already reading an older detail
      // must never see a later tick mutate into it.
      transferring: s.transferring.map(f => ({ ...f })),
      recent: [...this.recent],
      speedSamples: [...this.speedSamples],
    }
  }
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
  /**
   * rclone.5 — handed the rclone child the moment it spawns, so the job's
   * cancel hook ({@link ChildCancel}) can signal it. Absent = not cancellable.
   */
  onSpawn?: (child: SpawnedChild) => void
  /**
   * rclone.5 review — the pre-flight boundary check, called at each one (before
   * the source guard, before the transient snapshot, before the exec) with what
   * the next step would have done. Throws {@link JobCancelledError} when a
   * cancel was already accepted, so the run ends `cancelled` there — its own
   * `finally` still destroys anything taken. Absent = no boundary checks.
   */
  checkCancel?: (next: string) => void
  /**
   * rclone.6 — handed the run's live {@link CloudRunDetail} after every stats
   * object, for the job to publish through the queue's `updateDetail`.
   * Per-file events update the tracker's rings and are carried out by the
   * NEXT stats tick — a many-small-files run must not build one detail
   * snapshot per file (review batch A, 2026-09-25). Absent = no detail is
   * built (the preview).
   */
  onDetail?: (detail: CloudRunDetail) => void
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
  deps.checkCancel?.('the source guard')
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
  // The boundary between the read-only probes and the first mutation: past
  // here a cancel leaves nothing taken — the snapshot below never happens.
  deps.checkCancel?.('the transient snapshot')

  const taken: TakenSnapshot[] = []
  let result: CloudSyncRunResult

  try {
    const plan = await prepareSource(executor, deps, consistency, facts.ahrPools, now, updateProgress, taken, warnings)
    const args = buildRcloneArgs(task, deps.paths.configFile, plan.source)
    // The executor-side argv backstop, uniform with every other rclone call
    // ANAS makes. Nothing secret is in scope here (see `deps.secrets`), so it
    // normally has nothing to check — which is the point of a backstop.
    assertNoSecretValues(args, deps.secrets ?? [])

    // The last boundary before anything runs (rclone.5 review): a cancel
    // accepted by now ends the run here — the `finally` below still destroys
    // the snapshot the plan may have taken.
    deps.checkCancel?.('the rclone run')

    // rclone.6 — the live detail the run publishes on its job, fed by the same
    // stream the progress text is. Built only when someone is listening.
    const tracker = deps.onDetail ? new CloudRunDetailTracker(now) : null
    const publish = () => {
      if (tracker)
        deps.onDetail?.(tracker.detail())
    }

    updateProgress(`rclone ${task.mode} ${plan.source} -> ${destination}`)
    const exec = () => execRclone(executor, args, task.mode, updateProgress, deps.onSpawn, tracker ?? undefined, publish)
    const run = plan.pool
      ? await withTopLevelMounts(executor, [plan.pool], exec, deps.snapshotOptions)
      : await exec()

    if (!rcloneRunCompleted(run.exitCode))
      throw new Error(rcloneFailureMessage(task.mode, run.exitCode, run.log))

    const stats = finalStats(run.log)
    result = {
      status: 'success',
      mode: task.mode,
      consistency,
      source: plan.source,
      destination,
      ...(plan.snapshot ? { snapshot: plan.snapshot } : {}),
      bytes: stats.bytes,
      totalBytes: stats.totalBytes,
      transfers: stats.transfers,
      checks: stats.checks,
      deletes: stats.deletes,
      errors: stats.errors,
      elapsed: stats.elapsedTime,
      // Whether rclone actually reported a stats object. A sub-second run may
      // print none (its interval has not fired), and the counters below read
      // 0 in that case — honest only when this flag says so.
      countersReported: run.log.stats !== null,
      errorLines: run.log.errorLines,
      ...(nested.length ? { nested } : {}),
    }
  }
  finally {
    // Success, failure or refusal alike. A destroy that fails is a WARNING on
    // an otherwise-good run, never a reason to call a finished sync failed.
    // The noun says what kind of transient it was — this is a cloud sync run,
    // not a backup.
    warnings.push(...await destroyTransients(executor, taken, updateProgress, deps.snapshotOptions, 'cloud sync'))
  }

  if (warnings.length)
    result.warnings = warnings
  return result
}

/** What the rclone invocation will actually read, and what had to be taken for it. */
interface SourcePlan {
  /** The path rclone is pointed at — the snapshot path, or the live tree. */
  source: string
  /**
   * The transient snapshot, named in full (`<dataset>@<label>` / AHR's
   * `<pool>:@snapshots/<label>`) — taken verbatim from the `TakenSnapshot.full`
   * the take helpers already assembled, so the naming lives in ONE place.
   */
  snapshot?: string
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
    const snap = await takeZfsTransient(executor, dataset, label)
    taken.push(snap)
    const source = snapshotRoot(consistency, label)
    if (!source)
      throw new Error(`the snapshot path for ${task.source} could not be resolved`)
    return { source, snapshot: snap.full }
  }

  const pool = ahrPools.find(p => p.name === consistency.target)
  if (!pool)
    throw new Error(`AHR pool '${consistency.target}' is no longer resolvable`)
  warnings.push(...await sweepAhrTransients(executor, pool, task.name, now, updateProgress, deps.snapshotOptions, sweep))
  updateProgress(`snapshotting AHR pool '${pool.name}' as @snapshots/${label}`)
  const snap = await takeAhrTransient(executor, pool, label, undefined, updateProgress, deps.snapshotOptions)
  taken.push(snap)
  // `@snapshots` lives OUTSIDE the mounted `@data` tree, so the path is only
  // reachable while the pool is mounted top-level — which is why the caller
  // wraps the rclone call in `withTopLevelMounts` for exactly this pool.
  const source = snapshotRoot(consistency, label, plannedTopLevel(pool, deps.snapshotOptions))
  if (!source)
    throw new Error(`the snapshot path for ${task.source} could not be resolved`)
  return { source, snapshot: snap.full, pool }
}

/**
 * One rclone invocation, its NDJSON stderr read AS IT ARRIVES so the job's
 * progress moves during the run rather than at the end of it. `execFile`, no
 * shell, argv array — the whole command is the array `buildRcloneArgs` built.
 * The tee and the re-read fallback live in {@link execRcloneLog}, shared with
 * the preview (which wraps the same argv in `timeout` and keeps no progress).
 * `tracker`/`publish` (rclone.6) feed the live run detail off the same stream
 * — the detail is PUBLISHED per stats tick only (review batch A, 2026-09-25):
 * a file event updates the tracker's rings and the next stats tick carries it
 * out, so a many-small-files run builds no snapshot per file.
 */
async function execRclone(
  executor: CommandExecutor,
  args: string[],
  mode: string,
  updateProgress: (message: string) => void,
  onSpawn?: (child: SpawnedChild) => void,
  tracker?: CloudRunDetailTracker,
  publish?: () => void,
): Promise<{ exitCode: number, log: RcloneLogState }> {
  return execRcloneLog(
    executor,
    RCLONE,
    args,
    (stats) => {
      updateProgress(statsProgressLine(mode, stats))
      tracker?.onStats(stats)
      publish?.()
    },
    onSpawn,
    (event) => {
      tracker?.onEvent(event)
    },
  )
}

/**
 * One rclone invocation (or a `timeout` wrapper around one), its NDJSON
 * stderr read as it arrives. The ONE place the tee pattern lives: every
 * completed `stats` object is handed to `onStats` (the run publishes job
 * progress; the preview keeps none), every per-file event to `onEvent`
 * (rclone.6), and the bounded-tail re-read covers an executor that buffers
 * without teeing.
 */
export async function execRcloneLog(
  executor: CommandExecutor,
  command: string,
  args: string[],
  onStats?: (stats: RcloneStats) => void,
  onSpawn?: (child: SpawnedChild) => void,
  onEvent?: (event: RcloneFileEvent) => void,
): Promise<{ exitCode: number, log: RcloneLogState }> {
  const reader = new RcloneLogReader()
  reader.onFileEvent = onEvent
  const r = await executor.exec(command, args, {
    ...(onSpawn ? { onSpawn } : {}),
    // See RCLONE_MAX_BUFFER for the arithmetic. The tee means stderr is NOT
    // retained beyond the executor's bounded tail — a 15-day run's stats log
    // never accumulates in the daemon.
    maxBuffer: RCLONE_MAX_BUFFER,
    onStderr: (chunk) => {
      for (const stats of reader.push(chunk))
        onStats?.(stats)
    },
  })
  for (const stats of reader.flush())
    onStats?.(stats)
  const log = reader.state()
  // A mock (or an executor that buffers without teeing) hands the whole log
  // back only in `stderr`; re-reading it there is idempotent for a live run,
  // whose reader has already consumed the same bytes from the chunks. A log
  // whose only objects were `skipped` lines must re-read too, or a no-tee
  // executor would report the would-be deletes as zero.
  if (!log.stats && !log.errorLines.length && !log.skippedDeleteCount && r.stderr)
    return { exitCode: r.exitCode, log: readRcloneLog(r.stderr) }
  return { exitCode: r.exitCode, log }
}
