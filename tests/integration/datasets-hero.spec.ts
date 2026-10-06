import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists } from './fixtures/stunt-node'

/**
 * Story dshero.1 (GitHub #70, UI leg) — the Pool space hero on the Datasets
 * screen stays BOUNDED when the pool is also PVE storage, driven through the
 * real PVE UI over the pvepool fixture (test/stunt-node/pvepool-fixture.sh up).
 * Modelled on pvepool-ui.spec.ts (same login + openAnasItem, same fixture
 * guard) and datasets-gfx-ui.spec.ts (same hero hooks).
 *
 * The bug: buildHeroHtml emitted one legend row per top-level dataset with no
 * cap — on a PVE-storage pool that is every guest volume, the hero (a plain
 * component at natural height above the flex:1 tree) pushed the tree to zero
 * height. The fix folds PVE-owned children into ONE "Proxmox guest volumes"
 * segment (the same ownership verdict the Name-column badge uses) and caps
 * the legend to the largest 8 named segments + one "n more" roll-up, Free
 * last — so the invariant is hero height bounded regardless of dataset count,
 * NOT a scrollable legend.
 *
 * Fixture pools on screen: pvfix (PVE zfspool storage carrying vm-100-disk-0,
 * subvol-101-disk-0, basevol-102-disk-0, base-103-disk-0, ANAS siblings media
 * + media/child, and the pvfixdump dir-storage path dump) plus sysfix and the
 * baseline test pools. The hero follows the SELECTED node's pool, so the spec
 * selects the pvfix pool row first; the tree renders pools in zpool-list
 * order, hence .first() row addressing (see pvepool-ui.spec.ts).
 *
 * Legend rows are asserted through 15-gfx.js's own markup: each row is
 * .anas-gfx-legend-row holding .anas-gfx-legend-nm (the label span).
 */

const PVE_POOL = 'pvfix'
// N = 8 named + 1 roll-up + Free = 10 rows maximum by construction.
const MAX_LEGEND_ROWS = 10

test.beforeEach(async () => {
  test.skip(
    !(await poolExists(PVE_POOL)),
    'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
  )
})

/** Select the pvfix pool row so the hero focuses on it. */
async function openDatasetsOnPvfix(page: Page): Promise<{ grid: Locator, hero: Locator }> {
  await loginToPve(page)
  await openAnasItem(page, 'Datasets')
  const grid = page.locator('.anas-grid-datasets')
  await expect(grid).toBeVisible({ timeout: 45_000 })

  // Dataset rows show their RELATIVE name; the pvfix pool root matches first
  // in tree order (see pvepool-ui.spec.ts's dsRow note).
  const poolRow = grid
    .locator('.anas-ds-pool-row', { has: page.locator('.x-tree-node-text', { hasText: PVE_POOL }) })
    .first()
  await expect(poolRow).toBeVisible({ timeout: 45_000 })
  await poolRow.click()

  // The hero re-renders for the selected pool — its title carries the name.
  const hero = page.locator('.anas-ds-hero')
  await expect(hero).toBeVisible({ timeout: 20_000 })
  await expect(hero.locator('.anas-ds-hero-t')).toContainText(PVE_POOL, { timeout: 20_000 })
  return { grid, hero }
}

test.describe('dshero.1 — Pool space hero bounded on a PVE-storage pool (#70)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(150_000)

  test('guest volumes fold into ONE legend row; the legend stays capped', async ({ page }) => {
    const { hero } = await openDatasetsOnPvfix(page)

    const names = hero.locator('.anas-gfx-legend .anas-gfx-legend-nm')
    await expect(names.first()).toBeVisible({ timeout: 20_000 })

    // (a) The PVE footprint reads as ONE folded segment — exactly one row.
    const folded = names.filter({ hasText: /^Proxmox guest volumes/ })
    await expect(folded).toHaveCount(1)

    // (b) No guest volume keeps a named legend row of its own.
    const labels = await names.allTextContents()
    for (const label of labels) {
      expect(label).not.toMatch(/^(subvol-|vm-|basevol-|base-)/)
    }

    // (c) The legend is capped — max named + roll-up + Free.
    expect(labels.length).toBeLessThanOrEqual(MAX_LEGEND_ROWS)
  })

  test('the tree keeps at least half the Datasets panel height', async ({ page }) => {
    const { grid, hero } = await openDatasetsOnPvfix(page)
    await expect(hero.locator('.anas-gfx-legend')).toBeVisible({ timeout: 20_000 })

    // The #70 invariant: the hero (natural height in the vbox) may never
    // squeeze the flex:1 tree below usable — half the panel is generous.
    const panelBox = await page.locator('.anas-view-datasets').boundingBox()
    const treeBox = await grid.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(treeBox).not.toBeNull()
    expect(treeBox!.height).toBeGreaterThanOrEqual((panelBox!.height) * 0.5)
  })
})
