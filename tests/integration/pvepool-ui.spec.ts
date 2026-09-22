import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { datasetExists, destroyDataset, poolExists } from './fixtures/stunt-node'

/**
 * Story pvepool.2 (GitHub #61, UI leg) — the Datasets screen on per-dataset PVE
 * ownership, driven through the real PVE UI over the pvepool.1 fixture
 * (test/stunt-node/pvepool-fixture.sh up). Modelled on datasets-ui.spec.ts /
 * pve-managed-pools.spec.ts / replication-ui.spec.ts.
 *
 * Fixture (never mutated here except the throwaway dataset in test 3):
 *   pvfix   loop pool registered as PVE zfspool storage `pvfix` (bare pool
 *           root) with guest volumes vm-100-disk-0 / subvol-101-disk-0 /
 *           basevol-102-disk-0 / base-103-disk-0, ANAS siblings
 *           pvfix/media + pvfix/media/child, and pvfix/dump registered as
 *           dir storage `pvfixdump`
 *   sysfix  loop pool shaped like a ZFS-root install: bootfs =
 *           sysfix/ROOT/pve-1, nested sysfix/data storage `sysfix-data`
 *           holding vm-200-disk-0, sibling sysfix/media
 *
 * Contracts under test (DESIGN.md "PVE footprint ownership" → Workflow):
 *   - badges per ownership kind (label per kind, tooltip = the reason)
 *   - toolbar enabled/disabled per node kind, reasons riding the buttons
 *   - Create on the storage root with the INFORMATIONAL note + live naming
 *     guard; tree reloads with the new node selected (success AND failure)
 *   - skew (per-node `pve` stripped from the payload) ⇒ whole-pool rule —
 *     skew only ever tightens
 *   - Replication / snapshot-schedule pickers list siblings, omit owned
 *
 * Row addressing: dataset rows show their RELATIVE name (lastSegment), so
 * 'media' exists under both pvfix and sysfix, and owned rows repeat the
 * storage id in their badge label. The tree renders pools in zpool-list order
 * (gtbackup, gtiscsi, pvfix, sysfix), so `.first()` on a name match addresses
 * the pvfix row; badge/reason assertions are all row-scoped. ExtJS boot +
 * panel render is slow — generous timeouts.
 */

const PVE_POOL = 'pvfix'
const SYS_POOL = 'sysfix'
const UI_DS = 'pvfix/ui-proof'

// ExtJS marks a disabled tool/button with one of these (mirrors the
// pve-managed-pools / composer specs).
const DISABLED = /x-item-disabled|x-btn-disabled/

test.beforeEach(async () => {
  test.skip(
    !(await poolExists(PVE_POOL)) || !(await poolExists(SYS_POOL)),
    'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
  )
})

/** Select the node, open Datasets, wait for the tree to render. */
async function openDatasets(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Datasets')
  const grid = page.locator('.anas-grid-datasets')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  return grid
}

/**
 * The tree row for one dataset by its RELATIVE name. The name cell also holds
 * the badge markup (owned rows), so the match is an unanchored case-sensitive
 * regex — a string `hasText` would match case-insensitively and 'ROOT' would
 * hit every "PVE storage root" badge. Multiple pools can carry the same leaf
 * name ('media' under pvfix AND sysfix) and a badged row repeats the storage
 * id — callers rely on tree order (pool root first; pvfix renders before
 * sysfix) with `.first()`.
 */
function dsRow(page: Page, grid: Locator, name: string): Locator {
  return grid
    .locator('.x-grid-row', {
      has: page.locator('.x-tree-node-text', { hasText: new RegExp(name) }),
    })
    .first()
}

/**
 * Expand a collapsed tree row (dataset rows render collapsed so their
 * snapshots load lazily; grandchildren such as sysfix/ROOT/pve-1 stay hidden
 * until the parent is expanded).
 */
async function expandRow(row: Locator): Promise<void> {
  await row.locator('.x-tree-expander').first().click()
}

/** Open the Create Dataset window from a selected row, wait for it to render. */
async function openCreateWindow(page: Page): Promise<Locator> {
  await page.locator('.anas-btn-ds-create').click()
  const win = page.locator('.anas-win-dataset-create')
  await expect(win).toBeVisible({ timeout: 20_000 })
  return win
}

/**
 * Read the tooltip an ExtJS button currently carries. `setTooltip(string)` may
 * surface as data-qtip (QuickTips delegation) or as a live Ext.tip.ToolTip —
 * the attribute form is checked first, the hover form by the callers that need
 * it. Empty string when neither is present (yet).
 */
async function buttonTip(btn: Locator): Promise<string> {
  return btn.evaluate(el => el.getAttribute('data-qtip') ?? el.getAttribute('title') ?? '')
}

test.describe('pvepool.2 — Datasets on per-dataset PVE ownership (stunt node fixture)', () => {
  // Wide viewport: the Datasets toolbar carries ~12 labelled buttons and at
  // the default 1280px the tail of them (Destroy, the snapshot verbs) collapses
  // into ExtJS's overflow menu — clicks there would be invisible to the specs.
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(150_000)

  test('badges per ownership kind; siblings carry none', async ({ page }) => {
    await openDatasets(page)
    const grid = page.locator('.anas-grid-datasets')

    // Storage root — the pool root IS the zfspool storage's configured path.
    const root = dsRow(page, grid, PVE_POOL)
    await expect(root).toBeVisible({ timeout: 45_000 })
    await expect(root.locator('.anas-ds-pve-badge')).toHaveText(/PVE storage root/, { timeout: 20_000 })

    // All four guest-volume kinds, badge + tooltip (the reason sentence names
    // storage and dataset — never "this pool").
    for (const guest of ['vm-100-disk-0', 'subvol-101-disk-0', 'basevol-102-disk-0', 'base-103-disk-0']) {
      const row = dsRow(page, grid, guest)
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row.locator('.anas-ds-pve-badge')).toHaveText(/PVE guest volume \(pvfix\)/, { timeout: 20_000 })
      await expect(row.locator('.anas-ds-pve-badge')).toHaveAttribute(
        'title',
        new RegExp(`owns ${PVE_POOL}/${guest} as a guest volume`),
      )
    }

    // dir storage tree — pvfix/dump is the pvfixdump dir storage's path.
    const dump = dsRow(page, grid, 'dump')
    await expect(dump.locator('.anas-ds-pve-badge')).toHaveText('PVE storage (pvfixdump)', { timeout: 20_000 })

    // System pool — sysfix/ROOT/pve-1 carries the boot-filesystem badge. It is
    // a grandchild: expand the collapsed sysfix/ROOT row first.
    const sysRoot = dsRow(page, grid, 'ROOT')
    await expect(sysRoot).toBeVisible({ timeout: 20_000 })
    await expandRow(sysRoot)
    const boot = dsRow(page, grid, 'pve-1')
    await expect(boot).toBeVisible({ timeout: 20_000 })
    await expect(boot.locator('.anas-ds-pve-badge')).toHaveText(/System pool/, { timeout: 20_000 })

    // The sibling is ANAS's: no PVE badge anywhere in the row.
    const media = dsRow(page, grid, 'media')
    await expect(media).toBeVisible({ timeout: 20_000 })
    await expect(media.locator('.anas-ds-pve-badge')).toHaveCount(0)
    // ...and nor its child.
    await expect(dsRow(page, grid, 'child').locator('.anas-ds-pve-badge')).toHaveCount(0, { timeout: 20_000 })
  })

  test('toolbar gates per node kind, with the reason on the disabled buttons', async ({ page }) => {
    await openDatasets(page)
    const grid = page.locator('.anas-grid-datasets')

    // --- storage root: Create is the ONE live action (children outside PVE's
    // footprint are ANAS's to make); everything else view-only.
    await dsRow(page, grid, PVE_POOL).click()
    const createBtn = page.locator('.anas-btn-ds-create')
    await expect(createBtn).not.toHaveClass(DISABLED, { timeout: 20_000 })
    for (const sel of ['.anas-btn-ds-edit', '.anas-btn-ds-share', '.anas-btn-ds-destroy', '.anas-btn-snap-create']) {
      await expect(page.locator(sel)).toHaveClass(DISABLED, { timeout: 20_000 })
    }
    // The reason rides the disabled buttons as their tooltip — the ownership
    // sentence naming the storage ('pvfix'), not "this pool".
    await expect.poll(
      () => buttonTip(page.locator('.anas-btn-ds-destroy')),
      { timeout: 20_000 },
    ).toMatch(/pvfix/)

    // --- guest volume: Detail is the only live action.
    await dsRow(page, grid, 'vm-100-disk-0').click()
    await expect(page.locator('.anas-btn-ds-detail')).not.toHaveClass(DISABLED, { timeout: 20_000 })
    for (const sel of ['.anas-btn-ds-create', '.anas-btn-ds-edit', '.anas-btn-ds-perms', '.anas-btn-ds-share', '.anas-btn-ds-destroy', '.anas-btn-snap-create']) {
      await expect(page.locator(sel)).toHaveClass(DISABLED, { timeout: 20_000 })
    }

    // --- sibling: fully manageable — every action live (Resize stays
    // volume-only by nature, that is the iscsi.3 gate, not PVE's).
    await dsRow(page, grid, 'media').click()
    for (const sel of ['.anas-btn-ds-create', '.anas-btn-ds-detail', '.anas-btn-ds-edit', '.anas-btn-ds-perms', '.anas-btn-ds-share', '.anas-btn-ds-destroy', '.anas-btn-snap-create']) {
      await expect(page.locator(sel)).not.toHaveClass(DISABLED, { timeout: 20_000 })
    }
  })

  test('create on the storage root: note, guard, reload-with-selection, destroy (happy path)', async ({ page }) => {
    // Pre-clean a crashed earlier run so the create path is fresh.
    await destroyDataset(UI_DS)
    try {
      await openDatasets(page)
      const grid = page.locator('.anas-grid-datasets')

      await dsRow(page, grid, PVE_POOL).click()
      const win = await openCreateWindow(page)

      // The pool picker lists the PVE pool — it is preselected (the root row
      // seeded it) and offered in the boundlist.
      const poolInput = win.locator('.x-form-text').first()
      await expect(poolInput).toHaveValue(PVE_POOL, { timeout: 20_000 })

      // The INFORMATIONAL note (never a warning): names the storage and the
      // free-space fact.
      const note = win.locator('.anas-fld-pve-pool-note')
      await expect(note).toBeVisible({ timeout: 20_000 })
      await expect(note).toContainText(PVE_POOL)
      await expect(note).toContainText(/free-space/)

      await win.locator('.anas-fld-ds-path input[type="text"]').fill('ui-proof')
      // Blur so the live naming guard + form validation settle.
      await win.locator('.anas-fld-ds-path input[type="text"]').blur()

      const submit = win.locator('.anas-btn-dataset-create-submit')
      await expect(submit).not.toHaveClass(DISABLED, { timeout: 20_000 })
      await submit.click()

      // Job completes → the tree reloads and the NEW node is present, selected,
      // and carries no PVE badge. Source of truth on the node as well.
      // (Selection in this ExtJS build lands on the row's wrapping TABLE.)
      const created = dsRow(page, grid, 'ui-proof')
      await expect(created).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => datasetExists(UI_DS), { timeout: 60_000 }).toBe(true)
      await expect(created.locator('.anas-ds-pve-badge')).toHaveCount(0)
      await expect(created.locator('xpath=ancestor::table[1]')).toHaveClass(/x-grid-item-selected/, { timeout: 20_000 })

      // Destroy it again through the UI's own confirm flow.
      await page.locator('.anas-btn-ds-destroy').click()
      const confirm = page.locator('.anas-win-dataset-destroy')
      await expect(confirm).toBeVisible({ timeout: 20_000 })
      await confirm.locator('.anas-btn-dataset-destroy-confirm').click()
      await expect(created).not.toBeVisible({ timeout: 60_000 })
      await expect.poll(() => datasetExists(UI_DS), { timeout: 60_000 }).toBe(false)
    }
    finally {
      await destroyDataset(UI_DS)
    }
  })

  test('naming guard fires in the dialog before submit, and clears on a clean name', async ({ page }) => {
    await openDatasets(page)
    const grid = page.locator('.anas-grid-datasets')

    await dsRow(page, grid, PVE_POOL).click()
    const win = await openCreateWindow(page)
    const pathField = win.locator('.anas-fld-ds-path input[type="text"]')
    const guard = win.locator('.anas-fld-ds-name-guard')
    const submit = win.locator('.anas-btn-dataset-create-submit')

    await pathField.fill('vm-900-disk-0')
    await pathField.blur()

    await expect(guard).toBeVisible({ timeout: 20_000 })
    await expect(guard).toContainText('PVE would inventory \'vm-900-disk-0\' as a guest disk')
    await expect(submit).toHaveClass(DISABLED, { timeout: 20_000 })

    // A clean name clears the guard and re-enables Create.
    await pathField.fill('media2')
    await pathField.blur()
    await expect(guard).toBeHidden({ timeout: 20_000 })
    await expect(submit).not.toHaveClass(DISABLED, { timeout: 20_000 })

    // Cancel — nothing created.
    await win.getByText('Cancel', { exact: true }).click()
    await expect(win).toBeHidden({ timeout: 20_000 })
    await expect.poll(() => datasetExists('pvfix/media2'), { timeout: 30_000 }).toBe(false)
  })

  test('reload after a failed job: the daemon sentence shows, the tree refreshes', async ({ page }) => {
    // Failure injection without touching the fixture: pvfix/media has the
    // child 'media/child', so a NON-recursive destroy is confirmed and then
    // refused by zfs — a real job failure that destroys nothing. The fixture
    // leaves this test exactly as it found it.
    let datasetFetches = 0
    await page.route(/\/v1\/pools\/.+\/datasets/, async (route) => {
      datasetFetches += 1
      await route.continue()
    })

    await openDatasets(page)
    const grid = page.locator('.anas-grid-datasets')
    const before = datasetFetches

    await dsRow(page, grid, 'media').click()
    await page.locator('.anas-btn-ds-destroy').click()

    // The confirm window carries the daemon's guided warning about the child.
    const confirm = page.locator('.anas-win-dataset-destroy')
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await expect(confirm).toContainText(/child dataset/i, { timeout: 20_000 })
    await confirm.locator('.anas-btn-dataset-destroy-confirm').click()

    // The job fails; the alert carries the daemon's sentence.
    const alert = page.locator('.x-message-box')
    await expect(alert).toBeVisible({ timeout: 60_000 })
    await expect(alert).toContainText(/children|child/i, { timeout: 20_000 })
    await alert.locator('.x-btn', { hasText: 'OK' }).click()

    // ...and the tree reloads afterwards: the fetch count grows past the
    // initial load and the row is still there — no stale state.
    await expect.poll(() => datasetFetches, { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(dsRow(page, grid, 'media')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => datasetExists('pvfix/media'), { timeout: 30_000 }).toBe(true)
  })

  test('skew: per-node ownership stripped from the payload ⇒ the whole-pool rule', async ({ page }) => {
    // Play an OLD daemon: strip every per-node `pve` key from the datasets
    // payload. The pool's `pveStorages[]` stays, so the helper falls back to
    // the whole-pool rule — every row of the pool PVE names is gated and
    // badged, and Create is disabled on the storage root too (skew only ever
    // tightens a hands-off gate).
    const stripPveKeys = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const item of v)
          stripPveKeys(item)
        return
      }
      if (v && typeof v === 'object') {
        for (const key of Object.keys(v as Record<string, unknown>)) {
          if (key === 'pve')
            delete (v as Record<string, unknown>)[key]
          else
            stripPveKeys((v as Record<string, unknown>)[key])
        }
      }
    }
    await page.route(/\/v1\/pools\/.+\/datasets/, async (route) => {
      const response = await route.fetch()
      const json = (await response.json()) as unknown
      stripPveKeys(json)
      await route.fulfill({ response, json })
    })

    await openDatasets(page)
    const grid = page.locator('.anas-grid-datasets')

    // Every pvfix row now carries the whole-pool badge, siblings included.
    await expect(dsRow(page, grid, PVE_POOL).locator('.anas-ds-pve-badge')).toHaveText(/PVE storage root/, { timeout: 45_000 })
    for (const name of ['vm-100-disk-0', 'media', 'dump']) {
      await expect(dsRow(page, grid, name).locator('.anas-ds-pve-badge')).toBeVisible({ timeout: 20_000 })
    }

    // Create is DISABLED on the storage root under the skew rule — the
    // fallback verdict reads 'storage-root' but pvePerNode is false, so the
    // whole-pool gate wins.
    await dsRow(page, grid, PVE_POOL).click()
    await expect(page.locator('.anas-btn-ds-create')).toHaveClass(DISABLED, { timeout: 20_000 })
  })

  test('replication and snapshot-schedule pickers: PVE pools in, owned datasets out', async ({ page }) => {
    // --- Replication task dialog -----------------------------------------
    await loginToPve(page)
    await openAnasItem(page, 'Replication')
    await expect(page.locator('.anas-grid-replication')).toBeVisible({ timeout: 45_000 })
    await page.locator('.anas-btn-repl-new').click()
    const repl = page.locator('.anas-win-repl-task')
    await expect(repl).toBeVisible({ timeout: 20_000 })

    // The pool picker lists the PVE pool.
    const srcPool = repl.locator('.anas-fld-repl-src-pool')
    await srcPool.click()
    const poolList = page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${PVE_POOL}$`) })
    await expect(poolList).toBeVisible({ timeout: 20_000 })
    await poolList.click()

    // The dataset picker lists the siblings and OMITS the owned datasets.
    const srcDs = repl.locator('.anas-fld-repl-src-dataset')
    await expect.poll(async () => {
      await srcDs.click()
      return page
        .locator('.x-boundlist:visible .x-boundlist-item', { hasText: /^media$/ })
        .isVisible()
        .catch(() => false)
    }, { timeout: 30_000 }).toBe(true)
    const dsList = page.locator('.x-boundlist:visible')
    await expect(dsList.locator('.x-boundlist-item', { hasText: /^media$/ })).toBeVisible()
    await expect(dsList.locator('.x-boundlist-item', { hasText: /^media\/child$/ })).toBeVisible()
    await expect(dsList.locator('.x-boundlist-item', { hasText: /^vm-100-disk-0$/ })).toHaveCount(0)
    await repl.getByText('Cancel', { exact: true }).click()
    await expect(repl).toBeHidden({ timeout: 20_000 })

    // --- Snapshot-schedule dialog -----------------------------------------
    await openAnasItem(page, 'Snapshots')
    await expect(page.locator('.anas-grid-schedules')).toBeVisible({ timeout: 45_000 })
    await page.locator('.anas-btn-sched-new').click()
    const sched = page.locator('.anas-win-sched')
    await expect(sched).toBeVisible({ timeout: 20_000 })

    // Pick the SYSTEM pool here: every pvfix dataset owned or sibling was
    // already covered above — sysfix proves the boot tree and the nested
    // storage's guest zvol are omitted while the sibling stays.
    const schedPool = sched.locator('.anas-fld-sched-zfs-pool')
    await expect(schedPool).toBeVisible({ timeout: 20_000 })
    await schedPool.click()
    const schedPoolList = page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${SYS_POOL}$`) })
    await expect(schedPoolList).toBeVisible({ timeout: 20_000 })
    await schedPoolList.click()

    const schedDs = sched.locator('.anas-fld-sched-zfs-dataset')
    await expect.poll(async () => {
      await schedDs.click()
      return page
        .locator('.x-boundlist:visible .x-boundlist-item', { hasText: /^media$/ })
        .isVisible()
        .catch(() => false)
    }, { timeout: 30_000 }).toBe(true)
    const schedList = page.locator('.x-boundlist:visible')
    await expect(schedList.locator('.x-boundlist-item', { hasText: /^media$/ })).toBeVisible()
    await expect(schedList.locator('.x-boundlist-item', { hasText: /^ROOT$/ })).toHaveCount(0)
    await expect(schedList.locator('.x-boundlist-item', { hasText: /^vm-200-disk-0$/ })).toHaveCount(0)
    await sched.getByText('Cancel', { exact: true }).click()
    await expect(sched).toBeHidden({ timeout: 20_000 })
  })
})
