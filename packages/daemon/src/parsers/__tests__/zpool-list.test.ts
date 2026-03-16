import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
    assert.ok(pool.allocated >= 0)
    assert.ok(pool.free > 0)
    assert.equal(pool.fragmentation, 12)
    assert.equal(pool.capacity, 37)
    assert.equal(pool.dedupRatio, 1.0)
  })

  it('parses raidz pool summary', () => {
    const result = parseZpoolList(loadFixture('zpool-list-raidz.json'))
    assert.equal(result.length, 1)
    const pool = result[0]
    assert.equal(pool.name, 'testpool-rz')
    assert.ok(pool.size > 0)
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
