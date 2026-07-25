import type { CommandExecutor } from '../executor/types.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Busy-unmount root-cause diagnosis (story 3.29, docs/EPICS.md Epic 3).
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

export interface BusyDiagnosisOptions {
  /** /proc root — overridable so `/proc/<pid>/comm` reads are testable. */
  procRoot?: string
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
 * The wire-up entry point. Given a surfaced error and (optionally) the known
 * target path, append the holding-process clause IFF the error is a busy
 * failure AND a path is known or derivable AND holders are found. In every other
 * case the original error text is returned VERBATIM — diagnosis never masks the
 * primary failure.
 *
 *   enrichBusyError(exec, "cannot unmount '/tank': pool or dataset is busy")
 *     → "cannot unmount '/tank': pool or dataset is busy — held open by: smbd(567)"
 */
export async function enrichBusyError(
  executor: CommandExecutor,
  errorText: string,
  path?: string,
  opts?: BusyDiagnosisOptions,
): Promise<string> {
  if (!isBusyError(errorText))
    return errorText
  const target = path ?? extractBusyPath(errorText)
  if (!target)
    return errorText
  const holders = await diagnoseBusyPath(executor, target, opts)
  const clause = formatHolders(holders)
  return clause ? `${errorText} — ${clause}` : errorText
}
