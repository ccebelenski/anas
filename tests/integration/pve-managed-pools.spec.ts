import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { datasetExists, poolExists, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * Stories 3.25 / 3.26 — ANAS recognizes pools PVE already manages (read from
 * /etc/pve/storage.cfg → PoolSummary.pveStorages) and treats them as PVE's
 * territory: distinctly badged, the pool's structure hands-off, while
 * ANAS-managed pools stay fully manageable. Since pvepool.1/.2 ownership is
 * per dataset: the storage root itself stays view-only but may take ANAS
 * children (Create stays live on it). Two-case bed on the stunt node:
 * `datapool` (a PVE `zfspool` storage on the pool root) vs `testpool`
 * (ANAS-managed).
 *
 * Skip-guarded on both pools existing so the file no-ops on a box without the
 * PVE storage set up (`pvesm add zfspool datapool --pool datapool`).
 */

// ExtJS marks a disabled tool/button with one of these (mirrors the composer spec).
const DISABLED = /x-item-disabled|x-btn-disabled/

test.beforeEach(async () => {
  skipIfFixtureMissing(!(await poolExists('datapool')), 'datapool (PVE-managed) not present — add a zfspool storage')
  skipIfFixtureMissing(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
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

    // datapool's row is PVE-banded and carries the PVE badge whose tooltip is
    // the ownership reason (shared pve-footprint.ts: the pool root is a
    // storage root). (Operator ruling 2026-08-19: the row-icon Actions column
    // is gone — the badge tooltip is now the only home of that explanation,
    // and the toolbar does the gating.)
    const pveRow = grid.locator('.anas-ds-pve-row', { hasText: 'datapool' }).first()
    await expect(pveRow).toBeVisible({ timeout: 20_000 })
    const badge = pveRow.locator('.anas-ds-pve-badge').first()
    await expect(badge).toBeVisible({ timeout: 20_000 })
    await expect(badge).toHaveAttribute('title', 'PVE storage \'datapool\' owns datapool as a storage root')

    // Selecting it gates the structural toolbar actions (Destroy, Edit,
    // Permissions); read-only Detail stays. Create stays live: a storage root
    // takes ANAS children outside PVE's guest-volume namespace (pvepool.2,
    // createChildAllowed — the daemon answers childrenManageable true).
    await pveRow.click()
    await expect(page.locator('.anas-btn-ds-destroy')).toHaveClass(DISABLED, { timeout: 20_000 })
    await expect(page.locator('.anas-btn-ds-edit')).toHaveClass(DISABLED)
    await expect(page.locator('.anas-btn-ds-perms')).toHaveClass(DISABLED)
    await expect(page.locator('.anas-btn-ds-detail')).not.toHaveClass(DISABLED)
    await expect(page.locator('.anas-btn-ds-create')).not.toHaveClass(DISABLED)

    // testpool (ANAS-managed) is never PVE-banded — the marker is specific.
    await expect(grid.locator('.anas-ds-pve-row', { hasText: 'testpool' })).toHaveCount(0)
  })

  // Ruling #61's two halves on one storage root (operator, 2026-10-12: "to
  // tell against regressions"): a sibling the operator creates under the PVE
  // storage root is NOT owned (pve-footprint: children of a storage root that
  // are not guest-named are unowned) and is fully manageable; a guest-named
  // child (PVE's vm-<id>-disk-<n> namespace) IS owned and gated like the root.
  test('Datasets: an ANAS sibling under the PVE storage root is manageable; a guest-named child is not', async ({ page }) => {
    const sibling = 'datapool/anassibling'
    const guest = 'datapool/vm-100-disk-0'
    await sshExec(`zfs create ${sibling} && zfs create ${guest}`)
    try {
      expect(await datasetExists(sibling)).toBe(true)
      expect(await datasetExists(guest)).toBe(true)
      await loginToPve(page)
      await openAnasItem(page, 'Datasets')
      const grid = page.locator('.anas-grid-datasets')
      await expect(grid).toBeVisible({ timeout: 45_000 })

      // The sibling's row: not PVE-banded, no badge, and every structural
      // action live once selected.
      const siblingText = grid.locator('.x-tree-node-text', { hasText: /^anassibling$/ })
      await expect(siblingText).toBeVisible({ timeout: 20_000 })
      // (`has` is queried relative to the row, so the inner locator is page-rooted.)
      const siblingRow = grid.locator('.x-grid-row', { has: page.locator('.x-tree-node-text', { hasText: /^anassibling$/ }) })
      await expect(siblingRow).not.toHaveClass(/anas-ds-pve-row/)
      await expect(siblingRow.locator('.anas-ds-pve-badge')).toHaveCount(0)
      await siblingText.click()
      await expect(page.locator('.anas-btn-ds-destroy')).not.toHaveClass(DISABLED, { timeout: 20_000 })
      await expect(page.locator('.anas-btn-ds-edit')).not.toHaveClass(DISABLED)
      await expect(page.locator('.anas-btn-ds-perms')).not.toHaveClass(DISABLED)
      await expect(page.locator('.anas-btn-ds-create')).not.toHaveClass(DISABLED)

      // The guest-named child: PVE-banded, badged as a guest volume, gated.
      // Keyed on the badge title: the name cell carries the badge text beside
      // the name, and the pvepool fixture's pvfix holds a vm-100-disk-0 too.
      const guestTitle = 'PVE storage \'datapool\' owns datapool/vm-100-disk-0 as a guest volume'
      const guestRow = grid.locator('.x-grid-row', { has: page.locator(`.anas-ds-pve-badge[title="${guestTitle}"]`) })
      await expect(guestRow).toBeVisible({ timeout: 20_000 })
      await expect(guestRow).toHaveClass(/anas-ds-pve-row/)
      await expect(guestRow.locator('.x-tree-node-text')).toContainText('vm-100-disk-0')
      await guestRow.locator('.x-tree-node-text').click()
      await expect(page.locator('.anas-btn-ds-destroy')).toHaveClass(DISABLED, { timeout: 20_000 })
      await expect(page.locator('.anas-btn-ds-edit')).toHaveClass(DISABLED)
      await expect(page.locator('.anas-btn-ds-perms')).toHaveClass(DISABLED)
    }
    finally {
      await sshExec(`zfs destroy -r ${guest}; zfs destroy -r ${sibling}`).catch(() => {})
    }
  })
})
