import type { BackupTask } from '@anas/shared'
import type { CommandExecutor, ExecResult, PipelineResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildBackupWarnings,
  collectBackupWarnings,
  deriveRunResult,
  deriveTaskStatus,
  failureDetailFromJournal,
  isRunActive,
  messageFromJournalLine,
  parseHelperResult,
  parseServiceUnit,
  parseSystemdTimestamp,
  readAllTasks,
  readRecentJournal,
  removeTaskUnits,
  renderServiceUnit,
  renderTimerUnit,
  runFailed,
  serviceUnitName,
  superviseRun,
  timerUnitName,
  validateSchedule,
  writeTaskUnits,
} from '../backup-units.js'

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const JOURNALCTL = '/usr/bin/journalctl'

function makeTask(over: Partial<BackupTask> = {}): BackupTask {
  return {
    name: 'nightly-etc',
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives: [{ name: 'etc', path: '/etc', excludes: [] }],
    changeDetectionMode: 'default',
    schedule: '*-*-* 02:00:00',
    enabled: true,
    limitNofile: 1024,
    ...over,
  }
}

describe('backup units — the systemd units ARE the store (Epic 16.3, NOTES §7)', () => {
  it('task ⇄ service unit round-trips through the X-ANAS-Task JSON', () => {
    for (const task of [
      makeTask(),
      makeTask({ name: 'metadata-run', namespace: 'anastest', changeDetectionMode: 'metadata', limitNofile: 4096, enabled: false }),
      makeTask({ archives: [
        { name: 'documents', path: '/root/anas-src/documents', excludes: ['*.tmp'] },
        { name: 'pictures', path: '/root/anas-src/pictures', excludes: [] },
      ] }),
    ]) {
      assert.deepEqual(parseServiceUnit(renderServiceUnit(task)), task)
    }
  })

  it('service is a oneshot carrying LimitNOFILE + the backup-task ExecStart', () => {
    const unit = renderServiceUnit(makeTask({ limitNofile: 2048 }))
    assert.match(unit, /Type=oneshot/)
    assert.match(unit, /LimitNOFILE=2048/)
    assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/anas\/packages\/daemon\/dist\/backup-task\.js --name nightly-etc/)
    assert.match(unit, /Description=ANAS backup task nightly-etc/)
  })

  it('timer renders OnCalendar + Persistent + timers.target', () => {
    const unit = renderTimerUnit(makeTask({ schedule: '*-*-* 02:00:00' }))
    assert.match(unit, /OnCalendar=\*-\*-\* 02:00:00/)
    assert.match(unit, /Persistent=true/)
    assert.match(unit, /WantedBy=timers\.target/)
  })

  it('parseServiceUnit returns null for a missing marker or invalid JSON', () => {
    assert.equal(parseServiceUnit('[Unit]\nDescription=x\n'), null)
    assert.equal(parseServiceUnit('# X-ANAS-Task={"name":"BAD NAME"}\n'), null)
  })

  it('validateSchedule → ok on exit 0, surfaces systemd stderr on failure', async () => {
    const ok = new MockExecutor()
    ok.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'daily'], result: { stdout: 'Normalized form: *-*-* 00:00:00\n', stderr: '', exitCode: 0 } })
    assert.deepEqual(await validateSchedule(ok, 'daily'), { ok: true })

    const bad = new MockExecutor()
    bad.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'nope'], result: { stdout: '', stderr: 'Failed to parse calendar specification', exitCode: 1 } })
    const r = await validateSchedule(bad, 'nope')
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /Failed to parse calendar/)
  })
})

describe('backup units — CRUD lifecycle (temp dir + mocked systemctl)', () => {
  let dir: string
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backup-units-'))
    mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writeTaskUnits writes both files, reloads, enables the timer', async () => {
    const task = makeTask({ enabled: true })
    await writeTaskUnits(mock, dir, task)
    const files = (await readdir(dir)).sort()
    assert.deepEqual(files, [serviceUnitName(task.name), timerUnitName(task.name)].sort())
    assert.deepEqual(parseServiceUnit(await readFile(join(dir, serviceUnitName(task.name)), 'utf-8')), task)
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes('daemon-reload'))
    assert.ok(cmds.includes(`enable --now ${timerUnitName(task.name)}`))
  })

  it('writeTaskUnits with enabled=false disables the timer', async () => {
    await writeTaskUnits(mock, dir, makeTask({ enabled: false }))
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`disable --now ${timerUnitName('nightly-etc')}`))
    assert.ok(!cmds.some(c => c.startsWith('enable ')))
  })

  it('removeTaskUnits deletes both files, disables the timer, leaves others', async () => {
    await writeTaskUnits(mock, dir, makeTask())
    await writeFile(join(dir, 'keep.txt'), 'x')
    await removeTaskUnits(mock, dir, 'nightly-etc')
    assert.deepEqual(await readdir(dir), ['keep.txt'])
  })

  it('readAllTasks parses valid units and skips invalid ones (fail-open)', async () => {
    await writeTaskUnits(mock, dir, makeTask({ name: 'one' }))
    await writeTaskUnits(mock, dir, makeTask({ name: 'two' }))
    await writeFile(join(dir, serviceUnitName('broken')), '[Unit]\nDescription=broken\n')
    const names = (await readAllTasks(dir)).map(t => t.name).sort()
    assert.deepEqual(names, ['one', 'two'])
  })
})

describe('backup units — LOCAL-ONLY status derivation', () => {
  function statusMock(opts: { active?: string, result?: string, exitTs?: string, nextTs?: string }): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', serviceUnitName('nightly-etc'), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'],
      result: { stdout: `ActiveState=${opts.active ?? 'inactive'}\nResult=${opts.result ?? 'success'}\nExecMainStatus=0\nExecMainExitTimestamp=${opts.exitTs ?? ''}\nInactiveEnterTimestamp=\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', timerUnitName('nightly-etc'), '-p', 'NextElapseUSecRealtime'],
      result: { stdout: `NextElapseUSecRealtime=${opts.nextTs ?? '0'}\n`, stderr: '', exitCode: 0 },
    })
    return mock
  }

  it('deriveRunResult maps systemd state to a result', () => {
    assert.equal(deriveRunResult({ ActiveState: 'activating', Result: '' }), 'running')
    assert.equal(deriveRunResult({ ActiveState: 'failed', Result: 'exit-code' }), 'failure')
    assert.equal(deriveRunResult({ ActiveState: 'inactive', Result: 'success' }), 'success')
    assert.equal(deriveRunResult({ ActiveState: 'inactive', Result: 'exit-code' }), 'failure')
    assert.equal(deriveRunResult({}), 'unknown')
  })

  it('parseSystemdTimestamp handles the HUMAN date string systemctl prints', () => {
    assert.equal(parseSystemdTimestamp('Sun 2026-07-19 02:00:00 UTC'), '2026-07-19T02:00:00.000Z')
    assert.equal(parseSystemdTimestamp(String(Date.UTC(2026, 6, 20, 2, 0, 0) * 1000)), '2026-07-20T02:00:00.000Z')
    for (const v of ['n/a', 'infinity', '0', ''])
      assert.equal(parseSystemdTimestamp(v), null, `sentinel ${v}`)
  })

  // NextElapseUSecRealtime as microseconds-since-epoch (parseSystemdTimestamp
  // also accepts the numeric form; used here to avoid locale/date-format churn).
  const futureUsec = String((Date.now() + 3_600_000) * 1000)
  const pastUsec = String((Date.now() - 3_600_000) * 1000)

  it('status: success result, future next run → not overdue', async () => {
    const st = await deriveTaskStatus(statusMock({ result: 'success', nextTs: futureUsec }), makeTask())
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.overdue, false)
    assert.notEqual(st.nextRunAt, null)
  })

  it('status: enabled + next-elapse in the PAST → overdue', async () => {
    const st = await deriveTaskStatus(statusMock({ result: 'success', nextTs: pastUsec }), makeTask({ enabled: true }))
    assert.equal(st.overdue, true)
  })

  it('status: a DISABLED task with a past next-elapse is NOT overdue', async () => {
    const st = await deriveTaskStatus(statusMock({ nextTs: pastUsec }), makeTask({ enabled: false }))
    assert.equal(st.overdue, false)
  })

  it('lastRunAt derives from ExecMainExitTimestamp', async () => {
    const st = await deriveTaskStatus(statusMock({ exitTs: 'Sun 2026-07-19 02:00:12 UTC' }), makeTask())
    assert.equal(st.lastRunAt, '2026-07-19T02:00:12.000Z')
  })
})

describe('backup units — journald + dashboard warnings', () => {
  it('readRecentJournal returns the journalctl blob, fail-open to ""', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: JOURNALCTL,
      args: ['-u', serviceUnitName('nightly-etc'), '-n', '200', '-o', 'short-iso', '--no-pager'],
      result: { stdout: '2026-07-19T02:00:00 anas-pve backup-task[1]: {"task":"nightly-etc"}\n', stderr: '', exitCode: 0 },
    })
    assert.match(await readRecentJournal(mock, 'nightly-etc'), /nightly-etc/)

    const broken = new MockExecutor() // no fixture → mock returns 127
    assert.equal(await readRecentJournal(broken, 'nope'), '')
  })

  it('buildBackupWarnings: failures + silently-overdue only; disabled never warns', () => {
    const warnings = buildBackupWarnings([
      { name: 'ok', enabled: true, lastRunResult: 'success', overdue: false },
      { name: 'failing', enabled: true, lastRunResult: 'failure', overdue: false },
      { name: 'overdue', enabled: true, lastRunResult: 'success', overdue: true },
      { name: 'disabled-failing', enabled: false, lastRunResult: 'failure', overdue: true },
    ])
    const refs = warnings.map(w => w.ref).sort()
    assert.deepEqual(refs, ['failing', 'overdue'])
    for (const w of warnings)
      assert.equal(w.category, 'backup')
  })

  it('collectBackupWarnings reads the store and derives warnings (fail-open)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-backup-units-'))
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      await writeTaskUnits(mock, dir, makeTask({ name: 'a' }))
      // Default systemctl show fixture returns empty → unknown result, no next
      // elapse → no warnings. Just prove it reads the store without throwing.
      const warnings = await collectBackupWarnings(mock, dir)
      assert.ok(Array.isArray(warnings))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
//  Run-Now supervision (Fix 1: manual runs land in systemd + the unit journal)
// ---------------------------------------------------------------------------

/** A `systemctl show` blob from key=value pairs. */
function showBlob(props: Record<string, string>): string {
  return `${Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

/**
 * A scripted executor: `systemctl show` returns the NEXT queued snapshot each
 * call (last one repeats), `systemctl start` records + returns `startResult`,
 * `journalctl` returns `journal`. Everything else is a benign success.
 */
class ScriptedExecutor implements CommandExecutor {
  readonly calls: { command: string, args: string[] }[] = []
  private showQueue: string[]
  constructor(
    private opts: { shows: Record<string, string>[], journal?: string, startExit?: number, startStderr?: string },
  ) {
    this.showQueue = opts.shows.map(showBlob)
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    if (command === '/usr/bin/systemctl' && args[0] === 'show') {
      const next = this.showQueue.length > 1 ? this.showQueue.shift()! : (this.showQueue[0] ?? '')
      return { stdout: next, stderr: '', exitCode: 0 }
    }
    if (command === '/usr/bin/systemctl' && args[0] === 'start') {
      return { stdout: '', stderr: this.opts.startStderr ?? '', exitCode: this.opts.startExit ?? 0 }
    }
    if (command === '/usr/bin/journalctl')
      return { stdout: this.opts.journal ?? '', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  async pipeline(): Promise<PipelineResult> {
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: '' }
  }
}

async function noopSleep(): Promise<void> {}
const FAST = { pollIntervalMs: 0, timeoutMs: 60000, sleep: noopSleep }

const OK_JOURNAL = [
  '2026-07-19T01:07:07+0000 anas-pve systemd[1]: Starting ANAS backup task nightly-etc...',
  '2026-07-19T01:07:07+0000 anas-pve anas-backup-nightly-etc[999]: {"task":"nightly-etc","result":{"status":"success","archives":["etc.pxar: had to backup 82.957 KiB of 82.957 KiB (compressed 81.043 KiB) in 0.01 s"],"target":"Starting backup: [anastest]:host/anas-pve/2026-07-19T01:07:07Z"}}',
  '2026-07-19T01:07:07+0000 anas-pve systemd[1]: anas-backup-nightly-etc.service: Deactivated successfully.',
].join('\n')

const TOO_SOON_JOURNAL = [
  '2026-07-19T01:07:08+0000 anas-pve anas-backup-nightly-etc[1001]: {"task":"nightly-etc","result":{"status":"skipped","archives":[],"reason":"snapshot timestamp collision (1-second resolution) — nothing new to back up yet"}}',
  '2026-07-19T01:07:08+0000 anas-pve systemd[1]: anas-backup-nightly-etc.service: Deactivated successfully.',
].join('\n')

const FAILED_JOURNAL = [
  '2026-07-19T01:08:00+0000 anas-pve anas-backup-nightly-etc[1010]: Error: permission check failed.',
  '2026-07-19T01:08:00+0000 anas-pve systemd[1]: anas-backup-nightly-etc.service: Main process exited, code=exited, status=1/FAILURE',
  '2026-07-19T01:08:00+0000 anas-pve systemd[1]: anas-backup-nightly-etc.service: Failed with result \'exit-code\'.',
].join('\n')

describe('backup Run-Now supervision (Fix 1 — through the unit)', () => {
  it('isRunActive / runFailed classify systemd snapshots', () => {
    assert.equal(isRunActive({ ActiveState: 'activating' }), true)
    assert.equal(isRunActive({ ActiveState: 'active' }), true)
    assert.equal(isRunActive({ ActiveState: 'inactive' }), false)
    assert.equal(runFailed({ ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0' }), false)
    assert.equal(runFailed({ ActiveState: 'failed', Result: 'exit-code' }), true)
    assert.equal(runFailed({ ActiveState: 'inactive', Result: 'success', ExecMainStatus: '1' }), true)
  })

  it('messageFromJournalLine strips the syslog prefix', () => {
    assert.equal(
      messageFromJournalLine('2026-07-19T01:07:07+0000 anas-pve anas-backup-x[999]: Error: nope'),
      'Error: nope',
    )
  })

  it('parseHelperResult recovers the helper result JSON from the journal', () => {
    const r = parseHelperResult(OK_JOURNAL)
    assert.ok(r)
    assert.equal(r!.status, 'success')
    assert.ok(r!.archives!.some(l => l.startsWith('etc.pxar:')))
    assert.equal(parseHelperResult(FAILED_JOURNAL), null) // a failure logs no result JSON
  })

  it('failureDetailFromJournal returns pbc\'s verbatim Error line', () => {
    assert.equal(failureDetailFromJournal(FAILED_JOURNAL), 'Error: permission check failed.')
  })

  it('running → success: starts the unit, polls to completion, recovers stats', async () => {
    const exec = new ScriptedExecutor({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' }, // pre-check
        { ActiveState: 'activating', Result: 'success', InvocationID: 'NEW' }, // running
        { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'NEW' }, // done
      ],
      journal: OK_JOURNAL,
    })
    const res = await superviseRun(exec, 'nightly-etc', FAST)
    assert.equal(res.status, 'success')
    assert.equal(res.alreadyRunning, false)
    assert.ok(res.archives!.some(l => l.startsWith('etc.pxar:')))
    // It went through systemctl start (Fix 1: the run lands in the unit history).
    assert.ok(exec.calls.some(c => c.command === '/usr/bin/systemctl' && c.args[0] === 'start'))
  })

  it('running → failed: throws the journal\'s error line (so the job fails)', async () => {
    const exec = new ScriptedExecutor({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        { ActiveState: 'activating', InvocationID: 'NEW' },
        { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1', InvocationID: 'NEW' },
      ],
      journal: FAILED_JOURNAL,
    })
    await assert.rejects(superviseRun(exec, 'nightly-etc', FAST), /permission check failed/)
  })

  it('benign too-soon: helper JSON status skipped → success run reported as skipped', async () => {
    const exec = new ScriptedExecutor({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        // Fast finish: never observed active, but the invocation changed + exit 0.
        { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'NEW' },
      ],
      journal: TOO_SOON_JOURNAL,
    })
    const res = await superviseRun(exec, 'nightly-etc', FAST)
    assert.equal(res.status, 'skipped')
    assert.match(res.reason ?? '', /timestamp collision/)
  })

  it('already running: does NOT start a second run, supervises the in-flight one', async () => {
    const exec = new ScriptedExecutor({
      shows: [
        { ActiveState: 'active', InvocationID: 'CUR' }, // pre-check: already running
        { ActiveState: 'active', InvocationID: 'CUR' },
        { ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', InvocationID: 'CUR' },
      ],
      journal: OK_JOURNAL,
    })
    const res = await superviseRun(exec, 'nightly-etc', FAST)
    assert.equal(res.alreadyRunning, true)
    assert.equal(res.status, 'success')
    assert.equal(exec.calls.some(c => c.command === '/usr/bin/systemctl' && c.args[0] === 'start'), false)
  })

  it('ceiling: a still-running backup is reported truthfully (status running), not failed', async () => {
    const exec = new ScriptedExecutor({
      shows: [
        { ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' },
        { ActiveState: 'activating', InvocationID: 'NEW' }, // never leaves running
      ],
      journal: '',
    })
    let clock = 0
    const res = await superviseRun(exec, 'nightly-etc', {
      pollIntervalMs: 0,
      timeoutMs: 10,
      sleep: noopSleep,
      now: () => (clock += 4), // advances past the 10ms ceiling within a few polls
    })
    assert.equal(res.status, 'running')
    assert.match(res.reason ?? '', /still running/)
  })

  it('a failed systemctl start throws (nothing to supervise)', async () => {
    const exec = new ScriptedExecutor({
      shows: [{ ActiveState: 'inactive', Result: 'success', InvocationID: 'OLD' }],
      startExit: 1,
      startStderr: 'Failed to start anas-backup-nightly-etc.service: Unit not found.',
    })
    await assert.rejects(superviseRun(exec, 'nightly-etc', FAST), /Unit not found/)
  })
})
