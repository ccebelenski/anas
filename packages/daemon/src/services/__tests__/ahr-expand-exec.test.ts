import type { AhrCapacity, AhrExpansionIntent, AhrExpansionStep, AhrPool, AhrPreviewBand, ArrayLevel } from '@anas/shared'
import type { AhrExpansionPlan } from '../ahr-layout.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { diskLsblkArgs, executeExpansion, executeReplace, projectExistingBands } from '../ahr-expand-exec.js'
import { readIntent } from '../ahr-intent.js'
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
    disks: [],
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
      executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${W}`), result: { stdout: diskJson('sdt', SIZE_4G, []), stderr: '', exitCode: 0 } })
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
        '--data-offset=8192s', // 4 MiB for a sub-512GiB member (GT-5 policy)
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
    const pvsJson = (rows: { name: string, vg: string | null, size: number }[]) =>
      JSON.stringify({ report: [{ pv: rows.map(r => ({ pv_name: r.name, vg_name: r.vg ?? '', pv_size: String(r.size), pv_free: '0' })) }] })
    const vgsJson = (free: number) =>
      JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(5 * GIB), vg_free: String(free) }] }] })
    const lvsJson = (size: number) =>
      JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(size) }] }] })
    const R1_BYTES = 4190208 * 1024

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
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/pvcreate', '/dev/md125']])
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
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/vgextend', 'tank', '/dev/md125']])
    })

    it('lv-extend consumes free space; skips when nothing is free', async () => {
      // Free space present → extend.
      let executor = world()
      executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: vgsJson(GIB), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/lvextend', result: { stdout: '', stderr: '', exitCode: 0 } })
      let outcome = await run(executor, mkPlan([B1, B2], [{ kind: 'lv-extend', target: 'tank-vol' }]), [X, Y, Z])
      assert.equal(outcome.ok, true, outcome.error)
      assert.deepEqual(mutatingCalls(executor).map(c => [c.command, ...c.args]), [['/usr/sbin/lvextend', '-l', '+100%FREE', '/dev/tank/tank-vol']])
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
        [SGDISK, '-n', '1:1M:0', '-t', '1:FD00', '-c', '1:tank-d4-b1', `/dev/disk/by-id/${N}`],
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
