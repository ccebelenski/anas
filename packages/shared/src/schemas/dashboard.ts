import { z } from 'zod'
import { ISODateTime } from './common.js'
import { PoolState, VdevRole, VdevState, VdevType } from './zfs.js'

/**
 * Dashboard schemas (Epic 2). Two endpoints:
 *   - GET /v1/status    — the base aggregate (2.1–2.6): pool health, capacity,
 *                         disk-health counts, share status, jobs, warnings.
 *   - GET /v1/telemetry — a LIVE sample (2.7): ARC, per-pool & per-disk I/O
 *                         (bytes/s, IOPS, latency), and network throughput.
 *                         Sampled on demand over a ~1s window; NO stored history
 *                         (Principle 7 — the client polls while the panel is open
 *                         and keeps any rolling buffer itself).
 */

// ---- GET /v1/status : base aggregate (stories 2.1–2.6) -----------------------

/** A problem surfaced prominently on the dashboard (2.5). */
export const DashboardWarning = z.object({
  level: z.enum(['warning', 'critical']),
  category: z.enum(['pool', 'disk', 'scrub', 'share', 'capacity']),
  message: z.string(),
  /** Optional target name (pool/disk/share) the UI can deep-link to. */
  ref: z.string().optional(),
})
export type DashboardWarning = z.infer<typeof DashboardWarning>

/** Compact per-pool health/capacity for the dashboard (subset of PoolSummary). */
export const PoolStatusBrief = z.object({
  name: z.string(),
  state: PoolState,
  /** Capacity used, 0–100. */
  capacity: z.number().min(0).max(100),
  size: z.number().nonnegative(),
  allocated: z.number().nonnegative(),
  free: z.number().nonnegative(),
  scanRunning: z.boolean(),
})
export type PoolStatusBrief = z.infer<typeof PoolStatusBrief>

/** Fleet health roll-up, keyed by the fused SMART+ZFS healthStatus. */
export const DiskHealthCounts = z.object({
  total: z.number().int().nonnegative(),
  healthy: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  critical: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
})
export type DiskHealthCounts = z.infer<typeof DiskHealthCounts>

/** Share service status (2.3). Active flags omitted when not detectable. */
export const ShareStatusBrief = z.object({
  smbCount: z.number().int().nonnegative(),
  nfsCount: z.number().int().nonnegative(),
  smbActive: z.boolean().optional(),
  nfsActive: z.boolean().optional(),
})
export type ShareStatusBrief = z.infer<typeof ShareStatusBrief>

/** A recent/active job for the activity panel (2.4). */
export const JobBrief = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  startedAt: ISODateTime.optional(),
  /** When the job reached a terminal state; omitted while still running. */
  finishedAt: ISODateTime.optional(),
  /** Elapsed time in ms: finishedAt−startedAt for finished jobs, now−startedAt
   *  for running ones. Omitted when the job never started. */
  durationMs: z.number().nonnegative().optional(),
})
export type JobBrief = z.infer<typeof JobBrief>

export const StatusSummary = z.object({
  node: z.string(),
  pools: z.array(PoolStatusBrief),
  disks: DiskHealthCounts,
  shares: ShareStatusBrief,
  jobs: z.array(JobBrief),
  warnings: z.array(DashboardWarning),
})
export type StatusSummary = z.infer<typeof StatusSummary>

// ---- GET /v1/telemetry : live sampled performance (story 2.7) ----------------

/** I/O rates over the sample window. Latency is the average wait in nanoseconds
 *  (`zpool iostat -pl`), null when the device was idle / unavailable. */
export const IoStats = z.object({
  readBytesPerSec: z.number().nonnegative(),
  writeBytesPerSec: z.number().nonnegative(),
  readIops: z.number().nonnegative(),
  writeIops: z.number().nonnegative(),
  readLatencyNs: z.number().nonnegative().nullable(),
  writeLatencyNs: z.number().nonnegative().nullable(),
})
export type IoStats = z.infer<typeof IoStats>

export const ArcTelemetry = z.object({
  /** Hit ratio over the window, 0–1 (falls back to the lifetime ratio when the
   *  window had no ARC accesses). */
  hitRatio: z.number().min(0).max(1),
  /** Current ARC size (bytes). */
  size: z.number().nonnegative(),
  /** Target size `c` (bytes). */
  target: z.number().nonnegative(),
  /** Max size `c_max` (bytes). */
  max: z.number().nonnegative(),
  /** L2ARC, null when none is configured. */
  l2: z.object({
    hitRatio: z.number().min(0).max(1),
    size: z.number().nonnegative(),
  }).nullable(),
})
export type ArcTelemetry = z.infer<typeof ArcTelemetry>

/** Leaf-disk I/O. Its pool and vdev are implied by nesting. */
export const DiskTelemetry = IoStats.extend({
  /** Stable by-id / identity (mapped from the iostat leaf name). */
  id: z.string(),
})
export type DiskTelemetry = z.infer<typeof DiskTelemetry>

/** A vdev's aggregate I/O plus its topology (joined from `zpool status`) and
 *  the leaf disks it contains. */
export const VdevTelemetry = IoStats.extend({
  /** ZFS vdev name, e.g. "mirror-0". */
  name: z.string(),
  /** Topology type (mirror/raidz/…/disk). */
  type: VdevType,
  /** Role within the pool (data/log/cache/special/dedup/spare). */
  role: VdevRole,
  /** Vdev state (ONLINE/DEGRADED/FAULTED/…). */
  state: VdevState,
  disks: z.array(DiskTelemetry),
})
export type VdevTelemetry = z.infer<typeof VdevTelemetry>

/** A pool's aggregate I/O plus the vdevs beneath it. */
export const PoolTelemetry = IoStats.extend({
  name: z.string(),
  vdevs: z.array(VdevTelemetry),
})
export type PoolTelemetry = z.infer<typeof PoolTelemetry>

export const NetInterface = z.object({
  name: z.string(),
  rxBytesPerSec: z.number().nonnegative(),
  txBytesPerSec: z.number().nonnegative(),
})
export type NetInterface = z.infer<typeof NetInterface>

export const NetTelemetry = z.object({
  interfaces: z.array(NetInterface),
  totalRxBytesPerSec: z.number().nonnegative(),
  totalTxBytesPerSec: z.number().nonnegative(),
})
export type NetTelemetry = z.infer<typeof NetTelemetry>

export const Telemetry = z.object({
  sampledAt: ISODateTime,
  /** Length of the sample window in ms (~1000). */
  windowMs: z.number().nonnegative(),
  arc: ArcTelemetry,
  /** Nested pool → vdevs[] → disks[] I/O tree. */
  pools: z.array(PoolTelemetry),
  net: NetTelemetry,
})
export type Telemetry = z.infer<typeof Telemetry>
