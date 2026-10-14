import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SmbConfListEntry, SmbConfValue } from '../formats/smb-conf.js'
import { CreateSmbShareRequest, UpdateSmbGlobalConfigRequest } from '../schemas/shares.js'

/**
 * The per-format smb.conf layer from cr.13 (review H3(a), ruling (i)): a value
 * must be free of control characters and of a trailing `\` after whitespace
 * trim — Samba reads a trailing `\` as a line continuation, so a final
 * `valid users` entry `bob\` swallows the next line (e.g. `hosts allow`).
 */

describe('SmbConfValue', () => {
  it('accepts legitimate values — spaces, punctuation, a `=` inside, a mid-string `\\`', () => {
    for (const v of [
      '/mnt/My Data', // a path with spaces — legal, written verbatim
      'Bob\'s share', // comment punctuation
      'WORKGROUP',
      'ANAS Storage %v', // %v macros and spaces
      'DOMAIN\\alice', // Windows-style name — `\` mid-string is literal
      '10.0.0.0/24',
      'key=value',
    ])
      assert.equal(SmbConfValue.safeParse(v).success, true, JSON.stringify(v))
  })

  it('refuses the review\'s trailing-`\\` case in every spelling', () => {
    // The review H3(a) attack: a final `valid users` entry `bob\`.
    assert.equal(SmbConfValue.safeParse('bob\\').success, false)
    // With trailing whitespace the `\` still lands at the line end after the
    // trim, so it is refused too.
    assert.equal(SmbConfValue.safeParse('bob\\  ').success, false)
    assert.equal(SmbConfValue.safeParse('bob\\\t').success, false) // also a control char
    assert.equal(SmbConfValue.safeParse('/mnt/data\\').success, false)
  })

  it('refuses control characters (a newline is smb.conf line injection)', () => {
    for (const v of ['a\nb', 'a\rb', 'a\tb', 'a\x00b'])
      assert.equal(SmbConfValue.safeParse(v).success, false, JSON.stringify(v))
  })
})

describe('SmbConfListEntry', () => {
  it('accepts the legitimate entry vocabulary — @group, +netgroup, %U, DOMAIN\\user', () => {
    for (const e of ['alice', 'bob.smith', '@smbusers', '+trusted', '%U', 'DOMAIN\\alice', 'smbuser1_'])
      assert.equal(SmbConfListEntry.safeParse(e).success, true, JSON.stringify(e))
  })

  it('refuses an entry ending in `\\` (the continued line, wherever it sits)', () => {
    assert.equal(SmbConfListEntry.safeParse('bob\\').success, false)
    assert.equal(SmbConfListEntry.safeParse('bob\\ ').success, false)
  })

  it('refuses a list separator inside an entry — the writer joins with spaces, Samba splits on either', () => {
    // An entry that contains the join/split character is a DIFFERENT list on
    // read than it was on write, so it cannot be named by the request.
    for (const e of ['bob alice', 'bob,alice', 'bc\tusers'])
      assert.equal(SmbConfListEntry.safeParse(e).success, false, JSON.stringify(e))
  })
})

describe('the request schemas gate the smb.conf writer', () => {
  const base = { name: 'media', path: '/tank/media' }

  it('CreateSmbShareRequest refuses the review\'s `bob\` as a valid users / hosts entry', () => {
    for (const field of ['validUsers', 'hostsAllow', 'hostsDeny']) {
      const withTrailingBackslash = { ...base, [field]: ['alice', 'bob\\'] }
      assert.equal(CreateSmbShareRequest.safeParse(withTrailingBackslash).success, false, field)
    }
  })

  it('CreateSmbShareRequest refuses a comment or a path ending in `\` and any control char', () => {
    assert.equal(CreateSmbShareRequest.safeParse({ ...base, comment: 'ends\\' }).success, false)
    assert.equal(CreateSmbShareRequest.safeParse({ ...base, path: '/tank/media\\' }).success, false)
    assert.equal(CreateSmbShareRequest.safeParse({ ...base, comment: 'a\nb' }).success, false)
  })

  it('CreateSmbShareRequest accepts the legitimate share (a spaced path, @group, +group, %U)', () => {
    const ok = CreateSmbShareRequest.safeParse({
      name: 'media',
      path: '/tank/My Data',
      comment: 'the library',
      validUsers: ['@smbusers', '+netgroup', '%U'],
      hostsAllow: ['10.0.0.0/24', '192.168.1.'],
      hostsDeny: [],
    })
    assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues))
  })

  it('UpdateSmbGlobalConfigRequest refuses a workgroup/server string with a trailing `\`, accepts a normal one', () => {
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ workgroup: 'WORK\\' }).success, false)
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ serverString: 'ANAS %v' }).success, true)
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ interfaces: ['lo', 'eth0', '10.0.0.0/24'] }).success, true)
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ interfaces: ['eth0 eth1'] }).success, false)
  })

  it('the fixture (packages/daemon/fixtures/samba) carries only values the write side accepts', () => {
    // The review asks that the fixture still round-trips byte-identically;
    // that round trip lives in the daemon parser test (smb-conf.test.ts) and
    // runs unchanged here — this assertion is the new gate: every value the
    // fixture STORES must be one the request schemas would still write.
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../daemon/src/fixtures/samba/smb.conf'),
      'utf8',
    )
    // `@smbusers`, `media`, `@staff` … — real Samba entry spellings from the
    // fixture's `valid users` / `hosts allow` lines.
    const entries = ['media', '@smbusers', '10.0.0.0/24', '192.168.1.']
    for (const e of entries)
      assert.equal(SmbConfListEntry.safeParse(e).success, true, e)
    for (const v of ['Media library', 'Nightly backups', '/tank/media', 'ANAS Storage'])
      assert.equal(SmbConfValue.safeParse(v).success, true, v)
    assert.ok(fixture.includes('valid users = media @smbusers'))
  })
})
