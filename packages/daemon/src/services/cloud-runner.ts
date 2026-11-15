import type { AhrPool, BackupArchiveConsistency, CloudRunDetail, CloudRunRecentEvent, CloudSyncRunResult, CloudSyncTask } from '@anas/shared'
import type { DeadlineOptions } from '../executor/deadline.js'
import type { CommandExecutor, SpawnedChild } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import type { SubvolumeLstat } from './access-walk.js'
import type { BackupSnapshotOptions, TakenSnapshot } from './backup-snapshots.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { readdir, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { CLOUD_STATS_INTERVAL_SECS, isPathWithin } from '@anas/shared'
import { btrfsSubvolListArgs } from '../parsers/btrfs-subvol-list.js'
import { confirmedSubvolumesBelowMount } from './access-walk.js'
import { readAhrPools } from './ahr-topology.js'
import { deriveConsistency, readConsistencyFacts } from './backup-consistency.js'
import { snapshotRoot } from './backup-expansion.js'
import {
  destroyTransients,
  plannedTopLevel,
  sweepAhrTransients,
  sweepZfsTransients,
  takeAhrTransient,
  takeZfsTransient,
  withTopLevelMounts,
} from './backup-snapshots.js'
import { scanNestedFilesystems } from './nested-filesystems.js'
import { RCLONE, rcloneBaseArgs, remoteSecretValues } from './rclone-config.js'
import { assertNoSecretValues, maskSecretValues } from './secret-argv.js'
import { probeSharePath } from './share-path.js'
import { formatTransientCloudSnapshot, parseTransientCloudSnapshot } from './snapshot-naming.js'
import { guardSourcePath, readSourceGuardFacts } from './source-guard.js'

/**
 * Cloud sync RUN logic (story rclone.2) — the guards, the transient snapshot,
 * the one `rclone copy|sync` invocation, its JSON-log progress and the
 * exit-code policy. The backup runner's opposite number, built from the SAME
 * parts wherever the parts are the same: the consistency derivation, the
 * transient snapshot lifecycle, the boundary scan and the argv guard are all
 * the existing shared modules, called with cloud sync's own label prefix.
 *
 * Ground truth this is built on (DESIGN "Cloud sync — rclone", 2026-09-23,
 * rclone 1.60.1 — do NOT contradict):
 *   - `--use-json-log` emits ONE JSON object per line on STDERR, and one
 *     carrying a `stats` object at every `--stats` interval with `bytes`,
 *     `totalBytes`, `transfers`, `checks`, `deletes`, `errors`, `eta`, `speed`
 *     and `fatalError`. stdout stays empty.
 *   - A `sync` from an EMPTY source deletes the whole destination. That is the
 *     catastrophe this module guards up front; `copy` never deletes and has no
 *     such guard.
 *   - Exit codes: `0` and `9` (nothing to transfer) COMPLETE. Everything else
 *     fails — including `6`, "less serious errors", which means files are
 *     missing at the destination. A missing file is a failure, not a warning.
 *   - Every credential lives in the config file rclone is pointed at, so
 *     NOTHING secret is ever built into this argv.
 *   - ...but rclone (and the backend behind it) can ECHO a stored credential
 *     in its own error text. cr.55 (review 2026-10-16 M1): every string the
 *     run makes from rclone's stderr — the failure message that becomes
 *     `job.error` and the notification's Error block, the result's
 *     `errorLines`, the run detail's `recent` messages and `lastError` — is
 *     masked WHERE IT IS MADE against the remote's stored credentials
 *     (`remoteSecretValues`, transitive over wrapped remotes), one pass per
 *     boundary, after the raw text was read. The journal needs no mask of its
 *     own: the cloud-task runner prints the already-masked job record.
 */

/** rclone's "everything transferred" exit code. */
const EXIT_OK = 0
/** rclone's "nothing to transfer" exit code — a complete run that moved nothing. */
const EXIT_NOTHING_TO_TRANSFER = 9
/** "Less serious errors": some files did not make it. A FAILURE here (DESIGN). */
const EXIT_SOME_FILES_FAILED = 6

/**
 * The stats cadence. 5s (rclone.6 — was 30s): the run viewer, the task row's
 * tiny spark and the dashboard strip all move on it, and `speedSamples` is
 * 60 of these — the last 5 minutes of throughput. The journal noise it adds
 * costs nothing: the runner's log stream goes to the daemon's pipe, not
 * journald. The number lives in `@anas/shared` (`CLOUD_STATS_INTERVAL_SECS`)
 * beside the stalled rule that converts trailing zero samples into seconds —
 * the argv value and the rule cannot drift.
 */
const STATS_INTERVAL = `${CLOUD_STATS_INTERVAL_SECS}s`

/**
 * The executor's retention cap for an rclone run. The arithmetic that makes
 * 256 MiB the right generosity: at `--stats 5s` rclone writes about 5.75 MB
 * of stats JSON per day of run time (the 1.15 MB/day DESIGN ground truth for
 * `--stats 30s`, 2026-09-23, scaled by the cadence), so a 10 TB copy at
 * `--bwlimit 8M` (~15 days) writes ~90 MB — and dying at the 10 MiB default
 * with a half-copied destination would be the worst kind of failure. 256 MiB
 * covers ~45 days of stats plus the `-v` per-file events (one line each — a
 * million-file tree is ~200 MB, the one shape that approaches the cap). The
 * tee path retains none of it anyway (only the last 64 KiB tail); this cap
 * governs stdout, which is empty, and exists so a future stderr-retaining
 * path cannot reintroduce the death by default.
 */
export const RCLONE_MAX_BUFFER = 256 * 1024 * 1024

/**
 * The JSON-log + verbosity + stats flags every run carries. `-v` (rclone.6)
 * adds one JSON event per finished file — the `recent` ring's source — and
 * makes `--stats-log-level NOTICE` redundant for the stats themselves (they
 * appear at `-v` regardless), but it stays: one flag list for the run and the
 * preview (which shares this argv and simply ignores the per-file events) is
 * the point.
 */
export const RCLONE_LOG_ARGS = [
  '--use-json-log',
  '-v',
  '--stats',
  STATS_INTERVAL,
  '--stats-log-level',
  'NOTICE',
] as const

// ---------------------------------------------------------------------------
//  argv
// ---------------------------------------------------------------------------

/** `<remote>:<path>` as rclone takes it — an empty path IS the remote's root. */
export function rcloneDestination(task: Pick<CloudSyncTask, 'remote' | 'path'>): string {
  return `${task.remote}:${task.path}`
}

/**
 * The full rclone argv for one run. PURE, so the whole command a task would
 * issue is assertable without running anything.
 *
 * `--exclude` patterns are NOT rebased onto the snapshot root the way a pbc
 * exclude has to be: an rclone filter rule is relative to the source root by
 * definition, so the same pattern means the same thing whether the root is the
 * live tree or its snapshot.
 *
 * `dryRun` (the rclone.2 addendum's preview) appends `--dry-run` to the SAME
 * command a run would issue — one builder, no preview-specific argv copy.
 *
 * `excludes` (cr3 CLOUD-H3) are the nested-filesystem rules of a snapshot-mode
 * run ({@link nestedFilesystemExcludes}), after the task's own; the run and
 * its preview pass the same list. `oneFileSystem` (the preview of a
 * snapshot-mode run only) keeps rclone on the source's own filesystem, which
 * is what the snapshot the run reads holds.
 */
export function buildRcloneArgs(
  task: Pick<CloudSyncTask, 'mode' | 'remote' | 'path' | 'bwlimit' | 'excludes'>,
  configFile: string,
  source: string,
  opts: { dryRun?: boolean, excludes?: readonly string[], oneFileSystem?: boolean } = {},
): string[] {
  const args: string[] = [
    task.mode,
    source,
    rcloneDestination(task),
    ...rcloneBaseArgs(configFile),
    ...RCLONE_LOG_ARGS,
  ]
  if (task.bwlimit)
    args.push('--bwlimit', task.bwlimit)
  for (const pattern of task.excludes)
    args.push('--exclude', pattern)
  for (const pattern of opts.excludes ?? [])
    args.push('--exclude', pattern)
  if (opts.oneFileSystem)
    args.push('--one-file-system')
  if (opts.dryRun)
    args.push('--dry-run')
  return args
}

// ---------------------------------------------------------------------------
//  What the run reads (cr3 CLOUD-H3, CLOUD-M4, CLOUD-M6)
// ---------------------------------------------------------------------------

/** The characters rclone's filter glob gives a meaning; a backslash makes each literal. */
const RCLONE_GLOB_SPECIAL_RE = /[\\*?[\]{}]/g

/** `text` as a literal inside an rclone filter rule (every glob character escaped). */
export function rcloneGlobLiteral(text: string): string {
  return text.replace(RCLONE_GLOB_SPECIAL_RE, c => `\\${c}`)
}

/**
 * The filter rules that keep the nested filesystems under `root` out of a
 * snapshot-mode run (cr3 CLOUD-H3). A snapshot holds ONE filesystem: each
 * nested one is an EMPTY directory inside it, so a `sync` from the snapshot
 * deleted the destination's copy of every nested filesystem while the
 * preview, reading the live tree, said "would delete 0". rclone neither reads
 * nor deletes what a filter excludes (unless `--delete-excluded`, which ANAS
 * never passes), so one anchored rule per nested filesystem makes the run do
 * what every screen says in snapshot mode — nested filesystems are not
 * included — and leaves their copies at the destination as they are. (A LIVE
 * run reads through them and includes them: {@link nestedProgressLine}.) Paths outside `root`
 * name nothing under the source and are dropped.
 */
export function nestedFilesystemExcludes(root: string, nested: readonly string[]): string[] {
  const rules = new Set<string>()
  for (const path of nested) {
    const rel = posix.relative(root, path)
    if (rel === '' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel))
      continue
    rules.add(`/${rcloneGlobLiteral(rel)}/**`)
  }
  const sorted = [...rules]
  sorted.sort()
  return sorted
}

/** The top-level entries of the source that are nested filesystems (their own rule excludes them). */
function excludedTopLevelNames(root: string, nested: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const path of nested) {
    const rel = posix.relative(root, path)
    if (rel !== '' && !rel.startsWith('..') && !rel.includes('/'))
      names.add(rel)
  }
  return names
}

/**
 * What a cloud sync of `source` reads, decided ONCE for the run and its
 * preview alike (cr3 CLOUD-H3 / CLOUD-M4).
 */
export interface CloudSourceView {
  /**
   * The path the kernel reaches for the source — the source guard's bounded
   * `realpath -e` — or the path as written when that did not resolve. The
   * consistency and the nested filesystems are judged HERE (cr3 CLOUD-M4: a
   * symlinked source was snapshotted on the filesystem its TEXT names, while
   * rclone followed the link to the live data behind it).
   */
  real: string
  consistency: BackupArchiveConsistency
  /**
   * The nested filesystems under `real`, for DISPLAY (the progress line, the
   * result, the notification): the bounded boundary walk's list, joined in
   * snapshot mode with {@link excluded}.
   */
  nested: string[]
  /** Why the boundary walk could not see everything (a display WARNING, never a refusal), or null. */
  nestedUnknown: string | null
  /** The run reads a transient snapshot (and so excludes the nested filesystems). */
  snapshot: boolean
  /**
   * Snapshot mode: every nested filesystem under `real`, from COMPLETE,
   * hang-proof reads (review of cr3, finding 1): the mount table (every
   * mount target under the source) plus the source dataset's descendant
   * datasets (`zfs list`), or the AHR pool's nested subvolumes (`btrfs
   * subvolume list`). Never the bounded directory walk, whose depth and time
   * caps would refuse a healthy deep tree for ever.
   */
  excluded: string[]
  /** Why {@link excluded} could not be read (snapshot mode), or null. A sync is refused on it. */
  excludedUnknown: string | null
  /**
   * A nested filesystem whose name rclone cannot be told to leave out (a
   * control character: rclone encodes those names, so the generated rule
   * would not match) — the sentence naming it, or null. A sync is refused.
   */
  unexcludable: string | null
  /** The filter rules {@link nestedFilesystemExcludes} adds — snapshot mode only. */
  excludes: string[]
  /** The AHR pools the derivation read (the transient take resolves its pool here). */
  ahrPools: AhrPool[]
}

/** A path inside a ZFS snapshot directory (an automounted snapshot — never a nested filesystem of the tree). */
const ZFS_SNAPDIR_RE = /(?:^|\/)\.zfs\/snapshot(?:\/|$)/

/** A control character (or DEL): rclone's local backend encodes such a name. */
// eslint-disable-next-line no-control-regex -- the control characters ARE the thing detected
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/

const BTRFS = '/usr/bin/btrfs'
const ZFS_CANMOUNT_VALUES: ReadonlySet<string> = new Set(['on', 'off', 'noauto'])

const ZFS = '/usr/sbin/zfs'
/** The ZFS filesystem list the exclusion reads: name, mountpoint, canmount — tab separated (-H). */
export const ZFS_FILESYSTEMS_ARGS = ['list', '-H', '-o', 'name,mountpoint,canmount', '-t', 'filesystem'] as const

/**
 * `zfs list` of every filesystem, CHECKED (second review, E1): exit 0 with a
 * row that does not parse (three tab-separated fields, a canmount of on,
 * off or noauto), a non-zero exit, or a spawn that failed (ENOENT included)
 * is a FAILED complete read — never a short set.
 */
export async function readZfsFilesystemsChecked(executor: CommandExecutor): Promise<{ rows: { name: string, mountpoint: string, canmount: string }[] } | { problem: string }> {
  let r
  try {
    r = await executor.exec(ZFS, [...ZFS_FILESYSTEMS_ARGS])
  }
  catch (err) {
    return { problem: `zfs list could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (r.exitCode !== 0)
    return { problem: `zfs list exited ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]}` : ''}` }
  const rows: { name: string, mountpoint: string, canmount: string }[] = []
  for (const line of r.stdout.split('\n')) {
    if (line === '')
      continue
    const f = line.split('\t')
    if (f.length !== 3 || f[0] === '' || f[1] === '' || !ZFS_CANMOUNT_VALUES.has(f[2]!))
      return { problem: `zfs list answered a row that does not parse: ${JSON.stringify(line.slice(0, 120))}` }
    rows.push({ name: f[0]!, mountpoint: f[1]!, canmount: f[2]! })
  }
  return { rows }
}

/** The nested filesystems a snapshot of `real` leaves out, from the complete reads (exported for its test). */
export async function readExcludedNested(
  executor: CommandExecutor,
  real: string,
  consistency: BackupArchiveConsistency,
  facts: { mounts: Map<string, FindmntNode>, ahrPools: AhrPool[] },
  /** The subvolume confirmation's lstat (review R2); a test serves its own. */
  lstat?: SubvolumeLstat,
): Promise<{ excluded: { path: string, name: string }[], problem: string | null }> {
  const out = new Map<string, string>()
  const under = (path: string): boolean => path !== real && isPathWithin(real, path) && !ZFS_SNAPDIR_RE.test(path)
  // 1. The mount table (read from /proc/self/mountinfo by findmnt: it never
  //    hangs, and it lists every mount, however deep).
  for (const [target, node] of facts.mounts) {
    if (under(target))
      out.set(target, node.source || target)
  }
  // 2. The dataset tree / the pool's subvolumes: a nested filesystem that is
  //    not mounted right now (a locked encrypted child, one that failed to
  //    mount) is still not in the snapshot, and its copy at the destination
  //    must survive a sync too.
  if (consistency.backend === 'zfs' && consistency.target) {
    const table = await readZfsFilesystemsChecked(executor)
    if ('problem' in table)
      return { excluded: [], problem: table.problem }
    // Third review (D3): a list without the source's OWN dataset is not a
    // complete read (an empty answer included) — never a short set.
    if (!table.rows.some(r => r.name === consistency.target))
      return { excluded: [], problem: `zfs list answered no row for the source's dataset ${consistency.target}` }
    // Second review (E1): by MOUNTPOINT inside the source, for EVERY dataset
    // the list returns — a descendant or not, mounted or not. A dataset is a
    // separate filesystem at its mountpoint when it is, or would be, mounted
    // there: canmount=on and canmount=noauto are excluded; canmount=off is
    // NOT (it never mounts, so its directory holds the PARENT's data, which
    // the snapshot carries). A non-path mountpoint (legacy, none, -) names no
    // place: a legacy dataset that IS mounted is in the mount table above.
    for (const row of table.rows) {
      if (row.canmount !== 'off' && row.mountpoint.startsWith('/') && under(row.mountpoint))
        out.set(row.mountpoint, row.name)
    }
  }
  else if (consistency.backend === 'ahr' && consistency.target) {
    const pool = facts.ahrPools.find(p => p.name === consistency.target)
    if (!pool)
      return { excluded: [], problem: `AHR pool '${consistency.target}' is no longer resolvable` }
    let listed
    try {
      listed = await executor.exec(BTRFS, btrfsSubvolListArgs(pool.mountpoint))
    }
    catch (err) {
      return { excluded: [], problem: `btrfs subvolume list failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (listed.exitCode !== 0)
      return { excluded: [], problem: `btrfs subvolume list exited ${listed.exitCode}: ${listed.stderr.trim().split('\n')[0] ?? ''}` }
    // cr3.nodefix D2: placed on the pool's mount by the one shared reading
    // (the permission walk's): on the `subvol=/@data` mount a nested
    // subvolume prints as `sv`, never `@data/sv`, and the `@data/` prefix
    // this used to keep matched none of them — every nested subvolume was
    // left in the run, as an empty directory a sync deleted at the destination.
    const mount = facts.mounts.get(pool.mountpoint)
    if (!mount || mount.fstype !== 'btrfs')
      return { excluded: [], problem: `AHR pool '${pool.name}' is not mounted at ${pool.mountpoint} in the mount table` }
    // Review R2: each placement confirmed to be a subvolume root (a name
    // with a line break can forge a list line).
    const placed = await confirmedSubvolumesBelowMount(listed.stdout, mount, lstat)
    if ('problem' in placed)
      return { excluded: [], problem: `btrfs subvolume list ${placed.problem}` }
    for (const sub of placed.below) {
      if (under(sub.path))
        out.set(sub.path, `${pool.name}:${sub.subvol}`)
    }
  }
  const excluded = Array.from(out, ([path, name]) => ({ path, name }))
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { excluded, problem: null }
}

/**
 * Read the view: the consistency derivation on the real path (printed with
 * the configured one), in snapshot mode the COMPLETE nested set the run
 * excludes, and — when `walk` is asked for (the run, whose progress names the
 * nested filesystems in either mode) — the bounded boundary walk, for display
 * only. Never throws: what could not be read says so in its own field.
 */
export async function readCloudSourceView(
  executor: CommandExecutor,
  source: string,
  real: string,
  consistencyOptions: { pveStorageCfg?: string } = {},
  opts: { walk?: boolean } = {},
): Promise<CloudSourceView> {
  let walked: string[] = []
  let nestedUnknown: string | null = null
  if (opts.walk ?? true) {
    try {
      const scan = await scanNestedFilesystems(executor, real, { includeNested: 'none' })
      walked = scan.nested.map(n => n.path)
      if (!scan.exists || scan.truncated)
        nestedUnknown = scan.warnings.join('; ') || `the nested-filesystem scan of ${real} did not finish`
    }
    catch (err) {
      nestedUnknown = `the nested-filesystem scan of ${real} could not run: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const facts = await readConsistencyFacts(executor, readAhrPools, consistencyOptions)
  const consistency = deriveConsistency(real, facts, source)
  const snapshot = consistency.consistency === 'snapshot' && !!consistency.target
  let excluded: { path: string, name: string }[] = []
  let excludedUnknown: string | null = null
  if (snapshot) {
    const read = await readExcludedNested(executor, real, consistency, facts)
    excluded = read.excluded
    excludedUnknown = read.problem
  }
  const bad = excluded.find(e => CONTROL_CHAR_RE.test(posix.relative(real, e.path)))
  const unexcludable = bad
    ? `${source} syncs from a snapshot, and the nested filesystem ${JSON.stringify(bad.path)} (${bad.name}) has a control `
    + `character in its name, which rclone encodes - the run cannot leave it out, and a sync would delete its copy at `
    + `the destination, so the run is refused. Rename that mountpoint, or use copy mode`
    : null
  const display = new Set<string>([...walked, ...excluded.map(e => e.path)])
  const nested = [...display]
  nested.sort()
  return {
    real,
    consistency,
    nested,
    nestedUnknown,
    snapshot,
    excluded: excluded.map(e => e.path),
    excludedUnknown,
    unexcludable,
    excludes: snapshot ? nestedFilesystemExcludes(real, excluded.map(e => e.path)) : [],
    ahrPools: facts.ahrPools,
  }
}

/**
 * What happens to the nested filesystems under a source, said per mode (cr3,
 * operator ruling 2026-11-14 on the live-mode question: the run's coverage
 * stays, every message tells the truth). A SNAPSHOT holds one filesystem: the
 * nested ones are not included, and the run excludes them, so their copies at
 * the destination are left as they are. A LIVE copy reads through them: they
 * are included. One wording for the run's progress line and the notification.
 */
export const NESTED_SNAPSHOT_NOTE = 'a snapshot holds one filesystem; their copies at the destination are left as they are'
export const NESTED_LIVE_NOTE = 'a live copy reads through them'

/** The run's progress line naming the nested filesystems, per mode. */
export function nestedProgressLine(source: string, nested: readonly string[], snapshot: boolean): string {
  return snapshot
    ? `${nested.length} nested filesystem(s) under ${source} are not included (${NESTED_SNAPSHOT_NOTE}): ${nested.join(' ')}`
    : `${nested.length} nested filesystem(s) under ${source} are included (${NESTED_LIVE_NOTE}): ${nested.join(' ')}`
}

/**
 * The refusal of a snapshot-mode SYNC whose nested filesystems could not be
 * listed from the complete reads (cr3 CLOUD-H3, as corrected by the review):
 * each one missed is an empty directory in the snapshot, and a sync would
 * delete its copy at the destination. A copy never deletes, so only a sync is
 * refused. `why` names the read that failed (the mount table, `zfs list`,
 * `btrfs subvolume list`) — never the bounded walk's caps.
 */
export function nestedUnknownRefusal(source: string, why: string): string {
  return `${source} syncs from a snapshot, which holds no nested filesystem, and the nested filesystems `
    + `under it could not be listed (${why}) - a sync would delete the destination's copy of each, `
    + `so the run is refused until that read works. Use copy mode meanwhile`
}

/**
 * Why a snapshot-mode SYNC of this view must not run, or null: the complete
 * nested read failed ({@link nestedUnknownRefusal}), or a nested name cannot
 * be left out. A copy never deletes and is never refused here. The run and
 * the preview ask this ONE question.
 */
export function snapshotSyncRefusal(view: CloudSourceView, source: string, mode: string): string | null {
  if (!view.snapshot || mode !== 'sync')
    return null
  if (view.excludedUnknown !== null)
    return nestedUnknownRefusal(source, view.excludedUnknown)
  return view.unexcludable
}

/**
 * cr3 CLOUD-M6: does the source's filesystem answer at all? The bounded
 * `timeout 2 stat -f` the shares family probes with (share-path.ts), run
 * BEFORE any in-process read of the source: a source on a hard NFS mount
 * whose server is down passes the unmounted-mount guard (it IS mounted), and
 * an in-process `stat` would then block one of libuv's four pool threads
 * until the server came back. Only `not-answering` refuses; every other
 * answer leaves the existence checks to say what is wrong.
 */
export async function sourceNotAnsweringRefusal(executor: CommandExecutor, source: string): Promise<string | null> {
  const probe = await probeSharePath(executor, source)
  if (probe.state !== 'not-answering')
    return null
  return `${source} did not answer (${probe.detail ?? 'no reply'}) - the filesystem it is on is not responding, `
    + `so it is not read`
}

// ---------------------------------------------------------------------------
//  The JSON log
// ---------------------------------------------------------------------------

/** One `stats` object as rclone emits it (absent fields read as 0). */
export interface RcloneStats {
  bytes: number
  totalBytes: number
  transfers: number
  /** rclone.6 — the destination-side total, for the viewer's files bar. */
  totalTransfers: number
  checks: number
  totalChecks: number
  deletes: number
  errors: number
  elapsedTime: number
  /**
   * Seconds remaining, as rclone estimates them — parsed verbatim and used
   * only for the progress TEXT ("ETA 45s"), never for the run detail's `eta`
   * (review batch A 2026-09-25: rclone's averaging loop can freeze mid-run).
   */
  eta: number | null
  fatalError: boolean
  /**
   * rclone.6 — bytes/second, as the stats object reports it. Parsed verbatim
   * but NOT displayed: it is an exponentially weighted average that decays
   * toward zero without reaching it on a stall and stops being averaged once
   * only checks remain, so the detail derives its own samples from the byte
   * deltas instead (review batch A, 2026-09-25).
   */
  speed: number
  /**
   * rclone.6 — the in-flight files the object names, verbatim from
   * `transferring[]` (at most one per `--transfers` worker). Parsed for the
   * run viewer; the result-building path ignores it.
   */
  transferring: RcloneTransferringFile[]
}

/** One in-flight file, as a stats object's `transferring[]` carries it. */
export interface RcloneTransferringFile {
  name: string
  size: number
  bytes: number
  percentage: number
  speed: number
  eta: number | null
}

const ZERO_STATS: RcloneStats = {
  bytes: 0,
  totalBytes: 0,
  transfers: 0,
  totalTransfers: 0,
  checks: 0,
  totalChecks: 0,
  deletes: 0,
  errors: 0,
  elapsedTime: 0,
  eta: null,
  fatalError: false,
  speed: 0,
  transferring: [],
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One `transferring[]` entry, or null when it is not the shape rclone sends. */
function transferringOf(raw: unknown): RcloneTransferringFile | null {
  if (typeof raw !== 'object' || raw === null)
    return null
  const t = raw as Record<string, unknown>
  if (typeof t.name !== 'string' || t.name === '')
    return null
  return {
    name: t.name,
    size: num(t.size),
    bytes: num(t.bytes),
    percentage: num(t.percentage),
    speed: num(t.speed),
    eta: typeof t.eta === 'number' && Number.isFinite(t.eta) ? t.eta : null,
  }
}

/** Pull a `stats` object out of one parsed log object, or null when it has none. */
export function statsOf(entry: Record<string, unknown>): RcloneStats | null {
  const raw = entry.stats
  if (typeof raw !== 'object' || raw === null)
    return null
  const s = raw as Record<string, unknown>
  const transferring: RcloneTransferringFile[] = []
  if (Array.isArray(s.transferring)) {
    for (const t of s.transferring) {
      const f = transferringOf(t)
      if (f)
        transferring.push(f)
    }
  }
  return {
    bytes: num(s.bytes),
    totalBytes: num(s.totalBytes),
    transfers: num(s.transfers),
    totalTransfers: num(s.totalTransfers),
    checks: num(s.checks),
    totalChecks: num(s.totalChecks),
    deletes: num(s.deletes),
    errors: num(s.errors),
    elapsedTime: num(s.elapsedTime),
    eta: typeof s.eta === 'number' && Number.isFinite(s.eta) ? s.eta : null,
    fatalError: s.fatalError === true,
    speed: num(s.speed),
    transferring,
  }
}

// --- Per-file events (rclone.6 — the `-v` stream) ---------------------------

/** The per-file kinds the run detail's `recent` ring keeps. */
export type RcloneFileEventKind = 'copied' | 'updated' | 'deleted' | 'error'

/** One finished (or failed) file, as the `-v` stream reports it. */
export interface RcloneFileEvent {
  name: string
  kind: RcloneFileEventKind
  /** The error's message, verbatim (error events only). */
  message?: string
}

/**
 * The `-v` event messages rclone 1.60 emits per finished file, and the kind
 * each maps to (GT 2026-09-25, captured on the node — `fixtures/rclone/
 * run-copy-1.60.1.log`). Every Copied shape reads `copied`: a replace says
 * "Copied (replaced existing)", a server-side copy "Copied (server-side
 * copy)", a multi-threaded one "Multi-thread Copied (...)". A modtime touch
 * reads "Updated modification time in destination" and is NOT a file
 * transfer, so nothing maps to `updated` — the kind stays in the schema for
 * forward compatibility, but 1.60 never produces it. Anything else an
 * info-level object says about a file is not one of the viewer's kinds and
 * is ignored.
 */
const FILE_EVENT_MSGS: [prefix: string, kind: RcloneFileEventKind][] = [
  ['Copied', 'copied'],
  ['Multi-thread Copied', 'copied'],
  ['Deleted', 'deleted'],
]

/**
 * The per-file event one log object amounts to, or null when it is none:
 * an info-level object naming a file with one of the messages above, or an
 * error-level object (which is ALSO an error line — the caller pushes it to
 * both). An error names the file it failed on WHEN rclone says one; the
 * retry summary lines ("Attempt 1/3 failed with ...") carry no `object`, and
 * they must still reach `recent`/`lastError`, so those events carry
 * `name: ''` (GT: `run-error-objectless-1.60.1.log`).
 */
export function fileEventOf(entry: Record<string, unknown>): RcloneFileEvent | null {
  const msg = typeof entry.msg === 'string' ? entry.msg.trim() : ''
  if (!msg)
    return null
  const object = typeof entry.object === 'string' ? entry.object.trim() : ''
  if (entry.level === 'error' || entry.level === 'critical')
    return { name: object, kind: 'error', message: msg }
  if (!object || entry.level !== 'info')
    return null
  for (const [prefix, kind] of FILE_EVENT_MSGS) {
    if (msg.startsWith(prefix))
      return { name: object, kind }
  }
  return null
}

/**
 * The error line a `level:"error"` log object amounts to, verbatim and named:
 * rclone reports the object it failed on separately from the message, and an
 * error that does not say WHICH file is half an answer.
 */
export function errorLineOf(entry: Record<string, unknown>): string | null {
  if (entry.level !== 'error' && entry.level !== 'critical')
    return null
  const msg = typeof entry.msg === 'string' ? entry.msg.trim() : ''
  if (!msg)
    return null
  const object = typeof entry.object === 'string' ? entry.object.trim() : ''
  return object ? `${object}: ${msg}` : msg
}

/**
 * The cap on the would-be-delete NAMES the reader keeps. A whole-tree delete
 * can name millions of files, and the operator reading the answer wants a
 * sample with the count, not a wall of names — so the reader stops collecting
 * names at the cap while `skippedDeleteCount` keeps counting. Defined HERE,
 * next to the code that enforces it, and re-exported by `cloud-preview.ts`:
 * the reader and the answer must never disagree about the number.
 */
export const DELETED_FILES_CAP = 200

/** What one finished (or in-flight) read of rclone's log amounts to. */
export interface RcloneLogState {
  /** The most recent stats object — the LAST one is the run's result. */
  stats: RcloneStats | null
  /** Error-level lines, in order. */
  errorLines: string[]
  /** Lines that were not JSON at all (a panic, a pre-logger message). */
  rawLines: string[]
  /**
   * The `object` names of `skipped: delete` lines, in order — the would-be
   * deletes a `--dry-run` reports (GT 2026-09-24: every would-be delete is
   * exactly such an object). A real run prints none, so this stays empty
   * there and the preview's `deletedFiles` has one source.
   *
   * CAPPED at {@link DELETED_FILES_CAP} names: the reader is fed by a live
   * child's stderr, so an uncapped array would let a whole-tree delete grow
   * the daemon's heap by the destination's file count. The number is
   * {@link skippedDeleteCount}, which is never capped.
   */
  skippedDeletes: string[]
  /**
   * How many `skipped: delete` lines were read, whether or not their names
   * were kept — the honest total behind the capped {@link skippedDeletes}.
   */
  skippedDeleteCount: number
}

/**
 * A line-buffered reader for rclone's NDJSON stderr. `onStderr` hands over
 * CHUNKS, which split lines wherever the pipe happened to break, so the
 * buffering has to live here rather than in every caller.
 */
export class RcloneLogReader {
  private buffer = ''
  readonly errorLines: string[] = []
  readonly rawLines: string[] = []
  /**
   * rclone.6 — called with every per-file event a completed line amounts to
   * (a finished file, or an error naming one). Optional: the preview keeps
   * none. A live run completes at most one per chunk, like the stats objects.
   */
  onFileEvent?: (event: RcloneFileEvent) => void
  /**
   * The `object` of the first {@link DELETED_FILES_CAP} `skipped: delete`
   * lines (a dry run's would-be deletes). The names stop at the cap; the
   * count does not.
   */
  readonly skippedDeletes: string[] = []
  /** Every `skipped: delete` line read, capped names or not. */
  skippedDeleteCount = 0
  stats: RcloneStats | null = null

  /**
   * Feed a chunk. Returns EVERY stats object this chunk completed, in order —
   * the caller publishes one progress line per object, which is DESIGN's
   * contract ("each `stats` object updates the job's progress"). A live run
   * completes at most one per chunk (they arrive `--stats` apart); a buffered
   * replay can complete several at once and must not silently drop the earlier
   * ones.
   */
  push(chunk: string): RcloneStats[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // The tail is whatever came after the last newline — an incomplete line.
    this.buffer = lines.pop() ?? ''
    const fresh: RcloneStats[] = []
    for (const line of lines) {
      const stats = this.line(line)
      if (stats)
        fresh.push(stats)
    }
    return fresh
  }

  /** Consume whatever is left in the buffer (a final line with no newline). */
  flush(): RcloneStats[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest)
      return []
    const stats = this.line(rest)
    return stats ? [stats] : []
  }

  private line(raw: string): RcloneStats | null {
    const text = raw.trim()
    if (!text)
      return null
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) {
        this.rawLines.push(text)
        return null
      }
      entry = parsed as Record<string, unknown>
    }
    catch {
      this.rawLines.push(text)
      return null
    }
    const error = errorLineOf(entry)
    if (error)
      this.errorLines.push(error)
    const fileEvent = fileEventOf(entry)
    if (fileEvent)
      this.onFileEvent?.(fileEvent)
    // A would-be delete: rclone's `--dry-run` reports each one as a
    // `skipped: delete` object naming the file (`skipped: copy` lines are the
    // would-be TRANSFERS — rclone counts them in `stats.transfers`, so they
    // are not collected here twice).
    // The NAMES stop at the cap (an unbounded array here would grow with the
    // destination's file count, fed by a live child); the COUNT never does.
    if (entry.skipped === 'delete' && typeof entry.object === 'string' && entry.object.trim() !== '') {
      this.skippedDeleteCount++
      if (this.skippedDeletes.length < DELETED_FILES_CAP)
        this.skippedDeletes.push(entry.object.trim())
    }
    const stats = statsOf(entry)
    if (stats)
      this.stats = stats
    return stats
  }

  state(): RcloneLogState {
    return {
      stats: this.stats,
      errorLines: [...this.errorLines],
      rawLines: [...this.rawLines],
      skippedDeletes: [...this.skippedDeletes],
      skippedDeleteCount: this.skippedDeleteCount,
    }
  }
}

/** Read a whole captured log at once (the buffered path, and the tests'). */
export function readRcloneLog(text: string): RcloneLogState {
  const reader = new RcloneLogReader()
  reader.push(text)
  reader.flush()
  return reader.state()
}

/**
 * The final stats a whole run reported. Kept separate from the reader so the
 * result shape has ONE source, whether the log arrived in chunks or at once.
 */
export function finalStats(log: RcloneLogState): RcloneStats {
  return log.stats ?? ZERO_STATS
}

/**
 * One stats object as a job-progress line. rclone's OWN numbers, each with its
 * label — no unit guessing and nothing derived, so what the operator reads is
 * what rclone reported.
 */
export function statsProgressLine(mode: string, stats: RcloneStats): string {
  const parts = [
    `${stats.bytes} of ${stats.totalBytes} bytes`,
    `${stats.transfers} transferred`,
    `${stats.checks} checked`,
    `${stats.deletes} deleted`,
    `${stats.errors} errors`,
  ]
  if (stats.eta !== null)
    parts.push(`ETA ${stats.eta}s`)
  return `${mode}: ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------
//  The live run DETAIL (rclone.6)
// ---------------------------------------------------------------------------

/** The `recent` ring's cap — the last 50 per-file events. */
export const RECENT_RING_CAP = 50
/** The `speedSamples` ring's cap — the last 60 byte-delta samples, i.e. 5 min at 5s. */
export const SPEED_RING_CAP = 60

/**
 * The two timer faces the tracker's wall-clock watch needs, injectable so
 * the tests fire ticks by hand instead of waiting out real 5 s intervals.
 * The default is node's own timers.
 */
export interface CloudRunDetailTimer {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

const NODE_TIMER: CloudRunDetailTimer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>),
}

/**
 * Builds the {@link CloudRunDetail} a direct run job publishes on itself,
 * fed by the same log stream that drives the progress text: one
 * {@link onStats} per completed stats object, one {@link onEvent} per
 * finished/failed file. Every counter is rclone's own; the throughput
 * figures are NOT — the samples are derived HERE, from the byte deltas
 * between consecutive stats objects, because rclone's own `speed` is an
 * exponentially weighted average that decays toward zero but never reaches
 * it on a stall, and its averaging loop stops 60 s after the transferring
 * set empties and never restarts (review batch A, 2026-09-25). The rings
 * are capped so a multi-day run's daemon heap stays flat.
 *
 * The sample stream has one blind spot, closed 2026-09-26: the deltas are
 * per stats OBJECT, so a hung or frozen rclone — SIGSTOP'd, wedged on a
 * dead socket — emits no objects at all, no samples arrive, and the
 * trailing-zero count never grows. So the tracker also keeps a wall-clock
 * timer at the stats cadence ({@link start}, called when the run's exec
 * starts): a tick with no stats object since the previous one appends a 0
 * sample and republishes the detail, so three silent intervals read stalled
 * exactly like three unchanged stats objects. A tick that follows a stats
 * object within the interval appends nothing — the object's own derived
 * sample already stands for it.
 */
export class CloudRunDetailTracker {
  private startedMs: number
  private latest: RcloneStats | null = null
  private readonly recent: CloudRunRecentEvent[] = []
  /**
   * The daemon's own throughput samples: per stats object AFTER the first,
   * `(bytes - prevBytes) / (elapsedTime - prevElapsed)` — 0 when the elapsed
   * delta is <= 0 or bytes did not grow. One per stats tick, so on a stall
   * they read exactly 0 and the shared stalled rule can fire.
   */
  private readonly speedSamples: number[] = []
  private lastError: string | undefined
  /** Wall-clock ms the last stats object arrived — `lastStatsAt`'s source. */
  private lastStatsMs: number | null = null
  private timerId: unknown = null
  private timer: CloudRunDetailTimer | null = null
  private publish: (() => void) | null = null
  /** Whether a stats object arrived in the interval now closing. */
  private heardSinceTick = false

  constructor(startedAt: Date = new Date()) {
    this.startedMs = startedAt.getTime()
  }

  /** The run's start, as the detail publishes it. */
  get startedAt(): string {
    return new Date(this.startedMs).toISOString()
  }

  /**
   * Start the silence watch at the stats cadence, handing it the publish
   * callback so a silent tick can push the zeroed detail out. Called when
   * the run's exec starts; idempotent-safe to call once.
   */
  start(publish?: () => void, timer: CloudRunDetailTimer = NODE_TIMER): void {
    this.stop()
    this.publish = publish ?? null
    this.timer = timer
    this.heardSinceTick = false
    this.timerId = timer.setInterval(() => this.onTick(), CLOUD_STATS_INTERVAL_SECS * 1000)
  }

  /** Stop the watch — the run's `finally`, success, failure or throw alike. */
  stop(): void {
    if (this.timerId !== null)
      this.timer?.clearInterval(this.timerId)
    this.timerId = null
    this.timer = null
    this.publish = null
  }

  /**
   * One wall-clock tick: no stats object since the previous tick means
   * rclone said nothing for a whole interval — a silent process reads the
   * same as a network stall, so a 0 sample stands for it and the detail is
   * republished (counters and `transferring` stand as they were). A tick
   * that follows a stats object within the interval appends nothing: the
   * object's derived sample already covers it, and appending again would
   * double-count one interval of time.
   */
  private onTick(): void {
    if (this.timerId === null)
      return // the watch is stopped — no tick may move a finished run's rings
    const heard = this.heardSinceTick
    this.heardSinceTick = false
    if (heard)
      return
    this.speedSamples.push(0)
    while (this.speedSamples.length > SPEED_RING_CAP)
      this.speedSamples.shift()
    this.publish?.()
  }

  /** Feed one completed stats object (the counters + the sample ring). */
  onStats(stats: RcloneStats, at: Date = new Date()): void {
    const prev = this.latest
    this.latest = stats
    this.lastStatsMs = at.getTime()
    this.heardSinceTick = true
    if (prev) {
      const dElapsed = stats.elapsedTime - prev.elapsedTime
      const dBytes = stats.bytes - prev.bytes
      this.speedSamples.push(dElapsed > 0 && dBytes > 0 ? dBytes / dElapsed : 0)
      while (this.speedSamples.length > SPEED_RING_CAP)
        this.speedSamples.shift()
    }
  }

  /** Feed one per-file event (the `recent` ring; an error also names `lastError`). */
  onEvent(event: RcloneFileEvent, at: string = new Date().toISOString()): void {
    const entry: CloudRunRecentEvent = {
      name: event.name,
      kind: event.kind,
      at,
      ...(event.message ? { message: event.message } : {}),
    }
    this.recent.push(entry)
    while (this.recent.length > RECENT_RING_CAP)
      this.recent.shift()
    if (event.kind === 'error' && event.message) {
      // An object-less error line has no name to prefix — its message alone
      // is the last error (the "Attempt 1/3 failed" retry summaries).
      this.lastError = event.name ? `${event.name}: ${event.message}` : event.message
    }
  }

  /**
   * The detail's ETA: remaining bytes over the mean of the last 12 samples,
   * in seconds — null until at least 3 samples exist and that mean is
   * positive. Never rclone's own `eta` (see the class doc).
   */
  private eta(): number | null {
    if (this.speedSamples.length < 3)
      return null
    const window = this.speedSamples.slice(-12)
    const avg = window.reduce((sum, v) => sum + v, 0) / window.length
    if (!(avg > 0))
      return null
    const remaining = this.latest ? this.latest.totalBytes - this.latest.bytes : 0
    return Math.max(0, remaining) / avg
  }

  /** The detail as it stands right now — a fresh object every call. */
  detail(now: number = Date.now()): CloudRunDetail {
    const s = this.latest ?? ZERO_STATS
    return {
      startedAt: this.startedAt,
      elapsedMs: Math.max(0, now - this.startedMs),
      speed: this.speedSamples.at(-1) ?? 0,
      eta: this.eta(),
      bytes: s.bytes,
      totalBytes: s.totalBytes,
      transfers: s.transfers,
      totalTransfers: s.totalTransfers,
      checks: s.checks,
      totalChecks: s.totalChecks,
      deletes: s.deletes,
      errors: s.errors,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      // Snapshots, not live references: every poll hands the published object
      // to the wire on its own, so a poll already reading an older detail
      // must never see a later tick mutate into it.
      transferring: s.transferring.map(f => ({ ...f })),
      recent: [...this.recent],
      speedSamples: [...this.speedSamples],
      ...(this.lastStatsMs !== null ? { lastStatsAt: new Date(this.lastStatsMs).toISOString() } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
//  Exit-code policy
// ---------------------------------------------------------------------------

/** Did this exit code COMPLETE the run? Only 0 and 9 (DESIGN). */
export function rcloneRunCompleted(exitCode: number): boolean {
  return exitCode === EXIT_OK || exitCode === EXIT_NOTHING_TO_TRANSFER
}

/**
 * The failure message for a non-completing exit: rclone's own error lines when
 * it logged any, else its raw output, else the bare code. ASCII only — this
 * text becomes the job's error AND the notification body's Error block.
 */
export function rcloneFailureMessage(mode: string, exitCode: number, log: RcloneLogState): string {
  const detail = log.errorLines.length
    ? log.errorLines.join('; ')
    : (log.rawLines.at(-1) ?? '')
  // Exit 6 is rclone's "less serious errors", which in practice means some
  // files did not make it. ANAS calls that a failed run, and says why plainly.
  const meaning = exitCode === EXIT_SOME_FILES_FAILED
    ? ' - some files could not be transferred and are missing at the destination'
    : ''
  return `rclone ${mode} failed (exit ${exitCode})${meaning}${detail ? `: ${detail}` : ''}`
}

// ---------------------------------------------------------------------------
//  Guards
// ---------------------------------------------------------------------------

/** The `sync`-with-an-empty-source refusal, in DESIGN's own words. */
export function emptySourceRefusal(source: string, configFile: string, destination: string): string {
  return `${source} is empty and this task syncs - an empty source in sync mode would delete everything `
    + `at the destination, so the run is refused. Use copy mode, or, if the source really is meant to be `
    + `empty, empty the remote by hand first: rclone --config ${configFile} purge ${destination}`
}

/** The source must be a DIRECTORY that exists — rclone syncs trees, not devices. */
export function missingSourceRefusal(source: string): string {
  return `${source} does not exist or is not a directory - a cloud sync task copies a directory tree`
}

// ---------------------------------------------------------------------------
//  The run
// ---------------------------------------------------------------------------

export interface CloudRunDeps {
  task: CloudSyncTask
  /** Where ANAS's own rclone.conf lives (every invocation names it). */
  paths: RcloneConfigPaths
  /** The fstab the source guard reads (the Mounts path, overridable for tests). */
  fstabPath: string
  /** Passed through to the consistency derivation (the PVE storage.cfg override). */
  consistencyOptions?: { pveStorageCfg?: string }
  /** AHR snapshot/runtime-dir options, threaded through to the transient helpers. */
  snapshotOptions?: BackupSnapshotOptions
  /** Injectable clock — the transient label and the sweep cutoff. */
  now?: Date
  /**
   * Plain secret values HANDED to the child, for the argv guard. There are none
   * in a cloud sync run — rclone reads every credential from the config file,
   * and a remote NAME is not a secret — so this is normally empty and the
   * guard is the structural backstop that would fire if that ever stopped
   * being true. They are masked out of the run's output too; the remote's
   * STORED credentials (which rclone can echo) are not passed here —
   * {@link runCloudSync} reads them itself (cr.55), so no caller can forget
   * them. They do NOT feed the argv guard: the argv holds the operator's own
   * paths and ANAS's constants, where a stored credential that happens to be
   * a substring (a source path, `--stats`, the config path) is a coincidence
   * the guard — which has no length floor — would refuse every run over.
   */
  secrets?: string[]
  /**
   * rclone.5 — handed the rclone child the moment it spawns, so the job's
   * cancel hook ({@link ChildCancel}) can signal it. Absent = not cancellable.
   */
  onSpawn?: (child: SpawnedChild) => void
  /**
   * rclone.5 review — the pre-flight boundary check, called at each one (before
   * the source guard, before the transient snapshot, before the exec) with what
   * the next step would have done. Throws {@link JobCancelledError} when a
   * cancel was already accepted, so the run ends `cancelled` there — its own
   * `finally` still destroys anything taken. Absent = no boundary checks.
   */
  checkCancel?: (next: string) => void
  /**
   * rclone.6 — handed the run's live {@link CloudRunDetail} after every stats
   * object, for the job to publish through the queue's `updateDetail`.
   * Per-file events update the tracker's rings and are carried out by the
   * NEXT stats tick — a many-small-files run must not build one detail
   * snapshot per file (review batch A, 2026-09-25). Absent = no detail is
   * built (the preview).
   */
  onDetail?: (detail: CloudRunDetail) => void
  /**
   * The silence watch's timer, injectable for the tests (which fire the
   * ticks by hand). Absent = node's own timers.
   */
  timer?: CloudRunDetailTimer
}

/**
 * Run one cloud sync. Returns a result for a completed run; THROWS on a guard
 * refusal or a real failure, so the job fails and systemd's last-result stays
 * truthful.
 *
 * The order is load-bearing:
 *   1. source guard (configured-but-unmounted), the liveness probe (cr3
 *      CLOUD-M6) and the existence check — before anything is read in
 *      process, and before a `sync` can see an empty mountpoint;
 *   2. the empty-source refusal, `sync` only, on the live tree;
 *   3. the boundary scan and the consistency derivation, both on the source's
 *      REAL path ({@link readCloudSourceView}, cr3 CLOUD-M4); a snapshot-mode
 *      run excludes every nested filesystem (cr3 CLOUD-H3), and a snapshot-mode
 *      SYNC whose scan could not see everything is refused;
 *   4. the transient snapshot: sweep this task's own stale ones first, take,
 *      point rclone at the snapshot path; a `sync` judges emptiness again on
 *      the tree it will read (the snapshot root, less the excluded nested
 *      filesystems);
 *   5. ONE rclone invocation, its JSON log read live for progress;
 *   6. destroy the transient in a `finally` — success, failure or throw alike.
 */
export async function runCloudSync(
  executor: CommandExecutor,
  deps: CloudRunDeps,
  updateProgress: (message: string) => void,
): Promise<CloudSyncRunResult> {
  const { task } = deps
  const destination = rcloneDestination(task)
  const now = deps.now ?? new Date()
  const warnings: string[] = []

  updateProgress(`starting cloud sync ${task.name}: ${task.source} -> ${destination} (${task.mode})`)

  // ---- 1. Source guards --------------------------------------------------
  // The unmounted-mount check runs FIRST: it is the one that explains an empty
  // directory, and it is the only one that can answer without touching the path.
  deps.checkCancel?.('the source guard')
  const guardFacts = await readSourceGuardFacts(executor, deps.fstabPath, [task.source])
  const refusal = guardSourcePath(task.source, guardFacts)
  if (refusal)
    throw new Error(refusal)
  // cr3 CLOUD-M6: a mounted filesystem that does not answer (a hard NFS mount
  // whose server is down) is refused here, in a bounded child, before the
  // in-process `stat` below could block a libuv pool thread on it.
  const dead = await sourceNotAnsweringRefusal(executor, task.source)
  if (dead)
    throw new Error(dead)

  // The source must be a DIRECTORY that exists and can be listed. A `stat` is
  // safe here BECAUSE the unmounted-mount guard and the liveness probe already
  // ran — the cases where the path could sit on a filesystem that is not there
  // or does not answer.
  const stats = await stat(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (stats instanceof Error || !stats.isDirectory())
    throw new Error(missingSourceRefusal(task.source))
  const listed = await readdir(task.source).catch((err: NodeJS.ErrnoException) => err)
  if (listed instanceof Error) {
    // Readable-directory problems (EACCES, EIO) are their own thing: saying
    // "does not exist" would send the operator looking for the wrong fault.
    throw new Error(`${task.source} could not be listed: ${listed.message}`)
  }
  const entries = listed

  // ---- 2. The catastrophic shape ----------------------------------------
  if (task.mode === 'sync' && entries.length === 0)
    throw new Error(emptySourceRefusal(task.source, deps.paths.configFile, destination))

  // ---- 3. What the run reads ---------------------------------------------
  // cr3 CLOUD-M4: judged on the REAL path — the source guard's bounded
  // `realpath -e` (the path as written when it did not resolve) — and printed
  // with the configured one, as backup does (cr.64b2-iii (O)).
  const view = await readCloudSourceView(executor, task.source, guardFacts.realpaths.get(task.source) ?? task.source, deps.consistencyOptions ?? {})
  const nested = view.nested
  if (nested.length)
    updateProgress(nestedProgressLine(task.source, nested, view.snapshot))
  const consistency = view.consistency
  updateProgress(`source consistency: ${consistency.consistency} - ${consistency.reason}`)
  // cr3 CLOUD-H3 (as corrected by the review): a snapshot-mode sync is
  // refused only when the COMPLETE nested read failed, or a nested name
  // cannot be left out. The bounded walk's caps are a display warning.
  const refusedSync = snapshotSyncRefusal(view, task.source, task.mode)
  if (refusedSync)
    throw new Error(refusedSync)
  if (view.snapshot && view.excludedUnknown !== null)
    warnings.push(`the nested filesystems under ${task.source} could not be listed (${view.excludedUnknown})`)
  if (view.nestedUnknown !== null)
    warnings.push(`the nested-filesystem list shown for ${task.source} may be short (${view.nestedUnknown})`)
  // The boundary between the read-only probes and the first mutation: past
  // here a cancel leaves nothing taken — the snapshot below never happens.
  deps.checkCancel?.('the transient snapshot')

  const taken: TakenSnapshot[] = []
  // rclone.6 — the live detail the run publishes on its job, fed by the same
  // stream the progress text is. Built only when someone is listening; the
  // silence watch lives and dies with the run (started at the exec, stopped
  // in the `finally` below), so no tick can fire outside it.
  let tracker: CloudRunDetailTracker | null = null
  let result: CloudSyncRunResult

  try {
    const plan = await prepareSource(executor, deps, consistency, view.ahrPools, now, updateProgress, taken, warnings)
    // cr3 CLOUD-H3: the empty-source guard judged the LIVE tree above; a sync
    // from a snapshot is judged again on the tree rclone will read — the
    // snapshot root, less the nested filesystems it excludes (each an empty
    // directory there). A source whose whole content is nested filesystems
    // passed the live check and would sync as an empty tree.
    if (task.mode === 'sync' && plan.snapshot) {
      const read = await readdir(plan.source).catch((err: NodeJS.ErrnoException) => err)
      if (read instanceof Error)
        throw new Error(`${plan.source} (the snapshot of ${task.source}) could not be listed: ${read.message}`)
      const skip = excludedTopLevelNames(view.real, view.excluded)
      if (!read.some(name => !skip.has(name)))
        throw new Error(emptySourceRefusal(task.source, deps.paths.configFile, destination))
    }
    const args = buildRcloneArgs(task, deps.paths.configFile, plan.source, { excludes: view.excludes })
    // The executor-side argv backstop, uniform with every other rclone call
    // ANAS makes. Nothing secret is in scope here (see `deps.secrets`), so it
    // normally has nothing to check — which is the point of a backstop.
    assertNoSecretValues(args, deps.secrets ?? [])
    // cr.55: what rclone can ECHO — the remote's stored credentials,
    // transitive over the remotes it wraps (the ONE builder the Test and the
    // preview use; in process, no rclone call). Every string made from its
    // stderr below is masked with this where it is made.
    const maskValues = [...(deps.secrets ?? []), ...await remoteSecretValues(deps.paths.configFile, task.remote)]
    const mask = (text: string): string => maskSecretValues(text, maskValues)

    // The last boundary before anything runs (rclone.5 review): a cancel
    // accepted by now ends the run here — the `finally` below still destroys
    // the snapshot the plan may have taken.
    deps.checkCancel?.('the rclone run')

    // rclone.6 — the live detail the run publishes on its job, fed by the same
    // stream the progress text is. Built only when someone is listening.
    tracker = deps.onDetail ? new CloudRunDetailTracker(now) : null
    const publish = () => {
      if (tracker)
        deps.onDetail?.(tracker.detail())
    }

    updateProgress(`rclone ${task.mode} ${plan.source} -> ${destination}`)
    // The wall-clock silence watch rides the rclone invocation itself: a hung
    // process emits no stats objects, so the zeros have to come from a clock.
    tracker?.start(publish, deps.timer)
    const exec = () => execRclone(executor, args, task.mode, updateProgress, mask, deps.onSpawn, tracker ?? undefined, publish)
    const run = plan.pool
      ? await withTopLevelMounts(executor, [plan.pool], exec, deps.snapshotOptions)
      : await exec()

    // cr.55: the failure message is made from rclone's raw lines and masked
    // HERE, once — it becomes `job.error`, the notification's Error block and
    // (through the cloud-task runner) the unit journal's line.
    if (!rcloneRunCompleted(run.exitCode))
      throw new Error(mask(rcloneFailureMessage(task.mode, run.exitCode, run.log)))

    const stats = finalStats(run.log)
    result = {
      status: 'success',
      mode: task.mode,
      consistency,
      source: plan.source,
      destination,
      ...(plan.snapshot ? { snapshot: plan.snapshot } : {}),
      bytes: stats.bytes,
      totalBytes: stats.totalBytes,
      transfers: stats.transfers,
      checks: stats.checks,
      deletes: stats.deletes,
      errors: stats.errors,
      elapsed: stats.elapsedTime,
      // Whether rclone actually reported a stats object. A sub-second run may
      // print none (its interval has not fired), and the counters below read
      // 0 in that case — honest only when this flag says so.
      countersReported: run.log.stats !== null,
      // cr.55: rclone's own error lines, masked where the result is made —
      // they reach `job.result`, the notification's "rclone errors" block and
      // the runner's result-JSON journal line.
      errorLines: run.log.errorLines.map(mask),
      ...(nested.length ? { nested } : {}),
    }
  }
  finally {
    // The silence watch dies with the run — no tick may fire after the exit,
    // whichever way it went.
    tracker?.stop()
    // Success, failure or refusal alike. A destroy that fails is a WARNING on
    // an otherwise-good run, never a reason to call a finished sync failed.
    // The noun says what kind of transient it was — this is a cloud sync run,
    // not a backup.
    warnings.push(...await destroyTransients(executor, taken, updateProgress, deps.snapshotOptions, 'cloud sync'))
  }

  if (warnings.length)
    result.warnings = warnings
  return result
}

/** What the rclone invocation will actually read, and what had to be taken for it. */
interface SourcePlan {
  /** The path rclone is pointed at — the snapshot path, or the live tree. */
  source: string
  /**
   * The transient snapshot, named in full (`<dataset>@<label>` / AHR's
   * `<pool>:@snapshots/<label>`) — taken verbatim from the `TakenSnapshot.full`
   * the take helpers already assembled, so the naming lives in ONE place.
   */
  snapshot?: string
  /** The AHR pool whose top-level mount must be held open across the run. */
  pool?: AhrPool
}

/**
 * Sweep, take and resolve the snapshot path for a snapshottable source — or
 * hand back the live tree when the derivation said `live`. Pushes what it took
 * onto `taken`, which the caller's `finally` destroys.
 *
 * A ZVOL source cannot reach here: the existence check above requires a
 * directory, so `/dev/zvol/...` is refused long before the derivation's zvol
 * branch could matter.
 */
async function prepareSource(
  executor: CommandExecutor,
  deps: CloudRunDeps,
  consistency: BackupArchiveConsistency,
  ahrPools: AhrPool[],
  now: Date,
  updateProgress: (message: string) => void,
  taken: TakenSnapshot[],
  warnings: string[],
): Promise<SourcePlan> {
  const { task } = deps
  if (consistency.consistency !== 'snapshot' || !consistency.target)
    return { source: task.source }

  const label = formatTransientCloudSnapshot(task.name, now)
  // The sweep is scoped to THIS KIND's prefix AND this task's name: a backup
  // task's transients belong to a run that may be happening right now.
  const sweep = { parse: parseTransientCloudSnapshot }

  if (consistency.backend === 'zfs') {
    const dataset = consistency.target
    warnings.push(...await sweepZfsTransients(executor, dataset, task.name, now, updateProgress, sweep))
    updateProgress(`snapshotting ${dataset}@${label} (recursive)`)
    const snap = await takeZfsTransient(executor, dataset, label)
    taken.push(snap)
    const source = snapshotRoot(consistency, label)
    if (!source)
      throw new Error(`the snapshot path for ${task.source} could not be resolved`)
    return { source, snapshot: snap.full }
  }

  const pool = ahrPools.find(p => p.name === consistency.target)
  if (!pool)
    throw new Error(`AHR pool '${consistency.target}' is no longer resolvable`)
  warnings.push(...await sweepAhrTransients(executor, pool, task.name, now, updateProgress, deps.snapshotOptions, sweep))
  updateProgress(`snapshotting AHR pool '${pool.name}' as @snapshots/${label}`)
  const snap = await takeAhrTransient(executor, pool, label, undefined, updateProgress, deps.snapshotOptions)
  taken.push(snap)
  // `@snapshots` lives OUTSIDE the mounted `@data` tree, so the path is only
  // reachable while the pool is mounted top-level — which is why the caller
  // wraps the rclone call in `withTopLevelMounts` for exactly this pool.
  const source = snapshotRoot(consistency, label, plannedTopLevel(pool, deps.snapshotOptions))
  if (!source)
    throw new Error(`the snapshot path for ${task.source} could not be resolved`)
  return { source, snapshot: snap.full, pool }
}

/**
 * One rclone invocation, its NDJSON stderr read AS IT ARRIVES so the job's
 * progress moves during the run rather than at the end of it. `execFile`, no
 * shell, argv array — the whole command is the array `buildRcloneArgs` built.
 * The tee and the re-read fallback live in {@link execRcloneLog}, shared with
 * the preview (which wraps the same argv in `timeout` and keeps no progress).
 * `tracker`/`publish` (rclone.6) feed the live run detail off the same stream
 * — the detail is PUBLISHED per stats tick only (review batch A, 2026-09-25):
 * a file event updates the tracker's rings and the next stats tick carries it
 * out, so a many-small-files run builds no snapshot per file.
 */
async function execRclone(
  executor: CommandExecutor,
  args: string[],
  mode: string,
  updateProgress: (message: string) => void,
  /** cr.55: the run's mask — applied to a per-file event's message before the `recent` ring keeps it. */
  mask: (text: string) => string,
  onSpawn?: (child: SpawnedChild) => void,
  tracker?: CloudRunDetailTracker,
  publish?: () => void,
): Promise<{ exitCode: number, log: RcloneLogState }> {
  return execRcloneLog(
    executor,
    RCLONE,
    args,
    (stats) => {
      updateProgress(statsProgressLine(mode, stats))
      tracker?.onStats(stats)
      publish?.()
    },
    onSpawn,
    (event) => {
      // cr.55: an error event's message is rclone's own text — masked as it
      // enters the ring, so `recent` and the `lastError` built from it carry
      // no echoed credential (the file NAME is the operator's data, not a
      // credential, and is kept).
      tracker?.onEvent(event.message ? { ...event, message: mask(event.message) } : event)
    },
    // cr.34: the run is a data mover (days for an offsite copy); it ends on
    // its own or through its cancel hook (rclone.5), never by a deadline.
    { timeoutMs: null, longRunning: 'rclone sync/copy run: a data mover, days long; stopped by its cancel hook' },
  )
}

/**
 * One rclone invocation (or a `timeout` wrapper around one), its NDJSON
 * stderr read as it arrives. The ONE place the tee pattern lives: every
 * completed `stats` object is handed to `onStats` (the run publishes job
 * progress; the preview keeps none), every per-file event to `onEvent`
 * (rclone.6), and the bounded-tail re-read covers an executor that buffers
 * without teeing.
 */
export async function execRcloneLog(
  executor: CommandExecutor,
  command: string,
  args: string[],
  onStats?: (stats: RcloneStats) => void,
  onSpawn?: (child: SpawnedChild) => void,
  onEvent?: (event: RcloneFileEvent) => void,
  /**
   * cr.34: the call's deadline. Omitted, the executor's own rule applies (the
   * preview's `timeout 120` wrapper sets it); the run passes `null`.
   */
  deadline: DeadlineOptions = {},
): Promise<{ exitCode: number, log: RcloneLogState }> {
  const reader = new RcloneLogReader()
  reader.onFileEvent = onEvent
  const r = await executor.exec(command, args, {
    ...deadline,
    ...(onSpawn ? { onSpawn } : {}),
    // See RCLONE_MAX_BUFFER for the arithmetic. The tee means stderr is NOT
    // retained beyond the executor's bounded tail — a 15-day run's stats log
    // never accumulates in the daemon.
    maxBuffer: RCLONE_MAX_BUFFER,
    onStderr: (chunk) => {
      for (const stats of reader.push(chunk))
        onStats?.(stats)
    },
  })
  for (const stats of reader.flush())
    onStats?.(stats)
  const log = reader.state()
  // A mock (or an executor that buffers without teeing) hands the whole log
  // back only in `stderr`; re-reading it there is idempotent for a live run,
  // whose reader has already consumed the same bytes from the chunks. A log
  // whose only objects were `skipped` lines must re-read too, or a no-tee
  // executor would report the would-be deletes as zero.
  if (!log.stats && !log.errorLines.length && !log.skippedDeleteCount && r.stderr)
    return { exitCode: r.exitCode, log: readRcloneLog(r.stderr) }
  return { exitCode: r.exitCode, log }
}
