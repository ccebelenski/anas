import type { AhrCapacity, AhrExpansionIntent, AhrExpansionPlanResponse, Job } from '@anas/shared'
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

// The ahrexpand.1 §5.2 pool "quad": 4×2 GiB, ONE band raid5×4, and an LV that
// is EXACTLY the band math (6 GiB) — so a plan that adds nothing reads as a
// zero delta, and the guard's numbers are the clean 2/4 GiB of the story.
const D1 = 'ata-QUAD_D1' // member, 2 GiB class → sda
const D2 = 'ata-QUAD_D2' // member, 2 GiB class → sdb
const D3 = 'ata-QUAD_D3' // member, 2 GiB class → sdc
const D4 = 'ata-QUAD_D4' // member, 2 GiB class → sdd
const E = 'ata-QUAD_E' // available, 4 GiB class → sde
const E2 = 'ata-QUAD_E2' // available, 4 GiB class → sdf
const F = 'ata-QUAD_F' // available, 2 GiB class → sdg (the same-size replace)
const G = 'ata-QUAD_G' // available, 1 GiB class → sdh (strands below band 1)

const SIZE_2G = 2 * GIB + 8 * MIB
const SIZE_3G = 3 * GIB + 8 * MIB
const SIZE_4G = 4 * GIB + 8 * MIB
const SIZE_1G = GIB + 8 * MIB
const GPT_TAIL = 33 * 512
const B1_INTERIOR = 2 * GIB - MIB
const B1_CLAMPED_2G = SIZE_2G - MIB - GPT_TAIL
const B2_CLAMPED_3G = SIZE_3G - GPT_TAIL - 2 * GIB
const LV_SIZE = 5360320512
const LV_QUAD_SIZE = 6 * GIB // exactly the band math of raid5×4 over [0,2GiB]
const QUAD_MD_BLOCKS = Math.floor(B1_CLAMPED_2G / 512)

const MDSTAT_BASE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

md125 : active raid5 sda1[3] sdb1[2] sdc1[1] sdd1[0]
      ${QUAD_MD_BLOCKS} blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]

unused devices: <none>
`

// md127 assembled but NOT STARTED (every member (S), the GT-8 shape) → the band
// reads `inactive` and the pool `offline`. Before that split the band reported
// `degraded`, which is the only reason the §4 gate caught it; the gate now names
// both states, and this pins that it still refuses.
const MDSTAT_INACTIVE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : inactive sds1[2](S) sdr1[1](S) sdq1[0](S)
      4190208 blocks super 1.2

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

interface PartNode { name: string, size: number, label: string, md: 'md127' | 'md126' | 'md125' }
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
  { kernel: 'sda', id: D1, size: SIZE_2G, parts: [{ name: 'sda1', size: B1_CLAMPED_2G, label: 'quad-d1-b1', md: 'md125' }] },
  { kernel: 'sdb', id: D2, size: SIZE_2G, parts: [{ name: 'sdb1', size: B1_CLAMPED_2G, label: 'quad-d2-b1', md: 'md125' }] },
  { kernel: 'sdc', id: D3, size: SIZE_2G, parts: [{ name: 'sdc1', size: B1_CLAMPED_2G, label: 'quad-d3-b1', md: 'md125' }] },
  { kernel: 'sdd', id: D4, size: SIZE_2G, parts: [{ name: 'sdd1', size: B1_CLAMPED_2G, label: 'quad-d4-b1', md: 'md125' }] },
  { kernel: 'sde', id: E, size: SIZE_4G, parts: [] },
  { kernel: 'sdf', id: E2, size: SIZE_4G, parts: [] },
  { kernel: 'sdg', id: F, size: SIZE_2G, parts: [] },
  { kernel: 'sdh', id: G, size: SIZE_1G, parts: [] },
]

const MD_SIZES = { md127: 4190208 * 1024, md126: 1047552 * 1024, md125: QUAD_MD_BLOCKS * 512 }
const LVM_NODE = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }
const LVM_QUAD_NODE = { name: 'quad-quad--vol', type: 'lvm', size: LV_QUAD_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/quad', partlabel: null }

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
      children: [{ name: p.md, type: p.md === 'md126' ? 'raid1' : 'raid5', size: MD_SIZES[p.md], fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [p.md === 'md125' ? LVM_QUAD_NODE : LVM_NODE] }],
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

const BTRFS_USAGE_QUAD = [
  'Overall:',
  `    Device size:\t\t${LV_QUAD_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_QUAD_SIZE - 2 * MIB}\t(min: ${LV_QUAD_SIZE - 4 * MIB})`,
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

/** The band-1 slice label the quad replacement disk arrives already carrying. */
const QUAD_NEW_SLICE_LABEL = 'quad-d5-b1'

/** `lsblk -Jb -o NAME,TYPE,SIZE,PARTLABEL <dev>` for ONE disk (readDiskTree). */
function diskTreeJson(kernel: string, size: number, parts: { name: string, size: number, label: string }[]): string {
  return JSON.stringify({ blockdevices: [{
    name: kernel,
    type: 'disk',
    size,
    partlabel: null,
    children: parts.map(p => ({ name: p.name, type: 'part', size: p.size, partlabel: p.label })),
  }] })
}

/**
 * A MockExecutor whose `/proc/mdstat` CHANGES once `mdadm --replace` has been
 * issued — the one state transition a guided replace waits on. Against a
 * static fixture the wait loop never returns (correctly: the outgoing member
 * is still a healthy member), so a test that wants to prove the confirm bypass
 * really drives the executor has to let md move.
 */
class ReplaceAwareExecutor extends MockExecutor {
  private swapped = false
  constructor(private readonly afterSwap: string) {
    super()
  }

  override async exec(command: string, args: string[], opts?: Parameters<MockExecutor['exec']>[2]) {
    if (this.swapped && command === '/usr/bin/cat' && args.join(' ') === MDSTAT_CAT_ARGS.join(' ')) {
      this.calls.push({ command, args })
      return { stdout: this.afterSwap, stderr: '', exitCode: 0 }
    }
    const result = await super.exec(command, args, opts)
    if (command === '/usr/sbin/mdadm' && args.includes('--replace'))
      this.swapped = true
    return result
  }
}

/** md125 after the copy landed: the incoming slice in, the outgoing one gone. */
function mdstatQuadSwapped(newPartKernel: string): string {
  return MDSTAT_BASE.replace('md125 : active raid5 sda1[3]', `md125 : active raid5 ${newPartKernel}[3]`)
}

function buildExecutor(opts: { mdstat?: string, driveReplaceOf?: string } = {}): MockExecutor {
  // The incoming disk is the one whose slice md125 ends up carrying.
  const incoming = DISKS.find(d => d.id === opts.driveReplaceOf)
  const executor = incoming
    ? new ReplaceAwareExecutor(mdstatQuadSwapped(`${incoming.kernel}1`))
    : new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: opts.mdstat ?? MDSTAT_BASE, stderr: '', exitCode: 0 } })
  if (incoming) {
    // Per-disk trees for the replace path. The incoming disk already carries
    // its band-1 slice, so the partition step is the detect-then-delta no-op
    // it is on a resume and the run reaches the mdadm work under test.
    for (const d of DISKS) {
      const parts = d.id === incoming.id
        ? [{ name: `${d.kernel}1`, size: B1_CLAMPED_2G, label: QUAD_NEW_SLICE_LABEL }]
        : d.parts.map(p => ({ name: p.name, size: p.size, label: p.label }))
      executor.addFixture({ command: '/usr/bin/lsblk', args: diskLsblkArgs(`/dev/disk/by-id/${d.id}`), result: { stdout: diskTreeJson(d.kernel, d.size, parts), stderr: '', exitCode: 0 } })
    }
    executor.addFixture({ command: '/usr/bin/lsblk', args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: ahrLsblkJson(), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/sgdisk', result: { stdout: '', stderr: '', exitCode: 0 } })
  }
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md125'], result: { stdout: exportFor('quad-r1', 'raid5', 4, 'cccccccc:cccccccc:cccccccc:cccccccc'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: { stdout: inventoryLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID_LISTING, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }, { vg_name: 'quad', pv_count: '1', lv_count: '1', vg_size: String(LV_QUAD_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }, { lv_name: 'quad-vol', vg_name: 'quad', lv_attr: '-wi-ao----', lv_size: String(LV_QUAD_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: { stdout: JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }, { target: '/mnt/anas-ahr/quad', source: '/dev/mapper/quad-quad--vol', fstype: 'btrfs', options: 'rw,relatime' }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: BTRFS_USAGE, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/quad'], result: { stdout: BTRFS_USAGE_QUAD, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

/** Commands that would MUTATE the system — a plan/preview must issue NONE. */
function mutatingCalls(executor: MockExecutor): { command: string, args: string[] }[] {
  return executor.calls.filter((c) => {
    if (c.command === '/usr/sbin/mdadm')
      return c.args[0] !== '--detail'
    if (c.command === '/usr/bin/btrfs')
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

  async function build(opts: { mdstat?: string, driveReplaceOf?: string } = {}) {
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
      const { data } = res.json() as { data: AhrExpansionPlanResponse }
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
      // ahrexpand.1: a positive-gain plan reports the gain and carries no
      // zeroGain detail.
      assert.ok(data.usableGain !== undefined && data.usableGain > 0, 'positive-gain plan reports usableGain')
      assert.equal(data.zeroGain, undefined)
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

    it('REFUSES a pool whose band cannot start, for the honest reason', async () => {
      await build({ mdstat: MDSTAT_INACTIVE })
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/expand', headers: IDENTITY_HEADERS, payload: { addDisks: [W] } })
      assert.equal(res.statusCode, 409)
      const { error } = res.json()
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /is inactive/)
      // An unreachable volume gets its own reason: there is no double-failure
      // window to warn about when nothing is being served at all.
      assert.match(error.message, /nothing to reshape/)
      assert.ok(!error.message.includes('double-failure'), error.message)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no confirm bypass')
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
      // S reaches no boundary at all, so the planner says so in plain words
      // rather than reporting it "stranded above the 0 GiB boundary".
      assert.ok(warnings.some(w => w.includes(`disk '${S}': none of its 1 GiB can be used`)), warnings.join(' | '))
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

  // ---- Zero-gain expand guard (ahrexpand.1, AHR-DESIGN §5.2) ----------------
  // The "quad" pool is 4×2 GiB, one band raid5×4 — the §5.2 shape at GiB
  // scale. The guard measures band math against band math, so the LV's exact
  // size no longer enters it; the numbers are the story's clean 2/4 GiB.
  //
  // The refusal is the PLANNER's own pending-capacity line, lifted verbatim —
  // and because a replace is unlocked by another replace (band 1 keeps its
  // four members), the second 4 GiB disk unlocks the [2,4 GiB] band alone.

  const QUAD_PENDING_LINE = '2 GiB of new capacity is pending — replace one more disk with ≥4 GiB to unlock ~2 GiB'
  const QUAD_ZERO_GAIN = `This plan adds no usable capacity: ${QUAD_PENDING_LINE}`

  describe('zero-gain expand guard (ahrexpand.1, §5.2)', () => {
    it('plan response: the exact §5.2 shape carries usableGain 0 + the shortfall and the unlock', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand/plan', payload: { replace: { oldDiskId: D1, newDiskId: E } } })
      assert.equal(res.statusCode, 200, res.body)
      const { data } = res.json() as { data: AhrExpansionPlanResponse }
      assert.equal(data.usableGain, 0)
      assert.deepEqual(data.zeroGain, {
        shortfall: QUAD_ZERO_GAIN,
        unlockSize: 4 * GIB,
        unlockGain: 2 * GIB,
      })
      // …and the refusal quotes the planner's own warning, not a second
      // sentence that could drift from it.
      assert.ok(data.warnings.includes(QUAD_PENDING_LINE), data.warnings.join(' | '))
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('plan response: two 4 GiB disks → positive gain, no zeroGain', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand/plan', payload: { replace: { oldDiskId: D1, newDiskId: E }, addDisks: [E2] } })
      assert.equal(res.statusCode, 200, res.body)
      const { data } = res.json() as { data: AhrExpansionPlanResponse }
      // Band 1 grows raid5×4 → raid5×5 (+2 GiB); the [2,4GiB] band forms
      // RAID1×2 (+2 GiB).
      assert.equal(data.usableGain, 4 * GIB)
      assert.equal(data.zeroGain, undefined)
    })

    it('expand: the zero-gain plan is refused with the guiding 409; the confirm code runs the job', async () => {
      await build({ driveReplaceOf: E })
      const first = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand', headers: IDENTITY_HEADERS, payload: { replace: { oldDiskId: D1, newDiskId: E } } })
      assert.equal(first.statusCode, 409, first.body)
      const { error } = first.json()
      assert.equal(error.code, 'CONFIRMATION_REQUIRED')
      // The MESSAGE is the guidance: the exact shortfall and what unlocks it.
      assert.equal(error.message, QUAD_ZERO_GAIN)
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)
      assert.deepEqual(mutatingCalls(executor), [], 'refused before any destructive action')

      // The honest zero-gain case is still reachable — and the bypass does not
      // just mint a 202: the job RUNS the replace.
      const second = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code }, payload: { replace: { oldDiskId: D1, newDiskId: E } } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.ok(
        mutatingCalls(executor).some(c => c.command === '/usr/sbin/mdadm' && c.args.includes('--replace') && c.args.includes('/dev/sda1')),
        JSON.stringify(mutatingCalls(executor)),
      )
      assert.equal(await readIntent('quad', dir), null, 'intent cleared on completion')
    })

    it('guided replace: the repair headline stays; the zero-gain fact is a warning, and the code runs the job', async () => {
      await build({ driveReplaceOf: F })
      const first = await server.inject({ method: 'POST', url: `/v1/ahr/quad/disk/${D1}/replace`, headers: IDENTITY_HEADERS, payload: { newDiskId: F } })
      assert.equal(first.statusCode, 409, first.body)
      const { error } = first.json()
      assert.equal(error.code, 'CONFIRMATION_REQUIRED')
      // Replace is a REPAIR verb: swapping a failing disk for one of the same
      // size is the point, so the headline is the repair and the zero-gain
      // fact is stated ONCE, below it.
      assert.equal(error.message, `Replacing disk '${D1}' in pool 'quad'`)
      const warnings: string[] = error.warnings
      assert.equal(
        warnings[0],
        'This plan adds no usable capacity: the replacement only inherits the bands its predecessor already served',
      )
      assert.equal(warnings.filter(w => w.includes('adds no usable capacity')).length, 1, 'said once')
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)
      assert.deepEqual(mutatingCalls(executor), [])

      const second = await server.inject({ method: 'POST', url: `/v1/ahr/quad/disk/${D1}/replace`, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code }, payload: { newDiskId: F } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.ok(
        mutatingCalls(executor).some(c => c.command === '/usr/sbin/mdadm' && c.args.includes('--replace') && c.args.includes('/dev/sda1')),
        JSON.stringify(mutatingCalls(executor)),
      )
      assert.equal(await readIntent('quad', dir), null, 'intent cleared on completion')
    })

    it('a positive-gain expand is NOT zero-gain gated (normal confirm surface, unchanged message)', async () => {
      await build()
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand', headers: IDENTITY_HEADERS, payload: { replace: { oldDiskId: D1, newDiskId: E }, addDisks: [E2] } })
      assert.equal(res.statusCode, 409, res.body)
      const { error } = res.json()
      assert.equal(error.code, 'CONFIRMATION_REQUIRED')
      assert.equal(error.message, `Expanding AHR pool 'quad' starts an online reshape`)
      assert.ok(!error.message.includes('no usable capacity'))
      assert.ok(res.headers['x-anas-confirm-code'])
    })

    it('no reachable target: a zero-step plan flows unchanged (409 confirm → 202 → no-op, intent cleared)', async () => {
      await build()
      const first = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand', headers: IDENTITY_HEADERS, payload: { addDisks: [G] } })
      assert.equal(first.statusCode, 409, first.body)
      const { error } = first.json()
      assert.equal(error.code, 'CONFIRMATION_REQUIRED')
      // The guidance carries the planner's own line about the added disk,
      // verbatim — and an ADD-shaped plan is unlocked by another ADD.
      assert.equal(
        error.message,
        `This plan adds no usable capacity: disk '${G}': none of its 1 GiB can be used — it does not reach `
        + `the pool's lowest band boundary at 2 GiB, and existing band boundaries are immutable; `
        + `add one more disk of ≥2 GiB to unlock ~2 GiB`,
      )
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)

      const second = await server.inject({ method: 'POST', url: '/v1/ahr/quad/expand', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code }, payload: { addDisks: [G] } })
      assert.equal(second.statusCode, 202, second.body)
      const job = await waitForJob(jobQueue, second.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal(await readIntent('quad', dir), null, 'intent cleared on completion')
      assert.deepEqual(mutatingCalls(executor), [], 'a zero-step plan mutates nothing')
    })
  })
})
