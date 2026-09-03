import type { AhrPool, Dataset, IscsiTargetDetail, Job, JobAccepted, MountSummary, PoolSummary } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ZfsMountpoint } from '../../parsers/pve-storage.js'
import type { Transport } from '../../services/replication-transport.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { lunGrowGuidance } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { JobQueue } from '../../jobs/queue.js'
import { zfsListArgs, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { AHR_FINDMNT_ARGS } from '../../services/ahr-topology.js'
import { datasetRoutes } from '../datasets.js'
import { poolRoutes } from '../pools.js'

/**
 * The rest of ANAS knows a LUN is there — story `iscsi.6`, the ROUTE gates.
 *
 * Every refusal here has the same three properties, and every test asserts all
 * three:
 *
 *   1. **409, `reason: 'held-by-lun'`, and no confirm code.** This is the
 *      "unsafe NOW" altitude (a busy reshape, a degraded array), not the
 *      confirm-gated one: there is no safe way to pull a block device out from
 *      under a live SCSI target, and a confirm code would only make the data
 *      loss a two-click one.
 *   2. **It fires BEFORE the destructive step.** Asserted on the executor's CALL
 *      LOG, not on the response alone — a refusal that arrives after `zpool
 *      destroy` has run is not a refusal.
 *   3. **It names the target, the LUN and both ways out** (delete the LUN, or
 *      delete it with `destroyBacking`). Guide, don't just warn.
 *
 * Ground truth (GT-40) is why each one exists: ZFS refuses `destroy` and
 * `export` and NOTHING else — `rollback`, `rename`, a `volsize` shrink and an
 * `rm` of a backing image all return exit 0 under a live session with a mounted
 * filesystem on the initiator. And GT-41: `fuser`, `lsof` and sysfs `holders/`
 * see nothing, so ANAS is the only layer that can answer at all.
 *
 * FIXTURES. The LIO tree is the REAL configfs capture from `iscsi.1`
 * (`configfs-live.manifest`): LUN 0 `gtiscsi_vol1` → `/dev/zvol/gtiscsi/vol1`,
 * LUN 1 `gtiscsi_lun2` → `/gtiscsi/images/lun2.raw`. The ZFS side is the real
 * `zfs list` capture of that same pool (`fixtures/zfs/zfs-list-volumes.json`:
 * `gtiscsi`, `gtiscsi/images` at `/gtiscsi/images`, and the zvol `gtiscsi/vol1`).
 * Two cases need a backing path the capture does not contain — a zvol BENEATH a
 * parent dataset, and a file on an AHR pool — and those rewrite exactly ONE
 * `udev_path` line of the manifest before materialising it; the rewrite is
 * spelled out at each call site.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')
const ZFS_FIXTURES = join(__dirname, '../../fixtures/zfs')
const AHR_FIXTURES = join(__dirname, '../../fixtures/ahr')

const POOL = 'gtiscsi'
const ZVOL = 'gtiscsi/vol1'
const IMAGES_DATASET = 'gtiscsi/images'
const IMAGES_PATH = '/gtiscsi/images'
const GT_TARGET = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const AHR_POOL = 'ahr0'
const AHR_MOUNT = '/mnt/anas-ahr/ahr0'

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const UMOUNT = '/usr/bin/umount'
const MV = '/usr/bin/mv'
const BTRFS = '/usr/bin/btrfs'
const FINDMNT = '/usr/bin/findmnt'


/**
 * The dev mock's `ahr0` is mounted FLAT (`subvol=/`), which the snapshot
 * routes refuse before any held-by-LUN question. This re-points the SAME
 * mount at the §12 subvolume layout — findmnt appends the mounted subvolume
 * to a btrfs source (`…[/@data]`), which the topology reader strips.
 */
const AHR_FINDMNT_SUBVOL_LAYOUT = JSON.stringify({ filesystems: [{
  target: AHR_MOUNT,
  source: '/dev/mapper/ahr0-ahr0--vol[/@data]',
  fstype: 'btrfs',
  options: 'rw,relatime,space_cache=v2,subvol=/@data',
}] })

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/** The pool a LUN sits on, and a second one nothing serves (the control). */
const UNSERVED_POOL = 'sparepool'

/** A minimal `zpool list -j` naming both pools. */
const ZPOOL_LIST = JSON.stringify({
  output_version: { command: 'zpool list', vers_major: 0, vers_minor: 1 },
  pools: Object.fromEntries([POOL, UNSERVED_POOL].map(name => [name, {
    name,
    type: 'POOL',
    state: 'ONLINE',
    pool_guid: name === POOL ? '1' : '2',
    properties: {
      size: { value: '8G', source: { type: 'NONE', data: '-' } },
      allocated: { value: '2G', source: { type: 'NONE', data: '-' } },
      free: { value: '6G', source: { type: 'NONE', data: '-' } },
      health: { value: 'ONLINE', source: { type: 'NONE', data: '-' } },
    },
  }])),
})

/** One snapshot of each rollback subject — plumbing only, to reach the gate. */
function snapshotListJson(dataset: string, snap: string): string {
  return JSON.stringify({
    output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
    datasets: {
      [`${dataset}@${snap}`]: {
        name: `${dataset}@${snap}`,
        type: 'SNAPSHOT',
        pool: POOL,
        dataset,
        snapshot_name: snap,
        createtxg: '11',
        properties: {
          creation: { value: 'Tue Aug 25 19:30 2026', source: { type: 'NONE', data: '-' } },
          used: { value: '0B', source: { type: 'NONE', data: '-' } },
          referenced: { value: '60.5K', source: { type: 'NONE', data: '-' } },
        },
      },
    },
  })
}

function fixtureText(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8')
}

interface ErrorBody {
  error: { code: string, reason?: string, message: string }
}

describe('iscsi.6 — the rest of ANAS knows a LUN is there (route gates)', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []

  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
    fstab: process.env.ANAS_FSTAB_PATH,
  }

  /**
   * Start a mock server whose LIO tree is the real capture, optionally with the
   * named `udev_path` rewritten so a LUN can be placed somewhere the capture
   * does not cover (a zvol beneath a parent dataset, a file on an AHR pool).
   */
  async function serve(rewrite?: { from: string, to: string }): Promise<void> {
    let manifest = fixtureText(ISCSI_FIXTURES, 'configfs-live.manifest')
    if (rewrite) {
      assert.ok(manifest.includes(rewrite.from), `manifest has no '${rewrite.from}' to rewrite`)
      manifest = manifest.split(rewrite.from).join(rewrite.to)
    }
    const root = join(dir, 'target')
    await materializeConfigfsManifest(manifest, root)
    process.env.ANAS_ISCSI_CONFIGFS = root
    // configfs alone carries both LUNs; the persisted half is deliberately
    // absent so nothing here depends on saveconfig parsing.
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')

    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
    calls = []
    mock.exec = async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (command === ZPOOL && same(args, ['list', '-j']))
        return { stdout: ZPOOL_LIST, stderr: '', exitCode: 0 }
      if (command === ZFS && same(args, zfsListArgs(POOL)))
        return { stdout: fixtureText(ZFS_FIXTURES, 'zfs-list-volumes.json'), stderr: '', exitCode: 0 }
      if (command === ZFS && same(args, zfsSnapshotDetailArgs(ZVOL)))
        return { stdout: snapshotListJson(ZVOL, 'before-grow'), stderr: '', exitCode: 0 }
      if (command === ZFS && same(args, zfsSnapshotDetailArgs(IMAGES_DATASET)))
        return { stdout: snapshotListJson(IMAGES_DATASET, 'nightly'), stderr: '', exitCode: 0 }
      return orig(command, args)
    }
    await server.ready()
  }

  /** Did any command in the log actually try to do the destructive thing? */
  function ran(command: string, ...argPrefix: string[]): boolean {
    return calls.some(c => c.command === command && argPrefix.every((a, i) => c.args[i] === a))
  }

  /** Poll a submitted job to its terminal state (the grow RESULT is the point). */
  async function waitForJob(id: string): Promise<Job> {
    for (let i = 0; i < 200; i++) {
      const res = await server!.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
      const { job } = res.json() as { job: Job }
      if (job.status === 'completed' || job.status === 'failed')
        return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Job ${id} did not finish`)
  }

  /** Assert the shape every held-by-LUN refusal must have. */
  function assertHeldRefusal(res: { statusCode: number, headers: Record<string, unknown>, json: () => unknown }, lun: string): string {
    assert.equal(res.statusCode, 409)
    const body = res.json() as ErrorBody
    assert.equal(body.error.code, 'CONFLICT')
    assert.equal(body.error.reason, 'held-by-lun')
    // Names the holder…
    assert.match(body.error.message, new RegExp(`held by iSCSI LUN \\d+ '${lun}' of target ${GT_TARGET.replace(/[.:]/g, '\\$&')}`))
    // …both ways out…
    assert.match(body.error.message, /Delete LUN \d+/)
    assert.match(body.error.message, /destroyBacking=true/)
    // …and NO confirm bypass, in the text and in the headers.
    assert.match(body.error.message, /no confirm bypass/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    return body.error.message
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-held-gates-'))
    process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
    await writeFile(join(dir, 'fstab'), '# empty\n')
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
      ['ANAS_FSTAB_PATH', savedEnv.fstab],
    ] as const) {
      if (saved === undefined)
        delete process.env[key]
      else
        process.env[key] = saved
    }
  })

  // =========================================================================
  // Pools — destroy and export
  // =========================================================================
  describe('Pools', () => {
    it('DELETE /v1/pools/:name — refused, and `zpool destroy` never runs', async () => {
      await serve()
      const res = await server!.inject({ method: 'DELETE', url: `/v1/pools/${POOL}`, headers: IDENTITY })
      assertHeldRefusal(res, 'gtiscsi_(?:vol1|lun2)')
      assert.equal(ran(ZPOOL, 'destroy'), false)
    })

    it('POST /v1/pools/:name/export — refused, and `zpool export` never runs', async () => {
      await serve()
      const res = await server!.inject({ method: 'POST', url: `/v1/pools/${POOL}/export`, headers: JSON_HEADERS, payload: '{}' })
      assertHeldRefusal(res, 'gtiscsi_(?:vol1|lun2)')
      assert.equal(ran(ZPOOL, 'export'), false)
    })

    it('a pool nothing serves is untouched — the gate is not a blanket', async () => {
      await serve()
      const res = await server!.inject({ method: 'POST', url: `/v1/pools/${UNSERVED_POOL}/export`, headers: JSON_HEADERS, payload: '{}' })
      // 409 either way, but the CONFIRM one, with a code — not the refusal.
      assert.equal(res.statusCode, 409)
      assert.notEqual((res.json() as ErrorBody).error.reason, 'held-by-lun')
      assert.ok(res.headers['x-anas-confirm-code'])
    })

    it('GET /v1/pools carries heldByLun on the held pool, and nothing on the others', async () => {
      await serve()
      const res = await server!.inject({ method: 'GET', url: '/v1/pools', headers: IDENTITY })
      const pools = (res.json() as { data: PoolSummary[] }).data
      const held = pools.find(p => p.name === POOL)
      assert.ok(held?.heldByLun, 'the served pool must carry the field')
      assert.equal(held.heldByLun.targetIqn, GT_TARGET)
      assert.match(held.heldByLun.detail, /held by iSCSI LUN/)
      for (const other of pools.filter(p => p.name !== POOL))
        assert.equal(other.heldByLun, undefined, `${other.name} must carry nothing`)
    })
  })

  // =========================================================================
  // Datasets — volume destroy / rollback / shrink, and the image-file cases
  // =========================================================================
  describe('Datasets', () => {
    it('DELETE a served VOLUME — refused, and `zfs destroy` never runs', async () => {
      await serve()
      const res = await server!.inject({ method: 'DELETE', url: `/v1/pools/${POOL}/datasets/vol1`, headers: IDENTITY })
      assertHeldRefusal(res, 'gtiscsi_vol1')
      assert.equal(ran(ZFS, 'destroy'), false)
    })

    it('ROLLBACK of a served VOLUME — refused, and `zfs rollback` never runs (ZFS would exit 0)', async () => {
      await serve()
      const res = await server!.inject({
        method: 'POST',
        url: `/v1/pools/${POOL}/datasets/vol1/snapshots/before-grow/rollback`,
        headers: JSON_HEADERS,
        payload: '{}',
      })
      assertHeldRefusal(res, 'gtiscsi_vol1')
      assert.equal(ran(ZFS, 'rollback'), false)
    })

    it('a volsize SHRINK of a served volume names the LUN as well as the shrink rule', async () => {
      await serve()
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/pools/${POOL}/datasets/vol1`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ properties: { volsize: 1024 * 1024 * 1024 } }),
      })
      assert.equal(res.statusCode, 409)
      const body = res.json() as ErrorBody
      assert.equal(body.error.reason, 'shrink')
      assert.match(body.error.message, /would SHRINK it/)
      assert.match(body.error.message, /held by iSCSI LUN 0 'gtiscsi_vol1'/)
      assert.match(body.error.message, /no confirm bypass/)
      assert.equal(ran(ZFS, 'set'), false)
    })

    it('a volsize GROW of a served volume is allowed, and the guest guidance rides the job result — the same sentence the iSCSI door sends', async () => {
      // iscsi.8: the grow is the supported live path — allowed, not refused.
      // What the operator then has to do on the guest side is the daemon's job
      // to say: lunGrowGuidance, the ONE sentence both doors share.
      await serve()
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const wrapped = mock.exec.bind(mock)
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
      mock.exec = async (command: string, args: string[]) => {
        if (command === ZFS && same(args, ['set', 'volsize=4294967296', ZVOL]))
          return { stdout: '', stderr: '', exitCode: 0 }
        return wrapped(command, args)
      }
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/pools/${POOL}/datasets/vol1`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ properties: { volsize: 4294967296 } }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as { warnings?: string[] }
      assert.ok(
        result.warnings?.includes(lunGrowGuidance(4294967296)),
        JSON.stringify(result.warnings),
      )
    })

    it('DELETE a filesystem dataset holding a LUN\'s IMAGE FILE — refused before `zfs destroy`', async () => {
      await serve()
      const res = await server!.inject({ method: 'DELETE', url: `/v1/pools/${POOL}/datasets/images`, headers: IDENTITY })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.equal(ran(ZFS, 'destroy'), false)
    })

    it('a RECURSIVE destroy is refused too, and says so', async () => {
      await serve()
      const res = await server!.inject({ method: 'DELETE', url: `/v1/pools/${POOL}/datasets/images?recursive=true`, headers: IDENTITY })
      const message = assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.match(message, /\(recursive\)/)
      assert.equal(ran(ZFS, 'destroy'), false)
    })

    it('`-r` sweeping a CHILD ZVOL is refused at the parent — the child is what is served', async () => {
      // The one rewrite: the real capture's zvol sits at the pool root, so its
      // udev_path is moved BENEATH `gtiscsi/images` to make it a child. Nothing
      // else in the capture changes.
      await serve({ from: '/dev/zvol/gtiscsi/vol1', to: '/dev/zvol/gtiscsi/images/vol9' })
      const res = await server!.inject({ method: 'DELETE', url: `/v1/pools/${POOL}/datasets/images?recursive=true`, headers: IDENTITY })
      assert.equal(res.statusCode, 409)
      assert.equal((res.json() as ErrorBody).error.reason, 'held-by-lun')
      assert.equal(ran(ZFS, 'destroy'), false)
    })

    it('ROLLBACK of a filesystem dataset containing a LUN image — refused before `zfs rollback`', async () => {
      await serve()
      const res = await server!.inject({
        method: 'POST',
        url: `/v1/pools/${POOL}/datasets/images/snapshots/nightly/rollback`,
        headers: JSON_HEADERS,
        payload: '{}',
      })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.equal(ran(ZFS, 'rollback'), false)
    })

    it('GET the dataset list stamps heldByLun on the served rows only', async () => {
      await serve()
      const res = await server!.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets`, headers: IDENTITY })
      const datasets = (res.json() as { data: Dataset[] }).data
      const byName = new Map(datasets.map(d => [d.name, d]))
      assert.equal(byName.get(ZVOL)?.heldByLun?.name, 'gtiscsi_vol1')
      assert.equal(byName.get(IMAGES_DATASET)?.heldByLun?.name, 'gtiscsi_lun2')
      // The pool ROOT dataset holds both descendants, so it is stamped too.
      assert.ok(byName.get(POOL)?.heldByLun)
    })
  })

  // =========================================================================
  // Mounts — a LUN's image under the mountpoint
  // =========================================================================
  describe('Mounts', () => {
    /** An NFS mount at the directory the real file LUN lives in. */
    async function fstabWithNfsAtImages(): Promise<void> {
      await writeFile(
        join(dir, 'fstab'),
        `# test\nnas.example.test:/export/blocks ${IMAGES_PATH} nfs defaults,nofail 0 0\n`,
      )
    }

    it('DELETE /v1/mounts/:mp — refused, and `umount` never runs', async () => {
      await fstabWithNfsAtImages()
      await serve()
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/mounts/${encodeURIComponent(IMAGES_PATH)}`,
        headers: IDENTITY,
      })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.equal(ran(UMOUNT), false)
    })

    it('POST /v1/mounts/:mp/state {disable} — refused (it unmounts first)', async () => {
      await fstabWithNfsAtImages()
      await serve()
      const res = await server!.inject({
        method: 'POST',
        url: `/v1/mounts/${encodeURIComponent(IMAGES_PATH)}/state`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ action: 'disable' }),
      })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.equal(ran(UMOUNT), false)
    })

    it('GET /v1/mounts stamps heldByLun on the mount the image sits under', async () => {
      await fstabWithNfsAtImages()
      await serve()
      const res = await server!.inject({ method: 'GET', url: '/v1/mounts', headers: IDENTITY })
      const rows = (res.json() as { data: MountSummary[] }).data
      const row = rows.find(r => r.mountpoint === IMAGES_PATH)
      assert.ok(row, 'the fstab mount must be in the inventory')
      assert.equal(row.heldByLun?.name, 'gtiscsi_lun2')
      for (const other of rows.filter(r => r.mountpoint !== IMAGES_PATH))
        assert.equal(other.heldByLun, undefined, other.mountpoint)
    })
  })

  // =========================================================================
  // AHR — a file on the btrfs volume IS the block object
  // =========================================================================
  describe('Hybrid RAID', () => {
    /** Move the real fileio LUN's image onto the dev mock's AHR pool. */
    const ONTO_AHR = { from: '/gtiscsi/images/lun2.raw', to: `${AHR_MOUNT}/images/block1.raw` }

    it('DELETE /v1/ahr/:name — refused, and nothing is unmounted or wiped', async () => {
      await serve(ONTO_AHR)
      const res = await server!.inject({ method: 'DELETE', url: `/v1/ahr/${AHR_POOL}`, headers: IDENTITY })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.equal(ran(UMOUNT), false)
      assert.equal(ran('/usr/sbin/wipefs'), false)
      assert.equal(ran('/usr/sbin/mdadm', '--stop'), false)
    })

    it('PUT /v1/ahr/:name/mountpoint — refused (the move unmounts the filesystem)', async () => {
      await serve(ONTO_AHR)
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/ahr/${AHR_POOL}/mountpoint`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ mountpoint: join(dir, 'newmount') }),
      })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      assert.equal(ran(UMOUNT), false)
    })

    it('ROLLBACK of a snapshot on a served pool — refused, and nothing is unmounted or renamed (issue #51)', async () => {
      // The rollback route's own guards must pass FIRST so the held refusal is
      // the one that fires: the pool needs the §12 subvolume layout (the mount
      // seam above) and a snapshot to roll back to (the shipped layout capture,
      // which lists @snapshots/before-upgrade). Both are fixture seams — the
      // LIO half is unchanged: the same ONTO_AHR rewrite the destroy/mountpoint
      // refusals prove, since the subject (pool name + mountpoint) is identical.
      await serve(ONTO_AHR)
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const wrapped = mock.exec.bind(mock)
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
      mock.exec = async (command: string, args: string[]) => {
        if (command === FINDMNT && same(args, AHR_FINDMNT_ARGS))
          return { stdout: AHR_FINDMNT_SUBVOL_LAYOUT, stderr: '', exitCode: 0 }
        if (command === BTRFS && same(args, ['subvolume', 'list', AHR_MOUNT]))
          return { stdout: fixtureText(AHR_FIXTURES, 'btrfs-subvol-list-layout.txt'), stderr: '', exitCode: 0 }
        if (command === BTRFS && same(args, ['subvolume', 'list', '-s', AHR_MOUNT]))
          return { stdout: fixtureText(AHR_FIXTURES, 'btrfs-subvol-list-s.txt'), stderr: '', exitCode: 0 }
        if (command === BTRFS && same(args, ['subvolume', 'list', '-r', AHR_MOUNT]))
          return { stdout: fixtureText(AHR_FIXTURES, 'btrfs-subvol-list-r.txt'), stderr: '', exitCode: 0 }
        return wrapped(command, args)
      }

      const res = await server!.inject({
        method: 'POST',
        url: `/v1/ahr/${AHR_POOL}/snapshots/before-upgrade/rollback`,
        headers: JSON_HEADERS,
        payload: '{}',
      })
      assertHeldRefusal(res, 'gtiscsi_lun2')
      // The swap's two destructive steps — unmount the pool, rename `@data` to
      // its pre-rollback preserve — never run. (The unmounted-pool case is the
      // hole: the rename SUCCEEDS under LIO's open fd and the live `@data`
      // diverges silently.)
      assert.equal(ran(UMOUNT), false)
      assert.equal(ran(MV), false)
    })

    it('GET /v1/ahr stamps heldByLun on the pool the image lives on', async () => {
      await serve(ONTO_AHR)
      const res = await server!.inject({ method: 'GET', url: '/v1/ahr', headers: IDENTITY })
      const pools = (res.json() as { data: AhrPool[] }).data
      const pool = pools.find(p => p.name === AHR_POOL)
      assert.ok(pool)
      assert.equal(pool.heldByLun?.name, 'gtiscsi_lun2')
    })

    it('an AHR pool nothing serves is untouched (the unrewritten capture)', async () => {
      await serve()
      const res = await server!.inject({ method: 'GET', url: '/v1/ahr', headers: IDENTITY })
      const pools = (res.json() as { data: AhrPool[] }).data
      for (const pool of pools)
        assert.equal(pool.heldByLun, undefined, pool.name)
    })
  })

  // =========================================================================
  // The firewall advisory rides the target detail
  // =========================================================================
  describe('PVE firewall advisory', () => {
    it('GET /v1/iscsi/targets/:iqn carries a firewall verdict', async () => {
      await serve()
      const res = await server!.inject({
        method: 'GET',
        url: `/v1/iscsi/targets/${encodeURIComponent(GT_TARGET)}`,
        headers: IDENTITY,
      })
      assert.equal(res.statusCode, 200)
      const target = (res.json() as { data: IscsiTargetDetail }).data
      assert.ok(target.firewall, 'the detail must carry the firewall object')
      // The dev mock has no `pve-firewall`, so the honest answer is "could not
      // tell" — and that must never produce an advisory (fail-open).
      assert.equal(target.firewall.enabled, null)
      assert.equal(target.firewall.advisory, null)
    })
  })

  // =========================================================================
  // Version skew — an old daemon's shape must still work
  // =========================================================================
  describe('no LIO on the node (fail-open)', () => {
    async function serveWithoutLio(): Promise<void> {
      process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'no-such-configfs')
      process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'no-such-saveconfig.json')
      process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'no-such-block')
      process.env.ANAS_STORAGE_CFG = join(dir, 'no-such-storage.cfg')
      server = createServer({ mock: true, logger: false })
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const orig = mock.exec.bind(mock)
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
      calls = []
      mock.exec = async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (command === ZPOOL && same(args, ['list', '-j']))
          return { stdout: ZPOOL_LIST, stderr: '', exitCode: 0 }
        if (command === ZFS && same(args, zfsListArgs(POOL)))
          return { stdout: fixtureText(ZFS_FIXTURES, 'zfs-list-volumes.json'), stderr: '', exitCode: 0 }
        return orig(command, args)
      }
      await server.ready()
    }

    it('pool destroy falls through to the ordinary confirm gate', async () => {
      await serveWithoutLio()
      const res = await server!.inject({ method: 'DELETE', url: `/v1/pools/${POOL}`, headers: IDENTITY })
      assert.equal(res.statusCode, 409)
      assert.notEqual((res.json() as ErrorBody).error.reason, 'held-by-lun')
      assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    })

    it('no row carries heldByLun at all — the field is absent, never null-filled', async () => {
      await serveWithoutLio()
      const res = await server!.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets`, headers: IDENTITY })
      for (const d of (res.json() as { data: Dataset[] }).data)
        assert.equal('heldByLun' in d, false, d.name)
    })
  })
})

/**
 * The DISCLOSURE half of fail-open (D3). The fail-open posture above stands —
 * a broken claims read must never block a destroy — but it must not be
 * fail-SILENT either: the cache now keeps the failure bit, and the confirm
 * doors that are about to hand the operator a code say "ANAS could not check".
 *
 * These tests build the minimal app (not `createServer`) because the failure
 * has to be injected through the `zfsMountpoints` TEST SEAM: the read layer
 * fail-opens component by component, so the catch is reachable only by making
 * the read throw — which is precisely the "genuinely broken read" this warns
 * about. The LIO tree itself is the same real capture.
 */
describe('the disclosure — a failed claims read is named at the confirm doors (D3)', () => {
  let dir: string
  let app: FastifyInstance | undefined

  const BROKEN_READ = async (): Promise<ZfsMountpoint[]> => {
    throw new Error('zfs list exploded')
  }
  const HEALTHY_READ = async (): Promise<ZfsMountpoint[]> => []

  /** The datasetRoutes transport is never driven by these tests. */
  function stubTransport(): Transport {
    return {
      resolveLocation: async () => ({ ok: false, error: 'not driven by this test' }),
      listPeers: async () => [],
      sshExec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      buildSshArgv: () => [],
      remotePoolNames: async () => [],
      remotePoolExists: async () => false,
      remoteDatasetExists: async () => false,
      remoteSnapshotNames: async () => [],
      remoteHold: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      remoteRelease: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      remoteHeldTags: async () => [],
    }
  }

  /**
   * The real LIO capture behind both doors; `zfsMountpoints` decides whether
   * the claims read SUCCEEDS (healthy) or THROWS (the broken read).
   */
  async function buildDoors(zfsMountpoints: () => Promise<ZfsMountpoint[]>): Promise<FastifyInstance> {
    const root = join(dir, 'target')
    await materializeConfigfsManifest(fixtureText(ISCSI_FIXTURES, 'configfs-live.manifest'), root)
    const executor = new MockExecutor()
    executor.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: ZPOOL_LIST, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: ZFS, args: zfsListArgs(POOL), result: { stdout: fixtureText(ZFS_FIXTURES, 'zfs-list-volumes.json'), stderr: '', exitCode: 0 } })
    const iscsiPaths = {
      configfsRoot: root,
      saveconfigPath: join(dir, 'absent-saveconfig.json'),
      pveStorageCfg: join(dir, 'absent-storage.cfg'),
      blockRoot: join(dir, 'absent-block'),
      zfsMountpoints,
    }
    const built = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await built.register(poolRoutes, {
      prefix: '/v1', executor, jobQueue, confirmStore: new ConfirmStore(),
      fstabPath: join(dir, 'fstab'), pveStoragePath: join(dir, 'no-storage.cfg'), iscsiPaths,
    })
    await built.register(datasetRoutes, {
      prefix: '/v1', executor, jobQueue, confirmStore: new ConfirmStore(),
      transport: stubTransport(), iscsiPaths,
    })
    await built.ready()
    return built
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-held-disclose-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('pool destroy mints the confirm gate WITH the could-not-check warning', async () => {
    app = await buildDoors(BROKEN_READ)
    const res = await app.inject({ method: 'DELETE', url: `/v1/pools/${POOL}`, headers: IDENTITY })
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED', JSON.stringify(body))
    assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    const line = body.error.warnings.find(w => w.includes('could not check whether an iSCSI LUN'))
    assert.match(line ?? '', /served from this pool/)
    assert.match(line ?? '', /LIO configuration was unreadable/)
    assert.match(line ?? '', /verify by hand/)
  })

  it('dataset destroy mints the confirm gate WITH the could-not-check warning', async () => {
    app = await buildDoors(BROKEN_READ)
    const res = await app.inject({ method: 'DELETE', url: `/v1/pools/${POOL}/datasets/vol1`, headers: IDENTITY })
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED', JSON.stringify(body))
    assert.ok(res.headers['x-anas-confirm-code'])
    const line = body.error.warnings.find(w => w.includes('could not check whether an iSCSI LUN'))
    assert.match(line ?? '', /served from this dataset/)
  })

  it('pool export mints the confirm gate WITH the could-not-check warning', async () => {
    app = await buildDoors(BROKEN_READ)
    const res = await app.inject({
      method: 'POST', url: `/v1/pools/${UNSERVED_POOL}/export`,
      headers: JSON_HEADERS, payload: '{}',
    })
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED', JSON.stringify(body))
    assert.ok(res.headers['x-anas-confirm-code'])
    const line = body.error.warnings.find(w => w.includes('could not check whether an iSCSI LUN'))
    assert.match(line ?? '', /served from this pool/)
  })

  it('a healthy read discloses NOTHING — the warning rides the failure, not the LIO', async () => {
    app = await buildDoors(HEALTHY_READ)
    const res = await app.inject({ method: 'DELETE', url: `/v1/pools/${UNSERVED_POOL}`, headers: IDENTITY })
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, warnings: string[] } }
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
    // LIO is present, readable, serving `gtiscsi` — and `sparepool` hears
    // nothing about it, because nothing failed.
    assert.equal(
      body.error.warnings.some(w => w.includes('could not check whether an iSCSI LUN')),
      false,
      JSON.stringify(body.error.warnings),
    )
  })
})
