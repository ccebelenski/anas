import type { BackupRepo, BackupRepoRegistry } from '@anas/shared'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { BackupRepoRegistry as BackupRepoRegistrySchema } from '@anas/shared'

/**
 * PBS repositories registry (Epic 16.2) — the COROSYNC STORE, reusing the
 * replication-remotes machinery with a different payload.
 *
 * The registry lives in pmxcfs at /etc/pve/anas/backup-repos.json (corosync-
 * replicated cluster-wide); per-repo secrets live in root-only 0600 files under
 * /etc/anas/creds/ (write-only through the API — token secret OR account
 * password). Every path is overridable (env/deps) so tests run against temp dirs.
 *
 * Split-brain guard (same as remotes): the file carries a monotonic `version`;
 * ALL writes are COMPARE-AND-SWAP — the caller passes the version it read, we
 * re-read under a per-file lock, and if it moved we throw BackupReposConflictError
 * (→ 409). Writes are write-temp-then-rename (atomic replace).
 *
 * Secrets NEVER enter the registry JSON — only the per-repo creds file. The
 * fingerprint IS stored with the repo (explicit-confirm cert pin).
 */

/** The registry + creds paths — overridable for tests. */
export interface BackupReposPaths {
  /** The registry JSON (pmxcfs-replicated). */
  registryFile: string
  /** Directory holding per-repo 0600 secret files. */
  credsDir: string
}

/** Default paths (env-overridable, else the pmxcfs / system locations). */
export function defaultBackupReposPaths(): BackupReposPaths {
  return {
    registryFile: process.env.ANAS_BACKUP_REPOS_FILE ?? '/etc/pve/anas/backup-repos.json',
    credsDir: process.env.ANAS_BACKUP_CREDS_DIR ?? '/etc/anas/creds',
  }
}

/** This node's name — labels registry writes (updatedBy). Overridable for tests. */
export function backupNodename(): string {
  return process.env.ANAS_NODENAME ?? hostname()
}

/** Thrown when the registry moved between the caller's read and our CAS write. */
export class BackupReposConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super(`backup repositories registry changed (version ${currentVersion}) — reload and retry`)
    this.name = 'BackupReposConflictError'
  }
}

// --- Registry read / CAS write ----------------------------------------------

/** The empty registry an absent file stands in for. */
function emptyRegistry(): BackupRepoRegistry {
  return { version: 0, updatedBy: '', updatedAt: new Date(0).toISOString(), repos: [] }
}

/**
 * Read + zod-validate the registry. An absent (or empty) file is the empty
 * registry (version 0, no repos). A present-but-invalid file throws — we never
 * silently discard a real registry we can't parse.
 */
export async function readBackupRepos(paths: BackupReposPaths): Promise<BackupRepoRegistry> {
  let text: string
  try {
    text = await readFile(paths.registryFile, 'utf-8')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyRegistry()
    throw err
  }
  if (!text.trim())
    return emptyRegistry()
  const parsed = BackupRepoRegistrySchema.safeParse(JSON.parse(text))
  if (!parsed.success)
    throw new Error(`backup repositories registry is invalid: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

/** Per-path promise chain — serializes CAS writes to the same file in-process. */
const locks = new Map<string, Promise<unknown>>()
function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(path, next.catch(() => {}))
  return next
}

/** Test seam: run something between acquiring the lock and the CAS re-read. */
export interface WriteHooks {
  /** Invoked under the lock, BEFORE the CAS re-read — a competing write here is caught. */
  beforeRead?: () => Promise<void>
}

/**
 * COMPARE-AND-SWAP write. Re-reads the registry under the per-file lock; if its
 * version no longer equals `expectedVersion`, throws BackupReposConflictError.
 * Otherwise writes `{ version: expectedVersion + 1, updatedBy, updatedAt, repos }`
 * via write-temp-then-rename (atomic replace). Returns the written file.
 */
export async function writeBackupRepos(
  paths: BackupReposPaths,
  expectedVersion: number,
  repos: BackupRepo[],
  hooks: WriteHooks = {},
): Promise<BackupRepoRegistry> {
  return withFileLock(paths.registryFile, async () => {
    if (hooks.beforeRead)
      await hooks.beforeRead()
    const current = await readBackupRepos(paths)
    if (current.version !== expectedVersion)
      throw new BackupReposConflictError(current.version)

    const next: BackupRepoRegistry = {
      version: expectedVersion + 1,
      updatedBy: backupNodename(),
      updatedAt: new Date().toISOString(),
      repos,
    }
    await mkdir(dirname(paths.registryFile), { recursive: true })
    const tmp = join(dirname(paths.registryFile), `.${basename(paths.registryFile)}.anas.tmp`)
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    await rename(tmp, paths.registryFile)
    return next
  })
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

// --- Per-repo secret files (0600 root-only) ---------------------------------

/** Deterministic secret filename for a repo (e.g. `backup-repo-pbs-main.secret`). */
export function repoSecretFileName(name: string): string {
  return `backup-repo-${name}.secret`
}

/** Full secret-file path for a repo under the creds dir. */
export function repoSecretPath(dir: string, name: string): string {
  return join(dir, repoSecretFileName(name))
}

/**
 * Write a repo's secret atomically: ensure `dir` (0700 root), write the secret
 * file 0600. The secret never touches argv/logs. The file holds ONLY the raw
 * secret bytes (no key=value framing) — it is read back verbatim into
 * `PBS_PASSWORD`.
 */
export async function writeRepoSecret(dir: string, name: string, secret: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  const path = repoSecretPath(dir, name)
  const tmp = join(dirname(path), `.${repoSecretFileName(name)}.anas.tmp`)
  await writeFile(tmp, secret, { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
  return path
}

/** Read a repo's stored secret, or null if none is set. */
export async function readRepoSecret(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(repoSecretPath(dir, name), 'utf-8')
  }
  catch {
    return null
  }
}

/** Is a secret stored for this repo? (drives `credentialsSet` in responses). */
export async function repoSecretSet(dir: string, name: string): Promise<boolean> {
  return (await readRepoSecret(dir, name)) !== null
}

/** Remove a repo's secret file (best-effort — the goal state is "absent"). */
export async function removeRepoSecret(dir: string, name: string): Promise<void> {
  await rm(repoSecretPath(dir, name), { force: true }).catch(() => {})
}
