import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeMountTarget } from '../mount-target.js'

/**
 * The normaliser's table (Epic 18 bug fix). Every shape an operator has
 * actually typed into the Server / Share fields — the reproduced failures
 * (`//10.0.0.212`, `10.0.0.212/`, an empty share, a pasted `smb://host/
 * share`) plus the IPv6 and `host:/export` corners. `problems` must carry
 * the exact guiding sentence a 400 shows.
 */

const SHARE_REQUIRED = 'share name is required (the name of the share on the server, e.g. `pictures`)'
const SERVER_REQUIRED = 'server is required'

interface Row {
  type: 'nfs' | 'cifs'
  server: string
  remotePath: string
  wantServer: string
  wantPath: string
  wantProblems?: string[]
}

const ROWS: Row[] = [
  // --- CIFS: the reproduced server shapes ---------------------------------
  { type: 'cifs', server: '10.0.0.212', remotePath: 'pictures', wantServer: '10.0.0.212', wantPath: 'pictures' },
  // `//10.0.0.212` used to fail DNS ("Could not resolve host '//10.0.0.212'").
  { type: 'cifs', server: '//10.0.0.212', remotePath: 'pictures', wantServer: '10.0.0.212', wantPath: 'pictures' },
  // `10.0.0.212/` + empty share used to build `//10.0.0.212/` → Malformed UNC.
  { type: 'cifs', server: '10.0.0.212/', remotePath: '', wantServer: '10.0.0.212', wantPath: '', wantProblems: [SHARE_REQUIRED] },
  { type: 'cifs', server: '//10.0.0.212', remotePath: '', wantServer: '10.0.0.212', wantPath: '', wantProblems: [SHARE_REQUIRED] },
  // Backslash (Windows) paste, mixed separators.
  { type: 'cifs', server: '\\nas.example.com', remotePath: '/pictures', wantServer: 'nas.example.com', wantPath: 'pictures' },
  { type: 'cifs', server: '\\\\nas\\media', remotePath: '', wantServer: 'nas', wantPath: '', wantProblems: [SHARE_REQUIRED] },
  // A pasted URL: the server is the host; the share STAYS AS TYPED (empty
  // here, so the guiding sentence comes back — the normaliser never moves it).
  { type: 'cifs', server: 'smb://host/share', remotePath: '', wantServer: 'host', wantPath: '', wantProblems: [SHARE_REQUIRED] },
  { type: 'cifs', server: 'smb://host/share', remotePath: 'typed', wantServer: 'host', wantPath: 'typed' },
  { type: 'cifs', server: 'cifs://nas.example.com', remotePath: 'media', wantServer: 'nas.example.com', wantPath: 'media' },
  // A scheme of the OTHER protocol still comes off the server.
  { type: 'cifs', server: 'nfs://nas.example.com', remotePath: 'media', wantServer: 'nas.example.com', wantPath: 'media' },
  // Whitespace around both fields.
  { type: 'cifs', server: '  nas.example.com  ', remotePath: '  /media/  ', wantServer: 'nas.example.com', wantPath: 'media' },
  // A share keeps an inner prefix path (`share/sub`); backslashes are separators.
  { type: 'cifs', server: 'nas', remotePath: '/share/sub/', wantServer: 'nas', wantPath: 'share/sub' },
  { type: 'cifs', server: 'nas', remotePath: 'share\\sub', wantServer: 'nas', wantPath: 'share/sub' },
  // IPv6: the brackets stay intact, the share part still comes off.
  { type: 'cifs', server: '[2001:db8::1]', remotePath: 'share', wantServer: '[2001:db8::1]', wantPath: 'share' },
  { type: 'cifs', server: '//[2001:db8::1]/share/sub', remotePath: '', wantServer: '[2001:db8::1]', wantPath: '', wantProblems: [SHARE_REQUIRED] },
  // Empty / unusable server.
  { type: 'cifs', server: '', remotePath: 'share', wantServer: '', wantPath: 'share', wantProblems: [SERVER_REQUIRED] },
  { type: 'cifs', server: '///', remotePath: 'share', wantServer: '', wantPath: 'share', wantProblems: [SERVER_REQUIRED] },
  { type: 'cifs', server: '', remotePath: '', wantServer: '', wantPath: '', wantProblems: [SERVER_REQUIRED, SHARE_REQUIRED] },

  // --- NFS ------------------------------------------------------------------
  { type: 'nfs', server: '10.0.0.9', remotePath: '/srv/export1', wantServer: '10.0.0.9', wantPath: '/srv/export1' },
  // `host/` and a trailing lone `:` are stripped from the server.
  { type: 'nfs', server: '10.0.0.9/', remotePath: '/srv/export1', wantServer: '10.0.0.9', wantPath: '/srv/export1' },
  { type: 'nfs', server: '10.0.0.9:', remotePath: '/srv/export1', wantServer: '10.0.0.9', wantPath: '/srv/export1' },
  // `host:/export` in ONE field: the server is the host, the export fills a
  // BLANK path field only — a typed path always wins.
  { type: 'nfs', server: '10.0.0.9:/srv/export1', remotePath: '', wantServer: '10.0.0.9', wantPath: '/srv/export1' },
  { type: 'nfs', server: '10.0.0.9:/srv/export1', remotePath: '/other', wantServer: '10.0.0.9', wantPath: '/other' },
  { type: 'nfs', server: 'nfs://10.0.0.9:/srv/export1', remotePath: '', wantServer: '10.0.0.9', wantPath: '/srv/export1' },
  // The export path gets exactly one leading `/` (blank = the export root).
  { type: 'nfs', server: '10.0.0.9', remotePath: 'srv/export1', wantServer: '10.0.0.9', wantPath: '/srv/export1' },
  { type: 'nfs', server: '10.0.0.9', remotePath: '', wantServer: '10.0.0.9', wantPath: '/' },
  { type: 'nfs', server: '10.0.0.9', remotePath: '  //srv//export1  ', wantServer: '10.0.0.9', wantPath: '/srv//export1' },
  // IPv6: unbracketed stays whole (colons never precede a `/`); the bracketed
  // `host:/export` split keeps the brackets intact.
  { type: 'nfs', server: '2001:db8::1', remotePath: '/export', wantServer: '2001:db8::1', wantPath: '/export' },
  { type: 'nfs', server: '[2001:db8::1]:/export', remotePath: '', wantServer: '[2001:db8::1]', wantPath: '/export' },
  // An empty server is a problem on NFS too (there is no export root for `:`).
  { type: 'nfs', server: '', remotePath: '/x', wantServer: '', wantPath: '/x', wantProblems: [SERVER_REQUIRED] },
]

describe('normalizeMountTarget (Epic 18 server/share normaliser)', () => {
  for (const row of ROWS) {
    it(`${row.type} ${JSON.stringify({ server: row.server, remotePath: row.remotePath })}`, () => {
      const got = normalizeMountTarget(row.type, { server: row.server, remotePath: row.remotePath })
      assert.equal(got.server, row.wantServer, 'server')
      assert.equal(got.remotePath, row.wantPath, 'remotePath')
      assert.deepEqual(got.problems, row.wantProblems ?? [], 'problems')
    })
  }

  it('tolerates absent fields (undefined) like the create/test request schemas do', () => {
    const cifs = normalizeMountTarget('cifs', {})
    assert.deepEqual(cifs, { server: '', remotePath: '', problems: [SERVER_REQUIRED, SHARE_REQUIRED] })
    const nfs = normalizeMountTarget('nfs', { server: '10.0.0.9' })
    assert.deepEqual(nfs, { server: '10.0.0.9', remotePath: '/', problems: [] })
  })

  it('is idempotent — normalising the normal form changes nothing', () => {
    for (const type of ['cifs', 'nfs'] as const) {
      const once = normalizeMountTarget(type, { server: `//${type === 'cifs' ? 'host' : 'host:'}`, remotePath: type === 'cifs' ? '/share/sub/' : '//export/sub' })
      const twice = normalizeMountTarget(type, once)
      assert.deepEqual(twice, once, `${type} second pass`)
    }
  })
})
