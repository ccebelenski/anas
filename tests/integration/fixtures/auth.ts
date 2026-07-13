import { test as base, expect } from '@playwright/test'

const PVE_URL = 'https://192.168.200.50:8006'
const PVE_USER = 'root@pam'
const PVE_PASS = 'anas-test'

interface AuthFixtures {
  pveTicket: string
  pveCsrfToken: string
  authenticatedPage: import('@playwright/test').Page
}

export const test = base.extend<AuthFixtures>({
  pveTicket: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
    })
    const response = await context.post(
      `${PVE_URL}/api2/json/access/ticket`,
      {
        form: {
          username: PVE_USER,
          password: PVE_PASS,
        },
      },
    )
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    const ticket = body.data.ticket
    await context.dispose()
    await use(ticket)
  },

  pveCsrfToken: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
    })
    const response = await context.post(
      `${PVE_URL}/api2/json/access/ticket`,
      {
        form: {
          username: PVE_USER,
          password: PVE_PASS,
        },
      },
    )
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    const token = body.data.CSRFPreventionToken
    await context.dispose()
    await use(token)
  },

  authenticatedPage: async ({ browser, pveTicket }, use) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    })
    // Set the PVE auth cookie with the same attributes the real PVE UI
    // uses (proxmoxlib.js setAuthData): Secure + SameSite=Lax. The Secure
    // flag matters — it's why ANAS must serve HTTPS (story 10.4).
    await context.addCookies([
      {
        name: 'PVEAuthCookie',
        value: pveTicket,
        domain: '192.168.200.50',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
    ])
    const page = await context.newPage()
    await use(page)
    await context.close()
  },
})

export { expect }
