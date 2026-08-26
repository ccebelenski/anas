import type {
  BackupImageRestoreResult,
  BackupRepo,
  BackupSnapshot,
  IscsiLun,
  IscsiTargetDetail,
} from '@anas/shared'
import type { CommandExecutor, ExecStreamTarget } from '../executor/types.js'
import type { IscsiMutateOptions } from './iscsi-mutate.js'
import { constants } from 'node:fs'
import { stat } from 'node:fs/promises'
import { PBC } from './backup-runner.js'
import { setIscsiTargetState, ZFS, zvolDataset } from './iscsi-mutate.js'

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

/** `zfs get -Hp -o value volsize <dataset>` — the zvol target's exact size. */
export function volsizeArgs(dataset: string): string[] {
  return ['get', '-Hp', '-o', 'value', 'volsize', dataset]
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
  const args = ['restore', snapshot, archive, '-']
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

export interface RestoreProgress {
  /** The last percentage pbc reported, or null when it printed none. */
  percent: number | null
  /** The last full `progress …` line, verbatim (minus the padding). */
  lastLine: string | null
  /** pbc's own `restore complete (…)` line, when it printed one. */
  complete: string | null
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

/** The client-safe `Error:` line (pbc stderr never carries the secret). */
export function firstRestoreError(stderr: string): string {
  const lines = stderr.split(LINE_SPLIT_RE).map(l => l.trim()).filter(Boolean)
  return lines.find(l => l.startsWith('Error:')) ?? (lines.at(-1) ?? 'restore failed')
}

/**
 * Turn a failed restore into a sentence that says what to do next.
 *
 * Three of these collapse on the client side and the message says so rather
 * than pretending to a precision pbc does not have: a missing SNAPSHOT, a
 * missing GROUP and a missing NAMESPACE all produce the identical
 * `snapshot …/… does not exist.` string (GT-56).
 */
export function explainRestoreFailure(stderr: string): string {
  const line = firstRestoreError(stderr)
  if (NO_SNAPSHOT_RE.test(stderr)) {
    return `${line} The client reports a missing snapshot, a missing group and a missing NAMESPACE `
      + 'with this same sentence — check the namespace as well as the timestamp.'
  }
  if (NO_ARCHIVE_RE.test(stderr))
    return `${line} That snapshot exists but holds no archive by that name.`
  if (BAD_SUFFIX_RE.test(stderr))
    return `${line} A whole-image restore needs the '<name>.img' archive name, not the stored '.img.fidx' file name.`
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
  /** The mutate context the enable/disable pair runs in. */
  mutate: IscsiMutateOptions
}

/**
 * Run one whole-image restore.
 *
 * THE SEQUENCE, and why it is this order:
 *
 *   1. **Disable the target's TPG.** Not "check for sessions and hope" — the
 *      entry gate already refused a live session, but open-iscsi and Windows
 *      RECONNECT, so a target left enabled can acquire a session between the
 *      pre-flight and the first byte. Disabling refuses new logins and hides
 *      the target from discovery (GT-37, iSCSI ground truth). It is the whole
 *      TARGET that goes down, not one LUN: LIO's enable flag lives on the TPG,
 *      and every other LUN on that target is unreachable for the duration. The
 *      confirm text says so in those words.
 *   2. **Stream the image in.** `restore <snap> <archive> -` with stdout piped
 *      into a descriptor ANAS opened on the device/file. pbc never sees the
 *      target path, which is the only way past GT-39.
 *   3. **fsync** (inside the executor) — a LUN reported restored must be on the
 *      medium, not in the page cache.
 *   4. **Read back** serial + attributes + backing path and prove they are
 *      unchanged.
 *   5. **Re-enable in a `finally`** — EXCEPT after a partial write, which is
 *      the one case where staying offline is the correct outcome and an
 *      explicit `POST /iscsi/targets/:iqn/state {enable}` is the operator's
 *      acknowledgement.
 *
 * Only what ANAS disabled is re-enabled: a target that was already disabled
 * when the restore started is left exactly as found (guest philosophy).
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

  if (target.enabled) {
    updateProgress(
      `disabling iSCSI target ${target.iqn} for the duration of the restore `
      + `(the whole target goes offline, not just LUN ${lun.index})`,
    )
    await setIscsiTargetState(deps.mutate, target, 'disable')
    disabledByUs = true
  }
  else {
    updateProgress(`iSCSI target ${target.iqn} is already disabled - left as found`)
  }

  try {
    const args = imageRestoreArgs(deps.snapshot, deps.archive, deps.namespace, deps.rate)
    updateProgress(
      `restoring ${deps.archive} from ${deps.snapshot} into ${lun.backingPath} `
      + `(${deps.imageSize} bytes, streamed to stdout - the client refuses to write an existing target)`,
    )

    let lastPercent = -1
    const r = await executor.execToStream(PBC, args, streamTarget, {
      env: deps.env,
      onStderr: (chunk) => {
        // GT-59: the interval roughly DOUBLES (6 s, 16 s, 36 s, 79 s), so a
        // multi-hour restore emits a handful of late lines and long silences
        // are normal. Every line pbc does emit is forwarded verbatim.
        const p = parseRestoreProgress(chunk)
        if (p.percent !== null && p.percent !== lastPercent) {
          lastPercent = p.percent
          updateProgress(`restore ${p.lastLine ?? `progress ${p.percent}%`}`)
        }
      },
    })
    bytesWritten = r.bytesWritten
    const progress = parseRestoreProgress(r.stderr)
    if (progress.complete)
      duration = progress.complete

    if (r.exitCode !== 0) {
      const detail = explainRestoreFailure(r.stderr)
      if (bytesWritten > 0) {
        // The half-written state, stated in the words the story asks for. The
        // device has no marker of its own; this sentence IS the record.
        partial = `the image was partially written (${bytesWritten} of ${deps.imageSize} bytes reached `
          + `${lun.backingPath}); the LUN is disabled until you restore again or accept the state. `
          + `${detail}`
        throw new Error(partial)
      }
      throw new Error(`${detail} Nothing was written to ${lun.backingPath}.`)
    }

    if (bytesWritten !== deps.imageSize) {
      // pbc said complete and the byte count disagrees: report it rather than
      // trusting either number on its own.
      warnings.push(
        `the client reported a complete restore but ${bytesWritten} bytes reached ${lun.backingPath}, `
        + `not the manifest's ${deps.imageSize} - verify the LUN's contents before serving it.`,
      )
    }

    // ---- Read-back: the disk must still be the same disk -------------------
    updateProgress('verifying the backstore path, unit serial and attributes are unchanged')
    try {
      const after = await deps.readBack()
      const afterTarget = after.find(t => t.iqn === target.iqn)
      warnings.push(...readBackWarnings(lun, afterTarget?.luns.find(l => l.index === lun.index)))
      if (kind === 'file') {
        // The file was rewritten in place, so its length must be the image's.
        // A file that grew or shrank would mean the fileio backstore is now
        // serving a different size than it was created with, which LIO does
        // not notice and an initiator would discover the hard way.
        const size = await readTargetSize(executor, lun)
        if ('error' in size)
          warnings.push(`could not re-read the size of ${lun.backingPath}: ${size.error}`)
        else if (size.size !== deps.imageSize)
          warnings.push(`${lun.backingPath} is ${size.size} bytes after the restore, not the image's ${deps.imageSize}`)
      }
    }
    catch (err) {
      warnings.push(
        `the image was written, but the LIO read-back failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  finally {
    // A partial write is the ONE case that stays offline: serving half an image
    // is worse than serving nothing, and the operator's explicit re-enable is
    // the acknowledgement. Everything else — including a failure that wrote no
    // bytes — gets the target back.
    if (disabledByUs && !partial) {
      try {
        updateProgress(`re-enabling iSCSI target ${target.iqn}`)
        await setIscsiTargetState(deps.mutate, target, 'enable')
        reEnabled = true
      }
      catch (err) {
        // No `throw` in a `finally`: it would REPLACE the restore's own error,
        // which is always the more informative one. It is said loudly instead.
        warnings.push(
          `THE TARGET IS STILL DISABLED: re-enabling ${target.iqn} failed `
          + `(${err instanceof Error ? err.message : String(err)}). No initiator can log in until you `
          + `enable it again from the iSCSI screen.`,
        )
      }
    }
  }

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
