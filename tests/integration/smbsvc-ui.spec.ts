import type { APIRequestContext, Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import {
  datasetExists,
  removeShareUser,
  removeSmbShare,
  skipIfFixtureMissing,
  sshExec,
} from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story smbsvc.1 (Previous Versions on SMB shares) — UI ACCEPTANCE over the
 * real PVE UI on the stunt node, driven through the smbsvc fixture
 * (test/stunt-node/smbsvc-fixture.sh up). Companion to smbsvc-api.spec.ts
 * (which proves the daemon halves); this file exercises the Shares panel's
 * Self-service fieldset in packages/pve-integration/src/70-shares.js the way a
 * user meets it, per DESIGN.md "Self-service on SMB shares" → Workflow:
 *
 *   1. Create an SMB share through the dialog — the Self-service fieldset is
 *      there with Previous Versions unticked and NO note (nothing to say about
 *      a feature that is off).
 *   2. Edit → tick Previous Versions → the fresh-enable note ("stays empty
 *      until a schedule on this dataset runs") → OK → job completes → grid
 *      reloads → Detail shows "on — daily schedule" (no schedule targets the
 *      dataset ⇒ the design's fallback bucket).
 *   3. Untouched edit → the PUT body carries NO `previousVersions` key
 *      (§2 three-valued contract: omitted = keep) and the share's stanza in
 *      smb.conf round-trips byte-identically.
 *   4. Untick → OK → Detail shows "off"; the stanza has no shadow: keys.
 *   5. A hand-made `vfs objects` line (injected via ssh, smbd reloaded) greys
 *      the row with the custom-line reason; removed again afterwards.
 *   6. A failed save (PUT intercepted → 400 with a sentence) shows the failure
 *      alert AND still reloads the grid — the share row survives.
 *
 * Every test leaves the node as found: the share and the share user are
 * removed through their own API doors, and the fixture is torn down in
 * afterAll. Runs at 2560×1080 (same reason as pvepool-ui.spec.ts — the Shares
 * toolbar overflows below ~1300px and clicks in the overflow menu are
 * invisible to the spec).
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const DATASET = 'gtbackup/pvshare'
const SHARE_PATH = '/gtbackup/pvshare'
const SHARE = 'pvshare'
const SHARE_USER = 'smbsvc_ui'
const SHARE_PW = 'anas-ui-proof'

// Exact strings from 70-shares.js (the dialog is the contract surface).
const PV_NOTE_FRESH_ENABLE = 'Previous Versions will expose this share\'s finest '
  + 'snapshot schedule; it stays empty until a schedule on this dataset runs '
  + '(Snapshots menu)'
const PV_GREY_REASON = 'this share has a custom vfs objects line — remove it first'
const DETAIL_ON_DAILY = 'Previous Versions: on — daily schedule'
const DETAIL_OFF = 'Previous Versions: off'
// The intercepted-400 sentence test 6 hands the dialog's alert (daemon-shaped).
const FAIL_SENTENCE = 'testparm rejected the new configuration: '
  + `share '${SHARE}' has an invalid parameter 'invalid thing'`

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/smbsvc-fixture.sh', import.meta.url).pathname

// ---- API helpers (request contexts carrying the PVE cookie) ----------------

function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: {
      cookies: [{
        name: 'PVEAuthCookie',
        value: ticket,
        domain: new URL(PVE_URL).hostname,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      }],
      origins: [],
    },
  })
}

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 90_000,
): Promise<{ status: string, error?: string, [k: string]: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${job.error ?? job.progress ?? ''}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Submit a mutation, wait for its job, and require it to complete. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id)
  expect(job.status, job.error).toBe('completed')
}

/** Drive the standard 409-challenge → confirm → 202 share-removal flow. */
async function removeShareViaApi(ctx: APIRequestContext, name: string): Promise<void> {
  const challenge = await ctx.delete(`${V1}/shares/smb/${name}`)
  if (challenge.status() === 404)
    return
  expect(challenge.status()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  await runJob(ctx, 'delete', `${V1}/shares/smb/${name}`, undefined, { 'x-anas-confirm': code })
}

// ---- Node-side helpers (source of truth) -----------------------------------

/**
 * The share's stanza exactly as it stands in /etc/samba/smb.conf on the node —
 * the section header line through the last line before the next section (or
 * EOF, trailing newlines stripped). Shipped base64-encoded so no quoting
 * survives the trip through ssh.
 */
async function shareStanza(name: string): Promise<string> {
  const py = [
    `import re`,
    `s = open('/etc/samba/smb.conf').read()`,
    `m = re.search(r'(?ms)^\\[${name}\\].*?(?=^\\[|\\Z)', s)`,
    `print(m.group(0).rstrip('\\n') if m else '')`,
  ].join('\n')
  const b64 = Buffer.from(py, 'utf8').toString('base64')
  return sshExec(`echo ${b64} | base64 -d | python3`)
}

// ---- UI helpers --------------------------------------------------------------

/** Select the node, open Shares, wait for the grid to render. */
async function openShares(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Shares')
  const grid = page.locator('.anas-grid-shares')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  return grid
}

/**
 * The grid row for share `name` — scoped to the NAME cell (exact match) so the
 * Path column's '/gtbackup/pvshare' or another share named 'pvshare-ish' can
 * never match; the row is the ancestor .x-grid-row of that cell.
 */
function shareRow(page: Page, grid: Locator, name: string): Locator {
  return grid
    .locator('.x-grid-row', {
      has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${name}$`) }),
    })
    .first()
}

/** Count the grid's SMB list fetches — the reload-on-every-job observable. */
async function trackSharesFetches(page: Page): Promise<{ count: () => number }> {
  const state = { n: 0 }
  await page.route(/\/v1\/shares\/smb$/, async (route) => {
    state.n += 1
    await route.continue()
  })
  return { count: () => state.n }
}

function pvBox(win: Locator): Locator {
  return win.locator('.anas-fld-smb-previous-versions')
}

function pvNote(win: Locator): Locator {
  return win.locator('.anas-fld-smb-previous-versions-note')
}

/** Tick / untick the Previous Versions checkbox in the open dialog. */
async function setPvCheckbox(win: Locator, check: boolean): Promise<void> {
  const input = pvBox(win).locator('input').first()
  const checked = await input.evaluate(el => (el as HTMLInputElement).checked)
  if (checked !== check)
    await input.click()
}

// ---- Fixtures ---------------------------------------------------------------

test.beforeEach(async () => {
  // Self-heal like smbsvc-api.spec.ts: a failed test ends the worker and its
  // afterAll tears the fixture down; the next worker re-ups it here.
  if (!(await datasetExists(DATASET)))
    await execFileAsync(FIXTURE_SH, ['up']).catch(() => {})
  skipIfFixtureMissing(!(await datasetExists(DATASET)), 'smbsvc fixture not present — run test/stunt-node/smbsvc-fixture.sh up')
})

test.describe('smbsvc.1 — Self-service on SMB shares (stunt node UI)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(150_000)

  test.beforeAll(async ({ playwright }) => {
    // Leave-no-trace pre-clean, then the share user through the identity API
    // (the same door the Shares UI drives), so the node is as the API spec
    // left it: fixture up, no [pvshare] stanza, no leftover share user.
    await removeSmbShare(SHARE).catch(() => {})
    await removeShareUser(SHARE_USER).catch(() => {})

    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    expect(ticketRes.ok()).toBeTruthy()
    const ticket = (await ticketRes.json()).data.ticket as string
    await login.dispose()
    const ctx = await authedContext(playwright, ticket)
    try {
      await runJob(ctx, 'post', `${V1}/identity/users`, { name: SHARE_USER, smbPassword: SHARE_PW })
    }
    finally {
      await ctx.dispose()
    }
  })

  test.afterAll(async ({ playwright }) => {
    // Leave the node as found: the share through its confirm flow (with an
    // ssh safety net), the user through the identity API (with the same
    // net), finally the fixture down. All best-effort — an afterAll failure
    // must not mask the run's results.
    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    const ticket = ticketRes.ok() ? ((await ticketRes.json()).data.ticket as string) : null
    await login.dispose()
    const ctx = ticket ? await authedContext(playwright, ticket) : null
    try {
      if (ctx) {
        try {
          await removeShareViaApi(ctx, SHARE)
        }
        catch {
          await removeSmbShare(SHARE).catch(() => {})
        }
        try {
          const challenge = await ctx.delete(`${V1}/identity/users/${SHARE_USER}`)
          const code = challenge.headers()['x-anas-confirm-code']
          if (challenge.status() === 409 && code)
            await runJob(ctx, 'delete', `${V1}/identity/users/${SHARE_USER}`, undefined, { 'x-anas-confirm': code })
        }
        catch { /* best-effort */ }
      }
    }
    finally {
      if (ctx)
        await ctx.dispose()
      await removeSmbShare(SHARE).catch(() => {})
      await removeShareUser(SHARE_USER).catch(() => {})
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
    }
  })

  test('1 — create through the dialog: Self-service fieldset, Previous Versions unticked, no note', async ({ page }) => {
    await openShares(page)
    const grid = page.locator('.anas-grid-shares')

    await page.locator('.anas-btn-smb-add').click()
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // The fieldset with its title, the unticked box, and NO note — an
    // unticked feature has nothing to say yet.
    const fieldset = win.locator('.anas-fld-smb-self-service')
    await expect(fieldset).toBeVisible({ timeout: 20_000 })
    await expect(fieldset.locator('.x-fieldset-header', { hasText: 'Self-service' })).toBeVisible()
    await expect(pvBox(win)).toBeVisible()
    expect(await pvBox(win).locator('input').first().evaluate(el => (el as HTMLInputElement).checked)).toBe(false)
    await expect(pvNote(win)).toBeHidden()

    await win.locator('.anas-fld-smb-name input[type="text"]').fill(SHARE)
    await win.locator('.anas-fld-smb-path input[type="text"]').fill(SHARE_PATH)
    await win.locator('.anas-btn-smb-share-submit').click()

    // The job completes, the dialog closes, the grid reloads with the row.
    await expect(win).toBeHidden({ timeout: 60_000 })
    await expect(shareRow(page, grid, SHARE)).toBeVisible({ timeout: 45_000 })
  })

  test('2 — edit: tick → the empty-until-a-schedule-runs note → detail reads "on — daily schedule"', async ({ page }) => {
    const fetches = await trackSharesFetches(page)
    await openShares(page)
    const grid = page.locator('.anas-grid-shares')
    const before = fetches.count()

    await shareRow(page, grid, SHARE).click()
    await page.locator('.anas-btn-share-edit').click()
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // No schedule exists on the dataset: tick → the design's fresh-enable
    // note, NOT a bucket sentence (the daemon picks the bucket, the dialog
    // only ever displays it).
    await setPvCheckbox(win, true)
    await expect(pvNote(win)).toBeVisible({ timeout: 20_000 })
    await expect(pvNote(win)).toHaveText(PV_NOTE_FRESH_ENABLE)

    await win.locator('.anas-btn-smb-share-submit').click()
    await expect(win).toBeHidden({ timeout: 60_000 })

    // The grid reloads after the job (onDone) BEFORE the record carries the
    // bucket — wait for that reload, then open Detail from the fresh row.
    await expect.poll(() => fetches.count(), { timeout: 45_000 }).toBeGreaterThan(before)

    await shareRow(page, grid, SHARE).click()
    await page.locator('.anas-btn-share-details').click()
    const detail = page.locator('.anas-win-share-details')
    await expect(detail).toBeVisible({ timeout: 20_000 })
    await expect(detail).toContainText(DETAIL_ON_DAILY)
  })

  test('3 — untouched edit: the PUT body carries no previousVersions key and the stanza round-trips byte-identically', async ({ page }) => {
    const stanzaBefore = await shareStanza(SHARE)
    expect(stanzaBefore).toContain(`path = ${SHARE_PATH}`)

    // Record the PUT body, then let the request through untouched.
    let putBody: Record<string, unknown> | null = null
    await page.route(/\/v1\/shares\/smb\/pvshare$/, async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON() as Record<string, unknown>
      }
      await route.continue()
    })

    await openShares(page)
    const grid = page.locator('.anas-grid-shares')

    await shareRow(page, grid, SHARE).click()
    await page.locator('.anas-btn-share-edit').click()
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // Nothing touched: the ticked box already reflects the entry exactly
    // (pre-fill, never a field default), so saving sends a byte-identical edit.
    await win.locator('.anas-btn-smb-share-submit').click()
    await expect(win).toBeHidden({ timeout: 60_000 })

    expect(putBody, 'the edit issued exactly one PUT').not.toBeNull()
    expect(putBody!).not.toHaveProperty('previousVersions')
    expect(putBody!).toMatchObject({ path: SHARE_PATH })

    // The stanza on the node — the source of truth — is untouched byte for
    // byte (the managed shadow keys were rewritten to their same values).
    expect(await shareStanza(SHARE)).toBe(stanzaBefore)
  })

  test('4 — untick: detail reads "off"; the stanza loses every shadow: key', async ({ page }) => {
    const fetches = await trackSharesFetches(page)
    await openShares(page)
    const grid = page.locator('.anas-grid-shares')
    const before = fetches.count()

    await shareRow(page, grid, SHARE).click()
    await page.locator('.anas-btn-share-edit').click()
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // Unticking withdraws the sentence with it.
    await setPvCheckbox(win, false)
    await expect(pvNote(win)).toBeHidden({ timeout: 20_000 })

    await win.locator('.anas-btn-smb-share-submit').click()
    await expect(win).toBeHidden({ timeout: 60_000 })
    await expect.poll(() => fetches.count(), { timeout: 45_000 }).toBeGreaterThan(before)

    await shareRow(page, grid, SHARE).click()
    await page.locator('.anas-btn-share-details').click()
    const detail = page.locator('.anas-win-share-details')
    await expect(detail).toBeVisible({ timeout: 20_000 })
    await expect(detail).toContainText(DETAIL_OFF)

    const stanza = await shareStanza(SHARE)
    expect(stanza).not.toContain('shadow:')
    expect(stanza).not.toContain('vfs objects')
  })

  test('5 — a custom vfs objects line greys the row with its reason; the line is removed again', async ({ page }) => {
    // Inject a hand-made line into the stanza the way a user would (surgical
    // file edit + live reload), so the dialog's greyed state is judged on the
    // real read-model.
    await sshExec(
      `sed -i '/^\\[${SHARE}\\]$/a vfs objects = acl_xattr' /etc/samba/smb.conf && smbcontrol all reload-config`,
    )
    expect(await shareStanza(SHARE)).toContain('vfs objects = acl_xattr')

    try {
      const fetches = await trackSharesFetches(page)
      await openShares(page)
      const grid = page.locator('.anas-grid-shares')
      const before = fetches.count()

      // The read-model must see the injected line before the dialog opens.
      await page.locator('.anas-btn-refresh').click()
      await expect.poll(() => fetches.count(), { timeout: 45_000 }).toBeGreaterThan(before)

      await shareRow(page, grid, SHARE).click()
      await page.locator('.anas-btn-share-edit').click()
      const win = page.locator('.anas-win-smb-share')
      await expect(win).toBeVisible({ timeout: 20_000 })

      // Greyed with reason: the box is hands-off and the note stands in
      // every box state until the line is removed.
      await expect(pvBox(win).locator('input').first()).toBeDisabled({ timeout: 20_000 })
      await expect(pvNote(win)).toBeVisible({ timeout: 20_000 })
      await expect(pvNote(win)).toHaveText(PV_GREY_REASON)

      // Cancel — nothing was or can be changed through this dialog.
      await win.getByText('Cancel', { exact: true }).click()
      await expect(win).toBeHidden({ timeout: 20_000 })
    }
    finally {
      // Remove the injected line again (exactly one was added — guard on the
      // count so a stray duplicate is never silently swept) and reload smbd.
      const count = Number.parseInt(
        await sshExec(`grep -c '^vfs objects = acl_xattr$' /etc/samba/smb.conf || true`),
        10,
      )
      expect(count, 'exactly one injected line to remove').toBe(1)
      await sshExec(
        `sed -i '/^vfs objects = acl_xattr$/d' /etc/samba/smb.conf && systemctl reload smbd`,
      )
      expect(await shareStanza(SHARE)).not.toContain('acl_xattr')
    }
  })

  test('6 — failed save: the failure alert shows the sentence AND the grid reloads; the row survives', async ({ page }) => {
    // Failure injection without touching the node: the PUT is answered 400
    // with a daemon-shaped sentence. The dialog's runJob path must show it
    // AND still reload the grid (the smbsvc.1 timeliness rule).
    await page.route(/\/v1\/shares\/smb\/pvshare$/, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'VALIDATION_ERROR', message: FAIL_SENTENCE },
          }),
        })
        return
      }
      await route.continue()
    })
    const fetches = await trackSharesFetches(page)

    await openShares(page)
    const grid = page.locator('.anas-grid-shares')
    await expect(shareRow(page, grid, SHARE)).toBeVisible({ timeout: 45_000 })
    const before = fetches.count()

    await shareRow(page, grid, SHARE).click()
    await page.locator('.anas-btn-share-edit').click()
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })
    await setPvCheckbox(win, true)
    await win.locator('.anas-btn-smb-share-submit').click()

    // The failure alert carries the injected sentence…
    const alert = page.locator('.x-message-box')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(alert).toContainText(FAIL_SENTENCE)
    await alert.locator('.x-btn', { hasText: 'OK' }).click()
    await expect(alert).toBeHidden({ timeout: 20_000 })

    // …the dialog stays open for a retry — dismissed here by hand.
    await expect(win).toBeVisible({ timeout: 20_000 })
    await win.getByText('Cancel', { exact: true }).click()
    await expect(win).toBeHidden({ timeout: 20_000 })

    // …and the grid reloaded anyway: the fetch count grows past the initial
    // load and the row is still there — no stale state.
    await expect.poll(() => fetches.count(), { timeout: 45_000 }).toBeGreaterThan(before)
    await expect(shareRow(page, grid, SHARE)).toBeVisible({ timeout: 45_000 })

    // The interception never reached the daemon: the stanza is untouched.
    expect(await shareStanza(SHARE)).not.toContain('shadow:')
  })
})
