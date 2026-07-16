import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import {
  createSnapshot,
  datasetExists,
  destroyDataset,
  destroySnapshot,
  listSnapshots,
  poolExists,
} from './fixtures/stunt-node'

/**
 * Replication stage 1 (story 5.5.1) — the "Replicate…" action on the Datasets
 * view, driven through the real PVE UI on the stunt node (PVE login → ANAS node
 * menu → native Datasets grid → select a dataset → open the Replicate dialog).
 * Companion to the daemon's replicate API specs.
 *
 * The dialog's headline feature is HONESTY: before running a local one-shot
 * `zfs send | zfs recv`, it shows the plan (full vs incremental, exact estimated
 * bytes, or a "diverged" dead-end). UI hooks (task brief):
 *   - Datasets view/grid: '.anas-view-datasets', '.anas-grid-datasets'.
 *   - Toolbar button: '.anas-btn-ds-replicate'.
 *   - Dialog window: '.anas-win-replicate'; plan line '.anas-repl-plan'
 *     (with '.anas-repl-diverged' when the plan cannot proceed).
 *   - Fields: '.anas-fld-repl-pool', '.anas-fld-repl-dataset',
 *     '.anas-fld-repl-snapshot', '.anas-fld-repl-snapfirst'; submit
 *     '.anas-btn-replicate-submit'.
 *
 * Uses the pre-existing 'testpool/share1' dataset. ExtJS boot + panel render is
 * slow — timeouts are generous.
 */

const POOL = 'testpool'
const DS_FQ = 'testpool/share1'

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
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
 * Select the 'share1' dataset row and open the Replicate dialog via the toolbar
 * button (enabled once a dataset is selected).
 */
async function openReplicateDialog(page: Page): Promise<void> {
  await page.locator('.anas-grid-datasets .x-tree-node-text', { hasText: /^share1$/ }).click()
  const btn = page.locator('.anas-btn-ds-replicate')
  await expect(btn).toBeEnabled({ timeout: 20_000 })
  await btn.click()
  await expect(page.locator('.anas-win-replicate')).toBeVisible({ timeout: 20_000 })
}

test.describe('ANAS replication dialog — plan preview (stunt node)', () => {
  test.setTimeout(120_000)

  // A single snapshot so the source has a valid, preselected send point.
  const SNAP = 'replui1'

  test.beforeEach(async () => {
    // Clean slate — remove ALL of share1's snapshots so the newest is ours.
    for (const name of await listSnapshots(DS_FQ))
      await destroySnapshot(DS_FQ, name)
    await createSnapshot(DS_FQ, SNAP)
  })

  test.afterEach(async () => {
    await destroySnapshot(DS_FQ, SNAP)
  })

  test('opening the dialog shows source, target fields and a plan line', async ({ page }) => {
    await openDatasets(page)
    await openReplicateDialog(page)

    const win = page.locator('.anas-win-replicate')
    // Target defaults are visible and adjustable.
    await expect(win.locator('.anas-fld-repl-pool')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-fld-repl-dataset input')).toHaveValue('share1', { timeout: 20_000 })

    // The plan line renders and resolves to an honest verdict (any mode). It may
    // pass through "calculating…" first; wait for a terminal state.
    const plan = win.locator('.anas-repl-plan')
    await expect(plan).toBeVisible({ timeout: 20_000 })
    await expect(plan).toHaveText(/Incremental|FULL send|plan unavailable/, { timeout: 30_000 })

    // Cancel — no mutation.
    await win.getByText('Cancel', { exact: true }).click()
    await expect(win).toBeHidden({ timeout: 20_000 })
  })
})

/**
 * End-to-end create — replicate share1@<fresh snap> into a throwaway
 * 'testpool/replspec' dataset (same pool is legal), poll the real system for the
 * dataset, then tear it down. Mirrors the pool-composer throwaway pattern.
 */
test.describe('ANAS replication runs a send | recv job (stunt node)', () => {
  test.setTimeout(180_000)

  const SNAP = 'replspecsnap'
  const TARGET_DS = 'replspec'
  const TARGET_FQ = `${POOL}/${TARGET_DS}`

  test.beforeEach(async () => {
    await destroyDataset(TARGET_FQ)
    for (const name of await listSnapshots(DS_FQ))
      await destroySnapshot(DS_FQ, name)
    await createSnapshot(DS_FQ, SNAP)
  })

  test.afterEach(async () => {
    await destroyDataset(TARGET_FQ)
    await destroySnapshot(DS_FQ, SNAP)
  })

  test('replicating share1 into testpool/replspec materialises the dataset', async ({ page }) => {
    await openDatasets(page)
    await openReplicateDialog(page)

    const win = page.locator('.anas-win-replicate')
    // Retarget the destination dataset (target pool defaults to the source pool).
    const dsField = win.locator('.anas-fld-repl-dataset input')
    await dsField.fill(TARGET_DS)

    // The lone fresh snapshot is preselected. Wait for the plan to resolve so the
    // Replicate button is enabled (a diverged/full plan still runs — a brand-new
    // target is a clean full send).
    const plan = win.locator('.anas-repl-plan')
    await expect(plan).toHaveText(/Incremental|FULL send|plan unavailable/, { timeout: 30_000 })

    const submit = win.locator('.anas-btn-replicate-submit')
    await expect(submit).toBeEnabled({ timeout: 20_000 })
    await submit.click()

    // The job creates the target on the real system (source of truth). Poll.
    await expect.poll(async () => datasetExists(TARGET_FQ), { timeout: 90_000, intervals: [2_000] })
      .toBe(true)
  })
})
