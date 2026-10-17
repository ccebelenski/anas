import type { Job, PeriodicScrubState } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
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

function jobQueueOf(server: ReturnType<typeof createServer>): JobQueue {
  return (server as unknown as { jobQueue: JobQueue }).jobQueue
}

/** The ZFS toggle's guid binding reads (cr.64b2-ii) — the mock pins them exactly. */
const TANK_GUID = '17389218961908081526'
const RPOOL_GUID = '2305843009213693951'
function guidFixture(pool: string, guid: string) {
  return {
    command: ZPOOL,
    args: ['get', '-H', '-o', 'value', 'guid', '--', pool],
    result: { stdout: `${guid}\n`, stderr: '', exitCode: 0 },
  }
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
    mock.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'value', 'org.debian:periodic-scrub', '--', 'tank'], result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'value', 'org.debian:periodic-scrub', '--', 'rpool'], result: { stdout: 'disable\n', stderr: '', exitCode: 0 } })
    // cr.64b2-ii: the toggle is a guard door bound to the pool's guid.
    mock.addFixture(guidFixture('tank', TANK_GUID))
    mock.addFixture(guidFixture('rpool', RPOOL_GUID))
    // zfs set + any other zfs: command-only success.
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    // An md-less node: /proc/mdstat ABSENT — coreutils cat's ENOENT line, exit 1,
    // the one failed read that is honestly "no md arrays" (cr.33e) — so GET
    // returns only the ZFS pools. (Since cr.63 any OTHER failed AHR read is a
    // 503, never an empty list; see the AHR block.)
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory', exitCode: 1 } })
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

  it('cr.64b2-ii (L22): the toggle job holds zpool:<guid> + zname:<pool> SHARED (queue state)', async () => {
    const mock = mockOf(server)
    const queue = jobQueueOf(server)
    // Park the job mid-`zfs set` with a live child, read the lock table while
    // it runs, then release it. (Before cr.64b2-ii the toggle held NOTHING.)
    mock.addFixture({ command: ZFS, args: ['set', '--', 'org.debian:periodic-scrub=disable', 'tank'], live: { signalsToExit: Number.POSITIVE_INFINITY } })
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: false }) })
    assert.equal(res.statusCode, 202)
    const id = (res.json() as { job: { id: string } }).job.id
    for (let i = 0; i < 50 && !mock.calls.some(c => c.command === ZFS && c.args[0] === 'set'); i++)
      await new Promise(r => setTimeout(r, 10))
    assert.equal(queue.get(id)?.status, 'running', 'the toggle job never reached its zfs set')
    // A property set changes nothing about the pool's shape → the SHARED pair,
    // exactly what cr.36's pool-scrub verb and the props verb hold.
    assert.deepEqual(queue.heldLocks(), [
      { key: `zpool:${TANK_GUID}`, mode: 'shared', holders: [id] },
      { key: 'zname:tank', mode: 'shared', holders: [id] },
    ])
    mock.finishLive()
    const done = await waitForJob(server, id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
  })

  it('cr.64b2-ii (L22): a pool gone from `zpool list` between the route and the job → the job fails IDENTITY_MISMATCH, zfs set never ran', async () => {
    const mock = mockOf(server)
    const queue = jobQueueOf(server)
    // The job re-runs the door at its turn: script the pool list so `tank`
    // stands at the route and is gone by the job's re-read.
    mock.clearFixtures()
    mock.addFixture({
      command: ZPOOL,
      args: ['list', '-j'],
      results: [
        { stdout: zpoolListJson(['tank', 'rpool']), stderr: '', exitCode: 0 },
        { stdout: zpoolListJson(['rpool']), stderr: '', exitCode: 0 },
      ],
    })
    mock.addFixture(guidFixture('tank', TANK_GUID))
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory', exitCode: 1 } })
    // Paused-queue pattern (cr.33): the slots are held, so the toggle sits
    // QUEUED after its route gate passed; the pool disappears behind it.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)
    mock.calls.length = 0
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: false }) })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as { job: { id: string } }).job.id
    assert.equal(queue.get(id)?.status, 'queued', 'the toggle waits behind the held slots')
    release()
    const done = await waitForJob(server, id)
    assert.equal(done.status, 'failed', JSON.stringify(done))
    assert.equal(done.error?.code, 'IDENTITY_MISMATCH', JSON.stringify(done.error))
    assert.match(done.error?.message ?? '', /ZFS pool 'tank' is not the one that was confirmed/)
    assert.match(done.error?.message ?? '', /nothing was done/)
    assert.ok(!mock.calls.some(c => c.command === ZFS && c.args[0] === 'set'), 'zfs set never ran')
  })

  it('cr.64b2-ii (L22): a pool PVE\'s storage.cfg uses → 409 PVE_MANAGED at the door, no job, zfs set never runs', async () => {
    // The same hands-off answer every pool-level verb gives ("PVE territory is
    // read-only and hands-off"), with no confirm bypass.
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-pvegate-'))
    const cfg = join(dir, 'storage.cfg')
    const saved = process.env.ANAS_STORAGE_CFG
    try {
      await writeFile(cfg, 'zfspool: local-zfs\n\tpool tank\n\tcontent images,rootdir\n', 'utf-8')
      process.env.ANAS_STORAGE_CFG = cfg
      mockOf(server).calls.length = 0
      const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: false }) })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'PVE_MANAGED')
      assert.match((res.json() as { error: { message: string } }).error.message, /no confirm bypass/)
      assert.ok(!mockOf(server).calls.some(c => c.command === ZFS && c.args[0] === 'set'), 'zfs set never ran')
    }
    finally {
      if (saved === undefined)
        delete process.env.ANAS_STORAGE_CFG
      else
        process.env.ANAS_STORAGE_CFG = saved
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('PUT /scrub/zfs/:pool for an unknown pool → 404', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 404)
  })

  it('cr.64c: an unreadable `zpool list` is 503 UNAVAILABLE naming the read at both doors — never 404 for a live pool, never a ZFS-less list, and no job', async () => {
    // The ZFS twin of cr.63's L15: a failed `zpool list -j` used to read as
    // "no pools", so the toggle 404-ed a live pool and GET dropped every row.
    const mock = mockOf(server)
    mock.clearFixtures()
    // The AHR side stays honestly md-less (the ABSENT /proc/mdstat, cr.33e) so
    // the 503 can only come from the ZFS read.
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory', exitCode: 1 } })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: '', stderr: 'cannot open the pool list: I/O error', exitCode: 1 } })
    const put = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(put.statusCode, 503, put.body)
    assert.equal(put.json().error.code, 'UNAVAILABLE')
    assert.equal(put.json().error.message, 'the ZFS pool list could not be read (zpool list -j exited 1: cannot open the pool list: I/O error)')
    const get = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(get.statusCode, 503, get.body)
    assert.equal(get.json().error.code, 'UNAVAILABLE')
    assert.match(get.json().error.message, /^the ZFS pool list could not be read \(zpool list -j exited 1/)
  })

  it('PUT /scrub/zfs/:pool with a bad body → 400', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ on: 'yes' }) })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /scrub/ahr/:pool for an unknown AHR pool → 404 (an md-less node honestly has no AHR pools)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 404)
  })
})

describe('periodic scrub routes — AHR node-level anas-scrub timer (selfheal.4)', () => {
  let server: ReturnType<typeof createServer>
  let unitDir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    // The toggle WRITES unit files — point the route at a temp dir through the
    // same env override the schedules routes use (tests never touch /etc).
    unitDir = await mkdtemp(join(tmpdir(), 'anas-scrub-routes-'))
    prevEnv = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = unitDir
    // Default mock fixtures replay AHR pool `ahr0`; add a command-only systemctl
    // success so the unit writes + is-enabled reads resolve (exact fixtures
    // still win). is-enabled command-only returns empty → read = off.
    server = createServer({ mock: true, logger: false })
    mockOf(server).addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    if (prevEnv === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = prevEnv
    await rm(unitDir, { recursive: true, force: true })
  })

  it('GET /scrub reports the AHR state off the node timer (mechanism, phases, honest note)', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const ahr = (res.json() as { data: PeriodicScrubState[] }).data.find(s => s.target.kind === 'ahr')
    assert.ok(ahr, 'expected an AHR scrub state')
    assert.equal(ahr!.mechanism, 'anas-scrub-timer')
    assert.equal(ahr!.enabled, false, 'no units written yet — nothing enabled')
    assert.equal(ahr!.cadence, 'monthly', 'the default cadence stands before any toggle')
    assert.deepEqual(ahr!.phases, ['md-parity', 'btrfs-checksums'])
    assert.equal(ahr!.nextRun, null, 'an off pool claims no next run')
    assert.match(ahr!.note ?? '', /node-level timer/)
    // md keeps no completion record — always null, never mined from journald
    // and never a state file we wrote (the sanctioned divergence).
    assert.equal(ahr!.lastScrub, null)
  })

  it('PUT /scrub/ahr/ahr0 {enabled:true} writes the units and takes mdcheck over (202 job)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    // The node timer's units now exist, listing this pool.
    const schedule = JSON.parse(
      (await readFile(join(unitDir, 'anas-scrub.service'), 'utf-8')).match(/X-ANAS-Schedule=(.*)/)![1],
    )
    assert.deepEqual(schedule, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
    const call = mockOf(server).calls.find(c => c.args[0] === 'disable' && c.args.includes('mdcheck_start.timer'))
    assert.ok(call && call.args.includes('mdcheck_continue.timer'), 'mdcheck is disabled on enable')
  })

  it('PUT /scrub/ahr/ahr0 {enabled:true, cadence:"quarterly"} writes the quarterly calendar', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true, cadence: 'quarterly' }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.match(await readFile(join(unitDir, 'anas-scrub.timer'), 'utf-8'), /OnCalendar=Sun \*-01,04,07,10-01\.\.07 03:00:00/)
  })

  it('cr.64b2-ii (L22): the AHR toggle job holds ahr:<vg uuid> + ahrname:<pool> SHARED (queue state)', async () => {
    const mock = mockOf(server)
    const queue = jobQueueOf(server)
    // Park the job mid-`systemctl enable --now` (its last act), read the lock
    // table, release. (Before cr.64b2-ii the AHR toggle held NOTHING.)
    mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', 'anas-scrub.timer'], live: { signalsToExit: Number.POSITIVE_INFINITY } })
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 202)
    const id = (res.json() as { job: { id: string } }).job.id
    for (let i = 0; i < 50 && !mock.calls.some(c => c.command === SYSTEMCTL && c.args.join(' ') === 'enable --now anas-scrub.timer'); i++)
      await new Promise(r => setTimeout(r, 10))
    assert.equal(queue.get(id)?.status, 'running', 'the toggle job never reached the timer enable')
    // The toggle edits the node timer's pool list — it never reshapes the
    // pool → ahrPoolClaims(…, 'shared'). The captured `vgs` (fixtures/ahr)
    // carries no vg_uuid column (ahr-guard-verbs.test.ts says why), so the
    // route holds §4.2's fallback — the name key, exclusive — exactly as the
    // other AHR verbs do over this world; the uuid pair is pinned on the
    // builder in ahr-guard-verbs.test.ts (cr.38).
    assert.deepEqual(queue.heldLocks(), [
      { key: 'ahrname:ahr0', mode: 'exclusive', holders: [id] },
    ])
    mock.finishLive()
    const done = await waitForJob(server, id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
  })

  it('cr.64b2-ii (L22): the pool gone from the topology between the route and the job → IDENTITY_MISMATCH, no unit written', async () => {
    // A bare server so the mdstat read can be scripted [present, absent] —
    // registered FIRST, it wins over every later /proc/mdstat fixture.
    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/cat',
      args: MDSTAT_CAT_ARGS,
      results: [
        mockFixtures.ahrMdstat(),
        { stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory', exitCode: 1 },
      ],
    })
    mockAhrTopologyExecutor(executor, mockFixtures.ahrMdstat())
    executor.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    const queue = new JobQueue()
    const bare = Fastify({ logger: false })
    await bare.register(scrubRoutes, { prefix: '/v1', executor, jobQueue: queue, systemdDir: unitDir })
    try {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      for (let i = 0; i < 4; i++)
        queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)
      const res = await bare.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      assert.equal(queue.get(id)?.status, 'queued', 'the toggle waits behind the held slots')
      release()
      for (let i = 0; i < 50 && queue.get(id)?.status !== 'failed'; i++)
        await new Promise(r => setTimeout(r, 10))
      const done = queue.get(id)
      assert.equal(done?.status, 'failed', JSON.stringify(done))
      assert.equal(done?.error?.code, 'IDENTITY_MISMATCH', JSON.stringify(done?.error))
      assert.match(done?.error?.message ?? '', /AHR pool 'ahr0' is not the one that was confirmed/)
      assert.match(done?.error?.message ?? '', /nothing was done/)
      // The job door refused before any unit file touched the disk.
      const { readdir } = await import('node:fs/promises')
      assert.deepEqual(await readdir(unitDir), [], 'no anas-scrub units were written')
    }
    finally {
      await bare.close()
    }
  })

  it('PUT /scrub/ahr/ahr0 with a bad cadence → 400', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true, cadence: 'weekly' }) })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /scrub/ahr/:pool on a FOREIGN anas-scrub unit → 409 reason foreign-unit, no job (review R10)', async () => {
    // Someone else's unit on ANAS's fixed name — neither rewritten on enable
    // nor deleted on disable.
    await writeFile(join(unitDir, 'anas-scrub.service'), '[Unit]\nDescription=not ours\n')
    for (const enabled of [true, false]) {
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/scrub/ahr/ahr0',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ enabled }),
      })
      assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
      const body = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(body.error.code, 'CONFLICT')
      assert.equal(body.error.reason, 'foreign-unit')
      assert.match(body.error.message, /X-ANAS-Schedule/)
    }
    // The foreign file is untouched and no job was created.
    assert.equal(await readFile(join(unitDir, 'anas-scrub.service'), 'utf-8'), '[Unit]\nDescription=not ours\n')
    assert.equal((await server.inject({ method: 'GET', url: '/v1/jobs', headers: IDENTITY })).json().data.length, 0)
  })

  it('a FAILED unit write is reported as the failure it is, never as foreign-unit (review F14)', async () => {
    // The door check passes (nothing in the temp dir); the write's ENABLE step
    // fails (the mock server pre-registers a daemon-reload success, so the
    // failure goes on the one systemctl call no other test pins).
    mockOf(server).addFixture({ command: SYSTEMCTL, args: ['enable', '--now', 'anas-scrub.timer'], result: { stdout: '', stderr: 'enable bus borked', exitCode: 1 } })
    const res = await server.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'failed')
    assert.match(done.error?.message ?? '', /periodic scrub enable failed for 'ahr0': enable bus borked/)
    assert.doesNotMatch(done.error?.message ?? '', /foreign/i, 'a write failure is never misreported as a foreign unit')
    // And the rollback left no half-written pair for the next attempt.
    assert.equal(await readFile(join(unitDir, 'anas-scrub.service'), 'utf-8').then(() => 'present', () => 'absent'), 'absent')
    assert.equal(await readFile(join(unitDir, 'anas-scrub.timer'), 'utf-8').then(() => 'present', () => 'absent'), 'absent')
  })

  it('GET /scrub reports the LEGACY state as mechanism mdcheck-timer, honestly off (review F1/F4)', async () => {
    // mdcheck enabled (a stock node's default), no ANAS units: nothing armed,
    // nothing adopted — the state says what is running.
    mockOf(server).addFixture({ command: SYSTEMCTL, args: ['is-enabled', 'mdcheck_start.timer'], result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 200)
    const ahr = (res.json() as { data: PeriodicScrubState[] }).data.find(s => s.target.kind === 'ahr')
    assert.ok(ahr)
    assert.equal(ahr!.enabled, false, 'ANAS never enabled itself — the legacy state is reported, not adopted')
    assert.equal(ahr!.mechanism, 'mdcheck-timer')
    assert.match(ahr!.note ?? '', /the OS's monthly md parity check \(mdcheck\) is on/)
    assert.match(ahr!.note ?? '', /takes it over/)
    // And the start path armed nothing: no units were written by anyone.
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(unitDir), [], 'no anas-scrub units exist')
  })

  it('GET /scrub reports a RUNNING md check on the AHR pool (stage 6)', async () => {
    // A bare server so the mdstat fixture can be the mid-`check` one (the mock
    // server's default replays the idle capture, and first fixture wins).
    const executor = mockAhrTopologyExecutor(new MockExecutor(), mockFixtures.ahrMdstatCheck())
    executor.addFixture({ command: SYSTEMCTL, result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } })
    // cr.64c: GET now fails CLOSED on an unreadable `zpool list` — this node
    // honestly has no ZFS pools (a successful empty read), so the AHR row stands.
    executor.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson([]), stderr: '', exitCode: 0 } })
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

  /**
   * cr.63 (review L15): the dev-mock topology with ONE array's `mdadm --detail
   * --export` exiting non-zero — the cr.33d failure mode (the stderr is
   * injected and only echoed, never parsed; the exit code is the fact). The
   * failing fixture is registered FIRST, so it wins over the captured r2 export.
   */
  function unreadableDetailServer() {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: { stdout: '', stderr: 'mdadm: cannot open /dev/md126: injected', exitCode: 1 } })
    mockAhrTopologyExecutor(executor, mockFixtures.ahrMdstat())
    executor.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    return { executor, server: Fastify({ logger: false }) }
  }

  it('cr.63 L15: GET /scrub with an unreadable AHR topology answers 503 naming the read — never a list without the AHR pool', async () => {
    const { executor, server: bare } = unreadableDetailServer()
    await bare.register(scrubRoutes, { prefix: '/v1', executor, jobQueue: new JobQueue(), systemdDir: unitDir })
    const res = await bare.inject({ method: 'GET', url: '/v1/scrub' })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
    assert.equal(res.json().error.message, 'the AHR topology could not be read (mdadm --detail --export /dev/md126 exited 1: mdadm: cannot open /dev/md126: injected)')
    await bare.close()
  })

  it('cr.63 L15: PUT /scrub/ahr/:pool with an unreadable AHR topology answers 503 naming the read — never 404 for a live pool, and no job', async () => {
    const { executor, server: bare } = unreadableDetailServer()
    const jobQueue = new JobQueue()
    await bare.register(scrubRoutes, { prefix: '/v1', executor, jobQueue, systemdDir: unitDir })
    const res = await bare.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
    assert.match(res.json().error.message, /^the AHR topology could not be read \(mdadm --detail --export \/dev\/md126 exited 1/)
    assert.deepEqual(jobQueue.list(), [])
    await bare.close()
  })

  it('cr.63 L15: a PERMISSION-DENIED /proc/mdstat is 503 too; only the absent file is "no AHR pools"', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'cat: /proc/mdstat: Permission denied', exitCode: 1 } })
    const bare = Fastify({ logger: false })
    await bare.register(scrubRoutes, { prefix: '/v1', executor, jobQueue: new JobQueue(), systemdDir: unitDir })
    const res = await bare.inject({ method: 'PUT', url: '/v1/scrub/ahr/ahr0', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
    assert.equal(res.statusCode, 503, res.body)
    assert.match(res.json().error.message, /cat \/proc\/mdstat exited 1: cat: \/proc\/mdstat: Permission denied/)
    await bare.close()
  })
})
