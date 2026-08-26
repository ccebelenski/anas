import type { BackupArchiveKind, BackupIncludeNested, BackupNestedEntry, BackupNestedKind, BackupNestedScan } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import { effectiveArchiveKind, effectiveIncludeNested, isPathWithin, nestedIncluded } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { probeMount } from './mounts.js'

/**
 * Nested-filesystem detection (story backup2.2) — the SINGLE source; backup2.3's
 * per-dataset / per-subvolume archive expansion reuses it.
 *
 * `proxmox-backup-client` walks ONE filesystem. Every directory under a source
 * whose `st_dev` differs from the source root's is stored as an EMPTY DIRECTORY
 * with a single `skipping mount point: "<relative path>"` line on stderr. This
 * module finds those boundaries BEFORE the client does, so the omission is a
 * visible choice instead of a line in a log nobody reads.
 *
 * GROUND TRUTH (`docs/BACKUP-RESTORE-GROUND-TRUTH.md`, fixtures
 * `nested-filesystems.txt` + `btrfs-nested-subvol.txt`):
 *
 *   - Detection is an **`st_dev` walk, NOT a `findmnt` enumeration**. A btrfs
 *     nested subvolume carries its own `st_dev` and has NO mount line at all
 *     (GT-52/53); even the EMPTY PLACEHOLDER a read-only btrfs snapshot leaves
 *     behind reports a foreign `st_dev`. `st_dev` is exactly what the client
 *     keys on, so it is what we key on. `findmnt` is then used only to NAME
 *     what the walk found.
 *   - `find -xdev` IS the bounded walk: it prints the boundary directory itself
 *     (carrying the *nested* filesystem's device number) and does NOT descend
 *     into it — one command, no per-entry stat, no recursion of our own
 *     (verified: `46 /gtbackup` … `49 /gtbackup/cdm`, and nothing below it).
 *   - `.zfs/snapshot/<s>` automounts are real `findmnt` entries whose SOURCE
 *     carries an `@` (GT-51). They are EXCLUDED. With the default
 *     `snapdir=hidden` the walk never even sees `.zfs`; `-name .zfs -prune`
 *     covers a `snapdir=visible` dataset.
 *   - **The hang trap** (the mounts-family rule, Epic 18): a remote mount is
 *     recorded from `findmnt` and PRUNED from the walk. `findmnt` reads
 *     `/proc/self/mountinfo` and cannot hang; a dead NFS server can hang a
 *     `stat` forever. The walk itself is additionally wrapped in `timeout` so
 *     nothing else can wedge the daemon either.
 *
 *     **But pruning is not enough, and this scan is hang-BOUNDED, not
 *     hang-proof** (live-proof F8 / GT amendment 16). `find` `lstat`s an entry
 *     BEFORE the expression that would prune it runs, so `-path <dead mount>
 *     -prune` does not protect anything: measured, the whole walk printed
 *     NOTHING and died on the 20 s ceiling — losing the two real child datasets
 *     that were nowhere near the dead server. The `timeout` works, and the
 *     truncation was reported honestly, but a floor is not an answer.
 *
 *     So before walking, every REMOTE mount `findmnt` reports under the source
 *     is put through the mounts family's own guarded liveness probe
 *     (`probeMount` — `timeout 2 stat -f`, the ONE probe, not a second copy).
 *     A dead one is recorded as an `unreachable` boundary, the scan is marked
 *     `truncated` with a reason naming it, and its PARENT DIRECTORY is pruned
 *     from the walk — the parent's own `lstat` is fine, and pruning it is what
 *     stops `find` from ever reading the directory entry that hangs. The walk
 *     then runs on the remainder, so boundaries elsewhere are not lost, and the
 *     warning says exactly which subtree went unwalked.
 *   - An armed `autofs` placeholder is reported ARMED, never "local" (issue #35)
 *     — and it is pruned too, because walking into one triggers the mount. It is
 *     deliberately NOT probed: `stat`ing an armed automount is what triggers it,
 *     and Epic 18's ruling is that ANAS never touches one (its identity comes
 *     from its fstab entry). A placeholder that HAS been triggered is a real
 *     nfs/cifs row in the mount index by then, and that row is probed.
 */

/** Trailing slashes on an absolute path (`/` itself is preserved). */
const TRAILING_SLASHES_RE = /\/+$/

const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const BTRFS = '/usr/bin/btrfs'
/** `timeout` binary — the same hang guard the mounts family uses. */
const TIMEOUT = '/usr/bin/timeout'

/**
 * Default depth budget for the walk. Deep enough for real share trees, shallow
 * enough that a pathological tree cannot turn a wizard click into a tree scan.
 * A walk that hits it reports `truncated: true` rather than implying "none".
 */
export const DEFAULT_NESTED_MAX_DEPTH = 12
/** Default wall-clock budget (seconds) for the walk, enforced by `timeout`. */
export const DEFAULT_NESTED_TIMEOUT_S = 20
/** `timeout` exits 124 when it had to kill the child. */
const TIMEOUT_EXIT = 124
/** One `find -printf '%D\t%p\n'` row. */
const WALK_ROW_RE = /^(\d+)\t(.*)$/
/** A ZFS snapshot automount: its findmnt SOURCE is `<dataset>@<snap>`. */
const ZFS_SNAPSHOT_SOURCE_RE = /@/
/** `.zfs/snapshot/<name>` anywhere in a path (the automount tree). */
const ZFS_SNAPDIR_RE = /(?:^|\/)\.zfs\/snapshot(?:\/|$)/
/** `btrfs subvolume show` header line: `Subvolume ID: <n>`. */
const SUBVOL_ID_RE = /^\s*Subvolume ID:\s*(\d+)\s*$/m
/** `btrfs subvolume show` name line: `Name: <name>` (the value is trimmed). */
const SUBVOL_NAME_RE = /^[^\S\n]*Name:([^\n]*)$/m

export interface NestedScanOptions {
  /** Maximum directory depth walked below the source (default 12). */
  maxDepth?: number
  /** Wall-clock budget in seconds for the WHOLE scan (default 20). */
  timeoutSeconds?: number
  /** The archive name this scan belongs to (echoed into the result). */
  archive?: string
  /** The choice the `included` flags are computed against (default `none`). */
  includeNested?: BackupIncludeNested
  /**
   * Walk INTO each boundary that is being included, so a filesystem nested
   * inside a nested filesystem is found too. Defaults to true exactly when the
   * choice is `all` — because `all` is resolved into one explicit
   * `--include-dev` per boundary, and pbc does NOT recurse past a boundary it
   * was not told about: a child dataset inside a child dataset would be silently
   * lost. Remote / autofs mounts and `.zfs/snapshot` are still never entered.
   */
  descend?: boolean
}

// ---------------------------------------------------------------------------
//  Pure helpers (fixture-testable without an executor)
// ---------------------------------------------------------------------------

/** Strip trailing slashes from an absolute path (`/` itself stays `/`). */
export function normalizePath(path: string): string {
  const trimmed = path.replace(TRAILING_SLASHES_RE, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * `child` expressed relative to `root` — the form pbc's own skip line quotes
 * (`/etc` + `/etc/pve` → `pve`; GT-54's `skipping mount point: "photos"`).
 */
export function relativeTo(root: string, child: string): string {
  const base = normalizePath(root)
  if (child === base)
    return ''
  const prefix = base === '/' ? '/' : `${base}/`
  return child.startsWith(prefix) ? child.slice(prefix.length) : child
}

/**
 * The argv for the walk. `-P` (never follow symlinks) + `-xdev` (stop at every
 * `st_dev` boundary, but PRINT the boundary directory) + `-type d` (directories
 * only — a 10 TB tree is never file-stat'ed) + `-printf '%D\t%p\n'` (the device
 * number and the path; our own machine format, never a human table).
 *
 * `prune` paths are the ones the walk must not even TOUCH: remote mounts and
 * armed automounts (the hang trap), plus `.zfs` snapshot directories.
 */
export function buildWalkArgs(path: string, prune: string[], maxDepth: number): string[] {
  const args = ['-P', normalizePath(path), '-xdev', '-maxdepth', String(maxDepth)]
  const pruneTerms: string[] = ['-name', '.zfs']
  for (const p of prune)
    pruneTerms.push('-o', '-path', normalizePath(p))
  args.push('(', ...pruneTerms, ')', '-prune', '-o', '-type', 'd', '-printf', '%D\\t%p\\n')
  return args
}

/**
 * Parse `find -printf '%D\t%p\n'` output into `{ dev, path }` rows, in the order
 * find emitted them (pre-order, so the source root is first). Malformed rows are
 * dropped — the walk is advisory, never a reason to fail a backup.
 */
export function parseWalk(stdout: string): { dev: number, path: string }[] {
  const rows: { dev: number, path: string }[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(WALK_ROW_RE)
    if (!m)
      continue
    const dev = Number(m[1])
    if (!Number.isFinite(dev))
      continue
    rows.push({ dev, path: m[2] })
  }
  return rows
}

/** Is this findmnt row a ZFS `.zfs/snapshot/<s>` automount? (GT-51 — excluded.) */
export function isZfsSnapshotMount(node: FindmntNode): boolean {
  if (ZFS_SNAPDIR_RE.test(node.target))
    return true
  return node.fstype === 'zfs' && ZFS_SNAPSHOT_SOURCE_RE.test(node.source)
}

/**
 * Name a nested filesystem from its findmnt row. `/etc/pve` is PVE's pmxcfs
 * fuse mount — the product-level example this story exists for; an `autofs`
 * placeholder stays ARMED (never "local"), matching the mounts family.
 */
export function kindOfMount(node: FindmntNode): BackupNestedKind {
  const fstype = node.fstype
  if (fstype === 'autofs')
    return 'automount'
  if (fstype === 'nfs' || fstype === 'nfs4')
    return 'nfs'
  if (fstype === 'cifs' || fstype === 'smb3')
    return 'cifs'
  if (fstype === 'zfs')
    return 'dataset'
  if (fstype === 'btrfs')
    return 'subvolume'
  if (node.target === '/etc/pve' || fstype === 'fuse.pmxcfs')
    return 'pmxcfs'
  return 'local'
}

/** Kinds we never walk INTO: the hang trap, plus autofs (walking arms it). */
export function isUnwalkableKind(kind: BackupNestedKind): boolean {
  return kind === 'nfs' || kind === 'cifs' || kind === 'automount'
}

/**
 * Kinds that get a LIVENESS PROBE before the walk (live-proof F8): the real
 * remote filesystems, whose server can be gone. An armed `automount` is
 * deliberately absent — probing one is what triggers the mount, and a read
 * endpoint must not mount anything (Epic 18).
 */
export function isProbeableKind(kind: BackupNestedKind): boolean {
  return kind === 'nfs' || kind === 'cifs'
}

/**
 * The directory that must be pruned so `find` never reads the entry for
 * `mountpoint`. NOT the mountpoint itself: `find` `lstat`s an entry before the
 * expression that would prune it runs (GT amendment 16), so the only term that
 * helps is one that stops the PARENT's directory from being read at all. The
 * parent's own `lstat` is a local one and is fine.
 */
export function parentOf(path: string): string {
  const base = normalizePath(path)
  if (base === '/')
    return '/'
  const cut = base.lastIndexOf('/')
  return cut <= 0 ? '/' : base.slice(0, cut)
}

/**
 * Pick, for each path, the effective findmnt row: the LAST row for a target wins
 * (a stacked real filesystem over an autofs placeholder — the mounts-family
 * precedence). Rows for `.zfs/snapshot` automounts are dropped outright.
 */
export function mountIndex(findmntJson: string): Map<string, FindmntNode> {
  const byTarget = new Map<string, FindmntNode>()
  for (const node of parseFindmnt(findmntJson)) {
    if (isZfsSnapshotMount(node))
      continue
    const existing = byTarget.get(node.target)
    // A real filesystem stacked on an autofs placeholder is the identity.
    if (existing && node.fstype === 'autofs')
      continue
    byTarget.set(node.target, node)
  }
  return byTarget
}

/**
 * Every mount that must be pruned from the walk BEFORE find can stat it: remote
 * filesystems (a dead server hangs `stat` forever — findmnt never touches the
 * filesystem, so this list is safe to build) and armed automounts.
 */
export function prunePathsUnder(root: string, mounts: Map<string, FindmntNode>): string[] {
  const base = normalizePath(root)
  const out: string[] = []
  for (const [target, node] of mounts) {
    if (target === base || !isPathWithin(base, target))
      continue
    if (isUnwalkableKind(kindOfMount(node)))
      out.push(target)
  }
  return out.sort()
}

/** Parse `btrfs subvolume show` into `{ name, id }` (null when it is not one). */
export function parseSubvolumeShow(stdout: string): { name?: string, id?: number } | null {
  const id = stdout.match(SUBVOL_ID_RE)
  if (!id)
    return null
  const name = stdout.match(SUBVOL_NAME_RE)?.[1]?.trim()
  return { ...(name ? { name } : {}), id: Number(id[1]) }
}

// ---------------------------------------------------------------------------
//  The scan
// ---------------------------------------------------------------------------

/**
 * Find every nested filesystem under `path` and name it.
 *
 * Order of operations, and why:
 *   1. `findmnt --json` — the mount table. It reads `/proc/self/mountinfo`, so
 *      it is the ONE probe that can never hang (Epic 18's rule).
 *   2. Build the prune list from it: remote mounts and armed automounts are
 *      recorded from the table and never touched by the walk.
 *   3. `timeout N find -P … -xdev -type d -printf '%D\t%p\n'` — the bounded
 *      `st_dev` walk. Directory-only, symlink-free, depth-capped. With
 *      `descend`, each walkable boundary the walk finds becomes the root of a
 *      further walk (same shared depth and wall-clock budget), so a filesystem
 *      nested inside a nested filesystem is found too.
 *   4. Name each foreign-device hit: findmnt first, then `btrfs subvolume show`
 *      for a btrfs parent (subvolumes have no mount line), else `unknown`.
 *
 * FAIL-OPEN: a failed walk yields an EMPTY list with a warning and
 * `truncated: true` — never an exception, and never a silent "nothing found".
 */
export async function scanNestedFilesystems(
  executor: CommandExecutor,
  path: string,
  opts: NestedScanOptions = {},
): Promise<BackupNestedScan> {
  const root = normalizePath(path)
  const maxDepth = opts.maxDepth ?? DEFAULT_NESTED_MAX_DEPTH
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_NESTED_TIMEOUT_S
  const choice = effectiveIncludeNested({ includeNested: opts.includeNested ?? 'none' })
  // `all` is resolved into explicit --include-dev paths, and pbc stops at every
  // boundary it was not told about — so `all` MUST see the nested-inside-nested
  // ones. Any other choice needs only the first boundary layer.
  const descend = opts.descend ?? (choice === 'all')
  const warnings: string[] = []

  const scan: BackupNestedScan = {
    ...(opts.archive ? { archive: opts.archive } : {}),
    path: root,
    exists: true,
    includeNested: choice,
    nested: [],
    truncated: false,
    warnings,
  }

  // 1. The mount table (hang-proof).
  let mounts = new Map<string, FindmntNode>()
  try {
    const r = await executor.exec(FINDMNT, ['--json'])
    mounts = mountIndex(r.stdout)
  }
  catch (err) {
    warnings.push(`could not read the mount table: ${errText(err)} — nested filesystems are named as 'unknown'`)
  }

  // 2. Mounts the walk must never touch: remote filesystems (a dead server hangs
  // `stat` forever) and armed automounts (walking one triggers the mount). They
  // are recorded from the table instead — findmnt never touches a filesystem.
  const prune = prunePathsUnder(root, mounts)

  // 2b. LIVENESS, before anything walks (live-proof F8). Pruning a dead mount is
  // not protection: `find` lstats an entry before the expression that would
  // prune it runs, and one black-holed NFS mount took the WHOLE walk down with
  // it — real child datasets elsewhere under the source were lost to the 20 s
  // ceiling. So each remote mount under the source is put through the mounts
  // family's ONE guarded probe first (`timeout 2 stat -f`, never a second copy
  // of it), and a dead one costs its PARENT directory instead of the scan.
  const dead = await probeDeadRemotes(executor, root, prune, mounts)
  for (const target of dead) {
    // The parent is what has to be pruned; the mountpoint's own entry is read
    // (and hangs) while the parent's directory is being listed. Two dead mounts
    // in one directory prune it once.
    const parent = parentOf(target)
    if (!prune.includes(parent))
      prune.push(parent)
    scan.truncated = true
    warnings.push(
      `${target} did not answer a 2s liveness probe (the server is unreachable) — `
      + `everything under ${parent} was left unwalked, because reading that directory `
      + `is what hangs; nested filesystems elsewhere under ${root} were still scanned`,
    )
  }
  prune.sort()

  // 3. The bounded walk(s). ONE shared wall-clock deadline and ONE shared depth
  // budget measured from the ORIGINAL root, so descending can never turn a
  // 20-second scan into an unbounded one.
  const deadline = Date.now() + timeoutSeconds * 1000
  const recorded = new Map<string, BackupNestedEntry>()
  const queue: string[] = [root]
  const walked = new Set<string>()
  let first = true

  while (queue.length) {
    const current = queue.shift() as string
    if (walked.has(current))
      continue
    walked.add(current)

    const remainingDepth = maxDepth - depthBelow(root, current)
    const remainingSeconds = Math.ceil((deadline - Date.now()) / 1000)
    if (remainingDepth <= 0 || remainingSeconds <= 0) {
      scan.truncated = true
      warnings.push(`the scan budget ran out before ${current} could be examined — there may be more nested filesystems below it`)
      continue
    }
    // A dead remote's parent is unreadable, so a walk ROOTED at or inside it
    // cannot run at all — including the source root itself, when the dead mount
    // is one of its own children. The pruned mounts are still recorded below.
    if (dead.some(target => isPathWithin(parentOf(target), current))) {
      scan.truncated = true
      recordPruned(root, current, prune, mounts, choice, recorded, dead)
      continue
    }

    // Everything this walk learns is recorded before the iteration ends —
    // including on an early exit, which is why the pruned mounts are recorded in
    // a `finally` around the WHOLE body (they must be recorded AFTER this walk's
    // own hits, so a remote mount sitting inside a boundary we just found is
    // attributed to that boundary instead of to the source).
    try {
      await walkFrom()
    }
    finally {
      recordPruned(root, current, prune, mounts, choice, recorded, dead)
    }

    async function walkFrom(): Promise<void> {
      let rows: { dev: number, path: string }[] = []
      try {
        const r = await executor.exec(TIMEOUT, [String(remainingSeconds), FIND, ...buildWalkArgs(current, prune, remainingDepth)])
        rows = parseWalk(r.stdout)
        if (r.exitCode === TIMEOUT_EXIT) {
          scan.truncated = true
          warnings.push(`the filesystem-boundary scan of ${current} did not finish within ${remainingSeconds}s — the list below is a floor, not a complete answer`)
        }
        else if (r.exitCode !== 0 && !rows.length) {
          // find exits 1 on a missing path (real capture: `No such file or directory`).
          if (first)
            scan.exists = false
          else scan.truncated = true
          warnings.push(firstLine(r.stderr) || `could not scan ${current}`)
        }
        else if (r.exitCode !== 0) {
          warnings.push(firstLine(r.stderr) || `parts of ${current} could not be read`)
        }
      }
      catch (err) {
        scan.truncated = true
        warnings.push(`the filesystem-boundary scan of ${current} could not run: ${errText(err)}`)
        return
      }

      if (!rows.length)
        return

      // The walk's own root row is the reference device for THIS walk (find is
      // pre-order, but the row is matched by path, never by position).
      const rootRow = rows.find(r => r.path === current)
      if (!rootRow) {
        warnings.push(`the scan of ${current} did not report the source root itself — no boundary comparison is possible`)
        scan.truncated = true
        return
      }
      if (rows.some(r => depthBelow(root, r.path) >= maxDepth))
        scan.truncated = true

      const hits = rows
        .filter(r => r.dev !== rootRow.dev && r.path !== current)
        .filter(r => !ZFS_SNAPDIR_RE.test(r.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

      for (const hit of hits) {
        if (recorded.has(hit.path))
          continue
        // A hit BELOW an already-recorded boundary belongs to that boundary's own
        // walk, not this one (`find -xdev` already stops there; this covers the
        // prune-list edge).
        if (containedInRecorded(hit.path, current, recorded))
          continue
        const named = await nameHit(executor, root, hit.path, choice, mounts)
        recorded.set(hit.path, named)
        // Only descend into what we are actually including, and only into what is
        // safe to enter: never a remote mount, never an armed automount.
        if (descend && named.included && !isUnwalkableKind(named.kind))
          queue.push(hit.path)
      }
    }
    first = false
  }

  scan.nested = [...recorded.values()]
  return finish(scan)
}

/**
 * Which of the remote mounts under `root` are DEAD (live-proof F8).
 *
 * Reuses the mounts family's `probeMount` — `timeout 2 stat -f` — rather than
 * writing a second probe: one implementation of "is this server answering",
 * one 2 s bound, one classification of the timeout. Probes run in parallel so
 * N dead servers cost 2 s, not 2N; a probe that throws counts as ALIVE, because
 * the point of the probe is to avoid a hang and an inconclusive answer is not
 * grounds for skipping a subtree.
 *
 * Armed automounts are excluded on purpose ({@link isProbeableKind}).
 */
async function probeDeadRemotes(
  executor: CommandExecutor,
  root: string,
  prune: string[],
  mounts: Map<string, FindmntNode>,
): Promise<string[]> {
  const candidates = prune.filter((target) => {
    const node = mounts.get(target)
    return node !== undefined && isProbeableKind(kindOfMount(node)) && isPathWithin(root, target)
  })
  if (!candidates.length)
    return []
  const verdicts = await Promise.all(candidates.map(async (target) => {
    try {
      const probe = await probeMount(executor, target)
      return probe.state === 'unreachable' ? target : null
    }
    catch {
      return null
    }
  }))
  return verdicts.filter((t): t is string => t !== null)
}

/**
 * Record the pruned (remote / autofs) mounts that are boundaries of the walk
 * rooted at `current` — that is, those with no OTHER recorded boundary between
 * them and `current`. They are named entirely from the mount table.
 */
function recordPruned(
  root: string,
  current: string,
  prune: string[],
  mounts: Map<string, FindmntNode>,
  choice: BackupIncludeNested,
  recorded: Map<string, BackupNestedEntry>,
  dead: string[] = [],
): void {
  for (const target of prune) {
    if (recorded.has(target) || !isPathWithin(current, target) || target === current)
      continue
    if (containedInRecorded(target, current, recorded))
      continue
    const node = mounts.get(target)
    if (!node)
      continue
    const kind = kindOfMount(node)
    recorded.set(target, entry(root, target, kind, choice, {
      source: node.source,
      fstype: node.fstype,
      detail: prunedDetail(target, kind, dead.includes(target)),
    }))
  }
}

/** Why a pruned mount was not walked into — the honest one-liner on the row. */
function prunedDetail(target: string, kind: BackupNestedKind, isDead: boolean): string {
  if (isDead) {
    return `unreachable — the server did not answer a 2s liveness probe; recorded from the mount `
      + `table, never walked into, and ${parentOf(target)} was left unwalked because reading it is `
      + `what hangs`
  }
  if (kind === 'automount')
    return 'armed automount — not walked into (walking one triggers the mount)'
  return 'remote mount — recorded from the mount table, never probed (the hang trap)'
}

/** Is there a recorded boundary strictly between `current` and `target`? */
function containedInRecorded(target: string, current: string, recorded: Map<string, BackupNestedEntry>): boolean {
  for (const b of recorded.keys()) {
    if (b !== target && b !== current && isPathWithin(current, b) && isPathWithin(b, target))
      return true
  }
  return false
}

/** Name one foreign-device hit: findmnt first, then btrfs, else `unknown`. */
async function nameHit(
  executor: CommandExecutor,
  root: string,
  hit: string,
  choice: BackupIncludeNested,
  mounts: Map<string, FindmntNode>,
): Promise<BackupNestedEntry> {
  const node = mounts.get(hit)
  if (node)
    return entry(root, hit, kindOfMount(node), choice, { source: node.source, fstype: node.fstype })
  // No mount line: on btrfs this is a subvolume (or the empty placeholder a
  // read-only snapshot left behind — GT-52). Ask btrfs, then fall back to the
  // parent-filesystem heuristic; anything else is honestly `unknown`.
  const parentFstype = mounts.get(nearestMountTarget(hit, mounts))?.fstype
  return nameUnmounted(executor, root, hit, choice, parentFstype)
}

/**
 * Scan every archive of a task (or of an unsaved wizard state) in order. Each
 * source is scanned against its OWN `includeNested`, because coverage is a
 * per-archive question.
 */
export async function scanArchives(
  executor: CommandExecutor,
  archives: { name?: string, path: string, includeNested?: BackupIncludeNested, kind?: BackupArchiveKind }[],
  opts: Omit<NestedScanOptions, 'archive' | 'includeNested'> = {},
): Promise<BackupNestedScan[]> {
  const out: BackupNestedScan[] = []
  for (const a of archives) {
    if (effectiveArchiveKind(a) === 'img') {
      // backup2.4 — a BLOCK IMAGE has no directory tree, so there is nothing to
      // walk and nothing that could be "stored as an empty directory". The walk
      // is skipped entirely rather than run and discarded: the source may be a
      // device node (nonsense to descend) or an image file on a remote mount
      // (the one thing the boundary pass must never touch). The empty entry
      // keeps the scans index-aligned with the task's archives.
      out.push(imageArchiveScan(a.name, a.path))
      continue
    }
    out.push(await scanNestedFilesystems(executor, a.path, {
      ...opts,
      ...(a.name ? { archive: a.name } : {}),
      includeNested: effectiveIncludeNested(a),
    }))
  }
  return out
}

/** The boundary-scan answer for an `img` source: there are no boundaries. */
export function imageArchiveScan(archive: string | undefined, path: string): BackupNestedScan {
  return {
    ...(archive ? { archive } : {}),
    path: normalizePath(path),
    exists: true,
    includeNested: 'none',
    nested: [],
    truncated: false,
    warnings: [],
  }
}

/** What an archive's `includeNested` resolves to for THIS run. */
export interface NestedResolution {
  /**
   * Archive name → the absolute paths to pass as `--include-dev`. An empty list
   * means NO flag at all for that archive: the client's own default.
   */
  byArchive: Record<string, string[]>
  /** Honest notes about a resolution that is narrower than the choice asked for. */
  warnings: string[]
  /** The scans, with `included` corrected wherever `all` could not be resolved. */
  scans: BackupNestedScan[]
}

/**
 * Turn each archive's stored choice into the exact `--include-dev` paths this
 * run will pass — the ONE place `all` becomes concrete.
 *
 * WHY `all` is resolved here rather than mapped to `--all-file-systems`: that
 * flag is per-INVOCATION, and ANAS puts every archive of a task in ONE
 * `proxmox-backup-client backup` call. Emitting it for one archive would silently
 * apply it to all the others, so the per-archive control the wizard shows would
 * not be the contract pbc receives. One `--include-dev` per detected boundary
 * says exactly the same thing with exactly the intended scope, and leaves the
 * other archives untouched.
 *
 * NEVER A SILENT PARTIAL: if an `all` archive's scan did not complete (missing
 * path, timeout, depth budget, unreadable subtree) the run crosses NOTHING for
 * that archive — the client default — and says why. Half a boundary list would
 * be an omission nobody could see.
 */
export function resolveNestedIncludes(
  archives: { name: string, path: string, includeNested?: BackupIncludeNested }[],
  scans: BackupNestedScan[],
): NestedResolution {
  const byArchive: Record<string, string[]> = {}
  const warnings: string[] = []
  const out: BackupNestedScan[] = [...scans]

  archives.forEach((archive, index) => {
    const choice = effectiveIncludeNested(archive)
    if (choice !== 'all') {
      // `none` → nothing; a stored path list is already explicit.
      byArchive[archive.name] = Array.isArray(choice) ? [...choice] : []
      return
    }
    // Match the scan by archive name, falling back to request order.
    const at = out.findIndex(sc => sc.archive === archive.name)
    const scan = at >= 0 ? out[at] : out[index]
    const slot = at >= 0 ? at : index

    if (!scan) {
      byArchive[archive.name] = []
      warnings.push(`archive '${archive.name}': 'all' could not be resolved - no filesystem-boundary scan was produced for ${archive.path}; this run crossed no boundary`)
      return
    }
    const reason = !scan.exists
      ? `${scan.path} could not be read`
      : (scan.truncated ? `the boundary scan of ${scan.path} did not complete` : null)
    if (reason) {
      byArchive[archive.name] = []
      warnings.push(`archive '${archive.name}': 'all' could not be resolved - ${reason}; this run crossed NO filesystem boundary under ${scan.path} (the client default) rather than an unpredictable subset`)
      // The screen must not keep claiming these are included.
      out[slot] = { ...scan, nested: scan.nested.map(n => ({ ...n, included: false })) }
      return
    }

    byArchive[archive.name] = scan.nested.map(n => n.path)
    // A remote / armed mount is included by path, but we never enumerated what
    // is nested INSIDE it — pbc will stop at its own boundaries in there.
    const opaque = scan.nested.filter(n => isUnwalkableKind(n.kind))
    if (opaque.length) {
      warnings.push(`archive '${archive.name}': 'all' includes ${opaque.map(n => `${n.path} (${n.kind})`).join(', ')} - filesystems nested INSIDE those were not enumerated, so anything on a further device under them is still stored empty`)
    }
  })

  return { byArchive, warnings, scans: out }
}

/**
 * The authoritative run warnings: one line per nested filesystem the archive's
 * choice will NOT cover. This is the primary signal (the client's own
 * `skipping mount point:` parse is the secondary one) — plain ASCII, because it
 * rides the 16.12 notification body verbatim.
 */
export function nestedRunWarnings(scans: BackupNestedScan[]): string[] {
  const out: string[] = []
  for (const scan of scans) {
    for (const n of scan.nested) {
      if (n.included)
        continue
      const who = scan.archive ? `archive '${scan.archive}'` : scan.path
      out.push(`${who}: nested filesystem ${n.path} (${n.kind}) is NOT included - it is backed up as an empty directory`)
    }
    if (scan.truncated) {
      const who = scan.archive ? `archive '${scan.archive}'` : scan.path
      out.push(`${who}: the filesystem-boundary scan of ${scan.path} was incomplete - there may be more nested filesystems than listed`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
//  Internals
// ---------------------------------------------------------------------------

function finish(scan: BackupNestedScan): BackupNestedScan {
  scan.nested.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return scan
}

function entry(
  root: string,
  path: string,
  kind: BackupNestedKind,
  choice: BackupIncludeNested,
  extra: { source?: string, fstype?: string, detail?: string } = {},
): BackupNestedEntry {
  return {
    path,
    relativePath: relativeTo(root, path),
    kind,
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.fstype ? { fstype: extra.fstype } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    included: nestedIncluded(choice, path),
  }
}

/** How many path components below `root` this path sits. */
function depthBelow(root: string, path: string): number {
  const rel = relativeTo(root, path)
  return rel ? rel.split('/').length : 0
}

/** The longest findmnt target that contains `path` — the filesystem it lives on. */
function nearestMountTarget(path: string, mounts: Map<string, FindmntNode>): string {
  let best = '/'
  for (const target of mounts.keys()) {
    if (isPathWithin(target, path) && target.length > best.length)
      best = target
  }
  return best
}

/**
 * A foreign `st_dev` with NO mount line. On btrfs that is a subvolume; ask
 * `btrfs subvolume show` (structured enough — a labelled key/value block, and
 * the only interface btrfs offers), and keep the honest answer when it says no.
 */
async function nameUnmounted(
  executor: CommandExecutor,
  root: string,
  path: string,
  choice: BackupIncludeNested,
  parentFstype: string | undefined,
): Promise<BackupNestedEntry> {
  if (parentFstype !== 'btrfs')
    return entry(root, path, 'unknown', choice, { detail: 'a distinct filesystem with no mount-table entry' })
  try {
    const r = await executor.exec(BTRFS, ['subvolume', 'show', path])
    const subvol = r.exitCode === 0 ? parseSubvolumeShow(r.stdout) : null
    if (subvol) {
      return entry(root, path, 'subvolume', choice, {
        fstype: 'btrfs',
        ...(subvol.name ? { source: subvol.name } : {}),
        detail: subvol.id === undefined ? undefined : `btrfs subvolume id ${subvol.id}`,
      })
    }
    // GT-52: a read-only btrfs snapshot leaves the nested subvolume as an EMPTY
    // PLACEHOLDER that reports the fs-root device and is NOT a subvolume — and
    // `--all-file-systems` cannot rescue it (GT-55). Say exactly that.
    return entry(root, path, 'subvolume', choice, {
      fstype: 'btrfs',
      detail: 'empty placeholder left by a read-only btrfs snapshot - there is nothing under it to include',
    })
  }
  catch {
    return entry(root, path, 'subvolume', choice, { fstype: 'btrfs', detail: 'btrfs subvolume (identity unavailable)' })
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
}
