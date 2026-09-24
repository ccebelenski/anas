import type { CloudSyncTask } from '@anas/shared'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildRcloneArgs,
  emptySourceRefusal,
  errorLineOf,
  missingSourceRefusal,
  RCLONE_LOG_ARGS,
  rcloneDestination,
  rcloneFailureMessage,
  RcloneLogReader,
  rcloneRunCompleted,
  readRcloneLog,
  runCloudSync,
  statsOf,
  statsProgressLine,
} from '../cloud-runner.js'
import { RCLONE } from '../rclone-config.js'

/**
 * The cloud sync RUN (rclone.2): the argv, rclone's JSON log, the exit-code
 * policy, the three guards and the transient-snapshot path.
 *
 * The JSON-log fixtures below are the shapes DESIGN's 2026-09-23 ground truth
 * records for rclone 1.60.1 — one object per line on stderr, a `stats` object
 * at every `--stats` interval, error-level lines naming the object they failed
 * on.
 */

const FINDMNT = '/usr/bin/findmnt'
const ZFS = '/usr/sbin/zfs'
const CONFIG = '/etc/anas/rclone.conf'
const NOW = new Date(1_700_000_000_000)
const LABEL = 'anas-cloud-offsite-1700000000'

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

function statsLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: 'info',
    msg: '\nTransferred:   \t 1 MiB / 4 MiB, 25%',
    source: 'accounting/stats.go:479',
    time: '2026-09-24T02:00:30.001+00:00',
    stats: {
      bytes: 1048576,
      checks: 12,
      deletedDirs: 0,
      deletes: 0,
      elapsedTime: 30.001,
      errors: 0,
      eta: 45,
      fatalError: false,
      renames: 0,
      retryError: false,
      speed: 34952.5,
      totalBytes: 4194304,
      totalChecks: 12,
      totalTransfers: 5,
      transferTime: 29.5,
      transfers: 3,
      ...over,
    },
  })
}

const ERROR_LINE = JSON.stringify({
  level: 'error',
  msg: 'Failed to copy: failed to open source object: open /tank/pictures/a.jpg: permission denied',
  object: 'a.jpg',
  objectType: '*local.Object',
  source: 'operations/copy.go:368',
  time: '2026-09-24T02:00:12.000+00:00',
})

/** The final stats object of a clean run: everything transferred. */
const FINAL_STATS = statsLine({ bytes: 4194304, totalBytes: 4194304, transfers: 5, eta: 0, elapsedTime: 61.2 })

describe('cloud sync runner — argv (rclone.2)', () => {
  it('builds the DESIGN argv: mode, source, remote:path, config, JSON log', () => {
    assert.deepEqual(buildRcloneArgs(task({ excludes: [], bwlimit: undefined }), CONFIG, '/tank/pictures'), [
      'copy',
      '/tank/pictures',
      'backblaze:pve1/pictures',
      '--config',
      CONFIG,
      '--ask-password=false',
      ...RCLONE_LOG_ARGS,
    ])
  })

  it('appends --bwlimit and one --exclude per pattern, in order', () => {
    const args = buildRcloneArgs(task({ mode: 'sync', bwlimit: '8M', excludes: ['*.tmp', 'Cache/**'] }), CONFIG, '/src')
    assert.equal(args[0], 'sync')
    assert.deepEqual(args.slice(-6), ['--bwlimit', '8M', '--exclude', '*.tmp', '--exclude', 'Cache/**'])
  })

  it('an EMPTY remote path is the remote root, not a trailing-slash guess', () => {
    assert.equal(rcloneDestination(task({ path: '' })), 'backblaze:')
    assert.equal(buildRcloneArgs(task({ path: '' }), CONFIG, '/src')[2], 'backblaze:')
  })

  it('the source it is handed is the source it uses (the snapshot path)', () => {
    const snap = '/tank/pictures/.zfs/snapshot/anas-cloud-offsite-1700000000'
    assert.equal(buildRcloneArgs(task(), CONFIG, snap)[1], snap)
  })
})

describe('cloud sync runner — rclone\'s JSON log', () => {
  it('reads a stats object, and the LAST one wins', () => {
    const log = readRcloneLog([statsLine(), FINAL_STATS].join('\n'))
    assert.deepEqual(log.stats, {
      bytes: 4194304,
      totalBytes: 4194304,
      transfers: 5,
      checks: 12,
      deletes: 0,
      errors: 0,
      elapsedTime: 61.2,
      eta: 0,
      fatalError: false,
    })
  })

  it('collects error-level lines verbatim, naming the object', () => {
    const log = readRcloneLog([statsLine(), ERROR_LINE, FINAL_STATS].join('\n'))
    assert.deepEqual(log.errorLines, [
      'a.jpg: Failed to copy: failed to open source object: open /tank/pictures/a.jpg: permission denied',
    ])
  })

  it('an error with no object keeps the message alone; info lines are not errors', () => {
    assert.equal(errorLineOf({ level: 'error', msg: 'directory not found' }), 'directory not found')
    assert.equal(errorLineOf({ level: 'info', msg: 'something' }), null)
    assert.equal(errorLineOf({ level: 'error', msg: '   ' }), null)
    // `critical` is an error too — a fatal one.
    assert.equal(errorLineOf({ level: 'critical', msg: 'Fatal error: boom' }), 'Fatal error: boom')
  })

  it('a line that is not JSON is kept raw, not silently dropped', () => {
    const log = readRcloneLog(['panic: runtime error', FINAL_STATS].join('\n'))
    assert.deepEqual(log.rawLines, ['panic: runtime error'])
    assert.ok(log.stats)
  })

  it('an object with no stats key yields no stats', () => {
    assert.equal(statsOf({ level: 'info', msg: 'x' }), null)
    assert.equal(statsOf({ stats: 'not an object' }), null)
  })

  it('missing counters read as 0 rather than NaN, and a null eta stays null', () => {
    const log = readRcloneLog(JSON.stringify({ level: 'info', stats: { bytes: 5, eta: null } }))
    assert.deepEqual(log.stats, {
      bytes: 5,
      totalBytes: 0,
      transfers: 0,
      checks: 0,
      deletes: 0,
      errors: 0,
      elapsedTime: 0,
      eta: null,
      fatalError: false,
    })
  })

  describe('chunk buffering (onStderr splits wherever the pipe broke)', () => {
    it('reassembles a stats object split across three chunks', () => {
      const reader = new RcloneLogReader()
      const text = `${FINAL_STATS}\n`
      assert.deepEqual(reader.push(text.slice(0, 20)), [], 'no complete line yet')
      assert.deepEqual(reader.push(text.slice(20, 60)), [])
      const stats = reader.push(text.slice(60))
      assert.equal(stats[0]?.bytes, 4194304, 'the chunk that completed the line publishes it')
    })

    it('a final line with no trailing newline is read by flush()', () => {
      const reader = new RcloneLogReader()
      assert.deepEqual(reader.push(FINAL_STATS), [])
      assert.equal(reader.flush()[0]?.bytes, 4194304)
      assert.deepEqual(reader.flush(), [], 'flush is idempotent')
    })

    it('reports each stats object exactly once, in order', () => {
      const reader = new RcloneLogReader()
      const seen: number[] = []
      for (const chunk of [`${statsLine({ bytes: 1 })}\n`, `${ERROR_LINE}\n`, `${statsLine({ bytes: 2 })}\n`])
        seen.push(...reader.push(chunk).map(s => s.bytes))
      assert.deepEqual(seen, [1, 2])
      assert.equal(reader.errorLines.length, 1)
    })

    it('a chunk carrying SEVERAL stats objects publishes every one of them', () => {
      const reader = new RcloneLogReader()
      const both = reader.push(`${statsLine({ bytes: 1 })}\n${statsLine({ bytes: 2 })}\n`)
      assert.deepEqual(both.map(s => s.bytes), [1, 2])
    })
  })

  it('a progress line labels every number rclone reported', () => {
    const stats = readRcloneLog(statsLine()).stats!
    assert.equal(
      statsProgressLine('copy', stats),
      'copy: 1048576 of 4194304 bytes, 3 transferred, 12 checked, 0 deleted, 0 errors, ETA 45s',
    )
    const noEta = readRcloneLog(statsLine({ eta: null })).stats!
    assert.ok(!statsProgressLine('sync', noEta).includes('ETA'))
  })
})

describe('cloud sync runner — the exit-code policy', () => {
  it('only 0 and 9 complete (DESIGN: 6 is a FAILURE, files are missing)', () => {
    assert.equal(rcloneRunCompleted(0), true)
    assert.equal(rcloneRunCompleted(9), true)
    for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 10, 127])
      assert.equal(rcloneRunCompleted(code), false, `exit ${code} must fail`)
  })

  it('exit 6 says plainly what it means', () => {
    const msg = rcloneFailureMessage('copy', 6, readRcloneLog(ERROR_LINE))
    assert.match(msg, /^rclone copy failed \(exit 6\) - some files could not be transferred and are missing at the destination: /)
    assert.match(msg, /a\.jpg: Failed to copy/)
  })

  it('other codes carry rclone\'s error lines, joined', () => {
    const log = readRcloneLog([ERROR_LINE, JSON.stringify({ level: 'error', msg: 'second problem' })].join('\n'))
    assert.equal(
      rcloneFailureMessage('sync', 7, log),
      'rclone sync failed (exit 7): a.jpg: Failed to copy: failed to open source object: '
      + 'open /tank/pictures/a.jpg: permission denied; second problem',
    )
  })

  it('falls back to the raw output, then to the bare code', () => {
    assert.equal(
      rcloneFailureMessage('copy', 1, readRcloneLog('Failed to create file system for "backblaze:": not found')),
      'rclone copy failed (exit 1): Failed to create file system for "backblaze:": not found',
    )
    assert.equal(rcloneFailureMessage('copy', 1, readRcloneLog('')), 'rclone copy failed (exit 1)')
  })
})

describe('cloud sync runner — the guards\' sentences', () => {
  it('the empty-source refusal is DESIGN\'s sentence and names the manual fix', () => {
    const msg = emptySourceRefusal('/tank/pictures', CONFIG, 'backblaze:pve1/pictures')
    assert.match(msg, /an empty source in sync mode would delete everything at the destination/)
    assert.match(msg, /rclone --config \/etc\/anas\/rclone\.conf purge backblaze:pve1\/pictures/)
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x00-\x7F]/.test(msg), 'ASCII only')
  })

  it('the missing-source refusal says a task copies a directory tree', () => {
    assert.match(missingSourceRefusal('/dev/zvol/tank/vm'), /does not exist or is not a directory/)
  })
})

// ---------------------------------------------------------------------------
//  runCloudSync — the whole run over the mock executor
// ---------------------------------------------------------------------------

/** A findmnt capture with `/` plus whatever rows the case needs. */
function findmntJson(extra: { target: string, source: string, fstype: string }[] = []): string {
  return JSON.stringify({
    filesystems: [
      { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
      ...extra.map(e => ({ ...e, options: 'rw' })),
    ],
  })
}

interface Harness {
  dir: string
  source: string
  fstab: string
  mock: MockExecutor
  progress: string[]
  cleanup: () => Promise<void>
}

async function harness(opts: { findmnt?: string, fstab?: string } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-cloudrun-'))
  const source = join(dir, 'source')
  const fstab = join(dir, 'fstab')
  await writeFile(fstab, opts.fstab ?? 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
  const mock = new MockExecutor()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: opts.findmnt ?? findmntJson(), stderr: '', exitCode: 0 } })
  return {
    dir,
    source,
    fstab,
    mock,
    progress: [],
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function deps(h: Harness, over: Partial<Parameters<typeof runCloudSync>[1]> = {}) {
  return {
    task: task({ source: h.source }),
    paths: { configFile: CONFIG },
    fstabPath: h.fstab,
    // Absent storage.cfg = no PVE footprint at all (the parser's fail-open).
    consistencyOptions: { pveStorageCfg: join(h.dir, 'no-storage.cfg') },
    now: NOW,
    ...over,
  }
}

describe('runCloudSync — guards', () => {
  it('refuses a source on a configured-but-unmounted mount, naming it', async () => {
    const h = await harness({
      fstab: 'UUID=deadbeef / ext4 defaults 0 1\n//nas/pictures /mnt/pictures cifs nofail 0 0\n',
    })
    try {
      await assert.rejects(
        runCloudSync(h.mock, deps(h, { task: task({ source: '/mnt/pictures/2026' }) }), m => h.progress.push(m)),
        /\/mnt\/pictures.*not mounted right now/s,
      )
      // Nothing was executed past the guard.
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE), 'rclone is never reached')
    }
    finally {
      await h.cleanup()
    }
  })

  it('refuses a source that does not exist', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        runCloudSync(h.mock, deps(h), m => h.progress.push(m)),
        /does not exist or is not a directory/,
      )
    }
    finally {
      await h.cleanup()
    }
  })

  it('refuses a source that is a FILE, not a directory', async () => {
    const h = await harness()
    try {
      await writeFile(h.source, 'not a directory', 'utf-8')
      await assert.rejects(runCloudSync(h.mock, deps(h), () => {}), /is not a directory/)
    }
    finally {
      await h.cleanup()
    }
  })

  it('refuses an EMPTY source in sync mode — the catastrophic shape', async () => {
    const h = await harness()
    try {
      await mkdir(h.source, { recursive: true })
      await assert.rejects(
        runCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }), () => {}),
        /an empty source in sync mode would delete everything at the destination/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
    }
    finally {
      await h.cleanup()
    }
  })

  it('an empty source in COPY mode is a harmless no-op, not a refusal', async () => {
    const h = await harness()
    try {
      await mkdir(h.source, { recursive: true })
      h.mock.addFixture({
        command: RCLONE,
        result: { stdout: '', stderr: statsLine({ bytes: 0, totalBytes: 0, transfers: 0, eta: 0 }), exitCode: 9 },
      })
      const result = await runCloudSync(h.mock, deps(h), m => h.progress.push(m))
      assert.equal(result.status, 'success')
      assert.equal(result.bytes, 0)
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('runCloudSync — a live run', () => {
  async function liveHarness(): Promise<Harness> {
    const h = await harness()
    await mkdir(h.source, { recursive: true })
    await writeFile(join(h.source, 'a.jpg'), 'x', 'utf-8')
    return h
  }

  it('runs rclone over the LIVE tree, reports the final stats and takes no snapshot', async () => {
    const h = await liveHarness()
    try {
      h.mock.addFixture({
        command: RCLONE,
        result: { stdout: '', stderr: [statsLine(), FINAL_STATS].join('\n'), exitCode: 0 },
      })
      const result = await runCloudSync(h.mock, deps(h), m => h.progress.push(m))

      assert.equal(result.status, 'success')
      assert.equal(result.mode, 'copy')
      assert.equal(result.consistency.consistency, 'live')
      assert.equal(result.source, h.source, 'the live tree IS the source')
      assert.equal(result.destination, 'backblaze:pve1/pictures')
      assert.equal(result.snapshot, undefined)
      assert.deepEqual(
        { bytes: result.bytes, totalBytes: result.totalBytes, transfers: result.transfers, checks: result.checks, errors: result.errors, elapsed: result.elapsed },
        { bytes: 4194304, totalBytes: 4194304, transfers: 5, checks: 12, errors: 0, elapsed: 61.2 },
      )
      // No snapshot was TAKEN or destroyed (the footprint read still asks zfs
      // for its mountpoint list, which is a read, not a mutation).
      const mutations = h.mock.calls.filter(c => c.command === ZFS && (c.args[0] === 'snapshot' || c.args[0] === 'destroy'))
      assert.deepEqual(mutations, [])

      const rcloneCall = h.mock.calls.find(c => c.command === RCLONE)!
      assert.deepEqual(rcloneCall.args.slice(0, 3), ['copy', h.source, 'backblaze:pve1/pictures'])
      assert.ok(rcloneCall.args.includes('--use-json-log'))
      assert.ok(rcloneCall.args.includes('--ask-password=false'))
    }
    finally {
      await h.cleanup()
    }
  })

  it('publishes each stats object as job progress while the run is in flight', async () => {
    const h = await liveHarness()
    try {
      h.mock.addFixture({
        command: RCLONE,
        result: { stdout: '', stderr: `${[statsLine(), FINAL_STATS].join('\n')}\n`, exitCode: 0 },
      })
      await runCloudSync(h.mock, deps(h), m => h.progress.push(m))
      const stats = h.progress.filter(p => p.startsWith('copy: '))
      assert.ok(stats.length >= 2, `expected a progress line per stats object, got ${JSON.stringify(stats)}`)
      assert.match(stats[0], /1048576 of 4194304 bytes/)
      assert.match(stats.at(-1)!, /4194304 of 4194304 bytes/)
    }
    finally {
      await h.cleanup()
    }
  })

  it('carries rclone\'s error lines on a completed-with-errors run', async () => {
    const h = await liveHarness()
    try {
      h.mock.addFixture({
        command: RCLONE,
        result: { stdout: '', stderr: [ERROR_LINE, statsLine({ errors: 1 })].join('\n'), exitCode: 0 },
      })
      const result = await runCloudSync(h.mock, deps(h), () => {})
      assert.equal(result.errors, 1)
      assert.deepEqual(result.errorLines, [
        'a.jpg: Failed to copy: failed to open source object: open /tank/pictures/a.jpg: permission denied',
      ])
    }
    finally {
      await h.cleanup()
    }
  })

  it('a non-completing exit THROWS with rclone\'s lines', async () => {
    const h = await liveHarness()
    try {
      h.mock.addFixture({
        command: RCLONE,
        result: { stdout: '', stderr: [ERROR_LINE, statsLine({ errors: 1 })].join('\n'), exitCode: 6 },
      })
      await assert.rejects(
        runCloudSync(h.mock, deps(h), () => {}),
        /rclone copy failed \(exit 6\) - some files could not be transferred.*a\.jpg: Failed to copy/s,
      )
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('runCloudSync — the transient snapshot', () => {
  /** A source that findmnt reports as a mounted ZFS dataset. */
  async function zfsHarness(): Promise<Harness> {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cloudrun-'))
    const source = join(dir, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'a.jpg'), 'x', 'utf-8')
    const fstab = join(dir, 'fstab')
    await writeFile(fstab, 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
    const mock = new MockExecutor()
    mock.addFixture({
      command: FINDMNT,
      args: ['--json'],
      result: { stdout: findmntJson([{ target: source, source: 'tank/pictures', fstype: 'zfs' }]), stderr: '', exitCode: 0 },
    })
    // Every zfs verb succeeds; the sweep's list is empty (no stale transients).
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    return { dir, source, fstab, mock, progress: [], cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  it('snapshots the dataset, points rclone at the snapshot path, destroys it after', async () => {
    const h = await zfsHarness()
    try {
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: FINAL_STATS, exitCode: 0 } })
      const result = await runCloudSync(h.mock, deps(h), m => h.progress.push(m))

      assert.equal(result.consistency.consistency, 'snapshot')
      assert.equal(result.source, `${h.source}/.zfs/snapshot/${LABEL}`)
      assert.equal(result.snapshot, `tank/pictures@${LABEL}`)

      const zfsArgs = h.mock.calls.filter(c => c.command === ZFS).map(c => c.args.join(' '))
      assert.ok(zfsArgs.includes(`snapshot -r tank/pictures@${LABEL}`), zfsArgs.join(' | '))
      assert.ok(zfsArgs.includes(`destroy -r tank/pictures@${LABEL}`), 'destroyed in the finally')
      // The sweep is scoped to this task's own labels, on this dataset.
      assert.ok(zfsArgs.some(a => a.startsWith('list -t snapshot -Hp -o name -r tank/pictures')))

      // rclone read the SNAPSHOT, never the live tree.
      const rcloneCall = h.mock.calls.find(c => c.command === RCLONE)!
      assert.equal(rcloneCall.args[1], `${h.source}/.zfs/snapshot/${LABEL}`)
    }
    finally {
      await h.cleanup()
    }
  })

  it('destroys the transient even when rclone FAILS', async () => {
    const h = await zfsHarness()
    try {
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: ERROR_LINE, exitCode: 7 } })
      await assert.rejects(runCloudSync(h.mock, deps(h), () => {}), /exit 7/)
      const zfsArgs = h.mock.calls.filter(c => c.command === ZFS).map(c => c.args.join(' '))
      assert.ok(zfsArgs.includes(`destroy -r tank/pictures@${LABEL}`), 'the finally runs on a failure too')
    }
    finally {
      await h.cleanup()
    }
  })

  it('sweeps only THIS task\'s older cloud transients — never a backup task\'s', async () => {
    const h = await zfsHarness()
    try {
      const older = 'anas-cloud-offsite-1699999000'
      const otherTask = 'anas-cloud-archive-1699999000'
      const backupTransient = 'anas-backup-offsite-1699999000'
      h.mock.clearFixtures()
      h.mock.addFixture({
        command: FINDMNT,
        args: ['--json'],
        result: { stdout: findmntJson([{ target: h.source, source: 'tank/pictures', fstype: 'zfs' }]), stderr: '', exitCode: 0 },
      })
      h.mock.addFixture({
        command: ZFS,
        args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name', '-r', 'tank/pictures'],
        result: {
          stdout: [older, otherTask, backupTransient, 'anas-daily-2026-09-01T000000Z']
            .map(n => `tank/pictures@${n}`)
            .join('\n'),
          stderr: '',
          exitCode: 0,
        },
      })
      h.mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: FINAL_STATS, exitCode: 0 } })

      await runCloudSync(h.mock, deps(h), () => {})
      const destroys = h.mock.calls
        .filter(c => c.command === ZFS && c.args[0] === 'destroy')
        .map(c => c.args.at(-1))
      assert.deepEqual(destroys, [
        `tank/pictures@${older}`,
        `tank/pictures@${LABEL}`,
      ], 'the stale one of this task, then this run\'s own in the finally')
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('runCloudSync — the argv guard stays uniform', () => {
  it('refuses to run when a secret value would ride the command line', async () => {
    const h = await harness()
    try {
      await mkdir(h.source, { recursive: true })
      await writeFile(join(h.source, 'a.jpg'), 'x', 'utf-8')
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: FINAL_STATS, exitCode: 0 } })
      // Nothing secret is in scope in a real run (rclone reads every credential
      // from the config file) — this proves the backstop would still fire.
      await assert.rejects(
        runCloudSync(h.mock, deps(h, { task: task({ source: h.source, path: 'hunter2/pictures' }), secrets: ['hunter2'] }), () => {}),
        /a secret must never ride argv/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE))
    }
    finally {
      await h.cleanup()
    }
  })
})

/** The mock replays a fixture's stderr through `onStderr`, like a real child. */
describe('the executor tees stderr live (rclone.2)', () => {
  it('exec forwards each fixture\'s stderr to onStderr and still buffers it', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: '/bin/thing', result: { stdout: '', stderr: 'line one\n', exitCode: 0 } })
    const seen: string[] = []
    const opts: ExecOptions = { onStderr: chunk => seen.push(chunk) }
    const r: ExecResult = await mock.exec('/bin/thing', [], opts)
    assert.deepEqual(seen, ['line one\n'])
    assert.equal(r.stderr, 'line one\n')
  })
})
