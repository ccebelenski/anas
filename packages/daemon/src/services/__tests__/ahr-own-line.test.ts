import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { changeAhrMountpoint, remountAhrPool } from '../ahr-create.js'
import { readAhrPoolLine } from '../ahr-fstab.js'
import { rollbackAhrSnapshot } from '../ahr-snapshots.js'

/**
 * Story cr.52s-a (cr.52r review defect 6): every AHR re-mount carries the
 * pool's OWN fstab line AS STORED — cr.52r rebuilt ANAS's defaults
 * (`ahrFstabEntry`) and dropped what the operator had added (`noatime`,
 * `compress=zstd:3`). Before cr.52r these verbs ran `mount -- <mp>`, so fstab
 * supplied the line's options; the direct mount must keep that. A pool with no
 * line keeps ANAS's defaults and says so; an unreadable fstab refuses before
 * anything is unmounted.
 */

const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const FINDMNT = '/usr/bin/findmnt'
const SYSTEMCTL = '/usr/bin/systemctl'
const OPERATOR_OPTIONS = 'noatime,compress=zstd:3,subvol=@data'
const GIB = 1024 ** 3

function mkPool(mountpoint: string): AhrPool {
  return {
    name: 'tank',
    ahrType: 'ahr1',
    mountpoint,
    mounted: true,
    disks: [],
    arrays: [],
    vg: { name: 'tank', sizeBytes: 5 * GIB, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 5 * GIB },
    capacity: { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
  }
}

function okExecutor(): MockExecutor {
  const executor = new MockExecutor()
  for (const command of [MOUNT, UMOUNT, SYSTEMCTL, '/usr/bin/mv', '/usr/bin/btrfs'])
    executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: FINDMNT, result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
  return executor
}

/** The pool mount (target fd resolves to `mp`), as `-o` option string. */
function poolMountOptions(executor: MockExecutor, mp: string): string | undefined {
  const call = executor.calls.find(c => c.command === MOUNT && c.args.at(-1) === '/proc/self/fd/3/.' && c.fdPaths?.[0] === mp)
  return call ? call.args[call.args.indexOf('-o') + 1] : undefined
}

describe('AHR re-mounts use the pool\'s own fstab line as stored (cr.52s-a, review defect 6)', () => {
  let dir: string
  let mp: string
  let fstabPath: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-own-line-'))
    mp = join(dir, 'tank')
    await mkdir(mp)
    fstabPath = join(dir, 'fstab')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('the remount carries the line\'s options byte-identically (noatime,compress=zstd:3,subvol=@data)', async () => {
    await writeFile(fstabPath, `/dev/tank/tank-vol ${mp} btrfs ${OPERATOR_OPTIONS} 0 0\n`)
    const executor = okExecutor()
    await remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, () => {}, { fstabPath })
    assert.equal(poolMountOptions(executor, mp), OPERATOR_OPTIONS)
    const call = executor.calls.find(c => c.command === MOUNT)!
    assert.deepEqual(call.args, ['-c', '-t', 'btrfs', '-o', OPERATOR_OPTIONS, '--', '/dev/tank/tank-vol', '/proc/self/fd/3/.'])
  })

  it('the remount of a pool with NO line uses ANAS\'s defaults and the progress says so', async () => {
    await writeFile(fstabPath, '/dev/other/other-vol /srv/other btrfs defaults 0 0\n')
    const executor = okExecutor()
    const progress: string[] = []
    await remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, m => progress.push(m), { fstabPath })
    // cr.52s-e: ANAS's default entry carries `nofail` and the iSCSI ordering
    // pair (nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,
    // x-systemd.device-timeout=45s); the direct mount's `-o` carries only the
    // kernel/helper tokens that survive the strip.
    assert.equal(poolMountOptions(executor, mp), 'subvol=@data')
    assert.ok(progress.some(m => /has no line in .* re-mounting with ANAS's default options/.test(m)), progress.join(' | '))
  })

  it('an UNREADABLE fstab refuses the remount before anything is unmounted', async () => {
    const executor = okExecutor()
    // A directory where the file should be: readFile answers EISDIR.
    await mkdir(join(dir, 'fstab-dir'))
    await assert.rejects(
      remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, () => {}, { fstabPath: join(dir, 'fstab-dir') }),
      /could not read .* nothing was unmounted/,
    )
    assert.deepEqual(executor.calls.filter(c => c.command === UMOUNT || c.command === MOUNT), [], 'no umount, no mount')
  })

  it('the snapshot rollback\'s remount carries the line\'s options', async () => {
    await writeFile(fstabPath, `/dev/tank/tank-vol ${mp} btrfs ${OPERATOR_OPTIONS} 0 0\n`)
    const executor = okExecutor()
    await rollbackAhrSnapshot(executor, mkPool(mp), 'good', () => {}, { runtimeDir: dir, fstabPath })
    assert.equal(poolMountOptions(executor, mp), OPERATOR_OPTIONS)
  })

  it('the snapshot rollback refuses on an unreadable fstab before unmounting the pool', async () => {
    const executor = okExecutor()
    await mkdir(join(dir, 'fstab-dir'))
    await assert.rejects(
      rollbackAhrSnapshot(executor, mkPool(mp), 'good', () => {}, { runtimeDir: dir, fstabPath: join(dir, 'fstab-dir') }),
      /nothing was unmounted/,
    )
    assert.deepEqual(executor.calls.filter(c => c.command === UMOUNT || c.command === MOUNT), [])
  })

  it('a mountpoint MOVE keeps the line\'s own options — only the mountpoint changes — and mounts them', async () => {
    await writeFile(fstabPath, `# keep me\n/dev/tank/tank-vol ${mp} btrfs ${OPERATOR_OPTIONS} 0 0\n`)
    const executor = okExecutor()
    const target = join(dir, 'moved')
    await changeAhrMountpoint(executor, { name: 'tank', mountpoint: mp, mounted: true, subvolLayout: true }, target, () => {}, { fstabPath })
    const line = await readAhrPoolLine(fstabPath, 'tank')
    assert.equal(line.kind, 'line')
    assert.equal(line.kind === 'line' ? line.entry.mountpoint : '', target)
    assert.match(await readFile(fstabPath, 'utf8'), new RegExp(`/dev/tank/tank-vol ${target} btrfs ${OPERATOR_OPTIONS} 0 0`))
    assert.equal(poolMountOptions(executor, target), OPERATOR_OPTIONS)
  })

  it('readAhrPoolLine is three-valued: line / none / unreadable', async () => {
    await writeFile(fstabPath, `/dev/tank/tank-vol ${mp} btrfs ${OPERATOR_OPTIONS} 0 0\n`)
    assert.equal((await readAhrPoolLine(fstabPath, 'tank')).kind, 'line')
    assert.equal((await readAhrPoolLine(fstabPath, 'other')).kind, 'none')
    assert.equal((await readAhrPoolLine(join(dir, 'missing-fstab'), 'tank')).kind, 'unreadable')
  })

  it('a missing fstab answers readAhrPoolLine unreadable with the detail the file does not exist', async () => {
    const line = await readAhrPoolLine(join(dir, 'missing-fstab'), 'tank')
    assert.deepEqual(line, { kind: 'unreadable', detail: 'the file does not exist' })
  })

  it('a directory at the fstab path answers readAhrPoolLine unreadable with the detail EISDIR', async () => {
    await mkdir(join(dir, 'fstab-dir'))
    const line = await readAhrPoolLine(join(dir, 'fstab-dir'), 'tank')
    assert.deepEqual(line, { kind: 'unreadable', detail: 'EISDIR' })
  })
})

/**
 * cr3 AHR-CORE-M3 (review probe p5): the Previous Versions `@snapshots` line
 * carries the pool's own LV spec. After create → enable Previous Versions →
 * Change mountpoint, it comes FIRST in the file, and every reader that took
 * "the first line with the LV spec" took it: the Remount verb and the snapshot
 * rollback mounted the POOL `ro,subvol=@snapshots`, and a second move carried
 * the @snapshots line away instead of the pool's.
 */
describe('cr3 M3: the @snapshots line is never the pool\'s own line', () => {
  let dir: string
  let mp: string
  let fstabPath: string
  const SNAP_LINE = '/dev/tank/tank-vol /mnt/anas-ahr-snapshots/tank btrfs ro,nofail,subvol=@snapshots 0 0'
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-own-line-m3-'))
    mp = join(dir, 'tank')
    await mkdir(mp)
    fstabPath = join(dir, 'fstab')
    // The order a Change mountpoint leaves: @snapshots first, the pool's line appended.
    await writeFile(fstabPath, `UUID=abc / ext4 errors=remount-ro 0 1\n${SNAP_LINE}\n/dev/tank/tank-vol ${mp} btrfs ${OPERATOR_OPTIONS} 0 0\n`)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('readAhrPoolLine picks the pool\'s line, not the @snapshots line before it', async () => {
    const line = await readAhrPoolLine(fstabPath, 'tank')
    assert.equal(line.kind === 'line' ? line.entry.mountpoint : line.kind, mp)
  })

  it('a @snapshots line ALONE is no pool line (none, not the snapshot mount)', async () => {
    await writeFile(fstabPath, `${SNAP_LINE}\n`)
    assert.equal((await readAhrPoolLine(fstabPath, 'tank')).kind, 'none')
  })

  it('the Remount verb mounts the pool with its own options, never ro,subvol=@snapshots', async () => {
    const executor = okExecutor()
    await remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, () => {}, { fstabPath })
    assert.equal(poolMountOptions(executor, mp), OPERATOR_OPTIONS)
  })

  it('the snapshot rollback remounts the pool with its own options', async () => {
    const executor = okExecutor()
    await rollbackAhrSnapshot(executor, mkPool(mp), 'good', () => {}, { runtimeDir: dir, fstabPath })
    assert.equal(poolMountOptions(executor, mp), OPERATOR_OPTIONS)
  })

  it('a second Change mountpoint moves the pool\'s line and leaves the @snapshots line where it is', async () => {
    const executor = okExecutor()
    const target = join(dir, 'moved')
    // The pool is UNMOUNTED here, so the line is found by spec alone — the
    // shape where the @snapshots line used to win.
    await changeAhrMountpoint(executor, { name: 'tank', mountpoint: '/dev/tank/tank-vol', mounted: false, subvolLayout: true }, target, () => {}, { fstabPath })
    const text = await readFile(fstabPath, 'utf8')
    assert.ok(text.includes(SNAP_LINE), 'the @snapshots line is untouched')
    assert.match(text, new RegExp(`/dev/tank/tank-vol ${target} btrfs ${OPERATOR_OPTIONS} 0 0`))
    assert.ok(!text.includes(` ${mp} `), 'the pool\'s old line moved')
  })
})

// cr3 (INVENTED-STATE class): the Remount verb VERIFIES that the pool is
// writable again by reading the mount table. A table that could not be read
// used to answer "not read-only" and the verb reported success it never saw.
describe('cr3: a remount the mount table cannot verify is never reported writable', () => {
  let dir: string
  let mp: string
  let fstabPath: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-remount-verify-'))
    mp = join(dir, 'tank')
    await mkdir(mp)
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, `/dev/tank/tank-vol ${mp} btrfs ${OPERATOR_OPTIONS} 0 0\n`)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an unreadable findmnt after the mount fails the verb, naming why', async () => {
    const executor = okExecutor()
    executor.prependFixture({ command: FINDMNT, result: { stdout: '', stderr: 'findmnt: timeout', exitCode: 1 } })
    await assert.rejects(
      remountAhrPool(executor, { name: 'tank', mountpoint: mp, subvolLayout: true }, () => {}, { fstabPath }),
      /mounted again, but the kernel mount table could not be read to verify it is writable/,
    )
  })
})
