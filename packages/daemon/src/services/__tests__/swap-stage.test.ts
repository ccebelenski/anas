import type { SwapStageRefusalDeps } from '../mounts.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SWAP_STAGE_REFUSAL_REASON, swapStageRefusal } from '../mounts.js'

/**
 * Story cr.52s-a (cr.52r review defect 5): the swap-stage rule — where ZFS
 * mounts by itself, nobody but root may be able to rename, replace or CREATE a
 * name on the mountpoint's path. cr.52r checked only the existing ANCESTORS
 * (the walk started at `dirname(mp)`) with a blanket sticky exception, so a
 * user-owned leaf under 1777 `/tmp` and any missing name under it passed.
 *
 * The filesystem is staged through the injected deps (ownership the test user
 * could never create for real): a path is "present" when it has an entry.
 */

const DIR = 0o040000
const LNK = 0o120000

function fakeFs(entries: Record<string, { uid: number, mode: number }>): SwapStageRefusalDeps {
  return {
    async longestExistingAncestor(path) {
      let p = path
      while (p !== '/' && !(p in entries))
        p = p.slice(0, p.lastIndexOf('/')) || '/'
      return p
    },
    async dirAttr(path) {
      return entries[path] ?? null
    },
  }
}

const FS = fakeFs({
  '/tmp': { uid: 0, mode: DIR | 0o1777 },
  '/tmp/alice': { uid: 1000, mode: DIR | 0o755 },
  '/tmp/rootdir': { uid: 0, mode: DIR | 0o755 },
  '/tmp/rootdir/sub': { uid: 0, mode: DIR | 0o755 },
  '/tmp/rootopen': { uid: 0, mode: DIR | 0o777 },
  '/srv': { uid: 0, mode: DIR | 0o755 },
  '/srv/shared': { uid: 0, mode: DIR | 0o777 },
  '/srv/grp': { uid: 0, mode: DIR | 0o775 },
  '/srv/sticky': { uid: 0, mode: DIR | 0o1777 },
  '/srv/sticky/rootleaf': { uid: 0, mode: DIR | 0o755 },
  '/srv/user': { uid: 1000, mode: DIR | 0o755 },
  '/srv/link': { uid: 0, mode: LNK | 0o777 },
})

async function refused(mp: string): Promise<string> {
  const r = await swapStageRefusal(mp, FS)
  assert.ok(r, `${mp} must refuse`)
  assert.equal(r.status, 409)
  assert.equal(r.code, 'CONFLICT')
  assert.equal(r.reason, SWAP_STAGE_REFUSAL_REASON)
  return r.message
}

describe('swapStageRefusal — the leaf and the missing name are the rule\'s subject (cr.52s-a)', () => {
  it('a user-owned LEAF under a sticky 1777 parent refuses, naming the leaf', async () => {
    const message = await refused('/tmp/alice')
    assert.match(message, /the mountpoint directory itself is not root-owned/)
  })

  it('a MISSING name directly under a sticky 1777 parent refuses — anyone can create it first', async () => {
    const message = await refused('/tmp/newpool')
    assert.match(message, /'\/tmp' is group\/other-writable \(sticky does not stop another user creating the missing name first\)/)
  })

  it('a missing intermediate under a sticky parent refuses the same way', async () => {
    await refused('/tmp/missing/pool')
  })

  it('an EXISTING root-owned leaf under a sticky parent passes (the sticky exception\'s one honest case)', async () => {
    assert.equal(await swapStageRefusal('/tmp/rootdir', FS), null)
    assert.equal(await swapStageRefusal('/srv/sticky/rootleaf', FS), null)
  })

  it('a missing name under an existing root-owned 0755 directory passes (only root can create it)', async () => {
    assert.equal(await swapStageRefusal('/tmp/rootdir/newpool', FS), null)
    assert.equal(await swapStageRefusal('/srv/newpool', FS), null)
  })

  it('a missing name under a root-owned but world-writable (non-sticky) directory refuses', async () => {
    await refused('/srv/shared/newpool')
    await refused('/tmp/rootopen/newpool')
  })

  it('a group-writable parent of an existing component refuses', async () => {
    await refused('/srv/grp/x/pool')
  })

  it('an existing world-writable LEAF that is root-owned passes — its own mode lets others write inside it, not rename it', async () => {
    assert.equal(await swapStageRefusal('/srv/shared', FS), null)
  })

  it('a user-owned intermediate refuses, naming it', async () => {
    const message = await refused('/srv/user/pool')
    assert.match(message, /its ancestor directory '\/srv\/user' is not root-owned/)
  })

  it('a symlink component refuses', async () => {
    const message = await refused('/srv/link')
    assert.match(message, /is a symlink/)
  })

  it('a component that vanishes between the walk and its attribute read fails closed', async () => {
    const deps: SwapStageRefusalDeps = {
      longestExistingAncestor: async () => '/srv/gone',
      dirAttr: async p => (p === '/srv' ? { uid: 0, mode: DIR | 0o755 } : null),
    }
    const r = await swapStageRefusal('/srv/gone', deps)
    assert.match(r?.message ?? '', /vanished while it was being checked/)
  })
})
