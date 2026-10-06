import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { poolExists, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * Story dshero.1 (GitHub #70, UI leg) — the Pool space hero on the Datasets
 * screen stays BOUNDED when the pool is also PVE storage, driven through the
 * real PVE UI over the pvepool fixture (test/stunt-node/pvepool-fixture.sh up).
 * Modelled on pvepool-ui.spec.ts (same login + openAnasItem, same fixture
 * guard) and datasets-gfx-ui.spec.ts (same hero hooks).
 *
 * The bug: buildHeroHtml emitted one legend row per top-level dataset with no
 * cap — on a PVE-storage pool that is every guest volume, the hero (a plain
 * component at natural height above the flex:1 tree) pushed the tree to zero
 * height. The fix folds PVE-owned children into ONE "Proxmox storage"
 * segment (the same ownership verdict the Name-column badge uses) and caps
 * the legend to 6 rows + one "n more" roll-up + Free; the Proxmox storage
 * row takes one of the 6 but is never folded, Free last — so the invariant is hero height bounded regardless of dataset count,
 * NOT a scrollable legend.
 *
 * Fixture pools on screen: pvfix (PVE zfspool storage carrying vm-100-disk-0,
 * subvol-101-disk-0, basevol-102-disk-0, base-103-disk-0, ANAS siblings media
 * + media/child, and the pvfixdump dir-storage path dump) plus sysfix and the
 * baseline test pools. The hero follows the SELECTED node's pool, so the spec
 * selects the pvfix pool row first; the tree renders pools in zpool-list
 * order, hence .first() row addressing (see pvepool-ui.spec.ts).
 *
 * Legend rows are asserted through 15-gfx.js's own markup: each row is
 * .anas-gfx-legend-row holding .anas-gfx-legend-nm (the label span).
 *
 * The cap itself needs more named segments than pvfix carries, so the last
 * test adds pvfix/hero-01 … hero-12 (distinct sizes) for an 18-dataset pool —
 * 13 ANAS datasets + the folded segment = 14 named, more than the 6 kept —
 * and destroys them again in afterAll (with a pre-clean in beforeAll so a
 * failed run never leaves them behind).
 */

const PVE_POOL = 'pvfix'
// N = 6 rows (Proxmox storage included) + 1 roll-up + Free = 8 rows maximum by construction.
const MAX_LEGEND_ROWS = 8

test.beforeEach(async () => {
  skipIfFixtureMissing(
    !(await poolExists(PVE_POOL)),
    'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
  )
})

/** Select the pvfix pool row so the hero focuses on it. */
async function openDatasetsOnPvfix(page: Page): Promise<{ grid: Locator, hero: Locator }> {
  await loginToPve(page)
  return showPvfixHero(page)
}

/** On a logged-in page: open Datasets and focus the hero on pvfix. */
async function showPvfixHero(page: Page): Promise<{ grid: Locator, hero: Locator }> {
  await openAnasItem(page, 'Datasets')
  const grid = page.locator('.anas-grid-datasets')
  await expect(grid).toBeVisible({ timeout: 45_000 })

  // Dataset rows show their RELATIVE name; the pvfix pool root matches first
  // in tree order (see pvepool-ui.spec.ts's dsRow note).
  const poolRow = grid
    .locator('.anas-ds-pool-row', { has: page.locator('.x-tree-node-text', { hasText: PVE_POOL }) })
    .first()
  await expect(poolRow).toBeVisible({ timeout: 45_000 })
  await poolRow.click()

  // The hero re-renders for the selected pool — its title carries the name.
  const hero = page.locator('.anas-ds-hero')
  await expect(hero).toBeVisible({ timeout: 20_000 })
  await expect(hero.locator('.anas-ds-hero-t')).toContainText(PVE_POOL, { timeout: 20_000 })
  return { grid, hero }
}

test.describe('dshero.1 — Pool space hero bounded on a PVE-storage pool (#70)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(150_000)

  test('guest volumes fold into ONE legend row; the legend stays capped', async ({ page }) => {
    const { hero } = await openDatasetsOnPvfix(page)

    const names = hero.locator('.anas-gfx-legend .anas-gfx-legend-nm')
    await expect(names.first()).toBeVisible({ timeout: 20_000 })

    // (a) The PVE footprint reads as ONE folded segment — exactly one row.
    const folded = names.filter({ hasText: /^Proxmox storage$/ })
    await expect(folded).toHaveCount(1)

    // (b) No guest volume keeps a named legend row of its own.
    const labels = await names.allTextContents()
    for (const label of labels) {
      expect(label).not.toMatch(/^(subvol-|vm-|basevol-|base-)/)
    }

    // (c) The legend is capped — max named + roll-up + Free.
    expect(labels.length).toBeLessThanOrEqual(MAX_LEGEND_ROWS)
  })

  test('the tree keeps at least half the Datasets panel height', async ({ page }) => {
    const { grid, hero } = await openDatasetsOnPvfix(page)
    await expect(hero.locator('.anas-gfx-legend')).toBeVisible({ timeout: 20_000 })

    await expectTreeKeepsHalf(page, grid)
  })
})

/**
 * The #70 invariant: the hero (natural height in the vbox) may never squeeze
 * the flex:1 tree below usable — half the panel is generous. Measured on the
 * tree BODY (the tree view — a treepanel's view carries x-tree-view, never
 * x-grid-view), not the treepanel box, so the docked toolbar and column
 * header never count as usable tree.
 */
async function expectTreeKeepsHalf(page: Page, grid: Locator): Promise<void> {
  const panelBox = await page.locator('.anas-view-datasets').boundingBox()
  const bodyBox = await grid.locator('.x-tree-view').boundingBox()
  expect(panelBox).not.toBeNull()
  expect(bodyBox).not.toBeNull()
  const vp = page.viewportSize()
  console.warn(`dshero.1 @${vp?.width}x${vp?.height} tree body ${bodyBox!.height.toFixed(0)}px of panel ${panelBox!.height.toFixed(0)}px = ${(100 * bodyBox!.height / panelBox!.height).toFixed(1)}%`)
  expect(bodyBox!.height).toBeGreaterThanOrEqual(panelBox!.height * 0.5)
}

const HERO_COUNT = 12
const HERO_DATASETS = Array.from({ length: HERO_COUNT }, (_, i) =>
  `${PVE_POOL}/hero-${String(i + 1).padStart(2, '0')}`)

/** Best-effort removal of the hero-NN datasets (never throws). */
async function destroyHeroDatasets(): Promise<void> {
  const cmd = HERO_DATASETS
    .map(ds => `zfs list -H -o name ${ds} >/dev/null 2>&1 && zfs destroy -r ${ds}`)
    .join('; ')
  await sshExec(`${cmd}; true`).catch(() => {})
}

test.describe('dshero.1 — the cap on a pool with many datasets (#70)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(150_000)

  test.beforeAll(async () => {
    skipIfFixtureMissing(
      !(await poolExists(PVE_POOL)),
      'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
    )
    await destroyHeroDatasets()
    // Each hero-NN gets NN × 64 KiB of data so every `used` differs.
    const make = HERO_DATASETS.map((ds, i) =>
      `zfs create ${ds} && dd if=/dev/urandom of=/${ds}/f bs=64k count=${i + 1} status=none`)
    await sshExec(`set -e; ${make.join('; ')}; zpool sync ${PVE_POOL}`)
  })

  test.afterAll(async () => {
    await destroyHeroDatasets()
  })

  test('18 datasets: the legend rolls up past 6 into one "n more" row and the tree keeps half', async ({ page }) => {
    const { grid, hero } = await openDatasetsOnPvfix(page)

    const names = hero.locator('.anas-gfx-legend .anas-gfx-legend-nm')
    await expect(names.first()).toBeVisible({ timeout: 20_000 })

    const labels = await names.allTextContents()
    expect(labels.length).toBeLessThanOrEqual(MAX_LEGEND_ROWS)
    expect(labels.filter(l => /\d+ more/.test(l))).toHaveLength(1)
    // The Proxmox storage row is never folded into "n more": its own row, and
    // the last two rows are it and Free.
    expect(labels.filter(l => l === 'Proxmox storage')).toHaveLength(1)
    expect(labels.slice(-2)).toEqual(['Proxmox storage', 'Free'])

    await expectTreeKeepsHalf(page, grid)
  })

  // A common laptop screen (0.4.2 test review C8): PVE's own task log takes
  // the bottom third of a 768px screen, so the full hero left the tree 19.7%
  // of the panel. Under 600px of panel body the hero STARTS collapsed to its
  // title line ("Show chart"); shown there it is compact (110px donut, max 3
  // named rows → legend <= 5 rows). The link records the user's choice per
  // browser, and only a click records it.
  test.describe('at 1366x768', () => {
    test.use({ viewport: { width: 1366, height: 768 } })

    async function reloadAndReopen(page: Page): Promise<{ grid: Locator, hero: Locator }> {
      await page.reload()
      await page.waitForFunction(
        () => ![...document.querySelectorAll('.x-mask')].some(el => (el as HTMLElement).offsetParent !== null),
        undefined,
        { timeout: 30_000 },
      ).catch(() => undefined)
      const nag = page.getByText('No valid subscription')
      if (await nag.isVisible({ timeout: 10_000 }).catch(() => false))
        await page.getByRole('button', { name: 'OK' }).click()
      return showPvfixHero(page)
    }

    const treeHeight = async (grid: Locator): Promise<number> => (await grid.locator('.x-tree-view').boundingBox())!.height

    test('18 datasets at 1366x768: the hero starts collapsed and the tree keeps half; Show chart reveals the compact legend', async ({ page }) => {
      const { grid, hero } = await openDatasetsOnPvfix(page)
      const toggle = hero.locator('.anas-ds-hero-toggle')
      await expect(toggle).toHaveText('Show chart', { timeout: 20_000 })
      await expect(hero.locator('.anas-gfx-legend')).toHaveCount(0)
      await expectTreeKeepsHalf(page, grid)

      await toggle.click()
      const names = hero.locator('.anas-gfx-legend .anas-gfx-legend-nm')
      await expect(names.first()).toBeVisible({ timeout: 20_000 })
      const labels = await names.allTextContents()
      console.warn(`dshero.1 @1366x768 shown: legend rows ${labels.join(' | ')}; tree body ${(await treeHeight(grid)).toFixed(0)}px`)
      expect(labels.length).toBeLessThanOrEqual(5)
      expect(labels.filter(l => /\d+ more/.test(l))).toHaveLength(1)
      expect(labels.slice(-2)).toEqual(['Proxmox storage', 'Free'])
    })

    test('the choice is the user\'s: Show chart and Hide chart each survive a reload', async ({ page }) => {
      const { grid, hero } = await openDatasetsOnPvfix(page)
      await expect(hero.locator('.anas-ds-hero-toggle')).toHaveText('Show chart', { timeout: 20_000 })
      const collapsed = await treeHeight(grid)

      // Show it: the legend appears, the tree gives up room, and a reload keeps it shown.
      await hero.locator('.anas-ds-hero-toggle').click()
      await expect(hero.locator('.anas-gfx-legend')).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => treeHeight(grid)).toBeLessThan(collapsed)
      const shown = await reloadAndReopen(page)
      await expect(shown.hero.locator('.anas-ds-hero-toggle')).toHaveText('Hide chart', { timeout: 20_000 })
      await expect(shown.hero.locator('.anas-gfx-legend')).toBeVisible()
      const shownHeight = await treeHeight(shown.grid)

      // Hide it: the legend goes, the tree grows, and a reload keeps it hidden.
      await shown.hero.locator('.anas-ds-hero-toggle').click()
      await expect(shown.hero.locator('.anas-gfx-legend')).toHaveCount(0)
      await expect.poll(() => treeHeight(shown.grid)).toBeGreaterThan(shownHeight)
      console.warn(`dshero.1 @1366x768 toggle: tree body ${shownHeight.toFixed(0)}px shown -> ${(await treeHeight(shown.grid)).toFixed(0)}px hidden`)
      const hidden = await reloadAndReopen(page)
      await expect(hidden.hero.locator('.anas-ds-hero-toggle')).toHaveText('Show chart', { timeout: 20_000 })
      await expect(hidden.hero.locator('.anas-gfx-legend')).toHaveCount(0)
    })
  })
})
