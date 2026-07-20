import type { FsBrowseResult } from '@anas/shared'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

async function browse(
  server: ReturnType<typeof createServer>,
  path: string,
): Promise<{ statusCode: number, data?: FsBrowseResult, error?: { code: string, message: string } }> {
  const res = await server.inject({
    method: 'GET',
    url: `/v1/fs/browse?path=${encodeURIComponent(path)}`,
  })
  const body = res.json() as { data?: FsBrowseResult, error?: { code: string, message: string } }
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
})
