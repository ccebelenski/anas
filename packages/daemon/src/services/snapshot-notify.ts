import type { RetentionBucket, RetentionPolicy, SnapshotSchedule, SnapshotScheduleRunResult, SnapshotTarget } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { NotifyOutcome, UnattendedNotifyBase } from './unattended-notify.js'
import { ANAS_SNAPSHOT_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import { SCHEDULE_LIST_UNREADABLE } from './snapshot-schedules.js'
import {
  elapsedLine,
  notifySeverity,
  shouldNotify,
  unattendedOutcome,
} from './unattended-notify.js'

/**
 * Snapshot SCHEDULE run notifications (story 9.4, riding 16.12's machinery) —
 * an unattended take+prune tells the operator what happened through PVE's own
 * notification system, instead of waiting to be noticed on the dashboard.
 *
 * FULL parity with backup (operator ruling 2026-08-19, "we should notify on
 * successes too"): the same per-schedule two-mode knob, the same four outcomes,
 * the same gate — with a quieter DEFAULT (`on-failure`), because a schedule can
 * fire every 15 minutes and 17.7 already says healthy is silent on the dashboard.
 * `always` is the opt-in for the operator who wants the take/prune receipt.
 *
 * The body is shaped like the backup one (16.12) — plain text, scannable, and
 * detailed enough to read INSTEAD of the run: which schedule, which target, what
 * was taken, what retention did, and on a failure the error verbatim. Nothing
 * here can carry a secret (every string comes from the schedule's own unit JSON
 * or from `zfs`/`btrfs` stderr).
 */

/** Bucket order + label, oldest-to-newest, mirroring the shared RetentionBucket. */
const BUCKETS: RetentionBucket[] = ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']

/** What a finished take+prune hands back (the fire result), when it completed. */
export type SnapshotNotifyResult = SnapshotScheduleRunResult

/** At most this many names in the body's "Destroyed:" and "Held" sections. */
export const NOTIFY_SECTION_NAMES = 20

/** At most this many lines in the body's "Per dataset:" section, then the rest counted. */
export const NOTIFY_DATASET_LINES = 100

/** How many snapshots the run destroyed (`pruned` may list fewer — capped). */
function prunedTotal(result: SnapshotNotifyResult): number {
  return result.prunedCount ?? result.pruned.length
}

/** How many held snapshots the run retained (`skippedHeld` may list fewer — capped). */
function heldTotal(result: SnapshotNotifyResult): number {
  return result.heldCount ?? result.skippedHeld.length
}

/** A body section: at most {@link NOTIFY_SECTION_NAMES} names, then the rest counted. */
function namedSection(lines: string[], title: string, names: string[], total: number): void {
  lines.push('')
  lines.push(title)
  const shown = names.slice(0, NOTIFY_SECTION_NAMES)
  for (const name of shown)
    lines.push(`  ${name}`)
  if (total > shown.length)
    lines.push(`  ... and ${total - shown.length} more`)
}

export interface SnapshotNotifyContext extends UnattendedNotifyBase {
  schedule: SnapshotSchedule
  /** The finished run result — absent when the run threw. */
  result?: SnapshotNotifyResult
}

/**
 * Did this fire complete with something worth flagging? A prune that SKIPPED
 * held snapshots is exactly that (the 17.6 `skippedHeld` surface, GT-7): the
 * snapshot itself was taken, but retention could not do what policy asked, so
 * the target keeps growing until the hold is released. So is a destroy ZFS
 * refused on a swept or excluded dataset (snapprune.1: a clone depends on the
 * snapshot). So is the schedule-list fail-safe (any dataset noted
 * {@link SCHEDULE_LIST_UNREADABLE}): retention was not applied to the swept
 * children that run, and a quiet success would hide it until they piled up.
 * All are warnings, not failures — and precisely what an `on-failure`
 * operator asked to hear.
 */
function fireHasWarnings(ctx: SnapshotNotifyContext): boolean {
  const result = ctx.result
  if (!result)
    return false
  return heldTotal(result) > 0
    || (result.datasets ?? []).some(d => (d.refused ?? 0) > 0 || (d.note ?? '').includes(SCHEDULE_LIST_UNREADABLE))
}

/** Classify a finished schedule fire into the shared four-outcome vocabulary. */
export function snapshotNotifyOutcome(ctx: SnapshotNotifyContext): NotifyOutcome {
  return unattendedOutcome(ctx, fireHasWarnings(ctx))
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

/**
 * What the prune actually DID, in counts — the success body's receipt (backup's
 * `Retention: …` line, in snapshot terms). Held snapshots are reported as
 * retained, never as failed destroys.
 */
export function pruneSummaryLine(result: SnapshotNotifyResult): string {
  const parts = [`${prunedTotal(result)} destroyed`]
  if (heldTotal(result))
    parts.push(`${heldTotal(result)} held (kept despite policy)`)
  return parts.join(', ')
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function snapshotNotifyTitle(schedule: SnapshotSchedule, outcome: NotifyOutcome): string {
  if (outcome === 'failure')
    return `snapshot schedule '${schedule.name}' FAILED`
  if (outcome === 'warning')
    return `snapshot schedule '${schedule.name}' completed with warnings`
  return `snapshot schedule '${schedule.name}' succeeded`
}

/** The notification BODY — plain text, scannable, error verbatim. */
export function buildSnapshotNotifyBody(ctx: SnapshotNotifyContext): string {
  const { schedule, result } = ctx
  const outcome = snapshotNotifyOutcome(ctx)
  const lines: string[] = []

  const status = outcome === 'failure'
    ? 'FAILED'
    : outcome === 'warning' ? 'completed with warnings' : 'success'

  lines.push(`Schedule:    ${schedule.name} (${schedule.id})`)
  lines.push(`Target:      ${snapshotTargetLine(schedule.target)}`)
  lines.push(`Result:      ${status}`)
  const duration = elapsedLine(ctx.elapsedMs)
  if (duration)
    lines.push(`Duration:    ${duration}`)
  if (result?.taken)
    lines.push(`Snapshot:    ${result.taken}`)
  if (result)
    lines.push(`Pruned:      ${pruneSummaryLine(result)}`)
  // snapprune.1: a recursive schedule prunes per dataset — say what each did.
  // A leaf (only the target in `datasets`) says nothing the Pruned line has
  // not — unless it carries a note (ident.1: unstamped snapshots left).
  const datasets = result?.datasets ?? []
  const perDataset = datasets.some(d => d.scope !== 'target' || d.note)
    ? datasets.filter(d => d.pruned || d.held || d.note)
    : []
  if (perDataset.length) {
    lines.push('')
    lines.push('Per dataset:')
    for (const d of perDataset.slice(0, NOTIFY_DATASET_LINES)) {
      const parts = [`${d.pruned} destroyed`]
      if (d.held)
        parts.push(`${d.held} held`)
      if (d.note)
        parts.push(d.note)
      lines.push(`  ${d.dataset} (${d.scope}): ${parts.join(', ')}`)
    }
    if (perDataset.length > NOTIFY_DATASET_LINES)
      lines.push(`  ... and ${perDataset.length - NOTIFY_DATASET_LINES} more datasets`)
  }
  // Names are a sample (the per-dataset counts above are the record): a first
  // run after an upgrade can destroy thousands.
  if (result && prunedTotal(result) > 0)
    namedSection(lines, 'Destroyed:', result.pruned, prunedTotal(result))
  if (result && heldTotal(result) > 0)
    namedSection(lines, 'Held (retained, never pruned):', result.skippedHeld, heldTotal(result))

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  lines.push('')
  // snapx.1: the grid's "recursive, N excluded" wording, then the names.
  const excluded = schedule.recursive ? (schedule.exclude ?? []) : []
  lines.push(`Cadence:     ${schedule.cadence}${schedule.recursive ? ', recursive' : ''}`
    + `${excluded.length ? `, ${excluded.length} excluded` : ''}`
    + `${schedule.enabled ? '' : ' (schedule disabled)'}`)
  if (excluded.length)
    lines.push(`Excluded:    ${excluded.join(', ')}`)
  lines.push(`Retention:   ${retentionSummaryLine(schedule.retention)}`)
  // The body ends on the facts (backup's rule) - no closing pointer to the UI.
  return lines.join('\n')
}

/**
 * Emit the schedule-run notification, if this schedule's mode wants one. Called
 * at the ONE place every fire converges on — the daemon's run job (a timer fire
 * and a UI Run Now both arrive there), so one site covers both triggers.
 *
 * Never throws: the mode check happens before anything is executed, so a
 * schedule left on `on-failure` costs a good fire nothing at all, and pve-notify
 * swallows delivery problems.
 */
export async function notifyScheduleRun(
  executor: CommandExecutor,
  ctx: SnapshotNotifyContext,
): Promise<void> {
  const outcome = snapshotNotifyOutcome(ctx)
  if (!shouldNotify(ctx.schedule.notify, outcome))
    return
  await pveNotify(
    executor,
    notifySeverity(outcome),
    snapshotNotifyTitle(ctx.schedule, outcome),
    buildSnapshotNotifyBody(ctx),
    ANAS_SNAPSHOT_NOTIFY_TEMPLATE,
  )
}
