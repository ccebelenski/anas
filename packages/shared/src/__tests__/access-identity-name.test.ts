import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AccessEntry, SetAccessRequest } from '../schemas/access.js'

/**
 * cr.53 (review L16, a 2026-10-14 H5 residue): the access editor's
 * owner/group/entry names ride into `chown`'s and `setfacl`'s argv, so the
 * boundary validates them as identity names (`LookupName`). The probes the
 * review ran:
 *   {"owner":"--reference=/etc/shadow"} → chown --reference=/etc/shadow …
 *   entry name `media:r-x,o::rwx,u:nobody` → setfacl keeps the LAST `o::`,
 *   silently granting everyone rwx while the request says none.
 */
describe('cr.53 L16 — access editor names are validated identity names', () => {
  const refusals: [string, unknown][] = [
    // Option injection into chown/setfacl argv.
    ['owner --reference', { owner: '--reference=/etc/shadow' }],
    ['owner leading dash', { owner: '-R' }],
    ['group leading dash', { group: '--from=root' }],
    ['owner with space', { owner: 'root x' }],
    ['owner empty', { owner: '' }],
    // Spec delimiter: a `:` in an entry name joins a new ACL entry.
    ['entry name with colon', { entries: [{ kind: 'user', name: 'x,o::rwx', level: 'read' }] }],
    ['entry name with slash', { entries: [{ kind: 'user', name: '../../etc/shadow', level: 'read' }] }],
    ['entry name with control char', { entries: [{ kind: 'user', name: 'x\ny', level: 'read' }] }],
  ]
  for (const [label, body] of refusals) {
    it(`refuses: ${label}`, () => {
      assert.equal(SetAccessRequest.safeParse(body).success, false, label)
    })
  }

  const acceptances: [string, unknown][] = [
    // Local names and the forms directory identities surface through.
    ['plain', { owner: 'media', group: 'smbusers' }],
    ['mixed case + dot (AD)', { owner: 'john.doe', entries: [{ kind: 'user', name: 'Alice', level: 'read' }] }],
    ['UPN form', { entries: [{ kind: 'user', name: 'alice@corp.example', level: 'read-write' }] }],
    ['DOMAIN\\user form', { group: 'CORP\\shareusers' }],
    // A bare numeric id — an orphaned ACL entry round-trips through the
    // editor unchanged (and chown/setfacl accept numeric ids).
    ['numeric id', { owner: '1002', entries: [{ kind: 'user', name: '1002', level: 'read', unresolved: true }] }],
    // Machine-account trailing $.
    ['machine account', { owner: 'pve-node$' }],
  ]
  for (const [label, body] of acceptances) {
    it(`accepts: ${label}`, () => {
      assert.equal(SetAccessRequest.safeParse(body).success, true, `${label}: ${JSON.stringify(SetAccessRequest.safeParse(body).error?.issues)}`)
    })
  }

  it('AccessEntry itself refuses the injection shapes', () => {
    assert.equal(AccessEntry.safeParse({ kind: 'user', name: '-m', level: 'read' }).success, false)
    assert.equal(AccessEntry.safeParse({ kind: 'group', name: 'a:b', level: 'read' }).success, false)
    assert.equal(AccessEntry.safeParse({ kind: 'group', name: 'smbusers', level: 'read' }).success, true)
  })
})
