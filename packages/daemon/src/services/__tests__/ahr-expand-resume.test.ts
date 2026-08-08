import type { AhrCapacity, AhrExpansionIntent, AhrPool, JobRef } from '@anas/shared'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { resumeExpansion } from '../ahr-expand-resume.js'
import { readIntent, writeIntent } from '../ahr-intent.js'
import { DiskIdentityCache } from '../disk-identity-cache.js'

/**
 * The §5.3 resume core (services/ahr-expand-resume.ts), driven directly —
 * the seam BOTH the operator verb (POST .../expand/resume) and the daemon
 * boot re-attach (services/ahr-boot-scan.ts) go through.
 *
 * Issue #4: a resume entered mid-reshape recomputes a plan with NOTHING in it
 * (the new disk is already an md member), so the job used to walk straight to
 * "complete", clear the intent, and orphan the LVM/filesystem grow. The plan
 * must name the work the in-flight reshape still owes.
 *
 * Same GiB-aligned synthetic "tank" as ahr-expand-exec.test.ts:
 *   band 1 [0,2GiB] raid5×3 (md127: X,Y,Z)  band 2 [2,3GiB] raid1×2 (md126: Y,Z)
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X' // 2 GiB class → sdq
const Y = 'ata-TANK_Y' // 3 GiB class → sdr
const Z = 'ata-TANK_Z' // 3 GiB class → sds

const SIZE_2G = 2 * GIB + 8 * MIB
const SIZE_3G = 3 * GIB + 8 * MIB
const GPT_TAIL = 33 * 512
const B1_INTERIOR = 2 * GIB - MIB
const B1_CLAMPED_2G = SIZE_2G - MIB - GPT_TAIL
const B2_CLAMPED_3G = SIZE_3G - GPT_TAIL - 2 * GIB

const MDSTAT_IDLE = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

// The production shape: the expansion's member is already in the array and the
// kernel reshape is hours/days from done.
const MDSTAT_RESHAPING = `Personalities : [raid1] [raid5]
md126 : active raid1 sds2[1] sdr2[0]
      1047552 blocks super 1.2 [2/2] [UU]

md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
      [>....................]  reshape =  3.5% (73330/2095104) finish=5760.0min speed=2048K/sec

unused devices: <none>
`

function exportFor(name: string, level: string, devices: number, uuid: string): string {
  return `MD_LEVEL=${level}\nMD_DEVICES=${devices}\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_DEVNAME=${name}\nMD_NAME=anas-test:${name}\n`
}

function buildExecutor(mdstat: string): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: mdstat, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: exportFor('tank-r1', 'raid5', 3, 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md126'], result: { stdout: exportFor('tank-r2', 'raid1', 2, 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb'), stderr: '', exitCode: 0 } })
  return executor
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

function mkPool(): AhrPool {
  const member = (disk: string, part: string) =>
    ({ disk, partition: `/dev/disk/by-id/${disk}-part${part}`, memberState: 'in_sync' as const })
  return {
    name: 'tank',
    ahrType: 'ahr1',
    mountpoint: '/mnt/anas-ahr/tank',
    mounted: true,
    subvolLayout: true,
    disks: [
      { id: X, sizeBytes: SIZE_2G, usableBytes: 2 * GIB, model: null, serial: null, role: 'member', partitions: [{ device: `/dev/disk/by-id/${X}-part1`, band: 1, sizeBytes: B1_CLAMPED_2G }] },
      { id: Y, sizeBytes: SIZE_3G, usableBytes: 3 * GIB, model: null, serial: null, role: 'member', partitions: [
        { device: `/dev/disk/by-id/${Y}-part1`, band: 1, sizeBytes: B1_INTERIOR },
        { device: `/dev/disk/by-id/${Y}-part2`, band: 2, sizeBytes: B2_CLAMPED_3G },
      ] },
      { id: Z, sizeBytes: SIZE_3G, usableBytes: 3 * GIB, model: null, serial: null, role: 'member', partitions: [
        { device: `/dev/disk/by-id/${Z}-part1`, band: 1, sizeBytes: B1_INTERIOR },
        { device: `/dev/disk/by-id/${Z}-part2`, band: 2, sizeBytes: B2_CLAMPED_3G },
      ] },
    ],
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

function mkIntent(): AhrExpansionIntent {
  return {
    id: randomUUID(),
    trigger: 'add-disk',
    approvedDisks: [X, Y, Z],
    before: CAP,
    after: { ...CAP, usableBytes: 6 * GIB },
    state: 'halted',
  }
}

/** A jobQueue that records the submission and NEVER runs the handler. */
function stubJobQueue(): { submitted: string[], queue: JobQueue } {
  const submitted: string[] = []
  const submit = (operation: string): JobRef => {
    submitted.push(operation)
    return { id: 'stub-job', status: 'queued', operation, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'root@pam' }
  }
  return { submitted, queue: { submit } as unknown as JobQueue }
}

const IDENTITY = { user: 'root@pam', uid: 0 }

describe('resumeExpansion — the shared §5.3 recompute-and-continue core', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-resume-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const resume = async (executor: MockExecutor) => {
    const { submitted, queue } = stubJobQueue()
    const intent = mkIntent()
    await writeIntent('tank', intent, { dir })
    const result = await resumeExpansion({
      pool: mkPool(),
      intent,
      executor,
      jobQueue: queue,
      diskCache: new DiskIdentityCache(executor),
      intentDir: dir,
      identity: IDENTITY,
    })
    return { result, submitted }
  }

  it('issue #4: a plan recomputed mid-reshape names the wait AND the size-dependent tail', async () => {
    const { result, submitted } = await resume(buildExecutor(MDSTAT_RESHAPING))
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    assert.deepEqual(submitted, ['ahr.expand.resume'])
    if (!result.ok)
      return
    // §2.3 alone plans NOTHING here (the topology already matches the approved
    // set) — that emptiness is exactly what completed in 152 ms in production.
    assert.deepEqual(result.bundle.plan.steps.map(s => s.kind), [
      'reshape-wait',
      'pv-create',
      'pv-resize',
      'vg-extend',
      'lv-extend',
      'fs-grow',
    ])
    assert.equal(result.bundle.plan.steps[0].target, 'md/tank-r1')
    assert.deepEqual(result.bundle.plan.steps.map(s => s.index), [0, 1, 2, 3, 4, 5])
    assert.equal((await readIntent('tank', dir))?.state, 'running')
  })

  it('with every array idle the recomputed plan is unchanged (no invented work)', async () => {
    const { result } = await resume(buildExecutor(MDSTAT_IDLE))
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok)
      return
    assert.deepEqual(result.bundle.plan.steps, [])
  })

  // -----------------------------------------------------------------------
  // Issue #13, from the live stage run: the reshapes FINISHED, but the job
  // died before pv-resize. §2.3 then plans nothing (arrays already match the
  // approved set), the #4 completion invariant correctly refuses to call it
  // done (13.96 vs 18 GiB delivered), and every further Resume is an identical
  // ~300 ms failure — the capacity is stranded forever. The observed evidence
  // was PV PSize < DevSize on the grown bands.
  // -----------------------------------------------------------------------
  describe('stranded PV capacity (issue #13)', () => {
    /** `pvs` reporting a PV that never grew to cover its (grown) array. */
    function withPvs(executor: MockExecutor, rows: { name: string, size: number, devSize: number }[]): MockExecutor {
      executor.addFixture({
        command: '/usr/sbin/pvs',
        result: {
          stdout: JSON.stringify({ report: [{ pv: rows.map(r => ({
            pv_name: r.name,
            vg_name: 'tank',
            pv_size: String(r.size),
            pv_free: '0',
            dev_size: String(r.devSize),
          })) }] }),
          stderr: '',
          exitCode: 0,
        },
      })
      return executor
    }

    it('THE BUG: an idle, fully-grown pool with unresized PVs plans the pv-resize catch-up', async () => {
      const executor = withPvs(buildExecutor(MDSTAT_IDLE), [
        // Band 1 grew; its PV still reports the pre-reshape size.
        { name: '/dev/md127', size: 4 * GIB, devSize: 6 * GIB },
        // Band 2 is already whole — it must NOT be given busywork.
        { name: '/dev/md126', size: GIB, devSize: GIB },
      ])
      const { result, submitted } = await resume(executor)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      assert.deepEqual(submitted, ['ahr.expand.resume'], 'the resume must actually run')
      if (!result.ok)
        return

      // Without this fix the plan is EMPTY and the resume is a permanent no-op.
      assert.deepEqual(result.bundle.plan.steps.map(s => s.kind), [
        'pv-resize',
        'vg-extend',
        'lv-extend',
        'fs-grow',
      ])
      // Only the stranded band is resized — derived from truth, not guessed.
      assert.equal(result.bundle.plan.steps[0].target, 'md/tank-r1')
      assert.deepEqual(result.bundle.plan.steps.map(s => s.index), [0, 1, 2, 3])
      assert.match(result.bundle.plan.steps[0].detail!, /capacity is stranded below LVM/)
      assert.equal((await readIntent('tank', dir))?.state, 'running')
    })

    // A healthy, fully-resized PV always sits a few MiB under its device (LVM
    // metadata + PE rounding). Real pve5 numbers, 2026-08-09 — a bare
    // `pv_size < dev_size` would plan a cosmetic pv-resize for every band.
    it('the few-MiB metadata delta of a HEALTHY PV plans nothing', async () => {
      const executor = withPvs(buildExecutor(MDSTAT_IDLE), [
        { name: '/dev/md127', size: 32005014159360, devSize: 32005018353664 },
        { name: '/dev/md126', size: 11999597559808, devSize: 11999600705536 },
      ])
      const { result } = await resume(executor)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok)
        return
      assert.deepEqual(result.bundle.plan.steps, [])
    })

    it('PVs that already cover their arrays add nothing (idempotent, no busywork)', async () => {
      const executor = withPvs(buildExecutor(MDSTAT_IDLE), [
        { name: '/dev/md127', size: 6 * GIB, devSize: 6 * GIB },
        { name: '/dev/md126', size: GIB, devSize: GIB },
      ])
      const { result } = await resume(executor)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok)
        return
      assert.deepEqual(result.bundle.plan.steps, [])
    })

    it('a mid-reshape resume is not double-planned — the in-flight tail already covers it', async () => {
      // Both augmentations could fire here; the pv one must defer to the sync
      // one, which already plans a pv-resize for that band.
      const executor = withPvs(buildExecutor(MDSTAT_RESHAPING), [
        { name: '/dev/md127', size: 4 * GIB, devSize: 6 * GIB },
      ])
      const { result } = await resume(executor)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok)
        return
      assert.deepEqual(result.bundle.plan.steps.map(s => s.kind), [
        'reshape-wait',
        'pv-create',
        'pv-resize',
        'vg-extend',
        'lv-extend',
        'fs-grow',
      ])
      assert.equal(result.bundle.plan.steps.filter(s => s.kind === 'pv-resize').length, 1)
    })

    it('an unreadable pvs leaves the plan alone — fail-open, never a blocked resume', async () => {
      const executor = buildExecutor(MDSTAT_IDLE)
      executor.addFixture({ command: '/usr/sbin/pvs', result: { stdout: '', stderr: 'pvs: command failed', exitCode: 5 } })
      const { result } = await resume(executor)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok)
        return
      assert.deepEqual(result.bundle.plan.steps, [])
    })
  })

  it('fails closed when md sync state cannot be read (never drives a plan that might complete mid-reshape)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: '', stderr: 'cat: /proc/mdstat: No such file', exitCode: 1 } })
    const { result, submitted } = await resume(executor)
    assert.equal(result.ok, false)
    if (result.ok)
      return
    assert.equal(result.reason, 'plan-error')
    assert.match(result.message, /could not read md sync state/)
    assert.deepEqual(submitted, [], 'nothing submitted')
    assert.equal((await readIntent('tank', dir))?.state, 'halted', 'the intent stays halted')
  })
})
