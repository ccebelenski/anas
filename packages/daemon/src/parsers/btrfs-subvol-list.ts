import { posix } from 'node:path'

/**
 * Parser for `btrfs subvolume list` (Epic 11 + AHR, story 11.12, §12).
 *
 * btrfs has no JSON here; the line form is the most structured output available
 * (GT-13's sanctioned text exceptions — same footing as /proc/mdstat and
 * `btrfs scrub status`). `btrfs subvolume list` enumerates EVERY subvolume of a
 * filesystem regardless of which subvolume is mounted — so `@snapshots/<name>`
 * is visible from the live `@data` mount, and the snapshot list needs no extra
 * top-level mount. The path column is relative to the fs root (top level 5)
 * EXCEPT for a subvolume below the mounted one, which prints relative to the
 * MOUNTED subvolume: on an AHR mount (`subvol=/@data`) a nested `@data/sv`
 * prints as `sv` (captured, cr3 node pass 2:
 * `fixtures/ahr/btrfs-subvol-list-nested-mounted.txt`). Placing a subvolume
 * on a mount is {@link subvolumesBelowMount}'s job.
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
  /**
   * The path column: relative to the fs root (`@snapshots/nightly`), or to
   * the mounted subvolume for one below it (`sv` on a `subvol=/@data` mount).
   */
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

/**
 * cr3.nodefix review R2: what the reader of a refusal can do when the list
 * cannot be placed. A subvolume name may hold a line break (a user without
 * privileges can make one) and the list prints it raw; `find -inum 256`
 * matches only subvolume roots (captured: every subvolume root is inode 256).
 */
export function lineBreakRemedy(target: string): string {
  return `a subvolume with a line break in its name makes the list unreadable; rename or delete it (find '${target}' -inum 256 -name '*[[:cntrl:]]*' lists them)`
}

/** The fs tree's own subvolume id (`top level 5`): the top of every btrfs filesystem. */
const FS_TREE = 5

/** Leading slashes of a subvolume path (`subvol=/@data`). */
const LEADING_SLASHES_RE = /^\/+/

/** `subvol=` and `subvolid=` of a btrfs mount's option string (`subvol` without its leading slash, `''` for the top level). */
export function mountedSubvolumeOf(options: string): { subvol: string, subvolid: number | null } {
  const opts = options.split(',')
  const path = opts.find(o => o.startsWith('subvol='))
  const id = opts.find(o => o.startsWith('subvolid='))
  const n = id ? Number(id.slice('subvolid='.length)) : Number.NaN
  return {
    subvol: (path ? path.slice('subvol='.length) : '/').replace(LEADING_SLASHES_RE, ''),
    subvolid: Number.isInteger(n) && n > 0 ? n : null,
  }
}

/**
 * cr3.nodefix D2: the subvolumes a plain `btrfs subvolume list <mountpoint>`
 * names BELOW the subvolume that mountpoint shows, as absolute paths on the
 * mount (and each one's path from the top level, `subvol`).
 *
 * btrfs-progs resolves each path by walking its parent ids up until it meets
 * the MOUNTED subvolume (then the path is relative to the mount) or the fs
 * tree (then it is relative to the top level). This follows the same chain:
 * a subvolume is below the mount when its `top level` chain reaches the
 * mounted subvolume's id before the fs tree, and its printed path then
 * hangs off the mountpoint. Both captured shapes read right: a top-level
 * mount (`subvol=/`, every path from the top) and an AHR mount
 * (`subvol=/@data`, `sv`/`plain/sv2`/`sv/deep` below it, `@data` and
 * `@snapshots` beside it). The answer is the same whether `top level` is
 * the parent's id (btrfs-progs 6.14, captured: `sv/deep` has `top level` 262,
 * `sv`'s id) or the subvolume its path is relative to.
 *
 * Anything it cannot place is a FAILED read (`problem`), never a short list:
 * a line the grammar does not read, a list without the mounted subvolume
 * itself (an empty one included), a parent id the list does not hold, a
 * chain that does not end.
 */
export function subvolumesBelowMount(
  stdout: string,
  mount: { target: string, options: string },
): { below: { path: string, subvol: string }[] } | { problem: string } {
  const list = parseBtrfsSubvolList(stdout)
  const lines = stdout.split('\n').filter(l => l.trim() !== '')
  if (list.length !== lines.length) {
    // cr3.nodefix review R2: the list prints a name's line break raw
    // (captured: fixtures/ahr/btrfs-subvol-list-newline-names.txt), so the
    // usual cause is a subvolume named with one — say which line, and how
    // to find it.
    const odd = lines.find(l => !LINE_RE.test(l.trim())) ?? ''
    return { problem: `answered lines it could not read (${JSON.stringify(odd.slice(0, 80))}): ${lineBreakRemedy(mount.target)}` }
  }
  const { subvol: mounted, subvolid } = mountedSubvolumeOf(mount.options)
  const byId = new Map(list.map(s => [s.id, s]))
  // Review of R2 (2026-11-15): a subvolume id is unique on a filesystem, so
  // two lines with one id mean a line was forged by a name holding a line
  // break (the forged line reusing a real id would replace the real entry
  // here and cut its children's parent chain: a shorter list, silently).
  if (byId.size !== list.length) {
    const seen = new Set<number>()
    const twice = list.find(s => seen.has(s.id) || !seen.add(s.id))!
    return { problem: `listed subvolume id ${twice.id} twice ('${twice.path}'): ${lineBreakRemedy(mount.target)}` }
  }
  let mountedId = FS_TREE
  if (mounted !== '') {
    // The mounted subvolume is not below itself: its own line prints from the
    // top level. With `subvolid=` it is that id AND that path; without, the
    // one line of that path.
    const own = subvolid !== null
      ? [byId.get(subvolid)].filter(s => s?.path === mounted)
      : list.filter(s => s.path === mounted)
    if (own.length !== 1)
      return { problem: `did not list the mounted subvolume '${mounted}' itself` }
    mountedId = own[0]!.id
  }
  const below: { path: string, subvol: string }[] = []
  for (const s of list) {
    if (s.id === mountedId)
      continue
    let parent = s.topLevel
    for (let steps = 0; parent !== mountedId && parent !== FS_TREE; steps++) {
      const up = byId.get(parent)
      if (!up)
        return { problem: `listed subvolume ${s.id} ('${s.path}') under subvolume ${parent}, which it did not list` }
      if (steps > list.length)
        return { problem: `listed subvolume ${s.id} ('${s.path}') in a parent chain that does not end` }
      parent = up.topLevel
    }
    if (parent !== mountedId)
      continue
    const rel = s.path.replace(LEADING_SLASHES_RE, '')
    below.push({
      path: posix.join(mount.target, rel),
      subvol: mounted === '' ? rel : `${mounted}/${rel}`,
    })
  }
  return { below }
}
