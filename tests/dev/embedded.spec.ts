import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { gotoHydrated } from '../helpers/hydration'

/**
 * Story 13.6 — embedded display mode, verified against the mock dev server.
 *
 * Contracts under test (DESIGN.md → "UI Model: Routed Views + Floating Panels"
 * and "PVE UI Integration"):
 *   - Top-level views are routed pages: `/storage/pools` is deep-linkable.
 *   - `?embedded=1` hides ANAS chrome (the sidebar with [data-nav=...] links
 *     and the header); the flag persists across in-app navigation.
 *   - The handoff page validates `to` — no open redirect off-origin.
 *
 * The dev server (baseURL http://localhost:3100, ANAS_AUTH_PROVIDER=dev) serves
 * the mock daemon whose fixtures include a pool named `testpool`. The routed
 * views and the embedded flag are built in parallel (stories 13.1/13.2); until
 * merged these tests fail gracefully — that is expected in an isolated worktree.
 */

// The row selector that exists inside the embedded pools view regardless of
// whether the view renders the list inline or in a floating panel.
const POOL_ROW = '[data-pool-select="testpool"]'
// The defining "chrome" selector: the sidebar navigation links. Absence of any
// [data-nav] element is the observable signal that chrome is hidden.
const NAV_LINKS = '[data-nav]'
const SIDEBAR = '[data-region="sidebar"]'

async function waitForPoolRow(page: Page) {
  // The pool list fetches its own data on mount — give it room.
  await expect(page.locator(POOL_ROW)).toBeVisible({ timeout: 15_000 })
}

test.describe('Embedded display mode (mock dev server)', () => {
  test('standalone /storage/pools renders the pool list with sidebar chrome visible', async ({ page }) => {
    // Contract: views are routed pages — /storage/pools is directly reachable.
    await gotoHydrated(page, '/storage/pools')

    // The pool list renders `testpool`.
    await waitForPoolRow(page)

    // Standalone mode (no ?embedded=1): ANAS shows its own sidebar/header chrome.
    await expect(page.locator(SIDEBAR)).toBeVisible()
    await expect(page.locator('[data-nav="pools"]')).toBeVisible()
    expect(await page.locator(NAV_LINKS).count()).toBeGreaterThan(0)
  })

  test('embedded /storage/pools?embedded=1 renders the pool list with NO chrome', async ({ page }) => {
    // Contract: `?embedded=1` hides ANAS chrome — navigation belongs to the PVE
    // resource tree; the view renders content-only, filling the frame.
    await gotoHydrated(page, '/storage/pools?embedded=1')

    // Content still renders: the pool list shows `testpool`.
    await waitForPoolRow(page)

    // No sidebar, no [data-nav] links, no header chrome. Sidebar/nav are the
    // DESIGN-named chrome selectors; the header is asserted "not visible" rather
    // than removed, tolerating either v-if removal or CSS hiding.
    await expect(page.locator(SIDEBAR)).toHaveCount(0)
    await expect(page.locator(NAV_LINKS)).toHaveCount(0)
    await expect(page.locator('.app-header')).not.toBeVisible()
  })

  test('embedded flag persists after opening the pool detail panel', async ({ page }) => {
    // Contract: the embedded flag persists across in-app navigation/interaction.
    await gotoHydrated(page, '/storage/pools?embedded=1')
    await waitForPoolRow(page)

    // Chrome is hidden before we interact.
    await expect(page.locator(NAV_LINKS)).toHaveCount(0)

    // Interact: open the floating pool-detail panel (a stacked overlay).
    await page.locator(POOL_ROW).click()
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).toBeVisible({ timeout: 15_000 })

    // Chrome MUST stay hidden and the embedded flag MUST still be in the URL.
    await expect(page.locator(NAV_LINKS)).toHaveCount(0)
    await expect(page.locator(SIDEBAR)).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('embedded')).toBe('1')
  })

  test('handoff rejects an off-origin `to` (no open redirect)', async ({ page }) => {
    // Contract: `to` must be a same-origin relative path — validated, no open
    // redirect. `//evil.com` is a protocol-relative URL that would navigate
    // off-origin if naively passed to location.replace().
    //
    // The handoff page is reachable without auth; without a parent frame it
    // never receives an `anas:handoff:ticket`, so it must never leave its origin.
    await page.goto('/auth/handoff?to=//evil.com')

    // Give the page time to (mis)behave — any redirect would fire within this.
    await page.waitForTimeout(2000)

    // Final URL must still be on the ANAS origin, never evil.com.
    const finalUrl = new URL(page.url())
    expect(finalUrl.host).toBe('localhost:3100')
    expect(finalUrl.hostname).not.toContain('evil.com')
  })
})
