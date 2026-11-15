import type { AhrArray, AhrMetadataCorrected, AhrPool, AhrRepairBlockOutcome, AhrRepairFile, AhrRepairFileOutcome, AhrRepairResult, AhrScrubParityMismatch, IscsiHeldByLun } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { SelfhealRepairOptions } from './selfheal-repair.js'
import { AhrRepairResult as AhrRepairResultSchema, SELFHEAL_ARRAY_REBUILDS_ROT, SELFHEAL_CSUM_UNREADABLE, SELFHEAL_NO_CHECKSUM, SELFHEAL_RUN_STOPPED, SELFHEAL_WRITE_UNCONFIRMED } from '@anas/shared'
// One window reader, one sentence: the scrub owns them and the repair reuses
// them rather than growing second copies (single source of truth).
import { metadataCorrectedSentence, readCorrectedReads } from './ahr-scrub.js'
import { heldByLunOnce, heldHolderPhrase } from './iscsi-held.js'
import { pveNotify } from './pve-notify.js'
import { BAND_UNREADABLE_ADVICE, MEMORY_TEST_SENTENCE, repairBlock, REPORT_IT_ADVICE, SelfhealRunError } from './selfheal-repair.js'

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

/** Files listed in the notification body before it says "and N more". */
const NOTIFY_FILE_LIMIT = 20

/**
 * The cause above the disks (GT-5/GT-6), said once per job for every block
 * whose copies on the array all agree on bytes that fail their checksum —
 * `above-md` and `array-rebuilds-rot` alike (cr3.sentences: the two verdicts
 * rest on the same evidence, and each block's own sentence carries this too).
 *
 * cr3.heal.paths (coordinator decision 1): the result is final, so it says
 * so; memory is the one suspect the reader can test, so it names the test;
 * "the controller or software" and "unless the checksum record is what is
 * wrong" are gone (no path checks either, and a restore rewrites both the
 * data and its checksum).
 */
function agreeingBadSentence(blocks: number): string {
  return `Every copy the array holds of ${blocks} block(s) gives the same bytes, and those bytes fail their stored checksum: `
    + 'they were already wrong when md wrote them, so this result is final. Nothing was written to them. '
    + `${MEMORY_TEST_SENTENCE}, then restore the files listed above from a backup if one exists.`
}

/**
 * Restore-list wording (design review 2026-09-14, D10) — there is one action
 * left, and WHICH one depends on what the file is:
 *
 *  - the ordinary case: a file restore;
 *  - an iSCSI LUN image: restoring "the file" in place is a LUN restore — a
 *    different verb, refused while a session is live — so the advice names
 *    the LUN and the two honest sources for it;
 *  - a `csum-unreadable` block (the D3 code): the checksum that would judge the
 *    block could not be read, so nothing judged it. cr3.heal.paths: a scrub is
 *    the check that tells the two cases apart (it reads the same metadata and
 *    reports what it could not correct), and the sentence branches on what
 *    the reader sees in it.
 */
const RESTORE_FILE_SENTENCE = 'restore this file from backup'
const FILE_RESTORE_IF_ONE_EXISTS = 'restore this file from a backup if one exists'
// Review R3 (safety): the restore is reached only after the scrub named the
// file a second time AND the repair stopped at the same place again. "Errors
// that name no file" were the old test, and unrelated I/O errors pass it.
function csumUnreadableSentence(restore: string): string {
  return 'the checksum btrfs keeps for these blocks could not be read, so nothing judged them and nothing was written. '
    + 'Run a scrub (Scrubs → Run now). If it names this file again, run Repair from parity on it from that finding. '
    + 'If the repair stops here a second time, the checksum record is damaged and ANAS has no repair for it: '
    + `the scrub has named the file twice, so ${restore}. If the scrub does not name the file, nothing remains to do.`
}

/**
 * `array-rebuilds-rot` (cr3 review item 1) and `above-md` (cr3.sentences): the
 * block was read, fails its checksum, and every copy the array holds of it
 * gives the same bytes. A restore IS the advice, "if one exists" (operator-
 * approved), with the fact before it; the job paragraph says the cause.
 */
const ARRAY_REBUILDS_ROT_CAUSE = 'every copy the array holds of these blocks gives the same failing bytes'

function lunRestoreSentence(held: IscsiHeldByLun): string {
  // cr3.lunrestore: a backstore no LUN maps has no target and no index.
  if (held.unmapped === true) {
    return `this block backs ${heldHolderPhrase(held)} (an interrupted restore, or a LUN removed by hand). Restore the image `
      + `again from a PBS backup (Backup → Restore as new LUN) or the guest's own backup`
  }
  return `this block backs iSCSI LUN ${held.targetIqn}/${held.index}. Restore the LUN image `
    + `from a PBS backup (Backup → Restore as new LUN) or the guest's own backup`
}

/**
 * A csum-unreadable block that is ALSO a LUN image (sixth pass, N5).
 *
 * Csum-unreadable wins: nothing judged the block, so the restore is offered
 * only in the branch where the scrub shows the checksum record itself is
 * damaged, and then it is the LUN's restore. The LUN identity rides along so
 * the operator knows what the file is.
 */
function csumUnreadableLunSentence(held: IscsiHeldByLun): string {
  const restore = 'restore the LUN image from a PBS backup (Backup → Restore as new LUN) or the guest\'s own backup, if one exists'
  if (held.unmapped === true)
    return `this block backs ${heldHolderPhrase(held)}, and ${csumUnreadableSentence(restore)}`
  return `this block backs iSCSI LUN ${held.targetIqn}/${held.index}, and ${csumUnreadableSentence(restore)}`
}

/**
 * Mapping-abort wording (selfheal.7 live proof, F2; its own count since
 * review R9 — no longer folded into `unrepairable`).
 *
 * A `mapping-abort` means the bytes at the computed member location still
 * pass the checksum btrfs stored for them, so nothing was written. Two causes
 * fit (already repaired / a stale finding, or ANAS located the block wrongly),
 * and a scrub tells them apart: it names a block only when its checksum fails.
 */
function mappingAbortSentence(blocks: number): string {
  return `${blocks} block(s) pass their stored checksum where they sit on disk, so nothing was written to them. `
    + 'Run a scrub (Scrubs → Run now) to confirm them: a block that passes is no longer named. '
    + 'If the scrub names one again, ANAS located it wrongly: report it with this job\'s result.'
}

/**
 * What the reader does about each `not-examined` reason code (seventh pass,
 * F3/F9/F11; cr3.heal.paths). The engine's reason is the fact and ends
 * "Nothing was written."; this is the instruction after it, a full sentence
 * that starts with a verb. A rerun is offered only with what must change
 * first, or a scrub as a confirmation with its expected result.
 *
 * `run-stopped` has no entry: its causes differ by site, so each site's
 * reason carries its own instruction (coordinator decision 5).
 * `owner-scan-truncated` has none either: only the scrub's attribution raises
 * it (`extentsReferencing`, reached only from `extentsForStripe`, which only
 * `ahr-scrub.ts` calls); `resolveBlock` never does, so no repair carries it.
 */
const NOT_EXAMINED_ADVICE: Record<string, string> = {
  'inline-extent': 'Run a scrub (Scrubs → Run now) to refresh the findings: the extent the scrub named is no longer part of this file, and damage in the file now is named afresh.',
  'hole': 'Run a scrub (Scrubs → Run now) to refresh the findings: btrfs keeps no checksum for a hole.',
  'band-unreadable': BAND_UNREADABLE_ADVICE,
  'unresolvable': REPORT_IT_ADVICE,
  // Review R5: true of both branches (another file at the path, or none).
  'inode-changed': 'Run a scrub (Scrubs → Run now) and repair from what it names: the file the scrub named is no longer at this path.',
  [SELFHEAL_WRITE_UNCONFIRMED]: 'Run a scrub (Scrubs → Run now). If it no longer names this block, the write landed. '
    + 'If it names it again, run Repair from parity again once the AHR panel shows the band clean. '
    // Review R4: the rerun has a stop.
    + 'If the write fails again while the band shows clean, check that member\'s SMART data in Disks.',
  [SELFHEAL_NO_CHECKSUM]: 'Run a scrub (Scrubs → Run now) and repair from its findings.',
}

/** The not-examined bucket's sentence for one block, with its own reason. */
function notExaminedSentence(reasonCode: string | undefined, reason: string): string {
  // `run-stopped` (cr3 AHR-HEAL-H1): the run stopped before a verdict, and
  // the site that stopped it wrote the fact and what to do (coordinator
  // decision 5), so the wrapper adds nothing.
  if (reasonCode === SELFHEAL_RUN_STOPPED)
    return reason
  const advice = (reasonCode && NOT_EXAMINED_ADVICE[reasonCode]) ?? NOT_EXAMINED_ADVICE.unresolvable
  return `${reason} ${advice}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A sentence already ends here. */
const SENTENCE_END_RE = /[.!?]$/

/** A fragment closed as a sentence, without doubling its full stop. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return SENTENCE_END_RE.test(trimmed) ? trimmed : `${trimmed}.`
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
 * The residuals a run measured, split by what the verbs accept (cr3.heal.paths,
 * defects 7b/7c; review D1). Both evidence gates (`repairEvidence` in
 * ahr-parity-rewrite.ts and ahr-mirror-reconcile.ts) take a band only when md
 * counted the mismatch, and only from a run that left no block unrepaired,
 * above md or not examined. WHICH verb depends on the band's level: Rewrite
 * parity refuses a RAID1 band (`not-a-parity-band`), Reconcile mirror refuses
 * a parity band (`not-a-mirror-band`). A band whose level is not known is
 * offered neither: the Scrubs window does not offer one either.
 *
 * `uncounted`: bands a direct member read found inconsistent while md's check
 * counted 0 (GT-23's stale cache). They are never `parityResiduals` rows: a
 * row offers a verb, and both gates refuse a zero.
 */
type ResidualVerb = 'parity' | 'mirror' | 'unknown'

interface ResidualAdvice {
  counted: Record<ResidualVerb, AhrScrubParityMismatch[]>
  uncounted: Record<ResidualVerb, string[]>
  /** unrepairable + above md + not examined: what both gates refuse on. */
  unrepaired: number
}

function verbFor(level: AhrArray['level'] | undefined): ResidualVerb {
  if (level === 'raid1')
    return 'mirror'
  if (level === 'raid5' || level === 'raid6')
    return 'parity'
  return 'unknown'
}

function residualAdvice(result: AhrRepairResult, pool?: AhrPool): ResidualAdvice {
  const counted: ResidualAdvice['counted'] = { parity: [], mirror: [], unknown: [] }
  for (const r of result.parityResiduals.filter(r => r.mismatchCnt > 0))
    counted[verbFor(r.level)].push(r)
  const countedBands = new Set(result.parityResiduals.filter(r => r.mismatchCnt > 0).map(r => r.band))
  const uncounted: ResidualAdvice['uncounted'] = { parity: [], mirror: [], unknown: [] }
  const seen = new Set<string>()
  for (const f of result.files) {
    for (const b of f.blocks) {
      const r = b.parityResidual
      if (r && r.bandIndex !== null && r.mismatchCnt <= 0 && !countedBands.has(r.band) && !seen.has(r.band)) {
        seen.add(r.band)
        uncounted[verbFor(pool ? arrayLevelOf(pool, r.bandIndex) : undefined)].push(r.band)
      }
    }
  }
  return { counted, uncounted, unrepaired: result.unrepairable + result.aboveMd + result.notExamined }
}

/** The verb's name and where it lives, by the band's level. */
const VERB_NAME: Record<Exclude<ResidualVerb, 'unknown'>, string> = { parity: 'Rewrite parity', mirror: 'Reconcile mirror' }

/** The residual paragraphs: the verb each band's gate accepts now, and what comes first when it does not. */
function residualSentences(advice: ResidualAdvice): string[] {
  const out: string[] = []
  const first = advice.unrepaired > 0 ? 'Deal with the files above, run a scrub (Scrubs → Run now)' : 'Run a scrub (Scrubs → Run now)'
  const rowsOf = (list: AhrScrubParityMismatch[]): string => list.map(r => `  ${r.band} (${r.array}): mismatch_cnt ${r.mismatchCnt}`).join('\n')
  const facts: Record<Exclude<ResidualVerb, 'unknown'>, { clean: string, plain: string }> = {
    parity: {
      clean: 'The blocks on the bands below were repaired and proven cold against their stored checksum, and md still counts '
        + 'mismatching stripes there, so their parity (or Q) disagrees with the data.',
      plain: 'md still counts mismatching stripes on the bands below',
    },
    mirror: {
      clean: 'The blocks on the mirror bands below were repaired and proven cold against their stored checksum, and md still counts '
        + 'stripes there where the mirror legs differ.',
      plain: 'md still counts stripes where the mirror legs differ on the mirror bands below',
    },
  }
  for (const verb of ['parity', 'mirror'] as const) {
    const list = advice.counted[verb]
    if (list.length === 0)
      continue
    const name = VERB_NAME[verb]
    out.push(advice.unrepaired === 0
      ? `${facts[verb].clean} Run ${name} on each (Scrubs → the pool's parity mismatch → ${name}):\n${rowsOf(list)}`
      : `${facts[verb].plain}, and ${name} refuses while this run left blocks unrepaired, above md or not examined. `
        + `${first}, then run ${name} from that scrub's parity mismatch:\n${rowsOf(list)}`)
  }
  if (advice.counted.unknown.length > 0) {
    out.push('md still counts mismatching stripes on the bands below, and ANAS could not read their RAID level, so no verb is offered here. '
      + `${first}: its parity mismatch window offers the verb for each band:\n${rowsOf(advice.counted.unknown)}`)
  }
  if (advice.uncounted.parity.length > 0) {
    out.push(`A direct read found the parity (or Q) of ${advice.uncounted.parity.join(', ')} disagreeing with the repaired data, `
      + `and md's check counted no mismatch there. ${first} so md counts it, then run Rewrite parity from that scrub's parity mismatch.`)
  }
  if (advice.uncounted.mirror.length > 0) {
    out.push(`A direct read found the mirror legs of ${advice.uncounted.mirror.join(', ')} differing, `
      + `and md's check counted no mismatch there. ${first} so md counts it, then run Reconcile mirror from that scrub's parity mismatch.`)
  }
  if (advice.uncounted.unknown.length > 0) {
    out.push(`A direct read found ${advice.uncounted.unknown.join(', ')} inconsistent after the repair, and md's check counted no mismatch there. `
      + `${first} so md counts it, then run the verb its parity mismatch window offers for that band.`)
  }
  return out
}

/** Every band any residual names, counted or not. */
function residualBands(advice: ResidualAdvice): { counted: number, uncounted: number } {
  const n = (r: Record<ResidualVerb, unknown[]>): number => r.parity.length + r.mirror.length + r.unknown.length
  return { counted: n(advice.counted), uncounted: n(advice.uncounted) }
}

/**
 * The notification's title (cr3.heal.paths, defect 7a; review D1): "left
 * blocks unrepaired" only when a block was left unrepaired, above md or not
 * examined (a mapping-abort block passes its checksum where it sits, so it is
 * not one); otherwise the verb each counted band's gate accepts.
 */
function repairTitle(clean: boolean, advice: ResidualAdvice): string {
  if (clean)
    return 'AHR repair from parity completed'
  if (advice.unrepaired > 0)
    return 'AHR repair from parity left blocks unrepaired'
  const bands = residualBands(advice)
  if (bands.counted > 0 && advice.counted.unknown.length === 0) {
    const parts: string[] = []
    if (advice.counted.parity.length > 0)
      parts.push(`rewrite parity on ${advice.counted.parity.map(r => r.band).join(', ')}`)
    if (advice.counted.mirror.length > 0)
      parts.push(`reconcile mirror on ${advice.counted.mirror.map(r => r.band).join(', ')}`)
    return `AHR repair from parity completed: ${parts.join('; ')}`
  }
  if (bands.counted > 0 || bands.uncounted > 0) {
    const verbs: string[] = []
    if (advice.uncounted.parity.length > 0)
      verbs.push(`rewrite parity on ${advice.uncounted.parity.join(', ')}`)
    if (advice.uncounted.mirror.length > 0)
      verbs.push(`reconcile mirror on ${advice.uncounted.mirror.join(', ')}`)
    return verbs.length > 0 && advice.uncounted.unknown.length === 0 && advice.counted.unknown.length === 0
      ? `AHR repair from parity completed: run a scrub, then ${verbs.join('; ')}`
      : 'AHR repair from parity completed: run a scrub, then act on its parity mismatch'
  }
  return 'AHR repair from parity completed; run a scrub to confirm'
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
  residuals: ResidualAdvice,
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
    lines.push(`  and ${result.files.length - NOTIFY_FILE_LIMIT} more`)
  const tail: string[] = []
  // Each bucket reads ITS OWN count (review R9) — "restore from backup"
  // rides only the true `unrepairable` and (cr3.sentences) `above-md`, never the
  // mapping-aborts that mean the block was fine all along.
  if (restoreFiles.length > 0) {
    const advice = restoreFiles.slice(0, NOTIFY_FILE_LIMIT)
      .map(f => `  ${f.path}: ${f.advice}`)
    if (restoreFiles.length > NOTIFY_FILE_LIMIT)
      advice.push(`  and ${restoreFiles.length - NOTIFY_FILE_LIMIT} more`)
    tail.push('ANAS could not repair these blocks from the array. What to do, per file '
      + `(a file restore is Backup → the backup task → Restore, or Restore from repository):\n${advice.join('\n')}`)
  }
  if (result.mappingAbort > 0)
    tail.push(mappingAbortSentence(result.mappingAbort))
  // The not-examined bucket gets its own paragraph and its own per-file reason
  // (seventh pass, F3): the reason is the fact, the advice says what to do.
  if (result.notExamined > 0) {
    const advice = notExaminedFiles.slice(0, NOTIFY_FILE_LIMIT).map(f => `  ${f.path}: ${f.advice}`)
    if (notExaminedFiles.length > NOTIFY_FILE_LIMIT)
      advice.push(`  and ${notExaminedFiles.length - NOTIFY_FILE_LIMIT} more`)
    const anyUnconfirmed = result.files.some(f => f.blocks.some(b => b.reasonCode === SELFHEAL_WRITE_UNCONFIRMED))
    tail.push(`The repair reached no verdict on ${result.notExamined} block(s). ${anyUnconfirmed
      ? 'A block whose write could not be confirmed may have been written; nothing was written to the others. '
      : 'Nothing was written to them. '
    }What to do, per file:\n${advice.join('\n')}`)
  }
  // cr3.sentences: above md, or rebuilt by the array as the same failing
  // bytes — the same evidence, so the same cause, said once for the job.
  const agreeingBad = result.files.reduce((n, f) => n + f.blocks.filter(b => b.outcome === 'above-md'
    || (b.outcome === 'unrepairable' && b.reasonCode === SELFHEAL_ARRAY_REBUILDS_ROT)).length, 0)
  if (agreeingBad > 0)
    tail.push(agreeingBadSentence(agreeingBad))
  // cr3 review item 5 — written with bytes proven against the stored
  // checksum, but the confirmation after the write never ran.
  if (unconfirmedFiles.length > 0) {
    const lines = unconfirmedFiles.slice(0, NOTIFY_FILE_LIMIT).map(f => `  ${f.path}: ${f.count} block(s)`)
    if (unconfirmedFiles.length > NOTIFY_FILE_LIMIT)
      lines.push(`  and ${unconfirmedFiles.length - NOTIFY_FILE_LIMIT} more`)
    tail.push('These blocks were written with bytes that match their stored checksum; the check after the write did not finish. '
      + `Run a scrub (Scrubs → Run now) to confirm them: a confirmed block is no longer named.\n${lines.join('\n')}`)
  }
  // selfheal.12 — metadata (DUP) copies btrfs corrected from their mirror
  // during THIS run's window. Said here like every other fact the run
  // discovered, and only when the count is above zero.
  if (result.metadataCorrected && result.metadataCorrected.count > 0)
    tail.push(metadataCorrectedSentence(result.metadataCorrected, pool))
  // F2 — a repaired block whose band still counts a parity mismatch. The file
  // is right; the band's parity is not, and Rewrite parity is the verb for it
  // when its evidence gate will accept it (cr3.heal.paths, 7b/7c).
  tail.push(...residualSentences(residuals))
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
        // cr3.heal.paths (7b): a residual md counted 0 on is not promoted
        // either — a row offers Rewrite parity, whose gate refuses a zero.
        // The notification names the band with the scrub that comes first.
        const residual = outcome.parityResidual
        if (residual && residual.bandIndex !== null && residual.mismatchCnt > 0) {
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
              reason: `${written} — the block was written and matches its checksum; the run stopped before its confirmation (${errorText(error)}). Run a scrub (Scrubs → Run now) to confirm it.`,
              postcheckSkipped: errorText(error),
            }
          // cr3.heal.paths (coordinator decision 4): nothing names what a
          // rerun would change, so none is offered.
          : { block, outcome: 'not-examined', reason: `${asSentence(errorText(error))} Nothing was written. ${(error instanceof SelfhealRunError && error.advice) || REPORT_IT_ADVICE}`, reasonCode: SELFHEAL_RUN_STOPPED }
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
          ? (held ? csumUnreadableLunSentence(held) : csumUnreadableSentence(FILE_RESTORE_IF_ONE_EXISTS))
          : allRebuildRot
            ? `${ARRAY_REBUILDS_ROT_CAUSE}, and ${held ? `${lunRestoreSentence(held)}, if one exists` : `this result is final: ${FILE_RESTORE_IF_ONE_EXISTS}`}`
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
  // cr3.heal.paths (7a): the title reads the same split the advice does.
  const unconfirmedCount = unconfirmedFiles.reduce((n, f) => n + f.count, 0)
  const advice = residualAdvice(result, pool)
  const bands = residualBands(advice)
  const clean = advice.unrepaired === 0 && mappingAbort === 0 && bands.counted === 0
    && bands.uncounted === 0 && unconfirmedCount === 0
  await pveNotify(
    executor,
    clean ? 'info' : 'warning',
    repairTitle(clean, advice),
    repairBody(pool.name, result, advice, restoreFiles, notExaminedFiles, unconfirmedFiles),
  )

  return result
}
