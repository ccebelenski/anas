import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Shared helpers for driving the real PVE ExtJS UI on the stunt node.
 *
 * These patterns are hard-won (originally in pve-embedding.spec.ts): the PVE
 * login form, the subscription-nag dismissal that otherwise masks every click,
 * resource-tree-scoped node selection, and listitem-scoped ANAS menu selection
 * (PVE's own Ceph section also has a hidden "Pools" item, so a page-wide text
 * match is ambiguous). ExtJS is slow to render — callers use generous timeouts.
 */

export const PVE_URL = 'https://192.168.200.50:8006'
export const GATEWAY_URL = 'https://192.168.200.50:3000'
// The stunt node's hostname (test/stunt-node/provision.sh: hostnamectl set-hostname).
export const NODE_NAME = 'anas-pve'

/**
 * Drive the real PVE login form so the PVEAuthCookie is set by PVE's own JS
 * (Secure, SameSite=Lax) — not manufactured by the test — then dismiss the
 * subscription nag whose modal mask intercepts every subsequent click.
 */
export async function loginToPve(page: Page): Promise<void> {
  await page.goto(`${PVE_URL}/`)
  const username = page.locator('input[name="username"]')
  await username.waitFor({ state: 'visible', timeout: 20_000 })
  await username.fill('root')
  await page.locator('input[name="password"]').fill('anas-test')
  await page.getByRole('button', { name: 'Login' }).click()
  // Workspace loaded once the login dialog is gone.
  await expect(page.locator('input[name="username"]')).not.toBeVisible({ timeout: 20_000 })

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
