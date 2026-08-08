import type { AhrPool, AhrPoolState } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrPool as AhrPoolSchema } from '@anas/shared'
import { JobQueue } from '../../jobs/queue.js'
import { AHR_CREATE_OPERATION, buildFailedCreateWarnings, ROLLED_BACK_MARKER, withAhrCreateStatus } from '../ahr-create-status.js'
import { missingLvAdvisory, missingVgAdvisory, notMountedAdvisory } from '../ahr-topology.js'

/**
 * The create-status overlay (issue #7). A pool being built and a pool whose
 * create job died look IDENTICAL on disk — arrays up, no VG, no LV — so the
 * topology reader honestly calls both `failed`. Only the job queue knows which
 * is which, and this is where that knowledge is applied.
 */

const POOL = 'chiaahr2'

/** A pool read mid-create: bands exist, the LVM layer does not yet. */
function halfBuiltPool(state: AhrPoolState = 'failed'): AhrPool {
  return AhrPoolSchema.parse({
    name: POOL,
    ahrType: 'ahr1',
    mountpoint: `/dev/${POOL}/${POOL}-vol`,
    mounted: false,
    disks: [],
    arrays: [],
    vg: { name: POOL, sizeBytes: 0, freeBytes: 0 },
    lv: { name: `${POOL}-vol`, sizeBytes: 0 },
    capacity: {
      rawBytes: 0,
      usableBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      redundancyOverheadBytes: 0,
      unprotectedWastedBytes: 0,
      pendingBytes: 0,
    },
    state,
    subvolLayout: false,
    // Exactly what readAhrPools pushes when the LVM layer is absent.
    advisories: [missingVgAdvisory(POOL), missingLvAdvisory(POOL), notMountedAdvisory(POOL)],
  })
}

/** A queue holding one `ahr.create` job for POOL, parked mid-flight. */
function queueWithRunningCreate(progress: string): JobQueue {
  const queue = new JobQueue()
  queue.submit(
    AHR_CREATE_OPERATION,
    { user: 'test', uid: 0, params: { name: POOL } },
    async (updateProgress) => {
      updateProgress(progress)
      // Never settles — the job stays 'running', exactly as a multi-minute
      // create does while the status endpoint is polled.
      return new Promise(() => {})
    },
  )
  return queue
}

/** A queue whose `ahr.create` for POOL has already failed. */
async function queueWithFailedCreate(progress: string, message: string): Promise<JobQueue> {
  const queue = new JobQueue()
  queue.submit(
    AHR_CREATE_OPERATION,
    { user: 'test', uid: 0, params: { name: POOL } },
    async (updateProgress) => {
      updateProgress(progress)
      throw new Error(message)
    },
  )
  // Let the rejection settle into the job record.
  await new Promise(resolve => setImmediate(resolve))
  return queue
}

describe('withAhrCreateStatus (issue #7)', () => {
  it('a pool with no job at all is returned untouched', () => {
    const pool = halfBuiltPool()
    assert.equal(withAhrCreateStatus(pool, new JobQueue()), pool)
    // No queue injected (a request-less caller) is equally a no-op.
    assert.equal(withAhrCreateStatus(pool, undefined), pool)
  })

  it('a RUNNING create makes the half-built pool read BUILDING, not failed', () => {
    const queue = queueWithRunningCreate('Creating LVM stack (PVs → VG → LV)')
    const pool = withAhrCreateStatus(halfBuiltPool(), queue)

    assert.equal(pool.state, 'building')
    // The operator is told which step is underway, not that the pool is broken.
    assert.equal(pool.advisories[0], `pool '${POOL}' is being created — Creating LVM stack (PVs → VG → LV)`)
    // The missing-layer noise is dropped: it restates where the job has got to.
    assert.ok(!pool.advisories.includes(missingVgAdvisory(POOL)))
    assert.ok(!pool.advisories.includes(missingLvAdvisory(POOL)))
    assert.ok(!pool.advisories.includes(notMountedAdvisory(POOL)))
  })

  it('a FAILED create keeps state failed but leads with the real error and the fix', async () => {
    const queue = await queueWithFailedCreate(
      'Creating LVM stack (PVs → VG → LV)',
      'Devices have inconsistent logical block sizes (4096 and 512).',
    )
    const pool = withAhrCreateStatus(halfBuiltPool(), queue)

    // The pool really is wrecked — that verdict is correct and must stand.
    assert.equal(pool.state, 'failed')
    assert.match(pool.advisories[0], /creating this pool FAILED at 'Creating LVM stack/)
    assert.match(pool.advisories[0], /inconsistent logical block sizes/)
    assert.match(pool.advisories[1], /Destroy pool 'chiaahr2' and retry the create/)
    assert.ok(!pool.advisories.includes(missingVgAdvisory(POOL)))
  })

  it('a stale FAILED create never contradicts a pool that now reads healthy', async () => {
    const queue = await queueWithFailedCreate('Mounting', 'boom')
    const healthy = halfBuiltPool('healthy')
    assert.equal(withAhrCreateStatus(healthy, queue), healthy)
  })

  it('a job for a DIFFERENT pool is not applied', () => {
    const queue = queueWithRunningCreate('Wiping disks')
    const other = { ...halfBuiltPool(), name: 'someotherpool' } as AhrPool
    assert.equal(withAhrCreateStatus(other, queue).state, 'failed')
  })

  it('a COMPLETED create leaves the read alone (the system is the truth again)', async () => {
    const queue = new JobQueue()
    queue.submit(AHR_CREATE_OPERATION, { user: 'test', uid: 0, params: { name: POOL } }, async () => ({ created: POOL }))
    await new Promise(resolve => setImmediate(resolve))
    const pool = halfBuiltPool()
    assert.equal(withAhrCreateStatus(pool, queue), pool)
  })
})

describe('rolled-back creates (issue #11)', () => {
  it('a pool still visible after a rollback is told to RETRY, never to Destroy', async () => {
    const queue = await queueWithFailedCreate(
      'Creating LVM stack (PVs → VG → LV)',
      `Devices have inconsistent logical block sizes (4096 and 512).${ROLLED_BACK_MARKER}`,
    )
    const pool = withAhrCreateStatus(halfBuiltPool(), queue)

    assert.match(pool.advisories[1], /already rolled back — retry the create/)
    assert.ok(
      !pool.advisories.some(a => a.includes('Destroy pool')),
      'the disks are blank — there is nothing left to destroy',
    )
  })

  it('a create that failed WITHOUT rollback still points at Destroy', async () => {
    const queue = await queueWithFailedCreate('Mounting', 'the rollback ALSO FAILED: sgdisk busy')
    const pool = withAhrCreateStatus(halfBuiltPool(), queue)
    assert.match(pool.advisories[1], /Destroy pool 'chiaahr2' and retry the create/)
  })

  // The visibility gap a successful rollback opens: the pool vanishes from the
  // topology, so an operator who was not watching the create dialog would find
  // the failure nowhere in the UI.
  it('a failed create whose pool no longer EXISTS still cards on the dashboard', async () => {
    const queue = await queueWithFailedCreate(
      'Creating LVM stack (PVs → VG → LV)',
      `Devices have inconsistent logical block sizes (4096 and 512).${ROLLED_BACK_MARKER}`,
    )
    const warnings = buildFailedCreateWarnings([], queue)

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].category, 'ahr')
    assert.equal(warnings[0].ref, POOL)
    // Not critical: nothing is broken and no data is at risk.
    assert.equal(warnings[0].level, 'warning')
    assert.match(warnings[0].message, /was NOT created/)
    assert.match(warnings[0].message, /at 'Creating LVM stack/)
    assert.match(warnings[0].message, /inconsistent logical block sizes/)
    assert.match(warnings[0].message, /create can be retried/)
  })

  it('does NOT card when the pool still exists — the failed-pool card already covers it', async () => {
    const queue = await queueWithFailedCreate('Mounting', 'boom')
    assert.deepEqual(buildFailedCreateWarnings([POOL], queue), [])
  })

  it('a successful retry silences the earlier failure', async () => {
    const queue = await queueWithFailedCreate('Mounting', 'boom')
    assert.equal(buildFailedCreateWarnings([], queue).length, 1)
    // The operator retried and it worked; the pool exists again.
    queue.submit(AHR_CREATE_OPERATION, { user: 'test', uid: 0, params: { name: POOL } }, async () => ({ created: POOL }))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(buildFailedCreateWarnings([POOL], queue), [])
  })

  it('no queue (a request-less caller) cards nothing', () => {
    assert.deepEqual(buildFailedCreateWarnings([], undefined), [])
  })
})

describe('JobQueue.findByOperation (issue #7)', () => {
  it('correlates a job to its pool via the submitter params, and ignores others', () => {
    const queue = new JobQueue()
    const noop = async (): Promise<void> => {}
    queue.submit(AHR_CREATE_OPERATION, { user: 'u', uid: 0, params: { name: 'alpha' } }, noop)
    queue.submit(AHR_CREATE_OPERATION, { user: 'u', uid: 0, params: { name: 'beta' } }, noop)
    queue.submit('ahr.destroy', { user: 'u', uid: 0, params: { name: 'alpha' } }, noop)

    assert.equal(queue.findByOperation(AHR_CREATE_OPERATION, 'alpha')?.operation, AHR_CREATE_OPERATION)
    assert.equal(queue.findByOperation(AHR_CREATE_OPERATION, 'gamma'), undefined)
    // A job with no params at all must never match by accident.
    queue.submit(AHR_CREATE_OPERATION, { user: 'u', uid: 0 }, noop)
    assert.equal(queue.findByOperation(AHR_CREATE_OPERATION, ''), undefined)
  })

  it('returns the MOST RECENT job for the pool — a retry supersedes the old failure', async () => {
    const queue = new JobQueue()
    queue.submit(AHR_CREATE_OPERATION, { user: 'u', uid: 0, params: { name: POOL } }, async () => {
      throw new Error('first attempt')
    })
    await new Promise(resolve => setImmediate(resolve))
    queue.submit(AHR_CREATE_OPERATION, { user: 'u', uid: 0, params: { name: POOL } }, async () => new Promise(() => {}))

    assert.equal(queue.findByOperation(AHR_CREATE_OPERATION, POOL)?.status, 'running')
  })
})
