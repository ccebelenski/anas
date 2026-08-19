import type { NotifyMode } from '@anas/shared'
import type { PveNotifySeverity } from './pve-notify.js'

/**
 * The vocabulary EVERY run notification shares — the small set of decisions a
 * backup run (16.12), a snapshot-schedule fire and a replication run (9.4) make
 * identically, kept in ONE place so the three families cannot drift apart.
 *
 * Policy, settled 2026-08-19 (operator ruling: "we should notify on successes
 * too"): all three families offer the SAME per-task two-mode knob, classify a
 * finished run into the SAME four outcomes, and gate on the SAME function. What
 * differs is only the per-family DEFAULT — backup `always` (vzdump parity),
 * snapshot schedules and replication `on-failure` (a schedule can fire every 15
 * minutes) — and that lives in the shared schemas, not here.
 *
 * Emission stays best-effort (pve-notify's contract): a notification that cannot
 * be delivered never fails, and never changes, the job that emitted it.
 */

/** What a finished run amounts to, for notification purposes. */
export type NotifyOutcome
  /** The run did its work and reported no problem. */
  = | 'success'
  /** Completed, but carrying warnings — the work landed, something else did not. */
    | 'warning'
  /** The run job failed; the error text rides the body. */
    | 'failure'
  /**
   * A deliberate no-op — a cadence gate produced no run at all. The one outcome
   * that stays silent in BOTH modes. Only backup's biweekly off-week gate
   * produces one today; the value lives here because the gate below is the ONE
   * gate all three families call, and a shared gate must know every outcome its
   * callers can hand it.
   */
    | 'skip'

/** The minimum a run hands the notifier: its error, when it had one. */
export interface UnattendedNotifyBase {
  /** The failure message — present ONLY for a failed run. */
  error?: string
  /** Wall-clock time the run took inside the job. */
  elapsedMs?: number
}

/**
 * Classify a finished unattended run: an error is a failure, a completed run
 * carrying anything worth flagging is a warning, everything else is a success.
 * `hasWarnings` is the caller's own reading of its result (a replication's
 * hold/release warnings, a schedule's held-and-unprunable snapshots) — the ONE
 * thing the two families genuinely compute differently.
 */
export function unattendedOutcome(ctx: UnattendedNotifyBase, hasWarnings = false): NotifyOutcome {
  if (ctx.error !== undefined)
    return 'failure'
  return hasWarnings ? 'warning' : 'success'
}

/**
 * Does this outcome notify in this mode? `always` notifies every real run;
 * `on-failure` notifies only what went wrong — and a completed-with-warnings run
 * counts as wrong enough to mail (a retention that could not prune, a hold that
 * would not take, is precisely what an on-failure operator asked to hear about).
 * A skip notifies in neither mode.
 *
 * This is THE gate: backup, snapshot schedules and replication all call it, so
 * the matrix cannot be right in one family and wrong in another.
 */
export function shouldNotify(mode: NotifyMode, outcome: NotifyOutcome): boolean {
  if (outcome === 'skip')
    return false
  if (outcome === 'success')
    return mode === 'always'
  return true
}

/** Severity per outcome — PVE routes on it, so it is not decoration. */
export function notifySeverity(outcome: NotifyOutcome): PveNotifySeverity {
  if (outcome === 'failure')
    return 'error'
  if (outcome === 'warning')
    return 'warning'
  return 'info'
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
