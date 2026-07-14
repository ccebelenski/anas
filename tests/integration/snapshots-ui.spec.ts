import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { createSnapshot, destroySnapshot, listSnapshots, poolExists } from './fixtures/stunt-node'

/**
 * Epic 5 (ZFS Snapshots), stories 5.1–5.6 — full-chain ExtJS specs driven through
 * the real PVE UI on the stunt node (PVE login → ANAS node menu → native Datasets
 * grid → expand a dataset to reveal its snapshots). Companion to
 * snapshots-api.spec.ts, which covers the API contract directly. Modelled on
 * datasets-ui.spec.ts.
 *
 * Snapshots surface as CHILDREN of a dataset node inside the Datasets tree grid,
 * plus a dedicated popup listing all snapshots. UI hooks (task brief):
 *   - Datasets view/grid: '.anas-view-datasets', '.anas-grid-datasets'.
 *   - Snapshot leaf rows under a dataset node: '.anas-snap-row'.
 *   - Overflow node when a dataset has many snapshots: '.anas-snap-more'.
 *   - Toolbar buttons: '.anas-btn-snap-create' / -rollback / -rename / -destroy /
 *     -all (the last opens the popup).
 *   - Popup: window '.anas-win-snapshots' + grid '.anas-grid-snapshots'.
 *
 * Snapshots need NO spare disks — they live in the pre-existing 'testpool/share1'
 * dataset. Each test PRE-CREATES its snapshots directly on the system (this is
 * about the read/display path, not the create story) and tears them down in
 * afterEach. ExtJS boot + panel render is slow — timeouts are generous.
 */

const DS_FQ = 'testpool/share1'

// Snapshots pre-staged for the display tests. Cleaned in afterEach.
const SNAP_NAMES = ['uisnap1', 'uisnap2']

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

/**
 * Select the stunt node, open Datasets, and wait for the tree grid to render.
 */
async function openDatasets(page: Page): Promise<void> {
  await loginToPve(page)
  await openAnasItem(page, 'Datasets')
  await expect(page.locator('.anas-view-datasets')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })
}

/**
 * Expand the 'share1' dataset node in the Datasets tree so its snapshot children
 * render. Clicks the row's tree expander (ExtJS renders '.x-tree-expander' on
 * every expandable row).
 */
async function expandShare1(page: Page): Promise<void> {
  const grid = page.locator('.anas-grid-datasets')
  const node = grid.locator('.x-tree-node-text', { hasText: /^share1$/ })
  await expect(node).toBeVisible({ timeout: 45_000 })
  // The expander sits in the same tree row; walk up to the row, then click it.
  const row = node.locator('xpath=ancestor::*[contains(@class, "x-grid-item")][1]')
  await row.locator('.x-tree-expander').first().click()
}

test.describe('ANAS snapshots appear under a dataset (stunt node)', () => {
  test.setTimeout(120_000)

  test.beforeEach(async () => {
    // Start from a clean slate — destroy ALL of share1's snapshots (not just
    // ours), so a leftover from an earlier run can't break the exact row count.
    for (const name of await listSnapshots(DS_FQ))
      await destroySnapshot(DS_FQ, name)
    for (const name of SNAP_NAMES)
      await createSnapshot(DS_FQ, name)
  })

  test.afterEach(async () => {
    for (const name of SNAP_NAMES)
      await destroySnapshot(DS_FQ, name)
  })

  test('expanding the share1 dataset reveals its snapshot leaf rows', async ({ page }) => {
    await openDatasets(page)
    await expandShare1(page)

    // The pre-staged snapshots render as '.anas-snap-row' leaves under share1.
    const snapRows = page.locator('.anas-grid-datasets .anas-snap-row')
    await expect(snapRows.first()).toBeVisible({ timeout: 30_000 })
    await expect(snapRows).toHaveCount(SNAP_NAMES.length)

    // Each staged snapshot name is shown.
    for (const name of SNAP_NAMES)
      await expect(page.locator('.anas-snap-row', { hasText: name }).first()).toBeVisible({ timeout: 30_000 })
  })

  test('the snapshot toolbar exposes create/rollback/rename/destroy/all buttons', async ({ page }) => {
    await openDatasets(page)

    // Snapshot actions live on the Datasets toolbar (create-all is selection-free;
    // per-snapshot actions may be disabled until a snapshot row is selected — we
    // assert presence here, mirroring the dataset toolbar spec).
    for (const sel of [
      '.anas-btn-snap-create',
      '.anas-btn-snap-rollback',
      '.anas-btn-snap-rename',
      '.anas-btn-snap-destroy',
      '.anas-btn-snap-all',
    ]) {
      await expect(page.locator(sel)).toBeVisible({ timeout: 30_000 })
    }

    // "All Snapshots" opens the popup for the SELECTED dataset, so it enables
    // once a dataset row is selected (there's no dataset to show otherwise).
    await page.locator('.anas-grid-datasets').getByText('share1', { exact: true }).first().click()
    await expect(page.locator('.anas-btn-snap-all')).toBeEnabled({ timeout: 10_000 })
  })

  test('selecting a snapshot row enables the per-snapshot actions', async ({ page }) => {
    await openDatasets(page)
    await expandShare1(page)

    const snapRow = page.locator('.anas-grid-datasets .anas-snap-row').first()
    await expect(snapRow).toBeVisible({ timeout: 30_000 })
    await snapRow.click()

    // With a snapshot selected, the destructive/edit actions become enabled.
    for (const sel of ['.anas-btn-snap-rollback', '.anas-btn-snap-rename', '.anas-btn-snap-destroy'])
      await expect(page.locator(sel)).toBeEnabled({ timeout: 20_000 })
  })

  test('the All Snapshots button opens the popup grid listing the snapshots', async ({ page }) => {
    await openDatasets(page)
    await expandShare1(page)

    // Select the dataset so the popup is scoped to share1's snapshots.
    const node = page.locator('.anas-grid-datasets .x-tree-node-text', { hasText: /^share1$/ })
    await node.click()

    await page.locator('.anas-btn-snap-all').click()

    const win = page.locator('.anas-win-snapshots')
    await expect(win).toBeVisible({ timeout: 30_000 })
    const grid = win.locator('.anas-grid-snapshots')
    await expect(grid).toBeVisible({ timeout: 30_000 })

    // The popup grid lists the pre-staged snapshots.
    for (const name of SNAP_NAMES)
      await expect(grid.getByText(name).first()).toBeVisible({ timeout: 30_000 })
  })

  test('the Create Snapshot dialog pre-fills a snapshot-<datetime> name', async ({ page }) => {
    await openDatasets(page)
    // Select a dataset, open Create Snapshot; the name is pre-filled for speed
    // (a sortable timestamp) and overridable.
    await page.locator('.anas-grid-datasets .x-tree-node-text', { hasText: /^share1$/ }).click()
    await page.locator('.anas-btn-snap-create').click()
    await expect(page.locator('.anas-win-snap-create')).toBeVisible({ timeout: 20_000 })
    const value = await page.locator('.anas-fld-snap-name input').inputValue()
    expect(value).toMatch(/^snapshot-\d{4}-\d{2}-\d{2}-\d{6}$/)
  })
})

/**
 * Overflow node (5.1) — when a dataset has many snapshots the tree collapses them
 * behind a '.anas-snap-more' node rather than rendering an unbounded list inline.
 * Stages 6 snapshots (> the 5 threshold) to force the overflow to appear.
 */
test.describe('ANAS snapshot overflow node (many snapshots)', () => {
  test.setTimeout(120_000)

  const MANY = ['ov1', 'ov2', 'ov3', 'ov4', 'ov5', 'ov6']

  test.beforeEach(async () => {
    for (const name of MANY) {
      await destroySnapshot(DS_FQ, name)
      await createSnapshot(DS_FQ, name)
    }
  })

  test.afterEach(async () => {
    for (const name of MANY)
      await destroySnapshot(DS_FQ, name)
  })

  test('a dataset with >5 snapshots shows the .anas-snap-more overflow node', async ({ page }) => {
    // Sanity: the box really has all six staged (source of truth).
    expect((await listSnapshots(DS_FQ)).filter(n => MANY.includes(n)).length).toBe(MANY.length)

    await openDatasets(page)
    await expandShare1(page)

    await expect(page.locator('.anas-grid-datasets .anas-snap-more')).toBeVisible({ timeout: 30_000 })
  })
})
