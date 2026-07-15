import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists } from './fixtures/stunt-node'

/**
 * Epic 15.4 — enriched Datasets tree (gfx retrofit) driven through the real PVE
 * UI on the stunt node. Companion to datasets-ui.spec.ts (Epic 4 base tree).
 *
 * These assert the gfx VISUAL LANGUAGE is retrofitted INTO the existing native
 * treepanel (not a replacement div-tree): the enriched columns, per-row gfx
 * markup, the pool-root row band, and the pool-space donut hero. All hooks are
 * the stable gfx / view-local classes:
 *   - '.anas-grid-datasets' still the native tree (Epic 4 hook, unchanged)
 *   - Space-of-pool bars      '.anas-gfx-bar'
 *   - Property chips          '.anas-gfx-chip'
 *   - Persistent action icons '.anas-gfx-ctl' (each an always-visible <button>)
 *   - Pool-root row band      '.anas-ds-pool-row'
 *   - Donut hero              '.anas-ds-hero' + '.anas-gfx-donut'
 *
 * Read-only: no mutations here (the base spec + api specs cover the flows the
 * icons dispatch to). ExtJS boot is slow → generous timeouts.
 */

test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS Datasets enriched tree — Epic 15.4 gfx retrofit', () => {
  test.setTimeout(120_000)

  test('the tree is still the native treepanel, now enriched with gfx columns', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    // Still the native ExtJS tree (no custom div-tree, no iframe).
    const grid = page.locator('.anas-grid-datasets')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    await expect(page.locator('.anas-view-datasets iframe')).toHaveCount(0)
    await expect(grid.getByText('testpool').first()).toBeVisible({ timeout: 45_000 })

    // Enriched columns render gfx markup inside the tree rows.
    await expect(grid.locator('.anas-gfx-bar').first()).toBeVisible({ timeout: 45_000 })

    // Persistent (always-visible) per-row action icons — NOT hover-reveal.
    const ctls = grid.locator('.anas-gfx-ctl')
    await expect(ctls.first()).toBeVisible({ timeout: 45_000 })
    // The pool root exposes an "add" (new top-level dataset) control.
    await expect(grid.locator('.anas-gfx-ctl-add').first()).toBeVisible()
    // Each action icon carries a tooltip (nothing is unlabelled).
    await expect(ctls.first()).toHaveAttribute('title', /.+/)
  })

  test('the pool root has a distinct row band and a pool/folder object icon', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    const grid = page.locator('.anas-grid-datasets')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // Pool-root band applied via getRowClass.
    await expect(grid.locator('.anas-ds-pool-row').first()).toBeVisible({ timeout: 45_000 })
    // The pool row uses the gfx pool object icon.
    await expect(grid.locator('.anas-ds-pool-row .anas-gfx-obj-pool').first()).toBeVisible()
  })

  test('the pool-space donut hero appears above the tree', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })

    const hero = page.locator('.anas-ds-hero')
    await expect(hero).toBeVisible({ timeout: 45_000 })
    await expect(hero.locator('.anas-gfx-donut')).toBeVisible()
    await expect(hero.locator('.anas-gfx-legend')).toBeVisible()
  })
})
