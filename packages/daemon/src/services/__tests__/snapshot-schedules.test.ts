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
  parseZfsStampSources,
  parseZfsTreeSnapshots,
  planZfsSchedulePrune,
  pruneSnapshots,
  pruneZfsSchedule,
  takeSnapshot,
  zfsRunResult,
} from '../snapshot-schedules.js'

const ZFS = '/usr/sbin/zfs'
const BTRFS = '/usr/bin/btrfs'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const GIB = 1024 ** 3

const ZFS_TARGET: SnapshotTarget = { kind: 'zfs', dataset: 'tank/media' }
/** The ident.1 inventory columns (name, creation, userrefs, createtxg, the stamp). */
const COLS = 'name,creation,userrefs,createtxg,anas:schedule'

/**
 * The `zfs get -Hp -t snapshot … -o name,value,source anas:schedule` answer for
 * a list fixture (the ident.1 follow-up reads the stamp WITH its source). A
 * row's stamp column is `<id>` (source local), `<id>|<source>` (e.g.
 * `|received`) or `-` (unset).
 */
function stampsOf(listStdout: string): string {
  return listStdout.split('\n').filter(l => l.trim()).map((l) => {
    const c = l.split('\t')
    const stamp = (c[4] ?? '-').trim()
    if (stamp === '-' || stamp === '')
      return `${c[0]}\t-\t-`
    const [value, source = 'local'] = stamp.split('|')
    return `${c[0]}\t${value}\t${source}`
  }).join('\n')
}

/**
 * A MockExecutor whose stamp-source read answers from the matching inventory
 * fixture (via {@link stampsOf}) — every prune reads both, and the tests below
 * describe a snapshot once, in its list row.
 */
function mockExec(): MockExecutor {
  const ex = new MockExecutor()
  const orig = ex.exec.bind(ex)
  ex.exec = async (command, args, opts) => {
    if (command === ZFS && args[0] === 'get' && args.includes('anas:schedule')) {
      const listArgs = ['list', '-t', 'snapshot', '-Hp', '-o', COLS, ...(args.includes('-r') ? ['-r'] : []), args.at(-1)!]
      const listed = await orig(command, listArgs, opts)
      ex.calls.pop() // the derivation's own list read is not a call the code under test made
      ex.calls.push({ command, args })
      return { ...listed, stdout: stampsOf(listed.stdout) }
    }
    return orig(command, args, opts)
  }
  return ex
}
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
    const executor = mockExec()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await takeSnapshot(executor, ZFS_TARGET, 'daily', { now: NOW })
    assert.deepEqual(res, { target: ZFS_TARGET, name: `anas-daily-${STAMP}`, bucket: 'daily' })
    assert.deepEqual(executor.calls[0], { command: ZFS, args: ['snapshot', `tank/media@anas-daily-${STAMP}`] })
  })

  it('ZFS recursive adds -r', async () => {
    const executor = mockExec()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true })
    assert.deepEqual(executor.calls[0], { command: ZFS, args: ['snapshot', '-r', `tank/media@anas-hourly-${STAMP}`] })
  })

  it('ZFS recursive with exclude (snapx.1): zfs list the tree, then ONE zfs snapshot of the rest', async () => {
    const executor = mockExec()
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
    const executor = mockExec()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true, exclude: [] })
    assert.deepEqual(executor.calls, [{ command: ZFS, args: ['snapshot', '-r', `tank/media@anas-hourly-${STAMP}`] }])
  })

  it('ZFS exclude without recursive is ignored by the service (the schema refuses it upstream)', async () => {
    const executor = mockExec()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, exclude: ['tank/media/scratch'] })
    assert.deepEqual(executor.calls, [{ command: ZFS, args: ['snapshot', `tank/media@anas-hourly-${STAMP}`] }])
  })

  it('ident.1: ZFS with a schedule id stamps -o anas:schedule=<id> in the same verb', async () => {
    const executor = mockExec()
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'daily', { now: NOW, scheduleId: 'daily-media' })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true, scheduleId: 'hourly-tank' })
    assert.deepEqual(executor.calls, [
      { command: ZFS, args: ['snapshot', '-o', 'anas:schedule=daily-media', `tank/media@anas-daily-${STAMP}`] },
      { command: ZFS, args: ['snapshot', '-r', '-o', 'anas:schedule=hourly-tank', `tank/media@anas-hourly-${STAMP}`] },
    ])
  })

  it('ident.1: the exclude expansion stamps every name of its ONE atomic call', async () => {
    const executor = mockExec()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-H', '-o', 'name', '-r', '-t', 'filesystem,volume', 'tank/media'],
      result: { stdout: ['tank/media', 'tank/media/movies', 'tank/media/scratch'].join('\n'), stderr: '', exitCode: 0 },
    })
    executor.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await takeSnapshot(executor, ZFS_TARGET, 'hourly', { now: NOW, recursive: true, exclude: ['tank/media/scratch'], scheduleId: 'h' })
    assert.deepEqual(executor.calls[1], {
      command: ZFS,
      args: ['snapshot', '-o', 'anas:schedule=h', `tank/media@anas-hourly-${STAMP}`, `tank/media/movies@anas-hourly-${STAMP}`],
    })
  })

  it('AHR: read-only btrfs snapshot @data → @snapshots/anas-<bucket>-<utc> (reuses 11.12)', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'anas-sched-'))
    try {
      const executor = mockExec()
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
    const executor = mockExec()
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

  it('ident.1: reads the anas:schedule stamp; `-` is unset', () => {
    const snaps = parseZfsScheduledSnapshots(ZFS_TARGET, [
      'tank/media@anas-daily-2026-07-26T000000Z\t1769385600\t0\t812\tdaily-media',
      'tank/media@anas-daily-2026-07-25T000000Z\t1769299200\t0\t700\t-',
    ].join('\n'))
    assert.equal(snaps[0].schedule, 'daily-media')
    assert.equal(snaps[1].schedule, undefined)
    assert.ok(!('schedule' in snaps[1]), 'an unset stamp adds no key')
  })
})

describe('listScheduledSnapshots — uniform inventory', () => {
  it('ZFS reads zfs list -t snapshot -Hp with the right argv', async () => {
    const executor = mockExec()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, 'tank/media'],
      result: { stdout: 'tank/media@anas-hourly-2026-07-26T140000Z\t1769436000\t0\t9\th\n', stderr: '', exitCode: 0 },
    })
    const snaps = await listScheduledSnapshots(executor, ZFS_TARGET)
    assert.equal(snaps.length, 1)
    assert.equal(snaps[0].source, 'anas')
    assert.equal(snaps[0].bucket, 'hourly')
    assert.equal(snaps[0].schedule, 'h')
  })

  it('AHR reads @snapshots via the 11.12 list, marks source, never held', async () => {
    const executor = mockExec()
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

/** A non-recursive ZFS schedule on tank/media (ident.1: ZFS prunes through pruneZfsSchedule). */
function flatSched(over: Partial<SnapshotSchedule> = {}): SnapshotSchedule {
  return {
    id: 'daily-media',
    name: 'Daily media',
    target: ZFS_TARGET,
    cadence: 'daily',
    retention: { daily: 1 },
    enabled: true,
    notify: 'on-failure',
    ...over,
  }
}

const ALONE = { schedules: [], complete: true }

describe('pruneZfsSchedule (non-recursive) — ZFS held-skip + source-filter', () => {
  it('destroys over-retention anas snapshots, SKIPS the held one, leaves manual untouched', async () => {
    const executor = mockExec()
    // Inventory: 3 anas dailies (one held) + a manual non-anas snapshot.
    const listArgs = ['list', '-t', 'snapshot', '-Hp', '-o', COLS, 'tank/media']
    executor.addFixture({ command: ZFS, args: listArgs, result: {
      stdout: [
        'tank/media@anas-daily-2026-07-26T000000Z\t1769385600\t0\t30\tdaily-media', // newest — kept
        'tank/media@anas-daily-2026-07-25T000000Z\t1769299200\t0\t20\tdaily-media', // over-retention — prune
        'tank/media@anas-daily-2026-07-22T000000Z\t1769040000\t1\t10\tdaily-media', // HELD — skip
        'tank/media@nightly-2026-07-14\t1768348800\t0\t5\t-', // manual — never touched
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

    const res = await pruneZfsSchedule(executor, flatSched(), { others: ALONE, now: NOW })

    // Exactly the 25th was destroyed.
    assert.deepEqual(res.pruned.map(s => s.name), ['anas-daily-2026-07-25T000000Z'])
    // The held 22nd is surfaced as intentionally retained.
    assert.deepEqual(res.skippedHeld.map(s => s.name), ['anas-daily-2026-07-22T000000Z'])
    // Only ONE destroy call, and it was NOT the held one or the manual one.
    const destroys = executor.calls.filter(c => c.command === ZFS && c.args[0] === 'destroy')
    assert.equal(destroys.length, 1)
    assert.deepEqual(destroys[0].args, ['destroy', 'tank/media@anas-daily-2026-07-25T000000Z'])
    // A non-recursive inventory is the dataset alone (no -r).
    assert.ok(executor.calls.some(c => c.args.join(' ') === listArgs.join(' ')))
    // One dataset, nothing noted: the result carries no per-dataset list.
    const result = zfsRunResult(flatSched(), 'anas-daily-2026-07-26T000000Z', res)
    assert.equal(result.datasets, undefined)
  })

  it('a hold taken AFTER the inventory read is caught by the re-check and NOT destroyed', async () => {
    const executor = mockExec()
    const listArgs = ['list', '-t', 'snapshot', '-Hp', '-o', COLS, 'tank/media']
    executor.addFixture({ command: ZFS, args: listArgs, result: {
      stdout: [
        'tank/media@anas-daily-2026-07-26T000000Z\t1769385600\t0\t30\tdaily-media',
        'tank/media@anas-daily-2026-07-25T000000Z\t1769299200\t0\t20\tdaily-media', // unheld at list time
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
    const res = await pruneZfsSchedule(executor, flatSched(), { others: ALONE, now: NOW })
    assert.deepEqual(res.pruned, [])
    assert.deepEqual(res.skippedHeld.map(s => s.name), ['anas-daily-2026-07-25T000000Z'])
    assert.equal(executor.calls.filter(c => c.args[0] === 'destroy').length, 0)
  })

  it('pruneSnapshots refuses a ZFS target (ZFS prunes by stamp)', async () => {
    await assert.rejects(() => pruneSnapshots(mockExec(), ZFS_TARGET, { daily: 1 }, { now: NOW }), /pruneZfsSchedule/)
  })
})

describe('pruneSnapshots — AHR', () => {
  it('deletes the over-retention anas snapshots, leaves the newest + AHR-manual untouched', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'anas-sched-'))
    try {
      const executor = mockExec()
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

describe('planZfsSchedulePrune / pruneZfsSchedule (snapprune.1 + ident.1 stamps)', () => {
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

  /**
   * `ds@label<TAB>creation<TAB>userrefs<TAB>createtxg<TAB>anas:schedule` rows;
   * txg = the take; the stamp defaults to the fired schedule's id (`-` = unset).
   */
  function row(ds: string, label: string, txg: number, userrefs = 0, creation = 1769385600, stamp = 'hourly-tank'): string {
    return [`${ds}@${label}`, String(creation), String(userrefs), String(txg), stamp].join('\t')
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
    return planZfsSchedulePrune({
      schedule,
      inventory: parseZfsTreeSnapshots(stdout, parseZfsStampSources(stampsOf(stdout))),
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

  it('ident.1: two schedules on one dataset each prune only their OWN stamped snapshots', () => {
    // tank/media carries the parent's hourlies AND its own hourly schedule's
    // (stamped hourly-media); the parent's run prunes its own to hourly:1 and
    // leaves every one of the child schedule's — no most-generous count needed.
    const other = sched({ id: 'hourly-media', target: { kind: 'zfs', dataset: 'tank/media' }, recursive: false, retention: { hourly: 2 } })
    const M1 = 'anas-hourly-2026-07-26T100500Z'
    const M2 = 'anas-hourly-2026-07-26T110500Z'
    const M3 = 'anas-hourly-2026-07-26T120500Z'
    const stdout = tree(['tank', 'tank/media'], [M1, M2, M3].map((l, i) => row('tank/media', l, 400 + i, 0, 1769385600, 'hourly-media')))
    const plans = plan(stdout, sched(), [other])
    assert.deepEqual(byDs(plans, 'tank/media')!.prune.map(s => s.name).sort(), [H1, H2])
    assert.equal(byDs(plans, 'tank/media')!.note, undefined)
    // The child schedule's own run, symmetric: its own three, keep 2, the parent's untouched.
    const own = planZfsSchedulePrune({ schedule: other, inventory: parseZfsTreeSnapshots(stdout, parseZfsStampSources(stampsOf(stdout))), others: { schedules: [sched()], complete: true }, now: PRUNE_NOW })
    assert.deepEqual(own.map(p => p.dataset), ['tank/media'])
    assert.deepEqual(own[0].prune.map(s => s.name), [M1])
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

  it('ident.1: on an excluded dataset another schedule covers, this schedule clears ITS stamped snapshots and leaves the other\'s', () => {
    const other = sched({ id: 'hourly-backup', target: { kind: 'zfs', dataset: 'tank/backup' }, recursive: false, retention: { hourly: 48 } })
    const B1 = 'anas-hourly-2026-07-26T100700Z'
    const plans = plan(tree(['tank', 'tank/backup'], [row('tank/backup', B1, 500, 0, 1769385600, 'hourly-backup')]), sched({ exclude: ['tank/backup'] }), [other])
    const p = byDs(plans, 'tank/backup')!
    assert.equal(p.scope, 'excluded')
    assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.equal(p.note, undefined)
  })
  it('ident.1: snapshots on an excluded dataset with another stamp or none (received) are left; the unstamped are noted', () => {
    const plans = plan(
      tree(['tank'], [
        row('tank/backup', H1, 901, 0, 1769385600, 'sender-sched'), // received with the sender's stamp
        row('tank/backup', H2, 902, 0, 1769385600, '-'), // received without properties
        row('tank/backup', H3, 300),
      ]),
      sched({ exclude: ['tank/backup'] }),
    )
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name), [H3])
    assert.equal(p.note, '1 left: unstamped, outside this schedule\'s sweep')
  })
  it('a PVE-owned excluded dataset: this schedule\'s stamped snapshots destroyed, unstamped left', () => {
    const plans = plan(
      tree(['tank', 'tank/guests'], [row('tank/guests', 'anas-hourly-2026-07-26T090000Z', 777, 0, 1769385600, '-')]),
      sched({ exclude: ['tank/guests'] }),
    )
    const p = byDs(plans, 'tank/guests')!
    assert.equal(p.scope, 'excluded')
    assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.equal(p.note, '1 left: unstamped, outside this schedule\'s sweep')
  })
  /** A tree read plus a refusal for each `<ds>@<label>` named; everything else succeeds. */
  function armRefusing(stdout: string, refuse: string[]) {
    const executor = mockExec()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, '-r', 'tank'],
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
    const res = await pruneZfsSchedule(armRefusing(tree(['tank', 'tank/guests']), [`tank/guests@${H1}`]), sched({ exclude: ['tank/guests'] }), {
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
    const res = await pruneZfsSchedule(executor, sched(), {
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
    const result = zfsRunResult(sched(), H3, res)
    assert.equal(result.datasets!.find(d => d.dataset === 'tank/a')!.refused, 1)
    assert.equal(result.datasets!.find(d => d.dataset === 'tank/b')!.refused, undefined)
    assert.equal(snapshotNotifyOutcome({ schedule: sched(), result }), 'warning')
  })

  it('a refused destroy on the TARGET still fails the run', async () => {
    await assert.rejects(
      () => pruneZfsSchedule(armRefusing(tree(['tank', 'tank/a']), [`tank@${H1}`]), sched(), {
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
    const res = await pruneZfsSchedule(armRefusing(stdout, []), sched(), { others: { schedules: [], complete: true }, now: PRUNE_NOW })
    assert.deepEqual(res.skippedHeld, [])
    assert.equal(snapshotNotifyOutcome({ schedule: sched(), result: zfsRunResult(sched(), H3, res) }), 'success')
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
    const result = zfsRunResult(sched(), H3, {
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
    const res = await pruneZfsSchedule(armRefusing(lines.join('\n'), []), sched(), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
      updateProgress: m => progress.push(m),
    })
    assert.equal(res.pruned.length, 4998)
    assert.equal(progress.length, 2, 'one progress line per dataset')
    const result = zfsRunResult(sched(), labels.at(-1)!, res)
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

  it('pruneZfsSchedule: one tree read, a held re-check before each destroy, per-dataset results', async () => {
    const executor = mockExec()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, '-r', 'tank'],
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
    const res = await pruneZfsSchedule(executor, sched(), {
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

  it('an excluded ONLY child is cleared of this schedule\'s stamped snapshots', () => {
    const plans = plan(tree(['tank', 'tank/backup']), sched({ exclude: ['tank/backup'] }))
    assert.equal(plans.length, 2)
    const p = byDs(plans, 'tank/backup')!
    assert.equal(p.scope, 'excluded')
    assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.equal(p.note, undefined)
  })
  it('ident.1 closes the witness gap: an excluded child is cleared even when the target already pruned those names', () => {
    const plans = plan(
      [row('tank', H3, 300), row('tank/backup', H1, 100), row('tank/backup', H2, 200), row('tank/backup', H3, 300)].join('\n'),
      sched({ exclude: ['tank/backup'] }),
    )
    const p = byDs(plans, 'tank/backup')!
    assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.equal(p.note, undefined)
  })
  it('ident.1: a schedule covering an excluded subtree through its own recursion keeps ITS stamped snapshots there', () => {
    const projects = sched({ id: 'hourly-projects', target: { kind: 'zfs', dataset: 'tank/projects' }, recursive: true, retention: { hourly: 48 } })
    const P1 = 'anas-hourly-2026-07-26T100900Z'
    const theirs = ['tank/projects', 'tank/projects/a'].map(ds => row(ds, P1, 600, 0, 1769385600, 'hourly-projects'))
    const stdout = tree(['tank', 'tank/projects', 'tank/projects/a'], theirs)
    const plans = plan(stdout, sched({ exclude: ['tank/projects'] }), [projects])
    for (const ds of ['tank/projects', 'tank/projects/a']) {
      const p = byDs(plans, ds)!
      assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2, H3], ds)
      assert.ok(!p.prune.some(s => s.name === P1), ds)
    }
    // The covering schedule's own run plans only its own stamp in its sweep.
    const own = planZfsSchedulePrune({ schedule: projects, inventory: parseZfsTreeSnapshots(stdout, parseZfsStampSources(stampsOf(stdout))), others: { schedules: [sched({ exclude: ['tank/projects'] })], complete: true }, now: PRUNE_NOW })
    assert.ok(own.every(p => p.prune.every(s => s.name === P1)))
  })
  it('an INCOMPLETE schedule list still clears this schedule\'s STAMPED snapshots on excluded datasets; unstamped stay', () => {
    // tank/backup also carries an unstamped one and a held stamped one.
    const stdout = tree(['tank', 'tank/media', 'tank/backup', 'tank/backup/pc1'], [
      row('tank/backup', 'anas-hourly-2026-07-26T090000Z', 777, 1),
      row('tank/backup', 'anas-hourly-2026-07-26T080000Z', 700, 0, 1769385600, '-'),
    ])
    const plans = plan(stdout, sched({ exclude: ['tank/backup'] }), [], false)
    const backup = byDs(plans, 'tank/backup')!
    assert.deepEqual(backup.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.deepEqual(backup.skippedHeld.map(s => s.name), ['anas-hourly-2026-07-26T090000Z'])
    assert.equal(backup.note, '1 left: unstamped, outside this schedule\'s sweep')
    assert.deepEqual(byDs(plans, 'tank/backup/pc1')!.prune.map(s => s.name).sort(), [H1, H2, H3])
    assert.deepEqual(byDs(plans, 'tank')!.prune.map(s => s.name).sort(), [H1, H2])
  })
  it('an INCOMPLETE schedule list: stamped snapshots are pruned everywhere, UNSTAMPED ones nowhere (noted — a warning)', async () => {
    const OLD = 'anas-hourly-2026-07-26T050000Z'
    const stdout = tree(['tank', 'tank/media'], [row('tank', OLD, 50, 0, 1769385600, '-'), row('tank/media', OLD, 50, 0, 1769385600, '-')])
    const plans = plan(stdout, sched(), [], false)
    for (const ds of ['tank', 'tank/media']) {
      const p = byDs(plans, ds)!
      assert.deepEqual(p.prune.map(s => s.name).sort(), [H1, H2], ds)
      assert.equal(p.note, '1 left: schedule list unreadable', ds)
    }
    // The same tree on a complete list, this schedule the only one: legacy converges.
    const whole = plan(stdout, sched(), [], true)
    assert.deepEqual(byDs(whole, 'tank/media')!.prune.map(s => s.name).sort(), [OLD, H1, H2].sort())
    assert.equal(byDs(whole, 'tank/media')!.note, undefined)
    // The fail-safe note makes the run a warning.
    const res = await pruneZfsSchedule(armRefusing(stdout, []), sched(), { others: { schedules: [], complete: false }, now: PRUNE_NOW })
    assert.equal(snapshotNotifyOutcome({ schedule: sched(), result: zfsRunResult(sched(), H3, res) }), 'warning')
  })
  it('ident.1: a snapshot stamped with ANOTHER id is never a candidate, on any scope — even a deleted schedule\'s', () => {
    const plans = plan(tree(['tank'], [
      row('tank', 'anas-hourly-2026-07-26T050000Z', 50, 0, 1769385600, 'deleted-sched'),
      row('tank/a', 'anas-hourly-2026-07-26T050000Z', 50, 0, 1769385600, 'deleted-sched'),
    ]))
    assert.deepEqual(byDs(plans, 'tank')!.prune.map(s => s.name).sort(), [H1, H2])
    assert.equal(byDs(plans, 'tank/a'), undefined, 'nothing to do on tank/a')
  })

  it('ident.1 legacy: unstamped snapshots converge where this is the ONLY enabled schedule covering the dataset', () => {
    const OLD = 'anas-hourly-2026-07-26T050000Z'
    const legacy = [row('tank/a', OLD, 50, 0, 1769385600, '-')]
    // Alone (a disabled schedule there does not count): the unstamped one is pruned.
    const daily = sched({ id: 'daily-a', target: { kind: 'zfs', dataset: 'tank/a' }, recursive: false, cadence: 'daily', retention: { daily: 7 } })
    const alone = plan(tree(['tank', 'tank/a'], legacy), sched(), [{ ...daily, enabled: false }])
    assert.deepEqual(byDs(alone, 'tank/a')!.prune.map(s => s.name).sort(), [OLD, H1, H2].sort())
    // Another ENABLED schedule covers tank/a (any cadence): left, noted.
    const shared = plan(tree(['tank', 'tank/a'], legacy), sched(), [daily])
    assert.deepEqual(byDs(shared, 'tank/a')!.prune.map(s => s.name).sort(), [H1, H2])
    assert.equal(byDs(shared, 'tank/a')!.note, '1 left: unstamped, more than one schedule here')
    // The target is not covered by that schedule: its legacy still converges.
    const onTarget = plan(tree(['tank', 'tank/a'], [row('tank', OLD, 50, 0, 1769385600, '-')]), sched(), [daily])
    assert.ok(byDs(onTarget, 'tank')!.prune.some(s => s.name === OLD))
  })

  it('ident.1: a bucket absent from the policy is left alone — stamped or not (no more "keep 0")', () => {
    const W = 'anas-weekly-2026-07-19T000000Z'
    const plans = plan(tree(['tank'], [row('tank', W, 40), row('tank', 'anas-weekly-2026-07-12T000000Z', 30, 0, 1769385600, '-')]))
    assert.ok(!byDs(plans, 'tank')!.prune.some(s => s.bucket === 'weekly'))
    assert.equal(byDs(plans, 'tank')!.note, undefined)
  })
  it('several refused destroys on an excluded dataset are counted in one note', async () => {
    const executor = mockExec()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, '-r', 'tank'],
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
    const res = await pruneZfsSchedule(executor, sched({ exclude: ['tank/guests'] }), {
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
    const executor = mockExec()
    executor.addFixture({
      command: ZFS,
      args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, '-r', 'tank'],
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
    const res = await pruneZfsSchedule(armGone(tree(['tank', 'tank/a', 'tank/backup']), gone), sched({ exclude: ['tank/backup'] }), {
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
    const result = zfsRunResult(sched({ exclude: ['tank/backup'] }), H3, res)
    assert.equal(snapshotNotifyOutcome({ schedule: sched({ exclude: ['tank/backup'] }), result }), 'success')
  })

  it('C3: an already-gone destroy on a NON-recursive prune counts as pruned', async () => {
    const executor = mockExec()
    executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, 'tank/media'], result: {
      stdout: [`tank/media@${H1}\t1769385600\t0\t1\thourly-media`, `tank/media@${H2}\t1769389200\t0\t2\thourly-media`].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: ZFS, args: ['destroy', `tank/media@${H1}`], result: { stdout: '', stderr: 'could not find any snapshots to destroy; check snapshot names.\n', exitCode: 1 } })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    const res = await pruneZfsSchedule(executor, flatSched({ id: 'hourly-media', cadence: 'hourly', retention: { hourly: 1 } }), { others: ALONE, now: PRUNE_NOW })
    assert.deepEqual(res.pruned.map(s => s.name), [H1])
  })
  it('C3: any OTHER destroy failure on the target still fails the run', async () => {
    const executor = mockExec()
    executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, 'tank/media'], result: {
      stdout: [`tank/media@${H1}\t1769385600\t0\t1\thourly-media`, `tank/media@${H2}\t1769389200\t0\t2\thourly-media`].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: ZFS, args: ['destroy', `tank/media@${H1}`], result: { stdout: '', stderr: 'cannot destroy snapshot: dataset is busy', exitCode: 1 } })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    await assert.rejects(() => pruneZfsSchedule(executor, flatSched({ id: 'hourly-media', cadence: 'hourly', retention: { hourly: 1 } }), { others: ALONE, now: PRUNE_NOW }), /dataset is busy/)
  })
  it('C2: a first run over 40 children x 100 snapshots keeps the runner line under 40 KiB (total name caps)', async () => {
    const labels: string[] = []
    for (let i = 0; i < 100; i++)
      labels.push(formatScheduledName('hourly', new Date(Date.UTC(2026, 3, 1) + i * 3600_000)))
    const datasets = ['tank', ...Array.from({ length: 40 }, (_, i) => `tank/a-child-dataset-with-a-realistic-name-${String(i).padStart(2, '0')}`)]
    const lines: string[] = []
    for (const ds of datasets)
      labels.forEach((l, i) => lines.push(row(ds, l, 1000 + i)))
    const res = await pruneZfsSchedule(armRefusing(lines.join('\n'), []), sched(), {
      others: { schedules: [], complete: true },
      now: PRUNE_NOW,
    })
    assert.equal(res.pruned.length, 41 * 99)
    const result = zfsRunResult(sched(), labels.at(-1)!, res)
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
    const result = zfsRunResult(sched(), H3, { pruned: [], skippedHeld: datasets.flatMap(d => d.skippedHeld), datasets })
    assert.equal(result.skippedHeld.length, HELD_NAMES_TOTAL)
    assert.equal(result.heldCount, 40 * 60)
    assert.ok(result.datasets!.every(d => d.held === 60))
  })

  it('ident.1 (was PINNED C10a): a child\'s own NON-recursive hourly schedule leaves a parent recursive DAILY schedule\'s dailies on that child', async () => {
    // tank (daily, recursive, id daily-tank) took D1/D2 on tank/media; the
    // child's own hourly schedule ({ hourly: 24 }, no daily count) prunes only
    // what it stamped, and the daily bucket is absent from its policy anyway.
    // Both the stamped and the pre-0.4.2 (unstamped) dailies stay.
    const D2 = 'anas-daily-2026-07-26T000000Z'
    const child = flatSched({ id: 'hourly-media', cadence: 'hourly', retention: { hourly: 24 } })
    const parent = sched({ id: 'daily-tank', cadence: 'daily', retention: { daily: 7 } })
    const executor = mockExec()
    executor.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', COLS, 'tank/media'], result: {
      stdout: [
        `tank/media@${D1}\t1769385600\t0\t1\t-`,
        `tank/media@${D2}\t1769385600\t0\t2\tdaily-tank`,
        ...[H1, H2, H3].map((l, i) => `tank/media@${l}\t1769385600\t0\t${10 + i}\thourly-media`),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: ZFS, result: { stdout: '0\n', stderr: '', exitCode: 0 } })
    const res = await pruneZfsSchedule(executor, child, { others: { schedules: [parent], complete: true }, now: PRUNE_NOW })
    assert.deepEqual(res.pruned, [])
    assert.equal(executor.calls.filter(c => c.args[0] === 'destroy').length, 0)
  })

  it('ident.1: two schedules on one dataset with the standard and minimal presets each keep the other\'s buckets', () => {
    // Standard: hourly cadence, 36h/30d/12m. Minimal: daily cadence, 7d/4w.
    // Even with a SHARED daily bucket, each prunes only what it stamped.
    const standard = sched({ id: 'std', target: { kind: 'zfs', dataset: 'tank' }, recursive: false, cadence: 'hourly', retention: { hourly: 36, daily: 30, monthly: 12 } })
    const minimal = sched({ id: 'min', target: { kind: 'zfs', dataset: 'tank' }, recursive: false, cadence: 'daily', retention: { daily: 7, weekly: 4 } })
    const hours = Array.from({ length: 40 }, (_, i) => formatScheduledName('hourly', new Date(Date.UTC(2026, 6, 25) + i * 3600_000)))
    const days = Array.from({ length: 9 }, (_, i) => formatScheduledName('daily', new Date(Date.UTC(2026, 6, 17) + i * 86400_000)))
    const stdout = [
      ...hours.map((l, i) => row('tank', l, 1000 + i, 0, 1769385600, 'std')),
      ...days.map((l, i) => row('tank', l, 100 + i, 0, 1769385600, 'min')),
    ].join('\n')
    const inventory = parseZfsTreeSnapshots(stdout)
    const byStd = planZfsSchedulePrune({ schedule: standard, inventory, others: { schedules: [minimal], complete: true }, now: new Date('2026-07-27T00:00:00Z') })
    const byMin = planZfsSchedulePrune({ schedule: minimal, inventory, others: { schedules: [standard], complete: true }, now: new Date('2026-07-27T00:00:00Z') })
    // Standard: 40 hourlies, keep 36 → its 4 oldest; never a daily.
    assert.deepEqual(byStd[0].prune.map(s => s.name).sort(), hours.slice(0, 4))
    // Minimal: 9 dailies, keep 7 → its 2 oldest; never an hourly.
    assert.deepEqual(byMin[0].prune.map(s => s.name).sort(), days.slice(0, 2))
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

  it('ident.1 follow-up: a stamp with THIS id but source `received` is never this schedule\'s — left, noted; a local one is pruned', async () => {
    // tank/a: H1 received from a sender whose schedule shares this id; H2/H3 ours.
    const stdout = tree(['tank'], [
      row('tank/a', H1, 100, 0, 1769385600, 'hourly-tank|received'),
      row('tank/a', H2, 200),
      row('tank/a', H3, 300),
      row('tank/b', H1, 100, 0, 1769385600, 'hourly-tank|inherited from tank'),
    ])
    const plans = plan(stdout)
    const a = byDs(plans, 'tank/a')!
    assert.deepEqual(a.prune.map(s => s.name), [H2], 'the local H2 goes; the received H1 does not')
    assert.equal(a.note, '1 left: received')
    // Received/inherited stamps are not "unstamped" either (no legacy adoption).
    assert.equal(byDs(plans, 'tank/b')!.note, '1 left: received')
    assert.deepEqual(byDs(plans, 'tank/b')!.prune, [])
    // Through the executor: the stamp source is read with zfs get, and the received one is never destroyed.
    const ex = armRefusing(stdout, [])
    const res = await pruneZfsSchedule(ex, sched(), { others: { schedules: [], complete: true }, now: PRUNE_NOW })
    assert.ok(ex.calls.some(c => c.args.join(' ') === 'get -Hp -t snapshot -r -o name,value,source anas:schedule tank'))
    assert.ok(!ex.calls.some(c => c.args.join(' ') === `destroy tank/a@${H1}`))
    assert.ok(ex.calls.some(c => c.args.join(' ') === `destroy tank/a@${H2}`))
    assert.equal(res.datasets.find(d => d.dataset === 'tank/a')?.note, '1 left: received')
  })

  it('ident.1 follow-up: a stamp the source read does not confirm is not trusted from the list column', () => {
    // The list says hourly-tank, the get read says nothing: unstamped (legacy rules).
    const stdout = tree(['tank'])
    const inv = parseZfsTreeSnapshots(stdout, new Map())
    assert.ok([...inv.values()].flat().every(s => s.schedule === undefined))
    const local = parseZfsStampSources(`tank@${H1}\thourly-tank\tlocal\ntank@${H2}\t-\t-\n`)
    assert.deepEqual([...local.keys()], [`tank@${H1}`])
  })
})
