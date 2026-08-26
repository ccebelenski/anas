import { z } from 'zod'
import { DatasetPath, hasControlChars, ISODateTime, NotifyMode, PoolName, SingleLine, SnapshotName } from './common.js'

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
 * base carries a `zfs hold` (tag `anas-repl`) so cleanup cannot sever the
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
})
export type ReplicatePlan = z.infer<typeof ReplicatePlan>

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

/** A configured recurring replication (one systemd service+timer pair). */
export const ReplicationTask = z.object({
  name: ReplicationTaskName,
  /** Source dataset, pool-rooted ('' dataset = the pool root). */
  source: z.object({ pool: PoolName, dataset: ReplicationDataset }),
  target: ReplicationTarget,
  /** systemd OnCalendar expression (e.g. 'daily', '02:00', 'Mon *-*-* 03:00'). */
  schedule: z.string().min(1),
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
export type ReplicationTask = z.infer<typeof ReplicationTask>

/**
 * The LENIENT read-back form of ReplicationTask: the pool/dataset identity
 * fields relax to plain single-line strings (still control-char-free — they
 * flow into `zfs`/`ssh`/systemd argv on the read/status path) so a STORED task
 * whose dataset no longer passes the narrowed ReplicationDataset regex stays
 * parseable and VISIBLE (flagged `invalid`). Read path only; strict
 * ReplicationTask remains the create/update gate.
 */
export const LenientReplicationTask = ReplicationTask.extend({
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
})
export type ReplicationTaskStatus = z.infer<typeof ReplicationTaskStatus>

// ---- Stage 3: REMOTE replication (peers + external remotes) ------------------
//
// Remotes are a CLUSTER-level concept: the registry lives in pmxcfs at
// /etc/pve/anas/remotes.json (corosync-replicated; quorum-gated writes), the
// cluster-wide keypair at /etc/pve/priv/anas/replication_key, pinned host keys
// in /etc/pve/priv/anas/known_hosts. The remote itself needs sshd + ZFS only.

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

/** Create/update a remote — carries the registry version the client read. */
export const UpsertRemoteRequest = z.object({
  remote: ReplicationRemote,
  /** CAS guard: the registry version this change was based on. */
  expectedVersion: z.number().int().nonnegative(),
})
export type UpsertRemoteRequest = z.infer<typeof UpsertRemoteRequest>

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
