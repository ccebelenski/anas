/**
 * The claims say what they are. A LUN that is in the saved configuration and
 * missing from the live tree HOLDS its backing until it is put back, and its
 * claim SAYS so (`lunMissing`, plus `backstoreMissing` when no live backstore
 * holds the backing either). One backing has one claim: an `unmapped` claim is
 * dropped only when a missing LUN's own claim already says the same thing
 * (same backstore name, backing path, pool and dataset); when they differ both
 * stay. A fully live LUN, and a live backstore nothing maps and no saved LUN
 * names, are unchanged.
 */
import type { IscsiClaim } from '@anas/shared'
import type { IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claimsFromState } from '../iscsi-mutate.js'
import { buildIscsiTargets } from '../iscsi.js'
import { contextOf } from './lio-model.js'

const IQN = 'iqn.2026-08.nas.anas:claims'
const BASE = { iqn: IQN, tag: 1, backstores: [], luns: [] }
const NEWVOL = '/dev/zvol/tank/newvol'
const IMG = '/mnt/ahr1/images/img.raw'
const VOL_BACKSTORE = { name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's1' }
const VOL_LUN = { iqn: IQN, tag: 1, index: 0, backstore: 'newvol', plugin: 'block' }

/** The clause a missing LUN's claim carries, appended to its `detail`. */
const MISSING_CLAUSE = '; this LUN is in the saved iSCSI configuration and missing from the live one, and it holds this object until the LUN is put back'

async function claimsOf(ctx: IscsiReadContext): Promise<IscsiClaim[]> {
  return claimsFromState(ctx, await buildIscsiTargets(ctx))
}

describe('claimsFromState — a saved LUN missing live holds its backing and says so', () => {
  it('a saved LUN, not live, no live backstore of its name: ONE claim, both flags, and the sentence', async () => {
    const ctx = contextOf({ backstores: [], luns: [] }, { backstores: [VOL_BACKSTORE], luns: [VOL_LUN] }, BASE)
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.lunMissing, true)
    assert.equal(claims[0]?.backstoreMissing, true)
    assert.equal(claims[0]?.unmapped, undefined)
    assert.ok(claims[0]?.detail.endsWith(MISSING_CLAUSE), claims[0]?.detail)
  })

  it('the same with the backstore still live at the same path: ONE claim, no unmapped claim for that backstore', async () => {
    const live = { backstores: [VOL_BACKSTORE], luns: [] }
    const ctx = contextOf(live, { backstores: [VOL_BACKSTORE], luns: [VOL_LUN] }, BASE)
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.lunMissing, true)
    assert.equal(claims[0]?.backstoreMissing, undefined)
    assert.equal(claims[0]?.unmapped, undefined)
    assert.ok(claims[0]?.detail.endsWith(MISSING_CLAUSE), claims[0]?.detail)
  })

  // The two claims say different things: the image file is gone, so the LUN
  // row carries no pool or dataset (the placeless rule) while the live
  // backstore's claim still names the AHR pool whose mount hosts the path.
  // Dropping an unmapped claim on the backstore name ALONE loses that fact.
  it('a missing LUN whose claim and the unmapped claim differ in pool: BOTH claims stay', async () => {
    const backstore = { name: 'img', plugin: 'fileio', dev: IMG, wwn: 's2' }
    const ctx = contextOf({ backstores: [backstore], luns: [] }, {
      backstores: [backstore],
      luns: [{ iqn: IQN, tag: 1, index: 0, backstore: 'img', plugin: 'fileio' }],
    }, BASE)
    ctx.inputs.ahrMountpoints = new Map([['ahr1', '/mnt/ahr1']])
    ctx.backing.set(IMG, { exists: false, size: null })
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 2)
    const lunClaim = claims.find(c => c.unmapped === undefined)
    const unmapped = claims.find(c => c.unmapped === true)
    assert.equal(lunClaim?.lunMissing, true)
    assert.equal(lunClaim?.backstoreMissing, undefined)
    assert.equal(lunClaim?.pool, undefined)
    assert.equal(unmapped?.pool, 'ahr1')
    assert.equal(unmapped?.backstoreName, 'img')
  })

  it('a fully live LUN: neither flag, and the detail is byte-identical', async () => {
    const live = { backstores: [VOL_BACKSTORE], luns: [VOL_LUN] }
    const ctx = contextOf(live, live, BASE)
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.lunMissing, undefined)
    assert.equal(claims[0]?.backstoreMissing, undefined)
    assert.equal(claims[0]?.unmapped, undefined)
    assert.equal(claims[0]?.detail, 'held by iSCSI LUN 0 \'newvol\' of target iqn.2026-08.nas.anas:claims (/dev/zvol/tank/newvol)')
  })

  it('a live backstore nothing maps and no saved LUN names: its unmapped claim is unchanged', async () => {
    const ctx = contextOf({ backstores: [VOL_BACKSTORE], luns: [] }, null, BASE)
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.unmapped, true)
    assert.equal(claims[0]?.lunMissing, undefined)
    assert.equal(claims[0]?.backstoreMissing, undefined)
    assert.equal(claims[0]?.detail, 'held by iSCSI backstore \'newvol\' (block, /dev/zvol/tank/newvol), which is not mapped as a LUN')
  })

  it('two saved LUNs naming one live backstore, both missing live: two lunMissing claims, no unmapped claim', async () => {
    const live = { backstores: [VOL_BACKSTORE], luns: [] }
    const ctx = contextOf(live, {
      backstores: [VOL_BACKSTORE],
      luns: [VOL_LUN, { iqn: IQN, tag: 1, index: 1, backstore: 'newvol', plugin: 'block' }],
    }, BASE)
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 2)
    for (const claim of claims) {
      assert.equal(claim.lunMissing, true)
      assert.equal(claim.backstoreMissing, undefined)
      assert.equal(claim.unmapped, undefined)
    }
    assert.deepEqual(claims.map(c => c.lunIndex), [0, 1])
  })
  it('a LIVE LUN whose backstore was not found live is not called missing: the saved configuration does not name that LUN', async () => {
    const ctx = contextOf({ backstores: [], luns: [VOL_LUN] }, { backstores: [VOL_BACKSTORE], luns: [] }, BASE)
    const claims = await claimsOf(ctx)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.lunMissing, undefined)
    assert.equal(claims[0]?.backstoreMissing, undefined)
    assert.ok(!claims[0]?.detail.includes('missing from the live one'), claims[0]?.detail)
  })
})
