import type { BackupRepo, BackupTask } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { buildBackupArgs, parseBackupProgress, runBackup } from '../backup-runner.js'
import { snapdevGetArgs } from '../backup-zvol.js'
import { formatTransientBackupSnapshot } from '../snapshot-naming.js'
import { ZFS } from '../zfs-snapshot.js'

/**
 * backup2.4 — `img` archives: the argv, the snapdev cycle around the ONE pbc
 * call, and the two output lines an image prints.
 *
 * Ground truth throughout (`docs/BACKUP-RESTORE-GROUND-TRUTH.md`, real capture
 * `fixtures/backup/img-backup.txt` + `zvol-snapdev.txt`):
 *   - GT-34 a regular file is a first-class `.img` source, no loop device;
 *   - GT-37 `--change-detection-mode` is a COMPLETE no-op for an image;
 *   - GT-35/36 two lines per image, and the `reused` line appears on a FIRST run;
 *   - GT-43/44/45/46 the snapshot device does not exist until `snapdev=visible`,
 *     it arrives ~10 ms later, it is hard read-only, and `zfs inherit` — never
 *     `set …=hidden` — is the restore.
 */

const FINDMNT = '/usr/bin/findmnt'
const PRLIMIT = '/usr/bin/prlimit'
const UDEVADM = '/usr/bin/udevadm'
const TIMEOUT = '/usr/bin/timeout'
const FIND = '/usr/bin/find'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

const NOW = new Date('2026-08-25T12:00:00Z')
const TASK_NAME = 'nightly-luns'
const LABEL = formatTransientBackupSnapshot(TASK_NAME, NOW)

/** `tank` with a dataset that hosts image FILES; the zvol is not in the table. */
const TABLE = JSON.stringify({
  filesystems: [{
    target: '/',
    source: '/dev/sda1',
    fstype: 'ext4',
    options: 'rw',
    children: [
      { target: '/dev', source: 'udev', fstype: 'devtmpfs', options: 'rw' },
      { target: '/tank/images', source: 'tank/images', fstype: 'zfs', options: 'rw' },
    ],
  }],
})

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
    archives: [{ name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img' }],
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
  'Upload image \'/dev/zvol/tank/vol1@x\' to \'repo\' as lun0.img.fidx',
  'lun0.img: had to backup 0 B of 512 MiB (compressed 0 B) in 0.56 s (average 0 B/s)',
  'lun0.img: backup was done incrementally, reused 512 MiB (100.0%)',
  'Duration: 0.58s',
].join('\n')

/** The walk argv a pxar archive would produce (an image never walks). */
function walkCall(path: string): string[] {
  return ['60', FIND, '-P', path, '-xdev', '-maxdepth', '12', '(', '-name', '.zfs', ')', '-prune', '-o', '-type', 'd', '-printf', '%D\\t%p\\n']
}

interface WireOpts {
  pbc?: ExecResult
  snapdevValue?: string
  snapdevSource?: string
  volume?: string
}

function wire(opts: WireOpts = {}): MockExecutor {
  const volume = opts.volume ?? 'tank/vol1'
  const mock = new MockExecutor()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
  mock.addFixture({
    command: ZFS,
    args: snapdevGetArgs(volume),
    result: { stdout: `${volume}\t${opts.snapdevValue ?? 'hidden'}\t${opts.snapdevSource ?? 'default'}\n`, stderr: '', exitCode: 0 },
  })
  // The stale sweep's list, and every other zfs verb.
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: UDEVADM, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: PRLIMIT, result: opts.pbc ?? { stdout: '', stderr: PBC_OK, exitCode: 0 } })
  return mock
}

async function run(mock: MockExecutor, over: Partial<BackupTask> = {}) {
  return runBackup(mock, {
    task: task(over),
    repo: REPO,
    secret: 's3cret',
    now: NOW,
    // No PVE storage.cfg on a test host, and never the real one.
    consistencyOptions: { pveStorageCfg: '/nonexistent/anas-test/storage.cfg' },
    snapdevOptions: { deviceExists: async () => true, attempts: 2, intervalMs: 0 },
  }, () => {})
}

function zfsArgs(mock: MockExecutor): string[][] {
  return mock.calls.filter(c => c.command === ZFS).map(c => c.args)
}

function pbcArgs(mock: MockExecutor): string[] {
  return mock.calls.find(c => c.command === PRLIMIT)?.args ?? []
}

// ---------------------------------------------------------------------------
//  argv
// ---------------------------------------------------------------------------

describe('img archives — the pbc argv (backup2.4)', () => {
  it('an image archive is `<name>.img:<path>`, a file archive stays `.pxar`', () => {
    const args = buildBackupArgs(task({
      archives: [
        { name: 'etc', path: '/etc', excludes: [] },
        { name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img' },
      ],
    }))
    assert.deepEqual(args.slice(0, 3), ['backup', 'etc.pxar:/etc', 'lun0.img:/dev/zvol/tank/vol1'])
  })

  it('a REGULAR FILE is a first-class image source — no loop device anywhere (GT-34)', () => {
    const args = buildBackupArgs(task({
      archives: [{ name: 'lun0', path: '/tank/images/lun.raw', excludes: [], kind: 'img' }],
    }))
    assert.ok(args.includes('lun0.img:/tank/images/lun.raw'), args.join(' '))
    assert.ok(!args.some(a => a.includes('losetup') || a.includes('/dev/loop')), args.join(' '))
  })

  it('an IMG-ONLY task never gets --change-detection-mode (GT-37: it is a no-op)', () => {
    const args = buildBackupArgs(task({ changeDetectionMode: 'metadata' }))
    assert.ok(!args.some(a => a.startsWith('--change-detection-mode')), args.join(' '))
  })

  it('a BLOCK task (the task-level kind) never gets --change-detection-mode, whatever its mode (backup2.9)', () => {
    // The story's block shape — kind on the task, one img archive named
    // `disk` with its LUN record — is the unit the wizard writes. The no-flag
    // rule holds for it by the kind, not just by the archive list.
    const args = buildBackupArgs(task({
      kind: 'block',
      changeDetectionMode: 'metadata',
      archives: [{ name: 'disk', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img', lun: { targetIqn: 'iqn.2026-08.anas:vmstore', index: 0 } }],
    }))
    assert.ok(!args.some(a => a.startsWith('--change-detection-mode')), args.join(' '))
    assert.ok(args.includes('disk.img:/dev/zvol/tank/vol1'), args.join(' '))
  })

  it('a MIXED task still emits it once — its pxar archives honour it', () => {
    const args = buildBackupArgs(task({
      changeDetectionMode: 'metadata',
      archives: [
        { name: 'etc', path: '/etc', excludes: [] },
        { name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img' },
      ],
    }))
    assert.equal(args.filter(a => a === '--change-detection-mode=metadata').length, 1)
  })

  it('the EXPANSION carries the kind, so a snapshot-mode image is still `.img`', () => {
    const args = buildBackupArgs(
      task(),
      undefined,
      {},
      [{ name: 'lun0', from: 'lun0', root: `/dev/zvol/tank/vol1@${LABEL}`, relativePath: '', excludes: [], kind: 'img' }],
    )
    assert.ok(args.includes(`lun0.img:/dev/zvol/tank/vol1@${LABEL}`), args.join(' '))
  })
})

// ---------------------------------------------------------------------------
//  the snapdev cycle inside a real run
// ---------------------------------------------------------------------------

describe('img archives — the zvol snapshot device inside a run (backup2.4)', () => {
  it('snapshot -r → get snapdev → set visible → settle → pbc → INHERIT → destroy -r', async () => {
    const mock = wire()
    const result = await run(mock)

    assert.equal(result.status, 'success')
    assert.deepEqual(zfsArgs(mock), [
      // the stale sweep's list (the sweep is scoped to this task's own prefix)
      ['list', '-t', 'snapshot', '-Hp', '-o', 'name', '-r', 'tank/vol1'],
      ['snapshot', '-r', `tank/vol1@${LABEL}`],
      snapdevGetArgs('tank/vol1'),
      ['set', 'snapdev=visible', 'tank/vol1'],
      // GT-46: `inherit`, never `set snapdev=hidden`.
      ['inherit', 'snapdev', 'tank/vol1'],
      ['destroy', '-r', `tank/vol1@${LABEL}`],
    ])
    // pbc read the SNAPSHOT device, not the live volume.
    assert.ok(pbcArgs(mock).includes(`lun0.img:/dev/zvol/tank/vol1@${LABEL}`), pbcArgs(mock).join(' '))
    assert.ok(!pbcArgs(mock).includes('lun0.img:/dev/zvol/tank/vol1'), pbcArgs(mock).join(' '))
    // The settle happens between the publish and the run.
    const order = mock.calls.map(c => `${c.command} ${c.args[0]}`)
    assert.ok(order.indexOf(`${UDEVADM} settle`) < order.indexOf(`${PRLIMIT} --nofile=1024:1024`), order.join(' | '))

    assert.equal(result.consistency?.[0].consistency, 'snapshot')
    assert.equal(result.consistency?.[0].zvolDevice, '/dev/zvol/tank/vol1')
    assert.deepEqual(result.expansion?.map(e => [e.name, e.kind, e.root]), [
      ['lun0', 'img', `/dev/zvol/tank/vol1@${LABEL}`],
    ])
    assert.deepEqual(result.images, [{ archive: 'lun0', source: '/dev/zvol/tank/vol1@x' }])
    assert.equal(result.warnings, undefined)
  })

  it('a prior LOCAL snapdev is restored to its exact value, not inherited', async () => {
    const mock = wire({ snapdevValue: 'hidden', snapdevSource: 'local' })
    await run(mock)
    const restore = zfsArgs(mock).filter(a => a[0] === 'set' || a[0] === 'inherit')
    assert.deepEqual(restore, [
      ['set', 'snapdev=visible', 'tank/vol1'],
      ['set', 'snapdev=hidden', 'tank/vol1'],
    ])
  })

  it('a volume already visible is never touched — and the run still reads the snapshot', async () => {
    const mock = wire({ snapdevValue: 'visible', snapdevSource: 'local' })
    const result = await run(mock)
    assert.equal(result.status, 'success')
    assert.ok(!zfsArgs(mock).some(a => a[0] === 'set' || a[0] === 'inherit'), JSON.stringify(zfsArgs(mock)))
    assert.ok(pbcArgs(mock).includes(`lun0.img:/dev/zvol/tank/vol1@${LABEL}`))
  })

  it('a FAILED pbc still restores the property AND destroys the transient', async () => {
    const mock = wire({ pbc: { stdout: '', stderr: 'Error: unable to open chunk store \'store1\'\n', exitCode: 255 } })
    await assert.rejects(() => run(mock), /unable to open chunk store/)
    const args = zfsArgs(mock)
    assert.ok(args.some(a => a[0] === 'inherit'), JSON.stringify(args))
    assert.ok(args.some(a => a[0] === 'destroy' && a[2] === `tank/vol1@${LABEL}`), JSON.stringify(args))
    // Ordering: the property goes back BEFORE the snapshot it published is gone.
    const flat = args.map(a => a.join(' '))
    assert.ok(flat.indexOf('inherit snapdev tank/vol1') < flat.indexOf(`destroy -r tank/vol1@${LABEL}`), flat.join(' | '))
  })

  it('an image FILE on a dataset uses the .zfs/snapshot root and NO snapdev at all', async () => {
    const mock = wire()
    const result = await run(mock, {
      archives: [{ name: 'lun0', path: '/tank/images/lun.raw', excludes: [], kind: 'img' }],
    })
    assert.equal(result.status, 'success')
    assert.ok(pbcArgs(mock).includes(`lun0.img:/tank/images/.zfs/snapshot/${LABEL}/lun.raw`), pbcArgs(mock).join(' '))
    // A file needs no property change: `.zfs/snapshot` is reachable while hidden.
    assert.ok(!zfsArgs(mock).some(a => a[0] === 'get' || a[0] === 'set' || a[0] === 'inherit'), JSON.stringify(zfsArgs(mock)))
  })

  it('a LIVE image source is read where it is — no snapshot, no snapdev', async () => {
    const mock = wire()
    const result = await run(mock, {
      archives: [{ name: 'lun0', path: '/dev/sdb', excludes: [], kind: 'img' }],
    })
    assert.equal(result.consistency?.[0].consistency, 'live')
    assert.match(result.consistency?.[0].reason ?? '', /crash-consistent/)
    assert.ok(pbcArgs(mock).includes('lun0.img:/dev/sdb'), pbcArgs(mock).join(' '))
    assert.deepEqual(zfsArgs(mock), [])
  })

  it('an image source is never WALKED — no boundary scan runs for it', async () => {
    const mock = wire()
    await run(mock)
    assert.deepEqual(mock.calls.filter(c => c.command === TIMEOUT), [])
    // Sanity: the same run DOES walk a pxar sibling.
    const mixed = wire()
    await run(mixed, {
      archives: [
        { name: 'etc', path: '/etc', excludes: [] },
        { name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img' },
      ],
    })
    assert.deepEqual(
      mixed.calls.filter(c => c.command === TIMEOUT).map(c => c.args),
      [walkCall('/etc')],
    )
  })
})

// ---------------------------------------------------------------------------
//  the output an image prints (real capture)
// ---------------------------------------------------------------------------

describe('img archives — progress parsing from the real capture (backup2.4)', () => {
  const capture = fixture('img-backup.txt')

  it('parses the two lines per image, and the Upload image line names the source', () => {
    // The "both in ONE snapshot" block of the capture: two images, one run.
    const block = capture.split('=== GT: both in ONE snapshot ===')[1].split('=== snapshot files')[0]
    const progress = parseBackupProgress(block)
    assert.deepEqual(progress.images, [
      { archive: 'lun', source: '/gtbackup/images/lun.raw' },
      { archive: 'vol', source: '/dev/zvol/gtbackup/vol1' },
    ])
    assert.deepEqual(progress.archiveStats, [
      'lun.img: had to backup 12 MiB of 512 MiB (compressed 536 B) in 0.68 s (average 17.744 MiB/s)',
      'lun.img: backup was done incrementally, reused 500 MiB (97.7%)',
      'vol.img: had to backup 16 MiB of 512 MiB (compressed 4.001 MiB) in 0.81 s (average 19.86 MiB/s)',
      'vol.img: backup was done incrementally, reused 496 MiB (96.9%)',
    ])
    assert.equal(progress.duration, 'Duration: 1.51s')
  })

  it('an unchanged image reports 0 B and 100% reused — still a FULL read (GT-36)', () => {
    const block = capture.split('=== 2nd run, NO CHANGE (default mode) ===')[1].split('=== 3rd run')[0]
    const progress = parseBackupProgress(block)
    assert.deepEqual(progress.archiveStats, [
      'lun.img: had to backup 0 B of 512 MiB (compressed 0 B) in 0.56 s (average 0 B/s)',
      'lun.img: backup was done incrementally, reused 512 MiB (100.0%)',
    ])
  })

  it('metadata mode on an image produces the SAME shape — no summary block (GT-37)', () => {
    const block = capture.split('=== 4th run, metadata change-detection mode on an .img ===')[1]
    const progress = parseBackupProgress(block)
    assert.deepEqual(progress.changeDetectionSummary, [])
    assert.equal(progress.images.length, 1)
    assert.equal(progress.archiveStats.length, 2)
  })

  it('an image run has no skipped mount points — a block image has no tree', () => {
    const progress = parseBackupProgress(capture)
    assert.deepEqual(progress.skipped, [])
  })

  it('the snapdev capture parses the same way — the source IS the snapshot device', () => {
    const snapCapture = fixture('zvol-snapdev.txt')
    const block = snapCapture.split('=== back the SNAPSHOT DEVICE up as an .img archive ===')[1]
      .split('=== change the LIVE zvol')[0]
    const progress = parseBackupProgress(block)
    assert.deepEqual(progress.images, [{ archive: 'snap', source: '/dev/zvol/gtbackup/vol1@s1' }])
    assert.match(progress.archiveStats[0], /^snap\.img: had to backup 16 MiB/)
  })
})
