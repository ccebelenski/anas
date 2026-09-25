import type { JobRef } from '@anas/shared'
import type { Requester, RunnerResponse } from '../runner-poll.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pollJobToTerminal } from '../runner-poll.js'

/**
 * The shared poll loop every task runner mirrors its job through. What is
 * proved here is the loop's contract with a daemon that is NOT healthy: the
 * job queue is in-memory, so an anasd restart mid-run both kills the child and
 * loses the job id — the loop must end the run (the unit fails with the
 * sentence the Last-run tooltip reads back from the journal) instead of
 * polling a vanished job or a silent socket for the 24h backstop (found live
 * 2026-09-25: the cloud unit sat `activating` for hours, Run now answered 409,
 * Cancel had nothing to cancel).
 */
describe('pollJobToTerminal — a daemon that restarted mid-run', () => {
  const noSleep = async (): Promise<void> => {}
  const JOB_REF: JobRef = {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'queued',
    operation: 'cloud.task.run',
    createdAt: '2026-09-25T14:02:11.000Z',
    createdBy: 'root@pam',
  }

  function scriptedPoller(polls: RunnerResponse[]): { requester: Requester, pollCount: () => number } {
    let idx = 0
    const requester: Requester = async () => polls[Math.min(idx++, polls.length - 1)]
    return { requester, pollCount: () => idx }
  }

  it('a 404 is terminal on the first sight — no further polls', async () => {
    const { requester, pollCount } = scriptedPoller([
      { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'job not found' } } },
      { statusCode: 200, body: { job: { id: JOB_REF.id, status: 'completed' } } },
    ])
    await assert.rejects(
      pollJobToTerminal(requester, JOB_REF, 'cloud sync', { sleep: noSleep }),
      (err: Error) => {
        assert.equal(
          err.message,
          `cloud sync job ${JOB_REF.id} no longer exists: the daemon restarted while the run was in progress, so the run was interrupted and must be started again`,
        )
        return true
      },
    )
    assert.equal(pollCount(), 1)
  })

  it('refusals under the reconnect bound then a 200 terminal resolves', async () => {
    let refusedCount = 0
    const requester: Requester = async () => {
      if (refusedCount < 2) {
        refusedCount++
        throw new Error('connect ECONNREFUSED /run/anas/anasd.sock')
      }
      return { statusCode: 200, body: { job: { id: JOB_REF.id, status: 'completed', result: {} } } }
    }
    const job = await pollJobToTerminal(requester, JOB_REF, 'backup', { sleep: noSleep, reconnectAttempts: 3 })
    assert.equal(job.status, 'completed')
  })

  it('the bound consecutive transport failures reject with the silence sentence', async () => {
    let polls = 0
    const requester: Requester = async () => {
      polls++
      throw new Error('connect ECONNREFUSED /run/anas/anasd.sock')
    }
    // 3 × 20s interval = 60s of silence named in the sentence.
    await assert.rejects(
      pollJobToTerminal(requester, JOB_REF, 'backup', { sleep: noSleep, intervalMs: 20_000, reconnectAttempts: 3 }),
      (err: Error) => {
        assert.equal(
          err.message,
          `backup job ${JOB_REF.id}: the daemon did not answer for 60 s — the run was interrupted`,
        )
        return true
      },
    )
    assert.equal(polls, 3)
  })

  it('a statusCode-0 answer (no status came back) counts toward the bound too', async () => {
    let polls = 0
    const requester: Requester = async () => {
      polls++
      return { statusCode: 0, body: '' }
    }
    await assert.rejects(
      pollJobToTerminal(requester, JOB_REF, 'cloud sync', { sleep: noSleep, reconnectAttempts: 2 }),
      /the daemon did not answer for/,
    )
    assert.equal(polls, 2)
  })

  it('a 500 is a transport-class failure and counts toward the bound', async () => {
    let polls = 0
    const requester: Requester = async () => {
      polls++
      return { statusCode: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } }
    }
    await assert.rejects(
      pollJobToTerminal(requester, JOB_REF, 'snapshot', { sleep: noSleep, reconnectAttempts: 3 }),
      (err: Error) => {
        assert.equal(
          err.message,
          `snapshot job ${JOB_REF.id}: the daemon did not answer for 30 s — the run was interrupted`,
        )
        return true
      },
    )
    assert.equal(polls, 3)
  })

  it('mixed transport classes accumulate toward one bound', async () => {
    // One 500, one thrown refusal, one status-0 — three DIFFERENT failure
    // shapes, one consecutive streak: a bound of 3 trips on the third.
    const polls: (RunnerResponse | Error)[] = [
      { statusCode: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      new Error('connect ECONNREFUSED'),
      { statusCode: 0, body: '' },
    ]
    let idx = 0
    const requester: Requester = async () => {
      const poll = polls[idx++]
      if (poll instanceof Error)
        throw poll
      return poll
    }
    await assert.rejects(
      pollJobToTerminal(requester, JOB_REF, 'backup', { sleep: noSleep, reconnectAttempts: 3 }),
      /the daemon did not answer for/,
    )
    assert.equal(idx, 3)
  })

  it('a 200 resets the count — the bound counts CONSECUTIVE failures only', async () => {
    const REFUSED = new Error('connect ECONNREFUSED')
    // Two failures, a 200 `running`, two more: each streak of 2 stays under
    // the bound of 3, and the loop survives to the terminal 200.
    const polls: (RunnerResponse | Error)[] = [
      { statusCode: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      REFUSED,
      { statusCode: 200, body: { job: { id: JOB_REF.id, status: 'running' } } },
      REFUSED,
      { statusCode: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      { statusCode: 200, body: { job: { id: JOB_REF.id, status: 'completed', result: {} } } },
    ]
    let idx = 0
    const requester: Requester = async () => {
      const poll = polls[idx++]
      if (poll instanceof Error)
        throw poll
      return poll
    }
    const job = await pollJobToTerminal(requester, JOB_REF, 'backup', { sleep: noSleep, reconnectAttempts: 3 })
    assert.equal(job.status, 'completed')
  })
})
