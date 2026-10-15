import type { ExecResult } from '../../executor/types.js'
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
 * Story cr.32 review (cr.32r) — hermeticity. `poolRoutes` used to receive
 * `pveStoragePath: process.env.ANAS_STORAGE_CFG` UN-defaulted: a mock-mode
 * test that never set the env read the REAL /etc/pve/storage.cfg on a PVE
 * host. The wiring now resolves the path once — env, then (mock only) the
 * same read-only fixture the mounts routes use — and the pool gates, the
 * iSCSI read layer and the access service all take that resolved path.
 *
 * These tests leave ANAS_STORAGE_CFG UNSET on purpose: that is the case that
 * used to leak. The discriminator is the fixture's `zfspool: datapool`:
 * pool `datapool` — surfaced to the mock by routing `zpool list -j` and its
 * guid read through captures, the pools-guard idiom — is PVE territory per
 * the fixture, and nothing else. On the buggy wiring the same request reads
 * the host file instead: on a host without /etc/pve the config reads
 * UNREADABLE (the fail-closed sentence, not this one), and on a PVE host
 * that does not manage datapool it is a plain CONFIRMATION_REQUIRED.
 *
 * The control leg — the env pointed at an EMPTY file — shows the verdict
 * follows the configured file, so the fixture verdict is the wiring and not
 * a hardcoded answer. Residual, stated honestly: on a host whose real
 * storage.cfg manages `datapool` exactly as the fixture does, no behavior
 * can tell the two files apart; there the wiring line in server.ts is the
 * proof, and this leg still guards every other host shape.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')

const ZPOOL = '/usr/sbin/zpool'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** The raidz capture answers as pool `datapool` — the fixture's zfspool root. */
const LIST_WITH_DATAPOOL = readFileSync(join(FIXTURES, 'zfs/zpool-list-raidz.json'), 'utf-8')
  .split('testpool-rz')
  .join('datapool')
const DATAPOOL_GUID = '11795629151027407901'

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const DESTROY = { method: 'DELETE' as const, url: '/v1/pools/datapool', headers: IDENTITY_HEADERS }
const EXPORT = { method: 'POST' as const, url: '/v1/pools/datapool/export', headers: JSON_HEADERS, payload: '{}' }

describe('cr.32r — the mock never reads the host storage.cfg: with ANAS_STORAGE_CFG unset the fixture answers', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  const saved = process.env.ANAS_STORAGE_CFG

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr32r-hermetic-'))
    delete process.env.ANAS_STORAGE_CFG
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

  /** The dev mock with `datapool` on the node; every other read its own. */
  async function serve(): Promise<void> {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult>, calls: { command: string, args: string[] }[] } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === ZPOOL && args.length === 2 && args[0] === 'list' && args[1] === '-j')
        return ok(LIST_WITH_DATAPOOL)
      if (command === ZPOOL && args[0] === 'get' && args.includes('guid'))
        return ok(DATAPOOL_GUID)
      return orig(command, args, opts)
    }
    await server.ready()
  }

  it('destroy and export of the fixture-managed pool are PVE territory — the readable fixture, not the host', async () => {
    await serve()
    for (const request of [DESTROY, EXPORT]) {
      const res = await server!.inject(request)
      assert.equal(res.statusCode, 409, `${request.method} ${request.url}: ${res.body}`)
      const body = res.json() as { error: { code: string, message: string } }
      assert.equal(body.error.code, 'PVE_MANAGED', body.error.message)
      // The sentence ONLY the fixture's readable `zfspool: datapool` entry
      // produces — not the host file, and not the fail-closed UNREADABLE one.
      assert.match(body.error.message, /PVE storage 'datapool' owns datapool as a storage root/)
      assert.doesNotMatch(body.error.message, /unreadable/i)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a hard refusal offers no code')
    }
    assert.deepEqual(calls.filter(c => (c.command === ZPOOL && ['export', 'destroy', 'labelclear'].includes(c.args[0])) || c.command === WIPEFS || c.command === SGDISK), [])
  })

  it('control: the verdict follows the CONFIGURED file — the env at an empty storage.cfg leaves the same pool to the ordinary confirm', async () => {
    const empty = join(dir, 'empty-storage.cfg')
    await writeFile(empty, '', 'utf-8')
    process.env.ANAS_STORAGE_CFG = empty
    await serve()
    for (const request of [DESTROY, EXPORT]) {
      const res = await server!.inject(request)
      assert.equal(res.statusCode, 409, `${request.method} ${request.url}: ${res.body}`)
      const body = res.json() as { error: { code: string, message: string } }
      assert.equal(body.error.code, 'CONFIRMATION_REQUIRED', body.error.message)
      assert.ok(res.headers['x-anas-confirm-code'], 'an ordinary confirm challenge')
    }
  })
})
