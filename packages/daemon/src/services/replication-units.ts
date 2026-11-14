import type { DashboardWarning, ReplicationTargetDrift, ReplicationTask, ReplicationTaskStatus, Snapshot } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { TreeUnchecked } from './replication-drift.js'
import type { Transport } from './replication-transport.js'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatasetPath, LenientReplicationTask as LenientReplicationTaskSchema, ReplicationTask as ReplicationTaskSchema, SnapshotName } from '@anas/shared'
import { parseTreeSnapshots, zfsTreeSnapshotsArgs } from '../parsers/zfs-tree.js'
import { checkTargetDrift, nextIncrementalBase, readBaseHeld, treeUncheckedClause, treeUncheckedSentence, worstTargetDrift, writeOrAtimeRead } from './replication-drift.js'
import { replicationHoldTag } from './replication-holds.js'
import { readLocalSnapshots, readRemoteSnapshotNames } from './replication-snapshots.js'
import { judgeTreeTargets } from './replication-tree-gate.js'
import { readFailureReason, readTreeFactsWith } from './replication-tree-read.js'
import { isTransientRunSnapshot } from './snapshot-naming.js'
// The unit-store plumbing (marker regex, unlink, systemctl, unit-dir listing)
// is the ONE shared copy in systemd-unit-store.ts — this store was its fourth
// hand-copy and its last private leftovers (third pass).
import { listServiceUnitsChecked, markerRegex, quoteExecArg, readUnitFile, refuseControlChars, runSystemctl, systemdTimersStampDir, unlinkQuiet } from './systemd-unit-store.js'
import { deriveUnitRunStatus, newestHelperResult, readOnce, readUnitJournal, showReadFailed, toSystemdRunResult, TRIGGER_SLACK_MS } from './unit-run-status.js'

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
const ZFS = '/usr/sbin/zfs'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
/** The timer executes this compiled runner (ships in dist — see replicate-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/replicate-task.js'
const UNIT_PREFIX = 'anas-repl-'
/**
 * This store's unit-name prefix, exported for the boot sweep of orphan timer
 * stamps ({@link sweepOrphanTaskStamps} takes bare prefixes too). Same constant
 * as `UNIT_PREFIX` — one home, two names, because the sweep needs the prefix
 * and nothing else about this store.
 */
export const REPLICATION_UNIT_PREFIX = UNIT_PREFIX
/** The service-file line that carries the canonical task JSON (as a comment). */
const TASK_MARKER = 'X-ANAS-Task='

/** Default systemd unit directory; overridable (env/dep) for tests. */
export const DEFAULT_SYSTEMD_DIR = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

export function serviceUnitName(name: string): string {
  return `${UNIT_PREFIX}${name}.service`
}
export function timerUnitName(name: string): string {
  return `${UNIT_PREFIX}${name}.timer`
}

/**
 * Where systemd records a Persistent timer's last fire for ONE task: the
 * timers stamp dir (shared {@link systemdTimersStampDir}) + `stamp-<timer>` —
 * e.g. `/var/lib/systemd/timers/stamp-anas-repl-<name>.timer`. A stamp a
 * removed task leaves behind makes the task's re-creation fire at once (the
 * stamp reads as a missed run — SCHEDULES-GT-17), so removal deletes it.
 */
export function replicationStampPath(name: string): string {
  return `${systemdTimersStampDir()}/stamp-${timerUnitName(name)}`
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
  // rrep.2 (#84, R10): the recursion fields ride the flag list LAST, so a task
  // without them keeps the argv (and the ExecStart) it had before the fields
  // existed, in the same order (R0). `--exclude` repeats, one per entry, in the
  // stored order — the runner forwards the list to the endpoint verbatim.
  if (task.recursive === true) {
    args.push('--recursive')
    for (const name of task.exclude ?? [])
      args.push('--exclude', name)
  }
  return args
}

// --- Unit rendering ----------------------------------------------------------
// (The ExecStart quoting + control-character refusal moved to
// systemd-unit-store.ts `quoteExecArg` — cr.51 lifted it so the snapshot,
// cloud and scrub writers refuse the same thing the same way.)

/**
 * Render the `.service` unit. The `X-ANAS-Task=` comment embeds the canonical
 * task JSON (single line) — the ONLY thing the parser reads back. ExecStart is
 * for systemd to actually run; it is never parsed by us.
 *
 * Injection refusal (cr.51r / review C1 possibles): the ExecStart tokens have
 * refused control characters since cr.51 (via {@link quoteExecArg}); `name`
 * lands in `Description=` and now asks too — the unit file is a security
 * boundary in its own right, so a direct renderer call refuses like the route
 * does. Throws — the caller writes NOTHING.
 */
export function renderServiceUnit(task: ReplicationTask): string {
  refuseControlChars(task.name, 'task name')
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

/**
 * Render the `.timer` unit for a task's schedule. Same refusals as the service
 * (cr.51r): `name` in `Description=`, and the raw OnCalendar expression — the
 * route validates it with `systemd-analyze calendar`, but the writer asks
 * again about control characters before it lands on its line.
 */
export function renderTimerUnit(task: ReplicationTask): string {
  refuseControlChars(task.name, 'task name')
  refuseControlChars(task.schedule, 'OnCalendar expression')
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
  const markerRe = markerRegex(TASK_MARKER)
  for (const line of content.split('\n')) {
    const m = line.match(markerRe)
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
  return (await readAllTasksChecked(dir)).tasks
}

/**
 * Every task, plus whether the store was read IN FULL (`complete: false` = the
 * unit dir could not be listed, or a task file could not be read or parsed).
 * A caller whose release decision depends on what the OTHER tasks are — the
 * legacy hold migration — must not mistake "unreadable" for "no other task".
 */
export async function readAllTasksChecked(dir: string): Promise<{ tasks: ReplicationTask[], complete: boolean }> {
  const listed = await listServiceUnitsChecked(dir, UNIT_PREFIX)
  const tasks: ReplicationTask[] = []
  let complete = listed.complete
  for (const file of listed.files) {
    // Fail-open per file: an unreadable file skips with the same warning as an
    // unparseable one — never a broken read for the whole store.
    const content = await readUnitFile(dir, file)
    const task = content === null ? null : parseServiceUnit(content)
    if (task) {
      tasks.push(task)
    }
    else {
      complete = false
      process.stderr.write(`[replication] skipping ${file}: no parseable X-ANAS-Task JSON\n`)
    }
  }
  return { tasks, complete }
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
  // Render BOTH before writing either (cr.51r / review possible 3): the service
  // used to be written before the timer was even rendered, so a timer-render
  // refusal left a half-written pair — a service whose timer no longer matches
  // it (or, on a first create, a service with no timer at all).
  const serviceText = renderServiceUnit(task)
  const timerText = renderTimerUnit(task)
  await writeFile(join(dir, serviceUnitName(task.name)), serviceText, 'utf-8')
  await writeFile(join(dir, timerUnitName(task.name)), timerText, 'utf-8')

  await runSystemctl(executor, ['daemon-reload'])
  const timer = timerUnitName(task.name)
  if (task.enabled)
    await runSystemctl(executor, ['enable', '--now', timer])
  else
    await runSystemctl(executor, ['disable', '--now', timer])
}

/**
 * Remove a task: stop+disable the timer, delete both unit files AND the
 * timer's Persistent stamp, reset the units' failed state, reload systemd.
 * Deliberately touches NOTHING in ZFS — data, snapshots and `anas-repl` holds
 * are left exactly as they are (deleting a schedule is not deleting a backup).
 *
 * The stamp and the failed state are systemd's OWN bookkeeping about the task,
 * and leaving either behind poisons the task's NEXT life: a leftover stamp
 * makes the re-created timer fire immediately (`Persistent=true` reads the
 * stamp as a missed run — SCHEDULES-GT-17), and a removed oneshot that failed
 * stays in the failed state as a `not-found` ghost. Same shape as the task
 * stores' `removeTaskUnits`: the stamp unlinked beside the unit files, and
 * `systemctl reset-failed` issued as TWO calls (service, then timer), each
 * with its exit IGNORED — a reset of nothing must never fail the removal.
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
    unlinkQuiet(replicationStampPath(name)),
  ])
  // Best-effort: not failed / already gone is exactly the goal state.
  await executor.exec(SYSTEMCTL, ['reset-failed', serviceUnitName(name)]).catch(() => undefined)
  await executor.exec(SYSTEMCTL, ['reset-failed', timerUnitName(name)]).catch(() => undefined)
  await runSystemctl(executor, ['daemon-reload'])
}

// --- Status derivation ------------------------------------------------------

/**
 * The full ZFS names a task's source and target resolve to (mirrors the
 *  stage-1 endpoint's target resolution).
 *
 * An EMPTY target dataset is the same instruction as an absent one ("the
 * source's own relative path" — the schema says '' is the default, and the
 * runner and `endpoints()` already drop it). rrep.2 fold D2: this used `??`,
 * so a task stored with `''` was guarded, lag-derived and hold-named against
 * `<pool>/` while its run replicated to `<pool>/<source rel>`.
 */
export function resolveTaskDatasets(task: ReplicationTask): { sourceFull: string, targetFull: string } {
  const sourceFull = task.source.dataset ? `${task.source.pool}/${task.source.dataset}` : task.source.pool
  const targetRel = task.target.dataset || (task.source.dataset || task.source.pool)
  return { sourceFull, targetFull: `${task.target.pool}/${targetRel}` }
}

/**
 * A dataset's snapshots newest-first (by createtxg), `[]` when ZFS says the
 * dataset does not exist, or null when the listing could not be read (cr3
 * REPLICATION-L6 / INVENTED-STATE-M5). Before, every failure was `[]`: a
 * LOCAL target whose listing failed read as "never replicated" and the grid
 * showed every source snapshot behind and "Last replicated —".
 */
async function listSnapshots(executor: CommandExecutor, fullDataset: string): Promise<Snapshot[] | null> {
  const r = await readLocalSnapshots(executor, fullDataset)
  if (!r.ok)
    return null
  return r.exists ? r.snapshots : []
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
  = (task: ReplicationTask, targetFull: string) => Promise<Set<string> | string[] | null>

/**
 * repl.drift: run `zfs <args>` where a NON-local task's target lives (the
 * transport's ssh argv). A resolver answers the names NEWEST FIRST (an
 * array) for the drift read to judge the target; a Set carries no order,
 * and the row then has no `targetDrift`.
 */
export type TargetZfsRunner = (task: ReplicationTask, args: string[]) => Promise<ExecResult>

/**
 * repl.drift: what the task's LAST RUN recorded about its target — the
 * newest runner result line in the unit's journal, taken only when it is the
 * last run's own line (its time within {@link TRIGGER_SLACK_MS} of the run's
 * end), with a state and names the shared schemas accept. Changed (worst)
 * first. Null when the last run recorded nothing.
 */
function recordedDrift(journal: string, lastRunAt: string | null): ReplicationTargetDrift | null {
  const newest = newestHelperResult(journal)
  if (!newest || newest.at === null || lastRunAt === null)
    return null
  if (Math.abs(Date.parse(lastRunAt) - Date.parse(newest.at)) > TRIGGER_SLACK_MS)
    return null
  const list = newest.result.targetDrift
  if (!Array.isArray(list))
    return null
  const valid = list.filter((r): r is { state: 'modified' | 'exposed', dataset: string, base: string } =>
    !!r && typeof r === 'object'
    && ((r as { state?: unknown }).state === 'modified' || (r as { state?: unknown }).state === 'exposed')
    && DatasetPath.safeParse((r as { dataset?: unknown }).dataset).success
    && SnapshotName.safeParse((r as { base?: unknown }).base).success)
  const pick = valid.find(r => r.state === 'modified') ?? valid[0]
  return pick ? { state: pick.state, dataset: pick.dataset, base: pick.base, asOf: newest.at } : null
}

/** A task's lag and target state, read from ZFS (no systemd). */
export interface TaskTargetRead {
  lastReplicatedSnapshot: string | null
  lastReplicatedAt: string | null
  snapshotsBehind: number | null
  targetDrift?: ReplicationTargetDrift
  /**
   * repl.drift review P4: re-reads the target's snapshot listing the verdict
   * was judged against and answers whether it is UNCHANGED — false when it
   * changed (a receive landed between the listing and the `written@` read)
   * or could not be read. Set whenever `targetDrift` was read; the daily
   * check alerts only on a `modified` verdict this confirms. Nothing is kept:
   * the first listing lives only in this closure for the one check.
   */
  confirmUnchanged?: () => Promise<boolean>
}

/** A tree's per-dataset snapshot names as one comparable value. */
function treeSnapshotsKey(snaps: Map<string, string[]>): string {
  return JSON.stringify([...snaps])
}

/**
 * The ZFS half of a task's status (repl.drift: shared by the status read and
 * the daily drift check): the lag from the source and target listings, and
 * the target's state against the snapshot its next incremental starts from.
 * A peer/remote target is read only through the readers given (none: the lag
 * and the drift stay unknown/absent, and nothing is opened).
 */
export async function readTaskTarget(
  executor: CommandExecutor,
  task: ReplicationTask,
  remoteTargetNames?: TargetNamesResolver,
  remoteTargetZfs?: TargetZfsRunner,
): Promise<TaskTargetRead> {
  const { sourceFull, targetFull } = resolveTaskDatasets(task)
  // newest-first. ⚠ Transient backup snapshots (`anas-backup-<task>-<ts>`) are
  // dropped here as well as in the base discovery (backup2.3): they are never
  // replicated by design, so counting them would report a healthy task as N
  // behind for as long as a backup run is in flight — and the count would then
  // silently fix itself when the run's `finally` destroyed them.
  // A source listing that could not be read leaves all three unknown (null),
  // exactly as a source with no snapshots does: no lag is derived from it.
  const allSourceSnaps = (await listSnapshots(executor, sourceFull)) ?? []
  const sourceSnaps = allSourceSnaps.filter(s => !isTransientRunSnapshot(s.snapshotName))
  let lastReplicatedSnapshot: string | null = null
  let lastReplicatedAt: string | null = null
  let snapshotsBehind: number | null = null
  let targetDrift: ReplicationTargetDrift | undefined
  let confirmUnchanged: (() => Promise<boolean>) | undefined

  if (sourceSnaps.length > 0) {
    // Local target → list locally. Non-local target → the injected resolver
    // reads the REMOTE's snapshots over SSH (stage 3); without a resolver the
    // remote is unreadable here, so the lag honestly stays unknown (nulls).
    const isLocalTarget = !task.target.location || task.target.location.kind === 'local'
    let targetNames: Set<string> | null
    /** The same names newest first, when the read gave an order (repl.drift). */
    let targetOrder: string[] | null = null
    if (isLocalTarget) {
      // cr3: a target listing that could not be read is UNKNOWN (null), never
      // "nothing replicated"; a target ZFS says does not exist is the truth
      // "nothing replicated yet" (an empty set).
      const listed = await listSnapshots(executor, targetFull)
      targetOrder = listed === null ? null : listed.map(s => s.snapshotName)
      targetNames = targetOrder === null ? null : new Set(targetOrder)
    }
    else if (remoteTargetNames) {
      const read = await remoteTargetNames(task, targetFull)
      targetOrder = Array.isArray(read) ? read : null
      targetNames = read === null ? null : new Set(read)
    }
    else {
      targetNames = null
    }

    // repl.drift: the snapshot the next incremental starts from, and whether
    // the target still matches it (`written@<base>`) and is read-only — ONE
    // read where the target lives. A READ only: nothing here notifies (the
    // alert comes from runs and the daily check). A recursive task's LAG is
    // its root's; its target state is the worst of its copies' (P1, below).
    const base = targetOrder === null ? undefined : nextIncrementalBase(allSourceSnaps.map(s => s.snapshotName), targetOrder)
    if (base !== undefined && targetOrder !== null) {
      const runTarget = isLocalTarget
        ? (args: string[]) => executor.exec(ZFS, args)
        : remoteTargetZfs ? (args: string[]) => remoteTargetZfs(task, args) : null
      const where = isLocalTarget ? '' : ` on ${task.target.location!.kind} '${task.target.location!.name ?? ''}'`
      if (runTarget === null) {
        targetDrift = { state: 'unknown', dataset: targetFull, base, message: `Could not check whether target '${targetFull}'${where} was changed since '@${base}': the target is not reachable from this read` }
      }
      else {
        const tag = replicationHoldTag(task.target.location, targetFull)
        const runSource = (args: string[]) => executor.exec(ZFS, args)
        const readHeld = (sourceDs: string, targetDs: string, at: string) => () => readBaseHeld(runSource, runTarget, `${sourceDs}@${at}`, `${targetDs}@${at}`, tag)
        // repl.drift P1: a RECURSIVE task's target is every copy its run
        // receives into or finds up to date — judged by the run's own
        // per-copy judgement over the run's own tree read, so a changed
        // child shows here and alerts at the daily check. Review 2, defect 1
        // (a read that could not see never says clean): a tree that cannot
        // be read or planned leaves the copies UNCHECKED — the task's state
        // is `unknown` with what could not be read, unless the root's own
        // read below finds the root itself `modified`.
        let treeUnchecked: TreeUnchecked | undefined
        if (task.recursive === true) {
          const tree = await readTreeFactsWith({ source: runSource, target: runTarget }, { sourceRoot: sourceFull, targetRoot: targetFull, exclude: task.exclude ?? [], localTarget: isLocalTarget })
          if (!tree.ok) {
            treeUnchecked = { read: readFailureReason(tree.message) }
          }
          else {
            const copies = await judgeTreeTargets({ runTarget, where, readHeld: (ds, tgt, at) => readHeld(ds, tgt, at)() }, tree.facts)
            if (copies.ok)
              targetDrift = worstTargetDrift(copies.drifts)
            else
              treeUnchecked = { refusals: copies.refusals }
          }
          if (tree.ok && targetDrift !== undefined) {
            const first = treeSnapshotsKey(tree.facts.targetSnaps)
            confirmUnchanged = async () => {
              try {
                const again = await runTarget(zfsTreeSnapshotsArgs(targetFull))
                return again.exitCode === 0 && treeSnapshotsKey(parseTreeSnapshots(again.stdout)) === first
              }
              catch {
                return false
              }
            }
          }
        }
        if (targetDrift === undefined) {
          const root = await checkTargetDrift(runTarget, {
            target: targetFull,
            where,
            base,
            targetSnaps: targetOrder,
            readHeld: readHeld(sourceFull, targetFull, base),
          })
          if (treeUnchecked === undefined)
            targetDrift = root
          else if (root.state === 'modified')
            targetDrift = { ...root, message: `${root.message} ${treeUncheckedClause({ target: targetFull, why: treeUnchecked })}` }
          else
            targetDrift = { state: 'unknown', dataset: targetFull, base, message: treeUncheckedSentence({ target: targetFull, where, why: treeUnchecked }) }
          const first = targetOrder.join('\n')
          confirmUnchanged = async () => {
            try {
              const again = isLocalTarget
                ? (await listSnapshots(executor, targetFull))?.map(s => s.snapshotName) ?? null
                : await remoteTargetNames!(task, targetFull)
              return Array.isArray(again) && again.join('\n') === first
            }
            catch {
              return false
            }
          }
        }
      }
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

  return { lastReplicatedSnapshot, lastReplicatedAt, snapshotsBehind, ...(targetDrift ? { targetDrift } : {}), ...(confirmUnchanged ? { confirmUnchanged } : {}) }
}

export async function deriveTaskStatus(
  executor: CommandExecutor,
  task: ReplicationTask,
  remoteTargetNames?: TargetNamesResolver,
  remoteTargetZfs?: TargetZfsRunner,
  opts: {
    /**
     * repl.drift, the dashboard: a peer or remote target is never read here
     * (no ssh); its drift is what the task's last run recorded, as of then.
     */
    remoteDriftFromLastRun?: boolean
  } = {},
): Promise<ReplicationTaskStatus> {
  const read = await readTaskTarget(executor, task, remoteTargetNames, remoteTargetZfs)
  const { lastReplicatedSnapshot, lastReplicatedAt, snapshotsBehind } = read
  let targetDrift = read.targetDrift

  // taskstatus.1: the shared run-status derivation (unit-run-status.ts) —
  // live service props, else the runner's journal result line, else the
  // timer's last trigger. Replication's row carries the verdict and the next
  // run; its "when" is the ZFS-derived lastReplicatedAt above, not the unit's.
  const isRemote = !!task.target.location && task.target.location.kind !== 'local'
  const fromLastRun = opts.remoteDriftFromLastRun === true && isRemote
  const readJournal = readOnce(() => readUnitJournal(executor, serviceUnitName(task.name)))
  const run = await deriveUnitRunStatus(executor, {
    serviceUnit: serviceUnitName(task.name),
    timerUnit: timerUnitName(task.name),
    enabled: task.enabled,
    ...(fromLastRun ? { readJournal } : {}),
  })
  if (fromLastRun && targetDrift === undefined) {
    const recorded = recordedDrift(await readJournal(), run.lastRunAt)
    if (recorded)
      targetDrift = recorded
  }

  return {
    task,
    lastReplicatedSnapshot,
    lastReplicatedAt,
    snapshotsBehind,
    lastRunResult: toSystemdRunResult(run.lastRunResult),
    nextRunAt: run.nextRunAt,
    ...(run.lastRunNote ? { lastRunNote: run.lastRunNote } : {}),
    // cr3.followup: a `systemctl show` that could not answer is a failed
    // read, never the `unknown` result it derives to.
    ...(showReadFailed(run.serviceProps) ? { statusUnreadable: true as const } : {}),
    ...(targetDrift ? { targetDrift } : {}),
  }
}

/**
 * How a status read reaches a NON-local task's target (the task list route
 * and the dashboard collector share it): the snapshot names over ssh, NEWEST
 * FIRST (`readRemoteSnapshotNames`: a failed listing is null — unknown, never
 * "nothing replicated"; a target ZFS says does not exist is `[]`), and
 * `zfs <args>` there for the drift read (repl.drift). A location that does
 * not resolve answers null / a failed read.
 */
export function remoteTargetReaders(transport: Transport): { names: TargetNamesResolver, zfs: TargetZfsRunner } {
  const names: TargetNamesResolver = async (task, targetFull) => {
    try {
      const res = await transport.resolveLocation(task.target.location!)
      if (!res.ok)
        return null
      const read = await readRemoteSnapshotNames(cmd => transport.sshExec(res.resolved, cmd), targetFull)
      if (!read.ok)
        return null
      return read.exists ? read.snapshots : []
    }
    catch {
      return null
    }
  }
  const zfs: TargetZfsRunner = async (task, args) => {
    const res = await transport.resolveLocation(task.target.location!)
    if (!res.ok)
      return { stdout: '', stderr: res.error, exitCode: 1 }
    return transport.sshExec(res.resolved, ['zfs', ...args])
  }
  return { names, zfs }
}

/** Derive statuses for every task in the store (fail-open per task). */
export async function collectTaskStatuses(
  executor: CommandExecutor,
  dir: string,
  remoteTargetNames?: TargetNamesResolver,
  remoteTargetZfs?: TargetZfsRunner,
): Promise<ReplicationTaskStatus[]> {
  const tasks = await readAllTasks(dir)
  return Promise.all(tasks.map(t => deriveTaskStatus(executor, t, remoteTargetNames, remoteTargetZfs)))
}

/**
 * Dashboard warnings for failed replication tasks (category 'replication'). One
 * per task whose last run failed; the ref is the task name so the UI can
 * deep-link into the Replication view.
 */
export function buildReplicationWarnings(statuses: ReplicationTaskStatus[]): DashboardWarning[] {
  const out: DashboardWarning[] = []
  for (const s of statuses) {
    const drift = s.targetDrift
    // repl.drift: a target changed since its base is said by name, and one
    // that is not read-only gets its own card while its runs still succeed.
    // A state a run recorded (a peer or remote target, which the dashboard
    // never reads) names that run's time (review N5: the record is taken from
    // the newest result line near the last run's end, which two runs a few
    // seconds apart can blur, so the card names the time, never "the last
    // run").
    const runAt = drift?.asOf ? `its run at ${drift.asOf.slice(0, 16).replace('T', ' ')} UTC found ` : ''
    if (drift?.state === 'modified') {
      out.push({
        level: 'warning',
        category: 'replication',
        message: runAt
          ? `Replication task '${s.task.name}': ${runAt}its target '${drift.dataset}' changed since '@${drift.base}'; replication into it stops until those changes are discarded — check the Replication view`
          : `Replication task '${s.task.name}': its target '${drift.dataset}' has been changed since '@${drift.base}'; replication into it stops until those changes are discarded — check the Replication view`,
        ref: s.task.name,
      })
    }
    // Review N5: the failed-run card is left out only when the failed run's
    // own record says it was refused for the changed target (a recorded
    // `modified`); a target read live says nothing about why the last run
    // failed, so both cards stand.
    const failedOnTheChange = drift?.state === 'modified' && drift.asOf !== undefined
    if (s.lastRunResult === 'failure' && !failedOnTheChange) {
      out.push({
        level: 'warning',
        category: 'replication',
        message: `Replication task '${s.task.name}' last run failed — check the Replication view`,
        ref: s.task.name,
      })
    }
    if (drift?.state === 'exposed') {
      out.push({
        level: 'warning',
        category: 'replication',
        message: runAt
          ? `Replication task '${s.task.name}': ${runAt}its target '${drift.dataset}' not read-only, and ${writeOrAtimeRead('stops the next send')} — check the Replication view`
          : `Replication task '${s.task.name}': its target '${drift.dataset}' is not read-only, and ${writeOrAtimeRead('stops the next send')} — check the Replication view`,
        ref: s.task.name,
      })
    }
  }
  return out
}

/** repl.drift: the rows whose target state could not be read (the dashboard reports them incomplete). */
export function driftUnreadTasks(statuses: ReplicationTaskStatus[]): string[] {
  return statuses.filter(s => s.targetDrift?.state === 'unknown').map(s => s.task.name)
}
