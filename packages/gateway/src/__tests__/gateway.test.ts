import type { Server } from 'node:http'
import type { AddressInfo, Server as NetServer } from 'node:net'
import type { AuthProvider, AuthUser } from '../auth/index.js'
import type { GatewayConfig } from '../config.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { VERSION } from '@anas/shared'
import { classifyUpstreamResponse, resolveNodeAddress } from '../proxy.js'
import { createServer } from '../server.js'

const NODE = 'testnode'

// PVE peers are resolved via cluster membership (/etc/pve/.members), NOT DNS.
// A shared test members file maps the peer node names used below to loopback.
const membersDir = mkdtempSync(join(tmpdir(), 'anas-members-'))
const MEMBERS_PATH = join(membersDir, '.members')
writeFileSync(MEMBERS_PATH, JSON.stringify({
  nodelist: {
    '127.0.0.1': { id: 2, online: 1, ip: '127.0.0.1' },
    'peer1': { id: 3, online: 1, ip: '127.0.0.1' },
    // A "member" that resolves to a reserved, non-routable address (TEST-NET-1):
    // the TCP connect can never complete — the firewalled/black-holed peer.
    'blackhole': { id: 4, online: 1, ip: '192.0.2.1' },
  },
}))

/** Auth provider that accepts everything (like dev, but with a distinct name so the cookie path runs). */
class AcceptAuthProvider implements AuthProvider {
  readonly name = 'accept'
  async validateToken(): Promise<AuthUser | null> {
    return { name: 'alice@pve', uid: 4242 }
  }
}

/** Auth provider that rejects everything → 401. */
class RejectAuthProvider implements AuthProvider {
  readonly name = 'reject'
  async validateToken(): Promise<AuthUser | null> {
    return null
  }
}

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    pvePort: 8006,
    nodeName: NODE,
    anasdSocket: '/run/anas/anasd.sock',
    authProvider: undefined,
    clusterCa: '/etc/pve/pve-root-ca.pem',
    membersPath: MEMBERS_PATH,
    ...overrides,
  }
}

describe('auth hook', () => {
  it('rejects requests without a valid cookie with a 401 ApiError', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new RejectAuthProvider(),
      logger: false,
    })
    const res = await server.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
    await server.close()
  })

  it('accepts a request when the provider validates the cookie', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: 'PVEAuthCookie=whatever' },
    })
    assert.equal(res.statusCode, 200)
    await server.close()
  })
})

describe('no CORS (same-origin via :8006/anas)', () => {
  it('emits no access-control-* headers even when an Origin is present', async () => {
    // Requests now arrive same-origin through pveproxy; the CORS machinery is
    // gone. A response must carry none of the allow/expose headers.
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        host: 'pve1.example.com:8006',
        origin: 'https://pve1.example.com:8006',
        cookie: 'PVEAuthCookie=x',
      },
    })
    assert.equal(res.statusCode, 200)
    for (const h of Object.keys(res.headers)) {
      assert.ok(!h.startsWith('access-control-'), `unexpected CORS header ${h}`)
    }
    // The version header still ships (same-origin needs no expose-header).
    assert.equal(res.headers['x-anas-version'], VERSION)
    await server.close()
  })
})

describe('node param validation', () => {
  it('rejects a node name with illegal characters (400)', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/bad_node!/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    await server.close()
  })
})

describe('local proxy → anasd socket', () => {
  const socketPath = join(tmpdir(), `anasd-stub-${process.pid}.sock`)
  let stub: Server
  let received: { headers: Record<string, string | string[] | undefined>, url?: string, method?: string }

  before(async () => {
    stub = createHttpServer((req, res) => {
      received = { headers: req.headers, url: req.url, method: req.method }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-anas-confirm-code': 'CONF-123',
      })
      res.end(JSON.stringify({ data: [{ name: 'tank' }] }))
    })
    await new Promise<void>(resolve => stub.listen(socketPath, resolve))
  })

  after(async () => {
    await new Promise<void>(resolve => stub.close(() => resolve()))
  })

  it('forwards to the socket with identity headers and passes through status/body/confirm', async () => {
    const server = createServer({
      config: baseConfig({ anasdSocket: socketPath }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/testnode/v1/pools?verbose=1',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { data: [{ name: 'tank' }] })
    // Confirmation header passed straight through.
    assert.equal(res.headers['x-anas-confirm-code'], 'CONF-123')
    // Proxied responses carry the gateway's own version header (12.1).
    assert.equal(res.headers['x-anas-version'], VERSION)
    // Prefix stripped, query preserved.
    assert.equal(received.url, '/v1/pools?verbose=1')
    // Identity headers attached.
    assert.equal(received.headers['x-anas-user'], 'alice@pve')
    assert.equal(received.headers['x-anas-user-uid'], '4242')
    assert.ok(received.headers['x-anas-request-id'])

    await server.close()
  })

  it('preserves a URL-encoded path segment (%2F) so daemon :path routes match', async () => {
    // NFS exports are keyed by their URL-encoded mountpoint (/shares/nfs/:path).
    // The gateway must forward the encoding intact — Fastify decodes the wildcard
    // param, so building the upstream path from it would corrupt %2F into '/'.
    const server = createServer({
      config: baseConfig({ anasdSocket: socketPath }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/nodes/testnode/v1/shares/nfs/%2Ftestpool%2Fshare1',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(received.url, '/v1/shares/nfs/%2Ftestpool%2Fshare1')

    await server.close()
  })
})

describe('remote node forwarding', () => {
  // Each test uses a UNIQUE cluster-CA path so the module-level (path-keyed)
  // CA cache never leaks a value between them.
  let caDir: string

  before(() => {
    caDir = mkdtempSync(join(tmpdir(), 'anas-clusterca-'))
  })

  after(() => {
    rmSync(caDir, { recursive: true, force: true })
  })

  it('returns 502 NODE_UNRESOLVED for a node not in cluster membership', async () => {
    // A readable CA lets the request past the fail-closed gate so it reaches the
    // resolution step — a node absent from /etc/pve/.members can't be addressed.
    const caPath = join(caDir, 'present.pem')
    writeFileSync(caPath, 'test-ca-bytes')
    const server = createServer({
      config: baseConfig({ clusterCa: caPath }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/notamember/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(res.statusCode, 502)
    const body = res.json()
    assert.equal(body.error.code, 'NODE_UNRESOLVED')
    assert.match(body.error.message, /notamember/)
    await server.close()
  })

  it('returns 502 NODE_UNREACHABLE when a member node resolves but the peer is down', async () => {
    const caPath = join(caDir, 'present2.pem')
    writeFileSync(caPath, 'test-ca-bytes')
    // node 127.0.0.1 is in membership → resolves to 127.0.0.1; port 9 (discard)
    // refuses → the forward attempt errors → NODE_UNREACHABLE.
    const server = createServer({
      config: baseConfig({ clusterCa: caPath, pvePort: 9 }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/127.0.0.1/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(res.statusCode, 502)
    assert.equal(res.json().error.code, 'NODE_UNREACHABLE')
    await server.close()
  })

  it('fails CLOSED with 502 CLUSTER_CA_UNAVAILABLE and does NOT forward when the CA is unreadable', async () => {
    // A TCP stub stands in for the peer gateway and counts connection attempts:
    // if the gateway wrongly fell back to the public trust store it would try to
    // connect (and forward the cookie); we assert it never does.
    let connections = 0
    const peer: NetServer = createTcpServer((sock) => {
      connections += 1
      sock.destroy()
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      config: baseConfig({
        // Nonexistent CA path → unreadable.
        clusterCa: join(caDir, 'missing.pem'),
        // Point the "peer" at our local stub so any forward attempt is observable.
        pvePort: peerPort,
      }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/127.0.0.1/v1/pools',
      headers: { cookie: 'PVEAuthCookie=secret-ticket' },
    })

    assert.equal(res.statusCode, 502)
    assert.equal(res.json().error.code, 'CLUSTER_CA_UNAVAILABLE')
    // The load-bearing assertion: no forward was attempted at all.
    assert.equal(connections, 0, 'the cookie must NOT be sent to any upstream when the CA is unavailable')

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })

  it('self-heals: a CA that is missing then present is picked up (no sticky-undefined cache)', async () => {
    const caPath = join(caDir, 'appears.pem')
    const config = baseConfig({ clusterCa: caPath, pvePort: 9 })

    // First request: CA absent → fail closed.
    const s1 = createServer({ config, authProvider: new AcceptAuthProvider(), logger: false })
    const r1 = await s1.inject({
      method: 'GET',
      url: '/api/nodes/127.0.0.1/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(r1.json().error.code, 'CLUSTER_CA_UNAVAILABLE')
    await s1.close()

    // The CA appears (pmxcfs mounts /etc/pve).
    writeFileSync(caPath, 'test-ca-bytes')

    // Second request: the failed read was NOT cached, so it re-reads, gets past
    // the gate, and now fails only because port 9 is unreachable → NODE_UNREACHABLE.
    const s2 = createServer({ config, authProvider: new AcceptAuthProvider(), logger: false })
    const r2 = await s2.inject({
      method: 'GET',
      url: '/api/nodes/127.0.0.1/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(r2.json().error.code, 'NODE_UNREACHABLE')
    await s2.close()
  })
})

describe('resolveNodeAddress — cluster membership, not DNS', () => {
  it('maps a node name to its IP from /etc/pve/.members', () => {
    assert.equal(resolveNodeAddress('peer1', MEMBERS_PATH), '127.0.0.1')
    assert.equal(resolveNodeAddress('127.0.0.1', MEMBERS_PATH), '127.0.0.1')
  })
  it('returns undefined for a node not in membership', () => {
    assert.equal(resolveNodeAddress('notamember', MEMBERS_PATH), undefined)
  })
  it('returns undefined when the members file is unreadable', () => {
    assert.equal(resolveNodeAddress('peer1', '/no/such/.members'), undefined)
  })
})

describe('health endpoint', () => {
  it('returns { data: { node, version } }', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { data: { node: NODE, version: VERSION } })
    // Version-skew visibility (12.1): every response names the gateway version.
    assert.equal(res.headers['x-anas-version'], VERSION)
    await server.close()
  })
})

describe('unauthenticated /installed probe', () => {
  it('returns 200 { name, version } with NO cookie (auth exempt)', async () => {
    // Panels hit /anas/installed pre-login to detect ANAS presence; a 401 would
    // defeat the probe. The reject provider proves auth is genuinely bypassed.
    const server = createServer({
      config: baseConfig(),
      authProvider: new RejectAuthProvider(),
      logger: false,
    })
    const res = await server.inject({ method: 'GET', url: '/installed' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { name: 'anas', version: VERSION })
    // Still stamped with the gateway version (skew visibility).
    assert.equal(res.headers['x-anas-version'], VERSION)
    await server.close()
  })

  it('authenticated routes still 401 without a cookie (probe is the only exemption)', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new RejectAuthProvider(),
      logger: false,
    })
    const res = await server.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
    await server.close()
  })
})

describe('upstream classifier (ANAS_NOT_INSTALLED vs ANAS response)', () => {
  const jsonHeaders = { 'content-type': 'application/json' }

  it('classifies pveproxy no-such-path (404, non-JSON) as not-installed', () => {
    const result = {
      status: 404,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html><body>404 Not Found</body></html>'),
    }
    assert.equal(classifyUpstreamResponse(result), 'not-installed')
  })

  it('classifies pveproxy 501 Not Implemented as not-installed', () => {
    const result = {
      status: 501,
      headers: {},
      body: Buffer.from('Method \'GET /anas/...\' not implemented'),
    }
    assert.equal(classifyUpstreamResponse(result), 'not-installed')
  })

  it('classifies PVE 9 pveproxy 500 "no such file" fallthrough as not-installed', () => {
    // PVE 9's pveproxy answers an unmatched path (hook absent) with a plain-text
    // 500 `no such file '<path>'`, NOT 404/501 — proven on the stunt node.
    const result = {
      status: 500,
      headers: {},
      body: Buffer.from('no such file \'/anas/installed\''),
    }
    assert.equal(classifyUpstreamResponse(result), 'not-installed')
  })

  it('does NOT mask a non-fallthrough 500 (broken hook / gateway error) as not-installed', () => {
    // The hook-present-but-module-throws case: pveproxy 500 'ANAS proxy error'.
    // ANAS IS installed (just degraded) — must pass through, not read as missing.
    assert.equal(
      classifyUpstreamResponse({ status: 500, headers: {}, body: Buffer.from('ANAS proxy error') }),
      'anas',
    )
    // A genuine ANAS 500 with the JSON error envelope is a real response too.
    assert.equal(
      classifyUpstreamResponse({
        status: 500,
        headers: jsonHeaders,
        body: Buffer.from(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } })),
      }),
      'anas',
    )
  })

  it('classifies a genuine ANAS 404 error envelope as an ANAS response', () => {
    const result = {
      status: 404,
      headers: jsonHeaders,
      body: Buffer.from(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such pool' } })),
    }
    assert.equal(classifyUpstreamResponse(result), 'anas')
  })

  it('treats a non-fallthrough status as an ANAS response', () => {
    // 500 stays 'anas' here because the body is not pveproxy's no-such-file text.
    for (const status of [200, 202, 400, 409, 500]) {
      assert.equal(
        classifyUpstreamResponse({ status, headers: jsonHeaders, body: Buffer.from('{}') }),
        'anas',
      )
    }
  })
})

describe('cross-node forwarding over :8006/anas (real TLS, cluster CA)', () => {
  // A self-signed cert for the peer node NAME (peer1) doubles as the cluster CA:
  // the gateway resolves peer1→127.0.0.1 via membership, connects to the IP but
  // verifies with servername=peer1 against the cert's DNS SAN — mirroring how a
  // real PVE node cert carries the node name in its SAN.
  let tlsDir: string
  let certPath: string
  let cert: Buffer
  let key: Buffer

  before(() => {
    tlsDir = mkdtempSync(join(tmpdir(), 'anas-peer-tls-'))
    certPath = join(tlsDir, 'cert.pem')
    const keyPath = join(tlsDir, 'key.pem')
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=peer1',
      '-addext',
      'subjectAltName=DNS:peer1',
    ])
    cert = readFileSync(certPath)
    key = readFileSync(keyPath)
  })

  after(() => {
    rmSync(tlsDir, { recursive: true, force: true })
  })

  it('re-adds the /anas prefix and hits the peer over the cluster CA', async () => {
    let received: string | undefined
    let receivedHeaders: Record<string, string | string[] | undefined> = {}
    const peer = createHttpsServer({ cert, key }, (req, res) => {
      received = req.url
      receivedHeaders = req.headers
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ name: 'remotepool' }] }))
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      config: baseConfig({ clusterCa: certPath, pvePort: peerPort }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    // node = 127.0.0.1 (a peer, not this node) → forwarded, not local.
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/peer1/v1/pools?verbose=1',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { data: [{ name: 'remotepool' }] })
    // Round-trip: the local pveproxy stripped /anas; the gateway forwards to the
    // peer with /anas re-added so the peer's pveproxy can route it.
    assert.equal(received, '/anas/api/nodes/peer1/v1/pools?verbose=1')
    // The hop is marked: the peer serves it locally, but any gateway asked to
    // forward it a SECOND time refuses (FORWARD_LOOP) instead of looping.
    assert.equal(receivedHeaders['x-anas-forwarded'], '1')

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })

  it('returns 502 ANAS_NOT_INSTALLED when the peer :8006 answers no-such-path', async () => {
    const peer = createHttpsServer({ cert, key }, (req, res) => {
      // pveproxy's fallback when /anas is not hooked (ANAS absent on the node).
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><body>404 Not Found</body></html>')
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      config: baseConfig({ clusterCa: certPath, pvePort: peerPort }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/peer1/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 502)
    const body = res.json()
    assert.equal(body.error.code, 'ANAS_NOT_INSTALLED')
    assert.match(body.error.message, /peer1/)

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })

  it('passes a genuine ANAS error envelope through untouched (not mislabeled)', async () => {
    const peer = createHttpsServer({ cert, key }, (req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such pool' } }))
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      config: baseConfig({ clusterCa: certPath, pvePort: peerPort }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/peer1/v1/pools/nope',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    // A real ANAS 404 is relayed verbatim, NOT turned into ANAS_NOT_INSTALLED.
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })

  it('a peer that CONNECTS but never answers yields 504 GATEWAY_TIMEOUT — "timed out", not "unreachable"', async () => {
    // The peer terminates TLS and accepts the request, then stays silent: the
    // forward's socket is open, so this is a SLOW/HUNG operation on a reachable
    // node — NOT a connection failure. It must read that way, or the operator
    // chases a dead node that is fine. A short forwardTimeoutMs keeps the test
    // off the real 15 s wait; the PATH is what is under test.
    const peer = createHttpsServer({ cert, key }, (_req, _res) => {
      // Deliberately no response: hold the connection open and answer nothing.
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      config: baseConfig({ clusterCa: certPath, pvePort: peerPort, forwardTimeoutMs: 250 }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/peer1/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 504)
    const body = res.json()
    assert.equal(body.error.code, 'GATEWAY_TIMEOUT')
    // The wording says timed-out and names the reachable node; it must NOT read
    // as a dead node.
    assert.match(body.error.message, /timed out/i)
    assert.match(body.error.message, /reachable/i)
    assert.ok(!/unreachable/i.test(body.error.message), body.error.message)

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })

  it('a peer that never even CONNECTS stays 502 NODE_UNREACHABLE — a connect timeout is not "reachable"', async () => {
    // The firewalled/black-holed peer: the SYN is dropped, so the forward's
    // timeout fires while the connection is STILL PENDING. The 504 wording
    // ("the node is reachable") would be a lie here — no connection was ever
    // made — so this keeps the 502. 192.0.2.1 (TEST-NET-1) is reserved and
    // non-routable: the connect simply hangs until the (short) forward timeout.
    const server = createServer({
      config: baseConfig({ clusterCa: certPath, pvePort: 8006, forwardTimeoutMs: 300 }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/blackhole/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 502)
    const body = res.json()
    assert.equal(body.error.code, 'NODE_UNREACHABLE')
    assert.match(body.error.message, /unreachable/i)

    await server.close()
  })
})

describe('loop-safety: own node is served locally, never forwarded out', () => {
  const socketPath = join(tmpdir(), `anasd-loop-${process.pid}.sock`)
  let stub: Server
  let received: string | undefined

  before(async () => {
    stub = createHttpServer((req, res) => {
      received = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: 'local' }))
    })
    await new Promise<void>(resolve => stub.listen(socketPath, resolve))
  })

  after(async () => {
    await new Promise<void>(resolve => stub.close(() => resolve()))
  })

  it('a request for this node hits the local socket and opens no outbound :8006 hop', async () => {
    // A TCP counter stands in for the peer front door. If the gateway ever
    // forwarded its OWN node back out through :8006, this counter would tick.
    let outbound = 0
    const peer: NetServer = createTcpServer((sock) => {
      outbound += 1
      sock.destroy()
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      // nodeName === the requested node → must be served locally.
      config: baseConfig({ nodeName: NODE, anasdSocket: socketPath, pvePort: peerPort }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: `/api/nodes/${NODE}/v1/pools`,
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(received, '/v1/pools', 'served over the local anasd socket')
    assert.equal(outbound, 0, 'the own node must never be forwarded out through :8006')

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })
})
