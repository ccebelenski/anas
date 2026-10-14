import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeFstabField, FstabOptionList, FstabOptionToken, fstabOptionTokens, unescapeFstabField, X_ANAS_DISABLED_KEPT_TOKEN, X_ANAS_DISABLED_TOKEN } from '../formats/fstab.js'

/**
 * The per-format /etc/fstab layer from cr.2 (review C2, ruling (i)): octal
 * field escaping exactly as getmntent(3) reads it (space `\040`, tab `\011`,
 * newline `\012`, backslash `\134`, `#` `\043`) and the OPTIONS-token list.
 */

const HOSTILE_MOUNTPOINT = '/usr nfs4 rw 0 0 #' // the review C2 attack string

describe('escapeFstabField', () => {
  it('escapes space, tab, newline, backslash and # to their octal forms', () => {
    assert.equal(escapeFstabField('/mnt/My Share'), '/mnt/My\\040Share')
    assert.equal(escapeFstabField('/mnt/a\tb'), '/mnt/a\\011b')
    assert.equal(escapeFstabField('/mnt/a\nb'), '/mnt/a\\012b')
    assert.equal(escapeFstabField('/mnt/a\\b'), '/mnt/a\\134b')
    // A `#` inside a field is data to both libmount and glibc; only a leading one is escaped.
    assert.equal(escapeFstabField('/mnt/a#b'), '/mnt/a#b')
    assert.equal(escapeFstabField('#spec'), '\\043spec')
  })

  it('escapes the review\'s hostile mountpoint into ONE field', () => {
    assert.equal(escapeFstabField(HOSTILE_MOUNTPOINT), '/usr\\040nfs4\\040rw\\0400\\0400\\040#')
  })

  it('backslash is escaped FIRST — an already-escaped token round-trips', () => {
    // A literal `\040` (the four characters) must become `\134040` so a later
    // unescape cannot mistake the backslash for an escape introducer.
    assert.equal(escapeFstabField('/mnt/My\\040Share'), '/mnt/My\\134040Share')
  })

  it('a plain field passes through byte-identical', () => {
    assert.equal(escapeFstabField('/usr'), '/usr')
    assert.equal(escapeFstabField('//nas/My Share'), '//nas/My\\040Share')
  })
})

describe('unescapeFstabField', () => {
  it('decodes each octal escape to its character', () => {
    assert.equal(unescapeFstabField('/mnt/My\\040Share'), '/mnt/My Share')
    assert.equal(unescapeFstabField('/mnt/a\\011b'), '/mnt/a\tb')
    assert.equal(unescapeFstabField('/mnt/a\\012b'), '/mnt/a\nb')
    assert.equal(unescapeFstabField('/mnt/a\\134b'), '/mnt/a\\b')
    assert.equal(unescapeFstabField('/mnt/a\\043b'), '/mnt/a#b')
  })

  it('decodes any 3-octal-digit escape, leaving other backslashes alone', () => {
    assert.equal(unescapeFstabField('a\\1x'), 'a\\1x') // one digit
    assert.equal(unescapeFstabField('a\\40b'), 'a\\40b') // two digits
    assert.equal(unescapeFstabField('a\\8b'), 'a\\8b') // non-octal digit
    assert.equal(unescapeFstabField('a\\b'), 'a\\b') // bare backslash
    assert.equal(unescapeFstabField('a\\'), 'a\\') // trailing backslash
    assert.equal(unescapeFstabField('a\\123b'), 'aSb') // \123 → 'S'
  })

  it('handles a run of escapes left to right', () => {
    assert.equal(unescapeFstabField('a\\040b\\011c\\012d\\134e\\043f'), 'a b\tc\nd\\e#f')
  })
})

describe('escape ⇄ unescape round trips', () => {
  it('field → escape → unescape recovers the original for every special char', () => {
    const samples = ['/mnt/My Share', '/mnt/a\tb', '/mnt/a\nb', '/mnt/a\\b', '/mnt/a#b', '/mnt/a b\\c#d\te']
    for (const s of samples)
      assert.equal(unescapeFstabField(escapeFstabField(s)), s)
  })

  it('escape is injective — two different fields never escape alike', () => {
    assert.notEqual(escapeFstabField('/mnt/a\\040b'), escapeFstabField('/mnt/a b'))
  })

  it('the hostile mountpoint survives the full round trip', () => {
    assert.equal(unescapeFstabField(escapeFstabField(HOSTILE_MOUNTPOINT)), HOSTILE_MOUNTPOINT)
  })
})

describe('FstabOptionToken', () => {
  it('accepts the real option vocabulary', () => {
    for (const t of ['nofail', 'ro', 'rw', '_netdev', 'x-systemd.automount', 'vers=4.2', 'vers=default', 'x-systemd.idle-timeout=60', 'x-systemd.requires=/opt', 'credentials=/etc/anas/creds/anastest.cred', 'uid=1002', 'nfsvers=3'])
      assert.equal(FstabOptionToken.safeParse(t).success, true, t)
    // The story's accepted-and-written-verbatim case.
    assert.equal(FstabOptionList.safeParse('vers=4.2,x-systemd.requires=/opt').success, true)
  })

  it('refuses whitespace, control characters and the escape-requiring set', () => {
    for (const t of ['', 'a b', 'a\tb', 'a\nb', 'a,b', 'a#b', 'a"b', 'a\\b', '=x', 'key='])
      assert.equal(FstabOptionToken.safeParse(t).success, false, JSON.stringify(t))
  })
})

describe('FstabOptionList', () => {
  it('accepts the empty list and a well-formed list', () => {
    assert.equal(FstabOptionList.safeParse('').success, true)
    assert.equal(FstabOptionList.safeParse('nofail').success, true)
    assert.equal(FstabOptionList.safeParse('vers=4.2,x-systemd.requires=/opt').success, true)
  })

  it('refuses empty tokens, spaces and control characters anywhere', () => {
    for (const s of ['a,,b', ',a', 'a,', 'a b', 'a, b', 'a\nb', 'a\tb'])
      assert.equal(FstabOptionList.safeParse(s).success, false, JSON.stringify(s))
  })

  it('fstabOptionTokens splits commas and treats the empty string as nothing', () => {
    assert.deepEqual(fstabOptionTokens(''), [])
    assert.deepEqual(fstabOptionTokens('nofail'), ['nofail'])
    assert.deepEqual(fstabOptionTokens('vers=4.2,x-systemd.requires=/opt'), ['vers=4.2', 'x-systemd.requires=/opt'])
  })
})

describe('cr.6 — the disable tokens are valid fstab option tokens', () => {
  it('both spellings ANAS writes stay inside the token grammar (a token-clean OPTIONS column)', () => {
    assert.equal(FstabOptionToken.safeParse(X_ANAS_DISABLED_TOKEN).success, true)
    assert.equal(FstabOptionToken.safeParse(X_ANAS_DISABLED_KEPT_TOKEN).success, true)
    // …and the comma list exactly as the daemon writes it is a valid list.
    assert.equal(FstabOptionList.safeParse(`noauto,${X_ANAS_DISABLED_TOKEN}`).success, true)
    assert.equal(FstabOptionList.safeParse(`noauto,${X_ANAS_DISABLED_KEPT_TOKEN}`).success, true)
  })
})
