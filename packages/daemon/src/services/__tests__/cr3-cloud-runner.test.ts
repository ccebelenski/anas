import type { CloudSyncTask } from '@anas/shared'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { buildCloudNotifyBody } from '../cloud-notify.js'
import { cloudPreviewDeps, previewCloudSync, PreviewRefusal, resolveSourceChecked, runPreview } from '../cloud-preview.js'
import { buildRcloneArgs, nestedFilesystemExcludes, nestedProgressLine, rcloneGlobLiteral, runCloudSync, ZFS_FILESYSTEMS_ARGS } from '../cloud-runner.js'
import { RCLONE } from '../rclone-config.js'
import { sharePathProbeArgs } from '../share-path.js'
import { passThroughRealpath } from './cloud-realpath-passthrough.js'

/**
 * cr3 (review 2026-11-14), area `cloud` — the run and its preview read the
 * tree the run will really read:
 *
 *  - CLOUD-H3: a snapshot holds ONE filesystem; each nested one is an empty
 *    directory in it, and a `sync` from the snapshot deleted the destination's
 *    copy of every nested filesystem while the preview (the live tree) said
 *    "would delete 0". The run now excludes them (preserved at the
 *    destination), the preview carries the same excludes plus
 *    `--one-file-system`, emptiness is judged on the tree the run reads, and a
 *    snapshot-mode sync whose scan could not see everything is refused.
 *  - CLOUD-M4: consistency is derived on the source's REAL path.
 *  - CLOUD-M6: a source whose filesystem does not answer is refused by a
 *    bounded child before any in-process read.
 *
 * The real-rclone proof of the H3 argv (a scratch tree, before and after) is
 * recorded in the cr3 report; these pin the daemon's side over the mock.
 */

const FINDMNT = '/usr/bin/findmnt'
const FIND = '/usr/bin/find'
const ZFS = '/usr/sbin/zfs'
const TIMEOUT = '/usr/bin/timeout'
const REALPATH = '/usr/bin/realpath'
const NOW = new Date(1_700_000_000_000)
const LABEL = 'anas-cloud-offsite-1700000000'

const FINAL_STATS = JSON.stringify({
  level: 'info',
  msg: 'Transferred',
  stats: { bytes: 0, checks: 1, deletes: 0, elapsedTime: 1, errors: 0, eta: null, fatalError: false, speed: 0, totalBytes: 0, totalChecks: 1, totalTransfers: 0, transferTime: 0, transfers: 0 },
  time: '2026-09-24T02:00:30.001+00:00',
})

function task(over: Partial<CloudSyncTask> = {}): CloudSyncTask {
  return CloudSyncTaskSchema.parse({
    name: 'offsite',
    source: '/tank/pictures',
    remote: 'backblaze',
    path: 'pve1/pictures',
    schedule: 'Tue *-*-* 02:00:00',
    ...over,
  })
}

function findmntJson(rows: { target: string, source: string, fstype: string }[]): string {
  return JSON.stringify({
    filesystems: [
      { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
      ...rows.map(r => ({ ...r, options: 'rw' })),
    ],
  })
}

interface Harness {
  dir: string
  source: string
  fstab: string
  mock: MockExecutor
  cleanup: () => Promise<void>
}

/**
 * A source findmnt reports as the mounted ZFS dataset `tank/pictures`, with a
 * NESTED dataset `tank/pictures/photos` mounted at `<source>/photos`. The
 * boundary scan (`timeout ... find -xdev`) answers the walk a real one would
 * (device 50 for the parent, 51 for the child); `walk: 'fail'` answers it the
 * way an executor that could not start it does.
 */
async function nestedHarness(opts: { walk?: 'ok' | 'fail' | 'slow', snapshot?: string[] } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloudrun-'))
  const source = join(dir, 'pictures')
  await mkdir(join(source, 'docs'), { recursive: true })
  await writeFile(join(source, 'docs', 'd1.txt'), 'x', 'utf-8')
  await mkdir(join(source, 'photos'), { recursive: true })
  await writeFile(join(source, 'photos', 'p1.jpg'), 'x', 'utf-8')
  // What `<source>/.zfs/snapshot/<label>` holds: the parent's own files, and
  // the nested dataset as an EMPTY directory.
  const snap = join(source, '.zfs', 'snapshot', LABEL)
  for (const entry of opts.snapshot ?? ['docs', 'photos'])
    await mkdir(join(snap, entry), { recursive: true })
  const fstab = join(dir, 'fstab')
  await writeFile(fstab, 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
  const mock = new MockExecutor()
  mock.addFixture({
    command: FINDMNT,
    args: ['--json'],
    result: {
      stdout: findmntJson([
        { target: source, source: 'tank/pictures', fstype: 'zfs' },
        { target: join(source, 'photos'), source: 'tank/pictures/photos', fstype: 'zfs' },
      ]),
      stderr: '',
      exitCode: 0,
    },
  })
  mock.addFixture({
    command: TIMEOUT,
    argsMatch: args => args.includes(FIND),
    result: opts.walk === 'fail'
      ? { stdout: '', stderr: '', exitCode: 127 }
      // `timeout` firing on the walk (its 20 s budget ran out): exit 124 with the rows so far.
      : opts.walk === 'slow'
        ? { stdout: `50\t${source}\n`, stderr: '', exitCode: 124 }
        : { stdout: `50\t${source}\n50\t${join(source, 'docs')}\n51\t${join(source, 'photos')}\n`, stderr: '', exitCode: 0 },
  })
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  // The complete ZFS read (third review, D3): the list carries the source's
  // own dataset — a list without it is not a complete read.
  zfsListFixture(mock, source)
  passThroughRealpath(mock)
  return { dir, source, fstab, mock, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * The complete ZFS read (third review, D3) answers with the source's own
 * dataset and its child: `argsMatch`, so a test's own EXACT `zfs list`
 * fixture still wins.
 */
function zfsListFixture(mock: MockExecutor, source: string): void {
  mock.addFixture({
    command: ZFS,
    argsMatch: args => args.join(' ') === ZFS_FILESYSTEMS_ARGS.join(' '),
    result: { stdout: `tank/pictures\t${source}\ton\ntank/pictures/photos\t${join(source, 'photos')}\ton\n`, stderr: '', exitCode: 0 },
  })
}

function runDeps(h: Harness, over: Partial<CloudSyncTask> = {}) {
  return {
    task: task({ source: h.source, ...over }),
    paths: { configFile: join(h.dir, 'rclone.conf') },
    fstabPath: h.fstab,
    consistencyOptions: { pveStorageCfg: join(h.dir, 'no-storage.cfg') },
    now: NOW,
  }
}

function zfsVerbs(mock: MockExecutor): string[] {
  return mock.calls.filter(c => c.command === ZFS).map(c => c.args.join(' '))
}

describe('cr3 CLOUD-H3: the nested-filesystem filter rules', () => {
  it('one anchored rule per nested filesystem, relative to the source root, glob characters escaped', () => {
    assert.deepEqual(
      nestedFilesystemExcludes('/tank/pictures', ['/tank/pictures/photos', '/tank/pictures/a*b[1]', '/tank/pictures/x/{y}', '/elsewhere/z', '/tank/pictures']),
      ['/a\\*b\\[1\\]/**', '/photos/**', '/x/\\{y\\}/**'],
    )
    assert.equal(rcloneGlobLiteral('a\\b?c'), 'a\\\\b\\?c')
  })

  it('buildRcloneArgs puts them after the task\'s own excludes; --one-file-system only when asked', () => {
    const args = buildRcloneArgs(task({ excludes: ['*.tmp'] }), '/etc/anas/rclone.conf', '/tank/pictures', { dryRun: true, excludes: ['/photos/**'], oneFileSystem: true })
    assert.deepEqual(args.slice(-6), ['--exclude', '*.tmp', '--exclude', '/photos/**', '--one-file-system', '--dry-run'])
    assert.ok(!buildRcloneArgs(task(), '/c', '/s').includes('--one-file-system'))
  })
})

describe('cr3 CLOUD-H3: a snapshot-mode run leaves the nested filesystems out', () => {
  it('a sync from the snapshot excludes the nested dataset (its copy at the destination is kept)', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      const result = await runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {})
      assert.equal(result.consistency.consistency, 'snapshot')
      const call = h.mock.calls.find(c => c.command === RCLONE)!
      assert.equal(call.args[0], 'sync')
      assert.equal(call.args[1], `${h.source}/.zfs/snapshot/${LABEL}`)
      const i = call.args.indexOf('/photos/**')
      assert.ok(i > 0 && call.args[i - 1] === '--exclude', call.args.join(' '))
      assert.ok(!call.args.includes('--one-file-system'), 'the run reads the snapshot; -x is the preview\'s')
      assert.deepEqual(result.nested, [join(h.source, 'photos')])
    }
    finally {
      await h.cleanup()
    }
  })

  it('a sync whose snapshot holds nothing but nested filesystems is refused as an empty source; the snapshot is destroyed', async () => {
    const h = await nestedHarness({ snapshot: ['photos'] })
    try {
      // The LIVE tree is not empty (docs/, photos/ with files), so the live
      // guard passes; the snapshot root holds only the nested dataset's empty
      // mountpoint directory, which the run excludes.
      await assert.rejects(
        runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {}),
        /an empty source in sync mode would delete everything at the destination/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE), 'rclone is never reached')
      assert.ok(zfsVerbs(h.mock).includes(`destroy -r -- tank/pictures@${LABEL}`), 'the transient is destroyed')
    }
    finally {
      await h.cleanup()
    }
  })

  it('review fix 1: a walk that FAILED or hit its time cap is a display warning — the sync runs, the excludes come from the mount table', async () => {
    for (const walk of ['fail', 'slow'] as const) {
      const h = await nestedHarness({ walk })
      try {
        h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
        const result = await runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {})
        assert.equal(result.consistency.consistency, 'snapshot')
        const call = h.mock.calls.find(c => c.command === RCLONE)!
        const i = call.args.indexOf('/photos/**')
        assert.ok(i > 0 && call.args[i - 1] === '--exclude', `${walk}: ${call.args.join(' ')}`)
        assert.ok(result.warnings?.some(w => /may be short/.test(w)), `${walk}: ${JSON.stringify(result.warnings)}`)
      }
      finally {
        await h.cleanup()
      }
    }
  })

  it('review fix 1: a healthy tree 15 directories deep (the walk\'s depth cap is 12) syncs — real find on a scratch tree', async () => {
    const h = await nestedHarness()
    try {
      await mkdir(join(h.source, ...Array.from({ length: 15 }, (_, i) => `d${i}`)), { recursive: true })
      h.mock.clearFixtures()
      h.mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: findmntJson([{ target: h.source, source: 'tank/pictures', fstype: 'zfs' }, { target: join(h.source, 'photos'), source: 'tank/pictures/photos', fstype: 'zfs' }]), stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      zfsListFixture(h.mock, h.source)
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      // The boundary walk is the REAL `timeout ... find` on the scratch tree.
      const orig = h.mock.exec.bind(h.mock)
      let walkRows = -1
      h.mock.exec = async (command: string, args: string[], o?: ExecOptions): Promise<ExecResult> => {
        if (command === TIMEOUT && args.includes(FIND)) {
          const r = spawnSync(command, args, { encoding: 'utf8' })
          walkRows = r.stdout.split('\n').filter(Boolean).length
          return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 }
        }
        return orig(command, args, o)
      }
      const result = await runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {})
      assert.equal(result.consistency.consistency, 'snapshot')
      assert.ok(h.mock.calls.some(c => c.command === RCLONE), 'rclone ran')
      assert.ok(walkRows >= 13, `the real walk ran and reached its depth cap (${walkRows} rows)`)
      assert.ok(result.warnings?.some(w => /may be short/.test(w)), JSON.stringify(result.warnings))
    }
    finally {
      await h.cleanup()
    }
  })

  it('review fix 1: a sync is refused only when a COMPLETE read failed (zfs list) — naming it; a copy goes on with a warning', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({ command: ZFS, args: [...ZFS_FILESYSTEMS_ARGS], result: { stdout: '', stderr: 'cannot open pool\n', exitCode: 1 } })
      await assert.rejects(
        runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {}),
        /syncs from a snapshot, which holds no nested filesystem, and the nested filesystems under it could not be listed \(zfs list exited 1: cannot open pool\)/,
      )
      assert.ok(!zfsVerbs(h.mock).some(v => v.startsWith('snapshot ')), 'no snapshot was taken')
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      const copy = await runCloudSync(h.mock, runDeps(h, { mode: 'copy' }), () => {})
      assert.ok(copy.warnings?.some(w => /could not be listed/.test(w)), JSON.stringify(copy.warnings))
    }
    finally {
      await h.cleanup()
    }
  })

  it('review fix 1: a child dataset that is NOT mounted (zfs list only) is excluded too — its destination copy survives', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({ command: ZFS, args: [...ZFS_FILESYSTEMS_ARGS], result: { stdout: `tank/pictures\t${h.source}\ton\ntank/pictures/locked\t${join(h.source, 'locked')}\ton\ntank/other\t/tank/other\ton\n`, stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      await runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {})
      const call = h.mock.calls.find(c => c.command === RCLONE)!
      assert.ok(call.args.includes('/locked/**') && call.args.includes('/photos/**'), call.args.join(' '))
      assert.ok(!call.args.some(a => a.includes('other')), 'a dataset outside the source names nothing')
    }
    finally {
      await h.cleanup()
    }
  })

  it('review fix 5: a nested mount whose name has a control character refuses a snapshot-mode sync, naming the dataset; a copy runs', async () => {
    const h = await nestedHarness()
    try {
      h.mock.clearFixtures()
      h.mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: findmntJson([{ target: h.source, source: 'tank/pictures', fstype: 'zfs' }, { target: join(h.source, 'ra\tw'), source: 'tank/pictures/raw', fstype: 'zfs' }]), stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(FIND), result: { stdout: `50\t${h.source}\n`, stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      zfsListFixture(h.mock, h.source)
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      await assert.rejects(
        runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {}),
        /\(tank\/pictures\/raw\) has a control character in its name, which rclone encodes - the run cannot leave it out/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
      await runCloudSync(h.mock, runDeps(h, { mode: 'copy' }), () => {})
      assert.ok(h.mock.calls.some(c => c.command === RCLONE), 'a copy never deletes: it runs')
    }
    finally {
      await h.cleanup()
    }
  })

  it('a LIVE source keeps today\'s argv: no nested rule (live mode crosses into them, as before)', async () => {
    const h = await nestedHarness()
    try {
      // findmnt without the parent dataset row: the source is on `/` (ext4) → live.
      h.mock.clearFixtures()
      h.mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: findmntJson([{ target: join(h.source, 'photos'), source: 'tank/pictures/photos', fstype: 'zfs' }]), stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(FIND), result: { stdout: `50\t${h.source}\n51\t${join(h.source, 'photos')}\n`, stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      const result = await runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {})
      assert.equal(result.consistency.consistency, 'live')
      const call = h.mock.calls.find(c => c.command === RCLONE)!
      assert.equal(call.args[1], h.source)
      assert.ok(!call.args.includes('--exclude'), call.args.join(' '))
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('cr3 CLOUD-H3: the preview counts what the run will do', () => {
  function previewDeps(h: Harness, over: Partial<CloudSyncTask> = {}) {
    return cloudPreviewDeps(task({ source: h.source, ...over }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab, { pveStorageCfg: join(h.dir, 'no-storage.cfg') })
  }

  it('a snapshot-mode task\'s look carries the run\'s nested excludes and --one-file-system, on the live tree', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      await previewCloudSync(h.mock, previewDeps(h, { mode: 'sync' }))
      const call = h.mock.calls.find(c => c.command === TIMEOUT && c.args.includes(RCLONE))!
      assert.equal(call.args[3], h.source, 'the look reads the live tree')
      const i = call.args.indexOf('/photos/**')
      assert.ok(i > 0 && call.args[i - 1] === '--exclude', call.args.join(' '))
      assert.ok(call.args.includes('--one-file-system'))
      assert.equal(call.args.at(-1), '--dry-run')
      assert.ok(!zfsVerbs(h.mock).some(v => v.startsWith('snapshot ') || v.startsWith('destroy ')), 'a look takes no snapshot')
    }
    finally {
      await h.cleanup()
    }
  })

  it('review fix 1: the look needs no walk; a failed COMPLETE read (zfs list) fails a sync look with the run\'s sentence', async () => {
    const h = await nestedHarness({ walk: 'fail' })
    try {
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      await previewCloudSync(h.mock, previewDeps(h, { mode: 'sync' }))
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes(FIND)), 'no boundary walk for the look')
      assert.ok(h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes(RCLONE)), 'the dry run ran')
      h.mock.calls.length = 0
      h.mock.addFixture({ command: ZFS, args: [...ZFS_FILESYSTEMS_ARGS], result: { stdout: '', stderr: 'boom\n', exitCode: 1 } })
      await assert.rejects(previewCloudSync(h.mock, previewDeps(h, { mode: 'sync' })), /could not be listed \(zfs list exited 1: boom\)/)
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes(RCLONE)), 'no dry run was issued')
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('cr3 CLOUD-M4: consistency is derived on the source\'s REAL path', () => {
  it('a symlinked source is snapshotted on the dataset it leads to, and rclone reads that snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloudlink-'))
    try {
      const share = join(dir, 'share')
      const other = join(dir, 'other')
      await mkdir(join(other, 'photos'), { recursive: true })
      await writeFile(join(other, 'photos', 'p.jpg'), 'x', 'utf-8')
      await mkdir(share, { recursive: true })
      const link = join(share, 'link')
      await symlink(join(other, 'photos'), link)
      const fstab = join(dir, 'fstab')
      await writeFile(fstab, 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
      const mock = new MockExecutor()
      mock.addFixture({
        command: FINDMNT,
        args: ['--json'],
        result: { stdout: findmntJson([{ target: share, source: 'tank/share', fstype: 'zfs' }, { target: other, source: 'tank/other', fstype: 'zfs' }]), stderr: '', exitCode: 0 },
      })
      // The source guard's bounded `realpath -e` — the one resolution the run uses.
      mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', REALPATH, '-e', '--', link], result: { stdout: `${join(other, 'photos')}\n`, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })

      const result = await runCloudSync(mock, {
        task: task({ source: link }),
        paths: { configFile: join(dir, 'rclone.conf') },
        fstabPath: fstab,
        consistencyOptions: { pveStorageCfg: join(dir, 'no-storage.cfg') },
        now: NOW,
      }, () => {})

      assert.equal(result.consistency.target, 'tank/other')
      assert.match(result.consistency.reason, new RegExp(`^${link.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is on the ZFS dataset tank/other`))
      assert.equal(result.snapshot, `tank/other@${LABEL}`)
      assert.ok(zfsVerbs(mock).includes(`snapshot -r -- tank/other@${LABEL}`), zfsVerbs(mock).join(' | '))
      assert.ok(!zfsVerbs(mock).some(v => v.includes('tank/share@')), 'the dataset the TEXT names is never snapshotted')
      const call = mock.calls.find(c => c.command === RCLONE)!
      assert.equal(call.args[1], `${other}/.zfs/snapshot/${LABEL}/photos`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3 CLOUD-M6: a source whose filesystem does not answer is refused before it is read', () => {
  async function deadHarness(): Promise<Harness> {
    const h = await nestedHarness()
    // `timeout -k 1 2 stat -f` exits 124 when the stat did not return in 2 s
    // (the capture behind share-path.ts: a dead hard NFS mount).
    h.mock.addFixture({ command: TIMEOUT, args: sharePathProbeArgs(h.source), result: { stdout: '', stderr: '', exitCode: 124 } })
    return h
  }

  it('the run fails with the sentence; nothing is snapshotted, rclone never runs', async () => {
    const h = await deadHarness()
    try {
      await assert.rejects(runCloudSync(h.mock, runDeps(h), () => {}), /did not answer \(the stat did not return within 2 s\) - the filesystem it is on is not responding/)
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
      assert.ok(!zfsVerbs(h.mock).some(v => v.startsWith('snapshot ')))
    }
    finally {
      await h.cleanup()
    }
  })

  it('the preview door refuses it the same way (a PreviewRefusal: the route\'s 400)', async () => {
    const h = await deadHarness()
    try {
      await assert.rejects(
        previewCloudSync(h.mock, cloudPreviewDeps(task({ source: h.source }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab)),
        (err: unknown) => err instanceof PreviewRefusal && /did not answer/.test(err.message),
      )
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('cr3 (operator ruling): what happens to the nested filesystems is said per mode', () => {
  it('the run\'s progress line: a snapshot leaves them out (copies kept), a live copy includes them', () => {
    assert.equal(
      nestedProgressLine('/tank/pictures', ['/tank/pictures/raw'], true),
      '1 nested filesystem(s) under /tank/pictures are not included (a snapshot holds one filesystem; their copies at the destination are left as they are): /tank/pictures/raw',
    )
    assert.equal(
      nestedProgressLine('/mnt/nas', ['/mnt/nas/usb'], false),
      '1 nested filesystem(s) under /mnt/nas are included (a live copy reads through them): /mnt/nas/usb',
    )
  })

  it('a LIVE run says so in its progress, never "not included"', async () => {
    const h = await nestedHarness()
    try {
      h.mock.clearFixtures()
      h.mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: findmntJson([{ target: join(h.source, 'photos'), source: 'tank/pictures/photos', fstype: 'zfs' }]), stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(FIND), result: { stdout: `50\t${h.source}\n51\t${join(h.source, 'photos')}\n`, stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      const progress: string[] = []
      const result = await runCloudSync(h.mock, runDeps(h), m => progress.push(m))
      assert.equal(result.consistency.consistency, 'live')
      assert.ok(progress.some(p => /nested filesystem\(s\) under .* are included \(a live copy reads through them\)/.test(p)), progress.join(' | '))
      assert.ok(!progress.some(p => /not included/.test(p)), progress.join(' | '))
    }
    finally {
      await h.cleanup()
    }
  })

  it('the notification: a live run lists them as included, a snapshot run as NOT included with the destination note', () => {
    const base = {
      status: 'success' as const,
      mode: 'copy' as const,
      source: '/mnt/nas',
      destination: 'b:x',
      bytes: 0,
      totalBytes: 0,
      transfers: 0,
      checks: 0,
      deletes: 0,
      errors: 0,
      elapsed: 1,
      countersReported: true,
      errorLines: [],
      nested: ['/mnt/nas/usb'],
    }
    const t = task({ source: '/mnt/nas' })
    const live = buildCloudNotifyBody({ task: t, result: { ...base, consistency: { consistency: 'live', reason: 'r' } } })
    assert.match(live, /^Nested filesystems included \(read through as a live copy\):\n {2}\/mnt\/nas\/usb\n {2}\(a live copy reads through them\)$/m)
    assert.ok(!/NOT included/.test(live))
    const snap = buildCloudNotifyBody({ task: t, result: { ...base, consistency: { consistency: 'snapshot', reason: 'r', backend: 'zfs', target: 'tank/x' } } })
    assert.match(snap, /^Nested filesystems NOT included:\n {2}\/mnt\/nas\/usb\n {2}\(a snapshot holds one filesystem; their copies at the destination are left as they are\)$/m)
  })
})

describe('review fix 6: a reader\'s look reads the REAL path that was bounded', () => {
  it('a source re-resolving elsewhere between the check and the look is refused; nothing is read', async () => {
    const h = await nestedHarness()
    try {
      // The route bounded /.../pictures; the job's re-resolution now says the source leads elsewhere.
      h.mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', REALPATH, '-e', '--', h.source], result: { stdout: '/root\n', stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      const deps = { ...cloudPreviewDeps(task({ source: h.source }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab), realSource: h.source, pinRealSource: true }
      await assert.rejects(runPreview(h.mock, deps), /now resolves to \/root \(it was not a link when the preview was asked for\) - nothing was read/)
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes(RCLONE)))
    }
    finally {
      await h.cleanup()
    }
  })

  it('unchanged: rclone is handed the bounded real path', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      const deps = { ...cloudPreviewDeps(task({ source: h.source }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab), realSource: h.source, pinRealSource: true }
      await runPreview(h.mock, deps)
      const call = h.mock.calls.find(c => c.command === TIMEOUT && c.args.includes(RCLONE))!
      assert.equal(call.args[3], h.source)
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('cr3 backup hand-off: a source whose mount table could not be read is refused (run and preview)', () => {
  async function unreadableTable(): Promise<Harness> {
    const h = await nestedHarness()
    h.mock.clearFixtures()
    h.mock.addFixture({ command: FINDMNT, result: { stdout: '', stderr: 'findmnt: can\'t read /proc/self/mountinfo\n', exitCode: 1 } })
    h.mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
    h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
    return h
  }

  it('the run is refused before anything is read or taken', async () => {
    const h = await unreadableTable()
    try {
      await assert.rejects(runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {}), /mount table/i)
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
    }
    finally {
      await h.cleanup()
    }
  })

  it('the preview is refused at the door (a PreviewRefusal: the route\'s 400)', async () => {
    const h = await unreadableTable()
    try {
      await assert.rejects(
        previewCloudSync(h.mock, cloudPreviewDeps(task({ source: h.source, mode: 'sync' }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab)),
        (err: unknown) => err instanceof PreviewRefusal && /mount table/i.test(err.message),
      )
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes(RCLONE)))
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('second review (E1): the ZFS half of the complete nested read', () => {
  it('a dataset that is NOT a descendant but is mounted (or would be) inside the source is excluded; canmount=off is not', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({
        command: ZFS,
        args: [...ZFS_FILESYSTEMS_ARGS],
        result: {
          stdout: [
            `tank/pictures\t${h.source}\ton`,
            `other/elsewhere\t${join(h.source, 'foreign')}\ton`,
            `tank/pictures/later\t${join(h.source, 'later')}\tnoauto`,
            `tank/pictures/holder\t${join(h.source, 'holder')}\toff`,
            `tank/pictures/legacy\tlegacy\ton`,
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        },
      })
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
      await runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {})
      const args = h.mock.calls.find(c => c.command === RCLONE)!.args
      for (const rule of ['/foreign/**', '/later/**', '/photos/**'])
        assert.ok(args.includes(rule), `${rule}: ${args.join(' ')}`)
      assert.ok(!args.includes('/holder/**'), 'canmount=off holds the PARENT\'s data: it rides the snapshot, never excluded')
    }
    finally {
      await h.cleanup()
    }
  })

  it('third review (D3): exit 0 with NO rows, or without the source\'s own dataset, is not a complete read: sync refused, copy warned', async () => {
    for (const stdout of ['', `other/x\t/other/x\ton\n`]) {
      const h = await nestedHarness()
      try {
        h.mock.addFixture({ command: ZFS, args: [...ZFS_FILESYSTEMS_ARGS], result: { stdout, stderr: '', exitCode: 0 } })
        await assert.rejects(runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {}), /could not be listed \(zfs list answered no row for the source's dataset tank\/pictures\)/)
        assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
        h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
        const copy = await runCloudSync(h.mock, runDeps(h, { mode: 'copy' }), () => {})
        assert.ok(copy.warnings?.some(w => /no row for the source's dataset/.test(w)), JSON.stringify(copy.warnings))
      }
      finally {
        await h.cleanup()
      }
    }
  })

  it('zfs list exit 0 with a row that does not parse, or a spawn that failed (ENOENT), is a FAILED complete read: the sync is refused', async () => {
    for (const shape of ['garbage', 'enoent'] as const) {
      const h = await nestedHarness()
      try {
        if (shape === 'garbage') {
          h.mock.addFixture({ command: ZFS, args: [...ZFS_FILESYSTEMS_ARGS], result: { stdout: `tank/pictures\t${h.source}\n`, stderr: '', exitCode: 0 } })
        }
        else {
          const err = new Error('spawn /usr/sbin/zfs ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          h.mock.addFixture({ command: ZFS, args: [...ZFS_FILESYSTEMS_ARGS], throws: err })
        }
        await assert.rejects(runCloudSync(h.mock, runDeps(h, { mode: 'sync' }), () => {}), /could not be listed \(zfs list (answered a row that does not parse|could not run)/, shape)
        assert.ok(!h.mock.calls.some(c => c.command === RCLONE), shape)
      }
      finally {
        await h.cleanup()
      }
    }
  })
})

describe('second review (C1): the look\'s re-resolution never reads "unchanged" from a failure', () => {
  for (const [label, result] of [['failed', { stdout: '', stderr: 'realpath: x: Input/output error\n', exitCode: 1 }], ['did not answer', { stdout: '', stderr: '', exitCode: 124 }]] as const) {
    it(`a re-resolution that ${label} refuses ("could not be checked") — nothing is read`, async () => {
      const h = await nestedHarness()
      try {
        h.mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', REALPATH, '-e', '--', h.source], result })
        h.mock.addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: `${FINAL_STATS}\n`, exitCode: 0 } })
        const deps = { ...cloudPreviewDeps(task({ source: h.source }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab), realSource: h.source, pinRealSource: true }
        await assert.rejects(runPreview(h.mock, deps), /could not be checked again before the look .* - nothing was read/)
        assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes(RCLONE)))
      }
      finally {
        await h.cleanup()
      }
    })
  }

  it('a link that now leads somewhere else names both places', async () => {
    const h = await nestedHarness()
    try {
      h.mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', REALPATH, '-e', '--', h.source], result: { stdout: '/elsewhere\n', stderr: '', exitCode: 0 } })
      const deps = { ...cloudPreviewDeps(task({ source: h.source }), { configFile: join(h.dir, 'rclone.conf') }, h.fstab), realSource: '/was/here', pinRealSource: true }
      await assert.rejects(runPreview(h.mock, deps), /now resolves to \/elsewhere, not to \/was\/here as when the preview was asked for/)
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('third review (D4): the checked resolution keeps a trailing space — only the one newline goes', () => {
  it('`/src/dir \\n` resolves to `/src/dir ` (a trimmed answer would preview another directory)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', REALPATH, '-e', '--', '/src/dir '], result: { stdout: '/src/dir \n', stderr: '', exitCode: 0 } })
    assert.deepEqual(await resolveSourceChecked(mock, '/src/dir '), { real: '/src/dir ' })
  })
})
