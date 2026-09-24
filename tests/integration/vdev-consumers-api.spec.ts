import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

/**
 * Story vdevs.1 slice 2 (GitHub #66) — LIVE PROOF of the CONSUMER audit: the
 * parser now reports log, cache, spare, special and dedup vdevs, and this file
 * proves the consumers downstream of it act on them on a real node.
 *
 *   (a) all six classes ONLINE on one disk → GET /v1/disks carries the pool and
 *       the SPECIAL context; `zpool offline` the log leaf → the row moves to the
 *       faulted log class with a non-healthy verdict (it used to be blank for
 *       every non-data class), and GET /v1/status raises the degraded-pool
 *       warning AND the disk warning. Then `zpool online` → clean again.
 *   (b) the Expand / Replace dialog lists the special leaf as a replaceable
 *       member — the one failure that loses the whole pool, previously
 *       unreachable from the UI.
 *   (c) DELETE /v1/pools/gtvdev?cleanup=true → every one of the six partitions
 *       is labelcleared (a destroy used to leave the log, special and dedup
 *       members carrying live ZFS labels) and the disk reads available again.
 *
 * The file OWNS its fixture (`test/stunt-node/vdev-fixture.sh`): down then up in
 * beforeAll, down in afterAll. Test (c) destroys the pool through the API, so
 * the teardown only detaches the disk. Runs SERIALLY — each test leaves the
 * fixture in the state the next one expects. Disks 1-8, gtbackup and gtiscsi
 * are never touched.
 */

const execFileAsync = promisify(execFile)

// The API is reached exactly the way the injected panels reach it: the PVE
// origin's /anas/ forward, which pveproxy proxies to the gateway.
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtvdev'
const BY_ID = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/vdev-fixture.sh', import.meta.url).pathname

interface DiskRow {
  id: string
  name: string
  status: string
  poolName: string | null
  vdevName: string | null
  vdevRole: string | null
  zfsErrors: { read: number, write: number, checksum: number } | null
  healthStatus: string
}

interface DashboardWarning { level: string, category: string, message: string, ref?: string }

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
async function awaitJob(ctx: APIRequestContext, jobId: string, timeout = 60_000): Promise<{ status: string, [k: string]: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** The KERNEL name of the pool's Nth partition (source of truth: the node). */
async function partitionKernelName(n: number): Promise<string> {
  const dev = await sshExec(`readlink -f /dev/disk/by-id/${BY_ID}-part${n}`)
  const name = dev.split('/').pop()
  expect(name, `partition ${n} of ${BY_ID}`).toBeTruthy()
  return name!
}

/** The fixture disk's own row in GET /v1/disks (by its stable by-id). */
async function fixtureDisk(ctx: APIRequestContext): Promise<DiskRow> {
  const res = await ctx.get(`${V1}/disks`)
  expect(res.status()).toBe(200)
  const disks = (await res.json()).data as DiskRow[]
  const disk = disks.find(d => d.id === BY_ID)
  expect(disk, `${BY_ID} in the disk inventory`).toBeTruthy()
  return disk!
}

async function dashboardWarnings(ctx: APIRequestContext): Promise<DashboardWarning[]> {
  const res = await ctx.get(`${V1}/status`)
  expect(res.status()).toBe(200)
  return ((await res.json()).data.warnings ?? []) as DashboardWarning[]
}

test.describe.serial('vdevs.1 slice 2 — the vdev-class consumers, live', () => {
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 240_000 })
    await execFileAsync(FIXTURE_SH, ['up'], { timeout: 240_000 })
  })

  test.afterAll(async () => {
    // Test (c) already destroyed the pool through the API; `down` is idempotent
    // and here only detaches the disk. Best-effort — a failed teardown must not
    // mask the run's results.
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 240_000 }).catch(() => {})
  })

  // -----------------------------------------------------------------------
  // (a) a faulted non-data class reaches the Disks inventory and the dashboard
  // -----------------------------------------------------------------------
  //
  // GROUND TRUTH (ZFS 2.4.4, this fixture): a SINGLE special vdev cannot be
  // offlined — `zpool offline gtvdev <special leaf>` refuses with "no valid
  // replicas", because taking it away would take the pool with it. The LOG
  // device is the class this fixture CAN fault (the pool falls back to the
  // in-pool ZIL and goes DEGRADED), so that is the fault used here. It exercises
  // the same join, and one step further: with the log OFFLINE the disk's single
  // row has to move from the special context to the faulted log one.
  test('a faulted log leaf moves the disk row and raises the pool warning', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const logLeaf = await partitionKernelName(2)

      // Baseline: six classes on ONE disk, all ONLINE — the row carries the
      // special context, the class whose loss costs the most.
      const before = await fixtureDisk(ctx)
      expect(before.poolName).toBe(POOL)
      expect(before.status).toBe('pool_member')
      expect(before.vdevRole).toBe('special')
      expect(before.vdevName).toBe('special')
      expect(before.healthStatus).toBe('healthy')

      await sshExec(`zpool offline ${POOL} ${logLeaf}`)
      // ZFS applies the offline synchronously, but the inventory reads it back
      // through its own `zpool status` — poll rather than race the daemon.
      await expect.poll(async () => (await fixtureDisk(ctx)).healthStatus, { timeout: 30_000 })
        .not
        .toBe('healthy')

      const offlined = await fixtureDisk(ctx)
      // The context the inventory carried for NO non-data class before slice 1.
      expect(offlined.poolName).toBe(POOL)
      expect(offlined.vdevRole).toBe('log')
      expect(offlined.vdevName).toBe('logs')
      expect(offlined.zfsErrors).not.toBeNull()
      // An OFFLINE member is not ONLINE: the Disk schema folds the vdev state
      // into healthStatus, and OFFLINE lands on 'warning'.
      expect(offlined.healthStatus).toBe('warning')

      // The node agrees the pool is degraded, and so does the dashboard.
      expect(await sshExec(`zpool list -H -o health ${POOL}`)).toBe('DEGRADED')
      const warnings = await dashboardWarnings(ctx)
      expect(
        warnings.some(w => w.category === 'pool' && w.ref === POOL && w.message.includes('DEGRADED')),
        `a degraded-pool warning for ${POOL}: ${JSON.stringify(warnings)}`,
      ).toBe(true)
      expect(
        warnings.some(w => w.category === 'disk' && w.ref === BY_ID),
        `a disk warning for ${BY_ID}: ${JSON.stringify(warnings)}`,
      ).toBe(true)

      // Back online: the pool recovers and the row returns to the special
      // context it carries when nothing is wrong.
      await sshExec(`zpool online ${POOL} ${logLeaf}`)
      await expect.poll(async () => sshExec(`zpool list -H -o health ${POOL}`), { timeout: 60_000 })
        .toBe('ONLINE')
      await expect.poll(async () => (await fixtureDisk(ctx)).healthStatus, { timeout: 30_000 })
        .toBe('healthy')
      expect((await fixtureDisk(ctx)).vdevRole).toBe('special')
    }
    finally {
      await ctx.dispose()
    }
  })

  // -----------------------------------------------------------------------
  // (b) the Expand / Replace dialog offers the special leaf
  // -----------------------------------------------------------------------
  test.describe('UI', () => {
    // Wide viewport: the Pools toolbar carries several labelled buttons and at
    // the default 1280px the tail of them collapses into ExtJS's overflow menu.
    test.use({ viewport: { width: 2560, height: 1080 } })

    test('the replace surface lists the special leaf as a replaceable member', async ({ page }) => {
      const specialLeaf = await partitionKernelName(5)

      await loginToPve(page)
      await openAnasItem(page, 'Pools')

      const grid = page.locator('.anas-grid-pools')
      await expect(grid).toBeVisible({ timeout: 45_000 })
      await grid.locator('.x-grid-row', { hasText: POOL }).click()

      const expandBtn = page.locator('.anas-btn-pool-expand')
      await expect(expandBtn).toBeEnabled({ timeout: 20_000 })
      await expandBtn.click()

      const win = page.locator('.anas-win-pool-expand')
      await expect(win).toBeVisible({ timeout: 20_000 })

      // Replace mode: the pool's members become drop slots.
      await win.locator('input[name="pex-mode"][value="replace"]').check()
      const members = win.locator('.anas-grid-pex-rep')
      await expect(members.first()).toBeVisible({ timeout: 20_000 })

      // The special leaf is one of them, named with the vdev it belongs to —
      // the disk that cannot be replaced from the UI is the one that loses the
      // pool when it dies.
      await expect(win).toContainText(specialLeaf, { timeout: 20_000 })
      await expect(win).toContainText('special · ONLINE', { timeout: 20_000 })
      // …and every other class is there beside it.
      for (const n of [1, 2, 3, 4, 6]) {
        const leaf = await partitionKernelName(n)
        await expect(win).toContainText(leaf, { timeout: 20_000 })
      }
    })
  })

  // -----------------------------------------------------------------------
  // (c) destroy with cleanup clears the labels of EVERY class's partition
  // -----------------------------------------------------------------------
  test('destroy with cleanup labelclears all six partitions and frees the disk', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const parts: string[] = []
      for (let n = 1; n <= 6; n++)
        parts.push(`/dev/disk/by-id/${BY_ID}-part${n}`)

      // The confirm-code flow: 409 with the code, then the same request
      // carrying it. `cleanup=true` is the disk-hygiene opt-in.
      const challenge = await ctx.delete(`${V1}/pools/${POOL}?cleanup=true`)
      expect(challenge.status()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      expect((await challenge.json()).error.code).toBe('CONFIRMATION_REQUIRED')

      const confirmed = await ctx.delete(`${V1}/pools/${POOL}?cleanup=true`, {
        headers: { 'x-anas-confirm': code },
      })
      expect(confirmed.status()).toBe(202)
      const job = await awaitJob(ctx, (await confirmed.json()).job.id, 120_000)
      expect(job.status, JSON.stringify(job.error ?? '')).toBe('completed')

      // The node's own verdict, per partition: no ZFS label left anywhere.
      // GROUND TRUTH (ZFS 2.4.4): `zpool labelclear` has no read-only `-c`
      // ("invalid option 'c'"), so the non-destructive check is `wipefs` with
      // no `-a` — it lists a labelled partition's four `zfs_member` signatures
      // and says nothing about a clean one. The cleanup also zaps the GPT when
      // the disk is exclusively the pool's, so a partition may be gone
      // entirely; either way it carries no label.
      for (const part of parts) {
        const sigs = await sshExec(`if [ -e ${part} ]; then wipefs -n ${part} 2>&1 || true; else echo GONE; fi`)
        expect(sigs, `${part} carries no ZFS label`).not.toMatch(/zfs_member/)
      }
      // …and neither does the whole disk.
      const wholeDisk = await sshExec(`wipefs -n /dev/disk/by-id/${BY_ID} 2>&1 || true`)
      expect(wholeDisk, `${BY_ID} is blank`).not.toMatch(/zfs_member/)

      // And the inventory agrees the whole disk is free again.
      await expect.poll(async () => (await fixtureDisk(ctx)).status, { timeout: 30_000 })
        .toBe('available')
      const freed = await fixtureDisk(ctx)
      expect(freed.poolName).toBeNull()
      expect(freed.vdevRole).toBeNull()
    }
    finally {
      await ctx.dispose()
    }
  })
})
