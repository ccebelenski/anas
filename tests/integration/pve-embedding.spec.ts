import { expect, test } from '@playwright/test'
import { waitForFrameHydrated } from '../helpers/hydration'
import { poolExists } from './fixtures/stunt-node'

/**
 * Story 13.6 — the full PVE UI embedding chain, verified end-to-end against the
 * real stunt node: injection → ticket handoff → embedded view.
 *
 * Contracts under test (DESIGN.md → "PVE UI Integration"):
 *   - The PVE node menu gains a collapsible "ANAS" section (Dashboard, Pools,
 *     Disks) whose items render an iframe of the embedded ANAS view.
 *   - The iframe loads `/auth/handoff?to=...`, which hands off the cluster-valid
 *     PVEAuthCookie via postMessage and redirects to `<to>?embedded=1`.
 *   - The embedded pools view shows the real ZFS pool `testpool`, and its rows
 *     ([data-pool-select]) open the floating detail panel ([data-panel-id]).
 *   - The handoff page is served WITHOUT auth (200); data routes still 401
 *     without a cookie.
 *
 * ExtJS renders the node menu as a tree list — we prefer resilient text-based
 * selectors over brittle ExtJS component ids, and use generous timeouts because
 * ExtJS is slow to render.
 */

const PVE_URL = 'https://192.168.200.50:8006'
const ANAS_ORIGIN = 'https://192.168.200.50:3000'
// The stunt node's hostname (test/stunt-node/provision.sh: hostnamectl set-hostname).
const NODE_NAME = 'anas-pve'

// Skip-guard the whole suite when the real pool is absent (mirrors scrub.spec.ts),
// using the poolExists fixture helper. This also covers the stunt node being off:
// poolExists swallows SSH failures and returns false → the suite skips cleanly.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('PVE UI embedding (stunt node)', () => {
  // ExtJS boot + handoff handshake + iframe render can be slow.
  test.setTimeout(90_000)

  /**
   * Drive the real PVE login form (mirrors pve-login-flow.spec.ts) so the
   * PVEAuthCookie is set by PVE's own JS, not manufactured by the test.
   */
  async function loginToPve(page: import('@playwright/test').Page) {
    await page.goto(`${PVE_URL}/`)
    const username = page.locator('input[name="username"]')
    await username.waitFor({ state: 'visible', timeout: 20_000 })
    await username.fill('root')
    await page.locator('input[name="password"]').fill('anas-test')
    await page.getByRole('button', { name: 'Login' }).click()
    // Workspace loaded once the login dialog is gone.
    await expect(page.locator('input[name="username"]')).not.toBeVisible({ timeout: 20_000 })

    // Unsubscribed nodes always show the subscription nag after login; its
    // modal mask intercepts every click until dismissed. Wait for it
    // deterministically, dismiss, then wait for all ExtJS masks to clear.
    await page.getByText('No valid subscription').waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'OK' }).click()
    await page.waitForFunction(
      () => !Array.from(document.querySelectorAll('.x-mask')).some(el => (el as HTMLElement).offsetParent !== null),
      undefined,
      { timeout: 15_000 },
    )
  }

  /**
   * Select the node in the resource tree, then expand/locate the injected ANAS
   * section and click one of its items. Text-based selectors keep this resilient
   * to ExtJS-generated ids.
   */
  async function openAnasItem(page: import('@playwright/test').Page, item: string) {
    // Contract: node-level placement — select the node in the LEFT resource
    // tree. Scope to the tree element: the datacenter Search grid and storage
    // entries also render cells containing the node name.
    await page
      .locator('[id^="pveResourceTree"] .x-grid-cell-inner', { hasText: new RegExp(`^${NODE_NAME}$`) })
      .first()
      .click()

    // Contract: an expanded "ANAS" section appears in the node menu. Scope the
    // item lookup to the ANAS group's own subtree — PVE's Ceph section has a
    // (collapsed, hidden) "Pools" item too, so a page-wide text match is
    // ambiguous.
    const anasGroup = page
      .getByRole('listitem')
      .filter({ has: page.getByText('ANAS', { exact: true }) })
      .first()
    await expect(anasGroup).toBeVisible({ timeout: 20_000 })

    const menuItem = anasGroup.getByText(item, { exact: true })
    await expect(menuItem).toBeVisible({ timeout: 20_000 })
    await menuItem.click()
  }

  test('ANAS → Pools renders the embedded pools view showing testpool', async ({ page }) => {
    await loginToPve(page)

    // Contract: clicking Pools renders an iframe of the embedded ANAS pools view.
    await openAnasItem(page, 'Pools')

    // Contract: the ANAS iframe src is the handoff URL. The internal
    // location.replace() to /storage/pools?embedded=1 does not rewrite the
    // element's src attribute, so this locator still matches the frame element
    // while its document is now the embedded pools view.
    const anasFrame = page.frameLocator('iframe[src*="/auth/handoff"]')

    // Contract: the embedded pools view shows the real pool `testpool`.
    await expect(anasFrame.locator('[data-pool-select="testpool"]')).toBeVisible({ timeout: 45_000 })
  })

  test('clicking testpool in the embedded view opens the floating detail panel', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const anasFrame = page.frameLocator('iframe[src*="/auth/handoff"]')
    const poolRow = anasFrame.locator('[data-pool-select="testpool"]')
    await expect(poolRow).toBeVisible({ timeout: 45_000 })

    // Clicking pre-hydration hits dead SSR handlers — wait for the app's
    // hydration stamp inside the frame first (see tests/helpers/hydration.ts).
    await waitForFrameHydrated(anasFrame)

    // Contract: pool rows open the floating pool-detail panel (inside the frame).
    await poolRow.click()
    await expect(anasFrame.locator('[data-panel-id="pool-detail-testpool"]'))
      .toBeVisible({ timeout: 20_000 })
  })

  test('handoff is served without auth (200) while data routes 401 without a cookie', async ({ playwright }) => {
    // Fresh request context with NO cookies — a browser that never logged into PVE.
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })

    // Contract: the handoff page renders no data and is served WITHOUT auth.
    // Do not auto-follow redirects — we assert the page itself responds 200.
    const handoff = await context.get(
      `${ANAS_ORIGIN}/auth/handoff?to=/storage/pools`,
      { maxRedirects: 0 },
    )
    expect(handoff.status()).toBe(200)

    // Contract: data routes still require the PVEAuthCookie — no cookie → 401.
    const pools = await context.get(`${ANAS_ORIGIN}/storage/pools`, { maxRedirects: 0 })
    expect(pools.status()).toBe(401)

    await context.dispose()
  })
})
