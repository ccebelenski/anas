import type { SelfhealNotExaminedReason } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { TreeRoots } from './selfheal-btree.js'
import type { CsumItem } from './selfheal-csum.js'
import { mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { chunkItemKey, extentDataKey, extentItemKey, findLeaf, findLeafPath, nextLeaf, readTreeRoots } from './selfheal-btree.js'
import { BLOCK_BYTES, kernelName, mdSysPath, readMdAttrOrNull } from './selfheal-io.js'

/**
 * THE mapping helper for the self-heal repair engine (story selfheal.5).
 *
 * One file block → the exact bytes on one member disk, and back. Both halves
 * of the repair derive from this module and nothing else: the READ side
 * (re-verify the corruption, reconstruct a candidate from the siblings) and
 * the WRITE side (where the corrected block goes through md). The read-back
 * guard in `selfheal-repair.ts` is the PROOF of that — it compares the md
 * block at the mapping's `mdByte` with the member bytes at the mapping's
 * `memberOffset`, which can only agree if one resolution produced both.
 *
 * ## The chain (GT-2, with its correction)
 *
 *   file + 4 KiB block
 *     → btrfs LOGICAL bytenr            EXTENT_DATA in the subvolume tree
 *     → LV byte                         chunk-tree hop, per-chunk delta
 *     → md byte                         dm linear segment — WHICH segment also
 *                                       says which md ARRAY the byte is on
 *     → (member, member offset)         that array's layout, read live from sysfs
 *
 * ## One geometry per BAND, never one per pool
 *
 * An AHR pool's LV is a LINEAR CONCATENATION of one md array per band
 * (AHR-DESIGN §2.6) — different member counts, different levels, different
 * chunk sizes, in band order. So the dm segment covering the LV byte is what
 * names the array, and every later step (placement, the member device, the
 * sysfs knobs a repair turns) comes from THAT segment's array. A geometry taken
 * from the first segment would place a band-3 block with band-1's arithmetic
 * and then read — and write — it on band 1's disks.
 *
 * `filefrag`'s "physical_offset" is the btrfs LOGICAL bytenr, not a device
 * offset (GT-2), and it LIES outright on compressed extents (`physical_hi` is
 * bogus — suite note), so the authority is
 * `btrfs inspect-internal dump-tree`. It is run against the LV and NEVER
 * against the md device: the filesystem starts at the dm linear segment's
 * offset into md, so every tree offset read through md is shifted by it.
 *
 * There can be SEVERAL data chunks with different device deltas — on the drill
 * rig an 8 MiB first chunk had delta 0 and the 112 MiB second one delta
 * 60,358,656 — so the hop must select the chunk COVERING the logical byte, not
 * the first one.
 *
 * ## Layouts
 *
 * Nothing here is hardcoded. Chunk size, layout, disk count and every member's
 * own data offset are read live from md sysfs on each call; the member roles
 * come from `mdadm --detail --export` (KEY=VALUE — structured output, §13).
 * Only `left-symmetric` (sysfs `layout=2`, the mdadm default and what AHR
 * creates) is supported for RAID5/6; anything else is REFUSED by name rather
 * than mapped with a formula that does not describe it. RAID1 has no layout
 * and no stripe — every leg carries the same bytes at the same offset.
 *
 * ## Text parsing
 *
 * `dump-tree` and `dmsetup table` have no structured form (no `--json`, no
 * `-Hp`), so they are parsed as text — the same sanctioned exception as
 * `btrfs scrub status` and the kernel scrub lines in `ahr-scrub.ts`. Everything
 * else in this module is sysfs (one value per file) or KEY=VALUE.
 */

const BTRFS = '/usr/bin/btrfs'
const MDADM = '/usr/sbin/mdadm'
const DMSETUP = '/usr/sbin/dmsetup'
const FINDMNT = '/usr/bin/findmnt'
const STAT = '/usr/bin/stat'

// --- Regexes for the two text formats with no structured alternative -------
/** A dm table line's leading `<start> <len>` (the name-prefixed form has none). */
const DM_LEADING_NUMBER_RE = /^\s*\d/
/** Run of whitespace — the field separator of every text format parsed here. */
const WHITESPACE_RE = /\s+/
/** `<major>:<minor>` in a dm target. */
const DM_MAJOR_MINOR_RE = /^(\d+):(\d+)$/
/** A bare non-negative integer. */
const INTEGER_RE = /^\d+$/
/** `item N key (FIRST_CHUNK_TREE CHUNK_ITEM <logical>)`. */
const CHUNK_KEY_RE = /item \d+ key \(FIRST_CHUNK_TREE CHUNK_ITEM (\d+)\)/
/** Any `item N key (…)` — what closes another item's body. */
const ANY_ITEM_KEY_RE = /item \d+ key \(/
/** `length <n> owner <n> stripe_len <n> type <type>`. */
const CHUNK_GEOMETRY_RE = /length (\d+) owner \d+ stripe_len \d+ type (\S+)/
/**
 * `stripe <n> devid <n> offset <n>` — ONE copy of a chunk.
 *
 * Both are captured, not just stripe 0: a `METADATA|DUP` chunk holds the csum
 * tree TWICE, and the second copy is what a leaf whose first copy has rotted is
 * re-read from (design review 2026-09-14, D3).
 */
const CHUNK_STRIPE_RE = /stripe (\d+) devid \d+ offset (\d+)/
/** A chunk `type` naming DATA. */
const CHUNK_TYPE_DATA_RE = /\bDATA\b/
/** `item N key (<inode> EXTENT_DATA <file offset>)`. */
const EXTENT_KEY_RE = /item \d+ key \((\d+) EXTENT_DATA (\d+)\)/
/** `generation <n> type <n> (regular|prealloc|inline)`. */
const EXTENT_KIND_RE = /generation \d+ type \d+ \((\w+)\)/
/** `extent data disk byte <logical> nr <on-disk length>`. */
const EXTENT_DISK_RE = /extent data disk byte (\d+) nr (\d+)/
/**
 * `extent data offset <n> nr <length> ram <uncompressed length>`.
 *
 * The FIRST field is load-bearing and was dropped by an earlier cut: it is how
 * far into the on-disk extent this item's bytes start. A btrfs CoW split leaves
 * the tail of the original extent described by an item with a non-zero one
 * (captured live: a 4 KiB overwrite 1 MiB into an 8 MiB file leaves
 * `offset 1052672 nr 7335936 ram 8388608`), and a mapping that ignores it lands
 * a whole megabyte short of the block it was asked for.
 */
const EXTENT_SPAN_RE = /extent data offset (\d+) nr (\d+) ram (\d+)/
/** `extent compression <n> (<name>)`. */
const EXTENT_COMPRESSION_RE = /extent compression \d+ \((\w+)\)/
/** `inline extent data size <n> ram_bytes <n> compression <n> (<name>)` — no on-disk extent. */
const EXTENT_INLINE_RE = /inline extent data size \d+ ram_bytes (\d+) compression \d+ \((\w+)\)/
/** `Subvolume ID: <n>` from `btrfs subvolume show`. */
const SUBVOLUME_ID_RE = /Subvolume ID:\s*(\d+)/

/**
 * Raised when the chain cannot be followed. The message IS the operator's
 * reason; `reasonCode` is what a parser keys on.
 *
 * The code exists because every one of these used to become the SAME verdict —
 * `mapping-abort`, whose sentence asserts that the bytes at the mapped location
 * still pass their stored checksum (seventh pass, F3). That is true of exactly
 * one case, and it is not raised here at all: the re-verify establishes it by
 * READING the block. Everything thrown from this module is a block nobody
 * looked at, so it carries the reason it could not be looked at and lands in
 * the `not-examined` bucket. `unresolvable` is the honest default.
 */
export class SelfhealMapError extends Error {
  constructor(
    message: string,
    readonly reasonCode: SelfhealNotExaminedReason = 'unresolvable',
  ) {
    super(message)
    this.name = 'SelfhealMapError'
  }
}

/** One recorded range of a member's md bad-block list, in 512-byte sectors. */
export interface BadBlockRange {
  /** First sector of the range, as the member's own `bad_blocks` file prints it. */
  startSector: number
  lengthSectors: number
}

/**
 * Parse one member's `bad_blocks` file (seventh pass, F8).
 *
 * The kernel prints ONE RANGE PER LINE as `<start> <length>` in 512-byte
 * sectors, with an optional trailing `-` on a range that is not yet
 * acknowledged. An empty file is the common case and means the member has no
 * recorded unreadable ranges; an UNREADABLE file (the attribute is absent on a
 * kernel without bad-block support, or the read failed) is `null` here and is
 * NOT the same as empty — the caller is told it does not know, and a band ANAS
 * cannot ask about is not a band it claims is clean.
 */
export function parseBadBlocks(text: string | null): BadBlockRange[] | null {
  if (text === null)
    return null
  const out: BadBlockRange[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(WHITESPACE_RE)
    if (parts.length < 2 || !INTEGER_RE.test(parts[0]) || !INTEGER_RE.test(parts[1]))
      continue
    out.push({ startSector: Number(parts[0]), lengthSectors: Number(parts[1]) })
  }
  return out
}

/**
 * Which coordinates a member's `rd<n>/bad_blocks` prints its ranges in.
 *
 *  - `data-relative` — sector 0 is the first sector of the member's DATA AREA,
 *    so the member's `rd<n>/offset` comes off before the comparison. This is
 *    what the engine has assumed since F8.
 *  - `absolute` — sector 0 is the first sector of the member DEVICE (the
 *    2026-11-14 review's reading of md: `rdev_set_badblocks` adds
 *    `rdev->data_offset` before recording, `is_badblock` adds it before
 *    looking, and `bad_blocks` prints the stored value raw).
 *
 * NEITHER is ground truth yet (cr3 AHR-HEAL-M5): no capture backs the
 * decision tree's leaf H5. The constant stays at the value the engine has
 * always used until the capture named in `selfheal-map.test.ts`
 * ("md bad-block coordinates — the capture decides") is taken; that test turns
 * RED against the wrong value, and the fix is this one line.
 */
export type BadBlockCoordinates = 'data-relative' | 'absolute'

/** @see BadBlockCoordinates — UNSETTLED, pending the capture (cr3 AHR-HEAL-M5). */
export const MD_BAD_BLOCKS_COORDINATES: BadBlockCoordinates = 'data-relative'

/**
 * Does the member in `role` carry a recorded bad-block range over the byte span
 * `[offset, offset + length)` of its own device?
 *
 * `null` when the member's list could not be read (cr3 AHR-HEAL-L9). An
 * unreadable list used to answer FALSE — "clean" — on the reasoning that a
 * kernel without the file would otherwise refuse every repair. Every kernel
 * AHR runs on publishes `rd<n>/bad_blocks` for every member it holds, so an
 * unreadable one is a read that failed, and a read that failed never reads as
 * clean: each caller turns the null into a refusal that says it did not know.
 *
 * The coordinates are {@link MD_BAD_BLOCKS_COORDINATES}'s; the parameter exists
 * so the test that the capture settles can hold both readings side by side.
 */
export function memberHasBadBlock(
  geo: MdGeometry,
  role: number,
  memberOffset: number,
  lengthBytes: number = BLOCK_BYTES,
  coordinates: BadBlockCoordinates = MD_BAD_BLOCKS_COORDINATES,
): boolean | null {
  const ranges = geo.badBlocks[role]
  if (ranges === null || ranges === undefined)
    return null
  if (ranges.length === 0)
    return false
  const base = coordinates === 'absolute' ? 0 : geo.dataOffsets[role]
  if (!Number.isFinite(base))
    return null
  const first = Math.floor((memberOffset - base) / 512)
  const last = Math.floor((memberOffset - base + lengthBytes - 1) / 512)
  return ranges.some(r => first <= r.startSector + r.lengthSectors - 1 && last >= r.startSector)
}

/**
 * The PRESENT members whose bad-block list could not be read (cr3
 * AHR-HEAL-L9) — the band-wide twin of {@link memberHasBadBlock}'s null.
 *
 * The parity rewrite and the mirror reconcile refuse a band with recorded bad
 * blocks; a band whose lists they could not read is not a band they know to be
 * free of them, so it is refused too, with its own sentence. An ABSENT role
 * (a failed or removed member) has nothing to read and is not counted here —
 * the degraded gates answer for it.
 */
export function bandBadBlocksUnknown(geo: MdGeometry): { role: number, device: string }[] {
  const out: { role: number, device: string }[] = []
  for (let role = 0; role < geo.raidDisks; role++) {
    const device = geo.members[role]
    if (device === null || device === undefined)
      continue
    if (geo.badBlocks[role] === null || geo.badBlocks[role] === undefined)
      out.push({ role, device })
  }
  return out
}

/** The sentence a band with unreadable bad-block lists is refused with (cr3 AHR-HEAL-L9). */
export function badBlocksUnknownRefusal(geo: MdGeometry): string {
  const named = bandBadBlocksUnknown(geo).map(c => c.device).join(', ')
  return `${geo.device}: the md bad-block list of ${named} could not be read, so nothing says md can read every row of that member. A band ANAS cannot ask about is not one it treats as clean. Read /sys/block/${geo.kernel}/md/rd<n>/bad_blocks and try again`
}

/** Every role whose bad-block list is non-empty, with the ranges it holds. */
export function bandBadBlocks(geo: MdGeometry): { role: number, device: string, ranges: BadBlockRange[] }[] {
  const out: { role: number, device: string, ranges: BadBlockRange[] }[] = []
  for (let role = 0; role < geo.raidDisks; role++) {
    const ranges = geo.badBlocks[role]
    if (ranges && ranges.length > 0)
      out.push({ role, device: geo.members[role] ?? `role ${role}`, ranges })
  }
  return out
}

/** sysfs `layout` → md's name for it. RAID5/6 only; RAID1 reports 0 and means nothing by it. */
export const MD_LAYOUT_NAMES: Record<number, string> = {
  0: 'left-asymmetric',
  1: 'right-asymmetric',
  2: 'left-symmetric',
  3: 'right-symmetric',
}

/** The one parity layout this engine maps. Anything else is refused by name. */
export const SUPPORTED_PARITY_LAYOUT = 'left-symmetric'

/** Live md geometry — every field read at the moment of use, never cached across runs. */
export interface MdGeometry {
  /** `/dev/md127`, as resolved from the dm table. */
  device: string
  /** `md127` — the sysfs key. */
  kernel: string
  /** `/sys/block/md127/md`. */
  sys: string
  /** sysfs `level`: `raid1`, `raid5`, `raid6`. */
  level: string
  raid6: boolean
  raid1: boolean
  /** sysfs `raid_disks`. */
  raidDisks: number
  /** sysfs `chunk_size` in bytes; 0 on RAID1. */
  chunkBytes: number
  /** Decoded sysfs `layout`; null on RAID1. */
  layout: string | null
  /** Role index → member device path. A missing role (degraded) is null. */
  members: (string | null)[]
  /** Role index → that member's own data offset in bytes (`rd<n>/offset` × 512). */
  dataOffsets: number[]
  /**
   * Role index → the member's recorded md bad-block ranges (seventh pass, F8),
   * or null where the list could not be read.
   *
   * A range here is a span md returned a URE on during a rebuild and could not
   * reconstruct: md serves EIO for it and reconstructs nothing from it. The
   * repair engine treats such a member as ABSENT over the row it covers, and
   * Rewrite parity refuses the band outright — a whole-band `mdadm
   * --action=repair` would recompute parity from rows md cannot read.
   */
  badBlocks: (BadBlockRange[] | null)[]
}

/** One `linear` segment of a dm table. */
export interface DmSegment {
  /** First sector of the segment within the mapped device. */
  startSector: number
  lengthSectors: number
  /** The underlying device, as `major:minor` (dm's own notation). */
  major: number
  minor: number
  /** Offset of the segment's first sector within that underlying device. */
  offsetSector: number
}

/** One CHUNK_ITEM of the chunk tree. */
export interface ChunkItem {
  logical: number
  length: number
  /** First stripe's device offset — the delta GT-2 corrected for. */
  deviceOffset: number
  /**
   * EVERY copy's device offset, by stripe index — one entry for a `single`
   * chunk, two for a `DUP` one. `deviceOffset` is `stripes[0]`; the rest exist
   * so a metadata node that fails its own checksum in the first copy can be
   * re-read from the second (D3) instead of being reported as unreadable rot.
   */
  stripes: number[]
  /** `DATA|single`, `METADATA|DUP`, … verbatim. */
  type: string
}

/** Every copy of a chunk, in stripe order — one on `single`, two on `DUP`. */
export function chunkStripeOffsets(chunk: ChunkItem): number[] {
  return chunk.stripes.length > 0 ? chunk.stripes : [chunk.deviceOffset]
}

/**
 * One EXTENT_DATA item of a subvolume tree.
 *
 * Everything past `fileOffset` is optional because an INLINE extent has none
 * of it — its bytes are in the metadata item itself. Treating those fields as
 * present would turn "this file's tail lives in the tree" into a confident
 * mapping onto logical byte 0.
 */
export interface ExtentItem {
  /** Offset of the extent within the file (the item's own key). */
  fileOffset: number
  /** btrfs logical bytenr of the on-disk data; 0 means a hole. */
  diskByte?: number
  /** On-disk length (the compressed blob's length when compressed). */
  diskLength?: number
  /**
   * How far INTO the on-disk extent this item's bytes start (`extent data
   * offset`). Zero on a freshly written extent; non-zero on the pieces a CoW
   * split leaves behind, and then `fileOffset` alone does not locate the bytes.
   */
  extentDataOffset: number
  /** Length within the file this item covers (`nr` on the span line). */
  length?: number
  /** Uncompressed length of the extent. */
  ram?: number
  /** `none`, `zlib`, `lzo`, `zstd`. */
  compression: string
  /** `regular`, `prealloc`, `inline`. */
  type: string
}

/** Where one on-disk sector of a repair unit physically is. */
export interface MemberLocation {
  /** btrfs logical bytenr of this on-disk sector. */
  logical: number
  /** Byte offset within the btrfs device (the LV). */
  lvByte: number
  /**
   * The BAND this byte is on: the md array the covering dm segment maps onto,
   * with the geometry read from that array. Every read, every write and every
   * sysfs knob for this byte goes through it — carrying it here is what makes
   * a band mix-up impossible on a multi-band pool.
   */
  geometry: MdGeometry
  /** Byte offset within that md array. */
  mdByte: number
  /** Role index of the member carrying it (RAID1: the first leg — see `mirrors`). */
  memberIndex: number
  memberDevice: string
  /** Byte offset within that member device. */
  memberOffset: number
  /** Stripe index within the array; null on RAID1. */
  stripe: number | null
  /** Role index of this stripe's P member; null on RAID1. */
  parityIndex: number | null
  /** Role index of this stripe's Q member; null unless RAID6. */
  qIndex: number | null
  /**
   * This member's index among the stripe's DATA disks, in md's stripe order —
   * the exponent of the RAID6 Q coefficient (`g^dataIndex`). Null on RAID1.
   */
  dataIndex: number | null
  /** Every role holding a copy of these bytes: the RAID1 legs, or just one. */
  mirrors: number[]
  /** The dm segment's offset into md, in sectors — kept for the audit trail. */
  startSector: number
  /** The covering chunk's logical start and device offset (the GT-2 hop). */
  chunkLogical: number
  chunkDevice: number
}

/**
 * Everything about one pool that does not change between blocks of one run.
 *
 * `chunks` and `csums` are CACHES, not dumps: each starts empty and gains the
 * items of whichever leaf a bounded walk had to read. Two lookups in the same
 * chunk cost one walk; a lookup whose covering item is already cached costs
 * none. Nothing outside a leaf the run actually needed is ever read.
 */
export interface SelfhealContext {
  mountpoint: string
  /** The btrfs device — the LV. Every tree read runs against THIS, never md. */
  srcDevice: string
  /**
   * The pool's bands, in dm-table order: one linear segment and the md array it
   * maps onto, each with its OWN geometry. A btrfs straight on md gets one
   * synthetic identity segment, which keeps one code path.
   */
  bands: SelfhealBand[]
  /** Where each btrfs tree's root block is (`dump-tree -r`, one bounded exec). */
  roots: TreeRoots
  /** CHUNK_ITEMs learned so far, leaf at a time. */
  chunks: ChunkItem[]
  /** EXTENT_CSUM items learned so far, leaf at a time (filled by selfheal-csum). */
  csums: CsumItem[]
}

/** The repair unit for one file block: its on-disk sectors, each fully located. */
export interface ResolvedBlock {
  file: string
  block: number
  extent: ExtentItem
  compressed: boolean
  /** btrfs logical bytenr of the repair unit's first on-disk sector. */
  blobLogical: number
  /** On-disk sectors in the repair unit. */
  blobSectors: number
  /** btrfs logical bytenr of the block's own content (inside the blob when compressed). */
  logicalByte: number
  /** One entry per on-disk sector of the repair unit, in order. */
  sectors: MemberLocation[]
}

// ---------------------------------------------------------------------------
//  Pure parsers — every one of them unit-tested against captured rig output
// ---------------------------------------------------------------------------

/**
 * Parse `dmsetup table <device>`: `<start> <len> <target> <major:minor> <offset>`.
 *
 * ONLY `linear` targets are accepted. An LVM LV spanning several AHR bands is
 * a concatenation of linear segments, which this handles; anything else
 * (`striped`, `mirror`, `raid`, a snapshot origin, or the `mirror` target an
 * in-flight `pvmove` inserts) means the bytes do not sit where this chain
 * would put them, and the caller must refuse rather than guess.
 */
export function parseDmTable(text: string): DmSegment[] {
  const segments: DmSegment[] = []
  for (const raw of text.split('\n')) {
    // `dmsetup table` with no device argument prefixes each line with `name: `.
    const line = raw.includes(':') && !DM_LEADING_NUMBER_RE.test(raw) ? raw.slice(raw.indexOf(':') + 1) : raw
    const parts = line.trim().split(WHITESPACE_RE)
    if (parts.length < 3 || !INTEGER_RE.test(parts[0]))
      continue
    if (parts[2] !== 'linear')
      throw new SelfhealMapError(`dm target '${parts[2]}' is not linear — this pool's bytes are not where a linear map would put them (pvmove in flight, or a striped/mirrored LV)`)
    const m = DM_MAJOR_MINOR_RE.exec(parts[3] ?? '')
    if (!m || !INTEGER_RE.test(parts[4] ?? ''))
      throw new SelfhealMapError(`unparseable linear dm target: ${line.trim()}`)
    segments.push({
      startSector: Number(parts[0]),
      lengthSectors: Number(parts[1]),
      major: Number(m[1]),
      minor: Number(m[2]),
      offsetSector: Number(parts[4]),
    })
  }
  if (segments.length === 0)
    throw new SelfhealMapError('dmsetup table produced no linear segment')
  return segments
}

/** The linear segment covering an LV byte. */
export function segmentForLvByte(segments: DmSegment[], lvByte: number): DmSegment {
  const sector = Math.floor(lvByte / 512)
  const seg = segments.find(s => sector >= s.startSector && sector < s.startSector + s.lengthSectors)
  if (!seg)
    throw new SelfhealMapError(`no dm linear segment covers LV byte ${lvByte}`)
  return seg
}

/**
 * One BAND of the pool: a linear dm segment and the md array underneath it.
 *
 * The LV of an AHR pool is the concatenation of one md array per band in band
 * order (AHR-DESIGN §2.6), and the bands differ — member count, level, chunk
 * size, per-member data offsets. Pairing the segment with its own geometry in
 * ONE value is what keeps a block's placement, its member reads and the sysfs
 * knobs a repair turns all pointed at the same array.
 */
export interface SelfhealBand {
  segment: DmSegment
  /** The device the segment maps onto — named even when its geometry is unreadable. */
  device: string
  /**
   * This band's md geometry, or null when it could not be read.
   *
   * Null is deliberate and LOCAL: a band that is momentarily unreadable (or is
   * not an md array at all) must fail the blocks that live on IT, not the whole
   * context. The attribution pass never places a byte at all — it walks the
   * btrfs trees — so a pool with one unreadable band still names its corrupt
   * files everywhere else (second-pass review F6).
   */
  geometry: MdGeometry | null
  /** Why the geometry is unavailable — the operator's reason, verbatim. */
  error: string | null
}

/** A band whose geometry IS in hand — the one shape every caller builds. */
export function selfhealBand(segment: DmSegment, geometry: MdGeometry): SelfhealBand {
  return { segment, device: geometry.device, geometry, error: null }
}

/** The band covering an LV byte — the segment, and the array it maps onto. */
export function bandForLvByte(bands: SelfhealBand[], lvByte: number): SelfhealBand {
  const segment = segmentForLvByte(bands.map(b => b.segment), lvByte)
  const band = bands.find(b => b.segment === segment)
  if (!band)
    throw new SelfhealMapError(`no md array is resolved for the dm segment covering LV byte ${lvByte}`, 'band-unreadable')
  return band
}

/**
 * Parse the CHUNK_ITEMs of `btrfs inspect-internal dump-tree -t 3`.
 *
 * EVERY stripe is read, not just the first. `stripe 0` remains the copy the
 * chain follows for data, but a `METADATA|DUP` chunk carries the tree twice and
 * the second copy is the fallback a csum leaf that fails its own crc32c is
 * re-read from (D3). An item is emitted when the next item key closes it —
 * emitting on `stripe 0` would throw the second copy away before it was seen.
 */
export function parseChunkItems(dump: string): ChunkItem[] {
  const items: ChunkItem[] = []
  let current: (Partial<ChunkItem> & { stripes: number[] }) | null = null

  function flush(): void {
    if (current && current.logical !== undefined && current.length !== undefined && current.stripes[0] !== undefined) {
      items.push({
        logical: current.logical,
        length: current.length,
        deviceOffset: current.stripes[0],
        stripes: current.stripes.filter(offset => offset !== undefined),
        type: current.type ?? '',
      })
    }
    current = null
  }

  for (const line of dump.split('\n')) {
    const key = CHUNK_KEY_RE.exec(line)
    if (key) {
      flush()
      current = { logical: Number(key[1]), stripes: [] }
      continue
    }
    if (ANY_ITEM_KEY_RE.test(line)) {
      flush()
      continue
    }
    if (!current)
      continue
    const geom = CHUNK_GEOMETRY_RE.exec(line)
    if (geom) {
      current.length = Number(geom[1])
      current.type = geom[2]
      continue
    }
    const stripe = CHUNK_STRIPE_RE.exec(line)
    if (stripe)
      current.stripes[Number(stripe[1])] = Number(stripe[2])
  }
  flush()
  return items
}

/** The chunk covering a logical byte. `dataOnly` restricts it to DATA chunks. */
export function chunkForLogical(chunks: ChunkItem[], logical: number, dataOnly = false): ChunkItem {
  const hit = chunks.find(c =>
    logical >= c.logical && logical < c.logical + c.length
    && (!dataOnly || CHUNK_TYPE_DATA_RE.test(c.type)),
  )
  if (!hit)
    throw new SelfhealMapError(`no ${dataOnly ? 'DATA ' : ''}chunk covers logical byte ${logical}`)
  return hit
}

/** logical byte → LV byte, through the covering chunk's own delta (GT-2). */
export function logicalToLvByte(chunks: ChunkItem[], logical: number, dataOnly = false): { lvByte: number, chunk: ChunkItem } {
  const chunk = chunkForLogical(chunks, logical, dataOnly)
  return { lvByte: logical - chunk.logical + chunk.deviceOffset, chunk }
}

/**
 * Parse the EXTENT_DATA items of ONE inode out of a subvolume tree dump.
 *
 * Body lines attach only within their own item: with several files in the tree
 * the next `item N key (…)` belongs to another inode and must close the body,
 * or one file inherits the next one's extents.
 */
export function parseExtentItems(dump: string, inode: number): ExtentItem[] {
  const items: ExtentItem[] = []
  let current: Partial<ExtentItem> | null = null
  let inBody = false
  for (const line of dump.split('\n')) {
    const key = EXTENT_KEY_RE.exec(line)
    if (key) {
      inBody = true
      current = null
      if (Number(key[1]) === inode) {
        current = { fileOffset: Number(key[2]), extentDataOffset: 0, compression: 'none', type: 'regular' }
        items.push(current as ExtentItem)
      }
      continue
    }
    if (ANY_ITEM_KEY_RE.test(line)) {
      inBody = false
      current = null
      continue
    }
    if (!inBody || !current)
      continue
    const kind = EXTENT_KIND_RE.exec(line)
    if (kind) {
      current.type = kind[1]
      continue
    }
    const disk = EXTENT_DISK_RE.exec(line)
    if (disk) {
      current.diskByte = Number(disk[1])
      current.diskLength = Number(disk[2])
      continue
    }
    const span = EXTENT_SPAN_RE.exec(line)
    if (span) {
      current.extentDataOffset = Number(span[1])
      current.length = Number(span[2])
      current.ram = Number(span[3])
      continue
    }
    const comp = EXTENT_COMPRESSION_RE.exec(line)
    if (comp) {
      current.compression = comp[1]
      continue
    }
    // An INLINE extent has no `disk byte` and no `offset/nr/ram` line at all —
    // its bytes are in the metadata item. Give it a length anyway so the
    // covering-extent lookup FINDS it and `resolveBlock` can refuse it by name,
    // instead of the file looking like it has a hole where its tail is.
    const inline = EXTENT_INLINE_RE.exec(line)
    if (inline) {
      current.length = Number(inline[1])
      current.ram = Number(inline[1])
      current.compression = inline[2]
    }
  }
  return items
}

/** The extent covering a byte offset within the file. */
export function extentForFileOffset(items: ExtentItem[], fileOffset: number): ExtentItem {
  const hit = items.find(e => fileOffset >= e.fileOffset && fileOffset < e.fileOffset + (e.length ?? 0))
  if (!hit)
    throw new SelfhealMapError(`file offset ${fileOffset} is in no extent of this file`)
  return hit
}

/**
 * btrfs scrub checks and reports in 64 KiB stripes (GT-3) — the kernel names
 * one of these in every scrub warning, for compressed extents and plain ones
 * alike. Verified live on kernel 7.0.14-12-pve: two corrupt blobs 16 KiB apart
 * inside one stripe were both reported at the stripe's start.
 */
export const BTRFS_STRIPE_BYTES = 65536

/** One `extent data backref` line of an EXTENT_ITEM. */
export interface ExtentDataBackref {
  /** The subvolume id holding the file. */
  root: number
  /** The file's inode number. */
  objectid: number
  /** The offset within the file where the extent starts. */
  offset: number
  /** How many references this file makes to the extent. */
  count: number
}

/**
 * One EXTENT_ITEM of the extent tree — an on-disk extent keyed by DEVICE
 * logical byte, the only btrfs index that answers "which extent owns this
 * on-disk byte". The EXTENT_DATA items of a file tree are keyed by file offset
 * instead, which is why a logical byte cannot be traced to its extent through
 * them alone.
 */
export interface ExtentTreeItem {
  /** btrfs logical bytenr of the extent's first on-disk sector. */
  logical: number
  /** On-disk length (the key's offset field — the compressed blob when compressed). */
  length: number
  /** The data backrefs: every (subvolume, inode, file offset) that owns a piece. */
  backrefs: ExtentDataBackref[]
}

/** `item N key (<logical> EXTENT_ITEM <length>)`. */
const EXTENT_TREE_ITEM_RE = /item \d+ key \((\d+) EXTENT_ITEM (\d+)\)/
/** `(178 0x…) extent data backref root <r> objectid <i> offset <o> count <c>`. */
const EXTENT_DATA_BACKREF_RE = /extent data backref root (\d+) objectid (\d+) offset (\d+) count (\d+)/

/**
 * Parse the EXTENT_ITEMs (with their data backrefs) out of an extent tree dump.
 *
 * Body lines attach only within their own item, as in every parser here: the
 * next `item N key (…)` closes the previous one, and a block group or a
 * metadata tree-block item (which share the extent tree) is skipped by the key
 * regex itself.
 */
export function parseExtentTreeItems(dump: string): ExtentTreeItem[] {
  const items: ExtentTreeItem[] = []
  let current: ExtentTreeItem | null = null
  for (const line of dump.split('\n')) {
    const key = EXTENT_TREE_ITEM_RE.exec(line)
    if (key) {
      current = { logical: Number(key[1]), length: Number(key[2]), backrefs: [] }
      items.push(current)
      continue
    }
    if (!current)
      continue
    const ref = EXTENT_DATA_BACKREF_RE.exec(line)
    if (ref)
      current.backrefs.push({ root: Number(ref[1]), objectid: Number(ref[2]), offset: Number(ref[3]), count: Number(ref[4]) })
  }
  return items
}

/**
 * How many fs-tree leaves one backref's forward scan may read.
 *
 * The EXTENT_DATA items that reference one extent all sit in the file range
 * `[ref.offset, ref.offset + ram_bytes)`, so they are adjacent in key order and
 * a couple of leaves cover them. The cap is what keeps a walk bounded when the
 * tree says something this code did not expect.
 *
 * Reaching it is a REFUSAL, never an answer (third pass, T6): a scan cut off
 * at the cap returns exactly what "there were no more owning items" returns,
 * and the difference between those two is the difference between a file's
 * whole extent list and an arbitrary prefix of it. Attribution would name a
 * subset of the bad blocks as if it were all of them, and a repair would be
 * handed a partial list with nothing to say the rest existed.
 */
export const MAX_OWNER_LEAVES = 4

/**
 * The EXTENT_DATA items of one file that reference ONE on-disk extent.
 *
 * An `extent data backref`'s `offset` is NOT the owning item's file offset:
 * btrfs stores `file_offset − extent_data_offset` there, so every item carved
 * out of the same extent by a CoW split hashes to the SAME backref (captured
 * live: an 8 MiB extent overwritten 1 MiB in has one backref `offset 0
 * count 2`, owning the items at file offsets 0 and 1,052,672). Reading the
 * backref as a file offset therefore finds the first piece and silently misses
 * every later one.
 *
 * The items are found by descending to `ref.offset` and collecting, forward,
 * every item of this inode that points AT this extent — the relation the
 * backref actually encodes.
 *
 * The scan CROSSES LEAVES. A large extent split by enough CoW overwrites has
 * its owning items spread over more than one fs-tree leaf, and re-descending
 * with `last + 1` cannot reach the next one: `findLeaf` takes the greatest key
 * ≤ its target, which for a key one byte past a leaf's last item is that same
 * item, in that same leaf. The scan stopped on iteration two and
 * `MAX_OWNER_LEAVES` never did anything (second-pass review F7). It now steps
 * to the genuinely next leaf through the recorded descent path, still bounded
 * by that cap — and EXHAUSTING the cap throws {@link SelfhealMapError} rather
 * than returning the prefix it had reached, which is indistinguishable from a
 * complete answer (third pass, T6).
 */
async function extentsReferencing(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  fsRoot: number,
  inode: number,
  extentLogical: number,
  refOffset: number,
): Promise<ExtentItem[]> {
  const found: ExtentItem[] = []
  // Learned from the first match: no owning item starts past ref.offset + ram.
  let limit: number | null = null
  /**
   * The scan reached an END — the inode's items ran out, the learned limit was
   * passed, or the tree had no next leaf. False when only the cap stopped it,
   * which is the one exit that does not know whether it saw everything.
   */
  let complete = false
  let cursor = await findLeafPath(executor, ctx.srcDevice, fsRoot, extentDataKey(inode, refOffset))
  for (let leaves = 0; leaves < MAX_OWNER_LEAVES; leaves++) {
    const items = parseExtentItems(cursor.text, inode)
    // Past this inode's items entirely — key order puts every EXTENT_DATA item
    // of one inode together, so a leaf with none of them ends the scan. The
    // FIRST leaf is exempt: the descent takes the greatest key ≤ its target,
    // so it can land a leaf short of the search key (the inode's items start
    // on the next leaf), and an empty first leaf says nothing about whether
    // more follow. `found.length > 0` used to gate this (third pass) — but a
    // file truncated or rewritten since the scrub holds none of its old items
    // anywhere, so the scan then walked every leaf to the cap and threw
    // "truncated" over what is an honest, complete answer: no extent of this
    // file covers the reported stripe (fourth pass).
    if (items.length === 0 && leaves > 0) {
      complete = true
      break
    }
    let last: number | null = null
    for (const item of items) {
      last = Math.max(last ?? 0, item.fileOffset)
      if (item.fileOffset < refOffset || item.diskByte !== extentLogical)
        continue
      if (!found.some(e => e.fileOffset === item.fileOffset))
        found.push(item)
      limit = Math.max(limit ?? 0, refOffset + (item.ram ?? item.length ?? 0))
    }
    if (limit !== null && last !== null && last >= limit) {
      complete = true
      break
    }
    const next = await nextLeaf(executor, ctx.srcDevice, cursor)
    if (next === null) {
      complete = true
      break
    }
    cursor = next
  }
  if (!complete) {
    throw new SelfhealMapError(
      `owner scan truncated at ${MAX_OWNER_LEAVES} leaves — the items referencing extent ${extentLogical} for inode ${inode} do not end within the bound, so the ${found.length} found so far are a prefix, not this file's extents in that stripe`,
      'owner-scan-truncated',
    )
  }
  return found
}

/**
 * The file's extents whose ON-DISK bytes intersect the 64 KiB stripe the
 * kernel named (selfheal.8).
 *
 * The route is the kernel's own: the extent tree at the named logical (two
 * bounded walks — the stripe may straddle a leaf boundary), whose EXTENT_ITEMs
 * name the on-disk extents living in the stripe, then the fs tree for the
 * EXTENT_DATA items of THIS file that reference each of them
 * ({@link extentsReferencing} — a backref is not a file offset). Backrefs are
 * filtered to the (subvolume, inode) the kernel printed, so a blob shared with
 * a snapshot or another file contributes only this file's extents.
 *
 * An empty result means nothing of THIS file lives in the named stripe; a
 * thrown {@link SelfhealMapError} means the chain could not be followed at
 * all. Both are the caller's cue to fall back — never a reason to guess.
 */
export async function extentsForStripe(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  root: number,
  inode: number,
  logical: number,
): Promise<ExtentItem[]> {
  if (ctx.roots.extent === null)
    throw new SelfhealMapError('btrfs dump-tree -r named no extent tree root — a logical byte cannot be traced to its extent without it')
  const fsRoot = ctx.roots.bySubvolume.get(root)
  if (fsRoot === undefined)
    throw new SelfhealMapError(`btrfs names no tree root for subvolume ${root}`)

  // The stripe's first and last items: the leaf holding the stripe's start and
  // the leaf holding its end. Deduped, the two cover the stripe — items are
  // contiguous and ordered in device space.
  const stripeStart = Math.floor(logical / BTRFS_STRIPE_BYTES) * BTRFS_STRIPE_BYTES
  const stripeEnd = stripeStart + BTRFS_STRIPE_BYTES
  const seen = new Set<string>()
  const owners: { extentLogical: number, refOffset: number }[] = []
  for (const target of [stripeStart, stripeEnd - 1]) {
    const leaf = await findLeaf(executor, ctx.srcDevice, ctx.roots.extent, extentItemKey(target))
    for (const item of parseExtentTreeItems(leaf)) {
      if (item.logical >= stripeEnd || item.logical + item.length <= stripeStart)
        continue
      for (const ref of item.backrefs) {
        const key = `${item.logical}:${ref.offset}`
        if (ref.root !== root || ref.objectid !== inode || seen.has(key))
          continue
        seen.add(key)
        owners.push({ extentLogical: item.logical, refOffset: ref.offset })
      }
    }
  }

  const extents: ExtentItem[] = []
  for (const owner of owners) {
    for (const extent of await extentsReferencing(executor, ctx, fsRoot, inode, owner.extentLogical, owner.refOffset)) {
      if (!extents.some(e => e.fileOffset === extent.fileOffset))
        extents.push(extent)
    }
  }
  return extents
}

/**
 * md byte → which member, and where on it.
 *
 * left-symmetric RAID5/6: P sits at `(n-1) - (stripe mod n)`, Q immediately
 * after it, and the data chunks follow Q (RAID6) or P (RAID5) in increasing
 * disk order, wrapping. `dataIndex` is the position among the data disks in
 * that order — md's RAID6 syndrome uses it as the exponent of the Q
 * coefficient, which is why it is carried and not recomputed later.
 *
 * RAID1 has no stripe: the md byte is at the same offset on every leg, past
 * that leg's own data offset.
 */
export function placeMdByte(mdByte: number, geo: MdGeometry): Omit<MemberLocation, 'logical' | 'lvByte' | 'geometry' | 'startSector' | 'chunkLogical' | 'chunkDevice'> {
  if (geo.raid1) {
    const mirrors = geo.members.map((m, i) => (m ? i : -1)).filter(i => i >= 0)
    if (mirrors.length === 0)
      throw new SelfhealMapError('RAID1 array reports no present member')
    const first = mirrors[0]
    return {
      mdByte,
      memberIndex: first,
      memberDevice: geo.members[first] as string,
      memberOffset: geo.dataOffsets[first] + mdByte,
      stripe: null,
      parityIndex: null,
      qIndex: null,
      dataIndex: null,
      mirrors,
    }
  }

  if (geo.layout !== SUPPORTED_PARITY_LAYOUT) {
    throw new SelfhealMapError(
      `md layout '${geo.layout ?? 'unknown'}' is not supported — this engine maps ${SUPPORTED_PARITY_LAYOUT} only (the mdadm default, and what AHR creates). Refusing rather than guessing where the bytes are.`,
    )
  }
  if (geo.chunkBytes <= 0)
    throw new SelfhealMapError(`md reports chunk_size ${geo.chunkBytes} on ${geo.level}`)

  const n = geo.raidDisks
  const dataDisks = n - (geo.raid6 ? 2 : 1)
  const chunkIndex = Math.floor(mdByte / geo.chunkBytes)
  const dataIndex = chunkIndex % dataDisks
  const stripe = Math.floor(chunkIndex / dataDisks)
  const inChunk = mdByte % geo.chunkBytes
  const parityIndex = (n - 1) - (stripe % n)
  const qIndex = (parityIndex + 1) % n
  const anchor = geo.raid6 ? qIndex : parityIndex
  const memberIndex = (anchor + 1 + dataIndex) % n
  const device = geo.members[memberIndex]
  if (!device)
    throw new SelfhealMapError(`member role ${memberIndex} is missing from the array — repair refuses on a degraded array`)
  return {
    mdByte,
    memberIndex,
    memberDevice: device,
    memberOffset: geo.dataOffsets[memberIndex] + stripe * geo.chunkBytes + inChunk,
    stripe,
    parityIndex,
    qIndex: geo.raid6 ? qIndex : null,
    dataIndex,
    mirrors: [memberIndex],
  }
}

/**
 * Where the SAME bytes sit on another role of the same array.
 *
 * Every member has its OWN data offset (`rd<n>/offset`) — `mdadm --grow
 * --data-offset` can leave them differing, and md does not require them equal —
 * so the payload offset is computed once and added to THAT member's own offset.
 * RAID1's payload offset is the md byte itself (every leg carries the whole
 * array); on a parity level it is the stripe row the block sits in.
 *
 * One helper for all three callers — the mirror re-verify, the mirror
 * candidates and the parity row reads — so a member offset cannot be computed
 * two ways.
 */
export function memberOffsetOn(geo: MdGeometry, location: MemberLocation, member: number): number {
  const payload = geo.raid1
    ? location.mdByte
    : (location.stripe as number) * geo.chunkBytes + (location.mdByte % geo.chunkBytes)
  return geo.dataOffsets[member] + payload
}

/** The data-disk roles of one stripe, in md's stripe order (index = Q exponent). */
export function stripeDataOrder(geo: MdGeometry, stripe: number): number[] {
  const n = geo.raidDisks
  const dataDisks = n - (geo.raid6 ? 2 : 1)
  const parityIndex = (n - 1) - (stripe % n)
  const anchor = geo.raid6 ? (parityIndex + 1) % n : parityIndex
  return Array.from({ length: dataDisks }, (_, d) => (anchor + 1 + d) % n)
}

// ---------------------------------------------------------------------------
//  Live reads
// ---------------------------------------------------------------------------

/**
 * md geometry, read LIVE.
 *
 * Roles come from `mdadm --detail --export` (`MD_DEVICE_<name>_ROLE` /
 * `_DEV` — KEY=VALUE, the structured form); everything else from sysfs, one
 * value per file. Each member's data offset is read from its OWN `rd<n>/offset`
 * rather than assumed uniform: `mdadm --grow --data-offset` can leave a member
 * with a different one, and a repair that assumed otherwise would write 4 KiB
 * of correct data into the wrong place.
 */
export async function readMdGeometry(executor: CommandExecutor, mdDevice: string): Promise<MdGeometry> {
  const kernel = await kernelName(executor, mdDevice)
  const sys = mdSysPath(kernel)

  const attributes: Record<string, string | null> = {}
  for (const key of ['level', 'raid_disks', 'chunk_size', 'layout'])
    attributes[key] = await readMdAttrOrNull(sys, key)

  const raidDisks = Number(attributes.raid_disks ?? '0')
  for (let i = 0; i < raidDisks; i++) {
    attributes[`rd${i}/offset`] = await readMdAttrOrNull(sys, `rd${i}/offset`)
    // md's bad-block list, per member (seventh pass, F8). `rd<n>` is the
    // kernel's own symlink to `dev-<name>`, so this reads exactly the file the
    // packaging hook counts ranges in (`md/dev-*/bad_blocks`) while staying
    // indexed by ROLE, which is what the placement formula and the
    // reconstruction plan speak.
    attributes[`rd${i}/bad_blocks`] = await readMdAttrOrNull(sys, `rd${i}/bad_blocks`)
  }

  const detail = await executor.exec(MDADM, mdadmDetailExportArgs(mdDevice))
  if (detail.exitCode !== 0)
    throw new SelfhealMapError(`mdadm --detail --export ${mdDevice} failed: ${detail.stderr.trim()}`, 'band-unreadable')

  return geometryFromAttributes(mdDevice, kernel, sys, attributes, parseMdDetailExport(detail.stdout, raidDisks))
}

/**
 * Role index → member device, from `mdadm --detail --export`.
 *
 * The KEY=VALUE text is parsed by the ONE parser this codebase has for it
 * (`parsers/mdadm-detail.ts`, the topology layer's); this is only the
 * projection onto role slots the placement formula indexes by.
 *
 * A role with no device is a HOLE (a failed or removed member), left null so
 * the caller can refuse rather than silently shifting every later role down by
 * one — which is what building the list from the present devices alone would do.
 * A SPARE reports `MD_DEVICE_<x>_ROLE=spare`: it holds no role slot and none of
 * the array's data, so it is left out of the list by name rather than dropped
 * by a regex that happened not to match it.
 */
export function parseMdDetailExport(text: string, raidDisks: number): (string | null)[] {
  const members: (string | null)[] = Array.from<string | null>({ length: raidDisks }).fill(null)
  for (const member of parseMdadmDetailExport(text).members) {
    if (!INTEGER_RE.test(member.role))
      continue // 'spare' (or an unreported role) — not a slot in the layout
    const role = Number(member.role)
    if (role < raidDisks)
      members[role] = member.dev
  }
  return members
}

/**
 * Assemble the geometry from raw sysfs attribute values.
 *
 * Split out from the reads so the decoding — which level is which, what a
 * `layout` number means, which attributes a level simply does not have — can be
 * checked against captured sysfs from real RAID1, RAID5 and RAID6 arrays.
 */
export function geometryFromAttributes(
  device: string,
  kernel: string,
  sys: string,
  attributes: Record<string, string | null>,
  members: (string | null)[],
): MdGeometry {
  const level = attributes.level ?? ''
  const raid6 = level === 'raid6'
  const raid1 = level === 'raid1'
  if (!raid1 && level !== 'raid5' && !raid6)
    throw new SelfhealMapError(`md level '${level}' is not a self-heal band type (raid1, raid5, raid6)`, 'band-unreadable')

  const raidDisks = Number(attributes.raid_disks ?? '0')
  if (!Number.isInteger(raidDisks) || raidDisks <= 0)
    throw new SelfhealMapError(`md reports raid_disks '${attributes.raid_disks}'`, 'band-unreadable')

  const chunkBytes = Number(attributes.chunk_size ?? '0')
  // RAID1 reports layout 0 and means nothing by it — do not decode it as a
  // parity layout and then refuse the array for not being left-symmetric.
  const raw = attributes.layout
  const layout = raid1 || raw === null ? null : (MD_LAYOUT_NAMES[Number(raw)] ?? `layout ${raw}`)

  const dataOffsets: number[] = []
  const badBlocks: (BadBlockRange[] | null)[] = []
  for (let i = 0; i < raidDisks; i++) {
    const offset = attributes[`rd${i}/offset`]
    // cr3 AHR-HEAL-L8 — an unreadable data offset is not offset 0. Every read
    // and the one write the engine makes is placed at `dataOffset + payload`,
    // and a member whose offset this node could not read would have been read
    // (and, through the read-back guard's comparison, written) a whole data
    // offset away from the bytes md placed there. A PRESENT member's offset is
    // a fact the band needs; without it the band is unreadable. An ABSENT
    // role's offset is nobody's fact: NaN, so any arithmetic that reaches it
    // fails loudly (readDirect refuses a non-multiple of 4 KiB) instead of
    // landing on sector 0.
    const present = members[i] !== null && members[i] !== undefined
    const sectors = offset === null || offset === undefined || !INTEGER_RE.test(offset) ? null : Number(offset)
    if (sectors === null && present)
      throw new SelfhealMapError(`${device}: rd${i}/offset of member ${members[i]} could not be read${offset ? ` ('${offset}')` : ''} — every byte on that member is placed relative to it, and an offset this node does not know is not 0`, 'band-unreadable')
    dataOffsets.push(sectors === null ? Number.NaN : sectors * 512)
    // `undefined` (the caller never read the attribute) and `null` (it read and
    // found nothing there) are both "this node does not know", and neither is
    // "the member is clean" — see {@link parseBadBlocks}.
    badBlocks.push(parseBadBlocks(attributes[`rd${i}/bad_blocks`] ?? null))
  }

  return { device, kernel, sys, level, raid6, raid1, raidDisks, chunkBytes, layout, members, dataOffsets, badBlocks }
}

/** The btrfs device behind a mountpoint (the LV). */
export async function btrfsDeviceFor(executor: CommandExecutor, mountpoint: string): Promise<string> {
  const r = await executor.exec(FINDMNT, ['-n', '-o', 'SOURCE', '-T', mountpoint])
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new SelfhealMapError(`findmnt found no filesystem at ${mountpoint}`)
  // A subvolume mount prints `/dev/x[/@data]` — the device is the part before `[`.
  return r.stdout.trim().split('[')[0]
}

/**
 * Everything about the pool that is the same for every block of one run.
 *
 * Resolving each md array from the dm table's own `major:minor` — rather than a
 * second `dmsetup deps` call — keeps the device and the offset coming from ONE
 * reading of one table: a pool whose table changed between the two calls could
 * otherwise be mapped with one segment's offset onto another segment's array.
 *
 * EVERY segment is resolved, not just the first: an AHR pool's LV is the linear
 * concatenation of one md array per band, and a block in band 3 is placed with
 * band 3's geometry or not at all. A segment whose device is NOT an md array is
 * refused by name — the placement formula below describes md arrays and nothing
 * else, so mapping through anything else would be a guess with a write at the
 * end of it.
 *
 * A band whose geometry cannot be read is recorded, NOT thrown (second-pass
 * review F6). One momentarily-unreadable band used to void the whole context —
 * and with it the btrfs tree roots, which is all the scrub's attribution pass
 * needs — so every file of every band came back `unidentified`. The failure is
 * carried on the band and raised where a byte is actually placed on it
 * (`locateLogicalIn`), which fails exactly the blocks that live there. The
 * repair engine's gates refuse such a pool up front, as they always did.
 */
export async function resolveContext(executor: CommandExecutor, mountpoint: string): Promise<SelfhealContext> {
  const srcDevice = await btrfsDeviceFor(executor, mountpoint)

  const bands: SelfhealBand[] = []
  const band = async (segment: DmSegment, resolveDevice: () => Promise<string>): Promise<SelfhealBand> => {
    let device = `the dm segment at sector ${segment.startSector}`
    try {
      device = await resolveDevice()
      return { segment, device, geometry: await readBandGeometry(executor, device, segment), error: null }
    }
    catch (error) {
      return { segment, device, geometry: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const table = await executor.exec(DMSETUP, ['table', srcDevice])
  if (table.exitCode === 0 && table.stdout.trim()) {
    for (const segment of parseDmTable(table.stdout)) {
      const majmin = `${segment.major}:${segment.minor}`
      bands.push(await band(segment, async () => `/dev/${await kernelName(executor, `/sys/dev/block/${majmin}`)}`))
    }
  }
  else {
    // btrfs straight on md (no LVM): the identity segment keeps one code path.
    const segment: DmSegment = { startSector: 0, lengthSectors: Number.MAX_SAFE_INTEGER, major: 0, minor: 0, offsetSector: 0 }
    bands.push(await band(segment, async () => srcDevice))
  }

  const roots = await readTreeRoots(executor, srcDevice)
  return { mountpoint, srcDevice, bands, roots, chunks: [], csums: [] }
}

/**
 * One band's geometry, refusing a segment that is not on an md array at all.
 *
 * `readMdGeometry` would fail on such a device anyway — with a message about a
 * level it could not read, which describes the symptom and not the cause. The
 * cause is worth saying: this pool's bytes are not under md, so nothing here
 * knows where they are.
 */
async function readBandGeometry(
  executor: CommandExecutor,
  device: string,
  segment: DmSegment,
): Promise<MdGeometry> {
  const kernel = await kernelName(executor, device)
  if ((await readMdAttrOrNull(mdSysPath(kernel), 'level')) === null) {
    throw new SelfhealMapError(
      `the dm segment at sector ${segment.startSector} maps onto ${device}, which is not an md array (no /sys/block/${kernel}/md) — this engine maps AHR bands, and refuses rather than guessing where the bytes are`,
      'band-unreadable',
    )
  }
  return readMdGeometry(executor, device)
}

/**
 * The chunk covering a logical byte, fetching ONE chunk-tree leaf if the cache
 * does not already hold it.
 *
 * Chunks partition the logical address space, so a cached chunk that covers the
 * byte IS the answer and no walk is needed — which is why a compressed blob's
 * sectors, or a whole stripe's worth of lookups, cost one leaf between them.
 */
export async function coveringChunk(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
  dataOnly = false,
): Promise<ChunkItem> {
  const cached = ctx.chunks.find(c => logical >= c.logical && logical < c.logical + c.length)
  if (!cached) {
    const leaf = await findLeaf(executor, ctx.srcDevice, ctx.roots.chunk, chunkItemKey(logical))
    mergeChunks(ctx, parseChunkItems(leaf))
  }
  return chunkForLogical(ctx.chunks, logical, dataOnly)
}

/** Add newly-read chunk items to the run's cache, without duplicating. */
function mergeChunks(ctx: SelfhealContext, items: ChunkItem[]): void {
  for (const item of items) {
    if (!ctx.chunks.some(c => c.logical === item.logical))
      ctx.chunks.push(item)
  }
}

/**
 * Place ONE btrfs logical byte all the way down to a member — the pure half,
 * given the chunk that covers it. Kept separate from the fetching so the whole
 * chain can be asserted against captured rig output with no executor at all.
 *
 * The band is picked by the LV byte, and the geometry used from that point down
 * is the band's own — which is the whole point of passing bands rather than one
 * geometry.
 */
export function locateLogicalIn(
  logical: number,
  chunk: ChunkItem,
  bands: SelfhealBand[],
): MemberLocation {
  const lvByte = logical - chunk.logical + chunk.deviceOffset
  const band = bandForLvByte(bands, lvByte)
  // The band's geometry is resolved lazily (F6): a byte on an unreadable band
  // is refused HERE, naming that band — every other band still maps.
  if (band.geometry === null)
    throw new SelfhealMapError(`LV byte ${lvByte} is on ${band.device}, whose geometry could not be read: ${band.error ?? 'no reason recorded'}`, 'band-unreadable')
  const seg = band.segment
  const mdByte = lvByte - seg.startSector * 512 + seg.offsetSector * 512
  const placed = placeMdByte(mdByte, band.geometry)
  return {
    ...placed,
    logical,
    lvByte,
    geometry: band.geometry,
    startSector: seg.offsetSector,
    chunkLogical: chunk.logical,
    chunkDevice: chunk.deviceOffset,
  }
}

/** Place ONE btrfs logical byte, fetching the covering DATA chunk as needed. */
export async function locateLogical(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
): Promise<MemberLocation> {
  const chunk = await coveringChunk(executor, ctx, logical, true)
  return locateLogicalIn(logical, chunk, ctx.bands)
}

// ---------------------------------------------------------------------------
//  The chain, run backwards (story selfheal.11)
// ---------------------------------------------------------------------------

/**
 * Every CHUNK_ITEM of the filesystem, in ONE dump, merged into the run's cache.
 *
 * The forward chain never needs this: it starts from a logical byte and the
 * chunk tree is keyed BY logical byte, so one bounded `dump-tree -b` walk lands
 * on the covering item. The mirror reconcile (selfheal.11) starts from an md
 * byte and asks the opposite question — "which chunk was mapped HERE?" — and
 * nothing in the tree is keyed by device offset, so there is no walk to make.
 * The only honest answer is to read the whole chunk tree once.
 *
 * That is affordable where the csum tree is not (README: 8 TB of data carries
 * ~8 GB of checksums, which is why the engine never dumps THAT one). A chunk
 * covers a gigabyte of data or a quarter of one of metadata, so the same 8 TB
 * carries a few thousand chunk items — one bounded read, once per run, and
 * every later `coveringChunk` for that run is answered from the cache it fills.
 */
export async function readAllChunkItems(
  executor: CommandExecutor,
  ctx: SelfhealContext,
): Promise<ChunkItem[]> {
  const r = await executor.exec(BTRFS, ['inspect-internal', 'dump-tree', '-t', '3', ctx.srcDevice])
  if (r.exitCode !== 0)
    throw new SelfhealMapError(`btrfs inspect-internal dump-tree -t 3 ${ctx.srcDevice} failed: ${r.stderr.trim()}`)
  mergeChunks(ctx, parseChunkItems(r.stdout))
  return ctx.chunks
}

/** Where an md byte came from, read back up the chain. */
export interface LogicalForMdByte {
  /** The btrfs logical bytenr mapped onto this md byte. */
  logical: number
  /** Byte offset within the btrfs device (the LV) — the middle of the hop. */
  lvByte: number
  /** The chunk that covers it — `type` says DATA, METADATA or SYSTEM. */
  chunk: ChunkItem
  /**
   * Which COPY of that chunk this md byte is. A `single` chunk has one (0); a
   * `DUP` metadata chunk has two, and the same logical byte is at two different
   * device offsets, so the copy has to be carried rather than assumed.
   */
  copy: number
}

/**
 * md byte → LV byte → btrfs logical: the inverse of the forward hop
 * (`locateLogicalIn` + {@link logicalToLvByte}), for ONE band.
 *
 * `null` is a real answer and the common one: an md byte in no chunk at all is
 * FREE SPACE. btrfs has never written there, nothing on this node knows what it
 * should hold, and two mirror legs are entitled to disagree about it — so a
 * caller must skip such a row rather than pick a winner for it.
 *
 * Pure, and given the chunk list rather than fetching it, for the same reason
 * `locateLogicalIn` is: the whole chain can then be asserted against captured
 * rig output with no executor anywhere near it.
 */
export function logicalForMdByte(
  mdByte: number,
  band: SelfhealBand | readonly SelfhealBand[],
  chunks: readonly ChunkItem[],
): LogicalForMdByte | null {
  // cr3 AHR-HEAL-L10 — ONE md array can carry SEVERAL dm segments (AHR
  // expansion `lvextend`s onto the same band again), each mapping its own md
  // range to its own LV range. The md byte is placed through the segment whose
  // md range CONTAINS it, never through whichever segment came first: the
  // first segment's arithmetic applied to a byte of the second lands on an
  // unrelated LV byte, and the row is then arbitrated against a stranger. An
  // md byte inside no segment is not part of the LV at all — btrfs has never
  // written there, which is free space, the same answer as a byte in no chunk.
  const bands = Array.isArray(band) ? band as readonly SelfhealBand[] : [band as SelfhealBand]
  const seg = bands
    .map(b => b.segment)
    .find(s => mdByte >= s.offsetSector * 512 && mdByte < (s.offsetSector + s.lengthSectors) * 512)
  if (!seg)
    return null
  const lvByte = mdByte + seg.startSector * 512 - seg.offsetSector * 512
  if (lvByte < 0)
    return null
  for (const chunk of chunks) {
    for (const [copy, deviceOffset] of chunkStripeOffsets(chunk).entries()) {
      if (lvByte >= deviceOffset && lvByte < deviceOffset + chunk.length)
        return { logical: lvByte - deviceOffset + chunk.logical, lvByte, chunk, copy }
    }
  }
  return null
}

/** The inode number of a path. */
async function inodeOf(executor: CommandExecutor, path: string): Promise<number> {
  const r = await executor.exec(STAT, ['-c', '%i', path])
  if (r.exitCode !== 0)
    throw new SelfhealMapError(`stat ${path}: ${r.stderr.trim()}`)
  return Number(r.stdout.trim())
}

/** The subvolume id holding a path — which fs tree the walk starts in. */
export async function subvolumeIdOf(executor: CommandExecutor, path: string): Promise<number> {
  const rootid = await executor.exec(BTRFS, ['inspect-internal', 'rootid', path])
  if (rootid.exitCode === 0 && INTEGER_RE.test(rootid.stdout.trim()))
    return Number(rootid.stdout.trim())
  // Older btrfs-progs: fall back to the subvolume the path sits in.
  const show = await executor.exec(BTRFS, ['subvolume', 'show', path])
  const m = SUBVOLUME_ID_RE.exec(show.stdout)
  if (!m)
    throw new SelfhealMapError(`cannot determine the subvolume id of ${path}`)
  return Number(m[1])
}

/**
 * The REPAIR UNIT for one file block of one extent.
 *
 * Uncompressed: the block itself — each 4 KiB block carries its own csum, so
 * the extent is not the unit. Compressed: the whole on-disk blob, because
 * btrfs stores one csum entry per on-disk sector of it and a single corrupt
 * sector takes out the entire (up to 128 KiB) logical extent.
 *
 * The block's logical bytenr is `disk byte + extent data offset + (file offset
 * − the item's file offset)`. The middle term is the one a CoW split makes
 * non-zero, and it is not optional: on a live capture (an 8 MiB file with
 * 4 KiB overwritten 1 MiB in) the tail item reads `disk byte 13631488 …
 * offset 1052672`, so block 300 sits at logical 14,860,288 — dropping the term
 * lands on 13,807,616, a megabyte away, where a DIFFERENT block's stored csum
 * lives (0x286f6be8 against the block's real 0xaceb29bc) and where a repair
 * would have written.
 *
 * Everything is bound-checked against the item's own `nr` fields: a block the
 * item does not cover, or a logical byte past the on-disk extent, is refused
 * rather than mapped.
 */
export function repairUnitFor(extent: ExtentItem, block: number): {
  compressed: boolean
  blobLogical: number
  blobSectors: number
  logicalByte: number
} {
  const diskByte = extent.diskByte ?? 0
  const diskLength = extent.diskLength ?? BLOCK_BYTES
  const fileOffset = block * BLOCK_BYTES
  const compressed = extent.compression !== 'none'
  const within = fileOffset - extent.fileOffset
  const length = extent.length ?? 0
  if (within < 0 || within >= length)
    throw new SelfhealMapError(`block ${block} (file byte ${fileOffset}) is outside the extent at file offset ${extent.fileOffset}, which covers ${length} bytes`)

  const intoExtent = extent.extentDataOffset + within
  if (!compressed && intoExtent + BLOCK_BYTES > diskLength)
    throw new SelfhealMapError(`block ${block} maps ${intoExtent} bytes into an on-disk extent of ${diskLength} bytes — the EXTENT_DATA item does not describe where this block is`)
  if (compressed && intoExtent >= (extent.ram ?? length))
    throw new SelfhealMapError(`block ${block} maps ${intoExtent} bytes into a compressed extent that decompresses to ${extent.ram ?? length} bytes`)

  return {
    compressed,
    blobLogical: compressed ? diskByte : diskByte + intoExtent,
    blobSectors: compressed ? Math.ceil(diskLength / BLOCK_BYTES) : 1,
    logicalByte: diskByte + intoExtent,
  }
}

/**
 * Resolve one 4 KiB file block into the REPAIR UNIT's on-disk sectors.
 *
 * The repair unit is the block itself for an uncompressed extent — each block
 * carries its own csum — and the WHOLE on-disk blob for a compressed one:
 * btrfs stores one csum entry per on-disk sector of the blob, and a single
 * corrupt sector takes out the entire (up to 128 KiB) logical extent, so there
 * is nothing smaller that can be checked or fixed.
 *
 * Every sector is placed INDEPENDENTLY through the full chain rather than
 * assumed contiguous on one member: a blob that straddles a chunk boundary has
 * its sectors on two different disks, and assuming otherwise would read the
 * wrong bytes and then "repair" from them.
 */
export async function resolveBlock(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  file: string,
  block: number,
): Promise<ResolvedBlock> {
  const inode = await inodeOf(executor, file)
  const subvol = await subvolumeIdOf(executor, file)
  const fsRoot = ctx.roots.bySubvolume.get(subvol)
  if (fsRoot === undefined)
    throw new SelfhealMapError(`btrfs names no tree root for subvolume ${subvol} (holding ${file})`)

  const fileOffset = block * BLOCK_BYTES
  // ONE leaf: the descent takes the greatest key <= (inode, EXTENT_DATA,
  // fileOffset), which is the extent COVERING that offset, so the leaf it
  // lands in is the leaf that holds it.
  const leaf = await findLeaf(executor, ctx.srcDevice, fsRoot, extentDataKey(inode, fileOffset))
  const extents = parseExtentItems(leaf, inode)
  if (extents.length === 0)
    throw new SelfhealMapError(`no EXTENT_DATA items for ${file} (inode ${inode}) in subvolume ${subvol}`)

  const extent = extentForFileOffset(extents, fileOffset)
  if (extent.type === 'inline' || extent.diskByte === undefined || extent.diskLength === undefined)
    throw new SelfhealMapError(`block ${block} of ${file} is an inline extent — its bytes live in the metadata tree, not in a data chunk`, 'inline-extent')
  if (extent.diskByte === 0)
    throw new SelfhealMapError(`block ${block} of ${file} is a hole — there is nothing on disk to repair`, 'hole')

  const { compressed, blobLogical, blobSectors, logicalByte } = repairUnitFor(extent, block)

  const sectors: MemberLocation[] = []
  for (let k = 0; k < blobSectors; k++)
    sectors.push(await locateLogical(executor, ctx, blobLogical + k * BLOCK_BYTES))

  return { file, block, extent, compressed, blobLogical, blobSectors, logicalByte, sectors }
}
