import { z } from 'zod'
import { AbsolutePath, DatasetPath, hasControlChars, ISODateTime, NotifyMode, PoolName } from './common.js'
import { IscsiIqn, IscsiLunName } from './iscsi.js'

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

// ---- Cadence (16.10) -------------------------------------------------------
//
// A task's schedule stays a systemd `OnCalendar=` expression — `cadence` is the
// STRUCTURED form the UI edits, and when present the daemon GENERATES the
// expression from it (the cadence is then authoritative; see cadenceToOnCalendar
// and BackupTaskRequest). Absent cadence = a hand-written OnCalendar, which is
// what every task created before 16.10 carries — those keep working verbatim.
//
// ANAS adds run-time logic ONLY where OnCalendar cannot express the schedule:
//   weekly / monthly / custom → pure OnCalendar, NO gate. systemd's
//     `Persistent=true` is the missed-run heal there (it coalesces missed fires
//     into one catch-up, which is the correct behaviour for a backup).
//   biweekly → a WEEKLY timer plus an ISO-week parity gate in the daemon's run
//     path, because OnCalendar has no "every other week" (see backup-cadence.ts).

/**
 * Weekday abbreviations — deliberately systemd's OWN OnCalendar spelling, so a
 * generated expression is a plain join with no translation table in between.
 */
export const BackupWeekday = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
export type BackupWeekday = z.infer<typeof BackupWeekday>

/** ISO-8601 weekday order (Mon..Sun); generated expressions are always sorted. */
export const BACKUP_WEEKDAYS: readonly BackupWeekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * The cadence shapes ANAS can express structurally. `custom` is the raw
 * OnCalendar escape hatch — identical in behaviour to an absent cadence, and the
 * reason no existing task needs migrating.
 */
export const BackupCadenceKind = z.enum(['weekly', 'biweekly', 'monthly', 'custom'])
export type BackupCadenceKind = z.infer<typeof BackupCadenceKind>

/**
 * Which ISO-week parity a biweekly task runs in. EXPLICIT config, never derived
 * from a creation date: real biweekly fleets stagger their jobs across both
 * phases deliberately, and a migration must be able to state the phase it wants.
 */
export const BackupWeekParity = z.enum(['even', 'odd'])
export type BackupWeekParity = z.infer<typeof BackupWeekParity>

/** A 24-hour `HH:MM` fire time (the OnCalendar time component). */
export const BackupTimeOfDay = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour HH:MM time')
export type BackupTimeOfDay = z.infer<typeof BackupTimeOfDay>

/**
 * The structured schedule. Per-kind shape (enforced below, so an impossible
 * cadence cannot be stored):
 *   weekly    — 1..7 days, a time. Fires on each chosen weekday.
 *   biweekly  — exactly ONE day, a time, and an explicit ISO-week `parity`.
 *   monthly   — exactly ONE day, a time. Fires on that weekday's FIRST
 *               occurrence in the month.
 *   custom    — no days/time/parity; the task's raw `schedule` stands.
 */
export const BackupCadence = z
  .object({
    kind: BackupCadenceKind,
    /** Weekdays this cadence fires on (unused for `custom`). */
    days: z.array(BackupWeekday).max(7).default([]),
    /** Fire time, `HH:MM` (unused for `custom`). */
    time: BackupTimeOfDay.optional(),
    /** biweekly ONLY: which ISO-week parity actually runs. */
    parity: BackupWeekParity.optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [path] })
    }
    if (c.kind === 'custom') {
      if (c.days.length)
        issue('a custom cadence carries no weekdays — the raw schedule stands', 'days')
      return
    }
    if (!c.time)
      issue('a time (HH:MM) is required', 'time')
    if (c.kind === 'weekly' && c.days.length < 1)
      issue('choose at least one weekday', 'days')
    if (c.kind !== 'weekly' && c.days.length !== 1)
      issue(`a ${c.kind} cadence runs on exactly one weekday`, 'days')
    if (c.kind === 'biweekly' && !c.parity)
      issue('a biweekly cadence needs an explicit even/odd ISO-week parity', 'parity')
    if (c.kind !== 'biweekly' && c.parity)
      issue('week parity applies to a biweekly cadence only', 'parity')
  })
  // Normalise the weekdays on the way IN — deduped and in ISO order — so the
  // stored cadence and the expression generated from it can never disagree, and
  // two spellings of the same schedule are the same config.
  .transform(c => ({ ...c, days: BACKUP_WEEKDAYS.filter(d => c.days.includes(d)) }))
export type BackupCadence = z.infer<typeof BackupCadence>

/**
 * Translate a cadence into the systemd `OnCalendar=` expression that drives its
 * timer. Returns null for `custom` (the task's raw schedule is the expression).
 *
 * The generated forms — all validated against `systemd-analyze calendar`, and
 * re-validated by the daemon on every write:
 *   weekly    `Tue,Thu 02:00`          → Tue,Thu *-*-* 02:00:00
 *   biweekly  `Tue 02:00`              → Tue *-*-* 02:00:00 (the parity gate
 *                                        skips the off weeks — the timer cannot)
 *   monthly   `Sun *-*-01..07 02:00`   → the first Sun of each month (a 7-day
 *                                        window holds exactly one of each weekday)
 * Days are emitted deduped and in ISO order, so the same cadence always renders
 * the same string (a rewrite never churns the unit file).
 */
export function cadenceToOnCalendar(cadence: BackupCadence): string | null {
  if (cadence.kind === 'custom' || !cadence.time)
    return null
  const days = BACKUP_WEEKDAYS.filter(d => cadence.days.includes(d))
  if (!days.length)
    return null
  if (cadence.kind === 'monthly')
    return `${days[0]} *-*-01..07 ${cadence.time}`
  return `${days.join(',')} ${cadence.time}`
}

/**
 * Exit status the task runner uses for a deliberate no-op skip (today: a
 * biweekly off-week fire). The generated unit declares it as
 * `SuccessExitStatus=`, so systemd records the run as a SUCCESS (a skip is not a
 * failure) while `ExecMainStatus` still says plainly that nothing was backed up
 * — one `systemctl show` tells the whole story, with no journal read and no
 * second state source. 75 is EX_TEMPFAIL; pbc itself only ever exits 0 or 255.
 */
export const BACKUP_SKIP_EXIT_CODE = 75

/**
 * The run-result `status` a gated (off-week) fire reports. It travels daemon job
 * → runner stdout → journald → the Run-Now supervisor, which is why the three of
 * them share this one spelling rather than three string literals.
 */
export const BACKUP_SKIPPED_OFF_WEEK = 'skipped-off-week'

// ---- Retention (story 16.11) -----------------------------------------------

/**
 * OPTIONAL per-task retention — PBS's own `--keep-*` flags, verbatim (the CLI is
 * the API; we neither invent a policy language nor re-implement bucketing —
 * `proxmox-backup-client prune` owns that).
 *
 * ABSENT (or every field unset) means ANAS **never invokes prune** — today's
 * behavior, PBS-side retention (server prune jobs) stays the default posture. A
 * prune with no keep flags is a keep-all no-op on the server (ground truth
 * `prune-no-keep-flags.txt`); we do not even run it. Keeps are POSITIVE ints —
 * `0`/negative are rejected rather than silently meaning "keep none".
 */
export const BackupRetention = z.object({
  keepLast: z.number().int().positive().optional(),
  keepDaily: z.number().int().positive().optional(),
  keepWeekly: z.number().int().positive().optional(),
  keepMonthly: z.number().int().positive().optional(),
  keepYearly: z.number().int().positive().optional(),
})
export type BackupRetention = z.infer<typeof BackupRetention>

/**
 * Does a retention policy actually ask for anything? The ONE place that question
 * is answered (daemon runner, routes, and the task-request normalizer all call
 * it): an absent policy — or one whose every keep is unset — never prunes.
 */
export function hasRetentionKeeps(retention: BackupRetention | undefined | null): boolean {
  if (!retention)
    return false
  return (['keepLast', 'keepDaily', 'keepWeekly', 'keepMonthly', 'keepYearly'] as const)
    .some(k => typeof retention[k] === 'number')
}

/**
 * One snapshot as `prune --output-format json` reports it (ground truth
 * `prune-output-format-json.txt`): PBS's kebab-case keys mapped to the domain
 * shape. Dry-run and real prune emit the SAME array; `keep:false` means the
 * snapshot is (or would be) removed. `protected` snapshots are always kept.
 */
export const BackupPruneSnapshot = z.object({
  backupId: z.string(),
  backupType: z.string(),
  /** PBS `backup-time` — unix seconds. */
  backupTime: z.number().int(),
  keep: z.boolean(),
  /** The namespace PBS echoed back (absent at the datastore root). */
  namespace: z.string().optional(),
  protected: z.boolean(),
})
export type BackupPruneSnapshot = z.infer<typeof BackupPruneSnapshot>

/** A prune (or dry-run preview) that RAN: the parsed list plus its counts. */
export const BackupPruneResult = z.object({
  /** The PBS group pruned, e.g. `host/pictures`. */
  group: z.string(),
  namespace: z.string().optional(),
  /** True for the preview endpoint (`--dry-run`); false for a real prune. */
  dryRun: z.boolean(),
  kept: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Protected snapshots — PBS keeps them regardless of the policy. */
  protectedCount: z.number().int().nonnegative(),
  snapshots: z.array(BackupPruneSnapshot),
})
export type BackupPruneResult = z.infer<typeof BackupPruneResult>

/**
 * Why a prune did not run. Ground truth (16.11): a missing GROUP and a missing
 * NAMESPACE are INDISTINGUISHABLE (both `Error: ENOENT: No such file or
 * directory`, exit 255) — `not-found` says so honestly rather than guessing.
 */
export const BackupPruneVerdict = z.enum(['ok', 'not-found', 'permission', 'error'])
export type BackupPruneVerdict = z.infer<typeof BackupPruneVerdict>

/**
 * Dry-run preview request for the wizard's Preview button. Every field is an
 * override so an UNSAVED task can be previewed (the repos-test precedent: an
 * inline shape, or the stored task's own values when omitted). Non-mutating.
 */
export const BackupPrunePreviewRequest = z.object({
  repository: BackupRepoRef.optional(),
  namespace: z.string().optional(),
  backupId: z.string().min(1).optional(),
  retention: BackupRetention.optional(),
})
export type BackupPrunePreviewRequest = z.infer<typeof BackupPrunePreviewRequest>

/** Preview response: the verdict, plus the keep/remove list when it ran. */
export const BackupPrunePreviewResponse = z.object({
  verdict: BackupPruneVerdict,
  /** Human detail for a non-ok verdict (never contains the secret). */
  detail: z.string().optional(),
  result: BackupPruneResult.optional(),
})
export type BackupPrunePreviewResponse = z.infer<typeof BackupPrunePreviewResponse>

// ---- Notifications (story 16.12) -------------------------------------------

/**
 * When a finished backup run emits a PVE notification. This IS the shared
 * {@link NotifyMode} (9.4 extended the same two modes to snapshot schedules and
 * replication, so the enum moved to common.ts and every family reads it from
 * there); the name is kept as an alias because 16.12's callers and tests import
 * it, and because it is the natural word at a backup call site.
 *
 * Backup's DEFAULT is `always` — vzdump parity: the cron jobs this epic replaced
 * mailed every run's full output, and the operator wants the detailed
 * on-completion mail, not just the failure one. That is a BACKUP ruling, not a
 * global one: snapshot schedules and replication deliberately default to
 * `on-failure` (see NotifyMode).
 *
 * A deliberate off-week skip ({@link BACKUP_SKIPPED_OFF_WEEK}) NEVER notifies in
 * either mode: the cadence gate produced no run, and the cron jobs it replaces
 * produced no mail either — a non-event is a non-event.
 */
export const BackupNotifyMode = NotifyMode
export type BackupNotifyMode = NotifyMode

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
 *
 * The secret is write-only everywhere in this API, so an ABSENT `secret` on an
 * inline body means "the one already stored", not "no credential": when `name`
 * names a registered (or PVE-defined) repo, the daemon falls back to that repo's
 * stored secret and tests the request's own host/datastore/token fields with it.
 * That is what makes Test truthful for an edit-in-progress — it exercises the
 * config that would actually be SAVED, with the credential that would survive
 * the save.
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

// ---- Nested filesystems (story backup2.2) ----------------------------------
//
// pbc walks ONE filesystem: every directory under the source whose `st_dev`
// differs from the source root's is stored as an EMPTY DIRECTORY and the client
// prints a single `skipping mount point: "<archive-relative path>"` line on
// stderr (ground truth GT-54). That is the silent omission this story ends.
//
// Detection is an `st_dev` walk, NOT a `findmnt` enumeration: a btrfs nested
// subvolume — and even the empty placeholder a read-only btrfs snapshot leaves
// behind — carries its own `st_dev` but has NO mount table entry (GT-52/53), and
// `st_dev` is exactly what the client keys on. `findmnt` then NAMES what the
// walk found. See services/nested-filesystems.ts in the daemon.

/**
 * What a nested filesystem IS, once named. `dataset` = a ZFS child dataset,
 * `subvolume` = a btrfs subvolume (or the empty placeholder a ro snapshot left),
 * `nfs`/`cifs` = a remote mount (never descended into — the hang trap),
 * `pmxcfs` = PVE's `/etc/pve` fuse mount, `automount` = an armed autofs
 * placeholder (armed, never "local" — the mounts-family rule, issue #35),
 * `local` = another local filesystem, `unknown` = a distinct `st_dev` with no
 * mount line and no subvolume identity.
 */
/** Trailing slashes on an absolute path (stripped before a prefix compare). */
const TRAILING_SLASHES_RE = /\/+$/

export const BackupNestedKind = z.enum([
  'dataset',
  'subvolume',
  'nfs',
  'cifs',
  'local',
  'pmxcfs',
  'automount',
  'unknown',
])
export type BackupNestedKind = z.infer<typeof BackupNestedKind>

/**
 * Which nested filesystems under an archive's source get backed up:
 *   `none`      — the client's own default: nothing. Each nested filesystem is
 *                 stored as an empty directory (and warned about).
 *   `all`       — every filesystem under this archive's source. It is RESOLVED
 *                 at run time into one `--include-dev <path>` per boundary the
 *                 daemon's descending `st_dev` scan finds, so the choice applies
 *                 to THIS archive only. **`--all-file-systems` is never used**:
 *                 it is a per-INVOCATION flag and ANAS puts every archive of a
 *                 task in one `backup` call, so it would silently apply one
 *                 archive's choice to all the others.
 *   `[paths]`   — one `--include-dev <path>` per entry. ABSOLUTE paths (that is
 *                 what `--include-dev` takes, and what the detector reports);
 *                 each must lie under its archive's own `path`.
 *
 * ABSENT means `none` — see {@link effectiveIncludeNested}. The field is
 * OPTIONAL rather than `.default()`ed on purpose: an untouched edit of a task
 * written before this story must rewrite the unit BYTE-IDENTICALLY (the
 * dialog ↔ daemon contract), so a value nobody chose is never written. An
 * explicit `none` normalizes back to absent in {@link BackupTaskRequest} —
 * "no nested filesystems" has exactly one spelling on disk.
 */
export const BackupIncludeNested = z.union([
  z.literal('none'),
  z.literal('all'),
  z.array(AbsolutePath).min(1).max(256),
])
export type BackupIncludeNested = z.infer<typeof BackupIncludeNested>

/**
 * The ONE place "absent means none" is expressed. Every caller — the runner's
 * argv, the run-time warning pass, the task detail's coverage flags and the
 * wizard preview — reads the effective choice from here, so an absent field can
 * never mean two different things in two places.
 */
export function effectiveIncludeNested(
  archive: { includeNested?: BackupIncludeNested | null } | null | undefined,
): BackupIncludeNested {
  const chosen = archive?.includeNested
  if (chosen === 'all')
    return 'all'
  if (Array.isArray(chosen) && chosen.length)
    return chosen
  return 'none'
}

/**
 * Does an `includeNested` choice COVER a given nested filesystem path? `all`
 * covers everything the scan found; a path list covers an exact match
 * (that is what `--include-dev <path>` means — it names the device by one path
 * on it), and a path list entry also covers anything BELOW it that sits on the
 * same device. Note a device the client was NOT told about still stops it, which
 * is why `all` is resolved from a scan that descends through the boundaries it
 * is including rather than from the first layer alone.
 */
export function nestedIncluded(choice: BackupIncludeNested, path: string): boolean {
  if (choice === 'all')
    return true
  if (choice === 'none')
    return false
  return choice.some(p => p === path || path.startsWith(`${p.replace(TRAILING_SLASHES_RE, '')}/`))
}

/** Is `child` the same path as, or below, `parent`? (both absolute, normalized) */
export function isPathWithin(parent: string, child: string): boolean {
  if (child === parent)
    return true
  const base = parent === '/' ? '' : parent.replace(TRAILING_SLASHES_RE, '')
  return child.startsWith(`${base}/`)
}

// ---- Archive kind (story backup2.4) ----------------------------------------
//
// pbc takes an archive spec of the form `<name>.<type>:<source>`, and the type
// decides what the client does with the source:
//
//   `pxar` — a FILE ARCHIVE of a directory tree (Epic 16's only kind). Walks
//            one filesystem, honours `--exclude`, `--include-dev` and
//            `--change-detection-mode`.
//   `img`  — a fixed-chunk BLOCK IMAGE of a device or a regular file. 4 MiB
//            chunks, no catalog, no FUSE mount, and:
//              * a REGULAR FILE is a first-class source — no loop device is
//                needed at all (GT-34);
//              * `--change-detection-mode` is a COMPLETE NO-OP (GT-37) and
//                every run reads the whole image, even when it uploads 0 B
//                (GT-36);
//              * `--exclude` / `--include-dev` mean nothing on a block device,
//                which is why both are REFUSED on an `img` archive below
//                rather than silently ignored.

export const BackupArchiveKind = z.enum(['pxar', 'img'])
export type BackupArchiveKind = z.infer<typeof BackupArchiveKind>

/**
 * The ONE place "absent means pxar" is expressed — the {@link BackupArchive}
 * `kind` field is OPTIONAL rather than `.default()`ed so a task written before
 * this story rewrites its unit BYTE-IDENTICALLY on an untouched edit (the
 * dialog ↔ daemon contract). Every reader — the runner's argv, the consistency
 * derivation, the wizard, the notification body — asks here.
 */
export function effectiveArchiveKind(
  archive?: { kind?: BackupArchiveKind | null } | null,
): BackupArchiveKind {
  return archive?.kind === 'img' ? 'img' : 'pxar'
}

/** The pbc archive-spec type token for a kind: `pxar` or `img`. */
export function archiveSpecType(kind: BackupArchiveKind): string {
  return kind === 'img' ? 'img' : 'pxar'
}

// ---- Task kind (story backup2.9) -------------------------------------------
//
// A backup task is FILES (directory trees) or BLOCK (one iSCSI LUN as a whole
// image) — not a bag of archives with a mixed agenda. The field is OPTIONAL on
// the task, by the same ruling as the archive's `kind` (backup2.4): a unit
// written before this story stores nothing, and its kind is DERIVED from the
// archives — which is what keeps every existing unit byte-identical on an
// untouched edit, and makes an old UI + new daemon (or the reverse) a
// derivation, not a failure.

export const BackupTaskKind = z.enum(['files', 'block'])
export type BackupTaskKind = z.infer<typeof BackupTaskKind>

/** The one answer to "what IS this task" — the stored value or the derived shape. */
export interface EffectiveTaskKind {
  kind: BackupTaskKind
  /**
   * The legacy shape this story formalises: the task reads as `files` yet
   * still carries image archive(s) — written before block tasks existed, when
   * an `img` archive rode in a task alongside its files. The UI notes it and
   * points at one block task per LUN; the stored data is untouched.
   */
  legacyImgArchives: boolean
}

/**
 * The ONE place "what kind of task is this" is expressed — the read model, the
 * wizard, the grid and the LUN door all ask here rather than re-deriving.
 *
 *   - stored `block` / `files` is the answer (the wizard writes it the moment
 *     an operator chooses, so stored and derived can never diverge silently);
 *   - absent ⇒ derived: EXACTLY ONE archive, and it is an image, is a block
 *     task — the shape backup2.4 let the wizard build by hand;
 *   - everything else is a files task; a DERIVED files task that still carries
 *     image archive(s) is the legacy shape (`legacyImgArchives`), and the UI's
 *     note says what to do about it (one block task per LUN).
 */
export function effectiveTaskKind(
  task?: {
    kind?: BackupTaskKind | null
    archives?: ReadonlyArray<{ kind?: BackupArchiveKind | null } | null> | null
  } | null,
): EffectiveTaskKind {
  const archives = (task?.archives ?? []).filter((a): a is { kind?: BackupArchiveKind | null } => !!a)
  const imgCount = archives.filter(a => effectiveArchiveKind(a) === 'img').length
  if (task?.kind === 'block' || task?.kind === 'files')
    return { kind: task.kind, legacyImgArchives: false }
  if (archives.length === 1 && imgCount === 1)
    return { kind: 'block', legacyImgArchives: false }
  return { kind: 'files', legacyImgArchives: imgCount > 0 }
}

/**
 * The FIXED archive name of a block task (backup2.9): the whole image IS the
 * archive, and the name says exactly that — `disk`. It never varies, because
 * the archive name is pbc's change-detection KEY: a name that could drift would
 * be a re-read waiting to happen on a multi-terabyte LUN.
 */
export const BLOCK_ARCHIVE_NAME = 'disk'

/**
 * A block task's backup-id: `lun-<SCSI unit serial>` (backup2.9). The PBS
 * GROUP is the LUN's durable identity — the human LUN name is display-only and
 * can change, but the serial (a VPD fact) survives a rename, a re-point and a
 * re-install, so the LUN's backups stay one group across all of them. The
 * wizard derives the id from the pick; the daemon verifies it against the
 * read layer's own serial and refuses a mismatch (a guiding 400).
 */
export function lunBackupId(serial: string): string {
  return `lun-${serial}`
}

/**
 * WHICH iSCSI LUN an `img` archive's source was picked as. It is a RECORD, not
 * an address: the archive's `path` is still the one and only source pbc is
 * pointed at, and a LUN that is later deleted or re-pointed does not change what
 * gets backed up. It exists so the UI can show "this is LUN 0 of <target>" and
 * so backup2.7's restore knows which LUN to disable before writing an image back
 * (a LUN whose backing this archive is).
 */
export const BackupLunRef = z.object({
  /** The target's IQN — never truncated, never a display name. */
  targetIqn: z.string().min(1).max(223),
  /** The LUN number within the target's TPG. */
  index: z.number().int().nonnegative(),
})
export type BackupLunRef = z.infer<typeof BackupLunRef>

// ---- Snapshot consistency (story backup2.3) --------------------------------
//
// A multi-hour backup of a live tree captures no single instant: files written
// while pbc walks land in the archive in whatever state they were in when it
// reached them. Where the filesystem can give us a point-in-time view we take
// one, back up from it, and destroy it; where it cannot, the backup is LIVE and
// says so. The choice is DERIVED from the source's capability, never configured
// — there is no override field in this cut, so nothing can claim a consistency
// the filesystem does not provide.
//
// GROUND TRUTH (`docs/BACKUP-RESTORE-GROUND-TRUTH.md`):
//   - GT-51: `.zfs/snapshot/<s>/` is reachable with the default
//     `snapdir=hidden`. No property is ever changed for this.
//   - GT-47/48/49/50: metadata-mode (and default-mode) change detection is
//     INDIFFERENT to the root switching between the live path and the snapshot
//     path — inodes are identical, `st_dev` is not part of the reference, and
//     the first snapshot-mode run reuses 100%. There is no re-read.
//   - GT-52/55: a btrfs read-only snapshot leaves every nested subvolume as an
//     EMPTY PLACEHOLDER and `--all-file-systems` cannot rescue it. AHR therefore
//     snapshots each nested subvolume and expands to one archive root per
//     subvolume — a correctness requirement, not an optimisation.

/**
 * How faithfully a run captured a source. `snapshot` = backed up from a
 * point-in-time snapshot the run took and then destroyed; `live` = backed up
 * from the running filesystem, which is what every Epic 16 backup was.
 */
export const BackupConsistency = z.enum(['snapshot', 'live'])
export type BackupConsistency = z.infer<typeof BackupConsistency>

/** Which filesystem provides the snapshot for a `snapshot`-consistent source. */
export const BackupSnapshotBackend = z.enum(['zfs', 'ahr'])
export type BackupSnapshotBackend = z.infer<typeof BackupSnapshotBackend>

/**
 * The DERIVED consistency of one archive source, with the reason spelled out.
 * Read-only and additive: the wizard renders it as a chip, the task detail
 * repeats it, and nothing in any request body carries it — a source's capability
 * is a fact about the system, not a setting.
 *
 * backup2.4 adds ONE optional field, {@link BackupArchiveConsistency.zvolDevice}
 * — an `img` archive whose source is a zvol has no mountpoint and no tree, so
 * its snapshot is reached as a DEVICE NODE rather than a `.zfs/snapshot` path.
 */
export const BackupArchiveConsistency = z.object({
  /** `snapshot` when the source sits on a snapshottable filesystem, else `live`. */
  consistency: BackupConsistency,
  /** One plain sentence saying WHY — shown verbatim in the chip's tooltip. */
  reason: z.string(),
  /** Which backend will take the snapshot (absent for `live`). */
  backend: BackupSnapshotBackend.optional(),
  /** ZFS: the dataset that gets the recursive snapshot. AHR: the pool name. */
  target: z.string().optional(),
  /** Where that dataset / pool is mounted (the snapshot path derives from it). */
  mountpoint: AbsolutePath.optional(),
  /**
   * The source path relative to `mountpoint` — `''` when the source IS the
   * mountpoint, `photos/raw` when it is a plain subdirectory of the dataset.
   * This is what makes `<mountpoint>/.zfs/snapshot/<s>/<relativePath>` the
   * archive root for a subdirectory source.
   */
  relativePath: z.string().optional(),
  /**
   * backup2.4 — the source is a ZVOL BLOCK DEVICE (`/dev/zvol/<pool>/<vol>`),
   * not a tree. A zvol has no mountpoint and no `.zfs/snapshot` directory, so
   * the run reaches its snapshot as the DEVICE NODE `<zvolDevice>@<snapshot>`,
   * published by `zfs set snapdev=visible` for the duration of the run and
   * restored with `zfs inherit snapdev` afterwards (GT-44/GT-46). Present ONLY
   * for a zvol source; `mountpoint` and `relativePath` are absent then.
   */
  zvolDevice: AbsolutePath.optional(),
})
export type BackupArchiveConsistency = z.infer<typeof BackupArchiveConsistency>

/**
 * One transient snapshot a run took, on the record. Destroyed in the run's
 * `finally`; reported so the operator can see what existed while the run was in
 * flight (and so a leaked one is nameable if a node died mid-run).
 */
export const BackupTransientSnapshot = z.object({
  backend: BackupSnapshotBackend,
  /** The label `anas-backup-<taskname>-<unix-seconds>` (+ a subvolume suffix on AHR). */
  name: z.string(),
  /** The dataset (ZFS) or pool (AHR) it was taken on. */
  target: z.string(),
  /** ZFS: `<dataset>@<name>`. AHR: `<pool>:@snapshots/<name>`. Never truncated. */
  full: z.string(),
  /** ZFS: taken with `-r`, so every child dataset carries the same label. */
  recursive: z.boolean().optional(),
})
export type BackupTransientSnapshot = z.infer<typeof BackupTransientSnapshot>

/**
 * One archive root a snapshot-consistent run actually handed pbc. The
 * configured archive expands into one of these per nested filesystem the scan
 * reports as INCLUDED, plus the root itself.
 *
 * The ROOT entry's `name` is the configured archive name UNCHANGED — that,
 * together with an unchanged `--backup-id`, is what preserves change-detection
 * continuity across the live→snapshot switch (GT-47/48). Only children get a
 * derived suffix.
 */
export const BackupExpandedArchive = z.object({
  /** The PBS archive name (`<name>` for the root, `<name>__<child>` for a child). */
  name: z.string(),
  /** The configured archive this one was expanded FROM. */
  from: z.string(),
  /** The absolute path pbc was pointed at. */
  root: z.string(),
  /** `''` for the root archive; the nested filesystem's archive-relative path otherwise. */
  relativePath: z.string(),
  /** The excludes rebased onto THIS root. */
  excludes: z.array(z.string()).default([]),
  /**
   * backup2.4 — which pbc archive TYPE this root becomes (`<name>.pxar:<root>`
   * or `<name>.img:<root>`). Absent = `pxar`, so every pre-backup2.4 result
   * reads exactly as it did. An `img` archive never expands: a block device has
   * no nested filesystems, so it is always exactly one root.
   */
  kind: BackupArchiveKind.optional(),
})
export type BackupExpandedArchive = z.infer<typeof BackupExpandedArchive>

/**
 * PBS archive names are restricted to `[A-Za-z0-9_-]`. A configured
 * {@link BackupArchive} name is already narrower than that except for `.`, and a
 * derived child name adds path separators — so every DERIVED name goes through
 * here. The configured ROOT name never does: it must stay byte-identical for
 * change-detection continuity.
 */
const ARCHIVE_NAME_ILLEGAL_RE = /[^\w-]/g
/** Path separators in a derived suffix become `_`. */
const PATH_SEPARATOR_RE = /\//g
/** The characters an archive name can never carry (a derived name keeps dots). */
const DERIVED_ARCHIVE_NAME_ILLEGAL_RE = /[^\w.-]/g

/**
 * The deterministic child-archive name for a nested filesystem at
 * `relativePath` under archive `name`: `<name>__<path with / → _>`, sanitised to
 * PBS's charset. Deterministic on purpose — the same task always produces the
 * same archive names, so the previous run's change-detection reference still
 * matches. Collisions (two distinct paths sanitising to one name) are resolved
 * by the caller, which knows the whole set.
 */
export function expandedArchiveName(name: string, relativePath: string): string {
  const suffix = relativePath.replace(TRAILING_SLASHES_RE, '').replace(PATH_SEPARATOR_RE, '_')
  return `${name}__${suffix}`.replace(ARCHIVE_NAME_ILLEGAL_RE, '_')
}

/**
 * The archive name a files row gets when it is CREATED (backup2.9): the source
 * path's LAST SEGMENT, sanitised to the archive-name charset. The wizard shows
 * it, not an empty box to fill — and it is read-only, because the archive name
 * is pbc's change-detection KEY: a name that could later be re-derived (a path
 * rename changing the last segment) would silently turn the next run into a
 * full re-read of the whole tree. It is derived ONCE, at row creation, against
 * the names the task already carries (`taken`, auto-suffixed `-2`, `-3`, … on a
 * collision); a STORED name is never re-derived, on any edit.
 */
export function deriveArchiveName(path: string, taken: readonly string[] = []): string {
  const segments = path.replace(TRAILING_SLASHES_RE, '').split('/').filter(Boolean)
  // The same "replace what the charset cannot say" convention as
  // `expandedArchiveName` — but the archive charset keeps dots, so only true
  // illegal characters become `_`.
  let base = (segments.at(-1) ?? '').replace(DERIVED_ARCHIVE_NAME_ILLEGAL_RE, '_')
  if (!base)
    base = 'root' // the path was `/` — take the filesystem's own name
  let name = base
  let n = 2
  while (taken.includes(name))
    name = `${base}-${n++}`
  return name.length > 128 ? name.slice(0, 128) : name
}

/**
 * One nested filesystem the detector found under a source, named as well as the
 * system allows. `included` answers the only question the screen asks: does the
 * archive's CURRENT `includeNested` cover it, or will it be backed up as an
 * empty directory?
 */
export const BackupNestedEntry = z.object({
  /** Absolute path of the nested filesystem's root directory. */
  path: AbsolutePath,
  /** The same path relative to the archive source (what pbc's skip line quotes). */
  relativePath: z.string(),
  kind: BackupNestedKind,
  /** findmnt SOURCE when it is a real mount (dataset name, `//host/share`, …). */
  source: z.string().optional(),
  /** findmnt FSTYPE when it is a real mount. */
  fstype: z.string().optional(),
  /** Extra honesty (e.g. a btrfs ro-snapshot placeholder, a remote not descended). */
  detail: z.string().optional(),
  /** Does the archive's current includeNested choice cover this one? */
  included: z.boolean(),
})
export type BackupNestedEntry = z.infer<typeof BackupNestedEntry>

/** The detector's answer for ONE archive source. */
export const BackupNestedScan = z.object({
  /** The archive name this scan belongs to (absent for a bare-path preview). */
  archive: z.string().optional(),
  /** The source path scanned. */
  path: z.string(),
  /** False when the path does not exist (or could not be read at all). */
  exists: z.boolean(),
  /** The effective choice the `included` flags were computed against. */
  includeNested: BackupIncludeNested,
  nested: z.array(BackupNestedEntry),
  /**
   * True when the walk hit its depth budget or its timeout — the list is then a
   * FLOOR, not a complete answer, and the UI says so rather than implying none.
   */
  truncated: z.boolean(),
  /** Non-fatal problems (unreadable directory, walk timeout). Never secrets. */
  warnings: z.array(z.string()).default([]),
  /**
   * The DERIVED snapshot-consistency of this source (backup2.3) — READ-ONLY and
   * additive. It rides the boundary scan rather than a second endpoint because
   * the two answers come from the SAME facts: the mount table this scan already
   * read, plus the AHR pool topology. Absent when the derivation could not run
   * (an old daemon, or a scan that failed before it got there) — which the UI
   * renders as "not known", never as "live".
   */
  consistency: BackupArchiveConsistency.optional(),
})
export type BackupNestedScan = z.infer<typeof BackupNestedScan>

/**
 * Preview request for the wizard — the save-time verify pattern (the namespace
 * check, `prune-preview`) reapplied: user-initiated, one-shot, NON-mutating and
 * with NO PBS contact at all (this one never leaves the node). Either a bare
 * `path` (one archive row's Choose… picker) or the whole `archives` list.
 */
export const BackupNestedPreviewRequest = z.object({
  path: AbsolutePath.optional(),
  includeNested: BackupIncludeNested.optional(),
  /**
   * backup2.4 — an `img` source is a block device or an image FILE, so there is
   * no tree to walk: the daemon skips the boundary scan for it and answers with
   * the derived consistency alone. Absent = `pxar`.
   */
  kind: BackupArchiveKind.optional(),
  archives: z
    .array(z.object({
      name: z.string().optional(),
      path: AbsolutePath,
      includeNested: BackupIncludeNested.optional(),
      kind: BackupArchiveKind.optional(),
    }))
    .max(64)
    .optional(),
})
export type BackupNestedPreviewRequest = z.infer<typeof BackupNestedPreviewRequest>

/** Preview response: one scan per requested source, in request order. */
export const BackupNestedPreviewResponse = z.object({
  archives: z.array(BackupNestedScan),
})
export type BackupNestedPreviewResponse = z.infer<typeof BackupNestedPreviewResponse>

// ---- LUN sources (story backup2.4) -----------------------------------------
//
// `GET /v1/backup/lun-sources` — the wizard's picker for an `img` archive.
// READ-ONLY, LOCAL-ONLY (the iSCSI read layer plus the same mount table the
// consistency derivation already needs; no PBS contact, no `targetcli`), and a
// CONVENIENCE: a free-typed device or file path stays first-class, exactly as
// the directory picker never replaced typing a path.
//
// The list is deliberately narrower than `GET /v1/iscsi/targets`:
//   - a LUN whose backing ANAS cannot resolve onto storage it knows (`foreign`,
//     and — once `iscsi.5` lands — `unresolved`) is not offered: ANAS cannot say
//     what backs it, so it cannot say what backing it up would capture;
//   - a PVE-owned volume (a guest disk, or a zvol on a PVE-managed pool) is
//     never offered at all — PVE territory is read-only and hands-off, and PVE
//     backs its own guests up.

/** The backing kind of an offerable LUN — `foreign` is filtered out upstream. */
export const BackupLunSourceKind = z.enum(['zvol', 'file'])
export type BackupLunSourceKind = z.infer<typeof BackupLunSourceKind>

/** One backup-eligible LUN, with everything the picker shows. */
export const BackupLunSource = z.object({
  /** The serving target's IQN — never truncated. */
  targetIqn: z.string(),
  /** The LUN number within the target's TPG. */
  index: z.number().int().nonnegative(),
  /** The backstore name — which IS the SCSI model string initiators see. */
  name: z.string(),
  kind: BackupLunSourceKind,
  /** The stable backing path — `/dev/zvol/<pool>/<vol>` or the image file. */
  path: AbsolutePath,
  /** SCSI unit serial; null when it could not be read. */
  serial: z.string().nullable(),
  /** Size in bytes; null when it could not be determined. */
  size: z.number().int().nonnegative().nullable(),
  /**
   * Does the backing path resolve on this node right now? `false` is a real
   * answer and a real problem — a `zfs rename` under a live LUN succeeds
   * silently and leaves the backstore pointing at nothing (GT-40) — so the row
   * is still LISTED and says so, rather than vanishing from the picker with no
   * explanation. `null` means the check itself could not answer.
   */
  backingExists: z.boolean().nullable(),
  /**
   * The DERIVED consistency of backing THIS path up, from the same derivation
   * the wizard's preview uses — so the picker can say `snapshot` or `live`
   * BEFORE a path is chosen. Absent when the derivation could not run.
   */
  consistency: BackupArchiveConsistency.optional(),
})
export type BackupLunSource = z.infer<typeof BackupLunSource>

/**
 * `GET /v1/backup/lun-sources`. `installed: false` (no LIO stack on this node)
 * is a first-class 200 with an empty list, never an error — most nodes serve no
 * block storage and the wizard must keep working there.
 */
export const BackupLunSourceList = z.object({
  installed: z.boolean(),
  /** One sentence when `installed` is false; absent otherwise. */
  reason: z.string().optional(),
  luns: z.array(BackupLunSource),
})
export type BackupLunSourceList = z.infer<typeof BackupLunSourceList>

// ---- Tasks -----------------------------------------------------------------

/**
 * One archive within a task: a named archive of a path, with per-archive
 * exclude patterns (passed to pbc as `--exclude`). The name is the bare archive
 * name (no `.pxar` / `.img` suffix); paths are absolute.
 *
 * `kind` (backup2.4) decides what the path MEANS: a `pxar` archive's path is a
 * directory tree, an `img` archive's path is a block device or a regular image
 * file. Absent = `pxar`, which is what every pre-backup2.4 archive is.
 */
export const BackupArchive = z
  .object({
    /** Bare archive name — pbc stores it as `<name>.pxar` (mpxar/ppxar) or `<name>.img`. */
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/, 'letters, digits, dots, underscores and dashes'),
    path: AbsolutePath,
    excludes: z.array(z.string()).default([]),
    /**
     * Nested filesystems under `path` (backup2.2). ABSENT = `none` (the client's
     * own behaviour, and PVE's lead) — read it through
     * {@link effectiveIncludeNested}, never by truthiness.
     */
    includeNested: BackupIncludeNested.optional(),
    /**
     * `pxar` (a tree) or `img` (a block device / raw image file) — backup2.4.
     * ABSENT = `pxar`; read it through {@link effectiveArchiveKind}.
     */
    kind: BackupArchiveKind.optional(),
    /**
     * OPTIONAL record that this `img` source was picked as an iSCSI LUN
     * (backup2.4). Display + restore truth; the `path` is still the source.
     */
    lun: BackupLunRef.optional(),
  })
  .superRefine((a, ctx) => {
    const kind = effectiveArchiveKind(a)
    if (kind === 'img') {
      // A block image has no directory entries to exclude and no filesystem
      // boundaries to cross. pbc would IGNORE both flags on an `.img` archive
      // (and `--exclude` is per-invocation, so a pattern stored here would
      // silently reach every SIBLING pxar archive of the same task) — so they
      // are refused, loudly, rather than accepted and dropped.
      if (a.excludes.length) {
        ctx.addIssue({
          code: 'custom',
          message: `archive '${a.name}' is a block image: exclude patterns do not apply to an image and would be applied to the other archives of this task instead`,
          path: ['excludes'],
        })
      }
      if (effectiveIncludeNested(a) !== 'none') {
        ctx.addIssue({
          code: 'custom',
          message: `archive '${a.name}' is a block image: it has no nested filesystems, so 'include nested filesystems' does not apply`,
          path: ['includeNested'],
        })
      }
    }
    else if (a.lun) {
      ctx.addIssue({
        code: 'custom',
        message: `archive '${a.name}' records an iSCSI LUN but is a file archive - a LUN is a block image (kind 'img')`,
        path: ['lun'],
      })
    }
    if (!Array.isArray(a.includeNested))
      return
    for (const p of a.includeNested) {
      // An --include-dev outside the archive's own source is meaningless: pbc
      // only crosses boundaries it meets while walking THIS root.
      if (!isPathWithin(a.path, p)) {
        ctx.addIssue({
          code: 'custom',
          message: `nested filesystem '${p}' is not under the archive path '${a.path}'`,
          path: ['includeNested'],
        })
      }
    }
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
  /**
   * FILES or BLOCK (backup2.9) — the task's kind, chosen FIRST. OPTIONAL by the
   * same ruling as the archive's `kind`: a unit written before this story
   * stores nothing and {@link effectiveTaskKind} derives the answer (exactly
   * one image archive is a block task), so no existing unit is rewritten until
   * it is edited. The wizard stores `block` on a block task and stores NOTHING
   * on a files task — absent IS the files default, and a value nobody chose is
   * never written.
   */
  kind: BackupTaskKind.optional(),
  changeDetectionMode: ChangeDetectionMode.default('default'),
  /**
   * OPTIONAL retention (16.11): after a SUCCESSFUL run the job prunes the task's
   * group with exactly these `--keep-*` flags. Absent = ANAS never prunes.
   */
  retention: BackupRetention.optional(),
  /**
   * When a finished run notifies through PVE (16.12). ABSENT = `always` — the
   * schema default, which is also vzdump's, so every task written before 16.12
   * reads back as an always-notifying task with no migration at all.
   */
  notify: BackupNotifyMode.default('always'),
  /**
   * systemd OnCalendar expression. GENERATED from `cadence` when one is present
   * (the cadence is authoritative); hand-written otherwise.
   */
  schedule: z.string().min(1),
  /**
   * The structured schedule (16.10). Absent = the raw `schedule` above is the
   * whole story — which is exactly what every pre-16.10 task carries.
   */
  cadence: BackupCadence.optional(),
  enabled: z.boolean().default(true),
  /** LimitNOFILE= on the generated unit (pbc hoards fds in metadata mode). */
  limitNofile: z.number().int().positive().default(1024),
})
export type BackupTask = z.infer<typeof BackupTask>

/**
 * Create/update request. The UI sends `changeDetectionMode` AND a legacy `mode`
 * alias — accept either (prefer changeDetectionMode). `limitNofile` is optional
 * (default 1024). Normalized to a BackupTask before use.
 *
 * When a structured `cadence` is present, the OnCalendar expression is DERIVED
 * here from it and overwrites whatever `schedule` the client sent: the cadence is
 * authoritative, the generator lives in exactly one place, and the UI therefore
 * never has to reimplement systemd calendar syntax. A `custom` cadence (or none)
 * leaves the client's raw `schedule` untouched.
 *
 * A retention object with NO keeps set is dropped entirely, so a wizard whose
 * five fields are all blank stores no policy at all (absent = never prune)
 * rather than an empty `{}` riding the unit JSON forever.
 *
 * The same rule applies to `includeNested` (backup2.2): `none`, `null` and an
 * empty list all mean "the client's default", which is what an ABSENT field
 * already means — so they normalize to absent and an untouched edit of a
 * pre-backup2.2 task rewrites its unit byte-for-byte.
 */
export const BackupTaskRequest = z.preprocess((raw) => {
  if (raw && typeof raw === 'object') {
    const o = { ...(raw as Record<string, unknown>) }
    if (o.changeDetectionMode === undefined && o.mode !== undefined)
      o.changeDetectionMode = o.mode
    // backup2.9 — `null` kind is a clear (absent = derived), exactly as the
    // archive's `kind` normalises; `files` is KEPT — unlike `pxar`, it is not
    // redundant with absent: a stored `files` on a mixed task is what makes it
    // NOT the legacy shape.
    if (o.kind === null || o.kind === undefined)
      delete o.kind
    if (Array.isArray(o.archives)) {
      o.archives = o.archives.map((a) => {
        if (!a || typeof a !== 'object')
          return a
        const arch = { ...(a as Record<string, unknown>) }
        const chosen = arch.includeNested
        if (chosen === 'none' || chosen === null || chosen === undefined
          || (Array.isArray(chosen) && chosen.length === 0)) {
          delete arch.includeNested
        }
        // backup2.4 — the same rule for `kind`: `pxar` and `null` both mean what
        // an ABSENT field already means, so they normalize to absent and a
        // pre-backup2.4 archive rewrites byte-for-byte. `lun` is a record about
        // an IMAGE source: on a file archive it is meaningless, and a null one
        // is a clear.
        if (arch.kind === 'pxar' || arch.kind === null || arch.kind === undefined)
          delete arch.kind
        if (arch.lun === null || arch.lun === undefined || arch.kind !== 'img')
          delete arch.lun
        return arch
      })
    }
    if (o.cadence !== undefined) {
      // Parse defensively: an invalid cadence falls through to full validation
      // below, which reports the real problem rather than a schedule error.
      const cadence = BackupCadence.safeParse(o.cadence)
      const generated = cadence.success ? cadenceToOnCalendar(cadence.data) : null
      if (generated)
        o.schedule = generated
    }
    if (o.retention !== undefined) {
      const parsed = BackupRetention.safeParse(o.retention)
      if (parsed.success && !hasRetentionKeeps(parsed.data))
        delete o.retention
    }
    return o
  }
  return raw
}, BackupTask.superRefine((task, ctx) => {
  // backup2.9 — a BLOCK task is one LUN, spelled out at the TASK level. The
  // per-archive refusions already fired above (excludes and includeNested are
  // refused on an `img` archive); this is the shape the task itself must have.
  if (task.kind !== 'block')
    return
  if (task.archives.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['archives'],
      message: `a block task backs up EXACTLY one LUN — one image archive per task (${task.archives.length} archives were sent; create one block task per LUN)`,
    })
    return
  }
  const archive = task.archives[0]
  if (effectiveArchiveKind(archive) !== 'img') {
    ctx.addIssue({
      code: 'custom',
      path: ['archives', 0, 'kind'],
      message: `a block task's one archive must be a block image (kind 'img') — it names a LUN, not a directory`,
    })
    return
  }
  if (archive.name !== BLOCK_ARCHIVE_NAME) {
    ctx.addIssue({
      code: 'custom',
      path: ['archives', 0, 'name'],
      message: `a block task's archive is named '${BLOCK_ARCHIVE_NAME}' — the whole image is the archive, and the name is the change-detection key`,
    })
  }
  if (!archive.lun) {
    ctx.addIssue({
      code: 'custom',
      path: ['archives', 0, 'lun'],
      message: `a block task's archive must record the iSCSI LUN it backs up (target + LUN number)`,
    })
  }
  if (task.changeDetectionMode !== 'default') {
    ctx.addIssue({
      code: 'custom',
      path: ['changeDetectionMode'],
      message: `the change-detection mode does not apply to a block image (every run reads the whole image) — a block task cannot set it`,
    })
  }
}))
export type BackupTaskRequest = z.infer<typeof BackupTaskRequest>

/**
 * The task shape returned to clients — enriched with the repo's datastore and,
 * since backup2.9, the legacy-shape flag. The `kind` key stays the STORED value
 * (absent on a unit written before this story) — exactly the archive's `kind`
 * ruling, and exactly what the edit dialog needs: a STORED `block` is sent back
 * on save, a derived one is not, which is what keeps a pre-backup2.9 task's
 * hand-chosen id and PBS group (the daemon's serial guard fires only on a task
 * that claims to be block). The EFFECTIVE answer the grid and the LUN door ask
 * for is a DERIVATION the client performs through {@link effectiveTaskKind} —
 * the same helper the daemon reads it with, so both sides cannot disagree.
 */
export const BackupTaskView = BackupTask.extend({
  /** Joined from the repository so the UI need not (never truncated). */
  datastore: z.string().optional(),
  /**
   * backup2.9 — the legacy shape: a derived `files` that still carries image
   * archive(s) (written before block tasks existed). The wizard's note points
   * at one block task per LUN; the stored data is untouched.
   */
  legacyImgArchives: z.boolean().optional(),
})
export type BackupTaskView = z.infer<typeof BackupTaskView>

/**
 * Run-Now request body. `direct: true` is the INTERNAL path the task's own
 * systemd unit takes (via the backup-task helper the timer / `systemctl start`
 * fires): it executes pbc in the daemon — that IS the unit's work. A normal UI
 * Run-Now omits it (or sends false): the daemon starts the task's systemd unit
 * and SUPERVISES it, so a manual run lands in systemd's last-result and the unit
 * journal exactly like a scheduled run — one code path, one history. A `direct`
 * run NEVER starts systemctl (that is the recursion guard). The body may also be
 * empty (`{}`) — equivalent to a non-direct run.
 */
export const BackupRunRequest = z.object({
  direct: z.boolean().optional(),
})
export type BackupRunRequest = z.infer<typeof BackupRunRequest>

/**
 * systemd-derived run result (LOCAL-ONLY). `skipped` is a run that deliberately
 * did nothing and says so — today a biweekly off-week fire, recognised by the
 * runner's {@link BACKUP_SKIP_EXIT_CODE}. It is neither a fake success (no
 * backup was taken) nor a failure (nothing went wrong).
 *
 * `disabled` is the ABSENCE of a result, not an outcome: systemd unloads an
 * inactive unit nothing references, and a disabled task has no timer to
 * reference its service — so the run history is garbage-collected and
 * `systemctl show` answers from defaults (`Result=success`, empty timestamps).
 * Reporting that as a success is a fabricated outcome. The member is ADDITIVE:
 * the field stays required and every previously valid value still parses
 * (live-proof F9).
 *
 * `never-run` is the ENABLED twin: an enabled unit IS referenced by its timer,
 * so systemd keeps it loaded and its empty timestamps can only mean it has
 * never fired — yet the same default-valued `Result=success` still reads as a
 * successful run that never happened. Also ADDITIVE (version skew: an older
 * daemon that predates it never sends the value).
 */
export const BackupRunResult
  = z.enum(['success', 'failure', 'running', 'skipped', 'unknown', 'disabled', 'never-run'])
export type BackupRunResult = z.infer<typeof BackupRunResult>

/** A task grid entry: the task + its LOCAL-ONLY runtime status. */
export const BackupTaskEntry = z.object({
  task: BackupTaskView,
  lastRunResult: BackupRunResult,
  lastRunAt: ISODateTime.nullable(),
  nextRunAt: ISODateTime.nullable(),
  /** Enabled task past its schedule without a successful run (counts as failed). */
  overdue: z.boolean(),
  /**
   * backup2.9 — for a BLOCK task: the LUN's human NAME, resolved LIVE from the
   * iSCSI read layer. The stored task carries only the `{ targetIqn, index }`
   * record and the serial-derived backup-id; the name is display-only and can
   * change, so it is never stored — read where it lives. `null` = the LUN no
   * longer resolves right now (fail-open: the list must never die on the read
   * layer). Absent for files tasks and on older daemons.
   */
  lunName: z.string().nullable().optional(),
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
  /**
   * One line explaining a status the systemd store cannot answer — today only
   * the disabled-task case (`lastRunResult: 'disabled'`), where the unit's run
   * history has been garbage-collected. Absent when there is nothing to explain.
   */
  statusNote: z.string().optional(),
  /**
   * Nested filesystems under each archive source RIGHT NOW, and whether the
   * task's current `includeNested` covers each (backup2.2). Local-only: an
   * `st_dev` walk plus `findmnt`, no PBS contact. Absent when the scan could
   * not be run at all — a missing key is "not known", never "none found".
   */
  nested: z.array(BackupNestedScan).optional(),
  /**
   * The NOTICES of the task's last run (backup2 fix-ups): nested filesystems
   * the task's `includeNested` does not cover, stored as empty directories.
   * Informational — they never changed that run's status — but the run's
   * completion toast points the operator to THIS window for them, so they ride
   * the detail. Run jobs are in-process state: absent after a daemon restart,
   * or when the last run had none (a missing key is "not known", like `nested`).
   */
  lastRunNotices: z.array(z.string()).optional(),
})
export type BackupTaskDetail = z.infer<typeof BackupTaskDetail>

// ---- Restore reads: snapshots, groups, archive browse (story backup2.5) -----
//
// The three USER-INITIATED read contacts phase 2 adds to the sanctioned list
// (EPICS "Backup via PBS"): listing a group's points in time, listing a
// repository's groups (the task-less entry point), and browsing ONE directory
// level of an archive. Never polled, never background — a person clicked
// something. Ground truth: docs/BACKUP-RESTORE-GROUND-TRUTH.md §1 (GT-1..GT-8)
// plus the backup2.5 capture in fixtures/backup/catalog-shell-browse.txt.

/**
 * How a PBS-stored file behaves for restore, derived from its filename suffix
 * (GT-16: the archive argument must carry its type suffix).
 *
 *   `pxar`  — a file archive: `<n>.pxar.didx`, `<n>.mpxar.didx`, `<n>.ppxar.didx`.
 *             All three are browsable with `catalog shell` (real capture).
 *   `img`   — a fixed-chunk block image: `<n>.img.fidx`. NOT browsable
 *             (`Error: Can only mount pxar archives.`, exit 255) and restored
 *             whole, by nature.
 *   `other` — the snapshot's bookkeeping: `catalog.pcat1.didx`,
 *             `index.json.blob`. Never a restore target the picker offers.
 */
export const BackupSnapshotFileKind = z.enum(['pxar', 'img', 'other'])
export type BackupSnapshotFileKind = z.infer<typeof BackupSnapshotFileKind>

/**
 * The suffixes pbc strips to get from a STORED filename to the ARCHIVE NAME it
 * accepts as an argument (`data.pxar.didx` → `data.pxar`).
 */
const INDEX_SUFFIXES = ['.didx', '.fidx', '.blob'] as const
/** Archive extensions that `catalog shell` will browse (all three proven). */
const PXAR_EXTENSIONS = ['.pxar', '.mpxar', '.ppxar'] as const

/**
 * Classify ONE `snapshot list` file entry by its filename.
 *
 * Returns the kind and, for a real archive, the `archive` argument to pass to
 * `catalog shell` / `restore` — the stored name minus its index suffix. A
 * bookkeeping file (`index.json.blob`, `catalog.pcat1.didx`) is `other` and
 * carries no archive name, so nothing can offer it as a restore source.
 */
export function classifyArchiveFile(
  filename: string,
): { kind: BackupSnapshotFileKind, archive?: string } {
  let base = filename
  for (const suffix of INDEX_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length)
      break
    }
  }
  if (base.endsWith('.img'))
    return { kind: 'img', archive: base }
  for (const ext of PXAR_EXTENSIONS) {
    if (base.endsWith(ext))
      return { kind: 'pxar', archive: base }
  }
  return { kind: 'other' }
}

/** Is this archive kind something the archive picker can browse into? */
export function isBrowsableArchive(kind: BackupSnapshotFileKind): boolean {
  return kind === 'pxar'
}

/**
 * The composed snapshot id `<backup-type>/<backup-id>/<RFC3339 backup-time>`.
 *
 * GT-1: `snapshot list --output-format json` does NOT return this — the client
 * hands back the three parts separately and the CALLER composes the id. GT-57:
 * a group path with no timestamp silently restores the LATEST snapshot, so
 * every call ANAS makes carries the full three-part id.
 */
export function composeSnapshotId(
  backupType: string,
  backupId: string,
  backupTimeUnixSeconds: number,
): string {
  return `${backupType}/${backupId}/${snapshotTimeIso(backupTimeUnixSeconds)}`
}

/** The `.mmmZ` tail `toISOString()` adds; PBS renders whole seconds. */
const ISO_MILLIS_RE = /\.\d{3}Z$/

/**
 * PBS's own rendering of a `backup-time`: UTC RFC3339, second resolution, `Z`
 * zone (`2026-08-25T19:16:45Z`) — verified by round-tripping a composed id back
 * through `snapshot files` against a real server.
 */
export function snapshotTimeIso(backupTimeUnixSeconds: number): string {
  return new Date(backupTimeUnixSeconds * 1000).toISOString().replace(ISO_MILLIS_RE, 'Z')
}

/** The group path `<backup-type>/<backup-id>` (the `snapshot list` argument). */
export function composeGroupId(backupType: string, backupId: string): string {
  return `${backupType}/${backupId}`
}

/**
 * One file of a snapshot, as `snapshot list` reports it (GT-3: OBJECTS here,
 * bare STRINGS in the group `list` — two shapes for the same word).
 */
export const BackupSnapshotFile = z.object({
  /** The stored name, verbatim (`data.pxar.didx`). Never truncated. */
  filename: z.string(),
  /**
   * The argument `catalog shell` / `restore` take (`data.pxar`) — absent for a
   * bookkeeping file, which is never a restore source.
   */
  archive: z.string().optional(),
  /** Derived from the suffix — what this file IS for restore purposes. */
  kind: BackupSnapshotFileKind,
  /**
   * GT-4: the LOGICAL archive size, and the restore space estimate — no
   * download needed. An `.img` reports the full device size.
   */
  size: z.number().int().nonnegative().optional(),
  /** `crypt-mode` verbatim (`none`, `sign-only`, `encrypt`). */
  cryptMode: z.string().optional(),
})
export type BackupSnapshotFile = z.infer<typeof BackupSnapshotFile>

/** One point in time in a backup group. */
export const BackupSnapshot = z.object({
  /** The composed `<type>/<id>/<RFC3339>` id ANAS builds (GT-1). */
  snapshot: z.string(),
  backupType: z.string(),
  backupId: z.string(),
  /** `backup-time` verbatim — UNIX SECONDS (same unit as prune). */
  backupTime: z.number().int(),
  /** The RFC3339 rendering used inside `snapshot` — the picker's label. */
  backupTimeIso: ISODateTime,
  files: z.array(BackupSnapshotFile),
  /** The snapshot's total stored size, when the server reported one. */
  size: z.number().int().nonnegative().optional(),
  /** The owning auth-id (a group has ONE owner; a different auth-id is refused). */
  owner: z.string().optional(),
  /** PBS's protected flag — a protected snapshot is never pruned. */
  protected: z.boolean().optional(),
})
export type BackupSnapshot = z.infer<typeof BackupSnapshot>

/**
 * The outcome of one user-initiated PBS read. `ok` carries data; every other
 * value carries a `detail` the UI shows verbatim. Modelled on the prune verdict
 * (16.11) and the repo Test (16.6): DIAGNOSE, never a bare failure.
 *
 * GT-56 forces the honesty of `not-found`: a missing snapshot, a missing group
 * and a missing namespace produce the SAME string, so the message names all
 * three rather than guessing which one is wrong.
 */
export const BackupReadVerdict = z.enum([
  'ok',
  'not-found',
  'permission',
  'unreachable',
  'error',
])
export type BackupReadVerdict = z.infer<typeof BackupReadVerdict>

/** Points in time for one group (`GET /v1/backup/tasks/:name/snapshots`). */
export const BackupSnapshotList = z.object({
  verdict: BackupReadVerdict,
  /** Present for every non-ok verdict — the client-safe explanation. */
  detail: z.string().optional(),
  /** The repository reference the listing ran against. */
  repository: z.string(),
  /** The effective namespace (absent = the datastore root). */
  namespace: z.string().optional(),
  /** The group path `<type>/<id>` that was listed. */
  group: z.string(),
  /** NEWEST FIRST — GT-2: the client's array is NOT sorted, the picker must be. */
  snapshots: z.array(BackupSnapshot),
})
export type BackupSnapshotList = z.infer<typeof BackupSnapshotList>

/** One backup group as the group `list` reports it (GT-3: `files` are STRINGS). */
export const BackupGroup = z.object({
  /** The composed group path `<type>/<id>`. */
  group: z.string(),
  backupType: z.string(),
  backupId: z.string(),
  /** How many snapshots the group holds. */
  backupCount: z.number().int().nonnegative().optional(),
  /** `last-backup` verbatim — UNIX SECONDS. */
  lastBackup: z.number().int().optional(),
  /** RFC3339 rendering of `lastBackup` (absent when the server sent none). */
  lastBackupIso: ISODateTime.optional(),
  owner: z.string().optional(),
  /** The stored filenames, classified — which archives this group holds. */
  files: z.array(BackupSnapshotFile),
})
export type BackupGroup = z.infer<typeof BackupGroup>

/**
 * `GET /v1/backup/repos/:name/groups?ns=[&group=]` — the TASK-LESS entry point
 * for archives whose task was renamed or deleted.
 *
 * Without `group` it lists the namespace's groups. With `group` it returns THAT
 * group's snapshots in exactly the {@link BackupSnapshot} shape the task
 * endpoint uses — one picker, one parser, two doors.
 */
export const BackupGroupList = z.object({
  verdict: BackupReadVerdict,
  detail: z.string().optional(),
  repository: z.string(),
  namespace: z.string().optional(),
  /** Newest-last-backup first. Empty when a single group was requested. */
  groups: z.array(BackupGroup),
  /** Echoed when `?group=` was passed. */
  group: z.string().optional(),
  /** Present (newest first) only for the `?group=` form. */
  snapshots: z.array(BackupSnapshot).optional(),
})
export type BackupGroupList = z.infer<typeof BackupGroupList>

// ---- Archive browse (`catalog shell` over a pipe) --------------------------

/**
 * A path INSIDE a pxar archive. Absolute (the archive root is `/`), no `..`,
 * and — load-bearing — no control characters: the browse driver feeds paths to
 * `catalog shell` as lines on stdin, so a newline in a path would be a second
 * command. pxar itself permits a newline in a filename; such an entry cannot be
 * represented by the shell's line-based `ls` either, so it is refused here
 * rather than silently mis-parsed downstream.
 */
export const ArchivePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(p => p.startsWith('/'), 'must be an absolute archive path (the archive root is /)')
  .refine(p => !p.split('/').includes('..'), 'must not contain ".."')
  .refine(p => !hasControlChars(p), 'must not contain control characters')
export type ArchivePath = z.infer<typeof ArchivePath>

/**
 * What one entry in an archive directory IS.
 *
 * `hardlink` is its own type on purpose (the catalog's `h` entries): `stat`
 * renders a hardlink as a symlink pointing at the group's PRIMARY name, with
 * the give-away mode `(0/L---------)`. GT-25: picking a hardlink's second name
 * ALONE fails the whole restore, so a hardlink and its target are ONE selection
 * unit, never two.
 *
 * `image` is the single pseudo-entry an `.img` archive yields — browsing a
 * block image is meaningless, so the browse short-circuits and says so instead
 * of asking pbc a question it answers with an error.
 */
export const BackupBrowseEntryType = z.enum([
  'dir',
  'file',
  'symlink',
  'hardlink',
  'image',
  'other',
])
export type BackupBrowseEntryType = z.infer<typeof BackupBrowseEntryType>

/** One entry of one directory level inside an archive. */
export const BackupBrowseEntry = z.object({
  /** The bare entry name as `ls` printed it. Never truncated, never escaped. */
  name: z.string(),
  /** The full archive path `<dir>/<name>` — what a selection carries. */
  path: z.string(),
  type: BackupBrowseEntryType,
  /** Size in bytes when `stat` reported one (0 for dirs and links). */
  size: z.number().int().nonnegative().optional(),
  /**
   * The modification time EXACTLY as pbc rendered it (`2026-08-25 19:16:23`).
   * Deliberately not converted: the client prints it with NO timezone, so any
   * ISO conversion here would be an invented offset.
   */
  modified: z.string().optional(),
  /**
   * What timezone {@link modified} is in, when it is known. `catalog shell`
   * renders `Modify:` in the READING PROCESS's local timezone with no marker —
   * the same entry reads `15:06:53` under `Etc/UTC` and `11:06:53` under
   * `America/New_York` (live-proof F11 / GT amendment 20). The reading process
   * is the daemon, so the answer is always the NODE's local time; the marker
   * exists so the UI can LABEL it instead of guessing UTC. Additive and
   * optional: absent means "not stated", never "UTC".
   */
  mtimeZone: z.literal('node-local').optional(),
  /** Octal permission bits as pbc printed them (`644`, `755`). Display only. */
  mode: z.string().optional(),
  /**
   * For a symlink, its target verbatim. For a HARDLINK, the group's primary
   * name — the path that must be restored together with this one.
   */
  target: z.string().optional(),
})
export type BackupBrowseEntry = z.infer<typeof BackupBrowseEntry>

/**
 * `POST /v1/backup/restore/browse` — ONE directory level of one archive.
 *
 * Deliberately a POST of a compound key, not a GET: repo + namespace +
 * snapshot + archive + path do not belong in a query string. It is still a
 * READ (200, never a job) — nothing on the node or the server changes.
 */
export const BackupBrowseRequest = z.object({
  /** Repository reference (a registered name or `pve:<storage-id>`). */
  repo: BackupRepoRef,
  /** Namespace; absent = the repo's own, else the datastore root. */
  ns: z.string().optional(),
  /** The FULL `<type>/<id>/<RFC3339>` id — never a bare group path (GT-57). */
  snapshot: z.string().min(1),
  /** The archive argument WITH its type suffix (`data.pxar`) — GT-16. */
  archive: z.string().min(1),
  /** The directory to list; defaults to the archive root. */
  path: ArchivePath.default('/'),
})
export type BackupBrowseRequest = z.infer<typeof BackupBrowseRequest>

/** One directory level of an archive, or the verdict explaining why not. */
export const BackupBrowseResult = z.object({
  verdict: BackupReadVerdict,
  detail: z.string().optional(),
  repository: z.string(),
  namespace: z.string().optional(),
  snapshot: z.string(),
  archive: z.string(),
  /** What kind of archive this is — an `img` is a single whole-image unit. */
  archiveKind: BackupSnapshotFileKind,
  /** The directory that was listed (normalized). */
  path: z.string(),
  /** Directories first, then everything else; each group name-sorted. */
  entries: z.array(BackupBrowseEntry),
  /** True when the level was capped — silent truncation is banned. */
  truncated: z.boolean().optional(),
  /** Non-fatal problems (an entry that could not be stat'ed). Never secrets. */
  warnings: z.array(z.string()).default([]),
})
export type BackupBrowseResult = z.infer<typeof BackupBrowseResult>

// ---- Restore: the WHOLE-IMAGE branch (story backup2.7) ---------------------
//
// Restore is two types BY NATURE — files are SELECTIVE, block images are WHOLE
// — and this block is the whole half. The READ side (groups, points in time,
// archive browse) is backup2.5's above: ONE picker, one parser, two doors, and
// this block adds only what it takes to write an image BACK.
//
// GROUND TRUTH that shapes these types (`docs/BACKUP-RESTORE-GROUND-TRUTH.md`):
//   - GT-39: `restore` REFUSES every existing target — a regular file, the
//     `/dev/zvol/<pool>/<vol>` symlink and the resolved `/dev/zdNN` alike — and
//     `--overwrite` does not help. So the target is NEVER an argv path: the
//     archive is streamed to stdout (`-`) and ANAS opens the device/file itself.
//   - GT-42: a size mismatch is UNGUARDED AND DESTRUCTIVE below ANAS. A larger
//     image writes until `No space left on device` and leaves the target
//     half-overwritten; a smaller one succeeds and leaves stale tail bytes. The
//     equality pre-check is therefore ANAS's own, and it is a REFUSAL rather
//     than a warning.
//   - GT-57: a bare group path silently restores the LATEST snapshot, so
//     `snapshot` here is always a FULL `<type>/<id>/<RFC3339 time>`.
//   - GT-59: progress arrives on STDERR, CR-terminated, at a roughly DOUBLING
//     interval — silence is not a stall.

/**
 * The `.img` suffix a whole-image archive name must carry. pbc rejects an
 * unknown suffix outright (`failed to parse archive type for 'data.zzz'`,
 * GT-56), so validating it here turns a 255 into a 400 with a sentence.
 */
export const IMG_ARCHIVE_SUFFIX = '.img'

/** An archive name as pbc takes it on the restore command line. */
export const BackupArchiveName = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w.-]+$/, 'letters, digits, dots, underscores and dashes')
export type BackupArchiveName = z.infer<typeof BackupArchiveName>

/**
 * A FULL snapshot path: `<type>/<id>/<RFC3339 time>`.
 *
 * The three-segment shape is enforced rather than assumed because a two-segment
 * group path is NOT an error to pbc — it silently restores the latest snapshot
 * (GT-57). "Restore the newest one" is a different operation from the one the
 * operator picked in a dialog, and it must never happen by omission.
 */
export const BackupSnapshotPath = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-z]+\/[\w.:-]+\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'a full <type>/<id>/<RFC3339 time> path — a bare group silently restores the latest snapshot',
  )
export type BackupSnapshotPath = z.infer<typeof BackupSnapshotPath>

// ---- Restore: the SELECTIVE FILE branch (story backup2.6) ------------------
//
// The other half of the pair above: files are SELECTIVE, block images are
// WHOLE. Both branches share the discriminated `BackupRestoreRequest`, the
// snapshot path (`BackupSnapshotPath`, whose three-segment shape is enforced
// for the same GT-57 reason) and the read side backup2.5 built — and share
// nothing else, because there is nothing else in common between writing a tree
// of files and writing a block device.
//
// Ground truth: `docs/BACKUP-RESTORE-GROUND-TRUTH.md` §2 (flags), §3 (patterns)
// and §9 (failures / progress / interruption).

/**
 * Where a file restore lands — the two destinations every established backup
 * tool offers: the original location, or a location the operator chooses
 * (operator ruling 2026-08-29: a "beside the original under a fixed name" mode
 * was dropped entirely — none of the tools operators already know has it, so
 * ANAS does not either).
 *
 *   `inPlace`     — INTO the original: the live home itself, with
 *                   `--allow-existing-dirs --overwrite` (GT-11: the minimal
 *                   pair — `--overwrite` alone dies on the first existing
 *                   DIRECTORY). It is a MERGE, never a sync (GT-12): files
 *                   not in the archive SURVIVE.
 *   `newLocation` — SOMEWHERE ELSE: a directory of the operator's choosing
 *                   (`target.path`), REQUIRED. When it does NOT exist the
 *                   restore creates it with no overwrite flags (GT-15). When
 *                   it EXISTS the daemon confirm-gates it (409 +
 *                   X-Anas-Confirm-Code, Principle 14) and, on confirm, runs
 *                   with the SAME merge flags as `inPlace`: files with the
 *                   same names are replaced, everything else is kept. An
 *                   existing path that is not a directory is refused (400).
 */
export const BackupRestoreTargetMode = z.enum(['inPlace', 'newLocation'])
export type BackupRestoreTargetMode = z.infer<typeof BackupRestoreTargetMode>

/** Trailing slashes on a path (the root survives as `/`). */
const RESTORE_TRAILING_SLASHES_RE = /\/+$/
/** Leading slashes on an archive-relative path. */
const RESTORE_LEADING_SLASHES_RE = /^\/+/
/** The whole-second UTC RFC3339 form PBS renders a `backup-time` as. */
const SNAPSHOT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/**
 * The three-part snapshot id `<type>/<id>/<RFC3339>`, split.
 *
 * Returns null when the id does not carry all three parts — which is the whole
 * point of the check: GT-57 measured a BARE GROUP path (`host/gtrestore`)
 * restoring the LATEST snapshot at exit 0. That is not an error, it is a
 * DIFFERENT restore, so ANAS refuses the truncated form at the schema rather
 * than discovering afterwards that it restored a point in time nobody picked.
 */
export function parseSnapshotId(
  snapshot: string,
): { backupType: string, backupId: string, time: string } | null {
  const parts = snapshot.split('/')
  if (parts.length !== 3)
    return null
  const [backupType, backupId, time] = parts
  if (!backupType || !backupId || !time)
    return null
  if (!SNAPSHOT_TIME_RE.test(time))
    return null
  return { backupType, backupId, time }
}

/** True when `snapshot` carries a full timestamp (not a bare group path). */
export function snapshotIdHasTimestamp(snapshot: string): boolean {
  return parseSnapshotId(snapshot) !== null
}

/** The group path `<type>/<id>` of a composed snapshot id, or null. */
export function groupOfSnapshotId(snapshot: string): string | null {
  const parsed = parseSnapshotId(snapshot)
  return parsed ? composeGroupId(parsed.backupType, parsed.backupId) : null
}

/**
 * The characters `--pattern` treats as glob syntax, escaped with a backslash.
 *
 * GT-22 is the rule and `[` is the trap, not `*`: `bracket[1].txt` unescaped is
 * a CHARACTER CLASS, so the pattern means `bracket1.txt` and restores NOTHING
 * at exit 0. A backslash escape was verified against the real archive for `*`,
 * `[` and `]`. A SPACE needs nothing — the pattern is one argv element, never a
 * shell word. The backslash itself is in the class so it is escaped in the same
 * single pass (no double-escaping).
 */
const PATTERN_ESCAPE_RE = /[\\*?[\]]/g

/**
 * The `--pattern` argument for ONE archive-relative selection.
 *
 * `/`-ANCHORED: GT-18 proved an unanchored pattern is a PATH SUFFIX match at
 * any depth — a bare `alpha.txt` restored three files at three depths. A
 * selection is one exact entry, so it is anchored, always.
 *
 * Returns null for the archive ROOT: `--pattern /` is rejected by pbc's own
 * parameter schema (`value does not match the regex pattern`, exit 255), and it
 * would mean "everything" anyway — which is a restore with NO pattern at all.
 */
export function restorePatternFor(archivePath: string): string | null {
  const rel = archivePath
    .replace(RESTORE_TRAILING_SLASHES_RE, '')
    .replace(RESTORE_LEADING_SLASHES_RE, '')
  if (!rel)
    return null
  return `/${rel.replace(PATTERN_ESCAPE_RE, m => `\\${m}`)}`
}

/**
 * The `--pattern` list for a whole selection, in selection order and
 * deduplicated (GT-23: the flag may be repeated).
 *
 * An EMPTY list is not "restore nothing" — it is "restore everything", because
 * a selection that named the archive root cannot be expressed as a pattern and
 * a pattern-less restore is exactly what it means. Callers must not read an
 * empty result as a no-op.
 */
export function restorePatternsFor(selections: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const selection of selections) {
    const pattern = restorePatternFor(selection)
    // The archive root swallows every other pattern: everything is included.
    if (pattern === null)
      return []
    if (seen.has(pattern))
      continue
    seen.add(pattern)
    out.push(pattern)
  }
  return out
}

/**
 * Ownership / ACL / xattr / permission handling, surfaced HONESTLY — GT-14
 * measured each one and `--ignore-permissions` is the surprising one: newly
 * created files land **0600**, not the archived mode and not the umask.
 *
 * Absent = the flag is not emitted (pbc's own default: restore what was
 * archived). There is no tri-state here — a restore is a one-shot operation,
 * not a stored config, so `false` and absent mean the same thing.
 */
export const BackupRestoreOptions = z.object({
  /** `--ignore-ownership`: everything is owned by root (no chown). */
  ignoreOwnership: z.boolean().optional(),
  /** `--ignore-acls`: named ACL entries are dropped; the mode is still set. */
  ignoreAcls: z.boolean().optional(),
  /** `--ignore-xattrs`: user xattrs are dropped; POSIX ACLs still apply. */
  ignoreXattrs: z.boolean().optional(),
  /** `--ignore-permissions`: newly created files land 0600 (GT-14). */
  ignorePermissions: z.boolean().optional(),
})
export type BackupRestoreOptions = z.infer<typeof BackupRestoreOptions>

/**
 * A `--rate` value: bytes/s with an optional unit, exactly as pbc's own help
 * documents it (`B, KB (base 10), MB, GB, …, KiB (base 2), MiB, GiB, …`).
 *
 * GT-62: it limits TRANSFERRED bytes, not logical bytes — a sparse image
 * finishes far faster than its size suggests.
 */
export const BackupRateLimit = z
  .string()
  .regex(/^\d+(?:\.\d+)?(?:[KMGT]?i?B)?$/, 'a byte rate with an optional unit (e.g. 10MB, 50MiB)')
export type BackupRateLimit = z.infer<typeof BackupRateLimit>

/**
 * Where a file restore lands. `path` names the archive's live HOME in
 * `inPlace` — in `newLocation` (story backup2.10) it IS the destination
 * directory: created by the restore when it does not exist, and a
 * confirm-gated MERGE into the existing directory when it does.
 */
export const BackupRestoreTarget = z
  .object({
    mode: BackupRestoreTargetMode.default('newLocation'),
    /**
     * In `inPlace` the archive's live home. Optional when the request names a
     * `task` whose archive of this name knows its own path; REQUIRED otherwise
     * (the task-less door, and an expanded archive whose name no longer
     * matches any archive).
     *
     * In `newLocation` REQUIRED: the directory the restore writes into. When it
     * does not exist, the restore creates it (parents included, GT-15) with no
     * overwrite flags; when it exists, the daemon confirm-gates the MERGE into
     * it (409 + X-Anas-Confirm-Code) and runs with the in-place flags on
     * confirm — never a silent merge, and an existing non-directory is a plain
     * refusal.
     */
    path: AbsolutePath.optional(),
  })
  .superRefine((target, ctx) => {
    if (target.mode === 'newLocation' && target.path === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'a newLocation restore needs the directory it writes into (target.path)',
      })
    }
  })
export type BackupRestoreTarget = z.infer<typeof BackupRestoreTarget>

/**
 * The backing object a whole-image restore creates when it lands as a NEW LUN
 * (story backup2.10) — the same two kinds the add-LUN door offers (iscsi),
 * minus the "map an EXISTING object" shapes, because a restore's backing is
 * always created fresh at exactly the image's manifest size:
 *
 *   `zvol`  — a new sparse ZFS volume `<pool>/<name>` (the LUN's name IS the
 *             volume name), created with `zfs create -s -V <size>`.
 *   `file`  — a new sparse image `<dir>/<name>.raw` on a ZFS dataset or an
 *             AHR pool's filesystem (exactly ONE of the two), created by
 *             `createSparseImage` at that size.
 */
export const BackupNewLunBacking = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('zvol'),
    /** The ANAS-managed ZFS pool the new volume goes on. */
    pool: PoolName,
  }),
  z
    .object({
      kind: z.literal('file'),
      /** The ANAS-managed ZFS dataset whose mountpoint hosts the image. */
      dataset: DatasetPath.optional(),
      /** The AHR pool whose filesystem hosts the image. */
      ahrPool: PoolName.optional(),
    })
    .superRefine((backing, ctx) => {
      if (backing.dataset === undefined && backing.ahrPool === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'a file-backed new LUN names where the image goes: a ZFS dataset or an AHR pool',
        })
      }
      if (backing.dataset !== undefined && backing.ahrPool !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'a file-backed new LUN takes a ZFS dataset OR an AHR pool, not both',
        })
      }
    }),
])
export type BackupNewLunBacking = z.infer<typeof BackupNewLunBacking>

/**
 * Restore the image as a NEW LUN instead of over the source (story backup2.10):
 * the new backing is created at exactly the image's manifest size, the image is
 * streamed into it, and it is mapped on `targetIqn` under a FRESH serial — the
 * source LUN is never touched, goes offline nowhere, and a copy is a new disk
 * (a copied serial would be a second disk with the source's identity).
 */
export const BackupImageRestoreNewLunTarget = z.object({
  mode: z.literal('newLun'),
  /** The ANAS-owned target the new LUN appears on. */
  targetIqn: IscsiIqn,
  /** The new LUN's name — the backstore name and the SCSI model string. */
  name: IscsiLunName,
  /** Where the new backing is created. */
  backing: BackupNewLunBacking,
})
export type BackupImageRestoreNewLunTarget = z.infer<typeof BackupImageRestoreNewLunTarget>

/**
 * `POST /v1/backup/restore` — the WHOLE-IMAGE branch (`kind: 'image'`).
 *
 * The destination is named as a LUN, not as a path: the whole point of the
 * operation is that LIO stops serving the block object while it is rewritten,
 * and a bare path could not express which target has to go offline.
 *
 * Story backup2.10 adds the second door — `target` with `mode: 'newLun'`
 * restores the image AS A NEW LUN (fresh backing at the image's manifest size,
 * a fresh serial, mapped on an existing ANAS-owned target) and the source LUN
 * is not touched at all; then `lun` — the in-place destination — is the one
 * that is optional, and the two doors are mutually exclusive.
 */
export const BackupImageRestoreRequest = z
  .object({
    kind: z.literal('image'),
    repo: BackupRepoRef,
    /** Namespace; absent falls back to the repository's own. */
    ns: z.string().max(256).optional(),
    snapshot: BackupSnapshotPath,
    /** The `.img` archive within that snapshot. */
    archive: BackupArchiveName.refine(
      n => n.endsWith(IMG_ARCHIVE_SUFFIX),
      'a whole-image restore needs an .img archive',
    ),
    /**
     * Which LUN to write back — the target it belongs to goes offline for the
     * run. REQUIRED unless `target.mode` is `newLun` (restore as a new LUN
     * instead; the source is never touched).
     */
    lun: BackupLunRef.optional(),
    /** Restore as a NEW LUN instead of onto the source (story backup2.10). */
    target: BackupImageRestoreNewLunTarget.optional(),
    /**
     * pbc's `--rate` (e.g. `50MB`), emitted ONLY when asked for. GT-62: it limits
     * TRANSFERRED bytes, not logical ones, so a sparse image finishes far faster
     * than the archive size suggests.
     */
    rate: z.string().max(32).optional(),
  })
  .superRefine((request, ctx) => {
    if (request.target?.mode === 'newLun') {
      if (request.lun !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['lun'],
          message: 'an image restore names ONE destination: the LUN it rewrites (lun) or the new LUN it creates (target) — not both',
        })
      }
      return
    }
    if (request.lun === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lun'],
        message: 'an in-place image restore needs the LUN it writes back (lun); to restore as a NEW LUN send target with mode=newLun',
      })
    }
  })
export type BackupImageRestoreRequest = z.infer<typeof BackupImageRestoreRequest>

/** Ceiling on one restore's selection count — a bounded argv and one bounded stat pass. */
export const MAX_RESTORE_SELECTIONS = 256

/**
 * `POST /v1/backup/restore` with `kind: 'files'` — restore selected entries of
 * ONE pxar archive.
 *
 * A DIRECTORY selection restores recursively (GT-20). A hardlink's second name
 * picked ALONE fails the whole job (GT-25), so the daemon completes the group
 * before it runs. A pattern that matches nothing is a SILENT SUCCESS (GT-24),
 * so the daemon verifies what landed instead of trusting exit 0.
 */
export const BackupFilesRestoreRequest = z.object({
  kind: z.literal('files'),
  /** Repository reference (a registered name or `pve:<storage-id>`). */
  repo: BackupRepoRef,
  /** Namespace; absent = the repository's own. */
  ns: z.string().optional(),
  /**
   * The task this restore came from, when there is one. It supplies the
   * archive's live home so `target.path` can be omitted — nothing else. An
   * unknown task is not an error: the caller simply has to name the path.
   */
  task: BackupName.optional(),
  /** The FULL `<type>/<id>/<RFC3339>` id — a bare group means "latest" (GT-57). */
  snapshot: BackupSnapshotPath,
  /** The archive argument WITH its type suffix (`data.pxar`) — GT-16. */
  archive: BackupArchiveName,
  /**
   * Archive-relative paths, at least one. `/` (the archive root) means the
   * whole tree. Hardlink groups arrive as all their names; the daemon completes
   * a partly-named group itself.
   */
  selections: z.array(ArchivePath).min(1).max(MAX_RESTORE_SELECTIONS),
  /**
   * The destination, named by the operator (ruling 2026-08-29: with the
   * beside-the-original mode dropped there is no destination the daemon may
   * name on the operator's behalf). `inPlace` without a path defers to the
   * task's own archive home (the route resolves it); `newLocation` always
   * carries its directory. A restore without a destination is refused at the
   * boundary, never guessed.
   */
  target: BackupRestoreTarget,
  options: BackupRestoreOptions.default({}),
  /** Optional transfer-rate limit (`--rate`). */
  rate: BackupRateLimit.optional(),
})
export type BackupFilesRestoreRequest = z.infer<typeof BackupFilesRestoreRequest>

export const BackupRestoreRequest = z.discriminatedUnion('kind', [
  BackupImageRestoreRequest,
  BackupFilesRestoreRequest,
])
export type BackupRestoreRequest = z.infer<typeof BackupRestoreRequest>

/**
 * The result of a whole-image restore job.
 *
 * `complete: false` is the state that matters most: a mid-stream failure leaves
 * BYTES ON THE DEVICE with no marker of any kind (GT-60 shows pxar leaves none
 * for a tree; a block device has even less to mark with), so the job says it in
 * words and the target is deliberately LEFT DISABLED. Re-enabling it is an
 * explicit `POST /v1/iscsi/targets/:iqn/state {action:'enable'}` — the
 * operator's acknowledgement that a half-written LUN is not to be served.
 */
export const BackupImageRestoreResult = z.object({
  snapshot: z.string(),
  archive: z.string(),
  targetIqn: z.string(),
  lunIndex: z.number().int().nonnegative(),
  /** The device or file the image was streamed into. */
  targetPath: AbsolutePath,
  /** The image's size from the manifest — equal to the target's, by pre-check. */
  imageSize: z.number().int().nonnegative(),
  /** Bytes ANAS's own write stream put on the target. */
  bytesWritten: z.number().int().nonnegative(),
  /** Did the whole image land? `false` ⇒ the target holds a half-written image. */
  complete: z.boolean(),
  /** The half-written state, spelled out. Present only when `complete` is false. */
  partial: z.string().optional(),
  /** Did ANAS disable the target's TPG, and did it get re-enabled? */
  targetDisabled: z.boolean(),
  targetReEnabled: z.boolean(),
  /** pbc's own `restore complete (…)` line, when it printed one. */
  duration: z.string().optional(),
  /** Serial + attribute read-back, and anything else worth saying. */
  warnings: z.array(z.string()).optional(),
  /**
   * Present ONLY for a `newLun` restore (story backup2.10) — the new LUN this
   * run created. When it is present, `targetIqn`/`lunIndex`/`targetPath` above
   * name the NEW object, `targetDisabled`/`targetReEnabled` are both false
   * (nothing went offline), and the source LUN was never touched. A `newLun`
   * run that fails cleans up what it created and fails as a job — it never
   * returns a result with `complete: false`.
   */
  newLun: z.object({
    targetIqn: z.string(),
    index: z.number().int().nonnegative(),
    name: z.string(),
    /** The FRESH unit serial — never the source LUN's (a copy is a new disk). */
    serial: z.string(),
    /** The backing this run created: the zvol device path or the image file. */
    backingPath: AbsolutePath,
  }).optional(),
})
export type BackupImageRestoreResult = z.infer<typeof BackupImageRestoreResult>
/**
 * How a finished file restore turned out.
 *
 *   `completed`               — every selected path is present under the target.
 *   `completed-with-warnings` — the client exited 0 but something is missing
 *                               (GT-24's silent no-match, or GT-21's empty
 *                               directory, which `--pattern` cannot restore).
 *   `partial`                 — the client did NOT finish. A newLocation
 *                               directory the restore CREATED is labelled by
 *                               ANAS, because the client leaves no marker at
 *                               all (GT-60); a directory the restore MERGED
 *                               into (inPlace, or a confirmed existing
 *                               newLocation) is never labelled or removed.
 */
export const BackupRestoreStatus = z.enum(['completed', 'completed-with-warnings', 'partial'])
export type BackupRestoreStatus = z.infer<typeof BackupRestoreStatus>

/** One parsed `progress N% (…)` line (GT-59). The raw line rides along. */
export const BackupRestoreProgress = z.object({
  /** The line exactly as pbc wrote it, minus the trailing `\r` and padding. */
  line: z.string(),
  percent: z.number().int().min(0).max(100).optional(),
  /** `12.409 MiB` / `250.001 MiB` — kept as the client rendered them. */
  done: z.string().optional(),
  total: z.string().optional(),
  elapsed: z.string().optional(),
  rate: z.string().optional(),
})
export type BackupRestoreProgress = z.infer<typeof BackupRestoreProgress>

/** The result of one file restore job. */
export const BackupFilesRestoreResult = z.object({
  kind: z.literal('files'),
  status: BackupRestoreStatus,
  repository: z.string(),
  namespace: z.string().optional(),
  snapshot: z.string(),
  archive: z.string(),
  mode: BackupRestoreTargetMode,
  /**
   * The directory that was WRITTEN: the archive's live home in `inPlace`, the
   * operator's chosen directory in `newLocation` (created, or pre-existing).
   */
  target: z.string(),
  /**
   * True whenever the restore ran with the MERGE flags — `inPlace` always,
   * and a `newLocation` restore whose chosen directory already existed (the
   * confirm gate's "yes"). Files under the target that are not in the archive
   * SURVIVE (GT-12) — stated on the record so nobody reads a completed merge
   * as "the target now matches the snapshot". False when the restore created
   * its own new directory.
   */
  merge: z.boolean(),
  /** The selection actually restored, hardlink completion included. */
  selections: z.array(z.string()),
  /** Paths the daemon ADDED because a hardlink group was only partly named. */
  addedForHardlinks: z.array(z.string()).default([]),
  /** The `--pattern` arguments sent, verbatim. Empty = the whole archive. */
  patterns: z.array(z.string()),
  /** Selected paths verified present under the target afterwards. */
  restored: z.array(z.string()),
  /** Selected paths that are NOT there — the client's silent no-match, named. */
  missing: z.array(z.string()),
  /** Every `progress …` line pbc emitted, parsed (GT-59: widening intervals). */
  progress: z.array(BackupRestoreProgress).default([]),
  /** The `restore complete (… processed in …)` line, verbatim, when seen. */
  completeLine: z.string().optional(),
  /** Bytes processed, parsed from the complete line (else the last progress line). */
  bytes: z.number().nonnegative().optional(),
  /** The `.anas-restore-partial` marker this job wrote, when it wrote one. */
  partialMarker: z.string().optional(),
  warnings: z.array(z.string()).default([]),
})
export type BackupFilesRestoreResult = z.infer<typeof BackupFilesRestoreResult>
