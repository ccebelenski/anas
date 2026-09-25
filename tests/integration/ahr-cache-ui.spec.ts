import type { APIRequestContext, Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story ahrcache.1 slice 3 — the UI leg, LIVE-PROVEN on the stunt node
 * 2026-09-25 (two consecutive green runs, 3 passed each). Modelled on
 * ahr-cache-api.spec.ts (slice 1 + 2, live-proven) and pool-composer.spec.ts's
 * pointer-drag helper.
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
 *   - Remount is offered ONLY on a pool whose `mountedReadOnly` field is true,
 *     its confirm carries the daemon's own open-handle warning, and the job
 *     restores writes and takes the verb back off the toolbar (the third test,
 *     added by the live proof — see its own header for the GT-27 staging)
 *   - toolbar overflow rule as pvepool.2: runs at 2560×1080 — the AHR toolbar
 *     grew two labelled buttons and clicks in ExtJS's overflow menu would be
 *     invisible to the specs
 *
 * The cache-device FAILURE presentation (the red line in the Cache block, the
 * dashboard's CRITICAL card) needs slice 2's udev rung to stage honestly — a
 * yanked disk without the event would leave the block describing a state the
 * product never serves. It is proved on the unit level (dialog-contracts
 * harness, the GT-19 sentence) and on the wire by the API spec's slice-2 test;
 * the Remount test below stages the same yank and drives the aftermath.
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
  /** slice 2 — the narrow field the Remount verb is gated on. */
  mountedReadOnly?: boolean
  cache?: { state: 'healthy' | 'failed' | 'absent', devices: string[] }
}

/** The pool's mountpoint on the node — the Remount test writes into it. */
const MOUNT = `/mnt/anas-ahr/${POOL}`

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

/** Poll the pool payload until `ok` holds, or fail naming what was awaited. */
async function untilPool(
  ctx: APIRequestContext,
  ok: (p: PoolDetail) => boolean,
  timeout: number,
  what: string,
): Promise<PoolDetail> {
  const deadline = Date.now() + timeout
  let last: PoolDetail | undefined
  for (;;) {
    last = await poolDetail(ctx)
    if (ok(last))
      return last
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeout}ms waiting for ${what}: ${JSON.stringify(last)}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
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

  /**
   * Slice 2's UI leg — the Remount verb, added by the live proof (2026-09-25).
   *
   * The button is gated on `mountedReadOnly`, a FIELD and not the state badge
   * (§13), so the only honest way to see it is to take the pool read-only for
   * real. GT-27 is what makes that stageable: a streaming write only meets a
   * dead writethrough cache on the transaction COMMIT, so the write loop
   * carries a `sync` and has to already be in flight when the disk dies — a
   * write issued after the udev rung has uncached meets a plain linear volume
   * and succeeds. The same recipe the API spec proved, minus its reader loop:
   * that loop existed to MEASURE the recovery, which is not this test's claim.
   *
   * GT-27 also says a read-mostly pool can lose its cache and never go
   * read-only at all, so this test does not assume it — it asserts the button
   * is absent before the yank, waits for `mountedReadOnly` with the write loop
   * driving commits, and fails naming what it waited for if the window closed.
   *
   * The cache is attached through the API here: the UI attach is the first
   * test's business, and repeating it would only lengthen the staging.
   */
  test('Remount is offered only when the pool is read-only, and restores writes', async ({ page, playwright, pveTicket }) => {
    const WRITE_LOG = '/tmp/anas-cache-ui-write.log'
    const WRITE_STOP = '/tmp/anas-cache-ui-write.stop'
    const ctx = await authedContext(playwright, pveTicket)
    await buildPool(ctx)
    try {
      // ---- A live, warm cache ---------------------------------------------
      const attach = await ctx.post(`${V1}/ahr/${POOL}/cache`, { data: { disks: [CACHE_ID] } })
      expect(attach.status(), await attach.text()).toBe(202)
      const attachJob = await awaitJob(ctx, (await attach.json()).job.id)
      expect(attachJob.status, JSON.stringify(attachJob.error)).toBe('completed')
      await sshExec(`cd ${MOUNT} && for i in $(seq 1 32); do dd if=/dev/urandom of=f$i.bin bs=1M count=4 status=none; done && sync`)
      for (let pass = 0; pass < 4; pass++)
        await sshExec(`echo 3 > /proc/sys/vm/drop_caches && cat ${MOUNT}/f*.bin > /dev/null`)
      const warm = await poolDetail(ctx)
      expect(warm.cache?.state).toBe('healthy')
      expect(warm.mountedReadOnly).toBe(false)

      // ---- A writable pool does not offer Remount --------------------------
      const grid = await openAhrGrid(page)
      await poolRow(page, grid, POOL).click()
      const remountBtn = grid.locator('.anas-btn-ahr-remount')
      await expect(remountBtn).toBeHidden()

      // ---- The write loop, in flight BEFORE the yank (GT-27) ---------------
      await sshExec(
        `rm -f ${WRITE_LOG} ${WRITE_STOP}; setsid bash -c 'until [ -f ${WRITE_STOP} ]; do `
        + `dd if=/dev/urandom of=${MOUNT}/write.bin bs=1M count=1 oflag=direct status=none 2>/dev/null; rc=$?; sync 2>/dev/null; `
        + `echo "$(date -Is) rc=$rc" >> ${WRITE_LOG}; sleep 0.1; done' >/dev/null 2>&1 &`,
      )
      await execFileAsync(FIXTURE_SH, ['pull-cache'])

      // The udev rung uncaches unattended; the commit that met the dead cache
      // forces btrfs read-only, and THAT is what the verb exists for.
      await untilPool(ctx, p => p.cache?.state === 'absent', 60_000, 'the udev rung to uncache the pool')
      const ro = await untilPool(ctx, p => p.mountedReadOnly === true, 60_000, 'btrfs to force the filesystem read-only')
      expect(ro.cache?.state).toBe('absent')
      const writeLog = await sshExec(`cat ${WRITE_LOG}`)
      expect(writeLog, 'the write loop wrote cleanly before the yank').toContain('rc=0')
      expect(writeLog, 'and met the error once the cache was gone').toContain('rc=1')

      // Nothing of ours may hold the mount when Remount umounts it. The `[.]`
      // keeps the pattern off the pkill shell's own command line (the API
      // spec's lesson — a bare pattern kills the shell on its first statement).
      await sshExec(`touch ${WRITE_STOP}; sleep 0.5`)
      await sshExec(`pkill -f 'anas-cache-ui-write[.]stop' || true`)

      // ---- The verb appears, and its confirm names the break ---------------
      // Reload, then re-select: an ExtJS store reload drops the selection, and
      // the toolbar is gated on the SELECTED record. Wrapped in toPass because
      // the click can land mid-reload on a row the store is about to replace.
      await grid.locator('.anas-btn-ahr-refresh').click()
      await expect(async () => {
        await poolRow(page, grid, POOL).click()
        await expect(remountBtn).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 60_000 })
      await expect(remountBtn).toBeEnabled()
      await remountBtn.click()
      const confirm = page.locator('.x-message-box:visible')
      await expect(confirm).toBeVisible({ timeout: 30_000 })
      await expect(confirm).toContainText('unmounts and mounts its filesystem')
      // The daemon's own 409 warning rides the confirm window, mountpoint and
      // all — the UI never paraphrases it.
      await expect(confirm).toContainText('Open share handles break')
      await expect(confirm).toContainText(MOUNT)
      await confirm.getByRole('button', { name: 'Yes' }).click()

      // ---- Writes are back, and the verb leaves the toolbar ----------------
      const writable = await untilPool(ctx, p => p.mountedReadOnly === false, 180_000, 'the remount to restore writes')
      expect(writable.state).toBe('healthy')
      // GT-20's negative from the other side: `remount,rw` is refused after an
      // error, so only umount + mount could have produced this.
      expect(await sshExec(`dd if=/dev/urandom of=${MOUNT}/proof.bin bs=1M count=1 status=none && echo ok`)).toBe('ok')
      await grid.locator('.anas-btn-ahr-refresh').click()
      await expect(async () => {
        await poolRow(page, grid, POOL).click()
        await expect(remountBtn).toBeHidden({ timeout: 2_000 })
      }).toPass({ timeout: 60_000 })
    }
    finally {
      // The loop may never outlive the test: if a step above threw before the
      // marker was written, this is the only thing that stops it.
      await sshExec(`touch ${WRITE_STOP}; pkill -f 'anas-cache-ui-write[.]stop' || true; rm -f ${WRITE_STOP} ${WRITE_LOG}`)
        .catch(() => {})
      // Hand the disk back before the teardown so destroy wipes the leftover
      // <pool>-cache<n> slice it carries, rather than leaving it on the image.
      await execFileAsync(FIXTURE_SH, ['return-cache']).catch(() => {})
      await destroyPool(ctx)
    }
  })
})
