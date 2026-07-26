import type { IoStats } from '@anas/shared'

/**
 * Parser for `zpool iostat -plv <pools> 1 2` (story 2.7).
 *
 * The `1 2` sampling prints TWO samples: the first is a since-boot average, the
 * second is the trailing 1-second interval (true per-second rates). Each sample
 * is a block of rows led by a two-line group/column header and bracketed by
 * dashed separators:
 *
 *   <group header: capacity operations bandwidth total_wait disk_wait …>
 *   <col header:    pool  alloc free  read write  read write  read write  …>
 *   ------
 *   testpool                 alloc free  ops.r ops.w  bw.r bw.w  tw.r tw.w  …
 *     mirror-0               …
 *       sdb                  …
 *   ------
 *
 * Indentation of the NAME column encodes tree depth: 0 = pool, 2 = vdev, 4 =
 * leaf disk. After the name come 17 fixed value columns, two per metric group:
 *
 *   [0] capacity.alloc   [1] capacity.free
 *   [2] operations.read  [3] operations.write     ← IOPS
 *   [4] bandwidth.read   [5] bandwidth.write       ← bytes/sec
 *   [6] total_wait.read  [7] total_wait.write      ← latency ns
 *   [8] disk_wait.read   [9] disk_wait.write
 *   [10] syncq_wait.read [11] syncq_wait.write
 *   [12] asyncq.read     [13] asyncq.write
 *   [14] scrub.wait      [15] trim.wait            [16] rebuild.wait
 *
 * An idle device prints `-` for the wait cells; a `-` becomes null (latency) or
 * 0 (rate).
 */

/** One row of an iostat sample, positioned in the pool → vdev → disk tree. */
export interface IostatNode {
  /** The name as printed (pool, vdev like `mirror-0`, or leaf like `sdb`). */
  name: string
  /** 0 = pool, 1 = vdev, 2 = leaf disk (from name-column indentation / 2). */
  depth: number
  /** The owning pool (self for a pool row). */
  pool: string
  /** The owning vdev (undefined for pool/vdev rows). */
  vdev?: string
  /** operations read / write (IOPS). */
  ops: { read: number, write: number }
  /** bandwidth read / write (bytes/sec in the interval sample). */
  bandwidth: { read: number, write: number }
  /** total_wait read / write (latency ns); null when the cell was `-`. */
  totalWait: { read: number | null, write: number | null }
}

/** Column offsets within the value columns that follow the name. */
const COL = {
  opsRead: 2,
  opsWrite: 3,
  bwRead: 4,
  bwWrite: 5,
  twRead: 6,
  twWrite: 7,
} as const

const DASHES_RE = /^[\s-]+$/
const WHITESPACE_RE = /\s+/

/**
 * Parse the full multi-sample output into an array of samples, each an array of
 * nodes. The telemetry route uses the LAST sample (the per-second interval).
 */
export function parseZpoolIostat(text: string): IostatNode[][] {
  const samples: IostatNode[][] = []
  let current: IostatNode[] | null = null
  let currentPool = ''
  let currentVdev: string | undefined

  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim())
      continue
    // The group header ("...capacity...operations...") starts a new sample.
    if (rawLine.includes('capacity') && rawLine.includes('operations')) {
      current = []
      samples.push(current)
      currentPool = ''
      currentVdev = undefined
      continue
    }
    // Column header ("pool alloc free read write ...") and dashed separators.
    if (rawLine.includes('alloc') && rawLine.includes('free'))
      continue
    if (DASHES_RE.test(rawLine))
      continue
    if (!current)
      continue // defensive: data before any header

    const indent = rawLine.length - rawLine.trimStart().length
    const depth = Math.floor(indent / 2)
    const tokens = rawLine.trim().split(WHITESPACE_RE)
    const name = tokens[0]
    const values = tokens.slice(1)

    let pool = currentPool
    let vdev = currentVdev
    if (depth === 0) {
      currentPool = name
      currentVdev = undefined
      pool = name
      vdev = undefined
    }
    else if (depth === 1) {
      // A depth-1 row is either a vdev container (children follow) or a bare
      // striped leaf disk — neither belongs to a parent vdev, so its own vdev
      // is undefined. Deeper leaves (depth >= 2) inherit this as their vdev.
      currentVdev = name
      vdev = undefined
    }
    // depth >= 2 keeps the standing pool + vdev (a leaf disk in a vdev).

    current.push({
      name,
      depth,
      pool,
      vdev,
      ops: {
        read: numOrZero(values[COL.opsRead]),
        write: numOrZero(values[COL.opsWrite]),
      },
      bandwidth: {
        read: numOrZero(values[COL.bwRead]),
        write: numOrZero(values[COL.bwWrite]),
      },
      totalWait: {
        read: numOrNull(values[COL.twRead]),
        write: numOrNull(values[COL.twWrite]),
      },
    })
  }

  return samples
}

/** Map a parsed node's rate/latency columns onto the shared IoStats shape. */
export function nodeToIoStats(node: IostatNode): IoStats {
  return {
    readBytesPerSec: node.bandwidth.read,
    writeBytesPerSec: node.bandwidth.write,
    readIops: node.ops.read,
    writeIops: node.ops.write,
    readLatencyNs: node.totalWait.read,
    writeLatencyNs: node.totalWait.write,
  }
}

/** A `-` cell (idle) or a missing column reads as 0 for a rate/count. */
function numOrZero(cell: string | undefined): number {
  if (cell === undefined || cell === '-')
    return 0
  const n = Number(cell)
  return Number.isNaN(n) ? 0 : n
}

/** A `-` cell (idle) or a missing column reads as null for a latency. */
function numOrNull(cell: string | undefined): number | null {
  if (cell === undefined || cell === '-')
    return null
  const n = Number(cell)
  return Number.isNaN(n) ? null : n
}
