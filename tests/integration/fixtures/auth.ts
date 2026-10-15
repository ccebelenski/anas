import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { test as base, expect } from '@playwright/test'
import { PVE_URL, STUNT_HOST } from './pve-ui'
import { PVE_ROOT_PASSWORD } from './target'

const PVE_USER = 'root@pam'
const PVE_PASS = PVE_ROOT_PASSWORD

/**
 * cr.25b — the ONE door for authenticated API request contexts.
 *
 * PVE's CSRF token is bound to the user id and a timestamp, not to the
 * ticket (WAVE2-DESIGN.md §3), so the `PVEAuthCookie` and the
 * `CSRFPreventionToken` on a context MUST come from the SAME
 * `/access/ticket` reply. `pveLogin` performs that login and hands back
 * both halves; `apiContext` puts the cookie in `storageState` and the
 * token in `extraHTTPHeaders` of one `request.newContext`. The token is
 * valid 2 h — far longer than a Playwright worker lives — so one login
 * per (user, password) is cached per worker and every context reuses it.
 *
 * Contexts deliberately NOT built here (the allowed exceptions, see the
 * cr.25b report): the no-cookie contexts that prove the 401 path and the
 * cookieless OPTIONS preflight, and `authenticatedPage` (a browser
 * context driving the real UI, where PVE's own JS supplies the token).
 */

/** One `/access/ticket` reply: the two halves that belong together. */
export interface PveSession {
  ticket: string
  csrf: string
}

const loginCache = new Map<string, Promise<PveSession>>()

/** Log in (or reuse this worker's cached login) and return ticket + CSRF token. */
export async function pveLogin(
  playwright: PlaywrightWorkerArgs['playwright'],
  username: string = PVE_USER,
  password: string = PVE_PASS,
): Promise<PveSession> {
  const key = JSON.stringify([username, password])
  const cached = loginCache.get(key)
  if (cached)
    return cached
  const pending = (async (): Promise<PveSession> => {
    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    try {
      const response = await login.post(
        `${PVE_URL}/api2/json/access/ticket`,
        { form: { username, password } },
      )
      if (!response.ok())
        throw new Error(`PVE login for ${username} failed: HTTP ${response.status()}`)
      const data = (await response.json()).data as { ticket: string, CSRFPreventionToken: string }
      return { ticket: data.ticket, csrf: data.CSRFPreventionToken }
    }
    finally {
      await login.dispose()
    }
  })()
  loginCache.set(key, pending)
  try {
    return await pending
  }
  catch (err) {
    // A failed login is not a session — never cache the rejection.
    loginCache.delete(key)
    throw err
  }
}

/**
 * An `APIRequestContext` whose cookie and CSRF token come from one login
 * (see `pveLogin`). `headers` merge into the per-context extra headers;
 * `timeout` overrides Playwright's per-request timeout (the reboot spec
 * polls through a node reboot with it).
 */
export async function apiContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  opts: {
    username?: string
    password?: string
    headers?: Record<string, string>
    timeout?: number
  } = {},
): Promise<APIRequestContext> {
  const session = await pveLogin(playwright, opts.username, opts.password)
  return playwright.request.newContext({
    baseURL: PVE_URL,
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(session.ticket),
    extraHTTPHeaders: { CSRFPreventionToken: session.csrf, ...opts.headers },
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  })
}

interface AuthFixtures {
  pveTicket: string
  pveCsrfToken: string
  authenticatedPage: import('@playwright/test').Page
}

export const test = base.extend<AuthFixtures>({
  // Kept for callers that need the bare ticket (the ticket-format test and
  // `authenticatedPage`, which feeds it to a browser cookie store). Both
  // fixtures now ride the one cached login, so `pveTicket` and `apiContext`
  // in the same worker share a single session.
  pveTicket: async ({ playwright }, use) => {
    await use((await pveLogin(playwright)).ticket)
  },

  pveCsrfToken: async ({ playwright }, use) => {
    await use((await pveLogin(playwright)).csrf)
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
        domain: STUNT_HOST,
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

/**
 * Build a Playwright storageState carrying the PVE session cookie, for use with
 * `request.newContext({ storageState })` in request-context (API) tests. Mirrors
 * the attributes the real PVE UI sets (Secure + SameSite=Lax) — the Secure flag
 * is why the gateway must serve HTTPS (the browser withholds the cookie on plain
 * HTTP, which once masked a transport bug; see pve-login-flow.spec.ts).
 */
export function pveAuthState(ticket: string) {
  return {
    cookies: [
      {
        name: 'PVEAuthCookie',
        value: ticket,
        domain: STUNT_HOST,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  }
}

export { expect }
