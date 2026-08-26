import type { AhrPool, BackupArchiveConsistency } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import { isPathWithin, zvolDatasetFromPath, zvolDevicePath } from '@anas/shared'
import { PVE_STORAGE_CFG, readPveStorages } from '../parsers/pve-storage.js'
import { PVE_GUEST_VOLUME_RE } from './iscsi-ownership.js'
import { mountIndex, normalizePath, relativeTo } from './nested-filesystems.js'

/**
 * DERIVED per-source snapshot consistency (story backup2.3).
 *
 * The question this module answers is narrow: given an archive's source PATH,
 * can this run take a point-in-time snapshot of it, and if not, why not? The
 * answer is derived from the system — never configured. There is no override
 * field in this cut, deliberately: a setting that let a source claim `snapshot`
 * on a filesystem that cannot provide one would be a lie the operator could
 * turn on.
 *
 * The derivation reads exactly two facts, both of which the daemon already has
 * cheap access to:
 *
 *   1. `findmnt --json` — the kernel mount table. It reads
 *      `/proc/self/mountinfo`, so it can NEVER hang, even on a dead NFS server
 *      (Epic 18's rule). The source path's filesystem is found by LONGEST-PREFIX
 *      match against the table, never by `stat`-ing the path — the hang trap
 *      applies here exactly as it does to the boundary walk.
 *   2. `readAhrPools()` — the live AHR topology, for the btrfs branch.
 *
 * The three verdicts:
 *
 *   ZFS   → `snapshot`. The source's filesystem is a ZFS dataset (findmnt
 *           `FSTYPE=zfs`, `SOURCE=<dataset>`). A plain SUBDIRECTORY of a dataset
 *           maps to `<dataset>` plus a relative path, so `/tank/media/photos`
 *           on dataset `tank/media` becomes
 *           `<mountpoint>/.zfs/snapshot/<s>/photos`. GT-51: that path is
 *           reachable with the default `snapdir=hidden` — no property is ever
 *           changed.
 *   AHR   → `snapshot`, but ONLY on a `subvolLayout: true` pool. Its `@data`
 *           subvolume can be snapshotted read-only into `@snapshots/<name>`. A
 *           FLAT pre-layout pool (`subvolLayout: false`) has no `@snapshots` to
 *           put one in and no in-place migration (Epic 11 ruling), so it is
 *           honestly `live`.
 *   else  → `live`. Remote mounts (NFS/CIFS), foreign local filesystems
 *           (ext4/xfs), pmxcfs, a btrfs volume that is not an ANAS AHR pool, and
 *           anything the mount table cannot name.
 *
 * A `snapshot` verdict is a statement about the ROOT of the archive only. What
 * happens to filesystems NESTED under it is the expansion planner's problem
 * (backup-expansion.ts) — because a snapshot of the root captures the root's
 * filesystem and nothing else, on BOTH backends (GT-52 for btrfs; a ZFS child
 * dataset is simply a different filesystem).
 *
 * BLOCK SOURCES (story backup2.4). An `img` archive's path is a device or a
 * regular file, and the same three verdicts apply — with one branch added ahead
 * of the mount lookup:
 *
 *   ZVOL  → `snapshot`, via `zvolDevice`. A `/dev/zvol/<pool>/<vol>` path is not
 *           in the mount table and has no `.zfs/snapshot` directory, so the run
 *           snapshots the VOLUME (`zfs snapshot -r <pool>/<vol>@<label>`, the
 *           backup2.3 lifecycle unchanged) and reads the snapshot's own device
 *           node, published for the duration with `zfs set snapdev=visible` and
 *           restored with `zfs inherit snapdev` (GT-44/GT-45/GT-46).
 *           PVE territory is excluded first: a guest volume (`vm-N-disk-M`) or a
 *           zvol on a PVE-managed pool is hands-off, so it is honestly `live`.
 *   FILE  → exactly the directory rules above. An image file on a ZFS dataset or
 *           an AHR `@data` subvolume backs up from that filesystem's snapshot,
 *           with the file's own relative path under the snapshot root (GT-34: a
 *           regular file is a first-class `.img` source — no loop device).
 *   other → `live`, and a live block image is CRASH-CONSISTENT: the reason says
 *           so, because that is a different (and weaker) promise than a live
 *           file tree's.
 */

const FINDMNT = '/usr/bin/findmnt'

/** A ZFS findmnt SOURCE that is itself a snapshot (`<dataset>@<snap>`). */
const ZFS_SNAPSHOT_SOURCE_RE = /@/
/** `.zfs/snapshot/<name>` anywhere in a path — the automount tree. */
const ZFS_SNAPDIR_RE = /(?:^|\/)\.zfs\/snapshot(?:\/|$)/

/** The facts one derivation pass needs — read once, reused for every archive. */
export interface ConsistencyFacts {
  /** findmnt targets → their mount rows. */
  mounts: Map<string, FindmntNode>
  /** Live AHR topology (empty when it could not be read). */
  ahrPools: AhrPool[]
  /**
   * ZFS pool roots PVE manages, from `storage.cfg` (backup2.4). Only the zvol
   * branch needs them: PVE territory is read-only and hands-off, so ANAS never
   * takes a transient snapshot of a zvol PVE owns. Empty when the file could not
   * be read — which derives to `snapshot` for a non-guest-named volume, the same
   * posture `/v1/pools` already takes when storage.cfg is unreadable.
   */
  pvePools: Set<string>
}

/**
 * Read the facts once. Both probes fail OPEN: an unreadable mount table or an
 * unreadable AHR topology yields an empty map/list, which derives to `live` with
 * a reason that says the derivation could not see the system — never a silent
 * `snapshot` claim, and never an exception that fails a backup.
 */
export async function readConsistencyFacts(
  executor: CommandExecutor,
  readAhrPools: (executor: CommandExecutor) => Promise<AhrPool[]>,
  opts: { pveStorageCfg?: string } = {},
): Promise<ConsistencyFacts> {
  let mounts = new Map<string, FindmntNode>()
  try {
    const r = await executor.exec(FINDMNT, ['--json'])
    if (r.exitCode === 0)
      mounts = mountIndex(r.stdout)
  }
  catch {
    // fail open — derivation says `live` and names the reason
  }
  let ahrPools: AhrPool[] = []
  try {
    ahrPools = await readAhrPools(executor)
  }
  catch {
    ahrPools = []
  }
  // One file read, no `zfs list`: the zvol branch only needs the zfspool
  // storages, which `readPveStorages` resolves without mountpoints. Fail-open
  // (the parser already is): an unreadable storage.cfg yields an empty map.
  let pvePools = new Set<string>()
  try {
    pvePools = new Set((await readPveStorages(opts.pveStorageCfg ?? PVE_STORAGE_CFG)).keys())
  }
  catch {
    pvePools = new Set()
  }
  return { mounts, ahrPools, pvePools }
}

/**
 * The longest findmnt target that CONTAINS `path` — the filesystem the path
 * lives on. Pure prefix arithmetic over the table; the path itself is never
 * touched.
 */
export function filesystemOf(path: string, mounts: Map<string, FindmntNode>): FindmntNode | null {
  let best: FindmntNode | null = null
  let bestLen = -1
  for (const [target, node] of mounts) {
    if (!isPathWithin(target, path))
      continue
    const len = target === '/' ? 0 : target.length
    if (len > bestLen) {
      best = node
      bestLen = len
    }
  }
  return best
}

/**
 * Derive one source path's consistency from the facts. PURE — every test case in
 * the matrix (dataset root / dataset subdirectory / AHR subvol pool / flat AHR /
 * remote mount / plain path) is expressible as a mount table plus a pool list.
 */
export function deriveConsistency(path: string, facts: ConsistencyFacts): BackupArchiveConsistency {
  const source = normalizePath(path)

  // A source that is ALREADY inside somebody's `.zfs/snapshot/<s>` tree is a
  // frozen, read-only view: there is nothing to make consistent, and snapshotting
  // its dataset would point the archive at a `.zfs/snapshot/<new>/.zfs/…` path
  // that does not exist. This is checked on the PATH, not the mount table,
  // because the boundary scan deliberately DROPS those automount rows (GT-51).
  if (ZFS_SNAPDIR_RE.test(source)) {
    return {
      consistency: 'live',
      reason: `${source} is already inside a ZFS snapshot - it is read-only and unchanging, so nothing is snapshotted for it`,
    }
  }

  // --- Block sources (backup2.4) -----------------------------------------
  // A device path is answered BEFORE the mount table is consulted: `/dev` is
  // itself a mount (devtmpfs), so a longest-prefix match would gladly report a
  // zvol as "on udev (devtmpfs)" and call it live for the wrong reason.
  const zvol = zvolDatasetFromPath(source)
  if (zvol) {
    const pool = zvol.split('/')[0]
    const volume = zvol.split('/').at(-1) ?? zvol
    if (PVE_GUEST_VOLUME_RE.test(volume)) {
      return {
        consistency: 'live',
        reason: `${source} is a PVE guest volume - PVE owns its guests' disks and their snapshots, so ANAS takes none and the image is read live (crash-consistent)`,
      }
    }
    if (facts.pvePools.has(pool)) {
      return {
        consistency: 'live',
        reason: `${source} is on pool '${pool}', which PVE manages - PVE territory is hands-off, so ANAS takes no snapshot and the image is read live (crash-consistent)`,
      }
    }
    return {
      consistency: 'snapshot',
      reason: `${source} is the ZFS volume ${zvol}; the run snapshots the volume and reads the snapshot's own read-only device node (snapdev is published for the run and restored afterwards)`,
      backend: 'zfs',
      target: zvol,
      zvolDevice: zvolDevicePath(zvol),
    }
  }
  if (source.startsWith('/dev/')) {
    return {
      consistency: 'live',
      reason: `${source} is a block device ANAS does not manage - only a ZFS volume can be snapshotted, so the image is read live (crash-consistent: whatever the device holds while the run reads it)`,
    }
  }

  const node = filesystemOf(source, facts.mounts)

  if (!node) {
    return {
      consistency: 'live',
      reason: facts.mounts.size
        ? `no mount table entry contains ${source} - the filesystem it sits on could not be identified, so the backup is live`
        : 'the mount table could not be read, so no snapshot capability could be derived - the backup is live',
    }
  }

  // --- ZFS ---------------------------------------------------------------
  // A dataset mounted at `node.target`, with `node.source` the dataset name. A
  // SOURCE carrying an `@` is a `.zfs/snapshot/<s>` automount, i.e. the source
  // path is already inside somebody's snapshot — never snapshot that again.
  if (node.fstype === 'zfs') {
    if (ZFS_SNAPSHOT_SOURCE_RE.test(node.source)) {
      return {
        consistency: 'live',
        reason: `${source} is already inside a ZFS snapshot (${node.source}) - it is read-only and unchanging, so nothing is snapshotted for it`,
      }
    }
    return {
      consistency: 'snapshot',
      reason: `${source} is on the ZFS dataset ${node.source}; the run takes a recursive snapshot and backs up from ${node.target}/.zfs/snapshot/<snapshot>`,
      backend: 'zfs',
      target: node.source,
      mountpoint: node.target,
      relativePath: relativeTo(node.target, source),
    }
  }

  // --- AHR (btrfs) -------------------------------------------------------
  if (node.fstype === 'btrfs') {
    const pool = facts.ahrPools.find(p => normalizePath(p.mountpoint) === normalizePath(node.target))
    if (!pool) {
      return {
        consistency: 'live',
        reason: `${source} is on a btrfs filesystem (${node.source}) that is not an ANAS AHR pool - ANAS does not snapshot filesystems it does not manage, so the backup is live`,
      }
    }
    if (!pool.subvolLayout) {
      return {
        consistency: 'live',
        reason: `AHR pool '${pool.name}' predates the @data/@snapshots subvolume layout, so it has nowhere to put a snapshot (there is no in-place migration) - the backup is live`,
      }
    }
    if (!pool.mounted) {
      return {
        consistency: 'live',
        reason: `AHR pool '${pool.name}' is not mounted, so no snapshot can be taken - the backup is live`,
      }
    }
    return {
      consistency: 'snapshot',
      reason: `${source} is on AHR pool '${pool.name}'; the run takes a read-only btrfs snapshot of @data (and of every nested subvolume it backs up) and backs up from it`,
      backend: 'ahr',
      target: pool.name,
      mountpoint: normalizePath(pool.mountpoint),
      relativePath: relativeTo(pool.mountpoint, source),
    }
  }

  // --- Everything else ---------------------------------------------------
  return { consistency: 'live', reason: liveReason(source, node) }
}

/** The honest one-liner for a source that cannot be snapshotted. */
function liveReason(source: string, node: FindmntNode): string {
  const where = `${source} is on ${node.source} (${node.fstype})`
  if (node.fstype === 'nfs' || node.fstype === 'nfs4' || node.fstype === 'cifs' || node.fstype === 'smb3')
    return `${where}, a remote mount - the server owns its snapshots, ANAS cannot take one, so the backup is live`
  if (node.fstype === 'autofs')
    return `${where}, an armed automount that ANAS never triggers - the backup is live`
  if (node.target === '/etc/pve' || node.fstype.startsWith('fuse'))
    return `${where} - a FUSE filesystem cannot be snapshotted, so the backup is live`
  return `${where}, which has no snapshot mechanism ANAS can drive - the backup is live`
}

/** Derive consistency for a whole archive list, in order, from one fact read. */
export async function deriveArchiveConsistency(
  executor: CommandExecutor,
  archives: { path: string }[],
  readAhrPools: (executor: CommandExecutor) => Promise<AhrPool[]>,
): Promise<BackupArchiveConsistency[]> {
  const facts = await readConsistencyFacts(executor, readAhrPools)
  return archives.map(a => deriveConsistency(a.path, facts))
}

/**
 * Is this derived consistency a ZVOL source (backup2.4)? The one predicate the
 * runner, the expansion planner and the routes ask — so "a zvol is the one
 * snapshot source with no mountpoint" is stated once, not re-derived from the
 * shape of the object in three places.
 */
export function isZvolConsistency(c: BackupArchiveConsistency): boolean {
  return c.consistency === 'snapshot' && typeof c.zvolDevice === 'string' && c.zvolDevice.length > 0
}
