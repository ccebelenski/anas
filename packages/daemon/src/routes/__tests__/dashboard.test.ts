import type { JobBrief, PoolTelemetry, StatusSummary, Telemetry } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
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

describe('GET /v1/telemetry — nested pool → vdev → disk tree', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function fetchTelemetry(): Promise<Telemetry> {
    const res = await server!.inject({ method: 'GET', url: '/v1/telemetry', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: Telemetry }).data
  }

  it('nests pools → vdevs[] → disks[] and drops the top-level disks[]', async () => {
    server = createServer({ mock: true, logger: false })
    const t = await fetchTelemetry()

    // The old flat `disks[]` is gone.
    assert.equal((t as unknown as { disks?: unknown }).disks, undefined)

    const pool = t.pools.find(p => p.name === 'testpool') as PoolTelemetry
    assert.ok(pool, 'testpool present')
    // Pool-level I/O = the pool row (busy first sample is the since-boot avg; the
    // route uses the LAST/interval sample, which is idle → zeros + null latency).
    assert.equal(pool.readBytesPerSec, 0)
    assert.equal(pool.readLatencyNs, null)

    // Three mirror vdevs, each with its two leaf disks.
    const vdevNames = pool.vdevs.map(v => v.name)
    assert.deepEqual(vdevNames, ['mirror-0', 'mirror-1', 'mirror-2'])
    for (const v of pool.vdevs)
      assert.equal(v.disks.length, 2, `${v.name} has 2 disks`)

    // Leaf disks carry only the mapped id (no pool/vdev fields — implied by nesting).
    const mirror0 = pool.vdevs.find(v => v.name === 'mirror-0')!
    const diskKeys = Object.keys(mirror0.disks[0]).sort()
    assert.ok(diskKeys.includes('id'))
    assert.ok(!diskKeys.includes('pool'))
    assert.ok(!diskKeys.includes('vdev'))
  })

  it('joins vdev type/role/state from `zpool status` topology', async () => {
    server = createServer({ mock: true, logger: false })
    const t = await fetchTelemetry()
    const pool = t.pools.find(p => p.name === 'testpool')!

    // mirror-0 / mirror-1 exist in the status fixture → joined from topology.
    const mirror0 = pool.vdevs.find(v => v.name === 'mirror-0')!
    assert.equal(mirror0.type, 'mirror')
    assert.equal(mirror0.role, 'data')
    assert.equal(mirror0.state, 'ONLINE')

    // mirror-2 is NOT in the status fixture → name-derived fallback (type from
    // the `mirror` prefix, role 'data', state 'ONLINE').
    const mirror2 = pool.vdevs.find(v => v.name === 'mirror-2')!
    assert.equal(mirror2.type, 'mirror')
    assert.equal(mirror2.role, 'data')
    assert.equal(mirror2.state, 'ONLINE')
  })

  it('maps iostat leaf kernel names to stable by-id identities', async () => {
    server = createServer({ mock: true, logger: false })
    const t = await fetchTelemetry()
    const pool = t.pools.find(p => p.name === 'testpool')!
    const mirror0 = pool.vdevs.find(v => v.name === 'mirror-0')!
    // `sdb` → by-id via the disk-by-id listing; an already-by-id leaf stays verbatim.
    for (const d of mirror0.disks)
      assert.match(d.id, /^(?:scsi|ata|wwn)-|_/)
  })

  it('falls open to name-derived topology when `zpool status` is unavailable', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as any).executor as MockExecutor
    // The mock returns the FIRST matching fixture, so rebuild the minimal set a
    // telemetry sample needs, with a FAILING `zpool status` (no topology join).
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['iostat', '-plv', 'testpool', '1', '2'], result: mockFixtures.zpoolIostat() })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: 'no pools available', exitCode: 1 } })

    const t = await fetchTelemetry()
    const pool = t.pools.find(p => p.name === 'testpool')!
    assert.ok(pool, 'pool still built from iostat without topology')
    // Every vdev falls back: type from its `mirror` name prefix, role 'data',
    // state 'ONLINE' — and disks are still nested.
    for (const v of pool.vdevs) {
      assert.equal(v.type, 'mirror')
      assert.equal(v.role, 'data')
      assert.equal(v.state, 'ONLINE')
      assert.equal(v.disks.length, 2)
    }
  })
})

describe('GET /v1/status — job durations', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Poll /v1/status until the given job id appears with a terminal status. */
  async function statusJob(srv: ReturnType<typeof createServer>, id: string): Promise<JobBrief> {
    for (let i = 0; i < 50; i++) {
      const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
      const summary = (res.json() as { data: StatusSummary }).data
      const job = summary.jobs.find(j => j.id === id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`job ${id} not terminal in /v1/status`)
  }

  it('reports finishedAt + durationMs for a finished job', async () => {
    server = createServer({ mock: true, logger: false })

    // Submit a real job (a scrub) so the queue has a finished record.
    const accepted = await server.inject({ method: 'POST', url: '/v1/pools/testpool/scrub', headers: IDENTITY_HEADERS })
    const jobId = (accepted.json() as { job: { id: string } }).job.id

    const brief = await statusJob(server, jobId)
    assert.equal(brief.status, 'completed')
    assert.ok(brief.startedAt, 'startedAt present')
    assert.ok(brief.finishedAt, 'finishedAt present for a finished job')
    assert.equal(typeof brief.durationMs, 'number')
    assert.ok(brief.durationMs! >= 0)
    // durationMs == finishedAt − startedAt for a finished job.
    const expected = Date.parse(brief.finishedAt!) - Date.parse(brief.startedAt!)
    assert.equal(brief.durationMs, Math.max(0, expected))
  })
})
