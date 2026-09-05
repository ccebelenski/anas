import type {
  BackupGroup,
  BackupReadVerdict,
  BackupRepo,
  BackupSnapshot,
  BackupSnapshotFile,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import {
  classifyArchiveFile,
  composeGroupId,
  composeSnapshotId,
  snapshotTimeIso,
} from '@anas/shared'
import { buildBackupEnv, classifyPermissionFailure, firstErrorLine, PBC } from './backup-runner.js'

/**
 * Backup RESTORE READS (story backup2.5) — the point-in-time and group listings
 * a restore starts from.
 *
 * These are USER-INITIATED PBS contacts, newly sanctioned by the Epic 16 ruling
 * for phase 2 ("snapshot listing for a restore"). One call per click, never a
 * poll, never a background refresh: nothing here is ever scheduled.
 *
 * Ground truth (docs/BACKUP-RESTORE-GROUND-TRUTH.md §1) — do NOT contradict:
 *   - GT-1: `snapshot list --output-format json` has NO `snapshot` field. The
 *     caller composes `<backup-type>/<backup-id>/<RFC3339 backup-time>`;
 *     `backup-time` is UNIX SECONDS.
 *   - GT-2: the array is NOT sorted by time. The picker sorts, we do it here so
 *     there is exactly one sort in the system.
 *   - GT-3: `files` are OBJECTS in `snapshot list` and bare STRINGS in `list`.
 *   - GT-4: `files[].size` is the logical archive size — the restore space
 *     estimate, readable without downloading anything.
 *   - GT-5: a nonexistent GROUP inside a real namespace is `[]` at exit 0 (not
 *     an error); a nonexistent NAMESPACE is `Error: ENOENT`, exit 255.
 *   - Secrets ride the environment only (`buildBackupEnv`), never argv.
 */

// --- Failure taxonomy -------------------------------------------------------

/** `Error: ENOENT: No such file or directory` — group AND namespace both (GT). */
const ENOENT_RE = /ENOENT|No such file or directory/i
/** `Error: snapshot host/<g>/<t> does not exist.` — snapshot, group OR namespace. */
const SNAPSHOT_MISSING_RE = /snapshot\s+\S+\s+does not exist/i
/** `Error: archive not found in manifest`. */
const ARCHIVE_MISSING_RE = /archive not found in manifest/i
/** `Error: failed to parse archive type for '<name>'` (a missing type suffix). */
const ARCHIVE_TYPE_RE = /failed to parse archive type/i
/** `Error: Can only mount pxar archives.` (an `.img` handed to catalog shell). */
const NOT_PXAR_RE = /can only mount pxar archives/i
/** The catalog-shell path has its OWN wording: `no permissions on /datastore/…`. */
const PERM_NONE_RE = /no permissions on/i
/** `Error: client error (Connect)` — the transport never came up. */
const CONNECT_RE = /client error \(Connect\)/i

/**
 * The ONE message for a missing snapshot / group / namespace.
 *
 * GT-56 measured all three producing the SAME string, and the prune path
 * (16.11) already reached the same conclusion for its own ENOENT. Guessing
 * which of the three is wrong would be fiction, so the message names all of
 * them. ASCII only — these details ride notification bodies unchanged.
 */
export const NOT_FOUND_DETAIL
  = 'PBS reports no such snapshot, group or namespace - the server returns the '
    + 'same error for all three, so which one is missing cannot be told apart.'

/**
 * Classify a FAILED pbc read (`snapshot list`, `list`, `catalog shell`) into a
 * verdict plus a client-safe detail. One classifier for all three so a wording
 * change happens once.
 *
 * `timedOut` is the caller's own `timeout(1)` verdict (exit 124): the child was
 * killed because it never came back, which is an unreachable server as far as
 * the user is concerned — and saying "timed out" is more useful than the empty
 * stderr a killed pbc leaves.
 */
export function classifyBackupReadVerdict(
  exitCode: number,
  stderr: string,
  timedOut = false,
): { verdict: BackupReadVerdict, detail: string } {
  if (timedOut) {
    return {
      verdict: 'unreachable',
      detail: 'The Proxmox Backup Server did not answer in time - the request was cancelled.',
    }
  }
  if (PERM_NONE_RE.test(stderr)) {
    return {
      verdict: 'permission',
      detail: `The credential lacks read access to this datastore/namespace - PBS wants `
        + `Datastore.Audit or Datastore.Backup (${firstErrorLine(stderr)}).`,
    }
  }
  // The auth-vs-privileges split is the ONE classifier's (R5): the `- missing`
  // suffix means an authenticated-but-unauthorized credential (a permissions
  // problem); the BARE `permission check failed` means the credential was
  // REJECTED — a wrong password — and must not read as the Datastore.Audit
  // wording. There is no auth verdict in the read set, so a rejected
  // credential folds into `error` with the credential wording, the same fold
  // the repo test makes into its `auth` stage.
  const perm = classifyPermissionFailure(stderr)
  if (perm === 'missing-privileges') {
    return {
      verdict: 'permission',
      detail: `The credential lacks read access to this datastore/namespace - PBS wants `
        + `Datastore.Audit or Datastore.Backup (${firstErrorLine(stderr)}).`,
    }
  }
  if (perm === 'authentication') {
    return {
      verdict: 'error',
      detail: `PBS rejected the credential before any listing - this is an authentication failure, not a `
        + `permissions problem (check the password, or the token id and secret). (${firstErrorLine(stderr)})`,
    }
  }
  if (CONNECT_RE.test(stderr)) {
    // pbc 4.2.5 follows the identical `client error (Connect)` line with a
    // `Caused by:` block that DOES separate dns / tcp / tls (GT-58). Carry it
    // through verbatim rather than re-deriving the cause.
    const cause = stderr
      .split('\n')
      .map(l => l.trim())
      .find(l => l.startsWith('error connecting') || l.startsWith('dns error') || l.startsWith('tcp connect error'))
    return {
      verdict: 'unreachable',
      detail: cause
        ? `Could not reach the Proxmox Backup Server: ${cause}`
        : 'Could not reach the Proxmox Backup Server (connection failed).',
    }
  }
  if (ARCHIVE_MISSING_RE.test(stderr)) {
    return {
      verdict: 'not-found',
      detail: 'That archive is not in this snapshot - pick another archive or another point in time.',
    }
  }
  if (ARCHIVE_TYPE_RE.test(stderr)) {
    return {
      verdict: 'error',
      detail: `The archive name must carry its type suffix (.pxar / .mpxar / .img): ${firstErrorLine(stderr)}`,
    }
  }
  if (NOT_PXAR_RE.test(stderr)) {
    return {
      verdict: 'error',
      detail: 'A block image cannot be browsed - it is restored whole.',
    }
  }
  if (SNAPSHOT_MISSING_RE.test(stderr) || ENOENT_RE.test(stderr))
    return { verdict: 'not-found', detail: NOT_FOUND_DETAIL }
  return {
    verdict: 'error',
    detail: firstErrorLine(stderr) || `proxmox-backup-client exited with code ${exitCode}`,
  }
}

// --- argv builders ----------------------------------------------------------

/**
 * `snapshot list [<group>] [--ns <ns>] --output-format json`.
 *
 * With a group it lists that group; without one it lists the whole namespace
 * (GT-2: both forms return the SAME element shape, so ONE parser serves both).
 */
export function buildSnapshotListArgs(group?: string, namespace?: string): string[] {
  const args = ['snapshot', 'list']
  if (group)
    args.push(group)
  if (namespace)
    args.push('--ns', namespace)
  args.push('--output-format', 'json')
  return args
}

/** `list [--ns <ns>] --output-format json` — the GROUP listing (GT-3 shape). */
export function buildGroupListArgs(namespace?: string): string[] {
  const args = ['list']
  if (namespace)
    args.push('--ns', namespace)
  args.push('--output-format', 'json')
  return args
}

// --- Parsers ----------------------------------------------------------------

/** One raw `snapshot list` element (GT-1). Every field is optional defensively. */
interface RawSnapshot {
  'backup-id'?: unknown
  'backup-time'?: unknown
  'backup-type'?: unknown
  'files'?: unknown
  'owner'?: unknown
  'protected'?: unknown
  'size'?: unknown
}

/** One raw `list` element (GT-3: `files` is an array of STRINGS here). */
interface RawGroup {
  'backup-count'?: unknown
  'backup-id'?: unknown
  'backup-type'?: unknown
  'files'?: unknown
  'last-backup'?: unknown
  'owner'?: unknown
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined
}

/**
 * Map ONE `snapshot list` file object onto the shared shape, classifying it by
 * its filename suffix so the picker knows what it may offer (GT-16).
 */
export function toSnapshotFile(raw: unknown): BackupSnapshotFile | null {
  if (!raw || typeof raw !== 'object')
    return null
  const o = raw as Record<string, unknown>
  const filename = asString(o.filename)
  if (!filename)
    return null
  const { kind, archive } = classifyArchiveFile(filename)
  const file: BackupSnapshotFile = { filename, kind }
  if (archive)
    file.archive = archive
  const size = asInt(o.size)
  if (size !== undefined)
    file.size = size
  const cryptMode = asString(o['crypt-mode'])
  if (cryptMode)
    file.cryptMode = cryptMode
  return file
}

/**
 * Parse `snapshot list --output-format json` into the shared shape, composing
 * the id the client does not return (GT-1) and sorting NEWEST FIRST (GT-2 — the
 * client's order is arbitrary; the observed capture came back 412, 408, 410,
 * 405, 414, 416).
 *
 * Returns null when the output is not the expected JSON array — an exit-0 run
 * that produced something else is a fault, not an empty listing.
 */
export function parseSnapshotList(stdout: string): BackupSnapshot[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed))
    return null
  const out: BackupSnapshot[] = []
  for (const item of parsed as RawSnapshot[]) {
    if (!item || typeof item !== 'object')
      continue
    const backupType = asString(item['backup-type'])
    const backupId = asString(item['backup-id'])
    const backupTime = asInt(item['backup-time'])
    if (!backupType || !backupId || backupTime === undefined)
      continue
    const files: BackupSnapshotFile[] = []
    if (Array.isArray(item.files)) {
      for (const f of item.files) {
        const file = toSnapshotFile(f)
        if (file)
          files.push(file)
      }
    }
    const snapshot: BackupSnapshot = {
      snapshot: composeSnapshotId(backupType, backupId, backupTime),
      backupType,
      backupId,
      backupTime,
      backupTimeIso: snapshotTimeIso(backupTime),
      files,
    }
    const size = asInt(item.size)
    if (size !== undefined)
      snapshot.size = size
    const owner = asString(item.owner)
    if (owner)
      snapshot.owner = owner
    if (typeof item.protected === 'boolean')
      snapshot.protected = item.protected
    out.push(snapshot)
  }
  // Newest first. Sorted on an array we own (never `toSorted` — the codebase
  // targets the older idiom).
  out.sort((a, b) => b.backupTime - a.backupTime)
  return out
}

/**
 * Parse `list --output-format json` into the shared group shape. `files` is an
 * array of bare STRINGS here (GT-3), so each is classified by suffix into the
 * same {@link BackupSnapshotFile} shape the snapshot listing uses — with no
 * size, because the group listing does not report one.
 *
 * Sorted newest-last-backup first; a group with no `last-backup` sorts last.
 */
export function parseGroupList(stdout: string): BackupGroup[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed))
    return null
  const out: BackupGroup[] = []
  for (const item of parsed as RawGroup[]) {
    if (!item || typeof item !== 'object')
      continue
    const backupType = asString(item['backup-type'])
    const backupId = asString(item['backup-id'])
    if (!backupType || !backupId)
      continue
    const files: BackupSnapshotFile[] = []
    if (Array.isArray(item.files)) {
      for (const f of item.files) {
        const filename = asString(f)
        if (!filename)
          continue
        const { kind, archive } = classifyArchiveFile(filename)
        const file: BackupSnapshotFile = { filename, kind }
        if (archive)
          file.archive = archive
        files.push(file)
      }
    }
    const group: BackupGroup = {
      group: composeGroupId(backupType, backupId),
      backupType,
      backupId,
      files,
    }
    const count = asInt(item['backup-count'])
    if (count !== undefined)
      group.backupCount = count
    const last = asInt(item['last-backup'])
    if (last !== undefined) {
      group.lastBackup = last
      group.lastBackupIso = snapshotTimeIso(last)
    }
    const owner = asString(item.owner)
    if (owner)
      group.owner = owner
    out.push(group)
  }
  out.sort((a, b) => (b.lastBackup ?? 0) - (a.lastBackup ?? 0))
  return out
}

// --- Runners ----------------------------------------------------------------

/** What every read needs: the repo, its secret (fresh), and the namespace. */
export interface BackupReadDeps {
  repo: BackupRepo
  secret: string
  namespace?: string
}

/** A read that produced data, or a verdict explaining why it did not. */
export type BackupReadOutcome<T>
  = | { ok: true, data: T }
    | { ok: false, verdict: BackupReadVerdict, detail: string }

/**
 * Run one pbc read and hand back stdout, or a classified verdict. Never throws:
 * an exec blow-up becomes an `error` verdict, because a picker must render a
 * message, not a stack trace.
 */
async function runRead(
  executor: CommandExecutor,
  deps: BackupReadDeps,
  args: string[],
): Promise<BackupReadOutcome<string>> {
  try {
    const r = await executor.exec(PBC, args, { env: buildBackupEnv(deps.repo, deps.secret) })
    if (r.exitCode !== 0)
      return { ok: false, ...classifyBackupReadVerdict(r.exitCode, r.stderr) }
    return { ok: true, data: r.stdout }
  }
  catch (err) {
    return { ok: false, verdict: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * List the points in time of ONE group (or of the whole namespace when `group`
 * is omitted). GT-5: a nonexistent group inside a real namespace comes back as
 * `[]` at exit 0 — an empty list, honestly empty, never an error.
 */
export async function listSnapshots(
  executor: CommandExecutor,
  deps: BackupReadDeps,
  group?: string,
): Promise<BackupReadOutcome<BackupSnapshot[]>> {
  const out = await runRead(executor, deps, buildSnapshotListArgs(group, deps.namespace))
  if (!out.ok)
    return out
  const snapshots = parseSnapshotList(out.data)
  if (!snapshots) {
    return {
      ok: false,
      verdict: 'error',
      detail: 'proxmox-backup-client exited 0 but did not return the expected JSON snapshot list',
    }
  }
  return { ok: true, data: snapshots }
}

/** List the GROUPS of a namespace — the task-less entry point. */
export async function listGroups(
  executor: CommandExecutor,
  deps: BackupReadDeps,
): Promise<BackupReadOutcome<BackupGroup[]>> {
  const out = await runRead(executor, deps, buildGroupListArgs(deps.namespace))
  if (!out.ok)
    return out
  const groups = parseGroupList(out.data)
  if (!groups) {
    return {
      ok: false,
      verdict: 'error',
      detail: 'proxmox-backup-client exited 0 but did not return the expected JSON group list',
    }
  }
  return { ok: true, data: groups }
}
