import type { TaskCadence } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { TaskStatusSubject, TaskUnitKind } from '../task-units.js'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BACKUP_SKIP_EXIT_CODE } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { BACKUP_UNIT_KIND } from '../backup-units.js'
import { CLOUD_UNIT_KIND } from '../cloud-units.js'
import {
  buildTaskWarnings,
  classifyTrigger,
  collectTaskWarnings,
  deriveTaskRunResult,
  deriveTaskStatus,
  deriveTriggerSource,
  effectiveSchedule,
  failureDetailFromJournal,
  gateRun,
  isRunActive,
  messageFromJournalLine,
  parseHelperResult,
  readLastSuccessAt,
  readRecentJournal,
  readUnitTexts,
  removeTaskUnits,
  runFailed,
  serviceUnitName,
  superviseTaskRun,
  taskFileExists,
  timerUnitName,
  validateSchedule,
} from '../task-units.js'

/**
 * The extracted task-unit generics, exercised under a SECOND descriptor
 * (rclone.2 slice 1). backup-units.test.ts already proves every one of these
 * behaviours through the backup wrappers, unchanged; this file proves the
 * parameterisation is REAL — that the same code, handed `anas-cloud-` and
 * category `cloud`, derives the same answers off the cloud unit names and
 * nothing of backup's leaks in (the last describe compares the two descriptors
 * over identical inputs).
 *
 * The second descriptor is the cloud store's OWN (`cloud-units.ts`, rclone.2
 * slice 2) — it moved there when that store landed, so this file proves the
 * parameterisation against the descriptor production actually uses, not a copy
 * of it.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const JOURNALCTL = '/usr/bin/journalctl'
const TASK = 'offsite'
const SERVICE = 'anas-cloud-offsite.service'
const TIMER = 'anas-cloud-offsite.timer'
const SHOW_STATUS_PROPS = 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'
const SHOW_RUN_PROPS = 'ActiveState,Result,ExecMainStatus,InvocationID'

const DAY_MS = 24 * 60 * 60 * 1000
const BIWEEKLY: TaskCadence = { kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'even' }

function task(over: Partial<TaskStatusSubject> = {}): TaskStatusSubject {
  return { name: TASK, enabled: true, schedule: '*-*-* 02:00:00', ...over }
}

/** A `systemctl show` blob from key=value pairs. */
function showBlob(props: Record<string, string>): string {
  return `${Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

/** `systemctl show` fixtures for the status derivation (service + timer). */
function statusMock(opts: {
  kind?: TaskUnitKind
  active?: string
  result?: string
  execStatus?: string
  exitTs?: string
  nextTs?: string
  journal?: string
}): MockExecutor {
  const kind = opts.kind ?? CLOUD_UNIT_KIND
  const mock = new MockExecutor()
  mock.addFixture({
    command: SYSTEMCTL,
    args: ['show', serviceUnitName(kind, TASK), '-p', SHOW_STATUS_PROPS],
    result: ok(showBlob({
      ActiveState: opts.active ?? 'inactive',
      Result: opts.result ?? 'success',
      ExecMainStatus: opts.execStatus ?? '0',
      ExecMainExitTimestamp: opts.exitTs ?? '',
      InactiveEnterTimestamp: '',
    })),
  })
  mock.addFixture({
    command: SYSTEMCTL,
    args: ['show', timerUnitName(kind, TASK), '-p', 'NextElapseUSecRealtime'],
    result: ok(`NextElapseUSecRealtime=${opts.nextTs ?? '0'}\n`),
  })
  if (opts.journal !== undefined) {
    mock.addFixture({
      command: JOURNALCTL,
      args: ['-u', serviceUnitName(kind, TASK), '-n', '200', '-o', 'short-iso', '--no-pager'],
      result: ok(opts.journal),
    })
  }
  return mock
}

/** A mock whose journalctl returns `journal` for the task's unit. */
function journalMock(journal: string, kind: TaskUnitKind = CLOUD_UNIT_KIND): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({
    command: JOURNALCTL,
    args: ['-u', serviceUnitName(kind, TASK), '-n', '200', '-o', 'short-iso', '--no-pager'],
    result: ok(journal),
  })
  return mock
}

/** The trigger props the biweekly gate reads, both stamped at `stamp`. */
function triggerFixtures(mock: MockExecutor, stamp: string, kind: TaskUnitKind = CLOUD_UNIT_KIND): MockExecutor {
  mock.addFixture({
    command: SYSTEMCTL,
    args: ['show', timerUnitName(kind, TASK), '-p', 'LastTriggerUSec'],
    result: ok(`LastTriggerUSec=${stamp}\n`),
  })
  mock.addFixture({
    command: SYSTEMCTL,
    args: ['show', serviceUnitName(kind, TASK), '-p', 'InactiveExitTimestamp'],
    result: ok(`InactiveExitTimestamp=${stamp}\n`),
  })
  return mock
}

/** A journal blob whose newest runner result is a real success at `at`. */
function successJournal(at: string, after: string[] = [], kind: TaskUnitKind = CLOUD_UNIT_KIND): string {
  return [
    `${at} anas-pve ${kind.prefix}${TASK}[900]: {"task":"${TASK}","result":{"status":"success","bytes":4096,"files":3}}`,
    ...after,
  ].join('\n')
}

/**
 * A mock scripting a Run-Now: `systemctl show` walks `shows` (the last repeats),
 * `systemctl start` answers with `startExit`/`startStderr`, journalctl returns
 * `journal`. Everything the supervisor reads, nothing it does not.
 */
function superviseMock(opts: {
  shows: Record<string, string>[]
  journal?: string
  startExit?: number
  startStderr?: string
}): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({
    command: SYSTEMCTL,
    args: ['show', SERVICE, '-p', SHOW_RUN_PROPS],
    results: opts.shows.map(s => ok(showBlob(s))),
  })
  mock.addFixture({
    command: SYSTEMCTL,
    args: ['start', '--no-block', SERVICE],
    result: { stdout: '', stderr: opts.startStderr ?? '', exitCode: opts.startExit ?? 0 },
  })
  mock.addFixture({
    command: JOURNALCTL,
    args: ['-u', SERVICE, '-n', '200', '-o', 'short-iso', '--no-pager'],
    result: ok(opts.journal ?? ''),
  })
  return mock
}

async function noopSleep(): Promise<void> {}
const FAST = { pollIntervalMs: 0, timeoutMs: 60000, sleep: noopSleep }

const OK_JOURNAL = [
  '2026-09-20T02:00:00+0000 anas-pve systemd[1]: Starting ANAS cloud sync task offsite...',
  `2026-09-20T02:00:07+0000 anas-pve anas-cloud-offsite[999]: {"task":"offsite","result":{"status":"success","bytes":4096,"files":3,"checks":12,"deletes":0}}`,
  '2026-09-20T02:00:07+0000 anas-pve systemd[1]: anas-cloud-offsite.service: Deactivated successfully.',
].join('\n')

const SKIPPED_JOURNAL = [
  '2026-09-20T02:00:01+0000 anas-pve anas-cloud-offsite[1001]: {"task":"offsite","result":{"status":"skipped-off-week","reason":"ISO week 39 is odd, this task runs even weeks"}}',
  '2026-09-20T02:00:01+0000 anas-pve systemd[1]: anas-cloud-offsite.service: Deactivated successfully.',
].join('\n')

const FAILED_JOURNAL = [
  '2026-09-20T02:00:03+0000 anas-pve anas-cloud-offsite[1010]: Error: Failed to create file system for "offsite:backups": couldn\'t connect SSH: dial tcp 192.0.2.1:22: i/o timeout',
  '2026-09-20T02:00:03+0000 anas-pve systemd[1]: anas-cloud-offsite.service: Main process exited, code=exited, status=1/FAILURE',
  '2026-09-20T02:00:03+0000 anas-pve systemd[1]: anas-cloud-offsite.service: Failed with result \'exit-code\'.',
].join('\n')

describe('task units — unit names come from the descriptor', () => {
  it('the cloud prefix names both units', () => {
    assert.equal(serviceUnitName(CLOUD_UNIT_KIND, TASK), SERVICE)
    assert.equal(timerUnitName(CLOUD_UNIT_KIND, TASK), TIMER)
  })

  it('backup keeps its own names off the same code', () => {
    assert.equal(serviceUnitName(BACKUP_UNIT_KIND, TASK), 'anas-backup-offsite.service')
    assert.equal(timerUnitName(BACKUP_UNIT_KIND, TASK), 'anas-backup-offsite.timer')
  })
})

describe('task units — status derivation under the cloud prefix', () => {
  const futureUsec = String((Date.now() + 3_600_000) * 1000)
  const pastUsec = String((Date.now() - 3_600_000) * 1000)

  it('deriveTaskRunResult maps systemd state to a result', () => {
    assert.equal(deriveTaskRunResult({ ActiveState: 'activating', Result: '' }), 'running')
    assert.equal(deriveTaskRunResult({ ActiveState: 'failed', Result: 'exit-code' }), 'failure')
    assert.equal(deriveTaskRunResult({ ActiveState: 'inactive', Result: 'success' }), 'success')
    assert.equal(deriveTaskRunResult({ ActiveState: 'inactive', Result: 'exit-code' }), 'failure')
    assert.equal(deriveTaskRunResult({}), 'unknown')
  })

  it('the deliberate-skip exit code reads as `skipped`, not success or failure', () => {
    const skipped = { ActiveState: 'inactive', Result: 'success', ExecMainStatus: String(BACKUP_SKIP_EXIT_CODE) }
    assert.equal(deriveTaskRunResult(skipped), 'skipped')
    assert.equal(runFailed(skipped), false)
  })

  it('ENABLED with a future next run reads success and is not overdue', async () => {
    const st = await deriveTaskStatus(
      CLOUD_UNIT_KIND,
      statusMock({ exitTs: 'Sun 2026-09-20 02:00:07 UTC', nextTs: futureUsec }),
      task(),
    )
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.lastRunAt, '2026-09-20T02:00:07.000Z')
    assert.equal(st.overdue, false)
    assert.notEqual(st.nextRunAt, null)
  })

  it('ENABLED with a next elapse in the PAST is overdue (the timer never caught up)', async () => {
    const st = await deriveTaskStatus(
      CLOUD_UNIT_KIND,
      statusMock({ exitTs: 'Sun 2026-09-20 02:00:07 UTC', nextTs: pastUsec }),
      task({ enabled: true }),
    )
    assert.equal(st.overdue, true)
  })

  it('DISABLED reports `disabled` with no run to date, and is never overdue (F9)', async () => {
    const st = await deriveTaskStatus(
      CLOUD_UNIT_KIND,
      statusMock({ nextTs: pastUsec }),
      task({ enabled: false }),
    )
    assert.equal(st.lastRunResult, 'disabled')
    assert.equal(st.lastRunAt, null)
    assert.equal(st.overdue, false)
  })

  it('ENABLED with no retained history reads `never-run`, never a fabricated success', async () => {
    const st = await deriveTaskStatus(CLOUD_UNIT_KIND, statusMock({ nextTs: futureUsec }), task())
    assert.equal(st.lastRunResult, 'never-run')
  })

  it('a FAILED unit reads failure', async () => {
    const st = await deriveTaskStatus(
      CLOUD_UNIT_KIND,
      statusMock({ active: 'failed', result: 'exit-code', execStatus: '1', exitTs: 'Sun 2026-09-20 02:00:03 UTC' }),
      task(),
    )
    assert.equal(st.lastRunResult, 'failure')
  })

  it('a SKIPPED run keeps the cadence honest: 8 days is fine, 15 is overdue', async () => {
    const now = Date.UTC(2026, 8, 22, 2, 0, 0)
    const futureTs = String((now + DAY_MS) * 1000)
    const stamp = (ms: number): string => new Date(ms).toISOString().replace('.000Z', '+0000')
    const skipped = {
      execStatus: String(BACKUP_SKIP_EXIT_CODE),
      exitTs: 'Tue 2026-09-22 02:00:01 UTC',
      nextTs: futureTs,
    }

    const recent = await deriveTaskStatus(
      CLOUD_UNIT_KIND,
      statusMock({ ...skipped, journal: successJournal(stamp(now - 8 * DAY_MS)) }),
      task({ cadence: BIWEEKLY }),
      now,
    )
    assert.equal(recent.lastRunResult, 'skipped')
    assert.equal(recent.lastSuccessAt, new Date(now - 8 * DAY_MS).toISOString())
    assert.equal(recent.overdue, false)

    const stale = await deriveTaskStatus(
      CLOUD_UNIT_KIND,
      statusMock({ ...skipped, journal: successJournal(stamp(now - 15 * DAY_MS)) }),
      task({ cadence: BIWEEKLY }),
      now,
    )
    assert.equal(stale.overdue, true)
  })

  it('a raw-schedule task never pays for the journal read (no period to measure)', async () => {
    const mock = statusMock({ execStatus: String(BACKUP_SKIP_EXIT_CODE), journal: '' })
    const st = await deriveTaskStatus(CLOUD_UNIT_KIND, mock, task(), Date.now())
    assert.equal(st.lastSuccessAt, null)
    assert.equal(mock.calls.some(c => c.command === JOURNALCTL), false)
  })

  it('every source fails OPEN: an executor with no fixtures blanks nothing', async () => {
    const st = await deriveTaskStatus(CLOUD_UNIT_KIND, new MockExecutor(), task())
    assert.equal(st.lastRunResult, 'unknown')
    assert.equal(st.lastRunAt, null)
    assert.equal(st.nextRunAt, null)
    assert.equal(st.overdue, false)
  })
})

describe('task units — journald reads under the cloud prefix', () => {
  it('readRecentJournal reads the CLOUD unit and fails open to ""', async () => {
    const mock = journalMock(OK_JOURNAL)
    assert.match(await readRecentJournal(CLOUD_UNIT_KIND, mock, TASK), /anas-cloud-offsite/)
    assert.deepEqual(mock.calls[0].args, ['-u', SERVICE, '-n', '200', '-o', 'short-iso', '--no-pager'])
    // A journal fixture for the BACKUP unit is not this task's journal.
    assert.equal(await readRecentJournal(BACKUP_UNIT_KIND, mock, TASK), '')
    assert.equal(await readRecentJournal(CLOUD_UNIT_KIND, new MockExecutor(), TASK), '')
  })

  it('messageFromJournalLine strips the syslog prefix, bracket or not', () => {
    assert.equal(
      messageFromJournalLine('2026-09-20T02:00:03+0000 anas-pve anas-cloud-offsite[1010]: Error: nope'),
      'Error: nope',
    )
    assert.equal(
      messageFromJournalLine('2026-09-20T02:00:03+0000 anas-pve rclone: transferred 3 files'),
      'transferred 3 files',
    )
  })

  it('parseHelperResult recovers the runner result JSON, typed by the caller', () => {
    const r = parseHelperResult<{ status?: string, bytes?: number, files?: number }>(OK_JOURNAL)
    assert.ok(r)
    assert.equal(r!.status, 'success')
    assert.equal(r!.bytes, 4096)
    assert.equal(r!.files, 3)
    // A failure logs stderr, not a result line.
    assert.equal(parseHelperResult(FAILED_JOURNAL), null)
  })

  it('readLastSuccessAt finds the newest REAL success past skips and failures', async () => {
    const journal = successJournal('2026-09-08T02:00:07+0000', [
      '2026-09-15T02:00:01+0000 anas-pve anas-cloud-offsite[930]: {"task":"offsite","result":{"status":"skipped-off-week","reason":"off week"}}',
      '2026-09-22T02:00:03+0000 anas-pve anas-cloud-offsite[940]: Error: directory not found',
    ])
    assert.equal(await readLastSuccessAt(CLOUD_UNIT_KIND, journalMock(journal), TASK), '2026-09-08T02:00:07.000Z')
    // No record (rotated journal / never run) is null, never a guess.
    assert.equal(await readLastSuccessAt(CLOUD_UNIT_KIND, journalMock(''), TASK), null)
    assert.equal(await readLastSuccessAt(CLOUD_UNIT_KIND, new MockExecutor(), TASK), null)
  })

  it('failureDetailFromJournal prefers the verbatim Error line over systemd boilerplate', () => {
    assert.match(failureDetailFromJournal(CLOUD_UNIT_KIND, FAILED_JOURNAL) ?? '', /^Error: Failed to create file system/)
  })

  it('the boilerplate filter is built from the DESCRIPTOR prefix', () => {
    // No `Error:` line: the fallback must skip systemd's own `<unit>.service: …`
    // trailer for THIS kind and land on the runner's failure line.
    const journal = [
      '2026-09-20T02:00:03+0000 anas-pve anas-cloud-offsite[1010]: rclone failed with exit code 7',
      '2026-09-20T02:00:03+0000 anas-pve systemd[1]: anas-cloud-offsite.service: Failed with result \'exit-code\'.',
    ].join('\n')
    assert.equal(failureDetailFromJournal(CLOUD_UNIT_KIND, journal), 'rclone failed with exit code 7')
    // The SAME journal read with backup's descriptor: `anas-cloud-…service:` is
    // not backup's boilerplate, so the trailer is taken as the failure line.
    assert.match(failureDetailFromJournal(BACKUP_UNIT_KIND, journal) ?? '', /^anas-cloud-offsite\.service: Failed/)
  })

  it('cause hints are per-kind: backup\'s owner-mismatch line is not cloud\'s', () => {
    const journal = [
      '2026-09-20T02:00:03+0000 anas-pve anas-cloud-offsite[1010]: owner mismatch on the target',
      '2026-09-20T02:00:03+0000 anas-pve systemd[1]: anas-cloud-offsite.service: Failed with result \'exit-code\'.',
    ].join('\n')
    assert.equal(failureDetailFromJournal(BACKUP_UNIT_KIND, journal), 'owner mismatch on the target')
    // Cloud declares no hints, so it falls through to the last message line —
    // honest, and nothing of backup's vocabulary leaks in.
    assert.match(failureDetailFromJournal(CLOUD_UNIT_KIND, journal) ?? '', /Failed with result/)
  })

  it('an empty journal yields no detail at all', () => {
    assert.equal(failureDetailFromJournal(CLOUD_UNIT_KIND, ''), null)
  })
})

describe('task units — trigger classification under the cloud prefix', () => {
  it('classifyTrigger: the TIMER fired it iff its last trigger is not older than this run', () => {
    const started = 'Tue 2026-09-22 02:00:00 UTC'
    assert.equal(classifyTrigger({ LastTriggerUSec: started }, { InactiveExitTimestamp: started }), 'scheduled')
    assert.equal(
      classifyTrigger({ LastTriggerUSec: started }, { InactiveExitTimestamp: 'Tue 2026-09-22 10:31:07 UTC' }),
      'manual',
    )
    // Unknowable → manual, which leaves the gate open (never a missed run).
    assert.equal(classifyTrigger({ LastTriggerUSec: 'n/a' }, { InactiveExitTimestamp: started }), 'manual')
    assert.equal(classifyTrigger({}, {}), 'manual')
  })

  it('deriveTriggerSource reads the CLOUD timer + service props (fail-open to manual)', async () => {
    const mock = triggerFixtures(new MockExecutor(), 'Tue 2026-09-22 02:00:00 UTC')
    assert.equal(await deriveTriggerSource(CLOUD_UNIT_KIND, mock, TASK), 'scheduled')
    assert.deepEqual(mock.calls.map(c => c.args[1]).sort(), [SERVICE, TIMER])
    assert.equal(await deriveTriggerSource(CLOUD_UNIT_KIND, new MockExecutor(), TASK), 'manual')
  })
})

describe('task units — the biweekly parity gate under the cloud prefix', () => {
  it('no cadence: never gated, and nothing is read at all', async () => {
    const mock = new MockExecutor()
    const d = await gateRun(CLOUD_UNIT_KIND, mock, task(), new Date(2026, 8, 22))
    assert.equal(d.run, true)
    assert.equal(d.reason, 'ungated')
    assert.equal(mock.calls.length, 0)
  })

  // ISO weeks (`date +%V`): 2026-09-22 is week 39 (ODD), 2026-09-29 is week 40
  // (EVEN) — and the cadence above runs EVEN weeks.
  it('an EVEN-week scheduled fire of an even-parity task runs, without a journal read', async () => {
    const mock = triggerFixtures(journalMock(successJournal('2026-09-15T02:00:07+0000')), 'Tue 2026-09-29 02:00:00 UTC')
    const d = await gateRun(CLOUD_UNIT_KIND, mock, task({ cadence: BIWEEKLY }), new Date(2026, 8, 29, 2, 0))
    assert.equal(d.run, true)
    assert.equal(d.reason, 'on-week')
    assert.equal(mock.calls.some(c => c.command === JOURNALCTL), false)
  })

  it('an ODD-week scheduled fire skips, reading the journal for the heal check', async () => {
    const mock = triggerFixtures(journalMock(successJournal('2026-09-15T02:00:07+0000')), 'Tue 2026-09-22 02:00:00 UTC')
    const d = await gateRun(CLOUD_UNIT_KIND, mock, task({ cadence: BIWEEKLY }), new Date(2026, 8, 22, 2, 0))
    assert.equal(d.run, false)
    assert.equal(d.reason, 'off-week')
    assert.ok(mock.calls.some(c => c.command === JOURNALCTL))
  })

  it('the HEAL rule: an off week runs anyway when a full period passed without a success', async () => {
    const stale = new Date(Date.UTC(2026, 7, 25, 2, 0, 0)).toISOString().replace('.000Z', '+0000')
    const mock = triggerFixtures(journalMock(successJournal(stale)), 'Tue 2026-09-22 02:00:00 UTC')
    const d = await gateRun(CLOUD_UNIT_KIND, mock, task({ cadence: BIWEEKLY }), new Date(2026, 8, 22, 2, 0))
    assert.equal(d.run, true)
    assert.equal(d.reason, 'heal')
  })

  it('no last-success record at all: run rather than risk a missed one', async () => {
    const mock = triggerFixtures(journalMock(''), 'Tue 2026-09-22 02:00:00 UTC')
    const d = await gateRun(CLOUD_UNIT_KIND, mock, task({ cadence: BIWEEKLY }), new Date(2026, 8, 22, 2, 0))
    assert.equal(d.run, true)
    assert.equal(d.reason, 'no-record')
  })

  it('a MANUAL run of an off-week task is never gated', async () => {
    // No timer trigger stamp → classifyTrigger says manual, and the gate opens.
    const mock = journalMock(successJournal('2026-09-15T02:00:07+0000'))
    const d = await gateRun(CLOUD_UNIT_KIND, mock, task({ cadence: BIWEEKLY }), new Date(2026, 8, 22, 2, 0))
    assert.equal(d.run, true)
    assert.equal(d.reason, 'manual')
  })
})

describe('task units — Run-Now supervision under the cloud prefix', () => {
  it('isRunActive classifies systemd snapshots', () => {
    assert.equal(isRunActive({ ActiveState: 'activating' }), true)
    assert.equal(isRunActive({ ActiveState: 'active' }), true)
    assert.equal(isRunActive({ ActiveState: 'reloading' }), true)
    assert.equal(isRunActive({ ActiveState: 'inactive' }), false)
    assert.equal(isRunActive({}), false)
  })

  it('runFailed: a non-success Result or a non-zero exit is a failure; the skip code is not', () => {
    assert.equal(runFailed({ ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0' }), false)
    assert.equal(runFailed({ ActiveState: 'failed', Result: 'exit-code' }), true)
    assert.equal(runFailed({ ActiveState: 'inactive', Result: 'success', ExecMainStatus: '1' }), true)
    assert.equal(
      runFailed({ ActiveState: 'inactive', Result: 'success', ExecMainStatus: String(BACKUP_SKIP_EXIT_CODE) }),
      false,
    )
  })

  it('active → completed: starts the CLOUD unit, polls to terminal, hands back the runner result', async () => {
    const mock = superviseMock({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' }, // pre-check
        { ActiveState: 'activating', Result: 'success', InvocationID: 'NEW' }, // running
        { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'NEW' }, // done
      ],
      journal: OK_JOURNAL,
    })
    const progress: string[] = []
    const run = await superviseTaskRun<{ status?: string, bytes?: number }>(
      CLOUD_UNIT_KIND,
      mock,
      TASK,
      { ...FAST, onProgress: m => progress.push(m) },
    )
    assert.equal(run.status, 'success')
    assert.equal(run.alreadyRunning, false)
    assert.equal(run.reason, undefined)
    assert.equal(run.helper?.bytes, 4096)
    // The run went through the task's OWN unit, so one history holds both.
    assert.ok(mock.calls.some(c => c.command === SYSTEMCTL && c.args[0] === 'start' && c.args[2] === SERVICE))
    assert.deepEqual(progress, [`started cloud sync task '${TASK}'`])
  })

  it('active → failed: throws the journal\'s error line (so the job fails)', async () => {
    const mock = superviseMock({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        { ActiveState: 'activating', InvocationID: 'NEW' },
        { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1', InvocationID: 'NEW' },
      ],
      journal: FAILED_JOURNAL,
    })
    await assert.rejects(superviseTaskRun(CLOUD_UNIT_KIND, mock, TASK, FAST), /couldn't connect SSH/)
  })

  it('a failed run with NO journal line still throws, naming the kind and the task', async () => {
    const mock = superviseMock({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1', InvocationID: 'NEW' },
      ],
      journal: '',
    })
    await assert.rejects(
      superviseTaskRun(CLOUD_UNIT_KIND, mock, TASK, FAST),
      /cloud sync task 'offsite' failed \(see the recent journal\)/,
    )
  })

  it('a deliberate skip is reported as skipped, with the runner\'s own reason carried', async () => {
    const mock = superviseMock({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        // Fast finish: never observed active, but the invocation changed + exit 0.
        { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'NEW' },
      ],
      journal: SKIPPED_JOURNAL,
    })
    const run = await superviseTaskRun<{ status?: string, reason?: string }>(CLOUD_UNIT_KIND, mock, TASK, FAST)
    assert.equal(run.status, 'skipped')
    assert.match(run.helper?.reason ?? '', /ISO week 39 is odd/)
  })

  it('already running: supervises the in-flight run, starts no second one', async () => {
    const mock = superviseMock({
      shows: [
        { ActiveState: 'active', InvocationID: 'CUR' }, // pre-check: already running
        { ActiveState: 'active', InvocationID: 'CUR' },
        { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'CUR' },
      ],
      journal: OK_JOURNAL,
    })
    const progress: string[] = []
    const run = await superviseTaskRun(CLOUD_UNIT_KIND, mock, TASK, { ...FAST, onProgress: m => progress.push(m) })
    assert.equal(run.alreadyRunning, true)
    assert.equal(run.status, 'success')
    assert.equal(mock.calls.some(c => c.args[0] === 'start'), false)
    assert.deepEqual(progress, [`cloud sync task '${TASK}' is already running — waiting for it to finish`])
  })

  it('the TIMEOUT ceiling is truthful, not a failure', async () => {
    const mock = superviseMock({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        { ActiveState: 'activating', InvocationID: 'NEW' }, // never leaves running
      ],
      journal: '',
    })
    let clock = 0
    const run = await superviseTaskRun(CLOUD_UNIT_KIND, mock, TASK, {
      pollIntervalMs: 0,
      timeoutMs: 10,
      sleep: noopSleep,
      now: () => (clock += 4),
    })
    assert.equal(run.status, 'running')
    assert.equal(run.helper, null)
    assert.match(run.reason ?? '', /still running after 0s/)
  })

  it('a failed systemctl start throws (there is nothing to supervise)', async () => {
    const mock = superviseMock({
      shows: [{ ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' }],
      startExit: 1,
      startStderr: `Failed to start ${SERVICE}: Unit not found.`,
    })
    await assert.rejects(superviseTaskRun(CLOUD_UNIT_KIND, mock, TASK, FAST), /Unit not found/)
  })
})

describe('task units — dashboard warnings in the kind\'s own category', () => {
  it('failures + silently-overdue only; disabled never warns; category is cloud', () => {
    const warnings = buildTaskWarnings(CLOUD_UNIT_KIND, [
      { name: 'ok', enabled: true, lastRunResult: 'success', overdue: false },
      { name: 'failing', enabled: true, lastRunResult: 'failure', overdue: false },
      { name: 'overdue', enabled: true, lastRunResult: 'success', overdue: true },
      { name: 'disabled-failing', enabled: false, lastRunResult: 'failure', overdue: true },
      { name: 'skipped', enabled: true, lastRunResult: 'skipped', overdue: false },
    ])
    assert.deepEqual(warnings.map(w => w.ref), ['failing', 'overdue'])
    for (const w of warnings) {
      assert.equal(w.category, 'cloud')
      assert.equal(w.level, 'warning')
    }
    assert.equal(warnings[0].message, 'Cloud sync task \'failing\' last run failed — check the Cloud Sync view')
    assert.equal(warnings[1].message, 'Cloud sync task \'overdue\' is overdue — check the Cloud Sync view')
  })

  it('collectTaskWarnings derives from the store\'s own reader, fail-open', async () => {
    const mock = statusMock({ active: 'failed', result: 'exit-code', execStatus: '1', exitTs: 'Sun 2026-09-20 02:00:03 UTC' })
    const warnings = await collectTaskWarnings(
      CLOUD_UNIT_KIND,
      mock,
      '/etc/systemd/system',
      async () => [task()],
    )
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].category, 'cloud')
    assert.match(warnings[0].message, /last run failed/)

    // A reader that throws yields no warnings rather than a broken dashboard.
    const failOpen = await collectTaskWarnings(CLOUD_UNIT_KIND, mock, '/etc/systemd/system', async () => {
      throw new Error('unit dir unreadable')
    })
    assert.deepEqual(failOpen, [])
  })
})

describe('task units — the store plumbing that is prefix-only', () => {
  it('taskFileExists / readUnitTexts / removeTaskUnits work off the cloud names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-task-units-'))
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: ok('') })
      await writeFile(join(dir, SERVICE), '[Unit]\nDescription=ANAS cloud sync task offsite\n')
      await writeFile(join(dir, TIMER), '[Timer]\nOnCalendar=Tue 02:00\n')
      await writeFile(join(dir, 'keep.txt'), 'x')

      assert.equal(await taskFileExists(CLOUD_UNIT_KIND, dir, TASK), true)
      assert.equal(await taskFileExists(CLOUD_UNIT_KIND, dir, 'absent'), false)
      // Backup's descriptor does not see the cloud store's files.
      assert.equal(await taskFileExists(BACKUP_UNIT_KIND, dir, TASK), false)

      const texts = await readUnitTexts(CLOUD_UNIT_KIND, dir, TASK)
      assert.match(texts.unit, /cloud sync task offsite/)
      assert.match(texts.timer, /OnCalendar=Tue 02:00/)
      assert.deepEqual(await readUnitTexts(CLOUD_UNIT_KIND, dir, 'absent'), { unit: '', timer: '' })

      await removeTaskUnits(CLOUD_UNIT_KIND, mock, dir, TASK)
      assert.deepEqual(await readdir(dir), ['keep.txt'])
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes(`disable --now ${TIMER}`))
      assert.ok(cmds.includes('daemon-reload'))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('validateSchedule asks systemd, and surfaces its stderr', async () => {
    const good = new MockExecutor()
    good.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'Tue 02:00'], result: ok('Normalized form: Tue *-*-* 02:00:00\n') })
    assert.deepEqual(await validateSchedule(good, 'Tue 02:00'), { ok: true })

    const bad = new MockExecutor()
    bad.addFixture({
      command: SYSTEMD_ANALYZE,
      args: ['calendar', 'nope'],
      result: { stdout: '', stderr: 'Failed to parse calendar specification \'nope\'', exitCode: 1 },
    })
    assert.deepEqual(await validateSchedule(bad, 'nope'), {
      ok: false,
      error: 'Failed to parse calendar specification \'nope\'',
    })
  })

  it('effectiveSchedule: a cadence generates the expression, a raw schedule stands', () => {
    assert.equal(effectiveSchedule({ schedule: '*-*-* 02:00:00' }), '*-*-* 02:00:00')
    assert.equal(effectiveSchedule({ schedule: '*-*-* 02:00:00', cadence: BIWEEKLY }), 'Tue 02:00')
    // A biweekly cadence deliberately generates a WEEKLY expression — the parity
    // gate skips the off weeks, because OnCalendar cannot.
    assert.equal(
      effectiveSchedule({ schedule: 'x', cadence: { kind: 'weekly', days: ['Thu', 'Tue'], time: '02:00' } }),
      'Tue,Thu 02:00',
    )
    // `custom` generates nothing: the raw expression is the schedule.
    assert.equal(effectiveSchedule({ schedule: '*-*-* 03:00:00', cadence: { kind: 'custom', days: [] } }), '*-*-* 03:00:00')
  })
})

// ---------------------------------------------------------------------------
//  The point of the extraction: ONE implementation. Identical inputs through
//  both descriptors must differ ONLY where the descriptor says they differ —
//  the unit names the calls address, and the warning category/prose.
// ---------------------------------------------------------------------------
describe('task units — both descriptors, identical inputs, identical answers', () => {
  const PROPS = {
    ActiveState: 'inactive',
    Result: 'success',
    ExecMainStatus: '0',
    ExecMainExitTimestamp: 'Sun 2026-09-20 02:00:07 UTC',
    InactiveEnterTimestamp: '',
  }

  it('status derivation is the same answer off either prefix', async () => {
    const nextTs = String((Date.now() + 3_600_000) * 1000)
    const forKind = async (kind: TaskUnitKind): Promise<unknown> => {
      const mock = new MockExecutor()
      mock.addFixture({
        command: SYSTEMCTL,
        args: ['show', serviceUnitName(kind, TASK), '-p', SHOW_STATUS_PROPS],
        result: ok(showBlob(PROPS)),
      })
      mock.addFixture({
        command: SYSTEMCTL,
        args: ['show', timerUnitName(kind, TASK), '-p', 'NextElapseUSecRealtime'],
        result: ok(`NextElapseUSecRealtime=${nextTs}\n`),
      })
      return deriveTaskStatus(kind, mock, task(), Date.UTC(2026, 8, 22, 2, 0, 0))
    }
    assert.deepEqual(await forKind(CLOUD_UNIT_KIND), await forKind(BACKUP_UNIT_KIND))
  })

  it('the gate decides the same way off either prefix — only the NOUN differs', async () => {
    const forKind = async (kind: TaskUnitKind) => {
      // An OFF week (39, odd), so the decision pays for the journal read too.
      const mock = triggerFixtures(
        journalMock(successJournal('2026-09-15T02:00:07+0000', [], kind), kind),
        'Tue 2026-09-22 02:00:00 UTC',
        kind,
      )
      return gateRun(kind, mock, task({ cadence: BIWEEKLY }), new Date(2026, 8, 22, 2, 0))
    }
    const cloud = await forKind(CLOUD_UNIT_KIND)
    const backup = await forKind(BACKUP_UNIT_KIND)
    assert.deepEqual(
      { run: cloud.run, reason: cloud.reason },
      { run: backup.run, reason: backup.reason },
      'the decision itself is one implementation',
    )
    // The detail is the same sentence with the kind's own word in it — a cloud
    // sync's skip must never journal "backup" (rclone.2), and backup's string
    // must not change because cloud exists.
    assert.equal(
      backup.detail,
      'ISO week 39 is odd, this task runs even weeks — skipped (off week); last successful backup 7.2 days ago',
    )
    assert.equal(cloud.detail, backup.detail.replace('successful backup', 'successful cloud sync'))
  })

  it('supervision reports the same run off either prefix', async () => {
    const forKind = async (kind: TaskUnitKind): Promise<unknown> => {
      const service = serviceUnitName(kind, TASK)
      const mock = new MockExecutor()
      mock.addFixture({
        command: SYSTEMCTL,
        args: ['show', service, '-p', SHOW_RUN_PROPS],
        results: [
          ok(showBlob({ ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' })),
          ok(showBlob({ ActiveState: 'activating', Result: 'success', InvocationID: 'NEW' })),
          ok(showBlob({ ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'NEW' })),
        ],
      })
      mock.addFixture({ command: SYSTEMCTL, args: ['start', '--no-block', service], result: ok('') })
      mock.addFixture({
        command: JOURNALCTL,
        args: ['-u', service, '-n', '200', '-o', 'short-iso', '--no-pager'],
        result: ok(`2026-09-20T02:00:07+0000 anas-pve ${kind.prefix}${TASK}[999]: {"task":"${TASK}","result":{"status":"success","bytes":4096}}`),
      })
      return superviseTaskRun(kind, mock, TASK, FAST)
    }
    assert.deepEqual(await forKind(CLOUD_UNIT_KIND), await forKind(BACKUP_UNIT_KIND))
  })

  it('warnings differ ONLY in category and the view they name', () => {
    const inputs = [{ name: 'x', enabled: true, lastRunResult: 'failure' as const, overdue: false }]
    const cloud = buildTaskWarnings(CLOUD_UNIT_KIND, inputs)
    const backup = buildTaskWarnings(BACKUP_UNIT_KIND, inputs)
    assert.equal(cloud.length, backup.length)
    assert.equal(cloud[0].level, backup[0].level)
    assert.equal(cloud[0].ref, backup[0].ref)
    assert.equal(cloud[0].category, 'cloud')
    assert.equal(backup[0].category, 'backup')
    assert.equal(backup[0].message, 'Backup task \'x\' last run failed — check the Backup view')
    assert.equal(cloud[0].message, 'Cloud sync task \'x\' last run failed — check the Cloud Sync view')
  })

  it('the pure helpers take no descriptor at all — one answer for every kind', () => {
    const props = { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0' }
    assert.equal(deriveTaskRunResult(props), 'success')
    assert.equal(isRunActive(props), false)
    assert.equal(runFailed(props), false)
    assert.equal(classifyTrigger({}, {}), 'manual')
    assert.equal(messageFromJournalLine('a b c[1]: msg'), 'msg')
  })
})
