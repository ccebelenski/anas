import type { AhrPool, SnapshotSchedule, SnapshotTarget } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { HELD_NAMES_TOTAL, PRUNED_NAMES_TOTAL } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { formatScheduledName } from '../snapshot-naming.js'
import { snapshotNotifyOutcome } from '../snapshot-notify.js'
import {
  listScheduledSnapshots,
  parseZfsScheduledSnapshots,
  parseZfsTreeSnapshots,
  planRecursivePrune,
  pruneRecursiveSchedule,
  pruneSnapshots,
  recursiveRunResult,
  takeSnapshot,
} from '../snapshot-schedules.js'

const ZFS = '/usr/sbin/zfs'
const BTRFS = '/usr/bin/btrfs'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const GIB = 1024 ** 3

const ZFS_TARGET: SnapshotTarget = { kind: 'zfs', dataset: 'tank/media' }
const AHR_TARGET: SnapshotTarget = { kind: 'ahr', pool: 'tank' }
const NOW = new Date('2026-07-26T14:23:01.000Z')
const STAMP = '2026-07-26T142301Z'

function mkPool(over: Partial<AhrPool> = {}): AhrPool {
  return {
    name: 'tank',
    ahrType: 'ahr1',
    mountpoint: '/mnt/anas-ahr/tank',
    mounted: true,
    disks: [],
    arrays: [],
    vg: { name: 'tank', sizeBytes: 5 * GIB, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 5 * GIB },
    capacity: {
      rawBytes: 0,
      usableBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      redundancyOverheadBytes: 0,
      unprotectedWastedBytes: 0,
      pendingBytes: 0,
    },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
    ...over,
  }
}

describe('takeSnapshot — uniform, dispatches by target.kind', () => {
  it('ZFS: zfs snapshot <ds>@anas-<bucket>-<utc>', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await takeSnapshot(executor, ZFS_TARGET, 'daily', { now: NOW })
    assert.deepEqual(res, { target: ZFS_TARGET, name: `anas-daily-${STAMP}`, bucket: 'daily' })
    assert.deepEqual(executor.calls[0], { command: ZFS, args: ['snapshot', `tank/media@anas-daily-${STAMP}`] })
  })

  it('ZFS recursive adds -r', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true })
    assert.deepEqual(executor.calls[0], { command: ZFS, args: ['snapshot', '-r', `tank/media@anas-hourly-${STAMP}`] })
  })

  it('ZFS recursive with exclude (snapx.1): zfs list the tree, then ONE zfs snapshot of the rest', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-H', '-o', 'name', '-r', '-t', 'filesystem,volume', 'tank/media'],
      result: {
        stdout: ['tank/media', 'tank/media/movies', 'tank/media/scratch', 'tank/media/scratch/tmp', 'tank/media/tv'].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    })
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true, exclude: ['tank/media/scratch'] })
    assert.equal(res.name, `anas-hourly-${STAMP}`)
    assert.equal(executor.calls.length, 2)
    assert.deepEqual(executor.calls[0], { command: ZFS, args: ['list', '-H', '-o', 'name', '-r', '-t', 'filesystem,volume', 'tank/media'] })
    assert.deepEqual(executor.calls[1], {
      command: ZFS,
      args: ['snapshot', `tank/media@anas-hourly-${STAMP}`, `tank/media/movies@anas-hourly-${STAMP}`, `tank/media/tv@anas-hourly-${STAMP}`],
    })
  })

  it('ZFS recursive with an EMPTY exclude stays the unchanged -r argv (snapx.1)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true, exclude: [] })
    assert.deepEqual(executor.calls, [{ command: ZFS, args: ['snapshot', '-r', `tank/media@anas-hourly-${STAMP}`] }])
  })

  it('ZFS exclude without recursive is ignored by the service (the schema refuses it upstream)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, exclude: ['tank/media/scratch'] })
    assert.deepEqual(executor.calls, [{ command: ZFS, args: ['snapshot', `tank/media@anas-hourly-${STAMP}`] }])
  })

  it('AHR: read-only btrfs snapshot @data → @snapshots/anas-<bucket>-<utc> (reuses 11.12)', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'anas-sched-'))
    try {
      const executor = new MockExecutor()
      executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await takeSnapshot(executor, AHR_TARGET, 'daily', { now: NOW, pool: mkPool(), runtimeDir })
      assert.deepEqual(res, { target: AHR_TARGET, name: `anas-daily-${STAMP}`, bucket: 'daily' })
      const top = join(runtimeDir, 'tank.toplevel')
      assert.deepEqual(executor.calls[0], { command: MOUNT, args: ['-t', 'btrfs', '-o', 'subvolid=5', '/dev/tank/tank-vol', top] })
      assert.deepEqual(executor.calls[1], {
        command: BTRFS,
        args: ['subvolume', 'snapshot', '-r', join(top, '@data'), join(top, '@snapshots', `anas-daily-${STAMP}`)],
      })
      assert.deepEqual(executor.calls[2], { command: UMOUNT, args: ['--', top] })
    }
    finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('AHR without a resolved pool is a programming error', async () => {
    const executor = new MockExecutor()
    await assert.rejects(() => takeSnapshot(executor, AHR_TARGET, 'daily', { now: NOW }), /requires the resolved pool/)
  })
})

describe('parseZfsScheduledSnapshots — held + source marking', () => {
  it('parses name/creation/userrefs; marks anas vs other and held', () => {
    // Real `zfs list -t snapshot -Hp -o name,creation,userrefs tank/media` shape:
    // tab-delimited, creation as epoch seconds, userrefs as an integer.
    const stdout = [
      'tank/media@anas-daily-2026-07-26T000000Z\t1769385600\t0',
      'tank/media@anas-daily-2026-07-22T000000Z\t1769040000\t1', // HELD (replication base)
      'tank/media@nightly-2026-07-14\t1768348800\t0', // manual → other
    ].join('\n')
    const snaps = parseZfsScheduledSnapshots(ZFS_TARGET, stdout)
    assert.equal(snaps.length, 3)
    assert.deepEqual(snaps[0], {
      name: 'anas-daily-2026-07-26T000000Z',
      target: ZFS_TARGET,
      bucket: 'daily',
      createdAt: new Date(1769385600 * 1000).toISOString(),
      held: false,
      source: 'anas',
    })
    assert.equal(snaps[1].held, true)
    assert.equal(snaps[1].source, 'anas')
    assert.equal(snaps[2].source, 'other')
    assert.equal(snaps[2].bucket, null)
  })

  it('ignores blank lines', () => {
    assert.deepEqual(parseZfsScheduledSnapshots(ZFS_TARGET, '\n\n'), [])
  })
})

describe('listScheduledSnapshots — uniform inventory', () => {
  it('ZFS reads zfs list -t snapshot -Hp with the right argv', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', 'tank/media'],
      result: { stdout: 'tank/media@anas-hourly-2026-07-26T140000Z\t1769436000\t0\n', stderr: '', exitCode: 0 },
    })
    const snaps = await listScheduledSnapshots(executor, ZFS_TARGET)
    assert.equal(snaps.length, 1)
    assert.equal(snaps[0].source, 'anas')
    assert.equal(snaps[0].bucket, 'hourly')
  })

  it('AHR reads @snapshots via the 11.12 list, marks source, never held', async () => {
    const executor = new MockExecutor()
    // listAhrSnapshots does three btrfs subvolume list passes against the live @data mount.
    executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '/mnt/anas-ahr/tank'], result: {
      stdout: [
        'ID 258 gen 16 top level 257 path @snapshots/anas-daily-2026-07-26T000000Z',
        'ID 259 gen 13 top level 257 path @snapshots/before-upgrade',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-s', '/mnt/anas-ahr/tank'], result: {
      stdout: [
        'ID 258 gen 16 cgen 12 top level 257 otime 2026-07-26 00:00:00 path @snapshots/anas-daily-2026-07-26T000000Z',
        'ID 259 gen 13 cgen 13 top level 257 otime 2026-07-20 12:00:00 path @snapshots/before-upgrade',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-r', '/mnt/anas-ahr/tank'], result: {
      stdout: [
        'ID 258 gen 12 top level 257 path @snapshots/anas-daily-2026-07-26T000000Z',
        'ID 259 gen 13 top level 257 path @snapshots/before-upgrade',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    const snaps = await listScheduledSnapshots(executor, AHR_TARGET, { pool: mkPool() })
    const byName = new Map(snaps.map(s => [s.name, s]))
    assert.equal(byName.get('anas-daily-2026-07-26T000000Z')!.source, 'anas')
    assert.equal(byName.get('anas-daily-2026-07-26T000000Z')!.bucket, 'daily')
    assert.equal(byName.get('before-upgrade')!.source, 'other')
    assert.ok(snaps.every(s => s.held === false)) // btrfs snapshots are never held
  })
})

describe('pruneSnapshots — ZFS held-skip + source-filter', () => {
  it('destroys over-retention anas snapshots, SKIPS the held one, leaves manual untouched', async () => {
    const executor = new MockExecutor()
    // Inventory: 3 anas dailies (one held) + a manual non-anas snapshot.
    const listArgs = ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', 'tank/media']
    executor.addFixture({ command: ZFS, args: listArgs, result: {
      stdout: [
        'tank/media@anas-daily-2026-07-26T000000Z\t1769385600\t0', // newest — kept
        'tank/media@anas-daily-2026-07-25T000000Z\t1769299200\t0', // over-retention — prune
        'tank/media@anas-daily-2026-07-22T000000Z\t1769040000\t1', // HELD — skip
        'tank/media@nightly-2026-07-14\t1768348800\t0', // manual — never touched
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    // The belt-and-suspenders per-snapshot userrefs re-check: the 25th is unheld.
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'userrefs', 'tank/media@anas-daily-2026-07-25T000000Z'],
      result: { stdout: '0\n', stderr: '', exitCode: 0 },
    })
    executor.addFixture({ command: ZFS, args: ['destroy', 'tank/media@anas-daily-2026-07-25T000000Z'], result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await pruneSnapshots(executor, ZFS_TARGET, { daily: 1 }, { now: NOW })

    // Exactly the 25th was destroyed.
    assert.deepEqual(res.pruned.map(s => s.name), ['anas-daily-2026-07-25T000000Z'])
    // The held 22nd is surfaced as intentionally retained.
    assert.deepEqual(res.skippedHeld.map(s => s.name), ['anas-daily-2026-07-22T000000Z'])
    // Only ONE destroy call, and it was NOT the held one or the manual one.
    const destroys = executor.calls.filter(c => c.command === ZFS && c.args[0] === 'destroy')
    assert.equal(destroys.length, 1)
    assert.deepEqual(destroys[0].args, ['destroy', 'tank/media@anas-daily-2026-07-25T000000Z'])
    assert.ok(!destroys.some(c => c.args[1].includes('2026-07-22'))) // held never destroyed
    assert.ok(!destroys.some(c => c.args[1].includes('nightly'))) // manual never destroyed
  })

  it('a hold taken AFTER the inventory read is caught by the re-check and NOT destroyed', async () => {
    const executor = new MockExecutor()
    const listArgs = ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', 'tank/media']
    executor.addFixture({ command: ZFS, args: listArgs, result: {
      stdout: [
        'tank/media@anas-daily-2026-07-26T000000Z\t1769385600\t0',
        'tank/media@anas-daily-2026-07-25T000000Z\t1769299200\t0', // unheld at list time
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    // But by destroy time it is now held (userrefs=1) — the race the re-check guards.
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'userrefs', 'tank/media@anas-daily-2026-07-25T000000Z'],
      result: { stdout: '1\n', stderr: '', exitCode: 0 },
    })
    const res = await pruneSnapshots(executor, ZFS_TARGET, { daily: 1 }, { now: NOW })
    assert.deepEqual(res.pruned, [])
    assert.deepEqual(res.skippedHeld.map(s => s.name), ['anas-daily-2026-07-25T000000Z'])
    assert.equal(executor.calls.filter(c => c.args[0] === 'destroy').length, 0)
  })
})

describe('pruneSnapshots — AHR', () => {
  it('deletes the over-retention anas snapshots, leaves the newest + AHR-manual untouched', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'anas-sched-'))
    try {
      const executor = new MockExecutor()
      // Inventory via the live @data mount: 2 anas + 1 AHR-manual.
      executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '/mnt/anas-ahr/tank'], result: {
        stdout: [
          'ID 258 gen 16 top level 257 path @snapshots/anas-daily-2026-07-26T000000Z',
          'ID 259 gen 16 top level 257 path @snapshots/anas-daily-2026-07-25T000000Z',
          'ID 260 gen 13 top level 257 path @snapshots/before-upgrade',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } })
      executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-s', '/mnt/anas-ahr/tank'], result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-r', '/mnt/anas-ahr/tank'], result: { stdout: '', stderr: '', exitCode: 0 } })
      // The on-demand top-level mount + delete for the prune op.
      executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } }) // catch-all btrfs

      const res = await pruneSnapshots(executor, AHR_TARGET, { daily: 1 }, { now: NOW, pool: mkPool(), runtimeDir })

      // Only the older anas daily (25) is deleted; newest (26) + manual kept.
      assert.deepEqual(res.pruned.map(s => s.name), ['anas-daily-2026-07-25T000000Z'])
      const deletes = executor.calls.filter(c => c.command === BTRFS && c.args[0] === 'subvolume' && c.args[1] === 'delete')
      assert.equal(deletes.length, 1)
      assert.ok(deletes[0].args[2].endsWith(join('@snapshots', 'anas-daily-2026-07-25T000000Z')))
      // The AHR-manual snapshot was never a delete target.
      assert.ok(!deletes.some(c => c.args[2].includes('before-upgrade')))
    }
    finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })
})

// =============================================================================
//  snapprune.1 — retention across a recursive schedule's sweep, per dataset
// =============================================================================

describe('planRecursivePrune / pruneRecursiveSchedule (snapprune.1)', () => {
  const H1 = 'anas-hourly-2026-07-26T100000Z'
  const H2 = 'anas-hourly-2026-07-26T110000Z'
  const H3 = 'anas-hourly-2026-07-26T120000Z'
  const D1 = 'anas-daily-2026-07-25T000000Z'
  const PRUNE_NOW = new Date('2026-07-26T13:00:00.000Z')

  function sched(over: Partial<SnapshotSchedule> = {}): SnapshotSchedule {
    return {
      id: 'hourly-tank',
      name: 'Hourly tank',
      target: { kind: 'zfs', dataset: 'tank' },
      cadence: 'hourly',
      retention: { hourly: 1 },
      recursive: true,
      enabled: true,
      notify: 'on-failure',
      ...over,
    }
  }

  /** `ds@label<TAB>creation<TAB>userrefs<TAB>createtxg` rows; txg = the take. */
  function row(ds: string, label: string, txg: number, userrefs = 0, creation = 1769385600): string {
    return [`${ds}@${label}`, String(creation), String(userrefs), String(txg)].join('\t')
  }

  /** The three takes of a plain `-r` on tank (txg 100/200/300) across a tree. */
  function tree(datasets: string[], extra: string[] = []): string {
    const lines: string[] = []
    for (const ds of datasets) {
      lines.push(row(ds, H1, 100), row(ds, H2, 200), row(ds, H3, 300))
    }
    return [...lines, ...extra].join('\n')
  }

  function plan(stdout: string, schedule = sched(), others: SnapshotSchedule[] = [], complete = true) {
    return planRecursivePrune({
      schedule,
      inventory: parseZfsTreeSnapshots(stdout),
      others: { schedules: others, complete },
      now: PRUNE_NOW,
    })
  }

  const byDs = (plans: ReturnType<typeof plan>, ds: string) => plans.find(p => p.dataset === ds)

  it('a child of a plain recursive schedule converges to the policy count', () => {
    const plans = plan(tree(['tank', 'tank/media', 'tank/media/raw']))
    for (const ds of ['tank', 'tank/media', 'tank/media/raw']) {
      const p = byDs(plans, ds)!
      assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2], ds)
    }
    assert.equal(byDs(plans, 'tank')!.scope, 'target')
    assert.equal(byDs(plans, 'tank/media')!.scope, 'sweep')
    assert.equal(plans[0].dataset, 'tank', 'the target comes first')
  })

  it('a held child snapshot is skipped and reported, never planned for destroy', () => {
    const plans = plan(tree(['tank'], [row('tank/media', H1, 100, 1), row('tank/media', H2, 200), row('tank/media', H3, 300)]))
    const media = byDs(plans, 'tank/media')!
    assert.deepEqual(media.prune.map(s => s.name), [H2])
    assert.deepEqual(media.skippedHeld.map(s => s.name), [H1])
  })

  it('a child keeps the snapshots of OTHER buckets (its own daily schedule\'s)', () => {
    const plans = plan(tree(['tank', 'tank/media'], [row('tank/media', D1, 50)]))
    assert.ok(!byDs(plans, 'tank/media')!.prune.some(s => s.name === D1))
  })

  it('a child another enabled same-bucket schedule covers keeps the MOST generous count', () => {
    const other = sched({ id: 'hourly-media', target: { kind: 'zfs', dataset: 'tank/media' }, recursive: false, retention: { hourly: 2 } })
    const plans = plan(tree(['tank', 'tank/media']), sched(), [other])
    assert.deepEqual(byDs(plans, 'tank/media')!.prune.map(s => s.name), [H1])
    // A DISABLED one does not count.
    const off = plan(tree(['tank', 'tank/media']), sched(), [{ ...other, enabled: false }])
    assert.deepEqual(byDs(off, 'tank/media')!.prune.map(s => s.name).sort(), [H1, H2])
  })

  it('an excluded dataset and its subtree are cleared of this schedule\'s snapshots outright', () => {
    const plans = plan(tree(['tank', 'tank/media', 'tank/backup', 'tank/backup/pc1']), sched({ exclude: ['tank/backup'] }))
    for (const ds of ['tank/backup', 'tank/backup/pc1']) {
      const p = byDs(plans, ds)!
      assert.equal(p.scope, 'excluded')
      assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3], ds)
      assert.equal(p.note, undefined)
    }
  })

  it('an excluded dataset\'s held snapshot is skipped and reported', () => {
    const plans = plan(
      tree(['tank'], [row('tank/backup', H1, 100, 1), row('tank/backup', H2, 200)]),
      sched({ exclude: ['tank/backup'] }),
    )
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name), [H2])
    assert.deepEqual(p.skippedHeld.map(s => s.name), [H1])
  })

  it('an excluded dataset another enabled same-bucket schedule covers is left to it', () => {
    const other = sched({ id: 'hourly-backup', target: { kind: 'zfs', dataset: 'tank/backup' }, recursive: false, retention: { hourly: 48 } })
    const plans = plan(tree(['tank', 'tank/backup']), sched({ exclude: ['tank/backup'] }), [other])
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune, [])
    assert.match(p.note ?? '', /left to schedule 'hourly-backup'/)
    // A DAILY schedule there does not own hourly snapshots — they are cleared.
    const daily = plan(tree(['tank', 'tank/backup']), sched({ exclude: ['tank/backup'] }), [{ ...other, cadence: 'daily' }])
    assert.equal(byDs(daily, 'tank/backup')!.prune.length, 3)
  })

  it('snapshots on an excluded dataset this schedule did not take (received) are left, and said so', () => {
    // Same names, DIFFERENT txg: replicated in, not taken by our -r.
    const plans = plan(
      tree(['tank'], [row('tank/backup', H1, 901), row('tank/backup', H2, 200)]),
      sched({ exclude: ['tank/backup'] }),
    )
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name), [H2])
    assert.equal(p.note, '1 left: not taken by this schedule')
  })

  it('a PVE-owned excluded dataset: provably-own snapshots destroyed, others left', () => {
    const plans = plan(
      tree(['tank', 'tank/guests'], [row('tank/guests', 'anas-hourly-2026-07-26T090000Z', 777)]),
      sched({ exclude: ['tank/guests'] }),
    )
    const p = byDs(plans, 'tank/guests')!
    assert.equal(p.scope, 'excluded')
    assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.equal(p.note, '1 left: not taken by this schedule')
  })

  /** A tree read plus a refusal for each `<ds>@<label>` named; everything else succeeds. */
  function armRefusing(stdout: string, refuse: string[]) {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs,createtxg', '-r', 'tank'],
      result: { stdout, stderr: '', exitCode: 0 },
    })
    for (const full of refuse) {
      executor.addFixture({
        command: ZFS,
        args: ['destroy', full],
        result: { stdout: '', stderr: `cannot destroy '${full}': snapshot has dependent clones\nuse '-R' to destroy the following datasets:`, exitCode: 1 },
      })
    }
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    return executor
  }

  it('a refused destroy on an excluded dataset (PVE-owned or not) is noted and the run goes on', async () => {
    const res = await pruneRecursiveSchedule(armRefusing(tree(['tank', 'tank/guests']), [`tank/guests@${H1}`]), sched({ exclude: ['tank/guests'] }), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    const guests = res.datasets.find(d => d.dataset === 'tank/guests')!
    assert.deepEqual(guests.pruned.map(s => s.name).sort(), [H2, H3])
    assert.equal(guests.refused, 1)
    assert.equal(guests.note, `1 left: destroy refused: cannot destroy 'tank/guests@${H1}': snapshot has dependent clones`)
  })

  it('a refused destroy on a SWEPT child is noted, the run goes on, later datasets are still pruned, and the outcome is a warning', async () => {
    // A clone made from tank/a@H1 — refused every run until the clone goes.
    const executor = armRefusing(tree(['tank', 'tank/a', 'tank/b']), [`tank/a@${H1}`])
    const res = await pruneRecursiveSchedule(executor, sched(), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    const a = res.datasets.find(d => d.dataset === 'tank/a')!
    assert.deepEqual(a.pruned.map(s => s.name), [H2])
    assert.equal(a.refused, 1)
    assert.match(a.note ?? '', /^1 left: destroy refused: cannot destroy 'tank\/a@/)
    // The next dataset after the refusal is still converged.
    const b = res.datasets.find(d => d.dataset === 'tank/b')!
    assert.deepEqual(b.pruned.map(s => s.name).sort(), [H1, H2])
    assert.equal(b.refused, 0)
    const result = recursiveRunResult(sched(), H3, res)
    assert.equal(result.datasets!.find(d => d.dataset === 'tank/a')!.refused, 1)
    assert.equal(result.datasets!.find(d => d.dataset === 'tank/b')!.refused, undefined)
    assert.equal(snapshotNotifyOutcome({ schedule: sched(), result }), 'warning')
  })

  it('a refused destroy on the TARGET still fails the run', async () => {
    await assert.rejects(
      () => pruneRecursiveSchedule(armRefusing(tree(['tank', 'tank/a']), [`tank@${H1}`]), sched(), {
        others: { schedules: [], complete: true },
        now: PRUNE_NOW,
      }),
      /dependent clones/,
    )
  })

  it('a held child snapshot the policy keeps (replication\'s newest) is not reported, and the run is no warning', async () => {
    // tank/a@H3 is held by replication; hourly:1 as-if-unheld keeps it anyway.
    // It takes no slot (GT-7): the newest UNHELD (H2) is kept too.
    const stdout = tree(['tank'], [row('tank/a', H1, 100), row('tank/a', H2, 200), row('tank/a', H3, 300, 1)])
    const plans = plan(stdout)
    const a = byDs(plans, 'tank/a')!
    assert.deepEqual(a.skippedHeld, [])
    assert.deepEqual(a.prune.map(s => s.name), [H1])
    const res = await pruneRecursiveSchedule(armRefusing(stdout, []), sched(), { others: { schedules: [], complete: true }, now: PRUNE_NOW })
    assert.deepEqual(res.skippedHeld, [])
    assert.equal(snapshotNotifyOutcome({ schedule: sched(), result: recursiveRunResult(sched(), H3, res) }), 'success')
  })

  it('held names are capped per dataset like pruned, with heldCount carrying the total', () => {
    const held = Array.from({ length: 120 }, (_, i) => ({
      name: formatScheduledName('hourly', new Date(Date.UTC(2026, 3, 1) + i * 3600_000)),
      target: { kind: 'zfs' as const, dataset: 'tank/a' },
      bucket: 'hourly' as const,
      createdAt: null,
      held: true,
      source: 'anas' as const,
    }))
    const result = recursiveRunResult(sched(), H3, {
      pruned: [],
      skippedHeld: held,
      datasets: [{ dataset: 'tank/a', scope: 'sweep', pruned: [], skippedHeld: held, refused: 0 }],
    })
    assert.equal(result.skippedHeld.length, 50)
    assert.ok(result.skippedHeld.every(n => n.startsWith('tank/a@')))
    assert.equal(result.heldCount, 120)
    assert.equal(result.datasets![0].held, 120)
  })

  it('a 5000-snapshot first run: the result names at most 50 per dataset, carries the count, and serialises under 32 KiB', async () => {
    const labels: string[] = []
    for (let i = 0; i < 2500; i++)
      labels.push(formatScheduledName('hourly', new Date(Date.UTC(2026, 3, 1) + i * 3600_000)))
    const lines: string[] = []
    for (const ds of ['tank', 'tank/a-long-child-dataset-name/with/depth'])
      labels.forEach((l, i) => lines.push(row(ds, l, 1000 + i)))
    const progress: string[] = []
    const res = await pruneRecursiveSchedule(armRefusing(lines.join('\n'), []), sched(), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
      updateProgress: m => progress.push(m),
    })
    assert.equal(res.pruned.length, 4998)
    assert.equal(progress.length, 2, 'one progress line per dataset')
    const result = recursiveRunResult(sched(), labels.at(-1)!, res)
    assert.equal(result.prunedCount, 4998)
    assert.equal(result.pruned.length, 100)
    assert.deepEqual(result.datasets!.map(d => d.pruned), [2499, 2499])
    assert.equal(result.heldCount, 0)
    // What the runner prints to journald (snapshot-task.ts): one line, well under LineMax.
    const line = JSON.stringify({ schedule: 'hourly-tank', result })
    assert.ok(Buffer.byteLength(line) < 32 * 1024, `${Buffer.byteLength(line)} bytes`)
  })

  it('the target keeps its full-policy plan (unchanged)', () => {
    const plans = plan(tree(['tank'], [row('tank', D1, 50)]), sched({ retention: { hourly: 1, daily: 0 } }))
    // daily:0 prunes the daily on the TARGET exactly as a non-recursive schedule would.
    assert.deepEqual(byDs(plans, 'tank')!.prune.map(s => s.name).sort(), [D1, H1, H2].sort())
  })

  it('pruneRecursiveSchedule: one tree read, a held re-check before each destroy, per-dataset results', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs,createtxg', '-r', 'tank'],
      result: { stdout: tree(['tank', 'tank/media']), stderr: '', exitCode: 0 },
    })
    // tank/media@H1 got held between the read and the destroy.
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'userrefs', `tank/media@${H1}`],
      result: { stdout: '1\n', stderr: '', exitCode: 0 },
    })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    const progress: string[] = []
    const res = await pruneRecursiveSchedule(executor, sched(), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
      updateProgress: m => progress.push(m),
    })
    const destroys = executor.calls.filter(c => c.args[0] === 'destroy').map(c => c.args)
    assert.deepEqual(destroys.map(d => d.join(' ')).sort(), [
      `destroy tank/media@${H2}`,
      `destroy tank@${H1}`,
      `destroy tank@${H2}`,
    ])
    assert.equal(destroys.length, 3)
    assert.ok(destroys.every(d => d.length === 2), 'one snapshot per destroy, never -r')
    const media = res.datasets.find(d => d.dataset === 'tank/media')!
    assert.equal(media.pruned.length, 1)
    assert.deepEqual(media.skippedHeld.map(s => s.name), [H1])
    assert.equal(res.pruned.length, 3)
    assert.ok(progress.includes('Pruned tank/media (sweep): 1 destroyed, 1 held'), progress.join(' | '))
    // One progress line per dataset, never one per snapshot.
    assert.deepEqual(progress, ['Pruned tank (target): 2 destroyed', 'Pruned tank/media (sweep): 1 destroyed, 1 held'])
  })

  // ---- snapprune.1 review: gap tests ---------------------------------------

  it('an excluded ONLY child is cleared of this schedule\'s snapshots (the target is the witness)', () => {
    const plans = plan(tree(['tank', 'tank/backup']), sched({ exclude: ['tank/backup'] }))
    assert.equal(plans.length, 2)
    const p = byDs(plans, 'tank/backup')!
    assert.equal(p.scope, 'excluded')
    assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.equal(p.note, undefined)
  })

  it('known gap: an excluded only child whose names the target already pruned keeps them, with the note', () => {
    // The target pruned H1/H2 on an earlier run; only H3 is left as a witness.
    const plans = plan(
      [row('tank', H3, 300), row('tank/backup', H1, 100), row('tank/backup', H2, 200), row('tank/backup', H3, 300)].join('\n'),
      sched({ exclude: ['tank/backup'] }),
    )
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name), [H3])
    assert.equal(p.note, '2 left: not taken by this schedule')
  })

  it('a covering schedule protects an excluded dataset through its OWN recursion, not only as direct target', () => {
    const projects = sched({ id: 'hourly-projects', target: { kind: 'zfs', dataset: 'tank/projects' }, recursive: true, retention: { hourly: 48 } })
    const stdout = tree(['tank', 'tank/projects', 'tank/projects/a'])
    const plans = plan(stdout, sched({ exclude: ['tank/projects'] }), [projects])
    for (const ds of ['tank/projects', 'tank/projects/a']) {
      const p = byDs(plans, ds)!
      assert.deepEqual(p.prune, [], ds)
      assert.equal(p.note, '3 left to schedule \'hourly-projects\'', ds)
    }
    // The covering schedule's OWN exclude takes the child out of its cover:
    // the child is cleared, the dataset it still covers is left to it.
    const narrowed = plan(stdout, sched({ exclude: ['tank/projects'] }), [{ ...projects, exclude: ['tank/projects/a'] }])
    assert.deepEqual(byDs(narrowed, 'tank/projects')!.prune, [])
    assert.deepEqual(byDs(narrowed, 'tank/projects/a')!.prune.map(s => s.name).sort(), [H1, H2, H3])
    // A NON-recursive schedule on tank/projects does not cover its child.
    const flat = plan(stdout, sched({ exclude: ['tank/projects'] }), [{ ...projects, recursive: false }])
    assert.deepEqual(byDs(flat, 'tank/projects/a')!.prune.map(s => s.name).sort(), [H1, H2, H3])
  })

  it('an INCOMPLETE schedule list destroys nothing on excluded datasets; the target still prunes', () => {
    // tank/backup also carries a held one: nothing is destroyed or reported held there.
    const stdout = tree(['tank', 'tank/media', 'tank/backup', 'tank/backup/pc1'], [row('tank/backup', 'anas-hourly-2026-07-26T090000Z', 777, 1)])
    const plans = plan(stdout, sched({ exclude: ['tank/backup'] }), [], false)
    const backup = byDs(plans, 'tank/backup')!
    assert.deepEqual(backup.prune, [])
    assert.deepEqual(backup.skippedHeld, [])
    assert.equal(backup.note, '4 left: schedule list unreadable')
    const pc1 = byDs(plans, 'tank/backup/pc1')!
    assert.deepEqual(pc1.prune, [])
    assert.equal(pc1.note, '3 left: schedule list unreadable')
    assert.deepEqual(byDs(plans, 'tank')!.prune.map(s => s.name).sort(), [H1, H2])
    // Even when the readable part of the list names a covering schedule, the
    // excluded dataset gets the same fail-safe note.
    const covering = sched({ id: 'hourly-backup', target: { kind: 'zfs', dataset: 'tank/backup' }, recursive: false })
    const partial = plan(stdout, sched({ exclude: ['tank/backup'] }), [covering], false)
    assert.equal(byDs(partial, 'tank/backup')!.note, '4 left: schedule list unreadable')
    assert.deepEqual(byDs(partial, 'tank/backup/pc1')!.prune, [])
  })

  it('an INCOMPLETE schedule list leaves swept children unpruned for the run; the target still prunes', () => {
    // tank/media is over retention (3 vs hourly:1) and a held one sits on tank/media/raw.
    const stdout = tree(['tank', 'tank/media'], [row('tank/media/raw', H1, 100, 1), row('tank/media/raw', H2, 200), row('tank/media/raw', H3, 300)])
    const plans = plan(stdout, sched(), [], false)
    for (const ds of ['tank/media', 'tank/media/raw']) {
      const p = byDs(plans, ds)!
      assert.equal(p.scope, 'sweep', ds)
      assert.deepEqual(p.prune, [], ds)
      assert.deepEqual(p.skippedHeld, [], ds)
      assert.equal(p.note, '3 left: schedule list unreadable', ds)
    }
    assert.deepEqual(byDs(plans, 'tank')!.prune.map(s => s.name).sort(), [H1, H2])
    // The same tree on a complete list converges the children.
    const whole = plan(stdout, sched(), [], true)
    assert.deepEqual(byDs(whole, 'tank/media')!.prune.map(s => s.name).sort(), [H1, H2])
  })

  it('a creation-time mismatch leaves the snapshot (same name and txg is not enough)', () => {
    const plans = plan(
      tree(['tank'], [row('tank/backup', H1, 100, 0, 1769385601), row('tank/backup', H2, 200)]),
      sched({ exclude: ['tank/backup'] }),
    )
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name), [H2])
    assert.equal(p.note, '1 left: not taken by this schedule')
  })

  it('a non-ANAS snapshot in the sweep is never a witness', () => {
    // `source` follows the name today, so this guards the invariant should the
    // classification ever change: the witness side requires source 'anas'.
    const inventory = parseZfsTreeSnapshots(tree(['tank'], [row('tank/backup', H1, 100), row('tank/backup', H2, 200)]))
    for (const s of inventory.get('tank')!) {
      if (s.name === H1)
        s.source = 'other'
    }
    const plans = planRecursivePrune({
      schedule: sched({ exclude: ['tank/backup'] }),
      inventory,
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name), [H2])
    assert.equal(p.note, '1 left: not taken by this schedule')
  })

  it('several refused destroys on an excluded dataset are counted in one note', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs,createtxg', '-r', 'tank'],
      result: { stdout: tree(['tank', 'tank/guests']), stderr: '', exitCode: 0 },
    })
    for (const label of [H1, H2]) {
      executor.addFixture({
        command: ZFS,
        args: ['destroy', `tank/guests@${label}`],
        result: { stdout: '', stderr: `cannot destroy 'tank/guests@${label}': snapshot has dependent clones`, exitCode: 1 },
      })
    }
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    const res = await pruneRecursiveSchedule(executor, sched({ exclude: ['tank/guests'] }), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    const guests = res.datasets.find(d => d.dataset === 'tank/guests')!
    assert.deepEqual(guests.pruned.map(s => s.name), [H3])
    // The first reason, then how many more were refused.
    assert.equal(guests.note, `2 left: destroy refused: cannot destroy 'tank/guests@${H1}': snapshot has dependent clones (and 1 more)`)
    assert.equal(guests.refused, 2)
  })

  // ---- 0.4.2 test-review fixes ----------------------------------------------

  /** A tree read where each `<ds>@<label>` named is already gone; the rest succeed. */
  function armGone(stdout: string, gone: string[]) {
    const executor = new MockExecutor()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs,createtxg', '-r', 'tank'],
      result: { stdout, stderr: '', exitCode: 0 },
    })
    for (const full of gone) {
      // The re-check of a vanished snapshot fails (not held) …
      executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', 'userrefs', full], result: { stdout: '', stderr: `cannot open '${full}': dataset does not exist`, exitCode: 1 } })
      // … and the destroy answers the way OpenZFS 2.4 does (verified on the stunt node).
      executor.addFixture({ command: ZFS, args: ['destroy', full], result: { stdout: '', stderr: 'could not find any snapshots to destroy; check snapshot names.\n', exitCode: 1 } })
    }
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    return executor
  }

  it('C3: an already-gone destroy is pruned in EVERY scope — target, swept, excluded — no error, no note, no warning', async () => {
    const gone = [`tank@${H1}`, `tank/a@${H1}`, `tank/backup@${H1}`]
    const res = await pruneRecursiveSchedule(armGone(tree(['tank', 'tank/a', 'tank/backup']), gone), sched({ exclude: ['tank/backup'] }), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    const by = (ds: string) => res.datasets.find(d => d.dataset === ds)!
    assert.deepEqual(by('tank').pruned.map(s => s.name).sort(), [H1, H2])
    assert.deepEqual(by('tank/a').pruned.map(s => s.name).sort(), [H1, H2])
    assert.deepEqual(by('tank/backup').pruned.map(s => s.name).sort(), [H1, H2, H3])
    for (const d of res.datasets) {
      assert.equal(d.refused, 0, d.dataset)
      assert.equal(d.note, undefined, d.dataset)
    }
    const result = recursiveRunResult(sched({ exclude: ['tank/backup'] }), H3, res)
    assert.equal(snapshotNotifyOutcome({ schedule: sched({ exclude: ['tank/backup'] }), result }), 'success')
  })

  it('C3: an already-gone destroy on a NON-recursive prune counts as pruned', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', 'tank/media'], result: {
      stdout: [`tank/media@${H1}\t1769385600\t0`, `tank/media@${H2}\t1769389200\t0`].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: ZFS, args: ['destroy', `tank/media@${H1}`], result: { stdout: '', stderr: 'could not find any snapshots to destroy; check snapshot names.\n', exitCode: 1 } })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    const res = await pruneSnapshots(executor, ZFS_TARGET, { hourly: 1 }, { now: PRUNE_NOW })
    assert.deepEqual(res.pruned.map(s => s.name), [H1])
  })

  it('C3: any OTHER destroy failure on the target still fails the run', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', 'tank/media'], result: {
      stdout: [`tank/media@${H1}\t1769385600\t0`, `tank/media@${H2}\t1769389200\t0`].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: ZFS, args: ['destroy', `tank/media@${H1}`], result: { stdout: '', stderr: 'cannot destroy snapshot: dataset is busy', exitCode: 1 } })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    await assert.rejects(() => pruneSnapshots(executor, ZFS_TARGET, { hourly: 1 }, { now: PRUNE_NOW }), /dataset is busy/)
  })

  it('C2: a first run over 40 children x 100 snapshots keeps the runner line under 40 KiB (total name caps)', async () => {
    const labels: string[] = []
    for (let i = 0; i < 100; i++)
      labels.push(formatScheduledName('hourly', new Date(Date.UTC(2026, 3, 1) + i * 3600_000)))
    const datasets = ['tank', ...Array.from({ length: 40 }, (_, i) => `tank/a-child-dataset-with-a-realistic-name-${String(i).padStart(2, '0')}`)]
    const lines: string[] = []
    for (const ds of datasets)
      labels.forEach((l, i) => lines.push(row(ds, l, 1000 + i)))
    const res = await pruneRecursiveSchedule(armRefusing(lines.join('\n'), []), sched(), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    assert.equal(res.pruned.length, 41 * 99)
    const result = recursiveRunResult(sched(), labels.at(-1)!, res)
    assert.equal(result.pruned.length, PRUNED_NAMES_TOTAL)
    assert.equal(result.prunedCount, 41 * 99)
    assert.equal(result.datasets!.length, 41)
    assert.ok(result.datasets!.every(d => d.pruned === 99), 'per-dataset entries keep their counts')
    // What the runner prints to journald (snapshot-task.ts) — LineMax is 48 KiB.
    const line = JSON.stringify({ schedule: 'hourly-tank', result })
    assert.ok(Buffer.byteLength(line) < 40 * 1024, `${Buffer.byteLength(line)} bytes`)
  })

  it('C2: held names are capped at 100 in all across datasets; heldCount and the per-dataset counts stay whole', () => {
    const datasets = Array.from({ length: 40 }, (_, d) => {
      const held = Array.from({ length: 60 }, (_, i) => ({
        name: formatScheduledName('hourly', new Date(Date.UTC(2026, 3, 1) + i * 3600_000)),
        target: { kind: 'zfs' as const, dataset: `tank/c${d}` },
        bucket: 'hourly' as const,
        createdAt: null,
        held: true,
        source: 'anas' as const,
      }))
      return { dataset: `tank/c${d}`, scope: 'sweep' as const, pruned: [], skippedHeld: held, refused: 0 }
    })
    const result = recursiveRunResult(sched(), H3, { pruned: [], skippedHeld: datasets.flatMap(d => d.skippedHeld), datasets })
    assert.equal(result.skippedHeld.length, HELD_NAMES_TOTAL)
    assert.equal(result.heldCount, 40 * 60)
    assert.ok(result.datasets!.every(d => d.held === 60))
  })

  it('PINNED ruling (C10a): a child\'s own NON-recursive hourly schedule destroys a parent recursive DAILY schedule\'s daily snapshots on that child (absent bucket = keep 0)', async () => {
    // tank (daily, recursive) took D1/D2 on tank/media; tank/media's own
    // hourly schedule ({ hourly: 24 }, no daily count) prunes with its FULL
    // policy, which keeps 0 dailies. The newest-overall guarantee protects an
    // hourly here, not a daily. Pinned as current behaviour, not endorsed.
    const D2 = 'anas-daily-2026-07-26T000000Z'
    const executor = new MockExecutor()
    executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs', 'tank/media'], result: {
      stdout: [D1, D2, H1, H2, H3].map(l => `tank/media@${l}\t1769385600\t0`).join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    const res = await pruneSnapshots(executor, ZFS_TARGET, { hourly: 24 }, { now: PRUNE_NOW })
    assert.deepEqual(res.pruned.map(s => s.name).sort(), [D1, D2].sort())
    const destroys = executor.calls.filter(c => c.args[0] === 'destroy').map(c => c.args[1]).sort()
    assert.deepEqual(destroys, [`tank/media@${D1}`, `tank/media@${D2}`].sort())
  })

  it('PINNED ruling (C10b): an UNHELD replication base on a swept child is pruned by policy — the hold is what protects it', () => {
    // tank/a@H1 was the replication base; its hold is gone (userrefs 0), so
    // nothing marks it — the schedule's hourly:1 prunes it like any other.
    const plans = plan(tree(['tank', 'tank/a']))
    assert.deepEqual(byDs(plans, 'tank/a')!.prune.map(s => s.name).sort(), [H1, H2])
    // With the hold in place the same snapshot is set aside (and reported).
    const held = plan(tree(['tank'], [row('tank/a', H1, 100, 1), row('tank/a', H2, 200), row('tank/a', H3, 300)]))
    assert.deepEqual(byDs(held, 'tank/a')!.prune.map(s => s.name), [H2])
    assert.deepEqual(byDs(held, 'tank/a')!.skippedHeld.map(s => s.name), [H1])
  })
})
