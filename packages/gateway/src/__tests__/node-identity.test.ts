import type { Server } from 'node:http'
import type { AddressInfo, Server as NetServer } from 'node:net'
import type { AuthProvider, AuthUser } from '../auth/index.js'
import type { GatewayConfig } from '../config.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig } from '../config.js'
import { describeNodeNameSource, readPveNodeName, resolveNodeName, shortHostname } from '../node-name.js'
import { createServer } from '../server.js'

/** The issue #5 host: FQDN hostname, short PVE node name. */
const FQDN = 'pve-atlas.internal.mydomain.cloud'
const PVE_NODE = 'pve-atlas'

/** Auth provider that accepts everything (a distinct name so the cookie path runs). */
class AcceptAuthProvider implements AuthProvider {
  readonly name = 'accept'
  async validateToken(): Promise<AuthUser | null> {
    return { name: 'alice@pve', uid: 4242 }
  }
}

/**
 * Build a fake `/etc/pve` whose `local` symlink points at `nodes/<node>` —
 * exactly the shape PVE maintains on a real node.
 */
function fakePveLocal(target: string, node = PVE_NODE): { dir: string, localPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anas-pve-'))
  mkdirSync(join(dir, 'nodes', node), { recursive: true })
  const localPath = join(dir, 'local')
  symlinkSync(target, localPath)
  return { dir, localPath }
}

describe('node identity — resolution chain (issue #5)', () => {
  const dirs: string[] = []
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the PVE node name from /etc/pve/local (relative target) even when the hostname is an FQDN', () => {
    const { dir, localPath } = fakePveLocal(`nodes/${PVE_NODE}`)
    dirs.push(dir)
    const resolved = resolveNodeName({ ANAS_PVE_LOCAL_PATH: localPath }, () => FQDN)
    assert.equal(resolved.nodeName, PVE_NODE)
    assert.equal(resolved.source, 'pve-local')
    assert.equal(describeNodeNameSource(resolved), localPath)
  })

  it('reads an absolute symlink target too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anas-pve-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'nodes', PVE_NODE), { recursive: true })
    const localPath = join(dir, 'local')
    symlinkSync(join(dir, 'nodes', PVE_NODE), localPath)
    assert.equal(readPveNodeName(localPath), PVE_NODE)
  })

  it('falls back to the SHORT hostname when /etc/pve/local is absent (never the FQDN)', () => {
    const resolved = resolveNodeName(
      { ANAS_PVE_LOCAL_PATH: join(tmpdir(), 'anas-no-such-pve-local') },
      () => FQDN,
    )
    assert.equal(resolved.nodeName, PVE_NODE, 'the FQDN must be truncated at the first dot')
    assert.equal(resolved.source, 'hostname')
    assert.equal(describeNodeNameSource(resolved), 'hostname')
  })

  it('falls back when the path exists but is NOT a symlink (non-PVE box)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anas-pve-'))
    dirs.push(dir)
    const localPath = join(dir, 'local')
    writeFileSync(localPath, 'not a symlink')
    assert.equal(readPveNodeName(localPath), undefined)
    assert.equal(resolveNodeName({ ANAS_PVE_LOCAL_PATH: localPath }, () => FQDN).source, 'hostname')
  })

  it('falls back when the symlink target is not shaped like nodes/<name>', () => {
    for (const target of ['somewhere/else', 'pve-atlas', '/etc/pve/pve-atlas', 'nodes/..', 'nodes/bad_name']) {
      const dir = mkdtempSync(join(tmpdir(), 'anas-pve-'))
      dirs.push(dir)
      const localPath = join(dir, 'local')
      symlinkSync(target, localPath)
      assert.equal(readPveNodeName(localPath), undefined, `target '${target}' must not be trusted`)
    }
  })

  it('ANAS_NODE_NAME wins over both /etc/pve/local and the hostname', () => {
    const { dir, localPath } = fakePveLocal(`nodes/${PVE_NODE}`)
    dirs.push(dir)
    const resolved = resolveNodeName(
      { ANAS_NODE_NAME: 'operator-override', ANAS_PVE_LOCAL_PATH: localPath },
      () => FQDN,
    )
    assert.equal(resolved.nodeName, 'operator-override')
    assert.equal(resolved.source, 'ANAS_NODE_NAME')
    assert.equal(describeNodeNameSource(resolved), 'ANAS_NODE_NAME')
  })

  it('shortHostname truncates at the first dot and passes a bare short name through', () => {
    assert.equal(shortHostname(FQDN), PVE_NODE)
    assert.equal(shortHostname('pve5'), 'pve5')
  })

  it('loadConfig carries the resolved name and its source', () => {
    const { dir, localPath } = fakePveLocal(`nodes/${PVE_NODE}`)
    dirs.push(dir)
    const config = loadConfig({ ANAS_PVE_LOCAL_PATH: localPath }, () => FQDN)
    assert.equal(config.nodeName, PVE_NODE)
    assert.equal(config.nodeNameSource, 'pve-local')
    assert.equal(config.pveLocalPath, localPath)
  })
})

describe('node identity — routing heals the FQDN host (issue #5)', () => {
  const socketPath = join(tmpdir(), `anasd-identity-${process.pid}.sock`)
  let stub: Server
  let received: string | undefined
  const dirs: string[] = []

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
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('serves /api/nodes/<pve-node> locally on a host whose hostname is an FQDN', async () => {
    // Before the fix: nodeName was the FQDN, so the request for the SHORT PVE
    // node name took the forward branch and the gateway self-forwarded through
    // pveproxy until it timed out ("ANAS is not installed on this node").
    let outbound = 0
    const peer: NetServer = createTcpServer((sock) => {
      outbound += 1
      sock.destroy()
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const { dir, localPath } = fakePveLocal(`nodes/${PVE_NODE}`)
    dirs.push(dir)
    const config = loadConfig({
      ANAS_PVE_LOCAL_PATH: localPath,
      ANASD_SOCKET: socketPath,
      ANAS_PVE_PORT: String(peerPort),
    }, () => FQDN)

    const server = createServer({ config, authProvider: new AcceptAuthProvider(), logger: false })
    const res = await server.inject({
      method: 'GET',
      url: `/api/nodes/${PVE_NODE}/v1/pools`,
      headers: { cookie: 'PVEAuthCookie=x' },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(received, '/v1/pools', 'served over the local anasd socket')
    assert.equal(outbound, 0, 'the own node must never be forwarded out through :8006')
    // The health probe the panels use reports the PVE node name, not the FQDN.
    const health = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(health.json().data.node, PVE_NODE)

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })
})

describe('loop guard — x-anas-forwarded', () => {
  const socketPath = join(tmpdir(), `anasd-loopguard-${process.pid}.sock`)
  let stub: Server
  let received: string | undefined

  function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
      host: '127.0.0.1',
      port: 3000,
      pvePort: 8006,
      nodeName: PVE_NODE,
      anasdSocket: socketPath,
      authProvider: undefined,
      clusterCa: '/etc/pve/pve-root-ca.pem',
      membersPath: '/etc/pve/.members',
      ...overrides,
    }
  }

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

  it('an already-forwarded request for THIS node is served locally (the legitimate peer hop)', async () => {
    received = undefined
    const server = createServer({
      config: baseConfig(),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: `/api/nodes/${PVE_NODE}/v1/pools`,
      headers: { 'cookie': 'PVEAuthCookie=x', 'x-anas-forwarded': '1' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(received, '/v1/pools')
    await server.close()
  })

  it('refuses to forward an already-forwarded request AGAIN (502 FORWARD_LOOP, no outbound hop)', async () => {
    let outbound = 0
    const peer: NetServer = createTcpServer((sock) => {
      outbound += 1
      sock.destroy()
    })
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peer.address() as AddressInfo).port

    const server = createServer({
      config: baseConfig({ pvePort: peerPort }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/someothernode/v1/pools',
      headers: { 'cookie': 'PVEAuthCookie=x', 'x-anas-forwarded': '1' },
    })

    assert.equal(res.statusCode, 502)
    const body = res.json()
    assert.equal(body.error.code, 'FORWARD_LOOP')
    assert.match(body.error.message, /someothernode/)
    assert.match(body.error.message, new RegExp(PVE_NODE))
    assert.equal(outbound, 0, 'a looping request must not open an outbound connection')

    await server.close()
    await new Promise<void>(resolve => peer.close(() => resolve()))
  })

  it('a FIRST-hop request for a peer still forwards normally (guard is marker-gated)', async () => {
    // No marker → the normal forward path runs (and fails only because the CA
    // is unreadable here), proving the guard does not block legitimate hops.
    const server = createServer({
      config: baseConfig({ clusterCa: join(tmpdir(), 'anas-no-such-ca.pem') }),
      authProvider: new AcceptAuthProvider(),
      logger: false,
    })
    const res = await server.inject({
      method: 'GET',
      url: '/api/nodes/someothernode/v1/pools',
      headers: { cookie: 'PVEAuthCookie=x' },
    })
    assert.equal(res.json().error.code, 'CLUSTER_CA_UNAVAILABLE')
    await server.close()
  })
})
