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
