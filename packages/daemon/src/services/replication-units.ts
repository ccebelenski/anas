import type { DashboardWarning, ReplicationTask, ReplicationTaskStatus, Snapshot } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LenientReplicationTask as LenientReplicationTaskSchema, ReplicationTask as ReplicationTaskSchema } from '@anas/shared'
import { parseSnapshotList, zfsSnapshotDetailArgs } from '../parsers/zfs-list.js'
import { isTransientBackupSnapshot } from './snapshot-naming.js'

/**
 * Recurring replication TASKS (Epic 5.5.3) — the systemd units ARE the store.
 *
 * Each task is a `anas-repl-<name>.service` + `.timer` pair in the systemd unit
 * directory. There is NO second config source and NO custom scheduler (standing
 * ruling): CRUD writes/rewrites/removes the two unit files and drives
 * `systemctl` to reload + enable/disable the timer. The canonical ReplicationTask
 * JSON is embedded verbatim in the service file as an `X-ANAS-Task=` comment and
 * is the SINGLE source of truth for parsing a task back — we never
 * reverse-engineer it from ExecStart.
 *
 * Status is DERIVED, never stored (Principle 7): authoritative last-success/lag
 * come from ZFS snapshot state on both ends (the newest source snapshot also
 * present on the target IS the durable record); current failure state comes from
 * systemd; journald is forensics only. Every derivation fails open to
 * nulls/'unknown' so one broken source never blanks the view.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const ZFS = '/usr/sbin/zfs'
/** The timer executes this compiled runner (ships in dist — see replicate-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/replicate-task.js'
const UNIT_PREFIX = 'anas-repl-'
/** The service-file line that carries the canonical task JSON (as a comment). */
const TASK_MARKER = 'X-ANAS-Task='
/** Matches the X-ANAS-Task line (with or without a leading `# `), capturing the JSON. */
const TASK_MARKER_RE = /^#?\s*X-ANAS-Task=(.*)$/
const WHITESPACE_RE = /\s/
const DQUOTE_RE = /"/g
const NA_RE = /^n\/a$/i
const INFINITY_RE = /infinity/i
const LEADING_WEEKDAY_RE = /^[A-Z][a-z]{2}\s+/

/** Default systemd unit directory; overridable (env/dep) for tests. */
export const DEFAULT_SYSTEMD_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

export function serviceUnitName(name: string): string {
  return `${UNIT_PREFIX}${name}.service`
}
export function timerUnitName(name: string): string {
  return `${UNIT_PREFIX}${name}.timer`
}

// --- Runner argv -------------------------------------------------------------

/**
 * The argv the timer passes to the runner. Source dataset is pool-relative
 * ('' = the pool root); everything else is passed only when it DIFFERS from the
 * endpoint's own default, the idiom this ExecStart has always used (the runner
 * is a dumb conduit and the endpoint owns the defaults).
 */
export function runnerArgs(task: ReplicationTask): string[] {
  const args = [
    '--pool',
    task.source.pool,
    '--dataset',
    task.source.dataset,
    '--target-pool',
    task.target.pool,
  ]
  if (task.target.dataset !== undefined && task.target.dataset !== '')
    args.push('--target-dataset', task.target.dataset)
  // Stage 3: emit the target LOCATION so the runner replicates to a peer/remote.
  // Absent or 'local' → nothing (the runner defaults to a same-node target).
  const location = task.target.location
  if (location && location.kind !== 'local') {
    args.push('--location-kind', location.kind)
    if (location.name !== undefined)
      args.push('--location-name', location.name)
  }
  if (task.snapshotFirst)
    args.push('--snapshot-first')
  // 9.4: the notification MODE is stored in the task JSON above, but the ONE
  // place that actually notifies is the one-shot replicate endpoint — which
  // knows nothing about tasks — so the runner has to carry it there. Emitted
  // ONLY for the opt-in `always`: the endpoint already defaults to 'on-failure',
  // so a quiet task's ExecStart stays byte-identical to what it was before the
  // field existed (and a unit rewritten by a newer daemon never hands an older
  // runner a flag it cannot parse).
  if (task.notify === 'always')
    args.push('--notify', task.notify)
  return args
}

/**
 * Quote an ExecStart token so systemd's own splitter round-trips it (empty
 *  strings and any whitespace get double-quoted; ZFS/pool names are otherwise
 *  quote-free).
 *
 * Belt-and-suspenders: a newline or carriage return in a token would end the
 * `ExecStart=` line and inject an arbitrary systemd directive. The shared
 * schemas now forbid such values from ever reaching here, but this writer
 * refuses them unconditionally — the unit file is a security boundary in its own
 * right.
 */
function quoteExecArg(a: string): string {
  if (a.includes('\n') || a.includes('\r'))
    throw new Error('ExecStart argument must not contain a newline or carriage return')
  if (a === '' || WHITESPACE_RE.test(a))
    return `"${a.replace(DQUOTE_RE, '\\"')}"`
  return a
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Render the `.service` unit. The `X-ANAS-Task=` comment embeds the canonical
 * task JSON (single line) — the ONLY thing the parser reads back. ExecStart is
 * for systemd to actually run; it is never parsed by us.
 */
export function renderServiceUnit(task: ReplicationTask): string {
  const execStart = [RUNNER_NODE, RUNNER_SCRIPT, ...runnerArgs(task).map(quoteExecArg)].join(' ')
  return [
    '[Unit]',
    `Description=ANAS replication task ${task.name}`,
    `# ${TASK_MARKER}${JSON.stringify(task)}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/** Render the `.timer` unit for a task's schedule. */
export function renderTimerUnit(task: ReplicationTask): string {
  return [
    '[Unit]',
    `Description=ANAS replication timer ${task.name}`,
    '',
    '[Timer]',
    `OnCalendar=${task.schedule}`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/**
 * Parse the canonical ReplicationTask out of a `.service` unit's body by reading
 * its `X-ANAS-Task=` line (with or without the leading `# `) and validating the
 * JSON.
 *
 * Strict-on-write, LENIENT-ON-READ (the store's timer keeps firing whatever we
 * think): a stored task that fails STRICT validation but parses under the
 * lenient variant (a dataset that no longer matches the narrowed regex, say) is
 * returned FLAGGED `invalid` — never silently dropped — so the UI shows it and
 * the operator can delete/repair it. Returns null only when the marker is
 * absent, the JSON is malformed, or it fails even lenient parsing (the caller
 * skips those, logging to journald).
 */
export function parseServiceUnit(content: string): ReplicationTask | null {
  for (const line of content.split('\n')) {
    const m = line.match(TASK_MARKER_RE)
    if (!m)
      continue
    let json: unknown
    try {
      json = JSON.parse(m[1])
    }
    catch {
      return null
    }
    const strict = ReplicationTaskSchema.safeParse(json)
    if (strict.success)
      return strict.data
    // Strict failed — keep it visible if it parses leniently, flagged for repair.
    const lenient = LenientReplicationTaskSchema.safeParse(json)
    if (lenient.success) {
      return {
        ...lenient.data,
        invalid: true,
        invalidReason: strict.error.issues[0]?.message ?? 'failed strict validation',
      }
    }
    return null
  }
  return null
}

// --- Store: read ------------------------------------------------------------

/**
 * All valid tasks parsed from `anas-repl-*.service` files in `dir`. Invalid or
 *  unparseable files are skipped with a warning (fail-open); a missing/unreadable
 *  dir yields an empty list.
 */
export async function readAllTasks(dir: string): Promise<ReplicationTask[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  }
  catch {
    return []
  }
  const services = files.filter(f => f.startsWith(UNIT_PREFIX) && f.endsWith('.service'))
  const tasks: ReplicationTask[] = []
  for (const file of services) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      const task = parseServiceUnit(content)
      if (task)
        tasks.push(task)
      else
        process.stderr.write(`[replication] skipping ${file}: no parseable X-ANAS-Task JSON\n`)
    }
    catch (err) {
      process.stderr.write(`[replication] skipping ${file}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  return tasks
}

/** One task by name, or null if its service file is absent/invalid. */
export async function readTask(dir: string, name: string): Promise<ReplicationTask | null> {
  try {
    const content = await readFile(join(dir, serviceUnitName(name)), 'utf-8')
    return parseServiceUnit(content)
  }
  catch {
    return null
  }
}

/** Does a task's service file exist on disk? (the store is the files). */
export async function taskFileExists(dir: string, name: string): Promise<boolean> {
  try {
    await readFile(join(dir, serviceUnitName(name)), 'utf-8')
    return true
  }
  catch {
    return false
  }
}

// --- Store: validate + write + remove ---------------------------------------

/**
 * Validate a schedule with `systemd-analyze calendar <expr>` — honest
 * validation for free (systemd is the authority on OnCalendar syntax). Returns
 * the tool's own stderr on failure so the caller can 400 with it.
 */
export async function validateSchedule(
  executor: CommandExecutor,
  schedule: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const r = await executor.exec(SYSTEMD_ANALYZE, ['calendar', schedule])
    if (r.exitCode === 0)
      return { ok: true }
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `invalid OnCalendar expression '${schedule}'` }
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Write (or rewrite) a task's service+timer, reload systemd, then bring the
 * timer to match `enabled` (`enable --now` / `disable --now`). Throws on any
 * systemctl failure so the mutation surfaces it.
 */
export async function writeTaskUnits(
  executor: CommandExecutor,
  dir: string,
  task: ReplicationTask,
): Promise<void> {
  await writeFile(join(dir, serviceUnitName(task.name)), renderServiceUnit(task), 'utf-8')
  await writeFile(join(dir, timerUnitName(task.name)), renderTimerUnit(task), 'utf-8')

  await runSystemctl(executor, ['daemon-reload'])
  const timer = timerUnitName(task.name)
  if (task.enabled)
    await runSystemctl(executor, ['enable', '--now', timer])
  else
    await runSystemctl(executor, ['disable', '--now', timer])
}

/**
 * Remove a task: stop+disable the timer, delete both unit files, reload systemd.
 * Deliberately touches NOTHING in ZFS — data, snapshots and `anas-repl` holds
 * are left exactly as they are (deleting a schedule is not deleting a backup).
 */
export async function removeTaskUnits(
  executor: CommandExecutor,
  dir: string,
  name: string,
): Promise<void> {
  // Best-effort disable first (ignore failure — the unit may already be gone).
  await executor.exec(SYSTEMCTL, ['disable', '--now', timerUnitName(name)])
  await Promise.all([
    unlinkQuiet(join(dir, serviceUnitName(name))),
    unlinkQuiet(join(dir, timerUnitName(name))),
  ])
  await runSystemctl(executor, ['daemon-reload'])
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  }
  catch {
    // Missing file is fine — the goal state (absent) already holds.
  }
}

async function runSystemctl(executor: CommandExecutor, args: string[]): Promise<void> {
  const r = await executor.exec(SYSTEMCTL, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `systemctl ${args.join(' ')} exited with code ${r.exitCode}`)
}

// --- Status derivation ------------------------------------------------------

/**
 * The full ZFS names a task's source and target resolve to (mirrors the
 *  stage-1 endpoint's target resolution).
 */
export function resolveTaskDatasets(task: ReplicationTask): { sourceFull: string, targetFull: string } {
  const sourceFull = task.source.dataset ? `${task.source.pool}/${task.source.dataset}` : task.source.pool
  const targetRel = task.target.dataset ?? (task.source.dataset || task.source.pool)
  return { sourceFull, targetFull: `${task.target.pool}/${targetRel}` }
}

/** A dataset's snapshots newest-first, or [] on any error (fail-open). */
async function listSnapshots(executor: CommandExecutor, fullDataset: string): Promise<Snapshot[]> {
  try {
    const r = await executor.exec(ZFS, zfsSnapshotDetailArgs(fullDataset))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return parseSnapshotList(r.stdout)
  }
  catch {
    return []
  }
}

/** Parse `systemctl show` `key=value` lines into a map. */
function parseShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0)
      props[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return props
}

/**
 * Map a service's systemd state to a run result. A oneshot is 'activating' (or
 * 'active') while running; after it exits, Result carries the outcome
 * ('success' vs anything else) and ActiveState becomes 'failed' on failure.
 */
function deriveRunResult(props: Record<string, string>): ReplicationTaskStatus['lastRunResult'] {
  const active = props.ActiveState
  if (active === 'activating' || active === 'active' || active === 'reloading')
    return 'running'
  if (active === 'failed')
    return 'failure'
  const result = props.Result
  if (result === 'success')
    return 'success'
  if (result && result.length > 0)
    return 'failure'
  return 'unknown'
}

/** `systemctl show <service> -p ActiveState,Result,ExecMainStatus` → run result. */
async function serviceRunResult(
  executor: CommandExecutor,
  name: string,
): Promise<ReplicationTaskStatus['lastRunResult']> {
  try {
    const r = await executor.exec(SYSTEMCTL, [
      'show',
      serviceUnitName(name),
      '-p',
      'ActiveState,Result,ExecMainStatus',
    ])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return 'unknown'
    return deriveRunResult(parseShow(r.stdout))
  }
  catch {
    return 'unknown'
  }
}

/** `systemctl show <timer> -p NextElapseUSecRealtime` → ISO time or null. */
async function timerNextRun(executor: CommandExecutor, name: string): Promise<string | null> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['show', timerUnitName(name), '-p', 'NextElapseUSecRealtime'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return null
    const raw = parseShow(r.stdout).NextElapseUSecRealtime
    if (!raw || raw === '0' || NA_RE.test(raw) || INFINITY_RE.test(raw))
      return null
    // Despite the property's name, `systemctl show` prints a HUMAN date string
    // ("Fri 2026-07-17 00:00:00 UTC"), not microseconds (verified live on
    // PVE 9 / systemd 257). Handle both forms: numeric µs (older systemd /
    // machine formats) and the day-name-prefixed date string.
    const usec = Number(raw)
    if (Number.isFinite(usec) && usec > 0) {
      const d = new Date(Math.floor(usec / 1000))
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    // Strip a leading weekday name ("Fri ") — Date.parse dislikes it combined
    // with the "UTC" suffix on some engines; the rest parses cleanly.
    const cleaned = raw.replace(LEADING_WEEKDAY_RE, '')
    const parsed = Date.parse(cleaned)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  catch {
    return null
  }
}

/**
 * Derive one task's live status. lastReplicated* and snapshotsBehind come from
 * ZFS (the newest source snapshot also on the target); lastRunResult from
 * systemd; nextRunAt from the timer. Source with no snapshots (or gone) → nulls.
 */
/**
 * How a caller supplies the TARGET's snapshot names for a task whose target is
 * non-local (stage 3): returns the name set, or null when the remote could not
 * be read (transport down ≠ "nothing replicated" — status must show unknown,
 * never a false "N behind").
 */
export type TargetNamesResolver
  = (task: ReplicationTask, targetFull: string) => Promise<Set<string> | null>

export async function deriveTaskStatus(
  executor: CommandExecutor,
  task: ReplicationTask,
  remoteTargetNames?: TargetNamesResolver,
): Promise<ReplicationTaskStatus> {
  const { sourceFull, targetFull } = resolveTaskDatasets(task)

  // newest-first. ⚠ Transient backup snapshots (`anas-backup-<task>-<ts>`) are
  // dropped here as well as in the base discovery (backup2.3): they are never
  // replicated by design, so counting them would report a healthy task as N
  // behind for as long as a backup run is in flight — and the count would then
  // silently fix itself when the run's `finally` destroyed them.
  const sourceSnaps = (await listSnapshots(executor, sourceFull))
    .filter(s => !isTransientBackupSnapshot(s.snapshotName))
  let lastReplicatedSnapshot: string | null = null
  let lastReplicatedAt: string | null = null
  let snapshotsBehind: number | null = null

  if (sourceSnaps.length > 0) {
    // Local target → list locally. Non-local target → the injected resolver
    // reads the REMOTE's snapshots over SSH (stage 3); without a resolver the
    // remote is unreadable here, so the lag honestly stays unknown (nulls).
    const isLocalTarget = !task.target.location || task.target.location.kind === 'local'
    let targetNames: Set<string> | null
    if (isLocalTarget) {
      targetNames = new Set((await listSnapshots(executor, targetFull)).map(s => s.snapshotName))
    }
    else if (remoteTargetNames) {
      targetNames = await remoteTargetNames(task, targetFull)
    }
    else {
      targetNames = null
    }

    if (targetNames !== null) {
      // First (newest) source snapshot present on the target = last successful sync.
      const idx = sourceSnaps.findIndex(s => targetNames.has(s.snapshotName))
      if (idx !== -1) {
        lastReplicatedSnapshot = sourceSnaps[idx].snapshotName
        lastReplicatedAt = sourceSnaps[idx].created
        snapshotsBehind = idx // source snapshots newer than the last replicated one
      }
      else {
        // Nothing replicated yet: every source snapshot is behind.
        snapshotsBehind = sourceSnaps.length
      }
    }
  }

  const [lastRunResult, nextRunAt] = await Promise.all([
    serviceRunResult(executor, task.name),
    timerNextRun(executor, task.name),
  ])

  return { task, lastReplicatedSnapshot, lastReplicatedAt, snapshotsBehind, lastRunResult, nextRunAt }
}

/** Derive statuses for every task in the store (fail-open per task). */
export async function collectTaskStatuses(
  executor: CommandExecutor,
  dir: string,
  remoteTargetNames?: TargetNamesResolver,
): Promise<ReplicationTaskStatus[]> {
  const tasks = await readAllTasks(dir)
  return Promise.all(tasks.map(t => deriveTaskStatus(executor, t, remoteTargetNames)))
}

/**
 * Dashboard warnings for failed replication tasks (category 'replication'). One
 * per task whose last run failed; the ref is the task name so the UI can
 * deep-link into the Replication view.
 */
export function buildReplicationWarnings(statuses: ReplicationTaskStatus[]): DashboardWarning[] {
  return statuses
    .filter(s => s.lastRunResult === 'failure')
    .map(s => ({
      level: 'warning',
      category: 'replication',
      message: `Replication task '${s.task.name}' last run failed — check the Replication view`,
      ref: s.task.name,
    }))
}
