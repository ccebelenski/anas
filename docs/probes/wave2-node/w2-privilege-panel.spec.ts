import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { anasGroup, NODE_NAME, PVE_URL } from '../../../tests/integration/fixtures/pve-ui'

/**
 * Wave-2 node pass, WAVE2-DESIGN §8 row 4 / §5 row 15 (cr.27): a PVE user
 * PVE grants nothing (anas-none@pve, no ACL at all) opens the node's ANAS
 * item. ANAS answers the install probe (GET /v1/health) with 403, and the panel
 * must be the privilege panel ("You need Sys.Audit on / to view ANAS on this
 * node", 20-notinstalled.js ANAS.noPrivilegePanel) — NOT "ANAS is not
 * installed on this node".
 */

const USER = 'anas-none'
const PASSWORD = 'anas-w2-pw'
const REALM = 'Proxmox VE authentication server'

async function loginAs(page: Page, note: (s: string) => void): Promise<void> {
  await page.goto(`${PVE_URL}/`)
  const username = page.locator('input[name="username"]')
  await username.waitFor({ state: 'visible', timeout: 30_000 })
  await username.fill(USER)
  await page.locator('input[name="password"]').fill(PASSWORD)
  // The realm combo: pick PVE's own realm by its display name.
  const realm = page.locator('.x-form-item', { has: page.locator('input[name="realm"]') })
  await realm.locator('.x-form-trigger').first().click()
  await page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: REALM }).first().click()
  note(`realm field: "${await page.locator('input[name="realm"]').inputValue()}"`)
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(username).not.toBeVisible({ timeout: 30_000 })
  // The subscription nag may or may not come for a user without Sys.Audit.
  const nag = page.getByText('No valid subscription')
  if (await nag.isVisible({ timeout: 10_000 }).catch(() => false)) {
    note('subscription nag shown; dismissed')
    await page.getByRole('button', { name: 'OK' }).click()
  }
  else {
    note('no subscription nag for this user')
  }
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('.x-mask')).some(el => (el as HTMLElement).offsetParent !== null),
    undefined,
    { timeout: 15_000 },
  )
}

test('anas-none@pve sees the Sys.Audit privilege panel, not "not installed"', async ({ page }) => {
  test.setTimeout(180_000)
  const t0 = Date.now()
  const note = (s: string): void => console.log(`[t+${Math.round((Date.now() - t0) / 100) / 10}s] ${s}`)
  const health: { status: number, body: string }[] = []
  page.on('response', async (res) => {
    if (/\/anas\/api\/nodes\/[^/]+\/v1\/health$/.test(res.url())) {
      const body = await res.text().catch(() => '')
      health.push({ status: res.status(), body })
      note(`GET ${res.url().replace(PVE_URL, '')} -> HTTP ${res.status()} ${body.slice(0, 300)}`)
    }
  })

  await loginAs(page, note)
  note(`logged in; user shown: ${JSON.stringify((await page.locator('.x-btn', { hasText: '@pve' }).allInnerTexts()).slice(0, 2))}`)

  const nodeCell = page
    .locator('[id^="pveResourceTree"] .x-grid-cell-inner', { hasText: new RegExp(`^${NODE_NAME}$`) })
    .first()
  await expect(nodeCell).toBeVisible({ timeout: 30_000 })
  await nodeCell.click()
  const group = anasGroup(page)
  await expect(group).toBeVisible({ timeout: 20_000 })
  const item = group.getByText('Dashboard', { exact: true })
  await expect(item).toBeVisible({ timeout: 20_000 })
  await item.click()
  note('opened ANAS → Dashboard')

  const panel = page.locator('.anas-view-noprivilege')
  await expect(panel).toBeVisible({ timeout: 45_000 })
  const text = (await panel.innerText()).replace(/\s+/g, ' ').trim()
  note(`panel text: "${text}"`)
  await expect(panel.locator('h2')).toHaveText('You need Sys.Audit on / to view ANAS on this node')
  await expect(page.getByText('ANAS is not installed on this node')).toHaveCount(0)
  await expect(page.locator('.anas-view-notinstalled')).toHaveCount(0)

  expect(health.length).toBeGreaterThan(0)
  expect(health.every(h => h.status === 403)).toBe(true)
  note(`health responses: ${health.map(h => h.status).join(', ')}`)
})
