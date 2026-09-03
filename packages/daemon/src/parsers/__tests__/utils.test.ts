import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseDedupRatio, parseHumanSize, parseIntOrZero, parsePercent, parseZfsBool, parseZfsDate } from '../utils.js'

describe('parseHumanSize', () => {
  it('parses bytes', () => {
    assert.equal(parseHumanSize('0B'), 0)
    assert.equal(parseHumanSize('512B'), 512)
  })

  it('parses kilobytes', () => {
    assert.equal(parseHumanSize('123K'), 123 * 1024)
    assert.equal(parseHumanSize('1K'), 1024)
  })

  it('parses megabytes', () => {
    assert.equal(parseHumanSize('480M'), 480 * 1024 * 1024)
    assert.equal(parseHumanSize('1M'), 1024 * 1024)
  })

  it('parses gigabytes', () => {
    assert.equal(parseHumanSize('1G'), 1024 * 1024 * 1024)
  })

  it('parses decimal values', () => {
    assert.equal(parseHumanSize('1.38G'), Math.round(1.38 * 1024 * 1024 * 1024))
    assert.equal(parseHumanSize('49.5K'), Math.round(49.5 * 1024))
  })

  it('parses terabytes', () => {
    assert.equal(parseHumanSize('1T'), 1024 ** 4)
  })

  it('returns 0 for dash or empty', () => {
    assert.equal(parseHumanSize('-'), 0)
    assert.equal(parseHumanSize(''), 0)
  })

  // Issue #50: `zfsListArgs` asks for `-p`, whose values carry NO unit. A bare
  // integer used to fall off the regex and parse as 0 — which is how a real
  // shrink reached `zfs set volsize=` looking like a grow.
  it('parses the exact (-p) form: a unit-less byte count', () => {
    assert.equal(parseHumanSize('1331439861760'), 1331439861760)
    assert.equal(parseHumanSize('16384'), 16384)
    assert.equal(parseHumanSize('0'), 0)
  })

  it('keeps the display form meaning exactly what it did', () => {
    // The two forms of the SAME size, and the gap that made #50 a safety bug.
    assert.equal(parseHumanSize('1.21T'), 1330409069609)
    assert.ok(1331439861760 - parseHumanSize('1.21T') > 900 * 1024 * 1024)
  })

  it('accepts a JSON number as well as a string', () => {
    assert.equal(parseHumanSize(1331439861760), 1331439861760)
  })

  it('still returns 0 for values that are not sizes', () => {
    assert.equal(parseHumanSize('none'), 0)
    assert.equal(parseHumanSize('on'), 0)
    assert.equal(parseHumanSize('12X'), 0)
  })
})

describe('parseIntOrZero', () => {
  it('parses string integers', () => {
    assert.equal(parseIntOrZero('0'), 0)
    assert.equal(parseIntOrZero('42'), 42)
    assert.equal(parseIntOrZero('3'), 3)
  })

  it('passes through numbers', () => {
    assert.equal(parseIntOrZero(26), 26)
  })

  it('returns 0 for undefined/invalid', () => {
    assert.equal(parseIntOrZero(undefined), 0)
    assert.equal(parseIntOrZero('abc'), 0)
  })
})

describe('parsePercent', () => {
  it('parses percentage strings', () => {
    assert.equal(parsePercent('3%'), 3)
    assert.equal(parsePercent('0%'), 0)
    assert.equal(parsePercent('100%'), 100)
    assert.equal(parsePercent('42.5%'), 42.5)
  })

  it('returns 0 for dash or empty', () => {
    assert.equal(parsePercent('-'), 0)
    assert.equal(parsePercent(''), 0)
  })
})

describe('parseDedupRatio', () => {
  it('parses ratio strings', () => {
    assert.equal(parseDedupRatio('1.00x'), 1.0)
    assert.equal(parseDedupRatio('2.50x'), 2.5)
  })

  it('returns 1.0 for dash or empty', () => {
    assert.equal(parseDedupRatio('-'), 1.0)
    assert.equal(parseDedupRatio(''), 1.0)
  })

  // Whether libzfs keeps the trailing `x` under `-p` is unverified on a real
  // node (see the #50 live-capture checklist). Read both, so the answer either
  // way is a ratio and never a silent 1.00 default.
  it('reads a ratio with or without the trailing x', () => {
    assert.equal(parseDedupRatio('1.42'), 1.42)
    assert.equal(parseDedupRatio('1.42x'), 1.42)
  })
})

describe('parseZfsDate', () => {
  it('parses ZFS date strings to ISO 8601', () => {
    const result = parseZfsDate('Mon Mar 16 02:09:34 UTC 2026')
    assert.ok(result)
    assert.equal(result, '2026-03-16T02:09:34.000Z')
  })

  it('returns null for dash or empty', () => {
    assert.equal(parseZfsDate('-'), null)
    assert.equal(parseZfsDate(''), null)
  })
})

describe('parseZfsBool', () => {
  it('parses on/off', () => {
    assert.equal(parseZfsBool('on'), true)
    assert.equal(parseZfsBool('off'), false)
  })
})
