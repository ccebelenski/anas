import type { CommandExecutor } from '../executor/types.js'
import type { ConfigfsOptions, LunHolder } from './iscsi-configfs.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zvolDevicePath } from '@anas/shared'
import { describeLunHolder, lunHoldingDevice } from './iscsi-configfs.js'

/**
 * Busy-unmount root-cause diagnosis (story 3.29, docs/EPICS-HISTORY.md Epic 3;
 * the LIO branch is story `iscsi.6`).
 *
 * When an unmount fails because the filesystem is busy, the raw error names WHAT
 * failed but not WHY: the pve5 incident surfaced only
 * `cannot unmount '/chiapools/pool15': pool or dataset is busy` — the operator
 * had to run `fuser` by hand to find the chia harvester holding plot-dir FDs.
 * This helper names the holders alongside the primary error:
 * `… — held open by: chia_harvester(1234), smbd(567)`.
 *
 * ONE implementation, shared by every busy-prone path (ZFS pool/dataset destroy,
 * the ZFS + AHR mountpoint moves, AHR destroy, AHR snapshot rollback, and the
 * Mounts unmount/remove). It is STRICTLY additive: the primary error is never
 * masked or replaced — diagnosis only ever appends, and any failure to diagnose
 * (tool missing, no holders, unknown path) leaves the original error verbatim.
 *
 * Tool: `fuser` (psmisc) — it ships in the Debian/PVE base install (`lsof` does
 * not; see fixtures/busy/NOTES.md) and is the tool the operator reached for. The
 * terse `fuser -m <path>` form is used (bare PIDs on stdout, single-stream);
 * the command name is read from `/proc/<pid>/comm`.
 *
 * **The LIO branch (story `iscsi.6`).** There is one holder `fuser` cannot see.
 * When the kernel iSCSI target is serving a zvol or an image file, `fuser -m`,
 * `lsof` and `/sys/block/<dev>/holders/` ALL report nothing (GT-41) — the claim
 * exists only in configfs, as `CLAIMED: IBLOCK` plus the backstore's
 * `udev_path`. So a `zpool export` or a `zfs destroy` that hits `dataset is
 * busy` because of a LUN produces, today, a busy error with an EMPTY holder
 * list: the worst possible answer, because it reads as "nothing is holding it,
 * try again". {@link diagnoseLunHolder} asks configfs, and when it answers,
 * `fuser` is NOT consulted at all — it has nothing to add and its silence is
 * exactly what made the original message useless. Same fail-open posture as
 * every other branch: no LIO, no match, any throw ⇒ fall straight through to
 * the process-based diagnosis.
 */

const FUSER = '/usr/bin/fuser'
const DEFAULT_PROC_ROOT = '/proc'

/** Default cap on named holders before collapsing the tail into "+N more". */
const DEFAULT_CAP = 5

/** The busy class marker — ZFS "…is busy" or umount "target is busy". */
const BUSY_RE = /busy/i
/** `umount: <path>: target is busy` — the path segment. */
const UMOUNT_PATH_RE = /umount:\s+(\/[^:]+):/
/** A `'…'`-quoted absolute path (ZFS `cannot unmount '<path>'`). */
const QUOTED_PATH_RE = /'(\/[^']+)'/
/**
 * A `'…'`-quoted ZFS DATASET name — `cannot destroy 'tank/vol1': dataset is
 * busy`. Not a path, so `QUOTED_PATH_RE` (which demands a leading `/`) misses
 * it entirely, which is why a busy zvol destroy has never carried a holder
 * clause. A dataset name is `pool/child…`, no leading slash, no spaces.
 */
const QUOTED_TOKEN_RE = /'([^'\s]+)'/
/** Whitespace splitter for `fuser` terse PID tokens. */
const WHITESPACE_RE = /\s+/
/** Leading digits of a `fuser` PID token (drops any trailing access letter). */
const LEADING_DIGITS_RE = /^(\d+)/

/** A process holding a busy path open. */
export interface BusyHolder {
  /** The process command name (`/proc/<pid>/comm`), e.g. `chia_harvester`. */
  command: string
  /** The process id. */
  pid: number
}

/**
 * Injection points for the two diagnoses. `root`/`blockRoot` come from
 * {@link ConfigfsOptions} and are the LIO configfs tree — overridable so a test
 * (and a dev box with no LIO) never reads the kernel.
 */
export interface BusyDiagnosisOptions extends ConfigfsOptions {
  /** /proc root — overridable so `/proc/<pid>/comm` reads are testable. */
  procRoot?: string
  /**
   * The ZFS dataset the caller was operating on, when it knows one. A zvol's
   * busy error names the DATASET (`cannot destroy 'tank/vol1'`), not a path, so
   * without this the LIO branch would have to trust the message alone. Callers
   * that know better say so; the message is still parsed as a fallback.
   */
  dataset?: string
}

/**
 * The busy class: a ZFS ("pool or dataset is busy") or umount ("target is
 * busy") failure. A single `/busy/i` test covers both — the enrichment only
 * ever fires on a genuine busy failure, never on unrelated errors.
 */
export function isBusyError(text: string): boolean {
  return BUSY_RE.test(text)
}

/**
 * The filesystem path a busy error names, when the caller has no better one:
 * the `umount: <path>: target is busy` segment, else the first `'…'`-quoted
 * absolute path (ZFS's `cannot unmount '<path>'`). Null when none is present.
 */
export function extractBusyPath(text: string): string | null {
  const umount = text.match(UMOUNT_PATH_RE)
  if (umount)
    return umount[1]
  const quoted = text.match(QUOTED_PATH_RE)
  if (quoted)
    return quoted[1]
  return null
}

/**
 * The ZFS DATASET a busy error names, if it names one rather than a path.
 *
 * `zfs destroy` of a claimed zvol says `cannot destroy 'tank/vol1': dataset is
 * busy` — the quoted token is a dataset name with no leading slash, so
 * {@link extractBusyPath} (which requires one) returns null and the whole
 * diagnosis used to stop there. A zvol has no mountpoint to run `fuser` against
 * anyway; what it has is `/dev/zvol/<dataset>`, which is exactly what LIO
 * stores as the backstore's `udev_path` (GT-48). Null when the message quotes a
 * path, quotes nothing, or quotes a bare pool name (no `/`).
 */
export function extractBusyDataset(text: string): string | null {
  const quoted = text.match(QUOTED_TOKEN_RE)
  if (!quoted)
    return null
  const token = quoted[1]
  if (token.startsWith('/') || !token.includes('/'))
    return null
  return token
}

/**
 * Parse `fuser -m <path>` terse stdout into a de-duplicated PID list. Each token
 * is a PID optionally suffixed with an access-type letter (`5961c` = cwd), so we
 * keep the leading digits. Pure and total — malformed tokens are skipped.
 */
export function parseFuserPids(stdout: string): number[] {
  const pids = new Set<number>()
  for (const token of stdout.split(WHITESPACE_RE)) {
    const m = token.match(LEADING_DIGITS_RE)
    if (m)
      pids.add(Number(m[1]))
  }
  return [...pids]
}

/**
 * Render holders as the appended clause `held open by: a(1), b(2)`, capped at
 * `cap` with a `, +N more` tail. Empty in → empty string (caller must not
 * append it).
 */
export function formatHolders(holders: BusyHolder[], cap = DEFAULT_CAP): string {
  if (holders.length === 0)
    return ''
  const shown = holders.slice(0, cap).map(h => `${h.command}(${h.pid})`)
  const more = holders.length > cap ? `, +${holders.length - cap} more` : ''
  return `held open by: ${shown.join(', ')}${more}`
}

/**
 * Identify the processes holding `path`'s filesystem open: `fuser -m <path>`
 * for the PID set, then `/proc/<pid>/comm` for each command name. Fail-open —
 * `fuser` missing/erroring (exit non-zero, empty stdout) yields no PIDs, and a
 * PID that vanished before its `/proc` read is skipped. Never throws.
 */
export async function diagnoseBusyPath(
  executor: CommandExecutor,
  path: string,
  opts?: BusyDiagnosisOptions,
): Promise<BusyHolder[]> {
  const procRoot = opts?.procRoot ?? DEFAULT_PROC_ROOT
  try {
    // fuser writes PIDs to stdout (terse); its label decoration goes to stderr,
    // which we ignore. A missing fuser returns exit 127 with empty stdout → [].
    const r = await executor.exec(FUSER, ['-m', path])
    const holders: BusyHolder[] = []
    for (const pid of parseFuserPids(r.stdout)) {
      try {
        const comm = (await readFile(join(procRoot, String(pid), 'comm'), 'utf-8')).trim()
        if (comm)
          holders.push({ command: comm, pid })
      }
      catch {
        // Process gone between the fuser call and the read — skip it.
      }
    }
    return holders
  }
  catch {
    return []
  }
}

/**
 * The LIO branch (story `iscsi.6`): which iSCSI LUN, if any, is holding this?
 *
 * Tries each identity the caller and the message between them can supply, in
 * order of certainty:
 *
 *   1. the caller's known path (a mountpoint, an image file, a device node);
 *   2. the path the busy message quotes;
 *   3. `/dev/zvol/<dataset>` for the dataset the caller knows or the message
 *      quotes — the stable by-name path LIO actually stores (never `/dev/zdN`,
 *      GT-48).
 *
 * A directory argument also matches any LUN backed by a file underneath it,
 * which is what a busy `zpool export` or a busy dataset destroy needs.
 *
 * FAIL-OPEN: no LIO, no configfs, no match, any throw ⇒ null, and the caller
 * falls through to the process-based diagnosis exactly as before.
 */
export async function diagnoseLunHolder(
  errorText: string,
  path?: string,
  opts?: BusyDiagnosisOptions,
): Promise<LunHolder | null> {
  const dataset = opts?.dataset ?? extractBusyDataset(errorText)
  const candidates = [
    path,
    extractBusyPath(errorText),
    dataset ? zvolDevicePath(dataset) : null,
  ]
  for (const candidate of candidates) {
    if (!candidate)
      continue
    try {
      const holder = await lunHoldingDevice(candidate, opts)
      if (holder)
        return holder
    }
    catch {
      // Unreadable configfs — fall through to the next candidate, then to fuser.
    }
  }
  return null
}

/**
 * The wire-up entry point. Given a surfaced error and (optionally) the known
 * target path, append the holder clause IFF the error is a busy failure AND a
 * holder is found. In every other case the original error text is returned
 * VERBATIM — diagnosis never masks the primary failure.
 *
 *   enrichBusyError(exec, "cannot unmount '/tank': pool or dataset is busy")
 *     → "cannot unmount '/tank': pool or dataset is busy — held open by: smbd(567)"
 *
 * TWO diagnoses, tried in that order and never both (story `iscsi.6`):
 *
 *   1. **the LIO branch** — configfs knows whether the kernel target is serving
 *      this object. When it is, `fuser` is NOT run: it would return nothing
 *      (GT-41) and "held open by: " with an empty list is worse than silence.
 *   2. **the process branch** — the original 3.29 `fuser`/`comm` diagnosis,
 *      byte-for-byte unchanged for every path LIO is not holding.
 */
export async function enrichBusyError(
  executor: CommandExecutor,
  errorText: string,
  path?: string,
  opts?: BusyDiagnosisOptions,
): Promise<string> {
  if (!isBusyError(errorText))
    return errorText
  // The one holder `fuser` cannot see. Asked first, and answered exclusively.
  const lun = await diagnoseLunHolder(errorText, path, opts)
  if (lun)
    return `${errorText} — ${describeLunHolder(lun)}`
  const target = path ?? extractBusyPath(errorText)
  if (!target)
    return errorText
  const holders = await diagnoseBusyPath(executor, target, opts)
  const clause = formatHolders(holders)
  return clause ? `${errorText} — ${clause}` : errorText
}
