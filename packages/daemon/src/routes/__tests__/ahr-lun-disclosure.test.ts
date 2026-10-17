import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { ZfsMountpoint } from '../../parsers/pve-storage.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { JobQueue } from '../../jobs/queue.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes } from '../ahr-mutate.js'
import { ahrSnapshotRoutes } from '../ahr-snapshots.js'

/**
 * cr.38r — the LIO-unreadable disclosure on the LAST three AHR verbs that did
 * not carry it (WAVE3-DESIGN §2.3): mountpoint, remount and snapshot rollback.
 *
 * D3: a broken claims read fail-opens the LUN gate — "nothing held", exactly
 * what a node genuinely serving a LUN would look like — and this verb would
 * then unmount (mountpoint, remount) or SWAP @data (rollback) under a live
 * backstore without anyone being told. The confirm doors warn, never refuse;
 * the job re-reads its advisory under its lock and reports any the confirm did
 * not list on the RESULT (cr.24 ruling (j)).
 *
 * These tests build a minimal app (not `createServer`) for the same reason the
 * iscsi-held suite does: the failure has to be injected through the
 * `zfsMountpoints` TEST SEAM — `readZfsMountpoints` itself fail-opens
 * component by component, so the catch is reachable only by making the read
 * throw, which is precisely the "genuinely broken read" this warns about. The
 * LIO tree is a real capture ("a target, no LUNs" — enough for the read to
 * proceed AND enough that mounting/unmounting the pool was never contested by
 * a real LUN). The pool is this suite's own `tank` (subvol layout, so the
 * rollback is a §12 swap and the remount is a real verb).
 */

const ISCSI_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/iscsi')

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'
const Z = 'ata-TANK_Z'
const SIZE = 2 * GIB + 8 * MIB
const B1 = 2 * GIB - MIB
const LV_SIZE = 4 * GIB
// cr.52r D3: an AHR remount/rollback opens the pool's mountpoint O_PATH before
// the mount — the stored mountpoint must be a REAL directory, so it is a
// per-process tmpdir the harness creates and removes itself.
const MOUNTPOINT = join(tmpdir(), `anas-cr38r-tank-${process.pid}`)
/** The move's target, under the test's TMPDIR — the move job creates it for real. */
const MOVE_BASE = join(tmpdir(), `anas-cr38r-move-${process.pid}`)
const NEW_MOUNTPOINT = join(MOVE_BASE, 'tank-other')

const MDSTAT = `Personalities : [raid5]
md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

const SUBVOL_LIST_S = [
  'ID 258 gen 42 cgen 42 top level 5 otime 2026-07-23 14:23:01 path @snapshots/nightly',
  '',
].join('\n')
const SUBVOL_LIST_R = 'ID 258 gen 42 top level 5 path @snapshots/nightly\n'
const SUBVOL_LIST_ALL = [
  'ID 256 gen 9 top level 5 path @data',
  'ID 257 gen 9 top level 5 path @snapshots',
  'ID 258 gen 42 top level 257 path @snapshots/nightly',
  '',
].join('\n')

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const DISKS = [
  { kernel: 'sdq', id: X, part: 'sdq1' },
  { kernel: 'sdr', id: Y, part: 'sdr1' },
  { kernel: 'sds', id: Z, part: 'sds1' },
]

function ahrLsblkJson(): string {
  const lvmNode = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: MOUNTPOINT, partlabel: null }
  return JSON.stringify({ blockdevices: DISKS.map(d => ({
    name: d.kernel,
    type: 'disk',
    size: SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH',
    serial: d.id,
    children: [{
      name: d.part,
      type: 'part',
      size: B1,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: 'tank-d1-b1',
      children: [{ name: 'md127', type: 'raid5', size: 4190208 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })) })
}

/** The mount table — `ro` decides the pool's `mountedReadOnly` (the remount's first gate). */
function findmntJson(readOnly: boolean): string {
  return JSON.stringify({ filesystems: [{
    target: MOUNTPOINT,
    source: '/dev/mapper/tank-tank--vol',
    fstype: 'btrfs',
    options: `${readOnly ? 'ro' : 'rw'},relatime,space_cache=v2,subvolid=256,subvol=/@data`,
  }] })
}

/**
 * The dev mock's `tank` — snapshots exist, `findmnt` decides read-only.
 * `findmntResults` sequences the mount table (the remount's job-verification
 * read must see read-WRITE after the unmount/mount pair).
 */
function buildExecutor(opts: { ro?: boolean, findmntResults?: ExecResult[] } = {}): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: MDSTAT, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: 'MD_LEVEL=raid5\nMD_DEVICES=3\nMD_METADATA=1.2\nMD_UUID=aaaa:aaaa:aaaa:aaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: `${DISKS.map(d => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${d.id} -> ../../${d.kernel}`).join('\n')}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '1', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], ...(opts.findmntResults ? { results: opts.findmntResults } : { result: ok(findmntJson(opts.ro ?? false)) }) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', MOUNTPOINT], result: ok(BTRFS_USAGE) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', MOUNTPOINT], result: ok(SUBVOL_LIST_ALL) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '-s', MOUNTPOINT], result: ok(SUBVOL_LIST_S) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '-r', MOUNTPOINT], result: ok(SUBVOL_LIST_R) })
  // Mutation plumbing — the on-demand top-level mount + btrfs + rename + mount
  // cycle succeed, and the mountpoint move's daemon-reload is a no-op.
  executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/mount', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/umount', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/mv', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

/**
 * A `zfsMountpoints` seam: healthy (`[]`) until `readFailsAt` calls, then a
 * throw — the genuinely broken read the D3 warning exists for. `[]` is the
 * healthy answer ONLY beside the LUN-less capture, where no backing path needs
 * resolving; the test that asserts "a healthy read discloses nothing" uses it.
 */
function flipRead(readFailsAt: number): () => Promise<ZfsMountpoint[]> {
  let reads = 0
  return async () => {
    reads += 1
    if (reads >= readFailsAt)
      throw new Error('zfs list exploded')
    return []
  }
}

/** The BROKEN read for the confirm tests: it fails on the first (only) read. */
const BROKEN_READ = flipRead(1)

describe('cr.38r — the lio-unreadable advisory on AHR mountpoint, remount and snapshot rollback', () => {
  let dir: string
  let configfs: string
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify> | undefined

  /**
   * Both AHR mutation families on one app (this suite's `tank` satisfies
   * each verb's gates), the LIO capture materialised at a target (no LUNs), and
   * the claims read routed through the `zfsMountpoints` seam. `fstab` carries
   * the tank's line — the mountpoint move rewrites it for real.
   */
  async function build(zfsMountpoints: () => Promise<ZfsMountpoint[]>, opts: { ro?: boolean, findmntResults?: ExecResult[] } = {}) {
    const executor = buildExecutor(opts)
    await materializeConfigfsManifest(
      readFileSync(join(ISCSI_FIXTURES, 'configfs-restore-empty.manifest'), 'utf-8'),
      configfs,
    )
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    const iscsiPaths = {
      configfsRoot: configfs,
      saveconfigPath: join(dir, 'absent-saveconfig.json'),
      pveStorageCfg: join(dir, 'absent-storage.cfg'),
      blockRoot: join(dir, 'absent-block'),
      zfsMountpoints,
    }
    const common = {
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      iscsiPaths,
    }
    await server.register(ahrMutationRoutes, {
      prefix: '/v1',
      ...common,
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      kernelRelease: '7.0.14-8-pve',
    })
    await server.register(ahrSnapshotRoutes, {
      prefix: '/v1',
      ...common,
      intentDir: join(dir, 'intent'),
      subvolRuntimeDir: join(dir, 'run'),
    })
  }

  /** The parts of the confirm sentence every family shares. */
  function assertAdvisory(warnings: string[]): void {
    const line = warnings.find(w => w.includes('could not check whether an iSCSI LUN'))
    assert.ok(line, JSON.stringify(warnings))
    assert.match(line, /served from this pool/)
    assert.match(line, /LIO configuration was unreadable/)
    assert.match(line, /verify by hand/)
  }

  async function waitForJob(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = jobQueue.get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr38r-disclose-'))
    configfs = join(dir, 'target')
    await mkdir(MOUNTPOINT, { recursive: true })
    await writeFile(join(dir, 'fstab'), `/dev/tank/tank-vol ${MOUNTPOINT} btrfs subvol=@data,nofail 0 0\n`)
    await rm(MOVE_BASE, { recursive: true, force: true })
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    await rm(MOVE_BASE, { recursive: true, force: true })
    await rm(MOUNTPOINT, { recursive: true, force: true })
  })

  it('the mountpoint confirm lists the lio-unreadable advisory when the claims read broke (D3)', async () => {
    await build(BROKEN_READ)
    const res = await server!.inject({
      method: 'PUT',
      url: '/v1/ahr/tank/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: NEW_MOUNTPOINT }),
    })
    assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    assertAdvisory(body.error.warnings)
    await server!.close()
  })

  it('the remount confirm lists the lio-unreadable advisory when the claims read broke (D3)', async () => {
    await build(BROKEN_READ, { ro: true })
    const res = await server!.inject({ method: 'POST', url: '/v1/ahr/tank/remount', headers: IDENTITY })
    assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    assertAdvisory(body.error.warnings)
    await server!.close()
  })

  it('the snapshot rollback confirm lists the lio-unreadable advisory when the claims read broke (D3)', async () => {
    await build(BROKEN_READ)
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/ahr/tank/snapshots/nightly/rollback',
      headers: JSON_HEADERS,
      payload: '{}',
    })
    assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    assertAdvisory(body.error.warnings)
    await server!.close()
  })

  it('a HEALTHY claims read discloses nothing on these confirms — the warning rides the failure, not the LIO', async () => {
    await build(flipRead(Number.POSITIVE_INFINITY))
    const mountpoint = await server!.inject({
      method: 'PUT',
      url: '/v1/ahr/tank/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: NEW_MOUNTPOINT }),
    })
    assert.equal(mountpoint.statusCode, 409)
    const warnings = (mountpoint.json() as { error: { warnings: string[] } }).error.warnings
    assert.equal(warnings.some(w => w.includes('could not check whether an iSCSI LUN')), false, JSON.stringify(warnings))
    await server!.close()
  })

  it('a LIO read that breaks after the confirm rides the SNAPSHOT ROLLBACK job result (cr.24 ruling (j))', async () => {
    // The route's read is healthy (nothing disclosed at the confirm); the job's
    // fresh read — after the swap is confirmed — is the broken one, and its
    // advisory rides the result, never a failed job.
    await build(flipRead(3))
    const first = await server!.inject({
      method: 'POST',
      url: '/v1/ahr/tank/snapshots/nightly/rollback',
      headers: JSON_HEADERS,
      payload: '{}',
    })
    assert.equal(first.statusCode, 409, JSON.stringify(first.json()))
    const confirmWarnings = (first.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(!confirmWarnings.some(w => w.includes('could not check whether an iSCSI LUN')), 'the confirm reads a HEALTHY LIO')
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server!.inject({
      method: 'POST',
      url: '/v1/ahr/tank/snapshots/nightly/rollback',
      headers: { ...JSON_HEADERS, 'x-anas-confirm': code },
      payload: '{}',
    })
    assert.equal(second.statusCode, 202, JSON.stringify(second.json()))
    const job = await waitForJob((second.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assertAdvisory((job.result as { warnings?: string[] }).warnings ?? [])
    await server!.close()
  })

  it('a LIO read that breaks after the confirm rides the MOUNTPOINT job result (cr.24 ruling (j))', async () => {
    await build(flipRead(3))
    const first = await server!.inject({
      method: 'PUT',
      url: '/v1/ahr/tank/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: NEW_MOUNTPOINT }),
    })
    assert.equal(first.statusCode, 409, JSON.stringify(first.json()))
    const confirmWarnings = (first.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(!confirmWarnings.some(w => w.includes('could not check whether an iSCSI LUN')), 'the confirm reads a HEALTHY LIO')
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server!.inject({
      method: 'PUT',
      url: '/v1/ahr/tank/mountpoint',
      headers: { ...JSON_HEADERS, 'x-anas-confirm': code },
      payload: JSON.stringify({ mountpoint: NEW_MOUNTPOINT }),
    })
    assert.equal(second.statusCode, 202, JSON.stringify(second.json()))
    const job = await waitForJob((second.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assertAdvisory((job.result as { warnings?: string[] }).warnings ?? [])
    await server!.close()
  })

  it('a LIO read that breaks after the confirm rides the REMOUNT job result (cr.24 ruling (j))', async () => {
    // The mount table answers read-only for the two route doors AND the job's
    // re-guard, then read-WRITE for the job's own post-mount verification — the
    // remount only succeeds when the fault that forced read-only is gone.
    await build(flipRead(3), {
      findmntResults: [
        ok(findmntJson(true)),
        ok(findmntJson(true)),
        ok(findmntJson(true)),
        ok(findmntJson(true)),
        ok(findmntJson(true)),
        ok(findmntJson(true)),
        ok(findmntJson(false)),
      ],
    })
    const first = await server!.inject({ method: 'POST', url: '/v1/ahr/tank/remount', headers: IDENTITY })
    assert.equal(first.statusCode, 409, JSON.stringify(first.json()))
    const confirmWarnings = (first.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(!confirmWarnings.some(w => w.includes('could not check whether an iSCSI LUN')), 'the confirm reads a HEALTHY LIO')
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/remount', headers: { ...IDENTITY, 'x-anas-confirm': code } })
    assert.equal(second.statusCode, 202, JSON.stringify(second.json()))
    const job = await waitForJob((second.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assertAdvisory((job.result as { warnings?: string[] }).warnings ?? [])
    await server!.close()
  })
})
