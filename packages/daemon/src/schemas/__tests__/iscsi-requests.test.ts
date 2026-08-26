import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aclAuthRequirement,
  aclSatisfiesAuth,
  AddIscsiLunRequest,
  CreateIscsiTargetRequest,
  DeleteIscsiLunQuery,
  ipFamily,
  ISCSI_CHAP_SECRET_MAX_BYTES,
  ISCSI_CHAP_SECRET_MIN_BYTES,
  ISCSI_DEFAULT_PORT,
  IscsiChapSecret,
  IscsiLunName,
  IscsiPortalAddress,
  IscsiTargetName,
  unbracketAddress,
  UpdateIscsiLunRequest,
  UpdateIscsiTargetRequest,
} from '@anas/shared'

/**
 * The iSCSI MUTATION request schemas (story `iscsi.4`).
 *
 * Almost every rule here exists because LIO enforces nothing. It accepts a
 * one-character CHAP secret (GT-34), it binds a portal to an address that does
 * not exist and reports it healthy (GT-24), and it lets a backstore name be
 * anything at all even though that name is the SCSI model string every initiator
 * sees (GT-15). If ANAS wants a rule, ANAS is the only one enforcing it — so it
 * is enforced ONCE, at the schema boundary, for every caller.
 */

const OK_SECRET = 'correcthorseba' // 14 bytes

describe('IscsiChapSecret — the 12–16 byte rule LIO does not have (GT-34)', () => {
  it('accepts the boundaries exactly', () => {
    assert.equal(IscsiChapSecret.safeParse('x'.repeat(ISCSI_CHAP_SECRET_MIN_BYTES)).success, true)
    assert.equal(IscsiChapSecret.safeParse('x'.repeat(ISCSI_CHAP_SECRET_MAX_BYTES)).success, true)
  })

  it('rejects one byte either side', () => {
    assert.equal(IscsiChapSecret.safeParse('x'.repeat(ISCSI_CHAP_SECRET_MIN_BYTES - 1)).success, false)
    assert.equal(IscsiChapSecret.safeParse('x'.repeat(ISCSI_CHAP_SECRET_MAX_BYTES + 1)).success, false)
  })

  it('counts BYTES, not characters', () => {
    // 16 characters, 32 bytes of UTF-8 — an initiator's 16-byte field would
    // truncate it, and the login would fail as if the secret were simply wrong.
    assert.equal('é'.repeat(16).length, 16)
    assert.equal(IscsiChapSecret.safeParse('é'.repeat(16)).success, false)
    // 12 two-byte characters = 24 bytes: also out.
    assert.equal(IscsiChapSecret.safeParse('é'.repeat(12)).success, false)
    // 6 two-byte characters = 12 bytes: in.
    assert.equal(IscsiChapSecret.safeParse('é'.repeat(6)).success, true)
  })

  it('rejects a control character — the secret is written into a configfs file', () => {
    assert.equal(IscsiChapSecret.safeParse('secret\nvalue!').success, false)
  })
})

describe('IscsiPortalAddress — the three things refused before targetcli sees them', () => {
  it('accepts IPv4 and IPv6 literals', () => {
    assert.equal(IscsiPortalAddress.safeParse('192.168.200.50').success, true)
    assert.equal(IscsiPortalAddress.safeParse('fd00:6774:0:1::1').success, true)
    assert.equal(IscsiPortalAddress.safeParse('::1').success, true)
    assert.equal(IscsiPortalAddress.safeParse('2001:db8::ffff:192.0.2.1').success, true)
  })

  it('NORMALISES a bracketed IPv6 address to the bare form (GT-12)', () => {
    // LIO stores a v6 portal bracketed and a v4 one bare, so any comparison
    // against a node address has to strip the brackets. It happens once, here.
    assert.equal(IscsiPortalAddress.parse('[fd00:6774:0:1::1]'), 'fd00:6774:0:1::1')
    assert.equal(unbracketAddress('[::1]'), '::1')
    assert.equal(unbracketAddress('192.168.200.50'), '192.168.200.50')
  })

  it('refuses the wildcard — the epic\'s threat model in one line (GT-8)', () => {
    assert.equal(IscsiPortalAddress.safeParse('0.0.0.0').success, false)
    assert.equal(IscsiPortalAddress.safeParse('::').success, false)
    assert.equal(IscsiPortalAddress.safeParse('[::]').success, false)
  })

  it('refuses a link-local address, which LIO refuses opaquely (GT-25)', () => {
    assert.equal(IscsiPortalAddress.safeParse('fe80::1').success, false)
    assert.equal(IscsiPortalAddress.safeParse('FE80::abcd').success, false)
    assert.equal(IscsiPortalAddress.safeParse('169.254.1.1').success, false)
  })

  it('refuses a hostname — a portal binds an address, not a name', () => {
    assert.equal(IscsiPortalAddress.safeParse('nas.example.com').success, false)
    assert.equal(IscsiPortalAddress.safeParse('localhost').success, false)
  })

  it('refuses malformed literals rather than letting targetcli guess', () => {
    for (const bad of ['192.168.200.256', '192.168.200', '1.2.3.4.5', 'fd00::1::2', 'fd00:6774:0:1::1%eth0', 'gggg::1'])
      assert.equal(IscsiPortalAddress.safeParse(bad).success, false, bad)
  })

  it('ipFamily names the family, or null for a non-literal', () => {
    assert.equal(ipFamily('192.168.200.50'), 'inet')
    assert.equal(ipFamily('[fd00::1]'), 'inet6')
    assert.equal(ipFamily('nas.example.com'), null)
  })
})

describe('IscsiTargetName and IscsiLunName', () => {
  it('a target name cannot forge extra IQN structure', () => {
    assert.equal(IscsiTargetName.safeParse('vmstore').success, true)
    assert.equal(IscsiTargetName.safeParse('vm-store-2').success, true)
    // A `:` or a `.` would add a field to the generated IQN.
    assert.equal(IscsiTargetName.safeParse('vm:store').success, false)
    assert.equal(IscsiTargetName.safeParse('vm.store').success, false)
    assert.equal(IscsiTargetName.safeParse('VMStore').success, false)
    assert.equal(IscsiTargetName.safeParse('-vmstore').success, false)
    assert.equal(IscsiTargetName.safeParse('').success, false)
  })

  it('a LUN name is a configfs directory AND the SCSI model string (GT-15)', () => {
    assert.equal(IscsiLunName.safeParse('vmdisk1').success, true)
    assert.equal(IscsiLunName.safeParse('tank_vol1.raw').success, true)
    assert.equal(IscsiLunName.safeParse('a/b').success, false)
    assert.equal(IscsiLunName.safeParse('..').success, false)
    assert.equal(IscsiLunName.safeParse('has space').success, false)
    assert.equal(IscsiLunName.safeParse('').success, false)
  })
})

describe('CreateIscsiTargetRequest', () => {
  const base = { name: 'vmstore', portals: [{ address: '192.168.200.50' }] }

  it('defaults the port to 3260 and the auth to none', () => {
    const parsed = CreateIscsiTargetRequest.parse(base)
    assert.equal(parsed.portals[0].port, ISCSI_DEFAULT_PORT)
    assert.equal(parsed.auth, 'none')
    assert.deepEqual(parsed.acls, [])
  })

  it('needs at least one portal — a target with none listens nowhere', () => {
    assert.equal(CreateIscsiTargetRequest.safeParse({ name: 'vmstore', portals: [] }).success, false)
  })

  it('refuses a duplicate portal and a duplicate initiator', () => {
    assert.equal(CreateIscsiTargetRequest.safeParse({
      ...base,
      portals: [{ address: '192.168.200.50' }, { address: '192.168.200.50', port: 3260 }],
    }).success, false)
    assert.equal(CreateIscsiTargetRequest.safeParse({
      ...base,
      acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:a' }, { initiatorIqn: 'iqn.1993-08.org.debian:01:a' }],
    }).success, false)
  })

  it('refuses an ACL that could never log in under the chosen auth (GT-32)', () => {
    // Under explicit ACLs LIO ignores TPG-level credentials entirely, so an ACL
    // with no per-ACL pair is refused at login however the TPG is configured.
    const noCreds = { ...base, auth: 'chap', acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:a' }] }
    const r = CreateIscsiTargetRequest.safeParse(noCreds)
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0].message, /never be able to log in/)

    // One-way credentials are not enough for MUTUAL chap.
    assert.equal(CreateIscsiTargetRequest.safeParse({
      ...base,
      auth: 'mutual-chap',
      acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:a', chapUserid: 'alice', chapSecret: OK_SECRET }],
    }).success, false)

    // …and with both pairs it passes.
    assert.equal(CreateIscsiTargetRequest.safeParse({
      ...base,
      auth: 'mutual-chap',
      acls: [{
        initiatorIqn: 'iqn.1993-08.org.debian:01:a',
        chapUserid: 'alice',
        chapSecret: OK_SECRET,
        mutualUserid: 'target1',
        mutualSecret: 'batterystaple1',
      }],
    }).success, true)
  })

  it('an ACL with no credentials is fine when auth is none', () => {
    assert.equal(CreateIscsiTargetRequest.safeParse({
      ...base,
      acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:a' }],
    }).success, true)
  })

  it('the auth rule is ONE function, shared with the daemon\'s edit path', () => {
    assert.equal(aclSatisfiesAuth({}, 'none'), true)
    assert.equal(aclSatisfiesAuth({ chapUserid: 'a', chapSecret: 's' }, 'chap'), true)
    assert.equal(aclSatisfiesAuth({ chapUserid: 'a' }, 'chap'), false)
    assert.equal(aclSatisfiesAuth({ chapUserid: 'a', chapSecret: 's' }, 'mutual-chap'), false)
    assert.match(aclAuthRequirement('mutual-chap'), /BOTH directions/)
    assert.match(aclAuthRequirement('chap'), /every initiator ACL/)
  })
})

describe('UpdateIscsiTargetRequest — omission means keep', () => {
  it('an empty body is valid and says nothing', () => {
    const parsed = UpdateIscsiTargetRequest.parse({})
    assert.equal(parsed.portals, undefined)
    assert.equal(parsed.acls, undefined)
    assert.equal(parsed.auth, undefined)
  })

  it('an EMPTY acls array is valid — it means "remove them all"', () => {
    assert.equal(UpdateIscsiTargetRequest.safeParse({ acls: [] }).success, true)
  })

  it('an empty portals array is NOT — a target must listen somewhere', () => {
    assert.equal(UpdateIscsiTargetRequest.safeParse({ portals: [] }).success, false)
  })

  it('a null credential is accepted — that is how a stored one is cleared', () => {
    const parsed = UpdateIscsiTargetRequest.parse({
      acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:a', chapSecret: null, chapUserid: null }],
    })
    assert.equal(parsed.acls![0].chapSecret, null)
    // …and OMITTING it is a different thing entirely.
    const kept = UpdateIscsiTargetRequest.parse({ acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:a' }] })
    assert.equal('chapSecret' in kept.acls![0], false)
  })
})

describe('AddIscsiLunRequest — the two kinds take different shapes', () => {
  it('a zvol LUN names an existing volume and carries no size', () => {
    const parsed = AddIscsiLunRequest.parse({ name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1' })
    assert.equal(parsed.size, undefined)
    assert.equal(parsed.blockSize, undefined)
  })

  it('a zvol LUN with a size is refused — grow the volume instead', () => {
    const r = AddIscsiLunRequest.safeParse({ name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1', size: 4096 })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0].message, /grow the volume/)
  })

  it('a file LUN REQUIRES a size — fileio fixes it at creation (GT-29)', () => {
    const r = AddIscsiLunRequest.safeParse({ name: 'image1', kind: 'file', backing: 'tank/images' })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0].message, /fixed at creation/)
    assert.equal(AddIscsiLunRequest.safeParse({ name: 'image1', kind: 'file', backing: 'tank/images', size: 1 }).success, true)
  })

  it('refuses path traversal in the backing reference', () => {
    assert.equal(AddIscsiLunRequest.safeParse({ name: 'x', kind: 'zvol', backing: '../../etc' }).success, false)
  })

  it('accepts only the block sizes LIO takes', () => {
    for (const ok of [512, 1024, 2048, 4096]) {
      assert.equal(
        AddIscsiLunRequest.safeParse({ name: 'x', kind: 'zvol', backing: 'tank/v', blockSize: ok }).success,
        true,
        String(ok),
      )
    }
    for (const bad of [0, 511, 3000, 8192, 4096.5]) {
      assert.equal(
        AddIscsiLunRequest.safeParse({ name: 'x', kind: 'zvol', backing: 'tank/v', blockSize: bad }).success,
        false,
        String(bad),
      )
    }
  })

  it('refuses the `foreign` kind — that is a READ verdict, never a request', () => {
    assert.equal(AddIscsiLunRequest.safeParse({ name: 'x', kind: 'foreign', backing: '/dev/sdb' }).success, false)
  })
})

describe('UpdateIscsiLunRequest and DeleteIscsiLunQuery', () => {
  it('an empty update is refused — nothing to change is not a change', () => {
    assert.equal(UpdateIscsiLunRequest.safeParse({}).success, false)
    assert.equal(UpdateIscsiLunRequest.safeParse({ size: 1 }).success, true)
    assert.equal(UpdateIscsiLunRequest.safeParse({ writeBack: true }).success, true)
  })

  it('a size must be a positive integer', () => {
    assert.equal(UpdateIscsiLunRequest.safeParse({ size: 0 }).success, false)
    assert.equal(UpdateIscsiLunRequest.safeParse({ size: -1 }).success, false)
    assert.equal(UpdateIscsiLunRequest.safeParse({ size: 1.5 }).success, false)
  })

  it('destroyBacking defaults OFF and accepts the query-string spellings', () => {
    assert.equal(DeleteIscsiLunQuery.parse({}).destroyBacking, false)
    assert.equal(DeleteIscsiLunQuery.parse({ destroyBacking: 'true' }).destroyBacking, true)
    assert.equal(DeleteIscsiLunQuery.parse({ destroyBacking: '1' }).destroyBacking, true)
    assert.equal(DeleteIscsiLunQuery.parse({ destroyBacking: 'false' }).destroyBacking, false)
    assert.equal(DeleteIscsiLunQuery.parse({ destroyBacking: '0' }).destroyBacking, false)
  })
})
