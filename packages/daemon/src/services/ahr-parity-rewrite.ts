import type { AhrParityRewriteReasonCode, AhrParityRewriteResult, AhrScrubFinding, Job } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { MdGeometry } from './selfheal-map.js'
import { AhrParityRewriteReasonCode as AhrParityRewriteReasonCodeSchema, AhrParityRewriteResult as AhrParityRewriteResultSchema } from '@anas/shared'
import { z } from 'zod'
import {
  AHR_SCRUB_CHECK_FINISH_CEILING_MS,
  AHR_SCRUB_CHECK_START_TIMEOUT_MS,
  AHR_SCRUB_MISMATCH_DELAY_MS,
  AHR_SCRUB_POLL_MS,
  btrfsScrubPass,
  lastSyncAction,
  mismatchCount,
  syncAction,
} from './ahr-scrub.js'
import { pveNotify } from './pve-notify.js'
import { MD_DEFAULT_SYNC_MAX, MD_DEFAULT_SYNC_MIN, readMdAttrOrNull, sleep } from './selfheal-io.js'
import { bandBadBlocks, readMdGeometry } from './selfheal-map.js'
import { arrayRefusal, preWriteRefusal, restoreSyncKnobs } from './selfheal-repair.js'
import { foreignOpNote, isIdleSyncAction, markCheckIssued, ownsSyncOp, retireCheckIssued } from './selfheal-syncop.js'

/**
 * Rewrite parity — the one case ANAS can prove safe to hand to `md repair`
 * (story selfheal.10, RULED 2026-09-14).
 *
 * ## What this is, and why it is the exception
 *
 * The epic's standing rule is "never run md repair": md counts mismatching
 * stripes, it does not say WHICH member is wrong, and `repair` resolves that by
 * recomputing parity from the data members — so on a DATA-member rot it rewrites
 * parity to match the junk, the array goes clean, and the rot is invisible to
 * every future check while btrfs still EIOs the block (GT-18's negative control,
 * verbatim: `parity row == XOR(data rows): True` with the file unreadable).
 *
 * GT-18's positive half is the other side of the same coin: with the data
 * INTACT and the parity member rotten, a bounded `mdadm --action=repair` fixes
 * parity, leaves the data alone, and the stripe re-checks at
 * `mismatch_cnt = 0`. The two cases are indistinguishable TO MD. They are
 * distinguishable to ANAS, and the proof is the two-phase scrub: phase 1 counted
 * mismatches on this band, phase 2's checksum pass came back clean across the
 * whole pool. Every file that btrfs can vouch for is right, so what md would
 * recompute parity FROM is right, so the thing that is wrong is the parity.
 *
 * That proof is this verb's entire licence, which is why it is re-taken twice —
 * once at submit, once again immediately before the md write — and why a FRESH
 * btrfs scrub runs first, in this job, on this pool: the evidence scrub may be
 * hours old, and a finding that arrived since would be blessed.
 *
 * ## What it does NOT do
 *
 * It is never automatic, never a read-path heal, and never pool-wide: one band,
 * asked for by an operator through the confirm gate, with that band's own
 * duration estimate in front of them. It writes no file. It moves no md knob
 * that md itself does not move — both phases are whole-band operations with
 * `sync_max` at `max`, so neither needs a window and nothing needs to be
 * narrowed or ended. And it touches no array whose current operation is not
 * ours: a member that fails mid-run puts md into `recover`, and the only correct
 * thing this run can do then is walk away with every knob exactly as md left it
 * (design review D2, `selfheal-syncop.ts`).
 */

const MDADM = '/usr/sbin/mdadm'

/** Run of whitespace — `sync_completed` prints `<done> / <total>`. */
const WHITESPACE_RE = /\s+/g

/**
 * The per-member read rate the duration estimate assumes, in bytes/second.
 *
 * The GT rigs are loop files on this node's NVMe — GT-19 measured ~700 MB/s
 * writes there, and a 1 GiB rebuild finishing in ~2 s is why that drill had to
 * be rebuilt at 600 MiB per member to get a 7-second window at all. None of
 * those numbers say anything about a band on spinning disks, which is what a
 * real AHR pool is: there the op runs at the slowest member's sequential rate,
 * shared with whatever else the pool is serving and capped by md's own
 * `speed_limit_max`.
 *
 * So the estimate does not extrapolate from the rigs. It assumes a deliberate
 * FLOOR — 60 MiB/s per member, comfortably below a modern 7200 rpm disk's
 * sequential rate — so the number the operator confirms is a ceiling on the
 * wait rather than an optimistic guess. The warning says the assumption out
 * loud, because an estimate whose basis is hidden is worse than none.
 */
export const PARITY_REWRITE_RATE_BYTES_S = 60 * 1024 * 1024

/** One band of a pool, as much of it as this verb needs. */
export interface ParityRewriteArray {
  /** Band index (1-based, bottom-up). */
  band: number
  /** md device path — `/dev/md/<pool>-r<band>`. */
  device: string
  /** Per-member slice size: what one `repair` pass reads off each member. */
  heightBytes: number
  /** How many members the band has — for the estimate's wording. */
  members: number
}

/**
 * The pool, narrowed to what a parity rewrite reads.
 *
 * `AhrPool` satisfies this structurally, which is how the route hands the real
 * topology straight in. The narrowing is what lets the selfheal.2 suite drive
 * this verb on a loop rig, which is not an AHR pool and never will be — the rig
 * has an LV over md bands and a btrfs mountpoint, and that is all this needs.
 */
export interface ParityRewritePool {
  name: string
  mountpoint: string
  mounted: boolean
  arrays: readonly {
    band: number
    device: string
    heightBytes: number
    members: readonly unknown[]
  }[]
}

/** The evidence lookup's answer: the proof, or why there is none. */
export type ParityRewriteEvidence
  = | { ok: true, mismatchCnt: number, jobId: string }
    | { ok: false, code: AhrParityRewriteReasonCode, reason: string }

export interface ParityRewriteOptions {
  /** Progress sink — the job's, or a console in the dev entry. */
  updateProgress?: (message: string) => void
  /**
   * Re-read the proof. Called at the start of the run AND again immediately
   * before the md write, because it can stop being true in between (a scrub
   * finishing with a finding is the case that matters). The lookup lives in the
   * route because the evidence is a JOB, and jobs are the route's to read.
   */
  evidence?: () => ParityRewriteEvidence | Promise<ParityRewriteEvidence>
  /**
   * Is a scrub / repair / parity-rewrite in flight on this pool right now? The
   * operator's sentence, or null. Re-asked immediately before the md write for
   * the same reason the gates are.
   */
  jobConflict?: () => string | null
  /** Name the files the fresh scrub found (the route wires `attributeScrub`). */
  attributeFindings?: (since: Date) => Promise<AhrScrubFinding[]>
  /** Poll interval while waiting on the scrub and the md ops. */
  pollIntervalMs?: number
  /** Delay between an op going idle and the `mismatch_cnt` read. */
  mismatchDelayMs?: number
  /** How long an md op is given to actually start. */
  startTimeoutMs?: number
  /** Absolute ceiling on one op's finish-wait. */
  finishCeilingMs?: number
  /**
   * The guard's seams (story cr.38 session B, WAVE3-DESIGN §3.2, §4.3). The
   * route's job passes `ctx.reguard` — re-acquire the pool's key and re-run
   * every gate of the verb (the proof, the state roll-up, the in-process and
   * node-wide exclusions, the band's own md state, the pool and band
   * identity) against the node NOW, throwing the refusal — and `ctx.release`,
   * which gives the key back while md does the work. The engine calls
   * `reguard` before each md act (the repair, the verifying check) and
   * `release` before each md wait. A refusal is reported like the engine's
   * own (one result, one notification) and then thrown, so the job carries
   * the refusal's code. Absent (the selfheal rig, the dev entry): nothing to
   * re-gate, nothing to give back.
   */
  reguard?: () => Promise<void>
  release?: () => void
}

/** The band the request names, or null when the pool has no such band. */
export function parityRewriteArray(pool: ParityRewritePool, band: number): ParityRewriteArray | null {
  const array = pool.arrays.find(a => a.band === band)
  return array
    ? { band: array.band, device: array.device, heightBytes: array.heightBytes, members: array.members.length }
    : null
}

/** `1 h 20 m`, `4 m`, `40 s` — an estimate, rounded like one. */
export function approximateDuration(seconds: number): string {
  if (seconds < 90)
    return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600)
    return `${Math.round(seconds / 60)} min`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds - hours * 3600) / 60)
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

/** GiB, one decimal — the band size the estimate is computed from. */
function gib(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

/**
 * What the confirm gate must say before an operator can agree to this.
 *
 * Every line is a consequence, not a caution: what parity is recomputed FROM,
 * what runs first and what aborts the run, which files this cannot protect, and
 * how long the array will be reading. The NOCOW line is the one the operator
 * cannot discover any other way — ANAS never sets `chattr +C` and never
 * preallocates, so a file without checksums on an AHR pool got there by hand,
 * and this verb would bless rot inside it exactly as it would bless data rot.
 */
export function parityRewriteWarnings(
  poolName: string,
  array: ParityRewriteArray,
  poolUsedBytes: number | null = null,
): string[] {
  const perPass = array.heightBytes / PARITY_REWRITE_RATE_BYTES_S
  // Phase 1 is a scrub of the WHOLE POOL, not of this band, and on a pool with
  // real data in it that is usually the longest part of the run by a wide
  // margin — a confirm gate that quotes only the two md passes understates the
  // wait it is asking the operator to agree to (sixth pass, N8). The pool's
  // used bytes come from the topology the route already read; a pool that
  // cannot report them says so rather than quoting a number it does not have.
  const scrub = poolUsedBytes !== null && poolUsedBytes > 0
    ? `after a full checksum scrub of the pool (${gib(poolUsedBytes)} of data, ≈${approximateDuration(poolUsedBytes / PARITY_REWRITE_RATE_BYTES_S)}, usually the dominant term)`
    : 'after a full checksum scrub of the pool, whose duration this node could not estimate. On a pool with real data in it, that pass is usually the dominant term'
  return [
    `Parity on band r${array.band} is recomputed from the data AS IT IS NOW. md counts mismatching stripes, and it does not say which member is wrong. Whatever the data members hold becomes the truth for this band`,
    `A fresh btrfs scrub of the whole pool runs FIRST and any finding aborts the run before md is touched: data rot has to be repaired (Repair from parity) before parity is rewritten, because md repair would make that rot permanent and invisible`,
    `Files WITHOUT checksums are not protected. A hand-set NOCOW (chattr +C) file or a preallocated range has no checksum to prove it right, so rot inside it would be blessed by this run. ANAS creates neither, and cannot see into one it did not create`,
    `The run reads every member of band r${array.band} twice: the repair pass, then a verifying check. ${gib(array.heightBytes)} per member each time across ${array.members} member(s), about ${approximateDuration(perPass)} per pass (~${approximateDuration(perPass * 2)} in total), ${scrub}. All of it assumes a deliberately conservative 60 MiB/s per member, so real disks usually finish the run sooner. The pool stays usable throughout, but it will be slower while the run is on`,
    `Nothing else is touched: no file is written, no other band of pool '${poolName}' is read, and no md knob is left changed`,
    `This is never automatic. ANAS rewrites parity only when an operator asks for this band, with this proof in hand`,
  ]
}

/**
 * The band rows a completed scrub's result carries, or null when it carries
 * none at all.
 *
 * ADAPTER (selfheal.10, merge note): the scrub's `parityMismatches[]`
 * reporting field lands with the Scrubs reporting work in the same round as
 * this story. This reads it structurally so the two can land in either order —
 * a result WITHOUT the field parses fine and answers null, which the caller
 * turns into "the last scrub predates the parity-mismatch reporting", the same
 * honest refusal as "the last scrub found none". When the field is on the
 * shared schema, this function keeps working unchanged; the only thing it is
 * hiding is a type import.
 */
const ParityMismatchRow = z.object({
  /** The band LABEL (`<pool>-r<n>`) — the operator's name for it. */
  band: z.string().min(1),
  /** The same band as the number this verb's body names. */
  bandIndex: z.number().int().positive(),
  array: z.string().optional(),
  mismatchCnt: z.number().int().nonnegative(),
})
const ScrubEvidenceShape = z.object({
  btrfsErrors: z.string().nullable().optional(),
  findings: z.array(z.unknown()).optional(),
  parityMismatches: z.array(ParityMismatchRow).optional(),
})

export function scrubParityMismatches(result: unknown): z.infer<typeof ParityMismatchRow>[] | null {
  const parsed = ScrubEvidenceShape.safeParse(result)
  return parsed.success ? parsed.data.parityMismatches ?? null : null
}

/**
 * The same reading, of a REPAIR job's result (seventh pass, F2).
 *
 * A repair that wrote a block, proved it against its stored checksum and then
 * saw md still counting mismatching stripes has MEASURED a parity residual on
 * that band. Making the operator wait hours for a fresh two-phase scrub to
 * rediscover a number this node already has is the gap F2 names, so the same
 * row shape rides the repair result and is read here.
 *
 * The other half of the proof is read from the repair's own counts rather than
 * from a checksum pass: a run that left blocks unrepaired, above md or
 * unexamined is a run with KNOWN data rot on the pool, and md repair would
 * bless it exactly as it would bless a scrub's findings.
 */
const RepairEvidenceShape = z.object({
  unrepairable: z.number().int().nonnegative().optional(),
  aboveMd: z.number().int().nonnegative().optional(),
  notExamined: z.number().int().nonnegative().optional(),
  parityResiduals: z.array(ParityMismatchRow).optional(),
})

export function repairParityResiduals(result: unknown): z.infer<typeof ParityMismatchRow>[] | null {
  const parsed = RepairEvidenceShape.safeParse(result)
  return parsed.success ? parsed.data.parityResiduals ?? null : null
}

/**
 * Read the proof out of the pool's last COMPLETED scrub job (precondition 1).
 *
 * Both halves have to hold, and they are two different statements:
 *  - phase 1 counted mismatches ON THIS BAND — otherwise there is nothing to
 *    rewrite, and running `repair` over a band nobody has counted a mismatch on
 *    is the "never run md repair" rule with extra steps;
 *  - phase 2 was clean ACROSS THE POOL — a finding anywhere is a file md repair
 *    could bless, and the band a finding sits on is not always the band the
 *    mismatch was counted on.
 */
export function parityRewriteEvidence(
  poolName: string,
  source: Job | undefined | readonly (Job | undefined)[],
  band: number,
): ParityRewriteEvidence {
  // The proof may come from a scrub OR from a repair (seventh pass, F2), and
  // the NEWER of the two is the one that describes the band as it is now: a
  // repair run after a scrub has moved the data the scrub measured parity
  // against, and a scrub run after a repair has re-measured everything.
  const job = Array.isArray(source)
    ? [...source].filter((j): j is Job => !!j).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    : (source as Job | undefined)
  if (job?.operation === 'ahr.repair')
    return repairEvidence(poolName, job, band)
  if (!job) {
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: `no completed scrub of AHR pool '${poolName}' is on record. A parity rewrite stands entirely on the last two-phase scrub (band r${band} counted mismatches, the checksum pass found nothing). Scrub the pool first. The record is in-memory, so a daemon restart also clears it`,
    }
  }
  const evidence = ScrubEvidenceShape.safeParse(job.result)
  if (!evidence.success) {
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: `the last completed scrub of AHR pool '${poolName}' (job ${job.id}) did not report a result the parity rewrite can read`,
    }
  }
  if (evidence.data.btrfsErrors != null || (evidence.data.findings?.length ?? 0) > 0) {
    return {
      ok: false,
      code: 'data-findings-present',
      reason: `the last scrub of AHR pool '${poolName}' (job ${job.id}) found data corruption${evidence.data.btrfsErrors ? `: ${evidence.data.btrfsErrors}` : ''}. Repair those files from parity first. Rewriting parity now would recompute it from the corrupt data and make the rot permanent`,
    }
  }
  const rows = scrubParityMismatches(job.result)
  if (rows === null) {
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: `the last scrub of AHR pool '${poolName}' (job ${job.id}) reports no per-band parity counts. Scrub the pool again and rewrite parity from that run's findings`,
    }
  }
  const row = rows.find(r => r.bandIndex === band)
  if (!row || row.mismatchCnt <= 0) {
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: `the last scrub of AHR pool '${poolName}' (job ${job.id}) counted no parity mismatch on band r${band}. There is nothing here to rewrite`,
    }
  }
  return { ok: true, mismatchCnt: row.mismatchCnt, jobId: job.id }
}

/**
 * The proof, read out of a completed REPAIR job instead (F2).
 *
 * Both halves still have to hold, and they are the same two statements said
 * about a different run:
 *  - a repaired-and-proven block on THIS band left md still counting mismatches
 *    there, which is a parity residual and nothing else — the block itself was
 *    re-read cold and matched the checksum btrfs stored for it;
 *  - the run left NO block unrepaired, above md or unexamined: any of those is
 *    known data rot on the pool, and md repair would make it permanent.
 *
 * The rewrite job's own phase 1 — a fresh full-pool checksum scrub that aborts
 * on any finding — is what makes "the data is intact" a statement about NOW,
 * exactly as it is for a scrub-sourced proof. This gate is the filter in front
 * of it, not a substitute for it.
 */
function repairEvidence(poolName: string, job: Job, band: number): ParityRewriteEvidence {
  const parsed = RepairEvidenceShape.safeParse(job.result)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: `the last completed repair on AHR pool '${poolName}' (job ${job.id}) did not report a result the parity rewrite can read`,
    }
  }
  const unrepaired = (parsed.data.unrepairable ?? 0) + (parsed.data.aboveMd ?? 0) + (parsed.data.notExamined ?? 0)
  if (unrepaired > 0) {
    return {
      ok: false,
      code: 'data-findings-present',
      reason: `the last repair on AHR pool '${poolName}' (job ${job.id}) left ${unrepaired} block(s) unrepaired, above md or unexamined. Repair or restore those first. Rewriting parity now would recompute it from data this node cannot vouch for`,
    }
  }
  const row = (parsed.data.parityResiduals ?? []).find(r => r.bandIndex === band)
  if (!row || row.mismatchCnt <= 0) {
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: `the last repair on AHR pool '${poolName}' (job ${job.id}) recorded no leftover parity mismatch on band r${band}. There is nothing here to rewrite`,
    }
  }
  return { ok: true, mismatchCnt: row.mismatchCnt, jobId: job.id }
}

/** A refusal with the code a parser keys on, or null when the band may be rewritten. */
export interface ParityRewriteRefusal {
  reason: string
  code: AhrParityRewriteReasonCode
}

/**
 * The sentence a RAID1 band is refused with (sixth pass, N1).
 *
 * md's `repair` does not arbitrate. On a parity level it recomputes P (and Q)
 * from the data members, which is why the data-intact case has a verb at all.
 * On a MIRROR there is no parity to recompute: md copies the first in-sync leg
 * over every other leg, and nothing in that choice looks at which leg is right.
 * Running it on a band whose legs disagree is a coin flip that writes the
 * rotten copy over the good one half the time — the exact data loss this epic
 * exists to prevent.
 *
 * A mirror mismatch is not unrepairable, it is repaired by a DIFFERENT verb:
 * Repair from parity reads the block, arbitrates the legs against the checksum
 * btrfs stored for it, and writes back only the leg that matches.
 */
export function mirrorBandRefusal(device: string): string {
  return `${device} is a RAID1 mirror band. It has no parity to rewrite. md's repair on a mirror copies the first in-sync leg over the others, and it cannot tell which leg is right. On a band whose legs disagree, it overwrites the good copy half the time. A mirror mismatch is arbitrated by Repair from parity per block, never by md repair`
}

/**
 * The sentence a band with recorded md bad blocks is refused with (seventh
 * pass, F8).
 *
 * A bad-block range is a span md returned a URE on during a rebuild and never
 * reconstructed: md serves EIO for it and holds no correct copy of it. A
 * whole-band `mdadm --action=repair` walks every stripe of the array and
 * recomputes parity from what it reads — including rows it cannot read at all.
 * That is the data-rot case with the rot hidden inside md rather than on a
 * member, and the same rule applies: the member is replaced first.
 */
export function badBlocksRefusal(geo: MdGeometry): string {
  const carriers = bandBadBlocks(geo)
  const named = carriers.map(c => `${c.device} (${c.ranges.length} range${c.ranges.length === 1 ? '' : 's'})`).join(', ')
  return `${geo.device} has members with recorded bad blocks: ${named}. md cannot reconstruct from a member with recorded bad blocks. Replace the member first. A whole-band repair would recompute this band's parity from rows md cannot read`
}

/** Why this band cannot be rewritten right now (precondition 2), or null. */
export async function parityRewriteArrayRefusal(geo: MdGeometry): Promise<ParityRewriteRefusal | null> {
  // FIRST, and not a state that can pass: every other refusal here is "not
  // now", this one is "not this band, ever".
  if (geo.raid1)
    return { reason: mirrorBandRefusal(geo.device), code: 'not-a-parity-band' }
  // Also not a wait-and-retry state: a member with recorded bad blocks is a
  // member to replace, and until it is replaced this band has rows md cannot
  // reconstruct (F8).
  if (bandBadBlocks(geo).length > 0)
    return { reason: badBlocksRefusal(geo), code: 'bad-blocks-present' }
  const refusal = await arrayRefusal(geo)
  if (refusal)
    return { reason: refusal, code: 'array-busy' }
  // GT-13's trap: an interrupted repair leaves `sync_min`/`sync_max` bounded to
  // ONE STRIPE and the knob PERSISTS. A whole-band repair issued under it would
  // cover that sliver, suspend there, and report a `mismatch_cnt` that means
  // nothing. The scrub restores the window per band before it issues a check —
  // so the way out is a scrub, which this verb needs a fresh one of anyway.
  const min = await readMdAttrOrNull(geo.sys, 'sync_min')
  const max = await readMdAttrOrNull(geo.sys, 'sync_max')
  if ((max !== null && max !== MD_DEFAULT_SYNC_MAX) || (min !== null && min !== MD_DEFAULT_SYNC_MIN)) {
    return {
      reason: `${geo.device}'s sync window is bounded to ${min ?? '?'}..${max ?? '?'} (an interrupted repair or check left it there). A whole-band repair under it would cover only that sliver. A scrub of the pool restores the window`,
      code: 'array-busy',
    }
  }
  return null
}

/** How a wait on one md operation ended. */
export type WaitResult
  = | { ended: true }
  /** md is running something this run did not start: nothing was written. */
    | { ended: false, foreign: string }

/**
 * What {@link waitForOwnSyncOp} needs of its caller's options.
 *
 * `ParityRewriteOptions` satisfies it structurally, and so does the mirror
 * reconcile's (selfheal.11) — which is the point: both verbs issue whole-band
 * md operations and both have to answer the same question about whose
 * operation md is running, so there is ONE waiter rather than two copies that
 * drift.
 */
export interface SyncOpWaitOptions {
  updateProgress?: (message: string) => void
  pollIntervalMs?: number
  startTimeoutMs?: number
  finishCeilingMs?: number
}

/**
 * Wait for an md operation this run issued to finish, touching nothing.
 *
 * Both phases are whole-band ops with `sync_max` at `max`, so md runs them to
 * the device end and ends them itself — this never writes `idle`, never
 * narrows a window, and never has to. What it does is watch WHOSE operation md
 * is running: `ownsSyncOp` is the one place that decides, and anything it calls
 * foreign that is not the action we issued ends the wait with the array exactly
 * as md left it (D2). The check phase marks its check issued first, so
 * ownership is real for it; a `repair` has no ownership token in sysfs at all —
 * md reports the action, never who asked — and the honest reading is the one
 * taken here: this run issued a repair on an array that was idle a moment
 * earlier, so the `repair` md is running is that one, and ANY OTHER action
 * means md dropped ours and took something of its own on.
 *
 * `priorAction` is `last_sync_action` from before the op was issued. It is the
 * discriminator for the op that finishes between two polls (a 200 MiB loop rig
 * does exactly that): md is idle and `last_sync_action` now names the op we
 * issued, where it named something else before. Without that change nothing
 * proves the op ran, and "did not start" is what gets reported.
 */
export async function waitForOwnSyncOp(
  executor: CommandExecutor,
  geo: MdGeometry,
  label: string,
  expect: 'repair' | 'check',
  priorAction: string | null,
  opts: SyncOpWaitOptions,
): Promise<WaitResult> {
  const poll = opts.pollIntervalMs ?? AHR_SCRUB_POLL_MS
  const read = () => syncAction(executor, geo.kernel)
  const startDeadline = Date.now() + (opts.startTimeoutMs ?? AHR_SCRUB_CHECK_START_TIMEOUT_MS)
  const finishDeadline = Date.now() + (opts.finishCeilingMs ?? AHR_SCRUB_CHECK_FINISH_CEILING_MS)

  for (;;) {
    const own = await ownsSyncOp(geo.kernel, read)
    if (own.action === expect)
      break
    if (!isIdleSyncAction(own.action))
      return { ended: false, foreign: foreignOpNote(label, own.action) }
    if (Date.now() >= startDeadline) {
      const last = await lastSyncAction(executor, geo.kernel)
      if (last === expect && last !== priorAction)
        return { ended: true } // it ran to the end between two polls
      throw new Error(`md never started the ${expect} on ${label} (sync_action idle, last_sync_action=${last ?? 'unreadable'})`)
    }
    opts.updateProgress?.(`md ${expect} on ${label} (waiting for md to start it)`)
    await sleep(poll)
  }

  for (;;) {
    const own = await ownsSyncOp(geo.kernel, read)
    if (isIdleSyncAction(own.action))
      return { ended: true }
    if (own.action !== expect)
      return { ended: false, foreign: foreignOpNote(label, own.action) }
    if (Date.now() >= finishDeadline)
      throw new Error(`the md ${expect} on ${label} was still running after the ${Math.round((opts.finishCeilingMs ?? AHR_SCRUB_CHECK_FINISH_CEILING_MS) / 3600000)} h ceiling. Not waiting on it any longer`)
    const completed = await readMdAttrOrNull(geo.sys, 'sync_completed')
    opts.updateProgress?.(`md ${expect} on ${label}${completed ? ` (${completed.replace(WHITESPACE_RE, ' ')} sectors)` : ''}`)
    await sleep(poll)
  }
}

/** Where the run stopped, with everything it learned up to that point. */
interface RunState {
  mismatchBefore: number | null
  mismatchAfter: number | null
  scrubMs: number
  repairMs: number
  checkMs: number
}

/**
 * Rewrite one band's parity: fresh btrfs scrub → `mdadm --action=repair` over
 * the whole band → md `check` over the whole band → `mismatch_cnt` must read 0.
 *
 * The repair is issued on the BAND, not on a stripe: md counts mismatches, it
 * does not locate them, so the only honest scope for "the parity of this band
 * is wrong somewhere" is the band. That is what the confirm gate's duration
 * estimate is about, and why this is a per-band verb rather than a per-pool one.
 */
export async function rewriteBandParity(
  executor: CommandExecutor,
  pool: ParityRewritePool,
  band: number,
  opts: ParityRewriteOptions = {},
): Promise<AhrParityRewriteResult> {
  const progress = opts.updateProgress ?? (() => {})
  const startedAt = Date.now()
  const state: RunState = { mismatchBefore: null, mismatchAfter: null, scrubMs: 0, repairMs: 0, checkMs: 0 }

  const finish = async (
    outcome: AhrParityRewriteResult['outcome'],
    array: string | null,
    extra: Partial<AhrParityRewriteResult> = {},
  ): Promise<AhrParityRewriteResult> => {
    const result = AhrParityRewriteResultSchema.parse({
      pool: pool.name,
      band,
      array,
      mismatchBefore: state.mismatchBefore,
      mismatchAfter: state.mismatchAfter,
      outcome,
      ...extra,
      durations: {
        scrubMs: state.scrubMs,
        repairMs: state.repairMs,
        checkMs: state.checkMs,
        totalMs: Date.now() - startedAt,
      },
    })
    // ONE notification, whatever happened: the operator asked for this band and
    // gets one answer about it, with both counts in the body (§7.2/§7.3).
    const counts = `mismatch_cnt ${result.mismatchBefore ?? 'unknown'} before, ${result.mismatchAfter ?? 'unknown'} after`
    await pveNotify(
      executor,
      outcome === 'rewritten' ? 'info' : 'warning',
      `AHR parity rewrite on ${pool.name}-r${band}: ${outcome}`,
      outcome === 'rewritten'
        ? `parity on band r${band} of pool '${pool.name}' was recomputed from the data and re-checked clean (${counts})`
        : `${result.reason ?? 'the run did not complete'} (${counts})`,
    )
    return result
  }

  const array = parityRewriteArray(pool, band)
  if (!array)
    return finish('refused', null, { reason: `AHR pool '${pool.name}' has no band r${band}`, reasonCode: 'no-such-band' })

  if (!pool.mounted)
    return finish('refused', array.device, { reason: `AHR pool '${pool.name}' is not mounted. The parity rewrite starts with a fresh btrfs scrub, which needs the filesystem online`, reasonCode: 'pool-not-mounted' })

  const label = `${pool.name}-r${band}`

  /**
   * The guard's re-check before an md act (cr.38). A refusal ends the run
   * with `outcome` and the refusal's sentence (and its reason code, when it
   * is one of this verb's), then is rethrown for the job's error code.
   */
  const regate = async (outcome: 'refused' | 'still-mismatched', when: string): Promise<void> => {
    if (!opts.reguard)
      return
    try {
      await opts.reguard()
    }
    catch (error) {
      const code = AhrParityRewriteReasonCodeSchema.safeParse((error as { refusal?: { reason?: unknown } }).refusal?.reason)
      await finish(outcome, array.device, {
        reason: `${error instanceof Error ? error.message : String(error)} (${when})`,
        ...(code.success ? { reasonCode: code.data } : {}),
      })
      throw error
    }
  }

  // --- Preconditions, at submit ---------------------------------------------
  const evidence = opts.evidence ? await opts.evidence() : null
  if (evidence && !evidence.ok)
    return finish('refused', array.device, { reason: evidence.reason, reasonCode: evidence.code })
  if (evidence?.ok)
    state.mismatchBefore = evidence.mismatchCnt

  const conflict = opts.jobConflict?.()
  if (conflict)
    return finish('refused', array.device, { reason: conflict, reasonCode: 'job-active' })

  const geo = await readMdGeometry(executor, array.device)
  const busy = await parityRewriteArrayRefusal(geo)
  if (busy)
    return finish('refused', array.device, { reason: busy.reason, reasonCode: busy.code })

  // --- Phase 1/3: the fresh btrfs scrub -------------------------------------
  // The evidence scrub can be hours old. md repair recomputes parity from the
  // data, so a finding that arrived since would be blessed by phase 2 — this is
  // the pass that makes "the data is intact" a statement about NOW.
  progress(`phase 1/3: fresh btrfs checksum scrub of pool '${pool.name}'. Any finding aborts the run before md is touched`)
  const scrubStart = Date.now()
  const pass = await btrfsScrubPass(executor, pool.mountpoint, pool.name, progress, opts.pollIntervalMs ?? AHR_SCRUB_POLL_MS)
  state.scrubMs = Date.now() - scrubStart
  if (pass.btrfsErrors !== null) {
    let findings: AhrScrubFinding[] | undefined
    try {
      findings = await opts.attributeFindings?.(pass.startedAt)
    }
    catch (error) {
      // Naming the files is a bonus; the refusal stands on the summary line.
      progress(`the fresh scrub's errors could not be attributed to files: ${error instanceof Error ? error.message : String(error)}`)
    }
    return finish('refused', array.device, {
      reason: `refused: data corruption found. Repair the data first. The fresh btrfs scrub of pool '${pool.name}' reported: ${pass.btrfsErrors}`,
      reasonCode: 'data-corruption-found',
      btrfsErrors: pass.btrfsErrors,
      ...(findings ? { findings } : {}),
    })
  }
  progress(`the fresh scrub of '${pool.name}' is clean. The files btrfs holds checksums for all passed, so parity is what is wrong`)

  // --- The same preconditions, immediately before the md write --------------
  // A scrub takes hours on a real pool, and every one of these can have stopped
  // being true in that time: a member can fail, another job can be submitted,
  // and the evidence scrub itself can be superseded. Under the guard (cr.38)
  // the job's whole gate list runs first, against the node now.
  await regate('refused', 're-checked immediately before the md write; nothing was written')
  const evidenceNow = opts.evidence ? await opts.evidence() : null
  if (evidenceNow && !evidenceNow.ok)
    return finish('refused', array.device, { reason: `${evidenceNow.reason} (re-checked immediately before the md write)`, reasonCode: evidenceNow.code })
  const conflictNow = opts.jobConflict?.()
  if (conflictNow)
    return finish('refused', array.device, { reason: `${conflictNow} (re-checked immediately before the md write)`, reasonCode: 'job-active' })
  let busyNow: ParityRewriteRefusal | null = await parityRewriteArrayRefusal(geo)
  if (!busyNow) {
    const preWrite = await preWriteRefusal(geo)
    if (preWrite)
      busyNow = { reason: preWrite, code: 'array-busy' }
  }
  if (busyNow)
    return finish('refused', array.device, { reason: `${busyNow.reason}. Nothing was written`, reasonCode: busyNow.code })

  // md zeroes `mismatch_cnt` when a sync op starts, so this read — taken with
  // the array idle, immediately before the repair — is the last completed
  // check's verdict, the same number the evidence carries.
  const live = await mismatchCount(executor, geo.kernel)
  if (live !== null)
    state.mismatchBefore = live

  // --- Phase 2/3: md repair over the whole band ------------------------------
  const estimate = approximateDuration(array.heightBytes / PARITY_REWRITE_RATE_BYTES_S)
  progress(`phase 2/3: mdadm --action=repair on ${label} (whole band, ${gib(array.heightBytes)} per member, roughly ${estimate})`)
  const repairPrior = await lastSyncAction(executor, geo.kernel)
  const repairStart = Date.now()
  const issued = await executor.exec(MDADM, ['--action=repair', array.device])
  if (issued.exitCode !== 0) {
    return finish('refused', array.device, {
      reason: `mdadm --action=repair on ${label} exited ${issued.exitCode}${issued.stderr.trim() ? `: ${issued.stderr.trim()}` : ''}. md did not take the repair, and nothing was written`,
      reasonCode: 'array-busy',
    })
  }
  // cr.38 (§4.3): md does the work from here; the job only watches it.
  opts.release?.()
  const repaired = await waitForOwnSyncOp(executor, geo, label, 'repair', repairPrior, opts)
  state.repairMs = Date.now() - repairStart
  if (!repaired.ended) {
    return finish('refused', array.device, {
      reason: `${repaired.foreign}. md replaced this run's repair with an operation of its own, so the rewrite is not proven and no knob was touched`,
      reasonCode: 'foreign-sync-op',
    })
  }

  // --- Phase 3/3: the verifying check ---------------------------------------
  // A repair that ran is not a repair that WORKED: the only evidence md offers
  // is a check that counts zero afterwards. Whole-band again, for the same
  // reason — md does not say where the mismatches were.
  //
  // No stripe-cache eviction here, and that is deliberate: the eviction the
  // block repair needs (selfheal-repair's `evictStripeCache`) exists because a
  // BOUNDED check over one recently-written stripe reads md's cache instead of
  // the members. This check covers the whole band, which is orders of magnitude
  // more stripes than the cache holds, and the repair that preceded it wrote
  // through the same cache — so cache and disk agree by construction.
  progress(`phase 3/3: md check on ${label} (whole band). Proving the parity md just wrote`)
  await regate('still-mismatched', 'the repair ran; the verifying check was not issued, so the rewrite is unproven')
  const checkPrior = await lastSyncAction(executor, geo.kernel)
  const checkStart = Date.now()
  const checkIssued = await executor.exec(MDADM, ['--action=check', array.device])
  if (checkIssued.exitCode !== 0) {
    return finish('still-mismatched', array.device, {
      reason: `the repair ran, but mdadm --action=check on ${label} exited ${checkIssued.exitCode}${checkIssued.stderr.trim() ? `: ${checkIssued.stderr.trim()}` : ''}. The rewrite is unproven. Scrub the pool to check it`,
    })
  }
  markCheckIssued(geo.kernel)
  // cr.38 (§4.3): the check is md's; the job only watches it.
  opts.release?.()
  let checked: WaitResult
  try {
    checked = await waitForOwnSyncOp(executor, geo, label, 'check', checkPrior, opts)
  }
  finally {
    // Ours or not, this run is done with it. `restoreSyncKnobs` re-reads
    // `sync_action` and leaves a foreign operation completely alone.
    retireCheckIssued(geo.kernel)
    await restoreSyncKnobs(geo)
  }
  state.checkMs = Date.now() - checkStart
  if (!checked.ended) {
    return finish('still-mismatched', array.device, {
      reason: `the repair ran, but ${checked.foreign}. The verifying check did not complete, so the rewrite is unproven`,
      reasonCode: 'foreign-sync-op',
    })
  }

  await sleep(opts.mismatchDelayMs ?? AHR_SCRUB_MISMATCH_DELAY_MS)
  state.mismatchAfter = await mismatchCount(executor, geo.kernel)
  if (state.mismatchAfter === null) {
    return finish('still-mismatched', array.device, {
      reason: `the repair and the check both ran, but ${geo.device}'s mismatch_cnt could not be read. The rewrite is not proven`,
    })
  }
  if (state.mismatchAfter > 0) {
    return finish('still-mismatched', array.device, {
      reason: `${label} still counts ${state.mismatchAfter} mismatch(es) after the repair. Parity was rewritten, and the band did not come back clean. Scrub the pool and look at its disks before rewriting again`,
    })
  }
  return finish('rewritten', array.device)
}
