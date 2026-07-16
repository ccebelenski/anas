import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists } from './fixtures/stunt-node'

/**
 * Epic 2 (stories 2.1–2.7) + gfx retrofit 15.5 — the ANAS Dashboard. Full-chain
 * ExtJS specs driven through the real PVE UI on the stunt node (PVE login → ANAS
 * node menu → native Dashboard panel).
 *
 * Contracts under test (task brief / DESIGN.md → "ANAS.gfx"):
 *   - The Dashboard is a native ExtJS panel (.anas-view-dashboard) with a manual
 *     Refresh button (.anas-btn-dash-refresh) and the labelled sections that read
 *     from GET /v1/status and GET /v1/telemetry.
 *   - Section containers carry stable test hooks, top → bottom:
 *     .anas-dash-warnings / .anas-dash-fleet (moved to the TOP) / .anas-dash-pools
 *     (the nested Pool → VDEV → Device composite that absorbed the old pool-health,
 *     pool-I/O and disk-I/O sections) / .anas-dash-arc / .anas-dash-net, plus the
 *     toolbar freshness line .anas-dash-status. (The old .anas-dash-overview /
 *     .anas-dash-io / .anas-dash-disks / .anas-dash-shares sections are gone.)
 *   - Fail-open: whether or not the /status and /telemetry endpoints are live,
 *     the panel renders (never breaks the PVE UI) and each section degrades to a
 *     rendered state rather than throwing.
 *   - The telemetry poll is torn down when the panel is left (no leaked interval)
 *     — navigating to another ANAS view and back keeps the Dashboard functional.
 *
 * The whole file skips when the reference pool is absent (box not set up / off).
 */

test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS dashboard (stunt node)', () => {
  test.setTimeout(120_000)

  test('renders the dashboard panel with its sections and Refresh', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Dashboard')

    const view = page.locator('.anas-view-dashboard')
    await expect(view).toBeVisible({ timeout: 45_000 })

    // Manual refresh control (2.6 status load) + telemetry freshness line (2.7).
    await expect(view.locator('.anas-btn-dash-refresh')).toBeVisible({ timeout: 20_000 })
    await expect(view.locator('.anas-dash-status')).toBeVisible({ timeout: 20_000 })

    // The labelled sections are all present as stable containers, regardless of
    // whether the endpoints returned data (each degrades in place, fail-open).
    // Order matters: the fleet is at the top, pools is the headline composite.
    for (const cls of [
      '.anas-dash-fleet',
      '.anas-dash-pools',
      '.anas-dash-arc',
      '.anas-dash-net',
    ]) {
      await expect(view.locator(cls)).toBeVisible({ timeout: 20_000 })
    }

    // The old sections were folded away by the re-layout — assert they are gone.
    for (const cls of ['.anas-dash-overview', '.anas-dash-io', '.anas-dash-disks', '.anas-dash-shares']) {
      await expect(view.locator(cls)).toHaveCount(0)
    }

    // Fleet sits above the Pools composite in the DOM (fleet-at-top).
    const fleetBox = await view.locator('.anas-dash-fleet').boundingBox()
    const poolsBox = await view.locator('.anas-dash-pools').boundingBox()
    expect(fleetBox && poolsBox && fleetBox.y < poolsBox.y).toBeTruthy()

    // The Pools composite renders at least one pool block (fed by /status).
    await expect(view.locator('.anas-dash-pools .anas-dash-pool').first()).toBeVisible({
      timeout: 20_000,
    })

    // When live telemetry lands, the Pool → VDEV → Device nesting appears:
    // devices (.anas-dash-disk) live INSIDE a vdev (.anas-dash-vdev) inside a
    // pool. Tolerant of telemetry not (yet) being available — fail-open.
    const vdevCount = await view.locator('.anas-dash-pools .anas-dash-vdev').count()
    if (vdevCount > 0) {
      await expect(
        view.locator('.anas-dash-pools .anas-dash-vdev').first(),
      ).toBeVisible({ timeout: 20_000 })
      const nestedDisks = await view
        .locator('.anas-dash-pools .anas-dash-vdev .anas-dash-disk')
        .count()
      expect(nestedDisks).toBeGreaterThan(0)
    }
  })

  test('survives leaving and returning (poll teardown, no broken UI)', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Dashboard')
    await expect(page.locator('.anas-view-dashboard')).toBeVisible({ timeout: 45_000 })

    // Switch to another ANAS view (Dashboard deactivates → its telemetry poll
    // must stop) then come back — the panel is intact and still polling-capable.
    await openAnasItem(page, 'Pools')
    await expect(page.locator('.anas-grid-pools')).toBeVisible({ timeout: 45_000 })

    await openAnasItem(page, 'Dashboard')
    const view = page.locator('.anas-view-dashboard')
    await expect(view).toBeVisible({ timeout: 45_000 })
    await expect(view.locator('.anas-dash-status')).toBeVisible({ timeout: 20_000 })

    // Manual refresh still works after the round-trip.
    await view.locator('.anas-btn-dash-refresh').click()
    await expect(view.locator('.anas-dash-pools')).toBeVisible({ timeout: 20_000 })
  })
})
