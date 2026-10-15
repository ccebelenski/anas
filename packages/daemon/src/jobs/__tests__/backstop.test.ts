import type { Job, JobAccepted } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JobHandler, JobQueue as JobQueueType } from '../queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { forbiddenMessage } from '@anas/shared'
import { requireIdentity } from '../../routes/identity.js'
import { identityHeaders, socketRequester } from '../../runner-poll.js'
import { createServer } from '../../server.js'
import { CANCEL_OPERATION, readRequestAuthority, requiredPrivilege, runAsDaemon, runAsRequest } from '../authority.js'
import { JobQueue } from '../queue.js'
import { READ_JOB_OPERATIONS } from '../read-jobs.js'

/**
 * cr.28 — the job queue refuses work without Sys.Modify (WAVE2-DESIGN A3.1),
 * and a read job (cr.48, `read.*`) on Sys.Audit (operator ruling 2026-10-15).
 * The gateway's method rule (cr.27) stays the primary gate; these prove the
 * backstop behind it on the REAL daemon (createServer: its onRequest hooks,
 * its error handler, its queue), with test-only routes standing in for the
 * case the backstop exists for — a route the method rule lets a reader reach
 * (a GET) that submits a job anyway.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_EVENT_SCRIPT = join(HERE, '..', '..', '..', '..', '..', 'packaging', 'anas-cache-event.sh')

function headers(privileges: string | undefined, user = 'anas-audit@pve'): Record<string, string> {
  return {
    'x-anas-user': user,
    'x-anas-user-uid': '-1',
    'x-anas-request-id': randomUUID(),
    ...(privileges !== undefined ? { 'x-anas-privileges': privileges } : {}),
  }
}

const noop: JobHandler = async () => null

type Server = ReturnType<typeof createServer>

function queueOf(server: Server): JobQueueType {
  return (server as unknown as { jobQueue: JobQueueType }).jobQueue
}

/**
 * The daemon with its own hooks, error handler and queue, plus test-only
 * routes registered on it (root level, so every global hook applies):
 *
 *   POST /test/write    requireIdentity → submit a write job
 *   POST /test/read     requireIdentity → submit a read job (read.cloud.preview)
 *   GET  /test/sneaky   requireIdentity → submit a write job from a GET
 *   POST /test/as-boot  NO requireIdentity: a route that builds a system-looking
 *                       submitter by hand (`system:boot-cache`) and submits
 */
function daemon(lines: string[]): Server {
  const server = createServer({
    mock: true,
    logger: { level: 'warn', stream: { write: (l: string) => lines.push(String(JSON.parse(l).msg)) } },
  })
  const submitWith = (operation: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return reply
    const job = queueOf(server).submit(operation, { ...identity, params: { name: 'tank' } }, noop)
    reply.code(202)
    return { job }
  }
  server.post('/test/write', submitWith('pool.scrub'))
  server.post('/test/read', submitWith(READ_JOB_OPERATIONS.cloudPreview))
  server.get('/test/sneaky', submitWith('pool.scrub'))
  server.post('/test/as-boot', async (_request, reply) => {
    const job = queueOf(server).submit('ahr.cache.detach', { user: 'system:boot-cache', uid: 0, params: { pool: 'tank' } }, noop)
    reply.code(202)
    return { job }
  })
  return server
}

describe('cr.28 the rule (jobs/authority.ts requiredPrivilege)', () => {
  it('a job needs Sys.Modify; a read.* job Sys.Audit; a cancel follows its target', () => {
    assert.equal(requiredPrivilege('pool.scrub'), 'Sys.Modify')
    assert.equal(requiredPrivilege('cloud.task.run'), 'Sys.Modify')
    for (const op of Object.values(READ_JOB_OPERATIONS))
      assert.equal(requiredPrivilege(op), 'Sys.Audit', op)
    assert.equal(requiredPrivilege(CANCEL_OPERATION, { id: 'x', operation: READ_JOB_OPERATIONS.backupCatalog }), 'Sys.Audit')
    assert.equal(requiredPrivilege(CANCEL_OPERATION, { id: 'x', operation: 'cloud.task.run' }), 'Sys.Modify')
    assert.equal(requiredPrivilege(CANCEL_OPERATION), 'Sys.Modify', 'a cancel that names no target operation is a change')
  })

  it('reads the header with the shared RequestHeaders rule: absent and garbage carry no privileges', () => {
    assert.deepEqual(readRequestAuthority(headers('Sys.Audit,Sys.Modify')).privileges, ['Sys.Audit', 'Sys.Modify'])
    assert.deepEqual(readRequestAuthority(headers('')).privileges, [])
    const absent = readRequestAuthority(headers(undefined))
    assert.equal(absent.privileges, null)
    assert.match(absent.problem!, /no x-anas-privileges header/)
    const garbage = readRequestAuthority(headers('Sys.Modify, Sys.Audit'))
    assert.equal(garbage.privileges, null)
    assert.match(garbage.problem!, /"Sys.Modify, Sys.Audit" is not a privilege list/)
  })
})

describe('cr.28 the backstop on the daemon (createServer)', () => {
  let server: Server
  const lines: string[] = []

  beforeEach(() => {
    lines.length = 0
    server = daemon(lines)
  })

  afterEach(async () => {
    await server.close()
  })

  it('a submit without Sys.Modify → 403 FORBIDDEN with the gateway\'s sentence, logged, nothing recorded', async () => {
    for (const privileges of ['Sys.Audit', '']) {
      lines.length = 0
      const res = await server.inject({ method: 'POST', url: '/test/write', headers: headers(privileges) })
      assert.equal(res.statusCode, 403, res.body)
      assert.deepEqual(res.json(), {
        error: { code: 'FORBIDDEN', message: forbiddenMessage('anas-audit@pve', 'Sys.Modify') },
      })
      const held = privileges === '' ? 'no privilege' : privileges
      assert.deepEqual(lines, [`audit: anas-audit@pve refused pool.scrub: lacks Sys.Modify on / (holds ${held} on /)`])
    }
    assert.deepEqual(queueOf(server).list(), [], 'no job was recorded')
  })

  it('a GET that submits a job (what the backstop is for) is refused for a reader', async () => {
    const res = await server.inject({ method: 'GET', url: '/test/sneaky', headers: headers('Sys.Audit') })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error.code, 'FORBIDDEN')
    assert.deepEqual(queueOf(server).list(), [])
  })

  it('Sys.Modify submits (with or without Sys.Audit beside it)', async () => {
    for (const privileges of ['Sys.Audit,Sys.Modify', 'Sys.Modify']) {
      const res = await server.inject({ method: 'POST', url: '/test/write', headers: headers(privileges, 'root@pam') })
      assert.equal(res.statusCode, 202, res.body)
      assert.equal((res.json() as JobAccepted).job.operation, 'pool.scrub')
    }
    assert.deepEqual(lines, [])
  })

  it('a read.* job with Sys.Audit only → 202 accepted; with no privilege → 403 naming Sys.Audit', async () => {
    let res = await server.inject({ method: 'POST', url: '/test/read', headers: headers('Sys.Audit') })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((res.json() as JobAccepted).job.operation, READ_JOB_OPERATIONS.cloudPreview)
    res = await server.inject({ method: 'POST', url: '/test/read', headers: headers('') })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error.message, forbiddenMessage('anas-audit@pve', 'Sys.Audit'))
    assert.deepEqual(lines, [`audit: anas-audit@pve refused ${READ_JOB_OPERATIONS.cloudPreview}: lacks Sys.Audit on / (holds no privilege on /)`])
  })

  it('a missing or garbage privilege header is refused at the identity (401, logged) — fail closed', async () => {
    const cases: Array<[string | undefined, RegExp]> = [
      [undefined, /x-anas-privileges: /],
      ['Sys.Root', /x-anas-privileges: 'Sys.Root' is not a privilege list/],
      ['Sys.Audit,Sys.Audit', /is not a privilege list/],
      ['Sys.Audit, Sys.Modify', /is not a privilege list/],
    ]
    for (const [privileges, re] of cases) {
      lines.length = 0
      const res = await server.inject({ method: 'POST', url: '/test/write', headers: headers(privileges, 'root@pam') })
      assert.equal(res.statusCode, 401, String(privileges))
      assert.match(res.json().error.message, /x-anas-privileges/)
      assert.equal(lines.length, 1, String(privileges))
      assert.match(lines[0]!, /^\[authz\] refused POST \/test\/write: invalid identity headers \(/)
      assert.match(lines[0]!, re)
    }
    assert.deepEqual(queueOf(server).list(), [])
  })

  it('…and refused at the queue (403, logged with the reason) where a route never asked for the identity', async () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'the request carries no x-anas-privileges header'],
      ['yes', 'x-anas-privileges "yes" is not a privilege list'],
    ]
    for (const [privileges, reason] of cases) {
      lines.length = 0
      const res = await server.inject({ method: 'POST', url: '/test/as-boot', headers: headers(privileges, 'root@pam') })
      assert.equal(res.statusCode, 403, String(privileges))
      assert.equal(res.json().error.message, forbiddenMessage('root@pam', 'Sys.Modify'))
      assert.deepEqual(lines, [`audit: root@pam refused ahr.cache.detach: lacks Sys.Modify on / (${reason})`])
    }
  })

  it('a route that builds a system-looking submitter cannot pass a request off as the daemon\'s own work', async () => {
    // The queue asks the REQUEST's privileges, never the submitter's name.
    const res = await server.inject({ method: 'POST', url: '/test/as-boot', headers: headers('Sys.Audit') })
    assert.equal(res.statusCode, 403)
    assert.deepEqual(queueOf(server).list(), [])
  })
})

describe('cr.28 a cancel follows the same rule (Sys.Audit for a read job, Sys.Modify otherwise)', () => {
  let server: Server
  const lines: string[] = []

  beforeEach(() => {
    lines.length = 0
    server = daemon(lines)
  })

  afterEach(async () => {
    await server.close()
  })

  /** A running job with a cancel hook, submitted as the daemon's own work. */
  function running(operation: string): { id: string, stopped: () => boolean } {
    let stop: () => void = () => {}
    let stoppedFlag = false
    const ref = queueOf(server).submit(operation, { user: 'root@pam', uid: 0 }, async (_p, ctx) => {
      ctx.onCancel(async () => {
        stoppedFlag = true
        stop()
      }, { subject: `Job '${operation}'` })
      await new Promise<void>((resolve) => {
        stop = resolve
      })
      return null
    })
    return { id: ref.id, stopped: () => stoppedFlag }
  }

  async function settled(id: string): Promise<Job> {
    for (let i = 0; i < 200; i++) {
      const job = queueOf(server).get(id)!
      if (job.status !== 'queued' && job.status !== 'running')
        return job
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`job ${id} did not settle`)
  }

  async function startedHook(): Promise<void> {
    for (let i = 0; i < 5; i++)
      await new Promise(r => setImmediate(r))
  }

  it('a reader cancels a read job (no confirm); a requester with no privilege may not', async () => {
    const run = running(READ_JOB_OPERATIONS.cloudRemoteTest)
    await startedHook()
    let res = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers('') })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error.message, forbiddenMessage('anas-audit@pve', 'Sys.Audit'))
    assert.equal(run.stopped(), false, 'the refused cancel stopped nothing')
    assert.deepEqual(lines, [`audit: anas-audit@pve refused ${CANCEL_OPERATION}: lacks Sys.Audit on / (holds no privilege on /)`])

    res = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers('Sys.Audit') })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await settled(run.id)).status, 'cancelled')
    assert.equal(run.stopped(), true)
  })

  it('a reader may not cancel a run — refused BEFORE a confirm code is minted; Sys.Modify gets the confirm', async () => {
    const run = running('cloud.task.run')
    await startedHook()
    let res = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers('Sys.Audit') })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error.message, forbiddenMessage('anas-audit@pve', 'Sys.Modify'))
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no confirm code for a requester that may not cancel')
    assert.equal(run.stopped(), false)

    res = await server.inject({ method: 'POST', url: `/v1/jobs/${run.id}/cancel`, headers: headers('Sys.Audit,Sys.Modify', 'root@pam') })
    assert.equal(res.statusCode, 409)
    const code = res.headers['x-anas-confirm-code']
    assert.ok(typeof code === 'string' && code.length > 0)
    res = await server.inject({
      method: 'POST',
      url: `/v1/jobs/${run.id}/cancel`,
      headers: { ...headers('Sys.Audit,Sys.Modify', 'root@pam'), 'x-anas-confirm': code },
    })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await settled(run.id)).status, 'cancelled')
  })
})

describe('cr.28 internal submitters keep working', () => {
  it('the daemon\'s own work (no request: the boot scan, its cache rung and re-attach) is not checked', () => {
    const queue = new JobQueue()
    const ref = queue.submit('ahr.cache.detach', { user: 'system:boot-cache', uid: 0, params: { pool: 'tank', trigger: 'boot' } }, noop)
    assert.equal(ref.operation, 'ahr.cache.detach')
  })

  it('a job body is the daemon\'s own work: a nested submit is not judged by the request that happened to start it', async () => {
    // A reader's read job starts at once (execute is reached synchronously
    // from submit), so without the clear its body would run — and submit —
    // under the reader's Sys.Audit.
    const queue = new JobQueue()
    let nested: unknown = 'not run'
    const reader = readRequestAuthority(headers('Sys.Audit'))
    const ref = runAsRequest(reader, () => queue.submit(READ_JOB_OPERATIONS.cloudPreview, { user: 'anas-audit@pve', uid: -1 }, async () => {
      try {
        nested = queue.submit('pool.scrub', { user: 'system:nested', uid: 0 }, noop).operation
      }
      catch (err) {
        nested = err
      }
      return null
    }))
    for (let i = 0; i < 200 && queue.get(ref.id)!.status !== 'completed'; i++)
      await new Promise(r => setTimeout(r, 5))
    assert.equal(nested, 'pool.scrub')
    // …while the same submit made for the request itself is refused.
    assert.throws(() => runAsRequest(reader, () => queue.submit('pool.scrub', { user: 'anas-audit@pve', uid: -1 }, noop)), /Permission check failed \(\/, Sys\.Modify\)/)
    // runAsDaemon is that clear.
    assert.equal(runAsRequest(reader, () => runAsDaemon(() => queue.submit('pool.scrub', { user: 'system:x', uid: 0 }, noop))).operation, 'pool.scrub')
  })

  describe('over the real socket (the root-only door the runners and the udev script use)', () => {
    let server: Server
    let dir: string
    let sock: string
    const lines: string[] = []

    beforeEach(async () => {
      lines.length = 0
      dir = mkdtempSync(join(tmpdir(), 'anas-bs-'))
      sock = join(dir, 'd.sock')
      server = daemon(lines)
      await server.listen({ path: sock })
    })

    afterEach(async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('the systemd task runners (timers, Run-Now direct runs: runner-poll identity) → 202', async () => {
      const res = await socketRequester(sock)({ method: 'POST', path: '/test/write', headers: identityHeaders(), body: {} })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      assert.equal((res.body as JobAccepted).job.createdBy, 'root@pam')
    })

    it('the udev cache-event script\'s headers, read from the script itself → 202', async () => {
      const script = readFileSync(CACHE_EVENT_SCRIPT, 'utf-8')
      const sent: Record<string, string> = {}
      for (const m of script.matchAll(/--header ['"]([a-z-]+): ([^'"]+)['"]/g))
        sent[m[1]!] = m[2]!
      assert.equal(sent['x-anas-privileges'], 'Sys.Audit,Sys.Modify', 'the script names both privileges')
      sent['x-anas-request-id'] = randomUUID()
      const res = await socketRequester(sock)({ method: 'POST', path: '/test/write', headers: sent, body: {} })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      assert.equal((res.body as JobAccepted).job.createdBy, 'system:udev-cache-event')
    })

    it('a direct socket client with crafted headers gets exactly what its headers claim — the socket\'s permissions decide who may ask', async () => {
      const call = (h: Record<string, string>) => socketRequester(sock)({ method: 'POST', path: '/test/write', headers: { 'content-type': 'application/json', ...h }, body: {} })
      // Claims only Sys.Audit: refused, like the gateway would.
      assert.equal((await call(headers('Sys.Audit', 'mallory@pve'))).statusCode, 403)
      // Claims nothing: refused (no "absent means trusted").
      assert.equal((await call(headers(undefined, 'root@pam'))).statusCode, 401)
      // Claims both: accepted. Nothing in a header can tell a forged claim from
      // the runner's — a caller that can open this socket is root (0600
      // root:root, boot/__tests__/socket-perms.test.ts), and root is beyond
      // any check the daemon could make.
      assert.equal((await call(headers('Sys.Audit,Sys.Modify', 'mallory@pve'))).statusCode, 202)
    })
  })
})
