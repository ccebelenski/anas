import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { atomicTmpPath, isPmxcfsPath, writeFileAtomic } from '../config-writer.js'

/**
 * cr.14 / review M4: the ONE atomic config writer. Real temp dirs, real
 * files — the durability points (fsync) are not observable here and are not
 * claimed by these tests; what IS claimed: exclusive unpredictable temp in
 * the same dir, the target's mode/owner surviving the rename, the caller's
 * mode on creation, and no orphan temp after success OR failure.
 */
describe('writeFileAtomic', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-watomic-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the content', async () => {
    const file = join(dir, 'smb.conf')
    await writeFileAtomic(file, 'NEW\n')
    assert.equal(await readFile(file, 'utf8'), 'NEW\n')
  })

  it('an existing target keeps its mode (0640 stays 0640)', async () => {
    const file = join(dir, 'kept.conf')
    await writeFile(file, 'OLD\n')
    await chmod(file, 0o640)
    await writeFileAtomic(file, 'NEW\n')
    const st = await stat(file)
    assert.equal(st.mode & 0o7777, 0o640)
    // The owner is the one the rename would have dropped — assert it too.
    assert.equal(st.uid, process.getuid?.())
  })

  it('a new file gets the caller mode, defaulting to 0644', async () => {
    const secret = join(dir, 'secret.cred')
    await writeFileAtomic(secret, 's3cr3t\n', { mode: 0o600 })
    assert.equal((await stat(secret)).mode & 0o7777, 0o600)

    const plain = join(dir, 'plain.conf')
    await writeFileAtomic(plain, 'x\n')
    assert.equal((await stat(plain)).mode & 0o7777, 0o644)
  })

  it('leaves no temp file behind after success', async () => {
    const file = join(dir, 'clean.conf')
    await writeFileAtomic(file, 'one\n')
    await writeFileAtomic(file, 'two\n')
    assert.deepEqual(await readdir(dir), ['clean.conf'])
  })

  it('leaves no temp file behind when the rename fails (target is a directory)', async () => {
    await mkdir(join(dir, 'taken.conf'))
    await assert.rejects(writeFileAtomic(join(dir, 'taken.conf'), 'x\n'))
    assert.deepEqual(await readdir(dir), ['taken.conf'])
  })

  it('leaves no temp file behind when the parent directory does not exist', async () => {
    await assert.rejects(writeFileAtomic(join(dir, 'nope', 'conf'), 'x\n'))
    // Nothing was created anywhere under dir either.
    assert.deepEqual(await readdir(dir), [])
  })

  it('the temp name is unpredictable — two writes use different names', () => {
    const target = join(dir, 'a.conf')
    const a = atomicTmpPath(target)
    const b = atomicTmpPath(target)
    assert.notEqual(a, b)
    // Same directory as the target (rename stays atomic), hidden, carries
    // the target's name and this process.
    assert.equal(dirname(a), dir)
    const name = basename(a)
    assert.ok(name.startsWith('.'), `temp must be hidden: ${name}`)
    assert.ok(name.includes('a.conf'), `temp must name its target: ${name}`)
    assert.ok(name.includes(String(process.pid)), `temp must carry the pid: ${name}`)
  })
})

describe('isPmxcfsPath', () => {
  it('says yes for the cluster filesystem and everything under it', () => {
    assert.equal(isPmxcfsPath('/etc/pve'), true)
    assert.equal(isPmxcfsPath('/etc/pve/anas/backup-repos.json'), true)
    assert.equal(isPmxcfsPath('/etc/pve/priv/anas/known_hosts'), true)
  })

  it('says no for ordinary paths, lookalikes and sibling mounts', () => {
    assert.equal(isPmxcfsPath('/etc/pverc'), false)
    assert.equal(isPmxcfsPath('/etc/pve-ng/conf'), false)
    assert.equal(isPmxcfsPath('/etc/anas/creds'), false)
    assert.equal(isPmxcfsPath('/mnt/pve/pve/x'), false)
    assert.equal(isPmxcfsPath('/data/etc/pve/x'), false)
  })
})
