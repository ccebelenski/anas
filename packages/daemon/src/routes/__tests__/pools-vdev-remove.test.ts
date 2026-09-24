import type { Job, JobAccepted, VdevGroup, VdevState, VdevType } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { ParsedPoolStatus } from '../../parsers/zpool-status.js'
import type { ResolvedVdev } from '../../services/zfs-vdev-remove.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isRemovableVdevRole } from '@anas/shared'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'
import { ambiguousVdevMessage, isVdevRefusal, unknownVdevMessage } from '../../services/zfs-vdev-leaf.js'
import {
  NON_REMOVABLE_VDEV_MESSAGE,
  resolveVdev,
  spareInUseMessage,
  unreadablePoolMessage,
} from '../../services/zfs-vdev-remove.js'

/**
 * Story vdevs.2 — POST /v1/pools/:name/vdevs/remove.
 *
 * Route cases go the whole way through the route, the parser and the mock
 * executor — over the shipped `zpool-status-online.json` for the plain shapes
 * and over the stunt-node capture `zpool-status-multi-cache-spare-2.4.4.json`
 * for the by-id partition-backed one. Resolution cases the captures do not
 * carry (a split SSD's log and cache, a spare ZFS has put to work) ask the
 * SAME `resolveVdev` + `isRemovableVdevRole` pair the route asks, over a
 * `ParsedPoolStatus` built by hand — the parser's own output type.
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
  return serverForPool(mockFixtures.zpoolList(), statuses.map(asResult), remove)
}

/**
 * The same server for an arbitrary pool name and a scripted sequence of RAW
 * `zpool status -jv` results — so a captured fixture (or a deliberately failing
 * read) can be handed to the route as ZFS itself would.
 */
function serverForPool(
  list: ExecResult,
  statuses: ExecResult[],
  remove?: ExecResult,
): ReturnType<typeof createServer> {
  const server = createServer({ mock: true, logger: false })
  const mock = (server as unknown as { executor: MockExecutor }).executor
  mock.clearFixtures()
  mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: list })
  mock.addFixture({ command: ZPOOL, args: ['status', '-jv'], results: statuses })
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

// --- PVE-managed pools are hands-off (story 3.25, the whole-pool rule) -----
//
// A pool any `zfspool` storage in storage.cfg names belongs to PVE — the same
// door the mountpoint verb stands behind, and the same 400.
describe('remove-vdev: a PVE-managed pool is refused', () => {
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

// --- the six vdev classes, over a status built by hand --------------------
//
// `ParsedPoolStatus` is the parser's own output type, so these pin the
// RESOLUTION — which leaf a name fits and what `zpool remove` is handed —
// without a whole HTTP round trip. The container shape (a section's bare
// leaves under one vdev named after the section) is what the parser produces;
// the fixture-backed cases below prove that end to end.

function leaf(name: string, path: string, state: VdevState = 'ONLINE') {
  return { id: name, path: path as `/dev/${string}`, state, readErrors: 0, writeErrors: 0, checksumErrors: 0, slowIos: 0 }
}

function container(name: string, type: VdevType, disks: ReturnType<typeof leaf>[], state: VdevState = 'ONLINE') {
  return { name, type, state, readErrors: 0, writeErrors: 0, checksumErrors: 0, disks }
}

/** The six-class throwaway pool of `zpool-status-all-vdev-classes-2.4.4.json`. */
function sixClassStatus(): ParsedPoolStatus {
  const groups: VdevGroup[] = [
    { role: 'data', vdevs: [container('sdb1', 'disk', [leaf('sdb1', '/dev/sdb1')])] },
    { role: 'log', vdevs: [container('logs', 'disk', [leaf('sdb2', '/dev/sdb2')])] },
    { role: 'cache', vdevs: [container('cache', 'disk', [leaf('sdb3', '/dev/sdb3')])] },
    { role: 'spare', vdevs: [container('spares', 'spare', [leaf('sdb4', '/dev/sdb4', 'AVAIL')], 'AVAIL')] },
    { role: 'special', vdevs: [container('special', 'disk', [leaf('sdb5', '/dev/sdb5')])] },
    { role: 'dedup', vdevs: [container('dedup', 'disk', [leaf('sdb6', '/dev/sdb6')])] },
  ]
  return { name: 'gtvdev', state: 'ONLINE', guid: '1', errorCount: 0, vdevGroups: groups, scan: null }
}

/** The same pool after a mirrored log has been added by CLI. */
function mirroredLogStatus(): ParsedPoolStatus {
  const status = sixClassStatus()
  status.vdevGroups = status.vdevGroups.map(g => g.role === 'log'
    ? { role: 'log' as const, vdevs: [container('mirror-1', 'mirror', [leaf('sdb2', '/dev/sdb2'), leaf('sdb3', '/dev/sdb3')])] }
    : g)
  return status
}

describe('remove-vdev: the six vdev classes, resolved as the route resolves them', () => {
  /** The resolution, asserting it is not one of the refusal answers. */
  function hitOf(status: ParsedPoolStatus, name: string): ResolvedVdev {
    const lookup = resolveVdev(status, name)
    assert.ok(lookup && !isVdevRefusal(lookup), `expected a vdev for '${name}', got ${JSON.stringify(lookup)}`)
    return lookup
  }

  it('allows a single log leaf and hands zpool the leaf', () => {
    const hit = hitOf(sixClassStatus(), 'sdb2')
    assert.deepEqual(hit, { role: 'log', vdev: 'logs', token: '/dev/sdb2' })
    assert.equal(isRemovableVdevRole(hit.role), true)
  })

  it('allows a mirrored log by its mirror-N name', () => {
    const hit = hitOf(mirroredLogStatus(), 'mirror-1')
    assert.deepEqual(hit, { role: 'log', vdev: 'mirror-1', token: 'mirror-1' })
    assert.equal(isRemovableVdevRole(hit.role), true)
  })

  it('names the mirror, not the leg, when a leaf of a mirrored log is given', () => {
    assert.deepEqual(hitOf(mirroredLogStatus(), 'sdb2'), { role: 'log', vdev: 'mirror-1', token: 'mirror-1' })
  })

  it('allows a cache leaf and a spare leaf', () => {
    const status = sixClassStatus()
    assert.deepEqual(hitOf(status, 'sdb3'), { role: 'cache', vdev: 'cache', token: '/dev/sdb3' })
    assert.deepEqual(hitOf(status, 'sdb4'), { role: 'spare', vdev: 'spares', token: '/dev/sdb4' })
    assert.equal(isRemovableVdevRole('cache'), true)
    assert.equal(isRemovableVdevRole('spare'), true)
  })

  it('refuses the special vdev', () => {
    assert.equal(isRemovableVdevRole(hitOf(sixClassStatus(), 'sdb5').role), false)
  })

  it('refuses the dedup vdev', () => {
    assert.equal(isRemovableVdevRole(hitOf(sixClassStatus(), 'sdb6').role), false)
  })

  it('refuses the data leaf', () => {
    assert.equal(isRemovableVdevRole(hitOf(sixClassStatus(), 'sdb1').role), false)
  })

  it('answers null for a vdev the pool does not carry', () => {
    assert.equal(resolveVdev(sixClassStatus(), 'sdb9'), null)
  })

  it('answers null for a synthetic container name — the leaf is the unit', () => {
    const status = sixClassStatus()
    for (const name of ['logs', 'cache', 'spares', 'special', 'dedup'])
      assert.equal(resolveVdev(status, name), null, name)
  })
})

// --- a by-id PARTITION-backed split device (the #66 layout) ----------------
//
// One SSD carrying the log on -part1 and the cache on -part2: the parser
// strips `-partN` to get the DISK's identity, so both leaves carry the same
// `disk.id`. Taking the first match would remove the SLOG of an operator who
// picked the L2ARC, and report success for role `log`.

const SSD = 'ata-SSD_SERIAL0001'
const SSD_PART = (n: number) => `/dev/disk/by-id/${SSD}-part${n}` as const

/** log on -part1, cache on -part2, data on -part3 — one disk, three leaves. */
function splitSsdStatus(): ParsedPoolStatus {
  const groups: VdevGroup[] = [
    { role: 'data', vdevs: [container('mirror-0', 'mirror', [leaf(SSD, SSD_PART(3)), leaf('ata-OTHER', '/dev/disk/by-id/ata-OTHER-part1')])] },
    { role: 'log', vdevs: [container('logs', 'disk', [leaf(SSD, SSD_PART(1))])] },
    { role: 'cache', vdevs: [container('cache', 'disk', [leaf(SSD, SSD_PART(2))])] },
  ]
  return { name: 'tank', state: 'ONLINE', guid: '1', errorCount: 0, vdevGroups: groups, scan: null }
}

describe('remove-vdev: a token that names two leaves of one disk is refused', () => {
  it('the cache partition names the CACHE leaf only', () => {
    assert.deepEqual(
      resolveVdev(splitSsdStatus(), `${SSD}-part2`),
      { role: 'cache', vdev: 'cache', token: SSD_PART(2) },
    )
  })

  it('the log partition names the LOG leaf only', () => {
    assert.deepEqual(
      resolveVdev(splitSsdStatus(), `${SSD}-part1`),
      { role: 'log', vdev: 'logs', token: SSD_PART(1) },
    )
  })

  it('the full device path names exactly one leaf too', () => {
    assert.deepEqual(
      resolveVdev(splitSsdStatus(), SSD_PART(2)),
      { role: 'cache', vdev: 'cache', token: SSD_PART(2) },
    )
  })

  it('the STRIPPED disk id is refused, naming every candidate', () => {
    const lookup = resolveVdev(splitSsdStatus(), SSD)
    assert.ok(lookup && isVdevRefusal(lookup))
    assert.equal(
      lookup.message,
      ambiguousVdevMessage('tank', SSD, ['data mirror-0', `log ${SSD}-part1`, `cache ${SSD}-part2`]),
    )
  })
})

// --- a spare ZFS has put to work -------------------------------------------
//
// An active spare is listed TWICE: under the data vdev it is patching (inside
// `spare-N`, which the parser flattens into the mirror's disks) and in the
// spares section as INUSE. Matched in the data walk it came back as a DATA
// leaf, refused with the evacuation sentence — the wrong reason entirely, and
// one step away from handing `zpool remove` the whole data mirror.

const SPARE_IN_USE = 'ata-SPARE_0001'

function inUseSpareStatus(): ParsedPoolStatus {
  const spareLeaf = () => leaf(SPARE_IN_USE, `/dev/disk/by-id/${SPARE_IN_USE}-part1`, 'INUSE')
  const groups: VdevGroup[] = [
    {
      role: 'data',
      vdevs: [container('mirror-0', 'mirror', [
        leaf('ata-DATA_0001', '/dev/disk/by-id/ata-DATA_0001-part1'),
        leaf('ata-DATA_0002', '/dev/disk/by-id/ata-DATA_0002-part1', 'REMOVED'),
        spareLeaf(),
      ], 'DEGRADED')],
    },
    { role: 'spare', vdevs: [container('spares', 'spare', [spareLeaf()], 'INUSE')] },
  ]
  return { name: 'tank', state: 'DEGRADED', guid: '1', errorCount: 0, vdevGroups: groups, scan: null }
}

describe('remove-vdev: an in-use spare gets its own sentence', () => {
  it('refuses it by name, naming the vdev it is patching', () => {
    const lookup = resolveVdev(inUseSpareStatus(), SPARE_IN_USE)
    assert.ok(lookup && isVdevRefusal(lookup))
    assert.equal(lookup.message, spareInUseMessage(SPARE_IN_USE, 'mirror-0'))
  })

  it('and by its device path — never as a leaf of the data mirror', () => {
    const lookup = resolveVdev(inUseSpareStatus(), `${SPARE_IN_USE}-part1`)
    assert.ok(lookup && isVdevRefusal(lookup))
    assert.equal(lookup.message, spareInUseMessage(`${SPARE_IN_USE}-part1`, 'mirror-0'))
  })

  it('the data leaves of the same mirror still resolve as data', () => {
    const hit = resolveVdev(inUseSpareStatus(), 'ata-DATA_0001')
    assert.ok(hit && !isVdevRefusal(hit))
    assert.equal(hit.role, 'data')
  })
})

// --- the route, over the CAPTURED by-id partition-backed pool --------------
//
// `zpool-status-multi-cache-spare-2.4.4.json` is a stunt-node capture (ZFS
// 2.4.4 / PVE 9.2.20, 2026-09-24) of `vdev-fixture.sh up-multi`: data on
// -part1, log on -part2, TWO cache leaves on -part3/-part6 and TWO spares on
// -part4/-part5, all by-id partitions of ONE disk. Every leaf therefore shares
// one `disk.id` — the shape that made the first-match lookup dangerous.

const MULTI_POOL = 'gtvdev'
const MULTI_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'
const MULTI_PART = (n: number) => `/dev/disk/by-id/${MULTI_DISK}-part${n}`
const MULTI_LIST: ExecResult = {
  stdout: JSON.stringify({ pools: { [MULTI_POOL]: { name: MULTI_POOL, state: 'ONLINE', properties: {} } } }),
  stderr: '',
  exitCode: 0,
}

function multiStatus(): ExecResult {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/zfs/zpool-status-multi-cache-spare-2.4.4.json')
  return { stdout: readFileSync(path, 'utf-8'), stderr: '', exitCode: 0 }
}

/** The same capture with one leaf dropped from a pool-level section. */
function multiStatusWithout(section: string, part: number): ExecResult {
  const doc = JSON.parse(multiStatus().stdout) as { pools: Record<string, Record<string, Record<string, unknown>>> }
  delete doc.pools[MULTI_POOL][section][`${MULTI_DISK}-part${part}`]
  return { stdout: JSON.stringify(doc), stderr: '', exitCode: 0 }
}

describe('remove-vdev over a by-id partition-backed pool (the #66 layout)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function post(vdev: string) {
    return server!.inject({
      method: 'POST',
      url: `/v1/pools/${MULTI_POOL}/vdevs/remove`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev }),
    })
  }

  it('the cache partition takes out the CACHE leaf — the log is untouched', async () => {
    server = serverForPool(MULTI_LIST, [multiStatus(), multiStatusWithout('l2cache', 3)])

    const res = await post(`${MULTI_DISK}-part3`)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal((job.result as { role: string }).role, 'cache')
    assert.deepEqual(removeCall(server), ['remove', MULTI_POOL, MULTI_PART(3)])
  })

  it('the second cache leaf comes out on its own — one container, one leaf at a time', async () => {
    server = serverForPool(MULTI_LIST, [multiStatus(), multiStatusWithout('l2cache', 6)])

    const res = await post(`${MULTI_DISK}-part6`)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(removeCall(server), ['remove', MULTI_POOL, MULTI_PART(6)])
  })

  it('a spare comes out by its partition, leaving the other spare alone', async () => {
    server = serverForPool(MULTI_LIST, [multiStatus(), multiStatusWithout('spares', 4)])

    const res = await post(`${MULTI_DISK}-part4`)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(removeCall(server), ['remove', MULTI_POOL, MULTI_PART(4)])
  })

  it('the stripped disk id is refused as ambiguous — nothing is removed', async () => {
    server = serverForPool(MULTI_LIST, [multiStatus()])

    const res = await post(MULTI_DISK)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /names more than one device in pool gtvdev/)
    assert.match(res.json().error.message, /name the one you mean by its device/)
    assert.equal(removeCall(server), undefined)
  })
})

// --- the settle poll fails CLOSED ------------------------------------------
//
// `zpool status` exiting non-zero is not an answer. Reporting the removal done
// on an unreadable read tells the operator the vdev came out when nothing
// verified it.

describe('remove-vdev: the settle poll only completes on an answer', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_VDEV_REMOVE_SETTLE_MS
  })

  it('keeps polling through a failed status read and completes when the vdev is gone', async () => {
    server = serverForPool(MULTI_LIST, [
      multiStatus(),
      { stdout: '', stderr: 'cannot open \'gtvdev\': pool I/O is currently suspended', exitCode: 1 },
      multiStatusWithout('l2cache', 3),
    ])

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${MULTI_POOL}/vdevs/remove`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: `${MULTI_DISK}-part3` }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  it('fails the job with the status error when every read fails', async () => {
    process.env.ANAS_VDEV_REMOVE_SETTLE_MS = '0'
    server = serverForPool(MULTI_LIST, [
      multiStatus(),
      { stdout: '', stderr: 'cannot open \'gtvdev\': no such pool', exitCode: 1 },
    ])

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${MULTI_POOL}/vdevs/remove`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: `${MULTI_DISK}-part3` }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /could not be read back/)
    assert.match(job.error!.message, /no such pool/)
  })

  // The OTHER unreadable answer, and the quieter one: `zpool status` exits 0
  // and simply does not carry the pool any more. Nothing verified that the
  // vdev came out — the pool it belonged to is the thing that went missing —
  // so the job must say so rather than report a removal it never saw.
  it('fails the job when status exits 0 but no longer carries the pool', async () => {
    process.env.ANAS_VDEV_REMOVE_SETTLE_MS = '0'
    server = serverForPool(MULTI_LIST, [
      multiStatus(),
      { stdout: JSON.stringify({ pools: {} }), stderr: '', exitCode: 0 },
    ])

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${MULTI_POOL}/vdevs/remove`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev: `${MULTI_DISK}-part3` }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(
      job.error!.message,
      unreadablePoolMessage(MULTI_POOL, 'zpool status no longer reports the pool'),
    )
    // The removal itself WAS run — this is the read-back that failed, and the
    // job is honest about which half of the operation it could not confirm.
    assert.deepEqual(removeCall(server), ['remove', MULTI_POOL, MULTI_PART(3)])
  })
})

// --- an in-use spare, through the whole route ------------------------------
//
// `zpool-status-spare-active.json` is a real capture of a spare ZFS has put to
// work: HOT3 is listed inside `mirror-0`'s `spare-1` (which the parser
// flattens into the mirror's disks) AND in the pool's `spares` section as
// INUSE. Read as a member of the mirror it came back role `data` and was
// refused with the evacuation sentence — the wrong reason, one step away from
// handing `zpool remove` the whole data mirror.

describe('remove-vdev: an in-use spare is refused end to end', () => {
  const SPARED_POOL = 'testpool'
  const SPARED_ID = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT3'

  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function spareActiveStatus(): ExecResult {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/zfs/zpool-status-spare-active.json')
    return { stdout: readFileSync(path, 'utf-8'), stderr: '', exitCode: 0 }
  }

  async function post(vdev: string) {
    return server!.inject({
      method: 'POST',
      url: `/v1/pools/${SPARED_POOL}/vdevs/remove`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev }),
    })
  }

  it('400s with the spare sentence, naming the vdev it is patching', async () => {
    server = serverForPool(mockFixtures.zpoolList(), [spareActiveStatus()])

    const res = await post(SPARED_ID)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(res.json().error.message, spareInUseMessage(SPARED_ID, 'mirror-0'))
    assert.equal(removeCall(server), undefined)
  })

  it('and by its partition basename — never as a data leaf', async () => {
    server = serverForPool(mockFixtures.zpoolList(), [spareActiveStatus()])

    const res = await post(`${SPARED_ID}-part1`)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, spareInUseMessage(`${SPARED_ID}-part1`, 'mirror-0'))
    assert.notEqual(res.json().error.message, NON_REMOVABLE_VDEV_MESSAGE)
    assert.equal(removeCall(server), undefined)
  })
})

// --- a BASENAME that collides across classes -------------------------------
//
// The stripped by-id is not the only spelling two leaves can share. A pool
// mixing a by-id partition with a device-mapper alias of the same name gives
// two DIFFERENT devices, in two different classes, the same device-path
// basename — the very token the dialog sends. It must be refused, not guessed
// at, exactly as the stripped id is.

describe('remove-vdev: a basename that names two classes is refused', () => {
  const DM_POOL = 'tank'

  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** log on `/dev/disk/by-id/ssd-part1`, cache on `/dev/mapper/ssd-part1`. */
  function collidingStatus(): ExecResult {
    const counters = { read_errors: '0', write_errors: '0', checksum_errors: '0' }
    return {
      stdout: JSON.stringify({
        pools: {
          [DM_POOL]: {
            name: DM_POOL,
            state: 'ONLINE',
            pool_guid: '1',
            error_count: '0',
            vdevs: {
              [DM_POOL]: {
                name: DM_POOL,
                vdev_type: 'root',
                state: 'ONLINE',
                vdevs: {
                  'ata-DATA-part1': {
                    name: 'ata-DATA-part1',
                    vdev_type: 'disk',
                    path: '/dev/disk/by-id/ata-DATA-part1',
                    devid: 'ata-DATA-part1',
                    state: 'ONLINE',
                    ...counters,
                  },
                },
              },
            },
            logs: {
              'ssd-part1': {
                name: 'ssd-part1',
                vdev_type: 'disk',
                path: '/dev/disk/by-id/ssd-part1',
                devid: 'ssd-part1',
                class: 'log',
                state: 'ONLINE',
                ...counters,
              },
            },
            l2cache: {
              'dm-ssd': {
                name: 'dm-ssd',
                vdev_type: 'disk',
                path: '/dev/mapper/ssd-part1',
                class: 'l2cache',
                state: 'ONLINE',
                ...counters,
              },
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    }
  }

  /** The same pool with no `logs` section — what a successful remove leaves. */
  function collidingStatusWithoutLog(): ExecResult {
    const doc = JSON.parse(collidingStatus().stdout) as { pools: Record<string, Record<string, unknown>> }
    delete doc.pools[DM_POOL].logs
    return { stdout: JSON.stringify(doc), stderr: '', exitCode: 0 }
  }

  const DM_LIST: ExecResult = {
    stdout: JSON.stringify({ pools: { [DM_POOL]: { name: DM_POOL, state: 'ONLINE', properties: {} } } }),
    stderr: '',
    exitCode: 0,
  }

  async function post(vdev: string) {
    return server!.inject({
      method: 'POST',
      url: `/v1/pools/${DM_POOL}/vdevs/remove`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ vdev }),
    })
  }

  it('the shared BASENAME names both and is refused, naming the candidates', async () => {
    server = serverForPool(DM_LIST, [collidingStatus()])

    const res = await post('ssd-part1')
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.json().error.message,
      ambiguousVdevMessage(DM_POOL, 'ssd-part1', ['log ssd-part1', 'cache ssd-part1']),
    )
    assert.equal(removeCall(server), undefined)
  })

  it('each leaf still comes out under a spelling that names only it', async () => {
    server = serverForPool(DM_LIST, [collidingStatus(), collidingStatusWithoutLog()])

    // The by-id leaf's own id fits the LOG alone (the dm leaf's id is dm-ssd).
    const res = await post('ssd')
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(removeCall(server), ['remove', DM_POOL, '/dev/disk/by-id/ssd-part1'])
  })
})
