import type { CloudSyncPreviewResult, CloudSyncTask } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { stat } from 'node:fs/promises'
import {
  buildRcloneArgs,
  execRcloneLog,
  finalStats,
  missingSourceRefusal,
} from './cloud-runner.js'
import { RCLONE } from './rclone-config.js'
import { assertNoSecretValues } from './secret-argv.js'
import { guardSourcePath, readSourceGuardFacts } from './source-guard.js'

/**
 * The dry-run PREVIEW (rclone.2 addendum, operator 2026-09-24): the same
 * rclone command a run would issue, with `--dry-run` and a wall ceiling, read
 * against the LIVE source. DESIGN's words: "a preview is a look, not a run" —
 * so it takes NO snapshot (a transient would be pure cost the look does not
 * pay), it answers 200 with rclone's own counters, and it writes nothing.
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

/** The whole preview's wall budget, in seconds (the `timeout` argument). */
export const PREVIEW_TIMEOUT_S = 120

/** `timeout`'s own exit code when it is the one that killed the child. */
export const TIMEOUT_EXIT_CODE = 124

/**
 * The cap on `deletedFiles` kept in the result. A whole-tree delete can name
 * a lot of files, and the operator reading the answer wants a sample with the
 * count, not a wall of names. `deletedTotal` is always the whole number.
 */
export const DELETED_FILES_CAP = 200

/**
 * The fields a preview needs of a task — the stored task satisfies them and
 * so does the wizard's inline form (`CloudSyncPreviewTask`), which is why the
 * route can hand either one straight over.
 */
export type PreviewTask = Pick<CloudSyncTask, 'source' | 'remote' | 'path' | 'mode' | 'excludes' | 'bwlimit'>

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
 * Preview one cloud sync. THROWS on a guard refusal (the unmounted mount,
 * the missing source — the run's own sentences, which the route answers 400
 * with); a rclone FAILURE (an unknown remote, an auth failure) is NOT a
 * throw: the preview is a read, and its answer carries rclone's error lines
 * in `errors` with the counters it reported. On the wall ceiling it returns
 * what was parsed so far with `truncated: true`, never an error.
 */
export async function previewCloudSync(
  executor: CommandExecutor,
  deps: CloudPreviewDeps,
): Promise<CloudSyncPreviewResult> {
  const { task } = deps

  // ---- The guards (the run's own, minus the empty-source one) ------------
  // The unmounted-mount check first: the one that explains an empty
  // directory, and the only one that can answer without touching the path.
  const guardFacts = await readSourceGuardFacts(executor, deps.fstabPath)
  const refusal = guardSourcePath(task.source, guardFacts)
  if (refusal)
    throw new Error(refusal)

  // The source must be a DIRECTORY that exists — LIVE. A preview takes no
  // snapshot, so this is the same check the run makes, on the live tree.
  const dirStat = await stat(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (dirStat instanceof Error || !dirStat.isDirectory())
    throw new Error(missingSourceRefusal(task.source))

  // Deliberately ABSENT: the empty-source guard. A `sync` preview of an empty
  // source reporting "would delete everything" is the point.

  // ---- The look ------------------------------------------------------------
  const args = buildRcloneArgs(task, deps.paths.configFile, task.source, { dryRun: true })
  // The executor-side argv backstop, uniform with every other rclone call
  // ANAS makes (the run's own call, over the same argv).
  assertNoSecretValues(args, deps.secrets ?? [])

  const { exitCode, log } = await execRcloneLog(executor, TIMEOUT, [
    String(PREVIEW_TIMEOUT_S),
    RCLONE,
    ...args,
  ])
  const stats = finalStats(log)
  return {
    transfers: stats.transfers,
    bytes: stats.bytes,
    checks: stats.checks,
    deletes: stats.deletes,
    deletedFiles: log.skippedDeletes.slice(0, DELETED_FILES_CAP),
    deletedTotal: log.skippedDeletes.length,
    errors: log.errorLines,
    truncated: exitCode === TIMEOUT_EXIT_CODE,
  }
}
