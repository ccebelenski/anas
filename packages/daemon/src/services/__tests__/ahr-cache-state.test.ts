import type { CachePartInfo } from '../ahr-cache-state.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dmCacheHealth, parseDmsetupStatus } from '../../parsers/dmsetup.js'
import { parseLvsReport, parsePvsReport } from '../../parsers/lvm-report.js'
import {
  buildAhrCacheState,
  cacheLvName,
  cachePartitionLabel,
  isMdPvName,
  matchCachePartitionLabel,
  rotatingCacheAdvisory,
} from '../ahr-cache-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

const POOL = 'gtcache'
const CACHE_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'
const BAND_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7'

/** The live shape: sdb1 = the band member slice, sdd1 = the cache slice. */
function partsByKernel(opts?: { cacheSlice?: boolean }): Map<string, CachePartInfo> {
  const parts = new Map<string, CachePartInfo>()
  parts.set('sdb1', { partlabel: 'gtcache-d1-b1', size: 1072676352, disk: { name: 'sdb' } })
  if (opts?.cacheSlice !== false)
    parts.set('sdd1', { partlabel: 'gtcache-cache1', size: 535805440, disk: { name: 'sdd' } })
  return parts
}

const BY_ID = new Map<string, string>([['sdb', BAND_DISK], ['sdd', CACHE_DISK]])

describe('dmsetup status — the cache health signal (ahrcache.1, GT-19/GT-23)', () => {
  it('parses the single-device form, which does NOT repeat the name', () => {
    const line = parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt'))
    assert.ok(line)
    assert.equal(line.name, null)
    assert.equal(line.target, 'cache')
    assert.ok(line.args.startsWith('8 24/2048 128 8/8000'))
  })

  it('parses the listing form, which prefixes `<name>: `', () => {
    const line = parseDmsetupStatus('gtcache-gtcache--vol: 0 2080768 cache Error\n')
    assert.ok(line)
    assert.equal(line.name, 'gtcache-gtcache--vol')
    assert.equal(line.target, 'cache')
    assert.equal(line.args, 'Error')
  })

  it('a real status line is healthy — it opens with the metadata block size', () => {
    assert.equal(dmCacheHealth(parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt'))), 'healthy')
  })

  it('`Fail` is failed — the word this kernel used when the device was pulled', () => {
    assert.equal(dmCacheHealth(parseDmsetupStatus(loadFixture('dmsetup-status-cache-failed.txt'))), 'failed')
  })

  it('`Error` is failed too — GT-19 saw that word for the same condition', () => {
    assert.equal(dmCacheHealth(parseDmsetupStatus('0 2080768 cache Error')), 'failed')
  })

  it('any unrecognised cache status is failed, never healthy (the safe direction)', () => {
    assert.equal(dmCacheHealth(parseDmsetupStatus('0 2080768 cache something-new')), 'failed')
  })

  it('a `linear` target has no cache health to report', () => {
    assert.equal(dmCacheHealth(parseDmsetupStatus(loadFixture('dmsetup-status-uncached.txt'))), null)
  })

  it('unreadable output parses to null and reports no health', () => {
    assert.equal(parseDmsetupStatus(''), null)
    assert.equal(parseDmsetupStatus('Device does not exist.'), null)
    assert.equal(dmCacheHealth(null), null)
  })
})

describe('cache naming — the one home of "a cache slice of pool X"', () => {
  it('the cache LV sits beside the pool volume', () => {
    assert.equal(cacheLvName('tank'), 'tank-cache')
  })

  it('labels are `<pool>-cache<n>`, 1-based', () => {
    assert.equal(cachePartitionLabel('tank', 1), 'tank-cache1')
    assert.equal(cachePartitionLabel('tank', 2), 'tank-cache2')
  })

  it('the matcher is the exact inverse', () => {
    assert.equal(matchCachePartitionLabel('tank', 'tank-cache1'), 1)
    assert.equal(matchCachePartitionLabel('tank', 'tank-cache12'), 12)
  })

  it('never matches a BAND slice, another pool, or a lookalike', () => {
    assert.equal(matchCachePartitionLabel('tank', 'tank-d1-b1'), null)
    assert.equal(matchCachePartitionLabel('tank', 'other-cache1'), null)
    assert.equal(matchCachePartitionLabel('tank', 'tank-cache'), null)
    assert.equal(matchCachePartitionLabel('tank', 'tank-cachex'), null)
    // A pool name is never compiled as a pattern.
    assert.equal(matchCachePartitionLabel('ta.k', 'tank-cache1'), null)
  })

  it('classifies band PVs (md devices) apart from cache PVs', () => {
    assert.equal(isMdPvName('/dev/md127'), true)
    assert.equal(isMdPvName('/dev/md/tank-r1'), true)
    assert.equal(isMdPvName('/dev/sdd1'), false)
    assert.equal(isMdPvName('[unknown]'), false)
  })
})

describe('buildAhrCacheState — the pool `cache` block (ahrcache.1, §13)', () => {
  it('no cache: absent, no devices, no counters', () => {
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvm-lvs.json'))[0],
      pvs: parsePvsReport(loadFixture('lvm-pvs.json')),
      bandCount: 2,
      partsByKernel: partsByKernel({ cacheSlice: false }),
      byIdMap: BY_ID,
      dmStatus: null,
    })
    assert.equal(facts.cache.state, 'absent')
    assert.deepEqual(facts.cache.devices, [])
    assert.equal(facts.cache.sizeBytes, 0)
    assert.equal(facts.cache.hits, undefined)
    assert.deepEqual(facts.diskIds, [])
  })

  it('healthy: the cache disk by-id, the PV size, mode/policy from lvs, counters present', () => {
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cached-live.json'))[0],
      pvs: parsePvsReport(loadFixture('lvm-pvs-cached.json')),
      bandCount: 1,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt')),
    })
    assert.equal(facts.cache.state, 'healthy')
    assert.deepEqual(facts.cache.devices, [CACHE_DISK])
    assert.equal(facts.cache.sizeBytes, 532676608)
    assert.equal(facts.cache.mode, 'writethrough')
    assert.equal(facts.cache.policy, 'smq')
    assert.equal(facts.cache.hits, 795)
    assert.equal(facts.cache.misses, 3585)
    assert.equal(facts.cache.usedBlocks, 1036)
    assert.equal(facts.cache.totalBlocks, 8000)
    // Zero by construction in writethrough — a non-zero value would be a bug.
    assert.equal(facts.cache.dirtyBlocks, 0)
    assert.deepEqual(facts.diskIds, [CACHE_DISK])
  })

  it('failed: the counters are GATED OFF — lvs still reports numbers (GT-23)', () => {
    const lv = parseLvsReport(loadFixture('lvs-cache-missing.json'))[0]
    // lvs is still answering — with zeros here, with stale values in GT-23.
    assert.equal(lv.cacheTotalBlocks, 0)
    assert.equal(lv.cacheMode, 'writethrough')

    const facts = buildAhrCacheState({
      poolName: POOL,
      lv,
      pvs: parsePvsReport(loadFixture('lvm-pvs-cache-missing.json')),
      bandCount: 1,
      // The disk is gone, so lsblk no longer carries its slice.
      partsByKernel: partsByKernel({ cacheSlice: false }),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-failed.txt')),
    })
    assert.equal(facts.cache.state, 'failed')
    assert.equal(facts.cache.hits, undefined)
    assert.equal(facts.cache.misses, undefined)
    assert.equal(facts.cache.usedBlocks, undefined)
    assert.equal(facts.cache.totalBlocks, undefined)
    assert.equal(facts.cache.dirtyBlocks, undefined)
    // The id cannot be recovered from a disk that is not there — never invented.
    assert.deepEqual(facts.cache.devices, [])
    // The SIZE survives: a missing PV still reports its pv_size.
    assert.equal(facts.cache.sizeBytes, 532676608)
  })

  it('an `[unknown]` PV is NOT read as a cache when a band PV is the missing one', () => {
    // Two bands, only one named md PV: the nameless PV could be either, so it
    // is not claimed for the cache. Inventing a failed cache from a missing
    // BAND would be a diagnosis the evidence does not support.
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cache-missing.json'))[0],
      pvs: parsePvsReport(loadFixture('lvm-pvs-cache-missing.json')),
      bandCount: 2,
      partsByKernel: partsByKernel({ cacheSlice: false }),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-failed.txt')),
    })
    assert.equal(facts.cache.sizeBytes, 0)
  })

  it('a LEFTOVER slice keeps the disk attributed to the pool (GT-22)', () => {
    // After `pvremove` + `wipefs` but before `sgdisk -d`: LVM knows nothing,
    // the GPT label is the only truth left, and the disk is still ours.
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvm-lvs.json'))[0],
      pvs: parsePvsReport(loadFixture('lvm-pvs.json')),
      bandCount: 2,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-uncached.txt')),
    })
    assert.equal(facts.cache.state, 'absent')
    assert.deepEqual(facts.cache.devices, [CACHE_DISK])
    // No PV left, so the on-disk slice size stands in.
    assert.equal(facts.cache.sizeBytes, 535805440)
    assert.deepEqual(facts.diskIds, [CACHE_DISK])
  })

  it('the rotating advisory states the fact once, singular and plural', () => {
    assert.equal(rotatingCacheAdvisory(['a']), 'a is a rotating disk: a rotating cache adds a seek, not speed')
    assert.equal(rotatingCacheAdvisory(['a', 'b']), 'a, b are rotating disks: a rotating cache adds a seek, not speed')
  })
})
