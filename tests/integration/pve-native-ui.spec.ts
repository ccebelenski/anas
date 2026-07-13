import { expect, test } from '@playwright/test'
import { anasGroup, loginToPve, NODE_NAME, openAnasItem, selectNode } from './fixtures/pve-ui'
import { getZpoolStatus, poolExists, sshExec } from './fixtures/stunt-node'

/**
 * Stories 13.9–13.14 — the native ExtJS panels, verified end-to-end through the
 * real PVE UI on the stunt node: PVE login → ANAS node menu → panels rendering
 * real data → the scrub job flow → the "not installed" degrade path.
 *
 * Contracts under test (DESIGN.md → "UI: Native PVE Panels", "PVE UI Integration"):
 *   - The node menu gains an expanded ANAS group with items Dashboard, Pools,
 *     Disks — each a NATIVE ExtJS panel (no iframe, retired with the Vue app).
 *   - Panel DOM hooks: '.anas-view-{pools,disks,dashboard}', grids
 *     '.anas-grid-{pools,disks}', buttons '.anas-btn-{scrub,smart}'.
 *   - The Pools grid shows the real pool `testpool`; Start Scrub drives
 *     POST /api/nodes/<node>/v1/pools/testpool/scrub → 202 and zpool status
 *     shows the scrub.
 *   - With the anas service stopped, opening an ANAS item renders the friendly
 *     "ANAS is not installed on this node" panel (the Ceph pattern).
 *
 * ExtJS boot + panel render is slow, so timeouts are generous throughout.
 */

// Skip-guard the whole file when the real pool is absent (mirrors the old specs),
// via the poolExists helper. This also covers the stunt node being off:
// poolExists swallows SSH failures and returns false → the file skips cleanly.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('ANAS native panels (stunt node)', () => {
  test.setTimeout(120_000)

  test('the node menu shows the ANAS group with Dashboard, Pools, Disks', async ({ page }) => {
    await loginToPve(page)
    await selectNode(page)

    // Scope to the ANAS group's subtree — Ceph has a hidden 'Pools' too, so a
    // page-wide match is ambiguous.
    const group = anasGroup(page)
    await expect(group).toBeVisible({ timeout: 20_000 })
    for (const item of ['Dashboard', 'Pools', 'Disks'])
      await expect(group.getByText(item, { exact: true })).toBeVisible({ timeout: 20_000 })
  })

  test('Pools renders a native grid containing testpool, with no iframe', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const view = page.locator('.anas-view-pools')
    await expect(view).toBeVisible({ timeout: 45_000 })

    const grid = view.locator('.anas-grid-pools')
    await expect(grid.getByText('testpool')).toBeVisible({ timeout: 45_000 })

    // Native, not embedded: the retired iframe approach must be gone entirely.
    await expect(view.locator('iframe')).toHaveCount(0)
  })

  test('Start Scrub on testpool posts a 202 job and runs a real scrub', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    const grid = page.locator('.anas-grid-pools')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // Select the testpool row, then trigger the toolbar scrub action.
    await grid.getByText('testpool').click()
    const scrubBtn = page.locator('.anas-btn-scrub')
    await expect(scrubBtn).toBeVisible({ timeout: 20_000 })
    await expect(scrubBtn).toBeEnabled()

    // The mutation goes through the job API (202 Accepted, DESIGN Principle 4).
    const [scrubResponse] = await Promise.all([
      page.waitForResponse(
        r => r.url().includes(`/api/nodes/${NODE_NAME}/v1/pools/testpool/scrub`)
          && r.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      scrubBtn.click(),
    ])
    expect(scrubResponse.status()).toBe(202)

    // Source of truth: zpool status on the real system shows the scrub. A 512M
    // empty mirror finishes almost instantly, so match either state (mirrors the
    // old scrub.spec.ts poll).
    await expect
      .poll(async () => getZpoolStatus('testpool'), { timeout: 30_000 })
      .toMatch(/scrub in progress|scrub repaired/)
  })

  test('Dashboard renders and mentions testpool', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Dashboard')

    const view = page.locator('.anas-view-dashboard')
    await expect(view).toBeVisible({ timeout: 45_000 })
    await expect(view.getByText('testpool')).toBeVisible({ timeout: 45_000 })
  })

  test('Disks lists disks and opens a SMART window', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Disks')

    const view = page.locator('.anas-view-disks')
    await expect(view).toBeVisible({ timeout: 45_000 })

    const grid = view.locator('.anas-grid-disks')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    // At least one disk row (ExtJS renders grid rows as .x-grid-row).
    const rows = grid.locator('.x-grid-row')
    await expect(rows.first()).toBeVisible({ timeout: 45_000 })
    await rows.first().click()

    const smartBtn = page.locator('.anas-btn-smart')
    await expect(smartBtn).toBeVisible({ timeout: 20_000 })
    await smartBtn.click()

    // The SMART detail renders as an Ext.window.Window.
    await expect(page.locator('.x-window')).toBeVisible({ timeout: 30_000 })
  })
})

/**
 * "Not installed" degrade path — MUST run last and in isolation. It stops the
 * anas service, so it's serialized and always restarts the service afterward
 * (even on assertion failure) to avoid poisoning any spec that follows.
 */
test.describe.serial('ANAS not installed (service stopped)', () => {
  test.setTimeout(120_000)

  test.afterEach(async () => {
    // ALWAYS restore the service, even if the test above failed or was skipped —
    // starting an already-running service is a harmless no-op.
    await sshExec('systemctl start anas')
  })

  test('opening an ANAS item shows the not-installed panel', async ({ page }) => {
    // Simulate a node where ANAS isn't running: the panel's health probe to the
    // gateway fails and it must render the friendly degrade panel (Ceph pattern).
    await sshExec('systemctl stop anas')

    await loginToPve(page)
    await openAnasItem(page, 'Pools')

    await expect(page.getByText('ANAS is not installed on this node'))
      .toBeVisible({ timeout: 30_000 })
  })
})
