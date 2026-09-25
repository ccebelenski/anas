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
 * SLICE 2 adds two more tests at the bottom of this file — the cache device
 * failing under a live pool (udev auto-uncache, the warning card, the
 * notification, the btrfs read-only aftermath and Remount) and the boot rung.
 * Both are WRITTEN, NOT YET RUN: slice 2 was built at unit level while the
 * stunt node was held by another job, so their first run IS the story's live
 * proof and nothing here claims they have passed.
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
  /** slice 2 — the narrow question the Remount verb asks. */
  mountedReadOnly?: boolean
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

// ---- slice 2 helpers --------------------------------------------------------

/** A journald cursor for the daemon's own unit — the "before" of a comparison. */
async function anasdCursor(): Promise<string> {
  const out = await sshExec('journalctl -u anasd -n 0 --no-pager --show-cursor')
  const cursor = out.split('-- cursor:').pop()?.trim() ?? ''
  expect(cursor, 'journalctl printed a cursor').not.toBe('')
  return cursor
}

/**
 * How many PVE notifications the daemon emitted since `cursor`.
 *
 * `PVE::Notify` logs its own outcome line ("notified via target `<target>`")
 * from the perl child, which runs inside anasd's cgroup, so journald files it
 * under `anasd.service`. That line is the PROOF an emission happened; a missing
 * `anas-ahr-*.hbs` pair logs "could not notify via target … failed to render
 * notification template" instead, which the assertions require to be absent.
 */
async function notificationsSince(cursor: string): Promise<{ sent: number, renderFailures: number }> {
  const journal = await sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o short-iso`)
  const lines = journal.split('\n')
  return {
    sent: lines.filter(l => l.includes('notified via target')).length,
    renderFailures: lines.filter(l => l.includes('could not notify')).length,
  }
}

/** The dashboard's `ahr` warning cards, as GET /v1/status reports them. */
async function ahrWarnings(ctx: APIRequestContext): Promise<{ level: string, message: string, ref: string }[]> {
  const res = await ctx.get(`${V1}/status`)
  expect(res.status(), await res.text()).toBe(200)
  const warnings = (await res.json()).data.warnings as { level: string, category: string, message: string, ref: string }[]
  return warnings.filter(w => w.category === 'ahr')
}

/** Poll a predicate against the live API. Returns the first value that passes. */
async function until<T>(read: () => Promise<T>, pass: (v: T) => boolean, timeout: number, what: string): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T = await read()
  while (!pass(last)) {
    if (Date.now() > deadline)
      throw new Error(`${what} did not happen within ${timeout}ms; last: ${JSON.stringify(last)}`)
    await new Promise(resolve => setTimeout(resolve, 500))
    last = await read()
  }
  return last
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

  /**
   * SLICE 2 — THE FAILURE PATH, end to end, as GT §18(a)'s procedure.
   *
   * WRITTEN, NOT YET RUN: slice 2 was built at unit level with the stunt node
   * held by another job. Everything below is the procedure the ground truth
   * already walked by hand, expressed as a spec; the first run of it is the
   * story's live proof and no claim is made here that it has passed.
   *
   * The sequence, and why each step is in it:
   *   1. attach a cache, warm it, and start a reader loop — the cache must be
   *      LIVE and hot when it dies, or the failure proves nothing
   *   2. yank disk 9 live (`ahrcache-fixture.sh pull-cache`) — a real virsh
   *      detach, the shape GT-19 measured: every read returns EIO within the
   *      second, promoted or not, because dm-cache does not fall through to
   *      the origin
   *   3. the udev rung uncaches WITHIN SECONDS, with nobody at a keyboard;
   *      the reader loop recovers on its next pass (GT-20: `--uncache` is live
   *      with the device absent and takes under a third of a second)
   *   4. the warning card and the notification appear, and the notification
   *      really went out (journald cursor window: `notified via target`, zero
   *      `could not notify`)
   *   5. `GET /v1/ahr/<p>` reports `cache.state: absent` with the leftover
   *      device still named — the died-and-returned disk's mark, which is what
   *      keeps Detach cache reachable as the reclaim verb
   *   6. a WRITE takes btrfs read-only (GT-19), `mountedReadOnly` says so, and
   *      Remount is refused without a confirm code, then restores writes
   *   7. the returned disk is detached, which deletes the slice and hands it
   *      back as `available` (GT-22)
   */
  test('slice 2: the cache device dies live, ANAS uncaches itself, Remount restores writes', async ({ playwright, pveTicket }) => {
    const cacheId = BY_ID(CACHE_SERIAL)
    await execFileAsync(FIXTURE_SH, ['up'])
    for (const serial of [...BAND_SERIALS, CACHE_SERIAL])
      expect(await fileExists(`/dev/disk/by-id/${BY_ID(serial)}`), `${serial} attached`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- 0. A pool with a LIVE, WARM cache -------------------------------
      const inventory = await ctx.get(`${V1}/disks`)
      const disks = (await inventory.json()).data as DiskRow[]
      const bandIds = BAND_SERIALS.map(serial => disks.find(d => d.id.includes(serial))!.id)

      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })
      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/cache`, { disks: [cacheId] })

      // Data to read, and enough passes to promote it: a cache that never
      // held a block would make the "reads fail anyway" finding meaningless.
      await sshExec(`cd ${MOUNT} && for i in $(seq 1 32); do dd if=/dev/urandom of=f$i.bin bs=1M count=4 status=none; done && sync`)
      for (let pass = 0; pass < 4; pass++)
        await sshExec(`echo 3 > /proc/sys/vm/drop_caches && cat ${MOUNT}/f*.bin > /dev/null`)
      const warm = await poolDetail(ctx)
      expect(warm.cache?.state).toBe('healthy')
      expect(warm.cache!.usedBlocks!).toBeGreaterThan(0)
      expect(warm.cache?.dirtyBlocks).toBe(0)
      expect(warm.mountedReadOnly).toBe(false)

      // A reader loop against the pool, direct I/O so every pass really
      // reaches the block layer. It records a timestamped rc per file, which
      // is how "recovered on its next pass" is measured rather than asserted.
      const READER_LOG = '/tmp/anas-cache-reader.log'
      await sshExec(
        `rm -f ${READER_LOG}; setsid bash -c 'for p in $(seq 1 600); do for f in ${MOUNT}/f*.bin; do `
        + `dd if=$f of=/dev/null bs=4k count=16 iflag=direct status=none 2>/dev/null; `
        + `echo "$(date -Is) pass=$p rc=$?" >> ${READER_LOG}; done; sleep 0.2; done' >/dev/null 2>&1 &`,
      )

      const cursor = await anasdCursor()

      // --- 1. Yank the cache disk, live ------------------------------------
      await execFileAsync(FIXTURE_SH, ['pull-cache'])

      // --- 2. The udev rung uncaches, unattended, within seconds -----------
      // 30 s is a generous ceiling on "within seconds": GT-20 measured the
      // uncache itself at 0.224 s, and the udev event is raised in the same
      // second the kernel removes the device.
      const recovered = await until(
        () => poolDetail(ctx),
        p => p.cache?.state === 'absent',
        30_000,
        'the udev rung uncached the pool',
      )
      // The LEFTOVER device is still named: the disk carries its
      // `<pool>-cache1` slice, and that is what keeps Detach cache reachable
      // as the reclaim verb instead of the disk reading as a foreign one.
      expect(recovered.cache?.devices).toEqual([cacheId])
      expect(recovered.state).toBe('healthy')
      // The node's own view: a plain linear volume, and no ghost PV left in
      // the VG (`vgreduce --removemissing` ran behind the band guard).
      expect(await sshExec(`dmsetup status ${DM_NAME}`)).toContain('linear')
      expect(await sshExec(`pvs --noheadings -o pv_name ${POOL} | tr -d ' '`)).not.toContain('[unknown]')

      // --- 3. The reader loop recovered on its next pass -------------------
      const reader = await sshExec(`tail -40 ${READER_LOG}`)
      expect(reader, 'the reader loop met the EIO window').toContain('rc=1')
      expect(reader.trim().split('\n').at(-1), 'and came back after it').toContain('rc=0')

      // --- 4. The notification really went out -----------------------------
      const notified = await notificationsSince(cursor)
      expect(notified.sent, 'a PVE notification was emitted').toBeGreaterThan(0)
      expect(notified.renderFailures, 'the anas-ahr template pair rendered').toBe(0)
      const journal = await sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o cat`)
      expect(journal).toContain('rung=recover')
      // The udev hook's own record, under the AHR tag.
      const udevJournal = await sshExec(`journalctl -t anas-ahr --after-cursor='${cursor}' --no-pager -o cat`)
      expect(udevJournal).toContain(`EVENT=CacheDeviceRemoved POOL=${POOL} SLICE=${POOL}-cache1`)

      // --- 5. A write takes btrfs read-only, and the card says so ----------
      await sshExec(`dd if=/dev/urandom of=${MOUNT}/after.bin bs=1M count=1 status=none; sync; true`)
      const ro = await until(
        () => poolDetail(ctx),
        p => p.mountedReadOnly === true,
        30_000,
        'btrfs forced the filesystem read-only after the write',
      )
      expect(ro.state).toBe('readonly')
      expect(ro.advisories.some(a => a.includes('writes are stopped until the pool is remounted'))).toBe(true)
      const cards = await ahrWarnings(ctx)
      expect(cards.some(c => c.ref === POOL && c.level === 'critical' && c.message.includes('remounted'))).toBe(true)

      // --- 6. Remount: 409 with a code, then writes are back ---------------
      const challenge = await ctx.post(`${V1}/ahr/${POOL}/remount`)
      expect(challenge.status(), await challenge.text()).toBe(409)
      const warnings = (await challenge.json()).error.warnings as string[]
      expect(warnings.some(w => w.includes('Open share handles break'))).toBe(true)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      await sshExec(`pkill -f 'dd if=${MOUNT}' || true; pkill -f 'seq 1 600' || true`)
      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/remount`, undefined, { 'x-anas-confirm': code })

      const writable = await poolDetail(ctx)
      expect(writable.mountedReadOnly).toBe(false)
      expect(writable.state).toBe('healthy')
      // GT-20's negative, proven from the other side: only umount+mount could
      // have done this — `remount,rw` is refused after an error.
      expect(await sshExec(`dd if=/dev/urandom of=${MOUNT}/proof.bin bs=1M count=1 status=none && echo ok`)).toBe('ok')

      // --- 7. The disk comes back and Detach reclaims it -------------------
      await execFileAsync(FIXTURE_SH, ['return-cache'])
      const returned = await poolDetail(ctx)
      // Still attributed to the pool, by the slice the recovery deliberately
      // did NOT delete — the operator has a product path back to the disk.
      expect(returned.cache?.state).toBe('absent')
      expect(returned.cache?.devices).toEqual([cacheId])

      const detachJob = await runJob(ctx, 'delete', `${V1}/ahr/${POOL}/cache`)
      expect((detachJob.result as { released: string[] }).released).toEqual([cacheId])
      const released = await diskRow(ctx, cacheId)
      expect(released.status).toBe('available')
      expect(released.partitions).toEqual([])

      await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
    }
    finally {
      await sshExec(`pkill -f 'seq 1 600' || true`).catch(() => {})
      await ctx.dispose()
    }
  })

  /**
   * SLICE 2 — THE BOOT RUNG. WRITTEN, NOT YET RUN (see above).
   *
   * LVM refuses to activate a pool LV whose cache metadata is missing —
   * "Refusing activation of partial LV", in normal mode AND under
   * `--activationmode degraded` (GT §18) — so a node that boots with the cache
   * SSD dead comes up with the volume inactive and the fstab mount failed.
   * Restarting anasd with the cache disk already pulled reproduces exactly
   * that, without rebooting the node.
   *
   * What must hold afterwards: the pool is MOUNTED and UNCACHED, and it got
   * there by the recovery running BEFORE the mount — never by coming up with a
   * dm-cache target in front of a device that is not there.
   */
  test('slice 2: the boot rung recovers a cached pool whose cache PV is missing', async ({ playwright, pveTicket }) => {
    const cacheId = BY_ID(CACHE_SERIAL)
    await execFileAsync(FIXTURE_SH, ['up'])
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const inventory = await ctx.get(`${V1}/disks`)
      const disks = (await inventory.json()).data as DiskRow[]
      const bandIds = BAND_SERIALS.map(serial => disks.find(d => d.id.includes(serial))!.id)
      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })
      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/cache`, { disks: [cacheId] })
      await sshExec(`cd ${MOUNT} && dd if=/dev/urandom of=b1.bin bs=1M count=8 status=none && sha256sum b1.bin > /tmp/anas-b1.sha && sync`)
      expect((await poolDetail(ctx)).cache?.state).toBe('healthy')

      // Stop the daemon FIRST, so the pull cannot be answered by the udev rung
      // — the boot rung is what is under proof here, and it must be the only
      // thing that could have repaired the pool.
      await sshExec('systemctl stop anasd')
      await execFileAsync(FIXTURE_SH, ['pull-cache'])
      // The pool is now exactly what a node boots into after losing its cache
      // SSD: a partial cached LV. Unmount and deactivate it so the restart
      // meets the activation refusal rather than a still-running volume.
      await sshExec(`umount ${MOUNT} || true; vgchange -an ${POOL} || true`)
      expect(await sshExec(`vgchange -ay ${POOL} 2>&1 || true`)).toMatch(/partial|Refusing/i)

      const cursor = await anasdCursor()
      await execFileAsync(FIXTURE_SH, ['restart-daemon'])

      // The rung runs once, right after the socket comes up.
      const up = await until(
        () => poolDetail(ctx),
        p => p.mounted && p.cache?.state === 'absent',
        120_000,
        'the boot rung recovered and mounted the pool',
      )
      expect(up.state).toBe('healthy')
      // Mounted read-WRITE: nothing was written through the dead cache, so
      // btrfs never aborted a transaction and Remount is not needed.
      expect(up.mountedReadOnly).toBe(false)
      expect(await sshExec(`dmsetup status ${DM_NAME}`)).toContain('linear')

      // The order that matters: the recovery came BEFORE the mount. The
      // journal is where that is legible — a pool that mounted first would
      // have served EIO to whatever touched it in between.
      const journal = await sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o cat`)
      const uncachedAt = journal.indexOf('rung=recover status=uncached')
      const mountedAt = journal.indexOf('rung=mount result=ok')
      expect(uncachedAt, 'the recovery is journalled').toBeGreaterThan(-1)
      expect(mountedAt, 'the mount is journalled').toBeGreaterThan(-1)
      expect(uncachedAt).toBeLessThan(mountedAt)

      const notified = await notificationsSince(cursor)
      expect(notified.sent).toBeGreaterThan(0)
      expect(notified.renderFailures).toBe(0)

      // The data is intact — a writethrough cache held no only copy.
      expect(await sshExec(`cd ${MOUNT} && sha256sum -c /tmp/anas-b1.sha && echo ok`)).toContain('ok')

      // And the returned disk is reclaimable, exactly as in the live path.
      await execFileAsync(FIXTURE_SH, ['return-cache'])
      await runJob(ctx, 'delete', `${V1}/ahr/${POOL}/cache`)
      expect((await diskRow(ctx, cacheId)).status).toBe('available')
      await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
    }
    finally {
      await ctx.dispose()
    }
  })
})
