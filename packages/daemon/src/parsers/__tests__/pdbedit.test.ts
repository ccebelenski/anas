import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parsePdbeditEntries,
  passdbEntry,
  passdbOwnedByOther,
  passdbServes,
  PDBEDIT_UNMAPPED_UID,
  sameIdentityName,
} from '../pdbedit.js'

/**
 * `pdbedit -L` lines in the shape the #68 reproduction showed on the stunt
 * node (2026-09-25): `name:uid:fullname`, a trailing empty fullname for a user
 * created without one, and `4294967295` ((uid_t)-1) for a stored name no Unix
 * account answers to — the orphan `smbpasswd -a Name` leaves behind.
 */
const EXACT = 'Name:1001:\n'
const ORPHAN = 'name:4294967295:\n'
const LISTING = [
  'smbtest:1000:',
  'media:1002:Media User',
  'name:4294967295:',
  'odd:1003:Full: With Colon',
  '',
].join('\n')

describe('parsePdbeditEntries', () => {
  it('collects the stored name and resolved uid of every line', () => {
    assert.deepEqual(parsePdbeditEntries(LISTING), [
      { stored: 'smbtest', uid: 1000 },
      { stored: 'media', uid: 1002 },
      { stored: 'name', uid: null },
      { stored: 'odd', uid: 1003 },
    ])
  })

  it('maps the unmapped uid (4294967295) to null', () => {
    assert.equal(PDBEDIT_UNMAPPED_UID, 4294967295)
    assert.deepEqual(parsePdbeditEntries(ORPHAN), [{ stored: 'name', uid: null }])
  })

  it('treats a missing or non-numeric uid field as unmapped', () => {
    assert.deepEqual(parsePdbeditEntries('bare\nweird:x:\n'), [
      { stored: 'bare', uid: null },
      { stored: 'weird', uid: null },
    ])
  })

  it('returns no entries for empty output and skips nameless lines', () => {
    assert.deepEqual(parsePdbeditEntries(''), [])
    assert.deepEqual(parsePdbeditEntries('\n\n'), [])
    assert.deepEqual(parsePdbeditEntries(':1000:x\n'), [])
  })
})

describe('sameIdentityName (identity.1b)', () => {
  it('folds case in both directions', () => {
    assert.equal(sameIdentityName('Alice', 'alice'), true)
    assert.equal(sameIdentityName('alice', 'ALICE'), true)
    assert.equal(sameIdentityName('backup-svc', 'backup-svc'), true)
  })

  it('is false for different names', () => {
    assert.equal(sameIdentityName('alice', 'alice2'), false)
    assert.equal(sameIdentityName('alice', 'alicex'), false)
    assert.equal(sameIdentityName('', ''), true)
    assert.equal(sameIdentityName('', 'a'), false)
  })
})

describe('passdbEntry (identity.3) — the entry Samba would use, found case-folded', () => {
  it('exact match', () => {
    assert.deepEqual(passdbEntry(parsePdbeditEntries(EXACT), 'Name'), { stored: 'Name', uid: 1001 })
  })

  it('case-mismatched orphan: found under the account name, stored name kept', () => {
    assert.deepEqual(passdbEntry(parsePdbeditEntries(ORPHAN), 'Name'), { stored: 'name', uid: null })
  })

  it('absent', () => {
    assert.equal(passdbEntry(parsePdbeditEntries(LISTING), 'bob'), null)
    assert.equal(passdbEntry(parsePdbeditEntries(LISTING), 'namex'), null)
    assert.equal(passdbEntry([], 'Name'), null)
  })

  it('prefers the exact-case entry when a backend lists both', () => {
    const entries = parsePdbeditEntries('name:4294967295:\nName:1001:\n')
    assert.deepEqual(passdbEntry(entries, 'Name'), { stored: 'Name', uid: 1001 })
  })
})

describe('passdbServes (identity.3) — exact case AND the account uid', () => {
  it('exact match with the account uid serves', () => {
    const e = passdbEntry(parsePdbeditEntries(EXACT), 'Name')
    assert.equal(passdbServes(e, 'Name', 1001), true)
  })

  it('a case-mismatched orphan does not serve', () => {
    const e = passdbEntry(parsePdbeditEntries(ORPHAN), 'Name')
    assert.equal(passdbServes(e, 'Name', 1001), false)
  })

  it('an unmapped uid does not serve even under the exact name', () => {
    const e = passdbEntry(parsePdbeditEntries('Name:4294967295:\n'), 'Name')
    assert.equal(passdbServes(e, 'Name', 1001), false)
  })

  it('a case-different entry mapped to the same uid does not serve (exact case is the rule)', () => {
    const e = passdbEntry(parsePdbeditEntries('ALICE:1000:\n'), 'Alice')
    assert.equal(passdbServes(e, 'Alice', 1000), false)
  })

  it('a uid other than the account uid does not serve', () => {
    const e = passdbEntry(parsePdbeditEntries('Name:1002:\n'), 'Name')
    assert.equal(passdbServes(e, 'Name', 1001), false)
  })

  it('absent does not serve', () => {
    assert.equal(passdbServes(null, 'Name', 1001), false)
  })
})

describe('passdbOwnedByOther (identity.3) — never replace another live account\'s entry', () => {
  it('an entry mapped to a different uid belongs to another account', () => {
    assert.equal(passdbOwnedByOther({ stored: 'name', uid: 1000 }, 1001), true)
    // An account that does not exist yet: any mapped entry is someone else's.
    assert.equal(passdbOwnedByOther({ stored: 'name', uid: 1000 }, null), true)
  })

  it('an unmapped entry is an orphan — nobody\'s', () => {
    assert.equal(passdbOwnedByOther({ stored: 'name', uid: null }, 1001), false)
    assert.equal(passdbOwnedByOther({ stored: 'name', uid: null }, null), false)
  })

  it('an entry mapped to the account\'s own uid is its own; absent is nobody\'s', () => {
    assert.equal(passdbOwnedByOther({ stored: 'ALICE', uid: 1000 }, 1000), false)
    assert.equal(passdbOwnedByOther(null, 1000), false)
  })
})
