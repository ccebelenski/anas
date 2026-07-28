import type { Job, JobAccepted, PoolExpansionReport } from '@anas/shared'
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

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const BY_ID = '/dev/disk/by-id/'
const NEW_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4'
const D1 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'

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

const RZ = 'testpool-rz'

/** Minimal `zpool status -jv` JSON for a 3-disk raidz1 pool. */
function raidzStatus({ degraded = false, reflow = false, resilver = false }: { degraded?: boolean, reflow?: boolean, resilver?: boolean } = {}): string {
  const pool: Record<string, unknown> = {
    name: RZ,
    state: degraded ? 'DEGRADED' : 'ONLINE',
    pool_guid: '11',
    error_count: '0',
    vdevs: {
      [RZ]: {
        name: RZ,
        vdev_type: 'root',
        state: 'ONLINE',
        total_space: '1.38G',
        alloc_space: '280K',
        vdevs: {
          'raidz1-0': {
            name: 'raidz1-0',
            vdev_type: 'raidz',
            state: degraded ? 'DEGRADED' : 'ONLINE',
            total_space: '1.38G',
            alloc_space: '280K',
            vdevs: {
              d1: { name: 'd1', vdev_type: 'disk', state: 'ONLINE', devid: `${D1}-part1`, path: `${BY_ID}${D1}-part1` },
              d2: { name: 'd2', vdev_type: 'disk', state: 'ONLINE', devid: 'scsi-D2-part1', path: `${BY_ID}scsi-D2-part1` },
              d3: { name: 'd3', vdev_type: 'disk', state: 'ONLINE', devid: 'scsi-D3-part1', path: `${BY_ID}scsi-D3-part1` },
            },
          },
        },
      },
    },
  }
  if (reflow) {
    pool.raidz_expand_stats = { expanding_vdev: 'raidz1-0', state: 'COPYING', start_time: '-', end_time: '-', to_reflow: '5G', reflowed: '1G', waiting_for_resilver: '0' }
  }
  if (resilver) {
    pool.scan_stats = { function: 'RESILVER', state: 'SCANNING', start_time: '-', end_time: '-', to_examine: '100G', examined: '25G', processed: '25G', errors: '0' }
  }
  return JSON.stringify({ pools: { [RZ]: pool } })
}

function raidzList(): string {
  return JSON.stringify({ pools: { [RZ]: { name: RZ, state: 'ONLINE', properties: {} } } })
}

function getAll(featureVal: string | null): string {
  const properties = featureVal
    ? { 'feature@raidz_expansion': { value: featureVal, source: { type: 'LOCAL', data: '-' } } }
    : {}
  return JSON.stringify({ pools: { [RZ]: { properties } } })
}

const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

/** Wipe fixtures and seed a raidz pool with configurable gate inputs. */
function seedRaidz(
  server: ReturnType<typeof createServer>,
  opts: { version?: string, feature?: string | null, status?: string } = {},
): void {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  mock.clearFixtures()
  mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: raidzList(), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: opts.status ?? raidzStatus(), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, args: ['get', 'all', '-j'], result: { stdout: getAll(opts.feature === undefined ? 'enabled' : opts.feature), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZFS, args: ['version'], result: { stdout: `zfs-${opts.version ?? '2.3.1'}-1\n`, stderr: '', exitCode: 0 } })
  // Fallbacks for the mutation (attach/online) — no exact match needed.
  mock.addFixture({ command: ZPOOL, result: OK })
  mock.addFixture({ command: ZFS, result: OK })
}

describe('pool expansion (story 3.31)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- GET /pools/:name/expansion ------------------------------------------
  it('GET expansion reports a raidz-expand target with honest capacity', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server)

    const res = await server.inject({ method: 'GET', url: `/v1/pools/${RZ}/expansion`, headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const report = (res.json() as { data: PoolExpansionReport }).data
    assert.equal(report.capability.moduleSupported, true)
    assert.equal(report.capability.featureEnabled, true)
    assert.equal(report.capability.raidzExpandAvailable, true)
    assert.equal(report.busy.busy, false)
    assert.equal(report.targets.length, 1)
    const t = report.targets[0]
    assert.equal(t.vdevName, 'raidz1-0')
    assert.equal(t.kind, 'raidz-expand')
    assert.equal(t.allowed, true)
    assert.ok(t.naiveUsableGainBytes && t.naiveUsableGainBytes > 0)
    // Honest gain never exceeds the naive "one disk" figure.
    assert.ok(t.honestUsableGainBytes !== undefined && t.honestUsableGainBytes <= t.naiveUsableGainBytes!)
    assert.ok(t.advisories.some(a => /parity ratio/i.test(a)))
  })

  it('GET expansion marks targets not-allowed (version) on old ZFS', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server, { version: '2.2.6' })

    const res = await server.inject({ method: 'GET', url: `/v1/pools/${RZ}/expansion`, headers: IDENTITY_HEADERS })
    const report = (res.json() as { data: PoolExpansionReport }).data
    assert.equal(report.capability.moduleSupported, false)
    assert.equal(report.targets[0].allowed, false)
    assert.equal(report.targets[0].reason, 'version')
  })

  // --- raidz-expand dispatch ------------------------------------------------
  it('raidz-expand dispatches `zpool attach <pool> <raidz-vdev> <new>`', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server)
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${RZ}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ targetVdev: 'raidz1-0', newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.raidz-expand')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const call = spy.calls.find(c => c.command === ZPOOL && c.args[0] === 'attach')
    assert.ok(call, 'zpool attach was invoked')
    assert.deepEqual(call!.args, ['attach', RZ, 'raidz1-0', `${BY_ID}${NEW_DISK}`])
  })

  it('raidz-expand refuses on OpenZFS < 2.3.0 (version gate)', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server, { version: '2.2.6' })

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${RZ}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ targetVdev: 'raidz1-0', newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 409)
    const err = res.json().error
    assert.equal(err.reason, 'version')
    assert.match(err.message, /2\.3\.0/)
  })

  it('raidz-expand refuses when feature@raidz_expansion is disabled (flag gate)', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server, { feature: 'disabled' })

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${RZ}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ targetVdev: 'raidz1-0', newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 409)
    const err = res.json().error
    assert.equal(err.reason, 'flag')
    assert.match(err.message, /zpool upgrade/)
  })

  it('raidz-expand refuses while a reflow is in progress (busy gate)', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server, { status: raidzStatus({ reflow: true }) })

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${RZ}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ targetVdev: 'raidz1-0', newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 409)
    const err = res.json().error
    assert.equal(err.reason, 'busy')
    assert.match(err.message, /reflow|try again/i)
  })

  it('raidz-expand rejects a non-raidz target vdev', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server)

    // Ask to raidz-expand a name that exists but is not raidz — swap in a mirror
    // status so the vdev resolves to a mirror.
    const mirrorStatus = raidzStatus().replace('"vdev_type":"raidz"', '"vdev_type":"mirror"').replace('"raidz1-0"', '"mirror-0"').replace('name":"raidz1-0"', 'name":"mirror-0"')
    seedRaidz(server, { status: mirrorStatus })

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${RZ}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ targetVdev: 'mirror-0', newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  // --- mirror-attach & busy gate on the leaf path --------------------------
  it('mirror-attach still works ungated by ZFS version', async () => {
    // Default testpool fixtures = two mirrors, scan FINISHED (not busy). No
    // version fixture is even consulted for a mirror-attach.
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678', newDiskId: 'ata-WDC_WD2003FZEX-00SRLA0_WD-99999999' }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.attach')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    assert.ok(spy.calls.find(c => c.command === ZPOOL && c.args[0] === 'attach'))
  })

  it('mirror-attach refuses while a resilver runs (busy gate)', async () => {
    server = createServer({ mock: true, logger: false })
    seedRaidz(server, { status: raidzStatus({ resilver: true }) })

    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/${RZ}/attach`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: D1, newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'busy')
  })

  // --- replace + online -e side-effect (3.31a) -----------------------------
  it('replace runs `zpool online -e` on the new device afterward', async () => {
    server = createServer({ mock: true, logger: false })
    const spy = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ existingDiskId: 'ata-WDC_WD2003FZEX-00SRLA0_WD-34567890', newDiskId: 'ata-WDC_WD2003FZEX-00SRLA0_WD-99999999', replace: true }),
    })
    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.replace')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    const online = spy.calls.find(c => c.command === ZPOOL && c.args[0] === 'online')
    assert.ok(online, 'zpool online -e was invoked after replace')
    assert.deepEqual(online!.args, ['online', '-e', 'testpool', `${BY_ID}ata-WDC_WD2003FZEX-00SRLA0_WD-99999999`])
  })

  it('rejects a request carrying neither existingDiskId nor targetVdev', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ newDiskId: NEW_DISK }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })
})
