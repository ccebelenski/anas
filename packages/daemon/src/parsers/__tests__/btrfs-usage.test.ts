import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { btrfsUsageArgs, parseBtrfsUsage } from '../btrfs-usage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseBtrfsUsage', () => {
  it('parses the full stage-0 capture (Overall + profile sections)', () => {
    const u = parseBtrfsUsage(loadFixture('btrfs-usage.txt'))
    assert.equal(u.deviceSizeBytes, 2671771648)
    assert.equal(u.deviceAllocatedBytes, 292290560)
    assert.equal(u.deviceUnallocatedBytes, 2379481088)
    assert.equal(u.deviceMissingBytes, 0)
    assert.equal(u.usedBytes, 294912)
    assert.equal(u.freeEstimatedBytes, 2387869696)
    assert.equal(u.freeEstimatedMinBytes, 1198129152)
    assert.equal(u.freeStatfsBytes, 2386821120)
    assert.equal(u.globalReserveBytes, 5767168)
    // -d single -m dup — the enforced AHR profile (never btrfs raid5/6).
    assert.equal(u.dataProfile, 'single')
    assert.equal(u.metadataProfile, 'DUP')
    assert.equal(u.systemProfile, 'DUP')
  })

  it('tolerates truncated output (phase-B head-12 capture — Overall only)', () => {
    const u = parseBtrfsUsage(loadFixture('btrfs-usage-truncated.txt'))
    assert.equal(u.deviceSizeBytes, 4810866688)
    assert.equal(u.usedBytes, 538247168)
    assert.equal(u.freeEstimatedBytes, 3990093824)
    assert.equal(u.freeEstimatedMinBytes, 1995046912)
    // Profile sections truncated away → null, not a throw.
    assert.equal(u.dataProfile, null)
    assert.equal(u.metadataProfile, null)
  })

  it('is total: empty/garbage input yields all-null fields', () => {
    const u = parseBtrfsUsage('')
    assert.equal(u.deviceSizeBytes, null)
    assert.equal(u.usedBytes, null)
    assert.equal(u.freeEstimatedBytes, null)
    const g = parseBtrfsUsage('random text\nwith: colons\n')
    assert.equal(g.deviceSizeBytes, null)
  })
})

describe('btrfsUsageArgs', () => {
  it('always requests raw bytes (-b)', () => {
    assert.deepEqual(
      btrfsUsageArgs('/mnt/anas-ahr/ahr0'),
      ['filesystem', 'usage', '-b', '/mnt/anas-ahr/ahr0'],
    )
  })
})
