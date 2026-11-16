import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { configuredFstabPath, FstabUnreadableError, readFstab, readFstabAbsentAsEmpty } from '../fstab-file.js'

/**
 * The contract of the /etc/fstab file owner: one read of a file says its
 * text, that the file is absent (ENOENT, ENOTDIR), or that it is there and
 * could not be read (path + reason); a missing file reads as an empty one;
 * and the path is ANAS_FSTAB_PATH when set, else /etc/fstab.
 */

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anas-fstab-file-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readFstab', () => {
  it('returns the exact text of a file with two lines', async () => {
    const path = join(dir, 'two-line-fstab')
    const text = 'UUID=aaaa-1111 /data xfs defaults 0 2\nUUID=bbbb-2222 /backup ext4 noauto,user 0 2\n'
    await writeFile(path, text)
    assert.deepEqual(await readFstab(path), { state: 'read', text })
  })

  it('reads an empty file as the text ""', async () => {
    const path = join(dir, 'empty-fstab')
    await writeFile(path, '')
    assert.deepEqual(await readFstab(path), { state: 'read', text: '' })
  })

  it('says absent for a path that does not exist', async () => {
    assert.deepEqual(await readFstab(join(dir, 'no-such-fstab')), { state: 'absent' })
  })

  it('says absent for a path under a regular file (ENOTDIR)', async () => {
    const plain = join(dir, 'afile')
    await writeFile(plain, 'not a directory\n')
    assert.deepEqual(await readFstab(join(plain, 'fstab')), { state: 'absent' })
  })

  it('says unreadable with the path and EISDIR for a directory at the path', async () => {
    const path = join(dir, 'a-directory')
    await mkdir(path)
    assert.deepEqual(await readFstab(path), { state: 'unreadable', path, reason: 'EISDIR' })
  })
})

describe('readFstabAbsentAsEmpty', () => {
  it('returns the text of a file', async () => {
    const path = join(dir, 'present-fstab')
    const text = 'UUID=cccc-3333 /srv nfs defaults 0 0\n'
    await writeFile(path, text)
    assert.equal(await readFstabAbsentAsEmpty(path), text)
  })

  it('returns "" for a missing path', async () => {
    assert.equal(await readFstabAbsentAsEmpty(join(dir, 'no-such-fstab-2')), '')
  })

  it('rejects with FstabUnreadableError for a directory at the path', async () => {
    const path = join(dir, 'unreadable-dir')
    await mkdir(path)
    await assert.rejects(readFstabAbsentAsEmpty(path), (err: unknown) => {
      assert.ok(err instanceof FstabUnreadableError)
      assert.equal(err.name, 'FstabUnreadableError')
      assert.equal(err.path, path)
      assert.equal(err.reason, 'EISDIR')
      assert.equal(err.message, `${path} could not be read (EISDIR). Check the file, then try again.`)
      return true
    })
  })
})

describe('configuredFstabPath', () => {
  it('returns ANAS_FSTAB_PATH when set and /etc/fstab when not', async () => {
    const saved = process.env.ANAS_FSTAB_PATH
    try {
      process.env.ANAS_FSTAB_PATH = join(dir, 'configured-fstab')
      assert.equal(configuredFstabPath(), join(dir, 'configured-fstab'))
      delete process.env.ANAS_FSTAB_PATH
      assert.equal(configuredFstabPath(), '/etc/fstab')
    }
    finally {
      if (saved === undefined)
        delete process.env.ANAS_FSTAB_PATH
      else
        process.env.ANAS_FSTAB_PATH = saved
    }
  })
})
