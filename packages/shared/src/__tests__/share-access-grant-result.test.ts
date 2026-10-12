import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ShareAccessGrantResult } from '../schemas/access.js'

/**
 * The additive, optional `guestNote` on the share-path grant result (operator
 * ruling 2026-10-11: Samba admits no guest on a share that lists valid users,
 * so Everyone is not granted there and the result says so).
 *
 * The contract being pinned is compatibility, the same shape as the
 * `UnmountedMount` one: a result WITHOUT the key must keep parsing (results
 * written by an older daemon, and every grant on a share where the note does
 * not apply), and a result WITH it parses with the sentence kept.
 */

/** A minimal, valid grant result — the shape every consumer already speaks. */
const RESULT = {
  status: 'applied' as const,
  path: '/tank/media',
  granted: [{ kind: 'user' as const, name: 'alice', level: 'read-write' as const }],
  skipped: [],
  applyToExisting: false,
}

describe('ShareAccessGrantResult — the optional guestNote', () => {
  it('parses a result carrying the guest note, sentence kept', () => {
    const note = 'Guest access was not granted on the folder: the share lists valid users, so no guest can connect to it.'
    const parsed = ShareAccessGrantResult.safeParse({ ...RESULT, guestNote: note })
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
    assert.equal((parsed as { success: true, data: { guestNote?: string } }).data.guestNote, note)
  })

  it('an old payload without the key still parses (the field is optional, never required)', () => {
    const parsed = ShareAccessGrantResult.safeParse(RESULT)
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
    assert.equal((parsed as { success: true, data: { guestNote?: string } }).data.guestNote, undefined)
  })
})
