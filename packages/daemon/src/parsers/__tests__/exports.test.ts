import type { NfsExport } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addExport,
  getExport,
  hasExport,
  parseExports,
  parseExportsDoc,
  removeExport,
  replaceExport,
  serializeExportLine,
  serializeExportsDoc,
} from '../exports.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, '../../fixtures/nfs/etc-exports')

function loadFixture(): string {
  return readFileSync(FIXTURE, 'utf-8')
}

describe('parseExports', () => {
  it('parses every export in a realistic /etc/exports (incl. quoted + wildcard)', () => {
    const exports = parseExports(loadFixture())
    const paths = exports.map(e => e.path)
    assert.deepEqual(paths, [
      '/srv/nfs/media',
      '/srv/nfs/backups',
      '/export/legacy',
      '/srv/nfs/my documents',
    ])
  })

  it('parses multiple clients on one line, each with its own options', () => {
    const media = getExport(loadFixture(), '/srv/nfs/media')!
    assert.deepEqual(media.clients, [
      { spec: '192.168.1.0/24', options: ['rw', 'sync', 'no_subtree_check'] },
      { spec: '10.0.0.5', options: ['ro', 'sync', 'no_subtree_check'] },
    ])
  })

  it('parses a wildcard client', () => {
    const backups = getExport(loadFixture(), '/srv/nfs/backups')!
    assert.deepEqual(backups.clients, [
      { spec: '*', options: ['ro', 'sync', 'no_subtree_check', 'root_squash'] },
    ])
  })

  it('parses a double-quoted path with spaces', () => {
    const docs = getExport(loadFixture(), '/srv/nfs/my documents')!
    assert.deepEqual(docs.clients, [
      { spec: '192.168.1.0/24', options: ['rw', 'sync'] },
    ])
  })

  it('ignores comments and blank lines', () => {
    assert.equal(parseExports('# just a comment\n\n   \n').length, 0)
  })

  it('parses a client with no options (bare host, NFS defaults)', () => {
    const [exp] = parseExports('/data host.example.com\n')
    assert.deepEqual(exp.clients, [{ spec: 'host.example.com', options: [] }])
  })
})

describe('round-trip fidelity', () => {
  it('parse → serialize reproduces the fixture BYTE-FOR-BYTE', () => {
    const text = loadFixture()
    assert.equal(serializeExportsDoc(parseExportsDoc(text)), text)
  })

  it('round-trips a file with no trailing newline unchanged', () => {
    const text = '/a host(rw)\n/b other(ro)'
    assert.equal(serializeExportsDoc(parseExportsDoc(text)), text)
  })

  it('round-trips an empty file unchanged', () => {
    assert.equal(serializeExportsDoc(parseExportsDoc('')), '')
  })

  it('round-trips odd whitespace (tabs, multiple spaces) unchanged', () => {
    const text = '/export/legacy\t\tnfsclient.example.com(rw,async,no_root_squash)\n'
    assert.equal(serializeExportsDoc(parseExportsDoc(text)), text)
  })
})

describe('surgical edits — add', () => {
  it('appends a new export line and leaves the rest byte-identical', () => {
    const before = loadFixture()
    const exp: NfsExport = { path: '/srv/nfs/new', clients: [{ spec: '10.1.0.0/16', options: ['rw', 'sync'] }] }
    const after = addExport(before, exp)

    assert.ok(after.startsWith(before), 'existing content must be preserved verbatim as a prefix')
    assert.equal(after.slice(before.length), '/srv/nfs/new 10.1.0.0/16(rw,sync)\n')
    assert.ok(hasExport(after, '/srv/nfs/new'))
  })

  it('appends to a file with no trailing newline on its own line', () => {
    const before = '/a host(rw)'
    const after = addExport(before, { path: '/b', clients: [{ spec: '*', options: ['ro'] }] })
    assert.equal(after, '/a host(rw)\n/b *(ro)')
  })

  it('adds a newline-terminated line to an empty file', () => {
    const after = addExport('', { path: '/a', clients: [{ spec: '*', options: ['rw'] }] })
    assert.equal(after, '/a *(rw)\n')
  })
})

describe('surgical edits — replace', () => {
  it('replaces ONLY the target path line, leaving all others byte-identical', () => {
    const before = loadFixture()
    const after = replaceExport(before, '/srv/nfs/media', {
      path: '/srv/nfs/media',
      clients: [{ spec: '172.16.0.0/12', options: ['rw', 'async'] }],
    })

    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    assert.equal(beforeLines.length, afterLines.length)
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].startsWith('/srv/nfs/media'))
        assert.equal(afterLines[i], '/srv/nfs/media 172.16.0.0/12(rw,async)')
      else
        assert.equal(afterLines[i], beforeLines[i], `line ${i} must be untouched`)
    }
  })
})

describe('surgical edits — remove', () => {
  it('removes ONLY the target path line, leaving all others byte-identical', () => {
    const before = loadFixture()
    const after = removeExport(before, '/srv/nfs/backups')

    assert.ok(!hasExport(after, '/srv/nfs/backups'))
    // Every surviving line is unchanged, and only the one line disappeared.
    const removed = before.split('\n').filter(l => !l.startsWith('/srv/nfs/backups'))
    assert.equal(after, removed.join('\n'))
  })

  it('is a no-op for a path that is not exported', () => {
    const before = loadFixture()
    assert.equal(removeExport(before, '/not/exported'), before)
  })
})

describe('serializeExportLine', () => {
  it('quotes a path containing spaces', () => {
    assert.equal(
      serializeExportLine({ path: '/srv/my docs', clients: [{ spec: '*', options: ['ro'] }] }),
      '"/srv/my docs" *(ro)',
    )
  })

  // An empty option list is LEGAL and means "whatever the kernel defaults to"
  // (exports(5): ro, sync, root_squash) — NOT the read-write set ANAS seeds new
  // rows with. The editor's ghost text says so rather than showing options we
  // would not write (issue #42).
  it('omits parens for a client with no options — the kernel then applies its own', () => {
    assert.equal(
      serializeExportLine({ path: '/data', clients: [{ spec: 'host', options: [] }] }),
      '/data host',
    )
    // And it round-trips: a blank option list stays blank, never re-seeded.
    assert.deepEqual(parseExports('/data host\n')[0].clients, [{ spec: 'host', options: [] }])
  })
})

// --- cr3.shares M5 — read the way exportfs reads (exports(5)) ---------------
describe('exports(5) syntax the reader honours (cr3.shares M5)', () => {
  // The review's probe: a hand-written entry wrapped with backslashes.
  const WRAPPED = '# hand-written\n/srv/media \\\n    10.0.0.0/24(rw,sync,no_subtree_check) \\\n    192.168.1.5(ro)\n/srv/other 10.0.0.9(rw)\n'

  it('an entry continued with a backslash is one export with every client', () => {
    assert.deepEqual(parseExports(WRAPPED), [
      { path: '/srv/media', clients: [
        { spec: '10.0.0.0/24', options: ['rw', 'sync', 'no_subtree_check'] },
        { spec: '192.168.1.5', options: ['ro'] },
      ] },
      { path: '/srv/other', clients: [{ spec: '10.0.0.9', options: ['rw'] }] },
    ])
    assert.equal(serializeExportsDoc(parseExportsDoc(WRAPPED)), WRAPPED)
  })

  it('removing a wrapped entry removes every line of it — no orphaned continuation', () => {
    assert.equal(removeExport(WRAPPED, '/srv/media'), '# hand-written\n/srv/other 10.0.0.9(rw)\n')
  })

  it('replacing a wrapped entry replaces every line of it', () => {
    assert.equal(
      replaceExport(WRAPPED, '/srv/media', { path: '/srv/media', clients: [{ spec: '10.0.0.7', options: ['rw'] }] }),
      '# hand-written\n/srv/media 10.0.0.7(rw)\n/srv/other 10.0.0.9(rw)\n',
    )
  })

  it('a `#` after the clients is a comment, not a client', () => {
    assert.deepEqual(parseExports('/srv/a 10.0.0.1(rw) # old: 10.0.0.2(rw)\n')[0].clients, [{ spec: '10.0.0.1', options: ['rw'] }])
  })

  it('an octal escape in the export name is the byte it names', () => {
    assert.equal(parseExports('/srv/My\\040Data 10.0.0.1(ro)\n')[0].path, '/srv/My Data')
    assert.equal(parseExports('/srv/caf\\303\\251 *(ro)\n')[0].path, '/srv/café')
    assert.equal(hasExport('/srv/My\\040Data 10.0.0.1(ro)\n', '/srv/My Data'), true)
  })

  it('a quote toggles anywhere in the name', () => {
    assert.equal(parseExports('/mnt/"My Data" host(rw)\n')[0].path, '/mnt/My Data')
  })

  it('`-opts` after the path are the defaults every later client starts from', () => {
    assert.deepEqual(parseExports('/srv/d -rw,sync hostA hostB(no_root_squash)\n')[0].clients, [
      { spec: 'hostA', options: ['rw', 'sync'] },
      { spec: 'hostB', options: ['rw', 'sync', 'no_root_squash'] },
    ])
  })

  it('a no-break space is not a separator (exportfs splits on ASCII blanks only)', () => {
    assert.deepEqual(parseExports('/srv/a b host(rw)\n')[0].path, '/srv/a b')
  })

  it('a backslash before CRLF does not continue the entry', () => {
    const text = '/srv/a host(rw)\\\r\n/srv/b host(ro)\n'
    assert.deepEqual(parseExports(text).map(e => e.path), ['/srv/a', '/srv/b'])
  })
})

// --- cr3.shares (review) — comments never hide an entry; an untouched edit keeps bytes
describe('comments and untouched edits (cr3.shares, review)', () => {
  it('a comment line ending in a backslash continues nothing: the export after it is read', () => {
    const text = '# disabled for now \\\n/srv/hidden host1(rw)\n/srv/shown host2(ro)\n'
    assert.deepEqual(parseExports(text).map(e => e.path), ['/srv/hidden', '/srv/shown'])
  })

  it('a backslash inside a trailing comment continues nothing either', () => {
    const text = '/srv/a host1(rw) # note \\\n/srv/b host2(ro)\n'
    assert.deepEqual(parseExports(text).map(e => e.path), ['/srv/a', '/srv/b'])
  })

  it('replacing an entry with the clients it already has is byte-identical (continuations and comments kept)', () => {
    const text = '/srv/a host1(rw,sync) \\\n    host2(ro) # two hosts\n/srv/b *(ro)\n'
    assert.equal(replaceExport(text, '/srv/a', getExport(text, '/srv/a')!), text)
  })

  it('a real edit keeps the entry\'s trailing comment', () => {
    const text = '/srv/a host1(rw) # trailing note\n/srv/b host2(ro)\n'
    assert.equal(
      replaceExport(text, '/srv/a', { path: '/srv/a', clients: [{ spec: 'host9', options: ['ro'] }] }),
      '/srv/a host9(ro) # trailing note\n/srv/b host2(ro)\n',
    )
  })
})
