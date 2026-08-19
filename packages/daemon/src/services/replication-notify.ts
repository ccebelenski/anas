import type { ReplicationLocation } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { UnattendedNotifyBase, UnattendedOutcome } from './unattended-notify.js'
import { ANAS_REPLICATION_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import {
  elapsedLine,
  shouldNotifyUnattended,
  unattendedOutcome,
  unattendedSeverity,
} from './unattended-notify.js'

/**
 * Replication run notifications (story 9.4, riding 16.12's machinery) — an
 * unattended `zfs send | zfs recv` that FAILS tells the operator through PVE's
 * own notification system instead of waiting to be noticed on the dashboard.
 *
 * Failure-only by design (see unattended-notify.ts), matching the dashboard
 * policy (16.7): a healthy replication is silent. The body is shaped like the
 * backup one (16.12) — plain text, scannable: where the data was going
 * (including the peer/remote it was going to), what the run had resolved when it
 * died, and the error verbatim. Nothing here can carry a secret (the strings are
 * dataset names, a peer/remote NAME — never its credentials — and zfs stderr).
 *
 * A recurring task's own name never reaches this point: the timer's runner is a
 * thin client of the one-shot endpoint and passes only the datasets. The route
 * IS the identity here, which is also how the Replication view lists it.
 */

/** What a finished replication hands back, when it completed. */
export interface ReplicationNotifyResult {
  mode: 'full' | 'incremental'
  snapshot: string
  baseSnapshot?: string
}

export interface ReplicationNotifyContext extends UnattendedNotifyBase {
  /** Full source dataset (pool-qualified). */
  source: string
  /** Full target dataset (pool-qualified) — resolved before the job starts. */
  target: string
  /** Where the target lives; absent or `local` = same node. */
  location?: ReplicationLocation
  /** The source snapshot the run had settled on, when it got that far. */
  snapshot?: string
  /** The finished run result — absent when the run threw. */
  result?: ReplicationNotifyResult
}

/** Classify a finished replication (failure-only policy: error, or nothing). */
export function replicationNotifyOutcome(ctx: ReplicationNotifyContext): UnattendedOutcome {
  return unattendedOutcome(ctx)
}

/** `peer 'node-b'` / `remote 'offsite'` — null for a same-node replication. */
export function replicationLocationLine(location?: ReplicationLocation): string | null {
  if (!location || location.kind === 'local')
    return null
  return `${location.kind}${location.name ? ` '${location.name}'` : ''}`
}

/** `source → target` (plus the peer/remote it lands on) — never truncated. */
export function replicationRouteLine(ctx: ReplicationNotifyContext): string {
  const where = replicationLocationLine(ctx.location)
  return `${ctx.source} → ${ctx.target}${where ? ` (${where})` : ''}`
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function replicationNotifyTitle(ctx: ReplicationNotifyContext, outcome: UnattendedOutcome): string {
  const verdict = outcome === 'failure' ? 'FAILED' : 'succeeded'
  return `replication ${replicationRouteLine(ctx)} ${verdict}`
}

/** The notification BODY — plain text, scannable, error verbatim. */
export function buildReplicationNotifyBody(ctx: ReplicationNotifyContext): string {
  const outcome = replicationNotifyOutcome(ctx)
  const lines: string[] = []

  lines.push(`Source:      ${ctx.source}`)
  lines.push(`Target:      ${ctx.target}`)
  const where = replicationLocationLine(ctx.location)
  if (where)
    lines.push(`Location:    ${where}`)
  lines.push(`Result:      ${outcome === 'failure' ? 'FAILED' : 'success'}`)
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

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  lines.push('')
  lines.push('A recurring task\'s schedule and last-run state live in the ANAS Replication '
    + 'view; the run\'s full output is in the journal.')
  return lines.join('\n')
}

/**
 * Emit the replication-run notification when the run failed. Called at the ONE
 * place every replication converges on — the daemon's replicate job (a task
 * timer's runner and a UI replicate both submit it), so one site covers both.
 *
 * Never throws: the gate returns before anything is executed on a good run, and
 * pve-notify swallows delivery problems.
 */
export async function notifyReplicationRun(
  executor: CommandExecutor,
  ctx: ReplicationNotifyContext,
): Promise<void> {
  const outcome = replicationNotifyOutcome(ctx)
  if (!shouldNotifyUnattended(outcome))
    return
  await pveNotify(
    executor,
    unattendedSeverity(outcome),
    replicationNotifyTitle(ctx, outcome),
    buildReplicationNotifyBody(ctx),
    ANAS_REPLICATION_NOTIFY_TEMPLATE,
  )
}
