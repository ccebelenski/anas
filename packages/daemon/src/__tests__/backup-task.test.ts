import type { Requester, RunnerResponse } from '../backup-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK, TASK_CANCELLED_EXIT_CODE } from '@anas/shared'
import { exitCodeForResult, main, parseRunnerArgs, runBackupTask } from '../backup-task.js'
import { cancelledRunnerExit } from '../runner-poll.js'

describe('backup-task runner (Epic 16 — timer entrypoint)', () => {
  describe('parseRunnerArgs', () => {
    it('parses --name and defaults the socket', () => {
      const opts = parseRunnerArgs(['--name', 'nightly-etc'])
      assert.equal(opts.name, 'nightly-etc')
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

  it('POSTs the run endpoint, polls to completion, returns the job', async () => {
    const { requester, calls } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [
        { statusCode: 200, body: { job: { id: 'j', status: 'running' } } },
        { statusCode: 200, body: { job: { id: 'j', status: 'completed', result: { status: 'success' } } } },
      ],
    })
    const job = await runBackupTask(requester, 'nightly-etc', { sleep: noSleep, intervalMs: 0 })
    assert.equal(job.status, 'completed')
    assert.equal(calls[0], 'POST /v1/backup/tasks/nightly-etc/run')
    assert.ok(calls.slice(1).every(c => c === 'GET /v1/jobs/j'))
  })

  it('returns a failed job (does not throw) when the backup fails', async () => {
    const { requester } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [{ statusCode: 200, body: { job: { id: 'j', status: 'failed', error: { code: 'JOB_FAILED', message: 'no such datastore' } } } }],
    })
    const job = await runBackupTask(requester, 'x', { sleep: noSleep })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, 'no such datastore')
  })

  it('throws when the submit is not 202', async () => {
    const requester: Requester = async () => ({ statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'task gone' } } })
    await assert.rejects(runBackupTask(requester, 'x', { sleep: noSleep }), /submit failed \(HTTP 404\): task gone/)
  })

  it('a deliberate off-week skip exits with the declared skip status, not 0 (16.10)', () => {
    // The unit declares SuccessExitStatus=<code>, so systemd still calls the run a
    // success — the code is what tells the status derivation nothing was backed up.
    assert.equal(exitCodeForResult({ status: BACKUP_SKIPPED_OFF_WEEK }), BACKUP_SKIP_EXIT_CODE)
    assert.equal(exitCodeForResult({ status: 'success' }), 0)
    assert.equal(exitCodeForResult({ status: 'skipped' }), 0) // the benign too-soon collision
    assert.equal(exitCodeForResult(undefined), 0)
  })

  it('encodes the task name in the run URL', async () => {
    const { requester, calls } = scriptedRequester({
      post: { statusCode: 202, body: { job: { id: 'j', status: 'queued' } } },
      polls: [{ statusCode: 200, body: { job: { id: 'j', status: 'completed' } } }],
    })
    await runBackupTask(requester, 'a-b-c', { sleep: noSleep })
    assert.equal(calls[0], 'POST /v1/backup/tasks/a-b-c/run')
  })
})

/**
 * rclone.5 — a run an operator cancelled. The runner polls the job to its
 * terminal state (`cancelled` is one), prints the result line — the journal is
 * where the status derivation reads "cancelled by <user> at <time>" back from —
 * and exits 130, which the derivation maps to `cancelled`, never failed.
 */
describe('backup-task runner — a cancelled job (rclone.5)', () => {
  const CANCELLED = {
    id: 'j',
    status: 'cancelled',
    operation: 'backup.task.run',
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
    const job = await runBackupTask(requester, 'nightly-etc', { sleep: async () => {}, intervalMs: 0 })
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
      code = await main(['--name', 'nightly-etc'], () => requester)
    }
    finally {
      process.stdout.write = write
    }
    assert.equal(code, TASK_CANCELLED_EXIT_CODE)
    assert.equal(code, 130)
    assert.deepEqual(JSON.parse(out.join('').trim()), { task: 'nightly-etc', result: CANCELLED.result })
  })

  it('cancelledRunnerExit writes { task, result } and answers the cancel code', () => {
    const lines: string[] = []
    const code = cancelledRunnerExit(CANCELLED as never, 'nightly-etc', l => lines.push(l))
    assert.equal(code, 130)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /"reason":"cancelled by alice@pve at 2026-09-25T14:02:11\.000Z"/)
  })
})
