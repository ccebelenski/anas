import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const BY_ID = '/dev/disk/by-id/'
const EXISTING = 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678'
const FAILED = 'ata-WDC_WD2003FZEX-00SRLA0_WD-34567890'
// The NEW disks deliberately do NOT resolve in the mock disk inventory (where
// the WD-45678901/56789012 fixtures are testpool members): the composability
// pre-flight refuses an inventory-known non-available disk before the job, and
// these tests assert argv construction, not that refusal (see pools-composable).
const NEW_A = 'ata-WDC_WD2003FZEX-00SRLA0_WD-99999991'
const NEW_B = 'ata-WDC_WD2003FZEX-00SRLA0_WD-99999992'

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

describe('attach/replace endpoint: POST /v1/pools/:name/attach', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('attach (replace=false) runs zpool attach <pool> <existing> <new>', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: EXISTING, newDiskId: NEW_A, replace: false }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.attach')
    assert.equal(body.job.createdBy, 'root@pam')

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.error, null)

    const call = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'attach')
    assert.ok(call, 'zpool attach was invoked')
    assert.deepEqual(call!.args, [
      'attach',
      'testpool',
      `${BY_ID}${EXISTING}`,
      `${BY_ID}${NEW_A}`,
    ])
  })

  it('defaults to attach when replace is omitted', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: EXISTING, newDiskId: NEW_A }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.attach')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const call = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'attach')
    assert.ok(call)
    assert.deepEqual(call!.args, ['attach', 'testpool', `${BY_ID}${EXISTING}`, `${BY_ID}${NEW_A}`])
  })

  it('replace (replace=true) runs zpool replace <pool> <old> <new>', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: FAILED, newDiskId: NEW_B, replace: true }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.replace')

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const call = spy.calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'replace')
    assert.ok(call, 'zpool replace was invoked')
    assert.deepEqual(call!.args, [
      'replace',
      'testpool',
      `${BY_ID}${FAILED}`,
      `${BY_ID}${NEW_B}`,
    ])
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: EXISTING, newDiskId: NEW_A }),
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: EXISTING, newDiskId: NEW_A }),
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('rejects a request missing newDiskId', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: EXISTING }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects an invalid pool name', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/1notapool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: EXISTING, newDiskId: NEW_A }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('fails the job when zpool replace fails', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['replace', 'testpool', `${BY_ID}${FAILED}`, `${BY_ID}${NEW_B}`],
      result: { stdout: '', stderr: 'cannot replace: device is too small', exitCode: 1 },
    })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: FAILED, newDiskId: NEW_B, replace: true }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /device is too small/)
  })
})
