import type {
  AhrArray,
  AhrArrayMember,
  AhrArraySync,
  AhrBandBrief,
  AhrCapacity,
  AhrDisk,
  AhrDiskPartition,
  AhrExpansionIntent,
  AhrPoolState,
  ArrayLevel,
  ArrayState,
  DashboardWarning,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { MdadmDetailExport } from '../parsers/mdadm-detail.js'
import type { MdstatArray } from '../parsers/mdstat.js'
import { AhrPool, AhrPoolBrief } from '@anas/shared'
import { btrfsUsageArgs, parseBtrfsUsage } from '../parsers/btrfs-usage.js'
import { parseDiskByIdListing, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { optionsReadOnly, parseFindmnt } from '../parsers/findmnt.js'
import { lvIsActive, LVS_ARGS, parseLvsReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { hasArray, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { matchPartitionLabel } from './ahr-geometry.js'
import { readIntent } from './ahr-intent.js'
import { AHR_MIN_DISKS, floorToGranularity, isPvUnderSized } from './ahr-layout.js'
import { DEFAULT_MDADM_CONF } from './ahr-mdadm-conf.js'
import { isSubvolLayoutMount } from './ahr-snapshots.js'
import { readConfig } from './config-writer.js'

/**
 * AHR pool topology reader (Epic 11 + AHR, docs/AHR-DESIGN.md §3/§5.3).
 *
 * Reconstructs every AHR pool from the LIVE system — /proc/mdstat,
 * `mdadm --detail --export`, lsblk, /dev/disk/by-id, vgs/lvs, findmnt,
 * `btrfs filesystem usage` — because the system is the source of truth: ANAS
 * keeps no registry of what a pool IS (Principle 11, §5.3).
 *
 * Identity discipline (GT-2/GT-3): kernel `sdX`/`mdNNN` names are used only as
 * transient handles WITHIN one collection pass; everything reported is keyed
 * by by-id disk identities and superblock array names/UUIDs. Arrays are
 * discovered from /proc/mdstat (needed anyway for sync progress — GT-13's
 * sanctioned text exception) and identified via `--detail --export`
 * KEY=VALUE, tolerating both the bare and homehost-prefixed name forms.
 *
 * Everything is fail-open per pool: a missing layer (VG, LV, mount) degrades
 * that pool's report with advisories; it never throws the whole read away.
 */

const CAT = '/usr/bin/cat'
const MDADM = '/usr/sbin/mdadm'
const LSBLK = '/usr/bin/lsblk'
const LS = '/usr/bin/ls'
const VGS = '/usr/sbin/vgs'
const LVS = '/usr/sbin/lvs'
const PVS = '/usr/sbin/pvs'
const BTRFS = '/usr/bin/btrfs'
const FINDMNT = '/usr/bin/findmnt'

const MIB = 1024 ** 2

/**
 * lsblk args for the AHR stack view: the FULL device tree (partitions → md →
 * LVM), bytes, with partition labels. Distinct from the disks route's
 * LSBLK_ARGS (which flattens to physical disks).
 */
export const AHR_LSBLK_ARGS = ['-Jb', '-o', 'NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,PARTLABEL,MODEL,SERIAL']

/** findmnt args: real filesystems only (drops kernel pseudo-fs). */
export const AHR_FINDMNT_ARGS = ['--json', '--real']

// ---- lsblk tree (raw) ------------------------------------------------------

interface LsblkNode {
  name?: string
  type?: string
  size?: number
  fstype?: string | null
  mountpoint?: string | null
  partlabel?: string | null
  model?: string | null
  serial?: string | null
  children?: LsblkNode[]
}

export interface DiskInfo {
  name: string
  size: number
  model: string | null
  serial: string | null
}

export interface PartInfo {
  name: string
  size: number
  partlabel: string | null
  disk: DiskInfo
  partNumber: number | null
}

interface LvmInfo {
  /** device-mapper name, e.g. "ahr0-ahr0--vol". */
  name: string
  mountpoint: string | null
}

export interface LsblkIndex {
  partsByKernel: Map<string, PartInfo>
  lvmByDmName: Map<string, LvmInfo>
}

const PART_NUMBER_RE = /(\d+)$/

/**
 * Index one `lsblk AHR_LSBLK_ARGS` tree by kernel name: every partition (with
 * its label and its parent disk) and every LVM node. Exported as the single
 * home of this walk — destroy's partlabel sweep (issue #16) reads the SAME tree
 * this reader does, so the two can never disagree about which partitions of
 * which disk carry a pool's labels.
 */
export function indexLsblk(json: string): LsblkIndex {
  const index: LsblkIndex = { partsByKernel: new Map(), lvmByDmName: new Map() }
  let root: { blockdevices?: LsblkNode[] }
  try {
    root = JSON.parse(json)
  }
  catch {
    return index
  }

  const walk = (node: LsblkNode, disk: DiskInfo | null): void => {
    if (node.type === 'disk' && node.name) {
      disk = {
        name: node.name,
        size: node.size ?? 0,
        model: node.model?.trim() || null,
        serial: node.serial?.trim() || null,
      }
    }
    else if (node.type === 'part' && node.name && disk && !index.partsByKernel.has(node.name)) {
      const num = node.name.match(PART_NUMBER_RE)
      index.partsByKernel.set(node.name, {
        name: node.name,
        size: node.size ?? 0,
        partlabel: node.partlabel ?? null,
        disk,
        partNumber: num ? Number.parseInt(num[1], 10) : null,
      })
    }
    else if (node.type === 'lvm' && node.name && !index.lvmByDmName.has(node.name)) {
      index.lvmByDmName.set(node.name, { name: node.name, mountpoint: node.mountpoint ?? null })
    }
    for (const child of node.children ?? [])
      walk(child, disk)
  }
  for (const dev of root.blockdevices ?? [])
    walk(dev, null)
  return index
}

// ---- Assembly --------------------------------------------------------------

interface DiscoveredArray {
  pool: string
  band: number
  level: ArrayLevel
  mdstat: MdstatArray
  detail: MdadmDetailExport
}

const AHR_LEVELS = new Set<string>(['raid1', 'raid5', 'raid6'])

/** mdstat's sync verb → the shared schema's (only `recovery` differs). */
function toSyncAction(action: 'resync' | 'recovery' | 'reshape' | 'check'): AhrArraySync['action'] {
  return action === 'recovery' ? 'recover' : action
}

/**
 * dm name of `<vg>/<lv>` (device-mapper escapes `-` as `--`). Exported so the
 *  telemetry sampler (11.15) resolves the SAME `/dev/mapper/<dmName>` path this
 *  topology reader uses to find the pool's LV.
 */
export function dmName(vg: string, lv: string): string {
  return `${vg.replaceAll('-', '--')}-${lv.replaceAll('-', '--')}`
}

/** Trailing `[/subvol]` findmnt appends to a btrfs subvolume mount's source. */
const SUBVOL_SOURCE_SUFFIX_RE = /\[[^\]]*\]$/

/**
 * A findmnt mount source with any trailing btrfs-subvolume suffix removed:
 * `/dev/mapper/tank-tank--vol[/@data]` → `/dev/mapper/tank-tank--vol`. A source
 * with no suffix (a flat `subvol=/` mount, or a non-btrfs source) is unchanged.
 * Exported as the single home of this normalization: every findmnt-source
 * comparison against a mapper path (topology here, fs-grow in ahr-expand-exec)
 * MUST run through it — a raw `source === mapperPath` MISSES every §12
 * subvol-layout pool.
 */
export function stripSubvolSuffix(source: string): string {
  return source.replace(SUBVOL_SOURCE_SUFFIX_RE, '')
}

/**
 * The three MISSING-LAYER advisories, as functions rather than inline strings
 * so the create-status overlay can recognise and drop them (issue #7): while a
 * pool is being built — or after a create job died partway — "volume group not
 * found" is the expected consequence of where the job got to, not an
 * independent diagnosis, and repeating it alongside the job's real error buries
 * the one line the operator needs.
 */
export function missingVgAdvisory(pool: string): string {
  return `volume group '${pool}' not found — the LVM layer of this pool is missing or inactive`
}

/** @see missingVgAdvisory */
export function missingLvAdvisory(pool: string): string {
  return `logical volume '${pool}-vol' not found — the pool's filesystem volume is missing`
}

/** @see missingVgAdvisory */
export function notMountedAdvisory(pool: string): string {
  return `pool '${pool}' filesystem is not mounted`
}

/**
 * The `pool '<name>' ` subject the offline advisory opens with — defined once
 * because the dashboard card strips exactly this prefix to reuse the sentence
 * (a card supplies its own subject). Not a general advisory helper.
 */
function advisorySubject(pool: string): string {
  return `pool '${pool}' `
}

/**
 * The verdict clause that opens the offline advisory — the marker the dashboard
 * card matches on to lift the SAME sentence (see {@link buildAhrWarnings}), so
 * the two altitudes share one string instead of two that can drift.
 */
const OFFLINE_VERDICT = 'is OFFLINE — '

/** The evidence behind an `offline` verdict, as {@link readAhrPools} found it. */
interface OfflineDetail {
  /** Names of the band arrays that could not start, bands ascending. */
  cannotStart: string[]
  /** How many band arrays the pool has in total (the "N of M" denominator). */
  arrayCount: number
  lvName: string
  /** The LV is listed but its state field is not `a` (parsers/lvm-report). */
  lvInactive: boolean
}

/**
 * The `offline` advisory (issue #18) — WHY the volume is unreachable, stated as
 * evidence rather than diagnosis: which of the pool's band arrays cannot start
 * (named in full, never counted anonymously or truncated) and whether the LV
 * itself is inactive, then the consequence the badge alone cannot carry.
 *
 * It deliberately does NOT guess a cause. An inactive band array can be the GT-8
 * assemble-as-all-spares state (recoverable with `mdadm --run`) or genuinely
 * missing members; the per-array advisories say which, and inventing "missing
 * members" here would be a diagnosis we have not earned.
 */
function offlineAdvisory(pool: string, detail: OfflineDetail): string {
  const causes: string[] = []
  if (detail.cannotStart.length > 0) {
    causes.push(
      `${detail.cannotStart.length} of ${detail.arrayCount} band array${detail.arrayCount === 1 ? '' : 's'} `
      + `cannot start (${detail.cannotStart.join(', ')})`,
    )
  }
  if (detail.lvInactive)
    causes.push(`the logical volume '${detail.lvName}' is not active`)
  return `${advisorySubject(pool)}${OFFLINE_VERDICT}${causes.join(' and ')}; `
    + `the filesystem cannot be mounted and its data is unavailable`
}

/**
 * Whether an array's MEMBERSHIP is that of a build/rebuild rather than a fault:
 * no member is faulty, and there are at least as many member devices as raid
 * slots (the extra/high-numbered device is the spare md is rebuilding INTO).
 *
 * This is the one honest way to tell "redundancy is still being built" from
 * "a disk failed" when no progress line is present — a queued sync (issue #9)
 * or a slot count alone cannot. A removed disk shows FEWER members than slots;
 * a failed-but-attached disk shows `(F)`. Either way this returns false and the
 * array keeps its degraded verdict.
 *
 * THE SAME RULE IS IMPLEMENTED ONCE MORE, in sysfs, as `initial_build_shape()`
 * in packaging/anas-md-event.sh (issue #14): mdadm fires `DegradedArray` for
 * every array that STARTS degraded, which is every fresh RAID5/6 band, so the
 * monitor hook needs this discrimination too. It cannot import this function —
 * it runs from mdadm's monitor loop with no daemon and no node — so the two are
 * deliberately parallel and MUST be kept in step. Change one, change the other.
 */
function isBuildingMembership(md: MdstatArray): boolean {
  if (md.members.some(m => m.faulty))
    return false
  return md.raidDevices !== null && md.members.length >= md.raidDevices
}

/**
 * One band array's state, fused from mdstat (GT-8/GT-9 aware):
 *  - inactive (all-spares) → 'degraded'; the pool advisory names the
 *    condition (the schema deliberately gains no extra state for it).
 *  - a running `recovery` → 'recovering', checked BEFORE the degraded
 *    verdict: recovery is md actively (re)building redundancy — the initial
 *    RAID5/6 build ("building — pool usable now", §3), a §11 spare
 *    auto-failover, or a re-add/replace rebuild. It must NOT card as a
 *    degraded failure (§10); pool state fuses to 'rebuilding'.
 *  - a QUEUED sync (`resync=DELAYED`/`PENDING`) on an array with every slot
 *    populated and no faulty member → 'recovering' too (issue #9). The kernel
 *    serializes syncs across arrays that share physical disks, and a queued one
 *    prints NO progress line — so a mixed-media pool's second and third RAID5/6
 *    bands sit at `[n/n-1]` with `sync === null` and used to read as a DEGRADED
 *    ARRAY WITH A FAILED DISK on a pool minutes old. Live ground truth (pve5,
 *    issue #7): sysfs `sync_action` reads `recover` for the delayed arrays too,
 *    `mdadm --detail` says "clean, degraded, resyncing (DELAYED)" with
 *    `Failed Devices : 0` and a spare rebuilding.
 *  - only after ruling out a running OR queued recovery does reduced redundancy
 *    read as 'degraded' — the §8 disk-fault-during-reshape case stays degraded
 *    (its sync is a `reshape`, not a `recovery`) and DOES card.
 *  - a lingering faulty slot with EVERY raid slot in sync (the consumed-spare
 *    §11 shape) is NOT degraded: redundancy is intact; the consumed-spare
 *    advisory carries the "remove/replace the failed disk" message.
 *  - auto-read-only is NOT a fault (GT-9) — it maps to clean.
 *  - a running `check` keeps state clean/degraded; sync{} carries it.
 */
function arrayState(md: MdstatArray): ArrayState {
  if (!md.active)
    return 'degraded'
  if (md.sync?.action === 'recovery')
    return 'recovering'
  // A sync the kernel has QUEUED behind another array's (they share physical
  // disks) prints no progress line, so an initial RAID5/6 build reads `[n/n-1]`
  // with no sync — indistinguishable from a failed member by slot counts alone.
  // The discriminator is the membership: an initial build (or any rebuild) has
  // every slot populated and NO faulty member, while a real fault always leaves
  // an `(F)` member or one fewer member than raid slots (issue #9).
  if ((md.syncDelayed || md.syncPending) && isBuildingMembership(md))
    return 'recovering'
  const degraded = md.raidDevices !== null && md.activeDevices !== null
    ? md.activeDevices < md.raidDevices
    : md.members.some(m => m.faulty && !m.spare)
  if (degraded)
    return 'degraded'
  if (md.sync) {
    switch (md.sync.action) {
      // 'recovery' is handled above (it wins over the degraded verdict).
      case 'resync': return 'resyncing'
      case 'reshape': return 'reshaping'
      case 'check': return 'clean'
    }
  }
  return 'clean'
}

/**
 * Read every AHR pool from the live system. Returns schema-validated
 * {@link AhrPool} records; an empty list when no AHR arrays exist (or md is
 * absent entirely — fail-open, this is a guest).
 */
export async function readAhrPools(executor: CommandExecutor, mdadmConfPath?: string): Promise<AhrPool[]> {
  const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS)
  if (mdstatRes.exitCode !== 0)
    return []
  const mdArrays = parseMdstat(mdstatRes.stdout)
  if (mdArrays.length === 0)
    return []

  // Identify each array via --detail --export (superblock name/UUID — the
  // stable identities). Non-AHR-named arrays are foreign: not ours to report.
  const discovered: DiscoveredArray[] = []
  for (const md of mdArrays) {
    const res = await executor.exec(MDADM, mdadmDetailExportArgs(`/dev/${md.kernelName}`))
    const detail = parseMdadmDetailExport(res.stdout)
    const named = matchAhrArrayName(detail.name ?? detail.devName ?? '')
    if (!named)
      continue
    // Level: prefer the superblock's (export); mdstat's personality backs it
    // up for inactive arrays (which export may still report).
    const level = detail.level ?? md.personality ?? ''
    if (!AHR_LEVELS.has(level))
      continue
    discovered.push({ ...named, level: level as ArrayLevel, mdstat: md, detail })
  }
  if (discovered.length === 0)
    return []

  const [lsblkRes, byIdRes, vgsRes, lvsRes, pvsRes, findmntRes] = await Promise.all([
    executor.exec(LSBLK, AHR_LSBLK_ARGS),
    executor.exec(LS, ['-la', '/dev/disk/by-id/']),
    executor.exec(VGS, VGS_ARGS),
    executor.exec(LVS, LVS_ARGS),
    // pvs joins the SAME parallel batch, so the extra truth costs no latency.
    // It is what tells array capacity that LVM has not picked up (issue #13)
    // from capacity that is genuinely unprotected.
    executor.exec(PVS, PVS_ARGS),
    executor.exec(FINDMNT, AHR_FINDMNT_ARGS),
  ])

  const lsblk = indexLsblk(lsblkRes.stdout)
  const byIdMap = parseDiskByIdListing(byIdRes.stdout)
  const vgs = parseVgsReport(vgsRes.stdout)
  const lvs = parseLvsReport(lvsRes.stdout)
  const pvs = parsePvsReport(pvsRes.stdout)
  const mounts = parseFindmnt(findmntRes.stdout)

  // The ANAS-managed mdadm.conf — an ARRAY pin (by UUID) is the ANAS-authored
  // ownership marker (§2.6, config-is-the-API). Read fail-open: an unreadable
  // conf means "no pins", which only ever makes ownership STRICTER (a pool
  // then needs its VG to be claimed) — never looser.
  const mdadmConfDoc = parseMdadmConfDoc(
    await readConfig(mdadmConfPath ?? process.env.ANAS_MDADM_CONF ?? DEFAULT_MDADM_CONF).catch(() => ''),
  )

  // Group arrays by pool, bands ascending.
  const byPool = new Map<string, DiscoveredArray[]>()
  for (const d of discovered) {
    const list = byPool.get(d.pool) ?? []
    list.push(d)
    byPool.set(d.pool, list)
  }

  const poolEntries = [...byPool.entries()]
  poolEntries.sort(([a], [b]) => a.localeCompare(b))
  const pools: AhrPool[] = []
  for (const [poolName, arrayEntries] of poolEntries) {
    arrayEntries.sort((a, b) => a.band - b.band)

    // ---- Ownership gate (guest philosophy, §12) -----------------------------
    // A `<pool>-r<N>`-NAMED md array is claimed as an AHR pool ONLY with
    // evidence ANAS built (or can adopt) the full stack — otherwise a
    // hand-built `media-r1` would be seized as pool "media", card critical,
    // and offer to zero its superblocks + zap its disks. The evidence is
    // either:
    //   (a) the matching LVM VG exists — the adoptable mdadm→LVM→btrfs shape
    //       (stateless adoption stays intact, §5.3), OR
    //   (b) at least one of the pool's arrays is pinned by UUID in the
    //       ANAS-managed mdadm.conf — the ANAS-authored marker that keeps a
    //       genuinely FAILED ANAS pool (VG gone) still visible/reportable.
    // A name-collision array with NEITHER is foreign: ignored (a log line at
    // most), never reported.
    const vg = vgs.find(v => v.name === poolName)
    const pinned = arrayEntries.some(e => e.detail.uuid !== null && hasArray(mdadmConfDoc, e.detail.uuid))
    if (!vg && !pinned) {
      process.stderr.write(
        `ahr.topology: ignoring foreign md array(s) named '${poolName}-r*' — no LVM VG and not pinned in mdadm.conf; not an ANAS pool\n`,
      )
      continue
    }

    const advisories: string[] = []

    // ---- Arrays + membership ------------------------------------------------
    interface Membership { diskKernel: string, band: number, partSize: number, spare: boolean }
    const memberships: Membership[] = []
    const arrays: AhrArray[] = arrayEntries.map((entry) => {
      const members: AhrArrayMember[] = entry.mdstat.members.map((m) => {
        const part = lsblk.partsByKernel.get(m.device)
        const diskKernel = part?.disk.name ?? wholeDiskKernel(m.device)
        const diskId = byIdMap.get(diskKernel) ?? diskKernel
        const partNumber = part?.partNumber
          ?? (PART_NUMBER_RE.test(m.device) ? Number.parseInt(m.device.match(PART_NUMBER_RE)![1], 10) : null)
        // Partition identity: the by-id form when the disk resolved, else the
        // kernel path (defensive fallback — GT-2 keying is by-id first).
        const partition = byIdMap.has(diskKernel) && partNumber !== null
          ? `/dev/disk/by-id/${diskId}-part${partNumber}`
          : `/dev/${m.device}`
        memberships.push({
          diskKernel,
          band: entry.band,
          partSize: part?.size ?? 0,
          // Spare only counts on an ACTIVE array: an inactive array lists
          // EVERY member as (S) (GT-8) and must not relabel real members as
          // pool-level hot spares (§11 role fusion below).
          spare: m.spare && entry.mdstat.active,
        })
        return {
          disk: diskId,
          partition: partition as AhrArrayMember['partition'],
          memberState: m.faulty
            ? 'faulty' as const
            : m.spare
              ? 'spare' as const
              : m.replacement ? 'rebuilding' as const : 'in_sync' as const,
        }
      })

      const state = arrayState(entry.mdstat)
      // Consumed-spare detection (§11): a faulty slot alongside a rebuild
      // already running (md's automatic failover) or already finished (every
      // raid slot back in sync) means a spare was consumed by this band. The
      // advisory is view-level only — it deliberately does NOT card (§10).
      const slotsFull = entry.mdstat.raidDevices !== null && entry.mdstat.activeDevices !== null
        && entry.mdstat.activeDevices >= entry.mdstat.raidDevices
      const spareConsumed = entry.mdstat.active
        && entry.mdstat.members.some(m => m.faulty)
        && (slotsFull || entry.mdstat.sync?.action === 'recovery')
      if (!entry.mdstat.active) {
        advisories.push(`array ${poolName}-r${entry.band} is INACTIVE (assembled with all members as spares — the GT-8 post-power-loss state); the recovery ladder (mdadm --run, then --readwrite) is required`)
      }
      else if (spareConsumed) {
        const failed = members.filter(m => m.memberState === 'faulty').map(m => m.disk)
        advisories.push(`spare consumed by band ${entry.band} — add a new spare; remove/replace the failed disk${failed.length ? ` (${failed.join(', ')})` : ''}`)
      }
      else if (state === 'recovering' && (entry.mdstat.syncDelayed || entry.mdstat.syncPending)) {
        // Queued behind another band's sync (issue #9). Slot counts look
        // degraded and there is no progress line — say what it IS, and say that
        // there is nothing to do. NEVER the replace-the-failed-disk line: the
        // disks here are minutes old and nothing has failed.
        advisories.push(`array ${poolName}-r${entry.band} is building redundancy (queued behind another band) — no action needed`)
      }
      else if (state === 'degraded') {
        advisories.push(`array ${poolName}-r${entry.band} is degraded — replace the failed disk before a second failure`)
      }

      const sync: AhrArraySync | undefined = entry.mdstat.sync
        ? {
            action: toSyncAction(entry.mdstat.sync.action),
            percent: entry.mdstat.sync.percent,
            speedBytesSec: (entry.mdstat.sync.speedKibPerSec ?? 0) * 1024,
            etaSeconds: (entry.mdstat.sync.finishMinutes ?? 0) * 60,
          }
        : undefined

      // md semantics: the SMALLEST member slice defines the band — a member
      // whose topmost partition spilled past the boundary (geometry clamp on
      // a raw tail) must not inflate the band height and push derived
      // boundaries past every disk.
      const memberSizes = entry.mdstat.members
        .map(m => lsblk.partsByKernel.get(m.device)?.size ?? 0)
        .filter(s => s > 0)
      const heightBytes = memberSizes.length ? Math.min(...memberSizes) : 0
      return {
        device: `/dev/md/${poolName}-r${entry.band}` as AhrArray['device'],
        band: entry.band,
        level: entry.level,
        heightBytes,
        members,
        state,
        ...(sync ? { sync } : {}),
        // Transient convenience only — never persisted or keyed on (GT-2).
        kernelName: entry.mdstat.kernelName,
      }
    })

    // ---- Disks --------------------------------------------------------------
    // Band of each member partition, from live array membership.
    const bandByPartKernel = new Map<string, number>()
    for (const entry of arrayEntries) {
      for (const m of entry.mdstat.members)
        bandByPartKernel.set(m.device, entry.band)
    }
    const diskKernels = [...new Set(memberships.map(m => m.diskKernel))]
    diskKernels.sort()
    const disks: AhrDisk[] = diskKernels.map((kernel) => {
      const id = byIdMap.get(kernel) ?? kernel
      const mine = memberships.filter(m => m.diskKernel === kernel)
      // Every AHR partition on this disk, banded via array membership first,
      // then its member LABEL (covers not-yet-arrayed slices). The label is
      // read through matchPartitionLabel — the inverse of the function CREATE
      // writes labels with, and the same recognizer destroy's sweep uses
      // (issue #16), so no two AHR paths can disagree about what a member
      // partition of this pool looks like on disk.
      const partitions: AhrDiskPartition[] = []
      for (const [partKernel, part] of lsblk.partsByKernel) {
        if (part.disk.name !== kernel)
          continue
        const labeled = part.partlabel !== null ? matchPartitionLabel(poolName, part.partlabel) : null
        const band = bandByPartKernel.get(partKernel) ?? labeled?.band ?? null
        if (band === null)
          continue
        const device = byIdMap.has(kernel) && part.partNumber !== null
          ? `/dev/disk/by-id/${id}-part${part.partNumber}`
          : `/dev/${partKernel}`
        partitions.push({ device: device as AhrDiskPartition['device'], band, sizeBytes: part.size })
      }
      partitions.sort((a, b) => a.band - b.band)
      const info = [...lsblk.partsByKernel.values()].find(p => p.disk.name === kernel)?.disk
      const sizeBytes = info?.size ?? 0
      return {
        id,
        sizeBytes,
        usableBytes: floorToGranularity(sizeBytes),
        model: info?.model ?? null,
        serial: info?.serial ?? null,
        role: mine.length > 0 && mine.every(m => m.spare) ? 'spare' as const : 'member' as const,
        partitions,
      }
    })

    // ---- VG / LV ------------------------------------------------------------
    // `vg` resolved at the ownership gate above; a missing VG here means a
    // pinned-but-failed pool (state fuses to 'failed', §3).
    if (!vg)
      advisories.push(missingVgAdvisory(poolName))
    // The design's one-LV convention is `<pool>-vol`; tolerate a foreign-named
    // single LV in the VG rather than reporting nothing.
    const lv = lvs.find(l => l.vgName === poolName && l.name === `${poolName}-vol`)
      ?? lvs.find(l => l.vgName === poolName)
    if (!lv)
      advisories.push(missingLvAdvisory(poolName))

    // ---- Mount + btrfs ------------------------------------------------------
    const lvName = lv?.name ?? `${poolName}-vol`
    const mapperPath = `/dev/mapper/${dmName(poolName, lvName)}`
    // findmnt appends the mounted subvolume to a btrfs source
    // (`…-vol[/@data]`) — an exact `source === mapperPath` match MISSES every
    // §12 subvol-layout pool and falls through to the options-less lsblk
    // fallback below, which reads subvolLayout false. Strip the suffix so the
    // real mount (carrying subvol=@data) is found and its options preserved.
    const mount = mounts.find(m => stripSubvolSuffix(m.source) === mapperPath)
      ?? (lsblk.lvmByDmName.get(dmName(poolName, lvName))?.mountpoint
        ? { target: lsblk.lvmByDmName.get(dmName(poolName, lvName))!.mountpoint!, source: mapperPath, fstype: 'btrfs', options: '' }
        : null)
    const readonly = mount ? optionsReadOnly(mount.options) : false
    // §12 subvolume layout: read live from the mount's `subvol=` option — a
    // pool mounted `subvol=@data` carries the snapshot layout; a flat pool
    // (subvol=/, subvolid=5) or an unmounted pool does not. The mount is the
    // source of truth; nothing is precomputed or persisted (§5.3).
    const subvolLayout = mount ? isSubvolLayoutMount(mount.options) : false
    if (!mount)
      advisories.push(notMountedAdvisory(poolName))

    let btrfs = null
    if (mount) {
      const usageRes = await executor.exec(BTRFS, btrfsUsageArgs(mount.target))
      if (usageRes.exitCode === 0)
        btrfs = parseBtrfsUsage(usageRes.stdout)
    }

    // ---- Capacity (§3 — report what IS, GT-14: free space is READ) ----------
    const memberDisks = disks.filter(d => d.role === 'member')
    const rawBytes = memberDisks.reduce((sum, d) => sum + d.usableBytes, 0)
    // usable = the actual block capacity the filesystem sits on (LV size; the
    // btrfs device size equals it when mounted) — never the band-math ideal.
    const usableBytes = lv?.sizeBytes ?? btrfs?.deviceSizeBytes ?? 0
    const usedBytes = btrfs?.usedBytes ?? 0
    const freeBytes = btrfs?.freeEstimatedBytes ?? 0
    // Redundancy overhead: what the member slices carry beyond each array's
    // net size (parity/mirror copies + md metadata) — from observed sizes.
    let redundancyOverheadBytes = 0
    for (const entry of arrayEntries) {
      const arraySize = (entry.mdstat.blocks ?? 0) * 1024
      const memberBytes = entry.mdstat.members
        .filter(m => !m.spare && !m.replacement)
        .reduce((sum, m) => sum + (lsblk.partsByKernel.get(m.device)?.size ?? 0), 0)
      redundancyOverheadBytes += Math.max(0, memberBytes - arraySize)
    }
    // Pending (§5.2): member-disk capacity above the top array boundary —
    // physically present, not yet usable. Derived per disk from what is
    // actually partitioned, floored to the layout granularity.
    const tier = arrayEntries.some(e => e.level === 'raid6') ? 'ahr2' as const : 'ahr1' as const
    let pendingBytes = 0
    let pendingDisks = 0
    for (const d of memberDisks) {
      const covered = d.partitions.reduce((sum, p) => sum + p.sizeBytes, 0)
      const pend = floorToGranularity(Math.max(0, d.sizeBytes - MIB - covered))
      if (pend > 0) {
        pendingBytes += pend
        pendingDisks++
      }
    }
    if (pendingBytes > 0) {
      const needed = AHR_MIN_DISKS[tier] - pendingDisks
      advisories.push(needed <= 0
        ? `${(pendingBytes / 1024 ** 3).toFixed(0)} GiB of capacity is present but not yet part of the pool — run an expansion to add it`
        : `${(pendingBytes / 1024 ** 3).toFixed(0)} GiB of capacity is pending — no new usable space until ${needed} more disk${needed === 1 ? '' : 's'} with capacity above the top band ${needed === 1 ? 'is' : 'are'} added`)
    }
    // Capacity that IS inside a protected array but that LVM has not picked up:
    // the array grew and its PV was never resized (issue #13). It is emphatically
    // not `unprotectedWasted` — it sits under full RAID redundancy — so it is
    // reported as PENDING, the bucket that means "present, not yet usable", with
    // the concrete verb that reclaims it.
    let belowLvmBytes = 0
    for (const entry of arrayEntries) {
      const pv = pvs.find(p => p.name === `/dev/${entry.mdstat.kernelName}` || p.name === `/dev/md/${poolName}-r${entry.band}`)
      // Compared against dev_size — the same basis LVM itself reports, and the
      // same predicate the resume planner uses, so the advisory and the plan
      // can never disagree. The structural margin is what keeps a HEALTHY pool
      // quiet: every fully-resized PV is a few MiB under its device (metadata
      // + PE rounding), which a bare `<` comparison read as stranded capacity
      // and rendered as the nonsensical "0 GiB is grown into the RAID arrays".
      if (!pv || !isPvUnderSized(pv.sizeBytes, pv.devSizeBytes))
        continue
      belowLvmBytes += pv.devSizeBytes - pv.sizeBytes
    }
    if (belowLvmBytes > 0) {
      pendingBytes += belowLvmBytes
      advisories.push(
        `${(belowLvmBytes / 1024 ** 3).toFixed(0)} GiB is grown into the RAID arrays but not yet handed up to LVM — `
        + `resume or re-run the expansion to deliver it (the capacity is protected, just not yet usable)`,
      )
    }
    const unprotectedWastedBytes = Math.max(0, rawBytes - usableBytes - redundancyOverheadBytes - pendingBytes)
    const capacity: AhrCapacity = {
      rawBytes,
      usableBytes,
      usedBytes,
      freeBytes,
      redundancyOverheadBytes,
      unprotectedWastedBytes,
      pendingBytes,
    }

    // ---- Pool state fusion --------------------------------------------------
    const anyDegraded = arrays.some(a => a.state === 'degraded')
    const anyReshape = arrayEntries.some(e => e.mdstat.sync?.action === 'reshape')
    const anySync = arrayEntries.some(e => e.mdstat.sync?.action === 'resync' || e.mdstat.sync?.action === 'recovery')
    const anyCheck = arrayEntries.some(e => e.mdstat.sync?.action === 'check')
    // First-build (issue #7): EVERY band is laying down redundancy — each one
    // running or queued for a resync/recovery, with intact membership (no
    // faulty, no absent member) — which is exactly a freshly created pool. A
    // reshaping band fails this test (its action is 'reshape'), so an expansion
    // still fuses to 'expanding'; a single band syncing while others are clean
    // fails it too and stays 'rebuilding'.
    const allBuilding = arrayEntries.length > 0 && arrayEntries.every((e) => {
      const md = e.mdstat
      if (!md.active || !isBuildingMembership(md))
        return false
      if (md.syncDelayed || md.syncPending)
        return true
      return md.sync?.action === 'resync' || md.sync?.action === 'recovery'
    })
    // OFFLINE (issue #18): a band array that cannot START takes its PV with it,
    // so the VG comes up partial and the concatenated LV cannot be activated —
    // no data is reachable through ANY band, not even the bands that DID start.
    // That is categorically not `degraded` (reduced redundancy, still serving),
    // and the pve5 post-lockup shape proved why the distinction has to exist:
    // r1 active-degraded (4/5), r2 and r3 "active, FAILED, Not Started", VG
    // missing 2 of 3 PVs, LV not active — the volume was unreachable while the
    // badge said "degraded", which reads as reduced-redundancy-but-functioning.
    //
    // Two independent pieces of evidence, either one sufficient:
    //  - an INACTIVE band array (mdstat's `inactive`, the GT-8 shape);
    //  - the LV present but not active (lv_attr state field ≠ 'a').
    // A `null` from lvIsActive (attr column absent) reads as active — fail-safe:
    // an offline verdict is never manufactured from evidence we do not have.
    const cannotStart = arrayEntries.filter(e => !e.mdstat.active).map(e => `${poolName}-r${e.band}`)
    const lvInactive = lv !== undefined && lvIsActive(lv.attr) === false
    const offline = cannotStart.length > 0 || lvInactive

    let state: AhrPoolState
    if (!vg || !lv)
      state = 'failed'
    // Total unavailability OUTRANKS every other verdict below it: a pool that
    // serves nothing must not wear a reduced-redundancy (`degraded`), an
    // in-progress (`building`/`expanding`/`rebuilding`/`scrubbing`) or a
    // still-readable (`readonly`) badge. Only `failed` — the LVM layer gone
    // outright — ranks above it.
    else if (offline)
      state = 'offline'
    else if (readonly)
      state = 'readonly'
    else if (anyDegraded)
      state = 'degraded'
    else if (anyReshape)
      state = 'expanding'
    else if (allBuilding)
      state = 'building'
    else if (anySync)
      state = 'rebuilding'
    else if (anyCheck)
      state = 'scrubbing'
    else state = 'healthy'
    // Keyed off the FUSED state, so the advisory exists exactly when the badge
    // says offline. It leads the list: the pool-level verdict comes before the
    // per-band detail (a missing VG/LV reads `failed`, whose own advisories
    // already say the LVM layer is gone).
    if (state === 'offline')
      advisories.unshift(offlineAdvisory(poolName, { cannotStart, arrayCount: arrayEntries.length, lvName, lvInactive }))
    if (readonly)
      advisories.push(`pool '${poolName}' is mounted READ-ONLY — btrfs is protecting itself; diagnose before any remount`)

    pools.push(AhrPool.parse({
      name: poolName,
      ahrType: tier,
      // When unmounted there is no mountpoint to report; the LV device path is
      // the honest "where the filesystem lives" answer (never fabricated).
      mountpoint: mount?.target ?? `/dev/${poolName}/${lvName}`,
      mounted: mount != null,
      disks,
      arrays,
      vg: {
        name: poolName,
        sizeBytes: vg?.sizeBytes ?? 0,
        freeBytes: vg?.freeBytes ?? 0,
      },
      lv: {
        name: lvName,
        sizeBytes: lv?.sizeBytes ?? 0,
      },
      capacity,
      state,
      subvolLayout,
      advisories,
    }))
  }

  return pools
}

// --- Dashboard warnings (story 11.10, AHR-DESIGN §10) ------------------------

/**
 * A per-pool decoration applied between the live read and the dashboard
 * projections — how the create-job status overlay (issue #7) reaches the
 * /v1/status sources without this module importing it. Injected as a function
 * ON PURPOSE: the topology reader is pure system truth and must not grow a
 * dependency on the job queue (nor a cycle through the overlay that consumes
 * its advisories). Default is identity, so every existing caller is unchanged.
 */
export type AhrPoolDecorator = (pool: AhrPool) => AhrPool

/**
 * Attach a pool's expansion intent AND mirror it into `advisories[]`.
 *
 * The ONE place the intent is fused onto a pool read, because the two consumers
 * disagreed before: a halted expansion raised a dashboard card while the pool's
 * own `advisories[]` came back EMPTY, so the Hybrid RAID view showed a pool with
 * a stalled expansion and nothing to say about it. Anything worth a card is
 * worth an advisory — they are the same fact at two altitudes.
 *
 * Only `halted` advises: 'running' is an in-progress operation that rides the
 * jobs strip (§10 — in-progress states deliberately do not card), and 'done' /
 * 'abandoned' intents are cleared rather than displayed.
 */
export function withExpansionIntent(pool: AhrPool, intent: AhrExpansionIntent | null): AhrPool {
  if (!intent)
    return pool
  const advisories = intent.state === 'halted'
    ? [
        ...pool.advisories,
        `expansion is HALTED — Resume (recompute and continue) or Abandon it; no new capacity is delivered until one of the two runs`,
      ]
    : pool.advisories
  return { ...pool, expansion: intent, advisories }
}

/**
 * Which array/band + which member, for the degraded card. Every degraded
 * array in the pool is named (the card stays ONE per pool); a degraded array
 * with no faulty member listed (e.g. a member gone entirely, or the GT-8
 * inactive state) reads "missing a member". Disk ids are never truncated.
 *
 * Bands merely BUILDING redundancy never reach here: {@link arrayState} resolves
 * a running or queued recovery with intact membership to 'recovering' (issue
 * #9), so this function only ever describes a real fault.
 */
function degradedDetail(pool: AhrPool): string {
  const parts: string[] = []
  for (const array of pool.arrays) {
    if (array.state !== 'degraded')
      continue
    const name = `${pool.name}-r${array.band} (band ${array.band})`
    const faulty = array.members.filter(m => m.memberState === 'faulty')
    if (faulty.length > 0)
      parts.push(`array ${name} member ${faulty.map(m => `'${m.disk}'`).join(', ')} ${faulty.length === 1 ? 'is' : 'are'} faulty`)
    else
      parts.push(`array ${name} is missing a member`)
  }
  return parts.length > 0 ? parts.join('; ') : 'an array is degraded'
}

/**
 * Dashboard warning cards for AHR pools (story 11.10, AHR-DESIGN §10 — the
 * replication "only failures card" policy): ONE target-first card per pool in
 * a bad state — `offline` (naming which band arrays cannot start), `degraded`
 * (naming which array/band + which member), `failed`, `readonly`, or a HALTED
 * expansion (naming the Resume/Abandon verbs). Levels follow the §7.2 severity
 * table: offline/failed/readonly critical, degraded/halted warning. In-progress
 * expanding/rebuilding/scrubbing states ride the shared jobs strip — no card;
 * healthy/idle pools add NOTHING. View-level advisories (consumed spare,
 * flat-layout snapshots) deliberately do not card.
 */
export function buildAhrWarnings(pools: AhrPool[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const pool of pools) {
    const clauses: string[] = []
    let level: DashboardWarning['level'] = 'warning'
    if (pool.state === 'offline') {
      level = 'critical'
      // Reuse the pool's OWN offline advisory (readAhrPools built it where the
      // evidence is) minus the `pool '<name>' ` subject the card supplies
      // itself — so the card names the same arrays the Hybrid RAID view does
      // and the two can never disagree. The fallback covers a record that
      // reached here with the state but not the advisory (a decorated pool).
      const subject = advisorySubject(pool.name)
      const advisory = pool.advisories.find(a => a.startsWith(`${subject}${OFFLINE_VERDICT}`))
      clauses.push(advisory
        ? `${advisory.slice(subject.length)}; see the Hybrid RAID view`
        : `${OFFLINE_VERDICT}a band array cannot start or the volume is not active; its data is unavailable — see the Hybrid RAID view`)
    }
    else if (pool.state === 'failed') {
      level = 'critical'
      clauses.push('has FAILED — its LVM/filesystem layer is missing or inactive; see the Hybrid RAID view')
    }
    else if (pool.state === 'readonly') {
      level = 'critical'
      clauses.push('is mounted READ-ONLY — btrfs is protecting itself; diagnose before any remount')
    }
    else if (pool.state === 'degraded') {
      clauses.push(`is degraded — ${degradedDetail(pool)}; replace the failed disk before a second failure`)
    }
    if (pool.expansion?.state === 'halted')
      clauses.push('has a HALTED expansion — Resume (recompute-and-continue) or Abandon it in the Hybrid RAID view')
    if (clauses.length === 0)
      continue
    warnings.push({
      level,
      category: 'ahr',
      message: `AHR pool '${pool.name}' ${clauses.join('; ')}`,
      ref: pool.name,
    })
  }
  return warnings
}

/**
 * Collect the dashboard 'ahr' warnings from the live topology + the per-pool
 * expansion intent, fail-open (mirrors how replication/mount/backup warnings
 * are wired into GET /v1/status): an AHR read error degrades this source to no
 * warnings, never the dashboard; an unreadable intent file degrades only that
 * pool's halted-expansion card.
 */
export async function collectAhrWarnings(
  executor: CommandExecutor,
  intentDir?: string,
  decorate: AhrPoolDecorator = p => p,
): Promise<DashboardWarning[]> {
  try {
    const pools = await readAhrPools(executor)
    const withIntents = await Promise.all(pools.map(async (pool): Promise<AhrPool> => {
      try {
        const intent = await readIntent(pool.name, intentDir)
        return decorate(withExpansionIntent(pool, intent))
      }
      catch {
        return decorate(pool)
      }
    }))
    return buildAhrWarnings(withIntents)
  }
  catch {
    return []
  }
}

// --- Dashboard pool briefs (story 11.13, AHR-DESIGN §10 revision) ------------

/**
 * Derive the dashboard's per-pool briefs from the live topology — the §10
 * revision that puts healthy AHR pools in the headline Pools section with the
 * same structural presence ZFS pools get. Purely a projection of
 * {@link readAhrPools}' output (no re-parse, no extra system reads):
 *  - bands: each band array's index + RAID level + its REDUNDANT members
 *    (hot spares are excluded here — they are reported once at pool level so a
 *    "RAID5 × 4" reads as four data/parity members, not five);
 *  - spares: the pool's hot-spare disk(s), rendered in a labeled spare bay;
 *  - usedBytes: only when the pool is mounted (an unmounted pool has no btrfs
 *    usage read — capacity.usedBytes would be a placeholder 0, so it is OMITTED
 *    rather than reported as a wrong number).
 * Member/spare sizes are the raw DISK sizes (from the pool's disk list), the
 * value the UI tiles present.
 */
export function buildAhrPoolBriefs(pools: AhrPool[]): AhrPoolBrief[] {
  return pools.map((pool) => {
    const sizeById = new Map(pool.disks.map(d => [d.id, d.sizeBytes]))
    const bands: AhrBandBrief[] = pool.arrays.map((array) => {
      // Redundant members only — a hot spare rides as a member row (memberState
      // 'spare') but is not one of the array's data/parity slots.
      const members = array.members.filter(m => m.memberState !== 'spare')
      return {
        band: array.band,
        level: array.level,
        memberCount: members.length,
        members: members.map(m => ({ id: m.disk, sizeBytes: sizeById.get(m.disk) ?? 0 })),
        // 11.19 — PURE PROJECTION: heightBytes/state/sync are already in hand on
        // the AhrArray this brief is derived from; they were simply dropped.
        // No extra system read, no extra command, no new truth.
        heightBytes: array.heightBytes,
        state: array.state,
        ...(array.sync ? { sync: array.sync } : {}),
      }
    })
    const spares = pool.disks
      .filter(d => d.role === 'spare')
      .map(d => ({ id: d.id, sizeBytes: d.sizeBytes }))
    return AhrPoolBrief.parse({
      name: pool.name,
      state: pool.state,
      usableBytes: pool.capacity.usableBytes,
      // Used bytes are only trustworthy when btrfs usage was read (mounted).
      ...(pool.mounted ? { usedBytes: pool.capacity.usedBytes } : {}),
      mountpoint: pool.mountpoint,
      mounted: pool.mounted,
      subvolLayout: pool.subvolLayout,
      bands,
      spares,
    })
  })
}

/**
 * Capacity warning cards for AHR pools — PARALLEL CONSTRUCTION with ZFS pools
 * (the dashboard's `buildWarnings` 'capacity' category). Identical thresholds
 * (≥95% critical, ≥90% warning), identical wording shape ("AHR pool 'tank' is
 * 94% full"), same 'capacity' category, same ref-is-pool-name navigation the
 * AHR failure cards use — a filling AHR pool now warns exactly like a filling
 * ZFS pool.
 *
 * Percent is derived from the brief's usedBytes/usableBytes. An unmounted pool
 * (or one with no usedBytes read) carries NO usedBytes and produces NO card —
 * never a wrong number (11.13's omission discipline). A pool with no usable
 * capacity (usableBytes 0) likewise produces no card (no division by zero).
 */
export function buildAhrCapacityWarnings(briefs: AhrPoolBrief[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const pool of briefs) {
    // No usage read (unmounted) or no capacity → no honest percentage to card.
    if (pool.usedBytes === undefined || pool.usableBytes <= 0)
      continue
    const capacity = Math.round((pool.usedBytes / pool.usableBytes) * 100)
    if (capacity >= 95) {
      warnings.push({
        level: 'critical',
        category: 'capacity',
        message: `AHR pool '${pool.name}' is ${capacity}% full`,
        ref: pool.name,
      })
    }
    else if (capacity >= 90) {
      warnings.push({
        level: 'warning',
        category: 'capacity',
        message: `AHR pool '${pool.name}' is ${capacity}% full`,
        ref: pool.name,
      })
    }
  }
  return warnings
}

/**
 * Collect the dashboard AHR pool briefs from the live topology, fail-open
 * (mirrors {@link collectAhrWarnings} and every other GET /v1/status source):
 * any AHR read error degrades this source to `[]`, never the dashboard. The
 * dashboard must never degrade because AHR is unreadable.
 */
export async function collectAhrPoolBriefs(
  executor: CommandExecutor,
  mdadmConfPath?: string,
  decorate: AhrPoolDecorator = p => p,
): Promise<AhrPoolBrief[]> {
  try {
    return buildAhrPoolBriefs((await readAhrPools(executor, mdadmConfPath)).map(decorate))
  }
  catch {
    return []
  }
}
