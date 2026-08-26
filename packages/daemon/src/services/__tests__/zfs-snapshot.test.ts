import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  createZfsSnapshot,
  createZfsSnapshotArgs,
  destroyZfsSnapshot,
  destroyZfsSnapshotArgs,
  ZFS,
  zfsSnapshotFullName,
} from '../zfs-snapshot.js'

/**
 * backup2.3 stage 1 — the ONE zfs-snapshot helper.
 *
 * The point of these tests is NOT that the argv is clever; it is that the argv
 * is EXACTLY what the three call sites emitted before the extraction. The two
 * named in the story (the datasets route and the schedules service) plus
 * replication's snapshot-first branch all funnelled through the same two-line
 * shape, and backup became the fourth caller — an extraction that changed a flag
 * would change three features at once.
 */
describe('zfs-snapshot — the single snapshot/destroy helper (backup2.3)', () => {
  it('builds the exact argv the datasets route emitted: non-recursive', () => {
    assert.deepEqual(
      createZfsSnapshotArgs({ dataset: 'tank/media', name: 'nightly' }),
      ['snapshot', 'tank/media@nightly'],
    )
  })

  it('builds the exact argv the datasets route emitted: recursive', () => {
    assert.deepEqual(
      createZfsSnapshotArgs({ dataset: 'tank/media', name: 'nightly', recursive: true }),
      ['snapshot', '-r', 'tank/media@nightly'],
    )
  })

  it('builds the exact argv the schedules service emitted for a bucket name', () => {
    // `takeSnapshot` composed ['snapshot', ...(-r), '<ds>@<label>'] — identical.
    assert.deepEqual(
      createZfsSnapshotArgs({ dataset: 'tank', name: 'anas-daily-2026-07-26T142301Z', recursive: false }),
      ['snapshot', 'tank@anas-daily-2026-07-26T142301Z'],
    )
  })

  it('destroy is the same shape, with and without -r', () => {
    assert.deepEqual(destroyZfsSnapshotArgs({ dataset: 'tank', name: 's1' }), ['destroy', 'tank@s1'])
    assert.deepEqual(
      destroyZfsSnapshotArgs({ dataset: 'tank', name: 's1', recursive: true }),
      ['destroy', '-r', 'tank@s1'],
    )
  })

  it('the full name is `<dataset>@<name>`, never truncated', () => {
    assert.equal(zfsSnapshotFullName('tank/a/b', 'anas-backup-nightly-1756000000'), 'tank/a/b@anas-backup-nightly-1756000000')
  })

  it('execs /usr/sbin/zfs with the built argv', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await createZfsSnapshot(mock, { dataset: 'tank', name: 's1', recursive: true })
    assert.deepEqual(mock.calls, [{ command: ZFS, args: ['snapshot', '-r', 'tank@s1'] }])
  })

  it('throws the command\'s OWN stderr on failure (the routes\' long-standing text)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      result: { stdout: '', stderr: 'cannot create snapshot \'tank@s1\': dataset already exists\n', exitCode: 1 },
    })
    await assert.rejects(
      () => createZfsSnapshot(mock, { dataset: 'tank', name: 's1' }),
      /dataset already exists/,
    )
  })

  it('falls back to the named exit code when the command said nothing', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 2 } })
    await assert.rejects(
      () => destroyZfsSnapshot(mock, { dataset: 'tank', name: 's1' }),
      /zfs destroy exited with code 2/,
    )
  })
})
