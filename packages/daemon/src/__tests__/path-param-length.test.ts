import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../server.js'

/**
 * A mountpoint (or an export path) longer than Fastify's default 100-char
 * param cap reached no route at all — a route-not-found 404 — so it could not
 * be read, edited, unmounted or removed (found by cr.39 with a deep TMPDIR).
 * A route that MATCHES answers in the ANAS error envelope; Fastify's own
 * not-found does not.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

describe('long path params reach their route', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a 300-character mountpoint is answered by the mounts route, not a route-not-found', async () => {
    server = createServer({ mock: true, logger: false })
    const mp = `/mnt/${'a'.repeat(300)}`
    const res = await server.inject({ method: 'GET', url: `/v1/mounts/${encodeURIComponent(mp)}`, headers: IDENTITY_HEADERS })
    const body = res.json() as { error?: { code?: string }, message?: string }
    assert.ok(body.error && typeof body.error.code === 'string', `route-not-found: ${res.body}`)
  })
})
