import type { IscsiHealth, IscsiSessionList, IscsiTargetDetail, IscsiTargetList } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { IscsiHealth as IscsiHealthSchema, IscsiSessionList as IscsiSessionListSchema, IscsiTargetDetail as IscsiTargetDetailSchema, IscsiTargetList as IscsiTargetListSchema } from '@anas/shared'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

const GT_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

async function get<T>(
  server: ReturnType<typeof createServer>,
  url: string,
): Promise<{ statusCode: number, data?: T, error?: { code: string, message: string } }> {
  const res = await server.inject({ method: 'GET', url })
  const body = res.json() as { data?: T, error?: { code: string, message: string } }
  return { statusCode: res.statusCode, ...body }
}

/**
 * The routes read their paths from the environment at registration time, so a
 * server is built per test after the env is pointed at a materialised capture.
 * Nothing here touches the real kernel or /etc.
 */
describe('GET /v1/iscsi/* — the read layer against the real captures', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
    initiator: process.env.ANAS_ISCSI_INITIATOR_NAME,
  }

  async function serve(opts: { manifest?: string, saveconfig?: string } = {}) {
    if (opts.manifest) {
      const root = join(dir, 'target')
      await materializeConfigfsManifest(loadFixture(opts.manifest), root)
      process.env.ANAS_ISCSI_CONFIGFS = root
    }
    else {
      process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'absent-configfs')
    }
    process.env.ANAS_ISCSI_SAVECONFIG = opts.saveconfig
      ? join(fixturesDir, opts.saveconfig)
      : join(dir, 'absent-saveconfig.json')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
    // Absent by default: a test host has no open-iscsi state, and the read
    // must fail-open to null on its own.
    process.env.ANAS_ISCSI_INITIATOR_NAME = join(dir, 'absent-initiatorname.iscsi')
    server = createServer({ mock: true, logger: false })
    await server.ready()
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-route-'))
    // A block-device stub so the zvol LUN reports its real 2 GiB size.
    await mkdir(join(dir, 'block', 'zd16'), { recursive: true })
    await writeFile(join(dir, 'block', 'zd16', 'size'), '4194304\n')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [key, saved] of [
      ['ANAS_ISCSI_CONFIGFS', savedEnv.configfs],
      ['ANAS_ISCSI_SYS_BLOCK', savedEnv.block],
      ['ANAS_ISCSI_SAVECONFIG', savedEnv.saveconfig],
      ['ANAS_STORAGE_CFG', savedEnv.storage],
      ['ANAS_ISCSI_INITIATOR_NAME', savedEnv.initiator],
    ] as const) {
      if (saved === undefined)
        delete process.env[key]
      else
        process.env[key] = saved
    }
  })

  it('GET /v1/iscsi/targets lists the target and validates against the shared schema', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get<IscsiTargetList>(server!, '/v1/iscsi/targets')
    assert.equal(res.statusCode, 200)
    assert.equal(IscsiTargetListSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.installed, true)
    assert.equal(res.data!.targets.length, 1)
    const t = res.data!.targets[0]
    assert.equal(t.iqn, GT_IQN)
    assert.equal(t.lunCount, 2)
    assert.equal(t.enabled, true)
    assert.equal(t.ownership, 'foreign')
    assert.equal(t.ownershipReason, 'iqn-not-anas')
    // The summary is a grid row: no detail arrays ride along.
    assert.equal('luns' in t, false)
    // The node's own initiator IQN fails open to null (no open-iscsi state in
    // a test) — the field is present, the value is "none".
    assert.equal(res.data!.nodeInitiatorIqn, null)
  })

  it('GET /v1/iscsi/targets carries the node\'s own initiator IQN from the real file shape', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    // The route resolved the seam's path at registration; the FILE is read at
    // request time, so writing it now is enough.
    await writeFile(join(dir, 'absent-initiatorname.iscsi'), '# This file was created by openscsd.\nInitiatorName=iqn.1993-08.org.debian:01:1dd0a338f783\n')
    const res = await get<IscsiTargetList>(server!, '/v1/iscsi/targets')
    assert.equal(res.statusCode, 200)
    assert.equal(IscsiTargetListSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.nodeInitiatorIqn, 'iqn.1993-08.org.debian:01:1dd0a338f783')
  })

  it('GET /v1/iscsi/targets/:iqn returns the detail for a URL-encoded IQN', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get<IscsiTargetDetail>(server!, `/v1/iscsi/targets/${encodeURIComponent(GT_IQN)}`)
    assert.equal(res.statusCode, 200)
    assert.equal(IscsiTargetDetailSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.iqn, GT_IQN)
    assert.equal(res.data!.luns.length, 2)
    assert.equal(res.data!.luns[0].serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
    // The zvol LUN's size comes from the stubbed sysfs block root (a block
    // backstore's configfs `info` reports none); the fileio LUN's from `info`.
    assert.equal(res.data!.luns[0].size, 2 * 1024 * 1024 * 1024)
    assert.equal(res.data!.luns[1].size, 1073741824)
    assert.equal(res.data!.acls.length, 2)
    // Never a secret, at any depth.
    const serialised = JSON.stringify(res.data)
    assert.equal(serialised.includes('REDACTED-16char'), false)
    assert.equal(serialised.includes('password'), false)
  })

  it('the IQN really is percent-encoded in the request path', () => {
    // The `:` in an IQN is what makes the encoding load-bearing; the gateway
    // forwards the encoded form untouched and Fastify decodes the param.
    assert.equal(encodeURIComponent(GT_IQN), 'iqn.2026-08.dev.anas.gtiscsi%3Atarget1')
  })

  it('GET /v1/iscsi/targets/:iqn 404s for an unknown target', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get(server!, `/v1/iscsi/targets/${encodeURIComponent('iqn.2026-08.host.anas:nope')}`)
    assert.equal(res.statusCode, 404)
    assert.equal(res.error!.code, 'NOT_FOUND')
  })

  it('GET /v1/iscsi/targets/:iqn 400s on a name that is not an iSCSI name', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get(server!, '/v1/iscsi/targets/not-an-iqn')
    assert.equal(res.statusCode, 400)
    assert.equal(res.error!.code, 'VALIDATION_ERROR')
  })

  it('GET /v1/iscsi/sessions returns an empty list when nobody is logged in', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get<IscsiSessionList>(server!, '/v1/iscsi/sessions')
    assert.equal(res.statusCode, 200)
    assert.equal(IscsiSessionListSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.installed, true)
    assert.deepEqual(res.data!.sessions, [])
  })

  it('GET /v1/iscsi/sessions is not shadowed by the /targets/:iqn route', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get<IscsiSessionList>(server!, '/v1/iscsi/sessions')
    // A 200 with a `sessions` array proves the sessions handler ran.
    assert.equal(res.statusCode, 200)
    assert.ok(Array.isArray(res.data!.sessions))
  })

  it('GET /v1/iscsi/health reports the restore hole and refuses to look healthy', async () => {
    await serve({ manifest: 'configfs-restore-hole.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get<IscsiHealth>(server!, '/v1/iscsi/health')
    assert.equal(res.statusCode, 200)
    assert.equal(IscsiHealthSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.degraded, true)
    assert.equal(res.data!.missingLuns.length, 1)
    assert.equal(res.data!.missingLuns[0].backstoreName, 'gtiscsi_vol1')
    assert.equal(res.data!.missingLuns[0].lunIndex, 0)
  })

  it('GET /v1/iscsi/health is clean on a fully restored node', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await get<IscsiHealth>(server!, '/v1/iscsi/health')
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.degraded, false)
    assert.deepEqual(res.data!.missingLuns, [])
  })
})

describe('GET /v1/iscsi/* on a node with no LIO — 200 and installed:false, never a 5xx', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-absent-'))
    process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'absent-configfs')
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    server = createServer({ mock: true, logger: false })
    await server.ready()
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (savedEnv.configfs === undefined)
      delete process.env.ANAS_ISCSI_CONFIGFS
    else
      process.env.ANAS_ISCSI_CONFIGFS = savedEnv.configfs
    if (savedEnv.saveconfig === undefined)
      delete process.env.ANAS_ISCSI_SAVECONFIG
    else
      process.env.ANAS_ISCSI_SAVECONFIG = savedEnv.saveconfig
  })

  it('targets: 200, installed:false, empty list, and a reason in words', async () => {
    const res = await get<IscsiTargetList>(server!, '/v1/iscsi/targets')
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.installed, false)
    assert.deepEqual(res.data!.targets, [])
    assert.match(res.data!.reason!, /not present on this node/)
  })

  it('sessions: 200, installed:false, empty list', async () => {
    const res = await get<IscsiSessionList>(server!, '/v1/iscsi/sessions')
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.installed, false)
    assert.deepEqual(res.data!.sessions, [])
  })

  it('health: 200, installed:false, nothing degraded', async () => {
    const res = await get<IscsiHealth>(server!, '/v1/iscsi/health')
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.installed, false)
    assert.equal(res.data!.degraded, false)
    assert.deepEqual(res.data!.missingLuns, [])
    assert.deepEqual(res.data!.portalsWithoutInterface, [])
  })

  it('detail: 404 whose message says the stack is missing', async () => {
    const res = await get(server!, `/v1/iscsi/targets/${encodeURIComponent(GT_IQN)}`)
    assert.equal(res.statusCode, 404)
    assert.match(res.error!.message, /LIO target stack is not present/)
  })
})
