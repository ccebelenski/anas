import { test, expect, type Page } from '@playwright/test'

/** Wait for the app to fully hydrate by checking the sidebar is interactive */
async function waitForApp(page: Page) {
  await page.goto('/')
  await page.locator('button.nav-child', { hasText: 'Pools' }).waitFor({ state: 'visible' })
}

test.describe('Floating Panels', () => {

  test('pool list panel opens and closes with X', async ({ page }) => {
    await waitForApp(page)

    await page.locator('button.nav-child', { hasText: 'Pools' }).click()
    const panel = page.locator('.floating-panel').first()
    await expect(panel).toBeVisible()
    await expect(panel.getByText('testpool')).toBeVisible()

    await panel.locator('.floating-panel-close').click()
    await expect(page.locator('.floating-panel')).toHaveCount(0)
  })

  test('pool detail opens when clicking pool name', async ({ page }) => {
    await waitForApp(page)

    await page.locator('button.nav-child', { hasText: 'Pools' }).click()
    const poolPanel = page.locator('.floating-panel').first()
    await expect(poolPanel).toBeVisible()

    await poolPanel.getByText('testpool').first().click()
    await page.locator('.floating-panel').nth(1).waitFor({ state: 'visible' })

    await page.screenshot({ path: '/tmp/panel-detail-opened.png' })
    expect(await page.locator('.floating-panel').count()).toBe(2)

    const detailPanel = page.locator('.floating-panel').nth(1)
    await expect(detailPanel.getByText('mirror-0')).toBeVisible()
  })

  test('Escape closes topmost panel only', async ({ page }) => {
    await waitForApp(page)

    await page.locator('button.nav-child', { hasText: 'Pools' }).click()
    await expect(page.locator('.floating-panel').first()).toBeVisible()

    await page.locator('.floating-panel').first().getByText('testpool').first().click()
    await page.locator('.floating-panel').nth(1).waitFor({ state: 'visible' })
    expect(await page.locator('.floating-panel').count()).toBe(2)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    await page.screenshot({ path: '/tmp/panel-after-escape.png' })
    expect(await page.locator('.floating-panel').count()).toBe(1)
  })

  test('click outside closes panel', async ({ page }) => {
    await waitForApp(page)

    await page.locator('button.nav-child', { hasText: 'Pools' }).click()
    await expect(page.locator('.floating-panel').first()).toBeVisible()

    const content = page.locator('.app-content')
    const box = await content.boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width - 50, box.y + box.height - 50)
    }
    await page.waitForTimeout(300)

    await page.screenshot({ path: '/tmp/panel-after-outside.png' })
    await expect(page.locator('.floating-panel')).toHaveCount(0)
  })

  test('disk panel opens with data', async ({ page }) => {
    await waitForApp(page)

    await page.locator('button.nav-child', { hasText: 'Disks' }).click()
    const panel = page.locator('.floating-panel').first()
    await expect(panel).toBeVisible()

    await page.screenshot({ path: '/tmp/panel-disks.png' })
    await expect(panel.getByText('sda', { exact: true }).first()).toBeVisible()
  })
})
