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

  it('every backend that carries a guide carries ONE plain sentence', () => {
    for (const [backend, guide] of Object.entries(CLOUD_BACKEND_GUIDES)) {
      assert.ok(guide.essential.length > 0, `${backend} names at least one essential field`)
      if (guide.guide === undefined) { continue }
      assert.match(guide.guide, /\.$/, `${backend}'s guide ends the sentence`)
      assert.equal(guide.guide.includes('. '), false, `${backend}'s guide is one sentence`)
    }
  })

  it('the OAuth backends carry NO guide — the token sentence is their only instruction (rclone.6 batch B)', () => {
    for (const backend of ['drive', 'onedrive', 'dropbox', 'box', 'pcloud']) {
      const guide = CLOUD_BACKEND_GUIDES[backend]
      assert.ok(guide, `${backend} is curated`)
      assert.equal(guide.guide, undefined, `${backend} has no guide sentence`)
      assert.deepEqual(guide.essential, ['token'], `${backend} keeps its essential list`)
    }
    // The non-OAuth curated backends keep theirs.
    for (const backend of ['s3', 'b2', 'sftp', 'ftp', 'webdav', 'smb', 'azureblob']) {
      assert.ok(CLOUD_BACKEND_GUIDES[backend].guide, `'${backend}' keeps its guide sentence`)
    }
  })
})
