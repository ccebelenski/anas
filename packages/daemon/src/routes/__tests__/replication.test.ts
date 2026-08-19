import type { Job, JobAccepted, ReplicatePlan } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { zfsListArgs, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

// --- Fixture builders ------------------------------------------------------

/** Minimal `zpool list -j` JSON for a set of pool names. */
function zpoolListJson(names: string[]): string {
  const pools: Record<string, unknown> = {}
  for (const name of names)
    pools[name] = { name, state: 'ONLINE', properties: {} }
  return JSON.stringify({ pools })
}

/** Minimal `zfs list -j` (filesystem) JSON for a set of dataset full names. */
function zfsListJson(names: string[]): string {
  const datasets: Record<string, unknown> = {}
  for (const name of names)
    datasets[name] = { name, type: 'FILESYSTEM', pool: name.split('/')[0], properties: {} }
  return JSON.stringify({ datasets })
}

/** Minimal `zfs list -t snapshot -j` JSON. `txg` orders them (higher = newer). */
function snapshotListJson(dataset: string, snaps: { name: string, txg: number }[]): string {
  const datasets: Record<string, unknown> = {}
  for (const s of snaps) {
    const full = `${dataset}@${s.name}`
    datasets[full] = {
      name: full,
      type: 'SNAPSHOT',
      pool: dataset.split('/')[0],
      dataset,
      snapshot_name: s.name,
      createtxg: String(s.txg),
      properties: {},
    }
  }
  return JSON.stringify({ datasets })
}

/** Ground-truthed `zfs send -nvP` dry-run outputs (verified on a real node). */
const FULL_DRYRUN = 'full\ttestpool/share1@repl-base\t13424\nsize\t13424\n'
const INCR_DRYRUN = 'incremental\ttestpool/share1@repl-base\ttestpool/share1@repl-next\t8411760\nsize\t8411760\n'

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

describe('replication routes (Epic 5.5.1 — local zfs send | zfs recv)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- plan: full (no target) --------------------------------------------
  it('plan → full send when the target dataset does not exist', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', 'testpool/share1@repl-base'], result: { stdout: FULL_DRYRUN, stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate/plan',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: ReplicatePlan }
    assert.equal(data.mode, 'full')
    assert.equal(data.snapshot, 'repl-base')
    assert.equal(data.baseSnapshot, undefined)
    assert.equal(data.estimatedBytes, 13424)
    assert.equal(data.targetExists, false)
    assert.equal(data.targetDiverged, false)
  })

  // --- plan: incremental (common base) -----------------------------------
  it('plan → incremental when a common base snapshot exists on both sides', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2', 'testpool2/share1']), stderr: '', exitCode: 0 } })
    // source has repl-base (older) and repl-next (newer)
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }, { name: 'repl-next', txg: 200 }]), stderr: '', exitCode: 0 } })
    // target already has repl-base → the common base
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool2/share1'), result: { stdout: snapshotListJson('testpool2/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', '-i', '@repl-base', 'testpool/share1@repl-next'], result: { stdout: INCR_DRYRUN, stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate/plan',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: ReplicatePlan }
    assert.equal(data.mode, 'incremental')
    assert.equal(data.snapshot, 'repl-next')
    assert.equal(data.baseSnapshot, 'repl-base')
    assert.equal(data.estimatedBytes, 8411760)
    assert.equal(data.targetExists, true)
    assert.equal(data.targetDiverged, false)
  })

  // --- plan: diverged (target exists, no common snapshot) ----------------
  it('plan → targetDiverged when the target exists but shares no snapshot', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2', 'testpool2/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    // target has ONLY an unrelated snapshot → diverged
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool2/share1'), result: { stdout: snapshotListJson('testpool2/share1', [{ name: 'stranger', txg: 500 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', 'testpool/share1@repl-base'], result: { stdout: FULL_DRYRUN, stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate/plan',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: ReplicatePlan }
    assert.equal(data.mode, 'full')
    assert.equal(data.targetExists, true)
    assert.equal(data.targetDiverged, true)
    assert.equal(data.estimatedBytes, 13424)
  })

  // --- plan: no snapshots → 400 ------------------------------------------
  it('plan → 400 when the source has no snapshots', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate/plan',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /create a snapshot first/)
  })

  // --- plan: target pool absent → 400 ------------------------------------
  it('plan → 400 when the target pool does not exist', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate/plan',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'nopool' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /does not exist/)
  })

  // --- replicate: full happy path — exact send/recv argv -----------------
  it('replicate full → readonly recv, exact send|recv argv, holds after success', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', 'testpool/share1@repl-base'], result: { stdout: FULL_DRYRUN, stderr: '', exitCode: 0 } })
    // hold / holds / release fall through to the command-only zfs fallback:
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zfs.replicate')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { mode: string, snapshot: string, target: string, bytesEstimated: number }
    assert.equal(result.mode, 'full')
    assert.equal(result.snapshot, 'repl-base')
    assert.equal(result.target, 'testpool2/share1')
    assert.equal(result.bytesEstimated, 13424)

    // Exact send|recv argv: readonly=on only on the create (full send).
    assert.equal(mock.pipelineCalls.length, 1)
    assert.deepEqual(mock.pipelineCalls[0], {
      cmd1: ZFS,
      args1: ['send', 'testpool/share1@repl-base'],
      cmd2: ZFS,
      args2: ['recv', '-o', 'readonly=on', '--', 'testpool2/share1'],
    })

    // Holds placed on BOTH sides after success.
    const holds = mock.calls.filter(c => c.command === ZFS && c.args[0] === 'hold')
    assert.deepEqual(holds.map(h => h.args), [
      ['hold', 'anas-repl', 'testpool/share1@repl-base'],
      ['hold', 'anas-repl', 'testpool2/share1@repl-base'],
    ])
  })

  // --- replicate: incremental happy path — exact send/recv argv ----------
  it('replicate incremental → send -i @base, plain recv (no -o readonly)', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2', 'testpool2/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }, { name: 'repl-next', txg: 200 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool2/share1'), result: { stdout: snapshotListJson('testpool2/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', '-i', '@repl-base', 'testpool/share1@repl-next'], result: { stdout: INCR_DRYRUN, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { mode: string, snapshot: string, baseSnapshot: string, bytesEstimated: number }
    assert.equal(result.mode, 'incremental')
    assert.equal(result.snapshot, 'repl-next')
    assert.equal(result.baseSnapshot, 'repl-base')
    assert.equal(result.bytesEstimated, 8411760)

    assert.equal(mock.pipelineCalls.length, 1)
    assert.deepEqual(mock.pipelineCalls[0], {
      cmd1: ZFS,
      args1: ['send', '-i', '@repl-base', 'testpool/share1@repl-next'],
      cmd2: ZFS,
      args2: ['recv', '--', 'testpool2/share1'],
    })
  })

  // --- replicate: diverged → job fails, no pipeline ----------------------
  it('replicate → job fails when the target has diverged (no -F in stage 1)', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2', 'testpool2/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool2/share1'), result: { stdout: snapshotListJson('testpool2/share1', [{ name: 'stranger', txg: 500 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /diverged/)
    // No send|recv should have run.
    assert.equal(mock.pipelineCalls.length, 0)
  })

  // ==========================================================================
  //  Run notifications (story 9.4) — FAILURE ONLY, at the ONE emission point
  // ==========================================================================
  // A replication task's timer runner is a thin client of THIS endpoint, so the
  // replicate job is where both an unattended fire and a UI replicate converge —
  // one emission site. A healthy replication says nothing (16.7's policy).

  const PERL = '/usr/bin/perl'

  /** Every PVE notification the run emitted (template, severity, title, body). */
  function notifications(mock: MockExecutor): { perl: string, severity: string, title: string, body: string }[] {
    return mock.calls
      .filter(c => c.command === PERL)
      .map(c => ({ perl: c.args[1], severity: c.args[2], title: c.args[3], body: c.args[4] }))
  }

  /** The diverged-target setup (a real, unattended-visible failure) + perl. */
  function armDivergedRun(perlExit = 0): MockExecutor {
    const mock = mockOf(server!)
    mock.clearFixtures()
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: perlExit } })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2', 'testpool2/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool2/share1'), result: { stdout: snapshotListJson('testpool2/share1', [{ name: 'stranger', txg: 500 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    return mock
  }

  async function replicateShare1(): Promise<Job> {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(server!, (res.json() as JobAccepted).job.id)
  }

  it('a FAILED replication notifies `error` through the anas-replication template', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = armDivergedRun()
    const job = await replicateShare1()
    assert.equal(job.status, 'failed')
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'error')
    assert.match(sent[0].title, /replication testpool\/share1 → testpool2\/share1 FAILED/)
    // The route, the snapshot the run had settled on, and the error verbatim.
    assert.match(sent[0].body, /Source:\s+testpool\/share1/)
    assert.match(sent[0].body, /Target:\s+testpool2\/share1/)
    assert.match(sent[0].body, /Snapshot:\s+testpool\/share1@repl-base/)
    assert.ok(sent[0].body.includes('has diverged'))
    assert.ok(sent[0].perl.includes('anas-replication'))
  })

  it('a SUCCESSFUL replication is silent — healthy runs never mail', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', 'testpool/share1@repl-base'], result: { stdout: FULL_DRYRUN, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })

    const job = await replicateShare1()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(notifications(mock), [])
  })

  it('a notification that cannot be delivered leaves the failed job exactly as it was', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = armDivergedRun(255) // perl runs, PVE has no target → non-zero exit
    const job = await replicateShare1()
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /diverged/)
    assert.equal(notifications(mock).length, 1)
  })

  // --- replicate: unauthenticated ----------------------------------------
  it('replicate → 401 without identity headers', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' } }),
    })
    assert.equal(res.statusCode, 401)
  })
})
