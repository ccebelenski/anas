import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { identityHeaders } from '../runner-poll.js'
import { createServer } from '../server.js'

/**
 * cr.26 — the daemon accepts JSON bodies only (review H1, third bullet;
 * WAVE2-DESIGN §3). The rule under test, quoted from the design:
 *
 *   "for POST/PUT/DELETE/PATCH, a Content-Type that is present and not
 *   `application/json` is a 415 naming the type, with or without a body, and
 *   a body without a Content-Type is a 415; the `text/plain` parser is
 *   removed."
 *
 * The four request shapes of §8 run against POST /v1/pools/:name/scrub, the
 * design's own example; the runner submit and the cache-event script shapes
 * are pinned so a future parser change that breaks a shipped caller fails.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const SCRUB_URL = '/v1/pools/testpool/scrub'

describe('cr.26 content-type: the four request shapes (§8)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('JSON body → passes, as today (202 + job)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: SCRUB_URL,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'start' }),
    })
    assert.equal(res.statusCode, 202)
    assert.ok((res.json() as { job?: { id?: string } }).job?.id)
  })

  it('text/plain body → 415, the type named, and no job', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: SCRUB_URL,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'text/plain' },
      payload: 'action=start',
    })
    assert.equal(res.statusCode, 415)
    const body = res.json() as { error: { code: string, message: string, details?: Record<string, unknown> }, job?: unknown }
    assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE')
    assert.match(body.error.message, /text\/plain/)
    assert.equal(body.error.details?.contentType, 'text/plain')
    assert.equal(body.job, undefined)
  })

  it('application/x-www-form-urlencoded → 415 (empty body or not)', async () => {
    server = createServer({ mock: true, logger: false })
    // The shape a plain HTML form sends. Empty body included: the rule keys
    // on the type being present, "with or without a body".
    const empty = await server.inject({
      method: 'POST',
      url: SCRUB_URL,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    })
    assert.equal(empty.statusCode, 415)
    assert.equal((empty.json() as { error: { code: string } }).error.code, 'UNSUPPORTED_MEDIA_TYPE')

    const filled = await server.inject({
      method: 'POST',
      url: SCRUB_URL,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=start',
    })
    assert.equal(filled.statusCode, 415)
  })

  it('body-less POST without a Content-Type → passes, as today (202 + job)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({ method: 'POST', url: SCRUB_URL, headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 202)
    assert.ok((res.json() as { job?: { id?: string } }).job?.id)
  })
})

describe('cr.26 content-type: the rest of the rule', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a body without any Content-Type → 415', async () => {
    server = createServer({ mock: true, logger: false })
    // light-my-request sets content-length for a string payload and adds no
    // type — exactly the header state the rule refuses.
    const res = await server.inject({
      method: 'POST',
      url: SCRUB_URL,
      headers: IDENTITY_HEADERS,
      payload: 'action=start',
    })
    assert.equal(res.statusCode, 415)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE')
    assert.match(body.error.message, /without a Content-Type/)
  })

  it('application/json with a charset parameter → passes (parameters are not the type)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: SCRUB_URL,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ action: 'start' }),
    })
    assert.equal(res.statusCode, 202)
  })

  it('GET/HEAD are not affected — a text/plain type on a read stays fine', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({ method: 'GET', url: '/v1/health', headers: { 'content-type': 'text/plain' } })
    assert.equal(res.statusCode, 200)
  })

  it('PUT and DELETE carry the same rule', async () => {
    server = createServer({ mock: true, logger: false })
    const put = await server.inject({
      method: 'PUT',
      url: '/v1/scrub/zfs/tank',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'text/plain' },
      payload: 'enabled=true',
    })
    assert.equal(put.statusCode, 415)
    const del = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'x=1',
    })
    assert.equal(del.statusCode, 415)
  })

  it('the text/plain parser stays removed (Fastify default off the wire)', async () => {
    server = createServer({ mock: true, logger: false })
    assert.equal(server.hasContentTypeParser('text/plain'), false)
    assert.equal(server.hasContentTypeParser('application/json'), true)
  })
})

describe('cr.26 content-type: shipped client shapes pinned', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a timer-fired runner submit (identityHeaders + JSON body) reaches its route', async () => {
    // The exact submit of backup-task.ts (the schedule/backup/cloud task
    // runners): identityHeaders() + a JSON body, POSTed to the run door. The
    // task unit does not exist in the mock unit store, so the route answers
    // 404 — proof the request got through the hook AND was parsed as JSON.
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/nightly/run',
      headers: identityHeaders(),
      payload: JSON.stringify({ direct: true }),
    })
    assert.notEqual(res.statusCode, 415)
    assert.equal(res.statusCode, 404)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'NOT_FOUND')
  })

  it('the cache-event script request shape (curl, lowercase JSON type) is not a 415', async () => {
    // packaging/anas-cache-event.sh: --header 'content-type: application/json'
    // (lowercase, as curl sends it), system identity, a JSON body built with
    // printf. The pool has no cache here — what this pins is that the shape
    // clears the 415 hook and reaches the route.
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/ahr/tank/cache/event',
      headers: {
        'content-type': 'application/json',
        'x-anas-user': 'system:udev-cache-event',
        'x-anas-user-uid': '0',
        'x-anas-privileges': 'Sys.Audit,Sys.Modify',
        'x-anas-request-id': randomUUID(),
      },
      payload: '{"event":"device-removed","slice":"tank-cache1","kernel":"sdd1"}',
    })
    assert.notEqual(res.statusCode, 415)
    assert.notEqual((res.json() as { error?: { code?: string } }).error?.code, 'UNSUPPORTED_MEDIA_TYPE')
  })
})
