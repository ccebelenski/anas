import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ReplicationTask } from '../schemas/replication.js'

/**
 * The recurring replication task CONTRACT. Like the cloud task, this shape is
 * what rides the `X-ANAS-Task=` line in the unit file, so a field that loosens
 * here loosens every stored task's meaning.
 */
describe('ReplicationTask', () => {
  const MINIMAL = {
    name: 'nightly',
    source: { pool: 'tank', dataset: 'media' },
    target: { pool: 'backup' },
    schedule: 'daily',
  }

  it('the schedule is SingleLine: one line, no control characters (cr.17, backup parity from cr.9)', () => {
    for (const schedule of ['weekly', 'Mon *-*-* 03:00', '02:00'])
      assert.ok(ReplicationTask.safeParse({ ...MINIMAL, schedule }).success, schedule)
    // A newline in OnCalendar is a second unit-file line waiting to happen.
    for (const schedule of ['daily\nExecStart=/bin/sh', '02:00\n04:00', 'a\u0000b', '\tdaily', ''])
      assert.equal(ReplicationTask.safeParse({ ...MINIMAL, schedule }).success, false, JSON.stringify(schedule))
  })
})
