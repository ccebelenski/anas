import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists } from './fixtures/stunt-node'

/**
 * Stories 3.25 / 3.26 — ANAS recognizes pools PVE already manages (read from
 * /etc/pve/storage.cfg → PoolSummary.pveStorages) and treats them as PVE's
 * territory: distinctly badged and hands-off, while ANAS-managed pools stay
 * fully manageable. Two-case bed on the stunt node: `datapool` (a PVE `zfspool`
 * storage) vs `testpool` (ANAS-managed).
 *
 * Skip-guarded on both pools existing so the file no-ops on a box without the
 * PVE storage set up (`pvesm add zfspool datapool --pool datapool`).
 */

// ExtJS marks a disabled tool/button with one of these (mirrors the composer spec).
const DISABLED = /x-item-disabled|x-btn-disabled/

test.beforeEach(async () => {
  test.skip(!(await poolExists('datapool')), 'datapool (PVE-managed) not present — add a zfspool storage')
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS PVE-managed pools (stunt node)', () => {
  test.setTimeout(120_000)

  test('Pools: the PVE pool is badged and its structural actions are disabled', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')
    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // datapool carries the PVE badge; testpool does not.
    const pveRow = grid.locator('.x-grid-row', { hasText: 'datapool' })
    await expect(pveRow).toBeVisible({ timeout: 20_000 })
    await expect(pveRow.locator('.anas-pool-pve-badge')).toBeVisible({ timeout: 20_000 })
    await expect(
      grid.locator('.x-grid-row', { hasText: 'testpool' }).locator('.anas-pool-pve-badge'),
    ).toHaveCount(0)

    // Selecting the PVE pool: destructive/structural actions disabled, but the
    // safe monitor actions (Scrub) stay live.
    await pveRow.click()
    await expect(page.locator('.anas-btn-destroy')).toHaveClass(DISABLED, { timeout: 20_000 })
    await expect(page.locator('.anas-btn-export')).toHaveClass(DISABLED)
    await expect(page.locator('.anas-btn-scrub')).not.toHaveClass(DISABLED)

    // Selecting the ANAS pool re-enables the structural actions.
    await grid.locator('.x-grid-row', { hasText: 'testpool' }).click()
    await expect(page.locator('.anas-btn-destroy')).not.toHaveClass(DISABLED, { timeout: 20_000 })
  })

  test('Datasets: PVE pool root is banded + gated; ANAS pool root is not', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')
    const grid = page.locator('.anas-grid-datasets')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // datapool's row is PVE-banded and shows at least one gated (soft-disabled)
    // action control — the "+ create child" the user specifically called out.
    const pveRow = grid.locator('.anas-ds-pve-row', { hasText: 'datapool' }).first()
    await expect(pveRow).toBeVisible({ timeout: 20_000 })
    await expect(pveRow.locator('[data-anas-gated]').first()).toBeVisible({ timeout: 20_000 })

    // testpool (ANAS-managed) is never PVE-banded — the marker is specific.
    await expect(grid.locator('.anas-ds-pve-row', { hasText: 'testpool' })).toHaveCount(0)
  })
})
