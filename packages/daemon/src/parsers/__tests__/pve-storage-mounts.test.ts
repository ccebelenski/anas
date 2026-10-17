import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePveMountPaths, readPveMountPathsStrict, readPveTerritoryClaims } from '../pve-storage.js'

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

describe('the zfspool claim covers the dataset\'s LIVE targets too (cr.60r, review possible 3)', () => {
  const zfsroot = readFileSync(join(__dirname, '../../fixtures/pve/storage-zfsroot.cfg'), 'utf-8')
  /** The captured findmnt-full.json\'s zfs row shape, for local-zfs\'s dataset moved to /mnt/zp2. */
  const movedTable = JSON.stringify({ filesystems: [{ target: '/mnt/zp2', source: 'rpool/data', fstype: 'zfs', options: 'rw,relatime,xattr,noacl,casesensitive' }] })

  it('a dataset live elsewhere claims its live path AND keeps the config default; other datasets\' rows claim nothing', () => {
    const map = parsePveMountPaths(zfsroot, new Map([['rpool/data', ['/mnt/zp2', '/srv/bind']], ['rpool/ROOT/pve-1', ['/']], ['rpool/data/subvol-100-disk-0', ['/elsewhere']]]))
    assert.deepEqual(map, new Map([['/var/lib/vz', 'local'], ['/rpool/data', 'local-zfs'], ['/mnt/zp2', 'local-zfs'], ['/srv/bind', 'local-zfs']]))
  })

  it('an explicit `mountpoint` keeps its claim beside the live one', () => {
    const map = parsePveMountPaths(loadFixture('storage.cfg'), new Map([['datapool', ['/mnt/dp']]]))
    assert.equal(map.get('/datapool'), 'datapool')
    assert.equal(map.get('/mnt/dp'), 'datapool')
  })

  it('readPveTerritoryClaims: live claims from the table; an unreadable table is \'findmnt\', an unreadable file \'storage-cfg\', and a config with no zfspool never asks for the table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr60r-cfg-'))
    try {
      const zfsrootPath = join(__dirname, '../../fixtures/pve/storage-zfsroot.cfg')
      const live = await readPveTerritoryClaims(zfsrootPath, async () => movedTable)
      assert.ok(live instanceof Map)
      assert.equal(live.get('/mnt/zp2'), 'local-zfs')
      assert.equal(live.get('/rpool/data'), 'local-zfs')
      assert.equal(await readPveTerritoryClaims(zfsrootPath, async () => null), 'findmnt')
      assert.equal(await readPveTerritoryClaims(zfsrootPath, async () => '{"filesystems": 42}'), 'findmnt') // a wrong shape is unreadable too
      let asked = false
      const table = async (): Promise<string | null> => {
        asked = true
        return null
      }
      assert.equal(await readPveTerritoryClaims(dir, table), 'storage-cfg') // EISDIR stands in for pmxcfs down
      assert.deepEqual(await readPveTerritoryClaims(join(dir, 'absent.cfg'), table), new Map())
      // The fixture\'s own `dir: local` stanza alone: no zfspool, so the table is never read.
      await writeFile(join(dir, 'dir-only.cfg'), zfsroot.split('\n\n')[0])
      assert.deepEqual(await readPveTerritoryClaims(join(dir, 'dir-only.cfg'), table), new Map([['/var/lib/vz', 'local']]))
      assert.equal(asked, false, 'an unreadable, an absent and a zfspool-less file never ask for the table')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
