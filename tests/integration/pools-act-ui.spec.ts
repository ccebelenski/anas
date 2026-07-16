import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import {
  createTestPool,
  destroyPool,
  listSpareDisks,
  poolExists,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Epic 3 Act stories 3.7–3.14 — full-chain ExtJS specs driven through the real
 * PVE UI on the stunt node (PVE login → ANAS node menu → native Pools grid).
 *
 * Contracts under test (DESIGN.md → "UI: Native PVE Panels", task brief):
 *   - The Pools grid toolbar exposes action buttons:
 *       .anas-btn-create, .anas-btn-import      — always enabled (no selection)
 *       .anas-btn-modify, .anas-btn-addvdev,
 *       .anas-btn-attach, .anas-btn-export,
 *       .anas-btn-destroy                       — enabled only with a row selected
 *   - Their mutation windows carry .anas-win-modify / etc. Create AND Add Vdevs
 *     both launch the graphical Pool Composer (.anas-win-composer, Epic 15.2 /
 *     3.23): Create in create mode, Add Vdevs in expand mode against the selected
 *     pool (the dedicated single-vdev Add-Vdev window is retired).
 *   - Export/destroy use Ext.Msg.confirm (standard Yes/No) rather than a custom
 *     window, wiring the 409 + x-anas-confirm-code contract behind the UI.
 *
 * The safety story (3.13/3.14) is verified end-to-end on a THROWAWAY pool created
 * in setup — never on testpool — and cleaned up in afterEach. ExtJS boot + panel
 * render is slow, so timeouts are generous.
 */

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

const SELECTION_ACTIONS = [
  '.anas-btn-modify',
  '.anas-btn-addvdev',
  '.anas-btn-attach',
  '.anas-btn-export',
  '.anas-btn-destroy',
]
const ALWAYS_ACTIONS = ['.anas-btn-create', '.anas-btn-import']

test.describe('ANAS pool action toolbar (stunt node)', () => {
  test.setTimeout(120_000)

  test('exposes create/import always, and per-selection actions on the Pools grid', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // create/import need no selection — visible and enabled immediately.
    for (const sel of ALWAYS_ACTIONS) {
      const btn = page.locator(sel)
      await expect(btn).toBeVisible({ timeout: 20_000 })
      await expect(btn).toBeEnabled()
    }

    // Before any selection, the per-row actions exist but are disabled. ExtJS
    // marks a disabled button with the x-btn-disabled / x-item-disabled class on
    // the same element that carries our .anas-btn-* cls — more reliable than
    // toBeDisabled(), which depends on aria-disabled being emitted.
    for (const sel of SELECTION_ACTIONS) {
      const btn = page.locator(sel)
      await expect(btn).toBeVisible({ timeout: 20_000 })
      await expect(btn).toHaveClass(/x-item-disabled|x-btn-disabled/)
    }

    // Selecting testpool enables all per-row actions (click the row element —
    // ExtJS binds selection to .x-grid-row, not the inner text span).
    await grid.locator('.x-grid-row', { hasText: 'testpool' }).click()
    for (const sel of SELECTION_ACTIONS)
      await expect(page.locator(sel)).toBeEnabled({ timeout: 20_000 })
  })

  test('gates Trim by device capability and Upgrade by availability (story 4.12)', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    await grid.locator('.x-grid-row', { hasText: 'testpool' }).click()

    const DISABLED = /x-item-disabled|x-btn-disabled/

    // Trim: the stunt node's pool disks are QEMU virtual disks, which DO report
    // discard support (DISC-GRAN > 0), so trimSupported is true → Trim enabled.
    const trimBtn = page.locator('.anas-btn-pool-trim')
    await expect(trimBtn).toBeVisible({ timeout: 20_000 })
    await expect(trimBtn).not.toHaveClass(DISABLED, { timeout: 20_000 })

    // Upgrade: the stunt pools are freshly created on current ZFS, so all
    // supported features are already enabled → upgradeAvailable false → Upgrade
    // stays DISABLED even with a pool selected.
    const upgradeBtn = page.locator('.anas-btn-pool-upgrade')
    await expect(upgradeBtn).toBeVisible({ timeout: 20_000 })
    await expect(upgradeBtn).toHaveClass(DISABLED, { timeout: 20_000 })
  })

  test('the Create button opens the Pool Composer window', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    await expect(page.locator('.anas-grid-pools')).toBeVisible({ timeout: 45_000 })
    // The Create action now launches the graphical Pool Composer (Epic 15.2 /
    // story 3.23), superseding the old simple-create window.
    await page.locator('.anas-btn-create').click()
    await expect(page.locator('.anas-win-composer')).toBeVisible({ timeout: 20_000 })
  })

  test('the Add Vdevs button opens the Pool Composer in expand mode', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    await grid.locator('.x-grid-row', { hasText: 'testpool' }).click()

    // Add Vdevs (formerly the dedicated Add-Vdev window, now retired) launches
    // the composer in expand mode against the selected pool (Epic 15.2 / 3.21).
    const addBtn = page.locator('.anas-btn-addvdev')
    await expect(addBtn).toBeEnabled({ timeout: 20_000 })
    await addBtn.click()
    const win = page.locator('.anas-win-composer')
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect(win).toContainText('Expand Pool', { timeout: 20_000 })
  })

  test('the Modify button opens the .anas-win-modify window for the selected pool', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    await grid.locator('.x-grid-row', { hasText: 'testpool' }).click()

    const modifyBtn = page.locator('.anas-btn-modify')
    await expect(modifyBtn).toBeEnabled({ timeout: 20_000 })
    await modifyBtn.click()
    await expect(page.locator('.anas-win-modify')).toBeVisible({ timeout: 20_000 })
  })
})

/**
 * Export safety (3.13) — end-to-end on a THROWAWAY pool. Serialized because it
 * creates and tears down a real pool; each test both pre-cleans (beforeEach) and
 * post-cleans (afterEach) so a crash can't leak disks between runs.
 */
test.describe.serial('ANAS pool export safety (throwaway pool)', () => {
  test.setTimeout(180_000)

  const THROW = 'anasactui'
  let spares: string[] = []

  test.beforeEach(async () => {
    // Pre-clean BEFORE counting spares so a leftover throwaway frees its disk.
    await destroyPool(THROW)
    spares = await listSpareDisks()
    test.skip(spares.length < 1, 'no spare disks — attach one with add-disk.sh')
    await createTestPool(THROW, [spares[0]])
    // A child dataset makes export a genuine (consequential) confirmation.
    await sshExec(`zfs create ${THROW}/child`).catch(() => {})
  })

  test.afterEach(async () => {
    // destroyPool handles both an imported pool and one left exported by the test.
    await destroyPool(THROW)
  })

  test('exporting via the toolbar shows an Ext.Msg.confirm and exports the pool', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // The throwaway pool was created before the grid loaded, so it lists it.
    const row = grid.locator('.x-grid-row', { hasText: THROW })
    await expect(row).toBeVisible({ timeout: 45_000 })
    await row.click()

    const exportBtn = page.locator('.anas-btn-export')
    await expect(exportBtn).toBeEnabled({ timeout: 20_000 })
    await exportBtn.click()

    // The 409 + x-anas-confirm-code contract surfaces as an Ext.Msg.confirm with
    // standard Yes/No buttons (DESIGN: export/destroy don't use a custom window).
    const confirmDialog = page.locator('.x-message-box:visible')
    await expect(confirmDialog).toBeVisible({ timeout: 30_000 })
    const yes = page.getByRole('button', { name: 'Yes' })
    await expect(yes).toBeVisible({ timeout: 20_000 })
    await yes.click()

    // Source of truth: the pool leaves the imported set on the real system.
    await expect.poll(() => poolExists(THROW), { timeout: 60_000 }).toBe(false)
  })
})
