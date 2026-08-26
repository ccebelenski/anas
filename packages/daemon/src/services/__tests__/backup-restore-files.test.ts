import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BackupFilesRestoreRequest,
  BackupSnapshotPath,
  groupOfSnapshotId,
  parseSnapshotId,
  restorePatternFor,
  restorePatternsFor,
  sideBySideRestorePath,
} from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  availableBytes,
  bareArchiveName,
  buildRestoreArgs,
  classifyRestoreFailure,
  directoryHasEntries,
  estimateSpace,
  hardlinkPrimaryPath,
  isArchiveRootSelection,
  parentDirectory,
  parseHumanBytes,
  parseRestoreProgress,
  PARTIAL_MARKER_NAME,
  pathExists,
  progressSummaryLine,
  pveTerritoryReason,
  readSelectionFacts,
  runFileRestore,
  targetPathFor,
  verifyRestored,
  writePartialMarker,
  writeTestDirectory,
} from '../backup-restore-files.js'

/**
 * Selective file restore (story backup2.6).
 *
 * Every expectation here traces to a captured fact in
 * docs/BACKUP-RESTORE-GROUND-TRUTH.md — the pattern names come from the REAL
 * archive the pattern matrix was probed against (`bracket[1].txt`,
 * `star*name.txt`, `mix [a] * b.txt`, `with space.txt`), and the progress and
 * failure strings are read out of the real fixtures rather than retyped.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')
const PBC = '/usr/bin/proxmox-backup-client'
const TIMEOUT = '/usr/bin/timeout'

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

const REPO = {
  name: 'pbs-main',
  host: '127.0.0.1',
  port: 8007,
  datastore: 'anastest-store',
  authType: 'token' as const,
  tokenId: 'root@pam!anas-test',
}
const SNAP = 'host/gtrestore/2026-08-25T19:16:45Z'

function deps(overrides: Record<string, unknown> = {}) {
  return {
    repo: REPO,
    secret: 'token-secret-value',
    namespace: 'gtrestore',
    snapshot: SNAP,
    archive: 'data.pxar',
    target: '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z',
    mode: 'sideBySide' as const,
    selections: ['/alpha.txt'],
    options: {},
    ...overrides,
  }
}

/** The four-line `stat` block shape, verbatim from the real capture. */
function statBlock(
  path: string,
  size: number,
  type: string,
  mode: string,
  perms: string,
  modify = '2026-08-25 19:16:23',
): string {
  return [
    `  File: ${path}`,
    `  Size: ${String(size).padEnd(14)}Type: ${type}`,
    `Access: (${mode}/${perms}  )  Uid: 0     Gid: 0    `,
    `Modify: ${modify}`,
  ].join('\n')
}

// ============================================================================
//  1. The snapshot id must carry a timestamp (GT-57)
// ============================================================================

describe('backup2.6 — a snapshot id without a timestamp is refused', () => {
  it('accepts the full three-part id ANAS composes', () => {
    assert.equal(BackupSnapshotPath.safeParse(SNAP).success, true)
    assert.deepEqual(parseSnapshotId(SNAP), {
      backupType: 'host',
      backupId: 'gtrestore',
      time: '2026-08-25T19:16:45Z',
    })
    assert.equal(groupOfSnapshotId(SNAP), 'host/gtrestore')
  })

  it('refuses a BARE GROUP path — it silently restores the LATEST (GT-57)', () => {
    // Captured: `restore host/gtrestore data.pxar <target>` → exit 0, a
    // DIFFERENT restore than the one that was picked.
    assert.equal(BackupSnapshotPath.safeParse('host/gtrestore').success, false)
    assert.equal(parseSnapshotId('host/gtrestore'), null)
    assert.equal(groupOfSnapshotId('host/gtrestore'), null)
  })

  it('refuses a malformed or truncated timestamp', () => {
    assert.equal(BackupSnapshotPath.safeParse('host/gtrestore/2026-08-25').success, false)
    assert.equal(BackupSnapshotPath.safeParse('host/gtrestore/2026-08-25T19:16:45').success, false)
    assert.equal(BackupSnapshotPath.safeParse('host//2026-08-25T19:16:45Z').success, false)
    assert.equal(BackupSnapshotPath.safeParse('host/a/b/2026-08-25T19:16:45Z').success, false)
  })

  it('the request schema rejects it at the boundary', () => {
    const bad = BackupFilesRestoreRequest.safeParse({
      kind: 'files',
      repo: 'pbs-main',
      snapshot: 'host/gtrestore',
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
    })
    assert.equal(bad.success, false)
    const good = BackupFilesRestoreRequest.safeParse({
      kind: 'files',
      repo: 'pbs-main',
      snapshot: SNAP,
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
    })
    assert.equal(good.success, true)
    // Defaults: side-by-side, no ignore flags.
    assert.equal(good.data?.target.mode, 'sideBySide')
    assert.deepEqual(good.data?.options, {})
  })

  it('an EMPTY selection is refused — a restore of nothing is a mistake', () => {
    const r = BackupFilesRestoreRequest.safeParse({
      kind: 'files',
      repo: 'pbs-main',
      snapshot: SNAP,
      archive: 'data.pxar',
      selections: [],
    })
    assert.equal(r.success, false)
  })

  it('a selection with a control character is refused (it would be a second shell line)', () => {
    const r = BackupFilesRestoreRequest.safeParse({
      kind: 'files',
      repo: 'pbs-main',
      snapshot: SNAP,
      archive: 'data.pxar',
      selections: ['/a\nls /'],
    })
    assert.equal(r.success, false)
  })

  it('both target modes parse, and a bad one does not', () => {
    for (const mode of ['sideBySide', 'inPlace']) {
      const r = BackupFilesRestoreRequest.safeParse({
        kind: 'files',
        repo: 'pbs-main',
        snapshot: SNAP,
        archive: 'data.pxar',
        selections: ['/alpha.txt'],
        target: { mode, path: '/gtbackup/data' },
      })
      assert.equal(r.success, true, mode)
      assert.equal(r.data?.target.mode, mode)
    }
    const bad = BackupFilesRestoreRequest.safeParse({
      kind: 'files',
      repo: 'pbs-main',
      snapshot: SNAP,
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
      target: { mode: 'overwriteEverything' },
    })
    assert.equal(bad.success, false)
  })
})

// ============================================================================
//  2. The pattern helper, against the REAL archive's name set (GT-18/19/22)
// ============================================================================

describe('backup2.6 — restorePatternFor against the ground-truth names', () => {
  it('anchors with a leading slash — unanchored is a SUFFIX match at any depth (GT-18)', () => {
    // Captured: `--pattern alpha.txt` restored alpha.txt, sub/alpha.txt AND
    // sub/nest/alpha.txt. Anchoring is the difference between one file and three.
    assert.equal(restorePatternFor('/alpha.txt'), '/alpha.txt')
    assert.equal(restorePatternFor('/sub/nest/alpha.txt'), '/sub/nest/alpha.txt')
  })

  it('escapes `[` and `]` — unescaped they are a CHARACTER CLASS and match NOTHING (GT-22)', () => {
    // Captured PROBE 16: `bracket[1].txt` restored 0 entries at exit 0.
    // Captured PROBE 17: `bracket\[1\].txt` restored that one file.
    assert.equal(restorePatternFor('/bracket[1].txt'), '/bracket\\[1\\].txt')
  })

  it('escapes `*` (GT-22 PROBE 14)', () => {
    assert.equal(restorePatternFor('/star*name.txt'), '/star\\*name.txt')
  })

  it('escapes a mixed name exactly as the capture did (GT-22)', () => {
    // Captured PROBE 19 ARGV: [--pattern] [mix \[a\] \* b.txt]
    assert.equal(restorePatternFor('/mix [a] * b.txt'), '/mix \\[a\\] \\* b.txt')
  })

  it('leaves a SPACE alone — the pattern is one argv element, never a shell word', () => {
    assert.equal(restorePatternFor('/with space.txt'), '/with space.txt')
  })

  it('escapes `?` and a literal backslash in one pass, with no double-escaping', () => {
    assert.equal(restorePatternFor('/what?.txt'), '/what\\?.txt')
    assert.equal(restorePatternFor('/back\\slash.txt'), '/back\\\\slash.txt')
    assert.equal(restorePatternFor('/a[b]*c?d\\e'), '/a\\[b\\]\\*c\\?d\\\\e')
  })

  it('a directory name needs no trailing slash — it restores recursively (GT-20)', () => {
    assert.equal(restorePatternFor('/docs'), '/docs')
    assert.equal(restorePatternFor('/docs/'), '/docs')
  })

  it('the archive ROOT yields NO pattern — `--pattern /` is refused by pbc itself', () => {
    // Captured PROBE 22: `--pattern /` → "parameter verification failed -
    // 'pattern': value does not match the regex pattern", exit 255.
    assert.equal(restorePatternFor('/'), null)
    assert.equal(restorePatternFor('//'), null)
    // …and a selection list holding the root means "everything", which is a
    // restore with NO pattern at all — never an empty no-op.
    assert.deepEqual(restorePatternsFor(['/docs', '/']), [])
  })

  it('repeats and deduplicates, in selection order (GT-23)', () => {
    assert.deepEqual(
      restorePatternsFor(['/alpha.txt', '/docs/readme.md', '/alpha.txt']),
      ['/alpha.txt', '/docs/readme.md'],
    )
  })
})

// ============================================================================
//  3. The side-by-side directory name
// ============================================================================

describe('backup2.6 — the side-by-side directory', () => {
  it('is <home>.anas-restore-<snapshot time>, colon-free for SMB', () => {
    assert.equal(
      sideBySideRestorePath('/gtbackup/data', SNAP),
      '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z',
    )
    assert.equal(
      sideBySideRestorePath('/gtbackup/data/', SNAP),
      '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z',
    )
  })

  it('is deterministic — the same snapshot always names the same directory', () => {
    assert.equal(sideBySideRestorePath('/srv/x', SNAP), sideBySideRestorePath('/srv/x', SNAP))
  })

  it('refuses the filesystem root and a snapshot id with no timestamp', () => {
    assert.equal(sideBySideRestorePath('/', SNAP), null)
    assert.equal(sideBySideRestorePath('/gtbackup/data', 'host/gtrestore'), null)
  })
})

// ============================================================================
//  4. argv per mode — the flags exactly as the matrix measured them
// ============================================================================

describe('backup2.6 — buildRestoreArgs', () => {
  it('side-by-side emits NO overwrite flags at all (GT-15)', () => {
    // Captured: restoring into a NEW directory needs no flags and the directory
    // need not exist; deep missing parents are created.
    assert.deepEqual(
      buildRestoreArgs({
        snapshot: SNAP,
        archive: 'data.pxar',
        target: '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z',
        namespace: 'gtrestore',
        patterns: ['/alpha.txt'],
        mode: 'sideBySide',
        options: {},
      }),
      [
        'restore',
        SNAP,
        'data.pxar',
        '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z',
        '--ns',
        'gtrestore',
        '--pattern',
        '/alpha.txt',
      ],
    )
  })

  it('in-place emits `--allow-existing-dirs --overwrite`, the MINIMAL pair (GT-11)', () => {
    // Captured ladder: --overwrite alone dies on the first existing DIRECTORY;
    // --allow-existing-dirs alone dies on the first existing FILE; the pair
    // exits 0. `--overwrite` does NOT imply `--allow-existing-dirs`.
    const args = buildRestoreArgs({
      snapshot: SNAP,
      archive: 'data.pxar',
      target: '/gtbackup/data',
      patterns: ['/docs'],
      mode: 'inPlace',
      options: {},
    })
    assert.deepEqual(args, [
      'restore',
      SNAP,
      'data.pxar',
      '/gtbackup/data',
      '--pattern',
      '/docs',
      '--allow-existing-dirs',
      '--overwrite',
    ])
    assert.ok(!args.includes('--overwrite-files'), '--overwrite covers files/symlinks/hardlinks')
  })

  it('a single picked FILE in place still ships --allow-existing-dirs (GT-26)', () => {
    // Captured: `--pattern /docs/readme.md --overwrite` → 255 "failed to get
    // parent directory file descriptor: EEXIST"; with the dir flag → exit 0.
    const args = buildRestoreArgs({
      snapshot: SNAP,
      archive: 'data.pxar',
      target: '/gtbackup/data',
      patterns: ['/docs/readme.md'],
      mode: 'inPlace',
      options: {},
    })
    assert.ok(args.includes('--allow-existing-dirs'))
  })

  it('one --pattern per selection, in order (GT-23)', () => {
    const args = buildRestoreArgs({
      snapshot: SNAP,
      archive: 'data.pxar',
      target: '/t',
      patterns: ['/alpha.txt', '/docs/readme.md'],
      mode: 'sideBySide',
      options: {},
    })
    assert.deepEqual(
      args.slice(args.indexOf('--pattern')),
      ['--pattern', '/alpha.txt', '--pattern', '/docs/readme.md'],
    )
  })

  it('NO --pattern at all when the selection was the whole archive', () => {
    const args = buildRestoreArgs({
      snapshot: SNAP,
      archive: 'data.pxar',
      target: '/t',
      patterns: [],
      mode: 'sideBySide',
      options: {},
    })
    assert.deepEqual(args, ['restore', SNAP, 'data.pxar', '/t'])
  })

  it('every --ignore-* flag is emitted only when asked, and --rate rides last', () => {
    const args = buildRestoreArgs({
      snapshot: SNAP,
      archive: 'data.pxar',
      target: '/t',
      patterns: [],
      mode: 'sideBySide',
      options: { ignoreOwnership: true, ignoreAcls: true, ignoreXattrs: true, ignorePermissions: true },
      rate: '3MB',
    })
    assert.deepEqual(args, [
      'restore',
      SNAP,
      'data.pxar',
      '/t',
      '--ignore-ownership',
      '--ignore-acls',
      '--ignore-xattrs',
      '--ignore-permissions',
      '--rate',
      '3MB',
    ])
    // Absent means absent — `false` is not emitted either.
    const none = buildRestoreArgs({
      snapshot: SNAP,
      archive: 'data.pxar',
      target: '/t',
      patterns: [],
      mode: 'sideBySide',
      options: { ignoreOwnership: false },
    })
    assert.ok(!none.some(a => a.startsWith('--ignore')))
  })
})

// ============================================================================
//  5. Progress parsing, from the REAL fixture (GT-59)
// ============================================================================

describe('backup2.6 — restore progress', () => {
  it('parses every progress line of the real capture', () => {
    // The fixture's `[+  5983 ms] ` prefixes are the CAPTURE HARNESS's own
    // arrival stamps, not part of what the client writes — stripped here so the
    // parser sees exactly the bytes pbc emitted. (The fixture's second section
    // is a `cat -v` pty rendering where the CR shows as a literal `^M`; the real
    // CR behaviour is covered by the test below.)
    const p1 = fixture('restore-progress.txt').split('############ P2')[0]!
    const stderr = p1.replace(/^\[\+\s*\d+ ms\] /gm, '')
    const parsed = parseRestoreProgress(stderr)
    assert.equal(parsed.progress.length, 4)
    const first = parsed.progress[0]!
    assert.equal(first.percent, 4)
    assert.equal(first.done, '12.409 MiB')
    assert.equal(first.total, '250.001 MiB')
    assert.equal(first.elapsed, '6s')
    assert.equal(first.rate, '2.084 MiB/s')
    // The interval roughly DOUBLES (6s, 16.1s, 36.1s, 1m 18.8s) — a job UI must
    // never read the silence between them as a stall.
    assert.deepEqual(parsed.progress.map(p => p.elapsed), ['6s', '16.1s', '36.1s', '1m 18.8s'])
    assert.equal(parsed.completeLine, 'restore complete (250.001 MiB processed in 1m 27.5s, average 2.857 MiB/s)')
  })

  it('parses the `restore complete` line and its byte total', () => {
    const parsed = parseRestoreProgress(
      'progress 4% (12.409 MiB of 250.001 MiB in 6s, 2.084 MiB/s)    \r'
      + 'restore complete (250.001 MiB processed in 1m 27.5s, average 2.857 MiB/s)    \r',
    )
    assert.equal(parsed.completeLine, 'restore complete (250.001 MiB processed in 1m 27.5s, average 2.857 MiB/s)')
    assert.equal(parsed.bytes, Math.round(250.001 * 1024 * 1024))
  })

  it('falls back to the LAST progress line for an interrupted run — never an invented total', () => {
    const parsed = parseRestoreProgress(
      'progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.1 MiB/s)\r',
    )
    assert.equal(parsed.completeLine, undefined)
    assert.equal(parsed.bytes, Math.round(43.939 * 1024 * 1024))
  })

  it('says silence is not a stall when nothing has been printed yet', () => {
    // Nothing at all is printed for the first ~6 s, then at a DOUBLING interval.
    assert.match(progressSummaryLine(parseRestoreProgress('')), /silence is not a stall/)
  })

  it('parseHumanBytes handles the units pbc prints', () => {
    assert.equal(parseHumanBytes('13 B'), 13)
    assert.equal(parseHumanBytes('2.546 KiB'), Math.round(2.546 * 1024))
    assert.equal(parseHumanBytes('250.001 MiB'), Math.round(250.001 * 1024 * 1024))
    assert.equal(parseHumanBytes('nonsense'), undefined)
  })
})

// ============================================================================
//  6. Failure taxonomy, from the REAL fixture (GT-56/60/61)
// ============================================================================

describe('backup2.6 — classifyRestoreFailure', () => {
  it('collapses missing snapshot / group / namespace into ONE message (GT-56)', () => {
    // Captured F1/F2/F3: all three produce the identical string, so which one
    // is wrong CANNOT be told apart — and the message says so.
    for (const id of ['host/gtrestore/2020-01-01T00:00:00Z', 'host/nosuchgroup/2026-08-25T19:16:45Z']) {
      const { detail } = classifyRestoreFailure(255, `Error: snapshot ${id} does not exist.\n`)
      assert.match(detail, /snapshot, group or namespace/)
    }
  })

  it('names a PBS that is down, with the 4.2.5 cause line (GT-56 F10)', () => {
    const { detail } = classifyRestoreFailure(255, [
      'Error: client error (Connect)',
      '',
      'Caused by:',
      '    error connecting to https://localhost:8007/ - tcp connect error: Connection refused (os error 111)',
    ].join('\n'))
    assert.match(detail, /Connection refused/)
  })

  it('the no-permission token has its OWN wording (GT-56 F11)', () => {
    const { detail } = classifyRestoreFailure(255, 'Error: no permissions on /datastore/anastest-store/gtrestore\n')
    assert.match(detail, /lacks read access/)
  })

  it('a read-only target is named as failing at the FIRST FILE (GT-56 F8)', () => {
    const stderr = fixture('restore-failure-taxonomy.txt')
      .split('=== F8 target path UNWRITABLE')[1]!
      .split('=== F8b')[0]!
    const { detail, interrupted } = classifyRestoreFailure(255, stderr)
    assert.match(detail, /read-only/i)
    assert.match(detail, /FIRST file/)
    assert.equal(interrupted, true)
  })

  it('a target that is a regular file is named (GT-56 F7)', () => {
    const { detail } = classifyRestoreFailure(
      255,
      'Error: error extracting archive - failed to initialize extractor: error creating directory '
      + '"/gtbackup/ftfile": ENOTDIR: Not a directory\n',
    )
    assert.match(detail, /not a directory/i)
  })

  it('a hardlink restored without its partner explains the real cause (GT-25)', () => {
    const { detail } = classifyRestoreFailure(
      255,
      'Error: error extracting archive - encountered unexpected error during extraction: error at entry '
      + '"hard-b.txt": failed to extract hardlink: ENOENT: No such file or directory\n',
    )
    assert.match(detail, /hardlink group together/)
  })

  it('PBS dying mid-restore is INTERRUPTED, not a plain failure (GT-61)', () => {
    const { detail, interrupted } = classifyRestoreFailure(
      255,
      'HTTP/2.0 connection failed\nError: error extracting archive - … connection closed because of a broken pipe\n',
    )
    assert.equal(interrupted, true)
    assert.match(detail, /went away part-way/)
  })

  it('a KILLED client (exit 137/143) is interrupted, with nothing to quote (GT-60)', () => {
    for (const code of [137, 143]) {
      const { detail, interrupted } = classifyRestoreFailure(code, '')
      assert.equal(interrupted, true)
      assert.match(detail, /interrupted/)
      assert.match(detail, /still there/)
    }
  })

  it('ENOSPC says the estimate was an estimate', () => {
    const { detail } = classifyRestoreFailure(255, 'Error: … ENOSPC: No space left on device\n')
    assert.match(detail, /ran out of space/)
  })
})

// ============================================================================
//  7. Protected targets — PVE territory and live LUN backings
// ============================================================================

describe('backup2.6 — pveTerritoryReason', () => {
  const PVE_PATHS = ['/mnt/pve/nfs-store', '/rpool/data']

  it('refuses /mnt/pve and everything under it', () => {
    assert.match(pveTerritoryReason('/mnt/pve', PVE_PATHS)!, /belongs to Proxmox/)
    assert.match(pveTerritoryReason('/mnt/pve/anything/deep', PVE_PATHS)!, /belongs to Proxmox/)
  })

  it('refuses /etc/pve — the cluster filesystem', () => {
    assert.match(pveTerritoryReason('/etc/pve/anas', PVE_PATHS)!, /cluster filesystem/)
  })

  it('refuses a path storage.cfg claims, naming the path', () => {
    assert.match(pveTerritoryReason('/rpool/data/sub', PVE_PATHS)!, /'\/rpool\/data'/)
  })

  it('allows an ordinary path', () => {
    assert.equal(pveTerritoryReason('/tank/photos.anas-restore-2026-08-25T19-16-45Z', PVE_PATHS), null)
    // A path that merely SHARES A PREFIX is not inside — no string-prefix bug.
    assert.equal(pveTerritoryReason('/rpool/database', PVE_PATHS), null)
    assert.equal(pveTerritoryReason('/mnt/pvex', PVE_PATHS), null)
  })

  it('leaves the LIVE-LUN half to heldByLun — one question, one phrasing', () => {
    // iscsi.6's `heldByLun({ path })` already answers "is a LUN serving
    // anything at or under this path?", which is exactly the restore hazard: a
    // file-backed LUN is an ordinary file, so an in-place `--overwrite` restore
    // into its directory would rewrite it under a live initiator. The route
    // asks that question; this function deliberately does not duplicate it.
    assert.equal(pveTerritoryReason('/tank/luns/win.img', PVE_PATHS), null)
  })
})

// ============================================================================
//  8. The catalog stat pass: hardlink completion, directories, sizes
// ============================================================================

describe('backup2.6 — readSelectionFacts', () => {
  function shellMock(stdout: string, exitCode = 0, stderr = 'Starting interactive shell\n'): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, result: { stdout, stderr, exitCode } })
    return mock
  }

  const browseDeps = {
    repo: REPO,
    secret: 's',
    namespace: 'gtrestore',
    snapshot: SNAP,
    archive: 'data.pxar',
    path: '/',
  }

  it('adds a hardlink`s PRIMARY when only the second name was picked (GT-25)', async () => {
    // The real capture renders a hardlink as a symlink with mode (0/L---------)
    // pointing at the group's primary name.
    const mock = shellMock(statBlock('/hard-b.txt -> "hard-a.txt"', 0, 'symlink', '0', 'L---------'))
    const facts = await readSelectionFacts(mock, browseDeps, ['/hard-b.txt'])
    assert.deepEqual(facts.selections, ['/hard-b.txt', '/hard-a.txt'])
    assert.deepEqual(facts.addedForHardlinks, ['/hard-a.txt'])
    assert.match(facts.warnings[0]!, /fails the whole restore/)
  })

  it('does not add a partner twice when BOTH names were picked', async () => {
    const mock = shellMock([
      statBlock('/hard-a.txt', 13, 'file', '644', '-rw-r--r--'),
      statBlock('/hard-b.txt -> "hard-a.txt"', 0, 'symlink', '0', 'L---------'),
    ].join('\n'))
    const facts = await readSelectionFacts(mock, browseDeps, ['/hard-a.txt', '/hard-b.txt'])
    assert.deepEqual(facts.selections, ['/hard-a.txt', '/hard-b.txt'])
    assert.deepEqual(facts.addedForHardlinks, [])
  })

  it('a real SYMLINK is left alone — only mode `L` is a hardlink (GT-8c)', async () => {
    const mock = shellMock(statBlock('/link-to-alpha -> "alpha.txt"', 0, 'symlink', '777', 'lrwxrwxrwx'))
    const facts = await readSelectionFacts(mock, browseDeps, ['/link-to-alpha'])
    assert.deepEqual(facts.addedForHardlinks, [])
    assert.equal(facts.hasDirectory, false)
  })

  it('flags a DIRECTORY selection — the confirm gate`s only trigger', async () => {
    const mock = shellMock(statBlock('/docs', 0, 'directory', '755', 'drwxr-xr-x'))
    const facts = await readSelectionFacts(mock, browseDeps, ['/docs'])
    assert.equal(facts.hasDirectory, true)
    assert.equal(facts.exactBytes, null, 'a tree has no exact size from the catalog')
  })

  it('sums FILE sizes exactly when nothing in the selection is a tree', async () => {
    const mock = shellMock([
      statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'),
      statBlock('/beta.txt', 17, 'file', '644', '-rw-r--r--'),
    ].join('\n'))
    const facts = await readSelectionFacts(mock, browseDeps, ['/alpha.txt', '/beta.txt'])
    assert.equal(facts.hasDirectory, false)
    assert.equal(facts.exactBytes, 40)
  })

  it('the archive ROOT is a tree by definition', async () => {
    const mock = shellMock(statBlock('/', 0, 'directory', '755', 'drwxr-xr-x'))
    const facts = await readSelectionFacts(mock, browseDeps, ['/'])
    assert.equal(facts.hasDirectory, true)
    assert.equal(facts.exactBytes, null)
  })

  it('names a selection the archive does not hold (GT-8e: stderr, exit 0)', async () => {
    const mock = shellMock('', 0, 'Starting interactive shell\nError: no such file or directory: "nope.txt"\n')
    const facts = await readSelectionFacts(mock, browseDeps, ['/nope.txt'])
    assert.deepEqual(facts.unknown, ['/nope.txt'])
  })

  it('FAILS OPEN when the shell never started — and assumes the widest case', async () => {
    const mock = shellMock('', 255, 'Error: client error (Connect)\n')
    const facts = await readSelectionFacts(mock, browseDeps, ['/alpha.txt'])
    assert.deepEqual(facts.selections, ['/alpha.txt'])
    assert.equal(facts.hasDirectory, true, 'not knowing means assuming a tree')
    assert.equal(facts.exactBytes, null)
    assert.match(facts.warnings[0]!, /catalog could not be read/)
  })

  it('a bare hardlink target is ARCHIVE-ROOT-relative, not a sibling (live-proof wave 2)', () => {
    // Read off the real client: every non-primary name prints the primary's
    // path relative to the ARCHIVE ROOT with no leading slash, wherever the two
    // names sit — `/a/z -> "a/x"`, `/b/y -> "a/x"`, `/c/deep/w -> "a/x"`,
    // `/rootlink -> "rootfile"`. Reading it as a sibling gave `/b/a/x`, a
    // pattern matching nothing, and the restore died with GT-25's
    // `failed to extract hardlink: ENOENT`.
    assert.equal(hardlinkPrimaryPath('/b/y', 'a/x'), '/a/x')
    assert.equal(hardlinkPrimaryPath('/c/deep/w', 'a/x'), '/a/x')
    assert.equal(hardlinkPrimaryPath('/a/z', 'a/x'), '/a/x')
    // The archive root is where the two readings coincide — still right.
    assert.equal(hardlinkPrimaryPath('/rootlink', 'rootfile'), '/rootfile')
    // An absolute target is archive-absolute already.
    assert.equal(hardlinkPrimaryPath('/docs/hard-b.txt', '/other/hard-a.txt'), '/other/hard-a.txt')
    assert.equal(hardlinkPrimaryPath('/hard-b.txt', ''), null)
  })
})

// ============================================================================
//  9. Space
// ============================================================================

describe('backup2.6 — estimateSpace', () => {
  it('lets an exact, fitting selection through', () => {
    const e = estimateSpace(40, true, 1000, '/t')
    assert.equal(e.refuse, false)
  })

  it('refuses with BOTH numbers when an exact selection does not fit', () => {
    const e = estimateSpace(4000, true, 1000, '/t')
    assert.equal(e.refuse, true)
    assert.match(e.detail!, /4000 bytes/)
    assert.match(e.detail!, /1000 bytes free/)
  })

  it('says the figure is the WHOLE archive when a tree is involved', () => {
    const e = estimateSpace(4000, false, 1000, '/t')
    assert.equal(e.refuse, true)
    assert.match(e.detail!, /not known exactly/)
    assert.match(e.detail!, /whole archive is 4000 bytes/)
  })

  it('never refuses on an unknown figure — unknown is unknown, not "plenty"', () => {
    assert.equal(estimateSpace(null, false, 1000, '/t').refuse, false)
    assert.equal(estimateSpace(4000, true, null, '/t').refuse, false)
  })
})

// ============================================================================
//  10. The local probes — write test, space, existence, verification
// ============================================================================

describe('backup2.6 — local pre-flight probes', () => {
  it('the write test WRITES (root ignores directory permissions — GT-56 F8b)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 0 } })
    const out = await writeTestDirectory(mock, '/gtbackup/data', '.probe')
    assert.equal(out.ok, true)
    const touch = mock.calls[0]!
    assert.deepEqual(touch.args, ['10', '/usr/bin/touch', '/gtbackup/data/.probe'])
    // …and it cleans up after itself.
    assert.deepEqual(mock.calls[1]!.args, ['10', '/usr/bin/rm', '-f', '/gtbackup/data/.probe'])
  })

  it('a read-only target is refused BEFORE the client runs (GT-56 F8)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: TIMEOUT,
      result: { stdout: '', stderr: 'touch: cannot touch \'/x/.p\': Read-only file system\n', exitCode: 1 },
    })
    const out = await writeTestDirectory(mock, '/x', '.p')
    assert.equal(out.ok, false)
    assert.match(out.ok === false ? out.detail : '', /Read-only file system/)
  })

  it('a target that never answers is refused, not waited on', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 124 } })
    const out = await writeTestDirectory(mock, '/dead', '.p')
    assert.equal(out.ok, false)
    assert.match(out.ok === false ? out.detail : '', /not responding/)
  })

  it('availableBytes multiplies the block size by the free blocks', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, result: { stdout: '4096 2500\n', stderr: '', exitCode: 0 } })
    assert.equal(await availableBytes(mock, '/t'), 4096 * 2500)
    assert.deepEqual(mock.calls[0]!.args, ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/t'])
  })

  it('availableBytes returns null rather than guessing when the probe fails', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: 'no', exitCode: 1 } })
    assert.equal(await availableBytes(mock, '/t'), null)
  })

  it('pathExists answers from a bounded stat, and null on a timeout', async () => {
    const yes = new MockExecutor()
    yes.addFixture({ command: TIMEOUT, result: { stdout: 'directory\n', stderr: '', exitCode: 0 } })
    assert.equal(await pathExists(yes, '/t'), true)
    const no = new MockExecutor()
    no.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: 'No such file', exitCode: 1 } })
    assert.equal(await pathExists(no, '/t'), false)
    const dead = new MockExecutor()
    dead.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 124 } })
    assert.equal(await pathExists(dead, '/t'), null)
  })

  it('verification is a BOUNDED probe of the exact paths — it never walks the tree', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: TIMEOUT,
      result: { stdout: '/t/alpha.txt\n', stderr: 'find: \'/t/nope.txt\': No such file or directory\n', exitCode: 1 },
    })
    const out = await verifyRestored(mock, '/t', ['/alpha.txt', '/nope.txt'])
    assert.deepEqual(out.restored, ['/alpha.txt'])
    assert.deepEqual(out.missing, ['/nope.txt'])
    assert.deepEqual(mock.calls[0]!.args, [
      '30',
      '/usr/bin/find',
      '-P',
      '/t/alpha.txt',
      '/t/nope.txt',
      '-maxdepth',
      '0',
      '-printf',
      '%p\n',
    ])
  })

  it('a ROOT selection verifies as the target itself', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TIMEOUT, result: { stdout: '/t\n', stderr: '', exitCode: 0 } })
    const out = await verifyRestored(mock, '/t', ['/'])
    assert.deepEqual(out.restored, ['/'])
    assert.deepEqual(mock.calls[0]!.args.slice(0, 4), ['30', '/usr/bin/find', '-P', '/t'])
  })

  it('targetPathFor and the small path helpers', () => {
    assert.equal(targetPathFor('/t', '/docs/readme.md'), '/t/docs/readme.md')
    assert.equal(targetPathFor('/t/', '/docs/'), '/t/docs')
    assert.equal(targetPathFor('/t', '/'), '/t')
    assert.equal(isArchiveRootSelection('/'), true)
    assert.equal(isArchiveRootSelection('//'), true)
    assert.equal(isArchiveRootSelection('/a'), false)
    assert.equal(parentDirectory('/gtbackup/data'), '/gtbackup')
    assert.equal(parentDirectory('/gtbackup'), '/')
    assert.equal(bareArchiveName('data.pxar'), 'data')
    assert.equal(bareArchiveName('data.mpxar.didx'), 'data')
    assert.equal(bareArchiveName('lun.img'), 'lun')
    assert.equal(bareArchiveName('data__photos.pxar'), 'data__photos')
  })

  it('directoryHasEntries reports empty vs not', async () => {
    const empty = new MockExecutor()
    empty.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 0 } })
    assert.equal(await directoryHasEntries(empty, '/t'), false)
    const full = new MockExecutor()
    full.addFixture({ command: TIMEOUT, result: { stdout: '..', stderr: '', exitCode: 0 } })
    assert.equal(await directoryHasEntries(full, '/t'), true)
  })
})

// ============================================================================
//  11. The run: verification, partial marker, cleanup
// ============================================================================

describe('backup2.6 — runFileRestore', () => {
  /** A mock whose pbc call answers `pbc`, and whose probes answer `probe`. */
  function restoreMock(
    pbc: { stdout?: string, stderr?: string, exitCode: number },
    probes: { stdout?: string, stderr?: string, exitCode: number }[] = [],
  ): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: pbc.stdout ?? '', stderr: pbc.stderr ?? '', exitCode: pbc.exitCode } })
    mock.addFixture({
      command: TIMEOUT,
      results: probes.length
        ? probes.map(p => ({ stdout: p.stdout ?? '', stderr: p.stderr ?? '', exitCode: p.exitCode }))
        : [{ stdout: '', stderr: '', exitCode: 0 }],
    })
    return mock
  }

  it('sends the argv, parses progress, and verifies what landed', async () => {
    const mock = restoreMock(
      { stderr: 'restore complete (2.546 KiB processed in <0.1s, average 777 KiB/s)    \r', exitCode: 0 },
      [{ stdout: '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z/alpha.txt\n', exitCode: 0 }],
    )
    const progress: string[] = []
    const result = await runFileRestore(mock, deps(), m => progress.push(m))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.restored, ['/alpha.txt'])
    assert.deepEqual(result.missing, [])
    assert.equal(result.merge, false)
    assert.deepEqual(result.patterns, ['/alpha.txt'])
    assert.equal(result.bytes, Math.round(2.546 * 1024))
    const call = mock.calls.find(c => c.command === PBC)!
    assert.deepEqual(call.args, [
      'restore',
      SNAP,
      'data.pxar',
      '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z',
      '--ns',
      'gtrestore',
      '--pattern',
      '/alpha.txt',
    ])
    // The secret is NEVER on argv.
    assert.ok(!call.args.some(a => a.includes('token-secret-value')))
    assert.ok(progress.some(p => /silence is not a stall/.test(p)))
  })

  it('a SILENT no-match completes WITH WARNINGS, naming what is not there (GT-24)', async () => {
    // Captured F6 / PROBE 21: a pattern that matches nothing exits 0 and
    // restores nothing. The client will never say the selection was wrong.
    const mock = restoreMock(
      { stderr: 'restore complete (2.546 KiB processed in <0.1s, average 2.886 MiB/s)    \r', exitCode: 0 },
      [{ stdout: '', stderr: 'find: no such file\n', exitCode: 1 }],
    )
    const result = await runFileRestore(mock, deps({ selections: ['/nosuchthing'] }), () => {})
    assert.equal(result.status, 'completed-with-warnings')
    assert.deepEqual(result.missing, ['/nosuchthing'])
    assert.ok(result.warnings.some(w => w.includes('/nosuchthing')))
  })

  it('an in-place restore says MERGE, never sync, on the record (GT-12)', async () => {
    const mock = restoreMock(
      { stderr: 'restore complete (2.546 KiB processed in <0.1s, average 1 MiB/s)\r', exitCode: 0 },
      [{ stdout: '/gtbackup/data/docs\n', exitCode: 0 }],
    )
    const result = await runFileRestore(
      mock,
      deps({ mode: 'inPlace', target: '/gtbackup/data', selections: ['/docs'] }),
      () => {},
    )
    assert.equal(result.merge, true)
    assert.ok(result.warnings.some(w => /MERGE, never a sync/.test(w)))
    const call = mock.calls.find(c => c.command === PBC)!
    assert.ok(call.args.includes('--allow-existing-dirs') && call.args.includes('--overwrite'))
  })

  it('a failed side-by-side restore that WROTE something is LABELLED partial (GT-60)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-restore-partial-'))
    try {
      const mock = restoreMock(
        {
          stderr: 'progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.1 MiB/s)\r'
            + 'HTTP/2.0 connection failed\n'
            + 'Error: error extracting archive - … connection closed because of a broken pipe\n',
          exitCode: 255,
        },
        // directoryHasEntries → not empty
        [{ stdout: '..', exitCode: 0 }],
      )
      await assert.rejects(
        () => runFileRestore(mock, deps({ target: dir }), () => {}),
        (err: Error) => {
          assert.match(err.message, /PARTIAL tree/)
          assert.match(err.message, /Last progress: progress 17%/)
          return true
        },
      )
      const marker = await readFile(join(dir, PARTIAL_MARKER_NAME), 'utf8')
      assert.match(marker, /ANAS restore did not finish/)
      assert.match(marker, /last progress: progress 17%/)
      assert.match(marker, /mode 0600/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a failed side-by-side restore that wrote NOTHING removes the empty directory', async () => {
    const mock = restoreMock(
      { stderr: 'Error: snapshot host/gtrestore/2020-01-01T00:00:00Z does not exist.\n', exitCode: 255 },
      [
        { stdout: '', exitCode: 0 }, // directoryHasEntries → empty
        { stdout: '', exitCode: 0 }, // rm -d
      ],
    )
    await assert.rejects(
      () => runFileRestore(mock, deps(), () => {}),
      (err: Error) => {
        assert.match(err.message, /empty restore directory .* was removed/)
        return true
      },
    )
    const rmCall = mock.calls.filter(c => c.command === TIMEOUT).at(-1)!
    assert.deepEqual(rmCall.args, ['10', '/usr/bin/rm', '-d', '-f', deps().target])
  })

  it('an IN-PLACE failure writes no marker at all, and names the 0600 hint (GT-60)', async () => {
    const mock = restoreMock(
      { stderr: 'progress 40% (101.305 MiB of 250.001 MiB in 36.1s, 2.868 MiB/s)\r', exitCode: 137 },
    )
    await assert.rejects(
      () => runFileRestore(mock, deps({ mode: 'inPlace', target: '/gtbackup/data' }), () => {}),
      (err: Error) => {
        assert.match(err.message, /interrupted/)
        assert.match(err.message, /mixture of its previous contents/)
        assert.match(err.message, /short AND mode 0600/)
        return true
      },
    )
    // Nothing was written into the operator's live tree to describe our failure.
    assert.ok(!mock.calls.some(c => c.args.some(a => a.includes(PARTIAL_MARKER_NAME))))
  })

  it('writePartialMarker is best-effort and never masks the real failure', async () => {
    assert.equal(await writePartialMarker('/nonexistent-anas-dir-xyz', 'text'), null)
  })
})
