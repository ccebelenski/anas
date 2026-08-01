import type { AhrCapacity, AhrExpansionIntent, JobRef } from '@anas/shared'
import type { JobHandler, JobQueue, JobSubmitter } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ahrBootScan } from '../ahr-boot-scan.js'
import { readIntent, writeIntent } from '../ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../ahr-topology.js'
import { DiskIdentityCache } from '../disk-identity-cache.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')

/** The GT-8 shape: md127 inactive, every member `(S)`. */
const MDSTAT_INACTIVE_SPARES = readFileSync(join(fixturesDir, 'mdstat-inactive-spares.txt'), 'utf-8')

const MDSTAT_HEALTHY_RESHAPE = `Personalities : [raid1] [raid5]
md127 : active raid5 sde1[4] sdd1[3] sdc1[1] sdb1[0]
      3134976 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]
      [====>................]  reshape = 23.5% (245000/1044992) finish=8.0min speed=2048K/sec

unused devices: <none>
`

const EXPORT_R1 = [
  'MD_LEVEL=raid5',
  'MD_DEVICES=4',
  'MD_METADATA=1.2',
  'MD_UUID=aaaaaaaa:bbbbbbbb:cccccccc:dddddddd',
  'MD_DEVNAME=ahr0-r1',
  'MD_NAME=anas-pve:ahr0-r1', // homehost-prefixed (GT-3)
  '',
].join('\n')

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
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: ['ata-A'], before: CAP, after: CAP, state }
}

function mdstatFixture(executor: MockExecutor, text: string): void {
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: text, stderr: '', exitCode: 0 } })
}

const MDADM = '/usr/sbin/mdadm'

describe('ahr-boot-scan (GT-8 recovery + orphaned intents + reshape observation)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-boot-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('(a) drives the verified ladder for an inactive all-spares array and notifies', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_INACTIVE_SPARES)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgchange', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.recovered, ['ahr0-r1'])

    // The ladder, in order, gentlest first — and nothing else md-mutating.
    const ladder = executor.calls
      .filter(c => (c.command === MDADM && c.args[0] !== '--detail') || c.command === '/usr/sbin/vgchange')
      .map(c => [c.command, ...c.args])
    assert.deepEqual(ladder, [
      [MDADM, '--run', '/dev/md127'],
      [MDADM, '--readwrite', '/dev/md127'],
      ['/usr/sbin/vgchange', '-ay', 'ahr0'],
    ])
    // One PVE warning naming what happened.
    const warnings = executor.calls.filter(c => c.command === '/usr/bin/perl' && c.args[2] === 'warning')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].args[4], /mdadm --run/)
    assert.match(warnings[0].args[4], /vgchange -ay ahr0/)
  })

  it('(b) flips a running intent to halted and notifies that Resume is needed', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, 'unused devices: <none>\n')
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    await writeIntent('tank', mkIntent('running'), { dir })
    await writeIntent('vault', mkIntent('halted'), { dir }) // already halted — untouched

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.haltedIntents, ['tank'])
    assert.equal((await readIntent('tank', dir))?.state, 'halted')
    assert.equal((await readIntent('vault', dir))?.state, 'halted')
    const warnings = executor.calls.filter(c => c.command === '/usr/bin/perl' && c.args[2] === 'warning')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].args[4], /Resume/)
  })

  it('(c) observes a healthy reshape WITHOUT issuing any command (kernel owns it)', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_HEALTHY_RESHAPE)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_R1, stderr: '', exitCode: 0 } })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.observedReshapes, ['ahr0-r1'])
    assert.deepEqual(report.recovered, [])
    // Observation only: reads, never a mutation, never a re-issued reshape.
    const mutating = executor.calls.filter(c =>
      (c.command === MDADM && c.args[0] !== '--detail') || c.command === '/usr/sbin/vgchange')
    assert.deepEqual(mutating, [])
  })

  it('ignores foreign (non-AHR-named) arrays entirely', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_INACTIVE_SPARES)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: 'MD_NAME=somebox:data\nMD_LEVEL=raid5\n', stderr: '', exitCode: 0 } })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.recovered, [])
    const mutating = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail')
    assert.deepEqual(mutating, [])
  })

  it('(b) without a jobQueue/diskCache injected, still halts a running intent (no re-attach path)', async () => {
    // Legacy call shape (no resume deps): degrade gracefully to halt-and-warn.
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_HEALTHY_RESHAPE)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    await writeIntent('ahr0', mkIntent('running'), { dir })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.reattached, [])
    assert.deepEqual(report.haltedIntents, ['ahr0'])
    assert.equal((await readIntent('ahr0', dir))?.state, 'halted')
  })
})

// ---------------------------------------------------------------------------
// Re-attach (issue #1): a HEALTHY reshape interrupted only by a daemon restart
// is re-attached and driven forward via the SHARED §5.3 resume core (the kernel
// reshape never stopped); degraded/GT-8/missing-disk cases stay halted (operator
// verb). Uses the GiB-aligned synthetic
// pool "tank" (same shape as routes/__tests__/ahr-expand.test.ts) so the shared
// resumeExpansion() can read live topology, plus a STUB jobQueue that records
// the submitted resume job without running its handler.
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const TX = 'ata-TANK_X' // member, 2 GiB class → sdq
const TY = 'ata-TANK_Y' // member, 3 GiB class → sdr
const TZ = 'ata-TANK_Z' // member, 3 GiB class → sds

const T_SIZE_2G = 2 * GIB + 8 * MIB
const T_SIZE_3G = 3 * GIB + 8 * MIB
const GPT_TAIL = 33 * 512
const B1_INTERIOR = 2 * GIB - MIB
const B1_CLAMPED_2G = T_SIZE_2G - MIB - GPT_TAIL
const B2_CLAMPED_3G = T_SIZE_3G - GPT_TAIL - 2 * GIB
const LV_SIZE = 5360320512

interface TPart { name: string, size: number, label: string, md: 'md127' | 'md126' }
interface TDisk { kernel: string, id: string, size: number, parts: TPart[] }
const TANK_DISKS: TDisk[] = [
  { kernel: 'sdq', id: TX, size: T_SIZE_2G, parts: [{ name: 'sdq1', size: B1_CLAMPED_2G, label: 'tank-d1-b1', md: 'md127' }] },
  { kernel: 'sdr', id: TY, size: T_SIZE_3G, parts: [
    { name: 'sdr1', size: B1_INTERIOR, label: 'tank-d2-b1', md: 'md127' },
    { name: 'sdr2', size: B2_CLAMPED_3G, label: 'tank-d2-b2', md: 'md126' },
  ] },
  { kernel: 'sds', id: TZ, size: T_SIZE_3G, parts: [
    { name: 'sds1', size: B1_INTERIOR, label: 'tank-d3-b1', md: 'md127' },
    { name: 'sds2', size: B2_CLAMPED_3G, label: 'tank-d3-b2', md: 'md126' },
  ] },
]

const MD_SIZES = { md127: 4190208 * 1024, md126: 1047552 * 1024 }
const LVM_NODE = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }

function tankExportFor(name: string, level: string, devices: number, uuid: string): string {
  return `MD_LEVEL=${level}\nMD_DEVICES=${devices}\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_DEVNAME=${name}\nMD_NAME=anas-test:${name}\n`
}

function tankAhrLsblkJson(): string {
  return JSON.stringify({ blockdevices: TANK_DISKS.map(d => ({
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

function tankInventoryLsblkJson(): string {
  return JSON.stringify({ blockdevices: TANK_DISKS.map(d => ({
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

const TANK_BY_ID = `${TANK_DISKS.map(d => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${d.id} -> ../../${d.kernel}`).join('\n')}\n`

const TANK_BTRFS = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

const TANK_MDSTAT_CLEAN = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

const TANK_MDSTAT_RESHAPE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
      [====>................]  reshape = 23.5% (1000000/4190208) finish=8.0min speed=2048K/sec

unused devices: <none>
`

// A member lost from md127 → the pool reads degraded (must NOT re-attach).
const TANK_MDSTAT_DEGRADED = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]

unused devices: <none>
`

function buildTankExecutor(mdstat: string): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: mdstat, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: tankExportFor('tank-r1', 'raid5', 3, 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md126'], result: { stdout: tankExportFor('tank-r2', 'raid1', 2, 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: tankAhrLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: { stdout: tankInventoryLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: TANK_BY_ID, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: { stdout: JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: TANK_BTRFS, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

interface SubmittedJob { operation: string, submitter: JobSubmitter, handler: JobHandler }
/** A jobQueue whose submit() records the call and NEVER runs the handler. */
function stubJobQueue(): { submitted: SubmittedJob[], queue: JobQueue } {
  const submitted: SubmittedJob[] = []
  const submit = (operation: string, submitter: JobSubmitter, handler: JobHandler): JobRef => {
    submitted.push({ operation, submitter, handler })
    return { id: 'stub-job', status: 'queued', operation, createdAt: '2026-01-01T00:00:00.000Z', createdBy: submitter.user }
  }
  return { submitted, queue: { submit } as unknown as JobQueue }
}

function mkTankIntent(state: AhrExpansionIntent['state'], approved: string[]): AhrExpansionIntent {
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: approved, before: CAP, after: CAP, state }
}

function perlWarnings(executor: MockExecutor) {
  return executor.calls.filter(c => c.command === '/usr/bin/perl' && c.args[2] === 'warning')
}
function perlInfos(executor: MockExecutor) {
  return executor.calls.filter(c => c.command === '/usr/bin/perl' && c.args[2] === 'info')
}

describe('ahr-boot-scan re-attach (issue #1 — healthy interrupted reshape)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-boot-resume-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('running intent + HEALTHY in-flight reshape → re-attaches via the shared core (system identity), intent stays running', async () => {
    const executor = buildTankExecutor(TANK_MDSTAT_RESHAPE)
    const { submitted, queue } = stubJobQueue()
    await writeIntent('tank', mkTankIntent('running', [TX, TY, TZ]), { dir })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: queue, diskCache: new DiskIdentityCache(executor) })

    assert.deepEqual(report.reattached, ['tank'])
    assert.deepEqual(report.haltedIntents, [])
    // The in-flight expansion is tracked again — intent back to running.
    assert.equal((await readIntent('tank', dir))?.state, 'running')
    // A driving job was submitted under the synthetic boot-reattach identity.
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].operation, 'ahr.expand.resume')
    assert.equal(submitted[0].submitter.user, 'system:boot-reattach')
    assert.equal(submitted[0].submitter.uid, 0)
    // Re-attaching is a non-event: NO PVE notification fires (log-only), and NOT
    // the old "needs manual Resume" warning either.
    assert.equal(perlInfos(executor).length, 0)
    assert.equal(perlWarnings(executor).length, 0)
  })

  it('running intent + CLEAN array (reshape done, post-steps pending) → re-attaches', async () => {
    const executor = buildTankExecutor(TANK_MDSTAT_CLEAN)
    const { submitted, queue } = stubJobQueue()
    await writeIntent('tank', mkTankIntent('running', [TX, TY, TZ]), { dir })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: queue, diskCache: new DiskIdentityCache(executor) })

    assert.deepEqual(report.reattached, ['tank'])
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].operation, 'ahr.expand.resume')
    assert.equal((await readIntent('tank', dir))?.state, 'running')
  })

  it('running intent + a MISSING approved disk → NO auto-drive, intent halted, warning fires (fail-closed)', async () => {
    const executor = buildTankExecutor(TANK_MDSTAT_CLEAN)
    const { submitted, queue } = stubJobQueue()
    // ata-GHOST is neither a member nor in the inventory → resolveApproved fails.
    await writeIntent('tank', mkTankIntent('running', [TX, TY, TZ, 'ata-GHOST']), { dir })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: queue, diskCache: new DiskIdentityCache(executor) })

    assert.deepEqual(report.reattached, [])
    assert.deepEqual(report.haltedIntents, ['tank'])
    assert.equal((await readIntent('tank', dir))?.state, 'halted')
    assert.equal(submitted.length, 0, 'no job submitted — fail closed')
    const warnings = perlWarnings(executor)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].args[4], /ata-GHOST/)
    assert.match(warnings[0].args[4], /could not proceed/)
  })

  it('running intent + DEGRADED pool → NO re-attach, intent halted, existing warning fires (operator verb)', async () => {
    const executor = buildTankExecutor(TANK_MDSTAT_DEGRADED)
    const { submitted, queue } = stubJobQueue()
    await writeIntent('tank', mkTankIntent('running', [TX, TY, TZ]), { dir })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: queue, diskCache: new DiskIdentityCache(executor) })

    assert.deepEqual(report.reattached, [])
    assert.deepEqual(report.haltedIntents, ['tank'])
    assert.equal((await readIntent('tank', dir))?.state, 'halted')
    assert.equal(submitted.length, 0, 'degraded pool never auto-driven')
    const warnings = perlWarnings(executor)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].args[4], /Resume/)
  })

  it('running intent + GT-8 inactive-all-spares → NO re-attach, intent halted (recovery ladder path)', async () => {
    // md127 = ahr0-r1 assembles inactive/all-spares → branch (a) ladder fires
    // and the pool is ineligible; the ahr0 running intent halts, not resumes.
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_INACTIVE_SPARES)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgchange', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    const { submitted, queue } = stubJobQueue()
    await writeIntent('ahr0', mkIntent('running'), { dir })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {}, jobQueue: queue, diskCache: new DiskIdentityCache(executor) })

    assert.deepEqual(report.recovered, ['ahr0-r1'])
    assert.deepEqual(report.reattached, [])
    assert.deepEqual(report.haltedIntents, ['ahr0'])
    assert.equal((await readIntent('ahr0', dir))?.state, 'halted')
    assert.equal(submitted.length, 0, 'GT-8 recovery path is an operator verb, never auto-driven')
  })
})
