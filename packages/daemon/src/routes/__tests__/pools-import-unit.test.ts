import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { jobRoutes } from '../jobs.js'
import { poolRoutes } from '../pools.js'

/**
 * Boot-import unit parity (issue #22). ANAS used to rely on /etc/zfs/zpool.cache
 * alone, which is intermittently unreliable on PVE — the pool is simply gone
 * after a reboot. PVE solved this in PVE/API2/Disks/ZFS.pm (their fix for
 * Proxmox bug #2554) by ALSO enabling `zfs-import@<pool>.service` on create and
 * disabling it on destroy. These tests pin that ANAS does the same on all three
 * mutations, and that a systemctl hiccup warns instead of failing the job.
 */

const ZPOOL = '/usr/sbin/zpool'
const SYSTEMCTL = '/usr/bin/systemctl'
const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

/** A `zpool list -j` payload naming exactly the given pools. */
function listJson(...pools: string[]): string {
  return JSON.stringify({
    pools: Object.fromEntries(pools.map(p => [p, { name: p, state: 'ONLINE', properties: {} }])),
  })
}

function listResult(...pools: string[]): ExecResult {
  return { stdout: listJson(...pools), stderr: '', exitCode: 0 }
}

async function build(ex: MockExecutor): Promise<{ server: ReturnType<typeof Fastify>, jobQueue: JobQueue }> {
  const jobQueue = new JobQueue()
  const server = Fastify({ logger: false })
  await server.register(jobRoutes, { prefix: '/v1', jobQueue })
  await server.register(poolRoutes, { prefix: '/v1', executor: ex, jobQueue, confirmStore: new ConfirmStore() })
  return { server, jobQueue }
}

async function waitForJob(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = jobQueue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

/** The systemctl argv issued for a pool's boot-import unit, if any. */
function unitCall(ex: MockExecutor, pool: string): string[] | undefined {
  return ex.calls.find(c => c.command === SYSTEMCTL && c.args[1] === `zfs-import@${pool}.service`)?.args
}

describe('boot-import unit: create enables zfs-import@<pool>.service (issue #22)', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function createPool(ex: MockExecutor, name: string): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name, dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }] }),
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('enables the unit after a successful create and keeps the result null', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult() })
    ex.addFixture({ command: ZPOOL, result: OK }) // the create itself
    ex.addFixture({ command: SYSTEMCTL, args: ['enable', 'zfs-import@tank.service'], result: OK })

    const job = await createPool(ex, 'tank')

    assert.equal(job.status, 'completed')
    assert.deepEqual(unitCall(ex, 'tank'), ['enable', 'zfs-import@tank.service'])
    // Unchanged result shape when the unit management succeeds.
    assert.equal(job.result, null)
  })

  it('still completes when systemctl fails, reporting it as a job warning', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult() })
    ex.addFixture({ command: ZPOOL, result: OK })
    // No systemctl fixture — the mock answers 127, standing in for a hiccup.

    const job = await createPool(ex, 'tank')

    assert.equal(job.status, 'completed', 'a unit hiccup never fails an already-created pool')
    const result = job.result as { warnings?: string[] }
    assert.equal(result.warnings?.length, 1)
    assert.ok(result.warnings![0].includes('zfs-import@tank.service'))
  })

  it('escapes the pool name into the instance (my-pool → my\\x2dpool)', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult() })
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    await createPool(ex, 'my-pool')

    assert.deepEqual(
      ex.calls.find(c => c.command === SYSTEMCTL)?.args,
      ['enable', 'zfs-import@my\\x2dpool.service'],
    )
  })
})

describe('boot-import unit: import enables the unit for the pool(s) that appeared', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function importPool(ex: MockExecutor, body: Record<string, unknown>): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('enables the unit for a pool imported by name', async () => {
    const ex = new MockExecutor()
    // Before → after: `oldtank` appears across the import.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult(), listResult('oldtank')] })
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, args: ['enable', 'zfs-import@oldtank.service'], result: OK })

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'completed')
    assert.deepEqual(unitCall(ex, 'oldtank'), ['enable', 'zfs-import@oldtank.service'])
    assert.equal(job.result, null)
  })

  it('learns the name of a pool imported BY GUID from the list diff', async () => {
    const ex = new MockExecutor()
    // A guid import never tells us the name — an already-imported pool is in
    // both listings, and only the newcomer is the one we just imported.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool', 'oldtank')] })
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    const job = await importPool(ex, { guid: '9876543210987654321' })

    assert.equal(job.status, 'completed')
    // Exactly one unit touched, and it is the newly imported pool's.
    assert.deepEqual(
      ex.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args),
      [['enable', 'zfs-import@oldtank.service']],
    )
  })

  it('falls back to the requested name when the diff is empty', async () => {
    const ex = new MockExecutor()
    // Same listing before and after (e.g. the listing failed) — a by-name
    // import still knows what it asked for.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('testpool') })
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    await importPool(ex, { name: 'oldtank' })

    assert.deepEqual(unitCall(ex, 'oldtank'), ['enable', 'zfs-import@oldtank.service'])
  })

  it('reports a systemctl failure as a job warning, not a failed import', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult(), listResult('oldtank')] })
    ex.addFixture({ command: ZPOOL, result: OK })
    // No systemctl fixture — 127.

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'completed')
    const result = job.result as { warnings?: string[] }
    assert.equal(result.warnings?.length, 1)
  })
})

describe('boot-import unit: destroy disables the unit', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function destroyPool(ex: MockExecutor, pool: string): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const first = await server.inject({ method: 'DELETE', url: `/v1/pools/${pool}`, headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/pools/${pool}`,
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('disables the unit after a successful destroy', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('tank') })
    ex.addFixture({ command: ZPOOL, args: ['destroy', 'tank'], result: OK })
    ex.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@tank.service'], result: OK })

    const job = await destroyPool(ex, 'tank')

    assert.equal(job.status, 'completed')
    assert.deepEqual(unitCall(ex, 'tank'), ['disable', 'zfs-import@tank.service'])
    assert.deepEqual(job.result, { destroyed: 'tank' })
  })

  it('attaches a warning to the result when the disable fails', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('tank') })
    ex.addFixture({ command: ZPOOL, args: ['destroy', 'tank'], result: OK })
    // No systemctl fixture — 127.

    const job = await destroyPool(ex, 'tank')

    assert.equal(job.status, 'completed')
    const result = job.result as { destroyed: string, warnings?: string[] }
    assert.equal(result.destroyed, 'tank')
    assert.equal(result.warnings?.length, 1)
    assert.ok(result.warnings![0].includes('zfs-import@tank.service'))
  })

  it('never reaches the root pool — its destroy is blocked before the job', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('rpool') })
    const built = await build(ex)
    server = built.server

    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/rpool', headers: IDENTITY_HEADERS })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PROTECTED_RESOURCE')
    assert.equal(ex.calls.filter(c => c.command === SYSTEMCTL).length, 0)
  })
})
