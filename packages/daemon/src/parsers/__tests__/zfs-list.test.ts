import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDatasetGet, parseSnapshotList, parseSnapshotNames, parseVolblocksizeDefault, parseZfsList } from '../zfs-list.js'

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

// ============================================================================
// ZFS VOLUMES — story iscsi.3, against the REAL captures.
//
// `zfs-list-volumes.json` and `zfs-get-volume.json` are verbatim stunt-node
// output (see fixtures/zfs/NOTES.md), so these assertions are statements about
// what ZFS actually prints, not about what we assumed it prints.
// ============================================================================

const REAL_LIST = 'zfs-list-volumes.json'
const REAL_GET = 'zfs-get-volume.json'
const GiB = 1024 * 1024 * 1024

describe('volumes — real capture', () => {
  it('parses the real zvol row: volsize, volblocksize and no mountpoint', () => {
    const vol = parseZfsList(loadFixture(REAL_LIST)).find(d => d.name === 'gtiscsi/vol1')!
    assert.equal(vol.type, 'volume')
    assert.equal(vol.volsize, 2 * GiB)
    assert.equal(vol.volblocksize, 16 * 1024)
    // A volume has no mountpoint and no quota: ZFS prints a literal "-" for
    // both, which must read as absent rather than parse as a size.
    assert.equal(vol.mountpoint, null)
    assert.equal(vol.quota, 0)
  })

  it('reports the real (thick) volume as NOT sparse, from its refreservation', () => {
    const vol = parseZfsList(loadFixture(REAL_LIST)).find(d => d.name === 'gtiscsi/vol1')!
    // The capture's refreservation is 2.03G with source LOCAL — the volume
    // holds its whole size, so `used` (2.03G) is the reservation and NOT what
    // has been written (`referenced` is 60.5K). That gap is exactly why the UI
    // shows volsize and used side by side.
    assert.equal(vol.sparse, false)
    assert.ok(vol.used > vol.referenced * 100, 'a thick volume\'s used is its refreservation')
  })

  it('reports a volume with no refreservation as sparse', () => {
    // No sparse volume existed on the stunt node and the capture rules were
    // read-only, so the thin case is the REAL capture with its refreservation
    // set to `none` — the one field `zfs create -s` actually changes.
    const raw = loadFixture(REAL_LIST)
    raw.datasets['gtiscsi/vol1'].properties.refreservation.value = 'none'
    const vol = parseZfsList(raw).find(d => d.name === 'gtiscsi/vol1')!
    assert.equal(vol.sparse, true)
  })

  it('leaves the three volume fields ABSENT on a filesystem', () => {
    const fs = parseZfsList(loadFixture(REAL_LIST)).find(d => d.name === 'gtiscsi/images')!
    assert.equal(fs.type, 'filesystem')
    // Absent, not zero: the real capture prints "-" for all three on a
    // filesystem row, and "no such property" is not "a property that is 0".
    assert.equal(fs.volsize, undefined)
    assert.equal(fs.volblocksize, undefined)
    assert.equal(fs.sparse, undefined)
  })

  it('parses the volume detail (`zfs get all`) with the same three fields', () => {
    const parsed = parseDatasetGet(loadFixture(REAL_GET), 'gtiscsi/vol1')!
    assert.equal(parsed.base.type, 'volume')
    assert.equal(parsed.base.volsize, 2 * GiB)
    assert.equal(parsed.base.volblocksize, 16 * 1024)
    assert.equal(parsed.base.sparse, false)
  })

  it('confirms ZFS carries NO mountpoint/recordsize/quota/atime on a volume', () => {
    // This is the evidence behind the create schema refusing those properties
    // for type 'volume' and behind the UI dropping the filesystem-property
    // editor on a volume row — they are not defaulted, they are ABSENT.
    const parsed = parseDatasetGet(loadFixture(REAL_GET), 'gtiscsi/vol1')!
    const all = parsed.properties.all!
    for (const absent of ['mountpoint', 'recordsize', 'quota', 'refquota', 'atime'])
      assert.equal(all[absent], undefined, `${absent} must be absent on a volume`)
    // The ones a volume DOES carry.
    assert.equal(all.volsize, '2G')
    assert.equal(all.volblocksize, '16K')
    assert.equal(all.refreservation, '2.03G')
  })

  it('degrades when the list predates the volume columns', () => {
    // An older daemon/list without volsize/volblocksize/refreservation columns:
    // every volume field is simply absent and the rest still parses.
    const raw = loadFixture(REAL_LIST)
    for (const key of ['volsize', 'volblocksize', 'refreservation'])
      delete raw.datasets['gtiscsi/vol1'].properties[key]
    const vol = parseZfsList(raw).find(d => d.name === 'gtiscsi/vol1')!
    assert.equal(vol.type, 'volume')
    assert.equal(vol.volsize, undefined)
    assert.equal(vol.volblocksize, undefined)
    assert.equal(vol.sparse, undefined)
  })
})

describe('parseVolblocksizeDefault', () => {
  it('reads ZFS\'s own default off a DEFAULT-sourced volume, from the list we already have', () => {
    // The real capture reports volblocksize 16K with source DEFAULT — the only
    // honest place to learn the running ZFS default from (there is no module
    // parameter for it).
    assert.equal(parseVolblocksizeDefault(loadFixture(REAL_LIST)), 16 * 1024)
  })

  it('returns null when the only volume has a LOCAL volblocksize', () => {
    // A volume created with an explicit -b says nothing about the default, so
    // the dialog must say "ZFS default" with no number rather than quote it.
    const raw = loadFixture(REAL_LIST)
    raw.datasets['gtiscsi/vol1'].properties.volblocksize.source.type = 'LOCAL'
    assert.equal(parseVolblocksizeDefault(raw), null)
  })

  it('returns null when the pool has no volume at all', () => {
    assert.equal(parseVolblocksizeDefault(loadFixture('zfs-get-media.json')), null)
  })

  it('returns null on empty stdout rather than throwing', () => {
    assert.equal(parseVolblocksizeDefault(''), null)
  })
})

// Empty-stdout family behavior (see zpool-list.test.ts): zero pools/datasets
// ⇒ the -j commands print nothing. Must parse to empty, not crash.
describe('empty stdout (no pools on the node)', () => {
  it('parseZfsList returns []', () => {
    assert.deepEqual(parseZfsList(''), [])
  })
})
