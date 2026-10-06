import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BackupRunResult } from '../schemas/backup.js'
import { ReplicationTaskStatus } from '../schemas/replication.js'
import { ScheduleRunResult, SnapshotScheduleDetail, SnapshotScheduleStatus } from '../schemas/schedules.js'

/**
 * taskstatus.1: a run known only from the timer's stamp after a reboot reads
 * `lastRunResult: 'unknown'` with a `lastRunNote`. Every run-result enum
 * already carries `unknown`; the note is ADDITIVE on the schedule and
 * replication rows (backup and cloud carried it since rclone.5), so a payload
 * from an older daemon without it still parses.
 */
const NOTE = 'ran at 2026-10-05 02:00 UTC; result not retained across the reboot'
const SCHEDULE = {
  id: 'hourly-tank',
  name: 'Hourly tank',
  target: { kind: 'zfs', dataset: 'tank' },
  cadence: 'hourly',
  retention: { hourly: 1 },
  enabled: true,
}

describe('run status — the not-retained verdict parses on every row', () => {
  it('`unknown` is a member of every run-result vocabulary', () => {
    assert.equal(BackupRunResult.safeParse('unknown').success, true)
    assert.equal(ScheduleRunResult.safeParse('unknown').success, true)
  })

  it('a schedule status/detail carries the note, and parses without it', () => {
    const status = { schedule: SCHEDULE, lastRunResult: 'unknown', lastRunAt: '2026-10-05T02:00:00.000Z', nextRunAt: null, overdue: false }
    assert.equal(SnapshotScheduleStatus.parse({ ...status, lastRunNote: NOTE }).lastRunNote, NOTE)
    assert.equal(SnapshotScheduleStatus.parse(status).lastRunNote, undefined)
    const detail = { ...status, lastRunExitCode: null, unit: '', timer: '', lastRunNote: NOTE }
    assert.equal(SnapshotScheduleDetail.parse(detail).lastRunNote, NOTE)
  })

  it('a replication status carries the note, and parses without it', () => {
    const status = {
      task: {
        name: 'nightly-media',
        source: { pool: 'tank', dataset: 'media' },
        target: { pool: 'backup', dataset: 'media' },
        schedule: 'daily',
        enabled: true,
      },
      lastReplicatedSnapshot: null,
      lastReplicatedAt: null,
      snapshotsBehind: null,
      lastRunResult: 'unknown',
      nextRunAt: null,
    }
    const parsed = ReplicationTaskStatus.safeParse({ ...status, lastRunNote: NOTE })
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues))
    assert.equal(parsed.success && parsed.data.lastRunNote, NOTE)
    assert.equal(ReplicationTaskStatus.safeParse(status).success, true)
  })
})
