import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePveMountPaths, readPveMountPathsStrict } from '../pve-storage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/mounts')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parsePveMountPaths (Epic 18 hands-off tagging)', () => {
  const map = parsePveMountPaths(loadFixture('storage.cfg'))

  it('maps the PVE nfs storage mount path to its storage id', () => {
    assert.equal(map.get('/mnt/pve/anastest-nfs'), 'anastest-nfs')
  })

  it('maps dir storage paths and the zfspool mountpoint', () => {
    assert.equal(map.get('/var/lib/vz'), 'local')
    assert.equal(map.get('/srv/pve-dir'), 'anastest-dir')
    assert.equal(map.get('/datapool'), 'datapool')
  })

  it('is total: garbage / empty yields an empty map', () => {
    assert.equal(parsePveMountPaths('').size, 0)
    assert.equal(parsePveMountPaths('#nfs: x\n\tpath /mnt/pve/x\n').size, 0)
  })
})

describe('parsePveMountPaths — a zfspool with no `mountpoint` claims /<pool dataset> (cr.60, from cr.54)', () => {
  const zfsroot = readFileSync(join(__dirname, '../../fixtures/pve/storage-zfsroot.cfg'), 'utf-8')

  it('local-zfs (`pool rpool/data`, no mountpoint) claims /rpool/data — the path PVE builds its CT rootfs paths under', () => {
    const map = parsePveMountPaths(zfsroot)
    assert.equal(map.get('/rpool/data'), 'local-zfs')
    assert.equal(map.get('/var/lib/vz'), 'local')
    assert.equal(map.size, 2)
  })

  it('an explicit `mountpoint` is the claim, not /<pool> as well (the captured datapool stanza)', () => {
    const map = parsePveMountPaths(loadFixture('storage.cfg'))
    assert.equal(map.get('/datapool'), 'datapool')
    const moved = parsePveMountPaths('zfspool: tank-vm\n\tpool tank/vm\n\tmountpoint /srv/vm\n')
    assert.deepEqual([...moved], [['/srv/vm', 'tank-vm']])
  })

  it('the stanza ends at the next header even without a blank line, and a trailing slash is dropped', () => {
    const map = parsePveMountPaths('zfspool: a\n\tpool tank/a/\nzfspool: b\n\tpool tank/b\n\tmountpoint /mnt/b\n')
    assert.deepEqual(map, new Map([['/tank/a', 'a'], ['/mnt/b', 'b']]))
  })
})

describe('readPveMountPathsStrict — the ONE fail-closed reader (cr.54, lifted by cr.60)', () => {
  it('ENOENT is a read answer (no storages); an unreadable file is null; a readable one parses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr60-cfg-'))
    try {
      assert.deepEqual(await readPveMountPathsStrict(join(dir, 'absent.cfg')), new Map())
      assert.equal(await readPveMountPathsStrict(dir), null) // EISDIR stands in for pmxcfs down
      assert.equal((await readPveMountPathsStrict(join(__dirname, '../../fixtures/pve/storage-zfsroot.cfg')))?.get('/rpool/data'), 'local-zfs')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
