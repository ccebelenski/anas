import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { forbiddenMessage, PrivilegeList, RequestHeaders } from '../schemas/api.js'

/**
 * cr.28: `x-anas-privileges` is part of the request identity the daemon
 * validates with RequestHeaders. The gateway joins the privileges PVE granted
 * with ',' (proxy.ts) — that exact shape parses; anything else is refused.
 */
describe('PrivilegeList (x-anas-privileges)', () => {
  it('reads the shapes the gateway sends: both, one, none', () => {
    assert.deepEqual(PrivilegeList.parse('Sys.Audit,Sys.Modify'), ['Sys.Audit', 'Sys.Modify'])
    assert.deepEqual(PrivilegeList.parse('Sys.Audit'), ['Sys.Audit'])
    assert.deepEqual(PrivilegeList.parse('Sys.Modify'), ['Sys.Modify'])
    assert.deepEqual(PrivilegeList.parse(''), [])
  })

  it('refuses garbage: an unknown name, a repeat, whitespace (two joined headers), a stray comma, a wrong case', () => {
    for (const bad of ['Sys.Root', 'Sys.Audit,Sys.Audit', 'Sys.Audit, Sys.Modify', 'Sys.Audit,', ',', 'sys.modify', 'Sys.Modify ', 'yes'])
      assert.equal(PrivilegeList.safeParse(bad).success, false, JSON.stringify(bad))
  })
})

describe('RequestHeaders requires x-anas-privileges (cr.28: no "absent means trusted")', () => {
  const base = {
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-request-id': '550e8400-e29b-41d4-a716-446655440000',
  }

  it('without the header the identity does not parse', () => {
    assert.equal(RequestHeaders.safeParse(base).success, false)
  })

  it('with a garbage header the identity does not parse', () => {
    assert.equal(RequestHeaders.safeParse({ ...base, 'x-anas-privileges': 'Sys.Everything' }).success, false)
  })

  it('with a valid header the privileges ride as a list (none is a valid answer)', () => {
    const r = RequestHeaders.parse({ ...base, 'x-anas-privileges': 'Sys.Audit' })
    assert.deepEqual(r['x-anas-privileges'], ['Sys.Audit'])
    assert.deepEqual(RequestHeaders.parse({ ...base, 'x-anas-privileges': '' })['x-anas-privileges'], [])
  })
})

describe('forbiddenMessage', () => {
  it('is the gateway\'s 403 sentence (WAVE2-DESIGN §5 row 11), now defined once', () => {
    assert.equal(
      forbiddenMessage('anas-audit@pve', 'Sys.Modify'),
      'Permission check failed (/, Sys.Modify): anas-audit@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations.',
    )
  })
})
