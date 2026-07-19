import type { BackupRepo, BackupRepoTestResult, BackupTask } from '@anas/shared'
import type { PeerCertificate } from 'node:tls'
import type { CommandExecutor } from '../executor/types.js'
import { lookup } from 'node:dns/promises'
import { createConnection } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * Backup RUNNER logic (Epic 16.7) — assembles the pbc environment + argv,
 * executes proxmox-backup-client, parses its STDERR for progress, and
 * classifies the outcome. Also maps the pbc failure taxonomy to test verdicts.
 *
 * Ground-truth invariants (fixtures/backup/NOTES.md — do NOT contradict):
 *   - ALL pbc progress output is on STDERR; stdout is empty. Parse stderr.
 *   - Secrets ride PBS_PASSWORD via the ENVIRONMENT only — never argv, never
 *     logged, never in any detail string returned to a client.
 *   - PBS_REPOSITORY = user@host:port:datastore (token: user@realm!tokenname@…).
 *   - Every failure exits 255; the verbatim `Error:` string discriminates.
 *   - A rapid re-run collides on 1-second snapshot resolution with
 *     "backup timestamp is older than last backup." — that is BENIGN (too-soon),
 *     NOT a failure and NOT a dashboard warning.
 */

export const PBC = '/usr/bin/proxmox-backup-client'

/** Per-archive stats / reuse line (parse by the filename token, not position). */
const ARCHIVE_LINE_RE = /^\S+\.(?:pxar|mpxar|ppxar):\s/
/** The metadata-mode preflight fd warning (metadata mode only). */
const NOFILE_WARNING_RE = /resource limit for open file handles low:\s*\d+/
/** The group line: `Starting backup: [ns]:host/<backup-id>/<ISO-timestamp>`. */
const STARTING_RE = /^Starting backup:/
const DURATION_RE = /^Duration:/
/** The benign 1-second-resolution collision from a Run-Now just after a run. */
const TOO_SOON_RE = /backup timestamp is older than last backup/i
/** A backup GROUP is owned by one auth-id; a different auth-id is refused. */
const OWNER_MISMATCH_RE = /backup owner check failed/i
/** Trailing whitespace on a pbc output line (they end with padding spaces). */
const TRAILING_WS_RE = /\s+$/
/** Leading `sha256:`/`sha256=` prefix stripped when normalizing a fingerprint. */
const SHA256_PREFIX_RE = /^sha256[:=]?/i

// Test-verdict discriminators (verbatim pbc `Error:` strings; NOTES §6).
const DATASTORE_RE = /no such datastore/i
const NAMESPACE_RE = /ENOENT|No such file or directory/i
const PERM_MISSING_RE = /permission check failed\s*-\s*missing/i
const PERM_FAILED_RE = /permission check failed/i
const AUTH_FAILED_RE = /authentication failed/i
const CERT_MISMATCH_RE = /certificate fingerprint does not match/i
const CONNECT_ERR_RE = /client error \(Connect\)/i

// --- Env + argv assembly ----------------------------------------------------

/**
 * The `PBS_REPOSITORY` string: `<auth-id>@<host>:<port>:<datastore>`. For token
 * auth the auth-id is the token id (`user@realm!tokenname`); for password auth
 * it is the username (`user@realm`). Port is always included (pbc echoes it).
 */
export function buildRepoString(repo: BackupRepo): string {
  const authId = repo.authType === 'token' ? (repo.tokenId ?? '') : (repo.username ?? '')
  return `${authId}@${repo.host}:${repo.port}:${repo.datastore}`
}

/**
 * The pbc environment for a repo + secret. `PBS_PASSWORD` carries the account
 * password OR the token secret (env-only — never argv). `PBS_FINGERPRINT` pins
 * the cert when set. Namespace/backup-id ride argv, not the env.
 */
export function buildBackupEnv(repo: BackupRepo, secret: string): Record<string, string> {
  const env: Record<string, string> = {
    PBS_REPOSITORY: buildRepoString(repo),
    PBS_PASSWORD: secret,
  }
  if (repo.fingerprint)
    env.PBS_FINGERPRINT = repo.fingerprint
  return env
}

/**
 * The pbc `backup` argv (no secrets — those are env-only). Archives become
 * `<name>.pxar:<path>` args in order; each archive's excludes become `--exclude
 * <pattern>` (pbc applies --exclude across the whole invocation); then
 * `--backup-id`, optional `--ns`, and the metadata mode flag.
 */
export function buildBackupArgs(task: BackupTask): string[] {
  const args: string[] = ['backup']
  for (const a of task.archives)
    args.push(`${a.name}.pxar:${a.path}`)
  for (const a of task.archives) {
    for (const pattern of a.excludes)
      args.push('--exclude', pattern)
  }
  args.push('--backup-id', task.backupId)
  if (task.namespace)
    args.push('--ns', task.namespace)
  if (task.changeDetectionMode === 'metadata')
    args.push('--change-detection-mode=metadata')
  return args
}

/**
 * The cheap probe argv for the test endpoint: `snapshot list [--ns <ns>]
 * --output-format json`. It exercises tcp+tls+auth+datastore+namespace without
 * writing anything (the fixtures show which error appears at which stage).
 */
export function buildProbeArgs(namespace?: string): string[] {
  const args = ['snapshot', 'list']
  if (namespace)
    args.push('--ns', namespace)
  args.push('--output-format', 'json')
  return args
}

// --- STDERR progress parsing ------------------------------------------------

export interface BackupProgress {
  /** The `Starting backup: …` group line, if seen. */
  target: string | null
  /** Per-archive `had to backup / reused / incremental` lines (any pxar kind). */
  archiveStats: string[]
  /** The metadata `Change detection summary:` block (header + ` - …` lines). */
  changeDetectionSummary: string[]
  /** The metadata-only `resource limit for open file handles low: N` line. */
  nofileWarning: string | null
  /** The `Duration: …` line, if seen. */
  duration: string | null
}

/** Parse pbc STDERR into the progress units (per-archive stats + summary block). */
export function parseBackupProgress(stderr: string): BackupProgress {
  const progress: BackupProgress = {
    target: null,
    archiveStats: [],
    changeDetectionSummary: [],
    nofileWarning: null,
    duration: null,
  }
  const lines = stderr.split('\n')
  let inSummary = false
  for (const raw of lines) {
    const line = raw.replace(TRAILING_WS_RE, '')
    const trimmed = line.trim()
    if (!trimmed)
      continue
    if (STARTING_RE.test(trimmed))
      progress.target = trimmed
    if (NOFILE_WARNING_RE.test(trimmed))
      progress.nofileWarning = trimmed
    if (DURATION_RE.test(trimmed))
      progress.duration = trimmed
    if (trimmed.startsWith('Change detection summary:')) {
      inSummary = true
      progress.changeDetectionSummary.push(trimmed)
      continue
    }
    if (inSummary) {
      if (trimmed.startsWith('-')) {
        progress.changeDetectionSummary.push(trimmed)
        continue
      }
      inSummary = false
    }
    if (ARCHIVE_LINE_RE.test(trimmed))
      progress.archiveStats.push(trimmed)
  }
  return progress
}

/** A compact one-liner for the job's `progress` field (never a secret). */
export function progressSummary(progress: BackupProgress): string {
  const parts: string[] = []
  if (progress.archiveStats.length)
    parts.push(progress.archiveStats.join(' | '))
  else if (progress.target)
    parts.push(progress.target)
  if (progress.nofileWarning)
    parts.push(`(${progress.nofileWarning})`)
  return parts.join(' ')
}

// --- Result classification --------------------------------------------------

export type BackupOutcome
  = | { kind: 'success' }
  /** Benign 1-second collision (Run-Now just after a scheduled run). */
    | { kind: 'too-soon', detail: string }
  /** A real failure (incl. the owner-coupling case) — detail is client-safe. */
    | { kind: 'failure', detail: string, owner?: boolean }

/** Extract the client-safe `Error:` line (pbc stderr never carries the secret). */
export function firstErrorLine(stderr: string): string {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  const errLine = lines.find(l => l.startsWith('Error:'))
  return errLine ?? (lines.at(-1) ?? 'backup failed')
}

/**
 * Classify a pbc backup run. exit 0 → success. A too-soon collision is BENIGN
 * (skipped, not a failure — no dashboard warning). The owner-coupling refusal
 * gets a clear flag so the caller can surface an actionable message. Everything
 * else is a failure carrying the verbatim (secret-free) `Error:` line.
 */
export function classifyBackupResult(exitCode: number, stderr: string): BackupOutcome {
  if (exitCode === 0)
    return { kind: 'success' }
  if (TOO_SOON_RE.test(stderr))
    return { kind: 'too-soon', detail: firstErrorLine(stderr) }
  if (OWNER_MISMATCH_RE.test(stderr))
    return { kind: 'failure', detail: firstErrorLine(stderr), owner: true }
  return { kind: 'failure', detail: firstErrorLine(stderr) }
}

// --- Run one backup ---------------------------------------------------------

export interface BackupRunDeps {
  task: BackupTask
  repo: BackupRepo
  secret: string
}

export interface BackupRunResult {
  status: 'success' | 'skipped'
  /** The parsed target group line, when seen. */
  target?: string
  /** Per-archive stats lines (the job-progress units). */
  archives: string[]
  /** Present when pbc emitted the metadata-mode low-fd warning. */
  nofileWarning?: string
  /** Present for a benign too-soon skip (explains why it did nothing). */
  reason?: string
}

/**
 * Run one backup: assemble env + argv, exec pbc, parse STDERR for progress
 * (feeding `updateProgress`), and classify. Returns a result for success /
 * benign too-soon; THROWS on a real failure (so the job fails and systemd's
 * last-result is truthful). Secrets are env-only and never appear in the thrown
 * message or the returned result.
 */
export async function runBackup(
  executor: CommandExecutor,
  deps: BackupRunDeps,
  updateProgress: (message: string) => void,
): Promise<BackupRunResult> {
  const { task, repo, secret } = deps
  const env = buildBackupEnv(repo, secret)
  const args = buildBackupArgs(task)

  updateProgress(`starting backup ${task.name} → ${repo.name}:${repo.datastore}`)
  const r = await executor.exec(PBC, args, { env })

  const progress = parseBackupProgress(r.stderr)
  const summary = progressSummary(progress)
  if (summary)
    updateProgress(summary)

  const outcome = classifyBackupResult(r.exitCode, r.stderr)
  if (outcome.kind === 'failure') {
    const prefix = outcome.owner
      ? 'backup owner mismatch — this backup-id is owned by a different auth-id; '
      + 'switching a repo\'s auth style needs a server-side change-owner. '
      : ''
    throw new Error(`${prefix}${outcome.detail}`)
  }

  const result: BackupRunResult = {
    status: outcome.kind === 'too-soon' ? 'skipped' : 'success',
    archives: progress.archiveStats,
  }
  if (progress.target)
    result.target = progress.target
  if (progress.nofileWarning)
    result.nofileWarning = progress.nofileWarning
  if (outcome.kind === 'too-soon')
    result.reason = 'snapshot timestamp collision (1-second resolution) — nothing new to back up yet'
  return result
}

// --- Test-endpoint verdict (the pbc probe stage) ----------------------------

/**
 * Map the pbc probe result (AFTER the daemon's own dns/tcp/tls stages pass) to a
 * test verdict. Order matters: the token no-ACL `- missing` suffix must be
 * checked before the generic `permission check failed`. There is no separate
 * 'permission' verdict in the UI/DESIGN set — an authenticated-but-unauthorized
 * token folds into 'auth' with a distinguishing detail.
 */
export function classifyTestVerdict(exitCode: number, stderr: string): BackupRepoTestResult {
  if (exitCode === 0)
    return { stage: 'ok' }
  const s = stderr
  if (DATASTORE_RE.test(s))
    return { stage: 'datastore', detail: firstErrorLine(s) }
  if (NAMESPACE_RE.test(s))
    return { stage: 'namespace', detail: firstErrorLine(s) }
  if (PERM_MISSING_RE.test(s))
    return { stage: 'auth', detail: 'Authenticated, but the token is missing the required Datastore privileges.' }
  if (PERM_FAILED_RE.test(s))
    return { stage: 'auth', detail: 'Authentication failed — check the password.' }
  if (AUTH_FAILED_RE.test(s))
    return { stage: 'auth', detail: 'Authentication failed — check the token id/secret (a revoked token looks the same).' }
  if (CERT_MISMATCH_RE.test(s))
    return { stage: 'tls-fingerprint', detail: 'Certificate fingerprint does not match the pinned value.' }
  if (CONNECT_ERR_RE.test(s))
    return { stage: 'tcp', detail: 'Could not connect to the server.' }
  return { stage: 'auth', detail: firstErrorLine(s) }
}

// --- Network probes (dns / tcp / tls fingerprint) ---------------------------
//
// pbc collapses dns/tcp/route into one `client error (Connect)` (NOTES §6), so
// the daemon renders those verdicts itself (same lesson as the mounts test).
// The TLS fingerprint is fetched in-node (no shell) so the UI's explicit-confirm
// flow gets the server's real cert fingerprint even when nothing is pinned yet.

/** Normalize a cert fingerprint to lowercase colon-hex (the PBS/pbc format). */
export function normalizeFingerprint(fp: string): string {
  return fp.trim().toLowerCase().replace(SHA256_PREFIX_RE, '').trim()
}

/** DNS resolvable? (node dns.lookup — no shell). */
export async function resolvesDns(host: string): Promise<boolean> {
  try {
    await lookup(host)
    return true
  }
  catch {
    return false
  }
}

/** TCP connect within `timeoutMs` (node net — no shell). */
export function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Fetch the server's TLS certificate fingerprint (sha256, lowercase colon-hex)
 * without validating it — PBS uses a self-signed cert, so we pin by fingerprint,
 * not by CA. Returns null on any connect/handshake failure.
 */
export function fetchServerFingerprint(host: string, port: number, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, servername: host }, () => {
      const cert = socket.getPeerCertificate() as PeerCertificate | undefined
      const raw = cert && cert.fingerprint256 ? cert.fingerprint256 : ''
      finish(raw ? normalizeFingerprint(raw) : null)
    })
    let settled = false
    function finish(fp: string | null): void {
      if (settled)
        return
      settled = true
      socket.destroy()
      resolve(fp)
    }
    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}
