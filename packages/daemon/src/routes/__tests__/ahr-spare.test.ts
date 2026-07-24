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
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { diskLsblkArgs } from '../../services/ahr-expand-exec.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrSpareRoutes } from '../ahr-spare.js'
import { jobRoutes } from '../jobs.js'

/**
 * AHR hot-spare routes (story 11.11, AHR-DESIGN §11/§4) — the same GiB-aligned
 * synthetic pool "tank" as the expansion route tests:
 *   band 1 [0,2GiB] raid5×3 (md127: X,Y,Z), band 2 [2,3GiB] raid1×2 (md126: Y,Z).
 * Members X,Y,Z; W (4GiB) covers the 3GiB top boundary; S (1GiB) does not.
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X' // member, 2 GiB → sdq
const Y = 'ata-TANK_Y' // member, 3 GiB → sdr
const Z = 'ata-TANK_Z' // member, 3 GiB → sds
const W = 'ata-TANK_W' // available, 4 GiB → sdt (covers the top boundary)
const S = 'ata-TANK_S' // available, 1 GiB → sdu (too small — refused)

const SIZE_2G = 2 * GIB + 8 * MIB
const SIZE_3G = 3 * GIB + 8 * MIB
const SIZE_4G = 4 * GIB + 8 * MIB
const SIZE_1G = GIB + 8 * MIB
const GPT_TAIL = 33 * 512
const B1_INTERIOR = 2 * GIB - MIB
const B1_CLAMPED_2G = SIZE_2G - MIB - GPT_TAIL
const B2_CLAMPED_3G = SIZE_3G - GPT_TAIL - 2 * GIB
const B2_INTERIOR = GIB
const LV_SIZE = 5360320512

// Base topology: no spare attached.
const MDSTAT_BASE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

// W attached as a hot spare to both band arrays ((S) members).
const MDSTAT_WITH_SPARE = `Personalities : [raid1] [raid5]
md126 : active raid1 sdt2[2](S) sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdt1[3](S) sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

function exportFor(name: string, level: string, devices: number, uuid: string): string {
  return `MD_LEVEL=${level}\nMD_DEVICES=${devices}\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_DEVNAME=${name}\nMD_NAME=anas-test:${name}\n`
}

interface PartNode { name: string, size: number, label: string, md: 'md127' | 'md126' }
interface DiskNode { kernel: string, id: string, size: number, parts: PartNode[] }

/** DISKS with W optionally carved as an attached spare (d4). */
function disks(spareAttached: boolean): DiskNode[] {
  return [
    { kernel: 'sdq', id: X, size: SIZE_2G, parts: [{ name: 'sdq1', size: B1_CLAMPED_2G, label: 'tank-d1-b1', md: 'md127' }] },
    { kernel: 'sdr', id: Y, size: SIZE_3G, parts: [
      { name: 'sdr1', size: B1_INTERIOR, label: 'tank-d2-b1', md: 'md127' },
      { name: 'sdr2', size: B2_CLAMPED_3G, label: 'tank-d2-b2', md: 'md126' },
    ] },
    { kernel: 'sds', id: Z, size: SIZE_3G, parts: [
      { name: 'sds1', size: B1_INTERIOR, label: 'tank-d3-b1', md: 'md127' },
      { name: 'sds2', size: B2_CLAMPED_3G, label: 'tank-d3-b2', md: 'md126' },
    ] },
    { kernel: 'sdt', id: W, size: SIZE_4G, parts: spareAttached
      ? [
          { name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1', md: 'md127' },
          { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2', md: 'md126' },
        ]
      : [] },
    { kernel: 'sdu', id: S, size: SIZE_1G, parts: [] },
  ]
}

const MD_SIZES = { md127: 4190208 * 1024, md126: 1047552 * 1024 }
const LVM_NODE = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }

function ahrLsblkJson(ds: DiskNode[]): string {
  return JSON.stringify({ blockdevices: ds.map(d => ({
    name: d.kernel,
    type: 'disk',
    size: d.size,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH DISK',
    serial: d.id.replace('ata-', ''),
    children: d.parts.map(p => ({
      name: p.name,
      type: 'part',
      size: p.size,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: p.label,
      children: [{ name: p.md, type: p.md === 'md127' ? 'raid5' : 'raid1', size: MD_SIZES[p.md], fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [LVM_NODE] }],
    })),
  })) })
}

function inventoryLsblkJson(ds: DiskNode[]): string {
  return JSON.stringify({ blockdevices: ds.map(d => ({
    'name': d.kernel,
    'type': 'disk',
    'size': d.size,
    'model': 'SYNTH DISK',
    'serial': d.id.replace('ata-', ''),
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 4096,
    'log-sec': 512,
    'children': d.parts.map(p => ({ name: p.name, type: 'part', size: p.size, fstype: 'linux_raid_member', mountpoint: null })),
  })) })
}

const POOL_SCAN_LSBLK_ARGS = ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL']

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

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
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: [X, Y, Z, W], before: CAP, after: CAP, state }
}

/**
 * The full read-layer world; `spareAttached` swaps in the (S) topology + a
 *  sequenced lsblk for the incoming disk W so the attach/remove jobs complete.
 */
function buildExecutor(opts: { mdstat?: string, spareAttached?: boolean } = {}): MockExecutor {
  const ds = disks(!!opts.spareAttached)
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: opts.mdstat ?? (opts.spareAttached ? MDSTAT_WITH_SPARE : MDSTAT_BASE), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(ds), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: { stdout: inventoryLsblkJson(ds), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: POOL_SCAN_LSBLK_ARGS, result: { stdout: ahrLsblkJson(ds), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: `${ds.map(d => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${d.id} -> ../../${d.kernel}`).join('\n')}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: { stdout: JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: BTRFS_USAGE, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })

  // Incoming spare disk W — blank first (attach: partition planning), carved
  // afterwards (ghost-clear + --add-spare). For the remove world W is already
  // carved (its lsblk always returns the two slices).
  const carved = { stdout: JSON.stringify({ blockdevices: [{ name: 'sdt', type: 'disk', size: SIZE_4G, partlabel: null, children: [
    { name: 'sdt1', type: 'part', size: B1_INTERIOR, partlabel: 'tank-d4-b1' },
    { name: 'sdt2', type: 'part', size: B2_INTERIOR, partlabel: 'tank-d4-b2' },
  ] }] }), stderr: '', exitCode: 0 }
  const blank = { stdout: JSON.stringify({ blockdevices: [{ name: 'sdt', type: 'disk', size: SIZE_4G, partlabel: null, children: [] }] }), stderr: '', exitCode: 0 }
  executor.addFixture({ command: '/usr/bin/lsblk', args: diskLsblkArgs(`/dev/disk/by-id/${W}`), results: opts.spareAttached ? [carved] : [blank, carved, carved, carved] })

  // Mutation plumbing — succeeds quietly (attach: wipe/partition/add-spare;
  // remove: remove/zero/zap). ghost-clearing realpath resolves, no md holders.
  executor.addFixture({ command: '/usr/sbin/wipefs', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/udevadm', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', result: { stdout: '/dev/sdt1\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', result: { stdout: '', stderr: '', exitCode: 0 } }) // holders: none
  executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } }) // --add-spare / --remove / --zero-superblock
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

describe('AHR hot-spare routes (story 11.11)', () => {
  let dir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(opts: { mdstat?: string, spareAttached?: boolean } = {}) {
    executor = buildExecutor(opts)
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrSpareRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      intentDir: dir,
    })
  }

  /** Commands that would MUTATE the system — a 409/400 must issue NONE. */
  function destructiveCalls(): { command: string, args: string[] }[] {
    return executor.calls.filter(c =>
      ['/usr/sbin/wipefs', '/usr/sbin/sgdisk'].includes(c.command)
      || (c.command === '/usr/sbin/mdadm' && c.args[0] !== '--detail'),
    )
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-spare-routes-'))
  })
  afterEach(async () => {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  describe('POST /v1/ahr/:name/spare', () => {
    it('401 without identity headers', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/spare', payload: { diskId: W } })
      assert.equal(res.statusCode, 401)
    })

    it('404 for an unknown pool', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/nope/spare', headers: IDENTITY_HEADERS, payload: { diskId: W } })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('400 when the disk is already part of the pool', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/spare', headers: IDENTITY_HEADERS, payload: { diskId: X } })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /already part of pool/)
    })

    it('400 refusing a partial spare with the EXACT shortfall — before any destructive action', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/spare', headers: IDENTITY_HEADERS, payload: { diskId: S } })
      assert.equal(res.statusCode, 400)
      const { error } = res.json()
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /2 GiB short/)
      assert.match(error.message, /top array boundary/)
      assert.match(error.message, /partial spare/i)
      assert.deepEqual(destructiveCalls(), [], 'refused before touching anything')
    })

    it('409 confirm listing the wiped disk, then 202 and a completing attach job', async () => {
      await build()
      const first = await server.inject({ method: 'POST', url: '/v1/ahr/tank/spare', headers: IDENTITY_HEADERS, payload: { diskId: W } })
      assert.equal(first.statusCode, 409, first.body)
      const body = first.json()
      assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
      // Concrete consequence: THIS disk (id + model + size) is wiped.
      assert.ok(body.error.warnings.some((w: string) => w.includes(W) && w.includes('erased')))
      assert.ok(body.error.warnings.some((w: string) => w.includes('md starts the rebuild')))
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)
      assert.deepEqual(destructiveCalls(), [], 'a 409 must not have executed anything destructive')

      const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/spare', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code }, payload: { diskId: W } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(job.result, { attached: W, bands: [1, 2] })
      // One --add-spare per band array, ascending.
      const addSpare = executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args.includes('--add-spare'))
      assert.deepEqual(addSpare.map(c => c.args), [
        ['/dev/md127', '--add-spare', `/dev/disk/by-id/${W}-part1`],
        ['/dev/md126', '--add-spare', `/dev/disk/by-id/${W}-part2`],
      ])
    })

    it('409 (plain, no confirm bypass) while an expansion intent exists', async () => {
      await build()
      await writeIntent('tank', mkIntent('halted'), { dir })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/spare', headers: IDENTITY_HEADERS, payload: { diskId: W } })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.match(res.json().error.message, /expansion intent/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
    })
  })

  describe('DELETE /v1/ahr/:name/spare/:id', () => {
    it('404 when the disk is not part of the pool', async () => {
      await build({ spareAttached: true })
      const res = await server.inject({ method: 'DELETE', url: `/v1/ahr/tank/spare/${S}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
    })

    it('400 when the disk is a MEMBER, not a spare', async () => {
      await build({ spareAttached: true })
      const res = await server.inject({ method: 'DELETE', url: `/v1/ahr/tank/spare/${X}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /is a MEMBER/)
    })

    it('409 confirm (headroom drops), then 202 and a completing remove job', async () => {
      await build({ spareAttached: true })
      const first = await server.inject({ method: 'DELETE', url: `/v1/ahr/tank/spare/${W}`, headers: IDENTITY_HEADERS })
      assert.equal(first.statusCode, 409, first.body)
      const body = first.json()
      assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(body.error.warnings.some((w: string) => w.includes('NO hot spare')))
      assert.ok(body.error.warnings.some((w: string) => w.includes('removed from every band array')))
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)

      const second = await server.inject({ method: 'DELETE', url: `/v1/ahr/tank/spare/${W}`, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(job.result, { removed: W })
      // Each slice removed, then superblocks zeroed, then the GPT zapped.
      const md = executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] !== '--detail').map(c => c.args)
      assert.deepEqual(md, [
        ['/dev/md127', '--remove', `/dev/disk/by-id/${W}-part1`],
        ['/dev/md126', '--remove', `/dev/disk/by-id/${W}-part2`],
        ['--zero-superblock', `/dev/disk/by-id/${W}-part1`],
        ['--zero-superblock', `/dev/disk/by-id/${W}-part2`],
      ])
      assert.ok(executor.calls.some(c => c.command === '/usr/sbin/sgdisk' && c.args[0] === '--zap-all'))
    })

    it('400 on an invalid disk id', async () => {
      await build({ spareAttached: true })
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/spare/bad%20id', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })

    it('409 (plain) while an expansion intent exists', async () => {
      await build({ spareAttached: true })
      await writeIntent('tank', mkIntent('halted'), { dir })
      const res = await server.inject({ method: 'DELETE', url: `/v1/ahr/tank/spare/${W}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /expansion intent/)
    })
  })
})
