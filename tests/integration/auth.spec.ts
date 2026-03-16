import { expect, test } from './fixtures/auth'

test.describe('Authentication', () => {
  test('can obtain PVE auth ticket', async ({ pveTicket }) => {
    expect(pveTicket).toBeTruthy()
    // PVE tickets start with "PVE:"
    expect(pveTicket).toMatch(/^PVE:/)
  })

  test('PVE web UI is accessible', async ({ playwright }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
    })
    const response = await context.get('https://192.168.200.50:8006/')
    expect(response.ok()).toBeTruthy()
    await context.dispose()
  })

  test('ANAS rejects unauthenticated requests', async ({ page }) => {
    const response = await page.goto('/')
    expect(response).not.toBeNull()
    expect(response!.status()).toBe(401)
  })

  test('ANAS accepts PVE auth cookie', async ({ authenticatedPage }) => {
    const response = await authenticatedPage.goto('/')
    expect(response).not.toBeNull()
    expect(response!.status()).toBeLessThan(400)
  })
})
