/**
 * cr.64b2-iii (I): Repair's 409 on a hole that was a served PLACEHOLDER.
 *
 * The door quarantines first (story iscsi.8): the read at
 * routes/iscsi-mutate.ts:1214 tears the stub out of the live tree before the
 * plan is built, so the hole the plan reports is the ordinary absence the
 * placeholder became. The plain `backing-absent` sentence used to read as if
 * nothing had happened at all — it must say what THIS request did: took the
 * placeholder offline and kept the persisted record.
 *
 * The world is the stub shape pinned by services/__tests__/iscsi-stub.test.ts
 * (the iscsi.8 commit): the same ground-truth configfs manifest and
 * saveconfig record, the same two-signal fake filesystem (a REAL 0-byte file
 * under a temp dir, a findmnt table where the child dataset did not mount, a
 * zfs mountpoint list that says where the image should be). The quarantine's
 * `targetcli` pair runs against the mock executor; the file removal is real.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { JobQueue } from '../../jobs/queue.js'
import { iscsiMutationRoutes } from '../../routes/iscsi-mutate.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { TARGETCLI } from '../../services/iscsi-mutate.js'

const IQN = 'iqn.2026-08.dev.anas-pve.anas:lp2'
const IMAGE_SIZE = 268435456

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': '11111111-2222-4333-8444-555555555555',
}

/**
 * A mock `targetcli` that also moves the materialized configfs, so the
 * post-quarantine read sees the truth the tear-down left: the LUN unmapped and
 * its backstore gone. (The service-level stub suite keeps targetcli a pure
 * recorder; the ROUTE needs the hole to actually exist afterwards, or Repair
 * answers `nothing-to-repair` instead of the sentence under test.)
 */
class ConfigfsMutatingExecutor extends MockExecutor {
  constructor(private readonly root: string) {
    super()
  }

  override async exec(command: string, args: string[], opts?: Parameters<MockExecutor['exec']>[2]) {
    const result = await super.exec(command, args, opts)
    if (command === TARGETCLI && args[1] === 'delete') {
      if (args[0] === '/backstores/fileio' && args[2] === 'lpsmall')
        await rm(join(this.root, 'core/fileio_0/lpsmall'), { recursive: true, force: true })
      else if (args[0].endsWith('/luns') && args[2] === 'lun0')
        await rm(join(this.root, `iscsi/${IQN}/tpgt_1/lun/lun_0`), { recursive: true, force: true })
    }
    return result
  }
}

/** The live tree: ONE fileio LUN, ACTIVATED, at the recorded size (the F2 lie). */
function manifest(image: string): string {
  const tpg = `iscsi/${IQN}/tpgt_1`
  return [
    'D core',
    'D core/fileio_0',
    'D core/fileio_0/lpsmall',
    `F core/fileio_0/lpsmall/udev_path = ${image}`,
    'F core/fileio_0/lpsmall/enable = 1',
    `F core/fileio_0/lpsmall/info = Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384\\n        TCM FILEIO ID: 0        File: ${image}  Size: ${IMAGE_SIZE}  Mode: O_DSYNC Async: 0`,
    'D core/fileio_0/lpsmall/attrib',
    'F core/fileio_0/lpsmall/attrib/emulate_tpu = 1',
    'F core/fileio_0/lpsmall/attrib/emulate_tpws = 1',
    'F core/fileio_0/lpsmall/attrib/block_size = 512',
    'F core/fileio_0/lpsmall/attrib/emulate_write_cache = 0',
    'D core/fileio_0/lpsmall/wwn',
    'F core/fileio_0/lpsmall/wwn/vpd_unit_serial = T10 VPD Unit Serial Number: 8157f977-1111-2222-3333-444455556666',
    'F core/fileio_0/lpsmall/wwn/product_id = lpsmall',
    'F core/fileio_0/lpsmall/wwn/vendor_id = LIO-ORG',
    'D iscsi',
    `D iscsi/${IQN}`,
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
    `L ${tpg}/lun/lun_0/6847ded961 -> ../../../../../../target/core/fileio_0/lpsmall`,
    `D ${tpg}/acls`,
    '',
  ].join('\n')
}

/** The persisted half — the record Repair replays and the quarantine must keep. */
function saveconfig(image: string): string {
  return JSON.stringify({
    fabric_modules: [],
    storage_objects: [{
      name: 'lpsmall',
      plugin: 'fileio',
      dev: image,
      size: IMAGE_SIZE,
      wwn: '8157f977-1111-2222-3333-444455556666',
      readonly: false,
      write_back: false,
      attributes: {},
      alua_tpgs: [],
    }],
    targets: [{
      wwn: IQN,
      fabric: 'iscsi',
      parameters: {},
      tpgs: [{
        tag: 1,
        enable: true,
        attributes: { authentication: 0, generate_node_acls: 0, demo_mode_discovery: 0 },
        parameters: {},
        luns: [{ index: 0, storage_object: '/backstores/fileio/lpsmall', alias: '6847ded961' }],
        node_acls: [],
        portals: [{ ip_address: '192.168.200.50', port: 3260 }],
      }],
    }],
  })
}

describe('POST /v1/iscsi/health/repair — the 409 after a placeholder was quarantined (cr.64b2-iii I)', () => {
  let dir: string
  let image: string
  let saveconfigPath: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-repair-stub-'))
    // The placeholder is a REAL 0-byte file under a temp dir: the quarantine's
    // re-check (`stat` then `unlink`) is real, and the post-quarantine read
    // sees the ordinary absence it must see.
    image = join(dir, 'gtbackup', 'img2', 'lpsmall.raw')
    await mkdir(join(dir, 'gtbackup', 'img2'), { recursive: true })
    await writeFile(image, '')
    saveconfigPath = join(dir, 'saveconfig.json')
    await writeFile(saveconfigPath, saveconfig(image))

    executor = new ConfigfsMutatingExecutor(join(dir, 'target'))
    executor.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })

    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(iscsiMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      fstabPath: join(dir, 'absent-fstab'),
      configfsRoot: join(dir, 'target'),
      saveconfigPath,
      pveStorageCfg: join(dir, 'absent-storage.cfg'),
      blockRoot: join(dir, 'absent-block'),
      initiatorNamePath: join(dir, 'absent-initiatorname.iscsi'),
      // The fake filesystem (the iscsi.8 seams): the child dataset did NOT
      // mount, so the deepest mount containing the image is its parent —
      // wrongMount — while the ZFS view says where it should be.
      findmnt: async () => JSON.stringify({
        filesystems: [
          { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
          { target: join(dir, 'gtbackup'), source: 'gtbackup', fstype: 'zfs', options: 'rw' },
        ],
      }),
      zfsMountpoints: async () => [
        { mountpoint: join(dir, 'gtbackup'), dataset: 'gtbackup', pool: 'gtbackup' },
        { mountpoint: join(dir, 'gtbackup/img2'), dataset: 'gtbackup/img2', pool: 'gtbackup' },
      ],
    })
    await materializeConfigfsManifest(manifest(image), join(dir, 'target'))
  })

  afterEach(async () => {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('the 409 says the placeholder was just taken offline and the record kept; the tear-down argv ran and no save did', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/iscsi/health/repair', headers: IDENTITY })
    assert.equal(res.statusCode, 409, res.body)
    const error = (res.json() as { error: { code: string, reason?: string, message: string } }).error
    assert.equal(error.code, 'CONFLICT')
    assert.equal(error.reason, 'backing-absent')
    // What the code DID: the stub is offline now, the record is kept.
    assert.match(error.message, /This request took the 0-byte placeholder the restore service had left behind offline — the LUN no longer served by LIO — and kept the persisted record/)
    // The guidance still stands: bring the real backing back, run Repair again.
    assert.match(error.message, /import the pool, restore the image/)

    // The argv that took the stub offline (the quarantine's pair, one command
    // per invocation) is present…
    const argv = executor.calls.filter(c => c.command === TARGETCLI).map(c => `${c.command} ${c.args.join(' ')}`)
    assert.ok(argv.some(a => a.includes(`/backstores/fileio delete lpsmall`)), argv.join(' | '))
    assert.ok(argv.some(a => a.includes('/luns delete lun0')), argv.join(' | '))
    // …and the record was kept: the quarantine NEVER saves.
    assert.ok(!argv.some(a => a.includes('saveconfig')), argv.join(' | '))
    assert.equal(readFileSync(saveconfigPath, 'utf8'), saveconfig(image), 'saveconfig.json untouched')
    // The placeholder file itself is gone (both signals agreed, still 0 bytes).
    assert.equal(existsSync(image), false)

    // Nothing was submitted — the door refused before the queue (the refusal
    // returns before `jobQueue.submit`, and the body carries no job).
    assert.equal((res.json() as { job?: unknown }).job, undefined)
  })
})
