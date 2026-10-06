import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapshotSchedule } from '../schemas/schedules.js'

/**
 * Story snapx.1 (#71): the exclude list's shape rules live on the shared
 * schema, so the request body and the stored unit JSON both hold them.
 */
const BASE = {
  id: 'hourly-tank',
  name: 'Hourly tank',
  target: { kind: 'zfs', dataset: 'tank' },
  cadence: 'hourly',
  retention: { hourly: 24 },
  enabled: true,
}

function firstMessage(input: unknown): string | undefined {
  const r = SnapshotSchedule.safeParse(input)
  return r.success ? undefined : r.error.issues[0]?.message
}

describe('SnapshotSchedule exclude (snapx.1)', () => {
  it('accepts strict descendants on a recursive ZFS schedule', () => {
    const r = SnapshotSchedule.safeParse({ ...BASE, recursive: true, exclude: ['tank/media', 'tank/vm-100-disk-0'] })
    assert.ok(r.success)
    assert.deepEqual(r.data.exclude, ['tank/media', 'tank/vm-100-disk-0'])
  })

  it('a schedule without exclude parses unchanged (additive field)', () => {
    const r = SnapshotSchedule.safeParse({ ...BASE, recursive: true })
    assert.ok(r.success)
    assert.equal(r.data.exclude, undefined)
  })

  it('an empty exclude is the plain schedule, legal without recursive', () => {
    assert.ok(SnapshotSchedule.safeParse({ ...BASE, exclude: [] }).success)
  })

  it('refuses exclude on a non-recursive schedule', () => {
    assert.equal(firstMessage({ ...BASE, exclude: ['tank/media'] }), 'Exclude requires a recursive schedule')
    assert.equal(firstMessage({ ...BASE, recursive: false, exclude: ['tank/media'] }), 'Exclude requires a recursive schedule')
  })

  it('refuses an entry that is not a strict descendant, naming it', () => {
    assert.equal(
      firstMessage({ ...BASE, target: { kind: 'zfs', dataset: 'tank/media' }, recursive: true, exclude: ['tank/mediaX'] }),
      `Exclude 'tank/mediaX' is not a child dataset of 'tank/media'`,
    )
    assert.equal(
      firstMessage({ ...BASE, recursive: true, exclude: ['tank'] }),
      `Exclude 'tank' is not a child dataset of 'tank'`,
    )
    assert.equal(
      firstMessage({ ...BASE, recursive: true, exclude: ['other/media'] }),
      `Exclude 'other/media' is not a child dataset of 'tank'`,
    )
  })

  it('refuses exclude on an AHR schedule', () => {
    assert.equal(
      firstMessage({ ...BASE, target: { kind: 'ahr', pool: 'media' }, recursive: true, exclude: ['media/x'] }),
      'Exclude applies to ZFS dataset schedules only',
    )
  })
})
