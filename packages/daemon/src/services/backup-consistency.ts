import type { AhrPool, BackupArchiveConsistency, PveStorageRef, SystemPoolFacts } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import { isPathWithin, pveStoragePath, zvolDatasetFromPath, zvolDevicePath } from '@anas/shared'
import { mountIndex, normalizePath, relativeTo } from './nested-filesystems.js'
import { loadPveFootprint, ownedDescendantIn, ownershipWithFallback } from './pve-footprint.js'

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
  /**
   * Live AHR topology (empty when it could not be read — read why with
   * {@link ahrUnreadable}).
   */
  ahrPools: AhrPool[]
  /**
   * The AHR topology read FAILED (unreadable, not "no AHR pools"). While true
   * every btrfs source derives `live` with a reason that says the topology
   * could not be read — a btrfs mount cannot be confirmed as (or excluded
   * from being) an ANAS AHR pool (cr.33c F1). Absent/`false` when the read
   * succeeded, or when the caller built the facts without one.
   */
  ahrUnreadable?: boolean
  /**
   * PVE footprint refs per pool root, from `storage.cfg` WITH the ZFS
   * mountpoint map (pvepool.1 — a `dir` storage's path resolves onto its
   * dataset). The ONE ownership answer {@link ownershipWithFallback} judges
   * each source's own dataset: PVE-owned (a storage root, a guest volume, a
   * dir-storage tree, the boot tree) means hands-off — no transient snapshot —
   * while a sibling dataset on a PVE pool is snapshotted like any other.
   * Empty when the file could not be read — see {@link storagesUnavailable},
   * which is what the derivation then consults: unreadable tightens to
   * hands-off, it never reads as "no PVE storages" (pvepool.1 review fix 1).
   */
  pveStorages: Map<string, PveStorageRef[]>
  /**
   * True when the storage.cfg read FAILED (UNREADABLE, not absent). While
   * true, every dataset is judged PVE-owned and every source derives `live`.
   */
  storagesUnavailable: boolean
  /**
   * Boot facts per imported pool, for the system rule of the footprint
   * predicate. `null` (or omitted) means UNREADABLE — not "no system pool" —
   * and the whole-pool fallback of {@link ownershipWithFallback} tightens
   * toward hands-off on any pool that hosts a zfspool storage. Missing facts
   * may only tighten the gate, never loosen it.
   */
  systemFacts?: SystemPoolFacts[] | null
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
  const { mounts, ahrPools, ahrUnreadable } = await readFilesystemFacts(executor, readAhrPools)
  // Per-source ownership is the ONE footprint service's answer (pvepool.1
  // review fixes): it assembles storage.cfg + the ZFS mountpoint list (with the
  // ANAS_STORAGE_CFG env override this route honours everywhere else) + the
  // boot facts, so the derivation judges sources exactly as the routes do —
  // no second loader that could drift. Its three-valued posture carries over:
  // absent storage.cfg fails open (empty refs), UNREADABLE comes back as
  // `storagesUnavailable` and the derivation tightens to hands-off; a failed
  // `zfs list` only disables `dir` resolution — the parser's secondary signal.
  const pve = await loadPveFootprint(executor, { pveStorageCfg: opts.pveStorageCfg })
  // Unreadable boot facts stay `null` here — NOT `[]`: the derivation tightens
  // toward hands-off through the whole-pool fallback, exactly like the
  // footprint service does.
  const systemFacts = pve.systemFactsUnavailable ? null : pve.systemFacts
  return { mounts, ahrPools, ahrUnreadable, pveStorages: pve.storagesByPool, storagesUnavailable: pve.storagesUnavailable, systemFacts }
}

/** The two facts that say which filesystem a path lives on (the mount table, the AHR pools). */
export interface FilesystemFacts {
  /** findmnt targets → their mount rows (empty when the table could not be read). */
  mounts: Map<string, FindmntNode>
  /** Live AHR topology (empty when it could not be read — see {@link ahrUnreadable}). */
  ahrPools: AhrPool[]
  /**
   * The AHR topology read FAILED (unreadable, not "no AHR pools"). While true
   * a btrfs mount cannot be confirmed as an ANAS pool, so the source-claim
   * builder takes no `ahr:` key and says why (cr.33c F1).
   */
  ahrUnreadable?: boolean
  /**
   * Why the mount table could not be read (the exit status and stderr), when
   * it could not — `mounts` is then empty. The source-claim builder names it
   * when a guard door must refuse rather than lock nothing (cr.64b1 (B)).
   */
  mountsUnreadable?: string
  /** Why the AHR topology could not be read, beside {@link ahrUnreadable}. */
  ahrUnreadableReason?: string
}

/** A command's stderr or an error's message, first line — how a sentence names a failed read. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0] || 'no stderr'
}

/**
 * Read the mount table and the AHR topology. Both fail OPEN to empty, and
 * {@link FilesystemFacts.ahrUnreadable} says which of the two could not be
 * read — the derivation then says `live` and names why, and the source-claim
 * builder takes no key and says why (the mount-table sentence; or the AHR
 * sentence for a btrfs mount it cannot confirm as an ANAS pool) — never an
 * exception that fails a run.
 */
export async function readFilesystemFacts(
  executor: CommandExecutor,
  readAhrPools: (executor: CommandExecutor) => Promise<AhrPool[]>,
): Promise<FilesystemFacts> {
  let mounts = new Map<string, FindmntNode>()
  let mountsUnreadable: string | undefined
  try {
    const r = await executor.exec(FINDMNT, ['--json'])
    if (r.exitCode === 0)
      mounts = mountIndex(r.stdout)
    else
      mountsUnreadable = `findmnt --json exited ${r.exitCode}: ${firstLine(r.stderr)}`
  }
  catch (err) {
    // fail open — derivation says `live` and names the reason
    mountsUnreadable = `findmnt --json failed: ${firstLine(err instanceof Error ? err.message : String(err))}`
  }
  let ahrPools: AhrPool[] = []
  let ahrUnreadable = false
  let ahrUnreadableReason: string | undefined
  try {
    ahrPools = await readAhrPools(executor)
  }
  catch (err) {
    ahrPools = []
    ahrUnreadable = true
    ahrUnreadableReason = firstLine(err instanceof Error ? err.message : String(err))
  }
  return {
    mounts,
    ahrPools,
    ahrUnreadable,
    ...(mountsUnreadable !== undefined ? { mountsUnreadable } : {}),
    ...(ahrUnreadableReason !== undefined ? { ahrUnreadableReason } : {}),
  }
}

/** The ANAS AHR pool mounted at a btrfs mount's target, or undefined (a btrfs volume ANAS does not manage). */
export function ahrPoolMountedAt(target: string, ahrPools: readonly AhrPool[]): AhrPool | undefined {
  return ahrPools.find(p => normalizePath(p.mountpoint) === normalizePath(target))
}

/**
 * The filesystem a source path lives on, as the lock keys name it (story
 * cr.33b): the same resolution {@link deriveConsistency} makes — a zvol device
 * path is its volume, otherwise the longest mount-table target containing the
 * path ({@link filesystemOf}), a `zfs` row its dataset, a `btrfs` row the AHR
 * pool mounted there — but asked about the filesystem itself, not whether a
 * run may snapshot it (a PVE-owned dataset is `live` to the derivation and
 * still the dataset a destroy would take away). `mountpoint` is the target the
 * path's mount has in the table (absent for a zvol, which has none). Null when
 * no table entry contains the path (an unreadable table reads as empty).
 */
export type SourceFilesystem
  = | { kind: 'zfs', dataset: string, mountpoint?: string }
    | { kind: 'ahr', pool: AhrPool, mountpoint: string }
    | { kind: 'other', mountpoint: string }

export function sourceFilesystemOf(path: string, facts: FilesystemFacts): SourceFilesystem | null {
  const source = normalizePath(path)
  const zvol = zvolDatasetFromPath(source)
  if (zvol)
    return { kind: 'zfs', dataset: zvol }
  const node = filesystemOf(source, facts.mounts)
  if (!node)
    return null
  if (node.fstype === 'zfs')
    return { kind: 'zfs', dataset: node.source, mountpoint: node.target }
  if (node.fstype === 'btrfs') {
    const pool = ahrPoolMountedAt(node.target, facts.ahrPools)
    if (pool)
      return { kind: 'ahr', pool, mountpoint: node.target }
  }
  return { kind: 'other', mountpoint: node.target }
}

/**
 * The longest findmnt target that CONTAINS `path` — the filesystem the path
 * lives on. Pure prefix arithmetic over the table; the path itself is never
 * touched — so a symlink is followed by nobody here. The lock-claim readers
 * hand it the path's REAL path (`realSourcePath`, services/source-claims.ts,
 * cr.64b1 (H)), and since cr.64b2-iii (O) so does the consistency derivation —
 * both sides of a mover see the same resolved path.
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
 *
 * cr.64b2-iii (O): `path` is the path the run READS — the mover's callers hand
 * it the REAL path (`realSourcePath`, the same resolution the lock derivation
 * performs), so a symlinked source is snapshotted on the filesystem it actually
 * lives on, the same one its keys were taken on. `displayPath` is the path as
 * the operator configured it — every sentence prints THAT, so the progress line
 * and the record name what the task says, not what it resolves to. Absent =
 * `path` (the pure-fact callers, whose path is already the whole story).
 */
export function deriveConsistency(
  path: string,
  facts: ConsistencyFacts,
  displayPath: string = path,
): BackupArchiveConsistency {
  const source = normalizePath(path)
  const shown = normalizePath(displayPath)

  // The ONE ownership answer, assembled once from the facts (the same
  // composition {@link loadPveFootprint} performs) — every judgement below,
  // including the descendant scan, asks through here and never re-states the
  // rule.
  const ownershipOf = (dataset: string) =>
    ownershipWithFallback(facts.pveStorages, facts.systemFacts ?? null, dataset, facts.storagesUnavailable)

  // A source that is ALREADY inside somebody's `.zfs/snapshot/<s>` tree is a
  // frozen, read-only view: there is nothing to make consistent, and snapshotting
  // its dataset would point the archive at a `.zfs/snapshot/<new>/.zfs/…` path
  // that does not exist. This is checked on the PATH, not the mount table,
  // because the boundary scan deliberately DROPS those automount rows (GT-51).
  if (ZFS_SNAPDIR_RE.test(source)) {
    return {
      consistency: 'live',
      reason: `${shown} is already inside a ZFS snapshot - it is read-only and unchanging, so nothing is snapshotted for it`,
    }
  }

  // --- Block sources (backup2.4) -----------------------------------------
  // A device path is answered BEFORE the mount table is consulted: `/dev` is
  // itself a mount (devtmpfs), so a longest-prefix match would gladly report a
  // zvol as "on udev (devtmpfs)" and call it live for the wrong reason.
  const zvol = zvolDatasetFromPath(source)
  if (zvol) {
    // pvepool.1: the VOLUME's own dataset is judged, not the pool — the ONE
    // shared predicate. A guest volume is its own case (its snapshots are PVE's
    // to take); any other owned kind (storage root, dir-storage tree, boot
    // tree) is equally hands-off, with the ownership reason as the sentence.
    // A volume on a sibling dataset of a PVE pool is snapshotted normally.
    // (No descendant scan: a zvol is a leaf — it cannot have child datasets.)
    const owned = ownershipOf(zvol)
    if (owned?.kind === 'guest-volume') {
      return {
        consistency: 'live',
        reason: `${shown} is a PVE guest volume - PVE owns its guests' disks and their snapshots, so ANAS takes none and the image is read live (crash-consistent)`,
      }
    }
    if (owned) {
      return {
        consistency: 'live',
        reason: `${shown} is inside PVE's footprint - ${owned.reason} - so the run takes no snapshot and the image is read live (crash-consistent)`,
      }
    }
    return {
      consistency: 'snapshot',
      reason: `${shown} is the ZFS volume ${zvol}; the run snapshots the volume and reads the snapshot's own read-only device node (snapdev is published for the run and restored afterwards)`,
      backend: 'zfs',
      target: zvol,
      zvolDevice: zvolDevicePath(zvol),
    }
  }
  if (source.startsWith('/dev/')) {
    return {
      consistency: 'live',
      reason: `${shown} is a block device ANAS does not manage - only a ZFS volume can be snapshotted, so the image is read live (crash-consistent: whatever the device holds while the run reads it)`,
    }
  }

  const node = filesystemOf(source, facts.mounts)

  if (!node) {
    return {
      consistency: 'live',
      reason: facts.mounts.size
        ? `no mount table entry contains ${shown} - the filesystem it sits on could not be identified, so the backup is live`
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
        reason: `${shown} is already inside a ZFS snapshot (${node.source}) - it is read-only and unchanging, so nothing is snapshotted for it`,
      }
    }
    // pvepool.1: an OWNED hosting dataset is not snapshotted — a storage-root
    // snapshot would sweep PVE's guest zvols, a dir-storage tree or a guest
    // subvol is PVE's own territory. A sibling dataset of a PVE pool is
    // snapshotted like any other.
    const owned = ownershipOf(node.source)
    if (owned) {
      return {
        consistency: 'live',
        reason: `${shown} is inside PVE's footprint - ${owned.reason} - so the run takes no snapshot and reads the live tree`,
      }
    }
    // pvepool.1 review fix 2: the run snapshots RECURSIVELY, so an UNOWNED
    // hosting dataset with an OWNED DESCENDANT (a storage registered on a
    // nested path, e.g. `tank/x/data` under `tank/x`) is equally hands-off —
    // `zfs snapshot -r` would sweep PVE's storage root and its guest disks.
    // The descendant candidates are the pool's ref paths, already in the
    // facts — no extra I/O — and the scan is the ONE helper
    // {@link ownedDescendantIn}.
    const descendant = ownedDescendantIn(
      (facts.pveStorages.get(node.source.split('/')[0]) ?? []).flatMap((r) => {
        // A bare-pool `zfspool` ref resolves to the pool root itself; a ref
        // with no footprint contributes no candidate.
        const p = pveStoragePath(r, node.source.split('/')[0])
        return p ? [p] : []
      }),
      node.source,
      ownershipOf,
    )
    if (descendant) {
      return {
        consistency: 'live',
        reason: `${shown} is on the ZFS dataset ${node.source}, which has PVE-owned ${descendant.name} beneath it - a recursive snapshot would include it (${descendant.ownership.reason}) - so the run takes no snapshot and reads the live tree`,
      }
    }
    return {
      consistency: 'snapshot',
      reason: `${shown} is on the ZFS dataset ${node.source}; the run takes a recursive snapshot and backs up from ${node.target}/.zfs/snapshot/<snapshot>`,
      backend: 'zfs',
      target: node.source,
      mountpoint: node.target,
      relativePath: relativeTo(node.target, source),
    }
  }

  // --- AHR (btrfs) -------------------------------------------------------
  if (node.fstype === 'btrfs') {
    // cr.33c F1: the AHR topology is UNREADABLE, so this btrfs mount cannot be
    // confirmed as (nor excluded from being) an ANAS pool — the honest reason,
    // the twin to the claims builder's sentence, never "not an ANAS AHR pool"
    // (which the empty-list–but-readable case gets to assert).
    if (facts.ahrUnreadable) {
      return {
        consistency: 'live',
        reason: `${shown} is on a btrfs filesystem (${node.source}) and the AHR topology could not be read, so it cannot be told whether it is an ANAS AHR pool - the backup is live`,
      }
    }
    const pool = ahrPoolMountedAt(node.target, facts.ahrPools)
    if (!pool) {
      return {
        consistency: 'live',
        reason: `${shown} is on a btrfs filesystem (${node.source}) that is not an ANAS AHR pool - ANAS does not snapshot filesystems it does not manage, so the backup is live`,
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
      reason: `${shown} is on AHR pool '${pool.name}'; the run takes a read-only btrfs snapshot of @data (and of every nested subvolume it backs up) and backs up from it`,
      backend: 'ahr',
      target: pool.name,
      mountpoint: normalizePath(pool.mountpoint),
      relativePath: relativeTo(pool.mountpoint, source),
    }
  }

  // --- Everything else ---------------------------------------------------
  return { consistency: 'live', reason: liveReason(shown, node) }
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
