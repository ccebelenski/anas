import type { CloudSyncRunResult, CloudSyncTask } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BACKUP_SKIPPED_OFF_WEEK, CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildCloudNotifyBody,
  cloudConsistencyLine,
  cloudNotifyOutcome,
  cloudNotifySeverity,
  cloudNotifyTitle,
  cloudRouteLine,
  notifyCloudRun,
  shouldNotifyCloud,
} from '../cloud-notify.js'

/**
 * Cloud sync run notifications (rclone.2). The gate and the severity map are
 * the SHARED ones (unattended-notify.ts) — what is proved here is this family's
 * body, its title, and the two rules that are easy to get wrong: a skip is
 * silent in BOTH modes, and delivery never fails the run.
 */

const TASK: CloudSyncTask = CloudSyncTaskSchema.parse({
  name: 'offsite',
  source: '/tank/pictures',
  remote: 'backblaze',
  path: 'pve1/pictures',
  schedule: 'Tue *-*-* 02:00:00',
})

const RESULT: CloudSyncRunResult = {
  status: 'success',
  mode: 'copy',
  consistency: { consistency: 'snapshot', reason: '/tank/pictures is on the ZFS dataset tank/pictures', backend: 'zfs', target: 'tank/pictures' },
  source: '/tank/pictures/.zfs/snapshot/anas-cloud-offsite-1700000000',
  destination: 'backblaze:pve1/pictures',
  snapshot: 'tank/pictures@anas-cloud-offsite-1700000000',
  bytes: 4194304,
  totalBytes: 4194304,
  transfers: 5,
  checks: 12,
  deletes: 0,
  errors: 0,
  elapsed: 61.2,
  countersReported: true,
  errorLines: [],
}

describe('cloud sync notifications (rclone.2)', () => {
  describe('outcome + gate', () => {
    it('an error is a failure, warnings are a warning, otherwise a success', () => {
      assert.equal(cloudNotifyOutcome({ task: TASK, error: 'boom' }), 'failure')
      assert.equal(cloudNotifyOutcome({ task: TASK, result: { ...RESULT, warnings: ['a snapshot outlived its finally'] } }), 'warning')
      assert.equal(cloudNotifyOutcome({ task: TASK, result: RESULT }), 'success')
    })

    it('a deliberate off-week skip is its OWN outcome, and is silent in both modes', () => {
      const skip = cloudNotifyOutcome({ task: TASK, result: { ...RESULT, status: BACKUP_SKIPPED_OFF_WEEK } })
      assert.equal(skip, 'skip')
      assert.equal(shouldNotifyCloud('always', 'skip'), false)
      assert.equal(shouldNotifyCloud('on-failure', 'skip'), false)
    })

    it('the two-mode gate is the shared one', () => {
      assert.equal(shouldNotifyCloud('always', 'success'), true)
      assert.equal(shouldNotifyCloud('on-failure', 'success'), false)
      assert.equal(shouldNotifyCloud('on-failure', 'warning'), true)
      assert.equal(shouldNotifyCloud('on-failure', 'failure'), true)
    })

    it('severity is not decoration — PVE routes on it', () => {
      assert.equal(cloudNotifySeverity('failure'), 'error')
      assert.equal(cloudNotifySeverity('warning'), 'warning')
      assert.equal(cloudNotifySeverity('success'), 'info')
    })

    it('titles name the task and the outcome', () => {
      assert.equal(cloudNotifyTitle(TASK, 'failure'), 'cloud sync \'offsite\' FAILED')
      assert.equal(cloudNotifyTitle(TASK, 'warning'), 'cloud sync \'offsite\' completed with warnings')
      assert.equal(cloudNotifyTitle(TASK, 'success'), 'cloud sync \'offsite\' succeeded')
    })
  })

  describe('the route and consistency lines', () => {
    it('states the whole route, never truncated', () => {
      assert.equal(cloudRouteLine({ task: TASK, result: RESULT }), '/tank/pictures -> backblaze:pve1/pictures')
    })

    it('falls back to the task config when the run never produced a result', () => {
      assert.equal(cloudRouteLine({ task: TASK, error: 'boom' }), '/tank/pictures -> backblaze:pve1/pictures')
    })

    it('names the snapshot the run read, or says live', () => {
      assert.equal(cloudConsistencyLine({ task: TASK, result: RESULT }), 'snapshot tank/pictures@anas-cloud-offsite-1700000000')
      assert.equal(
        cloudConsistencyLine({
          task: TASK,
          result: { ...RESULT, snapshot: undefined, consistency: { consistency: 'live', reason: 'on ext4' } },
        }),
        'live',
      )
      assert.equal(cloudConsistencyLine({ task: TASK, error: 'boom' }), null)
    })
  })

  describe('the body', () => {
    it('carries the task, the route, the mode, the consistency and every counter', () => {
      const body = buildCloudNotifyBody({ task: TASK, result: RESULT, elapsedMs: 62_000 })
      assert.match(body, /^Task: +offsite$/m)
      assert.match(body, /^Route: +\/tank\/pictures -> backblaze:pve1\/pictures$/m)
      assert.match(body, /^Mode: +copy$/m)
      assert.match(body, /^Result: +success$/m)
      assert.match(body, /^Consistency: snapshot tank\/pictures@anas-cloud-offsite-1700000000$/m)
      // rclone's OWN elapsed wins over the job's wall clock when it reported one.
      assert.match(body, /^Duration: +61\.2s \(rclone\)$/m)
      assert.match(body, /^ {2}bytes: +4194304 of 4194304$/m)
      assert.match(body, /^ {2}files: +5$/m)
      assert.match(body, /^ {2}checked: +12$/m)
      assert.match(body, /^ {2}deleted: +0$/m)
      assert.match(body, /^ {2}errors: +0$/m)
      assert.match(body, /^Schedule: +Tue \*-\*-\* 02:00:00$/m)
    })

    it('falls back to the job clock when rclone reported no elapsed time', () => {
      const body = buildCloudNotifyBody({ task: TASK, result: { ...RESULT, elapsed: 0 }, elapsedMs: 62_000 })
      assert.match(body, /^Duration: +1m 2s \(job elapsed\)$/m)
    })

    it('a run rclone printed NO stats for says so instead of quoting silent zeros', () => {
      // rclone prints its first stats object at the first --stats interval; a
      // sub-second run prints none, and its counters are zeros rclone never
      // said (review 2026-09-24, item 10).
      const body = buildCloudNotifyBody({ task: TASK, result: { ...RESULT, elapsed: 0, countersReported: false } })
      assert.match(body, /^Transferred:\n {2}rclone reported no counters$/m)
      assert.ok(!body.includes('bytes:'), `no zero counters quoted:\n${body}`)
    })

    it('lists the nested filesystems the run did NOT include', () => {
      const body = buildCloudNotifyBody({ task: TASK, result: { ...RESULT, nested: ['/tank/pictures/raw'] } })
      assert.match(body, /^Nested filesystems NOT included:\n {2}\/tank\/pictures\/raw$/m)
    })

    it('carries rclone\'s error lines and the job\'s error on a failure', () => {
      const body = buildCloudNotifyBody({
        task: TASK,
        result: { ...RESULT, errors: 1, errorLines: ['a.jpg: Failed to copy: permission denied'] },
        error: 'rclone copy failed (exit 6)',
        elapsedMs: 1000,
      })
      assert.match(body, /^Result: +FAILED$/m)
      assert.match(body, /^rclone errors:\n {2}a\.jpg: Failed to copy: permission denied$/m)
      assert.match(body, /^Error:\n {2}rclone copy failed \(exit 6\)$/m)
    })

    it('says so when the task is disabled', () => {
      const body = buildCloudNotifyBody({ task: { ...TASK, enabled: false }, result: RESULT })
      assert.match(body, /\(task disabled\)$/m)
    })

    it('is ASCII ONLY — the mojibake rule every notify builder follows', () => {
      const body = buildCloudNotifyBody({
        task: TASK,
        result: { ...RESULT, warnings: ['a warning'], nested: ['/x'], errorLines: ['an error'] },
        error: 'and the failure',
        elapsedMs: 5,
      })
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[^\x00-\x7F]/.test(body), body)
    })
  })

  describe('emission', () => {
    function perlCalls(mock: MockExecutor) {
      return mock.calls.filter(c => c.command === '/usr/bin/perl')
    }

    it('emits through the anas-cloud template with the severity and body', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
      await notifyCloudRun(mock, { task: TASK, result: RESULT })
      const call = perlCalls(mock)[0]
      assert.ok(call, 'one perl invocation')
      assert.match(call.args[1], /'anas-cloud'/, 'the template name is the cloud one')
      assert.match(call.args[1], /type => 'anas-cloud'/, 'so a matcher rule can target cloud runs')
      assert.equal(call.args[2], 'info')
      assert.equal(call.args[3], 'cloud sync \'offsite\' succeeded')
      assert.match(call.args[4], /^Task: {8}offsite$/m)
    })

    it('an on-failure task stays silent on a success', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
      await notifyCloudRun(mock, { task: { ...TASK, notify: 'on-failure' }, result: RESULT })
      assert.deepEqual(perlCalls(mock), [])
    })

    it('a skip notifies in neither mode', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
      await notifyCloudRun(mock, { task: TASK, result: { ...RESULT, status: BACKUP_SKIPPED_OFF_WEEK } })
      assert.deepEqual(perlCalls(mock), [])
    })

    it('a delivery failure NEVER fails the run', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: 'no target configured', exitCode: 1 } })
      await notifyCloudRun(mock, { task: TASK, error: 'boom' })
      assert.equal(perlCalls(mock).length, 1, 'it tried, and swallowed the failure')
    })
  })
})
