import type { CloudSyncTask } from '@anas/shared'
import type { CloudPreviewDeps } from '../cloud-preview.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  DELETED_FILES_CAP,
  PREVIEW_TIMEOUT_S,
  previewCloudSync,
  TIMEOUT_EXIT_CODE,
} from '../cloud-preview.js'
import { RCLONE_LOG_ARGS, RcloneLogReader } from '../cloud-runner.js'
import { RCLONE } from '../rclone-config.js'

/**
 * The dry-run PREVIEW (rclone.2 addendum): the parser over the CAPTURED
 * 1.60.1 `--dry-run` logs (stunt node, sftp to the node's own sshd), the
 * delete-name cap, the 120 s ceiling, the argv (one builder, `--dry-run`,
 * the secret backstop, no snapshot) and the guards (the unmounted mount
 * refuses, the empty source does NOT — that is what the preview is for).
 *
 * The fixtures are rclone's own stderr, verbatim — the parser is built from
 * these lines, never from memory:
 *   sync-fresh   empty destination — three `skipped: copy` objects and a
 *                final stats object (transfers 3, checks 0)
 *   sync-delete  a file deleted at the source after a real sync — one
 *                `skipped: delete` object (b.bin) and a final stats object
 *                (checks 3, deletes 1, transfers 0)
 *   copy         a complete destination — NOTHING to do, and rclone still
 *                prints its final stats object (checks 2, transfers 0)
 */

const FINDMNT = '/usr/bin/findmnt'
const TIMEOUT = '/usr/bin/timeout'
const ZFS = '/usr/sbin/zfs'
const CONFIG = '/etc/anas/rclone.conf'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone')

function task(over: Partial<CloudSyncTask> = {}): CloudSyncTask {
  return CloudSyncTaskSchema.parse({
    name: 'offsite',
    source: '/tank/pictures',
    remote: 'gt',
    path: 'dst/preview',
    schedule: 'Tue *-*-* 02:00:00',
    ...over,
  })
}

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
  cleanup: () => Promise<void>
}

async function harness(opts: { findmnt?: string, fstab?: string, source?: 'dir' | 'file' | 'empty' | 'absent' } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-cloudpreview-'))
  const source = join(dir, 'source')
  switch (opts.source ?? 'dir') {
    case 'dir':
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'a.bin'), 'x', 'utf-8')
      break
    case 'empty':
      await mkdir(source, { recursive: true })
      break
    case 'file':
      await writeFile(source, 'not a directory', 'utf-8')
      break
    case 'absent':
      break
  }
  const fstab = join(dir, 'fstab')
  await writeFile(fstab, opts.fstab ?? 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
  const mock = new MockExecutor()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: opts.findmnt ?? findmntJson(), stderr: '', exitCode: 0 } })
  return {
    dir,
    source,
    fstab,
    mock,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function deps(h: Harness, over: Partial<CloudPreviewDeps> = {}) {
  return {
    task: task({ source: h.source }),
    paths: { configFile: CONFIG },
    fstabPath: h.fstab,
    ...over,
  }
}

/** Replays a log through the mock executor the way a real child's stderr would. */
function replayRclone(mock: MockExecutor, stderr: string, exitCode = 0, over: { teeStderr?: boolean } = {}): void {
  mock.addFixture({
    command: TIMEOUT,
    result: { stdout: '', stderr, exitCode },
    ...(over.teeStderr !== undefined ? { teeStderr: over.teeStderr } : {}),
  })
}

async function fixtureText(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), 'utf-8')
}

/**
 * The CAPTURED stderr of a dry run against a wrong-password remote. The
 * integration spec (`cloud-tasks-api.spec.ts`, the wrong-password test) is
 * where it comes from: the job that first runs that spec saves rclone's own
 * stderr here VERBATIM. Until then the test below uses the hand-written shape
 * and says so in its own name — the fixture is still owed, and a test name
 * that claims ground truth it does not have is worse than no fixture.
 */
const AUTH_FAIL_FIXTURE = 'dry-run-auth-fail-1.60.1.log'
const AUTH_FAIL_CAPTURED = existsSync(join(FIXTURES, AUTH_FAIL_FIXTURE))

/** rclone's auth-failure stderr: the capture when it exists, else the shape. */
async function authFailLog(): Promise<string> {
  if (AUTH_FAIL_CAPTURED)
    return fixtureText(AUTH_FAIL_FIXTURE)
  return JSON.stringify({
    level: 'error',
    msg: 'Failed to create file system for "gtbad:dst/fail": NewFs: couldn\'t connect SSH: ssh: handshake failed: ssh: unable to authenticate',
    source: 'fs/config.go:123',
    time: '2026-09-24T22:00:00.000000+00:00',
  })
}

// ---------------------------------------------------------------------------
//  The reader: the `skipped: delete` collection
// ---------------------------------------------------------------------------

describe('RcloneLogReader — the would-be deletes (rclone.2 addendum)', () => {
  it('collects the `object` of every `skipped: delete` line, in order — and not the `skipped: copy` ones', async () => {
    const fresh = await fixtureText('dry-run-sync-fresh-1.60.1.log')
    const reader = new RcloneLogReader()
    reader.push(fresh)
    reader.flush()
    assert.deepEqual(reader.skippedDeletes, [], 'three would-be COPIES are not deletes')
    assert.ok(reader.stats, 'the final stats object was read too')

    const del = await fixtureText('dry-run-sync-delete-1.60.1.log')
    const both = new RcloneLogReader()
    both.push(`${fresh}${del}`)
    both.flush()
    assert.deepEqual(both.skippedDeletes, ['b.bin'], 'exactly the one would-be delete, named')
  })

  it('stops collecting NAMES at the cap while the COUNT keeps going — the reader never grows with the destination', () => {
    const reader = new RcloneLogReader()
    reader.push(Array.from({ length: 250 }, (_, i) => JSON.stringify({
      level: 'warning',
      msg: 'Skipped delete as --dry-run is set (size 34)',
      object: `gone/file-${String(i).padStart(3, '0')}.txt`,
      objectType: '*sftp.Object',
      size: 34,
      skipped: 'delete',
      source: 'operations/operations.go:2404',
      time: '2026-09-24T22:08:07.000000+00:00',
    })).join('\n'))
    reader.flush()
    // The READER's own array, not the answer's slice: an uncapped reader fed
    // by a live child's stderr would hold one string per would-be delete.
    assert.equal(reader.skippedDeletes.length, DELETED_FILES_CAP, 'the reader itself stopped at 200')
    assert.equal(reader.skippedDeleteCount, 250, 'and counted every one of them')
    assert.equal(reader.skippedDeletes.at(-1), 'gone/file-199.txt', 'the FIRST 200, in rclone\'s order')
    assert.equal(reader.state().skippedDeleteCount, 250, 'the count survives into the state')
  })

  it('a `skipped: delete` line without an `object` (or a blank one) is not collected', () => {
    const reader = new RcloneLogReader()
    reader.push([
      JSON.stringify({ level: 'warning', msg: 'Skipped delete as --dry-run is set', skipped: 'delete' }),
      JSON.stringify({ level: 'warning', msg: 'Skipped delete as --dry-run is set', object: '  ', skipped: 'delete' }),
      JSON.stringify({ level: 'warning', msg: 'Skipped delete as --dry-run is set', object: 'x.bin', skipped: 'delete' }),
    ].join('\n'))
    reader.flush()
    assert.deepEqual(reader.skippedDeletes, ['x.bin'])
  })
})

// ---------------------------------------------------------------------------
//  previewCloudSync — the parser over the captured fixtures
// ---------------------------------------------------------------------------

describe('previewCloudSync — the captured 1.60.1 dry-run logs', () => {
  it('sync against an empty destination: the would-be copies are rclone\'s counters', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-sync-fresh-1.60.1.log'))
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.deepEqual(
        { transfers: result.transfers, bytes: result.bytes, checks: result.checks, deletes: result.deletes },
        { transfers: 3, bytes: 358434, checks: 0, deletes: 0 },
        'rclone\'s own final stats object, verbatim',
      )
      assert.deepEqual(result.deletedFiles, [])
      assert.equal(result.deletedTotal, 0)
      assert.deepEqual(result.errors, [])
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })

  it('sync after a source deletion: the deleted file is listed and counted', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-sync-delete-1.60.1.log'))
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.equal(result.deletes, 1)
      assert.deepEqual(result.deletedFiles, ['b.bin'], 'the would-be delete, by name')
      assert.equal(result.deletedTotal, 1)
      assert.deepEqual({ transfers: result.transfers, bytes: result.bytes, checks: result.checks }, { transfers: 0, bytes: 0, checks: 3 })
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })

  it('copy against a complete destination: nothing to do, and rclone still says so', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-copy-1.60.1.log'))
      const result = await previewCloudSync(h.mock, deps(h))
      assert.deepEqual(
        { transfers: result.transfers, bytes: result.bytes, checks: result.checks, deletes: result.deletes },
        { transfers: 0, bytes: 0, checks: 2, deletes: 0 },
      )
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })

  it('a log whose only objects are `skipped` lines still reports them through an executor that does not tee', async () => {
    const h = await harness()
    try {
      // No-tee shape: the whole log arrives only in `stderr`, and the re-read
      // fallback must collect the would-be deletes, not just stats/errors.
      replayRclone(h.mock, await fixtureText('dry-run-sync-delete-1.60.1.log'), 0, { teeStderr: false })
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.equal(result.deletes, 1)
      assert.deepEqual(result.deletedFiles, ['b.bin'])
    }
    finally {
      await h.cleanup()
    }
  })

  it(`a preview that fails at rclone answers with rclone's error lines, not a throw (${AUTH_FAIL_CAPTURED ? `captured ${AUTH_FAIL_FIXTURE}` : 'hand-written shape — the 1.60.1 capture is still owed'})`, async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await authFailLog(), 1)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.equal(result.transfers, 0, 'no stats object was printed — the counters are zeros')
      assert.ok(result.errors.length >= 1, 'rclone\'s own error line came back')
      assert.match(result.errors.join('\n'), /couldn't connect SSH|didn't find section in config file|NewFs/)
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
//  The exit code: a failure that logged NOTHING must not read as "nothing to do"
// ---------------------------------------------------------------------------

describe('previewCloudSync — a non-JSON failure carries the run\'s own sentence', () => {
  it('exit 1 with EMPTY output: zero counters AND the failure sentence, never a silent all-clear', async () => {
    const h = await harness()
    try {
      // A signal death, or a child that never reached its JSON logger: no
      // stats object, no error line, nothing on stderr at all. Without the
      // sentence this answer is byte-identical to an honest "nothing to do".
      replayRclone(h.mock, '', 1)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.deepEqual(
        { transfers: result.transfers, bytes: result.bytes, checks: result.checks, deletes: result.deletes },
        { transfers: 0, bytes: 0, checks: 0, deletes: 0 },
        'rclone reported nothing, so the counters stay zero',
      )
      assert.equal(result.errors.length, 1, 'and the answer says the run FAILED')
      assert.equal(result.errors[0], 'rclone copy failed (exit 1)')
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })

  it('exit 1 with a RAW non-JSON line (a panic, a pre-logger message): the line rides the sentence', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, 'panic: runtime error: invalid memory address or nil pointer dereference\n', 1)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0]!, /^rclone copy failed \(exit 1\): /)
      assert.match(result.errors[0]!, /panic: runtime error/, 'rclone\'s own last line, verbatim')
    }
    finally {
      await h.cleanup()
    }
  })

  it('`timeout` failing to start the child (127) is a failure too, not an empty look', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, '/usr/bin/timeout: failed to run command \'/usr/bin/rclone\': No such file or directory\n', 127)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0]!, /exit 127/)
      assert.match(result.errors[0]!, /failed to run command/)
    }
    finally {
      await h.cleanup()
    }
  })

  it('exit 9 ("nothing to transfer") is a COMPLETION: no errors invented', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-copy-1.60.1.log'), 9)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.deepEqual(result.errors, [], 'rclone\'s other success code')
      assert.equal(result.checks, 2, 'and the counters are still rclone\'s')
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })

  it('exit 124 is the CEILING, not a failure: truncated, with no invented error', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, '', TIMEOUT_EXIT_CODE)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.equal(result.truncated, true)
      assert.deepEqual(result.errors, [], 'the wall ceiling is reported by `truncated`, never as an error')
    }
    finally {
      await h.cleanup()
    }
  })

  it('an error line rclone DID log wins over the sentence — its own words, not ours', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await authFailLog(), 1)
      const result = await previewCloudSync(h.mock, deps(h))
      assert.ok(!result.errors.some(e => e.startsWith('rclone copy failed')), 'no wrapper sentence when rclone spoke for itself')
    }
    finally {
      await h.cleanup()
    }
  })
})

describe('previewCloudSync — the wall ceiling and the delete cap', () => {
  it('the timeout wrapper firing is `truncated: true` with what was parsed so far — never an error', async () => {
    const h = await harness()
    try {
      // A stalled remote: rclone logged one would-be delete and was killed
      // before its final stats object.
      const partial = JSON.stringify({
        level: 'warning',
        msg: 'Skipped delete as --dry-run is set (size 150Ki)',
        object: 'b.bin',
        objectType: '*sftp.Object',
        size: 153600,
        skipped: 'delete',
        source: 'operations/operations.go:2404',
        time: '2026-09-24T22:08:07.000000+00:00',
      })
      replayRclone(h.mock, partial, TIMEOUT_EXIT_CODE)
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.equal(result.truncated, true)
      assert.deepEqual(result.deletedFiles, ['b.bin'], 'what rclone had logged by then')
      assert.equal(result.deletedTotal, 1)
      assert.deepEqual({ transfers: result.transfers, bytes: result.bytes, checks: result.checks, deletes: result.deletes }, { transfers: 0, bytes: 0, checks: 0, deletes: 0 })
      assert.deepEqual(result.errors, [])
    }
    finally {
      await h.cleanup()
    }
  })

  it('a clean exit is not truncated', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-sync-delete-1.60.1.log'), 0)
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.equal(result.truncated, false)
    }
    finally {
      await h.cleanup()
    }
  })

  it('deletedFiles is capped at 200 names; deletedTotal is the whole count', async () => {
    const h = await harness()
    try {
      assert.equal(DELETED_FILES_CAP, 200, 'the cap the schema documents')
      const lines = Array.from({ length: 250 }, (_, i) => JSON.stringify({
        level: 'warning',
        msg: `Skipped delete as --dry-run is set (size 34)`,
        object: `gone/file-${String(i).padStart(3, '0')}.txt`,
        objectType: '*sftp.Object',
        size: 34,
        skipped: 'delete',
        source: 'operations/operations.go:2404',
        time: '2026-09-24T22:08:07.000000+00:00',
      }))
      // A final stats object agreeing with the 250 deletes it would have made.
      lines.push(JSON.stringify({
        level: 'warning',
        msg: '\nDeleted:                250 (files), 0 (dirs)\n',
        source: 'accounting/stats.go:482',
        stats: { bytes: 0, checks: 250, deletedDirs: 0, deletes: 250, elapsedTime: 1.2, errors: 0, eta: null, fatalError: false, renames: 0, retryError: false, speed: 0, totalBytes: 0, totalChecks: 250, totalTransfers: 0, transferTime: 0, transfers: 0 },
        time: '2026-09-24T22:08:08.000000+00:00',
      }))
      replayRclone(h.mock, lines.join('\n'))
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.equal(result.deletedFiles.length, 200, 'the cap on the LIST')
      assert.deepEqual(result.deletedFiles.slice(0, 2), ['gone/file-000.txt', 'gone/file-001.txt'], 'the FIRST 200, in rclone\'s order')
      assert.equal(result.deletedTotal, 250, 'the count is never capped')
      assert.equal(result.deletes, 250, 'and it is rclone\'s own counter')
    }
    finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
//  The argv: one builder, --dry-run, the backstop, no snapshot
// ---------------------------------------------------------------------------

describe('previewCloudSync — the argv', () => {
  it('is the run\'s own argv plus --dry-run, wrapped in `timeout 120`', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-sync-fresh-1.60.1.log'))
      await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync', bwlimit: '8M', excludes: ['*.tmp'] }) }))

      const call = h.mock.calls.find(c => c.command === TIMEOUT)
      assert.ok(call, 'the preview runs through the timeout wrapper')
      assert.deepEqual(call!.args, [
        String(PREVIEW_TIMEOUT_S),
        RCLONE,
        'sync',
        h.source,
        'gt:dst/preview',
        '--config',
        CONFIG,
        '--ask-password=false',
        ...RCLONE_LOG_ARGS,
        '--bwlimit',
        '8M',
        '--exclude',
        '*.tmp',
        '--dry-run',
      ])
    }
    finally {
      await h.cleanup()
    }
  })

  it('takes no snapshot and touches nothing but the mount-table read and the dry run', async () => {
    const h = await harness({
      findmnt: findmntJson([{ target: '/tank', source: 'tank/pictures', fstype: 'zfs' }]),
    })
    try {
      // The source sits on a MOUNTED zfs dataset — a RUN would snapshot it.
      // The preview must not: it looks at the live tree.
      replayRclone(h.mock, await fixtureText('dry-run-sync-fresh-1.60.1.log'))
      await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))

      const rcloneSource = h.mock.calls.find(c => c.command === TIMEOUT)!.args
      assert.equal(rcloneSource[3], h.source, 'rclone is pointed at the LIVE tree, not a snapshot path')
      assert.ok(!h.mock.calls.some(c => c.command === ZFS), 'no zfs call at all — no snapshot, no sweep')
    }
    finally {
      await h.cleanup()
    }
  })

  it('the secret-argv backstop still fires before the dry run is issued', async () => {
    const h = await harness()
    try {
      replayRclone(h.mock, await fixtureText('dry-run-sync-fresh-1.60.1.log'))
      await assert.rejects(
        previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, path: 'hunter2/preview' }), secrets: ['hunter2'] })),
        /a secret must never ride argv/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT), 'rclone is never reached')
    }
    finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
//  The guards
// ---------------------------------------------------------------------------

describe('previewCloudSync — the guards', () => {
  it('refuses a source on a configured-but-unmounted mount, with the run\'s sentence naming it', async () => {
    const h = await harness({
      fstab: 'UUID=deadbeef / ext4 defaults 0 1\n//nas/pictures /mnt/pictures cifs nofail 0 0\n',
    })
    try {
      await assert.rejects(
        previewCloudSync(h.mock, deps(h, { task: task({ source: '/mnt/pictures/2026' }) })),
        // The source is UNDER the mountpoint, so the sentence names both:
        // the path and the mount it sits on.
        /\/mnt\/pictures\/2026 is under \/mnt\/pictures, which is a mount defined in \/etc\/fstab but not mounted right now/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT), 'rclone is never reached')
    }
    finally {
      await h.cleanup()
    }
  })

  it('refuses a source that does not exist, with the run\'s sentence', async () => {
    const h = await harness({ source: 'absent' })
    try {
      await assert.rejects(
        previewCloudSync(h.mock, deps(h)),
        /does not exist or is not a directory/,
      )
      assert.ok(!h.mock.calls.some(c => c.command === TIMEOUT))
    }
    finally {
      await h.cleanup()
    }
  })

  it('refuses a source that is a FILE', async () => {
    const h = await harness({ source: 'file' })
    try {
      await assert.rejects(previewCloudSync(h.mock, deps(h)), /is not a directory/)
    }
    finally {
      await h.cleanup()
    }
  })

  it('does NOT apply the empty-source guard: a sync preview of an empty source runs the look', async () => {
    const h = await harness({ source: 'empty' })
    try {
      // rclone's honest answer for a sync over an empty source: it would
      // delete everything at the destination. That is exactly what the
      // preview exists to show — the guard stays with the run.
      replayRclone(h.mock, JSON.stringify({
        level: 'warning',
        msg: '\nDeleted:                4 (files), 1 (dirs)\n',
        source: 'accounting/stats.go:482',
        stats: { bytes: 0, checks: 5, deletedDirs: 1, deletes: 4, elapsedTime: 0.2, errors: 0, eta: null, fatalError: false, renames: 0, retryError: false, speed: 0, totalBytes: 0, totalChecks: 5, totalTransfers: 0, transferTime: 0, transfers: 0 },
        time: '2026-09-24T22:08:09.000000+00:00',
      }))
      const result = await previewCloudSync(h.mock, deps(h, { task: task({ source: h.source, mode: 'sync' }) }))
      assert.equal(result.deletes, 4, 'the look ran and reported what a run would do')
      assert.equal(result.truncated, false)
      assert.ok(h.mock.calls.some(c => c.command === TIMEOUT && c.args.includes('--dry-run')), 'the dry run was issued over the empty source')
    }
    finally {
      await h.cleanup()
    }
  })
})
