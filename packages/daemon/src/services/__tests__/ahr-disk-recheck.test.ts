import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diskIneligibility } from '../ahr-disk-recheck.js'

/**
 * Story ident.3 (a) — the job-time availability re-check speaks the route's
 * own sentences, so an operator reads the same refusal whether the disk changed
 * before the confirm or while the job waited in the queue.
 */
describe('diskIneligibility', () => {
  const disk = (extra: Partial<Disk>): Disk => ({ id: 'ata-X', status: 'available', ...extra }) as Disk

  it('an available disk with no hands-off tag may be wiped', () => {
    assert.equal(diskIneligibility('ata-X', disk({})), null)
  })

  it('a disk that left the inventory, became a pool member, or is hands-off is refused — named', () => {
    assert.equal(diskIneligibility('ata-X', undefined), `disk 'ata-X' not found in the inventory`)
    assert.equal(
      diskIneligibility('ata-X', disk({ status: 'pool_member', poolName: 'tank' })),
      `disk 'ata-X' is not available (status: pool_member, pool 'tank')`,
    )
    assert.match(diskIneligibility('ata-X', disk({ handsOff: 'iscsi-served-here', handsOffReason: 'an iSCSI LUN serves it' }))!, /hands-off: an iSCSI LUN serves it/)
  })
})
