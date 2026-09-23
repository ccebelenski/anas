import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  listSections,
  parseRcloneConf,
  removeSection,
  serializeRcloneConf,
  upsertSection,
} from '../rclone-conf.js'

// A deliberately gnarly, realistic fixture (story rclone.1): two sections, a
// `# anas:test comment` full-line comment INSIDE a section, a value with
// spaces and `=`/`;` in it, a token JSON value, a key with NO spaces around
// `=`, a `;` comment, a key repeated (duplicate), and NO trailing newline.
// This is the round-trip torture test.
const FIXTURE = [
  '# anas:test comment over the whole file',
  '; a semicolon comment',
  '',
  '[media]',
  '\ttype = webdav',
  'endpoint = https://x y=z ;q',
  'token={"access_token":"x","refresh_token":"y"}',
  '  # anas:test comment inside the section',
  'url = https://example.org ; not a comment',
  '',
  '[sftp1]',
  'type=sftp',
  'host = 127.0.0.1',
  'pass = OBSCURED-value;=with equals',
  'host = 10.0.0.2',
].join('\n') // note: no trailing newline on purpose

describe('rclone.conf round-trip (rclone.1)', () => {
  it('parse + serialize is byte-identical for the gnarly fixture', () => {
    assert.equal(serializeRcloneConf(parseRcloneConf(FIXTURE)), FIXTURE)
  })

  it('parse + serialize is byte-identical for empty, blank and odd inputs', () => {
    const cases = [
      '',
      '\n',
      '   \n\t\n  ',
      'no sections at all\njust stray = lines\nand = = =',
      '[only]\n',
      '[a]\n\n\n\n[b]\nc = 3\n',
      '[a]\nk = v', // no final newline
      '\n\n[a]\n\n',
      '[ spaced name ]\nx = 1\n',
      '[a]\nk = \nk =', // empty values, no final newline
      'x = orphan key before any section\n',
    ]
    for (const text of cases)
      assert.equal(serializeRcloneConf(parseRcloneConf(text)), text, `round-trip of ${JSON.stringify(text)}`)
  })

  it('listSections reads values verbatim: one leading space after = stripped, last duplicate wins', () => {
    const sections = listSections(parseRcloneConf(FIXTURE))
    assert.deepEqual(sections.map(s => s.name), ['media', 'sftp1'])

    const media = sections[0]!
    assert.equal(media.values.type, 'webdav')
    // spaces, `=` and `;` inside the value survive verbatim
    assert.equal(media.values.endpoint, 'https://x y=z ;q')
    // the JSON token value survives verbatim (the line itself has no spaces
    // around `=`, so nothing is stripped)
    assert.equal(media.values.token, '{"access_token":"x","refresh_token":"y"}')
    // a `;` mid-value is NOT a comment
    assert.equal(media.values.url, 'https://example.org ; not a comment')

    const sftp1 = sections[1]!
    // no-spaces spelling parses; the DUPLICATE host keeps the LAST value
    assert.equal(sftp1.values.type, 'sftp')
    assert.equal(sftp1.values.host, '10.0.0.2')
    assert.equal(sftp1.values.pass, 'OBSCURED-value;=with equals')
  })

  it('listSections skips the preamble and keeps duplicate-key last-wins across all lines', () => {
    const text = '[a]\nk = 1\nk = 2\nk = 3\n'
    const [only] = listSections(parseRcloneConf(text))
    assert.deepEqual(only, { name: 'a', values: { k: '3' } })
  })
})

describe('rclone.conf upsertSection (rclone.1)', () => {
  it('rewrites an existing section in place: comments kept at the top, every other byte identical', () => {
    const text = `${[
      '[media]',
      'type = webdav',
      '  # anas:test comment inside the section',
      'endpoint = old',
      '',
      '[sftp1]',
      'type = sftp',
      'host = 127.0.0.1',
    ].join('\n')}\n`

    const next = upsertSection(text, 'media', { type: 'webdav', endpoint: 'https://new', extra: 'z' })

    // The sftp1 section (and its separator blank) must be byte-identical.
    assert.ok(next.endsWith('\n[sftp1]\ntype = sftp\nhost = 127.0.0.1\n'), `got:\n${next}`)
    // The rewritten section: header, the comment at the top, then the new
    // key lines in insertion order, then the blank separator again.
    assert.equal(
      next,
      '[media]\n'
      + '  # anas:test comment inside the section\n'
      + 'type = webdav\n'
      + 'endpoint = https://new\n'
      + 'extra = z\n'
      + '\n'
      + '[sftp1]\ntype = sftp\nhost = 127.0.0.1\n',
    )
    // Untouched prefix/suffix comparison: everything after the media section
    // is exactly the old bytes.
    const prefix = '[sftp1]\ntype = sftp\nhost = 127.0.0.1\n'
    assert.equal(next.slice(next.indexOf(prefix)), prefix)
  })

  it('an untouched save of the LAST section keeps the file ending with a newline', () => {
    const text = '[media]\nx = 1\n'
    const next = upsertSection(text, 'media', { x: '1' })
    assert.equal(next, '[media]\nx = 1\n')
  })

  it('a section without a final newline does not gain one', () => {
    const text = '[a]\nx = 1\n[b]\ny = 2'
    const next = upsertSection(text, 'b', { y: '3' })
    assert.equal(next, '[a]\nx = 1\n[b]\ny = 3')
  })

  it('appends a new section to an empty file in rclone\'s own format', () => {
    const next = upsertSection('', 'new', { type: 'sftp', host: 'h' })
    assert.equal(next, '[new]\ntype = sftp\nhost = h\n')
  })

  it('appends a new section to a file WITHOUT a final newline, adding exactly one blank line', () => {
    const text = '[a]\nx = 1'
    const next = upsertSection(text, 'b', { type: 'sftp' })
    assert.equal(next, '[a]\nx = 1\n\n[b]\ntype = sftp\n')
  })

  it('appends a new section after a file that ends in extra blanks with exactly one blank separator', () => {
    const text = '[a]\nx = 1\n\n'
    const next = upsertSection(text, 'b', { k: 'v' })
    assert.equal(next, '[a]\nx = 1\n\n[b]\nk = v\n')
  })

  it('normalises a multi-blank separator to exactly one blank line on rewrite', () => {
    const text = '[a]\nx = 1\n\n\n[b]\ny = 2\n'
    const next = upsertSection(text, 'a', { x: '9' })
    assert.equal(next, '[a]\nx = 9\n\n[b]\ny = 2\n')
  })

  it('drops blank lines from inside the rewritten section body', () => {
    const text = '[a]\nk = 1\n\nk2 = 2\n'
    const next = upsertSection(text, 'a', { k: '1', k2: '2' })
    assert.equal(next, '[a]\nk = 1\nk2 = 2\n')
  })

  it('keeps a section header line verbatim (odd spacing survives)', () => {
    const text = '[  media  ]\nx = 1\n'
    const next = upsertSection(text, 'media', { x: '2' })
    assert.equal(next, '[  media  ]\nx = 2\n')
  })
})

describe('rclone.conf removeSection (rclone.1)', () => {
  const TEXT = `${[
    '[a]',
    'x = 1',
    '',
    '[b]',
    'y = 2',
    '',
    '[c]',
    'z = 3',
  ].join('\n')}\n`

  it('removes a middle section and its trailing blank line, keeping the rest byte-identical', () => {
    assert.equal(removeSection(TEXT, 'b'), '[a]\nx = 1\n\n[c]\nz = 3\n')
  })

  it('removes the first section', () => {
    assert.equal(removeSection(TEXT, 'a'), '[b]\ny = 2\n\n[c]\nz = 3\n')
  })

  it('removes the LAST section cleanly (no dangling blank lines)', () => {
    assert.equal(removeSection(TEXT, 'c'), '[a]\nx = 1\n\n[b]\ny = 2\n')
  })

  it('removing the only section leaves an empty file', () => {
    assert.equal(removeSection('[only]\nk = v\n', 'only'), '')
    assert.equal(removeSection('[only]\nk = v', 'only'), '')
  })

  it('an absent section leaves the text untouched', () => {
    assert.equal(removeSection(TEXT, 'nope'), TEXT)
  })

  it('names are exact and case-sensitive (rclone semantics)', () => {
    assert.equal(removeSection('[Media]\nk = v\n', 'media'), '[Media]\nk = v\n')
    assert.equal(upsertSection('[media]\nk = v\n', 'Media', { k: 'w' }), '[media]\nk = v\n\n[Media]\nk = w\n')
  })
})
