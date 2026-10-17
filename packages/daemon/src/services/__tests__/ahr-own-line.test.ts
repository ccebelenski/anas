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
const ANAS_DEFAULTS = 'nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s'
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
    assert.equal(poolMountOptions(executor, mp), ANAS_DEFAULTS)
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
})
