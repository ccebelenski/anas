import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { leafDiskId, parseByIdToKernel, parseDiskByIdListing, wholeDiskKernel } from '../disk-by-id.js'

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

describe('leafDiskId — the whole-disk by-id a ZFS leaf name resolves to (0.4.1)', () => {
  // The captured listing the disks service and the dashboard telemetry both
  // read: sdb → ata-WDC_WD2003FZEX-00SRLA0_WD-12345678, among others.
  const map = parseDiskByIdListing(readFileSync(join(fixturesDir, 'disk-by-id.txt'), 'utf-8'))
  const WDC = 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678'

  it('a whole-disk kernel name resolves directly (today\'s behaviour, unchanged)', () => {
    assert.equal(leafDiskId('sdb', map), WDC)
  })

  it('a kernel-named PARTITION leaf resolves to its whole-disk by-id', () => {
    // The device-named-pool shape (topology.1): zpool prints the bare
    // partition name, the telemetry row carries the disk id.
    assert.equal(leafDiskId('sdb5', map), WDC)
    assert.equal(leafDiskId('sdb1', map), WDC)
  })

  it('a /dev/-prefixed kernel leaf (what zpool status carries as path) resolves too', () => {
    assert.equal(leafDiskId('/dev/sdb1', map), WDC)
    assert.equal(leafDiskId('/dev/sdb', map), WDC)
  })

  it('an nvme partition reduces by its own rule', () => {
    const listing = [
      'nvme-QEMU_NVMe_Ctrl -> ../../nvme0n1',
      'nvme-QEMU_NVMe_Ctrl-part2 -> ../../nvme0n1p2',
    ].join('\n')
    assert.equal(leafDiskId('nvme0n1p2', parseDiskByIdListing(listing)), 'nvme-QEMU_NVMe_Ctrl')
  })

  it('a by-id leaf resolves to itself — the map is kernel-keyed, it was never a candidate', () => {
    // Whole-disk by-id and by-id partition leaves keep their own names.
    assert.equal(leafDiskId(WDC, map), WDC)
    assert.equal(leafDiskId(`${WDC}-part2`, map), `${WDC}-part2`)
  })

  it('a name nothing resolves keeps today\'s verbatim behaviour', () => {
    // A kernel name the listing does not know, and a name that is neither.
    assert.equal(leafDiskId('sdzz9', map), 'sdzz9')
    assert.equal(leafDiskId('dm-3', map), 'dm-3')
  })
})
