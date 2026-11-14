import type { Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runnerOutput } from '../replicate-task.js'
import { lastRunFromJournal, newestHelperResult } from '../services/unit-run-status.js'

/**
 * repl.drift (coordinator's decision: the dashboard opens no ssh): what the
 * replication runner prints for journald. A failed run that recorded the
 * target it found changed prints a result line carrying it; everything else
 * is printed exactly as before.
 */

const OPTS = { pool: 'tank', dataset: 'data' }
function job(over: Partial<Job>): Job {
  return {
    id: 'j1',
    status: 'completed',
    operation: 'zfs.replicate',
    progress: null,
    createdAt: '2026-11-14T03:00:00.000Z',
    createdBy: 'root@pam',
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    ...over,
  } as Job
}

describe('repl.drift — the runner\'s journal record', () => {
  it('a completed job: the {task, result} line as before (the result carries targetDrift when the run recorded one)', () => {
    const result = { snapshot: 'Sn', targetDrift: [{ state: 'exposed', dataset: 'backup/data', base: 'S0' }] }
    assert.deepEqual(runnerOutput(job({ status: 'completed', result }), OPTS), { stdout: `${JSON.stringify({ task: 'tank/data', result })}\n` })
  })

  it('a failed job WITHOUT a recorded drift: stderr only, as before', () => {
    assert.deepEqual(runnerOutput(job({ status: 'failed', error: { code: 'JOB_FAILED', message: 'Replication failed — recv: boom' } }), OPTS), { stderr: 'Replication failed — recv: boom\n' })
  })

  it('a failed job that recorded a changed target: a failure result line carrying it, then the error on stderr', () => {
    const drift = [{ state: 'modified', dataset: 'backup/data', base: 'S0' }]
    const out = runnerOutput(job({ status: 'failed', error: { code: 'JOB_FAILED', message: 'Target ... changed' }, detail: { targetDrift: drift } }), OPTS)
    assert.equal(out.stdout, `${JSON.stringify({ task: 'tank/data', result: { status: 'failure', targetDrift: drift } })}\n`)
    assert.equal(out.stderr, 'Target ... changed\n')
    // The status readers see a FAILED run in it (never a success), with the record.
    const journal = `2026-11-14T03:00:12+0000 pve anas-repl-n[910]: ${out.stdout!.trim()}`
    assert.equal(lastRunFromJournal(journal)?.status, 'failure')
    assert.deepEqual(newestHelperResult(journal), { result: { status: 'failure', targetDrift: drift }, at: '2026-11-14T03:00:12.000Z' })
  })
})
