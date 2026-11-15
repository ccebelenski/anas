import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parseTreeRoots } from '../selfheal-btree.js'
import {
  crc32c,
  csumFromLeafBytes,
  csumHex,
  CsumUnreadableError,
  findCsumEntry,
  LEAF_HEADER_BYTES,
  NODE_BYTES,
  parseCsumItems,
  readStoredCsum,
  verifyNode,
} from '../selfheal-csum.js'
import { parseChunkItems, parseDmTable, selfhealBand } from '../selfheal-map.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

const CSUM_TREE = fixture('dump-tree-csum.txt')
const ITEMS = parseCsumItems(CSUM_TREE)

/** f1.bin block 300 as it actually sits on its member disk (PROVENANCE.md). */
const MEMBER_BLOCK = Buffer.from(fixture('member-block-f1-300.b64').trim(), 'base64')
const STORED_CSUM = Number(fixture('member-block-f1-300.csum').trim())

/**
 * Make a synthetic 16 KiB node vouch for itself the way btrfs does — its own
 * bytenr at header offset 48, and the crc32c of bytes 32…nodesize in the low
 * four bytes of the csum field, little-endian.
 *
 * Before D3 the reader believed any four bytes it found; these fixtures were
 * built as bare `Buffer.alloc` with a csum written into one slot and passed.
 * They now have to be real nodes, which is the point: the check is what stops
 * rot in the csum tree being reported as rot in the file.
 */
function sealNode(node: Buffer, bytenr: number): Buffer {
  node.writeBigUInt64LE(BigInt(bytenr), 48)
  node.writeUInt32LE(crc32c(node.subarray(32, NODE_BYTES)), 0)
  return node
}

/**
 * The csum half of the engine (selfheal.5): btrfs's own stored checksum, and
 * the crc32c that has to reproduce it. Everything here is checked against
 * numbers the FILESYSTEM produced, not against itself.
 */
describe('selfheal csum — crc32c', () => {
  it('matches the published CRC-32C vectors', () => {
    assert.equal(crc32c(Buffer.from('123456789')), 0xE3069283)
    assert.equal(crc32c(Buffer.alloc(0)), 0)
    assert.equal(crc32c(Buffer.from('a')), 0xC1D04330)
    assert.equal(crc32c(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x22620404)
  })

  it('reproduces the csum btrfs stored for a real 4 KiB block', () => {
    assert.equal(MEMBER_BLOCK.length, 4096)
    assert.equal(crc32c(MEMBER_BLOCK), STORED_CSUM)
    assert.equal(csumHex(crc32c(MEMBER_BLOCK)), '0x84453138')
  })

  it('a single flipped bit changes the csum — the whole basis of arbitration', () => {
    const flipped = Buffer.from(MEMBER_BLOCK)
    flipped[2048] ^= 0x01
    assert.notEqual(crc32c(flipped), STORED_CSUM)
  })

  it('renders csums as fixed-width hex', () => {
    assert.equal(csumHex(0), '0x00000000')
    assert.equal(csumHex(0xB894DB02), '0xb894db02')
  })
})

describe('selfheal csum — the csum tree', () => {
  it('reads every EXTENT_CSUM item with the leaf it was printed under', () => {
    assert.equal(ITEMS.length, 11)
    assert.deepEqual(ITEMS[0], { start: 13631488, itemOffset: 8091, itemSize: 8192, leaf: 30834688 })
    assert.ok(ITEMS.every(i => i.leaf === 30834688))
  })

  it('locates a block by the GREATEST item start ≤ its logical byte', () => {
    // f1.bin block 300 — one item covers the whole 8 MiB uncompressed extent.
    const plain = findCsumEntry(ITEMS, 14860288)
    assert.ok(plain)
    assert.equal(plain.item.start, 13631488)
    assert.equal(plain.index, 300)
    assert.equal(plain.leafOffset, LEAF_HEADER_BYTES + 8091 + 300 * 4)
  })

  it('keys a COMPRESSED extent from its own logical start, across item boundaries', () => {
    // f3.bin block 300 lives in the blob at logical 82415616; the item that
    // covers it starts at 82391040 and is NOT the item for the extent's own key.
    const blob = findCsumEntry(ITEMS, 82415616)
    assert.ok(blob)
    assert.equal(blob.item.start, 82391040)
    assert.equal(blob.index, 6)
    assert.equal(blob.leafOffset, LEAF_HEADER_BYTES + 8051 + 6 * 4)
  })

  it('reports NO stored csum rather than the nearest one (NOCOW / prealloc)', () => {
    // Before the first item, and past the end of the last one.
    assert.equal(findCsumEntry(ITEMS, 4096), null)
    assert.equal(findCsumEntry(ITEMS, 82509824), null)
    assert.equal(findCsumEntry([], 13631488), null)
  })

  it('reads the stored value little-endian, from past the leaf header', () => {
    const leaf = Buffer.alloc(16384)
    const entry = findCsumEntry(ITEMS, 14860288)
    assert.ok(entry)
    leaf.writeUInt32LE(0xB894DB02, entry.leafOffset)
    assert.equal(csumFromLeafBytes(leaf, entry), 0xB894DB02)
  })

  it('refuses to read a csum past the bytes it was given', () => {
    const entry = findCsumEntry(ITEMS, 14860288)
    assert.ok(entry)
    assert.throws(() => csumFromLeafBytes(Buffer.alloc(128), entry), /past the 128-byte leaf read/)
  })
})

/**
 * The node self-check (D3), proved against a leaf the FILESYSTEM wrote
 * (`split-csum-leaf.b64`, PROVENANCE.md) rather than against one this test
 * built: nodesize 16384, crc32c over bytes 32…16384, stored little-endian in
 * the first four, and the node's own bytenr at header offset 48.
 */
describe('selfheal csum — a tree node vouching for itself', () => {
  const CAPTURED = Buffer.from(fixture('split-csum-leaf.b64').trim(), 'base64')
  const CAPTURED_BYTENR = 30801920

  it('accepts the captured leaf at its own bytenr', () => {
    const check = verifyNode(CAPTURED.subarray(0, NODE_BYTES), CAPTURED_BYTENR)
    assert.ok(check.ok, check.detail)
  })

  it('refuses it at a bytenr it does not claim — a valid node in the wrong place', () => {
    const check = verifyNode(CAPTURED.subarray(0, NODE_BYTES), CAPTURED_BYTENR + NODE_BYTES)
    assert.equal(check.ok, false)
    assert.match(check.detail, /says it is bytenr 30801920/)
  })

  it('refuses one flipped byte anywhere past the header csum', () => {
    const rotten = Buffer.from(CAPTURED.subarray(0, NODE_BYTES))
    rotten[8000] ^= 0x01
    const check = verifyNode(rotten, CAPTURED_BYTENR)
    assert.equal(check.ok, false)
    assert.match(check.detail, /is not the crc32c of its own bytes/)
  })

  it('refuses a short read rather than checksumming whatever arrived', () => {
    const check = verifyNode(CAPTURED.subarray(0, 4096), CAPTURED_BYTENR)
    assert.equal(check.ok, false)
    assert.match(check.detail, /only 4096 of 16384 bytes/)
  })
})

describe('selfheal csum — reading it off the LV', () => {
  const context = {
    mountpoint: '/mnt/gtsh/@data',
    srcDevice: '/dev/mapper/gtsh-data',
    bands: parseDmTable(fixture('dmsetup-table-lv.txt')).map(segment => selfhealBand(segment, {
      device: '/dev/md127',
      kernel: 'md127',
      sys: '/sys/block/md127/md',
      level: 'raid5',
      raid6: false,
      raid1: false,
      raidDisks: 6,
      chunkBytes: 65536,
      layout: 'left-symmetric',
      members: ['/dev/loop0'],
      dataOffsets: [1048576],
      badBlocks: [null],
    })),
    roots: { chunk: 22052864, csum: 30834688, extent: 32505856, bySubvolume: new Map([[256, 30851072]]) },
    chunks: parseChunkItems(fixture('dump-tree-chunk.txt')),
    csums: ITEMS.slice(),
  }

  /**
   * The csum leaf's OWN logical bytenr needs the chunk hop, exactly like a data
   * block: leaf 30834688 sits in the METADATA|DUP chunk at logical 30408704
   * whose first stripe is at device offset 38797312.
   */
  const LEAF_LV_BYTE = 30834688 - 30408704 + 38797312

  it('hops the leaf through the chunk tree and reads it with O_DIRECT', async () => {
    const leaf = Buffer.alloc(16384 + 4096)
    const entry = findCsumEntry(ITEMS, 14860288)
    assert.ok(entry)
    leaf.writeUInt32LE(STORED_CSUM, entry.leafOffset)
    sealNode(leaf.subarray(0, NODE_BYTES), 30834688)

    const executor = new MockExecutor()
    executor.addPipelineFixture({
      cmd1: '/usr/bin/dd',
      args1: [
        `if=/dev/mapper/gtsh-data`,
        'iflag=direct',
        'bs=4096',
        `skip=${LEAF_LV_BYTE / 4096}`,
        'count=5',
        'status=none',
      ],
      cmd2: '/usr/bin/base64',
      args2: ['-w', '0'],
      result: {
        leftExitCode: 0,
        rightExitCode: 0,
        leftStderr: '',
        rightStderr: '',
        stdout: leaf.toString('base64'),
      },
    })

    assert.equal(await readStoredCsum(executor, context, 14860288), STORED_CSUM)
    assert.equal(executor.pipelineCalls.length, 1)
  })

  /**
   * R2 end to end, on the split rig (PROVENANCE.md, "Split-extent fixtures"):
   * the logical byte the mapping computes for block 300 is the one whose STORED
   * csum equals crc32c of the file's own block — and the byte the pre-R2
   * arithmetic computed is a different entry with a different value. The leaf is
   * the rig's real csum leaf, read off the image at the offset the chunk hop
   * gives.
   */
  it('answers the split file\'s block 300 with the csum that matches its content', async () => {
    const expected = JSON.parse(fixture('split-expected.json')) as {
      logical_byte: number
      logical_byte_without_extent_data_offset: number
      stored_csum: string
      stored_csum_at_wrong_logical: string
    }
    const roots = parseTreeRoots(fixture('split-dump-tree-roots.txt'))
    const leaf = Buffer.from(fixture('split-csum-leaf.b64').trim(), 'base64')
    const block = Buffer.from(fixture('split-block-300.b64').trim(), 'base64')

    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.csum), '/dev/loop0'],
      result: { stdout: fixture('split-dump-tree-csum.txt'), stderr: '', exitCode: 0 },
    })
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.chunk), '/dev/loop0'],
      result: { stdout: fixture('split-dump-tree-chunk.txt'), stderr: '', exitCode: 0 },
    })
    executor.addPipelineFixture({
      cmd1: '/usr/bin/dd',
      cmd2: '/usr/bin/base64',
      result: { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: leaf.toString('base64') },
    })

    const ctx = {
      mountpoint: '/mnt/split',
      srcDevice: '/dev/loop0',
      bands: [],
      roots,
      chunks: [],
      csums: [],
    }
    const stored = await readStoredCsum(executor, ctx, expected.logical_byte)
    assert.equal(csumHex(stored as number), expected.stored_csum)
    assert.equal(stored, crc32c(block), 'the stored csum IS this block\'s crc32c')

    const wrong = await readStoredCsum(executor, ctx, expected.logical_byte_without_extent_data_offset)
    assert.equal(csumHex(wrong as number), expected.stored_csum_at_wrong_logical)
    assert.notEqual(wrong, crc32c(block), 'the pre-R2 byte belongs to another block')
  })

  /**
   * D3, the whole point of the self-check: the leaf is the ONE read in the
   * engine btrfs-progs does not verify for us, and a rotten one used to come
   * back as a plausible four-byte number — no reconstruction could match it,
   * and a HEALTHY data block was reported "restore from backup".
   */
  it('REFUSES a csum leaf that fails its own node checksum, on both DUP copies', async () => {
    const entry = findCsumEntry(ITEMS, 14860288)
    assert.ok(entry)
    const leaf = Buffer.alloc(16384 + 4096)
    leaf.writeUInt32LE(STORED_CSUM, entry.leafOffset)
    sealNode(leaf.subarray(0, NODE_BYTES), 30834688)
    // One flipped byte, after the seal — exactly what rot looks like.
    leaf[9000] ^= 0x01

    const executor = new MockExecutor()
    executor.addPipelineFixture({
      cmd1: '/usr/bin/dd',
      cmd2: '/usr/bin/base64',
      result: { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: leaf.toString('base64') },
    })

    await assert.rejects(
      () => readStoredCsum(executor, { ...context }, 14860288),
      (error: unknown) => {
        assert.ok(error instanceof CsumUnreadableError)
        assert.equal(error.reasonCode, 'csum-unreadable')
        assert.match(error.message, /failed its own checksum on both copies/)
        // cr3.heal.paths: a fact, no negative; the job's sentence says what to do.
        assert.ok(error.message.endsWith('). The data block was not judged.'), error.message)
        assert.doesNotMatch(error.message, /Restore .* from backup/)
        return true
      },
    )
    // BOTH copies of the DUP metadata chunk were tried before giving up.
    assert.equal(executor.pipelineCalls.length, 2)
  })

  /**
   * The other half: stripe 0 has rotted and stripe 1 of the same DUP chunk is
   * fine. btrfs keeps metadata twice precisely so this is survivable, and the
   * engine now uses the second copy instead of condemning the file.
   */
  it('falls back to the DUP chunk\'s SECOND copy when the first has rotted', async () => {
    const entry = findCsumEntry(ITEMS, 14860288)
    assert.ok(entry)
    const good = Buffer.alloc(16384 + 4096)
    good.writeUInt32LE(STORED_CSUM, entry.leafOffset)
    sealNode(good.subarray(0, NODE_BYTES), 30834688)
    const rotten = Buffer.from(good)
    rotten[9000] ^= 0x01

    // stripe 0 is at device offset 38797312, stripe 1 at 90767360 — the two
    // reads land at different skips, which is what tells them apart here.
    const stripe0Skip = (30834688 - 30408704 + 38797312) / 4096
    const stripe1Skip = (30834688 - 30408704 + 90767360) / 4096
    const executor = new MockExecutor()
    executor.addPipelineFixture({
      cmd1: '/usr/bin/dd',
      args1: [`if=/dev/mapper/gtsh-data`, 'iflag=direct', 'bs=4096', `skip=${stripe0Skip}`, 'count=5', 'status=none'],
      cmd2: '/usr/bin/base64',
      args2: ['-w', '0'],
      result: { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: rotten.toString('base64') },
    })
    executor.addPipelineFixture({
      cmd1: '/usr/bin/dd',
      args1: [`if=/dev/mapper/gtsh-data`, 'iflag=direct', 'bs=4096', `skip=${stripe1Skip}`, 'count=5', 'status=none'],
      cmd2: '/usr/bin/base64',
      args2: ['-w', '0'],
      result: { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: good.toString('base64') },
    })

    assert.equal(await readStoredCsum(executor, { ...context }, 14860288), STORED_CSUM)
    assert.equal(executor.pipelineCalls.length, 2, 'the first copy was tried, then the mirror')
  })

  it('walks once, then reports NO stored csum rather than "not fetched yet"', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', '30834688', '/dev/mapper/gtsh-data'],
      result: { stdout: CSUM_TREE, stderr: '', exitCode: 0 },
    })
    const cold = { ...context, csums: [], chunks: [] }
    assert.equal(await readStoredCsum(executor, cold, 4096), null)
    assert.equal(executor.calls.length, 1, 'exactly one bounded tree read')
    assert.ok(cold.csums.length > 0, 'the leaf it read is cached for the next lookup')
  })
})
