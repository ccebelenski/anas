import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

/** Poll a job until it reaches a terminal state. */
async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Wrap the mock executor's exec to record every command/args pair. */
function spyExecutor(server: ReturnType<typeof createServer>): { calls: { command: string, args: string[] }[] } {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const calls: { command: string, args: string[] }[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return { calls }
}

describe('trim endpoint: POST /v1/pools/:name/trim', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 202 and issues zpool trim <name> for the default start action', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/trim',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.trim')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const trimCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'trim')
    assert.ok(trimCall, 'zpool trim was invoked')
    assert.deepEqual(trimCall!.args, ['trim', 'testpool'])
  })

  it('issues zpool trim -c <name> for the cancel action', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/trim',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'cancel' }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const trimCall = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'trim')
    assert.ok(trimCall, 'zpool trim was invoked')
    assert.deepEqual(trimCall!.args, ['trim', '-c', 'testpool'])
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/trim',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/trim',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })
})
