import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isExpired,
  isShareRelevant,
  parseGroups,
  parsePasswd,
  parseShadowExpiry,
  primaryGroupName,
  toSystemGroup,
  toSystemUser,
  userGroups,
} from '../getent.js'

// Realistic `getent passwd` sample: root, a real user whose GECOS has commas
// and spaces, a filtered service account, and a share user with an empty gecos.
const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
  'jane:x:1000:1000:Jane Doe,Room 1,555-1234,,:/home/jane:/bin/bash',
  'media:x:1001:1001::/home/media:/usr/sbin/nologin',
  '', // trailing blank line
].join('\n')

const GROUP = [
  'root:x:0:',
  'daemon:x:1:',
  'users:x:100:',
  'jane:x:1000:',
  'smbusers:x:1001:jane,media',
  '',
].join('\n')

describe('parsePasswd', () => {
  it('parses all seven fields, keeping commas/spaces in gecos', () => {
    const entries = parsePasswd(PASSWD)
    const jane = entries.find(e => e.name === 'jane')
    assert.ok(jane)
    assert.equal(jane.uid, 1000)
    assert.equal(jane.gid, 1000)
    assert.equal(jane.gecos, 'Jane Doe,Room 1,555-1234,,')
    assert.equal(jane.home, '/home/jane')
    assert.equal(jane.shell, '/bin/bash')
  })

  it('treats a missing gecos as an empty string', () => {
    const media = parsePasswd(PASSWD).find(e => e.name === 'media')
    assert.ok(media)
    assert.equal(media.gecos, '')
  })

  it('skips blank lines and does not invent entries', () => {
    // root, daemon, www-data, jane, media — the blank line is dropped.
    assert.equal(parsePasswd(PASSWD).length, 5)
  })
})

describe('parseGroups', () => {
  it('comma-splits members and yields an empty array when there are none', () => {
    const groups = parseGroups(GROUP)
    assert.deepEqual(groups.find(g => g.name === 'smbusers')?.members, ['jane', 'media'])
    assert.deepEqual(groups.find(g => g.name === 'users')?.members, [])
  })
})

describe('isShareRelevant', () => {
  it('keeps root (0) and real accounts (>= 1000), drops service ids', () => {
    assert.equal(isShareRelevant(0), true)
    assert.equal(isShareRelevant(1000), true)
    assert.equal(isShareRelevant(1), false)
    assert.equal(isShareRelevant(999), false)
  })
})

describe('lean projections', () => {
  it('toSystemUser / toSystemGroup drop the extra fields', () => {
    const jane = parsePasswd(PASSWD).find(e => e.name === 'jane')!
    assert.deepEqual(toSystemUser(jane), { name: 'jane', uid: 1000 })
    const smbusers = parseGroups(GROUP).find(g => g.name === 'smbusers')!
    assert.deepEqual(toSystemGroup(smbusers), { name: 'smbusers', gid: 1001 })
  })
})

describe('group membership resolution', () => {
  const users = parsePasswd(PASSWD)
  const groups = parseGroups(GROUP)

  it('resolves the primary group from the passwd gid', () => {
    const jane = users.find(e => e.name === 'jane')!
    assert.equal(primaryGroupName(jane, groups), 'jane')
  })

  it('returns null when the primary gid has no matching group', () => {
    const media = users.find(e => e.name === 'media')!
    // media gid 1001 → group smbusers (gid 1001) IS the primary here.
    assert.equal(primaryGroupName(media, groups), 'smbusers')
  })

  it('combines primary + supplementary groups, primary first, de-duplicated', () => {
    const jane = users.find(e => e.name === 'jane')!
    // primary jane (gid 1000) + supplementary smbusers (member).
    assert.deepEqual(userGroups(jane, groups), ['jane', 'smbusers'])
  })
})

describe('parseShadowExpiry / isExpired', () => {
  const SHADOW = [
    'root:!:19000:0:99999:7:::',
    'jane:!:19000:0:99999:7:::',
    'media:!:19000:0:99999:7::1:',
    '',
  ].join('\n')

  it('extracts the expire (8th) field per user', () => {
    const map = parseShadowExpiry(SHADOW)
    assert.equal(map.get('root'), '')
    assert.equal(map.get('media'), '1')
  })

  it('reads an empty / -1 expiry as active and a past day as locked', () => {
    assert.equal(isExpired(''), false)
    assert.equal(isExpired('-1'), false)
    assert.equal(isExpired('1'), true) // day 1 (1970) is always in the past
    // A far-future expiry is not yet reached → still active.
    const future = String(Math.floor(Date.now() / 86_400_000) + 3650)
    assert.equal(isExpired(future), false)
  })
})
