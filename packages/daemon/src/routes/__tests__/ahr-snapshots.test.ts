import type { AhrExpansionIntent, Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { JobQueue } from '../../jobs/queue.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { AHR_SNAPSHOT_DELETE_PRESENTATION_ONLY, AHR_SNAPSHOT_ROLLBACK_PRESENTATION_ONLY, ahrSnapshotRoutes } from '../ahr-snapshots.js'
import { jobRoutes } from '../jobs.js'

/**
 * AHR snapshot routes (story 11.12, AHR-DESIGN §12/§4). A minimal single-band
 * raid5×3 pool "tank", mounted subvol=@data (so subvolLayout is true), with two
 * snapshots (`nightly` read-only, `pre-rollback-…` writable).
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'
const Z = 'ata-TANK_Z'
const SIZE = 2 * GIB + 8 * MIB
const B1 = 2 * GIB - MIB
const LV_SIZE = 4 * GIB

const MDSTAT = `Personalities : [raid5]
md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

const SUBVOL_LIST_S = [
  'ID 258 gen 42 cgen 42 top level 5 otime 2026-07-23 14:23:01 path @snapshots/nightly',
  'ID 261 gen 57 cgen 57 top level 5 otime 2026-07-24 09:00:00 path @snapshots/pre-rollback-2026-07-24T090000Z',
  '',
].join('\n')
const SUBVOL_LIST_R = 'ID 258 gen 42 top level 5 path @snapshots/nightly\n'
// The PLAIN list is the membership source listAhrSnapshots reads (a writable
// pre-rollback preserve is invisible to `-s`): @data + @snapshots + both snaps.
const SUBVOL_LIST_ALL = [
  'ID 256 gen 9 top level 5 path @data',
  'ID 257 gen 9 top level 5 path @snapshots',
  'ID 258 gen 42 top level 257 path @snapshots/nightly',
  'ID 261 gen 57 top level 257 path @snapshots/pre-rollback-2026-07-24T090000Z',
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

const CAP = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function mkIntent(state: AhrExpansionIntent['state']): AhrExpansionIntent {
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: [X, Y, Z], before: CAP, after: CAP, state }
}

const DISKS = [
  { kernel: 'sdq', id: X, part: 'sdq1' },
  { kernel: 'sdr', id: Y, part: 'sdr1' },
  { kernel: 'sds', id: Z, part: 'sds1' },
]

function ahrLsblkJson(mountpoint: string): string {
  const lvmNode = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint, partlabel: null }
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

/** subvolLayout is derived from the mount subvol= option (§12). */
function findmntJson(subvol: string, mountpoint: string): string {
  return JSON.stringify({ filesystems: [{
    target: mountpoint,
    source: '/dev/mapper/tank-tank--vol',
    fstype: 'btrfs',
    options: `rw,relatime,space_cache=v2,${subvol}`,
  }] })
}

/**
 * `lvAttr` drives the pool's state: the 5th field is LVM's state flag, so
 * '-wi-----p-' (not 'a') is a present-but-inactive LV — the issue #18 offline
 * evidence, and the cheapest way to put this pool's read layer into the state
 * the mutation gate has to refuse.
 */
function buildExecutor(opts: { subvol?: string, lvAttr?: string, mountpoint?: string } = {}): MockExecutor {
  const executor = new MockExecutor()
  // The pool's mountpoint must be a REAL directory when a rollback's fd-pinned
  // remount opens it (cr.52r D3) — callers override `mountpoint` with a temp
  // path and mkdir it; the default matches the pre-cr.52r fixtures.
  const mp = opts.mountpoint ?? '/mnt/anas-ahr/tank'
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: MDSTAT, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: 'MD_LEVEL=raid5\nMD_DEVICES=3\nMD_METADATA=1.2\nMD_UUID=aaaa:aaaa:aaaa:aaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(mp), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: `${DISKS.map(d => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${d.id} -> ../../${d.kernel}`).join('\n')}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '1', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: opts.lvAttr ?? '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: { stdout: findmntJson(opts.subvol ?? 'subvolid=256,subvol=/@data', mp), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', mp], result: { stdout: BTRFS_USAGE, stderr: '', exitCode: 0 } })
  // Snapshot listing against the live @data mount: the plain list is the
  // membership source; `-s` supplies otime, `-r` the readonly set.
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', mp], result: { stdout: SUBVOL_LIST_ALL, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '-s', mp], result: { stdout: SUBVOL_LIST_S, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '-r', mp], result: { stdout: SUBVOL_LIST_R, stderr: '', exitCode: 0 } })
  // Mutation plumbing — the on-demand top-level mount + btrfs + rename succeed.
  executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/mount', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/umount', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/mv', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

async function waitForJob(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = jobQueue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

describe('AHR snapshot routes (story 11.12)', () => {
  let dir: string
  let runtimeDir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(opts: { subvol?: string, lvAttr?: string, fstabPath?: string } = {}) {
    // cr.52r D3: the pool's mountpoint must exist for the fd-pinned remount a
    // rollback runs in its finally — the pool fixture needs a real directory.
    // It sits one level deep (under `stored`) so a P2 probe can swap the parent
    // (rc.52r P2: a STORED path whose parent becomes a symlink refuses).
    await mkdir(join(dir, 'stored'), { recursive: true }).catch(() => {})
    const poolMountpoint = join(dir, 'stored', 'pool')
    await mkdir(poolMountpoint, { recursive: true }).catch(() => {})
    executor = buildExecutor({ ...opts, mountpoint: poolMountpoint })
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrSnapshotRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      intentDir: dir,
      subvolRuntimeDir: runtimeDir,
      // cr.52s-c: the server's fstab, as registered on the route — the
      // rollback's remount reads the pool's line from THIS file.
      ...(opts.fstabPath !== undefined ? { fstabPath: opts.fstabPath } : {}),
    })
  }

  /** Commands that would MUTATE data — a refusal must issue NONE. */
  function mutatingCalls(): { command: string, args: string[] }[] {
    return executor.calls.filter(c =>
      c.command === '/usr/bin/mv'
      || (c.command === '/usr/bin/btrfs' && ['snapshot', 'delete'].includes(c.args[1])))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-snaproute-intent-'))
    runtimeDir = await mkdtemp(join(tmpdir(), 'anas-snaproute-run-'))
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    await rm(runtimeDir, { recursive: true, force: true })
  })

  it('GET lists snapshots, joining otime (-s) with the readonly set (-r)', async () => {
    await build()
    const res = await server.inject({ method: 'GET', url: '/v1/ahr/tank/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().data, [
      { name: 'nightly', createdAt: '2026-07-23T14:23:01', readonly: true },
      { name: 'pre-rollback-2026-07-24T090000Z', createdAt: '2026-07-24T09:00:00', readonly: false },
    ])
  })

  it('GET 404 for an unknown pool', async () => {
    await build()
    const res = await server.inject({ method: 'GET', url: '/v1/ahr/nope/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('POST create with no name defaults to a UTC-timestamp name (202 job)', async () => {
    await build()
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.match((job.result as { snapshot: string }).snapshot, /^\d{4}-\d{2}-\d{2}T\d{6}Z$/)
  })

  it('POST create rejects a charset-invalid name (400)', async () => {
    await build()
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots', headers: JSON_HEADERS, payload: JSON.stringify({ name: '../evil' }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(mutatingCalls().length, 0)
  })

  it('POST create 409 when the snapshot name already exists', async () => {
    await build()
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'nightly' }) })
    assert.equal(res.statusCode, 409)
    assert.ok(res.json().error.message.includes('already exists'))
  })

  it('DELETE 409-confirms then 202s; the confirm carries the concrete consequence', async () => {
    await build()
    const first = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/snapshots/nightly', headers: IDENTITY })
    assert.equal(first.statusCode, 409)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(first.json().error.warnings.some((w: string) => w.includes('untouched')))
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    assert.equal(mutatingCalls().length, 0) // a 409 mutated nothing

    const second = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/snapshots/nightly', headers: { ...IDENTITY, 'x-anas-confirm': code } })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(jobQueue, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { pool: 'tank', deleted: 'nightly' })
  })

  it('DELETE 404 for a snapshot that does not exist', async () => {
    await build()
    const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/snapshots/ghost', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('rollback 409-confirms (stating unmount + auto-preserve), then 202s', async () => {
    await build()
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(first.statusCode, 409)
    const warnings: string[] = first.json().error.warnings
    assert.ok(warnings.some(w => w.toUpperCase().includes('UNMOUNT')), 'states the unmount')
    assert.ok(warnings.some(w => w.includes('pre-rollback')), 'states the auto-preserve')
    assert.ok(warnings.some(w => w.toLowerCase().includes('nothing is destroyed')))
    const code = first.headers['x-anas-confirm-code'] as string

    const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: '{}' })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(jobQueue, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { rolledBackTo: string, preserved: string }
    assert.equal(result.rolledBackTo, 'nightly')
    assert.match(result.preserved, /^pre-rollback-/)
  })

  it('cr.52s-c — the rollback remount carries the line from the fstab the ROUTE was registered with (the server fstabPath, not the service fallback)', async () => {
    // A fixture fstab under the temp dir — the pool's line with an option
    // (`noatime`) ANAS's defaults do NOT write, and WITHOUT the nofail +
    // iSCSI-ordering defaults the no-line fallback carries: if the service
    // read its ANAS_FSTAB_PATH//etc/fstab fallback instead of the route's,
    // the argv would carry those defaults and never `noatime`.
    const fstabPath = join(dir, 'server-fstab')
    await writeFile(fstabPath, `/dev/tank/tank-vol ${join(dir, 'stored', 'pool')} btrfs subvol=@data,noatime 0 0\n`)
    await build({ fstabPath })
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: '{}' })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(jobQueue, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // The pool's remount (the finally's fd-pinned mount, spec = the LV): the
    // stored line's options in the serializer's order (the common `noatime`
    // flag, then the `subvol=@data` passthrough token).
    const remount = executor.calls.filter(c => c.command === '/usr/bin/mount' && c.args.at(-1) === '/proc/self/fd/3/.' && c.args.includes('/dev/tank/tank-vol')).at(-1)
    assert.ok(remount, 'the rollback re-mounted the pool through the fd')
    assert.deepEqual(remount!.args, ['-c', '-t', 'btrfs', '-o', 'noatime,subvol=@data', '--', '/dev/tank/tank-vol', '/proc/self/fd/3/.'])
  })

  it('a rollback whose STORED path now resolves through a symlinked parent refuses BEFORE the swap (cr.52r P2)', async () => {
    await build()
    const stored = join(dir, 'stored')
    const poolMountpoint = join(stored, 'pool')
    // The stored-path gate (`mountTargetRefusal(pool.mountpoint)`) reads the
    // path as it is NOW: swap the parent the way a rebuilt tree (or the
    // operator) could, and the rollback must refuse before any btrfs/mv.
    await rm(join(stored, 'pool'), { recursive: true, force: true })
    await rmdir(stored)
    await symlink('/etc', stored)

    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.statusCode, 409, res.body)
    const err = res.json().error
    assert.equal(err.code, 'CONFLICT')
    assert.equal(err.reason, 'system-mount-target')
    assert.ok(err.message.includes(poolMountpoint), `names the stored path: ${err.message}`)
    assert.match(err.message, /symlink/)
    assert.equal(mutatingCalls().length, 0, 'no btrfs/mv ran')
    // No confirm offered — a hard refusal, nothing to sign.
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('flat-layout pool: GET is empty and every mutation is refused (no migration)', async () => {
    await build({ subvol: 'subvolid=5,subvol=/' })
    const list = await server.inject({ method: 'GET', url: '/v1/ahr/tank/snapshots', headers: IDENTITY })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().data, [])

    for (const req of [
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots', payload: '{}' },
      { method: 'DELETE' as const, url: '/v1/ahr/tank/snapshots/nightly' },
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots/nightly/rollback', payload: '{}' },
    ]) {
      const res = await server.inject({ ...req, headers: req.payload ? JSON_HEADERS : IDENTITY })
      assert.equal(res.statusCode, 409, `${req.method} ${req.url}`)
      assert.ok(res.json().error.message.includes('flat layout'), req.url)
    }
    assert.equal(mutatingCalls().length, 0)
  })

  it('refuses every mutation on an OFFLINE pool — nothing is mounted to snapshot', async () => {
    // The gate predates `offline` (issue #18): an unassembled pool read
    // `degraded` and walked straight through it, leaving btrfs to fail with an
    // errno that names a path instead of the condition.
    await build({ lvAttr: '-wi-----p-' })
    for (const req of [
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots', payload: '{}' },
      { method: 'DELETE' as const, url: '/v1/ahr/tank/snapshots/nightly' },
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots/nightly/rollback', payload: '{}' },
    ]) {
      const res = await server.inject({ ...req, headers: req.payload ? JSON_HEADERS : IDENTITY })
      assert.equal(res.statusCode, 409, `${req.method} ${req.url}`)
      const { message } = res.json().error
      assert.ok(message.includes('is offline'), message)
      // Says WHY, and where to look — never a bare state word.
      assert.ok(message.includes('the volume is not assembled'), message)
    }
    assert.equal(mutatingCalls().length, 0)
  })

  it('refuses every mutation while an expansion intent exists', async () => {
    await build()
    await writeIntent('tank', mkIntent('running'), { dir })
    for (const req of [
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots', payload: '{}' },
      { method: 'DELETE' as const, url: '/v1/ahr/tank/snapshots/nightly' },
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots/nightly/rollback', payload: '{}' },
    ]) {
      const res = await server.inject({ ...req, headers: req.payload ? JSON_HEADERS : IDENTITY })
      assert.equal(res.statusCode, 409, `${req.method} ${req.url}`)
      assert.ok(res.json().error.message.includes('expansion intent'), req.url)
    }
    assert.equal(mutatingCalls().length, 0)
  })
})

/**
 * Story cr.38 session A — the snapshot verbs on the guard (WAVE3-DESIGN §2.3
 * "snapshot create / delete / rollback": every gate request-time only; the
 * rollback had no system-pool gate). The confirmed job is held behind four
 * placeholder jobs, the node's state changes, the slots are released: the
 * job refuses and nothing mutates.
 *
 * Flips: the LIO tree is the captured `iscsi/configfs-restore-empty.manifest`
 * at the confirm and `iscsi/configfs-live.manifest` with its fileio image
 * re-pointed onto the pool's mountpoint in the job; the mount table is this
 * suite's own `tank` row, moved to `/var` (a system path); the snapshot list
 * is this suite's plain list without `nightly`; the intent is the daemon's own
 * file.
 */
describe('cr.38 — the AHR snapshot verbs re-gate in the job (ruling (j))', () => {
  const ISCSI_FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures/iscsi')
  const LIO_NO_LUNS = readFileSync(join(ISCSI_FIXTURES, 'configfs-restore-empty.manifest'), 'utf-8')
  /**
   * The LUN-image manifest, ON the pool (cr.52r: the pool lives at the temp
   * mountpoint, so the image path rides it — the LUN-held gate checks the
   * image's path against the pool's mountpoint).
   */
  const lioLunOnTank = (mp: string): string =>
    readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8')
      .replace('udev_path = /gtiscsi/images/lun2.raw', `udev_path = ${mp}/images/lun2.raw`)
  const LIST_WITHOUT_NIGHTLY = SUBVOL_LIST_ALL.replace('ID 258 gen 42 top level 257 path @snapshots/nightly\n', '')

  let dir: string
  let runtimeDir: string
  let configfs: string
  let poolMountpoint: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>
  /** Overrides for the flippable reads (null: the suite's own fixture). */
  let findmnt: string | null = null
  let subvolList: string | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr38-snap-'))
    runtimeDir = join(dir, 'run')
    configfs = join(dir, 'target')
    findmnt = null
    subvolList = null
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function build() {
    await materializeConfigfsManifest(LIO_NO_LUNS, configfs)
    // cr.52r D3: the pool's mountpoint must exist for a rollback's fd-pinned
    // remount — the pool fixture needs a real directory.
    poolMountpoint = join(dir, 'pool')
    await mkdir(poolMountpoint, { recursive: true })
    executor = buildExecutor({ mountpoint: poolMountpoint })
    const orig = executor.exec.bind(executor)
    executor.exec = async (command, args, opts) => {
      if (command === '/usr/bin/findmnt' && findmnt !== null && args.join(' ') === AHR_FINDMNT_ARGS.join(' '))
        return { stdout: findmnt, stderr: '', exitCode: 0 }
      if (command === '/usr/bin/btrfs' && subvolList !== null && args.join(' ') === `subvolume list ${poolMountpoint}`)
        return { stdout: subvolList, stderr: '', exitCode: 0 }
      return orig(command, args, opts)
    }
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrSnapshotRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      intentDir: join(dir, 'intent'),
      subvolRuntimeDir: runtimeDir,
      iscsiPaths: {
        configfsRoot: configfs,
        saveconfigPath: join(dir, 'absent-saveconfig.json'),
        pveStorageCfg: join(dir, 'absent-storage.cfg'),
        blockRoot: join(dir, 'absent-block'),
      },
    })
  }

  /** What would mean a snapshot verb acted. */
  function mutating(): { command: string, args: string[] }[] {
    return executor.calls.filter(c =>
      c.command === '/usr/bin/mv'
      || c.command === '/usr/bin/umount'
      || (c.command === '/usr/bin/btrfs' && c.args[0] === 'subvolume' && ['snapshot', 'delete', 'create'].includes(c.args[1])))
  }

  /** Hold the four slots, send the request (with a confirm round when `confirm`), return the queued job. */
  async function queued(method: 'POST' | 'DELETE', url: string, confirm: boolean): Promise<{ id: string, release: () => void }> {
    let code: string | undefined
    if (confirm) {
      const first = await server.inject({ method, url, headers: JSON_HEADERS, payload: '{}' })
      assert.equal(first.statusCode, 409, first.body)
      code = first.headers['x-anas-confirm-code'] as string
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      jobQueue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const res = await server.inject({ method, url, headers: code ? { ...JSON_HEADERS, 'x-anas-confirm': code } : JSON_HEADERS, payload: '{}' })
    assert.equal(res.statusCode, 202, res.body)
    const id = res.json().job.id as string
    assert.equal(jobQueue.get(id)?.status, 'queued')
    return { id, release }
  }

  async function refused(id: string, release: () => void, code: string, message: RegExp): Promise<void> {
    release()
    const job = await waitForJob(jobQueue, id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error?.code, code, JSON.stringify(job.error))
    assert.match(job.error!.message, message)
    assert.deepEqual(mutating(), [], 'no mutating argv')
  }

  const ROLLBACK = '/v1/ahr/tank/snapshots/nightly/rollback'

  it('control: with nothing changed the held rollback runs and swaps', async () => {
    await build()
    const { id, release } = await queued('POST', ROLLBACK, true)
    release()
    const job = await waitForJob(jobQueue, id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(mutating().length > 0)
  })

  it('rollback: a LUN that appears between the confirm and the job refuses it — no mutating argv', async () => {
    await build()
    const { id, release } = await queued('POST', ROLLBACK, true)
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(lioLunOnTank(poolMountpoint), configfs)
    await refused(id, release, 'CONFLICT', /^Rolling back AHR pool 'tank' is refused: it is held by iSCSI LUN/)
  })

  it('rollback: the pool mounted at a system path between the confirm and the job refuses it (cr.38 adds the gate) — no mutating argv', async () => {
    await build()
    const { id, release } = await queued('POST', ROLLBACK, true)
    findmnt = findmntJson('subvolid=256,subvol=/@data', poolMountpoint).replace(`"target":"${poolMountpoint}"`, '"target":"/var"')
    assert.match(findmnt, /"target":"\/var"/)
    await refused(id, release, 'CONFLICT', /mounted at \/var — ANAS never destroys or remounts a system pool/)
  })

  it('rollback: an expansion intent that appears between the confirm and the job refuses it — no mutating argv', async () => {
    await build()
    const { id, release } = await queued('POST', ROLLBACK, true)
    await writeIntent('tank', mkIntent('halted'), { dir: join(dir, 'intent') })
    await refused(id, release, 'CONFLICT', /has an expansion intent \(state 'halted'\)/)
  })

  it('rollback: the snapshot deleted between the confirm and the job fails it NOT_FOUND — no mutating argv', async () => {
    await build()
    const { id, release } = await queued('POST', ROLLBACK, true)
    subvolList = LIST_WITHOUT_NIGHTLY
    await refused(id, release, 'NOT_FOUND', /Snapshot 'nightly' not found in pool 'tank'/)
  })

  it('delete: the snapshot deleted elsewhere between the confirm and the job fails it NOT_FOUND — no mutating argv', async () => {
    await build()
    const { id, release } = await queued('DELETE', '/v1/ahr/tank/snapshots/nightly', true)
    subvolList = LIST_WITHOUT_NIGHTLY
    await refused(id, release, 'NOT_FOUND', /Snapshot 'nightly' not found/)
  })

  it('create: an expansion intent that appears while the job waits refuses it — no mutating argv', async () => {
    await build()
    const { id, release } = await queued('POST', '/v1/ahr/tank/snapshots', false)
    await writeIntent('tank', mkIntent('running'), { dir: join(dir, 'intent') })
    await refused(id, release, 'CONFLICT', /has an expansion intent \(state 'running'\)/)
  })

  it('the snapshot confirms sign the whole request — no presentation-only fields', () => {
    assert.deepEqual(AHR_SNAPSHOT_DELETE_PRESENTATION_ONLY, {})
    assert.deepEqual(AHR_SNAPSHOT_ROLLBACK_PRESENTATION_ONLY, {})
  })
})
