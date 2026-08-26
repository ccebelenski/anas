import type {
  BackupBrowseEntry,
  BackupBrowseEntryType,
  BackupBrowseResult,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { BackupReadDeps } from './backup-reads.js'
import { classifyArchiveFile, isBrowsableArchive } from '@anas/shared'
import { classifyBackupReadVerdict } from './backup-reads.js'
import { buildBackupEnv, PBC } from './backup-runner.js'

/**
 * The ARCHIVE BROWSER (story backup2.5) — `proxmox-backup-client catalog shell`
 * driven over a pipe.
 *
 * **Why not FUSE.** `mount` is the obvious answer and it is rejected outright:
 * GT-33 measured a reachable-but-BLACK-HOLED PBS leaving readers in D state
 * that `timeout` CANNOT kill (only `/sys/fs/fuse/connections/<N>/abort` frees
 * them), and `stat -f` reports the dead mount healthy. That is the mounts
 * family's hang trap with no lever. `catalog shell` is an ordinary child
 * process: it can be wrapped in `timeout` and it dies when told to.
 *
 * **Why two invocations per level.** `ls` prints BARE NAMES and nothing else —
 * no type, no size, no marker of any kind (real capture). The type comes from
 * `stat`, and the names are not known until `ls` has answered, so one directory
 * level costs one `ls` call and one batched `stat` call. Both are cheap and
 * both are ONE process: 500 `stat`s in a single session measured 0.029 s on the
 * stunt node, and the whole shell start (catalog fetch included) measured
 * 0.066 s on a small archive and 0.143 s on a 250 MiB one. There is no
 * interactive back-and-forth: each invocation gets its whole script on stdin,
 * which is exactly what the executor's `stdin` option already does.
 *
 * **Errors inside the shell do not fail it.** `ls /nosuchdir` prints
 * `Error: no such file or directory: "nosuchdir"` on STDERR, the shell keeps
 * going, and the process still exits 0 (real capture). So a per-command failure
 * is detected by reading stderr, never by the exit code; a non-zero exit means
 * the shell never started at all (bad snapshot / archive / credentials / server).
 *
 * Ground truth for every rule below: docs/BACKUP-RESTORE-GROUND-TRUTH.md GT-8
 * plus this story's own capture, fixtures/backup/catalog-shell-browse.txt.
 */

/** The `timeout` binary — the same hang guard the mounts family uses. */
const TIMEOUT = '/usr/bin/timeout'
/** `timeout` exits 124 when it had to kill the child. */
const TIMEOUT_EXIT = 124

/**
 * Wall-clock budget for ONE catalog-shell invocation. Two orders of magnitude
 * above the measured 0.14 s worst case, and still bounded — a picker must never
 * be the thing that wedges the daemon.
 */
export const CATALOG_SHELL_TIMEOUT_S = 30

/**
 * Cap on entries returned for one directory level, mirroring `/v1/fs/browse`'s
 * own `MAX_DIRS`. Silent truncation is banned: over the cap sets `truncated`,
 * which the picker shows as "list truncated".
 */
export const MAX_BROWSE_ENTRIES = 500

/** `Starting interactive shell` — the banner pbc writes to STDERR, not an error. */
const BANNER_RE = /^Starting interactive shell\s*$/
/** A per-command failure inside the shell: `Error: no such file or directory: "x"`. */
const SHELL_ENOENT_RE = /no such file or directory/i
/** Any `Error:` line the shell wrote for one of our commands. */
const SHELL_ERROR_RE = /^Error:/

/**
 * The four lines of one `stat` block, in order (real capture):
 *
 *     '  File: /link-to-alpha -> "alpha.txt"'
 *     '  Size: 0             Type: symlink'
 *     'Access: (777/lrwxrwxrwx  )  Uid: 0     Gid: 0    '
 *     'Modify: 2026-08-25 19:16:23'
 */
const STAT_FILE_RE = /^ {2}File: (.*)$/
const STAT_SIZE_RE = /^ {2}Size: (\d+)\s+Type: (\S+)\s*$/
const STAT_ACCESS_RE = /^Access: \((\d+)\/(\S+)\s*\)/
const STAT_MODIFY_RE = /^Modify: (.*)$/
/** The ` -> "target"` tail a symlink OR a hardlink carries on its File: line. */
const STAT_TARGET_RE = /^(.*?) -> "(.*)"$/
/** Trailing slashes on a requested directory path. */
const TRAILING_SLASHES_RE = /\/+$/

/**
 * Characters that need no escaping in a `catalog shell` argument. Everything
 * else gets a backslash.
 *
 * The shell's parser is shellword-shaped: an unquoted space splits the argument
 * (`ls /with space.txt` → `Error: got additional arguments: ["space.txt"]`),
 * while `\ `, `"…"` and `'…'` all work. A backslash INSIDE double quotes is
 * LITERAL (`"/with\ space.txt"` looked for `with\ space.txt`), so quoting cannot
 * be rescued by escaping — which rules quotes out for names that contain the
 * quote character itself. Backslash-escaping unquoted has no such hole and was
 * verified against the real archive for space, `*`, `[` and `]`
 * (`ls /mix\ \[a\]\ \*\ b.txt` → `mix [a] * b.txt`). Globbing does not happen:
 * `*` and `[` are literal either way.
 */
const CATALOG_SAFE_CHAR_RE = /[\w./@%+:,=-]/

/**
 * Escape ONE path for the catalog shell's argument parser: backslash before
 * every character outside {@link CATALOG_SAFE_CHAR_RE}.
 *
 * Control characters are NOT escapable here — a newline would end the command
 * line and start a second one — so the shared `ArchivePath` schema refuses them
 * at the boundary and this function throws if one still arrives. That is a real
 * injection guard, not a formality: pxar permits a newline in a filename.
 */
export function escapeCatalogArg(path: string): string {
  let out = ''
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7F)
      throw new Error('archive path contains a control character')
    out += CATALOG_SAFE_CHAR_RE.test(ch) ? ch : `\\${ch}`
  }
  return out
}

/**
 * `timeout <s> proxmox-backup-client catalog shell <snapshot> <archive> [--ns <ns>]`.
 *
 * The snapshot is ALWAYS the full `<type>/<id>/<RFC3339>` id: GT-57 proved a
 * bare group path silently means "the latest", which for a browse would show a
 * different point in time than the one that was picked.
 */
export function buildCatalogShellArgs(
  snapshot: string,
  archive: string,
  namespace?: string,
  timeoutSeconds: number = CATALOG_SHELL_TIMEOUT_S,
): { command: string, args: string[] } {
  const args = [String(timeoutSeconds), PBC, 'catalog', 'shell', snapshot, archive]
  if (namespace)
    args.push('--ns', namespace)
  return { command: TIMEOUT, args }
}

/**
 * The stdin script that lists ONE directory level and stats the directory
 * itself. The trailing `stat` is not decoration: `ls` of a FILE echoes the
 * file's own name (real capture), which would otherwise look like a directory
 * containing one child. Knowing what the requested path IS removes that lie.
 */
export function buildLsScript(path: string): string {
  const arg = escapeCatalogArg(path)
  return `ls ${arg}\nstat ${arg}\nexit\n`
}

/** The stdin script that stats a batch of child paths, in order. */
export function buildStatScript(paths: string[]): string {
  let script = ''
  for (const p of paths)
    script += `stat ${escapeCatalogArg(p)}\n`
  return `${script}exit\n`
}

/** Join a directory and a child name into an archive path (root is `/`). */
export function joinArchivePath(dir: string, name: string): string {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return `${base}/${name}`
}

/** One parsed `stat` block. `path` is the File: line minus any `-> "target"`. */
export interface CatalogStat {
  path: string
  size?: number
  /** The `Type:` word verbatim: `directory` / `file` / `symlink`. */
  rawType: string
  /** Octal permission bits (`644`); `0` for a hardlink. */
  mode?: string
  /** The symbolic mode (`-rw-r--r--`, `lrwxrwxrwx`, `L---------`). */
  permissions?: string
  modified?: string
  target?: string
}

/**
 * True when a `stat` block is a HARDLINK rather than a real symlink.
 *
 * pbc renders both as `Type: symlink` with a `-> "target"` tail; only the mode
 * separates them. A hardlink carries octal `0` and the symbolic form
 * `L---------` (real capture: `Access: (0/L---------  )`, and its Modify is the
 * epoch), where a symlink carries `777` / `lrwxrwxrwx`. The `L` is pxar's own
 * format-mode letter for a hardlink, so it is the discriminator.
 */
export function isHardlinkStat(stat: CatalogStat): boolean {
  return stat.rawType === 'symlink' && (stat.permissions ?? '').startsWith('L')
}

/** Map one parsed block onto the shared entry type. */
export function browseEntryType(stat: CatalogStat): BackupBrowseEntryType {
  if (stat.rawType === 'directory')
    return 'dir'
  if (stat.rawType === 'file')
    return 'file'
  if (stat.rawType === 'symlink')
    return isHardlinkStat(stat) ? 'hardlink' : 'symlink'
  return 'other'
}

/**
 * Split one shell invocation's STDOUT into the leading `ls` names and the
 * `stat` blocks that follow.
 *
 * The split point is the first 4-line run that matches the stat signature
 * (`  File:` / `  Size: N Type: t` / `Access: (m/p…)` / `Modify: …`). A single
 * `  File: …` line is not enough — a filename can be anything, including that
 * text — but all four in sequence is not something `ls` can produce.
 */
export function splitCatalogOutput(stdout: string): { names: string[], blocks: CatalogStat[] } {
  const lines = stdout.split('\n')
  // A trailing newline yields one empty final element; nothing else is dropped
  // (a name is never empty).
  if (lines.at(-1) === '')
    lines.pop()

  let split = lines.length
  for (let i = 0; i + 3 < lines.length; i++) {
    if (STAT_FILE_RE.test(lines[i] ?? '')
      && STAT_SIZE_RE.test(lines[i + 1] ?? '')
      && STAT_ACCESS_RE.test(lines[i + 2] ?? '')
      && STAT_MODIFY_RE.test(lines[i + 3] ?? '')) {
      split = i
      break
    }
  }
  return {
    names: lines.slice(0, split),
    blocks: parseStatBlocks(lines.slice(split)),
  }
}

/**
 * Parse a run of `stat` blocks. A block that does not match all four lines is
 * skipped rather than guessed at, so a future pbc format change degrades to
 * "no detail" instead of to wrong detail.
 */
export function parseStatBlocks(lines: string[]): CatalogStat[] {
  const out: CatalogStat[] = []
  for (let i = 0; i + 3 < lines.length; i++) {
    const fileLine = STAT_FILE_RE.exec(lines[i] ?? '')
    if (!fileLine)
      continue
    const sizeLine = STAT_SIZE_RE.exec(lines[i + 1] ?? '')
    const accessLine = STAT_ACCESS_RE.exec(lines[i + 2] ?? '')
    const modifyLine = STAT_MODIFY_RE.exec(lines[i + 3] ?? '')
    if (!sizeLine || !accessLine || !modifyLine)
      continue
    let path = fileLine[1] ?? ''
    let target: string | undefined
    const withTarget = STAT_TARGET_RE.exec(path)
    if (withTarget) {
      path = withTarget[1] ?? path
      target = withTarget[2]
    }
    const stat: CatalogStat = {
      path,
      size: Number(sizeLine[1]),
      rawType: sizeLine[2] ?? '',
      mode: accessLine[1],
      permissions: accessLine[2],
      modified: (modifyLine[1] ?? '').trimEnd() || undefined,
    }
    if (target !== undefined)
      stat.target = target
    out.push(stat)
    i += 3
  }
  return out
}

/** The `Error:` lines the shell wrote for our commands (banner filtered out). */
export function shellErrorLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l && !BANNER_RE.test(l) && SHELL_ERROR_RE.test(l))
}

/** What a browse needs on top of the repo + secret + namespace. */
export interface BrowseArchiveDeps extends BackupReadDeps {
  /** The full `<type>/<id>/<RFC3339>` id — never a bare group path. */
  snapshot: string
  /** The archive argument WITH its type suffix (`data.pxar`). */
  archive: string
  /** The directory to list (archive-absolute; the archive root is `/`). */
  path: string
  /** Override the wall-clock budget (tests). */
  timeoutSeconds?: number
  /** Override the per-level entry cap (tests). */
  maxEntries?: number
}

/** Run one catalog-shell invocation with a script on stdin. */
async function runShell(
  executor: CommandExecutor,
  deps: BrowseArchiveDeps,
  script: string,
): Promise<{ ok: true, stdout: string, stderr: string } | { ok: false, verdict: BackupBrowseResult['verdict'], detail: string }> {
  const { command, args } = buildCatalogShellArgs(
    deps.snapshot,
    deps.archive,
    deps.namespace,
    deps.timeoutSeconds ?? CATALOG_SHELL_TIMEOUT_S,
  )
  try {
    const r = await executor.exec(command, args, {
      stdin: script,
      env: buildBackupEnv(deps.repo, deps.secret),
    })
    if (r.exitCode === TIMEOUT_EXIT)
      return { ok: false, ...classifyBackupReadVerdict(r.exitCode, r.stderr, true) }
    if (r.exitCode !== 0)
      return { ok: false, ...classifyBackupReadVerdict(r.exitCode, r.stderr) }
    return { ok: true, stdout: r.stdout, stderr: r.stderr }
  }
  catch (err) {
    return { ok: false, verdict: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Browse ONE directory level of ONE archive.
 *
 * An `img` archive short-circuits with NO PBS contact at all: browsing a block
 * image is meaningless (pbc answers `Error: Can only mount pxar archives.`), so
 * the result is a single whole-image pseudo-entry saying exactly that, instead
 * of a round trip that can only fail. Anything that is neither pxar nor img
 * (`catalog.pcat1.didx`, `index.json.blob`) is not a restore source and says so.
 */
export async function browseArchiveLevel(
  executor: CommandExecutor,
  deps: BrowseArchiveDeps,
): Promise<BackupBrowseResult> {
  const { kind } = classifyArchiveFile(deps.archive)
  const base: BackupBrowseResult = {
    verdict: 'ok',
    repository: deps.repo.name,
    ...(deps.namespace ? { namespace: deps.namespace } : {}),
    snapshot: deps.snapshot,
    archive: deps.archive,
    archiveKind: kind,
    path: deps.path,
    entries: [],
    warnings: [],
  }

  if (kind === 'img') {
    return {
      ...base,
      path: '/',
      entries: [{
        name: deps.archive,
        path: '/',
        type: 'image',
      }],
      warnings: ['A block image is restored whole - there is nothing inside it to pick.'],
    }
  }
  if (!isBrowsableArchive(kind)) {
    return {
      ...base,
      verdict: 'error',
      detail: `'${deps.archive}' is not a restorable archive - pick a .pxar or .img archive.`,
    }
  }

  let script: string
  try {
    script = buildLsScript(deps.path)
  }
  catch (err) {
    return { ...base, verdict: 'error', detail: err instanceof Error ? err.message : String(err) }
  }

  const listed = await runShell(executor, deps, script)
  if (!listed.ok)
    return { ...base, verdict: listed.verdict, detail: listed.detail }

  const shellErrors = shellErrorLines(listed.stderr)
  const { names, blocks } = splitCatalogOutput(listed.stdout)
  const self = blocks.find(b => b.path === deps.path)
    ?? blocks.find(b => b.path === deps.path.replace(TRAILING_SLASHES_RE, ''))

  // The shell reported the path missing and gave us nothing — the honest answer
  // is not-found, not an empty directory.
  if (!self && names.length === 0 && shellErrors.some(l => SHELL_ENOENT_RE.test(l))) {
    return {
      ...base,
      verdict: 'not-found',
      detail: `'${deps.path}' is not in this archive.`,
    }
  }

  // `ls` of a FILE echoes the file's own name; without this the picker would
  // show a directory that contains itself.
  if (self && self.rawType !== 'directory') {
    return {
      ...base,
      warnings: [`'${deps.path}' is not a directory in this archive.`],
    }
  }

  const cap = deps.maxEntries ?? MAX_BROWSE_ENTRIES
  const truncated = names.length > cap
  const kept = truncated ? names.slice(0, cap) : names
  if (kept.length === 0)
    return { ...base, ...(truncated ? { truncated: true } : {}) }

  const childPaths = kept.map(n => joinArchivePath(deps.path, n))
  let statScript: string
  try {
    statScript = buildStatScript(childPaths)
  }
  catch (err) {
    return { ...base, verdict: 'error', detail: err instanceof Error ? err.message : String(err) }
  }

  const statted = await runShell(executor, deps, statScript)
  const warnings: string[] = []
  const byPath = new Map<string, CatalogStat>()
  if (statted.ok) {
    for (const block of parseStatBlocks(statted.stdout.split('\n')))
      byPath.set(block.path, block)
  }
  else {
    // The detail listing failed but the NAME listing succeeded. Degrade to
    // names-without-detail rather than losing the level entirely — a picker
    // that can still navigate beats a picker that shows an error.
    warnings.push(`Entry details are unavailable: ${statted.detail}`)
  }

  const entries: BackupBrowseEntry[] = []
  let missingDetail = 0
  for (let i = 0; i < kept.length; i++) {
    const name = kept[i] ?? ''
    const path = childPaths[i] ?? ''
    const stat = byPath.get(path)
    if (!stat) {
      missingDetail++
      entries.push({ name, path, type: 'other' })
      continue
    }
    const entry: BackupBrowseEntry = { name, path, type: browseEntryType(stat) }
    if (stat.size !== undefined && Number.isFinite(stat.size))
      entry.size = stat.size
    if (stat.modified)
      entry.modified = stat.modified
    if (stat.mode)
      entry.mode = stat.mode
    if (stat.target !== undefined)
      entry.target = stat.target
    entries.push(entry)
  }
  if (missingDetail > 0 && statted.ok)
    warnings.push(`${missingDetail} entr${missingDetail === 1 ? 'y' : 'ies'} could not be inspected.`)

  // Folders first, then everything else; each group name-sorted. Sorted in
  // place on an array we own.
  entries.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1
    const bd = b.type === 'dir' ? 0 : 1
    if (ad !== bd)
      return ad - bd
    return a.name.localeCompare(b.name)
  })

  return {
    ...base,
    entries,
    ...(truncated ? { truncated: true } : {}),
    warnings,
  }
}
