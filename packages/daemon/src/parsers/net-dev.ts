import type { NetTelemetry } from '@anas/shared'

/**
 * Parser + rate math for `/proc/net/dev` (story 2.7 — network throughput).
 *
 * Two header lines, then one row per interface:
 *
 *   iface: <rx: bytes packets errs drop fifo frame compressed multicast> \
 *          <tx: bytes packets errs drop fifo colls carrier compressed>
 *
 * Cumulative counters since boot — we diff two snapshots for a per-second rate.
 */

/** Cumulative byte counters for one interface. */
export interface NetCounters {
  name: string
  rxBytes: number
  txBytes: number
}

/** The loopback device is never interesting for dashboard throughput. */
const LOOPBACK = 'lo'

/** Parse /proc/net/dev into per-interface cumulative rx/tx byte counters. */
export function parseProcNetDev(text: string): NetCounters[] {
  const out: NetCounters[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon === -1)
      continue // header lines ("Inter-|...", " face |...") have no "iface:"
    const name = line.slice(0, colon).trim()
    if (!name)
      continue
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number)
    // Receive block is 8 columns: bytes is [0]; Transmit bytes follows at [8].
    if (fields.length < 9)
      continue
    out.push({ name, rxBytes: fields[0], txBytes: fields[8] })
  }
  return out
}

/**
 * Compute per-interface and total byte rates from two snapshots over a window.
 * Excludes loopback. A negative delta (counter reset / interface re-created) or
 * a non-positive window clamps that interface's rate to 0.
 */
export function computeNetTelemetry(
  prev: NetCounters[],
  cur: NetCounters[],
  windowMs: number,
): NetTelemetry {
  const prevByName = new Map(prev.map(n => [n.name, n]))
  const seconds = windowMs / 1000
  const interfaces = []
  let totalRx = 0
  let totalTx = 0
  for (const c of cur) {
    if (c.name === LOOPBACK)
      continue
    const p = prevByName.get(c.name)
    const rxBytesPerSec = rate(p?.rxBytes, c.rxBytes, seconds)
    const txBytesPerSec = rate(p?.txBytes, c.txBytes, seconds)
    interfaces.push({ name: c.name, rxBytesPerSec, txBytesPerSec })
    totalRx += rxBytesPerSec
    totalTx += txBytesPerSec
  }
  return { interfaces, totalRxBytesPerSec: totalRx, totalTxBytesPerSec: totalTx }
}

function rate(prev: number | undefined, cur: number, seconds: number): number {
  if (prev === undefined || seconds <= 0)
    return 0
  const delta = cur - prev
  return delta > 0 ? delta / seconds : 0
}
