import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseZpoolGet } from '../zpool-get.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs')

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}

describe('parseZpoolGet', () => {
  it('parses typed properties', () => {
    const result = parseZpoolGet(loadFixture('zpool-get-all.json'), 'testpool')
    assert.ok(result)
    assert.equal(typeof result.ashift, 'number')
    assert.equal(result.autoexpand, false)
    assert.equal(result.autoreplace, false)
    assert.equal(result.autotrim, false)
    assert.equal(result.failmode, 'wait')
  })

  it('returns null for unknown pool', () => {
    const result = parseZpoolGet(loadFixture('zpool-get-all.json'), 'nonexistent')
    assert.equal(result, null)
  })

  it('includes full property bag when requested', () => {
    const result = parseZpoolGet(loadFixture('zpool-get-all.json'), 'testpool', true)
    assert.ok(result)
    assert.ok(result.all)
    assert.ok(Object.keys(result.all).length > 10)
    assert.equal(typeof result.all['ashift'], 'string')
    assert.equal(typeof result.all['failmode'], 'string')
  })

  it('omits full property bag by default', () => {
    const result = parseZpoolGet(loadFixture('zpool-get-all.json'), 'testpool')
    assert.ok(result)
    assert.equal(result.all, undefined)
  })
})
