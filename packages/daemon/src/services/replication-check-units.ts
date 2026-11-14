import type { CommandExecutor } from '../executor/types.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readAllTasksChecked } from './replication-units.js'
import { readUnitFile, runSystemctl, systemdTimersStampDir, unlinkQuiet } from './systemd-unit-store.js'

/**
 * repl.drift, ruling 3 (operator 2026-11-15): the node-wide DAILY check of
 * replication targets — ONE `anas-replcheck.service` + `anas-replcheck.timer`
 * pair per node (the periodic scrub's shape, `anas-scrub.*`), firing
 * `node dist/repl-drift-check.js`, which alerts only for a target changed
 * since its base (`modified`) on a task whose own run is older than 24 hours.
 *
 * The pair exists only while at least one replication task exists on the
 * node: {@link syncDriftCheckUnits} installs it with the first task and
 * removes it with the last (called by the task create, update and delete
 * jobs, and once at daemon start for a node that already had tasks). The
 * name is OUTSIDE the task store's `anas-repl-` prefix, so the task store
 * never reads these units as a task, and a task can never be named onto them.
 * Both files carry the `X-ANAS-Unit=` marker; a file of that name without it
 * is someone else's and is never overwritten or removed.
 */

export const DRIFT_CHECK_SERVICE = 'anas-replcheck.service'
export const DRIFT_CHECK_TIMER = 'anas-replcheck.timer'
const MARKER_LINE = '# X-ANAS-Unit=replication-drift-check'
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/repl-drift-check.js'
const SYSTEMCTL = '/usr/bin/systemctl'

export function renderDriftCheckService(): string {
  return [
    '[Unit]',
    'Description=ANAS daily replication target check',
    MARKER_LINE,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${RUNNER_NODE} ${RUNNER_SCRIPT}`,
    '',
  ].join('\n')
}

export function renderDriftCheckTimer(): string {
  return [
    '[Unit]',
    'Description=ANAS daily replication target check timer',
    MARKER_LINE,
    '',
    '[Timer]',
    'OnCalendar=daily',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/** The timer's Persistent stamp, removed with the units (the scrub pair's rule). */
export function driftCheckStampPath(): string {
  return `${systemdTimersStampDir()}/stamp-${DRIFT_CHECK_TIMER}`
}

/**
 * Bring the pair in line with the task store: present while a task exists,
 * absent when none does. `unchanged` when nothing had to change, or when the
 * store could not be read in full and listed no task (it cannot be told from
 * "no task", so nothing is removed on that read); `foreign` when a file of
 * that name lacks the marker (left alone).
 */
export type DriftCheckSync = 'installed' | 'removed' | 'unchanged' | 'foreign'

/**
 * Review P6: the syncs of this process run ONE AT A TIME. A task delete's
 * sync that read "no task" and a task create's sync overlapping it otherwise
 * raced: the create's sync saw the units still present (unchanged) and the
 * delete's then removed them, leaving a task and no daily check. Queued, the
 * later sync reads the store after the earlier one has finished acting.
 * A failed sync does not block the next one.
 */
let syncQueue: Promise<unknown> = Promise.resolve()

export function syncDriftCheckUnits(executor: CommandExecutor, dir: string): Promise<DriftCheckSync> {
  const run = syncQueue.then(() => syncDriftCheckUnitsNow(executor, dir))
  syncQueue = run.catch(() => undefined)
  return run
}

async function syncDriftCheckUnitsNow(executor: CommandExecutor, dir: string): Promise<DriftCheckSync> {
  const { tasks, complete } = await readAllTasksChecked(dir)
  const service = await readUnitFile(dir, DRIFT_CHECK_SERVICE)
  const timer = await readUnitFile(dir, DRIFT_CHECK_TIMER)
  if ((service !== null && !service.includes(MARKER_LINE)) || (timer !== null && !timer.includes(MARKER_LINE)))
    return 'foreign'
  if (tasks.length > 0) {
    if (service === renderDriftCheckService() && timer === renderDriftCheckTimer())
      return 'unchanged'
    await writeFile(join(dir, DRIFT_CHECK_SERVICE), renderDriftCheckService(), 'utf-8')
    await writeFile(join(dir, DRIFT_CHECK_TIMER), renderDriftCheckTimer(), 'utf-8')
    await runSystemctl(executor, ['daemon-reload'])
    await runSystemctl(executor, ['enable', '--now', DRIFT_CHECK_TIMER])
    return 'installed'
  }
  if (!complete || (service === null && timer === null))
    return 'unchanged'
  // Best-effort disable first (the unit may already be gone).
  await executor.exec(SYSTEMCTL, ['disable', '--now', DRIFT_CHECK_TIMER]).catch(() => undefined)
  await Promise.all([
    unlinkQuiet(join(dir, DRIFT_CHECK_SERVICE)),
    unlinkQuiet(join(dir, DRIFT_CHECK_TIMER)),
    unlinkQuiet(driftCheckStampPath()),
  ])
  await executor.exec(SYSTEMCTL, ['reset-failed', DRIFT_CHECK_SERVICE]).catch(() => undefined)
  await executor.exec(SYSTEMCTL, ['reset-failed', DRIFT_CHECK_TIMER]).catch(() => undefined)
  await runSystemctl(executor, ['daemon-reload'])
  return 'removed'
}
