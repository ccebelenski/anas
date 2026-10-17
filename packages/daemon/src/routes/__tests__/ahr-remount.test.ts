import type { Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { dmsetupStatusArgs } from '../../parsers/dmsetup.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes } from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

/**
 * `POST /v1/ahr/:name/remount` — the read-only aftermath (story ahrcache.1
 * slice 2, AHR-DESIGN §13 "Resolved 2026-09-24").
 *
 * The one thing the automatic uncache CANNOT fix. `lvconvert --uncache`
 * restores reads in the same second with the cache device gone, but if the pool
 * took a WRITE during the failure window the I/O error aborted a btrfs metadata
 * transaction and btrfs set a flag that survives the repair (GT-20):
 *
 *   # mount -o remount,rw /mnt/anas-ahr/gtcache
 *   mount: /mnt/anas-ahr/gtcache: mount point not mounted or bad option.
 *   BTRFS error (device dm-0 state EMA): remounting read-write after error is
 *   not allowed
 *
 * umount + mount restored rw cleanly on the same pool. So the verb runs the
 * expensive pair, not the cheap-looking one that does not work — and because
 * an unmount breaks every open handle on the filesystem, it is confirm-gated
 * and never part of the automatic recovery.
 *
 * Three worlds over a synthetic one-band pool `tank`:
 *   'ro'        mounted read-only, cache absent → the verb's own case
 *   'rw'        mounted read-write            → 409, nothing to remount
 *   'rofailed'  read-only AND the cache still failed → 409, uncache first
 *   'unmounted' not mounted at all                   → 409, bring it online
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'

const DISK_SIZE = 2 * GIB + 8 * MIB
const BAND_SIZE = 2 * GIB - MIB
const LV_SIZE = 2143289344
// cr.52r D3: the remount's mount opens the pool's mountpoint O_PATH — it must
// be a REAL directory, so the stored mountpoint is a per-process tmpdir.
const MOUNTPOINT = join(tmpdir(), `anas-ahr-remount-mp-${process.pid}`)
const DM_NAME = 'tank-tank--vol'

const MDSTAT = `Personalities : [raid1]
md127 : active raid1 sdr1[1] sdq1[0]
      2096128 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`
const MD_EXPORT = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/** The options btrfs leaves after forcing itself read-only (see the header). */
const RO_OPTIONS = 'ro,relatime,space_cache=v2,subvolid=256,subvol=/@data'
const RW_OPTIONS = 'rw,relatime,space_cache=v2,subvolid=256,subvol=/@data'

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

type World = 'ro' | 'rw' | 'rofailed' | 'unmounted'

function readOnly(world: World): boolean {
  return world === 'ro' || world === 'rofailed'
}

const DM_STATUS: Record<World, string> = {
  ro: '0 4186624 linear \n',
  rw: '0 4186624 linear \n',
  unmounted: '0 4186624 linear \n',
  rofailed: '0 4186624 cache Fail\n',
}

function ahrLsblkJson(world: World): string {
  // lsblk's own mountpoint is the topology reader's fallback when findmnt does
  // not name the pool, so an unmounted world has to be unmounted in BOTH views.
  const lvmNode = { name: DM_NAME, type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: world === 'unmounted' ? null : MOUNTPOINT, partlabel: null }
  const member = (kernel: string, id: string, n: number) => ({
    name: kernel,
    type: 'disk',
    size: DISK_SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH DISK',
    serial: id,
    children: [{
      name: `${kernel}1`,
      type: 'part',
      size: BAND_SIZE,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: `tank-d${n}-b1`,
      children: [{ name: 'md127', type: 'raid1', size: 2096128 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })
  return JSON.stringify({ blockdevices: [member('sdq', X, 1), member('sdr', Y, 2)] })
}

function inventoryLsblkJson(): string {
  const flat = (kernel: string, id: string) => ({
    'name': kernel,
    'type': 'disk',
    'size': DISK_SIZE,
    'model': 'SYNTH DISK',
    'serial': id,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'children': [{ name: `${kernel}1`, type: 'part', size: BAND_SIZE, fstype: 'linux_raid_member', mountpoint: null }],
  })
  return JSON.stringify({ blockdevices: [flat('sdq', X), flat('sdr', Y)] })
}

function lvsJson(world: World): string {
  return JSON.stringify({
    report: [{
      lv: [{
        lv_name: 'tank-vol',
        vg_name: 'tank',
        lv_attr: world === 'rofailed' ? 'Cwi-aoC-p-' : '-wi-ao----',
        lv_size: String(LV_SIZE),
        ...(world === 'rofailed' ? { cache_mode: 'writethrough', cache_policy: 'smq' } : {}),
      }],
    }],
  })
}

function pvsJson(world: World): string {
  const rows: Record<string, string>[] = [
    { pv_name: '/dev/md127', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: String(LV_SIZE + 2 * MIB) },
  ]
  if (world === 'rofailed')
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(4 * GIB), pv_free: '0', dev_size: '0' })
  return JSON.stringify({ report: [{ pv: rows }] })
}

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

const BY_ID_LISTING = [
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${X} -> ../../sdq`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${X}-part1 -> ../../sdq1`,
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${Y} -> ../../sdr`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${Y}-part1 -> ../../sdr1`,
  '',
].join('\n')

/**
 * The mount table, twice: read-only on the reads BEFORE the remount, read-write
 * on the ones after it. A single static answer could not tell a verb that
 * worked from one that did not — and the job VERIFIES rather than assumes,
 * because `mount` succeeds and lands read-only again when the fault is still
 * there.
 */
function findmntResults(world: World, healAfter: boolean, target: string = MOUNTPOINT) {
  const table = (options: string) => ok(JSON.stringify({
    filesystems: [{ target, source: `/dev/mapper/${DM_NAME}`, fstype: 'btrfs', options }],
  }))
  if (world === 'unmounted')
    return [ok(JSON.stringify({ filesystems: [] }))]
  if (!readOnly(world))
    return [table(RW_OPTIONS)]
  // Reads come in pairs since cr.23: each request (the confirm challenge and
  // the confirmed one) reads the table twice — the route's pool load and the
  // system-pool gate, which must answer BEFORE any confirm code is offered.
  // Since cr.38 the job runs the same pair again before it acts (the guard
  // re-reads the pool and re-runs every gate). Reads 1–6 are therefore all
  // read-only; the seventh is the job's own verification after `mount`, and
  // the last entry repeats from there.
  return healAfter
    ? [table(RO_OPTIONS), table(RO_OPTIONS), table(RO_OPTIONS), table(RO_OPTIONS), table(RO_OPTIONS), table(RO_OPTIONS), table(RW_OPTIONS)]
    : [table(RO_OPTIONS)]
}

function buildExecutor(world: World, healAfter = true, target: string = MOUNTPOINT): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: ok(ahrLsblkJson(world)) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: ok(inventoryLsblkJson()) })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_LISTING) })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '1', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] })) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok(pvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs(DM_NAME), result: ok(DM_STATUS[world]) })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], results: findmntResults(world, healAfter, target) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', target], result: ok(BTRFS_USAGE) })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: ok('') })
  executor.addFixture({ command: '/usr/bin/umount', result: ok('') })
  executor.addFixture({ command: '/usr/bin/mount', result: ok('') })
  return executor
}

async function waitForJob(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const job = jobQueue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

describe('POST /v1/ahr/:name/remount (ahrcache.1 slice 2)', () => {
  let dir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(world: World, healAfter = true, target: string = MOUNTPOINT) {
    executor = buildExecutor(world, healAfter, target)
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      iscsiPaths: { saveConfigPath: join(dir, 'saveconfig.json'), configfsRoot: join(dir, 'configfs') },
    })
    await server.ready()
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-remount-'))
    await mkdir(MOUNTPOINT, { recursive: true })
    await writeFile(join(dir, 'fstab'), `/dev/tank/tank-vol ${MOUNTPOINT} btrfs subvol=@data,nofail 0 0\n`)
  })

  afterEach(async () => {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
    await rm(MOUNTPOINT, { recursive: true, force: true })
  })

  function post(headers: Record<string, string> = IDENTITY_HEADERS) {
    return server.inject({ method: 'POST', url: '/v1/ahr/tank/remount', headers })
  }

  it('401s without identity headers', async () => {
    await build('ro')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/remount' })
    assert.equal(res.statusCode, 401)
  })

  it('404s for a pool this node does not have', async () => {
    await build('ro')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/nosuch/remount', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 404)
  })

  it('409s on a read-WRITE pool — there is nothing to remount', async () => {
    await build('rw')
    const res = await post()
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /mounted read-write — there is nothing to remount/)
    // The cost of this verb is every open handle on the filesystem. Running it
    // "just in case" spends that for nothing.
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/umount').length, 0)
  })

  it('409s on a pool that is not mounted at all', async () => {
    await build('unmounted')
    const res = await post()
    assert.equal(res.statusCode, 409)
    // Different sentence from the read-write one on purpose: "there is nothing
    // to remount" would be true and useless — the next move is to bring the
    // pool online, which is a different screen.
    assert.match(res.json().error.message, /is not mounted, so there is nothing to remount/)
    assert.match(res.json().error.message, /Bring the pool online first/)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/umount').length, 0)
  })

  it('409s while the read cache is STILL failed — uncache first', async () => {
    await build('rofailed')
    const res = await post()
    assert.equal(res.statusCode, 409)
    const message = res.json().error.message
    // GT-19: every read through a dead dm-cache returns EIO, so a remount
    // would land a filesystem that cannot serve a byte and btrfs would force it
    // read-only again on the first error.
    assert.match(message, /still has a FAILED read cache/)
    assert.match(message, /Detach the cache first/)
    assert.match(message, /no data is lost/)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/umount').length, 0)
  })

  it('409s with a confirm code, and the warnings name the open-handle break', async () => {
    await build('ro')
    const res = await post()
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
    const warnings = res.json().error.warnings as string[]
    assert.ok(warnings.some(w => w.includes('Open share handles break') && w.includes(MOUNTPOINT)), warnings.join(' | '))
    // The second warning is why the cheap call is not offered instead.
    assert.ok(warnings.some(w => w.includes('btrfs refuses `mount -o remount,rw` after an I/O error')), warnings.join(' | '))
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/umount').length, 0)
  })

  it('cr.52r P2 — a pool whose STORED mountpoint now resolves through a symlinked parent: 409 before any umount/mount', async () => {
    // The remount verb MOUNTS the stored path again, so the stored path runs
    // the mount-target refusal. Build the pool mounted at a real, once-legal
    // path, then swap its parent the way a rebuilt tree (or the operator)
    // could — the verb must refuse at the route, naming the stored path.
    const stored = join(dir, 'stored')
    const poolMountpoint = join(stored, 'pool')
    await mkdir(poolMountpoint, { recursive: true })
    await build('ro', true, poolMountpoint)
    await rm(poolMountpoint, { recursive: true, force: true })
    await rmdir(stored)
    await symlink('/etc', stored)

    const res = await post()
    assert.equal(res.statusCode, 409, res.body)
    const err = res.json().error
    assert.equal(err.code, 'CONFLICT')
    assert.equal(err.reason, 'system-mount-target', JSON.stringify(err))
    assert.ok(err.message.includes(poolMountpoint), `names the stored path: ${err.message}`)
    assert.match(err.message, /symlink/)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/umount').length, 0, 'no unmount before the refusal')
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/mount').length, 0, 'no mount')
  })

  it('unmounts and mounts — never `remount,rw`, which btrfs refuses', async () => {
    await build('ro')
    const code = (await post()).headers['x-anas-confirm-code'] as string
    const res = await post({ ...IDENTITY_HEADERS, 'x-anas-confirm': code })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual((job.result as { mountpoint: string, readOnly: boolean }), { mountpoint: MOUNTPOINT, readOnly: false })

    const mountCalls = executor.calls.filter(c => c.command === '/usr/bin/umount' || c.command === '/usr/bin/mount')
    assert.equal(mountCalls[0]!.command, '/usr/bin/umount')
    assert.deepEqual(mountCalls[0]!.args, ['--', MOUNTPOINT])
    // cr.52r D3: mounted DIRECTLY from the pool's OWN fstab entry (the spec and
    // its line's KERNEL options — the userspace-only tokens stay on the line,
    // cr.52s-e) through the daemon-opened directory, never
    // an invented mount at the typed path. cr.52s-c: the route hands the service
    // the SERVER's fstabPath — the harness's own `build()` registers
    // `fstabPath: join(dir, 'fstab')` (a non-default path) and beforeEach writes
    // the pool's line `subvol=@data,nofail` there, so the argv carries THAT
    // line's kernel option (the `subvol=@data` passthrough token; the common
    // `nofail` flag is userspace-only and dropped from the argv, cr.52s-e) —
    // proof the service read the route's
    // file, not its ANAS_FSTAB_PATH//etc/fstab fallback (which has no line for
    // this pool, and would re-mount with ANAS's defaults, iSCSI ordering pair
    // included).
    const m = mountCalls[1]!
    assert.equal(m.command, '/usr/bin/mount')
    assert.deepEqual(m.args, ['-c', '-t', 'btrfs', '-o', 'subvol=@data', '--', '/dev/tank/tank-vol', '/proc/self/fd/3/.'])
    assert.equal(m.fdPaths?.[0], MOUNTPOINT, 'the fd resolves to the pool mountpoint')
    // GT-20's negative: `mount -o remount,rw` is refused after an error, so it
    // must never be what this verb reaches for.
    assert.ok(!executor.calls.some(c => c.args.includes('remount,rw')))
  })

  it('cr.52s-e: the remount argv drops the userspace tokens the pool\'s LINE keeps (argv `-o` vs line, side by side)', async () => {
    await build('ro')
    const code = (await post()).headers['x-anas-confirm-code'] as string
    const res = await post({ ...IDENTITY_HEADERS, 'x-anas-confirm': code })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // THE LINE is untouched — the beforeEach line keeps its `nofail`.
    const line = (await readFile(join(dir, 'fstab'), 'utf8')).split('\n').find(l => l.includes('/dev/tank/tank-vol'))!
    assert.equal(line, `/dev/tank/tank-vol ${MOUNTPOINT} btrfs subvol=@data,nofail 0 0`)
    // THE DIRECT MOUNT carries only the line's kernel option — `nofail` would
    // land in /run/mount/utab under the fd target (cr.52s-d's node fact).
    const m = executor.calls.filter(c => c.command === '/usr/bin/mount').at(-1)!
    assert.deepEqual(m.args, ['-c', '-t', 'btrfs', '-o', 'subvol=@data', '--', '/dev/tank/tank-vol', '/proc/self/fd/3/.'])
  })

  it('FAILS the job when the pool comes back read-only anyway', async () => {
    // `mount` succeeds and btrfs re-applies the flag when the fault is still
    // present. Reporting that as success sends the operator away from the one
    // screen that could tell them.
    await build('ro', false)
    const code = (await post()).headers['x-anas-confirm-code'] as string
    const res = await post({ ...IDENTITY_HEADERS, 'x-anas-confirm': code })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /mounted again but is STILL read-only/)
    assert.match(job.error!.message, /Hybrid RAID view/)
  })
})
