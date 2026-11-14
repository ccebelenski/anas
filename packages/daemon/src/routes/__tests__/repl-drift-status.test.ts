import type { ReplicationTask, StatusSummary } from '@anas/shared'
import type { MockExecutor as MockExecutorType } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { replicationHoldTag } from '../../services/replication-holds.js'
import { buildReplicationWarnings, deriveTaskStatus, renderServiceUnit, serviceUnitName, timerUnitName } from '../../services/replication-units.js'
import { dashboardRoutes } from '../dashboard.js'

/**
 * repl.drift, the READ side: the task row carries the target's state
 * (`targetDrift`) so the panel and the dashboard show it without a run, and a
 * read sends NO notification — the alert comes from runs. The drift answers
 * are the captured `property\tvalue\tsource` rows with captured values
 * (`fixtures/zfs/zfs-written-replica.zfs2.4.2.txt`).
 */

const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const PERL = '/usr/bin/perl'
const SRC = 'testpool/media'
const TGT = 'backup/media'
const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': '11111111-1111-4111-8111-111111111111',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
}

function snapshotListJson(dataset: string, snaps: { name: string, txg: number }[]): string {
  const datasets: Record<string, unknown> = {}
  for (const s of snaps)
    datasets[`${dataset}@${s.name}`] = { name: `${dataset}@${s.name}`, type: 'SNAPSHOT', pool: dataset.split('/')[0], dataset, snapshot_name: s.name, createtxg: String(s.txg), properties: {} }
  return JSON.stringify({ datasets })
}

function makeTask(over: Partial<ReplicationTask> = {}): ReplicationTask {
  return {
    name: 'nightly-media',
    source: { pool: 'testpool', dataset: 'media' },
    target: { pool: 'backup', dataset: 'media' },
    schedule: 'daily',
    snapshotFirst: true,
    enabled: true,
    notify: 'on-failure',
    ...over,
  }
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const DRIFT_ARGS = ['get', '-Hp', '-o', 'property,value,source', 'written@s1,readonly', '--', TGT]

/** Source s1, s2; the target holds s1 (its base); systemd answers a successful last run. */
function world(drift: ExecResult | null, opts: { targetSnaps?: { name: string, txg: number }[], result?: string } = {}): MockExecutor {
  const m = new MockExecutor()
  m.clearFixtures()
  m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(SRC), result: ok(snapshotListJson(SRC, [{ name: 's1', txg: 1 }, { name: 's2', txg: 2 }])) })
  m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(TGT), result: ok(snapshotListJson(TGT, opts.targetSnaps ?? [{ name: 's1', txg: 1 }])) })
  if (drift)
    m.addFixture({ command: ZFS, args: DRIFT_ARGS, result: drift })
  const tag = replicationHoldTag(undefined, TGT)
  m.addFixture({ command: ZFS, args: ['holds', '-H', '--', `${SRC}@s1`], result: ok(`${SRC}@s1\t${tag}\tMon Jul 13 10:00 2026\n`) })
  m.addFixture({ command: ZFS, args: ['holds', '-H', '--', `${TGT}@s1`], result: ok(`${TGT}@s1\t${tag}\tMon Jul 13 10:00 2026\n`) })
  const stamp = 'Wed 2026-07-15 03:00:12 UTC'
  m.addFixture({ command: SYSTEMCTL, args: ['show', serviceUnitName('nightly-media'), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'], result: ok(`ActiveState=inactive\nResult=${opts.result ?? 'success'}\nExecMainStatus=0\nExecMainExitTimestamp=${stamp}\nInactiveEnterTimestamp=${stamp}\n`) })
  m.addFixture({ command: SYSTEMCTL, args: ['show', timerUnitName('nightly-media'), '-p', 'NextElapseUSecRealtime,LastTriggerUSec'], result: ok('NextElapseUSecRealtime=0\nLastTriggerUSec=\n') })
  return m
}

describe('repl.drift — the task status row', () => {
  it('clean: the state is carried, no sentence, and the read sent no notification', async () => {
    const m = world(ok('written@s1\t0\t-\nreadonly\ton\tlocal\n'))
    const st = await deriveTaskStatus(m, makeTask())
    assert.deepEqual(st.targetDrift, { state: 'clean', dataset: TGT, base: 's1', writtenBytes: 0, readonly: 'on' })
    assert.equal(st.snapshotsBehind, 1, 'the lag is unchanged')
    assert.deepEqual(m.calls.filter(c => c.command === PERL), [])
  })

  it('modified (the captured atime read, 12288): the sentence, the holds read, no notification', async () => {
    const m = world(ok('written@s1\t12288\t-\nreadonly\toff\tlocal\n'))
    const st = await deriveTaskStatus(m, makeTask())
    assert.equal(st.targetDrift?.state, 'modified')
    assert.equal(st.targetDrift?.writtenBytes, 12288)
    assert.match(st.targetDrift?.message ?? '', /^Target 'backup\/media' has been changed since '@s1': 12\.00 KiB written with no new snapshot/)
    assert.match(st.targetDrift?.message ?? '', /'@s1' stays held on both sides\.$/)
    assert.deepEqual(m.calls.filter(c => c.command === PERL), [])
  })

  it('exposed: nothing changed, not read-only', async () => {
    const st = await deriveTaskStatus(world(ok('written@s1\t0\t-\nreadonly\toff\tlocal\n')), makeTask())
    assert.equal(st.targetDrift?.state, 'exposed')
    assert.match(st.targetDrift?.message ?? '', /^Target 'backup\/media' is not read-only \(readonly=off, local\)/)
  })

  it('a read that failed is unknown, never clean', async () => {
    const st = await deriveTaskStatus(world({ stdout: '', stderr: 'cannot open \'backup/media\': I/O error', exitCode: 1 }), makeTask())
    assert.equal(st.targetDrift?.state, 'unknown')
    assert.equal(st.targetDrift?.message, 'Could not check whether target \'backup/media\' was changed since \'@s1\': cannot open \'backup/media\': I/O error')
  })

  it('no target yet, or nothing in common: no drift field (those have their own states)', async () => {
    const none = await deriveTaskStatus(world(null, { targetSnaps: [] }), makeTask())
    assert.equal(none.targetDrift, undefined)
    const stray = await deriveTaskStatus(world(null, { targetSnaps: [{ name: 'stray', txg: 1 }] }), makeTask())
    assert.equal(stray.targetDrift, undefined)
  })

  it('a remote target: the names newest first from the resolver, the read through the runner (the task list\'s ssh)', async () => {
    const m = world(null)
    const seen: string[][] = []
    const st = await deriveTaskStatus(m, makeTask({ target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } }), async () => ['s1'], async (_t, args) => {
      seen.push(args)
      return ok(args[0] === 'get' ? 'written@s1\t0\t-\nreadonly\toff\tlocal\n' : '')
    })
    assert.equal(st.targetDrift?.state, 'exposed')
    assert.match(st.targetDrift?.message ?? '', /^Target 'backup\/media' on remote 'nas1' is not read-only/)
    assert.deepEqual(seen, [DRIFT_ARGS])
  })

  it('a resolver that gives no order (a Set) leaves the field absent rather than guessing', async () => {
    const st = await deriveTaskStatus(world(null), makeTask({ target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } }), async () => new Set(['s1']))
    assert.equal(st.targetDrift, undefined)
    assert.equal(st.snapshotsBehind, 1)
  })
})

describe('repl.drift — the dashboard cards', () => {
  const base = { lastReplicatedSnapshot: 's1', lastReplicatedAt: null, snapshotsBehind: 0, nextRunAt: null } as const

  it('modified: a card naming the target and the base; a run that is up to date still completes, so it never says every run fails', () => {
    const cards = buildReplicationWarnings([{ ...base, task: makeTask(), lastRunResult: 'success', targetDrift: { state: 'modified', dataset: TGT, base: 's1', writtenBytes: 1, message: 'x' } }])
    assert.deepEqual(cards, [{ level: 'warning', category: 'replication', ref: 'nightly-media', message: 'Replication task \'nightly-media\': its target \'backup/media\' has been changed since \'@s1\'; replication into it stops until those changes are discarded — check the Replication view' }])
  })

  // Review N5: a target read live says nothing about WHY the last run failed.
  it('modified read live and a failed last run: both cards stand (the failure may have another reason)', () => {
    const cards = buildReplicationWarnings([{ ...base, task: makeTask(), lastRunResult: 'failure', targetDrift: { state: 'modified', dataset: TGT, base: 's1', writtenBytes: 1, message: 'x' } }])
    assert.deepEqual(cards.map(c => c.message), [
      'Replication task \'nightly-media\': its target \'backup/media\' has been changed since \'@s1\'; replication into it stops until those changes are discarded — check the Replication view',
      'Replication task \'nightly-media\' last run failed — check the Replication view',
    ])
  })

  it('modified as a failed run recorded it: ONE card naming that run\'s time, never "its last run"', () => {
    const cards = buildReplicationWarnings([{ ...base, task: makeTask(), lastRunResult: 'failure', targetDrift: { state: 'modified', dataset: TGT, base: 's1', asOf: '2026-11-14T03:00:12.000Z' } }])
    assert.deepEqual(cards.map(c => c.message), ['Replication task \'nightly-media\': its run at 2026-11-14 03:00 UTC found its target \'backup/media\' changed since \'@s1\'; replication into it stops until those changes are discarded — check the Replication view'])
  })

  it('exposed: its own card while the runs still succeed', () => {
    const cards = buildReplicationWarnings([{ ...base, task: makeTask(), lastRunResult: 'success', targetDrift: { state: 'exposed', dataset: TGT, base: 's1', writtenBytes: 0, readonly: 'off', message: 'x' } }])
    assert.deepEqual(cards, [{ level: 'warning', category: 'replication', ref: 'nightly-media', message: 'Replication task \'nightly-media\': its target \'backup/media\' is not read-only, and a write there, or a read with access-time updates on, stops the next send — check the Replication view' }])
  })

  it('clean adds nothing; a failed run of a clean target keeps today\'s card', () => {
    assert.deepEqual(buildReplicationWarnings([{ ...base, task: makeTask(), lastRunResult: 'success', targetDrift: { state: 'clean', dataset: TGT, base: 's1' } }]), [])
    assert.equal(buildReplicationWarnings([{ ...base, task: makeTask(), lastRunResult: 'failure', targetDrift: { state: 'clean', dataset: TGT, base: 's1' } }])[0].message, 'Replication task \'nightly-media\' last run failed — check the Replication view')
  })
})

describe('repl.drift — GET /v1/status reads the drift and notifies nothing', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repl-drift-dash-'))
    await mkdir(join(dir, 'systemd'), { recursive: true })
    await writeFile(join(dir, 'systemd', serviceUnitName('nightly-media')), renderServiceUnit(makeTask()))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function status(m: MockExecutor): Promise<StatusSummary> {
    m.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: ok('{"filesystems":[]}') })
    const srv = Fastify({ logger: false })
    await srv.register(dashboardRoutes, {
      prefix: '/v1',
      executor: m,
      jobQueue: new JobQueue(),
      diskIdentityCache: new DiskIdentityCache(m),
      smbConfPath: join(dir, 'smb.conf'),
      exportsPath: join(dir, 'exports'),
      systemdDir: join(dir, 'systemd'),
      fstabPath: join(dir, 'fstab'),
    })
    try {
      const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      return (res.json() as { data: StatusSummary }).data
    }
    finally {
      await srv.close()
    }
  }

  it('a changed target cards once, from the read, and no notification is sent (twice, the same)', async () => {
    const m = world(ok('written@s1\t14336\t-\nreadonly\ton\tlocal\n'))
    for (let i = 0; i < 2; i++) {
      const summary = await status(m)
      assert.deepEqual(summary.warnings.filter(w => w.category === 'replication').map(w => w.message), ['Replication task \'nightly-media\': its target \'backup/media\' has been changed since \'@s1\'; replication into it stops until those changes are discarded — check the Replication view'])
    }
    assert.deepEqual(m.calls.filter(c => c.command === PERL), [])
  })

  it('a target state that could not be read makes the section incomplete, never "fine"', async () => {
    const summary = await status(world({ stdout: '', stderr: 'boom', exitCode: 1 }))
    assert.equal(summary.warnings.filter(w => w.category === 'replication').length, 0)
    assert.ok(JSON.stringify(summary).includes('the target state of replication task \'nightly-media\' could not be read'), JSON.stringify(summary.unavailable ?? summary))
  })
})

/**
 * repl.drift, coordinator's decision (2026-11-15): the DASHBOARD never opens
 * an ssh connection for this. A target on this node is read live (a local
 * `zfs get`); a peer or remote target's card comes from what the task's LAST
 * RUN recorded (the runner's result line in the unit's journal carries
 * `targetDrift`), and says it is as of that run.
 */
describe('repl.drift — the dashboard and a peer/remote target', () => {
  const REMOTE_TASK = makeTask({ target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } })
  const EXIT = 'Sat 2026-11-14 03:00:12 UTC'
  const LINE_AT = '2026-11-14T03:00:12+0000'
  let dir: string
  const saved: Record<string, string | undefined> = {}
  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repl-drift-dash-r-'))
    await mkdir(join(dir, 'systemd'), { recursive: true })
    await writeFile(join(dir, 'systemd', serviceUnitName('nightly-media')), renderServiceUnit(REMOTE_TASK))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  /** Source s1, s2; systemd answers `result` with the exit stamp; the journal holds `journal`. */
  function remoteWorld(result: string, journal: string): MockExecutorType {
    const m = new MockExecutor()
    m.clearFixtures()
    m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(SRC), result: ok(snapshotListJson(SRC, [{ name: 's1', txg: 1 }, { name: 's2', txg: 2 }])) })
    m.addFixture({ command: SYSTEMCTL, args: ['show', serviceUnitName('nightly-media'), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'], result: ok(`ActiveState=${result === 'success' ? 'inactive' : 'failed'}\nResult=${result}\nExecMainStatus=${result === 'success' ? 0 : 1}\nExecMainExitTimestamp=${EXIT}\nInactiveEnterTimestamp=${EXIT}\n`) })
    m.addFixture({ command: SYSTEMCTL, args: ['show', timerUnitName('nightly-media'), '-p', 'NextElapseUSecRealtime,LastTriggerUSec'], result: ok('NextElapseUSecRealtime=0\nLastTriggerUSec=\n') })
    m.addFixture({ command: '/usr/bin/journalctl', result: ok(journal) })
    m.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: ok('{"filesystems":[]}') })
    return m
  }

  async function cards(m: MockExecutorType): Promise<string[]> {
    const srv = Fastify({ logger: false })
    await srv.register(dashboardRoutes, {
      prefix: '/v1',
      executor: m,
      jobQueue: new JobQueue(),
      diskIdentityCache: new DiskIdentityCache(m),
      smbConfPath: join(dir, 'smb.conf'),
      exportsPath: join(dir, 'exports'),
      systemdDir: join(dir, 'systemd'),
      fstabPath: join(dir, 'fstab'),
    })
    try {
      const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      return (res.json() as { data: StatusSummary }).data.warnings.filter(w => w.category === 'replication').map(w => w.message)
    }
    finally {
      await srv.close()
    }
  }

  const failLine = `${LINE_AT} pve anas-repl-nightly-media[910]: {"task":"testpool/media","result":{"status":"failure","targetDrift":[{"state":"modified","dataset":"backup/media","base":"s1"}]}}`

  it('GET /v1/status through the real server, with a REGISTERED remote task, makes zero ssh calls', async () => {
    const remotes = join(dir, 'remotes.json')
    await writeFile(remotes, JSON.stringify({ version: 1, updatedBy: 'root@pam', updatedAt: '2026-11-14T00:00:00.000Z', remotes: [{ name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }] }))
    setEnv('ANAS_REMOTES_FILE', remotes)
    setEnv('ANAS_SYSTEMD_DIR', join(dir, 'systemd'))
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    const server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutorType }).executor
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(SRC), result: ok(snapshotListJson(SRC, [{ name: 's1', txg: 1 }, { name: 's2', txg: 2 }])) })
    mock.addFixture({ command: '/usr/bin/ssh', result: ok('backup/media\n') })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
    }
    finally {
      await server.close()
    }
    assert.deepEqual(mock.calls.filter(c => c.command === '/usr/bin/ssh').map(c => c.args.join(' ')), [])
  })

  it('a remote target the last run found changed: ONE card, as of that run, and no ssh', async () => {
    const m = remoteWorld('exit-code', failLine)
    assert.deepEqual(await cards(m), ['Replication task \'nightly-media\': its run at 2026-11-14 03:00 UTC found its target \'backup/media\' changed since \'@s1\'; replication into it stops until those changes are discarded — check the Replication view'])
    assert.deepEqual(m.calls.filter(c => c.command === '/usr/bin/ssh'), [])
    assert.deepEqual(m.calls.filter(c => c.command === PERL), [])
  })

  it('a remote target the last run found not read-only (a run that succeeded): its own card, as of that run', async () => {
    const line = `${LINE_AT} pve anas-repl-nightly-media[910]: {"task":"testpool/media","result":{"snapshot":"s2","targetDrift":[{"state":"exposed","dataset":"backup/media","base":"s1"}]}}`
    assert.deepEqual(await cards(remoteWorld('success', line)), ['Replication task \'nightly-media\': its run at 2026-11-14 03:00 UTC found its target \'backup/media\' not read-only, and a write there, or a read with access-time updates on, stops the next send — check the Replication view'])
  })

  it('a drift recorded by an OLDER run than the last one is not the last run\'s word: only today\'s failure card', async () => {
    const older = failLine.replace(LINE_AT, '2026-11-13T03:00:12+0000')
    assert.deepEqual(await cards(remoteWorld('exit-code', older)), ['Replication task \'nightly-media\' last run failed — check the Replication view'])
  })

  it('a recorded state outside the vocabulary, or a dataset name ANAS does not accept, is ignored', async () => {
    const bad = failLine.replace('"modified"', '"gone"')
    assert.deepEqual(await cards(remoteWorld('exit-code', bad)), ['Replication task \'nightly-media\' last run failed — check the Replication view'])
    const badName = failLine.replace('"backup/media"', '"backup/<b>x"')
    assert.deepEqual(await cards(remoteWorld('exit-code', badName)), ['Replication task \'nightly-media\' last run failed — check the Replication view'])
  })
})
