/**
 * Parser for `zpool status -j` output.
 * Extracts: pool state, vdev topology, scan status, health messages.
 */

import type { LastScrub, PoolDisk, PoolHealthMessage, PoolState, ScanStatus, ScrubRunning, Vdev, VdevGroup, VdevRole, VdevState, VdevType } from '@anas/shared'
import { parseHumanSize, parseIntOrZero, parseZfsDate, parseZfsJson } from './utils.js'

/** Raw ZFS JSON types (what `zpool status -j` actually returns) */
interface ZfsVdevRaw {
  name: string
  vdev_type: string
  guid?: string
  path?: string
  /** Stable by-id of the leaf device, e.g. "scsi-…ANAS_HOT1-part1". */
  devid?: string
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

/**
 * RAIDZ-expansion reflow stats (`zpool status` "expand:" line), surfaced under
 * the pool object in `zpool status -j`.
 *
 * GROUND-TRUTH CAVEAT (story 3.31): a live raidz reflow is hard to produce on
 * demand, so these field names are based on the DOCUMENTED OpenZFS
 * `pool_raidz_expand_stat_t` struct and the same friendly-snake_case convention
 * `scan_stats` uses — NOT a live capture. Live-verify on pve5. The parser is
 * deliberately tolerant: it keys "in progress" off the copied-vs-total counters
 * and an unfinished end_time, so it survives field-name drift.
 */
interface ZfsRaidzExpandStatsRaw {
  /** vdev being expanded — a GUID/index or (defensively) a name. */
  expanding_vdev?: string | number
  state?: string
  start_time?: string
  end_time?: string
  /** Total bytes to reflow. */
  to_reflow?: string
  /** Bytes reflowed so far. */
  reflowed?: string
  waiting_for_resilver?: string | number
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
  /** RAIDZ-expansion reflow stats (story 3.31; doc-based — see caveat above). */
  raidz_expand_stats?: ZfsRaidzExpandStatsRaw
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
  const data: ZpoolStatusOutput = parseZfsJson(json, { pools: {} })
  return Object.values(data.pools).map(parsePool)
}

/**
 * Parse a single pool from `zpool status -jv` output.
 */
export function parseZpoolStatusPool(json: string | ZpoolStatusOutput, poolName: string): ParsedPoolStatus | null {
  const data: ZpoolStatusOutput = parseZfsJson(json, { pools: {} })
  const pool = data.pools[poolName]
  if (!pool)
    return null
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
    if (!groups.has(role))
      groups.set(role, [])
    groups.get(role)!.push(parseVdev(rawVdev))
  }

  return Array.from(groups.entries(), ([role, vdevs]) => ({ role, vdevs }))
}

/**
 * Infer vdev role from its name/type.
 * ZFS names special vdevs: "logs", "cache", "spares", "special", "dedup".
 */
function inferRole(vdev: ZfsVdevRaw): VdevRole {
  const name = vdev.name.toLowerCase()
  if (name === 'logs' || name === 'log')
    return 'log'
  if (name === 'cache')
    return 'cache'
  if (name === 'spares' || name === 'spare')
    return 'spare'
  if (name === 'special')
    return 'special'
  if (name === 'dedup')
    return 'dedup'
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
  }
  else if (raw.vdev_type === 'disk') {
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
  const id = diskId(raw)
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

/**
 * Map ZFS vdev_type strings to our VdevType enum.
 *  ZFS uses "raidz" for raidz1, the name contains the actual level (e.g. "raidz1-0").
 */
function mapVdevType(zfsType: string): VdevType {
  if (zfsType === 'raidz')
    return 'raidz'
  if (zfsType === 'raidz2')
    return 'raidz2'
  if (zfsType === 'raidz3')
    return 'raidz3'
  if (zfsType === 'mirror')
    return 'mirror'
  if (zfsType === 'disk' || zfsType === 'file')
    return 'disk'
  if (zfsType === 'replacing')
    return 'replacing'
  if (zfsType === 'spare')
    return 'spare'
  if (zfsType.startsWith('draid3'))
    return 'draid3'
  if (zfsType.startsWith('draid2'))
    return 'draid2'
  if (zfsType.startsWith('draid'))
    return 'draid'
  return 'disk' // fallback
}

const PART_SUFFIX_RE = /-part\d+$/
const BY_ID_PATH_RE = /\/dev\/disk\/by-id\//

/** Strip -partN suffix from a by-id disk name */
function stripPartSuffix(name: string): string {
  return name.replace(PART_SUFFIX_RE, '')
}

/**
 * Stable identity for a vdev leaf — always a by-id, never the kernel name
 * (which changes across reboots). ZFS reports the leaf's `devid` (a by-id) and
 * often a by-id `path`; prefer those. The kernel `name` is the last resort only
 * so a leaf with no by-id info still yields *something* rather than crashing —
 * such a disk simply won't cross-reference to the disk list.
 */
function diskId(raw: ZfsVdevRaw): string {
  if (raw.devid)
    return stripPartSuffix(raw.devid)
  if (raw.path && BY_ID_PATH_RE.test(raw.path))
    return stripPartSuffix(raw.path.replace(BY_ID_PATH_RE, ''))
  return stripPartSuffix(raw.name)
}

/**
 * An in-progress operation that must block a new expansion (story 3.31 busy
 * gate): a resilver, or a raidz-expansion reflow. A SCRUB is deliberately NOT
 * reported here — ZFS auto-yields a scrub to a resilver/expansion, so it is a
 * soft note, not a block.
 */
export interface PoolBusyState {
  busy: boolean
  operation?: 'resilver' | 'raidz-expand'
  /** Progress 0–100 when derivable. */
  percentComplete?: number
  /** The reflowing vdev (raidz-expand only), when the field names a vdev. */
  vdev?: string
}

/** Empty/`-`/`0` sentinels an `end_time` uses before a reflow finishes. */
const REFLOW_UNFINISHED = new Set(['', '-', '0'])
/** A reflow's `expanding_vdev` names a vdev only when it contains letters. */
const VDEV_NAMELIKE_RE = /[a-z]/i

function reflowInProgress(rx: ZfsRaidzExpandStatsRaw): boolean {
  const total = parseHumanSize(rx.to_reflow ?? '')
  const done = parseHumanSize(rx.reflowed ?? '')
  const end = (rx.end_time ?? '').trim()
  // Active when there is still work (copied < total) and the reflow has no end
  // time yet. Tolerant of the doc-based field shape (see the raw-type caveat).
  return total > 0 && done < total && REFLOW_UNFINISHED.has(end)
}

/**
 * Detect a busy-gating operation on a pool from `zpool status -jv` JSON. A
 * raidz-expansion reflow takes precedence over a resilver (it is the heavier,
 * more specific op). Returns `{ busy: false }` when neither is running or the
 * pool is absent — fail-soft.
 */
export function parsePoolBusyState(json: string | ZpoolStatusOutput, poolName: string): PoolBusyState {
  const data: ZpoolStatusOutput = parseZfsJson(json, { pools: {} })
  const pool = data.pools?.[poolName]
  if (!pool)
    return { busy: false }

  const rx = pool.raidz_expand_stats
  if (rx && reflowInProgress(rx)) {
    const total = parseHumanSize(rx.to_reflow ?? '')
    const done = parseHumanSize(rx.reflowed ?? '')
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 10000) / 100) : 0
    const vdev = typeof rx.expanding_vdev === 'string' && VDEV_NAMELIKE_RE.test(rx.expanding_vdev)
      ? rx.expanding_vdev
      : undefined
    return { busy: true, operation: 'raidz-expand', percentComplete: percent, ...(vdev && { vdev }) }
  }

  const scan = pool.scan_stats
  if (scan && scan.function === 'RESILVER' && scan.state === 'SCANNING') {
    const total = parseHumanSize(scan.to_examine)
    const examined = parseHumanSize(scan.examined)
    const percent = total > 0 ? Math.min(100, Math.round((examined / total) * 10000) / 100) : 0
    return { busy: true, operation: 'resilver', percentComplete: percent }
  }

  return { busy: false }
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

/**
 * The last COMPLETED verify pass on a pool, derived from the SAME `scan_stats`
 * the in-progress {@link ScanStatus} already comes from — no extra command, no
 * second source. `zpool status` keeps exactly one scan record per pool: while a
 * pass runs it reads as progress ("scrub in progress since …"); once the pass
 * ends the very same record is the verdict ZFS prints as
 * `scrub repaired 0B in 05:23:11 with 0 errors on Sun Aug  3 …`. This reads the
 * verdict form; `parseScanStats` above reads the record, this interprets it.
 *
 * Returns null — an honest "no record", never a fabricated one — when:
 *   - the pool has no scan record at all (`scan: null`, printed as "none
 *     requested": a pool that has never been scrubbed or resilvered),
 *   - a pass is still `SCANNING` (its verdict is not written yet, and the
 *     previous pass's record is already overwritten — ZFS keeps only one),
 *   - the record is `NONE`, or ZFS recorded no usable end time.
 *
 * `repairedBytes` is ZFS's `processed` — the field its own "repaired %s" text
 * prints. Duration is end − start (the "in %s" figure), clamped at 0. A
 * `CANCELED` pass is reported as such: it verified only part of the pool, so the
 * caller must not present its error count as a clean bill of health.
 */
export function lastScrubFromScan(scan: ScanStatus | null): LastScrub | null {
  if (!scan || (scan.state !== 'FINISHED' && scan.state !== 'CANCELED'))
    return null
  if (!scan.finishedAt)
    return null

  // `parseScanStats` substitutes the epoch for a start time ZFS didn't record;
  // treat that (and any unparseable pair) as "duration unknown" = 0 rather than
  // reporting a 56-year scrub.
  const started = Date.parse(scan.startedAt)
  const finished = Date.parse(scan.finishedAt)
  const durationSeconds = Number.isNaN(started) || Number.isNaN(finished) || started <= 0
    ? 0
    : Math.max(0, Math.round((finished - started) / 1000))

  return {
    function: scan.function,
    state: scan.state,
    finishedAt: scan.finishedAt,
    durationSeconds,
    repairedBytes: scan.processedBytes,
    errors: scan.errors,
  }
}

/**
 * The pass RUNNING RIGHT NOW on a pool, from the SAME `scan_stats` record
 * {@link lastScrubFromScan} reads the verdict out of — while `state` is
 * `SCANNING` that record is progress, not a verdict, and this is its other
 * half (stage 6). Null when nothing is running.
 *
 * What the record actually carries (ground truth, `zpool status -jv`):
 * `function`, `state`, `start_time`, `end_time`, `to_examine`, `examined`,
 * `skipped`, `processed`, `errors`, `bytes_per_scan`, `pass_start`,
 * `scrub_pause`, `scrub_spent_paused`, `issued_bytes_per_scan`, `issued`.
 * There is NO rate field and NO time-to-go field — ZFS's CLI derives the
 * "at 1.2G/s, 3h to go" text at print time from the counters and the current
 * clock. We therefore report `percent` only and leave speed/ETA absent rather
 * than manufacture a second, clock-dependent estimate (Principle 11).
 *
 * `percent` is omitted when ZFS reports nothing to examine: the 0 that
 * {@link ScanStatus.percentComplete} substitutes there is a placeholder, not a
 * measurement, and "0%" on screen would read as a stalled pass.
 */
export function scrubRunningFromScan(scan: ScanStatus | null): ScrubRunning | null {
  if (!scan || scan.state !== 'SCANNING')
    return null
  return {
    function: scan.function,
    ...(scan.totalBytes > 0 && { percent: scan.percentComplete }),
  }
}

/**
 * Pool name → its last completed verify pass (null when the pool records none),
 * for every pool in one `zpool status -jv` read.
 */
export function parseLastScrubs(json: string | ZpoolStatusOutput): Map<string, LastScrub | null> {
  return new Map(parseZpoolStatus(json).map(pool => [pool.name, lastScrubFromScan(pool.scan)]))
}

/**
 * Pool name → BOTH scan-derived scrub facts (the last completed pass and the
 * one running now) from a single `zpool status -jv` read. The two are mutually
 * exclusive by construction — one `scan_stats` record per pool is either
 * progress or a verdict — and reading them together keeps the Scrubs screen on
 * the ONE status read it already costs (no second system read for stage 6).
 */
export function parseScrubScans(
  json: string | ZpoolStatusOutput,
): Map<string, { lastScrub: LastScrub | null, running: ScrubRunning | null }> {
  return new Map(parseZpoolStatus(json).map(pool => [
    pool.name,
    { lastScrub: lastScrubFromScan(pool.scan), running: scrubRunningFromScan(pool.scan) },
  ]))
}
