import type {
  AhrPool,
  SelfhealDiagnostics,
  SelfhealMapping,
  SelfhealOutcome,
  SelfhealOutcomeKind,
  SelfhealParityResidual,
  SelfhealReasonCode,
  SelfhealReconstruction,
  SelfhealStep,
  SelfhealStepName,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import type { MdGeometry, MemberLocation, ResolvedBlock, SelfhealContext } from './selfheal-map.js'
import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { SELFHEAL_ARRAY_REBUILDS_ROT, SELFHEAL_BAD_BLOCKS_PRESENT, SELFHEAL_NO_CHECKSUM, SELFHEAL_RUN_STOPPED, SELFHEAL_WRITE_UNCONFIRMED } from '@anas/shared'
import {
  createAhrSnapshot,
  deleteAhrSnapshot,
  listAhrSnapshots,
  SUBVOL_DATA,
  SUBVOL_SNAPSHOTS,
  topLevelMountPath,
  withTopLevelMountWithin,
} from './ahr-snapshots.js'
import { crc32c, csumHex, CsumUnreadableError, readStoredCsum } from './selfheal-csum.js'
import {
  BLOCK_BYTES,
  DirectReadError,
  dropCaches,
  MD_DEFAULT_SYNC_MAX,
  MD_DEFAULT_SYNC_MIN,
  probeFileBlockState,
  readDirect,
  readDiscard,
  readMdAttr,
  readMdAttrOrNull,
  sleep,
  writeDirect,
  writeMdAttr,
} from './selfheal-io.js'
import {
  memberHasBadBlock,
  memberOffsetOn,
  parseBadBlocks,
  parseDmTable,
  resolveBlock,
  resolveContext,
  SelfhealMapError,
  stripeDataOrder,
  subvolumeIdOf,
} from './selfheal-map.js'
import {
  foreignOpNote,
  forgetWindowNarrowed,
  isIdleSyncAction,
  markCheckIssued,
  markWindowNarrowed,
  mayWidenSyncMaxUnder,
  narrowedSyncMax,
  ownsSyncOp,
  retireCheckIssued,
} from './selfheal-syncop.js'

/**
 * The AHR self-heal REPAIR ENGINE (story selfheal.5) — btrfs's checksum
 * arbitrating an md reconstruction, for ONE 4 KiB file block.
 *
 * md knows which disks hold a parity group; btrfs knows what the bytes in it
 * should be. Neither alone can fix silent rot: md's `repair` would happily
 * recompute parity over the junk, and btrfs on a single device has no second
 * copy to fall back to. Put together, the corrupt block is reconstructed from
 * the siblings and the reconstruction is only accepted if it matches the
 * stored crc32c.
 *
 * ## The sequence, and why it is in this order
 *
 * ```
 *  gates       degraded / resyncing / reshaping / recovering / pvmove, and a
 *              top-level mount already held by another job ⇒ refuse
 *  pin         transient read-only snapshot (backup2.3 lifecycle) — through
 *              `ahr-snapshots.ts` for a §12 pool, in place for a flat one
 *  resolve     re-resolve the block AFTER pinning, through the ONE mapping helper
 *  reverify    the bytes AT THE COMPUTED MEMBER LOCATION must FAIL the stored
 *              csum — otherwise "not corrupt here" and nothing is written
 *  precheck    bounded md check over the stripe AND a direct read of every
 *              member's row; both saying the parity group agrees with itself,
 *              while the block is corrupt, ⇒ above-md (GT-23)
 *  rmw         rmw_level = 0 for the write window (GT-7/GT-14)
 *  reconstruct XOR (RAID5) / P-XOR then Q syndrome (RAID6) / the other legs (RAID1)
 *  arbitrate   crc32c(candidate) vs the stored csum — the whole claim of the epic
 *  guard       the md block at the computed offset must equal the member bytes
 *              (RAID1: ANY leg's — md serves a mirror read from either)
 *  write       the winner through md, O_DIRECT + fsync
 *  postcheck   bounded check again, corroborated by the same direct read;
 *              anything but a consistent group is a failure, not a success
 *  coldread    the block through the FRESH SNAPSHOT, O_DIRECT
 *  finally     restore rmw_level / sync_min / sync_max / stripe_cache_size,
 *              destroy the snapshot
 * ```
 *
 * **Why `rmw_level = 0`.** At the default, a write-through of the corrected
 * block does read-modify-write: md reads the OLD (junk) block off the member,
 * xors it out of parity and xors the new one in — restoring the data and
 * poisoning the parity, so failing any other member of that stripe then
 * reconstructs one wrong block (GT-7, and GT-14: this happens whenever the
 * stripe is cache-cold, which is the real-world case). At `rmw_level=0` md
 * takes the reconstruct-write path and rebuilds the whole group.
 *
 * **Why the pin, and why re-resolve after it.** The snapshot freezes the
 * extent under repair for the run: btrfs is copy-on-write, and a file rewritten
 * between the resolve and the write would leave the engine repairing a block
 * that is no longer part of it. It is also the cold-read path at the end — a
 * fresh snapshot's inodes have no page cache behind them, so the final read
 * genuinely goes to the disks. Everything is resolved AFTER the snapshot
 * exists so the mapping describes the pinned state. On a §12 pool the pin IS an
 * AHR snapshot — same `@snapshots` home, same on-demand top-level mount, same
 * verbs (see {@link Pin}) — so there is one snapshot machinery on this
 * filesystem and not two.
 *
 * **Why the trees are never dumped.** Every btrfs lookup the engine makes is a
 * key-directed walk of a handful of 16 KiB nodes (`selfheal-btree.ts`).
 * `dump-tree -t 7` on an 80 TB pool is tens of gigabytes; through the
 * executor's buffer it is not a slow path, it is no path at all.
 *
 * **What a failed post-check means, and what it does not.** A repaired data
 * block over a stripe md still disagrees with reads correct today and
 * reconstructs wrong the day a disk dies, so the engine never calls it clean.
 * But it is not the same verdict as a block that could not be repaired at all
 * (seventh pass, F2): on RAID6 with rot in the target block AND in Q, P-XOR
 * wins arbitration and md still counts the stripe because Q is wrong. The block
 * is then re-read COLD and arbitrated again; if it passes, it is `repaired` and
 * the leftover is a PARITY residual on the band — carried out on the outcome so
 * Rewrite parity can act on it, and never as advice to restore a file that was
 * just proven correct.
 *
 * **Four things the engine refuses to call an answer about the bytes.** An
 * inline extent, a hole, a truncated owner scan, a band whose geometry went
 * unreadable — plus a read-back guard failure and a path whose inode is not the
 * one the scrub examined — are blocks NOBODY LOOKED AT. They are `not-examined`
 * with the reason, never `mapping-abort` (which asserts the bytes passed their
 * checksum) and never `unrepairable` (which advises a restore).
 *
 * ## What this cut does NOT repair (by design, all `unrepairable`)
 *
 *  - Extents with no stored csum — NOCOW, prealloc, `nodatasum`. Nothing to
 *    arbitrate against; a reconstruction could not be told from junk.
 *  - More than one corrupt on-disk sector inside ONE compressed blob. The
 *    repair unit for a compressed extent is the whole blob and a single
 *    reconstruction covers one sector of it.
 *  - Two corrupt blocks in one RAID5 stripe (the reconstruction then fails
 *    arbitration, which is the point of arbitrating).
 *  - Corruption that arrived THROUGH md — reported as `above-md`, never
 *    "repaired": parity agrees with the bad data, so there is no source of
 *    truth left below the csum tree. That verdict is CACHE-INDEPENDENT since
 *    GT-23: it is computed from the member rows themselves, with md's bounded
 *    check as corroboration, because on kernel 7.0.14-17 a stripe written
 *    moments ago survives the engine's eviction and its check answers from the
 *    cache. See {@link directParityConsistent}.
 */

/** What the caller asks to be repaired. */
export interface SelfhealRepairRequest {
  /** The pool's mountpoint — the subvolume the file is reached through. */
  mountpoint: string
  /** Absolute path of the file, under `mountpoint`. */
  file: string
  /** 4 KiB file block index. */
  block: number
  /**
   * The inode the SCRUB examined, when the caller knows it (seventh pass, F11).
   *
   * A path is not an identity. The finding carries an inode; when it rides in,
   * the engine `stat`s the path at the gates — before it pins anything — and
   * refuses a mismatch by name rather than leaving the re-verify to notice by
   * accident. Omitted, nothing changes.
   */
  inode?: number
  /**
   * The AHR pool, when the caller has it (selfheal.6 does; the dev entry point
   * resolves it from the topology). A §12 pool — `subvolLayout` — pins through
   * the SAME `@snapshots` machinery every other AHR snapshot goes through; a
   * flat pool, or no pool at all, falls back to an in-place snapshot.
   */
  pool?: AhrPool | null
}

/** Knobs the caller may turn; all of them have honest defaults. */
export interface SelfhealRepairOptions {
  /**
   * Called immediately BEFORE each step. Throwing from it aborts the sequence
   * with the full cleanup still running — which is how both the unit tests and
   * the selfheal.2 suite's case 4 prove that every md knob is restored and no
   * transient snapshot survives, at EVERY step boundary.
   */
  beforeStep?: (name: SelfhealStepName) => void | Promise<void>
  /** Seconds a bounded md check may take before the engine gives up. */
  checkTimeoutSeconds?: number
  /** Stripes swept either side of the target when evicting md's stripe cache. */
  evictSpan?: number
  /** Passed straight to the AHR snapshot service (tests point its runtime dir at a temp path). */
  ahrSnapshotOptions?: AhrSnapshotOptions
  /**
   * Milliseconds the final cold read may wait for the pool's top-level mount
   * before it is skipped (S2). Default {@link SELFHEAL_COLD_READ_WAIT_MS}.
   */
  coldReadWaitMs?: number
  /**
   * Milliseconds waited after a bounded check ends before `mismatch_cnt` is
   * read. The default is what the kernel needs (the counter finalizes slightly
   * after `sync_action` flips to idle — read it sooner and you get the PREVIOUS
   * check's number); a fake md in a unit test needs none of it.
   */
  settleMs?: number
}

/** An engine run that ended in something other than one of the four verdicts. */
export class SelfhealRunError extends Error {
  /**
   * The repaired-block sentence when the run stopped AFTER the block was
   * written (cr3 AHR-HEAL-H1), or null when nothing was. A caller that turns
   * this error into an outcome reads it first: "nothing was written" is false
   * of a run that got past the write, whatever stopped it afterwards.
   */
  readonly written: string | null

  /**
   * What the reader does next, when the site that threw knows its cause
   * (review R1): a member that could not be read, a bounded check that did not
   * finish, a pin that failed. Absent, the job says "final for this run,
   * report it".
   */
  readonly advice: string | null

  constructor(
    message: string,
    readonly steps: SelfhealStep[],
    readonly diagnostics: SelfhealDiagnostics,
    options?: { cause?: unknown, written?: string | null, advice?: string | null },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'SelfhealRunError'
    this.written = options?.written ?? null
    this.advice = options?.advice ?? null
  }
}

/**
 * md's bounded check over a stripe did not finish within its cap (review R1).
 * Typed so the run that met it can name the band to watch.
 */
export class CheckTimeoutError extends Error {
  constructor(message: string, readonly device: string) {
    super(message)
    this.name = 'CheckTimeoutError'
  }
}

/** Internal: stop the sequence with one of the four verdicts. */
class Verdict extends Error {
  constructor(
    readonly kind: SelfhealOutcomeKind,
    message: string,
    /** Set only where a parser has to tell this verdict from its neighbours (D3). */
    readonly code?: SelfhealReasonCode,
  ) {
    super(message)
    this.name = 'Verdict'
  }
}

const BTRFS = '/usr/bin/btrfs'
const DMSETUP = '/usr/sbin/dmsetup'
const FINDMNT = '/usr/bin/findmnt'

/** Leading slashes of a `subvolid-resolve` answer. */
const LEADING_SLASH_RE = /^\/+/

/**
 * A pool's layout, read EXPLICITLY (cr3, from the AHR core lane):
 * `subvolLayout` becomes `boolean | null` there, null when the kernel mount
 * table could not be read. `true` is §12, `false` is flat, `undefined` (an
 * older shape) is flat as it always was, and null is UNKNOWN — never the flat
 * layout a falsy test would read it as (which would put the pin inside the
 * mountpoint instead of `@snapshots`).
 */
export function poolLayout(pool: AhrPool | null | undefined): 'subvol' | 'flat' | 'unknown' {
  const v = (pool as { subvolLayout?: boolean | null } | null | undefined)?.subvolLayout
  if (v === true)
    return 'subvol'
  if (v === null)
    return 'unknown'
  return 'flat'
}

/**
 * What the reader does after a band whose md facts could not be read
 * (cr3.heal.paths): the read that failed is named in the reason before it.
 */
export const BAND_UNREADABLE_ADVICE = 'Run Repair from parity again once the AHR panel shows that band clean. '
  + 'If it stops here again while the band shows clean, report it with this job\'s result.'

/** The sentence every result ANAS cannot explain ends with (cr3.heal.paths, coordinator decision 4). */
export const REPORT_IT_ADVICE = 'This result is final for this run. Report it with this job\'s result.'

/**
 * A sentence that opens with a fragment (review R6: the gate sentences lost
 * their "refused:" prefix): its first letter capitalised. A path opens as it
 * is.
 */
function asSentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** `/dev/mdN` → `mdN`, the key `AhrArray.kernelName` carries. */
const DEV_PREFIX_RE = /^\/dev\//

/** The sentence a repair and a sweep stop with on an unknown layout. */
function unknownLayoutSentence(pool: AhrPool): string {
  return `the mount state of pool '${pool.name}' could not be read, so it is not known whether its snapshots live in @snapshots or inside the mountpoint`
}

/** Prefix of the engine's transient snapshots — its own sweep, nobody else's. */
export const SELFHEAL_SNAPSHOT_PREFIX = 'anas-selfheal-'

/** `array_state` values a repair refuses to write under, with the reason. */
const REFUSED_ARRAY_STATES: Record<string, string> = {
  'inactive': 'the array is inactive',
  'clear': 'the array holds no data yet',
  'readonly': 'the array is read-only',
  'read-auto': 'the array is read-auto (no write has been issued yet)',
  'suspended': 'the array is suspended',
  'broken': 'the array is broken',
}

/** Default seconds a bounded md check may take. */
export const SELFHEAL_CHECK_TIMEOUT_SECONDS = 180

/** Default stripes swept either side of the target during a stripe-cache evict. */
export const SELFHEAL_EVICT_SPAN = 200

/**
 * How long the final cold read waits for the pool's top-level mount (S2).
 *
 * Long enough that an ordinary snapshot list or delete passing through clears
 * out of the way; far short of a backup run, which holds that mount for the
 * whole of one `pbc` invocation. Past it the repair says the confirmation was
 * skipped rather than sitting on a live array with `rmw_level` turned down.
 */
export const SELFHEAL_COLD_READ_WAIT_MS = 60000

/**
 * The floor md accepts for `stripe_cache_size` — below it the write is
 * rejected with EINVAL (probed live). Shrinking to it is what discards the
 * cache; see {@link evictStripeCache}.
 */
const STRIPE_CACHE_FLOOR = '17'

/** Milliseconds `mismatch_cnt` needs to finalize after `sync_action` goes idle. */
const MISMATCH_SETTLE_MS = 1000

/** Trailing slashes of a mountpoint argument. */
const TRAILING_SLASH_RE = /\/+$/
/** Run of whitespace — `sync_completed` prints `<done> / <total>`. */
const WHITESPACE_RE = /\s+/
/** A bare non-negative integer. */
const INTEGER_RE = /^\d+$/

// ---------------------------------------------------------------------------
//  md bounded check
// ---------------------------------------------------------------------------

/** Per-member sectors one stripe occupies. RAID1 has no stripe: a 64 KiB window. */
function windowSectors(geo: MdGeometry): number {
  return geo.raid1 ? 128 : geo.chunkBytes / 512
}

/**
 * Evict md's stripe cache around a stripe so a bounded check reads the MEMBERS.
 *
 * Neither half is sufficient alone (probed live for selfheal.2): a sequential
 * sweep at the default cache size never evicts the target, because released
 * stripes are reused LIFO and only a few slots cycle; and shrinking
 * `stripe_cache_size` discards cached stripes but KEEPS the most recent
 * seventeen — a stripe just written through md survives it. Shrink, then sweep
 * while the cache is small, then restore. Without this a check over a
 * recently-touched stripe compares pre-corruption content and reports
 * `mismatch_cnt = 0` while the member block is junk.
 *
 * GT-23 (kernel 7.0.14-17, two identical runs) measured its REACH: a stripe
 * whose last through-md touch is in the past is still evicted by this recipe
 * and its check counts the rot; a stripe written moments earlier survives the
 * whole thing, and so does `drop_caches` before it, `drop_caches` alone, and
 * leaving `stripe_cache_size` at a value it did not start at. Only a
 * whole-array check recycles it, which is hours per band. So this stays — it
 * is what makes md's number worth having — and the verdict that used to rest
 * on that number alone rests on {@link directParityConsistent} instead.
 */
async function evictStripeCache(
  executor: CommandExecutor,
  geo: MdGeometry,
  stripe: number,
  span: number,
): Promise<void> {
  const original = await readMdAttrOrNull(geo.sys, 'stripe_cache_size')
  if (original === null)
    return // RAID1 has no stripe cache
  await writeMdAttr(geo.sys, 'stripe_cache_size', STRIPE_CACHE_FLOOR)
  try {
    const dataDisks = geo.raidDisks - (geo.raid6 ? 2 : 1)
    const dataSectors = await memberDataSectors(geo)
    const lastStripe = dataSectors === null ? stripe + span + 1 : Math.floor(dataSectors / windowSectors(geo))
    for (let s = Math.max(0, stripe - span); s < Math.min(stripe + span + 1, lastStripe); s++) {
      if (s === stripe)
        continue
      await readDiscard(executor, geo.device, s * dataDisks * geo.chunkBytes, geo.chunkBytes)
    }
  }
  finally {
    await writeMdAttr(geo.sys, 'stripe_cache_size', original)
  }
}

/**
 * How many 512-byte sectors of DATA each member of the array holds.
 *
 * `rd<n>/size` is in KIBIBYTES, and it is already the usable component size —
 * net of the data offset (the raid5 rig's `203776` is the 200 MiB member minus
 * its 1 MiB offset, and md's own `sync_completed` counts out of exactly
 * 407,552 sectors). Reading it as sectors AND subtracting the offset again put
 * the last stripe at half the array, so the sweep never reached a stripe in the
 * upper half and a stale cache was read back as `mismatch_cnt=0` — an
 * `above-md` verdict on rot that was below md all along.
 *
 * Read from the first SURVIVING role: the kernel removes a faulty member's
 * `rd<n>` from sysfs immediately, so `rd0` is not guaranteed to exist on an
 * array that is otherwise fine. Null when no role reports a size — the caller
 * then bounds the sweep by the span alone rather than inventing a number.
 */
export async function memberDataSectors(geo: MdGeometry): Promise<number | null> {
  for (let role = 0; role < geo.raidDisks; role++) {
    const kib = await readMdAttrOrNull(geo.sys, `rd${role}/size`)
    if (kib === null)
      continue
    const sectors = Number(kib) * 2
    if (Number.isFinite(sectors) && sectors > 0)
      return sectors
  }
  return null
}

/**
 * md is running an operation this run did not start, on an array this run was
 * about to touch (design review 2026-09-14, D2).
 *
 * Raised instead of writing anything. `repairBlock` turns it into
 * `unrepairable` — "array state changed mid-repair" — because that is exactly
 * what happened: a member failed, md started recovering onto a spare, and the
 * only correct thing a repair can do is get out of the way. Narrowing
 * `sync_max` under that rebuild, or ending it with `idle`, would abort it.
 */
export class ForeignSyncOpError extends Error {
  constructor(readonly device: string, readonly action: string | null) {
    super(foreignOpNote(device, action))
    this.name = 'ForeignSyncOpError'
  }
}

/** `sync_action` right now — null when the attribute cannot be read at all. */
function readSyncAction(geo: MdGeometry): Promise<string | null> {
  return readMdAttrOrNull(geo.sys, 'sync_action')
}

/**
 * Run an md `check` bounded to one stripe and return its `mismatch_cnt`.
 *
 * GT-5/GT-13: a check that reaches `sync_max` before the device end SUSPENDS
 * with `sync_action` still reading `check` — writing `idle` mid-operation is
 * refused (EBUSY), but once `sync_completed >= sync_max` it is accepted and
 * ends the op scoped to the window. And `mismatch_cnt` finalizes slightly
 * AFTER the op ends, so reading it immediately returns the previous check's
 * count — hence the settle.
 *
 * Every write here is gated on ownership (D2). `sync_min`/`sync_max` are
 * narrowed only onto an IDLE array — re-read at this instant, not at the gates
 * — and the poll loop's `idle` goes in only while `sync_action` still reads
 * the `check` this call issued. The moment md is doing something of its own the
 * call throws {@link ForeignSyncOpError} with nothing written.
 */
export async function boundedWindowCheck(
  executor: CommandExecutor,
  geo: MdGeometry,
  stripe: number,
  options?: SelfhealRepairOptions,
): Promise<number> {
  // The gates ran at step 1 and a member can fail at any point after it. Read
  // it again HERE, immediately before the first knob moves.
  const before = await ownsSyncOp(geo.kernel, () => readSyncAction(geo))
  if (before.foreign)
    throw new ForeignSyncOpError(geo.device, before.action)

  await evictStripeCache(executor, geo, stripe, options?.evictSpan ?? SELFHEAL_EVICT_SPAN)
  const per = windowSectors(geo)
  const low = stripe * per
  const high = (stripe + 1) * per
  await writeMdAttr(geo.sys, 'sync_min', String(low))
  await writeMdAttr(geo.sys, 'sync_max', String(high))
  // cr3 AHR-HEAL-H4: what this run narrowed the window to, so a cleanup under
  // a foreign recovery can tell its own one-stripe window from anyone else's.
  markWindowNarrowed(geo.kernel, String(high))
  await writeMdAttr(geo.sys, 'sync_action', 'check')
  // From here on `idle` may be written to this array — and only from here on.
  markCheckIssued(geo.kernel)

  const cap = options?.checkTimeoutSeconds ?? SELFHEAL_CHECK_TIMEOUT_SECONDS
  let ended = false
  for (let i = 0; i < cap * 2 && !ended; i++) {
    const own = await ownsSyncOp(geo.kernel, () => readSyncAction(geo))
    if (isIdleSyncAction(own.action)) {
      retireCheckIssued(geo.kernel)
      ended = true
      break
    }
    if (own.foreign) {
      // md dropped our check and took something of its own on — a member
      // failed, and this array is now rebuilding. Leave every knob alone.
      retireCheckIssued(geo.kernel)
      throw new ForeignSyncOpError(geo.device, own.action)
    }
    const completed = (await readMdAttr(geo.sys, 'sync_completed')).split(WHITESPACE_RE)[0]
    if (INTEGER_RE.test(completed) && Number(completed) >= high) {
      try {
        await writeMdAttr(geo.sys, 'sync_action', 'idle')
        retireCheckIssued(geo.kernel)
        ended = true
        break
      }
      catch {
        // EBUSY: the op has not reached the boundary yet after all — poll on.
      }
    }
    await sleep(500)
  }
  if (!ended) {
    // The check this call issued is STILL RUNNING and this call is walking
    // away from it. Two things have to happen in this order (sixth pass, N3):
    // `restoreSyncKnobs` first, while the token is still held, so the op that
    // is ended and the window that is widened are provably ours; then the
    // token goes, because nothing after this point may treat a `check` on this
    // array as this run's. Leaving it behind is how a later FOREIGN check —
    // mdcheck's — got written `idle`.
    let left: string | null = null
    try {
      left = await restoreSyncKnobs(geo)
    }
    catch (error) {
      left = `sync knobs not restored: ${errorText(error)}`
    }
    retireCheckIssued(geo.kernel)
    throw new CheckTimeoutError(`bounded md check over stripe ${stripe} did not settle within ${cap}s${left ? ` (${left})` : ''}`, geo.device)
  }

  await sleep(options?.settleMs ?? MISMATCH_SETTLE_MS)
  const mismatch = Number(await readMdAttr(geo.sys, 'mismatch_cnt'))
  await restoreSyncKnobs(geo)
  return mismatch
}

/**
 * Put `sync_min` / `sync_max` back the way md ships them — unless md has taken
 * an operation of its own on the array in the meantime.
 *
 * A suspended bounded op has to be widened and ended first: the knob PERSISTS,
 * and a later full check would stop at the old boundary again and silently
 * cover a sliver of the array (GT-13, the trap). But that widen-then-`idle`
 * pair is precisely what must NOT reach a recovery: the old code wrote both
 * whenever `sync_action` was anything but idle, which on a member failure
 * aborted the rebuild (D2).
 *
 * So: our own check is widened and ended as before; an idle array is simply
 * restored; under a FOREIGN operation `sync_min` and `sync_action` are never
 * written, and `sync_max` is written in exactly one case — a recovery or a
 * resync over the one-stripe window THIS run narrowed, widened to `max` (cr3
 * AHR-HEAL-H4, see {@link widenUnderForeignOp}); everything else is left as
 * md has it and the returned sentence says which operation it was. The
 * daemon-start reconciliation (`selfheal-reconcile.ts`) puts the rest of the
 * window back once md is finished.
 *
 * ## The trailing pair, and the token (sixth pass, N11)
 *
 * The widen-then-`idle` above can BOUNCE (EBUSY: the op has not reached the
 * boundary yet), and the old code swallowed that, retired the token anyway and
 * then wrote `sync_min`/`sync_max` unconditionally. Both halves were wrong:
 * widening `sync_max` under a check that is still running resumes it over the
 * whole band, and `sync_min` is itself EBUSY during a recovery — a raw throw
 * out of a `finally`-driven cleanup. So the bounce KEEPS the token (the check
 * is still ours) and skips the pair, and the pair itself re-reads ownership
 * one more time and records what it could not write instead of throwing.
 *
 * The return value is the caller's cleanup note — `null` when there is
 * nothing to say, otherwise one or more sentences joined with `; `, which
 * `repairBlock` pushes into `cleanupErrors`.
 */
export async function restoreSyncKnobs(geo: MdGeometry): Promise<string | null> {
  const notes: string[] = []
  const own = await ownsSyncOp(geo.kernel, () => readSyncAction(geo))
  if (own.foreign) {
    // md is running something of its own: our check is gone whatever it was,
    // so the token goes too — keeping it is what let a later foreign check
    // read as ours (N3).
    retireCheckIssued(geo.kernel)
    return widenUnderForeignOp(geo, own.action)
  }
  if (own.owned) {
    try {
      await writeMdAttr(geo.sys, 'sync_max', MD_DEFAULT_SYNC_MAX)
      forgetWindowNarrowed(geo.kernel)
      await writeMdAttr(geo.sys, 'sync_action', 'idle')
    }
    catch (error) {
      // EBUSY: the op has NOT reached the boundary, so it is still running and
      // still ours. Keep the token and write nothing more — the window stays
      // narrow until the daemon-start reconcile or the scrub's own pre-issue
      // restore puts it back, which is the safe direction to fail.
      return `${geo.device}: the bounded check could not be widened and ended (${errorText(error)}) — sync_min/sync_max left as they are, and the check is still this run's`
    }
    retireCheckIssued(geo.kernel)
  }
  else {
    // Idle: whatever we issued has ended. The token has no business outliving it.
    retireCheckIssued(geo.kernel)
  }
  // The pair that actually clears GT-13's trap — under the SAME ownership rule
  // as everything above, because the array can have changed hands in the
  // milliseconds since the read at the top of this function.
  const after = await ownsSyncOp(geo.kernel, () => readSyncAction(geo))
  if (!isIdleSyncAction(after.action)) {
    notes.push(await widenUnderForeignOp(geo, after.action))
    return notes.join('; ')
  }
  for (const [attr, value] of [['sync_min', MD_DEFAULT_SYNC_MIN], ['sync_max', MD_DEFAULT_SYNC_MAX]] as const) {
    try {
      await writeMdAttr(geo.sys, attr, value)
      if (attr === 'sync_max')
        forgetWindowNarrowed(geo.kernel)
    }
    catch (error) {
      notes.push(`${geo.device}: ${attr} not restored to ${value}: ${errorText(error)}`)
    }
  }
  return notes.length > 0 ? notes.join('; ') : null
}

/**
 * md is running an operation of its own over a window THIS run narrowed (cr3
 * AHR-HEAL-H4). The premise — md parks a recovery or a resync at `sync_max`,
 * so a rebuild onto a spare left at this run's one-stripe value never gets
 * past it — is UNCAPTURED (from md's `md_do_sync` as recalled, not seen on a
 * node). GT-19(d), verbatim: "`echo max > sync_max` during `recover`:
 * accepted (rc=0; the value was already `max`, no observable effect)". It
 * shows md ACCEPTS the write during a recovery; it did NOT show a parked
 * recovery released by it. The write is built on the review's ruling, and
 * the node probe (the cr3 report) settles both halves.
 *
 * So, and ONLY so: `sync_max` must still read exactly the value this run
 * wrote, and — re-read AFTER that, immediately before the write —
 * `sync_action` must read `recover` or `resync` ({@link mayWidenSyncMaxUnder})
 * and `reshape_position` must read `none` (unreadable is not `none`). Then
 * `sync_max` is widened to `max`. `sync_min` is never written (EBUSY
 * mid-recovery, GT-19(d)) and `idle` is never written; the daemon-start
 * reconcile or the scrub puts `sync_min` back once md is idle.
 *
 * The narrowed-window record is KEPT on every early return but one (frozen,
 * reshape, a check or repair, an unreadable state): it is only ever consulted
 * together with an exact re-read of `sync_max`, so keeping it cannot license
 * a write over a window that is no longer this run's — and forgetting it would
 * throw away the only proof the window IS this run's. The one exception is
 * `sync_max` reading something else: the window is provably no longer ours,
 * and the record goes. Returns the cleanup note.
 */
async function widenUnderForeignOp(geo: MdGeometry, action: string | null): Promise<string> {
  const left = `${geo.device}: sync_min/sync_max left as they are — ${foreignOpNote(geo.device, action)}`
  const ours = narrowedSyncMax(geo.kernel)
  if (!mayWidenSyncMaxUnder(action) || ours === null)
    return left
  const now = await readMdAttrOrNull(geo.sys, 'sync_max')
  if (now !== ours) {
    // Not this run's window any more: nobody's but md's to change.
    forgetWindowNarrowed(geo.kernel)
    return left
  }
  // The state, re-read AFTER `sync_max` and immediately before the write.
  const actionNow = await readSyncAction(geo)
  const reshape = await readMdAttrOrNull(geo.sys, 'reshape_position')
  if (!mayWidenSyncMaxUnder(actionNow) || reshape !== 'none')
    return `${left}; sync_max not widened: sync_action now reads ${actionNow ?? 'unreadable'} and reshape_position ${reshape ?? 'unreadable'}`
  try {
    await writeMdAttr(geo.sys, 'sync_max', MD_DEFAULT_SYNC_MAX)
  }
  catch (error) {
    return `${left}; sync_max could not be widened from this run's ${ours}: ${errorText(error)}`
  }
  forgetWindowNarrowed(geo.kernel)
  return `${geo.device}: md is running ${actionNow}; sync_max widened to max from this run's one-stripe ${ours} so the ${actionNow} is not held there. sync_min was left as it is (md refuses it mid-${actionNow}); it is put back once md is idle`
}

// ---------------------------------------------------------------------------
//  GF(2^8) — the RAID6 Q syndrome
// ---------------------------------------------------------------------------

/**
 * GF(2^8) exponent / log tables for md's RAID6 field: generator 2, primitive
 * polynomial x⁸+x⁴+x³+x²+1 (0x11D), the same one `lib/raid6` uses.
 *
 * Q for a stripe is `Σ gᵈ · Dᵈ` over the data disks in md's STRIPE ORDER — d
 * counting from the first data disk after Q, which is precisely the
 * `dataIndex` the mapping helper carries. Verified live against a RAID6 loop
 * rig (7 members, chunk 64 K, left-symmetric): the computed P and Q matched the
 * P and Q members byte-for-byte on three different stripes, and the Q-only
 * reconstruction of a data member reproduced it exactly.
 */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if ((x & 0x100) !== 0)
      x ^= 0x11D
  }
  for (let i = 255; i < 512; i++)
    GF_EXP[i] = GF_EXP[i - 255]
}

/** Multiply in GF(2^8). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0)
    return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** `2^n` in GF(2^8) — the Q coefficient of the n-th data disk of a stripe. */
export function gfPow2(n: number): number {
  return GF_EXP[n % 255]
}

/** Multiplicative inverse in GF(2^8). */
export function gfInv(a: number): number {
  if (a === 0)
    throw new Error('GF(2^8): 0 has no inverse')
  return GF_EXP[(255 - GF_LOG[a]) % 255]
}

/** XOR `b` into `a`, in place. */
function xorInto(a: Buffer, b: Buffer): void {
  for (let i = 0; i < a.length; i++)
    a[i] ^= b[i]
}

/**
 * Reconstruct one data block from the Q syndrome and the surviving data blocks.
 *
 * `blocks` is keyed by data index (position in md's stripe order); the entry at
 * `missing` is ignored. P is not consulted at all, which is the point: this is
 * the path for a stripe whose P member is ALSO bad.
 */
export function reconstructFromQ(blocks: (Buffer | null)[], q: Buffer, missing: number): Buffer {
  const partial = Buffer.alloc(q.length)
  for (let d = 0; d < blocks.length; d++) {
    const block = blocks[d]
    if (d === missing || !block)
      continue
    const coefficient = gfPow2(d)
    for (let i = 0; i < partial.length; i++)
      partial[i] ^= gfMul(coefficient, block[i])
  }
  const inverse = gfInv(gfPow2(missing))
  const out = Buffer.alloc(q.length)
  for (let i = 0; i < out.length; i++)
    out[i] = gfMul(inverse, partial[i] ^ q[i])
  return out
}

// ---------------------------------------------------------------------------
//  The direct parity computation (GT-23)
// ---------------------------------------------------------------------------

/** What a DIRECT read of every member's row says about one parity group. */
export interface DirectParityCheck {
  /**
   * The members themselves agree: the XOR of the data rows IS the P row (and
   * the Q syndrome IS the Q row on RAID6); on RAID1, every leg holds the same
   * bytes. Nothing about md's cache takes part in the answer.
   */
  consistent: boolean
  /** What was compared and what came back — the step's audit line. */
  detail: string
}

/**
 * Is the parity group under this block consistent, read STRAIGHT OFF THE
 * MEMBERS? (GT-23)
 *
 * The engine's `above-md` verdict used to rest on one number: a bounded md
 * `check` over the stripe reading `mismatch_cnt = 0` while the block fails its
 * stored csum, which says parity already agrees with the bad data. GT-14
 * established that md serves a recently-touched stripe out of its stripe cache,
 * and `evictStripeCache` was what made that check read the disks. GT-23 (kernel
 * 7.0.14-17, two identical runs) found that the eviction no longer reaches a
 * stripe written moments before: rot on the member, the engine's own eviction,
 * the bounded check reads 0 — while a direct read of the members says the XOR
 * is not the parity row at all. A real below-md rot in a recently written
 * stripe would be reported `above-md`: nothing written, false assurance, and
 * the rot left in place and misdescribed. No cheap knob changed it —
 * `drop_caches` before the eviction, `drop_caches` alone, and leaving
 * `stripe_cache_size` at a different value all read 0 too; only a whole-array
 * check recycled the cache, and that is hours per band.
 *
 * So the question is asked of the disks. The engine already reads every
 * member's row directly to reconstruct the block; this computes the same
 * arithmetic md's check would, one row wide, with no cache between it and the
 * platters. Reads go through {@link readDirect} (O_DIRECT off the MEMBER
 * devices, never through md) at each member's OWN data offset — `--grow
 * --data-offset` is allowed to leave them differing.
 *
 * It answers about ONE 4 KiB row; md's bounded check answers about a whole
 * chunk window. Both readings are kept, and {@link parityAgreement} says what
 * the pair means.
 */
export async function directParityConsistent(
  executor: CommandExecutor,
  geo: MdGeometry,
  location: MemberLocation,
): Promise<DirectParityCheck> {
  const row = (role: number): Promise<Buffer> =>
    readDirect(executor, geo.members[role] as string, memberOffsetOn(geo, location, role), BLOCK_BYTES)

  if (geo.raid1) {
    const legs = location.mirrors.filter(leg => geo.members[leg] !== null)
    if (legs.length < 2) {
      // Not reachable through `repairBlock` — the gates refuse an array with a
      // missing member — but a one-legged mirror has nothing to compare, and
      // saying so is the only honest answer.
      return {
        consistent: true,
        detail: `${geo.device} has one readable leg for this block, so a direct read has nothing to compare it with`,
      }
    }
    const first = await row(legs[0])
    for (const leg of legs.slice(1)) {
      if (!first.equals(await row(leg))) {
        return {
          consistent: false,
          detail: `a direct read of the mirror legs at their own offsets: ${geo.members[legs[0]]} and ${geo.members[leg]} DIFFER over this block`,
        }
      }
    }
    return {
      consistent: true,
      detail: `a direct read of all ${legs.length} mirror legs at their own offsets: every leg holds the same bytes`,
    }
  }

  const stripe = location.stripe as number
  const parityRole = location.parityIndex as number
  const order = stripeDataOrder(geo, stripe)
  const rows: Buffer[] = []
  for (let role = 0; role < geo.raidDisks; role++)
    rows.push(await row(role))

  const computedP = Buffer.alloc(BLOCK_BYTES)
  for (const role of order)
    xorInto(computedP, rows[role])
  const pOk = computedP.equals(rows[parityRole])
  const where = `a direct read of all ${geo.raidDisks} member rows of stripe ${stripe}`

  if (!geo.raid6) {
    return {
      consistent: pOk,
      detail: pOk
        ? `${where}: the XOR of the ${order.length} data rows IS the P row on ${geo.members[parityRole]}`
        : `${where}: the XOR of the ${order.length} data rows is NOT the P row on ${geo.members[parityRole]}`,
    }
  }

  const qRole = location.qIndex as number
  const computedQ = Buffer.alloc(BLOCK_BYTES)
  for (let d = 0; d < order.length; d++) {
    const coefficient = gfPow2(d)
    const block = rows[order[d]]
    for (let i = 0; i < BLOCK_BYTES; i++)
      computedQ[i] ^= gfMul(coefficient, block[i])
  }
  const qOk = computedQ.equals(rows[qRole])
  return {
    consistent: pOk && qOk,
    detail: `${where}: P on ${geo.members[parityRole]} ${pOk ? 'IS' : 'is NOT'} the XOR of the data rows, `
      + `Q on ${geo.members[qRole]} ${qOk ? 'IS' : 'is NOT'} their syndrome`,
  }
}

/**
 * What the two readings of one parity group say TOGETHER (GT-23).
 *
 *  - `consistent`   both say the group agrees with itself. With a block that
 *                   fails its stored csum, that is `above-md`: parity already
 *                   agrees with the bad data.
 *  - `stale-cache`  md counts nothing while the members disagree — md answered
 *                   from a cached copy of the stripe. The rot is below md and
 *                   the repair goes ahead.
 *  - `inconsistent` both say the group disagrees with itself: the ordinary
 *                   below-md rot the engine exists for.
 *  - `disagree`     md counts a mismatch while the members' own row agrees.
 *                   The two readings are not about the same thing — md's
 *                   window is a whole chunk and this row is one page of it —
 *                   so BEFORE a write it is not a fault this engine can act on
 *                   (and never `above-md`), and after one it is the parity
 *                   residual F2 describes.
 *
 * `mdMismatch` is null when the bounded check could not be taken at all; the
 * direct reading then decides on its own.
 */
export type SelfhealParityAgreement = 'consistent' | 'stale-cache' | 'inconsistent' | 'disagree'

/** @see SelfhealParityAgreement */
export function parityAgreement(directConsistent: boolean, mdMismatch: number | null): SelfhealParityAgreement {
  if (directConsistent)
    return mdMismatch === null || mdMismatch === 0 ? 'consistent' : 'disagree'
  return mdMismatch === 0 ? 'stale-cache' : 'inconsistent'
}

// ---------------------------------------------------------------------------
//  The sequence
// ---------------------------------------------------------------------------

interface Candidate {
  bytes: Buffer
  how: SelfhealReconstruction
  detail: string
}

/** One band whose md knobs a run moved, and what they were before it did. */
interface TouchedBand {
  geo: MdGeometry
  /** `rmw_level` as it was, or null when this array has none (RAID1). */
  savedRmwLevel: string | null
  /** `stripe_cache_size` as it was, or null when this array has none (RAID1). */
  savedStripeCache: string | null
  /** True once a bounded check moved `sync_min`/`sync_max` on this array. */
  syncKnobs: boolean
}

/**
 * Repair one 4 KiB block. Never throws for a verdict — the four buckets are
 * all returned as an outcome; it throws only for an internal failure (and for
 * whatever `beforeStep` throws), with the partial steps attached.
 */
export async function repairBlock(
  executor: CommandExecutor,
  request: SelfhealRepairRequest,
  options?: SelfhealRepairOptions,
): Promise<SelfhealOutcome> {
  const steps: SelfhealStep[] = []
  const diagnostics: SelfhealDiagnostics = { cleanupErrors: [] }

  const file = isAbsolute(request.file) ? request.file : join(request.mountpoint, request.file)
  const mountpoint = request.mountpoint.replace(TRAILING_SLASH_RE, '')
  if (relative(resolvePath(mountpoint), resolvePath(file)).startsWith('..'))
    throw new SelfhealRunError(`${file} is not under ${mountpoint}`, steps, diagnostics)

  let pin: Pin | null = null
  /**
   * The band the OUTCOME names: the array the write went to (or would have).
   *
   * Set from the resolved block's first sector, then narrowed to the TARGET
   * sector's band once the re-verify says which sector is the corrupt one. A
   * compressed blob straddling a band boundary has its sectors on two arrays,
   * and the outcome has to name the one that was worked on (F5).
   */
  let outcomeBand: MdGeometry | null = null
  /**
   * Every band whose md knobs this run moved, keyed by its md device.
   *
   * `rmw_level` was written on the TARGET's band while the restore read the
   * FIRST sector's — so a blob crossing a boundary left band 2 at
   * `rmw_level=0` forever and "restored" band 1 to the value it already had
   * (F5). Saved and restored per band, so whatever was touched is what is put
   * back, and nothing else is written to at all.
   */
  const touched = new Map<string, TouchedBand>()
  /**
   * The repaired-block sentence, set the moment `writeDirect` returns (F5).
   *
   * Null until then, which is what makes "nothing written" a checkable claim
   * rather than a hopeful one.
   */
  let written: string | null = null

  /** Register a band as touched, snapshotting the knobs before they move. */
  async function touchBand(geo: MdGeometry): Promise<TouchedBand> {
    const existing = touched.get(geo.device)
    if (existing)
      return existing
    const entry: TouchedBand = {
      geo,
      savedRmwLevel: null,
      savedStripeCache: await readMdAttrOrNull(geo.sys, 'stripe_cache_size'),
      syncKnobs: false,
    }
    touched.set(geo.device, entry)
    return entry
  }

  /** The step currently running — what `note` annotates and `fail` marks failed. */
  let current: SelfhealStep | null = null

  async function step(name: SelfhealStepName): Promise<void> {
    try {
      await options?.beforeStep?.(name)
    }
    catch (error) {
      // The hook is how a caller ABORTS the sequence (the suite's injected
      // failures). It stays an abort — a SelfhealRunError — on either side of
      // the write, and it carries `written` so the caller can still tell a run
      // that wrote from one that did not (cr3 AHR-HEAL-H1).
      throw new SelfhealRunError(errorText(error), steps, diagnostics, { cause: error, written })
    }
    current = { name, ok: true }
    steps.push(current)
  }

  /** Record what the current step observed. */
  function note(detail: string): void {
    if (current)
      current.detail = detail
  }

  function fail(kind: SelfhealOutcomeKind, reason: string, code?: SelfhealReasonCode): never {
    if (current) {
      current.ok = false
      current.detail = reason
    }
    throw new Verdict(kind, reason, code)
  }

  try {
    // ---- gates ----------------------------------------------------------
    // Every band is gated, not just the one the block turns out to be on: which
    // band that is is only known after the pin (the pool could be rewritten
    // between the two), and a pool with any band degraded or busy is one the
    // route already refuses as a whole.
    await step('gates')
    // F11 — identity, before anything is pinned or read. `reverify` catches a
    // re-created path by accident (the new bytes pass their own checksum, so
    // the run aborts "not corrupt here"); that is a coincidence, not a check,
    // and it says the wrong thing about a file nobody examined.
    if (request.inode !== undefined) {
      let live: number | null
      try {
        live = (await stat(file)).ino
      }
      catch (error) {
        fail('not-examined', `${file} could not be stat'ed to confirm it is the file the scrub named (inode ${request.inode}): ${errorText(error)}. Nothing was written.`, 'inode-changed')
      }
      if (live !== request.inode) {
        fail('not-examined', `the file at ${file} is inode ${live}; the scrub named inode ${request.inode}. Nothing was written.`, 'inode-changed')
      }
    }
    // cr3: a pool whose layout could not be read is not guessed at — the pin
    // shape depends on it. `run-stopped`: nothing was looked at, and the
    // repair runs once the mount table answers.
    if (request.pool && poolLayout(request.pool) === 'unknown')
      fail('not-examined', `${asSentenceStart(unknownLayoutSentence(request.pool))}. Nothing was pinned, examined or written. Run Repair from parity again once \`findmnt ${request.pool.mountpoint}\` lists the pool.`, SELFHEAL_RUN_STOPPED)
    const context = await resolveContext(executor, mountpoint)
    const refusal = await gateRefusal(executor, context, request.pool ?? null, options)
    // cr3 AHR-HEAL-H1 — a gate refusal is a block NOBODY LOOKED AT. It used to
    // be `unrepairable`, the bucket whose advice is "restore this file from
    // backup": advice to overwrite a file on the strength of an array that was
    // busy at the time.
    if (refusal)
      fail('not-examined', `${asSentenceStart(refusal.reason)}. Nothing was examined or written. ${refusal.advice}`, SELFHEAL_RUN_STOPPED)

    // ---- pin ------------------------------------------------------------
    await step('pin')
    try {
      pin = await takePin(executor, mountpoint, file, request.pool ?? null, diagnostics, options)
    }
    catch (error) {
      // Review R1: what failed is said; nothing visible names when a rerun
      // would differ, so it goes back with the job (never "final").
      throw new SelfhealRunError(`cannot pin ${mountpoint}: ${errorText(error)}`, steps, diagnostics, { cause: error, advice: 'Report it with this job\'s result.' })
    }
    note(pin.describe)

    // ---- resolve (AFTER the pin, so the mapping describes the pinned state)
    await step('resolve')
    const pinned = await resolveContext(executor, mountpoint)
    const resolved = await resolveBlock(executor, pinned, file, request.block)
    // The band the repair unit STARTS on — its own array, its own geometry,
    // its own sysfs. It is what the outcome names until the re-verify says
    // which sector is corrupt; a compressed blob can straddle a boundary and
    // the sector that gets worked on may be on the next band along (F5).
    const band = resolved.sectors[0].geometry
    outcomeBand = band
    diagnostics.mapping = mappingOf(resolved)
    note(`${band.device} m${resolved.sectors[0].memberIndex}@${resolved.sectors[0].memberOffset} `
      + `md@${resolved.sectors[0].mdByte} stripe ${resolved.sectors[0].stripe ?? 'n/a'}`)

    // ---- reverify -------------------------------------------------------
    await step('reverify')
    const verdict = await reverify(executor, pinned, resolved)
    diagnostics.badSectors = verdict.badSectors
    if (verdict.abort && !verdict.abort.mirrorAllLegsFail)
      fail(verdict.abort.kind, verdict.abort.reason, verdict.abort.code)

    // ---- guard (cr3 AHR-HEAL-L7: straight after the re-verify) ------------
    // F9 — the guard fires exactly when NOTHING about this file has been
    // established: the md offset and the member offset do not describe the
    // same bytes, so the sector the re-verify read may not even belong to this
    // file. It used to run AFTER the pre-check and the arbitration, so a
    // mapping error (a wrong data offset, say) reached `above-md` or "more than
    // one block of this stripe is damaged. Restore from backup" first — a
    // verdict about bytes nobody had shown to be this file's. Asked here, it
    // answers before any knob moves and before any verdict is possible.
    const guardTarget = resolved.sectors[verdict.badSectors[0]]
    outcomeBand = guardTarget.geometry
    diagnostics.mapping = mappingOf(resolved, verdict.badSectors[0])
    await step('guard')
    const guard = await readBackGuard(executor, guardTarget.geometry, guardTarget, verdict.corruptBytes)
    note(guard.detail)
    if (!guard.ok)
      fail('not-examined', guard.detail, 'unresolvable')

    if (verdict.abort?.mirrorAllLegsFail) {
      // F4 — parallel construction with the parity band. Every leg holding the
      // SAME bad bytes is what through-md rot looks like on a mirror, and md's
      // own bounded check is the thing that can tell it from two legs that rot
      // independently: a mirror check compares the legs with each other, so
      // `mismatch_cnt == 0` means they AGREE. Agreeing-and-wrong is `above-md`
      // — the diagnosis a parity band gets from the identical evidence, and the
      // one a node with failing memory needs to see. The advice happens to be
      // the same; the diagnosis is not, and only one of the two is recorded in
      // `aboveMd` or said in the notification.
      const mirrorTarget = resolved.sectors[verdict.badSectors[0]]
      const mirrorGeo = mirrorTarget.geometry
      outcomeBand = mirrorGeo
      diagnostics.mapping = mappingOf(resolved, verdict.badSectors[0])
      await step('precheck')
      const mirrorStripe = Math.floor(mirrorTarget.mdByte / (windowSectors(mirrorGeo) * 512))
      ;(await touchBand(mirrorGeo)).syncKnobs = true
      const legs = await boundedWindowCheck(executor, mirrorGeo, mirrorStripe, options)
      diagnostics.precheckMismatch = legs
      // GT-23 — md's number alone cannot carry this verdict either. A mirror
      // check compares the legs THROUGH md, so a cached copy of the block
      // answers "the legs agree" over legs that differ on the platters. The
      // legs are read directly and the pair decides.
      const mirrorDirect = await directParityConsistent(executor, mirrorGeo, mirrorTarget)
      const mirrorAgreement = parityAgreement(mirrorDirect.consistent, legs)
      note(`mismatch_cnt=${legs}; ${mirrorDirect.detail}`)
      if (mirrorAgreement === 'consistent') {
        // cr3.sentences: the operator's sentence, which REPLACES the re-verify's
        // "every mirror leg fails the stored csum" (its first sentence says it).
        fail('above-md', aboveMdSentence(file, request.block, 'mirror', mirrorGeo.device, mirrorDirect.detail))
      }
      if (mirrorAgreement === 'disagree') {
        // cr3 review item 1 (E04f4) — the block WAS examined: it fails its
        // checksum and every leg holds the same failing bytes. md counting a
        // mismatch elsewhere in its window changes nothing about this row,
        // and no rerun will: its own `unrepairable` code and sentence.
        fail('unrepairable', arrayRebuildsRotSentence(file, request.block, 'mirror', mirrorDirect.detail, legs), SELFHEAL_ARRAY_REBUILDS_ROT)
      }
      if (mirrorAgreement === 'stale-cache') {
        diagnostics.staleCache = true
        fail('unrepairable', `${verdict.abort.reason} md's bounded check over ${mirrorGeo.device} reports mismatch_cnt=0, but md's cached view of this stripe was stale; the direct member read shows the mismatch — ${mirrorDirect.detail}. The legs disagree with each other and neither matches the stored csum: the fault is below md. Restore ${file} from backup, and check both disks' SMART data in Disks.`)
      }
      fail('unrepairable', `${verdict.abort.reason} md's bounded check over ${mirrorGeo.device} counts ${legs} mismatch(es) and ${mirrorDirect.detail}, so the legs disagree with each other and neither matches the stored csum: the fault is below md. Restore ${file} from backup, and check both disks' SMART data in Disks.`)
    }
    const target = guardTarget
    const geo = target.geometry
    // The band that is actually worked on — which is not necessarily the first
    // sector's when a compressed blob straddles a band boundary (F5).
    outcomeBand = geo
    diagnostics.mapping = mappingOf(resolved, verdict.badSectors[0])
    const corruptBytes = verdict.corruptBytes
    const storedCsum = verdict.storedCsum
    diagnostics.storedCsum = csumHex(storedCsum)
    if (verdict.badMirror !== null && diagnostics.mapping) {
      diagnostics.mapping.memberIndex = verdict.badMirror
      diagnostics.mapping.memberDevice = geo.members[verdict.badMirror] as string
      diagnostics.mapping.memberOffset = memberOffsetOn(geo, target, verdict.badMirror)
    }

    // ---- precheck -------------------------------------------------------
    await step('precheck')
    const stripe = target.stripe ?? Math.floor(target.mdByte / (windowSectors(geo) * 512))
    // From here down the TARGET's band is written to: register it (and snapshot
    // its stripe cache) before the first knob moves.
    ;(await touchBand(geo)).syncKnobs = true
    const before = await boundedWindowCheck(executor, geo, stripe, options)
    diagnostics.precheckMismatch = before
    // GT-23 — the `above-md` verdict is CACHE-INDEPENDENT. md's bounded check
    // over a stripe written moments ago reads md's own cached copy of it on
    // kernel 7.0.14-17 and reports 0 over rot that is sitting on the member, so
    // the parity group is computed from DIRECT member reads and md's number is
    // corroboration. Only both readings together say `above-md`.
    const direct = await directParityConsistent(executor, geo, target)
    const agreement = parityAgreement(direct.consistent, before)
    note(`mismatch_cnt=${before}; ${direct.detail}`)
    if (agreement === 'consistent') {
      fail('above-md', aboveMdSentence(file, request.block, 'parity', String(stripe), direct.detail))
    }
    if (agreement === 'disagree') {
      // md counts the chunk window while the members' own row agrees with
      // itself. The two are not the same question and neither answer can be
      // acted on here: a reconstruction from a row whose parity already agrees
      // would just rebuild the bad bytes, and `above-md` is a claim md's own
      // count contradicts.
      // cr3 review item 1 (E05e) — the block WAS examined: it fails its
      // checksum and the parity group agrees with the failing bytes, so a
      // reconstruction gives them back. That is the same answer on every run.
      fail('unrepairable', arrayRebuildsRotSentence(file, request.block, 'parity', direct.detail, before), SELFHEAL_ARRAY_REBUILDS_ROT)
    }
    if (agreement === 'stale-cache') {
      // Exactly GT-23's shape: md answered from its cache, the members say
      // otherwise, and the rot is below md after all. The repair goes ahead.
      diagnostics.staleCache = true
      note(`mismatch_cnt=${before}; md's cached view of this stripe was stale; the direct member read shows the mismatch — ${direct.detail}`)
    }

    // ---- rmw ------------------------------------------------------------
    await step('rmw')
    const rmwBand = await touchBand(geo)
    rmwBand.savedRmwLevel = await readMdAttrOrNull(geo.sys, 'rmw_level')
    if (rmwBand.savedRmwLevel !== null)
      await writeMdAttr(geo.sys, 'rmw_level', '0')

    // ---- reconstruct ----------------------------------------------------
    // D7: the geometry's member list is the `mdadm --detail` snapshot taken at
    // the gates, and a member md has KICKED since then still has a device path
    // in it. Reading that path returns the disk's own stale bytes (or EIO) and
    // the XOR comes out wrong — a false candidate that can still fail
    // arbitration, but on RAID6 could be arbitrated against the WRONG syndrome.
    // Re-read `degraded` and ask sysfs which roles are actually still in.
    await step('reconstruct')
    const absent = await absentRoles(geo)
    // F8 — md's bad-block list is the OTHER way a member stops being a source
    // of truth. A recorded range is a span md returned a URE on during a
    // rebuild and never reconstructed: md serves EIO for it, and XORing what a
    // read of it returns produces a candidate that is wrong in a way
    // arbitration might not catch on RAID6 (the Q solve would be fed the wrong
    // syndrome). Such a member is ABSENT for this row, exactly as a kicked one
    // is — RAID5 then has nothing left, RAID6 still has the other syndrome.
    // cr3 review item 4 — md's bad-block lists are read AGAIN here, not taken
    // from the resolve step: md records a range on a member that hit an error
    // during this very run (the pre-check reads every member) without failing
    // it, and that member must not be XORed in.
    const liveGeo: MdGeometry = { ...geo, badBlocks: await readBadBlockLists(geo) }
    const { roles: badBlocked, unknown: badBlocksUnread } = badBlockRoles(liveGeo, target, absent)
    // cr3 AHR-HEAL-L9 — a member whose bad-block list could not be read is
    // not a member known to be readable over this row. Nothing is decided on
    // it: the band's facts could not be read, which is `band-unreadable`.
    if (badBlocksUnread.length > 0) {
      const names = badBlocksUnread.map(role => geo.members[role] ?? `role ${role}`).join(', ')
      fail('not-examined', `the md bad-block list of ${names} on ${geo.device} could not be read, so nothing says md can read this row of that member. Nothing was written.`, 'band-unreadable')
    }
    const plan = reconstructionPlan(geo, target, [...new Set([...absent, ...badBlocked])], verdict.goodMirrors)
    if (plan.refusal) {
      if (badBlocked.length > 0)
        fail('unrepairable', `${plan.refusal} ${badBlockNote(liveGeo, badBlocked)}`, SELFHEAL_BAD_BLOCKS_PRESENT)
      // cr3 AHR-HEAL-H1 — md kicked a member while this run was working: the
      // array changed under it, and nothing was decided about this block.
      // cr3.heal.paths: no rerun is offered. md rebuilds the kicked member's
      // row from the bytes this block holds now, so after the rebuild the
      // scrub decides (coordinator decision 6).
      fail('not-examined', `${plan.refusal} ${memberLostAdvice(bandShown(geo.device, request.pool), geo.sys, await readSyncAction(geo))}`, SELFHEAL_RUN_STOPPED)
    }
    if (badBlocked.length > 0)
      note(badBlockNote(liveGeo, badBlocked))
    const candidates = await reconstruct(executor, geo, target, plan)
    if (candidates.length === 0)
      fail('unrepairable', `no candidate could be reconstructed for ${file} block ${request.block}. Nothing was written. Restore ${file} from a backup if one exists.`)
    note(candidates.map(c => c.how).join(', '))

    // ---- arbitrate ------------------------------------------------------
    await step('arbitrate')
    let winner: Candidate | null = null
    const tried: string[] = []
    for (const candidate of candidates) {
      const value = crc32c(candidate.bytes)
      tried.push(`${candidate.how}=${csumHex(value)}`)
      if (value === storedCsum) {
        winner = candidate
        diagnostics.candidateCsum = csumHex(value)
        diagnostics.reconstruction = candidate.how
        break
      }
    }
    note(`${tried.join(' ')} stored=${csumHex(storedCsum)}`)
    if (!winner) {
      // cr3 second review 5(a): what ANAS tried and what it did not — never a
      // claim that the array itself cannot rebuild the block.
      fail('unrepairable', `no reconstruction ANAS tries matches the stored csum ${csumHex(storedCsum)} (tried ${tried.join(', ')}). ANAS rebuilds one missing block per stripe (RAID5: the XOR of the other members; RAID6: from P, then from Q alone) and does not solve for two; a second damaged block in this stripe would explain the miss. Nothing was written, and this result is final. Restore ${file} from a backup if one exists.`)
    }

    // ---- write ----------------------------------------------------------
    // The gates are a re-check, not a one-time test (D2). Everything between
    // step 1 and here takes real time — a bounded check over a 20 TB band is
    // minutes — and a member that failed inside that window puts md into
    // `recover`. Writing through md then lands the block in a stripe that is
    // being rebuilt underneath it.
    await step('write')
    const changed = await preWriteRefusalOf(geo)
    // cr3 AHR-HEAL-H1 — the array changed under the run: no verdict, and not
    // the restore bucket.
    if (changed)
      fail('not-examined', `the array changed during the repair: ${changed.reason}. Nothing was written. ${arrayRefusalAdvice(bandShown(geo.device, request.pool), geo.sys, changed)}`, SELFHEAL_RUN_STOPPED)
    // The read-back guard again, at the last instant (cr3 W1). It ran straight
    // after the re-verify (L7), and the pre-check, the rmw knob and the
    // reconstruction have taken real time since: the md block about to be
    // overwritten must STILL be the bytes the member holds.
    const still = await readBackGuard(executor, geo, target, corruptBytes)
    if (!still.ok)
      fail('not-examined', still.detail, 'unresolvable')
    try {
      await writeDirect(executor, geo.device, target.mdByte, winner.bytes)
    }
    catch (error) {
      // cr3 review item 6 — the write was ISSUED and then reported a failure
      // (a failed fsync is the usual shape). The bytes may have landed:
      // "nothing written" is not known to be true, and neither is "repaired".
      // The facts only; the job says what to do, once (cr3 second review 5(c)).
      fail('not-examined', `the write of ${file} block ${request.block} through ${geo.device} (member ${diagnostics.mapping?.memberDevice ?? target.memberDevice}) at md byte ${target.mdByte} was issued and then reported a failure (${errorText(error)}). The arbitrated bytes, verified against the stored csum ${csumHex(storedCsum)}, may have landed or may not.`, SELFHEAL_WRITE_UNCONFIRMED)
    }
    const repaired = `${file} block ${request.block} reconstructed from ${winner.detail} and verified against the stored csum ${csumHex(storedCsum)}`
    // F5 — from here on, "nothing written" is a FALSE sentence. The post-check
    // is a bounded md check over a 20 TB band's stripe: minutes, during which a
    // member can fail and put md into `recover`. `boundedWindowCheck` raises
    // `ForeignSyncOpError` for that, and the single global catch below used to
    // answer it with the same words the PRE-write catch uses.
    written = repaired

    // ---- postcheck ------------------------------------------------------
    await step('postcheck')
    const after = await boundedWindowCheck(executor, geo, stripe, options)
    diagnostics.postcheckMismatch = after
    // GT-23 — the post-check is corroborated the same way the pre-check is, and
    // for the same reason: the stripe was written through md moments ago, which
    // is precisely the state in which its bounded check answers from the cache.
    // `mismatch_cnt = 0` over a row the members say is inconsistent is md's
    // stale view of our own write, not a clean parity group.
    const directAfter = await directParityConsistent(executor, geo, target)
    note(`mismatch_cnt=${after}; ${directAfter.detail}`)
    if (after === 0 && !directAfter.consistent)
      diagnostics.staleCache = true
    // What the residual sentence calls the evidence. md counting the window
    // while the written row reads consistent is not a stale cache — md's window
    // is a whole chunk and the direct read is one page of it, so the mismatch is
    // elsewhere in the band, which is exactly F2's residual.
    const residualNote = after !== 0
      ? `md's bounded check over stripe ${stripe} reports mismatch_cnt=${after}`
      : `md's bounded check over stripe ${stripe} reports mismatch_cnt=0, but md's cached view of this stripe was stale; the direct member read shows the mismatch — ${directAfter.detail}`
    // A residual md counted is one Rewrite parity's evidence gate accepts; one
    // only the direct read saw carries no count md will stand behind, and that
    // gate refuses a zero. So the advice is the scrub that produces the count,
    // not a verb that would be turned away.
    const residualAdvice = (band: string): string => after !== 0
      ? `Run Rewrite parity on ${band}.`
      : `Run a scrub (Scrubs → Run now) so md counts the band's mismatch, then run Rewrite parity on ${band}.`
    if (after !== 0 || !directAfter.consistent) {
      // F2 — a non-zero post-check AFTER a successful write is a different
      // verdict from one before it. The RAID6 shape that produces it: rot in
      // the target block AND in Q. P-XOR wins arbitration, the block goes
      // through md, and md still counts the stripe because Q is wrong. Prove
      // the BLOCK first — cold, through the pin, against the checksum btrfs
      // stored for it — and if it passes, the block is repaired and what is
      // left is a PARITY residual on the band. Telling the operator to restore
      // a file that was just proven correct is how a restore from an older
      // backup loses data that was recoverable.
      const proof = await coldVerify(executor, pin, resolved, verdict.badSectors[0], storedCsum)
      if (proof.ok) {
        note(`mismatch_cnt=${after}; ${directAfter.detail}; the block itself re-reads clean cold — the residual is parity`)
        const residual = parityResidualOf(geo, after, request.pool ?? null)
        return outcome(
          'repaired',
          `${repaired}; ${proof.detail}. The block is repaired; the band still has a parity/Q mismatch — ${residualNote}, which is the parity (or Q) member disagreeing and not this file. ${residualAdvice(residual.band)}`,
          undefined,
          { parityResidual: residual },
        )
      }
      fail('unrepairable', `the block was written back, ${residualNote}, AND ${proof.detail} — the parity group is not consistent and the block cannot be proven either. Restore ${file} from backup.`)
    }

    // ---- coldread -------------------------------------------------------
    // The write has already happened, so this step can no longer refuse
    // anything — it can only confirm. On a §12 pool it needs the pool's
    // top-level mount, which `withTopLevelMount` serialises: a backup run that
    // started since the gates holds it for HOURS, and blocking there would
    // leave `rmw_level=0` set on a live array for the duration of the backup.
    // Bounded wait, then say plainly that the confirmation did not run (S2).
    await step('coldread')
    const cold = await coldRead(executor, pin, resolved)
    if (!cold.ran) {
      note(`skipped: ${cold.reason}`)
      return outcome('repaired', `${repaired} (post-check passed; cold read skipped: ${cold.reason})`)
    }
    if (cold.bad.length > 0) {
      fail('unrepairable', `the repaired region still reads back with an error through a fresh snapshot (blocks ${cold.bad.join(', ')}). Restore ${file} from a backup if one exists.`)
    }
    note('read back clean through the pin snapshot')

    return outcome('repaired', repaired)
  }
  catch (error) {
    if (error instanceof Verdict)
      return outcome(error.kind, error.message, error.code)
    if (error instanceof SelfhealRunError)
      throw error
    if (error instanceof ForeignSyncOpError) {
      const stopped = steps.at(-1)
      if (stopped) {
        stopped.ok = false
        stopped.detail = error.message
      }
      // F5 — the same exception means two different things either side of the
      // write, and only one of them is "nothing written".
      if (written !== null) {
        return outcome(
          'repaired',
          `${written} — the block was written and matches its checksum; the post-check could not run (${error.message}). Run a scrub (Scrubs → Run now) to confirm it.`,
          undefined,
          { postcheckSkipped: error.message },
        )
      }
      // cr3 AHR-HEAL-H1 — md changed the array under the run: no verdict.
      // cr3.heal.paths: a recovery means md lost a member; any other
      // operation ends, and the panel shows when.
      const recovering = error.action === 'recover' || error.action === 'recovery'
      return outcome(
        'not-examined',
        `md started ${error.action ?? 'an operation whose sync_action could not be read'} on ${error.device} during the repair. Nothing was written. `
        + `${recovering ? memberLostAdvice(bandShown(error.device, request.pool), '', error.action) : arrayRefusalAdvice(bandShown(error.device, request.pool), `/sys/block/${error.device.replace(DEV_PREFIX_RE, '')}/md`, { cause: 'busy', action: error.action })}`,
        SELFHEAL_RUN_STOPPED,
      )
    }
    if (written !== null) {
      // cr3 AHR-HEAL-H1 (A) — ANY failure after the write is classified by
      // PHASE, not by its type. The block went through md and its bytes were
      // arbitrated against the stored csum before they did; what failed is the
      // CONFIRMATION (a post-check md marked `delayed` behind another band's
      // recovery and never settled, a member read in the cold verify). Telling
      // the operator to restore a file that was just written with proven bytes
      // is how a restore from an older backup loses data — exactly F5's
      // sentence, for every cause and not only a foreign sync op.
      const stopped = steps.at(-1)
      if (stopped) {
        stopped.ok = false
        stopped.detail = errorText(error)
      }
      return outcome(
        'repaired',
        `${written} — the block was written and matches its checksum; the confirmation after the write could not complete (${errorText(error)}). Run a scrub (Scrubs → Run now) to confirm it.`,
        undefined,
        { postcheckSkipped: errorText(error) },
      )
    }
    if (error instanceof SelfhealMapError) {
      // F3 — a map failure is a block NOBODY LOOKED AT. `mapping-abort` asserts
      // the opposite (the bytes there were read and passed their checksum), and
      // it is raised in exactly one place: the re-verify, which established it.
      // cr3.heal.paths: the map's sentence is a fact; the job adds, by
      // code, what to do about it.
      return outcome('not-examined', `${error.message}. Nothing was written.`, error.reasonCode)
    }
    // Review R1: a throw whose site knows its cause says what to do here.
    throw new SelfhealRunError(errorText(error), steps, diagnostics, { cause: error, advice: thrownAdvice(error, outcomeBand, request.pool) })
  }
  finally {
    await cleanup()
  }

  // -- helpers that close over the run's state -----------------------------

  function outcome(
    kind: SelfhealOutcomeKind,
    reason: string,
    code?: SelfhealReasonCode,
    extra?: { parityResidual?: SelfhealParityResidual, postcheckSkipped?: string },
  ): SelfhealOutcome {
    const map = diagnostics.mapping
    return {
      outcome: kind,
      reason,
      ...(code ? { reasonCode: code } : {}),
      ...(extra?.parityResidual ? { parityResidual: extra.parityResidual } : {}),
      ...(extra?.postcheckSkipped ? { postcheckSkipped: extra.postcheckSkipped } : {}),
      file,
      block: request.block,
      pool: request.pool?.name ?? null,
      array: outcomeBand?.device ?? null,
      member: map?.memberDevice ?? null,
      stripe: map?.stripe ?? null,
      steps,
      diagnostics,
    }
  }

  async function cleanup(): Promise<void> {
    // Per band, and ONLY the bands this run touched (F5).
    for (const band of touched.values()) {
      if (band.savedRmwLevel !== null) {
        try {
          await writeMdAttr(band.geo.sys, 'rmw_level', band.savedRmwLevel)
        }
        catch (error) {
          diagnostics.cleanupErrors.push(`${band.geo.device}: rmw_level not restored to ${band.savedRmwLevel}: ${errorText(error)}`)
        }
      }
      if (band.syncKnobs) {
        try {
          // A foreign op is not an error — it is a reason the window is still
          // narrow, and the operator is told which op it was rather than
          // having md interrupted on their behalf (D2).
          const left = await restoreSyncKnobs(band.geo)
          if (left)
            diagnostics.cleanupErrors.push(left)
        }
        catch (error) {
          diagnostics.cleanupErrors.push(`${band.geo.device}: sync knobs not restored: ${errorText(error)}`)
        }
      }
      if (band.savedStripeCache !== null) {
        try {
          if ((await readMdAttrOrNull(band.geo.sys, 'stripe_cache_size')) !== band.savedStripeCache)
            await writeMdAttr(band.geo.sys, 'stripe_cache_size', band.savedStripeCache)
        }
        catch (error) {
          diagnostics.cleanupErrors.push(`${band.geo.device}: stripe_cache_size not restored to ${band.savedStripeCache}: ${errorText(error)}`)
        }
      }
    }
    if (pin) {
      try {
        await pin.destroy()
      }
      catch (error) {
        diagnostics.cleanupErrors.push(`transient snapshot ${pin.describe} not destroyed: ${errorText(error)}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  Steps
// ---------------------------------------------------------------------------

/**
 * Why this repair must not run right now, or null when it may.
 *
 * EVERY band of the pool is checked. Which band the block is on is not known
 * until it has been pinned and resolved, and an AHR pool with any band
 * degraded, resyncing or reshaping is one the operator is told to leave alone
 * as a whole — the route refuses it by pool state for the same reason.
 */
async function gateRefusal(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  pool: AhrPool | null,
  options?: SelfhealRepairOptions,
): Promise<{ reason: string, advice: string } | null> {
  for (const band of ctx.bands) {
    // A band whose geometry could not be read is carried, not thrown, since F6
    // (the attribution pass must survive one unreadable band). A REPAIR still
    // refuses the whole pool for it: which band the block is on is not known
    // yet, and a band nothing can be read from is not one to write near.
    if (band.geometry === null)
      return { reason: `${band.device}: ${band.error ?? 'its geometry could not be read'}`, advice: BAND_UNREADABLE_ADVICE }
    // cr3.heal.paths: each refusal carries what must change before a rerun,
    // picked by the cause the gate found (coordinator decision 5).
    const refusal = await arrayRefusalOf(band.geometry)
    if (refusal)
      return { reason: refusal.reason, advice: arrayRefusalAdvice(bandShown(band.geometry.device, pool), band.geometry.sys, refusal) }
  }

  // An in-flight pvmove replaces the LV's linear target with a mirror and moves
  // extents underneath it: every byte offset this chain computes would be stale.
  const tables = await executor.exec(DMSETUP, ['table'])
  if (tables.exitCode === 0) {
    for (const line of tables.stdout.split('\n')) {
      const name = line.split(':')[0].trim()
      if (name.startsWith('pvmove')) {
        return {
          reason: `a pvmove (${name}) is moving the physical extents under this pool`,
          advice: 'Run Repair from parity again when the pvmove has finished (`dmsetup table` lists no pvmove device).',
        }
      }
    }
  }
  // Re-parse the pool's own table: a non-linear target here is the other face
  // of the same problem, and parseDmTable refuses it by name.
  const own = await executor.exec(DMSETUP, ['table', ctx.srcDevice])
  if (own.exitCode === 0 && own.stdout.trim()) {
    try {
      parseDmTable(own.stdout)
    }
    catch (error) {
      // No rerun: nothing names what would change (a striped or mirrored LV
      // stays one), so the result is final and goes back with the job.
      return { reason: errorText(error), advice: REPORT_IT_ADVICE }
    }
  }

  // A §12 pin needs the pool's on-demand top-level mount, and `withTopLevelMount`
  // serialises on that ONE path: a second holder (a backup run, which keeps every
  // pool's top level mounted across one pbc invocation) would make this repair
  // wait behind it, and a repair that silently blocks for hours is worse than one
  // that says why. Check before pinning rather than racing.
  if (pool && poolLayout(pool) === 'subvol') {
    const mnt = topLevelMountPath(pool, options?.ahrSnapshotOptions)
    if ((await executor.exec(FINDMNT, ['--mountpoint', mnt])).exitCode === 0) {
      return {
        reason: `a backup or snapshot job holds the top-level mount of pool '${pool.name}' at ${mnt}, and Repair from parity needs that mount to itself`,
        advice: `Run Repair from parity again when that job has finished (\`findmnt --mountpoint ${mnt}\` prints nothing).`,
      }
    }
  }
  return null
}

/**
 * The gates, re-run on ONE array immediately before the write (D2).
 *
 * The gates at step 1 proved this array complete and still. This asks whether
 * it STILL is, at the last instant before bytes go in — so "changed" and "not
 * clean now" are the same question and the answer names the condition.
 *
 * Exported because the parity rewrite (selfheal.10) has the same last instant
 * — its md write is `mdadm --action=repair` over a whole band — and asks the
 * question with this function rather than a second copy of it.
 */
export async function preWriteRefusal(geo: MdGeometry): Promise<string | null> {
  return (await preWriteRefusalOf(geo))?.reason ?? null
}

/**
 * {@link preWriteRefusal} with the cause it found (cr3.heal.paths): the repair
 * names what must change before a rerun by the cause, never by its sentence.
 */
export async function preWriteRefusalOf(geo: MdGeometry): Promise<ArrayRefusal | null> {
  const degraded = await readMdAttrOrNull(geo.sys, 'degraded')
  if (degraded !== null && degraded !== '0')
    return { cause: 'member-missing', action: await readSyncAction(geo), reason: `${geo.device} is now degraded (${degraded} member${degraded === '1' ? '' : 's'} missing)` }
  const action = await readSyncAction(geo)
  if (!isIdleSyncAction(action))
    return { cause: 'busy', action, reason: `${geo.device} is now running ${action ?? 'an operation whose sync_action could not be read'}` }
  const reshape = await readMdAttrOrNull(geo.sys, 'reshape_position')
  if (reshape !== null && reshape !== 'none')
    return { cause: 'reshape', reason: `${geo.device} is now mid-reshape (reshape_position=${reshape})` }
  return null
}

/**
 * The roles md is no longer serving, read from sysfs rather than from the
 * `mdadm --detail --export` snapshot the geometry was built from (D7).
 *
 * The kernel removes a faulty member's `rd<n>` directory the moment it kicks
 * it, so an absent attribute IS the answer; a member marked `faulty` that has
 * not been removed yet counts too. Skipped entirely while `degraded` reads 0,
 * which is the overwhelmingly common case and costs one attribute read.
 */
async function absentRoles(geo: MdGeometry): Promise<number[]> {
  const degraded = await readMdAttrOrNull(geo.sys, 'degraded')
  if (degraded === null || degraded === '0')
    return []
  const out: number[] = []
  for (let role = 0; role < geo.raidDisks; role++) {
    if (geo.members[role] === null) {
      out.push(role)
      continue
    }
    const state = await readMdAttrOrNull(geo.sys, `rd${role}/state`)
    if (state === null || state.includes('faulty'))
      out.push(role)
  }
  return out
}

/** Which reconstructions are still possible given what md is still serving. */
export interface ReconstructionPlan {
  /** Set when none of them are — the operator's sentence. */
  refusal: string | null
  /** RAID6/RAID5: the P-based XOR candidate can be built. */
  pXor: boolean
  /** RAID6: the Q-syndrome candidate can be built (P never consulted). */
  qSyndrome: boolean
  /** RAID1: the legs that are still in the array AND passed their csum. */
  mirrors: number[]
}

/**
 * What can still be reconstructed once md's kicked members are taken out (D7).
 *
 * RAID5 needs every other member of the stripe, so one kicked sibling ends it.
 * RAID6 has two syndromes and survives exactly one: a kicked Q leaves the
 * P-XOR, a kicked P leaves the Q solve — which is the whole reason the Q path
 * exists. A kicked DATA member is a second unknown alongside the block under
 * repair and neither syndrome can solve for two.
 */
export function reconstructionPlan(
  geo: MdGeometry,
  target: MemberLocation,
  absent: number[],
  goodMirrors: number[],
): ReconstructionPlan {
  const kicked = absent.filter(role => role !== target.memberIndex)
  const names = kicked.map(role => geo.members[role] ?? `role ${role}`).join(', ')
  const since = `md has kicked ${names} out of ${geo.device} since this repair started`

  if (geo.raid1) {
    const mirrors = goodMirrors.filter(leg => !kicked.includes(leg))
    return mirrors.length > 0
      ? { refusal: null, pXor: false, qSyndrome: false, mirrors }
      : { refusal: `${since} — there is no mirror leg left to copy the block from. Nothing was written.`, pXor: false, qSyndrome: false, mirrors: [] }
  }
  if (kicked.length === 0)
    return { refusal: null, pXor: true, qSyndrome: geo.raid6, mirrors: [] }
  if (!geo.raid6)
    return { refusal: `${since} — a RAID5 reconstruction needs every other member of the stripe. Nothing was written.`, pXor: false, qSyndrome: false, mirrors: [] }
  if (kicked.length > 1)
    return { refusal: `${since} — a RAID6 stripe with the block under repair and two members gone has three unknowns and two syndromes. Nothing was written.`, pXor: false, qSyndrome: false, mirrors: [] }
  if (kicked[0] === target.qIndex)
    return { refusal: null, pXor: true, qSyndrome: false, mirrors: [] }
  if (kicked[0] === target.parityIndex)
    return { refusal: null, pXor: false, qSyndrome: true, mirrors: [] }
  return { refusal: `${since} — that is a second unknown data member in the same stripe as the block under repair, and neither syndrome solves for two. Nothing was written.`, pXor: false, qSyndrome: false, mirrors: [] }
}

/**
 * Why ONE band's array cannot be repaired on right now, or null when it can.
 *
 * The submit-time half of the pair above, and shared with the parity rewrite
 * (selfheal.10) for the same reason: degraded, busy, mid-reshape and an
 * unwritable `array_state` bar a parity rewrite exactly as they bar a block
 * repair, and the operator should read the same sentence either way.
 */
export async function arrayRefusal(geo: MdGeometry): Promise<string | null> {
  return (await arrayRefusalOf(geo))?.reason ?? null
}

/**
 * What an array refusal is about (cr3.heal.paths). The sentence is shared with
 * the parity rewrite and the mirror reconcile; what a reader does next is the
 * caller's, and the repair picks it by this cause.
 */
export type ArrayRefusalCause = 'member-missing' | 'busy' | 'reshape' | 'state'

export interface ArrayRefusal {
  cause: ArrayRefusalCause
  reason: string
  /** md's `sync_action` when the refusal was read (review R2): whether a rebuild is already running. */
  action?: string | null
}

/** {@link arrayRefusal} with the cause it found. */
export async function arrayRefusalOf(geo: MdGeometry): Promise<ArrayRefusal | null> {
  const degraded = await readMdAttrOrNull(geo.sys, 'degraded')
  if (degraded !== null && degraded !== '0') {
    return { cause: 'member-missing', action: await readSyncAction(geo), reason: `${geo.device} is degraded (${degraded} member${degraded === '1' ? '' : 's'} missing) — a reconstruction needs every other member of the stripe` }
  }
  if (geo.members.includes(null))
    return { cause: 'member-missing', action: await readSyncAction(geo), reason: `${geo.device} is missing a member — a reconstruction needs every other member of the stripe` }

  const action = await readMdAttr(geo.sys, 'sync_action')
  if (action !== 'idle')
    return { cause: 'busy', action, reason: `${geo.device} is busy (sync_action=${action}) — resync, recovery, reshape and check all move or re-read the bytes this repair depends on` }

  const reshape = await readMdAttrOrNull(geo.sys, 'reshape_position')
  if (reshape !== null && reshape !== 'none')
    return { cause: 'reshape', reason: `${geo.device} is mid-reshape (reshape_position=${reshape}) — the layout under this block is changing` }

  const state = await readMdAttr(geo.sys, 'array_state')
  if (REFUSED_ARRAY_STATES[state])
    return { cause: 'state', reason: `${geo.device}: ${REFUSED_ARRAY_STATES[state]} (array_state=${state})` }
  return null
}

/**
 * What the reader does after a repair stopped on an array refusal
 * (cr3.heal.paths): the rerun is offered with the change that must come first
 * and where the reader sees it. A lost member is the one cause whose rerun is
 * never offered: md rebuilds the lost member's row from the bytes the block
 * holds now, so after the rebuild a scrub decides.
 */
function arrayRefusalAdvice(device: string, sys: string, refusal: Pick<ArrayRefusal, 'cause' | 'action'>): string {
  const cause = refusal.cause
  switch (cause) {
    case 'member-missing':
      return memberLostAdvice(device, sys, refusal.action ?? null)
    case 'busy':
      // Review R2: a reshape and a frozen sync are named as what to wait for.
      if (refusal.action === 'reshape')
        return `Run Repair from parity again when the AHR panel shows ${device} clean, with the reshape finished.`
      if (refusal.action === 'frozen')
        return `Run Repair from parity again once \`cat ${sys}/sync_action\` no longer reads frozen.`
      return `Run Repair from parity again when the AHR panel shows ${device} clean, with no check, build or rebuild in progress.`
    case 'reshape':
      return `Run Repair from parity again when the AHR panel shows ${device} clean, with the reshape finished.`
    case 'state':
      return `Run Repair from parity again once \`cat ${sys}/array_state\` reads clean or active.`
  }
}

/**
 * What the reader does after a throw whose site knows its cause (review R1),
 * or null when it does not (the job then says "final for this run, report
 * it"). A member that could not be read is a disk to check and maybe replace;
 * a bounded check that did not finish is a band to watch until it is idle.
 */
function thrownAdvice(error: unknown, band: MdGeometry | null, pool: AhrPool | null | undefined): string | null {
  if (error instanceof DirectReadError && band && band.members.includes(error.device)) {
    return `Check SMART for the disk holding ${error.device} in Disks, and replace it (AHR panel → Replace disk) if it is failing. `
      + 'Then run a scrub (Scrubs → Run now) and repair from what it names. If the same member fails to read again, replace that disk.'
  }
  if (error instanceof CheckTimeoutError) {
    return `md's check did not finish in time. Run Repair from parity again when the AHR panel shows ${bandShown(error.device, pool)} `
      + 'with no check in progress. If it stops here a second time with the band idle, report it with this job\'s result.'
  }
  return null
}

/**
 * A band named as the AHR panel shows it (review D4): `/dev/md/<pool>-r<n>`
 * (ahr-topology.ts, rendered by 39-ahr.js), with the kernel name the engine
 * read it by in parentheses. A run with no pool (the loop-device rigs) names
 * the kernel device alone, which is all it has.
 */
function bandShown(device: string, pool: AhrPool | null | undefined): string {
  const kernel = device.replace(DEV_PREFIX_RE, '')
  const array = pool?.arrays.find(a => a.kernelName === kernel || a.device === device)
  return array && array.device !== device ? `${array.device} (${device})` : device
}

/** A member md lost under the repair (cr3.heal.paths, coordinator decision 6). */
function memberLostAdvice(device: string, sys: string, action: string | null): string {
  // Review R2: "Replace the failed disk" only where no rebuild is running;
  // a rebuild, a reshape or a frozen sync is named as what to wait for.
  const scrub = 'run a scrub (Scrubs → Run now): a block the scrub still names needs a restore.'
  if (action === 'recover' || action === 'recovery')
    return `md is rebuilding ${device}. When the AHR panel shows it clean, ${scrub}`
  if (action === 'reshape') {
    return `md is reshaping ${device} with a member missing. When the AHR panel no longer shows it reshaping, replace the failed disk `
      + `(AHR panel → Replace disk); when it shows clean again, ${scrub}`
  }
  if (action === 'frozen') {
    return `md has frozen sync on ${device} with a member missing. Once \`cat ${sys}/sync_action\` no longer reads frozen, replace the failed disk `
      + `(AHR panel → Replace disk) unless the AHR panel shows the band rebuilding; when it shows clean again, ${scrub}`
  }
  if (action === null) {
    return `Unless the AHR panel shows ${device} rebuilding, replace the failed disk (AHR panel → Replace disk). `
      + `When it shows clean again, ${scrub}`
  }
  return `Replace the failed disk (AHR panel → Replace disk). When the AHR panel shows ${device} clean again, ${scrub}`
}

// ---------------------------------------------------------------------------
//  The pin
// ---------------------------------------------------------------------------

/**
 * How this run pinned the block, and how the cold read gets at it.
 *
 * TWO shapes, because AHR has two pool layouts:
 *
 *  - **§12 (`subvolLayout`)** — the pool mounts `@data` at its mountpoint and
 *    keeps `@snapshots` beside it, OUTSIDE the mounted tree. The pin then goes
 *    through the SAME `ahr-snapshots.ts` verbs every other AHR snapshot goes
 *    through — `createAhrSnapshot` / `deleteAhrSnapshot` / `listAhrSnapshots`,
 *    with the cold read reaching `@snapshots/<name>/…` through
 *    `withTopLevelMount`, exactly as a backup run reads its own transients.
 *    One snapshot machinery, one mount discipline, one place to fix.
 *  - **flat pool, or no pool at all** — there is no `@snapshots` to put
 *    anything in, so the pin is a read-only snapshot of the file's own
 *    subvolume placed inside the mountpoint. That is also what the selfheal.2
 *    loop-device rigs are, which is why the suite exercises this branch.
 *
 * Both carry the backup2.3 lifecycle: an `anas-selfheal-<ts>` name, a
 * stale-prefix sweep before taking a new one, destruction in a `finally`, and
 * a leftover that could not be destroyed NAMED in `cleanupErrors` rather than
 * swallowed.
 */
interface Pin {
  /** What to call it in an outcome or an error. */
  describe: string
  /**
   * Read those file blocks cold through the snapshot.
   *
   * `ran: false` is a real answer, not a failure: on a §12 pool the read needs
   * the pool's top-level mount, and a backup job holding it for hours is not
   * something a repair that has ALREADY WRITTEN should block behind (S2).
   */
  coldRead: (blocks: number[]) => Promise<ColdReadResult>
  destroy: () => Promise<void>
}

/** What the cold read found, or why it could not look. */
interface ColdReadResult {
  ran: boolean
  /** The blocks that still read back with an error. Empty when `ran` is false. */
  bad: number[]
  /** Why it could not run — an operator's clause, appended to the outcome. */
  reason: string
}

function noProgress(): void {}

/**
 * The `@data`-relative path of the subvolume holding `file`, or null when the
 * file is in `@data` itself.
 *
 * A btrfs read-only snapshot does NOT recurse into nested subvolumes — each is
 * left an empty placeholder (GT-52/55) — so a file inside one has to be pinned
 * by snapshotting THAT subvolume, which is the same reason backup2.3 takes one
 * snapshot per subvolume.
 */
async function nestedSubvolumeOf(
  executor: CommandExecutor,
  pool: AhrPool,
  file: string,
): Promise<string | null> {
  const id = await subvolumeIdOf(executor, file)
  const r = await executor.exec(BTRFS, ['inspect-internal', 'subvolid-resolve', String(id), pool.mountpoint])
  if (r.exitCode !== 0)
    throw new Error(`cannot resolve subvolume ${id} of ${file}: ${r.stderr.trim()}`)
  const resolved = r.stdout.trim().replace(LEADING_SLASH_RE, '')
  if (resolved === SUBVOL_DATA)
    return null
  if (resolved.startsWith(`${SUBVOL_DATA}/`))
    return resolved.slice(SUBVOL_DATA.length + 1)
  throw new Error(`${file} resolves to '${resolved}', which is not under ${SUBVOL_DATA} — it is not in the pool's mounted tree`)
}

/**
 * The mountpoint-relative path of the nested subvolume holding `file` on a
 * FLAT pool (or a plain mountpoint), or null when the file is in the mounted
 * subvolume itself (cr3 AHR-HEAL-M6).
 *
 * The §12 branch asks `subvolid-resolve` and reads the answer against `@data`;
 * a flat mount has no such anchor, so the subvolume root is found by walking
 * up from the file: the highest directory under the mountpoint that is still
 * in the file's subvolume is that subvolume's root.
 */
async function flatNestedSubvolumeOf(
  executor: CommandExecutor,
  mountpoint: string,
  file: string,
): Promise<string | null> {
  const fileId = await subvolumeIdOf(executor, file)
  if (fileId === await subvolumeIdOf(executor, mountpoint))
    return null
  let root: string | null = null
  for (let dir = dirname(file); dir.startsWith(`${mountpoint}/`); dir = dirname(dir)) {
    if ((await subvolumeIdOf(executor, dir)) !== fileId)
      break
    root = dir
  }
  if (root === null)
    throw new Error(`${file} is in subvolume ${fileId}, and no directory between it and ${mountpoint} is that subvolume's root`)
  return relative(mountpoint, root)
}

/** Take the transient pin, sweeping any leftover of a crashed earlier run first. */
async function takePin(
  executor: CommandExecutor,
  mountpoint: string,
  file: string,
  pool: AhrPool | null,
  diagnostics: SelfhealDiagnostics,
  options?: SelfhealRepairOptions,
): Promise<Pin> {
  const name = `${SELFHEAL_SNAPSHOT_PREFIX}${Math.floor(Date.now() / 1000)}`
  const ahrOptions = options?.ahrSnapshotOptions

  if (pool && poolLayout(pool) === 'subvol' && pool.mounted) {
    diagnostics.cleanupErrors.push(...(await sweepSelfhealPins(executor, pool, mountpoint, ahrOptions)).errors)
    const nested = await nestedSubvolumeOf(executor, pool, file)
    await createAhrSnapshot(executor, pool, name, noProgress, {
      ...ahrOptions,
      ...(nested ? { subvolume: nested } : {}),
    })
    // The file's path INSIDE the snapshot is relative to the subvolume that was
    // snapshotted, not to the pool mountpoint.
    const base = nested ? join(mountpoint, nested) : mountpoint
    const within = relative(base, file)
    return {
      describe: `${pool.name}:${SUBVOL_SNAPSHOTS}/${name}`,
      coldRead: async (blocks) => {
        const held = await withTopLevelMountWithin(executor, pool, async (top) => {
          const path = join(top, SUBVOL_SNAPSHOTS, name, within)
          const bad: number[] = []
          for (const block of blocks) {
            const read = await probeFileBlockState(executor, path, block)
            // Not in the snapshot: a read that could not be taken (M6).
            if (read === 'missing')
              return { missing: path, bad: [] }
            if (read === 'bad')
              bad.push(block)
          }
          return { missing: null, bad }
        }, ahrOptions, options?.coldReadWaitMs)
        if (held.ran && held.value.missing !== null)
          return { ran: false, bad: [], reason: `${held.value.missing} is not in the pin snapshot, so nothing was read through it` }
        return held.ran
          ? { ran: true, bad: held.value.bad, reason: '' }
          : { ran: false, bad: [], reason: `top-level mount busy (another job has held ${topLevelMountPath(pool, ahrOptions)} for the ${Math.round(held.waitedMs / 1000)}s this read waited)` }
      },
      destroy: async () => {
        await deleteAhrSnapshot(executor, pool, name, noProgress, ahrOptions)
      },
    }
  }

  // Flat pool (or no pool): no @snapshots to put it in, so the snapshot goes
  // inside the mountpoint and is swept from there.
  diagnostics.cleanupErrors.push(...(await sweepSelfhealPins(executor, null, mountpoint, ahrOptions)).errors)
  // cr3 AHR-HEAL-M6 — the §12 branch's rule, on a flat pool too: a read-only
  // snapshot does NOT recurse into a nested subvolume (GT-52/55). Snapshotting
  // the mountpoint left a file inside one UNPINNED between the resolve and the
  // write, and absent from the snapshot the cold read then looked in. So the
  // subvolume that actually holds the file is the one snapshotted.
  const nested = await flatNestedSubvolumeOf(executor, mountpoint, file)
  const source = nested ? join(mountpoint, nested) : mountpoint
  const path = join(mountpoint, name)
  const r = await executor.exec(BTRFS, ['subvolume', 'snapshot', '-r', source, path])
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `btrfs subvolume snapshot exited ${r.exitCode}`)
  const within = relative(source, file)
  return {
    describe: path,
    coldRead: async (blocks) => {
      const bad: number[] = []
      for (const block of blocks) {
        const read = await probeFileBlockState(executor, join(path, within), block)
        // A path that is not in the snapshot is a read that could not be
        // taken, never a block that failed (cr3 AHR-HEAL-M6).
        if (read === 'missing')
          return { ran: false, bad: [], reason: `${join(path, within)} is not in the pin snapshot, so nothing was read through it` }
        if (read === 'bad')
          bad.push(block)
      }
      return { ran: true, bad, reason: '' }
    },
    destroy: async () => {
      const d = await executor.exec(BTRFS, ['subvolume', 'delete', path])
      if (d.exitCode !== 0)
        throw new Error(d.stderr.trim() || `btrfs subvolume delete exited ${d.exitCode}`)
    },
  }
}

/** What one sweep of this engine's transient snapshots destroyed, and what it could not. */
export interface SelfhealPinSweep {
  /** Names destroyed. */
  swept: string[]
  /** Leftovers that could not be destroyed, each with its reason. */
  errors: string[]
}

/**
 * Destroy leftovers of a crashed earlier run — this engine's OWN prefix only,
 * never anything an operator or a backup made.
 *
 * Called from two places and living in one (D4): `takePin`, before it takes a
 * new one, and the daemon-start reconciliation, which is the only thing that
 * can clean up after a run that was SIGKILLed and so never reached its
 * `finally`. Both shapes of pin are swept here — the §12 `@snapshots/<name>`
 * through the same AHR snapshot verbs the pin is taken with, and the flat
 * pool's in-place subvolume inside the mountpoint.
 */
export async function sweepSelfhealPins(
  executor: CommandExecutor,
  pool: AhrPool | null,
  mountpoint: string,
  ahrOptions?: AhrSnapshotOptions,
): Promise<SelfhealPinSweep> {
  const swept: string[] = []
  const errors: string[] = []

  // cr3: an unknown layout is not the flat one — sweep nothing rather than
  // guess where the transient snapshots are.
  if (pool && poolLayout(pool) === 'unknown') {
    errors.push(`transient snapshots of pool '${pool.name}' were not swept: ${unknownLayoutSentence(pool)}`)
    return { swept, errors }
  }
  if (pool && poolLayout(pool) === 'subvol' && pool.mounted) {
    for (const stale of await listAhrSnapshots(executor, pool, ahrOptions)) {
      if (!stale.name.startsWith(SELFHEAL_SNAPSHOT_PREFIX))
        continue
      try {
        await deleteAhrSnapshot(executor, pool, stale.name, noProgress, ahrOptions)
        swept.push(`${pool.name}:${SUBVOL_SNAPSHOTS}/${stale.name}`)
      }
      catch (error) {
        errors.push(`stale transient snapshot ${pool.name}:${SUBVOL_SNAPSHOTS}/${stale.name} could not be swept: ${errorText(error)}`)
      }
    }
    return { swept, errors }
  }

  let entries: string[]
  try {
    entries = await readdir(mountpoint)
  }
  catch {
    return { swept, errors }
  }
  for (const entry of entries) {
    if (!entry.startsWith(SELFHEAL_SNAPSHOT_PREFIX))
      continue
    const r = await executor.exec(BTRFS, ['subvolume', 'delete', join(mountpoint, entry)])
    if (r.exitCode === 0)
      swept.push(join(mountpoint, entry))
    else
      errors.push(`stale transient snapshot ${entry} could not be swept: ${r.stderr.trim()}`)
  }
  return { swept, errors }
}

interface Reverified {
  /** Indexes (within the repair unit) of the on-disk sectors that failed their csum. */
  badSectors: number[]
  /** The corrupt bytes as read from the member — the read-back guard compares against these. */
  corruptBytes: Buffer
  /** The stored csum of the sector under repair. */
  storedCsum: number
  /** RAID1: the leg that failed; null on parity levels. */
  badMirror: number | null
  /** RAID1: legs that still pass their csum — the candidate source. */
  goodMirrors: number[]
  /** Set when the sequence must stop here. */
  abort: {
    kind: SelfhealOutcomeKind
    reason: string
    code?: SelfhealReasonCode
    /**
     * RAID1 with EVERY leg failing the stored csum (seventh pass, F4).
     *
     * The verdict is NOT decided here: the same bad bytes on both legs is what
     * rot that arrived THROUGH md looks like on a mirror, and on a parity band
     * that fault is diagnosed `above-md` by the bounded check. Parallel
     * construction says it must read the same way on a mirror, so the caller
     * runs the check before it answers.
     */
    mirrorAllLegsFail?: true
  } | null
}

/**
 * Re-read the bytes AT THE COMPUTED MEMBER LOCATION and require they FAIL the
 * current stored csum.
 *
 * This is what makes a wrong mapping harmless: pointed at a healthy block that
 * happens to hold identical content (a zero-filled region of an image, say),
 * the engine finds a passing csum and aborts with "not corrupt here" instead of
 * writing a correct-looking block over a healthy one.
 *
 * Every sector is read through ITS OWN band's geometry (F5). A compressed blob
 * can straddle a band boundary, and the first sector's `raid1`, `members` and
 * data offsets say nothing about the array the later sectors are on.
 */
async function reverify(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  resolved: ResolvedBlock,
): Promise<Reverified> {
  const badSectors: number[] = []
  let corruptBytes: Buffer = Buffer.alloc(0)
  let storedCsum = 0
  let badMirror: number | null = null
  let goodMirrors: number[] = []

  for (let k = 0; k < resolved.sectors.length; k++) {
    const location = resolved.sectors[k]
    const geo = location.geometry
    let stored: number | null
    try {
      stored = await readStoredCsum(executor, ctx, location.logical)
    }
    catch (error) {
      // D3: the csum tree leaf failed its OWN checksum on every copy. Nothing
      // is known about the data block — say that, with a code the UI can key
      // on, and never the words "restore from backup".
      if (!(error instanceof CsumUnreadableError))
        throw error
      return {
        badSectors,
        corruptBytes,
        storedCsum,
        badMirror,
        goodMirrors,
        abort: { kind: 'unrepairable', reason: error.message, code: error.reasonCode },
      }
    }
    if (stored === null) {
      return {
        badSectors,
        corruptBytes,
        storedCsum,
        badMirror,
        goodMirrors,
        abort: {
          // cr3 second review 5(a): a scrub names only blocks whose checksum
          // FAILED, so a block with none now is a stale finding or a file
          // that keeps no checksums. Scrub again; never "restore".
          kind: 'not-examined',
          reason: `btrfs keeps no checksum for logical byte ${location.logical} of ${resolved.file} now, so this range has changed since the scrub named it. Nothing was written.`,
          code: SELFHEAL_NO_CHECKSUM,
        },
      }
    }
    if (geo.raid1) {
      const good: number[] = []
      let bad: number | null = null
      for (const leg of location.mirrors) {
        const device = geo.members[leg] as string
        // Each leg at ITS OWN data offset — they are allowed to differ.
        const bytes = await readMemberWithRetry(executor, device, memberOffsetOn(geo, location, leg), stored)
        if (crc32c(bytes.value) === stored) {
          good.push(leg)
        }
        else if (bad === null) {
          bad = leg
          corruptBytes = bytes.value
          storedCsum = stored
        }
      }
      if (bad !== null) {
        badSectors.push(k)
        badMirror = bad
        goodMirrors = good
      }
    }
    else {
      const bytes = await readDirect(executor, location.memberDevice, location.memberOffset, BLOCK_BYTES)
      if (crc32c(bytes) !== stored) {
        badSectors.push(k)
        if (badSectors.length === 1) {
          corruptBytes = bytes
          storedCsum = stored
        }
      }
    }
  }

  if (badSectors.length === 0) {
    return {
      badSectors,
      corruptBytes,
      storedCsum,
      badMirror,
      goodMirrors,
      abort: {
        kind: 'mapping-abort',
        reason: `not corrupt here: the content at (m${resolved.sectors[0].memberIndex}, ${resolved.sectors[0].memberOffset}) passes the stored csum for ${resolved.file} block ${resolved.block}. Nothing was written.`,
      },
    }
  }
  if (badSectors.length > 1) {
    return {
      badSectors,
      corruptBytes,
      storedCsum,
      badMirror,
      goodMirrors,
      abort: {
        kind: 'unrepairable',
        // cr3 second review 5(a): what ANAS did not attempt, and why.
        reason: `${badSectors.length} on-disk sectors of one ${resolved.compressed ? 'compressed blob' : 'extent'} of ${resolved.file} fail their stored csum (sectors ${badSectors.join(', ')}). ANAS repairs one sector per run and does not repair an extent with several, so this result is final. Nothing was written. Restore ${resolved.file} from a backup if one exists.`,
      },
    }
  }
  if (resolved.sectors[badSectors[0]].geometry.raid1 && goodMirrors.length === 0) {
    return {
      badSectors,
      corruptBytes,
      storedCsum,
      badMirror,
      goodMirrors,
      abort: {
        kind: 'unrepairable',
        reason: `every mirror leg fails the stored csum for ${resolved.file} block ${resolved.block} — there is no good copy left.`,
        mirrorAllLegsFail: true,
      },
    }
  }
  return { badSectors, corruptBytes, storedCsum, badMirror, goodMirrors, abort: null }
}

/**
 * The read-back guard: prove the md offset about to be WRITTEN is the one the
 * member bytes were READ from.
 *
 * On a parity level the block lives on exactly one member, so the through-md
 * read must equal the bytes read directly off that member — anything else says
 * the mapping and the array disagree, and nothing is written.
 *
 * On RAID1 md serves a read from whichever leg its `read_balance` picks, so the
 * through-md bytes are as likely to be the HEALTHY leg's as the failing one's.
 * Demanding the failing leg's bytes there fails a repair that is perfectly
 * sound, roughly half the time. What the guard can still prove — and what it
 * has to prove — is that the md offset maps onto THIS mirror set: the
 * through-md bytes must equal what one of the legs holds at its own offset.
 */
async function readBackGuard(
  executor: CommandExecutor,
  geo: MdGeometry,
  target: MemberLocation,
  corruptBytes: Buffer,
): Promise<{ ok: boolean, detail: string }> {
  const throughMd = await readDirect(executor, geo.device, target.mdByte, BLOCK_BYTES)
  if (!geo.raid1) {
    return throughMd.equals(corruptBytes)
      ? { ok: true, detail: `the md block at ${target.mdByte} is the bytes read from ${target.memberDevice}` }
      : {
          ok: false,
          detail: `read-back guard failed: the md block at ${target.mdByte} does not hold the bytes read from ${target.memberDevice} at ${target.memberOffset}, so ANAS cannot confirm where this block is. Nothing was written.`,
        }
  }
  for (const leg of target.mirrors) {
    const device = geo.members[leg]
    if (!device)
      continue
    const bytes = await readDirect(executor, device, memberOffsetOn(geo, target, leg), BLOCK_BYTES)
    if (throughMd.equals(bytes))
      return { ok: true, detail: `the md block at ${target.mdByte} is the copy on ${device} (md serves a mirror read from either leg)` }
  }
  return {
    ok: false,
    detail: `read-back guard failed: the md block at ${target.mdByte} matches no leg of this mirror at its own offset, so ANAS cannot confirm where this block is. Nothing was written.`,
  }
}

/**
 * Read one member block, retrying a read whose content does not pass the csum.
 *
 * A mirror leg can hand back a TORN read (a write that landed on one leg while
 * the read was in flight) which is not rot and passes on the next attempt.
 * Three tries, then whatever the last one said.
 */
async function readMemberWithRetry(
  executor: CommandExecutor,
  device: string,
  offset: number,
  stored: number,
): Promise<{ value: Buffer, attempts: number }> {
  let last: Buffer = Buffer.alloc(0)
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await readDirect(executor, device, offset, BLOCK_BYTES)
    if (crc32c(last) === stored)
      return { value: last, attempts: attempt }
  }
  return { value: last, attempts: 3 }
}

/**
 * Build every candidate the {@link ReconstructionPlan} says is still possible,
 * best first.
 *
 * RAID5 has exactly one: the XOR of the same stripe row on every other member.
 * RAID6 has two — the P-based XOR (all members but the bad one and Q), and, if
 * that fails arbitration because P is ALSO damaged, the Q syndrome solve which
 * never touches P. RAID1's candidates are the surviving legs themselves.
 *
 * The plan is what keeps a kicked member from being READ (D7): its device path
 * is still in the geometry, and reading it returns that disk's stale bytes
 * rather than an error.
 */
async function reconstruct(
  executor: CommandExecutor,
  geo: MdGeometry,
  target: MemberLocation,
  plan: ReconstructionPlan,
): Promise<Candidate[]> {
  if (geo.raid1) {
    const out: Candidate[] = []
    for (const leg of plan.mirrors) {
      const device = geo.members[leg] as string
      out.push({
        bytes: await readDirect(executor, device, memberOffsetOn(geo, target, leg), BLOCK_BYTES),
        how: 'mirror',
        detail: `the copy on ${device}`,
      })
    }
    return out
  }

  const stripe = target.stripe as number
  const row = async (member: number): Promise<Buffer> => {
    const device = geo.members[member] as string
    return readDirect(executor, device, memberOffsetOn(geo, target, member), BLOCK_BYTES)
  }

  if (!geo.raid6) {
    if (!plan.pXor)
      return []
    const candidate = Buffer.alloc(BLOCK_BYTES)
    for (let i = 0; i < geo.raidDisks; i++) {
      if (i === target.memberIndex)
        continue
      xorInto(candidate, await row(i))
    }
    return [{
      bytes: candidate,
      how: 'xor',
      detail: `the XOR of the other ${geo.raidDisks - 1} members of stripe ${stripe}`,
    }]
  }

  const qIndex = target.qIndex as number
  const out: Candidate[] = []

  if (plan.pXor) {
    const pXor = Buffer.alloc(BLOCK_BYTES)
    for (let i = 0; i < geo.raidDisks; i++) {
      if (i === target.memberIndex || i === qIndex)
        continue
      xorInto(pXor, await row(i))
    }
    out.push({
      bytes: pXor,
      how: 'p-xor',
      detail: `the P parity of stripe ${stripe} and its other data members`,
    })
  }

  if (plan.qSyndrome) {
    const order = stripeDataOrder(geo, stripe)
    const dataBlocks: (Buffer | null)[] = []
    for (let d = 0; d < order.length; d++)
      dataBlocks.push(order[d] === target.memberIndex ? null : await row(order[d]))
    const qBytes = await row(qIndex)
    const missing = target.dataIndex ?? order.indexOf(target.memberIndex)
    out.push({
      bytes: reconstructFromQ(dataBlocks, qBytes, missing),
      how: 'q-syndrome',
      detail: `the Q syndrome of stripe ${stripe} (P not consulted)`,
    })
  }

  return out
}

/**
 * The roles whose recorded md bad-block list covers the ROW the target block
 * sits in (seventh pass, F8).
 *
 * The row is the same per-member span on every role of a parity stripe, so the
 * question is asked at each role's OWN offset (`memberOffsetOn` — data offsets
 * are allowed to differ). On RAID1 the legs are the roles, and the same test
 * answers for them.
 */
function badBlockRoles(geo: MdGeometry, target: MemberLocation, absent: readonly number[] = []): { roles: number[], unknown: number[] } {
  const roles: number[] = []
  const unknown: number[] = []
  for (let role = 0; role < geo.raidDisks; role++) {
    // A role md has kicked is absent for the plan already, and the kernel
    // removed its rd<n> with it: its list is nobody's fact.
    if (geo.members[role] === null || absent.includes(role))
      continue
    const covered = memberHasBadBlock(geo, role, memberOffsetOn(geo, target, role))
    // cr3 AHR-HEAL-L9 — null is "this node could not read the list", which
    // the caller refuses on; it is never "clean".
    if (covered === null)
      unknown.push(role)
    else if (covered)
      roles.push(role)
  }
  return { roles, unknown }
}

/** Every role's md bad-block list, read NOW (cr3 review item 4); null where it could not be read. */
async function readBadBlockLists(geo: MdGeometry): Promise<MdGeometry['badBlocks']> {
  const out: MdGeometry['badBlocks'] = []
  for (let role = 0; role < geo.raidDisks; role++)
    out.push(parseBadBlocks(await readMdAttrOrNull(geo.sys, `rd${role}/bad_blocks`)))
  return out
}

/*
 * The two verdicts that rest on the same evidence (cr3.sentences): every copy
 * the array holds of the block gives the same bytes, and those bytes fail the
 * stored checksum. `array-rebuilds-rot` (md counts a mismatch elsewhere in its
 * window) and `above-md` (md counts none) each say BOTH facts: there is no
 * good copy to restore from on the array, and the bytes were already wrong
 * when md wrote them. The wording was approved 2026-11-14 and changed by
 * cr3.heal.paths (coordinator decision 1): "the controller or software" had no
 * path to check, "unless the checksum record is what is wrong" had no check
 * (a restore rewrites both), and the result is final, so it says so and names
 * the one test the reader can run. The closing sentences are shared, word
 * for word.
 */
export const MEMORY_TEST_SENTENCE = 'Test the node\'s memory with memtest86+ (a boot menu entry where the package is installed)'
const FINAL_AGREEING_BAD_SENTENCES = 'No copy on the array holds a good version of this block, so nothing was written, and this result is final. '
  + `${MEMORY_TEST_SENTENCE}, then restore the file from a backup if one exists.`

/**
 * The `array-rebuilds-rot` sentence (cr3 review item 1) — what was read, and
 * why a rerun cannot change it. `mdMismatch` is md's bounded-check count.
 */
function arrayRebuildsRotSentence(file: string, block: number, shape: 'parity' | 'mirror', directDetail: string, mdMismatch: number): string {
  const copies = shape === 'parity'
    ? 'rebuilding this row from parity gives the same bytes'
    : 'every mirror leg holds the same bytes'
  return `${file} block ${block} fails its stored checksum, and ${copies} `
    + `(${directDetail}; md's check counts ${mdMismatch} mismatch(es) elsewhere in its window), `
    + `so they were already wrong when md wrote them. ${FINAL_AGREEING_BAD_SENTENCES}`
}

/**
 * The `above-md` sentence — md counts no mismatch AND the direct read says the
 * copies agree (GT-23: only both readings together carry this verdict, so "no
 * mismatch" is exactly what {@link parityAgreement} returned `consistent` on).
 * `where` is the stripe number on a parity band, the md device on a mirror.
 */
function aboveMdSentence(file: string, block: number, shape: 'parity' | 'mirror', where: string, directDetail: string): string {
  const reading = shape === 'parity'
    ? `parity agrees with those bytes (md's check over stripe ${where} counts no mismatch and ${directDetail})`
    : `the mirror legs agree with each other and with those bytes (md's check over ${where} counts no mismatch and ${directDetail})`
  return `${file} block ${block} fails its stored checksum, and ${reading}, `
    + `so they were already wrong when md wrote them. ${FINAL_AGREEING_BAD_SENTENCES}`
}

/** What to say about the bad-blocked members — the operator's own sentence. */
function badBlockNote(geo: MdGeometry, roles: number[]): string {
  const names = roles.map(role => geo.members[role] ?? `role ${role}`).join(', ')
  return `md has recorded bad blocks over this row on ${names} — md reconstructs nothing from a member's recorded bad-block range, so it counts as absent here. Replace that member.`
}

/**
 * The parity residual a repaired block left behind (F2), named the way the
 * Scrubs screen names bands.
 *
 * The band INDEX is what a `parityMismatches` row is keyed on, and it comes
 * from the pool's own topology by kernel name — `AhrArray.kernelName` is the
 * transient `mdN` sysfs key, which is exactly what the engine resolved the band
 * to through the dm table. It is deliberately not persisted anywhere: both
 * sides read it live, in the same run.
 */
function parityResidualOf(geo: MdGeometry, mismatchCnt: number, pool: AhrPool | null): SelfhealParityResidual {
  const array = pool?.arrays.find(a => a.kernelName === geo.kernel || a.device === geo.device)
  return {
    array: geo.device,
    band: array && pool ? `${pool.name}-r${array.band}` : geo.kernel,
    bandIndex: array ? array.band : null,
    mismatchCnt,
  }
}

/**
 * Re-read the REPAIRED block cold and check it against the checksum btrfs
 * stored for it (F2).
 *
 * This is the proof that separates "the block is fine and the band's parity is
 * not" from "neither is", and it is asked only after a post-check came back
 * non-zero over a block that was already written.
 *
 * TWO readings, and the first one that can run is the answer:
 *
 *  - through the PIN, which is the strongest form of the question — a fresh
 *    snapshot's inodes have no page cache behind them, btrfs verifies the
 *    stored csum on every read, and an EIO from it IS a checksum failure
 *    (GT-9a). Same reading the clean path takes, so one mechanism decides.
 *  - failing that (a §12 pool whose top-level mount a backup is holding, S2),
 *    the MEMBER is read directly at the repaired offset and the bytes are
 *    arbitrated against the stored csum — the same arbitration the candidate
 *    won, taken again off the disk after `drop_caches`.
 *
 * What it must never do is answer "proven" on a read it could not take.
 */
async function coldVerify(
  executor: CommandExecutor,
  pin: Pin,
  resolved: ResolvedBlock,
  sector: number,
  storedCsum: number,
): Promise<{ ok: boolean, detail: string }> {
  const cold = await coldRead(executor, pin, resolved)
  if (cold.ran) {
    return cold.bad.length === 0
      ? { ok: true, detail: 'the block reads back clean through a fresh snapshot, so btrfs verifies its stored checksum' }
      : { ok: false, detail: `the block still reads back with an error through a fresh snapshot (blocks ${cold.bad.join(', ')})` }
  }
  const location = resolved.sectors[sector]
  const geo = location.geometry
  const leg = geo.raid1 ? location.mirrors[0] ?? location.memberIndex : location.memberIndex
  const device = geo.members[leg] ?? location.memberDevice
  const bytes = await readDirect(executor, device, memberOffsetOn(geo, location, leg), BLOCK_BYTES)
  const value = crc32c(bytes)
  return value === storedCsum
    ? { ok: true, detail: `the cold read through the snapshot could not run (${cold.reason}), so the block was re-read straight off ${device} and matches the stored csum ${csumHex(storedCsum)}` }
    : { ok: false, detail: `the cold read through the snapshot could not run (${cold.reason}) and the block re-read straight off ${device} does NOT match the stored csum ${csumHex(storedCsum)} (read ${csumHex(value)})` }
}

/**
 * Read the repaired region back through the FRESH SNAPSHOT, cold.
 *
 * The snapshot's inodes are the cold-read guarantee — a warm page of the live
 * file would answer from memory and hide everything (GT-9a: a live buffered
 * read of a corrupt block SUCCEEDS while the snapshot path EIOs). `drop_caches`
 * and O_DIRECT are defense in depth on top of that. For a compressed extent
 * the whole logical extent is read: one corrupt on-disk sector takes out all
 * 128 KiB of it, so the block alone would not prove anything.
 */
async function coldRead(
  executor: CommandExecutor,
  pin: Pin,
  resolved: ResolvedBlock,
): Promise<ColdReadResult> {
  await dropCaches(executor)
  const span = resolved.extent.length ?? resolved.extent.ram ?? BLOCK_BYTES
  const blocks = resolved.compressed
    ? Array.from(
        { length: Math.ceil(span / BLOCK_BYTES) },
        (_, i) => Math.floor(resolved.extent.fileOffset / BLOCK_BYTES) + i,
      )
    : [resolved.block]
  return pin.coldRead(blocks)
}

/**
 * The resolved chain, flattened for the outcome's audit trail.
 *
 * `sector` is which on-disk sector of the repair unit it describes: the first
 * one until the re-verify says which is corrupt, and the TARGET's from then on.
 * A compressed blob straddling a band boundary has its sectors on two arrays,
 * and an audit trail that names the wrong one is worse than none (F5).
 */
function mappingOf(resolved: ResolvedBlock, sector = 0): SelfhealMapping {
  const first = resolved.sectors[sector]
  const geo = first.geometry
  return {
    level: geo.level,
    raidDisks: geo.raidDisks,
    chunkBytes: geo.chunkBytes,
    layout: geo.layout,
    dataOffset: geo.dataOffsets[first.memberIndex],
    logicalByte: resolved.logicalByte,
    blobLogical: resolved.blobLogical,
    blobSectors: resolved.blobSectors,
    compressed: resolved.compressed,
    chunkLogical: first.chunkLogical,
    chunkDevice: first.chunkDevice,
    lvByte: first.lvByte,
    startSector: first.startSector,
    mdByte: first.mdByte,
    memberIndex: first.memberIndex,
    memberDevice: first.memberDevice,
    memberOffset: first.memberOffset,
    parityIndex: first.parityIndex,
    qIndex: first.qIndex,
    stripe: first.stripe,
  }
}

/** An error's message, without a stack, for a field an operator reads. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
