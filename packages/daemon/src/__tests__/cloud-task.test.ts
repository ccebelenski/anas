import type { Requester, RunnerResponse } from '../cloud-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { exitCodeForResult, parseRunnerArgs, runCloudTask } from '../cloud-task.js'

/**
 * The cloud sync timer entrypoint (rclone.2) — the backup runner's twin on the
 * shared poll loop. What is proved here is the CONTRACT the unit depends on:
 * the endpoint it POSTs, the `direct:true` recursion guard, and the exit code
 * a deliberate off-week skip produces (the unit declares it as
 * `SuccessExitStatus=`, so getting it wrong turns a healthy skip into a failed
 * unit on the dashboard).
 */
describe('cloud-task runner (rclone.2 — timer entrypoint)', () => {
  describe('parseRunnerArgs', () => {
    it('parses --name and defaults the socket', () => {
      const opts = parseRunnerArgs(['--name', 'offsite'])
      assert.equal(opts.name, 'offsite')
      assert.equal(opts.socket, process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock')
    })

    it('accepts an explicit --socket', () => {
      assert.equal(parseRunnerArgs(['--name', 'x', '--socket', '/run/y.sock']).socket, '/run/y.sock')
    })

    it('throws on a missing --name, a value-less flag, and unknown flags', () => {
      assert.throws(() => parseRunnerArgs([]), /Missing required --name/)
      assert.throws(() => parseRunnerArgs(['--name']), /Missing value for --name/)
      assert.throws(() => parseRunnerArgs(['--bogus', 'x']), /Unknown argument: --bogus/)
    })
  })

  const noSleep = async (): Promise<void> => {}

  function scriptedRequester(script: { post: RunnerResponse, polls: RunnerResponse[] }): {
    requester: Requester
    calls: string[]
    bodies: unknown[]
  } {
    const calls: string[] = []
    const bodies: unknown[] = []
    let pollIdx = 0
    const requester: Requester = async (req) => {
      calls.push(`${req.method} ${req.path}`)
      if (req.method === 'POST') {
        bodies.push(req.body)
        return script.post
      }
      return script.polls[Math.min(pollIdx++, script.polls.length - 1)]
    }
    return { requester, calls, bodies }
  }

  it('POSTs the cloud run endpoint with direct:true, polls to completion', async () => {
    const { requester, calls, bodies } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [
        { statusCode: 200, body: { job: { id: 'j', status: 'running' } } },
        { statusCode: 200, body: { job: { id: 'j', status: 'completed', result: { status: 'success' } } } },
      ],
    })
    const job = await runCloudTask(requester, 'offsite', { sleep: noSleep, intervalMs: 0 })
    assert.equal(job.status, 'completed')
    assert.equal(calls[0], 'POST /v1/cloud/tasks/offsite/run')
    // The recursion guard: the unit's own execution must run rclone IN the
    // daemon, never make the daemon start this unit again.
    assert.deepEqual(bodies[0], { direct: true })
    assert.ok(calls.slice(1).every(c => c === 'GET /v1/jobs/j'))
  })

  it('url-encodes the task name', async () => {
    const { requester, calls } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [{ statusCode: 200, body: { job: { id: 'j', status: 'completed', result: {} } } }],
    })
    await runCloudTask(requester, 'a b', { sleep: noSleep })
    assert.equal(calls[0], 'POST /v1/cloud/tasks/a%20b/run')
  })

  it('returns a failed job (does not throw) when the sync fails', async () => {
    const { requester } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [{ statusCode: 200, body: { job: { id: 'j', status: 'failed', error: { code: 'JOB_FAILED', message: 'rclone sync failed (exit 7)' } } } }],
    })
    const job = await runCloudTask(requester, 'x', { sleep: noSleep })
    assert.equal(job.status, 'failed')
  })

  it('throws when the submit is refused, carrying the daemon sentence', async () => {
    const { requester } = scriptedRequester({
      post: { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'Cloud sync task \'x\' not found' } } },
      polls: [],
    })
    await assert.rejects(runCloudTask(requester, 'x', { sleep: noSleep }), /not found/)
  })

  describe('exitCodeForResult', () => {
    it('a deliberate off-week skip exits with the skip code the unit declares', () => {
      assert.equal(exitCodeForResult({ status: BACKUP_SKIPPED_OFF_WEEK }), BACKUP_SKIP_EXIT_CODE)
    })

    it('every other completed result exits 0', () => {
      assert.equal(exitCodeForResult({ status: 'success' }), 0)
      assert.equal(exitCodeForResult(undefined), 0)
      assert.equal(exitCodeForResult({}), 0)
    })
  })
})
