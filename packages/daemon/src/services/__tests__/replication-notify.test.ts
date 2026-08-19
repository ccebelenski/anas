import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ReplicateRequest, ReplicationTask } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { ANAS_REPLICATION_NOTIFY_TEMPLATE } from '../pve-notify.js'
import {
  buildReplicationNotifyBody,
  notifyReplicationRun,
  replicationLocationLine,
  replicationNotifyOutcome,
  replicationNotifyTitle,
  replicationRouteLine,
} from '../replication-notify.js'
import { formatElapsed, notifySeverity, shouldNotify } from '../unattended-notify.js'

/**
 * Replication run notifications (story 9.4, extended to FULL backup parity
 * 2026-08-19) — the per-run mode gate, the route/peer naming, and the body an
 * operator reads instead of the run.
 */

const PERL = '/usr/bin/perl'
/** Every notification string we build must survive the PVE→delivery pipeline. */
const ASCII_ONLY = /^[\x20-\x7E\n]*$/
const LOCAL = { source: 'testpool/media', target: 'backuppool/media', notify: 'on-failure' as const }
const REMOTE = { ...LOCAL, location: { kind: 'peer' as const, name: 'node-b' } }
const OK_RESULT = { mode: 'full' as const, snapshot: 'anas-daily-b' }
const WARN_RESULT = {
  ...OK_RESULT,
  warnings: ['Could not place anas-repl hold on backuppool/media@anas-daily-b: permission denied'],
}

describe('replication notifications — the mode gate (9.4)', () => {
  it('the full matrix: both modes x all four outcomes', () => {
    assert.equal(shouldNotify('always', 'success'), true)
    assert.equal(shouldNotify('always', 'warning'), true)
    assert.equal(shouldNotify('always', 'failure'), true)
    assert.equal(shouldNotify('always', 'skip'), false)
    assert.equal(shouldNotify('on-failure', 'success'), false)
    assert.equal(shouldNotify('on-failure', 'warning'), true)
    assert.equal(shouldNotify('on-failure', 'failure'), true)
    assert.equal(shouldNotify('on-failure', 'skip'), false)
  })

  it('outcome: error = failure, hold/release warnings = warning, clean = success', () => {
    assert.equal(replicationNotifyOutcome({ ...LOCAL, error: 'recv: dataset busy' }), 'failure')
    assert.equal(replicationNotifyOutcome({ ...LOCAL, result: WARN_RESULT }), 'warning')
    assert.equal(replicationNotifyOutcome({ ...LOCAL, result: OK_RESULT }), 'success')
  })

  it('severity is the routing signal PVE matches on', () => {
    assert.equal(notifySeverity('failure'), 'error')
    assert.equal(notifySeverity('warning'), 'warning')
    assert.equal(notifySeverity('success'), 'info')
  })

  it('a replicate request with no `notify` defaults to the QUIET mode', () => {
    // Version skew both ways: an interactive UI replicate and the pre-9.4 task
    // runner both send no `notify`, and neither may error or start mailing.
    assert.equal(ReplicateRequest.parse({ target: { pool: 'backuppool' } }).notify, 'on-failure')
    assert.equal(ReplicateRequest.parse({ target: { pool: 'backuppool' }, notify: 'always' }).notify, 'always')
  })

  it('a task stored before the field existed reads back as on-failure', () => {
    const parsed = ReplicationTask.parse({
      name: 'legacy',
      source: { pool: 'testpool', dataset: 'media' },
      target: { pool: 'backuppool' },
      schedule: 'daily',
    })
    assert.equal(parsed.notify, 'on-failure')
  })

  it('the route names source -> target in ASCII, and the peer/remote when there is one', () => {
    assert.equal(replicationRouteLine(LOCAL), 'testpool/media -> backuppool/media')
    assert.equal(replicationRouteLine(REMOTE), 'testpool/media -> backuppool/media (peer \'node-b\')')
    assert.equal(replicationLocationLine(undefined), null)
    assert.equal(replicationLocationLine({ kind: 'local' }), null)
    assert.equal(replicationLocationLine({ kind: 'remote', name: 'offsite' }), 'remote \'offsite\'')
  })

  it('the title carries the whole route and the verdict', () => {
    assert.equal(
      replicationNotifyTitle(REMOTE, 'failure'),
      'replication testpool/media -> backuppool/media (peer \'node-b\') FAILED',
    )
    assert.equal(
      replicationNotifyTitle(LOCAL, 'warning'),
      'replication testpool/media -> backuppool/media completed with warnings',
    )
    assert.equal(
      replicationNotifyTitle(LOCAL, 'success'),
      'replication testpool/media -> backuppool/media succeeded',
    )
  })

  it('formatElapsed reads in units a human uses (shared with the backup body)', () => {
    assert.equal(formatElapsed(4200), '4s')
    assert.equal(formatElapsed(95_000), '1m 35s')
    assert.equal(formatElapsed(7_265_000), '2h 1m 5s')
  })
})

describe('replication notifications — the body (9.4)', () => {
  it('a failure body carries source, target, the peer, the snapshot and the error verbatim', () => {
    const body = buildReplicationNotifyBody({
      ...REMOTE,
      snapshot: 'anas-daily-2026-08-19T020000Z',
      error: 'Replication failed - recv: cannot receive: destination has been modified since most recent snapshot',
      elapsedMs: 7_265_000,
    })
    assert.match(body, /Source:\s+testpool\/media/)
    assert.match(body, /Target:\s+backuppool\/media/)
    assert.match(body, /Location:\s+peer 'node-b'/)
    assert.match(body, /Result:\s+FAILED/)
    assert.match(body, /Duration:\s+2h 1m 5s \(job elapsed\)/)
    assert.match(body, /Snapshot:\s+testpool\/media@anas-daily-2026-08-19T020000Z/)
    assert.ok(body.includes('cannot receive: destination has been modified since most recent snapshot'))
  })

  it('a local failure that died before resolving a snapshot still names the route', () => {
    const body = buildReplicationNotifyBody({ ...LOCAL, error: 'Dataset \'testpool/media\' has no snapshots' })
    assert.match(body, /Source:\s+testpool\/media/)
    assert.match(body, /Target:\s+backuppool\/media/)
    assert.ok(!body.includes('Location:'), 'a same-node replication states no location')
    assert.ok(!body.includes('Snapshot:'), 'nothing is invented for a run that never got that far')
    assert.ok(body.includes('has no snapshots'))
  })

  it('a SUCCESS body is a full receipt: route, snapshot, mode, base, duration', () => {
    const body = buildReplicationNotifyBody({
      ...REMOTE,
      result: { mode: 'incremental', snapshot: 'anas-daily-b', baseSnapshot: 'anas-daily-a' },
      elapsedMs: 95_000,
    })
    assert.match(body, /Source:\s+testpool\/media/)
    assert.match(body, /Target:\s+backuppool\/media/)
    assert.match(body, /Location:\s+peer 'node-b'/)
    assert.match(body, /Result:\s+success/)
    assert.match(body, /Duration:\s+1m 35s \(job elapsed\)/)
    assert.match(body, /Snapshot:\s+testpool\/media@anas-daily-b/)
    assert.match(body, /Mode:\s+incremental \(from @anas-daily-a\)/)
    assert.ok(!body.includes('Error:'), 'a success body names no error')
  })

  it('a WARNING body says so and lists the hold/release problems verbatim', () => {
    const body = buildReplicationNotifyBody({ ...LOCAL, result: WARN_RESULT })
    assert.match(body, /Result:\s+completed with warnings/)
    assert.ok(body.includes('Warnings:'))
    assert.ok(body.includes('Could not place anas-repl hold on backuppool/media@anas-daily-b'))
    assert.ok(!body.includes('Error:'), 'a warning is not a failure')
  })

  it('the body ends on the facts — no closing pointer to the UI', () => {
    const body = buildReplicationNotifyBody({ ...LOCAL, result: OK_RESULT })
    assert.ok(!body.includes('Replication view'), 'no editorial closing line')
    assert.match(body.trimEnd(), /Mode:\s+full$/)
  })

  it('every body and title is pure ASCII — the delivery pipeline mangles anything else', () => {
    for (const ctx of [
      { ...REMOTE, result: OK_RESULT, elapsedMs: 1_000 },
      { ...LOCAL, result: WARN_RESULT },
      { ...LOCAL, error: 'recv: dataset busy' },
    ]) {
      assert.match(buildReplicationNotifyBody(ctx), ASCII_ONLY)
      assert.match(replicationNotifyTitle(ctx, replicationNotifyOutcome(ctx)), ASCII_ONLY)
    }
  })
})

describe('replication notifications — emission (9.4)', () => {
  function mockPerl(exitCode = 0): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: exitCode ? 'no target' : '', exitCode } })
    return executor
  }

  it('a failed run emits `error` through the anas-replication template, in BOTH modes', async () => {
    for (const notify of ['on-failure', 'always'] as const) {
      const executor = mockPerl()
      await notifyReplicationRun(executor, { ...REMOTE, notify, error: 'Replication failed - send: broken pipe' })
      assert.equal(executor.calls.length, 1)
      const call = executor.calls[0]
      assert.equal(call.command, PERL)
      assert.ok(call.args[1].includes(ANAS_REPLICATION_NOTIFY_TEMPLATE))
      assert.equal(call.args[2], 'error')
      assert.match(call.args[3], /replication testpool\/media -> backuppool\/media \(peer 'node-b'\) FAILED/)
      assert.ok(call.args[4].includes('send: broken pipe'))
    }
  })

  it('an `always` run mails a good replication as `info`', async () => {
    const executor = mockPerl()
    await notifyReplicationRun(executor, { ...LOCAL, notify: 'always', result: OK_RESULT })
    assert.equal(executor.calls.length, 1)
    assert.equal(executor.calls[0].args[2], 'info')
    assert.match(executor.calls[0].args[3], /succeeded$/)
  })

  it('an `on-failure` run costs a good replication nothing at all — no exec', async () => {
    const executor = mockPerl()
    await notifyReplicationRun(executor, { ...LOCAL, result: OK_RESULT })
    assert.deepEqual(executor.calls, [])
  })

  it('a run with hold warnings mails `warning` even on `on-failure`', async () => {
    const executor = mockPerl()
    await notifyReplicationRun(executor, { ...LOCAL, result: WARN_RESULT })
    assert.equal(executor.calls.length, 1)
    assert.equal(executor.calls[0].args[2], 'warning')
    assert.match(executor.calls[0].args[3], /completed with warnings$/)
  })

  it('a delivery failure is swallowed — best-effort by contract', async () => {
    const executor = mockPerl(255)
    await assert.doesNotReject(notifyReplicationRun(executor, { ...LOCAL, error: 'boom' }))
  })
})
