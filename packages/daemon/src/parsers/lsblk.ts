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
}

interface LsblkDeviceRaw {
  name: string
  type: string
  size: number
  model: string | null
  serial: string | null
  tran: string | null
  fstype: string | null
  mountpoint: string | null
  rota: boolean
  'phy-sec'?: number | null
  'log-sec'?: number | null
  wwn?: string | null
  vendor?: string | null
  rev?: string | null
  children?: LsblkPartRaw[]
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
 * @param byIdMap mapping of kernel names to by-id identifiers (from disk-by-id parser)
 * @param poolDisks set of by-id names that belong to ZFS pools
 */
export function parseLsblk(
  json: string | LsblkOutput,
  byIdMap: ByIdMap,
  poolDisks: Map<string, string> = new Map(),
): Disk[] {
  const data: LsblkOutput = typeof json === 'string' ? JSON.parse(json) : json

  return data.blockdevices
    .filter(dev => dev.type === 'disk' && !dev.name.startsWith('zram') && !dev.name.startsWith('loop'))
    .map(dev => {
      const id = byIdMap.get(dev.name) ?? dev.serial ?? dev.name
      const partitions = parsePartitions(dev.children ?? [])
      const isSystem = isSystemDisk(dev, partitions)
      const poolName = poolDisks.get(id) ?? null
      let status: DiskUsageStatus = 'available'
      if (isSystem) status = 'system'
      else if (poolName) status = 'pool_member'
      else if (hasNonZfsPartitions(partitions)) status = 'other'

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
        partitions,
      }
    })
}

/** Trim whitespace and return null for empty/null strings */
function trimOrNull(s: string | null | undefined): string | null {
  if (!s) return null
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
  if (dev.mountpoint === '/') return true
  return false
}

function hasNonZfsPartitions(partitions: DiskPartition[]): boolean {
  return partitions.some(
    p => p.fstype !== null && p.fstype !== 'zfs_member' && p.fstype !== '',
  )
}
