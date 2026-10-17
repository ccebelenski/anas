import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { currentLane } from '../../executor/deadline.js'
import { createServer } from '../../server.js'

/**
 * Story cr.64b1 — the guard core's second pass, over the REAL routes and the
 * dev mock's executor (the cr.64a review's construct-it requests).
 *
 * (A) DOMINANCE. A route whose pool-guid read fails takes cr.33b's fallback,
 * the pool's name key EXCLUSIVE; the job re-reads the guid and its recompute
 * needs the `zfs:<guid>/…` keys. Every guid-keyed claim set carries the name
 * key shared (cr.33b), so the held exclusive name key excludes every job that
 * could touch those keys — the recompute must say the run holds them (the
 * lock table's own rule, `covers` in jobs/locks.ts), not refuse key by key.
 *
 * FIXTURES (ruling (l)): the dev mock's ZFS world (testpool, testpool/media,
 * the `zpool get -H -o value guid -- testpool` line server.ts serves); the
 * one injected failure is that line answering exit 1 with zpool's own
 * missing-pool sentence, at the ROUTE only (no job lane), so the job's re-read
 * sees the guid.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const TESTPOOL_GUID = '5823146802312415237'
const GUID_ARGS = ['get', '-H', '-o', 'value', 'guid', '--', 'testpool']

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

describe('cr.64b1 (A) — the job door\'s lock recompute compares by dominance, as the lock table does', () => {
  let server: ReturnType<typeof createServer> | undefined
  let calls: { op: string, command: string, args: string[] }[] = []

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** The dev mock; `zpool get guid testpool` fails while `failGuid(op)` says so ('' = the route). */
  async function serve(failGuid: (op: string) => boolean): Promise<void> {
    calls = []
    server = createServer({ mock: true, logger: false })
    const jobs = queue()
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command, args, opts) => {
      const jobId = currentLane().jobId
      const op = jobId ? (jobs.get(jobId)?.operation ?? '') : ''
      calls.push({ op, command, args })
      if (command === ZPOOL && args.length === GUID_ARGS.length && args.every((a, i) => a === GUID_ARGS[i]) && failGuid(op))
        return { stdout: '', stderr: 'cannot open \'testpool\': no such pool\n', exitCode: 1 }
      return orig(command, args, opts)
    }
    await server.ready()
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  const snapshotArgv = (op: string) => calls.filter(c => c.op === op && c.command === ZFS && c.args[0] === 'snapshot')

  it('the review\'s request: a dataset snapshot whose pool-guid read fails at the ROUTE only — the route holds `zname:testpool` exclusive, the job needs the guid keys, and the job RUNS (`zfs snapshot` issued)', async () => {
    await serve(op => op === '')
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/media/snapshots',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'probe1' }),
    })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    // The route took the fallback: the name key, exclusive, and nothing else.
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(id)!
    assert.deepEqual(record.claims.map(c => `${c.key} ${c.mode}`), ['zname:testpool exclusive'])
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // The job's own re-read DID read the guid (the claims it needs are the guid keys).
    assert.ok(calls.some(c => c.op === 'zfs.snapshot' && c.command === ZPOOL && c.args.join(' ') === GUID_ARGS.join(' ')), 'the job re-read the guid')
    assert.deepEqual(snapshotArgv('zfs.snapshot').map(c => c.args.join(' ')), ['snapshot -- testpool/media@probe1'])
  })

  it('the other way round stays a refusal: a route that read the guid holds the name key only SHARED, so a job whose guid read fails needs `zname:testpool` exclusive and refuses STATE_CHANGED — no `zfs snapshot`', async () => {
    await serve(op => op === 'zfs.snapshot')
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/media/snapshots',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'probe1' }),
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed', JSON.stringify(job.result))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, new RegExp(`zfs:${TESTPOOL_GUID}/media`))
    assert.deepEqual(snapshotArgv('zfs.snapshot'), [])
  })
})
