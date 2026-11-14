import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LenientReplicationTask, ReplicateRequest, ReplicationTask } from '../schemas/replication.js'
import { SnapshotSchedule } from '../schemas/schedules.js'

/**
 * Story rrep.1a (#84), schema half: `recursive` + `exclude` on both replication
 * bodies (R10) and the R3 refusal, each sentence pinned verbatim because the
 * dialog quotes them. Absent-means-absent (R0: an old client and a stored task
 * parse EXACTLY as they did before these fields existed), and the lenient
 * read-back still accepts what the strict gate refuses (a task stored under
 * rules a downgrade no longer has must stay visible).
 */

/** R3's sentence, quoted byte-identically from schemas/replication.ts. */
const R3_MESSAGE = 'Recursive replication sends the snapshots a recursive snapshot schedule takes — turn off \'Take a fresh snapshot before each run\' and schedule the source recursively in the Snapshots menu'

const MINIMAL_TASK = {
  name: 'nightly',
  source: { pool: 'tank', dataset: 'media' },
  target: { pool: 'backup' },
  schedule: 'daily',
}

/** Where a refusal landed and what it says — zod's issue reduced to what we pin. */
interface IssueLike {
  path: unknown[]
  message: string
}

interface ParseErrorLike {
  success: boolean
  error?: { issues: IssueLike[] }
}

function issuesOf(schema: { safeParse: (v: unknown) => ParseErrorLike }, body: unknown): IssueLike[] {
  const r = schema.safeParse(body)
  if (r.success || !r.error)
    return []
  return r.error.issues.map(i => ({ path: [...i.path], message: i.message }))
}

function messagesOf(schema: Parameters<typeof issuesOf>[0], body: unknown): string[] {
  return issuesOf(schema, body).map(i => i.message)
}

describe('ReplicateRequest recursion fields (rrep.1a)', () => {
  it('a body without the new fields parses to exactly today output (R0)', () => {
    assert.deepEqual(
      ReplicateRequest.parse({ target: { pool: 'backup' }, snapshotFirst: true }),
      { target: { pool: 'backup' }, snapshotFirst: true, notify: 'on-failure' },
    )
  })

  it('a task body without the new fields parses to exactly today output (R0)', () => {
    assert.deepEqual(
      ReplicationTask.parse(MINIMAL_TASK),
      {
        name: 'nightly',
        source: { pool: 'tank', dataset: 'media' },
        target: { pool: 'backup' },
        schedule: 'daily',
        snapshotFirst: true,
        enabled: true,
        notify: 'on-failure',
      },
    )
  })
})

describe('ReplicateRequest exclude + R3 (rrep.1a)', () => {
  it('accepts recursive with exclude children; the source is the URL, so no child rule here', () => {
    const r = ReplicateRequest.safeParse({ target: { pool: 'backup' }, recursive: true, exclude: ['tank/media/x'] })
    assert.ok(r.success)
    assert.deepEqual(r.data.exclude, ['tank/media/x'])
  })

  it('refuses exclude without recursive, replication wording (not the schedule sentence)', () => {
    assert.deepEqual(
      messagesOf(ReplicateRequest, { target: { pool: 'backup' }, exclude: ['tank/media'] }),
      ['Exclude requires a recursive replication'],
    )
    assert.deepEqual(
      messagesOf(ReplicateRequest, { target: { pool: 'backup' }, recursive: false, exclude: ['tank/media'] }),
      ['Exclude requires a recursive replication'],
    )
  })

  it('an empty exclude is the plain run, legal without recursive', () => {
    assert.ok(ReplicateRequest.safeParse({ target: { pool: 'backup' }, exclude: [] }).success)
  })

  it('R3: recursive + snapshotFirst is an issue on snapshotFirst, sentence verbatim', () => {
    const issues = issuesOf(ReplicateRequest, { target: { pool: 'backup' }, recursive: true, snapshotFirst: true })
    assert.deepEqual(issues, [{ path: ['snapshotFirst'], message: R3_MESSAGE }])
  })

  it('recursive WITHOUT snapshotFirst is fine on a request (the field has no default here)', () => {
    assert.ok(ReplicateRequest.safeParse({ target: { pool: 'backup' }, recursive: true }).success)
  })
})

describe('ReplicationTask recursion fields (rrep.1a)', () => {
  it('the child rule names the source pool-rooted path (taskSourceFull: pool/dataset)', () => {
    assert.deepEqual(
      messagesOf(ReplicationTask, { ...MINIMAL_TASK, recursive: true, snapshotFirst: false, exclude: ['tank/other'] }),
      [`Exclude 'tank/other' is not a child dataset of 'tank/media'`],
    )
  })

  it('a pool-root source is named by the pool alone', () => {
    const root = { ...MINIMAL_TASK, source: { pool: 'tank', dataset: '' } }
    assert.ok(ReplicationTask.safeParse({ ...root, recursive: true, snapshotFirst: false, exclude: ['tank/media'] }).success)
    assert.deepEqual(
      messagesOf(ReplicationTask, { ...root, recursive: true, snapshotFirst: false, exclude: ['tankx'] }),
      [`Exclude 'tankx' is not a child dataset of 'tank'`],
    )
  })

  it('refuses exclude without recursive with the replication sentence', () => {
    assert.deepEqual(
      messagesOf(ReplicationTask, { ...MINIMAL_TASK, exclude: ['tank/media/x'] }),
      ['Exclude requires a recursive replication'],
    )
  })

  it('R3: snapshotFirst defaults true, so a bare { recursive: true } task is refused', () => {
    const issues = issuesOf(ReplicationTask, { ...MINIMAL_TASK, recursive: true })
    assert.deepEqual(issues, [{ path: ['snapshotFirst'], message: R3_MESSAGE }])
  })

  it('recursive + snapshotFirst false is the shape a recursive task is saved in', () => {
    const r = ReplicationTask.safeParse({ ...MINIMAL_TASK, recursive: true, snapshotFirst: false, exclude: ['tank/media/tmp'] })
    assert.ok(r.success)
    assert.equal(r.data.snapshotFirst, false)
  })

  it('a body wrong in both ways reports both issues', () => {
    assert.deepEqual(
      messagesOf(ReplicationTask, { ...MINIMAL_TASK, recursive: true, snapshotFirst: true, exclude: ['other/x'] }),
      [`Exclude 'other/x' is not a child dataset of 'tank/media'`, R3_MESSAGE],
    )
  })
})

describe('LenientReplicationTask carries no recursion rules (rrep.1a)', () => {
  it('parses a stored task the strict gate refuses on R3', () => {
    assert.equal(ReplicationTask.safeParse({ ...MINIMAL_TASK, recursive: true }).success, false)
    const r = LenientReplicationTask.safeParse({ ...MINIMAL_TASK, recursive: true })
    assert.ok(r.success)
    assert.equal(r.data.recursive, true)
  })

  it('still relaxes only the identity fields: control characters stay refused', () => {
    assert.equal(LenientReplicationTask.safeParse({ ...MINIMAL_TASK, source: { pool: 'tank', dataset: 'me\ndia' } }).success, false)
  })
})

describe('the shared helper kept the schedule sentences (rrep.1a refactor)', () => {
  const SCHEDULE_BASE = {
    id: 'hourly-tank',
    name: 'Hourly tank',
    target: { kind: 'zfs', dataset: 'tank' },
    cadence: 'hourly',
    retention: { hourly: 24 },
    enabled: true,
  }

  it('a bad exclude still produces the schedule sentences, byte-identical', () => {
    assert.deepEqual(
      messagesOf(SnapshotSchedule, { ...SCHEDULE_BASE, exclude: ['tank/media'] }),
      ['Exclude requires a recursive schedule'],
    )
    assert.deepEqual(
      messagesOf(SnapshotSchedule, { ...SCHEDULE_BASE, recursive: true, exclude: ['tank'] }),
      [`Exclude 'tank' is not a child dataset of 'tank'`],
    )
  })

  it('an AHR schedule still gets its own first sentence, and only that one', () => {
    assert.deepEqual(
      messagesOf(SnapshotSchedule, { ...SCHEDULE_BASE, target: { kind: 'ahr', pool: 'media' }, exclude: ['media/x'] }),
      ['Exclude applies to ZFS dataset schedules only'],
    )
  })

  it('a valid recursive schedule is untouched by the refactor', () => {
    const r = SnapshotSchedule.safeParse({ ...SCHEDULE_BASE, recursive: true, exclude: ['tank/media'] })
    assert.ok(r.success)
  })
})
