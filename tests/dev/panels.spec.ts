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

  test('pool detail opens on top of pool list', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    const poolList = page.locator('[data-panel-id="pool-list"]')
    await expect(poolList).toBeVisible()

    await poolList.getByText('testpool').first().click()
    const detail = page.locator('[data-panel-id="pool-detail-testpool"]')
    await expect(detail).toBeVisible()

    // Detail should have higher z-index than pool list
    const listZ = await poolList.evaluate(el => parseInt(el.style.zIndex))
    const detailZ = await detail.evaluate(el => parseInt(el.style.zIndex))
    expect(detailZ).toBeGreaterThan(listZ)

    await page.screenshot({ path: '/tmp/panel-detail-opened.png' })
    await expect(detail.getByText('mirror-0')).toBeVisible()
  })

  test('Escape closes topmost panel only', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()

    await page.locator('[data-panel-id="pool-list"]').getByText('testpool').first().click()
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).toBeVisible()

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await expect(page.locator('[data-panel-id="pool-detail-testpool"]')).not.toBeVisible()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()
  })

  test('click outside closes panel', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    await expect(page.locator('[data-panel-id="pool-list"]')).toBeVisible()

    const content = page.locator('[data-region="content"]')
    const box = await content.boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width - 50, box.y + box.height - 50)
    }
    await page.waitForTimeout(300)
    await expect(page.locator('[data-panel-id="pool-list"]')).not.toBeVisible()
  })

  test('panel is draggable', async ({ page }) => {
    await waitForApp(page)

    await page.locator('[data-nav="pools"]').click()
    const panel = page.locator('[data-panel-id="pool-list"]')
    await expect(panel).toBeVisible()

    const header = panel.locator('.fp-header')
    const box = await header.boundingBox()
    expect(box).toBeTruthy()

    // Drag the panel 100px right and 50px down
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 50, { steps: 5 })
    await page.mouse.up()

    // Panel should have moved (no longer centered)
    const hasTransform = await panel.evaluate(el => el.classList.contains('fp-centered'))
    expect(hasTransform).toBe(false)

    await page.screenshot({ path: '/tmp/panel-dragged.png' })
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
