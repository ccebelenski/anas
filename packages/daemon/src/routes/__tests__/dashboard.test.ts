import type { AhrCapacity, AhrExpansionIntent, JobBrief, PoolTelemetry, StatusSummary, Telemetry } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { createServer } from '../../server.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { sharePathProbeArgs } from '../../services/share-path.js'
import { dashboardRoutes } from '../dashboard.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
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
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['iostat', '-plv', '--', 'testpool', '1', '2'], result: mockFixtures.zpoolIostat() })
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

describe('GET /v1/telemetry — ahrPools (story 11.15, AHR I/O telemetry)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function fetchTelemetry(srv: ReturnType<typeof createServer>): Promise<Telemetry> {
    const res = await srv.inject({ method: 'GET', url: '/v1/telemetry', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: Telemetry }).data
  }

  it('the telemetry payload carries an ahrPools array parallel to pools', async () => {
    server = createServer({ mock: true, logger: false })
    const t = await fetchTelemetry(server)
    // The AHR I/O tree rides alongside the ZFS pools tree, same contract shape.
    assert.ok(Array.isArray(t.ahrPools), 'ahrPools is an array')
    // Every entry (when any) has the IoStats + bands shape.
    for (const ap of t.ahrPools) {
      assert.equal(typeof ap.name, 'string')
      assert.equal(typeof ap.writeBytesPerSec, 'number')
      assert.ok(Array.isArray(ap.bands))
    }
  })

  it('fail-open: an AHR resolve error leaves ahrPools [] without degrading ZFS telemetry', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as any).executor as MockExecutor
    // Make the AHR reader's first read (cat /proc/mdstat) fail; ZFS iostat
    // fixtures stay intact so the ZFS telemetry tree is unaffected.
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['iostat', '-plv', '--', 'testpool', '1', '2'], result: mockFixtures.zpoolIostat() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: mockFixtures.zpoolStatus() })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'boom', exitCode: 1 } })

    const t = await fetchTelemetry(server)
    // AHR degraded to [] …
    assert.deepEqual(t.ahrPools, [])
    // … while the ZFS telemetry tree is still fully built.
    assert.ok(t.pools.some(p => p.name === 'testpool'), 'ZFS telemetry unaffected')
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

describe('GET /v1/status — stale-share warnings', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_EXPORTS_PATH
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  async function status(srv: ReturnType<typeof createServer>): Promise<StatusSummary> {
    const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: StatusSummary }).data
  }

  it('emits a warning per SMB share / NFS export whose path is missing, and none for live paths', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-stale-'))
    const livePath = join(dir, 'live')
    mkdirSync(livePath)
    const missingSmb = join(dir, 'gone-smb') // never created
    const missingNfs = join(dir, 'gone-nfs') // never created

    const smbConfPath = join(dir, 'smb.conf')
    writeFileSync(smbConfPath, [
      '[global]',
      '\tworkgroup = WORKGROUP',
      '',
      '[live]',
      `\tpath = ${livePath}`,
      '',
      '[media]',
      `\tpath = ${missingSmb}`,
      '',
    ].join('\n'), 'utf8')

    const exportsPath = join(dir, 'exports')
    writeFileSync(exportsPath, [
      `${livePath} 10.0.0.0/24(rw,sync)`,
      `${missingNfs} *(ro,sync)`,
      '',
    ].join('\n'), 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath

    server = createServer({ mock: true, logger: false, smbConfPath })
    // cr.35: the path check is `timeout -k 1 2 stat -f` through the executor;
    // the dev mock answers a healthy stat, the two missing paths answer the
    // captured "nonexistent path" case.
    const mock = (server as unknown as { executor: MockExecutor }).executor
    for (const gone of [missingSmb, missingNfs])
      mock.prependFixture({ command: '/usr/bin/timeout', args: sharePathProbeArgs(gone), result: mockFixtures.statF('nonexistent path') })
    const summary = await status(server)
    const shareWarnings = summary.warnings.filter(w => w.category === 'share')

    // One SMB + one NFS stale warning, both 'warning' level.
    assert.equal(shareWarnings.length, 2)
    assert.ok(shareWarnings.every(w => w.level === 'warning'))

    const smb = shareWarnings.find(w => w.ref === 'media')!
    assert.ok(smb, 'SMB stale warning present, ref = share name')
    assert.equal(smb.message, `SMB share 'media' points to a missing path ${missingSmb}`)

    const nfs = shareWarnings.find(w => w.ref === missingNfs)!
    assert.ok(nfs, 'NFS stale warning present, ref = export path')
    assert.equal(nfs.message, `NFS export path ${missingNfs} no longer exists`)

    // The live path (shared by both protocols) yields no stale warning.
    assert.ok(!shareWarnings.some(w => w.message.includes(livePath)))
  })

  it('emits no share warnings when every backing path exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-stale-'))
    const livePath = join(dir, 'live')
    mkdirSync(livePath)

    const smbConfPath = join(dir, 'smb.conf')
    writeFileSync(smbConfPath, ['[global]', '\tworkgroup = WORKGROUP', '', '[live]', `\tpath = ${livePath}`, ''].join('\n'), 'utf8')
    const exportsPath = join(dir, 'exports')
    writeFileSync(exportsPath, [`${livePath} *(ro,sync)`, ''].join('\n'), 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath

    server = createServer({ mock: true, logger: false, smbConfPath })
    const summary = await status(server)
    assert.equal(summary.warnings.filter(w => w.category === 'share').length, 0)
  })
})

describe('GET /v1/status — AHR warnings (story 11.10, AHR-DESIGN §10)', () => {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/ahr')
  const loadFixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf-8')
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

  let server: ReturnType<typeof createServer> | Awaited<ReturnType<typeof bareDashboardServer>> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_AHR_INTENT_DIR
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  /** Register the AHR read-layer fixtures on a mock (topology-test twin). */
  function addAhrFixtures(mock: MockExecutor, mdstat: string): void {
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(mdstat) })
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(loadFixture('mdadm-export-r1.txt')) })
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(loadFixture('mdadm-export-r2.txt')) })
    mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(loadFixture('lsblk-ahr0.json')) })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(loadFixture('disk-by-id-ahr.txt')) })
    mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(loadFixture('lvm-vgs.json')) })
    mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(loadFixture('lvm-lvs.json')) })
    mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(loadFixture('findmnt-ahr0.json')) })
    mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(loadFixture('btrfs-usage.txt')) })
  }

  /**
   * A bare Fastify server with ONLY dashboardRoutes and a controlled executor.
   *  Every non-AHR source fail-opens (unmatched mock commands → exit 127).
   */
  async function bareDashboardServer(executor: MockExecutor, tmp: string) {
    const srv = Fastify({ logger: false })
    await srv.register(dashboardRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: new JobQueue(),
      diskIdentityCache: new DiskIdentityCache(executor),
      smbConfPath: join(tmp, 'smb.conf'),
      exportsPath: join(tmp, 'exports'),
      systemdDir: join(tmp, 'systemd'),
      fstabPath: join(tmp, 'fstab'),
    })
    return srv
  }

  async function fetchStatus(srv: NonNullable<typeof server>): Promise<StatusSummary> {
    const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: StatusSummary }).data
  }

  it('a healthy AHR pool adds nothing to the dashboard', async () => {
    server = createServer({ mock: true, logger: false })
    const summary = await fetchStatus(server)
    assert.equal(summary.warnings.filter(w => w.category === 'ahr').length, 0)
  })

  it('a degraded AHR pool cards exactly once, target-first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-ahr-dash-'))
    const mock = new MockExecutor()
    addAhrFixtures(mock, loadFixture('mdstat-reshape-degraded.txt'))
    // The fixture's third kernel md125 is not part of ahr0: its detail answers
    // (exit 0) and names no AHR pool, so it stays "not ours" (D12 — a FAILED
    // read would throw, never silently pass as unidentified).
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md125'), result: ok('MD_LEVEL=raid1\nMD_DEVICES=2\nMD_DEVNAME=backup256\nMD_NAME=otherhost:backup256\n') })
    server = await bareDashboardServer(mock, dir)
    const summary = await fetchStatus(server)
    const ahr = summary.warnings.filter(w => w.category === 'ahr')
    assert.equal(ahr.length, 1)
    assert.equal(ahr[0].level, 'warning')
    assert.equal(ahr[0].ref, 'ahr0')
    assert.ok(ahr[0].message.includes('ahr0-r1'), 'names the degraded array')
    assert.ok(ahr[0].message.includes('scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'), 'names the faulty member')
  })

  it('a halted expansion cards through the real server wiring (intent dir)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-ahr-dash-'))
    process.env.ANAS_AHR_INTENT_DIR = dir
    const capacity: AhrCapacity = { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 }
    const intent: AhrExpansionIntent = {
      id: randomUUID(),
      trigger: 'add-disk',
      approvedDisks: ['scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'],
      before: capacity,
      after: capacity,
      state: 'halted',
    }
    await writeIntent('ahr0', intent, { dir })

    server = createServer({ mock: true, logger: false })
    const summary = await fetchStatus(server)
    const ahr = summary.warnings.filter(w => w.category === 'ahr')
    assert.equal(ahr.length, 1)
    assert.equal(ahr[0].ref, 'ahr0')
    assert.ok(ahr[0].message.includes('Resume'), 'names the Resume verb')
    assert.ok(ahr[0].message.includes('Abandon'), 'names the Abandon verb')
  })

  it('an AHR topology read that could not see CARDS the AHR sections unavailable, never the dashboard (F3)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-ahr-dash-'))
    // The AHR reader's first read (cat /proc/mdstat) fails with the honest
    // non-zero-exit shape of an unreadable topology — a real cat never throws,
    // it exits 1 (EACCES-style stderr). The typed error must surface as the
    // unavailable mark for both AHR sections, not as a silent empty source;
    // ZFS reads work.
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'cat: /proc/mdstat: Permission denied', exitCode: 1 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: mockFixtures.zpoolStatus() })

    server = await bareDashboardServer(mock, dir)
    const summary = await fetchStatus(server)
    // The rest of the aggregate is intact — pools still reported…
    assert.ok(summary.pools.some(p => p.name === 'testpool'))
    // …and the AHR sources degraded to their empty shape, without failing the
    // request — but no longer in silence: cr.35 says unreadable is never empty.
    assert.equal(summary.warnings.filter(w => w.category === 'ahr').length, 0)
    assert.deepEqual(summary.ahrPools, [])
    const unavailable = summary.unavailable ?? []
    assert.ok(unavailable.includes('ahr'), 'names the ahr section unavailable')
    assert.ok(unavailable.includes('ahrPools'), 'names the ahrPools section unavailable')
    // …and the card carries the "could not be read" sentence naming the read.
    const card = summary.warnings.find(w => w.category === 'unavailable')
    assert.ok(card && /AHR/.test(card.message), card?.message)
    assert.ok(card && /could not be read/.test(card.message), card?.message)
  })

  it('an ABSENT /proc/mdstat is readable-empty at /status — no unavailable card for an md-less node (F1/F3)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-ahr-dash-'))
    // coreutils cat's ENOENT shape: the node has no md stack, honestly no
    // arrays. That is an empty read, not an unreadable one — it must never
    // card as "unavailable" (a liar's card for an honest md-less node).
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory', exitCode: 1 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: mockFixtures.zpoolStatus() })

    server = await bareDashboardServer(mock, dir)
    const summary = await fetchStatus(server)
    assert.deepEqual(summary.ahrPools, [])
    assert.deepEqual(summary.unavailable ?? [], [], 'an md-less node lists nothing as unavailable')
    assert.equal(summary.warnings.filter(w => w.category === 'ahr').length, 0)
  })
})

describe('GET /v1/status — ahrPools briefs (story 11.13, AHR-DESIGN §10 revision)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function status(srv: ReturnType<typeof createServer>): Promise<StatusSummary> {
    const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: StatusSummary }).data
  }

  it('the disk-warning path probes SMART through loadMany — a pull re-reads due disks, a fresh pull does not', async () => {
    // The dashboard's disk warnings ride collectDisks → the identity cache's
    // loadMany (disks.1): the pull that renders the warning cards is the same
    // pull that re-probes aged readings. No second path, no poller. The mock
    // identity call is `smartctl -n standby -iH --json <dev>` — count those.
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const identityProbes = () => mock.calls.filter(c => c.command === '/usr/sbin/smartctl' && c.args.includes('-iH')).length

    await status(server)
    const first = identityProbes()
    assert.ok(first > 0, 'a /status pull probed the fleet')

    await status(server)
    assert.equal(identityProbes(), first, 'a fresh reading is a cache hit within the cadence — no re-probe on the next pull')

    // ...and once the readings AGE past the cadence, the very next /status
    // pull re-probes: the dashboard's disk warnings are the whole reason the
    // reading must not be a lifetime cache hit. The server's own cache is the
    // one under test (there is exactly one for every consumer), so the clock
    // is injected into it rather than the test sleeping 30 minutes.
    const cache = (server as unknown as { diskIdentityCache: { now: () => number } }).diskIdentityCache
    const realNow = cache.now
    cache.now = () => realNow() + 31 * 60 * 1000
    await status(server)
    assert.ok(
      identityProbes() > first,
      `an aged reading is re-probed on the next dashboard pull (was ${first}, now ${identityProbes()})`,
    )
  })

  it('carries the healthy AHR pool in the /v1/status aggregate', async () => {
    server = createServer({ mock: true, logger: false })
    const summary = await status(server)

    // The aggregate now has an ahrPools array (parallel to pools[]).
    assert.ok(Array.isArray(summary.ahrPools))
    const ahr0 = summary.ahrPools.find(p => p.name === 'ahr0')
    assert.ok(ahr0, 'ahr0 present in ahrPools')
    assert.equal(ahr0!.state, 'healthy')
    assert.equal(ahr0!.mounted, true)
    assert.ok(ahr0!.usableBytes > 0)
    assert.notEqual(ahr0!.usedBytes, undefined) // mounted → used is trustworthy

    // Bands render the composite: r1 raid5×3, r2 raid1×2.
    assert.equal(ahr0!.bands.length, 2)
    assert.equal(ahr0!.bands[0].level, 'raid5')
    assert.equal(ahr0!.bands[0].memberCount, 3)
    assert.equal(ahr0!.bands[1].level, 'raid1')

    // A healthy pool still cards NOTHING (warnings stay failure-only, 11.10).
    assert.equal(summary.warnings.filter(w => w.category === 'ahr').length, 0)
  })
})

describe('GET /v1/status — disk counts honour AHR member state (disks.2)', () => {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/ahr')
  const loadFixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf-8')
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

  let server: ReturnType<typeof createServer> | Awaited<ReturnType<typeof bareDashboardServer>> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  // The DISKS-VIEW flat lsblk (LSBLK_ARGS) — physical disks only. The three AHR
  // members carry raid-member partitions, sde is a ZFS pool member, sdf blank.
  function flatPart(name: string, fstype: string | null) {
    return { name, type: 'part', size: 1072676352, fstype, mountpoint: null }
  }
  function flatDisk(name: string, serial: string, parts: object[]) {
    return {
      'name': name,
      'type': 'disk',
      'size': 1073741824,
      'model': 'QEMU HARDDISK',
      'serial': serial,
      'tran': 'sata',
      'fstype': null,
      'mountpoint': null,
      'rota': true,
      'phy-sec': 512,
      'log-sec': 512,
      'wwn': null,
      'vendor': 'QEMU',
      'rev': '2.5+',
      'children': parts,
    }
  }

  const FLAT_LSBLK = JSON.stringify({
    blockdevices: [
      flatDisk('sdb', 'ANAS_HOT1', [flatPart('sdb1', 'linux_raid_member')]),
      flatDisk('sdc', 'ANAS_HOT2', [flatPart('sdc1', 'linux_raid_member'), flatPart('sdc2', 'linux_raid_member')]),
      flatDisk('sdd', 'ANAS_HOT3', [flatPart('sdd1', 'linux_raid_member'), flatPart('sdd2', 'linux_raid_member')]),
      // A ZFS pool member — must still classify 'pool_member', healthy.
      flatDisk('sde', 'ZFS_MEMBER', [flatPart('sde1', 'zfs_member')]),
      // A genuinely blank disk — stays 'available', SMART-only health.
      flatDisk('sdf', 'BLANK', []),
    ],
  })

  // by-id: the ahr0 fixture's three disks + sde/sdf, one listing for BOTH the
  // disks view and the AHR topology reader.
  const BY_ID = `${loadFixture('disk-by-id-ahr.txt').trimEnd()}
lrwxrwxrwx 1 root root   9 Jul 22 22:43 scsi-0QEMU_QEMU_HARDDISK_ZFS_MEMBER -> ../../sde
lrwxrwxrwx 1 root root  10 Jul 22 22:44 scsi-0QEMU_QEMU_HARDDISK_ZFS_MEMBER-part1 -> ../../sde1
lrwxrwxrwx 1 root root   9 Jul 22 22:43 scsi-0QEMU_QEMU_HARDDISK_BLANK -> ../../sdf
`

  // A single-disk (stripe) ZFS pool 'tank' whose leaf is sde (kernel path).
  const ZPOOL_STATUS = JSON.stringify({
    pools: {
      tank: {
        name: 'tank',
        state: 'ONLINE',
        pool_guid: '9',
        error_count: '0',
        vdevs: {
          tank: {
            name: 'tank',
            vdev_type: 'root',
            state: 'ONLINE',
            read_errors: '0',
            write_errors: '0',
            checksum_errors: '0',
            vdevs: {
              'sde-leaf': {
                name: 'sde',
                vdev_type: 'disk',
                state: 'ONLINE',
                path: '/dev/sde1',
                read_errors: '0',
                write_errors: '0',
                checksum_errors: '0',
                slow_ios: '0',
              },
            },
          },
        },
      },
    },
  })

  /** The disks-view + AHR topology world, sharing one mdstat variant. */
  function addDiskWorld(mock: MockExecutor, mdstat: string): void {
    mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: ok(FLAT_LSBLK) })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID) })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: ok(ZPOOL_STATUS) })
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(mdstat) })
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(loadFixture('mdadm-export-r1.txt')) })
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(loadFixture('mdadm-export-r2.txt')) })
    mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(loadFixture('lsblk-ahr0.json')) })
    mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(loadFixture('lvm-vgs.json')) })
    mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(loadFixture('lvm-lvs.json')) })
    mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(loadFixture('findmnt-ahr0.json')) })
    mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(loadFixture('btrfs-usage.txt')) })
  }

  /** A bare Fastify server with ONLY dashboardRoutes and a controlled executor. */
  async function bareDashboardServer(executor: MockExecutor, tmp: string) {
    const srv = Fastify({ logger: false })
    await srv.register(dashboardRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: new JobQueue(),
      diskIdentityCache: new DiskIdentityCache(executor),
      smbConfPath: join(tmp, 'smb.conf'),
      exportsPath: join(tmp, 'exports'),
      systemdDir: join(tmp, 'systemd'),
      fstabPath: join(tmp, 'fstab'),
    })
    return srv
  }

  async function fetchStatus(srv: NonNullable<typeof server>): Promise<StatusSummary> {
    const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: StatusSummary }).data
  }

  it('an AHR-faulty band member lands in the critical count, not the healthy bin', async () => {
    // sdc is faulty on band r1, in_sync on r2 (same ahr0 world, mdstat variant).
    dir = mkdtempSync(join(tmpdir(), 'anas-dash-disks2-'))
    const mock = new MockExecutor()
    addDiskWorld(mock, loadFixture('mdstat-disks2-faulty.txt'))
    server = await bareDashboardServer(mock, dir)
    const summary = await fetchStatus(server)

    assert.equal(summary.disks.critical, 1, 'the AHR-faulty sdc is critical')
    assert.equal(summary.disks.healthy, 1, 'the ZFS member sde is healthy')
    assert.equal(summary.disks.warning, 0)
    assert.equal(summary.disks.unknown, 3, 'AHR in_sync (sdb, sdd) + blank sdf stay unknown')
    assert.equal(summary.disks.total, 5)
  })
})

describe('GET /v1/status — iSCSI warnings (story iscsi.5)', () => {
  const iscsiFixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/iscsi')
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_ISCSI_CONFIGFS
    delete process.env.ANAS_ISCSI_SAVECONFIG
    delete process.env.ANAS_ISCSI_SYS_BLOCK
    delete process.env.ANAS_STORAGE_CFG
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  async function status(): Promise<StatusSummary> {
    const res = await server!.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: StatusSummary }).data
  }

  /** Point the daemon's injectable iSCSI paths at a materialised fixture tree. */
  async function serveIscsi(manifest: string | null, saveconfig: string | null): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'anas-dash-iscsi-'))
    if (manifest) {
      const root = join(dir, 'target')
      await materializeConfigfsManifest(readFileSync(join(iscsiFixtures, manifest), 'utf-8'), root)
      process.env.ANAS_ISCSI_CONFIGFS = root
    }
    else {
      process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'absent-configfs')
    }
    process.env.ANAS_ISCSI_SAVECONFIG = saveconfig
      ? join(iscsiFixtures, saveconfig)
      : join(dir, 'absent-saveconfig.json')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    mkdirSync(join(dir, 'block', 'zd16'), { recursive: true })
    writeFileSync(join(dir, 'block', 'zd16', 'size'), '4194304\n')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
    server = createServer({ mock: true, logger: false })
  }

  it('a node with no LIO at all cards NOTHING', async () => {
    await serveIscsi(null, null)
    const summary = await status()
    assert.equal(summary.warnings.filter(w => w.category === 'iscsi').length, 0)
  })

  it('a healthy LIO configuration cards NOTHING', async () => {
    await serveIscsi('configfs-live.manifest', 'saveconfig-final.json')
    const summary = await status()
    assert.equal(summary.warnings.filter(w => w.category === 'iscsi').length, 0)
  })

  it('the restore hole reaches the aggregate as `iscsi` cards', async () => {
    // The whole point of the category: systemd reported this boot a SUCCESS.
    await serveIscsi('configfs-restore-hole.manifest', 'saveconfig-final.json')
    const summary = await status()
    const iscsi = summary.warnings.filter(w => w.category === 'iscsi')
    assert.equal(iscsi.length, 2)
    assert.ok(iscsi.some(w => /LUN 0 'gtiscsi_vol1'/.test(w.message) && w.level === 'warning'))
    assert.ok(iscsi.some(w => /mutations are refused/.test(w.message) && w.level === 'critical'))
    // Target-first: the per-LUN card deep-links to its target.
    assert.ok(iscsi.some(w => w.ref === 'iqn.2026-08.dev.anas.gtiscsi:target1'))
  })

  it('a target that restored with zero LUNs cards as critical', async () => {
    await serveIscsi('configfs-restore-empty.manifest', 'saveconfig-final.json')
    const summary = await status()
    const serving = summary.warnings.filter(w => w.category === 'iscsi' && /restored with none of its/.test(w.message))
    assert.equal(serving.length, 1)
    assert.equal(serving[0].level, 'critical')
    assert.match(serving[0].message, /accepting logins with no disks behind it/)
  })
})

// cr.51r (review possible 1): a unit file the schedule store cannot read back
// was INVISIBLE — the list 404'd it, only a stderr line said so, and its
// timer kept firing as root. The cr.35 convention says unreadable is never
// empty: the list still answers with what parses, and ONE card per bad file
// names it, with the way out. DELETE still reaches it (cr.41b binds the
// delete to the unit on disk, not the parsed schedule).
describe('GET /v1/status — cr.51r: an unparseable schedule unit cards by file name', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevEnv: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anas-dash-sched-'))
    prevEnv = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = dir
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    // A valid schedule's pair, as the store writes it…
    const good = { id: 'good', name: 'Good', target: { kind: 'zfs', dataset: 'testpool/media' }, cadence: 'daily', retention: { daily: 7 }, recursive: false, enabled: true, notify: 'on-failure' }
    writeFileSync(join(dir, 'anas-snap-good.service'), `# X-ANAS-Schedule=${JSON.stringify(good)}\n`)
    writeFileSync(join(dir, 'anas-snap-good.timer'), '[Timer]\nOnCalendar=daily\n')
    // …and the C1 proof's poisoned unit, byte-for-byte as the vulnerable build
    // wrote it (the cr.51 review probe): forged lines in Description=, marker
    // JSON that parses but fails the SingleLine fence.
    const evil = { ...good, id: 'evil', name: 'x\n[Service]\nExecStartPre=/bin/touch /root/pwned' }
    writeFileSync(join(dir, 'anas-snap-evil.service'), [
      '[Unit]',
      `Description=ANAS snapshot schedule ${evil.name}`,
      `# X-ANAS-Schedule=${JSON.stringify(evil)}`,
      '',
      '[Service]',
      'Type=oneshot',
      'Environment=TZ=UTC',
      'ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/snapshot-task.js --id evil',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'anas-snap-evil.timer'), '[Timer]\nOnCalendar=daily\n')
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    if (prevEnv === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else process.env.ANAS_SYSTEMD_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET /schedules answers 200 with the parsed schedule; the poisoned one is not in the list', async () => {
    const res = await server!.inject({ method: 'GET', url: '/v1/schedules', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const statuses = (res.json() as { data: { schedule: { id: string } }[] }).data
    assert.deepEqual(statuses.map(s => s.schedule.id), ['good'])
  })

  it('GET /status cards the poisoned unit, naming the file and the way out', async () => {
    const res = await server!.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const warnings = (res.json() as { data: StatusSummary }).data.warnings
    const card = warnings.find(w => w.message.includes('anas-snap-evil.service'))
    assert.ok(card, `card present among: ${JSON.stringify(warnings.map(w => w.message))}`)
    assert.equal(card.level, 'warning')
    assert.match(card.message, /Schedule unit anas-snap-evil\.service could not be read \(its X-ANAS-Schedule JSON does not parse or validate\); its timer may still fire\. Delete it from the Schedules view or by hand/)
  })

  it('DELETE /schedules/evil still removes both files (cr.41b)', async () => {
    const del = await server!.inject({ method: 'DELETE', url: '/v1/schedules/evil', headers: IDENTITY_HEADERS })
    assert.equal(del.statusCode, 202)
    const jobId = (del.json() as { job: { id: string } }).job.id
    let status = ''
    for (let i = 0; i < 100 && status !== 'completed' && status !== 'failed'; i++) {
      const job = await server!.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: IDENTITY_HEADERS })
      status = (job.json() as { job: { status: string } }).job.status
      if (status === '' || status === 'queued' || status === 'running')
        await new Promise(r => setTimeout(r, 10))
    }
    assert.equal(status, 'completed')
    assert.ok(!existsSync(join(dir, 'anas-snap-evil.service')), 'service file removed')
    assert.ok(!existsSync(join(dir, 'anas-snap-evil.timer')), 'timer file removed')
    // The good pair is untouched.
    assert.ok(existsSync(join(dir, 'anas-snap-good.service')))
  })
})
