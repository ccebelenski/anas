import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CloudSyncPreviewRequest, CloudSyncPreviewResult, CloudSyncPreviewTask, CloudSyncTask, CloudSyncTaskRequest } from '../schemas/cloud.js'

/**
 * The cloud sync task CONTRACT (rclone.2). The shape is what rides the
 * `X-ANAS-Task=` line in the unit file, so a default that changes here
 * silently changes what every stored task means.
 */
describe('CloudSyncTask (rclone.2)', () => {
  const MINIMAL = {
    name: 'offsite',
    source: '/tank/pictures',
    remote: 'backblaze',
    schedule: 'Tue *-*-* 02:00:00',
  }

  it('defaults: copy mode, no excludes, an empty remote path, notify always, enabled', () => {
    const task = CloudSyncTask.parse(MINIMAL)
    assert.deepEqual(task, {
      name: 'offsite',
      source: '/tank/pictures',
      remote: 'backblaze',
      path: '',
      mode: 'copy',
      excludes: [],
      notify: 'always',
      schedule: 'Tue *-*-* 02:00:00',
      enabled: true,
    })
  })

  it('the name follows the backup task rule (lowercase, digits, dashes)', () => {
    assert.ok(CloudSyncTask.safeParse({ ...MINIMAL, name: 'off-site-2' }).success)
    for (const name of ['Offsite', 'off site', '-lead', '', 'a'.repeat(65)])
      assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, name }).success, false, name)
  })

  it('the source must be absolute and free of traversal', () => {
    assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, source: 'relative' }).success, false)
    assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, source: '/tank/../etc' }).success, false)
  })

  it('the remote name stays a clean identifier (it builds env var names)', () => {
    assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, remote: 'has:colon' }).success, false)
    assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, remote: 'has space' }).success, false)
  })

  it('mode is copy or sync — nothing else, and two-way is not a mode', () => {
    assert.ok(CloudSyncTask.safeParse({ ...MINIMAL, mode: 'sync' }).success)
    assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, mode: 'bisync' }).success, false)
  })

  it('bwlimit is validated LOOSELY: a rate, optionally K/M/G', () => {
    for (const bwlimit of ['8M', '512', '1G', '100k'])
      assert.ok(CloudSyncTask.safeParse({ ...MINIMAL, bwlimit }).success, bwlimit)
    for (const bwlimit of ['fast', '8MB', '8 M', '-1'])
      assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, bwlimit }).success, false, bwlimit)
  })

  it('the remote path: control characters and padding refused; a leading / stays allowed', () => {
    assert.ok(CloudSyncTask.safeParse({ ...MINIMAL, path: 'pve1/pictures' }).success)
    assert.ok(CloudSyncTask.safeParse({ ...MINIMAL, path: '' }).success, 'empty is the remote root')
    assert.ok(
      CloudSyncTask.safeParse({ ...MINIMAL, path: '/abs/on/remote' }).success,
      'on sftp a leading / is the remote\'s own absolute root',
    )
    for (const path of ['pve1/pictures\n', 'x\u0000b', 'a\u001Fb', ' padded', 'padded ', '\tpve1'])
      assert.equal(CloudSyncTask.safeParse({ ...MINIMAL, path }).success, false, JSON.stringify(path))
  })
})

describe('CloudSyncTaskRequest (rclone.2)', () => {
  const MINIMAL = {
    name: 'offsite',
    source: '/tank/pictures',
    remote: 'backblaze',
    schedule: 'Mon *-*-* 09:00:00',
  }

  it('a cadence GENERATES the schedule, overwriting whatever the client sent', () => {
    const task = CloudSyncTaskRequest.parse({
      ...MINIMAL,
      cadence: { kind: 'weekly', days: ['Thu', 'Tue'], time: '03:30' },
    })
    assert.equal(task.schedule, 'Tue,Thu 03:30', 'the cadence is authoritative, and days come back in ISO order')
  })

  it('a biweekly cadence generates a WEEKLY expression (the parity gate skips off weeks)', () => {
    const task = CloudSyncTaskRequest.parse({
      ...MINIMAL,
      cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'even' },
    })
    assert.equal(task.schedule, 'Tue 02:00')
  })

  it('a custom cadence leaves the raw schedule untouched', () => {
    const task = CloudSyncTaskRequest.parse({ ...MINIMAL, cadence: { kind: 'custom' } })
    assert.equal(task.schedule, 'Mon *-*-* 09:00:00')
  })

  it('an invalid cadence reports the CADENCE problem, not a schedule one', () => {
    const parsed = CloudSyncTaskRequest.safeParse({
      ...MINIMAL,
      cadence: { kind: 'biweekly', days: ['Tue'], time: '02:00' },
    })
    assert.equal(parsed.success, false)
    assert.match(parsed.error!.issues[0].message, /parity/)
  })

  it('an empty bandwidth limit normalizes to ABSENT, never a stored ""', () => {
    assert.equal(CloudSyncTaskRequest.parse({ ...MINIMAL, bwlimit: '' }).bwlimit, undefined)
    assert.equal(CloudSyncTaskRequest.parse({ ...MINIMAL, bwlimit: null }).bwlimit, undefined)
    assert.equal(CloudSyncTaskRequest.parse({ ...MINIMAL, bwlimit: '8M' }).bwlimit, '8M')
  })
})

describe('CloudSyncPreviewRequest / CloudSyncPreviewResult (rclone.2 addendum)', () => {
  const INLINE = {
    source: '/tank/pictures',
    remote: 'backblaze',
    path: 'pve1/pictures',
  }

  it('the saved-task arm takes a name alone', () => {
    const parsed = CloudSyncPreviewRequest.parse({ name: 'offsite' })
    assert.deepEqual(parsed, { name: 'offsite' })
  })

  it('the inline arm takes the task fields, with the task defaults and no management fields', () => {
    const parsed = CloudSyncPreviewTask.parse(INLINE)
    assert.deepEqual(parsed, { ...INLINE, mode: 'copy', excludes: [] })
    // The task-management fields are not part of the preview form — they strip.
    assert.equal((parsed as Record<string, unknown>).name, undefined)
    assert.equal((parsed as Record<string, unknown>).schedule, undefined)
  })

  it('the inline arm carries the stored task\'s validation: relative source, bad mode, bad bwlimit', () => {
    assert.equal(CloudSyncPreviewTask.safeParse({ ...INLINE, source: 'relative' }).success, false)
    assert.equal(CloudSyncPreviewTask.safeParse({ ...INLINE, mode: 'two-way' }).success, false)
    assert.equal(CloudSyncPreviewTask.safeParse({ ...INLINE, bwlimit: 'fast' }).success, false)
  })

  it('an empty bandwidth limit normalizes to ABSENT, as on the write door', () => {
    assert.equal(CloudSyncPreviewTask.parse({ ...INLINE, bwlimit: '' }).bwlimit, undefined)
    assert.equal(CloudSyncPreviewTask.parse({ ...INLINE, bwlimit: '8M' }).bwlimit, '8M')
  })

  it('a sync-mode preview with excludes and a bwlimit parses whole', () => {
    const parsed = CloudSyncPreviewTask.parse({ ...INLINE, mode: 'sync', excludes: ['*.tmp'], bwlimit: '8M' })
    assert.deepEqual(parsed, { ...INLINE, mode: 'sync', excludes: ['*.tmp'], bwlimit: '8M' })
  })

  it('the union answers for both arms', () => {
    assert.equal(CloudSyncPreviewRequest.safeParse({ name: 'offsite' }).success, true)
    assert.equal(CloudSyncPreviewRequest.safeParse(INLINE).success, true)
    assert.equal(CloudSyncPreviewRequest.safeParse({}).success, false, 'neither a name nor a task')
    assert.equal(CloudSyncPreviewRequest.safeParse({ name: 'bad name' }).success, false)
  })

  it('the result carries rclone\'s counters, the capped delete list and the ceiling flag', () => {
    const parsed = CloudSyncPreviewResult.parse({
      transfers: 3,
      bytes: 358434,
      checks: 3,
      deletes: 1,
      deletedFiles: ['b.bin'],
      deletedTotal: 1,
      errors: [],
      truncated: false,
    })
    assert.deepEqual(parsed.deletedFiles, ['b.bin'])
    assert.equal(parsed.truncated, false)

    // Every count is nonnegative; a negative or missing counter is not a result.
    assert.equal(CloudSyncPreviewResult.safeParse({ ...parsed, bytes: -1 }).success, false)
    assert.equal(CloudSyncPreviewResult.safeParse({ ...parsed, truncated: 'yes' }).success, false)
  })
})
