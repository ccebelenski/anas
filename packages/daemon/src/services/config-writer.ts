import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, copyFile, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from './file-lock.js'

/**
 * Concurrency-safe, non-destructive editor for system config files
 * (smb.conf, /etc/exports). Implements DESIGN §5b:
 *
 *  - per-file mutex        — two ANAS jobs never read-modify-write concurrently
 *  - read fresh every time — the edit applies to the real current state
 *  - change-detection      — if the file changed under us (external hand-edit),
 *                            abort with a conflict rather than clobber
 *  - atomic replace        — see writeFileAtomic below (fsync + rename with
 *                            the target's mode/owner carried onto the temp)
 *  - .bak backup           — recoverable before every write
 *
 * ANAS never overwrites blindly: callers pass a `transform` that receives the
 * CURRENT file text and returns the new text (surgical edits only).
 */

export interface WriteAtomicOptions {
  /**
   * Mode for the file when the TARGET does not exist yet (an existing target
   * keeps its own mode). Default 0o644; secret-file callers pass 0o600
   * (EPICS §2 Secrets: creds files are root-only).
   */
  mode?: number
}

/**
 * Is this path on pmxcfs — PVE's cluster filesystem, mounted at /etc/pve
 * (EPICS §2: cluster-wide registries and `/etc/pve/priv/anas/*` live there)?
 *
 * pmxcfs fixes ownership and mode at the filesystem level: chmod/chown are
 * not supported there, and the FUSE layer is known to reject some fsync
 * calls. Writers to pmxcfs must therefore skip the mode/owner copy and treat
 * an fsync failure as non-fatal. (Needs a node check: exactly which fsync
 * calls pmxcfs rejects, and whether O_CREAT|O_EXCL and the create-time mode
 * are honoured there.)
 */
export function isPmxcfsPath(path: string): boolean {
  return path === '/etc/pve' || path.startsWith('/etc/pve/')
}

/**
 * The temp path for one write: same directory as the target (so the rename
 * is atomic), hidden, and UNPREDICTABLE — a fixed name is guessable and
 * pre-creatable by another writer in a world-readable directory. Exported
 * as a test seam (same convention as rclone-config's writeConfigFileAtomic).
 */
export function atomicTmpPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
}

/**
 * The ONE atomic config-file writer (review M4). Every ANAS config write
 * goes through here:
 *
 *  1. create `<dir>/.<name>.tmp-<pid>-<random>` with O_CREAT|O_EXCL ('wx')
 *     and mode 0600 — unpredictable name (a fixed one is guessable in a
 *     world-readable directory), private from the first byte, and exclusive
 *     so two writers never share a temp;
 *  2. write, fsync the file — the bytes are on disk before the rename;
 *  3. metadata: an existing target's mode/uid/gid are copied onto the temp
 *     (a bare rename would silently drop them), or, for a new file, the
 *     caller's mode. Skipped under /etc/pve: pmxcfs fixes ownership and
 *     mode and rejects chmod/chown;
 *  4. rename over the target (POSIX-atomic — readers see old or new, never
 *     a mix), then fsync the DIRECTORY so the rename itself survives a crash
 *     — best-effort: a filesystem that rejects directory fsync (pmxcfs) must
 *     not fail the write whose data is already durable;
 *  5. any error before the rename unlinks the temp — no orphans.
 */
export async function writeFileAtomic(path: string, data: string, opts: WriteAtomicOptions = {}): Promise<void> {
  const mode = opts.mode ?? 0o644
  const pmxcfs = isPmxcfsPath(path)
  const dir = dirname(path)
  const tmp = atomicTmpPath(path)

  const fh = await open(tmp, 'wx', 0o600)
  try {
    await fh.writeFile(data, 'utf8')
    if (pmxcfs)
      await fh.sync().catch(() => {}) // pmxcfs may reject it; data loss here is at most this write
    else
      await fh.sync()

    const target = await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT')
        return null
      throw err
    })
    if (target) {
      if (!pmxcfs) {
        await fh.chmod(target.mode & 0o7777)
        await fh.chown(target.uid, target.gid)
      }
    }
    else if (!pmxcfs) {
      // New file: the caller's intended mode (it was created at 0600 so a
      // failure below never exposes a wider-mode orphan).
      await fh.chmod(mode)
    }
    await fh.close()
  }
  catch (err) {
    await fh.close().catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }

  try {
    await rename(tmp, path)
  }
  catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }

  // Best-effort directory fsync (non-fatal by design — see step 4 above).
  try {
    const dh = await open(dir, 'r')
    try {
      await dh.sync()
    }
    finally {
      await dh.close()
    }
  }
  catch {
    // A filesystem without a syncable dir handle (or pmxcfs) — ignore.
  }
}

/** Thrown when the file changed on disk between our read and write. */
export class ConfigConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Config file '${path}' changed on disk during the operation — retry against the current state`)
    this.name = 'ConfigConflictError'
  }
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

    // Atomic replace via the shared helper. A new file gets the default
    // 0644 (the old inline write's mode); an existing one keeps its own
    // mode and owner instead of silently taking 0644 from the rename.
    await writeFileAtomic(path, next)
  })
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}
