import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

async function waitForApp(page: Page) {
  await page.goto('/')
  await page.locator('[data-nav="pools"]').waitFor({ state: 'visible' })
}

// Open the routed pools view and its floating pool-detail panel for testpool.
async function openPoolDetail(page: Page) {
  await page.locator('[data-nav="pools"]').click()
  await expect(page).toHaveURL(/\/storage\/pools$/)

  const select = page.locator('[data-pool-select="testpool"]')
  await expect(select).toBeVisible()
  await select.click()

  const detail = page.locator('[data-panel-id="pool-detail-testpool"]')
  await expect(detail).toBeVisible()
  return detail
}

test.describe('Routed views + floating panels', () => {
  test('sidebar Pools navigates to the pools view (list is page content)', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    await expect(page).toHaveURL(/\/storage\/pools$/)

    // The pool list renders as page content, not a floating panel.
    await expect(page.locator('[data-panel-id="pool-list"]')).toHaveCount(0)
    await expect(page.locator('[data-region="content"] [data-pool-select="testpool"]')).toBeVisible()
  })

  test('pool detail opens as a floating panel over the pools view', async ({ page }) => {
    await waitForApp(page)

    const detail = await openPoolDetail(page)
    await page.screenshot({ path: '/tmp/panel-detail-opened.png' })

    // Detail panel floats above the page content.
    const detailZ = await detail.evaluate(el => Number.parseInt((el as HTMLElement).style.zIndex))
    expect(detailZ).toBeGreaterThan(0)
  })

  test('Escape closes the pool detail panel, view stays', async ({ page }) => {
    await waitForApp(page)

    await openPoolDetail(page)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).not.toBeVisible()
    // The routed view remains.
    await expect(page.locator('[data-region="content"] [data-pool-select="testpool"]')).toBeVisible()
  })

  test('click outside closes the pool detail panel', async ({ page }) => {
    await waitForApp(page)

    await openPoolDetail(page)

    const content = page.locator('[data-region="content"]')
    const box = await content.boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20)
    }
    await page.waitForTimeout(300)
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).not.toBeVisible()
  })

  test('pool detail panel is draggable', async ({ page }) => {
    await waitForApp(page)

    const detail = await openPoolDetail(page)

    const header = detail.locator('.fp-header')
    const box = await header.boundingBox()
    expect(box).toBeTruthy()

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 50, { steps: 5 })
    await page.mouse.up()

    const hasCentered = await detail.evaluate(el => el.classList.contains('fp-centered'))
    expect(hasCentered).toBe(false)
  })

  test('sidebar Disks navigates to the disks view with data', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="disks"]').click()
    await expect(page).toHaveURL(/\/storage\/disks$/)

    await expect(page.locator('[data-panel-id="disk-list"]')).toHaveCount(0)
    await expect(page.locator('[data-region="content"] [data-disk-name="sda"]')).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: '/tmp/panel-disks.png' })
  })
})
