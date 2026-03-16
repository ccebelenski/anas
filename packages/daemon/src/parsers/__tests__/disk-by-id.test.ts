import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDiskByIdListing } from '../disk-by-id.js'

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
