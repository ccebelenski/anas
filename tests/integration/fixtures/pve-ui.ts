import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { GATEWAY_URL, NODE_NAME, PVE_ROOT_PASSWORD, PVE_URL, STUNT_HOST } from './target'

/**
 * Shared helpers for driving the real PVE ExtJS UI on the stunt node.
 *
 * These patterns are hard-won (originally in pve-embedding.spec.ts): the PVE
 * login form, the subscription-nag dismissal that otherwise masks every click,
 * resource-tree-scoped node selection, and listitem-scoped ANAS menu selection
 * (PVE's own Ceph section also has a hidden "Pools" item, so a page-wide text
 * match is ambiguous). ExtJS is slow to render — callers use generous timeouts.
 */

// The test-target address/names live in one place (./target). Re-exported here
// because these fixtures are the established import point for specs.
export { GATEWAY_URL, NODE_NAME, PVE_URL, STUNT_HOST }

/**
 * Drive the real PVE login form so the PVEAuthCookie is set by PVE's own JS
 * (Secure, SameSite=Lax) — not manufactured by the test — then dismiss the
 * subscription nag whose modal mask intercepts every subsequent click.
 */
export async function loginToPve(page: Page): Promise<void> {
  await page.goto(`${PVE_URL}/`)
  const username = page.locator('input[name="username"]')
  // 30 s rather than 20: this is every UI spec's first wait, so it absorbs
  // whatever the node is still busy with when a spec starts.
  await username.waitFor({ state: 'visible', timeout: 30_000 })
  await username.fill('root')
  await page.locator('input[name="password"]').fill(PVE_ROOT_PASSWORD)
  await page.getByRole('button', { name: 'Login' }).click()
  // Workspace loaded once the login dialog is gone.
  await expect(page.locator('input[name="username"]')).not.toBeVisible({ timeout: 30_000 })

  // Unsubscribed nodes always show the subscription nag after login; its modal
  // mask intercepts every click until dismissed. Wait for it deterministically,
  // dismiss, then wait for all ExtJS masks to clear.
  await page.getByText('No valid subscription').waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'OK' }).click()
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('.x-mask')).some(el => (el as HTMLElement).offsetParent !== null),
    undefined,
    { timeout: 15_000 },
  )
}

/**
 * Select the stunt node in the LEFT resource tree. Scope to the tree element:
 * the datacenter Search grid and storage entries also render cells containing
 * the node name.
 */
export async function selectNode(page: Page): Promise<void> {
  await page
    .locator('[id^="pveResourceTree"] .x-grid-cell-inner', { hasText: new RegExp(`^${NODE_NAME}$`) })
    .first()
    .click()
}

/**
 * Locate the injected "ANAS" group in the node menu. Scoped to the group's own
 * listitem subtree so item lookups (`Pools`, `Disks`, ...) don't collide with
 * PVE's Ceph section, which has its own (hidden) "Pools" item.
 */
export function anasGroup(page: Page): Locator {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByText('ANAS', { exact: true }) })
    .first()
}

/**
 * Select the node, then locate the expanded ANAS group and click one of its
 * items (Dashboard, Pools, Disks). Text-based selectors keep this resilient to
 * ExtJS-generated component ids.
 */
export async function openAnasItem(page: Page, item: string): Promise<void> {
  await selectNode(page)

  const group = anasGroup(page)
  await expect(group).toBeVisible({ timeout: 20_000 })

  const menuItem = group.getByText(item, { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 20_000 })
  await menuItem.click()
}

/**
 * The ExtJS grid/tree ROW (`tr.x-grid-row`) holding `inRow` (the row itself,
 * or any element inside it). The class test is word-exact: a focused cell
 * carries `x-grid-item-focused`, which a plain `contains(@class, ...)` would
 * mistake for the row.
 */
function gridRowOf(inRow: Locator): Locator {
  return inRow.locator('xpath=ancestor-or-self::tr[contains(concat(" ", normalize-space(@class), " "), " x-grid-row ")][1]')
}

/**
 * Bring a tree/grid row into the view's visible area, then act on it, retried
 * until the row reads the expected state. Why (cr3 node pass, measured on the
 * stunt node 2026-11-14 at 2560x1080): with six pools in the Datasets tree the
 * content (600 px) is taller than the tree view (471 px), so testpool/share1
 * sits BELOW the view's visible bottom. A plain Playwright click on such a row
 * scrolls it into view and clicks in the same breath; ExtJS's scroller has
 * not settled, the mousedown and mouseup land on different rows, and the click
 * is lost (mousedown events fire, no itemclick, no selection, no expand: 2 of 2
 * plain clicks lost, 2 of 2 scroll-first clicks selected). The state the
 * action must leave behind is the oracle, never the click.
 */
async function actOnRowUntil(inRow: Locator, act: () => Promise<void>, done: () => Promise<boolean>): Promise<void> {
  await expect(async () => {
    await inRow.scrollIntoViewIfNeeded({ timeout: 2_000 })
    if (!(await done()))
      await act()
    await expect.poll(done, { timeout: 2_000 }).toBe(true)
  }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] })
}

/** Select the tree/grid row holding `inRow`; returns once ExtJS marks it selected. */
export async function selectGridRow(inRow: Locator): Promise<void> {
  const item = gridRowOf(inRow).locator('xpath=ancestor::table[1]')
  await actOnRowUntil(
    inRow,
    () => inRow.click({ timeout: 2_000 }),
    async () => /(^|\s)x-grid-item-selected(\s|$)/.test(await item.getAttribute('class') ?? ''),
  )
}

/** Expand the tree row holding `inRow` (by its own expander); returns once it reads expanded. */
export async function expandTreeRow(inRow: Locator): Promise<void> {
  const row = gridRowOf(inRow)
  await actOnRowUntil(
    inRow,
    () => row.locator('.x-tree-expander').first().click({ timeout: 2_000 }),
    async () => (await row.getAttribute('aria-expanded')) === 'true',
  )
}
