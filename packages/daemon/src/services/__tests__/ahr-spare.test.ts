import type { AhrCapacity, AhrDisk, AhrPool, AhrPreviewBand, ArrayLevel } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { diskLsblkArgs, executeExpansion } from '../ahr-expand-exec.js'
import { attachSpare, poolPreviewBands, removeSpare, spareCoverage, spareCoverageWarnings, spareShortfallMessage } from '../ahr-spare.js'

/**
 * AHR hot spares (story 11.11, AHR-DESIGN §11) — the same synthetic
 * GiB-aligned "tank" world as ahr-expand-exec.test.ts:
 *   band 1 [0,2GiB]  raid5×3 (md127: X,Y,Z)   band 2 [2GiB,3GiB] raid1×2 (md126: Y,Z)
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X' // 2 GiB class → sdq
const Y = 'ata-TANK_Y' // 3 GiB class → sdr
const Z = 'ata-TANK_Z' // 3 GiB class → sds
const P = 'ata-TANK_P' // 3 GiB class → sdp (the incoming spare)
const SP = 'ata-TANK_SP' // 4 GiB class → sdv (an attached spare, coupling tests)

const SIZE_2G = 2 * GIB + 8 * MIB
const SIZE_3G = 3 * GIB + 8 * MIB
const SIZE_4G = 4 * GIB + 8 * MIB
const GPT_TAIL = 33 * 512

const B1_INTERIOR = 2 * GIB - MIB
const B1_CLAMPED_2G = SIZE_2G - MIB - GPT_TAIL
const B2_CLAMPED_3G = SIZE_3G - GPT_TAIL - 2 * GIB
const B2_INTERIOR = GIB
const B3_INTERIOR = GIB

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

// X's band-1 slice faulted out of md127 (device may be present or yanked).
const MDSTAT_FAULTY = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0](F)
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]

unused devices: <none>
`

// The spare SP attached to both bands as (S) members.
const MDSTAT_WITH_SPARE = `Personalities : [raid1] [raid5]
md126 : active raid1 sdv2[2](S) sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sdv1[3](S) sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

const MDSTAT_WITH_R3 = `Personalities : [raid1] [raid5]
md125 : active raid1 sdu3[1] sdt3[0]
      1047552 blocks super 1.2 [2/2] [UU]

${MDSTAT_BASE.split('\n').slice(1).join('\n')}`

function exportFor(name: string, level: string, devices: number, uuid: string): string {
  return `MD_LEVEL=${level}\nMD_DEVICES=${devices}\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_DEVNAME=${name}\nMD_NAME=anas-test:${name}\n`
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

const CAT = '/usr/bin/cat'
const LSBLK = '/usr/bin/lsblk'
const MDADM = '/usr/sbin/mdadm'
const SGDISK = '/usr/sbin/sgdisk'
const WIPEFS = '/usr/sbin/wipefs'
const REALPATH = '/usr/bin/realpath'
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

function world(opts: { mdstat?: string | string[] } = {}): MockExecutor {
  const executor = new MockExecutor()
  const mdstat = opts.mdstat ?? MDSTAT_BASE
  if (Array.isArray(mdstat))
    executor.addFixture({ command: CAT, args: [...MDSTAT_CAT_ARGS], results: mdstat.map(s => ({ stdout: s, stderr: '', exitCode: 0 })) })
  else
    executor.addFixture({ command: CAT, args: [...MDSTAT_CAT_ARGS], result: { stdout: mdstat, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, R1_UUID), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, R2_UUID), stderr: '', exitCode: 0 } })
  for (const [id, d] of Object.entries(DISK_PARTS))
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${id}`), result: { stdout: diskJson(d.kernel, d.size, d.parts), stderr: '', exitCode: 0 } })
  // Pool-wide label scan (a fresh disk gets max(d)+1).
  const tree = { blockdevices: Object.values(DISK_PARTS).map(d => ({
    name: d.kernel,
    type: 'disk',
    size: d.size,
    children: d.parts.map(p => ({ name: p.name, type: 'part', size: p.size, partlabel: p.label })),
  })) }
  executor.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL'], result: { stdout: JSON.stringify(tree), stderr: '', exitCode: 0 } })
  // Wipe/partition/notify plumbing succeeds quietly.
  executor.addFixture({ command: WIPEFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: SGDISK, result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/udevadm', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

function mkDisk(id: string, sizeBytes: number, role: AhrDisk['role'], partitions: { band: number, sizeBytes: number, part: number }[]): AhrDisk {
  return {
    id,
    sizeBytes,
    usableBytes: Math.floor(sizeBytes / GIB) * GIB,
    model: null,
    serial: null,
    role,
    partitions: partitions.map(p => ({
      device: `/dev/disk/by-id/${id}-part${p.part}` as AhrDisk['partitions'][number]['device'],
      band: p.band,
      sizeBytes: p.sizeBytes,
    })),
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

function mkPool(opts: { spare?: AhrDisk } = {}): AhrPool {
  const member = (disk: string, part: string, state: 'in_sync' | 'spare' = 'in_sync') =>
    ({ disk, partition: `/dev/disk/by-id/${disk}-part${part}` as const, memberState: state })
  const disks: AhrDisk[] = [
    mkDisk(X, SIZE_2G, 'member', [{ band: 1, sizeBytes: B1_CLAMPED_2G, part: 1 }]),
    mkDisk(Y, SIZE_3G, 'member', [{ band: 1, sizeBytes: B1_INTERIOR, part: 1 }, { band: 2, sizeBytes: B2_CLAMPED_3G, part: 2 }]),
    mkDisk(Z, SIZE_3G, 'member', [{ band: 1, sizeBytes: B1_INTERIOR, part: 1 }, { band: 2, sizeBytes: B2_CLAMPED_3G, part: 2 }]),
  ]
  if (opts.spare)
    disks.push(opts.spare)
  return {
    name: 'tank',
    ahrType: 'ahr1',
    mountpoint: '/mnt/anas-ahr/tank',
    mounted: true,
    disks,
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

describe('spareCoverage (§11 full-coverage rule)', () => {
  it('accepts an exact fit: rounded usable == the top array boundary', () => {
    const c = spareCoverage(3 * GIB, SIZE_3G) // 3 GiB + slack rounds down to exactly 3 GiB
    assert.equal(c.ok, true)
    assert.equal(c.usableBytes, 3 * GIB)
    assert.equal(c.shortfallBytes, 0)
  })

  it('refuses a short disk and states the EXACT shortfall', () => {
    const c = spareCoverage(3 * GIB, SIZE_2G) // rounds to 2 GiB → 1 GiB short
    assert.equal(c.ok, false)
    assert.equal(c.shortfallBytes, GIB)
    const msg = spareShortfallMessage(P, c)
    assert.match(msg, /1 GiB short/)
    assert.match(msg, /3 GiB, the pool's top array boundary/)
    assert.match(msg, /partial spare/i)
  })

  it('rounding applies BEFORE the comparison (§2.5): a nominal-fit disk with sub-GiB slack still passes', () => {
    // 3 GiB + 8 MiB rounds DOWN to 3 GiB — the 8 MiB never counts.
    assert.equal(spareCoverage(3 * GIB, 3 * GIB + 8 * MIB).ok, true)
    // 3 GiB - 1 byte rounds down to 2 GiB — refused.
    assert.equal(spareCoverage(3 * GIB, 3 * GIB - 1).ok, false)
  })
})

describe('spareCoverageWarnings (§11 expansion coupling — plan warnings)', () => {
  const bands = [pband(1, 0, 2 * GIB, 3, 'raid5'), pband(2, 2 * GIB, 3 * GIB, 2, 'raid1'), pband(3, 3 * GIB, 4 * GIB, 2, 'raid1')]

  it('names the gap for a spare that cannot cover the new top band', () => {
    const warnings = spareCoverageWarnings([{ id: SP, usableBytes: 3 * GIB }], bands)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], new RegExp(SP))
    assert.match(warnings[0], /cannot cover the new top band/)
    assert.match(warnings[0], /needs 4 GiB but has 3 GiB usable \(1 GiB short\)/)
    assert.match(warnings[0], /keeps covering the existing bands up to 3 GiB/)
  })

  it('is silent when every spare covers (and when there are no spares)', () => {
    assert.deepEqual(spareCoverageWarnings([{ id: SP, usableBytes: 4 * GIB }], bands), [])
    assert.deepEqual(spareCoverageWarnings([], bands), [])
  })
})

describe('attachSpare (§11)', () => {
  const noop = (): void => {}

  it('wipes, partitions the full band geometry, ghost-clears, then --add-spare per band', async () => {
    const executor = world()
    // The incoming disk: blank first (partition planning), carved afterwards.
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${P}`), results: [
      { stdout: diskJson('sdp', SIZE_3G, []), stderr: '', exitCode: 0 },
      { stdout: diskJson('sdp', SIZE_3G, [
        { name: 'sdp1', size: B1_INTERIOR, label: 'tank-d4-b1' },
        { name: 'sdp2', size: B2_INTERIOR, label: 'tank-d4-b2' },
      ]), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await attachSpare(executor, { pool: mkPool(), diskId: P, diskSizeBytes: SIZE_3G }, noop, { log: () => {} })
    assert.deepEqual(result, { attached: P, bands: [1, 2] })

    // Wipe: whole-disk wipefs + GPT zap, in order, before any sgdisk -n.
    const wipefs = executor.calls.filter(c => c.command === WIPEFS)
    assert.deepEqual(wipefs[0].args, ['-a', `/dev/disk/by-id/${P}`])
    const sgdisk = executor.calls.filter(c => c.command === SGDISK)
    assert.deepEqual(sgdisk[0].args, ['--zap-all', `/dev/disk/by-id/${P}`])
    // The FULL band-slice geometry (§2.6 path, labels d4, FD00).
    assert.deepEqual(sgdisk[1].args, [
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
      `/dev/disk/by-id/${P}`,
    ])
    // Ghost-superblock clearing pass hit both new slices.
    const partWipes = wipefs.slice(1).map(c => c.args[1])
    assert.deepEqual(partWipes, [`/dev/disk/by-id/${P}-part1`, `/dev/disk/by-id/${P}-part2`])
    // One --add-spare per band array, bands ascending.
    const addSpare = executor.calls.filter(c => c.command === MDADM && c.args.includes('--add-spare'))
    assert.deepEqual(addSpare.map(c => c.args), [
      ['/dev/md127', '--add-spare', `/dev/disk/by-id/${P}-part1`],
      ['/dev/md126', '--add-spare', `/dev/disk/by-id/${P}-part2`],
    ])
  })

  it('REFUSES a partial spare with the exact shortfall — before any destructive action', async () => {
    const executor = world()
    await assert.rejects(
      attachSpare(executor, { pool: mkPool(), diskId: P, diskSizeBytes: SIZE_2G }, noop, { log: () => {} }),
      (err: Error) => /1 GiB short/.test(err.message) && /partial spare/i.test(err.message),
    )
    assert.ok(!executor.calls.some(c => c.command === WIPEFS || c.command === SGDISK), 'refused before touching anything')
  })

  it('slot hygiene: --remove detached on an array whose faulty slot device is ABSENT', async () => {
    const executor = world({ mdstat: MDSTAT_FAULTY })
    // The faulty member's device node is GONE (disk yanked).
    executor.addFixture({ command: REALPATH, args: ['/dev/sdq1'], result: { stdout: '', stderr: 'No such file', exitCode: 1 } })
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${P}`), results: [
      { stdout: diskJson('sdp', SIZE_3G, []), stderr: '', exitCode: 0 },
      { stdout: diskJson('sdp', SIZE_3G, [
        { name: 'sdp1', size: B1_INTERIOR, label: 'tank-d4-b1' },
        { name: 'sdp2', size: B2_INTERIOR, label: 'tank-d4-b2' },
      ]), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })

    await attachSpare(executor, { pool: mkPool(), diskId: P, diskSizeBytes: SIZE_3G }, noop, { log: () => {} })
    const removes = executor.calls.filter(c => c.command === MDADM && c.args.includes('--remove'))
    assert.deepEqual(removes.map(c => c.args), [['/dev/md127', '--remove', 'detached']])
    // Hygiene ran BEFORE the wipe of the incoming disk.
    const removeIdx = executor.calls.findIndex(c => c.command === MDADM && c.args.includes('--remove'))
    const wipeIdx = executor.calls.findIndex(c => c.command === WIPEFS)
    assert.ok(removeIdx < wipeIdx)
  })

  it('slot hygiene leaves a faulty-but-PRESENT disk untouched (Re-add/Replace territory)', async () => {
    const executor = world({ mdstat: MDSTAT_FAULTY })
    // The faulty member's device is still attached.
    executor.addFixture({ command: REALPATH, args: ['/dev/sdq1'], result: { stdout: '/dev/sdq1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${P}`), results: [
      { stdout: diskJson('sdp', SIZE_3G, []), stderr: '', exitCode: 0 },
      { stdout: diskJson('sdp', SIZE_3G, [
        { name: 'sdp1', size: B1_INTERIOR, label: 'tank-d4-b1' },
        { name: 'sdp2', size: B2_INTERIOR, label: 'tank-d4-b2' },
      ]), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })

    await attachSpare(executor, { pool: mkPool(), diskId: P, diskSizeBytes: SIZE_3G }, noop, { log: () => {} })
    assert.ok(
      !executor.calls.some(c => c.command === MDADM && c.args.includes('--remove')),
      'no --remove of any kind when the faulty device is present',
    )
  })
})

describe('removeSpare (§11)', () => {
  const noop = (): void => {}
  const spareDisk = mkDisk(SP, SIZE_3G, 'spare', [
    { band: 1, sizeBytes: B1_INTERIOR, part: 1 },
    { band: 2, sizeBytes: B2_INTERIOR, part: 2 },
  ])

  function spareWorld(): MockExecutor {
    const executor = world({ mdstat: MDSTAT_WITH_SPARE })
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${SP}`), result: { stdout: diskJson('sdv', SIZE_3G, [
      { name: 'sdv1', size: B1_INTERIOR, label: 'tank-d4-b1' },
      { name: 'sdv2', size: B2_INTERIOR, label: 'tank-d4-b2' },
    ]), stderr: '', exitCode: 0 } })
    return executor
  }

  it('removes every slice, zeroes superblocks, zaps the disk', async () => {
    const executor = spareWorld()
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    const result = await removeSpare(executor, { pool: mkPool({ spare: spareDisk }), diskId: SP }, noop, { log: () => {} })
    assert.deepEqual(result, { removed: SP })
    const md = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail')
    assert.deepEqual(md.map(c => c.args), [
      ['/dev/md127', '--remove', `/dev/disk/by-id/${SP}-part1`],
      ['/dev/md126', '--remove', `/dev/disk/by-id/${SP}-part2`],
      ['--zero-superblock', `/dev/disk/by-id/${SP}-part1`],
      ['--zero-superblock', `/dev/disk/by-id/${SP}-part2`],
    ])
    const zap = executor.calls.filter(c => c.command === SGDISK)
    assert.deepEqual(zap.map(c => c.args), [['--zap-all', `/dev/disk/by-id/${SP}`]])
  })

  it('falls back to --fail then --remove when md refuses the plain remove', async () => {
    const executor = spareWorld()
    executor.addFixture({ command: MDADM, args: ['/dev/md127', '--remove', `/dev/disk/by-id/${SP}-part1`], results: [
      { stdout: '', stderr: 'mdadm: hot remove failed', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    await removeSpare(executor, { pool: mkPool({ spare: spareDisk }), diskId: SP }, noop, { log: () => {} })
    const md = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail').map(c => c.args)
    assert.deepEqual(md.slice(0, 3), [
      ['/dev/md127', '--remove', `/dev/disk/by-id/${SP}-part1`],
      ['/dev/md127', '--fail', `/dev/disk/by-id/${SP}-part1`],
      ['/dev/md127', '--remove', `/dev/disk/by-id/${SP}-part1`],
    ])
  })

  it('clears stale (S) slots with --remove detached when the spare device itself is absent', async () => {
    const executor = world({ mdstat: MDSTAT_WITH_SPARE })
    // No lsblk fixture for SP → readDiskTree returns null (device gone).
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${SP}`), result: { stdout: '', stderr: 'not a block device', exitCode: 32 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    const pool = mkPool({ spare: spareDisk })
    // Topology saw the spare slices as (S) members of both arrays.
    pool.arrays[0].members.push({ disk: SP, partition: `/dev/disk/by-id/${SP}-part1`, memberState: 'spare' })
    pool.arrays[1].members.push({ disk: SP, partition: `/dev/disk/by-id/${SP}-part2`, memberState: 'spare' })
    await removeSpare(executor, { pool, diskId: SP }, noop, { log: () => {} })
    const md = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail').map(c => c.args)
    assert.deepEqual(md, [
      ['/dev/md127', '--remove', 'detached'],
      ['/dev/md126', '--remove', 'detached'],
    ])
    assert.ok(!executor.calls.some(c => c.command === SGDISK), 'nothing to zap on an absent device')
  })
})

describe('expansion coupling (§11 — array-create extends every covering spare)', () => {
  const spareDisk4G = mkDisk(SP, SIZE_4G, 'spare', [
    { band: 1, sizeBytes: B1_INTERIOR, part: 1 },
    { band: 2, sizeBytes: B2_INTERIOR, part: 2 },
  ])

  const B1 = pband(1, 0, 2 * GIB, 3, 'raid5')
  const B2 = pband(2, 2 * GIB, 3 * GIB, 2, 'raid1')
  const B3 = pband(3, 3 * GIB, 4 * GIB, 2, 'raid1')

  function mkPlan() {
    return {
      steps: [{ index: 0, kind: 'array-create' as const, target: 'md/tank-r3', status: 'pending' as const }],
      preview: { bands: [B1, B2, B3], capacity: CAP, warnings: [], minDisksMet: true },
    }
  }

  function mkIntent() {
    return {
      id: randomUUID(),
      trigger: 'add-disk' as const,
      approvedDisks: [X, Y, Z, 'ata-TANK_W', 'ata-TANK_V'],
      before: CAP,
      after: { ...CAP, usableBytes: 6 * GIB },
      state: 'running' as const,
    }
  }

  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-spare-exec-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function withNewBandWorld(opts: { mdstat: string | string[] }): MockExecutor {
    const executor = world({ mdstat: opts.mdstat })
    const parts4 = (kernel: string, d: number): PartSpec[] => [
      { name: `${kernel}1`, size: B1_INTERIOR, label: `tank-d${d}-b1` },
      { name: `${kernel}2`, size: B2_INTERIOR, label: `tank-d${d}-b2` },
      { name: `${kernel}3`, size: B3_INTERIOR, label: `tank-d${d}-b3` },
    ]
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs('/dev/disk/by-id/ata-TANK_W'), result: { stdout: diskJson('sdt', SIZE_4G, parts4('sdt', 5)), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs('/dev/disk/by-id/ata-TANK_V'), result: { stdout: diskJson('sdu', SIZE_4G, parts4('sdu', 6)), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md125'], result: { stdout: exportFor('tank-r3', 'raid1', 2, R3_UUID), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/update-initramfs', result: { stdout: '', stderr: '', exitCode: 0 } })
    // The attached spare: bands 1+2 carved, band 3 missing → carved on demand.
    executor.addFixture({ command: LSBLK, args: diskLsblkArgs(`/dev/disk/by-id/${SP}`), results: [
      { stdout: diskJson('sdv', SIZE_4G, [
        { name: 'sdv1', size: B1_INTERIOR, label: 'tank-d4-b1' },
        { name: 'sdv2', size: B2_INTERIOR, label: 'tank-d4-b2' },
      ]), stderr: '', exitCode: 0 },
      { stdout: diskJson('sdv', SIZE_4G, [
        { name: 'sdv1', size: B1_INTERIOR, label: 'tank-d4-b1' },
        { name: 'sdv2', size: B2_INTERIOR, label: 'tank-d4-b2' },
        { name: 'sdv3', size: B3_INTERIOR, label: 'tank-d4-b3' },
      ]), stderr: '', exitCode: 0 },
    ] })
    return executor
  }

  it('creating a new band partitions the spare slice and --add-spare-s it', async () => {
    process.env.ANAS_MDADM_CONF = join(dir, 'mdadm.conf')
    const executor = withNewBandWorld({ mdstat: [MDSTAT_BASE, MDSTAT_WITH_R3] })
    const pool = mkPool({ spare: spareDisk4G })
    const outcome = await executeExpansion(
      executor,
      { pool, intent: mkIntent(), plan: mkPlan() },
      () => {},
      { intentDir: dir, pollIntervalMs: 1, log: () => {} },
    )
    delete process.env.ANAS_MDADM_CONF
    assert.equal(outcome.ok, true, outcome.error)
    // The new band's array was created…
    assert.ok(executor.calls.some(c => c.command === MDADM && c.args[0] === '--create'))
    // …the spare's band-3 slice was carved (label d4-b3)…
    const sgdisk = executor.calls.filter(c => c.command === SGDISK && c.args.includes('-n'))
    assert.equal(sgdisk.length, 1)
    assert.deepEqual(sgdisk[0].args, [
      '-n',
      '3:3072M:+1024M',
      '-t',
      '3:FD00',
      '-c',
      '3:tank-d4-b3',
      `/dev/disk/by-id/${SP}`,
    ])
    // …and attached as a spare to the NEW array.
    const addSpare = executor.calls.filter(c => c.command === MDADM && c.args.includes('--add-spare'))
    assert.deepEqual(addSpare.map(c => c.args), [['/dev/md125', '--add-spare', `/dev/disk/by-id/${SP}-part3`]])
  })

  it('the already-created resume path still extends the spare (never skipped)', async () => {
    const executor = withNewBandWorld({ mdstat: MDSTAT_WITH_R3 })
    const pool = mkPool({ spare: spareDisk4G })
    const outcome = await executeExpansion(
      executor,
      { pool, intent: mkIntent(), plan: mkPlan() },
      () => {},
      { intentDir: dir, pollIntervalMs: 1, log: () => {} },
    )
    assert.equal(outcome.ok, true, outcome.error)
    assert.ok(!executor.calls.some(c => c.command === MDADM && c.args[0] === '--create'), 'array already exists')
    const addSpare = executor.calls.filter(c => c.command === MDADM && c.args.includes('--add-spare'))
    assert.deepEqual(addSpare.map(c => c.args), [['/dev/md125', '--add-spare', `/dev/disk/by-id/${SP}-part3`]])
  })

  it('a spare too short for the new band is left alone (plan already warned)', async () => {
    const spare3G = mkDisk(SP, SIZE_3G, 'spare', [
      { band: 1, sizeBytes: B1_INTERIOR, part: 1 },
      { band: 2, sizeBytes: B2_INTERIOR, part: 2 },
    ])
    const executor = withNewBandWorld({ mdstat: MDSTAT_WITH_R3 })
    const outcome = await executeExpansion(
      executor,
      { pool: mkPool({ spare: spare3G }), intent: mkIntent(), plan: mkPlan() },
      () => {},
      { intentDir: dir, pollIntervalMs: 1, log: () => {} },
    )
    assert.equal(outcome.ok, true, outcome.error)
    assert.ok(!executor.calls.some(c => c.command === MDADM && c.args.includes('--add-spare')))
    assert.ok(!executor.calls.some(c => c.command === SGDISK && c.args.includes('-n')))
  })
})

describe('poolPreviewBands', () => {
  it('projects the live pool into the shared partitioning geometry', () => {
    const bands = poolPreviewBands(mkPool())
    assert.deepEqual(bands.map(b => [b.band, b.range.startBytes, b.range.endBytes, b.level, b.protected]), [
      [1, 0, 2 * GIB, 'raid5', true],
      [2, 2 * GIB, 3 * GIB, 'raid1', true],
    ])
  })
})
