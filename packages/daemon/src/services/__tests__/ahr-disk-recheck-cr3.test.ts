import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diskIneligibility, inventoryUnreadableRefusal, isDiskStatusUnknown } from '../ahr-disk-recheck.js'

/**
 * cr3 (handed by the pools area): a disk whose pool membership could not be
 * READ arrives with status `unknown`. Every AHR eligibility door answers it
 * 409 `unreadable` naming the inventory — never 400 "not available
 * (status: unknown)", which blamed the request for a read that failed.
 */
describe('the disk-inventory-unreadable answer (cr3)', () => {
  const disk = (status: string) => ({ id: 'ata-X', status, handsOff: null }) as unknown as Disk

  it('a status-unknown row is recognised, and its sentence names the inventory, not the request', () => {
    assert.equal(isDiskStatusUnknown(disk('unknown')), true)
    assert.equal(isDiskStatusUnknown(disk('available')), false)
    const why = diskIneligibility('ata-X', disk('unknown'))!
    assert.match(why, /the disk inventory could not be read for 'ata-X' \(its pool membership could not be read\)/)
    assert.ok(!why.includes('not available'), why)
  })

  it('the refusal is 409 CONFLICT with reason `unreadable`', () => {
    const r = inventoryUnreadableRefusal(['ata-X', 'ata-Y'])
    assert.equal(r.status, 409)
    assert.equal(r.code, 'CONFLICT')
    assert.equal(r.reason, 'unreadable')
    assert.match(r.message, /'ata-X', 'ata-Y'/)
  })
})
