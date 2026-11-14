import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CredentialsContentError, formatCredentials, parseCredentialsFileText, parseCredentialsMeta } from '../mounts.js'

/**
 * cr3.mounts review 3 (1)/(7) — a credentials file is read EXACTLY as
 * mount.cifs reads it (cifs-utils 7.4 `open_cred_file` / `parse_cred_line`,
 * quoted by the coordinator): leading spaces/tabs skipped, nothing else
 * trimmed, a case-insensitive PREFIX on the key (`user`, then `pass2` or
 * `password2`, then `pass`, then `dom`), the value everything after the first
 * `=`, the LAST line winning, no `workgroup`. And ANAS never WRITES a file
 * whose lines would not mean what was meant.
 */
describe('cr3.mounts review 3 (1) — the credentials file read as mount.cifs reads it', () => {
  const table: Array<[string, Record<string, string>]> = [
    ['username=alice', { username: 'alice' }],
    ['user=alice', { username: 'alice' }],
    ['USER=alice', { username: 'alice' }],
    ['userid=alice', { username: 'alice' }], // a prefix match
    ['  \tusername=alice', { username: 'alice' }], // leading blanks skipped
    ['username = alice ', { username: ' alice ' }], // nothing trimmed around '='
    ['password=p=w', { password: 'p=w' }], // value after the FIRST '='
    ['pass=p', { password: 'p' }],
    ['PASSWORD=p', { password: 'p' }],
    ['password2=q', { password2: 'q' }],
    ['pass2=q', { password2: 'q' }],
    ['Pass2word=q', { password2: 'q' }],
    ['passwordX=p', { password: 'p' }], // `pass` prefix, not password2
    ['domain=CORP', { domain: 'CORP' }],
    ['dom=CORP', { domain: 'CORP' }],
    ['DOMAINNAME=CORP', { domain: 'CORP' }],
    ['workgroup=CORP', {}], // no workgroup key in a FILE
    ['password=p\r', { password: 'p\r' }], // only the \n is removed
    ['# username=alice', {}],
    ['username', {}],
  ]
  for (const [line, want] of table) {
    it(`${JSON.stringify(line)} -> ${JSON.stringify(want)}`, () => {
      assert.deepEqual(parseCredentialsFileText(`${line}\n`), want)
    })
  }

  it('a later line OVERWRITES an earlier one', () => {
    assert.deepEqual(parseCredentialsFileText('username=a\nuser=b\npassword=1\npass=2\ndomain=X\ndom=Y\n'), { username: 'b', password: '2', domain: 'Y' })
  })

  it('the metadata reader (what a response shows) reads by the same rules and never returns a password', () => {
    assert.deepEqual(parseCredentialsMeta('USER=alice\npassword=p\npassword2=q\nworkgroup=W\ndom=D\n'), { username: 'alice', domain: 'D' })
  })
})

describe('cr3.mounts review 3 (7) — formatCredentials never writes a file that does not mean what was meant', () => {
  for (const [field, value] of [['password', 'a\nb'], ['password2', 'a\rb'], ['username', 'u\nx'], ['domain', 'D\nEVIL']] as const) {
    it(`a line break in the ${field} is refused, the value never in the sentence`, () => {
      const creds = { username: 'u', password: 'p', [field]: value }
      assert.throws(() => formatCredentials(creds), (err: Error) => err instanceof CredentialsContentError && !err.message.includes(value))
    })
  }
  it('an empty username is refused (never an empty `username=` line)', () => {
    assert.throws(() => formatCredentials({ username: '', password: 'p' }), CredentialsContentError)
  })
  it('the four lines in order', () => {
    assert.equal(formatCredentials({ username: 'u', password: 'p', password2: 'q', domain: 'D' }), 'username=u\npassword=p\npassword2=q\ndomain=D\n')
  })
})
