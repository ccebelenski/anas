import type { ArcTelemetry } from '@anas/shared'

/**
 * Parser + rate math for `/proc/spl/kstat/zfs/arcstats` (story 2.7).
 *
 * The file is a kstat table: a numeric header line, a `name type data` column
 * header, then one `name  <type>  <value>` row per counter. We only need a
 * handful of counters; every value is a plain integer.
 */

/** The arcstats counters the dashboard telemetry needs. */
export interface ArcStats {
  /** Lifetime ARC hits. */
  hits: number
  /** Lifetime ARC misses. */
  misses: number
  /** Current ARC size in bytes. */
  size: number
  /** Target size `c` in bytes. */
  c: number
  /** Max size `c_max` in bytes. */
  cMax: number
  /** Lifetime L2ARC hits. */
  l2Hits: number
  /** Lifetime L2ARC misses. */
  l2Misses: number
  /** Current L2ARC size in bytes (0 when no cache device is configured). */
  l2Size: number
}

/**
 * Parse arcstats text into the counters we need. Missing counters read as 0,
 * so an older/newer kernel that omits one degrades gracefully rather than
 * throwing.
 */
export function parseArcstats(text: string): ArcStats {
  const values = new Map<string, number>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line)
      continue
    // `name  type  data` — split on whitespace; name is first, value is last.
    const parts = line.split(/\s+/)
    if (parts.length < 3)
      continue
    const name = parts[0]
    const value = Number(parts[parts.length - 1])
    if (Number.isNaN(value))
      continue // skips the `name type data` header row (data === 'data')
    values.set(name, value)
  }

  const get = (name: string): number => values.get(name) ?? 0
  return {
    hits: get('hits'),
    misses: get('misses'),
    size: get('size'),
    c: get('c'),
    cMax: get('c_max'),
    l2Hits: get('l2_hits'),
    l2Misses: get('l2_misses'),
    l2Size: get('l2_size'),
  }
}

/**
 * Hit ratio over a window given the delta of hits and misses. Falls back to the
 * lifetime ratio when the window saw no accesses, and to 0 when even lifetime is
 * empty. Always clamped to 0–1 to satisfy the schema.
 */
export function hitRatio(
  deltaHits: number,
  deltaMisses: number,
  lifetimeHits: number,
  lifetimeMisses: number,
): number {
  const windowAccesses = deltaHits + deltaMisses
  if (windowAccesses > 0)
    return clamp01(deltaHits / windowAccesses)
  const lifetimeAccesses = lifetimeHits + lifetimeMisses
  if (lifetimeAccesses > 0)
    return clamp01(lifetimeHits / lifetimeAccesses)
  return 0
}

function clamp01(n: number): number {
  if (n < 0)
    return 0
  if (n > 1)
    return 1
  return n
}

/**
 * Compose the ARC telemetry from two snapshots. Sizes/targets come from the
 * later snapshot (`cur`); the hit ratio is computed over the window with a
 * lifetime fallback. L2 is null unless a cache device exists (`l2Size > 0`).
 */
export function computeArcTelemetry(prev: ArcStats, cur: ArcStats): ArcTelemetry {
  const arc: ArcTelemetry = {
    hitRatio: hitRatio(cur.hits - prev.hits, cur.misses - prev.misses, cur.hits, cur.misses),
    size: cur.size,
    target: cur.c,
    max: cur.cMax,
    l2: null,
  }
  if (cur.l2Size > 0) {
    arc.l2 = {
      hitRatio: hitRatio(cur.l2Hits - prev.l2Hits, cur.l2Misses - prev.l2Misses, cur.l2Hits, cur.l2Misses),
      size: cur.l2Size,
    }
  }
  return arc
}
