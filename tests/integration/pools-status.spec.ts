import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists } from './fixtures/stunt-node'

/**
 * Epic 15.3 — Pools status view retrofit. Full-chain ExtJS specs driven through
 * the real PVE UI on the stunt node (PVE login → ANAS node menu → native Pools
 * grid → Detail window).
 *
 * Contracts under test (task brief / DESIGN.md → "ANAS.gfx"):
 *   - The Pools grid renders capacity as a gfx bar (.anas-gfx-bar) and the pool
 *     state as a gfx status pill (.anas-gfx-pill) — the "monitor side" of the
 *     composer's visual language.
 *   - The Detail window's headline topology is a skeuomorphic bay-per-vdev
 *     graphic: .anas-pool-topo wrapper, .anas-pool-topo-bay per vdev, and
 *     .anas-gfx-diskcard disk tiles coloured by live health.
 *   - The per-disk read/write/checksum error-count tree (.anas-pool-topology)
 *     is retained below the graphic — no information is lost.
 *
 * The whole file skips when the reference pool is absent (box not set up / off).
 */

test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS pools status graphics (stunt node)', () => {
  test.setTimeout(120_000)

  test('renders gfx capacity bar + state pill in the Pools grid', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // The testpool row exists; its capacity cell renders a gfx fullness bar and
    // its state cell a gfx status pill.
    const row = grid.locator('.x-grid-row', { hasText: 'testpool' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(grid.locator('.anas-gfx-bar').first()).toBeVisible({ timeout: 20_000 })
    await expect(grid.locator('.anas-gfx-pill').first()).toBeVisible({ timeout: 20_000 })
  })

  test('renders skeuomorphic topology + retains the error-count tree in Detail', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    await grid.locator('.x-grid-row', { hasText: 'testpool' }).click()
    const detailBtn = page.locator('.anas-btn-detail')
    await expect(detailBtn).toBeEnabled({ timeout: 20_000 })
    await detailBtn.click()

    const win = page.locator('.anas-view-pool-detail')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // Headline graphic: wrapper, at least one vdev bay, at least one disk card.
    await expect(win.locator('.anas-pool-topo')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-pool-topo-bay').first()).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-gfx-diskcard').first()).toBeVisible({ timeout: 20_000 })

    // Secondary per-disk error-count tree is still present (no info lost).
    await expect(win.locator('.anas-pool-topology')).toBeVisible({ timeout: 20_000 })
  })
})
