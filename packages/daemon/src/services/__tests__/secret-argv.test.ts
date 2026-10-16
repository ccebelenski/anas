import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { maskSecretValues } from '../secret-argv.js'

/**
 * cr.48b — `maskSecretValues`, the output-side mirror of the argv guard: a
 * read job hands a tool its secret values (on the environment, never argv),
 * and if the tool ECHOES one back in its stderr, the string that leaves in the
 * result has that value replaced by `[secret]`. The unit contracts here are
 * exactly the ones the three read results depend on.
 */
describe('secret-argv: maskSecretValues (cr.48b)', () => {
  it('replaces a plain secret value everywhere it occurs', () => {
    assert.equal(
      maskSecretValues('401 Unauthorized for token s3cr3t-pass, retry s3cr3t-pass', ['s3cr3t-pass']),
      '401 Unauthorized for token [secret], retry [secret]',
    )
  })

  it('replaces the URL-encoded form too (rclone/pbc echo URLs)', () => {
    assert.equal(
      maskSecretValues('Failed to open https://user:s3cr3t%20pass@example.com/x', ['s3cr3t pass']),
      'Failed to open https://user:[secret]@example.com/x',
    )
  })

  it('an overlapping value is masked whole (longest first), never twice', () => {
    // The longer value contains the shorter: the whole `apisecret-core` must
    // become ONE `[secret]`, and the shorter `secret-core` must not then mask
    // inside the replacement or shred the first word.
    assert.equal(
      maskSecretValues('apisecret-core then secret-core', ['secret-core', 'apisecret-core']),
      '[secret] then [secret]',
    )
  })

  it('the longest value wins on a per-occurrence basis', () => {
    assert.equal(
      maskSecretValues('long-password-000 then short-password', ['long-password-000', 'short-password']),
      '[secret] then [secret]',
    )
  })

  it('a value shorter than 4 characters is NOT masked (it would shred the text)', () => {
    assert.equal(maskSecretValues('use the ga token here, ga is short', ['ga']), 'use the ga token here, ga is short')
    assert.equal(maskSecretValues('abc abc', ['abc']), 'abc abc')
  })

  it('an empty secret list changes nothing', () => {
    const text = 'some text that mentions nothing secret'
    assert.equal(maskSecretValues(text, []), text)
  })

  it('empty values are ignored', () => {
    assert.equal(maskSecretValues('a secret-value here', ['', '', 'secret-value']), 'a [secret] here')
  })

  it('a value with regex metacharacters is matched literally', () => {
    assert.equal(
      maskSecretValues('token [49$q.*^+(ab){2}] stays secret here', ['[49$q.*^+(ab){2}]']),
      'token [secret] stays secret here',
    )
  })

  it('no value and no text is a no-op', () => {
    assert.equal(maskSecretValues('', ['anything']), '')
    assert.equal(maskSecretValues('', []), '')
  })
})

/**
 * cr.48e — the widened form space: the `+`-for-space spelling of the URL
 * encoding (the form-urlencoded echo) and both Unicode normalisations, when
 * they differ from the stored value. Base64 is deliberately OUT OF SCOPE (a
 * tool does not echo a credential base64-encoded in an error line — recorded
 * in the helper's doc comment).
 */
describe('secret-argv: maskSecretValues (cr.48e form space)', () => {
  it('the +-for-space form of the encoding is masked too', () => {
    // One value, three spellings a tool can print: plain, %20-encoded, +.
    const value = 's3cr3t pa ss'
    assert.equal(maskSecretValues('body: s3cr3t+pa+ss=on', [value]), 'body: [secret]=on')
    assert.equal(maskSecretValues('url: s3cr3t%20pa%20ss here', [value]), 'url: [secret] here')
    assert.equal(maskSecretValues('echo: s3cr3t pa ss here', [value]), 'echo: [secret] here')
  })

  it('a value with no space produces no + form (a lone + in text survives)', () => {
    assert.equal(maskSecretValues('a+b stays, s3cr3t goes', ['s3cr3t']), 'a+b stays, [secret] goes')
  })

  it('the NFC form is masked (value stored decomposed, tool echoes composed)', () => {
    // Stored: 'cafe\u0301-secret' (e + combining acute); the NFC echo composes.
    assert.equal(maskSecretValues('pbc echoed caf\u00E9-secret back', ['cafe\u0301-secret']), 'pbc echoed [secret] back')
  })

  it('the NFD form is masked (value stored composed, tool echoes decomposed)', () => {
    // The text carries the decomposed echo of the stored COMPOSED value.
    assert.equal(maskSecretValues('pbc echoed cafe\u0301-secret back', ['caf\u00E9-secret']), 'pbc echoed [secret] back')
  })

  it('the 4-character floor applies to every form (a short normalisation is not masked)', () => {
    // 'e\u0301e\u0301f' is 5 code units (eligible plain); its NFC form
    // '\u00e9\u00e9f' is 3 — below the floor, so it survives in text rather
    // than shredding it. The plain stored form is still masked.
    assert.equal(maskSecretValues('the word \u00E9\u00E9f stays', ['e\u0301e\u0301f']), 'the word \u00E9\u00E9f stays')
    assert.equal(maskSecretValues('the word e\u0301e\u0301f goes', ['e\u0301e\u0301f']), 'the word [secret] goes')
  })

  it('an ASCII value masks no differently than before (normalisations are no-ops)', () => {
    assert.equal(maskSecretValues('plain s3cr3t-pass here', ['s3cr3t-pass']), 'plain [secret] here')
  })
})
