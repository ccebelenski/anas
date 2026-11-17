import type { IscsiHeldByLun } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { HeldByLunSubject } from './iscsi-held.js'
import type { IscsiPaths } from './iscsi.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pickHolder } from './iscsi-held.js'
import { iscsiClaims } from './iscsi-mutate.js'

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
 * try again". {@link diagnoseIscsiHolder} asks the iSCSI claims — the same list
 * every refusal door asks — and when it answers,
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
 * Injection points for the two diagnoses. The iSCSI paths come from
 * {@link IscsiPaths} — configfs root, saveconfig, and the read's seams —
 * overridable so a test (and a dev box with no LIO) never reads the kernel's
 * target tree, LIO's saved configuration or PVE's storage.cfg.
 */
export interface BusyDiagnosisOptions extends IscsiPaths {
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
 * An exec result that says the tool is not on this host: exit 127 with no
 * stdout. On a node a missing binary makes `exec` REJECT (ENOENT) and never
 * yields 127; the MockExecutor answers an unregistered command with exactly
 * this, so a mock host and a node without the tool read the same (D3).
 */
export function toolNotFound(r: ExecResult): boolean {
  return r.exitCode === 127 && r.stdout.trim() === ''
}

/**
 * The `fuser -m <path>` run behind {@link diagnoseBusyPath}, answering the ONE
 * question that helper's fail-open contract cannot: did the tool answer?
 *
 * {@link diagnoseBusyPath} collapses "fuser is not installed" and "fuser ran
 * and found nothing" into the same empty list, which is right for error
 * enrichment (the primary error is what matters). The cr.39 busy gate in
 * Mounts needs the distinction (D3): when no tool answers, the holder list is
 * UNKNOWN and the confirm must say so — "[]" would read as "nothing holds it".
 *
 * `null` = no answer: fuser could not be started, {@link toolNotFound}, or it
 * ran out of its budget (a hung mount). An empty ARRAY = fuser ran and found
 * nothing (`fuser -m` exits 1 with empty stdout), which IS an answer. Never
 * throws.
 */
export async function runFuser(
  executor: CommandExecutor,
  path: string,
  opts?: BusyDiagnosisOptions,
): Promise<BusyHolder[] | null> {
  const procRoot = opts?.procRoot ?? DEFAULT_PROC_ROOT
  try {
    // fuser writes PIDs to stdout (terse); its label decoration goes to stderr,
    // which we ignore.
    const r = await executor.exec(FUSER, ['-m', path])
    if (toolNotFound(r))
      return null
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
    return null
  }
}

/**
 * Identify the processes holding `path`'s filesystem open: `fuser -m <path>`
 * for the PID set, then `/proc/<pid>/comm` for each command name. Fail-open —
 * `fuser` missing/erroring yields no PIDs, and a PID that vanished before its
 * `/proc` read is skipped. Never throws.
 */
export async function diagnoseBusyPath(
  executor: CommandExecutor,
  path: string,
  opts?: BusyDiagnosisOptions,
): Promise<BusyHolder[]> {
  // Fail-open: an absent/ailing fuser reads as "no holders", exactly as before
  // runFuser existed — enrichment never masks the primary error with a note.
  return (await runFuser(executor, path, opts)) ?? []
}

/**
 * The iSCSI branch (story `iscsi.6`): which LUN, if any, is holding
 * this — as a VIEW over the claim list, which is itself the complete answer to
 * "what holds this backing for iSCSI" (`iscsiClaims`). This function walks
 * nothing: it reads the claims ONCE, keeps the ones that can explain a kernel
 * busy — only a claim whose backstore is live can be a hold the kernel feels,
 * so `backstoreMissing === true` is filtered out — and asks `pickHolder` for
 * each identity the caller and the message between them can supply, in order
 * of certainty:
 *
 *   1. the caller's known path (a mountpoint, an image file, a device node);
 *   2. the path the busy message quotes;
 *   3. the dataset the caller knows or the message quotes.
 *
 * A directory subject also matches any LUN whose backing lives underneath it,
 * and a dataset subject matches a LUN whose image file lives in that dataset
 * or below — `pickHolder`'s rules, shared with every refusal door, so the
 * busy clause and the refusal sentence can never disagree.
 *
 * FAIL-OPEN: no LIO, no match, any throw — including the claims read THROWING
 * on a configfs tree it could not list in full — ⇒ null, and the caller falls
 * through to the process-based diagnosis exactly as before.
 */
export async function diagnoseIscsiHolder(
  executor: CommandExecutor,
  errorText: string,
  path?: string,
  opts?: BusyDiagnosisOptions,
): Promise<IscsiHeldByLun | null> {
  try {
    const { claims } = await iscsiClaims(executor, opts ?? {})
    const kernelHolds = claims.filter(c => c.backstoreMissing !== true)
    const dataset = opts?.dataset ?? extractBusyDataset(errorText)
    const quoted = extractBusyPath(errorText)
    const subjects: HeldByLunSubject[] = [
      ...(path !== undefined ? [{ path }] : []),
      ...(quoted !== null ? [{ path: quoted }] : []),
      ...(dataset !== null ? [{ dataset }] : []),
    ]
    for (const subject of subjects) {
      const held = pickHolder(kernelHolds, subject)
      if (held)
        return held
    }
    return null
  }
  catch {
    // The claims could not be read — name no iSCSI holder and let fuser answer.
    return null
  }
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
 *   1. **the iSCSI branch** — the claims say whether the kernel target is
 *      serving this object. When it is, `fuser` is NOT run: it would return
 *      nothing (GT-41) and "held open by: " with an empty list is worse than
 *      silence. The appended sentence is the claim's own `detail`.
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
  // The one holder `fuser` cannot see: a mapped LUN, a saved LUN missing live,
  // or a backstore no LUN maps — the claims carry all three, with the sentence.
  const held = await diagnoseIscsiHolder(executor, errorText, path, opts)
  if (held)
    return `${errorText} — ${held.detail}`
  const target = path ?? extractBusyPath(errorText)
  if (!target)
    return errorText
  const holders = await diagnoseBusyPath(executor, target, opts)
  const clause = formatHolders(holders)
  return clause ? `${errorText} — ${clause}` : errorText
}
