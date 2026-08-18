import type { BackupRepo, BackupTask } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildPruneArgs,
  classifyPruneVerdict,
  parsePruneOutput,
  pruneAfterBackup,
  pruneGroup,
  pruneSummaryLine,
  runPrune,
  summarizePrune,
} from '../backup-prune.js'

const PBC = '/usr/bin/proxmox-backup-client'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')

/** A prune fixture: the `$ command` line, the body, and `exit=N`. */
function pruneFixture(name: string): { argv: string, body: string, exit: number } {
  const text = readFileSync(join(FIXTURES, name), 'utf-8')
  const lines = text.split('\n')
  const argv = (lines[0] ?? '').replace(/^\$\s*/, '')
  const exitLine = lines.find(l => l.startsWith('exit='))
  const body = lines.slice(1).filter(l => !l.startsWith('exit=')).join('\n').trim()
  return { argv, body, exit: exitLine ? Number(exitLine.slice(5)) : Number.NaN }
}

function makeRepo(over: Partial<BackupRepo> = {}): BackupRepo {
  return {
    name: 'pbs-main',
    host: 'localhost',
    port: 8007,
    datastore: 'anastest-store',
    authType: 'password',
    username: 'root@pam',
    fingerprint: 'cc:b8:a0',
    ...over,
  }
}

function makeTask(over: Partial<BackupTask> = {}): BackupTask {
  return {
    name: 'nightly',
    repository: 'pbs-main',
    backupId: 'prune-gt2',
    archives: [{ name: 'data', path: '/root/prune-src', excludes: [] }],
    changeDetectionMode: 'default',
    notify: 'always',
    schedule: 'daily',
    enabled: true,
    limitNofile: 1024,
    ...over,
  }
}

/** Silence the journal sink in tests (the real one writes to journald). */
function QUIET(): void {}

describe('backup prune — argv assembly (16.11; the CLI is the API)', () => {
  it('group is host/<backup-id>', () => {
    assert.equal(pruneGroup('pictures'), 'host/pictures')
  })

  it('emits ONLY the configured keeps, --ns, and --output-format json', () => {
    assert.deepEqual(
      buildPruneArgs({ backupId: 'prune-gt2', namespace: 'anastest', retention: { keepLast: 2 } }),
      ['prune', 'host/prune-gt2', '--ns', 'anastest', '--keep-last', '2', '--output-format', 'json'],
    )
  })

  it('all five keeps ride in a stable order; --dry-run only when asked', () => {
    const args = buildPruneArgs({
      backupId: 'prune-gt2',
      retention: { keepLast: 1, keepDaily: 2, keepWeekly: 3, keepMonthly: 4, keepYearly: 5 },
      dryRun: true,
    })
    assert.deepEqual(args, [
      'prune',
      'host/prune-gt2',
      '--keep-last',
      '1',
      '--keep-daily',
      '2',
      '--keep-weekly',
      '3',
      '--keep-monthly',
      '4',
      '--keep-yearly',
      '5',
      '--dry-run',
      '--output-format',
      'json',
    ])
    // No namespace configured → no --ns (datastore root).
    assert.ok(!args.includes('--ns'))
  })

  it('the ground-truth invocation is reproduced token-for-token', () => {
    // Same command, same flag SET as the capture (pbc does not care about flag
    // ORDER, so we compare multisets rather than freeze the capture's ordering).
    const { argv } = pruneFixture('prune-output-format-json.txt')
    const captured = argv.split(' ').slice(1).sort()
    const built = buildPruneArgs({ backupId: 'prune-gt2', namespace: 'anastest', retention: { keepLast: 2 }, dryRun: true }).sort()
    assert.deepEqual(built, captured)
  })
})

describe('backup prune — JSON parsing (Principle 13: never the human table)', () => {
  const { body, exit } = pruneFixture('prune-output-format-json.txt')

  it('parses the real --output-format json array', () => {
    assert.equal(exit, 0)
    const snapshots = parsePruneOutput(body)
    assert.ok(snapshots)
    assert.equal(snapshots!.length, 7)
    assert.equal(snapshots![0].backupId, 'prune-gt2')
    assert.equal(snapshots![0].backupType, 'host')
    assert.equal(snapshots![0].namespace, 'anastest')
    assert.equal(snapshots![0].protected, false)
    assert.equal(snapshots![0].backupTime, 1750712754)
  })

  it('counts kept / removed / protected (keep-last 2 over a 7-snapshot group)', () => {
    const counts = summarizePrune(parsePruneOutput(body)!)
    assert.deepEqual(counts, { kept: 2, removed: 5, protectedCount: 0 })
  })

  it('the HUMAN table is never accepted as data (it parses to null)', () => {
    // The default (no --output-format) output is a box-drawing table — the
    // fixtures keep it to document the path we deliberately do not parse.
    assert.equal(parsePruneOutput(pruneFixture('prune-dry-run-keep-last.txt').body), null)
    assert.equal(parsePruneOutput(''), null)
    assert.equal(parsePruneOutput('{"not":"an array"}'), null)
  })
})

describe('backup prune — failure verdicts from the REAL fixtures', () => {
  it('missing GROUP and missing NAMESPACE are indistinguishable — say so', () => {
    for (const file of ['prune-missing-group.txt', 'prune-bad-namespace.txt']) {
      const { body, exit } = pruneFixture(file)
      assert.equal(exit, 255)
      const v = classifyPruneVerdict(exit, body)
      assert.equal(v.verdict, 'not-found', file)
      assert.match(v.detail, /group or the namespace/)
      // It must never claim to know WHICH one is missing.
      assert.ok(!/only the namespace|only the group/i.test(v.detail))
    }
  })

  it('a missing prune privilege names the privileges PBS wanted', () => {
    const { body, exit } = pruneFixture('prune-no-permission.txt')
    assert.equal(exit, 255)
    const v = classifyPruneVerdict(exit, body)
    assert.equal(v.verdict, 'permission')
    assert.match(v.detail, /Datastore\.Modify or Datastore\.Prune/)
  })

  it('anything else is a plain error carrying the verbatim Error line', () => {
    const v = classifyPruneVerdict(255, 'Error: unable to open chunk store')
    assert.equal(v.verdict, 'error')
    assert.match(v.detail, /unable to open chunk store/)
  })
})

describe('backup prune — runPrune (mocked executor)', () => {
  const { body } = pruneFixture('prune-output-format-json.txt')

  it('exit 0 → parsed result with counts, group and namespace', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: body, stderr: '', exitCode: 0 } })
    const out = await runPrune(mock, {
      repo: makeRepo(),
      secret: 's3cret',
      backupId: 'prune-gt2',
      namespace: 'anastest',
      retention: { keepLast: 2 },
    })
    assert.ok(out.ok)
    assert.equal(out.result.group, 'host/prune-gt2')
    assert.equal(out.result.namespace, 'anastest')
    assert.equal(out.result.dryRun, false)
    assert.equal(out.result.kept, 2)
    assert.equal(out.result.removed, 5)
    // The secret never reaches argv (env-only, exactly like the backup path).
    const call = mock.calls.find(c => c.command === PBC)!
    assert.ok(!call.args.some(a => a.includes('s3cret')))
  })

  it('exit 255 → the classified verdict, never a throw', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: '', stderr: 'Error: ENOENT: No such file or directory', exitCode: 255 } })
    const out = await runPrune(mock, {
      repo: makeRepo(),
      secret: 's',
      backupId: 'nope',
      retention: { keepDaily: 3 },
    })
    assert.equal(out.ok, false)
    assert.equal((out as { verdict: string }).verdict, 'not-found')
  })

  it('exit 0 with unparseable output → an honest error verdict (no invented counts)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: pruneFixture('prune-real-buckets.txt').body, stderr: '', exitCode: 0 } })
    const out = await runPrune(mock, { repo: makeRepo(), secret: 's', backupId: 'prune-gt2', retention: { keepLast: 1 } })
    assert.equal(out.ok, false)
    assert.match((out as { detail: string }).detail, /expected JSON snapshot list/)
  })

  it('summary line is journal-friendly and carries no secret', () => {
    const line = pruneSummaryLine({
      group: 'host/prune-gt2',
      namespace: 'anastest',
      dryRun: false,
      kept: 2,
      removed: 5,
      protectedCount: 1,
      snapshots: [],
    })
    assert.equal(line, 'pruned host/prune-gt2 [anastest]: 2 kept, 5 removed, 1 protected')
  })
})

describe('backup prune — pruneAfterBackup (the post-success step)', () => {
  const { body } = pruneFixture('prune-output-format-json.txt')

  it('NO retention → prune is never invoked at all (the default posture)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: body, stderr: '', exitCode: 0 } })
    const out = await pruneAfterBackup(mock, { task: makeTask(), repo: makeRepo(), secret: 's', log: QUIET })
    assert.deepEqual(out, {})
    assert.equal(mock.calls.length, 0)
  })

  it('an EMPTY retention object is still "no retention" — no keep-all no-op run', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: body, stderr: '', exitCode: 0 } })
    const out = await pruneAfterBackup(mock, { task: makeTask({ retention: {} }), repo: makeRepo(), secret: 's', log: QUIET })
    assert.deepEqual(out, {})
    assert.equal(mock.calls.length, 0)
  })

  it('with retention → prunes with EXACTLY the configured flags + json output', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: body, stderr: '', exitCode: 0 } })
    const out = await pruneAfterBackup(mock, {
      task: makeTask({ retention: { keepLast: 2 }, namespace: 'anastest' }),
      repo: makeRepo(),
      secret: 's',
      log: QUIET,
    })
    assert.deepEqual(mock.calls, [{
      command: PBC,
      args: ['prune', 'host/prune-gt2', '--ns', 'anastest', '--keep-last', '2', '--output-format', 'json'],
    }])
    assert.equal(out.prune!.kept, 2)
    assert.equal(out.prune!.removed, 5)
    assert.equal(out.warnings, undefined)
    // A real prune, never a dry run.
    assert.equal(out.prune!.dryRun, false)
    assert.ok(!mock.calls[0].args.includes('--dry-run'))
  })

  it('falls back to the REPO namespace when the task sets none (16.8 parity)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: body, stderr: '', exitCode: 0 } })
    await pruneAfterBackup(mock, {
      task: makeTask({ retention: { keepDaily: 7 } }),
      repo: makeRepo({ namespace: 'repo-ns' }),
      secret: 's',
      log: QUIET,
    })
    const args = mock.calls[0].args
    assert.equal(args[args.indexOf('--ns') + 1], 'repo-ns')
  })

  it('a FAILED prune becomes a warning — never a throw, never a failed job', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: PBC, result: { stdout: '', stderr: 'Error: permission check failed - missing Datastore.Modify|Datastore.Prune on /datastore/anastest-store/anastest', exitCode: 255 } })
    const out = await pruneAfterBackup(mock, {
      task: makeTask({ retention: { keepLast: 3 } }),
      repo: makeRepo(),
      secret: 's',
      log: QUIET,
    })
    assert.equal(out.prune, undefined)
    assert.equal(out.warnings!.length, 1)
    assert.match(out.warnings![0], /Backup succeeded/)
    assert.match(out.warnings![0], /Datastore\.Prune/)
  })
})
