import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
} from '../ahr-snapshots.js'

const BTRFS = '/usr/bin/btrfs'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const MV = '/usr/bin/mv'

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
