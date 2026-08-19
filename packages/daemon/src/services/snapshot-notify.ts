import type { RetentionBucket, RetentionPolicy, SnapshotSchedule, SnapshotTarget } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { UnattendedNotifyBase, UnattendedOutcome } from './unattended-notify.js'
import { ANAS_SNAPSHOT_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import {
  elapsedLine,
  shouldNotifyUnattended,
  unattendedOutcome,
  unattendedSeverity,
} from './unattended-notify.js'

/**
 * Snapshot SCHEDULE run notifications (story 9.4, riding 16.12's machinery) —
 * an unattended take+prune that FAILS tells the operator through PVE's own
 * notification system, instead of waiting to be noticed on the dashboard.
 *
 * Failure-only by design (see unattended-notify.ts): a schedule can fire hourly,
 * so a success mail per fire would be noise, and 17.7 already says healthy is
 * silent. The body is shaped like the backup one (16.12) — plain text,
 * scannable, and detailed enough to read INSTEAD of the run: which schedule,
 * which target, the error verbatim, and the cadence/retention it runs under.
 * Nothing here can carry a secret (every string comes from the schedule's own
 * unit JSON or from `zfs`/`btrfs` stderr).
 */

/** Bucket order + label, oldest-to-newest, mirroring the shared RetentionBucket. */
const BUCKETS: RetentionBucket[] = ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']

/** What a finished take+prune hands back (the fire result), when it completed. */
export interface SnapshotNotifyResult {
  schedule: string
  taken: string
  pruned: string[]
  skippedHeld: string[]
}

export interface SnapshotNotifyContext extends UnattendedNotifyBase {
  schedule: SnapshotSchedule
  /** The finished run result — absent when the run threw. */
  result?: SnapshotNotifyResult
}

/** Classify a finished schedule fire (failure-only policy: error, or nothing). */
export function snapshotNotifyOutcome(ctx: SnapshotNotifyContext): UnattendedOutcome {
  return unattendedOutcome(ctx)
}

/**
 * The target, spelled out and never truncated — the ONE place the two backends
 * differ is the discriminant, exactly as everywhere else in Epic 17.
 */
export function snapshotTargetLine(target: SnapshotTarget): string {
  return target.kind === 'zfs' ? `ZFS dataset ${target.dataset}` : `AHR pool ${target.pool}`
}

/**
 * The retention policy in words (`24 hourly / 30 daily / 12 monthly`). The grid
 * renders its own compact form in browser JS (69-snapshots.js) which cannot
 * import daemon code; a mail body reads better spelled out anyway.
 */
export function retentionSummaryLine(retention: RetentionPolicy): string {
  const parts = BUCKETS
    .filter(b => (retention[b] ?? 0) > 0)
    .map(b => `${retention[b]} ${b}`)
  return parts.length ? parts.join(' / ') : 'nothing kept by policy (newest is always kept)'
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function snapshotNotifyTitle(schedule: SnapshotSchedule, outcome: UnattendedOutcome): string {
  return outcome === 'failure'
    ? `snapshot schedule '${schedule.name}' FAILED`
    : `snapshot schedule '${schedule.name}' succeeded`
}

/** The notification BODY — plain text, scannable, error verbatim. */
export function buildSnapshotNotifyBody(ctx: SnapshotNotifyContext): string {
  const { schedule } = ctx
  const outcome = snapshotNotifyOutcome(ctx)
  const lines: string[] = []

  lines.push(`Schedule:    ${schedule.name} (${schedule.id})`)
  lines.push(`Target:      ${snapshotTargetLine(schedule.target)}`)
  lines.push(`Result:      ${outcome === 'failure' ? 'FAILED' : 'success'}`)
  const duration = elapsedLine(ctx.elapsedMs)
  if (duration)
    lines.push(`Duration:    ${duration}`)
  if (ctx.result?.taken)
    lines.push(`Snapshot:    ${ctx.result.taken}`)
  if (ctx.result?.pruned.length)
    lines.push(`Pruned:      ${ctx.result.pruned.join(', ')}`)
  if (ctx.result?.skippedHeld.length)
    lines.push(`Held:        ${ctx.result.skippedHeld.join(', ')} (retained, never pruned)`)

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  lines.push('')
  lines.push(`Cadence:     ${schedule.cadence}${schedule.recursive ? ', recursive' : ''}`
    + `${schedule.enabled ? '' : ' (schedule disabled)'}`)
  lines.push(`Retention:   ${retentionSummaryLine(schedule.retention)}`)
  lines.push('Snapshot inventory and the schedule\'s own last-run log live in the ANAS '
    + 'Snapshots view.')
  return lines.join('\n')
}

/**
 * Emit the schedule-run notification when the run failed. Called at the ONE
 * place every fire converges on — the daemon's run job (a timer fire and a UI
 * Run Now both arrive there), so one site covers both triggers.
 *
 * Never throws: the gate returns before anything is executed on a good run, and
 * pve-notify swallows delivery problems.
 */
export async function notifyScheduleRun(
  executor: CommandExecutor,
  ctx: SnapshotNotifyContext,
): Promise<void> {
  const outcome = snapshotNotifyOutcome(ctx)
  if (!shouldNotifyUnattended(outcome))
    return
  await pveNotify(
    executor,
    unattendedSeverity(outcome),
    snapshotNotifyTitle(ctx.schedule, outcome),
    buildSnapshotNotifyBody(ctx),
    ANAS_SNAPSHOT_NOTIFY_TEMPLATE,
  )
}
