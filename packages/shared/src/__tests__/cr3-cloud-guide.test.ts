import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateOwnClientUpdate } from '../cloud-guide.js'

/**
 * cr3 CLOUD-M5 (review 2026-11-14): the update door judges the own-client
 * pair the update LEAVES — the body is the dialog's diff, an unchanged
 * client_id is absent, and a stored client_secret is named only in secretsSet.
 */
const ID = '1234567890-abc123def456.apps.googleusercontent.com'
const STORED = { options: { client_id: ID }, secretsSet: ['client_secret', 'token'] }

describe('validateOwnClientUpdate (cr3 CLOUD-M5)', () => {
  it('a secret rotation alone is a whole pair (the stored id)', () => {
    assert.deepEqual(validateOwnClientUpdate('drive', { client_secret: 'GOCSPX-new' }, STORED), { ok: true })
  })
  it('a token re-paste alone keeps the stored pair', () => {
    assert.deepEqual(validateOwnClientUpdate('drive', { token: '{"a":1}' }, STORED), { ok: true })
  })
  it('a blank secret is "unchanged": the stored one stands', () => {
    assert.deepEqual(validateOwnClientUpdate('drive', { client_secret: '' }, STORED), { ok: true })
  })
  it('clearing the id while the secret stays stored refuses (a lone secret)', () => {
    assert.equal(validateOwnClientUpdate('drive', { client_id: '' }, STORED).ok, false)
  })
  it('a new id with no secret anywhere refuses (a lone id)', () => {
    assert.equal(validateOwnClientUpdate('drive', { client_id: ID }, { options: {}, secretsSet: [] }).ok, false)
  })
  it('a malformed new id refuses by its shape', () => {
    const v = validateOwnClientUpdate('drive', { client_id: 'gdrive' }, STORED)
    assert.equal(v.ok, false)
    assert.match(v.ok ? '' : v.message, /is not a Google OAuth client ID/)
  })
  it('null clears (operator ruling): the secret alone while the id stays is the pair refusal', () => {
    const v = validateOwnClientUpdate('drive', { client_secret: null }, STORED)
    assert.equal(v.ok, false)
    assert.match(v.ok ? '' : v.message, /must be set together/)
  })
  it('null on both returns the remote to the built-in client', () => {
    assert.deepEqual(validateOwnClientUpdate('drive', { client_id: null, client_secret: null }, STORED), { ok: true })
  })
  it('a cleared secret with a NEW one typed is impossible on the wire, and a typed one wins over the stored', () => {
    assert.deepEqual(validateOwnClientUpdate('drive', { client_secret: 'GOCSPX-new' }, { options: { client_id: ID }, secretsSet: [] }), { ok: true })
  })
  it('review fix 8: a whitespace-only secret is a TYPED value (the writer would write it) — judged empty, so the pair is refused', () => {
    const v = validateOwnClientUpdate('drive', { client_secret: '   ' }, STORED)
    assert.equal(v.ok, false)
    assert.match(v.ok ? '' : v.message, /must be set together/)
  })
  it('a backend outside the OAuth five is not this rule\'s business', () => {
    assert.deepEqual(validateOwnClientUpdate('sftp', { client_id: 'x' }, { options: {}, secretsSet: [] }), { ok: true })
  })
})
