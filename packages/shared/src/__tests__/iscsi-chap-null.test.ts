import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IscsiChapSecret, IscsiChapUserid } from '../schemas/iscsi.js'

/**
 * cr3 ISCSI-L12: the kernel clears a CHAP credential whose value STARTS with
 * `NULL` (a four-byte prefix compare), so such a value would be stored as
 * "not set" and every CHAP login would fail silently. Refused at the boundary.
 */
describe('cr3 ISCSI-L12 — a CHAP value that starts with NULL is refused', () => {
  it('refuses a username or a secret beginning with NULL', () => {
    assert.equal(IscsiChapUserid.safeParse('NULL').success, false)
    assert.equal(IscsiChapUserid.safeParse('NULLuser').success, false)
    assert.equal(IscsiChapSecret.safeParse('NULLsecret12').success, false)
    const r = IscsiChapSecret.safeParse('NULLsecret12')
    assert.match(r.success ? '' : r.error.issues[0].message, /may not start with 'NULL'/)
  })

  it('accepts NULL anywhere else, and lower case (the compare is case-sensitive)', () => {
    assert.equal(IscsiChapUserid.safeParse('userNULL').success, true)
    assert.equal(IscsiChapUserid.safeParse('nulluser').success, true)
    assert.equal(IscsiChapSecret.safeParse('secretNULL12').success, true)
  })
})
