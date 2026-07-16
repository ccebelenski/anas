import type { RemotesFile, ReplicationRemote } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { RemotesFile as RemotesFileSchema } from '@anas/shared'

/**
 * Stage-3 remotes registry (Epic 5.5.2) — the COROSYNC STORE.
 *
 * The registry lives in pmxcfs at /etc/pve/anas/remotes.json (corosync-replicated
 * cluster-wide), the ONE cluster-wide keypair at /etc/pve/priv/anas/replication_key
 * (pmxcfs enforces 0600 root-only), and pinned host keys at
 * /etc/pve/priv/anas/known_hosts. Every path is overridable (env/deps) so tests
 * run against temp dirs.
 *
 * Split-brain guard (operator requirement): the file carries a monotonic
 * `version`; ALL writes are COMPARE-AND-SWAP — the caller passes the version it
 * read, we re-read under a per-file lock, and if it moved we throw
 * RemotesConflictError (→ 409). pmxcfs gives us atomic file replace underneath
 * (write-temp-then-rename), so a torn write is never visible.
 */

const SSH_KEYGEN = '/usr/bin/ssh-keygen'
const SSH_KEYSCAN = '/usr/bin/ssh-keyscan'

const TRAILING_EQUALS_RE = /=+$/
const WHITESPACE_RE = /\s+/
const TRAILING_NEWLINES_RE = /\n+$/

/** All the corosync-store paths — overridable for tests. */
export interface RemotesPaths {
  /** The registry JSON (pmxcfs-replicated). */
  registryFile: string
  /** The private key path; the public key is `${keyPath}.pub`. */
  keyPath: string
  /** Our pinned host keys (NOT the system known_hosts). */
  knownHostsFile: string
}

/** Default paths (env-overridable, else the pmxcfs locations). */
export function defaultRemotesPaths(): RemotesPaths {
  return {
    registryFile: process.env.ANAS_REMOTES_FILE ?? '/etc/pve/anas/remotes.json',
    keyPath: process.env.ANAS_REPL_KEY ?? '/etc/pve/priv/anas/replication_key',
    knownHostsFile: process.env.ANAS_REPL_KNOWN_HOSTS ?? '/etc/pve/priv/anas/known_hosts',
  }
}

/** This node's name — labels registry writes (updatedBy). Overridable for tests. */
export function nodename(): string {
  return process.env.ANAS_NODENAME ?? hostname()
}

/** Thrown when the registry moved between the caller's read and our CAS write. */
export class RemotesConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super(`remotes registry changed (version ${currentVersion}) — reload and retry`)
    this.name = 'RemotesConflictError'
  }
}

// --- Registry read / CAS write ----------------------------------------------

/** The empty registry an absent file stands in for. */
function emptyRegistry(): RemotesFile {
  return { version: 0, updatedBy: '', updatedAt: new Date(0).toISOString(), remotes: [] }
}

/**
 * Read + zod-validate the registry. An absent file is the empty registry
 * (version 0, no remotes). A present-but-invalid file throws — we never silently
 * discard a real registry we can't parse.
 */
export async function readRemotes(paths: RemotesPaths): Promise<RemotesFile> {
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
  const parsed = RemotesFileSchema.safeParse(JSON.parse(text))
  if (!parsed.success)
    throw new Error(`remotes registry is invalid: ${parsed.error.issues[0]?.message}`)
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
 * version no longer equals `expectedVersion`, throws RemotesConflictError.
 * Otherwise writes `{ version: expectedVersion + 1, updatedBy, updatedAt, remotes }`
 * via write-temp-then-rename (atomic replace). Returns the written file.
 */
export async function writeRemotes(
  paths: RemotesPaths,
  expectedVersion: number,
  remotes: ReplicationRemote[],
  hooks: WriteHooks = {},
): Promise<RemotesFile> {
  return withFileLock(paths.registryFile, async () => {
    if (hooks.beforeRead)
      await hooks.beforeRead()
    const current = await readRemotes(paths)
    if (current.version !== expectedVersion)
      throw new RemotesConflictError(current.version)

    const next: RemotesFile = {
      version: expectedVersion + 1,
      updatedBy: nodename(),
      updatedAt: new Date().toISOString(),
      remotes,
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

// --- Keypair -----------------------------------------------------------------

/**
 * Ensure the cluster-wide replication keypair exists and return its PUBLIC key
 * text (for the UI to show for pasting into the remote's authorized_keys).
 * Idempotent: if `${keyPath}.pub` already exists we never re-run ssh-keygen.
 * The passphrase is a fixed empty string (`-N ''`) — a private key on 0600
 * pmxcfs storage, never a secret on argv.
 */
export async function ensureKeypair(executor: CommandExecutor, paths: RemotesPaths): Promise<string> {
  const pubPath = `${paths.keyPath}.pub`
  if (!(await fileExists(pubPath))) {
    await mkdir(dirname(paths.keyPath), { recursive: true })
    const r = await executor.exec(SSH_KEYGEN, ['-t', 'ed25519', '-N', '', '-C', 'anas-replication', '-f', paths.keyPath])
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `ssh-keygen exited with code ${r.exitCode}`)
  }
  try {
    return (await readFile(pubPath, 'utf-8')).trim()
  }
  catch {
    return ''
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf-8')
    return true
  }
  catch {
    return false
  }
}

// --- Host-key pinning --------------------------------------------------------

/** The known_hosts host field: bare host on port 22, `[host]:port` otherwise. */
export function knownHostField(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/**
 * SHA256 fingerprint of an SSH host key from its base64 wire blob, computed in
 * node (no shell). Matches `ssh-keygen -lf` output: `SHA256:<base64-no-pad>`.
 */
export function fingerprintFromBlob(base64Blob: string): string {
  const der = Buffer.from(base64Blob, 'base64')
  const digest = createHash('sha256').update(der).digest('base64').replace(TRAILING_EQUALS_RE, '')
  return `SHA256:${digest}`
}

export interface ScannedKey {
  /** The raw known_hosts line (`<hostfield> <keytype> <blob>`). */
  line: string
  keyType: string
  fingerprint: string
}

/** Parse ssh-keyscan stdout into keys, skipping comments/blanks/malformed lines. */
export function parseScan(stdout: string): ScannedKey[] {
  const keys: ScannedKey[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#'))
      continue
    const parts = line.split(WHITESPACE_RE)
    if (parts.length < 3)
      continue
    const [, keyType, blob] = parts
    keys.push({ line, keyType, fingerprint: fingerprintFromBlob(blob) })
  }
  return keys
}

/** Prefer ed25519, else the first scanned key (matches the fingerprint we show). */
function preferredKey(keys: ScannedKey[]): ScannedKey | null {
  return keys.find(k => k.keyType === 'ssh-ed25519') ?? keys[0] ?? null
}

/**
 * `ssh-keyscan -p <port> <host>` → the parsed keys (does NOT pin). Returns [] on
 * an unreachable host / empty scan.
 */
export async function scanHostKeys(executor: CommandExecutor, host: string, port: number): Promise<ScannedKey[]> {
  const r = await executor.exec(SSH_KEYSCAN, ['-p', String(port), host])
  if (!r.stdout.trim())
    return []
  return parseScan(r.stdout)
}

/**
 * Pin a host's key(s): scan, append every new line to our known_hosts, and
 * return the (preferred) fingerprint. Returns null when nothing was scanned.
 */
export async function pinHostKey(
  executor: CommandExecutor,
  paths: RemotesPaths,
  host: string,
  port: number,
): Promise<string | null> {
  const keys = await scanHostKeys(executor, host, port)
  const chosen = preferredKey(keys)
  if (!chosen)
    return null

  let existing = ''
  try {
    existing = await readFile(paths.knownHostsFile, 'utf-8')
  }
  catch {
    // First pin — no file yet.
  }
  const have = new Set(existing.split('\n').map(l => l.trim()).filter(Boolean))
  const additions = keys.map(k => k.line).filter(l => !have.has(l))
  if (additions.length) {
    await mkdir(dirname(paths.knownHostsFile), { recursive: true })
    const body = `${[existing.replace(TRAILING_NEWLINES_RE, ''), ...additions].filter(Boolean).join('\n')}\n`
    const tmp = join(dirname(paths.knownHostsFile), `.${basename(paths.knownHostsFile)}.anas.tmp`)
    await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 })
    await rename(tmp, paths.knownHostsFile)
  }
  return chosen.fingerprint
}

/**
 * The pinned fingerprint for a host from our known_hosts, or null if unknown.
 * Matches the host field for the given port (bare host / `[host]:port`).
 */
export async function fingerprintOf(paths: RemotesPaths, host: string, port: number): Promise<string | null> {
  let text: string
  try {
    text = await readFile(paths.knownHostsFile, 'utf-8')
  }
  catch {
    return null
  }
  const field = knownHostField(host, port)
  const matches: ScannedKey[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#'))
      continue
    const parts = line.split(WHITESPACE_RE)
    if (parts.length < 3)
      continue
    // The host field may carry a comma list (`host,1.2.3.4`) — match any entry.
    const hosts = parts[0].split(',')
    if (hosts.includes(field))
      matches.push({ line, keyType: parts[1], fingerprint: fingerprintFromBlob(parts[2]) })
  }
  return preferredKey(matches)?.fingerprint ?? null
}
