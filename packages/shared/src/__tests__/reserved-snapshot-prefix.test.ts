import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrCreateSnapshotRequest, AhrSnapshotName } from '../schemas/ahr.js'
import { NewSnapshotName, SnapshotName } from '../schemas/common.js'
import { CreateSnapshotRequest, RenameSnapshotRequest } from '../schemas/snapshots.js'

/**
 * Story cr.20 (audit #1's remaining gap): `anas-` is the prefix ANAS's
 * schedules own — a hand-made `anas-<bucket>-<utc>` snapshot is pruned as a
 * legacy unstamped schedule snapshot once a schedule covers the dataset.
 * The manual create and rename doors (ZFS and AHR) refuse the prefix;
 * reads and references to EXISTING snapshots (replication, route params)
 * stay on the plain names.
 */

describe('reserved anas- snapshot prefix (cr.20)', () => {
  it('NewSnapshotName refuses the prefix, any rest', () => {
    for (const name of [
      'anas-',
      'anas-foo',
      'anas-daily-2026-07-26T142301Z',
      'anas-backup-task-1700000000',
    ]) {
      const r = NewSnapshotName.safeParse(name)
      assert.equal(r.success, false, name)
      assert.match(r.error!.issues[0].message, /reserved for scheduled snapshots/)
    }
  })

  it('refuses case-sensitively (ZFS/btrfs labels are case-sensitive)', () => {
    // The retention parser matches the lowercase prefix exactly; `Anas-foo`
    // is an ordinary snapshot name on both backends.
    assert.equal(NewSnapshotName.safeParse('Anas-foo').success, true)
    assert.equal(NewSnapshotName.safeParse('ANAS-foo').success, true)
  })

  it('accepts ordinary names, including ones containing anas-', () => {
    for (const name of ['pre-anas-run', 'myanas-1', 'nightly', 'snap-2026-10-14'])
      assert.equal(NewSnapshotName.safeParse(name).success, true, name)
  })

  it('the ZFS create and rename requests carry the gate', () => {
    assert.equal(CreateSnapshotRequest.safeParse({ name: 'anas-daily-2026-07-26T142301Z' }).success, false)
    assert.equal(CreateSnapshotRequest.safeParse({ name: 'manual-1' }).success, true)
    assert.equal(RenameSnapshotRequest.safeParse({ newName: 'anas-hourly-2026-07-26T142301Z' }).success, false)
    assert.equal(RenameSnapshotRequest.safeParse({ newName: 'keep-this-one' }).success, true)
  })

  it('the AHR create request carries the gate (name stays optional)', () => {
    assert.equal(AhrCreateSnapshotRequest.safeParse({}).success, true)
    assert.equal(AhrCreateSnapshotRequest.safeParse({ name: 'manual-1' }).success, true)
    assert.equal(AhrCreateSnapshotRequest.safeParse({ name: 'anas-daily-2026-07-26T142301Z' }).success, false)
    assert.equal(AhrCreateSnapshotRequest.safeParse({ name: 'anas-' }).success, false)
    assert.equal(AhrCreateSnapshotRequest.safeParse({ name: 'Anas-foo' }).success, true)
  })

  it('reads stay lenient — an existing anas-* snapshot is addressable', () => {
    assert.equal(SnapshotName.safeParse('anas-daily-2026-07-26T142301Z').success, true)
    assert.equal(AhrSnapshotName.safeParse('anas-daily-2026-07-26T142301Z').success, true)
  })
})
