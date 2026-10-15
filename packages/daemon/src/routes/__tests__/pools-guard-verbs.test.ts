import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'
import { POOL_CREATE_PRESENTATION_ONLY, POOL_IMPORT_PRESENTATION_ONLY, POOL_MOUNTPOINT_PRESENTATION_ONLY, POOL_UPGRADE_PRESENTATION_ONLY } from '../pools.js'
import { capturedPoolGet } from './pool-guard-reads.js'

/**
 * Story cr.36 — the remaining ZFS pool verbs on the guard (docs/WAVE3-DESIGN.md
 * §2.1, every pool row with a non-empty "Missing" cell; §8.2 "race tests per
 * verb"). The H8 property: a gate that would refuse at the route but only
 * becomes true AFTER the request was accepted — while the job waits in the
 * queue — refuses the job with the gate's own code, and the mock executor
 * shows no mutating argv. Also: what each confirm now binds, and which lock
 * keys each verb's job holds.
 *
 * The job is held in the REAL queue (the pools-guard.test.ts pattern): four
 * placeholder jobs fill the four slots, the request is accepted behind them
 * (`queued`), the test changes the node's state, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). Every state flip serves
 * a capture; the rewrites, each spelled out where it is built below:
 *  - the pool swap: the dev mock answers `zpool get guid` for testpool with
 *    its own guid; the swapped-in pool answers with testpool's CAPTURED guid
 *    (`zpool-get-all.json`, via pool-guard-reads.ts) — a different pool under
 *    the same name, as an export/import swap leaves it.
 *  - the system mount: `mounts/findmnt-full.json` with its one nested ZFS row
 *    re-pointed to `testpool/var` at `/var` (as pools-guard.test.ts).
 *  - PVE takes the pool: `pve/storage.cfg` with its zfspool storage's
 *    `pool datapool` line re-pointed to `pool testpool`.
 *  - a disk joins a pool: `zfs/zpool-status-online-fresh.json` (one mirror of
 *    the QEMU disks; WD-56789012 reads `available`) at the request, the
 *    captured `zfs/zpool-status-online.json` (WD-56789012 a testpool member)
 *    when the job runs. No rewrite.
 *  - a resilver starts: `zfs/zpool-status-resilvering.json` (testpool) with
 *    its finished scan's `"state":"FINISHED"` set to `"SCANNING"`; for the
 *    raidz pool, `zfs/zpool-status-scrubbing.json` (testpool-rz, a running
 *    scan) with `"function":"SCRUB"` set to `"RESILVER"`.
 *  - a spare is put to work: `zfs/zpool-status-with-spare.json` (HOT3 AVAIL)
 *    at the request, `zfs/zpool-status-spare-active.json` (HOT3 INUSE) or
 *    the fresh capture (no spare at all) when the job runs. No rewrite.
 *  - a mount appears at the path: `mounts/findmnt-real.json` (only `/`) at the
 *    request, the AHR capture `ahr/findmnt-ahr0.json` (`/mnt/anas-ahr/ahr0`)
 *    when the job runs; fstab: `mounts/fstab-stock` then
 *    `mounts/fstab-anas-managed` (`/mnt/anas-nfs`). No rewrite.
 *  - another dataset takes the path / the pool already sits there: the
 *    `zfs list -H -o name,mountpoint,mounted` rows built from the captured
 *    `zfs/zfs-list.json` (its `mountpoint` per dataset; `mounted` is `yes`
 *    for a path, `no` for `-`), optionally with testpool's row re-pointed.
 *  - the raidz pool: `zfs/zpool-list-raidz.json` + `zfs/zpool-status-raidz.json`,
 *    its guid from that status capture's `pool_guid`, and `zpool get all -j`
 *    from `zfs/zpool-get-all.json` with its one pool entry renamed from
 *    `testpool` to `testpool-rz` (feature@raidz_expansion `enabled`).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const FINDMNT = '/usr/bin/findmnt'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const FINDMNT_FULL = fixture('mounts/findmnt-full.json')
const FINDMNT_TESTPOOL_AT_VAR = rewrite(
  rewrite(FINDMNT_FULL, '"target": "/mnttest/data"', '"target": "/var"'),
  '"source": "mnttest/data"',
  '"source": "testpool/var"',
)
const FINDMNT_REAL_ROOT_ONLY = fixture('mounts/findmnt-real.json')
const FINDMNT_REAL_AHR0 = mockFixtures.ahrFindmnt().stdout
const FSTAB_STOCK = fixture('mounts/fstab-stock')
const FSTAB_WITH_NFS = fixture('mounts/fstab-anas-managed')
const STORAGE_CFG_TESTPOOL = rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool\n')

const STATUS_FRESH = fixture('zfs/zpool-status-online-fresh.json')
const STATUS_ONLINE = fixture('zfs/zpool-status-online.json')
const STATUS_RESILVERING = rewrite(fixture('zfs/zpool-status-resilvering.json'), '"function":"RESILVER","state":"FINISHED"', '"function":"RESILVER","state":"SCANNING"')
const STATUS_WITH_SPARE = fixture('zfs/zpool-status-with-spare.json')
const STATUS_SPARE_ACTIVE = fixture('zfs/zpool-status-spare-active.json')
const STATUS_RAIDZ = fixture('zfs/zpool-status-raidz.json')
const STATUS_RAIDZ_RESILVERING = rewrite(fixture('zfs/zpool-status-scrubbing.json'), '"function":"SCRUB"', '"function":"RESILVER"')
const LIST_RAIDZ = fixture('zfs/zpool-list-raidz.json')
const RAIDZ_GUID = (JSON.parse(STATUS_RAIDZ) as { pools: Record<string, { pool_guid: string }> }).pools['testpool-rz'].pool_guid
const GET_ALL_RAIDZ = (() => {
  const doc = JSON.parse(fixture('zfs/zpool-get-all.json')) as { pools: Record<string, { name: string }> }
  const entry = doc.pools.testpool
  return JSON.stringify({ ...doc, pools: { 'testpool-rz': { ...entry, name: 'testpool-rz' } } })
})()

/** `zfs list -H -o name,mountpoint,mounted` rows from the captured `zfs list -j` (see the module note). */
function mountRows(overrides: Record<string, string> = {}): string {
  const doc = JSON.parse(fixture('zfs/zfs-list.json')) as { datasets: Record<string, { properties?: { mountpoint?: { value?: string } } }> }
  return Object.entries(doc.datasets)
    .filter(([name]) => !name.includes('@'))
    .map(([name, ds]) => {
      const mp = overrides[name] ?? ds.properties?.mountpoint?.value ?? '-'
      return `${name}\t${mp}\t${mp.startsWith('/') ? 'yes' : 'no'}\n`
    })
    .join('')
}

/** The dev mock's guid for testpool (server.ts); the swap answers the captured one. */
const TESTPOOL_GUID = '5823146802312415237'
const SWAPPED_GUID = capturedPoolGet().guid

/** A disk the fresh capture leaves `available` and the online capture makes a testpool member. */
const NEW_DISK = 'ata-WDC_WD2003FZEX-00SRLA0_WD-56789012'
const HOT1 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'
const HOT3 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT3'

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** A call that would mean a pool verb acted. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return (c.command === ZPOOL && ['upgrade', 'set', 'scrub', 'trim', 'create', 'import', 'add', 'remove', 'attach', 'replace', 'online', 'export', 'destroy', 'labelclear'].includes(c.args[0])
    && !(c.args[0] === 'upgrade' && c.args.length === 0))
  || (c.command === ZFS && c.args[0] === 'set')
}

interface Req {
  method: 'POST' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
}

describe('cr.36 — the pool verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** What the node answers right now; a test flips these while the job waits. */
  let findmnt = FINDMNT_FULL
  let findmntReal: string | null = null
  let zpoolStatus = STATUS_FRESH
  let zpoolList: string | null = null
  let guid: string | null = null
  let getAll: string | null = null
  let zfsMountRows: string | null = null
  const paused = new Map<string, Promise<void>>()

  const ENV_KEYS = ['ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_STORAGE_CFG', 'ANAS_FSTAB_PATH'] as const
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
  const storageCfg = (): string => join(dir, 'storage.cfg')
  const fstab = (): string => join(dir, 'fstab')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr36-race-'))
    for (const key of ENV_KEYS)
      savedEnv[key] = process.env[key]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined)
        delete process.env[key]
      else
        process.env[key] = savedEnv[key]
    }
  })

  /** The dev mock, its reads routed through the flippable state. */
  async function serve(): Promise<void> {
    findmnt = FINDMNT_FULL
    findmntReal = null
    zpoolStatus = STATUS_FRESH
    zpoolList = null
    guid = null
    getAll = null
    zfsMountRows = null
    paused.clear()
    // No LIO and no PVE storage on this node; a stock fstab.
    process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'absent-configfs')
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = storageCfg()
    await rm(storageCfg(), { force: true })
    process.env.ANAS_FSTAB_PATH = fstab()
    await writeFile(fstab(), FSTAB_STOCK)
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      const argv = args.join(' ')
      if (command === FINDMNT && argv === '--json')
        return ok(findmnt)
      if (command === FINDMNT && argv === '--json --real' && findmntReal !== null)
        return ok(findmntReal)
      if (command === ZPOOL && argv === 'status -jv')
        return ok(zpoolStatus)
      if (command === ZPOOL && argv === 'list -j' && zpoolList !== null)
        return ok(zpoolList)
      if (command === ZPOOL && argv === 'get all -j' && getAll !== null)
        return ok(getAll)
      if (command === ZPOOL && argv.startsWith('get -H -o value guid -- ') && guid !== null)
        return ok(`${guid}\n`)
      if (command === ZFS && argv === 'list -H -o name,mountpoint,mounted' && zfsMountRows !== null)
        return ok(zfsMountRows)
      const hold = command === ZPOOL ? paused.get(args[0]) : command === ZFS ? paused.get(`zfs:${args[0]}`) : undefined
      if (hold)
        await hold
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  async function send(req: Req, code?: string) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.payload !== undefined ? JSON_HEADERS : IDENTITY_HEADERS), ...(code ? { 'x-anas-confirm': code } : {}) },
      ...(req.payload !== undefined ? { payload: JSON.stringify(req.payload) } : {}),
    })
  }

  /**
   * Fill the four slots, send the request (resent with its code when it is
   * confirm-gated) and leave the accepted job `queued` behind them.
   */
  async function acceptBehindFullQueue(req: Req, confirm: boolean): Promise<{ id: string, release: () => void }> {
    let code: string | undefined
    if (confirm) {
      const first = await send(req)
      assert.equal(first.statusCode, 409, first.body)
      assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
      code = first.headers['x-anas-confirm-code'] as string
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const res = await send(req, code)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the job waits behind the held slots')
    return { id, release }
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  /** Accept, flip, release: the job must fail with `code` and no mutating argv. */
  async function race(req: Req, confirm: boolean, flip: () => Promise<void> | void, code: string, message?: RegExp): Promise<Job> {
    const { id, release } = await acceptBehindFullQueue(req, confirm)
    await flip()
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed', `${req.url}: ${JSON.stringify(job.error)}`)
    assert.equal(job.error?.code, code, `${req.url}: ${job.error?.message}`)
    if (message)
      assert.match(job.error!.message, message)
    assert.deepEqual(calls.filter(isMutation), [], `${req.url}: no mutating argv`)
    return job
  }

  /** The control: nothing changes, the job runs and acts — the harness refuses nothing on its own. */
  async function control(req: Req, confirm: boolean, acted: (c: { command: string, args: string[] }) => boolean): Promise<void> {
    const { id, release } = await acceptBehindFullQueue(req, confirm)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'completed', `${req.url}: ${JSON.stringify(job.error)}`)
    assert.ok(calls.some(acted), `${req.url}: the verb ran`)
  }

  const swapPool = (): void => {
    guid = SWAPPED_GUID
  }
  const systemMount = (): void => {
    findmnt = FINDMNT_TESTPOOL_AT_VAR
  }
  const pveTakesPool = async (): Promise<void> => {
    await writeFile(storageCfg(), STORAGE_CFG_TESTPOOL)
  }

  // --- upgrade ------------------------------------------------------------

  const UPGRADE: Req = { method: 'POST', url: '/v1/pools/testpool/upgrade' }

  it('upgrade: control — confirmed and unchanged, the job upgrades', async () => {
    await serve()
    await control(UPGRADE, true, c => c.command === ZPOOL && c.args[0] === 'upgrade' && c.args.length > 0)
  })

  it('upgrade: another pool under the same name before the job → IDENTITY_MISMATCH, no zpool upgrade', async () => {
    await serve()
    await race(UPGRADE, true, swapPool, 'IDENTITY_MISMATCH')
  })

  it('upgrade: the confirm binds the guid — a resend after the swap is 409 IDENTITY_MISMATCH with a fresh code', async () => {
    await serve()
    const first = await send(UPGRADE)
    swapPool()
    const res = await send(UPGRADE, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.ok(res.headers['x-anas-confirm-code'])
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- scrub / trim (the existence cell) ----------------------------------

  for (const [verb, body] of [['scrub', {}], ['trim', {}]] as const) {
    it(`${verb}: control — the job runs`, async () => {
      await serve()
      await control({ method: 'POST', url: `/v1/pools/testpool/${verb}`, payload: body }, false, c => c.command === ZPOOL && c.args[0] === verb)
    })

    it(`${verb}: another pool under the same name before the job → IDENTITY_MISMATCH, no zpool ${verb}`, async () => {
      await serve()
      await race({ method: 'POST', url: `/v1/pools/testpool/${verb}`, payload: body }, false, swapPool, 'IDENTITY_MISMATCH')
    })
  }

  // --- mountpoint -----------------------------------------------------------

  const mountpointTo = (mp: string): Req => ({ method: 'PUT', url: '/v1/pools/testpool/mountpoint', payload: { mountpoint: mp } })

  it('mountpoint: control — confirmed and unchanged, the job sets it', async () => {
    await serve()
    await control(mountpointTo('/srv/newhome'), true, c => c.command === ZFS && c.args[0] === 'set')
  })

  it('mountpoint: a system mount of the pool appears → CONFLICT system-pool, no zfs set', async () => {
    await serve()
    const job = await race(mountpointTo('/srv/newhome'), true, systemMount, 'CONFLICT', /\/var/)
    assert.match(job.error!.message, /testpool/)
  })

  it('mountpoint: PVE takes the pool → PVE_MANAGED, no zfs set', async () => {
    await serve()
    await race(mountpointTo('/srv/newhome'), true, pveTakesPool, 'PVE_MANAGED', /PVE territory/)
  })

  it('mountpoint: a live mount appears at the path → CONFLICT, no zfs set', async () => {
    await serve()
    findmntReal = FINDMNT_REAL_ROOT_ONLY
    await race(mountpointTo('/mnt/anas-ahr/ahr0'), true, () => {
      findmntReal = FINDMNT_REAL_AHR0
    }, 'CONFLICT', /'\/mnt\/anas-ahr\/ahr0' is already a mountpoint/)
  })

  it('mountpoint: fstab claims the path → CONFLICT, no zfs set', async () => {
    await serve()
    await race(mountpointTo('/mnt/anas-nfs'), true, async () => {
      await writeFile(fstab(), FSTAB_WITH_NFS)
    }, 'CONFLICT', /already claimed in fstab/)
  })

  it('mountpoint: another dataset takes the path → CONFLICT naming it, no zfs set', async () => {
    await serve()
    zfsMountRows = mountRows({ 'testpool/media': '/srv/elsewhere' })
    await race(mountpointTo('/srv/newhome'), true, () => {
      zfsMountRows = mountRows({ 'testpool/media': '/srv/newhome' })
    }, 'CONFLICT', /already pool 'testpool\/media' mountpoint/)
  })

  it('mountpoint: the pool is already there when the job runs → VALIDATION_ERROR, no zfs set', async () => {
    await serve()
    zfsMountRows = mountRows()
    await race(mountpointTo('/srv/newhome'), true, () => {
      zfsMountRows = mountRows({ testpool: '/srv/newhome' })
    }, 'VALIDATION_ERROR', /already this pool's mountpoint/)
  })

  it('mountpoint: another pool under the same name → IDENTITY_MISMATCH, no zfs set', async () => {
    await serve()
    await race(mountpointTo('/srv/newhome'), true, swapPool, 'IDENTITY_MISMATCH')
  })

  it('mountpoint: the confirm binds the path — a resend for another path is 409 CONFIRM_SCOPE_CHANGED naming it', async () => {
    await serve()
    const first = await send(mountpointTo('/srv/newhome'))
    const res = await send(mountpointTo('/srv/other'), first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['mountpoint'])
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- create ---------------------------------------------------------------

  const create = (body: Record<string, unknown> = {}): Req => ({
    method: 'POST',
    url: '/v1/pools',
    payload: { name: 'newpool', dataVdevs: [{ type: 'stripe', disks: [NEW_DISK] }], ...body },
  })

  it('create: control — the job creates', async () => {
    await serve()
    await control(create(), false, c => c.command === ZPOOL && c.args[0] === 'create')
  })

  it('create: the disk joins a pool before the job → VALIDATION_ERROR naming it, no zpool create', async () => {
    await serve()
    await race(create(), false, () => {
      zpoolStatus = STATUS_ONLINE
    }, 'VALIDATION_ERROR', new RegExp(`disk '${NEW_DISK}' is not available \\(status: pool_member, pool 'testpool'\\)`))
  })

  it('create: a pool of that name appears before the job → CONFLICT, no zpool create', async () => {
    await serve()
    await race(create({ name: 'testpool-rz' }), false, () => {
      zpoolList = LIST_RAIDZ
    }, 'CONFLICT', /Pool 'testpool-rz' already exists/)
  })

  it('create: a mount appears at its mountpoint before the job → CONFLICT, no zpool create', async () => {
    await serve()
    findmntReal = FINDMNT_REAL_ROOT_ONLY
    await race(create({ mountpoint: '/mnt/anas-ahr/ahr0' }), false, () => {
      findmntReal = FINDMNT_REAL_AHR0
    }, 'CONFLICT', /already a mountpoint/)
  })

  it('create with force: the code signs the whole request — another layout is 409 CONFIRM_SCOPE_CHANGED naming it', async () => {
    await serve()
    const first = await send(create({ force: true }))
    assert.equal(first.statusCode, 409, first.body)
    const res = await send(create({ force: true, properties: { ashift: 12 } }), first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['properties'])
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('create: the job holds the name key and its disk key, exclusive, while it runs', async () => {
    await serve()
    const release = pause('create')
    const res = await send(create())
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZPOOL && c.args[0] === 'create'))
    assert.deepEqual(queue().heldLocks(), [
      { key: 'zname:newpool', mode: 'exclusive', holders: [id] },
      { key: `disk:${NEW_DISK}`, mode: 'exclusive', holders: [id] },
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  it('create: two creates naming one disk run one after the other, and the second is refused by its own re-run gate', async () => {
    await serve()
    const release = pause('create')
    const a = (await send(create())).json() as JobAccepted
    await until(() => calls.some(c => c.command === ZPOOL && c.args[0] === 'create'))
    const b = (await send(create({ name: 'otherpool' }))).json() as JobAccepted
    assert.equal(queue().get(b.job.id)?.status, 'queued')
    assert.match(queue().get(b.job.id)?.progress ?? '', /waiting for zpool\.create/)
    // The first create made the disk a pool member (the captured status that lists it).
    zpoolStatus = STATUS_ONLINE
    release()
    assert.equal((await finished(a.job.id)).status, 'completed')
    const second = await finished(b.job.id)
    assert.equal(second.status, 'failed')
    assert.equal(second.error?.code, 'VALIDATION_ERROR')
    assert.equal(calls.filter(c => c.command === ZPOOL && c.args[0] === 'create').length, 1, 'one zpool create')
  })

  // --- import ---------------------------------------------------------------

  it('import with force: the code signs altroot too — another altroot is 409 CONFIRM_SCOPE_CHANGED naming it', async () => {
    await serve()
    const req = (altroot: string): Req => ({ method: 'POST', url: '/v1/pools/import', payload: { name: 'oldtank', force: true, altroot } })
    const first = await send(req('/mnt/a'))
    assert.equal(first.statusCode, 409, first.body)
    const res = await send(req('/mnt/b'), first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['altroot'])
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('import: by name the job holds the name key, by guid the guid key', async () => {
    for (const [payload, key] of [
      [{ name: 'oldtank' }, 'zname:oldtank'],
      [{ guid: '9876543210987654321' }, 'zpool:9876543210987654321'],
    ] as const) {
      await serve()
      const release = pause('import')
      const id = ((await send({ method: 'POST', url: '/v1/pools/import', payload })).json() as JobAccepted).job.id
      await until(() => calls.some(c => c.command === ZPOOL && c.args[0] === 'import' && c.args.length > 1))
      assert.deepEqual(queue().heldLocks(), [{ key, mode: 'exclusive', holders: [id] }])
      release()
      assert.equal((await finished(id)).status, 'completed')
      await server!.close()
      server = undefined
    }
  })

  // --- add vdev -------------------------------------------------------------

  const ADD: Req = { method: 'POST', url: '/v1/pools/testpool/vdevs', payload: { role: 'cache', disks: [NEW_DISK] } }

  it('add vdev: control — the job adds', async () => {
    await serve()
    await control(ADD, false, c => c.command === ZPOOL && c.args[0] === 'add')
  })

  it('add vdev: the disk joins a pool before the job → VALIDATION_ERROR, no zpool add', async () => {
    await serve()
    await race(ADD, false, () => {
      zpoolStatus = STATUS_ONLINE
    }, 'VALIDATION_ERROR', /Ineligible disk selection/)
  })

  it('add vdev: a system mount appears → CONFLICT system-pool; PVE takes the pool → PVE_MANAGED; another pool → IDENTITY_MISMATCH', async () => {
    for (const [flip, code] of [[systemMount, 'CONFLICT'], [pveTakesPool, 'PVE_MANAGED'], [swapPool, 'IDENTITY_MISMATCH']] as const) {
      await serve()
      await race(ADD, false, flip, code)
      await server!.close()
      server = undefined
    }
  })

  it('add vdev: the job holds the pool\'s guid key and the disk key, exclusive', async () => {
    await serve()
    const release = pause('add')
    const id = ((await send(ADD)).json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZPOOL && c.args[0] === 'add'))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      [`zpool:${TESTPOOL_GUID}`, 'exclusive'],
      ['zname:testpool', 'shared'],
      [`disk:${NEW_DISK}`, 'exclusive'],
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  // --- remove vdev ----------------------------------------------------------

  const REMOVE: Req = { method: 'POST', url: '/v1/pools/testpool/vdevs/remove', payload: { vdev: HOT3 } }

  it('remove vdev: the spare is put to work before the job → VALIDATION_ERROR (in use), no zpool remove', async () => {
    await serve()
    zpoolStatus = STATUS_WITH_SPARE
    await race(REMOVE, false, () => {
      zpoolStatus = STATUS_SPARE_ACTIVE
    }, 'VALIDATION_ERROR', /is in use by/)
  })

  it('remove vdev: the spare is gone before the job → VALIDATION_ERROR (unknown), never a request-time token', async () => {
    await serve()
    zpoolStatus = STATUS_WITH_SPARE
    await race(REMOVE, false, () => {
      zpoolStatus = STATUS_FRESH
    }, 'VALIDATION_ERROR', new RegExp(HOT3))
  })

  it('remove vdev: a system mount, PVE, another pool — each refuses the waiting job', async () => {
    for (const [flip, code] of [[systemMount, 'CONFLICT'], [pveTakesPool, 'PVE_MANAGED'], [swapPool, 'IDENTITY_MISMATCH']] as const) {
      await serve()
      zpoolStatus = STATUS_WITH_SPARE
      await race(REMOVE, false, flip, code)
      await server!.close()
      server = undefined
    }
  })

  // --- attach / replace -----------------------------------------------------

  const ATTACH: Req = { method: 'POST', url: '/v1/pools/testpool/attach', payload: { existingDiskId: HOT1, newDiskId: NEW_DISK, replace: false } }
  const REPLACE: Req = { method: 'POST', url: '/v1/pools/testpool/attach', payload: { existingDiskId: HOT1, newDiskId: NEW_DISK, replace: true } }

  it('attach: control — the job attaches to the leaf ZFS reports', async () => {
    await serve()
    await control(ATTACH, false, c => c.command === ZPOOL && c.args[0] === 'attach'
      && c.args[3] === `/dev/disk/by-id/${HOT1}-part1` && c.args[4] === `/dev/disk/by-id/${NEW_DISK}`)
  })

  it('attach: a resilver starts before the job → CONFLICT busy, no zpool attach', async () => {
    await serve()
    await race(ATTACH, false, () => {
      zpoolStatus = STATUS_RESILVERING
    }, 'CONFLICT', /resilver in progress/)
  })

  it('attach and replace: the new disk joins a pool before the job → VALIDATION_ERROR, nothing runs', async () => {
    for (const req of [ATTACH, REPLACE]) {
      await serve()
      await race(req, false, () => {
        zpoolStatus = STATUS_ONLINE
      }, 'VALIDATION_ERROR', /Ineligible disk selection/)
      await server!.close()
      server = undefined
    }
  })

  it('attach and replace: a system mount, PVE, another pool — each refuses the waiting job', async () => {
    for (const req of [ATTACH, REPLACE]) {
      for (const [flip, code] of [[systemMount, 'CONFLICT'], [pveTakesPool, 'PVE_MANAGED'], [swapPool, 'IDENTITY_MISMATCH']] as const) {
        await serve()
        await race(req, false, flip, code)
        await server!.close()
        server = undefined
      }
    }
  })

  it('attach: a PVE pool is refused at the route now (the attach family had no topology gate)', async () => {
    await serve()
    await pveTakesPool()
    const res = await send(ATTACH)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PVE_MANAGED')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('replace: the job holds the pool\'s guid key and the new disk\'s key', async () => {
    await serve()
    const release = pause('replace')
    const id = ((await send(REPLACE)).json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZPOOL && c.args[0] === 'replace'))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      [`zpool:${TESTPOOL_GUID}`, 'exclusive'],
      ['zname:testpool', 'shared'],
      [`disk:${NEW_DISK}`, 'exclusive'],
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  // --- raidz expand ---------------------------------------------------------

  const EXPAND: Req = { method: 'POST', url: '/v1/pools/testpool-rz/attach', payload: { targetVdev: 'raidz1-0', newDiskId: NEW_DISK } }

  async function serveRaidz(): Promise<void> {
    await serve()
    zpoolList = LIST_RAIDZ
    zpoolStatus = STATUS_RAIDZ
    getAll = GET_ALL_RAIDZ
    guid = RAIDZ_GUID
  }

  it('raidz expand: control — the job widens the raidz vdev', async () => {
    await serveRaidz()
    await control(EXPAND, false, c => c.command === ZPOOL && c.args[0] === 'attach' && c.args[3] === 'raidz1-0')
  })

  it('raidz expand: a resilver starts before the job → CONFLICT busy, no zpool attach', async () => {
    await serveRaidz()
    await race(EXPAND, false, () => {
      zpoolStatus = STATUS_RAIDZ_RESILVERING
    }, 'CONFLICT', /resilver in progress/)
  })

  it('raidz expand: the new disk joins a pool before the job → VALIDATION_ERROR, no zpool attach', async () => {
    await serveRaidz()
    await race(EXPAND, false, () => {
      zpoolStatus = STATUS_ONLINE
    }, 'VALIDATION_ERROR', /Ineligible disk selection/)
  })

  it('raidz expand: the feature flag goes away before the job → CONFLICT flag; PVE takes the pool → PVE_MANAGED', async () => {
    await serveRaidz()
    await race(EXPAND, false, () => {
      getAll = rewrite(GET_ALL_RAIDZ, '"feature@raidz_expansion":{"value":"enabled"', '"feature@raidz_expansion":{"value":"disabled"')
    }, 'CONFLICT', /feature@raidz_expansion disabled/)
    await server!.close()
    server = undefined
    await serveRaidz()
    await race(EXPAND, false, async () => {
      await writeFile(storageCfg(), rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool-rz\n'))
    }, 'PVE_MANAGED')
  })

  // --- props: shared lock -----------------------------------------------------

  it('props: the job holds the pool\'s guid key SHARED (a property set does not reshape the pool)', async () => {
    await serve()
    const release = pause('set')
    const id = ((await send({ method: 'PUT', url: '/v1/pools/testpool', payload: { properties: { autotrim: 'on' } } })).json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZPOOL && c.args[0] === 'set'))
    assert.deepEqual(queue().heldLocks(), [
      { key: `zpool:${TESTPOOL_GUID}`, mode: 'shared', holders: [id] },
      { key: 'zname:testpool', mode: 'shared', holders: [id] },
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  it('mountpoint: the job holds the pool\'s guid key and the path\'s mount key, exclusive', async () => {
    await serve()
    const release = pause('zfs:set')
    const first = await send(mountpointTo('/srv/newhome'))
    const id = ((await send(mountpointTo('/srv/newhome'), first.headers['x-anas-confirm-code'] as string)).json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZFS && c.args[0] === 'set'))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      [`zpool:${TESTPOOL_GUID}`, 'exclusive'],
      ['zname:testpool', 'shared'],
      ['mount:/srv/newhome', 'exclusive'],
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  /** Pause `zpool <verb>` (or `zfs:<verb>`) inside its job until the returned release is called. */
  function pause(verb: string): () => void {
    let release!: () => void
    paused.set(verb, new Promise<void>((resolve) => {
      release = resolve
    }))
    return release
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
  }
})

describe('cr.36 — the pool confirms leave no request field out of the signature', () => {
  it('upgrade, mountpoint, forced create and forced import sign every field', () => {
    assert.deepEqual(POOL_UPGRADE_PRESENTATION_ONLY, {})
    assert.deepEqual(POOL_MOUNTPOINT_PRESENTATION_ONLY, {})
    assert.deepEqual(POOL_CREATE_PRESENTATION_ONLY, {})
    assert.deepEqual(POOL_IMPORT_PRESENTATION_ONLY, {})
  })
})
