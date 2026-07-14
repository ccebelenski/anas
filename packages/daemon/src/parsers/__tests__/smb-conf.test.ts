import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addShare,
  getShare,
  hasShare,
  normalizeKey,
  parseDoc,
  parseSmbConf,
  removeShare,
  serializeDoc,
  updateGlobal,
  updateShare,
} from '../smb-conf.js'

// A deliberately gnarly, realistic fixture: leading comments, [global] with an
// unknown directive, two shares, odd/tab/space whitespace, both `#` and `;`
// comments, an alternate spelling (`browsable`), a line continuation, a blank
// line inside a stanza, and NO trailing newline is added below on purpose in
// one variant. This is the round-trip torture test.
const FIXTURE = [
  '# ANAS test smb.conf',
  '; a semicolon comment',
  '',
  '[global]',
  '\tworkgroup = WORKGROUP',
  '   server string = Odd   Whitespace   Server',
  '\tinterfaces = lo eth0 10.0.0.0/24',
  '\tbind interfaces only = yes',
  '\t# unknown-to-ANAS directive, must survive verbatim',
  '\tlog level = 2',
  '',
  '[media]',
  '\tcomment = Media library',
  '\tpath = /tank/media',
  '\tBrowseable = Yes',
  '\tRead Only = No',
  '\tvalid users = alice bob \\',
  '\t\t@staff',
  '',
  '[archive]',
  '\tpath = /tank/archive',
  '\tbrowsable = no',
  '\tread only = yes',
  '\thosts allow = 10.0.0.0/24, 192.168.1.',
  '',
].join('\n')

describe('smb-conf round-trip fidelity', () => {
  it('parse → serialize is byte-identical (LF)', () => {
    assert.equal(serializeDoc(parseDoc(FIXTURE)), FIXTURE)
  })

  it('parse → serialize is byte-identical with a file that has NO trailing newline', () => {
    const noTrailing = FIXTURE.replace(/\n+$/, '')
    assert.equal(serializeDoc(parseDoc(noTrailing)), noTrailing)
  })

  it('parse → serialize preserves CRLF line endings exactly', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n')
    assert.equal(serializeDoc(parseDoc(crlf)), crlf)
  })

  it('parse → serialize preserves an empty file', () => {
    assert.equal(serializeDoc(parseDoc('')), '')
  })

  it('parse → serialize preserves a comments-only (headerless) file', () => {
    const only = '# just a comment\n; another\n\n'
    assert.equal(serializeDoc(parseDoc(only)), only)
  })
})

describe('parseSmbConf typed model', () => {
  it('extracts the global config, including a space-separated interfaces list', () => {
    const { global } = parseSmbConf(FIXTURE)
    assert.equal(global.workgroup, 'WORKGROUP')
    assert.equal(global.serverString, 'Odd   Whitespace   Server')
    assert.deepEqual(global.interfaces, ['lo', 'eth0', '10.0.0.0/24'])
    assert.equal(global.bindInterfacesOnly, true)
  })

  it('lists all path-based shares (case/space-insensitive keys, alt spellings)', () => {
    const { shares } = parseSmbConf(FIXTURE)
    const names = shares.map(s => s.name).sort()
    assert.deepEqual(names, ['archive', 'media'])

    const media = shares.find(s => s.name === 'media')!
    assert.equal(media.path, '/tank/media')
    assert.equal(media.comment, 'Media library')
    assert.equal(media.browseable, true) // "Browseable = Yes"
    assert.equal(media.readOnly, false) // "Read Only = No"
    assert.equal(media.guestOk, false) // absent → default no
    // valid users spans a line continuation.
    assert.deepEqual(media.validUsers, ['alice', 'bob', '@staff'])

    const archive = shares.find(s => s.name === 'archive')!
    assert.equal(archive.browseable, false) // "browsable = no" (alt spelling)
    assert.equal(archive.readOnly, true)
    assert.deepEqual(archive.hostsAllow, ['10.0.0.0/24', '192.168.1.'])
  })

  it('getShare / hasShare are case-insensitive', () => {
    assert.equal(hasShare(FIXTURE, 'MEDIA'), true)
    assert.equal(hasShare(FIXTURE, 'nope'), false)
    assert.equal(hasShare(FIXTURE, 'global'), false) // global is not a share
    assert.equal(getShare(FIXTURE, 'Archive')!.path, '/tank/archive')
    assert.equal(getShare(FIXTURE, 'global'), null)
  })

  it('normalizeKey folds case and whitespace', () => {
    assert.equal(normalizeKey('Read Only'), 'readonly')
    assert.equal(normalizeKey('read only'), 'readonly')
    assert.equal(normalizeKey('readonly'), 'readonly')
    assert.equal(normalizeKey('  Guest   OK '), 'guestok')
  })
})

describe('addShare — appends only, existing bytes untouched', () => {
  it('leaves all prior content byte-identical and appends the new stanza', () => {
    const next = addShare(FIXTURE, {
      name: 'photos',
      path: '/tank/photos',
      comment: 'Family photos',
    })
    assert.ok(next.startsWith(FIXTURE), 'existing content must be a verbatim prefix')
    const appended = next.slice(FIXTURE.length)
    assert.equal(appended, [
      '',
      '[photos]',
      '\tpath = /tank/photos',
      '\tcomment = Family photos',
      '\tbrowseable = yes',
      '\tread only = no',
      '\tguest ok = no',
      '',
    ].join('\n'))
    // And the new share round-trips through the typed model.
    const share = getShare(next, 'photos')!
    assert.equal(share.path, '/tank/photos')
    assert.equal(share.readOnly, false)
  })

  it('writes explicit lists and non-default booleans', () => {
    const next = addShare('', {
      name: 'secure',
      path: '/tank/secure',
      readOnly: true,
      guestOk: false,
      validUsers: ['alice', '@admins'],
      hostsAllow: ['10.0.0.0/8'],
    })
    const share = getShare(next, 'secure')!
    assert.equal(share.readOnly, true)
    assert.deepEqual(share.validUsers, ['alice', '@admins'])
    assert.deepEqual(share.hostsAllow, ['10.0.0.0/8'])
  })
})

describe('updateShare — changes ONLY the target key line', () => {
  it('rewrites a single value and leaves every other byte identical', () => {
    const next = updateShare(FIXTURE, 'media', { readOnly: true })
    const before = FIXTURE.split('\n')
    const after = next.split('\n')
    assert.equal(before.length, after.length, 'no lines added or removed')
    const changed = before.map((l, i) => [i, l, after[i]] as const).filter(([, b, a]) => b !== a)
    assert.equal(changed.length, 1, 'exactly one line changed')
    const [idx, oldLine, newLine] = changed[0]
    assert.equal(oldLine, '\tRead Only = No')
    // Only the value flips; the original key spelling + spacing are preserved.
    assert.equal(newLine, '\tRead Only = yes')
    assert.equal(after[idx - 1], before[idx - 1])
    assert.equal(after[idx + 1], before[idx + 1])
    assert.equal(getShare(next, 'media')!.readOnly, true)
  })

  it('adds a missing key inside the stanza without disturbing siblings', () => {
    const next = updateShare(FIXTURE, 'archive', { guestOk: true })
    assert.equal(getShare(next, 'archive')!.guestOk, true)
    // media + global are untouched.
    assert.equal(getShare(next, 'media')!.validUsers.join(' '), 'alice bob @staff')
    assert.equal(parseSmbConf(next).global.workgroup, 'WORKGROUP')
    // Only one line added, in the archive stanza.
    assert.equal(next.split('\n').length, FIXTURE.split('\n').length + 1)
  })

  it('removes a key when a list is set empty', () => {
    const next = updateShare(FIXTURE, 'media', { validUsers: [] })
    assert.deepEqual(getShare(next, 'media')!.validUsers, [])
    // The continuation line went too.
    assert.ok(!next.includes('@staff'))
  })

  it('is a no-op for an absent share', () => {
    assert.equal(updateShare(FIXTURE, 'nope', { readOnly: true }), FIXTURE)
  })
})

describe('removeShare — removes only that stanza', () => {
  it('drops the [media] stanza and keeps everything else byte-identical', () => {
    const next = removeShare(FIXTURE, 'media')
    assert.ok(!hasShare(next, 'media'))
    assert.ok(hasShare(next, 'archive'))
    // The other stanzas survive verbatim.
    assert.ok(next.includes('[global]'))
    assert.ok(next.includes('\tworkgroup = WORKGROUP'))
    assert.ok(next.includes('[archive]'))
    assert.ok(next.includes('\thosts allow = 10.0.0.0/24, 192.168.1.'))
    // Reconstruct the expectation: original minus the media block (header +
    // body + trailing blank up to the next header).
    const lines = FIXTURE.split('\n')
    const start = lines.indexOf('[media]')
    const end = lines.indexOf('[archive]')
    const expected = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
    assert.equal(next, expected)
  })

  it('is a no-op for an absent share and refuses to remove [global]', () => {
    assert.equal(removeShare(FIXTURE, 'nope'), FIXTURE)
    assert.equal(removeShare(FIXTURE, 'global'), FIXTURE)
  })
})

describe('updateGlobal', () => {
  it('changes only the target [global] key line', () => {
    const next = updateGlobal(FIXTURE, { workgroup: 'ANASDOM' })
    const changed = FIXTURE.split('\n')
      .map((l, i) => [l, next.split('\n')[i]] as const)
      .filter(([b, a]) => b !== a)
    assert.equal(changed.length, 1)
    assert.equal(changed[0][0], '\tworkgroup = WORKGROUP')
    assert.equal(parseSmbConf(next).global.workgroup, 'ANASDOM')
  })

  it('serialises an interfaces list and preserves bind-interfaces-only', () => {
    const next = updateGlobal(FIXTURE, { interfaces: ['bond0', '10.1.0.0/16'] })
    assert.deepEqual(parseSmbConf(next).global.interfaces, ['bond0', '10.1.0.0/16'])
    assert.equal(parseSmbConf(next).global.bindInterfacesOnly, true)
  })

  it('creates a [global] section when none exists', () => {
    const noGlobal = '[media]\n\tpath = /tank/media\n'
    const next = updateGlobal(noGlobal, { workgroup: 'NEWDOM' })
    assert.equal(parseSmbConf(next).global.workgroup, 'NEWDOM')
    assert.ok(hasShare(next, 'media'), 'existing share survives')
    assert.equal(getShare(next, 'media')!.path, '/tank/media')
  })
})
