import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  createZfsSnapshot,
  createZfsSnapshotArgs,
  createZfsSnapshotExcluding,
  createZfsSnapshotsArgs,
  destroyZfsSnapshot,
  destroyZfsSnapshotArgs,
  expandSnapshotTargets,
  ZFS,
  zfsSnapshotFullName,
  zfsTreeListArgs,
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

/**
 * snapx.1 (#71) — a recursive snapshot minus excluded subtrees. The expansion
 * is pure; the take is ONE `zfs snapshot` naming every remaining dataset (ZFS
 * takes all snapshots named in one call atomically), and an empty exclude list
 * is the literal `-r`, byte-identical to every existing schedule.
 */
describe('expandSnapshotTargets (snapx.1)', () => {
  const TREE = [
    'tank',
    'tank/backup',
    'tank/backup/pc1',
    'tank/backup/pc1/old',
    'tank/home',
    'tank/media',
    'tank/media2',
    'tank/vm-100-disk-0',
  ]

  it('drops an excluded dataset and its whole subtree, grandchildren included', () => {
    assert.deepEqual(
      expandSnapshotTargets(TREE, 'tank', ['tank/backup']),
      ['tank', 'tank/home', 'tank/media', 'tank/media2', 'tank/vm-100-disk-0'],
    )
  })

  it('a name prefix is not a subtree: excluding tank/media keeps tank/media2', () => {
    assert.deepEqual(
      expandSnapshotTargets(TREE, 'tank', ['tank/media', 'tank/vm-100-disk-0']),
      ['tank', 'tank/backup', 'tank/backup/pc1', 'tank/backup/pc1/old', 'tank/home', 'tank/media2'],
    )
  })

  it('excluding a grandchild keeps its parent', () => {
    assert.deepEqual(
      expandSnapshotTargets(TREE, 'tank/backup', ['tank/backup/pc1/old']),
      ['tank/backup', 'tank/backup/pc1'],
    )
  })

  it('the target is always first, even when the listing order differs', () => {
    assert.deepEqual(
      expandSnapshotTargets(['tank/home', 'tank'], 'tank', []),
      ['tank', 'tank/home'],
    )
  })

  it('an unknown exclude entry is inert (rejection is the route\'s job)', () => {
    assert.deepEqual(
      expandSnapshotTargets(['tank', 'tank/home'], 'tank', ['tank/gone']),
      ['tank', 'tank/home'],
    )
  })

  it('ignores listed names outside the target tree', () => {
    assert.deepEqual(
      expandSnapshotTargets(['tank', 'tank/home', 'tankx', 'other/a'], 'tank', []),
      ['tank', 'tank/home'],
    )
  })
})

describe('createZfsSnapshotsArgs / createZfsSnapshotExcluding (snapx.1)', () => {
  it('one snapshot verb, every name after it, no -r', () => {
    assert.deepEqual(
      createZfsSnapshotsArgs(['tank', 'tank/home'], 'anas-hourly-x'),
      ['snapshot', 'tank@anas-hourly-x', 'tank/home@anas-hourly-x'],
    )
  })

  it('the tree listing is name-only, recursive, filesystems and volumes', () => {
    assert.deepEqual(zfsTreeListArgs('tank'), ['list', '-H', '-o', 'name', '-r', '-t', 'filesystem,volume', 'tank'])
  })

  it('lists the tree then takes the remaining snapshots in ONE call', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: zfsTreeListArgs('tank'),
      result: { stdout: 'tank\ntank/media\ntank/media/raw\ntank/home\n', stderr: '', exitCode: 0 },
    })
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await createZfsSnapshotExcluding(executor, { dataset: 'tank', name: 'n', exclude: ['tank/media'] })
    assert.equal(executor.calls.length, 2)
    assert.deepEqual(executor.calls[1], { command: ZFS, args: ['snapshot', 'tank@n', 'tank/home@n'] })
    assert.deepEqual(res.snapshots, ['tank@n', 'tank/home@n'])
  })

  it('an empty exclude is the literal zfs snapshot -r (no listing)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await createZfsSnapshotExcluding(executor, { dataset: 'tank', name: 'n', exclude: [] })
    assert.deepEqual(executor.calls, [{ command: ZFS, args: ['snapshot', '-r', 'tank@n'] }])
  })

  it('a failed tree listing throws its stderr and takes nothing', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: 'cannot open \'tank\': dataset does not exist', exitCode: 1 } })
    await assert.rejects(
      () => createZfsSnapshotExcluding(executor, { dataset: 'tank', name: 'n', exclude: ['tank/media'] }),
      /dataset does not exist/,
    )
    assert.equal(executor.calls.length, 1)
  })
})
