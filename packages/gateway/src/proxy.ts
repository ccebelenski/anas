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

/**
 * The base prefix every ANAS request carries through PVE's `:8006` front door.
 * The browser hits `/anas/...`; the local pveproxy strips it before the gateway
 * sees the request, so when we forward cross-node we must re-add it for the peer
 * pveproxy to route the request to that node's gateway.
 */
const ANAS_PROXY_PREFIX = '/anas'

/**
 * Marker stamped on every cross-node forward. A peer legitimately receives it
 * and serves the request locally; a gateway that would forward a request
 * ALREADY carrying it refuses instead (FORWARD_LOOP) — see server.ts.
 */
export const FORWARDED_HEADER = 'x-anas-forwarded'

/** Cross-node forward timeout — a hung peer must not hang the browser request. */
const FORWARD_TIMEOUT_MS = 15000

/** pveproxy's file-fallthrough 500 body prefix (a node without ANAS installed). */
const NO_SUCH_FILE_RE = /^no such file\b/

/**
 * Classify a cross-node upstream response so we can tell an actual ANAS reply
 * apart from pveproxy's own "no such path" answer — which is what a peer's
 * `:8006` returns when ANAS is NOT installed there (the `/anas` hook is absent,
 * so pveproxy falls through to its 404/501 fallback rather than reaching a
 * gateway). A genuine ANAS response — even a 404 for a missing resource — always
 * carries the ANAS JSON error envelope (`{ error: { code, message } }`);
 * pveproxy's fallback does not.
 *
 * `'anas'`          → relay the response through verbatim.
 * `'not-installed'` → surface a clean ANAS_NOT_INSTALLED for the node.
 */
export function classifyUpstreamResponse(result: UpstreamResult): 'anas' | 'not-installed' {
  // pveproxy's own "no such path" answer — what a peer's :8006 returns when the
  // /anas hook is absent (ANAS not installed there) — surfaces differently
  // across PVE releases: 404 Not Found, 501 Not Implemented, or (PVE 9, proven
  // on the stunt node) a 500 whose plain-text body is `no such file '<path>'`
  // (pveproxy's file fallthrough, NOT a gateway error). Any other status is
  // unambiguously a real ANAS response.
  const { status } = result
  if (status !== 404 && status !== 501 && status !== 500)
    return 'anas'

  // A genuine ANAS response — even a 404/500 — always carries the ANAS JSON
  // error envelope ({ error: { code } }); pveproxy's fallback is plain text.
  const ct = result.headers['content-type']
  const contentType = Array.isArray(ct) ? ct[0] : ct
  const bodyText = result.body.toString('utf8')
  if (contentType && contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } }
      if (parsed && typeof parsed.error?.code === 'string')
        return 'anas'
    }
    catch {
      // Not JSON → not an ANAS envelope → treat as pveproxy fallback below.
    }
  }

  // A 500 is a not-installed signal ONLY when it is pveproxy's own no-such-file
  // fallthrough (the PVE 9 shape). Any OTHER 500 — the hook's own 'ANAS proxy
  // error', or a real gateway error — is a genuine (if degraded) response and
  // must pass through, never be masked as "not installed".
  if (status === 500 && !NO_SUCH_FILE_RE.test(bodyText))
    return 'anas'

  return 'not-installed'
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
 * already `/v1/...` with query) and attaches the X-Anas-* identity headers.
 * Passes through status, body, and the X-Anas-Confirm-* headers.
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
 * Forward the whole request to a peer node — through that node's PVE front door
 * at `https://<node>:8006/anas/...`, the single ANAS surface for browser AND
 * inter-node traffic (there is no `:3000` public origin anymore).
 *
 * The gateway saw this request as `/api/nodes/<node>/v1/...` (the local pveproxy
 * already stripped the `/anas` prefix), so we re-add `/anas` for the peer's
 * pveproxy to route it to that node's loopback gateway. Round-trip:
 *   browser  /anas/api/nodes/B/v1/x
 *   → nodeA pveproxy strips → nodeA gateway sees /api/nodes/B/v1/x
 *   → forward https://B:8006/anas/api/nodes/B/v1/x
 *   → nodeB pveproxy strips → nodeB gateway sees /api/nodes/B/v1/x → served locally.
 *
 * The user's PVEAuthCookie rides along so the remote gateway verifies the ticket
 * against the replicated cluster authkey exactly as for a direct request. The
 * TLS hop is verified against the cluster CA (fail-closed if it is unreadable).
 * Connection failure → 502 NODE_UNREACHABLE. A peer whose `:8006` answers but
 * lacks the `/anas` hook (ANAS not installed) → 502 ANAS_NOT_INSTALLED.
 */
/**
 * Resolve a cluster node name to its IP via PVE's membership file
 * (`/etc/pve/.members`). PVE peers are NOT DNS names — PVE routes cross-node
 * traffic by the cluster's own known addresses (corosync/pmxcfs), so we do the
 * same rather than assuming `<node>` resolves via DNS/hosts (it usually does
 * not). Re-read fresh each forward — membership (online state, IPs) changes.
 * Returns the IP, or undefined if the node isn't in the membership or the file
 * is unreadable.
 */
export function resolveNodeAddress(node: string, membersPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(membersPath, 'utf8')) as {
      nodelist?: Record<string, { ip?: unknown }>
    }
    const ip = parsed.nodelist?.[node]?.ip
    return typeof ip === 'string' && ip.length > 0 ? ip : undefined
  }
  catch {
    return undefined
  }
}

export async function forwardToNode(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { node: string, pvePort: number, clusterCa: string, membersPath: string },
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

  // Resolve the peer's IP from PVE cluster membership — node names are not DNS
  // names, so connecting to `<node>` directly fails to resolve (NODE_UNREACHABLE).
  const address = resolveNodeAddress(opts.node, opts.membersPath)
  if (address === undefined) {
    await reply.code(502).send({
      error: {
        code: 'NODE_UNRESOLVED',
        message: `Node '${opts.node}' is not in the PVE cluster membership (${opts.membersPath}); its address cannot be resolved. Is it a cluster member and online?`,
      },
    })
    return
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    // Mark the hop: the peer serves it locally, but a gateway asked to forward
    // an already-forwarded request refuses (FORWARD_LOOP) rather than loop.
    [FORWARDED_HEADER]: '1',
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
          host: address,
          // TLS SNI + cert-identity check uses the node NAME (PVE certs carry it
          // in the SAN), while we connect to the resolved IP. Verified against
          // the cluster CA below.
          servername: opts.node,
          port: opts.pvePort,
          method: request.method,
          // Re-add the `/anas` prefix the local pveproxy stripped, so the peer's
          // pveproxy routes this to that node's gateway.
          path: `${ANAS_PROXY_PREFIX}${request.url}`,
          headers,
          agent: new HttpsAgent({ ca }),
          // A down-but-not-refused peer (firewall drop, partition) must not hang
          // the browser request — time out and surface NODE_UNREACHABLE instead.
          timeout: FORWARD_TIMEOUT_MS,
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
      req.on('timeout', () => req.destroy(new Error(`connection to ${opts.node} timed out after ${FORWARD_TIMEOUT_MS}ms`)))
      if (body)
        req.write(body)
      req.end()
    })

    // The peer's :8006 is always up (it's PVE), so a "no such path" reply means
    // ANAS is not installed on that node — surface a clean, distinguishable
    // signal instead of relaying pveproxy's raw 404/501.
    if (classifyUpstreamResponse(result) === 'not-installed') {
      await reply.code(502).send({
        error: {
          code: 'ANAS_NOT_INSTALLED',
          message: `ANAS is not installed on node '${opts.node}' (its Proxmox front door answered, but the /anas endpoint is not present).`,
        },
      })
      return
    }

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
