import type { IscsiClaimList } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { anasIqn } from '@anas/shared'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

/**
 * The iSCSI MUTATION routes — the gates, not the sequences (story `iscsi.4`).
 *
 * The `targetcli` argv of every operation is asserted in
 * `services/__tests__/iscsi-mutate.test.ts`, against a MockExecutor it can hold
 * directly. What is proven HERE is everything that happens BEFORE a job is ever
 * submitted, which is where all the safety lives:
 *
 *   - LIO not installed          → a guiding 409 naming the two packages
 *   - a degraded restore         → a 409 naming the missing LUNs (GT-22)
 *   - a foreign target           → 409 hands-off, with the ownership reason
 *   - a live session on a LUN    → 409 with NO confirm bypass (GT-42)
 *   - a shrink                   → 409 with NO confirm bypass (GT-40)
 *   - a target delete            → 409 + X-Anas-Confirm-Code, listing initiators
 *   - destroyBacking             → 409 + confirm code
 *   - a duplicate LUN name       → 409 (the name is the SCSI model string)
 *   - a zvol already exported    → 409 (two LUNs onto one device)
 *
 * The ANAS-owned target is a SYNTHETIC configfs manifest, deliberately labelled
 * as such: every captured fixture from the ground-truth run belongs to the
 * hand-built `gtiscsi` target, whose IQN ANAS did not generate and which is
 * therefore foreign — useful for proving the hands-off gate, useless for
 * proving anything a mutation does.
 */

/**
 * A synthetic ANAS-owned target: one zvol LUN, one ACL, one portal.
 *
 * The IQN is GENERATED with the same function the create route uses, against a
 * pinned node name, rather than written out as a literal — a literal would
 * embed this month's `yyyy-mm` and the collision test would silently stop
 * testing a collision at the start of next month.
 */
const NODE_NAME = 'nas'
const ANAS_IQN = anasIqn('vmstore', { nodeName: NODE_NAME })
const INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
const GT_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'

/** SYNTHETIC (not a capture): the smallest tree the mutation gates need. */
function anasManifest(opts: { session?: boolean } = {}): string {
  const tpg = `iscsi/${ANAS_IQN}/tpgt_1`
  const acl = `${tpg}/acls/${INITIATOR}`
  const lines = [
    'D core',
    'D core/iblock_0',
    'D core/iblock_0/vmdisk1',
    'F core/iblock_0/vmdisk1/udev_path = /dev/zvol/tank/vol1',
    'F core/iblock_0/vmdisk1/enable = 1',
    'F core/iblock_0/vmdisk1/info = Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 32768\\n        iBlock device: zd16  UDEV PATH: /dev/zvol/tank/vol1  readonly: 0\\n        Major: 230 Minor: 16  CLAIMED: IBLOCK',
    'D core/iblock_0/vmdisk1/attrib',
    'F core/iblock_0/vmdisk1/attrib/emulate_tpu = 1',
    'F core/iblock_0/vmdisk1/attrib/emulate_tpws = 1',
    'F core/iblock_0/vmdisk1/attrib/block_size = 512',
    'F core/iblock_0/vmdisk1/attrib/emulate_write_cache = 0',
    'F core/iblock_0/vmdisk1/attrib/max_unmap_lba_count = 524288',
    'D core/iblock_0/vmdisk1/wwn',
    'F core/iblock_0/vmdisk1/wwn/vpd_unit_serial = T10 VPD Unit Serial Number: 9bc6e907-6015-4267-be4f-5a0617cb3d71',
    'F core/iblock_0/vmdisk1/wwn/product_id = vmdisk1',
    'F core/iblock_0/vmdisk1/wwn/vendor_id = LIO-ORG',
    'D iscsi',
    `D iscsi/${ANAS_IQN}`,
    `D ${tpg}`,
    `F ${tpg}/enable = 1`,
    `D ${tpg}/attrib`,
    `F ${tpg}/attrib/authentication = 0`,
    `F ${tpg}/attrib/generate_node_acls = 0`,
    `F ${tpg}/attrib/demo_mode_discovery = 0`,
    `F ${tpg}/dynamic_sessions = `,
    `D ${tpg}/np`,
    `D ${tpg}/np/192.168.200.50:3260`,
    `D ${tpg}/lun`,
    `D ${tpg}/lun/lun_0`,
    `L ${tpg}/lun/lun_0/6847ded961 -> ../../../../../../target/core/iblock_0/vmdisk1`,
    `D ${tpg}/acls`,
    `D ${acl}`,
    `D ${acl}/auth`,
    `F ${acl}/auth/userid = `,
    `F ${acl}/auth/password = `,
    `F ${acl}/auth/userid_mutual = `,
    `F ${acl}/auth/password_mutual = `,
    `F ${acl}/auth/authenticate_target = 0`,
    `D ${acl}/lun_0`,
    opts.session
      ? `F ${acl}/info = InitiatorName: ${INITIATOR}\\nInitiatorAlias: anas-pve\\nLIO Session ID: 1   ISID: 0x00 02 3d 00 00 02  TSIH: 1  SessionType: Normal\\nSession State: TARG_SESS_STATE_LOGGED_IN\\n---------------------[iSCSI Session Values]-----------------------\\n----------------------[iSCSI Connections]-------------------------\\nCID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN\\n   Address 192.168.200.60 TCP  StatSN: 0x6916c3e9`
      : `F ${acl}/info = No active iSCSI Session for Initiator Endpoint: ${INITIATOR}`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * SYNTHETIC: the persisted half that matches {@link anasManifest}.
 *
 * `extraLun` adds the GT-21 restore hole. `holeDev` points that hole's backing
 * at a path that EXISTS, which is the only difference between "cannot repair
 * yet" and "repair now" (story `iscsi.5`).
 */
function anasSaveconfig(extraLun = false, holeDev = '/dev/zvol/tank/gone'): string {
  const storageObjects: unknown[] = [{
    name: 'vmdisk1',
    plugin: 'block',
    dev: '/dev/zvol/tank/vol1',
    wwn: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    readonly: false,
    write_back: false,
    attributes: {},
    alua_tpgs: [],
  }]
  const luns: unknown[] = [{ index: 0, storage_object: '/backstores/block/vmdisk1', alias: '6847ded961' }]
  if (extraLun) {
    // A LUN the persisted config has and the kernel does NOT: the GT-21 restore
    // hole, and the reason every mutation must refuse.
    storageObjects.push({
      name: 'ghost',
      plugin: 'block',
      dev: holeDev,
      wwn: 'deadbeef-0000-0000-0000-000000000000',
      readonly: false,
      write_back: false,
      attributes: {},
      alua_tpgs: [],
    })
    luns.push({ index: 1, storage_object: '/backstores/block/ghost', alias: '0000000000' })
  }
  return JSON.stringify({
    fabric_modules: [],
    storage_objects: storageObjects,
    targets: [{
      wwn: ANAS_IQN,
      fabric: 'iscsi',
      parameters: {},
      tpgs: [{
        tag: 1,
        enable: true,
        attributes: { authentication: 0, generate_node_acls: 0, demo_mode_discovery: 0 },
        parameters: {},
        luns,
        node_acls: [{ node_wwn: INITIATOR, mapped_luns: [{ tpg_lun: 0, index: 0, alias: 'aaaaaaaaaa' }] }],
        portals: [{ ip_address: '192.168.200.50', port: 3260 }],
      }],
    }],
  })
}

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': '11111111-2222-4333-8444-555555555555',
}

interface Res {
  statusCode: number
  headers: Record<string, unknown>
  body: { data?: unknown, job?: { id: string }, error?: { code: string, reason?: string, message: string, warnings?: string[] } }
}

describe('the iSCSI mutation routes — every gate before the job', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
    nodename: process.env.ANAS_NODENAME,
  }

  async function serve(opts: { manifest?: string, saveconfigText?: string, saveconfigFixture?: string } = {}) {
    if (opts.manifest) {
      const root = join(dir, 'target')
      await materializeConfigfsManifest(opts.manifest, root)
      process.env.ANAS_ISCSI_CONFIGFS = root
    }
    else {
      process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'absent-configfs')
    }
    if (opts.saveconfigText !== undefined) {
      const p = join(dir, 'saveconfig.json')
      await writeFile(p, opts.saveconfigText)
      process.env.ANAS_ISCSI_SAVECONFIG = p
    }
    else if (opts.saveconfigFixture) {
      process.env.ANAS_ISCSI_SAVECONFIG = join(fixturesDir, opts.saveconfigFixture)
    }
    else {
      process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    }
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
    server = createServer({ mock: true, logger: false })
    await server.ready()
  }

  /** The ANAS-owned tree every mutation test runs against. */
  async function serveAnas(opts: { session?: boolean, hole?: boolean, holeDev?: string } = {}) {
    await serve({
      manifest: anasManifest({ session: opts.session ?? false }),
      saveconfigText: anasSaveconfig(opts.hole ?? false, opts.holeDev),
    })
  }

  async function call(
    method: 'POST' | 'PUT' | 'DELETE' | 'GET',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const res = await server!.inject({
      method,
      url,
      headers: { ...IDENTITY, ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
    return { statusCode: res.statusCode, headers: res.headers as Record<string, unknown>, body: res.json() }
  }

  const targetUrl = (iqn = ANAS_IQN) => `/v1/iscsi/targets/${encodeURIComponent(iqn)}`

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-mut-'))
    await mkdir(join(dir, 'block', 'zd16'), { recursive: true })
    await writeFile(join(dir, 'block', 'zd16', 'size'), '4194304\n')
    // Pin the node name so a generated IQN matches the synthetic fixture's.
    process.env.ANAS_NODENAME = NODE_NAME
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
      ['ANAS_NODENAME', savedEnv.nodename],
    ] as const) {
      if (saved === undefined)
        delete process.env[key]
      else
        process.env[key] = saved
    }
  })

  // --- availability --------------------------------------------------------

  describe('LIO not installed — a guiding refusal, never a stack trace', () => {
    it('names the packages instead of failing obscurely', async () => {
      await serve()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'vmstore',
        portals: [{ address: '192.168.200.50' }],
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'lio-not-installed')
      assert.match(res.body.error!.message, /targetcli-fb python3-rtslib-fb/)
      // Installing them is iscsi.5's story — this only says what is missing.
      assert.ok(!res.headers['x-anas-confirm-code'], 'no confirm bypass for a missing package')
    })

    it('refuses every verb the same way, not just create', async () => {
      await serve()
      for (const [method, url, payload] of [
        ['PUT', targetUrl(), { auth: 'none' }],
        ['POST', `${targetUrl()}/state`, { action: 'disable' }],
        ['DELETE', targetUrl(), undefined],
        ['POST', `${targetUrl()}/luns`, { name: 'x', kind: 'zvol', backing: 'tank/v' }],
        ['PUT', `${targetUrl()}/luns/0`, { size: 1 }],
        ['DELETE', `${targetUrl()}/luns/0`, undefined],
      ] as const) {
        const res = await call(method, url, payload)
        assert.equal(res.statusCode, 409, `${method} ${url}`)
        assert.equal(res.body.error!.reason, 'lio-not-installed', `${method} ${url}`)
      }
    })
  })

  // --- the degraded-restore guard (GT-22) ----------------------------------

  describe('a degraded restore stops EVERY mutation (GT-22)', () => {
    it('refuses with a 409 that names the missing LUN and says what to do', async () => {
      await serveAnas({ hole: true })
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'newdisk',
        kind: 'zvol',
        backing: 'tank/vol2',
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'degraded-restore')
      assert.match(res.body.error!.message, /ghost/)
      assert.match(res.body.error!.message, /\/dev\/zvol\/tank\/gone/)
      assert.match(res.body.error!.message, /saveconfig/)
      // No confirm code: this is not a "are you sure", it is "not until it is
      // healed" — a save here would persist the hole permanently.
      assert.ok(!res.headers['x-anas-confirm-code'])
    })

    it('blocks the harmless-looking verbs too — every sequence ends in saveconfig', async () => {
      await serveAnas({ hole: true })
      const res = await call('POST', `${targetUrl()}/state`, { action: 'disable' })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'degraded-restore')
    })

    it('a healthy tree is not blocked', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/state`, { action: 'disable' })
      assert.equal(res.statusCode, 202)
      assert.ok(res.body.job)
    })
  })

  // --- hands-off -----------------------------------------------------------

  describe('a foreign target is hands-off, and says why', () => {
    it('refuses a mutation on a target ANAS did not create', async () => {
      await serve({ manifest: readFileSync(join(fixturesDir, 'configfs-live.manifest'), 'utf-8'), saveconfigFixture: 'saveconfig-final.json' })
      const res = await call('POST', `${targetUrl(GT_IQN)}/state`, { action: 'disable' })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'foreign-target')
      // The badge explains itself: the message carries the derivation.
      assert.match(res.body.error!.message, /not generated by ANAS/)
    })

    it('reading a foreign target is still allowed — only mutation is refused', async () => {
      await serve({ manifest: readFileSync(join(fixturesDir, 'configfs-live.manifest'), 'utf-8'), saveconfigFixture: 'saveconfig-final.json' })
      const res = await call('GET', targetUrl(GT_IQN))
      assert.equal(res.statusCode, 200)
    })
  })

  // --- create --------------------------------------------------------------

  describe('POST /v1/iscsi/targets', () => {
    it('generates the IQN and accepts the job', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: '192.168.200.50' }],
      })
      assert.equal(res.statusCode, 202)
      assert.ok(res.body.job)
    })

    it('refuses a name whose generated IQN already exists — there is no rename', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'vmstore',
        portals: [{ address: '192.168.200.50' }],
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'target-exists')
      assert.match(res.body.error!.message, /no rename/)
    })

    it('400s a wildcard portal — the threat model in one line', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: '0.0.0.0' }],
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /wildcard/)
    })

    it('400s a link-local portal, which LIO would refuse opaquely (GT-25)', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: 'fe80::1' }],
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /link-local/)
    })

    it('400s an ACL that could never log in under the chosen auth (GT-32)', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: '192.168.200.50' }],
        auth: 'chap',
        acls: [{ initiatorIqn: INITIATOR }],
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /never be able to log in/)
    })

    it('400s a CHAP secret outside the 12–16 byte range LIO does not enforce (GT-34)', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: '192.168.200.50' }],
        auth: 'chap',
        acls: [{ initiatorIqn: INITIATOR, chapUserid: 'alice', chapSecret: 'short' }],
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /12–16 bytes/)
    })

    it('401s without identity headers — anasd never acts for nobody', async () => {
      await serveAnas()
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/iscsi/targets',
        payload: { name: 'other', portals: [{ address: '192.168.200.50' }] },
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- edit ----------------------------------------------------------------

  describe('PUT /v1/iscsi/targets/:iqn', () => {
    it('an untouched edit is accepted and rewrites nothing', async () => {
      await serveAnas()
      const res = await call('PUT', targetUrl(), {})
      assert.equal(res.statusCode, 202)
    })

    it('confirm-gates removing an ACL that has a LIVE session (GT-36)', async () => {
      await serveAnas({ session: true })
      const res = await call('PUT', targetUrl(), { acls: [] })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'], 'this one CAN be confirmed')
      assert.ok(res.body.error!.warnings!.some(w => w.includes(INITIATOR)))
      assert.ok(res.body.error!.warnings!.some(w => /stale/.test(w)))
    })

    it('the confirm code lets it through', async () => {
      await serveAnas({ session: true })
      const first = await call('PUT', targetUrl(), { acls: [] })
      const code = first.headers['x-anas-confirm-code'] as string
      const second = await call('PUT', targetUrl(), { acls: [] }, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
    })

    it('removing an ACL with NO session needs no confirmation', async () => {
      await serveAnas()
      const res = await call('PUT', targetUrl(), { acls: [] })
      assert.equal(res.statusCode, 202)
    })

    it('400s turning CHAP on when a stored ACL has no credentials', async () => {
      await serveAnas()
      const res = await call('PUT', targetUrl(), {
        auth: 'chap',
        acls: [{ initiatorIqn: INITIATOR }],
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /never be able to log in/)
    })

    it('400s an empty portal list — a target with no portal listens nowhere', async () => {
      await serveAnas()
      const res = await call('PUT', targetUrl(), { portals: [] })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /at least one portal/)
    })
  })

  // --- state ---------------------------------------------------------------

  describe('POST /v1/iscsi/targets/:iqn/state', () => {
    it('400s a no-op rather than pretending it did something', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/state`, { action: 'enable' })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /already enabled/)
    })

    it('404s an IQN that is not on this node', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl('iqn.2026-08.nas.anas:nope')}/state`, { action: 'disable' })
      assert.equal(res.statusCode, 404)
    })

    it('400s a string that is not an iSCSI name at all', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/targets/not-an-iqn/state', { action: 'disable' })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- target delete -------------------------------------------------------

  describe('DELETE /v1/iscsi/targets/:iqn', () => {
    it('is always confirm-gated, and lists the initiators it would drop', async () => {
      await serveAnas({ session: true })
      const res = await call('DELETE', targetUrl())
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.ok(res.body.error!.warnings!.some(w => w.includes(INITIATOR)))
      // The consequence is stated: the session drops, the device goes stale.
      assert.ok(res.body.error!.warnings!.some(w => /drops its session/.test(w)))
      // …and so is what is NOT destroyed.
      assert.ok(res.body.error!.warnings!.some(w => /data is NOT destroyed/.test(w)))
    })

    it('is confirm-gated even with no sessions — the IQN goes with it', async () => {
      await serveAnas()
      const res = await call('DELETE', targetUrl())
      assert.equal(res.statusCode, 409)
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.ok(res.body.error!.warnings!.some(w => /repointed/.test(w)))
    })

    it('goes through with the code', async () => {
      await serveAnas()
      const first = await call('DELETE', targetUrl())
      const code = first.headers['x-anas-confirm-code'] as string
      const second = await call('DELETE', targetUrl(), undefined, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
    })
  })

  // --- LUN add -------------------------------------------------------------

  describe('POST /v1/iscsi/targets/:iqn/luns', () => {
    it('refuses a duplicate LUN name — it is the SCSI model string (GT-15)', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'vmdisk1',
        kind: 'zvol',
        backing: 'tank/vol2',
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'name-taken')
      assert.match(res.body.error!.message, /SCSI model string/)
    })

    it('refuses exporting the SAME zvol through a second LUN', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'vmdisk9',
        kind: 'zvol',
        backing: 'tank/vol1',
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'backing-already-mapped')
      assert.match(res.body.error!.message, /two initiators to write to it at once/)
    })

    it('refuses a PVE guest volume', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'guestdisk',
        kind: 'zvol',
        backing: 'tank/vm-101-disk-0',
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'pve-guest-volume')
    })

    it('400s a file LUN with no size — a fileio size is fixed at creation', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'image1',
        kind: 'file',
        backing: 'tank/images',
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /fixed at creation/)
    })

    it('400s a zvol LUN that carries a size — the volume already has one', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'image1',
        kind: 'zvol',
        backing: 'tank/vol2',
        size: 4096,
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /grow the volume/)
    })

    it('400s a block size LIO does not accept', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'image1',
        kind: 'zvol',
        backing: 'tank/vol2',
        blockSize: 3000,
      })
      assert.equal(res.statusCode, 400)
    })

    it('accepts a zvol the read layer has never seen', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'vmdisk2',
        kind: 'zvol',
        backing: 'tank/vol2',
      })
      assert.equal(res.statusCode, 202)
    })
  })

  // --- LUN resize ----------------------------------------------------------

  describe('PUT /v1/iscsi/targets/:iqn/luns/:n', () => {
    it('refuses a resize under a LIVE session, with NO bypass (GT-42)', async () => {
      await serveAnas({ session: true })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 4294967296 })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'session-open')
      assert.match(res.body.error!.message, /no confirm bypass/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'there is no way to confirm past this')
      assert.match(res.body.error!.message, new RegExp(INITIATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('refuses a SHRINK, with NO bypass (GT-40)', async () => {
      await serveAnas()
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 1048576 })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'shrink')
      assert.match(res.body.error!.message, /no confirm bypass/)
      assert.ok(!res.headers['x-anas-confirm-code'])
    })

    it('accepts a grow when nobody is logged in', async () => {
      await serveAnas()
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 4294967296 })
      assert.equal(res.statusCode, 202)
    })

    it('400s an empty body — nothing to change is not a change', async () => {
      await serveAnas()
      const res = await call('PUT', `${targetUrl()}/luns/0`, {})
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /Nothing to change/)
    })

    it('404s a LUN index the target does not have', async () => {
      await serveAnas()
      const res = await call('PUT', `${targetUrl()}/luns/7`, { size: 4294967296 })
      assert.equal(res.statusCode, 404)
    })

    it('400s a LUN index that is not a non-negative integer', async () => {
      await serveAnas()
      const res = await call('PUT', `${targetUrl()}/luns/abc`, { size: 1 })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- LUN delete ----------------------------------------------------------

  describe('DELETE /v1/iscsi/targets/:iqn/luns/:n', () => {
    it('refuses a delete under a LIVE session, with NO bypass (GT-42)', async () => {
      await serveAnas({ session: true })
      const res = await call('DELETE', `${targetUrl()}/luns/0`)
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'session-open')
      assert.ok(!res.headers['x-anas-confirm-code'])
      // The refusal explains that LIO itself would NOT have refused.
      assert.match(res.body.error!.message, /LIO would delete it anyway/)
    })

    it('deletes without confirmation when the backing object is kept', async () => {
      await serveAnas()
      const res = await call('DELETE', `${targetUrl()}/luns/0`)
      assert.equal(res.statusCode, 202)
    })

    it('confirm-gates ?destroyBacking=true, naming the volume and the serial', async () => {
      await serveAnas()
      const res = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`)
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.ok(res.body.error!.warnings!.some(w => /tank\/vol1/.test(w)))
      assert.ok(res.body.error!.warnings!.some(w => /9bc6e907-6015-4267-be4f-5a0617cb3d71/.test(w)))
    })

    it('goes through with the code', async () => {
      await serveAnas()
      const first = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`)
      const code = first.headers['x-anas-confirm-code'] as string
      const second = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`, undefined, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
    })
  })

  // --- the iscsi.6 seam ----------------------------------------------------

  // --- the repair door (story iscsi.5) -------------------------------------

  describe('POST /v1/iscsi/health/repair — the way OUT of a degraded restore', () => {
    it('is the one mutation NOT blocked by the degraded gate', async () => {
      // Every other verb answers `degraded-restore` here. This one has to get
      // past that, or the node is stuck: the gate exists because a save over an
      // incomplete restore is permanent, and repair is what makes it complete.
      await serveAnas({ hole: true, holeDev: join(dir, 'backing-present.img') })
      await writeFile(join(dir, 'backing-present.img'), 'x')
      const res = await call('POST', '/v1/iscsi/health/repair')
      assert.equal(res.statusCode, 202)
      assert.ok(res.body.job)
    })

    it('refuses with a 409 NAMING the paths while the backing is still absent', async () => {
      await serveAnas({ hole: true })
      const res = await call('POST', '/v1/iscsi/health/repair')
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'backing-absent')
      assert.match(res.body.error!.message, /ghost/)
      assert.match(res.body.error!.message, /\/dev\/zvol\/tank\/gone/)
      assert.match(res.body.error!.message, /import the pool, restore the image/)
      // Recreating over an absent device is how the hole was made: no bypass.
      assert.ok(!res.headers['x-anas-confirm-code'])
    })

    it('refuses with a 409 when there is no hole at all', async () => {
      await serveAnas()
      const res = await call('POST', '/v1/iscsi/health/repair')
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'nothing-to-repair')
      assert.match(res.body.error!.message, /already matches the saved one/)
    })

    it('refuses like everything else when LIO is not installed', async () => {
      await serve()
      const res = await call('POST', '/v1/iscsi/health/repair')
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'lio-not-installed')
    })

    it('needs an identity, like every other mutation', async () => {
      await serveAnas({ hole: true })
      const res = await server!.inject({ method: 'POST', url: '/v1/iscsi/health/repair' })
      assert.equal(res.statusCode, 401)
    })
  })

  describe('GET /v1/iscsi/claims — the cross-feature seam', () => {
    it('answers "is this object held by a LUN?" in one call', async () => {
      await serveAnas()
      const res = await call('GET', '/v1/iscsi/claims')
      assert.equal(res.statusCode, 200)
      const data = res.body.data as IscsiClaimList
      assert.equal(data.installed, true)
      assert.equal(data.claims.length, 1)
      assert.equal(data.claims[0].backingPath, '/dev/zvol/tank/vol1')
      assert.equal(data.claims[0].kind, 'zvol')
      assert.equal(data.claims[0].dataset, 'tank/vol1')
      assert.equal(data.claims[0].targetIqn, ANAS_IQN)
      assert.equal(data.claims[0].lunIndex, 0)
      assert.match(data.claims[0].detail, /held by LUN 0/)
    })

    it('reports live sessions on the claim, which is what gates a rollback', async () => {
      await serveAnas({ session: true })
      const res = await call('GET', '/v1/iscsi/claims')
      const data = res.body.data as IscsiClaimList
      assert.deepEqual(data.claims[0].connectedInitiators, [INITIATOR])
    })

    it('is a 200 with installed:false on a node with no LIO, never a 5xx', async () => {
      await serve()
      const res = await call('GET', '/v1/iscsi/claims')
      assert.equal(res.statusCode, 200)
      const data = res.body.data as IscsiClaimList
      assert.equal(data.installed, false)
      assert.deepEqual(data.claims, [])
    })
  })
})
