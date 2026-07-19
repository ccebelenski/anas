import { z } from 'zod'
import { AbsolutePath, ISODateTime } from './common.js'

/**
 * PBS file backup (Epic 16) — back up host FILE data (shares, datasets, any
 * mounted path) to a Proxmox Backup Server via `proxmox-backup-client` (pbc).
 * PBS owns the hard parts (chunking, dedup, encryption, retention, verify,
 * restore); ANAS only configures + schedules the client invocation and surfaces
 * LOCAL-ONLY status (systemd + journald + jobs — ANAS NEVER polls the server).
 *
 * The design mirrors replication's two stores:
 *   - REPOSITORIES live in a cluster-wide CAS-versioned registry
 *     (/etc/pve/anas/backup-repos.json, pmxcfs), secrets in per-repo 0600 files
 *     under /etc/anas/creds/ (write-only via API). Fingerprint pinned explicitly.
 *   - TASKS ARE the systemd units (anas-backup-<name>.service/.timer) — no second
 *     config source. Each carries its canonical BackupTask JSON in an
 *     `X-ANAS-Task=` service comment.
 *
 * Env contract (ground truth 16.1 — the control surface pbc already speaks):
 *   PBS_REPOSITORY=user@host:port:datastore (token: user@realm!tokenname@…),
 *   PBS_PASSWORD=account password OR token secret, PBS_FINGERPRINT=sha256 pin,
 *   namespace via --ns, group via --backup-id. Secrets via env ONLY — never argv.
 */

/** A repository / task name — also the systemd unit suffix (anas-backup-<name>). */
export const BackupName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase alphanumerics and dashes')
export type BackupName = z.infer<typeof BackupName>

/**
 * Reserved namespace prefix for a PVE-defined (tier-1) repository: it is exposed
 * as `pve:<storage-id>`. Because a colon is not a legal BackupName character, a
 * registered (tier-2) repo can NEVER occupy this namespace — that IS the
 * collision rule. A registered `foo` and a PVE `pbs: foo` storage coexist
 * unambiguously as `foo` and `pve:foo`.
 */
export const PVE_REPO_PREFIX = 'pve:'

/**
 * A reference to a repository from a task (`task.repository`) or the repos test
 * endpoint — either a registered BackupName (tier 2), or a `pve:<storage-id>`
 * reference to an auto-discovered PVE storage (tier 1). PVE storage ids are
 * broader than a BackupName (they permit dots/underscores/uppercase), so the
 * `pve:` branch is deliberately more permissive than the tier-2 branch.
 */
export const BackupRepoRef = z
  .string()
  .max(105)
  .regex(
    /^(?:pve:[A-Za-z0-9][\w.-]*|[a-z0-9][a-z0-9-]*)$/,
    'a registered repo name, or pve:<storage-id> for a PVE-defined repository',
  )
export type BackupRepoRef = z.infer<typeof BackupRepoRef>

/**
 * Where a repository comes from: `anas` = ANAS-registered in the cluster
 * registry (tier 2, fully editable); `pve` = auto-discovered from a `pbs` stanza
 * in /etc/pve/storage.cfg (tier 1, hands-off — never editable through ANAS, its
 * secret read from /etc/pve/priv/storage/<id>.pw only at exec/test time).
 */
export const BackupRepoSource = z.enum(['anas', 'pve'])
export type BackupRepoSource = z.infer<typeof BackupRepoSource>

/** How a repository authenticates. UI recommends tokens; both are first-class. */
export const BackupAuthType = z.enum(['token', 'password'])
export type BackupAuthType = z.infer<typeof BackupAuthType>

/** pbc change-detection mode: the client default (data/block) or metadata. */
export const ChangeDetectionMode = z.enum(['default', 'metadata'])
export type ChangeDetectionMode = z.infer<typeof ChangeDetectionMode>

// ---- Repositories ----------------------------------------------------------

/**
 * A registered PBS repository — the STORED shape (no secret; the secret lives in
 * a per-repo 0600 creds file, and `credentialsSet` is DERIVED for responses).
 */
export const BackupRepo = z.object({
  /** Registry key; also shows in task pickers. */
  name: BackupName,
  host: z.string().min(1),
  /** PBS default is 8007. */
  port: z.number().int().min(1).max(65535).default(8007),
  datastore: z.string().min(1),
  /** Optional PBS namespace within the datastore. */
  namespace: z.string().optional(),
  authType: BackupAuthType,
  /** Token identity `user@realm!tokenname` (token auth). */
  tokenId: z.string().optional(),
  /** Account username `user@realm` (password auth). */
  username: z.string().optional(),
  /** Pinned PBS certificate fingerprint (sha256, colon-hex), set on confirm. */
  fingerprint: z.string().optional(),
})
export type BackupRepo = z.infer<typeof BackupRepo>

/**
 * The repo shape returned to clients — adds `credentialsSet` (secret presence)
 * and a `source` marker. `name` is widened to a {@link BackupRepoRef} so tier-1
 * PVE repos can be returned as `pve:<storage-id>` (tier-2 names still validate as
 * a plain BackupName). For tier-1, `credentialsSet` reflects whether the PVE
 * `.pw` file exists — the secret itself is NEVER returned.
 */
export const BackupRepoResponse = BackupRepo.extend({
  /** Registry key OR `pve:<storage-id>` for a PVE-defined repository. */
  name: BackupRepoRef,
  /** Whether a secret is stored for this repo (never the secret itself). */
  credentialsSet: z.boolean(),
  /** Tier: `anas` (registered) or `pve` (auto-discovered, hands-off). */
  source: BackupRepoSource.default('anas'),
})
export type BackupRepoResponse = z.infer<typeof BackupRepoResponse>

/**
 * The repo WRITE shape — adds a single write-only `secret` (the token secret OR
 * the account password; the daemon knows which from `authType`). Omitted/blank
 * on edit = keep the stored secret unchanged.
 */
export const BackupRepoWrite = BackupRepo.extend({
  /** Write-only secret: token secret (token auth) or password (password auth). */
  secret: z.string().optional(),
})
export type BackupRepoWrite = z.infer<typeof BackupRepoWrite>

/**
 * The cluster-wide registry file — split-brain guarded like the remotes store:
 * `version` is monotonic and every write is compare-and-swap.
 */
export const BackupRepoRegistry = z.object({
  version: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedAt: ISODateTime,
  repos: z.array(BackupRepo),
})
export type BackupRepoRegistry = z.infer<typeof BackupRepoRegistry>

/** Create/update a repository — carries the registry version the client read. */
export const UpsertBackupRepoRequest = z.object({
  repo: BackupRepoWrite,
  /** CAS guard: the registry version this change was based on. */
  expectedVersion: z.number().int().nonnegative(),
})
export type UpsertBackupRepoRequest = z.infer<typeof UpsertBackupRepoRequest>

/**
 * Test-connection request. Either an inline repo (pre-registration, with the
 * secret from the dialog) OR `{ name }` for a registered repo (the daemon loads
 * the stored secret). Distinguished by the presence of `host`.
 */
export const BackupRepoTestRequest = z.object({
  /**
   * Test a REGISTERED repo by name — a tier-2 BackupName or a tier-1
   * `pve:<storage-id>` (the daemon loads the stored / PVE `.pw` secret).
   */
  name: BackupRepoRef.optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  datastore: z.string().optional(),
  namespace: z.string().optional(),
  authType: BackupAuthType.optional(),
  tokenId: z.string().optional(),
  username: z.string().optional(),
  fingerprint: z.string().optional(),
  secret: z.string().optional(),
})
export type BackupRepoTestRequest = z.infer<typeof BackupRepoTestRequest>

/**
 * Staged diagnosis result — says WHAT failed, not just that it did. The daemon
 * does its OWN dns + tcp + tls-fingerprint probing (pbc collapses dns/tcp/route
 * into one `client error (Connect)`), then falls to a cheap pbc call for
 * auth/datastore/namespace. `fingerprint` is returned on the tls stage for the
 * explicit-confirm flow (no silent TOFU).
 */
export const BackupRepoTestResult = z.object({
  stage: z.enum(['dns', 'tcp', 'tls-fingerprint', 'auth', 'datastore', 'namespace', 'ok']),
  /** Human detail for a failure stage (never contains the secret). */
  detail: z.string().optional(),
  /** The server's certificate fingerprint (returned on the tls stage). */
  fingerprint: z.string().optional(),
})
export type BackupRepoTestResult = z.infer<typeof BackupRepoTestResult>

// ---- Tasks -----------------------------------------------------------------

/**
 * One archive within a task: a named pxar archive of a path, with per-archive
 * exclude patterns (passed to pbc as `--exclude`). The name is the bare archive
 * name (no `.pxar` suffix); paths are absolute.
 */
export const BackupArchive = z.object({
  /** Bare archive name — pbc stores it as `<name>.pxar` (or mpxar/ppxar). */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w.-]+$/, 'letters, digits, dots, underscores and dashes'),
  path: AbsolutePath,
  excludes: z.array(z.string()).default([]),
})
export type BackupArchive = z.infer<typeof BackupArchive>

/**
 * A configured recurring backup (one systemd service+timer pair). This exact
 * shape is embedded as the `X-ANAS-Task=` JSON in the service unit and is the
 * SINGLE source of truth parsed back.
 */
export const BackupTask = z.object({
  name: BackupName,
  /**
   * Target repository: a registered repo name (tier 2) OR `pve:<storage-id>`
   * for a PVE-defined repository (tier 1). See {@link BackupRepoRef}.
   */
  repository: BackupRepoRef,
  /** Optional PBS namespace (overrides / complements the repo's). */
  namespace: z.string().optional(),
  /** PBS group identity host/<backupId>. Defaults to the hostname in the UI. */
  backupId: z.string().min(1),
  /** 1..N archives (the operator's multi-archive shape). */
  archives: z.array(BackupArchive).min(1),
  changeDetectionMode: ChangeDetectionMode.default('default'),
  /** systemd OnCalendar expression. */
  schedule: z.string().min(1),
  enabled: z.boolean().default(true),
  /** LimitNOFILE= on the generated unit (pbc hoards fds in metadata mode). */
  limitNofile: z.number().int().positive().default(1024),
})
export type BackupTask = z.infer<typeof BackupTask>

/**
 * Create/update request. The UI sends `changeDetectionMode` AND a legacy `mode`
 * alias — accept either (prefer changeDetectionMode). `limitNofile` is optional
 * (default 1024). Normalized to a BackupTask before use.
 */
export const BackupTaskRequest = z.preprocess((raw) => {
  if (raw && typeof raw === 'object') {
    const o = { ...(raw as Record<string, unknown>) }
    if (o.changeDetectionMode === undefined && o.mode !== undefined)
      o.changeDetectionMode = o.mode
    return o
  }
  return raw
}, BackupTask)
export type BackupTaskRequest = z.infer<typeof BackupTaskRequest>

/** The task shape returned to clients — enriched with the repo's datastore. */
export const BackupTaskView = BackupTask.extend({
  /** Joined from the repository so the UI need not (never truncated). */
  datastore: z.string().optional(),
})
export type BackupTaskView = z.infer<typeof BackupTaskView>

/** systemd-derived run result (LOCAL-ONLY). */
export const BackupRunResult = z.enum(['success', 'failure', 'running', 'unknown'])
export type BackupRunResult = z.infer<typeof BackupRunResult>

/** A task grid entry: the task + its LOCAL-ONLY runtime status. */
export const BackupTaskEntry = z.object({
  task: BackupTaskView,
  lastRunResult: BackupRunResult,
  lastRunAt: ISODateTime.nullable(),
  nextRunAt: ISODateTime.nullable(),
  /** Enabled task past its schedule without a successful run (counts as failed). */
  overdue: z.boolean(),
})
export type BackupTaskEntry = z.infer<typeof BackupTaskEntry>

/** One recent run parsed from journald (labeled recent-only forensics). */
export const BackupRecentRun = z.object({
  at: ISODateTime.optional(),
  result: z.string(),
  exitCode: z.number().int().optional(),
  output: z.string().optional(),
})
export type BackupRecentRun = z.infer<typeof BackupRecentRun>

/** Task detail: the entry fields + the units as written + recent journald runs. */
export const BackupTaskDetail = z.object({
  task: BackupTaskView,
  lastRunResult: BackupRunResult,
  lastRunAt: ISODateTime.nullable(),
  nextRunAt: ISODateTime.nullable(),
  overdue: z.boolean(),
  /** The .service unit file, verbatim. */
  unit: z.string(),
  /** The .timer unit file, verbatim. */
  timer: z.string(),
  /** Recent runs parsed from journald (may be empty). */
  recentRuns: z.array(BackupRecentRun).optional(),
  /** Raw recent journald output (fallback when structured runs aren't parsed). */
  journal: z.string().optional(),
})
export type BackupTaskDetail = z.infer<typeof BackupTaskDetail>
