import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'
import { POOL_DESTROY_PRESENTATION_ONLY, POOL_EXPORT_PRESENTATION_ONLY } from '../pools.js'

/**
 * Story cr.32 — pool export and destroy on the guard (docs/WAVE3-DESIGN.md
 * §2.1 rows "pool export" / "pool destroy", §8.2). The H8 property itself:
 * a gate that would refuse at the route but only becomes true AFTER the
 * operator confirmed — while the job waits in the queue — refuses the job,
 * and the mock executor shows no mutating argv.
 *
 * The job is held in the REAL queue: four placeholder jobs fill the four
 * slots, the confirmed request is submitted behind them (`queued`), the test
 * changes the node's state, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). Each state flip serves
 * a capture, with the one rewrite it needs spelled out at the call site:
 *  - LIO: `iscsi/configfs-restore-empty.manifest` (a target, no LUNs) at the
 *    confirm; `iscsi/configfs-live.manifest` with its zvol LUN's `udev_path`
 *    re-pointed from `gtiscsi/vol1` to the dev mock's pool (`testpool/vol1`)
 *    when the job runs.
 *  - the mount table: `mounts/findmnt-full.json` (the dev mock's own answer)
 *    at the confirm; the same capture with its one nested ZFS row
 *    (`mnttest/data` at `/mnttest/data`) re-pointed to `testpool/var` at
 *    `/var` when the job runs.
 *  - the pool's leaves: `zfs/zpool-status-online-fresh.json` (one mirror) at
 *    the confirm, `zfs/zpool-status-online.json` (two mirrors + a spare) when
 *    the job runs — a disk joined the pool.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZPOOL = '/usr/sbin/zpool'
const FINDMNT = '/usr/bin/findmnt'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'
const SYSTEMCTL = '/usr/bin/systemctl'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const LIO_NO_LUNS = fixture('iscsi/configfs-restore-empty.manifest')
const LIO_LUN_ON_TESTPOOL = rewrite(fixture('iscsi/configfs-live.manifest'), '= /dev/zvol/gtiscsi/vol1', '= /dev/zvol/testpool/vol1')

const FINDMNT_FULL = fixture('mounts/findmnt-full.json')
const FINDMNT_TESTPOOL_AT_VAR = rewrite(
  rewrite(FINDMNT_FULL, '"target": "/mnttest/data"', '"target": "/var"'),
  '"source": "mnttest/data"',
  '"source": "testpool/var"',
)

const STATUS_ONE_MIRROR = fixture('zfs/zpool-status-online-fresh.json')
const STATUS_TWO_MIRRORS_AND_SPARE = fixture('zfs/zpool-status-online.json')

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** A call that would mean export, destroy, the cleanup or the unit edit acted. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return (c.command === ZPOOL && ['export', 'destroy', 'labelclear'].includes(c.args[0]))
    || c.command === WIPEFS || c.command === SGDISK
    || (c.command === SYSTEMCTL && c.args[0] === 'disable')
}

interface Verb {
  name: 'export' | 'destroy'
  method: 'POST' | 'DELETE'
  url: string
  headers: Record<string, string>
  payload?: string
}
const EXPORT: Verb = { name: 'export', method: 'POST', url: '/v1/pools/testpool/export', headers: JSON_HEADERS, payload: '{}' }
const DESTROY: Verb = { name: 'destroy', method: 'DELETE', url: '/v1/pools/testpool?cleanup=true', headers: IDENTITY_HEADERS }

describe('cr.32 — pool export and destroy re-gate in the job (ruling (j))', () => {
  let dir: string
  let configfs: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** What the node answers right now; a test flips these while the job waits. */
  let findmnt = FINDMNT_FULL
  let zpoolStatus = STATUS_ONE_MIRROR

  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr32-race-'))
    configfs = join(dir, 'target')
    findmnt = FINDMNT_FULL
    zpoolStatus = STATUS_ONE_MIRROR
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of [
      ['ANAS_ISCSI_CONFIGFS', savedEnv.configfs],
      ['ANAS_ISCSI_SYS_BLOCK', savedEnv.block],
      ['ANAS_ISCSI_SAVECONFIG', savedEnv.saveconfig],
      ['ANAS_STORAGE_CFG', savedEnv.storage],
    ] as const) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  /** The dev mock, its LIO tree the LUN-less capture, reads routed through the flippable state. */
  async function serve(): Promise<void> {
    findmnt = FINDMNT_FULL
    zpoolStatus = STATUS_ONE_MIRROR
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(LIO_NO_LUNS, configfs)
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === FINDMNT && args.length === 1 && args[0] === '--json')
        return ok(findmnt)
      if (command === ZPOOL && args.length === 2 && args[0] === 'status' && args[1] === '-jv')
        return ok(zpoolStatus)
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /**
   * Challenge, then resend with the code while all four slots are held: the
   * confirmed job is accepted and sits `queued`. Returns its id and the
   * release for the slots.
   */
  async function confirmBehindFullQueue(verb: Verb): Promise<{ id: string, release: () => void }> {
    const first = await server!.inject({ method: verb.method, url: verb.url, headers: verb.headers, payload: verb.payload })
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const res = await server!.inject({
      method: verb.method,
      url: verb.url,
      headers: { ...verb.headers, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
      payload: verb.payload,
    })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the confirmed job waits behind the held slots')
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

  it('control: with nothing changed the held job runs and acts — the harness does not refuse on its own', async () => {
    for (const verb of [EXPORT, DESTROY]) {
      await serve()
      const { id, release } = await confirmBehindFullQueue(verb)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'completed', `${verb.name}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(c => c.command === ZPOOL && c.args[0] === verb.name), `${verb.name} ran`)
      await server!.close()
      server = undefined
    }
  })

  it('a LUN that appears between the confirm and the job refuses BOTH export and destroy — no mutating argv', async () => {
    for (const verb of [EXPORT, DESTROY]) {
      await serve()
      const { id, release } = await confirmBehindFullQueue(verb)
      // A LUN is created on a zvol of the pool while the job waits.
      await rm(configfs, { recursive: true, force: true })
      await materializeConfigfsManifest(LIO_LUN_ON_TESTPOOL, configfs)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed', verb.name)
      assert.equal(job.error?.code, 'CONFLICT', verb.name)
      assert.match(job.error!.message, new RegExp(`^${verb.name === 'export' ? 'Exporting' : 'Destroying'} pool 'testpool' is refused: it is held by iSCSI LUN \\d+ 'gtiscsi_vol1'`))
      assert.match(job.error!.message, /no confirm bypass/)
      assert.deepEqual(calls.filter(isMutation), [], `${verb.name}: no mutating argv`)
      await server!.close()
      server = undefined
    }
  })

  it('a system mount that appears between the confirm and the job refuses BOTH export and destroy — no mutating argv', async () => {
    for (const verb of [EXPORT, DESTROY]) {
      await serve()
      const { id, release } = await confirmBehindFullQueue(verb)
      // A dataset of the pool is mounted at /var while the job waits.
      findmnt = FINDMNT_TESTPOOL_AT_VAR
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed', verb.name)
      assert.equal(job.error?.code, 'CONFLICT', verb.name)
      assert.match(job.error!.message, /\/var/, 'the sentence names the system path that fired')
      assert.deepEqual(calls.filter(isMutation), [], `${verb.name}: no mutating argv`)
      await server!.close()
      server = undefined
    }
  })

  it('the same system mount at the confirm is the route\'s hard 409 — the job and the route share the gate', async () => {
    await serve()
    findmnt = FINDMNT_TESTPOOL_AT_VAR
    for (const verb of [EXPORT, DESTROY]) {
      const res = await server!.inject({ method: verb.method, url: verb.url, headers: verb.headers, payload: verb.payload })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(res.json().error.reason, 'system-pool')
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
    }
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('cleanup binds the leaves it wipes: a disk that joins the pool before the job fails it STATE_CHANGED, nothing wiped', async () => {
    await serve()
    const { id, release } = await confirmBehindFullQueue(DESTROY)
    zpoolStatus = STATUS_TWO_MIRRORS_AND_SPARE
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, /the disks to wipe: scsi-0QEMU_QEMU_HARDDISK_ANAS_\w+-part1, \S+ at the confirmation, the disks to wipe: ata-WDC_/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('the cleanup challenge lists the disks it binds', async () => {
    await serve()
    const res = await server!.inject({ method: 'DELETE', url: DESTROY.url, headers: IDENTITY_HEADERS })
    const warnings = res.json().error.warnings as string[]
    assert.ok(warnings.includes('Disks to wipe: scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1-part1, scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT2-part1.'), warnings.join(' | '))
  })
})

describe('cr.32 — the export and destroy confirms bind the whole request', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('destroy: a resend with a different cleanup is 409 CONFIRM_SCOPE_CHANGED naming the field (both directions)', async () => {
    const srv = createServer({ mock: true, logger: false })
    server = srv
    for (const [from, to, sentence] of [
      ['?cleanup=false', '?cleanup=true', 'You confirmed with cleanup off; this request has cleanup on — confirm again'],
      ['?cleanup=true', '', 'You confirmed with cleanup on; this request has cleanup off — confirm again'],
    ] as const) {
      const first = await srv.inject({ method: 'DELETE', url: `/v1/pools/testpool${from}`, headers: IDENTITY_HEADERS })
      const res = await srv.inject({ method: 'DELETE', url: `/v1/pools/testpool${to}`, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
      assert.deepEqual(res.json().error.changed, ['cleanup'])
      assert.equal(res.json().error.message, sentence)
      assert.ok(res.headers['x-anas-confirm-code'])
    }
    const executor = (srv as unknown as { executor: { calls: { command: string, args: string[] }[] } }).executor
    assert.deepEqual(executor.calls.filter(isMutation), [])
  })

  it('export: a resend with a different force is 409 CONFIRM_SCOPE_CHANGED naming the field; an omitted body signs as force false', async () => {
    server = createServer({ mock: true, logger: false })
    const first = await server.inject({ method: 'POST', url: '/v1/pools/testpool/export', headers: IDENTITY_HEADERS })
    const code = first.headers['x-anas-confirm-code'] as string
    const res = await server.inject({ method: 'POST', url: '/v1/pools/testpool/export', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: '{"force":true}' })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['force'])

    const again = await server.inject({ method: 'POST', url: '/v1/pools/testpool/export', headers: IDENTITY_HEADERS })
    const ok = await server.inject({ method: 'POST', url: '/v1/pools/testpool/export', headers: { ...JSON_HEADERS, 'x-anas-confirm': again.headers['x-anas-confirm-code'] as string }, payload: '{"force":false}' })
    assert.equal(ok.statusCode, 202, ok.body)
  })

  it('neither confirm leaves a request field out of the signature', () => {
    assert.deepEqual(POOL_EXPORT_PRESENTATION_ONLY, {})
    assert.deepEqual(POOL_DESTROY_PRESENTATION_ONLY, {})
  })
})
