import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseZpoolList } from '../zpool-list.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs')

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}

describe('parseZpoolList', () => {
  it('parses mirror pool summary', () => {
    const result = parseZpoolList(loadFixture('zpool-list.json'))
    assert.equal(result.length, 1)
    const pool = result[0]
    assert.equal(pool.name, 'testpool')
    assert.equal(pool.state, 'ONLINE')
    assert.equal(pool.size, 480 * 1024 * 1024 * 1024)
    assert.ok(pool.allocated !== null && pool.allocated >= 0)
    assert.ok(pool.free !== null && pool.free > 0)
    assert.equal(pool.fragmentation, 12)
    assert.equal(pool.capacity, 37)
    assert.equal(pool.dedupRatio, 1.0)
  })

  it('parses raidz pool summary', () => {
    const result = parseZpoolList(loadFixture('zpool-list-raidz.json'))
    assert.equal(result.length, 1)
    const pool = result[0]
    assert.equal(pool.name, 'testpool-rz')
    assert.ok(pool.size !== null && pool.size > 0)
  })

  it('all sizes are numbers in bytes', () => {
    const result = parseZpoolList(loadFixture('zpool-list.json'))
    const pool = result[0]
    assert.equal(typeof pool.size, 'number')
    assert.equal(typeof pool.allocated, 'number')
    assert.equal(typeof pool.free, 'number')
    assert.equal(typeof pool.fragmentation, 'number')
    assert.equal(typeof pool.capacity, 'number')
    assert.equal(typeof pool.dedupRatio, 'number')
  })
})

// cr4 (P-3): the R2 probe's shapes. A pool whose `properties` bag is missing a
// field reads NULL for it (unknown), never a 0 it did not read, and a pool with
// no bag at all reads all six as unknown instead of throwing.
describe('cr4 P-3: a property the read did not return is NULL, never a zero', () => {
  it('a PARTIAL properties bag — the absent cells are null, the read ones parse', () => {
    const json = JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', properties: {
      size: { value: '9.1T', source: { type: 'NONE', data: '-' } },
      free: { value: '1.2T', source: { type: 'NONE', data: '-' } },
    } } } })
    assert.deepEqual(parseZpoolList(json), [{
      name: 'tank',
      state: 'ONLINE',
      size: Math.round(9.1 * 1024 ** 4),
      allocated: null,
      free: Math.round(1.2 * 1024 ** 4),
      fragmentation: null,
      capacity: null,
      dedupRatio: null,
    }])
  })

  it('NO properties bag at all — every cell null, and no throw', () => {
    const json = JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE' } } })
    assert.deepEqual(parseZpoolList(json), [{
      name: 'tank',
      state: 'ONLINE',
      size: null,
      allocated: null,
      free: null,
      fragmentation: null,
      capacity: null,
      dedupRatio: null,
    }])
  })
})

// Ground truth (stunt node, 2026-07-18): with zero pools, `zpool list -j`
// prints NOTHING (empty stdout, exit 0). A fresh node must not 500.
describe('parseZpoolList with no pools', () => {
  it('returns [] for empty stdout', () => {
    assert.deepEqual(parseZpoolList(''), [])
    assert.deepEqual(parseZpoolList('\n'), [])
  })
})
