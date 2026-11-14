import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapshotSchedule } from '@anas/shared'
import { parseServiceUnit, renderServiceUnit, renderTimerUnit, unitDescriptionText } from '../snapshot-schedule-units.js'

/**
 * cr3 DATASETS-SCHEDULES-L8: the schedule name lands in `Description=` of
 * both units. systemd expands `%` specifiers there and a line ending in an
 * odd run of backslashes continues onto the next one. Settled with
 * `systemd-analyze verify` (systemd 262): `100%n` rendered as
 * `100anas-snap-pct.service`, `%%` as `%`; `x\` swallowed the marker line
 * below it; `x\\` is not a continuation.
 */
const schedule = (name: string) => SnapshotSchedule.parse({ id: 'pct', name, target: { kind: 'zfs', dataset: 'tank/a' }, cadence: 'daily', retention: { daily: 7 }, enabled: true })
const description = (unit: string) => unit.split('\n').find(l => l.startsWith('Description='))!

describe('cr3 L8: the schedule name in Description=', () => {
  it('escapes % as %%', () => {
    assert.equal(unitDescriptionText('100%n daily %H'), '100%%n daily %%H')
    assert.equal(description(renderServiceUnit(schedule('100%n'))), 'Description=ANAS snapshot schedule 100%%n')
    assert.equal(description(renderTimerUnit(schedule('100%n'))), 'Description=ANAS snapshot timer 100%%n')
  })

  it('never ends the line in an odd run of backslashes', () => {
    assert.equal(unitDescriptionText('trailing \\'), 'trailing \\\\')
    assert.equal(unitDescriptionText('two \\\\'), 'two \\\\')
    assert.equal(unitDescriptionText('mid\\dle'), 'mid\\dle')
    const line = description(renderServiceUnit(schedule('back\\')))
    assert.match(line, /(?:^|[^\\])(?:\\\\)+$/, line)
  })

  it('the stored schedule keeps the name exactly as typed', () => {
    for (const name of ['100%n daily %H', 'trailing \\', 'plain'])
      assert.equal(parseServiceUnit(renderServiceUnit(schedule(name)))?.name, name)
  })

  it('a name without % or a trailing backslash renders byte-identically to before', () => {
    assert.equal(description(renderServiceUnit(schedule('Nightly media'))), 'Description=ANAS snapshot schedule Nightly media')
  })
})

describe('cr3 INVENTED-STATE-H1: the dashboard schedule collector never answers [] for a read that failed', () => {
  it('a unit directory that cannot be listed throws (the section is marked unavailable)', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { MockExecutor } = await import('../../executor/mock.js')
    const { collectScheduleWarnings } = await import('../snapshot-schedule-units.js')
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-units-'))
    try {
      // A FILE where the directory should be: readdir fails ENOTDIR.
      const notDir = join(dir, 'not-a-dir')
      await writeFile(notDir, '')
      await assert.rejects(collectScheduleWarnings(new MockExecutor(), notDir), /could not be listed/)
      // An ABSENT directory holds no unit: no warning, no throw.
      assert.deepEqual(await collectScheduleWarnings(new MockExecutor(), join(dir, 'absent')), [])
      // A readable empty one: no warning.
      assert.deepEqual(await collectScheduleWarnings(new MockExecutor(), dir), [])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
