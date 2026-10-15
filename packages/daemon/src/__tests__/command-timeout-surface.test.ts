import type { MockExecutor } from '../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { HealthResponse, StatusSummary } from '@anas/shared'
import { abandonedChildren } from '../executor/deadline.js'
import { buildAbandonedWarnings } from '../routes/dashboard.js'
import { createServer } from '../server.js'

/**
 * cr.34 — where a timeout and an abandoned child become visible:
 *   - a route that does not catch a CommandTimeoutError answers 503 TIMEOUT
 *     (the daemon's error handler), not a bare 500 and not an empty list;
 *   - every other error still gets Fastify's default handling;
 *   - GET /v1/health lists the abandoned children;
 *   - the dashboard turns each one into a `command` warning card.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

/** An entry as the executor records one (pid far outside any real range). */
const STUCK = {
  pid: 999_999_001,
  label: 'zpool status',
  command: '/usr/sbin/zpool',
  args: ['status', '-jv', 'tank'],
  lane: 'request' as const,
  budgetMs: 10_000,
  since: '2026-10-15T09:00:00.000Z',
}

describe('cr.34: a command timeout on the request path', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    abandonedChildren.remove(STUCK.pid)
  })

  it('GET /v1/pools with a zpool that never answers is 503 TIMEOUT naming the command — not `data: []`', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // Before this story the reader took a non-zero exit with no output for
    // "no pools"; a deadline that resolved like that would hide every pool.
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', timesOut: {} })
    const res = await server.inject({ method: 'GET', url: '/v1/pools', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string, details: Record<string, unknown> } }
    assert.equal(body.error.code, 'TIMEOUT')
    assert.match(body.error.message, /^'zpool list' did not finish within 10 s and was stopped/)
    assert.match(body.error.message, /The request was not completed\.$/)
    assert.deepEqual(body.error.details, { command: 'zpool list', budgetMs: 10_000, abandoned: false })
  })

  it('any other error keeps Fastify\'s default answer (the handler adds nothing for it)', async () => {
    server = createServer({ mock: true, logger: false })
    server.get('/v1/__boom', async () => {
      throw new Error('boom')
    })
    const res = await server.inject({ method: 'GET', url: '/v1/__boom', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.json(), { statusCode: 500, error: 'Internal Server Error', message: 'boom' })
  })
})

describe('cr.34: abandoned children are visible', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    abandonedChildren.remove(STUCK.pid)
  })

  it('GET /v1/health lists them by label, never by argv (status stays ok: the daemon is fine)', async () => {
    server = createServer({ mock: true, logger: false })
    const before = HealthResponse.parse((await server.inject({ method: 'GET', url: '/v1/health' })).json())
    assert.deepEqual(before.abandonedCommands, [])
    // An argv token no reply may carry (cr.34r: named like the audit log names it).
    abandonedChildren.add({ ...STUCK, args: ['status', '-jv', 'tank-argv-c0ffee'] })
    const res = await server.inject({ method: 'GET', url: '/v1/health' })
    assert.equal(res.body.includes('tank-argv-c0ffee'), false, 'the raw argv reached the reply')
    const after = HealthResponse.parse(res.json())
    assert.equal(after.status, 'ok')
    // `cause` absent on the registry entry reads as the deadline.
    const { args: _args, ...named } = STUCK
    assert.deepEqual(after.abandonedCommands, [{ ...named, cause: 'deadline' }])
  })

  it('GET /v1/status never carries the argv either', async () => {
    server = createServer({ mock: true, logger: false })
    abandonedChildren.add({ ...STUCK, args: ['status', '-jv', 'tank-argv-c0ffee'] })
    const res = await server.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.includes('tank-argv-c0ffee'), false, 'the raw argv reached the reply')
  })

  it('GET /v1/status carries a `command` warning card for each', async () => {
    server = createServer({ mock: true, logger: false })
    abandonedChildren.add({ ...STUCK, lane: 'job', jobId: 'f1d0c0de-0000-4000-8000-000000000001', label: 'zpool export' })
    const res = await server.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const summary = StatusSummary.parse((res.json() as { data: unknown }).data)
    const cards = summary.warnings.filter(w => w.category === 'command')
    assert.equal(cards.length, 1)
    assert.equal(cards[0].level, 'warning')
    assert.match(cards[0].message, /^'zpool export' \(pid 999999001, from job f1d0c0de-0000-4000-8000-000000000001\) did not end within 10 s and survived SIGKILL/)
    assert.match(cards[0].message, /since 2026-10-15T09:00:00\.000Z/)
  })

  it('the card names where the command ran when no job owns it', () => {
    const [request] = buildAbandonedWarnings([STUCK])
    assert.match(request.message, /from a request\)/)
    const [boot] = buildAbandonedWarnings([{ ...STUCK, lane: 'background' }])
    assert.match(boot.message, /from a background task\)/)
    // cr.34r: a child stopped for its output says so, not "did not end within".
    const [overflow] = buildAbandonedWarnings([{ ...STUCK, cause: 'maxBuffer' }])
    assert.match(overflow.message, /^'zpool status' \(pid 999999001, from a request\) was stopped for writing more output than the daemon keeps and survived SIGKILL/)
    assert.deepEqual(buildAbandonedWarnings([]), [])
  })
})
