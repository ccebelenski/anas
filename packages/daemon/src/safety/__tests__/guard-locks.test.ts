import type { GuardSpec } from '../guard.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { covers, normaliseClaims } from '../../jobs/locks.js'
import { JobQueue } from '../../jobs/queue.js'
import {
  ahrClaim,
  ahrPoolClaims,
  diskClaim,
  guardCheck,
  guarded,
  mountClaim,
  poolClaims,
  reverify,
  smbShareClaim,
  sourcePathsMoved,
  unheldClaimsRefusal,
  zfsClaims,
  zfsDatasetClaims,
  znameClaim,
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
      // cr.64b1 (A): every guid key says it rides with the pool's name key.
      { key: `zfs:${GUID}/a/b`, mode: 'exclusive', what: `Dataset 'tank/a/b'`, within: 'zname:tank' },
      { key: `zfs:${GUID}/a`, mode: 'shared', what: `Dataset 'tank/a'`, within: 'zname:tank' },
      { key: `zfs:${GUID}`, mode: 'shared', what: `Dataset 'tank'`, within: 'zname:tank' },
      { key: `zpool:${GUID}`, mode: 'shared', what: `Pool 'tank'`, within: 'zname:tank' },
      { key: 'zname:tank', mode: 'shared', what: `the pool name 'tank'` },
    ])
    assert.deepEqual(zfsClaims(GUID, 'tank', 'exclusive').map(c => [c.key, c.mode]), [
      [`zfs:${GUID}`, 'exclusive'],
      [`zpool:${GUID}`, 'shared'],
      ['zname:tank', 'shared'],
    ])
    // A pool imported under another name keeps its dataset keys (only the
    // name key, cr.33b, follows the name it is known by now).
    assert.deepEqual(zfsClaims(GUID, 'renamed/a/b', 'shared').map(c => c.key).slice(0, -1), zfsClaims(GUID, 'tank/a/b', 'shared').map(c => c.key).slice(0, -1))
  })

  it('a snapshot or bookmark name locks its dataset', () => {
    assert.deepEqual(zfsClaims(GUID, 'tank/a@auto-2026-10-15', 'shared'), zfsClaims(GUID, 'tank/a', 'shared'))
    assert.deepEqual(zfsClaims(GUID, 'tank/a#mark', 'shared'), zfsClaims(GUID, 'tank/a', 'shared'))
  })

  it('a pool verb: the guid key, plus the name key (exclusive for a namespace verb, shared otherwise — cr.33b); an unreadable guid falls back to the name key, exclusive', () => {
    assert.deepEqual(poolClaims('tank', GUID, 'exclusive', { namespace: true }), [
      { key: `zpool:${GUID}`, mode: 'exclusive', what: `Pool 'tank'`, within: 'zname:tank' },
      { key: 'zname:tank', mode: 'exclusive', what: `the pool name 'tank'` },
    ])
    assert.deepEqual(poolClaims('tank', GUID, 'shared'), [{ ...zpoolClaim(GUID, 'shared', 'tank'), within: 'zname:tank' }, znameClaim('tank', 'shared')])
    // cr.64b1r (3): the fallback says what could not be read.
    assert.deepEqual(poolClaims('tank', null, 'shared'), [{ key: 'zname:tank', mode: 'exclusive', what: `the pool name 'tank'`, unread: `the guid of pool 'tank'` }])
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

/**
 * Story cr.33b P1 — the guid-fallback key split. A route-time guid read that
 * fails leaves a verb with the name key only (§4.2's fallback); before cr.33b a
 * guid-keyed verb on the same pool carried no name key, so the two shared no
 * key and ran together. The builders below are the REAL ones the routes call
 * (datasets.ts `datasetClaims` and access.ts `accessClaims` through
 * `zfsDatasetClaims`, the AHR verbs through `ahrPoolClaims`).
 */
describe('cr.33b — a guid-keyed verb and a name-keyed fallback on one pool serialise', () => {
  const short = (claims: { key: string, mode: string }[]): string[] => claims.map(c => `${c.key} ${c.mode}`)

  it('the four claim sets: a dataset snapshot, a recursive destroy, a pool export, and the fallback', () => {
    assert.deepEqual(short(zfsDatasetClaims(GUID, 'tank/a@s1', 'shared')), [
      `zfs:${GUID}/a shared`,
      `zfs:${GUID} shared`,
      `zpool:${GUID} shared`,
      'zname:tank shared',
    ])
    assert.deepEqual(short(zfsDatasetClaims(GUID, 'tank/a', 'exclusive')), [
      `zfs:${GUID}/a exclusive`,
      `zfs:${GUID} shared`,
      `zpool:${GUID} shared`,
      'zname:tank shared',
    ])
    assert.deepEqual(short(poolClaims('tank', GUID, 'exclusive', { namespace: true })), [
      `zpool:${GUID} exclusive`,
      'zname:tank exclusive',
    ])
    for (const guid of [null, undefined, ''])
      assert.deepEqual(short(zfsDatasetClaims(guid, 'tank/a@s1', 'shared')), ['zname:tank exclusive'])
  })

  it('a snapshot holding the guid keys: a destroy whose guid read failed waits for it, named — and the other way round', async () => {
    const queue = new JobQueue()
    const snap = held(queue, 'zfs.snapshot', zfsDatasetClaims(GUID, 'tank/a@s1', 'shared'))
    const destroy = held(queue, 'zfs.destroy', zfsDatasetClaims(null, 'tank/a', 'exclusive'))
    assert.equal(queue.get(snap.id)?.status, 'running')
    assert.equal(queue.get(destroy.id)?.status, 'queued', 'the fallback destroy no longer runs beside the guid-keyed snapshot')
    assert.equal(queue.get(destroy.id)?.progress, `waiting for zfs.snapshot (job ${snap.id}) on the pool name 'tank'`)
    snap.end()
    await tick()
    assert.equal(queue.get(destroy.id)?.status, 'running')
    // Now the fallback holds the name key: a guid-keyed rollback waits for it.
    const rollback = held(queue, 'zfs.rollback', zfsDatasetClaims(GUID, 'tank/a', 'exclusive'))
    assert.equal(queue.get(rollback.id)?.status, 'queued')
    assert.equal(queue.get(rollback.id)?.progress, `waiting for zfs.destroy (job ${destroy.id}) on the pool name 'tank'`)
    destroy.end()
    await tick()
    assert.equal(queue.get(rollback.id)?.status, 'running')
    rollback.end()
    await tick()
    assert.deepEqual(queue.heldLocks(), [])
  })

  it('the AHR twin: a VG-UUID-keyed verb and a name-keyed fallback on one pool serialise', async () => {
    const queue = new JobQueue()
    const scrub = held(queue, 'ahr.scrub', ahrPoolClaims('media', 'VGU-1', 'shared'))
    const remount = held(queue, 'ahr.remount', ahrPoolClaims('media', null, 'exclusive'))
    assert.equal(queue.get(remount.id)?.status, 'queued')
    assert.equal(queue.get(remount.id)?.progress, `waiting for ahr.scrub (job ${scrub.id}) on the AHR pool name 'media'`)
    scrub.end()
    await tick()
    assert.equal(queue.get(remount.id)?.status, 'running')
    remount.end()
    await tick()
  })

  it('no over-serialisation: guid-keyed verbs on one pool still run together, and a namespace verb on another name does not wait', async () => {
    // Four at a time (the queue's four slots).
    for (const claims of [
      [zfsDatasetClaims(GUID, 'tank/a@s1', 'shared'), zfsDatasetClaims(GUID, 'tank/x', 'exclusive'), poolClaims('tank2', '1111', 'exclusive'), [znameClaim('tank3')]],
      [ahrPoolClaims('media', 'VGU-1', 'shared'), ahrPoolClaims('media', 'VGU-1', 'shared'), zfsDatasetClaims(GUID, 'tank/a@s2', 'shared'), zfsDatasetClaims(GUID, 'tank/y', 'exclusive')],
    ]) {
      const queue = new JobQueue()
      const jobs = claims.map((c, i) => held(queue, `verb.${i}`, c))
      assert.deepEqual(jobs.map(j => queue.get(j.id)?.status), ['running', 'running', 'running', 'running'])
      for (const j of jobs)
        j.end()
      await tick()
      assert.deepEqual(queue.heldLocks(), [])
    }
  })
})

describe('cr.56 (review M2) — unheldClaimsRefusal: the claims a run needs now against the set its job holds', () => {
  const held = [...zfsClaims(GUID, 'tank/media', 'shared'), znameClaim('tank', 'exclusive')]

  it('every needed claim held (the same set, or fewer) → null: an edit that needs no new key runs', () => {
    assert.equal(unheldClaimsRefusal('Backup task \'t\'', 'x', held, held), null)
    assert.equal(unheldClaimsRefusal('Backup task \'t\'', 'x', held, zfsClaims(GUID, 'tank', 'shared')), null)
    // A held EXCLUSIVE claim covers a needed shared one (the name key here).
    assert.equal(unheldClaimsRefusal('Backup task \'t\'', 'x', held, [znameClaim('tank', 'shared')]), null)
  })

  it('a needed claim not held, or held shared where exclusive is needed → STATE_CHANGED naming the field and each unheld object once', () => {
    // A mover's own set (the name key SHARED, as `zfsClaims` builds it) — cr.64b1
    // (A): with the name key held EXCLUSIVE the guid keys of tank/other would be
    // covered (the dominance describe below).
    const r = unheldClaimsRefusal('Backup task \'t\'', 'archive paths were /a; now /b', zfsClaims(GUID, 'tank/media', 'shared'), [
      ...zfsClaims(GUID, 'tank/other', 'shared'),
      zpoolClaim(GUID, 'exclusive', 'tank'),
    ])
    assert.deepEqual(r, {
      status: 409,
      code: 'STATE_CHANGED',
      // cr.64b1 (C): the pool's key IS held — shared — so it is named as such, not as "no lock".
      message: `Backup task 't' changed while this run waited (archive paths were /a; now /b) — the run holds no lock on `
        + `Dataset 'tank/other' and only a shared lock on Pool 'tank', so nothing was done; run it again`,
    })
  })

  it('sourcePathsMoved names the field when it changed, else the filesystem under the same paths', () => {
    assert.equal(sourcePathsMoved({ name: 'archive paths', plural: true }, ['/a', '/b'], ['/a']), 'archive paths were /a, /b; now /a')
    assert.equal(sourcePathsMoved({ name: 'source', plural: false }, [], ['/x']), 'source was none; now /x')
    assert.equal(sourcePathsMoved({ name: 'source', plural: false }, ['/x'], ['/x']), 'source /x now resolves to a different filesystem')
  })
})

describe('cr.64a — the job door recomputes spec.locks from the job\'s own re-read', () => {
  // The paused-queue pattern (mover-source-locks.test.ts): the guarded job is
  // queued behind a holder, the world moves while it waits, the holder lets
  // go — and the job's recompute of ITS OWN re-read finds keys the queue never
  // granted. `world` stands for the facts the spec's `locks` builder reads.
  const GUID2 = '2000000000000000001'

  it('the new-LUN image backing, whose dataset moves while the job waits: STATE_CHANGED naming the backing, and no body', async () => {
    const world = { mount: '/tank/iscsi', guid: GUID }
    const routeMount = world.mount
    const spec: GuardSpec<{ name: string }> = {
      operation: 'backup.restore.image',
      object: {
        what: 'the new LUN\'s backing',
        read: async () => ({ name: 'lun-1' }),
        id: async () => ({ backing: 'tank/iscsi' }),
        unbound: () => 'Could not read the backing — refusing',
      },
      gates: [],
      // The new-LUN door's image-file shape (cr.54): the backing dataset's
      // keys beside the mount its mountpoint resolves to — derived from reads.
      locks: async () => [
        ...zfsDatasetClaims(world.guid, 'tank/iscsi', 'shared'),
        mountClaim(world.mount, 'shared'),
      ],
      locksMoved: () => `the backing dataset 'tank/iscsi' moved: was mounted at ${routeMount}; now at ${world.mount}`,
    }
    const queue = new JobQueue()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail(`route door refused: ${JSON.stringify(pre.refusal)}`)
    // Park the restore behind an unmount of the mount it waits on.
    const unmount = held(queue, 'mount.umount', [mountClaim(world.mount)])
    let bodyRan = false
    const job = queue.submit(
      'backup.restore.image',
      SUBMITTER,
      guarded(spec, pre, async () => {
        bodyRan = true
      }),
      { locks: pre.locks },
    )
    await tick()
    assert.equal(queue.get(job.id)?.status, 'queued', 'the restore waits for the unmount')
    // The dataset's mountpoint moves (another filesystem under the name).
    world.mount = '/mnt/rescue'
    world.guid = GUID2
    unmount.end()
    await tick()
    const rec = queue.get(job.id)
    assert.equal(rec?.status, 'failed', JSON.stringify(rec?.error))
    assert.equal(rec?.error?.code, 'STATE_CHANGED')
    assert.equal(rec?.error?.message, `the new LUN's backing changed while this run waited (the backing dataset 'tank/iscsi' moved: was mounted at `
    + `/tank/iscsi; now at /mnt/rescue) — the run holds no lock on Dataset 'tank/iscsi', Dataset 'tank', Pool 'tank', `
    + `the mount at /mnt/rescue, so nothing was done; run it again`)
    assert.equal(bodyRan, false, 'the body ran')
  })

  it('a dataset verb whose pool is re-created under its name while the job waits: STATE_CHANGED naming the claim sets (no locksMoved), and no body', async () => {
    const world = { guid: GUID }
    const spec: GuardSpec<{ name: string }> = {
      operation: 'zfs.destroy',
      object: {
        what: 'Dataset \'tank/data\'',
        read: async () => ({ name: 'tank/data' }),
        // A name-bound id: the identity door cannot see the pool swap — the
        // recompute is the backstop for a verb whose keys derive from reads.
        id: async o => ({ dataset: o.name }),
        unbound: () => 'Could not read the dataset — refusing',
      },
      gates: [],
      locks: async () => zfsDatasetClaims(world.guid, 'tank/data', 'exclusive'),
    }
    const queue = new JobQueue()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail(`route door refused: ${JSON.stringify(pre.refusal)}`)
    // Park the destroy behind a namespace verb on the name (an import), as a
    // pool re-create takes it.
    const importing = held(queue, 'zpool.import', [znameClaim('tank')])
    let bodyRan = false
    const job = queue.submit(
      'zfs.destroy',
      SUBMITTER,
      guarded(spec, pre, async () => {
        bodyRan = true
      }),
      { locks: pre.locks },
    )
    await tick()
    assert.equal(queue.get(job.id)?.status, 'queued', 'the destroy waits for the import')
    // A different pool now answers to the name.
    world.guid = GUID2
    importing.end()
    await tick()
    const rec = queue.get(job.id)
    assert.equal(rec?.status, 'failed', JSON.stringify(rec?.error))
    assert.equal(rec?.error?.code, 'STATE_CHANGED')
    assert.equal(rec?.error?.message, `Dataset 'tank/data' changed while this run waited (lock claims were zfs:${GUID}/data, zfs:${GUID}, zpool:${GUID}, `
    + `zname:tank; now zfs:${GUID2}/data, zfs:${GUID2}, zpool:${GUID2}, zname:tank) — the run holds no lock on `
    + `Dataset 'tank/data', Dataset 'tank', Pool 'tank', so nothing was done; run it again`)
    assert.equal(bodyRan, false, 'the body ran')
  })

  it('control: a job that now needs FEWER keys than it holds runs (the extra keys only make others wait)', async () => {
    const world = { shrunk: false }
    const spec: GuardSpec<{ name: string }> = {
      operation: 'zfs.snapshot',
      object: {
        what: 'Dataset \'tank/data\'',
        read: async () => ({ name: 'tank/data' }),
        id: async o => ({ dataset: o.name }),
        unbound: () => 'Could not read the dataset — refusing',
      },
      gates: [],
      locks: async () => (world.shrunk
        ? [znameClaim('tank', 'shared')]
        : zfsDatasetClaims(GUID, 'tank/data', 'exclusive')),
    }
    const queue = new JobQueue()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail(`route door refused: ${JSON.stringify(pre.refusal)}`)
    const blocker = held(queue, 'zpool.import', [znameClaim('tank')])
    const job = queue.submit(
      'zfs.snapshot',
      SUBMITTER,
      guarded(spec, pre, async () => ({ done: true })),
      { locks: pre.locks },
    )
    await tick()
    assert.equal(queue.get(job.id)?.status, 'queued')
    world.shrunk = true
    blocker.end()
    await tick()
    assert.equal(queue.get(job.id)?.status, 'completed', JSON.stringify(queue.get(job.id)?.error))
  })
})

describe('cr.64b1 (A) — `covers`: the lock table\'s own rule, asked of a held set', () => {
  const UUID = 'Xa3k-1lQp-KdV8'

  it('the same key: a mode that excludes at least as much — same mode, or exclusive held for shared needed; never shared for exclusive', () => {
    assert.equal(covers([znameClaim('tank', 'shared')], znameClaim('tank', 'shared')), true)
    assert.equal(covers([znameClaim('tank', 'exclusive')], znameClaim('tank', 'shared')), true)
    assert.equal(covers([znameClaim('tank', 'exclusive')], znameClaim('tank', 'exclusive')), true)
    assert.equal(covers([znameClaim('tank', 'shared')], znameClaim('tank', 'exclusive')), false)
    assert.equal(covers([], znameClaim('tank', 'shared')), false)
  })

  it('the name key EXCLUSIVE (cr.33b\'s fallback) covers every guid-keyed claim of ITS pool in either mode — and only of its pool, and only exclusive', () => {
    const fallback = zfsDatasetClaims(null, 'tank/a', 'exclusive')
    for (const c of [...zfsClaims(GUID, 'tank/a/b', 'exclusive'), ...poolClaims('tank', GUID, 'exclusive')])
      assert.equal(covers(fallback, c), true, c.key)
    // Another pool's guid keys: its name key is another key.
    for (const c of zfsClaims('2000000000000000001', 'other/a', 'shared').filter(c => c.key !== 'zname:other'))
      assert.equal(covers(fallback, c), false, c.key)
    // The name key held SHARED excludes nothing a shared guid claim would.
    for (const c of zfsClaims(GUID, 'tank/a', 'shared').filter(c => c.key !== 'zname:tank'))
      assert.equal(covers([znameClaim('tank', 'shared')], c), false, c.key)
    // A bare `zpool:<guid>` (the import by guid, pools.ts) promises no name key, so nothing covers it but itself.
    assert.equal(covers(fallback, zpoolClaim(GUID, 'shared', 'tank')), false)
  })

  it('the AHR twin: `ahrname:` exclusive covers the pool\'s `ahr:<vg uuid>` claim', () => {
    const [ahr] = ahrPoolClaims('media', UUID, 'exclusive')
    assert.equal(covers(ahrPoolClaims('media', null, 'shared'), ahr), true)
    assert.equal(covers([ahrClaim(UUID, 'shared', 'media')], ahr), false)
  })

  it('unheldClaimsRefusal asks `covers`: the fallback held, the guid keys needed → null', () => {
    assert.equal(unheldClaimsRefusal('Dataset \'tank/a\'', 'x', zfsDatasetClaims(null, 'tank/a', 'shared'), zfsDatasetClaims(GUID, 'tank/a', 'shared')), null)
  })

  it('the queue refuses a claim set that names a `within` key it does not carry (the promise `covers` relies on)', () => {
    assert.throws(() => normaliseClaims(zfsClaims(GUID, 'tank/a', 'shared').filter(c => c.key !== 'zname:tank')), /rides with 'zname:tank'/)
    assert.doesNotThrow(() => normaliseClaims(zfsClaims(GUID, 'tank/a', 'shared')))
  })

  it('through the queue: what `covers` says the fallback covers, the table makes wait — a guid-keyed snapshot waits for the fallback holder', async () => {
    const queue = new JobQueue()
    const fallback = held(queue, 'zfs.snapshot', zfsDatasetClaims(null, 'tank/a', 'shared'))
    const guidKeyed = held(queue, 'zfs.destroy', zfsDatasetClaims(GUID, 'tank/a', 'exclusive'))
    await tick()
    assert.equal(queue.get(guidKeyed.id)?.status, 'queued')
    fallback.end()
    guidKeyed.end()
  })
})

describe('cr.64b1 (C, E) — the mode rule: a key held shared where the re-read needs it exclusive', () => {
  it('through the queue: STATE_CHANGED whose sentence names the MODE that moved and the shared lock it holds — no body', async () => {
    const world = { mode: 'shared' as 'shared' | 'exclusive' }
    const spec: GuardSpec<{ name: string }> = {
      operation: 'zfs.set',
      object: {
        what: 'Dataset \'tank/data\'',
        read: async () => ({ name: 'tank/data' }),
        id: async o => ({ dataset: o.name }),
        unbound: () => 'Could not read the dataset — refusing',
      },
      gates: [],
      locks: async () => zfsDatasetClaims(GUID, 'tank/data', world.mode),
    }
    const queue = new JobQueue()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail(`route door refused: ${JSON.stringify(pre.refusal)}`)
    const blocker = held(queue, 'zfs.destroy', zfsDatasetClaims(GUID, 'tank/data', 'exclusive'))
    let bodyRan = false
    const job = queue.submit('zfs.set', SUBMITTER, guarded(spec, pre, async () => {
      bodyRan = true
    }), { locks: pre.locks })
    await tick()
    assert.equal(queue.get(job.id)?.status, 'queued')
    world.mode = 'exclusive'
    blocker.end()
    await tick()
    const rec = queue.get(job.id)
    assert.equal(rec?.status, 'failed', JSON.stringify(rec?.error))
    assert.equal(rec?.error?.code, 'STATE_CHANGED')
    assert.equal(rec?.error?.message, `Dataset 'tank/data' changed while this run waited (lock modes were zfs:${GUID}/data shared; `
    + `now zfs:${GUID}/data exclusive) — the run holds only a shared lock on Dataset 'tank/data', so nothing was done; run it again`)
    assert.equal(bodyRan, false, 'the body ran')
  })

  it('unheldClaimsRefusal: shared held, exclusive needed refuses; exclusive held, shared needed does not', () => {
    const shared = zfsClaims(GUID, 'tank/data', 'shared')
    const exclusive = zfsClaims(GUID, 'tank/data', 'exclusive')
    assert.ok(unheldClaimsRefusal('x', 'y', shared, exclusive))
    assert.equal(unheldClaimsRefusal('x', 'y', exclusive, shared), null)
  })
})

describe('cr.64b1 (D) — every re-check recomputes the claims: `reguard` after a release, and a second spec\'s `reverify`', () => {
  const GUID2 = '2000000000000000001'

  /** A dataset verb whose keys follow `world.guid` (the pool under the name). */
  function datasetSpec(world: { guid: string }, dataset: string): GuardSpec<{ name: string }> {
    return {
      operation: 'zfs.set',
      object: {
        what: `Dataset '${dataset}'`,
        read: async () => ({ name: dataset }),
        id: async o => ({ dataset: o.name }),
        unbound: () => 'Could not read the dataset — refusing',
      },
      gates: [],
      locks: async () => zfsDatasetClaims(world.guid, dataset, 'shared'),
    }
  }

  it('reguard (cr.38\'s release/reacquire loop): the pool re-created under its name while the job had released → STATE_CHANGED from the reguard, and the next act never runs', async () => {
    const world = { guid: GUID }
    const spec = datasetSpec(world, 'tank/data')
    const queue = new JobQueue()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail(`route door refused: ${JSON.stringify(pre.refusal)}`)
    const steps: string[] = []
    let released!: () => void
    const waiting = new Promise<void>((resolve) => {
      released = resolve
    })
    let goOn!: () => void
    const resume = new Promise<void>((resolve) => {
      goOn = resolve
    })
    const job = queue.submit('zfs.set', SUBMITTER, guarded(spec, pre, async (_o, ctx) => {
      steps.push('first act')
      ctx.release()
      released()
      await resume
      await ctx.reguard()
      steps.push('second act')
    }), { locks: pre.locks })
    await waiting
    world.guid = GUID2
    goOn()
    await tick()
    const rec = queue.get(job.id)
    assert.equal(rec?.status, 'failed', JSON.stringify(rec?.error))
    assert.equal(rec?.error?.code, 'STATE_CHANGED')
    assert.match(rec!.error!.message, new RegExp(`now zfs:${GUID2}/data`))
    assert.deepEqual(steps, ['first act'])
  })

  it('cr.64b1r (3) reguard: the pool guid could not be read at the REGUARD only (the route and the first run read it) → 503 UNAVAILABLE "could not be read" from the reguard, never STATE_CHANGED, and the next act never runs', async () => {
    const world: { guid: string | null } = { guid: GUID }
    const spec: GuardSpec<{ name: string }> = {
      ...datasetSpec({ guid: GUID }, 'tank/data'),
      locks: async () => zfsDatasetClaims(world.guid, 'tank/data', 'shared'),
    }
    const queue = new JobQueue()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail(`route door refused: ${JSON.stringify(pre.refusal)}`)
    const steps: string[] = []
    let released!: () => void
    const waiting = new Promise<void>((resolve) => {
      released = resolve
    })
    let goOn!: () => void
    const resume = new Promise<void>((resolve) => {
      goOn = resolve
    })
    const job = queue.submit('zfs.set', SUBMITTER, guarded(spec, pre, async (_o, ctx) => {
      steps.push('first act')
      ctx.release()
      released()
      await resume
      await ctx.reguard()
      steps.push('second act')
    }), { locks: pre.locks })
    await waiting
    world.guid = null
    goOn()
    await tick()
    const rec = queue.get(job.id)
    assert.equal(rec?.status, 'failed', JSON.stringify(rec?.error))
    assert.equal(rec?.error?.code, 'UNAVAILABLE')
    assert.equal(rec?.error?.message, `Dataset 'tank/data': the guid of pool 'tank' could not be read in the job, so the run cannot tell which locks it needs — nothing was done; try again`)
    assert.deepEqual(steps, ['first act'])
  })

  it('cr.64b1r (3) unheldClaimsRefusal: a fallback needed where the guid keys are held is UNAVAILABLE naming the read; the guid keys of ANOTHER pool needed are STATE_CHANGED', () => {
    const heldSet = zfsDatasetClaims(GUID, 'tank/data', 'shared')
    const unread = unheldClaimsRefusal('x', 'y', heldSet, zfsDatasetClaims(null, 'tank/data', 'shared'), [])
    assert.equal(unread?.status, 503)
    assert.equal(unread?.code, 'UNAVAILABLE')
    assert.match(unread!.message, /^x: the guid of pool 'tank' could not be read in the job/)
    const moved = unheldClaimsRefusal('x', 'y', heldSet, zfsDatasetClaims(GUID2, 'tank/data', 'shared'), [])
    assert.equal(moved?.code, 'STATE_CHANGED')
    // Both at once — a mount appeared under the path AND the guid could not be
    // read: the move is a known fact, so the move is the sentence.
    const both = unheldClaimsRefusal('x', 'y', heldSet, [...zfsDatasetClaims(null, 'tank/data', 'shared'), mountClaim('/tank/data', 'shared')], [])
    assert.equal(both?.code, 'STATE_CHANGED')
    assert.match(both!.message, /no lock on the mount at \/tank\/data/)
  })

  it('reverify of a SECOND spec bound beside the verb\'s own (the SMB grant shape): its keys moved while the job waited → STATE_CHANGED from the reverify, before the act', async () => {
    const share = { guid: GUID }
    const grant = { guid: GUID }
    const verb = datasetSpec(share, 'tank/share')
    const second = datasetSpec(grant, 'tank/grant')
    const queue = new JobQueue()
    const pre = await guardCheck(verb)
    const pre2 = await guardCheck(second)
    if ('refusal' in pre || 'refusal' in pre2)
      assert.fail('route door refused')
    const blocker = held(queue, 'zpool.import', [znameClaim('tank')])
    let acted = false
    const job = queue.submit('zfs.set', SUBMITTER, guarded(verb, pre, async () => {
      await reverify(second, pre2.bound)
      acted = true
    }), { locks: [...pre.locks, ...pre2.locks] })
    await tick()
    assert.equal(queue.get(job.id)?.status, 'queued')
    // Only the second spec's object moved (a pool under ITS name would be the
    // same here; the point is the second spec's own recompute).
    grant.guid = GUID2
    blocker.end()
    await tick()
    const rec = queue.get(job.id)
    assert.equal(rec?.status, 'failed', JSON.stringify(rec?.error))
    assert.equal(rec?.error?.code, 'STATE_CHANGED')
    assert.match(rec!.error!.message, /^Dataset 'tank\/grant' changed while this run waited/)
    assert.equal(acted, false, 'the act ran')
  })

  it('control: the same reverify with nothing moved passes, and the route\'s claims ride on the bound', async () => {
    const world = { guid: GUID }
    const spec = datasetSpec(world, 'tank/data')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      assert.fail('route door refused')
    assert.deepEqual(pre.bound.locks, pre.locks)
    assert.equal((await reverify(spec, pre.bound)).object.name, 'tank/data')
  })
})
