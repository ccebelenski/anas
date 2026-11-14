import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AbsolutePath, decodeUserHeader, encodeUserHeader, hasControlChars, SingleLine, userHeaderNeedsEncoding } from '../schemas/common.js'

/**
 * cr3.core: the shared single-line primitives refuse the Unicode line breaks
 * as well as C0/DEL. U+2028/U+2029 are line terminators to every JavaScript
 * regex (ANAS's own config parsers), NEL (U+0085) is a line break to Python's
 * splitlines (rtslib/targetcli); the rest of C1 holds no printable character.
 * Non-ASCII text and non-ASCII spaces stay legal: they end no line.
 */
describe('cr3.core hasControlChars / SingleLine / AbsolutePath: line separators', () => {
  const REFUSED: Array<[string, string]> = [
    ['NEL U+0085', '\u0085'],
    ['LINE SEPARATOR U+2028', '\u2028'],
    ['PARAGRAPH SEPARATOR U+2029', '\u2029'],
    ['C1 start U+0080', '\u0080'],
    ['C1 end U+009F', '\u009F'],
    ['DEL', '\u007F'],
    ['newline', '\n'],
    ['NUL', '\u0000'],
  ]
  for (const [name, ch] of REFUSED) {
    it(`refuses ${name} in a comment and in a path`, () => {
      assert.equal(hasControlChars(`a${ch}b`), true)
      assert.equal(SingleLine.safeParse(`comment${ch}path = /etc`).success, false)
      assert.equal(AbsolutePath.safeParse(`/mnt/a${ch}b`).success, false)
    })
  }

  const KEPT: Array<[string, string]> = [
    ['NBSP U+00A0 (first printable after C1)', 'a\u00A0b'],
    ['IDEOGRAPHIC SPACE U+3000', '共有\u3000フォルダ'],
    ['an accented letter', 'Jörg\'s share'],
    ['CJK', '用户的共享'],
    ['an emoji (surrogate pair)', 'backups 💾'],
    ['NARROW NBSP U+202F beside the separators', 'a\u202Fb'],
  ]
  for (const [name, value] of KEPT) {
    it(`keeps ${name}`, () => {
      assert.equal(hasControlChars(value), false)
      assert.equal(SingleLine.safeParse(value).success, true)
      assert.equal(AbsolutePath.safeParse(`/mnt/${value}`).success, true)
    })
  }
})

describe('cr3.core CORE-M3 user header encoding', () => {
  it('plain ASCII ids travel raw; anything else (or a %) is encoded and round-trips', () => {
    assert.equal(userHeaderNeedsEncoding('root@pam'), false)
    for (const id of ['用户@pve', 'jörg@pve', '50%off@pve', 'a b@pve']) {
      assert.equal(userHeaderNeedsEncoding(id), true, id)
      const wire = encodeUserHeader(id)!
      assert.ok(/^[\x21-\x7E]+$/.test(wire), wire)
      assert.equal(decodeUserHeader(wire), id)
    }
    assert.equal(encodeUserHeader('\uD800@pve'), undefined, 'a lone surrogate cannot be encoded')
    assert.equal(decodeUserHeader('%E7%94'), undefined)
    assert.equal(decodeUserHeader(''), undefined)
  })
})
