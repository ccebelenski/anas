import type { SnapshotCadence, SnapshotSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildScheduleWarnings,
  cadenceToOnCalendar,
  deriveScheduleDetail,
  deriveScheduleStatus,
  parseServiceUnit,
  readAllSchedules,
  readSchedule,
  removeScheduleUnits,
  renderServiceUnit,
  renderTimerUnit,
  scheduleFileExists,
  serviceUnitName,
  timerUnitName,
  writeScheduleUnits,
} from '../snapshot-schedule-units.js'

const SYSTEMCTL = '/usr/bin/systemctl'

function makeSchedule(over: Partial<SnapshotSchedule> = {}): SnapshotSchedule {
  return {
    id: 'nightly-tank-media',
    name: 'Nightly tank/media',
    target: { kind: 'zfs', dataset: 'tank/media' },
    cadence: 'daily',
    retention: { daily: 7, weekly: 4, monthly: 6 },
    recursive: false,
    enabled: true,
    notify: 'on-failure',
    ...over,
  }
}

describe('snapshot schedule units — cadence → OnCalendar (systemd 257 verified)', () => {
  it('maps every bucket to a valid systemd calendar expression', () => {
    const expected: Record<SnapshotCadence, string> = {
      frequently: '*:0/15',
      hourly: 'hourly',
      daily: 'daily',
      weekly: 'weekly',
      monthly: 'monthly',
      yearly: 'yearly',
    }
    for (const [cadence, oncal] of Object.entries(expected))
      assert.equal(cadenceToOnCalendar(cadence as SnapshotCadence), oncal)
  })

  it('the timer unit carries the translated OnCalendar and Persistent=true', () => {
    const timer = renderTimerUnit(makeSchedule({ cadence: 'weekly' }))
    assert.match(timer, /OnCalendar=weekly/)
    assert.match(timer, /Persistent=true/)
    assert.match(timer, /WantedBy=timers\.target/)
  })
})

describe('snapshot schedule units — the systemd units ARE the store', () => {
  it('schedule ⇄ service unit round-trips through the X-ANAS-Schedule JSON', () => {
    for (const schedule of [
      makeSchedule(),
      makeSchedule({ id: 'ahr-hourly', name: 'AHR hourly', target: { kind: 'ahr', pool: 'tank' }, cadence: 'hourly', retention: { hourly: 24 } }),
      makeSchedule({ id: 'weekly.recursive', cadence: 'weekly', recursive: true, enabled: false }),
    ]) {
      const unit = renderServiceUnit(schedule)
      assert.deepEqual(parseServiceUnit(unit), schedule)
      // ExecStart fires the runner with the schedule id; never parsed back.
      assert.match(unit, new RegExp(`ExecStart=.*snapshot-task\\.js --id ${schedule.id.replace('.', '\\.')}`))
      assert.match(unit, /Type=oneshot/)
      assert.match(unit, /Environment=TZ=UTC/)
    }
  })

  it('9.4: notify round-trips through X-ANAS-Schedule, and an ABSENT one reads as on-failure', () => {
    const loud = makeSchedule({ notify: 'always' })
    assert.deepEqual(parseServiceUnit(renderServiceUnit(loud)), loud)

    // A unit written before 9.4 gained the knob — the store must keep firing it,
    // with exactly the failure-only behaviour it had.
    const legacy = renderServiceUnit(makeSchedule()).replace(/,"notify":"on-failure"/, '')
    assert.doesNotMatch(legacy, /"notify"/)
    assert.equal(parseServiceUnit(legacy)?.notify, 'on-failure')
  })

  it('parseServiceUnit returns null for a unit without the marker or with bad JSON', () => {
    assert.equal(parseServiceUnit('[Unit]\nDescription=x\n'), null)
    assert.equal(parseServiceUnit('# X-ANAS-Schedule={not json\n'), null)
    assert.equal(parseServiceUnit('# X-ANAS-Schedule={"id":"x"}\n'), null) // fails schema
  })
})

describe('snapshot schedule units — CRUD lifecycle (temp dir + mocked systemctl)', () => {
  let dir: string
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-snap-units-'))
    mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writeScheduleUnits writes both files, reloads, enables the timer', async () => {
    const schedule = makeSchedule({ enabled: true })
    await writeScheduleUnits(mock, dir, schedule)
    const files = (await readdir(dir)).sort()
    assert.deepEqual(files, [serviceUnitName(schedule.id), timerUnitName(schedule.id)].sort())
    assert.deepEqual(await readSchedule(dir, schedule.id), schedule)
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes('daemon-reload'))
    assert.ok(cmds.includes(`enable --now ${timerUnitName(schedule.id)}`))
  })

  it('writeScheduleUnits with enabled=false disables the timer', async () => {
    await writeScheduleUnits(mock, dir, makeSchedule({ enabled: false }))
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`disable --now ${timerUnitName('nightly-tank-media')}`))
    assert.ok(!cmds.some(c => c.startsWith('enable ')))
  })

  it('removeScheduleUnits deletes both files, disables the timer, leaves others', async () => {
    await writeScheduleUnits(mock, dir, makeSchedule())
    await writeFile(join(dir, 'keep.txt'), 'x')
    assert.equal(await scheduleFileExists(dir, 'nightly-tank-media'), true)
    await removeScheduleUnits(mock, dir, 'nightly-tank-media')
    assert.deepEqual(await readdir(dir), ['keep.txt'])
    assert.equal(await scheduleFileExists(dir, 'nightly-tank-media'), false)
  })

  it('readAllSchedules parses valid units and skips invalid ones (fail-open)', async () => {
    await writeScheduleUnits(mock, dir, makeSchedule({ id: 'one' }))
    await writeScheduleUnits(mock, dir, makeSchedule({ id: 'two' }))
    await writeFile(join(dir, serviceUnitName('broken')), '[Unit]\nDescription=broken\n')
    const ids = (await readAllSchedules(dir)).map(s => s.id).sort()
    assert.deepEqual(ids, ['one', 'two'])
  })

  it('readAllSchedules on a missing dir yields [] (fail-open)', async () => {
    assert.deepEqual(await readAllSchedules(join(dir, 'does-not-exist')), [])
  })
})

describe('snapshot schedule units — status derivation + dashboard warnings', () => {
  function statusMock(opts: { active?: string, result?: string, exitTs?: string, nextTs?: string }): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', serviceUnitName('nightly-tank-media'), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'],
      result: { stdout: `ActiveState=${opts.active ?? 'inactive'}\nResult=${opts.result ?? 'success'}\nExecMainStatus=0\nExecMainExitTimestamp=${opts.exitTs ?? ''}\nInactiveEnterTimestamp=\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', timerUnitName('nightly-tank-media'), '-p', 'NextElapseUSecRealtime'],
      result: { stdout: `NextElapseUSecRealtime=${opts.nextTs ?? '0'}\n`, stderr: '', exitCode: 0 },
    })
    return mock
  }

  it('derives last result + next run; a past next-elapse on an enabled schedule is overdue', async () => {
    const past = 'Mon 2020-01-01 00:00:00 UTC'
    const st = await deriveScheduleStatus(statusMock({ result: 'success', exitTs: 'Sun 2026-07-26 00:00:00 UTC', nextTs: past }), makeSchedule({ enabled: true }))
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.lastRunAt, '2026-07-26T00:00:00.000Z')
    assert.equal(st.overdue, true)
  })

  it('a disabled schedule is never overdue even with a past next-elapse', async () => {
    const st = await deriveScheduleStatus(statusMock({ nextTs: 'Mon 2020-01-01 00:00:00 UTC' }), makeSchedule({ enabled: false }))
    assert.equal(st.overdue, false)
  })

  // Live-proof F9, reached through the SAME shared map as backup: systemd
  // unloads a disabled unit nothing references and answers from property
  // DEFAULTS (`Result=success`, both timestamps empty), which read as a
  // successful run that never happened.
  it('a DISABLED schedule whose history systemd collected reads `disabled` (F9)', async () => {
    const st = await deriveScheduleStatus(
      statusMock({ result: 'success', exitTs: '' }),
      makeSchedule({ enabled: false }),
    )
    assert.equal(st.lastRunResult, 'disabled')
    assert.equal(st.lastRunAt, null)
    // The same shape while ENABLED is untouched — the unit is referenced there.
    const on = await deriveScheduleStatus(statusMock({ result: 'success', exitTs: '' }), makeSchedule({ enabled: true }))
    assert.equal(on.lastRunResult, 'success')
  })

  it('the schedule DETAIL states why there is no result, and shows no exit code (F9)', async () => {
    const mock = statusMock({ result: 'success', exitTs: '' })
    const detail = await deriveScheduleDetail(mock, join(tmpdir(), 'anas-no-such-unit-dir'), makeSchedule({ enabled: false }))
    assert.equal(detail.lastRunResult, 'disabled')
    assert.equal(detail.statusNote, 'run history is not retained while a task is disabled')
    // `ExecMainStatus=0` is a default too — it must not be shown as "exit 0".
    assert.equal(detail.lastRunExitCode, null)
  })

  it('buildScheduleWarnings warns only on enabled failed/overdue schedules', () => {
    const base = makeSchedule()
    const warnings = buildScheduleWarnings([
      { schedule: base, lastRunResult: 'failure', lastRunAt: null, nextRunAt: null, overdue: false },
      { schedule: makeSchedule({ id: 'ovd', enabled: true }), lastRunResult: 'success', lastRunAt: null, nextRunAt: null, overdue: true },
      { schedule: makeSchedule({ id: 'ok', enabled: true }), lastRunResult: 'success', lastRunAt: null, nextRunAt: null, overdue: false },
      { schedule: makeSchedule({ id: 'off', enabled: false }), lastRunResult: 'failure', lastRunAt: null, nextRunAt: null, overdue: true },
    ])
    assert.deepEqual(warnings.map(w => w.ref).sort(), ['nightly-tank-media', 'ovd'])
    assert.ok(warnings.every(w => w.category === 'schedule'))
  })
})
