import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { quoteExecArg } from '../systemd-unit-store.js'

/**
 * cr.51r (review possible 2): `quoteExecArg` escaped none of systemd's own
 * syntax — `%n`/`$HOME`/`;` in a token would have been EXPANDED or SPLIT by
 * systemd, not passed to the runner. One test per character, each asserting
 * the exact text that lands in the rendered `ExecStart=` line (the writers
 * join these tokens verbatim). Slug tokens — every token the writers emit
 * today — stay byte-identical, so no existing unit's ExecStart changes.
 */
describe('quoteExecArg — a token round-trips through systemd (systemd.service(5) "Command lines")', () => {
  it('% is doubled: a specifier sign reaches the runner as a literal', () => {
    assert.equal(quoteExecArg('%n'), '%%n')
    assert.equal(quoteExecArg('100%'), '100%%')
    assert.equal(quoteExecArg('%%'), '%%%%')
  })

  it('$ is doubled: a variable sign reaches the runner as a literal', () => {
    assert.equal(quoteExecArg('$HOME'), '$$HOME')
    // (concatenated so the linter does not read the braces as a template)
    assert.equal(quoteExecArg('$' + '{HOME}'), '$$' + '{HOME}')
  })

  it('a backslash is doubled: systemd\'s escape char reaches the runner as a literal', () => {
    // A literal `\n` (backslash + n) must not read as an escape of `n`.
    assert.equal(quoteExecArg('a\\nb'), 'a\\\\nb')
    assert.equal(quoteExecArg('x\\'), 'x\\\\')
  })

  it('a token carrying " is double-quoted with the inner " escaped', () => {
    assert.equal(quoteExecArg('a"b'), '"a\\"b"')
    // The backslash the token itself carries is doubled FIRST, so the quote
    // escape is the only new backslash.
    assert.equal(quoteExecArg('a\\b"c'), '"a\\\\b\\"c"')
  })

  it('a token carrying a single quote is double-quoted (it stays literal inside)', () => {
    assert.equal(quoteExecArg('\'x\''), '"\'x\'"')
  })

  it('a token carrying ; is double-quoted (a bare ; would start a second command)', () => {
    assert.equal(quoteExecArg('a;b'), '"a;b"')
    assert.equal(quoteExecArg(';'), '";"')
  })

  it('a token carrying whitespace is double-quoted', () => {
    assert.equal(quoteExecArg('a b'), '"a b"')
    assert.equal(quoteExecArg(' '), '" "')
  })

  it('the empty token stays a quoted empty argument', () => {
    assert.equal(quoteExecArg(''), '""')
  })

  it('slug tokens pass through byte-identical (every ExecStart we write today)', () => {
    for (const slug of ['tank', 'tank/media', 'nightly-etc', 'nas1.example', '--pool', '--name', 'pve:local'])
      assert.equal(quoteExecArg(slug), slug)
  })

  it('control characters are refused, not quoted (cr.51 — the writer and the schema draw the same line)', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 'a\tb'])
      assert.throws(() => quoteExecArg(bad), /control characters/)
  })

  it('metacharacters combine: quoting and doubling apply together', () => {
    // `%` and `$` double even inside a quoted token; the token parses back to
    // exactly itself after systemd's specifier/variable expansion and split.
    assert.equal(quoteExecArg('a b%c'), '"a b%%c"')
    assert.equal(quoteExecArg('a;b$c'), '"a;b$$c"')
  })
})
