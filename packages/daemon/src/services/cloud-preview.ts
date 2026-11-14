import type { CloudSyncPreviewResult, CloudSyncTask } from '@anas/shared'
import type { CommandExecutor, SpawnedChild } from '../executor/types.js'
import type { RcloneLogState, RcloneStats } from './cloud-runner.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { stat } from 'node:fs/promises'
import { CommandTimeoutError } from '../executor/deadline.js'
import {
  buildRcloneArgs,
  DELETED_FILES_CAP,
  execRcloneLog,
  finalStats,
  missingSourceRefusal,
  rcloneFailureMessage,
  rcloneRunCompleted,
  readCloudSourceView,
  snapshotSyncRefusal,
  sourceNotAnsweringRefusal,
} from './cloud-runner.js'
import { RCLONE, remoteSecretValues } from './rclone-config.js'
import { assertNoSecretValues, maskSecretValues } from './secret-argv.js'
import { guardSourcePath, readSourceGuardFacts } from './source-guard.js'

/**
 * The dry-run PREVIEW (rclone.2 addendum, operator 2026-09-24): the same
 * rclone command a run would issue, with `--dry-run` and a wall ceiling, read
 * against the LIVE source. DESIGN's words: "a preview is a look, not a run" —
 * so it takes NO snapshot (a transient would be pure cost the look does not
 * pay), it answers with rclone's own counters, and it writes nothing. Since
 * cr.48 (operator ruling 2026-10-15) the look runs as a cancellable READ job
 * with a ceiling of minutes: the route checks the source here
 * ({@link checkPreviewSource}, a 400 at the door) and the job runs
 * {@link runPreview}.
 *
 * What it reuses, and why the preview is thin:
 *   - `buildRcloneArgs` with `dryRun: true` — ONE argv builder; the preview
 *     is the run's command plus one flag, never a second argv;
 *   - the JSON-log reader and `finalStats` — the counters in the answer are
 *     rclone's LAST `stats` object, exactly as on a run;
 *   - the source guard's unmounted-mount check — the SAME sentence a run
 *     throws (a preview that read through a dead mount would report an empty
 *     source as "nothing to do", which is a lie);
 *   - the missing-source refusal, word for word.
 *
 * What it deliberately does NOT reuse:
 *   - the empty-source guard. A `sync` preview of an empty source answering
 *     "would delete N files" is the whole point of the feature — the
 *     protection for the real run stays the guard, and the preview is what
 *     shows the operator what that protection is standing in front of.
 *   - the transient snapshot (see above), the job, the notification and the
 *     cadence gate. The consistency derivation IS reused since cr3
 *     (CLOUD-H3): it decides whether the run reads a snapshot, and with it
 *     which nested filesystems the look must leave out to count what the run
 *     will do.
 *
 * Ground truth the parsing is built on (DESIGN + GT 2026-09-24, rclone 1.60.1,
 * stunt node — the fixtures under `fixtures/rclone/dry-run-*`):
 *   - a would-be TRANSFER is a `skipped: copy` object; rclone counts it in
 *     `stats.transfers`, so the result's `transfers`/`bytes` come from the
 *     final stats object and the list of what would move is never needed;
 *   - a would-be DELETE is a `skipped: delete` object naming the file under
 *     `object` (destination-relative) — the ONLY per-file fact the preview
 *     reports, collected by the reader as `skippedDeletes`;
 *   - the final `stats` object is printed even for a preview that does
 *     nothing (a `copy` over a complete destination), so the counters are
 *     rclone's on every exit `timeout` allows;
 *   - the `timeout` wrapper's exit is 124 when it fires. A preview that hits
 *     the ceiling is NOT an error: the answer is what rclone had logged by
 *     then, with `truncated: true` saying so.
 */

/** `timeout` binary — wraps the preview so a stalled remote can never hang the door. */
const TIMEOUT = '/usr/bin/timeout'
const REALPATH = '/usr/bin/realpath'

/**
 * The whole preview's wall ceiling, in seconds (the `timeout` argument): ten
 * minutes (cr.48, operator ruling 2026-10-15 — "minutes, not seconds").
 *
 * The preview is a JOB now, so the gateway's 20 s socket budget no longer
 * bounds it (cr.35r's 12 s was that budget's arithmetic). A dry run walks the
 * whole source and lists the whole destination: a large tree against a slow
 * remote legitimately takes minutes, and the operator can stop it at any
 * time (the dialog's Cancel). The wrapper stays because its exit 124 is what
 * makes a ceiling hit read as itself — `truncated: true` with the counts so
 * far — and never as the executor's job-lane timeout, whose sentence ("what
 * it was acting on is in an unknown state") would be a lie about a read. The
 * executor's own deadline sits the wrapper margin (5 s) above it.
 */
export const PREVIEW_TIMEOUT_S = 600

/** `timeout`'s own exit code when it is the one that killed the child. */
export const TIMEOUT_EXIT_CODE = 124

/**
 * The cap on `deletedFiles` — ONE constant, defined with the reader that
 * enforces it while the log is still arriving (`cloud-runner.ts`) and
 * re-exported here because the answer's shape is this file's contract.
 * `deletedTotal` is always the whole number.
 */
export { DELETED_FILES_CAP }

/**
 * A preview REFUSAL: the unmounted mount, the missing source — the run's own
 * sentences, thrown by the guards below and answered 400 at the door. Typed
 * on purpose: the route must not read an internal fault (a broken executor,
 * a bug in the parser) as "the operator's request was invalid" and dress it
 * up as a 400. Only what this class carries is the operator's to fix.
 */
export class PreviewRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewRefusal'
  }
}

/**
 * The fields a preview needs of a task — the stored task satisfies them and
 * so does the wizard's inline form (`CloudSyncPreviewTask`), which is why the
 * route can hand either one straight over.
 */
export type PreviewTask = Pick<CloudSyncTask, 'source' | 'remote' | 'path' | 'mode' | 'excludes' | 'bwlimit'>

/** What the job body hands the look (cr.48): the cancel seam and the progress line. */
export interface PreviewRunHooks {
  /** The exec's `onSpawn` — the job's read-cancel hook takes the child here. */
  onSpawn?: (child: SpawnedChild) => void
  /** Called before the exec: throws (JobCancelledError) when a cancel was already accepted. */
  checkpoint?: (next: string) => void
  /** rclone's periodic stats, as one progress line ({@link previewProgressLine}). */
  updateProgress?: (line: string) => void
}

/**
 * One periodic stats object as the preview job's progress line — rclone's own
 * counters, labelled, nothing derived (the run's `statsProgressLine` idiom, in
 * the would-be words of a dry run).
 */
export function previewProgressLine(stats: RcloneStats): string {
  return `${stats.checks} checked, ${stats.transfers} to transfer (${stats.bytes} bytes), ${stats.deletes} to delete`
}

export interface CloudPreviewDeps {
  task: PreviewTask
  /** Where ANAS's own rclone.conf lives (every invocation names it). */
  paths: RcloneConfigPaths
  /** The fstab the source guard reads (the Mounts path, overridable for tests). */
  fstabPath: string
  /**
   * Plain secret values HANDED to the child, for the argv guard — normally
   * none (rclone reads every credential from the config file), the structural
   * backstop that would fire if that ever stopped being true. Uniform with the
   * run. They are masked out of the answer too; the remote's STORED
   * credentials are not passed here — {@link runPreview} reads them itself
   * (cr.55), so no caller can forget them and no test can feed the mask.
   */
  secrets?: string[]
  /** Passed through to the consistency derivation (the PVE storage.cfg override), as the run's. */
  consistencyOptions?: { pveStorageCfg?: string }
  /**
   * The source's real path as {@link checkPreviewSource} resolved it (the
   * source guard's bounded `realpath -e`); absent, the path as written. The
   * consistency and the nested scan are judged on it, as the run judges them
   * (cr3 CLOUD-M4).
   */
  realSource?: string
  /**
   * A reader's preview (cr3 CORE-L9, review fix 6): rclone is handed
   * `realSource` — the path whose bound was checked — and the job re-resolves
   * the source first and refuses if it no longer leads there (a symlink
   * swapped between the check and the look).
   */
  pinRealSource?: boolean
}

/**
 * The preview's deps, built ONE way (cr.55, review 2026-10-16 W5): the route
 * builds them with this and so do the unit tests, so a test cannot hand the
 * service something the route never would. The secret list the answer is
 * masked with is NOT a field here — {@link runPreview} derives it from the
 * remote the task names, in the config file the route points it at.
 */
export function cloudPreviewDeps(
  task: PreviewTask,
  paths: RcloneConfigPaths,
  fstabPath: string,
  consistencyOptions?: { pveStorageCfg?: string },
): CloudPreviewDeps {
  return { task, paths, fstabPath, ...(consistencyOptions ? { consistencyOptions } : {}) }
}

/**
 * Preview one cloud sync. Throws a {@link PreviewRefusal} on a guard refusal
 * (the unmounted mount, the missing source — the run's own sentences, which
 * the route answers 400 with, and the ONLY throw the route reads as the
 * operator's fault); a rclone FAILURE (an unknown remote, an auth failure) is
 * NOT a throw: the preview is a read, and its answer carries rclone's error
 * lines in `errors` with the counters it reported — and when rclone failed
 * without logging a line at all, the run's own failure sentence instead, so a
 * dead child never reads as "nothing to do". On the wall ceiling it returns
 * what was parsed so far with `truncated: true`, never an error.
 */
export async function previewCloudSync(
  executor: CommandExecutor,
  deps: CloudPreviewDeps,
  hooks: PreviewRunHooks = {},
): Promise<CloudSyncPreviewResult> {
  const realSource = await checkPreviewSource(executor, deps)
  return runPreview(executor, { ...deps, realSource }, hooks)
}

/**
 * The preview's guards — the run's own, minus the empty-source one. Throws a
 * {@link PreviewRefusal} with the run's sentence; the route answers it 400
 * BEFORE the job is submitted (cr.48), so the refusal still arrives as the
 * door's answer, not as a failed job. Returns the source's real path (the
 * guard's bounded `realpath -e`, or the path as written), which the look
 * judges consistency on ({@link CloudPreviewDeps.realSource}).
 */
export async function checkPreviewSource(
  executor: CommandExecutor,
  deps: CloudPreviewDeps,
): Promise<string> {
  const { task } = deps
  // The unmounted-mount check first: the one that explains an empty
  // directory, and the only one that can answer without touching the path.
  const guardFacts = await readSourceGuardFacts(executor, deps.fstabPath, [task.source])
  const refusal = guardSourcePath(task.source, guardFacts)
  if (refusal)
    throw new PreviewRefusal(refusal)
  // cr3 CLOUD-M6: the run's liveness probe, before the in-process stat below.
  const dead = await sourceNotAnsweringRefusal(executor, task.source)
  if (dead)
    throw new PreviewRefusal(dead)

  // The source must be a DIRECTORY that exists — LIVE. A preview takes no
  // snapshot, so this is the same check the run makes, on the live tree.
  const dirStat = await stat(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (dirStat instanceof Error || !dirStat.isDirectory())
    throw new PreviewRefusal(missingSourceRefusal(task.source))

  // Deliberately ABSENT: the empty-source guard. A `sync` preview of an empty
  // source reporting "would delete everything" is the point.
  // The real path the look will read, resolved CHECKED: a resolution that
  // failed or did not answer refuses (never "the path as written").
  const real = await resolveSourceChecked(executor, task.source)
  if ('problem' in real)
    throw new PreviewRefusal(`${task.source} could not be resolved (${real.problem}) - nothing was read`)
  return real.real
}

const TIMEOUT_EXITS = new Set([124, 137])

/**
 * `realpath -e` of the source in a child bounded by `timeout` (the hang
 * trap), CHECKED: the real path, or why it could not be had — a failure or a
 * timeout is never read as "the path as written". The argv is the source
 * guard's own (`timeout -s KILL 5 realpath -e -- <path>`); MERGE: the backup
 * area could export a checked form of source-guard.ts `resolvePath` to replace
 * this one.
 */
export async function resolveSourceChecked(executor: CommandExecutor, path: string): Promise<{ real: string } | { problem: string }> {
  let r
  try {
    r = await executor.exec(TIMEOUT, ['-s', 'KILL', '5', REALPATH, '-e', '--', path])
  }
  catch (err) {
    // The executor's own deadline is a read that did not answer; any other
    // throw is an internal fault and stays one (never a 400 about the input).
    if (err instanceof CommandTimeoutError)
      return { problem: 'realpath did not answer' }
    throw err
  }
  // Third review (D4): strip exactly ONE trailing newline — a directory name
  // may end in whitespace, and a trimmed answer would preview another tree.
  const out = r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout
  if (r.exitCode === 0 && out.startsWith('/') && !out.includes('\n'))
    return { real: out }
  if (TIMEOUT_EXITS.has(r.exitCode))
    return { problem: 'realpath did not answer within 5 s' }
  return { problem: `realpath exited ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]}` : ''}` }
}

/**
 * The look itself: the run's argv plus `--dry-run`, under the
 * {@link PREVIEW_TIMEOUT_S} wrapper. A rclone failure is NOT a throw (see
 * {@link previewCloudSync}); a cancel stops the child through `hooks.onSpawn`
 * and the job ends `cancelled` whatever this returns.
 */
export async function runPreview(
  executor: CommandExecutor,
  deps: CloudPreviewDeps,
  hooks: PreviewRunHooks = {},
): Promise<CloudSyncPreviewResult> {
  const { task } = deps
  // cr3 CORE-L9 / review fix 6 (corrected by the second review): the look
  // reads the REAL path the door resolved — re-resolved here first, and
  // refused when it now leads elsewhere OR when the re-resolution itself
  // failed or did not answer (a read that failed never reads as "unchanged").
  let source = task.source
  if (deps.pinRealSource === true && deps.realSource !== undefined) {
    const now = await resolveSourceChecked(executor, task.source)
    if ('problem' in now)
      throw new Error(`${task.source} could not be checked again before the look (${now.problem}) - nothing was read`)
    if (now.real !== deps.realSource) {
      throw new Error(deps.realSource === task.source
        ? `${task.source} now resolves to ${now.real} (it was not a link when the preview was asked for) - nothing was read; run the preview again`
        : `${task.source} now resolves to ${now.real}, not to ${deps.realSource} as when the preview was asked for - nothing was read; run the preview again`)
    }
    source = deps.realSource
  }
  // cr3 CLOUD-H3: the look reads the live tree, the run a snapshot of it. A
  // snapshot holds one filesystem, so for a snapshot-mode task the look gets
  // the run's own nested-filesystem excludes AND `--one-file-system` — it
  // then counts what the run will copy and delete, not what the live tree
  // holds across its mounts. A sync the run would refuse (the complete nested
  // read failed, or a nested name cannot be left out) fails the look with the
  // run's sentence. The look needs no boundary walk: the excludes come from
  // the complete reads.
  const view = await readCloudSourceView(executor, task.source, deps.realSource ?? task.source, deps.consistencyOptions ?? {}, { walk: false })
  const refusedSync = snapshotSyncRefusal(view, task.source, task.mode)
  if (refusedSync)
    throw new Error(refusedSync)
  const args = buildRcloneArgs(task, deps.paths.configFile, source, {
    dryRun: true,
    excludes: view.excludes,
    oneFileSystem: view.snapshot,
  })
  // The executor-side argv backstop, uniform with every other rclone call
  // ANAS makes (the run's own call, over the same argv).
  assertNoSecretValues(args, deps.secrets ?? [])

  // cr.55 (review 2026-10-16 M1): the remote's OWN credentials — stored in
  // rclone.conf, transitive over the remotes it wraps — are what rclone can
  // echo; until cr.55 the route built these deps without them and the mask
  // below ran over an empty list. Read here, at the boundary, by the one
  // builder the Test and the run use (in process, no rclone call, no argv).
  const secrets = [...(deps.secrets ?? []), ...await remoteSecretValues(deps.paths.configFile, task.remote)]

  hooks.checkpoint?.('the dry run')
  const { exitCode, log } = await execRcloneLog(
    executor,
    TIMEOUT,
    [String(PREVIEW_TIMEOUT_S), RCLONE, ...args],
    hooks.updateProgress ? stats => hooks.updateProgress?.(previewProgressLine(stats)) : undefined,
    hooks.onSpawn,
  )
  const stats = finalStats(log)
  const truncated = exitCode === TIMEOUT_EXIT_CODE
  // cr.48b: the errors are rclone's own stderr lines — the one stderr-derived
  // string in the answer. Whatever the child echoed of a secret value in scope
  // (the remote's stored credentials, cr.55) is replaced AT the result, ONE
  // pass, after the parsing read the raw text (only what leaves is masked).
  return {
    transfers: stats.transfers,
    bytes: stats.bytes,
    checks: stats.checks,
    deletes: stats.deletes,
    // The reader already stopped at the cap; the slice is belt and braces
    // against a future caller handing over a state built some other way.
    deletedFiles: log.skippedDeletes.slice(0, DELETED_FILES_CAP),
    deletedTotal: log.skippedDeleteCount,
    errors: previewErrors(task.mode, exitCode, truncated, log).map(e => maskSecretValues(e, secrets)),
    truncated,
  }
}

/**
 * The `errors` the answer carries. rclone's own error lines when it logged
 * any — and, when it FAILED without logging one, a sentence saying so.
 *
 * The case this exists for: a run that dies before its JSON logger is up (a
 * panic, a pre-logger message), that is killed by a signal (exit 1, empty
 * output), or that `timeout` itself could not start (125/126/127). All of
 * those print no `stats` object and no error line, so the naive answer is
 * all-zero counters with `errors: []` — byte-identical to an honest "nothing
 * to do", which is the one lie a preview must never tell. `rcloneFailureMessage`
 * is the RUN's own sentence (it falls back to the last raw line), so the
 * operator reads the same words in both places.
 *
 * Not an error: the wall ceiling (`truncated` says what happened, and what
 * was parsed by then is real), and exits 0 / 9 — rclone's two completions.
 */
function previewErrors(mode: string, exitCode: number, truncated: boolean, log: RcloneLogState): string[] {
  if (log.errorLines.length)
    return log.errorLines
  // D9: the wrapper can end a preview while rclone has already said what
  // is wrong — a wrong credential prints its pre-logger plain line and keeps
  // retrying past the ceiling. The last RAW line rclone wrote answers the
  // "what went wrong" question an empty `errors` would leave open, so the
  // truncated look carries it too (the run's own failure path already falls
  // back to that line). Nothing logged at the ceiling stays an honest `[]`.
  if (truncated) {
    const last = log.rawLines.at(-1)
    return last ? [last] : []
  }
  if (rcloneRunCompleted(exitCode))
    return []
  return [rcloneFailureMessage(mode, exitCode, log)]
}
