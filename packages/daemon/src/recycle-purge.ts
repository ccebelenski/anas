import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { recyclePurgeTargets } from './parsers/smb-conf.js'

/**
 * Recycle-bin PURGE RUNNER (smbsvc.2) — the entrypoint the static
 * `anas-recycle.timer` fires daily (via `node dist/recycle-purge.js`, unit
 * shipped in packaging/ and installed by install.sh).
 *
 * Unlike snapshot-task.ts/scrub-task.ts this runner is NOT a client of the
 * daemon: the purge sweep is filesystem maintenance over smb.conf, and the
 * timer must work even when anasd is down (a NAS reboot with a failed daemon
 * must not silently stop pruning). It parses smb.conf with the daemon's ONE
 * parser (`recyclePurgeTargets`), and for each stanza that carries both a
 * `recycle:repository` and a numeric purge marker removes the files in
 * `<path>/<repository>` whose ctime is older than the purge age — the
 * equivalent of `find <path>/<repository> -type f -ctime +<days> -delete` —
 * then prunes the emptied directories under the bin (never the bin itself).
 *
 * The walk mirrors `find`'s documented whole-day rounding (`-ctime +30` first
 * matches a file 31 whole days old): the fractional part of the age in days is
 * ignored, so a file deleted "30 days ago" plus a few hours is still kept.
 * Deletion age is the ctime (a recycled file's ctime IS its deletion time —
 * the rename sets it, and users cannot forge it), exactly what the DESIGN keys
 * the purge on.
 *
 * Nothing is ever deleted from a share without a numeric marker, or with
 * `never` (recyclePurgeTargets answers `days: null` for both) — the runner
 * logs it as skipped and moves on. A share whose `path` or bin directory is
 * missing is skipped without error. `#recycle` contents are never touched by
 * anything else: uninstalling ANAS leaves every bin in place.
 *
 * Output goes to stdout → journald (`share=<name> removed=<n> pruned_dirs=<m>`
 * per purged share, one `skipped` line per skipped share); the exit code is 0
 * when every share either purged or skipped, 1 if any share's sweep FAILED, so
 * systemd's last-result stays truthful.
 */

/** Default smb.conf — overridable per run (the unit can pass --smbconf). */
export const DEFAULT_SMB_CONF = '/etc/samba/smb.conf'

const DAY_MS = 86_400_000

/** How the runner logs (stdout → journald when fired by the timer). */
export type PurgeLog = (line: string) => void

/** One share's purge outcome. */
export interface RecyclePurgeOutcome {
  share: string
  removed: number
  prunedDirs: number
}

/**
 * The filesystem calls the purge's containment rests on — injectable so a
 * test can swap the bin (or a directory under it) for a symlink BETWEEN two
 * calls: after a check (the race ident.4 (f) closes) or after an open (the
 * race the dirfd walk closes, cr.64cr).
 */
export interface PurgeFs {
  lstat: (path: string) => Promise<Stats>
  /**
   * Open a DIRECTORY without following a final symlink
   * (`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`): a link fails ELOOP, a
   * non-directory ENOTDIR. The handle pins the directory itself.
   */
  openDir: (path: string) => Promise<FileHandle>
}

const OPEN_DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

const NODE_FS: PurgeFs = { lstat: p => lstat(p), openDir: p => open(p, OPEN_DIR_FLAGS) }

export interface RecyclePurgeOptions {
  smbConfPath?: string
  /** Injectable filesystem checks (tests). */
  fs?: Partial<PurgeFs>
  /** Injectable clock (tests). */
  now?: () => number
  /**
   * Injectable age of one file, in ms (tests). Defaults to the real ctime age:
   * `now() - stats.ctimeMs`. Tests inject `stats.mtimeMs` after `utimes`
   * instead — ctime cannot be set from userspace (any utimes call stamps it
   * back to "now"), so the seam is the only way to age a fixture file.
   */
  ageOf?: (stats: Stats) => number
  log?: PurgeLog
}

/** `find`'s `-ctime +N` semantics: whole days only, strictly more than N. */
export function isPurgeable(ageMs: number, days: number): boolean {
  return Math.floor(ageMs / DAY_MS) > days
}

/**
 * A path INSIDE the directory an open handle pins: Linux's `/proc/self/fd/<fd>`
 * is a magic link to the opened directory itself, so a name resolved through
 * it is resolved in THAT directory — wherever it now sits, whatever its old
 * path now names. `lstat`, `unlink` and `rmdir` never follow the final
 * component, so an act through this path is the `fstatat`/`unlinkat` of a
 * native binding, with no binding (cr.64cr; the review of cr.64c proved the
 * shape).
 */
function inDir(dirFd: number, name?: string): string {
  return name === undefined ? `/proc/self/fd/${dirFd}` : `/proc/self/fd/${dirFd}/${name}`
}

/** An errno a race with a share user produces: the entry moved, or became something else. */
function swapped(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR'
}

/** The counts one sweep accumulates. */
interface SweepCounts {
  removed: number
  prunedDirs: number
  refused: number
}

/**
 * Sweep one OPENED directory: every regular file past its purge age is
 * unlinked, every real subdirectory is opened (no-follow), swept, and then
 * pruned if it emptied. Every act goes through the pinned handle
 * ({@link inDir}), never through a path a share user can re-point.
 */
async function sweepDir(
  fs: PurgeFs,
  dirFd: number,
  days: number,
  ageOf: (stats: Stats) => number,
  counts: SweepCounts,
): Promise<void> {
  for (const entry of await readdir(inDir(dirFd), { withFileTypes: true })) {
    const at = inDir(dirFd, entry.name)
    if (entry.isDirectory()) {
      let sub: FileHandle
      try {
        sub = await fs.openDir(at)
      }
      catch (err) {
        // Swapped for a link (or a file) since the listing: refused, never followed.
        if (swapped(err)) {
          counts.refused++
          continue
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          continue
        throw err
      }
      try {
        await sweepDir(fs, sub.fd, days, ageOf, counts)
      }
      finally {
        await sub.close()
      }
      try {
        await rmdir(at)
        counts.prunedDirs++
      }
      catch (err) {
        // Still holding files (young ones, or an age race), already gone, or
        // swapped for a link after the sweep (rmdir never follows it).
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOTDIR')
          counts.refused++
        else if (code !== 'ENOTEMPTY' && code !== 'ENOENT')
          throw err
      }
      continue
    }
    // Symlinks, sockets, fifos, devices: never purged, never followed (ident.4 (f)).
    if (!entry.isFile())
      continue
    try {
      const stats = await fs.lstat(at)
      if (!stats.isFile()) {
        counts.refused++
        continue
      }
      if (isPurgeable(ageOf(stats), days)) {
        await unlink(at)
        counts.removed++
      }
    }
    catch (err) {
      // The file vanished between listing and stat/unlink — nothing to purge;
      // or became a directory (EISDIR) — not a file, left in place.
      if (swapped(err)) {
        counts.refused++
        continue
      }
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        throw err
    }
  }
}

/** Why a bin is not a plain directory (a reason to skip the share), or null. */
function binSkipReason(stats: Stats, repository: string): string | null {
  if (stats.isSymbolicLink())
    return `${repository} is a symbolic link - not followed`
  if (!stats.isDirectory())
    return `${repository} is not a directory`
  return null
}

/** The bin stopped being a plain directory between two checks: skip the share. */
export class BinNotPlainError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'BinNotPlainError'
  }
}

/**
 * Purge one share's bin (`<share>/<repository>`): remove the files past their
 * purge age, then prune the empty directories under it (never the bin itself
 * — `rmdir` on the only-just-emptied parents succeeds, a still-populated one
 * fails with ENOTEMPTY and stays).
 *
 * Containment (ident.4 (f), cr.64c, cr.64cr): the bin is `lstat`ed (a link or
 * a non-directory throws {@link BinNotPlainError}), then OPENED no-follow
 * (`O_DIRECTORY | O_NOFOLLOW`: a bin swapped for a link after the check fails
 * the open the same way). From that open on, the walk never uses a path again:
 * every subdirectory is opened no-follow through its parent's handle, and
 * every `lstat`, `unlink` and `rmdir` names its entry inside an opened
 * directory as `/proc/self/fd/<dirfd>/<name>` — the dirfd-relative purge the
 * 2026-10-14 review asked for, without a native binding (the
 * no-new-dependencies ruling). A share user who swaps the bin, or any
 * directory under it, for a symlink after it was opened re-points only the
 * PATH: the walk keeps acting in the directory it opened, and the link's
 * target is never read, listed or unlinked. `refused` counts the entries left
 * because they changed kind under the walk (a directory that became a link, a
 * file that became a directory).
 */
export async function purgeBin(
  sharePath: string,
  repository: string,
  days: number,
  opts: { now?: () => number, ageOf?: (stats: Stats) => number, fs?: Partial<PurgeFs> } = {},
): Promise<{ removed: number, prunedDirs: number, refused: number }> {
  const fs: PurgeFs = { ...NODE_FS, ...opts.fs }
  const now = opts.now ?? Date.now
  const ageOf = opts.ageOf ?? ((stats: Stats) => now() - stats.ctimeMs)
  const bin = join(sharePath, repository)
  // cr.64c (cr.53's L27 half, 2026-10-14 §4): the bin is judged BEFORE it is
  // opened or listed — the lstat names what it is, for the skip line.
  const before = binSkipReason(await fs.lstat(bin), repository)
  if (before)
    throw new BinNotPlainError(before)
  let binDir: FileHandle
  try {
    binDir = await fs.openDir(bin)
  }
  catch (err) {
    // Swapped between the lstat and the open: the no-follow open refuses a
    // link (Linux answers ENOTDIR or ELOOP for O_DIRECTORY|O_NOFOLLOW on one,
    // by kernel), and a non-directory. A second lstat only names which.
    if (!swapped(err))
      throw err
    const now = await fs.lstat(bin).catch(() => null)
    throw new BinNotPlainError((now && binSkipReason(now, repository)) ?? `${repository} changed while it was being opened - not followed`)
  }
  const counts: SweepCounts = { removed: 0, prunedDirs: 0, refused: 0 }
  try {
    await sweepDir(fs, binDir.fd, days, ageOf, counts)
  }
  finally {
    await binDir.close()
  }
  return counts
}

/**
 * Is the repository one plain path segment? A `recycle:repository` such as
 * `../x` or `a/b` points the purge somewhere other than a directory inside
 * the share, so it is skipped (ident.4 (f)).
 */
export function isSingleSegment(repository: string): boolean {
  return repository !== '' && repository !== '.' && repository !== '..'
    && !repository.includes('/') && !repository.includes('\\') && !repository.includes('\0')
}

/** One run over the whole config. */
export interface RecyclePurgeResult {
  purged: number
  skipped: number
  failed: number
}

/**
 * Scan smb.conf and purge every eligible share's bin. Shares with no numeric
 * marker (absent, `never`, or a non-policy value) or without a resolvable bin
 * are SKIPPED — logged, never an error, never a deletion. A failure purging
 * one share (EACCES, EIO) is logged and the sweep continues; the run reports
 * it through the result (main exits nonzero) so systemd notices.
 */
export async function runRecyclePurge(opts: RecyclePurgeOptions = {}): Promise<RecyclePurgeResult> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const text = await readFile(opts.smbConfPath ?? DEFAULT_SMB_CONF, 'utf8')
  const result: RecyclePurgeResult = { purged: 0, skipped: 0, failed: 0 }

  for (const target of recyclePurgeTargets(text)) {
    if (target.days === null) {
      log(`anas-recycle: share=${target.share} skipped (no purge age — marker absent, \`never\`, or not a policy value)`)
      result.skipped++
      continue
    }
    if (target.path === null) {
      log(`anas-recycle: share=${target.share} skipped (stanza sets no path)`)
      result.skipped++
      continue
    }
    if (!isSingleSegment(target.repository)) {
      log(`anas-recycle: share=${target.share} skipped (repository '${target.repository}' is not a single directory name inside the share - not followed)`)
      result.skipped++
      continue
    }
    const bin = join(target.path, target.repository)
    const fs: PurgeFs = { ...NODE_FS, ...opts.fs }
    try {
      // lstat, never stat: a share user can replace the bin with a symlink to
      // anywhere, and a purge that followed it would delete files the user
      // could never have recycled (ident.4 (f), audit #19). purgeBin checks
      // again and opens the bin no-follow before it reads anything (cr.64cr).
      const reason = binSkipReason(await fs.lstat(bin), target.repository)
      if (reason) {
        log(`anas-recycle: share=${target.share} skipped (${reason})`)
        result.skipped++
        continue
      }
    }
    catch {
      // No bin on disk yet — nothing has been deleted on this share, so there
      // is nothing to purge. Not an error (DESIGN smbsvc.2).
      log(`anas-recycle: share=${target.share} skipped (${target.repository} does not exist)`)
      result.skipped++
      continue
    }
    try {
      const { removed, prunedDirs, refused } = await purgeBin(target.path, target.repository, target.days, { now: opts.now, ageOf: opts.ageOf, fs: opts.fs })
      const note = refused > 0 ? ` refused=${refused} (left in place - not a plain file or directory inside ${target.repository})` : ''
      log(`anas-recycle: share=${target.share} removed=${removed} pruned_dirs=${prunedDirs}${note}`)
      result.purged++
    }
    catch (err) {
      if (err instanceof BinNotPlainError) {
        log(`anas-recycle: share=${target.share} skipped (${err.reason})`)
        result.skipped++
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      log(`anas-recycle: share=${target.share} failed (${message})`)
      result.failed++
    }
  }
  return result
}

/** Parse the runner's argv (already sliced past `node script`). */
export function parseRunnerArgs(argv: string[]): { smbConfPath: string } {
  const opts = { smbConfPath: DEFAULT_SMB_CONF }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[++i]
    if (value === undefined)
      throw new Error(`Missing value for ${flag}`)
    if (flag === '--smbconf')
      opts.smbConfPath = value
    else
      throw new Error(`Unknown argument: ${flag}`)
  }
  return opts
}

/** CLI entrypoint. Exits 0 when every share purged or skipped, 1 on failure. */
export async function main(argv: string[]): Promise<number> {
  let opts: { smbConfPath: string }
  try {
    opts = parseRunnerArgs(argv)
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  try {
    const result = await runRecyclePurge({ smbConfPath: opts.smbConfPath })
    process.stdout.write(`anas-recycle: done (purged=${result.purged} skipped=${result.skipped} failed=${result.failed})\n`)
    return result.failed > 0 ? 1 : 0
  }
  catch (err) {
    // smb.conf unreadable — the sweep says nothing about any share.
    process.stderr.write(`anas-recycle: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
