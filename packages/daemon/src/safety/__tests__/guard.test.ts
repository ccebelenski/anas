import type { Job } from '@anas/shared'
import type { BoundId } from '../confirm.js'
import type { Advisory, Gate, GuardPass, GuardSpec, Refusal } from '../guard.js'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../confirm.js'
import { guardCheck, guardConfirm, guarded, sendRefusal, signedRequest } from '../guard.js'

/**
 * Story cr.32 — the guard mechanism (docs/WAVE3-DESIGN.md §3.2, §5.2, §8.2).
 *
 * The object here is an in-memory record the test mutates between the route
 * door and the job door, which is exactly the window ruling (j) is about. No
 * system output is faked: these tests exercise the mechanism, and the pool
 * route tests (pools-guard.test.ts) drive the same mechanism with captured
 * fixtures.
 */

interface Thing {
  name: string
  guid: string
  rev: string
  members: string[]
}

/** The world the fake view reads — mutated by a test between the doors. */
interface World {
  thing: Thing | null
  refuse: Set<string>
  advisories: Advisory[]
}

/** A named gate that counts its calls and refuses while the world says so. */
function gate(world: World, name: string, calls: string[]): Gate<Thing> {
  return async (t) => {
    calls.push(name)
    return world.refuse.has(name)
      ? { status: 409, code: 'CONFLICT', reason: name, message: `${t.name}: refused by ${name}` }
      : null
  }
}

function makeSpec(world: World, calls: string[], opts: { revision?: boolean, scope?: boolean } = {}): GuardSpec<Thing> {
  return {
    operation: 'thing.destroy',
    object: {
      what: `Thing 'x'`,
      read: async () => (world.thing ? { ...world.thing, members: [...world.thing.members] } : null),
      id: async t => ({ guid: t.guid }),
      ...(opts.revision ? { revision: async (t: Thing) => t.rev } : {}),
      ...(opts.scope ? { scope: async (t: Thing) => ({ members: t.members.join(', ') }) } : {}),
      scopeLabels: { members: 'the members to wipe' },
      unbound: part => `Could not read the ${part} of thing 'x'`,
    },
    gates: [gate(world, 'first', calls), gate(world, 'second', calls), gate(world, 'third', calls)],
    advisories: async () => [...world.advisories],
  }
}

function freshWorld(): World {
  return {
    thing: { name: 'x', guid: '111', rev: 'r1', members: ['disk-a', 'disk-b'] },
    refuse: new Set(),
    advisories: [{ key: 'share:media', warning: `SMB share 'media' uses it` }],
  }
}

/** Run a guarded handler through the REAL queue and return the finished job. */
async function runJob(handler: Parameters<JobQueue['submit']>[2]): Promise<Job> {
  const queue = new JobQueue()
  const ref = queue.submit('thing.destroy', { user: 'root@pam', uid: 0 }, handler)
  for (let i = 0; i < 200; i++) {
    const job = queue.get(ref.id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('job did not finish')
}

async function pass(spec: GuardSpec<Thing>): Promise<GuardPass<Thing>> {
  const pre = await guardCheck(spec)
  assert.ok(!('refusal' in pre), `the route door refused: ${JSON.stringify(pre)}`)
  return pre
}

describe('guard (cr.32): the route door', () => {
  it('runs every gate in order and binds id, revision and scope', async () => {
    const world = freshWorld()
    const calls: string[] = []
    const pre = await pass(makeSpec(world, calls, { revision: true, scope: true }))
    assert.deepEqual(calls, ['first', 'second', 'third'])
    assert.deepEqual(pre.bound, { id: { guid: '111' }, revision: 'r1', scope: { members: 'disk-a, disk-b' } })
    assert.deepEqual(pre.advisories.map(a => a.key), ['share:media'])
  })

  it('answers the first refusing gate and runs none after it', async () => {
    const world = freshWorld()
    world.refuse.add('second')
    const calls: string[] = []
    const pre = await guardCheck(makeSpec(world, calls))
    assert.ok('refusal' in pre)
    assert.equal(pre.refusal.code, 'CONFLICT')
    assert.equal(pre.refusal.reason, 'second')
    assert.deepEqual(calls, ['first', 'second'])
  })

  it('a missing object is 404 NOT_FOUND naming it; an unreadable id refuses the operation', async () => {
    const world = freshWorld()
    world.thing = null
    const gone = await guardCheck(makeSpec(world, []))
    assert.ok('refusal' in gone)
    assert.deepEqual(gone.refusal, { status: 404, code: 'NOT_FOUND', message: `Thing 'x' not found` })

    const world2 = freshWorld()
    const spec = makeSpec(world2, [])
    spec.object.id = async () => null
    const unbound = await guardCheck(spec)
    assert.ok('refusal' in unbound)
    assert.deepEqual(unbound.refusal, { status: 409, code: 'CONFLICT', message: `Could not read the id of thing 'x'` })
  })
})

describe('guard (cr.32): the job door', () => {
  it('re-runs EVERY gate the route ran, then the body', async () => {
    const world = freshWorld()
    const calls: string[] = []
    const spec = makeSpec(world, calls)
    const pre = await pass(spec)
    calls.length = 0
    let bodyRan = false
    const job = await runJob(guarded(spec, pre, async () => {
      bodyRan = true
      return { ok: true }
    }))
    assert.equal(job.status, 'completed')
    assert.deepEqual(calls, ['first', 'second', 'third'], 'the job ran the same gate list as the route')
    assert.equal(bodyRan, true)
  })

  it('a gate that refuses only in the job fails it with the refusal\'s code and sentence; the body never runs', async () => {
    for (const name of ['first', 'second', 'third']) {
      const world = freshWorld()
      const spec = makeSpec(world, [])
      const pre = await pass(spec)
      world.refuse.add(name) // the state changed while the job waited
      let bodyRan = false
      const job = await runJob(guarded(spec, pre, async () => {
        bodyRan = true
      }))
      assert.equal(job.status, 'failed', name)
      assert.deepEqual(job.error, { code: 'CONFLICT', message: `x: refused by ${name}` })
      assert.equal(bodyRan, false, `${name}: the body ran after a refusal`)
    }
  })

  it('a different object under the name fails IDENTITY_MISMATCH; a vanished one too', async () => {
    const world = freshWorld()
    const spec = makeSpec(world, [])
    const pre = await pass(spec)
    world.thing = { ...world.thing!, guid: '222' }
    const swapped = await runJob(guarded(spec, pre, async () => 'acted'))
    assert.equal(swapped.status, 'failed')
    assert.equal(swapped.error?.code, 'IDENTITY_MISMATCH')
    assert.match(swapped.error!.message, /guid 111 at the confirmation, guid 222 now/)

    world.thing = null
    const gone = await runJob(guarded(spec, pre, async () => 'acted'))
    assert.equal(gone.error?.code, 'IDENTITY_MISMATCH')
    assert.match(gone.error!.message, /unreadable now/)
  })

  it('a changed revision fails STATE_CHANGED; an unchanged one passes', async () => {
    const world = freshWorld()
    const spec = makeSpec(world, [], { revision: true })
    const pre = await pass(spec)
    const same = await runJob(guarded(spec, pre, async () => 'acted'))
    assert.equal(same.status, 'completed')

    world.thing = { ...world.thing!, rev: 'r2' }
    const moved = await runJob(guarded(spec, pre, async () => 'acted'))
    assert.equal(moved.status, 'failed')
    assert.equal(moved.error?.code, 'STATE_CHANGED')
  })

  it('a changed scope fails STATE_CHANGED naming both sets', async () => {
    const world = freshWorld()
    const spec = makeSpec(world, [], { scope: true })
    const pre = await pass(spec)
    world.thing = { ...world.thing!, members: ['disk-a', 'disk-b', 'disk-c'] }
    const job = await runJob(guarded(spec, pre, async () => 'acted'))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    // D7: the two sets are separated as `was: …; now: …`, never run together.
    assert.match(job.error!.message, /was: disk-a, disk-b; now: disk-a, disk-b, disk-c\) — nothing was done/)
  })

  it('reports only the advisories the confirm did not list', async () => {
    const world = freshWorld()
    const spec = makeSpec(world, [])
    const pre = await pass(spec)
    world.advisories.push({ key: 'nfs:/x', warning: `NFS export '/x' uses it` })
    let seen: string[] = []
    await runJob(guarded(spec, pre, async (_t, ctx) => {
      seen = ctx.newAdvisories
    }))
    assert.deepEqual(seen, [`NFS export '/x' uses it`])
  })

  it('reguard re-runs the gates against the state NOW and throws the refusal', async () => {
    const world = freshWorld()
    const calls: string[] = []
    const spec = makeSpec(world, calls)
    const pre = await pass(spec)
    const job = await runJob(guarded(spec, pre, async (_t, ctx) => {
      calls.length = 0
      world.refuse.add('third') // something changed mid-job, between two act steps
      await ctx.reguard()
      return 'second step'
    }))
    assert.deepEqual(calls, ['first', 'second', 'third'])
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
  })
})

describe('guard (cr.32): the bound confirm', () => {
  let server: ReturnType<typeof Fastify> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /**
   * A tiny route that runs the guard's route door with the world as it is at
   * each request — what pools.ts does with the real reads.
   */
  async function build(world: World, store = new ConfirmStore(), opts: { revision?: boolean, scope?: boolean, presentationOnly?: Record<string, string> } = {}) {
    const app = Fastify({ logger: false })
    app.post<{ Params: { name: string }, Body: { cleanup?: boolean, note?: string } }>('/things/:name', async (request, reply) => {
      const spec = makeSpec(world, [], opts)
      const pre = await guardCheck(spec)
      if ('refusal' in pre)
        return sendRefusal(reply, pre.refusal)
      const validated = { name: request.params.name, cleanup: request.body?.cleanup ?? false, note: request.body?.note ?? '' }
      if (!guardConfirm(store, request, reply, spec, pre, {
        validated,
        address: ['name'],
        ...(opts.presentationOnly ? { presentationOnly: opts.presentationOnly } : {}),
        message: 'Destroying x',
        warnings: ['it is gone for good'],
      })) {
        return reply
      }
      reply.code(202)
      return { ok: true }
    })
    server = app
    return app
  }

  async function post(app: ReturnType<typeof Fastify>, body: object, code?: string, name = 'x') {
    return app.inject({
      method: 'POST',
      url: `/things/${name}`,
      payload: body,
      headers: code ? { 'x-anas-confirm': code } : {},
    })
  }

  it('a code minted for exactly this request confirms it once', async () => {
    const app = await build(freshWorld())
    const first = await post(app, { cleanup: true })
    assert.equal(first.statusCode, 409)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code'] as string
    assert.equal((await post(app, { cleanup: true }, code)).statusCode, 202)
    assert.equal((await post(app, { cleanup: true }, code)).json().error.code, 'CONFIRMATION_REQUIRED', 'single-use')
  })

  it('an omitted flag and its explicit default sign the same', async () => {
    const app = await build(freshWorld())
    const code = (await post(app, {})).headers['x-anas-confirm-code'] as string
    assert.equal((await post(app, { cleanup: false }, code)).statusCode, 202)
  })

  it('a resend with a different flag is 409 CONFIRM_SCOPE_CHANGED naming the field, with a fresh code', async () => {
    const app = await build(freshWorld())
    const first = await post(app, { cleanup: false })
    const code = first.headers['x-anas-confirm-code'] as string
    const res = await post(app, { cleanup: true }, code)
    assert.equal(res.statusCode, 409)
    const body = res.json()
    assert.equal(body.error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(body.error.changed, ['cleanup'])
    assert.equal(body.error.message, 'You confirmed with cleanup off; this request has cleanup on — confirm again')
    assert.equal(body.error.warnings[0], body.error.message)
    assert.ok(body.error.warnings.includes('it is gone for good'))
    const fresh = res.headers['x-anas-confirm-code'] as string
    assert.ok(fresh && fresh !== code)
    // The old code was consumed; the fresh one confirms the request it was minted for.
    assert.equal((await post(app, { cleanup: false }, code)).json().error.code, 'CONFIRMATION_REQUIRED')
    assert.equal((await post(app, { cleanup: true }, fresh)).statusCode, 202)
  })

  it('every field is bound unless named presentation-only', async () => {
    const app = await build(freshWorld())
    const code = (await post(app, { note: 'a' })).headers['x-anas-confirm-code'] as string
    const res = await post(app, { note: 'b' }, code)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['note'])

    await server!.close()
    const app2 = await build(freshWorld(), new ConfirmStore(), { presentationOnly: { note: 'a free-text label the act never reads' } })
    const code2 = (await post(app2, { note: 'a' })).headers['x-anas-confirm-code'] as string
    assert.equal((await post(app2, { note: 'b' }, code2)).statusCode, 202)
  })

  it('signedRequest drops exactly the presentation-only fields', () => {
    assert.deepEqual(signedRequest({ a: 1, b: 2, c: 3 }, { b: 'why' }), { a: 1, c: 3 })
    assert.deepEqual(signedRequest({ a: 1 }), { a: 1 })
  })

  it('a different object under the name is IDENTITY_MISMATCH naming both ids', async () => {
    const world = freshWorld()
    const app = await build(world)
    const code = (await post(app, {})).headers['x-anas-confirm-code'] as string
    world.thing = { ...world.thing!, guid: '222' }
    const res = await post(app, {}, code)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.deepEqual(res.json().error.confirmed, { guid: '111' })
    assert.deepEqual(res.json().error.current, { guid: '222' })
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('a changed scope between challenge and resend is CONFIRM_SCOPE_CHANGED naming it', async () => {
    const world = freshWorld()
    const app = await build(world, new ConfirmStore(), { scope: true })
    const code = (await post(app, { cleanup: true })).headers['x-anas-confirm-code'] as string
    world.thing = { ...world.thing!, members: ['disk-a', 'disk-b', 'disk-c'] }
    const res = await post(app, { cleanup: true }, code)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['members'])
    assert.match(res.json().error.message, /the members to wipe changed since you confirmed \(was: disk-a, disk-b; now: disk-a, disk-b, disk-c\)/)
  })

  it('a changed revision between challenge and resend is STATE_CHANGED', async () => {
    const world = freshWorld()
    const app = await build(world, new ConfirmStore(), { revision: true })
    const code = (await post(app, {})).headers['x-anas-confirm-code'] as string
    world.thing = { ...world.thing!, rev: 'r2' }
    const res = await post(app, {}, code)
    assert.equal(res.json().error.code, 'STATE_CHANGED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('a code minted for another object is a plain new challenge, and is not consumed', async () => {
    const store = new ConfirmStore()
    const app = await build(freshWorld(), store)
    const code = (await post(app, {})).headers['x-anas-confirm-code'] as string
    const other = await post(app, {}, code, 'y')
    assert.equal(other.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.equal((await post(app, {}, code)).statusCode, 202, 'still good for the object it was minted for')
  })

  it('a gate refusal at the route is its own status and code, with no confirm code', async () => {
    const world = freshWorld()
    world.refuse.add('first')
    const app = await build(world)
    const res = await post(app, {})
    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.json(), { error: { code: 'CONFLICT', message: 'x: refused by first', reason: 'first' } })
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })
})

/** Type-level: a refusal is the shape both doors use. */
const _shape: Refusal = { status: 503, code: 'TIMEOUT', message: 'a read did not answer' }
const _id: BoundId = { guid: '1' }
void _shape
void _id
