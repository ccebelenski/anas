import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseZpoolUpgrade } from '../zpool-upgrade.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseZpoolUpgrade', () => {
  it('lists the pools with disabled features', () => {
    const pools = parseZpoolUpgrade(loadFixture('zpool-upgrade-pools.txt'))
    assert.deepEqual([...pools].sort(), ['pond', 'tank'])
  })

  it('does not mistake feature names, the header, or dashes for pools', () => {
    const pools = parseZpoolUpgrade(loadFixture('zpool-upgrade-pools.txt'))
    // Indented feature names must NOT appear as pool names.
    assert.ok(!pools.has('hole_birth'))
    assert.ok(!pools.has('embedded_data'))
    assert.ok(!pools.has('large_blocks'))
    // Structural rows must NOT appear either.
    assert.ok(!pools.has('POOL'))
    assert.ok(!pools.has('---------------'))
    assert.equal(pools.size, 2)
  })

  it('returns an empty set when every pool is fully upgraded', () => {
    const pools = parseZpoolUpgrade(loadFixture('zpool-upgrade-all-enabled.txt'))
    assert.equal(pools.size, 0)
  })

  it('returns an empty set for garbage / unrelated output (fail-open)', () => {
    assert.equal(parseZpoolUpgrade('').size, 0)
    assert.equal(parseZpoolUpgrade('mock: command not found').size, 0)
    assert.equal(parseZpoolUpgrade('{"unexpected":"json"}').size, 0)
    // Has the section marker but no table rows → still empty, no throw.
    assert.equal(
      parseZpoolUpgrade('Some supported features are not enabled on the following pools.\n').size,
      0,
    )
  })

  it('handles CRLF line endings', () => {
    const crlf = loadFixture('zpool-upgrade-pools.txt').replace(/\n/g, '\r\n')
    const pools = parseZpoolUpgrade(crlf)
    assert.deepEqual([...pools].sort(), ['pond', 'tank'])
  })
})
