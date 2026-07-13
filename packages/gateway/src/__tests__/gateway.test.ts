import type { Server } from 'node:http'
import type { AuthProvider, AuthUser } from '../auth/index.js'
import type { GatewayConfig } from '../config.js'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
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

  it('strips the port from an IPv6 Host header', async () => {
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '[2001:db8::1]:3000', cookie: 'PVEAuthCookie=x' },
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
    // Prefix stripped, query preserved.
    assert.equal(received.url, '/v1/pools?verbose=1')
    // Identity headers attached.
    assert.equal(received.headers['x-anas-user'], 'alice@pve')
    assert.equal(received.headers['x-anas-user-uid'], '4242')
    assert.ok(received.headers['x-anas-request-id'])

    await server.close()
  })
})

describe('remote node forwarding', () => {
  it('returns 502 NODE_UNREACHABLE for an unresolvable node', async () => {
    const server = createServer({
      config: baseConfig(),
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
    await server.close()
  })
})
