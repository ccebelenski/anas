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
