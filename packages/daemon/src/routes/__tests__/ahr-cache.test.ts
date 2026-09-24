import type { AhrExpansionIntent, Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
import { AHR_CACHE_LSBLK_ARGS } from '../../services/ahr-cache.js'
import { diskLsblkArgs } from '../../services/ahr-expand-exec.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, readAhrPools } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrCacheRoutes } from '../ahr-cache.js'
import { collectDisks } from '../disks.js'
import { jobRoutes } from '../jobs.js'

/**
 * AHR read-cache routes (story ahrcache.1, AHR-DESIGN §13/§4) over a synthetic
 * one-band pool `tank` (md127 across members X and Y), an available SSD `C`
 * and an available spinning disk `R`.
 *
 * Three worlds, because the routes' answers turn on exactly one thing — what
 * `dmsetup status` says about the pool LV:
 *   'none'    no cache        → attach proceeds, detach 409s
 *   'healthy' a live cache    → attach 409s, detach proceeds
 *   'failed'  a dead device   → the pool reads degraded, detach is the recovery
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X' // band member → sdq
const Y = 'ata-TANK_Y' // band member → sdr
const C = 'ata-TANK_C' // available SSD, the cache pick → sds
const R = 'ata-TANK_R' // available SPINNING disk → sdt

const DISK_SIZE = 2 * GIB + 8 * MIB
const BAND_SIZE = 2 * GIB - MIB
const LV_SIZE = 2143289344
const CACHE_SLICE_SIZE = 4 * GIB
const CACHE_PV_SIZE = CACHE_SLICE_SIZE - 3 * MIB
const CACHE_DISK_SIZE = 4 * GIB + 8 * MIB

const MDSTAT = `Personalities : [raid1]
md127 : active raid1 sdr1[1] sdq1[0]
      2096128 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`

const MD_EXPORT = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

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
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: [X, Y], before: CAP, after: CAP, state }
}

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

type World = 'none' | 'healthy' | 'failed'

/** The pool LV's dm status, verbatim in shape from the live captures. */
const DM_STATUS: Record<World, string> = {
  none: '0 4186624 linear \n',
  healthy: '0 4186624 cache 8 24/2048 128 8/8000 152 28 0 0 0 8 0 2 metadata2 writethrough 2 migration_threshold 2048 mq 10 random_threshold 0 sequential_threshold 0 discard_promote_adjustment 0 read_promote_adjustment 0 write_promote_adjustment 0 rw - \n',
  failed: '0 4186624 cache Fail\n',
}

/** The AHR stack lsblk tree: two band members, plus the cache slice when cached. */
function ahrLsblkJson(world: World): string {
  const lvmNode = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }
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
  const cacheDisk = {
    name: 'sds',
    type: 'disk',
    size: CACHE_DISK_SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH SSD',
    serial: C,
    children: world === 'none'
      ? []
      : [{ name: 'sds1', type: 'part', size: CACHE_SLICE_SIZE, fstype: 'LVM2_member', mountpoint: null, partlabel: 'tank-cache1' }],
  }
  const spinner = { name: 'sdt', type: 'disk', size: CACHE_DISK_SIZE, fstype: null, mountpoint: null, partlabel: null, model: 'SYNTH HDD', serial: R, children: [] }
  // A FAILED cache device is GONE — lsblk no longer sees the disk at all.
  const disks: unknown[] = [member('sdq', X, 1), member('sdr', Y, 2), spinner]
  if (world !== 'failed')
    disks.splice(2, 0, cacheDisk)
  return JSON.stringify({ blockdevices: disks })
}

/** The flat /v1/disks lsblk view. */
function inventoryLsblkJson(world: World): string {
  const flat = (kernel: string, id: string, size: number, rota: boolean, parts: object[], model: string) => ({
    'name': kernel,
    'type': 'disk',
    'size': size,
    'model': model,
    'serial': id,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': rota,
    'phy-sec': 512,
    'log-sec': 512,
    'children': parts,
  })
  const part = (name: string, size: number, fstype: string) => ({ name, type: 'part', size, fstype, mountpoint: null })
  const disks = [
    flat('sdq', X, DISK_SIZE, true, [part('sdq1', BAND_SIZE, 'linux_raid_member')], 'SYNTH DISK'),
    flat('sdr', Y, DISK_SIZE, true, [part('sdr1', BAND_SIZE, 'linux_raid_member')], 'SYNTH DISK'),
    flat('sdt', R, CACHE_DISK_SIZE, true, [], 'SYNTH HDD'),
  ]
  if (world !== 'failed') {
    disks.splice(2, 0, flat('sds', C, CACHE_DISK_SIZE, false, world === 'none' ? [] : [part('sds1', CACHE_SLICE_SIZE, 'LVM2_member')], 'SYNTH SSD'))
  }
  return JSON.stringify({ blockdevices: disks })
}

function pvsJson(world: World): string {
  const rows: Record<string, string>[] = [
    { pv_name: '/dev/md127', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: String(LV_SIZE + 2 * MIB) },
  ]
  if (world === 'healthy')
    rows.push({ pv_name: '/dev/sds1', vg_name: 'tank', pv_size: String(CACHE_PV_SIZE), pv_free: '0', dev_size: String(CACHE_SLICE_SIZE) })
  if (world === 'failed')
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(CACHE_PV_SIZE), pv_free: '0', dev_size: '0' })
  return JSON.stringify({ report: [{ pv: rows }] })
}

function lvsJson(world: World): string {
  const cached = world !== 'none'
  return JSON.stringify({
    report: [{
      lv: [{
        lv_name: 'tank-vol',
        vg_name: 'tank',
        lv_attr: cached ? (world === 'failed' ? 'Cwi-aoC-p-' : 'Cwi-aoC---') : '-wi-ao----',
        lv_size: String(LV_SIZE),
        ...(cached
          ? {
              cache_mode: 'writethrough',
              cache_policy: 'smq',
              cache_total_blocks: '8000',
              cache_used_blocks: '1036',
              cache_read_hits: '795',
              cache_read_misses: '3585',
              cache_dirty_blocks: '0',
            }
          : {}),
      }],
    }],
  })
}

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

/** The by-id listing; the failed world's cache disk is simply absent. */
function byIdListing(world: World): string {
  const lines = [
    `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${X} -> ../../sdq`,
    `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${X}-part1 -> ../../sdq1`,
    `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${Y} -> ../../sdr`,
    `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${Y}-part1 -> ../../sdr1`,
    `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${R} -> ../../sdt`,
  ]
  if (world !== 'failed') {
    lines.push(`lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${C} -> ../../sds`)
    if (world !== 'none')
      lines.push(`lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${C}-part1 -> ../../sds1`)
  }
  return `${lines.join('\n')}\n`
}

/** One disk's own `lsblk` tree: empty. */
function blankDisk(kernel: string): string {
  return JSON.stringify({ blockdevices: [{ name: kernel, type: 'disk', size: CACHE_DISK_SIZE, partlabel: null, children: [] }] })
}

/** The same disk once its `tank-cache1` slice is cut. */
function carvedDisk(kernel: string): string {
  return JSON.stringify({ blockdevices: [{ name: kernel, type: 'disk', size: CACHE_DISK_SIZE, partlabel: null, children: [{ name: `${kernel}1`, type: 'part', size: CACHE_SLICE_SIZE, partlabel: 'tank-cache1' }] }] })
}

function buildExecutor(world: World): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: ok(ahrLsblkJson(world)) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: ok(inventoryLsblkJson(world)) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_CACHE_LSBLK_ARGS], result: ok(ahrLsblkJson(world)) })
  // The cache disk's own tree: blank on the first read (the step's detect),
  // carrying the slice on every read after it (what sgdisk just wrote).
  executor.addFixture({ command: '/usr/bin/lsblk', args: diskLsblkArgs(`/dev/disk/by-id/${C}`), results: world === 'none' ? [ok(blankDisk('sds')), ok(carvedDisk('sds'))] : [ok(carvedDisk('sds'))] })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(byIdListing(world)) })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: world === 'none' ? '1' : '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] })) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: ['--reportformat', 'json', '--units', 'b', '--nosuffix'], result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok(pvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs('tank-tank--vol'), result: ok(DM_STATUS[world]) })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: ok(JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }] })) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: ok(BTRFS_USAGE) })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: ok('') })
  // Mutation plumbing — quiet success; the tests assert the ARGV, not effects.
  executor.addFixture({ command: '/usr/sbin/wipefs', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/sgdisk', result: ok('') })
  executor.addFixture({ command: '/usr/bin/udevadm', result: ok('') })
  executor.addFixture({ command: '/usr/bin/realpath', result: ok('/dev/sds1\n') })
  executor.addFixture({ command: '/usr/sbin/pvcreate', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/pvremove', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/vgextend', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/vgreduce', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/lvcreate', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/lvremove', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/lvconvert', result: ok('') })
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

describe('AHR read-cache routes (story ahrcache.1)', () => {
  let dir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(world: World = 'none') {
    executor = buildExecutor(world)
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrCacheRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      diskIdentityCache: new DiskIdentityCache(executor),
      intentDir: dir,
    })
  }

  /** Commands that would MUTATE the system — a refusal must issue NONE. */
  function destructiveCalls(): { command: string, args: string[] }[] {
    return executor.calls.filter(c => [
      '/usr/sbin/wipefs',
      '/usr/sbin/sgdisk',
      '/usr/sbin/pvcreate',
      '/usr/sbin/pvremove',
      '/usr/sbin/vgextend',
      '/usr/sbin/vgreduce',
      '/usr/sbin/lvcreate',
      '/usr/sbin/lvremove',
      '/usr/sbin/lvconvert',
    ].includes(c.command))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-cache-routes-'))
  })
  afterEach(async () => {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  describe('the pool read — dmsetup status is the health, lvs is not (GT-19/GT-23)', () => {
    it('no cache: the block reads absent with no devices and no counters', async () => {
      await build('none')
      const pool = (await readAhrPools(executor)).find(p => p.name === 'tank')!
      assert.equal(pool.state, 'healthy')
      assert.equal(pool.cache?.state, 'absent')
      assert.deepEqual(pool.cache?.devices, [])
      assert.equal(pool.cache?.hits, undefined)
    })

    it('healthy cache: devices, size from the PV, policy from lvs, counters present', async () => {
      await build('healthy')
      const pool = (await readAhrPools(executor)).find(p => p.name === 'tank')!
      assert.equal(pool.state, 'healthy')
      assert.equal(pool.cache?.state, 'healthy')
      assert.deepEqual(pool.cache?.devices, [C])
      assert.equal(pool.cache?.sizeBytes, CACHE_PV_SIZE)
      assert.equal(pool.cache?.mode, 'writethrough')
      assert.equal(pool.cache?.policy, 'smq')
      assert.equal(pool.cache?.hits, 795)
      assert.equal(pool.cache?.dirtyBlocks, 0)
      // Capacity comes from the LV, never the VG — the VG carries the cache
      // slice too (GT-23), so a consumer reading vg.sizeBytes as pool size
      // inherits the flash.
      assert.equal(pool.capacity.usableBytes, LV_SIZE)
      assert.equal(pool.lv.sizeBytes, LV_SIZE)
    })

    it('failed cache: the pool degrades, the counters are GATED OFF, and it advises', async () => {
      await build('failed')
      const pool = (await readAhrPools(executor)).find(p => p.name === 'tank')!
      assert.equal(pool.cache?.state, 'failed')
      // lvs was still answering with numbers; none of them reach the wire.
      assert.equal(pool.cache?.hits, undefined)
      assert.equal(pool.cache?.totalBlocks, undefined)
      // Not `failed` or `offline`: the data is all there and one command
      // restores service. But not healthy either — GT-23's whole point.
      assert.equal(pool.state, 'degraded')
      assert.ok(pool.advisories.some(a => a.includes('cache device failed')))
      // The band array itself is clean — the degradation is the cache alone.
      assert.equal(pool.arrays[0].state, 'clean')
    })
  })

  describe('the disks inventory — the cache disk is attributed to its pool (GT-22)', () => {
    it('no cache: the SSD is plain `available`', async () => {
      await build('none')
      const disks = await collectDisks(executor, new DiskIdentityCache(executor))
      const ssd = disks.find(d => d.id === C)!
      assert.equal(ssd.status, 'available')
      assert.equal(ssd.poolName, null)
      assert.equal(ssd.ahrArray, null)
    })

    it('cached: in use, role `cache`, named to its pool — not an unrelated `other`', async () => {
      await build('healthy')
      const disks = await collectDisks(executor, new DiskIdentityCache(executor))
      const ssd = disks.find(d => d.id === C)!
      assert.equal(ssd.status, 'ahr_member')
      assert.equal(ssd.poolName, 'tank')
      assert.equal(ssd.ahrArray, 'cache')
      // Band members keep their band label — the cache does not blur them.
      assert.equal(disks.find(d => d.id === X)!.ahrArray, 'r1')
    })
  })

  describe('POST /v1/ahr/:name/cache', () => {
    it('401 without identity headers', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', payload: { disks: [C] } })
      assert.equal(res.statusCode, 401)
    })

    it('404 for an unknown pool', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/nope/cache', headers: IDENTITY_HEADERS, payload: { disks: [C] } })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('400 for an empty disk list', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: [] } })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })

    it('409 when the pool already has a cache — and nothing is touched', async () => {
      await build('healthy')
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: [R] } })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /already has a read cache/)
      assert.deepEqual(destructiveCalls(), [])
    })

    it('400 when a picked disk is a band member of the pool', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: [X] } })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /already part of pool 'tank' \(role: member\)/)
      assert.deepEqual(destructiveCalls(), [])
    })

    it('400 when a picked disk is not in the inventory', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: ['ata-GHOST'] } })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /not found in the inventory/)
      assert.deepEqual(destructiveCalls(), [])
    })

    it('409 while an expansion intent exists — the VG shape is in flight', async () => {
      await build()
      await writeIntent('tank', mkIntent('running'), { dir })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: [C] } })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /expansion intent/)
      assert.deepEqual(destructiveCalls(), [])
    })

    it('202 + the job argv sequence — NO confirm code is ever minted', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: [C] } })
      assert.equal(res.statusCode, 202)
      // Nothing is destroyed that holds an only copy, so no confirm gate.
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      const { job } = res.json()
      assert.equal(job.operation, 'ahr.cache.attach')
      const done = await waitForJob(jobQueue, job.id)
      assert.equal(done.status, 'completed', done.error?.message)

      const MIXED = ['--config', 'devices/allow_mixed_block_sizes=1']
      const dev = `/dev/disk/by-id/${C}`
      assert.deepEqual(
        destructiveCalls().map(c => [c.command, ...c.args]),
        [
          ['/usr/sbin/sgdisk', '-n', '1:1M:0', '-t', '1:8E00', '-c', '1:tank-cache1', dev],
          ['/usr/sbin/wipefs', '-a', `${dev}-part1`],
          ['/usr/sbin/pvcreate', ...MIXED, `${dev}-part1`],
          ['/usr/sbin/vgextend', ...MIXED, 'tank', `${dev}-part1`],
          ['/usr/sbin/lvcreate', ...MIXED, '-y', '-n', 'tank-cache', '-l', '100%PVS', 'tank', `${dev}-part1`],
          ['/usr/sbin/lvconvert', ...MIXED, '-y', '--type', 'cache', '--cachevol', 'tank-cache', '--cachemode', 'writethrough', 'tank/tank-vol'],
        ],
      )
    })

    it('a SPINNING cache disk is accepted, with the advisory in the job result', async () => {
      await build()
      // The spinning disk has no per-disk lsblk fixture of its own; give it the
      // same blank-then-carved pair so the job can run.
      executor.addFixture({ command: '/usr/bin/lsblk', args: diskLsblkArgs(`/dev/disk/by-id/${R}`), results: [ok(blankDisk('sdt')), ok(carvedDisk('sdt'))] })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS, payload: { disks: [R] } })
      assert.equal(res.statusCode, 202, 'a rotating cache is the operator\'s call, not ours to refuse')
      const done = await waitForJob(jobQueue, res.json().job.id)
      assert.equal(done.status, 'completed', done.error?.message)
      const result = done.result as { warnings?: string[] }
      assert.deepEqual(result.warnings, [`${R} is a rotating disk: a rotating cache adds a seek, not speed`])
    })
  })

  describe('DELETE /v1/ahr/:name/cache', () => {
    it('401 without identity headers', async () => {
      await build('healthy')
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/cache' })
      assert.equal(res.statusCode, 401)
    })

    it('404 for an unknown pool', async () => {
      await build('healthy')
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/nope/cache', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
    })

    it('409 when there is no cache — and nothing is touched', async () => {
      await build('none')
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /has no read cache to detach/)
      assert.deepEqual(destructiveCalls(), [])
    })

    it('409 while an expansion intent exists', async () => {
      await build('healthy')
      await writeIntent('tank', mkIntent('halted'), { dir })
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.deepEqual(destructiveCalls(), [])
    })

    it('202 + the job argv sequence, ending at DELETING the slice (GT-22)', async () => {
      await build('healthy')
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 202)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      const { job } = res.json()
      assert.equal(job.operation, 'ahr.cache.detach')
      const done = await waitForJob(jobQueue, job.id)
      assert.equal(done.status, 'completed', done.error?.message)

      const MIXED = ['--config', 'devices/allow_mixed_block_sizes=1']
      const dev = `/dev/disk/by-id/${C}`
      assert.deepEqual(
        destructiveCalls().map(c => [c.command, ...c.args]),
        [
          ['/usr/sbin/lvconvert', ...MIXED, '-y', '--uncache', 'tank/tank-vol'],
          ['/usr/sbin/vgreduce', ...MIXED, 'tank', '/dev/sds1'],
          ['/usr/sbin/pvremove', ...MIXED, '-y', `${dev}-part1`],
          ['/usr/sbin/wipefs', '-a', `${dev}-part1`],
          ['/usr/sbin/sgdisk', '-d', '1', dev],
        ],
      )
    })

    it('a FAILED cache is detachable — that IS the recovery (GT-20)', async () => {
      await build('failed')
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/cache', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 202)
      const done = await waitForJob(jobQueue, res.json().job.id)
      assert.equal(done.status, 'completed', done.error?.message)
      const MIXED = ['--config', 'devices/allow_mixed_block_sizes=1']
      assert.deepEqual(
        destructiveCalls().map(c => [c.command, ...c.args]),
        [
          ['/usr/sbin/lvconvert', ...MIXED, '-y', '--uncache', 'tank/tank-vol'],
          // A PV whose device is gone has no name to give vgreduce.
          ['/usr/sbin/vgreduce', ...MIXED, '--removemissing', 'tank'],
        ],
      )
    })
  })
})
