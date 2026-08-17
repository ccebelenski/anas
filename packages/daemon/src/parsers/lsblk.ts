/**
 * Parser for `lsblk -Jb -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINT,ROTA,PHY-SEC,LOG-SEC,WWN,VENDOR,REV` output.
 * Extracts: disk hardware info, partitions, system disk detection.
 */

import type { Disk, DiskPartition, DiskUsageStatus } from '@anas/shared'

/** The lsblk command args to use */
export const LSBLK_ARGS = ['-Jb', '-o', 'NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINT,ROTA,PHY-SEC,LOG-SEC,WWN,VENDOR,REV']

interface LsblkPartRaw {
  name: string
  type: string
  size: number
  fstype: string | null
  mountpoint: string | null
  /** lsblk nests descendants: a disk's partition can itself host an LVM node. */
  children?: LsblkPartRaw[]
}

interface LsblkDeviceRaw {
  'name': string
  'type': string
  'size': number
  'model': string | null
  'serial': string | null
  'tran': string | null
  'fstype': string | null
  'mountpoint': string | null
  'rota': boolean
  'phy-sec'?: number | null
  'log-sec'?: number | null
  'wwn'?: string | null
  'vendor'?: string | null
  'rev'?: string | null
  'children'?: LsblkPartRaw[]
}

interface LsblkOutput {
  blockdevices: LsblkDeviceRaw[]
}

/**
 * Maps kernel device names to by-id names.
 * e.g. { "sdb": "ata-WDC_WD2003FZEX-00SRLA0_WD-12345678" }
 */
export type ByIdMap = Map<string, string>

/**
 * Parse lsblk JSON output into Disk objects.
 * Filters to physical disks (type=disk), excluding CD-ROMs, zram, loop, etc.
 * @param json raw lsblk JSON output (string or pre-parsed object)
 * @param byIdMap mapping of kernel names to by-id identifiers (from disk-by-id parser)
 * @param poolDisks map of KERNEL names to the ZFS pool they belong to
 */
export function parseLsblk(
  json: string | LsblkOutput,
  byIdMap: ByIdMap,
  poolDisks: Map<string, string> = new Map(),
): Disk[] {
  const data: LsblkOutput = typeof json === 'string' ? JSON.parse(json) : json

  return data.blockdevices
    .filter(dev => dev.type === 'disk' && !dev.name.startsWith('zram') && !dev.name.startsWith('loop'))
    .map((dev) => {
      const id = byIdMap.get(dev.name) ?? dev.serial ?? dev.name
      const partitions = parsePartitions(dev.children ?? [])
      const isSystem = isSystemDisk(dev, partitions)
      // Pool membership is matched on the KERNEL name: the caller canonicalizes
      // each zpool-status leaf (whose ZFS-chosen by-id may differ from the one
      // we display) to its kernel device, so both sides join on `dev.name`.
      const poolName = poolDisks.get(dev.name) ?? null
      let status: DiskUsageStatus = 'available'
      if (isSystem)
        status = 'system'
      else if (poolName)
        status = 'pool_member'
      else if (hasCephOsd(dev.children))
        // A Ceph OSD owns the disk as surely as a ZFS pool does. It reports as
        // its own status rather than falling through to 'other', which reads
        // as "leftover partitions" and hides the claim.
        status = 'ceph_osd'
      else if (hasAnySignature(dev, partitions))
        // Any partition (including a leftover zfs_member label) or a whole-disk
        // filesystem means the disk is NOT empty. Such disks are never offered
        // for vdev creation — only genuinely blank disks are 'available', so a
        // user cannot accidentally clobber data. To reuse a non-empty disk it
        // must be wiped first (e.g. destroy-with-cleanup).
        status = 'other'

      return {
        id,
        name: dev.name,
        path: `/dev/${dev.name}` as `/dev/${string}`,
        size: dev.size,
        model: trimOrNull(dev.model),
        modelFamily: null, // enriched by DiskIdentityCache
        serial: trimOrNull(dev.serial),
        vendor: trimOrNull(dev.vendor),
        revision: trimOrNull(dev.rev),
        formFactor: null, // enriched by DiskIdentityCache
        transport: dev.tran,
        rotational: dev.rota,
        physicalSectorSize: dev['phy-sec'] ?? null,
        logicalSectorSize: dev['log-sec'] ?? null,
        wwn: dev.wwn ?? null,
        smartHealthy: null, // enriched by DiskIdentityCache
        status,
        poolName,
        ahrArray: null, // enriched from AHR topology in the disks route
        vdevName: null, // enriched from zpool status in the disks route
        vdevRole: null, // enriched from zpool status in the disks route
        zfsErrors: null, // enriched from zpool status in the disks route
        healthStatus: 'unknown', // computed in the disks route (SMART + ZFS errors)
        partitions,
      }
    })
}

/** Trim whitespace and return null for empty/null strings */
function trimOrNull(s: string | null | undefined): string | null {
  if (!s)
    return null
  const trimmed = s.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parsePartitions(children: LsblkPartRaw[]): DiskPartition[] {
  return children
    .filter(c => c.type === 'part')
    .map(c => ({
      name: c.name,
      size: c.size,
      fstype: c.fstype,
      mountpoint: c.mountpoint,
    }))
}

function isSystemDisk(dev: LsblkDeviceRaw, partitions: DiskPartition[]): boolean {
  for (const p of partitions) {
    if (p.mountpoint === '/' || p.mountpoint === '/boot' || p.mountpoint === '/boot/efi') {
      return true
    }
  }
  if (dev.mountpoint === '/')
    return true
  return false
}

/**
 * True if any descendant of the disk is an LVM node belonging to a Ceph OSD.
 * Read from the lsblk tree alone — no ceph tooling, which exists only on Ceph
 * nodes. Either signal suffices:
 *  - fstype `ceph_bluestore` — util-linux detects the bluestore superblock;
 *  - an LV under the `ceph--<vg-uuid>` VG naming convention — this also covers
 *    dedicated DB/WAL LVs (`…-osd--db--…`, `…-osd--wal--…`), which carry no
 *    bluestore label.
 * Descendants nest (disk → part → lvm), so the walk is recursive: an OSD built
 * on a partition classifies the same as one built on the whole disk.
 */
function hasCephOsd(children: LsblkPartRaw[] | undefined): boolean {
  for (const child of children ?? []) {
    if (child.type === 'lvm' && (child.fstype === 'ceph_bluestore' || child.name.startsWith('ceph--')))
      return true
    if (hasCephOsd(child.children))
      return true
  }
  return false
}

/**
 * True if the disk carries any on-disk signature and is therefore not empty:
 * a partition table (any partitions at all, including ZFS's own part1/part9 and
 * leftover zfs_member labels) or a filesystem written straight to the whole
 * disk. Only a disk with neither is safe to hand to `zpool create`.
 */
function hasAnySignature(dev: LsblkDeviceRaw, partitions: DiskPartition[]): boolean {
  if (partitions.length > 0)
    return true
  return dev.fstype !== null && dev.fstype !== ''
}
