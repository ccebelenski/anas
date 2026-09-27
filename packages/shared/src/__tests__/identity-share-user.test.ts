import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ShareUser } from '../schemas/identity.js'

/**
 * identity.3 (#68): `smbEntryMismatch` is ADDITIVE — an older daemon's row
 * (no field) still parses, and a mismatch row carries the stored name as a
 * string beside `smbEnabled: false`.
 */
const BASE = {
  name: 'Name',
  uid: 1001,
  fullName: null,
  primaryGroup: 'users',
  groups: ['users'],
  smbEnabled: false,
  locked: false,
  local: true,
}

describe('ShareUser.smbEntryMismatch (identity.3)', () => {
  it('parses a row without the field (absent = no mismatched entry)', () => {
    const parsed = ShareUser.parse(BASE)
    assert.equal('smbEntryMismatch' in parsed, false)
  })

  it('parses a row carrying the stored name', () => {
    assert.equal(ShareUser.parse({ ...BASE, smbEntryMismatch: 'name' }).smbEntryMismatch, 'name')
  })

  it('rejects a non-string mismatch', () => {
    assert.equal(ShareUser.safeParse({ ...BASE, smbEntryMismatch: true }).success, false)
  })
})
