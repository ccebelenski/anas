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
  foreignVgPvAdvisory,
  isMdPvName,
  matchCachePartitionLabel,
  poolOfCacheLabel,
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
function partsByKernel(opts?: { cacheSlice?: boolean, foreign?: string | null }): Map<string, CachePartInfo> {
  const parts = new Map<string, CachePartInfo>()
  parts.set('sdb1', { partlabel: 'gtcache-d1-b1', size: 1072676352, disk: { name: 'sdb' }, partNumber: 1 })
  if (opts?.cacheSlice !== false)
    parts.set('sdd1', { partlabel: 'gtcache-cache1', size: 535805440, disk: { name: 'sdd' }, partNumber: 1 })
  // An operator's own partition on a third disk, carrying whatever label (or
  // none) they gave it — never one of ours.
  if (opts?.foreign !== undefined)
    parts.set('sde1', { partlabel: opts.foreign, size: 1073741824, disk: { name: 'sde' }, partNumber: 1 })
  return parts
}

const FOREIGN_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8'
const BY_ID = new Map<string, string>([['sdb', BAND_DISK], ['sdd', CACHE_DISK], ['sde', FOREIGN_DISK]])

/** The captured cached-pool `pvs` (lvm-pvs-cached.json) plus extra rows in the same shape. */
function pvsWith(fixture: string, extra: Record<string, string>[]) {
  const doc = JSON.parse(loadFixture(fixture)) as { report: { pv: Record<string, string>[] }[] }
  doc.report[0].pv.push(...extra)
  return parsePvsReport(JSON.stringify(doc))
}

/** A PV row an operator added to the pool VG by hand. */
const FOREIGN_PV_ROW = { pv_name: '/dev/sde1', vg_name: POOL, pv_fmt: 'lvm2', pv_attr: 'a--', pv_size: '1069547520', pv_free: '1069547520', dev_size: '1073741824' }

/**
 * The captured live cached LV with its activation field (lv_attr position 5)
 * set to `-`: the same row as lvm prints it for a cached volume that is not
 * active (`Cwi---C---`), which is what a VG left partial by a band array that
 * did not assemble looks like.
 */
function inactive(fixture: string) {
  const lv = parseLvsReport(loadFixture(fixture))[0]
  return { ...lv, attr: `${lv.attr.slice(0, 4)}-${lv.attr.slice(5)}` }
}

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

  it('a `<pool>-cache<n>` slice LVM counts in ANOTHER volume group is not this pool\'s disk (ident.3)', () => {
    // The label says `POOL`; LVM says the slice belongs to `media`. Identity
    // wins: never a pool disk, never on destroy's wipe list.
    const pvs = parsePvsReport(loadFixture('lvm-pvs.json'))
    pvs.push({ name: '/dev/sdd1', vgName: 'media', sizeBytes: 1, freeBytes: 0, devSizeBytes: 1 })
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvm-lvs.json'))[0],
      pvs,
      bandCount: 2,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: null,
    })
    assert.deepEqual(facts.diskIds, [])
    assert.deepEqual(facts.cache.devices, [])
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

describe('buildAhrCacheState — ahrcache.1 review fixes', () => {
  // ---- Finding 1: a PV is the cache's only on OUR label -------------------

  it('a named PV with NO cache label is foreign: not a pool disk, not in the size, reported', () => {
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cached-live.json'))[0],
      pvs: pvsWith('lvm-pvs-cached.json', [FOREIGN_PV_ROW]),
      bandCount: 1,
      partsByKernel: partsByKernel({ foreign: null }),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt')),
    })
    assert.equal(facts.cache.state, 'healthy')
    // diskIds is what the topology turns into role-'cache' pool disks — the
    // list destroy zaps. The operator's disk must never be on it.
    assert.deepEqual(facts.diskIds, [CACHE_DISK])
    assert.deepEqual(facts.cache.devices, [CACHE_DISK])
    assert.equal(facts.cache.sizeBytes, 532676608, 'the cache size counts our slice only')
    assert.deepEqual(facts.foreignPvs, ['/dev/sde1'])
  })

  it('another pool\'s cache label, or a band label, is foreign too', () => {
    for (const label of ['other-cache1', 'gtcache-d2-b1', 'gtcache-cachex']) {
      const facts = buildAhrCacheState({
        poolName: POOL,
        lv: parseLvsReport(loadFixture('lvs-cached-live.json'))[0],
        pvs: pvsWith('lvm-pvs-cached.json', [FOREIGN_PV_ROW]),
        bandCount: 1,
        partsByKernel: partsByKernel({ foreign: label }),
        byIdMap: BY_ID,
        dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt')),
      })
      assert.deepEqual(facts.foreignPvs, ['/dev/sde1'], label)
      assert.ok(!facts.diskIds.includes(FOREIGN_DISK), label)
    }
  })

  it('a named PV lsblk cannot see at all is not claimed either', () => {
    // No partition record → no label → not provably ours.
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cached-live.json'))[0],
      pvs: pvsWith('lvm-pvs-cached.json', [FOREIGN_PV_ROW]),
      bandCount: 1,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt')),
    })
    assert.deepEqual(facts.foreignPvs, ['/dev/sde1'])
    assert.deepEqual(facts.diskIds, [CACHE_DISK])
  })

  it('a cache PV named by its by-id path resolves through the label to OUR slice', () => {
    const doc = JSON.parse(loadFixture('lvm-pvs-cached.json')) as { report: { pv: Record<string, string>[] }[] }
    doc.report[0].pv[1].pv_name = `/dev/disk/by-id/${CACHE_DISK}-part1`
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cached-live.json'))[0],
      pvs: parsePvsReport(JSON.stringify(doc)),
      bandCount: 1,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt')),
    })
    assert.deepEqual(facts.foreignPvs, [])
    assert.deepEqual(facts.diskIds, [CACHE_DISK])
    assert.equal(facts.cache.sizeBytes, 532676608)
  })

  it('the foreign-PV advisory names the PV and says what each verb does with it', () => {
    const one = foreignVgPvAdvisory('tank', ['/dev/sde1'])
    assert.match(one, /volume group 'tank' also holds \/dev\/sde1, which is neither a band array nor one of this pool's cache slices/)
    assert.match(one, /Detach cache does not remove it/)
    assert.match(one, /Destroy removes the volume group and leaves it as a physical volume with no volume group/)
    assert.match(one, /expansion grows the pool volume into any free space it has/)
    assert.match(foreignVgPvAdvisory('tank', ['/dev/sde1', '/dev/sdf1']), /\/dev\/sde1, \/dev\/sdf1, which are neither/)
  })

  // ---- Finding 2: `failed` needs evidence the CACHE is the problem --------

  it('an INACTIVE cached LV with its cache PV present reads `inactive`, never `failed`', () => {
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: inactive('lvs-cached-live.json'),
      pvs: parsePvsReport(loadFixture('lvm-pvs-cached.json')),
      bandCount: 1,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      // The reader does not ask dmsetup for an inactive volume.
      dmStatus: null,
    })
    assert.equal(facts.cache.state, 'inactive')
    assert.equal(facts.deviceMissing, false)
    assert.equal(facts.cache.deviceMissing, undefined)
    assert.equal(facts.cache.hits, undefined, 'no counter rides a cache whose health is unread')
    assert.deepEqual(facts.cache.devices, [CACHE_DISK])
  })

  it('an inactive cached LV over a MISSING BAND (band guard fails) is `inactive` too', () => {
    // The finding's own shape: the VG is partial because a band did not
    // assemble; the cache SSD is fine. Two `[unknown]`-capable slots and only
    // the cache named — the nameless PV is the band's.
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: inactive('lvs-cached-live.json'),
      pvs: pvsWith('lvm-pvs-cached.json', [{ pv_name: '[unknown]', vg_name: POOL, pv_fmt: 'lvm2', pv_attr: 'a-m', pv_size: '1065353216', pv_free: '0', dev_size: '0' }]),
      bandCount: 2,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: null,
    })
    assert.equal(facts.cache.state, 'inactive')
    assert.equal(facts.deviceMissing, false)
  })

  it('an inactive cached LV whose cache PV IS missing reads `failed` (the boot-time dead SSD)', () => {
    // LVM refuses to activate a partial cached LV, so a node that boots with
    // the cache SSD dead has exactly this: inactive volume, band PV present,
    // cache PV `[unknown]`. That is evidence, and the boot rung must act on it.
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: inactive('lvs-cache-missing.json'),
      pvs: parsePvsReport(loadFixture('lvm-pvs-cache-missing.json')),
      bandCount: 1,
      partsByKernel: partsByKernel({ cacheSlice: false }),
      byIdMap: BY_ID,
      dmStatus: null,
    })
    assert.equal(facts.cache.state, 'failed')
    assert.equal(facts.deviceMissing, true)
    assert.equal(facts.cache.deviceMissing, true)
  })

  it('an ACTIVE cache target with no legible dm answer still reads `failed` (GT-23 asymmetry)', () => {
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cached-live.json'))[0],
      pvs: parsePvsReport(loadFixture('lvm-pvs-cached.json')),
      bandCount: 1,
      partsByKernel: partsByKernel(),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus('Device does not exist.'),
    })
    assert.equal(facts.cache.state, 'failed')
    assert.equal(facts.deviceMissing, false, 'failed, but nothing says the device is gone')
  })

  // ---- Finding 3: the idle pull ------------------------------------------

  it('IDLE PULL: dm still prints healthy counters, but the cache PV is `[unknown]` → failed', () => {
    // dm-cache enters Fail only once an I/O reaches the dead device. On an
    // idle pool the status line stays healthy after the pull; the missing PV
    // is the evidence, and the first read would return EIO.
    const facts = buildAhrCacheState({
      poolName: POOL,
      lv: parseLvsReport(loadFixture('lvs-cache-missing.json'))[0],
      pvs: parsePvsReport(loadFixture('lvm-pvs-cache-missing.json')),
      bandCount: 1,
      partsByKernel: partsByKernel({ cacheSlice: false }),
      byIdMap: BY_ID,
      dmStatus: parseDmsetupStatus(loadFixture('dmsetup-status-cache-healthy.txt')),
    })
    assert.equal(facts.cache.state, 'failed')
    assert.equal(facts.cache.deviceMissing, true)
    assert.equal(facts.cache.hits, undefined, 'the healthy-looking counters are not presented')
  })

  // ---- Finding 5: one home for the label ----------------------------------

  it('the label helper round-trips through BOTH inverses, even for a pool named like a cache', () => {
    for (const pool of ['tank', 'my-cache', 'x-cache9']) {
      for (const n of [1, 9, 12]) {
        const label = cachePartitionLabel(pool, n)
        assert.equal(matchCachePartitionLabel(pool, label), n, label)
        assert.equal(poolOfCacheLabel(label), pool, label)
      }
    }
  })
})
