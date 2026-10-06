import type { Locator, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { datasetExists, poolExists, skipIfFixtureMissing } from './fixtures/stunt-node'

/**
 * Story snapx.1 (GitHub #71) — the schedule dialog's Exclude datasets picker,
 * driven through the real PVE UI over the pvepool fixture
 * (test/stunt-node/pvepool-fixture.sh up). Modelled on pvepool-ui.spec.ts.
 *
 * Fixture used (never mutated here): pvfix/media and its child
 * pvfix/media/child, an ANAS sibling subtree on the PVE pool `pvfix`.
 *
 * Contracts under test:
 *   - the Exclude picker is hidden until Recursive is ticked, then shown
 *   - it lists the picked target's descendants (pvfix/media/child, shown
 *     relative to the pool as `media/child`)
 *   - a saved schedule's grid row reads "(-r, 1 excluded)", and the tooltip
 *     names the excluded dataset
 *
 * The schedule is created DISABLED (no timer fire on the node) and deleted
 * through the API before and after the test. ExtJS boot + panel render is
 * slow, so the timeouts are generous.
 */

const PVE_POOL = 'pvfix'
const TARGET = 'pvfix/media'
const CHILD = 'pvfix/media/child'
const SCHED_ID = 'snapx-proof'
const SCHED_NAME = 'snapx proof'
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

/** Remove the proof schedule through its own door; absent is fine. */
async function deleteSchedule(playwright: PlaywrightWorkerArgs['playwright'], ticket: string): Promise<void> {
  const ctx = await playwright.request.newContext({ ignoreHTTPSErrors: true, storageState: pveAuthState(ticket) })
  try {
    const res = await ctx.delete(`${V1}/schedules/${SCHED_ID}`)
    expect([202, 404]).toContain(res.status())
    if (res.status() === 202) {
      const { job } = await res.json() as { job: { id: string } }
      await expect.poll(async () => {
        const r = await ctx.get(`${V1}/jobs/${job.id}`)
        return ((await r.json()) as { job: { status: string } }).job.status
      }, { timeout: 30_000 }).toMatch(/completed|failed/)
    }
  }
  finally {
    await ctx.dispose()
  }
}

/** Pick one entry from the open ExtJS boundlist by its exact text. */
async function pickFromList(field: Locator, text: RegExp): Promise<void> {
  const page = field.page()
  await expect.poll(async () => {
    await field.click()
    return page
      .locator('.x-boundlist:visible .x-boundlist-item', { hasText: text })
      .isVisible()
      .catch(() => false)
  }, { timeout: 30_000 }).toBe(true)
  await page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: text }).first().click()
}

/** Tick / untick an ExtJS checkbox field found by its cls. */
async function setCheckbox(win: Locator, cls: string, check: boolean): Promise<void> {
  const input = win.locator(`${cls} input`).first()
  const checked = await input.evaluate(el => (el as HTMLInputElement).checked)
  if (checked !== check)
    await input.click()
}

test.beforeEach(async ({ playwright, pveTicket }) => {
  skipIfFixtureMissing(
    !(await poolExists(PVE_POOL)) || !(await datasetExists(CHILD)),
    'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
  )
  await deleteSchedule(playwright, pveTicket)
})

test.afterEach(async ({ playwright, pveTicket }) => {
  await deleteSchedule(playwright, pveTicket)
})

test.describe('snapx.1 — exclude datasets from a recursive snapshot schedule (stunt node fixture)', () => {
  test.setTimeout(150_000)

  test('Recursive reveals the Exclude picker; a picked child saves as "1 excluded"', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Snapshots')
    const grid = page.locator('.anas-grid-schedules')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    await page.locator('.anas-btn-sched-new').click()
    const win = page.locator('.anas-win-sched')
    await expect(win).toBeVisible({ timeout: 20_000 })

    await win.locator('.anas-fld-sched-name input').first().fill(SCHED_NAME)
    await win.locator('.anas-fld-sched-id input').first().fill(SCHED_ID)

    // Target: pvfix/media.
    await pickFromList(win.locator('.anas-fld-sched-zfs-pool'), new RegExp(`^${PVE_POOL}$`))
    await pickFromList(win.locator('.anas-fld-sched-zfs-dataset'), /^media$/)

    // The Exclude picker appears only once Recursive is ticked.
    const exclude = win.locator('.anas-fld-sched-exclude')
    await expect(exclude).toBeHidden()
    await setCheckbox(win, '.anas-fld-sched-recursive', true)
    await expect(exclude).toBeVisible({ timeout: 20_000 })

    // Pick the child. Force past the tagfield's placeholder label, which
    // overlays the input; typing filters the pick list.
    const excludeInput = exclude.locator('input[type="text"]').first()
    await excludeInput.click({ force: true })
    await excludeInput.pressSequentially('child')
    const item = page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: /^media\/child$/ })
    await expect(item).toBeVisible({ timeout: 20_000 })
    await item.click()
    await expect(exclude).toContainText('media/child')

    // Keep the proof schedule from ever firing on the node.
    await setCheckbox(win, '.anas-fld-sched-enabled', false)
    await win.locator('.anas-btn-sched-submit').click()
    await expect(win).toBeHidden({ timeout: 60_000 })

    // The grid row: "(-r, 1 excluded)", the tooltip names the dataset.
    const row = grid.locator('.x-grid-row', { hasText: SCHED_NAME }).first()
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toContainText(TARGET)
    const marker = row.locator('.anas-sched-recursive')
    await expect(marker).toHaveText('(-r, 1 excluded)', { timeout: 20_000 })
    await expect(marker).toHaveAttribute('title', new RegExp(`excluded: ${CHILD}`))
  })
})
