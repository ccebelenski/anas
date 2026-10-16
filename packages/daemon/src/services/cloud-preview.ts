import type { CloudSyncPreviewResult, CloudSyncTask } from '@anas/shared'
import type { CommandExecutor, SpawnedChild } from '../executor/types.js'
import type { RcloneLogState, RcloneStats } from './cloud-runner.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { stat } from 'node:fs/promises'
import {
  buildRcloneArgs,
  DELETED_FILES_CAP,
  execRcloneLog,
  finalStats,
  missingSourceRefusal,
  rcloneFailureMessage,
  rcloneRunCompleted,
} from './cloud-runner.js'
import { RCLONE } from './rclone-config.js'
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
 *   - the consistency derivation and the transient snapshot (see above),
 *     the job, the notification and the cadence gate.
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
   * Plain secret values in scope for the argv guard — normally none (rclone
   * reads every credential from the config file), the structural backstop
   * that would fire if that ever stopped being true. Uniform with the run.
   */
  secrets?: string[]
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
  await checkPreviewSource(executor, deps)
  return runPreview(executor, deps, hooks)
}

/**
 * The preview's guards — the run's own, minus the empty-source one. Throws a
 * {@link PreviewRefusal} with the run's sentence; the route answers it 400
 * BEFORE the job is submitted (cr.48), so the refusal still arrives as the
 * door's answer, not as a failed job.
 */
export async function checkPreviewSource(
  executor: CommandExecutor,
  deps: CloudPreviewDeps,
): Promise<void> {
  const { task } = deps
  // The unmounted-mount check first: the one that explains an empty
  // directory, and the only one that can answer without touching the path.
  const guardFacts = await readSourceGuardFacts(executor, deps.fstabPath, [task.source])
  const refusal = guardSourcePath(task.source, guardFacts)
  if (refusal)
    throw new PreviewRefusal(refusal)

  // The source must be a DIRECTORY that exists — LIVE. A preview takes no
  // snapshot, so this is the same check the run makes, on the live tree.
  const dirStat = await stat(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (dirStat instanceof Error || !dirStat.isDirectory())
    throw new PreviewRefusal(missingSourceRefusal(task.source))

  // Deliberately ABSENT: the empty-source guard. A `sync` preview of an empty
  // source reporting "would delete everything" is the point.
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
  const args = buildRcloneArgs(task, deps.paths.configFile, task.source, { dryRun: true })
  // The executor-side argv backstop, uniform with every other rclone call
  // ANAS makes (the run's own call, over the same argv).
  assertNoSecretValues(args, deps.secrets ?? [])

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
  // string in the answer. Whatever the child echoed of a secret value this
  // preview handed it is replaced AT the result, after the parsing read the
  // raw text (only what leaves is masked).
  const secrets = deps.secrets ?? []
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
