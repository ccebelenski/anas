import type { SmbShare, UpdateSmbShareRequest } from '@anas/shared'
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

// ============================================================================
// Issue #36 — a removal + an insert in ONE call must not leak into the NEXT
// stanza. Section spans are indexes into the line array: they go stale the
// moment a removal splices it, so the insert scan has to work from recomputed
// spans. The UI ALWAYS sends the full field set, so this shape is the norm,
// not an edge case.
// ============================================================================

/** Lines of `text` that are NOT part of `[name]`'s stanza, as a prefix/suffix pair. */
function outsideStanza(text: string, name: string): { prefix: string[], suffix: string[] } {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim().toLowerCase() === `[${name.toLowerCase()}]`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[.+\]\s*$/.test(lines[i].trim())) {
      end = i
      break
    }
  }
  return { prefix: lines.slice(0, start), suffix: lines.slice(end) }
}

/** Assert nothing outside `[name]` moved a byte. */
function assertOnlyStanzaTouched(before: string, after: string, name: string): void {
  const { prefix, suffix } = outsideStanza(before, name)
  const got = after.split('\n')
  assert.deepEqual(got.slice(0, prefix.length), prefix, `lines before [${name}] changed`)
  assert.deepEqual(got.slice(got.length - suffix.length), suffix, `lines after [${name}] changed`)
}

describe('updateShare — removal + insert in one call (issue #36)', () => {
  const THREE = [
    '# preamble',
    '',
    '[global]',
    '\tworkgroup = WORKGROUP',
    '',
    '[media]',
    '\tpath = /tank/media',
    '\tvalid users = alice bob',
    '',
    '[archive]',
    '\tpath = /tank/archive',
    '\thosts allow = 10.0.0.0/24',
    '',
  ].join('\n')

  it('writes the inserted directive into the EDITED stanza, not the next one', () => {
    // Removal (valid users cleared) + insert (guest ok absent) in one call.
    const next = updateShare(THREE, 'media', { validUsers: [], guestOk: true })
    assert.equal(getShare(next, 'media')!.guestOk, true)
    assert.deepEqual(getShare(next, 'media')!.validUsers, [])
    // The neighbouring share did NOT get guest access.
    assert.equal(getShare(next, 'archive')!.guestOk, false)
    assert.deepEqual(getShare(next, 'archive')!.hostsAllow, ['10.0.0.0/24'])
    assertOnlyStanzaTouched(THREE, next, 'media')
  })

  it('handles the same shape on the LAST stanza (no crash past the end of file)', () => {
    const next = updateShare(THREE, 'archive', { hostsAllow: [], guestOk: true })
    assert.deepEqual(getShare(next, 'archive')!.hostsAllow, [])
    assert.equal(getShare(next, 'archive')!.guestOk, true)
    // media and global are untouched.
    assert.deepEqual(getShare(next, 'media')!.validUsers, ['alice', 'bob'])
    assert.equal(getShare(next, 'media')!.guestOk, false)
    assertOnlyStanzaTouched(THREE, next, 'archive')
  })

  it('handles the full field set the UI always sends (edit dialog shape)', () => {
    const next = updateShare(THREE, 'media', {
      path: '/tank/media',
      comment: '',
      browseable: true,
      readOnly: false,
      guestOk: true,
      validUsers: [],
      hostsAllow: [],
      hostsDeny: [],
    })
    const media = getShare(next, 'media')!
    assert.equal(media.guestOk, true)
    assert.equal(media.readOnly, false)
    assert.deepEqual(media.validUsers, [])
    // Nothing bled into [archive].
    assert.equal(getShare(next, 'archive')!.guestOk, false)
    assert.equal(getShare(next, 'archive')!.readOnly, true)
    assertOnlyStanzaTouched(THREE, next, 'media')
  })

  it('applies the SMB Settings shape to [global], not to the share below it', () => {
    // Removal (interfaces cleared) + insert (server string absent) in one call.
    const next = updateGlobal(THREE, {
      workgroup: 'ANASDOM',
      serverString: 'ANAS box',
      interfaces: [],
      bindInterfacesOnly: false,
    })
    const { global } = parseSmbConf(next)
    assert.equal(global.workgroup, 'ANASDOM')
    assert.equal(global.serverString, 'ANAS box')
    assert.deepEqual(global.interfaces, [])
    assert.equal(global.bindInterfacesOnly, false)
    // The shares below are untouched — no `server string` in [media].
    assert.equal(getShare(next, 'media')!.path, '/tank/media')
    assert.deepEqual(getShare(next, 'media')!.validUsers, ['alice', 'bob'])
    assertOnlyStanzaTouched(THREE, next, 'global')
  })

  it('handles the same shape on a last stanza with NO trailing newline', () => {
    const noTrailing = THREE.replace(/\n+$/, '')
    const next = updateShare(noTrailing, 'archive', { hostsAllow: [], guestOk: true })
    assert.deepEqual(getShare(next, 'archive')!.hostsAllow, [])
    assert.equal(getShare(next, 'archive')!.guestOk, true)
    assert.deepEqual(getShare(next, 'media')!.validUsers, ['alice', 'bob'])
  })

  it('handles a removal + insert on a [global] that is the LAST stanza', () => {
    const globalLast = [
      '[media]',
      '\tpath = /tank/media',
      '',
      '[global]',
      '\tinterfaces = lo eth0',
      '',
    ].join('\n')
    const next = updateGlobal(globalLast, { interfaces: [], workgroup: 'ANASDOM' })
    const { global } = parseSmbConf(next)
    assert.deepEqual(global.interfaces, [])
    assert.equal(global.workgroup, 'ANASDOM')
    assert.equal(getShare(next, 'media')!.path, '/tank/media')
    assertOnlyStanzaTouched(globalLast, next, 'global')
  })
})

// ============================================================================
// Issue #42 — honesty: blank means "not set" (remove the directive), and every
// documented Samba synonym spelling is editable in place.
// ============================================================================

describe('blank values remove the directive rather than write an empty one', () => {
  const STOCK = [
    '[global]',
    '\tlog level = 1',
    '',
    '[media]',
    '\tpath = /tank/media',
    '\tbrowseable = yes',
    '\tread only = no',
    '\tguest ok = no',
    '',
  ].join('\n')

  it('saving a stock [global] with blank workgroup / server string writes nothing', () => {
    const next = updateGlobal(STOCK, {
      workgroup: '',
      serverString: '',
      interfaces: [],
      bindInterfacesOnly: false,
    })
    assert.ok(!next.includes('workgroup ='), 'no empty workgroup directive')
    assert.ok(!next.includes('server string ='), 'no empty server string directive')
    // Only the explicit boolean is added; nothing else moves.
    assert.equal(parseSmbConf(next).global.workgroup, '')
    assert.equal(parseSmbConf(next).global.serverString, '')
  })

  it('clears an existing workgroup instead of leaving `workgroup = `', () => {
    const withWg = STOCK.replace('\tlog level = 1', '\tlog level = 1\n\tworkgroup = OLD')
    const next = updateGlobal(withWg, { workgroup: '' })
    assert.ok(!next.includes('workgroup'), 'the directive is gone, not blanked')
    assert.equal(parseSmbConf(next).global.workgroup, '')
  })

  it('a blank comment does not litter a commentless stanza', () => {
    const next = updateShare(STOCK, 'media', {
      path: '/tank/media',
      comment: '',
      browseable: true,
      readOnly: false,
      guestOk: false,
      validUsers: [],
      hostsAllow: [],
      hostsDeny: [],
    })
    assert.ok(!next.includes('comment'), 'no empty comment directive was injected')
    assert.equal(next, STOCK, 'an untouched save is byte-identical')
  })

  it('a blanked comment removes the existing comment line', () => {
    const withComment = STOCK.replace('\tpath = /tank/media', '\tcomment = Media library\n\tpath = /tank/media')
    const next = updateShare(withComment, 'media', { comment: '' })
    assert.equal(getShare(next, 'media')!.comment, null)
    assert.ok(!next.includes('Media library'))
    assert.ok(!next.includes('comment'))
  })

  it('createShare omits a blank comment', () => {
    const next = addShare('', { name: 'x', path: '/tank/x', comment: '   ' })
    assert.ok(!next.includes('comment'))
  })
})

describe('synonym spellings are read AND edited in place', () => {
  const SYNONYMS = [
    '[legacy]',
    '\tdirectory = /tank/legacy',
    '\tbrowsable = yes',
    '\twritable = yes',
    '\tpublic = yes',
    '\tallow hosts = 10.0.0.0/24',
    '\tdeny hosts = 1.2.3.4',
    '',
    '[after]',
    '\tpath = /tank/after',
    '',
  ].join('\n')

  it('reads every synonym', () => {
    const share = getShare(SYNONYMS, 'legacy')!
    assert.equal(share.path, '/tank/legacy')
    assert.equal(share.browseable, true)
    assert.equal(share.readOnly, false) // writable = yes
    assert.equal(share.guestOk, true) // public = yes
    assert.deepEqual(share.hostsAllow, ['10.0.0.0/24'])
    assert.deepEqual(share.hostsDeny, ['1.2.3.4'])
  })

  it('CLEARS hosts allow / hosts deny written as `allow hosts` / `deny hosts`', () => {
    const next = updateShare(SYNONYMS, 'legacy', { hostsAllow: [], hostsDeny: [] })
    assert.deepEqual(getShare(next, 'legacy')!.hostsAllow, [], 'allow hosts really cleared')
    assert.deepEqual(getShare(next, 'legacy')!.hostsDeny, [])
    assert.ok(!next.includes('allow hosts'))
    assert.ok(!next.includes('deny hosts'))
    assertOnlyStanzaTouched(SYNONYMS, next, 'legacy')
  })

  it('rewrites the alternate spelling in place instead of shadowing it', () => {
    const next = updateShare(SYNONYMS, 'legacy', { hostsAllow: ['192.168.1.0/24'] })
    assert.deepEqual(getShare(next, 'legacy')!.hostsAllow, ['192.168.1.0/24'])
    assert.ok(next.includes('\tallow hosts = 192.168.1.0/24'), 'the user\'s spelling survives')
    assert.ok(!next.includes('hosts allow'), 'no duplicate canonical line')
  })

  it('flips an INVERTED synonym (`writable`) in its own sense', () => {
    const next = updateShare(SYNONYMS, 'legacy', { readOnly: true })
    assert.equal(getShare(next, 'legacy')!.readOnly, true)
    assert.ok(next.includes('\twritable = no'), 'writes the inverse spelling in place')
    assert.ok(!next.includes('read only'), 'no contradictory second directive')
  })

  it('edits `directory`, `browsable` and `public` in place', () => {
    const next = updateShare(SYNONYMS, 'legacy', {
      path: '/tank/moved',
      browseable: false,
      guestOk: false,
    })
    const share = getShare(next, 'legacy')!
    assert.equal(share.path, '/tank/moved')
    assert.equal(share.browseable, false)
    assert.equal(share.guestOk, false)
    assert.ok(next.includes('\tdirectory = /tank/moved'))
    assert.ok(next.includes('\tbrowsable = no'))
    assert.ok(next.includes('\tpublic = no'))
    assert.equal(next.split('\n').length, SYNONYMS.split('\n').length, 'no lines added')
  })

  it('removes EVERY definition when a list is cleared (both spellings)', () => {
    const doubled = [
      '[dup]',
      '\tpath = /tank/dup',
      '\thosts allow = 10.0.0.0/24',
      '\tallow hosts = 192.168.1.0/24',
      '',
    ].join('\n')
    const next = updateShare(doubled, 'dup', { hostsAllow: [] })
    assert.deepEqual(getShare(next, 'dup')!.hostsAllow, [], 'no earlier definition survives')
    assert.ok(!next.includes('10.0.0.0/24'))
    assert.ok(!next.includes('192.168.1.0/24'))
  })

  it('the LAST definition wins, as Samba does', () => {
    const contradictory = [
      '[mixed]',
      '\tpath = /tank/mixed',
      '\tread only = yes',
      '\twriteable = yes',
      '',
    ].join('\n')
    assert.equal(getShare(contradictory, 'mixed')!.readOnly, false, 'writeable = yes came last')
  })
})

// ============================================================================
// Class guards — the property-style matrix and the byte-identical round-trip.
// These are what keep the whole family of "edit wrote somewhere it shouldn't"
// bugs from coming back in a shape nobody wrote a case for.
// ============================================================================

/** Stanza bodies covering canonical, synonym, sparse and gnarly spellings. */
const STANZA_BODIES: { label: string, lines: string[] }[] = [
  {
    label: 'canonical',
    lines: [
      '\tpath = /tank/target',
      '\tcomment = Target share',
      '\tbrowseable = yes',
      '\tread only = no',
      '\tguest ok = no',
      '\tvalid users = alice bob',
      '\thosts allow = 10.0.0.0/24',
      '\thosts deny = 1.2.3.4',
    ],
  },
  {
    label: 'synonym spellings',
    lines: [
      '\tdirectory = /tank/target',
      '\tcomment = Target share',
      '\tbrowsable = no',
      '\twritable = yes',
      '\tpublic = yes',
      '\tallow hosts = 10.0.0.0/24',
      '\tdeny hosts = 1.2.3.4',
    ],
  },
  {
    label: 'sparse (path only)',
    lines: ['\tpath = /tank/target'],
  },
  {
    label: 'odd whitespace, mixed case, continuation, comment, blank line',
    lines: [
      '   Path   =   /tank/target',
      '\t# hand-written note',
      '\tRead Only= No',
      '',
      '\tvalid users = alice bob \\',
      '\t\t@staff',
      '\t; a semicolon comment',
    ],
  },
]

/** Edit shapes: removals only, inserts only, combined, and the full UI set. */
const EDIT_SHAPES: { label: string, req: UpdateSmbShareRequest }[] = [
  { label: 'removals only', req: { validUsers: [], hostsAllow: [], hostsDeny: [], comment: '' } },
  { label: 'inserts only', req: { guestOk: true, hostsDeny: ['9.9.9.9'] } },
  { label: 'combined removal + insert', req: { validUsers: [], guestOk: true } },
  { label: 'single value change', req: { readOnly: true } },
  {
    label: 'full UI field set',
    req: {
      path: '/tank/moved',
      comment: 'Edited',
      browseable: false,
      readOnly: true,
      guestOk: true,
      validUsers: ['carol'],
      hostsAllow: [],
      hostsDeny: [],
    },
  },
  { label: 'no-op (same values, blank comment)', req: { comment: '' } },
]

/** The share state an edit asks for, applied to the state it started from. */
function requestedState(before: SmbShare, req: UpdateSmbShareRequest): SmbShare {
  const comment = req.comment === undefined
    ? before.comment
    : (req.comment.trim() === '' ? null : req.comment)
  return {
    ...before,
    path: req.path ?? before.path,
    comment,
    browseable: req.browseable ?? before.browseable,
    readOnly: req.readOnly ?? before.readOnly,
    guestOk: req.guestOk ?? before.guestOk,
    validUsers: req.validUsers ?? before.validUsers,
    hostsAllow: req.hostsAllow ?? before.hostsAllow,
    hostsDeny: req.hostsDeny ?? before.hostsDeny,
  }
}

/** Build a file with `[target]` at the given position among real neighbours. */
function buildConf(body: string[], position: 'first' | 'middle' | 'last'): string {
  const target = ['[target]', ...body, '']
  const before = ['[before]', '\tpath = /tank/before', '\tvalid users = dave', '\thosts allow = 172.16.0.0/12', '']
  const after = ['[after]', '\tpath = /tank/after', '\tguest ok = no', '']
  const head = ['# a file that was here before ANAS', '', '[global]', '\tworkgroup = WORKGROUP', '\tlog level = 3', '']
  const stanzas = position === 'first'
    ? [...target, ...before, ...after]
    : position === 'middle'
      ? [...before, ...target, ...after]
      : [...before, ...after, ...target]
  return [...head, ...stanzas].join('\n')
}

describe('class guard — every write lands inside its own section', () => {
  for (const body of STANZA_BODIES) {
    for (const shape of EDIT_SHAPES) {
      for (const position of ['first', 'middle', 'last'] as const) {
        it(`${body.label} / ${shape.label} / ${position} stanza`, () => {
          const text = buildConf(body.lines, position)
          const beforeView = parseSmbConf(text)
          const beforeTarget = beforeView.shares.find(s => s.name === 'target')!
          const next = updateShare(text, 'target', shape.req)

          // 1. Nothing outside the [target] stanza moved a byte.
          assertOnlyStanzaTouched(text, next, 'target')

          // 2. Re-parsing yields EXACTLY the requested state.
          assert.deepEqual(getShare(next, 'target'), requestedState(beforeTarget, shape.req))

          // 3. Every neighbour — and [global] — reads back unchanged.
          const nextView = parseSmbConf(next)
          assert.deepEqual(nextView.global, beforeView.global)
          for (const name of ['before', 'after']) {
            assert.deepEqual(
              nextView.shares.find(s => s.name === name),
              beforeView.shares.find(s => s.name === name),
              `[${name}] changed`,
            )
          }

          // 4. The file still round-trips (no structural damage).
          assert.equal(serializeDoc(parseDoc(next)), next)
        })
      }
    }
  }
})

describe('class guard — an untouched save is byte-identical', () => {
  for (const body of STANZA_BODIES) {
    for (const position of ['first', 'middle', 'last'] as const) {
      it(`${body.label} / ${position} stanza round-trips its own state`, () => {
        const text = buildConf(body.lines, position)
        const share = getShare(text, 'target')!
        // Exactly what the UI submits after opening the edit dialog and
        // pressing Save without changing anything.
        const next = updateShare(text, 'target', {
          path: share.path,
          comment: share.comment ?? '',
          browseable: share.browseable,
          readOnly: share.readOnly,
          guestOk: share.guestOk,
          validUsers: share.validUsers,
          hostsAllow: share.hostsAllow,
          hostsDeny: share.hostsDeny,
        })
        assert.equal(next, text, 'saving the parsed state changed the file')
      })
    }
  }

  it('an untouched SMB Settings save leaves [global] byte-identical', () => {
    const { global } = parseSmbConf(FIXTURE)
    const next = updateGlobal(FIXTURE, {
      workgroup: global.workgroup,
      serverString: global.serverString,
      interfaces: global.interfaces,
      bindInterfacesOnly: global.bindInterfacesOnly,
    })
    assert.equal(next, FIXTURE)
  })

  it('an untouched save of the torture fixture leaves every share byte-identical', () => {
    let text = FIXTURE
    for (const share of parseSmbConf(FIXTURE).shares) {
      text = updateShare(text, share.name, {
        path: share.path,
        comment: share.comment ?? '',
        browseable: share.browseable,
        readOnly: share.readOnly,
        guestOk: share.guestOk,
        validUsers: share.validUsers,
        hostsAllow: share.hostsAllow,
        hostsDeny: share.hostsDeny,
      })
    }
    assert.equal(text, FIXTURE)
  })
})
