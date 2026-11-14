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

/** One dataset a recursive run SENT (rrep.1b) — name, where it went, and how. */
export interface ReplicationNotifyDataset {
  dataset: string
  target: string
  mode: 'full' | 'incremental'
}

/** What a finished replication hands back, when it completed. */
export interface ReplicationNotifyResult {
  /**
   * Absent when a RECURSIVE run sent nothing (every copy already at S) — a
   * mode over zero sends would claim a send shape that never happened
   * (fold 5, review J), and when a single-dataset run found the target
   * already at S (cr3) — every other single-dataset result carries it.
   */
  mode?: 'full' | 'incremental'
  snapshot: string
  baseSnapshot?: string
  /**
   * Fail-open hold/release hiccups the run recorded (the send|recv itself
   * succeeded). This is replication's real warning channel — a base that could
   * not be pinned is a future broken incremental chain, so it is worth mailing
   * even to an `on-failure` operator.
   */
  warnings?: string[]
  /**
   * rrep.1b: a RECURSIVE run. Absent on the single-dataset result, so the
   * notification below is byte-identical to today's for a non-recursive run.
   */
  recursive?: true
  /** The datasets this recursive run sent, in plan order. */
  datasets?: ReplicationNotifyDataset[]
  /**
   * Source datasets whose copy was already at S — listed, never sent. A
   * single-dataset run that sent nothing (cr3 REPLICATION-M1) carries its
   * one source here and no `mode`.
   */
  upToDate?: string[]
  /** One sentence a run that sent nothing adds about why (cr3). */
  note?: string
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

/** Every C0 control character (the newline included) and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F]/g

/** The longest text one line of the body carries; the journal has the rest. */
const SINGLE_LINE_MAX = 2000

/**
 * Text another program wrote (a remote `zfs recv`'s stderr, a hold's stderr)
 * as ONE line: control characters become spaces and a long text is cut (cr3 REPLICATION-L5). The notification body is plain
 * text whose lines are `Key:  value`; a newline or a carriage return carried
 * in verbatim wrote lines of its own into it — a forged `Result: success`
 * under a failure was one remote stderr away.
 */
export function singleLine(text: string): string {
  const flat = text.replace(CONTROL_RE, ' ').trim()
  return flat.length > SINGLE_LINE_MAX ? `${flat.slice(0, SINGLE_LINE_MAX)}...` : flat
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
  // Printed only when the run has a mode to state (fold 5, review J): a
  // recursive run that sent nothing omits the field, and a single-dataset
  // result always carries one — so that body stays byte-identical.
  if (ctx.result?.mode !== undefined) {
    lines.push(`Mode:        ${ctx.result.mode}`
      + `${ctx.result.baseSnapshot ? ` (from @${ctx.result.baseSnapshot})` : ''}`)
  }
  else if (ctx.result !== undefined && ctx.result.recursive !== true && (ctx.result.upToDate?.length ?? 0) > 0) {
    // cr3: a single-dataset run that sent nothing says so.
    lines.push('Mode:        nothing sent (the target already has this snapshot)')
  }
  if (ctx.result?.note)
    lines.push(`Note:        ${singleLine(ctx.result.note)}`)

  // rrep.1b: a recursive run lists what it sent and how many copies needed
  // nothing. Gated on the flag, so a single-dataset body never changes.
  if (ctx.result?.recursive === true) {
    const sent = ctx.result.datasets ?? []
    lines.push(`Datasets:    ${sent.length} sent, ${ctx.result.upToDate?.length ?? 0} up to date`)
    for (const d of sent)
      lines.push(`  ${d.dataset} -> ${d.target} (${d.mode})`)
  }

  if (ctx.result?.warnings?.length) {
    lines.push('')
    lines.push('Warnings:')
    for (const w of ctx.result.warnings)
      lines.push(`  ${singleLine(w)}`)
  }

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${singleLine(ctx.error)}`)
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
