import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseZfsVersion, supportsRaidzExpansion } from '../zfs-version.js'

describe('parseZfsVersion', () => {
  it('parses the userland line from `zfs version` output', () => {
    const v = parseZfsVersion('zfs-2.3.1-1\nzfs-kmod-2.3.1-1\n')
    assert.deepEqual(v, { raw: '2.3.1', major: 2, minor: 3, patch: 1 })
  })

  it('parses a kmod-only line as a fallback', () => {
    const v = parseZfsVersion('zfs-kmod-2.2.6-pve1\n')
    assert.deepEqual(v, { raw: '2.2.6', major: 2, minor: 2, patch: 6 })
  })

  it('returns null for unrecognizable output', () => {
    assert.equal(parseZfsVersion(''), null)
    assert.equal(parseZfsVersion('command not found'), null)
  })
})

describe('supportsRaidzExpansion (≥ 2.3.0 boundary)', () => {
  it('accepts exactly 2.3.0', () => {
    assert.equal(supportsRaidzExpansion({ raw: '2.3.0', major: 2, minor: 3, patch: 0 }), true)
  })

  it('accepts higher minors and majors', () => {
    assert.equal(supportsRaidzExpansion({ raw: '2.4.0', major: 2, minor: 4, patch: 0 }), true)
    assert.equal(supportsRaidzExpansion({ raw: '3.0.0', major: 3, minor: 0, patch: 0 }), true)
  })

  it('rejects 2.2.x (the pre-expansion line)', () => {
    assert.equal(supportsRaidzExpansion({ raw: '2.2.6', major: 2, minor: 2, patch: 6 }), false)
  })

  it('rejects older majors and a null version', () => {
    assert.equal(supportsRaidzExpansion({ raw: '1.9.9', major: 1, minor: 9, patch: 9 }), false)
    assert.equal(supportsRaidzExpansion(null), false)
  })
})
