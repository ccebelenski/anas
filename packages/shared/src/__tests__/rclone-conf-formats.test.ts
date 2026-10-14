import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RcloneOptionKey, RcloneOptionValue } from '../formats/rclone-conf.js'
import { CloudRemoteUpdate, CloudRemoteWrite } from '../schemas/cloud.js'

/**
 * The per-format rclone.conf layer from cr.13 (review H3(c), ruling (i)): an
 * option KEY is letters/digits/`_` and a VALUE has no control characters —
 * a newline in a secret non-password value would forge a whole `[section]`
 * that the post-write gate (which compares non-secret values only) never
 * catches.
 */

describe('RcloneOptionKey', () => {
  it('accepts the real option vocabulary — letters, digits, underscores', () => {
    for (const k of ['type', 'provider', 'access_key_id', 'secret_access_key', 'pass', 'token', 'key', 'hard_delete', 'endpoint', 'chunk_size', 'region2'])
      assert.equal(RcloneOptionKey.safeParse(k).success, true, JSON.stringify(k))
  })

  it('refuses any key that could change the line or section parse', () => {
    for (const k of ['a b', 'a\nb', 'a\rb', 'a=b', 'a]b', '[evil]', 'a-b', 'a:b', '', 'a\tb'])
      assert.equal(RcloneOptionKey.safeParse(k).success, false, JSON.stringify(k))
  })
})

describe('RcloneOptionValue', () => {
  it('accepts everything rclone reads on one line — spaces, `=`, `;`, `#`, JSON, unicode', () => {
    for (const v of ['https://s3.eu-west-1.amazonaws.com', 'key=value x', 'true', '{"access_token":"ya29.a0Af", "scope": "https://www.googleapis.com/auth/drive"}', 'v3', 'münich', '8M'])
      assert.equal(RcloneOptionValue.safeParse(v).success, true, JSON.stringify(v))
  })

  it('refuses every control character — the vehicle for a forged line or section', () => {
    for (const v of ['a\nb', 'a\rb', 'a\n[evil]\nkey=v', 'a\tb', 'a\x00b'])
      assert.equal(RcloneOptionValue.safeParse(v).success, false, JSON.stringify(v))
  })
})

describe('the request schemas gate the rclone.conf writer', () => {
  it('a newline in a SECRET non-password option value is refused (the forged-section case)', () => {
    // `secret_access_key` is secret only by the name rule (rclone does not
    // type it IsPassword), so the post-write gate would NOT compare it — the
    // schema is the enforceable barrier.
    const forged = {
      name: 's3backup',
      type: 's3',
      options: { provider: 'AWS', secret_access_key: 'abc\n[evil]\ntype = s3' },
    }
    assert.equal(CloudRemoteWrite.safeParse(forged).success, false)
    assert.equal(CloudRemoteUpdate.safeParse({ options: forged.options }).success, false)
  })

  it('a newline in a KEY is refused (the extra-key case)', () => {
    const badKey = { name: 'r', type: 's3', options: { 'provider\nendpoint': 'x' } }
    assert.equal(CloudRemoteWrite.safeParse(badKey).success, false)
  })

  it('the `token` KEY is the one transitional multi-line exception — its own gate collapses it pre-write', () => {
    // `rclone authorize`'s marker block is legitimately multi-line INPUT; the
    // schema lets it through and normalizeOAuthToken collapses the valid JSON
    // to a single line (or refuses it with the token sentence) before anything
    // is written — so the FILE still never sees a control character.
    const markerPaste = 'Paste the following into your remote --->\n{"access_token":"ya29.a0Af"}\n<---End paste'
    const ok = CloudRemoteWrite.safeParse({ name: 'gd', type: 'drive', options: { token: markerPaste } })
    assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues))
    // A multi-line value in ANY OTHER key stays refused.
    assert.equal(CloudRemoteWrite.safeParse({ name: 'gd', type: 'drive', options: { token: '{"a":1}', scope: 'line1\nline2' } }).success, false)
  })

  it('an ordinary option and a type stay writable', () => {
    const ok = CloudRemoteWrite.safeParse({
      name: 'nas-backup',
      type: 's3',
      options: { provider: 'AWS', region: 'eu-west-1', secret_access_key: 'plaintext-secret' },
    })
    assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues))
    assert.equal(CloudRemoteUpdate.safeParse({ options: { hard_delete: 'false' } }).success, true)
  })
})
