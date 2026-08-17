import type { BackupPruneResult, BackupPruneSnapshot, BackupPruneVerdict, BackupRepo, BackupRetention, BackupTask } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { hasRetentionKeeps } from '@anas/shared'
import { buildBackupEnv, effectiveNamespace, firstErrorLine, PBC } from './backup-runner.js'

/**
 * PBS RETENTION (story 16.11) — `proxmox-backup-client prune`, the only prune
 * ANAS ever runs. Two callers, one implementation:
 *   - the backup job, AFTER a successful run, with the task's own keep flags;
 *   - the wizard's Preview button, `--dry-run`, user-initiated and one-shot.
 *
 * Rulings this file encodes (do NOT contradict):
 *   - An ABSENT policy never invokes prune at all. A prune with no keep flags is
 *     a keep-all no-op on the server (fixture `prune-no-keep-flags.txt`) — we do
 *     not even run it. `hasRetentionKeeps` (shared) is the single gate.
 *   - `--output-format json` ALWAYS (Principle 13). The human table pbc prints by
 *     default is never parsed; dry-run and real prune emit the SAME JSON array.
 *   - GC stays PBS-side. Prune only MARKS snapshots removed; ANAS never surfaces
 *     or triggers garbage collection.
 *   - A prune failure after a successful backup is a WARNING, never a job
 *     failure — the backup data is already safe (PVE's vzdump treats it the same).
 *
 * Ground truth (fixtures/backup/NOTES.md §11, captured 2026-08-17):
 *   - exit 0 → `[{"backup-id":…,"backup-time":…,"backup-type":"host",
 *     "keep":bool,"ns":"…","protected":bool}, …]`
 *   - A missing GROUP and a missing NAMESPACE are INDISTINGUISHABLE: both
 *     `Error: ENOENT: No such file or directory`, exit 255. The verdict says
 *     "group or namespace" — it never guesses which.
 *   - No prune privilege → `Error: permission check failed - missing
 *     Datastore.Modify|Datastore.Prune on /datastore/<store>/<ns>`, exit 255.
 */

/** ENOENT — a missing group OR a missing namespace (indistinguishable). */
const PRUNE_ENOENT_RE = /ENOENT|No such file or directory/i
/** The prune-privilege refusal (names the privileges it wanted). */
const PRUNE_PERM_RE = /permission check failed\s*-\s*missing/i

/** The PBS group identity for a task's backup-id: `host/<backup-id>`. */
export function pruneGroup(backupId: string): string {
  return `host/${backupId}`
}

/** The retention flags in a stable order, as pbc `--keep-*` argv pairs. */
const KEEP_FLAGS: { key: keyof BackupRetention, flag: string }[] = [
  { key: 'keepLast', flag: '--keep-last' },
  { key: 'keepDaily', flag: '--keep-daily' },
  { key: 'keepWeekly', flag: '--keep-weekly' },
  { key: 'keepMonthly', flag: '--keep-monthly' },
  { key: 'keepYearly', flag: '--keep-yearly' },
]

export interface PruneArgsOptions {
  /** The task's PBS group identity (backup-id, not the group string). */
  backupId: string
  /** Effective namespace (task's, else the repo's) — omitted at the root. */
  namespace?: string
  retention: BackupRetention
  /** Preview only: add `--dry-run` (nothing is marked removed). */
  dryRun?: boolean
}

/**
 * The pbc `prune` argv (no secrets — those are env-only, exactly as the backup
 * path): `prune host/<id> [--ns <ns>] --keep-* N … [--dry-run] --output-format
 * json`. Only the keeps the task actually configured are emitted.
 */
export function buildPruneArgs(opts: PruneArgsOptions): string[] {
  const args: string[] = ['prune', pruneGroup(opts.backupId)]
  if (opts.namespace)
    args.push('--ns', opts.namespace)
  for (const { key, flag } of KEEP_FLAGS) {
    const value = opts.retention[key]
    if (typeof value === 'number')
      args.push(flag, String(value))
  }
  if (opts.dryRun)
    args.push('--dry-run')
  args.push('--output-format', 'json')
  return args
}

/** The raw PBS record — kebab keys, exactly as `--output-format json` emits. */
interface RawPruneEntry {
  'backup-id'?: unknown
  'backup-time'?: unknown
  'backup-type'?: unknown
  'keep'?: unknown
  'ns'?: unknown
  'protected'?: unknown
}

/**
 * Parse `prune --output-format json` stdout into the domain shape. Returns null
 * when the payload is not the expected array (a pbc that printed the human
 * table, or empty output) — the caller renders an honest 'error' verdict rather
 * than inventing counts.
 */
export function parsePruneOutput(stdout: string): BackupPruneSnapshot[] | null {
  const text = stdout.trim()
  if (!text)
    return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed))
    return null
  const out: BackupPruneSnapshot[] = []
  for (const raw of parsed as RawPruneEntry[]) {
    if (!raw || typeof raw !== 'object')
      return null
    const backupId = raw['backup-id']
    const backupTime = raw['backup-time']
    const backupType = raw['backup-type']
    if (typeof backupId !== 'string' || typeof backupTime !== 'number' || typeof backupType !== 'string')
      return null
    const ns = raw.ns
    out.push({
      backupId,
      backupType,
      backupTime,
      keep: raw.keep === true,
      ...(typeof ns === 'string' && ns ? { namespace: ns } : {}),
      protected: raw.protected === true,
    })
  }
  return out
}

/** Kept / removed / protected counts over a parsed prune list. */
export function summarizePrune(snapshots: BackupPruneSnapshot[]): {
  kept: number
  removed: number
  protectedCount: number
} {
  let kept = 0
  let removed = 0
  let protectedCount = 0
  for (const s of snapshots) {
    if (s.keep)
      kept++
    else removed++
    if (s.protected)
      protectedCount++
  }
  return { kept, removed, protectedCount }
}

/**
 * Map a failed prune to a verdict + client-safe detail. Honest about what the
 * server actually told us: ENOENT cannot distinguish a missing group from a
 * missing namespace, so the message names both.
 */
export function classifyPruneVerdict(
  exitCode: number,
  stderr: string,
): { verdict: BackupPruneVerdict, detail: string } {
  if (PRUNE_PERM_RE.test(stderr)) {
    return {
      verdict: 'permission',
      detail: 'The credential lacks prune privileges — PBS wants Datastore.Modify or '
        + `Datastore.Prune on this datastore/namespace (${firstErrorLine(stderr)}).`,
    }
  }
  if (PRUNE_ENOENT_RE.test(stderr)) {
    return {
      verdict: 'not-found',
      detail: 'The backup group or the namespace does not exist on the server — PBS reports '
        + 'the same ENOENT for both, so which one is missing cannot be told apart.',
    }
  }
  return { verdict: 'error', detail: `${firstErrorLine(stderr) || `prune exited with code ${exitCode}`}` }
}

export interface PruneDeps {
  repo: BackupRepo
  secret: string
  backupId: string
  namespace?: string
  retention: BackupRetention
  dryRun?: boolean
}

/** A prune that ran and parsed, or a verdict explaining why it did not. */
export type PruneOutcome
  = | { ok: true, result: BackupPruneResult }
    | { ok: false, verdict: BackupPruneVerdict, detail: string }

/**
 * Run ONE prune (real or `--dry-run`) and classify it. Never throws: an exec
 * blow-up becomes an 'error' verdict, because the post-backup caller must not be
 * able to fail a job whose backup data already landed. Secrets ride the
 * environment only (`buildBackupEnv` — the same builder the backup path uses).
 */
export async function runPrune(executor: CommandExecutor, deps: PruneDeps): Promise<PruneOutcome> {
  const args = buildPruneArgs({
    backupId: deps.backupId,
    ...(deps.namespace ? { namespace: deps.namespace } : {}),
    retention: deps.retention,
    ...(deps.dryRun ? { dryRun: true } : {}),
  })
  let exitCode: number
  let stdout: string
  let stderr: string
  try {
    const r = await executor.exec(PBC, args, { env: buildBackupEnv(deps.repo, deps.secret) })
    exitCode = r.exitCode
    stdout = r.stdout
    stderr = r.stderr
  }
  catch (err) {
    return { ok: false, verdict: 'error', detail: err instanceof Error ? err.message : String(err) }
  }

  if (exitCode !== 0)
    return { ok: false, ...classifyPruneVerdict(exitCode, stderr) }

  const snapshots = parsePruneOutput(stdout)
  if (!snapshots) {
    return {
      ok: false,
      verdict: 'error',
      detail: 'prune exited 0 but did not return the expected JSON snapshot list',
    }
  }
  const counts = summarizePrune(snapshots)
  return {
    ok: true,
    result: {
      group: pruneGroup(deps.backupId),
      ...(deps.namespace ? { namespace: deps.namespace } : {}),
      dryRun: deps.dryRun === true,
      ...counts,
      snapshots,
    },
  }
}

// --- After a successful backup ----------------------------------------------

export interface PruneAfterBackupDeps {
  task: BackupTask
  repo: BackupRepo
  secret: string
  /** Job-progress callback (never carries a secret). */
  onProgress?: (message: string) => void
  /** Journal sink — defaults to the daemon's stdout/stderr (→ journald). */
  log?: (message: string, level: 'info' | 'warn') => void
}

/** The extra job-result fields a post-backup prune contributes (or none). */
export interface PruneAfterBackupResult {
  prune?: BackupPruneResult
  warnings?: string[]
}

/**
 * The post-backup retention step — called ONLY after a run that actually backed
 * something up. Callers must not invoke it for a failed run or a skip (a
 * too-soon collision, or a cadence off-week skip): nothing new landed, so
 * nothing is pruned.
 *
 * Returns `{}` when the task configured no retention — the default posture, in
 * which ANAS never invokes prune at all. A prune FAILURE comes back as a
 * `warnings` entry, never a throw: the backup data is already safe and the job
 * must complete (the same call PVE's vzdump makes).
 */
export async function pruneAfterBackup(
  executor: CommandExecutor,
  deps: PruneAfterBackupDeps,
): Promise<PruneAfterBackupResult> {
  const { task, repo, secret } = deps
  if (!hasRetentionKeeps(task.retention))
    return {}
  const retention = task.retention as BackupRetention
  const namespace = effectiveNamespace(task, repo)
  const progress = deps.onProgress ?? (() => {})
  // Default sink: the daemon's own stdout/stderr, which systemd captures into
  // journald (no custom log files — Principle: journald IS the audit log). The
  // routes pass fastify's logger instead.
  const log = deps.log ?? ((message, level) => {
    if (level === 'warn')
      console.warn(message)
    else process.stdout.write(`${message}\n`)
  })

  progress(`applying retention to ${pruneGroup(task.backupId)}`)
  const outcome = await runPrune(executor, {
    repo,
    secret,
    backupId: task.backupId,
    ...(namespace ? { namespace } : {}),
    retention,
  })

  if (outcome.ok) {
    const line = pruneSummaryLine(outcome.result)
    progress(line)
    log(`[backup] ${task.name}: ${line}`, 'info')
    return { prune: outcome.result }
  }

  // Completed-with-warning: the backup itself succeeded, so the job does NOT
  // fail — the operator sees the prune problem and the data is untouched.
  const warning = `Backup succeeded, but the retention prune did not run: ${outcome.detail}`
  log(`[backup] ${task.name}: prune failed (${outcome.verdict}) — ${outcome.detail}`, 'warn')
  return { warnings: [warning] }
}

/** A one-line, journal-friendly summary of a prune result (never a secret). */
export function pruneSummaryLine(result: BackupPruneResult): string {
  const ns = result.namespace ? ` [${result.namespace}]` : ''
  const prot = result.protectedCount ? `, ${result.protectedCount} protected` : ''
  return `${result.dryRun ? 'prune preview' : 'pruned'} ${result.group}${ns}: `
    + `${result.kept} kept, ${result.removed} removed${prot}`
}
