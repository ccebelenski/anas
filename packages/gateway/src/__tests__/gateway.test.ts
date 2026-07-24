import type { Server } from 'node:http'
import type { AddressInfo, Server as NetServer } from 'node:net'
import type { AuthProvider, AuthUser } from '../auth/index.js'
import type { GatewayConfig } from '../config.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { VERSION } from '@anas/shared'
import { createServer } from '../server.js'

const NODE = 'testnode'

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
    port: 3000,
    nodeName: NODE,
    anasdSocket: '/run/anas/anasd.sock',
    authProvider: undefined,
    tlsCert: undefined,
    tlsKey: undefined,
    clusterCa: '/etc/pve/pve-root-ca.pem',
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

describe('cORS', () => {
  it('answers OPTIONS preflight unauthenticated with PVE-origin headers', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new RejectAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'OPTIONS',
      url: '/api/nodes/testnode/v1/pools',
      headers: { host: 'pve1.example.com:3000', origin: 'https://pve1.example.com:8006' },
    })
    assert.equal(res.statusCode, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'https://pve1.example.com:8006')
    assert.equal(res.headers['access-control-allow-credentials'], 'true')
    assert.match(String(res.headers['access-control-allow-methods']), /GET/)
    assert.match(String(res.headers['access-control-allow-methods']), /DELETE/)
    assert.match(String(res.headers['access-control-allow-headers']), /x-anas-confirm/)
    await server.close()
  })

  it('derives the allowed origin from an IPv6 Host header', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    // The browser sends the matching Origin; the gateway echoes it only because
    // it equals the host-derived PVE UI origin (port stripped from [addr]:port).
    const res = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        host: '[2001:db8::1]:3000',
        origin: 'https://2001:db8::1:8006',
        cookie: 'PVEAuthCookie=x',
      },
    })
    assert.equal(res.headers['access-control-allow-origin'], 'https://2001:db8::1:8006')
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

  it('returns 502 NODE_UNREACHABLE for an unresolvable node (CA present)', async () => {
    // A readable CA lets the request past the fail-closed gate so it reaches the
    // actual forward attempt — which then fails DNS → NODE_UNREACHABLE.
    const caPath = join(caDir, 'present.pem')
    writeFileSync(caPath, 'test-ca-bytes')
    const server = createServer({
      config: baseConfig({ clusterCa: caPath }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/bogus.example/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(res.statusCode, 502)
    const body = res.json()
    assert.equal(body.error.code, 'NODE_UNREACHABLE')
    assert.match(body.error.message, /bogus\.example/)
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
        port: peerPort,
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
    const config = baseConfig({ clusterCa: caPath, port: 9 })

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
