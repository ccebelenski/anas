import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { mountAhrPool } from '../ahr-fstab.js'

// cr4 D-30: an unmounted pool reads its subvolume layout as null, so a mount
// with no line of the pool's own has no layout to build the default mount
// options from. ANAS refuses rather than guess, and names the action for each
// cause.
describe('mountAhrPool — the layout a line-less mount needs', () => {
  it('refuses an unmounted pool with no fstab line, and names the action for each cause', async () => {
    const executor = new MockExecutor()
    await assert.rejects(
      mountAhrPool(executor, { name: 'tank', mountpoint: '/mnt/anas-ahr/tank', subvolLayout: null }, null),
      (err: Error) => {
        assert.equal(
          err.message,
          `pool 'tank' has no fstab line, and its subvolume layout could not be read (the pool is not mounted, or the kernel mount table did not answer) — not mounting it with guessed options. Mount it from the Hybrid RAID view if it is not mounted, or retry once the kernel mount table can be read`,
        )
        return true
      },
    )
    assert.deepEqual(executor.calls, [], 'nothing was run')
  })
})
