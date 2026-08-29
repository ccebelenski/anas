import type {
  BackupArchiveConsistency,
  BackupExpandedArchive,
  BackupNotifyMode,
  BackupPruneResult,
  BackupRepo,
  BackupTask,
  BackupTransientSnapshot,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { PveNotifySeverity } from './pve-notify.js'
import type { NotifyOutcome } from './unattended-notify.js'
import { archiveSpecType, BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { pruneSummaryLine } from './backup-prune.js'
import { ANAS_BACKUP_NOTIFY_TEMPLATE, pveNotify } from './pve-notify.js'
import { formatElapsed, notifySeverity, shouldNotify } from './unattended-notify.js'

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

/**
 * What a finished run amounts to, for notification purposes. This IS the shared
 * {@link NotifyOutcome} — 9.4 gave snapshot schedules and replication the same
 * four outcomes, so the union (and the gate below) live in unattended-notify.ts
 * and every family classifies into one vocabulary.
 */
export type BackupNotifyOutcome = NotifyOutcome

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
  /**
   * Informational lines about the run — nested filesystems stored as empty
   * directories because the task's includeNested does not cover them. They
   * ride the body (as notes) on a success AND a warning outcome alike, and
   * never change the outcome or the severity. Absent on an old daemon.
   */
  notices?: string[]
  /**
   * Archive name → the filesystem boundaries the run crossed (`--include-dev`).
   * What an `all` choice RESOLVED to is a per-run fact, so the body states it
   * rather than leaving the reader to infer it from the task config (backup2.2).
   */
  includedNested?: Record<string, string[]>
  /**
   * backup2.3 — the DERIVED consistency of each archive source, in task order.
   * `snapshot <name>` or `live`: the operator reading this mail must be able to
   * tell whether the run captured one instant or a moving tree, without opening
   * the UI. Absent on an old daemon (version skew: additive, warn-don't-fail).
   */
  consistency?: BackupArchiveConsistency[]
  /** The transient snapshots the run took (and destroyed before this body existed). */
  snapshots?: BackupTransientSnapshot[]
  /** One entry per archive root pbc was actually handed (the expansion). */
  expansion?: BackupExpandedArchive[]
  /**
   * backup2.4 — the `.img` archives the run uploaded and the device or file each
   * was read from (`Upload image '<source>' … as <name>.img.fidx`). Absent on a
   * task with no image archives, and on a daemon that predates the field.
   */
  images?: { archive: string, source: string }[]
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
 *
 * The level is derived from `warnings` ONLY. `notices` — nested filesystems
 * stored empty by a deliberate includeNested choice — never promote a run to
 * `warning` (operator ruling 2026-08-28): a run whose only finding is an
 * uncovered nested filesystem is a `success` whose body carries the note.
 */
export function backupNotifyOutcome(ctx: BackupNotifyContext): BackupNotifyOutcome {
  if (ctx.error !== undefined)
    return 'failure'
  if (ctx.result?.status === BACKUP_SKIPPED_OFF_WEEK)
    return 'skip'
  return ctx.result?.warnings?.length ? 'warning' : 'success'
}

/**
 * Does this outcome notify in this mode? The shared gate under a backup-shaped
 * name — see {@link shouldNotify}: `always` notifies every real run,
 * `on-failure` only warning + failure, a skip neither.
 */
export function shouldNotifyBackup(mode: BackupNotifyMode, outcome: BackupNotifyOutcome): boolean {
  return shouldNotify(mode, outcome)
}

/** Severity per outcome — PVE routes on it, so it is not decoration. */
export function backupNotifySeverity(outcome: BackupNotifyOutcome): PveNotifySeverity {
  return notifySeverity(outcome)
}

/** The subject line's title (the template renders `ANAS: <title>`). */
export function backupNotifyTitle(task: BackupTask, outcome: BackupNotifyOutcome): string {
  if (outcome === 'failure')
    return `backup '${task.name}' FAILED`
  if (outcome === 'warning')
    return `backup '${task.name}' completed with warnings`
  return `backup '${task.name}' succeeded`
}

/**
 * `repo:datastore / namespace` — the target, spelled out, never truncated.
 *
 * The datastore suffix is appended only when the repo NAME does not already end
 * in it. A PVE-sourced repository is named `pve:<datastore>`, so the
 * unconditional append rendered `pve:store1:store1` in a real notification
 * (ground truth 2026-08-19) — the name already carried the datastore. An exact
 * suffix check, not a contains: a repo genuinely named for a DIFFERENT datastore
 * must still say so.
 */
export function backupTargetLine(ctx: BackupNotifyContext): string {
  const repoName = ctx.repo?.name ?? ctx.task.repository
  const datastore = ctx.repo?.datastore
  const namespace = ctx.namespace ?? ctx.task.namespace ?? ctx.repo?.namespace
  const suffix = datastore && !repoName.endsWith(`:${datastore}`) ? `:${datastore}` : ''
  return `${repoName}${suffix}${namespace ? ` / ${namespace}` : ''}`
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
 * The per-archive "Consistency:" lines (backup2.3). One per configured archive,
 * naming the archive, the verdict, and — for `snapshot` — the transient snapshot
 * the run read from. Empty when the daemon that produced the result predates the
 * field, which is the version-skew rule: additive, warn-don't-fail, and a body
 * that says nothing is better than one that guesses `live`.
 */
export function consistencyBlock(ctx: BackupNotifyContext): string[] {
  const result = ctx.result
  const derived = result?.consistency
  if (!derived?.length)
    return []
  const snapshots = result?.snapshots ?? []
  return derived.map((c, i) => {
    const archive = ctx.task.archives[i]?.name ?? `archive ${i + 1}`
    if (c.consistency !== 'snapshot')
      return `${archive}: live`
    // The snapshot taken on THIS archive's target — never truncated.
    const snap = snapshots.find(s => s.target === c.target && s.backend === c.backend)
    return `${archive}: snapshot ${snap ? snap.full : (c.target ?? '')}`
  })
}

/**
 * The notification BODY — plain text, scannable, and detailed on purpose: this
 * is what replaces reading the cron mail. Nothing here can carry a secret (pbc
 * keeps them in the environment, and every string below comes from the task
 * config or pbc's own stderr).
 *
 * ASCII ONLY, deliberately (ground truth 2026-08-19): an em-dash in the closing
 * line arrived as mojibake on a real gotify target — something between PVE's
 * notification pipeline and the delivery agent reads our UTF-8 as Latin-1. We do
 * not own that pipeline and cannot fix it, so we stop giving it anything to get
 * wrong. Same rule in every notify builder (snapshot + replication); guarded by
 * a test in each family.
 */
export function buildBackupNotifyBody(ctx: BackupNotifyContext): string {
  const outcome = backupNotifyOutcome(ctx)
  const result = ctx.result
  const lines: string[] = []

  const status = outcome === 'failure'
    ? 'FAILED'
    : outcome === 'warning'
      ? 'completed with warnings'
      : result?.status === 'skipped' ? 'completed - nothing new to back up' : 'success'

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
    lines.push(`Archives:    none reported${result?.reason ? ` - ${result.reason}` : ''}`)
  }

  // backup2.3 — was this one instant, or a moving tree? Short and per-archive:
  // `snapshot <name>` when the run took (and destroyed) a point-in-time
  // snapshot, `live` when the filesystem could not give one. ASCII only.
  const consistencyLines = consistencyBlock(ctx)
  if (consistencyLines.length) {
    lines.push('')
    lines.push('Consistency:')
    for (const line of consistencyLines)
      lines.push(`  ${line}`)
  }

  // The archive roots pbc was actually handed — one per nested filesystem the
  // run expanded into, so a `data` + `data__photos` pair is visible as such.
  if (result?.expansion && result.expansion.length > (result.consistency?.length ?? 0)) {
    lines.push('')
    lines.push('Archive roots:')
    for (const e of result.expansion)
      lines.push(`  ${e.name}.${archiveSpecType(e.kind ?? 'pxar')} <- ${e.root}`)
  }

  // backup2.4 — the image archives and what each was actually READ FROM. In
  // snapshot mode that is the snapshot's own device node, which is the one line
  // that proves the run did not read the live volume. It is listed even when the
  // expansion block above is absent (an image never expands, so a single-image
  // task would otherwise say nothing about its source at all).
  if (result?.images?.length) {
    lines.push('')
    lines.push('Image sources:')
    for (const img of result.images)
      lines.push(`  ${img.archive}.img <- ${img.source}`)
  }

  if (result?.prune) {
    lines.push('')
    lines.push(`Retention:   ${pruneSummaryLine(result.prune)}`)
  }

  if (result?.includedNested && Object.keys(result.includedNested).length) {
    lines.push('')
    lines.push('Nested filesystems crossed:')
    for (const [archive, paths] of Object.entries(result.includedNested)) {
      for (const path of paths)
        lines.push(`  ${archive}: ${path}`)
    }
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

  // Notes: informational, same formatting as the warnings block. Shown on a
  // success AND a warning outcome alike — a run whose ONLY finding is an
  // uncovered nested filesystem is a success whose body still says so.
  if (result?.notices?.length) {
    lines.push('')
    lines.push('Notes:')
    for (const n of result.notices)
      lines.push(`  ${n}`)
  }

  if (ctx.error !== undefined) {
    lines.push('')
    lines.push('Error:')
    lines.push(`  ${ctx.error}`)
  }

  lines.push('')
  lines.push(`Schedule:    ${ctx.task.schedule}${ctx.task.enabled ? '' : ' (task disabled)'}`)
  // The body ends on the facts. No closing pointer, no editorial: the operator
  // reading this run's mail knows where the UI is.
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
