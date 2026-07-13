import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfirmStore } from '../confirm.js'

describe('ConfirmStore', () => {
  it('generates a code that verifies for the same operation and params', () => {
    const store = new ConfirmStore()
    const { code, expiresAt } = store.generateCode('zpool.destroy', { pool: 'tank' })
    assert.ok(code.length > 0)
    assert.ok(!Number.isNaN(Date.parse(expiresAt)))
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }), true)
  })

  it('is single-use — a consumed code cannot be reused', () => {
    const store = new ConfirmStore()
    const { code } = store.generateCode('zpool.export', { pool: 'tank' })
    assert.equal(store.verifyCode(code, 'zpool.export', { pool: 'tank' }), true)
    assert.equal(store.verifyCode(code, 'zpool.export', { pool: 'tank' }), false)
  })

  it('rejects an unknown / wrong code', () => {
    const store = new ConfirmStore()
    store.generateCode('zpool.destroy', { pool: 'tank' })
    assert.equal(store.verifyCode('not-a-real-code', 'zpool.destroy', { pool: 'tank' }), false)
  })

  it('rejects a code used against a different operation', () => {
    const store = new ConfirmStore()
    const { code } = store.generateCode('zpool.destroy', { pool: 'tank' })
    assert.equal(store.verifyCode(code, 'zpool.export', { pool: 'tank' }), false)
    // still consumable for the correct operation (mismatch does not consume)
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }), true)
  })

  it('rejects a code used against different params', () => {
    const store = new ConfirmStore()
    const { code } = store.generateCode('zpool.destroy', { pool: 'tank' })
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'other' }), false)
  })

  it('matches params regardless of key order', () => {
    const store = new ConfirmStore()
    const { code } = store.generateCode('op', { a: 1, b: 2 })
    assert.equal(store.verifyCode(code, 'op', { b: 2, a: 1 }), true)
  })

  it('verifies a code still inside the TTL window', () => {
    let now = 1000
    const store = new ConfirmStore({ ttlMs: 500, now: () => now })
    const { code } = store.generateCode('zpool.destroy', { pool: 'tank' })
    now = 1400 // within TTL
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }), true)
  })

  it('rejects an expired code', () => {
    let now = 1000
    const store = new ConfirmStore({ ttlMs: 500, now: () => now })
    const { code } = store.generateCode('zpool.destroy', { pool: 'tank' })
    now = 2000 // past expiry
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }), false)
  })
})
