import type { Requester, RunnerResponse } from '../replicate-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRunnerArgs, replicateBody, replicatePath, runReplication } from '../replicate-task.js'

describe('replicate-task runner (Epic 5.5.3)', () => {
  // --- arg parsing ---------------------------------------------------------
  describe('parseRunnerArgs', () => {
    it('parses a full argument set', () => {
      const opts = parseRunnerArgs(['--pool', 'testpool', '--dataset', 'media', '--target-pool', 'backup', '--target-dataset', 'archive/media', '--snapshot-first', '--socket', '/run/x.sock'])
      assert.deepEqual(opts, {
        pool: 'testpool',
        dataset: 'media',
        targetPool: 'backup',
        targetDataset: 'archive/media',
        snapshotFirst: true,
        socket: '/run/x.sock',
      })
    })

    it('accepts an empty --dataset (pool root) and defaults socket + snapshotFirst', () => {
      const opts = parseRunnerArgs(['--pool', 'testpool', '--dataset', '', '--target-pool', 'backup'])
      assert.equal(opts.dataset, '')
      assert.equal(opts.snapshotFirst, false)
      assert.equal(opts.targetDataset, undefined)
      assert.equal(opts.socket, process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock')
    })

    it('throws on a missing required flag', () => {
      assert.throws(() => parseRunnerArgs(['--dataset', 'media', '--target-pool', 'backup']), /Missing required --pool/)
      assert.throws(() => parseRunnerArgs(['--pool', 'p', '--dataset', 'd']), /Missing required --target-pool/)
    })

    it('throws on a value-less flag and on unknown flags', () => {
      assert.throws(() => parseRunnerArgs(['--pool']), /Missing value for --pool/)
      assert.throws(() => parseRunnerArgs(['--bogus', 'x']), /Unknown argument: --bogus/)
    })
  })

  // --- URL + body ----------------------------------------------------------
  it('replicatePath maps a dataset (and pool-root) to the stage-1 URL', () => {
    assert.equal(replicatePath('testpool', 'media'), '/v1/pools/testpool/datasets/media/replicate')
    assert.equal(replicatePath('testpool', ''), '/v1/pools/testpool/datasets/replicate')
  })

  it('replicateBody carries the target + snapshotFirst; omits empty target dataset', () => {
    assert.deepEqual(replicateBody({ pool: 'p', dataset: 'd', targetPool: 'backup', targetDataset: 'x', snapshotFirst: true, socket: 's' }), { target: { pool: 'backup', dataset: 'x' }, snapshotFirst: true })
    assert.deepEqual(replicateBody({ pool: 'p', dataset: 'd', targetPool: 'backup', snapshotFirst: false, socket: 's' }), { target: { pool: 'backup' }, snapshotFirst: false })
  })

  // --- stage-3 location args -----------------------------------------------
  it('parses --location-kind / --location-name (remote + peer)', () => {
    const remote = parseRunnerArgs(['--pool', 'p', '--dataset', 'd', '--target-pool', 'backup', '--location-kind', 'remote', '--location-name', 'nas1'])
    assert.equal(remote.locationKind, 'remote')
    assert.equal(remote.locationName, 'nas1')
    const peer = parseRunnerArgs(['--pool', 'p', '--dataset', 'd', '--target-pool', 'backup', '--location-kind', 'peer', '--location-name', 'node2'])
    assert.equal(peer.locationKind, 'peer')
    assert.equal(peer.locationName, 'node2')
  })

  it('throws when a non-local location kind has no name', () => {
    assert.throws(
      () => parseRunnerArgs(['--pool', 'p', '--dataset', 'd', '--target-pool', 'backup', '--location-kind', 'remote']),
      /Missing --location-name for --location-kind remote/,
    )
  })

  it('replicateBody carries target.location only for a non-local kind', () => {
    assert.deepEqual(
      replicateBody({ pool: 'p', dataset: 'd', targetPool: 'backup', locationKind: 'remote', locationName: 'nas1', snapshotFirst: false, socket: 's' }),
      { target: { pool: 'backup', location: { kind: 'remote', name: 'nas1' } }, snapshotFirst: false },
    )
    // 'local' (or absent) → no location key at all (full stage-1 compat).
    assert.deepEqual(
      replicateBody({ pool: 'p', dataset: 'd', targetPool: 'backup', locationKind: 'local', snapshotFirst: false, socket: 's' }),
      { target: { pool: 'backup' }, snapshotFirst: false },
    )
  })

  // --- run loop (mocked requester) -----------------------------------------
  const OPTS = { pool: 'testpool', dataset: 'media', targetPool: 'backup', snapshotFirst: true, socket: '/x' }
  const noSleep = async () => {}

  /** A requester that returns the given scripted responses in order per path. */
  function scriptedRequester(script: { post: RunnerResponse, polls: RunnerResponse[] }): { requester: Requester, calls: string[] } {
    const calls: string[] = []
    let pollIdx = 0
    const requester: Requester = async (req) => {
      calls.push(`${req.method} ${req.path}`)
      if (req.method === 'POST')
        return script.post
      return script.polls[Math.min(pollIdx++, script.polls.length - 1)]
    }
    return { requester, calls }
  }

  it('submits, polls past a running state, and returns the completed job', async () => {
    const jobId = 'job-1'
    const { requester, calls } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: jobId, status: 'queued' } } },
      polls: [
        { statusCode: 200, body: { job: { id: jobId, status: 'running' } } },
        { statusCode: 200, body: { job: { id: jobId, status: 'completed', result: { mode: 'incremental' } } } },
      ],
    })
    const job = await runReplication(requester, OPTS, { sleep: noSleep, intervalMs: 0 })
    assert.equal(job.status, 'completed')
    assert.deepEqual(job.result, { mode: 'incremental' })
    assert.equal(calls[0], 'POST /v1/pools/testpool/datasets/media/replicate')
    assert.ok(calls.slice(1).every(c => c === `GET /v1/jobs/${jobId}`))
  })

  it('returns a failed job (does not throw) when the job fails', async () => {
    const { requester } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [{ statusCode: 200, body: { job: { id: 'j', status: 'failed', error: { code: 'JOB_FAILED', message: 'diverged' } } } }],
    })
    const job = await runReplication(requester, OPTS, { sleep: noSleep })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, 'diverged')
  })

  it('throws when the submit is not 202', async () => {
    const requester: Requester = async () => ({ statusCode: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'no snapshots' } } })
    await assert.rejects(runReplication(requester, OPTS, { sleep: noSleep }), /submit failed \(HTTP 400\): no snapshots/)
  })

  it('throws when the poll never reaches a terminal state', async () => {
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } }
      return { statusCode: 200, body: { job: { id: 'j', status: 'running' } } }
    }
    await assert.rejects(runReplication(requester, OPTS, { sleep: noSleep, maxAttempts: 3 }), /did not reach a terminal state/)
  })
})
