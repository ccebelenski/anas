import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story ahrcache.1 slice 1 (AHR read cache — lvmcache writethrough) — LIVE
 * PROOF on the stunt node. Modelled on smbsvc-api.spec.ts's AHR test:
 * request-context API calls carrying the PVEAuthCookie, gateway → local
 * anasd → real sgdisk/LVM/dm-cache.
 *
 * REAL disks, not loop devices: a loop device has no /dev/disk/by-id entry and
 * the daemon addresses AHR disks exclusively by by-id (shared DiskId). The
 * fixture (`test/stunt-node/ahrcache-fixture.sh up`) attaches three blank
 * virtual disks — hot7+hot8 (1 GiB each) for the pool, hot9 (512 MiB) for the
 * cache — and NOTHING else: the pool and its cache are built and torn down
 * here, through the daemon's own API, because building them any other way
 * would dodge the code under proof.
 *
 * What is proven, per AHR-DESIGN §13:
 *   1. attach on a blank disk → job completes → `lvs -a` on the NODE shows the
 *      `Cwi-a-C` pool LV over a hidden `[gtcache-vol_corig]`, and
 *      GET /v1/ahr/gtcache reports cache.state healthy with the disk's by-id
 *   2. GET /v1/disks reports the cache disk in use, role `cache`, attributed to
 *      its pool — the GT-22 mis-reading (`other`, unattributed) is gone
 *   3. reading the same files twice climbs `hits`
 *   4. attaching again is refused (409, already cached), touching nothing
 *   5. detach → job completes → `lvs` shows the plain LV, `dmsetup status`
 *      reads `linear`, and GET /v1/disks reports the disk `available` again —
 *      which only holds because detach DELETES the slice (GT-22)
 *   6. the pool is destroyed through the API and the node is left clean
 *
 * A SECOND test proves DESTROY with the cache still attached (the slice-1 fix
 * batch): `lvremove` refuses a dm-cache target, so destroy runs the detach
 * step's own `lvconvert --uncache` first, and the whole stack — LV, VG, arrays,
 * fstab line — goes, with all three disks selectable again.
 *
 * The cache-device FAILURE path (yank the disk live) belongs to slice 2, which
 * adds the udev rung that makes the recovery automatic.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtcache'
const MOUNT = `/mnt/anas-ahr/${POOL}`
/** The pool LV's device-mapper name (`-` escapes as `--`). */
const DM_NAME = `${POOL}-${POOL}--vol`

const BAND_SERIALS = ['ANAS_HOT7', 'ANAS_HOT8']
const CACHE_SERIAL = 'ANAS_HOT9'
const BY_ID = (serial: string): string => `scsi-0QEMU_QEMU_HARDDISK_${serial}`

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/ahrcache-fixture.sh', import.meta.url).pathname

/** Build an authenticated request context carrying the PVE session cookie. */
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
  timeout = 120_000,
): Promise<{ status: string, error?: { message?: string }, result?: unknown, progress?: string }> {
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

/** Submit a mutation, wait for its job, require it to complete, return it. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
  timeout = 120_000,
): Promise<{ result?: unknown }> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, JSON.stringify(job.error)).toBe('completed')
  return job
}

/** Drive a confirm-gated mutation: 409 challenge → resend with the code. */
async function runConfirmedJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
  timeout = 300_000,
): Promise<void> {
  const challenge = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(challenge.status(), await challenge.text()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  await runJob(ctx, verb, url, data, { 'x-anas-confirm': code }, timeout)
}

interface CacheBlock {
  devices: string[]
  sizeBytes: number
  mode: string
  policy: string
  state: 'healthy' | 'failed' | 'absent'
  hits?: number
  misses?: number
  usedBlocks?: number
  totalBlocks?: number
  dirtyBlocks?: number
}

interface PoolDetail {
  state: string
  mounted: boolean
  cache?: CacheBlock
  lv: { name: string, sizeBytes: number }
  disks: { id: string, role: string }[]
  advisories: string[]
}

async function poolDetail(ctx: APIRequestContext): Promise<PoolDetail> {
  const res = await ctx.get(`${V1}/ahr/${POOL}`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data as PoolDetail
}

interface DiskRow {
  id: string
  status: string
  poolName: string | null
  ahrArray: string | null
  partitions: unknown[]
}

async function diskRow(ctx: APIRequestContext, id: string): Promise<DiskRow> {
  const res = await ctx.get(`${V1}/disks`)
  expect(res.status()).toBe(200)
  const disks = (await res.json()).data as DiskRow[]
  const disk = disks.find(d => d.id === id)
  expect(disk, `${id} present in /v1/disks`).toBeTruthy()
  return disk!
}

/** A file's presence on the node — `test -e` that never throws. */
async function fileExists(path: string): Promise<boolean> {
  return (await sshExec(`test -e '${path}' && echo yes || echo no`)) === 'yes'
}

test.describe('AHR read cache — attach and detach (ahrcache.1)', () => {
  test.setTimeout(900_000)

  test.afterAll(async () => {
    // Leave the node as found. The spec destroys the pool through the API, so
    // this is the safety net for a run that died partway: best-effort teardown
    // of any gtcache remnants, then all three disks detached.
    await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
  })

  test('attach on a blank SSD, hits climb, detach hands the disk back', async ({ playwright, pveTicket }) => {
    // The fixture owns disks 7/8/9 and recreates their images blank — a disk
    // left over from an earlier run carries stale labels, and a stale signature
    // is exactly what makes `pvcreate` abort non-interactively (GT-18).
    const cacheId = BY_ID(CACHE_SERIAL)
    if (!(await fileExists(`/dev/disk/by-id/${cacheId}`)))
      await execFileAsync(FIXTURE_SH, ['up'])
    for (const serial of [...BAND_SERIALS, CACHE_SERIAL])
      expect(await fileExists(`/dev/disk/by-id/${BY_ID(serial)}`), `${serial} attached`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- 0. The pool, through the daemon's own API (confirm flow) ---------
      const inventory = await ctx.get(`${V1}/disks`)
      const disks = (await inventory.json()).data as DiskRow[]
      const bandIds = BAND_SERIALS.map((serial) => {
        const disk = disks.find(d => d.id.includes(serial))
        expect(disk, `disk ${serial} in /v1/disks`).toBeTruthy()
        expect(disk!.status, `disk ${serial} available`).toBe('available')
        return disk!.id
      })
      expect(disks.find(d => d.id === cacheId)!.status).toBe('available')

      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })

      const fresh = await poolDetail(ctx)
      expect(fresh.mounted).toBe(true)
      // The block is present on every read, `absent` when there is no cache —
      // a consumer never has to guess whether the daemon simply omitted it.
      expect(fresh.cache?.state).toBe('absent')
      expect(fresh.cache?.devices).toEqual([])

      // --- 1. Attach -------------------------------------------------------
      // No confirm code: nothing that holds an only copy is destroyed.
      const attachChallenge = await ctx.post(`${V1}/ahr/${POOL}/cache`, { data: { disks: [cacheId] } })
      expect(attachChallenge.status(), await attachChallenge.text()).toBe(202)
      const attachJob = await awaitJob(ctx, (await attachChallenge.json()).job.id)
      expect(attachJob.status, JSON.stringify(attachJob.error)).toBe('completed')
      // The stunt node's virtual disks all report rotational, so the one
      // advisory a spinning cache earns rides out on the job result — the
      // request is NOT refused (it is the operator's disk and their call).
      const attachResult = attachJob.result as { devices: string[], sizeBytes: number, warnings?: string[] }
      expect(attachResult.devices).toEqual([cacheId])
      expect(attachResult.warnings).toEqual([
        `${cacheId} is a rotating disk: a rotating cache adds a seek, not speed`,
      ])

      // The NODE's own view: a cache-target LV over a hidden origin.
      const lvsA = await sshExec(`lvs -a --noheadings -o lv_name,lv_attr ${POOL}`)
      expect(lvsA).toContain(`${POOL}-vol`)
      expect(lvsA).toContain(`[${POOL}-vol_corig]`)
      expect(lvsA).toMatch(/Cwi-a.C/)
      // The pool LV keeps its name and its mapper path across the attach
      // (GT-18) — mounts, shares, LUNs and the fstab line are untouched.
      expect(await sshExec(`findmnt -n -o SOURCE ${MOUNT}`)).toContain(`/dev/mapper/${DM_NAME}`)

      // --- 2. The API's view -----------------------------------------------
      const cached = await poolDetail(ctx)
      expect(cached.state).toBe('healthy')
      expect(cached.cache?.state).toBe('healthy')
      expect(cached.cache?.devices).toEqual([cacheId])
      expect(cached.cache?.mode).toBe('writethrough')
      expect(cached.cache?.policy).toBe('smq')
      // Zero by construction in writethrough — the whole safety story.
      expect(cached.cache?.dirtyBlocks).toBe(0)
      expect(cached.cache?.totalBlocks).toBeGreaterThan(0)
      expect(cached.disks.find(d => d.id === cacheId)?.role).toBe('cache')

      // --- 3. The disks inventory (GT-22's first mis-reading) --------------
      const inUse = await diskRow(ctx, cacheId)
      expect(inUse.status).toBe('ahr_member')
      expect(inUse.poolName).toBe(POOL)
      expect(inUse.ahrArray).toBe('cache')

      // --- 4. Hits climb on a re-read --------------------------------------
      const before = (await poolDetail(ctx)).cache!.hits!
      await sshExec(`cd ${MOUNT} && for i in 1 2 3 4; do dd if=/dev/urandom of=c$i.bin bs=1M count=8 status=none; done && sync`)
      // The page cache is dropped between passes, so the second pass really
      // reaches the block layer — and therefore the cache.
      for (let pass = 0; pass < 3; pass++)
        await sshExec(`echo 3 > /proc/sys/vm/drop_caches && cat ${MOUNT}/c*.bin > /dev/null`)
      const after = (await poolDetail(ctx)).cache!
      expect(after.hits!, 'read hits climbed over repeated reads').toBeGreaterThan(before)
      expect(after.usedBlocks!).toBeGreaterThan(0)
      expect(after.dirtyBlocks).toBe(0)

      // --- 5. Attaching again is refused, and touches nothing --------------
      const again = await ctx.post(`${V1}/ahr/${POOL}/cache`, { data: { disks: [cacheId] } })
      expect(again.status()).toBe(409)
      expect((await again.json()).error.message).toContain('already has a read cache')
      expect((await poolDetail(ctx)).cache?.state).toBe('healthy')

      // --- 6. Detach --------------------------------------------------------
      const detachJob = await runJob(ctx, 'delete', `${V1}/ahr/${POOL}/cache`)
      expect((detachJob.result as { released: string[] }).released).toEqual([cacheId])

      const lvsAfter = await sshExec(`lvs -a --noheadings -o lv_name,lv_attr ${POOL}`)
      expect(lvsAfter).not.toContain('_corig')
      expect(lvsAfter).toMatch(/-wi-ao/)
      expect(await sshExec(`dmsetup status ${DM_NAME}`)).toContain('linear')
      // The data is still there and still readable — the cache held no copy.
      expect(await sshExec(`cat ${MOUNT}/c1.bin > /dev/null && echo ok`)).toBe('ok')

      const uncached = await poolDetail(ctx)
      expect(uncached.state).toBe('healthy')
      expect(uncached.cache?.state).toBe('absent')
      expect(uncached.cache?.devices).toEqual([])
      expect(uncached.disks.some(d => d.role === 'cache')).toBe(false)

      // GT-22: this only reads `available` because detach DELETED the slice.
      // `pvremove` + `wipefs` alone leave a partition, and a partition with no
      // filesystem still reads `other` — the disk could never be picked again.
      const released = await diskRow(ctx, cacheId)
      expect(released.status).toBe('available')
      expect(released.partitions).toEqual([])

      // --- 7. Detaching again is refused ------------------------------------
      const detachAgain = await ctx.delete(`${V1}/ahr/${POOL}/cache`)
      expect(detachAgain.status()).toBe(409)
      expect((await detachAgain.json()).error.message).toContain('has no read cache to detach')

      // --- 8. Destroy through the API, and the node is clean ----------------
      await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
      const list = await ctx.get(`${V1}/ahr`)
      expect((await list.json()).data).toEqual([])
      expect(await sshExec('lvs --noheadings; pvs --noheadings; mdadm --detail --scan')).toBe('')
    }
    finally {
      await ctx.dispose()
    }
  })

  /**
   * DESTROY WITH THE CACHE STILL ATTACHED — the ahrcache.1 slice-1 fix batch.
   *
   * A cached pool's LV is a dm-cache TARGET and `lvremove` REFUSES one, so
   * destroy stopped dead at the LVM teardown: the pool was already unmounted
   * and its fstab line already gone, while the VG, the LV and every band array
   * were still standing — a half-destroyed pool with no product path forward.
   * Destroy now runs the detach step's own `lvconvert --uncache` first.
   *
   * Unit tests pin the argv order; only the node can prove `lvremove` actually
   * accepts what follows, so this rides slice 2's live proof.
   */
  test('destroy with the cache still attached tears the whole stack down', async ({ playwright, pveTicket }) => {
    const cacheId = BY_ID(CACHE_SERIAL)
    // Blank images: a disk left over from the previous test carries stale
    // labels, and a stale signature aborts `pvcreate` non-interactively.
    await execFileAsync(FIXTURE_SH, ['up'])
    for (const serial of [...BAND_SERIALS, CACHE_SERIAL])
      expect(await fileExists(`/dev/disk/by-id/${BY_ID(serial)}`), `${serial} attached`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      const inventory = await ctx.get(`${V1}/disks`)
      const disks = (await inventory.json()).data as DiskRow[]
      const bandIds = BAND_SERIALS.map(serial => disks.find(d => d.id.includes(serial))!.id)

      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })
      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/cache`, { disks: [cacheId] })
      expect((await poolDetail(ctx)).cache?.state).toBe('healthy')
      // The pool LV really is a cache target — the state `lvremove` refuses.
      expect(await sshExec(`lvs --noheadings -o lv_attr ${POOL}/${POOL}-vol`)).toMatch(/^C/)

      // The confirm door names the cache disk and what becomes of it.
      const challenge = await ctx.delete(`${V1}/ahr/${POOL}`)
      expect(challenge.status()).toBe(409)
      const warnings = (await challenge.json()).error.warnings as string[]
      expect(warnings.some(w => w.includes('read cache') && w.includes(cacheId))).toBe(true)
      const code = challenge.headers()['x-anas-confirm-code']
      await runJob(ctx, 'delete', `${V1}/ahr/${POOL}`, undefined, { 'x-anas-confirm': code }, 300_000)

      // NOTHING of the pool survives — before the fix this stopped at the LV.
      const list = await ctx.get(`${V1}/ahr`)
      expect((await list.json()).data).toEqual([])
      expect(await sshExec('lvs --noheadings; pvs --noheadings; vgs --noheadings; mdadm --detail --scan')).toBe('')
      expect(await sshExec(`grep -c anas-ahr /etc/fstab || true`)).toBe('0')

      // All THREE disks — the two band members and the cache SSD — come back
      // selectable. The cache disk only does because destroy zapped its slice
      // as well: a partition with no filesystem still reads `other` (GT-22).
      const after = (await (await ctx.get(`${V1}/disks`)).json()).data as DiskRow[]
      for (const serial of [...BAND_SERIALS, CACHE_SERIAL]) {
        const disk = after.find(d => d.id === BY_ID(serial))!
        expect(disk.status, `${serial} available again`).toBe('available')
        expect(disk.partitions).toEqual([])
      }
    }
    finally {
      await ctx.dispose()
    }
  })
})
