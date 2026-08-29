import type { BackupRepo, BackupTask } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildBackupArgs,
  buildBackupEnv,
  buildProbeArgs,
  buildRepoString,
  classifyBackupResult,
  classifyTestVerdict,
  normalizeFingerprint,
  parseBackupProgress,
  progressSummary,
  skippedNotices,
} from '../backup-runner.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

function makeRepo(over: Partial<BackupRepo> = {}): BackupRepo {
  return {
    name: 'pbs-main',
    host: 'localhost',
    port: 8007,
    datastore: 'anastest-store',
    authType: 'password',
    username: 'root@pam',
    fingerprint: 'cc:b8:a0:35:60:b9:5f:77:10:e8:c2:62:ce:1e:dd:08',
    ...over,
  }
}

function makeTask(over: Partial<BackupTask> = {}): BackupTask {
  return {
    name: 'nightly',
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives: [{ name: 'documents', path: '/root/anas-src/documents', excludes: [] }],
    changeDetectionMode: 'default',
    notify: 'always',
    schedule: 'daily',
    enabled: true,
    limitNofile: 1024,
    ...over,
  }
}

/**
 * Parse the failure-taxonomy fixture into { case, stderr, exitCode }. The file
 * prints each probe's verbatim output as `  | <line>` and `=== EXIT CODE: N ===`.
 */
function parseTaxonomyCases(text: string): { title: string, stderr: string, exit: number }[] {
  const cases: { title: string, stderr: string, exit: number }[] = []
  const blocks = text.split(/^CASE:/m).slice(1)
  for (const block of blocks) {
    const title = block.split('\n')[0].trim()
    const stderr = block
      .split('\n')
      .filter(l => l.startsWith('  | '))
      .map(l => l.slice(4))
      .join('\n')
    const m = block.match(/=== EXIT CODE:\s*(\d+)\s*===/)
    cases.push({ title, stderr, exit: m ? Number(m[1]) : Number.NaN })
  }
  return cases
}

describe('backup runner — env + argv assembly (Epic 16, NOTES §1)', () => {
  it('password repo string is user@host:port:datastore', () => {
    assert.equal(buildRepoString(makeRepo()), 'root@pam@localhost:8007:anastest-store')
  })

  it('token repo string carries the !tokenname auth-id', () => {
    const repo = makeRepo({ authType: 'token', tokenId: 'root@pam!anas-test', username: undefined })
    assert.equal(buildRepoString(repo), 'root@pam!anas-test@localhost:8007:anastest-store')
  })

  it('env puts the SECRET in PBS_PASSWORD and pins the fingerprint (never argv)', () => {
    const env = buildBackupEnv(makeRepo(), 'the-secret')
    assert.equal(env.PBS_REPOSITORY, 'root@pam@localhost:8007:anastest-store')
    assert.equal(env.PBS_PASSWORD, 'the-secret')
    assert.equal(env.PBS_FINGERPRINT, 'cc:b8:a0:35:60:b9:5f:77:10:e8:c2:62:ce:1e:dd:08')
  })

  it('env omits PBS_FINGERPRINT when the repo has no pin', () => {
    const env = buildBackupEnv(makeRepo({ fingerprint: undefined }), 's')
    assert.equal('PBS_FINGERPRINT' in env, false)
  })

  it('backup argv: archives, excludes, backup-id, ns and metadata flag', () => {
    const task = makeTask({
      namespace: 'anastest',
      changeDetectionMode: 'metadata',
      archives: [
        { name: 'documents', path: '/root/anas-src/documents', excludes: ['*.key', '/build', 'tmp'] },
        { name: 'pictures', path: '/root/anas-src/pictures', excludes: [] },
      ],
    })
    assert.deepEqual(buildBackupArgs(task), [
      'backup',
      'documents.pxar:/root/anas-src/documents',
      'pictures.pxar:/root/anas-src/pictures',
      '--exclude',
      '*.key',
      '--exclude',
      '/build',
      '--exclude',
      'tmp',
      '--backup-id',
      'anas-pve',
      '--ns',
      'anastest',
      '--change-detection-mode=metadata',
    ])
  })

  it('default mode emits NO --change-detection-mode flag; no ns when absent', () => {
    const args = buildBackupArgs(makeTask())
    assert.ok(!args.includes('--change-detection-mode=metadata'))
    assert.ok(!args.includes('--ns'))
    assert.ok(args.includes('--backup-id'))
  })

  it('an explicit effective namespace overrides / supplies --ns (repo fallback path)', () => {
    // A task with no namespace but a repo that carries one → the resolved
    // effective namespace is passed and emitted (zero re-entry, Epic 16.8).
    const args = buildBackupArgs(makeTask({ namespace: undefined }), 'anastest')
    const i = args.indexOf('--ns')
    assert.ok(i >= 0 && args[i + 1] === 'anastest')
    // An explicit namespace also overrides the task's own.
    const overridden = buildBackupArgs(makeTask({ namespace: 'task-ns' }), 'repo-ns')
    const j = overridden.indexOf('--ns')
    assert.equal(overridden[j + 1], 'repo-ns')
  })

  // ---- backup2.2: includeNested → --include-dev, and NEVER --all-file-systems

  /** Every `--include-dev <path>` in an argv, in emission order. */
  function includeDevs(args: string[]): string[] {
    const out: string[] = []
    args.forEach((a, i) => {
      if (a === '--include-dev')
        out.push(args[i + 1])
    })
    return out
  }

  it('includeNested `none` (and ABSENT) emit NO nested flag at all', () => {
    const absent = buildBackupArgs(makeTask())
    assert.ok(!absent.includes('--include-dev'))
    // An explicit `none` is the same argv as an absent field — one behaviour.
    const explicit = buildBackupArgs(makeTask({
      archives: [{ name: 'etc', path: '/etc', excludes: [], includeNested: 'none' }],
    }))
    assert.deepEqual(explicit, buildBackupArgs(makeTask({
      archives: [{ name: 'etc', path: '/etc', excludes: [] }],
    })))
  })

  it('`--all-file-systems` is NEVER emitted — it is per-invocation, we are per-archive', () => {
    const args = buildBackupArgs(
      makeTask({
        archives: [
          { name: 'a', path: '/mnt/a', excludes: [], includeNested: 'all' },
          { name: 'b', path: '/mnt/b', excludes: [] },
        ],
      }),
      undefined,
      { a: ['/mnt/a/child'] },
    )
    assert.ok(!args.includes('--all-file-systems'), args.join(' '))
  })

  it('`all` with ZERO boundaries resolves to no flag at all (nothing to cross)', () => {
    const args = buildBackupArgs(
      makeTask({ archives: [{ name: 'a', path: '/mnt/a', excludes: [], includeNested: 'all' }] }),
      undefined,
      { a: [] },
    )
    assert.deepEqual(includeDevs(args), [])
    assert.ok(!args.includes('--include-dev'))
  })

  it('`all` with ONE boundary resolves to exactly that one --include-dev', () => {
    const args = buildBackupArgs(
      makeTask({ archives: [{ name: 'etc', path: '/etc', excludes: [], includeNested: 'all' }] }),
      undefined,
      { etc: ['/etc/pve'] },
    )
    assert.deepEqual(includeDevs(args), ['/etc/pve'])
  })

  it('`all` with a NESTED-INSIDE-NESTED boundary passes BOTH — pbc does not recurse for us', () => {
    // A child dataset inside a child dataset: naming only the outer one would
    // still lose the inner tree, because --include-dev names devices, not trees.
    const args = buildBackupArgs(
      makeTask({ archives: [{ name: 'pool', path: '/gtbackup', excludes: [], includeNested: 'all' }] }),
      undefined,
      { pool: ['/gtbackup/cdm', '/gtbackup/cdm/inner'] },
    )
    assert.deepEqual(includeDevs(args), ['/gtbackup/cdm', '/gtbackup/cdm/inner'])
  })

  it('`all` with NO resolution (a failed scan) falls back to the client default', () => {
    const task = makeTask({ archives: [{ name: 'a', path: '/mnt/a', excludes: [], includeNested: 'all' }] })
    // No entry for 'a' at all — the run crosses nothing rather than guessing.
    assert.deepEqual(includeDevs(buildBackupArgs(task, undefined, {})), [])
    assert.ok(!buildBackupArgs(task, undefined, {}).includes('--all-file-systems'))
  })

  it('includeNested [paths] emits one --include-dev per path, deduped and sorted', () => {
    const args = buildBackupArgs(makeTask({
      archives: [
        { name: 'etc', path: '/etc', excludes: [], includeNested: ['/etc/pve'] },
        { name: 'pool', path: '/gtbackup', excludes: [], includeNested: ['/gtbackup/cdm', '/etc/pve'] },
      ],
    }))
    assert.deepEqual(includeDevs(args), ['/etc/pve', '/gtbackup/cdm'])
  })

  it('two archives, one `all` and one `none`: ONLY the first gets --include-dev flags', () => {
    // The whole point of resolving `all` per archive: 'b' must be untouched.
    const args = buildBackupArgs(
      makeTask({
        archives: [
          { name: 'a', path: '/mnt/a', excludes: [], includeNested: 'all' },
          { name: 'b', path: '/mnt/b', excludes: [] },
        ],
      }),
      undefined,
      { a: ['/mnt/a/child', '/mnt/a/child/deeper'], b: [] },
    )
    assert.deepEqual(includeDevs(args), ['/mnt/a/child', '/mnt/a/child/deeper'])
    // Nothing under 'b' is named, and no invocation-wide flag leaks onto it.
    assert.ok(!args.some(x => x.startsWith('/mnt/b/')))
    assert.ok(!args.includes('--all-file-systems'))
    // Both archives are still in the SAME invocation — that is why this matters.
    assert.ok(args.includes('a.pxar:/mnt/a') && args.includes('b.pxar:/mnt/b'))
  })

  it('probe argv is snapshot list [--ns] --output-format json', () => {
    assert.deepEqual(buildProbeArgs('anastest'), ['snapshot', 'list', '--ns', 'anastest', '--output-format', 'json'])
    assert.deepEqual(buildProbeArgs(), ['snapshot', 'list', '--output-format', 'json'])
  })

  it('normalizeFingerprint lowercases and strips a sha256 prefix', () => {
    assert.equal(normalizeFingerprint('SHA256:CC:B8:A0'), 'cc:b8:a0')
    assert.equal(normalizeFingerprint('  Cc:B8  '), 'cc:b8')
  })
})

describe('backup runner — STDERR progress parsing (NOTES §3, SURPRISE C)', () => {
  it('multi-archive: one per-archive stats line per archive (argv order)', () => {
    const p = parseBackupProgress(fixture('backup-multi-archive.txt'))
    // documents / pictures / music .pxar lines
    assert.equal(p.archiveStats.length, 3)
    assert.ok(p.archiveStats[0].startsWith('documents.pxar:'))
    assert.ok(p.archiveStats.some(l => l.startsWith('music.pxar:')))
    assert.ok(p.target && p.target.startsWith('Starting backup: [anastest]:host/multiarch/'))
    assert.equal(p.nofileWarning, null)
  })

  it('metadata re-run: captures the Change detection summary + mpxar/ppxar lines', () => {
    const p = parseBackupProgress(fixture('backup-change-detection-modes.txt'))
    assert.ok(p.changeDetectionSummary.some(l => l.startsWith('Change detection summary:')))
    assert.ok(p.changeDetectionSummary.some(l => l.includes('unchanged, reusable files')))
    // parsed by the filename token, not position: both mpxar and ppxar lines
    assert.ok(p.archiveStats.some(l => l.startsWith('cdm.mpxar:')))
    assert.ok(p.archiveStats.some(l => l.startsWith('cdm.ppxar:')))
  })

  it('metadata-mode low-fd warning is surfaced (metadata-only signal, NOTES §5)', () => {
    const p = parseBackupProgress(fixture('backup-fd-warning-stream.txt'))
    assert.ok(p.nofileWarning && p.nofileWarning.includes('resource limit for open file handles low: 1024'))
  })

  it('progressSummary joins the per-archive lines and flags the fd warning', () => {
    const p = parseBackupProgress(fixture('backup-fd-warning-stream.txt'))
    const s = progressSummary(p)
    assert.ok(s.includes('w.ppxar:') || s.includes('w.mpxar:'))
    assert.ok(s.includes('resource limit for open file handles low'))
  })

  // ---- backup2.2: the client's own `skipping mount point:` lines -----------

  it('parses the REAL `skipping mount point:` capture and attributes it to its archive', () => {
    // btrfs-nested-subvol.txt is the real backup2.1 capture: FOUR runs, three of
    // which print the line — for the live subvolume AND for the ro snapshot
    // (GT-54), and none for the `--all-file-systems` live run (GT-55).
    const p = parseBackupProgress(fixture('btrfs-nested-subvol.txt'))
    assert.equal(p.skipped.length, 2, JSON.stringify(p.skipped))
    assert.deepEqual(p.skipped[0], {
      archive: 'btr',
      root: '/mnt/gtbtrfs/snap1',
      relativePath: 'photos',
      path: '/mnt/gtbtrfs/snap1/photos',
    })
    // The SECOND run's line belongs to the SECOND archive — the `Upload
    // directory … as <name>` header is what attributes it.
    assert.equal(p.skipped[1].archive, 'btrlive')
    assert.equal(p.skipped[1].path, '/mnt/gtbtrfs/@data/photos')
  })

  it('a skip line with no preceding upload header keeps the relative path honestly', () => {
    const p = parseBackupProgress('skipping mount point: "photos"\n')
    assert.equal(p.skipped.length, 1)
    assert.equal(p.skipped[0].path, 'photos')
    assert.equal(p.skipped[0].archive, undefined)
  })

  it('the client skip lines are SECONDARY: ones our own walk already named are dropped', () => {
    const skipped = [
      { archive: 'etc', root: '/etc', relativePath: 'pve', path: '/etc/pve' },
      { archive: 'etc', root: '/etc', relativePath: 'late', path: '/etc/late' },
      // A duplicate of the first — one omission is one notice.
      { archive: 'etc', root: '/etc', relativePath: 'pve', path: '/etc/pve' },
    ]
    const lines = skippedNotices(skipped, [{
      archive: 'etc',
      path: '/etc',
      exists: true,
      includeNested: 'none' as const,
      truncated: false,
      warnings: [],
      nested: [{ path: '/etc/pve', relativePath: 'pve', kind: 'pmxcfs' as const, included: false }],
    }])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /\/etc\/late/)
    assert.match(lines[0], /empty directory/)
  })

  it('in SNAPSHOT mode the boundary is matched on the relative path (live-proof wave 2)', () => {
    // The client reads the transient snapshot, so its absolute path can never
    // equal the walk's live one. Live-proven on the stunt node: an AHR source
    // with includeNested `all`, whose nested subvolume was EXPANDED into
    // `ahrdata__photos` and fully backed up, still reported "stored as an empty
    // directory" on every run — the run sat at completed-with-warnings and the
    // notification at `warning` forever, until the 2026-08-28 ruling made it a
    // notice.
    const root = '/run/anas-ahr/lpahr.toplevel/@snapshots/anas-backup-lp-ahr-1787755676'
    const lines = skippedNotices(
      [{ archive: 'ahrdata', root, relativePath: 'photos', path: `${root}/photos` }],
      [{
        archive: 'ahrdata',
        path: '/mnt/anas-ahr/lpahr',
        exists: true,
        includeNested: 'all' as const,
        truncated: false,
        warnings: [],
        nested: [{ path: '/mnt/anas-ahr/lpahr/photos', relativePath: 'photos', kind: 'subvolume' as const, included: true }],
      }],
    )
    assert.deepEqual(lines, [])
  })

  it('a boundary the walk never named still notices in snapshot mode', () => {
    const root = '/gtbackup/cdm/.zfs/snapshot/anas-backup-t-1/tree'
    const lines = skippedNotices(
      [{ archive: 'cdm', root, relativePath: 'appeared-late', path: `${root}/appeared-late` }],
      [{
        archive: 'cdm',
        path: '/gtbackup/cdm/tree',
        exists: true,
        includeNested: 'all' as const,
        truncated: false,
        warnings: [],
        nested: [{ path: '/gtbackup/cdm/tree/photos', relativePath: 'photos', kind: 'subvolume' as const, included: true }],
      }],
    )
    assert.equal(lines.length, 1)
    assert.match(lines[0], /appeared-late/)
  })
})

describe('backup runner — result classification (NOTES §6, SURPRISE A/B)', () => {
  it('exit 0 → success', () => {
    assert.deepEqual(classifyBackupResult(0, fixture('backup-password-auth.txt')), { kind: 'success' })
  })

  it('too-soon 1-second collision is BENIGN (skipped, not a failure)', () => {
    const out = classifyBackupResult(255, 'Error: backup timestamp is older than last backup.')
    assert.equal(out.kind, 'too-soon')
  })

  it('owner-check refusal is a failure flagged owner (SURPRISE A)', () => {
    const out = classifyBackupResult(255, fixture('backup-token-auth.txt'))
    assert.equal(out.kind, 'failure')
    assert.equal((out as { owner?: boolean }).owner, true)
    // the client-safe detail carries the verbatim Error line, no secret
    assert.match((out as { detail: string }).detail, /backup owner check failed/)
  })

  it('a generic failure carries the verbatim Error line', () => {
    const out = classifyBackupResult(255, 'Error: no such datastore \'nosuchstore\'')
    assert.equal(out.kind, 'failure')
    assert.match((out as { detail: string }).detail, /no such datastore/)
  })
})

describe('backup runner — test verdicts from the REAL failure taxonomy fixture', () => {
  const cases = parseTaxonomyCases(fixture('backup-failure-taxonomy.txt'))
  const byNum = (n: number) => cases.find(c => c.title.startsWith(`${n}.`))!

  it('baseline (exit 0) → ok', () => {
    assert.equal(classifyTestVerdict(0, byNum(0).stderr).stage, 'ok')
  })

  it('unreachable / wrong-port / dns-fail → tcp (pbc collapses them)', () => {
    for (const n of [1, 2, 10])
      assert.equal(classifyTestVerdict(byNum(n).exit, byNum(n).stderr).stage, 'tcp', `case ${n}`)
  })

  it('bad fingerprint → tls-fingerprint', () => {
    assert.equal(classifyTestVerdict(byNum(3).exit, byNum(3).stderr).stage, 'tls-fingerprint')
  })

  it('wrong password → auth', () => {
    assert.equal(classifyTestVerdict(byNum(4).exit, byNum(4).stderr).stage, 'auth')
  })

  it('bad token secret + revoked token → auth (indistinguishable)', () => {
    assert.equal(classifyTestVerdict(byNum(5).exit, byNum(5).stderr).stage, 'auth')
    assert.equal(classifyTestVerdict(byNum(6).exit, byNum(6).stderr).stage, 'auth')
  })

  it('token no-permission → auth with a distinguishing detail (missing privileges)', () => {
    const v = classifyTestVerdict(byNum(7).exit, byNum(7).stderr)
    assert.equal(v.stage, 'auth')
    assert.match(v.detail ?? '', /missing the required Datastore privileges/)
  })

  it('nonexistent datastore → datastore', () => {
    assert.equal(classifyTestVerdict(byNum(8).exit, byNum(8).stderr).stage, 'datastore')
  })

  it('nonexistent namespace → namespace', () => {
    assert.equal(classifyTestVerdict(byNum(9).exit, byNum(9).stderr).stage, 'namespace')
  })
})
