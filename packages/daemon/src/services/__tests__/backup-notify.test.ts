import type { BackupRepo, BackupTask } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BackupTask as BackupTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  backupNotifyOutcome,
  backupNotifySeverity,
  backupNotifyTitle,
  backupTargetLine,
  buildBackupNotifyBody,
  formatElapsed,
  notifyBackupRun,
  shouldNotifyBackup,
} from '../backup-notify.js'
import { ANAS_BACKUP_NOTIFY_TEMPLATE } from '../pve-notify.js'

/**
 * Backup run notifications (story 16.12) — the mode gate, the outcome mapping,
 * and the body the operator actually reads instead of the cron mail.
 */

const PERL = '/usr/bin/perl'

function makeTask(over: Partial<BackupTask> = {}): BackupTask {
  return BackupTaskSchema.parse({
    name: 'nightly-etc',
    repository: 'pbs-main',
    backupId: 'anas-pve',
    archives: [{ name: 'etc', path: '/etc', excludes: [] }],
    changeDetectionMode: 'default',
    schedule: '*-*-* 02:00:00',
    enabled: true,
    ...over,
  })
}

const REPO: BackupRepo = {
  name: 'pbs-main',
  host: 'pbs.example',
  port: 8007,
  datastore: 'store1',
  authType: 'token',
  tokenId: 'root@pam!anas',
}

/** A real per-archive stats line (ground truth 16.1 — pbc prints it on stderr). */
const ARCHIVE_LINE = 'work.pxar: had to backup 419 GiB of 2.1 TiB (compressed 402 GiB) in 4321.10 s (average 166 MiB/s)'
const REUSE_LINE = 'work.pxar: reused 41 GiB from previous snapshot for work.pxar (8.9%)'

describe('backup notifications — the mode gate (16.12)', () => {
  it('the schema default is `always` — vzdump\'s own, and every pre-16.12 task reads back as one', () => {
    assert.equal(makeTask().notify, 'always')
  })

  it('always: success/warning/failure all notify; on-failure: only the ones that went wrong', () => {
    assert.equal(shouldNotifyBackup('always', 'success'), true)
    assert.equal(shouldNotifyBackup('always', 'warning'), true)
    assert.equal(shouldNotifyBackup('always', 'failure'), true)
    assert.equal(shouldNotifyBackup('on-failure', 'success'), false)
    assert.equal(shouldNotifyBackup('on-failure', 'warning'), true)
    assert.equal(shouldNotifyBackup('on-failure', 'failure'), true)
  })

  it('a deliberate off-week skip notifies in NEITHER mode (a non-event is a non-event)', () => {
    assert.equal(shouldNotifyBackup('always', 'skip'), false)
    assert.equal(shouldNotifyBackup('on-failure', 'skip'), false)
  })

  it('outcome: an error is a failure, warnings are a warning, a gated skip is a skip', () => {
    const task = makeTask()
    assert.equal(backupNotifyOutcome({ task, error: 'Error: boom' }), 'failure')
    assert.equal(backupNotifyOutcome({ task, result: { status: 'success', warnings: ['prune failed'] } }), 'warning')
    assert.equal(backupNotifyOutcome({ task, result: { status: 'skipped-off-week' } }), 'skip')
    assert.equal(backupNotifyOutcome({ task, result: { status: 'success' } }), 'success')
    // The BENIGN too-soon collision really ran and reported nothing wrong — it is
    // a success whose body says nothing needed backing up, not a silent skip.
    assert.equal(backupNotifyOutcome({ task, result: { status: 'skipped', reason: 'timestamp collision' } }), 'success')
  })

  it('severity is the routing signal PVE matches on', () => {
    assert.equal(backupNotifySeverity('success'), 'info')
    assert.equal(backupNotifySeverity('warning'), 'warning')
    assert.equal(backupNotifySeverity('failure'), 'error')
  })
})

describe('backup notifications — the body (16.12)', () => {
  it('a success body carries the target, the group, the per-archive lines and the duration', () => {
    const body = buildBackupNotifyBody({
      task: makeTask(),
      repo: REPO,
      namespace: 'anastest',
      result: {
        status: 'success',
        target: 'Starting backup: [anastest]:host/anas-pve/2026-08-17T02:00:00Z',
        archives: [ARCHIVE_LINE, REUSE_LINE],
        duration: 'Duration: 4321.10s',
      },
      elapsedMs: 4_400_000,
    })
    assert.match(body, /Task:\s+nightly-etc/)
    assert.match(body, /Repository:\s+pbs-main:store1 \/ anastest/)
    assert.match(body, /Backup ID:\s+host\/anas-pve/)
    assert.match(body, /Result:\s+success/)
    // pbc's OWN duration wins over the job's wall clock.
    assert.match(body, /Duration:\s+4321\.10s/)
    assert.ok(body.includes(ARCHIVE_LINE), 'the archive stats line rides the body verbatim')
    assert.ok(body.includes(REUSE_LINE), 'the reuse line rides the body verbatim')
    assert.ok(!body.includes('Error:'), 'a success body names no error')
  })

  it('a prune summary and the warnings ride a completed-with-warnings body', () => {
    const body = buildBackupNotifyBody({
      task: makeTask(),
      repo: REPO,
      result: {
        status: 'success',
        archives: [ARCHIVE_LINE],
        prune: {
          group: 'host/anas-pve',
          dryRun: false,
          kept: 2,
          removed: 1,
          protectedCount: 0,
          snapshots: [],
        },
        warnings: ['Backup succeeded, but the retention prune did not run: ENOENT'],
      },
    })
    assert.match(body, /Result:\s+completed with warnings/)
    assert.match(body, /Retention:\s+pruned host\/anas-pve: 2 kept, 1 removed/)
    assert.ok(body.includes('Backup succeeded, but the retention prune did not run: ENOENT'))
  })

  it('a failure body carries the error text verbatim', () => {
    const body = buildBackupNotifyBody({
      task: makeTask(),
      error: 'Error: permission check failed - missing Datastore.Backup',
      elapsedMs: 95_000,
    })
    assert.match(body, /Result:\s+FAILED/)
    assert.match(body, /Duration:\s+1m 35s \(job elapsed\)/)
    assert.ok(body.includes('Error: permission check failed - missing Datastore.Backup'))
  })

  it('a benign too-soon run says plainly that nothing was backed up, and why', () => {
    const body = buildBackupNotifyBody({
      task: makeTask(),
      repo: REPO,
      result: { status: 'skipped', archives: [], reason: 'snapshot timestamp collision (1-second resolution)' },
    })
    assert.match(body, /Result:\s+completed - nothing new to back up/)
    assert.match(body, /Archives:\s+none reported - snapshot timestamp collision/)
  })

  it('the target line falls back to the task\'s configured repo when none resolved', () => {
    assert.equal(backupTargetLine({ task: makeTask() }), 'pbs-main')
    assert.equal(backupTargetLine({ task: makeTask(), repo: REPO }), 'pbs-main:store1')
  })

  it('a PVE-named repo does not double its datastore (ground truth 2026-08-19)', () => {
    // A PVE-sourced repository is NAMED `pve:<datastore>`, so the old
    // unconditional append rendered `pve:store1:store1` in a real notification.
    const pveRepo: BackupRepo = { ...REPO, name: 'pve:store1' }
    assert.equal(
      backupTargetLine({ task: makeTask({ repository: 'pve:store1' }), repo: pveRepo }),
      'pve:store1',
    )
    assert.equal(
      backupTargetLine({ task: makeTask({ repository: 'pve:store1' }), repo: pveRepo, namespace: 'testing' }),
      'pve:store1 / testing',
    )
    // Exact suffix, not a contains: a name ending in a DIFFERENT datastore, or
    // merely containing this one, still gets the datastore spelled out.
    assert.equal(
      backupTargetLine({ task: makeTask(), repo: { ...REPO, name: 'pve:store2' } }),
      'pve:store2:store1',
    )
    assert.equal(
      backupTargetLine({ task: makeTask(), repo: { ...REPO, name: 'store1-mirror' } }),
      'store1-mirror:store1',
    )
  })

  it('the body ends on the facts — no closing pointer to the PBS UI', () => {
    const body = buildBackupNotifyBody({ task: makeTask(), repo: REPO, result: { status: 'success', archives: [ARCHIVE_LINE] } })
    assert.ok(!body.includes('PBS UI'), 'no editorial closing line')
    assert.match(body.trimEnd(), /Schedule:\s+\*-\*-\* 02:00:00$/)
  })

  it('every body and title is pure ASCII — the delivery pipeline mangles anything else', () => {
    // Ground truth 2026-08-19: an em-dash arrived as mojibake on a real gotify
    // target. Nothing we build may contain a character that can be mangled.
    const asciiOnly = /^[\x20-\x7E\n]*$/
    for (const ctx of [
      { task: makeTask(), repo: REPO, namespace: 'anastest', result: { status: 'success', archives: [ARCHIVE_LINE], duration: 'Duration: 4321.10s' } },
      { task: makeTask(), repo: REPO, result: { status: 'skipped', archives: [], reason: 'snapshot timestamp collision (1-second resolution)' } },
      { task: makeTask({ enabled: false }), repo: REPO, error: 'Error: permission check failed', elapsedMs: 1_000 },
    ]) {
      assert.match(buildBackupNotifyBody(ctx), asciiOnly)
      assert.match(backupNotifyTitle(ctx.task, backupNotifyOutcome(ctx)), asciiOnly)
    }
  })

  it('the title names the task and the outcome (the subject template renders it)', () => {
    const task = makeTask()
    assert.equal(backupNotifyTitle(task, 'success'), 'backup \'nightly-etc\' succeeded')
    assert.equal(backupNotifyTitle(task, 'warning'), 'backup \'nightly-etc\' completed with warnings')
    assert.equal(backupNotifyTitle(task, 'failure'), 'backup \'nightly-etc\' FAILED')
  })

  it('formatElapsed reads in units a human uses', () => {
    assert.equal(formatElapsed(4200), '4s')
    assert.equal(formatElapsed(95_000), '1m 35s')
    assert.equal(formatElapsed(7_265_000), '2h 1m 5s')
  })
})

describe('backup notifications — emission (16.12)', () => {
  function mockPerl(exitCode = 0): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: exitCode ? 'no target' : '', exitCode } })
    return executor
  }

  it('emits through the anas-backup template so matcher rules can target backups', async () => {
    const executor = mockPerl()
    await notifyBackupRun(executor, {
      task: makeTask(),
      repo: REPO,
      result: { status: 'success', archives: [ARCHIVE_LINE] },
    })
    assert.equal(executor.calls.length, 1)
    const call = executor.calls[0]
    assert.equal(call.command, PERL)
    assert.ok(call.args[1].includes(ANAS_BACKUP_NOTIFY_TEMPLATE))
    assert.equal(call.args[2], 'info')
    assert.equal(call.args[3], 'backup \'nightly-etc\' succeeded')
    assert.ok(call.args[4].includes(ARCHIVE_LINE))
  })

  it('an on-failure task costs a successful run nothing at all (no exec)', async () => {
    const executor = mockPerl()
    await notifyBackupRun(executor, {
      task: makeTask({ notify: 'on-failure' }),
      repo: REPO,
      result: { status: 'success', archives: [ARCHIVE_LINE] },
    })
    assert.deepEqual(executor.calls, [])
  })

  it('a delivery failure is swallowed — best-effort by contract', async () => {
    const executor = mockPerl(255)
    await assert.doesNotReject(notifyBackupRun(executor, {
      task: makeTask(),
      error: 'Error: connection refused',
    }))
  })
})
