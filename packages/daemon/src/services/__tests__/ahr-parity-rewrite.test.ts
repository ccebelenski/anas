import type { Job } from '@anas/shared'
import type {
  CommandExecutor,
  ExecResult,
  ExecStreamResult,
  PipelineResult,
} from '../../executor/types.js'
import type { ParityRewriteEvidence, ParityRewritePool } from '../ahr-parity-rewrite.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AhrParityRewriteResult, AhrScrubParityMismatch } from '@anas/shared'
import {
  approximateDuration,
  PARITY_REWRITE_RATE_BYTES_S,
  parityRewriteEvidence,
  parityRewriteWarnings,
  rewriteBandParity,
} from '../ahr-parity-rewrite.js'
import { forgetIssuedChecks } from '../selfheal-syncop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

const MIB = 1024 * 1024

/**
 * Rewrite parity (story selfheal.10) — the ONE verb that runs
 * `mdadm --action=repair`, and only on the proof that the data is intact.
 *
 * The fake is a real sysfs tree in a temp directory (so every gate, every knob
 * read and the `sync_completed` poll go through the code's own md layer) plus a
 * scripted md: an operation runs for a set number of polls, then goes idle and
 * leaves a `mismatch_cnt` behind. That is enough to drive the whole sequence —
 * what the suite's case 8 proves on real loop devices is that the sequence is
 * the RIGHT one; what these prove is that it refuses everything it must.
 */
class FakeMd implements CommandExecutor {
  readonly root: string
  readonly sys: string
  readonly mountpoint: string
  readonly calls: { command: string, args: string[] }[] = []
  /** severity, title, message of every notification emitted. */
  readonly notifications: string[][] = []
  /** `Error summary:` the fresh btrfs scrub reports. */
  scrubSummary = 'no errors found'
  /** Polls an md operation runs for before it goes idle. */
  opPolls = 1
  /** What `mismatch_cnt` holds once an operation ends. */
  mismatchAfterOp = '0'
  /**
   * After this many reads of the named operation, md takes an action of its
   * own — a member failing mid-run puts the array straight into `recover`.
   */
  foreignAfter: { op: 'repair' | 'check', reads: number, action: string } | null = null
  /** Exit code `mdadm --action=<x>` returns (a band md refuses). */
  mdadmExit = 0

  private running: string | null = null
  private left = 0
  private reads = 0
  /** Which captured band this fake IS — raid5 by default, raid1 for N1. */
  private readonly level: 'raid1' | 'raid5'

  constructor(level: 'raid1' | 'raid5' = 'raid5') {
    this.level = level
    this.root = mkdtempSync(join(tmpdir(), 'anas-parity-'))
    this.sys = join(this.root, 'sys/block/md127/md')
    this.mountpoint = join(this.root, 'mnt')
    mkdirSync(this.sys, { recursive: true })
    mkdirSync(this.mountpoint, { recursive: true })
    for (const line of fixture(`md-sysfs-${level}.txt`).split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0 || line.slice(eq + 1) === '<absent>')
        continue
      const path = join(this.sys, line.slice(0, eq))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${line.slice(eq + 1)}\n`)
    }
    this.set('mismatch_cnt', '8')
    this.set('last_sync_action', 'check')
    this.set('sync_completed', '407552 / 407552')
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  knob(key: string): string {
    return readFileSync(join(this.sys, key), 'utf-8').trim()
  }

  set(key: string, value: string): void {
    writeFileSync(join(this.sys, key), `${value}\n`)
  }

  /** The pool shape the route hands in, pointed at this fake's md. */
  pool(): ParityRewritePool {
    return {
      name: 'tank',
      mountpoint: this.mountpoint,
      mounted: true,
      arrays: [{ band: 1, device: '/dev/md127', heightBytes: 200 * MIB, members: [1, 2, 3, 4, 5, 6] }],
    }
  }

  /** Every `mdadm --action=` this run issued, in order. */
  actions(): string[] {
    return this.calls
      .filter(c => c.command === '/usr/sbin/mdadm' && c.args[0].startsWith('--action='))
      .map(c => c.args[0])
  }

  /**
   * md's own clock: each read of `sync_action` while an operation runs brings
   * it one poll closer to idle, and the foreign-op injection replaces it
   * mid-flight the way a failing member does.
   */
  private tick(): void {
    if (this.running === null)
      return
    this.reads++
    if (this.foreignAfter && this.foreignAfter.op === this.running && this.reads >= this.foreignAfter.reads) {
      this.set('sync_action', this.foreignAfter.action)
      this.running = null
      return
    }
    if (--this.left > 0)
      return
    this.set('sync_action', 'idle')
    this.set('last_sync_action', this.running)
    this.set('mismatch_cnt', this.mismatchAfterOp)
    this.running = null
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

    if (command === '/usr/bin/readlink')
      return ok('/sys/devices/virtual/block/md127\n')
    if (command === '/usr/bin/cat') {
      const path = args[0]
      const value = readFileSync(join(this.root, path), 'utf-8')
      if (path.endsWith('/sync_action'))
        this.tick()
      return ok(value)
    }
    if (command === '/usr/sbin/mdadm') {
      if (args[0] === '--action=repair' || args[0] === '--action=check') {
        if (this.mdadmExit !== 0)
          return { stdout: '', stderr: 'Device or resource busy', exitCode: this.mdadmExit }
        this.running = args[0].slice('--action='.length)
        this.left = this.opPolls
        this.reads = 0
        this.set('sync_action', this.running)
        this.set('mismatch_cnt', '0') // md zeroes the counter at a sync start
        return ok()
      }
      return ok(fixture(`mdadm-detail-export-${this.level}.txt`))
    }
    if (command === '/usr/bin/btrfs') {
      if (args[1] === 'start')
        return ok()
      return ok([
        'UUID:             11111111-2222-3333-4444-555555555555',
        'Status:           finished',
        'Duration:         0:00:04',
        `Error summary:    ${this.scrubSummary}`,
        '',
      ].join('\n'))
    }
    if (command === '/usr/bin/perl') {
      this.notifications.push(args.slice(2)) // -e <body> <severity> <title> <message>
      return ok()
    }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }

  async pipeline(): Promise<PipelineResult> {
    throw new Error('no pipeline in this fake')
  }

  async execToStream(): Promise<ExecStreamResult> {
    throw new Error('no stream in this fake')
  }
}

/** The proof, as the route's lookup would hand it over. */
const PROVEN: ParityRewriteEvidence = { ok: true, mismatchCnt: 8, jobId: 'job-1' }

/** Fast polls: the fake's md is scripted, not timed. */
const FAST = { pollIntervalMs: 1, mismatchDelayMs: 1, startTimeoutMs: 50 }

describe('rewriteBandParity — the sequence', () => {
  let md: FakeMd

  beforeEach(() => {
    md = new FakeMd()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = md.root
    forgetIssuedChecks()
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    md.cleanup()
  })

  it('rewrites the band: fresh scrub, whole-band repair, verifying check, mismatch_cnt 0', async () => {
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })

    assert.equal(result.outcome, 'rewritten')
    assert.equal(result.mismatchBefore, 8, 'md\'s counter as it read before the repair')
    assert.equal(result.mismatchAfter, 0)
    assert.equal(result.array, '/dev/md127')
    assert.deepEqual(md.actions(), ['--action=repair', '--action=check'], 'repair THEN check, both whole-band')
    // The band, not a stripe: nothing narrows the window, so nothing has to
    // widen it back either.
    assert.equal(md.knob('sync_min'), '0')
    assert.equal(md.knob('sync_max'), 'max')
    // ONE notification, and it carries both counts.
    assert.equal(md.notifications.length, 1)
    const [severity, , message] = md.notifications[0]
    assert.equal(severity, 'info')
    assert.ok(message.includes('8 before, 0 after'), message)
  })

  // --- cr.38 session B: the guard's seams (WAVE3-DESIGN §3.2, §4.3) --------

  it('cr.38: re-guards before the repair and before the verifying check, and gives the key back while md runs each', async () => {
    const trace: string[] = []
    const actions = () => md.actions().length
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => PROVEN,
      reguard: async () => {
        trace.push(`reguard after ${actions()} md action(s)`)
      },
      release: () => {
        trace.push(`release after ${actions()} md action(s)`)
      },
    })
    assert.equal(result.outcome, 'rewritten')
    assert.deepEqual(trace, [
      'reguard after 0 md action(s)', // before the md write
      'release after 1 md action(s)', // md repairs; the job watches
      'reguard after 1 md action(s)', // before the verifying check
      'release after 2 md action(s)', // md checks; the job watches
    ])
  })

  it('cr.38: a refusal at the reguard before the md write is the run\'s refusal — its reason code, ONE notification, rethrown; md never repairs', async () => {
    const refusal = Object.assign(new Error('an md check is running on tank-r2 (started outside this job or by a previous daemon)'), { jobErrorCode: 'CONFLICT', refusal: { reason: 'array-busy' } })
    await assert.rejects(
      rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN, reguard: async () => Promise.reject(refusal), release: () => {} }),
      (err: unknown) => err === refusal,
    )
    assert.deepEqual(md.actions(), [], 'no repair, no check')
    assert.equal(md.notifications.length, 1)
    const [severity, title, message] = md.notifications[0]
    assert.equal(severity, 'warning')
    assert.match(title, /refused/)
    assert.match(message, /re-checked immediately before the md write; nothing was written/)
  })

  it('cr.38: a refusal at the reguard before the verifying check leaves the rewrite unproven — still-mismatched, rethrown, no check issued', async () => {
    const refusal = Object.assign(new Error('AHR pool \'tank\' is degraded'), { jobErrorCode: 'CONFLICT', refusal: { reason: 'array-busy' } })
    let calls = 0
    await assert.rejects(
      rewriteBandParity(md, md.pool(), 1, {
        ...FAST,
        evidence: () => PROVEN,
        reguard: async () => (++calls === 1 ? undefined : Promise.reject(refusal)),
        release: () => {},
      }),
      (err: unknown) => err === refusal,
    )
    assert.deepEqual(md.actions(), ['--action=repair'], 'the repair ran; the check was never issued')
    assert.equal(md.notifications.length, 1)
    assert.match(md.notifications[0][1], /still-mismatched/)
    assert.match(md.notifications[0][2], /the verifying check was not issued, so the rewrite is unproven/)
  })

  it('the fresh btrfs scrub finding anything aborts before md is touched', async () => {
    md.scrubSummary = 'csum_errors=3'
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => PROVEN,
      attributeFindings: async () => [{ path: '/mnt/tank/f1.bin', subvolume: '@data', inode: 257, stripes: [], badBlocks: [300] }],
    })

    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'data-corruption-found')
    assert.ok(result.reason?.startsWith('refused: data corruption found. Repair the data first.'), result.reason)
    assert.equal(result.btrfsErrors, 'csum_errors=3')
    assert.deepEqual(result.findings?.map(f => f.path), ['/mnt/tank/f1.bin'], 'the files are named in the result')
    assert.deepEqual(md.actions(), [], 'md was never asked to repair anything')
    assert.equal(md.notifications[0][0], 'warning')
  })

  it('refuses when the evidence says the last scrub counted no mismatch on this band', async () => {
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => ({ ok: false, code: 'no-parity-mismatch', reason: 'the last scrub counted no parity mismatch on band r1' }),
    })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'no-parity-mismatch')
    assert.deepEqual(md.actions(), [])
    assert.deepEqual(md.calls.filter(c => c.command === '/usr/bin/btrfs'), [], 'not even the scrub ran')
  })

  it('refuses when the last scrub found data corruption', async () => {
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => ({ ok: false, code: 'data-findings-present', reason: 'the last scrub of AHR pool \'tank\' found data corruption' }),
    })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'data-findings-present')
    assert.deepEqual(md.actions(), [])
  })

  it('refuses a band that is not idle, and one whose sync window is still bounded', async () => {
    md.set('sync_action', 'recover')
    const busy = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(busy.outcome, 'refused')
    assert.equal(busy.reasonCode, 'array-busy')
    assert.ok(busy.reason?.includes('recover'), busy.reason)

    md.set('sync_action', 'idle')
    md.set('sync_max', '6400')
    const bounded = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(bounded.outcome, 'refused')
    assert.equal(bounded.reasonCode, 'array-busy')
    assert.ok(bounded.reason?.includes('sync window is bounded'), bounded.reason)
    assert.deepEqual(md.actions(), [])
  })

  it('refuses a degraded band', async () => {
    md.set('degraded', '1')
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'array-busy')
    assert.ok(result.reason?.includes('degraded'), result.reason)
  })

  it('refuses while another job is in flight on the pool', async () => {
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => PROVEN,
      jobConflict: () => 'a scrub is in flight on AHR pool \'tank\' (job abc)',
    })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'job-active')
    assert.deepEqual(md.actions(), [])
  })

  it('re-checks the proof AFTER the scrub: evidence that went stale stops the write', async () => {
    let asked = 0
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => {
        asked++
        return asked === 1
          ? PROVEN
          : { ok: false, code: 'data-findings-present', reason: 'a newer scrub of AHR pool \'tank\' found data corruption' }
      },
    })
    assert.equal(asked, 2, 'asked at submit AND immediately before the md write')
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'data-findings-present')
    assert.ok(result.reason?.includes('re-checked immediately before the md write'), result.reason)
    assert.deepEqual(md.actions(), [], 'the scrub ran, md did not')
    assert.ok(result.durations.scrubMs >= 0)
  })

  it('a job submitted during the scrub also stops the write', async () => {
    let scrubbed = false
    const result = await rewriteBandParity(md, md.pool(), 1, {
      ...FAST,
      evidence: () => {
        scrubbed = md.calls.some(c => c.command === '/usr/bin/btrfs')
        return PROVEN
      },
      jobConflict: () => (scrubbed ? 'a repair is in flight on AHR pool \'tank\' (job xyz)' : null),
    })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'job-active')
    assert.deepEqual(md.actions(), [])
  })

  it('a foreign md operation replacing the repair aborts the run with every knob untouched', async () => {
    md.opPolls = 5
    md.foreignAfter = { op: 'repair', reads: 2, action: 'recover' }
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })

    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'foreign-sync-op')
    assert.ok(result.reason?.includes('recover'), result.reason)
    assert.deepEqual(md.actions(), ['--action=repair'], 'no check was issued on an array md had taken back')
    assert.equal(md.knob('sync_action'), 'recover', 'the rebuild was NOT ended')
    assert.equal(md.knob('sync_min'), '0')
    assert.equal(md.knob('sync_max'), 'max')
    assert.equal(md.notifications[0][0], 'warning')
  })

  it('a foreign operation replacing the VERIFYING CHECK leaves the rewrite unproven', async () => {
    md.opPolls = 5
    // The repair runs to the end; the CHECK is the op md takes away.
    md.foreignAfter = { op: 'check', reads: 2, action: 'recover' }
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'still-mismatched')
    assert.equal(result.reasonCode, 'foreign-sync-op')
    assert.equal(md.knob('sync_action'), 'recover')
  })

  it('a check that still counts mismatches is reported as still-mismatched, never as done', async () => {
    md.mismatchAfterOp = '8'
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'still-mismatched')
    assert.equal(result.mismatchAfter, 8)
    assert.ok(result.reason?.includes('still counts 8 mismatch'), result.reason)
    assert.equal(md.notifications[0][0], 'warning')
  })

  it('md refusing the repair is a refusal, not a rewrite', async () => {
    md.mdadmExit = 1
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'array-busy')
    assert.ok(result.reason?.includes('exited 1'), result.reason)
  })

  it('refuses a band the pool does not have, and an unmounted pool', async () => {
    const noBand = await rewriteBandParity(md, md.pool(), 4, { ...FAST, evidence: () => PROVEN })
    assert.equal(noBand.outcome, 'refused')
    assert.ok(noBand.reason?.includes('no band r4'), noBand.reason)

    const unmounted = await rewriteBandParity(md, { ...md.pool(), mounted: false }, 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(unmounted.outcome, 'refused')
    assert.ok(unmounted.reason?.includes('not mounted'), unmounted.reason)
  })

  it('an op that finished between two polls is proven by last_sync_action, not assumed', async () => {
    // md takes the op and completes it before the first read — the rig case.
    md.opPolls = 1
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'rewritten')
    assert.equal(md.knob('last_sync_action'), 'check')
  })

  it('REFUSES a RAID1 mirror band outright — md repair there is a coin flip on the good copy (N1)', async () => {
    // The fixture is the captured RAID1 band (`md-sysfs-raid1.txt`): md counts
    // legs that disagree with each other, and `repair` resolves that by copying
    // the FIRST in-sync leg over the rest without looking at which one is
    // right. On a band whose legs disagree that overwrites the good copy half
    // the time — data loss, from the verb that exists to prevent it.
    const mirror = new FakeMd('raid1')
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = mirror.root
    try {
      const result = await rewriteBandParity(mirror, mirror.pool(), 1, { ...FAST, evidence: () => PROVEN })
      assert.equal(result.outcome, 'refused')
      assert.equal(result.reasonCode, 'not-a-parity-band')
      assert.ok(result.reason?.includes('RAID1 mirror band'), result.reason)
      assert.ok(
        result.reason?.includes('arbitrated by Repair from parity per block, never by md repair'),
        result.reason,
      )
      // NOTHING was handed to md — not the repair, not the verifying check.
      assert.deepEqual(mirror.actions(), [])
      // And not even the fresh scrub: the band is wrong, so the run stops at
      // the gate rather than reading the whole pool first.
      assert.deepEqual(mirror.calls.filter(c => c.command === '/usr/bin/btrfs'), [])
    }
    finally {
      mirror.cleanup()
      process.env.ANAS_SELFHEAL_KERNEL_ROOT = md.root
    }
  })

  it('the result is the shared schema, round-trip', async () => {
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    const round = AhrParityRewriteResult.parse(JSON.parse(JSON.stringify(result)))
    assert.deepEqual(round, result)
    assert.ok(round.durations.totalMs >= 0)
  })
})

describe('parityRewriteEvidence — the proof the verb stands on', () => {
  function scrubJob(result: unknown): Job {
    return {
      id: 'job-9',
      status: 'completed',
      operation: 'ahr.scrub',
      progress: null,
      createdAt: '2026-09-13T00:00:00.000Z',
      createdBy: 'root@pam',
      startedAt: null,
      completedAt: null,
      result,
      error: null,
    }
  }

  it('no completed scrub is no proof', () => {
    const answer = parityRewriteEvidence('tank', undefined, 1)
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.code, 'no-parity-mismatch')
  })

  it('a scrub that found data corruption refuses with its own code', () => {
    const answer = parityRewriteEvidence('tank', scrubJob({ btrfsErrors: 'csum_errors=3', parityMismatches: [{ band: 'tank-r1', bandIndex: 1, array: '/dev/md/tank-r1', mismatchCnt: 8 }] }), 1)
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.code, 'data-findings-present')
    assert.ok(answer.ok === false && answer.reason.includes('csum_errors=3'))
  })

  it('a clean scrub with a mismatch on THIS band is the proof', () => {
    const answer = parityRewriteEvidence('tank', scrubJob({
      btrfsErrors: null,
      findings: [],
      parityMismatches: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md/tank-r2', mismatchCnt: 16 }, { band: 'tank-r1', bandIndex: 1, array: '/dev/md/tank-r1', mismatchCnt: 8 }],
    }), 1)
    assert.deepEqual(answer, { ok: true, mismatchCnt: 8, jobId: 'job-9' })
  })

  it('reads the row shape the SCRUB actually writes — label plus numeric index (merge seam)', () => {
    // The scrub names the band for the operator (`<pool>-r<n>`) and carries the
    // index for this verb. Parsing the row through the shared schema first is
    // the point of the test: the producer and this consumer must agree on ONE
    // shape, and the evidence gate matches the NUMBER the request body names.
    const row = AhrScrubParityMismatch.parse({ band: 'tank-r1', bandIndex: 1, array: '/dev/md/tank-r1', mismatchCnt: 8 })
    const answer = parityRewriteEvidence('tank', scrubJob({ btrfsErrors: null, findings: [], parityMismatches: [row] }), 1)
    assert.deepEqual(answer, { ok: true, mismatchCnt: 8, jobId: 'job-9' })
    // …and never matches the label's digits by accident.
    assert.equal(parityRewriteEvidence('tank', scrubJob({ btrfsErrors: null, findings: [], parityMismatches: [row] }), 2).ok, false)
  })

  it('a clean scrub with a mismatch on ANOTHER band is not', () => {
    const answer = parityRewriteEvidence('tank', scrubJob({ btrfsErrors: null, parityMismatches: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md/tank-r2', mismatchCnt: 16 }] }), 1)
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.code, 'no-parity-mismatch')
  })

  it('a scrub result with no per-band counts at all refuses rather than guessing', () => {
    // The adapter's reason for existing: a result from a daemon that did not
    // report `parityMismatches` parses fine and proves nothing.
    const answer = parityRewriteEvidence('tank', scrubJob({ btrfsErrors: null, checkedArrays: 2 }), 1)
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.code, 'no-parity-mismatch')
    assert.ok(answer.ok === false && answer.reason.includes('no per-band parity counts'))
  })
})

describe('the confirm gate\'s warnings', () => {
  const array = { band: 1, device: '/dev/md/tank-r1', heightBytes: 4 * 1024 * 1024 * 1024 * 1024, members: 5 }

  it('names what parity is recomputed from, the scrub that runs first, NOCOW, and the estimate', () => {
    const warnings = parityRewriteWarnings('tank', array)
    assert.ok(warnings.some(w => w.includes('AS IT IS NOW')), 'what parity is recomputed from')
    assert.ok(warnings.some(w => w.includes('fresh btrfs scrub') && w.includes('aborts')), 'the scrub that runs first')
    assert.ok(warnings.some(w => w.includes('NOCOW') && w.includes('preallocated')), 'the files this cannot protect')
    assert.ok(warnings.some(w => w.includes('60 MiB/s')), 'the estimate states its assumption')
    assert.ok(warnings.some(w => w.includes('never automatic')), 'never automatic')
    // 4 TiB per member at 60 MiB/s is ~19 h a pass — the warning must not
    // round that into something that reads like minutes.
    assert.ok(warnings.some(w => /\d+ h/.test(w)), warnings.join('\n'))
  })

  it('the estimate INCLUDES phase 1\'s full-pool checksum scrub (N8)', () => {
    // 30 TiB of data at the same conservative 60 MiB/s is ~145 h — an order of
    // magnitude more than the two md passes over a 4 TiB band, and the gate
    // used to quote only the md passes.
    const used = 30 * 1024 * 1024 * 1024 * 1024
    const warnings = parityRewriteWarnings('tank', array, used)
    const line = warnings.find(w => w.includes('after a full checksum scrub of the pool'))
    assert.ok(line, warnings.join('\n'))
    assert.ok(line.includes('usually the dominant term'), line)
    assert.ok(line.includes(approximateDuration(used / PARITY_REWRITE_RATE_BYTES_S)), line)

    // A pool that cannot report its used bytes says so rather than quoting a
    // number it does not have.
    const unknown = parityRewriteWarnings('tank', array).find(w => w.includes('full checksum scrub of the pool'))
    assert.ok(unknown?.includes('could not estimate'), unknown)
  })

  it('rounds an estimate the way an estimate should be read', () => {
    assert.equal(approximateDuration(42), '42 s')
    assert.equal(approximateDuration(600), '10 min')
    assert.equal(approximateDuration(3540), '59 min')
    assert.equal(approximateDuration(3600), '1 h')
    assert.equal(approximateDuration(5400), '1 h 30 min')
  })
})

/**
 * Seventh pass, F8 — a band with recorded md bad blocks is refused.
 *
 * md reconstructs nothing from a recorded bad-block range: it serves EIO there.
 * A whole-band `mdadm --action=repair` walks every stripe and recomputes parity
 * from what it reads — rows md cannot read included. Until this pass nothing in
 * the daemon read a member's `bad_blocks` at all, and this verb would have handed
 * such a band a repair regardless.
 */
describe('rewrite parity — a member with recorded bad blocks (F8)', () => {
  let md: FakeMd
  beforeEach(() => {
    forgetIssuedChecks()
    md = new FakeMd()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = md.root
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    md.cleanup()
  })

  it('REFUSES the band, names the member, and hands md nothing', async () => {
    md.set('rd2/bad_blocks', '6368 8')
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'bad-blocks-present')
    assert.ok(result.reason?.includes('recorded bad blocks'), result.reason)
    assert.ok(result.reason?.includes('Replace the member first'), result.reason)
    assert.deepEqual(md.actions(), [], 'no repair and no check were issued')
  })

  it('an EMPTY bad-block list is not a refusal — the band rewrites as it always did', async () => {
    for (let role = 0; role < 6; role++)
      md.set(`rd${role}/bad_blocks`, '')
    const result = await rewriteBandParity(md, md.pool(), 1, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'rewritten', result.reason)
  })
})

/**
 * Seventh pass, F2 — the proof may come from a completed REPAIR.
 *
 * A repair that wrote a block, proved it cold against the checksum btrfs stored
 * for it, and then saw md still counting mismatching stripes has MEASURED the
 * residual. Before this pass that number was recorded nowhere and Rewrite
 * parity refused `no-parity-mismatch` until a fresh multi-hour two-phase scrub
 * had rediscovered it.
 */
describe('parityRewriteEvidence — a repair job as the proof (F2)', () => {
  function repairJob(result: unknown, createdAt = '2026-09-13T06:00:00.000Z'): Job {
    return {
      id: 'job-r1',
      status: 'completed',
      operation: 'ahr.repair',
      progress: null,
      createdAt,
      createdBy: 'root@pam',
      startedAt: null,
      completedAt: null,
      result,
      error: null,
    }
  }
  function scrubJobAt(result: unknown, createdAt: string): Job {
    return { ...repairJob(result), id: 'job-s1', operation: 'ahr.scrub', createdAt }
  }

  const RESIDUAL = { band: 'tank-r1', bandIndex: 1, array: '/dev/md/tank-r1', mismatchCnt: 8 }

  it('a residual on the band IS the proof', () => {
    const answer = parityRewriteEvidence('tank', repairJob({
      repaired: 2,
      unrepairable: 0,
      aboveMd: 0,
      notExamined: 0,
      parityResiduals: [RESIDUAL],
    }), 1)
    assert.equal(answer.ok, true)
    assert.equal(answer.ok === true && answer.mismatchCnt, 8)
    assert.equal(answer.ok === true && answer.jobId, 'job-r1')
  })

  it('…on THAT band only', () => {
    const answer = parityRewriteEvidence('tank', repairJob({ parityResiduals: [RESIDUAL] }), 2)
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.code, 'no-parity-mismatch')
  })

  it('a run that left blocks unrepaired, above md or unexamined is NOT proof', () => {
    for (const left of ['unrepairable', 'aboveMd', 'notExamined']) {
      const answer = parityRewriteEvidence('tank', repairJob({
        repaired: 1,
        [left]: 1,
        parityResiduals: [RESIDUAL],
      }), 1)
      assert.equal(answer.ok, false, left)
      assert.equal(answer.ok === false && answer.code, 'data-findings-present', left)
      assert.ok(answer.ok === false && /Rewriting parity now would recompute it from data this node cannot vouch for/.test(answer.reason), left)
    }
  })

  it('the NEWER of the scrub and the repair is the one that describes the band now', () => {
    const scrub = scrubJobAt({ btrfsErrors: null, findings: [], parityMismatches: [{ band: 'tank-r1', bandIndex: 1, array: '/dev/md/tank-r1', mismatchCnt: 40 }] }, '2026-09-13T01:00:00.000Z')
    const repair = repairJob({ repaired: 1, unrepairable: 0, aboveMd: 0, notExamined: 0, parityResiduals: [RESIDUAL] }, '2026-09-13T06:00:00.000Z')
    const newer = parityRewriteEvidence('tank', [scrub, repair], 1)
    assert.equal(newer.ok === true && newer.jobId, 'job-r1', 'the repair ran last')
    assert.equal(newer.ok === true && newer.mismatchCnt, 8)

    const older = parityRewriteEvidence('tank', [scrub, { ...repair, createdAt: '2026-09-12T01:00:00.000Z' }], 1)
    assert.equal(older.ok === true && older.jobId, 'job-s1', 'the scrub ran last')
    assert.equal(older.ok === true && older.mismatchCnt, 40)
  })

  it('a list with nothing in it is still "no proof", not a crash', () => {
    const answer = parityRewriteEvidence('tank', [undefined, undefined], 1)
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.code, 'no-parity-mismatch')
  })
})
