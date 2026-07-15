import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePveStorageCfg, readPveStorages } from '../pve-storage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/pve')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parsePveStorageCfg', () => {
  it('maps a zfspool stanza to its pool root and ignores dir stanzas', () => {
    const map = parsePveStorageCfg(loadFixture('storage.cfg'))
    // datapool → one zfspool ref; local (dir) → ignored.
    assert.deepEqual([...map.keys()], ['datapool'])
    const refs = map.get('datapool')!
    assert.equal(refs.length, 1)
    assert.deepEqual(refs[0], {
      storage: 'datapool',
      type: 'zfspool',
      dataset: 'datapool',
      content: ['images', 'rootdir'],
    })
  })

  it('keys a dataset-path pool by its root but keeps the full dataset', () => {
    const map = parsePveStorageCfg('zfspool: sub\n\tpool tank/data\n\tcontent images\n')
    const refs = map.get('tank')!
    assert.equal(refs.length, 1)
    assert.equal(refs[0].dataset, 'tank/data')
    assert.deepEqual(refs[0].content, ['images'])
  })

  it('accumulates multiple zfspool storages under the same pool root', () => {
    const text = [
      'zfspool: a',
      '\tpool tank',
      '\tcontent images',
      '',
      'zfspool: b',
      '\tpool tank/vms',
      '\tcontent rootdir',
      '',
    ].join('\n')
    const refs = parsePveStorageCfg(text).get('tank')!
    assert.deepEqual(refs.map(r => r.storage), ['a', 'b'])
  })

  it('yields empty content when the content line is absent', () => {
    const refs = parsePveStorageCfg('zfspool: c\n\tpool tank\n').get('tank')!
    assert.deepEqual(refs[0].content, [])
  })

  it('skips a zfspool stanza with no pool line', () => {
    const map = parsePveStorageCfg('zfspool: broken\n\tcontent images\n')
    assert.equal(map.size, 0)
  })

  it('ignores commented-out stanzas and comment lines', () => {
    const text = [
      '#zfspool: old',
      '#\tpool ghost',
      '#\tcontent images',
      '',
      'zfspool: real',
      '\tpool tank',
      '\t# inline-ish comment line',
      '\tcontent images',
    ].join('\n')
    const map = parsePveStorageCfg(text)
    assert.deepEqual([...map.keys()], ['tank'])
    assert.equal(map.get('tank')!.length, 1)
  })

  it('parses a final stanza with no trailing blank line', () => {
    const map = parsePveStorageCfg('zfspool: last\n\tpool tank\n\tcontent images')
    assert.equal(map.get('tank')![0].storage, 'last')
  })

  it('returns an empty map for empty input', () => {
    assert.equal(parsePveStorageCfg('').size, 0)
  })
})

describe('readPveStorages (fail-open)', () => {
  it('reads and parses a real storage.cfg fixture', async () => {
    const map = await readPveStorages(join(fixturesDir, 'storage.cfg'))
    assert.deepEqual([...map.keys()], ['datapool'])
  })

  it('returns an empty map when the file is missing (non-PVE host)', async () => {
    const map = await readPveStorages(join(fixturesDir, 'does-not-exist.cfg'))
    assert.equal(map.size, 0)
  })
})
