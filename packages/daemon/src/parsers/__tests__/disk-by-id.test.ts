import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseByIdToKernel, parseDiskByIdListing, wholeDiskKernel } from '../disk-by-id.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/system')

describe('parseDiskByIdListing', () => {
  it('parses disk-by-id listing', () => {
    const text = readFileSync(join(fixturesDir, 'disk-by-id.txt'), 'utf-8')
    const map = parseDiskByIdListing(text)

    assert.ok(map.size > 0)
  })

  it('excludes partition entries', () => {
    const text = readFileSync(join(fixturesDir, 'disk-by-id.txt'), 'utf-8')
    const map = parseDiskByIdListing(text)

    for (const id of map.values()) {
      assert.ok(!id.match(/-part\d+$/), `should not include partition entry: ${id}`)
    }
  })

  it('prefers higher-priority by-id names', () => {
    // Synthetic test: same device, two by-id names
    const listing = [
      'wwn-0x123456 -> ../../sdb',
      'scsi-0QEMU_ANAS_HOT1 -> ../../sdb',
    ].join('\n')

    const map = parseDiskByIdListing(listing)
    assert.equal(map.get('sdb'), 'scsi-0QEMU_ANAS_HOT1') // scsi > wwn
  })

  it('prefers nvme over scsi', () => {
    const listing = [
      'scsi-something -> ../../nvme0n1',
      'nvme-QEMU_NVMe_Ctrl -> ../../nvme0n1',
    ].join('\n')

    const map = parseDiskByIdListing(listing)
    assert.equal(map.get('nvme0n1'), 'nvme-QEMU_NVMe_Ctrl')
  })
})

describe('wholeDiskKernel', () => {
  it('reduces a partition to its whole-disk parent', () => {
    assert.equal(wholeDiskKernel('sdb1'), 'sdb')
    assert.equal(wholeDiskKernel('sda15'), 'sda')
    assert.equal(wholeDiskKernel('nvme0n1p1'), 'nvme0n1')
  })

  it('leaves a whole-disk name unchanged', () => {
    assert.equal(wholeDiskKernel('sdb'), 'sdb')
    assert.equal(wholeDiskKernel('nvme0n1'), 'nvme0n1')
  })
})

describe('parseByIdToKernel — COMPLETE by-id → kernel map', () => {
  it('keeps EVERY by-id form for a disk (not just the highest priority)', () => {
    // Same physical disk, two symlink forms — both must appear, unlike the
    // priority-collapsing parseDiskByIdListing.
    const listing = [
      'ata-WDC_HET_0001 -> ../../sdb',
      'wwn-0x50000000000001 -> ../../sdb',
    ].join('\n')

    const map = parseByIdToKernel(listing)
    assert.equal(map.get('ata-WDC_HET_0001'), 'sdb')
    assert.equal(map.get('wwn-0x50000000000001'), 'sdb')
  })

  it('strips -partN on the by-id key and the kernel target alike', () => {
    const listing = [
      'wwn-0x5-part1 -> ../../sdb1',
      'nvme-Ctrl-part1 -> ../../nvme0n1p1',
    ].join('\n')

    const map = parseByIdToKernel(listing)
    assert.equal(map.get('wwn-0x5'), 'sdb')
    assert.equal(map.get('nvme-Ctrl'), 'nvme0n1')
  })
})
