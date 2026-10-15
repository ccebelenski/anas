import type {
  AhrMirrorReconcileReasonCode,
  AhrMirrorReconcileResult,
  AhrScrubFinding,
  Job,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { ChunkItem, MdGeometry, MemberLocation, SelfhealBand, SelfhealContext } from './selfheal-map.js'
import { AhrMirrorReconcileResult as AhrMirrorReconcileResultSchema } from '@anas/shared'
import { z } from 'zod'
import { approximateDuration, waitForOwnSyncOp } from './ahr-parity-rewrite.js'
import {
  AHR_SCRUB_MISMATCH_DELAY_MS,
  AHR_SCRUB_POLL_MS,
  btrfsScrubPass,
  lastSyncAction,
  mismatchCount,
} from './ahr-scrub.js'
import { pveNotify } from './pve-notify.js'
import { crc32c, csumHex, CsumUnreadableError, NODE_BYTES, readStoredCsum, verifyNode } from './selfheal-csum.js'
import { BLOCK_BYTES, MD_DEFAULT_SYNC_MAX, MD_DEFAULT_SYNC_MIN, readDirect, readMdAttrOrNull, sleep, writeDirect } from './selfheal-io.js'
import {
  bandBadBlocks,
  logicalForMdByte,
  memberOffsetOn,
  placeMdByte,
  readAllChunkItems,
  readMdGeometry,
  resolveContext,
} from './selfheal-map.js'
import { arrayRefusal, memberDataSectors, preWriteRefusal, restoreSyncKnobs } from './selfheal-repair.js'
import { markCheckIssued, retireCheckIssued } from './selfheal-syncop.js'

/**
 * Reconcile a mirror band — the verb for the decision tree's R9 root, which had
 * none (story selfheal.11, RULED 2026-09-14).
 *
 * ## The fault
 *
 * md counts DISAGREEING LEGS on a RAID1 band. It does not say which leg is
 * right, it does not say where in the band they disagree, and btrfs reads
 * through md, so the checksum pass sees whatever leg md's read-balance happened
 * to serve — which on GT-22's rig was the rotten one every time, and is not
 * contractual anywhere.
 *
 * ## Why md's own repair is not the answer, here or ever
 *
 * `mdadm --action=repair` on a mirror copies the first in-sync leg over the
 * others. It does not arbitrate; it does not look. GT-22(f) proved it in both
 * directions on the rig: with the rot on leg 0 the junk was propagated to
 * leg 1 (the band then agrees on rotten data and no later check can see it);
 * with the rot on leg 1 the good copy won. The winner is always leg 0, never
 * the right one. So the epic's ruling is absolute — NO ANAS code path issues
 * `--action=repair` on a RAID1 band. In this module that is not a convention
 * but a wrapper: every command goes through {@link mirrorGuardedExecutor},
 * which throws before the process is spawned (see {@link assertNoMdRepair}).
 *
 * ## The two arms, cheapest first
 *
 * **Arm A — scrub until clean.** GT-22's UNEXPECTED(1): an ordinary btrfs scrub
 * that MEETS the rot heals the whole band through md. btrfs re-reads on a
 * checksum failure, md serves the other leg, the good block is written back,
 * and md propagates that write to both legs — `corrected_errors: 1`, both legs
 * good afterwards. Since the read-balance is not contractual, repeating the
 * pass raises the odds that md serves the rotten leg at least once; each pass's
 * `corrected` count is progress, and a whole-band md check after each pass is
 * what says whether the band is done.
 *
 * **Arm B — compare legs, arbitrate by checksum, write through md.** When the
 * scrub cannot reach it (md never served the rotten leg), both legs are read
 * directly at their own data offsets and compared row by row. For each
 * differing 4 KiB row the md byte is mapped BACK to a btrfs logical byte
 * ({@link logicalForMdByte}) and the row is arbitrated:
 *
 *  - a DATA chunk against the csum btrfs stored for that logical byte;
 *  - a METADATA or SYSTEM chunk against the containing node's own header
 *    checksum (`verifyNode`, the same check the csum reader makes before it
 *    believes a leaf);
 *  - a row in no chunk at all is FREE SPACE — nothing knows what it should
 *    hold, and legs may disagree about it. Skipped;
 *  - a DATA row with no stored csum (NOCOW, prealloc, `nodatasum`) has nothing
 *    to arbitrate with. Skipped;
 *  - both legs failing is `unresolvedRows`: nothing is written, and the band's
 *    residual is reported rather than hidden.
 *
 * The winning row is written THROUGH md, which writes both legs — the same
 * write the repair engine makes, for the same reason.
 *
 * ## What it does NOT do
 *
 * There is NO degraded window. The documented manual alternative — fail one
 * leg, scrub, remove, add, let md's resync copy the survivor (GT-22 b/c) — is a
 * full leg copy at ≈6–7.5 s/GiB with the array degraded throughout, which on a
 * 20 TB leg is a day and a half of single-copy exposure. This verb reads the
 * same bytes a check reads and never takes a leg out. It is never automatic,
 * never a read-path heal, and never pool-wide.
 */

const MDADM = '/usr/sbin/mdadm'
const BTRFS = '/usr/bin/btrfs'

/** The one mdadm action this module must never issue, on any band. */
export const MD_REPAIR_ACTION = '--action=repair'

/** A DATA chunk — the rows a stored checksum arbitrates. */
const CHUNK_TYPE_DATA_RE = /\bDATA\b/
/** A METADATA or SYSTEM chunk — the rows a tree node's own checksum arbitrates. */
const CHUNK_TYPE_TREE_RE = /\b(?:METADATA|SYSTEM)\b/

/** `btrfs scrub status`'s error breakdown, under the `Error summary:` line. */
const SCRUB_CORRECTED_RE = /^\s*Corrected:\s+(\d+)\s*$/m
const SCRUB_UNCORRECTABLE_RE = /^\s*Uncorrectable:\s+(\d+)\s*$/m

/** How many btrfs scrub passes arm A runs before it gives up and tries arm B. */
export const MIRROR_SCRUB_PASSES = 3

/**
 * How much of each leg is read at a time while comparing (arm B).
 *
 * The comparison is per 4 KiB ROW, but reading a leg 4 KiB at a time would be
 * one `dd` per row — hours of process spawning for a band the disks could
 * stream in minutes. So the legs are read in windows and compared in memory,
 * and only the rows that actually differ cost anything further.
 */
export const MIRROR_COMPARE_WINDOW_BYTES = 4 * 1024 * 1024

/**
 * The rate arm A's btrfs scrub passes are estimated at, in bytes/second.
 *
 * The same deliberate FLOOR the parity rewrite's estimate uses — 60 MiB/s,
 * comfortably below a modern 7200 rpm disk's sequential rate. It is the right
 * number for arm A because btrfs does that reading itself, at the disks' pace.
 */
export const MIRROR_RECONCILE_RATE_BYTES_S = 60 * 1024 * 1024

/**
 * The per-leg rate ARM B is estimated at, in bytes/second — and it is a third
 * of arm A's on purpose.
 *
 * Arm B's reads do not go at the disks' pace. They go through ANAS's own read
 * path (`readDirect`: `dd | base64` per window, decoded in the daemon), and
 * THAT is the limit. Live proof 2026-09-15, a real 2-disk AHR-1 pool on the
 * stunt node: 2.0 GiB per leg compared in 81.3 s, which is 26 MiB/s per leg —
 * while the confirm gate, quoting the 60 MiB/s disk floor, had promised 34 s.
 * An estimate that is 2.4× optimistic is exactly what the parity rewrite's own
 * note says an estimate must not be, so this one is set BELOW the measurement
 * (20 MiB/s) and the warning says what the limit is.
 *
 * It is also the honest scale statement: at this rate a 20 TB leg is about
 * twelve days of reading, which is why arm A runs first and why the operator
 * is told the number before they agree to it.
 */
export const MIRROR_COMPARE_RATE_BYTES_S = 20 * 1024 * 1024

/** One band of a pool, as much of it as this verb needs. */
export interface MirrorReconcileArray {
  /** Band index (1-based, bottom-up). */
  band: number
  /** md device path — `/dev/md/<pool>-r<band>`. */
  device: string
  /** Per-leg slice size: what one whole-band pass reads off each leg. */
  heightBytes: number
  /** How many legs the band has. */
  members: number
}

/**
 * The pool, narrowed to what a mirror reconcile reads.
 *
 * Structurally identical to the parity rewrite's narrowing, and for the same
 * reason: `AhrPool` satisfies it, which is how the route hands the real
 * topology straight in, and a loop rig (which is not an AHR pool and never will
 * be) satisfies it too, which is how the selfheal.2 suite drives this verb.
 */
export interface MirrorReconcilePool {
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
export type MirrorReconcileEvidence
  = | { ok: true, mismatchCnt: number, jobId: string }
    | { ok: false, code: AhrMirrorReconcileReasonCode, reason: string }

export interface MirrorReconcileOptions {
  /** Progress sink — the job's, or a console in the dev entry. */
  updateProgress?: (message: string) => void
  /**
   * Re-read the proof. Called at the start of the run AND again immediately
   * before arm B's first write, because it can stop being true in between.
   * The lookup lives in the route because the evidence is a JOB.
   */
  evidence?: () => MirrorReconcileEvidence | Promise<MirrorReconcileEvidence>
  /** Is a scrub / repair / rewrite / reconcile in flight on this pool right now? */
  jobConflict?: () => string | null
  /** Name the files a refusing scrub pass found (the route wires `attributeScrub`). */
  attributeFindings?: (since: Date) => Promise<AhrScrubFinding[]>
  /** How many arm-A btrfs scrub passes to run before falling through to arm B. */
  scrubPasses?: number
  /** Bytes of each leg read per window while comparing. */
  compareWindowBytes?: number
  /** Poll interval while waiting on the scrub and the md checks. */
  pollIntervalMs?: number
  /** Delay between a check going idle and the `mismatch_cnt` read. */
  mismatchDelayMs?: number
  /** How long an md check is given to actually start. */
  startTimeoutMs?: number
  /** Absolute ceiling on one check's finish-wait. */
  finishCeilingMs?: number
  /**
   * The resolved pool context (bands + btrfs tree roots), for a caller that
   * already has one. Resolved from the mountpoint when absent.
   */
  context?: SelfhealContext
}

// ---------------------------------------------------------------------------
//  The invariant: md repair is never issued on a mirror
// ---------------------------------------------------------------------------

/**
 * Refuse `mdadm --action=repair` before the process is spawned.
 *
 * The epic's standing ruling (2026-09-14) is that no ANAS code path may issue
 * md's own repair on a RAID1 band, because it copies leg 0 over the others
 * without arbitrating (GT-22(f)). A comment saying so is a convention; this is
 * a guard, and it throws rather than warning — a run that somehow reached this
 * point has a bug, and the correct outcome of that bug is a failed job, never a
 * blessed rot.
 */
export function assertNoMdRepair(command: string, args: readonly string[]): void {
  if (!command.endsWith('mdadm'))
    return
  if (args.some(a => a === MD_REPAIR_ACTION || a === 'repair' || a.startsWith('--action=repair'))) {
    throw new Error(
      `refusing to run 'mdadm ${args.join(' ')}': md's repair on a RAID1 band copies the first in-sync leg over the others without looking at which one is right, so it would bless rot half the time. The mirror reconcile arbitrates each row against the checksum btrfs stored for it instead. This is a bug in ANAS, not a state of the array`,
    )
  }
}

/**
 * The executor every command in this module goes through.
 *
 * Explicit delegation rather than a spread or a Proxy: `ProdExecutor` is a
 * class, so a spread would copy none of its methods, and the point of the
 * wrapper is that there is no way past it. Each door is `async` so the guard's
 * throw reaches the caller as a REJECTED PROMISE — the same shape every other
 * executor failure has, which is what the callers' `try`/`catch` is written for.
 */
export function mirrorGuardedExecutor(executor: CommandExecutor): CommandExecutor {
  return {
    exec: async (command, args, opts) => {
      assertNoMdRepair(command, args)
      return executor.exec(command, args, opts)
    },
    pipeline: async (cmd1, args1, cmd2, args2, opts) => {
      assertNoMdRepair(cmd1, args1)
      assertNoMdRepair(cmd2, args2)
      return executor.pipeline(cmd1, args1, cmd2, args2, opts)
    },
    execToStream: async (command, args, target, opts) => {
      assertNoMdRepair(command, args)
      return executor.execToStream(command, args, target, opts)
    },
  }
}

// ---------------------------------------------------------------------------
//  Evidence and gates
// ---------------------------------------------------------------------------

/** The band the request names, or null when the pool has no such band. */
export function mirrorReconcileArray(pool: MirrorReconcilePool, band: number): MirrorReconcileArray | null {
  const array = pool.arrays.find(a => a.band === band)
  return array
    ? { band: array.band, device: array.device, heightBytes: array.heightBytes, members: array.members.length }
    : null
}

/**
 * The per-band row a scrub or a repair result carries, read structurally.
 *
 * The same adapter shape the parity rewrite reads, and for the same reason: the
 * row is `AhrScrubParityMismatch`, the `level` on it is OPTIONAL, and a result
 * from an older daemon that omits it must parse — and then be refused, because
 * a consumer that cannot tell a mirror from a parity band must not offer either
 * verb for it.
 */
const MismatchRow = z.object({
  band: z.string().min(1),
  bandIndex: z.number().int().positive(),
  array: z.string().optional(),
  mismatchCnt: z.number().int().nonnegative(),
  level: z.string().optional(),
})
const ScrubEvidenceShape = z.object({
  btrfsErrors: z.string().nullable().optional(),
  findings: z.array(z.unknown()).optional(),
  parityMismatches: z.array(MismatchRow).optional(),
})
const RepairEvidenceShape = z.object({
  unrepairable: z.number().int().nonnegative().optional(),
  aboveMd: z.number().int().nonnegative().optional(),
  notExamined: z.number().int().nonnegative().optional(),
  parityResiduals: z.array(MismatchRow).optional(),
})

/**
 * Read the proof out of the pool's newest COMPLETED scrub or repair job.
 *
 * Three statements have to hold, and they are three different things:
 *  - md counted mismatches ON THIS BAND — otherwise there is nothing here to
 *    reconcile;
 *  - the band is a RAID1 band. A parity band's mismatch is parity disagreeing
 *    with data and has its own verb; arbitrating "legs" on it is meaningless;
 *  - the checksum pass was clean ACROSS THE POOL. A finding anywhere means a
 *    file btrfs cannot vouch for, and the two arms both assume the checksum
 *    tree is the authority. Repair those files first.
 */
export function mirrorReconcileEvidence(
  poolName: string,
  source: Job | undefined | readonly (Job | undefined)[],
  band: number,
): MirrorReconcileEvidence {
  const job = Array.isArray(source)
    ? [...source].filter((j): j is Job => !!j).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    : (source as Job | undefined)
  if (!job) {
    return {
      ok: false,
      code: 'no-mirror-mismatch',
      reason: `no completed scrub of AHR pool '${poolName}' is on record. A mirror reconcile stands entirely on the last two-phase scrub (band r${band} counted disagreeing legs, the checksum pass found nothing). Scrub the pool first. The record is in-memory, so a daemon restart also clears it`,
    }
  }
  if (job.operation === 'ahr.repair')
    return repairEvidence(poolName, job, band)

  const parsed = ScrubEvidenceShape.safeParse(job.result)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'no-mirror-mismatch',
      reason: `the last completed scrub of AHR pool '${poolName}' (job ${job.id}) did not report a result the mirror reconcile can read`,
    }
  }
  if (parsed.data.btrfsErrors != null || (parsed.data.findings?.length ?? 0) > 0) {
    return {
      ok: false,
      code: 'data-findings-present',
      reason: `the last scrub of AHR pool '${poolName}' (job ${job.id}) found data corruption${parsed.data.btrfsErrors ? `: ${parsed.data.btrfsErrors}` : ''}. Repair those files first. Both arms of the reconcile treat the checksum tree as the authority, and a file that already fails its checksum is not one this verb can arbitrate a leg against`,
    }
  }
  return rowEvidence(poolName, job.id, parsed.data.parityMismatches ?? null, band, 'scrub')
}

/**
 * The proof, read out of a completed REPAIR job instead.
 *
 * A repair that wrote a block, proved it cold against its stored checksum and
 * then saw md still counting the band has MEASURED the residual — the same
 * shortcut the parity rewrite takes, so an operator is not made to sit through
 * a fresh multi-hour scrub for a number this node already has. The other half
 * still has to hold: a run that left a block unrepaired, above md or unexamined
 * is a run with KNOWN data rot on the pool.
 */
function repairEvidence(poolName: string, job: Job, band: number): MirrorReconcileEvidence {
  const parsed = RepairEvidenceShape.safeParse(job.result)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'no-mirror-mismatch',
      reason: `the last completed repair on AHR pool '${poolName}' (job ${job.id}) did not report a result the mirror reconcile can read`,
    }
  }
  const unrepaired = (parsed.data.unrepairable ?? 0) + (parsed.data.aboveMd ?? 0) + (parsed.data.notExamined ?? 0)
  if (unrepaired > 0) {
    return {
      ok: false,
      code: 'data-findings-present',
      reason: `the last repair on AHR pool '${poolName}' (job ${job.id}) left ${unrepaired} block(s) unrepaired, above md or unexamined. Repair or restore those first — this verb arbitrates a leg against the checksum tree, and those blocks are exactly the ones it cannot`,
    }
  }
  return rowEvidence(poolName, job.id, parsed.data.parityResiduals ?? null, band, 'repair')
}

/** The band's row out of either result, with the level gate on it. */
function rowEvidence(
  poolName: string,
  jobId: string,
  rows: z.infer<typeof MismatchRow>[] | null,
  band: number,
  what: 'scrub' | 'repair',
): MirrorReconcileEvidence {
  if (rows === null) {
    return {
      ok: false,
      code: 'no-mirror-mismatch',
      reason: `the last ${what} of AHR pool '${poolName}' (job ${jobId}) reports no per-band counts. Scrub the pool again and reconcile from that run's findings`,
    }
  }
  const row = rows.find(r => r.bandIndex === band)
  if (!row || row.mismatchCnt <= 0) {
    return {
      ok: false,
      code: 'no-mirror-mismatch',
      reason: `the last ${what} of AHR pool '${poolName}' (job ${jobId}) counted no mismatch on band r${band}. There is nothing here to reconcile`,
    }
  }
  if (row.level === undefined) {
    return {
      ok: false,
      code: 'not-a-mirror-band',
      reason: `the last ${what} of AHR pool '${poolName}' (job ${jobId}) did not record what level band r${band} is, and the two mismatch verbs are not interchangeable — md counts disagreeing legs on a mirror and parity disagreeing with data on a parity band. Scrub the pool again and reconcile from that run's findings`,
    }
  }
  if (row.level !== 'raid1') {
    return {
      ok: false,
      code: 'not-a-mirror-band',
      reason: `band r${band} of AHR pool '${poolName}' is ${row.level}, not a mirror. Its mismatch is parity disagreeing with the data, which is what Rewrite parity is for. This verb arbitrates two legs against each other and there are none here`,
    }
  }
  return { ok: true, mismatchCnt: row.mismatchCnt, jobId }
}

/** A refusal with the code a parser keys on, or null when the band may be reconciled. */
export interface MirrorReconcileRefusal {
  reason: string
  code: AhrMirrorReconcileReasonCode
}

/**
 * The sentence a PARITY band is refused with — the mirror of
 * `mirrorBandRefusal` on the other verb.
 *
 * Between the two, the epic's invariant is stated at both doors: md's repair is
 * for a parity band with the data proven intact, and nothing else reaches it.
 */
export function parityBandRefusal(geo: MdGeometry): string {
  return `${geo.device} is a ${geo.level} band, not a mirror. Its mismatch is parity disagreeing with the data, and it is repaired by Rewrite parity — which recomputes parity from data a clean checksum pass has vouched for. This verb reads two legs and arbitrates them against each other, and a parity band has no second copy of a row to compare`
}

/** The sentence a band with recorded md bad blocks is refused with. */
export function mirrorBadBlocksRefusal(geo: MdGeometry): string {
  const carriers = bandBadBlocks(geo)
  const named = carriers.map(c => `${c.device} (${c.ranges.length} range${c.ranges.length === 1 ? '' : 's'})`).join(', ')
  return `${geo.device} has legs with recorded bad blocks: ${named}. md serves EIO for those ranges and holds no correct copy of them, so a row inside one cannot be read off that leg at all. Replace the member first`
}

/** Why this band cannot be reconciled right now (or ever), or null. */
export async function mirrorReconcileArrayRefusal(geo: MdGeometry): Promise<MirrorReconcileRefusal | null> {
  // FIRST, and not a state that can pass: every other refusal here is "not
  // now", this one is "not this band, ever".
  if (!geo.raid1)
    return { reason: parityBandRefusal(geo), code: 'not-a-mirror-band' }
  // Also not a state that passes. AHR builds two-leg mirror bands; the result
  // this verb reports counts winners per leg, and a shape it cannot describe is
  // one it must not act on.
  if (geo.raidDisks !== 2) {
    return {
      reason: `${geo.device} is a ${geo.raidDisks}-leg mirror. This verb arbitrates TWO legs against each other and reports which of the two won each row; it does not describe a wider mirror, and AHR does not build one`,
      code: 'not-a-mirror-band',
    }
  }
  if (bandBadBlocks(geo).length > 0)
    return { reason: mirrorBadBlocksRefusal(geo), code: 'bad-blocks-present' }
  const refusal = await arrayRefusal(geo)
  if (refusal)
    return { reason: refusal, code: 'array-busy' }
  // GT-13's trap: an interrupted check leaves `sync_min`/`sync_max` bounded and
  // the knob PERSISTS. A whole-band check issued under it would cover that
  // sliver and report a `mismatch_cnt` that means nothing — which is this
  // verb's only proof that it worked.
  const min = await readMdAttrOrNull(geo.sys, 'sync_min')
  const max = await readMdAttrOrNull(geo.sys, 'sync_max')
  if ((max !== null && max !== MD_DEFAULT_SYNC_MAX) || (min !== null && min !== MD_DEFAULT_SYNC_MIN)) {
    return {
      reason: `${geo.device}'s sync window is bounded to ${min ?? '?'}..${max ?? '?'} (an interrupted repair or check left it there). A whole-band check under it would cover only that sliver, and this run's proof is that check's count. A scrub of the pool restores the window`,
      code: 'array-busy',
    }
  }
  return null
}

// ---------------------------------------------------------------------------
//  The confirm gate's warnings
// ---------------------------------------------------------------------------

/** GiB, one decimal. */
function gib(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

/**
 * What the confirm gate must say before an operator can agree to this.
 *
 * Every line is a consequence, not a caution: what is read and for how long,
 * which rows this cannot arbitrate and are therefore left exactly as they are,
 * that the pool stays online throughout (the thing that distinguishes this from
 * the manual fail-a-leg procedure), and that it is never automatic.
 */
export function mirrorReconcileWarnings(
  poolName: string,
  array: MirrorReconcileArray,
  poolUsedBytes: number | null = null,
  passes: number = MIRROR_SCRUB_PASSES,
): string[] {
  const perLeg = array.heightBytes / MIRROR_COMPARE_RATE_BYTES_S
  const scrub = poolUsedBytes !== null && poolUsedBytes > 0
    ? `${gib(poolUsedBytes)} of data per pass, ≈${approximateDuration(poolUsedBytes / MIRROR_RECONCILE_RATE_BYTES_S)} each`
    : 'a duration this node could not estimate'
  return [
    `Arm A runs an ordinary btrfs checksum scrub of pool '${poolName}', up to ${passes} times (${scrub}), with a whole-band md check after each. A scrub that meets the rot heals the band through md by itself; md's read-balance decides whether it does, and repeating the pass is the only way to raise the odds`,
    `Arm B runs only if the mismatch survives arm A, and it is the long one. It reads BOTH legs of band r${array.band} in full — ${gib(array.heightBytes)} per leg, about ${approximateDuration(perLeg)} — and compares them row by row. That rate is ANAS's own read path rather than the disks': measured at 26 MiB/s per leg on a live pool, and estimated here at 20 MiB/s so the number is a ceiling on the wait`,
    `Each differing 4 KiB row is decided by the checksum btrfs stored for it, and the leg that matches is written back through md to both legs. A row with NO checksum is left exactly as it is: free space, a hand-set NOCOW (chattr +C) file, or a preallocated range. ANAS creates none of those and cannot see into one it did not create, so they are counted and reported, never guessed at`,
    `A row where NEITHER leg matches is never written. It is reported as a residual, and the file it belongs to needs restoring from backup`,
    `The pool stays ONLINE and undegraded throughout. No leg is failed, removed or re-added, so there is no single-copy window — which is the whole difference between this and doing it by hand with mdadm`,
    `md's own repair is NOT used and never will be on a mirror: it copies the first in-sync leg over the other without looking at which one is right, so on a band whose legs disagree it overwrites the good copy half the time. Do not run it by hand on this band either`,
    `This is never automatic. ANAS reconciles a mirror only when an operator asks for this band, with this proof in hand`,
  ]
}

// ---------------------------------------------------------------------------
//  btrfs scrub error counts (arm A's progress)
// ---------------------------------------------------------------------------

/** `Corrected:` / `Uncorrectable:` of a finished `btrfs scrub status`. */
export interface ScrubErrorCounts {
  corrected: number
  uncorrectable: number
}

/**
 * The error breakdown `btrfs scrub status` prints under its `Error summary:`
 * line, read after a pass has finished.
 *
 * `btrfsScrubPass` reports the summary LINE and nothing else, which is all the
 * parity rewrite needs (any error at all aborts it). Arm A needs the numbers:
 * `corrected` is the progress the scrub made healing the band through md, and
 * `uncorrectable` is the one that means a file is genuinely beyond this verb.
 * A clean pass prints no breakdown at all and both read zero.
 */
export function parseScrubErrorCounts(text: string): ScrubErrorCounts {
  return {
    corrected: Number(SCRUB_CORRECTED_RE.exec(text)?.[1] ?? 0),
    uncorrectable: Number(SCRUB_UNCORRECTABLE_RE.exec(text)?.[1] ?? 0),
  }
}

/** Read the finished pass's counts off `btrfs scrub status <mountpoint>`. */
async function scrubErrorCounts(executor: CommandExecutor, mountpoint: string): Promise<ScrubErrorCounts> {
  const r = await executor.exec(BTRFS, ['scrub', 'status', mountpoint])
  return r.exitCode === 0 ? parseScrubErrorCounts(r.stdout) : { corrected: 0, uncorrectable: 0 }
}

// ---------------------------------------------------------------------------
//  Whole-band md check
// ---------------------------------------------------------------------------

/** What a whole-band check came back with. */
type CheckResult
  = | { ok: true, mismatch: number | null }
  /** md took an operation of its own: the check is not ours and proves nothing. */
    | { ok: false, foreign: string }

/**
 * Issue a whole-band md `check` and read its `mismatch_cnt`.
 *
 * Whole-band because md does not say WHERE the legs disagree, so a bounded
 * window would prove nothing about the band. The ownership discipline is the
 * parity rewrite's, through the same helper (`waitForOwnSyncOp`): md running
 * anything this run did not issue ends the wait with every knob exactly as md
 * left it.
 */
async function wholeBandCheck(
  executor: CommandExecutor,
  geo: MdGeometry,
  label: string,
  opts: MirrorReconcileOptions,
): Promise<CheckResult> {
  const prior = await lastSyncAction(executor, geo.kernel)
  const issued = await executor.exec(MDADM, ['--action=check', geo.device])
  if (issued.exitCode !== 0)
    return { ok: false, foreign: `mdadm --action=check on ${label} exited ${issued.exitCode}${issued.stderr.trim() ? `: ${issued.stderr.trim()}` : ''}` }
  markCheckIssued(geo.kernel)
  let waited: Awaited<ReturnType<typeof waitForOwnSyncOp>>
  try {
    waited = await waitForOwnSyncOp(executor, geo, label, 'check', prior, opts)
  }
  finally {
    retireCheckIssued(geo.kernel)
    await restoreSyncKnobs(geo)
  }
  if (!waited.ended)
    return { ok: false, foreign: waited.foreign }
  await sleep(opts.mismatchDelayMs ?? AHR_SCRUB_MISMATCH_DELAY_MS)
  return { ok: true, mismatch: await mismatchCount(executor, geo.kernel) }
}

// ---------------------------------------------------------------------------
//  Arm B — comparing the legs
// ---------------------------------------------------------------------------

/** The md byte, placed on one leg at THAT leg's own data offset. */
function legOffset(geo: MdGeometry, mdByte: number, leg: number): number {
  // `placeMdByte` is the forward placement, and on RAID1 it is the whole of it;
  // `memberOffsetOn` is the one helper that turns it into a per-leg offset, so
  // a leg offset cannot be computed two ways in this codebase.
  const location: MemberLocation = {
    ...placeMdByte(mdByte, geo),
    logical: 0,
    lvByte: 0,
    geometry: geo,
    startSector: 0,
    chunkLogical: 0,
    chunkDevice: 0,
  }
  return memberOffsetOn(geo, location, leg)
}

/** How one differing row was decided. */
type RowVerdict
  = | { kind: 'won', leg: number, detail: string }
    | { kind: 'free-space' }
    | { kind: 'unchecked', detail: string }
    | { kind: 'unresolved', detail: string }

/** Everything arm B carries between rows of one run. */
interface CompareState {
  ctx: SelfhealContext
  band: SelfhealBand
  chunks: readonly ChunkItem[]
  geo: MdGeometry
  legs: number[]
  /** node logical bytenr → the leg whose copy of that node passed, or null. */
  nodes: Map<number, RowVerdict>
}

/**
 * Decide ONE differing 4 KiB row.
 *
 * The md byte is mapped back to a btrfs logical byte and the chunk that covers
 * it says which authority arbitrates: the csum tree for DATA, the node's own
 * header checksum for METADATA and SYSTEM, and nothing at all for free space.
 */
async function decideRow(
  executor: CommandExecutor,
  state: CompareState,
  mdByte: number,
  rows: Map<number, Buffer>,
): Promise<RowVerdict> {
  const back = logicalForMdByte(mdByte, state.band, state.chunks)
  if (back === null)
    return { kind: 'free-space' }
  if (back.logical % BLOCK_BYTES !== 0) {
    return {
      kind: 'unchecked',
      detail: `md byte ${mdByte} maps to btrfs logical ${back.logical}, which is not a 4 KiB boundary — nothing can be arbitrated against a skewed mapping`,
    }
  }
  if (CHUNK_TYPE_TREE_RE.test(back.chunk.type))
    return decideTreeRow(executor, state, mdByte, back.logical)
  if (!CHUNK_TYPE_DATA_RE.test(back.chunk.type)) {
    return {
      kind: 'unchecked',
      detail: `btrfs logical ${back.logical} is in a chunk of type '${back.chunk.type}', which this verb has no authority for`,
    }
  }

  let stored: number | null
  try {
    stored = await readStoredCsum(executor, state.ctx, back.logical)
  }
  catch (error) {
    if (error instanceof CsumUnreadableError) {
      return {
        kind: 'unresolved',
        detail: `btrfs logical ${back.logical}: ${error.message}`,
      }
    }
    throw error
  }
  if (stored === null) {
    return {
      kind: 'unchecked',
      detail: `btrfs logical ${back.logical} has no stored checksum (free or unused space in a data chunk, a NOCOW file, or a preallocated range) — there is nothing to arbitrate the legs against`,
    }
  }
  const matched = state.legs.filter(leg => crc32c(rows.get(leg) as Buffer) === stored)
  if (matched.length === 0) {
    return {
      kind: 'unresolved',
      detail: `btrfs logical ${back.logical}: neither leg matches the stored checksum ${csumHex(stored)} (${state.legs.map(leg => `${state.geo.members[leg]}=${csumHex(crc32c(rows.get(leg) as Buffer))}`).join(', ')})`,
    }
  }
  if (matched.length > 1) {
    // Both legs match the stored csum while holding different bytes: a crc32c
    // collision, or a csum tree that does not describe this row. Either way
    // nothing here picks a winner, and writing one would be a coin flip.
    return {
      kind: 'unresolved',
      detail: `btrfs logical ${back.logical}: both legs match the stored checksum ${csumHex(stored)} while holding different bytes. Nothing here can say which is the file`,
    }
  }
  return {
    kind: 'won',
    leg: matched[0],
    detail: `btrfs logical ${back.logical}: ${state.geo.members[matched[0]]} matches the stored checksum ${csumHex(stored)}`,
  }
}

/**
 * A METADATA or SYSTEM row: the containing 16 KiB node vouches for itself.
 *
 * btrfs stores no EXTENT_CSUM for tree blocks — the checksum is in the node's
 * own header, over its own bytes, which is exactly what `verifyNode` checks and
 * what `readStoredCsum` already uses before it believes a csum leaf. So the
 * question for a metadata row is the node's, and the verdict is CACHED per
 * node: a 16 KiB node is four rows, and reading it once per leg is enough for
 * all of them.
 */
async function decideTreeRow(
  executor: CommandExecutor,
  state: CompareState,
  mdByte: number,
  logical: number,
): Promise<RowVerdict> {
  const within = logical % NODE_BYTES
  const nodeLogical = logical - within
  const cached = state.nodes.get(nodeLogical)
  if (cached)
    return cached

  const nodeMdByte = mdByte - within
  const verdict = await ((async (): Promise<RowVerdict> => {
    const passing: number[] = []
    const details: string[] = []
    for (const leg of state.legs) {
      let bytes: Buffer
      try {
        bytes = await readDirect(executor, state.geo.members[leg] as string, legOffset(state.geo, nodeMdByte, leg), NODE_BYTES)
      }
      catch (error) {
        details.push(`${state.geo.members[leg]}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const check = verifyNode(bytes, nodeLogical)
      details.push(`${state.geo.members[leg]}: ${check.detail}`)
      if (check.ok)
        passing.push(leg)
    }
    if (passing.length === 1)
      return { kind: 'won', leg: passing[0], detail: `metadata node ${nodeLogical}: ${details.join('; ')}` }
    if (passing.length === 0)
      return { kind: 'unresolved', detail: `metadata node ${nodeLogical}: no leg's copy passes its own checksum (${details.join('; ')})` }
    // Two valid nodes claiming the same bytenr: one of them is a stale but
    // internally consistent write. Nothing on this node says which generation
    // the trees actually point at, and guessing would corrupt the filesystem.
    return { kind: 'unresolved', detail: `metadata node ${nodeLogical}: both legs hold a node that passes its own checksum while the bytes differ (${details.join('; ')})` }
  })())

  state.nodes.set(nodeLogical, verdict)
  return verdict
}

// ---------------------------------------------------------------------------
//  The sequence
// ---------------------------------------------------------------------------

/** Where the run stopped, with everything it learned up to that point. */
interface RunState {
  arm: 'scrub' | 'compare'
  passes: { corrected: number, mismatchAfter: number | null }[]
  rowsCompared: number
  rowsDiffering: number
  rowsWritten: { leg0: number, leg1: number }
  freeSpaceRows: number
  uncheckedRows: number
  unresolvedRows: number
  mismatchBefore: number | null
  mismatchAfter: number | null
  scrubMs: number
  compareMs: number
  checkMs: number
}

/**
 * Reconcile one mirror band: arm A "scrub until clean", then — only if the
 * mismatch survives it — arm B "compare legs, arbitrate by checksum, write
 * through md".
 *
 * Never `mdadm --action=repair`: every command this function issues goes
 * through {@link mirrorGuardedExecutor}, which refuses it before the process is
 * spawned.
 */
export async function reconcileMirrorBand(
  executor: CommandExecutor,
  pool: MirrorReconcilePool,
  band: number,
  options: MirrorReconcileOptions = {},
): Promise<AhrMirrorReconcileResult> {
  const guarded = mirrorGuardedExecutor(executor)
  const opts = options
  const progress = opts.updateProgress ?? (() => {})
  const startedAt = Date.now()
  const state: RunState = {
    arm: 'scrub',
    passes: [],
    rowsCompared: 0,
    rowsDiffering: 0,
    rowsWritten: { leg0: 0, leg1: 0 },
    freeSpaceRows: 0,
    uncheckedRows: 0,
    unresolvedRows: 0,
    mismatchBefore: null,
    mismatchAfter: null,
    scrubMs: 0,
    compareMs: 0,
    checkMs: 0,
  }
  /**
   * What a btrfs scrub pass found that NO copy can satisfy, or null.
   *
   * Carried rather than refused on: see the arm-A loop below. It rides every
   * outcome, and it turns the notification's severity to `warning` even when
   * the band itself came out clean.
   */
  let lost: { btrfsErrors: string | null, findings?: AhrScrubFinding[] } | null = null

  const finish = async (
    outcome: AhrMirrorReconcileResult['outcome'],
    array: string | null,
    extra: Partial<AhrMirrorReconcileResult> = {},
  ): Promise<AhrMirrorReconcileResult> => {
    const result = AhrMirrorReconcileResultSchema.parse({
      pool: pool.name,
      band,
      array,
      arm: state.arm,
      passes: state.passes,
      rowsCompared: state.rowsCompared,
      rowsDiffering: state.rowsDiffering,
      rowsWritten: state.rowsWritten,
      freeSpaceRows: state.freeSpaceRows,
      uncheckedRows: state.uncheckedRows,
      unresolvedRows: state.unresolvedRows,
      mismatchBefore: state.mismatchBefore,
      mismatchAfter: state.mismatchAfter,
      outcome,
      // The uncorrectable files a scrub pass named ride EVERY later outcome:
      // they are the run's own finding and must not be dropped because the
      // band itself came out clean.
      ...(lost ? { btrfsErrors: lost.btrfsErrors, ...(lost.findings ? { findings: lost.findings } : {}) } : {}),
      ...extra,
      durations: {
        scrubMs: state.scrubMs,
        compareMs: state.compareMs,
        checkMs: state.checkMs,
        totalMs: Date.now() - startedAt,
      },
    })
    // ONE notification, whatever happened (§7.2/§7.3). The line about md's own
    // repair rides every one of them: an operator who has just been told a
    // mirror band is still mismatched is exactly the operator who reaches for
    // `mdadm --action=repair` next, and it would bless the rot.
    const counts = `mismatch_cnt ${result.mismatchBefore ?? 'unknown'} before, ${result.mismatchAfter ?? 'unknown'} after`
    const dont = ' Do not run mdadm --action=repair on a mirror band: it copies the first in-sync leg over the other without looking at which one is right.'
    const lostLine = lost
      ? ` A btrfs scrub pass also reported errors no copy could satisfy (${lost.btrfsErrors ?? 'uncorrectable'})${lost.findings?.length ? `: ${lost.findings.map(f => f.path).join(', ')}` : ''}. Those rows have no good leg and were never written — restore them from backup.`
      : ''
    const body = outcome === 'reconciled'
      ? (result.arm === 'scrub'
          ? `the legs of band r${band} of pool '${pool.name}' agree again: ${result.passes.length} btrfs scrub pass(es) healed the band through md and a whole-band check counted 0 (${counts})`
          : `the legs of band r${band} of pool '${pool.name}' agree again: ${result.rowsDiffering} differing row(s) were arbitrated against the checksums btrfs stored for them and ${result.rowsWritten.leg0 + result.rowsWritten.leg1} written back through md, and a whole-band check counted 0 (${counts})`)
      : `${result.reason ?? 'the run did not complete'} (${counts})`
    await pveNotify(
      guarded,
      outcome === 'reconciled' && lost === null ? 'info' : 'warning',
      `AHR mirror reconcile on ${pool.name}-r${band}: ${outcome}`,
      outcome === 'reconciled' ? body + lostLine : body + dont + lostLine,
    )
    return result
  }

  const array = mirrorReconcileArray(pool, band)
  if (!array)
    return finish('refused', null, { reason: `AHR pool '${pool.name}' has no band r${band}`, reasonCode: 'no-such-band' })
  if (!pool.mounted) {
    return finish('refused', array.device, {
      reason: `AHR pool '${pool.name}' is not mounted. Arm A is a btrfs scrub and arm B reads the checksum tree, and both need the filesystem online`,
      reasonCode: 'pool-not-mounted',
    })
  }

  const label = `${pool.name}-r${band}`

  // --- Preconditions, at submit ---------------------------------------------
  const evidence = opts.evidence ? await opts.evidence() : null
  if (evidence && !evidence.ok)
    return finish('refused', array.device, { reason: evidence.reason, reasonCode: evidence.code })
  if (evidence?.ok)
    state.mismatchBefore = evidence.mismatchCnt

  const conflict = opts.jobConflict?.()
  if (conflict)
    return finish('refused', array.device, { reason: conflict, reasonCode: 'job-active' })

  const geo = await readMdGeometry(guarded, array.device)
  const busy = await mirrorReconcileArrayRefusal(geo)
  if (busy)
    return finish('refused', array.device, { reason: busy.reason, reasonCode: busy.code })

  const live = await mismatchCount(guarded, geo.kernel)
  if (live !== null)
    state.mismatchBefore = live

  // --- Arm A: scrub until clean ---------------------------------------------
  const passes = Math.max(1, opts.scrubPasses ?? MIRROR_SCRUB_PASSES)
  for (let pass = 1; pass <= passes; pass++) {
    progress(`arm A, pass ${pass}/${passes}: btrfs checksum scrub of pool '${pool.name}'. A scrub that meets the rot heals the band through md`)
    const scrubStart = Date.now()
    const ran = await btrfsScrubPass(guarded, pool.mountpoint, pool.name, progress, opts.pollIntervalMs ?? AHR_SCRUB_POLL_MS)
    const counts = await scrubErrorCounts(guarded, pool.mountpoint)
    state.scrubMs += Date.now() - scrubStart
    if (counts.uncorrectable > 0 && lost === null) {
      // NOT a refusal, and this is the one place this verb differs from the
      // parity rewrite. That verb aborts on any finding because md repair would
      // BLESS the rot; this one writes nothing it cannot prove, so a file
      // neither leg can satisfy is a fact to REPORT — arm B will report its
      // rows as `unresolvedRows` — and not a reason to leave the rest of the
      // band mismatched. The files are named once, from the pass that found
      // them.
      let findings: AhrScrubFinding[] | undefined
      try {
        findings = await opts.attributeFindings?.(ran.startedAt)
      }
      catch (error) {
        progress(`the scrub's errors could not be attributed to files: ${error instanceof Error ? error.message : String(error)}`)
      }
      lost = { btrfsErrors: ran.btrfsErrors, ...(findings ? { findings } : {}) }
      progress(`arm A, pass ${pass}: btrfs reported ${counts.uncorrectable} uncorrectable error(s)${findings?.length ? ` (${findings.map(f => f.path).join(', ')})` : ''}. Those rows have no good copy on either leg and will be reported, never written. The rest of the band is still reconciled`)
    }
    progress(counts.corrected > 0
      ? `arm A, pass ${pass}: btrfs corrected ${counts.corrected} block(s) through md — md served the good leg and the write went to both`
      : `arm A, pass ${pass}: the scrub corrected nothing. md served a leg that satisfies every checksum`)

    const checkStart = Date.now()
    progress(`arm A, pass ${pass}: whole-band md check on ${label}. md counts legs that disagree, so this is what says whether the band is done`)
    const checked = await wholeBandCheck(guarded, geo, label, opts)
    state.checkMs += Date.now() - checkStart
    if (!checked.ok) {
      state.passes.push({ corrected: counts.corrected, mismatchAfter: null })
      return finish('refused', array.device, {
        reason: `${checked.foreign}. The band's state is unproven and NOTHING was written`,
        reasonCode: 'foreign-sync-op',
      })
    }
    state.passes.push({ corrected: counts.corrected, mismatchAfter: checked.mismatch })
    state.mismatchAfter = checked.mismatch
    if (checked.mismatch === 0)
      return finish('reconciled', array.device)
    if (counts.corrected === 0) {
      // The scrub had nothing to correct and md still counts disagreeing legs:
      // md is not serving the rotten leg, and running the same pass again is
      // the same coin flip. This is the residual case the story names, and it
      // is exactly what arm B is for.
      progress(`arm A did not reach the rot: the scrub corrected nothing and ${label} still counts ${checked.mismatch ?? 'an unreadable number of'} mismatch(es). md is not serving the rotten leg to btrfs`)
      break
    }
  }

  // --- Arm B: compare legs --------------------------------------------------
  state.arm = 'compare'

  // The same preconditions, immediately before anything is written. Arm A can
  // be hours on a real pool, and every one of these can have stopped being
  // true in that time.
  const evidenceNow = opts.evidence ? await opts.evidence() : null
  if (evidenceNow && !evidenceNow.ok)
    return finish('refused', array.device, { reason: `${evidenceNow.reason} (re-checked before arm B)`, reasonCode: evidenceNow.code })
  const conflictNow = opts.jobConflict?.()
  if (conflictNow)
    return finish('refused', array.device, { reason: `${conflictNow} (re-checked before arm B)`, reasonCode: 'job-active' })
  let busyNow: MirrorReconcileRefusal | null = await mirrorReconcileArrayRefusal(geo)
  if (!busyNow) {
    const preWrite = await preWriteRefusal(geo)
    if (preWrite)
      busyNow = { reason: preWrite, code: 'array-busy' }
  }
  if (busyNow)
    return finish('refused', array.device, { reason: `${busyNow.reason}. Nothing was written`, reasonCode: busyNow.code })

  const ctx = opts.context ?? await resolveContext(guarded, pool.mountpoint)
  const bandCtx = ctx.bands.find(b => b.geometry?.kernel === geo.kernel)
  if (!bandCtx || bandCtx.geometry === null) {
    return finish('refused', array.device, {
      reason: `band r${band} (${array.device}) is not one of the dm segments under pool '${pool.name}' — the reverse mapping from an md byte to a btrfs logical byte has no segment to run through, so no row can be arbitrated. Nothing was written`,
      reasonCode: 'array-busy',
    })
  }
  const legs = geo.members.map((m, i) => (m ? i : -1)).filter(i => i >= 0)
  for (const leg of legs) {
    if (geo.dataOffsets[leg] % BLOCK_BYTES !== 0) {
      return finish('refused', array.device, {
        reason: `leg ${geo.members[leg]} of ${array.device} has a data offset of ${geo.dataOffsets[leg]} bytes, which is not a multiple of ${BLOCK_BYTES}. A row read at that offset would not be the row md placed there. Nothing was written`,
        reasonCode: 'array-busy',
      })
    }
  }

  progress(`arm B: reading the chunk tree of pool '${pool.name}' — a differing row is arbitrated by the chunk it is in, and nothing in the tree is keyed by device offset`)
  const chunks = await readAllChunkItems(guarded, ctx)

  const sectors = await memberDataSectors(geo)
  const spanBytes = Math.floor(((sectors ?? 0) * 512) / BLOCK_BYTES) * BLOCK_BYTES
  if (spanBytes <= 0) {
    return finish('refused', array.device, {
      reason: `${array.device} reports no readable data area (rd<n>/size and rd<n>/offset), so there is nothing to compare. Nothing was written`,
      reasonCode: 'array-busy',
    })
  }
  const window = Math.max(BLOCK_BYTES, Math.floor((opts.compareWindowBytes ?? MIRROR_COMPARE_WINDOW_BYTES) / BLOCK_BYTES) * BLOCK_BYTES)
  const compareState: CompareState = { ctx, band: bandCtx, chunks, geo, legs, nodes: new Map() }
  const notes: string[] = []
  const compareStart = Date.now()

  progress(`arm B: comparing both legs of ${label} row by row — ${gib(spanBytes)} per leg, about ${approximateDuration(spanBytes / MIRROR_RECONCILE_RATE_BYTES_S)}`)
  for (let base = 0; base < spanBytes; base += window) {
    const length = Math.min(window, spanBytes - base)
    const legBytes = new Map<number, Buffer>()
    for (const leg of legs)
      legBytes.set(leg, await readDirect(guarded, geo.members[leg] as string, legOffset(geo, base, leg), length))
    const first = legBytes.get(legs[0]) as Buffer
    for (let at = 0; at < length; at += BLOCK_BYTES) {
      state.rowsCompared++
      const rows = new Map<number, Buffer>()
      for (const leg of legs)
        rows.set(leg, (legBytes.get(leg) as Buffer).subarray(at, at + BLOCK_BYTES))
      let differs = false
      for (const leg of legs.slice(1)) {
        if (!first.subarray(at, at + BLOCK_BYTES).equals(rows.get(leg) as Buffer))
          differs = true
      }
      if (!differs)
        continue
      state.rowsDiffering++
      const mdByte = base + at
      const verdict = await decideRow(guarded, compareState, mdByte, rows)
      if (verdict.kind === 'free-space') {
        state.freeSpaceRows++
        continue
      }
      if (verdict.kind === 'unchecked') {
        state.uncheckedRows++
        if (notes.length < 10)
          notes.push(verdict.detail)
        continue
      }
      if (verdict.kind === 'unresolved') {
        state.unresolvedRows++
        if (notes.length < 10)
          notes.push(verdict.detail)
        continue
      }
      await writeDirect(guarded, array.device, mdByte, rows.get(verdict.leg) as Buffer)
      if (verdict.leg === 0)
        state.rowsWritten.leg0++
      else
        state.rowsWritten.leg1++
      progress(`arm B: md byte ${mdByte} — ${verdict.detail}; written through md to both legs`)
    }
    const done = Math.min(base + length, spanBytes)
    progress(`arm B: ${gib(done)} of ${gib(spanBytes)} per leg compared (${state.rowsDiffering} differing row(s), ${state.rowsWritten.leg0 + state.rowsWritten.leg1} written)`)
  }
  state.compareMs = Date.now() - compareStart

  // --- The proof: a whole-band check, again ---------------------------------
  progress(`arm B: whole-band md check on ${label}. Proving the legs agree now`)
  const finalStart = Date.now()
  const finalCheck = await wholeBandCheck(guarded, geo, label, opts)
  state.checkMs += Date.now() - finalStart
  if (!finalCheck.ok) {
    return finish('residual', array.device, {
      reason: `arm B wrote ${state.rowsWritten.leg0 + state.rowsWritten.leg1} row(s), but ${finalCheck.foreign}. The verifying check did not complete, so the band is unproven`,
      reasonCode: 'foreign-sync-op',
    })
  }
  state.mismatchAfter = finalCheck.mismatch

  const residualNote = notes.length > 0 ? ` First rows: ${notes.join('; ')}` : ''
  if (state.unresolvedRows > 0) {
    return finish('residual', array.device, {
      reason: `${state.unresolvedRows} row(s) of ${label} could not be arbitrated: neither leg satisfies the checksum btrfs stored for them. Those rows were NOT written, and ${label} still counts ${state.mismatchAfter ?? 'an unreadable number of'} mismatch(es). The files they belong to need restoring from backup.${residualNote}`,
    })
  }
  if (state.mismatchAfter === null) {
    return finish('residual', array.device, {
      reason: `arm B wrote ${state.rowsWritten.leg0 + state.rowsWritten.leg1} row(s), but ${geo.device}'s mismatch_cnt could not be read afterwards. The band is not proven`,
    })
  }
  if (state.mismatchAfter > 0) {
    return finish('residual', array.device, {
      reason: `${label} still counts ${state.mismatchAfter} mismatch(es) after arm B compared every row of both legs and wrote ${state.rowsWritten.leg0 + state.rowsWritten.leg1}. ${state.uncheckedRows > 0 ? `${state.uncheckedRows} differing row(s) had no checksum to arbitrate them and were left exactly as they are, which is the likely remainder. ` : ''}Look at the disks before running this again.${residualNote}`,
    })
  }
  return finish('reconciled', array.device)
}
