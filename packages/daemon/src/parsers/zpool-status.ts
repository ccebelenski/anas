/**
 * Parser for `zpool status -j` output.
 * Extracts: pool state, vdev topology, scan status, health messages.
 */

import type { PoolDisk, PoolHealthMessage, PoolState, ScanStatus, Vdev, VdevGroup, VdevRole, VdevState, VdevType } from '@anas/shared'
import { parseHumanSize, parseIntOrZero, parseZfsDate } from './utils.js'

/** Raw ZFS JSON types (what `zpool status -j` actually returns) */
interface ZfsVdevRaw {
  name: string
  vdev_type: string
  guid?: string
  path?: string
  state: string
  class?: string
  alloc_space?: string
  total_space?: string
  read_errors?: string
  write_errors?: string
  checksum_errors?: string
  slow_ios?: string
  scan_processed?: string
  vdevs?: Record<string, ZfsVdevRaw>
}

interface ZfsScanStatsRaw {
  function: string
  state: string
  start_time: string
  end_time: string
  to_examine: string
  examined: string
  processed: string
  errors: string
}

interface ZfsPoolStatusRaw {
  name: string
  state: string
  pool_guid: string
  status?: string
  action?: string
  msgid?: string
  moreinfo?: string
  scan_stats?: ZfsScanStatsRaw
  vdevs: Record<string, ZfsVdevRaw>
  /** Pool-level spares (separate from vdev tree) */
  spares?: Record<string, ZfsVdevRaw>
  /** Pool-level L2ARC cache (separate from vdev tree) */
  l2cache?: Record<string, ZfsVdevRaw>
  error_count: string
  /** Present with -v flag when there are data errors */
  errlist?: string
}

interface ZpoolStatusOutput {
  pools: Record<string, ZfsPoolStatusRaw>
}

export interface ParsedPoolStatus {
  name: string
  state: PoolState
  guid: string
  errorCount: number
  /** Error details from -v flag (file list or error message) */
  errorDetail?: string
  vdevGroups: VdevGroup[]
  scan: ScanStatus | null
  health?: PoolHealthMessage
}

/**
 * Parse `zpool status -jv` JSON output for all pools.
 */
export function parseZpoolStatus(json: string | ZpoolStatusOutput): ParsedPoolStatus[] {
  const data: ZpoolStatusOutput = typeof json === 'string' ? JSON.parse(json) : json
  return Object.values(data.pools).map(parsePool)
}

/**
 * Parse a single pool from `zpool status -jv` output.
 */
export function parseZpoolStatusPool(json: string | ZpoolStatusOutput, poolName: string): ParsedPoolStatus | null {
  const data: ZpoolStatusOutput = typeof json === 'string' ? JSON.parse(json) : json
  const pool = data.pools[poolName]
  if (!pool) return null
  return parsePool(pool)
}

function parsePool(pool: ZfsPoolStatusRaw): ParsedPoolStatus {
  const result: ParsedPoolStatus = {
    name: pool.name,
    state: pool.state as PoolState,
    guid: pool.pool_guid,
    errorCount: parseIntOrZero(pool.error_count),
    ...(pool.errlist && { errorDetail: pool.errlist }),
    vdevGroups: [],
    scan: pool.scan_stats ? parseScanStats(pool.scan_stats) : null,
  }

  if (pool.status || pool.action) {
    result.health = {
      status: pool.status ?? '',
      action: pool.action ?? '',
      ...(pool.msgid && { msgId: pool.msgid }),
      ...(pool.moreinfo && { moreInfo: pool.moreinfo }),
    }
  }

  // Parse vdev tree: root → top-level vdevs → leaf disks
  const rootVdev = Object.values(pool.vdevs)[0]
  if (rootVdev?.vdevs) {
    result.vdevGroups = classifyVdevs(rootVdev.vdevs)
  }

  // Pool-level spares (separate from vdev tree)
  if (pool.spares && Object.keys(pool.spares).length > 0) {
    const spareDisksList: PoolDisk[] = Object.values(pool.spares).map(parseDisk)
    const spareVdev: Vdev = {
      name: 'spares',
      type: 'spare',
      state: 'ONLINE' as VdevState,
      readErrors: 0,
      writeErrors: 0,
      checksumErrors: 0,
      disks: spareDisksList,
    }
    result.vdevGroups.push({ role: 'spare', vdevs: [spareVdev] })
  }

  // Pool-level L2ARC cache
  if (pool.l2cache && Object.keys(pool.l2cache).length > 0) {
    const cacheDisksList: PoolDisk[] = Object.values(pool.l2cache).map(parseDisk)
    const cacheVdev: Vdev = {
      name: 'cache',
      type: 'disk' as VdevType,
      state: 'ONLINE' as VdevState,
      readErrors: 0,
      writeErrors: 0,
      checksumErrors: 0,
      disks: cacheDisksList,
    }
    result.vdevGroups.push({ role: 'cache', vdevs: [cacheVdev] })
  }

  return result
}

/**
 * Classify top-level vdevs into groups by role.
 * ZFS puts log, cache, spare etc. as named top-level children.
 */
function classifyVdevs(topLevelVdevs: Record<string, ZfsVdevRaw>): VdevGroup[] {
  const groups = new Map<VdevRole, Vdev[]>()

  for (const [, rawVdev] of Object.entries(topLevelVdevs)) {
    const role = inferRole(rawVdev)
    if (!groups.has(role)) groups.set(role, [])
    groups.get(role)!.push(parseVdev(rawVdev))
  }

  return Array.from(groups.entries()).map(([role, vdevs]) => ({ role, vdevs }))
}

/**
 * Infer vdev role from its name/type.
 * ZFS names special vdevs: "logs", "cache", "spares", "special", "dedup".
 */
function inferRole(vdev: ZfsVdevRaw): VdevRole {
  const name = vdev.name.toLowerCase()
  if (name === 'logs' || name === 'log') return 'log'
  if (name === 'cache') return 'cache'
  if (name === 'spares' || name === 'spare') return 'spare'
  if (name === 'special') return 'special'
  if (name === 'dedup') return 'dedup'
  return 'data'
}

function parseVdev(raw: ZfsVdevRaw): Vdev {
  const disks: PoolDisk[] = []

  // If this vdev has children (mirror, raidz), parse them as disks
  if (raw.vdevs && Object.keys(raw.vdevs).length > 0) {
    for (const child of Object.values(raw.vdevs)) {
      if (child.vdev_type === 'disk' || !child.vdevs || Object.keys(child.vdevs).length === 0) {
        disks.push(parseDisk(child))
      }
      // Nested vdevs (e.g. replacing-0 containing disks) — flatten
      if (child.vdevs && Object.keys(child.vdevs).length > 0 && child.vdev_type !== 'disk') {
        for (const grandchild of Object.values(child.vdevs)) {
          disks.push(parseDisk(grandchild))
        }
      }
    }
  } else if (raw.vdev_type === 'disk') {
    // Single disk vdev (stripe member) — the vdev IS the disk
    disks.push(parseDisk(raw))
  }

  return {
    name: raw.name,
    type: mapVdevType(raw.vdev_type),
    state: raw.state as VdevState,
    ...(raw.alloc_space && { allocated: parseHumanSize(raw.alloc_space) }),
    ...(raw.total_space && { size: parseHumanSize(raw.total_space) }),
    readErrors: parseIntOrZero(raw.read_errors),
    writeErrors: parseIntOrZero(raw.write_errors),
    checksumErrors: parseIntOrZero(raw.checksum_errors),
    disks,
  }
}

function parseDisk(raw: ZfsVdevRaw): PoolDisk {
  const id = stripPartSuffix(raw.name)
  return {
    id,
    path: (raw.path ?? `/dev/disk/by-id/${id}`) as `/dev/${string}`,
    state: raw.state as VdevState,
    readErrors: parseIntOrZero(raw.read_errors),
    writeErrors: parseIntOrZero(raw.write_errors),
    checksumErrors: parseIntOrZero(raw.checksum_errors),
    slowIos: parseIntOrZero(raw.slow_ios),
  }
}

/** Map ZFS vdev_type strings to our VdevType enum.
 *  ZFS uses "raidz" for raidz1, the name contains the actual level (e.g. "raidz1-0"). */
function mapVdevType(zfsType: string): VdevType {
  if (zfsType === 'raidz') return 'raidz'
  if (zfsType === 'raidz2') return 'raidz2'
  if (zfsType === 'raidz3') return 'raidz3'
  if (zfsType === 'mirror') return 'mirror'
  if (zfsType === 'disk' || zfsType === 'file') return 'disk'
  if (zfsType === 'replacing') return 'replacing'
  if (zfsType === 'spare') return 'spare'
  if (zfsType.startsWith('draid3')) return 'draid3'
  if (zfsType.startsWith('draid2')) return 'draid2'
  if (zfsType.startsWith('draid')) return 'draid'
  return 'disk' // fallback
}

/** Strip -partN suffix from a by-id disk name */
function stripPartSuffix(name: string): string {
  return name.replace(/-part\d+$/, '')
}

function parseScanStats(raw: ZfsScanStatsRaw): ScanStatus {
  const totalBytes = parseHumanSize(raw.to_examine)
  const examinedBytes = parseHumanSize(raw.examined)
  const percentComplete = totalBytes > 0
    ? Math.min(100, Math.round((examinedBytes / totalBytes) * 10000) / 100)
    : 0

  const startedAt = parseZfsDate(raw.start_time)
  const finishedAt = raw.state === 'SCANNING' ? null : parseZfsDate(raw.end_time)

  return {
    function: raw.function as ScanStatus['function'],
    state: raw.state as ScanStatus['state'],
    startedAt: startedAt ?? new Date(0).toISOString(),
    finishedAt,
    totalBytes,
    examinedBytes,
    processedBytes: parseHumanSize(raw.processed),
    errors: parseIntOrZero(raw.errors),
    percentComplete,
  }
}
