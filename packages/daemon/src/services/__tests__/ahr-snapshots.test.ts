import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AhrSnapshotName } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  createAhrSnapshot,
  defaultSnapshotName,
  deleteAhrSnapshot,
  isSubvolLayoutMount,
  listAhrSnapshots,
  preRollbackName,
  rollbackAhrSnapshot,
  subvolFromMountOptions,
  withTopLevelMount,
} from '../ahr-snapshots.js'

const BTRFS = '/usr/bin/btrfs'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const MV = '/usr/bin/mv'
const FINDMNT = '/usr/bin/findmnt'

const GIB = 1024 ** 3

const CAP = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

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
    capacity: CAP,
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
    ...over,
  }
}

/** Indices of a matching call in the recorded argv (for ordering assertions). */
function callIndex(executor: MockExecutor, pred: (c: { command: string, args: string[] }) => boolean): number {
  return executor.calls.findIndex(pred)
}

describe('subvol layout detection', () => {
  it('reads the subvol= mount option (§12)', () => {
    assert.equal(subvolFromMountOptions('rw,relatime,subvolid=256,subvol=/@data'), '/@data')
    assert.equal(subvolFromMountOptions('rw,relatime,subvolid=5,subvol=/'), '/')
    assert.equal(subvolFromMountOptions('rw,relatime'), null)
  })

  it('is the subvolume layout only when mounted subvol=@data', () => {
    assert.equal(isSubvolLayoutMount('rw,subvolid=256,subvol=/@data'), true)
    assert.equal(isSubvolLayoutMount('rw,subvolid=5,subvol=/'), false) // flat top-level
    assert.equal(isSubvolLayoutMount('rw,relatime'), false) // no subvol at all
  })
})

describe('snapshot names', () => {
  it('the default UTC-timestamp name is charset-safe (no colons)', () => {
    const name = defaultSnapshotName(new Date('2026-07-23T14:23:01.234Z'))
    assert.equal(name, '2026-07-23T142301Z')
    assert.ok(AhrSnapshotName.safeParse(name).success)
    assert.ok(!name.includes(':'))
  })

  it('the pre-rollback preserve name is charset-safe', () => {
    const name = preRollbackName(new Date('2026-07-24T09:00:00.000Z'))
    assert.equal(name, 'pre-rollback-2026-07-24T090000Z')
    assert.ok(AhrSnapshotName.safeParse(name).success)
  })
})

describe('listAhrSnapshots', () => {
  it('enumerates @snapshots/ from the plain list, joins otime (-s) + readonly (-r), no extra mount', async () => {
    // Real bytes live-captured 2026-07-23 AFTER a rollback: the plain list is
    // the membership source (a writable `pre-rollback-*` preserve is a PLAIN
    // subvolume, so `-s` omits it — the defect the fix corrects). Note the real
    // `top level 257` (@snapshots' id) — snapshots are NOT top level 5.
    const executor = new MockExecutor()
    executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '/mnt/anas-ahr/tank'], result: {
      stdout: [
        'ID 256 gen 15 top level 257 path @snapshots/pre-rollback-2026-07-23T235407Z',
        'ID 257 gen 16 top level 5 path @snapshots',
        'ID 258 gen 16 top level 257 path @snapshots/2026-07-23T235250Z',
        'ID 259 gen 13 top level 257 path @snapshots/before-upgrade',
        'ID 260 gen 16 top level 5 path @data',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-s', '/mnt/anas-ahr/tank'], result: {
      stdout: [
        'ID 258 gen 16 cgen 12 top level 257 otime 2026-07-23 23:52:50 path @snapshots/2026-07-23T235250Z',
        'ID 259 gen 13 cgen 13 top level 257 otime 2026-07-23 23:52:53 path @snapshots/before-upgrade',
        'ID 260 gen 16 cgen 16 top level 5 otime 2026-07-23 23:54:07 path @data',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: BTRFS, args: ['subvolume', 'list', '-r', '/mnt/anas-ahr/tank'], result: {
      stdout: [
        'ID 258 gen 12 top level 257 path @snapshots/2026-07-23T235250Z',
        'ID 259 gen 13 top level 257 path @snapshots/before-upgrade',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })

    const snaps = await listAhrSnapshots(executor, mkPool())
    // Sorted by name (localeCompare): digits, then 'before-', then 'pre-'.
    assert.deepEqual(snaps, [
      { name: '2026-07-23T235250Z', createdAt: '2026-07-23T23:52:50', readonly: true },
      { name: 'before-upgrade', createdAt: '2026-07-23T23:52:53', readonly: true },
      // The writable pre-rollback preserve IS listed (was invisible under `-s`):
      // no otime row → createdAt null, not in `-r` → readonly false.
      { name: 'pre-rollback-2026-07-23T235407Z', createdAt: null, readonly: false },
    ])
    // Listed against the LIVE @data mount — never mounted the top-level.
    assert.equal(callIndex(executor, c => c.command === MOUNT), -1)
  })

  it('an unmounted pool lists nothing', async () => {
    const executor = new MockExecutor()
    const snaps = await listAhrSnapshots(executor, mkPool({ mounted: false, mountpoint: '/dev/tank/tank-vol' }))
    assert.deepEqual(snaps, [])
    assert.equal(executor.calls.length, 0)
  })
})

describe('createAhrSnapshot', () => {
  let runtimeDir: string
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'anas-snap-'))
  })
  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true })
  })

  it('mounts top-level, takes a read-only snapshot of @data, unmounts (§12)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await createAhrSnapshot(executor, mkPool(), 'nightly', () => {}, { runtimeDir })
    assert.deepEqual(res, { pool: 'tank', snapshot: 'nightly' })

    const top = join(runtimeDir, 'tank.toplevel')
    // top-level mount (subvolid=5), then the -r snapshot, then the unmount.
    assert.deepEqual(executor.calls[0], { command: MOUNT, args: ['-t', 'btrfs', '-o', 'subvolid=5', '/dev/tank/tank-vol', top] })
    assert.deepEqual(executor.calls[1], { command: BTRFS, args: ['subvolume', 'snapshot', '-r', join(top, '@data'), join(top, '@snapshots', 'nightly')] })
    assert.deepEqual(executor.calls[2], { command: UMOUNT, args: ['--', top] })
  })

  it('unmounts even when the snapshot command fails', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: 'boom', exitCode: 1 } })

    await assert.rejects(createAhrSnapshot(executor, mkPool(), 'nightly', () => {}, { runtimeDir }))
    assert.ok(executor.calls.some(c => c.command === UMOUNT), 'top-level unmounted in finally')
  })

  it('rejects a name that fails the charset schema at the boundary', async () => {
    const executor = new MockExecutor()
    await assert.rejects(createAhrSnapshot(executor, mkPool(), '../evil', () => {}, { runtimeDir }))
    // Never mounted anything.
    assert.equal(executor.calls.length, 0)
  })
})

describe('deleteAhrSnapshot', () => {
  let runtimeDir: string
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'anas-snap-'))
  })
  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true })
  })

  it('mounts top-level, deletes the subvolume, unmounts', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await deleteAhrSnapshot(executor, mkPool(), 'nightly', () => {}, { runtimeDir })
    assert.deepEqual(res, { pool: 'tank', deleted: 'nightly' })
    const top = join(runtimeDir, 'tank.toplevel')
    assert.deepEqual(executor.calls[1], { command: BTRFS, args: ['subvolume', 'delete', join(top, '@snapshots', 'nightly')] })
    assert.equal(executor.calls.at(-1)!.command, UMOUNT)
  })
})

describe('rollbackAhrSnapshot', () => {
  let runtimeDir: string
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'anas-snap-'))
  })
  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true })
  })

  const NOW = new Date('2026-07-24T09:00:00.000Z')

  it('preserves @data BEFORE the swap and remounts the pool in a finally', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MV, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await rollbackAhrSnapshot(executor, mkPool(), 'good', () => {}, { runtimeDir, now: NOW })
    assert.deepEqual(res, { pool: 'tank', rolledBackTo: 'good', preserved: 'pre-rollback-2026-07-24T090000Z' })

    const top = join(runtimeDir, 'tank.toplevel')
    // 1) the pool mountpoint is unmounted first.
    const poolUmount = callIndex(executor, c => c.command === UMOUNT && c.args[1] === '/mnt/anas-ahr/tank')
    // 2) the preserve RENAME (mv @data → @snapshots/pre-rollback-<ts>).
    const mvIdx = callIndex(executor, c => c.command === MV
      && c.args[1] === join(top, '@data')
      && c.args[2] === join(top, '@snapshots', 'pre-rollback-2026-07-24T090000Z'))
    // 3) the swap: writable snapshot of the chosen snapshot → @data.
    const swapIdx = callIndex(executor, c => c.command === BTRFS
      && c.args[0] === 'subvolume' && c.args[1] === 'snapshot'
      && c.args[2] === join(top, '@snapshots', 'good') && c.args[3] === join(top, '@data'))
    // 4) the pool is remounted at the end.
    const poolRemount = callIndex(executor, c => c.command === MOUNT && c.args[0] === '--' && c.args[1] === '/mnt/anas-ahr/tank')

    assert.ok(poolUmount >= 0 && mvIdx >= 0 && swapIdx >= 0 && poolRemount >= 0)
    assert.ok(poolUmount < mvIdx, 'pool unmounted before the swap')
    assert.ok(mvIdx < swapIdx, 'preserve-rename happens BEFORE the swap (nothing destroyed)')
    assert.ok(swapIdx < poolRemount, 'remount is last')
  })

  it('remounts the pool even when the swap fails (finally)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MV, result: { stdout: '', stderr: '', exitCode: 0 } })
    // The writable snapshot swap fails after the preserve-rename already ran.
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: 'swap failed', exitCode: 1 } })

    await assert.rejects(rollbackAhrSnapshot(executor, mkPool(), 'good', () => {}, { runtimeDir, now: NOW }))
    // The preserve-rename ran (nothing destroyed) AND the pool got remounted.
    assert.ok(executor.calls.some(c => c.command === MV), 'preserve-rename ran before the failure')
    assert.ok(
      executor.calls.some(c => c.command === MOUNT && c.args[0] === '--' && c.args[1] === '/mnt/anas-ahr/tank'),
      'pool remounted in the finally despite the failure',
    )
  })
})

// Bug #1 (code review): the withTopLevelMount teardown MUST never recursively
// remove the mountpoint, and MUST serialize concurrent ops on one pool — a
// recursive rm over a still-mounted btrfs top-level (from a failed umount or a
// second job stacking a mount on the same path) would unlink POOL DATA.
describe('withTopLevelMount teardown safety (data-loss guard)', () => {
  const ok = { stdout: '', stderr: '', exitCode: 0 }
  let runtimeDir: string
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'ahr-toplevel-'))
  })
  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true })
  })

  it('never recursively removes a still-mounted top-level; surfaces the leak loudly', async () => {
    const pool = mkPool()
    const mnt = join(runtimeDir, `${pool.name}.toplevel`)
    await mkdir(mnt, { recursive: true })
    // A sentinel standing in for pool data reachable through the live mount —
    // the OLD `rm(mnt, {recursive:true})` would have destroyed it.
    const sentinel = join(mnt, 'POOL_DATA')
    await writeFile(sentinel, 'precious')

    const ex = new MockExecutor()
    ex.addFixture({ command: MOUNT, result: ok })
    ex.addFixture({ command: UMOUNT, result: { stdout: '', stderr: 'target is busy', exitCode: 32 } })
    // findmnt --mountpoint exits 0 → the path is STILL a mountpoint.
    ex.addFixture({ command: FINDMNT, result: ok })

    await assert.rejects(
      withTopLevelMount(ex, pool, async () => 'done', { runtimeDir }),
      /still mounted/,
      'a leaked (still-mounted) teardown is surfaced as a job error, not swallowed',
    )
    assert.equal(await readFile(sentinel, 'utf8'), 'precious', 'pool data under the still-mounted path survives')
  })

  it('does not mask the op error, and never findmnt-probes when umount succeeds', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: MOUNT, result: ok })
    ex.addFixture({ command: UMOUNT, result: ok })
    await assert.rejects(
      withTopLevelMount(ex, mkPool(), async () => { throw new Error('op boom') }, { runtimeDir }),
      /op boom/,
      'the operation\'s own error propagates',
    )
    assert.ok(!ex.calls.some(c => c.command === FINDMNT), 'no mountpoint probe on a clean umount')
  })

  it('serializes concurrent top-level mounts on the same pool (no stacked mounts)', async () => {
    const pool = mkPool()
    const ex = new MockExecutor()
    ex.addFixture({ command: MOUNT, result: ok })
    ex.addFixture({ command: UMOUNT, result: ok })
    let release1: () => void = () => {}
    const gate1 = new Promise<void>((r) => {
      release1 = r
    })
    // Resolves the instant fn1 enters its critical section — a race-free signal,
    // not a timing budget. fn1's real mkdir + mount (libuv I/O) complete before
    // this fires, so awaiting it is deterministic under any load (the old
    // fixed-tick poll could expire before the real mkdir landed → flaky []).
    let signalStarted1: () => void = () => {}
    const started1 = new Promise<void>((r) => {
      signalStarted1 = r
    })
    const order: string[] = []

    const p1 = withTopLevelMount(ex, pool, async () => {
      order.push('fn1-start')
      signalStarted1()
      await gate1
      order.push('fn1-end')
      return 1
    }, { runtimeDir })
    const p2 = withTopLevelMount(ex, pool, async () => {
      order.push('fn2-start')
      return 2
    }, { runtimeDir })

    // Block until fn1 is provably in its critical section (parked on gate1). At
    // this point fn2's task is still chained behind fn1's unsettled promise
    // (serializeOnPath's .then() queue), so it cannot have started or mounted —
    // no drain/poll needed; the serialization is structural.
    await started1
    assert.deepEqual(order, ['fn1-start'], 'the second op does not start until the first finishes')
    assert.equal(ex.calls.filter(c => c.command === MOUNT).length, 1, 'only one mount is live at a time')

    release1()
    assert.deepEqual(await Promise.all([p1, p2]), [1, 2])
    assert.deepEqual(order, ['fn1-start', 'fn1-end', 'fn2-start'])
    assert.equal(ex.calls.filter(c => c.command === MOUNT).length, 2)
  })
})
