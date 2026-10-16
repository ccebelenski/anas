import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { maskSecretValues, secretForms } from '../secret-argv.js'

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

/**
 * cr.55 (review 2026-10-16 L6) — the spellings GO tools print. rclone and pbc
 * are Go programs: a URL query is built with `url.QueryEscape` (which escapes
 * `!'()*` where `encodeURIComponent` does not, and writes space as `+`), an
 * error that quotes a value uses `%q` (`"` and `\` backslashed), and
 * rclone's `--use-json-log` puts every message inside a JSON string (Go's
 * `json.Marshal` additionally escapes `<`, `>`, `&`). Each form gets its own
 * test with the review's probe values, and each was shown to fail with its
 * line in `secretForms` removed.
 */
describe('secret-argv: maskSecretValues (cr.55 — the spellings Go tools print)', () => {
  it('Go url.QueryEscape: `!\'()*` escaped — the review\'s probe value `p@ss!w0rd(x)`', () => {
    assert.equal(maskSecretValues('GET /?pw=p%40ss%21w0rd%28x%29&x=1', ['p@ss!w0rd(x)']), 'GET /?pw=[secret]&x=1')
    assert.equal(maskSecretValues('q=it%27s%2Asecret', ['it\'s*secret']), 'q=[secret]')
  })

  it('Go url.QueryEscape with a space: `+` AND the Go-only escapes in one spelling', () => {
    assert.equal(maskSecretValues('body pw=my+pa%21ss+word', ['my pa!ss word']), 'body pw=[secret]')
  })

  it('Go %q / strconv.Quote: the quoted body with `\\"` and `\\\\` — the review\'s probe value', () => {
    // The stored value is ab"cd\ef9; a Go error that %q-quotes it prints
    // "ab\"cd\\ef9" — the body between the quotes never matched before.
    assert.equal(maskSecretValues('bad token "ab\\"cd\\\\ef9" refused', ['ab"cd\\ef9']), 'bad token "[secret]" refused')
  })

  it('Go %q of a control character: `\\t` short escape and `\\xHH`', () => {
    assert.equal(maskSecretValues('pw "tab\\there" bad', ['tab\there']), 'pw "[secret]" bad')
    assert.equal(maskSecretValues('pw "bel\\x01x" bad', ['bel\x01x']), 'pw "[secret]" bad')
  })

  it('a JSON string body as an encoder WITHOUT HTML escaping writes it (`\\u0001` where %q writes `\\x01`, `<` bare where json.Marshal writes `\\u003c`)', () => {
    // JSON.stringify is exactly that encoder (Go's json.Encoder with
    // SetEscapeHTML(false)); the value carries both a control character and
    // `<`, so this spelling matches neither the %q body nor Go's HTML-safe one.
    const line = JSON.stringify({ level: 'error', msg: 'auth failed for bel<\x01x"q' })
    assert.ok(line.includes('bel<\\u0001x\\"q'), line)
    assert.equal(maskSecretValues(line, ['bel<\x01x"q']), JSON.stringify({ level: 'error', msg: 'auth failed for [secret]' }))
  })

  it('Go json.Marshal (HTML-safe): `<`, `>`, `&` as \\u003c-style escapes', () => {
    assert.equal(maskSecretValues('{"msg":"key a\\u003cb\\u0026c\\u003e rejected"}', ['a<b&c>']), '{"msg":"key [secret] rejected"}')
  })

  it('every new form is built from each normalisation too (an NFD-stored value echoed QueryEscaped from its NFC form)', () => {
    const stored = 'cafe\u0301!pw'
    const nfcQuery = encodeURIComponent('caf\u00E9!pw').replace('!', '%21')
    assert.equal(maskSecretValues(`q=${nfcQuery}`, [stored]), 'q=[secret]')
  })

  it('the floor still binds: a value under 4 characters yields NO form at all, however long its encoding', () => {
    assert.deepEqual(secretForms('a"b'), [])
    assert.equal(maskSecretValues('pw "a\\"b" and a%22b', ['a"b']), 'pw "a\\"b" and a%22b')
  })

  it('a WORD-like secret is still masked (L6, recorded): the guessable gap beats printing the value', () => {
    // The review's probe: secret `copy` turns "Failed to copy" into "Failed to
    // [secret]". Kept by decision — the alternative prints the credential, and
    // the minimum length the review proposes was closed by the operator's
    // 2026-10-16 ruling (the helper's doc comment records both).
    assert.equal(maskSecretValues('Failed to copy: 403 Forbidden', ['copy']), 'Failed to [secret]: 403 Forbidden')
  })
})
