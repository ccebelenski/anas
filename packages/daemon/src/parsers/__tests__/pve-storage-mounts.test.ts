import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePveMountPaths } from '../pve-storage.js'

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
