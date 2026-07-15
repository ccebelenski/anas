import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePveStorageCfg, parseZfsMountpoints, readPveStorages } from '../pve-storage.js'

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

describe('parsePveStorageCfg — dir on ZFS (secondary signal)', () => {
  const mountpoints = [
    { mountpoint: '/datapool', dataset: 'datapool', pool: 'datapool' },
  ]

  it('ignores dir stanzas entirely when no mountpoints are supplied', () => {
    // Fixture has a dir on /datapool/backups; without the map it must not appear.
    const map = parsePveStorageCfg(loadFixture('storage.cfg'))
    assert.deepEqual([...map.keys()], ['datapool'])
    assert.deepEqual(map.get('datapool')!.map(r => r.type), ['zfspool'])
  })

  it('attaches a dir on a ZFS mountpoint to the pool, keyed by pool root', () => {
    const map = parsePveStorageCfg(loadFixture('storage.cfg'), mountpoints)
    // /var/lib/vz is on no ZFS dataset → ignored; /datapool/backups → datapool.
    assert.deepEqual([...map.keys()], ['datapool'])
    const refs = map.get('datapool')!
    assert.equal(refs.length, 2)
    const dir = refs.find(r => r.type === 'dir')!
    assert.deepEqual(dir, {
      storage: 'backups',
      type: 'dir',
      dataset: 'datapool',
      content: ['backup', 'iso'],
    })
  })

  it('ignores a dir path that is on no ZFS dataset (e.g. /var/lib/vz)', () => {
    const text = 'dir: local\n\tpath /var/lib/vz\n\tcontent backup,iso\n'
    const map = parsePveStorageCfg(text, mountpoints)
    assert.equal(map.size, 0)
  })

  it('picks the longest matching mountpoint (most specific dataset)', () => {
    const nested = [
      { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
      { mountpoint: '/tank/backups', dataset: 'tank/backups', pool: 'tank' },
    ]
    const text = 'dir: bk\n\tpath /tank/backups/dump\n\tcontent backup\n'
    const dir = parsePveStorageCfg(text, nested).get('tank')![0]
    assert.equal(dir.dataset, 'tank/backups')
  })

  it('matches a dir path equal to the dataset mountpoint itself', () => {
    const text = 'dir: bk\n\tpath /datapool\n\tcontent iso\n'
    const dir = parsePveStorageCfg(text, mountpoints).get('datapool')![0]
    assert.equal(dir.dataset, 'datapool')
  })

  it('does not let /tank swallow a sibling path like /tank-other', () => {
    const mps = [{ mountpoint: '/tank', dataset: 'tank', pool: 'tank' }]
    const text = 'dir: x\n\tpath /tank-other/dump\n\tcontent backup\n'
    assert.equal(parsePveStorageCfg(text, mps).size, 0)
  })

  it('skips a dir stanza with no path line', () => {
    const text = 'dir: x\n\tcontent backup\n'
    assert.equal(parsePveStorageCfg(text, mountpoints).size, 0)
  })
})

describe('parseZfsMountpoints', () => {
  it('parses tab-separated name,mountpoint rows and derives the pool root', () => {
    const out = parseZfsMountpoints('datapool\t/datapool\ndatapool/backups\t/datapool/backups\n')
    assert.deepEqual(out, [
      { mountpoint: '/datapool', dataset: 'datapool', pool: 'datapool' },
      { mountpoint: '/datapool/backups', dataset: 'datapool/backups', pool: 'datapool' },
    ])
  })

  it('drops volumes and non-mounted datasets (-, none, legacy)', () => {
    const out = parseZfsMountpoints([
      'tank\t/tank',
      'tank/vm-100-disk-0\t-',
      'tank/legacy\tlegacy',
      'tank/nomount\tnone',
      '',
    ].join('\n'))
    assert.deepEqual(out.map(m => m.dataset), ['tank'])
  })

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseZfsMountpoints(''), [])
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
