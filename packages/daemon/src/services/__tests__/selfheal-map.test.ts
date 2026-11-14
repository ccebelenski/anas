import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parseTreeRoots } from '../selfheal-btree.js'
import { crc32c, csumHex } from '../selfheal-csum.js'
import { BLOCK_BYTES } from '../selfheal-io.js'
import {
  badBlocksUnknownRefusal,
  bandBadBlocks,
  bandBadBlocksUnknown,
  chunkForLogical,
  extentForFileOffset,
  extentsForStripe,
  geometryFromAttributes,
  locateLogicalIn,
  logicalToLvByte,
  MAX_OWNER_LEAVES,
  MD_BAD_BLOCKS_COORDINATES,
  memberHasBadBlock,
  memberOffsetOn,
  parseBadBlocks,
  parseChunkItems,
  parseDmTable,
  parseExtentItems,
  parseExtentTreeItems,
  parseMdDetailExport,
  placeMdByte,
  repairUnitFor,
  segmentForLvByte,
  selfhealBand,
  SelfhealMapError,
  stripeDataOrder,
} from '../selfheal-map.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

/** `key=value` sysfs capture (see fixtures/selfheal/PROVENANCE.md) → a map. */
function sysfsAttributes(name: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const line of fixture(name).split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0)
      continue
    const value = line.slice(eq + 1)
    out[line.slice(0, eq)] = value === '<absent>' ? null : value
  }
  return out
}

const CHUNK_TREE = fixture('dump-tree-chunk.txt')
const SUBVOL_TREE = fixture('dump-tree-subvol.txt')
const DM_TABLE = fixture('dmsetup-table-lv.txt')

/** What the selfheal.2 Python mapper resolved on the same rig — the answers. */
interface ExpectedMapping {
  file: string
  block: number
  compressed: boolean
  logical_byte: number
  target_logical: number
  blob_logical: number
  blob_sectors: number
  chunk_logical: number
  chunk_device: number
  start_sector: number
  lv_byte: number
  md_byte: number
  disk: number
  moff: number
  stripe: number
  parity_disk: number
  q_disk: number
  stored_csum: string
}
const EXPECTED: ExpectedMapping[] = JSON.parse(fixture('expected-mapping.json'))

const RAID5 = geometryFromAttributes(
  '/dev/md127',
  'md127',
  '/sys/block/md127/md',
  sysfsAttributes('md-sysfs-raid5.txt'),
  parseMdDetailExport(fixture('mdadm-detail-export-raid5.txt'), 6),
)
const RAID6 = geometryFromAttributes(
  '/dev/md127',
  'md127',
  '/sys/block/md127/md',
  sysfsAttributes('md-sysfs-raid6.txt'),
  parseMdDetailExport(fixture('mdadm-detail-export-raid6.txt'), 7),
)
const RAID1 = geometryFromAttributes(
  '/dev/md126',
  'md126',
  '/sys/block/md126/md',
  sysfsAttributes('md-sysfs-raid1.txt'),
  parseMdDetailExport(fixture('mdadm-detail-export-raid1.txt'), 2),
)

const SEGMENTS = parseDmTable(DM_TABLE)
/** The rig's single band: its one linear segment on the RAID5 array. */
const BANDS = SEGMENTS.map(segment => selfhealBand(segment, RAID5))
const CHUNKS = parseChunkItems(CHUNK_TREE)

/**
 * THE mapping helper (selfheal.5), against output captured verbatim from a
 * live loop rig. The reference answers come from the selfheal.2 suite's own
 * Python mapper, which was written independently — an agreement between the
 * two is worth more than either agreeing with itself.
 */
describe('selfheal mapping — md geometry', () => {
  it('reads level, chunk, layout and per-member data offsets from sysfs values', () => {
    assert.equal(RAID5.level, 'raid5')
    assert.equal(RAID5.raidDisks, 6)
    assert.equal(RAID5.chunkBytes, 65536)
    assert.equal(RAID5.layout, 'left-symmetric')
    assert.equal(RAID5.raid6, false)
    assert.deepEqual(RAID5.dataOffsets, [1048576, 1048576, 1048576, 1048576, 1048576, 1048576])
  })

  it('maps roles to devices from mdadm --detail --export, in role order', () => {
    assert.deepEqual(RAID5.members, [
      '/dev/loop0',
      '/dev/loop1',
      '/dev/loop2',
      '/dev/loop3',
      '/dev/loop4',
      '/dev/loop5',
    ])
    assert.equal(RAID6.members.length, 7)
    assert.equal(RAID6.raid6, true)
  })

  it('leaves a missing role NULL rather than shifting the later roles down', () => {
    const text = fixture('mdadm-detail-export-raid5.txt')
      .split('\n')
      .filter(l => !l.includes('dev_loop2'))
      .join('\n')
    const members = parseMdDetailExport(text, 6)
    assert.equal(members[2], null)
    assert.equal(members[3], '/dev/loop3')
  })

  it('treats RAID1 as having no layout and no chunk — both are absent, not zero-meaning', () => {
    assert.equal(RAID1.level, 'raid1')
    assert.equal(RAID1.raid1, true)
    assert.equal(RAID1.layout, null)
    assert.equal(RAID1.chunkBytes, 0)
    assert.deepEqual(RAID1.dataOffsets, [1048576, 1048576])
  })

  it('refuses a level that is not an AHR band type', () => {
    assert.throws(
      () => geometryFromAttributes('/dev/md0', 'md0', '/s', { level: 'raid10', raid_disks: '4' }, []),
      /not a self-heal band type/,
    )
  })
})

describe('selfheal mapping — dm table', () => {
  it('parses the linear segment the btrfs LV sits on', () => {
    assert.deepEqual(parseDmTable(DM_TABLE), [
      { startSector: 0, lengthSectors: 2031616, major: 9, minor: 127, offsetSector: 2560 },
    ])
  })

  it('parses the name-prefixed form `dmsetup table` prints without a device', () => {
    assert.deepEqual(parseDmTable(fixture('dmsetup-table-all.txt')), parseDmTable(DM_TABLE))
  })

  it('REFUSES a non-linear target instead of mapping through it', () => {
    assert.throws(
      () => parseDmTable('0 2031616 mirror core 2 1024 nosync 2 9:127 0 9:128 0\n'),
      /is not linear/,
    )
  })

  it('picks the segment covering an LV byte (a multi-band pool is a concat)', () => {
    const segments = [
      { startSector: 0, lengthSectors: 2048, major: 9, minor: 1, offsetSector: 2560 },
      { startSector: 2048, lengthSectors: 2048, major: 9, minor: 2, offsetSector: 4096 },
    ]
    assert.equal(segmentForLvByte(segments, 0).minor, 1)
    assert.equal(segmentForLvByte(segments, 2048 * 512).minor, 2)
    assert.throws(() => segmentForLvByte(segments, 4096 * 512), /no dm linear segment/)
  })
})

/**
 * R1 — a pool whose LV is a LINEAR CONCATENATION of several md arrays, one per
 * AHR band (AHR-DESIGN §2.6). Fixtures captured from a live two-band rig: two
 * 3-member RAID5 arrays with DIFFERENT chunk sizes (64 K and 512 K) and
 * DIFFERENT data offsets (1 MiB and 2 MiB), one VG, one LV across both.
 */
describe('selfheal mapping — a multi-band pool', () => {
  const TWO_BAND = parseDmTable(fixture('twoband-dmsetup-table-lv.txt'))
  const BAND1 = geometryFromAttributes(
    '/dev/md127',
    'md127',
    '/sys/block/md127/md',
    sysfsAttributes('twoband-md-sysfs-band1.txt'),
    parseMdDetailExport(fixture('twoband-mdadm-detail-export-band1.txt'), 3),
  )
  const BAND2 = geometryFromAttributes(
    '/dev/md126',
    'md126',
    '/sys/block/md126/md',
    sysfsAttributes('twoband-md-sysfs-band2.txt'),
    parseMdDetailExport(fixture('twoband-mdadm-detail-export-band2.txt'), 3),
  )
  const BANDS_2 = [
    selfhealBand(TWO_BAND[0], BAND1),
    selfhealBand(TWO_BAND[1], BAND2),
  ]
  /** Identity chunk: this is about the band hop, not the GT-2 chunk delta. */
  const FLAT_CHUNK = { logical: 0, length: 2 ** 40, deviceOffset: 0, stripes: [0], type: 'DATA|single' }

  it('reads the LV as two linear segments on two different arrays', () => {
    assert.equal(TWO_BAND.length, 2)
    assert.deepEqual(TWO_BAND[0], { startSector: 0, lengthSectors: 811008, major: 9, minor: 127, offsetSector: 2048 })
    assert.deepEqual(TWO_BAND[1], { startSector: 811008, lengthSectors: 802816, major: 9, minor: 126, offsetSector: 2048 })
    // The two bands really do differ — which is why one geometry cannot serve both.
    assert.equal(BAND1.chunkBytes, 65536)
    assert.equal(BAND2.chunkBytes, 524288)
    assert.deepEqual(BAND1.dataOffsets, [1048576, 1048576, 1048576])
    assert.deepEqual(BAND2.dataOffsets, [2097152, 2097152, 2097152])
    assert.notDeepEqual(BAND1.members, BAND2.members)
  })

  it('places a byte in the SECOND band with the second band\'s geometry, array and members', () => {
    const lvByte = 811008 * 512 + 1048576
    const located = locateLogicalIn(lvByte, FLAT_CHUNK, BANDS_2)
    assert.equal(located.geometry.device, '/dev/md126', 'the block is on band 2\'s array')
    assert.equal(located.mdByte, 2097152)
    assert.equal(located.stripe, 2)
    assert.equal(located.memberIndex, 1)
    assert.equal(located.memberDevice, BAND2.members[1])
    assert.equal(located.memberOffset, 2097152 + 2 * 524288)
  })

  it('is a DIFFERENT member and a different disk than band 1\'s geometry would have said', () => {
    const lvByte = 811008 * 512 + 1048576
    const right = locateLogicalIn(lvByte, FLAT_CHUNK, BANDS_2)
    // What the pre-R1 engine did: the first segment's geometry for every byte.
    const wrong = locateLogicalIn(lvByte, FLAT_CHUNK, [selfhealBand(TWO_BAND[1], BAND1)])
    assert.notEqual(right.memberDevice, wrong.memberDevice)
    assert.notEqual(right.memberOffset, wrong.memberOffset)
    assert.notEqual(right.geometry.device, wrong.geometry.device)
  })

  it('keeps a byte in the first band on the first band', () => {
    const located = locateLogicalIn(65536, FLAT_CHUNK, BANDS_2)
    assert.equal(located.geometry.device, '/dev/md127')
    assert.equal(located.memberDevice, BAND1.members[located.memberIndex])
  })

  it('refuses an LV byte past the last segment rather than extrapolating', () => {
    assert.throws(() => locateLogicalIn((811008 + 802816) * 512, FLAT_CHUNK, BANDS_2), /no dm linear segment/)
  })
})

describe('selfheal mapping — chunk tree (GT-2)', () => {
  const chunks = parseChunkItems(CHUNK_TREE)

  it('reads every chunk with its own device delta', () => {
    const data = chunks.filter(c => /\bDATA\b/.test(c.type))
    assert.equal(data.length, 2)
    assert.deepEqual(data[0], { logical: 13631488, length: 8388608, deviceOffset: 13631488, stripes: [13631488], type: 'DATA|single' })
    assert.deepEqual(data[1], { logical: 82378752, length: 117440512, deviceOffset: 142737408, stripes: [142737408], type: 'DATA|single' })
  })

  it('selects the chunk COVERING the byte — the second one has delta 60,358,656', () => {
    assert.equal(logicalToLvByte(chunks, 14860288, true).lvByte, 14860288)
    assert.equal(logicalToLvByte(chunks, 82378752, true).lvByte, 142737408)
    assert.equal(82378752 - 142737408, -60358656)
  })

  it('finds metadata chunks too — the csum leaf hop needs them', () => {
    const metadata = chunkForLogical(chunks, 30867456)
    assert.equal(metadata.type, 'METADATA|DUP')
    assert.equal(metadata.deviceOffset, 38797312)
  })

  it('refuses a logical byte no DATA chunk covers', () => {
    assert.throws(() => chunkForLogical(chunks, 1, true), /no DATA chunk covers/)
  })
})

describe('selfheal mapping — extent items', () => {
  it('reads the uncompressed extent of f1.bin (inode 257)', () => {
    const extents = parseExtentItems(SUBVOL_TREE, 257)
    assert.equal(extents.length, 1)
    assert.deepEqual(extents[0], {
      fileOffset: 0,
      diskByte: 13631488,
      diskLength: 8388608,
      extentDataOffset: 0,
      length: 8388608,
      ram: 8388608,
      compression: 'none',
      type: 'regular',
    })
  })

  it('reads f3.bin as 32 zstd extents, each a single 4 KiB on-disk block', () => {
    const extents = parseExtentItems(SUBVOL_TREE, 258)
    assert.equal(extents.length, 32)
    assert.ok(extents.every(e => e.compression === 'zstd' && e.diskLength === 4096 && e.ram === 131072))
    assert.equal(extents[0].diskByte, 82378752)
    assert.equal(extents[9].fileOffset, 9 * 131072)
    assert.equal(extents[9].diskByte, 82378752 + 9 * 4096)
  })

  it('never lets one inode inherit the next inode\'s extents', () => {
    assert.equal(parseExtentItems(SUBVOL_TREE, 999).length, 0)
  })

  it('the repair unit is the block when uncompressed and the whole blob when not', () => {
    const plain = parseExtentItems(SUBVOL_TREE, 257)[0]
    assert.deepEqual(repairUnitFor(plain, 300), {
      compressed: false,
      blobLogical: 13631488 + 300 * 4096,
      blobSectors: 1,
      logicalByte: 13631488 + 300 * 4096,
    })
    const zstd = extentForFileOffset(parseExtentItems(SUBVOL_TREE, 258), 300 * 4096)
    const unit = repairUnitFor(zstd, 300)
    assert.equal(unit.compressed, true)
    assert.equal(unit.blobLogical, 82415616)
    assert.equal(unit.blobSectors, 1)
  })
})

/**
 * R2 — the `extent data offset` field, and the CoW split that makes it
 * non-zero. Fixtures captured from a live rig (see PROVENANCE.md, "Split-extent
 * fixtures"): an 8 MiB file with 4 KiB overwritten 1 MiB in. `split-expected
 * .json` carries what the NODE computed — the stored csum read off the device
 * and the crc32c of the file's own block 300.
 */
describe('selfheal mapping — a CoW-split extent', () => {
  const SPLIT_TREE = fixture('split-dump-tree-subvol.txt')
  const EXPECTED_SPLIT = JSON.parse(fixture('split-expected.json')) as {
    inode: number
    block: number
    logical_byte: number
    logical_byte_without_extent_data_offset: number
    stored_csum: string
    stored_csum_at_wrong_logical: string
    crc32c_of_block: string
    extent_data_offset: number
  }
  const SPLIT_BLOCK = Buffer.from(fixture('split-block-300.b64').trim(), 'base64')

  it('parses the three items the split left, with their extent data offsets', () => {
    const items = parseExtentItems(SPLIT_TREE, EXPECTED_SPLIT.inode)
    assert.equal(items.length, 3)
    assert.deepEqual(items.map(e => [e.fileOffset, e.extentDataOffset, e.length]), [
      [0, 0, 1048576],
      [1048576, 0, 4096],
      // The tail of the ORIGINAL extent: same disk byte as the first item,
      // starting a megabyte into it.
      [1052672, 1052672, 7335936],
    ])
    assert.equal(items[0].diskByte, items[2].diskByte)
  })

  it('maps block 300 through the extent data offset — the csum tree says which answer is right', () => {
    const extent = extentForFileOffset(parseExtentItems(SPLIT_TREE, EXPECTED_SPLIT.inode), EXPECTED_SPLIT.block * 4096)
    assert.equal(extent.extentDataOffset, EXPECTED_SPLIT.extent_data_offset)
    const unit = repairUnitFor(extent, EXPECTED_SPLIT.block)
    assert.equal(unit.logicalByte, EXPECTED_SPLIT.logical_byte)
    assert.equal(unit.blobLogical, EXPECTED_SPLIT.logical_byte)
    // The pre-R2 arithmetic — disk byte + (file offset − item offset) — lands a
    // megabyte short, on a logical byte whose stored csum belongs to a
    // different block entirely.
    assert.notEqual(unit.logicalByte, EXPECTED_SPLIT.logical_byte_without_extent_data_offset)
    assert.notEqual(EXPECTED_SPLIT.stored_csum, EXPECTED_SPLIT.stored_csum_at_wrong_logical)
    assert.equal(csumHex(crc32c(SPLIT_BLOCK)), EXPECTED_SPLIT.stored_csum)
  })

  it('refuses a block the item does not cover instead of mapping it anyway', () => {
    const [first] = parseExtentItems(SPLIT_TREE, EXPECTED_SPLIT.inode)
    // Block 300 is past the first item's 1 MiB — the item stops at block 256.
    assert.throws(() => repairUnitFor(first, 300), /outside the extent at file offset 0/)
  })
})

describe('selfheal mapping — md placement', () => {
  it('places a RAID5 md byte on the left-symmetric data disk of its stripe', () => {
    const placed = placeMdByte(16171008, RAID5)
    assert.equal(placed.memberIndex, 0)
    assert.equal(placed.memberOffset, 4308992)
    assert.equal(placed.stripe, 49)
    assert.equal(placed.parityIndex, 4)
    assert.equal(placed.qIndex, null)
  })

  it('places a RAID6 md byte past Q, and names both parity members', () => {
    const placed = placeMdByte(16171008, RAID6)
    assert.equal(placed.stripe, 49)
    assert.equal(placed.parityIndex, 6)
    assert.equal(placed.qIndex, 0)
    assert.equal(placed.dataIndex, 1)
    assert.equal(placed.memberIndex, 2)
  })

  it('orders a RAID6 stripe\'s data disks the way md numbers its Q coefficients', () => {
    assert.deepEqual(stripeDataOrder(RAID6, 49), [1, 2, 3, 4, 5])
    assert.deepEqual(stripeDataOrder(RAID6, 58), [6, 0, 1, 2, 3])
    assert.deepEqual(stripeDataOrder(RAID5, 49), [5, 0, 1, 2, 3])
  })

  it('puts a RAID1 block at the same offset on every leg, with no stripe', () => {
    const placed = placeMdByte(65536, RAID1)
    assert.equal(placed.memberOffset, 1048576 + 65536)
    assert.equal(placed.stripe, null)
    assert.equal(placed.parityIndex, null)
    assert.deepEqual(placed.mirrors, [0, 1])
  })

  /**
   * R4 — every member has its own `rd<n>/offset`, and md does not require them
   * equal. The mirror paths used to read every leg at the FIRST leg's offset.
   */
  it('puts the same bytes at each member\'s OWN data offset, on both level kinds', () => {
    const skewed = { ...RAID1, dataOffsets: [1048576, 4194304] }
    const placed = placeMdByte(65536, skewed)
    const location = { ...placed, logical: 0, lvByte: 0, geometry: skewed, startSector: 0, chunkLogical: 0, chunkDevice: 0 }
    assert.equal(memberOffsetOn(skewed, location, 0), 1048576 + 65536)
    assert.equal(memberOffsetOn(skewed, location, 1), 4194304 + 65536, 'leg 1 reads at ITS offset')

    // The parity path already did this; it now goes through the same helper.
    const parity = { ...RAID5, dataOffsets: [1048576, 1048576, 1048576, 1048576, 1048576, 2097152] }
    const target = placeMdByte(16171008, parity)
    const row = { ...target, logical: 0, lvByte: 0, geometry: parity, startSector: 0, chunkLogical: 0, chunkDevice: 0 }
    assert.equal(memberOffsetOn(parity, row, 0), 4308992)
    assert.equal(memberOffsetOn(parity, row, 5), 4308992 + 1048576)
  })

  it('REFUSES a layout it does not map rather than guessing', () => {
    const asymmetric = { ...RAID5, layout: 'left-asymmetric' }
    assert.throws(() => placeMdByte(16171008, asymmetric), SelfhealMapError)
    assert.throws(() => placeMdByte(16171008, asymmetric), /left-symmetric only/)
  })

  it('REFUSES to place a block on a member the array does not have', () => {
    const degraded = { ...RAID5, members: [null, ...RAID5.members.slice(1)] }
    assert.throws(() => placeMdByte(16171008, degraded), /missing from the array/)
  })
})

describe('selfheal mapping — the whole chain', () => {
  for (const expected of EXPECTED) {
    it(`resolves ${expected.file} block ${expected.block} exactly as the suite's own mapper does`, () => {
      const chunk = chunkForLogical(CHUNKS, expected.target_logical, true)
      const located = locateLogicalIn(expected.target_logical, chunk, BANDS)
      assert.equal(located.chunkLogical, expected.chunk_logical)
      assert.equal(located.chunkDevice, expected.chunk_device)
      assert.equal(located.lvByte, expected.lv_byte)
      assert.equal(located.startSector, expected.start_sector)
      assert.equal(located.mdByte, expected.md_byte)
      assert.equal(located.memberIndex, expected.disk)
      assert.equal(located.memberOffset, expected.moff)
      assert.equal(located.stripe, expected.stripe)
      assert.equal(located.parityIndex, expected.parity_disk)
    })
  }

  it('derives the block\'s repair unit and its logical byte from the tree, not from filefrag', () => {
    for (const expected of EXPECTED) {
      const inode = expected.file === 'f1.bin' ? 257 : 258
      const extent = extentForFileOffset(parseExtentItems(SUBVOL_TREE, inode), expected.block * 4096)
      const unit = repairUnitFor(extent, expected.block)
      assert.equal(unit.compressed, expected.compressed)
      // `target_logical` is the suite's name for the start of the repair unit:
      // the block itself when uncompressed, the compressed blob when not.
      assert.equal(unit.blobLogical, expected.target_logical, `${expected.file} ${expected.block}`)
      assert.equal(unit.logicalByte, expected.logical_byte)
    }
  })
})

/**
 * selfheal.8 — tracing a DEVICE logical byte back to the extent that owns it.
 * Everything below is fed the verbatim capture of a live rig with a compressed
 * file whose second extent's blob was corrupted and scrubbed (see
 * fixtures/selfheal/PROVENANCE.md, "Compressed-extent attribution fixtures").
 */
describe('selfheal mapping — the extent tree (selfheal.8)', () => {
  const EXTENT_TREE = fixture('dump-tree-extent.txt')

  it('parses the EXTENT_ITEMs with their data backrefs, and nothing else', () => {
    const items = parseExtentTreeItems(EXTENT_TREE)
    // 16 data extents of the rig's one file; the BLOCK_GROUP_ITEM and the
    // metadata TREE_BLOCK items sharing the tree create no item.
    assert.equal(items.length, 16)
    assert.deepEqual(items[1], {
      logical: 13635584,
      length: 4096,
      backrefs: [{ root: 256, objectid: 257, offset: 131072, count: 1 }],
    })
    assert.ok(items.every(i => i.backrefs.length === 1))
    // The backref offset is the extent's REAL file offset — the number the
    // kernel's scrub warning does not carry for a compressed extent.
    assert.deepEqual(items.map(i => i.backrefs[0].offset), Array.from({ length: 16 }, (_, k) => k * 131072))
  })

  /** The captured rig's mapping context — trees only; the md half is unused here. */
  function compressedRigContext(): Parameters<typeof extentsForStripe>[1] {
    const roots = parseTreeRoots(fixture('dump-tree-roots-compressed.txt'))
    return {
      mountpoint: '/mnt/sh8',
      srcDevice: '/dev/loop0',
      bands: [],
      roots,
      chunks: [],
      csums: [],
    }
  }

  function treeExecutor(): MockExecutor {
    const executor = new MockExecutor()
    const roots = parseTreeRoots(fixture('dump-tree-roots-compressed.txt'))
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.extent), '/dev/loop0'],
      result: { stdout: EXTENT_TREE, stderr: '', exitCode: 0 },
    })
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.bySubvolume.get(256)), '/dev/loop0'],
      result: { stdout: fixture('dump-tree-subvol-compressed.txt'), stderr: '', exitCode: 0 },
    })
    return executor
  }

  it('resolves the extents owning the named stripe, with their real file ranges', async () => {
    const executor = treeExecutor()
    const extents = await extentsForStripe(executor, compressedRigContext(), 256, 257, 13631488)
    // All 16 of the file's zstd blobs live inside that one 64 KiB stripe.
    assert.equal(extents.length, 16)
    assert.ok(extents.every(e => e.compression === 'zstd' && e.length === 131072 && e.diskLength === 4096))
    assert.deepEqual(extents.map(e => e.fileOffset), Array.from({ length: 16 }, (_, k) => k * 131072))
    // The extent whose blob sits 4 KiB into the stripe — the corrupt one in
    // the capture — resolves to file bytes 131072..262143, NOT to what the
    // kernel's `offset 0` would have pointed at.
    const corrupt = extentForFileOffset(extents, 131072)
    assert.equal(corrupt.diskByte, 13635584)
    // Two walks for the extent tree (stripe start and stripe end land in the
    // same leaf) plus one per owning file offset.
    assert.equal(executor.calls.length, 2 + 16)
  })

  /**
   * R2's other half: an `extent data backref` offset is `file_offset −
   * extent_data_offset`, not a file offset. On the split rig the 8 MiB extent
   * has ONE backref (`offset 0 count 2`) and TWO owning items — file offsets 0
   * and 1,052,672. Reading the backref as a file offset finds the first and
   * misses the second, which is the half of the file a repair would be told
   * nothing about.
   */
  it('resolves EVERY item that references an extent, not just the one at the backref offset', async () => {
    const roots = parseTreeRoots(fixture('split-dump-tree-roots.txt'))
    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.extent), '/dev/loop0'],
      result: { stdout: fixture('split-dump-tree-extent.txt'), stderr: '', exitCode: 0 },
    })
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.bySubvolume.get(256)), '/dev/loop0'],
      result: { stdout: fixture('split-dump-tree-subvol.txt'), stderr: '', exitCode: 0 },
    })
    const ctx = { mountpoint: '/mnt/split', srcDevice: '/dev/loop0', bands: [], roots, chunks: [], csums: [] }
    const extents = await extentsForStripe(executor, ctx, 256, 257, 13631488)
    assert.deepEqual(extents.map(e => e.fileOffset), [0, 1052672])
    assert.deepEqual(extents.map(e => e.extentDataOffset), [0, 1052672])
    assert.ok(extents.every(e => e.diskByte === 13631488))
  })

  /**
   * F7 (second pass): the forward scan has to CROSS an fs-tree leaf.
   *
   * `findLeaf` descends to the leaf holding the greatest key ≤ its target, so a
   * re-descent with `last + 1` landed in the SAME leaf and the loop exited on
   * its second iteration — `MAX_OWNER_LEAVES` never did anything. The capture
   * is a 32 MiB extent cut into 121 surviving pieces by 120 CoW overwrites, in
   * a real level-1 subvolume tree whose two leaves hold 49 and 72 of them
   * (PROVENANCE.md, "Leaf-crossing backref fixtures").
   */
  it('follows one extent\'s owning items ACROSS an fs-tree leaf boundary', async () => {
    const roots = parseTreeRoots(fixture('leafspan-dump-tree-roots.txt'))
    const executor = new MockExecutor()
    for (const block of [30916608, 30949376, 30965760, 30867456]) {
      executor.addFixture({
        command: '/usr/bin/btrfs',
        args: ['inspect-internal', 'dump-tree', '-b', String(block), '/dev/loop0'],
        result: { stdout: fixture(`leafspan-node-${block}.txt`), stderr: '', exitCode: 0 },
      })
    }
    const ctx = { mountpoint: '/mnt/leafspan', srcDevice: '/dev/loop0', bands: [], roots, chunks: [], csums: [] }

    // The 64 KiB stripe at the extent's own start. Its one owner in the extent
    // tree is `84082688 EXTENT_ITEM 33554432`, carrying a single data backref:
    // `root 256 objectid 257 offset 0 count 121`.
    const extents = await extentsForStripe(executor, ctx, 256, 257, 84082688)
    assert.equal(extents.length, 121, 'every piece of the extent, not just the first leaf\'s 49')
    assert.ok(extents.every(e => e.diskByte === 84082688))
    // The first leaf's last piece starts at 6,295,552; the 72 pieces past it
    // are what a scan that cannot cross a leaf never sees.
    assert.equal(extents.filter(e => e.fileOffset > 6295552).length, 72)
    assert.equal(extents[0].fileOffset, 0)
    assert.equal(Math.max(...extents.map(e => e.fileOffset)), 15732736)
  })

  /**
   * T6 (third pass) — exhausting `MAX_OWNER_LEAVES` used to return silently,
   * and a truncated scan's result is byte-for-byte what "there were no more
   * owning items" returns. Attribution would then name a PREFIX of the file's
   * extents as if it were all of them, and a repair offered on that prefix
   * reads as a repair of the file.
   *
   * SYNTHETIC tree (not a capture): a level-1 fs tree whose five leaves each
   * hold two EXTENT_DATA items of inode 257 pointing at the same 32 MiB
   * extent, none of them past the learned `ref.offset + ram` limit — so the
   * only thing that can stop the scan is the cap.
   */
  it('refuses a truncated owner scan rather than returning the prefix it reached', async () => {
    const LEAVES = 5
    const EXTENT = 13631488
    const RAM = 33554432
    const leafBlock = (n: number): number => 40000 + n * 16
    /** Two owning items per leaf, at ascending file offsets well under RAM. */
    const leaf = (n: number): string => [
      'btrfs-progs v6.14',
      `leaf ${leafBlock(n)} items 2 free space 100 generation 11 owner 256`,
      ...[0, 1].flatMap((k) => {
        const fileOffset = (n * 2 + k) * 131072
        return [
          `\titem ${k} key (257 EXTENT_DATA ${fileOffset}) itemoff 16230 itemsize 53`,
          '\t\tgeneration 11 type 1 (regular)',
          `\t\textent data disk byte ${EXTENT} nr ${RAM}`,
          `\t\textent data offset ${fileOffset} nr 131072 ram ${RAM}`,
          '\t\textent compression 0 (none)',
        ]
      }),
      '',
    ].join('\n')
    const node = [
      'btrfs-progs v6.14',
      `node 30000 level 1 items ${LEAVES} generation 11 owner 256`,
      ...Array.from({ length: LEAVES }, (_, n) => `\tkey (257 EXTENT_DATA ${n * 262144}) block ${leafBlock(n)} gen 11`),
      '',
    ].join('\n')
    const extentLeaf = [
      'btrfs-progs v6.14',
      'leaf 20000 items 1 free space 100 generation 11 owner EXTENT_TREE',
      `\titem 0 key (${EXTENT} EXTENT_ITEM ${RAM}) itemoff 16230 itemsize 53`,
      `\t\trefs ${LEAVES * 2} gen 11 flags DATA`,
      `\t\t(178 0xdea30de73813529) extent data backref root 256 objectid 257 offset 0 count ${LEAVES * 2}`,
      '',
    ].join('\n')

    const executor = new MockExecutor()
    const block = (bytenr: number, text: string): void => {
      executor.addFixture({
        command: '/usr/bin/btrfs',
        args: ['inspect-internal', 'dump-tree', '-b', String(bytenr), '/dev/loop0'],
        result: { stdout: text, stderr: '', exitCode: 0 },
      })
    }
    block(20000, extentLeaf)
    block(30000, node)
    for (let n = 0; n < LEAVES; n++)
      block(leafBlock(n), leaf(n))

    const ctx = {
      mountpoint: '/mnt/cap',
      srcDevice: '/dev/loop0',
      bands: [],
      roots: { chunk: 1, csum: 2, extent: 20000, bySubvolume: new Map([[256, 30000]]) },
      chunks: [],
      csums: [],
    }
    assert.equal(MAX_OWNER_LEAVES, 4, 'the cap this case is built to outrun')
    await assert.rejects(
      extentsForStripe(executor, ctx, 256, 257, EXTENT),
      // Seventh pass, F3: the reason code rides too — a truncated scan is a
      // block NOBODY LOOKED AT, and saying which kind is the whole point.
      (err: unknown) => err instanceof SelfhealMapError
        && /owner scan truncated at 4 leaves/.test(err.message)
        && err.reasonCode === 'owner-scan-truncated',
      'the scan refuses instead of handing back the 8 items its 4 leaves held',
    )
  })

  /**
   * Fourth pass — the other half of the cap: a leaf holding NONE of the
   * inode's items used to end the scan only when something had already been
   * found (`found.length > 0`). A file truncated or rewritten since the scrub
   * holds none of its old EXTENT_DATA items anywhere, so the scan walked all
   * four leaves and threw "owner scan truncated" over what is a real end —
   * the honest "no extent of this file covers the reported stripe" the
   * attribution turns into an `unidentified` reason.
   *
   * SYNTHETIC tree (not a capture): a level-1 fs tree of five leaves, every
   * item in them belonging to a DIFFERENT inode (258) — for inode 257 the
   * scan is empty everywhere, and the cap is reachable only if emptiness does
   * not end the walk.
   */
  it('a scan whose leaves hold none of the inode\'s items returns [] — it does not refuse', async () => {
    const EXTENT = 13631488
    const RAM = 33554432
    const leafBlock = (n: number): number => 40000 + n * 16
    /** Two items per leaf, all of them inode 258's — none of them 257's. */
    const leaf = (n: number): string => [
      'btrfs-progs v6.14',
      `leaf ${leafBlock(n)} items 2 free space 100 generation 11 owner 256`,
      ...[0, 1].flatMap((k) => {
        const fileOffset = (n * 2 + k) * 131072
        return [
          `\titem ${k} key (258 EXTENT_DATA ${fileOffset}) itemoff 16230 itemsize 53`,
          '\t\tgeneration 11 type 1 (regular)',
          `\t\textent data disk byte ${EXTENT + n} nr ${RAM}`,
          `\t\textent data offset ${fileOffset} nr 131072 ram ${RAM}`,
          '\t\textent compression 0 (none)',
        ]
      }),
      '',
    ].join('\n')
    const node = [
      'btrfs-progs v6.14',
      'node 30000 level 1 items 5 generation 11 owner 256',
      ...Array.from({ length: 5 }, (_, n) => `\tkey (258 EXTENT_DATA ${n * 262144}) block ${leafBlock(n)} gen 11`),
      '',
    ].join('\n')
    const extentLeaf = [
      'btrfs-progs v6.14',
      'leaf 20000 items 1 free space 100 generation 11 owner EXTENT_TREE',
      `\titem 0 key (${EXTENT} EXTENT_ITEM ${RAM}) itemoff 16230 itemsize 53`,
      '\t\trefs 1 gen 11 flags DATA',
      '\t\t(178 0xdea30de73813529) extent data backref root 256 objectid 257 offset 0 count 1',
      '',
    ].join('\n')

    const executor = new MockExecutor()
    const block = (bytenr: number, text: string): void => {
      executor.addFixture({
        command: '/usr/bin/btrfs',
        args: ['inspect-internal', 'dump-tree', '-b', String(bytenr), '/dev/loop0'],
        result: { stdout: text, stderr: '', exitCode: 0 },
      })
    }
    block(20000, extentLeaf)
    block(30000, node)
    for (let n = 0; n < 5; n++)
      block(leafBlock(n), leaf(n))

    const ctx = {
      mountpoint: '/mnt/empty',
      srcDevice: '/dev/loop0',
      bands: [],
      roots: { chunk: 1, csum: 2, extent: 20000, bySubvolume: new Map([[256, 30000]]) },
      chunks: [],
      csums: [],
    }
    assert.deepEqual(
      await extentsForStripe(executor, ctx, 256, 257, EXTENT),
      [],
      'an empty owner scan is a complete answer here, not a truncation',
    )
    // …and the walk ENDED: the first leaf's emptiness is ambiguous (the
    // descent can land a leaf short of the search key), but the second leaf's
    // is not — only the node and the first TWO leaves were read, not all four
    // of the cap.
    const fsBlocks = executor.calls
      .filter(c => c.command === '/usr/bin/btrfs' && Number(c.args[3]) >= 30000)
      .map(c => Number(c.args[3]))
    assert.deepEqual(fsBlocks, [30000, 40000, 40016], `the scan stopped at the second leaf (${fsBlocks.join(', ')})`)
  })

  it('names no extent where this file owns none — and refuses a foreign subvolume', async () => {
    const executor = treeExecutor()
    const ctx = compressedRigContext()
    assert.deepEqual(
      await extentsForStripe(executor, ctx, 256, 257, 97533952),
      [],
      'the metadata region at the top of the address space is nobody\'s data extent',
    )
    await assert.rejects(
      extentsForStripe(executor, ctx, 999, 257, 13631488),
      SelfhealMapError,
    )
  })
})

/**
 * Seventh pass, F3 — a map failure is a block NOBODY LOOKED AT, and WHICH
 * failure it was is the only thing that says what a re-scrub would need.
 *
 * Every one of these used to become the `mapping-abort` bucket, whose sentence
 * asserts the bytes at the mapped location still pass their stored checksum.
 * (`inline-extent` and `hole` are proved at the engine level, in
 * selfheal-repair.test.ts, because that is where the whole verdict is decided.)
 */
describe('selfheal mapping — every map failure carries its reason (F3)', () => {
  it('a band with no readable geometry is `band-unreadable`, naming the band', () => {
    const blind = SEGMENTS.map(segment => ({ segment, device: '/dev/md127', geometry: null, error: 'sysfs went away' }))
    assert.throws(
      () => locateLogicalIn(CHUNKS[0].logical, CHUNKS[0], blind),
      (error: unknown) => {
        assert.ok(error instanceof SelfhealMapError)
        assert.equal(error.reasonCode, 'band-unreadable')
        assert.match(error.message, /sysfs went away/)
        return true
      },
    )
  })

  it('anything else is `unresolvable` — the honest default, never a guess', () => {
    assert.throws(
      () => chunkForLogical(CHUNKS, 1 << 40),
      (error: unknown) => {
        assert.ok(error instanceof SelfhealMapError)
        assert.equal(error.reasonCode, 'unresolvable')
        return true
      },
    )
    assert.throws(
      () => segmentForLvByte(SEGMENTS, Number.MAX_SAFE_INTEGER),
      (error: unknown) => {
        assert.ok(error instanceof SelfhealMapError)
        assert.equal(error.reasonCode, 'unresolvable')
        return true
      },
    )
  })
})

/**
 * Seventh pass, F8 — md's bad-block list, read where the topology is built.
 *
 * A recorded range is a span md returned a URE on during a rebuild and never
 * reconstructed. Until this pass nothing in the daemon read the file at all:
 * the packaging hook counted the ranges once, at `RebuildFinished`, and every
 * repair and rewrite gate was blind to it.
 */
describe('selfheal mapping — md bad blocks (F8)', () => {
  it('parses one range per line, ignoring anything that is not two numbers', () => {
    assert.deepEqual(parseBadBlocks('6368 8\n1048576 16\n\n'), [
      { startSector: 6368, lengthSectors: 8 },
      { startSector: 1048576, lengthSectors: 16 },
    ])
  })

  it('an EMPTY file is no ranges; an UNREADABLE one is null, which is not the same', () => {
    assert.deepEqual(parseBadBlocks(''), [])
    assert.equal(parseBadBlocks(null), null, 'a member ANAS cannot ask about is not a member it calls clean')
  })

  it('a range is matched in the member\'s OWN data coordinates', () => {
    const geo = { ...RAID5, badBlocks: RAID5.members.map((_, role) => (role === 1 ? [{ startSector: 6368, lengthSectors: 8 }] : [])) }
    // 1048576 is rd1's data offset, so sector 6368 of the data area is here:
    const covered = 1048576 + 6368 * 512
    assert.equal(memberHasBadBlock(geo, 1, covered), true)
    assert.equal(memberHasBadBlock(geo, 1, covered + 4096), false, 'the next block is outside the range')
    assert.equal(memberHasBadBlock(geo, 0, covered), false, 'the range belongs to role 1 alone')
  })

  it('cr3 AHR-HEAL-L9: an unreadable list answers NULL — unknown, never clean — and the band names the members it could not ask', () => {
    const geo = { ...RAID5, badBlocks: RAID5.members.map(() => null) }
    assert.equal(memberHasBadBlock(geo, 1, 1048576), null)
    assert.deepEqual(bandBadBlocks(geo), [], 'no member carries a KNOWN range')
    assert.deepEqual(bandBadBlocksUnknown(geo).map(c => c.device), RAID5.members, 'every present member is unknown')
    assert.match(badBlocksUnknownRefusal(geo), /could not be read/)
    // An ABSENT role has nothing to read: the degraded gates answer for it.
    const degraded = { ...geo, members: RAID5.members.map((m, role) => (role === 2 ? null : m)) }
    assert.ok(!bandBadBlocksUnknown(degraded).some(c => c.role === 2))
  })

  it('bandBadBlocks names the members that carry ranges, with their devices', () => {
    const geo = { ...RAID5, badBlocks: RAID5.members.map((_, role) => (role === 3 ? [{ startSector: 0, lengthSectors: 8 }] : [])) }
    assert.deepEqual(bandBadBlocks(geo), [{ role: 3, device: '/dev/loop3', ranges: [{ startSector: 0, lengthSectors: 8 }] }])
  })

  it('geometryFromAttributes reads them off rd<n>/bad_blocks — the kernel\'s symlink to dev-<name>', () => {
    const attributes = { ...sysfsAttributes('md-sysfs-raid5.txt'), 'rd2/bad_blocks': '40 8\n' }
    const geo = geometryFromAttributes('/dev/md127', 'md127', '/sys/block/md127/md', attributes, parseMdDetailExport(fixture('mdadm-detail-export-raid5.txt'), 6))
    assert.deepEqual(geo.badBlocks[2], [{ startSector: 40, lengthSectors: 8 }])
    assert.equal(geo.badBlocks[0], null, 'an attribute nobody read is unknown, not empty')
  })
})

/**
 * cr3 AHR-HEAL-L8 — an unreadable `rd<n>/offset` is not offset 0.
 */
describe('selfheal mapping — a data offset this node could not read (cr3 AHR-HEAL-L8)', () => {
  const members = parseMdDetailExport(fixture('mdadm-detail-export-raid5.txt'), 6)

  it('a PRESENT member with no readable rd<n>/offset makes the band unreadable — never offset 0', () => {
    const attributes = { ...sysfsAttributes('md-sysfs-raid5.txt'), 'rd3/offset': null }
    assert.throws(
      () => geometryFromAttributes('/dev/md127', 'md127', '/sys/block/md127/md', attributes, members),
      (error: unknown) => error instanceof SelfhealMapError && error.reasonCode === 'band-unreadable' && /rd3\/offset/.test(error.message),
    )
  })

  it('a value that is not a sector count is not read as one either', () => {
    const attributes = { ...sysfsAttributes('md-sysfs-raid5.txt'), 'rd1/offset': 'garbage' }
    assert.throws(() => geometryFromAttributes('/dev/md127', 'md127', '/sys/block/md127/md', attributes, members), SelfhealMapError)
  })

  it('an ABSENT role has no offset at all: NaN, which no read can be placed at', () => {
    const attributes = { ...sysfsAttributes('md-sysfs-raid5.txt'), 'rd2/offset': null }
    const holed = members.map((m, role) => (role === 2 ? null : m))
    const geo = geometryFromAttributes('/dev/md127', 'md127', '/sys/block/md127/md', attributes, holed)
    assert.ok(Number.isNaN(geo.dataOffsets[2]))
    assert.equal(geo.dataOffsets[0], 2048 * 512, 'the members that are there keep their own offsets')
  })
})

/**
 * cr3 AHR-HEAL-M5 — WHICH COORDINATES `rd<n>/bad_blocks` prints in is not
 * settled: the engine has always read the ranges as data-relative, and the
 * review's reading of md is that they are absolute member sectors. Nothing is
 * changed on a recollection. The capture below settles it; until it exists the
 * case is skipped, and once it does it is RED against the wrong value of
 * `MD_BAD_BLOCKS_COORDINATES` and GREEN against the right one.
 *
 * The capture (stunt node, a two-leg RAID1 LOOP rig, metadata 1.2 — never a
 * pool), written as `fixtures/selfheal/md-bad-blocks-coordinates.txt`:
 *
 *   D=$(cat /sys/block/mdX/md/rd0/offset)          # data offset, sectors
 *   S=$((D + 4096))                                # a range well inside the data area
 *   echo "$S 8" > /sys/block/mdX/md/rd0/bad_blocks
 *   SHOWN=$(cat /sys/block/mdX/md/rd0/bad_blocks)
 *   mdadm /dev/mdX --fail <leg 1>                  # leg 0 is now md's only source
 *   dd if=/dev/mdX of=/dev/null bs=4096 count=1 iflag=direct skip=$(( (S - D) / 8 )); A=$?
 *   dd if=/dev/mdX of=/dev/null bs=4096 count=1 iflag=direct skip=$(( S / 8 )); B=$?
 *
 * and the file holds, one per line: `DATA_OFFSET_SECTORS=<D>`,
 * `SHOWN=<the line bad_blocks printed>`, `EIO_MD_SECTOR=<S-D if A failed,
 * else S>`, `OK_MD_SECTOR=<the other one>`. md byte = md sector × 512 on RAID1,
 * and leg 0 holds md sector s at member sector D + s.
 */
describe('selfheal mapping — md bad-block coordinates, the capture decides (cr3 AHR-HEAL-M5)', () => {
  const CAPTURE = 'md-bad-blocks-coordinates.txt'
  let capture: Record<string, string> | null = null
  try {
    capture = Object.fromEntries(fixture(CAPTURE).split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  }
  catch {
    capture = null
  }

  it('the captured EIO row is the row the engine treats as bad-blocked', { skip: capture === null ? `awaiting the live capture fixtures/selfheal/${CAPTURE} (cr3 AHR-HEAL-M5; MD_BAD_BLOCKS_COORDINATES is '${MD_BAD_BLOCKS_COORDINATES}' until then)` : false }, () => {
    const c = capture as Record<string, string>
    const d = Number(c.DATA_OFFSET_SECTORS) * 512
    const geo = { ...RAID1, dataOffsets: [d, d], badBlocks: [parseBadBlocks(c.SHOWN), []] }
    const memberByte = (mdSector: number): number => d + mdSector * 512
    assert.equal(memberHasBadBlock(geo, 0, memberByte(Number(c.EIO_MD_SECTOR))), true, 'md refused this row: the engine must see the range over it')
    assert.equal(memberHasBadBlock(geo, 0, memberByte(Number(c.OK_MD_SECTOR))), false, 'md served this row: the engine must not refuse it')
  })

  it('the two readings differ by exactly the member\'s data offset — the probe\'s own arithmetic', () => {
    // review probe-geometry part 2: a range recorded at absolute member sector
    // A covers the row at member byte A×512 under `absolute`, and the row one
    // whole data offset further in under `data-relative`.
    const offset = RAID1.dataOffsets[0]
    const absoluteSector = offset / 512 + 4096
    const geo = { ...RAID1, badBlocks: [[{ startSector: absoluteSector, lengthSectors: 8 }], []] }
    assert.equal(memberHasBadBlock(geo, 0, absoluteSector * 512, BLOCK_BYTES, 'absolute'), true)
    assert.equal(memberHasBadBlock(geo, 0, absoluteSector * 512, BLOCK_BYTES, 'data-relative'), false)
    assert.equal(memberHasBadBlock(geo, 0, absoluteSector * 512 + offset, BLOCK_BYTES, 'data-relative'), true)
  })
})
