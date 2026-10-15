import type { GuardSpec } from '../guard.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JobQueue } from '../../jobs/queue.js'
import {
  ahrClaim,
  diskClaim,
  guardCheck,
  guarded,
  poolClaims,
  smbShareClaim,
  zfsClaims,
  zpoolClaim,
} from '../guard.js'

/**
 * Story cr.33 — the lock keys and the guard's claims (docs/WAVE3-DESIGN.md
 * §4.2, §3.2): the key builders, and a guard spec's claims reaching the queue
 * so two verbs on one object serialise and the second one's job-time gate
 * run sees what the first one did.
 */

const SUBMITTER = { user: 'root@pam', uid: 0 }
const GUID = '6915264936287318418'

/** Submit a job holding `locks` whose body waits until the test ends it. */
function held(queue: JobQueue, op: string, locks: ReturnType<typeof zfsClaims>): { id: string, end: () => void } {
  let end!: () => void
  const done = new Promise<void>((resolve) => {
    end = resolve
  })
  const id = queue.submit(op, SUBMITTER, async () => done, { locks }).id
  return { id, end }
}

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
}

describe('cr.33 — lock key builders (§4.2)', () => {
  it('a dataset claims its own key in the verb\'s mode, every ancestor and the pool shared — keyed below the pool by guid', () => {
    assert.deepEqual(zfsClaims(GUID, 'tank/a/b', 'exclusive'), [
      { key: `zfs:${GUID}/a/b`, mode: 'exclusive', what: `Dataset 'tank/a/b'` },
      { key: `zfs:${GUID}/a`, mode: 'shared', what: `Dataset 'tank/a'` },
      { key: `zfs:${GUID}`, mode: 'shared', what: `Dataset 'tank'` },
      { key: `zpool:${GUID}`, mode: 'shared', what: `Pool 'tank'` },
    ])
    assert.deepEqual(zfsClaims(GUID, 'tank', 'exclusive').map(c => [c.key, c.mode]), [
      [`zfs:${GUID}`, 'exclusive'],
      [`zpool:${GUID}`, 'shared'],
    ])
    // A pool imported under another name keeps its dataset keys.
    assert.deepEqual(zfsClaims(GUID, 'renamed/a/b', 'shared').map(c => c.key), zfsClaims(GUID, 'tank/a/b', 'shared').map(c => c.key))
  })

  it('a snapshot or bookmark name locks its dataset', () => {
    assert.deepEqual(zfsClaims(GUID, 'tank/a@auto-2026-10-15', 'shared'), zfsClaims(GUID, 'tank/a', 'shared'))
    assert.deepEqual(zfsClaims(GUID, 'tank/a#mark', 'shared'), zfsClaims(GUID, 'tank/a', 'shared'))
  })

  it('a pool verb: the guid key, plus the name key for a namespace verb; an unreadable guid falls back to the name key, exclusive', () => {
    assert.deepEqual(poolClaims('tank', GUID, 'exclusive', { namespace: true }), [
      { key: `zpool:${GUID}`, mode: 'exclusive', what: `Pool 'tank'` },
      { key: 'zname:tank', mode: 'exclusive', what: `the pool name 'tank'` },
    ])
    assert.deepEqual(poolClaims('tank', GUID, 'shared'), [zpoolClaim(GUID, 'shared', 'tank')])
    assert.deepEqual(poolClaims('tank', null, 'shared'), [{ key: 'zname:tank', mode: 'exclusive', what: `the pool name 'tank'` }])
  })

  it('the other families: stable ids, and an SMB section case-folded as Samba matches it', () => {
    assert.equal(ahrClaim('Xa3k-…', 'exclusive', 'media').key, 'ahr:Xa3k-…')
    assert.equal(diskClaim('ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567').key, 'disk:ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567')
    assert.equal(smbShareClaim('Media').key, smbShareClaim('media').key)
  })
})

describe('cr.33 — what the dataset keys exclude (through the queue)', () => {
  it('a recursive destroy of tank/a excludes a snapshot of tank/a/b; the snapshot waits and is told why', async () => {
    const queue = new JobQueue()
    const destroy = held(queue, 'zfs.destroy', zfsClaims(GUID, 'tank/a', 'exclusive'))
    const snap = held(queue, 'zfs.snapshot', zfsClaims(GUID, 'tank/a/b@s1', 'shared'))
    assert.equal(queue.get(destroy.id)?.status, 'running')
    assert.equal(queue.get(snap.id)?.status, 'queued')
    assert.equal(queue.get(snap.id)?.progress, `waiting for zfs.destroy (job ${destroy.id}) on Dataset 'tank/a'`)
    destroy.end()
    await tick()
    assert.equal(queue.get(snap.id)?.status, 'running')
    snap.end()
    await tick()
  })

  it('two snapshots under one parent, and verbs on sibling datasets, run together', async () => {
    const queue = new JobQueue()
    const jobs = [
      held(queue, 'zfs.snapshot', zfsClaims(GUID, 'tank/a/b', 'shared')),
      held(queue, 'zfs.snapshot', zfsClaims(GUID, 'tank/a/c', 'shared')),
      held(queue, 'zfs.destroy', zfsClaims(GUID, 'tank/x', 'exclusive')),
      held(queue, 'zfs.rename', zfsClaims(GUID, 'tank/y', 'exclusive')),
    ]
    assert.deepEqual(jobs.map(j => queue.get(j.id)?.status), ['running', 'running', 'running', 'running'])
    for (const j of jobs)
      j.end()
    await tick()
    assert.deepEqual(queue.heldLocks(), [])
  })

  it('a pool-structural exclusive excludes every dataset verb in the pool', async () => {
    const queue = new JobQueue()
    const exp = held(queue, 'zpool.export', poolClaims('tank', GUID, 'exclusive', { namespace: true }))
    const snap = held(queue, 'zfs.snapshot', zfsClaims(GUID, 'tank/a', 'shared'))
    assert.equal(queue.get(snap.id)?.status, 'queued')
    assert.equal(queue.get(snap.id)?.progress, `waiting for zpool.export (job ${exp.id}) on Pool 'tank'`)
    exp.end()
    await tick()
    assert.equal(queue.get(snap.id)?.status, 'running')
    snap.end()
    await tick()
  })
})

describe('cr.33 — a guard spec\'s claims reach the queue', () => {
  interface Thing { name: string, guid: string }
  interface World { thing: Thing | null, held: boolean }

  function spec(world: World): GuardSpec<Thing> {
    return {
      operation: 'thing.destroy',
      object: {
        what: `Pool 'tank'`,
        read: async () => (world.thing ? { ...world.thing } : null),
        id: async t => ({ guid: t.guid }),
        unbound: () => 'unbound',
      },
      gates: [async t => world.held ? { status: 409, code: 'CONFLICT', message: `Pool '${t.name}' is held` } : null],
      locks: async (t, bound) => poolClaims(t.name, bound.id.guid, 'exclusive', { namespace: true }),
    }
  }

  it('guardCheck returns the spec\'s claims built from the bound id; no `locks` means none', async () => {
    const world: World = { thing: { name: 'tank', guid: GUID }, held: false }
    const pre = await guardCheck(spec(world))
    assert.ok(!('refusal' in pre))
    assert.deepEqual(pre.locks.map(c => [c.key, c.mode]), [[`zpool:${GUID}`, 'exclusive'], ['zname:tank', 'exclusive']])
    const { locks: _drop, ...noLocks } = spec(world)
    const bare = await guardCheck(noLocks)
    assert.ok(!('refusal' in bare))
    assert.deepEqual(bare.locks, [])
  })

  it('two verbs confirmed on one pool: the second waits for the first and its job-time gates see what the first did', async () => {
    const world: World = { thing: { name: 'tank', guid: GUID }, held: false }
    const queue = new JobQueue()
    const s = spec(world)
    // Both pass the route door now.
    const pre1 = await guardCheck(s)
    const pre2 = await guardCheck(s)
    assert.ok(!('refusal' in pre1) && !('refusal' in pre2))

    let release!: () => void
    const firstActs = new Promise<void>((resolve) => {
      release = resolve
    })
    const acted: string[] = []
    const id1 = queue.submit(s.operation, SUBMITTER, guarded(s, pre1, async () => {
      acted.push('first')
      await firstActs
      world.held = true // what the first job did makes the second one unsafe
    }), { locks: pre1.locks }).id
    const id2 = queue.submit(s.operation, SUBMITTER, guarded(s, pre2, async () => {
      acted.push('second')
    }), { locks: pre2.locks }).id
    await tick()
    assert.equal(queue.get(id2)?.status, 'queued', 'the second job waits for the lock, not for a slot')
    assert.match(queue.get(id2)?.progress ?? '', new RegExp(`^waiting for thing\\.destroy \\(job ${id1}\\) on Pool 'tank'$`))
    release()
    await tick()
    await tick()
    assert.equal(queue.get(id1)?.status, 'completed')
    assert.equal(queue.get(id2)?.status, 'failed')
    assert.equal(queue.get(id2)?.error?.code, 'CONFLICT')
    assert.deepEqual(acted, ['first'], 'the second body never ran')
  })
})
