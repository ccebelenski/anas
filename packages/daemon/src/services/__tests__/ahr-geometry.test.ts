import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AHR_DATA_OFFSET,
  ahrDataOffsetArg,
  ahrDataOffsetBytes,
  AhrGeometryError,
  matchPartitionLabel,
  partitionLabel,
  planDiskPartitions,
} from '../ahr-geometry.js'

const MIB = 1024 ** 2
const GIB = 1024 ** 3

describe('planDiskPartitions', () => {
  // The exact stage-0 build (phase A): virtual 1024/1536/2048 MiB disks,
  // band boundaries at 1024 MiB and 1536 MiB. Locked as a regression case —
  // these argument strings are byte-for-byte what the live build ran.
  const B1 = 1024 * MIB
  const B2 = 1536 * MIB
  const B3 = 2048 * MIB

  it('reproduces stage-0 disk d1 (single band, clamps to last usable)', () => {
    const parts = planDiskPartitions({
      poolName: 'ahr0',
      diskNumber: 1,
      diskUsableBytes: 1 * GIB,
      slices: [{ band: 1, startBytes: 0, endBytes: B1 }],
    })
    assert.equal(parts.length, 1)
    assert.deepEqual(parts[0].sgdiskArgs, ['-n', '1:1M:0', '-t', '1:FD00', '-c', '1:ahr0-d1-b1'])
    assert.equal(parts[0].startBytes, MIB)
    assert.equal(parts[0].sizeBytes, null) // end=0 semantics
  })

  it('reproduces stage-0 disk d2 (interior +size, top slice clamps)', () => {
    const parts = planDiskPartitions({
      poolName: 'ahr0',
      diskNumber: 2,
      diskUsableBytes: 1536 * MIB,
      slices: [
        { band: 1, startBytes: 0, endBytes: B1 },
        { band: 2, startBytes: B1, endBytes: B2 },
      ],
    })
    // Interior slice: start displaced to 1 MiB ⇒ size 1023M, NOT an end "at"
    // the 1024M boundary (inclusive-end overlap, GT-4).
    assert.deepEqual(parts[0].sgdiskArgs, ['-n', '1:1M:+1023M', '-t', '1:FD00', '-c', '1:ahr0-d2-b1'])
    assert.deepEqual(parts[1].sgdiskArgs, ['-n', '2:1024M:0', '-t', '2:FD00', '-c', '2:ahr0-d2-b2'])
  })

  it('reproduces stage-0 disk d3 (three bands)', () => {
    const parts = planDiskPartitions({
      poolName: 'ahr0',
      diskNumber: 3,
      diskUsableBytes: 2 * GIB,
      slices: [
        { band: 1, startBytes: 0, endBytes: B1 },
        { band: 2, startBytes: B1, endBytes: B2 },
        { band: 3, startBytes: B2, endBytes: B3 },
      ],
    })
    assert.deepEqual(parts.map(p => p.sgdiskArgs[1]), ['1:1M:+1023M', '2:1024M:+512M', '3:1536M:0'])
    assert.deepEqual(parts.map(p => p.label), ['ahr0-d3-b1', 'ahr0-d3-b2', 'ahr0-d3-b3'])
  })

  it('reproduces stage-0 disk d5 (phase C1: four bands on a 2560 MiB disk)', () => {
    const parts = planDiskPartitions({
      poolName: 'ahr0',
      diskNumber: 5,
      diskUsableBytes: 2560 * MIB,
      slices: [
        { band: 1, startBytes: 0, endBytes: B1 },
        { band: 2, startBytes: B1, endBytes: B2 },
        { band: 3, startBytes: B2, endBytes: B3 },
        { band: 4, startBytes: B3, endBytes: 2560 * MIB },
      ],
    })
    assert.deepEqual(
      parts.map(p => p.sgdiskArgs[1]),
      ['1:1M:+1023M', '2:1024M:+512M', '3:1536M:+512M', '4:2048M:0'],
    )
  })

  it('leaves unassigned top regions raw — NO partition (§2.6)', () => {
    // Same d5 disk, but the planner assigned only bands 1–3 (the 2048–2560 MiB
    // region is unusable): the final slice is sized exactly, never clamped.
    const parts = planDiskPartitions({
      poolName: 'ahr0',
      diskNumber: 5,
      diskUsableBytes: 2560 * MIB,
      slices: [
        { band: 1, startBytes: 0, endBytes: B1 },
        { band: 2, startBytes: B1, endBytes: B2 },
        { band: 3, startBytes: B2, endBytes: B3 },
      ],
    })
    assert.equal(parts.length, 3)
    assert.deepEqual(parts[2].sgdiskArgs[1], '3:1536M:+512M')
    assert.equal(parts[2].sizeBytes, 512 * MIB)
  })

  it('returns an empty spec for a disk with no assigned slices', () => {
    assert.deepEqual(
      planDiskPartitions({ poolName: 'ahr0', diskNumber: 9, diskUsableBytes: GIB, slices: [] }),
      [],
    )
  })

  it('rejects non-contiguous slice chains', () => {
    assert.throws(
      () => planDiskPartitions({
        poolName: 'ahr0',
        diskNumber: 1,
        diskUsableBytes: 2 * GIB,
        slices: [{ band: 2, startBytes: B1, endBytes: B2 }],
      }),
      AhrGeometryError,
    )
  })

  it('rejects a slice beyond the disk\'s usable size', () => {
    assert.throws(
      () => planDiskPartitions({
        poolName: 'ahr0',
        diskNumber: 1,
        diskUsableBytes: 1000 * MIB,
        slices: [{ band: 1, startBytes: 0, endBytes: B1 }],
      }),
      AhrGeometryError,
    )
  })

  it('rejects non-MiB-aligned boundaries', () => {
    assert.throws(
      () => planDiskPartitions({
        poolName: 'ahr0',
        diskNumber: 1,
        diskUsableBytes: 2 * GIB,
        slices: [
          { band: 1, startBytes: 0, endBytes: B1 + 512 },
          { band: 2, startBytes: B1 + 512, endBytes: 2 * GIB },
        ],
      }),
      AhrGeometryError,
    )
  })
})

describe('data-offset policy (GT-5, calibrated 2026-07-24)', () => {
  it('pins 4 MiB below the 128 GiB knee, 256 MiB from 128 GiB up', () => {
    // Below mdadm's native plateau knee (128 GiB): small/test regime, 4 MiB.
    assert.equal(ahrDataOffsetBytes(1 * GIB), 4 * MIB)
    assert.equal(ahrDataOffsetBytes(128 * GIB - 1), 4 * MIB)
    // At/above the knee (all production TB-scale disks): 256 MiB, ≥ mdadm's own
    // native 129 MiB (264192 s), verified constant to 15.6 TiB on the stunt node.
    assert.equal(ahrDataOffsetBytes(128 * GIB), 256 * MIB)
    assert.equal(ahrDataOffsetBytes(14 * 1000 ** 4), 256 * MIB)
    assert.equal(AHR_DATA_OFFSET.largeMemberThresholdBytes, 128 * GIB)
  })

  it('renders the mdadm argument in unambiguous sectors', () => {
    assert.equal(ahrDataOffsetArg(1 * GIB), '--data-offset=8192s')
    // 256 MiB = 524288 sectors — dominates native (264192 s) with margin.
    assert.equal(ahrDataOffsetArg(4 * 1000 ** 4), '--data-offset=524288s')
  })
})

describe('partitionLabel', () => {
  it('follows the deterministic <pool>-d<n>-b<band> convention', () => {
    assert.equal(partitionLabel('ahr0', 2, 1), 'ahr0-d2-b1')
    assert.equal(partitionLabel('tank', 12, 4), 'tank-d12-b4')
  })

  // The inverse is what recognizes a member partition NOTHING claims any more —
  // the premise of destroy's partlabel sweep (issue #16) and of the topology
  // reader's not-yet-arrayed slices. Both must read a label the same way.
  it('matchPartitionLabel inverts it exactly, and matches nothing else', () => {
    assert.deepEqual(matchPartitionLabel('ahr0', partitionLabel('ahr0', 2, 1)), { diskNumber: 2, band: 1 })
    assert.deepEqual(matchPartitionLabel('tank', 'tank-d12-b4'), { diskNumber: 12, band: 4 })
    // Another pool's label, a partial pool-name match, and a non-member label on
    // the right pool are all rejected — the sweep zeroes superblocks, so a loose
    // match would scrub a disk that is not ours.
    assert.equal(matchPartitionLabel('tank', 'tank2-d1-b1'), null)
    assert.equal(matchPartitionLabel('tank2', 'tank-d1-b1'), null)
    assert.equal(matchPartitionLabel('tank', 'tank-b1'), null)
    assert.equal(matchPartitionLabel('tank', 'tank-d1'), null)
    assert.equal(matchPartitionLabel('tank', 'tank-d1-b1-old'), null)
    assert.equal(matchPartitionLabel('tank', 'pve-swap'), null)
  })
})
