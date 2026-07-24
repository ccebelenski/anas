import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUser } from './auth/index.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

/** Response headers passed straight back to the browser (the 409 confirm contract). */
const PASSTHROUGH_RESPONSE_HEADERS = [
  'content-type',
  'x-anas-confirm-code',
  'x-anas-confirm-expires',
] as const

interface UpstreamResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** Copy a header from the upstream response onto the client reply, if present. */
function relayHeaders(reply: FastifyReply, headers: UpstreamResult['headers']): void {
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = headers[name]
    if (value !== undefined)
      reply.header(name, value)
  }
}

/**
 * Proxy the request to the local anasd Unix socket.
 *
 * Strips the `/api/nodes/<node>` prefix (the caller supplies `anasdPath`,
 * already `/v1/...` with query) and attaches the X-Anas-* identity headers
 * exactly as the retired Nuxt server did. Passes through status, body, and
 * the X-Anas-Confirm-* headers.
 */
export async function proxyToLocalSocket(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { socketPath: string, anasdPath: string, user: AuthUser | undefined },
): Promise<void> {
  const headers: Record<string, string> = {
    'accept': 'application/json',
    'x-anas-request-id': randomUUID(),
  }

  if (opts.user) {
    headers['x-anas-user'] = opts.user.name
    headers['x-anas-user-uid'] = String(opts.user.uid)
  }

  // Forward the confirmation code for dangerous operations, if the client sent one.
  const confirm = request.headers['x-anas-confirm']
  if (typeof confirm === 'string')
    headers['x-anas-confirm'] = confirm

  const body = request.body instanceof Buffer && request.body.length > 0
    ? request.body
    : undefined
  if (body) {
    headers['content-type'] = (request.headers['content-type'] as string) ?? 'application/json'
    headers['content-length'] = String(body.length)
  }

  try {
    const result = await new Promise<UpstreamResult>((resolve, reject) => {
      const req = httpRequest(
        { socketPath: opts.socketPath, method: request.method, path: opts.anasdPath, headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({
            status: res.statusCode ?? 502,
            headers: res.headers as UpstreamResult['headers'],
            body: Buffer.concat(chunks),
          }))
        },
      )
      req.on('error', reject)
      if (body)
        req.write(body)
      req.end()
    })

    relayHeaders(reply, result.headers)
    await reply.code(result.status).send(result.body)
  }
  catch (err) {
    await reply.code(502).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: `anasd unavailable: ${(err as Error).message}`,
      },
    })
  }
}

let cachedCaPath: string | undefined
let cachedCa: string | Buffer | undefined

/**
 * Read the cluster CA, caching ONLY a successful load (keyed by path). A failed
 * read is never cached, so a transient boot-race miss (a request that lands
 * before pmxcfs mounts /etc/pve) self-heals: the next request re-reads and, once
 * /etc/pve is up, succeeds. Returns undefined only when the CA is currently
 * unreadable — the caller MUST then refuse to forward rather than fall back to
 * Node's public trust store.
 */
function loadClusterCa(request: FastifyRequest, caPath: string): string | Buffer | undefined {
  if (cachedCa !== undefined && cachedCaPath === caPath)
    return cachedCa
  try {
    const ca = readFileSync(caPath)
    cachedCa = ca
    cachedCaPath = caPath
    return ca
  }
  catch {
    request.log.warn(`[gateway] Cluster CA ${caPath} unreadable — refusing to forward (peer TLS trust anchor unavailable)`)
    return undefined
  }
}

/**
 * Forward the whole request to a peer node's gateway over HTTPS.
 *
 * Same path, forwarding the user's PVEAuthCookie so the remote gateway
 * verifies the ticket against the replicated cluster authkey exactly as for a
 * direct request. The TLS hop is verified against the cluster CA. Connection
 * failure → 502 NODE_UNREACHABLE naming the node.
 */
export async function forwardToNode(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { node: string, port: number, clusterCa: string },
): Promise<void> {
  const ca = loadClusterCa(request, opts.clusterCa)
  if (ca === undefined) {
    // Fail CLOSED: without the cluster CA we cannot verify the peer's TLS
    // identity, and building an HttpsAgent without it would silently fall back
    // to Node's PUBLIC trust store — forwarding the operator's PVEAuthCookie
    // over a hop we can't authenticate. Refuse instead.
    await reply.code(502).send({
      error: {
        code: 'CLUSTER_CA_UNAVAILABLE',
        message: `Cannot forward to node '${opts.node}': the cluster CA (peer TLS trust anchor) is unavailable, so the request is refused rather than sent over the public trust store.`,
      },
    })
    return
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  // Forward the credential and confirmation/content headers verbatim.
  for (const name of ['cookie', 'content-type', 'x-anas-confirm'] as const) {
    const value = request.headers[name]
    if (typeof value === 'string')
      headers[name] = value
  }

  const body = request.body instanceof Buffer && request.body.length > 0
    ? request.body
    : undefined
  if (body)
    headers['content-length'] = String(body.length)

  try {
    const result = await new Promise<UpstreamResult>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: opts.node,
          port: opts.port,
          method: request.method,
          path: request.url,
          headers,
          agent: new HttpsAgent({ ca }),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({
            status: res.statusCode ?? 502,
            headers: res.headers as UpstreamResult['headers'],
            body: Buffer.concat(chunks),
          }))
        },
      )
      req.on('error', reject)
      if (body)
        req.write(body)
      req.end()
    })

    relayHeaders(reply, result.headers)
    await reply.code(result.status).send(result.body)
  }
  catch (err) {
    await reply.code(502).send({
      error: {
        code: 'NODE_UNREACHABLE',
        message: `Node '${opts.node}' is unreachable: ${(err as Error).message}`,
      },
    })
  }
}
