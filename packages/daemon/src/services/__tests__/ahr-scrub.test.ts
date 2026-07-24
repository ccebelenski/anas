import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrPool } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { parseBtrfsScrubStatus, scrubAhrPool } from '../ahr-scrub.js'

/**
 * AHR scrub — the two-phase, strictly SEQUENTIAL pass (§4): btrfs scrub
 * completes before the first md check starts; md checks run one band at a
 * time. Findings notify at warning; a clean scrub is silent (§7.3).
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
  return executor
}

describe('scrubAhrPool (Epic 11 + AHR)', () => {
  it('runs btrfs scrub to completion, THEN per-array checks sequentially; clean → silent', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
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
    const result = await scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1 })
    assert.deepEqual(result, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })

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
    // Never concurrent: btrfs finished before md; r1's check awaited before r2 starts.
    assert.ok(lastStatus < checkR1, 'btrfs scrub completes before any md check starts')
    assert.ok(checkR1 < checkR2, 'md checks run band by band')
    const waitBetween = calls.slice(checkR1 + 1, checkR2).some(c => c.command === '/usr/bin/cat')
    assert.ok(waitBetween, 'r1 check is awaited via /proc/mdstat before r2 starts')

    // Clean scrub → NO notification (dashboard policy §7.3).
    assert.ok(!calls.some(c => c.command === '/usr/bin/perl'))
    // Progress reported on every poll.
    assert.ok(progress.some(m => m.includes('42.5')))
    assert.ok(progress.some(m => m.includes('t2-r1')) && progress.some(m => m.includes('t2-r2')))
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
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
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

    const result = await scrubAhrPool(executor, stale, () => {}, { pollIntervalMs: 1 })
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
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })
    assert.equal(result.btrfsErrors, 'csum=2')

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
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
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

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })
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

  it('aborted btrfs scrub fails the job', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: scrubStatus('aborted'), stderr: '', exitCode: 0 } })
    await assert.rejects(scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 }), /aborted/)
  })

  it('refuses an unmounted pool', async () => {
    const executor = baseExecutor()
    await assert.rejects(scrubAhrPool(executor, pool('/dev/t2/t2-vol'), () => {}), /not mounted/)
    assert.equal(executor.calls.length, 0)
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
