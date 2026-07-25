import type { AhrPool, Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { changeAhrMountpoint } from '../../services/ahr-create.js'
import { rollbackAhrSnapshot } from '../../services/ahr-snapshots.js'
import { jobRoutes } from '../jobs.js'
import { poolRoutes } from '../pools.js'

/**
 * Busy-unmount root-cause enrichment (story 3.29) at the route/job level — one
 * per feature family: a ZFS pool destroy (the pve5 incident), an AHR mountpoint
 * move, and an AHR snapshot rollback. Each asserts the surfaced error names the
 * holding process(es) after the primary "busy" text — the primary error is never
 * masked.
 *
 * The AHR service tests use THIS test process's own PID as the scripted holder,
 * so `/proc/<pid>/comm` resolves for real — the enrichment is proven end-to-end,
 * not mocked away.
 */

const GIB = 1024 ** 3
const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const FUSER = '/usr/bin/fuser'
const UMOUNT = '/usr/bin/umount'

// A minimal zpool-list -j payload with a single destroyable pool `testpool`.
const ZPOOL_LIST_JSON = JSON.stringify({
  output_version: { command: 'zpool list', vers_major: 0, vers_minor: 1 },
  pools: {
    testpool: {
      name: 'testpool',
      state: 'ONLINE',
      pool_guid: '1',
      properties: {
        size: { value: '480G' },
        allocated: { value: '100G' },
        free: { value: '380G' },
        fragmentation: { value: '0%' },
        capacity: { value: '20%' },
        dedupratio: { value: '1.00x' },
        health: { value: 'ONLINE' },
      },
    },
  },
})

interface TestServer {
  inject: ReturnType<typeof Fastify>['inject']
  close: () => Promise<unknown>
}

async function waitForJob(server: TestServer, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('3.29 — ZFS pool destroy job surfaces the holding processes', () => {
  let server: TestServer
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-busy-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')

    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: { stdout: ZPOOL_LIST_JSON, stderr: '', exitCode: 0 } })
    // The destroy fails busy — the exact pve5 error shape (names its own path).
    executor.addFixture({
      command: '/usr/sbin/zpool',
      args: ['destroy', 'testpool'],
      result: { stdout: '', stderr: `cannot unmount '/testpool': pool or dataset is busy`, exitCode: 1 },
    })
    // fuser names THIS test process as the holder → /proc/<pid>/comm resolves real.
    executor.addFixture({ command: FUSER, args: ['-m', '/testpool'], result: { stdout: `${process.pid}\n`, stderr: '', exitCode: 0 } })

    const app = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(poolRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      fstabPath: join(dir, 'fstab'),
      pveStoragePath: join(dir, 'no-storage.cfg'),
    })
    server = app as unknown as TestServer
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('the failed job error keeps the primary busy text AND names the holder', async () => {
    const first = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, res.json().job.id)

    assert.equal(job.status, 'failed')
    const msg = job.error!.message
    // Primary error preserved verbatim…
    assert.ok(msg.includes(`cannot unmount '/testpool': pool or dataset is busy`), msg)
    // …with the root cause appended.
    assert.ok(msg.includes('held open by:'), msg)
    assert.ok(msg.includes(`(${process.pid})`), msg)
  })
})

function mkPool(over: Partial<AhrPool> = {}): AhrPool {
  return {
    name: 'tank',
    ahrType: 'ahr1',
    mountpoint: '/mnt/anas-ahr/tank',
    mounted: true,
    disks: [],
    arrays: [],
    vg: { name: 'tank', sizeBytes: 5 * GIB, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 5 * GIB },
    capacity: { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
    ...over,
  } as AhrPool
}

/** A MockExecutor whose umount fails busy and whose fuser names this process. */
function busyUmountExecutor(mountpoint: string): MockExecutor {
  const exec = new MockExecutor()
  exec.addFixture({ command: UMOUNT, result: { stdout: '', stderr: `umount: ${mountpoint}: target is busy.`, exitCode: 32 } })
  exec.addFixture({ command: FUSER, args: ['-m', mountpoint], result: { stdout: `${process.pid}\n`, stderr: '', exitCode: 0 } })
  return exec
}

describe('3.29 — AHR mountpoint move surfaces the holding processes', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-busy-ahr-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('the busy umount error names the holder', async () => {
    const mp = '/mnt/anas-ahr/tank'
    const exec = busyUmountExecutor(mp)
    await assert.rejects(
      changeAhrMountpoint(
        exec,
        { name: 'tank', mountpoint: mp, mounted: true, subvolLayout: true },
        '/mnt/anas-ahr/tank2',
        () => {},
        { fstabPath: join(dir, 'fstab') },
      ),
      (err: Error) => {
        assert.ok(err.message.includes('target is busy'), err.message)
        assert.ok(err.message.includes('held open by:'), err.message)
        assert.ok(err.message.includes(`(${process.pid})`), err.message)
        return true
      },
    )
  })
})

describe('3.29 — AHR snapshot rollback surfaces the holding processes', () => {
  it('the brief unmount, when busy, names the holder', async () => {
    const mp = '/mnt/anas-ahr/tank'
    const exec = busyUmountExecutor(mp)
    await assert.rejects(
      rollbackAhrSnapshot(exec, mkPool({ mountpoint: mp }), 'snap1', () => {}),
      (err: Error) => {
        assert.ok(err.message.includes('target is busy'), err.message)
        assert.ok(err.message.includes('held open by:'), err.message)
        assert.ok(err.message.includes(`(${process.pid})`), err.message)
        return true
      },
    )
  })
})
