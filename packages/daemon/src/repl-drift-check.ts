import type { ReplicationTask } from '@anas/shared'
import type { CommandExecutor } from './executor/types.js'
import type { ReplicationNotifyContext } from './services/replication-notify.js'
import type { TargetNamesResolver, TargetZfsRunner } from './services/replication-units.js'
import { CommandBudgetExecutor } from './executor/command-budgets.js'
import { ProdExecutor } from './executor/prod.js'
import { notifyReplicationRun } from './services/replication-notify.js'
import { defaultRemotesPaths } from './services/replication-remotes.js'
import { createTransport, defaultMembersFile } from './services/replication-transport.js'
import { DEFAULT_SYSTEMD_DIR, readAllTasksChecked, readTaskTarget, remoteTargetReaders, resolveTaskDatasets, serviceUnitName, timerUnitName } from './services/replication-units.js'
import { deriveUnitRunStatus } from './services/unit-run-status.js'

/**
 * repl.drift, ruling 3 — the DAILY replication target check, fired by the
 * node-wide `anas-replcheck.timer` (services/replication-check-units.ts) as
 * `node dist/repl-drift-check.js`.
 *
 * Like recycle-purge.ts, this runner is not a client of the daemon: it is a
 * READ of ZFS and systemd plus PVE's notification, through the daemon's own
 * helpers, so no route is needed. For every ENABLED task on this node whose
 * last run (the same systemd last-run record the status uses) ended more than
 * 24 hours ago, or never, it asks the one drift read (`readTaskTarget`); when
 * the target is `modified` — replication into it has stopped — and a second
 * read of the target's snapshot listing confirms the verdict (review P4: the
 * listing it was judged against is unchanged), it sends ONE notification
 * with the drift sentence at error severity, titled as the daily check's
 * own verdict (no replication ran, so never "FAILED"). `exposed` and
 * `unknown` are silent here (the task list shows them, and the task's next
 * run says so). A task that ran within 24 hours is skipped without a read: its
 * own run was the check and already alerted, so no alert is doubled. Nothing
 * is sent, held, released or set; nothing is remembered.
 */

const DAY_MS = 86_400_000

export interface DriftCheckDeps {
  executor: CommandExecutor
  systemdDir: string
  now: () => number
  notify: (ctx: ReplicationNotifyContext) => Promise<void>
  /** How a peer/remote target is read (the task list's ssh readers); absent, such a target is unknown. */
  readers?: { names: TargetNamesResolver, zfs: TargetZfsRunner }
  log?: (line: string) => void
}

export interface DriftCheckReport {
  /** Store read in full. */
  complete: boolean
  skipped: string[]
  checked: string[]
  alerted: string[]
}

function isRemote(task: ReplicationTask): boolean {
  return !!task.target.location && task.target.location.kind !== 'local'
}

export async function runDriftCheck(deps: DriftCheckDeps): Promise<DriftCheckReport> {
  const log = deps.log ?? (() => {})
  const { tasks, complete } = await readAllTasksChecked(deps.systemdDir)
  const report: DriftCheckReport = { complete, skipped: [], checked: [], alerted: [] }
  for (const task of tasks) {
    if (!task.enabled || task.invalid)
      continue
    try {
      const run = await deriveUnitRunStatus(deps.executor, {
        serviceUnit: serviceUnitName(task.name),
        timerUnit: timerUnitName(task.name),
        enabled: task.enabled,
      })
      const last = run.lastRunAt === null ? Number.NaN : Date.parse(run.lastRunAt)
      // Review N10: a last run AFTER now (a clock that moved back, a stamp
      // from the future) is no evidence of a run within 24 hours.
      const now = deps.now()
      const ranWithinDay = Number.isFinite(last) && last <= now && now - last < DAY_MS
      if (run.runActive || ranWithinDay) {
        report.skipped.push(task.name)
        log(`task=${task.name} skipped: ${run.runActive ? 'running now' : 'ran within 24 hours'}`)
        continue
      }
      report.checked.push(task.name)
      const read = await readTaskTarget(deps.executor, task, isRemote(task) ? deps.readers?.names : undefined, isRemote(task) ? deps.readers?.zfs : undefined)
      const drift = read.targetDrift
      log(`task=${task.name} target=${drift?.state ?? 'not judged'}`)
      if (drift?.state !== 'modified')
        continue
      // Review P4: never alert on a verdict that cannot be confirmed. A
      // receive in flight (an ad-hoc Replicate is no unit, so `runActive`
      // does not see it) that lands between the target listing and the
      // `written@` read makes an untouched target read `modified`: the
      // listing is read again, and a verdict whose listing changed, or could
      // not be read again, is dropped silently (tomorrow's check asks anew).
      if (!read.confirmUnchanged || !(await read.confirmUnchanged())) {
        log(`task=${task.name} target=modified not confirmed: its snapshot listing changed or could not be read again; no alert`)
        continue
      }
      const { sourceFull, targetFull } = resolveTaskDatasets(task)
      await deps.notify({
        source: sourceFull,
        target: targetFull,
        ...(isRemote(task) && task.target.location ? { location: task.target.location } : {}),
        notify: task.notify,
        dailyCheck: true,
        error: `The daily check of replication task '${task.name}' found its target changed; no replication ran: ${drift.message}`,
      })
      report.alerted.push(task.name)
    }
    catch (err) {
      // One task's failed read (a remote that is down) is that task's
      // unknown — silent here — never the end of the check.
      if (!report.checked.includes(task.name))
        report.checked.push(task.name)
      log(`task=${task.name} could not be checked: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return report
}

/** CLI entrypoint: exits 0 whenever the task store was read, 1 when it could not be read at all. */
export async function main(): Promise<number> {
  const executor = new CommandBudgetExecutor(new ProdExecutor())
  const transport = createTransport(executor, { paths: defaultRemotesPaths(), membersFile: defaultMembersFile() })
  const report = await runDriftCheck({
    executor,
    systemdDir: DEFAULT_SYSTEMD_DIR,
    now: () => Date.now(),
    notify: ctx => notifyReplicationRun(executor, ctx),
    readers: remoteTargetReaders(transport),
    log: line => process.stdout.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify({ check: 'replication-drift', ...report })}\n`)
  return report.complete || report.checked.length + report.skipped.length > 0 ? 0 : 1
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code), (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
