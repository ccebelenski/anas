import { z } from 'zod'
import { DatasetPath, excludeShapeIssue, hasControlChars, ISODateTime, NotifyMode, PoolName, SingleLine, SnapshotName } from './common.js'

/**
 * A replication dataset field: a validated ZFS DatasetPath, OR the empty string.
 * The empty string is load-bearing — it means "the pool root" for a source and
 * "default to the source's relative path" for a target — so it must stay valid.
 * Everything non-empty is charset-restricted (no shell metacharacters, no
 * control chars) because these values flow into `zfs recv …` and `ssh <peer>
 * zfs recv …` argv and into systemd `ExecStart=` lines.
 */
const ReplicationDataset = DatasetPath.or(z.literal(''))

/**
 * Replication (Epic 5.5) — stage 1: LOCAL one-shot snapshot replication
 * (`zfs send | zfs recv` on the same node).
 *
 * Design (EPICS 5.5.x): stateless — the incremental base is
 * DISCOVERED at run time as the newest snapshot common to source and target
 * (never bookkept); the destination is created `readonly=on`; the incremental
 * base carries a `zfs hold` under the chain's own tag (`anas-repl-<12 hex of
 * sha256(location, target)>`, `replicationHoldTag` in the daemon's
 * services/replication-holds.ts — ident.4; the suffix-less `anas-repl` is the
 * tag earlier installs placed, migrated away) so cleanup cannot sever the
 * chain; a broken chain means a FULL send and the caller must be told (with
 * bytes) before running. journald is forensics, never correctness.
 *
 * Two endpoints, both dataset-scoped:
 *   POST /pools/:name/datasets/<path>/replicate/plan → ReplicatePlan (dry-run,
 *        read-only: mode + exact estimated bytes from `zfs send -nvP`)
 *   POST /pools/:name/datasets/<path>/replicate      → 202 { job }
 */

/** Where replication can land (stage 3): local, a cluster peer, or a remote. */
export const ReplicationLocation = z.object({
  /** 'local' (default) | 'peer' (PVE cluster node) | 'remote' (registered). */
  kind: z.enum(['local', 'peer', 'remote']).default('local'),
  /**
   * Peer nodename or registered remote name (absent for local). Single-line —
   *  a peer name becomes the `ssh root@<name>` host and both are matched against
   *  a known-nodes / registry set.
   */
  name: SingleLine.optional(),
})
export type ReplicationLocation = z.infer<typeof ReplicationLocation>

/**
 * Where a replication lands: a pool and optionally a dataset path within it
 *  (default: the source dataset's own path). Stage 1 is same-node only.
 */
export const ReplicationTarget = z.object({
  pool: PoolName,
  /**
   * Target dataset path relative to the pool (no leading slash). Defaults to
   *  the source dataset's relative path. '' is treated as "default".
   */
  dataset: ReplicationDataset.optional(),
  /**
   * Stage 3: where the target pool lives — local (default), a PVE cluster
   *  peer, or a registered external remote. Additive; absent = local.
   */
  location: ReplicationLocation.optional(),
})
export type ReplicationTarget = z.infer<typeof ReplicationTarget>

/** Ask what a replication WOULD do (dry-run; mutates nothing). */
export const ReplicatePlanRequest = z.object({
  target: ReplicationTarget,
  /**
   * Source snapshot to replicate up to (default: the newest snapshot). ZFS
   *  snapshot charset — flows into `zfs`/`ssh` argv as `<source>@<snapshot>`.
   */
  snapshot: SnapshotName.optional(),
})
export type ReplicatePlanRequest = z.infer<typeof ReplicatePlanRequest>

/** The dry-run answer — shown to the user before they commit. */
export const ReplicatePlan = z.object({
  /** 'incremental' when a common base snapshot exists on both sides. */
  mode: z.enum(['full', 'incremental']),
  /** The snapshot that will be sent (source-side name). */
  snapshot: SnapshotName,
  /** The common base snapshot (incremental mode only; name without dataset). */
  baseSnapshot: SnapshotName.optional(),
  /** Exact stream size in bytes from `zfs send -nvP`. */
  estimatedBytes: z.number().nonnegative(),
  /** Whether the target dataset already exists. */
  targetExists: z.boolean(),
  /**
   * True when the target exists but shares NO common snapshot — a full send
   *  cannot proceed without destroying the target (out of stage-1 scope; the
   *  UI must say so instead of offering the run).
   */
  targetDiverged: z.boolean(),
  /**
   * cr3 (REPLICATION-M1): true when the target already has `snapshot` —
   * nothing would be sent (`estimatedBytes` 0, no `baseSnapshot`; `mode`
   * stays 'incremental' so a panel that predates the field shows no full
   * send). A run of such a plan sends nothing and moves no hold onto an older
   * snapshot. ADDITIVE/optional: absent everywhere else.
   */
  upToDate: z.boolean().optional(),
})
export type ReplicatePlan = z.infer<typeof ReplicatePlan>

// --- Recursive replication (rrep.1, #84): the fields and the rules both bodies hold --

/**
 * R3 — recursive replication sends ONE snapshot name across the tree (R4: the
 * newest snapshot of the source root), i.e. the snapshots a recursive snapshot
 * SCHEDULE takes. Snapshot-first would take a fresh one per run under the
 * manual `snapshot-<iso>` name, which nothing prunes (#80) and which the
 * operator cannot select recursively anyway; the dialog disables the field
 * while "Include child datasets" is checked (R11). One sentence, both schemas.
 */
const RECURSIVE_SNAPSHOT_FIRST_REFUSAL = 'Recursive replication sends the snapshots a recursive snapshot schedule takes — turn off \'Take a fresh snapshot before each run\' and schedule the source recursively in the Snapshots menu'

/** The recursion fields, as both replication bodies carry them (R10). */
interface RecursionFields {
  recursive?: boolean
  exclude?: string[]
  snapshotFirst?: boolean
}

/** A schema-level refusal of the recursion fields, at the field that caused it. */
interface RecursionIssue {
  path: ['exclude'] | ['snapshotFirst']
  message: string
}

/**
 * What the recursion fields refuse at the SCHEMA boundary: R10's exclude shape
 * (the schedule's own sentences, through the one shared helper) and R3's
 * snapshot-first pairing. Returns every issue it can see — the exclude list's
 * FIRST violation plus the R3 pairing, so a body wrong in both ways says both.
 *
 * `sourceFull` is the pool-rooted source a TASK knows: pool + `/` + dataset, or
 * the pool alone for a pool-root source — the same name the daemon derives in
 * `resolveTaskDatasets` (`services/replication-units.ts`), which stays the one
 * place a task's full names are built for the ZFS commands; the shared package
 * cannot import the daemon, so the join is restated here (and pinned by a test
 * of the not-a-child sentence on a pool-root and a nested source).
 * The one-off request passes null: its source is in the URL, so the child rule
 * is the run branch's (rrep.1) — the request checks only "exclude requires
 * recursive", exactly as the brief's R10 half at this boundary says.
 */
function recursionIssues(body: RecursionFields, sourceFull: string | null): RecursionIssue[] {
  const issues: RecursionIssue[] = []
  const shape = excludeShapeIssue(sourceFull, body.recursive, body.exclude, 'replication')
  if (shape)
    issues.push({ path: ['exclude'], message: shape })
  if (body.recursive === true && body.snapshotFirst === true)
    issues.push({ path: ['snapshotFirst'], message: RECURSIVE_SNAPSHOT_FIRST_REFUSAL })
  return issues
}

/** The pool-rooted source dataset of a task, as `resolveTaskDatasets` builds it. */
function taskSourceFull(source: { pool: string, dataset: string }): string {
  return source.dataset ? `${source.pool}/${source.dataset}` : source.pool
}

/**
 * Run a replication (202 → job). Same fields as the plan request, plus an
 *  optional snapshot-first convenience.
 */
export const ReplicateRequest = z.object({
  target: ReplicationTarget,
  /**
   * Source snapshot to replicate up to (default: the newest snapshot). ZFS
   *  snapshot charset — flows into `zfs`/`ssh` argv as `<source>@<snapshot>`.
   */
  snapshot: SnapshotName.optional(),
  /**
   * Create a fresh snapshot of the source first (name auto-generated like the
   *  snapshot dialog default), then replicate up to it.
   */
  snapshotFirst: z.boolean().optional(),
  /**
   * When THIS run notifies through PVE (story 9.4). The mode has to arrive with
   * the REQUEST because the one-shot endpoint is the single place every
   * replication converges and it deliberately knows nothing about tasks — a
   * recurring task's runner forwards its own stored mode here (see
   * {@link ReplicationTask.notify}), while an interactive replicate simply omits
   * the field and gets the quiet default.
   *
   * Additive + defaulted, so an OLD client (or the pre-9.4 runner) that sends no
   * `notify` keeps the failure-only behaviour rather than erroring.
   */
  notify: NotifyMode.default('on-failure'),
  /**
   * Replicate the source's whole tree, one `zfs send | zfs recv` per dataset
   *  (rrep.1, #84). ABSENT IS ABSENT, never defaulted: R0 — a request without
   *  the field runs today's single-dataset path, so an old client parses and
   *  behaves exactly as before (and a daemon that does not know the field can
   *  never be talked into a recursive run, R12).
   */
  recursive: z.boolean().optional(),
  /**
   * Child datasets of the source the recursive run skips, each with its whole
   *  subtree — the shape a recursive snapshot schedule already takes
   *  ({@link excludeShapeIssue}). Only meaningful with `recursive`; whether an
   *  entry EXISTS is the route's question, as it is for a schedule.
   */
  exclude: z.array(DatasetPath).optional(),
}).superRefine((r, ctx) => {
  for (const issue of recursionIssues(r, null))
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
export type ReplicateRequest = z.infer<typeof ReplicateRequest>

// ---- Stage 2: recurring replication TASKS (the Replication view) -------------
//
// Task store = the systemd units themselves (anas-repl-<name>.service/.timer),
// generated/parsed/rewritten by the daemon — no second config source, no custom
// scheduler. Status: authoritative last-success/lag derive from ZFS snapshot
// state on both ends; current failure state from systemd; journald = forensics.

/** A task name — also the systemd unit suffix (anas-repl-<name>). */
export const ReplicationTaskName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase alphanumerics and dashes')
export type ReplicationTaskName = z.infer<typeof ReplicationTaskName>

/**
 * The FIELDS of a configured recurring replication (one systemd service+timer
 * pair), WITHOUT the recursion rules — the plain base both ReplicationTask and
 * LenientReplicationTask build from.
 *
 * Why a base object rather than refining inline: a recursive ZodObject refuses
 * `.extend()` in this repo's zod (4.3.6 throws "Cannot overwrite keys on object
 * schemas containing refinements. Use `.safeExtend()` instead."), and
 * `.safeExtend()` INHERITS the checks — which is exactly what the lenient
 * read-back must not carry (its purpose is parsing a stored task the strict
 * rules refuse). So: rules are added to the base ONCE (ReplicationTask's
 * `superRefine`), and the lenient variant extends the bare base and stays
 * rule-free, exactly as when it extended a plain object.
 *
 * Exported for the task UPDATE door (rrep.2 fold D1): a PUT body is first
 * parsed for field SHAPES only with this base, the stored `recursive` /
 * `exclude` are merged in for the keys the body omitted, and only the merged
 * task is judged by the strict {@link ReplicationTask} — the cross-field rules
 * never judge a body that is missing the stored half of a pair.
 */
export const ReplicationTaskFields = z.object({
  name: ReplicationTaskName,
  /** Source dataset, pool-rooted ('' dataset = the pool root). */
  source: z.object({ pool: PoolName, dataset: ReplicationDataset }),
  target: ReplicationTarget,
  /** systemd OnCalendar expression (e.g. 'daily', '02:00', 'Mon *-*-* 03:00'). */
  schedule: SingleLine.min(1),
  /** Snapshot the source before each run (recommended; default true). */
  snapshotFirst: z.boolean().default(true),
  enabled: z.boolean().default(true),
  /**
   * When a finished run notifies through PVE (story 9.4, backup 16.12's modes).
   * DEFAULT `on-failure`, deliberately quieter than backup's `always` — and the
   * behaviour every task stored before the field existed keeps, since an absent
   * value parses back to it.
   *
   * The task JSON is where the mode LIVES; the timer's runner carries it to the
   * one-shot endpoint that actually notifies (services/replication-units.ts
   * runnerArgs → replicate-task.ts → {@link ReplicateRequest.notify}).
   */
  notify: NotifyMode.default('on-failure'),
  /**
   * Replicate the source's whole tree, one `zfs send | zfs recv` per dataset
   *  (rrep.1, #84). ABSENT IS ABSENT, never defaulted: R0 — a task stored (or
   *  a client speaking) without the field runs today's single-dataset path,
   *  exactly as before. R12: the CREATE/UPDATE route must refuse to save a
   *  non-recursive task carrying an exclude list, never silently strip it.
   */
  recursive: z.boolean().optional(),
  /**
   * Child datasets of the source this task's recursive runs skip, each with its
   *  whole subtree — the same list shape a recursive snapshot schedule takes
   *  ({@link excludeShapeIssue}); the child rule is checked against the
   *  source's pool-rooted name. Whether an entry EXISTS on the live tree is the
   *  route's question, as it is for a schedule.
   */
  exclude: z.array(DatasetPath).optional(),
  /**
   * Read-path ONLY: set true (with a reason) when a STORED task failed STRICT
   * validation but parsed leniently — e.g. a dataset that no longer matches the
   * narrowed ReplicationDataset regex. Such a task stays VISIBLE in the list so
   * the operator can delete/repair it (its systemd timer keeps firing
   * regardless). NEVER set on create/update — those stay strict-gated — and
   * omitted (undefined) from a valid task.
   */
  invalid: z.boolean().optional(),
  /** Why the stored task failed strict validation (paired with `invalid`). */
  invalidReason: z.string().optional(),
})

/**
 * A task as the CREATE/UPDATE gate accepts it: the fields above plus the
 * recursion rules (R10's exclude shape against the pool-rooted source name,
 * R3's snapshot-first pairing). Because `snapshotFirst` DEFAULTS to true, a
 * body of `{ recursive: true }` with no `snapshotFirst` hits the R3 refusal —
 * intended (the field can only mean "snapshot first" here, and R3 forbids
 * that pairing), and pinned by a test.
 */
export const ReplicationTask = ReplicationTaskFields.superRefine((t, ctx) => {
  for (const issue of recursionIssues(t, taskSourceFull(t.source)))
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
export type ReplicationTask = z.infer<typeof ReplicationTask>

/**
 * The LENIENT read-back form of ReplicationTask: the pool/dataset identity
 * fields relax to plain single-line strings (still control-char-free — they
 * flow into `zfs`/`ssh`/systemd argv on the read/status path) so a STORED task
 * whose dataset no longer passes the narrowed ReplicationDataset regex stays
 * parseable and VISIBLE (flagged `invalid`). Built from
 * {@link ReplicationTaskFields}, so it carries NO recursion rules — a task
 * stored before R3/R10 existed, or stored by a newer daemon under rules a
 * downgrade no longer knows, still parses. Read path only; strict
 * ReplicationTask remains the create/update gate.
 */
export const LenientReplicationTask = ReplicationTaskFields.extend({
  source: z.object({ pool: SingleLine, dataset: SingleLine }),
  target: ReplicationTarget.extend({ pool: SingleLine, dataset: SingleLine.optional() }),
})
export type LenientReplicationTask = z.infer<typeof LenientReplicationTask>

/** Live status of a task — derived, never stored (ZFS + systemd truth). */
export const ReplicationTaskStatus = z.object({
  task: ReplicationTask,
  /** Newest source snapshot already present on the target (ZFS truth). */
  lastReplicatedSnapshot: z.string().nullable(),
  /** When that snapshot was created (proxy for last successful sync). */
  lastReplicatedAt: ISODateTime.nullable(),
  /** Source snapshots newer than the last replicated one (lag). */
  snapshotsBehind: z.number().int().nonnegative().nullable(),
  /**
   * systemd: last trigger result. `disabled` is the ABSENCE of a result —
   * systemd garbage-collects the run history of a disabled unit nothing
   * references, so no real outcome can be read (live-proof F9). Additive.
   * `never-run` is the ENABLED twin: an enabled unit is kept loaded by its
   * timer, so empty run timestamps mean it has never fired — the
   * default-valued `Result=success` would read as a fabricated success.
   * Additive, like `disabled`.
   */
  lastRunResult: z.enum(['success', 'failure', 'running', 'unknown', 'disabled', 'never-run']),
  /** systemd timer: next scheduled trigger. */
  nextRunAt: ISODateTime.nullable(),
  /**
   * taskstatus.1 — one line when the last run needs it: today "ran at <time>;
   * result not retained across the reboot" beside `lastRunResult: 'unknown'`,
   * when the timer's stamp is the only record of a run left after a reboot.
   * ADDITIVE/optional.
   */
  lastRunNote: z.string().optional(),
})
export type ReplicationTaskStatus = z.infer<typeof ReplicationTaskStatus>

// ---- Stage 3: REMOTE replication (peers + external remotes) ------------------
//
// Remotes are a CLUSTER-level concept: the registry lives in pmxcfs at
// /etc/pve/anas/remotes.json (corosync-replicated; quorum-gated writes), the
// cluster-wide keypair at /etc/pve/priv/anas/replication_key, pinned host keys
// in /etc/pve/priv/anas/known_hosts. The remote itself needs sshd + ZFS only.

/**
 * SSH login user for a remote (C1, review 2026-10-14). A POSIX-style login
 * name: letters, digits, '_', '.', '-', never a leading '-' (that would reach
 * ssh as an option), 1–32 chars. WRITE-side only — buildSshArgv also passes
 * `--`, and the registry READ schema stays lenient so stored values keep
 * loading.
 */
export const RemoteUser = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[\w.][\w.-]*$/, 'letters, digits, "_", ".", "-" — never a leading "-"')
export type RemoteUser = z.infer<typeof RemoteUser>

/**
 * SSH destination host for a remote (C1, review 2026-10-14): a DNS name
 * (incl. IPv4 dotted-quad) or a BARE IPv6 address (no brackets), never a
 * leading '-' and never carrying whitespace or the characters that let the
 * string be re-read as ssh/known_hosts syntax: '[', ']', ',', '@', '/'. The
 * grammar is deliberately not checked deeper (octets ≤ 255, full IPv6 form) —
 * anything malformed simply fails to connect; the security property is the
 * charset. WRITE-side only, like {@link RemoteUser}.
 */
const HOST_NAME_RE = /^[\w.-]+$/
const HOST_IPV6_RE = /^[0-9A-F:]+$/i
export const RemoteHost = z
  .string()
  .min(1)
  .max(253)
  .refine(s => !hasControlChars(s), 'Control characters are not allowed')
  .refine(s => s[0] !== '-', 'Host must not start with "-"')
  .refine(
    s => (s.includes(':') ? HOST_IPV6_RE.test(s) : HOST_NAME_RE.test(s)),
    'Host must be a DNS name, IPv4 address, or bare IPv6 address',
  )
export type RemoteHost = z.infer<typeof RemoteHost>

/** A registered external remote (TrueNAS, plain Linux+ZFS, …). */
export const ReplicationRemote = z.object({
  /** Registry key; also shows in target pickers. */
  name: ReplicationTaskName,
  /**
   * Hostname / IP. Single-line (no control chars) — it is written into our
   *  known_hosts file and into `ssh <user>@<host>` / `ssh-keyscan` argv.
   */
  host: z.string().min(1).refine(s => !hasControlChars(s), 'Control characters are not allowed'),
  port: z.number().int().min(1).max(65535).default(22),
  /** v1 connects as root (or the remote's admin); zfs-allow delegation later. */
  user: z.string().min(1).refine(s => !hasControlChars(s), 'Control characters are not allowed').default('root'),
  /**
   * Pinned SSH host-key fingerprint (SHA256:…), set on explicit confirm. The
   * registry MIRRORS what is actually pinned in known_hosts: the test-connection
   * route writes this field whenever a probe resolves the pinned fingerprint
   * (pin, deliberate re-trust, or simply reading an already-pinned host), so the
   * Remotes grid can show the real key instead of a permanent "not pinned".
   * known_hosts stays the source of truth — this is the readable copy.
   */
  hostKeyFingerprint: z.string().optional(),
})
export type ReplicationRemote = z.infer<typeof ReplicationRemote>

/**
 * The registry file — split-brain guarded: `version` is monotonic and every
 * write is compare-and-swap (a mutation carries the version it read; the
 * daemon 409s when it moved). updatedBy/updatedAt are forensics.
 */
export const RemotesFile = z.object({
  version: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedAt: ISODateTime,
  remotes: z.array(ReplicationRemote),
})
export type RemotesFile = z.infer<typeof RemotesFile>

/**
 * Create/update a remote — carries the registry version the client read.
 * WRITE-side strictness (C1, review 2026-10-14): user/host go through
 * {@link RemoteUser}/{@link RemoteHost}, NOT the lenient READ schema —
 * ReplicationRemote must stay lenient so registries written before the
 * narrowing keep loading (buildSshArgv's `--` makes stored values harmless).
 */
export const UpsertRemoteRequest = z.object({
  remote: ReplicationRemote.extend({
    host: RemoteHost,
    user: RemoteUser.default('root'),
  }),
  /** CAS guard: the registry version this change was based on. */
  expectedVersion: z.number().int().nonnegative(),
})
export type UpsertRemoteRequest = z.infer<typeof UpsertRemoteRequest>

/**
 * Pre-registration test-connection probe body (the values typed in the dialog,
 * nothing stored yet). Parsed by `POST /replication/remotes/test` in place of
 * its old hand-rolled typeof checks — the second door a hostile user/host had
 * (C1, review 2026-10-14).
 */
export const TestRemoteRequest = z.object({
  host: RemoteHost,
  port: z.number().int().min(1).max(65535).default(22),
  user: RemoteUser.default('root'),
  /**
   * The fingerprint the operator was SHOWN — REQUIRED (enforced by the test
   * route, hence optional in the shape) whenever `?pin=true` / `?retrust=true`
   * asks to trust a key (cr.64b2-ii). The pin becomes a job bound to exactly
   * this string: it re-probes and writes known_hosts only if the host still
   * presents it; a different key → 409 STATE_CHANGED, nothing written. Before,
   * pin accepted whatever the host presented at that moment — the value the
   * operator confirmed was never checked. The registered-remote route
   * (`/:name/test`, no body schema of its own) validates this SAME field with
   * `TestRemoteRequest.pick({ fingerprint: true })`.
   */
  fingerprint: z.string().min(1).refine(s => !hasControlChars(s), 'Control characters are not allowed').optional(),
})
export type TestRemoteRequest = z.infer<typeof TestRemoteRequest>

/** Diagnosing test-connection result — says WHAT failed, not just that it did. */
export const RemoteTestResult = z.object({
  /**
   * How far the probe got. 'ok' = ssh + zfs both answered.
   *
   * 'hostkey-unknown' and 'hostkey-changed' are DIFFERENT facts and must stay
   * distinct: nothing is pinned yet (first contact) versus the host now presents
   * a key that is NOT the one we pinned. The second is the rebuilt/rekeyed
   * remote — and, with the same evidence, what a machine-in-the-middle looks
   * like — so it gets its own deliberate re-trust flow instead of being reported
   * as a generic 'unreachable' the operator can only fix by hand-editing
   * known_hosts.
   */
  stage: z.enum(['unreachable', 'hostkey-unknown', 'hostkey-changed', 'auth-failed', 'no-zfs', 'ok']),
  /** Remote's zfs version when stage === 'ok'. */
  zfsVersion: z.string().optional(),
  /**
   * The host-key fingerprint SEEN: the pinned one for a host we already trust,
   * the freshly scanned one on 'hostkey-unknown' / 'hostkey-changed' (i.e. the
   * key the host presents NOW — the one an explicit confirm would trust).
   */
  fingerprint: z.string().optional(),
  /**
   * The fingerprint currently PINNED, on 'hostkey-changed' only. Paired with
   * `fingerprint` (old vs new) so the re-trust confirmation can show both —
   * re-trusting without showing what changed would defeat the pinning.
   */
  knownFingerprint: z.string().optional(),
  /** Human detail for the failure stages (stderr excerpt). */
  detail: z.string().optional(),
})
export type RemoteTestResult = z.infer<typeof RemoteTestResult>
