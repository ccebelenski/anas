import type { Job } from '@anas/shared'
import type {
  CommandExecutor,
  ExecResult,
  ExecStreamResult,
  PipelineResult,
} from '../../executor/types.js'
import type { MirrorReconcileEvidence, MirrorReconcilePool } from '../ahr-mirror-reconcile.js'
import type { ChunkItem, SelfhealContext } from '../selfheal-map.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AhrMirrorReconcileResult } from '@anas/shared'
import {
  assertNoMdRepair,
  MIRROR_COMPARE_RATE_BYTES_S,
  MIRROR_RECONCILE_RATE_BYTES_S,
  mirrorGuardedExecutor,
  mirrorReconcileEvidence,
  mirrorReconcileWarnings,
  parseScrubErrorCounts,
  reconcileMirrorBand,
} from '../ahr-mirror-reconcile.js'
import { crc32c, NODE_BYTES } from '../selfheal-csum.js'
import { BLOCK_BYTES } from '../selfheal-io.js'
import { logicalForMdByte, selfhealBand } from '../selfheal-map.js'
import { forgetIssuedChecks } from '../selfheal-syncop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

/**
 * Reconcile mirror (story selfheal.11) — the R9 root's verb.
 *
 * The fake is a real sysfs tree in a temp directory (so every gate, every knob
 * read and the `sync_completed` poll go through the code's own md layer), a
 * scripted md whose check runs for a set number of polls and leaves a
 * `mismatch_cnt` behind, and a set of VIRTUAL BLOCK DEVICES held as buffers —
 * two legs and the md array over them, with a write through md landing on both
 * legs exactly as md does it.
 *
 * That last part is what makes arm B testable at all: the arbitration is
 * "which leg's bytes satisfy the checksum btrfs stored for this row", and a
 * fake that cannot hold bytes can only prove the gates. What the loop-device
 * suite's cases 9a/9b prove on real md is that the sequence is the right one;
 * what these prove is that every row is classified honestly and that md's own
 * repair is never issued.
 */

// --- The rig's geometry, in one place --------------------------------------
//
// The dm segment is the identity map (start 0, offset 0), so an md byte IS an
// LV byte here — the offset arithmetic has its own pure test below. Each leg
// carries md's 1 MiB data offset (the raid1 sysfs fixture's `rd<n>/offset`).

const DATA_OFFSET = 2048 * 512
/** Bytes of the band arm B walks: six 4 KiB rows. */
const SPAN = 6 * BLOCK_BYTES
/** `rd<n>/size` is in KiB and is already net of the data offset. */
const SPAN_KIB = String(SPAN / 1024)

/** A DATA chunk covering LV 4096…12287 — rows 0 and 12288 are free space. */
const DATA_CHUNK: ChunkItem = {
  logical: 1073741824,
  length: 2 * BLOCK_BYTES,
  deviceOffset: BLOCK_BYTES,
  stripes: [BLOCK_BYTES],
  type: 'DATA|single',
}
/** A METADATA|DUP chunk covering LV 16384…49151. Copy 0 is the one in the span. */
const META_CHUNK: ChunkItem = {
  logical: 1090519040,
  length: 32768,
  deviceOffset: 4 * BLOCK_BYTES,
  stripes: [4 * BLOCK_BYTES, 1000 * BLOCK_BYTES],
  type: 'METADATA|DUP',
}

/** The tree node rows 16384 and 20480 belong to. */
const NODE_A = META_CHUNK.logical
/** The csum-tree leaf holding the two DATA rows' checksums (outside the span). */
const CSUM_LEAF = META_CHUNK.logical + NODE_BYTES
/** Where that leaf sits on the LV (copy 0 of the metadata chunk). */
const CSUM_LEAF_LV = CSUM_LEAF - META_CHUNK.logical + META_CHUNK.deviceOffset

/** Byte offset of a csum entry inside its leaf: header + itemoff + index × 4. */
const LEAF_HEADER_BYTES = 101

/**
 * A btrfs tree node that vouches for itself: `bytenr` at offset 48 and the
 * crc32c of bytes 32…nodesize in the first four, little-endian — the two facts
 * `verifyNode` checks, built the way btrfs builds them.
 */
function makeNode(bytenr: number, fill?: (node: Buffer) => void): Buffer {
  const node = Buffer.alloc(NODE_BYTES, 0x5A)
  node.writeBigUInt64LE(BigInt(bytenr), 48)
  fill?.(node)
  node.writeUInt32LE(crc32c(node.subarray(32, NODE_BYTES)), 0)
  return node
}

/** 4 KiB of recognisable content. */
function row(tag: number): Buffer {
  return Buffer.alloc(BLOCK_BYTES, tag)
}

class FakeMirror implements CommandExecutor {
  readonly root: string
  readonly sys: string
  readonly mountpoint: string
  readonly srcDevice = '/dev/mapper/tank-data'
  readonly calls: { command: string, args: string[] }[] = []
  readonly notifications: string[][] = []

  /** The two legs' raw bytes, indexed by role. */
  readonly legs: [Buffer, Buffer]

  /** `Error summary:` and the breakdown each btrfs scrub pass reports. */
  scrubSummary = 'no errors found'
  scrubCorrected = 0
  scrubUncorrectable = 0
  /** Called before each scrub pass, so a pass can heal the legs. */
  onScrub: ((md: FakeMirror, pass: number) => void) | null = null
  private scrubPasses = 0

  /** `mismatch_cnt` each successive check leaves behind. The last repeats. */
  mismatchQueue = ['0']
  private checks = 0
  /** Polls a check runs for before it goes idle. */
  opPolls = 1
  /** md takes an action of its own after this many `sync_action` reads. */
  foreignAfter: { reads: number, action: string } | null = null

  private running: string | null = null
  private left = 0
  private reads = 0

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'anas-mirror-'))
    this.sys = join(this.root, 'sys/block/md127/md')
    this.mountpoint = join(this.root, 'mnt')
    mkdirSync(this.sys, { recursive: true })
    mkdirSync(this.mountpoint, { recursive: true })
    for (const line of fixture('md-sysfs-raid1.txt').split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0 || line.slice(eq + 1) === '<absent>')
        continue
      const path = join(this.sys, line.slice(0, eq))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${line.slice(eq + 1)}\n`)
    }
    // A band arm B can walk end to end in six rows.
    this.set('rd0/size', SPAN_KIB)
    this.set('rd1/size', SPAN_KIB)
    this.set('mismatch_cnt', '128')
    this.set('last_sync_action', 'check')
    this.set('sync_completed', '48 / 48')

    // Both legs start identical and healthy: the DATA rows, the metadata node,
    // and the csum leaf that vouches for the DATA rows.
    const leg = Buffer.alloc(DATA_OFFSET + 64 * BLOCK_BYTES)
    row(0x11).copy(leg, DATA_OFFSET + BLOCK_BYTES)
    row(0x22).copy(leg, DATA_OFFSET + 2 * BLOCK_BYTES)
    makeNode(NODE_A).copy(leg, DATA_OFFSET + 4 * BLOCK_BYTES)
    makeNode(CSUM_LEAF, (node) => {
      node.writeUInt32LE(crc32c(row(0x11)), LEAF_HEADER_BYTES)
      node.writeUInt32LE(crc32c(row(0x22)), LEAF_HEADER_BYTES + 4)
    }).copy(leg, DATA_OFFSET + CSUM_LEAF_LV)
    this.legs = [Buffer.from(leg), Buffer.from(leg)]
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  knob(key: string): string {
    return readFileSync(join(this.sys, key), 'utf-8').trim()
  }

  set(key: string, value: string): void {
    writeFileSync(join(this.sys, key), `${value}\n`)
  }

  /** Put junk in one leg's row, behind md. */
  rot(leg: number, mdByte: number, tag: number): void {
    row(tag).copy(this.legs[leg], DATA_OFFSET + mdByte)
  }

  /** What one leg holds at an md byte. */
  at(leg: number, mdByte: number): Buffer {
    return this.legs[leg].subarray(DATA_OFFSET + mdByte, DATA_OFFSET + mdByte + BLOCK_BYTES)
  }

  pool(): MirrorReconcilePool {
    return {
      name: 'tank',
      mountpoint: this.mountpoint,
      mounted: true,
      arrays: [{ band: 2, device: '/dev/md127', heightBytes: SPAN, members: ['/dev/loop0', '/dev/loop1'] }],
    }
  }

  /**
   * The resolved pool context, handed straight in.
   *
   * The reverse hop needs the band's dm segment and the btrfs tree roots, and
   * nothing in arm B's arithmetic depends on how they were discovered — so the
   * test supplies them rather than making the fake impersonate `dmsetup`,
   * `findmnt` and a tree-roots dump.
   */
  context(csums: SelfhealContext['csums'] = defaultCsums()): SelfhealContext {
    return {
      mountpoint: this.mountpoint,
      srcDevice: this.srcDevice,
      bands: [selfhealBand(
        { startSector: 0, lengthSectors: SPAN / 512, major: 9, minor: 127, offsetSector: 0 },
        {
          device: '/dev/md127',
          kernel: 'md127',
          sys: this.sys,
          level: 'raid1',
          raid6: false,
          raid1: true,
          raidDisks: 2,
          chunkBytes: 0,
          layout: null,
          members: ['/dev/loop0', '/dev/loop1'],
          dataOffsets: [DATA_OFFSET, DATA_OFFSET],
          badBlocks: [[], []],
        },
      )],
      roots: { chunk: 1, csum: 2, extent: null, bySubvolume: new Map() },
      chunks: [],
      csums,
    }
  }

  /** Every `mdadm --action=` this run issued, in order. */
  actions(): string[] {
    return this.calls
      .filter(c => c.command === '/usr/sbin/mdadm' && (c.args[0] ?? '').startsWith('--action='))
      .map(c => c.args[0])
  }

  private tick(): void {
    if (this.running === null)
      return
    this.reads++
    if (this.foreignAfter && this.reads >= this.foreignAfter.reads) {
      this.set('sync_action', this.foreignAfter.action)
      this.running = null
      return
    }
    if (--this.left > 0)
      return
    this.set('sync_action', 'idle')
    this.set('last_sync_action', this.running)
    this.set('mismatch_cnt', this.mismatchQueue[Math.min(this.checks, this.mismatchQueue.length - 1)])
    this.checks++
    this.running = null
  }

  /** Which leg buffer answers a read of this device path. */
  private deviceOf(path: string): { buffer: Buffer, base: number } | null {
    if (path === '/dev/loop0')
      return { buffer: this.legs[0], base: 0 }
    if (path === '/dev/loop1')
      return { buffer: this.legs[1], base: 0 }
    // The LV is the identity map over md, and md serves leg 0.
    if (path === this.srcDevice || path === '/dev/md127')
      return { buffer: this.legs[0], base: DATA_OFFSET }
    return null
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

    if (command === '/usr/bin/readlink')
      return ok('/sys/devices/virtual/block/md127\n')
    if (command === '/usr/bin/cat') {
      const path = args[0]
      const value = readFileSync(join(this.root, path), 'utf-8')
      if (path.endsWith('/sync_action'))
        this.tick()
      return ok(value)
    }
    if (command === '/usr/sbin/mdadm') {
      if ((args[0] ?? '').startsWith('--action=')) {
        this.running = args[0].slice('--action='.length)
        this.left = this.opPolls
        this.reads = 0
        this.set('sync_action', this.running)
        this.set('mismatch_cnt', '0') // md zeroes the counter at a sync start
        return ok()
      }
      return ok(fixture('mdadm-detail-export-raid1.txt'))
    }
    if (command === '/usr/bin/btrfs') {
      if (args[0] === 'scrub' && args[1] === 'start') {
        this.scrubPasses++
        this.onScrub?.(this, this.scrubPasses)
        return ok()
      }
      if (args[0] === 'scrub') {
        return ok([
          'UUID:             11111111-2222-3333-4444-555555555555',
          'Status:           finished',
          'Duration:         0:00:04',
          `Error summary:    ${this.scrubSummary}`,
          `    Corrected:      ${this.scrubCorrected}`,
          `    Uncorrectable:  ${this.scrubUncorrectable}`,
          '    Unverified:     0',
          '',
        ].join('\n'))
      }
      if (args[2] === '-t' && args[3] === '3')
        return ok(chunkDump())
      if (args[2] === '-b') {
        // A csum-tree walk that lands on a leaf with no items: the honest
        // answer for a logical byte btrfs stored no checksum for.
        return ok('leaf 4096 items 0 free space 16283 generation 9 owner CSUM_TREE\n')
      }
      return ok()
    }
    if (command === '/usr/bin/dd') {
      // The write path: `if=<staged file> of=<device> seek=<blocks>`.
      const of = args.find(a => a.startsWith('of='))?.slice(3) ?? ''
      const from = args.find(a => a.startsWith('if='))?.slice(3) ?? ''
      const seek = Number(args.find(a => a.startsWith('seek='))?.slice(5) ?? 0)
      const target = this.deviceOf(of)
      if (!target)
        return { stdout: '', stderr: `unexpected dd target ${of}`, exitCode: 1 }
      const payload = readFileSync(from)
      // md writes EVERY leg.
      for (const leg of this.legs)
        payload.copy(leg, DATA_OFFSET + seek * BLOCK_BYTES)
      return ok()
    }
    if (command === '/usr/bin/perl') {
      this.notifications.push(args.slice(2))
      return ok()
    }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }

  async pipeline(cmd1: string, args1: string[]): Promise<PipelineResult> {
    this.calls.push({ command: cmd1, args: args1 })
    const of = args1.find(a => a.startsWith('if='))?.slice(3) ?? ''
    const skip = Number(args1.find(a => a.startsWith('skip='))?.slice(5) ?? 0)
    const count = Number(args1.find(a => a.startsWith('count='))?.slice(6) ?? 0)
    const source = this.deviceOf(of)
    if (!source)
      return { leftExitCode: 1, rightExitCode: 0, leftStderr: `unexpected read of ${of}`, rightStderr: '', stdout: '' }
    const at = source.base + skip * BLOCK_BYTES
    const bytes = source.buffer.subarray(at, at + count * BLOCK_BYTES)
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: bytes.toString('base64') }
  }

  async execToStream(): Promise<ExecStreamResult> {
    throw new Error('no stream in this fake')
  }
}

/** The chunk tree, as `dump-tree -t 3` prints it. */
function chunkDump(): string {
  const item = (index: number, chunk: ChunkItem): string => [
    `\titem ${index} key (FIRST_CHUNK_TREE CHUNK_ITEM ${chunk.logical}) itemoff 0 itemsize 80`,
    `\t\tlength ${chunk.length} owner 2 stripe_len 65536 type ${chunk.type}`,
    ...chunk.stripes.map((offset, i) => `\t\t\tstripe ${i} devid 1 offset ${offset}`),
  ].join('\n')
  return `${['leaf 1 items 2 free space 0 generation 9 owner CHUNK_TREE', item(0, DATA_CHUNK), item(1, META_CHUNK)].join('\n')}\n`
}

/** The csum item covering both DATA rows, as the run's cache would hold it. */
function defaultCsums(): SelfhealContext['csums'] {
  return [{ start: DATA_CHUNK.logical, itemOffset: 0, itemSize: 8, leaf: CSUM_LEAF }]
}

/** The proof, as the route's lookup would hand it over. */
const PROVEN: MirrorReconcileEvidence = { ok: true, mismatchCnt: 128, jobId: 'job-1' }

/** Fast polls: the fake's md is scripted, not timed. */
const FAST = { pollIntervalMs: 1, mismatchDelayMs: 1, startTimeoutMs: 50 }

describe('the md-repair invariant', () => {
  it('refuses `mdadm --action=repair` before the process is spawned', () => {
    assert.throws(
      () => assertNoMdRepair('/usr/sbin/mdadm', ['--action=repair', '/dev/md127']),
      /copies the first in-sync leg over the others/,
    )
    assert.throws(() => assertNoMdRepair('/usr/sbin/mdadm', ['--action=repair']), /bug in ANAS/)
    // The check phase, and anything that is not mdadm, pass untouched.
    assert.doesNotThrow(() => assertNoMdRepair('/usr/sbin/mdadm', ['--action=check', '/dev/md127']))
    assert.doesNotThrow(() => assertNoMdRepair('/usr/bin/btrfs', ['scrub', 'start', '/mnt/repair']))
  })

  it('the guarded executor never lets one through, on any of its three doors', async () => {
    const seen: string[][] = []
    const note = (c: string, a: string[]): void => {
      seen.push([c, ...a])
    }
    const inner: CommandExecutor = {
      exec: async (c, a) => {
        note(c, a)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      pipeline: async (c, a) => {
        note(c, a)
        return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: '' }
      },
      execToStream: async (c, a) => {
        note(c, a)
        return { exitCode: 0, stderr: '', bytesWritten: 0 }
      },
    }
    const guarded = mirrorGuardedExecutor(inner)
    await assert.rejects(guarded.exec('/usr/sbin/mdadm', ['--action=repair', '/dev/md127']))
    await assert.rejects(guarded.pipeline('/usr/sbin/mdadm', ['--action=repair'], '/usr/bin/cat', []))
    await assert.rejects(guarded.execToStream('/usr/sbin/mdadm', ['--action=repair'], { path: '/dev/null', flags: 'w' }))
    assert.deepEqual(seen, [], 'not one of them reached the real executor')
  })
})

describe('the AhrMirrorReconcileResult contract', () => {
  const MINIMAL = {
    pool: 'tank',
    band: 2,
    array: '/dev/md127',
    arm: 'scrub' as const,
    mismatchBefore: 128,
    mismatchAfter: 0,
    outcome: 'reconciled' as const,
    durations: { scrubMs: 1, compareMs: 0, checkMs: 2, totalMs: 3 },
  }

  it('defaults every row count, so an older consumer never reads undefined as a number', () => {
    const parsed = AhrMirrorReconcileResult.parse(MINIMAL)
    assert.deepEqual(parsed.passes, [])
    assert.equal(parsed.rowsCompared, 0)
    assert.equal(parsed.rowsDiffering, 0)
    assert.deepEqual(parsed.rowsWritten, { leg0: 0, leg1: 0 })
    assert.equal(parsed.freeSpaceRows, 0)
    assert.equal(parsed.uncheckedRows, 0)
    assert.equal(parsed.unresolvedRows, 0)
  })

  it('an unreadable counter is null, never zero — before and after', () => {
    const parsed = AhrMirrorReconcileResult.parse({ ...MINIMAL, mismatchBefore: null, mismatchAfter: null })
    assert.equal(parsed.mismatchBefore, null)
    assert.equal(parsed.mismatchAfter, null)
    const pass = AhrMirrorReconcileResult.parse({ ...MINIMAL, passes: [{ corrected: 2, mismatchAfter: null }] })
    assert.equal(pass.passes[0].mismatchAfter, null)
  })

  it('survives the JSON round trip a job result makes', () => {
    const rich = AhrMirrorReconcileResult.parse({
      ...MINIMAL,
      arm: 'compare',
      outcome: 'residual',
      reason: '1 row(s) could not be arbitrated',
      passes: [{ corrected: 0, mismatchAfter: 128 }],
      rowsCompared: 51200,
      rowsDiffering: 3,
      rowsWritten: { leg0: 1, leg1: 0 },
      freeSpaceRows: 1,
      uncheckedRows: 0,
      unresolvedRows: 1,
      mismatchAfter: 128,
      btrfsErrors: 'csum=1',
    })
    assert.deepEqual(AhrMirrorReconcileResult.parse(JSON.parse(JSON.stringify(rich))), rich)
  })

  it('refuses an outcome or a reason code it does not define', () => {
    assert.throws(() => AhrMirrorReconcileResult.parse({ ...MINIMAL, outcome: 'rewritten' }))
    assert.throws(() => AhrMirrorReconcileResult.parse({ ...MINIMAL, arm: 'repair' }))
    assert.throws(() => AhrMirrorReconcileResult.parse({ ...MINIMAL, reasonCode: 'not-a-parity-band' }))
    // Deliberately absent: this verb never refuses because a file is corrupt.
    assert.throws(() => AhrMirrorReconcileResult.parse({ ...MINIMAL, reasonCode: 'data-corruption-found' }))
    for (const code of ['no-mirror-mismatch', 'not-a-mirror-band', 'data-findings-present', 'array-busy', 'job-active', 'bad-blocks-present', 'foreign-sync-op', 'no-such-band', 'pool-not-mounted'])
      assert.doesNotThrow(() => AhrMirrorReconcileResult.parse({ ...MINIMAL, outcome: 'refused', reason: 'x', reasonCode: code }), code)
  })
})

describe('parseScrubErrorCounts', () => {
  it('reads the breakdown btrfs prints under its error summary', () => {
    const counts = parseScrubErrorCounts([
      'Error summary:    csum=1',
      '    Corrected:      1',
      '    Uncorrectable:  0',
      '    Unverified:     0',
    ].join('\n'))
    assert.deepEqual(counts, { corrected: 1, uncorrectable: 0 })
  })

  it('a clean pass prints no breakdown at all, and both read zero', () => {
    assert.deepEqual(
      parseScrubErrorCounts('Status:           finished\nError summary:    no errors found\n'),
      { corrected: 0, uncorrectable: 0 },
    )
  })
})

describe('logicalForMdByte — the chain, run backwards', () => {
  const band = selfhealBand(
    { startSector: 8192, lengthSectors: 1024, major: 9, minor: 127, offsetSector: 2048 },
    {
      device: '/dev/md127',
      kernel: 'md127',
      sys: '/sys/block/md127/md',
      level: 'raid1',
      raid6: false,
      raid1: true,
      raidDisks: 2,
      chunkBytes: 0,
      layout: null,
      members: ['/dev/loop0', '/dev/loop1'],
      dataOffsets: [0, 0],
      badBlocks: [null, null],
    },
  )

  it('is the exact inverse of the forward hop, dm offset and chunk delta included', () => {
    // Forward: logical → LV byte through the chunk delta, LV byte → md byte
    // through the segment. The segment here starts at LV sector 8192 and maps
    // onto md sector 2048, so the two offsets do NOT cancel.
    const logical = DATA_CHUNK.logical + BLOCK_BYTES
    const lvByte = logical - DATA_CHUNK.logical + DATA_CHUNK.deviceOffset
    const mdByte = lvByte - 8192 * 512 + 2048 * 512
    const back = logicalForMdByte(mdByte, band, [DATA_CHUNK])
    assert.equal(back?.logical, logical)
    assert.equal(back?.lvByte, lvByte)
    assert.equal(back?.chunk.type, 'DATA|single')
    assert.equal(back?.copy, 0)
  })

  it('answers null for an md byte in no chunk at all — that is free space, not an error', () => {
    assert.equal(logicalForMdByte(2048 * 512, band, [DATA_CHUNK]), null)
    assert.equal(logicalForMdByte(0, band, [DATA_CHUNK]), null, 'and for one below the segment')
  })

  it('finds the SECOND copy of a DUP metadata chunk, and says which copy it is', () => {
    const lvByte = META_CHUNK.stripes[1] + BLOCK_BYTES
    const back = logicalForMdByte(lvByte - 8192 * 512 + 2048 * 512, band, [META_CHUNK])
    assert.equal(back?.copy, 1)
    assert.equal(back?.logical, META_CHUNK.logical + BLOCK_BYTES)
  })
})

describe('mirrorReconcileEvidence', () => {
  const scrubJob = (result: unknown): Job => ({
    id: 'job-9',
    operation: 'ahr.scrub',
    status: 'completed',
    createdAt: '2026-09-14T10:00:00.000Z',
    params: {},
    result,
  } as unknown as Job)

  it('accepts a RAID1 band the last scrub counted mismatches on, with no findings', () => {
    const proof = mirrorReconcileEvidence('tank', scrubJob({
      btrfsErrors: null,
      parityMismatches: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 128, level: 'raid1' }],
    }), 2)
    assert.equal(proof.ok, true)
    assert.equal(proof.ok && proof.mismatchCnt, 128)
  })

  it('refuses a PARITY band by name — that mismatch has a verb of its own', () => {
    const proof = mirrorReconcileEvidence('tank', scrubJob({
      btrfsErrors: null,
      parityMismatches: [{ band: 'tank-r1', bandIndex: 1, array: '/dev/md126', mismatchCnt: 8, level: 'raid5' }],
    }), 1)
    assert.equal(proof.ok, false)
    assert.equal(!proof.ok && proof.code, 'not-a-mirror-band')
    assert.ok(!proof.ok && /Rewrite parity/.test(proof.reason))
  })

  it('refuses a row from a daemon too old to record the level, rather than guessing', () => {
    const proof = mirrorReconcileEvidence('tank', scrubJob({
      btrfsErrors: null,
      parityMismatches: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 128 }],
    }), 2)
    assert.equal(proof.ok, false)
    assert.equal(!proof.ok && proof.code, 'not-a-mirror-band')
  })

  it('refuses when the same scrub named corrupt files', () => {
    const proof = mirrorReconcileEvidence('tank', scrubJob({
      btrfsErrors: 'csum=2',
      parityMismatches: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 128, level: 'raid1' }],
    }), 2)
    assert.equal(proof.ok, false)
    assert.equal(!proof.ok && proof.code, 'data-findings-present')
  })

  it('refuses when the band counted nothing, and when nothing is on record at all', () => {
    const none = mirrorReconcileEvidence('tank', scrubJob({ btrfsErrors: null, parityMismatches: [] }), 2)
    assert.equal(!none.ok && none.code, 'no-mirror-mismatch')
    const absent = mirrorReconcileEvidence('tank', undefined, 2)
    assert.equal(!absent.ok && absent.code, 'no-mirror-mismatch')
  })

  it('reads a REPAIR job\'s measured residual, and refuses one that left blocks unrepaired', () => {
    const repair = (result: unknown): Job => ({
      id: 'job-r',
      operation: 'ahr.repair',
      status: 'completed',
      createdAt: '2026-09-14T11:00:00.000Z',
      params: {},
      result,
    } as unknown as Job)
    const proven = mirrorReconcileEvidence('tank', repair({
      unrepairable: 0,
      aboveMd: 0,
      notExamined: 0,
      parityResiduals: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 128, level: 'raid1' }],
    }), 2)
    assert.equal(proven.ok, true)

    const leftover = mirrorReconcileEvidence('tank', repair({
      unrepairable: 1,
      parityResiduals: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 128, level: 'raid1' }],
    }), 2)
    assert.equal(!leftover.ok && leftover.code, 'data-findings-present')
  })

  it('takes the NEWER of a scrub and a repair', () => {
    const older = scrubJob({ btrfsErrors: null, parityMismatches: [] })
    const newer = {
      id: 'job-new',
      operation: 'ahr.repair',
      status: 'completed',
      createdAt: '2026-09-14T12:00:00.000Z',
      params: {},
      result: { unrepairable: 0, parityResiduals: [{ band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 64, level: 'raid1' }] },
    } as unknown as Job
    const proof = mirrorReconcileEvidence('tank', [older, newer], 2)
    assert.equal(proof.ok && proof.mismatchCnt, 64)
  })
})

describe('mirrorReconcileWarnings', () => {
  it('names both arms, what is left alone, and the absence of a degraded window', () => {
    const warnings = mirrorReconcileWarnings('tank', { band: 2, device: '/dev/md127', heightBytes: 20 * 1024 ** 4, members: 2 }, 1024 ** 4)
    const all = warnings.join('\n')
    assert.ok(/Arm A runs an ordinary btrfs checksum scrub/.test(all), all)
    assert.ok(/Arm B .*reads BOTH legs of band r2 in full/.test(all), all)
    assert.ok(/NOCOW/.test(all) && /left exactly as it is/.test(all), all)
    assert.ok(/NEITHER leg matches is never written/.test(all), all)
    assert.ok(/stays ONLINE and undegraded/.test(all) && /no single-copy window/.test(all), all)
    assert.ok(/md's own repair is NOT used/.test(all), all)
    assert.ok(/never automatic/.test(all), all)
    // Each arm is estimated at ITS OWN rate, and both are said out loud. Arm A
    // is btrfs reading at the disks' pace; arm B is ANAS's own read path, which
    // the live proof measured at 26 MiB/s per leg against a gate that had
    // promised 60.
    assert.ok(/60 MiB\/s/.test(all) === false, 'arm B must not quote the disk floor')
    assert.ok(/26 MiB\/s per leg on a live pool/.test(all), all)
    assert.ok(/estimated here at 20 MiB\/s so the number is a ceiling/.test(all), all)
    assert.equal(MIRROR_RECONCILE_RATE_BYTES_S, 60 * 1024 * 1024)
    assert.equal(MIRROR_COMPARE_RATE_BYTES_S, 20 * 1024 * 1024)
  })

  it('estimates arm B at its own rate — a 20 TB leg is days, and the gate says so', () => {
    const [, armB] = mirrorReconcileWarnings('tank', { band: 2, device: '/dev/md127', heightBytes: 20 * 1024 ** 4, members: 2 })
    // 20 TB at 20 MiB/s is ~291 hours. The point is that it does not read as
    // hours-not-days by quoting a rate arm B cannot reach.
    assert.ok(/\d{3} h/.test(armB), armB)
  })
})

describe('reconcileMirrorBand — arm A', () => {
  let md: FakeMirror

  beforeEach(() => {
    md = new FakeMirror()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = md.root
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = join(md.root, 'run')
    forgetIssuedChecks()
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
    md.cleanup()
  })

  it('stops at the first pass whose check reads 0 — the scrub healed the band through md', async () => {
    md.scrubSummary = 'csum=1'
    md.scrubCorrected = 1
    md.mismatchQueue = ['0']
    const result = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN, context: md.context() })

    assert.equal(result.outcome, 'reconciled')
    assert.equal(result.arm, 'scrub')
    assert.deepEqual(result.passes, [{ corrected: 1, mismatchAfter: 0 }])
    assert.equal(result.mismatchBefore, 128)
    assert.equal(result.mismatchAfter, 0)
    assert.equal(result.rowsCompared, 0, 'arm B never ran')
    assert.deepEqual(md.actions(), ['--action=check'], 'one whole-band check, and no repair')
    assert.equal(md.notifications.length, 1)
    assert.equal(md.notifications[0][0], 'info')
  })

  it('repeats the pass while it is making progress, up to the bound', async () => {
    md.scrubSummary = 'csum=1'
    md.scrubCorrected = 1
    md.mismatchQueue = ['128', '128', '128']
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      evidence: () => PROVEN,
      context: md.context(),
      scrubPasses: 3,
    })

    assert.equal(result.passes.length, 3, 'three passes, because each one corrected something')
    assert.deepEqual(result.passes.map(p => p.corrected), [1, 1, 1])
    assert.equal(result.arm, 'compare', 'and then it fell through to arm B')
  })

  // --- cr.38 session B: the guard's seams (WAVE3-DESIGN §3.2, §4.3) --------

  it('cr.38: re-guards before every whole-band check and every later pass, and gives the key back while md checks', async () => {
    md.scrubSummary = 'csum=1'
    md.scrubCorrected = 1
    md.mismatchQueue = ['128', '0']
    const trace: string[] = []
    const actions = () => md.actions().length
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      evidence: () => PROVEN,
      context: md.context(),
      scrubPasses: 2,
      reguard: async () => {
        trace.push(`reguard after ${actions()} md check(s)`)
      },
      release: () => {
        trace.push(`release after ${actions()} md check(s)`)
      },
    })
    assert.equal(result.outcome, 'reconciled')
    assert.deepEqual(trace, [
      'reguard after 0 md check(s)', // pass 1's whole-band check (its scrub ran on the job's entry check)
      'release after 1 md check(s)', // md checks; the job watches
      'reguard after 1 md check(s)', // pass 2's scrub
      'reguard after 1 md check(s)', // pass 2's whole-band check
      'release after 2 md check(s)',
    ])
  })

  it('cr.38: a refusal at the reguard before arm B is the run\'s refusal — reported once, rethrown, no row written', async () => {
    md.mismatchQueue = ['128']
    const refusal = Object.assign(new Error('a repair is in flight on AHR pool \'tank\' (job j0)'), { jobErrorCode: 'CONFLICT', refusal: { reason: 'job-active' } })
    let calls = 0
    await assert.rejects(
      reconcileMirrorBand(md, md.pool(), 2, {
        ...FAST,
        evidence: () => PROVEN,
        context: md.context(),
        reguard: async () => (++calls === 1 ? undefined : Promise.reject(refusal)),
        release: () => {},
      }),
      (err: unknown) => err === refusal,
    )
    assert.deepEqual(md.actions(), ['--action=check'], 'arm A\'s one check, nothing after it')
    assert.equal(md.notifications.length, 1)
    assert.match(md.notifications[0][2], /re-checked before arm B; nothing was written/)
  })

  it('a pass that corrects NOTHING while md still counts stops arm A at once', async () => {
    md.mismatchQueue = ['128']
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      evidence: () => PROVEN,
      context: md.context(),
      scrubPasses: 3,
    })
    assert.equal(result.passes.length, 1, 'repeating the same coin flip proves nothing')
    assert.equal(result.arm, 'compare')
  })

  it('NAMES an uncorrectable file and carries on — it is a fact to report, not a refusal', async () => {
    // The one place this verb's gates differ from Rewrite parity's: that verb
    // aborts on any finding because md repair would bless the rot. This one
    // writes no row it cannot prove, so the rest of the band is still worth
    // reconciling and the lost file is reported.
    md.scrubSummary = 'csum=1'
    md.scrubUncorrectable = 1
    md.mismatchQueue = ['0']
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      evidence: () => PROVEN,
      context: md.context(),
      attributeFindings: async () => [{ path: '/mnt/tank/f1.bin', subvolume: '@data', inode: 257, stripes: [], badBlocks: [300] }],
    })
    assert.equal(result.outcome, 'reconciled', 'the BAND is what this outcome describes')
    assert.equal(result.reasonCode, undefined)
    assert.equal(result.btrfsErrors, 'csum=1', 'and the finding rides the result')
    assert.deepEqual(result.findings?.map(f => f.path), ['/mnt/tank/f1.bin'])
    // A clean band with an unreadable file on it is NOT an `info` notification.
    assert.equal(md.notifications[0][0], 'warning')
    assert.ok(md.notifications[0][2].includes('/mnt/tank/f1.bin'), md.notifications[0][2])
    assert.ok(md.notifications[0][2].includes('restore them from backup'), md.notifications[0][2])
  })

  it('walks away when md takes an operation of its own mid-check', async () => {
    md.opPolls = 5
    md.foreignAfter = { reads: 2, action: 'recover' }
    const result = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN, context: md.context() })
    assert.equal(result.outcome, 'refused', 'nothing was written, so this is not a residual')
    assert.equal(result.reasonCode, 'foreign-sync-op')
    assert.ok(/recover/.test(result.reason ?? ''), result.reason)
    assert.equal(result.rowsCompared, 0, 'nothing was compared and nothing was written')
  })
})

describe('reconcileMirrorBand — the gates', () => {
  let md: FakeMirror

  beforeEach(() => {
    md = new FakeMirror()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = md.root
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = join(md.root, 'run')
    forgetIssuedChecks()
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
    md.cleanup()
  })

  it('refuses a band the pool does not have, and an unmounted pool', async () => {
    const missing = await reconcileMirrorBand(md, md.pool(), 7, { ...FAST, evidence: () => PROVEN })
    assert.equal(missing.reasonCode, 'no-such-band')
    const unmounted = await reconcileMirrorBand(md, { ...md.pool(), mounted: false }, 2, { ...FAST, evidence: () => PROVEN })
    assert.equal(unmounted.reasonCode, 'pool-not-mounted')
  })

  it('refuses without the proof, before the scrub and before md', async () => {
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      evidence: () => ({ ok: false, code: 'no-mirror-mismatch', reason: 'the last scrub counted no mismatch on band r2' }),
    })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'no-mirror-mismatch')
    assert.deepEqual(md.actions(), [])
    assert.deepEqual(md.calls.filter(c => c.command === '/usr/bin/btrfs'), [], 'not even the scrub ran')
  })

  it('refuses a PARITY band outright — it never becomes a mirror', async () => {
    md.set('level', 'raid5')
    md.set('chunk_size', '65536')
    md.set('layout', '2')
    const result = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'not-a-mirror-band')
    assert.ok(/Rewrite parity/.test(result.reason ?? ''), result.reason)
  })

  it('refuses a degraded band, a busy one, and one whose sync window is still bounded', async () => {
    md.set('degraded', '1')
    const degraded = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN })
    assert.equal(degraded.reasonCode, 'array-busy')
    assert.ok(/degraded/.test(degraded.reason ?? ''), degraded.reason)

    md.set('degraded', '0')
    md.set('sync_action', 'resync')
    const busy = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN })
    assert.equal(busy.reasonCode, 'array-busy')

    md.set('sync_action', 'idle')
    md.set('sync_max', '6400')
    const bounded = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN })
    assert.equal(bounded.reasonCode, 'array-busy')
    assert.ok(/sync window is bounded/.test(bounded.reason ?? ''), bounded.reason)
    assert.deepEqual(md.actions(), [])
  })

  it('refuses a band with recorded md bad blocks — md holds no correct copy there', async () => {
    md.set('rd0/bad_blocks', '128 8')
    const result = await reconcileMirrorBand(md, md.pool(), 2, { ...FAST, evidence: () => PROVEN })
    assert.equal(result.reasonCode, 'bad-blocks-present')
    assert.ok(/replace the member first/i.test(result.reason ?? ''), result.reason)
  })

  it('refuses while another job is in flight on the pool', async () => {
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      evidence: () => PROVEN,
      jobConflict: () => 'a scrub is in flight on AHR pool \'tank\' (job x)',
    })
    assert.equal(result.reasonCode, 'job-active')
    assert.deepEqual(md.actions(), [])
  })

  it('re-takes the proof before arm B writes anything', async () => {
    md.mismatchQueue = ['128']
    md.rot(1, BLOCK_BYTES, 0xEE)
    let asked = 0
    const result = await reconcileMirrorBand(md, md.pool(), 2, {
      ...FAST,
      context: md.context(),
      scrubPasses: 1,
      evidence: () => {
        asked++
        return asked === 1
          ? PROVEN
          : { ok: false, code: 'data-findings-present', reason: 'a scrub finished with findings while this run was in flight' }
      },
    })
    assert.equal(asked, 2, 'the proof is taken at submit and again before arm B')
    assert.equal(result.outcome, 'refused')
    assert.equal(result.reasonCode, 'data-findings-present')
    assert.ok(/re-checked before arm B/.test(result.reason ?? ''), result.reason)
    assert.deepEqual(md.at(1, BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0xEE), 'the rotten leg is exactly as it was')
  })
})

describe('reconcileMirrorBand — arm B', () => {
  let md: FakeMirror

  beforeEach(() => {
    md = new FakeMirror()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = md.root
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = join(md.root, 'run')
    forgetIssuedChecks()
    // Arm A's pass finds nothing (md never serves the rotten leg) and md still
    // counts, which is the whole reason arm B exists; the check after arm B
    // reads 0.
    md.mismatchQueue = ['128', '0']
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
    md.cleanup()
  })

  const run = async (extra = {}) => reconcileMirrorBand(md, md.pool(), 2, {
    ...FAST,
    evidence: () => PROVEN,
    context: md.context(),
    scrubPasses: 1,
    ...extra,
  })

  it('arbitrates a rotten DATA row by its stored checksum and writes the winner through md', async () => {
    md.rot(1, BLOCK_BYTES, 0xEE)
    const result = await run()

    assert.equal(result.outcome, 'reconciled')
    assert.equal(result.arm, 'compare')
    assert.equal(result.rowsCompared, 6, 'every row of the band was read off both legs')
    assert.equal(result.rowsDiffering, 1)
    assert.deepEqual(result.rowsWritten, { leg0: 1, leg1: 0 }, 'leg 0 matched the checksum')
    assert.equal(result.unresolvedRows, 0)
    assert.equal(result.mismatchAfter, 0)
    // md writes EVERY leg: both hold the original bytes again.
    assert.deepEqual(md.at(0, BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0x11))
    assert.deepEqual(md.at(1, BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0x11))
    assert.deepEqual(md.actions(), ['--action=check', '--action=check'], 'two checks, no repair — ever')
  })

  it('the rot on the OTHER leg is arbitrated the same way, and leg 1 wins', async () => {
    md.rot(0, 2 * BLOCK_BYTES, 0xEE)
    const result = await run()
    assert.equal(result.outcome, 'reconciled')
    assert.deepEqual(result.rowsWritten, { leg0: 0, leg1: 1 })
    assert.deepEqual(md.at(0, 2 * BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0x22))
  })

  it('a METADATA row is decided by the node\'s own header checksum', async () => {
    // Junk in the node on leg 0. Its stored crc32c no longer describes its
    // bytes, so leg 1's copy is the one that vouches for itself.
    md.rot(0, 4 * BLOCK_BYTES, 0xEE)
    const result = await run()
    assert.equal(result.outcome, 'reconciled')
    assert.deepEqual(result.rowsWritten, { leg0: 0, leg1: 1 })
    assert.equal(result.uncheckedRows, 0)
    assert.deepEqual(md.at(0, 4 * BLOCK_BYTES), md.at(1, 4 * BLOCK_BYTES))
  })

  it('counts rows in no chunk as free space and leaves them exactly as they are', async () => {
    md.rot(1, 0, 0xEE)
    md.rot(1, 3 * BLOCK_BYTES, 0xEE)
    const result = await run()
    assert.equal(result.rowsDiffering, 2)
    assert.equal(result.freeSpaceRows, 2, 'nothing knows what free space should hold')
    assert.deepEqual(result.rowsWritten, { leg0: 0, leg1: 0 })
    assert.deepEqual(md.at(1, 0), Buffer.alloc(BLOCK_BYTES, 0xEE), 'untouched')
  })

  it('counts a DATA row with NO stored checksum as unchecked, and writes nothing for it', async () => {
    // A csum item that covers only the first row: the second has none, which is
    // what a NOCOW file or a preallocated range looks like from here.
    md.rot(1, 2 * BLOCK_BYTES, 0xEE)
    const result = await run({ context: md.context([{ start: DATA_CHUNK.logical, itemOffset: 0, itemSize: 4, leaf: CSUM_LEAF }]) })
    assert.equal(result.rowsDiffering, 1)
    assert.equal(result.uncheckedRows, 1)
    assert.deepEqual(result.rowsWritten, { leg0: 0, leg1: 0 })
    assert.deepEqual(md.at(1, 2 * BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0xEE), 'untouched')
  })

  it('reports a row NEITHER leg can satisfy as a residual, and never writes one', async () => {
    md.mismatchQueue = ['128', '128']
    md.rot(0, BLOCK_BYTES, 0xAA)
    md.rot(1, BLOCK_BYTES, 0xBB)
    const result = await run()

    assert.equal(result.outcome, 'residual')
    assert.equal(result.unresolvedRows, 1)
    assert.deepEqual(result.rowsWritten, { leg0: 0, leg1: 0 })
    assert.ok(/neither leg satisfies the checksum/.test(result.reason ?? ''), result.reason)
    assert.ok(/restoring from backup/.test(result.reason ?? ''), result.reason)
    assert.deepEqual(md.at(0, BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0xAA), 'leg 0 untouched')
    assert.deepEqual(md.at(1, BLOCK_BYTES), Buffer.alloc(BLOCK_BYTES, 0xBB), 'leg 1 untouched')
    assert.equal(md.notifications[0][0], 'warning')
    assert.ok(md.notifications[0][2].includes('Do not run mdadm --action=repair on a mirror band'), md.notifications[0][2])
  })

  it('a band that comes back still mismatched is a residual, never a success', async () => {
    md.mismatchQueue = ['128', '64']
    md.rot(1, BLOCK_BYTES, 0xEE)
    const result = await run()
    assert.equal(result.outcome, 'residual')
    assert.equal(result.mismatchAfter, 64)
    assert.ok(/still counts 64 mismatch/.test(result.reason ?? ''), result.reason)
  })

  it('reads both legs in windows and still decides every row — the result parses as the shared schema', async () => {
    md.rot(1, BLOCK_BYTES, 0xEE)
    const result = await run({ compareWindowBytes: BLOCK_BYTES })
    assert.doesNotThrow(() => AhrMirrorReconcileResult.parse(result))
    assert.equal(result.rowsCompared, 6)
    assert.deepEqual(result.rowsWritten, { leg0: 1, leg1: 0 })
  })

  it('never issues md repair, on any path through the verb', async () => {
    md.rot(1, BLOCK_BYTES, 0xEE)
    await run()
    const repairs = md.calls.filter(c => c.args.some(a => String(a).includes('--action=repair')))
    assert.deepEqual(repairs, [], 'the executor never saw an md repair')
  })
})
