import type { FastifyReply, FastifyRequest } from 'fastify'

/** The PVE web UI always runs on port 8006. */
const PVE_UI_PORT = 8006

/**
 * Strip the port (and IPv6 brackets) from a Host header, yielding the bare
 * hostname. `pve1:3000` → `pve1`, `[::1]:3000` → `::1`, `pve1` → `pve1`.
 */
export function hostnameFromHost(host: string | undefined): string | undefined {
  if (!host)
    return undefined

  // IPv6 literal: [addr]:port or [addr]
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : undefined
  }

  const colon = host.indexOf(':')
  return colon >= 0 ? host.slice(0, colon) : host
}

/**
 * The single CORS origin the gateway trusts: the PVE UI on this same host.
 * Derived per-request from the Host header so it works regardless of the
 * node's actual hostname. Returns undefined if the Host header is missing.
 */
export function allowedOrigin(request: FastifyRequest): string | undefined {
  const hostname = hostnameFromHost(request.headers.host)
  return hostname ? `https://${hostname}:${PVE_UI_PORT}` : undefined
}

/**
 * onRequest CORS hook.
 *
 * Allows exactly `https://<own-hostname>:8006` (the PVE UI) with credentials.
 * No wildcard, no other origins. Answers OPTIONS preflight immediately and
 * unauthenticated — the auth hook runs after this and would otherwise 401 a
 * preflight (which carries no cookie).
 */
export async function corsHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const allowed = allowedOrigin(request)
  const requestOrigin = request.headers.origin

  // Emit CORS headers only when the request's Origin is exactly the trusted
  // PVE UI origin. Same-origin/non-browser requests (no Origin header) need no
  // CORS headers, and disallowed origins must not receive any allow headers.
  if (allowed && requestOrigin === allowed) {
    reply.header('access-control-allow-origin', allowed)
    reply.header('access-control-allow-credentials', 'true')
    reply.header('vary', 'Origin')
    reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    reply.header('access-control-allow-headers', 'content-type, x-anas-confirm')
    // The 409 confirmation contract lives in response headers the browser must
    // read cross-origin; without this the ExtJS panels can't see the code.
    // x-anas-version feeds the UI's version-skew warning (12.1).
    reply.header('access-control-expose-headers', 'x-anas-confirm-code, x-anas-confirm-expires, x-anas-version')
  }

  if (request.method === 'OPTIONS') {
    // Preflight: short-circuit before auth (a preflight carries no cookie).
    // 204 with no allow headers for disallowed origins — the browser blocks.
    await reply.code(204).send()
  }
}
