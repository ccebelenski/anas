import type { IoStats } from '@anas/shared'

/**
 * Parser + rate math for `/proc/diskstats` (story 11.15 — AHR I/O telemetry).
 *
 * The AHR analog of the ZFS zpool-iostat sampling: two snapshots ~1s apart, the
 * sector/io/tick deltas give throughput, IOPS, and await latency. One line per
 * block device (whole disks, partitions, md arrays, dm targets):
 *
 *   <major> <minor> <name> f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 [f12..f17]
 *
 * The fields after the name (1-indexed, per the kernel's iostats doc):
 *   1  reads completed        (rd_ios)
 *   2  reads merged
 *   3  sectors read           (rd_sectors, always 512-byte units)
 *   4  ms spent reading       (rd_ticks)
 *   5  writes completed       (wr_ios)
 *   6  writes merged
 *   7  sectors written        (wr_sectors, 512-byte units)
 *   8  ms spent writing       (wr_ticks)
 *   9  I/Os in progress
 *   10 ms doing I/Os
 *   11 weighted ms doing I/Os
 *   (12..17 discard/flush on newer kernels — unused here)
 *
 * Counters are cumulative since boot; we diff two snapshots for per-second
 * rates. `await` (per-direction average wait) is the tick-delta / io-delta — the
 * total time a request waited (queue + service), NOT the device service time.
 * That is the honest limit of diskstats and is labeled as await in the UI.
 */

/** Cumulative counters for one block device, from one /proc/diskstats line. */
export interface DiskstatsCounters {
  /** Kernel device name (e.g. `md127`, `dm-0`, `sdd1`). */
  device: string
  readIos: number
  readSectors: number
  /** Milliseconds spent reading (rd_ticks). */
  readTicksMs: number
  writeIos: number
  writeSectors: number
  /** Milliseconds spent writing (wr_ticks). */
  writeTicksMs: number
}

/**
 * diskstats always reports sectors in 512-byte units, independent of the
 *  device's logical/physical sector size.
 */
const SECTOR_BYTES = 512
const NS_PER_MS = 1e6
const WHITESPACE_RE = /\s+/

/** Parse /proc/diskstats into a map keyed by kernel device name. */
export function parseDiskstats(text: string): Map<string, DiskstatsCounters> {
  const out = new Map<string, DiskstatsCounters>()
  for (const rawLine of text.split('\n')) {
    const tokens = rawLine.trim().split(WHITESPACE_RE)
    // major, minor, name, then at least the 8 base read/write fields.
    if (tokens.length < 11)
      continue
    const device = tokens[2]
    if (!device)
      continue
    const readIos = num(tokens[3])
    const readSectors = num(tokens[5])
    const readTicksMs = num(tokens[6])
    const writeIos = num(tokens[7])
    const writeSectors = num(tokens[9])
    const writeTicksMs = num(tokens[10])
    // A line whose value columns are non-numeric (a stray header) is skipped.
    if ([readIos, readSectors, readTicksMs, writeIos, writeSectors, writeTicksMs].some(Number.isNaN))
      continue
    out.set(device, { device, readIos, readSectors, readTicksMs, writeIos, writeSectors, writeTicksMs })
  }
  return out
}

/**
 * Map two diskstats snapshots of ONE device onto the shared {@link IoStats}
 * shape (the AHR analog of zpool-iostat's `nodeToIoStats`).
 *
 *  - Throughput / IOPS: the positive delta over the window in bytes-or-ops per
 *    second. A missing prior sample, a non-positive window, or a counter
 *    wraparound / reset (a NEGATIVE delta — kernel counters are unsigned and can
 *    wrap) clamps that metric to 0 rather than emitting a garbage rate.
 *  - Latency (await): tick-delta / io-delta, ms → ns. A direction with ZERO
 *    completed I/O in the window reports `null` (idle) — never NaN and never a
 *    fabricated 0, matching how ZFS idle latency reads null.
 */
export function diskstatsToIoStats(
  prev: DiskstatsCounters | undefined,
  cur: DiskstatsCounters,
  windowMs: number,
): IoStats {
  const seconds = windowMs > 0 ? windowMs / 1000 : 0
  const rIos = delta(prev?.readIos, cur.readIos)
  const wIos = delta(prev?.writeIos, cur.writeIos)
  const rSectors = delta(prev?.readSectors, cur.readSectors)
  const wSectors = delta(prev?.writeSectors, cur.writeSectors)
  const rTicks = delta(prev?.readTicksMs, cur.readTicksMs)
  const wTicks = delta(prev?.writeTicksMs, cur.writeTicksMs)
  return {
    readBytesPerSec: seconds > 0 ? (rSectors * SECTOR_BYTES) / seconds : 0,
    writeBytesPerSec: seconds > 0 ? (wSectors * SECTOR_BYTES) / seconds : 0,
    readIops: seconds > 0 ? rIos / seconds : 0,
    writeIops: seconds > 0 ? wIos / seconds : 0,
    // await = per-direction average wait; null (idle) when no I/O completed.
    readLatencyNs: rIos > 0 ? (rTicks / rIos) * NS_PER_MS : null,
    writeLatencyNs: wIos > 0 ? (wTicks / wIos) * NS_PER_MS : null,
  }
}

/** Positive counter delta; 0 for a missing prior sample or a wrap/reset. */
function delta(prev: number | undefined, cur: number): number {
  if (prev === undefined)
    return 0
  const d = cur - prev
  return d > 0 ? d : 0
}

function num(token: string | undefined): number {
  if (token === undefined)
    return Number.NaN
  return Number(token)
}
