import { expect, test } from '@playwright/test'

const PVE_URL = 'https://192.168.200.50:8006'
const GATEWAY_URL = 'https://192.168.200.50:3000'

/**
 * The real user journey: log into the Proxmox web UI, then reach the ANAS
 * gateway from that same session.
 *
 * This drives the actual PVE login form so the PVEAuthCookie is set by PVE's own
 * JS (Secure, SameSite=Lax) — not manufactured by the test. It exists because a
 * manufactured cookie once masked a transport bug: the gateway served plain
 * HTTP, browsers withheld the Secure cookie, and every real user got a 401 while
 * the fixture-based tests stayed green.
 *
 * The gateway serves no pages (13.13), so instead of navigating we fetch
 * `/api/health` from the PVE page's own context with credentials. Same host →
 * the Secure PVEAuthCookie rides along (cookies ignore ports); the gateway's
 * PVE-origin CORS-with-credentials lets the cross-port response through. That
 * proves the whole cookie + CORS flow end-to-end.
 */
test.describe('PVE login flow', () => {
  test('logging into the PVE UI authenticates the user to the gateway', async ({ page }) => {
    await page.goto(`${PVE_URL}/`)

    // PVE's ExtJS login dialog
    const username = page.locator('input[name="username"]')
    await username.waitFor({ state: 'visible', timeout: 15_000 })
    await username.fill('root')
    await page.locator('input[name="password"]').fill('anas-test')
    await page.getByRole('button', { name: 'Login' }).click()

    // Wait for the workspace to load (login dialog gone)
    await expect(page.locator('input[name="username"]')).not.toBeVisible({ timeout: 15_000 })

    // Same browser, real session: from the PVE origin, fetch the gateway health
    // endpoint with credentials. The gateway must accept the cookie (200).
    const status = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'include' })
      return res.status
    }, `${GATEWAY_URL}/api/health`)
    expect(status).toBe(200)
  })
})
