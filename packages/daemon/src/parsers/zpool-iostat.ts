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
 * The five pool-level vdev-class sections `zpool iostat -plv` prints as an
 * unindented row — the same five `zpool status -j` reports beside the data
 * tree. A row must be called one of these AND carry no statistics to be read
 * as a section header.
 */
const SECTION_NAMES: ReadonlySet<string> = new Set(['logs', 'cache', 'special', 'dedup', 'spares'])

/**
 * Parse the full multi-sample output into an array of samples, each an array of
 * nodes. The telemetry route uses the LAST sample (the per-second interval).
 *
 * An unindented row is a pool row or a vdev-class section header. A row is a
 * section header only when BOTH hold: every value cell is `-`, AND its name is
 * one of the five section names ZFS prints (`logs`, `cache`, `special`,
 * `dedup`, `spares`). GROUND TRUTH (stunt node, ZFS 2.4.4, 2026-09-24, fixture
 * `zpool-iostat-plv-all-vdev-classes-2.4.4.txt`): `zpool iostat -plv` prints
 * `logs`, `cache`, `special` and `dedup` UNINDENTED, in the pool column, with
 * every value cell `-`; their devices follow at the vdev indent. Read
 * positionally those headers become four phantom pools and the real pool loses
 * the vdevs beneath them (vdevs.1 consumer audit).
 *
 * Both halves are needed, and neither alone: a pool may legitimately be NAMED
 * `logs` — it keeps its numbers, so the shape tells it from the header — while
 * an all-`-` row under any OTHER name is a pool, not a header. That second
 * half is the SUSPENDED-pool guard: no capture shows what `zpool iostat` prints
 * for a suspended pool, so whether it can print a pool row as all `-` is
 * UNVERIFIED; if it can, that pool stays a pool here instead of being swallowed
 * as a header (vdevs.2 hardening).
 *
 * `knownPools` — the pools the command was ASKED about — extends the name
 * check: an all-`-` row named like NONE of them is read as a section header
 * too, for a header shape this ground truth has not seen. The SHAPE half still
 * applies to it — a pool that is not in the list (imported between the
 * `zpool list` and the `zpool iostat -plv` call) keeps its capacity numbers,
 * so it is a pool of its own, never folded into the pool printed before it.
 */
export function parseZpoolIostat(text: string, knownPools?: ReadonlySet<string>): IostatNode[][] {
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
      // An unindented row can be a POOL or a vdev-class section header (logs /
      // cache / special / dedup / spares). A header is both SHAPED and NAMED
      // like one: it carries no statistics at all, so every value cell prints
      // `-`, and it is called by one of the five section names. Shape is needed
      // because a pool may legitimately be NAMED `logs` or `special` — it keeps
      // its capacity numbers and stays a pool. The name is needed because an
      // all-`-` row called anything else is a pool, not a header: no capture
      // shows what a SUSPENDED pool prints, so if it prints all `-` it survives
      // here rather than being swallowed. When `knownPools` is given, a row
      // named like NONE of them joins the name check — but only when it is
      // ALSO shaped like a header: a pool imported after the `zpool list` the
      // names came from is not in the set, yet it carries its numbers and is a
      // pool of its own, never a header of the pool printed before it. Either
      // way the standing pool continues and the devices under the header are
      // that pool's vdevs.
      const noStats = values.length > 0 && values.every(v => v === '-')
      const sectionHeader = noStats
        && (SECTION_NAMES.has(name) || (knownPools !== undefined && !knownPools.has(name)))
      if (currentPool && sectionHeader) {
        currentVdev = undefined
        continue
      }
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
