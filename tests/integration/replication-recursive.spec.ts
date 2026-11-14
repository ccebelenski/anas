import type { Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { apiContext, expect, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { datasetExists, poolExists, skipIfFixtureMissing } from './fixtures/stunt-node'

/**
 * Story rrep.3 (GitHub #84) — the Replication task dialog offers recursive
 * replication: "Include child datasets" with the snapshot schedule dialog's
 * Exclude picker, driven through the real PVE UI over the pvepool fixture
 * (test/stunt-node/pvepool-fixture.sh up). Modelled on
 * schedules-exclude.spec.ts and replication-ui.spec.ts.
 *
 * Fixture used (never mutated here): pvfix/media and its child
 * pvfix/media/child, an ANAS sibling subtree on the PVE pool `pvfix`. The
 * task targets pvfix/rrep3-proof; it is created DISABLED and never run, so
 * nothing is sent and the target is never created.
 *
 * Contracts under test:
 *   - ticking Recursive reveals the Exclude picker and its hint, and turns
 *     "Take a fresh snapshot before each run" off and greys it, with the hint
 *     that says why (R3)
 *   - the picker lists the source's descendants (pvfix/media/child, shown as
 *     `media/child`); a pick saves
 *   - the grid row reads "(-r, 1 excluded)", its tooltip names the dataset
 *   - the daemon stored recursive:true, exclude:[child], snapshotFirst:false
 *   - Edit reopens it ticked with the pick, snapshot-first still greyed
 *   - at 1280x720 with every recursive row shown, the Save button is inside
 *     the viewport (the dialog's viewport cap)
 *
 * Written against the rrep.2 contract; until rrep.2 merges the daemon accepts
 * the fields but does not run its extra create/update gates. The task is
 * deleted through the API before and after the test. ExtJS boot + panel
 * render is slow, so the timeouts are generous.
 */

const PVE_POOL = 'pvfix'
const SOURCE = 'pvfix/media'
const CHILD = 'pvfix/media/child'
const TASK = 'rrep3-proof'
const TARGET_DS = 'rrep3-proof'
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

test.use({ viewport: { width: 1280, height: 720 } })

interface StoredTask {
  name: string
  source: { pool: string, dataset: string }
  snapshotFirst?: boolean
  recursive?: boolean
  exclude?: string[]
  enabled?: boolean
}

/** Remove the proof task through its own door; absent is fine. */
async function deleteTask(playwright: PlaywrightWorkerArgs['playwright']): Promise<void> {
  const ctx = await apiContext(playwright)
  try {
    const res = await ctx.delete(`${V1}/replication/tasks/${TASK}`)
    expect([202, 404]).toContain(res.status())
    if (res.status() === 202) {
      const { job } = await res.json() as { job: { id: string } }
      await expect.poll(async () => {
        const r = await ctx.get(`${V1}/jobs/${job.id}`)
        return ((await r.json()) as { job: { status: string } }).job.status
      }, { timeout: 30_000 }).toMatch(/completed|failed/)
    }
  }
  finally {
    await ctx.dispose()
  }
}

/** The proof task as the daemon stored it (GET /replication/tasks), or null. */
async function storedTask(playwright: PlaywrightWorkerArgs['playwright']): Promise<StoredTask | null> {
  const ctx = await apiContext(playwright)
  try {
    const res = await ctx.get(`${V1}/replication/tasks`)
    expect(res.status(), await res.text()).toBe(200)
    const list = ((await res.json()) as { data: { task: StoredTask }[] }).data
    return list.map(e => e.task).find(t => t.name === TASK) ?? null
  }
  finally {
    await ctx.dispose()
  }
}

/**
 * Pick a value in an ExtJS readonly combobox by its display label, retried:
 * the source-dataset combo reloads asynchronously when the source pool
 * changes and its dropdown collapses when the new list lands (see
 * replication-ui.spec.ts, pickCombo).
 */
async function pickCombo(page: Page, field: Locator, label: string): Promise<void> {
  const item = page
    .locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${label}$`) })
    .first()
  await expect(async () => {
    if (await page.locator('.x-boundlist:visible').count() === 0)
      await field.click()
    await item.click({ timeout: 2_000 })
  }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] })
}

/** Is an ExtJS checkbox field (found by its cls) ticked? */
async function isChecked(win: Locator, cls: string): Promise<boolean> {
  return win.locator(`${cls} input`).first().evaluate(el => (el as HTMLInputElement).checked)
}

/** Tick / untick an ExtJS checkbox field found by its cls. */
async function setCheckbox(win: Locator, cls: string, check: boolean): Promise<void> {
  if (await isChecked(win, cls) !== check)
    await win.locator(`${cls} input`).first().click()
}

/** The button sits wholly inside the page's viewport. */
async function expectInViewport(page: Page, button: Locator): Promise<void> {
  await expect(button).toBeVisible({ timeout: 20_000 })
  const box = await button.boundingBox()
  const view = page.viewportSize()
  expect(box, 'the button has a box').not.toBeNull()
  expect(view, 'the page has a viewport').not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(view!.height)
  expect(box!.x + box!.width).toBeLessThanOrEqual(view!.width)
}

/** The recursive rows of an open task dialog read as a recursive task's. */
async function expectRecursiveShown(win: Locator): Promise<void> {
  await expect(win.locator('.anas-fld-repl-exclude')).toBeVisible({ timeout: 20_000 })
  expect(await isChecked(win, '.anas-fld-repl-snapfirst')).toBe(false)
  await expect(win.locator('.anas-fld-repl-snapfirst')).toHaveClass(/x-item-disabled/)
  const hint = win.locator('.anas-repl-snapfirst-hint')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('recursive snapshot schedule of the source')
  await expect(hint).toContainText('Snapshots menu')
}

test.beforeEach(async ({ playwright }) => {
  skipIfFixtureMissing(
    !(await poolExists(PVE_POOL)) || !(await datasetExists(CHILD)),
    'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
  )
  await deleteTask(playwright)
})

test.afterEach(async ({ playwright }) => {
  await deleteTask(playwright)
})

test.describe('rrep.3 — recursive replication in the task dialog (stunt node fixture)', () => {
  test.setTimeout(180_000)

  test('Include child datasets: picker, snapshot-first off, "1 excluded", stored, reopened', async ({ page, playwright }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Replication')
    const grid = page.locator('.anas-grid-replication')
    await expect(grid).toBeVisible({ timeout: 45_000 })

    await page.locator('.anas-btn-repl-new').click()
    const win = page.locator('.anas-win-repl-task')
    await expect(win).toBeVisible({ timeout: 20_000 })

    await win.locator('.anas-fld-repl-name input').first().fill(TASK)
    // Source: pvfix/media.
    await pickCombo(page, win.locator('.anas-fld-repl-src-pool'), PVE_POOL)
    await pickCombo(page, win.locator('.anas-fld-repl-src-dataset'), 'media')

    // Before Recursive: no picker, snapshot-first ticked and live.
    const exclude = win.locator('.anas-fld-repl-exclude')
    await expect(exclude).toBeHidden()
    expect(await isChecked(win, '.anas-fld-repl-snapfirst')).toBe(true)
    await expect(win.locator('.anas-fld-repl-snapfirst')).not.toHaveClass(/x-item-disabled/)

    // Recursive reveals the picker and greys snapshot-first with its hint.
    await setCheckbox(win, '.anas-fld-repl-recursive', true)
    await expectRecursiveShown(win)

    // Pick the child. Force past the tagfield's placeholder label, which
    // overlays the input; typing filters the pick list.
    const excludeInput = exclude.locator('input[type="text"]').first()
    await excludeInput.click({ force: true })
    await excludeInput.pressSequentially('child')
    const item = page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: /^media\/child$/ })
    await expect(item).toBeVisible({ timeout: 20_000 })
    await item.click()
    await expect(exclude).toContainText('media/child')

    // Target: pvfix/rrep3-proof (outside the source tree).
    await pickCombo(page, win.locator('.anas-fld-repl-tgt-pool'), PVE_POOL)
    await win.locator('.anas-fld-repl-tgt-dataset input').first().fill(TARGET_DS)
    await win.locator('.anas-fld-repl-schedule input').first().fill('daily')
    // Keep the proof task from ever firing on the node.
    await setCheckbox(win, '.anas-fld-repl-enabled', false)

    // Everything shown, at 1280x720: Save is still inside the view.
    const submit = win.locator('.anas-btn-repl-task-submit')
    await expectInViewport(page, submit)
    await submit.click()
    await expect(win).toBeHidden({ timeout: 60_000 })

    // The grid row: "(-r, 1 excluded)", the tooltip names the dataset.
    const row = grid.locator('.x-grid-row', { hasText: TASK }).first()
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toContainText(SOURCE)
    const marker = row.locator('.anas-repl-recursive')
    await expect(marker).toHaveText('(-r, 1 excluded)', { timeout: 20_000 })
    await expect(marker).toHaveAttribute('title', new RegExp(`excluded: ${CHILD}`))
    // The R12 read-back (issued with the grid reload that drew the row) found
    // the field: no "not supported" / "not confirmed" alert.
    await expect(page.locator('.x-message-box:visible')).toHaveCount(0)

    // What the daemon stored.
    const stored = await storedTask(playwright)
    expect(stored, 'the task is listed').not.toBeNull()
    expect(stored!.recursive).toBe(true)
    expect(stored!.exclude).toEqual([CHILD])
    expect(stored!.snapshotFirst).toBe(false)
    expect(stored!.enabled).toBe(false)

    // Edit reopens it as it was saved.
    await row.click()
    const edit = page.locator('.anas-btn-repl-edit')
    await expect(edit).toBeEnabled({ timeout: 20_000 })
    await edit.click()
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => isChecked(win, '.anas-fld-repl-recursive'), { timeout: 20_000 }).toBe(true)
    await expectRecursiveShown(win)
    await expect(exclude).toContainText('media/child', { timeout: 20_000 })
    await expectInViewport(page, submit)

    // Saved untouched, it sends back what was stored.
    await submit.click()
    await expect(win).toBeHidden({ timeout: 60_000 })
    await expect(marker).toHaveText('(-r, 1 excluded)', { timeout: 20_000 })
    await expect(page.locator('.x-message-box:visible')).toHaveCount(0)
    const again = await storedTask(playwright)
    expect(again!.recursive).toBe(true)
    expect(again!.exclude).toEqual([CHILD])
    expect(again!.snapshotFirst).toBe(false)
  })
})
