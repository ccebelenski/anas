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

/**
 * The gateway's rungs of the timeout ladder (cr.35, WAVE3-DESIGN §6.2), set so
 * the innermost layer that knows the reason answers first:
 *
 *   one command on the request path   10 s  (anasd's executor, its own 503 TIMEOUT)
 *   gateway → local anasd socket      20 s  → 504 GATEWAY_TIMEOUT, request aborted
 *   gateway → peer node              5 s to connect, then 25 s for the answer
 *                                           (the peer's own 20 s socket answer
 *                                           arrives before ours fires)
 *   AnasProxy inside pveproxy         30 s inactivity → a synthetic 502
 *
 * Before cr.35 the local hop had no timeout at all (a hung daemon read held
 * the gateway request open after pveproxy had already given the browser its
 * 502), and the forward ran connect and response on one 15 s timer.
 */
export const LOCAL_SOCKET_TIMEOUT_MS = 20_000
export const FORWARD_CONNECT_TIMEOUT_MS = 5_000
export const FORWARD_RESPONSE_TIMEOUT_MS = 25_000

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

/** `20 s`, or `250 ms` for a test's short budget. */
function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/** Copy a header from the upstream response onto the client reply, if present. */
function relayHeaders(reply: FastifyReply, headers: UpstreamResult['headers']): void {
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = headers[name]
    if (value !== undefined)
      reply.header(name, value)
  }
}

/** The header carrying the privileges PVE granted on `/` to the daemon. */
export const PRIVILEGES_HEADER = 'x-anas-privileges'

/**
 * The Content-Type the local hop sends anasd (cr.27, the cr.26 note). The
 * daemon's rule (cr.26, WAVE2-DESIGN §3) is: a mutation whose Content-Type is
 * present and not application/json is a 415, with or without a body. Before
 * cr.27 the gateway sent the type only along with a body, so a body-less POST
 * typed `text/plain` lost its header here and passed through `/anas` while the
 * same request on the socket was refused. Now:
 *   - with a body: the client's type, or application/json when it sent none
 *     (as before);
 *   - without a body: any type that is not application/json is forwarded, so
 *     the daemon answers its own 415 exactly as on the socket; a body-less
 *     application/json is still dropped (Fastify would refuse an empty JSON
 *     body with its own 400, and a body-less JSON-typed POST passed before).
 */
export function forwardedContentType(header: string | string[] | undefined, hasBody: boolean): string | undefined {
  const value = Array.isArray(header) ? header.join(', ') : header
  if (hasBody)
    return value ?? 'application/json'
  if (value === undefined)
    return undefined
  return value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json' ? undefined : value
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
  opts: { socketPath: string, anasdPath: string, user: AuthUser | undefined, timeoutMs?: number },
): Promise<void> {
  // Overridable for tests; production always runs at LOCAL_SOCKET_TIMEOUT_MS.
  const timeoutMs = opts.timeoutMs ?? LOCAL_SOCKET_TIMEOUT_MS
  const headers: Record<string, string> = {
    'accept': 'application/json',
    'x-anas-request-id': randomUUID(),
  }

  if (opts.user) {
    // The full PVE user id, realm included (cr.27: `alice@pve` is not the
    // local `alice`); the uid only for a `@pam` user, -1 otherwise.
    headers['x-anas-user'] = opts.user.name
    headers['x-anas-user-uid'] = String(opts.user.uid)
    // What PVE granted on `/`, as pveproxy signed it (WAVE2-DESIGN A3.1: the
    // daemon's job-queue backstop, cr.28, reads it; an absent header means a
    // root socket client).
    headers[PRIVILEGES_HEADER] = opts.user.privileges.join(',')
  }

  // Forward the confirmation code for dangerous operations, if the client sent one.
  const confirm = request.headers['x-anas-confirm']
  if (typeof confirm === 'string')
    headers['x-anas-confirm'] = confirm

  const body = request.body instanceof Buffer && request.body.length > 0
    ? request.body
    : undefined
  const contentType = forwardedContentType(request.headers['content-type'], body !== undefined)
  if (contentType !== undefined)
    headers['content-type'] = contentType
  if (body)
    headers['content-length'] = String(body.length)

  try {
    const result = await new Promise<UpstreamResult>((resolve, reject) => {
      // The whole answer must arrive within the budget (cr.35): anasd sends
      // nothing until its handler is done, so this is the time its reads took.
      // On expiry the upstream request is ABORTED (the daemon sees the socket
      // close; its commands still end at their own deadlines) and the browser
      // gets the ANAS envelope, not pveproxy's synthetic 502 ten seconds later.
      let timer: NodeJS.Timeout | undefined
      const req = httpRequest(
        { socketPath: opts.socketPath, method: request.method, path: opts.anasdPath, headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            clearTimeout(timer)
            resolve({
              status: res.statusCode ?? 502,
              headers: res.headers as UpstreamResult['headers'],
              body: Buffer.concat(chunks),
            })
          })
          res.on('error', (err) => {
            clearTimeout(timer)
            reject(err)
          })
        },
      )
      timer = setTimeout(() => {
        const err = new Error(`anasd did not answer within ${timeoutMs} ms`) as NodeJS.ErrnoException
        err.code = 'ANAS_SOCKET_TIMEOUT'
        req.destroy(err)
      }, timeoutMs)
      req.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      if (body)
        req.write(body)
      req.end()
    })

    relayHeaders(reply, result.headers)
    await reply.code(result.status).send(result.body)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ANAS_SOCKET_TIMEOUT') {
      request.log.warn(`[gateway] anasd did not answer ${request.method} ${opts.anasdPath} within ${timeoutMs} ms — request aborted`)
      await reply.code(504).send({
        error: {
          code: 'GATEWAY_TIMEOUT',
          message: `anasd did not answer within ${formatSeconds(timeoutMs)}: the request was stopped at the gateway. `
            + 'A command it ran may be hung (a suspended pool, a dead mount or an unresponsive remote host); '
            + 'the dashboard lists commands that did not end. If this was a change, check its state before retrying.',
        },
      })
      return
    }
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
 * against the replicated cluster authkey exactly as for a direct request, and
 * PVE's `CSRFPreventionToken` header with it when the browser sent one. The
 * TLS hop is verified against the cluster CA (fail-closed if it is unreadable).
 * Connection failure → 502 NODE_UNREACHABLE — including a connect that never
 * COMPLETES (a firewalled/black-holed peer whose SYN is dropped): Node's
 * request `timeout` also fires while the connect is still pending, and there
 * "the node is reachable" would itself be the lie, so that timeout stays a
 * plain error and takes the 502 path. A peer that CONNECTED (TCP+TLS) but does
 * not answer within the forward timeout → 504 GATEWAY_TIMEOUT — a distinct
 * wording, because "unreachable" for a request that was slow or hung is a lie:
 * the node was reachable, the operation was not (a pre-fix boundary scan of a
 * remote-rooted source took exactly this path and read as a dead node). A peer
 * whose `:8006` answers but lacks the `/anas` hook (ANAS not installed) →
 * 502 ANAS_NOT_INSTALLED.
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
  opts: { node: string, pvePort: number, clusterCa: string, membersPath: string, connectTimeoutMs?: number, responseTimeoutMs?: number },
): Promise<void> {
  // Overridable for tests (the real budgets are 5 s and 25 s waits);
  // production always runs at FORWARD_CONNECT_TIMEOUT_MS / FORWARD_RESPONSE_TIMEOUT_MS.
  const connectTimeoutMs = opts.connectTimeoutMs ?? FORWARD_CONNECT_TIMEOUT_MS
  const responseTimeoutMs = opts.responseTimeoutMs ?? FORWARD_RESPONSE_TIMEOUT_MS
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
  // Forward the credential and confirmation/content headers verbatim. The CSRF
  // token rides with the cookie (cr.25a, docs/WAVE2-DESIGN.md §3) so that, once
  // cr.27 enforces it, the peer's pveproxy can check it for the node that does
  // the work; until then nothing checks it. Absent → not sent, and the forward
  // goes out as before.
  for (const name of ['cookie', 'csrfpreventiontoken', 'content-type', 'x-anas-confirm'] as const) {
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
      // Started at the TLS handshake (below); declared here for the response handler.
      let responseTimer: NodeJS.Timeout | undefined
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
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            clearTimeout(responseTimer)
            resolve({
              status: res.statusCode ?? 502,
              headers: res.headers as UpstreamResult['headers'],
              body: Buffer.concat(chunks),
            })
          })
        },
      )
      // Two timers, two meanings (cr.35). The CONNECT budget covers TCP and
      // TLS: a down-but-not-refused peer (firewall drop, partition) never
      // answers the SYN, and "the node is reachable" may only be claimed once a
      // connection was made — so its expiry is a plain error, NODE_UNREACHABLE.
      // The RESPONSE budget starts when the TLS session is up: a peer that
      // CONNECTED and then never answered is reachable; the operation is what
      // is slow or hung (GATEWAY_TIMEOUT). It is longer than the peer's own
      // 20 s socket budget, so a peer whose anasd hangs answers its own 504
      // (naming itself) before this one fires.
      const connectTimer = setTimeout(() => {
        req.destroy(new Error(`connection attempt to ${opts.node} timed out after ${connectTimeoutMs}ms`))
      }, connectTimeoutMs)
      req.on('socket', (s) => {
        s.once('secureConnect', () => {
          clearTimeout(connectTimer)
          responseTimer = setTimeout(() => {
            const err = new Error(`connection to ${opts.node} timed out after ${responseTimeoutMs}ms`) as NodeJS.ErrnoException
            err.code = 'ANAS_FORWARD_TIMEOUT'
            req.destroy(err)
          }, responseTimeoutMs)
        })
      })
      req.on('error', (err) => {
        clearTimeout(connectTimer)
        clearTimeout(responseTimer)
        reject(err)
      })
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
    // The forward TIMED OUT on a connection that HAD BEEN ESTABLISHED (the
    // marker is only stamped when the socket connected): the peer is reachable
    // — the operation is what did not answer in time. A distinct 504 and
    // wording, because the 502 "unreachable" below is a lie for this. A timeout
    // that happened BEFORE any connect (a black-holed peer) has no marker and
    // lands on the 502 below, where it belongs.
    if ((err as NodeJS.ErrnoException)?.code === 'ANAS_FORWARD_TIMEOUT') {
      await reply.code(504).send({
        error: {
          code: 'GATEWAY_TIMEOUT',
          message: `Node '${opts.node}' did not answer within ${formatSeconds(responseTimeoutMs)}: the request timed out. The node is reachable; that operation is slow or hung.`,
        },
      })
      return
    }
    await reply.code(502).send({
      error: {
        code: 'NODE_UNREACHABLE',
        message: `Node '${opts.node}' is unreachable: ${(err as Error).message}`,
      },
    })
  }
}
