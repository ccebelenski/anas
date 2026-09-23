import type { Job, JobAccepted, ReplicatePlan, Snapshot } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { PveFootprint } from '../../services/pve-footprint.js'
import type { Transport } from '../../services/replication-transport.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { zfsListArgs, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { loadPveFootprint } from '../../services/pve-footprint.js'
import { createReplicationHandlers } from '../replication.js'

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

  // --- ⚠ plan: a transient backup snapshot is NEVER an incremental base ----
  //
  // backup2.3's flagged risk, in situ. A snapshot-consistent backup run takes
  // `anas-backup-<task>-<ts>` on the source and destroys it in a `finally`. Here
  // it is the NEWEST snapshot common to both sides — exactly the shape the base
  // discovery reaches for — and adopting it would leave the next incremental
  // send pointing at a base that no longer exists.
  it('plan → the newest common snapshot IGNORES an anas-backup-* transient', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2', 'testpool2/share1']), stderr: '', exitCode: 0 } })
    // repl-base (oldest), the transient (NEWER than the base), repl-next (newest).
    mock.addFixture({
      command: ZFS,
      args: zfsSnapshotDetailArgs('testpool/share1'),
      result: {
        stdout: snapshotListJson('testpool/share1', [
          { name: 'repl-base', txg: 100 },
          { name: 'anas-backup-nightly-share1-1756000000', txg: 150 },
          { name: 'repl-next', txg: 200 },
        ]),
        stderr: '',
        exitCode: 0,
      },
    })
    // The target carries BOTH — so without the filter the transient wins.
    mock.addFixture({
      command: ZFS,
      args: zfsSnapshotDetailArgs('testpool2/share1'),
      result: {
        stdout: snapshotListJson('testpool2/share1', [
          { name: 'repl-base', txg: 100 },
          { name: 'anas-backup-nightly-share1-1756000000', txg: 150 },
        ]),
        stderr: '',
        exitCode: 0,
      },
    })
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
    assert.equal(data.baseSnapshot, 'repl-base', 'a transient must never become an incremental base')
    // And the dry run was estimated against that base, not the transient.
    assert.equal(data.estimatedBytes, 8411760)
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
  //  Run notifications (story 9.4) — the per-run mode, one emission point
  // ==========================================================================
  // A replication task's timer runner is a thin client of THIS endpoint, so the
  // replicate job is where both an unattended fire and a UI replicate converge —
  // one emission site. The endpoint knows nothing about tasks, so the MODE
  // arrives in the request body: absent → `on-failure` (a healthy replication
  // says nothing, 16.7's policy), `always` → the run mails its receipt too.

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

  /** Fixtures for a replication that actually completes (no diverged target). */
  function armSuccessfulRun(): MockExecutor {
    const mock = mockOf(server!)
    mock.clearFixtures()
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson(['testpool', 'testpool/share1']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: { stdout: zfsListJson(['testpool2']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/share1'), result: { stdout: snapshotListJson('testpool/share1', [{ name: 'repl-base', txg: 100 }]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', 'testpool/share1@repl-base'], result: { stdout: FULL_DRYRUN, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    return mock
  }

  async function replicateShare1(extra: Record<string, unknown> = {}): Promise<Job> {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' }, ...extra }),
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
    assert.match(sent[0].title, /replication testpool\/share1 -> testpool2\/share1 FAILED/)
    // The route, the snapshot the run had settled on, and the error verbatim.
    assert.match(sent[0].body, /Source:\s+testpool\/share1/)
    assert.match(sent[0].body, /Target:\s+testpool2\/share1/)
    assert.match(sent[0].body, /Snapshot:\s+testpool\/share1@repl-base/)
    assert.ok(sent[0].body.includes('has diverged'))
    assert.ok(sent[0].perl.includes('anas-replication'))
  })

  it('a SUCCESSFUL replication is silent when the request names no mode', async () => {
    // No `notify` in the body — the schema's `on-failure` applies, which is what
    // an interactive replicate and every pre-9.4 task runner send.
    server = createServer({ mock: true, logger: false })
    const mock = armSuccessfulRun()
    const job = await replicateShare1()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(notifications(mock), [])
  })

  it('`notify: always` in the body mails a SUCCESSFUL replication as `info`', async () => {
    // This is how a task whose stored mode is `always` reaches the endpoint: its
    // runner forwards the flag, and the run mails its own receipt.
    server = createServer({ mock: true, logger: false })
    const mock = armSuccessfulRun()
    const job = await replicateShare1({ notify: 'always' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'info')
    assert.match(sent[0].title, /replication testpool\/share1 -> testpool2\/share1 succeeded/)
    assert.match(sent[0].body, /Result:\s+success/)
    assert.match(sent[0].body, /Snapshot:\s+testpool\/share1@repl-base/)
    assert.match(sent[0].body, /Mode:\s+full/)
    assert.ok(sent[0].perl.includes('anas-replication'))
  })

  it('an invalid `notify` is rejected at the boundary → 400', async () => {
    server = createServer({ mock: true, logger: false })
    armSuccessfulRun()
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/share1/replicate',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool2' }, notify: 'sometimes' }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('a notification that cannot be delivered leaves the failed job exactly as it was', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = armDivergedRun(255) // perl runs, PVE has no target → non-zero exit
    const job = await replicateShare1()
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /diverged/)
    assert.equal(notifications(mock).length, 1)
  })

  // --- pvepool.1 review fixes: snapshotFirst + the run-time re-check ------
  //
  // `snapshotFirst: true` takes a NEW snapshot on the SOURCE before sending —
  // a mutation, so an OWNED source refuses 400 with the ownership reason.
  // Without the flag the run sends PVE's own EXISTING snapshots — a read —
  // and stays allowed. This endpoint IS the recurring task's run: its timer
  // runner (replicate-task.js) POSTs here with the unit's --snapshot-first
  // flag, so the guard re-asks ownership with the storage.cfg of THAT run —
  // a source PVE claimed after the task was written fails the later run.

  // A storage registered on the NESTED path testpool/share1 — the shape that
  // leaves everything above it unowned while owning the named dataset as a
  // storage root. It owns this file's fixture source outright.
  const CLAIM = 'zfspool: local-zfs\n\tpool testpool/share1\n\tcontent images,rootdir\n\n'

  /**
   * Point ANAS_STORAGE_CFG at a temp file holding `text` (or at an ABSENT
   * path when null — the fail-open posture). Returns the cfg path and a
   * restore thunk; the caller can REWRITE the file mid-test to model PVE
   * claiming a pool after the fact.
   */
  async function storageCfg(text: string | null): Promise<{ cfg: string, restore: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'anas-repl-pve-'))
    const prev = process.env.ANAS_STORAGE_CFG
    const cfg = join(dir, 'storage.cfg')
    if (text === null)
      process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    else
      await writeFile(cfg, text, 'utf8')
    process.env.ANAS_STORAGE_CFG = text === null ? join(dir, 'absent-storage.cfg') : cfg
    return {
      cfg,
      restore: async () => {
        if (prev === undefined)
          delete process.env.ANAS_STORAGE_CFG
        else
          process.env.ANAS_STORAGE_CFG = prev
        await rm(dir, { recursive: true, force: true })
      },
    }
  }

  it('snapshot-first onto an OWNED source is refused 400 with the ownership reason', async () => {
    server = createServer({ mock: true, logger: false })
    armSuccessfulRun()
    const { restore } = await storageCfg(CLAIM)
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/share1/replicate',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: { pool: 'testpool2' }, snapshotFirst: true }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.match(res.json().error.message, /snapshot-first replication would snapshot/i)
      assert.match(res.json().error.message, /local-zfs/)
      assert.match(res.json().error.message, /testpool\/share1/)
      assert.match(res.json().error.message, /storage root/)
    }
    finally {
      await restore()
    }
  })

  it('the SAME owned source WITHOUT snapshotFirst is a read of existing snapshots — allowed', async () => {
    server = createServer({ mock: true, logger: false })
    armSuccessfulRun()
    const { restore } = await storageCfg(CLAIM)
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/share1/replicate',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: { pool: 'testpool2' } }),
      })
      // No snapshotFirst → nothing is created on the source → the send of
      // PVE's existing snapshots is a read and passes the guard (202 job).
      assert.equal(res.statusCode, 202)
    }
    finally {
      await restore()
    }
  })

  it('a source PVE claimed AFTER a run fails the NEXT run (the timer re-check)', async () => {
    server = createServer({ mock: true, logger: false })
    armSuccessfulRun()
    // The task's world at creation/first-run time: storage.cfg does not claim
    // testpool (absent on this node — fail-open, the pvepool.1 posture). The
    // run is ACCEPTED (the guard let it through; the job itself cannot finish
    // in mock — the just-taken snapshot is not in the static fixture list —
    // but that is downstream of the boundary under test here).
    const { cfg, restore } = await storageCfg(null)
    try {
      const first = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/share1/replicate',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: { pool: 'testpool2' }, snapshotFirst: true }),
      })
      assert.equal(first.statusCode, 202)

      // PVE claims testpool/share1 (the storage in CLAIM) — the fixture
      // storage.cfg is written AFTER the first run. The timer's next run
      // POSTs the same endpoint (replicate-task.js), and the guard must
      // refuse the mutation with the reason, not send.
      await writeFile(cfg, CLAIM, 'utf8')
      process.env.ANAS_STORAGE_CFG = cfg
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/share1/replicate',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: { pool: 'testpool2' }, snapshotFirst: true }),
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /local-zfs/)
      assert.match(res.json().error.message, /testpool\/share1/)
    }
    finally {
      await restore()
    }
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

// --- pvepool.1 review fixes 1 + 4: the gate is IN THE JOB -------------------
//
// The request-level 400 is the fast path (dialog feedback before a job
// exists). The snapshot is taken IN THE JOB, so the ownership gate is IN
// THE JOB: the handler re-asks with a FRESH footprint immediately before
// `zfs snapshot` (the fireSchedule pattern). A source PVE claims between the
// request and the snapshot step fails the JOB — the 9.4 failure notification
// carries the reason — and no `zfs snapshot` is ever issued. The REQUEST
// itself loads the footprint exactly ONCE: the pre-job check and the target
// guard share the same load (fix 4); the job's load is the deliberate fresh
// one.
//
// The seam is unit-level: a route test cannot deterministically place a
// storage.cfg change between the pre-job and the in-job loads (the queue runs
// the handler to its first await during the request), but a gated footprint
// loader can — hold it between the two loads and the load count at that
// moment is exactly what the request path asked for.

describe('snapshotFirst ownership — the in-job re-check (review fixes 1 + 4)', () => {
  const PERL = '/usr/bin/perl'

  /** A real footprint from a temp storage.cfg (null = an ABSENT path, fail-open). */
  async function footprintFor(cfgText: string | null): Promise<PveFootprint> {
    const dir = await mkdtemp(join(tmpdir(), 'anas-repl-injob-'))
    const cfg = join(dir, 'storage.cfg')
    if (cfgText !== null)
      await writeFile(cfg, cfgText, 'utf8')
    try {
      return await loadPveFootprint(new MockExecutor(), {
        pveStorageCfg: cfgText === null ? join(dir, 'absent.cfg') : cfg,
      })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function jobWhen(queue: JobQueue, id: string): Promise<Job> {
    for (let i = 0; i < 100; i++) {
      const job = queue.get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Job ${id} did not finish`)
  }

  it('an owned-at-snapshot-time source fails the job with the reason; no snapshot is taken', async () => {
    const unowned = await footprintFor(null)
    const owned = await footprintFor('zfspool: local-zfs\n\tpool testpool/share1\n\tcontent images,rootdir\n\n')
    assert.equal(owned.ownershipOf('testpool/share1')?.kind, 'storage-root')

    let loads = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pveFootprint = async (): Promise<PveFootprint> => {
      loads++
      if (loads > 1)
        await gate // hold the JOB on its fresh load until the request is done
      return loads === 1 ? unowned : owned
    }

    const mock = new MockExecutor()
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })
    const queue = new JobQueue()
    const handlers = createReplicationHandlers({
      executor: mock,
      jobQueue: queue,
      resolveDatasetName: () => 'testpool/share1',
      poolExists: async () => true,
      datasetExists: async () => true,
      listSnapshotsDetail: async () => [{ snapshotName: 'repl-base' } as Snapshot],
      pveFootprint,
      transport: {} as Transport, // a local target never touches the transport
    })

    let replyCode = 0
    const request = {
      headers: {
        'x-anas-user': 'root@pam',
        'x-anas-user-uid': '0',
        'x-anas-request-id': randomUUID(),
      },
      body: { target: { pool: 'testpool2' }, snapshotFirst: true },
    } as unknown as FastifyRequest
    const reply = {
      code(c: number) {
        replyCode = c
        return this
      },
      send() {
        return this
      },
    } as unknown as FastifyReply

    const returned = await handlers.runReplication('testpool', 'share1', request, reply)
    assert.equal(replyCode, 202) // accepted — the pre-job footprint did not own the source
    const ref = (returned as { job: { id: string } }).job

    // The request path loaded the footprint EXACTLY ONCE — the pre-job check
    // and the target guard shared it (fix 4). The second load is the job's
    // fresh in-job load, suspended on the gate; had the guard loaded its own,
    // the count would be three.
    assert.equal(loads, 2)

    // PVE claims the source NOW — between the request and the snapshot step.
    release()
    const job = await jobWhen(queue, ref.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /is PVE-owned/)
    assert.match(job.error!.message, /local-zfs/)
    // The gate fired BEFORE the snapshot — nothing was taken on the source.
    assert.ok(!mock.calls.some(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'snapshot'))
    // ...and the 9.4 failure notification carries the reason.
    const sent = mock.calls
      .filter(c => c.command === PERL)
      .map(c => ({ severity: c.args[2], body: c.args[4] }))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'error')
    assert.match(sent[0].body, /is PVE-owned/)
  })
})
