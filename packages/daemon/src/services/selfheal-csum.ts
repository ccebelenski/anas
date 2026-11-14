import type { CommandExecutor } from '../executor/types.js'
import type { SelfhealContext } from './selfheal-map.js'
import { csumItemKey, findLeaf, readTreeRoots, SelfhealTreeError } from './selfheal-btree.js'
import { BLOCK_BYTES, readDirect } from './selfheal-io.js'
import { chunkStripeOffsets, coveringChunk, SelfhealMapError } from './selfheal-map.js'

/**
 * The stored btrfs checksum for one on-disk sector, and the crc32c that
 * arbitrates against it (story selfheal.5).
 *
 * This is the OTHER half of the engine's claim: md knows the parity group,
 * btrfs knows what the bytes should be. Without a stored csum there is nothing
 * to arbitrate with and the only honest answer is `unrepairable` — which is
 * exactly what a NOCOW or prealloc extent gets.
 *
 * ## Why the csum tree and not the kernel's scrub line
 *
 * Kernel 7.0's scrub warning names the 64 KiB stripe, the path and the inode
 * but prints NEITHER the found nor the expected csum (GT-3 — the drill brief
 * expected `csum 0x… expected csum 0x…` and the kernel emits no such thing).
 * So the expected value is read out of the EXTENT_CSUM tree directly, exactly
 * as the drill did, through the LV.
 *
 * ## Layout facts this depends on (GT-4 + the selfheal.2 live probe)
 *
 *  - A csum is crc32c stored LITTLE-ENDIAN, 4 bytes, one entry per 4 KiB
 *    ON-DISK sector.
 *  - Compressed extents are no exception: entry *k* of an extent is
 *    `crc32c(sector k of the compressed blob)`, keyed contiguously from the
 *    extent's logical start — across csum-item boundaries. Lookup is therefore
 *    "the greatest EXTENT_CSUM item start ≤ the logical byte", never "the item
 *    whose printed range contains it".
 *  - Item payloads are addressed from the END of the 101-byte leaf header:
 *    `leaf + 101 + itemoff + index × 4`.
 *  - The leaf's own logical bytenr needs the chunk-tree hop like any other
 *    logical byte, and metadata chunks are `DUP` — so there are TWO copies of
 *    it and either may answer.
 *
 * ## The leaf is checked against itself before it is believed (D3)
 *
 * This is the one read in the whole engine that btrfs-progs does not make for
 * us. Every `dump-tree -b` the walk issues goes through btrfs-progs's own
 * `read_tree_block`, which verifies the block's checksum and fails the command
 * when it does not match — a non-zero exit `selfheal-btree.ts` already turns
 * into an error, so the walk cannot consume a rotten node. The RAW leaf read
 * below had no such protection: rot in the csum tree itself came back as a
 * plausible four-byte number, no reconstruction could ever match it, and a
 * perfectly healthy data block was reported "unrepairable — restore from
 * backup". The operator then overwrites good data with a backup.
 *
 * So the node proves itself first, exactly the way btrfs does it (verified
 * against a captured leaf, `split-csum-leaf.b64`): the crc32c of bytes
 * 32…nodesize equals the little-endian word in bytes 0…3, and the node's own
 * `bytenr` field at offset 48 equals the leaf the walk asked for. If the first
 * copy fails, the DUP chunk's second copy is read and checked the same way.
 * Only when BOTH fail is the answer "unreadable" — a distinct, honest verdict
 * ({@link CsumUnreadableError}, reason code `csum-unreadable`) that must never
 * be rendered as restore-from-backup.
 */

/** Bytes of a btrfs leaf header, past which item payloads are addressed (GT-4). */
export const LEAF_HEADER_BYTES = 101

/** btrfs metadata nodesize on every filesystem AHR creates. */
export const NODE_BYTES = 16384

/** Bytes per stored csum entry (crc32c). */
export const CSUM_BYTES = 4

/**
 * `struct btrfs_header`, the first 101 bytes of every tree node:
 * `csum[32] fsid[16] bytenr(le64) flags(le64) chunk_tree_uuid[16]
 * generation(le64) owner(le64) nritems(le32) level(u8)`. The two fields this
 * module checks are the csum (its low 4 bytes are the crc32c, little-endian)
 * and `bytenr` at offset 48.
 */
const NODE_CSUM_FIELD_BYTES = 32
const NODE_BYTENR_OFFSET = 48

/** What a node's self-check found. */
export interface NodeCheck {
  ok: boolean
  /** The reason it failed, or what it proved — an operator's sentence either way. */
  detail: string
}

/**
 * Does this node vouch for itself, and is it the node that was asked for?
 *
 * Two independent facts: the stored crc32c has to match the bytes AFTER the
 * csum field (btrfs computes it over `32 … nodesize`), and the node's own
 * `bytenr` has to be the leaf the walk descended to. The second catches the
 * case the first cannot — a whole VALID node from somewhere else landing at
 * this offset, which is what a stale or mis-hopped chunk delta produces.
 */
export function verifyNode(node: Buffer, bytenr: number): NodeCheck {
  if (node.length < NODE_BYTES)
    return { ok: false, detail: `only ${node.length} of ${NODE_BYTES} bytes were read` }
  const stored = node.readUInt32LE(0)
  const computed = crc32c(node.subarray(NODE_CSUM_FIELD_BYTES, NODE_BYTES))
  if (stored !== computed)
    return { ok: false, detail: `its stored node checksum ${csumHex(stored)} is not the crc32c of its own bytes (${csumHex(computed)})` }
  const own = Number(node.readBigUInt64LE(NODE_BYTENR_OFFSET))
  if (own !== bytenr)
    return { ok: false, detail: `the node at this offset says it is bytenr ${own}, not ${bytenr}` }
  return { ok: true, detail: `node ${bytenr} passes its own crc32c` }
}

/**
 * The csum tree leaf holding this block's checksum could not be read reliably.
 *
 * NOT the same thing as "this file is beyond repair": nothing is known about
 * the data block at all, because the thing that would arbitrate it is itself
 * damaged. The engine reports `unrepairable` with this reason and the
 * `csum-unreadable` code, and the notification and the UI must NOT tell the
 * operator to restore from backup for it — restoring would overwrite data that
 * may be perfectly good.
 */
export class CsumUnreadableError extends Error {
  readonly reasonCode = 'csum-unreadable' as const
  constructor(message: string) {
    super(message)
    this.name = 'CsumUnreadableError'
  }
}

/**
 * CRC-32C (Castagnoli) — reflected polynomial 0x82F63B78, init and final xor
 * 0xFFFFFFFF. Table-driven, built once; no dependency, because adding one for
 * 40 lines of table lookup is not a trade this project makes.
 */
const CRC32C_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++)
      c = (c & 1) !== 0 ? (c >>> 1) ^ 0x82F63B78 : c >>> 1
    table[i] = c
  }
  return table
})()

/** crc32c of a byte range, as an unsigned 32-bit number. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++)
    crc = CRC32C_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** `0x0b894db02`-style rendering used in outcomes and logs. */
export function csumHex(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`
}

/** Node-pointer line of a multi-leaf csum tree — the leaf a following item is in. */
const CSUM_NODE_RE = /key \(EXTENT_CSUM EXTENT_CSUM \d+\) block (\d+) gen/
/** Leaf header line. */
const LEAF_HEADER_RE = /^leaf (\d+) /
/** One EXTENT_CSUM item line. */
const CSUM_ITEM_RE = /item \d+ key \(EXTENT_CSUM EXTENT_CSUM (\d+)\) itemoff (\d+) itemsize (\d+)/

/** One EXTENT_CSUM item, with the leaf it was printed under. */
export interface CsumItem {
  /** Logical byte the item's first entry covers. */
  start: number
  /** Payload offset from the end of the leaf header. */
  itemOffset: number
  /** Payload size in bytes; `itemSize / 4` entries. */
  itemSize: number
  /** Logical bytenr of the leaf holding it. */
  leaf: number
}

/**
 * Parse `btrfs inspect-internal dump-tree -t 7`.
 *
 * Each item is paired with the leaf whose header PRECEDED it in the dump — a
 * multi-leaf csum tree (anything past a few GiB of data) must not map every
 * item onto the last leaf printed.
 */
export function parseCsumItems(dump: string): CsumItem[] {
  const items: CsumItem[] = []
  let leaf: number | null = null
  for (const raw of dump.split('\n')) {
    const line = raw.trim()
    const node = CSUM_NODE_RE.exec(line)
    if (node) {
      leaf = Number(node[1])
      continue
    }
    const header = LEAF_HEADER_RE.exec(line)
    if (header) {
      leaf = Number(header[1])
      continue
    }
    const item = CSUM_ITEM_RE.exec(line)
    if (item && leaf !== null) {
      items.push({
        start: Number(item[1]),
        itemOffset: Number(item[2]),
        itemSize: Number(item[3]),
        leaf,
      })
    }
  }
  return items
}

/** Where one logical byte's stored csum sits inside the tree. */
export interface CsumEntryLocation {
  item: CsumItem
  /** Entry index inside the item. */
  index: number
  /** Byte offset of the entry from the start of the leaf. */
  leafOffset: number
}

/**
 * Locate the stored csum entry for a logical byte, or null when there is none.
 *
 * Null is a real answer, not an error: a NOCOW file, a prealloc extent, or the
 * `nodatasum` flag all mean btrfs never wrote a csum, and the engine reports
 * `unrepairable` with that reason rather than arbitrating against nothing.
 */
export function findCsumEntry(items: CsumItem[], logical: number): CsumEntryLocation | null {
  let best: CsumItem | null = null
  for (const item of items) {
    if (item.start <= logical && (best === null || item.start > best.start))
      best = item
  }
  if (!best)
    return null
  const entries = Math.floor(best.itemSize / CSUM_BYTES)
  if (logical >= best.start + entries * BLOCK_BYTES)
    return null
  const index = Math.floor((logical - best.start) / BLOCK_BYTES)
  return { item: best, index, leafOffset: LEAF_HEADER_BYTES + best.itemOffset + index * CSUM_BYTES }
}

/** Extract the little-endian stored csum from a leaf's raw bytes. */
export function csumFromLeafBytes(leaf: Buffer, location: CsumEntryLocation): number {
  if (location.leafOffset + CSUM_BYTES > leaf.length)
    throw new SelfhealMapError(`csum entry at leaf offset ${location.leafOffset} is past the ${leaf.length}-byte leaf read`)
  return leaf.readUInt32LE(location.leafOffset)
}

/**
 * Add newly-read csum items to the run's cache, without duplicating.
 *
 * The cache is what makes a compressed blob's sectors — or several blocks of
 * one extent — cost ONE leaf between them: csum items do not overlap, so a
 * cached item whose range contains the logical byte IS the answer.
 */
function mergeCsums(ctx: SelfhealContext, items: CsumItem[]): void {
  for (const item of items) {
    if (!ctx.csums.some(c => c.start === item.start && c.leaf === item.leaf))
      ctx.csums.push(item)
  }
}

/**
 * The csum item covering a logical byte, fetching ONE csum-tree leaf when the
 * run's cache does not already hold it.
 *
 * The csum tree is the one that makes a whole-tree dump impossible on a real
 * pool — 8 TB of data carries 8 GB of checksums — so it is walked by key and
 * never dumped. Null is a real answer: a NOCOW file, a prealloc extent or
 * `nodatasum` means btrfs never wrote a csum, and the engine reports
 * `unrepairable` with that reason rather than arbitrating against nothing.
 */
export async function findStoredCsumEntry(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
): Promise<CsumEntryLocation | null> {
  const cached = findCsumEntry(ctx.csums, logical)
  if (cached)
    return cached
  const leaf = await findLeaf(executor, ctx.srcDevice, ctx.roots.csum, csumItemKey(logical))
  mergeCsums(ctx, parseCsumItems(leaf))
  return findCsumEntry(ctx.csums, logical)
}

/** The tree roots as they are NOW — a fresh lookup's starting point. */
async function readFreshRoots(executor: CommandExecutor, device: string): Promise<SelfhealContext['roots']> {
  try {
    return await readTreeRoots(executor, device)
  }
  catch (error) {
    if (error instanceof SelfhealTreeError)
      throw new CsumUnreadableError(`this file's checksum could not be read reliably: the tree roots could not be re-read (${error.message}). Nothing is known about the data block itself: do NOT restore from backup on the strength of this.`)
    throw error
  }
}

/**
 * The stored crc32c for one logical byte, read through the LV.
 *
 * Returns null when btrfs stored no csum for it. The csum VALUES are not in the
 * tree dump (btrfs-progs prints them only under `--csum-items`, which would
 * mean pulling every checksum of a 16 KiB leaf through the executor to use
 * four bytes of it), so the leaf is read off the LV directly — with O_DIRECT,
 * so a stale page of the block device cannot answer with a csum from before
 * the last commit. The leaf's own logical bytenr needs the chunk hop like any
 * other logical byte.
 *
 * Every copy the chunk holds is tried in turn and each one must pass
 * {@link verifyNode} before its four bytes are believed — metadata chunks are
 * `DUP`, so a leaf whose first copy has rotted is answered by the second.
 * Throws {@link CsumUnreadableError} when no copy vouches for itself: that is
 * a verdict about the CHECKSUM, not about the file (D3).
 */
export async function readStoredCsum(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
  options?: { fresh?: boolean },
): Promise<number | null> {
  // `fresh` (cr3 AHR-HEAL-H3): the run's caches were filled at its start, and
  // a mirror reconcile runs for DAYS. The csum tree is copy-on-write — every
  // commit moves its root and the leaves under it, and a leaf freed by one
  // commit still reads back intact (and passes `verifyNode`, which checks only
  // its crc and its bytenr) until something reuses its space. A row about to
  // be WRITTEN is arbitrated against the tree as it is NOW: the roots are read
  // again and the walk starts with no cached items.
  const lookup: SelfhealContext = options?.fresh
    ? { ...ctx, roots: await readFreshRoots(executor, ctx.srcDevice), csums: [] }
    : ctx
  let location: CsumEntryLocation | null
  try {
    location = await findStoredCsumEntry(executor, lookup, logical)
  }
  catch (error) {
    // cr3 AHR-HEAL-H1 (B) / D3 — the CSUM TREE could not be walked to this
    // byte's leaf. btrfs-progs verifies every block `dump-tree -b` reads and
    // fails the command when a node does not pass (both DUP copies bad is
    // D3's own case). That is a verdict about the checksum, never about the
    // data block: it carries the code that keeps the words "restore from
    // backup" away from it.
    if (error instanceof SelfhealTreeError)
      throw new CsumUnreadableError(`this file's checksum could not be read reliably: the checksum tree could not be walked to logical byte ${logical} (${error.message}). Nothing is known about the data block itself: do NOT restore from backup on the strength of this.`)
    throw error
  }
  if (!location)
    return null
  const chunk = await coveringChunk(executor, ctx, location.item.leaf)
  const copies = chunkStripeOffsets(chunk)
  const failures: string[] = []

  for (const [copy, deviceOffset] of copies.entries()) {
    const leafLv = location.item.leaf - chunk.logical + deviceOffset
    const aligned = leafLv - (leafLv % BLOCK_BYTES)
    const skew = leafLv - aligned
    let bytes: Buffer
    try {
      bytes = await readDirect(executor, ctx.srcDevice, aligned, NODE_BYTES + BLOCK_BYTES)
    }
    catch (error) {
      failures.push(`copy ${copy}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const check = verifyNode(bytes.subarray(skew, skew + NODE_BYTES), location.item.leaf)
    if (check.ok)
      return csumFromLeafBytes(bytes.subarray(skew), location)
    failures.push(`copy ${copy}: ${check.detail}`)
  }

  throw new CsumUnreadableError(
    `this file's checksum could not be read reliably (csum tree leaf ${location.item.leaf} failed its own checksum on `
    + `${copies.length > 1 ? 'both copies' : 'its only copy'} — ${failures.join('; ')}). `
    + `Nothing is known about the data block itself: do NOT restore from backup on the strength of this.`,
  )
}
