import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Concurrency-safe, non-destructive editor for system config files
 * (smb.conf, /etc/exports). Implements DESIGN §5b:
 *
 *  - per-file mutex        — two ANAS jobs never read-modify-write concurrently
 *  - read fresh every time — the edit applies to the real current state
 *  - change-detection      — if the file changed under us (external hand-edit),
 *                            abort with a conflict rather than clobber
 *  - atomic replace        — temp write + fsync + rename (POSIX-atomic)
 *  - .bak backup           — recoverable before every write
 *
 * ANAS never overwrites blindly: callers pass a `transform` that receives the
 * CURRENT file text and returns the new text (surgical edits only).
 */

/** Thrown when the file changed on disk between our read and write. */
export class ConfigConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Config file '${path}' changed on disk during the operation — retry against the current state`)
    this.name = 'ConfigConflictError'
  }
}

/** Per-path promise chain — serializes writes to the same file within anasd. */
const locks = new Map<string, Promise<unknown>>()

function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  // Chain regardless of prior success/failure so one failed write doesn't wedge the lock.
  const next = prev.catch(() => {}).then(fn)
  locks.set(path, next.catch(() => {}))
  return next
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Read a config file, returning '' if it doesn't exist yet. */
export async function readConfig(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return ''
    throw err
  }
}

/**
 * Surgically edit a config file. `transform(current)` returns the new content;
 * it must preserve everything it doesn't intend to change (Principle 12).
 *
 * The whole read → transform → verify-unchanged → backup → atomic-write runs
 * under the per-file lock. If the on-disk content changed between the initial
 * read and the write, throws ConfigConflictError (surfaced as 409).
 */
export async function editConfig(
  path: string,
  transform: (current: string) => string | Promise<string>,
): Promise<void> {
  await withFileLock(path, async () => {
    const before = await readConfig(path)
    const beforeHash = sha256(before)

    const next = await transform(before)
    if (next === before)
      return // no-op — nothing to write

    // Re-read immediately before writing to catch an external edit that landed
    // while we were transforming.
    const check = await readConfig(path)
    if (sha256(check) !== beforeHash)
      throw new ConfigConflictError(path)

    // Back up the current file (only if it exists) before replacing it.
    try {
      await access(path, fsConstants.F_OK)
      await copyFile(path, `${path}.bak`)
    }
    catch {
      // no existing file to back up (first write) — fine
    }

    // Atomic replace: write a temp file in the same directory, then rename.
    const tmp = join(dirname(path), `.${basename(path)}.anas.tmp`)
    await writeFile(tmp, next, { encoding: 'utf8', mode: 0o644 })
    await rename(tmp, path)
  })
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}
