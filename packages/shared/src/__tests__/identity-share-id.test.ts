import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CreateGroupRequest, CreateShareUserRequest, SHARE_ID_LIMIT, SHARE_ID_MIN } from '../schemas/identity.js'

/**
 * cr.29: Add takes an optional explicit uid/gid, a whole number inside the
 * share band [1000, 60000) — login.defs' UID_MAX 60000 itself is outside it
 * (WAVE2-DESIGN §11). Absent stays absent (ANAS picks one).
 */
describe('cr.29 — CreateShareUserRequest.uid / CreateGroupRequest.gid', () => {
  it('the band is [1000, 60000)', () => {
    assert.equal(SHARE_ID_MIN, 1000)
    assert.equal(SHARE_ID_LIMIT, 60000)
  })

  it('absent: parses without the field (the daemon picks one)', () => {
    assert.equal('uid' in CreateShareUserRequest.parse({ name: 'alice' }), false)
    assert.equal('gid' in CreateGroupRequest.parse({ name: 'media' }), false)
  })

  it('accepts the band edges 1000 and 59999', () => {
    for (const id of [1000, 1004, 59999]) {
      assert.equal(CreateShareUserRequest.parse({ name: 'alice', uid: id }).uid, id)
      assert.equal(CreateGroupRequest.parse({ name: 'media', gid: id }).gid, id)
    }
  })

  it('refuses 999, 60000 (login.defs UID_MAX), 0, a fraction, a string and null', () => {
    for (const id of [999, 60000, 0, 1004.5, '1004', null]) {
      assert.equal(CreateShareUserRequest.safeParse({ name: 'alice', uid: id }).success, false, `uid ${String(id)}`)
      assert.equal(CreateGroupRequest.safeParse({ name: 'media', gid: id }).success, false, `gid ${String(id)}`)
    }
  })

  it('names the band in the refusal', () => {
    const r = CreateShareUserRequest.safeParse({ name: 'alice', uid: 60000 })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0].message, /from 1000 to 59999 \(the share band\)/)
  })
})
