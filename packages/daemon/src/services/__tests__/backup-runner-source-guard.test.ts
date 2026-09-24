import type { BackupRepo, BackupTask } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MockExecutor as Mock } from '../../executor/mock.js'
import { runBackup } from '../backup-runner.js'

/**
 * backup2.11 — the SOURCE GUARD at the front of a run, over a mocked fstab +
 * findmnt pair.
 *
 * The incident it exists for (2026-08): a boot race left a CIFS mount defined
 * in /etc/fstab unmounted, the backup read the EMPTY MOUNTPOINT DIRECTORY that
 * was sitting there, and PBS took a near-empty snapshot as a good one — with
 * retention ready to age the last real one out behind it.
 *
 * What is pinned here, and why it is pinned at THIS level: the guard is step 0,
 * so the proof that it ran first is that NOTHING ELSE RAN AT ALL. A refused run
 * makes exactly one call — the guard's own `findmnt --json` — and never reaches
 * the boundary walk, `zfs snapshot`, or `proxmox-backup-client`.
 */

const FINDMNT = '/usr/bin/findmnt'
const TIMEOUT = '/usr/bin/timeout'
const PRLIMIT = '/usr/bin/prlimit'
const ZFS = '/usr/sbin/zfs'

const NOW = new Date('2026-09-24T12:00:00Z')

/**
 * The node's configured mounts. Three of them are CIFS/NFS/ext4 shares the
 * system is supposed to have; `/` is always there. Real fstab spelling — the
 * `source` the refusal sentence names is field 1, verbatim.
 */
const FSTAB = [
  '# /etc/fstab: static file system information.',
  'UUID=deadbeef  /              ext4  errors=remount-ro  0  1',
  '//nas/pictures /mnt/pictures  cifs  credentials=/etc/anas/creds/mnt_pictures,nofail  0  0',
  'server:/export /mnt/archive   nfs4  nofail  0  0',
  '/dev/sdb1      /mnt/images    ext4  defaults  0  0',
  '',
].join('\n')

/** What the kernel actually has. Only `/` — the three shares never came up. */
function findmntTable(targets: string[]): string {
  return JSON.stringify({
    filesystems: [{
      target: '/',
      source: '/dev/sda1',
      fstype: 'ext4',
      options: 'rw',
      children: targets.filter(t => t !== '/').map(target => ({
        target,
        source: '//nas/share',
        fstype: 'cifs',
        options: 'rw',
      })),
    }],
  })
}

const NOTHING_MOUNTED = findmntTable(['/'])
const ALL_MOUNTED = findmntTable(['/', '/mnt/pictures', '/mnt/archive', '/mnt/images'])

const REPO: BackupRepo = {
  name: 'pbs-main',
  host: '127.0.0.1',
  port: 8007,
  datastore: 'store1',
  authType: 'token',
  tokenId: 'root@pam!anas',
}

const PBC_OK = [
  'Starting backup: host/anas-pve/2026-09-24T12:00:01Z',
  'Upload directory \'/srv/data\' to \'repo\' as data.pxar.didx',
  'data.pxar: had to backup 0 B of 3.937 MiB (compressed 0 B)',
  'Duration: 1.2s',
].join('\n')

function task(archives: BackupTask['archives']): BackupTask {
  return {
    name: 'nightly',
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives,
    changeDetectionMode: 'default',
    notify: 'always',
    schedule: '*-*-* 02:00:00',
    enabled: true,
    limitNofile: 1024,
  } as BackupTask
}

/** A mock wired for one LIVE run: the mount table, the walk, and pbc. */
function wire(table: string): MockExecutor {
  const mock = new Mock()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: table, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: PRLIMIT, result: { stdout: '', stderr: PBC_OK, exitCode: 0 } })
  return mock
}

describe('backup source guard — the run\'s step 0 (backup2.11)', () => {
  let dir: string
  let fstabPath: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backup-guard-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, FSTAB)
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Run with the guard's fstab under test; `over` swaps the mount table. */
  async function run(mock: MockExecutor, archives: BackupTask['archives'], fstab = fstabPath) {
    return runBackup(mock, {
      task: task(archives),
      repo: REPO,
      secret: 's3cret',
      now: NOW,
      fstabPath: fstab,
      // Never the host's own storage.cfg.
      consistencyOptions: { pveStorageCfg: '/nonexistent/anas-test/storage.cfg' },
    }, () => {})
  }

  it('ONE archive on a configured-but-unmounted mount: the run throws before anything else runs', async () => {
    const mock = wire(NOTHING_MOUNTED)
    await assert.rejects(
      run(mock, [{ name: 'pictures', path: '/mnt/pictures/2026', excludes: [] }]),
      (err: Error) => {
        // All four facts, in DESIGN's own sentence: the ARCHIVE to fix, the
        // PATH as configured, the MOUNTPOINT it actually sits on, and the fstab
        // SOURCE that is missing.
        assert.equal(
          err.message,
          'archive \'pictures\': /mnt/pictures/2026 is on /mnt/pictures (//nas/pictures), '
          + 'which is configured in /etc/fstab but not mounted',
        )
        return true
      },
    )
    // The proof that the guard is STEP 0: the only thing that ran is the
    // guard's own mount-table read. No boundary walk, no `zfs snapshot`, no
    // `proxmox-backup-client` — the refused run touched nothing.
    assert.deepEqual(mock.calls.map(c => c.command), [FINDMNT])
    assert.ok(!mock.calls.some(c => c.command === PRLIMIT), 'pbc was never invoked')
    assert.ok(!mock.calls.some(c => c.command === ZFS && c.args[0] === 'snapshot'), 'nothing was snapshotted')
  })

  it('TWO unmounted archives: both sentences come back in ONE error, in task order', async () => {
    const mock = wire(NOTHING_MOUNTED)
    await assert.rejects(
      run(mock, [
        { name: 'pictures', path: '/mnt/pictures', excludes: [] },
        { name: 'ok', path: '/srv/data', excludes: [] },
        { name: 'archive', path: '/mnt/archive/2026', excludes: [] },
      ]),
      (err: Error) => {
        // One fix round suffices: every offending archive is listed, and the
        // one that is fine is not mentioned at all.
        assert.deepEqual(err.message.split('\n'), [
          'archive \'pictures\': /mnt/pictures is on /mnt/pictures (//nas/pictures), '
          + 'which is configured in /etc/fstab but not mounted',
          'archive \'archive\': /mnt/archive/2026 is on /mnt/archive (server:/export), '
          + 'which is configured in /etc/fstab but not mounted',
        ])
        return true
      },
    )
    assert.deepEqual(mock.calls.map(c => c.command), [FINDMNT])
  })

  it('an `img` archive on an unmounted mount is refused too — the same lie in block form', async () => {
    const mock = wire(NOTHING_MOUNTED)
    await assert.rejects(
      run(mock, [{ name: 'lun0', path: '/mnt/images/vm-100.raw', excludes: [], kind: 'img' }]),
      (err: Error) => {
        assert.equal(
          err.message,
          'archive \'lun0\': /mnt/images/vm-100.raw is on /mnt/images (/dev/sdb1), '
          + 'which is configured in /etc/fstab but not mounted',
        )
        return true
      },
    )
    assert.deepEqual(mock.calls.map(c => c.command), [FINDMNT])
  })

  it('FAIL OPEN: an unreadable mount table lets the run proceed', async () => {
    // findmnt answering nothing is the unreadable case (a live Linux system
    // always has at least `/`). A guard that cannot see the system must not
    // claim a mount is missing.
    const mock = new Mock()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: '', stderr: 'boom', exitCode: 1 } })
    mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: PRLIMIT, result: { stdout: '', stderr: PBC_OK, exitCode: 0 } })
    const result = await run(mock, [{ name: 'pictures', path: '/mnt/pictures', excludes: [] }])
    assert.equal(result.status, 'success')
    assert.ok(mock.calls.some(c => c.command === PRLIMIT), 'pbc ran')
  })

  it('FAIL OPEN: an unreadable fstab configures nothing, so nothing is refused', async () => {
    const mock = wire(NOTHING_MOUNTED)
    const result = await run(
      mock,
      [{ name: 'pictures', path: '/mnt/pictures', excludes: [] }],
      join(dir, 'no-such-fstab'),
    )
    assert.equal(result.status, 'success')
    assert.ok(mock.calls.some(c => c.command === PRLIMIT), 'pbc ran')
  })

  it('a MOUNTED source runs, and its pbc argv is byte-identical to the same run without any fstab', async () => {
    const archives: BackupTask['archives'] = [
      { name: 'pictures', path: '/mnt/pictures/2026', excludes: ['**/*.tmp'] },
      { name: 'images', path: '/mnt/images', excludes: [] },
    ]

    const guarded = wire(ALL_MOUNTED)
    const withGuard = await run(guarded, archives)
    assert.equal(withGuard.status, 'success')

    const ungurded = wire(ALL_MOUNTED)
    const without = await run(ungurded, archives, join(dir, 'no-such-fstab'))
    assert.equal(without.status, 'success')

    const argvOf = (mock: MockExecutor): string[] =>
      mock.calls.find(c => c.command === PRLIMIT)?.args ?? []
    assert.ok(argvOf(guarded).length > 0, 'pbc ran')
    assert.deepEqual(
      argvOf(guarded),
      argvOf(ungurded),
      'a mounted source changes NOTHING about the invocation — the guard only ever refuses',
    )
  })

  it('a path on no configured mount at all is not this guard\'s business', async () => {
    // `/srv/data` is a plain directory on the mounted `/`. Nothing in fstab
    // names it, so nothing can be said to be missing.
    const mock = wire(NOTHING_MOUNTED)
    const result = await run(mock, [{ name: 'data', path: '/srv/data', excludes: [] }])
    assert.equal(result.status, 'success')
  })
})
