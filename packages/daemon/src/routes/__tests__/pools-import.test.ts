import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** The disks the create-behind-import test needs the inventory to serve as blank. */
const ALL_DISKS = ['d1', 'd2']

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
    // cr.70 (b): the gate read must NAME the pool root's mountpoint (an exit-0
    // read that sees nothing refuses); the dev mock seeds that read for
    // oldtank (server.ts), so a completing import answers the gate here.
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
    // cr.70 (b): the gate read must NAME the pool root's mountpoint (an exit-0
    // read that sees nothing refuses); the dev mock seeds that read for
    // oldtank (server.ts), so a completing import answers the gate here.
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

  it('a failing first `zpool list` refuses the import JOB 503 UNAVAILABLE naming the read — nothing imported (cr.52s-b (1))', async () => {
    server = createServer({ mock: true, logger: false })
    // The pinned cr.64b2-i failure line (`zpool: cannot read configuration:
    // access denied`, exit 127) is exactly what `zpool list` prints when the
    // config cannot be read — it refuses the by-guid SCAN door there and the
    // import's own BEFORE listing here. The listing happens inside the job (the
    // guarded body), so the refusal is the JOB's, before the `-N` import runs.
    const executor = (server as unknown as { executor: MockExecutor }).executor
    executor.prependFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: { stdout: '', stderr: 'zpool: cannot read configuration: access denied', exitCode: 127 } })
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
    assert.equal(job.error!.code, 'UNAVAILABLE')
    assert.match(job.error!.message, /the currently imported pools could not be listed for the import of 'oldtank'/)
    assert.match(job.error!.message, /zpool: cannot read configuration: access denied/)
    // Nothing imported — the -N gate import never ran.
    assert.equal(importCall(calls), undefined, 'no zpool import with a target ever ran')
  })

  it('a stored mountpoint on a protected path fails the job AFTER `-N` and BEFORE any mount, exporting the pool again (cr.52r D4)', async () => {
    server = createServer({ mock: true, logger: false })
    // The imported pool's own stored mountpoint — knowable only once imported —
    // answers on a protected path. Override the exact `zfs get` read the job
    // gates against: the dev mock seeds the same read at a SAFE mountpoint
    // (server.ts, cr.70 (b)) and fixtures are first-wins, so this one PREPENDS.
    ;(server as unknown as { executor: { prependFixture: (f: object) => void } }).executor.prependFixture({
      command: '/usr/sbin/zfs',
      // cr.52s-b (5): `canmount` rides the same read — a row per property.
      args: ['get', '-H', '-r', '-o', 'name,property,value', 'mountpoint,canmount', '--', 'oldtank'],
      result: { stdout: 'oldtank\tmountpoint\t/mnt/pve/oldtank\noldtank\tcanmount\ton\n', stderr: '', exitCode: 0 },
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

/**
 * cr.64b2-i (P): an import by GUID holds the NAME the pool will carry beside
 * the guid key. The name comes from the `zpool import` scan the GET scanner
 * reads (`parseImportScan`); the dev mock's own scan names `oldtank` for guid
 * 9876543210987654321 (packages/daemon/src/server.ts, the pinned dev-mock
 * answer the commit extends), so the by-guid import must hold `zname:oldtank`
 * exclusive beside `zpool:9876543210987654321` — a create of that name queues
 * behind it. An unreadable scan refuses 503 at the door, never "no name".
 */
describe('cr.64b2-i — the by-guid import\'s name key', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /**
   * Pause every real `zpool import <target>` exec (never the one-arg scan) on
   * ONE gate: the first `-N` import stalls the job while its locks are held,
   * and once the gate is opened every later exec (the mounted re-import)
   * passes without re-pausing.
   */
  function pauseImportExecs(): { importExecs: () => number, release: () => void } {
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    let count = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
      if (command === '/usr/sbin/zpool' && args.length > 1 && args[0] === 'import') {
        count++
        await gate
      }
      return orig(command, args)
    }
    return { importExecs: () => count, release: () => release() }
  }

  async function untilSatisfied(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (cond())
        return
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('holds zpool:<guid> AND the scanned zname:<name> exclusive while it runs — no name key, a same-name create would not serialise', async () => {
    server = createServer({ mock: true, logger: false })
    const paused = pauseImportExecs()

    const res = await server.inject({ method: 'POST', url: '/v1/pools/import', headers: JSON_HEADERS, payload: JSON.stringify({ guid: '9876543210987654321' }) })
    assert.equal(res.statusCode, 202, res.body)
    const importId = (res.json() as JobAccepted).job.id

    // The `-N` import is paused mid-run: the guid key AND the scanned name key
    // are held. (The job then fails on the unmocked `zfs get` of the pool's
    // stored mountpoints — the same end the existing by-guid test runs to.)
    await untilSatisfied(() => paused.importExecs() > 0, 'the -N import exec')
    assert.deepEqual(paused.importExecs(), 1)
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      ['zpool:9876543210987654321', 'exclusive'],
      ['zname:oldtank', 'exclusive'],
    ])
    assert.equal(queue().get(importId)?.status, 'running')

    paused.release()
    await waitForJob(server, importId)
  })

  it('a create of the scanned name queues behind the by-guid import: "waiting for zpool.import (job …) on the pool name"', async () => {
    server = createServer({ mock: true, logger: false })
    serveBlankInventoryDisks(server, ALL_DISKS)
    const paused = pauseImportExecs()

    const importRes = await server.inject({ method: 'POST', url: '/v1/pools/import', headers: JSON_HEADERS, payload: JSON.stringify({ guid: '9876543210987654321' }) })
    assert.equal(importRes.statusCode, 202, importRes.body)
    const importId = (importRes.json() as JobAccepted).job.id
    await untilSatisfied(() => paused.importExecs() > 0, 'the -N import exec')

    // The create of the pool's scanned name claims `zname:oldtank` — the very
    // key the import holds — so it waits, naming the import (cr.33 §4.1).
    // The progress line names the job's OPERATION (`zpool.import`, per §4.1):
    // the same line the queue writes for any job waiting behind another.
    const createRes = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'oldtank', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }] }),
    })
    assert.equal(createRes.statusCode, 202, createRes.body)
    const createId = (createRes.json() as JobAccepted).job.id
    await untilSatisfied(() => queue().get(createId)?.progress?.includes(`waiting for zpool.import (job ${importId}) on the pool name 'oldtank'`) === true, 'the create waiting behind the import')
    assert.deepEqual(queue().get(createId)?.status, 'queued')

    paused.release()
    await waitForJob(server, importId)
    const created = await waitForJob(server, createId)
    assert.equal(created.status, 'completed', `the create ran once the import's name key was released: ${JSON.stringify(created.error)}`)
  })

  it('a by-guid import whose post-`-N` listing cannot be read exports (checked) and refuses UNAVAILABLE naming the read — no mounted import without a gate read (cr.52s-b (3))', async () => {
    server = createServer({ mock: true, logger: false })
    const executor = (server as unknown as { executor: MockExecutor }).executor
    // The BEFORE listing reads the dev-mock captured zpool-list.json (testpool);
    // the AFTER listing fails with the pinned cr.64b2-i "cannot read
    // configuration" line. The by-guid import has no req.name to fall back to:
    // the exported pool is the name the `zpool import` scan predicted (oldtank).
    executor.prependFixture({
      command: '/usr/sbin/zpool',
      args: ['list', '-j'],
      results: [mockFixtures.zpoolList(), { stdout: '', stderr: 'zpool: cannot read configuration: access denied', exitCode: 127 }],
    })
    const calls = spyExecutor(server)

    const res = await server.inject({ method: 'POST', url: '/v1/pools/import', headers: JSON_HEADERS, payload: JSON.stringify({ guid: '9876543210987654321' }) })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)

    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error!.code, 'UNAVAILABLE')
    assert.match(job.error!.message, /could not be listed after importing by guid 9876543210987654321/)
    assert.match(job.error!.message, /zpool: cannot read configuration: access denied/)
    // The imported-unmounted pool was exported again — the CHECKED undo ran.
    assert.deepEqual(zpoolCalls(calls).filter(c => c[0] === 'export'), [['export', 'oldtank']])
    // Only the -N gate import ever ran; the mounted re-import NEVER did.
    assert.deepEqual(importCall(calls), ['import', '-N', '--', '9876543210987654321'])
    assert.ok(!zpoolCalls(calls).some(c => c[0] === 'import' && c.includes('oldtank') && !c.includes('-N')), 'no mounted import of oldtank')
  })

  it('an unreadable import scan refuses the by-guid import 503 UNAVAILABLE — no job, no zpool import', async () => {
    server = createServer({ mock: true, logger: false })
    const executor = (server as unknown as { executor: MockExecutor }).executor
    executor.prependFixture({ command: '/usr/sbin/zpool', args: ['import'], result: { stdout: '', stderr: 'zpool: cannot read configuration: access denied', exitCode: 127 } })
    const calls = spyExecutor(server)

    const res = await server.inject({ method: 'POST', url: '/v1/pools/import', headers: JSON_HEADERS, payload: JSON.stringify({ guid: '9876543210987654321' }) })
    assert.equal(res.statusCode, 503, res.body)
    const err = res.json() as { error: { code: string, message: string } }
    assert.equal(err.error.code, 'UNAVAILABLE')
    assert.match(err.error.message, /importable pools could not be listed/)
    assert.match(err.error.message, /9876543210987654321/)
    assert.equal(importCall(calls), undefined, 'no zpool import with a target ever ran')
    assert.deepEqual(queue().heldLocks(), [], 'the refused door took no lock')
    assert.ok(!zpoolCalls(calls).some(c => c[0] === 'import' && c.length > 1), 'no import argv at all')
  })
})
