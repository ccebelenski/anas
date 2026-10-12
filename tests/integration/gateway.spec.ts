import { expect, pveAuthState, test } from './fixtures/auth'
import { GATEWAY_URL, NODE_NAME, PVE_URL } from './fixtures/pve-ui'

/**
 * Story 13.8 — the `anas` gateway is a pure API surface (no pages). These are
 * request-context tests: they exercise the HTTP contract directly, the way the
 * injected ExtJS panels' API helper will.
 *
 * Contracts under test (DESIGN.md → "Public API"):
 *   - PVEAuthCookie auth: no cookie → 401; the cluster-valid ticket → 200.
 *   - Node-as-path routing: `/api/nodes/<node>/v1/*`. The local node forwards to
 *     the anasd socket; a bad node name is a 400; an unreachable node is a 502
 *     with error code NODE_UNRESOLVED (not in the cluster membership); a
 *     connection failure is 502 NODE_UNREACHABLE.
 *   - No CORS: the gateway is same-origin behind pveproxy's :8006/anas, so it
 *     emits no Access-Control-Allow-* headers for any origin, the PVE UI included.
 */

const GATEWAY = GATEWAY_URL
const PVE_ORIGIN = PVE_URL
const NODE = NODE_NAME

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

  test('surfaces a node outside the cluster membership as 502 NODE_UNRESOLVED', async ({ playwright, pveTicket }) => {
    const context = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      storageState: pveAuthState(pveTicket),
    })
    // A syntactically valid node that is not in /etc/pve/.members: the gateway
    // cannot resolve its address and reports a gateway error.
    const response = await context.get(`${GATEWAY}/api/nodes/ghost.example/v1/pools`)
    expect(response.status()).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('NODE_UNRESOLVED')
    await context.dispose()
  })

  test('emits no CORS headers for a preflight from the PVE UI origin', async ({ playwright }) => {
    // Browsers send preflight without cookies — no auth needed here. The
    // gateway is same-origin (via pveproxy :8006/anas), so PVE's origin gets
    // no allow headers either.
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const response = await context.fetch(`${GATEWAY}/api/nodes/${NODE}/v1/pools`, {
      method: 'OPTIONS',
      headers: {
        'Origin': PVE_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    // No access-control-* header of any kind (the gateway unit suite's rule).
    const cors = Object.keys(response.headers()).filter(h => h.startsWith('access-control-'))
    expect(cors).toEqual([])
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
    // No origin is allowed (no CORS at all) — a foreign origin gets no allow
    // header, so the browser blocks the response.
    expect(response.headers()['access-control-allow-origin']).toBeUndefined()
    await context.dispose()
  })
})
