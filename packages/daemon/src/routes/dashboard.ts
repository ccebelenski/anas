import type {
  AhrPool,
  ArcTelemetry,
  DashboardWarning,
  Disk,
  DiskHealthCounts,
  DiskTelemetry,
  JobBrief,
  NetTelemetry,
  PoolStatusBrief,
  PoolTelemetry,
  ShareStatusBrief,
  StatusSummary,
  Telemetry,
  VdevRole,
  VdevState,
  VdevTelemetry,
  VdevType,
} from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { computeArcTelemetry, parseArcstats } from '../parsers/arcstats.js'
import { parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { parseExports } from '../parsers/exports.js'
import { computeNetTelemetry, parseProcNetDev } from '../parsers/net-dev.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { nodeToIoStats, parseZpoolIostat } from '../parsers/zpool-iostat.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'
import { withAhrCreateStatus } from '../services/ahr-create-status.js'
import { collectAhrTelemetry } from '../services/ahr-io.js'
import { buildAhrCapacityWarnings, collectAhrPoolBriefs, collectAhrWarnings } from '../services/ahr-topology.js'
import { collectBackupWarnings } from '../services/backup-units.js'
import { readConfig } from '../services/config-writer.js'
import { collectMountWarnings } from '../services/mounts.js'
import { buildReplicationWarnings, collectTaskStatuses } from '../services/replication-units.js'
import { collectScheduleWarnings } from '../services/snapshot-schedule-units.js'
import { collectDisks } from './disks.js'
import { pathExists } from './shares-smb.js'

const ARCSTATS_PATH = '/proc/spl/kstat/zfs/arcstats'
const PROC_NET_DEV = '/proc/net/dev'
const PROC_DISKSTATS = '/proc/diskstats'
const ZPOOL = '/usr/sbin/zpool'
const SYSTEMCTL = '/usr/bin/systemctl'

/** Pool states that are outright critical (data at risk / unavailable). */
const CRITICAL_POOL_STATES = new Set(['FAULTED', 'UNAVAIL', 'REMOVED', 'SUSPENDED'])

/**
 * Dashboard endpoints (Epic 2).
 *   GET /v1/status    — the base aggregate (2.1–2.6): pools, disk-health counts,
 *                       share status, recent jobs, and derived warnings.
 *   GET /v1/telemetry — a live on-demand ~1s sample (2.7): ARC, per-pool and
 *                       per-disk I/O, and network throughput.
 *
 * Both are read-only (no jobs, no mutations) and FAIL-OPEN: any sub-part that
 * errors contributes empty/zero rather than failing the whole panel.
 */
export async function dashboardRoutes(
  server: FastifyInstance,
  opts: {
    executor: CommandExecutor
    jobQueue: JobQueue
    diskIdentityCache: DiskIdentityCache
    smbConfPath: string
    exportsPath: string
    /** systemd unit dir — replication task store, for failure warnings (5.5.3). */
    systemdDir: string
    /** /etc/fstab location — for failing-mount warnings (Epic 18). */
    fstabPath: string
    /** storage.cfg location for read-only PVE tagging (undefined = default). */
    storagePath?: string
    /** mdadm.conf location for AHR-pin tagging (AHR pools skip mount warnings). */
    mdadmConfPath?: string
    /** AHR expansion-intent dir (§5.3) — halted-expansion warnings (11.10). */
    ahrIntentDir?: string
  },
) {
  const { executor, jobQueue, diskIdentityCache, smbConfPath, exportsPath, systemdDir, fstabPath, storagePath, mdadmConfPath, ahrIntentDir } = opts

  // A pool mid-create must not card as a CRITICAL failure for the whole build
  // (issue #7): the half-built stack is genuinely VG-less, so only the live job
  // can tell "being built" from "wrecked". Applied to both AHR /v1/status
  // sources so the Pools section and the warning cards agree.
  const ahrCreateStatus = (pool: AhrPool): AhrPool => withAhrCreateStatus(pool, jobQueue)

  // --- GET /v1/status ------------------------------------------------------
  server.get('/status', async () => {
    // Each block is independently fail-open so one failing source (e.g. no ZFS)
    // never blanks the rest of the dashboard.
    const [poolStatus, diskHealth, shares, jobs, replicationWarnings, mountWarnings, backupWarnings, ahrWarnings, ahrPools, scheduleWarnings] = await Promise.all([
      collectPoolStatus(),
      collectDiskHealth(),
      collectShareStatus(),
      collectJobs(),
      collectReplicationWarnings(),
      collectMountWarnings(executor, { fstabPath, storagePath, mdadmConfPath }),
      collectBackupWarnings(executor, systemdDir),
      // AHR (11.10): only bad states card (degraded/failed/readonly/halted
      // expansion); healthy pools contribute nothing, errors fail-open.
      collectAhrWarnings(executor, ahrIntentDir, ahrCreateStatus),
      // AHR (11.13, §10 revision): per-pool briefs for the headline Pools
      // section — healthy pools now render alongside ZFS pools; errors
      // fail-open to [] (the dashboard never degrades when AHR is unreadable).
      collectAhrPoolBriefs(executor, mdadmConfPath, ahrCreateStatus),
      // Snapshot schedules (17.7): failed/overdue enabled schedules → 'schedule'
      // warnings; healthy/idle and disabled contribute nothing, errors fail-open.
      collectScheduleWarnings(executor, systemdDir),
    ])

    const summary: StatusSummary = {
      node: hostname(),
      pools: poolStatus.pools,
      disks: diskHealth.counts,
      shares: shares.brief,
      jobs,
      // Pool/disk warnings, stale-share warnings (same smb.conf/exports parse
      // collectShareStatus already ran), plus failed-replication-task warnings.
      // AHR pools get the SAME capacity cards ZFS pools do — parallel
      // construction, derived from the same briefs the Pools section renders
      // (11.13): identical ≥95/≥90 thresholds, same 'capacity' category.
      warnings: [...buildWarnings(poolStatus, diskHealth.disks), ...shares.warnings, ...replicationWarnings, ...mountWarnings, ...backupWarnings, ...ahrWarnings, ...buildAhrCapacityWarnings(ahrPools), ...scheduleWarnings],
      ahrPools,
    }
    return { data: summary }
  })

  /**
   * Replication tasks whose last run failed → 'replication' warnings (5.5.3).
   *  Reuses the same task-status derivation the Replication view uses; fail-open
   *  to no warnings (units-as-store, ZFS + systemd truth).
   */
  async function collectReplicationWarnings(): Promise<DashboardWarning[]> {
    try {
      return buildReplicationWarnings(await collectTaskStatuses(executor, systemdDir))
    }
    catch {
      return []
    }
  }

  /** Pool briefs + the scan/state context the warnings pass needs. */
  async function collectPoolStatus(): Promise<{
    pools: PoolStatusBrief[]
    scanErrors: Map<string, number>
  }> {
    const pools: PoolStatusBrief[] = []
    const scanErrors = new Map<string, number>()
    try {
      const [listResult, statusResult] = await Promise.all([
        executor.exec(ZPOOL, ['list', '-j']),
        executor.exec(ZPOOL, ['status', '-jv']),
      ])
      if (listResult.exitCode !== 0 && !listResult.stdout.trim())
        return { pools, scanErrors }

      const list = parseZpoolList(listResult.stdout)
      const status = statusResult.exitCode === 0 ? parseZpoolStatus(statusResult.stdout) : []
      const statusByName = new Map(status.map(s => [s.name, s]))

      for (const pool of list) {
        const s = statusByName.get(pool.name)
        pools.push({
          name: pool.name,
          state: s?.state ?? pool.state,
          capacity: pool.capacity,
          size: pool.size,
          allocated: pool.allocated,
          free: pool.free,
          scanRunning: s?.scan?.state === 'SCANNING',
        })
        if (s?.scan && s.scan.errors > 0)
          scanErrors.set(pool.name, s.scan.errors)
      }
    }
    catch {
      // fail-open: no pools
    }
    return { pools, scanErrors }
  }

  /** Fused SMART+ZFS health counts plus the disk list (for per-disk warnings). */
  async function collectDiskHealth(): Promise<{ counts: DiskHealthCounts, disks: Disk[] }> {
    const counts: DiskHealthCounts = { total: 0, healthy: 0, warning: 0, critical: 0, unknown: 0 }
    let disks: Disk[] = []
    try {
      disks = await collectDisks(executor, diskIdentityCache)
      for (const d of disks) {
        counts.total++
        counts[d.healthStatus]++
      }
    }
    catch {
      // fail-open: zero counts, no disks
    }
    return { counts, disks }
  }

  /**
   * SMB + NFS share counts (plus service-active flags when detectable) AND the
   * stale-share warnings derived from the SAME parse: a share/export whose
   * backing path no longer exists on disk (2.5). A stat that fails for any
   * reason other than "missing" contributes NO warning (fail-open — never a
   * false stale). Every stale share is emitted; the dashboard renders warnings
   * as compact wrap cards, so volume is fine.
   */
  async function collectShareStatus(): Promise<{ brief: ShareStatusBrief, warnings: DashboardWarning[] }> {
    const brief: ShareStatusBrief = { smbCount: 0, nfsCount: 0 }
    const warnings: DashboardWarning[] = []
    try {
      const smbShares = parseSmbConf(await readConfig(smbConfPath)).shares
      brief.smbCount = smbShares.length
      for (const share of smbShares) {
        if (pathExists(share.path) === false) {
          warnings.push({
            level: 'warning',
            category: 'share',
            message: `SMB share '${share.name}' points to a missing path ${share.path}`,
            ref: share.name,
          })
        }
      }
    }
    catch { /* fail-open */ }
    try {
      const exports = parseExports(await readConfig(exportsPath))
      brief.nfsCount = exports.length
      for (const exp of exports) {
        if (pathExists(exp.path) === false) {
          warnings.push({
            level: 'warning',
            category: 'share',
            message: `NFS export path ${exp.path} no longer exists`,
            ref: exp.path,
          })
        }
      }
    }
    catch { /* fail-open */ }
    const smbActive = await serviceActive('smbd')
    if (smbActive !== undefined)
      brief.smbActive = smbActive
    const nfsActive = await serviceActive('nfs-server')
    if (nfsActive !== undefined)
      brief.nfsActive = nfsActive
    return { brief, warnings }
  }

  /** `systemctl is-active <unit>` → true/false, or undefined if undetectable. */
  async function serviceActive(unit: string): Promise<boolean | undefined> {
    try {
      const r = await executor.exec(SYSTEMCTL, ['is-active', unit])
      const state = r.stdout.trim()
      // is-active prints a known state token (exit code is non-zero when
      // inactive, which is fine). Anything else (empty / mock miss) → omit.
      if (['active', 'inactive', 'activating', 'deactivating', 'failed', 'reloading'].includes(state))
        return state === 'active'
      return undefined
    }
    catch {
      return undefined
    }
  }

  /** Recent + active jobs, newest first, as compact briefs. */
  async function collectJobs(): Promise<JobBrief[]> {
    try {
      return jobQueue
        .list()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20)
        .map((j): JobBrief => {
          const brief: JobBrief = { id: j.id, kind: j.operation, status: j.status }
          if (j.startedAt) {
            brief.startedAt = j.startedAt
            const start = Date.parse(j.startedAt)
            if (!Number.isNaN(start)) {
              // Finished job: measure to completedAt. Still running: measure to now.
              const end = j.completedAt ? Date.parse(j.completedAt) : Date.now()
              if (j.completedAt && !Number.isNaN(Date.parse(j.completedAt)))
                brief.finishedAt = j.completedAt
              if (!Number.isNaN(end))
                brief.durationMs = Math.max(0, end - start)
            }
          }
          return brief
        })
    }
    catch {
      return []
    }
  }

  // --- GET /v1/telemetry ---------------------------------------------------
  server.get('/telemetry', async () => {
    return { data: await sampleTelemetry() }
  })

  async function sampleTelemetry(): Promise<Telemetry> {
    const sampledAt = new Date().toISOString()
    try {
      // t0 snapshots of the cumulative counters, BEFORE the ~1s iostat window.
      // /proc/diskstats rides the SAME window (AHR I/O, 11.15) as ARC/net.
      const t0 = Date.now()
      const [arc0, net0, diskstats0] = await Promise.all([readArcstats(), readNetDev(), readDiskstats()])

      // Pool names for the iostat call (fail-open to none).
      let poolNames: string[] = []
      try {
        const listResult = await executor.exec(ZPOOL, ['list', '-j'])
        if (listResult.exitCode === 0 || listResult.stdout.trim())
          poolNames = parseZpoolList(listResult.stdout).map(p => p.name)
      }
      catch { /* no pools */ }

      // The ~1s sampling window: `iostat ... 1 2` prints a since-boot sample,
      // waits one second, prints the interval sample, then exits.
      let iostatText = ''
      if (poolNames.length > 0) {
        try {
          const r = await executor.exec(ZPOOL, ['iostat', '-plv', ...poolNames, '1', '2'])
          if (r.exitCode === 0)
            iostatText = r.stdout
        }
        catch { /* no iostat */ }
      }

      // t1 snapshots, AFTER the window closed.
      const t1 = Date.now()
      const [arc1, net1, diskstats1] = await Promise.all([readArcstats(), readNetDev(), readDiskstats()])
      const windowMs = t1 - t0

      const arc = computeArc(arc0, arc1)
      const net = computeNet(net0, net1, windowMs)
      const pools = await computeIo(iostatText)
      // AHR I/O rides its own diskstats deltas (11.15), fully fail-open to []:
      // an AHR resolve error never disturbs the ZFS/ARC/net telemetry above.
      const ahrPools = await collectAhrTelemetry(executor, diskstats0, diskstats1, windowMs, mdadmConfPath)

      return { sampledAt, windowMs, arc, pools, ahrPools, net }
    }
    catch {
      return emptyTelemetry(sampledAt)
    }
  }

  /** ARC telemetry from two snapshots; zeroed when arcstats is unreadable. */
  function computeArc(prev: string | null, cur: string | null): ArcTelemetry {
    if (!cur)
      return { hitRatio: 0, size: 0, target: 0, max: 0, l2: null }
    const curStats = parseArcstats(cur)
    const prevStats = prev ? parseArcstats(prev) : curStats
    return computeArcTelemetry(prevStats, curStats)
  }

  /** Net telemetry from two snapshots; empty when /proc/net/dev is unreadable. */
  function computeNet(prev: string | null, cur: string | null, windowMs: number): NetTelemetry {
    if (!cur)
      return { interfaces: [], totalRxBytesPerSec: 0, totalTxBytesPerSec: 0 }
    return computeNetTelemetry(
      prev ? parseProcNetDev(prev) : [],
      parseProcNetDev(cur),
      windowMs,
    )
  }

  /**
   * Nested pool → vdevs[] → disks[] I/O from the interval (LAST) iostat sample.
   * Each vdev is enriched with type/role/state joined from `zpool status`.
   */
  async function computeIo(iostatText: string): Promise<PoolTelemetry[]> {
    const pools: PoolTelemetry[] = []
    if (!iostatText.trim())
      return pools

    const samples = parseZpoolIostat(iostatText)
    const sample = samples.at(-1)
    if (!sample || sample.length === 0)
      return pools

    // Both joins are independent and fail-open: the by-id map (leaf → stable
    // identity) and the topology map (vdev → type/role/state).
    const [byIdMap, topology] = await Promise.all([loadByIdMap(), fetchVdevTopology()])

    const disk = (name: string, node: (typeof sample)[number]): DiskTelemetry => ({
      id: byIdMap.get(name) ?? name,
      ...nodeToIoStats(node),
    })

    let currentPool: PoolTelemetry | null = null
    let currentVdev: VdevTelemetry | null = null

    for (let i = 0; i < sample.length; i++) {
      const node = sample[i]
      const hasChild = i + 1 < sample.length && sample[i + 1].depth > node.depth

      if (node.depth === 0) {
        currentPool = { name: node.name, vdevs: [], ...nodeToIoStats(node) }
        currentVdev = null
        pools.push(currentPool)
        continue
      }
      if (!currentPool)
        continue // defensive: a vdev/disk row with no standing pool

      if (node.depth === 1) {
        const info = topology.get(currentPool.name)?.get(node.name)
        const vdev: VdevTelemetry = {
          name: node.name,
          type: info?.type ?? typeFromName(node.name),
          role: info?.role ?? 'data',
          state: info?.state ?? 'ONLINE',
          disks: [],
          ...nodeToIoStats(node),
        }
        currentPool.vdevs.push(vdev)
        currentVdev = vdev
        // A bare striped leaf disk is a depth-1 row with no deeper child: it is
        // both vdev and disk — surface it as the vdev's single disk.
        if (!hasChild)
          vdev.disks.push(disk(node.name, node))
        continue
      }

      // depth >= 2: a leaf disk in the current vdev. Skip nested container rows
      // (e.g. `replacing-0`) that still have deeper child rows following them.
      if (!hasChild && currentVdev)
        currentVdev.disks.push(disk(node.name, node))
    }
    return pools
  }

  /**
   * Map iostat leaf names (kernel like `sdb` or already-by-id) to the SAME
   * stable by-id identity the Disks view / pool topology uses. `ls -la
   * /dev/disk/by-id/` gives kernel→by-id; a name that is already a by-id (or
   * unresolvable) is used verbatim. Fail-open to an empty map.
   */
  async function loadByIdMap(): Promise<Map<string, string>> {
    try {
      const byIdResult = await executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/'])
      return parseDiskByIdListing(byIdResult.stdout)
    }
    catch {
      return new Map()
    }
  }

  /**
   * One `zpool status -jv` read per sample, reduced to pool → (vdev name →
   * type/role/state). Reuses the same parser /status uses. Fail-open: an
   * unmatched vdev falls back to a name-derived type + role 'data' + 'ONLINE'.
   */
  async function fetchVdevTopology(): Promise<Map<string, Map<string, VdevJoin>>> {
    const map = new Map<string, Map<string, VdevJoin>>()
    try {
      const r = await executor.exec(ZPOOL, ['status', '-jv'])
      if (r.exitCode !== 0 && !r.stdout.trim())
        return map
      for (const pool of parseZpoolStatus(r.stdout)) {
        const vmap = new Map<string, VdevJoin>()
        for (const group of pool.vdevGroups) {
          for (const vdev of group.vdevs)
            vmap.set(vdev.name, { type: vdev.type, role: group.role, state: vdev.state })
        }
        map.set(pool.name, vmap)
      }
    }
    catch { /* fail-open: no topology, callers use name-derived fallback */ }
    return map
  }
}

/** The topology fields joined onto a vdev from `zpool status`. */
interface VdevJoin {
  type: VdevType
  role: VdevRole
  state: VdevState
}

/** Fallback vdev type from its iostat name when topology has no match. */
function typeFromName(name: string): VdevType {
  const n = name.toLowerCase()
  if (n.startsWith('mirror'))
    return 'mirror'
  if (n.startsWith('raidz3'))
    return 'raidz3'
  if (n.startsWith('raidz2'))
    return 'raidz2'
  if (n.startsWith('raidz'))
    return 'raidz'
  if (n.startsWith('draid3'))
    return 'draid3'
  if (n.startsWith('draid2'))
    return 'draid2'
  if (n.startsWith('draid'))
    return 'draid'
  if (n.startsWith('replacing'))
    return 'replacing'
  if (n.startsWith('spare'))
    return 'spare'
  return 'disk'
}

/** Read a /proc file, returning null on any error (fail-open). */
async function readArcstats(): Promise<string | null> {
  return readProc(ARCSTATS_PATH)
}
async function readNetDev(): Promise<string | null> {
  return readProc(PROC_NET_DEV)
}
async function readDiskstats(): Promise<string | null> {
  return readProc(PROC_DISKSTATS)
}
async function readProc(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  }
  catch {
    return null
  }
}

/** A fully-zeroed telemetry payload for the total fail-open case. */
function emptyTelemetry(sampledAt: string): Telemetry {
  return {
    sampledAt,
    windowMs: 0,
    arc: { hitRatio: 0, size: 0, target: 0, max: 0, l2: null },
    pools: [],
    ahrPools: [],
    net: { interfaces: [], totalRxBytesPerSec: 0, totalTxBytesPerSec: 0 },
  }
}

/** Derive dashboard warnings from pool state/scan and disk health (2.5). */
function buildWarnings(
  poolStatus: { pools: PoolStatusBrief[], scanErrors: Map<string, number> },
  disks: Disk[],
): DashboardWarning[] {
  const warnings: DashboardWarning[] = []

  for (const pool of poolStatus.pools) {
    // Pool not ONLINE: critical vs warning by state.
    if (pool.state !== 'ONLINE') {
      const level = CRITICAL_POOL_STATES.has(pool.state) ? 'critical' : 'warning'
      warnings.push({
        level,
        category: 'pool',
        message: `Pool '${pool.name}' is ${pool.state}`,
        ref: pool.name,
      })
    }
    // A last scan that found errors (failed scrub/resilver).
    const errs = poolStatus.scanErrors.get(pool.name)
    if (errs !== undefined && errs > 0) {
      warnings.push({
        level: 'critical',
        category: 'scrub',
        message: `Pool '${pool.name}' last scan found ${errs} error${errs === 1 ? '' : 's'}`,
        ref: pool.name,
      })
    }
    // Capacity thresholds: ≥95% critical, ≥90% warning.
    if (pool.capacity >= 95) {
      warnings.push({
        level: 'critical',
        category: 'capacity',
        message: `Pool '${pool.name}' is ${pool.capacity}% full`,
        ref: pool.name,
      })
    }
    else if (pool.capacity >= 90) {
      warnings.push({
        level: 'warning',
        category: 'capacity',
        message: `Pool '${pool.name}' is ${pool.capacity}% full`,
        ref: pool.name,
      })
    }
  }

  // One warning per non-healthy disk, carrying its stable id as the ref so the
  // UI can deep-link into the Disks view.
  for (const d of disks) {
    if (d.healthStatus === 'critical') {
      warnings.push({
        level: 'critical',
        category: 'disk',
        message: `Disk '${d.name}' is in critical health`,
        ref: d.id,
      })
    }
    else if (d.healthStatus === 'warning') {
      warnings.push({
        level: 'warning',
        category: 'disk',
        message: `Disk '${d.name}' is reporting warnings`,
        ref: d.id,
      })
    }
  }

  return warnings
}
