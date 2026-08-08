import type { AhrCapacity, AhrExpansionIntent, AhrExpansionStep, AhrPool, AhrPreviewBand, ArrayLevel } from '@anas/shared'
import type { AhrExpansionPlan } from '../ahr-layout.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { LVM_MIXED_BLOCK_ARGS } from '../ahr-exec.js'
import { diskLsblkArgs, executeExpansion, executeReadd, executeReplace, projectExistingBands } from '../ahr-expand-exec.js'
import { readIntent, writeIntent } from '../ahr-intent.js'
import { planExpansion } from '../ahr-layout.js'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

// The synthetic GiB-aligned "tank" world (the stage-0 fixtures are MiB-scale
// and pre-date the §2.5 granularity, so they cannot legally replan):
//  band 1 [0,2GiB]  raid5×3 (md127: X,Y,Z)   band 2 [2GiB,3GiB] raid1×2 (md126: Y,Z)
const X = 'ata-TANK_X' // 2 GiB class → sdq
const Y = 'ata-TANK_Y' // 3 GiB class → sdr
const Z = 'ata-TANK_Z' // 3 GiB class → sds
const W = 'ata-TANK_W' // 4 GiB class → sdt (incoming)
const V = 'ata-TANK_V' // 4 GiB class → sdu (incoming)
const N = 'ata-TANK_N' // 2 GiB class → sdv (replacement for X)

const SIZE_2G = 2 * GIB + 8 * MIB
const SIZE_3G = 3 * GIB + 8 * MIB
const SIZE_4G = 4 * GIB + 8 * MIB
const GPT_TAIL = 33 * 512

// Partition sizes exactly as sgdisk would carve them (GT-4).
const B1_INTERIOR = 2 * GIB - MIB // start 1MiB, end 2GiB
const B1_CLAMPED_2G = SIZE_2G - MIB - GPT_TAIL // X's top slice clamps to disk end
const B2_CLAMPED_3G = SIZE_3G - GPT_TAIL - 2 * GIB // Y/Z top slice
const B2_INTERIOR = GIB // [2GiB,3GiB] on a taller disk
const B3_INTERIOR = GIB // [3GiB,4GiB]

const R1_UUID = 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'
const R2_UUID = 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb'
const R3_UUID = 'cccccccc:cccccccc:cccccccc:cccccccc'

const MDSTAT_BASE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

const MDSTAT_WITH_R3 = `Personalities : [raid1] [raid5]
md125 : active raid1 sdu3[1] sdt3[0]
      1047552 blocks super 1.2 [2/2] [UU]

${MDSTAT_BASE.split('\n').slice(1).join('\n')}`

const MDSTAT_RESHAPING = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdt1[3] sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]
      [==>..................]  reshape = 10.0% (209510/2095104) finish=5.0min speed=10240K/sec

unused devices: <none>
`

function mdstatReshapeDegraded(percent: string): string {
  return `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdt1[3] sds1[2] sdr1[1] sdq1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/3] [_UUU]
      [===========>.........]  reshape = ${percent}% (1152307/2095104) finish=2.0min speed=10240K/sec

unused devices: <none>
`
}

const MDSTAT_DONE_DEGRADED = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdt1[3] sds1[2] sdr1[1] sdq1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/3] [_UUU]

unused devices: <none>
`

const MDSTAT_INACTIVE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : inactive sdt1[3](S) sds1[2](S) sdr1[1](S) sdq1[0](S)
      4190208 blocks super 1.2

unused devices: <none>
`

// Live --replace drill shapes (GT-4/GT-10 phase-d): copy running, then landed.
const MDSTAT_REPLACE_RUNNING = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdv1[3](R) sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
      [==>..................]  recovery = 12.0% (251412/2095104) finish=3.0min speed=10240K/sec

unused devices: <none>
`

const MDSTAT_REPLACE_DONE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdv1[3] sds1[2] sdr1[1] sdq1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

function exportFor(name: string, level: string, devices: number, uuid: string): string {
  return [
    `MD_LEVEL=${level}`,
    `MD_DEVICES=${devices}`,
    'MD_METADATA=1.2',
    `MD_UUID=${uuid}`,
    `MD_DEVNAME=${name}`,
    `MD_NAME=anas-test:${name}`, // homehost-prefixed on purpose (GT-3)
    '',
  ].join('\n')
}

interface PartSpec { name: string, size: number, label: string }

function diskJson(kernel: string, size: number, parts: PartSpec[]): string {
  return JSON.stringify({ blockdevices: [{
    name: kernel,
    type: 'disk',
    size,
    partlabel: null,
    children: parts.map(p => ({ name: p.name, type: 'part', size: p.size, partlabel: p.label })),
  }] })
}

const LSBLK = '/usr/bin/lsblk'
const MDADM = '/usr/sbin/mdadm'
const SGDISK = '/usr/sbin/sgdisk'
const PERL = '/usr/bin/perl'

const DISK_PARTS: Record<string, { kernel: string, size: number, parts: PartSpec[] }> = {
  [X]: { kernel: 'sdq', size: SIZE_2G, parts: [{ name: 'sdq1', size: B1_CLAMPED_2G, label: 'tank-d1-b1' }] },
  [Y]: { kernel: 'sdr', size: SIZE_3G, parts: [
    { name: 'sdr1', size: B1_INTERIOR, label: 'tank-d2-b1' },
    { name: 'sdr2', size: B2_CLAMPED_3G, label: 'tank-d2-b2' },
  ] },
  [Z]: { kernel: 'sds', size: SIZE_3G, parts: [
    { name: 'sds1', size: B1_INTERIOR, label: 'tank-d3-b1' },
    { name: 'sds2', size: B2_CLAMPED_3G, label: 'tank-d3-b2' },
  ] },
}

/** Register the baseline tank world on a fresh MockExecutor. */
function world(opts: { mdstat?: string | string[], r2Export?: string } = {}): MockExecutor {
  const executor = new MockExecutor()
  const mdstat = opts.mdstat ?? MDSTAT_BASE
  if (Array.isArray(mdstat))
    executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], results: mdstat.map(s => ({ stdout: s, stderr: '', exitCode: 0 })) })
  else
    executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: mdstat, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, R1_UUID), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md126'], result: { stdout: opts.r2Export ?? exportFor('tank-r2', 'raid1', 2, R2_UUID), stderr: '', exitCode: 0 } })
  for (const [id, d] of Object.entries(DISK_PARTS))
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${id}`), result: { stdout: diskJson(d.kernel, d.size, d.parts), stderr: '', exitCode: 0 } })
  // Notifications + udev settle succeed quietly.
  executor.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/udevadm', result: { stdout: '', stderr: '', exitCode: 0 } })
  // partx + the by-id link probe the partition step verifies with (issue #12).
  // Command-only, so arg-specific realpath fixtures in individual tests still win.
  executor.addFixture({ command: '/usr/sbin/partx', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', result: { stdout: '/dev/sdt1\n', stderr: '', exitCode: 0 } })
  return executor
}

function pband(band: number, startBytes: number, endBytes: number, memberCount: number, level: ArrayLevel | null): AhrPreviewBand {
  const heightBytes = endBytes - startBytes
  return {
    band,
    range: { startBytes, endBytes },
    memberCount,
    level,
    heightBytes,
    usableBytes: level === null ? 0 : heightBytes * (memberCount - 1),
    protected: level !== null,
  }
}

const CAP: AhrCapacity = {
  rawBytes: 0,
  usableBytes: 4 * GIB,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function mkPlan(bands: AhrPreviewBand[], steps: (Pick<AhrExpansionStep, 'kind' | 'target'> & { detail?: string })[]): AhrExpansionPlan {
  return {
    steps: steps.map((s, index) => ({ index, status: 'pending' as const, ...s })),
    preview: { bands, capacity: CAP, warnings: [], minDisksMet: true },
  }
}

function mkPool(): AhrPool {
  const member = (disk: string, part: string) =>
    ({ disk, partition: `/dev/disk/by-id/${disk}-part${part}`, memberState: 'in_sync' as const })
  return {
    name: 'tank',
    ahrType: 'ahr1',
    mountpoint: '/mnt/anas-ahr/tank',
    mounted: true,
    disks: [],
    subvolLayout: true,
    arrays: [
      { device: '/dev/md/tank-r1', band: 1, level: 'raid5', heightBytes: 2 * GIB, members: [member(X, '1'), member(Y, '1'), member(Z, '1')], state: 'clean' },
      { device: '/dev/md/tank-r2', band: 2, level: 'raid1', heightBytes: GIB, members: [member(Y, '2'), member(Z, '2')], state: 'clean' },
    ],
    vg: { name: 'tank', sizeBytes: 5 * GIB, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 5 * GIB },
    capacity: CAP,
    state: 'healthy',
    advisories: [],
  }
}

function mkIntent(approved: string[], extra: Partial<AhrExpansionIntent> = {}): AhrExpansionIntent {
  return {
    id: randomUUID(),
    trigger: 'add-disk',
    approvedDisks: approved,
    before: CAP,
    after: { ...CAP, usableBytes: 6 * GIB },
    state: 'running',
    ...extra,
  }
}

/** Every recorded call that would MUTATE the system. */
function mutatingCalls(executor: MockExecutor): { command: string, args: string[] }[] {
  return executor.calls.filter((c) => {
    if (c.command === MDADM)
      return c.args[0] !== '--detail'
    if (c.command === '/usr/bin/btrfs')
      return c.args.includes('resize')
    return [SGDISK, '/usr/sbin/pvcreate', '/usr/sbin/pvresize', '/usr/sbin/vgextend', '/usr/sbin/lvextend', '/usr/sbin/update-initramfs'].includes(c.command)
  })
}

function notifyCalls(executor: MockExecutor, severity: string): { command: string, args: string[] }[] {
  return executor.calls.filter(c => c.command === PERL && c.args[2] === severity)
}

// LVM/btrfs report shapes for the tail steps (and, since issue #4, for the
// delivered-capacity read that completion reports).
function pvsJson(rows: { name: string, vg: string | null, size: number }[]): string {
  return JSON.stringify({ report: [{ pv: rows.map(r => ({ pv_name: r.name, vg_name: r.vg ?? '', pv_size: String(r.size), pv_free: '0' })) }] })
}
function vgsJson(free: number): string {
  return JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(5 * GIB), vg_free: String(free) }] }] })
}
function lvsJson(size: number): string {
  return JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(size) }] }] })
}
function btrfsUsageJson(deviceSize: number): string {
  return [
    'Overall:',
    `    Device size:\t\t${deviceSize}`,
    '    Used:\t\t1024',
    `    Free (estimated):\t\t${deviceSize - 4096}\t(min: ${deviceSize - 8192})`,
    '',
  ].join('\n')
}
const R1_BYTES = 4190208 * 1024

const B1 = pband(1, 0, 2 * GIB, 3, 'raid5')
const B1_GROWN = pband(1, 0, 2 * GIB, 4, 'raid5')
const B2 = pband(2, 2 * GIB, 3 * GIB, 2, 'raid1')
const B2_CONVERTED = pband(2, 2 * GIB, 3 * GIB, 3, 'raid5')
const B3 = pband(3, 3 * GIB, 4 * GIB, 2, 'raid1')

describe('ahr-expand-exec (Epic 11.6 — detect-then-delta steps)', () => {
  let dir: string
  let progress: string[]

  const run = (executor: MockExecutor, plan: AhrExpansionPlan, approved: string[], intent?: AhrExpansionIntent) =>
    executeExpansion(
      executor,
      { pool: mkPool(), intent: intent ?? mkIntent(approved), plan },
      (m) => { progress.push(m) },
      { intentDir: dir, pollIntervalMs: 1, log: () => {} },
    )

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-exec-'))
    progress = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    delete process.env.ANAS_MDADM_CONF
  })

  describe('partition', () => {
    it('skips slices whose partitions already exist (no sgdisk)', async () => {
      const executor = world()
      const outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'partition', target: Y }]), [X, Y, Z])
      assert.equal(outcome.ok, true)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('carves only the missing slices for a new disk, with labels + FD00', async () => {
      const executor = world()
      // Before the carve the disk is bare; AFTER it the kernel must show the
      // slices — the partition step now VERIFIES that (issue #12) instead of
      // reporting done and failing minutes later.
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), results: [
        { stdout: diskJson('sdt', SIZE_4G, []), stderr: '', exitCode: 0 },
        { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }, { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2' }]), stderr: '', exitCode: 0 },
      ] })
      // Pool-wide label scan (fresh disk gets max(d)+1 = d4).
      const tree = { blockdevices: Object.values(DISK_PARTS).map(d => ({
        name: d.kernel,
        type: 'disk',
        size: d.size,
        children: d.parts.map(p => ({ name: p.name, type: 'part', size: p.size, partlabel: p.label })),
      })) }
      executor.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: JSON.stringify(tree), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: SGDISK, result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2_CONVERTED], [{ kind: 'partition', target: W }]), [X, Y, Z, W])
      assert.equal(outcome.ok, true, outcome.error)
      const sgdisk = executor.calls.filter(c => c.command === SGDISK)
      assert.equal(sgdisk.length, 1)
      assert.deepEqual(sgdisk[0].args, [
        '-n',
        '1:1M:+2047M',
        '-t',
        '1:FD00',
        '-c',
        '1:tank-d4-b1',
        '-n',
        '2:2048M:+1024M',
        '-t',
        '2:FD00',
        '-c',
        '2:tank-d4-b2',
        `/dev/disk/by-id/${W}`,
      ])
      assert.ok(executor.calls.some(c => c.command === '/usr/bin/udevadm'))
    })
  })

  describe('array-grow', () => {
    it('is a no-op when the member is present and raid-devices is at target', async () => {
      const executor = world()
      const outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'array-grow', target: 'md/tank-r1' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    // Issue #12: sgdisk writes the new slice to the GPT of a disk that is IN
    // USE (its other slices are live md members), and the kernel refuses the
    // whole-table BLKRRPART re-read that would publish it. `udevadm settle`
    // cannot help — there is no event to wait for. The step used to report
    // success and the job died ~6.5 minutes later in expectedBandMembers.
    it('publishes a new slice with partx and VERIFIES it appeared', async () => {
      const executor = world()
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), results: [
        { stdout: diskJson('sdt', SIZE_4G, []), stderr: '', exitCode: 0 },
        { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }, { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2' }]), stderr: '', exitCode: 0 },
      ] })
      executor.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: JSON.stringify({ blockdevices: [] }), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: SGDISK, result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2_CONVERTED], [{ kind: 'partition', target: W }]), [X, Y, Z, W])
      assert.equal(outcome.ok, true, outcome.error)

      // BLKPG per-partition add — the mechanism that works on a held disk.
      const partx = executor.calls.filter(c => c.command === '/usr/sbin/partx')
      assert.deepEqual(partx.map(c => c.args), [['-a', `/dev/disk/by-id/${W}`]])
      // …and it runs AFTER sgdisk wrote the table, not before.
      const order = executor.calls.map(c => c.command)
      assert.ok(order.indexOf(SGDISK) < order.indexOf('/usr/sbin/partx'))
    })

    it('FAILS THE PARTITION STEP when the slice never becomes a device', async () => {
      const executor = world()
      // sgdisk succeeds and partx runs, but the kernel never adopts the slice:
      // the tree still shows a bare disk. The step must die HERE, naming the
      // real cause, not six minutes downstream in an unrelated step.
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, []), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: JSON.stringify({ blockdevices: [] }), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: SGDISK, result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2_CONVERTED], [{ kind: 'partition', target: W }]), [X, Y, Z, W])
      assert.equal(outcome.ok, false)
      assert.match(outcome.error!, /never appeared as/)
      assert.match(outcome.error!, /the disk is in use, so a whole-table re-read is refused/)
      // It never proceeded to touch md with a partition that does not exist.
      assert.ok(!executor.calls.some(c => c.command === MDADM && c.args.includes('--add')))
    })

    it('a by-id link that never materializes also fails the step', async () => {
      const executor = world()
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), results: [
        { stdout: diskJson('sdt', SIZE_4G, []), stderr: '', exitCode: 0 },
        { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }, { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2' }]), stderr: '', exitCode: 0 },
      ] })
      executor.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: JSON.stringify({ blockdevices: [] }), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: SGDISK, result: { stdout: '', stderr: '', exitCode: 0 } })
      // The kernel has the partition, but udev never made the -partN symlink
      // the md steps address it by.
      executor.addFixture({ command: '/usr/bin/realpath', args: [`/dev/disk/by-id/${W}-part1`], result: { stdout: '', stderr: 'no such file', exitCode: 1 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2_CONVERTED], [{ kind: 'partition', target: W }]), [X, Y, Z, W])
      assert.equal(outcome.ok, false)
      assert.match(outcome.error!, /never appeared as/)
    })

    it('adds the new member then grows — never with --backup-file', async () => {
      const executor = world()
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }, { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2], [{ kind: 'array-grow', target: 'md/tank-r1' }]), [X, Y, Z, W])
      assert.equal(outcome.ok, true, outcome.error)
      const md = mutatingCalls(executor).filter(c => c.command === MDADM)
      assert.deepEqual(md.map(c => c.args), [
        ['/dev/md127', '--add', `/dev/disk/by-id/${W}-part1`],
        ['--grow', '/dev/md127', '--raid-devices=4'],
      ])
      assert.ok(executor.calls.every(c => !c.args.some(a => a.includes('--backup-file'))))
    })

    it('FAILS with the exact stderr when mdadm demands a backup file (GT-6 violation signal)', async () => {
      const executor = world()
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
      const stderr = 'mdadm: Need to backup 3072K of critical section.. please provide a --backup-file'
      executor.addFixture({ command: MDADM, args: ['--grow', '/dev/md127', '--raid-devices=4'], result: { stdout: '', stderr, exitCode: 1 } })

      const intent = mkIntent([X, Y, Z, W])
      const outcome = await run(executor, mkPlan([B1_GROWN, B2], [
        { kind: 'array-grow', target: 'md/tank-r1' },
        { kind: 'pv-resize', target: 'md/tank-r1' },
      ]), [X, Y, Z, W], intent)

      assert.equal(outcome.ok, false)
      assert.ok(outcome.error!.includes(stderr), 'the exact mdadm stderr is preserved')
      assert.match(outcome.error!, /GT-6/)
      assert.equal(outcome.failedStep?.kind, 'array-grow')
      // The pipeline halted: no later step ran, the intent is 'halted', one error notify.
      assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/pvresize'))
      assert.equal((await readIntent('tank', dir))?.state, 'halted')
      assert.equal(notifyCalls(executor, 'error').length, 1)
    })

    // Bug #6 (code review): with a hot spare (§11) attached, its slice sits as a
    // spare in the same band. `--grow --raid-devices=N` may absorb the HOT SPARE
    // into the new slot instead of the intended new slice — silently converting
    // the spare disk to a data member. The grow must be made deterministic:
    // remove the spare slice first, grow with only the new slice spare, re-add.
    it('§11: pulls the hot-spare slice out BEFORE the grow, then re-adds it', async () => {
      const S = 'ata-TANK_S'
      const withSpare = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sde1[4](S) sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`
      const afterGrow = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdt1[3] sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]

unused devices: <none>
`
      const executor = world({ mdstat: [withSpare, afterGrow] })
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }, { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${S}`), result: { stdout: diskJson('sde', SIZE_2G, [{ name: 'sde1', size: B1_INTERIOR, label: 'tank-d5-b1' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })

      const spareDisk = { id: S, sizeBytes: SIZE_2G, usableBytes: 2 * GIB, model: null, serial: null, role: 'spare' as const, partitions: [{ device: `/dev/disk/by-id/${S}-part1`, band: 1, sizeBytes: B1_INTERIOR }] }
      const poolWithSpare: AhrPool = { ...mkPool(), disks: [spareDisk] }

      const outcome = await executeExpansion(
        executor,
        { pool: poolWithSpare, intent: mkIntent([X, Y, Z, W]), plan: mkPlan([B1_GROWN, B2], [{ kind: 'array-grow', target: 'md/tank-r1' }]) },
        () => {},
        { intentDir: dir, pollIntervalMs: 1, log: () => {} },
      )
      assert.equal(outcome.ok, true, outcome.error)
      const md = mutatingCalls(executor).filter(c => c.command === MDADM)
      assert.deepEqual(md.map(c => c.args), [
        ['/dev/md127', '--add', `/dev/disk/by-id/${W}-part1`],
        ['/dev/md127', '--remove', `/dev/disk/by-id/${S}-part1`], // spare pulled FIRST
        ['--grow', '/dev/md127', '--raid-devices=4'],
        ['/dev/md127', '--add-spare', `/dev/disk/by-id/${S}-part1`], // coverage restored
      ])
    })
  })

  describe('array-convert', () => {
    it('is a no-op when the array is already converted', async () => {
      const executor = world({ r2Export: exportFor('tank-r2', 'raid5', 3, R2_UUID) })
      const outcome = await run(executor, mkPlan([B1, B2_CONVERTED], [{ kind: 'array-convert', target: 'md/tank-r2' }]), [X, Y, Z, W])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('adds the member then converts one-shot: --level=5 --raid-devices=3 (GT-7)', async () => {
      const executor = world()
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, [{ name: 'sdt1', size: B1_INTERIOR, label: 'tank-d4-b1' }, { name: 'sdt2', size: B2_INTERIOR, label: 'tank-d4-b2' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2_CONVERTED], [{ kind: 'array-convert', target: 'md/tank-r2' }]), [X, Y, Z, W])
      assert.equal(outcome.ok, true, outcome.error)
      const md = mutatingCalls(executor).filter(c => c.command === MDADM)
      assert.deepEqual(md.map(c => c.args), [
        ['/dev/md126', '--add', `/dev/disk/by-id/${W}-part2`],
        ['--grow', '/dev/md126', '--level=5', '--raid-devices=3'],
      ])
    })
  })

  describe('array-create', () => {
    it('skips an array that already exists', async () => {
      const executor = world({ mdstat: MDSTAT_WITH_R3 })
      executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md125'], result: { stdout: exportFor('tank-r3', 'raid1', 2, R3_UUID), stderr: '', exitCode: 0 } })
      const outcome = await run(executor, mkPlan([B1, B2, B3], [{ kind: 'array-create', target: 'md/tank-r3' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('creates with explicit --data-offset + name, then pins + update-initramfs', async () => {
      process.env.ANAS_MDADM_CONF = join(dir, 'mdadm.conf')
      const executor = world({ mdstat: [MDSTAT_BASE, MDSTAT_WITH_R3] })
      const parts4 = (kernel: string, d: number): PartSpec[] => [
        { name: `${kernel}1`, size: B1_INTERIOR, label: `tank-d${d}-b1` },
        { name: `${kernel}2`, size: B2_INTERIOR, label: `tank-d${d}-b2` },
        { name: `${kernel}3`, size: B3_INTERIOR, label: `tank-d${d}-b3` },
      ]
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, parts4('sdt', 4)), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${V}`), result: { stdout: diskJson('sdu', SIZE_4G, parts4('sdu', 5)), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md125'], result: { stdout: exportFor('tank-r3', 'raid1', 2, R3_UUID), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/update-initramfs', result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1_GROWN, B2_CONVERTED, B3], [{ kind: 'array-create', target: 'md/tank-r3' }]), [X, Y, Z, W, V])
      assert.equal(outcome.ok, true, outcome.error)
      const create = executor.calls.find(c => c.command === MDADM && c.args[0] === '--create')!
      assert.deepEqual(create.args, [
        '--create',
        '/dev/md/tank-r3',
        '--run',
        '--level=1',
        '--raid-devices=2',
        '--metadata=1.2',
        '--name=tank-r3',
        '--data-offset=8192s', // 4 MiB for a sub-128GiB member (GT-5 policy)
        '--bitmap=internal',
        `/dev/disk/by-id/${W}-part3`,
        `/dev/disk/by-id/${V}-part3`,
      ])
      // Pinned in mdadm.conf + initramfs refreshed (§2.6).
      const conf = await readFile(join(dir, 'mdadm.conf'), 'utf-8')
      assert.ok(conf.includes(R3_UUID))
      assert.ok(conf.includes('tank-r3'))
      assert.ok(executor.calls.some(c => c.command === '/usr/sbin/update-initramfs'))
    })
  })

  describe('reshape-wait', () => {
    it('reports progress, continues degraded with exactly ONE error notify, never re-issues', async () => {
      const executor = world({ mdstat: [
        MDSTAT_RESHAPING, // resolve pass
        MDSTAT_RESHAPING,
        mdstatReshapeDegraded('55.0'),
        mdstatReshapeDegraded('80.0'),
        MDSTAT_DONE_DEGRADED,
      ] })
      const outcome = await run(executor, mkPlan([B1_GROWN, B2], [{ kind: 'reshape-wait', target: 'md/tank-r1' }]), [X, Y, Z, W])
      assert.equal(outcome.ok, true, outcome.error)
      assert.ok(progress.some(m => m.includes('10.0%')))
      assert.ok(progress.some(m => m.includes('55.0%') && m.includes('DEGRADED')))
      assert.equal(notifyCalls(executor, 'error').length, 1, 'degraded-during-reshape notifies exactly once')
      // Observation only: no mdadm beyond --detail, ever.
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('FAILS when the array goes inactive mid-wait (GT-8 family)', async () => {
      const executor = world({ mdstat: [MDSTAT_RESHAPING, MDSTAT_RESHAPING, MDSTAT_INACTIVE] })
      const intent = mkIntent([X, Y, Z, W])
      const outcome = await run(executor, mkPlan([B1_GROWN, B2], [{ kind: 'reshape-wait', target: 'md/tank-r1' }]), [X, Y, Z, W], intent)
      assert.equal(outcome.ok, false)
      assert.match(outcome.error!, /INACTIVE/)
      assert.equal((await readIntent('tank', dir))?.state, 'halted')
    })
  })

  describe('LVM + filesystem tail', () => {
    it('pv-create skips an existing PV and creates a missing one', async () => {
      const withR3 = () => {
        const executor = world({ mdstat: MDSTAT_WITH_R3 })
        executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md125'], result: { stdout: exportFor('tank-r3', 'raid1', 2, R3_UUID), stderr: '', exitCode: 0 } })
        return executor
      }
      // Already a PV → skip.
      let executor = withR3()
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson([{ name: '/dev/md125', vg: null, size: GIB }]), stderr: '', exitCode: 0 } })
      let outcome = await run(executor, mkPlan([B1, B2, B3], [{ kind: 'pv-create', target: 'md/tank-r3' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
      // Not yet a PV → pvcreate on the resolved kernel device.
      executor = withR3()
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson([]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/pvcreate', result: { stdout: '', stderr: '', exitCode: 0 } })
      outcome = await run(executor, mkPlan([B1, B2, B3], [{ kind: 'pv-create', target: 'md/tank-r3' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/pvcreate', ...LVM_MIXED_BLOCK_ARGS, '/dev/md125']])
    })

    it('pv-resize skips when the PV already matches the array size', async () => {
      const executor = world()
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson([{ name: '/dev/md127', vg: 'tank', size: R1_BYTES }]), stderr: '', exitCode: 0 } })
      const outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'pv-resize', target: 'md/tank-r1' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('pv-resize resizes a lagging PV', async () => {
      const executor = world()
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson([{ name: '/dev/md127', vg: 'tank', size: R1_BYTES - 2 * GIB }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/pvresize', result: { stdout: '', stderr: '', exitCode: 0 } })
      const outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'pv-resize', target: 'md/tank-r1' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/pvresize', '/dev/md127']])
    })

    it('vg-extend adds only PVs not yet in the VG (skip when all are in)', async () => {
      const base = () => {
        const executor = world({ mdstat: MDSTAT_WITH_R3 })
        executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md125'], result: { stdout: exportFor('tank-r3', 'raid1', 2, R3_UUID), stderr: '', exitCode: 0 } })
        executor.addFixture({ command: '/usr/sbin/vgextend', result: { stdout: '', stderr: '', exitCode: 0 } })
        return executor
      }
      const plan = mkPlan([B1, B2, B3], [{ kind: 'pv-create', target: 'md/tank-r3' }, { kind: 'vg-extend', target: 'tank' }])
      // Already in the VG → both steps no-ops.
      let executor = base()
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson([{ name: '/dev/md125', vg: 'tank', size: GIB }]), stderr: '', exitCode: 0 } })
      let outcome = await run(executor, plan, [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
      // PV exists but unassigned → vgextend.
      executor = base()
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson([{ name: '/dev/md125', vg: null, size: GIB }]), stderr: '', exitCode: 0 } })
      outcome = await run(executor, plan, [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/vgextend', ...LVM_MIXED_BLOCK_ARGS, 'tank', '/dev/md125']])
    })

    it('lv-extend consumes free space; skips when nothing is free', async () => {
      // Free space present → extend.
      let executor = world()
      executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: vgsJson(GIB), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/lvextend', result: { stdout: '', stderr: '', exitCode: 0 } })
      let outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'lv-extend', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/lvextend', ...LVM_MIXED_BLOCK_ARGS, '-l', '+100%FREE', '/dev/tank/tank-vol']])
      // Nothing free → no-op.
      executor = world()
      executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: vgsJson(0), stderr: '', exitCode: 0 } })
      outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'lv-extend', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('fs-grow REFUSES when lv-extend is not verified complete', async () => {
      const executor = world()
      executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: vgsJson(2 * GIB), stderr: '', exitCode: 0 } })
      const outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'fs-grow', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, false)
      assert.match(outcome.error!, /refusing to grow the filesystem before its block device/)
      assert.deepEqual(mutatingCalls(executor), [])
    })

    it('fs-grow runs btrfs resize max LAST — and skips when already grown', async () => {
      const usage = (deviceSize: number) => [
        'Overall:',
        `    Device size:\t\t${deviceSize}`,
        '    Used:\t\t1024',
        `    Free (estimated):\t\t${deviceSize - 4096}\t(min: ${deviceSize - 8192})`,
        '',
      ].join('\n')
      const withTail = (deviceSize: number) => {
        const executor = world()
        executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: vgsJson(0), stderr: '', exitCode: 0 } })
        executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson(5 * GIB), stderr: '', exitCode: 0 } })
        executor.addFixture({ command: '/usr/bin/findmnt', result: { stdout: JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }] }), stderr: '', exitCode: 0 } })
        executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: usage(deviceSize), stderr: '', exitCode: 0 } })
        executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
        return executor
      }
      // Already at LV size → skip.
      let executor = withTail(5 * GIB)
      let outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'fs-grow', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor), [])
      // Smaller than the LV → resize max on the MOUNTPOINT.
      executor = withTail(3 * GIB)
      outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'fs-grow', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/bin/btrfs', 'filesystem', 'resize', 'max', '/mnt/anas-ahr/tank']])
    })

    // Bug #3 (code review): findmnt appends the mounted subvolume to a btrfs
    // source (`…-vol[/@data]`) — matching it raw against the mapper path MISSES
    // every §12 subvol-layout pool, so fs-grow deterministically halted with
    // "filesystem is not mounted" on EVERY new pool's expansion.
    it('fs-grow matches a §12 subvol mount whose findmnt source carries [/@data]', async () => {
      const usage = (deviceSize: number): string => [
        'Overall:',
        `    Device size:\t\t${deviceSize}`,
        '    Used:\t\t1024',
        `    Free (estimated):\t\t${deviceSize - 4096}\t(min: ${deviceSize - 8192})`,
        '',
      ].join('\n')
      const executor = world()
      executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: vgsJson(0), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson(5 * GIB), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/findmnt', result: { stdout: JSON.stringify({ filesystems: [{
        target: '/mnt/anas-ahr/tank',
        source: '/dev/mapper/tank-tank--vol[/@data]', // the real subvol-layout source form
        fstype: 'btrfs',
        options: 'rw,relatime,subvolid=256,subvol=/@data',
      }] }), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: usage(3 * GIB), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })

      const outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'fs-grow', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error) // before the fix: halts "not mounted"
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/bin/btrfs', 'filesystem', 'resize', 'max', '/mnt/anas-ahr/tank']])
    })
  })

  describe('completion bookkeeping', () => {
    it('clears the intent and sends the before→after info notification', async () => {
      const executor = world()
      const intent = mkIntent([X, Y, Z])
      const outcome = await run(executor, mkPlan([B1, B2], []), [X, Y, Z], intent)
      assert.equal(outcome.ok, true)
      assert.equal(await readIntent('tank', dir), null)
      const info = notifyCalls(executor, 'info')
      assert.equal(info.length, 1)
      assert.match(info[0].args[4], /4 GiB → 6 GiB/)
    })
  })

  // -------------------------------------------------------------------------
  // Issue #4: resuming an expansion while the mdadm reshape is still in flight
  // completed the job in 152 ms on a real 4→5 × 22 TB pool, cleared the intent
  // and reported the PLANNED capacity — so when the kernel finished four days
  // later nothing ran pvresize → lvextend → btrfs resize, and the pool's usable
  // capacity silently never grew. These drive the REAL executor against a
  // reshaping mdstat; a stubbed job queue cannot catch this class.
  // -------------------------------------------------------------------------
  describe('completion invariant — never complete mid-sync (issue #4)', () => {
    // md publishes the GROWN size only when the reshape ENDS (4 members here,
    // 3 data → 6285312 blocks, up from 4190208).
    const MDSTAT_GROWN_IDLE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdt1[3] sds1[2] sdr1[1] sdq1[0]
      6285312 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]

unused devices: <none>
`
    const GROWN_BYTES = 6285312 * 1024

    /** The LVM/fs tail's fixtures: PV still at the OLD array size. */
    function withTailFixtures(executor: MockExecutor, opts: { lvBytes: number, pvs?: { name: string, vg: string | null, size: number }[] }): MockExecutor {
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: pvsJson(opts.pvs ?? [{ name: '/dev/md127', vg: 'tank', size: R1_BYTES }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/pvresize', result: { stdout: '', stderr: '', exitCode: 0 } })
      // lv-extend sees free space; fs-grow (next read) must see it consumed.
      executor.addFixture({ command: '/usr/sbin/vgs', results: [
        { stdout: vgsJson(GIB), stderr: '', exitCode: 0 },
        { stdout: vgsJson(0), stderr: '', exitCode: 0 },
      ] })
      executor.addFixture({ command: '/usr/sbin/lvextend', result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson(opts.lvBytes), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/findmnt', result: { stdout: JSON.stringify({ filesystems: [{ target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs', options: 'rw,relatime' }] }), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: btrfsUsageJson(3 * GIB), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
      return executor
    }

    it('THE BUG: an empty resume plan holds for the in-flight reshape, then delivers the tail', async () => {
      // mdstat reads: 1 invariant check, 2 reshape-wait resolve, 3 first poll
      // (still reshaping), 4+ idle with the grown size.
      const executor = withTailFixtures(
        world({ mdstat: [MDSTAT_RESHAPING, MDSTAT_RESHAPING, MDSTAT_RESHAPING, MDSTAT_GROWN_IDLE] }),
        { lvBytes: 6 * GIB },
      )
      const intent = mkIntent([X, Y, Z, W])
      await writeIntent('tank', intent, { dir })
      const intentPath = join(dir, 'tank.json')
      const intentPresentDuringWait: boolean[] = []

      // The plan a mid-reshape resume recomputes: the new disk is ALREADY an
      // md member, so §2.3 has nothing left to plan — not even a reshape-wait.
      const outcome = await executeExpansion(
        executor,
        { pool: mkPool(), intent, plan: mkPlan([B1_GROWN, B2], []) },
        (m) => {
          progress.push(m)
          if (m.includes('reshape'))
            intentPresentDuringWait.push(existsSync(intentPath))
        },
        { intentDir: dir, pollIntervalMs: 1, log: () => {} },
      )

      assert.equal(outcome.ok, true, outcome.error)
      // Before the fix this returned instantly with ZERO steps.
      assert.deepEqual(outcome.steps.map(s => s.kind), [
        'reshape-wait',
        'pv-create',
        'pv-resize',
        'vg-extend',
        'lv-extend',
        'fs-grow',
      ])
      assert.ok(intentPresentDuringWait.length > 0, 'the job actually waited on the reshape')
      assert.ok(intentPresentDuringWait.every(Boolean), 'the intent survived the whole in-flight reshape')
      assert.ok(progress.some(m => m.includes('reshape tank-r1') && m.includes('10.0%')), 'reshape progress is reported during the wait')

      // The size-dependent steps ran only AFTER mdstat flipped to idle (read 4).
      const firstResize = executor.calls.findIndex(c => c.command === '/usr/sbin/pvresize')
      assert.ok(firstResize > 0, 'pvresize ran')
      const mdstatReadsBefore = executor.calls.slice(0, firstResize).filter(c => c.command === '/usr/bin/cat').length
      assert.ok(mdstatReadsBefore >= 4, `no size-dependent step ran before md published the grown size (${mdstatReadsBefore} mdstat reads)`)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [
        ['/usr/sbin/pvresize', '/dev/md127'],
        ['/usr/sbin/lvextend', ...LVM_MIXED_BLOCK_ARGS, '-l', '+100%FREE', '/dev/tank/tank-vol'],
        ['/usr/bin/btrfs', 'filesystem', 'resize', 'max', '/mnt/anas-ahr/tank'],
      ])
      // Only NOW is the expansion over.
      assert.equal(await readIntent('tank', dir), null)
      assert.ok(GROWN_BYTES > R1_BYTES) // the fixture really does grow
    })

    it('a plan that already contains its reshape-wait behaves exactly as before (nothing appended)', async () => {
      const executor = world({ mdstat: [MDSTAT_RESHAPING, MDSTAT_RESHAPING, MDSTAT_GROWN_IDLE] })
      const intent = mkIntent([X, Y, Z, W])
      await writeIntent('tank', intent, { dir })
      const outcome = await run(executor, mkPlan([B1_GROWN, B2], [{ kind: 'reshape-wait', target: 'md/tank-r1' }]), [X, Y, Z, W], intent)
      assert.equal(outcome.ok, true, outcome.error)
      // The invariant read finds every array idle → a pure no-op read.
      assert.deepEqual(outcome.steps.map(s => s.kind), ['reshape-wait'])
      assert.deepEqual(mutatingCalls(executor), [])
      assert.equal(await readIntent('tank', dir), null)
    })

    it('a queued (DELAYED) sync holds completion too', async () => {
      const delayed = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]
      \tresync=DELAYED

md127 : active raid5 sdt1[3] sds1[2] sdr1[1] sdq1[0]
      6285312 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]

unused devices: <none>
`
      const executor = withTailFixtures(world({ mdstat: [delayed, delayed, MDSTAT_GROWN_IDLE] }), {
        lvBytes: 6 * GIB,
        // r2's PV is already created and at size — only r1's grew.
        pvs: [
          { name: '/dev/md127', vg: 'tank', size: R1_BYTES },
          { name: '/dev/md126', vg: 'tank', size: 1047552 * 1024 },
        ],
      })
      const intent = mkIntent([X, Y, Z, W])
      await writeIntent('tank', intent, { dir })
      const outcome = await run(executor, mkPlan([B1_GROWN, B2], []), [X, Y, Z, W], intent)
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(outcome.steps.map(s => s.kind), ['reshape-wait', 'pv-create', 'pv-resize', 'vg-extend', 'lv-extend', 'fs-grow'])
      assert.equal(outcome.steps[0].target, 'md/tank-r2', 'the DELAYED band is the one held on')
      assert.equal(await readIntent('tank', dir), null)
    })

    it('a scrub (md check) is NOT a hold — it cannot change the array size', async () => {
      const checking = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
      [==>..................]  check = 12.0% (251412/2095104) finish=300.0min speed=10240K/sec

unused devices: <none>
`
      const executor = world({ mdstat: checking })
      const intent = mkIntent([X, Y, Z])
      await writeIntent('tank', intent, { dir })
      const outcome = await run(executor, mkPlan([B1, B2], []), [X, Y, Z], intent)
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(outcome.steps, [])
      assert.equal(await readIntent('tank', dir), null)
    })
  })

  describe('delivered-capacity verification (issue #4)', () => {
    it('reports the MEASURED capacity, not the plan projection', async () => {
      const executor = world()
      executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson(6 * GIB - 512 * MIB), stderr: '', exitCode: 0 } })
      const lines: string[] = []
      const intent = mkIntent([X, Y, Z]) // plan projects 6 GiB usable
      await writeIntent('tank', intent, { dir })

      const outcome = await executeExpansion(
        executor,
        { pool: mkPool(), intent, plan: mkPlan([B1, B2], []) },
        () => {},
        { intentDir: dir, pollIntervalMs: 1, log: line => lines.push(line) },
      )
      assert.equal(outcome.ok, true, outcome.error)
      const info = notifyCalls(executor, 'info')
      assert.equal(info.length, 1)
      assert.match(info[0].args[4], /4 GiB → 5\.5 GiB/, 'the measured figure, not the planned 6 GiB')
      const complete = lines.find(l => l.includes('status=complete'))!
      assert.match(complete, /usable=4294967296->5905580032/)
      assert.match(complete, /capacity=measured/)
      assert.match(complete, /planned=6442450944/)
      assert.equal(await readIntent('tank', dir), null)
    })

    it('a material shortfall HALTS instead of completing — the intent survives', async () => {
      const executor = world()
      // Every step reported done, but the volume is still 2 GiB short of plan.
      executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson(4 * GIB), stderr: '', exitCode: 0 } })
      const intent = mkIntent([X, Y, Z])
      await writeIntent('tank', intent, { dir })

      const outcome = await run(executor, mkPlan([B1, B2], []), [X, Y, Z], intent)
      assert.equal(outcome.ok, false)
      assert.match(outcome.error!, /delivered 4 GiB .* projected 6 GiB — 2 GiB short/)
      assert.equal((await readIntent('tank', dir))?.state, 'halted')
      assert.equal(notifyCalls(executor, 'info').length, 0, 'completion is NOT declared')
      assert.equal(notifyCalls(executor, 'error').length, 1)
    })

    it('layout overhead (data offsets + LVM rounding) is NOT a shortfall', async () => {
      const executor = world()
      // 6 GiB planned, delivered short by the §2.6 data offsets + LVM slack.
      executor.addFixture({ command: '/usr/sbin/lvs', result: { stdout: lvsJson(6 * GIB - 200 * MIB), stderr: '', exitCode: 0 } })
      const intent = mkIntent([X, Y, Z])
      await writeIntent('tank', intent, { dir })
      const outcome = await run(executor, mkPlan([B1, B2], []), [X, Y, Z], intent)
      assert.equal(outcome.ok, true, outcome.error)
      assert.equal(await readIntent('tank', dir), null)
    })
  })

  describe('executeReplace (one-band member, live disk)', () => {
    it('runs the full sequence: partition → add → replace --with → wait → remove → residual plan → retire', async () => {
      const executor = world({ mdstat: [
        MDSTAT_BASE, // phase-2 resolve
        MDSTAT_REPLACE_RUNNING, // wait poll 1
        MDSTAT_REPLACE_DONE, // wait poll 2 → old faulty, idle
        MDSTAT_REPLACE_DONE, // post-wait re-resolve (old still listed (F) → --remove)
      ] })
      // Incoming disk N: bare at first, partitioned after sgdisk.
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${N}`), results: [
        { stdout: diskJson('sdv', SIZE_2G, []), stderr: '', exitCode: 0 },
        { stdout: diskJson('sdv', SIZE_2G, [{ name: 'sdv1', size: B1_CLAMPED_2G, label: 'tank-d4-b1' }]), stderr: '', exitCode: 0 },
      ] })
      const tree = { blockdevices: Object.values(DISK_PARTS).map(d => ({
        name: d.kernel,
        type: 'disk',
        size: d.size,
        children: d.parts.map(p => ({ name: p.name, type: 'part', size: p.size, partlabel: p.label })),
      })) }
      executor.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: JSON.stringify(tree), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: SGDISK, result: { stdout: '', stderr: '', exitCode: 0 } })

      // The REAL planner produces the residual plan (§2.3): a pure same-shape
      // swap → only the partition step for the incoming disk.
      const plan = planExpansion({
        poolName: 'tank',
        tier: 'ahr1',
        existingBands: [
          { band: 1, startBytes: 0, endBytes: 2 * GIB, level: 'raid5', members: [X, Y, Z] },
          { band: 2, startBytes: 2 * GIB, endBytes: 3 * GIB, level: 'raid1', members: [Y, Z] },
        ],
        approvedDisks: [{ id: N, usableBytes: SIZE_2G }, { id: Y, usableBytes: SIZE_3G }, { id: Z, usableBytes: SIZE_3G }],
        replaced: { oldDiskId: X, newDiskId: N },
      })
      assert.deepEqual(plan.steps.map(s => s.kind), ['partition'])

      const intent = mkIntent([N, Y, Z], { trigger: 'replace-disk', replacedDisk: X, replacementDisk: N })
      const outcome = await executeReplace(
        executor,
        { pool: mkPool(), intent, plan, oldDiskId: X, newDiskId: N },
        () => {},
        { intentDir: dir, pollIntervalMs: 1, log: () => {} },
      )
      assert.equal(outcome.ok, true, outcome.error)

      const muts = mutatingCalls(executor).map(c => [c.command, ...c.args])
      assert.deepEqual(muts, [
        // Exact size — N's raw leaves room past the rounded boundary; the
        // §2.5 slack stays unpartitioned (no clamp-to-end spill).
        [SGDISK, '-n', '1:1M:+2047M', '-t', '1:FD00', '-c', '1:tank-d4-b1', `/dev/disk/by-id/${N}`],
        [MDADM, '/dev/md127', '--add', `/dev/disk/by-id/${N}-part1`],
        [MDADM, '/dev/md127', '--replace', '/dev/sdq1', '--with', `/dev/disk/by-id/${N}-part1`],
        [MDADM, '/dev/md127', '--remove', '/dev/sdq1'],
        [MDADM, '--zero-superblock', `/dev/disk/by-id/${X}-part1`],
        [SGDISK, '--zap-all', `/dev/disk/by-id/${X}`],
      ])
      // Intent cleared by the residual executeExpansion completion.
      assert.equal(await readIntent('tank', dir), null)
    })
  })

  describe('projectExistingBands', () => {
    it('reconstructs exact boundaries from interior slices and clamped tops', async () => {
      const pool = mkPool()
      pool.disks = [
        { id: X, sizeBytes: SIZE_2G, usableBytes: 2 * GIB, model: null, serial: null, role: 'member', partitions: [{ device: `/dev/disk/by-id/${X}-part1`, band: 1, sizeBytes: B1_CLAMPED_2G }] },
        { id: Y, sizeBytes: SIZE_3G, usableBytes: 3 * GIB, model: null, serial: null, role: 'member', partitions: [
          { device: `/dev/disk/by-id/${Y}-part1`, band: 1, sizeBytes: B1_INTERIOR },
          { device: `/dev/disk/by-id/${Y}-part2`, band: 2, sizeBytes: B2_CLAMPED_3G },
        ] },
        { id: Z, sizeBytes: SIZE_3G, usableBytes: 3 * GIB, model: null, serial: null, role: 'member', partitions: [
          { device: `/dev/disk/by-id/${Z}-part1`, band: 1, sizeBytes: B1_INTERIOR },
          { device: `/dev/disk/by-id/${Z}-part2`, band: 2, sizeBytes: B2_CLAMPED_3G },
        ] },
      ]
      const bands = projectExistingBands(pool)
      assert.deepEqual(bands.map(b => [b.band, b.startBytes, b.endBytes, b.level]), [
        [1, 0, 2 * GIB, 'raid5'],
        [2, 2 * GIB, 3 * GIB, 'raid1'],
      ])
      assert.deepEqual(bands[0].members, [X, Y, Z])
      assert.deepEqual(bands[1].members, [Y, Z])
    })
  })
})

describe('executeReadd (11.9 — the returned-disk verb)', () => {
  // X's slice came back after a blip: mdstat lists sdq1 faulty, superblock
  // UUID still matches r1.
  const MDSTAT_X_FAULTY = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]

unused devices: <none>
`
  const MDSTAT_X_RECOVERED = MDSTAT_BASE

  function readdWorld(opts: { examUuid?: string, readdExit?: number, mdstats?: string[] } = {}): MockExecutor {
    const executor = world({ mdstat: opts.mdstats ?? [MDSTAT_X_FAULTY, MDSTAT_X_RECOVERED] })
    executor.addFixture({
      command: MDADM,
      args: ['--examine', '--export', `/dev/disk/by-id/${X}-part1`],
      result: { stdout: `MD_UUID=${opts.examUuid ?? R1_UUID}\nMD_NAME=anas-test:tank-r1\n`, stderr: '', exitCode: 0 },
    })
    executor.addFixture({
      command: MDADM,
      args: ['/dev/md127', '--re-add', `/dev/disk/by-id/${X}-part1`],
      result: { stdout: '', stderr: opts.readdExit ? 'mdadm: --re-add for /dev/disk/by-id/... rejected' : '', exitCode: opts.readdExit ?? 0 },
    })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } }) // --remove / fallback
    return executor
  }

  it('differential path: remove faulty slot → --re-add → wait → notify (exact argv)', async () => {
    const executor = readdWorld()
    const out = await executeReadd(executor, { pool: mkPool(), diskId: X }, () => {}, { pollIntervalMs: 1, log: () => {} })
    assert.deepEqual(out.bands, [{ band: 1, mode: 'differential' }])
    const mdadmCalls = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail' && c.args[0] !== '--examine')
    assert.deepEqual(mdadmCalls.map(c => c.args), [
      ['/dev/md127', '--remove', `/dev/disk/by-id/${X}-part1`],
      ['/dev/md127', '--re-add', `/dev/disk/by-id/${X}-part1`],
    ])
    const notify = executor.calls.filter(c => c.command === PERL).at(-1)!
    assert.equal(notify.args[2], 'info')
    assert.ok(String(notify.args[4]).includes('differential catch-up'))
  })

  it('fallback path: --re-add refused → --zero-superblock + --add (full rebuild)', async () => {
    const executor = readdWorld({ readdExit: 1 })
    const out = await executeReadd(executor, { pool: mkPool(), diskId: X }, () => {}, { pollIntervalMs: 1, log: () => {} })
    assert.deepEqual(out.bands, [{ band: 1, mode: 'full' }])
    const mdadmArgs = executor.calls.filter(c => c.command === MDADM).map(c => c.args)
    assert.ok(mdadmArgs.some(a => a[0] === '--zero-superblock' && a[1] === `/dev/disk/by-id/${X}-part1`))
    assert.ok(mdadmArgs.some(a => a[0] === '/dev/md127' && a[1] === '--add'))
    const notify = executor.calls.filter(c => c.command === PERL).at(-1)!
    assert.ok(String(notify.args[4]).includes('full rebuild'))
  })

  it('identity check: a lookalike slice with a foreign superblock UUID is REFUSED', async () => {
    const executor = readdWorld({ examUuid: 'ffffffff:ffffffff:ffffffff:ffffffff' })
    await assert.rejects(
      executeReadd(executor, { pool: mkPool(), diskId: X }, () => {}, { pollIntervalMs: 1, log: () => {} }),
      /does not match array/,
    )
    // No mutating mdadm command was issued.
    assert.ok(!executor.calls.some(c => c.command === MDADM && (c.args[1] === '--re-add' || c.args[1] === '--add')))
  })

  it('absent device is refused before any command', async () => {
    const executor = world()
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs('/dev/disk/by-id/ata-GONE'), result: { stdout: '', stderr: 'not a block device', exitCode: 32 } })
    await assert.rejects(
      executeReadd(executor, { pool: mkPool(), diskId: 'ata-GONE' }, () => {}, { pollIntervalMs: 1 }),
      /not present/,
    )
  })

  // Bug #4 (code review): a disk that dropped and returned WITHOUT a reboot
  // re-enumerates under a NEW kernel name, so the array's faulty slot still
  // names the OLD (now-absent) node. Matching on the returning disk's CURRENT
  // name misses it — the stale slot lingers, `--re-add` is refused, and the
  // differential catch-up silently degrades to a full rebuild. The stale slot
  // must be cleared by IDENTITY (detached), not by current name.
  it('reboot-less return under a NEW kernel name: clears the DETACHED slot, then --re-add', async () => {
    // md127 lists the OLD sdq1 faulty; X has come back as sdw (new name).
    const stale = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]

unused devices: <none>
`
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], results: [stale, MDSTAT_BASE].map(s => ({ stdout: s, stderr: '', exitCode: 0 })) })
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, R1_UUID), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, R2_UUID), stderr: '', exitCode: 0 } })
    // X returns under a NEW kernel name (sdw), same by-id, same band label.
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${X}`), result: { stdout: diskJson('sdw', SIZE_2G, [{ name: 'sdw1', size: B1_CLAMPED_2G, label: 'tank-d1-b1' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, args: ['--examine', '--export', `/dev/disk/by-id/${X}-part1`], result: { stdout: `MD_UUID=${R1_UUID}\n`, stderr: '', exitCode: 0 } })
    // The stale faulty device sdq1 is now ABSENT (X re-enumerated) → detached.
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/sdq1'], result: { stdout: '', stderr: 'No such file', exitCode: 1 } })
    executor.addFixture({ command: MDADM, args: ['/dev/md127', '--re-add', `/dev/disk/by-id/${X}-part1`], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })

    const out = await executeReadd(executor, { pool: mkPool(), diskId: X }, () => {}, { pollIntervalMs: 1, log: () => {} })
    assert.deepEqual(out.bands, [{ band: 1, mode: 'differential' }], 'differential path taken, NOT a silent full rebuild')
    const mdadmCalls = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail' && c.args[0] !== '--examine')
    assert.deepEqual(mdadmCalls.map(c => c.args), [
      ['/dev/md127', '--remove', 'detached'], // stale slot cleared by identity
      ['/dev/md127', '--re-add', `/dev/disk/by-id/${X}-part1`],
    ])
  })

  // nvme partition-suffix guard: an nvme disk's partitions are `nvme0n1p1`
  // (a `p` separator), NEVER `nvme0n11`. The stunt node is all sdX, so an
  // nvme partition-naming regression is invisible to live-proof — pve14
  // (production) has nvme disks. This locks the whole operational chain:
  // PART_NUMBER_RE must extract `1` from `nvme0n1p1` (not `11`/`01`), the md
  // member match must line up the p-separated kernel name, and every device
  // handed to mdadm must go through the by-id `-part1` symlink (which udev
  // creates uniformly for nvme AND sdX), never a `disk + '1'` concatenation.
  it('nvme member: --re-add rides the by-id -part1 link, never a p-concat', async () => {
    const NVME = 'nvme-SAMSUNG_MZVL2_TANK_X'
    // md127 (r1) lists the returned nvme slice `nvme0n1p1` faulty by its
    // p-separated kernel name; superblock UUID still matches r1.
    const nvmeFaulty = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] nvme0n1p1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]

unused devices: <none>
`
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], results: [nvmeFaulty, MDSTAT_BASE].map(s => ({ stdout: s, stderr: '', exitCode: 0 })) })
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, R1_UUID), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, R2_UUID), stderr: '', exitCode: 0 } })
    // The returned disk is nvme: whole disk `nvme0n1`, partition `nvme0n1p1`.
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${NVME}`), result: { stdout: diskJson('nvme0n1', SIZE_2G, [{ name: 'nvme0n1p1', size: B1_CLAMPED_2G, label: 'tank-d1-b1' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, args: ['--examine', '--export', `/dev/disk/by-id/${NVME}-part1`], result: { stdout: `MD_UUID=${R1_UUID}\n`, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, args: ['/dev/md127', '--re-add', `/dev/disk/by-id/${NVME}-part1`], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })

    const out = await executeReadd(executor, { pool: mkPool(), diskId: NVME }, () => {}, { pollIntervalMs: 1, log: () => {} })
    assert.deepEqual(out.bands, [{ band: 1, mode: 'differential' }])
    const mdadmCalls = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail' && c.args[0] !== '--examine')
    // partNumber 1 correctly extracted from `nvme0n1p1`; both the same-name
    // faulty-slot removal and the --re-add use the by-id `-part1` link.
    assert.deepEqual(mdadmCalls.map(c => c.args), [
      ['/dev/md127', '--remove', `/dev/disk/by-id/${NVME}-part1`],
      ['/dev/md127', '--re-add', `/dev/disk/by-id/${NVME}-part1`],
    ])
    // Belt-and-braces: nothing referenced a p-concatenated whole-disk path.
    assert.ok(!executor.calls.some(c => c.args.some(a => typeof a === 'string' && a.includes('nvme0n11'))))
  })
})
