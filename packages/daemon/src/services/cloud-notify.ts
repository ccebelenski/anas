import type { CloudSyncRunResult, CloudSyncTask, NotifyMode } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { PveNotifySeverity } from './pve-notify.js'
import type { NotifyOutcome } from './unattended-notify.js'
import { BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { ANAS_CLOUD_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import { elapsedLine, notifySeverity, shouldNotify } from './unattended-notify.js'

/**
 * Cloud sync run NOTIFICATIONS (story rclone.2) — the run job tells the
 * operator what happened, through PVE's own notification system (Principle 15:
 * we emit, PVE matches and delivers).
 *
 * The shape is backup's (16.12) and the vocabulary is the shared one
 * (`unattended-notify.ts`): the same four outcomes, the same two-mode gate, the
 * same severity map. What differs is the BODY, which states rclone's own
 * counters, and the template name — `anas-cloud`, so an operator can write a
 * matcher rule for offsite copies specifically.
 *
 * Emission is BEST-EFFORT (pve-notify's contract, preserved): a notification
 * that cannot be delivered never fails the run job that emitted it. A
 * deliberate off-week skip notifies in NEITHER mode — the gate produced no run,
 * and a non-event is a non-event.
 *
 * ASCII ONLY, deliberately (ground truth 2026-08-19): an em-dash arrived as
 * mojibake on a real gotify target, so no ANAS notification body gives that
 * pipeline anything to get wrong.
 */

/** What a finished cloud sync run amounts to — the shared four outcomes. */
export type CloudNotifyOutcome = NotifyOutcome

export interface CloudNotifyContext {
  task: CloudSyncTask
  /** The finished run result — absent when the run threw. */
  result?: CloudSyncRunResult
  /** The failure message — present ONLY for a failed run. */
  error?: string
  /** Wall-clock time the run took inside the job. */
  elapsedMs?: number
}

/**
 * Classify a finished run. A gated off-week skip is its own outcome (the one
 * that stays silent in both modes); a completed run carrying warnings — a
 * transient snapshot that outlived its `finally` — is a warning.
 */
export function cloudNotifyOutcome(ctx: CloudNotifyContext): CloudNotifyOutcome {
  if (ctx.error !== undefined)
    return 'failure'
  if (ctx.result?.status === BACKUP_SKIPPED_OFF_WEEK)
    return 'skip'
  return ctx.result?.warnings?.length ? 'warning' : 'success'
}

/** Does this outcome notify in this mode? The ONE shared gate. */
export function shouldNotifyCloud(mode: NotifyMode, outcome: CloudNotifyOutcome): boolean {
  return shouldNotify(mode, outcome)
}

/** Severity per outcome — PVE routes on it, so it is not decoration. */
export function cloudNotifySeverity(outcome: CloudNotifyOutcome): PveNotifySeverity {
  return notifySeverity(outcome)
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function cloudNotifyTitle(task: CloudSyncTask, outcome: CloudNotifyOutcome): string {
  if (outcome === 'failure')
    return `cloud sync '${task.name}' FAILED`
  if (outcome === 'warning')
    return `cloud sync '${task.name}' completed with warnings`
  return `cloud sync '${task.name}' succeeded`
}

/** `<source> -> <remote>:<path>` — the whole route, never truncated. */
export function cloudRouteLine(ctx: CloudNotifyContext): string {
  const destination = ctx.result?.destination ?? `${ctx.task.remote}:${ctx.task.path}`
  return `${ctx.task.source} -> ${destination}`
}

/**
 * The consistency line: `snapshot <name>` when the run read a point-in-time
 * snapshot, `live` when the filesystem could not give one. The operator reading
 * this mail must be able to tell one instant from a moving tree without opening
 * the UI.
 */
export function cloudConsistencyLine(ctx: CloudNotifyContext): string | null {
  const result = ctx.result
  if (!result?.consistency)
    return null
  if (result.consistency.consistency !== 'snapshot')
    return 'live'
  return `snapshot ${result.snapshot ?? result.consistency.target ?? ''}`.trim()
}

/**
 * The notification BODY — plain text, scannable, and detailed enough to read
 * INSTEAD of the run. Nothing here can carry a secret: every credential lives
 * in the config file, never in an argv and never in rclone's log.
 */
export function buildCloudNotifyBody(ctx: CloudNotifyContext): string {
  const outcome = cloudNotifyOutcome(ctx)
  const result = ctx.result
  const lines: string[] = []

  const status = outcome === 'failure'
    ? 'FAILED'
    : outcome === 'warning' ? 'completed with warnings' : 'success'

  lines.push(`Task:        ${ctx.task.name}`)
  lines.push(`Route:       ${cloudRouteLine(ctx)}`)
  lines.push(`Mode:        ${result?.mode ?? ctx.task.mode}`)
  lines.push(`Result:      ${status}`)
  const consistency = cloudConsistencyLine(ctx)
  if (consistency)
    lines.push(`Consistency: ${consistency}`)
  // rclone's own elapsed seconds when it reported them, else the job's clock.
  const duration = typeof result?.elapsed === 'number' && result.elapsed > 0
    ? `${result.elapsed}s (rclone)`
    : elapsedLine(ctx.elapsedMs)
  if (duration)
    lines.push(`Duration:    ${duration}`)

  if (result) {
    lines.push('')
    lines.push('Transferred:')
    // rclone prints its first stats object only when the first --stats
    // interval fires; a sub-second run prints none, and its counters would
    // read as zeros. Zeros are rclone's own numbers only when it REPORTED
    // them — anything else is a lie about what happened, so say that instead.
    if (result.countersReported === false) {
      lines.push('  rclone reported no counters')
    }
    else {
      lines.push(`  bytes:     ${result.bytes} of ${result.totalBytes}`)
      lines.push(`  files:     ${result.transfers}`)
      lines.push(`  checked:   ${result.checks}`)
      lines.push(`  deleted:   ${result.deletes}`)
      lines.push(`  errors:    ${result.errors}`)
    }
  }

  if (result?.nested?.length) {
    lines.push('')
    lines.push('Nested filesystems NOT included:')
    for (const path of result.nested)
      lines.push(`  ${path}`)
  }

  if (result?.warnings?.length) {
    lines.push('')
    lines.push('Warnings:')
    for (const w of result.warnings)
      lines.push(`  ${w}`)
  }

  // rclone's own error lines, on a failure AND on a completed run that logged
  // some (exit 9 with per-file errors is possible): the line the operator needs
  // is the line rclone printed.
  if (result?.errorLines?.length) {
    lines.push('')
    lines.push('rclone errors:')
    for (const line of result.errorLines)
      lines.push(`  ${line}`)
  }

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  lines.push('')
  lines.push(`Schedule:    ${ctx.task.schedule}${ctx.task.enabled ? '' : ' (task disabled)'}`)
  return lines.join('\n')
}

/**
 * Emit the run notification, if this task's mode wants one. Called at the ONE
 * place every run converges — the daemon's run job (a timer fire and a UI Run
 * Now both arrive there through the task's own unit).
 *
 * Never throws: pve-notify swallows delivery problems, and the mode check
 * happens before anything is executed.
 */
export async function notifyCloudRun(
  executor: CommandExecutor,
  ctx: CloudNotifyContext,
): Promise<void> {
  const outcome = cloudNotifyOutcome(ctx)
  if (!shouldNotifyCloud(ctx.task.notify, outcome))
    return
  await pveNotify(
    executor,
    cloudNotifySeverity(outcome),
    cloudNotifyTitle(ctx.task, outcome),
    buildCloudNotifyBody(ctx),
    ANAS_CLOUD_NOTIFY_TEMPLATE,
  )
}
