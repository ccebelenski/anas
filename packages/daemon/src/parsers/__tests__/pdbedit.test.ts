import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePdbeditNames } from '../pdbedit.js'

describe('parsePdbeditNames', () => {
  it('collects usernames from `username:uid:gecos` lines', () => {
    const stdout = [
      'media:1000:Media User',
      'jane:1001:Jane Doe',
      'backup-svc:1002:',
      '',
    ].join('\n')
    const names = parsePdbeditNames(stdout)
    assert.equal(names.size, 3)
    assert.ok(names.has('media'))
    assert.ok(names.has('jane'))
    assert.ok(names.has('backup-svc'))
    assert.equal(names.has('root'), false)
  })

  it('returns an empty set for empty output', () => {
    assert.equal(parsePdbeditNames('').size, 0)
    assert.equal(parsePdbeditNames('\n\n').size, 0)
  })
})
