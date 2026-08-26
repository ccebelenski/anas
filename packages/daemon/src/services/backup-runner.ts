import type {
  AhrPool,
  BackupArchiveConsistency,
  BackupExpandedArchive,
  BackupNestedScan,
  BackupPruneResult,
  BackupRepo,
  BackupRepoTestResult,
  BackupTask,
  BackupTransientSnapshot,
} from '@anas/shared'
import type { PeerCertificate } from 'node:tls'
import type { CommandExecutor } from '../executor/types.js'
import type { BackupSnapshotOptions, TakenSnapshot } from './backup-snapshots.js'
import type { ZvolSnapdevOptions } from './backup-zvol.js'
import { lookup } from 'node:dns/promises'
import { createConnection, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { archiveSpecType, effectiveArchiveKind, effectiveIncludeNested } from '@anas/shared'
import { readAhrPools } from './ahr-topology.js'
import { deriveConsistency, isZvolConsistency, readConsistencyFacts } from './backup-consistency.js'
import { planExpansion } from './backup-expansion.js'
import { backupTargetLine } from './backup-notify.js'
import {
  destroyTransients,
  plannedTopLevel,
  sweepAhrTransients,
  sweepZfsTransients,
  takeAhrTransient,
  takeZfsTransient,
  withTopLevelMounts,
} from './backup-snapshots.js'
import { withZvolSnapshotDevices } from './backup-zvol.js'
import { nestedRunWarnings, resolveNestedIncludes, scanArchives } from './nested-filesystems.js'
import { formatTransientBackupSnapshot } from './snapshot-naming.js'

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
export const PRLIMIT = '/usr/bin/prlimit'
/**
 * Wall-clock budget for the run-time boundary scan. Generous next to a backup
 * (which is minutes to hours) and still bounded — a truncated scan says so in
 * the warnings rather than pretending it found nothing.
 */
export const NESTED_SCAN_RUN_TIMEOUT_S = 60

/**
 * Per-archive stats / reuse line (parse by the filename token, not position).
 * `img` is here for backup2.4: an image archive prints the SAME two-line shape
 * (`<name>.img: had to backup …` and `<name>.img: backup was done
 * incrementally, reused …`, GT-35), so the notification body and the job
 * progress carry it exactly as they carry a pxar archive's.
 */
const ARCHIVE_LINE_RE = /^\S+\.(?:pxar|mpxar|ppxar|img):\s/
/** The metadata-mode preflight fd warning (metadata mode only). */
const NOFILE_WARNING_RE = /resource limit for open file handles low:\s*\d+/
/** The group line: `Starting backup: [ns]:host/<backup-id>/<ISO-timestamp>`. */
const STARTING_RE = /^Starting backup:/
/**
 * `Upload directory '<root>' to '<repo>' as <name>.pxar.didx` — the line that
 * says which archive the following skip lines belong to (real capture:
 * `backup-multi-archive.txt`, `btrfs-nested-subvol.txt`).
 */
const UPLOAD_DIR_RE = /^Upload directory '(.+?)' to '.*' as (\S+?)\.(?:pxar|mpxar|ppxar)\.didx$/
/**
 * The `img` counterpart (backup2.4, real capture `img-backup.txt`):
 * `Upload image '<source>' to '<repo>' as <name>.img.fidx` — a FIXED-index
 * upload, not a dynamic one, which is the whole difference between a chunked
 * tree and a 4 MiB-chunked block image. It names which source became which
 * archive, and it is the only place the run says so.
 */
const UPLOAD_IMAGE_RE = /^Upload image '(.+?)' to '.*' as (\S+?)\.img\.fidx$/
/**
 * The client's own boundary report: `skipping mount point: "<path>"` — quoted,
 * unescaped, ARCHIVE-ROOT-RELATIVE, one per omitted filesystem (GT-54). This is
 * the SECONDARY signal; ANAS's own st_dev walk is the authoritative one.
 */
const SKIPPING_MOUNT_RE = /^skipping mount point:\s*"(.*)"\s*$/
const DURATION_RE = /^Duration:/
/** The benign 1-second-resolution collision from a Run-Now just after a run. */
const TOO_SOON_RE = /backup timestamp is older than last backup/i
/** A backup GROUP is owned by one auth-id; a different auth-id is refused. */
const OWNER_MISMATCH_RE = /backup owner check failed/i
/** Trailing whitespace on a pbc output line (they end with padding spaces). */
const TRAILING_WS_RE = /\s+$/
/** Leading `sha256:`/`sha256=` prefix stripped when normalizing a fingerprint. */
const SHA256_PREFIX_RE = /^sha256[:=]?/i
/** Trailing slashes on an archive root (joining a client skip path onto it). */
const TRAILING_SLASHES_RE = /\/+$/
/** Leading slashes on the client's archive-relative skip path. */
const LEADING_SLASHES_RE = /^\/+/

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
 * `--backup-id`, optional `--ns`, the metadata mode flag, and the
 * nested-filesystem flags (backup2.2).
 *
 * `includeNested` reaches pbc in exactly ONE form — `--include-dev <path>`:
 *   `none`     → no flag (the client's own behaviour: one filesystem only)
 *   `[paths]`  → one `--include-dev` per stored path
 *   `all`      → one `--include-dev` per boundary the run-time scan RESOLVED
 *                for that archive (`resolveNestedIncludes`), passed here in
 *                `resolvedNested`
 *
 * **`--all-file-systems` is never emitted.** It is a per-INVOCATION flag and
 * ANAS puts every archive of a task in one `backup` call, so it would silently
 * apply one archive's choice to all the others — the per-archive control the
 * wizard shows would not be the contract pbc receives. Resolving `all` into
 * explicit paths says the same thing with the intended scope and leaves the
 * other archives alone.
 *
 * Paths are deduplicated across archives (two archives naming the same boundary
 * are one device to pbc), and emitted in a stable sorted order so the same task
 * always produces the same argv.
 *
 * `namespace` overrides the task's when supplied — the caller resolves the
 * EFFECTIVE namespace (task's, else the repo's) so a repo that already carries a
 * namespace (e.g. a PVE-defined `pbs` storage with `namespace anastest`) needs
 * zero re-entry on the task, matching the test path which probes `repo.namespace`.
 */
export function buildBackupArgs(
  task: BackupTask,
  namespace?: string,
  resolvedNested: Record<string, string[]> = {},
  expansion?: BackupExpandedArchive[],
): string[] {
  const args: string[] = ['backup']
  // backup2.3 — when the run is snapshot-consistent, the archive list is the
  // EXPANSION (one root per nested filesystem), not the stored archives. The
  // root archive's NAME and the `--backup-id` below are unchanged either way:
  // that pair is pbc's change-detection identity, and GT-47/48 proved a switch
  // between the live root and the snapshot root costs nothing as long as it
  // holds.
  const roots: { name: string, path: string, excludes: string[], kind: string }[] = expansion?.length
    ? expansion.map(e => ({ name: e.name, path: e.root, excludes: e.excludes, kind: archiveSpecType(e.kind ?? 'pxar') }))
    : task.archives.map(a => ({ name: a.name, path: a.path, excludes: a.excludes, kind: archiveSpecType(effectiveArchiveKind(a)) }))
  // backup2.4 — the archive spec's TYPE token is what tells pbc whether the
  // source is a tree (`<name>.pxar:<dir>`) or a fixed-chunk block image
  // (`<name>.img:<device-or-file>`). A regular file is a first-class `.img`
  // source: no loop device, no `losetup` (GT-34).
  for (const a of roots)
    args.push(`${a.name}.${a.kind}:${a.path}`)
  // `--exclude` is a per-INVOCATION flag (Epic 16's finding, unchanged here), so
  // the union is emitted once, deduplicated — a pattern repeated across two
  // expanded roots of the same archive is one flag, not two.
  const excludes = new Set<string>()
  for (const a of roots) {
    for (const pattern of a.excludes) {
      if (excludes.has(pattern))
        continue
      excludes.add(pattern)
      args.push('--exclude', pattern)
    }
  }
  args.push('--backup-id', task.backupId)
  const ns = namespace ?? task.namespace
  if (ns)
    args.push('--ns', ns)
  // `--change-detection-mode` is a COMPLETE NO-OP for an `.img` archive (GT-37:
  // byte-identical output shape, no mpxar/ppxar split, no change-detection
  // summary), so a task whose archives are ALL images does not get the flag at
  // all — an argv that claims a mode nothing will honour is a lie in the unit
  // and in journald. A mixed task still emits it once, for its pxar archives;
  // the image archives ignore it exactly as pbc does.
  if (task.changeDetectionMode === 'metadata' && roots.some(a => a.kind !== 'img'))
    args.push('--change-detection-mode=metadata')

  const devs = new Set<string>()
  for (const a of task.archives) {
    const choice = effectiveIncludeNested(a)
    // On a SNAPSHOT-CONSISTENT run `resolvedNested` is the COMPLETE include-dev
    // map: an archive that was expanded is absent from it and contributes no
    // flag at all. That is not an optimisation — under a `.zfs/snapshot/<s>/`
    // root the boundary is an EMPTY DIRECTORY on the snapshot's own device, so
    // `--include-dev` there names nothing; the child came along as its own
    // archive root instead (backup2.3).
    //
    // On a live run `all` is only ever as good as the scan that resolved it;
    // with no resolution (a scan that failed, or a caller with nothing to hand
    // over) the archive gets NO flag and the client default stands — never a
    // guessed subset.
    const paths = expansion?.length
      ? (resolvedNested[a.name] ?? [])
      : (choice === 'all'
          ? (resolvedNested[a.name] ?? [])
          : (Array.isArray(choice) ? choice : []))
    for (const p of paths)
      devs.add(p)
  }
  // Sorted in place on an array we own, so the same task always yields the same
  // argv (a stable argv keeps unit diffs and journald lines comparable).
  const ordered = [...devs]
  ordered.sort()
  for (const p of ordered)
    args.push('--include-dev', p)
  return args
}

/**
 * The EFFECTIVE namespace for a task against a repo: the task's if set, else the
 * repo's own (a PVE-defined storage often carries one — zero re-entry, 16.8).
 * The ONE place that fallback is expressed; the backup argv, the prune argv and
 * the test path all read it from here.
 */
export function effectiveNamespace(task: BackupTask, repo: BackupRepo): string | undefined {
  return task.namespace ?? repo.namespace
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

/** One `skipping mount point:` line, attributed to the archive it followed. */
export interface SkippedMountPoint {
  /** The archive name from the preceding `Upload directory … as <name>` line. */
  archive?: string
  /** The archive root that line named (so the path can be made absolute). */
  root?: string
  /** The path pbc printed — relative to the archive root. */
  relativePath: string
  /** `<root>/<relativePath>` when the root is known; the relative path otherwise. */
  path: string
}

/** One `Upload image … as <name>.img.fidx` line (backup2.4). */
export interface UploadedImage {
  /** The archive name from the line (`<name>` of `<name>.img.fidx`). */
  archive: string
  /** The device or file pbc actually read — a snapshot device in snapshot mode. */
  source: string
}

export interface BackupProgress {
  /** The `Starting backup: …` group line, if seen. */
  target: string | null
  /** Per-archive `had to backup / reused / incremental` lines (any archive kind). */
  archiveStats: string[]
  /**
   * The image archives this run uploaded, in argv order (backup2.4). Reported
   * separately from `archiveStats` because the `Upload image` line names the
   * SOURCE — and in snapshot mode that is the snapshot device, which is the one
   * fact that proves the run did not read the live volume.
   */
  images: UploadedImage[]
  /** The metadata `Change detection summary:` block (header + ` - …` lines). */
  changeDetectionSummary: string[]
  /** The metadata-only `resource limit for open file handles low: N` line. */
  nofileWarning: string | null
  /** The `Duration: …` line, if seen. */
  duration: string | null
  /** Filesystem boundaries the CLIENT reported skipping (backup2.2, secondary). */
  skipped: SkippedMountPoint[]
}

/** Parse pbc STDERR into the progress units (per-archive stats + summary block). */
export function parseBackupProgress(stderr: string): BackupProgress {
  const progress: BackupProgress = {
    target: null,
    archiveStats: [],
    images: [],
    changeDetectionSummary: [],
    nofileWarning: null,
    duration: null,
    skipped: [],
  }
  const lines = stderr.split('\n')
  let inSummary = false
  // Which archive the `skipping mount point:` lines below belong to: the client
  // prints one `Upload directory … as <name>.pxar.didx` header per archive and
  // the skips follow it (real capture, backup-multi-archive + btrfs-nested).
  let currentArchive: string | undefined
  let currentRoot: string | undefined
  for (const raw of lines) {
    const line = raw.replace(TRAILING_WS_RE, '')
    const trimmed = line.trim()
    if (!trimmed)
      continue
    const upload = trimmed.match(UPLOAD_DIR_RE)
    if (upload) {
      currentRoot = upload[1]
      currentArchive = upload[2]
      continue
    }
    const image = trimmed.match(UPLOAD_IMAGE_RE)
    if (image) {
      // An image archive has no tree, so no `skipping mount point:` line can
      // belong to it — the skip attribution is deliberately left where the last
      // DIRECTORY upload put it rather than pointed at an image.
      progress.images.push({ archive: image[2], source: image[1] })
      continue
    }
    const skip = trimmed.match(SKIPPING_MOUNT_RE)
    if (skip) {
      const relativePath = skip[1]
      progress.skipped.push({
        ...(currentArchive ? { archive: currentArchive } : {}),
        ...(currentRoot ? { root: currentRoot } : {}),
        relativePath,
        path: currentRoot ? joinUnder(currentRoot, relativePath) : relativePath,
      })
      continue
    }
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

/** `<root>/<relative>` with exactly one separator (root may be `/`). */
function joinUnder(root: string, relative: string): string {
  const base = root.replace(TRAILING_SLASHES_RE, '')
  const rel = relative.replace(LEADING_SLASHES_RE, '')
  return `${base}/${rel}`
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
  /**
   * backup2.3 test seam: the clock the transient snapshot's name and the stale
   * sweep's cutoff are read from, and the AHR runtime dir. Absent = real time
   * and the real `/run/anas-ahr`.
   */
  now?: Date
  snapshotOptions?: BackupSnapshotOptions
  /**
   * backup2.4 test seam: how the `snapdev` publish checks for the snapshot
   * device node and how long it waits. Absent = a real `stat` and the real poll
   * budget.
   */
  snapdevOptions?: ZvolSnapdevOptions
  /**
   * backup2.4 test seam: where the consistency derivation reads PVE's
   * `storage.cfg` from (the zvol branch's hands-off guard). Absent = the real
   * `/etc/pve/storage.cfg`, fail-open when it is not there.
   */
  consistencyOptions?: { pveStorageCfg?: string }
}

export interface BackupRunResult {
  status: 'success' | 'skipped'
  /** The parsed target group line, when seen. */
  target?: string
  /** Per-archive stats lines (the job-progress units). */
  archives: string[]
  /**
   * backup2.4 — the image archives this run uploaded and the SOURCE each was
   * read from. In snapshot mode that source is the snapshot's own device node,
   * which is the record that the run did not read the live volume.
   */
  images?: UploadedImage[]
  /** Present when pbc emitted the metadata-mode low-fd warning. */
  nofileWarning?: string
  /** pbc's own `Duration: …` line, when it printed one (16.12's honest timing). */
  duration?: string
  /** Present for a benign too-soon skip (explains why it did nothing). */
  reason?: string
  /** Retention prune counts, when the task configured one and it ran (16.11). */
  prune?: BackupPruneResult
  /**
   * Completed-with-warning detail — a prune that failed AFTER a successful
   * backup never fails the job (the data is safe); it rides here instead, as do
   * this story's nested-filesystem omissions (backup2.2). They flow verbatim
   * into the 16.12 notification body and the task detail.
   */
  warnings?: string[]
  /** The run-time boundary scan, per archive (backup2.2). */
  nested?: BackupNestedScan[]
  /**
   * Archive name → the filesystem boundaries this run actually crossed (the
   * `--include-dev` paths). What `all` RESOLVED to is a fact about the run, not
   * about the config, so it is reported here rather than inferred from the task.
   */
  includedNested?: Record<string, string[]>
  /**
   * backup2.3 — the DERIVED consistency of each archive source, in task order.
   * A fact about the system at run time, never a setting.
   */
  consistency?: BackupArchiveConsistency[]
  /**
   * The transient snapshots this run took. All of them were destroyed in the
   * run's `finally` by the time this result exists — they are reported so the
   * record says what the backup was actually read FROM.
   */
  snapshots?: BackupTransientSnapshot[]
  /**
   * The expansion: one entry per archive root pbc was handed. The root entry of
   * each archive keeps the configured name (change-detection continuity); the
   * children carry the derived `<name>__<child>` names.
   */
  expansion?: BackupExpandedArchive[]
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

  // The fd cap must bind pbc ITSELF: pbc execs inside anasd (nofile 524288 —
  // Node raises soft→hard), not in the task unit's cgroup, so the unit's
  // LimitNOFILE= never reaches it. Hence prlimit around the exec: without the
  // cap pbc hoards handles — worst in metadata mode — until the network
  // stack degrades.
  const nofile = task.limitNofile ?? 1024
  // Same un-doubled target rendering as the notification body (a pve-sourced
  // repo is NAMED pve:<datastore>, so a blind `:datastore` suffix duplicates).
  updateProgress(`starting backup ${task.name} -> ${backupTargetLine({ task, repo })}`)

  // backup2.2 — the AUTHORITATIVE boundary pass, BEFORE the client runs. Our own
  // st_dev walk is primary because it names what will be omitted (and can say a
  // btrfs subvolume is one); the client's `skipping mount point:` lines below are
  // the secondary confirmation. Both are captured and deduplicated by path.
  // It is ALSO what makes `all` concrete: the walk descends through the
  // boundaries an `all` archive is including, and every one it finds becomes an
  // explicit `--include-dev` for THAT archive only.
  // Fail-open: the scan never fails a backup — it only ever adds warnings.
  const scanned = await scanArchives(executor, task.archives, { timeoutSeconds: NESTED_SCAN_RUN_TIMEOUT_S })
  const resolution = resolveNestedIncludes(task.archives, scanned)
  const warnings: string[] = [...nestedRunWarnings(resolution.scans), ...resolution.warnings]

  // backup2.3 — the DERIVED consistency of every source, from the mount table
  // plus the live AHR topology. Read once for the whole task; both probes fail
  // open to `live` with a stated reason, so a derivation that cannot see the
  // system NEVER claims a snapshot it did not take.
  const facts = await readConsistencyFacts(executor, readAhrPools, deps.consistencyOptions ?? {})
  const consistency = task.archives.map(a => deriveConsistency(a.path, facts))
  // The scans carry it to the screens (one endpoint, not two — the two answers
  // come from the same mount table).
  const scans = resolution.scans.map((scan, i) => ({ ...scan, consistency: consistency[i] }))

  const snapshotMode = consistency.some(c => c.consistency === 'snapshot')
  for (let i = 0; i < task.archives.length; i++)
    updateProgress(`archive '${task.archives[i].name}': ${consistency[i].consistency} - ${consistency[i].reason}`)

  // `--include-dev` is meaningless under a snapshot root: the boundary directory
  // is captured by the snapshot as an EMPTY DIRECTORY, so there is no foreign
  // device there for pbc to be told about. Snapshot-mode archives therefore
  // carry no include-dev at all — their included children become archive roots
  // of their own (the expansion), and the ones that cannot be snapshotted are
  // named in a warning by the planner. Live archives keep backup2.2 verbatim.
  const liveIncludes: Record<string, string[]> = {}
  for (let i = 0; i < task.archives.length; i++) {
    if (consistency[i].consistency !== 'snapshot')
      liveIncludes[task.archives[i].name] = resolution.byArchive[task.archives[i].name] ?? []
  }

  // Effective namespace: the task's if set, else the repo's (zero re-entry for a
  // repo that already carries one, e.g. a PVE-defined storage). Mirrors the test
  // path, which probes repo.namespace.
  const namespace = effectiveNamespace(task, repo)

  // Say on the record exactly which boundaries this run crossed — journald gets
  // it from the job progress, and it rides the 16.12 notification body.
  const includedNested = includedNestedOf(liveIncludes)
  for (const [archive, paths] of Object.entries(includedNested))
    updateProgress(`archive '${archive}': crossing ${paths.length} filesystem boundary/boundaries - ${paths.join(' ')}`)

  const now = deps.now ?? new Date()
  const snapshotOptions = deps.snapshotOptions
  const taken: TakenSnapshot[] = []
  let expansion: BackupExpandedArchive[] = []
  // Definitely assigned by the time it is read: every branch below either sets
  // it or throws (the `finally` re-raises after destroying the snapshots).
  let r!: { exitCode: number, stderr: string }

  const exec = async (args: string[]): Promise<{ exitCode: number, stderr: string }> =>
    executor.exec(PRLIMIT, [`--nofile=${nofile}:${nofile}`, '--', PBC, ...args], { env })

  if (!snapshotMode) {
    r = await exec(buildBackupArgs(task, namespace, liveIncludes))
  }
  else {
    // ---- Snapshot-consistent run ----------------------------------------
    // Order matters and is load-bearing:
    //   1. sweep this task's OWN stale transients (a previous run that died
    //      before its `finally`) — never another task's, which may be running;
    //   2. take the snapshots (all of them, before any top-level mount, because
    //      `withTopLevelMount` serialises per pool and would deadlock on itself);
    //   3. plan the expansion and build the argv from it;
    //   4. hold every AHR pool's top-level mount open across the ONE pbc call;
    //   5. destroy everything in a `finally`, mounts already released.
    const zfsTargets = distinctZfsTargets(consistency)
    const ahrTargets = distinctAhrTargets(consistency, facts.ahrPools)

    for (const dataset of zfsTargets)
      warnings.push(...await sweepZfsTransients(executor, dataset, task.name, now, updateProgress))
    for (const pool of ahrTargets)
      warnings.push(...await sweepAhrTransients(executor, pool, task.name, now, updateProgress, snapshotOptions))

    const label = formatTransientBackupSnapshot(task.name, now)
    try {
      for (const dataset of zfsTargets) {
        updateProgress(`snapshotting ${dataset}@${label} (recursive)`)
        taken.push(await takeZfsTransient(executor, dataset, label))
      }
      for (const pool of ahrTargets) {
        updateProgress(`snapshotting AHR pool '${pool.name}' as @snapshots/${label}`)
        taken.push(await takeAhrTransient(executor, pool, label, undefined, updateProgress, snapshotOptions))
      }

      const plans = task.archives.map((archive, i) => planExpansion({
        archive,
        consistency: consistency[i],
        scan: scans[i],
        snapshot: label,
        ...(consistency[i].backend === 'ahr' && consistency[i].target
          ? { topLevel: plannedTopLevel(poolOf(consistency[i].target as string, ahrTargets) as AhrPool, snapshotOptions) }
          : {}),
      }))
      for (const plan of plans)
        warnings.push(...plan.warnings)
      expansion = plans.flatMap(p => p.archives)

      // GT-52/55: a single ro btrfs snapshot leaves every nested subvolume an
      // EMPTY placeholder that no client flag can rescue — so each included one
      // gets its own snapshot before the run reads anything.
      for (let i = 0; i < plans.length; i++) {
        const pool = poolOf(consistency[i].target ?? '', ahrTargets)
        if (!pool)
          continue
        for (const sub of plans[i].ahrSubvolumeSnapshots) {
          updateProgress(`snapshotting nested subvolume @data/${sub.subvolume} as @snapshots/${sub.label}`)
          taken.push(await takeAhrTransient(executor, pool, sub.label, sub.subvolume, updateProgress, snapshotOptions))
        }
      }

      const args = buildBackupArgs(task, namespace, liveIncludes, expansion)
      for (const e of expansion)
        updateProgress(`archive '${e.name}' <- ${e.root}`)

      // backup2.4 — a snapshotted ZVOL's device node does not exist until
      // `snapdev` publishes it (GT-43), so the publish wraps the ONE pbc call
      // and the property is put back with `zfs inherit` (or its exact prior
      // local value) in that helper's own `finally`, whatever happens here.
      // Deduplicated by volume: two archives of the same zvol are one property
      // change and one restore, never two.
      const byVolume = new Map<string, { volume: string, device: string, label: string }>()
      for (const c of consistency.filter(isZvolConsistency))
        byVolume.set(c.target as string, { volume: c.target as string, device: c.zvolDevice as string, label })
      const zvolSources = [...byVolume.values()]
      const runPbc = async (): Promise<{ exitCode: number, stderr: string }> =>
        ahrTargets.length
          ? withTopLevelMounts(executor, ahrTargets, async () => exec(args), snapshotOptions)
          : exec(args)

      r = await withZvolSnapshotDevices(executor, zvolSources, runPbc, warnings, updateProgress, deps.snapdevOptions)
    }
    finally {
      // Success, failure or timeout alike. Destroy failures are warnings on an
      // otherwise-good run; they never turn a completed backup into a failed job.
      warnings.push(...await destroyTransients(executor, taken, updateProgress, snapshotOptions))
    }
  }

  const progress = parseBackupProgress(r.stderr)
  const summary = progressSummary(progress)
  if (summary)
    updateProgress(summary)

  const outcome = classifyBackupResult(r.exitCode, r.stderr)
  if (outcome.kind === 'failure') {
    const prefix = outcome.owner
      // ASCII only: this text becomes the run job's error and is embedded
      // verbatim in the notification body (see backup-notify's ASCII rule).
      ? 'backup owner mismatch - this backup-id is owned by a different auth-id; '
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
  if (progress.duration)
    result.duration = progress.duration
  if (progress.images.length)
    result.images = progress.images
  if (outcome.kind === 'too-soon')
    result.reason = 'snapshot timestamp collision (1-second resolution) - nothing new to back up yet'

  // The SECONDARY signal: whatever the client itself reported skipping and our
  // own walk did not already name. Deduplicated by absolute path so one
  // omission is one warning, never two (backup2.2).
  for (const line of skippedWarnings(progress.skipped, scans))
    warnings.push(line)
  if (scans.length)
    result.nested = scans
  if (Object.keys(includedNested).length)
    result.includedNested = includedNested
  // backup2.3, on the record: what each source's consistency was DERIVED to be,
  // which transient snapshots existed while the run read, and which archive
  // roots pbc was actually handed.
  if (consistency.length)
    result.consistency = consistency
  if (taken.length)
    result.snapshots = taken.map(({ pool: _pool, ...rest }) => rest)
  if (expansion.length)
    result.expansion = expansion
  if (warnings.length)
    result.warnings = warnings
  return result
}

/**
 * The distinct ZFS datasets one recursive snapshot each must cover. A dataset
 * that is a DESCENDANT of another in the set is dropped: `zfs snapshot -r` on
 * the ancestor already gave it the same label, and a second `-r` on the
 * descendant would fail with "dataset already exists". Destroying the ancestor
 * recursively takes the descendant's copy with it, so the lifecycle stays whole.
 */
export function distinctZfsTargets(consistency: BackupArchiveConsistency[]): string[] {
  const names = new Set<string>()
  for (const c of consistency) {
    if (c.consistency === 'snapshot' && c.backend === 'zfs' && c.target)
      names.add(c.target)
  }
  // Two steps on an array we own: `[...x].sort()` trips the lint rule that wants
  // `toSorted()`, which this package's TS lib target does not have. Same pattern
  // the include-dev ordering above already uses.
  const all = [...names]
  all.sort()
  return all.filter(ds => !all.some(other => other !== ds && ds.startsWith(`${other}/`)))
}

/** The distinct AHR pools involved, resolved against the live topology. */
export function distinctAhrTargets(consistency: BackupArchiveConsistency[], pools: AhrPool[]): AhrPool[] {
  const names = new Set<string>()
  for (const c of consistency) {
    if (c.consistency === 'snapshot' && c.backend === 'ahr' && c.target)
      names.add(c.target)
  }
  const ordered = [...names]
  ordered.sort()
  return ordered.flatMap((name) => {
    const pool = pools.find(p => p.name === name)
    return pool ? [pool] : []
  })
}

/** One resolved AHR pool by name (undefined when the archive is not on AHR). */
function poolOf(name: string, pools: AhrPool[]): AhrPool | undefined {
  return name ? pools.find(p => p.name === name) : undefined
}

/** Drop the archives that cross nothing — an empty list is not a fact worth showing. */
function includedNestedOf(byArchive: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [archive, paths] of Object.entries(byArchive)) {
    if (!paths.length)
      continue
    const ordered = [...paths]
    ordered.sort()
    out[archive] = ordered
  }
  return out
}

/**
 * Turn the client's own `skipping mount point:` lines into warnings, DROPPING
 * every one our detection already named. A skip line the walk missed is the
 * interesting one — it means reality moved between the scan and the run, or the
 * walk was truncated.
 *
 * Matched on the ARCHIVE-RELATIVE path as well as the absolute one, because in
 * snapshot mode (backup2.3) the two absolute paths are never equal: the walk
 * names the live boundary (`/mnt/anas-ahr/lpahr/photos`) while the client is
 * reading the transient snapshot and prints
 * `/run/anas-ahr/<pool>.toplevel/@snapshots/anas-backup-…/photos` — and on ZFS,
 * `<mountpoint>/.zfs/snapshot/<s>/…`. Live-proof wave 2 caught the consequence:
 * an AHR source with `includeNested: all`, whose nested subvolume was EXPANDED
 * into its own archive and fully backed up, still reported "it was stored as an
 * empty directory" on every run — so the run was permanently
 * completed-with-warnings and the 16.12 notification permanently `warning`,
 * which is exactly what choosing `all` is supposed to stop. The relative path is
 * the same string on both sides because expansion preserves the tree.
 *
 * Suppressing here loses nothing: ANAS's own detection is the authoritative
 * warning (an uncovered nested filesystem gets its own "is NOT included" line
 * from `nestedRunWarnings`, and the whole scan rides in `result.nested`).
 */
export function skippedWarnings(
  skipped: SkippedMountPoint[],
  scans: BackupNestedScan[],
): string[] {
  const known = new Set<string>()
  for (const scan of scans) {
    for (const n of scan.nested) {
      known.add(n.path)
      known.add(n.relativePath)
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of skipped) {
    if (known.has(s.path) || known.has(s.relativePath) || seen.has(s.path))
      continue
    seen.add(s.path)
    const who = s.archive ? `archive '${s.archive}'` : 'the backup'
    out.push(`${who}: the client skipped mount point "${s.relativePath}" (${s.path}) - it was stored as an empty directory`)
  }
  return out
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
    // TLS ServerName must be a DNS name — Node throws synchronously on an IP
    // (ERR_INVALID_ARG_VALUE), which would escape this promise as a rejection
    // and turn a repo test against `server <ip>` into a 500 (#44).
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, servername: isIP(host) ? undefined : host }, () => {
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
