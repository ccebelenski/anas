import type { Job, PeriodicScrubState } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { createServer } from '../../server.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { scrubRoutes } from '../scrub.js'

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'

/**
 * The dev-mock AHR topology (the stage-0 `ahr0` pool) on a fresh executor, with
 * the /proc/mdstat read swappable — the mock server registers the IDLE capture
 * and first fixture wins, so a running-check test has to bring its own read
 * layer. Same fixture loader, same registration idiom as the AHR route tests.
 */
function mockAhrTopologyExecutor(executor: MockExecutor, mdstat: ExecResult): MockExecutor {
  executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mdstat })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
  executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
  executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
  executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
  executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
  executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })
  return executor
}

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function zpoolListJson(names: string[]): string {
  const pools: Record<string, unknown> = {}
  for (const name of names)
    pools[name] = { name, state: 'ONLINE', properties: {} }
  return JSON.stringify({ pools })
}

/**
 * `zpool status -jv` with a completed scrub on `tank` and none on `rpool` — the
 * two last-scrub shapes the Scrubs screen has to render (a verdict, and an
 * honest "no record"). Trimmed to the fields the last-scrub read uses.
 */
function zpoolStatusJson(): string {
  return JSON.stringify({
    pools: {
      tank: {
        name: 'tank',
        state: 'ONLINE',
        pool_guid: '1',
        scan_stats: {
          function: 'SCRUB',
          state: 'FINISHED',
          start_time: 'Sun Aug  3 02:00:00 UTC 2026',
          end_time: 'Sun Aug  3 07:23:11 UTC 2026',
          to_examine: '8.20T',
          examined: '8.20T',
          processed: '0B',
          errors: '0',
        },
        vdevs: {},
        error_count: '0',
      },
      // Never scrubbed — no scan record at all.
      rpool: { name: 'rpool', state: 'ONLINE', pool_guid: '2', vdevs: {}, error_count: '0' },
    },
  })
}

/**
 * The same read with a scrub IN PROGRESS on `tank` (`state: SCANNING`, half the
 * pool examined) and nothing at all on `rpool` — the running/idle pair the
 * stage-6 Last scrub cell has to tell apart.
 */
function zpoolStatusScanningJson(): string {
  return JSON.stringify({
    pools: {
      tank: {
        name: 'tank',
        state: 'ONLINE',
        pool_guid: '1',
        scan_stats: {
          function: 'SCRUB',
          state: 'SCANNING',
          start_time: 'Sun Aug  3 02:00:00 UTC 2026',
          end_time: '-',
          to_examine: '8.20T',
          examined: '4.10T',
          processed: '0B',
          errors: '0',
        },
        vdevs: {},
        error_count: '0',
      },
      rpool: { name: 'rpool', state: 'ONLINE', pool_guid: '2', vdevs: {}, error_count: '0' },
    },
  })
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('periodic scrub routes — ZFS property (Epic 17.5)', () => {
  let server: ReturnType<typeof createServer>

  beforeEach(() => {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['tank', 'rpool']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'value', 'org.debian:periodic-scrub', 'tank'], result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'value', 'org.debian:periodic-scrub', 'rpool'], result: { stdout: 'disable\n', stderr: '', exitCode: 0 } })
    // zfs set + any other zfs: command-only success. AHR reads fail (unmocked) →
    // ahrPoolNames fail-opens to [] so GET returns only the ZFS pools.
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
  })

  it('GET /scrub reports each ZFS pool uniformly (default on; disable → off)', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const states = (res.json() as { data: PeriodicScrubState[] }).data
    const byPool = new Map(states.map(s => [s.target.pool, s]))
    assert.equal(byPool.get('tank')?.enabled, true)
    assert.equal(byPool.get('rpool')?.enabled, false)
    assert.ok(states.every(s => s.mechanism === 'zfs-property' && s.cadence === 'monthly'))
  })

  it('GET /scrub carries each ZFS pool\'s last completed scrub verdict', async () => {
    mockOf(server).addFixture({
      command: ZPOOL,
      args: ['status', '-jv'],
      result: { stdout: zpoolStatusJson(), stderr: '', exitCode: 0 },
    })
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    const byPool = new Map((res.json() as { data: PeriodicScrubState[] }).data.map(s => [s.target.pool, s]))
    const tank = byPool.get('tank')?.lastScrub
    assert.ok(tank, 'expected tank to carry a last-scrub verdict')
    assert.equal(tank.function, 'SCRUB')
    assert.equal(tank.state, 'FINISHED')
    assert.equal(tank.repairedBytes, 0)
    assert.equal(tank.errors, 0)
    assert.equal(tank.finishedAt, '2026-08-03T07:23:11.000Z')
    assert.equal(tank.durationSeconds, 19391)
    // A pool ZFS records no completed pass for reads as null — never fabricated.
    assert.equal(byPool.get('rpool')?.lastScrub, null)
  })

  it('GET /scrub carries a RUNNING pass in place of a verdict (stage 6)', async () => {
    mockOf(server).addFixture({
      command: ZPOOL,
      args: ['status', '-jv'],
      result: { stdout: zpoolStatusScanningJson(), stderr: '', exitCode: 0 },
    })
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    const byPool = new Map((res.json() as { data: PeriodicScrubState[] }).data.map(s => [s.target.pool, s]))
    assert.deepEqual(byPool.get('tank')?.running, { function: 'SCRUB', percent: 50 })
    // ZFS keeps ONE scan record per pool: while it holds progress there is no
    // verdict to report, and we report none rather than a stale one.
    assert.equal(byPool.get('tank')?.lastScrub, null)
    // An idle pool carries no `running` key at all.
    assert.equal('running' in (byPool.get('rpool') as object), false)
  })

  it('GET /scrub still answers when the status read fails (no verdict, nothing running)', async () => {
    // `zpool status -jv` is unmocked here → exit 127. The uniform state must
    // still come back, with both scan-derived halves honestly absent.
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const states = (res.json() as { data: PeriodicScrubState[] }).data
    assert.equal(states.length, 2)
    assert.ok(states.every(s => s.lastScrub === null))
    assert.ok(states.every(s => !('running' in s)))
  })

  it('PUT /scrub/zfs/:pool flips the property (202 job)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: false }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const setCall = mockOf(server).calls.find(c => c.args[0] === 'set')
    assert.ok(setCall && setCall.args.includes('org.debian:periodic-scrub=disable') && setCall.args.includes('tank'))
  })

  it('PUT /scrub/zfs/:pool for an unknown pool → 404', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 404)
  })

  it('PUT /scrub/zfs/:pool with a bad body → 400', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ on: 'yes' }) })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /scrub/ahr/:pool for an unknown AHR pool → 404 (AHR reads fail-open to [])', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 404)
  })
})

describe('periodic scrub routes — AHR mdcheck timers (Epic 17.5)', () => {
  let server: ReturnType<typeof createServer>

  beforeEach(() => {
    // Default mock fixtures replay AHR pool `ahr0`; add a command-only systemctl
    // success so the mdcheck enable/disable + is-enabled resolve (exact fixtures
    // still win). is-enabled command-only returns empty → read = off.
    server = createServer({ mock: true, logger: false })
    mockOf(server).addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
  })

  it('GET /scrub includes the AHR pool with the node-global mdcheck note', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const ahr = (res.json() as { data: PeriodicScrubState[] }).data.find(s => s.target.kind === 'ahr')
    assert.ok(ahr, 'expected an AHR scrub state')
    assert.equal(ahr!.mechanism, 'mdcheck-timer')
    assert.match(ahr!.note ?? '', /node-global/)
    // md keeps no completion record — always null, never mined from journald
    // and never a state file we wrote (the sanctioned divergence).
    assert.equal(ahr!.lastScrub, null)
  })

  it('PUT /scrub/ahr/ahr0 toggles the node mdcheck timers (202 job)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const call = mockOf(server).calls.find(c => c.args[0] === 'enable' && c.args.includes('mdcheck_start.timer'))
    assert.ok(call && call.args.includes('mdcheck_continue.timer'))
  })

  it('GET /scrub reports a RUNNING md check on the AHR pool (stage 6)', async () => {
    // A bare server so the mdstat fixture can be the mid-`check` one (the mock
    // server's default replays the idle capture, and first fixture wins).
    const executor = mockAhrTopologyExecutor(new MockExecutor(), mockFixtures.ahrMdstatCheck())
    executor.addFixture({ command: SYSTEMCTL, result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } })
    const bare = Fastify({ logger: false })
    await bare.register(scrubRoutes, { prefix: '/v1', executor, jobQueue: new JobQueue() })

    const res = await bare.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const ahr = (res.json() as { data: PeriodicScrubState[] }).data.find(s => s.target.kind === 'ahr')
    assert.ok(ahr, 'expected an AHR scrub state')
    // Least-advanced band (r1 at 12.4%), both bands' throughput summed, the
    // longer of the two ETAs (1.2min) — see `ahrScrubRunning`.
    assert.deepEqual(ahr.running, {
      percent: 12.4,
      speedBytesSec: (64800 + 53973) * 1024,
      etaSeconds: 72,
    })
    // Still no COMPLETION record — live progress does not create one.
    assert.equal(ahr.lastScrub, null)
    await bare.close()
  })
})
