import type { AuthProvider, AuthUser } from './auth/index.js'
import type { GatewayConfig } from './config.js'
import { VERSION } from '@anas/shared'
import Fastify from 'fastify'
import { createAuthProvider } from './auth/index.js'
import { loadConfig } from './config.js'
import { NODE_NAME_RE } from './node-name.js'
import { FORWARDED_HEADER, forwardToNode, proxyToLocalSocket } from './proxy.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user, attached by the auth hook. */
    user?: AuthUser
  }
}

export interface ServerOptions {
  /** Resolved config. Defaults to loadConfig() (env). */
  config?: GatewayConfig
  /** Override the auth provider (tests inject a stub). Defaults to env. */
  authProvider?: AuthProvider
  /** Enable request logging. Default: true. Disable in unit tests. */
  logger?: boolean
}

/** Read a named cookie out of a raw Cookie header. */
function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader)
    return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0)
      continue
    if (part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function createServer(opts: ServerOptions = {}) {
  const config = opts.config ?? loadConfig()
  const provider = opts.authProvider ?? createAuthProvider(config.authProvider)

  // pveproxy terminates TLS at :8006 and forwards to this loopback service, so
  // the gateway is a plain-HTTP internal service — no TLS, no public origin.
  const server = Fastify({ logger: opts.logger ?? true })

  // Pure gateway: never parse bodies — forward them verbatim as raw Buffers.
  server.removeAllContentTypeParsers()
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  // Version-skew visibility (12.1): every response names this gateway's
  // version. Forwarded peer responses keep it too — relayHeaders never copies
  // the peer's copy — so the header always identifies the gateway the browser
  // is actually talking to. Requests are same-origin (via :8006/anas), so the
  // header needs no CORS-expose.
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('x-anas-version', VERSION)
  })

  // Unauthenticated ANAS-presence probe: panels hit /anas/installed pre-login to
  // detect whether ANAS is on a node without provoking a 401. Must bypass auth.
  server.get('/installed', async () => {
    return { name: 'anas', version: VERSION }
  })

  // Auth: verify PVEAuthCookie (or dev), attach { name, uid } → 401 otherwise.
  server.addHook('onRequest', async (request, reply) => {
    // The unauthenticated presence probe is exempt (panels hit it pre-login).
    const path = request.url.split('?', 1)[0]
    if (request.method === 'GET' && path === '/installed')
      return

    if (provider.name === 'dev') {
      request.user = (await provider.validateToken('')) ?? undefined
      return
    }

    const cookie = readCookie(request.headers.cookie, 'PVEAuthCookie')
    if (cookie) {
      const user = await provider.validateToken(cookie)
      if (user) {
        request.user = user
        return
      }
    }

    return reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Access ANAS through the Proxmox UI' },
    })
  })

  // Gateway health — the panels' not-installed probe target.
  server.get('/api/health', async () => {
    return { data: { node: config.nodeName, version: VERSION } }
  })

  // Node-scoped API: local node → anasd socket; other node → peer gateway.
  server.all('/api/nodes/:node/v1/*', async (request, reply) => {
    const { node } = request.params as { 'node': string, '*': string }

    if (!NODE_NAME_RE.test(node)) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Invalid node name: '${node}'` },
      })
    }

    if (node === config.nodeName) {
      // Preserve the path's original percent-encoding. Fastify decodes the
      // wildcard param, turning %2F into a literal '/', which corrupts daemon
      // routes keyed by a URL-encoded path — e.g. NFS exports at
      // /shares/nfs/:path (identity is the URL-encoded mountpoint). Slice the
      // still-encoded suffix (path + query) out of the raw request URL instead.
      const marker = `/api/nodes/${node}/v1/`
      const idx = request.url.indexOf(marker)
      const rest = idx >= 0
        ? request.url.slice(idx + marker.length)
        : `${(request.params as { '*': string })['*'] ?? ''}`
      const anasdPath = `/v1/${rest}`
      await proxyToLocalSocket(request, reply, {
        socketPath: config.anasdSocket,
        anasdPath,
        user: request.user,
      })
      return
    }

    // Loop guard (defense in depth). The legitimate cross-node flow is
    // browser → entry gateway → peer :8006 → peer gateway → LOCAL socket: the
    // peer receives the marker and serves locally (handled above). Reaching
    // HERE with the marker means a gateway received an already-forwarded
    // request and would forward it AGAIN — the shape of a node-identity
    // mismatch (issue #5: an FQDN hostname made a gateway not recognise its own
    // node, so it forwarded to itself through pveproxy until timeouts). Fail as
    // one clean error instead of a request loop.
    if (request.headers[FORWARDED_HEADER] !== undefined) {
      return reply.code(502).send({
        error: {
          code: 'FORWARD_LOOP',
          message: `Refusing to forward the request for node '${node}' a second time: it was already forwarded once, and this gateway does not recognise itself as '${node}' (its node identity is '${config.nodeName}'). The gateway's node name does not match the PVE node name.`,
        },
      })
    }

    await forwardToNode(request, reply, {
      node,
      pvePort: config.pvePort,
      clusterCa: config.clusterCa,
      membersPath: config.membersPath,
      ...(config.forwardTimeoutMs !== undefined ? { timeoutMs: config.forwardTimeoutMs } : {}),
    })
  })

  return server
}
