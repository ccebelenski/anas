import type { PveNotifySeverity } from './pve-notify.js'

/**
 * The vocabulary the UNATTENDED run notifications share (story 9.4) — the small
 * set of decisions a snapshot-schedule run and a replication run make
 * identically, kept in ONE place so the two families cannot drift apart.
 *
 * Policy, settled: these families notify on FAILURE ONLY. Backup's per-task
 * `always` default (16.12) exists for vzdump parity and a body that replaces
 * cron mail; a snapshot schedule can fire hourly, so an `always` here would be
 * spam. This matches the dashboard policy (17.7 / 16.7): failures surface,
 * healthy is silent. There is deliberately no mode field and no UI knob — one
 * can be added if demand appears, and it would be added HERE.
 *
 * Emission stays best-effort (pve-notify's contract): a notification that cannot
 * be delivered never fails, and never changes, the job that emitted it.
 */

/** What a finished unattended run amounts to, for notification purposes. */
export type UnattendedOutcome
  /** The run job failed; the error text rides the body. */
  = | 'failure'
  /** Anything else — a good run, a no-op, a skip. Never notifies. */
    | 'success'

/** The minimum a run hands the notifier: its error, when it had one. */
export interface UnattendedNotifyBase {
  /** The failure message — present ONLY for a failed run. */
  error?: string
  /** Wall-clock time the run took inside the job. */
  elapsedMs?: number
}

/** Classify a finished run: an error is a failure, everything else is not. */
export function unattendedOutcome(ctx: UnattendedNotifyBase): UnattendedOutcome {
  return ctx.error !== undefined ? 'failure' : 'success'
}

/** Failure-only: the gate both families apply, spelled once. */
export function shouldNotifyUnattended(outcome: UnattendedOutcome): boolean {
  return outcome === 'failure'
}

/** Severity per outcome — PVE routes on it, so it is not decoration. */
export function unattendedSeverity(outcome: UnattendedOutcome): PveNotifySeverity {
  return outcome === 'failure' ? 'error' : 'info'
}

/** A short elapsed-time rendering (`42s`, `7m 12s`) for the job's own clock. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60)
    return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60)
    return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds}s`
}

/**
 * The duration as an unattended body states it: the job's wall clock, LABELED
 * as such (unlike backup, neither `zfs` nor the snapshot verbs print a duration
 * of their own, so there is nothing truer to prefer). Null when unmeasured.
 */
export function elapsedLine(elapsedMs?: number): string | null {
  return typeof elapsedMs === 'number' ? `${formatElapsed(elapsedMs)} (job elapsed)` : null
}
