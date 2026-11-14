import type { SnapshotCadence, SnapshotFireShape, SnapshotSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildScheduleWarnings,
  buildUnparseableScheduleWarnings,
  cadenceToOnCalendar,
  deriveScheduleDetail,
  deriveScheduleStatus,
  parseServiceUnit,
  readAllSchedules,
  readSchedule,
  readScheduleList,
  removeScheduleUnits,
  renderServiceUnit,
  renderTimerUnit,
  scheduleFileExists,
  serviceUnitName,
  snapshotStampPath,
  timerUnitName,
  writeScheduleUnits,
} from '../snapshot-schedule-units.js'
import { withStampDir } from './stamp-dir.js'

const SYSTEMCTL = '/usr/bin/systemctl'

/**
 * What each cadence renders with NONE of the fire fields set — today's strings,
 * unchanged by snaptime.1. The first test below pins every one; the
 * byte-identical-timer test reads the same map rather than restating it.
 */
const NO_FIELD_ONCALENDAR: Record<SnapshotCadence, string> = {
  frequently: '*:0/15',
  hourly: 'hourly',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  yearly: 'yearly',
}

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
    for (const [cadence, oncal] of Object.entries(NO_FIELD_ONCALENDAR))
      assert.deepEqual(cadenceToOnCalendar({ cadence: cadence as SnapshotCadence }), [oncal])
  })

  it('the timer unit carries the translated OnCalendar and Persistent=true', () => {
    const timer = renderTimerUnit(makeSchedule({ cadence: 'weekly' }))
    assert.match(timer, /OnCalendar=weekly/)
    assert.match(timer, /Persistent=true/)
    assert.match(timer, /WantedBy=timers\.target/)
  })
})

describe('snapshot schedule units — the fire fields in OnCalendar (snaptime.1)', () => {
  it('renders the long form, each expression checked with systemd-analyze calendar on the node', () => {
    const rows: { schedule: SnapshotFireShape, expected: string[] }[] = [
      { schedule: { cadence: 'daily', time: '01:30' }, expected: ['*-*-* 01:30:00'] },
      { schedule: { cadence: 'weekly', weekday: 'Thu', time: '01:30' }, expected: ['Thu *-*-* 01:30:00'] },
      { schedule: { cadence: 'monthly', dayOfMonth: 15, time: '01:30' }, expected: ['*-*-15 01:30:00'] },
      { schedule: { cadence: 'yearly', time: '01:30' }, expected: ['*-01-01 01:30:00'] },
    ]
    for (const row of rows)
      assert.deepEqual(cadenceToOnCalendar(row.schedule), row.expected, JSON.stringify(row.schedule))
  })

  it('monthly day: 1-28 one line, 29 and 30 two (February last day), 31 the last-day form alone', () => {
    const rows: { schedule: SnapshotFireShape, expected: string[], why: string }[] = [
      { schedule: { cadence: 'monthly', dayOfMonth: 28, time: '01:30' }, expected: ['*-*-28 01:30:00'], why: 'every month has a 28th' },
      {
        schedule: { cadence: 'monthly', dayOfMonth: 29, time: '01:30' },
        expected: ['*-*-29 01:30:00', '*-02~01 01:30:00'],
        why: 'February 2027 has no 29th; its last day is the second line',
      },
      {
        schedule: { cadence: 'monthly', dayOfMonth: 30, time: '01:30' },
        expected: ['*-*-30 01:30:00', '*-02~01 01:30:00'],
        why: 'February has no 30th either',
      },
      {
        schedule: { cadence: 'monthly', dayOfMonth: 31, time: '01:30' },
        expected: ['*-*~01 01:30:00'],
        why: '*-*~01 is the last day of every month; *-*-31 would skip short months',
      },
    ]
    for (const row of rows)
      assert.deepEqual(cadenceToOnCalendar(row.schedule), row.expected, `${JSON.stringify(row.schedule)}: ${row.why}`)
  })

  it('yearly month and day: a day the month always has is spelled out, otherwise its last day', () => {
    const rows: { schedule: SnapshotFireShape, expected: string[], why: string }[] = [
      { schedule: { cadence: 'yearly', month: 6, dayOfMonth: 17, time: '01:30' }, expected: ['*-06-17 01:30:00'], why: 'June 17' },
      { schedule: { cadence: 'yearly', month: 6, dayOfMonth: 30, time: '01:30' }, expected: ['*-06-30 01:30:00'], why: 'June has a 30th' },
      { schedule: { cadence: 'yearly', month: 4, dayOfMonth: 31, time: '01:30' }, expected: ['*-04~01 01:30:00'], why: 'April has no 31st; fires on the 30th' },
      { schedule: { cadence: 'yearly', month: 2, dayOfMonth: 29, time: '01:30' }, expected: ['*-02~01 01:30:00'], why: 'February 29 is always the last day, leap years included' },
    ]
    for (const row of rows)
      assert.deepEqual(cadenceToOnCalendar(row.schedule), row.expected, `${JSON.stringify(row.schedule)}: ${row.why}`)
  })

  it('absent parts take their defaults (time 00:00, weekday Mon, day 1, month January), two-digit fields', () => {
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'weekly', weekday: 'Wed' }), ['Wed *-*-* 00:00:00'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'monthly', dayOfMonth: 28 }), ['*-*-28 00:00:00'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'monthly', dayOfMonth: 1, time: '03:00' }), ['*-*-01 03:00:00'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'monthly', dayOfMonth: 5 }), ['*-*-05 00:00:00'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'daily', time: '23:59' }), ['*-*-* 23:59:00'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'yearly' }), ['yearly'])
    // `month` alone is a fire field: it takes the long form with the day at 1.
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'yearly', month: 6 }), ['*-06-01 00:00:00'])
  })

  // Review of snaptime.1 (constructed): `dayOfMonth: '1\nExecStart=/bin/x'` in
  // memory rendered a forged directive line, and NaN / 1.5 / -1 / 0 / 13 /
  // '99:99' / 'Xyz' reached the timer file. RULE: every value bound for an
  // `OnCalendar=` line passes the schema's own fence inside the generator.
  it('the generator is a hard boundary: a corrupt fire field throws, whatever its type', () => {
    const corrupt: Record<string, unknown>[] = [
      { cadence: 'monthly', dayOfMonth: '1\nExecStart=/bin/x' },
      { cadence: 'monthly', dayOfMonth: Number.NaN },
      { cadence: 'monthly', dayOfMonth: 1.5 },
      { cadence: 'monthly', dayOfMonth: -1 },
      { cadence: 'monthly', dayOfMonth: 0 },
      { cadence: 'monthly', dayOfMonth: 32 },
      { cadence: 'yearly', month: 13 },
      { cadence: 'yearly', month: 0 },
      { cadence: 'yearly', month: '6\r' },
      { cadence: 'daily', time: '99:99' },
      { cadence: 'daily', time: '01:30\r' },
      { cadence: 'weekly', weekday: 'Xyz' },
      { cadence: 'weekly', weekday: 'Mon\nOnCalendar=*:*' },
    ]
    for (const c of corrupt) {
      assert.throws(() => cadenceToOnCalendar(c as never), /Snapshot schedule cannot fire: invalid/, JSON.stringify(c))
      assert.throws(() => renderTimerUnit(makeSchedule(c as never)), /Snapshot schedule cannot fire: invalid/, JSON.stringify(c))
    }
  })

  // Review of snaptime.1: a dialog that sends its pickers' visible defaults
  // must not rewrite a shortcut timer into an equivalent long form.
  it('a field at its default is the schedule without the field: shortcut word, and stored as absence', () => {
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'monthly', dayOfMonth: 1 }), ['monthly'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'weekly', weekday: 'Mon', time: '00:00' }), ['weekly'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'yearly', month: 1, dayOfMonth: 1, time: '00:00' }), ['yearly'])
    assert.deepEqual(cadenceToOnCalendar({ cadence: 'daily', time: '00:00' }), ['daily'])
    const plain = makeSchedule({ cadence: 'yearly' })
    const defaults = makeSchedule({ cadence: 'yearly', month: 1, dayOfMonth: 1, time: '00:00' })
    assert.equal(renderServiceUnit(defaults), renderServiceUnit(plain))
    assert.equal(renderTimerUnit(defaults), renderTimerUnit(plain))
    // One non-default part keeps the others at their defaults in the line, and only itself in the store.
    assert.match(renderServiceUnit(makeSchedule({ cadence: 'yearly', month: 1, dayOfMonth: 17 })), /"dayOfMonth":17/)
    assert.doesNotMatch(renderServiceUnit(makeSchedule({ cadence: 'yearly', month: 1, dayOfMonth: 17 })), /"month"/)
  })

  it('a monthly 30 timer has exactly two OnCalendar lines in order, and one Persistent=true', () => {
    const timer = renderTimerUnit(makeSchedule({ cadence: 'monthly', dayOfMonth: 30, time: '02:15' }))
    const lines = timer.split('\n').filter(line => line.startsWith('OnCalendar='))
    assert.deepEqual(lines, ['OnCalendar=*-*-30 02:15:00', 'OnCalendar=*-02~01 02:15:00'])
    assert.equal(timer.split('Persistent=true').length - 1, 1)
  })

  it('a schedule WITHOUT the fields renders today\'s timer byte-identically', () => {
    // No existing test carried the full timer text; the OnCalendar token is
    // lifted from the pinned map above (never retyped), the frame is the
    // renderer's fixed [Timer] block — so a drift in either half fails here.
    for (const cadence of Object.keys(NO_FIELD_ONCALENDAR) as SnapshotCadence[]) {
      const schedule = makeSchedule({ cadence })
      assert.equal(renderTimerUnit(schedule), [
        '[Unit]',
        `Description=ANAS snapshot timer ${schedule.name}`,
        '',
        '[Timer]',
        `OnCalendar=${NO_FIELD_ONCALENDAR[cadence]}`,
        'Persistent=true',
        '',
        '[Install]',
        'WantedBy=timers.target',
        '',
      ].join('\n'))
    }
  })

  it('render then parse round-trips the four fields through X-ANAS-Schedule', () => {
    for (const schedule of [
      makeSchedule({ cadence: 'daily', time: '01:30' }),
      makeSchedule({ cadence: 'weekly', weekday: 'Thu', time: '01:30' }),
      makeSchedule({ cadence: 'monthly', dayOfMonth: 31, time: '01:30' }),
      makeSchedule({ cadence: 'yearly', month: 6, dayOfMonth: 17, time: '23:59' }),
      makeSchedule({ cadence: 'yearly', time: '23:59' }),
    ]) {
      const parsed = parseServiceUnit(renderServiceUnit(schedule))
      assert.deepEqual(parsed, schedule)
      // The street-level check the deep equal can hide: the MONTH came back.
      assert.equal(parsed?.month, schedule.month)
    }
  })

  it('a CLEARED field (null) is stored as absence, never as null', () => {
    // A PUT clearing `time` hands the writer `time: null`; the stored JSON holds
    // no key at all and the timer is back to the shortcut word.
    const cleared = makeSchedule({ cadence: 'hourly', time: null })
    const unit = renderServiceUnit(cleared)
    assert.doesNotMatch(unit, /"time"/)
    assert.equal(parseServiceUnit(unit)?.time, undefined)
    assert.match(renderTimerUnit(cleared), /OnCalendar=hourly/)
  })

  it('fail loud: a field the cadence refuses throws before any write', () => {
    assert.throws(
      () => cadenceToOnCalendar({ cadence: 'hourly', time: '01:30' }),
      /An hourly schedule has no time of day — it fires every hour/,
    )
    assert.throws(
      () => cadenceToOnCalendar({ cadence: 'daily', weekday: 'Mon' }),
      /Weekday applies to a weekly schedule only/,
    )
    assert.throws(
      () => cadenceToOnCalendar({ cadence: 'weekly', dayOfMonth: 15 }),
      /Day of the month applies to a monthly or yearly schedule only/,
    )
    // A control character in a field never reaches the unit line (cr.51).
    assert.throws(() => cadenceToOnCalendar({ cadence: 'daily', time: '01:30\nRestart=always' }), /invalid time/)
    // An unknown cadence still throws first, before any field rule.
    assert.throws(() => cadenceToOnCalendar({ cadence: 'bogus' as SnapshotCadence, time: '01:30' }), /Unknown snapshot cadence/)
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

  it('snapx.1: exclude round-trips through X-ANAS-Schedule; a unit without it is unchanged', () => {
    const excluding = makeSchedule({ recursive: true, exclude: ['tank/media/scratch', 'tank/media/vm-100-disk-0'] })
    const unit = renderServiceUnit(excluding)
    assert.match(unit, /"exclude":\["tank\/media\/scratch","tank\/media\/vm-100-disk-0"\]/)
    assert.deepEqual(parseServiceUnit(unit), excluding)
    // Every existing schedule renders byte-identically: no `exclude` key appears.
    assert.doesNotMatch(renderServiceUnit(makeSchedule({ recursive: true })), /exclude/)
    // A hand-edited unit whose exclude breaks the shared rules does not parse.
    const bad = renderServiceUnit(excluding).replace('"recursive":true', '"recursive":false')
    assert.equal(parseServiceUnit(bad), null)
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

  // snaptime.1: an EDIT of the fire time must never fire a snapshot. The store
  // does `daemon-reload` then `enable --now`; ground truth on the node
  // (2026-11-13) says that leaves an active timer running and moves its next
  // elapse, while a RESTART would fire a past-due time at once. Pinned on argv.
  it('snaptime.1: an edit of `time` on an enabled schedule reloads and enables — never restarts or stops', async () => {
    const edited = makeSchedule({ cadence: 'daily', time: '01:30' })
    await writeScheduleUnits(mock, dir, edited)
    assert.deepEqual(mock.calls.map(c => c.args.join(' ')), [
      'daemon-reload',
      `enable --now ${timerUnitName(edited.id)}`,
    ])
    assert.ok(!mock.calls.some(c => c.args.includes('restart') || c.args.includes('stop')))
    assert.match(await readFile(join(dir, timerUnitName(edited.id)), 'utf-8'), /OnCalendar=\*-\*-\* 01:30:00/)
  })

  it('writeScheduleUnits with enabled=false disables the timer', async () => {
    await writeScheduleUnits(mock, dir, makeSchedule({ enabled: false }))
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`disable --now ${timerUnitName('nightly-tank-media')}`))
    assert.ok(!cmds.some(c => c.startsWith('enable ')))
  })

  it('removeScheduleUnits deletes both files, the stamp, resets failed; leaves others', async () => {
    // SCHEDULES-GT-17 (review D2): the store renders `Persistent=true`, so a
    // leftover stamp makes the schedule's re-creation fire at once — the stamp
    // and the failed-state ghost go down with the units, exactly like the task
    // stores' removal.
    await withStampDir(async (stampDir) => {
      await writeScheduleUnits(mock, dir, makeSchedule())
      await writeFile(join(stampDir, `stamp-${timerUnitName('nightly-tank-media')}`), '')
      // Another schedule's stamp — one removal must not reach past its own id.
      await writeFile(join(stampDir, 'stamp-anas-snap-other.timer'), '')
      await writeFile(join(dir, 'keep.txt'), 'x')
      assert.equal(await scheduleFileExists(dir, 'nightly-tank-media'), true)
      await removeScheduleUnits(mock, dir, 'nightly-tank-media')
      assert.deepEqual(await readdir(dir), ['keep.txt'])
      assert.deepEqual(await readdir(stampDir), ['stamp-anas-snap-other.timer'])
      assert.equal(snapshotStampPath('nightly-tank-media'), `${stampDir}/stamp-${timerUnitName('nightly-tank-media')}`)
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes(`disable --now ${timerUnitName('nightly-tank-media')}`))
      // ONE unit per reset-failed call (review R2) — service, then timer.
      assert.ok(cmds.includes(`reset-failed ${serviceUnitName('nightly-tank-media')}`))
      assert.ok(cmds.includes(`reset-failed ${timerUnitName('nightly-tank-media')}`))
      assert.ok(cmds.includes('daemon-reload'))
      assert.equal(await scheduleFileExists(dir, 'nightly-tank-media'), false)
    })
  })

  // cr.51 / review C1: the reviewer ran `POST /v1/schedules` with
  // name = "x\n[Service]\nExecStartPre=/bin/touch /root/pwned" and the written
  // unit carried the injected directive (systemd merges repeated [Service]
  // sections) — root code execution when the timer first fires. The schema now
  // refuses it at the route; this proves the WRITER is a hard boundary too.
  it('an injected name throws from both renderers and NOTHING is written', async () => {
    const evil = makeSchedule({ name: 'x\n[Service]\nExecStartPre=/bin/touch /root/pwned' })
    assert.throws(() => renderServiceUnit(evil), /control characters/)
    assert.throws(() => renderTimerUnit(evil), /control characters/)
    await assert.rejects(() => writeScheduleUnits(mock, dir, evil), /control characters/)
    assert.deepEqual(await readdir(dir), [])
    // Not one systemctl call either — the refusal precedes every side effect.
    assert.deepEqual(mock.calls, [])
    // NUL truncates a unit line in C-land — refused too, as in the schemas.
    const nul = makeSchedule({ name: 'x\0y' })
    assert.throws(() => renderServiceUnit(nul), /control characters/)
    // A CR alone (line-ending spoof) is refused as well.
    const cr = makeSchedule({ name: 'x\ry' })
    assert.throws(() => renderTimerUnit(cr), /control characters/)
  })

  // cr.51r (review doc-drift): the test above cannot fail on the render-both
  // hoist — the name is refused by BOTH renderers, so the service renderer
  // throws first either way. This is the input that makes the hoist testable:
  // the service renderer ACCEPTS it (clean name, clean id) and only the timer
  // renderer refuses. With the hoist nothing is written; without it (the
  // pre-cr.51 shape — write the service, then render the timer) a service
  // file with no timer beside it is left on disk.
  it('cr.51r: a cadence only the timer renderer refuses leaves no service file', async () => {
    const evil = makeSchedule({ cadence: 'bogus' as SnapshotCadence })
    assert.doesNotThrow(() => renderServiceUnit(evil))
    assert.throws(() => renderTimerUnit(evil), /Unknown snapshot cadence/)
    await assert.rejects(() => writeScheduleUnits(mock, dir, evil), /Unknown snapshot cadence/)
    assert.deepEqual(await readdir(dir), [])
    assert.deepEqual(mock.calls, [])
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

  it('readScheduleList says whether the list is COMPLETE (snapprune.1 review)', async () => {
    await writeScheduleUnits(mock, dir, makeSchedule({ id: 'one' }))
    const whole = await readScheduleList(dir)
    assert.equal(whole.complete, true)
    assert.deepEqual(whole.schedules.map(s => s.id), ['one'])
    // An unparseable unit: the valid ones are kept, the list is not whole.
    await writeFile(join(dir, serviceUnitName('broken')), '[Unit]\nDescription=broken\n')
    const partial = await readScheduleList(dir)
    assert.equal(partial.complete, false)
    assert.deepEqual(partial.schedules.map(s => s.id), ['one'])
    // An unlistable dir is not an empty store.
    assert.deepEqual(await readScheduleList(join(dir, 'does-not-exist')), { schedules: [], complete: false, unparseable: [] })
  })

  // cr.51r (review possible 1): the C1 proof's poisoned unit — written by a
  // pre-cr.51 build, marker JSON that fails the SingleLine fence — was
  // INVISIBLE: the list 404'd it, only a stderr line said so, and its timer
  // kept firing ExecStartPre as root. It must now be collected and named.
  it('cr.51r: the poisoned unit from the C1 proof is surfaced, not silently skipped', async () => {
    await writeScheduleUnits(mock, dir, makeSchedule({ id: 'one' }))
    const evil = makeSchedule({ id: 'evil', name: 'x\n[Service]\nExecStartPre=/bin/touch /root/pwned' })
    // Byte-for-byte what the vulnerable build's renderServiceUnit produced
    // (the cr.51 review probe, cr51-probe.test.ts Q2-migration): the raw
    // newline in Description= forged the [Service]/ExecStartPre lines, and the
    // marker JSON — control characters escaped onto one line — parses but
    // fails the schema.
    const svc = [
      '[Unit]',
      `Description=ANAS snapshot schedule ${evil.name}`,
      `# X-ANAS-Schedule=${JSON.stringify(evil)}`,
      '',
      '[Service]',
      'Type=oneshot',
      'Environment=TZ=UTC',
      'ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/snapshot-task.js --id evil',
      '',
    ].join('\n')
    await writeFile(join(dir, serviceUnitName('evil')), svc)
    const read = await readScheduleList(dir)
    assert.deepEqual(read.schedules.map(s => s.id), ['one'])
    assert.equal(read.complete, false)
    assert.deepEqual(read.unparseable, [{ file: 'anas-snap-evil.service', reason: 'its X-ANAS-Schedule JSON does not parse or validate' }])
    // The dashboard card names the file, the reason, and the way out.
    const cards = buildUnparseableScheduleWarnings(read.unparseable)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].level, 'warning')
    assert.equal(cards[0].category, 'schedule')
    assert.equal(cards[0].message, 'Schedule unit anas-snap-evil.service could not be read (its X-ANAS-Schedule JSON does not parse or validate); its timer may still fire. Delete it from the Schedules view or by hand')
  })

  it('cr.51r: a unit with no marker and a unit whose marker id contradicts the file are both surfaced', async () => {
    await writeFile(join(dir, serviceUnitName('nomarker')), '[Unit]\nDescription=broken\n')
    // A readable marker naming an id the file contradicts: neither the parsed
    // list nor a delete-by-id can be trusted to own this unit, so it is not
    // adopted — it is named.
    await writeFile(join(dir, serviceUnitName('mismatch')), `# X-ANAS-Schedule=${JSON.stringify(makeSchedule({ id: 'other' }))}\n`)
    const read = await readScheduleList(dir)
    assert.deepEqual(read.schedules, [])
    assert.equal(read.complete, false)
    const byFile = new Map(read.unparseable.map(u => [u.file, u.reason]))
    assert.equal(byFile.get('anas-snap-nomarker.service'), 'no X-ANAS-Schedule marker')
    assert.equal(byFile.get('anas-snap-mismatch.service'), 'its X-ANAS-Schedule id \'other\' does not match the file name')
  })
})

describe('snapshot schedule units — status derivation + dashboard warnings', () => {
  function statusMock(opts: { active?: string, result?: string, exitTs?: string, nextTs?: string, journal?: string, lastTrigger?: string }): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', serviceUnitName('nightly-tank-media'), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'],
      result: { stdout: `ActiveState=${opts.active ?? 'inactive'}\nResult=${opts.result ?? 'success'}\nExecMainStatus=0\nExecMainExitTimestamp=${opts.exitTs ?? ''}\nInactiveEnterTimestamp=\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['show', timerUnitName('nightly-tank-media'), '-p', 'NextElapseUSecRealtime,LastTriggerUSec'],
      result: { stdout: `NextElapseUSecRealtime=${opts.nextTs ?? '0'}\nLastTriggerUSec=${opts.lastTrigger ?? ''}\n`, stderr: '', exitCode: 0 },
    })
    if (opts.journal !== undefined) {
      mock.addFixture({
        command: '/usr/bin/journalctl',
        args: ['-u', serviceUnitName('nightly-tank-media'), '-n', '200', '-o', 'short-iso', '--no-pager'],
        result: { stdout: opts.journal, stderr: '', exitCode: 0 },
      })
    }
    return mock
  }

  // taskstatus.1 wiring — the precedence is proven in unit-run-status.test.ts.
  it('after a reboot the runner\'s journal line answers, and no default exit code is shown', async () => {
    const journal = '2026-10-05T02:00:04+0000 pve anas-snap-nightly-tank-media[904]: {"schedule":"nightly-tank-media","result":{"schedule":"nightly-tank-media","taken":"anas-daily-20261005T020000Z","pruned":[],"skippedHeld":[]}}'
    const st = await deriveScheduleStatus(statusMock({ result: 'success', exitTs: '', journal }), makeSchedule({ enabled: true }))
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.lastRunAt, '2026-10-05T02:00:04.000Z')
    const detail = await deriveScheduleDetail(statusMock({ result: 'success', exitTs: '', journal }), join(tmpdir(), 'anas-no-such-unit-dir'), makeSchedule({ enabled: true }))
    assert.equal(detail.lastRunResult, 'success')
    assert.equal(detail.lastRunExitCode, null)
    assert.equal(detail.journal, journal)
  })

  it('after a reboot with only the timer stamp left → unknown with the note', async () => {
    const st = await deriveScheduleStatus(statusMock({ result: 'success', exitTs: '', journal: '', lastTrigger: 'Mon 2026-10-05 02:00:00 UTC' }), makeSchedule({ enabled: true }))
    assert.equal(st.lastRunResult, 'unknown')
    assert.equal(st.lastRunAt, '2026-10-05T02:00:00.000Z')
    assert.equal(st.lastRunNote, 'ran at 2026-10-05 02:00 UTC; result not retained across the reboot')
  })

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
    // The same shape while ENABLED is the never-run twin: the timer keeps the
    // unit loaded, so empty timestamps mean it has never fired — the
    // default-valued `Result=success` is a run that never happened.
    const on = await deriveScheduleStatus(statusMock({ result: 'success', exitTs: '' }), makeSchedule({ enabled: true }))
    assert.equal(on.lastRunResult, 'never-run')
    assert.equal(on.lastRunAt, null)
  })

  it('an ENABLED schedule that HAS run keeps its real result — its history is retained', async () => {
    const st = await deriveScheduleStatus(statusMock({ result: 'success', exitTs: 'Sun 2026-07-26 00:00:00 UTC' }), makeSchedule({ enabled: true }))
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.lastRunAt, '2026-07-26T00:00:00.000Z')
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
