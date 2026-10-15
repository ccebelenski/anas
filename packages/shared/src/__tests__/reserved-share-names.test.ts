import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NewShareName, reservedSmbSection, ShareName } from '../schemas/common.js'
import { CreateSmbShareRequest, UpdateSmbShareRequest } from '../schemas/shares.js'

/**
 * Story cr.20 (audit #23): `global`, `homes` and `printers` are Samba's
 * special section names — a share ANAS created under one of them collides
 * with Samba's own handling of the section (a second `[global]` is merged),
 * and ANAS could neither show nor delete the stanza it wrote. The create door
 * refuses them case-insensitively (Samba matches section names
 * case-insensitively); reads keep the plain ShareName.
 */

const MINIMAL = { path: '/srv/share' }

describe('reserved Samba section names (cr.20, audit #23)', () => {
  it('folds case and matches whole names only', () => {
    assert.equal(reservedSmbSection('global'), 'global')
    assert.equal(reservedSmbSection('GLOBAL'), 'global')
    assert.equal(reservedSmbSection('Homes'), 'homes')
    assert.equal(reservedSmbSection('PRINTERS'), 'printers')
    assert.equal(reservedSmbSection('globals'), null)
    assert.equal(reservedSmbSection('home'), null)
    assert.equal(reservedSmbSection('printer'), null)
    assert.equal(reservedSmbSection('homes-x'), null)
    assert.equal(reservedSmbSection(''), null)
  })

  it('NewShareName refuses each reserved name in mixed case', () => {
    for (const name of ['global', 'Global', 'GLOBAL', 'homes', 'HOMEs', 'printers', 'Printers', 'PRINTERS']) {
      const r = NewShareName.safeParse(name)
      assert.equal(r.success, false, name)
      assert.match(r.error!.issues[0].message, /reserved Samba section name/)
    }
  })

  it('accepts the near misses', () => {
    for (const name of ['globals', 'home', 'printer', 'homes-x', 'globalizer', 'Printing', 'homesX']) {
      assert.equal(NewShareName.safeParse(name).success, true, name)
    }
  })

  it('the create request carries the gate', () => {
    for (const name of ['global', 'Global', 'Homes', 'PRINTERS']) {
      assert.equal(CreateSmbShareRequest.safeParse({ ...MINIMAL, name }).success, false, name)
    }
    for (const name of ['globals', 'home', 'printer']) {
      assert.equal(CreateSmbShareRequest.safeParse({ ...MINIMAL, name }).success, true, name)
    }
  })

  it('reads stay lenient and the update door carries no name', () => {
    // A hand-written [homes] with a path stays a listable, manageable share.
    for (const name of ['global', 'homes', 'printers'])
      assert.equal(ShareName.safeParse(name).success, true, name)
    // The PUT route only ever addresses an EXISTING share (404 otherwise) —
    // its schema has no name field that could reintroduce one.
    assert.equal('name' in UpdateSmbShareRequest.shape, false)
  })
})
