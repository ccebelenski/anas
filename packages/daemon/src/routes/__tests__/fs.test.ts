import type { FsBrowseResult } from '@anas/shared'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

/** An operator (Sys.Modify): the unbounded browse every picker dialog uses. */
const MODIFY = { 'x-anas-user': 'root@pam', 'x-anas-privileges': 'Sys.Audit,Sys.Modify' }
/** A reader (Sys.Audit only): bounded to the managed roots since cr.62. */
const AUDIT = { 'x-anas-user': 'audit@pve', 'x-anas-privileges': 'Sys.Audit' }

async function browse(
  server: ReturnType<typeof createServer>,
  path: string,
  headers: Record<string, string> = MODIFY,
  files = false,
): Promise<{ statusCode: number, data?: FsBrowseResult, error?: { code: string, message: string } }> {
  const res = await server.inject({
    method: 'GET',
    url: `/v1/fs/browse?path=${encodeURIComponent(path)}${files ? '&files=1' : ''}`,
    headers,
  })
  const body = res.json() as { data?: FsBrowseResult, error?: { code: string, message: string } }
  return { statusCode: res.statusCode, ...body }
}

/** The same browse, opting IN to the file listing (story backup2.5). */
async function browseWithFiles(
  server: ReturnType<typeof createServer>,
  path: string,
): Promise<{ statusCode: number, data?: FsBrowseResult }> {
  const res = await server.inject({
    method: 'GET',
    url: `/v1/fs/browse?path=${encodeURIComponent(path)}&files=1`,
    headers: MODIFY,
  })
  const body = res.json() as { data?: FsBrowseResult }
  return { statusCode: res.statusCode, ...body }
}

describe('fs browse route (Epic 16.9)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-fs-'))
    server = createServer({ mock: true, logger: false })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('lists child directories of a directory, sorted, dotdirs included', async () => {
    await mkdir(join(dir, 'zeta'))
    await mkdir(join(dir, 'alpha'))
    await mkdir(join(dir, '.hidden'))
    await writeFile(join(dir, 'afile.txt'), 'x') // a file — must NOT appear in dirs

    const res = await browse(server!, dir)
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.exists, true)
    assert.equal(res.data!.type, 'dir')
    assert.deepEqual(res.data!.dirs, ['.hidden', 'alpha', 'zeta'])
    assert.equal(res.data!.truncated, undefined)
  })

  it('reports a file as type=file with no dirs', async () => {
    const f = join(dir, 'a-file')
    await writeFile(f, 'hello')
    const res = await browse(server!, f)
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.exists, true)
    assert.equal(res.data!.type, 'file')
    assert.deepEqual(res.data!.dirs, [])
  })

  it('reports a missing path as exists=false type=missing', async () => {
    const res = await browse(server!, join(dir, 'does-not-exist'))
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.exists, false)
    assert.equal(res.data!.type, 'missing')
    assert.deepEqual(res.data!.dirs, [])
  })

  it('400s on a relative path', async () => {
    const res = await browse(server!, 'etc/relative')
    assert.equal(res.statusCode, 400)
    assert.equal(res.error!.code, 'VALIDATION_ERROR')
  })

  it('400s on a path containing traversal (..)', async () => {
    const res = await browse(server!, '/etc/../etc/passwd')
    assert.equal(res.statusCode, 400)
    assert.equal(res.error!.code, 'VALIDATION_ERROR')
  })

  it('normalizes the returned path (trailing slash / redundant segments)', async () => {
    await mkdir(join(dir, 'sub'))
    const res = await browse(server!, `${dir}/sub/`)
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.path, join(dir, 'sub'))
    assert.equal(res.data!.type, 'dir')
  })

  it('reports a symlink to a directory as type=dir and lists it', async () => {
    await mkdir(join(dir, 'real'))
    await mkdir(join(dir, 'real', 'child'))
    await symlink(join(dir, 'real'), join(dir, 'link'))
    // Browsing the symlink itself resolves to the dir (stat follows symlinks).
    const res = await browse(server!, join(dir, 'link'))
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.type, 'dir')
    assert.deepEqual(res.data!.dirs, ['child'])
  })

  it('includes a symlinked-directory child in the listing', async () => {
    await mkdir(join(dir, 'target'))
    await symlink(join(dir, 'target'), join(dir, 'linkchild'))
    const res = await browse(server!, dir)
    assert.equal(res.statusCode, 200)
    assert.ok(res.data!.dirs.includes('linkchild'), 'symlinked dir child should be listed')
    // A dangling symlink child must be skipped (fail-open), not error.
    await symlink(join(dir, 'nowhere'), join(dir, 'dangling'))
    const res2 = await browse(server!, dir)
    assert.equal(res2.statusCode, 200)
    assert.ok(!res2.data!.dirs.includes('dangling'), 'dangling symlink must be skipped')
  })

  it('sets truncated=true when the child count exceeds the cap', async () => {
    // 501 subdirectories — one over the 500 cap.
    const mk: Promise<void>[] = []
    for (let i = 0; i < 501; i++) {
      mk.push(mkdir(join(dir, `d${String(i).padStart(4, '0')}`)))
    }
    await Promise.all(mk)
    const res = await browse(server!, dir)
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.truncated, true)
    assert.equal(res.data!.dirs.length, 500)
  })

  it('fail-opens to an empty listing on an unreadable directory', async () => {
    const locked = join(dir, 'locked')
    await mkdir(locked)
    await mkdir(join(locked, 'hidden-child'))
    await chmod(locked, 0o000)
    try {
      const res = await browse(server!, locked)
      assert.equal(res.statusCode, 200)
      // Running as root defeats permission bits — either the child lists (root)
      // or it fail-opens to empty (non-root). Both are non-error and type=dir.
      assert.equal(res.data!.type, 'dir')
      assert.ok(Array.isArray(res.data!.dirs))
    }
    finally {
      await chmod(locked, 0o755)
    }
  })

  // --- `?files=1` — the picker's file-select mode (story backup2.5) ---------

  it('lists child FILES only when asked, sorted, and never mixed into dirs', async () => {
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'zeta.img'), 'x')
    await writeFile(join(dir, 'alpha.raw'), 'x')

    const withFiles = await browseWithFiles(server!, dir)
    assert.equal(withFiles.statusCode, 200)
    assert.deepEqual(withFiles.data!.dirs, ['sub'])
    assert.deepEqual(withFiles.data!.files, ['alpha.raw', 'zeta.img'])
  })

  it('ABSENT, not [], when files were not requested — "not asked" is not "none"', async () => {
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'a.img'), 'x')
    const plain = await browse(server!, dir)
    assert.equal(plain.statusCode, 200)
    assert.equal('files' in plain.data!, false)
    assert.deepEqual(plain.data!.dirs, ['sub'])
  })

  it('an empty directory asked for files answers with an empty list', async () => {
    const res = await browseWithFiles(server!, dir)
    assert.deepEqual(res.data!.dirs, [])
    assert.deepEqual(res.data!.files, [])
  })

  it('a symlink to a FILE is listed as a file; a symlink to a dir stays a dir', async () => {
    await writeFile(join(dir, 'real.img'), 'x')
    await mkdir(join(dir, 'realdir'))
    await symlink(join(dir, 'real.img'), join(dir, 'linkfile'))
    await symlink(join(dir, 'realdir'), join(dir, 'linkdir'))
    const res = await browseWithFiles(server!, dir)
    assert.deepEqual(res.data!.dirs, ['linkdir', 'realdir'])
    assert.deepEqual(res.data!.files, ['linkfile', 'real.img'])
  })

  it('caps the file listing too, and says so', async () => {
    const mk: Promise<void>[] = []
    for (let i = 0; i < 501; i++) {
      mk.push(writeFile(join(dir, `f${String(i).padStart(4, '0')}.bin`), 'x'))
    }
    await Promise.all(mk)
    const res = await browseWithFiles(server!, dir)
    assert.equal(res.data!.truncated, true)
    assert.equal(res.data!.files!.length, 500)
  })
})

// cr.62 (review L11): the daemon lists as root, so a reader (Sys.Audit, no
// Sys.Modify) is bounded to the managed roots — SMB share paths, NFS export
// paths, ZFS dataset mountpoints — and `/` is never one. Sys.Modify stays
// unbounded (the pickers are all in mutation dialogs; the H4 ruling).
describe('fs browse is bounded for a reader (cr.62, review L11)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let share: string
  let outside: string

  /** An smb.conf that shares `sharePath` (and, optionally, `/`); returns its path. */
  async function shareConf(sharePath: string, alsoRoot = false): Promise<string> {
    const conf = join(dir, 'smb.conf')
    await writeFile(conf, [
      '[global]',
      '   workgroup = WORKGROUP',
      '[media]',
      `   path = ${sharePath}`,
      ...(alsoRoot ? ['[everything]', '   path = /'] : []),
      '',
    ].join('\n'))
    return conf
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-fs-bound-'))
    share = join(dir, 'share')
    outside = join(dir, 'secret')
    await mkdir(join(share, 'photos'), { recursive: true })
    await writeFile(join(share, 'readme.txt'), 'x')
    await mkdir(join(outside, 'keys'), { recursive: true })
    await writeFile(join(outside, 'id_ed25519'), 'PRIVATE')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('a reader lists directories AND files inside a share path', async () => {
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share) })
    const res = await browse(server!, share, AUDIT, true)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.data!.dirs, ['photos'])
    assert.deepEqual(res.data!.files, ['readme.txt'])
    const sub = await browse(server!, join(share, 'photos'), AUDIT)
    assert.equal(sub.statusCode, 200)
  })

  it('a reader is refused outside every root — directories and files — with a 403 naming Sys.Modify', async () => {
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share) })
    for (const files of [false, true]) {
      const res = await browse(server!, outside, AUDIT, files)
      assert.equal(res.statusCode, 403)
      assert.equal(res.error!.code, 'FORBIDDEN')
      assert.match(res.error!.message, /^Permission check failed \(\/, Sys\.Modify\): audit@pve does not have it\./)
      assert.match(res.error!.message, /limited to the node's shares, exports and dataset mountpoints/)
      assert.equal(res.data, undefined, 'no listing rides the refusal')
    }
    // The review's own examples: the node's private trees.
    for (const p of ['/root', '/etc/pve/priv', '/etc/anas/creds', '/'])
      assert.equal((await browse(server!, p, AUDIT, true)).statusCode, 403, p)
  })

  it('a symlink inside a share does not carry a reader outside it', async () => {
    await symlink(outside, join(share, 'escape'))
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share) })
    const res = await browse(server!, join(share, 'escape'), AUDIT, true)
    assert.equal(res.statusCode, 403)
    // A path that does not exist yet is judged by its nearest real ancestor.
    const below = await browse(server!, join(share, 'escape', 'not-there'), AUDIT)
    assert.equal(below.statusCode, 403)
  })

  it('a missing path inside a share is an ordinary exists=false', async () => {
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share) })
    const res = await browse(server!, join(share, 'new-folder'), AUDIT)
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.exists, false)
  })

  it('`/` is never a root: a share of / does not open the host to a reader', async () => {
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share, true) })
    assert.equal((await browse(server!, outside, AUDIT)).statusCode, 403)
    assert.equal((await browse(server!, share, AUDIT)).statusCode, 200)
  })

  it('a request with no readable privileges is bounded too (fail closed)', async () => {
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share) })
    assert.equal((await browse(server!, outside, {})).statusCode, 403)
  })

  it('Sys.Modify is unbounded, files included (every picker is in a mutation dialog)', async () => {
    server = createServer({ mock: true, logger: false, smbConfPath: await shareConf(share) })
    const res = await browse(server!, outside, MODIFY, true)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.data!.dirs, ['keys'])
    assert.deepEqual(res.data!.files, ['id_ed25519'])
  })
})
