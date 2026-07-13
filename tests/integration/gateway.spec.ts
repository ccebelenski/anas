import { expect, pveAuthState, test } from './fixtures/auth'

/**
 * Story 13.8 — the `anas` gateway is a pure API surface (no pages). These are
 * request-context tests: they exercise the HTTP contract directly, the way the
 * injected ExtJS panels' API helper will.
 *
 * Contracts under test (DESIGN.md → "Public API"):
 *   - PVEAuthCookie auth: no cookie → 401; the cluster-valid ticket → 200.
 *   - Node-as-path routing: `/api/nodes/<node>/v1/*`. The local node forwards to
 *     the anasd socket; a bad node name is a 400; an unreachable node is a 502
 *     with error code NODE_UNREACHABLE.
 *   - CORS: preflight from the PVE UI origin is answered with credentials
 *     allowed, and ONLY for that origin.
 */

const GATEWAY = 'https://192.168.200.50:3000'
const PVE_ORIGIN = 'https://192.168.200.50:8006'
const NODE = 'anas-pve'

test.describe('Gateway API', () => {
  test('rejects requests without a PVE cookie (401)', async ({ playwright }) => {
    // A browser that never logged into PVE — no cookie jar.
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const response = await context.get(`${GATEWAY}/api/health`)
    expect(response.status()).toBe(401)
    await context.dispose()
  })

  test('serves the health probe with the PVE cookie (200)', async ({ playwright, pveTicket }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      storageState: pveAuthState(pveTicket),
    })
    const response = await context.get(`${GATEWAY}/api/health`)
    expect(response.status()).toBe(200)
    await context.dispose()
  })

  test('returns the pool list for the local node with the PVE cookie (200)', async ({ playwright, pveTicket }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      storageState: pveAuthState(pveTicket),
    })
    const response = await context.get(`${GATEWAY}/api/nodes/${NODE}/v1/pools`)
    expect(response.status()).toBe(200)
    // Collection reads return `{ data: [...] }` (DESIGN → Response Conventions).
    const body = await response.json()
    expect(Array.isArray(body.data)).toBe(true)
    await context.dispose()
  })

  test('rejects a malformed node name (400)', async ({ playwright, pveTicket }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      storageState: pveAuthState(pveTicket),
    })
    // Authenticated, so this is a validation failure (400), not an auth failure.
    const response = await context.get(`${GATEWAY}/api/nodes/bad_node!/v1/pools`)
    expect(response.status()).toBe(400)
    await context.dispose()
  })

  test('surfaces an unreachable node as 502 NODE_UNREACHABLE', async ({ playwright, pveTicket }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      storageState: pveAuthState(pveTicket),
    })
    // A syntactically valid node that isn't in the cluster / can't be reached:
    // the gateway forwards, the hop fails, and it reports a gateway error.
    const response = await context.get(`${GATEWAY}/api/nodes/ghost.example/v1/pools`)
    expect(response.status()).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('NODE_UNREACHABLE')
    await context.dispose()
  })

  test('answers CORS preflight for the PVE UI origin with credentials allowed', async ({ playwright }) => {
    // Browsers send preflight without cookies — no auth needed here.
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const response = await context.fetch(`${GATEWAY}/api/nodes/${NODE}/v1/pools`, {
      method: 'OPTIONS',
      headers: {
        'Origin': PVE_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    const headers = response.headers()
    expect(headers['access-control-allow-origin']).toBe(PVE_ORIGIN)
    expect(headers['access-control-allow-credentials']).toBe('true')
    await context.dispose()
  })

  test('does not emit CORS allow headers for a disallowed origin', async ({ playwright }) => {
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const response = await context.fetch(`${GATEWAY}/api/nodes/${NODE}/v1/pools`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    // Only the PVE UI origin is allowed — anything else gets no allow header
    // (and thus the browser blocks the response).
    expect(response.headers()['access-control-allow-origin']).toBeUndefined()
    await context.dispose()
  })
})
