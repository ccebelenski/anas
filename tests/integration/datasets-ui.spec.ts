import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { datasetExists, destroyDataset, poolExists } from './fixtures/stunt-node'

/**
 * Epic 4 (ZFS Datasets), stories 4.1–4.8 — full-chain ExtJS specs driven through
 * the real PVE UI on the stunt node (PVE login → ANAS node menu → native
 * Datasets grid). Companion to datasets-api.spec.ts, which covers the API
 * contract directly.
 *
 * Contracts under test (DESIGN.md → "UI: Native PVE Panels" + task brief):
 *   - The ANAS node menu gains a 'Datasets' item → a NATIVE ExtJS panel.
 *   - Panel DOM hooks: '.anas-view-datasets', grid '.anas-grid-datasets'.
 *   - Toolbar buttons: '.anas-btn-ds-create' (always), and -detail / -edit /
 *     -perms / -destroy (per selection).
 *   - Mutation windows: '.anas-win-dataset-create' / -detail / -perms.
 *   - The grid lists real datasets, including the pool root 'testpool'.
 *   - Creating via the window makes the dataset appear on the real system.
 *
 * ExtJS boot + panel render is slow, so timeouts are generous throughout.
 * Destructive work is confined to a THROWAWAY dataset, torn down in afterEach.
 */

const DS_CREATE_UI = 'testpool/itestui'

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS Datasets panel (stunt node)', () => {
  test.setTimeout(120_000)

  test('Datasets renders a native grid containing testpool, with no iframe', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    const view = page.locator('.anas-view-datasets')
    await expect(view).toBeVisible({ timeout: 45_000 })

    const grid = page.locator('.anas-grid-datasets')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    // The flat list includes the pool root dataset.
    await expect(grid.getByText('testpool').first()).toBeVisible({ timeout: 45_000 })

    // Native, not embedded: the retired iframe approach must be gone entirely.
    await expect(page.locator('.anas-view-datasets iframe')).toHaveCount(0)
  })

  test('the Datasets toolbar exposes create/detail/edit/perms/destroy buttons', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })

    // Create needs no selection — visible and enabled immediately.
    const createBtn = page.locator('.anas-btn-ds-create')
    await expect(createBtn).toBeVisible({ timeout: 20_000 })
    await expect(createBtn).toBeEnabled()

    // The per-selection actions exist in the toolbar (they may be disabled until a
    // row is selected — we only assert their presence here, mirroring the pool
    // toolbar spec's approach).
    for (const sel of ['.anas-btn-ds-detail', '.anas-btn-ds-edit', '.anas-btn-ds-perms', '.anas-btn-ds-destroy']) {
      await expect(page.locator(sel)).toBeVisible({ timeout: 20_000 })
    }
  })

  test('the Create button opens the .anas-win-dataset-create window', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })
    await page.locator('.anas-btn-ds-create').click()
    await expect(page.locator('.anas-win-dataset-create')).toBeVisible({ timeout: 20_000 })
  })
})

/**
 * Create-via-UI (4.5) — end-to-end on a THROWAWAY dataset. Serialized because it
 * mutates the real system; each test both pre-cleans (beforeEach) and post-cleans
 * (afterEach) so a crash can't leak state between runs.
 */
test.describe.serial('ANAS dataset create via UI (throwaway dataset)', () => {
  test.setTimeout(150_000)

  test.beforeEach(async () => {
    await destroyDataset(DS_CREATE_UI)
  })

  test.afterEach(async () => {
    await destroyDataset(DS_CREATE_UI)
  })

  test('filling the create window makes the dataset appear on the real system', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')

    await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })
    await page.locator('.anas-btn-ds-create').click()

    const win = page.locator('.anas-win-dataset-create')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // The window's first text field is the dataset name/path. Fill it with the
    // throwaway leaf name (the window carries the parent-pool context).
    const nameField = win.locator('input[type="text"]').first()
    await expect(nameField).toBeVisible({ timeout: 20_000 })
    await nameField.fill('itestui')

    // Submit — Proxmox.window.Edit subclasses expose a Create/OK/Add/Submit
    // button and handle the 202 job + 4xx display internally.
    await page.getByRole('button', { name: /Create|OK|Add|Submit|Save/i }).first().click()

    // Source of truth: the dataset really exists on the system (async job).
    await expect.poll(() => datasetExists(DS_CREATE_UI), { timeout: 60_000 }).toBe(true)
  })
})
