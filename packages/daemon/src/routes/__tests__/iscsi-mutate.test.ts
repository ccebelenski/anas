import type { IscsiClaimList, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { anasIqn, lunGrowGuidance } from '@anas/shared'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { zfsSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { TARGETCLI, ZFS } from '../../services/iscsi-mutate.js'

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
 *   - a target delete with sessions → 409 `live-sessions`, NO confirm bypass,
 *                                     nothing runs (GT-42)
 *   - a target delete with LUNs     → 409 `target-has-luns`, NO confirm bypass
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
function anasManifest(opts: {
  session?: boolean
  fileLun?: string
  /** The TPG's portals; defaults to the single 192.168.200.50:3260 the other tests expect. */
  portals?: { address: string, port: number }[]
  /** The address the live session's connection came in on (M3/LP6). */
  sessionAddress?: string
} = {}): string {
  const tpg = `iscsi/${ANAS_IQN}/tpgt_1`
  const acl = `${tpg}/acls/${INITIATOR}`
  const portals = opts.portals ?? [{ address: '192.168.200.50', port: 3260 }]
  const sessionAddress = opts.sessionAddress ?? '192.168.200.60'
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
    // A FILE-backed LUN, for the resize gates that turn on the backing KIND
    // (story `iscsi.8` / live-proof F13: a zvol grows live, a file is recreated).
    ...(opts.fileLun
      ? [
          'D core/fileio_1',
          'D core/fileio_1/imgdisk',
          `F core/fileio_1/imgdisk/udev_path = ${opts.fileLun}`,
          'F core/fileio_1/imgdisk/enable = 1',
          `F core/fileio_1/imgdisk/info = Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384\n        TCM FILEIO ID: 1        File: ${opts.fileLun}  Size: 1073741824  Mode: O_DSYNC Async: 0`,
          'D core/fileio_1/imgdisk/attrib',
          'F core/fileio_1/imgdisk/attrib/emulate_tpu = 1',
          'F core/fileio_1/imgdisk/attrib/emulate_tpws = 1',
          'F core/fileio_1/imgdisk/attrib/block_size = 512',
          'F core/fileio_1/imgdisk/attrib/emulate_write_cache = 0',
          'F core/fileio_1/imgdisk/attrib/max_unmap_lba_count = 262144',
          'D core/fileio_1/imgdisk/wwn',
          'F core/fileio_1/imgdisk/wwn/vpd_unit_serial = T10 VPD Unit Serial Number: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          'F core/fileio_1/imgdisk/wwn/product_id = imgdisk',
          'F core/fileio_1/imgdisk/wwn/vendor_id = LIO-ORG',
        ]
      : []),
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
    ...portals.map(p => `D ${tpg}/np/${p.address}:${p.port}`),
    `D ${tpg}/lun`,
    `D ${tpg}/lun/lun_0`,
    `L ${tpg}/lun/lun_0/6847ded961 -> ../../../../../../target/core/iblock_0/vmdisk1`,
    ...(opts.fileLun
      ? [
          `D ${tpg}/lun/lun_1`,
          `L ${tpg}/lun/lun_1/7947ded962 -> ../../../../../../target/core/fileio_1/imgdisk`,
        ]
      : []),
    `D ${tpg}/acls`,
    `D ${acl}`,
    `D ${acl}/auth`,
    `F ${acl}/auth/userid = `,
    `F ${acl}/auth/password = `,
    `F ${acl}/auth/userid_mutual = `,
    `F ${acl}/auth/password_mutual = `,
    `F ${acl}/auth/authenticate_target = 0`,
    `D ${acl}/lun_0`,
    ...(opts.fileLun ? [`D ${acl}/lun_1`] : []),
    opts.session
      ? `F ${acl}/info = InitiatorName: ${INITIATOR}\\nInitiatorAlias: anas-pve\\nLIO Session ID: 1   ISID: 0x00 02 3d 00 00 02  TSIH: 1  SessionType: Normal\\nSession State: TARG_SESS_STATE_LOGGED_IN\\n---------------------[iSCSI Session Values]-----------------------\\n----------------------[iSCSI Connections]-------------------------\\nCID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN\\n   Address ${sessionAddress} TCP  StatSN: 0x6916c3e9`
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
function anasSaveconfig(extraLun = false, holeDev = '/dev/zvol/tank/gone', fileLun?: string): string {
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
  if (fileLun) {
    storageObjects.push({
      name: 'imgdisk',
      plugin: 'fileio',
      dev: fileLun,
      size: 1073741824,
      wwn: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      readonly: false,
      write_back: false,
      attributes: {},
      alua_tpgs: [],
    })
    luns.push({ index: 1, storage_object: '/backstores/fileio/imgdisk', alias: '7947ded962' })
  }
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
        node_acls: [{
          node_wwn: INITIATOR,
          mapped_luns: fileLun
            ? [{ tpg_lun: 0, index: 0, alias: 'aaaaaaaaaa' }, { tpg_lun: 1, index: 1, alias: 'bbbbbbbbbb' }]
            : [{ tpg_lun: 0, index: 0, alias: 'aaaaaaaaaa' }],
        }],
        portals: [{ ip_address: '192.168.200.50', port: 3260 }],
      }],
    }],
  })
}

/**
 * SYNTHETIC: the same ANAS target with NO backstores and NO LUNs — the only
 * state a target delete may run on.
 */
function emptyAnasManifest(): string {
  const tpg = `iscsi/${ANAS_IQN}/tpgt_1`
  const acl = `${tpg}/acls/${INITIATOR}`
  const lines = [
    'D core',
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
    `D ${tpg}/acls`,
    `D ${acl}`,
    `D ${acl}/auth`,
    `F ${acl}/auth/userid = `,
    `F ${acl}/auth/password = `,
    `F ${acl}/auth/userid_mutual = `,
    `F ${acl}/auth/password_mutual = `,
    `F ${acl}/auth/authenticate_target = 0`,
    `F ${acl}/info = No active iSCSI Session for Initiator Endpoint: ${INITIATOR}`,
  ]
  return `${lines.join('\n')}\n`
}

/** SYNTHETIC: the persisted half of the empty target. */
function emptyAnasSaveconfig(): string {
  return JSON.stringify({
    fabric_modules: [],
    storage_objects: [],
    targets: [{
      wwn: ANAS_IQN,
      fabric: 'iscsi',
      parameters: {},
      tpgs: [{
        tag: 1,
        enable: true,
        attributes: { authentication: 0, generate_node_acls: 0, demo_mode_discovery: 0 },
        parameters: {},
        luns: [],
        node_acls: [{
          node_wwn: INITIATOR,
          mapped_luns: [],
        }],
        portals: [{ ip_address: '192.168.200.50', port: 3260 }],
      }],
    }],
  })
}

/**
 * SYNTHETIC `zfs list -j -t snapshot` output for one dataset (M5).
 *
 * The shape is the captured fixture's, trimmed to what `parseSnapshotNames`
 * reads: the envelope, and one `datasets` entry per snapshot.
 */
function snapshotListJson(dataset: string, names: string[]): string {
  const datasets: Record<string, unknown> = {}
  for (const n of names) {
    datasets[`${dataset}@${n}`] = {
      name: `${dataset}@${n}`,
      type: 'SNAPSHOT',
      pool: dataset.split('/')[0],
      createtxg: '100',
      dataset,
      snapshot_name: n,
      properties: {},
    }
  }
  return JSON.stringify({ output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 }, datasets })
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

/** A node of the `lsblk -J` tree, as far as a mountpoint walk needs. */
interface LsblkNode {
  type?: string
  mountpoint?: string
  children?: LsblkNode[]
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
    initiator: process.env.ANAS_ISCSI_INITIATOR_NAME,
    fstab: process.env.ANAS_FSTAB_PATH,
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
    // Absent by default: a test host has no open-iscsi state, and the read
    // must fail-open to null on its own. The FILE is read at request time, so
    // a test that wants a value writes this exact path before the call.
    process.env.ANAS_ISCSI_INITIATOR_NAME = join(dir, 'absent-initiatorname.iscsi')
    server = createServer({ mock: true, logger: false })
    await server.ready()
  }

  function mockOf(): MockExecutor {
    return (server as unknown as { executor: MockExecutor }).executor
  }

  async function waitForJob(id: string): Promise<Job> {
    for (let i = 0; i < 200; i++) {
      const res = await call('GET', `/v1/jobs/${id}`)
      const { job } = res.body as unknown as { job: Job }
      if (job.status === 'completed' || job.status === 'failed')
        return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Job ${id} did not finish`)
  }

  /** The ANAS-owned tree every mutation test runs against. */
  async function serveAnas(opts: { session?: boolean, hole?: boolean, holeDev?: string, fileLun?: string } = {}) {
    await serve({
      manifest: anasManifest({ session: opts.session ?? false, ...(opts.fileLun ? { fileLun: opts.fileLun } : {}) }),
      saveconfigText: anasSaveconfig(opts.hole ?? false, opts.holeDev, opts.fileLun),
    })
  }

  /** The ANAS-owned EMPTY target — the only state a target delete may run on. */
  async function serveEmpty() {
    await serve({ manifest: emptyAnasManifest(), saveconfigText: emptyAnasSaveconfig() })
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
      ['ANAS_ISCSI_INITIATOR_NAME', savedEnv.initiator],
      ['ANAS_FSTAB_PATH', savedEnv.fstab],
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
        // A target with no ACLs is refused — discovery is closed, so the
        // list is never optional at create.
        acls: [{ initiatorIqn: INITIATOR }],
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

    it('refuses an EMPTY initiator ACL list — a target nobody is listed on is invisible to everyone', async () => {
      await serveAnas()
      // The file is read at request time, so writing the seam's path now is
      // enough: the refusal then names this node's own IQN.
      await writeFile(join(dir, 'absent-initiatorname.iscsi'), 'InitiatorName=iqn.1993-08.org.debian:01:1dd0a338f783\n')
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: '192.168.200.50' }],
        acls: [],
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.body.error!.code, 'VALIDATION_ERROR')
      assert.match(res.body.error!.message, /needs at least one initiator ACL/)
      assert.match(res.body.error!.message, /invisible to everyone/)
      assert.match(res.body.error!.message, /iqn\.1993-08\.org\.debian:01:1dd0a338f783/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'a guiding 400, not a confirm gate')
    })

    it('the same refusal without the parenthetical when the node\'s own IQN is unknown', async () => {
      await serveAnas()
      // No file: open-iscsi may simply not be installed. The sentence still
      // says what to do — it just cannot name a value it does not have.
      const res = await call('POST', '/v1/iscsi/targets', {
        name: 'other',
        portals: [{ address: '192.168.200.50' }],
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /needs at least one initiator ACL/)
      assert.ok(!/this node/.test(res.body.error!.message), res.body.error!.message)
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

    it('removing the LAST ACL is accepted — the discovery sentence rides the job result as a warning', async () => {
      await serveAnas()
      // The generic targetcli success lets the sequence (acls delete +
      // saveconfig) complete so the job RESULT — not the 202 — can be read.
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('PUT', targetUrl(), { acls: [] })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as { warnings?: string[] }
      assert.ok(
        result.warnings?.some(w => /needs at least one initiator ACL/.test(w) && /invisible to everyone/.test(w)),
        JSON.stringify(result.warnings),
      )
    })

    it('an edit that KEEPS its ACLs adds no such warning', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('PUT', targetUrl(), { acls: [{ initiatorIqn: INITIATOR }] })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as { warnings?: string[] }
      assert.ok(!result.warnings?.some(w => /needs at least one initiator ACL/.test(w)), JSON.stringify(result.warnings))
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

    // --- M3 / LP6: portal removal under a live session -----------------------
    //
    // A two-portal target, A=192.168.200.50 and B=192.168.200.51, with a live
    // session whose connection came in on one of them. Removing the portal the
    // session came in on is a CONFIRM-with-warnings (LP6): the session survives
    // — LIO drops only the listener — but the initiator's next reconnect through
    // that address fails (iscsiadm error 8). It is NOT a refusal.
    const PORTAL_A = { address: '192.168.200.50', port: 3260 }
    const PORTAL_B = { address: '192.168.200.51', port: 3260 }
    async function serveTwoPortals(sessionAddress: string) {
      await serve({
        manifest: anasManifest({ session: true, portals: [PORTAL_A, PORTAL_B], sessionAddress }),
        saveconfigText: anasSaveconfig(),
      })
    }

    it('confirm-gates removing a portal a live session came in through (M3, LP6)', async () => {
      await serveTwoPortals(PORTAL_A.address)
      const res = await call('PUT', targetUrl(), { portals: [PORTAL_B] })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'], 'a portal removal under a live connection CAN be confirmed')
      const warnings = res.body.error!.warnings!
      // The initiator is named, the removed address:port is named, and the truth
      // from LP6 is stated: session keeps running, reconnect fails with error 8.
      assert.ok(warnings.some(w => w.includes(INITIATOR)), JSON.stringify(warnings))
      assert.ok(warnings.some(w => /192\.168\.200\.50:3260/.test(w)), JSON.stringify(warnings))
      assert.ok(warnings.some(w => /keeps running/.test(w) && /error 8/.test(w)), JSON.stringify(warnings))
      // No overclaim about dropped I/O — the wording never says the session dies.
      assert.ok(!warnings.some(w => /drops the/.test(w) || /disconnect/.test(w)), JSON.stringify(warnings))
    })

    it('the confirm code applies the portal removal', async () => {
      await serveTwoPortals(PORTAL_A.address)
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const first = await call('PUT', targetUrl(), { portals: [PORTAL_B] })
      const code = first.headers['x-anas-confirm-code'] as string
      const second = await call('PUT', targetUrl(), { portals: [PORTAL_B] }, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
      const job = await waitForJob(second.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as { portalsRemoved?: number }
      assert.equal(result.portalsRemoved, 1)
    })

    it('removing a portal that carries NO live connection needs no confirmation', async () => {
      // The session came in on B; A is removed. That initiator can still re-login
      // through its own surviving portal, so there is nothing to warn about.
      await serveTwoPortals(PORTAL_B.address)
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('PUT', targetUrl(), { portals: [PORTAL_B] })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      assert.ok(!res.headers['x-anas-confirm-code'], 'no session on the removed address — no new gate')
    })

    it('adding a portal, or an untouched-portal edit, raises no portal gate', async () => {
      await serveTwoPortals(PORTAL_A.address)
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      // Keep both and add a third — nothing is removed, so nothing to confirm.
      const res = await call('PUT', targetUrl(), {
        portals: [PORTAL_A, PORTAL_B, { address: '192.168.200.52', port: 3260 }],
      })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      assert.ok(!res.headers['x-anas-confirm-code'])
    })

    it('a combined ACL-and-portal removal is ONE challenge carrying BOTH warnings (M3)', async () => {
      await serveTwoPortals(PORTAL_A.address)
      const res = await call('PUT', targetUrl(), { acls: [], portals: [PORTAL_B] })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      const warnings = res.body.error!.warnings!
      // Both surface in the one challenge, not two sequential ones.
      assert.ok(warnings.some(w => /session drops the moment the ACL is removed/.test(w)), `ACL warning: ${JSON.stringify(warnings)}`)
      assert.ok(warnings.some(w => /error 8/.test(w)), `portal warning: ${JSON.stringify(warnings)}`)
      // The single minted code applies the whole edit — one challenge, not two.
      const code = res.headers['x-anas-confirm-code'] as string
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const second = await call('PUT', targetUrl(), { acls: [], portals: [PORTAL_B] }, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202, JSON.stringify(second.body))
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

  describe('DELETE /v1/iscsi/targets/:iqn — an empty, session-free target is the only deletable one', () => {
    it('refuses a target with a LIVE session — names the initiators, no bypass, nothing runs', async () => {
      await serveAnas({ session: true })
      const mock = mockOf()
      const res = await call('DELETE', targetUrl())
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'live-sessions')
      // No confirm code: there is no confirm path left to send one through.
      assert.ok(!res.headers['x-anas-confirm-code'])
      assert.match(res.body.error!.message, new RegExp(INITIATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(res.body.error!.message, /Log the initiators out first/)
      // Nothing ran: the read layer never calls targetcli, so any targetcli
      // call at all would be the delete sequence — and it must not be there.
      assert.equal(
        mock.calls.filter(c => c.command === TARGETCLI).length,
        0,
        JSON.stringify(mock.calls.map(c => [c.command, c.args])),
      )
    })

    it('does not honour a confirm code — the gate is gone entirely', async () => {
      await serveAnas({ session: true })
      const res = await call('DELETE', targetUrl(), undefined, { 'x-anas-confirm': 'a-code-from-nowhere' })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'live-sessions')
      assert.ok(!res.headers['x-anas-confirm-code'])
    })

    it('refuses a target that still has LUNs — names them and says delete them first', async () => {
      await serveAnas()
      const mock = mockOf()
      const res = await call('DELETE', targetUrl())
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'target-has-luns')
      assert.ok(!res.headers['x-anas-confirm-code'])
      assert.match(res.body.error!.message, /vmdisk1/)
      assert.match(res.body.error!.message, /Delete the LUNs first/)
      assert.match(res.body.error!.message, /destroyBacking/)
      assert.equal(mock.calls.filter(c => c.command === TARGETCLI).length, 0)
    })

    it('deletes an EMPTY, session-free target — no confirm at all, exact argv', async () => {
      await serveEmpty()
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('DELETE', targetUrl())
      assert.equal(res.statusCode, 202)
      assert.ok(!res.headers['x-anas-confirm-code'], 'an empty target is not data-destroying — no confirm gate')
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(job.result, { iqn: ANAS_IQN })
      // The whole sequence, nothing more: delete the target, save. An empty
      // target has no backstores of its own, so there is no cleanup to assert.
      assert.deepEqual(
        mock.calls.filter(c => c.command === TARGETCLI).map(c => c.args),
        [
          ['/iscsi', 'delete', ANAS_IQN],
          ['saveconfig'],
        ],
      )
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

    // M4: a POOL is not a volume. `/dev/zvol/tank` is not a device node, so the
    // old code answered 202 and the job died inside `targetcli` with an opaque
    // message. The refusal has to happen at the door, and say what to type.
    it('refuses a POOL name as a zvol backing — no job, and it names the <pool>/<volume> form', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'pooldisk',
        kind: 'zvol',
        backing: 'tank',
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'not-a-volume')
      assert.match(res.body.error!.message, /<pool>\/<volume>/)
      assert.ok(!res.body.job, 'nothing may be queued for a backing that cannot exist')
      assert.equal(mockOf().calls.filter(c => c.command === TARGETCLI).length, 0, JSON.stringify(mockOf().calls))
    })

    it('refuses the spelled-out /dev/zvol/<pool> form too — same door, same answer', async () => {
      await serveAnas()
      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'pooldisk',
        kind: 'zvol',
        backing: '/dev/zvol/tank',
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'not-a-volume')
    })

    it('accepts an AHR pool NAME as a file backing — the image lands under the pool\'s mountpoint', async () => {
      // The pool's "mountpoint" is a real temp directory: the job's
      // createSparseImage is real file I/O, and the point of the test is that
      // the NAME resolved onto it. fstab is pointed at a temp file so the
      // boot-ordering step (iscsi.8) the same job runs never touches the host's.
      const mountDir = join(dir, 'ahr0')
      await mkdir(mountDir, { recursive: true })
      process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
      await writeFile(join(dir, 'fstab'), '')
      await serveAnas()
      const mock = mockOf()
      // The MockExecutor is first-match, and serveAnas() already registered the
      // fixture pool MOUNTED at /mnt/anas-ahr/ahr0 — both as the findmnt entry
      // and as the LVM nodes' mountpoints, the two sources the topology reader
      // consults for a pool's mount. Those would shadow everything added here
      // and the image would land under /mnt/anas-ahr/ahr0, not the temp dir
      // this test points the name at. Clear the defaults and re-register the
      // AHR reads with BOTH sources agreeing on the temp mountpoint.
      mock.clearFixtures()
      const lsblk = JSON.parse(mockFixtures.ahrLsblk().stdout) as { blockdevices: LsblkNode[] }
      const pointMounts = (nodes: LsblkNode[]): void => {
        for (const n of nodes) {
          if (n.type === 'lvm')
            n.mountpoint = mountDir
          if (n.children)
            pointMounts(n.children)
        }
      }
      pointMounts(lsblk.blockdevices)
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
      mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
      mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
      mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: { stdout: JSON.stringify(lsblk), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
      mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
      mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
      mock.addFixture({ command: '/usr/sbin/pvs', args: PVS_ARGS, result: mockFixtures.ahrPvs() })
      mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: {
        stdout: JSON.stringify({ filesystems: [{ target: mountDir, source: '/dev/mapper/ahr0-ahr0--vol', fstype: 'btrfs', options: 'rw,relatime,subvolid=5,subvol=/' }] }),
        stderr: '',
        exitCode: 0,
      } })

      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'ahrimg',
        kind: 'file',
        backing: 'ahr0',
        size: 1024 * 1024,
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed')

      // The image exists under the pool's MOUNTPOINT — the name resolved there.
      const img = await stat(join(mountDir, 'ahrimg.raw'))
      assert.equal(img.size, 1024 * 1024)
      // …and the backstore LIO was told about points at that same path.
      const create = mock.calls.find(c => c.command === TARGETCLI
        && c.args.includes('/backstores/fileio')
        && c.args.join(' ').includes('name=ahrimg'))
      assert.ok(create, 'the fileio backstore create was issued')
      assert.ok(create!.args.join(' ').includes(`file_or_dev=${join(mountDir, 'ahrimg.raw')}`))
    })

    it('refuses an UNMOUNTED AHR pool name before the job — naming it, saying to mount it', async () => {
      process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
      await writeFile(join(dir, 'fstab'), '')
      await serveAnas()
      const mock = mockOf()
      // First-match again: without the clear the server-registered findmnt
      // still shows the pool mounted and the refusal below never fires. Both
      // sources the reader consults for a mount must agree on "none" — the
      // findmnt list is empty AND no lsblk LVM node carries a mountpoint.
      mock.clearFixtures()
      mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
      mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
      mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
      const lsblk = JSON.parse(mockFixtures.ahrLsblk().stdout) as { blockdevices: LsblkNode[] }
      const clearMounts = (nodes: LsblkNode[]): void => {
        for (const n of nodes) {
          if (n.type === 'lvm')
            n.mountpoint = undefined
          if (n.children)
            clearMounts(n.children)
        }
      }
      clearMounts(lsblk.blockdevices)
      mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: { stdout: JSON.stringify(lsblk), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
      mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
      mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
      mock.addFixture({ command: '/usr/sbin/pvs', args: PVS_ARGS, result: mockFixtures.ahrPvs() })
      mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })

      const res = await call('POST', `${targetUrl()}/luns`, {
        name: 'ahrimg',
        kind: 'file',
        backing: 'ahr0',
        size: 1024 * 1024,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'ahr-pool-unmounted')
      assert.match(res.body.error!.message, /'ahr0' is an AHR pool, but it is not mounted — mount it first, then place the image/)
    })
  })

  // --- LUN resize ----------------------------------------------------------

  describe('PUT /v1/iscsi/targets/:iqn/luns/:n', () => {
    // Live-proof F13: the two doors used to disagree about the SAME safe
    // operation. `PUT /pools/:pool/datasets/:name {volsize}` accepted a grow of a
    // held zvol (iscsi.3 allows it, and it is live end to end — measured), while
    // this door refused every resize under a session. A user who met the iSCSI
    // refusal first concluded it could not be done.
    it('ALLOWS growing a zvol LUN under a live session — it is live, and the other door already allows it', async () => {
      await serveAnas({ session: true })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 4294967296 })
      assert.equal(res.statusCode, 202)
    })

    it('still refuses a FILE-backed resize under a live session — it is a recreate, not a grow', async () => {
      await serveAnas({ session: true, fileLun: '/tank/images/imgdisk.raw' })
      const res = await call('PUT', `${targetUrl()}/luns/1`, { size: 4294967296 })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'session-open')
      assert.match(res.body.error!.message, /size is fixed at creation/)
      assert.match(res.body.error!.message, /no confirm bypass/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'there is no way to confirm past this')
      assert.match(res.body.error!.message, new RegExp(INITIATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('still refuses a WRITE-CACHE change under a live session (GT-42)', async () => {
      await serveAnas({ session: true })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { writeBack: true })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'session-open')
      assert.match(res.body.error!.message, /write cache/i)
    })

    /**
     * The same ANAS target, but the zvol's sysfs size file is gone — the exact
     * shape of M2 (#53): `lun.size` reads back null, and no gate below may take
     * that as "therefore a grow".
     */
    async function serveAnasUnreadableSize(opts: { session?: boolean } = {}) {
      await serveAnas(opts)
      await rm(join(dir, 'block', 'zd16', 'size'))
    }

    it('refuses ANY size change when the current size could not be read — it cannot be proven a grow (M2 #53)', async () => {
      await serveAnasUnreadableSize()
      const mock = mockOf()
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 1048576 })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'size-unknown')
      assert.match(res.body.error!.message, /cannot prove/)
      assert.match(res.body.error!.message, /no confirm bypass/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'there is no way to confirm past this')
      // The old code took the null size as a grow and ran a direction-blind
      // `zfs set volsize=` — a silent truncation. Nothing may have run.
      assert.equal(
        mock.calls.filter(c => c.command === TARGETCLI || c.command === ZFS).length,
        0,
        JSON.stringify(mock.calls.map(c => [c.command, c.args])),
      )
    })

    it('refuses a size change on an unreadable-size LUN even UNDER a live session — the zvol exemption cannot vouch for it (M2 #53)', async () => {
      await serveAnasUnreadableSize({ session: true })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 4294967296 })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'size-unknown')
      assert.ok(!res.headers['x-anas-confirm-code'])
    })

    it('a combined {size, writeBack} on a zvol runs BOTH the grow and the cache change (M1)', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 4294967296, writeBack: true })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      // The grow ran…
      assert.ok(
        mock.calls.some(c => c.command === ZFS && c.args.join(' ').includes('volsize=4294967296')),
        JSON.stringify(mock.calls.map(c => [c.command, c.args])),
      )
      // …AND the emulate_write_cache change the audit params and the ON warning
      // both claim — the old code ran the grow only.
      assert.ok(
        mock.calls.some(c => c.command === TARGETCLI && c.args.includes('emulate_write_cache=1')),
        JSON.stringify(mock.calls.map(c => [c.command, c.args])),
      )
      const result = job.result as { warnings?: string[] }
      assert.ok(result.warnings?.some(w => /Write-back caching is ON/.test(w)), JSON.stringify(result.warnings))
      // A combined request is still a grow, so it carries the guest guidance too.
      assert.ok(result.warnings?.includes(lunGrowGuidance(4294967296)), JSON.stringify(result.warnings))
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

    /** Let a resize job run to completion so its RESULT can be read. */
    async function finishedResizeJob(opts: { session?: boolean } = {}) {
      await serveAnas(opts)
      const mock = mockOf()
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { size: 4294967296 })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      return job.result as { warnings?: string[] }
    }

    it('a zvol grow carries the guest guidance as a warning — even when nobody is logged in', async () => {
      const result = await finishedResizeJob()
      assert.ok(result.warnings?.includes(lunGrowGuidance(4294967296)), JSON.stringify(result.warnings))
      // Plain ASCII on purpose: it rides job results, logs and notifications.
      assert.ok(!/[^\x20-\x7E]/.test(lunGrowGuidance(4294967296)))
    })

    it('under a live session it carries the SAME sentence — the old rescan warning is gone (one source)', async () => {
      const result = await finishedResizeJob({ session: true })
      assert.ok(result.warnings?.includes(lunGrowGuidance(4294967296)), JSON.stringify(result.warnings))
      assert.ok(
        !result.warnings?.some(w => /rescans|OLD size/.test(w)),
        `the pre-guidance rescan sentence must not ride the result: ${JSON.stringify(result.warnings)}`,
      )
    })

    it('a write-cache change carries no grow guidance — it is not a grow', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('PUT', `${targetUrl()}/luns/0`, { writeBack: true })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as { warnings?: string[] }
      assert.ok(!result.warnings?.includes(lunGrowGuidance(4294967296)), JSON.stringify(result.warnings))
      // The write-back caveat still rides — only the grow sentence does not.
      assert.ok(result.warnings?.some(w => /Write-back caching is ON/.test(w)), JSON.stringify(result.warnings))
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

    // U1 (#47): the confirmation protects "delete this LUN" — EVERY delete is
    // gated, not just the one that also destroys the backing.
    it('confirm-gates EVERY delete — even with the backing kept, nothing runs yet', async () => {
      await serveAnas()
      const res = await call('DELETE', `${targetUrl()}/luns/0`)
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      // The warnings describe BOTH outcomes: the flag is chosen on the resend,
      // so the challenge has to disclose what each choice does.
      assert.ok(res.body.error!.warnings!.some(w => /9bc6e907-6015-4267-be4f-5a0617cb3d71/.test(w)), JSON.stringify(res.body.error!.warnings))
      assert.ok(res.body.error!.warnings!.some(w => /kept/.test(w) && /tank\/vol1/.test(w)), JSON.stringify(res.body.error!.warnings))
      assert.ok(res.body.error!.warnings!.some(w => /If the backing is destroyed/.test(w)), JSON.stringify(res.body.error!.warnings))
      // No job submitted, and no targetcli reached the executor.
      assert.ok(!res.body.job)
      assert.equal(mockOf().calls.filter(c => c.command === TARGETCLI).length, 0, JSON.stringify(mockOf().calls))
    })

    it('goes through with the code and keeps the backing', async () => {
      await serveAnas()
      mockOf().addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const first = await call('DELETE', `${targetUrl()}/luns/0`)
      const code = first.headers['x-anas-confirm-code'] as string
      // No ?destroyBacking on the resend: the code minted for {target, lun}
      // must verify WITHOUT the flag being part of anything.
      const second = await call('DELETE', `${targetUrl()}/luns/0`, undefined, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
      const job = await waitForJob(second.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal((job.result as { backingDestroyed?: string | null }).backingDestroyed, null)
      assert.ok(!mockOf().calls.some(c => c.command === ZFS), 'no zfs destroy when the backing is kept')
    })

    it('the code minted for {target, lun} verifies WITH ?destroyBacking=true — the flag is not in the signature', async () => {
      await serveAnas()
      mockOf().addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mockOf().addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      const first = await call('DELETE', `${targetUrl()}/luns/0`)
      const code = first.headers['x-anas-confirm-code'] as string
      const second = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`, undefined, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
      const job = await waitForJob(second.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal((job.result as { backingDestroyed?: string | null }).backingDestroyed, 'tank/vol1')
      assert.ok(mockOf().calls.some(c => c.command === ZFS && c.args[0] === 'destroy' && c.args[1] === 'tank/vol1'), JSON.stringify(mockOf().calls))
    })

    // M5: the job runs a PLAIN `zfs destroy` (no `-r`), which refuses a volume
    // that still has snapshots — and it refuses AFTER the LUN is unmapped and
    // its backstore deleted, before `saveconfig`: config drift with an opaque
    // error attached. The snapshots are checked at the door instead.
    it('refuses ?destroyBacking=true on a zvol that has snapshots, NAMING them, before the confirm gate', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({
        command: ZFS,
        args: zfsSnapshotListArgs('tank/vol1'),
        result: { stdout: snapshotListJson('tank/vol1', ['daily-2026-09-01', 'daily-2026-09-02']), stderr: '', exitCode: 0 },
      })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      const res = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`)
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'zvol-has-snapshots')
      assert.match(res.body.error!.message, /tank\/vol1@daily-2026-09-01/)
      assert.match(res.body.error!.message, /tank\/vol1@daily-2026-09-02/)
      assert.match(res.body.error!.message, /Datasets screen/)
      // Not a confirm challenge, and not a job: nothing may be unmapped for a
      // destroy that cannot finish.
      assert.notEqual(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(!res.headers['x-anas-confirm-code'], 'there is no way to confirm past this')
      assert.ok(!res.body.job)
      assert.equal(mock.calls.filter(c => c.command === TARGETCLI).length, 0, JSON.stringify(mock.calls))
      assert.ok(!mock.calls.some(c => c.command === ZFS && c.args[0] === 'destroy'), JSON.stringify(mock.calls))
    })

    it('the confirm warning promises the VOLUME only — never "every snapshot under it"', async () => {
      await serveAnas()
      const res = await call('DELETE', `${targetUrl()}/luns/0`)
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      const warnings = res.body.error!.warnings!
      assert.ok(
        !warnings.some(w => /every snapshot under it will be destroyed/.test(w)),
        `the job runs a plain zfs destroy — the warning must not promise a recursive one: ${JSON.stringify(warnings)}`,
      )
      assert.ok(
        warnings.some(w => /snapshots are NOT destroyed with it/.test(w)),
        JSON.stringify(warnings),
      )
    })

    it('a snapshot-free zvol still destroys — the pre-check is a gate, not a wall', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: ZFS, args: zfsSnapshotListArgs('tank/vol1'), result: { stdout: snapshotListJson('tank/vol1', []), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      const first = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`)
      assert.equal(first.body.error!.code, 'CONFIRMATION_REQUIRED')
      const code = first.headers['x-anas-confirm-code'] as string
      const second = await call('DELETE', `${targetUrl()}/luns/0?destroyBacking=true`, undefined, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
      const job = await waitForJob(second.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      // Still a PLAIN destroy: the fix is a pre-check, NOT a silent `-r`.
      const destroy = mock.calls.find(c => c.command === ZFS && c.args[0] === 'destroy')
      assert.deepEqual(destroy?.args, ['destroy', 'tank/vol1'])
    })

    it('a wrong code 409s again — a fresh challenge, and nothing has run', async () => {
      await serveAnas()
      const first = await call('DELETE', `${targetUrl()}/luns/0`)
      assert.equal(first.statusCode, 409)
      const second = await call('DELETE', `${targetUrl()}/luns/0`, undefined, { 'x-anas-confirm': 'not-a-code' })
      assert.equal(second.statusCode, 409)
      assert.equal(second.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(second.headers['x-anas-confirm-code'])
      assert.notEqual(second.headers['x-anas-confirm-code'], 'not-a-code')
      assert.ok(!second.body.job)
      assert.equal(mockOf().calls.filter(c => c.command === TARGETCLI).length, 0, JSON.stringify(mockOf().calls))
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
      assert.match(data.claims[0].detail, /held by iSCSI LUN 0 '.+' of target/)
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
