import type { SystemPoolFacts } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePveStorageCfg } from '../../parsers/pve-storage.js'
import { buildSystemPoolFacts, ownershipFromFootprintData, parseBootfsGet, parseRootMount } from '../pve-footprint.js'

/**
 * Story pvepool.1 — the system-pool half of the footprint service. The boot
 * facts come from two command outputs, so the parsers are proven against
 * LITERAL output, and the pure predicate assembly is checked over the story's
 * fixture set (the predicate itself has its table in @anas/shared).
 */

describe('parseBootfsGet — `zpool get -H -o name,value bootfs`', () => {
  it('reads one row per imported pool, omitting bootfs when the value is `-`', () => {
    const rows = parseBootfsGet(
      'rpool\trpool/ROOT/pve-1\n'
      + 'tank\t-\n'
      + 'ahr0\t-\n',
    )
    assert.deepEqual(rows, [
      { pool: 'rpool', bootfs: 'rpool/ROOT/pve-1' },
      { pool: 'tank' },
      { pool: 'ahr0' },
    ])
  })

  it('a pool whose bootfs IS the pool root is kept verbatim', () => {
    assert.deepEqual(parseBootfsGet('bpool\tbpool'), [{ pool: 'bpool', bootfs: 'bpool' }])
  })

  it('malformed rows and blank lines are skipped, never thrown on', () => {
    assert.deepEqual(parseBootfsGet('\n\ngarbage with no tab\nrpool\tkeep-value'), [
      { pool: 'rpool', bootfs: 'keep-value' },
    ])
    assert.deepEqual(parseBootfsGet(''), [])
  })
})

describe('parseRootMount — `findmnt -n -o SOURCE,FSTYPE /`', () => {
  it('reads the zfs dataset mounted at /', () => {
    assert.deepEqual(parseRootMount('rpool/ROOT/pve-1 zfs\n'), {
      dataset: 'rpool/ROOT/pve-1',
      fstype: 'zfs',
    })
  })

  it('any other filesystem at / is no boot dataset at all', () => {
    assert.equal(parseRootMount('/dev/sda1 ext4\n'), null)
    assert.equal(parseRootMount('//server/share cifs\n'), null)
  })

  it('an unreadable answer is no boot dataset', () => {
    assert.equal(parseRootMount(''), null)
  })
})

describe('buildSystemPoolFacts — the boot rows + the root mount, one entry per pool', () => {
  it('tags rootDataset on the pool that actually hosts /', () => {
    const facts = buildSystemPoolFacts(
      parseBootfsGet('rpool\trpool/ROOT/pve-1\ntank\t-\n'),
      parseRootMount('rpool/ROOT/pve-1 zfs\n'),
    )
    assert.equal(facts.length, 2)
    assert.equal(facts[0].rootDataset, 'rpool/ROOT/pve-1')
    assert.equal(facts[1].rootDataset, undefined)
    assert.equal(facts[1].bootfs, undefined)
  })

  it('a non-zfs / contributes no rootDataset to any pool', () => {
    const facts = buildSystemPoolFacts(parseBootfsGet('rpool\t-\n'), null)
    assert.deepEqual(facts, [{ pool: 'rpool' }])
  })
})

describe('ownershipFromFootprintData — the service-level assembly over the fixture set', () => {
  // The story's shape: nested storage root, bare storage, a dir storage, and
  // the system pool.
  const CFG = 'zfspool: local-zfs\n\tpool rpool/data\n\tcontent images,rootdir\n\n'
  const MPS = [
    { mountpoint: '/rpool/data', dataset: 'rpool/data', pool: 'rpool' },
    { mountpoint: '/rpool/media', dataset: 'rpool/media', pool: 'rpool' },
  ]
  const storages = parsePveStorageCfg(CFG, MPS)
  const system: SystemPoolFacts[] = [{ pool: 'rpool', bootfs: 'rpool/ROOT/pve-1' }]

  it('the boot dataset and its ancestors are system-owned', () => {
    for (const dataset of ['rpool', 'rpool/ROOT', 'rpool/ROOT/pve-1'])
      assert.equal(ownershipFromFootprintData(storages, system, dataset)?.kind, 'system', dataset)
  })

  it('the storage root and its guests are PVE-owned; the sibling is NOT', () => {
    assert.equal(ownershipFromFootprintData(storages, system, 'rpool/data')?.kind, 'storage-root')
    assert.equal(ownershipFromFootprintData(storages, system, 'rpool/data/vm-100-disk-0')?.kind, 'guest-volume')
    // rpool/media is neither under ROOT nor a storage path — the manageable one.
    assert.equal(ownershipFromFootprintData(storages, system, 'rpool/media'), null)
  })

  it('no system facts (failed boot probe) fails open to the plain footprint rules', () => {
    // Without boot facts the system rule is undetectable — rpool/ROOT is
    // outside any storage's footprint, so it answers manageable.
    assert.equal(ownershipFromFootprintData(storages, [], 'rpool/ROOT'), null)
    assert.equal(ownershipFromFootprintData(storages, [], 'rpool/data')?.kind, 'storage-root')
  })
})
