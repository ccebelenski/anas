import type { NotifyMode, ReplicationLocation } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { NotifyOutcome, UnattendedNotifyBase } from './unattended-notify.js'
import { ANAS_REPLICATION_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import {
  elapsedLine,
  notifySeverity,
  shouldNotify,
  unattendedOutcome,
} from './unattended-notify.js'

/**
 * Replication run notifications (story 9.4, riding 16.12's machinery) — an
 * unattended `zfs send | zfs recv` tells the operator what happened through
 * PVE's own notification system instead of waiting to be noticed on the
 * dashboard.
 *
 * FULL parity with backup (operator ruling 2026-08-19): the same two-mode knob,
 * the same four outcomes, the same gate — with a quieter DEFAULT (`on-failure`),
 * matching the dashboard policy (16.7) that a healthy replication is silent.
 *
 * The MODE arrives WITH the run rather than being looked up: the one-shot
 * endpoint is where every replication converges and it deliberately knows
 * nothing about tasks, so a recurring task's runner forwards its stored mode in
 * the request body (replication-units runnerArgs → replicate-task → the route),
 * and an interactive replicate omits it and gets the default. The route IS the
 * identity here, which is also how the Replication view lists it.
 *
 * The body is shaped like the backup one (16.12) — plain text, scannable: where
 * the data went (including the peer/remote it went to), the snapshot and mode,
 * the warnings verbatim, and on a failure the error itself. Nothing here can
 * carry a secret (the strings are dataset names, a peer/remote NAME — never its
 * credentials — and zfs stderr).
 */

/** What a finished replication hands back, when it completed. */
export interface ReplicationNotifyResult {
  mode: 'full' | 'incremental'
  snapshot: string
  baseSnapshot?: string
  /**
   * Fail-open hold/release hiccups the run recorded (the send|recv itself
   * succeeded). This is replication's real warning channel — a base that could
   * not be pinned is a future broken incremental chain, so it is worth mailing
   * even to an `on-failure` operator.
   */
  warnings?: string[]
}

export interface ReplicationNotifyContext extends UnattendedNotifyBase {
  /** Full source dataset (pool-qualified). */
  source: string
  /** Full target dataset (pool-qualified) — resolved before the job starts. */
  target: string
  /** Where the target lives; absent or `local` = same node. */
  location?: ReplicationLocation
  /** When this run notifies — from the request body (task runner or UI). */
  notify: NotifyMode
  /** The source snapshot the run had settled on, when it got that far. */
  snapshot?: string
  /** The finished run result — absent when the run threw. */
  result?: ReplicationNotifyResult
}

/** Classify a finished replication into the shared four-outcome vocabulary. */
export function replicationNotifyOutcome(ctx: ReplicationNotifyContext): NotifyOutcome {
  return unattendedOutcome(ctx, (ctx.result?.warnings?.length ?? 0) > 0)
}

/** `peer 'node-b'` / `remote 'offsite'` — null for a same-node replication. */
export function replicationLocationLine(location?: ReplicationLocation): string | null {
  if (!location || location.kind === 'local')
    return null
  return `${location.kind}${location.name ? ` '${location.name}'` : ''}`
}

/**
 * `source -> target` (plus the peer/remote it lands on), never truncated. The
 * arrow is ASCII on purpose: this line rides the notification TITLE, and a real
 * gotify delivery mojibake'd our UTF-8 punctuation (ground truth 2026-08-19).
 */
export function replicationRouteLine(ctx: ReplicationNotifyContext): string {
  const where = replicationLocationLine(ctx.location)
  return `${ctx.source} -> ${ctx.target}${where ? ` (${where})` : ''}`
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function replicationNotifyTitle(ctx: ReplicationNotifyContext, outcome: NotifyOutcome): string {
  const verdict = outcome === 'failure'
    ? 'FAILED'
    : outcome === 'warning' ? 'completed with warnings' : 'succeeded'
  return `replication ${replicationRouteLine(ctx)} ${verdict}`
}

/** The notification BODY — plain text, scannable, error verbatim. */
export function buildReplicationNotifyBody(ctx: ReplicationNotifyContext): string {
  const outcome = replicationNotifyOutcome(ctx)
  const lines: string[] = []

  const status = outcome === 'failure'
    ? 'FAILED'
    : outcome === 'warning' ? 'completed with warnings' : 'success'

  lines.push(`Source:      ${ctx.source}`)
  lines.push(`Target:      ${ctx.target}`)
  const where = replicationLocationLine(ctx.location)
  if (where)
    lines.push(`Location:    ${where}`)
  lines.push(`Result:      ${status}`)
  const duration = elapsedLine(ctx.elapsedMs)
  if (duration)
    lines.push(`Duration:    ${duration}`)

  const snapshot = ctx.result?.snapshot ?? ctx.snapshot
  if (snapshot)
    lines.push(`Snapshot:    ${ctx.source}@${snapshot}`)
  if (ctx.result) {
    lines.push(`Mode:        ${ctx.result.mode}`
      + `${ctx.result.baseSnapshot ? ` (from @${ctx.result.baseSnapshot})` : ''}`)
  }

  if (ctx.result?.warnings?.length) {
    lines.push('')
    lines.push('Warnings:')
    for (const w of ctx.result.warnings)
      lines.push(`  ${w}`)
  }

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  // The body ends on the facts (backup's rule) - no closing pointer to the UI.
  return lines.join('\n')
}

/**
 * Emit the replication-run notification, if this run's mode wants one. Called at
 * the ONE place every replication converges on — the daemon's replicate job (a
 * task timer's runner and a UI replicate both submit it), so one site covers both.
 *
 * Never throws: the mode check happens before anything is executed, and
 * pve-notify swallows delivery problems.
 */
export async function notifyReplicationRun(
  executor: CommandExecutor,
  ctx: ReplicationNotifyContext,
): Promise<void> {
  const outcome = replicationNotifyOutcome(ctx)
  if (!shouldNotify(ctx.notify, outcome))
    return
  await pveNotify(
    executor,
    notifySeverity(outcome),
    replicationNotifyTitle(ctx, outcome),
    buildReplicationNotifyBody(ctx),
    ANAS_REPLICATION_NOTIFY_TEMPLATE,
  )
}
