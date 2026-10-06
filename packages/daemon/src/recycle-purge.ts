import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
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

export interface RecyclePurgeOptions {
  smbConfPath?: string
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

/** Recursively list every regular file under `dir` (relative paths resolved). */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory())
        await walk(full)
      else if (entry.isFile())
        files.push(full)
    }
  }
  await walk(dir)
  return files
}

/** Every directory under `dir` (exclusive), deepest first — for pruning. */
async function listDirsDeepestFirst(dir: string): Promise<string[]> {
  const dirs: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue
      const full = join(current, entry.name)
      dirs.push(full)
      await walk(full)
    }
  }
  await walk(dir)
  return dirs.reverse()
}

/** Is `p` strictly inside `root` (both already resolved)? */
function isInside(root: string, p: string): boolean {
  return p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Does `p` still resolve inside the bin? A share user can swap a directory
 * under the bin for a symlink between the walk listing it and the purge
 * acting on it; the resolved path is the only honest answer (story ident.4
 * (f), audit #19). An unresolvable path is not inside.
 */
async function resolvesInside(realBin: string, p: string): Promise<boolean> {
  try {
    return isInside(realBin, await realpath(p))
  }
  catch {
    return false
  }
}

/**
 * Purge one bin: remove the files past their purge age, then prune the empty
 * directories under it (never `bin` itself — `rmdir` on the only-just-emptied
 * parents succeeds, a still-populated one fails with ENOTEMPTY and stays).
 *
 * Every file and directory is acted on only while its resolved path stays
 * inside the bin's resolved path and it is what it was listed as (`lstat`: a
 * regular file, a real directory) — never through a symlink (ident.4 (f)).
 * `refused` counts what was left for failing that check.
 */
export async function purgeBin(
  bin: string,
  days: number,
  opts: { now?: () => number, ageOf?: (stats: Stats) => number } = {},
): Promise<{ removed: number, prunedDirs: number, refused: number }> {
  const now = opts.now ?? Date.now
  const ageOf = opts.ageOf ?? ((stats: Stats) => now() - stats.ctimeMs)
  const realBin = await realpath(bin)
  let removed = 0
  let refused = 0
  for (const file of await listFiles(bin)) {
    try {
      const stats = await lstat(file)
      if (!stats.isFile() || !(await resolvesInside(realBin, file))) {
        refused++
        continue
      }
      if (isPurgeable(ageOf(stats), days)) {
        await unlink(file)
        removed++
      }
    }
    catch (err) {
      // The file vanished between listing and stat/unlink — nothing to purge.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        throw err
    }
  }

  let prunedDirs = 0
  for (const dir of await listDirsDeepestFirst(bin)) {
    try {
      const stats = await lstat(dir)
      if (!stats.isDirectory() || !(await resolvesInside(realBin, dir))) {
        refused++
        continue
      }
      await rmdir(dir)
      prunedDirs++
    }
    catch (err) {
      // Still holding files (young ones, or an age race) or already gone.
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (err as NodeJS.ErrnoException).code !== 'ENOENT')
        throw err
    }
  }
  return { removed, prunedDirs, refused }
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
    try {
      // lstat, never stat: a share user can replace the bin with a symlink to
      // anywhere, and a purge that followed it would delete files the user
      // could never have recycled (ident.4 (f), audit #19).
      const stats = await lstat(bin)
      if (stats.isSymbolicLink()) {
        log(`anas-recycle: share=${target.share} skipped (${target.repository} is a symbolic link - not followed)`)
        result.skipped++
        continue
      }
      if (!stats.isDirectory()) {
        log(`anas-recycle: share=${target.share} skipped (${target.repository} is not a directory)`)
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
      const { removed, prunedDirs, refused } = await purgeBin(bin, target.days, { now: opts.now, ageOf: opts.ageOf })
      const note = refused > 0 ? ` refused=${refused} (left in place - not a plain file or directory inside ${target.repository})` : ''
      log(`anas-recycle: share=${target.share} removed=${removed} pruned_dirs=${prunedDirs}${note}`)
      result.purged++
    }
    catch (err) {
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
