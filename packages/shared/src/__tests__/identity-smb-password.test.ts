import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CreateShareUserRequest, SetSmbPasswordRequest } from '../schemas/identity.js'

/**
 * cr3.shares L10: the daemon feeds `smbpasswd -a -s` the password twice on
 * stdin (`<pw>\n<pw>\n`), and smbpasswd reads it a line at a time — so a
 * password `a\na` arrived as new = `a`, retype = `a`, and set `a`. Control
 * characters are refused at both doors that carry a password.
 */
describe('SMB passwords refuse control characters (cr3.shares L10)', () => {
  for (const bad of ['a\na', 'pass\r', 'tab\there', 'nul\u0000', 'del\u007F']) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.equal(SetSmbPasswordRequest.safeParse({ password: bad }).success, false)
      assert.equal(CreateShareUserRequest.safeParse({ name: 'bob', smbPassword: bad }).success, false)
    })
  }

  it('keeps every printable password, spaces and punctuation included', () => {
    for (const ok of ['correct horse battery staple', 'p@ss;w0rd#\\"\'', 'naïve-пароль'])
      assert.equal(SetSmbPasswordRequest.safeParse({ password: ok }).success, true, ok)
  })
})
