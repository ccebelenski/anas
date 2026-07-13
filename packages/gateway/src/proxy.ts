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

let cachedCa: string | Buffer | undefined
let caChecked = false

/** Read the cluster CA once. Missing file → undefined (logged), TLS falls back to defaults. */
function loadClusterCa(request: FastifyRequest, caPath: string): string | Buffer | undefined {
  if (caChecked)
    return cachedCa
  caChecked = true
  try {
    cachedCa = readFileSync(caPath)
  }
  catch {
    request.log.warn(`[gateway] Cluster CA ${caPath} unreadable — peer TLS uses default trust store`)
    cachedCa = undefined
  }
  return cachedCa
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
