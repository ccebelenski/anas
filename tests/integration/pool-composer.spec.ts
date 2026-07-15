import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { destroyPool, listSpareDisks, poolExists } from './fixtures/stunt-node'

/**
 * Epic 15.2 / story 3.23 — the graphical Pool Composer, verified inside the REAL
 * PVE ExtJS page on the stunt node. The composer is built entirely on ANAS.gfx
 * (native pointer-drag, skeuomorphic disk objects, capacity gauge) and holds a
 * client-side draft that commits ONE POST /pools on success.
 *
 * Coverage:
 *   - Launch from the Pools "Create" action → the .anas-win-composer window.
 *   - Add a vdev, drag available disks into its bay (native Pointer Events driven
 *     by a manual mouse sequence, exactly like the retired gfx-check smoke), and
 *     assert the summary updates and Create enables ONLY when the draft is valid
 *     (a lone-disk mirror keeps Create disabled).
 *   - A real end-to-end pool create — disk-dependent, so skip-gated on available
 *     spare disks existing (mirrors the spare-gated Act specs) and self-cleaning.
 *
 * Resilient by design: skip-guarded on the stunt node being provisioned and on
 * spare disks being present. ExtJS boot is slow, so timeouts are generous.
 */

const DISABLED = /x-item-disabled|x-btn-disabled/

// Drive the composer's native pointer-drag: pick up `disk`, move over the bay in
// steps so pointermove + elementFromPoint run, then drop. Playwright's high-level
// dragTo dispatches HTML5 DnD events, which the pointer-based helper ignores.
async function dragDiskIntoBay(page: Page, diskSel: string, baySel: string): Promise<void> {
  const disk = page.locator(diskSel).first()
  await expect(disk).toBeVisible({ timeout: 20_000 })
  const bay = page.locator(baySel).first()
  await expect(bay).toBeVisible({ timeout: 20_000 })

  const box = await disk.boundingBox()
  const bayBox = await bay.boundingBox()
  if (!box || !bayBox)
    throw new Error('could not resolve drag geometry')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20, { steps: 4 })
  await page.mouse.move(bayBox.x + bayBox.width / 2, bayBox.y + bayBox.height / 2, { steps: 8 })
  await page.mouse.up()
}

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS Pool Composer (stunt node)', () => {
  test.setTimeout(150_000)

  test('launches from the Pools grid and gates Create on draft validity', async ({ page }) => {
    const spares = await listSpareDisks()
    test.skip(spares.length < 2, 'need >= 2 spare disks — attach with add-disk.sh')

    await loginToPve(page)
    await openAnasItem(page, 'Pools')
    await expect(page.locator('.anas-grid-pools')).toBeVisible({ timeout: 45_000 })

    // Launch the composer from the Create action.
    await page.locator('.anas-btn-composer-open').click()
    const win = page.locator('.anas-win-composer')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // Available disks load from GET /disks (status available) — at least the two
    // spares appear as draggable gfx disk cards.
    await expect(win.locator('#anasc-avail .anas-composer-disk').first()).toBeVisible({ timeout: 30_000 })

    // Create is disabled with an empty draft.
    const createBtn = page.locator('.anas-btn-composer-create')
    await expect(createBtn).toHaveClass(DISABLED)

    // Add a data vdev (defaults to a mirror) → an empty bay appears; still invalid.
    await win.locator('.anas-btn-composer-addvdev').click()
    await expect(win.locator('.anas-composer-bay')).toHaveCount(1, { timeout: 20_000 })
    await expect(createBtn).toHaveClass(DISABLED)

    // Drag ONE disk in → a lone-disk mirror is below its min: Create stays disabled.
    await dragDiskIntoBay(page, '#anasc-avail .anas-composer-disk', '[data-anas-zone^="vdev:"]')
    await expect(win.locator('[data-anas-zone^="vdev:"] .anas-composer-disk')).toHaveCount(1, { timeout: 20_000 })
    await expect(createBtn).toHaveClass(DISABLED)

    // Drag a SECOND disk in → the mirror meets its min and the pool is valid:
    // Create enables and the summary reflects usable capacity.
    await dragDiskIntoBay(page, '#anasc-avail .anas-composer-disk', '[data-anas-zone^="vdev:"]')
    await expect(win.locator('[data-anas-zone^="vdev:"] .anas-composer-disk')).toHaveCount(2, { timeout: 20_000 })
    await expect(createBtn).not.toHaveClass(DISABLED, { timeout: 20_000 })
    await expect(win.locator('.anas-composer-summary')).toContainText('Usable', { timeout: 20_000 })

    // Nothing is committed — cancel leaves the system untouched.
    await page.locator('.anas-btn-composer-cancel').click()
    await expect(win).not.toBeVisible({ timeout: 20_000 })
  })
})

/**
 * End-to-end create on a THROWAWAY pool. Serialized because it creates and tears
 * down a real pool; both pre-cleans (beforeEach) and post-cleans (afterEach) so a
 * crash can't leak disks between runs. Skip-gated on >= 2 spare disks.
 */
test.describe.serial('ANAS Pool Composer create (throwaway pool)', () => {
  test.setTimeout(210_000)

  const THROW = 'anascomp'

  test.beforeEach(async () => {
    // Pre-clean BEFORE counting spares so a leftover throwaway frees its disks.
    await destroyPool(THROW)
  })

  test.afterEach(async () => {
    await destroyPool(THROW)
  })

  test('builds a mirror in the composer and creates the pool for real', async ({ page }) => {
    const spares = await listSpareDisks()
    test.skip(spares.length < 2, 'need >= 2 spare disks — attach with add-disk.sh')

    await loginToPve(page)
    await openAnasItem(page, 'Pools')
    await expect(page.locator('.anas-grid-pools')).toBeVisible({ timeout: 45_000 })

    await page.locator('.anas-btn-composer-open').click()
    const win = page.locator('.anas-win-composer')
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('#anasc-avail .anas-composer-disk').first()).toBeVisible({ timeout: 30_000 })

    // Name the throwaway pool.
    await win.locator('.anas-fld-composer-poolname').fill(THROW)

    // Add a mirror data vdev and drag two disks in.
    await win.locator('.anas-btn-composer-addvdev').click()
    await expect(win.locator('.anas-composer-bay')).toHaveCount(1, { timeout: 20_000 })
    await dragDiskIntoBay(page, '#anasc-avail .anas-composer-disk', '[data-anas-zone^="vdev:"]')
    await dragDiskIntoBay(page, '#anasc-avail .anas-composer-disk', '[data-anas-zone^="vdev:"]')
    await expect(win.locator('[data-anas-zone^="vdev:"] .anas-composer-disk')).toHaveCount(2, { timeout: 20_000 })

    const createBtn = page.locator('.anas-btn-composer-create')
    await expect(createBtn).not.toHaveClass(DISABLED, { timeout: 20_000 })
    await createBtn.click()

    // Source of truth: the pool now exists on the real system (one POST /pools).
    await expect.poll(() => poolExists(THROW), { timeout: 90_000 }).toBe(true)
  })
})
