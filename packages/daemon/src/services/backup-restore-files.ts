import type {
  BackupFilesRestoreResult,
  BackupRestoreOptions,
  BackupRestoreProgress,
  BackupRestoreTargetMode,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { BrowseArchiveDeps } from './backup-catalog.js'
import type { BackupReadDeps } from './backup-reads.js'
import { writeFile } from 'node:fs/promises'
import { isPathWithin, restorePatternsFor } from '@anas/shared'
import { isHardlinkStat, statArchivePaths } from './backup-catalog.js'
import { classifyBackupReadVerdict } from './backup-reads.js'
import { buildBackupEnv, PBC } from './backup-runner.js'

/**
 * SELECTIVE FILE RESTORE (story backup2.6) — `proxmox-backup-client restore`
 * with one `--pattern` per picked entry.
 *
 * This is the `kind: 'files'` half of `POST /v1/backup/restore`; the whole-image
 * half (`kind: 'image'`, backup2.7) is its own service behind the same door.
 * Restore is two types BY NATURE: files are selective, block images are whole.
 *
 * Ground truth that shapes every line here (docs/BACKUP-RESTORE-GROUND-TRUTH.md):
 *
 *   - GT-11  in-place needs `--allow-existing-dirs --overwrite`, the MINIMAL
 *            pair. `--overwrite` alone dies on the first existing DIRECTORY,
 *            and `--allow-existing-dirs` alone dies on the first existing FILE.
 *   - GT-12  an in-place restore is a MERGE, never a sync. Nothing is deleted.
 *   - GT-15  restoring into a NEW directory needs no flags at all, and deep
 *            missing parents are created (mkdir -p semantics).
 *   - GT-18  a pattern without a leading `/` is a PATH SUFFIX match at any
 *            depth. Every pattern ANAS emits is anchored.
 *   - GT-22  `[` unescaped is a character class and matches NOTHING at exit 0.
 *   - GT-24  a pattern that matches nothing is a SILENT SUCCESS. The client will
 *            never say the selection was wrong — so this daemon verifies.
 *   - GT-25  a hardlink's SECOND name restored alone fails the WHOLE job. The
 *            group is completed before the client is called.
 *   - GT-56  the failure taxonomy, verbatim, incl. the read-only target that
 *            fails only at the FIRST FILE (hence the pre-flight write test).
 *   - GT-59  progress is CR-terminated, on STDERR, at a DOUBLING interval —
 *            6 s, 16 s, 36 s, 79 s. Silence is not a stall.
 *   - GT-60  an interrupted restore leaves a partial tree with NO MARKER. The
 *            "partial" label is entirely ANAS's to write; the only forensic
 *            hint the client leaves is an in-flight file that is short AND 0600.
 */

/** `timeout` — the same hang guard the mounts family and the browser use. */
const TIMEOUT = '/usr/bin/timeout'
/** `timeout` exits 124 when it had to kill the child. */
const TIMEOUT_EXIT = 124
const FIND = '/usr/bin/find'
const TOUCH = '/usr/bin/touch'
const RM = '/usr/bin/rm'
const STAT = '/usr/bin/stat'

/** Budget for the pre-flight write test — a dead mount must not wedge a request. */
export const WRITE_TEST_TIMEOUT_S = 10
/** Budget for the free-space probe (`stat -f`). */
export const SPACE_PROBE_TIMEOUT_S = 10
/** Budget for the post-restore verification walk. */
export const VERIFY_TIMEOUT_S = 30

/**
 * The marker ANAS writes inside a newLocation directory it could not finish —
 * a directory THIS restore created.
 *
 * OUR artefact, inside OUR directory — not shadow state about the system. It
 * exists because the client leaves nothing at all behind (GT-60) and a tree
 * that looks complete but is not is the one outcome a restore must never
 * produce silently. A restore that MERGED into a directory that already
 * existed (inPlace, or a newLocation confirmed through the gate) never gets
 * one: writing a file into the operator's data to describe our own failure is
 * not ours to do (Principle 12).
 */
export const PARTIAL_MARKER_NAME = '.anas-restore-partial'

/**
 * `progress 4% (12.409 MiB of 250.001 MiB in 6s, 2.084 MiB/s)` (GT-59). The
 * inner fields are kept as the client rendered them — re-deriving a rate from a
 * parsed size would be a different number than the one the operator saw.
 */
const PROGRESS_RE = /^progress (\d{1,3})% \((.+?) of (.+?) in (.+?), (.+?)\)$/
/** `restore complete (250.001 MiB processed in 1m 27.5s, average 2.857 MiB/s)`. */
const COMPLETE_RE = /^restore complete \((.+?) processed in .+?, average .+?\)$/
/** A human size the client printed: `250.001 MiB`, `2.546 KiB`, `13 B`. */
const HUMAN_BYTES_RE = /^([\d.]+)\s*([KMGTP]?i?B)$/i
/** Trailing padding spaces pbc leaves on every line. */
const TRAILING_WS_RE = /\s+$/
/** Trailing slashes on a path (the root survives). */
const TRAILING_SLASHES_RE = /\/+$/
/** Leading slashes on an archive-relative path. */
const LEADING_SLASHES_RE = /^\/+/
/** A line break of either flavour — a progress line is CR-terminated (GT-59). */
const LINE_BREAK_RE = /[\r\n]/
/** Any run of whitespace (splitting `stat -f`'s two numbers). */
const WHITESPACE_RE = /\s+/
/** The archive-type suffix (and its stored index suffix) on an archive name. */
const ARCHIVE_SUFFIX_RE = /\.(?:pxar|mpxar|ppxar|img)(?:\.(?:didx|fidx|blob))?$/

// --- Failure taxonomy (GT-56) ------------------------------------------------

/** `… failed to extract hardlink: ENOENT …` — GT-25's partly-named group. */
const HARDLINK_ENOENT_RE = /failed to extract hardlink:\s*ENOENT/i
/** `… failed to create file "x": EROFS: Read-only file system` (first file). */
const EROFS_RE = /EROFS|Read-only file system/i
/** `… error creating directory "…": ENOTDIR` — the target path is a FILE. */
const ENOTDIR_RE = /ENOTDIR|Not a directory/i
/** `… EEXIST: File exists` — a flag combination that cannot enter the tree. */
const EEXIST_RE = /EEXIST|File exists/i
/** `ENOSPC` / `No space left on device` — the check was an estimate, not a promise. */
const ENOSPC_RE = /ENOSPC|No space left on device/i
/** GT-61: the server went away mid-stream. */
const BROKEN_PIPE_RE = /broken pipe|connection closed|HTTP\/2\.0 connection failed/i

/**
 * Exit codes a KILLED client leaves, mapped to the SIGNAL each one encodes
 * (GT-60: `SIGTERM` behaves like `kill -9` — exit 143 / 137, no cleanup, no
 * marker). A shell reports a signal death as 128+N; the daemon's executor does
 * NOT (a signal has no exit code, so `exec` reports a plain 1 and carries the
 * signal NAME separately). Both routes have to be readable here, because the
 * captures were taken through a shell and the running system goes through the
 * executor. `timeout`'s own 124 is NOT in here — it is the guard's exit, not
 * the client's, and it gets its own wording.
 */
const SIGNAL_EXITS = new Map<number, number>([[130, 2], [137, 9], [143, 15]])
/** `timeout` exits 124 when it had to kill the child it was guarding. */
const TIMEOUT_GUARD_EXIT = 124

/** POSIX numbers for the signals a killed client can actually arrive with. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
}

/**
 * How the client's process ENDED, in one clause — `killed (signal 9)` or
 * `exit 1`. This is what the partial marker's `reason:` falls back to when the
 * client left no error of its own (live-proof F16); it is never a progress line
 * and never invents a cause.
 */
export function describeAbnormalExit(exitCode: number, signal?: string): string {
  if (signal) {
    const named = SIGNAL_NUMBERS[signal]
    return named === undefined ? `killed (${signal})` : `killed (signal ${named})`
  }
  if (exitCode === TIMEOUT_GUARD_EXIT)
    return 'exit 124 (the timeout guard killed it)'
  const fromCode = SIGNAL_EXITS.get(exitCode)
  if (fromCode !== undefined)
    return `killed (signal ${fromCode})`
  return `exit ${exitCode}`
}

/**
 * Is this line one of the client's PROGRESS lines (or its completion line)?
 * They are the last thing on stderr when a client is killed, and they are not a
 * reason for anything — the whole point of F16.
 */
export function isRestoreProgressLine(line: string): boolean {
  const trimmed = line.replace(TRAILING_WS_RE, '')
  return PROGRESS_RE.test(trimmed) || COMPLETE_RE.test(trimmed)
}

/**
 * Did the client say anything that could serve as a reason? An `Error:` line, or
 * any non-progress line (`HTTP/2.0 connection failed` is one). Progress alone is
 * silence.
 */
export function hasRestoreErrorText(stderr: string): boolean {
  return restoreLines(stderr).some(l => l.trim().length > 0 && !isRestoreProgressLine(l))
}

/** Split pbc output on BOTH `\r` and `\n` — a progress line is CR-terminated. */
export function restoreLines(stderr: string): string[] {
  return stderr
    .split(LINE_BREAK_RE)
    .map(l => l.replace(TRAILING_WS_RE, ''))
    .filter(l => l.length > 0)
}

/** A human size the client printed → bytes, or undefined when unparseable. */
export function parseHumanBytes(text: string): number | undefined {
  const m = HUMAN_BYTES_RE.exec(text.trim())
  if (!m)
    return undefined
  const value = Number(m[1])
  if (!Number.isFinite(value))
    return undefined
  const unit = (m[2] ?? 'B').toUpperCase()
  // Binary units are what pbc prints; the decimal forms are accepted because
  // its own `--rate` help documents both families.
  const scale: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    PIB: 1024 ** 5,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    PB: 1000 ** 5,
  }
  const factor = scale[unit]
  if (factor === undefined)
    return undefined
  return Math.round(value * factor)
}

export interface ParsedRestoreProgress {
  /** Every `progress …` line, in order. */
  progress: BackupRestoreProgress[]
  /** The `restore complete (…)` line verbatim, when the client got that far. */
  completeLine?: string
  /**
   * Bytes processed: from the complete line when there is one, else from the
   * LAST progress line — which is the honest figure for an interrupted run
   * ("it had got this far"), never an invented total.
   */
  bytes?: number
}

/**
 * Parse a restore's STDERR into progress units.
 *
 * STDOUT is empty for a restore (measured), and nothing at all is printed for
 * the first ~6 s. The interval then roughly DOUBLES (6 s, 16 s, 36 s, 79 s), so
 * a multi-hour restore emits only a handful of late lines — a job UI must never
 * read silence as a stall, and `progressSummaryLine` says so.
 */
export function parseRestoreProgress(stderr: string): ParsedRestoreProgress {
  const out: ParsedRestoreProgress = { progress: [] }
  for (const line of restoreLines(stderr)) {
    const p = PROGRESS_RE.exec(line)
    if (p) {
      const percent = Number(p[1])
      const entry: BackupRestoreProgress = { line }
      if (Number.isFinite(percent) && percent >= 0 && percent <= 100)
        entry.percent = percent
      if (p[2])
        entry.done = p[2]
      if (p[3])
        entry.total = p[3]
      if (p[4])
        entry.elapsed = p[4]
      if (p[5])
        entry.rate = p[5]
      out.progress.push(entry)
      continue
    }
    const c = COMPLETE_RE.exec(line)
    if (c) {
      out.completeLine = line
      const bytes = parseHumanBytes(c[1] ?? '')
      if (bytes !== undefined)
        out.bytes = bytes
    }
  }
  if (out.bytes === undefined) {
    const last = out.progress.at(-1)
    if (last?.done) {
      const bytes = parseHumanBytes(last.done)
      if (bytes !== undefined)
        out.bytes = bytes
    }
  }
  return out
}

/** The one-line job progress for a parsed restore (never a secret). */
export function progressSummaryLine(parsed: ParsedRestoreProgress): string {
  if (parsed.completeLine)
    return parsed.completeLine
  const last = parsed.progress.at(-1)
  return last ? last.line : 'restore running (pbc reports progress at widening intervals; silence is not a stall)'
}

/**
 * Classify a FAILED restore into a client-safe message.
 *
 * The shared strings (missing snapshot/group/namespace, `Connection refused`,
 * the no-permission wording, a bad archive suffix) come from ONE classifier —
 * `classifyBackupReadVerdict` — so a wording change happens once. Everything
 * below is restore-specific and is checked FIRST, because a restore fails in
 * ways a listing cannot.
 */
export function classifyRestoreFailure(
  exitCode: number,
  stderr: string,
  signal?: string,
): { detail: string, interrupted: boolean } {
  // The client said NOTHING usable — a kill leaves only progress lines behind,
  // and a progress line is not a reason (live-proof F16). Name how the process
  // ended instead; that is the only fact there is. Checked first because every
  // branch below reads stderr for a cause that is not in there.
  if (!hasRestoreErrorText(stderr)) {
    return {
      detail: `The restore was interrupted - the client ended with ${describeAbnormalExit(exitCode, signal)} `
        + `and reported no error of its own; what it had already written is still there.`,
      interrupted: true,
    }
  }
  if (BROKEN_PIPE_RE.test(stderr)) {
    return {
      detail: `The Proxmox Backup Server went away part-way through the restore: ${firstRestoreError(stderr)}`,
      interrupted: true,
    }
  }
  if (HARDLINK_ENOENT_RE.test(stderr)) {
    return {
      detail: 'A hardlink was restored without the other name in its group, which fails the whole restore - '
        + 'select every name of a hardlink group together.',
      interrupted: true,
    }
  }
  if (ENOSPC_RE.test(stderr)) {
    return {
      detail: `The target filesystem ran out of space part-way through: ${firstRestoreError(stderr)}`,
      interrupted: true,
    }
  }
  if (EROFS_RE.test(stderr)) {
    return {
      detail: 'The target filesystem is read-only - the client only discovers this at the FIRST file, '
        + `so nothing useful was written: ${firstRestoreError(stderr)}`,
      interrupted: true,
    }
  }
  if (ENOTDIR_RE.test(stderr)) {
    return {
      detail: `The target path is not a directory: ${firstRestoreError(stderr)}`,
      interrupted: false,
    }
  }
  if (EEXIST_RE.test(stderr)) {
    return {
      detail: 'The target already holds entries this restore would replace, and the restore was not told to '
        + `overwrite them: ${firstRestoreError(stderr)}`,
      interrupted: true,
    }
  }
  const shared = classifyBackupReadVerdict(exitCode, stderr)
  return { detail: shared.detail, interrupted: false }
}

/**
 * The `reason:` line of the `.anas-restore-partial` marker (live-proof F16).
 *
 * The client's own ERROR line when it left one — else, when its whole stderr is
 * progress, how the process ENDED (`killed (signal 9)` / `exit 1`). NEVER a
 * progress line: a killed pbc's last words are `progress 22% (…)`, and writing
 * that into `reason:` reads as though the progress WAS the reason. The last
 * progress line has its own field in the marker, right below this one.
 */
export function partialMarkerReason(exitCode: number, stderr: string, signal?: string): string {
  const lines = restoreLines(stderr).map(l => l.trim()).filter(Boolean)
  // Two steps on an array we own — `toReversed()` is not in this package's TS
  // lib target (the same note as `backup-snapshots.ts`).
  const newestFirst = [...lines]
  newestFirst.reverse()
  const said = lines.find(l => l.startsWith('Error:'))
    ?? newestFirst.find(l => !isRestoreProgressLine(l))
  return said ?? describeAbnormalExit(exitCode, signal)
}

/**
 * The client-safe `Error:` line (pbc's stderr never carries the secret).
 *
 * The fallback skips PROGRESS lines: pbc's last words before a kill are
 * `progress 22% (…)`, and quoting that as the failure reads as though the
 * progress WAS the reason (live-proof F16). When there is nothing but progress
 * there is nothing to quote, and the caller says so instead.
 */
export function firstRestoreError(stderr: string): string {
  const lines = restoreLines(stderr).map(l => l.trim()).filter(Boolean)
  const error = lines.find(l => l.startsWith('Error:'))
  if (error)
    return error
  const newestFirst = [...lines]
  newestFirst.reverse()
  return newestFirst.find(l => !isRestoreProgressLine(l)) ?? 'restore failed'
}

// --- argv --------------------------------------------------------------------

export interface RestoreArgvSpec {
  snapshot: string
  archive: string
  /** The directory pbc writes into. */
  target: string
  namespace?: string
  /** One entry per selection, `/`-anchored and escaped. Empty = the whole archive. */
  patterns: string[]
  /**
   * Whether the target ALREADY EXISTED when the pre-flight looked: `inPlace`
   * always, and a `newLocation` only after its confirm gate (operator ruling
   * 2026-08-29). The merge flag pair rides on this, not on the mode's name —
   * a newLocation into a fresh directory is a `newLocation` with no flags.
   */
  merge: boolean
  options: BackupRestoreOptions
  rate?: string
}

/**
 * The `restore` argv. No secrets — those ride the environment only.
 *
 * The MERGE flag pair is `--allow-existing-dirs --overwrite` and nothing else
 * (GT-11: that is the minimal pair, and `--overwrite` does NOT imply
 * `--allow-existing-dirs`). It is emitted when the target already exists — an
 * in-place restore, or a newLocation restore the operator confirmed into an
 * existing directory — and a single explicitly picked file in a merge still
 * ships the directory flag, because GT-26 proved a file in a SUBDIRECTORY
 * needs it too — the flag is about entering the parent, not about the file.
 *
 * A restore into a directory it creates emits no overwrite flags at all:
 * there is nothing to overwrite and nothing to allow (GT-15).
 */
export function buildRestoreArgs(spec: RestoreArgvSpec): string[] {
  const args = ['restore', spec.snapshot, spec.archive, spec.target]
  if (spec.namespace)
    args.push('--ns', spec.namespace)
  for (const pattern of spec.patterns)
    args.push('--pattern', pattern)
  if (spec.merge)
    args.push('--allow-existing-dirs', '--overwrite')
  if (spec.options.ignoreOwnership)
    args.push('--ignore-ownership')
  if (spec.options.ignoreAcls)
    args.push('--ignore-acls')
  if (spec.options.ignoreXattrs)
    args.push('--ignore-xattrs')
  if (spec.options.ignorePermissions)
    args.push('--ignore-permissions')
  if (spec.rate)
    args.push('--rate', spec.rate)
  return args
}

// --- Local pre-flight probes -------------------------------------------------

/** `<target>/<archive-relative path>`, with exactly one separator. */
export function targetPathFor(target: string, selection: string): string {
  const base = target.replace(TRAILING_SLASHES_RE, '') || '/'
  const rel = selection.replace(LEADING_SLASHES_RE, '').replace(TRAILING_SLASHES_RE, '')
  if (!rel)
    return base
  return base === '/' ? `/${rel}` : `${base}/${rel}`
}

/** True when a selection names the archive ROOT (the whole tree). */
export function isArchiveRootSelection(selection: string): boolean {
  return selection.replace(TRAILING_SLASHES_RE, '').replace(LEADING_SLASHES_RE, '') === ''
}

export type WriteTestOutcome
  = | { ok: true }
    | { ok: false, detail: string }

/** What a bounded `stat` said about one path's existence. */
type PathPresence = 'present' | 'absent' | 'unknown'

/**
 * Does this path exist? A bounded `stat` through the executor, read as
 * three-valued on purpose: `absent` (the command answered and the path is not
 * there) is the only answer that sends the nearest-existing walk UP. `unknown`
 * — a timeout on a dead remote mount, or a probe that could not run at all —
 * must NOT: walking past a mountpoint would test a different filesystem and
 * green-light a restore onto a mount that never answers.
 */
async function pathPresence(executor: CommandExecutor, path: string): Promise<PathPresence> {
  let r
  try {
    r = await executor.exec(TIMEOUT, [String(SPACE_PROBE_TIMEOUT_S), STAT, '-c', '%F', path])
  }
  catch {
    return 'unknown'
  }
  if (r.exitCode === TIMEOUT_EXIT)
    return 'unknown'
  if (r.exitCode !== 0)
    return 'absent'
  return 'present'
}

/**
 * The nearest EXISTING directory at or above `path` — the directory a write
 * test must probe when the target does not exist yet (GT-15: pbc creates the
 * WHOLE missing chain with mkdir -p semantics, so what matters is that the
 * nearest ancestor that does exist accepts a write).
 *
 * The walk uses {@link parentDirectory} and stops at `/`; it also stops at the
 * first path that answers at all (even as a file — the write test then fails
 * honestly on it) or that the probe could not read (a dead mount stays where
 * it is, refusing as before).
 */
export async function nearestExistingDirectory(
  executor: CommandExecutor,
  path: string,
): Promise<string> {
  let probe = path.replace(TRAILING_SLASHES_RE, '') || '/'
  for (;;) {
    if (await pathPresence(executor, probe) !== 'absent')
      return probe
    const parent = parentDirectory(probe)
    if (parent === probe)
      return probe
    probe = parent
  }
}

/**
 * Prove the target directory is WRITABLE before anything is restored.
 *
 * GT-56 (F8) is the reason this exists: a read-only target does not fail at the
 * start — the client enters the directory happily and dies at the FIRST FILE,
 * after the operator has already committed to the restore. F8b is the reason it
 * has to be a real write rather than a permission check: as root, a `0555`
 * directory is writable, so only writing tells the truth.
 *
 * The test probes the nearest EXISTING ancestor ({@link nearestExistingDirectory}):
 * a newLocation restore into a directory whose parent chain is not built yet
 * used to fail here with `touch`'s ENOENT and read as "not writable", when pbc
 * would happily have created the whole chain (GT-15). The messages keep naming
 * the operator's path, whatever was probed.
 *
 * Both halves are `timeout`-wrapped: the directory may be on a dead remote
 * mount, and the daemon never touches a mountpoint synchronously.
 */
export async function writeTestDirectory(
  executor: CommandExecutor,
  directory: string,
  probeName = `.anas-restore-write-test-${process.pid}`,
): Promise<WriteTestOutcome> {
  const probeDir = await nearestExistingDirectory(executor, directory)
  const probe = targetPathFor(probeDir, probeName)
  let r
  try {
    r = await executor.exec(TIMEOUT, [String(WRITE_TEST_TIMEOUT_S), TOUCH, probe])
  }
  catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode === TIMEOUT_EXIT) {
    return {
      ok: false,
      detail: `'${directory}' did not answer a write within ${WRITE_TEST_TIMEOUT_S}s - `
        + 'the filesystem it sits on is not responding.',
    }
  }
  if (r.exitCode !== 0) {
    return {
      ok: false,
      detail: `'${directory}' is not writable: ${(r.stderr || '').trim() || `touch exited ${r.exitCode}`}`,
    }
  }
  // Best effort: a probe file left behind is noise, never a correctness problem.
  await executor.exec(TIMEOUT, [String(WRITE_TEST_TIMEOUT_S), RM, '-f', probe]).catch(() => undefined)
  return { ok: true }
}

/**
 * Free space on the filesystem holding `directory`, in bytes.
 *
 * `stat -f` through the executor, `timeout`-wrapped — the same hang-safe probe
 * the mounts family uses, for the same reason. Null when the probe could not
 * answer: an unknown figure is reported as unknown, never as "plenty".
 */
export async function availableBytes(
  executor: CommandExecutor,
  directory: string,
): Promise<number | null> {
  let r
  try {
    r = await executor.exec(TIMEOUT, [String(SPACE_PROBE_TIMEOUT_S), STAT, '-f', '-c', '%S %a', directory])
  }
  catch {
    return null
  }
  if (r.exitCode !== 0)
    return null
  const parts = r.stdout.trim().split(WHITESPACE_RE).map(Number)
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n)))
    return null
  return parts[0]! * parts[1]!
}

/**
 * Which of `selections` actually landed under `target`.
 *
 * One bounded `find` over the EXACT paths at `-maxdepth 0` — it never walks
 * into the tree, so a restore of a million files costs the same probe as a
 * restore of one, and nothing recurses into a directory that might sit on a
 * remote mount. `-P` never follows a symlink, so a restored link counts as
 * itself. A path that is not there makes `find` write to stderr and carry on,
 * which is exactly the signal wanted.
 *
 * A selection naming the archive ROOT is verified as "the target exists": a
 * pattern-less restore cannot suffer GT-24's silent no-match, because there is
 * no pattern to miss.
 */
export async function verifyRestored(
  executor: CommandExecutor,
  target: string,
  selections: string[],
): Promise<{ restored: string[], missing: string[], detail?: string }> {
  if (selections.length === 0)
    return { restored: [], missing: [] }
  const probes = selections.map(s => targetPathFor(target, s))
  let r
  try {
    r = await executor.exec(TIMEOUT, [
      String(VERIFY_TIMEOUT_S),
      FIND,
      '-P',
      ...probes,
      '-maxdepth',
      '0',
      '-printf',
      '%p\n',
    ])
  }
  catch (err) {
    return { restored: [], missing: [], detail: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode === TIMEOUT_EXIT) {
    return {
      restored: [],
      missing: [],
      detail: `The restored tree could not be checked within ${VERIFY_TIMEOUT_S}s - what landed is unverified.`,
    }
  }
  const present = new Set(restoreLines(r.stdout))
  const restored: string[] = []
  const missing: string[] = []
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i]!
    if (present.has(probes[i]!))
      restored.push(selection)
    else
      missing.push(selection)
  }
  return { restored, missing }
}

/**
 * Write the `.anas-restore-partial` marker into a newLocation directory the
 * restore could not finish, or say why it did not.
 *
 * Best effort by contract: a marker that cannot be written must never replace
 * the real failure the caller is about to report.
 */
export async function writePartialMarker(
  directory: string,
  text: string,
): Promise<string | null> {
  const path = targetPathFor(directory, PARTIAL_MARKER_NAME)
  try {
    await writeFile(path, `${text}\n`, { encoding: 'utf8', mode: 0o600 })
    return path
  }
  catch {
    return null
  }
}

/** Does the directory hold anything at all? Null when the probe could not say. */
export async function directoryHasEntries(
  executor: CommandExecutor,
  directory: string,
): Promise<boolean | null> {
  let r
  try {
    r = await executor.exec(TIMEOUT, [
      String(VERIFY_TIMEOUT_S),
      FIND,
      '-P',
      directory,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-printf',
      '.',
    ])
  }
  catch {
    return null
  }
  if (r.exitCode === TIMEOUT_EXIT)
    return null
  if (r.exitCode !== 0 && !r.stdout)
    return null
  return r.stdout.length > 0
}

/**
 * Remove an EMPTY newLocation directory the restore created (never a
 * recursive delete — and only ever a directory the restore itself owns).
 */
export async function removeEmptyDirectory(
  executor: CommandExecutor,
  directory: string,
): Promise<boolean> {
  try {
    const r = await executor.exec(TIMEOUT, [String(WRITE_TEST_TIMEOUT_S), RM, '-d', '-f', directory])
    return r.exitCode === 0
  }
  catch {
    return false
  }
}

// --- The run -----------------------------------------------------------------

export interface FileRestoreDeps extends BackupReadDeps {
  snapshot: string
  archive: string
  /** The directory pbc writes into (already resolved and pre-flighted). */
  target: string
  mode: BackupRestoreTargetMode
  /**
   * Ran with the MERGE flags: `inPlace` always; `newLocation` only when its
   * chosen directory already existed and passed the confirm gate. This — not
   * the mode — decides the argv (buildRestoreArgs) and what a failure may
   * clean up below.
   */
  merge: boolean
  /** The selection AFTER hardlink completion. */
  selections: string[]
  /** Paths the pre-flight added to complete a hardlink group. */
  addedForHardlinks?: string[]
  options: BackupRestoreOptions
  rate?: string
  /** Warnings gathered by the pre-flight, carried onto the result. */
  warnings?: string[]
}

/**
 * Run ONE file restore and report what actually landed.
 *
 * On success the job still VERIFIES: `--pattern` that matches nothing is a
 * silent success (GT-24), so exit 0 is not proof and the daemon says which
 * selections are not there. A non-empty `missing` list makes the job complete
 * WITH WARNINGS rather than plainly — the operator asked for those paths.
 *
 * On failure the rule is WHOSE the directory is:
 *
 *   - a `newLocation` restore that CREATED its target — the directory is
 *     ANAS's: it is labelled `partial` (or removed when it is empty) and the
 *     error is re-thrown so the job fails truthfully;
 *   - a MERGE into a directory that already existed (an in-place restore, or a
 *     newLocation confirmed through the gate) — the tree belongs to the
 *     operator. NOTHING is removed and no marker is written: writing a file
 *     into the operator's data to describe our own failure is not ours to do.
 *     The error says how far the client got and names the one forensic hint
 *     the client leaves — an in-flight file that is short AND mode `0600`
 *     (GT-60).
 */
export async function runFileRestore(
  executor: CommandExecutor,
  deps: FileRestoreDeps,
  updateProgress: (message: string) => void,
): Promise<BackupFilesRestoreResult> {
  const patterns = restorePatternsFor(deps.selections)
  const warnings = [...(deps.warnings ?? [])]
  const merge = deps.merge

  updateProgress(
    `restoring ${deps.archive} from ${deps.snapshot} into ${deps.target} `
    + `(${patterns.length ? `${patterns.length} selection(s)` : 'the whole archive'}, `
    + `${deps.mode === 'inPlace'
      ? 'in place - a MERGE, never a sync'
      : merge
        ? `into an EXISTING directory - a MERGE, never a sync`
        : 'a new directory at the chosen path, created by this restore'})`,
  )
  updateProgress('pbc reports restore progress at widening intervals (about 6s, 16s, 36s, 79s) - silence is not a stall')

  const args = buildRestoreArgs({
    snapshot: deps.snapshot,
    archive: deps.archive,
    target: deps.target,
    ...(deps.namespace ? { namespace: deps.namespace } : {}),
    patterns,
    merge,
    options: deps.options,
    ...(deps.rate ? { rate: deps.rate } : {}),
  })

  let r: { exitCode: number, stderr: string, signal?: string }
  try {
    r = await executor.exec(PBC, args, { env: buildBackupEnv(deps.repo, deps.secret) })
  }
  catch (err) {
    throw new Error(`proxmox-backup-client could not be started: ${err instanceof Error ? err.message : String(err)}`)
  }

  const parsed = parseRestoreProgress(r.stderr)
  for (const line of parsed.progress)
    updateProgress(line.line)
  updateProgress(progressSummaryLine(parsed))

  const base = {
    kind: 'files' as const,
    repository: deps.repo.name,
    ...(deps.namespace ? { namespace: deps.namespace } : {}),
    snapshot: deps.snapshot,
    archive: deps.archive,
    mode: deps.mode,
    target: deps.target,
    merge,
    selections: deps.selections,
    addedForHardlinks: deps.addedForHardlinks ?? [],
    patterns,
    progress: parsed.progress,
    ...(parsed.completeLine ? { completeLine: parsed.completeLine } : {}),
    ...(parsed.bytes !== undefined ? { bytes: parsed.bytes } : {}),
  }

  if (r.exitCode !== 0) {
    const { detail } = classifyRestoreFailure(r.exitCode, r.stderr, r.signal)
    const partialText = [
      'ANAS restore did not finish.',
      `snapshot: ${deps.snapshot}`,
      `archive: ${deps.archive}`,
      `target: ${deps.target}`,
      `selections: ${deps.selections.length}`,
      `reason: ${partialMarkerReason(r.exitCode, r.stderr, r.signal)}`,
      `detail: ${detail}`,
      `last progress: ${progressSummaryLine(parsed)}`,
      'The Proxmox backup client leaves no marker of its own; this file is written by ANAS.',
      'An in-flight file is short AND mode 0600 - that is the only hint the client leaves.',
    ].join('\n')

    let suffix = ''
    if (merge) {
      // The restore wrote INTO a directory that already existed — the live
      // home in place, or a newLocation the operator confirmed. That tree is
      // the operator's: nothing is removed, and no marker is written into it.
      suffix = ` '${deps.target}' was restored INTO and is now a mixture of its previous contents and `
        + 'a partial restore. The client leaves no marker; an in-flight file is short AND mode 0600.'
    }
    else {
      // The only mode left that creates its own directory: a newLocation into
      // a path that did not exist. ANAS owns that directory, so it is labelled
      // (or removed when empty) — NEVER a pre-existing directory, which the
      // `merge` branch above takes care of without touching it.
      const hasEntries = await directoryHasEntries(executor, deps.target)
      if (hasEntries === false) {
        // Nothing landed at all — leave no litter.
        await removeEmptyDirectory(executor, deps.target)
        suffix = ` The empty restore directory '${deps.target}' was removed.`
      }
      else {
        const marker = await writePartialMarker(deps.target, partialText)
        suffix = marker
          ? ` '${deps.target}' holds a PARTIAL tree and is labelled '${PARTIAL_MARKER_NAME}'.`
          : ` '${deps.target}' holds a PARTIAL tree (the partial marker could not be written).`
      }
    }
    throw new Error(`${detail}${suffix} Last progress: ${progressSummaryLine(parsed)}`)
  }

  const verified = await verifyRestored(executor, deps.target, deps.selections)
  if (verified.detail)
    warnings.push(verified.detail)
  for (const missing of verified.missing) {
    warnings.push(
      `'${missing}' is not under '${deps.target}' - the client reports success for a selection that matched `
      + 'nothing, and an empty directory cannot be restored by a pattern at all.',
    )
  }
  if (merge) {
    warnings.push(
      deps.mode === 'inPlace'
        ? 'An in-place restore is a MERGE, never a sync: files under the target that are not in the archive '
        + 'were left exactly as they were.'
        : `The chosen directory '${deps.target}' already existed, so this restore MERGED into it: files with `
          + 'the same names were replaced, and everything else under it was left exactly as it was.',
    )
  }

  // A retry that COMPLETES removes the marker a failed run left behind: a
  // `.anas-restore-partial` sitting in a directory whose restore just finished
  // is a lie about the tree below it. Only ANAS's own marker at ANAS's own
  // name is ever removed — the exact path this module writes, nothing else.
  const markerPath = targetPathFor(deps.target, PARTIAL_MARKER_NAME)
  if (await pathKind(executor, markerPath) !== null) {
    const removed = await executor
      .exec(TIMEOUT, [String(WRITE_TEST_TIMEOUT_S), RM, '-f', markerPath])
      .then(r => r.exitCode === 0)
      .catch(() => false)
    if (removed)
      updateProgress(`removed the '${PARTIAL_MARKER_NAME}' left by a failed earlier restore into '${deps.target}'`)
    else
      warnings.push(`'${markerPath}' is the partial marker of a failed earlier restore and could not be removed.`)
  }

  const status = verified.missing.length > 0 ? 'completed-with-warnings' : 'completed'
  return {
    ...base,
    status,
    restored: verified.restored,
    missing: verified.missing,
    warnings,
  }
}

// --- Pre-flight: protected targets, hardlink groups, space -------------------

/**
 * Why this directory is PVE's and not ours — or null when it is not.
 *
 * `/mnt/pve` is reserved and every path `storage.cfg` names is PVE-managed.
 * PVE territory is read-only and hands-off, always: this is a hard refusal
 * with no confirm bypass, not a gate. It is not "dangerous but sometimes
 * right", it is somebody else's storage.
 *
 * The OTHER protected target — a live iSCSI LUN's backing object — is not
 * checked here on purpose. `heldByLun()` (story iscsi.6) is the ONE question
 * the rest of ANAS asks before it touches anything a LUN might be serving, and
 * a restore asks it the same way with the same wording rather than growing a
 * second reader and a second phrasing.
 */
export function pveTerritoryReason(
  target: string,
  pveMountPaths: string[],
): string | null {
  const path = target.replace(TRAILING_SLASHES_RE, '') || '/'
  if (isPathWithin('/mnt/pve', path)) {
    return `'${target}' is under /mnt/pve, which belongs to Proxmox - PVE territory is read-only for ANAS. `
      + 'Restore somewhere ANAS manages and move the files yourself if that is what you want.'
  }
  if (isPathWithin('/etc/pve', path))
    return `'${target}' is inside /etc/pve, the Proxmox cluster filesystem - ANAS never writes there.`
  for (const pvePath of pveMountPaths) {
    if (isPathWithin(pvePath, path)) {
      return `'${target}' is inside '${pvePath}', a path Proxmox's storage.cfg claims - PVE territory is `
        + 'read-only for ANAS. Restore somewhere ANAS manages instead.'
    }
  }
  return null
}

/** What the catalog `stat` pass concluded about a restore's selection. */
export interface SelectionFacts {
  /** The selection AFTER hardlink completion, in order, deduplicated. */
  selections: string[]
  /** Paths added because a hardlink group was only partly named (GT-25). */
  addedForHardlinks: string[]
  /** True when at least one selection is a DIRECTORY — the confirm gate's trigger. */
  hasDirectory: boolean
  /** Selections the archive does not hold at all. */
  unknown: string[]
  /** Sum of the FILE selections' sizes, when every selection had a known size. */
  exactBytes: number | null
  /** Non-fatal notes (a stat pass that could not run at all). */
  warnings: string[]
}

/**
 * Resolve one hardlink `stat` block's target into an archive-absolute path.
 *
 * pbc renders a hardlink as a symlink pointing at the group's PRIMARY name, and
 * live-proof wave 2 settled the form the client actually emits: the primary's
 * path **relative to the ARCHIVE ROOT, without a leading slash** — never a
 * sibling name, wherever the two names sit:
 *
 *     File: /a/z      -> "a/x"        (same directory)
 *     File: /b/y      -> "a/x"        (different directory)
 *     File: /c/deep/w -> "a/x"        (deeper directory)
 *     File: /rootlink -> "rootfile"   (archive root — where the two readings coincide,
 *                                      which is why the earlier capture read as "bare sibling")
 *
 * Reading a bare target as a sibling produced `/b/a/x` for the second case: a
 * pattern that matches nothing, so the completed group was not in fact complete
 * and pbc died with `failed to extract hardlink: ENOENT` — the exact GT-25
 * failure the completion exists to prevent.
 *
 * An ABSOLUTE target is kept as-is: it is archive-absolute already, and leaving
 * that branch in costs nothing if a future client version emits it.
 */
export function hardlinkPrimaryPath(_selection: string, target: string): string | null {
  if (!target)
    return null
  if (target.startsWith('/'))
    return target.replace(TRAILING_SLASHES_RE, '') || '/'
  const rooted = `/${target.replace(TRAILING_SLASHES_RE, '')}`
  return rooted === '/' ? null : rooted
}

/**
 * Ask the catalog what the selection IS, before anything runs.
 *
 * ONE `catalog shell` session answers all three questions the pre-flight has
 * (GT-8h: 500 stats in one session cost 0.083 s), and the third is the one that
 * cannot be skipped: GT-25 measured a hardlink's SECOND name restored alone
 * failing the ENTIRE job with `ENOENT`. There is no client flag for it, so the
 * daemon completes the group itself and says on the record that it did.
 *
 * FAIL-OPEN on a session that never started (an unreachable server, a bad
 * credential): the restore itself is about to produce the same error, better
 * placed, and refusing here would only replace one message with a worse one. A
 * PER-PATH miss is different — the shell answered and said that path is not in
 * the archive — and lands in `unknown` for the caller to refuse.
 */
export async function readSelectionFacts(
  executor: CommandExecutor,
  deps: BrowseArchiveDeps,
  selections: string[],
): Promise<SelectionFacts> {
  const facts: SelectionFacts = {
    selections: [...selections],
    addedForHardlinks: [],
    hasDirectory: selections.some(isArchiveRootSelection),
    unknown: [],
    exactBytes: null,
    warnings: [],
  }

  const out = await statArchivePaths(executor, deps, selections)
  if (!out.ok) {
    facts.warnings.push(
      `The archive catalog could not be read before the restore (${out.detail}) - hardlink groups were not `
      + 'completed and the size estimate falls back to the whole archive.',
    )
    // Not knowing means assuming the widest case: a tree.
    facts.hasDirectory = true
    return facts
  }

  facts.unknown = out.missing
  const seen = new Set(selections)
  let bytes = 0
  let sizesKnown = !selections.some(isArchiveRootSelection)
  for (const selection of selections) {
    const stat = out.stats.get(selection)
    if (!stat) {
      sizesKnown = false
      continue
    }
    if (stat.rawType === 'directory') {
      facts.hasDirectory = true
      sizesKnown = false
      continue
    }
    if (isHardlinkStat(stat)) {
      const primary = hardlinkPrimaryPath(selection, stat.target ?? '')
      if (primary && !seen.has(primary)) {
        seen.add(primary)
        facts.selections.push(primary)
        facts.addedForHardlinks.push(primary)
      }
      // A hardlink's payload is its primary's; counting it twice would inflate
      // the estimate, and pbc reports it as size 0 anyway.
      continue
    }
    if (typeof stat.size === 'number' && Number.isFinite(stat.size))
      bytes += stat.size
    else
      sizesKnown = false
  }
  if (sizesKnown)
    facts.exactBytes = bytes
  if (facts.addedForHardlinks.length) {
    facts.warnings.push(
      `Added ${facts.addedForHardlinks.length} hardlink partner(s) to the selection `
      + `(${facts.addedForHardlinks.join(', ')}) - restoring one name of a hardlink group without the others `
      + 'fails the whole restore.',
    )
  }
  return facts
}

/** The space verdict: how much is needed, how much is free, and how sure we are. */
export interface SpaceEstimate {
  /** Bytes the restore may need. Null when nothing could be estimated. */
  required: number | null
  /** Bytes free on the target filesystem. Null when the probe could not answer. */
  available: number | null
  /**
   * True when `required` is the exact sum of the picked files' sizes; false
   * when it is the WHOLE archive's logical size, which is only an upper bound
   * for a partial selection.
   */
  exact: boolean
  /** True when the restore does not fit and must be refused. */
  refuse: boolean
  /** The refusal text, naming BOTH numbers. */
  detail?: string
}

/**
 * Does this restore fit?
 *
 * The figure is the best one available, and which one it is gets SAID:
 *
 *   - every selection is a FILE ⇒ the exact sum of their sizes, straight from
 *     the catalog. This is what makes restoring one file out of a 10 TiB
 *     archive onto a small dataset possible at all;
 *   - anything else (a directory, the whole tree, a catalog that could not be
 *     read) ⇒ the manifest's `files[].size`, which GT-4 established as the
 *     LOGICAL archive size and therefore an upper bound.
 *
 * A restore that does not fit is REFUSED rather than started: running out of
 * space part-way leaves a half-written tree, and with an in-place restore that
 * tree is the operator's live data.
 */
export function estimateSpace(
  requiredBytes: number | null,
  exact: boolean,
  available: number | null,
  target: string,
): SpaceEstimate {
  const estimate: SpaceEstimate = { required: requiredBytes, available, exact, refuse: false }
  if (requiredBytes === null || available === null)
    return estimate
  if (requiredBytes <= available)
    return estimate
  estimate.refuse = true
  estimate.detail = exact
    ? `The selection needs ${requiredBytes} bytes and '${target}' has ${available} bytes free.`
    : 'This selection includes a directory, so the size is not known exactly; the whole archive is '
      + `${requiredBytes} bytes and '${target}' has ${available} bytes free. Pick fewer entries, free space, `
      + 'or restore somewhere with more room.'
  return estimate
}

/**
 * What a path IS — the `stat -c %F` answer (`directory`, `regular file`, …) —
 * or null when the path does not exist, or the probe itself could not say
 * (a timeout: a dead mount must not wedge a request).
 *
 * A bounded `stat` through the executor — never a bare `fs.stat`, because the
 * path may sit on a remote mount that never answers. A restore pre-flight
 * reads the KIND, not just existence: an existing DIRECTORY is a confirm gate,
 * an existing FILE is a refusal, and a null answer falls through to the write
 * test, which re-asks the filesystem for real.
 */
export async function pathKind(
  executor: CommandExecutor,
  path: string,
): Promise<string | null> {
  let r
  try {
    r = await executor.exec(TIMEOUT, [String(SPACE_PROBE_TIMEOUT_S), STAT, '-c', '%F', path])
  }
  catch {
    return null
  }
  if (r.exitCode !== 0)
    return null
  return r.stdout.trim() || null
}

/** The parent directory of an absolute path (`/` is its own parent). */
export function parentDirectory(path: string): string {
  const base = path.replace(TRAILING_SLASHES_RE, '')
  const idx = base.lastIndexOf('/')
  if (idx <= 0)
    return '/'
  return base.slice(0, idx)
}

/**
 * The bare archive NAME behind a pbc archive argument: `data.pxar` → `data`.
 *
 * A task stores archive names without their type suffix (the runner adds it),
 * so this is what joins a restore request back to the task archive that knows
 * the live home. An EXPANDED archive (`data__photos`, backup2.3) deliberately
 * will not match: its name was derived from a nested filesystem path with `/`
 * flattened to `_`, which cannot be inverted — so the caller names the target
 * directory instead, and nothing is guessed.
 */
export function bareArchiveName(archive: string): string {
  return archive.replace(ARCHIVE_SUFFIX_RE, '')
}
