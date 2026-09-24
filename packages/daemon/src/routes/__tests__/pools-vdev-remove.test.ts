import type { Job, JobAccepted, VdevGroup } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { ParsedPoolStatus } from '../../parsers/zpool-status.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { isRemovableVdevRole } from '@anas/shared'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'
import {
  NON_REMOVABLE_VDEV_MESSAGE,
  resolveVdev,
  unknownVdevMessage,
} from '../../services/zfs-vdev-remove.js'

/**
 * Story vdevs.2 — POST /v1/pools/:name/vdevs/remove.
 *
 * Two halves, for one reason: the zpool-status parser on main does not yet
 * surface the pool-level `logs`/`special`/`dedup` sections (that is story
 * vdevs.1, landing in parallel), so a log/special/dedup case cannot reach the
 * route through a fixture yet. Those roles are covered against a
 * `ParsedPoolStatus` built by hand — the parser's own output type — through the
 * SAME `resolveVdev` + `isRemovableVdevRole` pair the route asks. Cache and
 * spare go the whole way through the route, the parser and the mock executor.
 */

const ZPOOL = '/usr/sbin/zpool'
const BY_ID = '/dev/disk/by-id/'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** The spare the shipped `zpool-status-online.json` fixture carries. */
const SPARE_ID = 'ata-WDC_WD2003FZEX-00SRLA0_WD-56789012'
const SPARE_PATH = `${BY_ID}${SPARE_ID}-part1`
/** An L2ARC device added to that fixture for the cache cases. */
const CACHE_ID = 'ata-Samsung_SSD_870_EVO_500GB_S6PWNS0T123456'
const CACHE_PATH = `${BY_ID}${CACHE_ID}-part1`
/** A DATA leaf of the fixture's first mirror — refused, it is not removable. */
const DATA_LEAF_ID = 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678'

interface StatusDoc {
  pools: Record<string, Record<string, unknown>>
}

/** The shipped online fixture, parsed so a test can add/drop pool sections. */
function statusDoc(): StatusDoc {
  return JSON.parse(mockFixtures.zpoolStatus().stdout) as StatusDoc
}

function asResult(doc: StatusDoc): ExecResult {
  return { stdout: JSON.stringify(doc), stderr: '', exitCode: 0 }
}

/** The fixture with an L2ARC device bolted on, as `zpool status -j` reports it. */
function withCache(): StatusDoc {
  const doc = statusDoc()
  doc.pools.testpool.l2cache = {
    [CACHE_ID]: {
      name: CACHE_ID,
      vdev_type: 'disk',
      guid: '2222222222222222222',
      path: CACHE_PATH,
      devid: `${CACHE_ID}-part1`,
      class: 'l2cache',
      state: 'ONLINE',
    },
  }
  return doc
}

/** The same pool with no `l2cache` section — what a successful remove leaves. */
function withoutCache(): StatusDoc {
  return statusDoc()
}

/** The fixture with its `spares` section dropped. */
function withoutSpare(): StatusDoc {
  const doc = statusDoc()
  delete doc.pools.testpool.spares
  return doc
}

/** Poll a job until it reaches a terminal state. */
async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/**
 * A server whose only live reads are the pool list and a SCRIPTED sequence of
 * `zpool status -jv` answers: the first is what the route resolves the name
 * against, the rest are what the job's settle loop re-reads (the last repeats).
 * Everything else is unmatched and fail-opens, as every read on this route does.
 */
function serverWith(statuses: StatusDoc[], remove?: ExecResult): ReturnType<typeof createServer> {
  const server = createServer({ mock: true, logger: false })
  const mock = (server as unknown as { executor: MockExecutor }).executor
  mock.clearFixtures()
  mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: mockFixtures.zpoolList() })
  mock.addFixture({ command: ZPOOL, args: ['status', '-jv'], results: statuses.map(asResult) })
  // Readable boot facts with no bootfs: the system-pool rule stays inactive
  // (an unreadable probe would tighten every pool to hands-off).
  mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, args: undefined, result: remove ?? { stdout: '', stderr: '', exitCode: 0 } })
  return server
}

/** Every exec the server made, in order. */
function callsOf(server: ReturnType<typeof createServer>): { command: string, args: string[] }[] {
  return (server as unknown as { executor: MockExecutor }).executor.calls
}

function removeCall(server: ReturnType<typeof createServer>): string[] | undefined {
  return callsOf(server).find(c => c.command === ZPOOL && c.args[0] === 'remove')?.args
}

describe('remove-vdev endpoint: POST /v1/pools/:name/vdevs/remove', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('removes a cache leaf: 202, exactly [remove, pool, token], result names the role', async () => {
    server = serverWith([withCache(), withoutCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: CACHE_ID }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.remove')
    assert.equal(body.job.createdBy, 'root@pam')

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { pool: 'testpool', vdev: CACHE_ID, role: 'cache' })
    assert.deepEqual(removeCall(server), ['remove', 'testpool', CACHE_PATH])
  })

  it('removes a cache leaf named by its device-path basename', async () => {
    server = serverWith([withCache(), withoutCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: `${CACHE_ID}-part1` }),
    })

    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(removeCall(server), ['remove', 'testpool', CACHE_PATH])
  })

  it('removes a spare leaf', async () => {
    server = serverWith([statusDoc(), withoutSpare()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: SPARE_ID }),
    })

    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { pool: 'testpool', vdev: SPARE_ID, role: 'spare' })
    assert.deepEqual(removeCall(server), ['remove', 'testpool', SPARE_PATH])
  })

  it('refuses a DATA leaf with the evacuation sentence — never runs zpool remove', async () => {
    server = serverWith([statusDoc()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: DATA_LEAF_ID }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(res.json().error.message, NON_REMOVABLE_VDEV_MESSAGE)
    assert.equal(removeCall(server), undefined)
  })

  it('refuses a data vdev NAME (mirror-0) with the same sentence', async () => {
    server = serverWith([statusDoc()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: 'mirror-0' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, NON_REMOVABLE_VDEV_MESSAGE)
    assert.equal(removeCall(server), undefined)
  })

  it('refuses a vdev the pool does not carry, naming pool and vdev', async () => {
    server = serverWith([statusDoc()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: 'mirror-9' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(res.json().error.message, unknownVdevMessage('testpool', 'mirror-9'))
    assert.equal(removeCall(server), undefined)
  })

  it('refuses the synthetic cache CONTAINER name — the leaf is the removable unit', async () => {
    server = serverWith([withCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: 'cache' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, unknownVdevMessage('testpool', 'cache'))
    assert.equal(removeCall(server), undefined)
  })

  it('fails the job when the vdev is still present after zpool remove exits 0', async () => {
    process.env.ANAS_VDEV_REMOVE_SETTLE_MS = '0'
    try {
      // Every status read still shows the cache device — the removal did not
      // take, whatever the exit code said.
      server = serverWith([withCache(), withCache()])

      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/vdevs/remove',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ vdev: CACHE_ID }),
      })

      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /still part of pool testpool/)
      assert.deepEqual(removeCall(server), ['remove', 'testpool', CACHE_PATH])
    }
    finally {
      delete process.env.ANAS_VDEV_REMOVE_SETTLE_MS
    }
  })

  it('fails the job with zpool\'s own error when the remove exits non-zero', async () => {
    server = serverWith(
      [withCache(), withoutCache()],
      { stdout: '', stderr: `cannot remove ${CACHE_ID}: no such device in pool`, exitCode: 1 },
    )

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: CACHE_ID }),
    })

    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /no such device in pool/)
  })

  it('rejects a request without identity headers', async () => {
    server = serverWith([withCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: CACHE_ID }),
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('404s for a pool that does not exist', async () => {
    server = serverWith([withCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: CACHE_ID }),
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('400s on a vdev name carrying a path separator', async () => {
    server = serverWith([withCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: '../../dev/sda' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(removeCall(server), undefined)
  })

  it('400s on an invalid pool name', async () => {
    server = serverWith([withCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/1notapool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: CACHE_ID }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })
})

// --- PVE-owned pools are hands-off (pvepool.1, as everywhere) --------------
describe('remove-vdev: a PVE-owned pool is refused', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_STORAGE_CFG
    if (dir)
      await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('400s when storage.cfg registers the pool as a zfspool storage', async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-vdev-remove-'))
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: local-zfs\n\tpool testpool\n\tcontent images,rootdir\n')
    process.env.ANAS_STORAGE_CFG = cfg
    server = serverWith([withCache()])

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs/remove',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: CACHE_ID }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /local-zfs/)
    assert.equal(removeCall(server), undefined)
  })
})

// --- log / special / dedup: the roles the parser does not surface yet -------
//
// Built as `ParsedPoolStatus` by hand (the parser's own output type) because
// story vdevs.1 — the fix that reads the pool-level `logs`/`special`/`dedup`
// sections — lands in parallel. The verdict under test is the route's: resolve
// the name, then ask `isRemovableVdevRole` about the role that came back.

function leaf(name: string, path: string) {
  return { id: name, path: path as `/dev/${string}`, state: 'ONLINE' as const, readErrors: 0, writeErrors: 0, checksumErrors: 0, slowIos: 0 }
}

/** The six-class throwaway pool of `zpool-status-all-vdev-classes-2.4.4.json`. */
function sixClassStatus(): ParsedPoolStatus {
  const groups: VdevGroup[] = [
    {
      role: 'data',
      vdevs: [{ name: 'sdb1', type: 'disk', state: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks: [leaf('sdb1', '/dev/sdb1')] }],
    },
    {
      role: 'log',
      vdevs: [{ name: 'sdb2', type: 'disk', state: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks: [leaf('sdb2', '/dev/sdb2')] }],
    },
    {
      role: 'cache',
      vdevs: [{ name: 'sdb3', type: 'disk', state: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks: [leaf('sdb3', '/dev/sdb3')] }],
    },
    {
      role: 'spare',
      vdevs: [{ name: 'sdb4', type: 'spare', state: 'AVAIL', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks: [leaf('sdb4', '/dev/sdb4')] }],
    },
    {
      role: 'special',
      vdevs: [{ name: 'sdb5', type: 'disk', state: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks: [leaf('sdb5', '/dev/sdb5')] }],
    },
    {
      role: 'dedup',
      vdevs: [{ name: 'sdb6', type: 'disk', state: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks: [leaf('sdb6', '/dev/sdb6')] }],
    },
  ]
  return { name: 'gtvdev', state: 'ONLINE', guid: '1', errorCount: 0, vdevGroups: groups, scan: null }
}

/** The same pool after a mirrored log has been added by CLI. */
function mirroredLogStatus(): ParsedPoolStatus {
  const status = sixClassStatus()
  status.vdevGroups = status.vdevGroups.map(g => g.role === 'log'
    ? {
        role: 'log' as const,
        vdevs: [{
          name: 'mirror-1',
          type: 'mirror' as const,
          state: 'ONLINE' as const,
          readErrors: 0,
          writeErrors: 0,
          checksumErrors: 0,
          disks: [leaf('sdb2', '/dev/sdb2'), leaf('sdb3', '/dev/sdb3')],
        }],
      }
    : g)
  return status
}

describe('remove-vdev: the six vdev classes, resolved as the route resolves them', () => {
  it('allows a single log leaf and hands zpool the leaf', () => {
    const hit = resolveVdev(sixClassStatus(), 'sdb2')
    assert.deepEqual(hit, { role: 'log', vdev: 'sdb2', token: '/dev/sdb2' })
    assert.equal(isRemovableVdevRole(hit!.role), true)
  })

  it('allows a mirrored log by its mirror-N name', () => {
    const hit = resolveVdev(mirroredLogStatus(), 'mirror-1')
    assert.deepEqual(hit, { role: 'log', vdev: 'mirror-1', token: 'mirror-1' })
    assert.equal(isRemovableVdevRole(hit!.role), true)
  })

  it('names the mirror, not the leg, when a leaf of a mirrored log is given', () => {
    const hit = resolveVdev(mirroredLogStatus(), 'sdb2')
    assert.deepEqual(hit, { role: 'log', vdev: 'mirror-1', token: 'mirror-1' })
  })

  it('allows a cache leaf and a spare leaf', () => {
    const status = sixClassStatus()
    assert.deepEqual(resolveVdev(status, 'sdb3'), { role: 'cache', vdev: 'sdb3', token: '/dev/sdb3' })
    assert.deepEqual(resolveVdev(status, 'sdb4'), { role: 'spare', vdev: 'sdb4', token: '/dev/sdb4' })
    assert.equal(isRemovableVdevRole('cache'), true)
    assert.equal(isRemovableVdevRole('spare'), true)
  })

  it('refuses the special vdev', () => {
    const hit = resolveVdev(sixClassStatus(), 'sdb5')
    assert.equal(hit?.role, 'special')
    assert.equal(isRemovableVdevRole(hit!.role), false)
  })

  it('refuses the dedup vdev', () => {
    const hit = resolveVdev(sixClassStatus(), 'sdb6')
    assert.equal(hit?.role, 'dedup')
    assert.equal(isRemovableVdevRole(hit!.role), false)
  })

  it('refuses the data leaf', () => {
    const hit = resolveVdev(sixClassStatus(), 'sdb1')
    assert.equal(hit?.role, 'data')
    assert.equal(isRemovableVdevRole(hit!.role), false)
  })

  it('answers null for a vdev the pool does not carry', () => {
    assert.equal(resolveVdev(sixClassStatus(), 'sdb9'), null)
  })
})
