import { test, expect } from '@playwright/test'

test.describe('Floating Panels', () => {

  test('pool list panel opens and closes with X', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)

    await page.getByText('Pools').click()
    await page.waitForTimeout(500)

    const panel = page.locator('.floating-panel').first()
    await expect(panel).toBeVisible()
    await expect(panel.getByText('testpool')).toBeVisible()

    // Close with X button
    await panel.locator('.floating-panel-close').click()
    await page.waitForTimeout(300)
    await expect(page.locator('.floating-panel')).toHaveCount(0)
  })

  test('pool detail opens when clicking pool name', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)

    await page.getByText('Pools').click()
    await page.waitForTimeout(500)

    const poolPanel = page.locator('.floating-panel').first()
    await expect(poolPanel).toBeVisible()

    // Click testpool name to open detail
    await poolPanel.getByText('testpool').first().click()
    await page.waitForTimeout(1000)

    await page.screenshot({ path: '/tmp/panel-detail-opened.png' })

    // Should have 2 panels now
    const panelCount = await page.locator('.floating-panel').count()
    expect(panelCount).toBe(2)
  })

  test('Escape closes topmost panel only', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)

    // Ensure no panels open
    await expect(page.locator('.floating-panel')).toHaveCount(0)

    await page.locator('.nav-child', { hasText: 'Pools' }).click()
    await page.waitForTimeout(500)
    await expect(page.locator('.floating-panel').first()).toBeVisible()

    // Open detail
    await page.locator('.floating-panel').first().getByText('testpool').first().click()
    await page.waitForTimeout(1000)

    const before = await page.locator('.floating-panel').count()
    expect(before).toBe(2)

    // Escape should close detail but leave pool list
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    await page.screenshot({ path: '/tmp/panel-after-escape.png' })
    const after = await page.locator('.floating-panel').count()
    expect(after).toBe(1)
  })

  test('click outside closes panel', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)

    await page.locator('.nav-child', { hasText: 'Pools' }).click()
    await page.waitForTimeout(500)
    await expect(page.locator('.floating-panel').first()).toBeVisible()

    // Click bottom-right of content area (away from panel)
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
    await page.goto('/')
    await page.waitForTimeout(500)

    await page.getByText('Disks').click()
    await page.waitForTimeout(1000)

    const panel = page.locator('.floating-panel').first()
    await expect(panel).toBeVisible()

    await page.screenshot({ path: '/tmp/panel-disks.png' })
    // Check for disk data — use exact match to avoid ambiguity
    await expect(panel.getByText('sda', { exact: true }).first()).toBeVisible()
  })
})
