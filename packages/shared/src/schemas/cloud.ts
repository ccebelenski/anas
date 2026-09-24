import { z } from 'zod'
import { BackupArchiveConsistency, BackupName, BackupRunRequest, BackupRunResult } from './backup.js'
import { AbsolutePath, ISODateTime, NotifyMode } from './common.js'
import { cadenceToOnCalendar, TaskCadence } from './task-cadence.js'

/**
 * Cloud sync — remotes (story rclone.1, Epic: Cloud sync via rclone).
 *
 * Remotes live in ANAS's OWN rclone.conf (/etc/anas/rclone.conf, 0600 root) —
 * DESIGN "Cloud sync — rclone", "Remotes = ANAS's own rclone.conf". Reads go
 * through `rclone config dump`; a remote is `{name, type, options (non-secret
 * keys only), secretsSet (the secret keys that ARE set)}` — a secret value is
 * never returned. A key is secret when rclone types it as a password
 * (`IsPassword`, the obscure-in-file set) or when its name ends in `pass`,
 * `password`, `secret`, `token` or `key` (the generic name rule that stands in
 * for rclone 1.60's missing `Sensitive` flag). Writes are ANAS's own surgical
 * INI edit; password-typed values are obscured via `rclone obscure -` over
 * stdin, and no secret ever enters an argv.
 */

/**
 * A remote name — the `[name]` section in rclone.conf and the `name:` of
 * `name:path` references. No spaces or colons: the name is also used to build
 * rclone environment-variable names (`RCLONE_CONFIG_<NAME>_<KEY>`), so it must
 * stay a clean identifier.
 */
export const CloudRemoteName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9][\w.-]*$/i, 'letters, digits, underscore, dot and dash; must start with a letter or digit')
export type CloudRemoteName = z.infer<typeof CloudRemoteName>

/** One example value of a provider option (e.g. an S3 region for a provider). */
export const CloudProviderExample = z
  .object({
    value: z.string(),
    help: z.string(),
    provider: z.string(),
  })
export type CloudProviderExample = z.infer<typeof CloudProviderExample>

/**
 * One option of a cloud backend, trimmed from `rclone config providers` to
 * what the dialog renders.
 *
 * The two booleans carry DIFFERENT facts and drive different behaviour:
 *  - `secret` (hide the value from responses): `IsPassword` OR the name rule
 *    — s3's `secret_access_key` and b2's `key` are secret here although rclone
 *    does not type them as passwords. A BOOL option is never secret:
 *    `sftp.ask_password` matches the name rule but holds `true`/`false`.
 *  - `password` (obscure the value in the file): rclone's `IsPassword` ONLY.
 *    A secret-by-name value is stored PLAIN — rclone would not reveal an
 *    obscured value in a non-password field.
 */
export const CloudProviderOption = z
  .object({
    name: z.string(),
    help: z.string(),
    type: z.string(),
    required: z.boolean(),
    secret: z.boolean(),
    password: z.boolean(),
    default: z.string(),
    examples: z.array(CloudProviderExample),
    /** The backend filter this option instance applies to (`AWS`, `!AWS,…`); '' = all. */
    provider: z.string(),
    advanced: z.boolean(),
  })
export type CloudProviderOption = z.infer<typeof CloudProviderOption>

/** One cloud backend from rclone's provider catalogue (46 in 1.60). */
export const CloudProvider = z
  .object({
    name: z.string(),
    description: z.string(),
    options: z.array(CloudProviderOption),
  })
export type CloudProvider = z.infer<typeof CloudProvider>

/**
 * A remote as ANAS reports it: never a secret value. `options` holds the
 * non-secret keys only; `secretsSet` names the secret keys that are set
 * (their values are never included).
 */
export const CloudRemote = z
  .object({
    name: CloudRemoteName,
    type: z.string().min(1),
    /** Non-secret keys only (the `type` key itself excluded — it is a field). */
    options: z.record(z.string(), z.string()),
    /** The secret keys that are set — the values never appear. */
    secretsSet: z.array(z.string()),
  })
export type CloudRemote = z.infer<typeof CloudRemote>

/**
 * Create a remote. Secret values arrive here in plain text and are obscured
 * (via `rclone obscure -`) before they reach the file; the response never
 * returns them.
 */
export const CloudRemoteWrite = z
  .object({
    name: CloudRemoteName,
    type: z.string().min(1),
    /** Option values by key; secret values in plain text (write-only). */
    options: z.record(z.string(), z.string()),
  })
export type CloudRemoteWrite = z.infer<typeof CloudRemoteWrite>

/**
 * Update a remote. An ABSENT secret key means unchanged (secrets are
 * write-only — the dialog cannot read one back to send it); an EMPTY string
 * for a non-secret key means "remove the key". `type` is immutable — a retype
 * is a remove + create (rclone's own posture).
 */
export const CloudRemoteUpdate = z
  .object({
    options: z.record(z.string(), z.string()),
  })
export type CloudRemoteUpdate = z.infer<typeof CloudRemoteUpdate>

/** Facts about the node's rclone binary + config file (Remotes window footer). */
export const CloudRcloneInfo = z
  .object({
    version: z.string(),
    configFile: z.string(),
    /**
     * The config file is password-encrypted: ANAS reports it as a fact and
     * refuses every mutation (`config-encrypted`) — it neither prompts nor
     * stores the passphrase.
     */
    encrypted: z.boolean(),
  })
export type CloudRcloneInfo = z.infer<typeof CloudRcloneInfo>

/** `GET /v1/cloud/remotes` — the remotes of the node's own rclone.conf. */
export const CloudRemotesResponse = z
  .object({
    rclone: CloudRcloneInfo,
    remotes: z.array(CloudRemote),
  })
export type CloudRemotesResponse = z.infer<typeof CloudRemotesResponse>

/**
 * The bounded-`lsjson` verdict of a remote Test (rclone.1 probe / later slice):
 * exit codes alone cannot tell the buckets apart (`NewFs` failures all exit 1),
 * so the verdict is a classifier over rclone's message.
 */
export const CloudRemoteTestVerdict = z
  .enum(['ok', 'unreachable', 'auth', 'not-found', 'error'])
export type CloudRemoteTestVerdict = z.infer<typeof CloudRemoteTestVerdict>

/** A Test result: the verdict bucket + rclone's line, verbatim on `error`. */
export const CloudRemoteTestResult = z
  .object({
    verdict: CloudRemoteTestVerdict,
    message: z.string(),
  })
export type CloudRemoteTestResult = z.infer<typeof CloudRemoteTestResult>

/**
 * `POST /v1/cloud/remotes/test` — Test a SAVED remote by `name`, or an
 * UNSAVED dialog by `remote` (served through an environment-defined remote,
 * so nothing is written before the user saves). Exactly one of the two.
 * `path` is the remote-side path to list (default: the remote root).
 */
export const CloudRemoteTestRequest = z
  .object({
    name: CloudRemoteName.optional(),
    remote: CloudRemoteWrite.optional(),
    path: z.string().max(2048).optional(),
  })
  .refine(v => (v.name === undefined) !== (v.remote === undefined), {
    message: 'exactly one of name or remote is required',
  })
export type CloudRemoteTestRequest = z.infer<typeof CloudRemoteTestRequest>

// ---------------------------------------------------------------------------
//  Cloud sync TASKS (story rclone.2)
// ---------------------------------------------------------------------------

/**
 * A cloud sync task — one `anas-cloud-<name>.service` + `.timer` pair, the
 * fifth unit store. This exact shape is embedded as the `X-ANAS-Task=` JSON in
 * the service file and is the SINGLE source of truth parsed back (the backup
 * store's contract, reapplied: DESIGN "Tasks = systemd units").
 *
 * What is DELIBERATELY absent: retention or versioning on the remote, two-way
 * sync, a dry-run flag, `--max-delete`. DESIGN's simplicity check names each
 * of them as out of scope.
 */

/**
 * `copy` never deletes at the destination; `sync` mirrors the source exactly,
 * deletions included. `copy` is the default because it is the mode that cannot
 * destroy anything — the empty-source guard exists only for the other one.
 */
export const CloudSyncMode = z.enum(['copy', 'sync'])
export type CloudSyncMode = z.infer<typeof CloudSyncMode>

/**
 * An rclone bandwidth limit (`--bwlimit`), validated LOOSELY on purpose: a
 * plain rate, optionally suffixed `K`/`M`/`G` (`8M`). rclone's own syntax is
 * richer (timetables, `B`/`k`/`Mi` spellings) and ANAS neither re-implements
 * nor blesses all of it — the shape here is what the dialog offers, and rclone
 * stays the authority on what it accepts.
 */
export const CloudBandwidthLimit = z
  .string()
  .regex(/^\d+[KMG]?$/i, 'a rate like 8M (digits, optionally suffixed K, M or G)')
export type CloudBandwidthLimit = z.infer<typeof CloudBandwidthLimit>

/**
 * The stored task. `name` follows the SAME rule a backup task's does
 * ({@link BackupName}): it becomes a unit file name, and the two stores must
 * not disagree about what a task may be called.
 */
export const CloudSyncTask = z.object({
  name: BackupName,
  /** The local tree to send. Absolute — a dataset mountpoint, a share path, any directory. */
  source: AbsolutePath,
  /** The remote to send it to — a section of ANAS's own rclone.conf. */
  remote: CloudRemoteName,
  /**
   * The remote-side path under `remote:`. MAY BE EMPTY — `remote:` alone is
   * the remote's own root, which is what an sftp home directory or a bucket
   * root actually is. MAY START WITH `/` — on some backends (sftp) that is
   * the remote's own absolute root, so it stays allowed (rclone.3 dialog).
   * Control characters and leading/trailing whitespace are refused: the path
   * is joined into `remote:<path>` verbatim, and a padded or control-bearing
   * value names something no backend resolves.
   */
  path: z
    .string()
    .max(2048)
    // eslint-disable-next-line no-control-regex -- the control characters ARE the thing being refused
    .regex(/^[^\x00-\x1F\x7F]*$/, 'control characters are not allowed in a remote path')
    .refine(p => p === p.trim(), 'leading or trailing whitespace is not allowed in a remote path')
    .default(''),
  mode: CloudSyncMode.default('copy'),
  /** `--exclude` patterns, one flag each, in order. */
  excludes: z.array(z.string().min(1).max(512)).default([]),
  /** Optional `--bwlimit`. Absent = rclone's own default (no limit). */
  bwlimit: CloudBandwidthLimit.optional(),
  /**
   * When a finished run notifies through PVE. DEFAULT `always` — backup parity
   * (DESIGN: the task is the operator's offsite copy), not the `on-failure`
   * default a snapshot schedule takes.
   */
  notify: NotifyMode.default('always'),
  /** systemd OnCalendar expression. GENERATED from `cadence` when one is present. */
  schedule: z.string().min(1),
  /** The structured schedule — the SAME cadence contract backup tasks carry. */
  cadence: TaskCadence.optional(),
  enabled: z.boolean().default(true),
})
export type CloudSyncTask = z.infer<typeof CloudSyncTask>

/**
 * Create/update request. When a structured `cadence` is present the OnCalendar
 * expression is DERIVED from it here and overwrites whatever `schedule` the
 * client sent — the cadence is authoritative and the generator lives in exactly
 * one place (the backup request's rule, verbatim).
 */
export const CloudSyncTaskRequest = z.preprocess((raw) => {
  if (raw && typeof raw === 'object') {
    const o = { ...(raw as Record<string, unknown>) }
    if (o.cadence !== undefined) {
      // Parse defensively: an invalid cadence falls through to full validation
      // below, which reports the real problem rather than a schedule error.
      const cadence = TaskCadence.safeParse(o.cadence)
      const generated = cadence.success ? cadenceToOnCalendar(cadence.data) : null
      if (generated)
        o.schedule = generated
    }
    // An empty bandwidth limit is what a cleared dialog field sends, and it
    // means "no limit" — which is what an ABSENT field already means, so it
    // normalizes to absent rather than riding the unit JSON as `""` forever.
    if (o.bwlimit === '' || o.bwlimit === null)
      delete o.bwlimit
    return o
  }
  return raw
}, CloudSyncTask)
export type CloudSyncTaskRequest = z.infer<typeof CloudSyncTaskRequest>

/**
 * A grid row: the stored task plus its LOCAL-ONLY runtime status, derived per
 * load from systemd unit + timer state (no shadow state). `lastRunResult` is
 * the SAME systemd-derived enum a backup task reports — one vocabulary for
 * every unit-store task kind, so `skipped` and `disabled` mean here exactly
 * what they already mean there.
 */
export const CloudSyncTaskView = CloudSyncTask.extend({
  lastRunResult: BackupRunResult,
  lastRunAt: ISODateTime.nullable(),
  nextRunAt: ISODateTime.nullable(),
  /** Enabled task past its schedule without a successful run (counts as failed). */
  overdue: z.boolean(),
})
export type CloudSyncTaskView = z.infer<typeof CloudSyncTaskView>

/**
 * `GET /v1/cloud/tasks/:name` — the detail window's facts: the row, the DERIVED
 * source consistency, the nested filesystems that will NOT be included, the two
 * units as written, and the recent journald tail (labeled recent-only).
 */
export const CloudSyncTaskDetail = z.object({
  task: CloudSyncTaskView,
  /** The derived source consistency — the same derivation a backup source gets. */
  consistency: BackupArchiveConsistency.optional(),
  /** Absolute paths of nested filesystems under the source (a snapshot omits them). */
  nested: z.array(z.string()).optional(),
  unit: z.string(),
  timer: z.string(),
  journal: z.string().optional(),
  /** Why there is no run history to show (a disabled unit's is collected). */
  statusNote: z.string().optional(),
})
export type CloudSyncTaskDetail = z.infer<typeof CloudSyncTaskDetail>

/**
 * What one finished rclone run amounts to — built from the LAST `stats` object
 * of rclone's JSON log, plus what ANAS knows about the run it drove.
 *
 * Every count is rclone's own; nothing here is estimated. `errorLines` carries
 * rclone's error-level messages verbatim — the same lines the failed job's
 * message and the notification body show.
 */
export const CloudSyncRunResult = z.object({
  /** `success`, or the deliberate off-week skip's status. */
  status: z.string(),
  mode: CloudSyncMode,
  /** The DERIVED source consistency — the label plus the sentence saying why. */
  consistency: BackupArchiveConsistency,
  /** The path rclone was actually pointed at (the snapshot path in snapshot mode). */
  source: z.string(),
  /** `remote:path` as rclone was given it. */
  destination: z.string(),
  /** The transient snapshot that existed while the run read, when there was one. */
  snapshot: z.string().optional(),
  bytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  transfers: z.number().nonnegative(),
  checks: z.number().nonnegative(),
  deletes: z.number().nonnegative(),
  errors: z.number().nonnegative(),
  /** rclone's own elapsed seconds, from the final stats object. */
  elapsed: z.number().nonnegative(),
  /**
   * Whether rclone reported ANY stats object this run. It prints its first at
   * the first `--stats` interval, so a sub-second run reports none and the
   * counters above are zeros that rclone never said — the notification body
   * and the UI say "no counters reported" instead of showing them. Defaults
   * true so results recorded before the field existed still parse.
   */
  countersReported: z.boolean().default(true),
  /** rclone's error-level log lines, verbatim and in order. */
  errorLines: z.array(z.string()).default([]),
  /** Nested filesystems under the source that the run did NOT include. */
  nested: z.array(z.string()).optional(),
  /** Why a run did nothing (the cadence skip's detail). */
  reason: z.string().optional(),
  /** Completed-with-warning detail (a transient that outlived its `finally`). */
  warnings: z.array(z.string()).optional(),
})
export type CloudSyncRunResult = z.infer<typeof CloudSyncRunResult>

/**
 * Run-Now request body — structurally the backup run request, and deliberately
 * ITS schema: `direct: true` is the INTERNAL path a task's own systemd unit
 * takes (the cloud-task runner the timer fires), and the recursion guard has to
 * mean the same thing in both stores.
 */
export const CloudSyncRunRequest = BackupRunRequest
export type CloudSyncRunRequest = BackupRunRequest
