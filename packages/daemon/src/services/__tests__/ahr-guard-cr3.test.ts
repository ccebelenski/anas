import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { expansionStateRefusal } from '../ahr-guard.js'

/**
 * cr3 (INVENTED-STATE-H3): the new pool state `unknown` — the mount table
 * could not be read, so whether btrfs forced the filesystem read-only is not
 * known. The expansion's §4 pre-check refuses it like `readonly`: a reshape is
 * never started on the strength of a read that did not see.
 */
describe('expansionStateRefusal — cr3: an unknown pool state refuses', () => {
  const clean = [{ band: 1, state: 'clean' as const }]
  const pool = (state: string) => ({ name: 'tank', state, arrays: clean }) as unknown as Parameters<typeof expansionStateRefusal>[0]

  it('refuses `unknown` with the reason and no confirm bypass', () => {
    const refusal = expansionStateRefusal(pool('unknown'))
    assert.ok(refusal)
    assert.equal(refusal.status, 409)
    assert.match(refusal.message, /pool 'tank' is in an unknown state — the kernel mount table could not be read/)
    assert.match(refusal.message, /no confirm bypass/)
  })

  it('control: a healthy pool passes', () => {
    assert.equal(expansionStateRefusal(pool('healthy')), null)
  })
})
