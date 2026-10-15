import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExportClientSpec, ExportOption, ExportOptionList, isExportClientSpec, isExportPath } from '../formats/exports.js'
import { CreateNfsExportRequest, UpdateNfsExportRequest } from '../schemas/shares.js'

/**
 * The per-format /etc/exports layer from cr.13 (review H3(b), ruling (i)): a
 * client spec or option token written into the file must be free of the
 * characters that change how exportfs splits a line — whitespace, `(`, `)`,
 * `,`, `"`, `\` and `#` — and an exported path must not carry `"`, `\`, `#`
 * or a control character (spaces stay legal: the writer double-quotes them).
 */

describe('ExportClientSpec', () => {
  it('accepts the legitimate spec vocabulary', () => {
    // The review's accepted set, verbatim.
    for (const s of ['192.168.1.0/24', '*.lan', '@trusted', 'host1', '*'])
      assert.equal(ExportClientSpec.safeParse(s).success, true, JSON.stringify(s))
    // Plus the real shapes exports(5) names: FQDNs, IPv6 addresses and CIDRs.
    for (const s of ['host.example.com', '2001:db8::1', '2001:db8:dead::/64', 'nfs01.fleet'])
      assert.equal(ExportClientSpec.safeParse(s).success, true, JSON.stringify(s))
  })

  it('refuses every hostile spec from the review — each one changes the parse', () => {
    for (const s of [
      '10.0.0.0/24 rw', // a space ADDS A CLIENT (the review's attack)
      'host(ro)', // parens start an option list
      'host,other', // a comma inside a spec
      '"host',
      'host"', // a quote breaks writing
      'host\\', // a trailing backslash is a line continuation
      'host#x', // a hash starts a comment / hides the rest
      '10.0.0.0/24\t', // embedded tab
      'a\nb', // a control character
    ])
      assert.equal(ExportClientSpec.safeParse(s).success, false, JSON.stringify(s))
  })
})

describe('ExportOption', () => {
  it('accepts the review\'s option vocabulary — commas are the join, never inside a token', () => {
    for (const t of ['rw', 'sync', 'no_subtree_check', 'sec=sys'])
      assert.equal(ExportOption.safeParse(t).success, true, JSON.stringify(t))
    for (const t of ['root_squash', 'no_root_squash', 'fsid=0', 'anonuid=65534', 'port=2049', 'crossmnt'])
      assert.equal(ExportOption.safeParse(t).success, true, JSON.stringify(t))
  })

  it('refuses any option that needs a structural character', () => {
    for (const t of ['rw sync', 'a(b)', 'a,b', 'a"b', 'a\\b', 'a#b', '=x', 'key=', 'rw\nsync', 'rp:string', 'a=b c'])
      assert.equal(ExportOption.safeParse(t).success, false, JSON.stringify(t))
  })
})

describe('ExportOptionList', () => {
  it('accepts the review\'s joined option list, and the empty list', () => {
    assert.equal(ExportOptionList.safeParse('rw,sync,no_subtree_check,sec=sys').success, true)
    assert.equal(ExportOptionList.safeParse('').success, true)
  })

  it('refuses an empty token and a whitespace/control-bearing list', () => {
    for (const s of ['rw,,sync', 'rw, sync', ',', 'rw\nsync'])
      assert.equal(ExportOptionList.safeParse(s).success, false, JSON.stringify(s))
  })
})

describe('export PATH write-safety', () => {
  it('a path with spaces stays legal — the writer double-quotes it', () => {
    assert.equal(isExportPath('/srv/nfs/My Docs'), true)
    assert.equal(isExportPath('/srv/nfs/Hï'), true) // non-ASCII printable is fine
  })

  it('refuses `"`, `\\`, `#` and control characters', () => {
    for (const p of ['/srv/nfs/a"b', '/srv/nfs/a\\b', '/srv/nfs/a#b', '/srv/nfs/a\nb', '/srv/nfs/a\x00b'])
      assert.equal(isExportPath(p), false, JSON.stringify(p))
  })
})

describe('the export request schemas gate both boundaries', () => {
  const spec = (s: string) => ({ spec: s, options: [] })

  it('a hostile spec or option is refused as a whole request', () => {
    const withHostileSpec = { path: '/srv/x', clients: [spec('10.0.0.0/24 ro')] }
    assert.equal(CreateNfsExportRequest.safeParse(withHostileSpec).success, false)
    const withHostileOption = { path: '/srv/x', clients: [{ spec: '*', options: ['ro,sync'] }] }
    assert.equal(CreateNfsExportRequest.safeParse(withHostileOption).success, false)
    const withHostilePath = { path: '/srv/"x', clients: [spec('*')] }
    assert.equal(CreateNfsExportRequest.safeParse(withHostilePath).success, false)
  })

  it('the review\'s accepted sets form a valid request, and the fixture\'s values do too', () => {
    const ok = CreateNfsExportRequest.safeParse({
      path: '/srv/nfs/media',
      clients: [
        { spec: '192.168.1.0/24', options: ['rw', 'sync', 'no_subtree_check'] },
        { spec: '*.lan', options: ['ro'] },
        { spec: '@trusted', options: [] },
        { spec: 'host1', options: ['sec=sys'] },
      ],
    })
    assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues))
    const update = UpdateNfsExportRequest.safeParse({
      clients: [{ spec: '10.0.0.5', options: ['ro', 'sync', 'no_subtree_check'] }],
    })
    assert.equal(update.success, true)
  })

  it('a hand-maintained spacing INSIDE a submitted option is refused (the round trip must stay honest)', () => {
    // The writer joins options with ',' and the reader splits on ',' — a token
    // carrying whitespace is a different list on read than on write.
    assert.equal(CreateNfsExportRequest.safeParse({ path: '/srv/x', clients: [{ spec: '*', options: ['ro ,sync'] }] }).success, false)
  })
})

describe('export client spec: no leading dash (node pass 2026-10-14)', () => {
  it('refuses a spec exportfs would read as a default-options block', () => {
    assert.equal(isExportClientSpec('-x'), false)
    assert.equal(isExportClientSpec('-'), false)
    assert.equal(isExportClientSpec('host-1'), true)
  })
})
