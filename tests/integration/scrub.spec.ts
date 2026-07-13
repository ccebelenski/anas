import { expect, test } from './fixtures/auth'
import { getZpoolStatus, poolExists } from './fixtures/stunt-node'

test.describe('Pool Scrub', () => {
  test('starting a scrub from the UI runs a real scrub', async ({ authenticatedPage: page }) => {
    test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')

    await page.goto('/')
    await page.locator('[data-nav="pools"]').click()
    const poolList = page.locator('[data-panel-id="pool-list"]')
    await expect(poolList).toBeVisible()
    await poolList.locator('[data-pool-select="testpool"]').click()

    const detail = page.locator('[data-panel-id="pool-detail-testpool"]')
    await expect(detail).toBeVisible()

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

    // The source of truth: zpool status on the real system shows the scrub
    // (a 512M empty mirror finishes almost instantly, so match either state)
    await expect
      .poll(async () => getZpoolStatus('testpool'), { timeout: 30_000 })
      .toMatch(/scrub in progress|scrub repaired/)

    await expect(detail.locator('[data-id="scrub-error"]')).not.toBeVisible()
  })
})
