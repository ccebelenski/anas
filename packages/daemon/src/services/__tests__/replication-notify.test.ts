import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
import { formatElapsed, shouldNotifyUnattended, unattendedSeverity } from '../unattended-notify.js'

/**
 * Replication run notifications (story 9.4) — the failure-only gate, the
 * route/peer naming, and the body an operator reads instead of the run.
 */

const PERL = '/usr/bin/perl'
const LOCAL = { source: 'testpool/media', target: 'backuppool/media' }
const REMOTE = { ...LOCAL, location: { kind: 'peer' as const, name: 'node-b' } }

describe('replication notifications — the failure-only gate (9.4)', () => {
  it('a failure notifies; a completed replication stays silent', () => {
    assert.equal(shouldNotifyUnattended('failure'), true)
    assert.equal(shouldNotifyUnattended('success'), false)
    assert.equal(replicationNotifyOutcome({ ...LOCAL, error: 'Replication failed — recv: dataset busy' }), 'failure')
    assert.equal(replicationNotifyOutcome({ ...LOCAL, result: { mode: 'full', snapshot: 'anas-daily-x' } }), 'success')
  })

  it('severity is the routing signal PVE matches on', () => {
    assert.equal(unattendedSeverity('failure'), 'error')
    assert.equal(unattendedSeverity('success'), 'info')
  })

  it('the route names source → target, and the peer/remote when there is one', () => {
    assert.equal(replicationRouteLine(LOCAL), 'testpool/media → backuppool/media')
    assert.equal(replicationRouteLine(REMOTE), 'testpool/media → backuppool/media (peer \'node-b\')')
    assert.equal(replicationLocationLine(undefined), null)
    assert.equal(replicationLocationLine({ kind: 'local' }), null)
    assert.equal(replicationLocationLine({ kind: 'remote', name: 'offsite' }), 'remote \'offsite\'')
  })

  it('the title carries the whole route (the subject template renders it)', () => {
    assert.equal(
      replicationNotifyTitle(REMOTE, 'failure'),
      'replication testpool/media → backuppool/media (peer \'node-b\') FAILED',
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
      error: 'Replication failed — recv: cannot receive: destination has been modified since most recent snapshot',
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
    const body = buildReplicationNotifyBody({ ...LOCAL, error: 'Dataset \'testpool/media\' has no snapshots — create a snapshot first' })
    assert.match(body, /Source:\s+testpool\/media/)
    assert.match(body, /Target:\s+backuppool\/media/)
    assert.ok(!body.includes('Location:'), 'a same-node replication states no location')
    assert.ok(!body.includes('Snapshot:'), 'nothing is invented for a run that never got that far')
    assert.ok(body.includes('has no snapshots'))
  })

  it('a completed run\'s body names the mode and its incremental base, and no error', () => {
    const body = buildReplicationNotifyBody({
      ...LOCAL,
      result: { mode: 'incremental', snapshot: 'anas-daily-b', baseSnapshot: 'anas-daily-a' },
    })
    assert.match(body, /Result:\s+success/)
    assert.match(body, /Mode:\s+incremental \(from @anas-daily-a\)/)
    assert.ok(!body.includes('Error:'), 'a success body names no error')
  })
})

describe('replication notifications — emission (9.4)', () => {
  function mockPerl(exitCode = 0): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: exitCode ? 'no target' : '', exitCode } })
    return executor
  }

  it('a failed run emits `error` through the anas-replication template', async () => {
    const executor = mockPerl()
    await notifyReplicationRun(executor, { ...REMOTE, error: 'Replication failed — send: broken pipe' })
    assert.equal(executor.calls.length, 1)
    const call = executor.calls[0]
    assert.equal(call.command, PERL)
    assert.ok(call.args[1].includes(ANAS_REPLICATION_NOTIFY_TEMPLATE))
    assert.equal(call.args[2], 'error')
    assert.match(call.args[3], /replication testpool\/media → backuppool\/media \(peer 'node-b'\) FAILED/)
    assert.ok(call.args[4].includes('send: broken pipe'))
  })

  it('a successful run costs nothing at all — no exec', async () => {
    const executor = mockPerl()
    await notifyReplicationRun(executor, { ...LOCAL, result: { mode: 'full', snapshot: 'anas-daily-b' } })
    assert.deepEqual(executor.calls, [])
  })

  it('a delivery failure is swallowed — best-effort by contract', async () => {
    const executor = mockPerl(255)
    await assert.doesNotReject(notifyReplicationRun(executor, { ...LOCAL, error: 'boom' }))
  })
})
