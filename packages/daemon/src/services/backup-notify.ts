import type { BackupNotifyMode, BackupPruneResult, BackupRepo, BackupTask } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { PveNotifySeverity } from './pve-notify.js'
import { BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { pruneSummaryLine } from './backup-prune.js'
import { ANAS_BACKUP_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import { formatElapsed } from './unattended-notify.js'

/** Re-exported for the callers (and tests) that have always imported it here. */
export { formatElapsed }

/**
 * Backup run NOTIFICATIONS (story 16.12) — the run job tells the operator what
 * happened, through PVE's own notification system (Principle 15: leverage the
 * host, don't duplicate it; we emit, PVE matches and delivers).
 *
 * Operator context: the six cron jobs Epic 16 replaced mailed the FULL
 * proxmox-backup-client output of every run, so "PVE's lead" here is vzdump's:
 * a per-task mode whose DEFAULT is `always`, and a body detailed enough to read
 * instead of the run — the archive lines pbc printed, the duration, the prune
 * counts, the warnings verbatim, and on a failure the error itself.
 *
 * Emission is BEST-EFFORT (pve-notify's contract, preserved): a notification
 * that cannot be delivered never fails the run job that emitted it.
 */

/** pbc prints `Duration: 12.3s`; the body states the value, not the label. */
const DURATION_LABEL_RE = /^Duration:\s*/i
/** The `Starting backup: ` prefix on pbc's group line (the body says Snapshot:). */
const STARTING_LABEL_RE = /^Starting backup:\s*/

/** What a finished run amounts to, for notification purposes. */
export type BackupNotifyOutcome
  /** A run that backed up (or benignly had nothing new) and reported no problem. */
  = | 'success'
  /** Completed, but carrying warnings — e.g. a prune that failed after a good backup. */
    | 'warning'
  /** The run job failed; the error text rides the body. */
    | 'failure'
  /** A deliberate no-op (the biweekly off-week gate) — never notifies. */
    | 'skip'

/** The result shape a finished run hands back (runner result, or a gated skip). */
export interface BackupNotifyResult {
  status: string
  target?: string
  archives?: string[]
  /** pbc's own `Duration: …` line, when it printed one. */
  duration?: string
  reason?: string
  nofileWarning?: string
  prune?: BackupPruneResult
  warnings?: string[]
}

export interface BackupNotifyContext {
  task: BackupTask
  /** The resolved repository, when the run got far enough to resolve one. */
  repo?: BackupRepo
  /** The effective PBS namespace (task's, else the repo's), when known. */
  namespace?: string
  /** The finished run result — absent when the run threw. */
  result?: BackupNotifyResult
  /** The failure message — present ONLY for a failed run. */
  error?: string
  /** Wall-clock time the run took inside the job (fallback for pbc's Duration). */
  elapsedMs?: number
}

/**
 * Classify a finished run. A gated off-week skip is its own outcome because it
 * is the one case that stays silent in BOTH modes; the benign too-soon
 * collision, by contrast, is a run that really executed and reported nothing
 * wrong, so it reads as a success whose body says nothing needed backing up.
 */
export function backupNotifyOutcome(ctx: BackupNotifyContext): BackupNotifyOutcome {
  if (ctx.error !== undefined)
    return 'failure'
  if (ctx.result?.status === BACKUP_SKIPPED_OFF_WEEK)
    return 'skip'
  return ctx.result?.warnings?.length ? 'warning' : 'success'
}

/**
 * Does this outcome notify in this mode? `always` (the default) notifies every
 * real run; `on-failure` notifies only what went wrong — and a
 * completed-with-warnings run counts as wrong enough to mail (the prune
 * problem is precisely what an on-failure operator asked to hear about). A skip
 * notifies in neither mode.
 */
export function shouldNotifyBackup(mode: BackupNotifyMode, outcome: BackupNotifyOutcome): boolean {
  if (outcome === 'skip')
    return false
  if (outcome === 'success')
    return mode === 'always'
  return true
}

/** Severity per outcome — PVE routes on it, so it is not decoration. */
export function backupNotifySeverity(outcome: BackupNotifyOutcome): PveNotifySeverity {
  if (outcome === 'failure')
    return 'error'
  if (outcome === 'warning')
    return 'warning'
  return 'info'
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function backupNotifyTitle(task: BackupTask, outcome: BackupNotifyOutcome): string {
  if (outcome === 'failure')
    return `backup '${task.name}' FAILED`
  if (outcome === 'warning')
    return `backup '${task.name}' completed with warnings`
  return `backup '${task.name}' succeeded`
}

/** `repo:datastore / namespace` — the target, spelled out, never truncated. */
export function backupTargetLine(ctx: BackupNotifyContext): string {
  const repoName = ctx.repo?.name ?? ctx.task.repository
  const datastore = ctx.repo?.datastore
  const namespace = ctx.namespace ?? ctx.task.namespace ?? ctx.repo?.namespace
  return `${repoName}${datastore ? `:${datastore}` : ''}${namespace ? ` / ${namespace}` : ''}`
}

/**
 * The duration as the body states it: pbc's OWN `Duration:` line when it
 * printed one (the truthful number for the backup itself), else the job's
 * wall-clock elapsed — labeled so the two are never confused.
 */
function durationLine(ctx: BackupNotifyContext): string | null {
  const pbc = ctx.result?.duration
  if (pbc)
    return pbc.replace(DURATION_LABEL_RE, '')
  if (typeof ctx.elapsedMs === 'number')
    return `${formatElapsed(ctx.elapsedMs)} (job elapsed)`
  return null
}

/**
 * The notification BODY — plain text, scannable, and detailed on purpose: this
 * is what replaces reading the cron mail. Nothing here can carry a secret (pbc
 * keeps them in the environment, and every string below comes from the task
 * config or pbc's own stderr).
 */
export function buildBackupNotifyBody(ctx: BackupNotifyContext): string {
  const outcome = backupNotifyOutcome(ctx)
  const result = ctx.result
  const lines: string[] = []

  const status = outcome === 'failure'
    ? 'FAILED'
    : outcome === 'warning'
      ? 'completed with warnings'
      : result?.status === 'skipped' ? 'completed — nothing new to back up' : 'success'

  lines.push(`Task:        ${ctx.task.name}`)
  lines.push(`Repository:  ${backupTargetLine(ctx)}`)
  lines.push(`Backup ID:   host/${ctx.task.backupId}`)
  lines.push(`Result:      ${status}`)
  const duration = durationLine(ctx)
  if (duration)
    lines.push(`Duration:    ${duration}`)
  if (result?.target)
    lines.push(`Snapshot:    ${result.target.replace(STARTING_LABEL_RE, '')}`)

  const archives = result?.archives ?? []
  if (archives.length) {
    lines.push('')
    lines.push('Archives:')
    for (const line of archives)
      lines.push(`  ${line}`)
  }
  else if (outcome !== 'failure') {
    lines.push('')
    lines.push(`Archives:    none reported${result?.reason ? ` — ${result.reason}` : ''}`)
  }

  if (result?.prune) {
    lines.push('')
    lines.push(`Retention:   ${pruneSummaryLine(result.prune)}`)
  }

  if (result?.nofileWarning) {
    lines.push('')
    lines.push(`Note:        ${result.nofileWarning}`)
  }

  if (result?.warnings?.length) {
    lines.push('')
    lines.push('Warnings:')
    for (const w of result.warnings)
      lines.push(`  ${w}`)
  }

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  lines.push('')
  lines.push(`Schedule:    ${ctx.task.schedule}${ctx.task.enabled ? '' : ' (task disabled)'}`)
  lines.push('Server-side snapshot history and verification state live in the PBS UI — '
    + 'ANAS never reads them.')
  return lines.join('\n')
}

/**
 * Emit the run notification, if this task's mode wants one. Called at the ONE
 * place every run converges on — the daemon's run job (a timer fire and a UI
 * Run Now both arrive there through the task's own unit).
 *
 * Never throws: pve-notify swallows delivery problems, and the mode check
 * happens before anything is executed, so a task set to `on-failure` costs a
 * successful run nothing at all.
 */
export async function notifyBackupRun(
  executor: CommandExecutor,
  ctx: BackupNotifyContext,
): Promise<void> {
  const outcome = backupNotifyOutcome(ctx)
  if (!shouldNotifyBackup(ctx.task.notify, outcome))
    return
  await pveNotify(
    executor,
    backupNotifySeverity(outcome),
    backupNotifyTitle(ctx.task, outcome),
    buildBackupNotifyBody(ctx),
    ANAS_BACKUP_NOTIFY_TEMPLATE,
  )
}
