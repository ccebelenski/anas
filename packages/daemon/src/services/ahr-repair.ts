import type { AhrArray, AhrMetadataCorrected, AhrPool, AhrRepairBlockOutcome, AhrRepairFile, AhrRepairFileOutcome, AhrRepairResult, AhrScrubParityMismatch, IscsiHeldByLun } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { SelfhealRepairOptions } from './selfheal-repair.js'
import { AhrRepairResult as AhrRepairResultSchema, SELFHEAL_ARRAY_REBUILDS_ROT, SELFHEAL_CSUM_UNREADABLE, SELFHEAL_NO_CHECKSUM, SELFHEAL_RUN_STOPPED, SELFHEAL_WRITE_UNCONFIRMED } from '@anas/shared'
// One window reader, one sentence: the scrub owns them and the repair reuses
// them rather than growing second copies (single source of truth).
import { metadataCorrectedSentence, readCorrectedReads } from './ahr-scrub.js'
import { heldByLunOnce } from './iscsi-held.js'
import { pveNotify } from './pve-notify.js'
import { repairBlock, SelfhealRunError } from './selfheal-repair.js'

/**
 * The Repair-from-parity JOB (story selfheal.6) — the operator-triggered half
 * of the self-heal epic.
 *
 * The engine (`selfheal-repair.ts`) repairs ONE 4 KiB block. This is the job
 * around it: the files and blocks an operator picked out of a scrub's findings,
 * run strictly one at a time, with every verdict landing in one of FIVE honest
 * counts (repaired / unrepairable / above md / not corrupt at the mapped
 * location — review R9 — / not examined at all — seventh pass, F3) and one PVE
 * notification at the end.
 *
 * It also carries out one fact the engine discovers and nothing else could: a
 * block that was repaired and PROVEN while its band still counts mismatching
 * stripes leaves a parity residual (F2), reported in the same row shape a
 * scrub's `parityMismatches` uses so Rewrite parity can act on it without
 * waiting hours for a fresh two-phase scrub.
 *
 * Two boundaries from the epic hold here and are not negotiable:
 *   - repair is NEVER automatic — this service only ever runs from the
 *     confirm-gated route, on a named file, with named blocks;
 *   - repair is NEVER a read-path heal — nothing in ANAS repairs a block
 *     because someone read it.
 *
 * **Strictly sequential.** Two repairs at once would fight over the same md
 * knobs (`rmw_level`, `sync_min`/`sync_max`, `stripe_cache_size`) and over the
 * bounded check each one needs to finish before the next begins. The engine
 * saves and restores those knobs around its own run, which is only sound while
 * exactly one run is in flight.
 *
 * **A thrown block is never a failed job — and never restore advice** (cr3
 * AHR-HEAL-H1). The engine returns its verdicts and throws only on an internal
 * failure. If block 3 of 50 dies on a btrfs lookup, the other 49 still deserve
 * their attempt — the error text becomes that block's reason and the job
 * carries on. What the thrown block IS depends on the phase the engine reached:
 * past the write it is `repaired` with the confirmation skipped (the bytes
 * that went through md were arbitrated against the stored csum first); before
 * it, `not-examined` / `run-stopped` — nothing was written and nothing was
 * decided. It used to be `unrepairable`, the one bucket that says "restore
 * this file from backup". The job fails only if something outside the
 * per-block loop does.
 */

/** The engine call this job makes — injectable so a test can fake the verdicts. */
export type RepairBlockFn = typeof repairBlock

export interface AhrRepairOptions {
  /** The repair engine. Defaults to the real one; tests hand in a fake. */
  repair?: RepairBlockFn
  /** Passed straight through to the engine (tests point its runtime dir at a temp path). */
  repairOptions?: SelfhealRepairOptions
  /**
   * Does an iSCSI LUN back this file (design review 2026-09-14, D10)? Defaults
   * to the ONE claims helper (`heldByLunOnce`, the same configfs read every
   * other gate uses) with the file as the subject — a claim whose backing
   * path IS the file means the block under repair is a LUN image. Fail-open:
   * an unreadable configfs answers "not a LUN" and the ordinary restore
   * advice stands. Tests hand in a fake; a caller may inject the lookup to
   * share one claims read across a whole request.
   */
  lunHeld?: (path: string) => Promise<IscsiHeldByLun | null>
}

/** Files listed in the notification body before it says "…and N more". */
const NOTIFY_FILE_LIMIT = 20

/**
 * The cause above the disks (GT-5/GT-6), said once per job for every block
 * whose copies on the array all agree on bytes that fail their checksum —
 * `above-md` and `array-rebuilds-rot` alike (cr3.sentences: the two verdicts
 * rest on the same evidence, and each block's own sentence carries this too).
 * "Point to", never a certainty: md only reports that the copies agree.
 */
const ABOVE_DISKS_SENTENCE = 'Disks that agree on bytes that fail their checksum point to a cause above the disks: '
  + 'memory, the controller or software. Check those before trusting new writes.'

/**
 * Unrepairable wording (design review 2026-09-14, D10) — there is one action
 * left, and WHICH one depends on what the file is:
 *
 *  - the ordinary case: a file restore;
 *  - an iSCSI LUN image: restoring "the file" in place is a LUN restore — a
 *    different verb, refused while a session is live — so the advice names
 *    the LUN and the two honest sources for it;
 *  - a `csum-unreadable` block (the D3 code): there was nothing to arbitrate
 *    against YET — the metadata holding the checksum is itself damaged, and
 *    metadata is DUP, so a btrfs scrub repairs its copies. Restore advice
 *    here would overwrite data whose corruption was never confirmed.
 */
const RESTORE_FILE_SENTENCE = 'restore this file from backup'
const CSUM_UNREADABLE_SENTENCE = 'the file\'s checksum could not be read reliably. '
  + 'Re-scrub after the metadata is repaired. A btrfs scrub repairs metadata copies'

/**
 * `array-rebuilds-rot` (cr3 review item 1) and `above-md` (cr3.sentences): the
 * block was read, fails its checksum, and every copy the array holds of it
 * gives the same bytes. A restore IS the advice — with the reason, and "if one
 * exists", because a rerun cannot change it and the checksum record itself may
 * be what is wrong. The clauses are the per-block sentence's own.
 */
const ARRAY_REBUILDS_ROT_CAUSE = 'every copy the array holds of this block gives the same failing bytes, '
  + 'so the repair cannot fix it and running it again will not change that. '
  + 'The file is damaged at this block unless the checksum record is what is wrong'
const ARRAY_REBUILDS_ROT_SENTENCE = `${ARRAY_REBUILDS_ROT_CAUSE}: restore this file from a backup if one exists`

function lunRestoreSentence(held: IscsiHeldByLun): string {
  return `this block backs iSCSI LUN ${held.targetIqn}/${held.index}. Restore the LUN image `
    + `from a PBS backup (Backup → Restore as new LUN) or the guest's own backup`
}

/**
 * A csum-unreadable block that is ALSO a LUN image (sixth pass, N5).
 *
 * The two facts are not the same kind of fact. "This is a LUN" says which
 * restore verb would apply; "the checksum could not be read" says a restore is
 * the WRONG ACTION — nothing has confirmed the block is corrupt, and restoring
 * would overwrite data on no evidence. The code used to test LUN-ness first, so
 * a LUN file whose unrepairable blocks were all `csum-unreadable` was told to
 * restore the LUN anyway. Csum-unreadable wins; the LUN identity rides along
 * because the operator still needs to know what the file is, and it is stated
 * without a restore verb.
 */
function csumUnreadableLunSentence(held: IscsiHeldByLun): string {
  return `this block backs iSCSI LUN ${held.targetIqn}/${held.index}, and ${CSUM_UNREADABLE_SENTENCE}`
}

/**
 * Mapping-abort wording (selfheal.7 live proof, F2; its own count since
 * review R9 — no longer folded into `unrepairable`).
 *
 * A `mapping-abort` means the OPPOSITE of `unrepairable`. The bytes at the
 * computed member location still pass the checksum btrfs stored for them, so
 * there is nothing wrong with the block and nothing was written. Telling the
 * operator to restore that file from backup is advice to overwrite good data,
 * so it gets its own count and its own sentence.
 */
const MAPPING_ABORT_SENTENCE = 'Blocks reported "not corrupt here" were left alone: the bytes on '
  + 'the member still pass their stored checksum, so there was nothing to reconstruct. Either '
  + 'the block was already repaired or the finding no longer describes it. Nothing was written, '
  + 'and they need no restore.'

/**
 * What each `not-examined` reason code means, and what would have to change
 * before a re-scrub could say anything (seventh pass, F3/F9/F11).
 *
 * The bucket exists because every one of these used to be reported with the
 * mapping-abort sentence above, which asserts a POSITIVE fact about the bytes.
 * That sentence is true of exactly one case — the re-verify READ the block and
 * it passed — and false of all of these: nothing here was examined at all, and
 * some of them are reachable on any ANAS-created LUN (`hole`: every LUN image
 * is created sparse with `ftruncate`).
 *
 * Each entry is the clause after "re-scrub after" — what would make the block
 * examinable, never a promise that it is fine.
 */
const NOT_EXAMINED_ADVICE: Record<string, string> = {
  'inline-extent': 'the file is rewritten so its tail is no longer stored in the metadata tree. An inline extent has no on-disk location to read, arbitrate or write',
  'hole': 'the range has been written. A hole has nothing on disk, and every LUN image ANAS creates is sparse, so a hole says nothing about the LUN\'s data',
  'owner-scan-truncated': 'the extent has fewer references: the back-reference scan hit its bound, so it lists only part of this file\'s extents in that stripe',
  'band-unreadable': 'the band\'s md geometry can be read again: the array was not answering when the lookup ran',
  'unresolvable': 'the mapping and the array agree again. Nothing about this block was established',
  'inode-changed': 'a fresh scrub has named the file that is at this path now. The file the finding describes is not the file at that path',
  [SELFHEAL_RUN_STOPPED]: 'the cause in the reason has passed (the array is idle and complete, the lookup or read that failed answers again). Then run the repair again',
  [SELFHEAL_WRITE_UNCONFIRMED]: 'the next scrub: if it still names this block, run the repair again',
  [SELFHEAL_NO_CHECKSUM]: 'Scrub again: a block that still fails its checksum is named again, and a file with no checksums is never named',
}

/** The not-examined bucket's sentence for one block, with its own reason. */
function notExaminedSentence(reasonCode: string | undefined, reason: string): string {
  const advice = (reasonCode && NOT_EXAMINED_ADVICE[reasonCode]) ?? NOT_EXAMINED_ADVICE.unresolvable
  // `run-stopped` (cr3 AHR-HEAL-H1): the block may have been READ — the run
  // stopped before a verdict, which is a different sentence from "never
  // looked at", and it ends in running the repair again, not in a re-scrub.
  // `write-unconfirmed` (cr3 review item 6): the write was issued and failed
  // to confirm — "nothing was written" is exactly the sentence it must not get.
  if (reasonCode === SELFHEAL_WRITE_UNCONFIRMED) {
    return `${reason} Wait for ${advice}.`
  }
  // `no-checksum` (cr3 second review 5(a)): a stale finding or a file with no
  // checksums — the advice is a scrub, never a restore.
  if (reasonCode === SELFHEAL_NO_CHECKSUM)
    return `${reason} ${advice}.`
  if (reasonCode === SELFHEAL_RUN_STOPPED) {
    return `the repair of this block stopped before it reached a verdict (${reason}). `
      + `Nothing was written, and this is not a verdict on the file's bytes. Wait until ${advice}. `
      // cr3 second review 5(b): `run-stopped` also covers causes waiting does
      // not cure — say what a repeat means.
      + 'If a second run stops with the same reason, it will not pass by waiting: the cause is the one named (a member that cannot be read, a btrfs tree btrfs-progs cannot walk, a snapshot that cannot be taken) and it needs looking at directly.'
  }
  return `this block could not be examined: ${reasonCode ?? 'unresolvable'} (${reason}). `
    + `Nothing was written, and nothing is known about this file's bytes. Re-scrub after ${advice}.`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The band's md level, for the `parityMismatches` row a residual becomes.
 *
 * It rides because the row's consumers branch on it: a RAID1 band is never
 * offered Rewrite parity (N1), and a row that cannot say which level it is must
 * not be offered the verb either. Absent when the pool has no such band.
 */
function arrayLevelOf(pool: AhrPool, bandIndex: number): AhrArray['level'] | undefined {
  return pool.arrays.find(a => a.band === bandIndex)?.level
}

/** One file's line in the notification body: what happened to its blocks. */
function fileLine(file: AhrRepairFileOutcome): string {
  const counts = new Map<string, number>()
  for (const b of file.blocks)
    counts.set(b.outcome, (counts.get(b.outcome) ?? 0) + 1)
  const parts: string[] = []
  for (const [outcome, n] of counts)
    parts.push(`${n} ${outcome}`)
  return `  ${file.path}: ${parts.join(', ')}`
}

/**
 * The notification body: the counts, then the files, then — only when they
 * apply — the sentences that say what the operator does next. Unrepairable
 * advice is PER FILE (D10): the same bucket can hold a plain data file, a LUN
 * image and a csum-unreadable block, and the one sentence "restore this file
 * from backup" was wrong for two of the three.
 */
function repairBody(
  pool: string,
  result: AhrRepairResult,
  restoreFiles: { path: string, advice: string }[],
  notExaminedFiles: { path: string, advice: string }[],
  unconfirmedFiles: { path: string, count: number }[] = [],
): string {
  const head = `Repair from parity on AHR pool '${pool}': `
    + `${result.repaired} repaired, ${result.unrepairable} unrepairable, `
    + `${result.aboveMd} above md, ${result.mappingAbort} not corrupt at the mapped location, `
    + `${result.notExamined} not examined, `
    + `of ${result.blocks} block(s) in ${result.files.length} file(s).`
  const lines = result.files.slice(0, NOTIFY_FILE_LIMIT).map(fileLine)
  if (result.files.length > NOTIFY_FILE_LIMIT)
    lines.push(`  …and ${result.files.length - NOTIFY_FILE_LIMIT} more`)
  const tail: string[] = []
  // Each bucket reads ITS OWN count (review R9) — "restore from backup" rides
  // only the true `unrepairable` and (cr3.sentences) `above-md`, never the
  // mapping-aborts that mean the block was fine all along.
  if (restoreFiles.length > 0) {
    const advice = restoreFiles.slice(0, NOTIFY_FILE_LIMIT)
      .map(f => `  ${f.path}: ${f.advice}`)
    if (restoreFiles.length > NOTIFY_FILE_LIMIT)
      advice.push(`  …and ${restoreFiles.length - NOTIFY_FILE_LIMIT} more`)
    const which = result.unrepairable > 0 && result.aboveMd > 0
      ? 'Unrepairable and above-md blocks'
      : result.aboveMd > 0 ? 'Above-md blocks' : 'Unrepairable blocks'
    tail.push(`${which} have no source of truth left below the checksum tree. `
      + `What to restore, per file:\n${advice.join('\n')}`)
  }
  if (result.mappingAbort > 0)
    tail.push(MAPPING_ABORT_SENTENCE)
  // The not-examined bucket gets its own paragraph and its own per-file reason
  // (seventh pass, F3): "nothing was written" is all these blocks share, and
  // the reason is the only thing that says what a re-scrub would need.
  if (result.notExamined > 0) {
    const advice = notExaminedFiles.slice(0, NOTIFY_FILE_LIMIT).map(f => `  ${f.path}: ${f.advice}`)
    if (notExaminedFiles.length > NOTIFY_FILE_LIMIT)
      advice.push(`  …and ${notExaminedFiles.length - NOTIFY_FILE_LIMIT} more`)
    const anyUnconfirmed = result.files.some(f => f.blocks.some(b => b.reasonCode === SELFHEAL_WRITE_UNCONFIRMED))
    tail.push(`${anyUnconfirmed
      ? 'Blocks below reached no verdict. Those that could not be EXAMINED were not written; a block whose write could not be confirmed may have been. '
      : 'Blocks that could not be EXAMINED were not written, and nothing is known about their bytes. '
    }This is neither a clean bill of health nor a reason to restore:\n${advice.join('\n')}`)
  }
  // cr3.sentences: above md, or rebuilt by the array as the same failing
  // bytes — the same evidence, so the same cause, said once for the job.
  const agreeingBad = result.files.reduce((n, f) => n + f.blocks.filter(b => b.outcome === 'above-md'
    || (b.outcome === 'unrepairable' && b.reasonCode === SELFHEAL_ARRAY_REBUILDS_ROT)).length, 0)
  if (agreeingBad > 0) {
    tail.push(`Every copy the array holds of ${agreeingBad} block(s) gives the same bytes, and those bytes fail `
      + `the stored checksum. Nothing was written to them. ${ABOVE_DISKS_SENTENCE}`)
  }
  // cr3 review item 5 — written with bytes proven against the stored
  // checksum, but the confirmation after the write never ran.
  if (unconfirmedFiles.length > 0) {
    const lines = unconfirmedFiles.slice(0, NOTIFY_FILE_LIMIT).map(f => `  ${f.path}: ${f.count} block(s)`)
    if (unconfirmedFiles.length > NOTIFY_FILE_LIMIT)
      lines.push(`  ...and ${unconfirmedFiles.length - NOTIFY_FILE_LIMIT} more`)
    tail.push('Blocks were written with bytes proven against their stored checksum, but the confirmation after the write '
      + `(post-check, cold read) did not complete. Re-scrub the pool to confirm them:\n${lines.join('\n')}`)
  }
  // selfheal.12 — metadata (DUP) copies btrfs corrected from their mirror
  // during THIS run's window. Said here like every other fact the run
  // discovered, and only when the count is above zero.
  if (result.metadataCorrected && result.metadataCorrected.count > 0)
    tail.push(metadataCorrectedSentence(result.metadataCorrected))
  // F2 — a repaired block whose band still counts a parity mismatch. The file
  // is right; the band's parity is not, and Rewrite parity is the verb for it.
  // Said here so the operator does not have to wait hours for a fresh two-phase
  // scrub to rediscover a residual this run already measured.
  if (result.parityResiduals.length > 0) {
    const bands = result.parityResiduals
      .map(r => `  ${r.band} (${r.array}): mismatch_cnt ${r.mismatchCnt}`)
    tail.push('Blocks were repaired and PROVEN against their stored checksum, and md still counts'
      + ' mismatching stripes on their band. The data is right, and the parity (or Q) member is'
      + ` what disagrees. Run Rewrite parity on:\n${bands.join('\n')}`)
  }
  return [`${head}\n\nFiles:\n${lines.join('\n')}`, ...tail].join('\n\n')
}

/**
 * Repair the named blocks of the named files on one AHR pool.
 *
 * Returns the three-bucket result, validated against the shared schema before
 * it leaves (Principle 6), and emits exactly ONE PVE notification: `warning`
 * when anything came back unrepairable or above md, `info` when every block
 * was repaired.
 */
export async function repairAhrFiles(
  executor: CommandExecutor,
  pool: AhrPool,
  files: AhrRepairFile[],
  updateProgress: (message: string) => void,
  options?: AhrRepairOptions,
): Promise<AhrRepairResult> {
  const repair = options?.repair ?? repairBlock
  // The run's own start — the bound of the journal window the corrected
  // metadata reads (selfheal.12) are counted in at the end.
  const startedAt = new Date()
  // The LUN lookup (D10). Only asked for files that actually came back
  // unrepairable or above md — the buckets whose advice names a restore verb.
  const lunHeld = options?.lunHeld ?? (async (path: string): Promise<IscsiHeldByLun | null> => {
    try {
      return await heldByLunOnce(executor, { path })
    }
    catch {
      return null
    }
  })
  const total = files.reduce((n, f) => n + f.blocks.length, 0)
  const outcomes: AhrRepairFileOutcome[] = []
  /** Per-file restore advice for the notification (D10), in request order. */
  const restoreFiles: { path: string, advice: string }[] = []
  /** Per-file "what could not be examined, and why" (seventh pass, F3). */
  const notExaminedFiles: { path: string, advice: string }[] = []
  /** Per-file count of blocks written whose confirmation never ran (cr3 review item 5). */
  const unconfirmedFiles: { path: string, count: number }[] = []
  /**
   * Bands a repaired block left a parity/Q mismatch on (F2), by band label —
   * many blocks of one file live on one band, and the operator rewrites the
   * band once. The highest count seen wins: md's counter is the band's, not the
   * block's, and understating it would understate the work.
   */
  const residuals = new Map<string, AhrScrubParityMismatch>()
  let repaired = 0
  let unrepairable = 0
  let aboveMd = 0
  let mappingAbort = 0
  let notExamined = 0
  let done = 0

  for (const file of files) {
    const blocks: AhrRepairBlockOutcome[] = []
    for (const block of file.blocks) {
      done += 1
      updateProgress(`Repairing ${file.path} block ${block} (${done}/${total})`)
      let entry: AhrRepairBlockOutcome
      try {
        const outcome = await repair(
          executor,
          {
            mountpoint: pool.mountpoint,
            file: file.path,
            block,
            pool,
            // F11 — the finding's inode, when the caller carried it. The engine
            // stats the path before it pins anything and refuses a mismatch by
            // name; omitted, nothing changes.
            ...(file.inode !== undefined ? { inode: file.inode } : {}),
          },
          options?.repairOptions,
        )
        // The engine's reason CODE rides through untouched (D3/D10). It is the
        // one thing in the verdict a parser may key on — the job result, the
        // notification and the Scrubs window all tell a `csum-unreadable`
        // block from one that genuinely needs a restore by this field, never
        // by grepping the operator's sentence.
        entry = {
          block,
          outcome: outcome.outcome,
          reason: outcome.reason,
          ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
          ...(outcome.parityResidual ? { parityResidual: outcome.parityResidual } : {}),
          // cr3 review item 5: the confirmation that did not run rides the block.
          ...(outcome.postcheckSkipped ? { postcheckSkipped: outcome.postcheckSkipped } : {}),
        }
        // F2 — the residual is a fact about the BAND, rolled up so the result
        // can hand it on in the shape the Scrubs parity indicator and Rewrite
        // parity already read. A residual the engine could not tie to a band
        // index (the loop-device rigs, a pool the caller did not hand in) stays
        // on the per-block entry and is not promoted to a row: a
        // `parityMismatches` row with no band number names nothing.
        const residual = outcome.parityResidual
        if (residual && residual.bandIndex !== null) {
          const prior = residuals.get(residual.band)
          if (!prior || residual.mismatchCnt > prior.mismatchCnt) {
            residuals.set(residual.band, {
              band: residual.band,
              bandIndex: residual.bandIndex,
              array: residual.array,
              mismatchCnt: residual.mismatchCnt,
              ...(arrayLevelOf(pool, residual.bandIndex) ? { level: arrayLevelOf(pool, residual.bandIndex) } : {}),
            })
          }
        }
      }
      catch (error) {
        // The engine threw rather than reaching a verdict (cr3 AHR-HEAL-H1).
        // Classified by PHASE, and never into the restore bucket: a run that
        // had written its block wrote bytes proven against the stored csum, so
        // it is `repaired` with the confirmation skipped; a run that had not
        // reached the write decided nothing about the block. The remaining
        // blocks still get their attempt either way.
        const written = error instanceof SelfhealRunError ? error.written : null
        entry = written !== null
          ? {
              block,
              outcome: 'repaired',
              reason: `${written} — the block was written and matches its checksum; the run stopped before its confirmation (${errorText(error)}). Re-scrub to confirm parity.`,
              postcheckSkipped: errorText(error),
            }
          : { block, outcome: 'not-examined', reason: errorText(error), reasonCode: SELFHEAL_RUN_STOPPED }
      }
      // `mapping-abort` counts AS ITSELF (review R9) — it is not a repair, but
      // it is the opposite of `unrepairable`: the block was not corrupt at the
      // mapped location, nothing was written, nothing to restore. The
      // per-block entry keeps the outcome and its own reason either way.
      if (entry.outcome === 'repaired')
        repaired += 1
      else if (entry.outcome === 'above-md')
        aboveMd += 1
      else if (entry.outcome === 'mapping-abort')
        mappingAbort += 1
      else if (entry.outcome === 'not-examined')
        notExamined += 1
      else
        unrepairable += 1
      updateProgress(`${file.path} block ${block}: ${entry.outcome}`)
      blocks.push(entry)
    }
    outcomes.push({ path: file.path, blocks })
    const unconfirmed = blocks.filter(b => b.outcome === 'repaired' && b.postcheckSkipped !== undefined).length
    if (unconfirmed > 0)
      unconfirmedFiles.push({ path: file.path, count: unconfirmed })
    // Advice classification (D10), once per file that needs it. LUN-ness is a
    // property of the FILE (its blocks all live in the image); csum-unreadable
    // is per BLOCK — a file whose unrepairable blocks ALL carry the code gets
    // the re-scrub advice, a mixed one gets the ordinary restore advice
    // (which is still true of it: nothing else can prove those blocks).
    //
    // CSUM-UNREADABLE IS TESTED FIRST (sixth pass, N5). It is the one verdict
    // that says a restore is the wrong action — the checksum that would have
    // proven the block corrupt is itself damaged — so it outranks the question
    // of WHICH restore verb a LUN would need. The LUN identity is composed into
    // that sentence instead of replacing it.
    //
    // The classification reads `reasonCode`, not the reason TEXT: the sentence
    // is the operator's and may be reworded, the code is the contract.
    // The not-examined bucket's per-file line (F3). One sentence per distinct
    // reason code the file's blocks carried — the reason IS the advice, and a
    // file whose blocks failed for two different reasons deserves both.
    const notExaminedBlocks = blocks.filter(b => b.outcome === 'not-examined')
    if (notExaminedBlocks.length > 0) {
      const seen = new Set<string>()
      const sentences: string[] = []
      for (const b of notExaminedBlocks) {
        const key = b.reasonCode ?? 'unresolvable'
        if (seen.has(key))
          continue
        seen.add(key)
        sentences.push(notExaminedSentence(b.reasonCode, b.reason))
      }
      notExaminedFiles.push({ path: file.path, advice: sentences.join(' ') })
    }
    // cr3.sentences: an `above-md` block is on the restore list too. Every
    // copy the array holds of it agrees on the failing bytes, exactly as with
    // `array-rebuilds-rot`, so it takes that block's advice and its reason.
    const restoreBlocks = blocks.filter(b => b.outcome === 'unrepairable' || b.outcome === 'above-md')
    if (restoreBlocks.length > 0) {
      const held = await lunHeld(file.path)
      const allCsumUnreadable = restoreBlocks
        .every(b => b.reasonCode === SELFHEAL_CSUM_UNREADABLE)
      // cr3 review item 1: every restore-list block of the file is one the
      // array gives back as the same failing bytes — the restore says why.
      const allRebuildRot = restoreBlocks
        .every(b => b.outcome === 'above-md' || b.reasonCode === SELFHEAL_ARRAY_REBUILDS_ROT)
      restoreFiles.push({
        path: file.path,
        advice: allCsumUnreadable
          ? (held ? csumUnreadableLunSentence(held) : CSUM_UNREADABLE_SENTENCE)
          : allRebuildRot
            ? (held ? `${lunRestoreSentence(held)}, if one exists: ${ARRAY_REBUILDS_ROT_CAUSE}` : ARRAY_REBUILDS_ROT_SENTENCE)
            : held
              ? lunRestoreSentence(held)
              : RESTORE_FILE_SENTENCE,
      })
    }
  }

  // Band order, so the notification and the Scrubs window read bottom-up like
  // every other band list. Built fresh here, so sorting in place mutates
  // nothing anyone else holds.
  const residualRows = [...residuals.values()]
  residualRows.sort((a, b) => a.bandIndex - b.bandIndex)

  // selfheal.12 — the run's OWN window, read once at the end (the same helper
  // the scrub uses): a cold read here can trigger the same metadata
  // correction a scrub does, and the sentence rides this job's notification.
  // Fail-open: an unreadable journal costs the count, never the repair.
  let metadataCorrected: AhrMetadataCorrected | undefined
  try {
    const corrected = await readCorrectedReads(executor, pool, startedAt)
    if (corrected.count > 0)
      metadataCorrected = corrected
  }
  catch {
    // No count rather than an invented clean bill.
  }

  const result = AhrRepairResultSchema.parse({
    pool: pool.name,
    files: outcomes,
    repaired,
    unrepairable,
    aboveMd,
    mappingAbort,
    notExamined,
    parityResiduals: residualRows,
    ...(metadataCorrected ? { metadataCorrected } : {}),
    blocks: total,
  })

  // ONE notification, whatever the outcome — the operator asked for this and is
  // owed the answer even when the browser has moved on (a repair outruns the
  // UI's job-poll budget exactly as a scrub does). A mapping-abort block was
  // left exactly as it was — still not a repair, so the notification stays a
  // warning when any block ended unrepaired.
  // A parity residual is NOT a clean run either: the block is repaired, and the
  // band md counts mismatching stripes on still needs Rewrite parity.
  // cr3 review item 5: a block written whose confirmation never ran is not
  // a clean run either — the notification is a warning and says re-scrub.
  const unconfirmedCount = unconfirmedFiles.reduce((n, f) => n + f.count, 0)
  const unrepaired = unrepairable + aboveMd + mappingAbort + notExamined
  const clean = unrepaired === 0 && residuals.size === 0 && unconfirmedCount === 0
  await pveNotify(
    executor,
    clean ? 'info' : 'warning',
    clean
      ? 'AHR repair from parity completed'
      : unrepaired === 0 && residuals.size === 0
        ? 'AHR repair from parity completed; re-scrub to confirm'
        : 'AHR repair from parity left blocks unrepaired',
    repairBody(pool.name, result, restoreFiles, notExaminedFiles, unconfirmedFiles),
  )

  return result
}
