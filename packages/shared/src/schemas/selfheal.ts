import { z } from 'zod'
import { AhrMetadataCorrected, AhrScrubFinding, AhrScrubParityMismatch } from './ahr.js'
import { AbsolutePath } from './common.js'

/**
 * Self-heal repair engine schemas (story selfheal.5).
 *
 * The engine is the userspace repair path where the btrfs csum ARBITRATES an
 * md reconstruction: md knows the parity group, btrfs knows what the bytes
 * should be. Everything the engine can say about one 4 KiB block is one of
 * four honest buckets — never "fixed, probably".
 *
 * The vocabulary here is shared because selfheal.6 (the confirm-gated repair
 * job) reports exactly these outcomes per file, and the CLI entry point that
 * drives the selfheal.2 loop-device suite writes the same object.
 */

/**
 * What the engine concluded about one block.
 *
 * - `repaired` — a candidate reconstructed from the other members passed the
 *   stored csum, was written back through md with the parity group rebuilt,
 *   the stripe re-checked clean, and the block read back cold through a fresh
 *   snapshot.
 * - `unrepairable` — there is no source of truth left below the csum tree for
 *   this block (two bad blocks in one stripe, an extent with no csum at all,
 *   a post-check that did not come back clean). Restore from backup.
 * - `above-md` — the stripe's parity AGREES with the bad data, so the
 *   corruption did not arrive from a disk. Nothing is written. The wording is
 *   deliberately "points to a cause above the disks", never a certainty: md
 *   only reports that parity and data are consistent. No copy on the array
 *   holds a good version, so the file is restored from a backup if one exists
 *   (cr3.sentences: the same advice `array-rebuilds-rot` gets).
 * - `mapping-abort` — the bytes at the computed member location were READ and
 *   still pass their stored csum. Either the mapping is wrong or the block was
 *   already repaired; either way the engine refuses to write. "Not corrupt
 *   here." It is the one verdict that asserts a POSITIVE fact about the bytes,
 *   so it is reachable only from the re-verify, which established it.
 * - `not-examined` — the block was never looked at. The mapping could not be
 *   followed (an inline extent, a hole, a truncated owner scan, a band whose
 *   geometry went unreadable), the file at the path is not the file the scrub
 *   examined, or the read-back guard says the mapping and the array disagree.
 *   Nothing was written and NOTHING IS KNOWN about the bytes — which is the
 *   opposite of `mapping-abort` and the opposite of `unrepairable`. Its
 *   `reasonCode` says which of those it is (seventh pass, F3/F9/F11).
 */
export const SelfhealOutcomeKind = z.enum([
  'repaired',
  'unrepairable',
  'above-md',
  'mapping-abort',
  'not-examined',
])
export type SelfhealOutcomeKind = z.infer<typeof SelfhealOutcomeKind>

/**
/**
 * A machine-readable qualifier on an `unrepairable` verdict, for the one case
 * where the operator's next step is NOT "restore from backup".
 *
 * `csum-unreadable` — the csum tree leaf that would arbitrate this block failed
 * its own checksum on every copy the DUP metadata chunk holds. Nothing is known
 * about the data block: it may be perfectly good. Restoring the file from
 * backup on the strength of this verdict overwrites data that was never proven
 * bad, so the notification and the UI must say "the checksum could not be
 * read", never "restore from backup" (design review 2026-09-14, D3/D10). The
 * repair job matches this code to give re-scrub advice ("re-scrub after the
 * metadata is repaired — a btrfs scrub repairs metadata copies").
 *
 * Absent on every other outcome — `reason` is the operator's sentence and
 * stays the only thing most verdicts carry.
 *
 * `SELFHEAL_CSUM_UNREADABLE` is the ONE spelling of the code: the enum is
 * built from it, and every producer and consumer imports the constant rather
 * than repeating the literal.
 */
export const SELFHEAL_CSUM_UNREADABLE = 'csum-unreadable'

/**
 * The reason codes of the `not-examined` verdict (seventh pass, F3/F9/F11).
 *
 * Each one is a different sentence about a block NOBODY LOOKED AT, and the
 * distinction is the whole point: "nothing was written" is true of all of them,
 * "the bytes are fine" is true of none.
 *
 * - `inline-extent` — the block's bytes live in the metadata tree, not in a
 *   data chunk. There is no member offset to read, arbitrate or write.
 * - `hole` — the extent is a HOLE. Every LUN image ANAS creates is sparse
 *   (`iscsi-mutate.ts:createSparseImage` uses `ftruncate`), so this is reachable
 *   on any ANAS-created LUN and says nothing at all about the LUN's data.
 * - `owner-scan-truncated` — the extent's back-reference scan hit its bound, so
 *   what it found is a prefix rather than the file's extents in that stripe.
 * - `band-unreadable` — the band the byte sits on had no readable md geometry
 *   at the moment of the lookup.
 * - `unresolvable` — the chain could not be followed for any other reason, and
 *   the read-back guard's own failure: the mapping and the array disagree.
 * - `inode-changed` — the file at the path is not the file the scrub examined
 *   (the finding's inode and the live `stat` disagree). Nothing was pinned.
 * - `run-stopped` — the run stopped BEFORE IT REACHED A VERDICT, and before it
 *   wrote anything (cr3 AHR-HEAL-H1): a gate refused (the array was degraded
 *   or busy), md changed the array under the run (a member kicked, a foreign
 *   sync operation, a state change at the last instant before the write), md
 *   and the direct member read disagreed about the stripe, or an error stopped
 *   the run (a tree walk, a member read, the pin, a bounded check that would
 *   not settle). The block may have been READ; nothing about it was decided.
 *   Restoring the file on the strength of this would overwrite data nothing
 *   has proven bad — the advice is to run the repair again once the cause in
 *   the reason has passed.
 *
 * `csum-unreadable` stays what it always was: an `unrepairable` qualifier, not
 * a `not-examined` one. There the block WAS read; what could not be read is the
 * checksum that would arbitrate it.
 */
/** `run-stopped`'s ONE spelling (cr3 AHR-HEAL-H1), imported by its producers and its consumer. */
export const SELFHEAL_RUN_STOPPED = 'run-stopped'

/**
 * `write-unconfirmed` (cr3 review item 6) — the write through md was ISSUED and
 * reported a failure (`dd` exited non-zero, a failed fsync), so the arbitrated
 * bytes may or may not have landed. The one `not-examined` code of which
 * "nothing was written" is NOT known to be true: the next scrub decides, and a
 * block it still names is repaired again. Never a reason to restore.
 */
export const SELFHEAL_WRITE_UNCONFIRMED = 'write-unconfirmed'

/**
 * `no-checksum` (cr3 second review 5(a)) — btrfs stores NO checksum for this
 * block now. A scrub names only blocks whose checksum failed, so the finding
 * is stale (the file changed since that scrub) or the file keeps no checksums
 * (NOCOW, a preallocated range, `nodatasum`). Nothing can arbitrate a
 * reconstruction; nothing was written; scrub again. Never a reason to restore.
 */
export const SELFHEAL_NO_CHECKSUM = 'no-checksum'

export const SELFHEAL_NOT_EXAMINED_REASONS = [
  'inline-extent',
  'hole',
  'owner-scan-truncated',
  'band-unreadable',
  'unresolvable',
  'inode-changed',
  SELFHEAL_RUN_STOPPED,
  SELFHEAL_WRITE_UNCONFIRMED,
  SELFHEAL_NO_CHECKSUM,
] as const
export type SelfhealNotExaminedReason = typeof SELFHEAL_NOT_EXAMINED_REASONS[number]

/**
 * A member carrying a recorded md bad-block range over the row under repair
 * (seventh pass, F8). md reconstructs nothing from such a member, so it is
 * treated as ABSENT — on RAID5 that ends the reconstruction, on RAID6 it leaves
 * the Q path.
 */
export const SELFHEAL_BAD_BLOCKS_PRESENT = 'bad-blocks-present'

/**
 * `array-rebuilds-rot` (cr3 review item 1) — an `unrepairable` qualifier. The
 * block WAS read and fails its stored checksum, and every copy the array holds
 * of that row gives back the same failing bytes: the parity group (P, and Q on
 * RAID6) agrees with them, or every mirror leg holds them, while md's bounded
 * check counts a mismatch elsewhere in its window. The array cannot rebuild
 * the block and no rerun changes that. The file is damaged at this block
 * unless the checksum record itself is what is wrong: restore it from a backup
 * if one exists. Carried so the advice can say WHY, distinct from a block whose
 * reconstruction merely failed arbitration.
 */
export const SELFHEAL_ARRAY_REBUILDS_ROT = 'array-rebuilds-rot'

export const SelfhealReasonCode = z.enum([
  SELFHEAL_CSUM_UNREADABLE,
  SELFHEAL_BAD_BLOCKS_PRESENT,
  SELFHEAL_ARRAY_REBUILDS_ROT,
  ...SELFHEAL_NOT_EXAMINED_REASONS,
])
export type SelfhealReasonCode = z.infer<typeof SelfhealReasonCode>

/**
 * The steps of the converged sequence, in order.
 *
 * They are named (and NOT renumbered) because the selfheal.2 suite injects a
 * failure immediately before each one and asserts that every md knob is
 * restored and the transient snapshot destroyed afterwards.
 */
export const SelfhealStepName = z.enum([
  'gates',
  'pin',
  'resolve',
  'reverify',
  'precheck',
  'rmw',
  'reconstruct',
  'arbitrate',
  'guard',
  'write',
  'postcheck',
  'coldread',
])
export type SelfhealStepName = z.infer<typeof SelfhealStepName>

/** One step of the sequence, with what it found. */
export const SelfhealStep = z.object({
  name: SelfhealStepName,
  /** False when this is the step the sequence stopped on. */
  ok: z.boolean(),
  /** What the step observed, in the engine's own words. Never a raw stack. */
  detail: z.string().optional(),
})
export type SelfhealStep = z.infer<typeof SelfhealStep>

/** Which reconstruction produced the candidate that won arbitration. */
export const SelfhealReconstruction = z.enum([
  /** RAID5: XOR of the same member offset on every other member. */
  'xor',
  /** RAID6 with P intact: XOR of every member except the bad one and Q. */
  'p-xor',
  /** RAID6 Q syndrome: GF(2^8) solve for the one missing data block. */
  'q-syndrome',
  /** RAID1: another mirror leg's copy of the same block. */
  'mirror',
])
export type SelfhealReconstruction = z.infer<typeof SelfhealReconstruction>

/**
 * The resolved mapping for one block — the whole chain, kept so an outcome can
 * be audited without re-running it (and so the suite can cross-check the
 * engine's mapping against its own).
 *
 * Every field is the value the engine actually used. `logicalByte` is the
 * btrfs LOGICAL bytenr of the block (GT-2: filefrag's "physical_offset" is
 * this number, NOT a device offset); `lvByte` is after the chunk-tree hop,
 * `mdByte` after the dm linear segment, and `memberOffset` after the md
 * layout.
 */
export const SelfhealMapping = z.object({
  /** md level as sysfs reports it (`raid1`, `raid5`, `raid6`). */
  level: z.string(),
  /** `raid_disks` from sysfs. */
  raidDisks: z.number().int().positive(),
  /** `chunk_size` from sysfs, in bytes. 0 on RAID1 (no chunking). */
  chunkBytes: z.number().int().nonnegative(),
  /** Decoded `layout` (`left-symmetric`); null on RAID1, where it has no meaning. */
  layout: z.string().nullable(),
  /** The repaired member's data offset in bytes (`rd<n>/offset` × 512). */
  dataOffset: z.number().int().nonnegative(),
  /** btrfs logical bytenr of the block's own content. */
  logicalByte: z.number().int().nonnegative(),
  /**
   * btrfs logical bytenr of the REPAIR UNIT's start. For an uncompressed
   * extent that is the block itself; for a compressed one it is the extent's
   * on-disk blob, which carries one csum entry per on-disk sector and is
   * therefore the smallest thing that can be checked (suite note, extends GT-9).
   */
  blobLogical: z.number().int().nonnegative(),
  /** On-disk sectors in the repair unit: 1 uncompressed, ⌈disk_nr/4096⌉ compressed. */
  blobSectors: z.number().int().positive(),
  /** The extent is compressed — the repair unit is the blob, not the 4 KiB block. */
  compressed: z.boolean(),
  /** Start of the btrfs chunk covering the block (chunk-tree hop, GT-2). */
  chunkLogical: z.number().int().nonnegative(),
  /** That chunk's device offset — the per-chunk delta GT-2 corrected for. */
  chunkDevice: z.number().int().nonnegative(),
  /** Byte offset inside the btrfs device (the LV). */
  lvByte: z.number().int().nonnegative(),
  /** The dm linear segment's offset into the md device, in 512-byte sectors. */
  startSector: z.number().int().nonnegative(),
  /** Byte offset inside the md array. */
  mdByte: z.number().int().nonnegative(),
  /** Role index of the member holding the block. */
  memberIndex: z.number().int().nonnegative(),
  /** That member's device node, resolved live. */
  memberDevice: z.string(),
  /** Byte offset inside the member device. */
  memberOffset: z.number().int().nonnegative(),
  /** Role index of the stripe's P member; null on RAID1. */
  parityIndex: z.number().int().nonnegative().nullable(),
  /** Role index of the stripe's Q member; null unless RAID6. */
  qIndex: z.number().int().nonnegative().nullable(),
  /** Stripe index within the array; null on RAID1. */
  stripe: z.number().int().nonnegative().nullable(),
})
export type SelfhealMapping = z.infer<typeof SelfhealMapping>

/**
 * The numbers behind the verdict. Optional throughout: a sequence that stopped
 * at the gates has none of them, and an outcome must still parse.
 */
export const SelfhealDiagnostics = z.object({
  mapping: SelfhealMapping.optional(),
  /** `mismatch_cnt` from the bounded md check BEFORE anything was written. */
  precheckMismatch: z.number().int().nonnegative().optional(),
  /** `mismatch_cnt` from the bounded md check after the write. 0 is the only pass. */
  postcheckMismatch: z.number().int().nonnegative().optional(),
  /**
   * md's bounded check read 0 over a parity group a DIRECT read of the members
   * shows is inconsistent — its cached view of the stripe was stale (GT-23).
   *
   * On kernel 7.0.14-17 a stripe written through md moments earlier survives
   * the engine's eviction, and a bounded check over it compares the CACHED
   * copy. Taken alone that number reads `above-md` — "parity already agrees
   * with the bad data" — over rot that is below md all along. The verdict is
   * computed from the member rows instead, and this flag says md's own number
   * was the stale one.
   */
  staleCache: z.boolean().optional(),
  /** On-disk sectors of the repair unit that failed their stored csum. */
  badSectors: z.array(z.number().int().nonnegative()).optional(),
  /** crc32c of the winning candidate, hex. */
  candidateCsum: z.string().optional(),
  /** The stored crc32c it was arbitrated against, hex. */
  storedCsum: z.string().optional(),
  /** Which reconstruction produced that candidate. */
  reconstruction: SelfhealReconstruction.optional(),
  /**
   * Cleanup that did not complete — a knob that could not be restored, a
   * snapshot that could not be destroyed. NEVER swallowed: a repaired block
   * with a leftover snapshot is still repaired, and the operator has to be
   * told what is left behind.
   */
  cleanupErrors: z.array(z.string()),
})
export type SelfhealDiagnostics = z.infer<typeof SelfhealDiagnostics>

/**
 * The engine's verdict on ONE 4 KiB file block.
 *
 * `pool`, `array`, `member` and `stripe` are nullable because the sequence can
 * stop before it knows them (a refused gate knows the array but not the
 * member; a mountpoint the engine was handed directly has no pool name until
 * selfheal.6 hands one in).
 */
export const SelfhealParityResidual = z.object({
  /** The md array the residual is on, as the engine resolved it (`/dev/md127`). */
  array: z.string(),
  /**
   * The band's label (`tank-r1`) when the caller handed the pool in, and the
   * array's kernel name otherwise — the engine is also driven by the loop-device
   * suite, which has bands but no AHR pool.
   */
  band: z.string(),
  /**
   * The band INDEX, when it could be resolved from the pool's topology. Null
   * from the suite's rigs. It is carried separately from the label because a
   * `parityMismatches` row is keyed on it, and that row is what makes Rewrite
   * parity reachable without a fresh multi-hour scrub.
   */
  bandIndex: z.number().int().positive().nullable(),
  /** `mismatch_cnt` the post-check read AFTER the block had been written. */
  mismatchCnt: z.number().int().nonnegative(),
})
export type SelfhealParityResidual = z.infer<typeof SelfhealParityResidual>

export const SelfhealOutcome = z.object({
  outcome: SelfhealOutcomeKind,
  /** Why, in one sentence, for the operator — not for a parser. */
  reason: z.string(),
  /** The one verdict a parser must tell apart; absent on all the others. */
  reasonCode: SelfhealReasonCode.optional(),
  /**
   * The block was repaired and the BAND still counts a parity/Q mismatch
   * (seventh pass, F2).
   *
   * RAID6 with rot in the target block AND in Q: the P-XOR candidate wins
   * arbitration, the block goes through md, and the post-check still counts a
   * mismatch because Q is still wrong. The block is provably correct — it was
   * re-read cold through the pin and matched the checksum btrfs stored for it —
   * so the verdict is `repaired`, and what is left over is a PARITY residual on
   * the band, not a data problem in the file. It rides here so the repair job
   * can hand it on as a `parityMismatches` row, which is what Rewrite parity
   * stands on.
   */
  parityResidual: SelfhealParityResidual.optional(),
  /**
   * The write landed and the POST-CHECK could not run (seventh pass, F5): md
   * took an operation of its own — a member failing inside a post-check window
   * that is minutes long on a 20 TB band is the case — between the write and
   * the verification. The note says which op. Never "nothing written".
   */
  postcheckSkipped: z.string().optional(),
  /** Absolute path of the file on the node. */
  file: z.string(),
  /** 4 KiB file block index (byte offset / 4096). */
  block: z.number().int().nonnegative(),
  /** The AHR pool, when the caller knew it. */
  pool: z.string().nullable(),
  /** The md array device the block lives on (`/dev/md127`). */
  array: z.string().nullable(),
  /** The member device holding the block (`/dev/sdb1`). */
  member: z.string().nullable(),
  /** Stripe index within the array; null on RAID1 and before `resolve`. */
  stripe: z.number().int().nonnegative().nullable(),
  /** Every step the sequence ran, in order, including the one it stopped on. */
  steps: z.array(SelfhealStep),
  diagnostics: SelfhealDiagnostics.optional(),
})
export type SelfhealOutcome = z.infer<typeof SelfhealOutcome>

// ---------------------------------------------------------------------------
//  The repair JOB (story selfheal.6) — POST /v1/ahr/:name/repair
// ---------------------------------------------------------------------------

/**
 * One file the operator asked to have repaired, with the exact blocks.
 *
 * The request is always EXPLICIT: the blocks come from the findings the
 * operator selected in the Scrubs window, never from "everything the daemon
 * thinks is bad". A repair writes through md, and what it writes over is named
 * by the caller.
 *
 * `path` is absolute and under the pool's mountpoint. A scrub finding that
 * lives OUTSIDE the mounted tree (`outsideMount` — a corrupt block inside
 * `@snapshots/…`) is filesystem-relative and is refused here rather than
 * silently reinterpreted: repair works on the live `@data` tree in this cut.
 */
export const AhrRepairFile = z.object({
  path: AbsolutePath,
  /** 4 KiB file block indexes, as `AhrScrubFinding.badBlocks` reports them. */
  blocks: z.array(z.number().int().nonnegative()).min(1, 'name at least one block'),
  /**
   * The inode the scrub examined (seventh pass, F11). ADDITIVE and optional —
   * a caller that does not know it (the dev entry point, an older UI) simply
   * omits it and the engine behaves exactly as it did.
   *
   * A path is not an identity: a file deleted and re-created between the scrub
   * and the repair has the same path and different bytes. The finding already
   * carries the inode; when it rides along, the engine `stat`s the path before
   * it pins anything and refuses a mismatch by name (`inode-changed`) rather
   * than relying on the re-verify to notice by accident.
   */
  inode: z.number().int().nonnegative().optional(),
})
export type AhrRepairFile = z.infer<typeof AhrRepairFile>

/** Body of POST /v1/ahr/:name/repair. */
export const AhrRepairRequest = z.object({
  files: z.array(AhrRepairFile).min(1, 'name at least one file'),
})
export type AhrRepairRequest = z.infer<typeof AhrRepairRequest>

/** What the engine concluded about one requested block. */
export const AhrRepairBlockOutcome = z.object({
  block: z.number().int().nonnegative(),
  outcome: SelfhealOutcomeKind,
  /** The engine's own sentence — including a `refused:` gate and an error text. */
  reason: z.string(),
  /**
   * Carried through from the engine's outcome so the job result, the
   * notification and the Scrubs window can all tell a block whose CHECKSUM
   * could not be read from one that genuinely needs a restore.
   */
  reasonCode: SelfhealReasonCode.optional(),
  /**
   * The block was repaired but its BAND still counts a parity/Q mismatch
   * (seventh pass, F2). Carried per block because it is the block's own
   * post-check that read it; the job rolls them up into `parityResiduals`.
   */
  parityResidual: SelfhealParityResidual.optional(),
  /**
   * The block was WRITTEN with bytes arbitrated against its stored checksum,
   * and the confirmation after the write (post-check, cold read) did not run
   * (cr3 review item 5). Carried from the engine's outcome; a run with such a
   * block is not a clean run, and a re-scrub confirms it.
   */
  postcheckSkipped: z.string().optional(),
})
export type AhrRepairBlockOutcome = z.infer<typeof AhrRepairBlockOutcome>

/** Every requested block of one file, in the order they were attempted. */
export const AhrRepairFileOutcome = z.object({
  path: z.string(),
  blocks: z.array(AhrRepairBlockOutcome),
})
export type AhrRepairFileOutcome = z.infer<typeof AhrRepairFileOutcome>

/**
 * The result of a repair job.
 *
 * FIVE honest counts, and no sixth place to hide a block in (review R9 —
 * `mapping-abort` is counted AS ITSELF, never folded into `unrepairable`, so
 * each bucket's advice follows its own blocks):
 *
 *  - `repaired` — the reconstruction matched the stored checksum, was written
 *    through md, re-checked clean and read back cold. A repaired block whose
 *    BAND still counts a parity mismatch is still repaired (seventh pass, F2);
 *    the leftover rides `parityResiduals`.
 *  - `unrepairable` — nothing below the csum tree can be proven right for this
 *    block (two bad blocks in one stripe, an extent with no csum at all, a
 *    post-check whose cold read did not come back clean). Restore the file from
 *    backup.
 *  - `aboveMd` — parity already agreed with the bad data. Nothing was written;
 *    restore the file from a backup if one exists.
 *  - `mappingAbort` — the block was NOT CORRUPT AT THE MAPPED LOCATION: the
 *    bytes there were READ and still pass their stored csum, so the engine
 *    refused to write. Nothing was written, nothing to restore — the finding no
 *    longer describes the block.
 *  - `notExamined` — the block was never looked at (seventh pass, F3/F9/F11):
 *    an inline extent, a hole, a truncated owner scan, a band whose geometry
 *    went unreadable, a read-back guard that says the mapping and the array
 *    disagree, or a path whose inode is not the one the scrub examined. Nothing
 *    was written and nothing is known about the bytes — so it is neither a
 *    reassurance nor a restore.
 *
 * The per-block entry keeps the outcome and its own reason in every bucket.
 *
 * `blocks` is every block attempted, so the five counts always add up to it.
 * `mappingAbort` and `notExamined` default to 0 so a payload from an older
 * daemon (which folded them elsewhere) still parses.
 */
export const AhrRepairResult = z.object({
  /** The AHR pool the repair ran on. */
  pool: z.string(),
  files: z.array(AhrRepairFileOutcome),
  repaired: z.number().int().nonnegative(),
  unrepairable: z.number().int().nonnegative(),
  aboveMd: z.number().int().nonnegative(),
  /** Blocks whose mapped location was read and not corrupt — left alone, nothing to restore. */
  mappingAbort: z.number().int().nonnegative().default(0),
  /** Blocks nothing was established about — see {@link SelfhealOutcomeKind}. */
  notExamined: z.number().int().nonnegative().default(0),
  /**
   * The bands a repaired block left a parity/Q mismatch on (seventh pass, F2),
   * de-duplicated per band and carrying the highest count seen.
   *
   * Deliberately the SAME row shape the scrub's `parityMismatches` uses: the
   * Scrubs parity indicator and Rewrite parity both read that shape, so a
   * residual a repair discovered is actionable without waiting hours for a
   * fresh two-phase scrub to rediscover it.
   */
  parityResiduals: z.array(AhrScrubParityMismatch).default([]),
  /**
   * Metadata (DUP) copies btrfs corrected from their mirror during THIS
   * repair's own window (selfheal.12, GT-20). The engine's cold reads touch
   * the metadata that holds the checksums it arbitrates against, so a repair
   * can trigger the same correction a scrub does. Additive and optional — a
   * result from an older daemon, or a window that read nothing, omits it.
   */
  metadataCorrected: AhrMetadataCorrected.optional(),
  /** Total blocks attempted — repaired + unrepairable + aboveMd + mappingAbort + notExamined. */
  blocks: z.number().int().nonnegative(),
})
export type AhrRepairResult = z.infer<typeof AhrRepairResult>

// ---------------------------------------------------------------------------
//  Rewrite parity (story selfheal.10) — POST /v1/ahr/:name/parity-rewrite
// ---------------------------------------------------------------------------

/**
 * Body of POST /v1/ahr/:name/parity-rewrite — the ONE band to rewrite.
 *
 * A band at a time, never the pool: `mdadm --action=repair` walks every member
 * of the array it is given, and the operator confirms one array's worth of
 * reading at a time, with that array's own estimate in front of them.
 */
export const AhrParityRewriteRequest = z.object({
  band: z.number().int().positive(),
})
export type AhrParityRewriteRequest = z.infer<typeof AhrParityRewriteRequest>

/**
 * What the run did, in three honest words.
 *
 * - `rewritten` — the fresh btrfs scrub was clean, md rewrote the band's parity
 *   from the data as it stands, and the check afterwards counted 0.
 * - `refused` — a precondition did not hold (see `reasonCode`). Nothing was
 *   written and no md knob was moved.
 * - `still-mismatched` — the repair ran and the check afterwards still counted
 *   mismatches. Parity is NOT proven good; the band needs looking at.
 */
export const AhrParityRewriteOutcome = z.enum(['rewritten', 'refused', 'still-mismatched'])
export type AhrParityRewriteOutcome = z.infer<typeof AhrParityRewriteOutcome>

/**
 * Why a run refused, for a parser. The operator's sentence is `reason`.
 *
 * The first four are the route's hard 409s, re-checked by the engine at submit
 * AND immediately before the md write (the array can lose a member in between);
 * `data-corruption-found` is the fresh scrub's own abort, and `foreign-sync-op`
 * is md having taken an operation of its own on the band while the run was in
 * flight — the one case where the run walks away with every knob exactly as md
 * left it. `no-such-band` and `pool-not-mounted` are the two the route answers
 * before any of that (400 and 409 respectively), and the engine answers again
 * because it is also driven directly by the selfheal.2 suite.
 *
 * `not-a-parity-band` is the sixth pass's refusal and it is not a state that
 * passes: a RAID1 band has no parity to rewrite, and md's `repair` on a mirror
 * copies the first in-sync leg over the others — a 50/50 chance of writing the
 * rotten copy over the good one. It never becomes true for that band.
 *
 * `bad-blocks-present` is the seventh pass's (F8): a member of the band carries
 * recorded bad-block ranges, so md cannot reconstruct from it. A whole-band
 * `repair` over such an array recomputes parity from rows md could not read.
 * The member is replaced first; it is not a wait-and-retry state either.
 */
export const AhrParityRewriteReasonCode = z.enum([
  'no-parity-mismatch',
  'data-findings-present',
  'array-busy',
  'job-active',
  'data-corruption-found',
  'foreign-sync-op',
  'no-such-band',
  'pool-not-mounted',
  'not-a-parity-band',
  'bad-blocks-present',
  // cr3 review item 7: the fresh btrfs scrub's verdict could not be read as
  // `finished` for THIS pass (it did not run, it describes an earlier pass, or
  // its status names no state). Nothing proves the data intact, so md is not
  // handed the repair.
  'scrub-unproven',
])
export type AhrParityRewriteReasonCode = z.infer<typeof AhrParityRewriteReasonCode>

/** How long each phase took, in milliseconds — the run's own clock. */
export const AhrParityRewriteDurations = z.object({
  /** The fresh btrfs scrub (phase 1). */
  scrubMs: z.number().int().nonnegative(),
  /** `mdadm --action=repair` over the whole band (phase 2). */
  repairMs: z.number().int().nonnegative(),
  /** The verifying md check over the whole band (phase 3). */
  checkMs: z.number().int().nonnegative(),
  totalMs: z.number().int().nonnegative(),
})
export type AhrParityRewriteDurations = z.infer<typeof AhrParityRewriteDurations>

/**
 * The result of a parity-rewrite job (story selfheal.10).
 *
 * `mismatchBefore` is md's counter as it read immediately before the repair was
 * issued — the last completed check's verdict, since md zeroes the counter when
 * a sync op starts. `mismatchAfter` is the verifying check's own count. Both are
 * nullable because an attribute that could not be read is reported as unknown,
 * never as zero.
 *
 * `btrfsErrors` / `errorsReported` / `findings` carry the fresh scrub's verdict
 * — populated on a `data-corruption-found` refusal, which is the whole point of
 * running that scrub: md repair would BLESS that rot (GT-18's negative), so the
 * files are named here and repaired through selfheal.6 first.
 */
export const AhrParityRewriteResult = z.object({
  /** The AHR pool the band belongs to. */
  pool: z.string(),
  /** Band index (1-based), as the request named it. */
  band: z.number().int().positive(),
  /** The md array that band is (`/dev/md/tank-r1`), or null when unresolved. */
  array: z.string().nullable(),
  mismatchBefore: z.number().int().nonnegative().nullable(),
  mismatchAfter: z.number().int().nonnegative().nullable(),
  outcome: AhrParityRewriteOutcome,
  /** One sentence for the operator — always set on anything but `rewritten`. */
  reason: z.string().optional(),
  reasonCode: AhrParityRewriteReasonCode.optional(),
  /** The fresh scrub's `Error summary:` line, verbatim, when it found errors. */
  btrfsErrors: z.string().nullable().optional(),
  /** Total errors that summary counted. */
  errorsReported: z.number().int().nonnegative().optional(),
  /** The corrupt files the fresh scrub named, when attribution ran. */
  findings: z.array(AhrScrubFinding).optional(),
  durations: AhrParityRewriteDurations,
})
export type AhrParityRewriteResult = z.infer<typeof AhrParityRewriteResult>

// ---------------------------------------------------------------------------
//  Reconcile mirror (story selfheal.11) — POST /v1/ahr/:name/mirror-reconcile
// ---------------------------------------------------------------------------

/**
 * Body of POST /v1/ahr/:name/mirror-reconcile — the ONE mirror band to
 * reconcile.
 *
 * A band at a time, like the parity rewrite and for the same reason: md counts
 * disagreeing legs over a whole array and never says WHERE they disagree, so
 * the honest scope of "the legs of this band disagree somewhere" is the band —
 * and the operator confirms one band's worth of reading with that band's own
 * estimate in front of them.
 */
export const AhrMirrorReconcileRequest = z.object({
  band: z.number().int().positive(),
})
export type AhrMirrorReconcileRequest = z.infer<typeof AhrMirrorReconcileRequest>

/**
 * Which arm of the verb answered (story selfheal.11, RULED 2026-09-14).
 *
 * - `scrub` — arm A, "scrub until clean". GT-22's UNEXPECTED(1): a btrfs scrub
 *   that meets a mirror band's rot heals the whole band THROUGH md — btrfs
 *   re-reads on a checksum failure, md's read-balance serves the other leg, and
 *   the good block goes back to BOTH legs. md's read-balance is not
 *   contractual, so the pass is repeated (bounded), and each pass's
 *   `corrected` count is progress.
 * - `compare` — arm B, "compare legs". The scrub could not reach it (md never
 *   served the rotten leg), so both legs are read directly, row by row, and
 *   every differing row is arbitrated against the checksum btrfs stored for it.
 */
export const AhrMirrorReconcileArm = z.enum(['scrub', 'compare'])
export type AhrMirrorReconcileArm = z.infer<typeof AhrMirrorReconcileArm>

/**
 * What the run did.
 *
 * - `reconciled` — the legs agree and a whole-band md check counted 0.
 * - `refused` — a precondition did not hold (see `reasonCode`). Nothing was
 *   written.
 * - `residual` — the run wrote what it could prove and the band is STILL not
 *   clean: rows where neither leg matched the checksum btrfs stored for them
 *   (`unresolvedRows`), or a check that came back non-zero anyway. Not a
 *   success, and it must never be rendered as one.
 */
export const AhrMirrorReconcileOutcome = z.enum(['reconciled', 'refused', 'residual'])
export type AhrMirrorReconcileOutcome = z.infer<typeof AhrMirrorReconcileOutcome>

/**
 * Why a run refused, for a parser. The operator's sentence is `reason`.
 *
 * `not-a-mirror-band` is this verb's `not-a-parity-band`: it never becomes true
 * for a parity band, which has a verb of its own. The pair is deliberate —
 * between them they carry the epic's standing invariant that `mdadm
 * --action=repair` is issued on a parity band with the data proven intact and
 * on nothing else, ever (RULED 2026-09-14).
 *
 * There is deliberately NO `data-corruption-found` here, and that is the one
 * place this verb's gates differ from the parity rewrite's. That verb aborts on
 * any finding because md repair would recompute parity from the rot and bless
 * it; this one writes no row it cannot prove, so a file neither leg can satisfy
 * is reported (`btrfsErrors`, `findings`, and its rows as `unresolvedRows`) and
 * is not a reason to leave the rest of the band mismatched.
 */
export const AhrMirrorReconcileReasonCode = z.enum([
  'no-mirror-mismatch',
  'not-a-mirror-band',
  'data-findings-present',
  'array-busy',
  'job-active',
  'bad-blocks-present',
  'foreign-sync-op',
  'no-such-band',
  'pool-not-mounted',
  // cr3 review item 7: an arm-A btrfs scrub pass whose verdict could not be read.
  'scrub-unproven',
])
export type AhrMirrorReconcileReasonCode = z.infer<typeof AhrMirrorReconcileReasonCode>

/** One arm-A pass: what the btrfs scrub corrected, and what md counted after it. */
export const AhrMirrorReconcilePass = z.object({
  /**
   * `corrected_errors` of that btrfs scrub pass — every one of them is
   * progress. Null when `btrfs scrub status` could not be read after the pass
   * (cr3): a count nobody read is unknown, never zero.
   */
  corrected: z.number().int().nonnegative().nullable(),
  /**
   * `mismatch_cnt` of the whole-band md check that followed the pass, or null
   * when the counter could not be read. Never reported as 0 when unknown.
   */
  mismatchAfter: z.number().int().nonnegative().nullable(),
})
export type AhrMirrorReconcilePass = z.infer<typeof AhrMirrorReconcilePass>

/** How many rows each leg won, by role index — the write's own audit line. */
export const AhrMirrorReconcileWrites = z.object({
  leg0: z.number().int().nonnegative(),
  leg1: z.number().int().nonnegative(),
})
export type AhrMirrorReconcileWrites = z.infer<typeof AhrMirrorReconcileWrites>

/** How long each phase took, in milliseconds — the run's own clock. */
export const AhrMirrorReconcileDurations = z.object({
  /** Every arm-A btrfs scrub pass together. */
  scrubMs: z.number().int().nonnegative(),
  /** Arm B: reading both legs, arbitrating, and writing the winners. */
  compareMs: z.number().int().nonnegative(),
  /** Every whole-band md check the run issued, together. */
  checkMs: z.number().int().nonnegative(),
  totalMs: z.number().int().nonnegative(),
})
export type AhrMirrorReconcileDurations = z.infer<typeof AhrMirrorReconcileDurations>

/**
 * The result of a mirror-reconcile job (story selfheal.11).
 *
 * `mismatchBefore` is md's counter as it read with the band idle at the start
 * of the run; `mismatchAfter` is the last whole-band check's own count. Both
 * are nullable because a counter that could not be read is reported as
 * unknown, never as zero.
 *
 * The four row counts are the honesty of arm B, and they are not
 * interchangeable:
 *  - `rowsWritten` — a leg matched the checksum btrfs stored for the row, and
 *    its bytes went through md to both legs.
 *  - `freeSpaceRows` — the row is in no chunk at all. btrfs has never written
 *    there, nothing knows what it should hold, and legs are allowed to
 *    disagree about free space. Skipped, never written.
 *  - `uncheckedRows` — the row is in a DATA chunk with NO stored checksum (a
 *    hand-set NOCOW file, a prealloc range, `nodatasum`). There is nothing to
 *    arbitrate with. Skipped, never written.
 *  - `unresolvedRows` — both legs failed. Nothing written, and the band's
 *    residual is reported rather than hidden.
 *  - `undecidedRows` (cr3 AHR-HEAL-H3/L12) — the row could not be arbitrated
 *    for a reason that says NOTHING about its data: the checksum that would
 *    arbitrate it could not be read (D3), both legs matched it, a leg could
 *    not be read there at all, or the row changed between the comparison and
 *    the write. Never written, and — unlike `unresolvedRows` — never a reason
 *    to restore anything.
 */
export const AhrMirrorReconcileResult = z.object({
  /** The AHR pool the band belongs to. */
  pool: z.string(),
  /** Band index (1-based), as the request named it. */
  band: z.number().int().positive(),
  /** The md array that band is (`/dev/md/tank-r2`), or null when unresolved. */
  array: z.string().nullable(),
  /**
   * The arm the run ended in. `scrub` while arm A is still running or answered;
   * `compare` from the moment arm A gives up, which includes the refusals taken
   * at arm B's own gate (the preconditions are re-read there, and one of them
   * can have stopped being true during a scrub that took hours).
   */
  arm: AhrMirrorReconcileArm,
  /** One entry per arm-A btrfs scrub pass, in order. */
  passes: z.array(AhrMirrorReconcilePass).default([]),
  /** 4 KiB rows arm B read off both legs. Zero when arm A answered. */
  rowsCompared: z.number().int().nonnegative().default(0),
  /** Of those, the rows whose legs held different bytes. */
  rowsDiffering: z.number().int().nonnegative().default(0),
  rowsWritten: AhrMirrorReconcileWrites.default({ leg0: 0, leg1: 0 }),
  freeSpaceRows: z.number().int().nonnegative().default(0),
  uncheckedRows: z.number().int().nonnegative().default(0),
  unresolvedRows: z.number().int().nonnegative().default(0),
  undecidedRows: z.number().int().nonnegative().default(0),
  /**
   * The md bytes of the rows arm B wrote, the first 64 of them (cr3 second
   * review item 7); `rowsWritten` says how many there were in all. Absent
   * when nothing was written, and from an older daemon.
   */
  writtenAt: z.array(z.number().int().nonnegative()).optional(),
  mismatchBefore: z.number().int().nonnegative().nullable(),
  mismatchAfter: z.number().int().nonnegative().nullable(),
  outcome: AhrMirrorReconcileOutcome,
  /** One sentence for the operator — always set on anything but `reconciled`. */
  reason: z.string().optional(),
  reasonCode: AhrMirrorReconcileReasonCode.optional(),
  /** A btrfs scrub pass's `Error summary:` line, verbatim, when it was not clean. */
  btrfsErrors: z.string().nullable().optional(),
  /** The corrupt files a refusing pass named, when attribution ran. */
  findings: z.array(AhrScrubFinding).optional(),
  durations: AhrMirrorReconcileDurations,
})
export type AhrMirrorReconcileResult = z.infer<typeof AhrMirrorReconcileResult>
