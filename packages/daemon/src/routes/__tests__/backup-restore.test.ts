import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecStreamResult } from '../../executor/types.js'
import type { LockClaim } from '../../jobs/locks.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { constants, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { anasIqn } from '@anas/shared'
import { currentLane } from '../../executor/deadline.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { iscsiTargetClaim, zfsDatasetClaims, znameClaim } from '../../safety/guard.js'
import { createServer } from '../../server.js'
import { withFileMarks } from '../../services/__tests__/file-mark-fixtures.js'
import { volsizeArgs } from '../../services/backup-restore.js'
import { PBC } from '../../services/backup-runner.js'
import { withIscsiLock } from '../../services/iscsi-mutate.js'
import { GETFATTR, SETFATTR } from '../../services/restore-mark.js'

/** The captured mount trees (`findmnt --json`). */
const MOUNTS_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/mounts')

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
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': '11111111-2222-4333-8444-555555555555',
}

/**
 * The `acls/<iqn>/info` block LIO writes while an initiator is LOGGED IN.
 *
 * One copy, used twice: the manifest embeds it (escaped) for a target that is
 * busy from the start, and the TOCTOU test writes it into the live tree to make
 * an initiator reconnect while a restore job is queued.
 */
const SESSION_INFO = `InitiatorName: ${INITIATOR}
InitiatorAlias: anas-pve
LIO Session ID: 1   ISID: 0x00 02 3d 00 00 02  TSIH: 1  SessionType: Normal
Session State: TARG_SESS_STATE_LOGGED_IN
---------------------[iSCSI Session Values]-----------------------
----------------------[iSCSI Connections]-------------------------
CID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN
   Address 192.168.200.60 TCP  StatSN: 0x6916c3e9`

/**
 * SYNTHETIC configfs: one ANAS target, one zvol LUN, one ACL. With
 * `fileLunPath`, a SECOND LUN — fileio, an image file at that path (the
 * cr.64b2-iii (N) mount-table tests; the path is a real file under the
 * test's temp dir because the restore door's size gate stats it).
 */
function anasManifest(opts: { session?: boolean, fileLunPath?: string } = {}): string {
  const tpg = `iscsi/${ANAS_IQN}/tpgt_1`
  const acl = `${tpg}/acls/${INITIATOR}`
  const p = opts.fileLunPath
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
    ...(p
      ? [
          'D core/fileio_0',
          'D core/fileio_0/lun2',
          `F core/fileio_0/lun2/udev_path = ${p}`,
          'F core/fileio_0/lun2/enable = 1',
          // The captured fileio info shape (iscsi/configfs-live.manifest): the
          // Size field is what the restore door's size equality reads.
          `F core/fileio_0/lun2/info = Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384\\n        TCM FILEIO ID: 0        File: ${p}  Size: ${IMAGE_SIZE}  Mode: O_DSYNC Async: 0`,
          'D core/fileio_0/lun2/wwn',
          'F core/fileio_0/lun2/wwn/vpd_unit_serial = T10 VPD Unit Serial Number: 689844a4-1d20-4cba-8516-bdc52a402645',
          'F core/fileio_0/lun2/wwn/product_id = lun2',
          'F core/fileio_0/lun2/wwn/vendor_id = LIO-ORG',
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
    `D ${tpg}/np/192.168.200.50:3260`,
    `D ${tpg}/lun`,
    `D ${tpg}/lun/lun_0`,
    `L ${tpg}/lun/lun_0/6847ded961 -> ../../../../../../target/core/iblock_0/vmdisk1`,
    ...(p
      ? [
          `D ${tpg}/lun/lun_1`,
          `L ${tpg}/lun/lun_1/6847ded962 -> ../../../../../../target/core/fileio_0/lun2`,
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
    opts.session
      // The manifest escapes newlines as `\n`, so the one copy of the block is
      // re-escaped here rather than written out a second time.
      ? `F ${acl}/info = ${SESSION_INFO.replace(/\n/g, '\\n')}`
      : `F ${acl}/info = No active iSCSI Session for Initiator Endpoint: ${INITIATOR}`,
  ].join('\n')}\n`
}

/**
 * SYNTHETIC saveconfig matching the manifest; `hole` adds a GT-21 restore
 * hole; `fileLunPath` the fileio LUN 1 of the extended manifest.
 */
function anasSaveconfig(hole = false, fileLunPath?: string): string {
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
  if (fileLunPath) {
    storageObjects.push({
      name: 'lun2',
      plugin: 'fileio',
      dev: fileLunPath,
      size: IMAGE_SIZE,
      wwn: '689844a4-1d20-4cba-8516-bdc52a402645',
      readonly: false,
      write_back: false,
      attributes: {},
      alua_tpgs: [],
    })
    luns.push({ index: 1, storage_object: '/backstores/fileio/lun2', alias: '6847ded962' })
  }
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
    storageCfg?: string
    /** ident.2: what the LUN's path names, as the stat seam's env form. */
    deviceStat?: string
    /** Override the backing-present seam (colon-separated paths). */
    backingPresent?: string
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
    if (opts.storageCfg !== undefined) {
      const p = join(dir, 'storage.cfg')
      await writeFile(p, opts.storageCfg)
      setEnv('ANAS_STORAGE_CFG', p)
    }
    else {
      setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    }
    setEnv('ANAS_ISCSI_BACKING_PRESENT', opts.backingPresent ?? (opts.present === false ? '' : ZVOL_PATH))
    // ident.2: by default the path names the device the LUN serves (configfs
    // Major 230 Minor 16) — the healthy case every other gate test runs on.
    setEnv('ANAS_ISCSI_DEVICE_STAT', opts.deviceStat ?? `${ZVOL_PATH}=230:16`)

    server = createServer({ mock: true, logger: false })
    const mock = mockOf()
    // cr3.lunrestore: a backstore the job creates (or deletes) appears in (or
    // leaves) the configfs tree the job reads again before the map — the
    // map's re-read proves the backstore is still this run's own (name,
    // serial, path), and a mock targetcli changes no tree by itself.
    if (opts.manifest)
      liveBackstoresFollow(mock, join(dir, 'target'))
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

  /**
   * cr3.lunrestore: make a successful `/backstores/<plugin> create name= ... wwn=`
   * add `core/<plugin>_9/<name>/` (udev_path, the unit serial) to the
   * materialized configfs tree, and a `/backstores/<plugin> delete <name>`
   * remove it — the two facts the map's re-read checks.
   */
  function liveBackstoresFollow(mock: MockExecutor, root: string): void {
    const exec = mock.exec.bind(mock)
    mock.exec = async (command, args, o) => {
      const r = await exec(command, args, o)
      if (command !== TARGETCLI || r.exitCode !== 0 || !args[0]?.startsWith('/backstores/'))
        return r
      const plugin = args[0].slice('/backstores/'.length) === 'block' ? 'iblock' : args[0].slice('/backstores/'.length)
      if (args[1] === 'create') {
        const kv = (k: string) => args.find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? ''
        const d = join(root, 'core', `${plugin}_9`, kv('name'))
        await mkdir(join(d, 'wwn'), { recursive: true })
        await writeFile(join(d, 'wwn', 'vpd_unit_serial'), `T10 VPD Unit Serial Number: ${kv('wwn')}\n`)
        await writeFile(join(d, 'udev_path'), `${kv('dev') || kv('file_or_dev')}\n`)
      }
      else if (args[1] === 'delete') {
        await rm(join(root, 'core', `${plugin}_9`, args[2] ?? ''), { recursive: true, force: true })
      }
      return r
    }
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

  const ZPOOL = '/usr/sbin/zpool'
  /** TYPED, as in iscsi-backing-locks.test.ts: the gtiscsi pool's guid. */
  const GTISCSI_POOL_GUID = '7395061128366427419'

  /** The image LUN's world: the extended manifest, the real sparse file, the re-pointed table. */
  async function serveImageLun(): Promise<{ imageDir: string, imagePath: string }> {
    const imageDir = join(dir, 'gtiscsi', 'images')
    const imagePath = join(imageDir, 'lun2.raw')
    await mkdir(imageDir, { recursive: true })
    // A REAL sparse file at the image's size: the door's size equality
    // stats it, and the served-device seam must name a regular file.
    await writeFile(imagePath, '')
    await truncate(imagePath, IMAGE_SIZE)

    // serve() directly, not serveAnas(): serveAnas builds its own manifest
    // and saveconfig and would drop the fileio LUN 1.
    await serve({
      manifest: anasManifest({ fileLunPath: imagePath }),
      saveconfigText: anasSaveconfig(false, imagePath),
      backingPresent: `${ZVOL_PATH}:${imagePath}`,
      deviceStat: `${ZVOL_PATH}=230:16;${imagePath}=file:66306:4242`,
    })
    const mock = mockOf()
    const mounts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup/findmnt-nested.json'), 'utf-8')
      .replace('"target": "/gtiscsi/images"', `"target": ${JSON.stringify(imageDir)}`)
    mock.prependFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: mounts, stderr: '', exitCode: 0 } })
    // The ZFS mountpoint list the iSCSI read classifies the image path by.
    mock.prependFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: `gtiscsi\t${join(dir, 'gtiscsi')}\ngtiscsi/images\t${imageDir}\n`, stderr: '', exitCode: 0 } })
    mock.prependFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'gtiscsi'], result: { stdout: `${GTISCSI_POOL_GUID}\n`, stderr: '', exitCode: 0 } })
    return { imageDir, imagePath }
  }

  const imageBody = () => body({ lun: { targetIqn: ANAS_IQN, index: 1 } })

  describe('the request shape', () => {
    // cr4.lun N: a mark the route cannot read refuses the restore HERE, in the
    // job's own sentence, before a confirm is minted for a run that cannot start.
    it('the image file\'s restore mark cannot be read: 409 in the job\'s words, no confirm minted, no job', async () => {
      const { imagePath } = await serveImageLun()
      const mock = mockOf()
      mock.prependFixture({ command: GETFATTR, result: { stdout: '', stderr: `getfattr: ${imagePath}: Permission denied\n`, exitCode: 1 } })
      const res = await restore(imageBody())
      assert.equal(res.statusCode, 409, JSON.stringify(res.body))
      assert.equal(res.body.error!.code, 'CONFLICT')
      assert.equal(res.body.error!.reason, 'restore-mark-unreadable')
      const path = imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      assert.match(res.body.error!.message, new RegExp(`^ANAS could not read the restore mark trusted\\.anas\\.restore on ${path} \\(getfattr: ${path}: Permission denied\\), so it cannot keep the record an earlier restore may have left there\\. The restore is refused until the mark can be read\\. Nothing was disabled and nothing was written\\. `))
      assert.match(res.body.error!.message, /To see what ANAS sees, run 'LC_ALL=C getfattr --absolute-names -e hex -n trusted\.anas\.restore -- /)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'the door refuses before it asks to confirm')
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      assert.deepEqual(queue.list(), [], 'no job was submitted')
      assertNothingDestructive()
    })

    it('is identity-gated like every other route', async () => {
      await serveAnas()
      const res = await server!.inject({ method: 'POST', url: '/v1/backup/restore', payload: body() })
      assert.equal(res.statusCode, 401)
    })

    // backup2.6 merge fix-up: the file branch is BUILT now, so `kind: 'files'`
    // is no longer refused — it is dispatched. What still matters here is that
    // the switch keeps the two kinds apart: a files body is judged by the FILE
    // schema (it needs `selections`), never by the image one, and it never
    // reaches anything the image restore does.
    it('kind: files dispatches to the file branch, judged by the FILE schema', async () => {
      await serveAnas()
      const res = await restore({ kind: 'files', repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar' })
      assert.equal(res.statusCode, 400)
      assert.match(res.body.error!.message, /selections/)
      assert.ok(!/\.img/.test(res.body.error!.message), 'not judged by the image schema')
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

  describe('cr3 review2 (1): a named task\'s namespace at the two image doors', () => {
    async function storeTask(name: string, namespace: string | undefined): Promise<void> {
      const task = { name, repository: 'pbs-main', backupId: name, archives: [{ name: 'a', path: '/a', excludes: [] }], schedule: 'daily', enabled: true, ...(namespace === undefined ? {} : { namespace }) }
      await writeFile(join(dir, `anas-backup-${name}.service`), `# X-ANAS-Task=${JSON.stringify(task)}\n[Service]\n`)
      await writeFile(join(dir, `anas-backup-${name}.timer`), '[Timer]\n')
    }
    // [task, body ns, expected --ns of the snapshot read (null = the root) or 400]
    const table: [string | undefined, string | undefined, string | null | 400][] = [
      [undefined, 'gtrestore', 'gtrestore'],
      [undefined, '', null], // no task: '' is "not given" = the repository's (none here) — unchanged
      ['rooted', undefined, null],
      ['rooted', '', null],
      ['rooted', 'gtrestore', 400],
      ['named', undefined, 'gtrestore'],
      ['named', '', 'gtrestore'],
      ['named', 'other', 400],
    ]
    for (const door of ['in place', 'new LUN'] as const) {
      it(`${door}: door x (task named / not) x (ns absent / '' / value)`, async () => {
        await serveAnas()
        await storeTask('rooted', '')
        await storeTask('named', 'gtrestore')
        const mock = mockOf()
        for (const [task, ns, want] of table) {
          mock.calls.length = 0
          const base = door === 'in place' ? body() : newLunBodyOf()
          const { ns: _drop, ...rest } = base as Record<string, unknown>
          const res = await restore({ ...rest, ...(task ? { task } : {}), ...(ns === undefined ? {} : { ns }) })
          const label = `${door} task=${task ?? '-'} ns=${ns === undefined ? '-' : JSON.stringify(ns)}`
          if (want === 400) {
            assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`)
            continue
          }
          const read = mock.calls.find(c => c.command === PBC && c.args[0] === 'snapshot')
          assert.ok(read, `${label}: ${JSON.stringify(res.body)}`)
          const i = read.args.indexOf('--ns')
          assert.equal(i === -1 ? null : read.args[i + 1], want, label)
        }
      })
    }
    function newLunBodyOf(): Record<string, unknown> {
      return body({ lun: undefined, target: { mode: 'newLun', targetIqn: ANAS_IQN, name: 'newvol', backing: { kind: 'zvol', pool: 'tank' } } })
    }
  })

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

  // --- (7b) the SAME question, asked again when the job runs (R1, #52) -----
  //
  // The gate above is a fact about the moment the request arrived. A restore is
  // a job, and a job waits: the queue runs four at a time and this one can sit
  // behind hours of backups. open-iscsi and Windows reconnect on their own, so
  // an initiator can be back before the first byte — which used to mean the
  // designed "gate, then disable" pair degraded to "disable only".

  describe('a session that comes back while the job is QUEUED stops the job', () => {
    /** The initiator logs back in: LIO's live `info` block replaces the idle one. */
    async function loginInitiator(): Promise<void> {
      await writeFile(
        join(dir, 'target', 'iscsi', ANAS_IQN, 'tpgt_1', 'acls', INITIATOR, 'info'),
        `${SESSION_INFO}\n`,
      )
    }

    it('fails the job with the live-session wording — nothing disabled, nothing written', async () => {
      await serveAnas()
      const first = await restore()
      const code = String(first.headers['x-anas-confirm-code'])

      // Park the daemon-wide iSCSI mutex. The job takes it for the session
      // re-check plus the disable, so holding it here holds the job open in
      // EXACTLY the window the defect lived in — no sleeps, no races.
      let release!: () => void
      let locked!: () => void
      const isLocked = new Promise<void>((r) => {
        locked = r
      })
      const held = withIscsiLock(() => new Promise<void>((r) => {
        release = r
        locked()
      }))
      await isLocked

      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))

      // ... and now the initiator is back, after the entry gate said it was not.
      await loginInitiator()
      release()
      await held

      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.match(job.error!.message, new RegExp(INITIATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(job.error!.message, /is logged in to/)
      assert.match(job.error!.message, /under a mounted filesystem/)
      assert.match(job.error!.message, /appeared AFTER the restore was accepted/)
      // The whole point: the target was left EXACTLY as the job found it. No
      // disable, no saveconfig, and not one byte of the image streamed.
      assertNothingDestructive()
    })

    it('no session when the job runs — the restore proceeds exactly as before', async () => {
      // The same lock-parked shape as above with the login left out, so the
      // only difference between passing and failing this pair is the session.
      await serveAnas()
      const first = await restore()
      const code = String(first.headers['x-anas-confirm-code'])

      let release!: () => void
      let locked!: () => void
      const isLocked = new Promise<void>((r) => {
        locked = r
      })
      const held = withIscsiLock(() => new Promise<void>((r) => {
        release = r
        locked()
      }))
      await isLocked

      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202)
      release()
      await held

      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const mock = mockOf()
      assert.equal(mock.streamCalls.length, 1)
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
  })

  // --- ident.2 (audit #10): the served device is the identity ---------------

  describe('ident.2 — the restore acts only on the LUN and device it was accepted for', () => {
    const vmdisk = () => join(dir, 'target', 'core', 'iblock_0', 'vmdisk1')

    /** Park the iSCSI mutex so a confirmed job waits exactly where it re-reads. */
    async function parkLock(): Promise<{ release: () => void, held: Promise<void> }> {
      let release!: () => void
      let locked!: () => void
      const isLocked = new Promise<void>((r) => {
        locked = r
      })
      const held = withIscsiLock(() => new Promise<void>((r) => {
        release = r
        locked()
      }))
      await isLocked
      return { release, held }
    }

    it('a path that names a different device than the LUN serves is refused before PBS is asked', async () => {
      // The volume was renamed away and a new one created at the old name: the
      // path is device 230:32 now, LIO still serves 230:16.
      await serveAnas({ deviceStat: `${ZVOL_PATH}=230:32` })
      const res = await restore()
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.reason, 'served-device-mismatch')
      assert.match(res.body.error!.message, /LUN serves a different device than its path names/)
      assert.match(res.body.error!.message, /230:16/)
      assert.match(res.body.error!.message, /230:32/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(mockOf().calls.some(c => c.command === PBC), false, 'no PBS contact')
      assertNothingDestructive()
    })

    it('the code binds the serial: a LUN re-created at the index inside the TTL gets a NEW challenge', async () => {
      await serveAnas()
      const first = await restore()
      const code = String(first.headers['x-anas-confirm-code'])
      // Delete + add within the TTL: same index, same path, a fresh serial.
      await writeFile(join(vmdisk(), 'wwn', 'vpd_unit_serial'), 'T10 VPD Unit Serial Number: 11111111-2222-3333-4444-555555555555\n')
      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.notEqual(res.headers['x-anas-confirm-code'], code)
      assertNothingDestructive()
    })

    // cr.56: the in-place door's confirm now answers a changed request field
    // the way every guard door does — 409 CONFIRM_SCOPE_CHANGED naming the
    // field, with a fresh code (was: CONFIRMATION_REQUIRED). What the test
    // protects is unchanged: the code does not authorise a different archive.
    it('the code binds the snapshot and the archive: a different archive is a new challenge (409 CONFIRM_SCOPE_CHANGED naming it)', async () => {
      await serveAnas()
      const first = await restore()
      const code = String(first.headers['x-anas-confirm-code'])
      const res = await restore(body({ archive: 'lun.img' }), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRM_SCOPE_CHANGED')
      assert.deepEqual((res.body.error as { changed?: string[] }).changed, ['archive'])
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.notEqual(res.headers['x-anas-confirm-code'], code)
      assertNothingDestructive()
    })

    it('parity table 2026-10-17: the code binds the RATE — the in-place door writes it to pbc, so a replay that changes it is 409 CONFIRM_SCOPE_CHANGED naming rate (its new-LUN twin already signed it)', async () => {
      await serveAnas()
      const first = await restore()
      assert.equal(first.body.error!.code, 'CONFIRMATION_REQUIRED')
      const code = String(first.headers['x-anas-confirm-code'])
      const res = await restore(body({ rate: '10MB' }), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 409, JSON.stringify(res.body))
      assert.equal(res.body.error!.code, 'CONFIRM_SCOPE_CHANGED')
      assert.deepEqual((res.body.error as { changed?: string[] }).changed, ['rate'])
      assertNothingDestructive()
    })

    it('cr.56 (H3, folded from cr.54): the code binds the NAMESPACE — a code minted for ns gtrestore replayed with another ns is 409 CONFIRM_SCOPE_CHANGED naming ns, and nothing runs', async () => {
      await serveAnas()
      const first = await restore()
      assert.equal(first.body.error!.code, 'CONFIRMATION_REQUIRED')
      const code = String(first.headers['x-anas-confirm-code'])
      // The same snapshot NAME in another namespace is another point in time.
      const res = await restore(body({ ns: 'gtrestore-old' }), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 409, JSON.stringify(res.body))
      assert.equal(res.body.error!.code, 'CONFIRM_SCOPE_CHANGED')
      assert.deepEqual((res.body.error as { changed?: string[] }).changed, ['ns'])
      assert.match(res.body.error!.message, /^You confirmed with ns "gtrestore"; this request has ns "gtrestore-old" — confirm again$/)
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.notEqual(res.headers['x-anas-confirm-code'], code)
      assertNothingDestructive()
    })

    it('a LUN re-created at the index while the job is QUEUED fails the job — nothing disabled, nothing written', async () => {
      await serveAnas()
      const code = String((await restore()).headers['x-anas-confirm-code'])
      const lock = await parkLock()
      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      await writeFile(join(vmdisk(), 'wwn', 'vpd_unit_serial'), 'T10 VPD Unit Serial Number: 11111111-2222-3333-4444-555555555555\n')
      lock.release()
      await lock.held
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      // cr.64b2-iii (N): the LUN's serial key is now derived by the spec's
      // `locks`, so the guard's job-time recompute (cr.64b1 (D)) catches the
      // re-created LUN at the job door — the run needs a key the route was
      // never granted — before the service's own reverify ever runs. The
      // sentence names the exact key that moved. (INVARIANT CHANGE: this test
      // used to pin the service's reverify sentence, "no longer the LUN this
      // request was accepted for"; the refusal moved earlier, not softer.)
      assert.match(job.error!.message, /changed while this run waited/)
      assert.match(job.error!.message, /the run holds no lock on iSCSI LUN 11111111-2222-3333-4444-555555555555/)
      assertNothingDestructive()
    })

    it('a served device that changed while the job is QUEUED fails the job — nothing disabled, nothing written', async () => {
      await serveAnas()
      const code = String((await restore()).headers['x-anas-confirm-code'])
      const lock = await parkLock()
      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      // LIO now serves another device under the same backstore name.
      await writeFile(join(vmdisk(), 'info'), `Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 32768\n        iBlock device: zd32  UDEV PATH: ${ZVOL_PATH}  readonly: 0\n        Major: 230 Minor: 32  CLAIMED: IBLOCK\n`)
      lock.release()
      await lock.held
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /LUN serves a different device than its path names/)
      assertNothingDestructive()
    })
  })

  // --- cr.56 (folded from cr.54): the job reads the repository and its secret ---
  //
  // The restore waits in the queue behind a job holding the target's key (the
  // key the in-place restore takes, cr.40); the repository changes while it
  // waits; the job's first act is to read the repository and its secret again.

  describe('cr.56 — the job re-resolves the repository and its secret, as the backup run does', () => {
    function hold(): () => void {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      ;(server as unknown as { jobQueue: JobQueue }).jobQueue.submit('test.hold', { user: 'test', uid: 0 }, async () => {
        await held
      }, { locks: [iscsiTargetClaim(ANAS_IQN)] })
      return release
    }

    async function acceptedBehindHold(): Promise<{ id: string, release: () => void }> {
      const code = String((await restore()).headers['x-anas-confirm-code'])
      const release = hold()
      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      return { id: res.body.job!.id, release }
    }

    it('a token ROTATED while the restore waits is the one the job hands pbc — pbc echoing the NEW value is masked, so the job carried it', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.clearFixtures()
      mock.addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, argsMatch: a => a[0] === 'get' && a.includes('anas:restore'), result: { stdout: '-\t-\n', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      // pbc fails echoing the credential it was handed: the ROTATED one.
      mock.addStreamFixture({
        command: PBC,
        result: { stderr: 'Error: error extracting archive - connection closed because of a broken pipe while using rotated-secret\n', exitCode: 255, bytesWritten: 0 },
      })
      const { id, release } = await acceptedBehindHold()
      await writeFile(join(dir, 'creds', 'backup-repo-pbs-main.secret'), 'rotated-secret', { mode: 0o600 })
      release()
      const job = await waitForJob(id)
      assert.equal(job.status, 'failed')
      // The mask is built from the value the job handed pbc: the rotated one.
      assert.match(job.error!.message, /\[secret\]/)
      assert.equal(JSON.stringify(job).includes('rotated-secret'), false, job.error!.message)
    })

    it('a credential DELETED while the restore waits fails the job naming it — nothing disabled, nothing written', async () => {
      await serveAnas()
      const { id, release } = await acceptedBehindHold()
      await rm(join(dir, 'creds', 'backup-repo-pbs-main.secret'))
      release()
      const job = await waitForJob(id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error!.message, `No secret stored for repository 'pbs-main' — set its credentials first; nothing was restored`)
      assertNothingDestructive()
    })

    it('a repository re-pointed at another server while the restore waits fails STATE_CHANGED — the snapshot was picked from the old one; nothing disabled, nothing written', async () => {
      await serveAnas()
      const { id, release } = await acceptedBehindHold()
      const reg = JSON.parse(await readFile(join(dir, 'backup-repos.json'), 'utf8')) as { repos: { host: string }[] }
      reg.repos[0].host = 'pbs-other.example'
      await writeFile(join(dir, 'backup-repos.json'), `${JSON.stringify(reg, null, 2)}\n`)
      release()
      const job = await waitForJob(id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error!.code, 'STATE_CHANGED')
      assert.equal(job.error!.message, `Repository 'pbs-main' changed while the restore waited (was pbs.example:8007/store; `
      + `now pbs-other.example:8007/store) — the snapshot was picked from the old one, so nothing was restored; pick it again`)
      assertNothingDestructive()
    })
  })

  // --- cr.64a: the in-place restore's backing keys (beside target + LUN) ----

  describe('cr.64a — the in-place restore holds its backing\'s keys beside the target\'s', () => {
    const ZPOOL = '/usr/sbin/zpool'
    /** TYPED (this harness reads no real pool): the pool guid of tank/vol1. */
    const TANK_GUID = '6915264936287318418'

    /** Opened by afterEach if a test failed part-way, so no job parks in the stream. */
    let openStream: (() => void) | undefined
    afterEach(() => {
      openStream?.()
      openStream = undefined
    })

    it('a dataset destroy on the backing waits for the running restore — named — and runs once the stream ends', async () => {
      await serveAnas()
      const mock = mockOf()
      // The pool's guid IS readable here, so the backing's keys are the
      // volume's real dataset keys, not §4.2's name-key fallback.
      mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'tank'], result: { stdout: `${TANK_GUID}\n`, stderr: '', exitCode: 0 } })
      // Hold the job AT the image stream: keys held, target disabled, waiting.
      let arrive!: () => void
      const reached = new Promise<void>((resolve) => {
        arrive = resolve
      })
      let release!: () => void
      const go = new Promise<void>((resolve) => {
        release = resolve
        openStream = resolve
      })
      const toStream = mock.execToStream.bind(mock)
      mock.execToStream = async (command, args, target, opts) => {
        arrive()
        await go
        return toStream(command, args, target, opts)
      }

      const code = String((await restore()).headers['x-anas-confirm-code'])
      const res = await restore(body(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      const id = res.body.job!.id
      await reached

      // A destroy of the LUN's backing dataset, claiming it as `zfs destroy`
      // does (its own key exclusive, ancestors and the pool shared). Before
      // cr.64a the restore held only the iSCSI keys and this ran beside the
      // stream, destroying the object the image was landing in.
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const probe = queue.submit('zfs.destroy', { user: 'test', uid: 0 }, async () => null, { locks: zfsDatasetClaims(TANK_GUID, 'tank/vol1', 'exclusive') })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(queue.get(probe.id)?.status, 'queued', 'the destroy waits for the restore, not for a slot')
      assert.equal(queue.get(probe.id)?.progress, `waiting for backup.restore.image (job ${id}) on Dataset 'tank/vol1'`)

      release()
      openStream = undefined
      const job = await waitForJob(id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      for (let i = 0; i < 200 && queue.get(probe.id)?.status !== 'completed'; i++)
        await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(queue.get(probe.id)?.status, 'completed', JSON.stringify(queue.get(probe.id)?.error))
      assert.deepEqual(queue.heldLocks(), [])
    })
  })

  // cr.64b2-iii (N): the in-place restore's backing claims now ride a guard
  // spec's `locks` (the new-LUN branch's idiom), so the guard's job-time
  // recompute covers them and a mount-table failure refuses the door 503
  // UNAVAILABLE naming the read instead of locking nothing. The world adds a
  // SECOND LUN — fileio, an image file — because the claim reader that fails
  // closed on the mount table is the image's (`pathSourceClaims`); the zvol
  // LUN's keys derive from the pool guid, not the table. The image lives under
  // the test's temp dir because the door's size gate stats the REAL file; the
  // mount table is the captured `backup/findmnt-nested.json` with its
  // `/gtiscsi/images` row re-pointed at that dir (the same one-row adaptation
  // the new-LUN backing-moved test makes at findmnt-full.json).
  describe('cr.64b2-iii (N) — the in-place restore of an IMAGE LUN and the mount table', () => {
    const IMAGE_LUN_SERIAL = '689844a4-1d20-4cba-8516-bdc52a402645'

    /** `findmnt --json` exits 1 (its unreadable-mountinfo line) where `fails(inJob)` says so. */
    function findmntFails(fails: (inJob: boolean) => boolean): void {
      const mock = mockOf()
      const inner = mock.exec.bind(mock)
      mock.exec = async (command, args, opts) => {
        if (command === '/usr/bin/findmnt' && args.join(' ') === '--json' && fails(currentLane().jobId !== undefined))
          return { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo\n', exitCode: 1 }
        return inner(command, args, opts)
      }
    }
    const UNREADABLE = /the mount table could not be read \(findmnt --json exited 1: findmnt: cannot read \/proc\/self\/mountinfo\), so the filesystem .+ lives on cannot be locked — nothing was done; try again/

    it('findmnt failing at the ROUTE: the restore of the image LUN answers 503 UNAVAILABLE naming the read — no confirm minted, no job, nothing destructive', async () => {
      await serveImageLun()
      findmntFails(inJob => !inJob)
      const res = await restore(imageBody())
      assert.equal(res.statusCode, 503, JSON.stringify(res.body))
      assert.equal(res.body.error!.code, 'UNAVAILABLE')
      assert.match(res.body.error!.message, UNREADABLE)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'the door refuses before it asks to confirm')
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      assert.deepEqual(queue.list(), [], 'no job was submitted')
      assertNothingDestructive()
    })

    it('findmnt failing in the JOB only: the accepted restore refuses UNAVAILABLE naming the read — nothing disabled, nothing streamed', async () => {
      await serveImageLun()
      findmntFails(inJob => inJob)
      const first = await restore(imageBody())
      assert.equal(first.statusCode, 409, JSON.stringify(first.body))
      const code = String(first.headers['x-anas-confirm-code'])
      const res = await restore(imageBody(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error!.code, 'UNAVAILABLE')
      assert.match(job.error!.message, UNREADABLE)
      assertNothingDestructive()
    })

    it('findmnt fine: the running restore holds the image filesystem\'s keys beside the target and LUN — the set the route computed before, now re-derived by the job door', async () => {
      const { imageDir } = await serveImageLun()
      const mock = mockOf()
      // Hold the job AT the image stream: keys held, target disabled, waiting.
      let arrive!: () => void
      const reached = new Promise<void>((resolve) => {
        arrive = resolve
      })
      let release!: () => void
      const go = new Promise<void>((resolve) => {
        release = resolve
      })
      const toStream = mock.execToStream.bind(mock)
      mock.execToStream = async (command, args, target, opts) => {
        arrive()
        await go
        return toStream(command, args, target, opts)
      }

      const code = String((await restore(imageBody())).headers['x-anas-confirm-code'])
      const res = await restore(imageBody(), { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      const id = res.body.job!.id
      await reached

      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const held = queue.heldLocks().filter(l => l.holders.includes(id)).map(l => ({ key: l.key, mode: l.mode }))
      // The same set the route computed before this story (cr.64a): the
      // target, the LUN by serial, and the image filesystem's keys SHARED —
      // the dataset's, the pool's, the name's, and the mount's.
      assert.deepEqual(held, [
        { key: `iscsi-target:${ANAS_IQN}`, mode: 'exclusive' },
        { key: `iscsi-lun:${IMAGE_LUN_SERIAL}`, mode: 'exclusive' },
        { key: `zfs:${GTISCSI_POOL_GUID}/images`, mode: 'shared' },
        { key: `zfs:${GTISCSI_POOL_GUID}`, mode: 'shared' },
        { key: `zpool:${GTISCSI_POOL_GUID}`, mode: 'shared' },
        { key: 'zname:gtiscsi', mode: 'shared' },
        { key: `mount:${imageDir}`, mode: 'shared' },
      ])

      release()
      const job = await waitForJob(id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(queue.heldLocks(), [])
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
      assert.match(warnings, /HALF-WRITTEN image: the target stays disabled and the volume keeps the restore mark anas:restore/)
      assertNothingDestructive()
    })

    it('cr3.backup: an image from ANOTHER LUN\'s group says so in the confirm', async () => {
      const other = 'host/lun-11111111-2222-3333-4444-555555555555/2026-08-25T19:28:38Z'
      const snapshots = JSON.stringify([{
        'backup-id': 'lun-11111111-2222-3333-4444-555555555555',
        'backup-type': 'host',
        'backup-time': 1787686118,
        'files': [{ 'crypt-mode': 'none', 'filename': 'vol.img.fidx', 'size': IMAGE_SIZE }],
      }])
      await serveAnas({ snapshots })
      const res = await restore(body({ snapshot: other }))
      assert.equal(res.statusCode, 409)
      const warnings = (res.body.error!.warnings ?? []).join(' | ')
      assert.match(warnings, /This image was backed up from ANOTHER LUN \(lun-11111111-2222-3333-4444-555555555555\); LUN 0 of .* is lun-9bc6e907-6015-4267-be4f-5a0617cb3d71/)
      assertNothingDestructive()
    })

    it('cr3.backup: a group that is not a LUN group (a hand-named id) carries no other-LUN line', async () => {
      await serveAnas()
      const own = await restore()
      assert.equal(own.statusCode, 409)
      assert.ok(!(own.body.error!.warnings ?? []).some(w => /ANOTHER LUN/.test(w)))
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
      mock.addFixture({ command: ZFS, argsMatch: a => a[0] === 'get' && a.includes('anas:restore'), result: { stdout: '-\t-\n', stderr: '', exitCode: 0 } })
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

    it('cr.48d: pbc echoing the repo secret in a failed restore is masked on the whole job record', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.clearFixtures()
      mock.addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, argsMatch: a => a[0] === 'get' && a.includes('anas:restore'), result: { stdout: '-\t-\n', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      // A pbc ERROR line that echoes the credential this restore handed it.
      mock.addStreamFixture({
        command: PBC,
        result: {
          stderr: 'Error: error extracting archive - connection closed because of a broken pipe while using super-secret\n',
          exitCode: 255,
          bytesWritten: 0,
        },
      })

      const first = await restore()
      const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      // The detail rides the job error AND the audit line verbatim.
      assert.match(job.error!.message, /dropped part-way through the image/)
      assert.match(job.error!.message, /\[secret\]/)
      assert.ok(!job.error!.message.includes('super-secret'), job.error!.message)
      // And no secret value anywhere on the whole job record — the wire shape,
      // the queue record's audit params and its progress lines, all of it.
      assert.equal(JSON.stringify(job).includes('super-secret'), false)
    })

    it('a snapshot the client cannot find fails the job and RE-ENABLES the target', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.clearFixtures()
      mock.addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, argsMatch: a => a[0] === 'get' && a.includes('anas:restore'), result: { stdout: '-\t-\n', stderr: '', exitCode: 0 } })
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

  // --- backup2.10: the same image restored AS A NEW LUN ---------------------
  //
  // `target: { mode: 'newLun' }` is the second door of this route: the image
  // lands on a FRESH backing with a FRESH serial, mapped at the next free
  // index — the source LUN is never touched, so it has none of in-place's
  // gates (no live-session gate, no offline window). It has its own: the
  // destination target's ownership, the node-global name, the backing's
  // storage, the manifest's size, and a confirm gate whose warnings say what
  // this is NOT (not an overwrite). The sequence itself is asserted as a call
  // log in `services/__tests__/backup-restore-elsewhere.test.ts`.

  describe('backup2.10 — the image restored as a NEW LUN (target.mode: newLun)', () => {
    const NEWVOL_PATH = '/dev/zvol/tank/newvol'

    function newLunBody(over: Record<string, unknown> = {}) {
      return body({
        lun: undefined,
        target: {
          mode: 'newLun',
          targetIqn: ANAS_IQN,
          name: 'newvol',
          backing: { kind: 'zvol', pool: 'tank' },
        },
        ...over,
      })
    }

    function targetWith(over: Record<string, unknown>) {
      return { target: { mode: 'newLun', targetIqn: ANAS_IQN, name: 'newvol', backing: { kind: 'zvol', pool: 'tank' }, ...over } }
    }

    describe('the preflights — in order, and nothing destructive before each one', () => {
      it('no LIO stack → the same guiding 409, nothing touched', async () => {
        await serve()
        const res = await restore(newLunBody())
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'lio-not-installed')
        assert.match(res.body.error!.message, /targetcli-fb python3-rtslib-fb/)
        assertNothingDestructive()
      })

      it('a degraded restore is refused for a NEW LUN too — a save would persist the hole (GT-22)', async () => {
        await serveAnas({ hole: true })
        const res = await restore(newLunBody())
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'degraded-restore')
        assert.match(res.body.error!.message, /ghost/)
        assertNothingDestructive()
      })

      it('an unknown destination target is a 404', async () => {
        await serveAnas()
        const res = await restore(newLunBody(targetWith({ targetIqn: 'iqn.2026-08.nas.anas:nope' })))
        assert.equal(res.statusCode, 404)
        assert.match(res.body.error!.message, /not found/)
        assertNothingDestructive()
      })

      it('a destination target ANAS does not manage is hands-off', async () => {
        const foreign = 'iqn.2026-08.dev.example.gt:target1'
        await serve({
          manifest: anasManifest().replace(new RegExp(ANAS_IQN, 'g'), foreign),
          saveconfigText: anasSaveconfig().replace(new RegExp(ANAS_IQN, 'g'), foreign),
        })
        const res = await restore(newLunBody(targetWith({ targetIqn: foreign })))
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'foreign-target')
        assertNothingDestructive()
      })

      it('a taken name is refused node-wide — it is the SCSI model string (GT-15)', async () => {
        await serveAnas()
        const res = await restore(newLunBody(targetWith({ name: 'vmdisk1' })))
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'name-taken')
        assert.match(res.body.error!.message, /SCSI model string/)
        assertNothingDestructive()
      })

      it('cr3.backup: an UNMAPPED backstore of that name is refused too — the daemon checks, not the panel', async () => {
        // A backstore in the live tree that no target maps: lunNameFreeGate
        // cannot see it, and a create over it would fail after the backing was
        // made, with the cleanup's delete-by-name then removing it.
        await serve({
          manifest: anasManifest().replace('D core\n', [
            'D core',
            'D core/iblock_1',
            'D core/iblock_1/newvol',
            'F core/iblock_1/newvol/udev_path = /dev/zvol/tank/other',
            'F core/iblock_1/newvol/enable = 1',
            'D core/iblock_1/newvol/wwn',
            'F core/iblock_1/newvol/wwn/product_id = newvol',
            '',
          ].join('\n')),
          saveconfigText: anasSaveconfig(),
        })
        const res = await restore(newLunBody(targetWith({ name: 'newvol' })))
        assert.equal(res.statusCode, 409, JSON.stringify(res.body))
        assert.equal(res.body.error!.reason, 'name-taken', JSON.stringify(res.body))
        assert.match(res.body.error!.message, /backstore named 'newvol' exists on this node and no LUN maps it\. .*: pick another name, or remove that backstore with targetcli\.$/)
        assertNothingDestructive()
      })

      it('a PVE guest volume is never ANAS\'s to create, even for a restore (pvepool.1)', async () => {
        // The naming rule is scoped to PVE's storage: with `tank` as the
        // configured pool of a zfspool storage, a zvol named like a guest disk
        // is exactly what PVE would inventory on its next scan.
        await serveAnas({ storageCfg: 'zfspool: local-zfs\n\tpool tank\n\tcontent images,rootdir\n' })
        const res = await restore(newLunBody(targetWith({ name: 'vm-101-disk-0' })))
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'pve-guest-volume')
        assert.match(res.body.error!.message, /guest volume/)
        assertNothingDestructive()
      })

      it('a guest-LOOKING LUN name on a pool PVE has no storage for is allowed (pvepool.1)', async () => {
        // Without a storage.cfg naming the pool, PVE would never list
        // `tank/vm-101-disk-0` — the name alone proves nothing.
        await serveAnas()
        const res = await restore(newLunBody(targetWith({ name: 'vm-101-disk-0' })))
        // It reaches the CONFIRM gate — every preflight passed.
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
        assertNothingDestructive()
      })

      it('a file backing on storage ANAS does not manage is refused by name', async () => {
        await serveAnas()
        const res = await restore(newLunBody(targetWith({ backing: { kind: 'file', dataset: 'nosuchdataset' } })))
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'backing-not-found')
        assert.match(res.body.error!.message, /neither a mounted ZFS dataset nor an AHR pool/)
        assertNothingDestructive()
      })

      it('a manifest without the image\'s size refuses — a backing of the wrong size is worse than none', async () => {
        await serveAnas()
        const res = await restore(newLunBody({ archive: 'nosuch.img' }))
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.error!.reason, 'image-size-unknown')
        assert.match(res.body.error!.message, /not in the snapshot manifest/)
        assertNothingDestructive()
      })
    })

    it('the confirm gate says what this is and is not — a NEW disk, nothing touched', async () => {
      await serveAnas()
      const res = await restore(newLunBody())
      assert.equal(res.statusCode, 409)
      assert.equal(res.body.error!.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'], 'expected a confirm code')
      const warnings = (res.body.error!.warnings ?? []).join(' | ')
      assert.match(warnings, /NEW LUN 'newvol' backed by \/dev\/zvol\/tank\/newvol at exactly the image's size \(536870912 bytes\)/)
      assert.match(warnings, /FRESH unit serial/)
      assert.match(warnings, /source LUN .* is not touched/)
      // cr3.lunrestore: the new truth — no initiator sees it until it is whole.
      assert.match(warnings, /No initiator sees the new LUN until the whole image is written and its size is verified/)
      assert.match(warnings, /ANAS removes the backstore and its backing/)
      assert.ok(!/looking complete/.test(warnings), warnings)
      // cr3 review2 (5): the keep-on-map-or-save-failure case is said too.
      assert.match(warnings, /If mapping the LUN or saving the iSCSI configuration fails once the image is written and verified, the image, its backstore and its backing are kept/)
      assertNothingDestructive()
    })

    it('the confirmed call runs the whole sequence: fresh backing at the manifest size, FRESH serial, source untouched, saveconfig LAST', async () => {
      await serveAnas()
      // The read-back at the end of the job reads the NEW volume's size.
      mockOf().addFixture({
        command: ZFS,
        args: volsizeArgs('tank/newvol'),
        result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 },
      })

      const first = await restore(newLunBody())
      const res = await restore(newLunBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as {
        complete: boolean
        bytesWritten: number
        imageSize: number
        lunIndex: number
        targetPath: string
        targetDisabled: boolean
        targetReEnabled: boolean
        newLun?: { targetIqn: string, index: number, name: string, serial: string, backingPath: string }
        warnings?: string[]
      }
      assert.equal(result.complete, true)
      assert.equal(result.bytesWritten, IMAGE_SIZE)
      assert.equal(result.imageSize, IMAGE_SIZE)
      assert.equal(result.targetPath, NEWVOL_PATH)
      assert.equal(result.lunIndex, 1, 'mapped at the NEXT free index — the source holds 0')
      assert.equal(result.targetDisabled, false, 'the source LUN never goes offline')
      assert.equal(result.targetReEnabled, false)
      assert.equal(result.warnings, undefined, JSON.stringify(result.warnings))

      // The serial is FRESH — generated for this disk, never the source's.
      const serial = result.newLun?.serial ?? ''
      assert.match(serial, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      assert.notEqual(serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71', 'never the source LUN\'s serial')
      assert.deepEqual(result.newLun, { targetIqn: ANAS_IQN, index: 1, name: 'newvol', serial, backingPath: NEWVOL_PATH })

      const mock = mockOf()
      // The stream went to the NEW backing, write-only — pbc never saw a path.
      assert.equal(mock.streamCalls.length, 1)
      assert.deepEqual(mock.streamCalls[0].target, { path: NEWVOL_PATH, flags: constants.O_WRONLY })
      assert.deepEqual(mock.streamCalls[0].args, ['restore', SNAP, 'vol.img', '-', '--ns', 'gtrestore'])

      // The sequence, in order: volume created at the manifest size FIRST,
      // backstore with the fresh wwn, ALL attributes, the stream, the
      // read-back, and only then (cr3.lunrestore) the map at index 1, the
      // grant and saveconfig.
      const seq = mock.calls
        .map(c => `${c.command} ${c.args.join(' ')}`)
        .filter(a => a.startsWith(TARGETCLI)
          || a.includes(' restore ')
          || a === `${ZFS} create -s -V ${IMAGE_SIZE} -- tank/newvol`
          || a === `${ZFS} get -Hp -o value volsize -- tank/newvol`)
      assert.deepEqual(seq, [
        `${ZFS} create -s -V ${IMAGE_SIZE} -- tank/newvol`,
        `${TARGETCLI} /backstores/block create name=newvol dev=${NEWVOL_PATH} wwn=${serial}`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpu=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpws=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute max_unmap_lba_count=524288`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_write_cache=0`,
        `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
        `${ZFS} get -Hp -o value volsize -- tank/newvol`,
        `${TARGETCLI} /iscsi/${ANAS_IQN}/tpg1/luns create storage_object=/backstores/block/newvol lun=1`,
        `${TARGETCLI} /iscsi/${ANAS_IQN}/tpg1/acls/${INITIATOR} create 1 1`,
        `${TARGETCLI} saveconfig`,
      ], seq.join(' | '))

      // The source LUN never went offline and was never written to.
      assert.deepEqual(
        mock.calls.filter(c => c.command === TARGETCLI && (c.args.includes('disable') || c.args.includes('enable'))),
        [],
      )
      assert.ok(!mock.calls.some(c => c.args.join(' ').includes(ZVOL_PATH)), JSON.stringify(mock.calls))
    })

    // --- cr.38 session B: the target's key, released once the backstore exists (cr3.lunrestore) ---

    /**
     * Every latch a test made, opened after it — a test that fails part-way
     * must not leave a job parked inside the iSCSI lock for the next one.
     */
    const latches: (() => void)[] = []
    afterEach(() => {
      for (const open of latches.splice(0))
        open()
    })

    /** A promise the test opens, and one that settles when the code reaches it. */
    function gate(): { open: () => void, wait: Promise<void>, reached: Promise<void>, arrive: () => void } {
      let open!: () => void
      let arrive!: () => void
      const wait = new Promise<void>((resolve) => {
        open = resolve
      })
      latches.push(() => open())
      const reached = new Promise<void>((resolve) => {
        arrive = resolve
      })
      return { open, wait, reached, arrive }
    }

    /**
     * Hold the job at the backstore create (inside its iSCSI-lock section), at
     * the image stream, and at the LUN map (cr3.lunrestore: after the stream).
     */
    function pauseAtMapAndStream(mock: MockExecutor, stream: ExecStreamResult | null = null) {
      const atCreate = gate()
      const atMap = gate()
      const atStream = gate()
      const exec = mock.exec.bind(mock)
      mock.exec = async (command, args, opts) => {
        if (command === TARGETCLI && args[0] === '/backstores/block' && args[1] === 'create') {
          atCreate.arrive()
          await atCreate.wait
        }
        if (command === TARGETCLI && args[0]?.endsWith('/tpg1/luns') && args[1] === 'create') {
          atMap.arrive()
          await atMap.wait
        }
        return exec(command, args, opts)
      }
      const toStream = mock.execToStream.bind(mock)
      mock.execToStream = async (command, args, target, opts) => {
        atStream.arrive()
        await atStream.wait
        if (stream) {
          mock.calls.push({ command, args })
          return stream
        }
        return toStream(command, args, target, opts)
      }
      return { atCreate, atMap, atStream }
    }

    async function settled(queue: JobQueue, id: string): Promise<void> {
      for (let i = 0; i < 400 && !['completed', 'failed'].includes(queue.get(id)?.status ?? ''); i++)
        await new Promise(resolve => setTimeout(resolve, 5))
    }

    it('cr.38 + cr3.lunrestore: the job holds the target\'s key until the BACKSTORE exists, gives it back for the stream, and takes it again before the map', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const { atCreate, atMap, atStream } = pauseAtMapAndStream(mock)
      atMap.open()

      const first = await restore(newLunBody())
      const res = await restore(newLunBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202)
      const id = res.body.job!.id
      await atCreate.reached

      // Before the backstore exists: another verb on the same target waits.
      const probe = queue.submit('iscsi.acl.add', { user: 'test', uid: 0 }, async () => null, { locks: [iscsiTargetClaim(ANAS_IQN)] })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(queue.get(probe.id)?.status, 'queued')
      assert.equal(queue.get(probe.id)?.progress, `waiting for backup.restore.image (job ${id}) on iSCSI target ${ANAS_IQN}`)

      // The backstore exists (not mapped); the stream starts and is held — the key is back.
      atCreate.open()
      await atStream.reached
      await settled(queue, probe.id)
      assert.equal(queue.get(probe.id)?.status, 'completed', 'the target verb ran while the image streams')
      assert.equal(queue.get(id)?.status, 'running', 'the restore is still streaming')
      assert.deepEqual(queue.heldLocks(), [], 'nobody holds the target while the image streams')
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args[0]?.endsWith('/luns') && c.args[1] === 'create'), 'nothing is mapped while the image streams')

      // A verb that takes the key while the image streams makes the MAP wait.
      let endHolder!: () => void
      const holder = queue.submit('iscsi.lun.delete', { user: 'test', uid: 0 }, () => new Promise<void>((resolve) => {
        endHolder = resolve
        latches.push(resolve)
      }), { locks: [iscsiTargetClaim(ANAS_IQN)] })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(queue.get(holder.id)?.status, 'running')
      atStream.open()
      for (let i = 0; i < 400 && !(queue.get(id)?.progress ?? '').startsWith('waiting for'); i++)
        await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(queue.get(id)?.progress, `waiting for iscsi.lun.delete (job ${holder.id}) on iSCSI target ${ANAS_IQN}`)
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args[0]?.endsWith('/luns') && c.args[1] === 'create'), 'the map waits for the key')

      endHolder()
      const job = await waitForJob(id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.ok(mock.calls.some(c => c.command === TARGETCLI && c.args[0]?.endsWith('/luns') && c.args[1] === 'create'), 'mapped once the key was back')
      assert.deepEqual(queue.heldLocks(), [])
    })

    it('cr.38: a failed stream takes the target\'s key again before its undo deletes the backstore — it waits for the verb that took it', async () => {
      await serveAnas()
      const mock = mockOf()
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const { atCreate, atMap, atStream } = pauseAtMapAndStream(mock, { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 })
      atCreate.open()
      atMap.open()

      const first = await restore(newLunBody())
      const res = await restore(newLunBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      const id = res.body.job!.id
      await atStream.reached

      // A verb on the target takes the key while the image streams, and holds it.
      let endProbe!: () => void
      const probe = queue.submit('iscsi.lun.delete', { user: 'test', uid: 0 }, () => new Promise<void>((resolve) => {
        endProbe = resolve
        latches.push(resolve)
      }), { locks: [iscsiTargetClaim(ANAS_IQN)] })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(queue.get(probe.id)?.status, 'running')

      atStream.open() // the stream fails
      for (let i = 0; i < 400 && !(queue.get(id)?.progress ?? '').startsWith('waiting for'); i++)
        await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(queue.get(id)?.progress, `waiting for iscsi.lun.delete (job ${probe.id}) on iSCSI target ${ANAS_IQN}`)
      const undo = `${TARGETCLI} /backstores/block delete newvol`
      assert.ok(!mock.calls.some(c => `${c.command} ${c.args.join(' ')}` === undo), 'the undo has not touched LIO yet')

      endProbe()
      const job = await waitForJob(id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /ANAS has removed backstore 'newvol'/)
      assert.ok(mock.calls.some(c => `${c.command} ${c.args.join(' ')}` === undo), 'the undo ran, under the key')
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args[1] === 'create' && c.args[0]?.endsWith('/luns')), 'nothing was ever mapped')
      assert.deepEqual(queue.heldLocks(), [])
    })

    it('a mid-stream failure removes the backstore and its backing — nothing was mapped, and nothing is saved', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.clearFixtures()
      mock.addFixture({ command: PBC, result: { stdout: SNAPSHOT_LIST_JSON, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        result: { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 },
      })

      // The confirm gate still comes first — the failure is the job's, not the gate's.
      const first = await restore(newLunBody())
      assert.equal(first.statusCode, 409)
      assert.equal(first.body.error!.code, 'CONFIRMATION_REQUIRED')
      const res = await restore(newLunBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202)

      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /the image was partially written \(268435456 of 536870912 bytes reached the new backing \/dev\/zvol\/tank\/newvol\)/)
      assert.match(job.error!.message, /ANAS has removed backstore 'newvol', volume tank\/newvol/)
      assert.match(job.error!.message, /nothing of the failed restore remains/)

      // The undo runs in the reverse of the order the objects were made, and
      // nothing is persisted or taken offline along the way.
      const seq = mock.calls.map(c => `${c.command} ${c.args.join(' ')}`)
      const restoreIdx = seq.indexOf(`${PBC} restore ${SNAP} vol.img - --ns gtrestore`)
      assert.ok(!seq.slice(0, restoreIdx).some(a => a.includes('/luns create')), 'nothing was mapped before the stream')
      // cr3.lunrestore (D2): the undo re-reads the live tree first (reads only);
      // the ACTS after the stream are these.
      assert.deepEqual(seq.slice(restoreIdx + 1).filter(a => a.startsWith(TARGETCLI) || a.startsWith(`${ZFS} destroy`)), [
        `${TARGETCLI} /backstores/block delete newvol`,
        `${ZFS} destroy -- tank/newvol`,
      ], seq.join(' | '))
      assert.ok(!seq.some(a => a.includes('saveconfig')), 'a failed restore must not save the LIO configuration')
      assert.deepEqual(
        mock.calls.filter(c => c.command === TARGETCLI && (c.args.includes('disable') || c.args.includes('enable'))),
        [],
      )
    })

    // --- cr3.lunrestore Part B: the restore mark, through the routes ---------

    /**
     * The mock's volumes keep their `anas:restore` mark: `zfs set` stores it,
     * `zfs inherit` clears it, `zfs get ... anas:restore` answers from it (`-\t-`
     * when unset), and `unreadable` makes the read fail like a suspended pool.
     */
    function marksFollow(mock: MockExecutor): { marks: Map<string, string>, unreadable: Set<string> } {
      const marks = new Map<string, string>()
      const unreadable = new Set<string>()
      const exec = mock.exec.bind(mock)
      mock.exec = async (command, args, o) => {
        if (command === ZFS && args[0] === 'set' && (args[1] ?? '').startsWith('anas:restore=')) {
          mock.calls.push({ command, args })
          marks.set(args.at(-1)!, args[1].slice('anas:restore='.length))
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        if (command === ZFS && args[0] === 'inherit' && args[1] === 'anas:restore') {
          mock.calls.push({ command, args })
          marks.delete(args.at(-1)!)
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        if (command === ZFS && args[0] === 'get' && args.includes('anas:restore')) {
          mock.calls.push({ command, args })
          // review2 (7): the single form (`-o value,source -- <ds>`) and the
          // batched one (`-o name,value,source -- <ds>...`).
          const datasets = args.slice(args.indexOf('--') + 1)
          if (datasets.some(d => unreadable.has(d)))
            return { stdout: '', stderr: 'cannot get property: pool I/O is currently suspended', exitCode: 1 }
          const named = args.includes('name,value,source')
          const rows = datasets.map((d) => {
            const v = marks.get(d)
            const row = v === undefined ? '-\t-' : `${v}\tlocal`
            return named ? `${d}\t${row}` : row
          })
          return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 }
        }
        return exec(command, args, o)
      }
      return { marks, unreadable }
    }

    const MARK = JSON.stringify({ v: 1, repo: 'pbs-main', ns: 'gtrestore', snapshot: SNAP, archive: 'vol.img', started: '2026-11-14T10:00:00.000Z', state: 'writing' })

    /**
     * cr3.lunrestore.filemark: a node with the attr tools — the image files
     * keep `trusted.anas.restore` (setfattr stores it, getfattr answers from
     * it, every answer a captured one: `withFileMarks`). `marks` carries the
     * state across a daemon restart (a new server over the same files).
     */
    function fileMarksFollow(mock: MockExecutor, marks: Map<string, string> = new Map()) {
      const inner = mock.exec.bind(mock)
      const files = withFileMarks({ exec: inner, pipeline: mock.pipeline.bind(mock), execToStream: mock.execToStream.bind(mock) }, Object.fromEntries(marks))
      mock.exec = async (command, args, o) => {
        if (command !== GETFATTR && command !== SETFATTR)
          return inner(command, args, o)
        mock.calls.push({ command, args })
        return files.executor.exec(command, args, o)
      }
      return files
    }

    async function enable(headers: Record<string, string> = {}) {
      return server!.inject({ method: 'POST', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}/state`, headers: { ...IDENTITY, 'content-type': 'application/json', ...headers }, payload: { action: 'enable' } })
    }

    async function disableInConfigfs(): Promise<void> {
      await writeFile(join(dir, 'target', 'iscsi', ANAS_IQN, 'tpgt_1', 'enable'), '0\n')
    }

    it('R8 (review D5): an in-place restore streaming — the dashboard says a restore is running and does not invite Enable; Enable is REFUSED naming the job; the failed restore keeps the mark and the target dark', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      const g = pauseAtMapAndStream(mock, { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 })
      const first = await restore(body())
      const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      await g.atStream.reached
      await disableInConfigfs()
      assert.ok(m.marks.has('tank/vol1'), 'the mark is on the volume before the first byte')

      const status = await server!.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY })
      const sj = status.json() as { data?: { warnings?: { message: string }[] }, warnings?: { message: string }[] }
      const disabledCard = (sj.data?.warnings ?? sj.warnings ?? []).map(w => w.message).find(msg => /is disabled/.test(msg)) ?? ''
      assert.match(disabledCard, /is writing LUN 0 \('vmdisk1'\) of .* right now \(job .*\)\. Enable is refused until the restore ends\. When the restore ends, a target the restore disabled is enabled again only if the image is complete and its size verified, and put back as it was if the restore fails before writing anything and leaves the volume with no restore mark \(an earlier restore's mark, put back, keeps it disabled\); in every other case it stays disabled and the restore job says why\. A target the restore did not disable is left as it is\./)
      assert.doesNotMatch(disabledCard, /Enable it from the iSCSI screen when you are ready/)

      const en = await enable()
      assert.equal(en.statusCode, 409, en.body)
      assert.equal((en.json() as { error: { reason: string } }).error.reason, 'restore-in-progress')
      assert.match(en.body, /A whole-image restore is writing LUN 0 \('vmdisk1'\) of .* right now \(job /)
      assert.equal(en.headers['x-anas-confirm-code'], undefined, 'no confirm while it runs')

      g.atStream.open()
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /Enable on the iSCSI screen asks you to confirm that you accept the partial image, and removes the restore mark on tank\/vol1/)
      assert.ok(m.marks.has('tank/vol1'), 'the mark stays: the LUN holds a partial image')
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args.includes('enable')), 'nothing enabled the target')
    })

    it('R8 (review D5 c): an Enable accepted with no mark, still queued when a mark appears, refuses IN THE JOB — nothing is enabled', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      await disableInConfigfs()
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      // Something holds the target's key, so the accepted enable waits.
      let endHolder!: () => void
      queue.submit('iscsi.lun.delete', { user: 'test', uid: 0 }, () => new Promise<void>((resolve) => {
        endHolder = resolve
        latches.push(resolve)
      }), { locks: [iscsiTargetClaim(ANAS_IQN)] })
      await new Promise(resolve => setImmediate(resolve))
      const en = await enable()
      assert.equal(en.statusCode, 202, en.body)
      // Meanwhile a restore onto LUN 0 started and died, leaving its mark.
      m.marks.set('tank/vol1', MARK)
      endHolder()
      const job = await waitForJob((en.json() as { job: { id: string } }).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /A restore mark on .* is not the one this enable was accepted for: LUN 0 \('vmdisk1'\): a whole-image restore of vol\.img .* onto tank\/vol1 did not finish, so the LUN holds a partial image\..* Nothing was enabled/)
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args.includes('enable')), 'the half-written LUN was not served')
      assert.ok(m.marks.has('tank/vol1'))
    })

    it('review D5 b: Enable on an interrupted restore is a 409 confirm naming what and since when; the confirmed enable removes the mark, then enables', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      await disableInConfigfs()
      m.marks.set('tank/vol1', MARK)
      const first = await enable()
      assert.equal(first.statusCode, 409, first.body)
      const err = (first.json() as { error: { code: string, message: string, warnings: string[] } }).error
      assert.equal(err.code, 'CONFIRMATION_REQUIRED')
      assert.match(err.message, /^Enabling .* serves a LUN whose whole-image restore did not finish$/)
      assert.match(err.warnings.join(' '), /LUN 0 \('vmdisk1'\): a whole-image restore of vol\.img from host\/gtimgboth\/2026-08-25T19:28:38Z \(repository pbs-main, namespace gtrestore\) started 2026-11-14T10:00:00\.000Z onto tank\/vol1 did not finish, so the LUN holds a partial image\. An initiator will be served that partial image\. Confirming removes the restore mark; restoring the image again is the other way out\./)
      const res = await enable({ 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob((res.json() as { job: { id: string } }).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.ok(!m.marks.has('tank/vol1'), 'the confirm removed the mark')
      const seq = mock.calls.map(c => `${c.command} ${c.args.join(' ')}`)
      const inherit = seq.indexOf(`${ZFS} inherit anas:restore -- tank/vol1`)
      const enabled = seq.indexOf(`${TARGETCLI} /iscsi/${ANAS_IQN}/tpg1 enable`)
      assert.ok(inherit >= 0 && enabled > inherit, 'the mark goes first, then the target is enabled')
    })

    it('review D5 b: a mark that cannot be READ refuses Enable — never enabled on unknown', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      await disableInConfigfs()
      m.unreadable.add('tank/vol1')
      const en = await enable()
      assert.equal(en.statusCode, 409, en.body)
      assert.equal((en.json() as { error: { reason: string } }).error.reason, 'restore-mark-unreadable')
      assert.match(en.body, /could not check whether LUN 0 \('vmdisk1'\) of .* holds a partially restored image/)
    })

    it('review D5 d: adding an initiator ACL to a target whose LUN is marked is refused (it would reach a new initiator)', async () => {
      await serveAnas()
      const m = marksFollow(mockOf())
      m.marks.set('tank/vol1', MARK)
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}`,
        headers: { ...IDENTITY, 'content-type': 'application/json' },
        payload: { acls: [{ initiatorIqn: INITIATOR }, { initiatorIqn: 'iqn.2026-01.org.example:new' }] },
      })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal((res.json() as { error: { reason: string } }).error.reason, 'restore-mark')
      assert.match(res.body, /Adding an initiator to this target would serve that image to initiators and is refused/)
    })

    it('review D1: an add-LUN over the zvol a new-LUN restore is writing (an UNMAPPED backstore holds it) is refused with the backstore sentence', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      const g = pauseAtMapAndStream(mock)
      g.atCreate.open()
      g.atMap.open()
      const first = await restore(newLunBody())
      const res = await restore(newLunBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      await g.atStream.reached
      const add = await server!.inject({ method: 'POST', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}/luns`, headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: { name: 'other', kind: 'zvol', backing: 'tank/newvol' } })
      assert.equal(add.statusCode, 409, add.body)
      assert.equal((add.json() as { error: { reason: string } }).error.reason, 'backing-held-by-backstore')
      assert.match(add.body, /held by iSCSI backstore 'newvol' \(block, \/dev\/zvol\/tank\/newvol\), which is not mapped as a LUN/)
      assert.ok(!mock.calls.some(c => c.args.join(' ').includes('name=other')), 'no second backstore over the device')
      g.atStream.open()
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    })

    it('review2 defect A (1): a partial restore, then a retry PBS refuses before any byte — the mark of the first is still there, and Enable still asks', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      const results: ExecStreamResult[] = [
        { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 },
        // review3 3: the CAPTURED refused stderr (restore-failure-taxonomy.txt F10).
        { stderr: 'Error: client error (Connect)\n\nCaused by:\n    error connecting to https://pbs.example:8007/ - tcp connect error: Connection refused (os error 111)\n', exitCode: 255, bytesWritten: 0 },
      ]
      mock.execToStream = async (command, args) => {
        mock.calls.push({ command, args })
        return results.shift()!
      }
      let firstMark = ''
      for (const n of [1, 2]) {
        if (n === 2)
          await disableInConfigfs() // the first run left the target disabled (the mock targetcli does not touch configfs)
        const first = await restore(body())
        const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
        const job = await waitForJob(res.body.job!.id)
        assert.equal(job.status, 'failed')
        if (n === 1)
          firstMark = m.marks.get('tank/vol1') ?? ''
        else
          assert.match(job.error!.message, /Nothing was written to \/dev\/zvol\/tank\/vol1\. tank\/vol1 carries the restore mark of .* again, as it did before this restore/)
      }
      assert.ok(firstMark.length > 0)
      assert.equal(m.marks.get('tank/vol1'), firstMark, 'the first restore\'s mark, exactly')
      const en = await enable()
      assert.equal(en.statusCode, 409, en.body)
      assert.equal((en.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args.includes('enable')), 'nothing enabled the partial image')
    })

    // --- review2 D: an image FILE carries no mark; the job records close what they can

    async function statusMessages(): Promise<string[]> {
      const status = await server!.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY })
      const sj = status.json() as { data?: { warnings?: { message: string }[] }, warnings?: { message: string }[] }
      return (sj.data?.warnings ?? sj.warnings ?? []).map(w => w.message)
    }
    async function healthRows(): Promise<{ lunIndex?: number, state: string, source: string, dataset: string | null, job?: string, detail: string }[]> {
      const h = await server!.inject({ method: 'GET', url: '/v1/iscsi/health', headers: IDENTITY })
      return (h.json() as { data: { restoreMarks?: [] } }).data.restoreMarks ?? []
    }
    const enabledAfterStream = (mock: MockExecutor) => {
      const seq = mock.calls.map(c => `${c.command} ${c.args.join(' ')}`)
      const at = seq.findIndex(a => a.startsWith(`${PBC} restore`))
      return seq.slice(at + 1).filter(a => a === `${TARGETCLI} /iscsi/${ANAS_IQN}/tpg1 enable`).length
    }

    it('review2 D5-file (4a): while a FILE LUN restore streams Enable is refused and nothing invites it; once it fails part-way Enable asks, naming the job record; the confirm enables it once', async () => {
      const { imagePath } = await serveImageLun()
      const mock = mockOf()
      marksFollow(mock)
      const g = pauseAtMapAndStream(mock, { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 })
      const first = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      await g.atStream.reached
      await disableInConfigfs()
      const running = (await healthRows()).find(r => r.lunIndex === 1)
      assert.deepEqual([running?.state, running?.source, running?.dataset, running?.job], ['in-progress', 'job', null, res.body.job!.id])
      const card = (await statusMessages()).find(m => /is disabled/.test(m)) ?? ''
      assert.match(card, new RegExp(`A whole-image restore \\(job ${res.body.job!.id}\\) is writing LUN 1 \\('lun2'\\) of .* right now\\. Enable is refused until the restore ends\\.`))
      assert.doesNotMatch(card, /Enable it from the iSCSI screen when you are ready/)
      const en = await enable()
      assert.equal(en.statusCode, 409, en.body)
      assert.equal((en.json() as { error: { reason: string } }).error.reason, 'restore-in-progress')
      assert.equal(en.headers['x-anas-confirm-code'], undefined)

      g.atStream.open()
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error!.code, 'IMAGE_PARTIAL')
      // cr3.lunrestore.filemark (re-pinned): this mock node has no attr tools; the sentence says why the file carries no mark.
      assert.match(job.error!.message, /while ANAS keeps this job's record; this image file carries no restore mark because setfattr and getfattr \(the attr package, which install\.sh installs\) are not installed on this node/)

      const row = (await healthRows()).find(r => r.lunIndex === 1)
      assert.deepEqual([row?.state, row?.source, row?.job], ['interrupted', 'job', job.id])
      const ask = await enable()
      assert.equal(ask.statusCode, 409, ask.body)
      const err = (ask.json() as { error: { code: string, message: string, warnings: string[] } }).error
      assert.equal(err.code, 'CONFIRMATION_REQUIRED')
      assert.match(err.message, /serves a LUN whose whole-image restore did not finish$/)
      assert.match(err.warnings.join(' '), new RegExp(`LUN 1 \\('lun2'\\): the whole-image restore job ${job.id} onto ${imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} did not finish, so the LUN may hold a partial image\\. An initiator will be served that image\\. ANAS knows this only from that job's record in this run of the ANAS daemon: this image file carries no restore mark because setfattr and getfattr \\(the attr package, which install\\.sh installs\\) are not installed on this node, so the record is lost when the ANAS daemon restarts, or when the daemon holds more than 100 such records and more than 1000 jobs \\(the oldest record goes first\\)\\.`))
      const acl = await server!.inject({ method: 'PUT', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}`, headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: { acls: [{ initiatorIqn: INITIATOR }, { initiatorIqn: 'iqn.2026-01.org.example:new' }] } })
      assert.equal(acl.statusCode, 409, acl.body)
      assert.match(acl.body, /The whole-image restore job .* onto LUN 1 \('lun2'\) of .* did not finish, so it may hold a partial image\. ANAS knows this only from/)
      assert.equal(enabledAfterStream(mock), 0, 'the partial file was never served')

      const ok = await enable({ 'x-anas-confirm': String(ask.headers['x-anas-confirm-code']) })
      assert.equal(ok.statusCode, 202, ok.body)
      const ej = await waitForJob((ok.json() as { job: { id: string } }).job.id)
      assert.equal(ej.status, 'completed', JSON.stringify(ej.error))
      assert.equal(enabledAfterStream(mock), 1, 'the confirm accepted it: enabled once')
      assert.equal((await healthRows()).find(r => r.lunIndex === 1), undefined, 'the completed Enable accepted that record')
    })

    it('review2 D5-file (4b): an Enable accepted BEFORE a file restore ran enables nothing when the job finds that restore failed part-way', async () => {
      await serveImageLun()
      const mock = mockOf()
      marksFollow(mock)
      mock.execToStream = async (command, args) => {
        mock.calls.push({ command, args })
        return { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 }
      }
      await disableInConfigfs()
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      // Something holds the target's key, so the restore and the enable queue behind it.
      let endHolder!: () => void
      queue.submit('iscsi.lun.delete', { user: 'test', uid: 0 }, () => new Promise<void>((resolve) => {
        endHolder = resolve
        latches.push(resolve)
      }), { locks: [iscsiTargetClaim(ANAS_IQN)] })
      await new Promise(resolve => setImmediate(resolve))
      const first = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      const en = await enable()
      assert.equal(en.statusCode, 202, en.body)
      endHolder()
      const rjob = await waitForJob(res.body.job!.id)
      assert.equal(rjob.error?.code, 'IMAGE_PARTIAL')
      const ejob = await waitForJob((en.json() as { job: { id: string } }).job.id)
      assert.equal(ejob.status, 'failed')
      assert.match(ejob.error!.message, new RegExp(`^What ANAS knows about the restored images on .* is not what this enable was accepted for: LUN 1 \\('lun2'\\): the whole-image restore job ${rjob.id} .* did not finish.* Nothing was enabled`))
      assert.equal(enabledAfterStream(mock), 0, 'the half-written file was not served')
    })

    it('review3 4: an Enable confirmed over a FILE record that a later complete restore cleared enables nothing, and its STATE_CHANGED names a job record, not a mark', async () => {
      const { imagePath } = await serveImageLun()
      const mock = mockOf()
      marksFollow(mock)
      mock.execToStream = async (command, args) => {
        mock.calls.push({ command, args })
        return { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 }
      }
      const first = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal((await waitForJob(res.body.job!.id)).error?.code, 'IMAGE_PARTIAL')
      await disableInConfigfs()
      const ask = await enable()
      assert.equal(ask.statusCode, 409, ask.body)
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      let endHolder!: () => void
      queue.submit('iscsi.lun.delete', { user: 'test', uid: 0 }, () => new Promise<void>((resolve) => {
        endHolder = resolve
        latches.push(resolve)
      }), { locks: [iscsiTargetClaim(ANAS_IQN)] })
      await new Promise(resolve => setImmediate(resolve))
      const ok = await enable({ 'x-anas-confirm': String(ask.headers['x-anas-confirm-code']) })
      assert.equal(ok.statusCode, 202, ok.body)
      // A later restore onto the file completes while the Enable waits: the record no longer applies.
      const done = queue.submit('backup.restore.image', { user: 'test', uid: 0, params: { backing: imagePath, target: ANAS_IQN, lun: 1 } }, async () => ({}))
      assert.equal((await waitForJob(done.id)).status, 'completed')
      endHolder()
      const ej = await waitForJob((ok.json() as { job: { id: string } }).job.id)
      assert.equal(ej.status, 'failed')
      assert.equal(ej.error?.message, `What this enable was confirmed for on ${ANAS_IQN} (the job records of failed restores onto image files) no longer applies; nothing was enabled — enable the target again.`)
      assert.equal(enabledAfterStream(mock), 0)
    })

    it('review3 2: a file the failed restore left SHORTER is refused in place (size-mismatch) until the truncate the job names sets it back; then the door asks to confirm', async () => {
      const { imagePath } = await serveImageLun()
      const mock = mockOf()
      marksFollow(mock)
      mock.execToStream = async (command, args) => {
        mock.calls.push({ command, args })
        // The stream's open truncates the file; half the image is written.
        await truncate(imagePath, 268435456)
        return { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 }
      }
      const first = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.error?.code, 'IMAGE_PARTIAL')
      assert.ok(job.error!.message.includes(`To restore the image again in place, first set ${imagePath} to the image's ${IMAGE_SIZE} bytes with 'truncate -s ${IMAGE_SIZE} ${imagePath}'`), job.error!.message)
      const again = await restore(imageBody())
      assert.equal(again.statusCode, 409)
      assert.equal((again.body as unknown as { error: { reason: string } }).error.reason, 'size-mismatch', 'restoring again in place, as the file is now, is refused')
      await truncate(imagePath, IMAGE_SIZE) // what 'truncate -s <bytes> <path>' does
      const ask = await restore(imageBody())
      assert.equal(ask.statusCode, 409)
      assert.equal((ask.body as unknown as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED', 'at the image\'s length the door asks to confirm')
    })

    it('review3 1: the daemon\'s queue keeps a FILE LUN\'s failed restore past its 1000-job eviction (the pin is wired in createServer)', async () => {
      await serveImageLun()
      const mock = mockOf()
      marksFollow(mock)
      mock.execToStream = async (command, args) => {
        mock.calls.push({ command, args })
        return { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 }
      }
      const first = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      const rjob = await waitForJob(res.body.job!.id)
      assert.equal(rjob.error?.code, 'IMAGE_PARTIAL')
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      for (let i = 0; i < 1001; i++)
        queue.submit('test.noop', { user: 'test', uid: 0 }, async () => {})
      for (let i = 0; i < 50; i++)
        await new Promise(resolve => setImmediate(resolve))
      assert.ok(queue.list().length <= 1000 + 100, 'eviction ran')
      assert.equal(queue.get(rjob.id)?.error?.code, 'IMAGE_PARTIAL', 'pinned: still held')
      const row = (await healthRows()).find(r => r.lunIndex === 1)
      assert.deepEqual([row?.state, row?.source, row?.job], ['interrupted', 'job', rjob.id])
    })

    // --- review2 E: Repair over a hole whose backing carries a restore mark ---

    async function repairOverMarkedHole(state: 'interrupted' | 'unverified' | 'unreadable') {
      await serveAnas({ hole: true, backingPresent: `${ZVOL_PATH}:/dev/zvol/tank/gone` })
      const m = marksFollow(mockOf())
      if (state === 'interrupted')
        m.marks.set('tank/gone', MARK)
      if (state === 'unverified')
        m.marks.set('tank/gone', JSON.stringify({ ...JSON.parse(MARK), state: 'unverified', reason: 'size could not be re-read' }))
      if (state === 'unreadable')
        m.unreadable.add('tank/gone')
      return server!.inject({ method: 'POST', url: '/v1/iscsi/health/repair', headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: {} })
    }

    it('review2 E (5): Repair over an interrupted mark answers its own reason, a true sentence, and ways out that exist for a hole', async () => {
      const r = await repairOverMarkedHole('interrupted')
      assert.equal(r.statusCode, 409, r.body)
      const err = (r.json() as { error: { reason: string, message: string } }).error
      assert.equal(err.reason, 'restore-mark')
      assert.equal(err.message, 'None of the missing LUNs can be repaired. One hole is held back by a restore mark on the backing: '
      + `LUN 1 of ${ANAS_IQN} (backstore 'ghost', /dev/zvol/tank/gone): a whole-image restore of vol.img from ${SNAP} (repository pbs-main, `
      + 'namespace gtrestore) started 2026-11-14T10:00:00.000Z onto tank/gone did not finish, so it holds a partial image. Repair would map '
      + 'that image into the target again, so it does not. If you accept the image as it is, clear its restore mark '
      + '(\'zfs inherit anas:restore tank/gone\') and run Repair again. If you do not, saving the iSCSI configuration by hand '
      + '(\'targetcli saveconfig\') removes the LUN from the saved configuration for good, together with every other missing LUN; '
      + 'the volume keeps its mark, and the image can then be restored as a new LUN.')
      assert.doesNotMatch(err.message, /Restore the image again|\.\.|record-incomplete|does not describe/)
    })

    it('review2 E (5): Repair over an unverified mark says the client reported it complete', async () => {
      const r = await repairOverMarkedHole('unverified')
      const err = (r.json() as { error: { reason: string, message: string } }).error
      assert.equal(err.reason, 'restore-mark')
      assert.match(err.message, /a whole-image restore of vol\.img .* wrote tank\/gone, and the client reported the image complete, but its size was not verified \(size could not be re-read\)\. Repair would map that image/)
    })

    it('review2 E (5): Repair over a mark that cannot be read: one stop, and the wait named', async () => {
      const r = await repairOverMarkedHole('unreadable')
      const err = (r.json() as { error: { reason: string, message: string } }).error
      assert.equal(err.reason, 'restore-mark')
      assert.match(err.message, /: ANAS could not read the restore mark on tank\/gone \(cannot get property: pool I\/O is currently suspended\), so it cannot tell whether it holds a partially restored image\. Repair is refused for a LUN whose restore mark could not be read until it can be read\. To see what ANAS sees, run 'zfs get -Hp -o value,source anas:restore -- tank\/gone' as root\. When its value column holds the mark, or is '-' \(no mark\), ANAS reads the same and Repair is no longer refused for it\.$/)
      assert.doesNotMatch(err.message, /\.\./)
    })

    it('cr3.lunrestore.filemark: Repair over a hole whose IMAGE FILE carries the mark is held back, with the setfattr way out; unmarked, it is repaired', async () => {
      // The file LUN 1 is in the saved configuration and not live: a hole on an image file.
      const imageDir = join(dir, 'gtiscsi', 'images')
      const imagePath = join(imageDir, 'lun2.raw')
      await mkdir(imageDir, { recursive: true })
      await writeFile(imagePath, '')
      await truncate(imagePath, IMAGE_SIZE)
      const hole = async () => {
        await rm(join(dir, 'target'), { recursive: true, force: true, maxRetries: 5 })
        await serve({
          manifest: anasManifest(),
          saveconfigText: anasSaveconfig(false, imagePath),
          backingPresent: `${ZVOL_PATH}:${imagePath}`,
          deviceStat: `${ZVOL_PATH}=230:16;${imagePath}=file:66306:4242`,
        })
        const mock = mockOf()
        const mounts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup/findmnt-nested.json'), 'utf-8')
          .replace('"target": "/gtiscsi/images"', `"target": ${JSON.stringify(imageDir)}`)
        mock.prependFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: mounts, stderr: '', exitCode: 0 } })
        mock.prependFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: `gtiscsi\t${join(dir, 'gtiscsi')}\ngtiscsi/images\t${imageDir}\n`, stderr: '', exitCode: 0 } })
        marksFollow(mock)
        return mock
      }
      const files = fileMarksFollow(await hole(), new Map([[imagePath, Buffer.from(MARK, 'utf8').toString('hex')]]))
      const r = await server!.inject({ method: 'POST', url: '/v1/iscsi/health/repair', headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: {} })
      assert.equal(r.statusCode, 409, r.body)
      const err = (r.json() as { error: { reason: string, message: string } }).error
      assert.equal(err.reason, 'restore-mark')
      assert.match(err.message, new RegExp(`One hole is held back by a restore mark on the backing: LUN 1 of .* \\(backstore 'lun2', ${imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\): a whole-image restore of vol\\.img .* onto ${imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} did not finish, so it holds a partial image\\.`))
      assert.match(err.message, new RegExp(`clear its restore mark \\('setfattr -x trusted\\.anas\\.restore ${imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'\\) and run Repair again`))
      assert.match(err.message, /the image file keeps its mark, and the image can then be restored as a new LUN\./)
      assert.equal(files.stateOf(imagePath), 'writing', 'Repair touched nothing')

      // The same hole with the mark removed by hand: nothing holds it back.
      await server!.close()
      server = undefined
      const again = await hole()
      fileMarksFollow(again)
      const ok = await server!.inject({ method: 'POST', url: '/v1/iscsi/health/repair', headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: {} })
      assert.equal(ok.statusCode, 202, ok.body)
      await waitForJob((ok.json() as { job: { id: string } }).job.id)
    })

    it('review S3: Repair over a hole whose image FILE carries no mark but whose failed restore record stands is held back, as Enable asks (one verdict at every door)', async () => {
      const { imagePath } = await serveImageLun()
      const mock = mockOf()
      // No attr tools on this mock node: the file cannot carry a mark, the job record stands in.
      const g = pauseAtMapAndStream(mock, { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 })
      g.atStream.open()
      const ask = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(ask.headers['x-anas-confirm-code']) })
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.error?.code, 'IMAGE_PARTIAL')
      // The LUN is lost from the live tree (and its backstore with it): a hole the saved configuration still names.
      await rm(join(dir, 'target', 'iscsi', ANAS_IQN, 'tpgt_1', 'lun', 'lun_1'), { recursive: true, force: true })
      await rm(join(dir, 'target', 'core', 'fileio_0', 'lun2'), { recursive: true, force: true })
      const r = await server!.inject({ method: 'POST', url: '/v1/iscsi/health/repair', headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: {} })
      assert.equal(r.statusCode, 409, r.body)
      const err = (r.json() as { error: { reason: string, message: string } }).error
      assert.equal(err.reason, 'restore-mark')
      assert.match(err.message, new RegExp(`One hole is held back by a restore mark on the backing: LUN 1 of .* \\(backstore 'lun2', ${imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\): the whole-image restore job ${job.id} onto it did not finish, so it may hold a partial image\\. ANAS knows this only from that job's record in this run of the ANAS daemon: this image file carries no restore mark because setfattr and getfattr`))
      assert.doesNotMatch(err.message, /clear its restore mark|keeps its mark/)
      assert.doesNotMatch(err.message, /\.\./)
    })

    // --- review2 F (6): every sentence true on the path that prints it ------

    it('review2 F2 (6): adding an initiator while a restore RUNS says it runs — never "did not finish"', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      const g = pauseAtMapAndStream(mock, { stderr: 'restore complete (512 MiB processed in 0.6s)    \n', exitCode: 0, bytesWritten: IMAGE_SIZE })
      const first = await restore(body())
      const res = await restore(body(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      await g.atStream.reached
      assert.ok(m.marks.has('tank/vol1'))
      const acl = await server!.inject({ method: 'PUT', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}`, headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: { acls: [{ initiatorIqn: INITIATOR }, { initiatorIqn: 'iqn.2026-01.org.example:new' }] } })
      assert.equal(acl.statusCode, 409, acl.body)
      const err = (acl.json() as { error: { reason: string, message: string } }).error
      assert.equal(err.reason, 'restore-in-progress')
      assert.equal(err.message, `A whole-image restore is writing LUN 0 ('vmdisk1') of ${ANAS_IQN} right now (job ${res.body.job!.id}). Adding an initiator to this target is refused until the restore ends.`)
      g.atStream.open()
      await waitForJob(res.body.job!.id)
    })

    it('review2 F (6): a confirm replayed after the mark CHANGED names the two marks in words, never their JSON', async () => {
      await serveAnas()
      const m = marksFollow(mockOf())
      await disableInConfigfs()
      m.marks.set('tank/vol1', MARK)
      const first = await enable()
      m.marks.set('tank/vol1', JSON.stringify({ ...JSON.parse(MARK), state: 'unverified', reason: 'size could not be re-read' }))
      const replay = await enable({ 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      assert.equal(replay.statusCode, 409, replay.body)
      const err = (replay.json() as { error: { code: string, message: string } }).error
      assert.equal(err.code, 'CONFIRM_SCOPE_CHANGED')
      assert.equal(err.message, 'what ANAS knows about the restored images on its LUNs changed since you confirmed (was: tank/vol1: an unfinished '
      + `whole-image restore of vol.img from ${SNAP} (repository pbs-main, namespace gtrestore) started 2026-11-14T10:00:00.000Z; now: `
      + `tank/vol1: an unverified whole-image restore of vol.img from ${SNAP} (repository pbs-main, namespace gtrestore) started `
      + '2026-11-14T10:00:00.000Z (not verified: size could not be re-read)) — confirm again')
      assert.doesNotMatch(err.message, /[{}"]/)
      assert.ok(replay.headers['x-anas-confirm-code'], 'a fresh code for the new state')
    })

    it('review2 F (6): the confirm removed the mark and the ENABLE then failed — the job error says the mark was removed', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      await disableInConfigfs()
      m.marks.set('tank/vol1', MARK)
      mock.prependFixture({ command: TARGETCLI, args: [`/iscsi/${ANAS_IQN}/tpg1`, 'enable'], result: { stdout: '', stderr: 'Cannot enable: no portal', exitCode: 1 } })
      const first = await enable()
      const res = await enable({ 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      const job = await waitForJob((res.json() as { job: { id: string } }).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, new RegExp(`^The restore mark was removed from tank/vol1, as the confirm accepted, but enabling ${ANAS_IQN.replace(/[.:]/g, '\\$&')} then failed: .*Cannot enable: no portal`))
      assert.equal(m.marks.has('tank/vol1'), false)
    })

    it('review2 F (6): a mark that cannot be removed enables nothing, and says so', async () => {
      await serveAnas()
      const mock = mockOf()
      const m = marksFollow(mock)
      await disableInConfigfs()
      m.marks.set('tank/vol1', MARK)
      const inner = mock.exec.bind(mock)
      mock.exec = async (command, args, o) => {
        if (command === ZFS && args[0] === 'inherit')
          return { stdout: '', stderr: 'cannot inherit anas:restore for \'tank/vol1\': pool I/O is currently suspended', exitCode: 1 }
        return inner(command, args, o)
      }
      const first = await enable()
      const res = await enable({ 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      const job = await waitForJob((res.json() as { job: { id: string } }).job.id)
      assert.equal(job.error?.message, 'could not remove the restore mark anas:restore from tank/vol1: cannot inherit anas:restore for \'tank/vol1\': pool I/O is currently suspended. Nothing was enabled.')
      assert.ok(!mock.calls.some(c => c.command === TARGETCLI && c.args.includes('enable')))
    })

    it('review2 F1 (6): the in-place confirm promises a re-enable only where the restore would make one, per backing kind', async () => {
      await serveAnas()
      const zvolOn = (await restore(body())).body as unknown as { error: { warnings: string[] } }
      const on = zvolOn.error.warnings.join('\n')
      assert.match(on, /When the restore ends, the target is enabled again only if the image is complete and its size verified, and put back as it was if the restore fails before writing anything and leaves the volume with no restore mark \(an earlier restore's mark, put back, keeps it disabled\); in every other case it stays disabled and the restore job says why\./)
      assert.match(on, /the volume keeps the restore mark anas:restore, so Enable asks you to confirm before it serves that image\./)
      assert.doesNotMatch(on, /re-enabled when the restore finishes|explicitly enable it/)
      await disableInConfigfs()
      const off = ((await restore(body())).body as unknown as { error: { warnings: string[] } }).error.warnings.join('\n')
      assert.match(off, /The target is disabled now; a restore leaves a target it did not disable as it finds it\./)
      assert.doesNotMatch(off, /enables the target again/)
    })

    it('review2 F1 (6): the in-place confirm on an image FILE that cannot carry a mark (no attr tools) says the job record is the only record, and why', async () => {
      await serveImageLun()
      const res = (await restore(imageBody())).body as unknown as { error: { warnings: string[] } }
      const w = res.error.warnings.join('\n')
      // cr3.lunrestore.filemark (re-pinned): the door reads the file's mark; on this mock node there are no attr tools.
      assert.match(w, /Enable asks you to confirm before it serves that image while ANAS keeps the restore job's record; this image file carries no restore mark because setfattr and getfattr \(the attr package, which install\.sh installs\) are not installed on this node, so the record is lost when the ANAS daemon restarts, or when the daemon holds more than 100 such records and more than 1000 jobs \(the oldest record goes first\)\./)
      assert.doesNotMatch(w, /anas:restore/)
      // review3 4: the three endings, true for a file: a failed restore that opened it never comes back enabled.
      assert.match(w, /When the restore ends, the target is enabled again only if the image is complete and its size verified, and put back as it was if the restore fails before it opens the image file and the file is still the image's size \(opening it for the restore empties it\); in every other case it stays disabled and the restore job says why\./)
    })

    it('cr3.lunrestore.filemark: the in-place confirm on an image FILE that carries the mark promises the mark, and the endings true for a marked file', async () => {
      await serveImageLun()
      fileMarksFollow(mockOf())
      const w = ((await restore(imageBody())).body as unknown as { error: { warnings: string[] } }).error.warnings.join('\n')
      assert.match(w, /If the restore fails part-way, the LUN holds a HALF-WRITTEN image: the target stays disabled and the image file keeps the restore mark trusted\.anas\.restore, so Enable asks you to confirm before it serves that image\./)
      assert.match(w, /put back as it was if the restore fails before it opens the image file, the file is still the image's size and it is left with no restore mark \(opening it for the restore empties it; an earlier restore's mark, put back, keeps it disabled\)/)
      assert.doesNotMatch(w, /keeps the restore job's record|the record is lost/)
    })

    it('cr3.lunrestore.filemark — THE ORACLE for a file LUN: a restore that fails part-way leaves the mark on the file; after a daemon restart (an empty queue) the health row, the add-initiator refusal and Enable still say so; the confirm removes the mark and enables once', async () => {
      const { imagePath } = await serveImageLun()
      const first = mockOf()
      marksFollow(first)
      const files = fileMarksFollow(first)
      const g = pauseAtMapAndStream(first, { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 })
      const ask0 = await restore(imageBody())
      const res = await restore(imageBody(), { 'x-anas-confirm': String(ask0.headers['x-anas-confirm-code']) })
      assert.equal(res.statusCode, 202, JSON.stringify(res.body))
      await g.atStream.reached
      // The mark is on the file BEFORE the stream opened it (the open empties it).
      assert.equal(files.stateOf(imagePath), 'writing')
      const setAt = first.calls.findIndex(c => c.command === SETFATTR && c.args[0] === '-n')
      const readAt = first.calls.findIndex(c => c.command === GETFATTR)
      assert.ok(readAt >= 0 && setAt > readAt, 'the earlier mark is read first, then this run\'s is set')
      g.atStream.open()
      const job = await waitForJob(res.body.job!.id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error!.code, 'IMAGE_PARTIAL')
      assert.match(job.error!.message, new RegExp(`removes the restore mark on ${imagePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\. To restore the image again in place, first set`))
      assert.doesNotMatch(job.error!.message, /the record is lost/)
      assert.equal(files.stateOf(imagePath), 'writing', 'the failed run leaves its mark')
      assert.ok(!first.calls.some(c => c.command === SETFATTR && c.args[0] === '-x'), 'never removed after a partial write')

      // THE RESTART: a new daemon over the same node — an empty job queue, the file keeps its mark.
      await server!.close()
      server = undefined
      // The configfs tree is materialized afresh (the node's LIO, as it boots).
      await rm(join(dir, 'target'), { recursive: true, force: true })
      await serveImageLun()
      const second = mockOf()
      marksFollow(second)
      const after = fileMarksFollow(second, files.marks)
      await disableInConfigfs()
      const row = (await healthRows()).find(r => r.lunIndex === 1)
      assert.deepEqual([row?.state, row?.source, row?.dataset, row?.job], ['interrupted', 'mark', null, undefined])
      assert.match(row?.detail ?? '', /A whole-image restore of vol\.img from .* did not finish: it holds a partial image\. To restore the image again in place, first set /)
      const card = (await statusMessages()).find(m => /is disabled/.test(m)) ?? ''
      assert.match(card, /did not finish: it holds a partial image/)
      assert.match(card, /Enable on the iSCSI screen asks you to confirm and removes the restore mark\./)
      assert.doesNotMatch(card, /Enable it from the iSCSI screen when you are ready/)
      const acl = await server!.inject({ method: 'PUT', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}`, headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: { acls: [{ initiatorIqn: INITIATOR }, { initiatorIqn: 'iqn.2026-01.org.example:new' }] } })
      assert.equal(acl.statusCode, 409, acl.body)
      assert.equal((acl.json() as { error: { reason: string } }).error.reason, 'restore-mark')
      assert.match(acl.body, /the restore mark trusted\.anas\.restore on /)
      const ask = await enable()
      assert.equal(ask.statusCode, 409, ask.body)
      const err = (ask.json() as { error: { code: string, message: string, warnings: string[] } }).error
      assert.equal(err.code, 'CONFIRMATION_REQUIRED')
      assert.match(err.message, /serves a LUN whose whole-image restore did not finish$/)
      assert.match(err.warnings.join(' '), /LUN 1 \('lun2'\): a whole-image restore of vol\.img .* did not finish, so the LUN holds a partial image\. An initiator will be served that partial image\. Confirming removes the restore mark\. To restore the image again in place/)
      assert.doesNotMatch(err.warnings.join(' '), /the record is lost/)
      const ok = await enable({ 'x-anas-confirm': String(ask.headers['x-anas-confirm-code']) })
      assert.equal(ok.statusCode, 202, ok.body)
      const ej = await waitForJob((ok.json() as { job: { id: string } }).job.id)
      assert.equal(ej.status, 'completed', JSON.stringify(ej.error))
      const removeAt = second.calls.findIndex(c => c.command === SETFATTR && c.args.join(' ') === `-x trusted.anas.restore -- ${imagePath}`)
      const enableAt = second.calls.findIndex(c => c.command === TARGETCLI && c.args.join(' ') === `/iscsi/${ANAS_IQN}/tpg1 enable`)
      assert.ok(removeAt >= 0 && enableAt > removeAt, 'the mark goes, then the target is enabled')
      assert.equal(after.stateOf(imagePath), 'none')
      assert.equal((await healthRows()).find(r => r.lunIndex === 1), undefined)
    })

    it('review2 F (6): an add-LUN over a backstore a restore is writing names the job, ends with its stop, and does not say delete it', async () => {
      await serveAnas()
      const mock = mockOf()
      mock.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
      const g = pauseAtMapAndStream(mock)
      g.atCreate.open()
      g.atMap.open()
      const first = await restore(newLunBody())
      const res = await restore(newLunBody(), { 'x-anas-confirm': String(first.headers['x-anas-confirm-code']) })
      await g.atStream.reached
      const add = await server!.inject({ method: 'POST', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}/luns`, headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: { name: 'other', kind: 'zvol', backing: 'tank/newvol' } })
      const msg = (add.json() as { error: { message: string } }).error.message
      assert.match(msg, new RegExp(`a whole-image restore as a new LUN is writing the image into it right now \\(job ${res.body.job!.id}\\)\\. .*adding it as a LUN is refused while the restore runs; when it ends, the restore maps it as a LUN itself or says why it did not\\.$`))
      assert.doesNotMatch(msg, /Delete the backstore|delete newvol/)
      const name = await server!.inject({ method: 'POST', url: `/v1/iscsi/targets/${encodeURIComponent(ANAS_IQN)}/luns`, headers: { ...IDENTITY, 'content-type': 'application/json' }, payload: { name: 'newvol', kind: 'zvol', backing: 'tank/other' } })
      const nmsg = (name.json() as { error: { message: string } }).error.message
      assert.equal(nmsg, `A backstore named 'newvol' exists on this node and no LUN maps it: a whole-image restore is writing its image right now (job ${res.body.job!.id}). The name is the SCSI model string initiators see, so it has to be unique: pick another name.`)
      g.atStream.open()
      await waitForJob(res.body.job!.id)
    })

    // --- cr.54 (review H3): the new-LUN restore is on the guard ------------

    describe('cr.54 — the confirm binds the whole request; the job re-reads and re-gates; the backing\'s keys', () => {
      function queueOf(): JobQueue {
        return (server as unknown as { jobQueue: JobQueue }).jobQueue
      }

      /** Mint a code for `payload`, asserting the first answer is the plain challenge. */
      async function mint(payload: unknown): Promise<string> {
        const first = await restore(payload)
        assert.equal(first.statusCode, 409, JSON.stringify(first.body))
        assert.equal(first.body.error!.code, 'CONFIRMATION_REQUIRED')
        return String(first.headers['x-anas-confirm-code'])
      }

      function assertScopeChanged(res: Res, field: string): void {
        assert.equal(res.statusCode, 409, JSON.stringify(res.body))
        const err = res.body.error as { code: string, message: string, changed?: string[] }
        assert.equal(err.code, 'CONFIRM_SCOPE_CHANGED')
        assert.ok(err.changed?.includes(field), `the 409 names '${field}': ${JSON.stringify(err.changed)}`)
        assert.ok(res.headers['x-anas-confirm-code'], 'a fresh code for the request as it is now')
        assertNothingDestructive()
        assert.ok(!mockOf().calls.some(c => c.command === ZFS && c.args[0] === 'create'), 'no volume created')
      }

      it('the H3 probe: a code minted for archive vol.img replayed with lun.img is 409 CONFIRM_SCOPE_CHANGED naming the archive — no restore argv', async () => {
        await serveAnas()
        const code = await mint(newLunBody())
        const res = await restore(newLunBody({ archive: 'lun.img' }), { 'x-anas-confirm': code })
        assertScopeChanged(res, 'archive')
      })

      it('a code minted for one snapshot replayed with another is 409 CONFIRM_SCOPE_CHANGED naming the snapshot', async () => {
        await serveAnas()
        const code = await mint(newLunBody())
        // The manifest lists the second group's snapshot too (gtsmall); its archive is the same name.
        const res = await restore(newLunBody({ snapshot: 'host/gtsmall/2026-08-25T19:26:40Z' }), { 'x-anas-confirm': code })
        assertScopeChanged(res, 'snapshot')
      })

      it('a code minted for namespace gtrestore replayed with another namespace is 409 CONFIRM_SCOPE_CHANGED naming ns', async () => {
        await serveAnas()
        const code = await mint(newLunBody())
        const res = await restore(newLunBody({ ns: 'other' }), { 'x-anas-confirm': code })
        assertScopeChanged(res, 'ns')
      })

      it('a code minted for a zvol on tank replayed with a file backing is 409 CONFIRM_SCOPE_CHANGED naming the backing (kind and pool are signed)', async () => {
        await serveAnas()
        mockOf().addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/tank/images\n', stderr: '', exitCode: 0 } })
        const code = await mint(newLunBody())
        const res = await restore(newLunBody(targetWith({ backing: { kind: 'file', dataset: 'tank/images' } })), { 'x-anas-confirm': code })
        assertScopeChanged(res, 'backing')
      })

      // cr.64a (item 4a, the cr.54 review's coverage item): the request body
      // NEVER changes — only the dataset's mountpoint does. Nothing but the
      // confirm's bound `confirmScope` backing path can tell the operator
      // that the image now lands somewhere other than where they confirmed.
      it('cr.54\'s confirmScope pin: the backing dataset\'s mountpoint MOVES between mint and resend — same body — 409 CONFIRM_SCOPE_CHANGED naming the backing', async () => {
        await serveAnas()
        const mock = mockOf()
        mock.addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/tank/images\n', stderr: '', exitCode: 0 } })
        const payload = newLunBody(targetWith({ backing: { kind: 'file', dataset: 'tank/images' } }))
        const code = await mint(payload)
        // The dataset's mountpoint moves BEFORE the resend; the body is identical.
        mock.prependFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/srv/images\n', stderr: '', exitCode: 0 } })
        const res = await restore(payload, { 'x-anas-confirm': code })
        assertScopeChanged(res, 'backing')
      })

      /** A job holding `claim` until released — the restore queues behind it while the node changes. */
      function hold(operation: string, claim: LockClaim): { id: string, release: () => void } {
        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        latches.push(release)
        const job = queueOf().submit(operation, { user: 'test', uid: 0 }, () => held, { locks: [claim] })
        return { id: job.id, release }
      }

      async function queuedBehind(id: string, progress: string): Promise<void> {
        for (let i = 0; i < 200 && queueOf().get(id)?.status !== 'queued'; i++)
          await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(queueOf().get(id)?.status, 'queued', 'the restore waits')
        assert.equal(queueOf().get(id)?.progress, progress)
      }

      it('a file backing whose dataset MOVED while the job waited fails the job STATE_CHANGED naming both paths — no volume, no targetcli, no stream', async () => {
        await serveAnas()
        const mock = mockOf()
        mock.addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/tank/images\n', stderr: '', exitCode: 0 } })
        const payload = newLunBody(targetWith({ backing: { kind: 'file', dataset: 'tank/images' } }))
        const code = await mint(payload)
        const blocker = hold('iscsi.acl.add', iscsiTargetClaim(ANAS_IQN))
        const res = await restore(payload, { 'x-anas-confirm': code })
        assert.equal(res.statusCode, 202, JSON.stringify(res.body))
        const id = res.body.job!.id
        await queuedBehind(id, `waiting for iscsi.acl.add (job ${blocker.id}) on iSCSI target ${ANAS_IQN}`)

        // The dataset's mountpoint changed while the restore waited.
        mock.prependFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/srv/images\n', stderr: '', exitCode: 0 } })
        blocker.release()
        const job = await waitForJob(id)
        assert.equal(job.status, 'failed')
        assert.equal(job.error?.code, 'STATE_CHANGED')
        assert.match(job.error!.message, /was: \/tank\/images\/newvol\.raw; now: \/srv\/images\/newvol\.raw/)
        assertNothingDestructive()
      })

      // cr.64b1 (E): the new-LUN door's own `locksMoved` sentence, emitted by
      // the real route. The backing PATH does not move (the unmoved gate
      // passes) — the filesystem under it does: the dev mock's mount table has
      // no row for /tank/images (the image directory sits on `/`), and while
      // the restore waits the dataset is mounted there (findmnt-full.json's
      // `mnttest/data` row re-pointed, as mover-source-locks.test.ts does).
      it('cr.64b1 (E): the backing path unchanged but its FILESYSTEM moved while the job waited — STATE_CHANGED with the door\'s own sentence naming the backing; no volume, no targetcli, no stream', async () => {
        await serveAnas()
        const mock = mockOf()
        mock.addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/tank/images\n', stderr: '', exitCode: 0 } })
        const payload = newLunBody(targetWith({ backing: { kind: 'file', dataset: 'tank/images' } }))
        const code = await mint(payload)
        const blocker = hold('iscsi.acl.add', iscsiTargetClaim(ANAS_IQN))
        const res = await restore(payload, { 'x-anas-confirm': code })
        assert.equal(res.statusCode, 202, JSON.stringify(res.body))
        const id = res.body.job!.id
        await queuedBehind(id, `waiting for iscsi.acl.add (job ${blocker.id}) on iSCSI target ${ANAS_IQN}`)

        const mounted = readFileSync(join(MOUNTS_FIXTURES, 'findmnt-full.json'), 'utf8')
          .replace('"target": "/mnttest/data"', '"target": "/tank/images"')
          .replace('"source": "mnttest/data"', '"source": "tank/images"')
        mock.prependFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: mounted, stderr: '', exitCode: 0 } })
        blocker.release()
        const job = await waitForJob(id)
        assert.equal(job.status, 'failed')
        assert.equal(job.error?.code, 'STATE_CHANGED')
        assert.match(job.error!.message, / changed while this run waited \(the new LUN's backing \/tank\/images\/newvol\.raw now lives on a different filesystem\) — the run holds no lock on /)
        assert.match(job.error!.message, /the mount at \/tank\/images/)
        assertNothingDestructive()
        assert.ok(!mockOf().calls.some(c => c.command === ZFS && c.args[0] === 'create'), 'no volume created')
      })

      it('cr.56: a credential DELETED while the new-LUN restore waits fails the job naming it — the job reads the repository and its secret again; no volume, no targetcli, no stream', async () => {
        await serveAnas()
        const mock = mockOf()
        mock.addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank\t/tank\ntank/images\t/tank/images\n', stderr: '', exitCode: 0 } })
        const payload = newLunBody(targetWith({ backing: { kind: 'file', dataset: 'tank/images' } }))
        const code = await mint(payload)
        const blocker = hold('iscsi.acl.add', iscsiTargetClaim(ANAS_IQN))
        const res = await restore(payload, { 'x-anas-confirm': code })
        assert.equal(res.statusCode, 202, JSON.stringify(res.body))
        const id = res.body.job!.id
        await queuedBehind(id, `waiting for iscsi.acl.add (job ${blocker.id}) on iSCSI target ${ANAS_IQN}`)

        await rm(join(dir, 'creds', 'backup-repo-pbs-main.secret'))
        blocker.release()
        const job = await waitForJob(id)
        assert.equal(job.status, 'failed')
        assert.equal(job.error!.message, `No secret stored for repository 'pbs-main' — set its credentials first; nothing was restored`)
        assertNothingDestructive()
      })

      it('a pool PVE claims while the job waits refuses the guest-named backing IN THE JOB (the backing gate runs again) — no zfs create, no targetcli, no stream', async () => {
        await serveAnas()
        const payload = newLunBody(targetWith({ name: 'vm-101-disk-0' }))
        const code = await mint(payload)
        const blocker = hold('iscsi.acl.add', iscsiTargetClaim(ANAS_IQN))
        const res = await restore(payload, { 'x-anas-confirm': code })
        assert.equal(res.statusCode, 202, JSON.stringify(res.body))
        const id = res.body.job!.id
        await queuedBehind(id, `waiting for iscsi.acl.add (job ${blocker.id}) on iSCSI target ${ANAS_IQN}`)

        await writeFile(process.env.ANAS_STORAGE_CFG!, 'zfspool: local-zfs\n\tpool tank\n\tcontent images,rootdir\n')
        blocker.release()
        const job = await waitForJob(id)
        assert.equal(job.status, 'failed')
        assert.equal(job.error?.code, 'CONFLICT')
        assert.match(job.error!.message, /guest volume/)
        assertNothingDestructive()
        assert.ok(!mockOf().calls.some(c => c.command === ZFS && c.args[0] === 'create'), 'no volume created')
      })

      it('a zvol restore holds the new volume\'s dataset keys (as a dataset create): a pool-namespace verb holding tank makes it wait, named', async () => {
        await serveAnas()
        mockOf().addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
        const code = await mint(newLunBody())
        // The pool's guid cannot be read in this harness, so the volume's
        // claims fall back to the pool's name key (§4.2) — what a destroy or
        // export of `tank` holds.
        const blocker = hold('zfs.pool.destroy', znameClaim('tank'))
        const res = await restore(newLunBody(), { 'x-anas-confirm': code })
        assert.equal(res.statusCode, 202, JSON.stringify(res.body))
        const id = res.body.job!.id
        await queuedBehind(id, `waiting for zfs.pool.destroy (job ${blocker.id}) on the pool name 'tank'`)
        assert.ok(!mockOf().calls.some(c => c.command === ZFS && c.args[0] === 'create'), 'nothing created while it waits')
        blocker.release()
        const job = await waitForJob(id)
        assert.equal(job.status, 'completed', JSON.stringify(job.error))
      })
    })
  })
})
