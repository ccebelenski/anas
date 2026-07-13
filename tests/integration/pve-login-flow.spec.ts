import { expect, test } from '@playwright/test'

const PVE_URL = 'https://192.168.200.50:8006'
const ANAS_URL = 'https://192.168.200.50:3000'

/**
 * The real user journey: log into the Proxmox web UI, then open ANAS.
 *
 * This drives the actual PVE login form so the PVEAuthCookie is set by
 * PVE's own JS (Secure, SameSite=Lax) — not manufactured by the test.
 * It exists because a manufactured cookie once masked a transport bug:
 * ANAS served plain HTTP, browsers withheld the Secure cookie, and every
 * real user got a 401 while the fixture-based tests stayed green.
 */
test.describe('PVE login flow', () => {
  test('logging into PVE UI authenticates the user to ANAS', async ({ page }) => {
    await page.goto(`${PVE_URL}/`)

    // PVE's ExtJS login dialog
    const username = page.locator('input[name="username"]')
    await username.waitFor({ state: 'visible', timeout: 15_000 })
    await username.fill('root')
    await page.locator('input[name="password"]').fill('anas-test')
    await page.getByRole('button', { name: 'Login' }).click()

    // Wait for the workspace to load (login dialog gone)
    await expect(page.locator('input[name="username"]')).not.toBeVisible({ timeout: 15_000 })

    // Same browser, no manufactured cookie: ANAS must accept the session
    const response = await page.goto(`${ANAS_URL}/`)
    expect(response).not.toBeNull()
    expect(response!.status()).toBeLessThan(400)

    // And it's actually the app, not an error page
    await expect(page.locator('[data-nav="pools"]')).toBeVisible({ timeout: 10_000 })
  })
})
