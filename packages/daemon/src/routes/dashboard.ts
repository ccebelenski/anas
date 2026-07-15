import type {
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
import { readConfig } from '../services/config-writer.js'
import { collectDisks } from './disks.js'

const ARCSTATS_PATH = '/proc/spl/kstat/zfs/arcstats'
const PROC_NET_DEV = '/proc/net/dev'
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
  },
) {
  const { executor, jobQueue, diskIdentityCache, smbConfPath, exportsPath } = opts

  // --- GET /v1/status ------------------------------------------------------
  server.get('/status', async () => {
    // Each block is independently fail-open so one failing source (e.g. no ZFS)
    // never blanks the rest of the dashboard.
    const [poolStatus, diskHealth, shares, jobs] = await Promise.all([
      collectPoolStatus(),
      collectDiskHealth(),
      collectShareStatus(),
      collectJobs(),
    ])

    const summary: StatusSummary = {
      node: hostname(),
      pools: poolStatus.pools,
      disks: diskHealth.counts,
      shares,
      jobs,
      warnings: buildWarnings(poolStatus, diskHealth.disks),
    }
    return { data: summary }
  })

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

  /** SMB + NFS share counts, plus service-active flags when detectable. */
  async function collectShareStatus(): Promise<ShareStatusBrief> {
    const brief: ShareStatusBrief = { smbCount: 0, nfsCount: 0 }
    try {
      brief.smbCount = parseSmbConf(await readConfig(smbConfPath)).shares.length
    }
    catch { /* fail-open */ }
    try {
      brief.nfsCount = parseExports(await readConfig(exportsPath)).length
    }
    catch { /* fail-open */ }
    const smbActive = await serviceActive('smbd')
    if (smbActive !== undefined)
      brief.smbActive = smbActive
    const nfsActive = await serviceActive('nfs-server')
    if (nfsActive !== undefined)
      brief.nfsActive = nfsActive
    return brief
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
        .map((j): JobBrief => ({
          id: j.id,
          kind: j.operation,
          status: j.status,
          ...(j.startedAt ? { startedAt: j.startedAt } : {}),
        }))
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
      const t0 = Date.now()
      const [arc0, net0] = await Promise.all([readArcstats(), readNetDev()])

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
      const [arc1, net1] = await Promise.all([readArcstats(), readNetDev()])
      const windowMs = t1 - t0

      const arc = computeArc(arc0, arc1)
      const net = computeNet(net0, net1, windowMs)
      const { pools, disks } = await computeIo(iostatText)

      return { sampledAt, windowMs, arc, pools, disks, net }
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

  /** Per-pool and per-leaf-disk I/O from the interval (LAST) iostat sample. */
  async function computeIo(iostatText: string): Promise<{ pools: PoolTelemetry[], disks: DiskTelemetry[] }> {
    const pools: PoolTelemetry[] = []
    const disks: DiskTelemetry[] = []
    if (!iostatText.trim())
      return { pools, disks }

    const samples = parseZpoolIostat(iostatText)
    const sample = samples[samples.length - 1]
    if (!sample || sample.length === 0)
      return { pools, disks }

    // Map iostat leaf names (kernel like `sdb` or already-by-id) to the SAME
    // stable by-id identity the Disks view / pool topology uses. `ls -la
    // /dev/disk/by-id/` gives kernel→by-id; a name that is already a by-id (or
    // unresolvable) is used verbatim.
    let byIdMap = new Map<string, string>()
    try {
      const byIdResult = await executor.exec('/usr/bin/ls', ['-la', '/dev/disk/by-id/'])
      byIdMap = parseDiskByIdListing(byIdResult.stdout)
    }
    catch { /* leaf names used verbatim */ }

    for (let i = 0; i < sample.length; i++) {
      const node = sample[i]
      if (node.depth === 0) {
        pools.push({ name: node.name, ...nodeToIoStats(node) })
        continue
      }
      // A leaf disk is any non-pool row with no deeper child row following it.
      const hasChild = i + 1 < sample.length && sample[i + 1].depth > node.depth
      if (hasChild)
        continue
      disks.push({
        id: byIdMap.get(node.name) ?? node.name,
        pool: node.pool,
        ...(node.vdev ? { vdev: node.vdev } : {}),
        ...nodeToIoStats(node),
      })
    }
    return { pools, disks }
  }
}

/** Read a /proc file, returning null on any error (fail-open). */
async function readArcstats(): Promise<string | null> {
  return readProc(ARCSTATS_PATH)
}
async function readNetDev(): Promise<string | null> {
  return readProc(PROC_NET_DEV)
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
    disks: [],
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
