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
 *   - Pool-root row band      '.anas-ds-pool-row'
 *   - Donut hero              '.anas-ds-hero' + '.anas-gfx-donut'
 *
 * Operator ruling 2026-08-19: the per-row line-icon ACTIONS COLUMN is gone —
 * every icon duplicated a toolbar button (which already gates PVE-managed rows),
 * so the tree is toolbar-first like every other view. These specs now assert its
 * ABSENCE alongside the surviving gfx enrichment.
 *
 * Read-only: no mutations here (the base spec + api specs cover the flows the
 * toolbar dispatches to). ExtJS boot is slow → generous timeouts.
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

    // No per-row action icons anywhere in the tree — the verbs live on the
    // toolbar only (operator ruling 2026-08-19), and the reclaimed width goes
    // back to the flexed Name column.
    await expect(grid.locator('.anas-gfx-ctl')).toHaveCount(0)
    await expect(grid.locator('.anas-ds-actions-cell')).toHaveCount(0)
    // The toolbar carries those verbs instead.
    await expect(page.locator('.anas-btn-ds-create')).toBeVisible()
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
