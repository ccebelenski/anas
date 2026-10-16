import type { ZodType } from 'zod'
import type { CommandExecutor } from '../executor/types.js'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { hasControlChars } from '@anas/shared'

/**
 * The ONE systemd unit-store helper module — the plumbing every ANAS unit-store
 * shares (replication, backup, snapshot schedules, and now the scrub schedule).
 * Each store embeds its canonical schedule JSON in its `.service` file as a
 * marker comment (`X-ANAS-Task=` / `X-ANAS-Schedule=`), zod-validates it on
 * read, and drives systemctl to reload + enable/disable. That shape was four
 * hand-copied implementations; the copies diverge into bugs (single source of
 * truth), so the marker parse, the unit-dir listing and the two little
 * filesystem/exec helpers live ONCE here. Rendering and the per-store store
 * semantics (what a write enables, when a removal happens) stay per-store —
 * those genuinely differ.
 */

/**
 * Regex matching a unit's marker line (with or without the leading `# `),
 * capturing the JSON after the marker. The marker is a plain `X-ANAS-…=`
 * token; every regex metacharacter in it is escaped. Compiled once per marker
 * (the two stores in tree mean exactly two entries) and cached at module scope.
 */
const MARKER_RE_CACHE = new Map<string, RegExp>()
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g

export function markerRegex(marker: string): RegExp {
  let re = MARKER_RE_CACHE.get(marker)
  if (!re) {
    const escaped = marker.replace(REGEX_METACHARS, '\\$&')
    re = new RegExp(`^#?\\s*${escaped}(.*)$`)
    MARKER_RE_CACHE.set(marker, re)
  }
  return re
}

/**
 * Parse the canonical JSON out of a unit file's marker line, zod-validated.
 * Returns null when the marker is absent or the JSON does not parse/validate —
 * a unit we did not write (or that we cannot read back) is never adopted.
 */
export function parseMarkedJson<T>(content: string, marker: string, schema: ZodType<T>): T | null {
  const re = markerRegex(marker)
  for (const line of content.split('\n')) {
    const m = line.match(re)
    if (!m)
      continue
    try {
      const parsed = schema.safeParse(JSON.parse(m[1]))
      return parsed.success ? parsed.data : null
    }
    catch {
      return null
    }
  }
  return null
}

// --- Injection guards (cr.51 / review C1) ------------------------------------

/**
 * Refuse a value that would break out of its unit line. A control character in
 * ANY interpolated value (a `Description=`, an `ExecStart=` token) ends that
 * line and forges the next one — systemd merges repeated sections, so a
 * newline in a task/schedule name injects a directive (`ExecStartPre=`) the
 * daemon then runs as root. The shared schemas forbid such values at the
 * boundary; the unit file is a security boundary in its own right, so every
 * writer asks again before rendering. Throws — the caller writes NOTHING.
 */
export function refuseControlChars(value: string, field: string): void {
  if (hasControlChars(value))
    throw new Error(`Unit ${field} must not contain control characters (newline, carriage return, NUL, …)`)
}

const WHITESPACE_RE = /\s/
const DQUOTE_RE = /"/g

/**
 * Quote an ExecStart token so systemd's own splitter round-trips it (empty
 * strings and any whitespace get double-quoted; ZFS/pool names are otherwise
 * quote-free). The control-character refusal (cr.51, was replication's
 * private `quoteExecArg`) covers NUL and TAB too — exactly what the shared
 * schemas reject, so the writer and the schema draw the same line.
 */
export function quoteExecArg(a: string): string {
  refuseControlChars(a, 'ExecStart argument')
  if (a === '' || WHITESPACE_RE.test(a))
    return `"${a.replace(DQUOTE_RE, '\\"')}"`
  return a
}

/** Read one unit file as utf-8 text; null when absent or unreadable. */
export async function readUnitFile(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(dir, name), 'utf-8')
  }
  catch {
    return null
  }
}

/**
 * All `<prefix>*.service` file NAMES in a unit dir, plus whether the dir could
 * be read at all (`complete: false` = readdir failed, `files` is []). A caller
 * that must not mistake "unreadable" for "empty" — a destroy decision that
 * depends on what other units say — checks `complete`.
 */
export async function listServiceUnitsChecked(dir: string, prefix: string): Promise<{ files: string[], complete: boolean }> {
  let files: string[]
  try {
    files = await readdir(dir)
  }
  catch {
    return { files: [], complete: false }
  }
  return { files: files.filter(f => f.startsWith(prefix) && f.endsWith('.service')), complete: true }
}

/**
 * All `<prefix>*.service` file NAMES in a unit dir (fail-open to [] — an
 * unreadable unit dir means an empty store, which is exactly how a node with
 * no schedules of this kind reads).
 */
export async function listServiceUnits(dir: string, prefix: string): Promise<string[]> {
  return (await listServiceUnitsChecked(dir, prefix)).files
}

/**
 * Where systemd records a Persistent timer's last fire — `stamp-<unit>.timer`
 * beside `/etc/systemd/system`, NOT with the unit files. A leftover stamp makes
 * a re-enabled or re-created timer fire at once (the stamp reads as a missed
 * run), so every ANAS store that removes a timer deletes its stamp alongside
 * the units. Read per call, not at import, so a test can point it at a scratch
 * dir by env after the modules are loaded. ONE home for the path — the scrub
 * store knew it first, the task stores now share it.
 */
export function systemdTimersStampDir(): string {
  return process.env.ANAS_TIMERS_STAMP_DIR ?? '/var/lib/systemd/timers'
}

/** Delete a file quietly — a missing file is fine, the goal state already holds. */
export async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  }
  catch {
    // Missing file is fine — the goal state (absent) already holds.
  }
}

/** Run one systemctl call, throwing its stderr on a nonzero exit. */
export async function runSystemctl(executor: CommandExecutor, args: string[]): Promise<void> {
  const r = await executor.exec('/usr/bin/systemctl', args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `systemctl ${args.join(' ')} exited with code ${r.exitCode}`)
}
