import type { LvmLv, LvmPv } from '../../parsers/lvm-report.js'
import type { CachePartInfo } from '../ahr-cache-state.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseMdadmConfDoc } from '../../parsers/mdadm-conf.js'
import { buildAhrCacheState } from '../ahr-cache-state.js'
import { poolBandCount } from '../ahr-identity.js'

/**
 * cr3 review2 2 (probe a3-stopped-band.mts) and 3 (the coordinator's ruling):
 * the band rule that lets an `[unknown]` PV read as the dead CACHE device.
 *  - The band count is the arrays seen OR the arrays the pins name: a band
 *    whose members are ALL absent has no /proc/mdstat entry, and counting
 *    only mdstat let its [unknown] PV pass as the cache — the event and boot
 *    rungs then uncached a healthy cache unattended. Unknown when mdadm.conf
 *    cannot be read.
 *  - A missing row is never the cache beside a PV ANAS did not label, nor
 *    beside a cache slice that is still there.
 */
const PINS_TWO = parseMdadmConfDoc('ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nARRAY /dev/md/tank-r2 metadata=1.2 UUID=bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb\n')
const LV: LvmLv = { name: 'tank-vol', vgName: 'tank', attr: 'Cwi---C-p-', sizeBytes: 1, cacheMode: null, cachePolicy: 'smq', cacheReadHits: null, cacheReadMisses: null, cacheUsedBlocks: null, cacheTotalBlocks: null, cacheDirtyBlocks: null }
const pv = (name: string): LvmPv => ({ name, vgName: 'tank', sizeBytes: 100, freeBytes: 0, devSizeBytes: 100 })
const disk = (name: string) => ({ name, size: 200, model: null, serial: null })
const PARTS = new Map<string, CachePartInfo>([
  ['sds1', { name: 'sds1', partlabel: 'tank-cache1', size: 100, partNumber: 1, disk: disk('sds') } as unknown as CachePartInfo],
  ['sdx1', { name: 'sdx1', partlabel: null, size: 100, partNumber: 1, disk: disk('sdx') } as unknown as CachePartInfo],
])
const BY_ID = new Map([['sds', 'ata-SSD'], ['sdx', 'ata-OPERATOR']])
const state = (pvs: LvmPv[], bandCount: number | null) => buildAhrCacheState({ poolName: 'tank', lv: LV, pvs, bandCount, partsByKernel: PARTS, byIdMap: BY_ID, dmStatus: null })

describe('the band rule — cr3 review2 2 and 3', () => {
  it('poolBandCount: the larger of arrays seen and arrays pinned; unknown when the conf could not be read', () => {
    assert.equal(poolBandCount('tank', 1, PINS_TWO), 2)
    assert.equal(poolBandCount('tank', 3, PINS_TWO), 3)
    assert.equal(poolBandCount('tank', 1, parseMdadmConfDoc('')), 1)
    assert.equal(poolBandCount('tank', 1, null), null)
  })

  it('a3: band 2 ABSENT from mdstat but pinned — its [unknown] PV is never the cache', () => {
    const rows = [pv('/dev/md127'), pv('[unknown]')]
    // mdstat-only counting (1) read it as the cache; the pins say 2 bands.
    assert.equal(state(rows, poolBandCount('tank', 1, PINS_TWO)).deviceMissing, false)
    // Control: one pinned band, its PV named — the [unknown] row IS the cache.
    assert.equal(state(rows, 1).deviceMissing, true)
  })

  it('an unknown band count never names the cache missing', () => {
    assert.equal(state([pv('/dev/md127'), pv('[unknown]')], null).deviceMissing, false)
  })

  it('ruling 3: beside an operator\'s own PV (no pool label) a missing row is never the cache', () => {
    assert.equal(state([pv('/dev/md127'), pv('/dev/sdx1'), pv('[unknown]')], 1).deviceMissing, false)
  })

  it('ruling 3: beside a cache slice that is still there, a missing row is not the cache (an operator\'s vanished PV)', () => {
    assert.equal(state([pv('/dev/md127'), pv('/dev/sds1'), pv('[unknown]')], 1).deviceMissing, false)
  })
})
