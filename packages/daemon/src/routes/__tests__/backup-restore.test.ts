import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { anasIqn } from '@anas/shared'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'
import { volsizeArgs } from '../../services/backup-restore.js'
import { PBC } from '../../services/backup-runner.js'

/**
 * backup2.7 — `POST /v1/backup/restore` (kind `image`): EVERY GATE BEFORE THE JOB.
 *
 * The sequence itself is asserted as a call log in
 * `services/__tests__/backup-restore.test.ts`, against a MockExecutor that test
 * holds directly. What is proven HERE is the pre-flight, in ORDER, and the one
 * property that matters most about it: NOTHING DESTRUCTIVE RUNS until every
 * refusal has had its chance — no `targetcli`, no stream, not even a PBS
 * contact where a local check already answers.
 *
 * The ANAS-owned target is SYNTHETIC (the same shape `iscsi-mutate.test.ts`
 * uses and for the same reason: every captured fixture belongs to the
 * hand-built `gtiscsi` target, whose IQN ANAS did not generate, so it is
 * foreign — useful for the hands-off gate, useless for anything else).
 */

const NODE_NAME = 'nas'
const ANAS_IQN = anasIqn('vmstore', { nodeName: NODE_NAME })
const INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
const ZVOL_PATH = '/dev/zvol/tank/vol1'
/** The real capture's image size — 512 MiB, and the zvol's `volsize` to match. */
const IMAGE_SIZE = 536870912
const SNAP = 'host/gtimgboth/2026-08-25T19:28:38Z'

const TARGETCLI = '/usr/bin/targetcli'
const ZFS = '/usr/sbin/zfs'

/** One snapshot holding two `.img` archives — the real `gtimgboth` shape. */
const SNAPSHOT_LIST_JSON = JSON.stringify([
  {
    'backup-id': 'gtimgboth',
    'backup-type': 'host',
    // 2026-08-25T19:28:38Z
    'backup-time': 1787686118,
    'files': [
      { 'crypt-mode': 'none', 'filename': 'lun.img.fidx', 'size': IMAGE_SIZE },
      { 'crypt-mode': 'none', 'filename': 'vol.img.fidx', 'size': IMAGE_SIZE },
      { 'crypt-mode': 'none', 'filename': 'index.json.blob', 'size': 368 },
    ],
    'owner': 'root@pam!anas-test',
    'protected': false,
    'size': 1073742192,
  },
  {
    'backup-id': 'gtsmall',
    'backup-type': 'host',
    'backup-time': 1787686000,
    'files': [{ 'crypt-mode': 'none', 'filename': 'vol.img.fidx', 'size': 268435456 }],
  },
])

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': '11111111-2222-4333-8444-555555555555',
}

/** SYNTHETIC configfs: one ANAS target, one zvol LUN, one ACL. */
function anasManifest(opts: { session?: boolean } = {}): string {
  const tpg = `iscsi/${ANAS_IQN}/tpgt_1`
  const acl = `${tpg}/acls/${INITIATOR}`
  return `${[
    'D core',
    'D core/iblock_0',
    'D core/iblock_0/vmdisk1',
    `F core/iblock_0/vmdisk1/udev_path = ${ZVOL_PATH}`,
    'F core/iblock_0/vmdisk1/enable = 1',
    `F core/iblock_0/vmdisk1/info = Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 32768\\n        iBlock device: zd16  UDEV PATH: ${ZVOL_PATH}  readonly: 0\\n        Major: 230 Minor: 16  CLAIMED: IBLOCK`,
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
  ].join('\n')}\n`
}

/** SYNTHETIC saveconfig matching the manifest; `hole` adds a GT-21 restore hole. */
function anasSaveconfig(hole = false): string {
  const storageObjects: unknown[] = [{
    name: 'vmdisk1',
    plugin: 'block',
    dev: ZVOL_PATH,
    wwn: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    readonly: false,
    write_back: false,
    attributes: {},
    alua_tpgs: [],
  }]
  const luns: unknown[] = [{ index: 0, storage_object: '/backstores/block/vmdisk1', alias: '6847ded961' }]
  if (hole) {
    storageObjects.push({
      name: 'ghost',
      plugin: 'block',
      dev: '/dev/zvol/tank/gone',
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

interface Res {
  statusCode: number
  headers: Record<string, unknown>
  body: { data?: unknown, job?: { id: string }, error?: { code: string, reason?: string, message: string, warnings?: string[] } }
}

describe('POST /v1/backup/restore — the whole-image LUN restore (backup2.7)', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in saved))
      saved[k] = process.env[k]
    process.env[k] = v
  }

  function mockOf(): MockExecutor {
    return (server as unknown as { executor: MockExecutor }).executor
  }

  /**
   * Bring the server up. `present` makes the LUN's backing path resolve (no
   * test host has a `/dev/zvol/...` to stat, and without it every restore stops
   * at the backing-missing gate before anything else can be exercised).
   */
  async function serve(opts: {
    manifest?: string
    saveconfigText?: string
    present?: boolean
    volsize?: number
    snapshots?: string
    snapshotExit?: number
    snapshotStderr?: string
  } = {}) {
    if (opts.manifest) {
      const root = join(dir, 'target')
      await materializeConfigfsManifest(opts.manifest, root)
      setEnv('ANAS_ISCSI_CONFIGFS', root)
    }
    else {
      setEnv('ANAS_ISCSI_CONFIGFS', join(dir, 'absent-configfs'))
    }
    if (opts.saveconfigText !== undefined) {
      const p = join(dir, 'saveconfig.json')
      await writeFile(p, opts.saveconfigText)
      setEnv('ANAS_ISCSI_SAVECONFIG', p)
    }
    else {
      setEnv('ANAS_ISCSI_SAVECONFIG', join(dir, 'absent-saveconfig.json'))
    }
    setEnv('ANAS_ISCSI_SYS_BLOCK', join(dir, 'block'))
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    setEnv('ANAS_ISCSI_BACKING_PRESENT', opts.present === false ? '' : ZVOL_PATH)

    server = createServer({ mock: true, logger: false })
    const mock = mockOf()
    // pbc: the snapshot-list read. The restore itself goes through
    // `execToStream`, which is fixtured separately below.
    mock.addFixture({
      command: PBC,
      result: {
        stdout: opts.snapshots ?? SNAPSHOT_LIST_JSON,
        stderr: opts.snapshotStderr ?? '',
        exitCode: opts.snapshotExit ?? 0,
      },
    })
    mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    // EXACT args: the dev-mode server already registers command-only `zfs`
    // fixtures, and a command-only match would win over this one.
    mock.addFixture({
      command: ZFS,
      args: volsizeArgs('tank/vol1'),
      result: { stdout: `${opts.volsize ?? IMAGE_SIZE}\n`, stderr: '', exitCode: 0 },
    })
    mock.addStreamFixture({
      command: PBC,
      result: {
        stderr: 'restore complete (512 MiB processed in 0.6s, average 802.99 MiB/s)    \n',
        exitCode: 0,
        bytesWritten: IMAGE_SIZE,
      },
    })
    await server.ready()
  }

  /** The healthy ANAS tree every gate test runs against. */
  async function serveAnas(opts: Parameters<typeof serve>[0] & { session?: boolean, hole?: boolean } = {}) {
    await serve({
      ...opts,
      manifest: anasManifest({ session: opts.session ?? false }),
      saveconfigText: anasSaveconfig(opts.hole ?? false),
    })
  }

  function body(over: Record<string, unknown> = {}) {
    return {
      kind: 'image',
      repo: 'pbs-main',
      ns: 'gtrestore',
      snapshot: SNAP,
      archive: 'vol.img',
      lun: { targetIqn: ANAS_IQN, index: 0 },
      ...over,
    }
  }

  async function restore(payload: unknown = body(), headers: Record<string, string> = {}): Promise<Res> {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/backup/restore',
      headers: { ...IDENTITY, ...headers },
      payload: payload as object,
    })
    return { statusCode: res.statusCode, headers: res.headers as Record<string, unknown>, body: res.json() }
  }

  async function waitForJob(id: string): Promise<Job> {
    for (let i = 0; i < 200; i++) {
      const res = await server!.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
      const { job } = res.json() as { job: Job }
      if (job.status === 'completed' || job.status === 'failed')
        return job
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`job ${id} never finished`)
  }

  /** Nothing that could change a byte ran. */
  function assertNothingDestructive(): void {
    const mock = mockOf()
    const argv = mock.calls.map(c => `${c.command} ${c.args.join(' ')}`)
    assert.equal(argv.some(a => a.startsWith(TARGETCLI)), false, argv.join(' | '))
    assert.equal(mock.streamCalls.length, 0, JSON.stringify(mock.streamCalls))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backup-restore-'))
    await mkdir(join(dir, 'block', 'zd16'), { recursive: true })
    await writeFile(join(dir, 'block', 'zd16', 'size'), `${IMAGE_SIZE / 512}\n`)
    setEnv('ANAS_NODENAME', NODE_NAME)
    // A tier-2 repository with a stored secret — the restore reads both fresh.
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    await writeFile(join(dir, 'backup-repos.json'), `${JSON.stringify({
      version: 1,
      updatedBy: NODE_NAME,
      updatedAt: '2026-08-25T00:00:00.000Z',
      repos: [{
        name: 'pbs-main',
        host: 'pbs.example',
        port: 8007,
        datastore: 'store',
        authType: 'token',
        tokenId: 'root@pam!anas',
      }],
    }, null, 2)}\n`)
    await mkdir(join(dir, 'creds'), { recursive: true })
    await writeFile(join(dir, 'creds', 'backup-repo-pbs-main.secret'), 'super-secret', { mode: 0o600 })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
      delete saved[key]
    }
  })

  // --- (0) schema + the files branch ---------------------------------------

  describe('the request shape', () => {
    it('is identity-gated like every other route', async () => {
      await serveAnas()
      const res = await server!.inject({ method: 'POST', url: '/v1/backup/restore', payload: body() })
      assert.equal(res.statusCode, 401)
    })

    it('kind: files is REFUSED with "not yet available", never half-built', async () => {
      await serveAnas()
      const res = await restore({ kind: 'files', repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar' })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /not yet available/)
      assert.match(res.body.error!.message, /whole block images only/)
      assertNothingDestructive()
    })

    it('a BARE GROUP path is refused — it would silently restore the latest (GT-57)', async () => {
      await serveAnas()
      const res = await restore(body({ snapshot: 'host/gtimgboth' }))
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /silently restores the latest/)
      assertNothingDestructive()
    })

    it('a non-.img archive is refused before pbc could mis-parse it', async () => {
      await serveAnas()
      const res = await restore(body({ archive: 'data.pxar' }))
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /\.img archive/)
      assertNothingDestructive()
    })

    it('an unknown kind is a validation error, not a crash', async () => {
      await serveAnas()
      assert.equal((await restore({ kind: 'blocks' })).statusCode, 400)
    })
  })

  // --- (1)(2) LIO availability + the degraded-restore guard ----------------

  describe('LIO must be there, and not mid-degraded-restore', () => {
    it('no LIO stack → a guiding 409 naming the packages, nothing touched', async () => {
      await serve()
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'lio-not-installed')
      assert.match(res.body.error!.message, /targetcli-fb python3-rtslib-fb/)
      assertNothingDestructive()
    })

    it('a degraded restore → 409 naming the hole (a save would persist it, GT-22)', async () => {
      await serveAnas({ hole: true })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'degraded-restore')
      assert.match(res.body.error!.message, /ghost/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'a hole is not a "are you sure"')
      assertNothingDestructive()
    })
  })

  // --- (3) the target and the LUN ------------------------------------------

  describe('the target and the LUN have to exist and be ANAS\'s', () => {
    it('an unknown target is a 404', async () => {
      await serveAnas()
      const res = await restore(body({ lun: { targetIqn: 'iqn.2026-08.nas.anas:nope', index: 0 } }))
      assert.equal(res.statusCode, 404)
      assertNothingDestructive()
    })

    it('an unknown LUN index is a 404 that names the target', async () => {
      await serveAnas()
      const res = await restore(body({ lun: { targetIqn: ANAS_IQN, index: 7 } }))
      assert.equal(res.statusCode, 404)
      assert.match(res.body.error!.message, /has no LUN 7/)
      assertNothingDestructive()
    })

    it('a FOREIGN target is hands-off — 409 with the ownership reason', async () => {
      const foreign = 'iqn.2026-08.dev.example.gt:target1'
      await serve({
        manifest: anasManifest().replace(new RegExp(ANAS_IQN, 'g'), foreign),
        saveconfigText: anasSaveconfig().replace(new RegExp(ANAS_IQN, 'g'), foreign),
      })
      const res = await restore(body({ lun: { targetIqn: foreign, index: 0 } }))
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'foreign-target')
      assertNothingDestructive()
    })
  })

  // --- (4) the backing has to be resolvable AND present --------------------

  describe('the backing object', () => {
    it('a backing that does not resolve right now is a 409 that says to repair first', async () => {
      await serveAnas({ present: false })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'backing-missing')
      assert.match(res.body.error!.message, /repair the LUN/)
      assertNothingDestructive()
    })
  })

  // --- (5)(6) the snapshot, the archive, and THE SIZE CHECK ----------------

  describe('the size equality pre-check — the guard nothing below ANAS provides', () => {
    it('a snapshot that is not in the repository is a 404', async () => {
      await serveAnas()
      const res = await restore(body({ snapshot: 'host/gtimgboth/2020-01-01T00:00:00Z' }))
      assert.equal(res.statusCode, 404)
      assert.match(res.body.error!.message, /is not in repository 'pbs-main'/)
      assertNothingDestructive()
    })

    it('an archive that is not in the snapshot is refused for want of a size', async () => {
      await serveAnas()
      const res = await restore(body({ archive: 'nosuch.img' }))
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'size-mismatch')
      assert.match(res.body.error!.message, /not in the snapshot manifest/)
      assertNothingDestructive()
    })

    it('a LARGER image than the target is refused, naming BOTH numbers (GT-42)', async () => {
      // 512 MiB image, 256 MiB zvol — the exact destructive pair from the
      // ground-truth capture: it writes until ENOSPC and leaves the LUN half
      // overwritten. There is no confirm code for this.
      await serveAnas({ volsize: 268435456 })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'size-mismatch')
      assert.match(res.body.error!.message, /536870912 bytes/)
      assert.match(res.body.error!.message, /268435456 bytes/)
      assert.match(res.body.error!.message, /LARGER/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'a size mismatch is not confirmable')
      assertNothingDestructive()
    })

    it('a SMALLER image is refused too — stale tail bytes are still corruption', async () => {
      await serveAnas({ volsize: 1073741824 })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.match(res.body.error!.message, /SMALLER/)
      assert.match(res.body.error!.message, /stale bytes/)
      assertNothingDestructive()
    })

    it('a target whose size cannot be read is refused, never guessed at', async () => {
      await serveAnas()
      mockOf().clearFixtures()
      mockOf().addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mockOf().addFixture({ command: ZFS, result: { stdout: '', stderr: 'cannot open', exitCode: 1 } })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'target-size-unknown')
      assertNothingDestructive()
    })

    it('PBS being down surfaces as a 502 that quotes the client, not a 500', async () => {
      await serveAnas({
        snapshotExit: 255,
        snapshotStderr: 'Error: client error (Connect)\n\nCaused by:\n    error connecting to https://pbs.example:8007/ - tcp connect error: Connection refused (os error 111)\n',
      })
      const res = await restore()
      assert.equal(res.statusCode, 502)
      assert.match(res.body.error!.message, /Connection refused/)
      assertNothingDestructive()
    })
  })

  // --- (7) the live-session entry gate -------------------------------------

  describe('a live session is a hard 409 with NO bypass', () => {
    it('lists the initiators and says why no confirmation makes it safe', async () => {
      await serveAnas({ session: true })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'live-sessions')
      assert.match(res.body.error!.message, new RegExp(INITIATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(res.body.error!.message, /under a mounted filesystem/)
      assert.ok(!res.headers['x-anas-confirm-code'], 'a live session has no confirm bypass')
      assertNothingDestructive()
    })
  })

  // --- (8) the confirm gate + the job --------------------------------------

  describe('the confirm gate, and only then the job', () => {
    it('a first call is 409 + X-Anas-Confirm-Code with the four warnings', async () => {
      await serveAnas()
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'], 'expected a confirm code')
      const warnings = (res.body.error!.warnings ?? []).join(' | ')
      assert.match(warnings, /OVERWRITES \/dev\/zvol\/tank\/vol1 completely/)
      assert.match(warnings, /WHOLE TARGET goes offline/)
      assert.match(warnings, /auto-reconnects/)
      assert.match(warnings, /HALF-WRITTEN image and the target stays disabled/)
      assertNothingDestructive()
    })

    it('the confirmed call runs the whole sequence and reports it', async () => {
      await serveAnas()
      const first = await restore()
      const code = String(first.headers['x-anas-confirm-code'])
      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202)
      assert.ok(res.body.job?.id)

      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as {
        complete: boolean
        bytesWritten: number
        targetDisabled: boolean
        targetReEnabled: boolean
        targetPath: string
        imageSize: number
        warnings?: string[]
      }
      assert.equal(result.complete, true)
      assert.equal(result.bytesWritten, IMAGE_SIZE)
      assert.equal(result.imageSize, IMAGE_SIZE)
      assert.equal(result.targetPath, ZVOL_PATH)
      assert.equal(result.targetDisabled, true)
      assert.equal(result.targetReEnabled, true)
      assert.equal(result.warnings, undefined, JSON.stringify(result.warnings))

      // The stream went to the LUN's OWN backing path, and pbc never saw it.
      const mock = mockOf()
      assert.equal(mock.streamCalls.length, 1)
      assert.equal(mock.streamCalls[0].target.path, ZVOL_PATH)
      assert.deepEqual(mock.streamCalls[0].args, ['restore', SNAP, 'vol.img', '-', '--ns', 'gtrestore'])
      // disable → restore → enable, in that order.
      const seq = mock.calls
        .map(c => `${c.command} ${c.args.join(' ')}`)
        .filter(a => a.startsWith(TARGETCLI) || a.includes(' restore '))
      assert.deepEqual(seq, [
        `${TARGETCLI} /iscsi/${ANAS_IQN}/tpg1 disable`,
        `${TARGETCLI} saveconfig`,
        `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
        `${TARGETCLI} /iscsi/${ANAS_IQN}/tpg1 enable`,
        `${TARGETCLI} saveconfig`,
      ])
    })

    it('a mid-stream failure fails the job, says PARTIAL, and leaves the target DISABLED', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.clearFixtures()
      mock.addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        result: { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 },
      })

      const first = await restore()
      const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /partially written \(268435456 of 536870912 bytes/)
      assert.match(job.error!.message, /disabled until you restore again or accept the state/)
      // The `finally` did NOT re-enable it.
      const enables = mock.calls.filter(c => c.command === TARGETCLI && c.args.includes('enable'))
      assert.deepEqual(enables, [], JSON.stringify(enables))
    })

    it('a snapshot the client cannot find fails the job and RE-ENABLES the target', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.clearFixtures()
      mock.addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        result: {
          stderr: 'Error: snapshot host/gtimgboth/2026-08-25T19:28:38Z does not exist.\n',
          exitCode: 255,
          bytesWritten: 0,
        },
      })

      const first = await restore()
      const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /Nothing was written to/)
      const enables = mock.calls.filter(c => c.command === TARGETCLI && c.args.includes('enable'))
      assert.equal(enables.length, 1, 'the target must come back when nothing was written')
    })

    it('the confirm code is single-use and tied to this LUN', async () => {
      await serveAnas()
      const first = await restore()
      const code = String(first.headers['x-anas-confirm-code'])
      assert.equal((await restore(body(), { 'x-anas-confirm': code })).statusCode, 202)
      // Consumed: the same code cannot drive a second overwrite.
      assert.equal((await restore(body(), { 'x-anas-confirm': code })).statusCode, 409)
    })

    it('the audit params name the snapshot, archive, LUN and byte count — never a secret', async () => {
      await serveAnas()
      const first = await restore()
      const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.operation, 'backup.restore.image')
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      // The submitter params ARE the journald audit line's payload, and they are
      // deliberately not on the wire Job shape — so they are read from the queue
      // record itself, the way the audit logger reads them.
      const queue = (server as unknown as { jobQueue: { jobs: Map<string, { submitter: { params: Record<string, unknown> } }> } }).jobQueue
      const params = queue.jobs.get(res.body.job!.id)!.submitter.params
      assert.equal(params.snapshot, SNAP)
      assert.equal(params.archive, 'vol.img')
      assert.equal(params.target, ANAS_IQN)
      assert.equal(params.lun, 0)
      assert.equal(params.backing, ZVOL_PATH)
      assert.equal(params.imageBytes, IMAGE_SIZE)
      // Filled in when the job finished — the audit line reads this object
      // again at completion, so it names what actually reached the device.
      assert.equal(params.bytesWritten, IMAGE_SIZE)
      // And no secret, anywhere.
      assert.equal(JSON.stringify(job).includes('super-secret'), false)
      assert.equal(JSON.stringify(params).includes('super-secret'), false)
    })
  })
})
