import type { AhrPool, SnapshotTarget } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  listScheduledSnapshots,
  parseZfsScheduledSnapshots,
  pruneSnapshots,
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
