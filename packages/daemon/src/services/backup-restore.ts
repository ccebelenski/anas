import type {
  BackupImageRestoreResult,
  BackupRepo,
  BackupSnapshot,
  CreateDatasetRequest,
  ImageRestoreFailureCode,
  IscsiLun,
  IscsiSession,
  IscsiTargetDetail,
} from '@anas/shared'
import type { CommandExecutor, ExecStreamResult, ExecStreamTarget } from '../executor/types.js'
import type { TargetObject } from './iscsi-guard.js'
import type { IscsiMutateOptions, ResolvedBacking } from './iscsi-mutate.js'
import type { IscsiReadContext } from './iscsi.js'
import type { RestoreMarkRead } from './restore-mark.js'
import { constants } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { RESTORE_MARK_PROPERTY } from '@anas/shared'
import { StreamFlushError, StreamNotStartedError } from '../executor/stream-errors.js'
import { buildCreateArgs } from '../routes/datasets.js'
import { ensureAhrTargetOrdering } from './ahr-create.js'
import { classifyPermissionFailure, PBC, pbcPositional, withStateLeftBehind } from './backup-runner.js'
import { aclNamesRefusal, createLunBackstore, createSparseImage, mapLunIntoTarget, newSerial, runTargetcli, saveIscsiConfig, setIscsiTargetState, tpgPath, withIscsiLock, ZFS, zvolDataset } from './iscsi-mutate.js'
import { normalizePlugin } from './iscsi.js'
import { capitalize, clearMarkCommand, clearRestoreMark, describeRestoreMark, fileRestoreAgain, JOB_RECORD_LIFETIME, markDataset, putBackRestoreMark, readRestoreMark, setRestoreMark, unverifiedMark, writingMark } from './restore-mark.js'
import { maskSecretValues } from './secret-argv.js'

/**
 * WHOLE-IMAGE RESTORE of an iSCSI LUN (story backup2.7).
 *
 * Restore is two types by nature — files are selective, block images are whole
 * — and this module is the whole half. It takes an `.img` archive out of a PBS
 * snapshot and puts it back on the zvol or image file a LUN is serving from,
 * with LIO stood down for the duration.
 *
 * EVERY line here answers a fact from `docs/BACKUP-RESTORE-GROUND-TRUTH.md`:
 *
 *  - **GT-39 — `restore` refuses every existing target.** A regular file, the
 *    `/dev/zvol/<pool>/<vol>` symlink and the resolved `/dev/zdNN` all come
 *    back `unable to create target file … File exists (os error 17)`, and
 *    `--overwrite` does not help. The client never writes "into" a device node
 *    and never unlinks a path — it simply refuses. So ANAS never hands the
 *    target to pbc at all: the archive goes to STDOUT (`-`) and ANAS opens the
 *    destination itself (GT-40, proven exit 0 into a zvol).
 *
 *  - **GT-42 — a size mismatch is unguarded AND destructive.** A 512 MiB image
 *    onto a 256 MiB zvol wrote the first 256 MiB and then died on `No space
 *    left on device`; the target's head was the image's head, i.e. the LUN was
 *    half-overwritten. The reverse (a smaller image) exits 0 and leaves stale
 *    tail bytes past the image length. Nothing below ANAS checks this, so
 *    {@link assertSizeMatch} is a REFUSAL before anything is touched.
 *
 *  - **GT-57 — a bare group path silently restores the LATEST snapshot.** The
 *    argv builder therefore takes a full `<type>/<id>/<RFC3339>` (enforced by
 *    the shared schema) and never a group.
 *
 *  - **GT-59 — progress is on STDERR, CR-terminated, at a doubling interval**
 *    (6 s, 16 s, 36 s, 79 s on an 87-second restore). A parser must split on
 *    `\r` as well as `\n`, and a job must not read silence as a stall.
 *
 *  - **GT-60/61 — a killed restore leaves NO marker of any kind.** For a tree
 *    that is a heuristic about file modes; for a block device there is nothing
 *    at all. The only record that a LUN holds half an image is the one ANAS
 *    writes into the job result — which is why a partial write leaves the
 *    target DISABLED and says so.
 *
 * WHY `map` + `dd` IS NOT BUILT: it is the documented alternative, not a second
 * code path. `map` produces a read-only `/dev/loopN` (GT-41) that `dd` could
 * copy from, which makes it a fine hands-on tool — and a `blkid`/`mount -o ro`
 * on that loop device is a cheap "is this the filesystem you expected?" check
 * before overwriting a LUN. But it is two more moving parts (a mapping that
 * outlives a crash and needs the argument-less `unmap` sweep to clean up) for
 * the same bytes, and two paths that write a LUN is one path too many.
 */

/** Splits a pbc stream into lines: its progress lines are CR-terminated (GT-59). */
const LINE_SPLIT_RE = /[\r\n]+/

/**
 * targetcli's answer to a `delete` of a backstore that does not exist. The
 * parent form (`/backstores/<plugin> delete <name>`, cr3.backup) is proven by
 * GT-42 to delete; its not-found wording is not captured, so the three
 * spellings configshell/targetcli use for a missing child or path are all
 * read as "nothing there" (unverified on the node — a wording outside them is
 * reported as left behind, never as removed).
 */
const NO_SUCH_OBJECT_RE = /no such object|no storage object named|no such path/i

/** `zfs get -Hp -o value volsize <dataset>` — the zvol target's exact size. */
export function volsizeArgs(dataset: string): string[] {
  // cr.21: `--` ends option parsing before the derived dataset operand.
  return ['get', '-Hp', '-o', 'value', 'volsize', '--', dataset]
}

/**
 * The restore argv. The target is `-` — ALWAYS.
 *
 * `--rate` is emitted only when asked for. GT-62: it limits TRANSFERRED bytes,
 * not logical ones, so a 512 MiB sparse image throttled to 3 MB/s still
 * finished in 0.4 s; any "time remaining" built on the archive size is wrong.
 */
export function imageRestoreArgs(
  snapshot: string,
  archive: string,
  namespace?: string,
  rate?: string,
): string[] {
  // The `-` target is this builder's own constant (stdout, GT-39), not a value
  // from anywhere: it is the one positional that legitimately IS a dash.
  const args = ['restore', pbcPositional(snapshot, 'snapshot'), pbcPositional(archive, 'archive'), '-']
  if (namespace)
    args.push('--ns', namespace)
  if (rate)
    args.push('--rate', rate)
  return args
}

/**
 * The open flags for a restore target, by backing kind.
 *
 * A ZVOL (or any block device) is opened `O_WRONLY` and NOTHING else: no
 * `O_CREAT` (the node is already there, and creating a regular file over a
 * missing device node would be a catastrophe rather than a fallback) and no
 * `O_TRUNC` (meaningless on a device, and stating it would misdescribe intent).
 *
 * An image FILE is opened `'w'` — `O_WRONLY | O_CREAT | O_TRUNC`. The truncate
 * matters and is safe: the size-equality pre-check has already proven the image
 * is exactly the file's length, and `open`+truncate keeps the INODE, so the LIO
 * fileio backstore keeps pointing at the same object. That is the entire reason
 * this path needs no `wwn=`/attribute replay (see `resizeFileLun`, which does).
 */
export function restoreTargetFlags(kind: 'zvol' | 'file'): string | number {
  return kind === 'zvol' ? constants.O_WRONLY : 'w'
}

/** The full stream target for a LUN's backing object. */
export function restoreStreamTarget(path: string, kind: 'zvol' | 'file'): ExecStreamTarget {
  return { path, flags: restoreTargetFlags(kind) }
}

// ---------------------------------------------------------------------------
// Reading the snapshot's manifest — through backup2.5's picker layer
// ---------------------------------------------------------------------------
//
// The listing, the composed `<type>/<id>/<RFC3339>` id and the per-file
// classification are ALL `services/backup-reads.ts`'s (story backup2.5). This
// module does not parse `snapshot list` a second time: one picker, one parser,
// and a restore that reads exactly what the operator was shown.

/**
 * The GROUP path `<type>/<id>` of a full snapshot id.
 *
 * `snapshot list` takes a group as its argument, so listing the ONE group a
 * restore names is both cheaper and more precise than listing the namespace and
 * filtering. The id is schema-validated as three segments before it gets here
 * (GT-57 — a two-segment path is not an error to pbc, it silently restores the
 * latest), so the first two are the group.
 */
export function snapshotGroup(snapshot: string): string {
  const parts = snapshot.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : snapshot
}

/**
 * The manifest size of ONE image archive within a snapshot, or null.
 *
 * `files[].size` is the LOGICAL size of the archive — for an `.img` that is the
 * image's own length, which is the number the equality pre-check needs. (For a
 * sparse image it is emphatically NOT the transferred or stored size: the real
 * capture shows a 512 MiB image whose stored chunks are 5.5 K.)
 *
 * The match is on backup2.5's `archive` field — the stored `<name>.img.fidx`
 * minus its index suffix, which is what pbc takes on the command line — and on
 * `kind === 'img'`, so a pxar archive that happened to be named `foo.img`
 * cannot be handed to a block restore.
 */
export function imageArchiveSize(snapshot: BackupSnapshot, archive: string): number | null {
  const found = snapshot.files.find(f => f.kind === 'img' && f.archive === archive)
  return found ? (found.size ?? null) : null
}

// ---------------------------------------------------------------------------
// Progress parsing (STDERR, CR-terminated, doubling interval)
// ---------------------------------------------------------------------------

/** `progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.1 MiB/s)` — GT-59. */
const PROGRESS_RE = /^progress\s+(\d+)%\s*\((.*)\)\s*$/
/** `restore complete (250.001 MiB processed in 1m 27.5s, average 2.857 MiB/s)`. */
const COMPLETE_RE = /^restore complete\s*\((.*)\)\s*$/
/** Trailing padding spaces pbc puts on every line. */
const TRAILING_WS_RE = /\s+$/
/** The amount processed, at the start of a progress line's parenthesis: `43.939 MiB of 250.001 MiB in 16.1s` (GT-59). */
const PROCESSED_RE = /^(\d+)(?:\.(\d+))?\s*(B|KiB|MiB|GiB|TiB|PiB)\s+of\s/
const UNIT_BYTES: Record<string, number> = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40, PiB: 2 ** 50 }

export interface RestoreProgress {
  /** The last percentage pbc reported, or null when it printed none. */
  percent: number | null
  /** The last full `progress …` line, verbatim (minus the padding). */
  lastLine: string | null
  /** pbc's own `restore complete (…)` line, when it printed one. */
  complete: string | null
  /**
   * A LOWER BOUND on the bytes the last progress line says were processed
   * (`1 MiB of 512 GiB` — review3 3: a `progress 0%` line on a large image
   * still names an amount), its display rounding taken off. Absent when that
   * line names none.
   */
  processedBytes?: number
}

/**
 * The lower bound of an amount pbc printed: it shows at most three decimals
 * and drops trailing zeros (`250.001 MiB`, `3.1 MiB/s`, `512 MiB` for exactly
 * 536870912 bytes — the captures in `fixtures/backup/`), so half of 0.001 of
 * the unit comes off; a plain `B` count is exact.
 */
function processedLowerBound(inner: string): number | undefined {
  const m = inner.match(PROCESSED_RE)
  if (!m)
    return undefined
  const shown = Number(`${m[1]}.${m[2] ?? '0'}`)
  if (m[3] === 'B')
    return Math.floor(shown)
  return Math.max(0, Math.floor((shown - 0.0005) * UNIT_BYTES[m[3]]))
}

/** How many image bytes reached the target, and whether that number is exact. */
export interface ImageBytesWritten {
  bytes: number
  /** True when the number is a LOWER BOUND read off the client's own progress. */
  estimated: boolean
}

/**
 * How much of the image actually reached the LUN.
 *
 * The obvious source — the descriptor ANAS opened — is only right when the
 * child writes to fd 1. `proxmox-backup-client restore … -` does not: it OPENS
 * `/dev/stdout`, which gives it its own file description on the same object, so
 * OUR offset never moves (live-proof wave 2). The count is therefore taken from
 * the descriptor when it did move, and from the client's own progress otherwise:
 * a completed restore wrote the whole image (pbc's `restore complete` line says
 * so), and an interrupted one wrote AT LEAST what its last percentage claimed —
 * a lower bound, labelled as one, which is exactly what the partial verdict
 * needs (a device carries no marker of its own, GT-60).
 */
export function imageBytesWritten(
  descriptorBytes: number,
  progress: RestoreProgress,
  imageSize: number,
  exitCode: number,
): ImageBytesWritten {
  if (descriptorBytes > 0)
    return { bytes: descriptorBytes, estimated: false }
  if (exitCode === 0 && progress.complete)
    return { bytes: imageSize, estimated: false }
  if (progress.percent !== null) {
    // review3 3: the amount on the line counts too — `progress 0% (1 MiB of
    // 512 GiB in 6.0s)` is 1 MiB written, never 0.
    const byPercent = Math.floor((progress.percent / 100) * imageSize)
    const bytes = Math.min(imageSize, Math.max(byPercent, progress.processedBytes ?? 0))
    if (bytes > 0)
      return { bytes, estimated: true }
  }
  return { bytes: 0, estimated: false }
}

/**
 * Parse pbc restore STDERR.
 *
 * The lines are CR-terminated, so the split is on `\r` AND `\n` — under a pty
 * the ONLY difference is a trailing `\r` (`cat -v` shows `…MiB/s)    ^M`), and
 * a parser that split on `\n` alone would see one enormous line.
 */
export function parseRestoreProgress(stderr: string): RestoreProgress {
  const progress: RestoreProgress = { percent: null, lastLine: null, complete: null }
  for (const raw of stderr.split(LINE_SPLIT_RE)) {
    const line = raw.replace(TRAILING_WS_RE, '').trim()
    if (!line)
      continue
    const p = line.match(PROGRESS_RE)
    if (p) {
      progress.percent = Number(p[1])
      progress.lastLine = line
      const processed = processedLowerBound(p[2])
      if (processed === undefined)
        delete progress.processedBytes
      else
        progress.processedBytes = processed
      continue
    }
    const c = line.match(COMPLETE_RE)
    if (c)
      progress.complete = line
  }
  return progress
}

// ---------------------------------------------------------------------------
// Failure taxonomy (GT-56)
// ---------------------------------------------------------------------------

const CONNECT_RE = /client error \(Connect\)/i
const REFUSED_RE = /Connection refused/i
const DNS_RE = /dns error/i
const DEADLINE_RE = /deadline has elapsed/i
const CERT_RE = /certificate fingerprint does not match|certificate verify failed/i
const NO_SNAPSHOT_RE = /snapshot .* does not exist/i
const NO_ARCHIVE_RE = /archive not found in manifest/i
const BAD_SUFFIX_RE = /failed to parse archive type/i
const NO_PERM_RE = /no permissions on/i
const BROKEN_PIPE_RE = /broken pipe|connection closed/i

/**
 * The lines pbc prints when it fails BEFORE it fetches any data (review3 3),
 * each anchored to one whole line of stderr (trimmed, its padding off). The
 * captures they come from: `fixtures/backup/restore-failure-taxonomy.txt`
 * (F1-F5, F10, F11 are `restore` runs; 21-connect A and D are `snapshot list`)
 * and `fixtures/backup/backup-failure-taxonomy.txt` (CASE 4 and 7, `snapshot
 * list`).
 */
const PREWRITE_LINE_RES: readonly RegExp[] = [
  /^Error: snapshot \S+ does not exist\.$/, // F1, F2, F3 (restore)
  /^Error: archive not found in manifest$/, // F4 (restore)
  /^Error: failed to parse archive type for '[^']*'$/, // F5 (restore)
  /^Error: no permissions on \S+$/, // F11 (restore)
  /^Error: permission check failed\.$/, // CASE 4 (snapshot list)
  /^Error: permission check failed - missing \S+ on \S+$/, // CASE 7 (snapshot list)
  /^Error: client error \(Connect\)$/, // F10 (restore); 21-connect A, C, D
  /^error connecting to \S+ - tcp connect error: Connection refused \(os error 111\)$/, // F10 (restore)
  /^error connecting to \S+ - dns error: .+$/, // 21-connect A (snapshot list)
  /^WARNING: certificate fingerprint does not match expected fingerprint!$/, // 21-connect D (snapshot list)
  /^certificate validation failed - Certificate fingerprint was not confirmed\.$/, // 21-connect D
  /^\d+: error:[0-9A-F]+:SSL routines:[^:]*:certificate verify failed:/, // 21-connect D
]

/** Lines that say nothing either way, from the same captures (`Caused by:`, the pinned fingerprint). */
const NEUTRAL_LINE_RES: readonly RegExp[] = [
  /^Caused by:$/,
  /^expected:\s+[0-9a-f]{2}(?::[0-9a-f]{2})+$/,
]

/**
 * The `Error:` line to quote in a failure detail — RAW, on purpose.
 *
 * cr.48d: the line can echo the repo secret a restore handed pbc (a bad
 * credential answered with the token, a URL repeated back — the assumption
 * cr.48b rejected), so every CALLER masks it — {@link explainRestoreFailure}
 * masks its whole sentence at the boundary, and {@link runImageRestore} /
 * {@link runNewLunImageRestore} are covered by that one pass. This stays raw
 * because classification must read the truth.
 */
export function firstRestoreError(stderr: string): string {
  const lines = stderr.split(LINE_SPLIT_RE).map(l => l.trim()).filter(Boolean)
  return lines.find(l => l.startsWith('Error:')) ?? (lines.at(-1) ?? 'restore failed')
}

/**
 * Does the image restore's stderr hold anything usable as a REASON? Progress
 * alone is silence (live-proof F16): a killed pbc's last words are
 * `progress 22% (…)`, and quoting that as the failure reads as though the
 * progress WAS the reason.
 */
export function hasImageRestoreErrorText(stderr: string): boolean {
  for (const raw of stderr.split(LINE_SPLIT_RE)) {
    const line = raw.replace(TRAILING_WS_RE, '').trim()
    if (!line)
      continue
    if (PROGRESS_RE.test(line) || COMPLETE_RE.test(line))
      continue
    return true
  }
  return false
}

/**
 * Turn a failed restore into a sentence that says what to do next.
 *
 * Three of these collapse on the client side and the message says so rather
 * than pretending to a precision pbc does not have: a missing SNAPSHOT, a
 * missing GROUP and a missing NAMESPACE all produce the identical
 * `snapshot …/… does not exist.` string (GT-56).
 *
 * `signal` is the executor's record of a signal death (D5): when the client was
 * killed and left nothing but progress behind, the reason is HOW it ended —
 * `the client was killed by SIGKILL` — never the progress line, which is not a
 * reason. A client that said something real before dying keeps its words.
 *
 * `secretValues` are the secret values this restore handed pbc (the repo
 * password / token secret, cr.48b): the sentence that leaves is masked against
 * them, because a pbc ERROR line can echo the value it was pointed at (a bad
 * credential answered with the token, a URL repeated back) and the sentence
 * would otherwise ride the job error and the audit line. The classification
 * reads the RAW stderr — the same split cr.48b/c make: the verdict is drawn
 * from the truth, only the reply is masked.
 */
export function explainRestoreFailure(stderr: string, signal?: string, secretValues: string[] = []): string {
  // cr.48d: the sentence is THE thing that leaves (the job error the detail
  // rides, the audit line that carries it verbatim) — ONE masking pass at the
  // boundary, over whatever the raw classifier composed from stderr. The
  // classification above reads the RAW text and is untouched. A masked value
  // under four characters, or no values at all, is a no-op.
  return maskSecretValues(rawExplainRestoreFailure(stderr, signal), secretValues)
}

/**
 * Did the client fail BEFORE it could write a byte of the image (cr3.lunrestore,
 * review2 B, review3 3)? Only the failures pbc reports before it fetches any
 * data count: the server not reached (refused, a name that did not resolve, a
 * failed connect), a certificate that does not match, a rejected credential or
 * missing privileges, a snapshot or archive that does not exist, a wrong
 * archive name — each as the WHOLE line pbc prints ({@link PREWRITE_LINE_RES}).
 *
 * Anything that may have written wins over a pre-write line: a signal, any
 * progress or `restore complete` line (the stream started), a dropped
 * connection or a timeout anywhere in the text, and any line that is neither a
 * pre-write line nor a known neutral one (unclassified). "Nothing written"
 * needs at least one pre-write line and nothing else.
 */
export function failedBeforeWriting(stderr: string, signal?: string): boolean {
  if (signal)
    return false
  if (DEADLINE_RE.test(stderr) || BROKEN_PIPE_RE.test(stderr))
    return false
  let preWrite = false
  for (const raw of stderr.split(LINE_SPLIT_RE)) {
    const line = raw.replace(TRAILING_WS_RE, '').trim()
    if (!line)
      continue
    if (PROGRESS_RE.test(line) || COMPLETE_RE.test(line))
      return false
    if (PREWRITE_LINE_RES.some(re => re.test(line))) {
      preWrite = true
      continue
    }
    if (!NEUTRAL_LINE_RES.some(re => re.test(line)))
      return false
  }
  return preWrite
}

/**
 * Why an exit-0 stream is not proof of the whole image (review3 6), or null:
 * the descriptor count when it moved and is not the image's size; otherwise
 * the client did not print its `restore complete` line, and ANAS cannot count
 * what the client wrote through its own descriptor (live-proof wave 2).
 */
function exitZeroCountGap(descriptorBytes: number, counted: number, imageSize: number, path: string): string | null {
  if (counted === imageSize)
    return null
  if (descriptorBytes > 0)
    return `${descriptorBytes} bytes reached ${path}, not the image's ${imageSize}`
  return 'it did not report the restore complete and ANAS cannot count what it wrote'
}

/**
 * The clause for a failed stream that counted no bytes and is not proof that
 * nothing was written (review3 3), true for what the client printed: no
 * progress line at all, or the last line it printed (masked, cr.48e), which
 * named no amount above zero.
 */
function unknownAmount(progress: RestoreProgress, where: string, secret: string): string {
  const said = progress.lastLine ?? progress.complete
  if (said === null)
    return `the restore failed before the client reported any progress, so how much of the image reached ${where} is not known (possibly none)`
  // Review 4: the client's completion line followed by a failure is not
  // "no amount above zero"; it is a complete report that the exit contradicts.
  if (progress.lastLine === null)
    return `the client printed '${maskSecretValues(said, [secret])}' and then failed, so whether the whole image reached ${where} is not proven`
  return `the client printed '${maskSecretValues(said, [secret])}' and then failed without naming an amount above zero, so how much `
    + `of the image reached ${where} is not known (possibly none)`
}

/**
 * A failed whole-image restore that may have left an image that is not proven
 * whole: the job fails with this code (`ImageRestoreFailureCode`), which is the
 * only record a FILE backing has of it (cr3.lunrestore, review2 D).
 */
export function imageRestoreFailure(message: string, code: ImageRestoreFailureCode): Error {
  return Object.assign(new Error(message), { jobErrorCode: code })
}

/** The classification itself — over the raw stderr, unmasked ({@link explainRestoreFailure}). */
function rawExplainRestoreFailure(stderr: string, signal?: string): string {
  if (signal && !hasImageRestoreErrorText(stderr)) {
    return `The image restore was interrupted - the client was killed by ${signal} `
      + 'and reported no error of its own; what reached the target is whatever its last progress line claimed.'
  }
  const line = firstRestoreError(stderr)
  if (NO_SNAPSHOT_RE.test(stderr)) {
    return `${line} The client reports a missing snapshot, a missing group and a missing NAMESPACE `
      + 'with this same sentence — check the namespace as well as the timestamp.'
  }
  if (NO_ARCHIVE_RE.test(stderr))
    return `${line} That snapshot exists but holds no archive by that name.`
  if (BAD_SUFFIX_RE.test(stderr))
    return `${line} A whole-image restore needs the '<name>.img' archive name, not the stored '.img.fidx' file name.`
  // The auth-vs-privileges split is the ONE classifier's (R5): a bare
  // `permission check failed` is a REJECTED credential, not a permissions
  // problem, and must not read as the Datastore.Audit wording.
  const perm = classifyPermissionFailure(stderr)
  if (perm === 'missing-privileges')
    return `${line} The repository's credential authenticated but is not allowed to read this datastore/namespace.`
  if (perm === 'authentication')
    return `${line} PBS rejected the credential - this is an authentication failure, not a permissions problem (check the password, or the token id and secret).`
  if (NO_PERM_RE.test(stderr))
    return `${line} The repository's credential authenticated but is not allowed to read this datastore/namespace.`
  if (CERT_RE.test(stderr))
    return `${line} The server's TLS certificate does not match the fingerprint pinned on this repository.`
  if (CONNECT_RE.test(stderr) || REFUSED_RE.test(stderr) || DNS_RE.test(stderr) || DEADLINE_RE.test(stderr)) {
    const why = DNS_RE.test(stderr)
      ? 'the server name did not resolve'
      : REFUSED_RE.test(stderr)
        ? 'the connection was refused'
        : DEADLINE_RE.test(stderr)
          ? 'the connection timed out'
          : 'the connection failed'
    return `${line} The PBS server could not be reached (${why}).`
  }
  if (BROKEN_PIPE_RE.test(stderr))
    return `${line} The connection to PBS dropped part-way through the image.`
  return line
}

// ---------------------------------------------------------------------------
// The size pre-check
// ---------------------------------------------------------------------------

/** Read the exact byte size of a restore target: zvol `volsize` or file size. */
export async function readTargetSize(
  executor: CommandExecutor,
  lun: { kind: string, backingPath: string, dataset?: string },
): Promise<{ size: number } | { error: string }> {
  if (lun.kind === 'zvol') {
    const dataset = lun.dataset ?? zvolDataset(lun.backingPath)
    const r = await executor.exec(ZFS, volsizeArgs(dataset))
    if (r.exitCode !== 0) {
      return {
        error: `could not read the size of volume '${dataset}': `
          + `${r.stderr.trim() || `zfs get volsize exited with code ${r.exitCode}`}`,
      }
    }
    const size = Number(r.stdout.trim())
    if (!Number.isFinite(size) || size <= 0)
      return { error: `could not read the size of volume '${dataset}': zfs reported '${r.stdout.trim()}'` }
    return { size }
  }
  try {
    const st = await stat(lun.backingPath)
    return { size: st.size }
  }
  catch (err) {
    return { error: `could not read the size of image file '${lun.backingPath}': ${(err as Error).message}` }
  }
}

/**
 * The refusal a size mismatch earns, with BOTH numbers in it — or null when
 * they are equal.
 *
 * This is the single most important guard in the story, because the failure it
 * prevents is silent and destructive and NOTHING below ANAS does it: a larger
 * image writes until ENOSPC and leaves the LUN half-overwritten, a smaller one
 * exits 0 and leaves stale tail bytes past the image's end (GT-42). There is no
 * confirm code for this — a mismatch is not a risk the operator can accept, it
 * is an operation that cannot produce the LUN they asked for.
 */
export function assertSizeMatch(
  imageSize: number | null,
  targetSize: number,
  ctx: { archive: string, targetPath: string },
): string | null {
  if (imageSize === null) {
    return `The size of archive '${ctx.archive}' is not in the snapshot manifest, so ANAS cannot prove it `
      + `matches ${ctx.targetPath} (${targetSize} bytes). A whole-image restore is refused without that proof: `
      + 'an image larger than the target is written until the device is full and leaves it half-overwritten, '
      + 'and a smaller one leaves stale bytes past its end. Neither PBS nor LIO checks this.'
  }
  if (imageSize === targetSize)
    return null
  // Both directions are named, because both are corruption and they corrupt
  // differently — an operator who only hears "sizes differ" cannot tell which
  // half of their LUN is about to be wrong.
  const tooBig = 'The image is LARGER than the target: the restore would write until the device is full '
    + 'and leave it half-overwritten — the old contents gone, the new ones incomplete.'
  const tooSmall = 'The image is SMALLER than the target: the restore would succeed and leave stale bytes '
    + 'from the old contents past the end of the restored image.'
  const verdict = imageSize > targetSize ? tooBig : tooSmall
  return `Size mismatch: archive '${ctx.archive}' is ${imageSize} bytes, `
    + `${ctx.targetPath} is ${targetSize} bytes. ${verdict} `
    + 'Restore this image onto a target of exactly its own size.'
}

// ---------------------------------------------------------------------------
// Serial + attribute read-back
// ---------------------------------------------------------------------------

/**
 * Compare the LUN as it was before the write with the LUN as it is after.
 *
 * NOTHING in this restore recreates a backstore, and that is the point: the
 * zvol keeps its device node and the image file keeps its inode (opened `'w'`,
 * never unlinked), so LIO is never asked to forget and re-learn the object. The
 * serial and the attributes therefore CANNOT be lost the way they are on a
 * fileio resize, where the backstore genuinely has to be deleted and recreated
 * and `resizeFileLun` replays `wwn=` plus every attribute to keep the disk the
 * same disk (GT-17/GT-18).
 *
 * So this function exists to PROVE that claim rather than to assert it in a
 * comment. Anything it finds changed is reported loudly — if it ever fires, the
 * restore path has grown a recreate and owes the `resizeFileLun` replay.
 */
export function readBackWarnings(before: IscsiLun, after: IscsiLun | undefined): string[] {
  const out: string[] = []
  if (!after) {
    out.push(
      `LUN ${before.index} ('${before.name}') could not be read back after the restore — `
      + 'the image was written, but ANAS cannot confirm the backstore is unchanged.',
    )
    return out
  }
  if (after.backingPath !== before.backingPath) {
    out.push(
      `The backstore now points at '${after.backingPath}' instead of '${before.backingPath}'. `
      + 'The image was written to the original path; this LUN is serving something else.',
    )
  }
  if (after.serial !== before.serial) {
    out.push(
      `The SCSI unit serial changed (${before.serial ?? 'unknown'} -> ${after.serial ?? 'unknown'}). `
      + 'Initiators, ESXi, Windows and PVE volids identify this disk by that serial, so they will see a '
      + 'DIFFERENT disk. Nothing in a restore recreates a backstore, so this came from outside ANAS.',
    )
  }
  const changed = changedAttributes(before.attributes, after.attributes)
  if (changed.length) {
    out.push(
      `Backstore attributes changed across the restore: ${changed.join(', ')}. `
      + 'A restore never recreates a backstore, so nothing in this operation should have touched them.',
    )
  }
  return out
}

/** The attribute keys whose value differs, rendered `key: before -> after`. */
function changedAttributes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const ordered = [...keys]
  ordered.sort()
  const out: string[] = []
  for (const key of ordered) {
    const b = (before ?? {})[key]
    const a = (after ?? {})[key]
    if (b !== a)
      out.push(`${key}: ${String(b)} -> ${String(a)}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// The live-session refusal — ONE sentence, said at BOTH doors
// ---------------------------------------------------------------------------

/**
 * The refusal a live session earns an in-place image restore.
 *
 * It lives here, not in the route, because it is said TWICE and the two sayings
 * must be the same words: once at the request (the entry gate, a 409 with no
 * confirm bypass) and once inside the job, immediately before the TPG is
 * disabled. An operator who hits the second one has already been told the first
 * one's story by the UI, so a differently-worded second refusal would read as a
 * different problem.
 */
export function liveSessionsRefusal(iqn: string, sessions: { initiatorIqn: string }[]): string {
  const initiators = [...new Set(sessions.map(s => s.initiatorIqn))]
  return `${initiators.length} initiator${initiators.length === 1 ? ' is' : 's are'} logged in to `
    + `${iqn} right now: ${initiators.join(', ')}. Restoring an image over a LUN an initiator has `
    + 'open would overwrite the device under a mounted filesystem, and neither LIO nor the initiator '
    + 'would be told. Log the initiator(s) out first.'
}

/**
 * The same refusal, from INSIDE the job, plus the one fact that is only true
 * there: the session was not present when the restore was accepted.
 *
 * A queued restore can sit behind hours of backups (the queue runs four jobs at
 * a time), and open-iscsi and Windows RECONNECT on their own — so the entry
 * gate's verdict is a fact about the past by the time the job runs. Without
 * this re-read the designed "gate, then disable" pair degrades to "disable
 * only": the session comes back during the wait and the image is written under
 * it. What LIO does to an ESTABLISHED session when its TPG is disabled is not
 * ground-truthed (GT-37 measured new logins), so nothing here assumes either
 * way — the restore simply does not start.
 */
export function liveSessionsAtRunRefusal(iqn: string, sessions: { initiatorIqn: string }[]): string {
  return `${liveSessionsRefusal(iqn, sessions)} This session appeared AFTER the restore was accepted — `
    + 'the check at the request passed and this one did not, so the job refused rather than write under it. '
    + 'Nothing was disabled and nothing was written; the target is exactly as it was.'
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface ImageRestoreDeps {
  repo: BackupRepo
  secret: string
  /** The effective namespace (the request's, else the repo's own). */
  namespace?: string
  snapshot: string
  archive: string
  /** The manifest's image size — already proven equal to the target's. */
  imageSize: number
  target: IscsiTargetDetail
  lun: IscsiLun
  /** pbc `--rate`, only when the caller asked for one. */
  rate?: string
  /** The pbc environment builder's output (secrets are env-only, never argv). */
  env: Record<string, string>
  /** Re-read the LIO state for the post-write assertions. */
  readBack: () => Promise<IscsiTargetDetail[]>
  /**
   * Re-read the target's LIVE sessions, NOW — the smallest possible reader,
   * because the only thing the job needs from LIO before it disables anything
   * is whether an initiator is logged in at this instant. Required, never
   * optional: a caller that forgot it would silently lose the gate.
   */
  readSessions: (iqn: string) => Promise<IscsiSession[]>
  /**
   * Re-read the LUN NOW, under the iSCSI lock (story `ident.2`, audit #10):
   * the caller's reader proves the LUN at the index still has the same
   * serial, backstore, backing path and served device (`reverifyServedLun`)
   * and throws if not, then reports the backing object's size as read now.
   * Required, never optional: without it the job writes to whatever the
   * request-time path names by the time it runs.
   */
  reverify: () => Promise<{ target: IscsiTargetDetail, lun: IscsiLun, size: number | null }>
  /** The mutate context the enable/disable pair runs in. */
  mutate: IscsiMutateOptions
}

/**
 * Run one whole-image restore.
 *
 * THE SEQUENCE, and why it is this order:
 *
 *   1. **Re-read the sessions, THEN disable the target's TPG — under the iSCSI
 *      lock, as one step.** The entry gate refused a live session at the
 *      REQUEST; this job may have waited hours in the queue behind other work,
 *      and open-iscsi and Windows RECONNECT, so that verdict is about the past.
 *      The re-read is the same question asked at the moment it matters, and it
 *      shares the lock with the disable so no other iSCSI mutation can slip
 *      between the two. A session here is a hard failure with NOTHING done:
 *      the target is left exactly as found. Disabling then refuses new logins
 *      and hides the target from discovery (GT-37, iSCSI ground truth). It is
 *      the whole TARGET that goes down, not one LUN: LIO's enable flag lives on
 *      the TPG, and every other LUN on that target is unreachable for the
 *      duration. The confirm text says so in those words.
 *   2. **Stream the image in.** `restore <snap> <archive> -` with stdout piped
 *      into a descriptor ANAS opened on the device/file. pbc never sees the
 *      target path, which is the only way past GT-39.
 *   3. **fsync** (inside the executor) — a LUN reported restored must be on the
 *      medium, not in the page cache.
 *   4. **Read back** serial + attributes + backing path and prove they are
 *      unchanged.
 *   5. **Re-enable in a `finally`, under the lock again** — EXCEPT after a
 *      partial write, which is the one case where staying offline is the
 *      correct outcome and an explicit `POST /iscsi/targets/:iqn/state {enable}`
 *      is the operator's acknowledgement.
 *
 * Only what ANAS disabled is re-enabled: a target that was already disabled
 * when the restore started is left exactly as found (guest philosophy).
 *
 * WHERE THE LOCK IS, AND WHY IT IS NOT AROUND THE WHOLE THING: the daemon-wide
 * `withIscsiLock` mutex exists so two `targetcli` runs never touch the tree at
 * once, and this function is its OWNER for a restore — it takes it twice, for
 * the two short targetcli sections, and holds it for neither the image stream
 * nor the read-back. An image restore runs for HOURS; a lock held across it
 * would block every iSCSI mutation on the node for the whole restore, which is
 * a far bigger outage than the one it would prevent. The stream itself needs no
 * mutual exclusion: it writes the LUN's backing object, not the LIO tree. The
 * mutex is NOT reentrant (a plain promise chain), so callers must not wrap this
 * call in another `withIscsiLock` — that deadlocks.
 */
export async function runImageRestore(
  executor: CommandExecutor,
  deps: ImageRestoreDeps,
  updateProgress: (message: string) => void,
): Promise<BackupImageRestoreResult> {
  const { target, lun } = deps
  const kind = lun.kind === 'zvol' ? 'zvol' : 'file'
  const streamTarget = restoreStreamTarget(lun.backingPath, kind)
  const warnings: string[] = []

  let disabledByUs = false
  let reEnabled = false
  let partial: string | null = null
  let bytesWritten = 0
  let duration: string | undefined
  // cr3.backup M5: a failed restore's error carries a failed re-enable.
  let failed = false
  let failure: unknown
  const stillDisabled: string[] = []

  // cr3.lunrestore: the breadcrumb on the volume (a file image carries none).
  const markOn = markDataset(lun.backingPath)
  // cr3.lunrestore (review2 A): the mark ALREADY on the volume when this run
  // starts — an earlier restore that did not finish, or one whose size was not
  // verified. A run removes only the mark it created on a volume that carried
  // none; a run that writes nothing puts this one back exactly.
  let prior: Extract<RestoreMarkRead, { state: 'present' }> | null = null

  // ---- 1. Re-check + disable: ONE locked section --------------------------
  // Under the lock so nothing else can mutate the LIO tree between the answer
  // and the act on it. The refusal is thrown from INSIDE the lock, before the
  // `try`, so a job that stops here has disabled nothing and has no `finally`
  // to unwind — the target is bit-for-bit as the job found it.
  await withIscsiLock(async () => {
    // ident.2 (audit #10): the LUN itself, not just its sessions. The request
    // proved serial, path, served device and size; a queued job re-proves all
    // four before it disables anything, so a LUN re-created at the index or a
    // volume re-created at the path is refused with nothing touched.
    updateProgress(`re-reading LUN ${lun.index} of ${target.iqn} - serial, backing path, served device and size must be unchanged`)
    const now = await deps.reverify()
    if (now.size === null || now.size !== deps.imageSize) {
      throw new Error(`${lun.backingPath} is ${now.size === null ? 'of unknown size' : `${now.size} bytes`} now, not the `
        + `${deps.imageSize} bytes the restore was accepted for - the backing object changed while the job waited. `
        + 'Nothing was disabled and nothing was written.')
    }
    updateProgress(`re-reading the live sessions on ${target.iqn} - the request-time check is not the run-time one`)
    const sessions = await deps.readSessions(target.iqn)
    if (sessions.length > 0)
      throw new Error(liveSessionsAtRunRefusal(target.iqn, sessions))

    // cr3.lunrestore (review2 A): the mark already on the volume, read before
    // anything is touched. A mark that cannot be read refuses the restore here,
    // with nothing done: a run that later wrote nothing could not tell whether
    // it was erasing an earlier restore's record of a partial image. (A mark
    // that IS read never refuses: restoring again is a way out of it.)
    if (markOn !== null) {
      const read = await readRestoreMark(executor, { path: lun.backingPath })
      if (read.state === 'unknown') {
        throw new Error(`ANAS could not read the restore mark ${RESTORE_MARK_PROPERTY} on ${markOn} (${read.reason}), so it cannot `
          + `keep the record an earlier restore may have left there. The restore is refused until the mark can be read. `
          + 'Nothing was disabled and nothing was written.')
      }
      if (read.state === 'present')
        prior = read
    }

    // cr.40 (WAVE3-DESIGN §2.4 "image restore in place"): whether the target
    // is enabled is read NOW, under the lock — not taken from the request's
    // read. A target the operator disabled while the job waited is left
    // disabled (and not re-enabled after); one enabled meanwhile is disabled
    // for the stream like any other.
    if (now.target.enabled) {
      updateProgress(
        `disabling iSCSI target ${target.iqn} for the duration of the restore `
        + `(the whole target goes offline, not just LUN ${lun.index})`,
      )
      await setIscsiTargetState(deps.mutate, now.target, 'disable')
      disabledByUs = true
    }
    else {
      updateProgress(`iSCSI target ${target.iqn} is already disabled - left as found`)
    }
  })

  const mark = writingMark({ repo: deps.repo.name, ...(deps.namespace ? { namespace: deps.namespace } : {}), snapshot: deps.snapshot, archive: deps.archive })
  // Set when the target must stay disabled although nothing partial was
  // written by the stream: an image not proven good, or a mark that could not
  // be cleared (the LUN still reads as a partial image everywhere).
  let keepDisabled: string | null = null
  // An image file the stream's open emptied although nothing was written.
  let fileEmptied = false
  const nothingWritten = (message: string): Error => fileEmptied ? imageRestoreFailure(message, 'IMAGE_PARTIAL') : new Error(message)

  /**
   * Nothing reached the volume: leave its mark as this run found it (review2
   * A). No mark before: remove the one this run set. A mark before: put that
   * value back exactly, and keep the target disabled — the volume still holds
   * the earlier restore's image, and Enable's confirm is the way to accept it.
   * A mark that cannot be put back or removed keeps the target disabled too.
   * Returns the sentence the job error carries ('' when there is none).
   */
  const restorePriorMark = async (): Promise<string> => {
    if (markOn === null) {
      // An image FILE is opened 'w' for the stream, which TRUNCATES it: once
      // the open happened, "nothing was written" still means the old image is
      // gone. Its size says which (an open that failed left it whole).
      if (kind !== 'file')
        return ''
      const size = await readTargetSize(executor, lun)
      if (!('error' in size) && size.size === deps.imageSize)
        return ''
      fileEmptied = true
      keepDisabled = `${lun.backingPath} ${'error' in size ? `could not be re-read (${size.error})` : `is ${size.size} bytes now, not ${deps.imageSize}`}: `
        + `the image file is emptied when it is opened for the restore, so it no longer holds the image it held, and target `
        + `${target.iqn} stays disabled. ${capitalize(fileRestoreAgain(lun.backingPath, deps.imageSize))}`
      return ` ${keepDisabled}.`
    }
    if (prior === null) {
      try {
        await clearRestoreMark(executor, markOn)
        return ''
      }
      catch (err) {
        keepDisabled = `${errorText(err)}; nothing was written, but the volume still reads as a partial image, so target `
          + `${target.iqn} stays disabled: clear the mark with '${clearMarkCommand(markOn)}', then enable the target`
        return ` ${keepDisabled}.`
      }
    }
    const earlier = describeRestoreMark(prior)
    try {
      await putBackRestoreMark(executor, markOn, prior.raw)
      keepDisabled = `${markOn} carries the restore mark of ${earlier} again, as it did before this restore: the LUN holds `
        + `that restore's image, so target ${target.iqn} stays disabled. Enable on the iSCSI screen asks you to confirm `
        + `that you accept that image; restoring again is the other way out`
    }
    catch (err) {
      keepDisabled = `${errorText(err)} (the mark of ${earlier}): ${markOn} carries this restore's mark instead, so it still `
        + `reads as holding a partial image and target ${target.iqn} stays disabled`
    }
    return ` ${keepDisabled}.`
  }

  /** How the operator accepts what is on the LUN — true per backing kind. */
  const wayOut = (what: string): string => markOn !== null
    ? `Enable on the iSCSI screen asks you to confirm that you accept ${what}, and removes the restore mark on ${markOn}`
    : `Enable on the iSCSI screen asks you to confirm that you accept ${what} while ANAS keeps this job's record; `
      + `${JOB_RECORD_LIFETIME}. ${capitalize(fileRestoreAgain(lun.backingPath, deps.imageSize))}`

  /** Turn this run's mark `unverified` with the reason; the clause the job error carries. */
  const markUnverified = async (reason: string): Promise<string> => {
    try {
      await setRestoreMark(executor, markOn!, unverifiedMark(mark, reason))
      return ` and the restore mark on ${markOn} now says the image was not verified`
    }
    catch (markErr) {
      return ` and the restore mark on ${markOn} stays as it was set at the start (${errorText(markErr)})`
    }
  }

  try {
    if (markOn !== null) {
      // No mark, no write: a mark that cannot be set refuses the restore here.
      // Nothing was written; the `finally` re-enables what was disabled unless
      // an earlier mark is still on the volume (then it stays disabled).
      updateProgress(`marking ${markOn} as being restored (${RESTORE_MARK_PROPERTY}) before the first byte is written`)
      try {
        await setRestoreMark(executor, markOn, mark)
      }
      catch (err) {
        // A failed set changed nothing: an earlier mark is still there, and
        // the target is not enabled over it (review2 A).
        if (prior !== null) {
          keepDisabled = `${markOn} still carries the restore mark of ${describeRestoreMark(prior)}, so target ${target.iqn} stays disabled`
        }
        throw new Error(`${errorText(err)}; a restore that cannot leave its mark is refused. Nothing was written to ${lun.backingPath}.`
          + `${keepDisabled ? ` ${keepDisabled}.` : ''}`)
      }
    }
    const args = imageRestoreArgs(deps.snapshot, deps.archive, deps.namespace, deps.rate)
    updateProgress(
      `restoring ${deps.archive} from ${deps.snapshot} into ${lun.backingPath} `
      + `(${deps.imageSize} bytes, streamed to stdout - the client refuses to write an existing target)`,
    )

    let lastPercent = -1
    let r: ExecStreamResult
    try {
      r = await executor.execToStream(PBC, args, streamTarget, {
        env: deps.env,
        // cr.34: a data mover (a whole disk image); no deadline.
        timeoutMs: null,
        longRunning: 'proxmox-backup-client image restore in place: a data mover, hours for a large image',
        onStderr: (chunk) => {
          // GT-59: the interval roughly DOUBLES (6 s, 16 s, 36 s, 79 s), so a
          // multi-hour restore emits a handful of late lines and long silences
          // are normal. Every line pbc does emit is forwarded — masked (cr.48e):
          // the progress SHAPE does not guarantee the CONTENT, and a line
          // matching it can carry an error fragment quoting the repo secret.
          // The percentage parse below reads the raw chunk; only the forwarded
          // line is masked with the secret this restore handed pbc.
          const p = parseRestoreProgress(chunk)
          if (p.percent !== null && p.percent !== lastPercent) {
            lastPercent = p.percent
            updateProgress(`restore ${p.lastLine !== null ? maskSecretValues(p.lastLine, [deps.secret]) : `progress ${p.percent}%`}`)
          }
        },
      })
    }
    catch (err) {
      // cr.48d: a rejection's message (an executor error) is masked the same
      // way the reads mask theirs — the secret rides the child env and can be
      // echoed by anyone, and this message lands in job.error. No
      // classification ever runs on this text; it only ever leaves.
      const said = maskSecretValues(errorText(err), [deps.secret])
      // cr3.lunrestore (review2 B): only the executor can prove the client
      // never started (nothing was written): then the previous state comes
      // back. Every other rejection — a flush that failed after exit 0, a
      // child that died in a way the executor could not report — leaves an
      // unknown amount on the device: the target stays disabled, the mark stays.
      if (err instanceof StreamNotStartedError) {
        const kept = await restorePriorMark()
        throw nothingWritten(`proxmox-backup-client could not be started: ${said}. Nothing was written to ${lun.backingPath}.${kept}`)
      }
      if (err instanceof StreamFlushError) {
        const reason = `the client exited 0, but flushing ${lun.backingPath} to the medium failed (${said})`
        const marked = markOn !== null ? await markUnverified(reason) : ''
        partial = `${reason}: how much of the image is on the medium is not known. Target ${target.iqn} stays disabled${marked}. ${wayOut('the image')}`
        throw imageRestoreFailure(`${partial}.`, 'IMAGE_UNVERIFIED')
      }
      partial = `the image restore into ${lun.backingPath} ended without a result from the client (${said}): how much of `
        + `the image reached it is not known. Target ${target.iqn} stays disabled${markOn !== null ? ` and the restore mark on ${markOn} stays` : ''}. `
        + `${wayOut('the partial image')}`
      throw imageRestoreFailure(`${partial}.`, 'IMAGE_PARTIAL')
    }
    const progress = parseRestoreProgress(r.stderr)
    const written = imageBytesWritten(r.bytesWritten, progress, deps.imageSize, r.exitCode)
    bytesWritten = written.bytes
    if (progress.complete)
      duration = progress.complete

    if (r.exitCode !== 0) {
      // cr.48d: the detail (and through it every sentence that rides the job
      // error and the audit line) is masked against the repo secret this
      // restore handed pbc — a pbc error line that echoes it meets `[secret]`.
      const detail = explainRestoreFailure(r.stderr, r.signal, [deps.secret])
      if (bytesWritten > 0) {
        // The half-written state, stated in the words the story asks for. The
        // device has no marker of its own; this sentence IS the record.
        // cr3.lunrestore (D5 e): the way to accept the state is named.
        partial = `the image was partially written (${written.estimated ? 'at least ' : ''}${bytesWritten} `
          + `of ${deps.imageSize} bytes reached ${lun.backingPath}); the LUN is disabled until you restore `
          + `again or accept the state: ${wayOut('the partial image')}. ${detail}`
        throw imageRestoreFailure(partial, 'IMAGE_PARTIAL')
      }
      if (!failedBeforeWriting(r.stderr, r.signal)) {
        // cr3.lunrestore (review2 B): no byte count and no progress line is not
        // proof that nothing was written — the client opens the device itself
        // (our descriptor never moves) and prints its first progress line only
        // seconds in. Only a failure it reports before fetching any data is.
        // review3 3: and a progress line that names no amount is not "no
        // progress": the sentence says which it was.
        partial = `${unknownAmount(progress, lun.backingPath, deps.secret)}; the LUN is disabled until you restore again or accept the `
          + `state: ${wayOut('the image')}. ${detail}`
        throw imageRestoreFailure(partial, 'IMAGE_PARTIAL')
      }
      // Nothing was written: the volume is as it was, and so is its mark.
      const kept = await restorePriorMark()
      throw nothingWritten(`${detail} Nothing was written to ${lun.backingPath}.${kept}`)
    }

    // review3 6: an exit 0 whose byte count is not the image's (no `restore
    // complete` line, or a descriptor count that disagrees) is not proof of a
    // complete image: unverified below, never a warning beside a re-enable.
    const countGap = exitZeroCountGap(r.bytesWritten, bytesWritten, deps.imageSize, lun.backingPath)

    // ---- Read-back: the disk must still be the same disk -------------------
    updateProgress('verifying the backstore path, unit serial and attributes are unchanged')
    try {
      const after = await deps.readBack()
      const afterTarget = after.find(t => t.iqn === target.iqn)
      warnings.push(...readBackWarnings(lun, afterTarget?.luns.find(l => l.index === lun.index)))
    }
    catch (err) {
      warnings.push(
        `the image was written, but the LIO read-back failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // cr3.lunrestore: the size must be the image's before anything treats the
    // LUN as good — a zvol AND an image file (review2 C: a file that grew or
    // shrank used to be a warning and was re-enabled; a fileio backstore then
    // serves a size LIO does not notice). Unverified: the target stays
    // disabled, the job fails with both numbers or the read error, and a
    // zvol's mark says so.
    const size = await readTargetSize(executor, lun)
    const unverified = 'error' in size
      ? `the size of ${lun.backingPath} could not be re-read (${size.error})`
      : size.size !== deps.imageSize
        ? `${lun.backingPath} is ${size.size} bytes, not the image's ${deps.imageSize}`
        : countGap
    if (unverified !== null) {
      const marked = markOn !== null ? await markUnverified(unverified) : ''
      keepDisabled = `${progress.complete ? 'the client reported the image complete' : 'the client exited 0'}, but ${unverified}: target ${target.iqn} stays disabled${marked}. `
        + `${wayOut('it')}${markOn !== null ? '. Restoring again is the other way out' : ''}`
      throw imageRestoreFailure(`${keepDisabled}.`, 'IMAGE_UNVERIFIED')
    }
    if (markOn !== null) {
      try {
        await clearRestoreMark(executor, markOn)
      }
      catch (markErr) {
        keepDisabled = `the image was restored in full and its size verified, but ${errorText(markErr)}: the volume still `
          + `reads as a partial image, so the target stays disabled. Clear the mark with '${clearMarkCommand(markOn)}', then enable the target`
        throw new Error(`${keepDisabled}.`)
      }
    }
  }
  catch (err) {
    // cr3.backup M5: held, not swallowed — the `finally` below may add the one
    // sentence the operator most needs (the target is still offline), and it
    // rides THIS error, since a warnings list never reaches anyone on failure.
    failed = true
    failure = err
  }
  finally {
    // A partial write is the ONE case that stays offline: serving half an image
    // is worse than serving nothing, and the operator's explicit re-enable is
    // the acknowledgement. Everything else — including a failure that wrote no
    // bytes — gets the target back.
    if (disabledByUs && !partial && !keepDisabled) {
      try {
        updateProgress(`re-enabling iSCSI target ${target.iqn}`)
        // The lock again, for the same reason it was taken to disable: this is
        // a targetcli run plus a `saveconfig`, and it must not interleave with
        // another mutation. It is a SECOND acquisition, not a nested one — the
        // stream ran with the lock released.
        await withIscsiLock(async () => setIscsiTargetState(deps.mutate, target, 'enable'))
        reEnabled = true
      }
      catch (err) {
        // No `throw` in a `finally`: it would REPLACE the restore's own error,
        // which is always the more informative one. It is said loudly instead.
        stillDisabled.push(
          `THE TARGET IS STILL DISABLED: re-enabling ${target.iqn} failed `
          + `(${err instanceof Error ? err.message : String(err)}). No initiator can log in until you `
          + `enable it again from the iSCSI screen.`,
        )
      }
    }
  }
  warnings.push(...stillDisabled)
  if (failed)
    throw withStateLeftBehind(failure, stillDisabled)

  const result: BackupImageRestoreResult = {
    snapshot: deps.snapshot,
    archive: deps.archive,
    targetIqn: target.iqn,
    lunIndex: lun.index,
    targetPath: lun.backingPath,
    imageSize: deps.imageSize,
    bytesWritten,
    complete: true,
    targetDisabled: disabledByUs,
    targetReEnabled: reEnabled,
  }
  if (duration)
    result.duration = duration
  if (warnings.length)
    result.warnings = warnings
  return result
}

// ---------------------------------------------------------------------------
// Restore as a NEW LUN (story backup2.10)
// ---------------------------------------------------------------------------

export interface NewLunRestoreDeps {
  repo: BackupRepo
  secret: string
  /** The effective namespace (the request's, else the repo's own). */
  namespace?: string
  snapshot: string
  archive: string
  /** The manifest's image size — the new backing is created at EXACTLY this. */
  imageSize: number
  /**
   * The destination target as the REQUEST read it — ANAS-owned, the route's
   * pre-flight proved it. It names the target (IQN, TPG tag) and nothing else:
   * the index and the ACL grants come from {@link refreshAfterCreate}.
   */
  target: IscsiTargetDetail
  /**
   * Re-read the destination target NOW and re-run EVERY gate of the route on
   * it (LIO installed and not degraded, the target there and ANAS's, the name
   * still free node-wide, the backing on ANAS storage at the confirmed path);
   * throws the gate's refusal (story cr.40, audit #34). Called once before
   * anything is created, and again UNDER the iSCSI lock right before the
   * backstore is created — while the name is still free. Required.
   */
  refresh: () => Promise<IscsiTargetDetail>
  /**
   * Re-read once THIS run's backstore exists (cr3.lunrestore): the target and
   * the whole iSCSI state as they are now, with every gate that still applies
   * — LIO saveable, the target there and ANAS's, the backing at the confirmed
   * path — but NOT the name gates, which this run's own backstore (or the copy
   * of it a save persisted) now answers. Called under the iSCSI lock right
   * before the map (the index and the ACL grants are this answer's), and before
   * a failed run saves away a copy of its backstore another verb persisted.
   * Throws the gate's refusal. Required.
   */
  refreshAfterCreate: () => Promise<TargetObject>
  /** The new LUN's name — the backstore name and the SCSI model string. */
  name: string
  /**
   * The resolved backing — its pool/dataset was already refused if it is not
   * ANAS-managed. The path does NOT exist yet; this run creates it.
   */
  backing: ResolvedBacking
  /**
   * Present when a file backing lands on an AHR pool — the fstab file and the
   * pool whose mount must win the boot race against LIO (story iscsi.8).
   */
  ahr?: { fstabPath: string, pool: { name: string, mountpoint: string } }
  /** pbc `--rate`, only when the caller asked for one. */
  rate?: string
  /** The pbc environment builder's output (secrets are env-only, never argv). */
  env: Record<string, string>
  /** The mutate context the targetcli steps run in. */
  mutate: IscsiMutateOptions
  /**
   * The job's lock release (story cr.38: `ctx.release()`), called the moment
   * the BACKSTORE exists (cr3.lunrestore; it used to be the map). The job holds
   * the target's key and the backing's keys while it creates the backing and
   * the backstore, and gives them back for the stream, which writes only the
   * new backing object and can run for hours. From then on the unmapped
   * backstore is what holds the backing against a dataset or pool verb (its
   * claim, `unmappedBackstoreClaims`). Absent = no lock.
   */
  release?: () => void
  /**
   * Take the keys back after {@link release} (cr.38: `ctx.reacquire()`):
   * before the map, which changes the target, and before a failed run's undo,
   * which deletes the backstore and destroys the backing — each waits its turn
   * behind whatever took a key during the stream.
   */
  reacquire?: () => Promise<void>
  /**
   * cr3.backup (iSCSI review): the storage objects the SAVED LIO configuration
   * holds right now (`saveconfig.json`), or null when it cannot be read — what
   * a failed run's cleanup asks to learn whether another verb's `saveconfig`
   * persisted this run's backstore during the stream. Absent = not checked.
   */
  persistedBackstores?: () => Promise<{ name: string, wwn: string | null }[] | null>
  /**
   * cr3.lunrestore (review D2/D4/N1): the live LIO state NOW, with no gate —
   * what the cleanup reads, under the iSCSI lock, to prove a backstore of this
   * name is THIS run's before it deletes anything, and what a failed map reads
   * to learn whether the map landed anyway. Throws when it cannot be read.
   * Required.
   */
  readLive: () => Promise<{ ctx: IscsiReadContext }>
}

/**
 * The `zfs create` argv for the new LUN's zvol backing — the SAME builder the
 * dataset door uses (one copy of the volume-create arguments, not two):
 * a sparse volume of exactly the image's size.
 */
export function newLunZvolCreateArgs(dataset: string, size: number): string[] {
  return buildCreateArgs(dataset, {
    path: dataset,
    type: 'volume',
    sparse: true,
    volsize: size,
  } satisfies CreateDatasetRequest)
}

/**
 * Why this run's backstore may not be mapped now, or null when it may
 * (cr3.lunrestore, point 4). Between the backstore create and the map the
 * iSCSI lock was released for the stream; the name is node-global (GT-15) and
 * the map reads the state again, so anything that changed the backstore in
 * between — deleted by hand, recreated under the same name, mapped by hand —
 * is refused here, never mapped over and never failed obscurely by targetcli.
 * The index is not planned ahead: it is the lowest free one of the target as
 * read under the lock now.
 */
export function ownBackstoreRefusal(
  state: Pick<TargetObject['state'], 'ctx'>,
  backstore: { name: string, plugin: string, backingPath: string, serial: string },
): string | null {
  const { name, plugin, backingPath, serial } = backstore
  const live = state.ctx.live.backstores.find(b => b.name === name && normalizePlugin(b.plugin) === plugin)
  if (!live)
    return `backstore '${name}' is no longer in the live configuration (it was deleted while the image was written)`
  if ((live.serial ?? '').toLowerCase() !== serial.toLowerCase()) {
    return `backstore '${name}' now carries the unit serial ${live.serial ?? '(unreadable)'}, not the ${serial} this restore `
      + `created it with: it is no longer this restore's backstore`
  }
  if (live.udevPath !== backingPath)
    return `backstore '${name}' now points at ${live.udevPath}, not at ${backingPath}`
  const mappedBy = state.ctx.live.targets.flatMap(t => t.tpgs.flatMap(g => g.luns
    .filter(l => l.backstoreName === name)
    .map(l => `LUN ${l.index} of ${t.iqn}${g.tag === 1 ? '' : ` (TPG ${g.tag})`}`)))
  if (mappedBy.length > 0)
    return `backstore '${name}' was mapped as ${mappedBy.join(', ')} by something else while the image was written`
  return null
}

/**
 * Run one whole-image restore that lands as a NEW LUN (story backup2.10;
 * reordered by cr3.lunrestore).
 *
 * THE RULE: a new-LUN restore never exposes an image that is not completely
 * written. The LUN is mapped, its ACLs granted and the configuration saved
 * only AFTER the stream ended with exit 0 and the size read back confirmed it.
 * And the object carries a BREADCRUMB while it is not proven whole (operator
 * ruling 2026-11-14): the restore mark (`anas:restore`, `restore-mark.ts`) on
 * the volume, set before the first byte and removed only once the size is
 * verified.
 *
 * THE SEQUENCE, and why it is this order:
 *
 *   1. **Create the backing at exactly the manifest size** — `zfs create -s -V`
 *      for a zvol, a sparse image for fileio (GT-42 by construction) — and, on
 *      a zvol, **set the restore mark** before anything can write to it. A mark
 *      that cannot be set refuses the restore: no mark, no write.
 *   2. **Create the backstore and set its attributes — and map nothing**
 *      ({@link createLunBackstore}) with a FRESH serial: a copy is a new disk
 *      (GT-14/15/16). A backstore no TPG LUN points at is no disk to any
 *      initiator (GT-13; GT-11: a separate array of the saved configuration),
 *      so a `saveconfig` another verb runs during the stream persists a storage
 *      object with no LUN. It holds the backing while it exists (GT-40), and
 *      its claim makes every dataset, pool and AHR verb refuse on the backing.
 *   3. **Stream the image in.** A stream that does not exit 0 is provably
 *      partial: the run is undone (the backstore — re-read and proved this
 *      run's own first — then the backing).
 *   4. **Read the size back.** From here on NOTHING is destroyed (review D3,
 *      ruling): a read that fails or disagrees is not mapped; the backstore and
 *      the backing are kept, and the mark turns `unverified` with the reason,
 *      so nothing treats the image as good.
 *   5. **Remove the mark** (the image is complete and verified), then **map at
 *      the lowest free index, grant to every ACL, save** — under the lock,
 *      after a re-read that refuses if the backstore is no longer this run's
 *      ({@link ownBackstoreRefusal}). A failure keeps the image and says how to
 *      map it or remove it.
 *
 * The source LUN is never touched. WHERE THE LOCK IS (the #52 shape): the
 * daemon-wide mutex is taken for the backstore create, for the map + grants +
 * save, and for each targetcli step of an undo — never across the stream. The
 * job's keys go back once the backstore exists and are taken again right after
 * the stream, before anything else acts.
 *
 * A CRASH at any point leaves either no LUN at all — at most a marked volume
 * and an unmapped backstore, which the health read and the dashboard name as
 * an interrupted restore — or, after the map, a LUN whose image is complete.
 */
export async function runNewLunImageRestore(
  executor: CommandExecutor,
  deps: NewLunRestoreDeps,
  updateProgress: (message: string) => void,
): Promise<BackupImageRestoreResult> {
  const { target, backing } = deps
  const kind: 'zvol' | 'file' = backing.plugin === 'block' ? 'zvol' : 'file'
  const streamTarget = restoreStreamTarget(backing.path, kind)
  // The volume the restore mark lives on; null for an image file (no mark).
  const markOn = markDataset(backing.path)
  const mark = writingMark({ repo: deps.repo.name, ...(deps.namespace ? { namespace: deps.namespace } : {}), snapshot: deps.snapshot, archive: deps.archive })

  let bytesWritten = 0
  let duration: string | undefined
  let serial = ''
  // review3 6: what an exit 0 said about the byte count.
  let reportedComplete = false
  let countGap: string | null = null
  // What this run has created so far — the cleanup's work list. `released`:
  // the job's keys were given back for the stream.
  const state = { backingCreated: false, backstoreAttempted: false, released: false }
  // cr3.lunrestore (review2 B): a stream that REJECTED after the client may
  // have run (a flush that failed after exit 0, a child the executor lost):
  // how much of the image is there is unknown, and it may be all of it — so
  // nothing is destroyed. Handled after the undo block, never by it.
  let rejected: unknown = null

  try {
    // ---- 0. The destination as it is NOW (cr.40) ---------------------------
    updateProgress(`re-reading iSCSI target ${target.iqn} - the request-time read is not the run-time one`)
    await deps.refresh()

    // ---- 1. The backing at exactly the manifest's size, then the mark -------
    if (kind === 'zvol') {
      const dataset = backing.dataset ?? zvolDataset(backing.path)
      updateProgress(`creating volume ${dataset} at exactly the image's size (${deps.imageSize} bytes)`)
      const r = await executor.exec(ZFS, newLunZvolCreateArgs(dataset, deps.imageSize))
      if (r.exitCode !== 0) {
        throw new Error(
          `could not create the new volume ${dataset} at the image's size: `
          + `${r.stderr.trim() || `zfs create exited with code ${r.exitCode}`}`,
        )
      }
    }
    else {
      updateProgress(`creating sparse image ${backing.path} at exactly the image's size (${deps.imageSize} bytes)`)
      await createSparseImage(backing.path, deps.imageSize)
    }
    state.backingCreated = true
    if (markOn !== null) {
      // The breadcrumb, before anything can write: no mark, no write.
      updateProgress(`marking ${markOn} as being restored (${RESTORE_MARK_PROPERTY}) before the first byte is written`)
      await setRestoreMark(executor, markOn, mark)
    }

    // The moment the image lands on an AHR pool, that pool's boot ordering
    // starts to matter (live-proof F2).
    if (deps.ahr) {
      const added = await ensureAhrTargetOrdering(executor, deps.ahr.fstabPath, deps.ahr.pool)
      if (added)
        updateProgress(`Ordered the mount of AHR pool '${deps.ahr.pool.name}' before the iSCSI restore service`)
    }

    // ---- 2. The backstore, NOT mapped: a FRESH serial — a copy is a new disk
    serial = newSerial()
    updateProgress(
      `creating backstore ${deps.name} with a fresh unit serial (a copy is a NEW disk; the source LUN keeps its own). `
      + 'It is not mapped as a LUN until the whole image is written and verified',
    )
    await withIscsiLock(async () => {
      // cr.40: the target and every gate again, under the lock, while the name
      // is still free; the ACL names the map will grant to are checked now.
      const fresh = await deps.refresh()
      const acls = aclNamesRefusal(fresh.iqn, fresh.acls)
      if (acls)
        throw new Error(acls.message)
      // D4: from here on the cleanup re-reads for a backstore of this name and
      // THIS serial — a create that failed (or timed out) after taking effect
      // is found and removed by that read, not by a flag.
      state.backstoreAttempted = true
      await createLunBackstore(deps.mutate, deps.name, backing, kind === 'file' ? deps.imageSize : null, serial)
    })
    deps.release?.()
    state.released = deps.release !== undefined

    // ---- 3. The image -------------------------------------------------------
    const args = imageRestoreArgs(deps.snapshot, deps.archive, deps.namespace, deps.rate)
    updateProgress(
      `restoring ${deps.archive} from ${deps.snapshot} into the new backing ${backing.path} `
      + `(${deps.imageSize} bytes, streamed to stdout - the client refuses to write an existing target)`,
    )
    let lastPercent = -1
    let r: ExecStreamResult
    try {
      r = await executor.execToStream(PBC, args, streamTarget, {
        env: deps.env,
        // cr.34: a data mover (a whole disk image); no deadline.
        timeoutMs: null,
        longRunning: 'proxmox-backup-client image restore to a new backing: a data mover, hours for a large image',
        onStderr: (chunk) => {
          // GT-59, masked (cr.48e).
          const p = parseRestoreProgress(chunk)
          if (p.percent !== null && p.percent !== lastPercent) {
            lastPercent = p.percent
            updateProgress(`restore ${p.lastLine !== null ? maskSecretValues(p.lastLine, [deps.secret]) : `progress ${p.percent}%`}`)
          }
        },
      })
    }
    catch (err) {
      // cr.48d: masked. cr3.lunrestore (review2 B): only a client that never
      // started is "nothing written" — that run is undone like any provably
      // incomplete one. Any other rejection is kept (below).
      if (err instanceof StreamNotStartedError) {
        throw new Error(`proxmox-backup-client could not be started: ${maskSecretValues(errorText(err), [deps.secret])}. `
          + `Nothing was written to the new backing ${backing.path}.`)
      }
      rejected = err
    }
    if (rejected === null) {
      const progress = parseRestoreProgress(r!.stderr)
      const written = imageBytesWritten(r!.bytesWritten, progress, deps.imageSize, r!.exitCode)
      bytesWritten = written.bytes
      if (progress.complete)
        duration = progress.complete
      // review3 6: an exit 0 the byte count does not prove is unverified (below).
      reportedComplete = progress.complete !== null
      countGap = exitZeroCountGap(r!.bytesWritten, bytesWritten, deps.imageSize, backing.path)

      if (r!.exitCode !== 0) {
        const detail = explainRestoreFailure(r!.stderr, r!.signal, [deps.secret])
        if (bytesWritten > 0) {
          throw new Error(
            `the image was partially written (${written.estimated ? 'at least ' : ''}${bytesWritten} `
            + `of ${deps.imageSize} bytes reached the new backing ${backing.path}); it was never mapped as a LUN. ${detail}`,
          )
        }
        if (!failedBeforeWriting(r!.stderr, r!.signal)) {
          throw new Error(`${unknownAmount(progress, `the new backing ${backing.path}`, deps.secret)}; it was never mapped as a LUN. ${detail}`)
        }
        throw new Error(`${detail} Nothing was written to the new backing ${backing.path}.`)
      }
    }
  }
  catch (err) {
    // Provably partial (or nothing written): undo what this run made, under
    // the job's keys again.
    const base = err instanceof Error ? err.message : String(err)
    if (state.released)
      await deps.reacquire?.()
    const cleanup = await removeNewLun(executor, deps, serial, state)
    if (cleanup)
      throw new Error(`${base} ${cleanup}`)
    throw err
  }

  // ---- The stream exited 0 (or may have): from here on NOTHING is destroyed (D3)
  if (state.released)
    await deps.reacquire?.()
  const plugin = backing.plugin
  const keptHow = (targetUsable: boolean, image: KeptImage = 'complete'): string => keptSentence(deps, target, plugin, serial, targetUsable, image)

  if (rejected !== null) {
    const said = maskSecretValues(errorText(rejected), [deps.secret])
    if (rejected instanceof StreamFlushError) {
      const reason = `the client exited 0, but flushing ${backing.path} to the medium failed (${said})`
      let marked = ''
      if (markOn !== null) {
        try {
          await setRestoreMark(executor, markOn, unverifiedMark(mark, reason))
          marked = ` ${markOn} keeps its restore mark, now saying the image was not verified, so nothing treats it as good.`
        }
        catch (markErr) {
          marked = ` ${markOn} keeps its restore mark from the start of the restore (${errorText(markErr)}).`
        }
      }
      throw imageRestoreFailure(`${reason}, so it was not mapped as a LUN: how much of the image is on the medium is not known.`
        + `${marked}${keptHow(true, 'unverified')}`, 'IMAGE_UNVERIFIED')
    }
    throw imageRestoreFailure(`the image restore into the new backing ${backing.path} ended without a result from the client (${said}), `
      + `so it was not mapped as a LUN: how much of the image reached it is not known.`
      + `${markOn !== null ? ` ${markOn} keeps its restore mark, so nothing treats the image as good.` : ''}${keptHow(true, 'unknown')}`, 'IMAGE_PARTIAL')
  }

  // ---- 4. Read-back: the new object must hold exactly the image ------------
  updateProgress('verifying the new backing holds exactly the image')
  const size = await readTargetSize(executor, { kind, backingPath: backing.path, dataset: backing.dataset })
  const unverified = 'error' in size
    ? `the size of ${backing.path} could not be re-read (${size.error})`
    : size.size !== deps.imageSize
      ? `${backing.path} is ${size.size} bytes, not the image's ${deps.imageSize}`
      : countGap
  if (unverified !== null) {
    let marked = ''
    if (markOn !== null) {
      try {
        await setRestoreMark(executor, markOn, unverifiedMark(mark, unverified))
        marked = ` ${markOn} keeps its restore mark, now saying the size was not verified, so nothing treats the image as good.`
      }
      catch (markErr) {
        marked = ` ${markOn} keeps its restore mark from the start of the restore (${markErr instanceof Error ? markErr.message : String(markErr)}).`
      }
    }
    throw imageRestoreFailure(
      `${reportedComplete ? 'the client reported the image complete' : 'the client exited 0'}, but ${unverified}, so it was not mapped as a LUN.${marked}${keptHow(true, 'unverified')}`,
      'IMAGE_UNVERIFIED',
    )
  }

  // ---- 5. Verified: remove the mark, then map, grant, save ------------------
  if (markOn !== null) {
    try {
      await clearRestoreMark(executor, markOn)
    }
    catch (markErr) {
      throw new Error(
        `the image was restored in full and its size verified, but ${markErr instanceof Error ? markErr.message : String(markErr)}, `
        + `so it was not mapped as a LUN: a marked volume reads as a partial image everywhere. Clear it with `
        + `'${clearMarkCommand(markOn)}'.${keptHow(true)}`,
      )
    }
  }

  let mappedAt: { iqn: string, tag: number, index: number } | null = null
  let index = 0
  let mapTarget: { iqn: string, tag: number } = { iqn: target.iqn, tag: target.tpgTag }
  updateProgress(`the image is complete and verified: mapping ${deps.name} as a LUN on ${target.iqn}`)
  try {
    await withIscsiLock(async () => {
      let now: TargetObject
      try {
        now = await deps.refreshAfterCreate()
      }
      catch (err) {
        // The target refused (gone, hands-off, LIO not saveable): the image is
        // kept, and the operator is not told to map into that target (N2).
        throw new NotMappedError(`it could not be mapped as a LUN: ${errorText(err)}`, false, true)
      }
      mapTarget = { iqn: now.target.iqn, tag: now.target.tpgTag }
      const refused = ownBackstoreRefusal(now.state, { name: deps.name, plugin, backingPath: backing.path, serial })
      if (refused)
        throw new NotMappedError(refused, true, false)
      try {
        index = await mapLunIntoTarget(
          { ...deps.mutate, onLunMapped: (n) => { mappedAt = { iqn: now.target.iqn, tag: now.target.tpgTag, index: n } } },
          now.target,
          deps.name,
          plugin,
        )
      }
      catch (err) {
        throw new NotMappedError(`mapping it as a LUN on ${now.target.iqn} failed: ${errorText(err)}`, true, true)
      }
      updateProgress('Saving the LIO configuration')
      try {
        await saveIscsiConfig(executor)
      }
      catch (err) {
        throw new SaveFailedError(errorText(err))
      }
    })
  }
  catch (err) {
    if (err instanceof SaveFailedError) {
      // cr3 review (8): complete and mapped; only the save failed.
      throw new Error(
        `the image was restored in full and LUN ${index} ('${deps.name}') on ${target.iqn} is live, but saving the iSCSI `
        + `configuration failed: ${err.message}; it will not survive a restart of the target service until the `
        + `configuration is saved: retry with any iSCSI change.`,
      )
    }
    const notMapped = err instanceof NotMappedError ? err : new NotMappedError(errorText(err), true, true)
    // N1: a map that reported a failure may still have landed (a timeout after
    // the act). The live tree is read again before the outcome is worded, and
    // any LUN mapping this run's backstore — partial grants and all — is
    // removed; what could not be removed is said.
    let unmapped = ''
    const partial = mappedAt as { iqn: string, tag: number, index: number } | null
    let landed: { iqn: string, tag: number, index: number }[] = partial ? [partial] : []
    if (notMapped.backstoreIsOurs) {
      try {
        const live = await withIscsiLock(async () => deps.readLive())
        landed = live.ctx.live.targets.flatMap(t => t.tpgs.flatMap(g => g.luns
          .filter(l => l.backstoreName === deps.name)
          .map(l => ({ iqn: t.iqn, tag: g.tag, index: l.index }))))
      }
      catch (readErr) {
        if (partial === null)
          unmapped = ` ANAS could not read the live configuration back to check whether the map landed anyway (${errorText(readErr)}).`
      }
    }
    for (const l of landed) {
      try {
        await withIscsiLock(async () => runTargetcli(executor, [`${tpgPath(l.iqn, l.tag)}/luns`, 'delete', `lun${l.index}`]))
        unmapped += ` ANAS removed the partial mapping (LUN ${l.index}).`
      }
      catch (unmapErr) {
        unmapped += ` The partial mapping could not be removed (${errorText(unmapErr)}): LUN ${l.index} on ${l.iqn} serves the `
          + `complete image but may not be granted to every initiator, and it is not saved.`
      }
    }
    const kept = notMapped.backstoreIsOurs
      ? keptSentence(deps, { iqn: mapTarget.iqn, tpgTag: mapTarget.tag }, plugin, serial, notMapped.targetUsable)
      : ` ${backing.path} is kept; ANAS did not touch the backstore named '${deps.name}'.`
    throw new Error(`the image was restored in full into ${backing.path}, but ${sentenceBody(notMapped.message)}.${unmapped}${kept}`)
  }

  const result: BackupImageRestoreResult = {
    snapshot: deps.snapshot,
    archive: deps.archive,
    targetIqn: target.iqn,
    lunIndex: index,
    targetPath: backing.path,
    imageSize: deps.imageSize,
    bytesWritten,
    complete: true,
    targetDisabled: false,
    targetReEnabled: false,
    newLun: { targetIqn: target.iqn, index, name: deps.name, serial, backingPath: backing.path },
  }
  if (duration)
    result.duration = duration
  return result
}

const TRAILING_STOPS_RE = /[\s.]+$/
/** zfs's stderr for a named dataset that is not there (N8). */
const ZFS_DATASET_ABSENT_RE = /dataset does not exist/
const NO_BYPASS_RE = /\s*This refusal has no confirm bypass\.?/g

/** A refusal's message as the middle of a job sentence: no route-only phrase, no trailing stop (N2). */
function sentenceBody(message: string): string {
  return message.replace(NO_BYPASS_RE, '').replace(TRAILING_STOPS_RE, '')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What a kept, complete-or-unverified image is and what to do with it (N2):
 * map it into the target only when that target can take it; otherwise say so.
 */
/**
 * What a kept image is known to be (cr3.lunrestore, review2 F4): `complete` —
 * written and verified; `unverified` — the client reported it complete and
 * ANAS could not confirm it; `unknown` — the client's end was not seen, so it
 * may be partial.
 */
type KeptImage = 'complete' | 'unverified' | 'unknown'

function keptSentence(
  deps: NewLunRestoreDeps,
  target: { iqn: string, tpgTag: number },
  plugin: string,
  serial: string,
  targetUsable: boolean,
  image: KeptImage = 'complete',
): string {
  const dataset = markDataset(deps.backing.path)
  const remove = `delete it with 'targetcli /backstores/${plugin} delete ${deps.name}', then ${dataset ? `'zfs destroy ${dataset}'` : `delete ${deps.backing.path}`}`
  const mapCmd = `map it with 'targetcli ${tpgPath(target.iqn, target.tpgTag)}/luns create /backstores/${plugin}/${deps.name}' and `
    + `grant it to the initiators (the next iSCSI change in ANAS saves the configuration)`
  const map = image === 'unknown'
    ? `It may hold a partial image: ${remove}, and restore the image again.`
    : image === 'unverified'
      ? `If you have checked the image and want to serve it, ${dataset ? `clear the restore mark with '${clearMarkCommand(dataset)}', then ` : ''}${mapCmd}; otherwise ${remove}.`
      : targetUsable
        ? `To serve it, ${mapCmd}; or ${remove}.`
        : `Target ${target.iqn} cannot take it as it is (above): map it into a target ANAS manages with targetcli, or ${remove}.`
  return ` The backstore '${deps.name}' (unit serial ${serial}) and ${deps.backing.path} are kept, not mapped as a LUN. ${map}`
}

/** The map step refused or failed after a complete image (cr3.lunrestore) — nothing of the image is undone. */
class NotMappedError extends Error {
  /**
   * `backstoreIsOurs`: false when the refusal is that the backstore is no
   * longer this run's. `targetUsable`: false when the target itself refused
   * (gone, hands-off, LIO not saveable) — the kept sentence then does not tell
   * the operator to map into it (N2).
   */
  constructor(message: string, readonly targetUsable: boolean, readonly backstoreIsOurs: boolean) {
    super(message)
    this.name = 'NotMappedError'
  }
}

/** The final save failed after a complete map (cr3 review (8)) — the LUN is kept, live and unsaved. */
class SaveFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaveFailedError'
  }
}

/**
 * Remove what a failed new-LUN restore created — only ever after a stream that
 * did not exit 0, or a failure before the stream: an image that may be
 * complete is never destroyed (D3).
 *
 * The backstore is deleted only when a re-read UNDER THE LOCK proves it is this
 * run's (review D2/D4): the name and plugin, this run's fresh serial, exactly
 * this backing path, and mapped by nothing — the map step's own identity check
 * ({@link ownBackstoreRefusal}). That read also finds a backstore whose create
 * timed out after taking effect. A backstore of the name that is not this
 * run's is left and named. The backing is destroyed only when no live
 * backstore holds it any more. Nothing is said to "remain" that the re-read did
 * not prove gone.
 */
async function removeNewLun(
  executor: CommandExecutor,
  deps: NewLunRestoreDeps,
  serial: string,
  state: { backingCreated: boolean, backstoreAttempted: boolean },
): Promise<string> {
  if (!state.backingCreated && !state.backstoreAttempted)
    return ''

  const { backing } = deps
  const removed: string[] = []
  const left: string[] = []
  let ourBackstoreGone = !state.backstoreAttempted
  let backingHeldBy: string | null = null
  let liveUnread = false

  if (state.backstoreAttempted || state.backingCreated) {
    try {
      await withIscsiLock(async () => {
        const live = await deps.readLive()
        const own = ownBackstoreRefusal(live, { name: deps.name, plugin: backing.plugin, backingPath: backing.path, serial })
        const named = live.ctx.live.backstores.find(b => b.name === deps.name && normalizePlugin(b.plugin) === backing.plugin)
        if (state.backstoreAttempted && own === null) {
          try {
            // The parent form GT-42 proves.
            await runTargetcli(executor, [`/backstores/${backing.plugin}`, 'delete', deps.name])
            removed.push(`backstore '${deps.name}'`)
            ourBackstoreGone = true
          }
          catch (err) {
            const msg = errorText(err)
            if (NO_SUCH_OBJECT_RE.test(msg))
              ourBackstoreGone = true
            else
              left.push(`backstore '${deps.name}' could not be deleted (${msg})`)
          }
        }
        else if (state.backstoreAttempted && !named) {
          // Never created, or gone by hand: nothing of this run's is there.
          ourBackstoreGone = true
        }
        else if (named) {
          left.push(`a backstore named '${deps.name}' that is not this restore's is in the live configuration (${own}); ANAS left it as it is`)
          ourBackstoreGone = !state.backstoreAttempted || (named.serial ?? '').toLowerCase() !== serial.toLowerCase()
        }
        // Whatever still holds the backing after the delete keeps it alive.
        const holder = live.ctx.live.backstores.find(b => b.udevPath === backing.path
          && !(ourBackstoreGone && b.name === deps.name && normalizePlugin(b.plugin) === backing.plugin && (b.serial ?? '').toLowerCase() === serial.toLowerCase()))
        backingHeldBy = holder ? holder.name : null
      })
    }
    catch (err) {
      liveUnread = true
      left.push(`the live iSCSI configuration could not be read to prove which backstore is this restore's (${errorText(err)}), `
        + `so ANAS deleted nothing: check for backstore '${deps.name}' with 'targetcli ls /backstores'`)
    }
  }

  if (state.backingCreated) {
    if (liveUnread) {
      left.push(`${backingWhat(backing)} is kept`)
    }
    else if (backingHeldBy !== null) {
      left.push(`${backingWhat(backing)} is kept, because backstore '${backingHeldBy}' still holds it`)
    }
    else {
      try {
        if (backing.plugin === 'block') {
          const dataset = backing.dataset ?? zvolDataset(backing.path)
          const r = await executor.exec(ZFS, ['destroy', '--', dataset])
          if (r.exitCode !== 0) {
            const line = r.stderr.trim() || `zfs destroy ${dataset} exited with code ${r.exitCode}`
            // N8: renamed (or destroyed) by hand while the image was written.
            throw new Error(ZFS_DATASET_ABSENT_RE.test(line)
              ? `it is no longer at that name (${line}): it was renamed or destroyed by hand while the image was written; if it was renamed, the volume under its new name holds a partial image and carries the restore mark ${RESTORE_MARK_PROPERTY}`
              : line)
          }
          removed.push(`volume ${dataset}`)
        }
        else {
          await unlink(backing.path)
          removed.push(`image ${backing.path}`)
        }
      }
      catch (err) {
        left.push(`${backingWhat(backing)} could not be destroyed (${errorText(err)})`)
      }
    }
  }

  // The save-away (cr3.backup, carried over; N4: whenever THIS run's backstore
  // is gone from the live tree, whatever happened to the backing): a copy of
  // it another verb's `saveconfig` persisted during the stream would come back
  // at boot. Read the saved configuration (the system's own record); when it
  // holds THIS run's backstore (name AND fresh serial), save the live tree once
  // more under the lock, after the gates that still apply are re-proved.
  if (state.backstoreAttempted && ourBackstoreGone && !liveUnread && deps.persistedBackstores) {
    const persisted = await deps.persistedBackstores().catch(() => null)
    if (persisted === null) {
      left.push(`the saved LIO configuration could not be read to check whether another iSCSI change persisted `
        + `backstore '${deps.name}' during the restore - if it did, it comes back, not mapped as a LUN, at the next boot; `
        + `the iSCSI dashboard card names it`)
    }
    else if (persisted.some(o => o.name === deps.name && o.wwn !== null && o.wwn === serial)) {
      try {
        await withIscsiLock(async () => {
          await deps.refreshAfterCreate()
          await saveIscsiConfig(executor)
        })
        removed.push(`the copy of it another iSCSI change had saved during the restore`)
      }
      catch (err) {
        left.push(`another iSCSI change saved backstore '${deps.name}' during the restore and the configuration could `
          + `not be saved again without it (${errorText(err)}) - it comes back, not mapped as a LUN, at the next boot `
          + `until the configuration is saved by any iSCSI change`)
      }
    }
  }

  // cr3 review2 (6): one true sentence per outcome.
  if (!left.length) {
    return `The backstore and its backing were created by this restore and are ANAS's to clean up: `
      + `ANAS has removed ${removed.length ? removed.join(', ') : 'nothing, because nothing of it was left'}, so nothing of the failed restore remains.`
  }
  return `The backstore and its backing were created by this restore: `
    + `${removed.length ? `ANAS removed ${removed.join(', ')}. ` : 'ANAS could not remove any of it. '}`
    + `This was left behind and needs your hand: ${left.join('; ')}.`
}

/** "volume <dataset>" or "image <path>" — the backing, as the cleanup names it. */
function backingWhat(backing: ResolvedBacking): string {
  return backing.plugin === 'block'
    ? `volume ${backing.dataset ?? zvolDataset(backing.path)}`
    : `image ${backing.path}`
}
