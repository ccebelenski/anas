import type { BackupRepo, BackupRepoRegistry } from '@anas/shared'
import type { PbsStorageDef } from '../parsers/pve-storage.js'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { BackupRepoRegistry as BackupRepoRegistrySchema, PVE_REPO_PREFIX } from '@anas/shared'
import { PVE_PRIV_STORAGE_DIR, PVE_STORAGE_CFG } from '../parsers/pve-storage.js'

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
  /**
   * storage.cfg — read-only, for tier-1 PVE-defined repos (Epic 16.8). ANAS
   * never writes it. Reuses the mounts-tagging ANAS_STORAGE_CFG override.
   */
  pveStorageCfg: string
  /**
   * The PVE per-storage secret dir (`/etc/pve/priv/storage`). A tier-1 repo's
   * secret is read from `<id>.pw` here at exec/test time — never copied,
   * never cached. ANAS never writes it.
   */
  pvePrivStorageDir: string
}

/** Default paths (env-overridable, else the pmxcfs / system locations). */
export function defaultBackupReposPaths(): BackupReposPaths {
  return {
    registryFile: process.env.ANAS_BACKUP_REPOS_FILE ?? '/etc/pve/anas/backup-repos.json',
    credsDir: process.env.ANAS_BACKUP_CREDS_DIR ?? '/etc/anas/creds',
    pveStorageCfg: process.env.ANAS_STORAGE_CFG ?? PVE_STORAGE_CFG,
    pvePrivStorageDir: process.env.ANAS_PVE_PRIV_STORAGE_DIR ?? PVE_PRIV_STORAGE_DIR,
  }
}

/** This node's name — labels registry writes (updatedBy). Overridable for tests. */
export function backupNodename(): string {
  return process.env.ANAS_NODENAME ?? hostname()
}

/** A single trailing newline on a PVE `.pw` file (bare secret + `\n`). */
const PW_TRAILING_NEWLINE_RE = /\r?\n$/

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

// --- Tier 1: PVE-defined repositories (Epic 16.8) ---------------------------
//
// A `pbs` storage in /etc/pve/storage.cfg is offered as a hands-off repository
// named `pve:<storage-id>` (the reserved namespace — a tier-2 BackupName can
// never carry a colon, so the two tiers never collide). The server/datastore/
// username/fingerprint come from the read-only parse; the SECRET is read from
// /etc/pve/priv/storage/<id>.pw ONLY at exec/test time — never copied into
// /etc/anas/creds, never cached in memory beyond the exec, never returned.

/** The tier-1 repo name for a PVE storage id (`anastest-pw` → `pve:anastest-pw`). */
export function pveRepoName(id: string): string {
  return `${PVE_REPO_PREFIX}${id}`
}

/** Is this repo reference a tier-1 PVE-defined repo (`pve:<id>`)? */
export function isPveRepoName(name: string): boolean {
  return name.startsWith(PVE_REPO_PREFIX)
}

/** The PVE storage id behind a `pve:<id>` reference (`pve:foo` → `foo`). */
export function pveStorageId(name: string): string {
  return name.slice(PVE_REPO_PREFIX.length)
}

/**
 * Map a parsed PBS stanza onto the runtime {@link BackupRepo} shape (name
 * `pve:<id>`). The auth style is inferred from the username: a token id carries
 * a `!tokenname` suffix (ground truth 16.1/16.8), otherwise it is password auth.
 * This object is built in-process (never zod-parsed), so the colon in the name
 * is fine — the runner reads host/port/datastore/authType/username|tokenId, not
 * the name, to build PBS_REPOSITORY.
 */
export function pbsDefToRepo(def: PbsStorageDef): BackupRepo {
  const isToken = (def.username ?? '').includes('!')
  const repo: BackupRepo = {
    name: pveRepoName(def.id),
    host: def.server,
    port: def.port ?? 8007,
    datastore: def.datastore,
    authType: isToken ? 'token' : 'password',
  }
  if (def.namespace)
    repo.namespace = def.namespace
  if (def.fingerprint)
    repo.fingerprint = def.fingerprint
  if (isToken)
    repo.tokenId = def.username
  else if (def.username)
    repo.username = def.username
  return repo
}

/** Path of a PVE storage's secret file (`<privDir>/<id>.pw`). */
export function pveSecretPath(privDir: string, id: string): string {
  return join(privDir, `${id}.pw`)
}

/**
 * Read a PVE storage's secret from its `.pw` file, or null if absent. Ground
 * truth (16.8): the file is the bare secret plus a single trailing newline
 * (`AnasPbsTest123\n`), so a lone trailing newline is stripped — nothing else is
 * touched (the secret is used verbatim as PBS_PASSWORD). Read fresh EVERY time
 * (rotation in PVE is instantly effective — ANAS holds no second copy).
 */
export async function readPveSecret(privDir: string, id: string): Promise<string | null> {
  try {
    const raw = await readFile(pveSecretPath(privDir, id), 'utf-8')
    return raw.replace(PW_TRAILING_NEWLINE_RE, '')
  }
  catch {
    return null
  }
}

/** Does this PVE storage have a secret file? (drives tier-1 `credentialsSet`). */
export async function pveSecretSet(privDir: string, id: string): Promise<boolean> {
  return (await readPveSecret(privDir, id)) !== null
}
