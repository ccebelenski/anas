import type { Server } from 'node:http'
import type { GatewayConfig } from '../config.js'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ASSERTION_MAX_SKEW_S, signAssertion, verifyAssertion } from '../auth/assertion.js'
import { forbiddenMessage, requiredPrivilege } from '../auth/policy.js'
import { DevAuthProvider } from '../auth/providers/dev.js'
import { PveAuthProvider, uidForUser } from '../auth/providers/pve.js'
import { groupId, PROXY_KEY_MODE, removeProxyKey, writeProxyKey } from '../auth/proxy-key.js'
import { forwardedContentType, PRIVILEGES_HEADER } from '../proxy.js'
import { createServer, NOT_THROUGH_PVEPROXY } from '../server.js'

/**
 * cr.27 — PVE decides who and what inside pveproxy; the gateway believes only
 * the signed X-Anas-Auth statement and applies the one rule (GET/HEAD →
 * Sys.Audit, everything else → Sys.Modify). docs/WAVE2-DESIGN.md §2 A2.1, A3,
 * §5 rows 9-12, §7.
 *
 * The signing side lives in AnasProxy.pm; the known-answer vectors it signs
 * (packages/pve-integration/perl/t/fixtures/assertion-vectors.json, checked by
 * its own t/ tests) are verified here, so the two implementations cannot drift.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(readFileSync(
  join(HERE, '..', '..', '..', 'pve-integration', 'perl', 't', 'fixtures', 'assertion-vectors.json'),
  'utf8',
)) as {
  key_hex: string
  vectors: Array<{ header: string, method: string, path: string, privileges: string[], ts: number, userid_bytes_hex: string }>
}
const VECTOR_KEY = Buffer.from(VECTORS.key_hex, 'hex')

const KEY = Buffer.alloc(32, 0x5A)
const NOW = 1_760_600_000
const NODE = 'testnode'

function sign(userid: string, privileges: Array<'Sys.Audit' | 'Sys.Modify'>, method: string, path: string, opts: { ts?: number, key?: Buffer } = {}) {
  return signAssertion(opts.key ?? KEY, { userid, privileges, ts: opts.ts ?? NOW, method, path })
}

describe('X-Anas-Auth: the Perl signer and the gateway verifier agree (known-answer vectors)', () => {
  for (const v of VECTORS.vectors) {
    it(`verifies the vector signed by AnasProxy: ${v.method} ${v.path}`, () => {
      const r = verifyAssertion(VECTOR_KEY, v.header, { method: v.method, path: v.path, nowS: v.ts })
      assert.ok(r.ok, r.ok ? '' : r.reason)
      assert.equal(r.userid, Buffer.from(v.userid_bytes_hex, 'hex').toString('utf8'))
      assert.deepEqual(r.privileges, v.privileges)
    })
    it(`signs the same header as AnasProxy: ${v.method} ${v.path}`, () => {
      const userid = Buffer.from(v.userid_bytes_hex, 'hex').toString('utf8')
      assert.equal(signAssertion(VECTOR_KEY, {
        userid,
        privileges: v.privileges as Array<'Sys.Audit' | 'Sys.Modify'>,
        ts: v.ts,
        method: v.method,
        path: v.path,
      }), v.header)
    })
  }
})

describe('X-Anas-Auth: every field is bound by the MAC', () => {
  const path = '/api/nodes/testnode/v1/pools/tank/scrub'
  const good = sign('alice@pve', ['Sys.Audit'], 'POST', path)
  const req = { method: 'POST', path, nowS: NOW }

  it('accepts the untampered header', () => {
    const r = verifyAssertion(KEY, good, req)
    assert.deepEqual(r, { ok: true, userid: 'alice@pve', privileges: ['Sys.Audit'] })
  })

  const tampered: Array<[string, string]> = [
    ['the user', good.replace('user=alice@pve', 'user=root@pam')],
    ['the privileges', good.replace('privs=Sys.Audit;', 'privs=Sys.Audit,Sys.Modify;')],
    ['the timestamp (still fresh)', good.replace(`ts=${NOW};`, `ts=${NOW + 1};`)],
    ['the MAC', good.replace(/mac=(.)/, (_m, c: string) => `mac=${c === '0' ? '1' : '0'}`)],
  ]
  for (const [what, header] of tampered) {
    it(`refuses a header whose ${what} was changed: bad MAC`, () => {
      const r = verifyAssertion(KEY, header, req)
      assert.equal(r.ok, false)
      assert.match(r.ok ? '' : r.reason, /^bad proxy assertion MAC/)
    })
  }

  it('refuses the header for another method (replayed onto a different verb)', () => {
    const r = verifyAssertion(KEY, sign('alice@pve', ['Sys.Audit', 'Sys.Modify'], 'GET', path), req)
    assert.match(r.ok ? '' : r.reason, /^bad proxy assertion MAC/)
  })

  it('refuses the header for another path or query', () => {
    for (const other of ['/api/nodes/testnode/v1/pools/tank', `${path}?force=1`, '/api/nodes/othernode/v1/pools/tank/scrub']) {
      const r = verifyAssertion(KEY, sign('alice@pve', ['Sys.Audit'], 'POST', other), req)
      assert.match(r.ok ? '' : r.reason, /^bad proxy assertion MAC/, other)
    }
  })

  it('refuses a header signed with another key (forged)', () => {
    const r = verifyAssertion(KEY, sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'POST', path, { key: Buffer.alloc(32, 1) }), req)
    assert.match(r.ok ? '' : r.reason, /^bad proxy assertion MAC/)
  })
})

describe('X-Anas-Auth: freshness and shape', () => {
  const path = '/api/health'
  it(`accepts ±${ASSERTION_MAX_SKEW_S} s and refuses one second beyond, both ways`, () => {
    for (const d of [-ASSERTION_MAX_SKEW_S, 0, ASSERTION_MAX_SKEW_S])
      assert.ok(verifyAssertion(KEY, sign('a@pve', ['Sys.Audit'], 'GET', path, { ts: NOW + d }), { method: 'GET', path, nowS: NOW }).ok, `skew ${d}`)
    for (const d of [-(ASSERTION_MAX_SKEW_S + 1), ASSERTION_MAX_SKEW_S + 1]) {
      const r = verifyAssertion(KEY, sign('a@pve', ['Sys.Audit'], 'GET', path, { ts: NOW + d }), { method: 'GET', path, nowS: NOW })
      assert.match(r.ok ? '' : r.reason, /^stale proxy assertion/, `skew ${d}`)
    }
  })

  it('a missing header is "no proxy assertion"', () => {
    assert.deepEqual(verifyAssertion(KEY, undefined, { method: 'GET', path, nowS: NOW }), { ok: false, reason: 'no proxy assertion' })
  })

  it('refuses two headers, another version and malformed shapes', () => {
    const good = sign('a@pve', ['Sys.Audit'], 'GET', path)
    const cases: Array<[string | string[], RegExp]> = [
      [[good, good], /more than one/],
      [good.replace(/^v1;/, 'v2;'), /version/],
      ['garbage', /version/],
      [`${good};extra=1`, /malformed/],
      [good.replace(/mac=([0-9a-f]+)/, (_m, h: string) => `mac=${h.toUpperCase()}`), /malformed/],
      [good.replace('user=a@pve', 'user=a b@pve'), /malformed/],
    ]
    for (const [header, re] of cases) {
      const r = verifyAssertion(KEY, header, { method: 'GET', path, nowS: NOW })
      assert.equal(r.ok, false, String(header))
      assert.match(r.ok ? '' : r.reason, re, String(header))
    }
  })

  it('refuses a correctly signed header naming an unknown or repeated privilege, or an undecodable user', () => {
    const forge = (user: string, privs: string) => {
      // Sign the raw fields directly (signAssertion only takes valid privileges).
      const raw = sign('placeholder@pve', [], 'GET', path)
      const header = raw.replace('user=placeholder@pve', `user=${user}`).replace('privs=;', `privs=${privs};`)
      const mac = createHmac('sha256', KEY).update(['v1', user, privs, String(NOW), 'GET', path].join('\n')).digest('hex')
      return header.replace(/mac=[0-9a-f]+$/, `mac=${mac}`)
    }
    for (const [user, privs, re] of [
      ['a@pve', 'Sys.Root', /unknown or repeated privilege/],
      ['a@pve', 'Sys.Audit,Sys.Audit', /unknown or repeated privilege/],
      ['%FF@pve', 'Sys.Audit', /undecodable user/],
    ] as const) {
      const r = verifyAssertion(KEY, forge(user, privs), { method: 'GET', path, nowS: NOW })
      assert.match(r.ok ? '' : r.reason, re, `${user} ${privs}`)
    }
  })
})

// cr.64a: ANAS's own shape rule behind PVE's: a user id is `name@realm` and
// never contains `:` — the runner identity `system:task-runner` is refused
// even correctly signed. (The known-answer vectors cover the ids PVE does
// sign, all of them realm-suffixed; these are the negatives.)
describe('X-Anas-Auth: the user id must be one PVE can have (cr.64a)', () => {
  const path = '/api/health'
  for (const user of ['system:task-runner', 'root', 'a:b@c', 'noRealm']) {
    it(`refuses '${user}' even with a valid MAC`, () => {
      const r = verifyAssertion(KEY, sign(user, ['Sys.Audit'], 'GET', path), { method: 'GET', path, nowS: NOW })
      assert.equal(r.ok, false, user)
      assert.match(r.ok ? '' : r.reason, /user id PVE cannot have/, user)
    })
  }
  it('accepts the shapes PVE really signs', () => {
    for (const user of ['alice@pve', 'root@pam', 'svc_backup.1@ldap-corp', 'jörg@pam', 'a;b=c,d@pve'])
      assert.ok(verifyAssertion(KEY, sign(user, ['Sys.Audit'], 'GET', path), { method: 'GET', path, nowS: NOW }).ok, user)
  })
})

describe('the one rule: GET/HEAD → Sys.Audit, everything else → Sys.Modify', () => {
  it('maps every method', () => {
    assert.equal(requiredPrivilege('GET'), 'Sys.Audit')
    assert.equal(requiredPrivilege('HEAD'), 'Sys.Audit')
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
      assert.equal(requiredPrivilege(m), 'Sys.Modify', m)
  })

  // cr.67 (operator ruling 2026-10-17): the one exception to the method rule —
  // a POST whose daemon-side path is EXACTLY a shared READ_JOB_ROUTES entry.
  // The match is on the raw path (cr.62's rule): trailing slashes, percent-
  // encodings, longer names and dot segments are not the exception.
  it('cr.67: POST on an exact read-job path (or a shaped cancel) is Sys.Audit; near-misses are Sys.Modify', () => {
    const G = '/api/nodes/testnode/v1'
    for (const p of ['/cloud/tasks/preview', '/cloud/remotes/test', '/backup/restore/browse']) {
      assert.equal(requiredPrivilege('POST', `${G}${p}`), 'Sys.Audit', p)
      assert.equal(requiredPrivilege('GET', `${G}${p}`), 'Sys.Audit', `GET ${p}`)
      for (const m of ['PUT', 'DELETE'])
        assert.equal(requiredPrivilege(m, `${G}${p}`), 'Sys.Modify', `${m} ${p}`)
      assert.equal(requiredPrivilege('POST', `${G}${p}/`), 'Sys.Modify', `trailing slash on ${p}`)
      assert.equal(requiredPrivilege('POST', `${G}${p}%2F..`), 'Sys.Modify', `%2F.. on ${p}`)
    }
    assert.equal(requiredPrivilege('POST', `${G}/cloud/remotes/test2`), 'Sys.Modify', 'a longer name is not the path')

    // The cancel door: shape-matched, the id segment validated by the job-id
    // rule (a UUID) — never a bare wildcard.
    const ID = '550e8400-e29b-41d4-a716-446655440000'
    assert.equal(requiredPrivilege('POST', `${G}/jobs/${ID}/cancel`), 'Sys.Audit')
    for (const bad of ['not-a-uuid', '..', '550e8400-e29b-41d4-a716-44665544000', `${ID}%2Fx`, `${ID}/x`, ''])
      assert.equal(requiredPrivilege('POST', `${G}/jobs/${bad}/cancel`), 'Sys.Modify', `malformed id segment '${bad}'`)

    // A `..` segment is a literal path segment of the raw line: not normalised,
    // so it is not one of the exception paths — Sys.Modify; the gateway would
    // forward it verbatim and the daemon's router would match nothing.
    assert.equal(requiredPrivilege('POST', `${G}/../v1/cloud/tasks/preview`), 'Sys.Modify')
  })

  it('the 403 sentence names the path, the privilege and the user', () => {
    assert.equal(
      forbiddenMessage('alice@pve', 'Sys.Modify'),
      'Permission check failed (/, Sys.Modify): alice@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations.',
    )
  })
})

describe('uid: only a @pam user is a Linux account (F5, review M6 #45)', () => {
  it('looks up the name before the last @ for the pam realm only', async () => {
    const asked: string[] = []
    const resolve = async (n: string) => {
      asked.push(n)
      return n === 'root' ? 0 : 1001
    }
    assert.equal(await uidForUser('root@pam', resolve), 0)
    assert.equal(await uidForUser('alice@pve', resolve), -1)
    assert.equal(await uidForUser('alice@ldap-corp', resolve), -1)
    assert.equal(await uidForUser('mail@example.org@pam', resolve), 1001)
    assert.deepEqual(asked, ['root', 'mail@example.org'], 'no lookup for a non-pam realm')
  })
})

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    pvePort: 8006,
    nodeName: NODE,
    anasdSocket: '/run/anas/anasd.sock',
    authProvider: undefined,
    clusterCa: '/etc/pve/pve-root-ca.pem',
    membersPath: '/nonexistent/.members',
    ...overrides,
  }
}

describe('the gateway with the pve provider (end to end)', () => {
  const socketPath = join(tmpdir(), `anasd-authz-${process.pid}.sock`)
  let stub: Server
  let received: Array<{ method?: string, url?: string, headers: Record<string, string | string[] | undefined> }> = []
  const logs: string[] = []

  before(async () => {
    stub = createHttpServer((req, res) => {
      received.push({ method: req.method, url: req.url, headers: req.headers })
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
      })
    })
    await new Promise<void>(resolve => stub.listen(socketPath, resolve))
  })
  after(async () => {
    await new Promise<void>(resolve => stub.close(() => resolve()))
  })

  function gateway() {
    received = []
    logs.length = 0
    const provider = new PveAuthProvider(KEY, {
      now: () => NOW,
      resolveUid: async n => (n === 'root' ? 0 : 1001),
    })
    return createServer({
      config: baseConfig({ anasdSocket: socketPath }),
      authProvider: provider,
      logger: { level: 'warn', stream: { write: (l: string) => logs.push(String(JSON.parse(l).msg)) } },
    })
  }

  const POOLS = '/api/nodes/testnode/v1/pools'
  const SCRUB = '/api/nodes/testnode/v1/pools/tank/scrub'

  it('row 9: no X-Anas-Auth (a direct loopback caller) → 401 "did not come through pveproxy", logged, nothing forwarded', async () => {
    const s = gateway()
    const res = await s.inject({ method: 'GET', url: POOLS, headers: { cookie: 'PVEAuthCookie=PVE:root@pam:6AD0605A::sig' } })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: { code: 'UNAUTHORIZED', message: NOT_THROUGH_PVEPROXY } })
    assert.equal(NOT_THROUGH_PVEPROXY, 'This request did not come through pveproxy')
    assert.deepEqual(logs, [`[authz] refused GET ${POOLS}: no proxy assertion`])
    assert.equal(received.length, 0)
    await s.close()
  })

  it('row 10: a forged, a stale and a replayed header → 401, each logged with which check failed', async () => {
    const s = gateway()
    const cases: Array<[string, RegExp]> = [
      [sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'GET', POOLS, { key: Buffer.alloc(32, 9) }), /bad proxy assertion MAC/],
      [sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'GET', POOLS, { ts: NOW - 31 }), /stale proxy assertion/],
      [sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'GET', '/api/health'), /bad proxy assertion MAC/],
    ]
    for (const [header, re] of cases) {
      logs.length = 0
      const res = await s.inject({ method: 'GET', url: POOLS, headers: { 'x-anas-auth': header } })
      assert.equal(res.statusCode, 401)
      assert.equal(res.json().error.message, NOT_THROUGH_PVEPROXY)
      assert.equal(logs.length, 1)
      assert.match(logs[0]!, re)
    }
    assert.equal(received.length, 0)
    await s.close()
  })

  // cr.64a: cr.56's runner-only identity (`system:task-runner` — no realm, a
  // `:` in the name, printed by the task runners themselves on the daemon's
  // Unix socket) must never arrive through the gateway. pveproxy cannot sign
  // it (PVE has no such user), and ANAS now refuses the shape itself even if
  // the MAC is valid for it — the check is the verifier's, not PVE's alone.
  it('cr.64a: a VALID signature naming system:task-runner (or any `:`-bearing, realm-less id) → 401, logged, nothing forwarded', async () => {
    const s = gateway()
    for (const user of ['system:task-runner', 'root']) {
      logs.length = 0
      const res = await s.inject({ method: 'GET', url: POOLS, headers: { 'x-anas-auth': sign(user, ['Sys.Audit', 'Sys.Modify'], 'GET', POOLS) } })
      assert.equal(res.statusCode, 401, user)
      assert.equal(res.json().error.message, NOT_THROUGH_PVEPROXY)
      assert.equal(logs.length, 1, user)
      assert.match(logs[0]!, /user id PVE cannot have/, user)
    }
    assert.equal(received.length, 0)
    await s.close()
  })

  it('a reader (Sys.Audit) may GET and HEAD; the daemon gets the full user id, uid -1 and the privileges', async () => {
    const s = gateway()
    let res = await s.inject({ method: 'GET', url: POOLS, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'GET', POOLS) } })
    assert.equal(res.statusCode, 200)
    assert.equal(received[0]!.headers['x-anas-user'], 'anas-audit@pve')
    assert.equal(received[0]!.headers['x-anas-user-uid'], '-1')
    assert.equal(received[0]!.headers[PRIVILEGES_HEADER], 'Sys.Audit')
    res = await s.inject({ method: 'HEAD', url: '/api/health', headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'HEAD', '/api/health') } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(logs, [])
    await s.close()
  })

  it('cr.28: a client cannot hand the daemon its own identity or privileges — the gateway sends only what pveproxy signed', async () => {
    // The daemon's job-queue backstop reads x-anas-privileges; a browser (or a
    // local caller with a valid assertion) that adds the header itself, or a
    // different x-anas-user, must not reach the daemon with it.
    const s = gateway()
    const res = await s.inject({
      method: 'GET',
      url: POOLS,
      headers: {
        'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'GET', POOLS),
        [PRIVILEGES_HEADER]: 'Sys.Audit,Sys.Modify',
        'x-anas-user': 'root@pam',
        'x-anas-user-uid': '0',
      },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(received[0]!.headers[PRIVILEGES_HEADER], 'Sys.Audit')
    assert.equal(received[0]!.headers['x-anas-user'], 'anas-audit@pve')
    assert.equal(received[0]!.headers['x-anas-user-uid'], '-1')
    await s.close()
  })

  it('row 11: a reader\'s POST, PUT, DELETE and PATCH → 403 FORBIDDEN naming Sys.Modify, logged, nothing reaches the daemon', async () => {
    const s = gateway()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      logs.length = 0
      const res = await s.inject({ method, url: SCRUB, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], method, SCRUB) } })
      assert.equal(res.statusCode, 403, method)
      assert.deepEqual(res.json(), {
        error: {
          code: 'FORBIDDEN',
          message: 'Permission check failed (/, Sys.Modify): anas-audit@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations.',
        },
      })
      assert.deepEqual(logs, [`[authz] forbidden: anas-audit@pve ${method} ${SCRUB} lacks Sys.Modify on /`])
    }
    assert.equal(received.length, 0)
    await s.close()
  })

  // cr.67 (operator ruling 2026-10-17): the read-job doors and a cancel go
  // through for a Sys.Audit-only user; everything merely shaped like them
  // keeps row 11 (403 naming Sys.Modify, nothing reaches the daemon).
  it('cr.67: a reader POSTs the three read doors and a cancel through; near-misses 403 Sys.Modify', async () => {
    const s = gateway()
    const ID = '11111111-2222-4333-8444-555555555555'
    const PASS = [
      '/api/nodes/testnode/v1/cloud/tasks/preview',
      '/api/nodes/testnode/v1/cloud/remotes/test',
      '/api/nodes/testnode/v1/backup/restore/browse',
      `/api/nodes/testnode/v1/jobs/${ID}/cancel`,
    ]
    for (const url of PASS) {
      const res = await s.inject({ method: 'POST', url, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'POST', url) } })
      assert.equal(res.statusCode, 200, url)
    }
    assert.deepEqual(received.map(r => r.method), PASS.map(() => 'POST'))

    const MISS = [
      '/api/nodes/testnode/v1/cloud/tasks/preview/',
      '/api/nodes/testnode/v1/cloud/remotes/test%2F..',
      '/api/nodes/testnode/v1/cloud/remotes/test2',
      '/api/nodes/testnode/v1/jobs/not-a-uuid/cancel',
      // `…/v1/../v1/cloud/tasks/preview` is pinned at the policy level, not
      // here: inject's URL parser normalises the dot segment away before the
      // hook sees the line (a header signed for the raw `..` path would fail
      // the MAC), so through this transport the case cannot arrive intact.
      // Node's real HTTP parser keeps the raw line as sent, and the policy
      // rule for it (requiredPrivilege, test above) is Sys.Modify — never
      // normalised into the exception, forwarded verbatim for the daemon's
      // router to miss.
    ]
    for (const url of MISS) {
      const res = await s.inject({ method: 'POST', url, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'POST', url) } })
      assert.equal(res.statusCode, 403, url)
      assert.match(res.json().error.message, /^Permission check failed \(\/, Sys\.Modify\): anas-audit@pve does not have it\./, url)
    }
    assert.equal(received.length, PASS.length, 'the near-misses reached nothing')

    // The exception is POST-shaped only: a GET of an exception path stays the
    // read it always was, a PUT/DELETE of it needs Sys.Modify.
    for (const url of [PASS[0]!, PASS[3]!]) {
      const res = await s.inject({ method: 'GET', url, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'GET', url) } })
      assert.equal(res.statusCode, 200, `GET ${url}`)
      for (const m of ['PUT', 'DELETE'] as const) {
        const r = await s.inject({ method: m, url, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], m, url) } })
        assert.equal(r.statusCode, 403, `${m} ${url}`)
        assert.match(r.json().error.message, /Sys\.Modify/, `${m} ${url}`)
      }
    }
    await s.close()
  })

  // cr.62 (review L9): the acts that used to ride a GET — the iSCSI placeholder
  // quarantine (GET /iscsi/health, GET /status) and the cluster replication key
  // (GET /replication/remotes) — are POST verbs now: Repair and the keypair
  // verb. A reader (or a cross-site navigation, which can only make a GET and
  // carries no CSRF token — PVE refuses a token-less POST with 401 before the
  // gateway, AnasProxy-auth.t row 5) cannot reach them; Sys.Modify can.
  it('cr.62: the acting verbs are POSTs — a reader gets 403 and nothing reaches the daemon; Sys.Modify goes through', async () => {
    const s = gateway()
    const ACTS = ['/api/nodes/testnode/v1/iscsi/health/repair', '/api/nodes/testnode/v1/replication/remotes/keypair']
    for (const url of ACTS) {
      const res = await s.inject({ method: 'POST', url, headers: { 'x-anas-auth': sign('anas-audit@pve', ['Sys.Audit'], 'POST', url) } })
      assert.equal(res.statusCode, 403, url)
      assert.match(res.json().error.message, /^Permission check failed \(\/, Sys\.Modify\): anas-audit@pve does not have it\./)
    }
    assert.equal(received.length, 0)
    for (const url of ACTS) {
      const res = await s.inject({ method: 'POST', url, headers: { 'x-anas-auth': sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'POST', url) } })
      assert.equal(res.statusCode, 200, url)
    }
    assert.deepEqual(received.map(r => `${r.method} ${r.url}`), ['POST /v1/iscsi/health/repair', 'POST /v1/replication/remotes/keypair'])
    await s.close()
  })

  it('a user with no privilege on / → 403 naming Sys.Audit on a read (also on the gateway\'s own health route)', async () => {
    const s = gateway()
    for (const url of [POOLS, '/api/health']) {
      const res = await s.inject({ method: 'GET', url, headers: { 'x-anas-auth': sign('anas-node@pve', [], 'GET', url) } })
      assert.equal(res.statusCode, 403, url)
      assert.match(res.json().error.message, /^Permission check failed \(\/, Sys\.Audit\): anas-node@pve does not have it\./)
    }
    assert.equal(received.length, 0)
    await s.close()
  })

  it('the privileges are tiered by ANAS (operator 2026-10-15): Sys.Modify alone may POST AND GET; Sys.Audit alone may GET but not POST', async () => {
    const s = gateway()
    let res = await s.inject({ method: 'POST', url: SCRUB, headers: { 'x-anas-auth': sign('odd@pve', ['Sys.Modify'], 'POST', SCRUB) } })
    assert.equal(res.statusCode, 200)
    res = await s.inject({ method: 'GET', url: POOLS, headers: { 'x-anas-auth': sign('odd@pve', ['Sys.Modify'], 'GET', POOLS) } })
    assert.equal(res.statusCode, 200, 'the higher privilege covers a read')
    res = await s.inject({ method: 'POST', url: SCRUB, headers: { 'x-anas-auth': sign('reader@pve', ['Sys.Audit'], 'POST', SCRUB) } })
    assert.equal(res.statusCode, 403, 'the lower privilege never covers a change')
    await s.close()
  })

  it('an administrator\'s mutation goes through; root@pam carries its Linux uid', async () => {
    const s = gateway()
    const res = await s.inject({
      method: 'POST',
      url: SCRUB,
      headers: { 'x-anas-auth': sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'POST', SCRUB), 'content-type': 'application/json' },
      payload: '{}',
    })
    assert.equal(res.statusCode, 200)
    assert.equal(received[0]!.headers['x-anas-user'], 'root@pam')
    assert.equal(received[0]!.headers['x-anas-user-uid'], '0')
    assert.equal(received[0]!.headers[PRIVILEGES_HEADER], 'Sys.Audit,Sys.Modify')
    assert.equal(received[0]!.headers['x-anas-auth'], undefined, 'the assertion is not passed to the daemon')
    await s.close()
  })

  it('the presence probe stays the only exemption: GET /installed needs no assertion, POST /installed does', async () => {
    const s = gateway()
    let res = await s.inject({ method: 'GET', url: '/installed' })
    assert.equal(res.statusCode, 200)
    res = await s.inject({ method: 'POST', url: '/installed' })
    assert.equal(res.statusCode, 401)
    await s.close()
  })

  it('the dev provider grants both privileges and needs no assertion', async () => {
    const s = createServer({ config: baseConfig({ anasdSocket: socketPath }), authProvider: new DevAuthProvider(), logger: false })
    received = []
    const res = await s.inject({ method: 'POST', url: SCRUB })
    assert.equal(res.statusCode, 200)
    assert.equal(received[0]!.headers['x-anas-user'], 'devuser')
    assert.equal(received[0]!.headers[PRIVILEGES_HEADER], 'Sys.Audit,Sys.Modify')
    await s.close()
  })

  describe('the 415 rule is uniform through the gateway (cr.26 note)', () => {
    const cases: Array<{ name: string, type?: string, body?: string, expect: string | undefined }> = [
      { name: 'a body-less text/plain POST reaches the daemon WITH its type (the daemon answers its own 415)', type: 'text/plain', expect: 'text/plain' },
      { name: 'a body-less form POST keeps its type', type: 'application/x-www-form-urlencoded', expect: 'application/x-www-form-urlencoded' },
      { name: 'a body-less JSON-typed POST is forwarded without the type (as before)', type: 'application/json', expect: undefined },
      { name: 'a body-less POST with no type carries none', expect: undefined },
      { name: 'a text/plain body keeps its type', type: 'text/plain', body: 'x', expect: 'text/plain' },
      { name: 'a body with no type is sent as JSON (as before)', body: '{}', expect: 'application/json' },
    ]
    for (const c of cases) {
      it(c.name, async () => {
        const s = gateway()
        const headers: Record<string, string> = { 'x-anas-auth': sign('root@pam', ['Sys.Audit', 'Sys.Modify'], 'POST', SCRUB) }
        if (c.type)
          headers['content-type'] = c.type
        const res = await s.inject({ method: 'POST', url: SCRUB, headers, ...(c.body !== undefined ? { payload: c.body } : {}) })
        assert.equal(res.statusCode, 200)
        assert.equal(received[0]!.headers['content-type'], c.expect)
        await s.close()
      })
    }
    it('forwardedContentType: parameters and case do not hide application/json', () => {
      assert.equal(forwardedContentType('Application/JSON; charset=utf-8', false), undefined)
      assert.equal(forwardedContentType('text/plain;charset=utf-8', false), 'text/plain;charset=utf-8')
    })
  })
})

describe('the proxy key file (§5 row 12; A2.1: root:www-data 0640, atomic, rotated per start)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anas-key-'))
  const path = join(dir, 'run', 'anas', 'proxy.key')
  const uid = process.getuid!()
  const gid = process.getgid!()
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('writes 32 random bytes, mode 0640, owner and group as asked, creating the directory 0755', () => {
    const key = writeProxyKey(path, { uid, gid })
    assert.equal(key.length, 32)
    assert.ok(readFileSync(path).equals(key))
    const st = statSync(path)
    assert.equal(st.mode & 0o777, PROXY_KEY_MODE)
    assert.equal(PROXY_KEY_MODE, 0o640)
    assert.equal(st.uid, uid)
    assert.equal(st.gid, gid)
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o755)
    assert.deepEqual(readdirSync(dirname(path)), ['proxy.key'], 'no temp file left')
  })

  it('a restart rotates it: a new key, a new inode (AnasProxy\'s cache sees the change)', () => {
    const before = statSync(path).ino
    const old = readFileSync(path)
    const key = writeProxyKey(path, { uid, gid })
    assert.ok(!key.equals(old))
    assert.notEqual(statSync(path).ino, before)
  })

  it('sets the group it is given on the file (www-data in production)', (t) => {
    const other = process.getgroups!().find(g => g !== gid)
    if (other === undefined) {
      t.skip('the test user has no supplementary group to chown to')
      return
    }
    const p = join(dir, 'grp', 'proxy.key')
    writeProxyKey(p, { uid, gid: other })
    assert.equal(statSync(p).gid, other)
  })

  it('a failed write leaves the previous key in place (temp file + rename, never in place)', (t) => {
    if (uid === 0) {
      t.skip('root may chown to any group; the failure cannot be provoked')
      return
    }
    const p = join(dir, 'atomic', 'proxy.key')
    const first = writeProxyKey(p, { uid, gid })
    // A non-root process may not give a file to group 0: the write fails at fchown.
    assert.throws(() => writeProxyKey(p, { uid, gid: 0 }), /^Error: cannot write /)
    assert.ok(readFileSync(p).equals(first), 'the old key is still there, whole')
    assert.deepEqual(readdirSync(dirname(p)), ['proxy.key'], 'no temp file left')
  })

  it('refuses to start without the www-data group, naming it', () => {
    const groups = join(dir, 'group')
    writeFileSync(groups, 'root:x:0:\nadm:x:4:\n')
    assert.throws(() => writeProxyKey(join(dir, 'k2'), { uid, groupFile: groups }), /^Error: cannot write .*k2: group 'www-data' not found in .*group/)
    assert.equal(existsSync(join(dir, 'k2')), false)
  })

  it('reads the www-data gid from the group file', () => {
    const groups = join(dir, 'group2')
    writeFileSync(groups, 'root:x:0:\nwww-data:x:33:\n')
    assert.equal(groupId('www-data', groups), 33)
    assert.equal(groupId('nobody-here', groups), undefined)
  })

  it('an unwritable location fails with "cannot write <path>"', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, '')
    assert.throws(() => writeProxyKey(join(blocker, 'proxy.key'), { uid, gid }), /^Error: cannot write .*blocker\/proxy\.key: /)
  })

  it('shutdown removes the key only while it is still ours', () => {
    const p = join(dir, 'rm', 'proxy.key')
    mkdirSync(dirname(p), { recursive: true })
    const mine = writeProxyKey(p, { uid, gid })
    removeProxyKey(p, Buffer.alloc(32, 1))
    assert.ok(existsSync(p), 'another process\'s key is left alone')
    removeProxyKey(p, mine)
    assert.equal(existsSync(p), false)
  })
})
