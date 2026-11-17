import type { AhrPool } from '@anas/shared'
import type { MockExecCall } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AhrSnapshotName } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { isSubvolLayoutMount, subvolFromMountOptions } from '../ahr-fstab.js'
import {
  createAhrSnapshot,
  defaultSnapshotName,
  deleteAhrSnapshot,
  listAhrSnapshots,
  preRollbackName,
  rollbackAhrSnapshot,
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
function callIndex(executor: MockExecutor, pred: (c: MockExecCall) => boolean): number {
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
    // top-level mount (subvolid=5) through the daemon-opened dir (cr.52r D3),
    // then the -r snapshot, then the unmount. The mount child inherits the
    // fd the daemon opened on `top` and targets /proc/self/fd/3.
    assert.equal(executor.calls[0].command, MOUNT)
    assert.deepEqual(executor.calls[0].args, ['-c', '-t', 'btrfs', '-o', 'subvolid=5', '--', '/dev/tank/tank-vol', '/proc/self/fd/3/.'])
    assert.equal(executor.calls[0].inheritedFds?.length, 1, 'the mount child inherits the daemon-opened fd')
    assert.equal(executor.calls[0].fdPaths?.[0], top, 'the inherited fd resolves to the opened top-level directory')
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

  /**
   * A pool whose mountpoint is a REAL directory under the tempdir (cr.52r D3's
   * fd-pin opens it — the mocked pool fixtures' `/mnt/anas-ahr/tank` does not
   * exist on the test host).
   */
  async function mkRealPool(): Promise<AhrPool> {
    const pool = mkPool({ mountpoint: join(runtimeDir, 'tank') })
    await mkdir(pool.mountpoint, { recursive: true })
    return pool
  }

  it('preserves @data BEFORE the swap and remounts the pool in a finally', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MV, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const pool = await mkRealPool()
    const res = await rollbackAhrSnapshot(executor, pool, 'good', () => {}, { runtimeDir, now: NOW })
    assert.deepEqual(res, { pool: 'tank', rolledBackTo: 'good', preserved: 'pre-rollback-2026-07-24T090000Z' })

    const top = join(runtimeDir, 'tank.toplevel')
    // 1) the pool mountpoint is unmounted first.
    const poolUmount = callIndex(executor, c => c.command === UMOUNT && c.args[1] === pool.mountpoint)
    // 2) the preserve RENAME (mv @data → @snapshots/pre-rollback-<ts>).
    const mvIdx = callIndex(executor, c => c.command === MV
      && c.args[1] === join(top, '@data')
      && c.args[2] === join(top, '@snapshots', 'pre-rollback-2026-07-24T090000Z'))
    // 3) the swap: writable snapshot of the chosen snapshot → @data.
    const swapIdx = callIndex(executor, c => c.command === BTRFS
      && c.args[0] === 'subvolume' && c.args[1] === 'snapshot'
      && c.args[2] === join(top, '@snapshots', 'good') && c.args[3] === join(top, '@data'))
    // 4) the pool is remounted DIRECTLY through the daemon-opened dir (cr.52r
    // D3) — the POOL's remount (its fd resolves to the pool mountpoint), not
    // the on-demand TOP-LEVEL mount (whose fd resolves to `top`).
    const poolRemount = callIndex(executor, c => c.command === MOUNT
      && c.args.at(-1) === '/proc/self/fd/3/.'
      && c.fdPaths?.[0] === pool.mountpoint)

    assert.ok(poolUmount >= 0 && mvIdx >= 0 && swapIdx >= 0 && poolRemount >= 0)
    assert.ok(poolUmount < mvIdx, 'pool unmounted before the swap')
    assert.ok(mvIdx < swapIdx, 'preserve-rename happens BEFORE the swap (nothing destroyed)')
    assert.ok(swapIdx < poolRemount, 'remount is last')
    // The remount's fd resolves to the pool's own mountpoint directory.
    const remountCall = executor.calls[poolRemount]
    assert.equal(remountCall.fdPaths?.[0], pool.mountpoint)
  })

  it('remounts the pool even when the swap fails (finally)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MV, result: { stdout: '', stderr: '', exitCode: 0 } })
    // The writable snapshot swap fails after the preserve-rename already ran.
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: 'swap failed', exitCode: 1 } })

    const pool = await mkRealPool()
    await assert.rejects(rollbackAhrSnapshot(executor, pool, 'good', () => {}, { runtimeDir, now: NOW }))
    // The preserve-rename ran (nothing destroyed) AND the pool got remounted.
    assert.ok(executor.calls.some(c => c.command === MV), 'preserve-rename ran before the failure')
    assert.ok(
      executor.calls.some(c => c.command === MOUNT && c.args.includes('btrfs')),
      'pool remounted in the finally despite the failure',
    )
  })
})

// cr3 AHR-CORE-M6: a swap failing after the preserve-rename used to leave
// @data renamed away; the finally's remount (subvol=@data) then failed on the
// missing subvolume and ITS error replaced the real one.
describe('rollbackAhrSnapshot — cr3 M6: a failed swap puts @data back, and the real error leads', () => {
  let runtimeDir: string
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'anas-snap-m6-'))
  })
  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true })
  })
  const NOW = new Date('2026-07-24T09:00:00.000Z')
  async function realPool(): Promise<AhrPool> {
    const pool = mkPool({ mountpoint: join(runtimeDir, 'tank') })
    await mkdir(pool.mountpoint, { recursive: true })
    return pool
  }
  function world(mvResults: { stdout: string, stderr: string, exitCode: number }[], mountResults?: { stdout: string, stderr: string, exitCode: number }[]): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: MOUNT, ...(mountResults ? { results: mountResults } : { result: { stdout: '', stderr: '', exitCode: 0 } }) })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MV, results: mvResults })
    executor.addFixture({ command: BTRFS, result: { stdout: '', stderr: 'ERROR: cannot snapshot: No space left on device', exitCode: 1 } })
    return executor
  }
  const OK = { stdout: '', stderr: '', exitCode: 0 }
  const top = () => join(runtimeDir, 'tank.toplevel')

  it('renames @snapshots/pre-rollback-<ts> back to @data BEFORE the remount, and says so', async () => {
    const executor = world([OK, OK])
    const pool = await realPool()
    await assert.rejects(
      rollbackAhrSnapshot(executor, pool, 'good', () => {}, { runtimeDir, now: NOW }),
      /^Error: .*No space left on device — @data was renamed back; the pool is as it was before the rollback$/,
    )
    const mvs = executor.calls.filter(c => c.command === MV).map(c => c.args)
    assert.deepEqual(mvs, [
      ['--', join(top(), '@data'), join(top(), '@snapshots', 'pre-rollback-2026-07-24T090000Z')],
      ['-T', '--', join(top(), '@snapshots', 'pre-rollback-2026-07-24T090000Z'), join(top(), '@data')],
    ])
    const restore = executor.calls.findIndex(c => c.command === MV && c.args.at(-1) === join(top(), '@data'))
    const remount = executor.calls.findIndex(c => c.command === MOUNT && c.fdPaths?.[0] === pool.mountpoint)
    assert.ok(restore >= 0 && remount > restore, 'restored, then remounted')
  })

  // cr3 review 7: a failed snapshot step that still created @data — GNU mv
  // would nest the preserved subvolume inside it and claim restoration.
  it('cr3 review 7: a NEW @data left by the failed step is never renamed onto; the job says where the original is', async () => {
    const executor = world([OK, OK])
    const pool = await realPool()
    // withTopLevelMount mounts at <runtimeDir>/tank.toplevel; the failed
    // snapshot step left a directory where @data belongs.
    await mkdir(join(top(), '@data'), { recursive: true })
    await assert.rejects(
      rollbackAhrSnapshot(executor, pool, 'good', () => {}, { runtimeDir, now: NOW }),
      /the failed step left a NEW @data behind, so the original was NOT renamed back: it is intact as @snapshots\/pre-rollback-2026-07-24T090000Z/,
    )
    assert.equal(executor.calls.filter(c => c.command === MV).length, 1, 'only the preserve-rename ran')
  })

  // cr3 review2 10: an lstat that could not SEE read as "no @data there".
  it('cr3 review2 10: a stat of @data that fails for a reason other than ENOENT stops the rename-back, naming it', { skip: process.getuid?.() === 0 }, async () => {
    const executor = world([OK, OK])
    // After the preserve-rename, the top-level directory turns unreadable.
    const orig = executor.exec.bind(executor)
    executor.exec = async (command, args, opts) => {
      const r = await orig(command, args, opts)
      if (command === MV)
        await chmod(top(), 0o000)
      return r
    }
    const pool = await realPool()
    try {
      await assert.rejects(
        rollbackAhrSnapshot(executor, pool, 'good', () => {}, { runtimeDir, now: NOW }),
        /whether the failed step left a @data behind could not be read \(EACCES[^)]*\), so the original was NOT renamed back/,
      )
      assert.equal(executor.calls.filter(c => c.command === MV).length, 1, 'no rename-back')
    }
    finally {
      await chmod(top(), 0o755).catch(() => {})
    }
  })

  it('a rename-back that fails names where the data is, and the remount failure never replaces the real error', async () => {
    // The top-level mount succeeds; the pool's remount then fails (no @data).
    const executor = world([OK, { stdout: '', stderr: 'mv: cannot move', exitCode: 1 }], [OK, { stdout: '', stderr: 'mount: special device subvol=@data does not exist', exitCode: 32 }])
    const pool = await realPool()
    await assert.rejects(rollbackAhrSnapshot(executor, pool, 'good', () => {}, { runtimeDir, now: NOW }), (err: Error) => {
      assert.match(err.message, /^.*No space left on device — and @data could not be renamed back from @snapshots\/pre-rollback-2026-07-24T090000Z \(mv: mv: cannot move\)/)
      assert.match(err.message, /The pool's data is intact as @snapshots\/pre-rollback-2026-07-24T090000Z/)
      assert.match(err.message, /remounting .* ALSO failed: mount: special device subvol=@data does not exist$/)
      return true
    })
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
