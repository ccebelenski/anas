import { expect, pveAuthState, test } from './fixtures/auth'

const GATEWAY = 'https://192.168.200.50:3000'

/**
 * Auth boundary smoke tests. The `anas` gateway serves no pages (13.13) — its
 * authenticated surface is the API, so these exercise `GET /api/health`, the
 * probe the native panels use before rendering, rather than a page load.
 */
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

  test('the gateway rejects unauthenticated API requests', async ({ playwright }) => {
    // No cookie: a browser that never logged into PVE.
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const response = await context.get(`${GATEWAY}/api/health`)
    expect(response.status()).toBe(401)
    await context.dispose()
  })

  test('the gateway accepts the PVE auth cookie', async ({ playwright, pveTicket }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      storageState: pveAuthState(pveTicket),
    })
    const response = await context.get(`${GATEWAY}/api/health`)
    expect(response.status()).toBe(200)
    await context.dispose()
  })
})
