import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'

/**
 * Story cr.32 — pool export and destroy refuse a PVE pool with 409
 * PVE_MANAGED (EPICS §2 "PVE territory is read-only and hands-off"; DESIGN
 * pvepool.1 "pool-level actions on a PVE pool stay hands-off"), at the route
 * AND in the job (ruling (j)).
 *
 * FIXTURE. `fixtures/mounts/storage.cfg` is the stunt node's real
 * /etc/pve/storage.cfg (fixtures/mounts/NOTES.md): a `zfspool: datapool`
 * storage whose `pool` line is the bare pool `datapool`. The dev mock's pool
 * is `testpool`, so each case rewrites exactly the lines it names, spelled
 * out at the call site — the rest of the capture is served verbatim.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORAGE_CFG = readFileSync(join(__dirname, '../../fixtures/mounts/storage.cfg'), 'utf-8')

const ZPOOL = '/usr/sbin/zpool'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Rewrite one exact line of the capture (it must be there exactly once). */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `storage.cfg capture has no single '${from}'`)
  return text.replace(from, to)
}

/** The storage root IS the pool root: `pool datapool` → `pool testpool`. */
const ROOT_STORAGE = rewrite(STORAGE_CFG, '\tpool datapool\n', '\tpool testpool\n')
/** A nested storage root: `pool datapool` → `pool testpool/vmdata` (the pool root itself is unowned). */
const NESTED_STORAGE = rewrite(STORAGE_CFG, '\tpool datapool\n', '\tpool testpool/vmdata\n')

/** Every call that would mean export, destroy or the cleanup acted. */
function mutations(mock: MockExecutor): { command: string, args: string[] }[] {
  return mock.calls.filter(c => (c.command === ZPOOL && ['export', 'destroy', 'labelclear'].includes(c.args[0]))
    || c.command === WIPEFS || c.command === SGDISK)
}

describe('cr.32 — pool export/destroy refuse a PVE pool (409 PVE_MANAGED)', () => {
  let dir: string
  let cfg: string
  let server: ReturnType<typeof createServer> | undefined
  const saved = process.env.ANAS_STORAGE_CFG

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr32-pve-'))
    cfg = join(dir, 'storage.cfg')
    process.env.ANAS_STORAGE_CFG = cfg
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (saved === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = saved
  })

  async function serve(storageCfg: string): Promise<MockExecutor> {
    await writeFile(cfg, storageCfg, 'utf-8')
    server = createServer({ mock: true, logger: false })
    return (server as unknown as { executor: MockExecutor }).executor
  }

  function assertPveRefusal(res: { statusCode: number, headers: Record<string, unknown>, json: () => unknown }, storageRoot: string): void {
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, reason?: string, message: string } }
    assert.equal(body.error.code, 'PVE_MANAGED')
    assert.equal(body.error.reason, 'pve-managed')
    assert.match(body.error.message, new RegExp(`PVE storage 'datapool' owns ${storageRoot.replace('/', '\\/')} as a storage root`))
    assert.match(body.error.message, /no confirm bypass/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a hard refusal offers no code')
  }

  for (const [label, storageCfg, storageRoot] of [
    ['the pool root is the storage root', ROOT_STORAGE, 'testpool'],
    ['a storage root nested in the pool', NESTED_STORAGE, 'testpool/vmdata'],
  ] as const) {
    it(`destroy: refused when ${label}, and nothing runs (a code does not bypass it)`, async () => {
      const mock = await serve(storageCfg)
      assertPveRefusal(await server!.inject({ method: 'DELETE', url: '/v1/pools/testpool?cleanup=true', headers: IDENTITY_HEADERS }), storageRoot)
      assertPveRefusal(await server!.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'anything' } }), storageRoot)
      assert.deepEqual(mutations(mock), [])
    })

    it(`export: refused when ${label}, and nothing runs`, async () => {
      const mock = await serve(storageCfg)
      assertPveRefusal(await server!.inject({ method: 'POST', url: '/v1/pools/testpool/export', headers: JSON_HEADERS, payload: '{}' }), storageRoot)
      assert.deepEqual(mutations(mock), [])
    })
  }

  it('the capture as recorded (a storage on ANOTHER pool) leaves testpool to the ordinary confirm', async () => {
    await serve(STORAGE_CFG)
    const res = await server!.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('race: PVE takes a DATASET of the pool between the confirm and the job — both verbs fail PVE_MANAGED with no mutating argv', async () => {
    for (const verb of ['destroy', 'export'] as const) {
      // The pool root is unowned at the confirm; a storage on `testpool/vmdata`
      // appears while the job waits — exporting or destroying the pool takes
      // the nested storage root and every guest disk under it just the same.
      const mock = await serve(STORAGE_CFG)
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const request = verb === 'destroy'
        ? { method: 'DELETE' as const, url: '/v1/pools/testpool', headers: IDENTITY_HEADERS }
        : { method: 'POST' as const, url: '/v1/pools/testpool/export', headers: JSON_HEADERS, payload: '{}' }

      const first = await server!.inject(request)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      for (let i = 0; i < 4; i++)
        queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
      const res = await server!.inject({ ...request, headers: { ...request.headers, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as JobAccepted).job.id
      assert.equal(queue.get(id)?.status, 'queued')

      // PVE adds a storage on a dataset of the pool while the job waits.
      await writeFile(cfg, NESTED_STORAGE, 'utf-8')
      release()

      let job: Job | undefined
      for (let i = 0; i < 200 && !(job && (job.status === 'failed' || job.status === 'completed')); i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
        job = queue.get(id)
      }
      assert.equal(job?.status, 'failed', verb)
      assert.equal(job?.error?.code, 'PVE_MANAGED', verb)
      assert.match(job!.error!.message, /PVE storage 'datapool' owns testpool\/vmdata as a storage root/)
      assert.deepEqual(mutations(mock), [], `${verb}: no mutating argv`)
      await server!.close()
      server = undefined
    }
  })

  it('race: PVE takes the pool between the confirm and the job — both verbs fail PVE_MANAGED with no mutating argv', async () => {
    for (const verb of ['destroy', 'export'] as const) {
      const mock = await serve(STORAGE_CFG)
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const request = verb === 'destroy'
        ? { method: 'DELETE' as const, url: '/v1/pools/testpool', headers: IDENTITY_HEADERS }
        : { method: 'POST' as const, url: '/v1/pools/testpool/export', headers: JSON_HEADERS, payload: '{}' }

      const first = await server!.inject(request)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      // Fill all four slots so the confirmed job waits in the queue.
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      for (let i = 0; i < 4; i++)
        queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
      const res = await server!.inject({ ...request, headers: { ...request.headers, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as JobAccepted).job.id
      assert.equal(queue.get(id)?.status, 'queued')

      // The operator adds the pool to PVE while the job waits.
      await writeFile(cfg, ROOT_STORAGE, 'utf-8')
      release()

      let job: Job | undefined
      for (let i = 0; i < 200 && !(job && (job.status === 'failed' || job.status === 'completed')); i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
        job = queue.get(id)
      }
      assert.equal(job?.status, 'failed', verb)
      assert.equal(job?.error?.code, 'PVE_MANAGED', verb)
      assert.match(job!.error!.message, /PVE storage 'datapool' owns testpool as a storage root/)
      assert.deepEqual(mutations(mock), [], `${verb}: no mutating argv`)
      await server!.close()
      server = undefined
    }
  })
})
