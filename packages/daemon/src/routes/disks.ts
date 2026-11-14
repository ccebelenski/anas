import type { AhrDiskRole, AhrMemberState, Disk, DiskHealthStatus, VdevRole, VdevState } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { CommandTimeoutError } from '../executor/deadline.js'
import { parseByIdToKernel, parseDiskByIdListing, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { LSBLK_ARGS, parseLsblk, zfsMemberKernels } from '../parsers/lsblk.js'
import { isSmartctlProbeFailure, isSmartctlStandby, parseSmartctl, standbySmartData } from '../parsers/smartctl.js'
import { execZpool } from '../parsers/zpool-list.js'
import { readZpoolStatusAnswer } from '../parsers/zpool-status.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { iscsiServedSerialsStrict, normalizeSerial } from '../services/iscsi-held.js'
import { readSystemMountPools } from '../services/system-mounts.js'

const BY_ID_PATH_RE = /^\/dev\/disk\/by-(?:id|partuuid)\/(.+)$/
const KERNEL_PATH_RE = /^\/dev\/([a-z0-9]+)$/
const PART_SUFFIX_RE = /-part\d+$/
const BARE_KERNEL_RE = /^(?:sd|vd|hd)[a-z]+\d*$|^nvme\d+n\d+|^mmcblk\d+/

const BY_PARTUUID_PREFIX = '/dev/disk/by-partuuid/'
const BY_ID_PREFIX = '/dev/disk/by-id/'
/** Leaf states ZFS reports for a device it has open (see resolveLeafKernel). */
const OPEN_LEAF_STATES: ReadonlySet<VdevState> = new Set<VdevState>(['ONLINE', 'DEGRADED', 'AVAIL', 'INUSE'])
/** `ls` reads in the C locale: the absent-directory verdict reads its English message (cr3). */
const C_LOCALE = { env: { LC_ALL: 'C' } }
/** `ls` of a directory that does not exist (GNU coreutils' own sentence). */
const LS_NO_SUCH_DIR_RE = /No such file or directory/

/**
 * Resolve a `zpool status` leaf to its whole-disk KERNEL name so both sides of
 * the disk↔pool join canonicalize to the same key. A leaf's ZFS-chosen by-id
 * (its `devid`) is often a DIFFERENT form than the highest-priority by-id our
 * disk parser picks (e.g. ZFS says `wwn-0x…`, we display `ata-WDC…`); keying on
 * the by-id therefore drops the match on real hardware. The kernel device is
 * the one identity both agree on.
 *
 * Precedence, mirroring `zpool-status`'s own `diskId()` inputs:
 *   1. the leaf `id` (its `devid`, or a by-id derived from `path`/`name`),
 *      looked up in the complete by-id → kernel map;
 *   2. the leaf `path`: a `/dev/disk/by-id/<x>` or `/dev/disk/by-partuuid/<x>`
 *      form is stripped + mapped (partuuid GUIDs ride the same map — issue #32);
 *      a `/dev/sdX[N]` / `/dev/nvmeXnY[pN]` form is reduced to its parent kernel;
 *   3. the leaf `id` treated as a bare kernel name.
 * Returns null when nothing resolves — that leaf simply won't cross-reference.
 *
 * The kernel-name fallback (the bare kernel path of step 2, and step 3) is
 * decided by the leaf's state (cr3, review M7 and two re-reviews):
 *  - ONLINE, DEGRADED, AVAIL, INUSE — the device ZFS has open (OpenZFS
 *    `zpool_main.c`: "For hot spares, we use the terms 'INUSE' and
 *    'AVAILABLE' for online drives"): it resolves by its kernel name;
 *  - FAULTED, OFFLINE, REMOVED, UNAVAIL — the leaf may no longer be the
 *    device at that name (the `zpool offline`, swap, `zpool replace`
 *    workflow; the kernel reuses the name for the next disk): it resolves to
 *    the kernel name ONLY when `evidence` holds that disk — lsblk shows a
 *    `zfs_member` signature on it or one of its partitions, or an ONLINE leaf
 *    of the same pool already resolved to it. A blank replacement in the same
 *    slot carries neither, so it never inherits the leaf's pool, vdev and
 *    health; a present FAULTED member carries its label and keeps them.
 * `state` absent (a caller with no state, the trim probe) keeps the fallback.
 */
export function resolveLeafKernel(
  id: string,
  path: string,
  byIdToKernel: Map<string, string>,
  state?: VdevState,
  evidence?: ReadonlySet<string>,
): string | null {
  const kernelOk = (kernel: string): string | null =>
    state === undefined || OPEN_LEAF_STATES.has(state) || evidence?.has(kernel) ? kernel : null
  // 1. id is the leaf's devid (or by-id from path/name) in the common case.
  const fromId = byIdToKernel.get(id.replace(PART_SUFFIX_RE, ''))
  if (fromId)
    return fromId

  // 2. fall back to the raw path.
  if (path) {
    const byIdPath = path.match(BY_ID_PATH_RE)
    if (byIdPath) {
      const fromPath = byIdToKernel.get(byIdPath[1].replace(PART_SUFFIX_RE, ''))
      if (fromPath)
        return fromPath
    }
    const kernelPath = path.match(KERNEL_PATH_RE)
    if (kernelPath)
      return kernelOk(wholeDiskKernel(kernelPath[1]))
  }

  // 3. id may itself be a bare kernel name (ZFS had nothing better).
  if (BARE_KERNEL_RE.test(id))
    return kernelOk(wholeDiskKernel(id))

  return null
}

/** AHR context for a member disk, keyed by whole-disk kernel name. */
interface AhrDiskInfo {
  /** The AHR pool this disk belongs to. */
  pool: string
  /** Band-array label — the AHR parallel to a ZFS vdev name (see Disk.ahrArray). */
  array: string
  /**
   * The md state of EVERY array membership on this disk, one entry per band it
   * slices (the `memberState` the topology reader derives per AhrArrayMember).
   * A disk in bands r1–r3 carries three; a cache disk, which slices no band, or
   * a disk whose extra slice is not yet arrayed, none. computeHealth takes the
   * worst band (disks.2) — one disk, one badge.
   */
  memberStates: AhrMemberState[]
}

/**
 * The `Disk.ahrArray` band label for one AHR member disk: a single-band disk
 * reads "r1", a disk spanning bands reads the range "r1-r3", a hot spare
 * (which slices every band but carries no active membership) reads "spare",
 * and a read-cache disk (story ahrcache.1, §13) reads "cache".
 * Bands are contiguous from the bottom up by AHR construction (§2.6), so a
 * first→last range is faithful.
 *
 * A cache disk carries ONE slice that backs no band, so it has no band range
 * to render — but it is genuinely in use by the pool, and saying so is the
 * whole point: before ahrcache.1 it read `other` with no pool at all (GT-22),
 * which in the UI is an unrelated foreign disk.
 */
export function ahrBandLabel(bands: number[], role: AhrDiskRole): string {
  if (role === 'spare' || role === 'cache')
    return role
  const unique = [...new Set(bands)]
  if (unique.length === 0)
    return 'AHR'
  if (unique.length === 1)
    return `r${unique[0]}`
  // Only the span matters for the label; take min/max directly (no sort).
  return `r${Math.min(...unique)}-r${Math.max(...unique)}`
}

/** ZFS context for a pool-member disk, keyed by whole-disk kernel name. */
interface PoolDiskInfo {
  pool: string
  vdevName: string
  role: VdevRole
  state: VdevState
  read: number
  write: number
  checksum: number
}

/**
 * Class gravity for the one-row-per-disk pick below. One disk can carry leaves
 * of SEVERAL vdev classes at once (a data partition and a special partition —
 * the whole of the six-class pool the vdevs.1 live proof builds), and the disk
 * row carries ONE context. Ranked by what the loss of that class costs: special
 * and dedup take the WHOLE pool down with them and are the classes an operator
 * is least likely to know are on this disk; data is next; a log, spare or cache
 * device can be lost (a log, short of a crash) without losing data.
 */
const ROLE_GRAVITY: Record<VdevRole, number> = {
  special: 5,
  dedup: 4,
  data: 3,
  log: 2,
  spare: 1,
  cache: 0,
}

/**
 * How much this leaf's context deserves the disk's single row. The FAULT comes
 * first — a faulted special member with errors must never be shadowed by a
 * healthy sibling class on the same disk — then the error counts, and only then
 * class gravity as a deterministic tie-break between two equally healthy
 * contexts. The state tiers mirror `computeHealth`'s own ranking.
 */
function contextWeight(info: PoolDiskInfo): number {
  const stateRank = info.state === 'FAULTED' || info.state === 'UNAVAIL' || info.state === 'REMOVED'
    ? 2
    : info.state === 'OFFLINE' || info.state === 'DEGRADED'
      ? 1
      : 0
  const errors = Math.min(info.read + info.write + info.checksum, 1_000_000)
  return (stateRank * 10_000_000) + (errors * 10) + ROLE_GRAVITY[info.role]
}

/**
 * Fuse SMART pass/fail with live ZFS state into one health level — the signal
 * PVE's disk view never combines. Cheap: uses already-collected data, no extra
 * smartctl call per disk.
 *
 * `zfsUnreadable` (cr3): `zpool status` could not be read, so `info` being
 * absent says nothing — the disk may be a FAULTED pool member. Positive bad
 * evidence (SMART failed, a bad AHR band) still answers; a disk with no AHR
 * membership is then `unknown`, never healthy from SMART alone.
 */
export function computeHealth(
  smartHealthy: boolean | null,
  info: PoolDiskInfo | undefined,
  ahrStates?: readonly AhrMemberState[],
  zfsUnreadable = false,
): DiskHealthStatus {
  if (smartHealthy === false)
    return 'critical'
  if (info) {
    if (info.state === 'FAULTED' || info.state === 'UNAVAIL' || info.state === 'REMOVED'
      || info.read > 0 || info.write > 0) {
      return 'critical'
    }
    if (info.state === 'OFFLINE' || info.state === 'DEGRADED' || info.checksum > 0)
      return 'warning'
    // In a pool, ONLINE, no errors — ZFS and SMART agree it's fine.
    return 'healthy'
  }
  // AHR member state mirrors the ZFS mapping (disks.2): a disk md marked
  // faulty — or whose slice is gone entirely — is critical, a band rebuilding
  // onto a spare is a warning, and in_sync/spare change nothing (SMART keeps
  // its say). A disk slicing several bands is as sick as its WORST band. No
  // SMART-attribute interpretation here — smartd already does that.
  if (ahrStates?.some(s => s === 'faulty' || s === 'missing'))
    return 'critical'
  if (ahrStates?.includes('rebuilding'))
    return 'warning'
  // ZFS could not be read and the disk is no AHR member: it may be in a pool.
  if (zfsUnreadable && ahrStates === undefined)
    return 'unknown'
  // Not in a pool: only SMART tells us anything.
  return smartHealthy === true ? 'healthy' : 'unknown'
}

/**
 * The ECMAScript time range: `new Date(ms).toISOString()` throws outside it,
 * and on NaN. Wider than any real measurement, narrow enough that a garbage
 * clock cannot take a route down.
 */
const MAX_EPOCH_MS = 8.64e15

function isUsableEpochMs(ms: number | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS
}

/**
 * How long a disk list waits for the SMART probes that are due (cr.35). The
 * probe itself may take 12 s (§6.3, lowered at the cr.35 merge: a disk
 * waking for another reader), but the gateway hangs up on anasd at 20 s, so
 * a list that waited that long for one slow disk would reach the browser as
 * a 504 instead of a Disks view. After 8 s — below the probe's own 12 s
 * budget — the list answers with each disk's last reading (or none — health
 * `unknown`); the slow probe keeps running and its answer is in the cache
 * for the next pull. 8 s + the parallel base reads stays under the gateway's
 * 20 s.
 */
export const SMART_DISPLAY_WAIT_MS = 8_000

/**
 * Fetch all disk data: lsblk, by-id mapping, and pool membership, enriched with
 * cached identity + the fused SMART/ZFS `healthStatus`. Standalone (not a route
 * closure) so the Disks view AND the Dashboard status endpoint share ONE health
 * computation rather than diverging (Epic 2 reuse).
 */
export async function collectDisks(
  executor: CommandExecutor,
  diskIdentityCache: DiskIdentityCache,
  iscsiPaths: IscsiPaths = {},
): Promise<Disk[]> {
  return (await collectDiskInventory(executor, diskIdentityCache, iscsiPaths)).disks
}

/** The disk list, and which of the facts behind it could not be read (cr3). */
export interface DiskInventory {
  disks: Disk[]
  /**
   * Why `zpool status` could not be read, when it could not: every disk
   * without positive evidence of its use then reads status `unknown` and
   * health `unknown` (never `available`, never healthy from SMART alone).
   */
  zfsUnreadable?: string
  /**
   * Why this node's own LUN serials could not be read, when they could not:
   * every iSCSI-transport disk is then hands-off `iscsi-unverified`.
   */
  servedSerialsUnreadable?: string
  /**
   * Why the /dev/disk/by-id (or by-partuuid) listing could not be read, when
   * it could not (cr3): pool membership is then as unknown as for
   * {@link zfsUnreadable} (status and health `unknown`).
   */
  byIdUnreadable?: string
}

/**
 * The serials of the LUNs THIS node serves (story iscsi.6), or `null` when the
 * LIO tree could not be read (cr3). `iscsiServedSerials` answers an empty set
 * on a failed read, which would clear the hands-off mark; this reader keeps
 * "could not read" distinct so a missing fact can only tighten. Same read
 * (`readIscsiState`), same normalisation.
 */
async function readServedSerials(
  executor: CommandExecutor,
  iscsiPaths: IscsiPaths,
): Promise<{ serials: Set<string> } | { unreadable: string }> {
  // cr3 (merge, iSCSI): the iSCSI lane's strict reader — every TPG, and a
  // configfs tree that could not be listed in full is unreadable too. A
  // timeout is a failed read like any other: it marks the iSCSI-transport
  // disks `iscsi-unverified` and never fails the disk list.
  return iscsiServedSerialsStrict(executor, iscsiPaths)
}

/** {@link collectDisks}, with the facts it could not read named (cr3). */
export async function collectDiskInventory(
  executor: CommandExecutor,
  diskIdentityCache: DiskIdentityCache,
  iscsiPaths: IscsiPaths = {},
): Promise<DiskInventory> {
  const [lsblkResult, byIdResult, byPartuuidResult, statusResult, ahrPools, servedSerials, systemMountPools] = await Promise.all([
    executor.exec('/usr/bin/lsblk', LSBLK_ARGS),
    executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/'], C_LOCALE),
    // Some pools reference vdev members by GPT partition GUID (`zpool status`
    // leaves under /dev/disk/by-partuuid/ — issue #32); this listing is the only
    // way to resolve those to a kernel device. cr3: an ABSENT directory is an
    // honest empty (no partition carries a GUID link); any other failure is
    // a listing that could not be read (see listingUnreadable below).
    executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-partuuid/'], C_LOCALE)
      .catch((err: unknown) => ({ stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: -1 })),
    execZpool(executor, ['status', '-jv']),
    // Single-source AHR membership from the topology reader (never re-parse
    // mdstat here). Fail-soft: an AHR read error (or md absent) yields no AHR
    // membership and disks fall through to their existing status — the disks
    // endpoint must never crash because AHR is unreadable. A TIMEOUT is the
    // exception (cr.35r, mirroring the zpool-status read beside it): "no AHR
    // members" is a fact a hung read cannot establish, and rendering a member
    // disk as free on one is worse than a 503. Let it propagate.
    readAhrPools(executor).catch((err: unknown) => {
      if (err instanceof CommandTimeoutError)
        throw err
      return []
    }),
    // The serials of the LUNs THIS node serves (story iscsi.6). Costs two stats
    // on a node with no LIO (the read layer short-circuits before it touches
    // ZFS, PVE or the network). A failed read is kept distinct (cr3): it marks
    // every iSCSI-transport disk hands-off rather than none.
    readServedSerials(executor, iscsiPaths),
    // Which ZFS pools hold a filesystem at a system path (disks.r1) — the
    // mount table's own answer, read through the ONE strict findmnt reader.
    // Fail-soft on EVERY failure including a timeout, deliberately SOFTER than
    // the AHR read above: this fact only LABELS a disk `system` (it does not
    // decide membership), so "no system pools" on an unread table leaves every
    // disk exactly as it reads today. A label may never take the disks endpoint
    // down, and it may never make a disk read `available`.
    readSystemMountPools(executor).catch(() => null),
  ])

  const byIdMap = parseDiskByIdListing(byIdResult.stdout)
  // Complete by-id → kernel map (every ata-/wwn-/scsi-/nvme- form), used to
  // canonicalize both the zpool-status leaves and the physical disks to the
  // same kernel device before joining. See resolveLeafKernel.
  const byIdToKernel = parseByIdToKernel(byIdResult.stdout)
  // Fold the partuuid GUIDs into the same leaf-resolve map (a GUID key cannot
  // collide with a by-id name, and the listing shape is identical).
  if (byPartuuidResult.exitCode === 0) {
    for (const [guid, kernel] of parseByIdToKernel(byPartuuidResult.stdout)) {
      if (!byIdToKernel.has(guid))
        byIdToKernel.set(guid, kernel)
    }
  }

  // Rich ZFS context per disk (vdev/role/state/error counts), keyed by the
  // whole-disk KERNEL name — the identity both zpool-status and lsblk share.
  // A status that could not be read is kept as such (cr3): an empty map then
  // says nothing about membership.
  const poolInfo = new Map<string, PoolDiskInfo>()
  const statusAnswer = readZpoolStatusAnswer(statusResult)
  const zfsUnreadable = 'unreadable' in statusAnswer ? statusAnswer.unreadable : undefined
  // cr3 re-review item 3: the by-id (and by-partuuid) listings are how a pool
  // leaf finds its disk; one that could not be read makes membership as
  // unknown as a failed status does — a FAULTED member would read healthy, a
  // member would lose its pool and a member with no partitions read
  // `available`.
  // The by-partuuid listing counts only when a leaf is named through it
  // (issue #32's shape): elsewhere it resolves nothing either way.
  // The same condition holds for by-id (cr3 re-review 2 item 4): an absent
  // or empty by-id directory is an honest empty only while no leaf is named
  // through it.
  const leavesUnder = (prefix: string): boolean => 'pools' in statusAnswer && statusAnswer.pools.some(p =>
    p.vdevGroups.some(g => g.vdevs.some(v => v.disks.some(d => d.path.startsWith(prefix)))))
  const listingFor = (r: { exitCode: number, stdout: string, stderr: string }, dir: string, prefix: string, links: number): string | null => {
    if (!leavesUnder(prefix))
      return r.exitCode === 0 || prefix === BY_PARTUUID_PREFIX ? null : listingUnreadable(r, dir)
    const unreadable = listingUnreadable(r, dir)
    if (unreadable)
      return unreadable
    return links === 0 ? `the ${dir} listing is absent or empty while zpool status names leaves by ${prefix} paths` : null
  }
  const byIdUnreadable = listingFor(byIdResult, '/dev/disk/by-id/', BY_ID_PREFIX, parseByIdToKernel(byIdResult.stdout).size)
    ?? listingFor(byPartuuidResult, '/dev/disk/by-partuuid/', BY_PARTUUID_PREFIX, parseByIdToKernel(byPartuuidResult.stdout).size)
    ?? undefined
  const membershipUnreadable = zfsUnreadable ?? byIdUnreadable
  const zfsLabelledDisks = zfsMemberKernels(lsblkResult.stdout)
  if ('pools' in statusAnswer) {
    for (const pool of statusAnswer.pools) {
      // The disks a FAULTED/OFFLINE/REMOVED/UNAVAIL leaf may join by kernel
      // name (resolveLeafKernel): those carrying a ZFS label per lsblk, and
      // those an ONLINE leaf of this pool already resolved to.
      const evidence = new Set<string>(zfsLabelledDisks)
      for (const group of pool.vdevGroups) {
        for (const vdev of group.vdevs) {
          for (const disk of vdev.disks) {
            const kernel = disk.state === 'ONLINE' ? resolveLeafKernel(disk.id, disk.path, byIdToKernel, disk.state) : null
            if (kernel)
              evidence.add(kernel)
          }
        }
      }
      for (const group of pool.vdevGroups) {
        for (const vdev of group.vdevs) {
          for (const disk of vdev.disks) {
            const kernel = resolveLeafKernel(disk.id, disk.path, byIdToKernel, disk.state, evidence)
            if (!kernel)
              continue
            const candidate: PoolDiskInfo = {
              pool: pool.name,
              vdevName: vdev.name,
              role: group.role,
              state: disk.state,
              read: disk.readErrors,
              write: disk.writeErrors,
              checksum: disk.checksumErrors,
            }
            // Several leaves can resolve to ONE disk (partition-backed vdev
            // classes on a single device); keep the context that most
            // deserves the row rather than whichever class ZFS printed last.
            const standing = poolInfo.get(kernel)
            if (standing && contextWeight(standing) >= contextWeight(candidate))
              continue
            poolInfo.set(kernel, candidate)
          }
        }
      }
    }
  }

  // parseLsblk needs kernel-name → pool for its usage-status classification.
  const poolDisks = new Map<string, string>()
  for (const [kernel, info] of poolInfo)
    poolDisks.set(kernel, info.pool)

  // AHR membership per disk, keyed by the SAME whole-disk kernel name the
  // disk↔pool join uses (d.name). readAhrPools reports disks by their by-id;
  // canonicalize each to its kernel via the complete by-id → kernel map so both
  // AHR and physical disks agree on one identity (GT-2). A band member lives on
  // a partition, but AhrDisk already resolves to the whole disk + its band
  // slices — we read the bands straight off it, no partition re-parsing.
  const ahrInfo = new Map<string, AhrDiskInfo>()
  for (const pool of ahrPools) {
    // md member state per disk, collated across every band array — a disk
    // slicing several bands appears once per band. Keyed by the same by-id
    // the AhrDisk.ids below carry, so the two never disagree on a disk.
    const statesByDisk = new Map<string, AhrMemberState[]>()
    for (const array of pool.arrays) {
      for (const member of array.members) {
        const list = statesByDisk.get(member.disk) ?? []
        list.push(member.memberState)
        statesByDisk.set(member.disk, list)
      }
    }
    for (const disk of pool.disks) {
      const kernel = byIdToKernel.get(disk.id) ?? disk.id
      const bands = disk.partitions.map(p => p.band)
      ahrInfo.set(kernel, {
        pool: pool.name,
        array: ahrBandLabel(bands, disk.role),
        // Only LIVE array memberships carry a state; a cache disk or a sliced
        // band not yet arrayed contributes none ([] → no md opinion on health).
        memberStates: statesByDisk.get(disk.id) ?? [],
      })
    }
  }

  // A null (unreadable) mount table labels nothing: the set stays empty and
  // every disk keeps the status it has today (disks.r1 — a label, never a gate).
  const systemPools = new Set<string>(systemMountPools ? systemMountPools.zfs.keys() : [])

  // A failed status read leaves no disk `available` (cr3): a disk with no
  // positive answer (system, a Ceph OSD, an AHR membership below) may be a
  // pool member ZFS could not report, so it reads `unknown` — never offered.
  const disks = parseLsblk(lsblkResult.stdout, byIdMap, poolDisks, systemPools).map(d =>
    membershipUnreadable !== undefined && (d.status === 'available' || d.status === 'other')
      ? { ...d, status: 'unknown' as const }
      : d)

  // Lazy-load identity cache for all disks in parallel. The list doubles as
  // the topology refresh, which may prune entries — but only when it can
  // name the fleet: if the by-id listing came back empty or failed, every
  // disk id fell back to serial/kernel name, and pruning on such a list
  // would drop EVERY entry (the sleeping disks' preserved identities
  // included). The gate is the LISTING, not the fleet (fourth pass): one disk
  // without a by-id symlink (virtio without a serial, some USB bridges) must
  // not veto pruning for the whole cache for ever. Only the ids that resolved
  // through by-id count as present — a disk that fell back is named by a
  // fallback id, which is exactly the kind of entry that goes stale, so it is
  // pruned like any other absence once the trustworthy listing stops naming it.
  const enumerationPrunable = byIdMap.size > 0
  await diskIdentityCache.loadMany(
    disks.map(d => ({ id: d.id, path: d.path })),
    {
      prunable: enumerationPrunable,
      presentIds: enumerationPrunable
        ? disks.filter(d => byIdMap.has(d.name)).map(d => d.id)
        : undefined,
      waitMs: SMART_DISPLAY_WAIT_MS,
    },
  )

  // Enrich each disk with cached identity, ZFS context, and derived health.
  const enriched = disks.map((d): Disk => {
    const identity = diskIdentityCache.getCached(d.id)
    const smartHealthy = identity ? identity.smartHealthy : null
    // The reading is STALE when it is the disk's last known state, not a fresh
    // probe (it was asleep, or its probe failed): surfaced so the UI can mark
    // the health cell instead of presenting the value as current. Absent on a
    // fresh reading (undefined keys drop out of the JSON).
    const smartStale = identity?.stale === true ? true : undefined
    const smartStaleReason = smartStale ? identity?.staleReason : undefined
    // When the values on THIS payload were measured — the reading's own probe
    // on a fresh reading, the last measured one on a standby/probe-failed
    // carry-over. The UI shows "read <age> ago" from it. Absent on a disk
    // never measured, and the power mode with it (undefined drops from JSON).
    // A NaN, an Infinity or a value past the ECMAScript time range would make
    // `toISOString()` THROW (RangeError) and take the whole disk list with it.
    // The clock is injectable, so an unusable timestamp is a shape this route
    // must survive rather than assume away: unusable reads as "never
    // measured", which is exactly what an undated reading already means.
    const measuredAtMs = identity?.measuredAt
    const smartMeasuredAt = isUsableEpochMs(measuredAtMs)
      ? new Date(measuredAtMs).toISOString()
      : undefined
    // Pool context joins on the kernel name (d.name), NOT the display by-id
    // (d.id) — the by-id ZFS reports and the by-id we display can differ.
    const info = poolInfo.get(d.name)
    const zfsContext = info
      ? {
          vdevName: info.vdevName,
          vdevRole: info.role,
          zfsErrors: { read: info.read, write: info.write, checksum: info.checksum },
        }
      : { vdevName: null, vdevRole: null, zfsErrors: null }
    // AHR membership (never a ZFS pool member at the same time — ZFS wins if,
    // impossibly, both claim a disk). An AHR member is 'ahr_member' + its pool
    // + band label, parallel to how a ZFS member becomes 'pool_member'. Its md
    // member state flows into the SAME health fusion ZFS vdev state does
    // (disks.2), so a disk md marked faulty reads critical here exactly as it
    // does in the AHR pool view.
    const ahr = info ? undefined : ahrInfo.get(d.name)
    const ahrContext = ahr
      ? { status: 'ahr_member' as const, poolName: ahr.pool, ahrArray: ahr.array }
      : {}
    return {
      ...d,
      modelFamily: identity ? identity.modelFamily : null,
      formFactor: identity ? identity.formFactor : null,
      revision: identity?.firmwareVersion ?? d.revision,
      smartHealthy,
      smartStale,
      smartStaleReason,
      smartMeasuredAt,
      powerMode: identity?.powerMode,
      ...zfsContext,
      ...ahrContext,
      ...handsOffContext(d, 'serials' in servedSerials ? servedSerials.serials : null),
      healthStatus: computeHealth(smartHealthy, info, ahr?.memberStates, membershipUnreadable !== undefined),
    }
  })
  return {
    disks: enriched,
    ...(zfsUnreadable !== undefined && { zfsUnreadable }),
    ...(byIdUnreadable !== undefined && { byIdUnreadable }),
    ...('unreadable' in servedSerials && { servedSerialsUnreadable: servedSerials.unreadable }),
  }
}

/**
 * Whether an `ls -la <dir>` of a /dev/disk link directory could not be read
 * (cr3): exit 0 is the listing; a non-zero exit whose stderr is coreutils'
 * "No such file or directory" is the directory being ABSENT — udev creates
 * `/dev/disk/by-id` only when some disk has an id link (a VM whose virtio
 * disks carry no serial has none), so absent is an honest empty. Anything
 * else (a spawn failure, another error) is the sentence saying why it is
 * unreadable.
 */
function listingUnreadable(r: { exitCode: number, stdout: string, stderr: string }, dir: string): string | null {
  if (r.exitCode === 0)
    return null
  if (r.exitCode > 0 && r.stdout.trim() === '' && LS_NO_SUCH_DIR_RE.test(r.stderr))
    return null
  const line = r.stderr.trim().split('\n')[0]
  return `the ${dir} listing could not be read (ls exited ${r.exitCode}${line ? `: ${line}` : ''})`
}

/**
 * Why a composability answer read from `inv` cannot be trusted for `ids`, or
 * null (cr3 re-review item 2) — the ONE question every door that offers a
 * disk for writing asks before it calls a disk "not available": pool
 * membership could not be read (`zpool status` or the by-id listings), or a
 * requested disk is hands-off only because this node's LUNs could not be
 * read. A read that failed is never blamed on the request.
 */
export function inventoryUnreadableFor(inv: DiskInventory, ids: readonly string[]): string | null {
  const membership = inv.zfsUnreadable ?? inv.byIdUnreadable
  if (membership)
    return `the disk inventory could not tell pool members from free disks (${membership})`
  const unverified = inv.disks.find(d => ids.includes(d.id) && d.handsOff === 'iscsi-unverified')
  if (unverified)
    return `disk '${unverified.id}' could not be checked against this node's own iSCSI LUNs (${inv.servedSerialsUnreadable ?? 'the LUN read failed'})`
  return null
}

/**
 * Thrown by {@link collectComposableInventory}. A plain `Error` on purpose:
 * it passes through the guard's doors untouched, so at a ROUTE the server's
 * error handler answers it with {@link inventoryUnreadableRefusal} (409
 * `unreadable`, the ZFS doors' answer — the mapping is handed to the core
 * area's `server.ts`), and in a JOB it fails the job with its sentence.
 */
export class DiskInventoryUnreadableError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'DiskInventoryUnreadableError'
  }
}

/**
 * The disk list a composability check may judge `ids` against (cr3 re-review
 * item 2), or THROW {@link DiskInventoryUnreadableError} with
 * {@link inventoryUnreadableFor}'s sentence (see the error for how it is
 * answered).
 */
export async function collectComposableInventory(
  executor: CommandExecutor,
  diskIdentityCache: DiskIdentityCache,
  ids: readonly string[],
  iscsiPaths: IscsiPaths = {},
): Promise<Disk[]> {
  const inv = await collectDiskInventory(executor, diskIdentityCache, iscsiPaths)
  const unreadable = inventoryUnreadableFor(inv, ids)
  if (unreadable)
    throw new DiskInventoryUnreadableError(unreadable)
  return inv.disks
}

/** The ZFS doors' answer to an unreadable inventory: 409, reason `unreadable`. */
export function inventoryUnreadableRefusal(reason: string): { status: 409, code: 'CONFLICT', reason: 'unreadable', message: string } {
  return { status: 409, code: 'CONFLICT', reason: 'unreadable', message: `${reason}; refusing a disk it cannot judge` }
}

/**
 * The hands-off tag for a disk this node is serving to ITSELF (story iscsi.6).
 *
 * `status` is left alone on purpose: the disk really IS a blank SCSI device, and
 * lying about that in the inventory would be worse than the loop-back it
 * prevents. The tag is the honest form — "ANAS knows something about this disk
 * that the block layer does not" — and it is what the composer candidacy check
 * and the Disks badge both read.
 *
 * Only a disk that arrived over the ISCSI TRANSPORT is ever considered. A local
 * disk cannot be one of our LUNs, and a serial collision with a real SATA drive
 * would otherwise be enough to hide it from the composer.
 *
 * `servedSerials` null = this node's LUNs could not be read (cr3): every
 * iSCSI-transport disk is then hands-off `iscsi-unverified` — the missing fact
 * may only tighten, so the composer is never offered what might be this
 * node's own loop-back LUN.
 */
export function handsOffContext(
  disk: Pick<Disk, 'transport' | 'serial' | 'model'>,
  servedSerials: Set<string> | null,
): { handsOff?: Disk['handsOff'], handsOffReason?: string } {
  if (disk.transport !== 'iscsi')
    return {}
  if (servedSerials === null) {
    return {
      handsOff: 'iscsi-unverified',
      handsOffReason: 'This disk arrived over iSCSI, and ANAS could not read the LUNs this node serves, so it cannot rule out that this is one of them coming back over the node\'s own initiator. '
        + 'It is not offered for a pool until that read answers.',
    }
  }
  if (!disk.serial || servedSerials.size === 0)
    return {}
  if (!servedSerials.has(normalizeSerial(disk.serial)))
    return {}
  return {
    handsOff: 'iscsi-served-here',
    handsOffReason: `This disk is an iSCSI LUN served by THIS node${disk.model ? ` (backstore '${disk.model}')` : ''} — the node's own initiator is logged in to its own target. `
      + `It is not remote storage: building a pool on it would stack storage on top of itself. Manage it from the iSCSI screen.`,
  }
}

export async function diskRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, diskIdentityCache: DiskIdentityCache, iscsiPaths?: IscsiPaths },
) {
  const { executor, diskIdentityCache, iscsiPaths } = opts

  /** Fetch all disk data: lsblk, by-id mapping, and pool membership. */
  async function fetchDisks(): Promise<Disk[]> {
    return collectDisks(executor, diskIdentityCache, iscsiPaths)
  }

  server.get('/disks', async (_request, _reply) => {
    const disks = await fetchDisks()
    return { data: disks }
  })

  server.get<{ Params: { id: string } }>('/disks/:id', async (request, reply) => {
    const { id } = request.params
    const disks = await fetchDisks()
    const disk = disks.find(d => d.id === id)

    if (!disk) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Disk '${id}' not found` } }
    }

    return { data: disk }
  })

  server.get<{ Params: { id: string } }>('/disks/:id/smart', async (request, reply) => {
    const { id } = request.params
    const disks = await fetchDisks()
    const disk = disks.find(d => d.id === id)

    if (!disk) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Disk '${id}' not found` } }
    }

    // -n standby: a spun-down disk is reported as such, never woken to read SMART.
    const smartResult = await executor.exec('/usr/sbin/smartctl', [
      '-n',
      'standby',
      '-a',
      '--json',
      disk.path,
    ])

    if (isSmartctlStandby(smartResult))
      return { data: standbySmartData() }

    // cr3 (review POOLS-DISKS-L11): a probe that could not read the disk is
    // 503, never "SMART not supported"; output that is not smartctl's JSON is
    // 503 too, never a 500 from a throwing parse.
    let doc: Parameters<typeof isSmartctlProbeFailure>[0]
    try {
      doc = JSON.parse(smartResult.stdout) as Parameters<typeof isSmartctlProbeFailure>[0]
    }
    catch {
      reply.code(503)
      return { error: { code: 'UNAVAILABLE', message: `SMART data for disk '${id}' could not be read: smartctl exited ${smartResult.exitCode} without its JSON report` } }
    }
    if (isSmartctlProbeFailure(doc)) {
      const said = doc.smartctl?.messages?.find(m => m.severity === 'error')?.string
      reply.code(503)
      return { error: { code: 'UNAVAILABLE', message: `SMART data for disk '${id}' could not be read: smartctl exited ${smartResult.exitCode}${said ? ` (${said})` : ''}` } }
    }
    const smartData = parseSmartctl(doc as Parameters<typeof parseSmartctl>[0])
    return { data: smartData }
  })
}
