import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

async function openPoolDetail(page: Page) {
  await page.goto('/')
  await page.locator('[data-nav="pools"]').waitFor({ state: 'visible' })
  await page.locator('[data-nav="pools"]').click()
  const poolList = page.locator('[data-panel-id="pool-list"]')
  await expect(poolList).toBeVisible()
  await poolList.locator('[data-pool-select="testpool"]').click()
  const detail = page.locator('[data-panel-id="pool-detail-testpool"]')
  await expect(detail).toBeVisible()
  return detail
}

test.describe('Pool Scrub', () => {
  test('start scrub submits a job and refreshes the detail', async ({ page }) => {
    const detail = await openPoolDetail(page)

    const btn = detail.locator('[data-id="start-scrub"]')
    await expect(btn).toBeVisible()
    await expect(btn).toBeEnabled()

    const [scrubResponse] = await Promise.all([
      page.waitForResponse(r =>
        r.url().includes('/api/pools/testpool/scrub') && r.request().method() === 'POST'),
      btn.click(),
    ])
    expect(scrubResponse.status()).toBe(202)
    const body = await scrubResponse.json()
    expect(body.job.operation).toBe('zpool.scrub')
    expect(body.job.id).toBeTruthy()

    // Job completes on the mock, which triggers a pool detail refresh
    await page.waitForResponse(r =>
      r.url().endsWith('/api/pools/testpool') && r.request().method() === 'GET', { timeout: 15000 })

    await expect(detail.locator('[data-id="scrub-error"]')).not.toBeVisible()
    await expect(btn).toBeEnabled()
  })
})
