import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { getZpoolStatus, poolExists, sshExec } from './fixtures/stunt-node'

/**
 * Story vdevs.2 (GitHub #66) — LIVE PROOF of POST /v1/pools/:name/vdevs/remove
 * on the stunt node: a cache leaf, a spare, a single log leaf and a mirrored
 * log come out; data, special and dedup are refused with one sentence, and so
 * is a vdev the pool does not carry. Request-context API tests carrying the
 * PVEAuthCookie, gateway → local anasd → real zpool, exactly like
 * pvepool-api.spec.ts.
 *
 * DEPENDS ON TWO THINGS THAT ARE NOT IN THIS FILE:
 *
 *  1. The fixture `test/stunt-node/vdev-fixture.sh up`, which builds a
 *     THROWAWAY pool `gtvdev` across six partitions of one spare disk, added on
 *     the command line as KERNEL NAMES: <d>1 data, <d>2 log, <d>3 cache,
 *     <d>4 spare, <d>5 special, <d>6 dedup. `… down` destroys it. The whole
 *     file skips when the pool is absent. Nothing here touches any other pool.
 *
 *  2. Story vdevs.1 — the zpool-status parser fix that surfaces the pool-level
 *     `logs`, `special` and `dedup` sections. Until that lands, GET
 *     /v1/pools/gtvdev reports neither the log nor the special/dedup vdevs, so
 *     the log cases here cannot resolve and the special/dedup refusals would
 *     come back as "carries no vdev". RUN THIS FILE ONLY AFTER vdevs.1 IS IN.
 *
 * The tests run SERIALLY and mutate the fixture pool in order: cache out,
 * spare out, log out, mirrored log added by CLI and taken out again. The
 * refusals come last, against the data/special/dedup vdevs that are still
 * there.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtvdev'

/** The sentence the daemon refuses data/special/dedup removal with. */
const EVACUATION_SENTENCE
  = 'data, special and dedup vdevs cannot be removed here — their removal is device evacuation, which ANAS does not offer'

interface PoolDisk { id: string, path: string }
interface PoolVdev { name: string, type: string, disks: PoolDisk[] }
interface PoolGroup { role: string, vdevs: PoolVdev[] }

async function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(ticket),
  })
}

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 60_000,
): Promise<{ status: string, [k: string]: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${JSON.stringify(job.error ?? job.progress ?? '')}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** The pool's vdev groups as ANAS reports them. */
async function vdevGroups(ctx: APIRequestContext): Promise<PoolGroup[]> {
  const res = await ctx.get(`${V1}/pools/${POOL}`)
  expect(res.status()).toBe(200)
  return ((await res.json()).data.vdevGroups ?? []) as PoolGroup[]
}

function groupOf(groups: PoolGroup[], role: string): PoolGroup | undefined {
  return groups.find(g => g.role === role)
}

/** Every leaf name ANAS reports for one role. */
function leavesOf(groups: PoolGroup[], role: string): string[] {
  return (groupOf(groups, role)?.vdevs ?? []).flatMap(v => v.disks.map(d => d.id))
}

/**
 * The fixture disk's kernel base name, read from the pool itself — the fixture
 * picks whatever spare disk the node has, so nothing here hardcodes `sdb`.
 */
async function deviceBase(ctx: APIRequestContext): Promise<string> {
  const data = leavesOf(await vdevGroups(ctx), 'data')
  expect(data.length).toBeGreaterThan(0)
  const base = data[0].replace(/\d+$/, '')
  expect(base).not.toBe('')
  return base
}

/** Remove one vdev through the API and wait for the job to finish. */
async function removeVdev(ctx: APIRequestContext, vdev: string): Promise<{ status: string, [k: string]: any }> {
  const res = await ctx.post(`${V1}/pools/${POOL}/vdevs/remove`, { data: { vdev } })
  expect(res.status()).toBe(202)
  return awaitJob(ctx, (await res.json()).job.id)
}

/** The daemon's 400 body for a refused removal. */
async function refuseVdev(ctx: APIRequestContext, vdev: string): Promise<string> {
  const res = await ctx.post(`${V1}/pools/${POOL}/vdevs/remove`, { data: { vdev } })
  expect(res.status()).toBe(400)
  return (await res.json()).error.message as string
}

/** Does `zpool status <pool>` still print the named section header? */
async function statusHasSection(section: string): Promise<boolean> {
  const text = await getZpoolStatus(POOL)
  return text.split('\n').some(line => line.trim().split(/\s+/)[0] === section)
}

test.beforeEach(async () => {
  test.skip(!(await poolExists(POOL)), `vdev fixture not present — run test/stunt-node/vdev-fixture.sh up`)
})

test.describe.serial('Remove a cache, log or spare vdev (story vdevs.2)', () => {
  test.setTimeout(120_000)

  test('the fixture pool starts with all six vdev classes', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const groups = await vdevGroups(ctx)
      for (const role of ['data', 'log', 'cache', 'spare', 'special', 'dedup'])
        expect(groupOf(groups, role), `${POOL} reports its ${role} vdev`).toBeTruthy()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a cache leaf comes out — zpool status and the API agree', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const leaves = leavesOf(await vdevGroups(ctx), 'cache')
      expect(leaves.length).toBe(1)

      const job = await removeVdev(ctx, leaves[0])
      expect(job.status, JSON.stringify(job.error)).toBe('completed')
      expect(job.result).toMatchObject({ pool: POOL, vdev: leaves[0], role: 'cache' })

      expect(await statusHasSection('cache'), 'zpool status has no cache section').toBe(false)
      expect(groupOf(await vdevGroups(ctx), 'cache'), 'the API reports no cache group').toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a spare comes out', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const leaves = leavesOf(await vdevGroups(ctx), 'spare')
      expect(leaves.length).toBe(1)

      const job = await removeVdev(ctx, leaves[0])
      expect(job.status, JSON.stringify(job.error)).toBe('completed')
      expect(job.result).toMatchObject({ pool: POOL, vdev: leaves[0], role: 'spare' })

      expect(await statusHasSection('spares'), 'zpool status has no spares section').toBe(false)
      expect(groupOf(await vdevGroups(ctx), 'spare'), 'the API reports no spare group').toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a single log leaf comes out', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const leaves = leavesOf(await vdevGroups(ctx), 'log')
      expect(leaves.length).toBe(1)

      const job = await removeVdev(ctx, leaves[0])
      expect(job.status, JSON.stringify(job.error)).toBe('completed')
      expect(job.result).toMatchObject({ pool: POOL, vdev: leaves[0], role: 'log' })

      expect(await statusHasSection('logs'), 'zpool status has no logs section').toBe(false)
      expect(groupOf(await vdevGroups(ctx), 'log'), 'the API reports no log group').toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a MIRRORED log added on the command line comes out by its mirror-N name', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The two partitions freed by the log and cache removals above.
      const base = await deviceBase(ctx)
      await sshExec(`zpool add ${POOL} log mirror ${base}2 ${base}3`)

      // The vdev NAME is read back from ANAS, never guessed: ZFS numbers
      // mirror-N by creation order across the whole pool.
      const logGroup = groupOf(await vdevGroups(ctx), 'log')
      expect(logGroup, 'the API reports the new log vdev').toBeTruthy()
      expect(logGroup!.vdevs.length).toBe(1)
      const mirrorName = logGroup!.vdevs[0].name
      expect(mirrorName).toMatch(/^mirror-\d+$/)
      expect(logGroup!.vdevs[0].disks.length).toBe(2)

      const job = await removeVdev(ctx, mirrorName)
      expect(job.status, JSON.stringify(job.error)).toBe('completed')
      expect(job.result).toMatchObject({ pool: POOL, vdev: mirrorName, role: 'log' })

      expect(await statusHasSection('logs'), 'zpool status has no logs section').toBe(false)
      expect(groupOf(await vdevGroups(ctx), 'log'), 'the API reports no log group').toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('special, dedup and a data leaf are refused with the evacuation sentence', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const groups = await vdevGroups(ctx)
      const targets = [
        leavesOf(groups, 'special')[0],
        leavesOf(groups, 'dedup')[0],
        leavesOf(groups, 'data')[0],
      ]
      for (const target of targets) {
        expect(target, 'the fixture still carries the vdev under test').toBeTruthy()
        expect(await refuseVdev(ctx, target)).toBe(EVACUATION_SENTENCE)
      }

      // Refused means REFUSED: all three are still in the pool.
      const after = await vdevGroups(ctx)
      for (const role of ['special', 'dedup', 'data'])
        expect(groupOf(after, role), `${role} is untouched`).toBeTruthy()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a vdev the pool does not carry is refused by name', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      expect(await refuseVdev(ctx, 'mirror-99')).toBe(`pool ${POOL} carries no vdev 'mirror-99'`)
    }
    finally {
      await ctx.dispose()
    }
  })
})
