import type { AhrCapacity, AhrExpansionIntent, AhrExpansionStep, Job } from '@anas/shared'
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
import { readIntent, writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrExpansionRoutes } from '../ahr-expand.js'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

// The GiB-aligned synthetic pool "tank" (see ahr-expand-exec.test.ts):
//  band 1 [0,2GiB] raid5×3 (md127: X,Y,Z), band 2 [2,3GiB] raid1×2 (md126: Y,Z).
const X = 'ata-TANK_X' // member, 2 GiB class → sdq
const Y = 'ata-TANK_Y' // member, 3 GiB class → sdr
const Z = 'ata-TANK_Z' // member, 3 GiB class → sds
const W = 'ata-TANK_W' // available, 4 GiB class → sdt
const S = 'ata-TANK_S' // available, 1 GiB class → sdu (too small for any band)

const SIZE_2G = 2 * GIB + 8 * MIB
const SIZE_3G = 3 * GIB + 8 * MIB
const SIZE_4G = 4 * GIB + 8 * MIB
const SIZE_1G = GIB + 8 * MIB
const GPT_TAIL = 33 * 512
const B1_INTERIOR = 2 * GIB - MIB
const B1_CLAMPED_2G = SIZE_2G - MIB - GPT_TAIL
const B2_CLAMPED_3G = SIZE_3G - GPT_TAIL - 2 * GIB
const LV_SIZE = 5360320512

const MDSTAT_BASE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

// A member lost from md127 → the pool reads degraded (the §4 refusal case).
const MDSTAT_DEGRADED = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]

unused devices: <none>
`

function exportFor(name: string, level: string, devices: number, uuid: string): string {
  return `MD_LEVEL=${level}\nMD_DEVICES=${devices}\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_DEVNAME=${name}\nMD_NAME=anas-test:${name}\n`
}

interface PartNode { name: string, size: number, label: string, md: 'md127' | 'md126' }
interface DiskNode { kernel: string, id: string, size: number, parts: PartNode[] }

const DISKS: DiskNode[] = [
  { kernel: 'sdq', id: X, size: SIZE_2G, parts: [{ name: 'sdq1', size: B1_CLAMPED_2G, label: 'tank-d1-b1', md: 'md127' }] },
  { kernel: 'sdr', id: Y, size: SIZE_3G, parts: [
    { name: 'sdr1', size: B1_INTERIOR, label: 'tank-d2-b1', md: 'md127' },
    { name: 'sdr2', size: B2_CLAMPED_3G, label: 'tank-d2-b2', md: 'md126' },
  ] },
  { kernel: 'sds', id: Z, size: SIZE_3G, parts: [
    { name: 'sds1', size: B1_INTERIOR, label: 'tank-d3-b1', md: 'md127' },
    { name: 'sds2', size: B2_CLAMPED_3G, label: 'tank-d3-b2', md: 'md126' },
  ] },
  { kernel: 'sdt', id: W, size: SIZE_4G, parts: [] },
  { kernel: 'sdu', id: S, size: SIZE_1G, parts: [] },
]

const MD_SIZES = { md127: 4190208 * 1024, md126: 1047552 * 1024 }
const LVM_NODE = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }

function ahrLsblkJson(): string {
  return JSON.stringify({ blockdevices: DISKS.map(d => ({
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

function inventoryLsblkJson(): string {
  return JSON.stringify({ blockdevices: DISKS.map(d => ({
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

const BY_ID_LISTING = `${DISKS.map(d => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${d.id} -> ../../${d.kernel}`).join('\n')}\n`

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

const CAP: AhrCapacity = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function mkIntent(state: AhrExpansionIntent['state']): AhrExpansionIntent {
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: [X, Y, Z, S], before: CAP, after: CAP, state }
}

function buildExecutor(opts: { mdstat?: string } = {}): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: opts.mdstat ?? MDSTAT_BASE, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: { stdout: inventoryLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID_LISTING, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: { stdout: JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: BTRFS_USAGE, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

/** Commands that would MUTATE the system — a plan/preview must issue NONE. */
function mutatingCalls(executor: MockExecutor): { command: string, args: string[] }[] {
  return executor.calls.filter((c) => {
    if (c.command === '/usr/sbin/mdadm')
      return c.args[0] !== '--detail'
    if (c.command === '/usr/sbin/btrfs')
      return c.args.includes('resize')
    return ['/usr/sbin/sgdisk', '/usr/sbin/pvcreate', '/usr/sbin/pvresize', '/usr/sbin/vgextend', '/usr/sbin/lvextend', '/usr/sbin/update-initramfs', '/usr/sbin/wipefs'].includes(c.command)
  })
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

describe('AHR expansion routes (Epic 11.6)', () => {
  let dir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(opts: { mdstat?: string } = {}) {
    executor = buildExecutor(opts)
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(ahrExpansionRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      intentDir: dir,
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-routes-'))
  })
  afterEach(async () => {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  describe('POST /v1/ahr/:name/expand/plan', () => {
    it('computes before → after + steps with ZERO mutating commands', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/plan', payload: { addDisks: [W] } })
      assert.equal(res.statusCode, 200, res.body)
      const { data } = res.json() as { data: { before: AhrCapacity, after: AhrCapacity, steps: AhrExpansionStep[], warnings: string[] } }
      // Adding the 4 GiB disk: partition W, grow r1 (3→4), convert r2
      // (raid1×2 → raid5×3), waits, pv-resizes, then the one lv/fs tail.
      assert.deepEqual(data.steps.map(s => s.kind), [
        'partition',
        'array-grow',
        'reshape-wait',
        'array-convert',
        'reshape-wait',
        'pv-resize',
        'pv-resize',
        'lv-extend',
        'fs-grow',
      ])
      assert.ok(data.after.usableBytes > data.before.usableBytes)
      // The [3,4GiB] region has one disk → pending, stated concretely.
      assert.ok(data.after.pendingBytes > 0)
      assert.ok(data.warnings.some(w => w.includes('pending')))
      // The no-mutation guarantee.
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('404s for an unknown pool and 400s an empty request', async () => {
      await build()
      let res = await server.inject({ method: 'POST', url: '/v1/ahr/nope/expand/plan', payload: { addDisks: [W] } })
      assert.equal(res.statusCode, 404)
      res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/plan', payload: {} })
      assert.equal(res.statusCode, 400)
    })

    it('rejects a non-available disk by name', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/plan', payload: { addDisks: ['ata-NOPE'] } })
      assert.equal(res.statusCode, 400)
      assert.ok(res.json().error.message.includes('ata-NOPE'))
    })
  })

  describe('POST /v1/ahr/:name/expand', () => {
    it('REFUSES a degraded pool with a plain 409 (no confirm bypass)', async () => {
      await build({ mdstat: MDSTAT_DEGRADED })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand', headers: IDENTITY_HEADERS, payload: { addDisks: [W] } })
      assert.equal(res.statusCode, 409)
      const { error } = res.json()
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /degraded/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'degraded refusal must not mint a confirm code')
    })

    it('REFUSES a second expansion while an intent exists (409)', async () => {
      await build()
      await writeIntent('tank', mkIntent('halted'), { dir })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand', headers: IDENTITY_HEADERS, payload: { addDisks: [W] } })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /already has an expansion intent/)
    })

    it('confirm-gates with reshape realism, then drives the job and clears the intent', async () => {
      await build()
      // S (1 GiB) joins no band: a legal zero-step expansion (stranded capacity).
      const first = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand', headers: IDENTITY_HEADERS, payload: { addDisks: [S] } })
      assert.equal(first.statusCode, 409, first.body)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      const warnings: string[] = first.json().error.warnings
      assert.ok(warnings.some(w => w.includes('hours to DAYS')))
      assert.ok(warnings.some(w => w.includes('Do NOT remove disks')))
      assert.ok(warnings.some(w => w.includes('stranded')))
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)

      const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code }, payload: { addDisks: [S] } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal(await readIntent('tank', dir), null, 'intent cleared on completion')
      assert.deepEqual(mutatingCalls(executor), [], 'a zero-step plan mutates nothing')
    })
  })

  describe('POST /v1/ahr/:name/expand/resume', () => {
    it('409s when there is no halted intent (absent AND running)', async () => {
      await build()
      let res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/resume', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /no halted expansion/)
      await writeIntent('tank', mkIntent('running'), { dir })
      res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/resume', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /state 'running'/)
    })

    it('recomputes from current topology + approved set and re-drives (202)', async () => {
      await build()
      await writeIntent('tank', mkIntent('halted'), { dir })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/resume', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(jobQueue, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal(await readIntent('tank', dir), null)
    })
  })

  describe('POST /v1/ahr/:name/expand/abandon', () => {
    it('confirm-gates naming the kept layout, then clears the intent (202)', async () => {
      await build()
      await writeIntent('tank', mkIntent('halted'), { dir })
      const first = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/abandon', headers: IDENTITY_HEADERS })
      assert.equal(first.statusCode, 409, first.body)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      const warnings: string[] = first.json().error.warnings
      assert.ok(warnings.some(w => w.includes('tank-r1 raid5×3')), 'names the current layout concretely')
      assert.ok(warnings.some(w => w.includes('nothing is rolled back')))
      const code = first.headers['x-anas-confirm-code'] as string

      const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/abandon', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed')
      assert.equal(await readIntent('tank', dir), null)
    })

    it('409s with no intent, and while the expansion is running', async () => {
      await build()
      let res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/abandon', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      await writeIntent('tank', mkIntent('running'), { dir })
      res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand/abandon', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.match(res.json().error.message, /currently being driven/)
    })
  })

  describe('POST /v1/ahr/:name/disk/:oldId/replace', () => {
    it('rejects a too-small replacement with the planner message VERBATIM (400)', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: `/v1/ahr/tank/disk/${X}/replace`, headers: IDENTITY_HEADERS, payload: { newDiskId: S } })
      assert.equal(res.statusCode, 400, res.body)
      const { error } = res.json()
      assert.equal(error.code, 'VALIDATION_ERROR')
      // The §2.5 replacement-slack refusal, word for word from the planner.
      assert.match(error.message, /too small for band 1/)
      assert.match(error.message, /§2\.5 replacement-slack check/)
      assert.deepEqual(mutatingCalls(executor), [], 'refused before any destructive action')
    })

    it('rejects a non-member old disk (400)', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: `/v1/ahr/tank/disk/${W}/replace`, headers: IDENTITY_HEADERS, payload: { newDiskId: S } })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /not a member/)
    })

    it('confirm-gates the replace with copy realism + retire notice', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: `/v1/ahr/tank/disk/${X}/replace`, headers: IDENTITY_HEADERS, payload: { newDiskId: W } })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      const warnings: string[] = res.json().error.warnings
      assert.ok(warnings.some(w => w.includes('mdadm --replace')))
      assert.ok(warnings.some(w => w.includes('retired')))
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.deepEqual(mutatingCalls(executor), [])
    })
  })
})
