import type { BackupRepo, BackupTask } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { buildBackupArgs, distinctAhrTargets, distinctZfsTargets, runBackup } from '../backup-runner.js'
import { formatTransientBackupSnapshot } from '../snapshot-naming.js'
import { ZFS } from '../zfs-snapshot.js'

/**
 * backup2.3 — the RUN, end to end, with the executor AND the clock under test
 * control. The route-level suite proves the same arc through the API; this one
 * exists for the branches the route cannot pin: a pbc failure and a pbc that
 * never returns (the timeout), where the transient snapshot's `finally` is the
 * only thing between a dead run and a snapshot nobody knows about.
 */

const FINDMNT = '/usr/bin/findmnt'
const TIMEOUT = '/usr/bin/timeout'
const FIND = '/usr/bin/find'
const PRLIMIT = '/usr/bin/prlimit'

const NOW = new Date('2026-08-25T12:00:00Z')
const TASK_NAME = 'nightly-media'
const LABEL = formatTransientBackupSnapshot(TASK_NAME, NOW)

/** `/tank/media` is a ZFS dataset with the child dataset `photos` under it. */
const TABLE = JSON.stringify({
  filesystems: [{
    target: '/',
    source: '/dev/sda1',
    fstype: 'ext4',
    options: 'rw',
    children: [
      { target: '/tank/media', source: 'tank/media', fstype: 'zfs', options: 'rw' },
      { target: '/tank/media/photos', source: 'tank/media/photos', fstype: 'zfs', options: 'rw' },
    ],
  }],
})

/** The walk the run performs for a source (60 s budget, depth 12). */
function walkCall(path: string, maxDepth = 12): string[] {
  return [
    '60',
    FIND,
    '-P',
    path,
    '-xdev',
    '-maxdepth',
    String(maxDepth),
    '(',
    '-name',
    '.zfs',
    ')',
    '-prune',
    '-o',
    '-type',
    'd',
    '-printf',
    '%D\\t%p\\n',
  ]
}

const REPO: BackupRepo = {
  name: 'pbs-main',
  host: '127.0.0.1',
  port: 8007,
  datastore: 'store1',
  authType: 'token',
  tokenId: 'root@pam!anas',
}

function task(over: Partial<BackupTask> = {}): BackupTask {
  return {
    name: TASK_NAME,
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives: [{ name: 'media', path: '/tank/media', excludes: [], includeNested: ['/tank/media/photos'] }],
    changeDetectionMode: 'default',
    notify: 'always',
    schedule: '*-*-* 02:00:00',
    enabled: true,
    limitNofile: 1024,
    ...over,
  } as BackupTask
}

const PBC_OK = [
  'Starting backup: host/anas-pve/2026-08-25T12:00:01Z',
  'Upload directory \'/tank/media/.zfs/snapshot/x\' to \'repo\' as media.pxar.didx',
  'media.pxar: had to backup 0 B of 3.937 MiB (compressed 0 B)',
  'Duration: 1.2s',
].join('\n')

/** The stale-sweep list argv for the dataset under test. */
const SWEEP_LIST = ['list', '-t', 'snapshot', '-Hp', '-o', 'name', '-r', 'tank/media']

/** A mock wired for one snapshot-mode run of `/tank/media`. */
function wire(pbc: ExecResult = { stdout: '', stderr: PBC_OK, exitCode: 0 }): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
  mock.addFixture({
    command: TIMEOUT,
    args: walkCall('/tank/media'),
    result: { stdout: '66\t/tank/media\n66\t/tank/media/plain\n67\t/tank/media/photos\n', stderr: '', exitCode: 0 },
  })
  // The stale sweep's list: one transient of THIS task from a run that died
  // before its `finally`, plus snapshots that are emphatically not ours.
  mock.addFixture({
    command: ZFS,
    args: SWEEP_LIST,
    result: {
      stdout: [
        'tank/media@anas-backup-nightly-media-1000000000',
        'tank/media@anas-backup-some-other-task-1000000000',
        'tank/media@anas-daily-2026-08-20T020000Z',
        'tank/media@manual-before-upgrade',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    },
  })
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: PRLIMIT, result: pbc })
  return mock
}

/** Every `zfs <verb>` argv, in call order. */
function zfsArgs(mock: MockExecutor, verb: string): string[][] {
  return mock.calls.filter(c => c.command === ZFS && c.args[0] === verb).map(c => c.args)
}

async function run(executor: CommandExecutor, over: Partial<BackupTask> = {}) {
  return runBackup(executor, { task: task(over), repo: REPO, secret: 's3cret', now: NOW }, () => {})
}

describe('snapshot-consistent run — lifecycle (backup2.3)', () => {
  it('SUCCESS: sweep → snapshot -r → pbc from the snapshot root → destroy -r', async () => {
    const mock = wire()
    const result = await run(mock)

    assert.equal(result.status, 'success')
    // The sweep took only this task's own older transient; then the run's own
    // snapshot; then the `finally` destroy.
    assert.deepEqual(zfsArgs(mock, 'destroy'), [
      ['destroy', '-r', 'tank/media@anas-backup-nightly-media-1000000000'],
      ['destroy', '-r', `tank/media@${LABEL}`],
    ])
    assert.deepEqual(zfsArgs(mock, 'snapshot'), [['snapshot', '-r', `tank/media@${LABEL}`]])
    // Ordering is load-bearing: the sweep runs BEFORE the snapshot is taken.
    const order = mock.calls.filter(c => c.command === ZFS).map(c => c.args.join(' '))
    assert.ok(
      order.indexOf('destroy -r tank/media@anas-backup-nightly-media-1000000000')
      < order.indexOf(`snapshot -r tank/media@${LABEL}`),
      order.join(' | '),
    )

    const pbc = mock.calls.find(c => c.command === PRLIMIT)
    assert.ok(pbc)
    assert.deepEqual(pbc.args.filter(a => a.includes('.pxar:')), [
      `media.pxar:/tank/media/.zfs/snapshot/${LABEL}`,
      `media__photos.pxar:/tank/media/photos/.zfs/snapshot/${LABEL}`,
    ])
    // GT-51: no `zfs set snapdir` — `.zfs/snapshot` is reachable while hidden.
    assert.equal(zfsArgs(mock, 'set').length, 0)
    // NO HOLDS, ever (the story's explicit ruling).
    assert.equal(zfsArgs(mock, 'hold').length, 0)

    assert.deepEqual(result.snapshots?.map(s => s.full), [`tank/media@${LABEL}`])
    assert.deepEqual(result.expansion?.map(e => e.name), ['media', 'media__photos'])
    assert.equal(result.consistency?.[0].consistency, 'snapshot')
  })

  it('FAILURE: the transient is still destroyed, and the pbc error is what escapes', async () => {
    const mock = wire({ stdout: '', stderr: 'Error: unable to open chunk store \'store1\'\n', exitCode: 255 })
    await assert.rejects(() => run(mock), /unable to open chunk store/)
    assert.ok(
      zfsArgs(mock, 'destroy').some(a => a[2] === `tank/media@${LABEL}`),
      JSON.stringify(zfsArgs(mock, 'destroy')),
    )
  })

  it('TIMEOUT: an exec that never returns normally still hits the `finally`', async () => {
    // A killed pbc surfaces as a REJECTED exec, not an exit code — the branch a
    // `try/catch` around the result alone would miss entirely.
    const inner = wire()
    const executor = {
      exec: async (cmd: string, args: string[], opts?: unknown) => {
        if (cmd === PRLIMIT)
          throw new Error('spawn ETIMEDOUT')
        return inner.exec(cmd, args, opts as never)
      },
      pipeline: inner.pipeline.bind(inner),
    } as unknown as CommandExecutor

    await assert.rejects(() => run(executor), /ETIMEDOUT/)
    assert.ok(
      zfsArgs(inner, 'destroy').some(a => a[2] === `tank/media@${LABEL}`),
      JSON.stringify(zfsArgs(inner, 'destroy')),
    )
  })

  it('a destroy that fails does NOT fail a completed backup — it is a warning', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
    mock.addFixture({
      command: TIMEOUT,
      args: walkCall('/tank/media'),
      result: { stdout: '66\t/tank/media\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({ command: ZFS, args: SWEEP_LIST, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({
      command: ZFS,
      args: ['snapshot', '-r', `tank/media@${LABEL}`],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: ZFS,
      args: ['destroy', '-r', `tank/media@${LABEL}`],
      result: { stdout: '', stderr: 'cannot destroy: dataset is busy\n', exitCode: 1 },
    })
    mock.addFixture({ command: PRLIMIT, result: { stdout: '', stderr: PBC_OK, exitCode: 0 } })

    const result = await run(mock)
    assert.equal(result.status, 'success')
    const said = (result.warnings ?? []).some(w => w.includes('could not be destroyed') && w.includes('dataset is busy'))
    assert.ok(said, JSON.stringify(result.warnings))
  })

  it('a LIVE task takes no snapshot at all and keeps backup2.2 verbatim', async () => {
    const mock = wire()
    const result = await run(mock, {
      archives: [{ name: 'etc', path: '/etc', excludes: [], includeNested: 'none' }],
    })
    // The `/etc` walk is unfixtured, so the boundary scan fails open — which must
    // not conjure a snapshot for an ext4 source.
    assert.equal(result.consistency?.[0].consistency, 'live')
    assert.equal(zfsArgs(mock, 'snapshot').length, 0)
    assert.equal(zfsArgs(mock, 'destroy').length, 0)
    assert.equal(result.snapshots, undefined)
    assert.equal(result.expansion, undefined)
    const pbc = mock.calls.find(c => c.command === PRLIMIT)
    assert.ok(pbc)
    assert.deepEqual(pbc.args.filter(a => a.includes('.pxar:')), ['etc.pxar:/etc'])
  })
})

describe('snapshot targets are deduplicated by dataset (backup2.3)', () => {
  const snap = (target: string) => ({ consistency: 'snapshot' as const, reason: '', backend: 'zfs' as const, target })

  it('two archives on the SAME dataset share ONE recursive snapshot', () => {
    assert.deepEqual(distinctZfsTargets([snap('tank/media'), snap('tank/media')]), ['tank/media'])
  })

  it('a DESCENDANT dataset is dropped — the ancestor\'s -r already labelled it', () => {
    // A second `zfs snapshot -r` on the child would fail "already exists", and
    // destroying the ancestor recursively takes the child's copy with it.
    assert.deepEqual(distinctZfsTargets([snap('tank/media'), snap('tank/media/photos')]), ['tank/media'])
  })

  it('unrelated datasets each get their own', () => {
    assert.deepEqual(distinctZfsTargets([snap('tank/a'), snap('tank/b')]), ['tank/a', 'tank/b'])
  })

  it('a live archive contributes no target', () => {
    assert.deepEqual(distinctZfsTargets([{ consistency: 'live', reason: '' }]), [])
    assert.deepEqual(distinctAhrTargets([{ consistency: 'live', reason: '' }], []), [])
  })
})

describe('buildBackupArgs under expansion (backup2.3)', () => {
  it('the --backup-id is untouched and the ROOT archive keeps its name', () => {
    const t = task()
    const live = buildBackupArgs(t, undefined, {})
    const snap = buildBackupArgs(t, undefined, {}, [
      { name: 'media', from: 'media', root: `/tank/media/.zfs/snapshot/${LABEL}`, relativePath: '', excludes: [] },
      { name: 'media__photos', from: 'media', root: `/tank/media/photos/.zfs/snapshot/${LABEL}`, relativePath: 'photos', excludes: [] },
    ])
    const idOf = (a: string[]): string => a[a.indexOf('--backup-id') + 1]
    assert.equal(idOf(snap), idOf(live))
    assert.equal(live.filter(a => a.includes('.pxar:'))[0].split('.pxar:')[0], 'media')
    assert.equal(snap.filter(a => a.includes('.pxar:'))[0].split('.pxar:')[0], 'media')
  })

  it('excludes are emitted ONCE for the invocation, deduplicated across roots', () => {
    const args = buildBackupArgs(task(), undefined, {}, [
      { name: 'a', from: 'a', root: '/r1', relativePath: '', excludes: ['*.tmp', '/cache'] },
      { name: 'a__b', from: 'a', root: '/r2', relativePath: 'b', excludes: ['*.tmp', '/thumbs'] },
    ])
    const excludes: string[] = []
    args.forEach((a, i) => {
      if (a === '--exclude')
        excludes.push(args[i + 1])
    })
    assert.deepEqual(excludes, ['*.tmp', '/cache', '/thumbs'])
  })

  it('an expanded archive emits NO --include-dev, and never --all-file-systems', () => {
    const args = buildBackupArgs(
      task({ archives: [{ name: 'media', path: '/tank/media', excludes: [], includeNested: ['/tank/media/photos'] }] }),
      undefined,
      {},
      [{ name: 'media', from: 'media', root: '/snap', relativePath: '', excludes: [] }],
    )
    assert.ok(!args.includes('--include-dev'), args.join(' '))
    assert.ok(!args.includes('--all-file-systems'))
  })
})
