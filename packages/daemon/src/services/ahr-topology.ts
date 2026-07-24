import type {
  AhrArray,
  AhrArrayMember,
  AhrArraySync,
  AhrCapacity,
  AhrDisk,
  AhrDiskPartition,
  AhrPoolState,
  ArrayLevel,
  ArrayState,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { MdadmDetailExport } from '../parsers/mdadm-detail.js'
import type { MdstatArray } from '../parsers/mdstat.js'
import { AhrPool } from '@anas/shared'
import { btrfsUsageArgs, parseBtrfsUsage } from '../parsers/btrfs-usage.js'
import { parseDiskByIdListing, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { optionsReadOnly, parseFindmnt } from '../parsers/findmnt.js'
import { LVS_ARGS, parseLvsReport, parseVgsReport, VGS_ARGS } from '../parsers/lvm-report.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { AHR_MIN_DISKS, floorToGranularity } from './ahr-layout.js'

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

interface DiskInfo {
  name: string
  size: number
  model: string | null
  serial: string | null
}

interface PartInfo {
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

interface LsblkIndex {
  partsByKernel: Map<string, PartInfo>
  lvmByDmName: Map<string, LvmInfo>
}

const PART_NUMBER_RE = /(\d+)$/

/** `<pool>-d<n>-b<band>` partition-label band suffix. */
const LABEL_BAND_RE = /-b(\d+)$/

function indexLsblk(json: string): LsblkIndex {
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

/** dm name of `<vg>/<lv>` (device-mapper escapes `-` as `--`). */
function dmName(vg: string, lv: string): string {
  return `${vg.replaceAll('-', '--')}-${lv.replaceAll('-', '--')}`
}

/**
 * One band array's state, fused from mdstat (GT-8/GT-9 aware):
 *  - inactive (all-spares) → 'degraded' — the pool advisory names the
 *    condition; the schema deliberately gains no extra state for it.
 *  - degraded takes precedence over a concurrent sync (the drilled
 *    "clean, degraded, reshaping" case reports degraded; sync{} still
 *    carries the reshape progress).
 *  - auto-read-only is NOT a fault (GT-9) — it maps to clean.
 *  - a running `check` keeps state clean/degraded; sync{} carries it.
 */
function arrayState(md: MdstatArray): ArrayState {
  if (!md.active)
    return 'degraded'
  const degraded
    = (md.raidDevices !== null && md.activeDevices !== null && md.activeDevices < md.raidDevices)
      || md.members.some(m => m.faulty)
  if (degraded)
    return 'degraded'
  if (md.sync) {
    switch (md.sync.action) {
      case 'resync': return 'resyncing'
      case 'reshape': return 'reshaping'
      case 'recovery': return 'recovering'
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
export async function readAhrPools(executor: CommandExecutor): Promise<AhrPool[]> {
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

  const [lsblkRes, byIdRes, vgsRes, lvsRes, findmntRes] = await Promise.all([
    executor.exec(LSBLK, AHR_LSBLK_ARGS),
    executor.exec(LS, ['-la', '/dev/disk/by-id/']),
    executor.exec(VGS, VGS_ARGS),
    executor.exec(LVS, LVS_ARGS),
    executor.exec(FINDMNT, AHR_FINDMNT_ARGS),
  ])

  const lsblk = indexLsblk(lsblkRes.stdout)
  const byIdMap = parseDiskByIdListing(byIdRes.stdout)
  const vgs = parseVgsReport(vgsRes.stdout)
  const lvs = parseLvsReport(lvsRes.stdout)
  const mounts = parseFindmnt(findmntRes.stdout)

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
          spare: m.spare,
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
      if (!entry.mdstat.active)
        advisories.push(`array ${poolName}-r${entry.band} is INACTIVE (assembled with all members as spares — the GT-8 post-power-loss state); the recovery ladder (mdadm --run, then --readwrite) is required`)
      else if (state === 'degraded')
        advisories.push(`array ${poolName}-r${entry.band} is degraded — replace the failed disk before a second failure`)

      const sync: AhrArraySync | undefined = entry.mdstat.sync
        ? {
            action: toSyncAction(entry.mdstat.sync.action),
            percent: entry.mdstat.sync.percent,
            speedBytesSec: (entry.mdstat.sync.speedKibPerSec ?? 0) * 1024,
            etaSeconds: (entry.mdstat.sync.finishMinutes ?? 0) * 60,
          }
        : undefined

      const heightBytes = Math.max(0, ...entry.mdstat.members.map(m => lsblk.partsByKernel.get(m.device)?.size ?? 0))
      return {
        device: `/dev/md/${poolName}-r${entry.band}` as AhrArray['device'],
        band: entry.band,
        level: entry.level,
        heightBytes,
        members,
        state,
        ...(sync ? { sync } : {}),
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
      // then the `-b<N>` label suffix (covers not-yet-arrayed slices).
      const partitions: AhrDiskPartition[] = []
      for (const [partKernel, part] of lsblk.partsByKernel) {
        if (part.disk.name !== kernel)
          continue
        const labelBand = part.partlabel?.startsWith(`${poolName}-`)
          ? part.partlabel.match(LABEL_BAND_RE)
          : null
        const band = bandByPartKernel.get(partKernel)
          ?? (labelBand ? Number.parseInt(labelBand[1], 10) : null)
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
    const vg = vgs.find(v => v.name === poolName)
    if (!vg)
      advisories.push(`volume group '${poolName}' not found — the LVM layer of this pool is missing or inactive`)
    // The design's one-LV convention is `<pool>-vol`; tolerate a foreign-named
    // single LV in the VG rather than reporting nothing.
    const lv = lvs.find(l => l.vgName === poolName && l.name === `${poolName}-vol`)
      ?? lvs.find(l => l.vgName === poolName)
    if (!lv)
      advisories.push(`logical volume '${poolName}-vol' not found — the pool's filesystem volume is missing`)

    // ---- Mount + btrfs ------------------------------------------------------
    const lvName = lv?.name ?? `${poolName}-vol`
    const mapperPath = `/dev/mapper/${dmName(poolName, lvName)}`
    const mount = mounts.find(m => m.source === mapperPath)
      ?? (lsblk.lvmByDmName.get(dmName(poolName, lvName))?.mountpoint
        ? { target: lsblk.lvmByDmName.get(dmName(poolName, lvName))!.mountpoint!, source: mapperPath, fstype: 'btrfs', options: '' }
        : null)
    const readonly = mount ? optionsReadOnly(mount.options) : false
    if (!mount)
      advisories.push(`pool '${poolName}' filesystem is not mounted`)

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
    let state: AhrPoolState
    if (!vg || !lv)
      state = 'failed'
    else if (readonly)
      state = 'readonly'
    else if (anyDegraded)
      state = 'degraded'
    else if (anyReshape)
      state = 'expanding'
    else if (anySync)
      state = 'rebuilding'
    else if (anyCheck)
      state = 'scrubbing'
    else state = 'healthy'
    if (readonly)
      advisories.push(`pool '${poolName}' is mounted READ-ONLY — btrfs is protecting itself; diagnose before any remount`)

    pools.push(AhrPool.parse({
      name: poolName,
      ahrType: tier,
      // When unmounted there is no mountpoint to report; the LV device path is
      // the honest "where the filesystem lives" answer (never fabricated).
      mountpoint: mount?.target ?? `/dev/${poolName}/${lvName}`,
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
      advisories,
    }))
  }

  return pools
}
