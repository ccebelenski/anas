/**
 * Parser for `btrfs subvolume list` (Epic 11 + AHR, story 11.12, §12).
 *
 * btrfs has no JSON here; the line form is the most structured output available
 * (GT-13's sanctioned text exceptions — same footing as /proc/mdstat and
 * `btrfs scrub status`). `btrfs subvolume list` enumerates EVERY subvolume of a
 * filesystem regardless of which subvolume is mounted, with paths relative to
 * the fs root (top level 5) — so `@snapshots/<name>` is visible from the live
 * `@data` mount, and the snapshot list needs no extra top-level mount.
 *
 * Two invocations feed the snapshot list:
 *   - `-s` (snapshots only) carries `cgen` + `otime` (the creation time);
 *   - `-r` (read-only only) is the set membership for the `readonly` flag —
 *     btrfs does not print a readonly column in `-s`, so the readonly set is
 *     the join key.
 * Both share ONE line grammar; every non-`ID` line and every unparseable field
 * is skipped rather than throwing (format-drift tolerance, like btrfs-usage).
 *
 * Provenance: no live `btrfs subvolume list` capture exists from the stage-0
 * ground-truth build (the pre-11.12 pools were flat-layout, no subvolumes to
 * list). The fixtures are MODELLED on the documented btrfs-progs 6.14 line
 * format and are labelled synthetic in the fixture NOTES — replace with a live
 * capture on the next subvol-layout stunt-node drill.
 */

/** Args: list only SNAPSHOT subvolumes (carries otime). */
export function btrfsSubvolListSnapshotsArgs(path: string): string[] {
  return ['subvolume', 'list', '-s', path]
}

/** Args: list only READ-ONLY subvolumes (the readonly-flag join set). */
export function btrfsSubvolListReadonlyArgs(path: string): string[] {
  return ['subvolume', 'list', '-r', path]
}

/** Args: list ALL subvolumes (used to confirm `@data`/`@snapshots` exist). */
export function btrfsSubvolListArgs(path: string): string[] {
  return ['subvolume', 'list', path]
}

/** One parsed `btrfs subvolume list` line. Absent optional fields are null. */
export interface BtrfsSubvol {
  id: number
  gen: number
  /** cgen — present only in the `-s` (snapshot) form. */
  cgen: number | null
  topLevel: number
  /**
   * otime as btrfs reports it (`YYYY-MM-DD HH:MM:SS`, local, no timezone) —
   * present only in the `-s` form. Null when absent.
   */
  otime: string | null
  /** Subvolume path relative to the fs root, e.g. "@snapshots/nightly". */
  path: string
}

/**
 * One line grammar covering the `-s`, `-r`, and plain forms:
 *   ID <n> gen <n> [cgen <n>] top level <n> [otime <date> <time>] path <rest>
 * Fields ANAS never consumes (parent/uuid columns from `-q`/`-u`, which ANAS
 * does not pass) never appear, so the optional-field chain stays small.
 */
const LINE_RE
  = /^ID (\d+) gen (\d+)(?: cgen (\d+))? top level (\d+)(?: otime (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))? path (.+)$/

/**
 * Parse `btrfs subvolume list` output. Non-matching lines (blank, headers,
 * partial captures) are skipped — never a throw (GT-13 drift tolerance).
 */
export function parseBtrfsSubvolList(text: string): BtrfsSubvol[] {
  const out: BtrfsSubvol[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line)
      continue
    const m = line.match(LINE_RE)
    if (!m)
      continue
    out.push({
      id: Number.parseInt(m[1], 10),
      gen: Number.parseInt(m[2], 10),
      cgen: m[3] !== undefined ? Number.parseInt(m[3], 10) : null,
      topLevel: Number.parseInt(m[4], 10),
      otime: m[5] ?? null,
      path: m[6],
    })
  }
  return out
}

const OTIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/

/**
 * The ISO-8601 (local, no timezone) form of a btrfs otime — `2026-07-23
 * 14:23:01` → `2026-07-23T14:23:01`. Null passes through (never fabricated).
 */
export function otimeToIso(otime: string | null): string | null {
  if (otime === null)
    return null
  const m = otime.match(OTIME_RE)
  return m ? `${m[1]}T${m[2]}` : otime
}
