import type { Requester, RunnerResponse } from '../snapshot-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRunnerArgs, runSnapshotSchedule } from '../snapshot-task.js'

describe('snapshot-task runner (Epic 17.4 — timer entrypoint)', () => {
  describe('parseRunnerArgs', () => {
    it('parses --id and defaults the socket', () => {
      const opts = parseRunnerArgs(['--id', 'nightly-tank-media'])
      assert.equal(opts.id, 'nightly-tank-media')
      assert.equal(opts.socket, process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock')
    })

    it('accepts an explicit --socket', () => {
      assert.equal(parseRunnerArgs(['--id', 'x', '--socket', '/run/y.sock']).socket, '/run/y.sock')
    })

    it('throws on a missing --id, a value-less flag, and unknown flags', () => {
      assert.throws(() => parseRunnerArgs([]), /Missing required --id/)
      assert.throws(() => parseRunnerArgs(['--id']), /Missing value for --id/)
      assert.throws(() => parseRunnerArgs(['--bogus', 'x']), /Unknown argument: --bogus/)
    })
  })

  const noSleep = async (): Promise<void> => {}

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

  it('POSTs the fire endpoint, polls to completion, returns the job', async () => {
    const { requester, calls } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [
        { statusCode: 200, body: { job: { id: 'j', status: 'running' } } },
        { statusCode: 200, body: { job: { id: 'j', status: 'completed', result: { taken: 'anas-daily-2026-07-26T000000Z' } } } },
      ],
    })
    const job = await runSnapshotSchedule(requester, 'nightly-tank-media', { sleep: noSleep, intervalMs: 0 })
    assert.equal(job.status, 'completed')
    assert.equal(calls[0], 'POST /v1/schedules/nightly-tank-media/run')
    assert.ok(calls.slice(1).every(c => c === 'GET /v1/jobs/j'))
  })

  it('returns a failed job (does not throw) when the fire fails', async () => {
    const { requester } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [{ statusCode: 200, body: { job: { id: 'j', status: 'failed', error: { code: 'JOB_FAILED', message: 'dataset gone' } } } }],
    })
    const job = await runSnapshotSchedule(requester, 'x', { sleep: noSleep })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, 'dataset gone')
  })

  it('throws when the submit is not 202', async () => {
    const requester: Requester = async () => ({ statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'schedule gone' } } })
    await assert.rejects(runSnapshotSchedule(requester, 'x', { sleep: noSleep }), /submit failed \(HTTP 404\): schedule gone/)
  })
})
