import type { Requester, RunnerResponse } from '../backup-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { exitCodeForResult, parseRunnerArgs, runBackupTask } from '../backup-task.js'

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
