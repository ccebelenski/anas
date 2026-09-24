import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { getZpoolStatus, sshExec } from './fixtures/stunt-node'

/**
 * Story vdevs.2 fix batch (GitHub #66) — LIVE PROOF over the layout the issue
 * was reported on: a pool whose leaves are BY-ID PARTITIONS of one device.
 *
 * `vdev-remove-api.spec.ts` proves the same route over a pool built from
 * KERNEL names, where every leaf has a distinct `disk.id`. Here all six
 * classes sit on six partitions of the SAME disk, created from
 * `/dev/disk/by-id/<id>-partN`, so the whole-disk identity the parser derives
 * (the `-partN` stripped) is ONE string shared by all six leaves. On that
 * layout a lookup that took the first matching leaf removed the SLOG of an
 * operator who picked the L2ARC and reported success for role `log`.
 *
 * What this file proves on the real system:
 *   - the dialog-shaped token (the leaf's device-path basename) takes out the
 *     leaf it names and leaves the others alone — asserted against `zpool
 *     status` before and after, not only against the API;
 *   - the stripped disk id is REFUSED as ambiguous and nothing comes out;
 *   - a pool-level section holding TWO cache leaves is one container vdev, and
 *     its leaves come out one at a time;
 *   - the dashboard's telemetry join gives the special partition role
 *     `special`, never the `data` fallback.
 *
 * The file OWNS its fixture: `test/stunt-node/vdev-fixture.sh up-byid` builds
 * the throwaway pool `gtvdev`. beforeAll runs `down` then `up-byid`, afterAll
 * runs `down` (best-effort — a failed teardown must not mask the results). The
 * tests CONSUME the fixture and run SERIALLY in order. Nothing here touches
 * any other pool.
 */

const execFileAsync = promisify(execFile)

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtvdev'

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/vdev-fixture.sh', import.meta.url).pathname

interface PoolDisk { id: string, path: string }
interface PoolVdev { name: string, type: string, state: string, disks: PoolDisk[] }
interface PoolGroup { role: string, vdevs: PoolVdev[] }
interface TelemetryVdev { name: string, role: string, state: string }

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

async function vdevGroups(ctx: APIRequestContext): Promise<PoolGroup[]> {
  const res = await ctx.get(`${V1}/pools/${POOL}`)
  expect(res.status()).toBe(200)
  return ((await res.json()).data.vdevGroups ?? []) as PoolGroup[]
}

function groupOf(groups: PoolGroup[], role: string): PoolGroup | undefined {
  return groups.find(g => g.role === role)
}

/** Every leaf DEVICE PATH ANAS reports for one role. */
function leafPathsOf(groups: PoolGroup[], role: string): string[] {
  return (groupOf(groups, role)?.vdevs ?? []).flatMap(v => v.disks.map(d => d.path))
}

/** The last segment of a device path — what the dialog sends. */
function leafToken(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Replace one leaf through the attach route and wait for the job to finish. */
async function replaceLeaf(
  ctx: APIRequestContext,
  existingDiskId: string,
  newDiskId: string,
): Promise<{ status: string, [k: string]: any }> {
  const res = await ctx.post(`${V1}/pools/${POOL}/attach`, {
    data: { existingDiskId, newDiskId, replace: true },
  })
  expect(res.status(), JSON.stringify(await res.json())).toBe(202)
  return awaitJob(ctx, (await res.json()).job.id)
}

/** The daemon's 400 body for a refused replace. */
async function refuseReplace(
  ctx: APIRequestContext,
  existingDiskId: string,
  newDiskId: string,
): Promise<string> {
  const res = await ctx.post(`${V1}/pools/${POOL}/attach`, {
    data: { existingDiskId, newDiskId, replace: true },
  })
  expect(res.status()).toBe(400)
  return (await res.json()).error.message as string
}

/** Wait (bounded) for `zpool status` to settle on one section's leaves. */
async function waitForSectionLeaves(section: string, expected: string[], timeout = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeout
  let seen: string[] = []
  for (;;) {
    seen = await statusSectionLeaves(section)
    if (seen.join(',') === expected.join(','))
      return seen
    if (Date.now() > deadline)
      return seen
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
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

/** The leaf names `zpool status <pool>` prints under one section header. */
async function statusSectionLeaves(section: string): Promise<string[]> {
  const lines = (await getZpoolStatus(POOL)).split('\n')
  const at = lines.findIndex(line => line.trim().split(/\s+/)[0] === section)
  if (at === -1)
    return []
  const leaves: string[] = []
  const indent = (line: string) => line.length - line.replace(/^[\t ]+/, '').length
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim())
      break
    if (indent(line) <= indent(lines[at]))
      break
    leaves.push(line.trim().split(/\s+/)[0])
  }
  return leaves
}

/** The by-id name of the fixture disk, read from the pool itself. */
async function fixtureDiskId(ctx: APIRequestContext): Promise<string> {
  const ids = new Set((await vdevGroups(ctx)).flatMap(g => g.vdevs.flatMap(v => v.disks.map(d => d.id))))
  expect([...ids], 'every fixture leaf is a partition of ONE disk').toHaveLength(1)
  return [...ids][0]
}

test.describe.serial('Remove a vdev on a BY-ID partition-backed pool (vdevs.2, #66)', () => {
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 240_000 })
    await execFileAsync(FIXTURE_SH, ['up-byid'], { timeout: 240_000 })
  })

  test.afterAll(async () => {
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 240_000 }).catch(() => {})
  })

  test('all six classes sit on partitions of ONE disk — the ids collide', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const groups = await vdevGroups(ctx)
      for (const role of ['data', 'log', 'cache', 'spare', 'special', 'dedup'])
        expect(groupOf(groups, role), `${POOL} reports its ${role} vdev`).toBeTruthy()

      // The shape that makes `disk.id` an ambiguous way to name a leaf: one id
      // for six different devices, told apart only by their `-partN` suffix.
      const disk = await fixtureDiskId(ctx)
      expect(leafPathsOf(groups, 'log')[0]).toBe(`/dev/disk/by-id/${disk}-part2`)
      expect(leafPathsOf(groups, 'cache')[0]).toBe(`/dev/disk/by-id/${disk}-part3`)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the special partition joins the dashboard with role special, not data', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const disk = await fixtureDiskId(ctx)
      const res = await ctx.get(`${V1}/telemetry`)
      expect(res.status()).toBe(200)
      const pool = ((await res.json()).data.pools as { name: string, vdevs: TelemetryVdev[] }[])
        .find(p => p.name === POOL)
      expect(pool, 'telemetry carries the fixture pool').toBeTruthy()

      const roleOf = (part: number) => pool!.vdevs.find(v => v.name === `${disk}-part${part}`)?.role
      expect(roleOf(5), 'the special leaf carries role special').toBe('special')
      expect(roleOf(2)).toBe('log')
      expect(roleOf(3)).toBe('cache')
      expect(roleOf(6)).toBe('dedup')
      expect(pool!.vdevs.filter(v => v.role === 'data')).toHaveLength(1)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the STRIPPED disk id is refused as ambiguous — nothing comes out', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const disk = await fixtureDiskId(ctx)
      const message = await refuseVdev(ctx, disk)
      expect(message).toContain(`names more than one device in pool ${POOL}`)
      expect(message).toContain('name the one you mean by its device')

      // Refused means REFUSED: every class is still there.
      const after = await vdevGroups(ctx)
      for (const role of ['data', 'log', 'cache', 'spare', 'special', 'dedup'])
        expect(groupOf(after, role), `${role} is untouched`).toBeTruthy()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the cache partition comes out and the LOG is untouched', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const disk = await fixtureDiskId(ctx)
      const cachePath = leafPathsOf(await vdevGroups(ctx), 'cache')[0]
      const token = leafToken(cachePath)
      expect(token).toBe(`${disk}-part3`)

      const logBefore = await statusSectionLeaves('logs')
      expect(logBefore).toEqual([`${disk}-part2`])

      const job = await removeVdev(ctx, token)
      expect(job.status, JSON.stringify(job.error)).toBe('completed')
      expect(job.result).toMatchObject({ pool: POOL, vdev: token, role: 'cache' })

      // The system, not the exit code: the cache section is gone and the log
      // section still carries the partition it carried before.
      expect(await statusSectionLeaves('cache'), 'zpool status has no cache section').toEqual([])
      expect(await statusSectionLeaves('logs'), 'the SLOG is untouched').toEqual(logBefore)
      expect(groupOf(await vdevGroups(ctx), 'cache')).toBeUndefined()
      expect(leafPathsOf(await vdevGroups(ctx), 'log')).toEqual([`/dev/disk/by-id/${disk}-part2`])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a section with TWO cache leaves is one vdev, and they come out one at a time', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const disk = await fixtureDiskId(ctx)
      const byId = (part: number) => `/dev/disk/by-id/${disk}-part${part}`

      // Free the spare partition, then put BOTH freed partitions in as cache.
      const spareJob = await removeVdev(ctx, `${disk}-part4`)
      expect(spareJob.status, JSON.stringify(spareJob.error)).toBe('completed')
      await sshExec(`zpool add -f ${POOL} cache ${byId(3)} ${byId(4)}`)

      const cache = groupOf(await vdevGroups(ctx), 'cache')
      expect(cache, 'the API reports the cache group').toBeTruthy()
      expect(cache!.vdevs, 'both leaves are ONE container vdev').toHaveLength(1)
      expect(cache!.vdevs[0].name).toBe('cache')
      expect(cache!.vdevs[0].disks.map(d => d.path).sort()).toEqual([byId(3), byId(4)])

      const first = await removeVdev(ctx, `${disk}-part3`)
      expect(first.status, JSON.stringify(first.error)).toBe('completed')
      expect(await statusSectionLeaves('cache')).toEqual([`${disk}-part4`])
      expect(leafPathsOf(await vdevGroups(ctx), 'cache')).toEqual([byId(4)])

      const second = await removeVdev(ctx, `${disk}-part4`)
      expect(second.status, JSON.stringify(second.error)).toBe('completed')
      expect(await statusSectionLeaves('cache')).toEqual([])
      expect(groupOf(await vdevGroups(ctx), 'cache')).toBeUndefined()

      // The classes that were never named are all still there.
      const after = await vdevGroups(ctx)
      for (const role of ['data', 'log', 'special', 'dedup'])
        expect(groupOf(after, role), `${role} is untouched`).toBeTruthy()
    }
    finally {
      await ctx.dispose()
    }
  })

  /**
   * The REPLACE half of the same contract (vdevs.1 fix batch 2). The dialog
   * builds its replace slots from the pool's leaves, and on this layout all six
   * carry the same `disk.id` — so the slot that used to send it drew six
   * identically labelled rows and `zpool replace gtvdev /dev/disk/by-id/<disk>
   * <new>` named a device the pool does not have. It now sends the leaf's
   * device-path basename and the daemon resolves it against `zpool status`.
   *
   * The replacement is the partition the two tests above freed (the old spare,
   * bigger than the log partition it takes over).
   */
  test('the LOG partition is replaced by its basename — the stripped id is refused', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const disk = await fixtureDiskId(ctx)
      const byId = (part: number) => `/dev/disk/by-id/${disk}-part${part}`

      // The log leaf as ANAS reports it, and the free partition standing by.
      expect(leafPathsOf(await vdevGroups(ctx), 'log')).toEqual([byId(2)])
      expect(await statusSectionLeaves('logs')).toEqual([`${disk}-part2`])
      // The freed partition still carries the label of the cache vdev it was;
      // `zpool replace` refuses a device that looks like a pool member.
      await sshExec(`zpool labelclear -f ${byId(4)} || true`)

      // The stripped disk id names six leaves — refused, with the candidates.
      const message = await refuseReplace(ctx, disk, `${disk}-part4`)
      expect(message).toContain(`names more than one device in pool ${POOL}`)
      expect(message).toContain('name the one you mean by its device')
      expect(leafPathsOf(await vdevGroups(ctx), 'log'), 'nothing was replaced').toEqual([byId(2)])

      // The basename names exactly one leaf — the SLOG comes out, the new
      // partition takes its place, and nothing else moves.
      const job = await replaceLeaf(ctx, `${disk}-part2`, `${disk}-part4`)
      expect(job.status, JSON.stringify(job.error)).toBe('completed')

      const logs = await waitForSectionLeaves('logs', [`${disk}-part4`])
      expect(logs, 'zpool status shows the new leaf in logs').toEqual([`${disk}-part4`])
      expect(leafPathsOf(await vdevGroups(ctx), 'log')).toEqual([byId(4)])

      // The data leaf is where it was — a replace aimed at the disk would have
      // taken the whole device with it.
      expect(leafPathsOf(await vdevGroups(ctx), 'data')).toEqual([byId(1)])
      for (const role of ['data', 'special', 'dedup'])
        expect(groupOf(await vdevGroups(ctx), role), `${role} is untouched`).toBeTruthy()
    }
    finally {
      await ctx.dispose()
    }
  })
})
