import type { Locator, PlaywrightWorkerArgs } from '@playwright/test'
import { apiContext, expect, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { datasetExists, poolExists, skipIfFixtureMissing } from './fixtures/stunt-node'

/**
 * Story snaptime.2 (GitHub #83) — the schedule dialog shows and edits WHEN
 * a snapshot schedule fires (time, weekday, day of month, month), driven
 * through the real PVE UI over the pvepool fixture
 * (test/stunt-node/pvepool-fixture.sh up). Modelled on
 * schedules-exclude.spec.ts.
 *
 * Fixture used (never mutated here): pvfix/media, an ANAS sibling subtree
 * on the PVE pool `pvfix`.
 *
 * Contracts under test:
 *   - the fire controls show only where the chosen cadence allows them:
 *     monthly shows day + time and hides weekday + month, yearly shows
 *     month, hourly hides all four
 *   - monthly day 30 earns the hint's shorter-month sentence
 *   - a saved monthly 30 at 01:30 reads `monthly on the 30th 01:30` in the
 *     grid's Cadence cell, and the API holds dayOfMonth 30 + time '01:30'
 *   - reopening Edit shows the stored values in the controls
 *
 * The schedule is created DISABLED (no timer fire on the node) and deleted
 * through the API before and after the test. ExtJS boot + panel render is
 * slow, so the timeouts are generous.
 */

const PVE_POOL = 'pvfix'
const TARGET = 'pvfix/media'
const SCHED_ID = 'snaptime-proof'
const SCHED_NAME = 'snaptime proof'
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

/** Remove the proof schedule through its own door; absent is fine. */
async function deleteSchedule(playwright: PlaywrightWorkerArgs['playwright']): Promise<void> {
  const ctx = await apiContext(playwright)
  try {
    const res = await ctx.delete(`${V1}/schedules/${SCHED_ID}`)
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

/** Pick one entry from the open ExtJS boundlist by its exact text. */
async function pickFromList(field: Locator, text: RegExp): Promise<void> {
  const page = field.page()
  await expect.poll(async () => {
    await field.click()
    return page
      .locator('.x-boundlist:visible .x-boundlist-item', { hasText: text })
      .isVisible()
      .catch(() => false)
  }, { timeout: 30_000 }).toBe(true)
  await page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: text }).first().click()
}

/** Tick / untick an ExtJS checkbox field found by its cls. */
async function setCheckbox(win: Locator, cls: string, check: boolean): Promise<void> {
  const input = win.locator(`${cls} input`).first()
  const checked = await input.evaluate(el => (el as HTMLInputElement).checked)
  if (checked !== check)
    await input.click()
}

/** Fill an ExtJS field and blur it (Tab), so the change event fires. */
async function setField(field: Locator, value: string): Promise<void> {
  const input = field.locator('input').first()
  await input.fill(value)
  await input.press('Tab')
}

test.beforeEach(async ({ playwright }) => {
  skipIfFixtureMissing(
    !(await poolExists(PVE_POOL)) || !(await datasetExists(TARGET)),
    'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
  )
  await deleteSchedule(playwright)
})

test.afterEach(async ({ playwright }) => {
  await deleteSchedule(playwright)
})

test.describe('snaptime.2 — the fire schedule in the dialog and the grid (stunt node fixture)', () => {
  test.setTimeout(240_000)

  test('cadence picks the fire controls; monthly 30 at 01:30 saves, reads and re-opens', async ({ page, playwright }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Snapshots')
    const grid = page.locator('.anas-grid-schedules')
    await expect(grid).toBeVisible({ timeout: 45_000 })
    await page.locator('.anas-btn-sched-new').click()
    const win = page.locator('.anas-win-sched')
    await expect(win).toBeVisible({ timeout: 20_000 })

    await win.locator('.anas-fld-sched-name input').first().fill(SCHED_NAME)
    await win.locator('.anas-fld-sched-id input').first().fill(SCHED_ID)

    // Target: pvfix/media.
    await pickFromList(win.locator('.anas-fld-sched-zfs-pool'), new RegExp(`^${PVE_POOL}$`))
    await pickFromList(win.locator('.anas-fld-sched-zfs-dataset'), /^media$/)

    // Each cadence shows exactly the controls it allows.
    const time = win.locator('.anas-fld-sched-time')
    const weekday = win.locator('.anas-fld-sched-weekday')
    const month = win.locator('.anas-fld-sched-month')
    const day = win.locator('.anas-fld-sched-day')
    const cadence = win.locator('.anas-fld-sched-cadence')

    await pickFromList(cadence, /^monthly$/)
    await expect(time).toBeVisible({ timeout: 20_000 })
    await expect(day).toBeVisible({ timeout: 20_000 })
    await expect(weekday).toBeHidden()
    await expect(month).toBeHidden()

    await pickFromList(cadence, /^yearly$/)
    await expect(month).toBeVisible({ timeout: 20_000 })
    await expect(weekday).toBeHidden()

    await pickFromList(cadence, /^hourly$/)
    await expect(time).toBeHidden({ timeout: 20_000 })
    await expect(weekday).toBeHidden()
    await expect(month).toBeHidden()
    await expect(day).toBeHidden()

    // Back to monthly: day 30 at 01:30 — a day the short months lack, so
    // the hint must say when it really fires.
    await pickFromList(cadence, /^monthly$/)
    await setField(day, '30')
    await setField(time, '01:30')
    const hint = win.locator('.anas-fld-sched-firehint')
    await expect(hint).toBeVisible({ timeout: 20_000 })
    await expect(hint).toContainText('last day')

    // Keep the proof schedule from ever firing on the node.
    await setCheckbox(win, '.anas-fld-sched-enabled', false)
    await win.locator('.anas-btn-sched-submit').click()
    await expect(win).toBeHidden({ timeout: 60_000 })

    // The grid's Cadence cell spells the schedule out.
    const row = grid.locator('.x-grid-row', { hasText: SCHED_NAME }).first()
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toContainText(TARGET)
    await expect(row).toContainText('monthly on the 30th 01:30', { timeout: 20_000 })

    // The daemon holds exactly what was set.
    const ctx = await apiContext(playwright)
    try {
      const res = await ctx.get(`${V1}/schedules`)
      expect(res.status()).toBe(200)
      const list = await res.json() as {
        data: { schedule: { id: string, dayOfMonth?: number, time?: string } }[]
      }
      const stored = list.data.find(s => s.schedule.id === SCHED_ID)
      expect(stored?.schedule.dayOfMonth).toBe(30)
      expect(stored?.schedule.time).toBe('01:30')
    }
    finally {
      await ctx.dispose()
    }

    // Reopen Edit: the controls hold the stored values.
    await row.click()
    await page.locator('.anas-btn-sched-edit').click()
    const edit = page.locator('.anas-win-sched')
    await expect(edit).toBeVisible({ timeout: 20_000 })
    await expect(edit.locator('.anas-fld-sched-day input').first()).toHaveValue('30')
    await expect(edit.locator('.anas-fld-sched-time input').first()).toHaveValue('01:30')
  })
})
