import type { AhrPool, ScheduledSnapshot, Snapshot } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  destroyTransients,
  plannedTopLevel,
  staleTransients,
  sweepAhrTransients,
  sweepZfsTransients,
  takeAhrTransient,
  takeZfsTransient,
  withTopLevelMounts,
  zfsTransientListArgs,
} from '../backup-snapshots.js'
import {
  formatTransientBackupSnapshot,
  isTransientBackupSnapshot,
  isTransientBackupSnapshotOf,
  parseTransientBackupSnapshot,
} from '../snapshot-naming.js'
import { planRetention } from '../snapshot-retention.js'
import { ZFS } from '../zfs-snapshot.js'

/**
 * backup2.3 — the transient snapshot LIFECYCLE, and the ⚠ prefix-ignore that the
 * design review called out as the thing that bites hardest if missed.
 */

const TASK = 'nightly-pictures'
const NOW = new Date('2026-08-25T12:00:00Z')
const LABEL = formatTransientBackupSnapshot(TASK, NOW) // anas-backup-nightly-pictures-<unix>

describe('transient backup-snapshot naming (backup2.3)', () => {
  it('the label is `anas-backup-<taskname>-<unix seconds>`', () => {
    assert.equal(LABEL, `anas-backup-${TASK}-${Math.floor(NOW.getTime() / 1000)}`)
  })

  it('round-trips a task name that itself contains dashes', () => {
    const parsed = parseTransientBackupSnapshot(LABEL)
    assert.equal(parsed?.task, TASK)
    assert.equal(parsed?.at.getTime(), NOW.getTime())
    assert.equal(parsed?.subvolume, undefined)
  })

  it('AHR\'s per-subvolume `__<suffix>` label parses to the same task and instant', () => {
    const parsed = parseTransientBackupSnapshot(`${LABEL}__photos_raw`)
    assert.equal(parsed?.task, TASK)
    assert.equal(parsed?.at.getTime(), NOW.getTime())
    assert.equal(parsed?.subvolume, 'photos_raw')
  })

  it('is charset-legal on BOTH backends (ZFS labels and btrfs path segments)', () => {
    assert.match(LABEL, /^[\w.:-]+$/)
    assert.match(`${LABEL}__photos_raw`, /^[a-z0-9][\w.:-]*$/i)
  })

  it('recognises anything carrying the prefix, even a name it cannot fully parse', () => {
    assert.equal(isTransientBackupSnapshot(LABEL), true)
    assert.equal(isTransientBackupSnapshot('anas-backup-mangled'), true)
    assert.equal(isTransientBackupSnapshot('anas-daily-2026-07-26T142301Z'), false)
    assert.equal(isTransientBackupSnapshot('nightly'), false)
    assert.equal(isTransientBackupSnapshot('repl-base'), false)
  })

  it('scopes to a task: another task\'s transient is not ours', () => {
    assert.equal(isTransientBackupSnapshotOf(LABEL, TASK), true)
    assert.equal(isTransientBackupSnapshotOf(LABEL, 'other-task'), false)
  })
})

// ---------------------------------------------------------------------------
//  ⚠ The prefix ignore, in situ
// ---------------------------------------------------------------------------

describe('⚠ transient snapshots are invisible to replication and retention (backup2.3)', () => {
  it('RETENTION never counts, keeps or prunes a transient', () => {
    const snap = (name: string, source: 'anas' | 'other' = 'anas'): ScheduledSnapshot => ({
      name,
      target: { kind: 'zfs', dataset: 'tank/media' },
      bucket: null,
      createdAt: null,
      held: false,
      source,
    })
    const plan = planRetention(
      [
        snap('anas-daily-2026-08-20T020000Z'),
        snap('anas-daily-2026-08-21T020000Z'),
        snap('anas-daily-2026-08-22T020000Z'),
        // Two transients, one of them the NEWEST thing on the dataset — exactly
        // the case that would otherwise claim the always-keep-newest guarantee
        // and displace a real daily from the keep budget.
        snap(LABEL, 'anas'),
        snap(`${LABEL}__photos`, 'anas'),
      ],
      { daily: 2 },
      new Date('2026-08-26T00:00:00Z'),
    )
    const all = [...plan.keep, ...plan.prune, ...plan.skippedHeld].map(s => s.name)
    assert.ok(!all.some(isTransientBackupSnapshot), all.join(' '))
    // The real dailies are bucketed exactly as they would be with no transient
    // present at all: 2 kept, 1 pruned.
    assert.deepEqual(plan.keep.map(s => s.name).sort(), [
      'anas-daily-2026-08-21T020000Z',
      'anas-daily-2026-08-22T020000Z',
    ])
    assert.deepEqual(plan.prune.map(s => s.name), ['anas-daily-2026-08-20T020000Z'])
  })

  it('RETENTION with ONLY transients present plans nothing at all', () => {
    const plan = planRetention(
      [{
        name: LABEL,
        target: { kind: 'zfs', dataset: 'tank' },
        bucket: null,
        createdAt: null,
        held: false,
        source: 'anas',
      }],
      { daily: 1 },
    )
    assert.deepEqual(plan, { keep: [], prune: [], skippedHeld: [] })
  })

  it('REPLICATION never adopts a transient as an incremental base', async () => {
    // `discover` is private to the replication route module, so this exercises
    // the exact selection expression it uses over the same shapes: newest-first
    // source snapshots, a target name set, and the transient filter.
    const source: Snapshot[] = [
      { snapshotName: 'nightly-3' },
      { snapshotName: LABEL },
      { snapshotName: 'nightly-2' },
      { snapshotName: 'nightly-1' },
    ] as Snapshot[]
    const targetNames = new Set(
      [LABEL, 'nightly-2', 'nightly-1'].filter(n => !isTransientBackupSnapshot(n)),
    )
    const older = source.slice(source.findIndex(s => s.snapshotName === 'nightly-3') + 1)
    const base = older.find(s => !isTransientBackupSnapshot(s.snapshotName) && targetNames.has(s.snapshotName))
    // Without the filter the base would be the transient, which the backup run's
    // `finally` is about to destroy — severing the chain.
    assert.equal(base?.snapshotName, 'nightly-2')
    assert.ok(!targetNames.has(LABEL))
  })
})

// ---------------------------------------------------------------------------
//  Lifecycle: take, destroy-in-finally, stale sweep
// ---------------------------------------------------------------------------

describe('transient snapshot lifecycle (backup2.3)', () => {
  it('a ZFS transient is ALWAYS taken recursively — a child dataset needs its own label', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const taken = await takeZfsTransient(mock, 'tank/media', LABEL)
    assert.deepEqual(mock.calls, [{ command: ZFS, args: ['snapshot', '-r', `tank/media@${LABEL}`] }])
    assert.equal(taken.recursive, true)
    assert.equal(taken.full, `tank/media@${LABEL}`)
    assert.equal(taken.backend, 'zfs')
  })

  it('destroy is recursive too, and runs in REVERSE order', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const warnings = await destroyTransients(mock, [
      { backend: 'zfs', name: LABEL, target: 'tank/a', full: `tank/a@${LABEL}`, recursive: true },
      { backend: 'zfs', name: LABEL, target: 'tank/b', full: `tank/b@${LABEL}`, recursive: true },
    ])
    assert.deepEqual(warnings, [])
    assert.deepEqual(mock.calls.map(c => c.args), [
      ['destroy', '-r', `tank/b@${LABEL}`],
      ['destroy', '-r', `tank/a@${LABEL}`],
    ])
  })

  it('a destroy that FAILS is one warning, never an exception — the backup already succeeded', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      results: [
        { stdout: '', stderr: 'cannot destroy: dataset is busy\n', exitCode: 1 },
        { stdout: '', stderr: '', exitCode: 0 },
      ],
    })
    const warnings = await destroyTransients(mock, [
      { backend: 'zfs', name: LABEL, target: 'tank/a', full: `tank/a@${LABEL}`, recursive: true },
      { backend: 'zfs', name: LABEL, target: 'tank/b', full: `tank/b@${LABEL}`, recursive: true },
    ])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /tank\/b@/)
    assert.match(warnings[0], /dataset is busy/)
    assert.match(warnings[0], /next run of this task sweeps it/)
    // The SECOND destroy still ran: one failure never aborts the cleanup.
    assert.equal(mock.calls.length, 2)
  })

  // ---- the stale sweep's scoping rule ------------------------------------

  const OLDER = formatTransientBackupSnapshot(TASK, new Date(NOW.getTime() - 3600_000))
  const OTHER_TASK = formatTransientBackupSnapshot('some-other-task', new Date(NOW.getTime() - 3600_000))
  const NEWER = formatTransientBackupSnapshot(TASK, new Date(NOW.getTime() + 3600_000))

  it('the sweep takes ONLY this task\'s own older transients', () => {
    const stale = staleTransients(
      [
        OLDER,
        `${OLDER}__photos`,
        LABEL, // this run's own — never
        NEWER, // future-dated — never
        OTHER_TASK, // another task's, possibly running RIGHT NOW — never
        'anas-daily-2026-08-20T020000Z', // a schedule snapshot — never
        'nightly', // a manual snapshot — never
        'anas-backup-mangled', // ours by prefix, unparseable: left alone
      ],
      TASK,
      NOW,
    )
    assert.deepEqual(stale, [OLDER, `${OLDER}__photos`])
  })

  it('the sweep destroys what it selected, recursively, and lists with -r', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: zfsTransientListArgs('tank/media'),
      result: {
        stdout: [
          `tank/media@${OLDER}`,
          `tank/media@${LABEL}`,
          `tank/media@${OTHER_TASK}`,
          'tank/media@nightly',
          // A CHILD dataset's snapshot — not this dataset's label, so the parse
          // of `<dataset>@` filters it out rather than sweeping a child by name.
          `tank/media/photos@${OLDER}`,
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const warnings = await sweepZfsTransients(mock, 'tank/media', TASK, NOW)
    assert.deepEqual(warnings, [])
    const destroys = mock.calls.filter(c => c.args[0] === 'destroy').map(c => c.args)
    assert.deepEqual(destroys, [['destroy', '-r', `tank/media@${OLDER}`]])
  })

  it('an unreadable snapshot list never fails the run — the sweep is best-effort', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: zfsTransientListArgs('tank/media'),
      result: { stdout: '', stderr: 'dataset does not exist\n', exitCode: 1 },
    })
    assert.deepEqual(await sweepZfsTransients(mock, 'tank/media', TASK, NOW), [])
    assert.equal(mock.calls.filter(c => c.args[0] === 'destroy').length, 0)
  })
})

// ---------------------------------------------------------------------------
//  AHR: one read-only snapshot PER SUBVOLUME, and the mounts that reach them
// ---------------------------------------------------------------------------

describe('AHR transient snapshots (backup2.3, GT-52)', () => {
  const BTRFS = '/usr/bin/btrfs'
  const MOUNT = '/usr/bin/mount'
  const UMOUNT = '/usr/bin/umount'
  const FINDMNT = '/usr/bin/findmnt'

  function pool(name: string): AhrPool {
    // Only the fields the snapshot primitives read are meaningful here.
    return {
      name,
      mountpoint: `/mnt/anas-ahr/${name}`,
      mounted: true,
      subvolLayout: true,
      lv: { name: 'data' },
    } as unknown as AhrPool
  }

  async function withTempRuntime<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'anas-backup23-'))
    try {
      return await fn(dir)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  function ahrMock(): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: FINDMNT, result: { stdout: '', stderr: '', exitCode: 1 } })
    mock.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    return mock
  }

  it('the ROOT snapshot is a read-only snapshot of @data, under an on-demand top-level mount', async () => {
    await withTempRuntime(async (runtimeDir) => {
      const mock = ahrMock()
      const p = pool('ahr1')
      const taken = await takeAhrTransient(mock, p, LABEL, undefined, () => {}, { runtimeDir })
      const top = join(runtimeDir, 'ahr1.toplevel')
      assert.deepEqual(mock.calls.filter(c => c.command === BTRFS).map(c => c.args), [
        ['subvolume', 'snapshot', '-r', join(top, '@data'), join(top, '@snapshots', LABEL)],
      ])
      // Mounted top-level for the op, and unmounted again — nothing stays mounted.
      assert.deepEqual(
        mock.calls.filter(c => c.command === MOUNT).map(c => c.args),
        [['-t', 'btrfs', '-o', 'subvolid=5', '/dev/ahr1/data', top]],
      )
      assert.deepEqual(mock.calls.filter(c => c.command === UMOUNT).map(c => c.args), [['--', top]])
      assert.equal(taken.backend, 'ahr')
      assert.equal(taken.full, `ahr1:@snapshots/${LABEL}`)
    })
  })

  it('a NESTED subvolume gets its OWN snapshot from @data/<path> — a single @data snapshot loses it', async () => {
    // GT-52/55: a read-only btrfs snapshot leaves each nested subvolume an EMPTY
    // placeholder, and `--all-file-systems` cannot rescue it. One snapshot per
    // subvolume is the correctness requirement, not an optimisation.
    await withTempRuntime(async (runtimeDir) => {
      const mock = ahrMock()
      const top = join(runtimeDir, 'ahr1.toplevel')
      await takeAhrTransient(mock, pool('ahr1'), `${LABEL}__photos_sub`, 'photos/sub', () => {}, { runtimeDir })
      assert.deepEqual(mock.calls.filter(c => c.command === BTRFS).map(c => c.args), [
        [
          'subvolume',
          'snapshot',
          '-r',
          join(top, '@data', 'photos/sub'),
          join(top, '@snapshots', `${LABEL}__photos_sub`),
        ],
      ])
    })
  })

  it('withTopLevelMounts holds every pool at once and tears them down in reverse', async () => {
    await withTempRuntime(async (runtimeDir) => {
      const mock = ahrMock()
      const pools = [pool('ahr1'), pool('ahr2')]
      const seen = await withTopLevelMounts(mock, pools, async (byPool) => {
        // Both are mounted at the SAME time — one pbc invocation covers every
        // archive of a task, so every AHR root has to be reachable together.
        assert.deepEqual([...byPool.keys()], ['ahr1', 'ahr2'])
        return [...byPool.values()]
      }, { runtimeDir })
      assert.deepEqual(seen, [join(runtimeDir, 'ahr1.toplevel'), join(runtimeDir, 'ahr2.toplevel')])
      assert.deepEqual(mock.calls.filter(c => c.command === MOUNT).map(c => c.args.at(-1)), [
        join(runtimeDir, 'ahr1.toplevel'),
        join(runtimeDir, 'ahr2.toplevel'),
      ])
      assert.deepEqual(mock.calls.filter(c => c.command === UMOUNT).map(c => c.args.at(-1)), [
        join(runtimeDir, 'ahr2.toplevel'),
        join(runtimeDir, 'ahr1.toplevel'),
      ])
    })
  })

  it('plannedTopLevel names the mount BEFORE anything is mounted (so the argv is knowable)', () => {
    assert.equal(plannedTopLevel(pool('ahr1'), { runtimeDir: '/tmp/x' }), '/tmp/x/ahr1.toplevel')
  })

  it('the AHR sweep deletes only THIS task\'s older transients, subvolume suffixes included', async () => {
    await withTempRuntime(async (runtimeDir) => {
      const mock = ahrMock()
      const p = pool('ahr1')
      const older = formatTransientBackupSnapshot(TASK, new Date(NOW.getTime() - 3600_000))
      // `btrfs subvolume list` output shape: `ID n gen g top level t path <p>`.
      const rows = [
        `ID 256 gen 1 top level 5 path @snapshots/${older}`,
        `ID 257 gen 1 top level 5 path @snapshots/${older}__photos`,
        `ID 258 gen 1 top level 5 path @snapshots/anas-backup-some-other-task-1000000000`,
        `ID 259 gen 1 top level 5 path @snapshots/anas-daily-2026-08-20T020000Z`,
        `ID 260 gen 1 top level 5 path @data`,
        '',
      ].join('\n')
      mock.addFixture({ command: BTRFS, args: ['subvolume', 'list', p.mountpoint], result: { stdout: rows, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-s', p.mountpoint], result: { stdout: rows, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-r', p.mountpoint], result: { stdout: rows, stderr: '', exitCode: 0 } })

      const warnings = await sweepAhrTransients(mock, p, TASK, NOW, () => {}, { runtimeDir })
      assert.deepEqual(warnings, [])
      const deletes = mock.calls
        .filter(c => c.command === BTRFS && c.args[1] === 'delete')
        .map(c => (c.args[2] as string).split('@snapshots/')[1])
      assert.deepEqual(deletes, [older, `${older}__photos`])
    })
  })
})
