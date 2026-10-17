import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/** Poll a job until it reaches a terminal state. */
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

/** Wrap the mock executor so we can inspect the exact command/args issued. */
function spyExecutor(server: ReturnType<typeof createServer>): Array<{ command: string, args: string[] }> {
  const mock = (server as any).executor as MockExecutor
  const calls: Array<{ command: string, args: string[] }> = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return calls
}

function importCall(calls: Array<{ command: string, args: string[] }>): string[] | undefined {
  // The scan uses ['import']; the actual import has a target after 'import'.
  // cr.52r D4 imports `-N` FIRST (no mount), then on success exports and
  // re-imports — the FIRST import call with a target is the pinned `-N` one.
  return calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'import' && c.args.length > 1)?.args
}

function zpoolCalls(calls: Array<{ command: string, args: string[] }>): string[][] {
  return calls.filter(c => c.command === '/usr/sbin/zpool').map(c => c.args)
}

describe('import pool endpoint: /v1/pools/import', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('GET scans and returns the importable pool list', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({ method: 'GET', url: '/v1/pools/import' })

    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: Array<{ name: string, guid: string, state: string }> }
    assert.equal(data.length, 1)
    assert.deepEqual(data[0], {
      name: 'oldtank',
      guid: '9876543210987654321',
      state: 'ONLINE',
    })
  })

  it('POST with a name returns 202, completes, and builds import args', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank' }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.import')
    assert.equal(body.job.createdBy, 'root@pam')

    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')

    // cr.52r D4 — the pinned argv sequence: `-N` import (no mount), then on
    // success export + a mounted `import` (so ZFS mounts the pool's datasets
    // exactly as the single import always did).
    assert.deepEqual(importCall(calls), ['import', '-N', '--', 'oldtank'])
    assert.deepEqual(zpoolCalls(calls).filter(c => c[0] === 'export'), [['export', 'oldtank']])
    assert.deepEqual(zpoolCalls(calls).filter(c => c[0] === 'import' && c.includes('oldtank')), [
      ['import', '-N', '--', 'oldtank'],
      ['import', '--', 'oldtank'],
    ])
  })

  it('POST with force without a confirm code is a 409 naming the cross-host risk, and no zpool command runs (cr.12)', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank', force: true }),
    })

    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, warnings?: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'a confirm code is offered for the resend')
    assert.ok(
      body.error.warnings?.some(w => w.includes('active on another host')),
      `the corruption warning names the cross-host risk: ${JSON.stringify(body.error.warnings)}`,
    )
    assert.equal(importCall(calls), undefined, 'force without a confirm never reaches zpool')
  })

  it('POST with force resent with the confirm code proceeds, and the argv carries -f (cr.12)', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank', force: true }),
    })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank', force: true }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
    // The `-f` rides BOTH imports (the -N gate and the mounted re-import).
    assert.deepEqual(importCall(calls), ['import', '-N', '-f', '--', 'oldtank'])
    assert.deepEqual(zpoolCalls(calls).filter(c => c[0] === 'import' && c.includes('oldtank')), [
      ['import', '-N', '-f', '--', 'oldtank'],
      ['import', '-f', '--', 'oldtank'],
    ])
  })

  it('rejects a hostile pool name with 400 and no zpool command (cr.12)', async () => {
    // '-aDf' would read as zpool import's own flags (-a -D -f) if it ever
    // reached argv unvalidated — the schema refuses it at the boundary.
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: '-aDf' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(importCall(calls), undefined)
    assert.equal(calls.filter(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'import' && c.args.length > 1).length, 0)
  })

  it('rejects a guid that is not decimal digits with 400 (cr.12)', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ guid: '1 2' }),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(importCall(calls), undefined)
  })

  it('POST with a guid imports by numeric identifier', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ guid: '9876543210987654321' }),
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    await waitForJob(server, body.job.id)

    assert.deepEqual(importCall(calls), ['import', '-N', '--', '9876543210987654321'])
  })

  it('refuses an import with altroot on a protected path — the ONE 409, no zpool command (cr.52r D4)', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank', altroot: '/etc' }),
    })

    assert.equal(res.statusCode, 409, res.body)
    const err = res.json().error
    assert.equal(err.code, 'CONFLICT')
    assert.equal(err.reason, 'system-mount-target')
    assert.match(err.message, /system path|protected|PVE/)
    assert.equal(importCall(calls), undefined, 'no zpool command ever ran')
  })

  it('a stored mountpoint on a protected path fails the job AFTER `-N` and BEFORE any mount, exporting the pool again (cr.52r D4)', async () => {
    server = createServer({ mock: true, logger: false })
    // The imported pool's own stored mountpoint — knowable only once imported —
    // answers on a protected path. Override the exact `zfs get` read the job
    // gates against.
    ;(server as unknown as { executor: { addFixture: (f: object) => void } }).executor.addFixture({
      command: '/usr/sbin/zfs',
      args: ['get', '-H', '-r', '-o', 'name,value', 'mountpoint', '--', 'oldtank'],
      result: { stdout: 'oldtank\t/mnt/pve/oldtank\n', stderr: '', exitCode: 0 },
    })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank' }),
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)

    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.match(job.error!.message, /protected or system path/)
    assert.match(job.error!.message, /exported again/)
    // The pinned argv: the `-N` import ran, the refusal exported the pool, and
    // the MOUNTED re-import (without -N) NEVER ran — nothing was mounted.
    assert.deepEqual(importCall(calls), ['import', '-N', '--', 'oldtank'])
    assert.deepEqual(zpoolCalls(calls).filter(c => c[0] === 'export'), [['export', 'oldtank']])
    assert.ok(!zpoolCalls(calls).some(c => c[0] === 'import' && !c.includes('-N')), 'the mounted import never ran')
  })

  it('returns 400 when neither name nor guid is given', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank' }),
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })
})
