import type { Job, JobAccepted } from '@anas/shared'
import type { AddressInfo } from 'node:net'
import type { MockExecutor } from '../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { currentLane, LANE_BUDGET_MS, runInLane } from '../executor/deadline.js'
import { MockExecutor as Mock } from '../executor/mock.js'
import { JobQueue } from '../jobs/queue.js'
import { createServer } from '../server.js'

/**
 * cr.34 lanes (WAVE3-DESIGN §6.2, §8.2 "Lanes"): the same command gets the
 * request budget when a request runs it and the job budget when a job does —
 * asserted through the deadlines the mock executor records, which it resolves
 * with the production rules in the lane in effect at the call.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const SUBMITTER = { user: 'root@pam', uid: 0, requestId: 'r1', params: {} }

async function settled(queue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = queue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error(`job ${id} did not settle`)
}

describe('cr.34 lanes: the job queue', () => {
  it('a job body runs in the job lane under its own id, even when a request submitted it', async () => {
    const queue = new JobQueue()
    const mock = new Mock()
    let seen: ReturnType<typeof currentLane> | undefined
    // `execute` is reached synchronously from `submit`: submitted from inside
    // a request's store, the body would inherit it without the queue's lane.
    const job = runInLane({ lane: 'request' }, () => queue.submit('test.op', SUBMITTER, async () => {
      await new Promise(r => setTimeout(r, 1))
      seen = currentLane()
      await mock.exec('/usr/sbin/zpool', ['scrub', '--', 'tank'])
      return null
    }))
    const done = await settled(queue, job.id)
    assert.equal(done.status, 'completed')
    assert.deepEqual(seen, { lane: 'job', jobId: job.id })
    assert.deepEqual(mock.deadlines.map(d => [d.lane, d.jobId, d.budgetMs]), [['job', job.id, LANE_BUDGET_MS.job]])
  })

  it('a job that dies of a timeout fails with error code TIMEOUT and the command\'s sentence', async () => {
    const queue = new JobQueue()
    const mock = new Mock().addFixture({ command: '/usr/sbin/zpool', timesOut: {} })
    const job = queue.submit('test.op', SUBMITTER, async () => {
      await mock.exec('/usr/sbin/zpool', ['export', '--', 'tank'])
      return null
    })
    const done = await settled(queue, job.id)
    assert.equal(done.status, 'failed')
    assert.equal(done.error?.code, 'TIMEOUT')
    assert.match(done.error?.message ?? '', /^'zpool export' did not finish within 300 s and was stopped/)
    assert.match(done.error?.message ?? '', /check it before retrying/)
  })
})

describe('cr.34 lanes: the daemon\'s request hooks', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a GET\'s commands run in the request lane (10 s)', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.deadlines.length = 0
    const res = await server.inject({ method: 'GET', url: '/v1/pools', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    assert.ok(mock.deadlines.length > 0)
    for (const d of mock.deadlines)
      assert.deepEqual([d.command, d.lane, d.budgetMs], [d.command, 'request', LANE_BUDGET_MS.request])
  })

  it('a POST with a JSON body: the read before the reply gets the request budget, the job\'s command the job budget', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.deadlines.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/scrub',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'start' }),
    })
    assert.equal(res.statusCode, 202)
    const { job } = res.json() as JobAccepted
    const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
    assert.equal((await settled(queue, job.id)).status, 'completed')
    const list = mock.deadlines.find(d => d.args[0] === 'list')
    const scrub = mock.deadlines.find(d => d.args[0] === 'scrub')
    assert.deepEqual([list?.lane, list?.budgetMs], ['request', LANE_BUDGET_MS.request])
    assert.deepEqual([scrub?.lane, scrub?.jobId, scrub?.budgetMs], ['job', job.id, LANE_BUDGET_MS.job])
  })

  it('over a real socket, a body that arrives after the headers still leaves the handler in the request lane', async () => {
    // The body is parsed on later socket events; the store the onRequest hook
    // entered must survive that into the handler. `inject` hands the body
    // over at once and cannot show it — a real socket with a late body can.
    server = createServer({ mock: true, logger: false })
    await server.listen({ host: '127.0.0.1', port: 0 })
    const { port } = server.server.address() as AddressInfo
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.deadlines.length = 0
    const body = JSON.stringify({ action: 'start' })
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/pools/testpool/scrub',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.flushHeaders()
      setTimeout(() => req.end(body), 50)
    })
    assert.equal(status, 202)
    const list = mock.deadlines.find(d => d.args[0] === 'list')
    assert.deepEqual([list?.lane, list?.budgetMs], ['request', LANE_BUDGET_MS.request])
  })
})
