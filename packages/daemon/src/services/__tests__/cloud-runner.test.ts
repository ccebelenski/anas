import type { CloudSyncTask } from '@anas/shared'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import type { JobCancellation, JobContext } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLOUD_STATS_INTERVAL_SECS, CloudSyncTask as CloudSyncTaskSchema, stalledFor } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { assertRunNotCancelled, ChildCancel } from '../../jobs/child-cancel.js'
import { JobCancelledError, JobQueue } from '../../jobs/queue.js'
import {
  buildRcloneArgs,
  CloudRunDetailTracker,
  emptySourceRefusal,
  errorLineOf,
  fileEventOf,
  missingSourceRefusal,
  RCLONE_LOG_ARGS,
  rcloneDestination,
  rcloneFailureMessage,
  RcloneLogReader,
  rcloneRunCompleted,
  readRcloneLog,
  RECENT_RING_CAP,
  runCloudSync,
  SPEED_RING_CAP,
  statsOf,
  statsProgressLine,
} from '../cloud-runner.js'
import { RCLONE } from '../rclone-config.js'

/**
 * The cloud sync RUN (rclone.2): the argv, rclone's JSON log, the exit-code
 * policy, the three guards and the transient-snapshot path.
 *
 * The PARSER tests read CAPTURED logs (fixtures/rclone/run-*.log, rclone
 * 1.60.1 on the stunt node, 2026-09-25 — see that directory's NOTES.md), never
 * hand-shaped lines. The `statsLine()` helper below stays for the run
 * MACHINERY (progress lines, exit codes, mock runs), where only the counters'
 * presence matters and no display fact rides on the exact bytes.
 */

const FINDMNT = '/usr/bin/findmnt'
const ZFS = '/usr/sbin/zfs'
const CONFIG = '/etc/anas/rclone.conf'
const NOW = new Date(1_700_000_000_000)
const LABEL = 'anas-cloud-offsite-1700000000'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone')

/** A captured log's JSON entries, in order (non-JSON lines are not entries). */
function logEntries(text: string): Record<string, unknown>[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

/**
 * The captured copy run: 4 files over a `--bwlimit 400k` loopback — one
 * `stats` object per 5s tick (4 mid-run with `transferring[]`, one final),
 * one `Copied (new)` event per file.
 */
const RUN_COPY_LOG = readFileSync(join(FIXTURES, 'run-copy-1.60.1.log'), 'utf-8')
const RUN_STATS = logEntries(RUN_COPY_LOG)
  .map(e => statsOf(e))
  .filter((s): s is NonNullable<typeof s> => s !== null)
const RUN_EVENTS = logEntries(RUN_COPY_LOG)
  .map(e => fileEventOf(e))
  .filter((e): e is NonNullable<typeof e> => e !== null)

/**
 * The captured failing run: an unreadable source subdirectory — JSON
 * `level: error` objects WITH an object (the file), and the "Attempt n/m
 * failed" retry summaries WITHOUT one.
 */
const RUN_ERROR_LOG = readFileSync(join(FIXTURES, 'run-error-objectless-1.60.1.log'), 'utf-8')
const RUN_ERROR_ENTRIES = logEntries(RUN_ERROR_LOG)
const OBJECTLESS_ERROR_LINE = JSON.stringify(
  RUN_ERROR_ENTRIES.find(e => typeof e.msg === 'string' && String(e.msg).startsWith('Attempt 1/2')),
)
const OBJECT_ERROR_LINE = JSON.stringify(
  RUN_ERROR_ENTRIES.find(e => e.object === 'locked'),
)

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

  it('pins the rclone.6 log flags: -v, one JSON event per file, and a 5s stats cadence', () => {
    assert.deepEqual(RCLONE_LOG_ARGS, [
      '--use-json-log',
      '-v',
      '--stats',
      '5s',
      '--stats-log-level',
      'NOTICE',
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
  it('reads the captured run: one stats object per tick, and the LAST one wins', () => {
    const log = readRcloneLog(RUN_COPY_LOG)
    // The final stats object of the captured copy: everything transferred.
    assert.deepEqual(log.stats, {
      bytes: 10000000,
      totalBytes: 10000000,
      transfers: 4,
      totalTransfers: 4,
      checks: 0,
      totalChecks: 0,
      deletes: 0,
      errors: 0,
      elapsedTime: 24.421977558,
      eta: 0,
      fatalError: false,
      speed: 413664.71814161836,
      transferring: [],
    })
  })

  it('the captured run carries 5 stats objects and 4 Copied events, nothing raw', () => {
    const log = readRcloneLog(RUN_COPY_LOG)
    const reader = new RcloneLogReader()
    assert.equal(reader.push(RUN_COPY_LOG).length, 5, 'every stats object is published, in order')
    reader.flush()
    assert.equal(log.errorLines.length, 0)
    assert.deepEqual(log.rawLines, [])
  })

  it('collects the captured error lines verbatim — named when rclone names one', () => {
    const log = readRcloneLog(RUN_ERROR_LOG)
    assert.deepEqual(log.errorLines, [
      'locked: failed to open directory "locked": open /tmp/anas-fixcap2-3189298/src/locked: permission denied',
      'ok/a.bin: Failed to copy: mkdir /tmp/anas-fixcap2-3189298/dst/ok: permission denied',
      'Attempt 1/2 failed with 2 errors and: mkdir /tmp/anas-fixcap2-3189298/dst/ok: permission denied',
      'locked: failed to open directory "locked": open /tmp/anas-fixcap2-3189298/src/locked: permission denied',
      'ok/a.bin: Failed to copy: mkdir /tmp/anas-fixcap2-3189298/dst/ok: permission denied',
      'Attempt 2/2 failed with 2 errors and: failed to open directory "locked": open /tmp/anas-fixcap2-3189298/src/locked: permission denied',
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
      totalTransfers: 0,
      checks: 0,
      totalChecks: 0,
      deletes: 0,
      errors: 0,
      elapsedTime: 0,
      eta: null,
      fatalError: false,
      speed: 0,
      transferring: [],
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

describe('cloud sync runner — the live run detail (rclone.6)', () => {
  it('parses the captured stats objects: counters, rclone\'s speed and the in-flight files', () => {
    assert.equal(RUN_STATS.length, 5)
    const first = RUN_STATS[0]
    assert.equal(first.bytes, 2179072)
    assert.equal(first.totalBytes, 10000000)
    assert.equal(first.elapsedTime, 5.00817145)
    assert.equal(first.transfers, 0)
    assert.equal(first.totalTransfers, 4)
    assert.equal(first.eta, 17)
    assert.equal(first.speed, 438275.31105320586, 'rclone\'s own EWMA speed is parsed verbatim')
    assert.deepEqual(first.transferring, [
      { name: 'f1.bin', size: 2500000, bytes: 552960, percentage: 22, speed: 110647.46923604007, eta: 17 },
      { name: 'f2.bin', size: 2500000, bytes: 552960, percentage: 22, speed: 110682.52675162704, eta: 17 },
      { name: 'f3.bin', size: 2500000, bytes: 552960, percentage: 22, speed: 110683.95064772702, eta: 17 },
      { name: 'f4.bin', size: 2500000, bytes: 520192, percentage: 20, speed: 104143.00252310744, eta: 18 },
    ])
  })

  it('maps the captured -v file events onto the viewer kinds', () => {
    // The capture: one "Copied (new)" per file, in completion order.
    assert.deepEqual(
      RUN_EVENTS.map(e => [e.name, e.kind]),
      [['f3.bin', 'copied'], ['f2.bin', 'copied'], ['f1.bin', 'copied'], ['f4.bin', 'copied']],
    )
    // rclone 1.60's real message shapes (review batch A, 2026-09-25): every
    // Copied shape is a `copied`; a modtime touch is NOT a file transfer.
    assert.deepEqual(fileEventOf({ level: 'info', msg: 'Copied (replaced existing)', object: 'f1.bin' }), { name: 'f1.bin', kind: 'copied' })
    assert.deepEqual(fileEventOf({ level: 'info', msg: 'Copied (server-side copy)', object: 'f2.bin' }), { name: 'f2.bin', kind: 'copied' })
    assert.deepEqual(fileEventOf({ level: 'info', msg: 'Multi-thread Copied (replaced existing)', object: 'f3.bin' }), { name: 'f3.bin', kind: 'copied' })
    assert.deepEqual(fileEventOf({ level: 'info', msg: 'Deleted', object: 'old.bin' }), { name: 'old.bin', kind: 'deleted' })
    assert.equal(fileEventOf({ level: 'info', msg: 'Updated modification time in destination', object: 'f4.bin' }), null)
    // `updated` stays in the schema for forward compatibility, but 1.60 never
    // produces a message that maps to it.
    assert.equal(fileEventOf({ level: 'info', msg: 'Updated', object: 'f2.bin' }), null)
  })

  it('an error-level event is BOTH an error line and a recent error', () => {
    const events: ReturnType<typeof fileEventOf>[] = []
    const reader = new RcloneLogReader()
    reader.onFileEvent = (e) => {
      events.push(e)
    }
    reader.push(`${OBJECT_ERROR_LINE}\n`)
    assert.equal(reader.errorLines.length, 1)
    assert.deepEqual(events, [{
      name: 'locked',
      kind: 'error',
      message: 'failed to open directory "locked": open /tmp/anas-fixcap2-3189298/src/locked: permission denied',
    }])
  })

  it('an error line with NO object still reaches recent and lastError (the retry summaries)', () => {
    const events: ReturnType<typeof fileEventOf>[] = []
    const reader = new RcloneLogReader()
    reader.onFileEvent = (e) => {
      events.push(e)
    }
    reader.push(`${OBJECTLESS_ERROR_LINE}\n`)
    const msg = (JSON.parse(OBJECTLESS_ERROR_LINE) as { msg: string }).msg
    assert.equal(reader.errorLines.length, 1, 'it is still an error line')
    assert.deepEqual(events, [{ name: '', kind: 'error', message: msg }])
    const tracker = new CloudRunDetailTracker()
    tracker.onEvent(events[0]!)
    const detail = tracker.detail()
    assert.equal(detail.lastError, msg, 'the message alone — there is no file to name')
    assert.deepEqual(detail.recent, [{ name: '', kind: 'error', at: detail.recent[0]!.at, message: msg }])
  })

  it('an info line that is not one of the viewer\'s messages is no event', () => {
    assert.equal(fileEventOf({ level: 'info', msg: 'Renamed', object: 'moved.bin' }), null)
    assert.equal(fileEventOf({ level: 'info', msg: 'Copied (new)', objectType: '*local.Object' }), null)
    assert.equal(fileEventOf({ level: 'notice', msg: 'Copied (new)', object: 'f9.bin' }), null)
  })

  it('the samples are DAEMON-derived byte deltas, and the detail reads them', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const base = RUN_STATS[0]
    // First tick: no previous stats object, so no sample at all.
    tracker.onStats({ ...base, bytes: 0, elapsedTime: 0, speed: 999999 })
    tracker.onStats({ ...base, bytes: 1000000, elapsedTime: 5, speed: 999999 })
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 10, speed: 999999 })
    // rclone's own `speed` above decays toward zero but never reaches it —
    // the samples must not care.
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 15, speed: 120000 })
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 20, speed: 45000 })
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 25, speed: 16000 })
    const detail = tracker.detail(Date.parse('2026-09-25T07:00:30.000Z'))
    assert.equal(detail.startedAt, '2026-09-25T07:00:00.000Z')
    assert.equal(detail.elapsedMs, 30000)
    assert.deepEqual(detail.speedSamples, [200000, 200000, 0, 0, 0], 'one byte-delta sample per tick after the first')
    assert.equal(detail.speed, 0, 'the latest sample — not rclone\'s decaying EWMA')
    // bytes stopped: the stalled rule (the shared one, over the shared
    // vectors) fires on three zero samples with files outstanding.
    assert.equal(stalledFor(detail), 15)
  })

  it('the detail eta comes from the last 12 samples, never from rclone', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const base = RUN_STATS[0]
    tracker.onStats({ ...base, bytes: 0, elapsedTime: 0, eta: 999 })
    tracker.onStats({ ...base, bytes: 1000000, elapsedTime: 5, eta: 999 })
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 10, eta: 999 })
    assert.equal(tracker.detail().eta, null, 'two samples is too few to answer')
    tracker.onStats({ ...base, bytes: 3000000, elapsedTime: 15, eta: 999 })
    const detail = tracker.detail()
    assert.equal(detail.eta, (10000000 - 3000000) / 200000, 'remaining bytes over the sample mean')
    // A LONG stall zeroes the whole 12-sample mean, and then there is no eta
    // to give — rclone's own eta (999 above) is never consulted instead.
    for (let i = 1; i <= 12; i++)
      tracker.onStats({ ...base, bytes: 3000000, elapsedTime: 15 + i * 5, eta: 999 })
    assert.equal(tracker.detail().eta, null)
  })

  it('the detail is the counters plus both rings, with an error naming lastError', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    tracker.onStats(RUN_STATS[0])
    tracker.onStats(RUN_STATS[1])
    tracker.onEvent({ name: 'f3.bin', kind: 'copied' }, '2026-09-25T07:00:06.000Z')
    tracker.onEvent({
      name: 'a.jpg',
      kind: 'error',
      message: 'Failed to copy: permission denied',
    }, '2026-09-25T07:00:07.000Z')
    const detail = tracker.detail(Date.parse('2026-09-25T07:00:10.000Z'))
    assert.equal(detail.startedAt, '2026-09-25T07:00:00.000Z')
    assert.equal(detail.elapsedMs, 10000)
    const sample = (RUN_STATS[1].bytes - RUN_STATS[0].bytes) / (RUN_STATS[1].elapsedTime - RUN_STATS[0].elapsedTime)
    assert.equal(detail.speed, sample)
    assert.equal(detail.eta, null, 'one sample only — no average yet')
    assert.equal(detail.bytes, RUN_STATS[1].bytes)
    assert.equal(detail.totalBytes, RUN_STATS[1].totalBytes)
    assert.equal(detail.totalTransfers, RUN_STATS[1].totalTransfers)
    assert.deepEqual(detail.speedSamples, [sample])
    assert.deepEqual(detail.transferring, RUN_STATS[1].transferring)
    assert.deepEqual(detail.recent, [
      { name: 'f3.bin', kind: 'copied', at: '2026-09-25T07:00:06.000Z' },
      { name: 'a.jpg', kind: 'error', at: '2026-09-25T07:00:07.000Z', message: 'Failed to copy: permission denied' },
    ])
    assert.equal(detail.lastError, 'a.jpg: Failed to copy: permission denied')
  })

  it('both rings are capped: 60 speed samples, 50 recent events, oldest dropped', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const base = RUN_STATS[0]
    for (let i = 0; i < SPEED_RING_CAP + 5; i++) {
      tracker.onStats({ ...base, bytes: (i + 1) * 1000, elapsedTime: (i + 1) * 5 })
      tracker.onEvent({ name: `f${i}.bin`, kind: 'copied' }, '2026-09-25T07:00:06.000Z')
    }
    const detail = tracker.detail()
    assert.equal(detail.speedSamples.length, SPEED_RING_CAP)
    assert.equal(detail.speedSamples[0], 200)
    assert.equal(detail.speedSamples.at(-1), 200)
    assert.equal(detail.recent.length, RECENT_RING_CAP)
    assert.equal(detail.recent[0].name, `f${SPEED_RING_CAP + 5 - RECENT_RING_CAP}.bin`)
  })

  it('a clean run has no lastError, and the detail is a snapshot, not live arrays', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const base = RUN_STATS[0]
    tracker.onStats({ ...base, bytes: 1000, elapsedTime: 5 })
    const first = tracker.detail()
    assert.equal(first.speed, 0, 'the first tick has no previous stats object to delta against')
    tracker.onStats({ ...base, bytes: 2000, elapsedTime: 10 })
    assert.equal(first.speed, 0, 'an older published detail does not change under a later tick')
    assert.equal(tracker.detail().speed, 200)
    assert.equal('lastError' in tracker.detail(), false)
  })

  it('the shared stalled rule answers the shared vectors from a tracker-built detail', () => {
    const vectors: { name: string, samples: number[], transfers?: number, totalTransfers?: number, transferring?: number, stalledSeconds: number | null }[]
      = JSON.parse(readFileSync(join(FIXTURES, '../../../../shared/test-vectors/stalled-samples.json'), 'utf-8'))
    const tracker = new CloudRunDetailTracker()
    const base = RUN_STATS[0]
    // Build a stalled detail the tracker's own way: growing bytes, then three
    // ticks where bytes stop.
    tracker.onStats({ ...base, bytes: 0, elapsedTime: 0 })
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 5 })
    tracker.onStats({ ...base, bytes: 4000000, elapsedTime: 10 })
    tracker.onStats({ ...base, bytes: 4000000, elapsedTime: 15 })
    tracker.onStats({ ...base, bytes: 4000000, elapsedTime: 20 })
    tracker.onStats({ ...base, bytes: 4000000, elapsedTime: 25 })
    const detail = tracker.detail()
    const expected = vectors.find(v => v.name === 'three zero samples with files remaining — stalled')
    assert.ok(expected)
    assert.equal(stalledFor(detail), expected.stalledSeconds)
  })

  // --- The silence watch (2026-09-26 ground truth: a FROZEN rclone emits no
  // stats objects at all, so the deltas alone never see it hang) ------------

  it('the silence watch runs at the stats cadence, and ticks with stats between them append nothing', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const fake = new FakeTimer()
    const published: import('@anas/shared').CloudRunDetail[] = []
    tracker.start(() => published.push(tracker.detail()), fake)
    assert.equal(fake.ms, CLOUD_STATS_INTERVAL_SECS * 1000, 'the watch ticks at the stats cadence, not its own')
    const base = RUN_STATS[0]
    tracker.onStats({ ...base, bytes: 0, elapsedTime: 0 }, new Date('2026-09-25T07:00:01.000Z'))
    fake.tick()
    tracker.onStats({ ...base, bytes: 1000000, elapsedTime: 5 }, new Date('2026-09-25T07:00:06.000Z'))
    fake.tick()
    tracker.onStats({ ...base, bytes: 2000000, elapsedTime: 10 }, new Date('2026-09-25T07:00:11.000Z'))
    fake.tick()
    const detail = tracker.detail()
    assert.deepEqual(detail.speedSamples, [200000, 200000], 'the derived samples only — no extra zeros')
    assert.equal(detail.speed, 200000)
    assert.equal(published.length, 0, 'a heard tick publishes nothing — the stats object already did')
  })

  it('a 20 s silence after the last stats object appends three zero samples and reads stalled', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const fake = new FakeTimer()
    tracker.start(undefined, fake)
    const base = RUN_STATS[0]
    tracker.onStats({ ...base, bytes: 1000000, elapsedTime: 5 }, new Date('2026-09-25T07:00:05.000Z'))
    fake.tick() // the interval the stats object arrived in — heard, nothing appended
    fake.tick() // 10 s of silence
    fake.tick() // 15 s
    fake.tick() // 20 s
    const detail = tracker.detail()
    assert.deepEqual(detail.speedSamples, [0, 0, 0], 'one zero sample per silent interval')
    assert.equal(detail.speed, 0, 'the silence reads as zero throughput, not the last number forever')
    assert.equal(detail.bytes, 1000000, 'the counters stand as the stats object left them')
    assert.equal(detail.transferring.length, base.transferring.length, 'so does the in-flight set')
    assert.equal(detail.lastStatsAt, '2026-09-25T07:00:05.000Z', 'a silent tick does not touch lastStatsAt')
    assert.equal(stalledFor(detail), 15, 'three silent intervals fire the same stalled rule')
  })

  it('a stats object arriving 2 s after a tick yields one sample for that interval, not two', () => {
    const tracker = new CloudRunDetailTracker(new Date('2026-09-25T07:00:00.000Z'))
    const fake = new FakeTimer()
    tracker.start(undefined, fake)
    const base = RUN_STATS[0]
    tracker.onStats({ ...base, bytes: 0, elapsedTime: 0 }, new Date('2026-09-25T07:00:00.000Z'))
    fake.tick() // heard — the tick appends nothing
    tracker.onStats({ ...base, bytes: 1000000, elapsedTime: 7 }, new Date('2026-09-25T07:00:07.000Z'))
    fake.tick() // heard again — the stats object's own sample covers the interval
    const detail = tracker.detail()
    assert.equal(detail.speedSamples.length, 1, 'one sample for one interval of time')
    assert.equal(detail.speedSamples[0], 1000000 / 7)
  })

  it('lastStatsAt rides the detail: absent before the first stats object, the last one after', () => {
    const tracker = new CloudRunDetailTracker()
    assert.equal('lastStatsAt' in tracker.detail(), false, 'nothing has arrived yet')
    tracker.onStats({ ...RUN_STATS[0] }, new Date('2026-09-25T07:00:01.000Z'))
    tracker.onStats({ ...RUN_STATS[1] }, new Date('2026-09-25T07:00:06.000Z'))
    assert.equal(tracker.detail().lastStatsAt, '2026-09-25T07:00:06.000Z')
  })

  it('stop() ends the watch: a tick after it neither publishes nor appends', () => {
    const tracker = new CloudRunDetailTracker()
    const fake = new FakeTimer()
    const published: import('@anas/shared').CloudRunDetail[] = []
    tracker.start(() => published.push(tracker.detail()), fake)
    tracker.onStats({ ...RUN_STATS[0], bytes: 0, elapsedTime: 0 })
    tracker.stop()
    assert.ok(fake.cleared, 'clearInterval was called')
    fake.tick()
    assert.equal(published.length, 0, 'no publish after the run ended')
    assert.deepEqual(tracker.detail().speedSamples, [], 'no sample after the run ended either')
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

  it('publishes the live run detail per STATS tick — file events only fill the rings (rclone.6, batch A)', async () => {
    const h = await liveHarness()
    try {
      // The whole captured copy run — 5 stats objects and 4 Copied events —
      // replays through the tee like a real child's stderr.
      h.mock.addFixture({
        command: RCLONE,
        result: { stdout: '', stderr: RUN_COPY_LOG, exitCode: 0 },
      })
      const details: import('@anas/shared').CloudRunDetail[] = []
      const result = await runCloudSync(h.mock, deps(h, { onDetail: d => details.push(d) }), () => {})
      assert.equal(result.status, 'success')
      assert.equal(result.bytes, 10000000)
      // One publication per stats object ONLY — the 4 file events updated the
      // rings and the next tick carried them out, so a many-small-files run
      // builds no detail snapshot per file.
      assert.equal(details.length, 5, `a detail per stats tick, got ${details.length}`)
      // The first tick carries no sample (nothing to delta against). The
      // rings DO carry the Copied events here: the mock delivers the whole
      // log as ONE chunk, and the reader fires file events as their lines
      // complete — before the stats callbacks run. A live run's chunks
      // interleave; this replay just publishes the events early.
      assert.deepEqual(details[0].speedSamples, [])
      assert.deepEqual(
        details[0].recent.map(e => [e.name, e.kind]),
        [['f3.bin', 'copied'], ['f2.bin', 'copied'], ['f1.bin', 'copied'], ['f4.bin', 'copied']],
      )
      // The last detail is the run's final state, over the captured bytes.
      const last = details.at(-1)!
      assert.equal(last.bytes, 10000000)
      assert.equal(last.transfers, 4)
      assert.equal(last.speedSamples.length, 4)
      assert.ok(last.speedSamples.every(s => s > 0), 'every captured interval moved bytes')
      assert.equal(last.speed, last.speedSamples.at(-1)!)
      assert.equal(last.eta, 0, 'everything transferred — no seconds remaining')
      assert.deepEqual(
        last.recent.map(e => [e.name, e.kind]),
        [['f3.bin', 'copied'], ['f2.bin', 'copied'], ['f1.bin', 'copied'], ['f4.bin', 'copied']],
      )
    }
    finally {
      await h.cleanup()
    }
  })

  it('a silent interval during the run publishes a zeroed detail, and the watch dies with the run', async () => {
    const h = await liveHarness()
    try {
      // A live child that never finishes on its own — the hung-rclone shape.
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${statsLine()}\n`, exitCode: 0 }, live: {} })
      const fake = new FakeTimer()
      const details: import('@anas/shared').CloudRunDetail[] = []
      const run = runCloudSync(h.mock, deps(h, { onDetail: d => details.push(d), timer: fake }), () => {})
      for (let i = 0; i < 200 && !h.mock.calls.some(c => c.command === RCLONE); i++)
        await new Promise(r => setTimeout(r, 5))
      assert.equal(details.length, 1, 'the stats object the child printed at spawn published one detail')

      fake.tick() // the interval the stats object arrived in — heard
      fake.tick() // 10 s: rclone has said nothing
      fake.tick() // 15 s
      fake.tick() // 20 s
      assert.equal(details.length, 4, 'one publication per silent tick')
      const stalled = details.at(-1)!
      assert.deepEqual(stalled.speedSamples, [0, 0, 0], 'the silent intervals read as zero samples')
      assert.equal(stalled.speed, 0)
      assert.equal(stalledFor(stalled), 15, 'the viewer\'s stalled rule fires off the silence too')
      assert.ok(!Number.isNaN(Date.parse(stalled.lastStatsAt ?? '')), 'lastStatsAt rides the live detail')

      h.mock.finishLive({ stdout: '', stderr: '', exitCode: 0 })
      const result = await run
      assert.equal(result.status, 'success')
      assert.ok(fake.cleared, 'the watch was cleared when the run ended')
      const after = details.length
      fake.tick()
      assert.equal(details.length, after, 'no tick publishes anything after the exit')
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

  it('rclone.5: a CANCEL stops rclone with SIGINT, the job ends `cancelled`, and the transient is STILL destroyed', async () => {
    const h = await zfsHarness()
    try {
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: `${statsLine()}\n`, exitCode: 0 }, live: {} })
      const queue = new JobQueue()
      const ref = queue.submit('cloud.task.run', { user: 'root@pam', uid: 0, params: { task: 'offsite', direct: true } }, async (progress, ctx) => {
        const cancel = new ChildCancel(ctx, 'rclone', { subject: 'Cloud sync task \'offsite\'' }, { waitMs: 50 })
        return runCloudSync(h.mock, deps(h, { onSpawn: cancel.onSpawn }), progress)
      })
      for (let i = 0; i < 200 && !h.mock.calls.some(c => c.command === RCLONE); i++)
        await new Promise(r => setTimeout(r, 5))
      assert.match(queue.get(ref.id)?.progress ?? '', /1048576 of 4194304 bytes/, 'progress from the live stats')

      await queue.cancel(ref.id, 'alice@pve')
      for (let i = 0; i < 200 && queue.get(ref.id)?.status === 'running'; i++)
        await new Promise(r => setTimeout(r, 5))

      assert.deepEqual(h.mock.signals.map(s => s.signal), ['SIGINT'])
      const job = queue.get(ref.id)!
      assert.equal(job.status, 'cancelled')
      assert.match((job.result as { reason: string }).reason, /^cancelled by alice@pve at /)
      const zfsArgs = h.mock.calls.filter(c => c.command === ZFS).map(c => c.args.join(' '))
      assert.ok(zfsArgs.includes(`destroy -r tank/pictures@${LABEL}`), 'the finally runs on a cancel too')
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

/** A live-tree harness: a real source directory with one file in it. */
async function liveHarness(): Promise<Harness> {
  const h = await harness()
  await mkdir(h.source, { recursive: true })
  await writeFile(join(h.source, 'a.jpg'), 'x', 'utf-8')
  return h
}

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

  it('a fixture with teeStderr:false holds the stderr back — the no-tee executor shape', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/bin/thing',
      teeStderr: false,
      result: { stdout: '', stderr: 'line one\n', exitCode: 0 },
    })
    const seen: string[] = []
    const r: ExecResult = await mock.exec('/bin/thing', [], { onStderr: c => seen.push(c) })
    assert.deepEqual(seen, [], 'nothing reached the live sink')
    assert.equal(r.stderr, 'line one\n', 'the buffer still has it — that is what the fallback re-reads')
  })
})

// ---------------------------------------------------------------------------
//  Fix-batch pins (rclone.2 slice 2 review, 2026-09-24)
// ---------------------------------------------------------------------------

/** A MockExecutor that remembers the options the last exec was handed. */
class OptsRecorder extends MockExecutor {
  lastExecOpts?: ExecOptions
  override exec(command: string, args: string[], opts?: ExecOptions) {
    this.lastExecOpts = opts
    return super.exec(command, args, opts)
  }
}

/**
 * The silence watch's timer, hand-fired — a CloudRunDetailTimer whose tick()
 * stands in for the wall clock, so the tests never wait out real 5 s rounds.
 */
class FakeTimer {
  fn: (() => void) | null = null
  ms = 0
  cleared = false
  setInterval(fn: () => void, ms: number): unknown {
    this.fn = fn
    this.ms = ms
    return this
  }

  clearInterval(id: unknown): void {
    if (id === this)
      this.cleared = true
  }

  tick(): void {
    this.fn?.()
  }
}

describe('execRclone — executor options (fix batch)', () => {
  it('asks for a generous maxBuffer: a 15-day stats log is ~17 MB, the 10 MiB default would kill the run', async () => {
    const h = await harness()
    try {
      await mkdir(h.source, { recursive: true })
      const mock = new OptsRecorder()
      mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: findmntJson(), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: FINAL_STATS, exitCode: 0 } })
      await runCloudSync(mock, deps(h), () => {})
      assert.equal(mock.lastExecOpts?.maxBuffer, 256 * 1024 * 1024)
    }
    finally {
      await h.cleanup()
    }
  })

  it('a run rclone printed NO stats object for carries countersReported:false', async () => {
    const h = await liveHarness()
    try {
      // rclone prints its first stats object at the first --stats interval; a
      // sub-second run prints none and its counters would read as silent zeros.
      h.mock.addFixture({ command: RCLONE, result: { stdout: '', stderr: '', exitCode: 0 } })
      const result = await runCloudSync(h.mock, deps(h), m => h.progress.push(m))
      assert.equal(result.status, 'success')
      assert.equal(result.countersReported, false)
      assert.equal(result.bytes, 0)
      assert.deepEqual(
        h.progress.filter(p => p.startsWith('copy: ')),
        [],
        'no stats progress was published — rclone printed nothing',
      )
    }
    finally {
      await h.cleanup()
    }
  })

  it('an executor that buffers WITHOUT teeing still yields the counters (the re-read fallback)', async () => {
    const h = await liveHarness()
    try {
      h.mock.addFixture({
        command: RCLONE,
        teeStderr: false,
        result: { stdout: '', stderr: [statsLine(), FINAL_STATS].join('\n'), exitCode: 0 },
      })
      const result = await runCloudSync(h.mock, deps(h), m => h.progress.push(m))
      assert.equal(result.status, 'success')
      assert.equal(result.bytes, 4194304, 'the counters came from re-reading r.stderr')
      assert.equal(result.countersReported, true)
      assert.deepEqual(h.progress.filter(p => p.startsWith('copy: ')), [], 'no live progress — the tee never fired')
    }
    finally {
      await h.cleanup()
    }
  })
})

/**
 * rclone.5 review — an accepted cancel ends the run at the NEXT pre-flight
 * boundary, with `checkCancel` wired exactly as the route wires it
 * (`assertRunNotCancelled` over the job's `ChildCancel`).
 */
describe('runCloudSync — an accepted cancel ends the pre-flight (rclone.5 review)', () => {
  /** A minimal JobContext with a settable cancellation. */
  function fakeCtx(): { ctx: JobContext, set: (c: JobCancellation | null) => void } {
    let cancellation: JobCancellation | null = null
    return {
      ctx: { onCancel: () => {}, cancellation: () => cancellation, updateDetail: () => {} },
      set: (c) => {
        cancellation = c
      },
    }
  }

  it('a cancel accepted before the run ends it at the FIRST boundary — not even the guard runs', async () => {
    const h = await harness()
    try {
      const f = fakeCtx()
      const cancel = new ChildCancel(f.ctx, 'rclone', {}, { waitMs: 20 })
      f.set({ user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' })
      await assert.rejects(
        runCloudSync(h.mock, deps(h, { checkCancel: next => assertRunNotCancelled(cancel, next) }), () => {}),
        JobCancelledError,
      )
      assert.equal(h.mock.calls.length, 0, 'nothing executed — the guard included')
    }
    finally {
      await h.cleanup()
    }
  })

  it('a cancel accepted after the guard ends it before the snapshot and the exec', async () => {
    const h = await harness()
    try {
      await mkdir(h.source, { recursive: true })
      await writeFile(join(h.source, 'a.jpg'), 'x', 'utf-8')
      const f = fakeCtx()
      const cancel = new ChildCancel(f.ctx, 'rclone', {}, { waitMs: 20 })
      const boundaries: string[] = []
      await assert.rejects(
        runCloudSync(h.mock, deps(h, {
          checkCancel: (next) => {
            boundaries.push(next)
            if (next === 'the transient snapshot')
              f.set({ user: 'alice@pve', at: '2026-09-25T14:02:11.000Z' }) // the cancel lands between the guard and the snapshot
            assertRunNotCancelled(cancel, next)
          },
        }), () => {}),
        JobCancelledError,
      )
      assert.deepEqual(boundaries, ['the source guard', 'the transient snapshot'], 'the exec boundary is never reached')
      assert.ok(!h.mock.calls.some(c => c.command === RCLONE), 'rclone never ran')
      assert.ok(
        !h.mock.calls.some(c => c.command === ZFS && c.args[0] === 'snapshot'),
        'no snapshot was taken',
      )
    }
    finally {
      await h.cleanup()
    }
  })
})
