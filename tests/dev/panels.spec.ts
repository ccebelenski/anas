import { test, expect, type Page } from '@playwright/test'

async function waitForApp(page: Page) {
  await page.goto('/')
  await page.locator('[data-nav="pools"]').waitFor({ state: 'visible' })
}

test.describe('Floating Panels', () => {

  test('pool list panel opens and closes with X', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    const panel = page.locator('[data-panel-id="pool-list"]')
    await expect(panel).toBeVisible()

    await panel.locator('[data-close-panel="pool-list"]').click()
    await expect(panel).not.toBeVisible()
  })

  test('pool detail opens when clicking pool name', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()

    await page.locator('[data-panel-id="pool-list"]').getByText('testpool').first().click()
    const detail = page.locator('[data-panel-id="pool-detail-testpool"]')
    await expect(detail).toBeVisible()

    await page.screenshot({ path: '/tmp/panel-detail-opened.png' })
    await expect(detail.getByText('mirror-0')).toBeVisible()
  })

  test('Escape closes topmost panel only', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()

    await page.locator('[data-panel-id="pool-list"]').getByText('testpool').first().click()
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).toBeVisible()

    // Escape closes detail, pool list stays
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).not.toBeVisible()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()

    await page.screenshot({ path: '/tmp/panel-after-escape.png' })
  })

  test('click outside closes panel', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()

    // Click bottom-right of content area
    const content = page.locator('[data-region="content"]')
    const box = await content.boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width - 50, box.y + box.height - 50)
    }
    await page.waitForTimeout(300)

    await expect(page.locator('[data-panel-id="pool-list"]')).not.toBeVisible()
    await page.screenshot({ path: '/tmp/panel-after-outside.png' })
  })

  test('disk panel opens with data', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="disks"]').click()
    const panel = page.locator('[data-panel-id="disk-list"]')
    await expect(panel).toBeVisible()

    await page.screenshot({ path: '/tmp/panel-disks.png' })
    await expect(panel.getByText('sda', { exact: true }).first()).toBeVisible()
  })
})
