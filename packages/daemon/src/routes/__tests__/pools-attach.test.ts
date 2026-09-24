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
// What `zpool status` reports for those leaves, and therefore what the route
// hands ZFS: the pool's members are PARTITIONS of those disks, and the leaf
// device — not the whole-disk by-id the id is stripped down to — is the one
// spelling that names exactly one of them (vdevs.1 fix batch, GitHub #66).
const EXISTING_LEAF = `${BY_ID}${EXISTING}-part1`
const FAILED_LEAF = `${BY_ID}${FAILED}-part1`
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
      EXISTING_LEAF,
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
    assert.deepEqual(call!.args, ['attach', 'testpool', EXISTING_LEAF, `${BY_ID}${NEW_A}`])
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
      FAILED_LEAF,
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

  // No `zpool status` fixture here: the leaf lookup FAILS OPEN, as every read
  // on this route does, and the request's own by-id spelling stays the device —
  // zpool's error is the answer, never a 500 from us.
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

// --- a by-id PARTITION-backed split device (the #66 layout) ----------------
//
// One SSD partitioned into a log, a cache and a data leaf: the parser strips
// `-partN` to get the DISK's identity, so all three leaves carry the SAME
// `disk.id`. Sent that way the replace dialog drew three identically labelled
// slots and `zpool replace pool /dev/disk/by-id/<disk> <new>` named a device
// the pool does not have — ZFS refuses it. The dialog sends the leaf's
// device-path basename and the route resolves it against the pool's own
// status.

const SSD = 'ata-SSD_SERIAL0001'
const SSD_PART = (n: number) => `${BY_ID}${SSD}-part${n}`
const SPLIT_POOL = 'tank'

/** `zpool status -j` for that pool: data on -part3, log on -part1, cache -part2. */
function splitSsdStatus(): ExecResult {
  const leaf = (part: number, extra: Record<string, unknown> = {}) => ({
    name: `${SSD}-part${part}`,
    vdev_type: 'disk',
    guid: `${part}${part}${part}`,
    path: SSD_PART(part),
    devid: `${SSD}-part${part}`,
    state: 'ONLINE',
    read_errors: '0',
    write_errors: '0',
    checksum_errors: '0',
    ...extra,
  })
  return {
    stdout: JSON.stringify({
      pools: {
        [SPLIT_POOL]: {
          name: SPLIT_POOL,
          state: 'ONLINE',
          pool_guid: '1',
          vdevs: {
            [SPLIT_POOL]: {
              name: SPLIT_POOL,
              vdev_type: 'root',
              state: 'ONLINE',
              vdevs: {
                'mirror-0': {
                  name: 'mirror-0',
                  vdev_type: 'mirror',
                  state: 'ONLINE',
                  read_errors: '0',
                  write_errors: '0',
                  checksum_errors: '0',
                  vdevs: {
                    [`${SSD}-part3`]: leaf(3),
                    'ata-OTHER-part1': {
                      ...leaf(1),
                      name: 'ata-OTHER-part1',
                      path: `${BY_ID}ata-OTHER-part1`,
                      devid: 'ata-OTHER-part1',
                    },
                  },
                },
              },
            },
          },
          logs: { [`${SSD}-part1`]: { ...leaf(1), class: 'log' } },
          l2cache: { [`${SSD}-part2`]: { ...leaf(2), class: 'l2cache' } },
        },
      },
    }),
    stderr: '',
    exitCode: 0,
  }
}

function splitSsdServer(): ReturnType<typeof createServer> {
  const server = createServer({ mock: true, logger: false })
  const mock = (server as unknown as { executor: MockExecutor }).executor
  mock.clearFixtures()
  mock.addFixture({
    command: '/usr/sbin/zpool',
    args: ['list', '-j'],
    result: { stdout: JSON.stringify({ pools: { [SPLIT_POOL]: { name: SPLIT_POOL, state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 },
  })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: splitSsdStatus() })
  mock.addFixture({ command: '/usr/sbin/zpool', args: undefined, result: { stdout: '', stderr: '', exitCode: 0 } })
  return server
}

describe('attach/replace on a by-id partition-backed split device (#66)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function post(existingDiskId: string, replace = true) {
    return server!.inject({
      method: 'POST',
      url: `/v1/pools/${SPLIT_POOL}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId, newDiskId: NEW_A, replace }),
    })
  }

  it('the LOG partition basename replaces the log leaf — not the cache, not the disk', async () => {
    server = splitSsdServer()
    const spy = spyExecutor(server)

    const res = await post(`${SSD}-part1`)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const call = spy.calls.find(c => c.args[0] === 'replace')
    assert.deepEqual(call!.args, ['replace', SPLIT_POOL, SSD_PART(1), `${BY_ID}${NEW_A}`])
  })

  it('the CACHE partition basename names the cache leaf', async () => {
    server = splitSsdServer()
    const spy = spyExecutor(server)

    const res = await post(`${SSD}-part2`)
    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.deepEqual(
      spy.calls.find(c => c.args[0] === 'replace')!.args,
      ['replace', SPLIT_POOL, SSD_PART(2), `${BY_ID}${NEW_A}`],
    )
  })

  it('the data partition attaches a mirror leg to the leaf, not the disk', async () => {
    server = splitSsdServer()
    const spy = spyExecutor(server)

    const res = await post(`${SSD}-part3`, false)
    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.deepEqual(
      spy.calls.find(c => c.args[0] === 'attach')!.args,
      ['attach', SPLIT_POOL, SSD_PART(3), `${BY_ID}${NEW_A}`],
    )
  })

  it('the STRIPPED disk id is refused as ambiguous — nothing is run', async () => {
    server = splitSsdServer()
    const spy = spyExecutor(server)

    const res = await post(SSD)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, new RegExp(`names more than one device in pool ${SPLIT_POOL}`))
    assert.match(res.json().error.message, /log ata-SSD_SERIAL0001-part1/)
    assert.match(res.json().error.message, /cache ata-SSD_SERIAL0001-part2/)
    assert.equal(spy.calls.find(c => c.args[0] === 'replace' || c.args[0] === 'attach'), undefined)
  })

  it('refuses a leaf the pool does not carry, naming pool and device', async () => {
    server = splitSsdServer()
    const spy = spyExecutor(server)

    const res = await post(`${SSD}-part9`)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `pool ${SPLIT_POOL} carries no vdev '${SSD}-part9'`)
    assert.equal(spy.calls.find(c => c.args[0] === 'replace'), undefined)
  })
})
