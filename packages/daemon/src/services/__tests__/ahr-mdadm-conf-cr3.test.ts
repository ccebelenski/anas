import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { installProgramHook, pinArrays, unpinArrays } from '../ahr-mdadm-conf.js'

/**
 * cr3 review2 5 (probe b-mdhook.mts B6d): a SYMLINKED mdadm.conf was replaced
 * by a regular file — the atomic write renamed its temp file over the link —
 * and the operator's real file silently stopped being read. Every mdadm.conf
 * edit (create's pins and hook, destroy's unpin, the boot re-wire) now writes
 * the link's TARGET in its own directory; a dangling link is never written.
 */
describe('mdadm.conf edits through a symbolic link (cr3 review2 5)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mdadm-link-'))
    await mkdir(join(dir, 'real'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('pin, hook and unpin edit the TARGET; the link stays a link', async () => {
    const target = join(dir, 'real', 'mdadm.conf')
    const link = join(dir, 'mdadm.conf')
    await writeFile(target, '# operator file\n')
    await symlink('real/mdadm.conf', link)

    await pinArrays([{ name: 'tank-r1', uuid: 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa' }], link)
    await installProgramHook(undefined, link)
    assert.ok((await lstat(link)).isSymbolicLink(), 'the link is still a link')
    assert.equal(await readlink(link), 'real/mdadm.conf')
    assert.equal(await readFile(target, 'utf8'), '# operator file\nARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nPROGRAM /usr/local/bin/anas-md-event\n')

    await unpinArrays(['aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'], link)
    assert.ok((await lstat(link)).isSymbolicLink())
    assert.equal(await readFile(target, 'utf8'), '# operator file\n')
  })

  it('a DANGLING link is never written — the edit refuses, nothing appears', async () => {
    const link = join(dir, 'mdadm.conf')
    await symlink('real/missing.conf', link)
    await assert.rejects(installProgramHook(undefined, link), /is a symbolic link whose target cannot be resolved .* mdadm\.conf was not written/)
    assert.ok((await lstat(link)).isSymbolicLink())
    await assert.rejects(lstat(join(dir, 'real', 'missing.conf')), /ENOENT/)
  })
})
