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

/** Wrap the mock executor so we can inspect the exact command/args issued. */
function spyExecutor(server: ReturnType<typeof createServer>): Array<{ command: string, args: string[] }> {
  const mock = (server as any).executor as MockExecutor
  const calls: Array<{ command: string, args: string[] }> = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return calls
}

function createCall(calls: Array<{ command: string, args: string[] }>): string[] | undefined {
  return calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'create')?.args
}

describe('create pool endpoint: POST /v1/pools', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 202, completes the job, and builds a mirror arg array', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'newpool',
        dataVdevs: [{ type: 'mirror', disks: ['ata-DISK1', 'ata-DISK2'] }],
      }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.create')
    assert.equal(body.job.createdBy, 'root@pam')

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    assert.deepEqual(createCall(calls), [
      'create',
      'newpool',
      'mirror',
      '/dev/disk/by-id/ata-DISK1',
      '/dev/disk/by-id/ata-DISK2',
    ])
  })

  it('builds a raidz2 arg array', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'rzpool',
        dataVdevs: [{ type: 'raidz2', disks: ['d1', 'd2', 'd3', 'd4'] }],
      }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    await waitForJob(server, body.job.id)

    assert.deepEqual(createCall(calls), [
      'create',
      'rzpool',
      'raidz2',
      '/dev/disk/by-id/d1',
      '/dev/disk/by-id/d2',
      '/dev/disk/by-id/d3',
      '/dev/disk/by-id/d4',
    ])
  })

  it('builds a stripe arg array with no redundancy keyword', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'strp',
        dataVdevs: [{ type: 'stripe', disks: ['d1', 'd2'] }],
      }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    await waitForJob(server, body.job.id)

    assert.deepEqual(createCall(calls), [
      'create',
      'strp',
      '/dev/disk/by-id/d1',
      '/dev/disk/by-id/d2',
    ])
  })

  it('appends log, cache, and spare vdevs with their keywords', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'full',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
        logVdevs: [{ type: 'mirror', disks: ['l1', 'l2'] }],
        cacheDisks: ['c1'],
        spareDisks: ['s1'],
      }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    await waitForJob(server, body.job.id)

    assert.deepEqual(createCall(calls), [
      'create',
      'full',
      'mirror',
      '/dev/disk/by-id/d1',
      '/dev/disk/by-id/d2',
      'log',
      'mirror',
      '/dev/disk/by-id/l1',
      '/dev/disk/by-id/l2',
      'cache',
      '/dev/disk/by-id/c1',
      'spare',
      '/dev/disk/by-id/s1',
    ])
  })

  it('appends special and dedup allocation-class vdevs with their keywords', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'alloc',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
        specialVdevs: [{ type: 'mirror', disks: ['sp1', 'sp2'] }],
        dedupVdevs: [{ type: 'mirror', disks: ['dd1', 'dd2'] }],
      }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    await waitForJob(server, body.job.id)

    assert.deepEqual(createCall(calls), [
      'create',
      'alloc',
      'mirror',
      '/dev/disk/by-id/d1',
      '/dev/disk/by-id/d2',
      'special',
      'mirror',
      '/dev/disk/by-id/sp1',
      '/dev/disk/by-id/sp2',
      'dedup',
      'mirror',
      '/dev/disk/by-id/dd1',
      '/dev/disk/by-id/dd2',
    ])
  })

  it('rejects a striped (non-redundant) special vdev with 400 — never forced', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'badspecial',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
        specialVdevs: [{ type: 'stripe', disks: ['sp1'] }],
      }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    // The pool must never be created for a non-redundant special vdev.
    assert.equal(createCall(calls), undefined)
  })

  it('rejects a striped (non-redundant) dedup vdev with 400', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'baddedup',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
        dedupVdevs: [{ type: 'stripe', disks: ['dd1'] }],
      }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('returns 409 for a pool name that already exists', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'testpool',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
      }),
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
  })

  it('returns 400 for a request with too few disks', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'toofew',
        dataVdevs: [{ type: 'mirror', disks: ['onlyone'] }],
      }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'noauth',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
      }),
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })
})
