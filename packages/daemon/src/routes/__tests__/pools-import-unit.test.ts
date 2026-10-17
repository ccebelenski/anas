import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { jobRoutes } from '../jobs.js'
import { poolRoutes } from '../pools.js'
import { serveBlankInventoryDisksOn } from './inventory-stub.js'
import { capturedRootMountTable } from './pool-guard-reads.js'

/**
 * Boot-import unit parity (issue #22). ANAS used to rely on /etc/zfs/zpool.cache
 * alone, which is intermittently unreliable on PVE — the pool is simply gone
 * after a reboot. PVE solved this in PVE/API2/Disks/ZFS.pm (their fix for
 * Proxmox bug #2554) by ALSO enabling `zfs-import@<pool>.service` on create and
 * disabling it on destroy. These tests pin that ANAS does the same on all three
 * mutations, and that a systemctl hiccup warns instead of failing the job.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

/**
 * cr.52r D4: the import job reads the imported pool's stored mountpoints with
 * `zfs get -H -r -o name,property,value mountpoint,canmount <pool>` (cr.52s-b
 * (5)) — a safe effective mountpoint (`/tank`, under `/mnt`, not `/mnt/pve`)
 * lets the import proceed; its dataset's `canmount` row rides the same read.
 */
function zfsStoredMountpoints(pool: string): { command: string, args: string[], result: ExecResult } {
  return {
    command: ZFS,
    args: ['get', '-H', '-r', '-o', 'name,property,value', 'mountpoint,canmount', '--', pool],
    result: {
      stdout: `${pool}\tmountpoint\t/mnt/anas-${pool}\n${pool}\tcanmount\ton\n`,
      stderr: '',
      exitCode: 0,
    },
  }
}

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/** A `zpool list -j` payload naming exactly the given pools. */
function listJson(...pools: string[]): string {
  return JSON.stringify({
    pools: Object.fromEntries(pools.map(p => [p, { name: p, state: 'ONLINE', properties: {} }])),
  })
}

function listResult(...pools: string[]): ExecResult {
  return { stdout: listJson(...pools), stderr: '', exitCode: 0 }
}

async function build(ex: MockExecutor): Promise<{ server: ReturnType<typeof Fastify>, jobQueue: JobQueue }> {
  // cr.12: the composer refuses disk ids the inventory does not know — serve
  // the invented d1/d2 as blank, available disks (see inventory-stub.ts).
  serveBlankInventoryDisksOn(ex, ['d1', 'd2'])
  const jobQueue = new JobQueue()
  const server = Fastify({ logger: false })
  await server.register(jobRoutes, { prefix: '/v1', jobQueue })
  await server.register(poolRoutes, { prefix: '/v1', executor: ex, jobQueue, confirmStore: new ConfirmStore() })
  return { server, jobQueue }
}

async function waitForJob(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = jobQueue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

/** The systemctl argv issued for a pool's boot-import unit, if any. */
function unitCall(ex: MockExecutor, pool: string): string[] | undefined {
  return ex.calls.find(c => c.command === SYSTEMCTL && c.args[1] === `zfs-import@${pool}.service`)?.args
}

/** Every zpool argv this executor saw, in order. */
function importZpoolCalls(ex: MockExecutor): string[][] {
  return ex.calls.filter(c => c.command === ZPOOL).map(c => c.args)
}

describe('boot-import unit: create enables zfs-import@<pool>.service (issue #22)', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function createPool(ex: MockExecutor, name: string): Promise<Job> {
    // cr.52r D5: a create without a mountpoint is checked at its default
    // `/<name>`, so the live-mount collision gate reads the mount table here
    // too (cr.60: unreadable fails closed). A test that registered its own
    // findmnt answer keeps it (fixtures are first-wins).
    ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: capturedRootMountTable(), stderr: '', exitCode: 0 } })
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name, dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }] }),
    })
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('enables the unit after a successful create and keeps the result null', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult() })
    ex.addFixture({ command: ZPOOL, result: OK }) // the create itself
    ex.addFixture({ command: SYSTEMCTL, args: ['enable', 'zfs-import@tank.service'], result: OK })

    const job = await createPool(ex, 'tank')

    assert.equal(job.status, 'completed')
    assert.deepEqual(unitCall(ex, 'tank'), ['enable', 'zfs-import@tank.service'])
    // Unchanged result shape when the unit management succeeds.
    assert.equal(job.result, null)
  })

  it('still completes when systemctl fails, reporting it as a job warning', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult() })
    ex.addFixture({ command: ZPOOL, result: OK })
    // No systemctl fixture — the mock answers 127, standing in for a hiccup.

    const job = await createPool(ex, 'tank')

    assert.equal(job.status, 'completed', 'a unit hiccup never fails an already-created pool')
    const result = job.result as { warnings?: string[] }
    assert.equal(result.warnings?.length, 1)
    assert.ok(result.warnings![0].includes('zfs-import@tank.service'))
  })

  it('escapes the pool name into the instance (my-pool → my\\x2dpool)', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult() })
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    await createPool(ex, 'my-pool')

    assert.deepEqual(
      ex.calls.find(c => c.command === SYSTEMCTL)?.args,
      ['enable', 'zfs-import@my\\x2dpool.service'],
    )
  })
})

describe('boot-import unit: import enables the unit for the pool(s) that appeared', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function importPool(ex: MockExecutor, body: Record<string, unknown>): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('enables the unit for a pool imported by name', async () => {
    const ex = new MockExecutor()
    // Before → after: `oldtank` appears across the import.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult(), listResult('oldtank')] })
    ex.addFixture(zfsStoredMountpoints('oldtank'))
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, args: ['enable', 'zfs-import@oldtank.service'], result: OK })

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'completed')
    assert.deepEqual(unitCall(ex, 'oldtank'), ['enable', 'zfs-import@oldtank.service'])
    assert.equal(job.result, null)
  })

  it('learns the name of a pool imported BY GUID from the list diff', async () => {
    const ex = new MockExecutor()
    // A guid import never tells us the name — an already-imported pool is in
    // both listings, and only the newcomer is the one we just imported.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool', 'oldtank')] })
    ex.addFixture(zfsStoredMountpoints('oldtank'))
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    const job = await importPool(ex, { guid: '9876543210987654321' })

    assert.equal(job.status, 'completed')
    // Exactly one unit touched, and it is the newly imported pool's.
    assert.deepEqual(
      ex.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args),
      [['enable', 'zfs-import@oldtank.service']],
    )
  })

  it('falls back to the requested name when the diff is empty', async () => {
    const ex = new MockExecutor()
    // Same listing before and after (e.g. the listing failed) — a by-name
    // import still knows what it asked for.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('testpool') })
    ex.addFixture(zfsStoredMountpoints('oldtank'))
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    await importPool(ex, { name: 'oldtank' })

    assert.deepEqual(unitCall(ex, 'oldtank'), ['enable', 'zfs-import@oldtank.service'])
  })

  it('reports a systemctl failure as a job warning, not a failed import', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult(), listResult('oldtank')] })
    ex.addFixture(zfsStoredMountpoints('oldtank'))
    ex.addFixture({ command: ZPOOL, result: OK })
    // No systemctl fixture — 127.

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'completed')
    const result = job.result as { warnings?: string[] }
    assert.equal(result.warnings?.length, 1)
  })
})

describe('boot-import unit: destroy disables the unit', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function destroyPool(ex: MockExecutor, pool: string): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const first = await server.inject({ method: 'DELETE', url: `/v1/pools/${pool}`, headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/pools/${pool}`,
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
    })
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('disables the unit after a successful destroy', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('tank') })
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'tank'], result: { stdout: '77\n', stderr: '', exitCode: 0 } }) // ident.1
    // cr.23: readable-quiet boot facts — destroy asks them before the confirm
    // gate, and facts gone dark would fail closed.
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'tank\t-\n', stderr: '', exitCode: 0 } })
    // cr.60: the mount table too — on its own, an unreadable one tightens.
    ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: capturedRootMountTable(), stderr: '', exitCode: 0 } })
    ex.addFixture({ command: ZPOOL, args: ['destroy', '--', 'tank'], result: OK })
    ex.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@tank.service'], result: OK })

    const job = await destroyPool(ex, 'tank')

    assert.equal(job.status, 'completed')
    assert.deepEqual(unitCall(ex, 'tank'), ['disable', 'zfs-import@tank.service'])
    assert.deepEqual(job.result, { destroyed: 'tank' })
  })

  it('attaches a warning to the result when the disable fails', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('tank') })
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'tank'], result: { stdout: '77\n', stderr: '', exitCode: 0 } }) // ident.1
    // cr.23: readable-quiet boot facts — destroy asks them before the confirm
    // gate, and facts gone dark would fail closed.
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'tank\t-\n', stderr: '', exitCode: 0 } })
    // cr.60: the mount table too — on its own, an unreadable one tightens.
    ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: capturedRootMountTable(), stderr: '', exitCode: 0 } })
    ex.addFixture({ command: ZPOOL, args: ['destroy', '--', 'tank'], result: OK })
    // No systemctl fixture — 127.

    const job = await destroyPool(ex, 'tank')

    assert.equal(job.status, 'completed')
    const result = job.result as { destroyed: string, warnings?: string[] }
    assert.equal(result.destroyed, 'tank')
    assert.equal(result.warnings?.length, 1)
    assert.ok(result.warnings![0].includes('zfs-import@tank.service'))
  })

  it('never reaches the system pool — its destroy is blocked before the job', async () => {
    // cr.23: the block is a FACT, never the name. A pool called `rpool` is a
    // data pool until the boot facts say otherwise; here `zpool get bootfs`
    // names it, and that — not the string — is what 409s the destroy.
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: listResult('rpool') })
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'rpool\trpool/ROOT/pve-1\n', stderr: '', exitCode: 0 } })
    const built = await build(ex)
    server = built.server

    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/rpool', headers: IDENTITY_HEADERS })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.equal(res.json().error.reason, 'system-pool')
    assert.match(res.json().error.message, /boot filesystem \(rpool\/ROOT\/pve-1\)/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a hard refusal never offers a confirm code')
    assert.equal(ex.calls.filter(c => c.command === SYSTEMCTL).length, 0)
  })
})

/**
 * cr.52s-b (5): the import gate skips datasets whose `canmount` is `off` — such
 * a dataset never mounts at import, so its stored mountpoint (however dangerous)
 * is not a path ZFS will take. `canmount` rides the SAME `zfs get` as
 * `mountpoint` (`-o name,property,value` over `mountpoint,canmount`, one row per
 * property per dataset), so the read stays a single call.
 */
describe('cr.52s-b (5): the import gate and canmount=off', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function importPool(ex: MockExecutor, body: Record<string, unknown>): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  /** The `zfs get` answer: the pool root safe, `oldtank/etc` at `/etc` with the given canmount. */
  function etcDataset(canmount: string): { command: string, args: string[], result: ExecResult } {
    return {
      command: ZFS,
      args: ['get', '-H', '-r', '-o', 'name,property,value', 'mountpoint,canmount', '--', 'oldtank'],
      result: {
        stdout: 'oldtank\tmountpoint\t/mnt/anas-oldtank\noldtank\tcanmount\ton\n'
          + `oldtank/etc\tmountpoint\t/etc\noldtank/etc\tcanmount\t${canmount}\n`,
        stderr: '',
        exitCode: 0,
      },
    }
  }

  it('a canmount=off dataset whose stored mountpoint is /etc lets the import proceed — the full pinned argv runs', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult(), listResult('oldtank')] })
    ex.addFixture(etcDataset('off'))
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // The whole sequence: the -N gate import, the checked export, the mounted
    // re-import — the pool's own mountpoint (/mnt/anas-oldtank) is safe and the
    // /etc dataset is skipped, so nothing refuses.
    assert.deepEqual(
      ex.calls.filter(c => c.command === ZPOOL && c.args[0] === 'import' && c.args.length > 1).map(c => c.args),
      [['import', '-N', '--', 'oldtank'], ['import', '--', 'oldtank']],
    )
    assert.deepEqual(ex.calls.filter(c => c.command === ZPOOL && c.args[0] === 'export').map(c => c.args), [['export', 'oldtank']])
  })

  it('the same dataset with canmount=on still refuses at /etc — canmount rides the read, the skip is only off', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult(), listResult('oldtank')] })
    ex.addFixture(etcDataset('on'))
    ex.addFixture({ command: ZPOOL, result: OK })

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.match(job.error!.message, /stored mountpoints land on a protected or system path/)
    assert.match(job.error!.message, /'\/etc' /)
    // The refusal exported the pool again; the mounted re-import NEVER ran.
    assert.deepEqual(ex.calls.filter(c => c.command === ZPOOL && c.args[0] === 'export').map(c => c.args), [['export', 'oldtank']])
    assert.ok(!ex.calls.some(c => c.command === ZPOOL && c.args[0] === 'import' && !c.args.includes('-N')), 'the mounted import never ran')
  })
})

/**
 * cr.52s-b (1): the pool the import gates (and, on a refusal, exports again)
 * is ONLY the pool this job imported — never "everything the second listing
 * names that the first did not". A by-name import knows its pool (the request);
 * a by-guid import takes the name the post-import listing gives it, with the
 * cr.64b2-i scan's predicted name as the fallback.
 */
describe('cr.52s-b (1): the gated/exported set is the imported pool only', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function importPool(ex: MockExecutor, body: Record<string, unknown>): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('a refusal after `-N` exports ONLY the imported pool — a second pool present in BOTH listings is never touched', async () => {
    const ex = new MockExecutor()
    // testpool is imported before AND after; only oldtank appears across the
    // import. The pre-cr.52s-b diff (`after - before`) reads the same, but the
    // gate/export set is now the REQUESTED pool, so testpool can never be
    // exported by an oldtank import.
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool', 'oldtank')] })
    ex.addFixture({
      command: ZFS,
      args: ['get', '-H', '-r', '-o', 'name,property,value', 'mountpoint,canmount', '--', 'oldtank'],
      result: { stdout: 'oldtank\tmountpoint\t/mnt/pve/oldtank\noldtank\tcanmount\ton\n', stderr: '', exitCode: 0 },
    })
    ex.addFixture({ command: ZPOOL, result: OK })

    const job = await importPool(ex, { name: 'oldtank' })

    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.match(job.error!.message, /stored mountpoints land on a protected or system path/)
    assert.deepEqual(importZpoolCalls(ex).filter(c => c[0] === 'export'), [['export', 'oldtank']])
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'export' && c[1] === 'testpool'), 'the pre-existing pool is never exported')
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'import' && c.includes('oldtank') && !c.includes('-N')), 'the mounted import never ran')
  })
})

/**
 * cr.52s-b (2): the `zpool export` that undoes a refused `-N` import CHECKS
 * its exit. The pre-cr.52r code swallowed it (`.catch(() => {})` on an exec
 * that resolves with an exit code) and the job still said the pool was
 * "exported again" — it stayed imported-unmounted. A failed export now fails
 * the job with the export's stderr, that the pool is STILL imported, at which
 * mountpoint it would mount, and what to run.
 */
describe('cr.52s-b (2): the undo export after a refusal checks its exit', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a failed export after a refusal fails the job with its stderr and the STILL-imported sentence — no mounted import', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool', 'oldtank')] })
    ex.addFixture({
      command: ZFS,
      args: ['get', '-H', '-r', '-o', 'name,property,value', 'mountpoint,canmount', '--', 'oldtank'],
      result: { stdout: 'oldtank\tmountpoint\t/mnt/pve/oldtank\noldtank\tcanmount\ton\n', stderr: '', exitCode: 0 },
    })
    // The export's stderr is the captured busy-export shape — iscsi/error-texts.txt
    // §10's `cannot unmount '<dataset mountpoint>': pool or dataset is busy`
    // (a real `zpool export gtiscsi` failure captured on the stunt node) with the
    // pool's refused mountpoint in place of the capture's `/gtiscsi/images`.
    ex.addFixture({ command: ZPOOL, args: ['export', 'oldtank'], result: { stdout: '', stderr: 'cannot unmount \'/mnt/pve/oldtank\': pool or dataset is busy', exitCode: 1 } })
    ex.addFixture({ command: ZPOOL, result: OK })

    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank' }),
    })
    assert.equal(res.statusCode, 202, res.payload)
    const job = await waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)

    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    const message = job.error!.message
    // The export's own stderr is pasted.
    assert.match(message, /could not export 'oldtank': cannot unmount '\/mnt\/pve\/oldtank': pool or dataset is busy/)
    // The pool is STILL imported — never the old "exported again" sentence.
    assert.match(message, /STILL IMPORTED/)
    assert.match(message, /with -N it was imported unmounted/)
    assert.match(message, /would mount at '\/mnt\/pve\/oldtank'/)
    assert.match(message, /run `zpool export oldtank` once nothing holds it and retry/)
    assert.doesNotMatch(message, /exported again/)
    // No second import — the mounted re-import never ran.
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'import' && c.includes('oldtank') && !c.includes('-N')), 'the mounted import never ran')
  })
})

/**
 * cr.52s-b (4): a failed `zfs get` after the `-N` import exports the pool
 * again (CHECKED, item 2) and refuses naming the read — the op is never left
 * half-imported (the pool was imported unmounted and stayed that way before).
 */
describe('cr.52s-b (4): a failed `zfs get` after `-N` exports and refuses', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('zfs get exit 1 → the pool is exported again (checked) and the job refuses naming the read — no mounted import', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool', 'oldtank')] })
    // The failing `zfs get` stderr is the captured zfs shape
    // (iscsi/zfs-list-t-volume-absent.stderr.txt: `cannot open '<dataset>':
    // dataset does not exist`, exit 1) re-pointed at the pool under test.
    ex.addFixture({
      command: ZFS,
      args: ['get', '-H', '-r', '-o', 'name,property,value', 'mountpoint,canmount', '--', 'oldtank'],
      result: { stdout: '', stderr: 'cannot open \'oldtank\': dataset does not exist', exitCode: 1 },
    })
    ex.addFixture({ command: ZPOOL, result: OK })

    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'oldtank' }),
    })
    assert.equal(res.statusCode, 202, res.payload)
    const job = await waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)

    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    const message = job.error!.message
    assert.match(message, /could not read the stored mountpoints of 'oldtank' before mounting it/)
    assert.match(message, /cannot open 'oldtank': dataset does not exist/)
    assert.match(message, /was exported again, so nothing was left half-imported/)
    // The export ran and was CHECKED (it succeeded here).
    assert.deepEqual(importZpoolCalls(ex).filter(c => c[0] === 'export'), [['export', 'oldtank']])
    // No mounted re-import ever ran.
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'import' && c.includes('oldtank') && !c.includes('-N')), 'the mounted import never ran')
  })
})

/**
 * cr.52s-b review (Opus 2026-10-17): a by-guid import whose import scan named
 * no pool for the guid learns the name from the post-import diff, and that
 * diff must name EXACTLY one newcomer. An empty diff once let the gate loop
 * run over nothing and the real (mounting) `zpool import <guid>` ran with no
 * `zfs get` at all; a two-name diff (another import or create landing in the
 * same window under other lock keys) gated both, and on a pass exported the
 * foreign pool and never re-imported it. Both now refuse naming the state,
 * with no export and no mounted import.
 */
describe('cr.52s-b review: a by-guid import with no scan name needs exactly one newcomer', () => {
  let server: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const GUID = '9876543210987654321'

  async function importByGuid(ex: MockExecutor): Promise<Job> {
    const built = await build(ex)
    server = built.server
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/import',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ guid: GUID }),
    })
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(built.jobQueue, (res.json() as { job: { id: string } }).job.id)
  }

  it('an empty diff refuses — no mounted import runs without a gate read', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool')] })
    // The scan exits 0 and names nothing for the guid.
    ex.addFixture({ command: ZPOOL, args: ['import'], result: OK })
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    const job = await importByGuid(ex)

    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.match(job.error!.message, new RegExp(`the pool with guid ${GUID} was imported unmounted \\(-N\\)`))
    assert.match(job.error!.message, /the post-import listing names no new pool/)
    assert.match(job.error!.message, /run `zpool list -o name,guid`/)
    assert.deepEqual(
      importZpoolCalls(ex).filter(c => c[0] === 'import' && c.length > 1),
      [['import', '-N', '--', GUID]],
      'only the -N import ran — never the mounted one',
    )
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'export'), 'nothing is exported')
    assert.ok(!ex.calls.some(c => c.command === SYSTEMCTL), 'no boot-import unit is enabled')
  })

  it('a two-name diff refuses — a pool another job created or imported meanwhile is never exported', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], results: [listResult('testpool'), listResult('testpool', 'oldtank', 'other')] })
    ex.addFixture({ command: ZPOOL, args: ['import'], result: OK })
    ex.addFixture(zfsStoredMountpoints('oldtank'))
    ex.addFixture(zfsStoredMountpoints('other'))
    ex.addFixture({ command: ZPOOL, result: OK })
    ex.addFixture({ command: SYSTEMCTL, result: OK })

    const job = await importByGuid(ex)

    assert.equal(job.status, 'failed', JSON.stringify(job.error))
    assert.match(job.error!.message, /the post-import listing names 2 new pools \('oldtank', 'other'\)/)
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'export'), 'neither newcomer is exported')
    assert.ok(!importZpoolCalls(ex).some(c => c[0] === 'import' && !c.includes('-N') && c.length > 1), 'the mounted import never ran')
    assert.ok(!ex.calls.some(c => c.command === SYSTEMCTL), 'no boot-import unit is enabled')
  })
})
