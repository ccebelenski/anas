import type { FastifyServerOptions } from 'fastify'
import type { AuthProvider, AuthUser } from './auth/index.js'
import type { GatewayConfig } from './config.js'
import { VERSION } from '@anas/shared'
import Fastify from 'fastify'
import { createAuthProvider } from './auth/index.js'
import { loadConfig } from './config.js'
import { corsHook } from './cors.js'
import { forwardToNode, proxyToLocalSocket } from './proxy.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user, attached by the auth hook. */
    user?: AuthUser
  }
}

/** Node names are hostnames: alphanumerics, dots, hyphens. */
const NODE_NAME_RE = /^[a-z0-9.-]+$/i

export interface ServerOptions {
  /** Resolved config. Defaults to loadConfig() (env). */
  config?: GatewayConfig
  /** Override the auth provider (tests inject a stub). Defaults to env. */
  authProvider?: AuthProvider
  /** Enable request logging. Default: true. Disable in unit tests. */
  logger?: boolean
  /** HTTPS cert/key. Absent → plain HTTP. */
  https?: { cert: string | Buffer, key: string | Buffer }
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

  // Build a single options object and call Fastify once. Branching between two
  // Fastify() calls would union the HTTP and HTTPS instance types and make the
  // instance's own methods non-callable. `https` is read at runtime regardless
  // of the (HTTP) static type we cast to.
  const fastifyOpts = { logger: opts.logger ?? true } as FastifyServerOptions
  if (opts.https)
    (fastifyOpts as { https?: ServerOptions['https'] }).https = opts.https
  const server = Fastify(fastifyOpts)

  // Pure gateway: never parse bodies — forward them verbatim as raw Buffers.
  server.removeAllContentTypeParsers()
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  // 1. CORS (also answers OPTIONS preflight, unauthenticated).
  server.addHook('onRequest', corsHook)

  // 2. Auth: verify PVEAuthCookie (or dev), attach { name, uid } → 401 otherwise.
  server.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS')
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

    await forwardToNode(request, reply, {
      node,
      port: config.port,
      clusterCa: config.clusterCa,
    })
  })

  return server
}
