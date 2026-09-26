import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLOUD_BACKEND_GUIDES, validateOwnClient } from '../cloud-guide.js'

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
      if (guide.guide === undefined) {
        continue
      }
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

/**
 * The save-time own-OAuth-client guard (rclone.4 rider, human-pass finding
 * 2026-09-26): ONE rule shared by the daemon's doors and the ES5 UI port, so
 * its vectors live OUTSIDE the code — `test-vectors/own-client.json` — and
 * every consumer's test iterates the same file.
 */
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), '../../test-vectors')

interface OwnClientCase {
  name: string
  backend: string
  options: Record<string, string>
  ok: boolean
  message?: string
}

const OWN_CLIENT_CASES: OwnClientCase[] = JSON.parse(
  readFileSync(join(VECTORS, 'own-client.json'), 'utf-8'),
)

describe('validateOwnClient — the save-time own-client guard (rclone.4 rider)', () => {
  it('answers every vector in test-vectors/own-client.json', () => {
    for (const c of OWN_CLIENT_CASES) {
      const got = validateOwnClient(c.backend, c.options)
      assert.equal(got.ok, c.ok, c.name)
      if (c.message !== undefined) {
        assert.equal(got.ok, false, c.name)
        assert.equal(got.message, c.message, c.name)
      }
      else if (!got.ok) {
        assert.ok(got.message, `${c.name} carries a sentence`)
      }
    }
  })

  it('every OAuth backend in the curation table is covered by the rule', () => {
    for (const backend of ['drive', 'onedrive', 'dropbox', 'box', 'pcloud']) {
      // An empty pair is rclone's built-in client — never refused.
      assert.deepEqual(validateOwnClient(backend, {}), { ok: true }, backend)
    }
  })
})
