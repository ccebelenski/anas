import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  levelToAclPerms,
  levelToOctalDigit,
  modeDigitToLevel,
  parseGetfacl,
  permsToLevel,
} from '../getfacl.js'

describe('parseGetfacl', () => {
  it('parses a base-only ACL (mode bits only)', () => {
    const text = [
      'user::rwx',
      'group::r-x',
      'other::r-x',
      '',
    ].join('\n')
    const acl = parseGetfacl(text)
    assert.equal(acl.owner, 'rwx')
    assert.equal(acl.owningGroup, 'r-x')
    assert.equal(acl.everyone, 'r-x')
    assert.deepEqual(acl.named, [])
    assert.equal(acl.mask, undefined)
    assert.equal(acl.default, undefined)
  })

  it('parses base + named user/group entries with a mask', () => {
    const text = [
      'user::rwx',
      'user:alice:rwx',
      'group::r-x',
      'group:staff:r-x',
      'mask::rwx',
      'other::---',
      '',
    ].join('\n')
    const acl = parseGetfacl(text)
    assert.equal(acl.owner, 'rwx')
    assert.equal(acl.owningGroup, 'r-x')
    assert.equal(acl.everyone, '---')
    assert.equal(acl.mask, 'rwx')
    assert.deepEqual(acl.named, [
      { type: 'user', name: 'alice', perms: 'rwx' },
      { type: 'group', name: 'staff', perms: 'r-x' },
    ])
  })

  it('keeps GRANTED perms and drops the #effective comment', () => {
    // A mask of r-- clamps alice's effective rights, but we report the grant.
    const text = [
      'user::rwx',
      'user:alice:rwx\t#effective:r--',
      'group::rwx\t#effective:r--',
      'mask::r--',
      'other::---',
      '',
    ].join('\n')
    const acl = parseGetfacl(text)
    assert.deepEqual(acl.named, [{ type: 'user', name: 'alice', perms: 'rwx' }])
    assert.equal(acl.owningGroup, 'rwx')
    assert.equal(acl.mask, 'r--')
    // Reported level tracks the grant, not the masked effective rights.
    assert.equal(permsToLevel(acl.named[0].perms), 'read-write')
  })

  it('parses default (inheritance) entries into the default set', () => {
    const text = [
      'user::rwx',
      'user:alice:rwx',
      'group::r-x',
      'mask::rwx',
      'other::---',
      'default:user::rwx',
      'default:user:alice:rwx',
      'default:group::r-x',
      'default:mask::rwx',
      'default:other::---',
      '',
    ].join('\n')
    const acl = parseGetfacl(text)
    assert.ok(acl.default)
    assert.equal(acl.default?.owner, 'rwx')
    assert.equal(acl.default?.everyone, '---')
    assert.equal(acl.default?.mask, 'rwx')
    assert.deepEqual(acl.default?.named, [{ type: 'user', name: 'alice', perms: 'rwx' }])
    // Named entries stay on the access set, not duplicated into default.
    assert.deepEqual(acl.named, [{ type: 'user', name: 'alice', perms: 'rwx' }])
  })

  it('skips comment header lines and blanks (raw -pE output)', () => {
    const text = [
      '# file: /testpool/media',
      '# owner: root',
      '# group: root',
      'user::rwx',
      '',
      'group::r-x',
      'other::---',
      '',
    ].join('\n')
    const acl = parseGetfacl(text)
    assert.equal(acl.owner, 'rwx')
    assert.equal(acl.owningGroup, 'r-x')
    assert.equal(acl.everyone, '---')
  })
})

describe('permsToLevel', () => {
  it('maps write → read-write, read-without-write → read, none → none', () => {
    assert.equal(permsToLevel('rwx'), 'read-write')
    assert.equal(permsToLevel('rw-'), 'read-write')
    assert.equal(permsToLevel('r-x'), 'read')
    assert.equal(permsToLevel('r--'), 'read')
    assert.equal(permsToLevel('--x'), 'none')
    assert.equal(permsToLevel('---'), 'none')
  })
})

describe('modeDigitToLevel', () => {
  it('maps octal digits to levels', () => {
    assert.equal(modeDigitToLevel(7), 'read-write') // rwx
    assert.equal(modeDigitToLevel(6), 'read-write') // rw-
    assert.equal(modeDigitToLevel(5), 'read') // r-x
    assert.equal(modeDigitToLevel(4), 'read') // r--
    assert.equal(modeDigitToLevel(1), 'none') // --x
    assert.equal(modeDigitToLevel(0), 'none') // ---
  })
})

describe('level ↔ perms round-trips', () => {
  it('levelToOctalDigit → modeDigitToLevel is stable for the canonical shapes', () => {
    for (const level of ['none', 'read', 'read-write'] as const)
      assert.equal(modeDigitToLevel(levelToOctalDigit(level)), level)
  })

  it('levelToAclPerms → permsToLevel is stable (both mountpoint and recursive)', () => {
    for (const level of ['none', 'read', 'read-write'] as const) {
      assert.equal(permsToLevel(levelToAclPerms(level, false)), level)
      assert.equal(permsToLevel(levelToAclPerms(level, true)), level)
    }
  })

  it('uses capital X for read only when recursive (no spurious execute on files)', () => {
    assert.equal(levelToAclPerms('read', false), 'r-x')
    assert.equal(levelToAclPerms('read', true), 'r-X')
    assert.equal(levelToAclPerms('read-write', true), 'rwx')
    assert.equal(levelToAclPerms('none', true), '---')
  })
})
