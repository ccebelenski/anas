import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists } from './fixtures/stunt-node'

/**
 * Epic 15.1 — the ANAS.gfx de-risk checkpoint, verified inside the REAL PVE
 * ExtJS page on the stunt node. This is the one thing the local HTML spikes
 * could not prove: that the graphical layer renders under PVE's CSP, that ExtJS
 * event handling doesn't fight our native Pointer Events, and that a Playwright
 * hook can drive it.
 *
 * The "GFX Check" view (src/16-gfxcheck.js — TEMPORARY, removed with the
 * Composer) uses ONLY ANAS.gfx. This smoke asserts the three registers render
 * (a disk content-object, the breakdown donut, a control line-icon) and that a
 * disk drags from the available list into the vdev bay (client-side move).
 *
 * Resilient by design: skip-guarded on the stunt node being provisioned (the
 * gfx panel needs the gateway health probe to pass), and the drag assertion is
 * best-effort — a smoke, not an exhaustive drag suite. ExtJS boot is slow, so
 * timeouts are generous.
 */

test.beforeEach(async () => {
  test.skip(
    !(await poolExists('testpool')),
    'stunt node not provisioned (testpool absent) — run setup-test-data.sh',
  )
})

test.describe('ANAS.gfx checkpoint (stunt node)', () => {
  test.setTimeout(120_000)

  test('the GFX Check view renders all three visual registers', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'GFX Check')

    const view = page.locator('.anas-view-gfxcheck')
    await expect(view).toBeVisible({ timeout: 45_000 })

    // Content object: at least one skeuomorphic disk (the .anas-gfx-disk card
    // wraps an .anas-gfx-icon). Both hooks must be present.
    await expect(view.locator('.anas-gfx-disk').first()).toBeVisible({ timeout: 45_000 })
    await expect(view.locator('.anas-gfx-icon').first()).toBeVisible({ timeout: 20_000 })

    // A faulted disk renders the dead/greyscale variant.
    await expect(view.locator('.anas-gfx-icon-dead')).toHaveCount(1)

    // Data viz: the breakdown donut and the capacity gauge.
    await expect(view.locator('.anas-gfx-donut')).toBeVisible({ timeout: 20_000 })
    await expect(view.locator('.anas-gfx-gauge')).toBeVisible({ timeout: 20_000 })
    await expect(view.locator('.anas-gfx-legend-row').first()).toBeVisible({ timeout: 20_000 })

    // Control: at least one flat line-icon button (e.g. the trash danger ctl).
    await expect(view.locator('.anas-gfx-ctl').first()).toBeVisible({ timeout: 20_000 })
    await expect(view.locator('.anas-gfx-ctl-trash')).toHaveCount(1)

    // Theme inheritance: gfx stamps data-anas-theme on <html> (light or dark).
    await expect(page.locator('html')).toHaveAttribute('data-anas-theme', /light|dark/, { timeout: 20_000 })
  })

  test('dragging a disk from the list into the bay moves it', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'GFX Check')

    const view = page.locator('.anas-view-gfxcheck')
    await expect(view).toBeVisible({ timeout: 45_000 })

    const bay = view.locator('.anas-gfx-bay')
    await expect(bay).toBeVisible({ timeout: 45_000 })

    // Bay starts empty (no disk cards inside it).
    await expect(bay.locator('.anas-gfx-disk')).toHaveCount(0)

    const disk = view.locator('#gc-avail .anas-gfx-disk').first()
    await expect(disk).toBeVisible({ timeout: 20_000 })
    const diskId = await disk.getAttribute('data-id')

    // Drive the native Pointer Events drag with a manual mouse sequence (steps
    // so pointermove fires and the dropzone hit-test runs). Playwright's high-
    // level dragTo dispatches HTML5 DnD events, which our pointer-based helper
    // ignores — so we synthesise pointer moves via the mouse API.
    const box = await disk.boundingBox()
    const bayBox = await bay.boundingBox()
    if (!box || !bayBox)
      throw new Error('could not resolve drag geometry')

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // A couple of intermediate moves so pointermove + elementFromPoint run.
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20, { steps: 4 })
    await page.mouse.move(bayBox.x + bayBox.width / 2, bayBox.y + bayBox.height / 2, { steps: 8 })
    await page.mouse.up()

    // The dropped disk now lives inside the bay (client-side DOM move, no API).
    await expect(bay.locator(`.anas-gfx-disk[data-id="${diskId}"]`)).toHaveCount(1, { timeout: 20_000 })
  })
})
