import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseDiscardCapableKernels, poolTrimSupported } from '../pools.js'

// `lsblk -Jbno NAME,DISC-GRAN`: sda advertises a nonzero discard granularity
// (SSD), sdb reports 0 (spinning disk, no discard). Partitions inherit and are
// reduced to their whole disk.
const LSBLK_MIXED = JSON.stringify({
  blockdevices: [
    { 'name': 'sda', 'disc-gran': 512, 'children': [{ 'name': 'sda1', 'disc-gran': 512 }] },
    { 'name': 'sdb', 'disc-gran': 0, 'children': [{ 'name': 'sdb1', 'disc-gran': 0 }] },
  ],
})

const LSBLK_ALL_ZERO = JSON.stringify({
  blockdevices: [
    { 'name': 'sda', 'disc-gran': 0 },
    { 'name': 'sdb', 'disc-gran': 0 },
  ],
})

// by-id → whole-disk kernel, as parseByIdToKernel would produce.
const BY_ID = new Map<string, string>([
  ['ata-SSD_A', 'sda'],
  ['ata-HDD_B', 'sdb'],
])

describe('parseDiscardCapableKernels', () => {
  it('collects only whole-disk kernels with DISC-GRAN > 0', () => {
    const capable = parseDiscardCapableKernels(LSBLK_MIXED)
    assert.ok(capable.has('sda'))
    assert.ok(!capable.has('sdb'))
  })

  it('returns an empty set for garbage (fail-open, no throw)', () => {
    assert.equal(parseDiscardCapableKernels('not json').size, 0)
    assert.equal(parseDiscardCapableKernels('').size, 0)
    assert.equal(parseDiscardCapableKernels('{}').size, 0)
  })
})

describe('poolTrimSupported', () => {
  const capable = parseDiscardCapableKernels(LSBLK_MIXED)

  it('is true when a member resolves to a discard-capable device', () => {
    const leaves = [{ id: 'ata-SSD_A', path: '/dev/disk/by-id/ata-SSD_A' }]
    assert.equal(poolTrimSupported(leaves, BY_ID, capable), true)
  })

  it('is false when all members are on non-discard devices', () => {
    const leaves = [{ id: 'ata-HDD_B', path: '/dev/disk/by-id/ata-HDD_B' }]
    assert.equal(poolTrimSupported(leaves, BY_ID, capable), false)
  })

  it('is false when every device reports DISC-GRAN 0', () => {
    const allZero = parseDiscardCapableKernels(LSBLK_ALL_ZERO)
    const leaves = [{ id: 'ata-SSD_A', path: '/dev/disk/by-id/ata-SSD_A' }]
    assert.equal(poolTrimSupported(leaves, BY_ID, allZero), false)
  })

  it('is false (and never throws) for an unresolvable member', () => {
    const leaves = [{ id: 'unknown-nonsense', path: '' }]
    assert.equal(poolTrimSupported(leaves, BY_ID, capable), false)
  })

  it('is true if ANY member is discard-capable (mixed vdev)', () => {
    const leaves = [
      { id: 'ata-HDD_B', path: '/dev/disk/by-id/ata-HDD_B' },
      { id: 'ata-SSD_A', path: '/dev/disk/by-id/ata-SSD_A' },
    ]
    assert.equal(poolTrimSupported(leaves, BY_ID, capable), true)
  })
})
