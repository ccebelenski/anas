import type {
  AhrPool,
  AhrPoolBrief,
  ArcTelemetry,
  DashboardSection,
  DashboardWarning,
  Disk,
  DiskHealthCounts,
  DiskTelemetry,
  IscsiTargetDetail,
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
import type { AbandonedChild } from '../executor/deadline.js'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { SharePathProbe } from '../services/share-path.js'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename } from 'node:path'
import { GROUPING_VDEV_TYPES } from '@anas/shared'
import { abandonedChildren, CommandTimeoutError, formatBudget } from '../executor/deadline.js'
import { WatchedExecutor } from '../executor/watch.js'
import { computeArcTelemetry, parseArcstats } from '../parsers/arcstats.js'
import { leafDiskId, parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { parseExports } from '../parsers/exports.js'
import { computeNetTelemetry, parseProcNetDev } from '../parsers/net-dev.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { nodeToIoStats, parseZpoolIostat } from '../parsers/zpool-iostat.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseZpoolStatus } from '../parsers/zpool-status.js'
import { buildFailedCreateWarnings, withAhrCreateStatus } from '../services/ahr-create-status.js'
import { collectAhrTelemetry } from '../services/ahr-io.js'
import { buildAhrCapacityWarnings, collectAhrPoolBriefs, collectAhrWarnings } from '../services/ahr-topology.js'
import { collectBackupWarnings } from '../services/backup-units.js'
import { collectCloudWarnings } from '../services/cloud-units.js'
import { readConfig } from '../services/config-writer.js'
import { collectIscsiWarnings } from '../services/iscsi-warnings.js'
import { collectMountWarnings } from '../services/mounts.js'
import { buildReplicationWarnings, collectTaskStatuses } from '../services/replication-units.js'
import { probeSharePaths } from '../services/share-path.js'
import { collectScheduleWarnings } from '../services/snapshot-schedule-units.js'
import { collectDisks } from './disks.js'

const ARCSTATS_PATH = '/proc/spl/kstat/zfs/arcstats'
const PROC_NET_DEV = '/proc/net/dev'
const PROC_DISKSTATS = '/proc/diskstats'
const ZPOOL = '/usr/sbin/zpool'
const SYSTEMCTL = '/usr/bin/systemctl'

/**
 * The wall budget of one /v1/status section (cr.35). Inside the gateway's
 * 20 s socket budget with room for the reply, and above the request lane's
 * 10 s per command, so a single hung command that can be stopped is named by
 * its own CommandTimeoutError at 10 s. The §6.3 rows are 12 s (cr.35r) — at
 * the wall, not below it — and the wall still ends the section first: a row
 * deadline only becomes an error after the child stops (up to 7 s later on
 * the TERM/KILL ladder), so a row-bounded command (a 12 s smartctl or ssh
 * inside a section) is still running when this wall fires and the section
 * answers 'had not answered after 12 s'.
 */
export const DASHBOARD_SECTION_BUDGET_MS = 12_000

/** Pool states that are outright critical (data at risk / unavailable). */
const CRITICAL_POOL_STATES = new Set(['FAULTED', 'UNAVAIL', 'REMOVED', 'SUSPENDED'])

/**
 * Vdev types whose members iostat prints NESTED under them — their leaves are
 * never vdev rows, so the topology join must not index them by leaf name. One
 * set, shared with the vdev-remove resolver: GROUPING_VDEV_TYPES in
 * `@anas/shared`, beside the VdevType values it is a set of.
 */

/**
 * Dashboard endpoints (Epic 2).
 *   GET /v1/status    — the base aggregate (2.1–2.6): pools, disk-health counts,
 *                       share status, recent jobs, and derived warnings.
 *   GET /v1/telemetry — a live on-demand ~1s sample (2.7): ARC, per-pool and
 *                       per-disk I/O, and network throughput.
 *
 * Both are read-only (no jobs, no mutations) and FAIL-OPEN: any sub-part that
 * errors contributes empty/zero rather than failing the whole panel. On
 * /v1/status that empty part is never silent (cr.35): a section whose read
 * failed, timed out or overran its budget is listed in `unavailable` and
 * carded, so an empty pool list there is never "no pools".
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
    /** iSCSI read paths (configfs / saveconfig) — defaults are production. */
    iscsiPaths?: IscsiPaths
    /** One /v1/status section's wall budget (cr.35); tests shorten it. */
    sectionBudgetMs?: number
  },
) {
  const { executor, jobQueue, diskIdentityCache, smbConfPath, exportsPath, systemdDir, fstabPath, storagePath, mdadmConfPath, ahrIntentDir, iscsiPaths } = opts
  const sectionBudgetMs = opts.sectionBudgetMs ?? DASHBOARD_SECTION_BUDGET_MS

  // A pool mid-create must not card as a CRITICAL failure for the whole build
  // (issue #7): the half-built stack is genuinely VG-less, so only the live job
  // can tell "being built" from "wrecked". Applied to both AHR /v1/status
  // sources so the Pools section and the warning cards agree.
  const ahrCreateStatus = (pool: AhrPool): AhrPool => withAhrCreateStatus(pool, jobQueue)

  /**
   * Why an ANAS target is disabled, when a retained job still says (live-proof
   * F12). The image-restore door is the only thing in ANAS that leaves a target
   * disabled on purpose: after a mid-stream failure the half-written LUN stays
   * offline and re-enabling is the operator's acknowledgement. That decision is
   * recorded in exactly one place — the failed job's error text — and jobs are
   * ephemeral by design, so this is best-effort by construction: no job, no
   * detail, and the card still says the target is dark.
   */
  function iscsiDisabledDetail(target: IscsiTargetDetail): string | undefined {
    const job = jobQueue.findByOperation('backup.restore.image', target.iqn, 'target')
    if (job?.status !== 'failed' || !job.error?.message)
      return undefined
    return `A whole-image restore onto it failed and left it disabled: ${job.error.message}`
  }

  // --- GET /v1/status ------------------------------------------------------
  server.get('/status', async () => {
    // Each section is read by its own collector, through its own watched
    // executor, under its own wall budget (cr.35). A section that throws,
    // overruns, or whose read timed out — even a timeout its collector
    // caught and turned into an empty answer — is the empty shape here AND
    // listed in `unavailable` with a card naming the command; every other
    // section renders as read. One hung read never turns the dashboard into
    // a 503 (Promise.all over collectors that could reject did), and never
    // reads as "no pools".
    const [poolStatus, diskHealth, shares, jobs, replicationWarnings, mountWarnings, backupWarnings, cloudWarnings, ahrWarnings, ahrPools, scheduleWarnings, iscsiWarnings] = await Promise.all([
      readSection('pools', { pools: [], scanErrors: new Map<string, number>() }, exec => collectPoolStatus(exec)),
      readSection('disks', { counts: { total: 0, healthy: 0, warning: 0, critical: 0, unknown: 0 }, disks: [] as Disk[] }, exec => collectDiskHealth(exec)),
      readSection('shares', { brief: { smbCount: 0, nfsCount: 0 }, warnings: [] as DashboardWarning[] }, exec => collectShareStatus(exec)),
      readSection('jobs', [] as JobBrief[], async () => collectJobs()),
      readSection('replication', [] as DashboardWarning[], exec => collectReplicationWarnings(exec)),
      readSection('mounts', [] as DashboardWarning[], exec => collectMountWarnings(exec, { fstabPath, storagePath, mdadmConfPath })),
      readSection('backup', [] as DashboardWarning[], exec => collectBackupWarnings(exec, systemdDir)),
      // Cloud sync (rclone.2): failed/overdue enabled tasks → 'cloud' warnings,
      // the same rule and the same code backup's go through (task-units.ts with
      // the cloud descriptor). Healthy and disabled tasks contribute nothing.
      readSection('cloud', [] as DashboardWarning[], exec => collectCloudWarnings(exec, systemdDir)),
      // AHR (11.10): only bad states card (degraded/failed/readonly/halted
      // expansion); healthy pools contribute nothing.
      readSection('ahr', [] as DashboardWarning[], exec => collectAhrWarnings(exec, ahrIntentDir, ahrCreateStatus)),
      // AHR (11.13, §10 revision): per-pool briefs for the headline Pools
      // section — healthy pools render alongside ZFS pools.
      readSection('ahrPools', [] as AhrPoolBrief[], exec => collectAhrPoolBriefs(exec, mdadmConfPath, ahrCreateStatus)),
      // Snapshot schedules (17.7): failed/overdue enabled schedules → 'schedule'
      // warnings; healthy/idle and disabled contribute nothing.
      readSection('schedules', [] as DashboardWarning[], exec => collectScheduleWarnings(exec, systemdDir)),
      // iSCSI (iscsi.5): the saveconfig ⟷ configfs diff → 'iscsi' warnings. A
      // boot restore whose backing device was missing reports systemd SUCCESS
      // and silently drops the LUN, so this PULL is the ONLY place a missing
      // LUN, a target serving nothing or a portal on a dead address is ever
      // surfaced. Healthy adds nothing; a node without LIO costs two stats and
      // adds nothing.
      // Story `iscsi.8` widens it twice: a fileio LUN found to be serving a
      // PLACEHOLDER gets a card (REPORTED only since cr.62 — review L9, no GET
      // acts; Repair takes it offline), and a disabled ANAS target gets a card
      // that names WHY when a retained job still knows — the image restore that
      // left it dark says so in its own failure text, and nothing else on the
      // system remembers (no shadow state).
      readSection('iscsi', [] as DashboardWarning[], exec => collectIscsiWarnings(exec, iscsiPaths ?? {}, { disabledDetail: iscsiDisabledDetail })),
    ])
    const sections = [poolStatus, diskHealth, shares, jobs, replicationWarnings, mountWarnings, backupWarnings, cloudWarnings, ahrWarnings, ahrPools, scheduleWarnings, iscsiWarnings]
    const unavailable = sections.flatMap(r => (r.unavailable ? [r.unavailable] : []))

    const summary: StatusSummary = {
      node: hostname(),
      pools: poolStatus.value.pools,
      disks: diskHealth.value.counts,
      shares: shares.value.brief,
      jobs: jobs.value,
      // Pool/disk warnings, stale-share warnings (same smb.conf/exports parse
      // collectShareStatus already ran), plus failed-replication-task warnings.
      // AHR pools get the SAME capacity cards ZFS pools do — parallel
      // construction, derived from the same briefs the Pools section renders
      // (11.13): identical ≥95/≥90 thresholds, same 'capacity' category.
      // A create that failed and rolled itself back leaves NO pool behind, so
      // it can only be surfaced from the job side (issue #11) — without this the
      // failure would be discoverable nowhere in the UI.
      // cr.35: the unavailable sections' cards lead — the rest of the summary
      // is read with them in mind.
      warnings: [
        ...buildUnavailableWarnings(unavailable),
        ...buildWarnings(poolStatus.value, diskHealth.value.disks),
        ...shares.value.warnings,
        ...replicationWarnings.value,
        ...mountWarnings.value,
        ...backupWarnings.value,
        ...cloudWarnings.value,
        ...ahrWarnings.value,
        ...buildAhrCapacityWarnings(ahrPools.value),
        ...buildFailedCreateWarnings(ahrPools.value.map(p => p.name), jobQueue),
        ...scheduleWarnings.value,
        ...iscsiWarnings.value,
        ...buildAbandonedWarnings(abandonedChildren.list()),
      ],
      ahrPools: ahrPools.value,
      unavailable: unavailable.map(u => u.section),
    }
    return { data: summary }
  })

  /** One /v1/status section, through {@link readDashboardSection}. */
  function readSection<T>(
    section: DashboardSection,
    fallback: T,
    read: (exec: CommandExecutor) => Promise<T>,
  ): Promise<SectionRead<T>> {
    return readDashboardSection(executor, sectionBudgetMs, section, fallback, read)
  }

  /**
   * Replication tasks whose last run failed → 'replication' warnings (5.5.3).
   *  Reuses the same task-status derivation the Replication view uses; fail-open
   *  to no warnings (units-as-store, ZFS + systemd truth).
   */
  async function collectReplicationWarnings(exec: CommandExecutor): Promise<DashboardWarning[]> {
    try {
      return buildReplicationWarnings(await collectTaskStatuses(exec, systemdDir))
    }
    catch {
      return []
    }
  }

  /** Pool briefs + the scan/state context the warnings pass needs. */
  async function collectPoolStatus(exec: CommandExecutor): Promise<{
    pools: PoolStatusBrief[]
    scanErrors: Map<string, number>
  }> {
    const pools: PoolStatusBrief[] = []
    const scanErrors = new Map<string, number>()
    try {
      const [listResult, statusResult] = await Promise.all([
        exec.exec(ZPOOL, ['list', '-j']),
        exec.exec(ZPOOL, ['status', '-jv']),
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
  async function collectDiskHealth(exec: CommandExecutor): Promise<{ counts: DiskHealthCounts, disks: Disk[] }> {
    const counts: DiskHealthCounts = { total: 0, healthy: 0, warning: 0, critical: 0, unknown: 0 }
    let disks: Disk[] = []
    try {
      disks = await collectDisks(exec, diskIdentityCache)
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
  async function collectShareStatus(exec: CommandExecutor): Promise<{ brief: ShareStatusBrief, warnings: DashboardWarning[] }> {
    const brief: ShareStatusBrief = { smbCount: 0, nfsCount: 0 }
    const warnings: DashboardWarning[] = []
    try {
      const smbShares = parseSmbConf(await readConfig(smbConfPath)).shares
      brief.smbCount = smbShares.length
      const probes = await probeSharePaths(exec, smbShares.map(s => s.path))
      for (const share of smbShares)
        warnings.push(...sharePathWarnings('smb', share.name, share.path, probes.get(share.path)!))
    }
    catch { /* fail-open */ }
    try {
      const exports = parseExports(await readConfig(exportsPath))
      brief.nfsCount = exports.length
      const probes = await probeSharePaths(exec, exports.map(e => e.path))
      for (const exp of exports)
        warnings.push(...sharePathWarnings('nfs', exp.path, exp.path, probes.get(exp.path)!))
    }
    catch { /* fail-open */ }
    const smbActive = await serviceActive(exec, 'smbd')
    if (smbActive !== undefined)
      brief.smbActive = smbActive
    const nfsActive = await serviceActive(exec, 'nfs-server')
    if (nfsActive !== undefined)
      brief.nfsActive = nfsActive
    return { brief, warnings }
  }

  /** `systemctl is-active <unit>` → true/false, or undefined if undetectable. */
  async function serviceActive(exec: CommandExecutor, unit: string): Promise<boolean | undefined> {
    try {
      const r = await exec.exec(SYSTEMCTL, ['is-active', unit])
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
      // waits one second, prints the interval sample, then exits. cr.21: `--`
      // ends option parsing before the derived pool-name operands.
      let iostatText = ''
      if (poolNames.length > 0) {
        try {
          const r = await executor.exec(ZPOOL, ['iostat', '-plv', '--', ...poolNames, '1', '2'])
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
      const pools = await computeIo(iostatText, new Set(poolNames))
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
  async function computeIo(iostatText: string, knownPools: ReadonlySet<string>): Promise<PoolTelemetry[]> {
    const pools: PoolTelemetry[] = []
    if (!iostatText.trim())
      return pools

    // The pools we asked iostat about — without them a `logs`/`special`/`dedup`
    // section header reads as a pool of its own (vdevs.1 consumer audit).
    const samples = parseZpoolIostat(iostatText, knownPools)
    const sample = samples.at(-1)
    if (!sample || sample.length === 0)
      return pools

    // Both joins are independent and fail-open: the by-id map (leaf → stable
    // identity) and the topology map (vdev → type/role/state).
    const [byIdMap, topology] = await Promise.all([loadByIdMap(), fetchVdevTopology()])

    // Leaf → disk id through {@link leafDiskId}: a kernel-named leaf — whole
    // disk or partition, the device-named-pool shape (0.4.1) — resolves to the
    // SAME whole-disk by-id the Disks view carries, so it cross-references
    // like a by-id leaf; anything unresolvable keeps its own name.
    const disk = (name: string, node: (typeof sample)[number]): DiskTelemetry => ({
      id: leafDiskId(name, byIdMap),
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
          for (const vdev of group.vdevs) {
            const join: VdevJoin = { type: vdev.type, role: group.role, state: vdev.state }
            vmap.set(vdev.name, join)
            // A pool-level section's bare leaves are one CONTAINER vdev named
            // after the section (`logs`, `cache`, `special`, `dedup`,
            // `spares`) in the status parser, while iostat prints each leaf at
            // the vdev indent. Index every leaf of such a vdev, so a
            // special/log/dedup/cache device joins with its own role instead of
            // falling back to `data` (vdevs.1 consumer audit) — a section
            // holding two cache devices included.
            //
            // Under BOTH spellings: `disk.id` is the whole-disk by-id (the
            // `-partN` suffix stripped), while iostat prints the leaf exactly
            // as `zpool status` names it — `ata-SSD-part2` on a by-id
            // partition-backed vdev, `sdb5` on a kernel-name one. Indexing the
            // id alone missed every by-id partition leaf.
            //
            // A GROUPING vdev is left out: iostat nests a mirror's or raidz's
            // members UNDER it, so its leaves are not vdev rows. A key an
            // actual vdev already owns is never overwritten.
            if (!GROUPING_VDEV_TYPES.has(vdev.type)) {
              for (const disk of vdev.disks) {
                for (const key of [disk.id, basename(disk.path)]) {
                  if (!vmap.has(key))
                    vmap.set(key, join)
                }
              }
            }
          }
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

/** One section's read: its value, and why it is unavailable when it is. */
export interface SectionRead<T> {
  value: T
  unavailable?: UnavailableSection
}

/** A section that could not be read, and why (the command that did not answer). */
export interface UnavailableSection {
  section: DashboardSection
  reason: string
}

/**
 * Read one /v1/status section (cr.35). `read` gets a {@link WatchedExecutor}
 * over `executor` and `budgetMs` of wall time; the section is UNAVAILABLE —
 * `fallback` (the empty shape) plus a reason — when `read` throws, does not
 * finish in time (it keeps running; its answer is dropped), or saw a
 * CommandTimeoutError it may have caught and turned into an empty answer. A
 * read that finished keeps its value even then: the reason says it is
 * incomplete, and the value is never presented as complete.
 */
export async function readDashboardSection<T>(
  executor: CommandExecutor,
  budgetMs: number,
  section: DashboardSection,
  fallback: T,
  read: (exec: CommandExecutor) => Promise<T>,
): Promise<SectionRead<T>> {
  const watch = new WatchedExecutor(executor)
  let timer: NodeJS.Timeout | undefined
  type Outcome = { kind: 'done', value: T } | { kind: 'threw', err: unknown } | { kind: 'late' }
  const outcome = await Promise.race<Outcome>([
    read(watch).then(value => ({ kind: 'done', value }), (err: unknown) => ({ kind: 'threw', err })),
    new Promise<Outcome>((resolve) => {
      timer = setTimeout(resolve, budgetMs, { kind: 'late' })
    }),
  ])
  clearTimeout(timer)
  if (outcome.kind === 'late') {
    const waiting = watch.oldestRunning()
    const reason = waiting
      ? `'${waiting}' had not answered after ${formatBudget(budgetMs)}`
      : `its read did not finish within ${formatBudget(budgetMs)}`
    return { value: fallback, unavailable: { section, reason } }
  }
  if (outcome.kind === 'threw') {
    const err = outcome.err
    const reason = err instanceof CommandTimeoutError ? err.message : `its read failed: ${err instanceof Error ? err.message : String(err)}`
    return { value: fallback, unavailable: { section, reason } }
  }
  if (watch.timeouts.length > 0)
    return { value: outcome.value, unavailable: { section, reason: watch.timeouts[0].message } }
  return { value: outcome.value }
}

/** What each section is called on its card. */
const SECTION_TITLE: Readonly<Record<DashboardSection, string>> = {
  pools: 'Pool status',
  disks: 'Disk health',
  shares: 'Share status',
  jobs: 'Recent jobs',
  replication: 'Replication task status',
  mounts: 'Mount status',
  backup: 'Backup task status',
  cloud: 'Cloud sync task status',
  ahr: 'AHR pool warnings',
  ahrPools: 'AHR pool status',
  schedules: 'Snapshot schedule status',
  iscsi: 'iSCSI status',
}

/**
 * cr.35: one `unavailable` card per section that could not be read — what is
 * missing, the command that did not answer, and that the rest is current.
 * Unreadable is never empty (WAVE3-DESIGN §6.2): without the card, an empty
 * pool list would read as "no pools".
 */
export function buildUnavailableWarnings(sections: UnavailableSection[]): DashboardWarning[] {
  return sections.map(u => ({
    level: 'warning',
    category: 'unavailable',
    message: `${SECTION_TITLE[u.section]} is unavailable: ${u.reason}. The rest of the dashboard is current.`,
  }))
}

/**
 * cr.34: one warning per command anasd gave up on — it outlived its deadline
 * and the SIGKILL after it, so it is stuck in the kernel (WAVE3-DESIGN §6.2,
 * §8.1 "an abandoned child": "the dashboard shows 'a command did not end'").
 * Nothing in ANAS can end it; the card says what usually causes it and what
 * clears it. GET /v1/health lists the same entries; neither shows the argv
 * (cr.34r: commands are named the way the audit log names them, by label).
 */
export function buildAbandonedWarnings(children: AbandonedChild[]): DashboardWarning[] {
  return children.map((c) => {
    const where = c.jobId !== undefined ? `job ${c.jobId}` : `a ${c.lane === 'request' ? 'request' : 'background task'}`
    return {
      level: 'warning',
      category: 'command',
      message: `'${c.label}' (pid ${c.pid}, from ${where}) ${c.cause === 'maxBuffer' ? 'was stopped for writing more output than the daemon keeps' : `did not end within ${formatBudget(c.budgetMs)}`} and survived SIGKILL: `
        + `it has been stuck in the kernel since ${c.since}. A suspended pool or a hung disk or mount is the usual cause. `
        + 'The warning clears when the command returns or anasd restarts.',
    }
  })
}

/**
 * The dashboard card for one share's path check (2.5, cr.35). A missing path
 * is a stale definition; a path that does not answer is a hung mount under a
 * live share — clients cannot use it either, and before cr.35 the check that
 * found it froze the whole daemon; an unreadable path is named with what stat
 * said. A path that exists adds nothing.
 */
export function sharePathWarnings(protocol: 'smb' | 'nfs', ref: string, path: string, probe: SharePathProbe): DashboardWarning[] {
  const what = protocol === 'smb' ? `SMB share '${ref}'` : `NFS export ${path}`
  switch (probe.state) {
    case 'exists':
      return []
    case 'missing':
      return [{
        level: 'warning',
        category: 'share',
        message: protocol === 'smb' ? `${what} points to a missing path ${path}` : `NFS export path ${path} no longer exists`,
        ref,
      }]
    case 'not-answering':
      return [{
        level: 'warning',
        category: 'share',
        message: `${what}: the path ${path} is not answering (${probe.detail ?? 'no answer'}) — the storage under it, usually an NFS or CIFS mount, is hung, and clients cannot use the share either`,
        ref,
      }]
    case 'unreadable':
      return [{
        level: 'warning',
        category: 'share',
        message: `${what}: the path ${path} could not be checked (${probe.detail ?? 'stat failed'})`,
        ref,
      }]
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
