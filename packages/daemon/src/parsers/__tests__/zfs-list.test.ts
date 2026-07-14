import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDatasetGet, parseSnapshotList, parseSnapshotNames, parseZfsList } from '../zfs-list.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs')

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}

describe('parseZfsList', () => {
  it('returns only filesystems and volumes, skipping snapshots', () => {
    const result = parseZfsList(loadFixture('zfs-list.json'))
    const names = result.map(d => d.name)
    assert.deepEqual(names.sort(), ['testpool', 'testpool/media', 'testpool/vm-100-disk-0'])
    assert.ok(!names.includes('testpool/media@snap1'), 'snapshot must be filtered out')
  })

  it('parses a filesystem with sizes in bytes and quota', () => {
    const result = parseZfsList(loadFixture('zfs-list.json'))
    const media = result.find(d => d.name === 'testpool/media')!
    assert.equal(media.type, 'filesystem')
    assert.equal(media.pool, 'testpool')
    assert.equal(media.used, 120 * 1024 * 1024)
    assert.equal(media.available, 352 * 1024 * 1024)
    assert.equal(media.referenced, 120 * 1024 * 1024)
    assert.equal(media.quota, 10 * 1024 * 1024 * 1024)
    assert.equal(media.mountpoint, '/testpool/media')
    assert.equal(media.compression, 'zstd')
    assert.equal(media.compressratio, 1.42)
  })

  it('parses a volume with a null mountpoint and 0 quota for "none"', () => {
    const result = parseZfsList(loadFixture('zfs-list.json'))
    const vol = result.find(d => d.name === 'testpool/vm-100-disk-0')!
    assert.equal(vol.type, 'volume')
    assert.equal(vol.mountpoint, null)
    assert.equal(vol.quota, 0)
    assert.equal(vol.used, 8 * 1024 * 1024 * 1024)
  })

  it('derives pool from the name when the field is absent', () => {
    const result = parseZfsList({
      datasets: {
        'tank/a': { name: 'tank/a', type: 'FILESYSTEM', properties: {} },
      },
    } as any)
    assert.equal(result[0].pool, 'tank')
  })
})

describe('parseSnapshotNames', () => {
  it('lists only snapshot entries', () => {
    const names = parseSnapshotNames(loadFixture('zfs-list.json'))
    assert.deepEqual(names, ['testpool/media@snap1'])
  })
})

describe('parseSnapshotList', () => {
  it('maps name/dataset/label/pool, ISO created, and byte sizes', () => {
    const snaps = parseSnapshotList(loadFixture('zfs-snapshots-media.json'))
    assert.equal(snaps.length, 2)
    const snap1 = snaps.find(s => s.snapshotName === 'snap1')!
    assert.equal(snap1.name, 'testpool/media@snap1')
    assert.equal(snap1.dataset, 'testpool/media')
    assert.equal(snap1.pool, 'testpool')
    assert.equal(snap1.created, '2026-07-13T10:00:00.000Z')
    assert.equal(snap1.used, 0)
    assert.equal(snap1.referenced, 128 * 1024 * 1024)
  })

  it('sorts newest-first by creation time', () => {
    const snaps = parseSnapshotList(loadFixture('zfs-snapshots-media.json'))
    assert.deepEqual(snaps.map(s => s.snapshotName), ['snap2', 'snap1'])
  })

  it('breaks creation-time ties by createtxg (descending)', () => {
    const same = 'Tue Jul 14 10:00:00 UTC 2026'
    const snaps = parseSnapshotList({
      datasets: {
        'tank/a@old': { name: 'tank/a@old', type: 'SNAPSHOT', pool: 'tank', dataset: 'tank/a', snapshot_name: 'old', createtxg: '10', properties: { creation: { value: same }, used: { value: '0B' }, referenced: { value: '1M' } } },
        'tank/a@new': { name: 'tank/a@new', type: 'SNAPSHOT', pool: 'tank', dataset: 'tank/a', snapshot_name: 'new', createtxg: '99', properties: { creation: { value: same }, used: { value: '0B' }, referenced: { value: '1M' } } },
      },
    } as any)
    assert.deepEqual(snaps.map(s => s.snapshotName), ['new', 'old'])
  })

  it('derives dataset and label from the name when fields are absent', () => {
    const snaps = parseSnapshotList({
      datasets: {
        'tank/media@x': { name: 'tank/media@x', type: 'SNAPSHOT', properties: { creation: { value: 'Tue Jul 14 10:00:00 UTC 2026' }, used: { value: '0B' }, referenced: { value: '0B' } } },
      },
    } as any)
    assert.equal(snaps[0].dataset, 'tank/media')
    assert.equal(snaps[0].snapshotName, 'x')
    assert.equal(snaps[0].pool, 'tank')
  })

  it('ignores non-snapshot rows', () => {
    const snaps = parseSnapshotList(loadFixture('zfs-list.json'))
    assert.deepEqual(snaps.map(s => s.name), ['testpool/media@snap1'])
  })
})

describe('parseDatasetGet', () => {
  it('parses base summary and typed properties', () => {
    const parsed = parseDatasetGet(loadFixture('zfs-get-media.json'), 'testpool/media')
    assert.ok(parsed)
    assert.equal(parsed!.base.name, 'testpool/media')
    assert.equal(parsed!.base.type, 'filesystem')
    assert.equal(parsed!.base.mountpoint, '/testpool/media')
    assert.equal(parsed!.base.quota, 10 * 1024 * 1024 * 1024)

    const p = parsed!.properties
    assert.equal(p.compression, 'zstd')
    assert.equal(p.recordsize, 128 * 1024)
    assert.equal(p.quota, 10 * 1024 * 1024 * 1024)
    assert.equal(p.reservation, 0)
    assert.equal(p.refquota, 0)
    assert.equal(p.atime, true)
    assert.equal(p.readonly, false)
    assert.equal(p.dedup, 'off')
    assert.equal(p.sync, 'standard')
    assert.ok(p.all && p.all.mountpoint === '/testpool/media')
  })

  it('returns null for an unknown dataset', () => {
    const parsed = parseDatasetGet(loadFixture('zfs-get-media.json'), 'testpool/nope')
    assert.equal(parsed, null)
  })
})
