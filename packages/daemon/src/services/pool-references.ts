import type { CommandExecutor } from '../executor/types.js'
import { effectiveArchiveKind, isPathWithin, zvolDatasetFromPath } from '@anas/shared'
import { parseExports } from '../parsers/exports.js'
import { parseFstab } from '../parsers/fstab.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { BACKUP_UNIT_KIND, readAllTasks as readAllBackupTasks } from './backup-units.js'
import { CLOUD_UNIT_KIND, readAllTasks as readAllCloudTasks } from './cloud-units.js'
import { readConfig } from './config-writer.js'
import { readAllTasksChecked as readAllReplicationTasks } from './replication-units.js'
import { readScrubSchedule, SCRUB_SERVICE_NAME } from './scrub-schedule-units.js'
import { readScheduleList } from './snapshot-schedule-units.js'
import { listServiceUnitsChecked } from './systemd-unit-store.js'

/**
 * Story cr.24 — ONE helper answering "what references this path?".
 *
 * A pool export or destroy (ZFS) and a pool destroy (AHR) list every REFERENCE
 * whose path lives on the pool — an SMB share, an NFS export, a backup task
 * source, a replication task, a cloud-sync task, a snapshot / scrub schedule, an
 * ANAS mount — in the confirm warnings, so the operator decides with the facts.
 * They do not refuse (state the failure mode once, §2 "Guide, don't just warn");
 * the job re-reads the same list before it acts (ruling (j)) and reports
 * references that appeared after the confirm in the result.
 *
 * Every source is read through the module's existing reader (Principle 11), and
 * a source that CANNOT be read is reported as an {@link UnreadablePoolSource} —
 * never silently skipped, because "could not read" must not read as "nothing
 * references the pool". The existing fail-open store readers (a corrupt unit
 * file skips with a journald warn) are respected; the UNREADABLE store (its
 * unit directory cannot be listed) is surfaced through the same readers where
 * they carry a `complete` flag, and `listServiceUnitsChecked` elsewhere.
 *
 * Path matching uses the shared `isPathWithin` (never a string prefix).
 * References that are intrinsic to the pool itself — the snapshot target, the
 * replication source/target pool, the AHR scrub-timer pool list — are matched
 * by the pool NAME in the dataset-name namespace.
 *
 * DELIBERATE NON-REFERENCE (a judgement call on the spec): a ZFS pool's
 * `org.debian:periodic-scrub` property is not listed. It lives ON the pool,
 * disappears with it, and reads as "on" by default (`zfs get` failing
 * fail-opens to the distro default), so reporting it would warn on every pool
 * that merely has the default on. Only the AHR node-level `anas-scrub` timer
 * dangles (its pool list names a pool that will no longer exist) and is listed.
 */

/** The kinds of reference this helper can find, and can fail to read. */
export type PoolReferenceKind
  = | 'smb'
    | 'nfs'
    | 'backup'
    | 'replication'
    | 'cloud'
    | 'snapshot-schedule'
    | 'scrub-schedule'
    | 'mount'

/** One thing that references a path on the pool. */
export interface PoolReference {
  kind: PoolReferenceKind
  /** The reference's name — a share name, a task name, a schedule label, a mountpoint. */
  name: string
  /** The path (or dataset name) on the pool that the reference points at. */
  path: string
}

/** A source that could not be read — the caller discloses it at the confirm door. */
export interface UnreadablePoolSource {
  kind: PoolReferenceKind
  unreadable: true
}

/** Everything {@link readPoolReferences} found. */
export interface PoolReferenceRead {
  refs: PoolReference[]
  unreadableSources: UnreadablePoolSource[]
}

/** What the helper needs to answer "what references this pool". */
export interface PoolReferenceContext {
  executor: CommandExecutor
  /**
   * The pool's name — the pool-rooted namespace references are matched by
   * (replication source/target pool, snapshot / AHR scrub targets).
   */
  pool: string
  /**
   * The paths the pool owns — its datasets' mountpoints (ZFS) or its mounted
   * `@data` path (AHR). References whose path is at or under one of these count.
   */
  paths: string[]
  /**
   * smb.conf location (config IS the API). Absent ⇒ the SMB-share kind is not
   * checked. An unreadable file · unreadable:smb.
   */
  smbConfPath?: string
  /** /etc/exports location. Absent ⇒ the NFS-export kind is not checked. */
  exportsPath?: string
  /**
   * The systemd unit directory holding the task/schedule stores. Absent ⇒ the
   * unit-store kinds (backup, cloud, replication, schedules, AHR scrub) are NOT
   * checked at all, and no `unreadable` is reported for them.
   */
  systemdDir?: string
  /** /etc/fstab location for the ANAS-mount reference. Absent ⇒ not checked. */
  fstabPath?: string
  /**
   * What fstab may carry of the pool's OWN filesystems — the pool itself, never
   * a reference to it (story cr.31 D3). The confirm already says the pool's
   * filesystem goes; listing its own line as "a mount beneath this pool" named
   * the pool as a reference to itself on every AHR destroy.
   *
   *  - `mountpoints`: an AHR pool's mounted `@data` path — the fstab line ANAS
   *    wrote for the pool. An entry AT one of these is the pool's own mount;
   *    an entry UNDER one is still a reference.
   *  - `zfsDatasets`: a ZFS pool's datasets mount themselves (no fstab line),
   *    except a `mountpoint=legacy` dataset, which is mounted through fstab
   *    (`<pool>/<ds> <dir> zfs …`). An fstab entry of fstype `zfs` whose spec
   *    is a dataset of this pool is the pool's own dataset, not a reference.
   */
  ownMounts?: { mountpoints?: string[], zfsDatasets?: boolean }
  /**
   * Story cr.39: read ONLY these kinds (absent = every kind the paths above
   * enable). A mount's path is not in any pool's dataset namespace, so the
   * dataset-matched kinds (replication, snapshot and scrub schedules) cannot
   * reference it — reading their stores would only add "could not check"
   * disclosures for references that cannot exist.
   */
  kinds?: ReadonlySet<PoolReferenceKind>
}

/**
 * The identity of one reference for the confirm-vs-job comparison: a reference
 * that appeared after the confirm has a key the confirmed list does not carry.
 */
export function poolReferenceKey(ref: PoolReference): string {
  return `${ref.kind}|${ref.name}|${ref.path}`
}

/** Is a dataset-name IN the pool's dataset namespace (pool root or below)? */
function datasetOnPool(dataset: string, pool: string): boolean {
  return dataset === pool || dataset.startsWith(`${pool}/`)
}

const TRAILING_SLASHES_RE = /\/+$/

/** The same directory, ignoring trailing slashes (`/mnt/x/` is `/mnt/x`). */
function samePath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(TRAILING_SLASHES_RE, '') : p)
  return strip(a) === strip(b)
}

/**
 * Is this fstab entry one of the pool's OWN filesystems (story cr.31 D3,
 * {@link PoolReferenceContext.ownMounts}) rather than something mounted
 * beneath it?
 */
function isOwnMount(entry: { spec: string, mountpoint: string, fstype: string }, ctx: PoolReferenceContext): boolean {
  const own = ctx.ownMounts
  if (!own)
    return false
  if (own.mountpoints?.some(mp => samePath(mp, entry.mountpoint)))
    return true
  return own.zfsDatasets === true && entry.fstype === 'zfs' && datasetOnPool(entry.spec, ctx.pool)
}

/**
 * Is `path` at or under one of the pool's own paths? The one question every
 * path-based reference kind asks — shared `isPathWithin`, never a prefix splice.
 */
function pathAtOrUnder(path: string, poolPaths: string[]): boolean {
  return poolPaths.some(mp => isPathWithin(mp, path))
}

/**
 * Read every reference and every unreadable source for the pool. Never throws:
 * an unreadable source is reported, not propagated — the confirm door must get
 * a full answer (refs + what could not be checked) in one call.
 */
export async function readPoolReferences(ctx: PoolReferenceContext): Promise<PoolReferenceRead> {
  const refs: PoolReference[] = []
  const unreadableSources: UnreadablePoolSource[] = []
  const onPoolPath = (path: string) => pathAtOrUnder(path, ctx.paths)
  const wanted = (kind: PoolReferenceKind): boolean => !ctx.kinds || ctx.kinds.has(kind)

  // --- SMB shares (smb.conf) + NFS exports (/etc/exports) -------------------
  // readConfig throws on anything but ENOENT; an ABSENT file genuinely has no
  // shares/exports (the "samba removed" case in share-identity.ts is this exact
  // reading), so only a real read failure is an unreadable source.
  if (ctx.smbConfPath && wanted('smb')) {
    const smbText = await readConfigOr(ctx.smbConfPath)
    if (smbText.readable) {
      for (const share of parseSmbConf(smbText.text).shares) {
        if (onPoolPath(share.path))
          refs.push({ kind: 'smb', name: share.name, path: share.path })
      }
    }
    else {
      unreadableSources.push({ kind: 'smb', unreadable: true })
    }
  }

  if (ctx.exportsPath && wanted('nfs')) {
    const exportsText = await readConfigOr(ctx.exportsPath)
    if (exportsText.readable) {
      for (const exp of parseExports(exportsText.text)) {
        if (onPoolPath(exp.path))
          refs.push({ kind: 'nfs', name: exp.path, path: exp.path })
      }
    }
    else {
      unreadableSources.push({ kind: 'nfs', unreadable: true })
    }
  }

  // --- Unit-store kinds (backup, cloud, replication, schedules, AHR scrub) --
  if (ctx.systemdDir) {
    const dir = ctx.systemdDir
    if (wanted('backup')) {
      const backup = await readAllBackupTasks(dir)
      const backupListed = await listServiceUnitsChecked(dir, BACKUP_UNIT_KIND.prefix)
      if (!backupListed.complete)
        unreadableSources.push({ kind: 'backup', unreadable: true })
      for (const task of backup) {
        for (const archive of task.archives ?? []) {
          if (onPoolPath(archive.path)) {
            refs.push({ kind: 'backup', name: task.name, path: archive.path })
          }
          else if (effectiveArchiveKind(archive) === 'img') {
            // An `img` archive's source may be a ZVOL DEVICE (`/dev/zvol/<pool>/<vol>`),
            // which is not a path under a mountpoint — match it by its dataset name.
            const dataset = zvolDatasetFromPath(archive.path)
            if (dataset && datasetOnPool(dataset, ctx.pool))
              refs.push({ kind: 'backup', name: task.name, path: archive.path })
          }
        }
      }
    }

    if (wanted('cloud')) {
      const cloud = await readAllCloudTasks(dir)
      const cloudListed = await listServiceUnitsChecked(dir, CLOUD_UNIT_KIND.prefix)
      if (!cloudListed.complete)
        unreadableSources.push({ kind: 'cloud', unreadable: true })
      for (const task of cloud) {
        if (onPoolPath(task.source))
          refs.push({ kind: 'cloud', name: task.name, path: task.source })
      }
    }

    if (wanted('replication')) {
      const replication = await readAllReplicationTasks(dir)
      if (!replication.complete)
        unreadableSources.push({ kind: 'replication', unreadable: true })
      for (const task of replication.tasks) {
        if (task.source.pool === ctx.pool) {
          const dataset = task.source.dataset === '' ? ctx.pool : `${task.source.pool}/${task.source.dataset}`
          refs.push({ kind: 'replication', name: task.name, path: dataset })
        }
        // A LOCAL target on this pool (stage-3 `location.kind` defaults to local):
        // a remote target's zfs recv runs on the other node and does not live here.
        const location = task.target.location
        if (task.target.pool === ctx.pool && (location === undefined || location.kind === 'local')) {
          const dataset = task.target.dataset ?? ''
          const targetPath = dataset === '' ? ctx.pool : `${task.target.pool}/${dataset}`
          refs.push({ kind: 'replication', name: task.name, path: targetPath })
        }
      }
    }

    if (wanted('snapshot-schedule')) {
      const schedules = await readScheduleList(dir)
      if (!schedules.complete)
        unreadableSources.push({ kind: 'snapshot-schedule', unreadable: true })
      for (const schedule of schedules.schedules) {
        if (schedule.target.kind === 'zfs' && datasetOnPool(schedule.target.dataset, ctx.pool))
          refs.push({ kind: 'snapshot-schedule', name: schedule.name, path: schedule.target.dataset })
        if (schedule.target.kind === 'ahr' && schedule.target.pool === ctx.pool)
          refs.push({ kind: 'snapshot-schedule', name: schedule.name, path: schedule.target.pool })
      }
    }

    // The node-level AHR scrub timer lists the pools it scrubs. An ABSENT unit
    // is no schedule; an unreadable unit dir, or a unit FILE that exists but
    // does not parse as ours, means the pool list could not be read and is
    // disclosed (never assumed absent).
    if (wanted('scrub-schedule')) {
      const scrubListed = await listServiceUnitsChecked(dir, 'anas-scrub')
      const scrub = await readScrubSchedule(dir)
      if (!scrubListed.complete || (scrubListed.files.includes(SCRUB_SERVICE_NAME) && scrub === null)) {
        unreadableSources.push({ kind: 'scrub-schedule', unreadable: true })
      }
      else if (scrub && scrub.pools.includes(ctx.pool)) {
        refs.push({ kind: 'scrub-schedule', name: 'ANAS scrub timer', path: ctx.pool })
      }
    }
  }

  // --- ANAS mounts (fstab) whose mountpoint is under the pool — never the
  // pool's own filesystem (cr.31 D3) ------------------------------------------
  if (ctx.fstabPath && wanted('mount')) {
    const fstabText = await readConfigOr(ctx.fstabPath)
    if (fstabText.readable) {
      for (const entry of parseFstab(fstabText.text)) {
        if (onPoolPath(entry.mountpoint) && !isOwnMount(entry, ctx))
          refs.push({ kind: 'mount', name: entry.mountpoint, path: entry.mountpoint })
      }
    }
    else {
      unreadableSources.push({ kind: 'mount', unreadable: true })
    }
  }

  return { refs, unreadableSources }
}

/** The readable/unreadable split of one config file through `readConfig`. */
async function readConfigOr(
  path: string,
): Promise<{ readable: true, text: string } | { readable: false }> {
  try {
    return { readable: true, text: await readConfig(path) }
  }
  catch {
    return { readable: false }
  }
}

/**
 * The confirm-door sentence for ONE reference (story cr.24). The KIND and the
 * NAME are always present so the operator can act on the warning, and the path
 * says where it points at. ASCII only (the confirm body can become a job error
 * and a notification body line — the mojibake rule).
 */
export function poolReferenceWarning(ref: PoolReference): string {
  switch (ref.kind) {
    case 'smb':
      return `SMB share '${ref.name}' serves '${ref.path}', which is a path on this pool, and will stop working`
    case 'nfs':
      return `NFS export '${ref.name}' serves a path on this pool and will stop working`
    case 'backup':
      return `Backup task '${ref.name}' backs up '${ref.path}', which lives on this pool - the source disappears with it`
    case 'replication':
      return `Replication task '${ref.name}' references '${ref.path}' on this pool and will break`
    case 'cloud':
      return `Cloud-sync task '${ref.name}' syncs '${ref.path}', which lives on this pool`
    case 'snapshot-schedule':
      return `Snapshot schedule '${ref.name}' takes snapshots of '${ref.path}' on this pool`
    case 'scrub-schedule':
      return `Scrub schedule '${ref.name}' targets '${ref.path}' on this pool`
    case 'mount':
      return `Mount '${ref.name}' is mounted beneath this pool and will stop working`
  }
}

/**
 * The confirm-door sentence for ONE unreadable source (story cr.24): says
 * exactly which kind could not be read and invites a hand check — the "fail-open
 * is not fail-silent (D3)" disclosure pattern the LUN-claims reads already use.
 */
export function poolUnreadableWarning(source: UnreadablePoolSource, pool: string): string {
  switch (source.kind) {
    case 'smb':
      return `ANAS could not read smb.conf, so it could not check whether an SMB share references '${pool}'. If this node has SMB shares, verify their paths before confirming.`
    case 'nfs':
      return `ANAS could not read /etc/exports, so it could not check whether an NFS export references '${pool}'. If this node exports NFS, verify the exports before confirming.`
    case 'backup':
      return `ANAS could not read the backup task store, so it could not check whether a backup task sources from '${pool}'. If this node has backup tasks, verify their sources before confirming.`
    case 'replication':
      return `ANAS could not read the replication task store, so it could not check whether a replication task references '${pool}'. If this node has replication tasks, verify them before confirming.`
    case 'cloud':
      return `ANAS could not read the cloud-sync task store, so it could not check whether a cloud-sync task syncs a path on '${pool}'. If this node has cloud-sync tasks, verify their sources before confirming.`
    case 'snapshot-schedule':
      return `ANAS could not read the snapshot schedule store, so it could not check whether a snapshot schedule targets '${pool}'. If this node has snapshot schedules, verify them before confirming.`
    case 'scrub-schedule':
      return `ANAS could not read the scrub schedule, so it could not check whether it targets '${pool}'. If scrubs are scheduled, verify them before confirming.`
    case 'mount':
      return `ANAS could not read /etc/fstab, so it could not check whether a mount lives beneath '${pool}'. If this node has mounts, verify their mountpoints before confirming.`
  }
}

/**
 * The confirm-door warnings for a whole read: one per reference, then one per
 * unreadable source — built in the route, but the sentence style lives here so
 * Pools and AHR never drift.
 */
export function poolReferenceWarnings(read: PoolReferenceRead, pool: string): string[] {
  return [
    ...read.refs.map(poolReferenceWarning),
    ...read.unreadableSources.map(s => poolUnreadableWarning(s, pool)),
  ]
}

// ---------------------------------------------------------------------------
// Story cr.39 — what rides a MOUNT's path (EPICS §2 Mounts: "unmount
// cross-checks shares and backup tasks riding the path"; WAVE3-DESIGN §10 Q4:
// warn, never refuse). The SAME reader as the pools, scoped to the kinds a
// path can carry; the sentences say "this mount" instead of "this pool".
// ---------------------------------------------------------------------------

/**
 * The kinds that can reference a path on a mount: shares, exports, the
 * path-sourced tasks, and an fstab mount nested beneath it. Replication and
 * snapshot/scrub schedules address datasets by pool name, which an NFS/CIFS
 * mountpoint never is.
 */
export const MOUNT_REFERENCE_KINDS: ReadonlySet<PoolReferenceKind> = new Set<PoolReferenceKind>(['smb', 'nfs', 'backup', 'cloud', 'mount'])

/** Where the reference sources live — the same paths the share/task/mount routes edit. */
export interface MountReferenceContext {
  executor: CommandExecutor
  mountpoint: string
  smbConfPath?: string
  exportsPath?: string
  systemdDir?: string
  fstabPath?: string
}

/**
 * Everything that references a path at or under `mountpoint`, and every
 * source that could not be read. The mount's OWN fstab line is not a
 * reference to itself (cr.31 D3's rule, by mountpoint); a line mounted
 * beneath it is. Never throws.
 */
export async function readMountReferences(ctx: MountReferenceContext): Promise<PoolReferenceRead> {
  return readPoolReferences({
    executor: ctx.executor,
    // No dataset-matched kind is read (MOUNT_REFERENCE_KINDS), and a zvol
    // device path's dataset never starts with `/`, so the "pool" namespace
    // matches nothing here.
    pool: ctx.mountpoint,
    paths: [ctx.mountpoint],
    ownMounts: { mountpoints: [ctx.mountpoint] },
    kinds: MOUNT_REFERENCE_KINDS,
    ...(ctx.smbConfPath ? { smbConfPath: ctx.smbConfPath } : {}),
    ...(ctx.exportsPath ? { exportsPath: ctx.exportsPath } : {}),
    ...(ctx.systemdDir ? { systemdDir: ctx.systemdDir } : {}),
    ...(ctx.fstabPath ? { fstabPath: ctx.fstabPath } : {}),
  })
}

/** The confirm-door sentence for ONE reference riding a mount. ASCII only (the mojibake rule). */
export function mountReferenceWarning(ref: PoolReference): string {
  switch (ref.kind) {
    case 'smb':
      return `SMB share '${ref.name}' serves '${ref.path}', which is on this mount, and stops working while it is not mounted`
    case 'nfs':
      return `NFS export '${ref.name}' serves a path on this mount and stops working while it is not mounted`
    case 'backup':
      return `Backup task '${ref.name}' backs up '${ref.path}', which is on this mount - its source is missing while it is not mounted`
    case 'cloud':
      return `Cloud-sync task '${ref.name}' syncs '${ref.path}', which is on this mount - its source is missing while it is not mounted`
    case 'mount':
      return `Mount '${ref.name}' is mounted beneath this mount and stops working with it`
    default:
      return poolReferenceWarning(ref)
  }
}

/** The confirm-door sentence for ONE source that could not be read (the D3 disclosure). */
export function mountUnreadableWarning(source: UnreadablePoolSource, mountpoint: string): string {
  switch (source.kind) {
    case 'smb':
      return `ANAS could not read smb.conf, so it could not check whether an SMB share serves a path on '${mountpoint}'. If this node has SMB shares, verify their paths before confirming.`
    case 'nfs':
      return `ANAS could not read /etc/exports, so it could not check whether an NFS export serves a path on '${mountpoint}'. If this node exports NFS, verify the exports before confirming.`
    case 'backup':
      return `ANAS could not read the backup task store, so it could not check whether a backup task sources from '${mountpoint}'. If this node has backup tasks, verify their sources before confirming.`
    case 'cloud':
      return `ANAS could not read the cloud-sync task store, so it could not check whether a cloud-sync task syncs a path on '${mountpoint}'. If this node has cloud-sync tasks, verify their sources before confirming.`
    case 'mount':
      return `ANAS could not read /etc/fstab, so it could not check whether a mount lives beneath '${mountpoint}'. If this node has mounts, verify their mountpoints before confirming.`
    default:
      return poolUnreadableWarning(source, mountpoint)
  }
}
