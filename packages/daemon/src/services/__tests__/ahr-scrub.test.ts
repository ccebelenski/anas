import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AhrPool, AhrScrubResult } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import {
  AHR_SCRUB_FINDINGS_CAP,
  AHR_SCRUB_JOURNAL_LINE_CAP,
  attributeScrubErrors,
  btrfsScrubPass,
  correctedReadsFromMessages,
  countErrorSummary,
  findingPath,
  journalSince,
  kernelJournalMessages,
  metadataCorrectedSentence,
  mismatchCount,
  parseBtrfsScrubStatus,
  parseCorrectedRead,
  parseScrubWarning,
  parseUnattributedScrubError,
  runningAhrCheck,
  scrubAhrPool,
} from '../ahr-scrub.js'
import { mismatchCntArgs } from '../scrub-schedules.js'
import { forgetIssuedChecks, hasIssuedCheck, ownsSyncOp } from '../selfheal-syncop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')

/** The drill's verbatim kernel captures (GT-3 / GT-6) — see fixtures/ahr/NOTES.md. */
const GT3_DMESG = readFileSync(join(fixturesDir, 'scrub-dmesg-gt3.txt'), 'utf-8')
const GT6_DMESG = readFileSync(join(fixturesDir, 'scrub-dmesg-gt6.txt'), 'utf-8')
const GT3_LINES = GT3_DMESG.split('\n').filter(l => l.trim() !== '')
const GT6_LINES = GT6_DMESG.split('\n').filter(l => l.trim() !== '')

/**
 * AHR scrub — ONE scrub, TWO phases, strictly SEQUENTIAL (selfheal.4, §4):
 * each band's md parity check first (one band at a time), then the btrfs
 * checksum scrub and its attribution. Findings notify at warning; a clean
 * scrub is silent (§7.3).
 */

const GIB = 1024 ** 3
const SMALL = 'ata-ANAS_SMALL_2G'
const BIG = 'ata-ANAS_BIG_3G'
const MOUNTPOINT = '/mnt/test-ahr/t2'

function pool(mountpoint = MOUNTPOINT): AhrPool {
  const member = (disk: string, part: number) =>
    ({ disk, partition: `/dev/disk/by-id/${disk}-part${part}`, memberState: 'in_sync' as const })
  return AhrPool.parse({
    name: 't2',
    ahrType: 'ahr1',
    mountpoint,
    mounted: !mountpoint.startsWith('/dev/'),
    disks: [
      { id: SMALL, sizeBytes: 2 * GIB, usableBytes: 2 * GIB, model: null, serial: null, role: 'member', partitions: [{ device: `/dev/disk/by-id/${SMALL}-part1`, band: 1, sizeBytes: GIB }] },
      { id: BIG, sizeBytes: 3 * GIB, usableBytes: 3 * GIB, model: null, serial: null, role: 'member', partitions: [{ device: `/dev/disk/by-id/${BIG}-part1`, band: 1, sizeBytes: GIB }] },
    ],
    arrays: [
      { device: '/dev/md/t2-r1', band: 1, level: 'raid1', heightBytes: GIB, members: [member(SMALL, 1), member(BIG, 1)], state: 'clean' },
      { device: '/dev/md/t2-r2', band: 2, level: 'raid1', heightBytes: GIB, members: [member(SMALL, 2), member(BIG, 2)], state: 'clean' },
    ],
    vg: { name: 't2', sizeBytes: 2 * GIB, freeBytes: 0 },
    lv: { name: 't2-vol', sizeBytes: 2 * GIB },
    capacity: { rawBytes: 5 * GIB, usableBytes: 2 * GIB, usedBytes: 0, freeBytes: 2 * GIB, redundancyOverheadBytes: 2 * GIB, unprotectedWastedBytes: GIB, pendingBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
  })
}

function scrubStatus(status: string, opts?: { percent?: string, summary?: string }): string {
  return [
    'UUID:             11111111-2222-3333-4444-555555555555',
    'Scrub started:    Wed Jul 23 10:00:00 2026',
    `Status:           ${status}`,
    'Duration:         0:00:04',
    ...(opts?.percent ? [`Bytes scrubbed:   721.09MiB  (${opts.percent}%)`] : ['Total to scrub:   6.66GiB']),
    `Error summary:    ${opts?.summary ?? 'no errors found'}`,
    '',
  ].join('\n')
}

function mdstat(entries: { kernel: string, checkPercent?: number }[]): string {
  const lines = ['Personalities : [raid1] ']
  for (const e of entries) {
    lines.push(`${e.kernel} : active raid1 sdd1[1] sdc1[0]`)
    lines.push('      1044992 blocks super 1.2 [2/2] [UU]')
    if (e.checkPercent !== undefined)
      lines.push(`      [====>.............]  check = ${e.checkPercent.toFixed(1)}% (52224/1044992) finish=0.8min speed=20472K/sec`)
    lines.push('      ')
  }
  lines.push('unused devices: <none>', '')
  return lines.join('\n')
}

function baseExecutor(): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r1'], result: { stdout: '/dev/md127\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r2'], result: { stdout: '/dev/md126\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  // Catch-all cat: an idle mdstat (so a test that never scripts /proc/mdstat
  // still terminates) — and, falling through, the phase-1 mismatch_cnt reads,
  // whose non-numeric text reads as "no counter" (no parity-mismatch warning).
  // Tests that script mdstat transitions or rot register exact-arg fixtures,
  // which beat the catch-all.
  executor.addFixture({ command: '/usr/bin/cat', result: { stdout: mdstat([]), stderr: '', exitCode: 0 } })
  return executor
}

/**
 * A READABLE `mismatch_cnt` of 0 for the named bands — the ordinary "checked,
 * and it came back clean" case.
 *
 * The catch-all `cat` above answers mdstat text for every unscripted sysfs
 * read, which `mismatchCount` reads as "no counter". Since the sixth pass a
 * band whose counter cannot be READ is not coverage (N12): the check ran but
 * nothing came back from it, so the band has no verdict and lands in
 * `bandsSkipped`. A test that means "this band was checked and is clean" has
 * to say so with a number. First-match-wins, so this is registered only where
 * the test has not scripted that band's counter itself.
 */
function cleanCounters(executor: MockExecutor, ...kernels: string[]): MockExecutor {
  for (const kernel of kernels)
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs(kernel), result: { stdout: '0\n', stderr: '', exitCode: 0 } })
  return executor
}

const selfhealFixturesDir = join(__dirname, '../../fixtures/selfheal')

/** One of the self-heal engine's captured rig fixtures. */
function selfhealFixture(name: string): string {
  return readFileSync(join(selfhealFixturesDir, name), 'utf-8')
}

/**
 * The rig's md geometry as REAL files in a temp tree — the engine's sysfs reads
 * go through node:fs with `ANAS_SELFHEAL_KERNEL_ROOT` as the prefix
 * (selfheal-io), and `resolveContext` needs a geometry to finish.
 */
let kernelRoot: string | null = null
const realKernelRoot = process.env.ANAS_SELFHEAL_KERNEL_ROOT
const realRuntimeDir = process.env.ANAS_SELFHEAL_RUNTIME_DIR

after(() => {
  process.env.ANAS_SELFHEAL_KERNEL_ROOT = realKernelRoot
  process.env.ANAS_SELFHEAL_RUNTIME_DIR = realRuntimeDir
  if (kernelRoot)
    rmSync(kernelRoot, { recursive: true, force: true })
})

function useKernelRoot(): void {
  if (kernelRoot)
    return
  kernelRoot = mkdtempSync(join(tmpdir(), 'anas-scrub-map-'))
  const sys = join(kernelRoot, 'sys/block/md127/md')
  mkdirSync(sys, { recursive: true })
  for (const line of selfhealFixture('md-sysfs-raid5.txt').split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0 || line.slice(eq + 1) === '<absent>')
      continue
    const path = join(sys, line.slice(0, eq))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${line.slice(eq + 1)}\n`)
  }
  process.env.ANAS_SELFHEAL_KERNEL_ROOT = kernelRoot
  process.env.ANAS_SELFHEAL_RUNTIME_DIR ??= join(kernelRoot, 'run')
}

/**
 * Everything `resolveContext` and the tree walks read, for a pool whose LV is
 * `device` and whose trees are one captured rig's: the dm table and its md
 * array, then the roots and the two leaves the attribution descends into.
 *
 * Shared by both findings suites so the mapping layer is wired ONE way here.
 */
function mappingFixtures(
  executor: MockExecutor,
  device: string,
  trees: { roots: string, extentLeaf: string, subvolLeaf: string },
  /** The LV's dm table and the arrays its segments resolve to (default: one band). */
  dm: { table: string, bands: { majmin: string, kernel: string }[] } = {
    table: 'dmsetup-table-lv.txt',
    bands: [{ majmin: '9:127', kernel: 'md127' }],
  },
): void {
  useKernelRoot()
  executor.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE', '-T', MOUNTPOINT], result: { stdout: `${device}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: ['table', device], result: { stdout: selfhealFixture(dm.table), stderr: '', exitCode: 0 } })
  for (const band of dm.bands) {
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', `/sys/dev/block/${band.majmin}`], result: { stdout: `/sys/devices/virtual/block/${band.kernel}\n`, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', `/dev/${band.kernel}`], result: { stdout: `/dev/${band.kernel}\n`, stderr: '', exitCode: 0 } })
  }
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: selfhealFixture('mdadm-detail-export-raid5.txt'), stderr: '', exitCode: 0 } })
  const rootsText = selfhealFixture(trees.roots)
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'dump-tree', '-r', device], result: { stdout: rootsText, stderr: '', exitCode: 0 } })
  const extentRoot = /extent tree key \(EXTENT_TREE ROOT_ITEM 0\) (\d+)/.exec(rootsText)![1]
  const subvolRoot = /file tree key \(256 ROOT_ITEM 0\) (\d+)/.exec(rootsText)![1]
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'dump-tree', '-b', extentRoot, device], result: { stdout: selfhealFixture(trees.extentLeaf), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'dump-tree', '-b', subvolRoot, device], result: { stdout: selfhealFixture(trees.subvolLeaf), stderr: '', exitCode: 0 } })
}

/**
 * Where this scrub ISSUED a band's check — the line every counter read is
 * judged against. A read before it is the pre-issue snapshot (T2: md zeroes
 * `mismatch_cnt` at a sync start, so the old value is the only thing that can
 * prove a new one is new); a read after it is a verdict read.
 */
function checkIssuedAt(executor: MockExecutor, device: string): number {
  return executor.calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === device)
}

/** Every `mismatch_cnt` read for one band, as call indexes. */
function counterReads(executor: MockExecutor, kernel: string): number[] {
  return executor.calls
    .map((c, i) => (c.command === '/usr/bin/cat' && c.args[0] === `/sys/block/${kernel}/md/mismatch_cnt` ? i : -1))
    .filter(i => i >= 0)
}

/** The argv `probeFileBlock` (selfheal-io) issues for one file block. */
function probeArgs(path: string, block: number): string[] {
  return [`if=${path}`, 'iflag=direct', 'bs=4096', `skip=${block}`, 'count=1', 'of=/dev/null', 'status=none']
}

/** How many `btrfs scrub status` reads the call log has recorded so far. */
function statusPolls(executor: MockExecutor): number {
  return executor.calls.filter(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'status').length
}

/** Wait (1 ms steps — the tests' own poll cadence) until `predicate` holds. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (predicate())
      return
    await new Promise(r => setTimeout(r, 1))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * scrub.r1 (#81): `btrfs scrub start -B` is a LIVE child — the pass ends when
 * the COMMAND returns, not when a poll reads `finished`. Every test that
 * drives a real phase 2 hands its pass promise here: once the status poll
 * BESIDE the child has recorded two reads, `finishLive` ends the child (the
 * command exits 0), and the pass is awaited. Two polls is the shape the order
 * asserts check: at least one status read while the child is open, the final
 * read after it settled. A scrub that refuses or fails BEFORE phase 2 never
 * spawns the child — if the pass settles first, `finishLive` ends nothing
 * and the pass is returned with its own result or rejection.
 */
async function liveScrubPass<T>(executor: MockExecutor, pass: Promise<T>): Promise<T> {
  const passSettledFirst = Symbol('pass settled first')
  await Promise.race([
    pass.then(() => passSettledFirst, () => passSettledFirst),
    until(() => statusPolls(executor) >= 2, 'two btrfs scrub status polls beside the live child'),
  ])
  executor.finishLive()
  return pass
}

describe('scrubAhrPool (Epic 11 + AHR)', () => {
  it('runs btrfs scrub to completion, THEN per-array checks sequentially; clean → silent', async () => {
    const executor = cleanCounters(baseExecutor(), 'md127', 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], results: [
      { stdout: scrubStatus('running', { percent: '42.50' }), stderr: '', exitCode: 0 },
      { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      // r1's check runs, then finishes; then r2's check runs, then finishes.
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 10 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 55 }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
    ] })

    const progress: string[] = []
    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    // D8: checkedArrays counts bands ACTUALLY checked, and the record names them.
    assert.deepEqual(result, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2, bandsChecked: ['t2-r1', 't2-r2'] })

    const calls = executor.calls
    const idx = (pred: (c: { command: string, args: string[] }) => boolean) => calls.findIndex(pred)
    const scrubStart = idx(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start')
    let lastStatus = -1
    for (const [i, c] of calls.entries()) {
      if (c.command === '/usr/bin/btrfs' && c.args[1] === 'status')
        lastStatus = i
    }
    const checkR1 = idx(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r1')
    const checkR2 = idx(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r2')
    assert.ok(scrubStart >= 0 && lastStatus >= 0 && checkR1 >= 0 && checkR2 >= 0)
    // Never concurrent (selfheal.4): BOTH md checks finish before the btrfs
    // scrub starts, and r1's check is awaited before r2's begins.
    assert.ok(checkR2 < scrubStart, 'phase 1 (md) completes before phase 2 (btrfs) starts')
    assert.ok(checkR1 < checkR2, 'md checks run band by band')
    const waitBetween = calls.slice(checkR1 + 1, checkR2).some(c => c.command === '/usr/bin/cat')
    assert.ok(waitBetween, 'r1 check is awaited via /proc/mdstat before r2 starts')

    // Clean scrub → NO notification (dashboard policy §7.3) — parity was agreed
    // (both mismatch counters read 0) and checksums found nothing.
    assert.ok(!calls.some(c => c.command === '/usr/bin/perl'))
    // Progress NAMES the phase (selfheal.4) and reports on every poll.
    assert.ok(progress.some(m => m.startsWith('phase 1/2: md parity check on t2-r1')), progress.join(' | '))
    assert.ok(progress.some(m => m.startsWith('phase 2/2: btrfs checksum scrub')), progress.join(' | '))
    assert.ok(progress.some(m => m.includes('42.5')))
    assert.ok(progress.some(m => m.includes('t2-r1')) && progress.some(m => m.includes('t2-r2')))
  })

  // Story selfheal.4 (e): a phase-1 mismatch warns IMMEDIATELY — rot exists,
  // and phase 2 (running right then) is what names the files. One warning per
  // mismatching band; phase 2 proceeds either way.
  it('phase 1 rot: a mismatch_cnt > 0 warns before phase 2 starts — and phase 2 still runs', async () => {
    const executor = cleanCounters(baseExecutor(), 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 10 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 55 }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
    ] })
    // md counted 8 parity mismatches on r1; r2 came back clean.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/mismatch_cnt'], result: { stdout: '8\n', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.btrfsErrors, null, 'checksums can be clean while parity rots — both stories are told')
    // D1: the mismatch rides the result, and the band counts as checked.
    assert.deepEqual(result.parityMismatches, [{ band: 't2-r1', bandIndex: 1, array: '/dev/md/t2-r1', mismatchCnt: 8, level: 'raid1' }])
    assert.deepEqual(result.bandsChecked, ['t2-r1', 't2-r2'])

    const calls = executor.calls
    const warns = calls.filter(c => c.command === '/usr/bin/perl')
    // Two notifications: the immediate per-band warning at the phase boundary,
    // then the parity-only closing notification once phase 2 named nothing.
    assert.equal(warns.length, 2, 'the per-band warning plus the parity-only second notification')
    assert.equal(warns[0].args[2], 'warning')
    assert.equal(warns[1].args[2], 'warning')
    assert.equal(warns[0].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.equal(
      warns[0].args[4],
      'rot exists in t2-r1. Phase 2 is running now and checks every file\'s checksum. '
      + 'If a file is affected, it will be named',
    )
    assert.equal(warns[1].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.ok(warns[1].args[4].startsWith('Parity mismatch on t2-r1 (8), but the checksum scrub found no corrupt files'), warns[1].args[4])
    // N6: the claim "nothing in ANAS repairs parity" stopped being true when
    // Rewrite parity shipped — the clean arm names the verb instead.
    assert.ok(!warns[1].args[4].includes('Nothing in ANAS repairs parity'), warns[1].args[4])
    assert.ok(warns[1].args[4].includes('Scrubs → parity mismatch → Rewrite parity'), warns[1].args[4])
    // The warning lands BETWEEN the md check and the btrfs scrub: phase 2 is
    // literally running when the operator reads it.
    const warnAt = calls.indexOf(warns[0])
    const checkR1 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[1] === '/dev/md/t2-r1')
    const scrubStart = calls.findIndex(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start')
    assert.ok(checkR1 < warnAt && warnAt < scrubStart, 'the warning rides the phase boundary')
    // The mismatch counter is read AFTER the check goes idle (md finalises it)
    // — md127's counter is read after the poll that shows md127 idle, and
    // still before phase 2 starts. (A later mdstat poll exists — r2's check —
    // and rightly does not gate md127's read.)
    const mdstatPolls = calls.map((c, i) => c.command === '/usr/bin/cat' && c.args[0] === '/proc/mdstat' ? i : -1).filter(i => i >= 0)
    // The FIRST read is the pre-issue snapshot (T2); the verdict is the last.
    const reads = counterReads(executor, 'md127')
    assert.ok(reads[0] < checkIssuedAt(executor, '/dev/md/t2-r1'), 'the counter is snapshotted before the check is issued')
    const cntRead = reads.at(-1)!
    assert.ok(mdstatPolls[1] < cntRead && cntRead < scrubStart, 'the counter is read once the band is idle, before phase 2')
  })

  it('every mismatching band warns; an unreadable counter warns about nothing', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/mismatch_cnt'], result: { stdout: '3\n', stderr: '', exitCode: 0 } })
    // md126's counter unreadable — fail-open to silence, never a false "rot".
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md126/md/mismatch_cnt'], result: { stdout: '', stderr: 'No such file', exitCode: 1 } })

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const warns = executor.calls.filter(c => c.command === '/usr/bin/perl')
    // The per-band warning plus the parity-only closing notification (phase 2
    // was clean), both about t2-r1 only.
    assert.equal(warns.length, 2)
    assert.ok(warns[0].args[4].includes('t2-r1'))
    assert.ok(warns[1].args[3].includes('t2-r1'))
    assert.ok(!warns.some(w => (w.args[3] + w.args[4]).includes('t2-r2')), 'an unreadable counter never becomes a warning')
  })

  it('the mismatch counter is read from the sysfs file the 11.17 hook reads', async () => {
    assert.deepEqual(mismatchCntArgs('md127'), ['/sys/block/md127/md/mismatch_cnt'])
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '  8 \n', stderr: '', exitCode: 0 } })
    assert.equal(await mismatchCount(executor, 'md127'), 8)
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md0'), result: { stdout: 'nonsense\n', stderr: '', exitCode: 0 } })
    assert.equal(await mismatchCount(executor, 'md0'), null, 'a non-numeric counter is no counter')
  })

  // Regression: array.kernelName in the pool object is captured at ROUTE time
  // (the topology read), but phase 2 runs AFTER an unbounded btrfs scrub. md
  // kernel numbers re-enumerate and get REUSED across any reassembly in that
  // window, so a stale md-number could match a DIFFERENT array in mdstat (or
  // none) and make scrub wait on the wrong device — or skip the wait entirely,
  // breaking the strictly-sequential guarantee (§4). Scrub must resolve the
  // CURRENT kernel name from the stable pin symlink (realpath array.device) at
  // point-of-use and ignore the route-time value.
  it('ignores a STALE route-time array.kernelName — resolves fresh via the pin symlink', async () => {
    const executor = cleanCounters(baseExecutor(), 'md127', 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    // r1's check runs one poll then finishes; then r2's. The realpath fixtures
    // (baseExecutor) map t2-r1→md127, t2-r2→md126 — the ONLY correct handles.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 10 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 55 }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
    ] })

    // Poison the pool with STALE kernel names that no longer exist in mdstat
    // (md0/md1). If scrub trusted them, mdstat.find would miss and it would
    // NEVER wait — no /proc/mdstat poll would land between the two checks.
    const stale = pool()
    stale.arrays[0].kernelName = 'md0'
    stale.arrays[1].kernelName = 'md1'

    const result = await liveScrubPass(executor, scrubAhrPool(executor, stale, () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.checkedArrays, 2)

    const calls = executor.calls
    // The stable pin symlink is what gets resolved — never the stale name.
    assert.ok(calls.some(c => c.command === '/usr/bin/realpath' && c.args[0] === '/dev/md/t2-r1'))
    const checkR1 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r1')
    const checkR2 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r2')
    assert.ok(checkR1 >= 0 && checkR2 > checkR1, 'both checks issued, r1 before r2')
    // r1's check WAS awaited via realpath-resolved md127 — polls sit between the
    // two checks. A stale-name trust would produce zero polls between them.
    const catsBetween = calls.slice(checkR1 + 1, checkR2).filter(c => c.command === '/usr/bin/cat').length
    assert.ok(catsBetween >= 2, `r1 was awaited before r2 despite the stale kernelName (saw ${catsBetween} poll(s))`)
  })

  it('btrfs findings → PVE warning notification', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    // A journal with nothing in the window: the count still notifies, and the
    // body says so rather than printing an empty file list (selfheal.3).
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.btrfsErrors, 'csum=2')
    assert.equal(result.errorsReported, 2)
    assert.deepEqual(result.findings, [])

    const notify = executor.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(notify, 'findings must notify')
    assert.equal(notify!.args[2], 'warning')
    assert.equal(notify!.args[3], 'AHR scrub found errors')
    assert.ok(notify!.args[4].includes('csum=2'))
  })

  // Bug #7 (code review): a `resync=PENDING` md check (syncPending set, sync
  // still null — e.g. an auto-read-only array parks its check) is IN-FLIGHT,
  // not finished. Treating it as done lets the next band's check start; when
  // the pending one later fires, two full-device reads run concurrently,
  // breaking the strictly-sequential guarantee (§4).
  it('treats a resync=PENDING md check as in-flight — waits it out before the next band', async () => {
    const executor = cleanCounters(baseExecutor(), 'md127', 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })

    // md127's check parks as PENDING first, then runs, then finishes; only then
    // may md126's check start.
    const pendingR1 = [
      'Personalities : [raid1] ',
      'md127 : active raid1 sdd1[1] sdc1[0]',
      '      1044992 blocks super 1.2 [2/2] [UU]',
      '      \tresync=PENDING',
      '      ',
      'md126 : active raid1 sdf1[1] sde1[0]',
      '      1044992 blocks super 1.2 [2/2] [UU]',
      '      ',
      'unused devices: <none>',
      '',
    ].join('\n')
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      { stdout: pendingR1, stderr: '', exitCode: 0 }, // r1 PENDING → must NOT advance to r2
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 20 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }, // r1 running
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }, // r1 done → r2
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 60 }]), stderr: '', exitCode: 0 }, // r2 running
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }, // r2 done
    ] })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.checkedArrays, 2)

    const calls = executor.calls
    const checkR1 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r1')
    const checkR2 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r2')
    assert.ok(checkR1 >= 0 && checkR2 > checkR1, 'both checks issued, r1 before r2')
    // The PENDING poll must NOT release r2: the pending + running polls both sit
    // between the two checks. Without the fix, r2 starts right after the single
    // PENDING poll (one cat between).
    const catsBetween = calls.slice(checkR1 + 1, checkR2).filter(c => c.command === '/usr/bin/cat').length
    assert.ok(catsBetween >= 2, `r1 was waited through PENDING before r2 started (saw ${catsBetween} poll(s))`)
  })

  /**
   * R6 — md takes the write to `sync_action` asynchronously. A wait loop that
   * looks once, sees no check in mdstat and calls it finished reads a
   * `mismatch_cnt` left by some EARLIER check, and lets phase 2 run on top of
   * the check md was about to start.
   */
  it('waits for the check to START before waiting for it to finish', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    // mdstat never shows the check at all (the poll that lands between the
    // kernel starting and finishing it is the case this guards).
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    // sysfs: not started yet, then running, then running, then idle.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], results: [
      { stdout: 'idle\n', stderr: '', exitCode: 0 },
      { stdout: 'check\n', stderr: '', exitCode: 0 },
      { stdout: 'check\n', stderr: '', exitCode: 0 },
      { stdout: 'idle\n', stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/mismatch_cnt'], result: { stdout: '8\n', stderr: '', exitCode: 0 } })

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 500 }))

    const calls = executor.calls
    const actionReads = calls.map((c, i) => (c.command === '/usr/bin/cat' && c.args[0] === '/sys/block/md127/md/sync_action' ? i : -1)).filter(i => i >= 0)
    const cntRead = counterReads(executor, 'md127').at(-1)!
    const scrubStart = calls.findIndex(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start')
    assert.ok(actionReads.length >= 3, `md was polled until it started and again until it ended (saw ${actionReads.length})`)
    assert.ok(actionReads.filter(i => i < cntRead).length >= 3, 'the counter is read only after the check has started AND ended')
    assert.ok(cntRead < scrubStart, 'phase 2 waits for phase 1')
    // The counter belongs to THIS check, so its verdict is reported.
    const warns = calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(warns.length, 2, 'the per-band warning plus the parity-only closing notification')
    assert.equal(warns[0].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.equal(warns[1].args[3], 'AHR scrub: parity mismatch on t2-r1')
  })

  it('records a band whose check md NEVER started, and reads no stale counter for it', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    // md stays idle: it never took the check.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
    // An old check's counter is still sitting there — and must NOT be reported.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/mismatch_cnt'], result: { stdout: '8\n', stderr: '', exitCode: 0 } })

    const progress: string[] = []
    await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    // The pre-issue snapshot is read (T2 needs it); nothing is read AFTER the
    // check was issued, so no number is ever taken as this band's verdict.
    assert.deepEqual(
      counterReads(executor, 'md127').filter(i => i > checkIssuedAt(executor, '/dev/md/t2-r1')),
      [],
      'no counter is read as the verdict of a check that never ran',
    )
    assert.ok(progress.some(m => m.includes('never started the check on t2-r1')), progress.join(' | '))
    // No rot is claimed from a stale number — but the D8 notification still
    // says the band was not checked (no false assurance from the silence).
    const skippedNotifies = executor.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(skippedNotifies.length, 1, 'the skipped band is said, not silent')
    assert.equal(skippedNotifies[0].args[3], 'AHR scrub did not check every band')
    assert.ok(skippedNotifies[0].args[4].includes('t2-r1 was not checked: md never started the check'), skippedNotifies[0].args[4])
    // The scrub itself still runs — phase 2 is not cancelled by a band md
    // would not check.
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'))
  })

  /**
   * F11 (second pass) — the start-wait had no "already finished" branch. On a
   * small band a check can run AND complete between `mdadm --action=check`
   * returning and the first poll, which every poll of the start window then
   * reads as idle. That was reported as "never started" and the counter — this
   * scrub's own verdict — was never read.
   *
   * T2 (third pass) — `last_sync_action` alone is NOT that evidence: it is
   * persistent, so it reads `check` for ever on any node that has run mdcheck.
   * The counter is what md moves at a sync start, so a counter that MOVED
   * since the pre-issue snapshot is the proof, and this is the shape that
   * carries it.
   */
  it('a check that finished before the first poll is not "never started" — its MOVED counter is the verdict', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    // The band is a tiny one: mdstat never names a check and sysfs reads idle
    // from the very first poll — the check is over before anything looks.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
    // Before the check md had last run a resync; after it, a check — ours.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/last_sync_action'], results: [
      { stdout: 'resync\n', stderr: '', exitCode: 0 },
      { stdout: 'check\n', stderr: '', exitCode: 0 },
    ] })
    // md zeroed the counter when it took the check and left 8 behind: the
    // number MOVED, which is what says this is a new check's count.
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), results: [
      { stdout: '0\n', stderr: '', exitCode: 0 },
      { stdout: '8\n', stderr: '', exitCode: 0 },
    ] })

    const progress: string[] = []
    await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    const calls = executor.calls
    const priorRead = calls.findIndex(c => c.command === '/usr/bin/cat' && c.args[0] === '/sys/block/md127/md/last_sync_action')
    const issued = checkIssuedAt(executor, '/dev/md/t2-r1')
    assert.ok(priorRead >= 0 && priorRead < issued, 'the prior sync action is snapshotted BEFORE the check is issued')
    assert.ok(counterReads(executor, 'md127')[0] < issued, 'and so is the counter it has to be compared against')
    assert.ok(
      counterReads(executor, 'md127').some(i => i > issued),
      'the completed check\'s counter is read',
    )
    assert.ok(!progress.some(m => m.includes('never started')), progress.join(' | '))
    assert.ok(progress.some(m => m.includes('finished before the first poll') && m.includes('counter moved from 0 to 8')), progress.join(' | '))
    // The counter is this check's, so its verdict is reported: the per-band
    // warning plus the parity-only closing notification (D1).
    const warns = calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(warns.length, 2)
    assert.equal(warns[0].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.equal(warns[1].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.ok(warns[1].args[4].includes('Parity mismatch on t2-r1 (8)'))
  })

  /**
   * T2 (third pass) — the aborted-check shape, which the `last_sync_action`
   * test alone could not tell from a completed one.
   *
   * `last_sync_action` is PERSISTENT: a node that has ever run mdcheck reads
   * `check` there for ever. So "idle + last_sync_action=check" is also exactly
   * what a check killed two seconds in by a member failure leaves behind — and
   * the `mismatch_cnt` sitting beside it is a partial or a stale count.
   * Reporting it as this scrub's verdict invents rot (or clears real rot).
   * The counter never moved, so nothing is claimed either way.
   */
  it('a check that aborted (idle + a persistent last_sync_action=check, counter unmoved) is UNKNOWN, not a verdict', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
    // The node ran mdcheck months ago; the attribute has said `check` ever since.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/last_sync_action'], result: { stdout: 'check\n', stderr: '', exitCode: 0 } })
    // 8 before, 8 after — an old count, never zeroed, so no sync op ran here.
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '8\n', stderr: '', exitCode: 0 } })

    const progress: string[] = []
    await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.ok(
      progress.some(m => m.startsWith('check state unknown on t2-r1. Not counted')),
      progress.join(' | '),
    )
    assert.ok(!progress.some(m => m.includes('finished before the first poll')), progress.join(' | '))
    assert.equal(
      executor.calls.filter(c => c.command === '/usr/bin/perl').length,
      1,
      'a stale 8 is not this scrub\'s rot — and an unknown band is never reported clean either (it is said skipped)',
    )
    // The scrub goes on: band 2 and phase 2 still run.
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'))
  })

  /**
   * T2's other half: the GENUINE fast check. md zeroed the counter when it
   * took the check and the band came back clean, so 8 → 0 — a move, and
   * therefore a verdict: counted, and clean.
   */
  it('a genuine fast check whose counter was ZEROED is counted — and reported clean', async () => {
    const executor = cleanCounters(baseExecutor(), 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/last_sync_action'], result: { stdout: 'check\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), results: [
      { stdout: '8\n', stderr: '', exitCode: 0 },
      { stdout: '0\n', stderr: '', exitCode: 0 },
    ] })

    const progress: string[] = []
    await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.ok(progress.some(m => m.includes('finished before the first poll') && m.includes('counter moved from 8 to 0')), progress.join(' | '))
    assert.ok(!progress.some(m => m.includes('check state unknown')), progress.join(' | '))
    assert.equal(
      executor.calls.filter(c => c.command === '/usr/bin/perl').length,
      0,
      'the band was counted and it counted zero mismatches — the stale 8 is not warned about',
    )
  })

  /**
   * F3 (second pass) — the finish-wait exited only when mdstat AND sync_action
   * both read idle, so a band that went `frozen` (or was taken over by another
   * sync op) spun the job forever. With the active-job exclusion (R7) that
   * refused every later scrub and repair on the pool until anasd restarted.
   *
   * T4 (third pass) — and walking away is not enough. ANAS's `--action=check`
   * is still ARMED on the band it gave up on, so it has to be taken back
   * before the next band's check is issued; otherwise both run at once on
   * shared spindles when the array thaws (§4, strictly sequential).
   */
  for (const takeover of ['frozen', 'recover'] as const) {
    it(`stops waiting on a band whose check became '${takeover}', and checks the next band`, async () => {
      const executor = cleanCounters(baseExecutor(), 'md126')
      executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
      executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
      // Idle at the PRE-ISSUE read (S3), our check starts, then md is doing
      // something else entirely — for good.
      executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], results: [
        { stdout: 'idle\n', stderr: '', exitCode: 0 },
        { stdout: 'check\n', stderr: '', exitCode: 0 },
        { stdout: `${takeover}\n`, stderr: '', exitCode: 0 },
      ] })
      // A counter from some earlier check is sitting there — and must NOT be read.
      executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '8\n', stderr: '', exitCode: 0 } })

      const progress: string[] = []
      const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

      assert.equal(result.btrfsErrors, null)
      assert.deepEqual(
        counterReads(executor, 'md127').filter(i => i > checkIssuedAt(executor, '/dev/md/t2-r1')),
        [],
        'no counter is read as the verdict of a band md is not checking for us',
      )
      assert.ok(progress.includes(`t2-r1 was not checked (sync_action=${takeover}). md is not running this scrub's check on that band`), progress.join(' | '))
      // D8: no rot is claimed from a stale number — but the band is SAID
      // skipped, so the only notification here is the skipped-band one.
      const skippedNotifies = executor.calls.filter(c => c.command === '/usr/bin/perl')
      assert.equal(skippedNotifies.length, 1, 'no rot is claimed from a stale number; the skipped band is said')
      assert.ok(skippedNotifies[0].args[4].includes(`t2-r1 was not checked: md was running '${takeover}' instead of this scrub's check`), skippedNotifies[0].args[4])
      assert.deepEqual(result.bandsSkipped?.map(b => b.band), ['t2-r1'])
      // D2 (design review 2026-09-14): the check is NOT taken back by writing
      // `idle`. `idle` does not mean "drop my check" — it means "stop whatever
      // you are doing", and on a `recover` that is a rebuild onto a spare; on a
      // frozen array md refuses the write anyway. md is left alone either way,
      // and the progress line names what it is doing.
      assert.deepEqual(
        executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=idle' && c.args[1] === '/dev/md/t2-r1'),
        [],
        'nothing is written to an array md is running its own operation on',
      )
      assert.ok(
        progress.some(m => m.includes('t2-r1') && (m.includes('not touched') || m.includes('may still run when it thaws'))),
        progress.join(' | '),
      )
      // The scrub goes ON: band 2 is checked and phase 2 runs.
      const nextCheck = checkIssuedAt(executor, '/dev/md/t2-r2')
      assert.ok(nextCheck >= 0)
      assert.ok(executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'))
    })
  }

  /**
   * T4, the honest half: md REFUSES `idle` on a frozen array (EBUSY). The
   * cancel is best-effort — it never fails the scrub — and the progress line
   * says plainly that the check may still fire when the array thaws, rather
   * than claiming a cancellation that did not happen.
   */
  it('a frozen band that refuses idle is said so — the scrub carries on', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], results: [
      { stdout: 'idle\n', stderr: '', exitCode: 0 },
      { stdout: 'check\n', stderr: '', exitCode: 0 },
      { stdout: 'frozen\n', stderr: '', exitCode: 0 },
    ] })
    // mdadm's own refusal, the way md reports it — no longer reached (D2: the
    // write is not attempted at all on a frozen array), and left registered so
    // the assertion below is about ANAS's sentence, not about mdadm's.
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--action=idle', '/dev/md/t2-r1'], result: { stdout: '', stderr: 'mdadm: failed to set action for /dev/md/t2-r1: Device or resource busy', exitCode: 1 } })

    const progress: string[] = []
    await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.ok(
      progress.some(m => m.includes('could not drop this scrub\'s check on t2-r1') && m.includes('may still run when it thaws')),
      progress.join(' | '),
    )
    // Best-effort: the refusal never fails the job, and band 2 is still checked.
    assert.ok(checkIssuedAt(executor, '/dev/md/t2-r2') >= 0)
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'))
  })

  it('a long check is waited out — polled for as long as md says `check`, then the counter', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      ...Array.from({ length: 13 }).fill({ stdout: mdstat([{ kernel: 'md127', checkPercent: 3 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }) as ExecResult[],
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], results: [
      // The pre-issue read (S3) — md is idle, so the check is issued.
      { stdout: 'idle\n', stderr: '', exitCode: 0 },
      ...Array.from({ length: 12 }).fill({ stdout: 'check\n', stderr: '', exitCode: 0 }) as ExecResult[],
      { stdout: 'idle\n', stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '0\n', stderr: '', exitCode: 0 } })

    const progress: string[] = []
    await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    const actionReads = executor.calls.filter(c => c.command === '/usr/bin/cat' && c.args[0] === '/sys/block/md127/md/sync_action').length
    assert.ok(actionReads >= 12, `the check was polled through, not cut short (saw ${actionReads} reads)`)
    assert.ok(progress.some(m => m.startsWith('md check on t2-r1 (3.0%)')), progress.join(' | '))
    assert.ok(!progress.some(m => m.includes('was not checked')), progress.join(' | '))
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/cat' && c.args[0] === '/sys/block/md127/md/mismatch_cnt'))
  })

  it('the absolute ceiling is the last resort — a band that never goes idle stops being waited on', async () => {
    const executor = cleanCounters(baseExecutor(), 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127', checkPercent: 1 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    // Idle at the pre-issue read (S3), then md says `check` for ever — the one
    // state the sync_action policy cannot end, because a real check
    // legitimately looks exactly like this.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], results: [
      { stdout: 'idle\n', stderr: '', exitCode: 0 },
      { stdout: 'check\n', stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '8\n', stderr: '', exitCode: 0 } })

    const progress: string[] = []
    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20, checkFinishCeilingMs: 5 }))

    assert.equal(result.checkedArrays, 1, 't2-r1 was abandoned — it is not coverage')
    assert.deepEqual(result.bandsSkipped, [{ band: 't2-r1', reason: 'still not idle after the 5ms ceiling: the check may still be running' }])
    assert.ok(progress.some(m => m.includes('t2-r1 was not checked (sync_action=check). Still not idle after the 5ms ceiling')), progress.join(' | '))
    assert.deepEqual(
      counterReads(executor, 'md127').filter(i => i > checkIssuedAt(executor, '/dev/md/t2-r1')),
      [],
      'no counter is read as the verdict of a band whose check never ended',
    )
    // T4: the ceiling abandons the band with the check still running on it —
    // so idle goes in before the next band's check is issued.
    const idleAt = executor.calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=idle' && c.args[1] === '/dev/md/t2-r1')
    assert.ok(idleAt >= 0 && idleAt < checkIssuedAt(executor, '/dev/md/t2-r2'), 'the ceiling writes idle before moving on')
    assert.ok(progress.includes('dropped this scrub\'s check on t2-r1 so it cannot run beside the next band\'s check'), progress.join(' | '))
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'), 'the job finishes rather than spinning')
  })

  /**
   * T4's FOURTH abandonment path (fourth pass): an unresolvable pin symlink
   * leaves no kernel name to watch the check on — but the check was still
   * ISSUED (the resolution comment says so deliberately: an unresolvable name
   * costs the wait, never the check).
   *
   * The third pass took it back with `mdadm --action=idle`. D2 (design review
   * 2026-09-14) says that write is safe only when `sync_action` has just been
   * read as the `check` this run issued — and with no kernel name there is
   * nothing to read it from. An unprovable `idle` is exactly the write that
   * aborts a rebuild onto a spare, so the band is left alone and the progress
   * line says the check may still be armed. A check running beside a later
   * band's breaks §4's sequencing; an aborted rebuild loses data.
   */
  it('a band whose kernel name will not resolve is LEFT ALONE — an unprovable idle is not written', async () => {
    const executor = new MockExecutor()
    // First-match-wins: the failing realpath for t2-r1 is registered FIRST, so
    // it beats baseExecutor's resolving one — build the executor by hand.
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r1'], result: { stdout: '', stderr: 'realpath: No such file or directory', exitCode: 1 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r2'], result: { stdout: '/dev/md126\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    // Catch-all cat: md126 has no scripted sysfs, so its wait behaves as in
    // every other abandonment test above.
    executor.addFixture({ command: '/usr/bin/cat', result: { stdout: mdstat([]), stderr: '', exitCode: 0 } })

    const progress: string[] = []
    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.ok(
      progress.includes('Cannot resolve /dev/md/t2-r1 to a kernel device. Not waiting on its check'),
      progress.join(' | '),
    )
    // The check WAS issued either way — and nothing is written to take it back,
    // because nothing here can prove what md is running on that array.
    assert.deepEqual(
      executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=idle' && c.args[1] === '/dev/md/t2-r1'),
      [],
      'no idle is written to an array whose sync_action cannot be read',
    )
    assert.ok(
      progress.some(m => m.includes('could not drop this scrub\'s check on t2-r1') && m.includes('Nothing was written')),
      progress.join(' | '),
    )
    const nextCheck = checkIssuedAt(executor, '/dev/md/t2-r2')
    assert.ok(nextCheck >= 0, 'the scrub goes on: band 2 is still checked')
    assert.equal(result.btrfsErrors, null, 'the job completes — the cancellation is best-effort, never fatal')
  })

  /**
   * S3 — the route reads the pool's state once, and bands are checked one at a
   * time over hours. A member that failed since then has md recovering onto a
   * spare RIGHT NOW. Issuing `--action=check` into that used to go through
   * `run`, which THROWS on a non-zero exit and failed the whole scrub; worse,
   * once the cancel path ran it wrote `idle` and aborted the rebuild (D2).
   *
   * Re-read per band, immediately before issuing. A busy band is recorded and
   * skipped, nothing is issued, nothing is written, and the scrub carries on.
   */
  it('does not ISSUE a check on a band md is already recovering — it skips it', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    // A member failed between the route's read and this band's turn.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'recover\n', stderr: '', exitCode: 0 } })

    const progress: string[] = []
    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.ok(
      progress.includes('t2-r1 was not checked. md is running recover on that band, and a parity check would fight it'),
      progress.join(' | '),
    )
    assert.equal(checkIssuedAt(executor, '/dev/md/t2-r1'), -1, 'no check was issued into the recovery')
    assert.deepEqual(
      executor.calls.filter(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=idle'),
      [],
      'and nothing was written to take back a check that was never issued',
    )
    // The scrub is not failed by one busy band: band 2 and phase 2 still run.
    assert.ok(checkIssuedAt(executor, '/dev/md/t2-r2') >= 0)
    assert.equal(result.btrfsErrors, null)
  })

  it('records a band whose check mdadm refuses, rather than failing the scrub', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--action=check', '/dev/md/t2-r1'], result: { stdout: '', stderr: 'mdadm: failed to set action for /dev/md/t2-r1: Device or resource busy', exitCode: 1 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r1'], result: { stdout: '/dev/md127\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r2'], result: { stdout: '/dev/md126\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', result: { stdout: mdstat([]), stderr: '', exitCode: 0 } })

    const progress: string[] = []
    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.ok(
      progress.some(m => m.startsWith('t2-r1 was not checked (mdadm --action=check exited 1')),
      progress.join(' | '),
    )
    assert.ok(checkIssuedAt(executor, '/dev/md/t2-r2') >= 0, 'band 2 is still checked')
    assert.equal(result.btrfsErrors, null, 'one band\'s refusal is not the job\'s failure')
  })

  /**
   * D4(b) — GT-13's trap, reached from the scrub side. A repair killed
   * mid-sequence leaves `sync_max` bounded to ONE STRIPE, and the knob
   * PERSISTS: a check issued under it covers that stripe, suspends there, and
   * the finish-wait then holds the pool's job exclusion for the full ceiling
   * while the band goes unchecked. The band is idle, so the window is simply
   * put back before the check goes in.
   */
  it('restores a sync window an interrupted repair left bounded, before issuing the check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-scrub-knobs-'))
    const sys = join(root, 'sys/block/md127/md')
    mkdirSync(sys, { recursive: true })
    writeFileSync(join(sys, 'sync_min'), '6272\n')
    writeFileSync(join(sys, 'sync_max'), '6400\n')
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = root

    try {
      const executor = baseExecutor()
      executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
      executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '0\n', stderr: '', exitCode: 0 } })

      const progress: string[] = []
      await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

      const widened = progress.findIndex(m => m.includes('t2-r1: sync window was bounded to 6272..6400') && m.includes('restored to 0..max'))
      assert.ok(widened >= 0, progress.join(' | '))
      assert.equal(readFileSync(join(sys, 'sync_min'), 'utf-8').trim(), '0')
      assert.equal(readFileSync(join(sys, 'sync_max'), 'utf-8').trim(), 'max')
      // And it happened BEFORE the check went in — a check issued under the old
      // window would have covered one stripe and suspended there.
      assert.ok(checkIssuedAt(executor, '/dev/md/t2-r1') >= 0)
    }
    finally {
      delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('aborted btrfs scrub fails the job', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: scrubStatus('aborted'), stderr: '', exitCode: 0 } })
    await assert.rejects(scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }), /aborted/)
  })

  it('refuses an unmounted pool', async () => {
    const executor = baseExecutor()
    await assert.rejects(scrubAhrPool(executor, pool('/dev/t2/t2-vol'), () => {}), /not mounted/)
    assert.equal(executor.calls.length, 0)
  })
})

/**
 * scrub.r1 (#81) — the pass outlives the command deadline on purpose.
 *
 * `btrfs scrub start -B` is ONE foreground command for the whole checksum
 * pass: it runs with NO deadline (a days-long verify on a big pool), the
 * status poll runs BESIDE it for progress only, and the verdict comes from
 * ONE final status read AFTER the command returned. These drive
 * `btrfsScrubPass` directly — that is the unit both callers (the scrub's
 * phase 2 and the parity rewrite) share.
 */
describe('btrfsScrubPass — the blocking start (scrub.r1)', () => {
  it('phase 2 holds `btrfs scrub start -B` open with NO deadline and polls status beside it', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], results: [
      { stdout: scrubStatus('running', { percent: '42.50' }), stderr: '', exitCode: 0 },
      { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 },
    ] })

    const progress: string[] = []
    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', m => progress.push(m), 1)
    // The boundary is the test's OWN clock: the moment two status polls are
    // logged AND the percentage line was reported, the child is still open
    // (finishLive has not run) — everything before is "while it was live".
    let boundary = -1
    await until(() => {
      if (statusPolls(executor) >= 2 && progress.some(m => m.includes('42.5'))) {
        boundary = executor.calls.length
        return true
      }
      return false
    }, 'two status polls and a percentage progress line beside the live child')
    const progressWhileLive = progress.filter(m => m === 'btrfs scrub running (42.5%)').length
    executor.finishLive()
    const result = await pass

    assert.equal(result.btrfsErrors, null)
    assert.ok(result.startedAt instanceof Date)
    // The start call carries NO deadline and names the reason (cr.34).
    const startDeadline = executor.deadlines.find(d => d.command === '/usr/bin/btrfs' && d.args[1] === 'start')
    assert.equal(startDeadline?.budgetMs, null, 'the blocking start runs with no deadline')
    assert.equal(startDeadline?.source, 'call')
    assert.match(startDeadline?.longRunning ?? '', /^btrfs scrub: /)
    // A progress line with a percentage was reported WHILE the command lived.
    assert.ok(progressWhileLive >= 1, progress.join(' | '))
    // Order from the call log: at least one status poll was recorded BEFORE
    // the child was ended, and the final read came AFTER — the pass ends on
    // the command, not on a poll.
    const statuses = executor.calls
      .map((c, i) => (c.command === '/usr/bin/btrfs' && c.args[1] === 'status' ? i : -1))
      .filter(i => i >= 0)
    assert.ok(statuses.some(i => i < boundary), 'a status poll ran beside the live command')
    assert.ok(statuses.some(i => i >= boundary), 'the final status read followed the command')
    assert.equal(statuses.filter(i => i >= boundary).length, 1, 'exactly ONE status read after settlement')
  })

  it('a non-zero exit from the blocking start with a `finished` status is a finding, not a failure', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })

    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', () => {}, 1)
    await until(() => statusPolls(executor) >= 1, 'a status poll beside the live child')
    // btrfs-progs exits non-zero when the pass FINISHED WITH ERRORS — the
    // verdict is the final status, the exit code is noise.
    executor.finishLive({ stdout: '', stderr: 'ERROR: there are uncorrectable errors', exitCode: 3 })
    const result = await pass
    assert.equal(result.btrfsErrors, 'csum=1', 'the Error summary rides the result for phase 2 attribution')
  })

  it('a status that is neither finished nor aborted after the command returned is a failure', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('interrupted'), stderr: '', exitCode: 0 } })

    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', () => {}, 1)
    await until(() => executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'), 'the start call')
    // The command returned (cleanly) but the kernel never finished the pass —
    // the #81 shape: `scrub: not finished on devid 1 with status: -4`.
    executor.finishLive()
    await assert.rejects(pass, /btrfs scrub on 't2' ended without finishing \(status: interrupted\)/)
  })

  it('the aborted status still fails the pass with its existing sentence', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('aborted', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })

    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', () => {}, 1)
    await until(() => executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start'), 'the start call')
    executor.finishLive()
    await assert.rejects(pass, /btrfs scrub on 't2' was aborted \(csum=1\)/)
  })

  // The review of #81 (probe 1): one transient `btrfs scrub status` failure
  // must not fail the JOB while the `-B` child is still reading the array —
  // nothing ends that child (no cancel hook), so the job record said "failed"
  // beside a live scrub and a retry could start a second one beside it.
  it('a failing status poll is progress, not a verdict: the pass keeps waiting for the command', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], results: [
      { stdout: '', stderr: 'ERROR: cannot open scrub status', exitCode: 1 },
      { stdout: scrubStatus('running', { percent: '42.50' }), stderr: '', exitCode: 0 },
      { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 },
    ] })

    let settled = false
    const markSettled = (): void => {
      settled = true
    }
    const progress: string[] = []
    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', m => progress.push(m), 1)
    pass.then(markSettled, markSettled)
    // The FIRST poll fails (run() throws on exit 1) — the pass reports it on
    // the progress line and STAYS PENDING beside the live child.
    await until(() => progress.some(m => m.includes('status unreadable')), 'a `status unreadable` progress line')
    assert.equal(settled, false, 'a failing status poll does not settle the pass')
    assert.ok(
      progress.includes('btrfs scrub running (status unreadable: ERROR: cannot open scrub status)'),
      progress.join(' | '),
    )
    // And polling continues on the normal interval (a failing poll does not
    // spin): the next read is an ordinary progress line, the pass STILL waits
    // for the command.
    await until(() => progress.includes('btrfs scrub running (42.5%)'), 'the next (successful) progress poll')
    assert.equal(settled, false, 'the pass waits for the COMMAND, not for a poll')
    executor.finishLive()
    const result = await pass
    assert.equal(result.btrfsErrors, null)
  })

  // Probe 2: when the exec rejects AND the status read fails too — the
  // ordinary consequence of the SAME cause (btrfs missing: ENOENT on the
  // start, no fixture → exit 127 on the status) — the pass must throw the
  // SPAWN error, with its message, not the status read's.
  it('a spawn failure throws the spawn error even when the status read fails too', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], throws: new Error('ENOENT: no such file or directory, spawn /usr/bin/btrfs') })
    // NO status fixture — the mock answers every status read with its
    // exit-127 "command not found" fallback, as the real ENOENT would.

    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', () => {}, 1)
    await assert.rejects(pass, /spawn|ENOENT|EACCES/)
    const err = await pass.then(() => null, (e: unknown) => e)
    assert.ok(err instanceof Error)
    assert.ok(
      !err.message.includes('command not found'),
      `the STATUS error surfaced instead of the spawn error: ${err.message}`,
    )
  })

  // Probe 3 (POSSIBLE): a status file that still reads `running` in the
  // instant after `-B` returned must not fail a clean multi-hour pass.
  it('the verdict read retries a lagging `running` status before giving up', async () => {
    const lagging = new MockExecutor()
    lagging.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    lagging.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], results: [
      { stdout: scrubStatus('running', { percent: '99.90' }), stderr: '', exitCode: 0 },
      { stdout: scrubStatus('running'), stderr: '', exitCode: 0 },
      { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 },
    ] })
    const laggingPass = btrfsScrubPass(lagging, MOUNTPOINT, 't2', () => {}, 1)
    await until(() => statusPolls(lagging) >= 1, 'the first status poll beside the live child')
    lagging.finishLive()
    const result = await laggingPass
    assert.equal(result.btrfsErrors, null)
    assert.ok(statusPolls(lagging) >= 3, `the lagging verdict was not retried — ${statusPolls(lagging)} status reads`)

    // A status that never leaves `running` exhausts the three attempts and
    // fails with the EXISTING sentence.
    const stuck = new MockExecutor()
    stuck.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    stuck.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('running'), stderr: '', exitCode: 0 } })
    const stuckPass = btrfsScrubPass(stuck, MOUNTPOINT, 't2', () => {}, 1)
    await until(() => statusPolls(stuck) >= 1, 'the first status poll beside the live child')
    stuck.finishLive()
    await assert.rejects(stuckPass, /btrfs scrub on 't2' ended without finishing \(status: running\)/)
  })

  // Probe 3 (NOTICED): the scrub finished and only the VERDICT read fails —
  // say so, instead of failing the pass with the status command's stderr.
  it('a verdict read that keeps throwing says the status could not be read', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: '', stderr: 'ERROR: cannot open scrub status', exitCode: 1 } })

    const pass = btrfsScrubPass(executor, MOUNTPOINT, 't2', () => {}, 1)
    await until(() => statusPolls(executor) >= 1, 'the first status poll beside the live child')
    executor.finishLive()
    await assert.rejects(pass, /btrfs scrub on 't2' finished but its status could not be read: ERROR: cannot open scrub status/)
  })
})

describe('parseBtrfsScrubStatus', () => {
  it('extracts status, percent, and error summary', () => {
    const st = parseBtrfsScrubStatus(scrubStatus('running', { percent: '42.50', summary: 'csum=2' }))
    assert.deepEqual(st, { status: 'running', percent: 42.5, errorSummary: 'csum=2' })
  })
  it('fail-opens to nulls on empty output', () => {
    assert.deepEqual(parseBtrfsScrubStatus(''), { status: null, percent: null, errorSummary: null })
  })
})

/**
 * Story selfheal.3 — the scrub names WHAT is corrupt.
 *
 * Every parser case below is fed the drill's verbatim kernel lines
 * (fixtures/ahr/scrub-dmesg-gt3.txt, scrub-dmesg-gt6.txt — GT-3 and GT-6 of
 * docs/AHR-SELF-HEAL-GROUND-TRUTH.md), never a hand-written approximation of
 * them.
 */
describe('parseScrubWarning (GT-3 kernel lines)', () => {
  it('parses the drill\'s checksum-error line field for field', () => {
    assert.deepEqual(parseScrubWarning(GT3_LINES[0]), {
      device: 'dm-0',
      logical: 14811136,
      dev: '/dev/mapper/gtsh-data',
      physical: 14811136,
      root: 256,
      inode: 257,
      offset: 1179648,
      length: 4096,
      links: 1,
      path: 'f1.bin',
    })
  })

  it('parses the GT-6 line (corruption written THROUGH md) the same way', () => {
    const line = parseScrubWarning(GT6_LINES[0])
    assert.equal(line?.inode, 258)
    assert.equal(line?.path, 'f2.bin')
    assert.equal(line?.logical, 19005440)
  })

  it('reads the same line from journald (no dmesg timestamp prefix)', () => {
    const bare = GT3_LINES[0].replace(/^\[\s*\d+\.\d+\]\s*/, '')
    assert.deepEqual(parseScrubWarning(bare), parseScrubWarning(GT3_LINES[0]))
  })

  it('ignores the bdev error-COUNTER line that follows it — not an error event', () => {
    assert.equal(parseScrubWarning(GT3_LINES[1]), null)
    assert.equal(parseUnattributedScrubError(GT3_LINES[1]), null)
    // …and the scrub-summary line the capture script appends is not one either.
    assert.equal(parseUnattributedScrubError(GT6_LINES[1]), null)
  })

  it('a path-less error line is unattributed, never a file', () => {
    const line = 'BTRFS error (device dm-0): unable to fixup (regular) error at logical 24000000 on dev /dev/mapper/gtsh-data physical 24000000'
    assert.equal(parseScrubWarning(line), null)
    assert.deepEqual(parseUnattributedScrubError(line), { device: 'dm-0', logical: 24000000 })
  })
})

describe('kernelJournalMessages (journalctl -k -o json)', () => {
  it('takes MESSAGE out of the JSON envelope, string or byte array', () => {
    const ndjson = [
      JSON.stringify({ MESSAGE: GT3_LINES[0], _TRANSPORT: 'kernel' }),
      JSON.stringify({ MESSAGE: Array.from(GT6_LINES[0], c => c.charCodeAt(0)) }),
      'not json at all',
      '',
      JSON.stringify({ PRIORITY: '6' }),
    ].join('\n')
    assert.deepEqual(kernelJournalMessages(ndjson), [GT3_LINES[0], GT6_LINES[0]])
  })
})

describe('attributeScrubErrors (grouping, cap, honesty counts)', () => {
  const dmesg = (opts: { device?: string, root?: number, inode: number, logical: number, offset: number, path: string }): string =>
    `BTRFS warning (device ${opts.device ?? 'dm-0'}): scrub: checksum error at logical ${opts.logical} `
    + `on dev /dev/mapper/gtsh-data, physical ${opts.logical} root ${opts.root ?? 256} inode ${opts.inode} `
    + `offset ${opts.offset} length 4096 links 1 (path: ${opts.path})`

  it('groups every stripe of one file into one finding', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      dmesg({ inode: 257, logical: 14876672, offset: 1245184, path: 'f1.bin' }),
      GT6_LINES[0],
    ])
    assert.equal(a.files.length, 2)
    assert.equal(a.files[0].inode, 257)
    assert.deepEqual(a.files[0].stripes.map(s => s.offset), [1179648, 1245184])
    assert.equal(a.files[1].inode, 258)
    assert.equal(a.errorsAttributed, 3)
    assert.equal(a.truncated, false)
  })

  it('counts a stripe reported twice (both copies of a mirror) once', () => {
    const a = attributeScrubErrors([GT3_LINES[0], GT3_LINES[0]])
    assert.equal(a.errorsAttributed, 1)
    assert.equal(a.files[0].stripes.length, 1)
  })

  it('same inode number in a DIFFERENT subvolume is a different file', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      dmesg({ root: 257, inode: 257, logical: 15000000, offset: 0, path: 'f1.bin' }),
    ])
    assert.equal(a.files.length, 2)
    assert.deepEqual(a.files.map(f => f.root), [256, 257])
  })

  it(`caps the list at ${AHR_SCRUB_FINDINGS_CAP} files but keeps counting every error`, () => {
    const lines: string[] = []
    for (let i = 0; i < AHR_SCRUB_FINDINGS_CAP + 5; i++) {
      lines.push(dmesg({ inode: 1000 + i, logical: 20000000 + i * 65536, offset: 0, path: `f${i}.bin` }))
      // A second stripe for each file — the cap is on FILES, not on errors.
      lines.push(dmesg({ inode: 1000 + i, logical: 30000000 + i * 65536, offset: 65536, path: `f${i}.bin` }))
    }
    const a = attributeScrubErrors(lines)
    assert.equal(a.files.length, AHR_SCRUB_FINDINGS_CAP)
    assert.equal(a.truncated, true)
    assert.equal(a.errorsAttributed, (AHR_SCRUB_FINDINGS_CAP + 5) * 2)
  })

  it('errors with no path are counted unattributed — and never counted twice', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      // The same error said again, this time without a path: still ONE error.
      'BTRFS error (device dm-0): unable to fixup (regular) error at logical 14811136 on dev /dev/mapper/gtsh-data physical 14811136',
      // A genuinely nameless one.
      'BTRFS error (device dm-0): unable to fixup (regular) error at logical 24000000 on dev /dev/mapper/gtsh-data physical 24000000',
    ])
    assert.equal(a.errorsAttributed, 1)
    assert.equal(a.unattributed, 1)
  })

  it('another pool scrubbing at the same time is not attributed to this one', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      dmesg({ device: 'dm-9', inode: 9999, logical: 40000000, offset: 0, path: 'other-pool.bin' }),
      'BTRFS error (device dm-9): unable to fixup (regular) error at logical 40000000 on dev /dev/mapper/other-data physical 40000000',
    ], 'dm-0')
    assert.equal(a.files.length, 1)
    assert.equal(a.files[0].inode, 257)
    assert.equal(a.unattributed, 0)
  })

  it('an unresolvable device filters nothing (fail-open)', () => {
    assert.equal(attributeScrubErrors([GT3_LINES[0]], null).files.length, 1)
  })
})

describe('scrub summary counts + path assembly', () => {
  it('sums the Error summary counters', () => {
    assert.equal(countErrorSummary('csum=2'), 2)
    assert.equal(countErrorSummary('read=1 csum=12 super=1'), 14)
    assert.equal(countErrorSummary(null), 0)
  })

  // `subvolid-resolve` answers from the filesystem's TOP LEVEL, but a §12 pool
  // is mounted `subvol=@data` AT the mountpoint — so the resolved path has to be
  // taken RELATIVE to the mounted subvolume. Getting this wrong points every
  // probe at a path that does not exist on a real pool.
  const MP = '/mnt/anas-ahr/t2'

  it('§12 layout: a file at the root of the MOUNTED subvolume sits at the mountpoint', () => {
    assert.deepEqual(findingPath(MP, '@data', '@data', 'f1.bin'), { path: `${MP}/f1.bin`, outsideMount: false })
    // …and the same with the slashes btrfs and findmnt actually print.
    assert.deepEqual(findingPath(`${MP}/`, '/@data', '@data/', '/movies/a.mkv'), { path: `${MP}/movies/a.mkv`, outsideMount: false })
  })

  it('§12 layout: a NESTED subvolume keeps its remainder under the mountpoint', () => {
    assert.deepEqual(
      findingPath(MP, '@data', '@data/photos', '2026/a.jpg'),
      { path: `${MP}/photos/2026/a.jpg`, outsideMount: false },
    )
  })

  it('§12 layout: a snapshot is OUTSIDE the mounted tree — filesystem-relative, flagged', () => {
    assert.deepEqual(
      findingPath(MP, '@data', '@snapshots/nightly', 'f1.bin'),
      { path: '@snapshots/nightly/f1.bin', outsideMount: true },
    )
    // A sibling whose name merely STARTS with the mounted one is outside too.
    assert.equal(findingPath(MP, '@data', '@database', 'f1.bin').outsideMount, true)
  })

  it('flat pool (top level mounted): the resolved subvolume is a directory under it', () => {
    assert.deepEqual(findingPath(MP, '', '@data', 'f1.bin'), { path: `${MP}/@data/f1.bin`, outsideMount: false })
    assert.deepEqual(findingPath(MP, '/', '/', 'f1.bin'), { path: `${MP}/f1.bin`, outsideMount: false })
  })

  it('formats the journal window as journalctl -S takes it (local wall clock)', () => {
    assert.equal(journalSince(new Date(2026, 8, 11, 7, 5, 3)), '2026-09-11 07:05:03')
  })
})

describe('scrubAhrPool — findings (story selfheal.3)', () => {
  // The pool is the §12 layout — `subvol=@data` mounted AT the mountpoint — so
  // the kernel's `root 256` (`@data`) file `f1.bin` is `<mountpoint>/f1.bin`.
  // `<mountpoint>/@data/f1.bin` does not exist on such a pool.
  const F1 = `${MOUNTPOINT}/f1.bin`
  const F2 = `${MOUNTPOINT}/f2.bin`

  /** The journalctl -o json envelope around a set of kernel lines. */
  function journal(lines: string[]): string {
    return `${lines.map(l => JSON.stringify({ _TRANSPORT: 'kernel', MESSAGE: l })).join('\n')}\n`
  }

  /** `findmnt --json --real <mountpoint>` for a pool mounted `subvol=<subvol>`. */
  function findmnt(subvol: string): string {
    return `${JSON.stringify({
      filesystems: [{
        target: MOUNTPOINT,
        source: `/dev/mapper/t2-t2--vol[${subvol}]`,
        fstype: 'btrfs',
        options: `rw,relatime,space_cache=v2,subvol=${subvol}`,
      }],
    })}\n`
  }

  /**
   * The whole findings path. `journal` replaces the default capture — the mock
   * matches the FIRST fixture registered for a command, so a test that needs a
   * different journal answer has to say so here rather than add a second one.
   */
  function findingsExecutor(journalResults?: { stdout: string, stderr: string, exitCode: number }[]): MockExecutor {
    const executor = baseExecutor()
    if (journalResults)
      executor.addFixture({ command: '/usr/bin/journalctl', results: journalResults })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmnt('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([...GT3_LINES, ...GT6_LINES]), stderr: '', exitCode: 0 } })
    // The pool LV's dm name — the name the kernel lines carry.
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    // Every probe read succeeds unless a fixture below says otherwise.
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })
    // The mapping layer: the split rig's trees (PROVENANCE.md) — an
    // UNCOMPRESSED file whose extents cover the stripe the GT-3 line names, so
    // the attribution probes the kernel's own offset (GT-3) and names the block.
    mappingFixtures(executor, '/dev/mapper/t2-t2--vol', {
      roots: 'split-dump-tree-roots.txt',
      extentLeaf: 'split-dump-tree-extent.txt',
      subvolLeaf: 'split-dump-tree-subvol.txt',
    })
    return executor
  }

  /** Both files still exist (the ordinary case). */
  function bothPresent(executor: MockExecutor): void {
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F1], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F2], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
  }

  /** GT-3's rot sits in file block 300 — inside the named stripe (288–303). */
  function badBlock300(executor: MockExecutor): void {
    executor.addFixture({
      command: '/usr/bin/dd',
      args: probeArgs(F1, 300),
      result: { stdout: '', stderr: 'dd: error reading', exitCode: 1 },
    })
  }

  it('names the corrupt file, its stripe, and the exact failing 4 KiB block', async () => {
    const executor = findingsExecutor()
    bothPresent(executor)
    badBlock300(executor)

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    assert.equal(result.errorsReported, 2)
    assert.equal(result.errorsAttributed, 2)
    assert.equal(result.unattributed, 0)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.findings?.[0], {
      path: F1,
      subvolume: '@data',
      inode: 257,
      stripes: [{ logical: 14811136, offset: 1179648, length: 4096 }],
      badBlocks: [300],
    })
    assert.deepEqual(result.findings?.[1].badBlocks, [])
    assert.equal(result.findings?.[1].path, F2)

    // The window is bounded to THIS scrub, and the envelope is asked for as JSON.
    const journalCall = executor.calls.find(c => c.command === '/usr/bin/journalctl')
    assert.ok(journalCall)
    assert.deepEqual(journalCall!.args.slice(0, 4), ['-k', '-o', 'json', '-S'])
    assert.match(journalCall!.args[4], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // §4, restated by selfheal.4: the attribution's probe reads run AFTER both
    // md checks — nothing else reads the array while a check runs.
    const journalAt = executor.calls.indexOf(journalCall!)
    const lastCheck = executor.calls.reduce((at, c, i) =>
      (c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' ? i : at), -1)
    assert.ok(lastCheck >= 0 && lastCheck < journalAt, 'attribution follows phase 1')

    // 16 O_DIRECT reads per named stripe — the whole stripe, nothing else.
    const ddF1 = executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F1}`)
    assert.equal(ddF1.length, 16)
    assert.deepEqual(ddF1.map(c => c.args[3]), Array.from({ length: 16 }, (_, i) => `skip=${288 + i}`))
    assert.ok(ddF1.every(c => c.args.includes('iflag=direct')), 'a cached read would find nothing')

    // One subvolume id → ONE resolve, however many files it holds.
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'subvolid-resolve').length, 1)

    // The path is taken relative to the subvolume the pool actually MOUNTS —
    // read from the live mount table, not assumed.
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/findmnt' && c.args.includes(MOUNTPOINT)))
  })

  it('carries the paths in the SAME warning notification — never a second one', async () => {
    const executor = findingsExecutor()
    bothPresent(executor)
    badBlock300(executor)

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    const notifies = executor.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(notifies.length, 1, 'one event, one notification')
    const body = notifies[0].args[4]
    assert.ok(body.includes('csum=2'), 'the summary sentence is unchanged')
    assert.ok(body.includes(F1) && body.includes(F2), 'both paths are named in full')
    assert.ok(body.includes('1 bad 4K block(s)'))
    assert.ok(body.includes('2 of 2 reported error(s) attributed'))
  })

  it('a file deleted since the scrub is reported as missing, not as a failure', async () => {
    const executor = findingsExecutor()
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F1], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F2], result: { stdout: '', stderr: 'No such file or directory', exitCode: 1 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.findings?.[1].missing, true)
    assert.deepEqual(result.findings?.[1].badBlocks, [])
    // Nothing was probed for it — a missing path is never dd'd sixteen times.
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F2}`).length, 0)
    // …and the deletion is said in the notification rather than counted as blocks.
    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('deleted since the scrub'))
  })

  it('an unreadable journal never fails the scrub — the count still stands', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: 'Failed to open journal', exitCode: 1 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.btrfsErrors, 'csum=2')
    assert.equal(result.errorsReported, 2)
    assert.equal(result.findings, undefined, 'no attribution rather than an invented one')
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 1)
  })

  /**
   * The journal read is BOUNDED. The executor hands stdout over as a string
   * through a 10 MB buffer, so an unbounded read on a node with tens of
   * thousands of scrub errors does not truncate — it fails outright and the
   * whole attribution is lost.
   */
  it('asks the journal for this window\'s error lines only, and for a bounded number of them', async () => {
    const executor = findingsExecutor()
    bothPresent(executor)
    badBlock300(executor)

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    const call = executor.calls.find(c => c.command === '/usr/bin/journalctl')!
    assert.deepEqual(call.args.slice(0, 4), ['-k', '-o', 'json', '-S'])
    assert.ok(call.args.includes('--no-pager'))
    assert.equal(call.args[call.args.indexOf('-n') + 1], String(AHR_SCRUB_JOURNAL_LINE_CAP))
    // Both error shapes carry the first alternative; the corrected-metadata
    // reads (selfheal.12) ride the same single window read as the second.
    assert.equal(call.args[call.args.indexOf('-g') + 1], 'error at logical|read error corrected')
  })

  it('re-reads without -g when journalctl has no pattern matching, rather than losing the attribution', async () => {
    // The -g call fails as a journalctl built without PCRE2 does; the plain
    // one answers.
    const executor = findingsExecutor([
      { stdout: '', stderr: 'journalctl: unrecognized option \'-g\'', exitCode: 1 },
      { stdout: journal([...GT3_LINES, ...GT6_LINES]), stderr: '', exitCode: 0 },
    ])
    bothPresent(executor)
    badBlock300(executor)

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const calls = executor.calls.filter(c => c.command === '/usr/bin/journalctl')
    // The attribution's pair (-g failing, the plain re-read answering) plus
    // the corrected-metadata read of the same window (selfheal.12) — whose -g
    // succeeds here, because the mock's sequence repeats its last entry.
    assert.equal(calls.length, 3)
    assert.ok(calls[0].args.includes('-g'))
    assert.ok(!calls[1].args.includes('-g'))
    assert.ok(calls[1].args.includes('-n'), 'still line-capped')
    assert.equal(result.errorsAttributed, 2, 'the attribution stands')
  })

  it('says the listing is incomplete when the journal read hits its cap', async () => {
    // Exactly the cap: `-n` keeps the most RECENT entries, so older errors of
    // this window were not read and the result must not read as complete.
    const lines = Array.from(
      { length: AHR_SCRUB_JOURNAL_LINE_CAP },
      (_, i) => `BTRFS error (device dm-0): unable to fixup (regular) error at logical ${20000000 + i * 4096}`,
    )
    const executor = findingsExecutor([{ stdout: journal(lines), stderr: '', exitCode: 0 }])
    bothPresent(executor)

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.truncated, true)
    assert.equal(result.unattributed, AHR_SCRUB_JOURNAL_LINE_CAP)
    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('name no file'), body)
  })

  it('a clean scrub probes nothing, and reads the journal only for the corrected-metadata window', async () => {
    const clean = cleanCounters(baseExecutor(), 'md127', 'md126')
    clean.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    clean.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    clean.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(clean, scrubAhrPool(clean, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    // Read off BEFORE the deepEqual below: strict deepEqual asserts the actual
    // against the expected literal, which narrows the static type to the four
    // fields that literal carries.
    assert.equal(result.metadataCorrected, undefined)
    assert.deepEqual(result, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2, bandsChecked: ['t2-r1', 't2-r2'] })
    // selfheal.12 (GT-20): a clean scrub is where the corrected-metadata
    // signal alone lives, so the window is still read — for that count only,
    // through the same bounded grep — while nothing is probed. The journal
    // here cannot be read at all (no fixture): the -g attempt plus its
    // no-PCRE2 fallback, no count, no notification.
    const journalCalls = clean.calls.filter(c => c.command === '/usr/bin/journalctl')
    assert.equal(journalCalls.length, 2)
    assert.equal(journalCalls[0].args[journalCalls[0].args.indexOf('-g') + 1], 'error at logical|read error corrected')
    assert.ok(!clean.calls.some(c => c.command === '/usr/bin/dd'))
  })

  /** A kernel scrub warning for one file, in the drill's exact shape. */
  function warning(root: number, inode: number, logical: number, path: string): string {
    return `BTRFS warning (device dm-0): scrub: checksum error at logical ${logical} `
      + `on dev /dev/mapper/t2-t2--vol, physical ${logical} root ${root} inode ${inode} `
      + `offset 1179648 length 4096 links 1 (path: ${path})`
  }

  it('a NESTED subvolume keeps its remainder, and a SNAPSHOT is reported outside the mount', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmnt('/@data'), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([
      warning(257, 300, 20000000, '2026/a.jpg'),
      warning(258, 301, 21000000, 'f1.bin'),
    ]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '257', MOUNTPOINT], result: { stdout: '@data/photos\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '258', MOUNTPOINT], result: { stdout: '@snapshots/nightly\n', stderr: '', exitCode: 0 } })
    const NESTED = `${MOUNTPOINT}/photos/2026/a.jpg`
    e.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', NESTED], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(e, scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    // `@data/photos` under a mounted `@data` is <mountpoint>/photos — the PATH
    // is what this case is about. No mapping is wired, so the blocks inside it
    // are honestly not identified (see the unresolvable-stripe case).
    assert.equal(result.findings?.[0].path, NESTED)
    assert.deepEqual(result.findings?.[0].badBlocks, [])
    assert.equal(result.findings?.[0].unidentified, true)
    assert.equal(result.findings?.[0].outsideMount, undefined)

    // `@snapshots/nightly` has NO path under the mountpoint: reported
    // filesystem-relative, flagged, and never probed at a path that is not it.
    assert.equal(result.findings?.[1].path, '@snapshots/nightly/f1.bin')
    assert.equal(result.findings?.[1].outsideMount, true)
    assert.equal(result.findings?.[1].missing, undefined, 'outside the mount is not "deleted"')
    assert.deepEqual(result.findings?.[1].badBlocks, [])
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/stat').length, 1, 'the snapshot path is never stat-ed')
    assert.ok(!e.calls.some(c => c.command === '/usr/bin/dd' && c.args[0].includes('@snapshots')))

    const body = e.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('in a snapshot, outside the mounted tree'), body)
  })

  it('a FLAT pool mounts the top level — the resolved subvolume IS a directory under it', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmnt('/'), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([GT3_LINES[0]]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    const FLAT = `${MOUNTPOINT}/@data/f1.bin`
    e.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', FLAT], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    const flat = pool()
    flat.subvolLayout = false
    const result = await liveScrubPass(e, scrubAhrPool(e, flat, () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.findings?.[0].path, FLAT)
    assert.equal(result.findings?.[0].outsideMount, undefined)
    // The path is the subject here; with no mapping wired the blocks inside it
    // are not identified.
    assert.equal(result.findings?.[0].unidentified, true)
    // The window WAS probed (F6) — every block of it read back fine, so there
    // is nothing to name and the finding says so.
    assert.deepEqual(result.findings?.[0].badBlocks, [])
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/dd').length, 16)
  })

  it('an unreadable mount table falls back to the pool\'s own subvolLayout reading', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([GT3_LINES[0]]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    // No findmnt fixture: the mock answers 127. The pool says subvolLayout —
    // which is the SAME mount reading, one hop earlier — so the path still
    // resolves under the mounted @data.
    e.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F1], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(e, scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.findings?.[0].path, F1)
  })
})

describe('AhrScrubResult schema (shared, additive)', () => {
  it('still parses a result from a daemon that knew nothing of findings', () => {
    const old = AhrScrubResult.parse({ scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
    assert.deepEqual(old, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
  })

  it('round-trips a full finding through JSON unchanged', () => {
    const full = {
      scrubbed: 't2',
      btrfsErrors: 'csum=2',
      checkedArrays: 2,
      findings: [
        {
          path: '/mnt/anas-ahr/t2/@data/f1.bin',
          subvolume: '@data',
          inode: 257,
          stripes: [{ logical: 14811136, offset: 1179648, length: 4096 }],
          badBlocks: [300],
        },
        {
          path: '/mnt/anas-ahr/t2/@data/gone.bin',
          subvolume: '@data',
          inode: 258,
          stripes: [{ logical: 19005440, offset: 1179648, length: 4096 }],
          badBlocks: [],
          missing: true,
        },
        // selfheal.8 — a compressed finding names its extent's block range;
        // an unidentified one says plainly that no block could be named.
        {
          path: '/mnt/anas-ahr/t2/@data/comp/text.bin',
          subvolume: '@data',
          inode: 259,
          stripes: [{ logical: 953155584, offset: 0, length: 4096 }],
          badBlocks: [32, 33, 34],
          compressed: true,
          extentBlocks: { first: 32, count: 32 },
        },
        {
          path: '/mnt/anas-ahr/t2/@data/comp/other.bin',
          subvolume: '@data',
          inode: 260,
          stripes: [{ logical: 953283584, offset: 0, length: 4096 }],
          badBlocks: [],
          unidentified: true,
          reason: 'no block failed on re-read: either the file changed since the scrub, or the read was served from cache',
        },
        // T7 — blocks WERE named, in a window the mapping could not verify.
        // Both facts ride the same finding: `reason` is no longer gated on an
        // empty `badBlocks`, and `probedUnverified` says the search window
        // itself is not known to have been the right one.
        {
          path: '/mnt/anas-ahr/t2/@data/comp/partial.bin',
          subvolume: '@data',
          inode: 261,
          stripes: [{ logical: 953417728, offset: 0, length: 4096 }],
          badBlocks: [5],
          reason: 'extent could not be resolved (btrfs dump-tree -r /dev/t2/t2-vol failed)',
          probedUnverified: true,
        },
      ],
      errorsReported: 2,
      errorsAttributed: 2,
      unattributed: 0,
      truncated: false,
    }
    assert.deepEqual(AhrScrubResult.parse(JSON.parse(JSON.stringify(full))), full)
  })

  it('refuses a negative count and a finding without its stripes', () => {
    assert.equal(AhrScrubResult.safeParse({ scrubbed: 't2', btrfsErrors: null, checkedArrays: -1 }).success, false)
    assert.equal(AhrScrubResult.safeParse({
      scrubbed: 't2',
      btrfsErrors: 'csum=1',
      checkedArrays: 1,
      findings: [{ path: '/x', subvolume: '@data', inode: 1, badBlocks: [] }],
    }).success, false)
  })
})

/**
 * Story selfheal.8 — a COMPRESSED file's finding names its bad blocks, or says
 * plainly that it cannot.
 *
 * The kernel's scrub warning for a compressed extent reports `offset` relative
 * to the extent, not the file, and names the 64 KiB stripe the failing blob
 * sits in — neither says which extent inside the stripe it was. Every input
 * below is the verbatim capture of a live rig that did exactly this (a 2 MiB
 * compressed file, one blob overwritten, one scrub — see
 * fixtures/selfheal/PROVENANCE.md): the kernel line from
 * `fixtures/ahr/scrub-dmesg-compressed.txt`, the extent tree, the file tree
 * and the roots from `fixtures/selfheal/dump-tree-*compressed.txt`. The
 * mapping itself is resolved through the selfheal.5 engine's helpers — the
 * same code the repair runs on.
 */
describe('scrubAhrPool — compressed-extent findings (selfheal.8)', () => {
  const COMPRESSED_DMESG = readFileSync(join(fixturesDir, 'scrub-dmesg-compressed.txt'), 'utf-8')
    .split('\n')
    .filter(l => l.trim() !== '')
  // The scrub warning line — the read-time `csum failed` lines around it are
  // part of the capture and parse to nothing, as on a real journal.
  const SCRUB_LINE = COMPRESSED_DMESG.find(l => l.includes('scrub: checksum error'))!
  const F = `${MOUNTPOINT}/f.bin`
  const selfhealFixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/selfheal')
  const selfhealFixture = (name: string): string => readFileSync(join(selfhealFixtures, name), 'utf-8')

  /**
   * The rig's md geometry files, as REAL files in a temp tree — the engine's
   * sysfs reads go through node:fs with `ANAS_SELFHEAL_KERNEL_ROOT` as the
   * prefix (selfheal-io), and `resolveContext` needs a geometry to finish.
   */
  let kernelRoot: string | null = null
  const realKernelRoot = process.env.ANAS_SELFHEAL_KERNEL_ROOT
  const realRuntimeDir = process.env.ANAS_SELFHEAL_RUNTIME_DIR

  after(() => {
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = realKernelRoot
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = realRuntimeDir
    if (kernelRoot)
      rmSync(kernelRoot, { recursive: true, force: true })
  })

  /** Write the rig's sysfs capture into the kernel-root temp tree, once. */
  function useKernelRoot(): void {
    if (kernelRoot)
      return
    kernelRoot = mkdtempSync(join(tmpdir(), 'anas-sh8-'))
    const sys = join(kernelRoot, 'sys/block/md127/md')
    mkdirSync(sys, { recursive: true })
    for (const line of selfhealFixture('md-sysfs-raid5.txt').split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0 || line.slice(eq + 1) === '<absent>')
        continue
      const path = join(sys, line.slice(0, eq))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${line.slice(eq + 1)}\n`)
    }
    // D9: the attribution's compressed probe drops the page cache through the
    // engine's own helper, which writes `/proc/sys/vm/drop_caches` under the
    // same kernel root. Give it a real file so the drop is observable here.
    mkdirSync(join(kernelRoot, 'proc/sys/vm'), { recursive: true })
    writeFileSync(join(kernelRoot, 'proc/sys/vm/drop_caches'), '0')
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = kernelRoot
    process.env.ANAS_SELFHEAL_RUNTIME_DIR ??= join(kernelRoot, 'run')
  }

  /** Journalctl -o json envelopes around the captured kernel lines. */
  function journal(lines: string[]): string {
    return `${lines.map(l => JSON.stringify({ _TRANSPORT: 'kernel', MESSAGE: l })).join('\n')}\n`
  }

  /** `findmnt --json --real <mountpoint>` for the pool mounted `subvol=/@data`. */
  function findmntJson(subvol: string): string {
    return `${JSON.stringify({
      filesystems: [{
        target: MOUNTPOINT,
        source: `/dev/loop0[${subvol}]`,
        fstype: 'btrfs',
        options: `rw,relatime,space_cache=v2,subvol=${subvol}`,
      }],
    })}\n`
  }

  /**
   * The whole scrub, on an executor whose mapping layer answers with the
   * rig's captured trees: phase 1, the btrfs scrub, the journal with the
   * verbatim scrub warning, and everything `resolveContext` reads.
   */
  function compressedExecutor(dm?: { table: string, bands: { majmin: string, kernel: string }[] }): MockExecutor {
    useKernelRoot()
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal(COMPRESSED_DMESG), stderr: '', exitCode: 0 } })
    // The pool LV resolves to the rig's loop device — the device the kernel
    // lines name, so the journal filter keeps them.
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/loop0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmntJson('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F], result: { stdout: '2097152\n', stderr: '', exitCode: 0 } })
    // The probe: every block of the file reads, unless a test says otherwise.
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })
    // --- what resolveContext and the tree walks read (selfheal-map) ---
    mappingFixtures(executor, '/dev/loop0', {
      roots: 'dump-tree-roots-compressed.txt',
      extentLeaf: 'dump-tree-extent.txt',
      subvolLeaf: 'dump-tree-subvol-compressed.txt',
    }, dm)
    return executor
  }

  /** The corrupt extent's 32 file blocks read back EIO — the blob is junk. */
  function corruptExtent(executor: MockExecutor): void {
    for (let block = 32; block < 64; block++) {
      executor.addFixture({
        command: '/usr/bin/dd',
        args: probeArgs(F, block),
        result: { stdout: '', stderr: 'dd: error reading', exitCode: 1 },
      })
    }
  }

  it('a compressed extent is probed over its REAL file range and names every failing block', async () => {
    const executor = compressedExecutor()
    corruptExtent(executor)

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const finding = result.findings?.[0]
    assert.equal(finding?.path, F)
    assert.deepEqual(finding?.stripes, [{ logical: 13631488, offset: 0, length: 4096 }])
    // One corrupt 4 KiB blob takes out its whole 128 KiB logical extent
    // (GT-9b): blocks 32..63, the extent starting at file offset 131072 —
    // NOT the blocks at the kernel's `offset 0`.
    assert.deepEqual(finding?.badBlocks, Array.from({ length: 32 }, (_, i) => 32 + i))
    assert.equal(finding?.compressed, true)
    assert.deepEqual(finding?.extentBlocks, { first: 32, count: 32 })
    assert.equal(finding?.unidentified, undefined)
    // T7: the mapping resolved the window, so there is nothing to qualify.
    assert.equal(finding?.probedUnverified, undefined)
    assert.equal(finding?.reason, undefined)

    // The probe read the file's whole extent range — every one of the 16
    // compressed blobs lives inside the one named stripe — and nothing at the
    // kernel-offset stripe alone.
    const dd = executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F}`)
    assert.equal(dd.length, 512)
    assert.deepEqual(dd.map(c => c.args[3]), Array.from({ length: 512 }, (_, i) => `skip=${i}`))

    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('compressed extent, 32 blocks'), body)
  })

  it('drops the page cache BEFORE a compressed extent\'s probe reads (D9)', async () => {
    const executor = compressedExecutor()
    corruptExtent(executor)
    writeFileSync(join(kernelRoot!, 'proc/sys/vm/drop_caches'), '0')

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    // btrfs cannot do direct I/O on COMPRESSED data — the read falls back to
    // the buffered path, and a warm page would answer every probe "fine". The
    // engine's cold read drops the cache for this reason; so does the probe
    // now, from the SAME helper.
    const syncAt = executor.calls.findIndex(c => c.command === '/usr/bin/sync')
    const firstProbe = executor.calls.findIndex(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F}`)
    assert.ok(syncAt >= 0, 'the page cache is dropped')
    assert.ok(firstProbe >= 0, 'the extent is probed')
    assert.ok(syncAt < firstProbe, `dropped at ${syncAt}, first probe at ${firstProbe}`)
    assert.equal(readFileSync(join(kernelRoot!, 'proc/sys/vm/drop_caches'), 'utf-8').trim(), '3')
    // ONCE, not once per extent — the attribution reads are tiny but the drop
    // is node-wide.
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/sync').length, 1)
  })

  it('an all-UNCOMPRESSED stripe never drops the page cache — O_DIRECT is enough there (D9)', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmntJson('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/loop0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([SCRUB_LINE]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F], result: { stdout: '2097152\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/sync').length, 0)
  })

  it('nothing in the resolved range failing is said plainly — never an empty badBlocks that reads as nothing found', async () => {
    const executor = compressedExecutor()

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const finding = result.findings?.[0]
    assert.deepEqual(finding?.badBlocks, [])
    assert.equal(finding?.unidentified, true)
    // D9: the sentence states the AMBIGUITY — a warm cache reads as "fine"
    // just as a changed file does, and the scrub never claims which.
    assert.match(finding?.reason ?? '', /no block failed on re-read: either the file changed since the scrub, or the read was served from cache/)
    assert.doesNotMatch(finding?.reason ?? '', /repaired/)
    // The probe still happened — this is "looked and found nothing", not
    // "never looked".
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F}`).length, 512)

    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('block not identified'), body)
  })

  /**
   * F6 (second pass). With the mapping unavailable the stripe is STILL probed
   * at the kernel's printed offset. A probe reads the FILE with O_DIRECT, so a
   * block that comes back EIO is a block of this file that genuinely cannot be
   * read — the wrong window costs a miss, never a false accusation, and for an
   * uncompressed extent the kernel's offset is exact (GT-3). The earlier cut
   * dropped the probe and voided the WHOLE pool's findings whenever the mapping
   * was unavailable for any reason at all.
   */
  /**
   * T7 (third pass) is the other half of F6: the probe's window was never
   * verified, and the finding has to SAY so. For a compressed extent the
   * kernel's offset names the wrong 64 KiB, so bad blocks outside it are
   * simply not looked for — and `reason` used to be attached only when
   * `badBlocks` was empty, so one lucky stripe erased the reason every other
   * stripe of the file had for finding nothing.
   */
  it('a stripe whose mapping is unavailable is still probed at the kernel offset — a block that EIOs there is real, and the window is marked unverified', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([SCRUB_LINE]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/loop0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmntJson('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F], result: { stdout: '2097152\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({
      command: '/usr/bin/dd',
      args: probeArgs(F, 5),
      result: { stdout: '', stderr: 'dd: error reading', exitCode: 1 },
    })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const finding = result.findings?.[0]
    assert.equal(finding?.path, F)
    assert.deepEqual(finding?.badBlocks, [5], 'the failing block of the named stripe is reported')
    assert.equal(finding?.compressed, undefined, 'an unresolved stripe claims no compression')
    assert.equal(finding?.unidentified, undefined, 'a block was named, so the finding is not unidentified')
    // T7: a block WAS found, and the window it was found in is still unverified
    // — both facts survive, so the list is not read as the whole file's story.
    assert.equal(finding?.probedUnverified, true)
    assert.match(finding?.reason ?? '', /extent could not be resolved/)
    // The 16 blocks of the named 64 KiB stripe, and nothing else.
    const dd = executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F}`)
    assert.deepEqual(dd.map(c => c.args[3]), Array.from({ length: 16 }, (_, i) => `skip=${i}`))
    // T7's fact reaches the reader (fourth pass): blocks found in an
    // UNVERIFIED window are named, and the window says so beside them.
    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes(` (search window unverified: `), body)
    assert.match(body, /search window unverified: extent could not be resolved/)
  })

  // The compressed case with the mapping down: the kernel's offset is
  // extent-relative, so the probed window is the wrong one and nothing in it
  // fails — which is a MISS, and is reported as `unidentified` with the mapping
  // error rather than an empty badBlocks that reads as "nothing wrong here".
  it('unresolvable AND nothing failing → unidentified, with the mapping error as the reason', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([SCRUB_LINE]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/loop0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmntJson('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F], result: { stdout: '2097152\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const finding = result.findings?.[0]
    assert.deepEqual(finding?.badBlocks, [])
    assert.equal(finding?.unidentified, true)
    assert.match(finding?.reason ?? '', /extent could not be resolved/)
    assert.equal(finding?.probedUnverified, true, 'the window it looked in was never verified either')
    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('block not identified'), body)
    // The unidentified arm already names the reason as its block text — the
    // unverified suffix must not print the same reason a second time (fourth pass).
    assert.ok(!body.includes('search window unverified'), body)
  })

  /**
   * F6 (second pass), the other half. R1 made `resolveContext` throw for any
   * band whose geometry is momentarily unreadable — and the attribution's
   * mapping is built ONCE per pass, so one bad band left every file of the
   * pool `unidentified` with no blocks and nothing to repair. Band geometry is
   * resolved lazily now: the attribution walks the btrfs trees, which need no
   * band at all, and only a byte actually placed ON the bad band fails.
   */
  it('one band with no readable geometry does not void the whole pool\'s findings', async () => {
    // The LV is TWO linear segments (the live two-band capture) — and band 2
    // on 9:126 has NO md sysfs in the kernel root, so its geometry cannot be
    // read at all. Pre-fix that threw out of `resolveContext` and took the
    // btrfs tree roots with it.
    const executor = compressedExecutor({
      table: 'twoband-dmsetup-table-lv.txt',
      bands: [{ majmin: '9:127', kernel: 'md127' }, { majmin: '9:126', kernel: 'md126' }],
    })
    corruptExtent(executor)

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    const finding = result.findings?.[0]
    assert.equal(finding?.path, F)
    assert.equal(finding?.unidentified, undefined, 'the mapping still answered for this stripe')
    assert.equal(finding?.compressed, true)
    assert.deepEqual(finding?.badBlocks, Array.from({ length: 32 }, (_, i) => 32 + i))
  })

  it('the verbatim scrub warning parses field for field — the F3 shape, captured again', () => {
    assert.deepEqual(parseScrubWarning(SCRUB_LINE), {
      device: 'loop0',
      logical: 13631488,
      dev: '/dev/loop0',
      physical: 13631488,
      root: 256,
      inode: 257,
      offset: 0,
      length: 4096,
      links: 1,
      path: 'f.bin',
    })
  })
})

/**
 * S6 — the node-wide check exclusion.
 *
 * Every other "already scrubbing" refusal is in-process: the pool state a
 * topology read reports, and the job queue's own record. Neither survives a
 * daemon restart. A restart mid-scrub leaves md's check on band r1 running
 * happily while the job that issued it is gone, and the next scrub then issues
 * checks on bands that share spindles with it — exactly what §4 exists to
 * prevent. And a check on ANOTHER POOL's band is invisible to the requested
 * pool's state no matter what: on a real node those bands are very often
 * slices of the same disks.
 */
describe('runningAhrCheck — an md check anywhere on the node\'s AHR bands', () => {
  function poolWith(name: string, bands: { band: number, kernelName?: string }[]): AhrPool {
    return { name, arrays: bands.map(b => ({ band: b.band, kernelName: b.kernelName })) } as unknown as AhrPool
  }

  function executorWith(text: string): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: text, stderr: '', exitCode: 0 } })
    return executor
  }

  const CHECKING = [
    'Personalities : [raid1] [raid5]',
    'md126 : active raid1 sdd2[1] sdc2[0]',
    '      523200 blocks super 1.2 [2/2] [UU]',
    '      [============>........]  check = 61.9% (323840/523200) finish=0.3min speed=53973K/sec',
    '',
    'md127 : active raid5 sdd1[3] sdc1[1] sdb1[0]',
    '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
    '',
    'unused devices: <none>',
    '',
  ].join('\n')

  const DELAYED = [
    'Personalities : [raid5]',
    'md126 : active raid5 sdd1[3] sdc1[1] sdb1[0]',
    '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
    '      \tresync=DELAYED',
    '',
    'unused devices: <none>',
    '',
  ].join('\n')

  it('finds a check running on ANOTHER pool\'s band — the shared-spindle case', async () => {
    const found = await runningAhrCheck(executorWith(CHECKING), [
      poolWith('tank', [{ band: 1, kernelName: 'md127' }]),
      poolWith('scratch', [{ band: 1, kernelName: 'md126' }]),
    ])
    assert.deepEqual(found, { label: 'scratch-r1', kernelName: 'md126' })
  })

  it('counts a DELAYED check — md has it queued and it will fire', async () => {
    const found = await runningAhrCheck(executorWith(DELAYED), [poolWith('tank', [{ band: 2, kernelName: 'md126' }])])
    assert.equal(found?.label, 'tank-r2')
  })

  it('ignores an md array that is not an AHR band', async () => {
    const found = await runningAhrCheck(executorWith(CHECKING), [poolWith('tank', [{ band: 1, kernelName: 'md127' }])])
    assert.equal(found, null, 'md126 belongs to nothing ANAS manages')
  })

  it('reads mdstat ONCE, and not at all when no band has a kernel name', async () => {
    const executor = executorWith(CHECKING)
    await runningAhrCheck(executor, [poolWith('tank', [{ band: 1, kernelName: 'md127' }])])
    assert.equal(executor.calls.filter(c => c.args[0] === '/proc/mdstat').length, 1)

    const cold = executorWith(CHECKING)
    assert.equal(await runningAhrCheck(cold, [poolWith('tank', [{ band: 1 }])]), null)
    assert.equal(cold.calls.length, 0, 'nothing to match against — no read at all')
  })
})

/**
 * Design review 2026-09-14, D1/D8 — the scrub's per-band record and the
 * notification taxonomy that closes on it:
 *
 *  - `parityMismatches` rides the result; the parity-only second notification
 *    fires EXACTLY when phase 2 named no file (mismatch without attribution),
 *    not when a file was named (the findings notification closes that story).
 *  - `checkedArrays` counts bands ACTUALLY checked; `bandsSkipped` names the
 *    rest with the why, and a clean-but-incomplete scrub is not silent.
 */
describe('scrub per-band record and notifications (D1/D8)', () => {
  /** The journalctl -o json envelope around kernel lines (as the scrub reads it). */
  function journalOf(lines: string[]): string {
    return `${lines.map(l => JSON.stringify({ _TRANSPORT: 'kernel', MESSAGE: l })).join('\n')}\n`
  }

  /** `findmnt --json --real <mountpoint>` for the §12 pool mounted at @data. */
  function findmntAt(subvol: string): string {
    return `${JSON.stringify({
      filesystems: [{
        target: MOUNTPOINT,
        source: `/dev/mapper/t2-t2--vol[${subvol}]`,
        fstype: 'btrfs',
        options: `rw,relatime,space_cache=v2,subvol=${subvol}`,
      }],
    })}\n`
  }

  /** Phase 1 on t2-r1 counts 8 mismatches; t2-r2 is clean. */
  function rotExecutor(btrfsSummary?: string): MockExecutor {
    const executor = cleanCounters(baseExecutor(), 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', btrfsSummary ? { summary: btrfsSummary } : undefined), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/mismatch_cnt'], result: { stdout: '8\n', stderr: '', exitCode: 0 } })
    return executor
  }

  /** The attribution path for ONE named file (the light shape: path, no blocks). */
  function namedFinding(executor: MockExecutor): void {
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmntAt('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journalOf([
      `BTRFS warning (device dm-0): scrub: checksum error at logical 20000000 `
      + `on dev /dev/mapper/t2-t2--vol, physical 20000000 root 257 inode 300 `
      + `offset 1179648 length 4096 links 1 (path: f1.bin)`,
    ]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '257', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', `${MOUNTPOINT}/f1.bin`], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })
  }

  it('parity mismatch AND a named file: ONE notification — the findings story closes the scrub', async () => {
    const executor = rotExecutor('csum=2')
    namedFinding(executor)

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    // The record carries the parity mismatch even though a file was named —
    // with the band's LEVEL, which is what says whether Rewrite parity applies
    // to it at all (sixth pass, N1).
    assert.deepEqual(result.parityMismatches, [{ band: 't2-r1', bandIndex: 1, array: '/dev/md/t2-r1', mismatchCnt: 8, level: 'raid1' }])
    assert.deepEqual(result.bandsChecked, ['t2-r1', 't2-r2'])
    assert.ok(result.findings && result.findings.length > 0, 'the file is named')

    const warns = executor.calls.filter(c => c.command === '/usr/bin/perl')
    // The immediate per-band warning rides the phase boundary; the findings
    // notification closes the story — no third, parity-only one.
    assert.equal(warns.length, 2)
    assert.equal(warns[0].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.equal(warns[1].args[3], 'AHR scrub found errors')
    assert.ok(warns[1].args[4].includes('f1.bin'))
  })

  it('parity mismatch and errors that name NO file: the second notification refuses to call the data clean', async () => {
    const executor = rotExecutor('csum=2')
    // Errors reported (csum=2) but the journal gives nothing to attribute.
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.btrfsErrors, 'csum=2')

    const warns = executor.calls.filter(c => c.command === '/usr/bin/perl')
    // The immediate per-band warning, then the findings notification, then the
    // parity one that refuses the dataClean claim.
    assert.equal(warns.length, 3)
    assert.equal(warns[0].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.equal(warns[1].args[3], 'AHR scrub found errors')
    assert.equal(warns[2].args[3], 'AHR scrub: parity mismatch on t2-r1')
    assert.ok(warns[2].args[4].includes('cannot tell whether the rot is in parity or in data'), warns[2].args[4])
    // N6: the parity ASSERTION belongs only to the clean arm — this one does
    // not know where the rot is, so it must not claim the parity member…
    assert.ok(!warns[2].args[4].includes('The rot is in the PARITY'), warns[2].args[4])
    // …and it says what to do FIRST rather than offering the verb.
    assert.ok(warns[2].args[4].includes('Do the data first'), warns[2].args[4])
    assert.ok(warns[2].args[4].includes('scrub pool \'t2\' again'), warns[2].args[4])
    assert.ok(warns[2].args[4].includes('Rewrite parity is refused while a finding stands'), warns[2].args[4])
    assert.ok(!warns[2].args[4].includes('Nothing in ANAS repairs parity'), warns[2].args[4])
  })

  it('a band md never started is recorded, not coverage — checkedArrays stays honest', async () => {
    const executor = rotExecutor()
    // md stays idle on r1: it never took the check.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/last_sync_action'], result: { stdout: 'resync\n', stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))

    assert.equal(result.checkedArrays, 1, 'one band checked, not two')
    assert.deepEqual(result.bandsChecked, ['t2-r2'])
    assert.deepEqual(result.bandsSkipped, [{ band: 't2-r1', reason: 'md never started the check' }])

    const warns = executor.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(warns.length, 1, 'a clean-but-incomplete scrub is not silent (D8)')
    assert.equal(warns[0].args[3], 'AHR scrub did not check every band')
    assert.ok(warns[0].args[4].includes('t2-r1 was not checked: md never started the check'), warns[0].args[4])
  })

  it('a band whose mismatch_cnt cannot be READ is a skip, not coverage (N12)', async () => {
    // The check RAN — md took it and went idle — but nothing came back from
    // it, so the band has no verdict: no clean bill, and no finding either.
    // Counting it in `checkedArrays` is the same false assurance D8 closed for
    // the bands that were never checked at all.
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: mismatchCntArgs('md127'), result: { stdout: '', stderr: 'No such file', exitCode: 1 } })
    cleanCounters(executor, 'md126')

    const progress: string[] = []
    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1, mismatchDelayMs: 1 }))

    assert.equal(result.checkedArrays, 1, 'only the band with a verdict counts')
    assert.deepEqual(result.bandsChecked, ['t2-r2'])
    assert.deepEqual(result.bandsSkipped, [{ band: 't2-r1', reason: 'checked, but its mismatch_cnt could not be read' }])
    assert.ok(progress.some(m => m.includes('t2-r1 was checked, but its mismatch_cnt could not be read')), progress.join(' | '))
    // And the operator is told — a clean-but-incomplete scrub is not silent (D8).
    const warns = executor.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(warns.length, 1)
    assert.equal(warns[0].args[3], 'AHR scrub did not check every band')
  })

  it('retires every band\'s issued-check token, so a later FOREIGN check is never ours (N3)', async () => {
    // `markCheckIssued` is what licenses `echo idle > sync_action` (D2), and it
    // used to be taken back ONLY on the abandonment path. A scrub that finished
    // normally left both bands' tokens in the set for the life of the daemon —
    // and then mdcheck's own check on one of those arrays read as ours, and the
    // next thing to ask would have written `idle` over it.
    forgetIssuedChecks()
    const executor = cleanCounters(baseExecutor(), 'md127', 'md126')
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.checkedArrays, 2, 'a clean two-band scrub — the ordinary success path')
    assert.equal(hasIssuedCheck('md127'), false, 'the token does not outlive the band that took it')
    assert.equal(hasIssuedCheck('md126'), false)

    // The leaked-entry consequence, at the one function that decides it: with
    // no token, a `check` on that array is FOREIGN and nothing may end it.
    const own = await ownsSyncOp('md127', async () => 'check')
    assert.equal(own.owned, false, 'mdcheck\'s check is not this daemon\'s to end')
    assert.equal(own.foreign, true)
  })

  it('retires the token on the SKIP paths too — md never started the check (N3)', async () => {
    forgetIssuedChecks()
    const executor = rotExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/sync_action'], result: { stdout: 'idle\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/sys/block/md127/md/last_sync_action'], result: { stdout: 'resync\n', stderr: '', exitCode: 0 } })

    await liveScrubPass(executor, scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1, checkStartTimeoutMs: 20 }))
    assert.equal(hasIssuedCheck('md127'), false)
    assert.equal(hasIssuedCheck('md126'), false)
  })

  it('the new record fields round-trip the shared schema — and stay optional', () => {
    // The parity-only-rot shape, exactly as the service assembles it.
    const rot = AhrScrubResult.parse({
      scrubbed: 't2',
      btrfsErrors: null,
      checkedArrays: 1,
      bandsChecked: ['t2-r2'],
      bandsSkipped: [{ band: 't2-r1', reason: 'md never started the check' }],
      parityMismatches: [{ band: 't2-r1', bandIndex: 1, array: '/dev/md/t2-r1', mismatchCnt: 8 }],
    })
    assert.deepEqual(rot.parityMismatches, [{ band: 't2-r1', bandIndex: 1, array: '/dev/md/t2-r1', mismatchCnt: 8 }])
    assert.deepEqual(rot.bandsSkipped, [{ band: 't2-r1', reason: 'md never started the check' }])

    // A pre-existing consumer's shape (no record fields) still validates —
    // additive-optional, the version-skew rule.
    const legacy = AhrScrubResult.parse({ scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
    assert.equal(legacy.parityMismatches, undefined)
    assert.equal(legacy.bandsSkipped, undefined)
    assert.equal(legacy.bandsChecked, undefined)
  })
})

describe('corrected metadata reads (selfheal.12, GT-20)', () => {
  // GT-20's verbatim capture (docs/AHR-SELF-HEAL-GROUND-TRUTH.md, stage (b)):
  // the RW mount's read path repaired a rotten DUP metadata copy from its
  // mirror, and `btrfs scrub` on the already-repaired array reported 0.
  const GT20_CORRECTED
    = 'BTRFS info (device dm-0): read error corrected: ino 0 off 30834688 (dev /dev/mapper/gtsh-data sector 76608)'

  function journal(lines: string[]): string {
    return `${lines.map(l => JSON.stringify({ _TRANSPORT: 'kernel', MESSAGE: l })).join('\n')}\n`
  }

  it('parses the GT-20 line field for field, in both kernel spellings', () => {
    const line = parseCorrectedRead(GT20_CORRECTED)
    assert.deepEqual(line, {
      device: 'dm-0',
      ino: 0,
      offset: 30834688,
      dev: '/dev/mapper/gtsh-data',
      sector: 76608,
    })
    // The kind word is open (`info`/`warning`), a dmesg stamp is tolerated,
    // and an intermediate parenthetical after `corrected` does not blind it.
    assert.deepEqual(
      parseCorrectedRead(`[ 3455.495994] ${GT20_CORRECTED.replace('BTRFS info', 'BTRFS warning')}`)?.dev,
      '/dev/mapper/gtsh-data',
    )
    assert.deepEqual(
      parseCorrectedRead(GT20_CORRECTED.replace('corrected: ino', 'corrected (r): ino'))?.sector,
      76608,
    )
    // A scrub checksum error line is not a corrected read.
    assert.equal(parseCorrectedRead(GT3_LINES[0]), null)
  })

  it('counts one line per correction, dedupes the devices, and keeps another pool out', () => {
    const other = 'BTRFS info (device dm-9): read error corrected: ino 5 off 99 (dev /dev/mapper/other-data sector 3)'
    const counted = correctedReadsFromMessages(
      [GT20_CORRECTED, GT20_CORRECTED.replace('sector 76608', 'sector 76609'), other, GT3_LINES[0]],
      'dm-0',
    )
    assert.deepEqual(counted, { count: 2, devices: ['/dev/mapper/gtsh-data'] })
    // Fail-open: no device filter reads every line, as the attribution does.
    assert.equal(correctedReadsFromMessages([other]).count, 1)
    assert.deepEqual(correctedReadsFromMessages([GT3_LINES[0]], 'dm-0'), { count: 0, devices: [] })
  })

  it('a clean scrub that corrected metadata says so — result and notification', async () => {
    const e = cleanCounters(baseExecutor(), 'md127', 'md126')
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([
      GT20_CORRECTED,
      'BTRFS info (device dm-9): read error corrected: ino 0 off 1 (dev /dev/mapper/other sector 2)',
    ]), stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(e, scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    // The exact GT-20 shape: a CLEAN scrub (no findings, no parity, no skips)
    // whose journal window carries the only rot evidence there is.
    assert.deepEqual(result.metadataCorrected, { count: 1, devices: ['/dev/mapper/gtsh-data'] })
    const notify = e.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(notify, 'the one signal a clean scrub holds is never silent')
    assert.equal(notify!.args[2], 'warning')
    assert.equal(notify!.args[3], 'AHR scrub: metadata corrected from the mirror')
    assert.ok(notify!.args[4].includes(
      'btrfs corrected 1 metadata read(s) from the mirror copy during this run. '
      + 'A member is returning bad metadata. Check that disk\'s SMART data in Disks.',
    ), notify!.args[4])
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/perl').length, 1, 'one notification')
  })

  it('no corrected reads: no count on the result, no sentence anywhere', async () => {
    const e = cleanCounters(baseExecutor(), 'md127', 'md126')
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([GT3_LINES[0]]), stderr: '', exitCode: 0 } })

    const result = await liveScrubPass(e, scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.metadataCorrected, undefined)
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/perl').length, 0, 'a truly clean scrub stays silent (§7.3)')
    assert.equal(metadataCorrectedSentence({ count: 3, devices: [] }).includes('btrfs corrected 3 metadata read(s)'), true)
  })

  it('the sentence rides the EXISTING notification when the scrub already found errors', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', '-B', MOUNTPOINT], live: {} })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([GT3_LINES[0], GT20_CORRECTED]), stderr: '', exitCode: 0 } })
    // No mapping wired: the finding is unidentified, the notification stands.

    const result = await liveScrubPass(e, scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1, mismatchDelayMs: 1 }))
    assert.equal(result.metadataCorrected?.count, 1)
    const body = e.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('csum=1'), 'the findings notification is unchanged')
    assert.ok(body.includes('btrfs corrected 1 metadata read(s) from the mirror copy during this run'), body)
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/perl').length, 1, 'appended, never a second one')
  })

  it('metadataCorrected round-trips the shared schema — and stays optional', () => {
    const parsed = AhrScrubResult.parse({
      scrubbed: 't2',
      btrfsErrors: null,
      checkedArrays: 2,
      metadataCorrected: { count: 2, devices: ['/dev/mapper/gtsh-data'] },
    })
    assert.deepEqual(parsed.metadataCorrected, { count: 2, devices: ['/dev/mapper/gtsh-data'] })
    const legacy = AhrScrubResult.parse({ scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
    assert.equal(legacy.metadataCorrected, undefined)
  })
})
