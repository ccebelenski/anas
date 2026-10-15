import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CreateGroupRequest, CreateShareUserRequest, SHARE_ID_MAX, SHARE_ID_MIN } from '../schemas/identity.js'

/**
 * cr.29: Add takes an optional explicit uid/gid, a whole number inside the
 * share band — [1000, 60000] INCLUSIVE since cr.29c, login.defs' own
 * UID_MIN..UID_MAX (login.defs(5) defaults 1000 / 60000; PVE 9.2's file says
 * the same, probe P06). Absent stays absent (ANAS picks one).
 */
describe('cr.29 — CreateShareUserRequest.uid / CreateGroupRequest.gid', () => {
  it('the band is [1000, 60000], inclusive (cr.29c)', () => {
    assert.equal(SHARE_ID_MIN, 1000)
    assert.equal(SHARE_ID_MAX, 60000)
  })

  it('absent: parses without the field (the daemon picks one)', () => {
    assert.equal('uid' in CreateShareUserRequest.parse({ name: 'alice' }), false)
    assert.equal('gid' in CreateGroupRequest.parse({ name: 'media' }), false)
  })

  it('accepts the band edges 1000 and 60000 (login.defs UID_MAX, cr.29c)', () => {
    for (const id of [1000, 1004, 59999, 60000]) {
      assert.equal(CreateShareUserRequest.parse({ name: 'alice', uid: id }).uid, id)
      assert.equal(CreateGroupRequest.parse({ name: 'media', gid: id }).gid, id)
    }
  })

  it('refuses 999, 60001, 0, a fraction, a string and null', () => {
    for (const id of [999, 60001, 0, 1004.5, '1004', null]) {
      assert.equal(CreateShareUserRequest.safeParse({ name: 'alice', uid: id }).success, false, `uid ${String(id)}`)
      assert.equal(CreateGroupRequest.safeParse({ name: 'media', gid: id }).success, false, `gid ${String(id)}`)
    }
  })

  it('names the band in the refusal', () => {
    const r = CreateShareUserRequest.safeParse({ name: 'alice', uid: 60001 })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0].message, /from 1000 to 60000 \(the share band\)/)
  })
})

/**
 * cr.29c (3): Add may name an existing PRIMARY group, a strict identity name
 * like `groups` (it reaches `useradd -g` only as the gid the route read, but a
 * name that is not an identity name never gets that far). Absent stays absent.
 */
describe('cr.29c — CreateShareUserRequest.primaryGroup', () => {
  it('absent stays absent; an identity name parses', () => {
    assert.equal('primaryGroup' in CreateShareUserRequest.parse({ name: 'alice' }), false)
    assert.equal(CreateShareUserRequest.parse({ name: 'alice', primaryGroup: 'media' }).primaryGroup, 'media')
  })

  it('refuses an option-shaped, empty, spaced or numeric value', () => {
    for (const g of ['-g0', '', 'my group', 100, null]) {
      assert.equal(CreateShareUserRequest.safeParse({ name: 'alice', primaryGroup: g }).success, false, String(g))
    }
  })
})
