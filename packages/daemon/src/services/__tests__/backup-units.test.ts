import type { BackupTask } from '@anas/shared'
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
  parseServiceUnit,
  parseSystemdTimestamp,
  readAllTasks,
  readRecentJournal,
  removeTaskUnits,
  renderServiceUnit,
  renderTimerUnit,
  serviceUnitName,
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
