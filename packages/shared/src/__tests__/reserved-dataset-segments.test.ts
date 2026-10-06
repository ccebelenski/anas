import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatasetPath, NewDatasetPath, reservedDatasetSegment } from '../schemas/common.js'
import { CreateDatasetRequest } from '../schemas/datasets.js'
import { CloneSnapshotRequest } from '../schemas/snapshots.js'

/**
 * Story ident.1 (audit #12): the datasets router reads `snapshots`, `access`
 * and `permissions` out of a dataset path, so a NEW dataset may not use one as
 * a segment. Reads keep the plain DatasetPath — an existing dataset with such
 * a name stays addressable.
 */
describe('reserved dataset segments (ident.1)', () => {
  it('names the first reserved segment, whole segments only', () => {
    assert.equal(reservedDatasetSegment('media/snapshots/old'), 'snapshots')
    assert.equal(reservedDatasetSegment('access'), 'access')
    assert.equal(reservedDatasetSegment('a/b/permissions'), 'permissions')
    assert.equal(reservedDatasetSegment('my-snapshots/accessible/permissionsx'), null)
    assert.equal(reservedDatasetSegment('media/movies'), null)
  })

  it('NewDatasetPath refuses a reserved segment; DatasetPath (reads) still accepts it', () => {
    for (const path of ['snapshots', 'media/snapshots/x', 'x/access', 'permissions/y']) {
      const r = NewDatasetPath.safeParse(path)
      assert.equal(r.success, false, path)
      assert.match(r.error!.issues[0].message, /is reserved/)
      assert.equal(DatasetPath.safeParse(path).success, true, path)
    }
    assert.equal(NewDatasetPath.safeParse('media/snapshot-archive').success, true)
  })

  it('create and clone carry the refinement', () => {
    assert.equal(CreateDatasetRequest.safeParse({ path: 'media/snapshots' }).success, false)
    assert.equal(CreateDatasetRequest.safeParse({ path: 'media/movies' }).success, true)
    assert.equal(CloneSnapshotRequest.safeParse({ target: 'tank/snapshots/x' }).success, false)
    assert.equal(CloneSnapshotRequest.safeParse({ target: 'tank/clone-x' }).success, true)
    // The pool name is the router's, never a segment.
    assert.equal(CloneSnapshotRequest.safeParse({ target: 'access/x' }).success, true)
  })
})
