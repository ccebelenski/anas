/**
 * Story cr.44 (docs/WAVE3-DESIGN.md §5.3): the confirm window re-challenges a
 * BOUND option in place — ticking "Clean up disks", "Recursive" or "Force"
 * re-sends the UNCONFIRMED request with the new value and swaps in the
 * daemon's new warnings and code. That is only safe while the three verbs'
 * confirm is UNCONDITIONAL: an unconfirmed request must never act, whatever
 * the bound flag says. This file pins that precondition for every value of
 * the flag on the three routes (so a later change that makes one of them
 * conditional fails here before the UI can act on a re-challenge), and the
 * parse the UI relies on when it spells the default out (`?cleanup=false`
 * reads as false, never as "present ⇒ true").
 */
import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'

/**
 * Every query form the flag can arrive in: absent, the UI's explicit default,
 * both truthy spellings the routes accept, spellings they do not, an empty
 * value, and a repeated key (Fastify hands that over as an array).
 */
const FLAG_FORMS: { label: string, qs: (k: string) => string }[] = [
  { label: 'absent', qs: () => '' },
  { label: 'false', qs: k => `?${k}=false` },
  { label: '0', qs: k => `?${k}=0` },
  { label: 'true', qs: k => `?${k}=true` },
  { label: '1', qs: k => `?${k}=1` },
  { label: 'TRUE', qs: k => `?${k}=TRUE` },
  { label: 'yes', qs: k => `?${k}=yes` },
  { label: 'empty', qs: k => `?${k}=` },
  { label: 'bare key', qs: k => `?${k}` },
  { label: 'repeated true,false', qs: k => `?${k}=true&${k}=false` },
  { label: 'repeated true,true', qs: k => `?${k}=true&${k}=true` },
]

interface BoundRoute {
  name: string
  method: 'DELETE' | 'POST'
  url: string
  flag: string
  operation: string
  /** A recorded call that would mean the verb ACTED. */
  acted: (c: { command: string, args: string[] }) => boolean
}

const ROUTES: BoundRoute[] = [
  {
    name: 'pool destroy',
    method: 'DELETE',
    url: '/v1/pools/testpool',
    flag: 'cleanup',
    operation: 'zpool.destroy',
    acted: c => (c.command === ZPOOL && (c.args[0] === 'destroy' || c.args[0] === 'labelclear'))
      || c.command === WIPEFS || c.command === SGDISK,
  },
  {
    name: 'dataset destroy',
    method: 'DELETE',
    url: '/v1/pools/testpool/datasets/media',
    flag: 'recursive',
    operation: 'zfs.destroy',
    acted: c => c.command === ZFS && c.args[0] === 'destroy',
  },
  {
    name: 'snapshot rollback',
    method: 'POST',
    url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback',
    flag: 'force',
    operation: 'zfs.rollback',
    acted: c => c.command === ZFS && c.args[0] === 'rollback',
  },
]

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

function executorOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

describe('cr.44: no confirm code ⇒ 409, for every value of the bound option', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  for (const route of ROUTES) {
    for (const form of FLAG_FORMS) {
      it(`${route.name}: ${route.flag} ${form.label} without a code → 409 CONFIRMATION_REQUIRED with a code, nothing run, no job`, async () => {
        server = createServer({ mock: true, logger: false })
        const mock = executorOf(server)

        const res = await server.inject({
          method: route.method,
          url: route.url + form.qs(route.flag),
          headers: IDENTITY_HEADERS,
        })

        assert.equal(res.statusCode, 409, res.body)
        assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
        assert.ok(res.headers['x-anas-confirm-code'], 'a code the window can swap in')
        assert.ok(Array.isArray(res.json().error.warnings) && res.json().error.warnings.length > 0)

        // Let anything that might have been queued run, then prove nothing was.
        await new Promise(resolve => setTimeout(resolve, 20))
        const acted = mock.calls.filter(route.acted)
        assert.deepEqual(acted, [], `the unconfirmed request ran ${JSON.stringify(acted)}`)
        const jobs = await server.inject({ method: 'GET', url: '/v1/jobs', headers: IDENTITY_HEADERS })
        const ours = (jobs.json() as { data: Job[] }).data.filter(j => j.operation === route.operation)
        assert.deepEqual(ours, [], 'no job was submitted')
      })
    }
  }
})

describe('cr.44: the explicit default the UI sends parses as false', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Challenge then confirm `url` (each with the code its own challenge minted); return the finished job. */
  async function confirmed(url: string, method: 'DELETE' | 'POST'): Promise<Job> {
    const first = await server!.inject({ method, url, headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    const res = await server!.inject({ method, url, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob(server!, (res.json() as JobAccepted).job.id)
  }

  it('pool destroy: ?cleanup=false destroys without wiping a disk; ?cleanup=true wipes', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = executorOf(server)
    const job = await confirmed('/v1/pools/testpool?cleanup=false', 'DELETE')
    assert.equal(job.status, 'completed')
    assert.ok(mock.calls.some(c => c.command === ZPOOL && c.args[0] === 'destroy'), 'the pool was destroyed')
    const wipes = mock.calls.filter(c => (c.command === ZPOOL && c.args[0] === 'labelclear') || c.command === WIPEFS || c.command === SGDISK)
    assert.deepEqual(wipes, [], 'cleanup=false wiped nothing')

    await server.close()
    server = createServer({ mock: true, logger: false })
    const mock2 = executorOf(server)
    const job2 = await confirmed('/v1/pools/testpool?cleanup=true', 'DELETE')
    assert.equal(job2.status, 'completed')
    assert.ok(mock2.calls.some(c => c.command === ZPOOL && c.args[0] === 'labelclear'), 'cleanup=true wiped the members')
  })

  it('pool destroy: the wipe warning is in the challenge exactly when cleanup is on (what the re-challenge swaps in)', async () => {
    const srv = createServer({ mock: true, logger: false })
    server = srv
    const WIPE = /disks will be wiped clean/
    for (const [qs, want] of [['', false], ['?cleanup=false', false], ['?cleanup=true', true]] as const) {
      const res = await srv.inject({ method: 'DELETE', url: `/v1/pools/testpool${qs}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      const warnings = res.json().error.warnings as string[]
      assert.equal(warnings.some(w => WIPE.test(w)), want, `${qs || '(absent)'}: ${warnings.join(' | ')}`)
    }
  })

  it('pool destroy: the re-challenged code confirms the request it was minted for', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = executorOf(server)
    // The window's sequence: the first request (explicit default), then the
    // re-challenge after the box is ticked, then the resend with THAT code.
    const first = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool?cleanup=false', headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const again = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool?cleanup=true', headers: IDENTITY_HEADERS })
    assert.equal(again.statusCode, 409)
    const code = again.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    assert.notEqual(code, first.headers['x-anas-confirm-code'])
    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool?cleanup=true', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.ok(mock.calls.some(c => c.command === ZPOOL && c.args[0] === 'labelclear'))
  })

  it('dataset destroy: ?recursive=false runs `zfs destroy` without -r; ?recursive=true with it', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = executorOf(server)
    await confirmed('/v1/pools/testpool/datasets/media?recursive=false', 'DELETE')
    const plain = mock.calls.filter(c => c.command === ZFS && c.args[0] === 'destroy')
    assert.deepEqual(plain.map(c => c.args), [['destroy', '--', 'testpool/media']])

    await server.close()
    server = createServer({ mock: true, logger: false })
    const mock2 = executorOf(server)
    await confirmed('/v1/pools/testpool/datasets/media?recursive=true', 'DELETE')
    const rec = mock2.calls.filter(c => c.command === ZFS && c.args[0] === 'destroy')
    assert.deepEqual(rec.map(c => c.args), [['destroy', '-r', '--', 'testpool/media']])
  })

  it('rollback: ?force=false runs `zfs rollback` without -r; ?force=true with it', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = executorOf(server)
    await confirmed('/v1/pools/testpool/datasets/media/snapshots/snap1/rollback?force=false', 'POST')
    const plain = mock.calls.filter(c => c.command === ZFS && c.args[0] === 'rollback')
    assert.deepEqual(plain.map(c => c.args), [['rollback', '--', 'testpool/media@snap1']])

    await server.close()
    server = createServer({ mock: true, logger: false })
    const mock2 = executorOf(server)
    await confirmed('/v1/pools/testpool/datasets/media/snapshots/snap1/rollback?force=true', 'POST')
    const forced = mock2.calls.filter(c => c.command === ZFS && c.args[0] === 'rollback')
    assert.deepEqual(forced.map(c => c.args), [['rollback', '-r', '--', 'testpool/media@snap1']])
  })
})
