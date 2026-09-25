import type { Requester, RunnerResponse } from '../cloud-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK, TASK_CANCELLED_EXIT_CODE } from '@anas/shared'
import { exitCodeForResult, main, parseRunnerArgs, runCloudTask } from '../cloud-task.js'
import { cancelledRunnerExit } from '../runner-poll.js'

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

/**
 * rclone.5 — a run an operator cancelled. The runner polls the job to its
 * terminal state (`cancelled` is one), prints the result line — the journal is
 * where the status derivation reads "cancelled by <user> at <time>" back from —
 * and exits 130, which the derivation maps to `cancelled`, never failed.
 */
describe('cloud-task runner — a cancelled job (rclone.5)', () => {
  const CANCELLED = {
    id: 'j',
    status: 'cancelled',
    operation: 'cloud.task.run',
    result: { status: 'cancelled', reason: 'cancelled by alice@pve at 2026-09-25T14:02:11.000Z' },
    error: null,
  }

  it('the poll stops at `cancelled` (a terminal state)', async () => {
    let polls = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } }
      polls++
      return { statusCode: 200, body: { job: polls < 2 ? { id: 'j', status: 'running' } : CANCELLED } }
    }
    const job = await runCloudTask(requester, 'offsite', { sleep: async () => {}, intervalMs: 0 })
    assert.equal(job.status, 'cancelled')
    assert.equal(polls, 2)
  })

  it('main() exits 130 and prints the result line', async () => {
    const requester: Requester = async req => (req.method === 'POST'
      ? { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } }
      : { statusCode: 200, body: { job: CANCELLED } })
    const out: string[] = []
    const write = process.stdout.write
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    let code: number
    try {
      code = await main(['--name', 'offsite'], () => requester)
    }
    finally {
      process.stdout.write = write
    }
    assert.equal(code, TASK_CANCELLED_EXIT_CODE)
    assert.equal(code, 130)
    assert.deepEqual(JSON.parse(out.join('').trim()), { task: 'offsite', result: CANCELLED.result })
  })

  it('cancelledRunnerExit writes { task, result } and answers the cancel code', () => {
    const lines: string[] = []
    const code = cancelledRunnerExit(CANCELLED as never, 'offsite', l => lines.push(l))
    assert.equal(code, 130)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /"reason":"cancelled by alice@pve at 2026-09-25T14:02:11\.000Z"/)
  })
})
