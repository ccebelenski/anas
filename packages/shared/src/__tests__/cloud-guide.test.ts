import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLOUD_BACKEND_GUIDES } from '../cloud-guide.js'

/**
 * The remote-form curation table's own contract (story rclone.4): the option
 * names must be lowercase snake_case (they are matched against rclone's
 * option names verbatim) and no backend may list a name twice — a name listed
 * twice would render twice or split a field between two groups.
 */
describe('cloud-guide: the curation table (rclone.4)', () => {
  it('every curated option name is lowercase snake_case', () => {
    for (const [backend, guide] of Object.entries(CLOUD_BACKEND_GUIDES)) {
      for (const name of [...guide.essential, ...(guide.ownClient ?? [])])
        assert.match(name, /^[a-z][a-z0-9_]*$/, `${backend}.${name} is lowercase snake_case`)
    }
  })

  it('no backend lists a name twice', () => {
    for (const [backend, guide] of Object.entries(CLOUD_BACKEND_GUIDES)) {
      const all = [...guide.essential, ...(guide.ownClient ?? [])]
      assert.equal(new Set(all).size, all.length, `${backend} lists no option twice`)
      for (const list of [guide.essential, guide.ownClient ?? []]) {
        assert.equal(new Set(list).size, list.length, `${backend} lists no option twice within one group`)
      }
    }
  })

  it('every backend guides ONE plain sentence', () => {
    for (const [backend, guide] of Object.entries(CLOUD_BACKEND_GUIDES)) {
      assert.ok(guide.essential.length > 0, `${backend} names at least one essential field`)
      assert.match(guide.guide, /\.$/, `${backend}'s guide ends the sentence`)
      assert.equal(guide.guide.includes('. '), false, `${backend}'s guide is one sentence`)
    }
  })
})
