import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeHealth } from '../disks.js'

function info(over: Partial<{ state: string, read: number, write: number, checksum: number }> = {}) {
  return {
    pool: 'tank',
    vdevName: 'mirror-0',
    role: 'data' as const,
    state: (over.state ?? 'ONLINE') as any,
    read: over.read ?? 0,
    write: over.write ?? 0,
    checksum: over.checksum ?? 0,
  }
}

describe('computeHealth — fuse SMART pass/fail with ZFS state', () => {
  it('SMART FAILED is critical regardless of ZFS state', () => {
    assert.equal(computeHealth(false, info()), 'critical')
    assert.equal(computeHealth(false, undefined), 'critical')
  })

  it('read/write errors or a faulted vdev are critical', () => {
    assert.equal(computeHealth(true, info({ write: 1 })), 'critical')
    assert.equal(computeHealth(true, info({ read: 3 })), 'critical')
    assert.equal(computeHealth(true, info({ state: 'FAULTED' })), 'critical')
    assert.equal(computeHealth(true, info({ state: 'UNAVAIL' })), 'critical')
  })

  it('checksum errors or a degraded/offline vdev are a warning', () => {
    assert.equal(computeHealth(true, info({ checksum: 2 })), 'warning')
    assert.equal(computeHealth(true, info({ state: 'DEGRADED' })), 'warning')
    assert.equal(computeHealth(true, info({ state: 'OFFLINE' })), 'warning')
  })

  it('an online pool member with no errors is healthy (even if SMART is n/a)', () => {
    assert.equal(computeHealth(true, info()), 'healthy')
    assert.equal(computeHealth(null, info()), 'healthy')
  })

  it('a free disk is healthy only when SMART passed, else unknown', () => {
    assert.equal(computeHealth(true, undefined), 'healthy')
    assert.equal(computeHealth(null, undefined), 'unknown')
  })
})

describe('computeHealth — fuse AHR member state with SMART (disks.2)', () => {
  it('faulty or missing in any band is critical — the worst band wins', () => {
    assert.equal(computeHealth(null, undefined, ['faulty']), 'critical')
    assert.equal(computeHealth(null, undefined, ['missing']), 'critical')
    // A multi-band disk is as sick as its worst band.
    assert.equal(computeHealth(null, undefined, ['in_sync', 'faulty', 'spare']), 'critical')
    assert.equal(computeHealth(true, undefined, ['in_sync', 'missing', 'rebuilding']), 'critical')
  })

  it('a band rebuilding onto a replacement is a warning', () => {
    assert.equal(computeHealth(null, undefined, ['rebuilding']), 'warning')
    assert.equal(computeHealth(true, undefined, ['spare', 'rebuilding']), 'warning')
  })

  it('in_sync and spare members change nothing — SMART keeps its say', () => {
    assert.equal(computeHealth(true, undefined, ['in_sync', 'in_sync']), 'healthy')
    assert.equal(computeHealth(true, undefined, ['spare']), 'healthy')
    assert.equal(computeHealth(null, undefined, ['in_sync']), 'unknown')
  })

  it('SMART failed is still the loudest signal even when md is happy', () => {
    assert.equal(computeHealth(false, undefined, ['in_sync']), 'critical')
    assert.equal(computeHealth(false, undefined, ['spare', 'in_sync']), 'critical')
  })

  it('no member state (a cache disk, or none at all) leaves the SMART-only path untouched', () => {
    assert.equal(computeHealth(true, undefined, []), 'healthy')
    assert.equal(computeHealth(null, undefined, []), 'unknown')
  })
})
