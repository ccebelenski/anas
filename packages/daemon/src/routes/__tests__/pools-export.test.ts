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

describe('export endpoint: POST /v1/pools/:name/export', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(Array.isArray(res.json().error.warnings) && res.json().error.warnings.length > 0)
    assert.ok(res.headers['x-anas-confirm-code'])
    assert.ok(res.headers['x-anas-confirm-expires'])
  })

  it('proceeds to 202 when resent with a valid confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.export')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('rejects a wrong confirm code with 409 and a fresh code', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'bogus-code' },
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('rejects a reused (single-use) confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(accepted.statusCode, 202)

    const reused = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(reused.statusCode, 409)
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/export',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })
})

describe('pools.r1 — export disables the pool boot-import unit (review M6 #22)', () => {
  const SYSTEMCTL = '/usr/bin/systemctl'
  const OK = { stdout: '', stderr: '', exitCode: 0 }

  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function attach(): MockExecutor {
    server = createServer({ mock: true, logger: false })
    return (server as unknown as { executor: MockExecutor }).executor
  }

  /** Challenge → confirm → 202, then wait for the job to finish. */
  async function runExport(pool = 'testpool'): Promise<Job> {
    const first = await server!.inject({
      method: 'POST',
      url: `/v1/pools/${pool}/export`,
      headers: IDENTITY_HEADERS,
    })
    const res = await server!.inject({
      method: 'POST',
      url: `/v1/pools/${pool}/export`,
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(server!, (res.json() as JobAccepted).job.id)
  }

  it('a successful export disables zfs-import@<pool>.service AFTER the pool is exported', async () => {
    const mock = attach()
    mock.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@testpool.service'], result: OK })

    const job = await runExport()
    assert.equal(job.status, 'completed')
    assert.equal(job.result, null, 'no warnings when the disable succeeded')

    // The order is the point: disabling before the export would leave a pool
    // that IS imported without its unit (the audit #22 bug in the other
    // direction). An export failure returns early and must skip the disable.
    const exportIdx = mock.calls.findIndex(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'export')
    const disableIdx = mock.calls.findIndex(c => c.command === SYSTEMCTL && c.args.join(' ') === 'disable zfs-import@testpool.service')
    assert.ok(exportIdx >= 0, 'zpool export ran')
    assert.ok(disableIdx > exportIdx, 'systemctl disable runs strictly after zpool export')
  })

  it('a failed export disables nothing — no systemctl call at all', async () => {
    const mock = attach()
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) =>
      command === '/usr/sbin/zpool' && args[0] === 'export'
        ? { stdout: '', stderr: 'cannot export \'testpool\': pool is busy\n', exitCode: 1 }
        : orig(command, args)

    const job = await runExport()
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', /pool is busy/)
    assert.equal(mock.calls.find(c => c.command === SYSTEMCTL), undefined, 'no systemctl after a failed export')
  })

  it('a failing disable leaves the job completed with the warning in its result', async () => {
    const mock = attach()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: 'Failed to disable unit: Transaction check failed.\n', exitCode: 1 } })

    const job = await runExport()
    assert.equal(job.status, 'completed', 'the pool is exported — a unit hiccup never fails the job')
    const result = job.result as { warnings?: string[] } | null
    assert.ok(Array.isArray(result?.warnings) && result!.warnings.length === 1)
    assert.match(result!.warnings[0], /Could not disable zfs-import@testpool\.service/)
    assert.match(result!.warnings[0], /Failed to disable unit: Transaction check failed/)
  })

  it('a pool name needing systemd escaping uses zfsImportUnitName\'s escaped unit', async () => {
    const mock = attach()
    // Exact-args fixture: a wrong (unescaped) unit name would not match and
    // the call would hit the default 127, warning the job — caught below.
    mock.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@my\\x2dpool.service'], result: OK })
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      // The mock inventory only knows testpool; give my-pool a listing and a
      // stable guid so the ident.1 gate passes.
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'get -H -o value guid -- my-pool')
        return { stdout: '17897551794000000001\n', stderr: '', exitCode: 0 }
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'list -j') {
        const base = await orig(command, args)
        const json = JSON.parse(base.stdout) as { pools: Record<string, unknown> }
        json.pools['my-pool'] = { name: 'my-pool', state: 'ONLINE', properties: {} }
        return { ...base, stdout: JSON.stringify(json) }
      }
      return orig(command, args)
    }

    const job = await runExport('my-pool')
    assert.equal(job.status, 'completed')
    assert.equal(job.result, null)
    assert.deepEqual(
      mock.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args),
      [['disable', 'zfs-import@my\\x2dpool.service']],
    )
  })
})

describe('ident.1 — pool export binds the pool guid', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Successive guid reads; `null` = the read fails (`zpool get` exits 1). */
  function serveWithGuids(guids: (string | null)[]): { calls: string[][] } {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    const calls: string[][] = []
    mock.exec = async (command: string, args: string[]) => {
      calls.push(args)
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'get -H -o value guid -- testpool') {
        const guid = guids.length > 1 ? guids.shift() : guids[0]
        return guid === null
          ? { stdout: '', stderr: 'cannot open \'testpool\': I/O error', exitCode: 1 }
          : { stdout: `${guid}\n`, stderr: '', exitCode: 0 }
      }
      return orig(command, args)
    }
    return { calls }
  }

  const exportReq = (code?: string) => server!.inject({
    method: 'POST',
    url: '/v1/pools/testpool/export',
    headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', ...(code ? { 'x-anas-confirm': code } : {}) },
    payload: '{}',
  })

  it('a pool swapped under the same name between challenge and resend → 409 IDENTITY_MISMATCH', async () => {
    const { calls } = serveWithGuids(['10', '20'])
    const first = await exportReq()
    assert.equal(first.statusCode, 409)
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.match(res.json().error.message, /guid 10 at the confirmation, guid 20 now/)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('the guid cannot be read at the gate → 409 CONFLICT, no confirm code, nothing exported', async () => {
    const { calls } = serveWithGuids([null])
    const res = await exportReq()
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /Could not read the guid of pool 'testpool' — refusing an export that cannot be bound to it/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('the guid cannot be read when the job runs → the job fails IDENTITY_MISMATCH and exports nothing', async () => {
    const { calls } = serveWithGuids(['10', '10', null])
    const first = await exportReq()
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.match(job.error?.message ?? '', /guid 10 at the confirmation, unreadable now/)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('a swap while the job is queued → the job fails IDENTITY_MISMATCH and exports nothing', async () => {
    const { calls } = serveWithGuids(['10', '10', '30'])
    const first = await exportReq()
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })
})
