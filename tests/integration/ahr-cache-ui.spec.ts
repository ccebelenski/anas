import type { APIRequestContext, Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story ahrcache.1 slice 3 — the UI leg, WRITTEN NOT RUN (the stunt node is
 * held). Modelled on ahr-cache-api.spec.ts (slice 1, live-proven) and
 * pool-composer.spec.ts's pointer-drag helper.
 *
 * Runs over test/stunt-node/ahrcache-fixture.sh (disks 7/8/9; pool `gtcache`
 * is NOT built by the fixture — creating it any way but the daemon's own API
 * would dodge the code under proof, so each test builds and tears down the
 * pool through POST/DELETE /v1/ahr and does the cache verbs THROUGH THE UI).
 *
 * Contracts under test (EPICS ahrcache.1 Workflow):
 *   - Attach cache… opens the composable-disk picker with the two-sentence
 *     advisory; the rotating pick earns its one sentence (the stunt node's
 *     virtual disks all report rotational — the API spec proved the advisory
 *     rides the job result, so the dialog note is assertable here too)
 *   - the Cache block in the pool detail shows the device by its FULL by-id,
 *     the size with its unit, and the healthy counters
 *   - Detach cache's confirm names the trade in the story's words; afterwards
 *     the block reads "no cache" and the Disks tab reads the disk Available
 *   - a refused attach (the disk became in-use while the dialog stood open —
 *     staged through the API, the race a dialog cannot prevent) surfaces the
 *     daemon's own sentence in the failure modal, never a bare "failed"
 *   - toolbar overflow rule as pvepool.2: runs at 2560×1080 — the AHR toolbar
 *     grew two labelled buttons and clicks in ExtJS's overflow menu would be
 *     invisible to the specs
 *
 * The cache-device FAILURE presentation (the red line in the Cache block, the
 * dashboard's CRITICAL card) needs slice 2's udev rung to stage honestly — a
 * yanked disk without the event would leave the block describing a state the
 * product never serves. It is proved on the unit level (dialog-contracts
 * harness, the GT-19 sentence) and joins the live proof with slice 2.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtcache'
const BAND_SERIALS = ['ANAS_HOT7', 'ANAS_HOT8']
const CACHE_SERIAL = 'ANAS_HOT9'
const BY_ID = (serial: string): string => `scsi-0QEMU_QEMU_HARDDISK_${serial}`
const CACHE_ID = BY_ID(CACHE_SERIAL)

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/ahrcache-fixture.sh', import.meta.url).pathname

/** The three virtual disks the fixture owns — nothing else is touched. */
async function disksPresent(): Promise<boolean> {
  for (const serial of [...BAND_SERIALS, CACHE_SERIAL]) {
    const there = await sshExec(`test -e /dev/disk/by-id/${BY_ID(serial)} && echo yes || echo no`)
    if (there !== 'yes')
      return false
  }
  return true
}

test.beforeEach(async () => {
  test.skip(!(await disksPresent()), 'ahrcache fixture not present — run test/stunt-node/ahrcache-fixture.sh up')
})

// Wide viewport: the AHR toolbar carries ~15 labelled buttons and at the
// default 1280px the tail of them (the cache verbs among them) collapses
// into ExtJS's overflow menu — clicks there would be invisible to the specs.
test.use({ viewport: { width: 2560, height: 1080 } })

interface PoolDetail {
  state: string
  cache?: { state: 'healthy' | 'failed' | 'absent', devices: string[] }
}

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
): Promise<{ status: string, error?: { message?: string } }> {
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

/** 409 confirm challenge → resend with the code → job must complete. */
async function runConfirmedJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
): Promise<void> {
  const challenge = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(challenge.status(), await challenge.text()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  const run = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    headers: { 'x-anas-confirm': code },
  })
  expect(run.status(), await run.text()).toBe(202)
  const job = await awaitJob(ctx, (await run.json()).job.id, 300_000)
  expect(job.status, JSON.stringify(job.error)).toBe('completed')
}

async function poolDetail(ctx: APIRequestContext): Promise<PoolDetail> {
  const res = await ctx.get(`${V1}/ahr/${POOL}`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data as PoolDetail
}

/** Build the one-band pool through the daemon's own API; fail if it exists. */
async function buildPool(ctx: APIRequestContext): Promise<void> {
  const inventory = await ctx.get(`${V1}/disks`)
  const disks = (await inventory.json()).data as { id: string, status: string }[]
  const bandIds = BAND_SERIALS.map((serial) => {
    const disk = disks.find(d => d.id === BY_ID(serial))
    expect(disk, `disk ${serial} in /v1/disks`).toBeTruthy()
    return disk!.id
  })
  await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })
  expect((await poolDetail(ctx)).cache?.state).toBe('absent')
}

/** Destroy the pool through the daemon's own API (also releases the cache). */
async function destroyPool(ctx: APIRequestContext): Promise<void> {
  await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`).catch(() => {})
}

/** Open Hybrid RAID and return the pools grid. */
async function openAhrGrid(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Hybrid RAID')
  const grid = page.locator('.anas-grid-ahr')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  return grid
}

/** The pools-grid row for one pool name. */
function poolRow(page: Page, grid: Locator, name: string): Locator {
  return grid.locator('.x-grid-row', { hasText: name }).first()
}

/**
 * Drive the toolbar's native pointer-drag (pool-composer.spec.ts's helper):
 * pick up the disk card, move over the bay in steps so pointermove +
 * elementFromPoint run, then drop. Playwright's dragTo dispatches HTML5 DnD,
 * which the pointer-based helper ignores.
 */
async function dragDiskIntoBay(page: Page, diskSel: string, baySel: string): Promise<void> {
  const disk = page.locator(diskSel).first()
  await expect(disk).toBeVisible({ timeout: 20_000 })
  const bay = page.locator(baySel).first()
  await expect(bay).toBeVisible({ timeout: 20_000 })
  const box = await disk.boundingBox()
  const bayBox = await bay.boundingBox()
  if (!box || !bayBox)
    throw new Error('could not resolve drag geometry')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20, { steps: 4 })
  await page.mouse.move(bayBox.x + bayBox.width / 2, bayBox.y + bayBox.height / 2, { steps: 8 })
  await page.mouse.up()
}

/** The on-demand Details window's body, opened from a selected row. */
async function openDetail(page: Page, grid: Locator, name: string): Promise<Locator> {
  await poolRow(page, grid, name).click()
  await grid.locator('.anas-btn-ahr-details').click()
  const win = page.locator('.anas-win-ahr-detail')
  await expect(win).toBeVisible({ timeout: 30_000 })
  const body = win.locator('.anas-ahr-detail-body')
  await expect(body).toBeVisible({ timeout: 30_000 })
  // Wait for the pull to land (Loading… gone) — the counters refresh with
  // the detail load, never a cache of an earlier one.
  await expect(body).not.toContainText('Loading…', { timeout: 30_000 })
  return body
}

test.describe('AHR read cache — the UI (ahrcache.1 slice 3)', () => {
  test.setTimeout(900_000)

  test.afterAll(async () => {
    // Leave the node as found. Both tests destroy the pool through the API;
    // this is the safety net for a run that died partway.
    await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
    await execFileAsync(FIXTURE_SH, ['up']).catch(() => {})
  })

  test('attach through the dialog → Cache block → detach through the confirm → disk back', async ({ page, playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    await buildPool(ctx)
    try {
      const grid = await openAhrGrid(page)
      const row = poolRow(page, grid, POOL)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await row.click()

      // ---- Toolbar gating on an uncached pool ---------------------------
      const attachBtn = grid.locator('.anas-btn-ahr-cache-attach')
      const detachBtn = grid.locator('.anas-btn-ahr-cache-detach')
      await expect(attachBtn).toBeEnabled({ timeout: 20_000 })
      await expect(detachBtn).toBeDisabled()

      // ---- The dialog: advisory, picker, rotating note -------------------
      await attachBtn.click()
      const dlg = page.locator('.anas-win-ahr-cache-attach')
      await expect(dlg).toBeVisible({ timeout: 30_000 })
      // The two-sentence advisory, verbatim in substance.
      await expect(dlg).toContainText('repeated random reads')
      await expect(dlg).toContainText('sequential streams do not benefit')
      await expect(dlg).toContainText('The SSD is a consumable')
      // The cache disk is offered in the tray by its full by-id.
      const card = dlg.locator(`[data-id="${CACHE_ID}"]`)
      await expect(card).toBeVisible({ timeout: 20_000 })
      await dragDiskIntoBay(page, `.anas-win-ahr-cache-attach [data-id="${CACHE_ID}"]`, '.anas-win-ahr-cache-attach [data-anas-zone="bay:cache"]')
      // The stunt node's virtual disks report rotational — the one sentence
      // a spinning pick earns appears (and only that: no argument).
      await expect(dlg).toContainText('a rotating cache adds a seek, not speed')

      // ---- Submit: the job, then the Cache block -------------------------
      await dlg.locator('.anas-btn-ahr-cache-attach-exec').click()
      await expect(dlg).not.toBeVisible({ timeout: 20_000 })
      // The job runs through the daemon; the block's counters refresh with
      // the detail load (the pull), so poll the API for the healthy state
      // and then read it off the UI.
      const deadline = Date.now() + 180_000
      for (;;) {
        const detail = await poolDetail(ctx)
        if (detail.cache?.state === 'healthy')
          break
        if (Date.now() > deadline)
          throw new Error(`cache still '${detail.cache?.state}' after 180s`)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      const body = await openDetail(page, grid, POOL)
      await expect(body).toContainText(CACHE_ID)
      await expect(body).toContainText('MiB')
      await expect(body).toContainText('writethrough')
      await expect(body).toContainText('smq')
      await expect(body).toContainText('Hits / misses (hit ratio)')

      // ---- Toolbar flipped -----------------------------------------------
      await expect(attachBtn).toBeDisabled()
      await expect(detachBtn).toBeEnabled({ timeout: 20_000 })

      // ---- Detach through the confirm ------------------------------------
      await detachBtn.click()
      const confirm = page.locator('.x-message-box:visible')
      await expect(confirm).toBeVisible({ timeout: 20_000 })
      await expect(confirm).toContainText('reads continue from the pool')
      await expect(confirm).toContainText('the SSD is wiped and returns to available')
      await expect(confirm).toContainText(CACHE_ID)
      await confirm.getByRole('button', { name: 'Yes' }).click()

      // The block reads "no cache" once the job lands.
      const detachDeadline = Date.now() + 180_000
      for (;;) {
        const detail = await poolDetail(ctx)
        if (detail.cache?.state === 'absent')
          break
        if (Date.now() > detachDeadline)
          throw new Error('cache still present after 180s')
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      const bodyAfter = await openDetail(page, grid, POOL)
      await expect(bodyAfter).toContainText('no cache')
      await expect(bodyAfter).not.toContainText(CACHE_ID)

      // ---- The Disks tab: the disk reads Available again ------------------
      await openAnasItem(page, 'Disks')
      const disksGrid = page.locator('.anas-grid-disks')
      await expect(disksGrid).toBeVisible({ timeout: 45_000 })
      const diskRowEl = disksGrid.locator('.x-grid-row', { hasText: CACHE_ID }).first()
      await expect(diskRowEl).toBeVisible({ timeout: 30_000 })
      // GT-22 held the OTHER direction while the slice existed; with it gone
      // the disk is genuinely blank inventory again.
      await expect(diskRowEl).toContainText('Available', { timeout: 30_000 })
    }
    finally {
      await destroyPool(ctx)
    }
  })

  test('a refused attach (the disk became in-use under the dialog) shows the sentence', async ({ page, playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    await buildPool(ctx)
    try {
      const grid = await openAhrGrid(page)
      const row = poolRow(page, grid, POOL)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await row.click()
      await grid.locator('.anas-btn-ahr-cache-attach').click()
      const dlg = page.locator('.anas-win-ahr-cache-attach')
      await expect(dlg).toBeVisible({ timeout: 30_000 })

      // The race a dialog cannot prevent: the disk is offered when the
      // picker opened, and in use by the time the submit lands. Stage the
      // "in use" half through the API — the SAME verb, the one code path.
      const challenge = await ctx.post(`${V1}/ahr/${POOL}/cache`, { data: { disks: [CACHE_ID] } })
      expect(challenge.status(), await challenge.text()).toBe(202)
      const job = await awaitJob(ctx, (await challenge.json()).job.id)
      expect(job.status, JSON.stringify(job.error)).toBe('completed')

      await dragDiskIntoBay(page, `.anas-win-ahr-cache-attach [data-id="${CACHE_ID}"]`, '.anas-win-ahr-cache-attach [data-anas-zone="bay:cache"]')
      await dlg.locator('.anas-btn-ahr-cache-attach-exec').click()

      // The daemon's own refusal sentence reaches the user under the verb's
      // fail title — never a bare "failed". The POOL is what changed under
      // the dialog, not just the disk, so the ALREADY-CACHED guard answers
      // first (ahr-cache.ts checks the pool's cache before it ever looks at
      // the requested disks) — that is the sentence the user sees.
      const modal = page.locator('.x-message-box:visible')
      await expect(modal).toBeVisible({ timeout: 30_000 })
      await expect(modal).toContainText('Attach cache failed')
      await expect(modal).toContainText('already has a read cache')
      await expect(modal).toContainText(CACHE_ID)
      await modal.getByRole('button', { name: 'OK' }).click()
    }
    finally {
      await destroyPool(ctx)
    }
  })
})
