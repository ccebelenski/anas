import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { currentLane } from '../../executor/deadline.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { zfsListArgs, zfsSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { TARGETCLI, ZFS, zvolExistsArgs } from '../../services/iscsi-mutate.js'

/**
 * Story cr.63 (review L17, WAVE3-DESIGN §4.2) — a LUN verb holds its BACKING's
 * keys beside its own `iscsi-target:`/`iscsi-lun:` keys, so a LUN verb and a
 * dataset or pool verb on the same backing serialise. Before, LUN add, grow
 * and delete held only the iSCSI keys: a dataset destroy accepted while a LUN
 * add on the same volume ran started at once, its LUN-held gate passed on a
 * tree the add had not mapped yet, and `zfs destroy` ran under it.
 *
 * The paused-queue pattern (cr.33): one job is held mid-act (its `targetcli`
 * or its `zfs destroy` does not return until the test releases it), the other
 * verb is accepted at its route, and the test asserts it waits for the LOCK —
 * `queued` with a free slot, its progress naming the holder — not a slot.
 *
 * FIXTURES (ruling (l): fakes print captured output):
 *  - LIO: `iscsi/configfs-restore-hole.manifest` (the captured target with LUN
 *    0, `gtiscsi_vol1` on /dev/zvol/gtiscsi/vol1, gone) before the add maps it,
 *    `iscsi/configfs-live.manifest` (LUN 0 present) once it has; the target's
 *    IQN rewritten to ANAS's naming (`anas` last), every other byte the
 *    capture's — as iscsi-guard.test.ts;
 *  - the volume: `zfs/zfs-list-volumes.json` (the real gtiscsi pool with its
 *    2G zvol `gtiscsi/vol1`) for `zfs list` of gtiscsi; its dataset guid is the
 *    `guid` property of the captured `zfs/zfs-get-volume.json`
 *    (12705534995224000801); its snapshots: `zfs/zfs-snapshots-media.json`
 *    with the `datasets` map emptied (none);
 *  - TYPED: the gtiscsi POOL's guid — no capture of `zpool get guid gtiscsi`
 *    exists — served in the one-line `zpool get -H -o value guid` shape the dev
 *    mock serves for testpool (server.ts);
 *  - the served device's size: `zd16/size` = 4194304 sectors (the capture's
 *    2G), as iscsi-mutate.test.ts writes it;
 *  - the mount table (the image-file case only): `backup/findmnt-nested.json`,
 *    the same node's whole `findmnt --json`, verbatim — it mounts the image
 *    LUN's directory `/gtiscsi/images` as the dataset `gtiscsi/images`; and
 *    the ZFS mountpoint list the iSCSI read classifies an image path by
 *    (`zfs list -H -o name,mountpoint`), rendered from the `name` and
 *    `mountpoint` columns of `zfs/zfs-list-volumes.json` in the `-H` shape
 *    (one tab-separated row per dataset, zfs-list(8)).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const CAPTURED_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const IQN = 'iqn.2026-08.dev.gtiscsi.anas:target1'
const ZVOL_PATH = '/dev/zvol/gtiscsi/vol1'
const ZVOL_DATASET = 'gtiscsi/vol1'
const LUN0_SERIAL = '9bc6e907-6015-4267-be4f-5a0617cb3d71'
/** The captured LUN 1's (fileio, /gtiscsi/images/lun2.raw) unit serial. */
const LUN1_SERIAL = '689844a4-1d20-4cba-8516-bdc52a402645'
/** TYPED (see the header): the gtiscsi pool's guid. */
const GTISCSI_POOL_GUID = '7395061128366427419'
/** The captured `guid` of gtiscsi/vol1 (`zfs/zfs-get-volume.json`). */
const VOL1_GUID = (JSON.parse(fixture('zfs/zfs-get-volume.json')) as { datasets: Record<string, { properties: { guid: { value: string } } }> })
  .datasets[ZVOL_DATASET]
  .properties
  .guid
  .value

function owned(manifest: string): string {
  assert.ok(manifest.includes(CAPTURED_IQN))
  return manifest.split(CAPTURED_IQN).join(IQN)
}
const LIVE = owned(fixture('iscsi/configfs-live.manifest'))
const HOLE = owned(fixture('iscsi/configfs-restore-hole.manifest'))

const VOLUMES = fixture('zfs/zfs-list-volumes.json')
const NO_SNAPSHOTS = JSON.stringify({ ...JSON.parse(fixture('zfs/zfs-snapshots-media.json')), datasets: {} })
const MOUNTS_WITH_GTISCSI = fixture('backup/findmnt-nested.json')
const GTISCSI_MOUNTPOINTS = Object.values((JSON.parse(VOLUMES) as { datasets: Record<string, { name: string, properties: { mountpoint: { value: string } } }> }).datasets)
  .map(d => `${d.name}\t${d.properties.mountpoint.value}\n`)
  .join('')

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const targetUrl = `/v1/iscsi/targets/${encodeURIComponent(IQN)}`
const ADD_VOL1 = { method: 'POST' as const, url: `${targetUrl}/luns`, payload: { name: 'gtiscsi_vol1', kind: 'zvol', backing: ZVOL_DATASET } }
const DESTROY_VOL1 = { method: 'DELETE' as const, url: '/v1/pools/gtiscsi/datasets/vol1' }

/** The volume's dataset keys as `zfsClaims` spells them, in `mode` for the volume itself. */
function vol1Keys(mode: 'shared' | 'exclusive'): { key: string, mode: string }[] {
  return [
    { key: `zfs:${GTISCSI_POOL_GUID}/vol1`, mode },
    { key: `zfs:${GTISCSI_POOL_GUID}`, mode: 'shared' },
    { key: `zpool:${GTISCSI_POOL_GUID}`, mode: 'shared' },
    { key: 'zname:gtiscsi', mode: 'shared' },
  ]
}

describe('cr.63 L17 — a LUN verb and a dataset verb on the same backing serialise', () => {
  let dir: string
  let configfs: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** When set, every targetcli call waits for it. */
  let targetcliHold: Promise<void> | null = null
  /** When set, `zfs destroy` waits for it. */
  let destroyHold: Promise<void> | null = null
  /** When set, `findmnt --json` answers it (else the dev mock's own table). */
  let mountTable: string | null = null

  const ENV_KEYS = ['ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_STORAGE_CFG', 'ANAS_ISCSI_INITIATOR_NAME', 'ANAS_ISCSI_DEVICE_STAT'] as const
  const savedEnv: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr63-l17-'))
    configfs = join(dir, 'target')
    await mkdir(join(dir, 'block', 'zd16'), { recursive: true })
    await writeFile(join(dir, 'block', 'zd16', 'size'), '4194304\n')
    for (const k of ENV_KEYS)
      savedEnv[k] = process.env[k]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined)
        delete process.env[k]
      else
        process.env[k] = savedEnv[k]
    }
  })

  async function lio(manifest: string): Promise<void> {
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(manifest, configfs)
  }

  async function serve(manifest: string): Promise<void> {
    await lio(manifest)
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_ISCSI_INITIATOR_NAME = join(dir, 'absent-initiatorname.iscsi')
    process.env.ANAS_ISCSI_DEVICE_STAT = `${ZVOL_PATH}=230:16`
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    targetcliHold = null
    destroyHold = null
    mountTable = null
    const listArgs = zfsListArgs('gtiscsi').join('\0')
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      const argv = args.join(' ')
      if (command === TARGETCLI) {
        if (targetcliHold)
          await targetcliHold
        return ok('')
      }
      if (command === '/usr/bin/findmnt' && argv === '--json' && mountTable !== null)
        return ok(mountTable)
      if (command === ZFS && argv === 'list -H -o name,mountpoint' && mountTable !== null)
        return ok(GTISCSI_MOUNTPOINTS)
      if (command === '/usr/sbin/zpool' && argv === 'get -H -o value guid -- gtiscsi')
        return ok(`${GTISCSI_POOL_GUID}\n`)
      if (command === ZFS && argv === `get -H -o value guid -- ${ZVOL_DATASET}`)
        return ok(`${VOL1_GUID}\n`)
      // cr.64c item 8 / cr.64cr: the LUN add proves the zvol exists before its first targetcli act.
      if (command === ZFS && argv === zvolExistsArgs(ZVOL_DATASET).join(' '))
        return ok(`${ZVOL_DATASET}\n`)
      if (command === ZFS && args.join('\0') === listArgs)
        return ok(VOLUMES)
      if (command === ZFS && argv === zfsSnapshotListArgs(ZVOL_DATASET).join(' '))
        return ok(NO_SNAPSHOTS)
      if (command === ZFS && args[0] === 'destroy') {
        if (destroyHold)
          await destroyHold
        return ok('')
      }
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown }

  function inject(req: Req, headers: Record<string, string> = {}) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.payload !== undefined ? JSON_HEADERS : IDENTITY_HEADERS), ...headers },
      ...(req.payload !== undefined ? { payload: JSON.stringify(req.payload) } : {}),
    })
  }

  /** Send `req`, confirming it when challenged; returns the accepted job's id. */
  async function accept(req: Req): Promise<string> {
    let res = await inject(req)
    if (res.statusCode === 409 && res.headers['x-anas-confirm-code'])
      res = await inject(req, { 'x-anas-confirm': res.headers['x-anas-confirm-code'] as string })
    assert.equal(res.statusCode, 202, res.body)
    return (res.json() as JobAccepted).job.id
  }

  function hold(): { promise: Promise<void>, release: () => void } {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
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

  const heldBy = (id: string) => queue().heldLocks().filter(l => l.holders.includes(id)).map(l => ({ key: l.key, mode: l.mode }))
  const zfsDestroys = () => calls.filter(c => c.command === ZFS && c.args[0] === 'destroy')

  it('a dataset destroy accepted while a LUN add on that volume runs waits for the add\'s LOCK, then re-gates on the LUN that now holds the volume — no zfs destroy', async () => {
    await serve(HOLE)
    const t = hold()
    targetcliHold = t.promise
    const addId = await accept(ADD_VOL1)
    await until(() => calls.some(c => c.command === TARGETCLI))
    assert.deepEqual(heldBy(addId), [{ key: `iscsi-target:${IQN}`, mode: 'exclusive' }, ...vol1Keys('shared')])

    // The route door of the destroy passes — LIO does not map vol1 yet — and
    // its job waits for the add's key on the volume, with free slots to spare.
    const destroyId = await accept(DESTROY_VOL1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queue().get(destroyId)?.status, 'queued')
    assert.equal(queue().get(destroyId)?.progress, `waiting for iscsi.lun.add (job ${addId}) on Dataset '${ZVOL_DATASET}'`)
    assert.equal(queue().list('running').length, 1, 'the waiting destroy holds no slot')
    assert.deepEqual(zfsDestroys(), [], 'nothing destroyed under the add')

    // The add maps the volume (the captured tree with LUN 0 present) and lets go.
    await lio(LIVE)
    t.release()
    assert.equal((await finished(addId)).status, 'completed')
    const destroyed = await finished(destroyId)
    assert.equal(destroyed.status, 'failed', JSON.stringify(destroyed))
    assert.match(destroyed.error!.message, /iSCSI LUN/, JSON.stringify(destroyed.error))
    assert.deepEqual(zfsDestroys(), [], 'the volume a LUN now serves was never destroyed')
    assert.deepEqual(queue().heldLocks(), [])
  })

  it('the reverse: a LUN add accepted while a dataset destroy of that volume runs waits for the destroy\'s LOCK — no targetcli until the destroy is done', async () => {
    await serve(HOLE)
    const d = hold()
    destroyHold = d.promise
    const destroyId = await accept(DESTROY_VOL1)
    await until(() => zfsDestroys().length === 1)
    assert.deepEqual(heldBy(destroyId).filter(l => l.key.startsWith('zfs:') || l.key.startsWith('zpool:') || l.key.startsWith('zname:')), vol1Keys('exclusive'))

    const addId = await accept(ADD_VOL1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queue().get(addId)?.status, 'queued')
    assert.equal(queue().get(addId)?.progress, `waiting for zfs.destroy (job ${destroyId}) on Dataset '${ZVOL_DATASET}'`)
    assert.ok(!calls.some(c => c.command === TARGETCLI), 'no targetcli while the volume is being destroyed')

    d.release()
    assert.equal((await finished(destroyId)).status, 'completed')
    await finished(addId)
    const firstTargetcli = calls.findIndex(c => c.command === TARGETCLI)
    const destroyCall = calls.findIndex(c => c.command === ZFS && c.args[0] === 'destroy')
    assert.ok(firstTargetcli > destroyCall, 'the add acted only after the destroy')
  })

  it('a zvol GROW holds the volume\'s key exclusive (a `zfs set volsize`, as the Datasets door\'s grow); a write-cache change holds it shared', async () => {
    await serve(LIVE)
    const t = hold()
    targetcliHold = t.promise
    const cacheId = await accept({ method: 'PUT', url: `${targetUrl}/luns/0`, payload: { writeBack: false } })
    await until(() => calls.some(c => c.command === TARGETCLI))
    assert.deepEqual(heldBy(cacheId), [{ key: `iscsi-target:${IQN}`, mode: 'exclusive' }, { key: `iscsi-lun:${LUN0_SERIAL}`, mode: 'exclusive' }, ...vol1Keys('shared')])
    t.release()
    assert.equal((await finished(cacheId)).status, 'completed')

    // The grow is a `zfs set volsize` — no targetcli — so it is held at the
    // `zfs set` itself to look at its keys.
    const g = hold()
    let growing = false
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const inner = mock.exec
    mock.exec = async (command, args, opts) => {
      if (command === ZFS && args[0] === 'set') {
        growing = true
        await g.promise
      }
      return inner(command, args, opts)
    }
    const growId = await accept({ method: 'PUT', url: `${targetUrl}/luns/0`, payload: { size: 4 * 1024 ** 3 } })
    await until(() => growing)
    assert.deepEqual(heldBy(growId), [{ key: `iscsi-target:${IQN}`, mode: 'exclusive' }, { key: `iscsi-lun:${LUN0_SERIAL}`, mode: 'exclusive' }, ...vol1Keys('exclusive')])
    g.release()
    await finished(growId)
  })

  it('an image-file LUN holds the keys of the filesystem its image lives on, SHARED — the dataset\'s and its mount\'s', async () => {
    await serve(LIVE)
    mountTable = MOUNTS_WITH_GTISCSI
    const t = hold()
    targetcliHold = t.promise
    // LUN 1 of the capture: fileio, /gtiscsi/images/lun2.raw.
    const id = await accept({ method: 'PUT', url: `${targetUrl}/luns/1`, payload: { writeBack: false } })
    await until(() => calls.some(c => c.command === TARGETCLI))
    assert.deepEqual(heldBy(id), [
      { key: `iscsi-target:${IQN}`, mode: 'exclusive' },
      { key: `iscsi-lun:${LUN1_SERIAL}`, mode: 'exclusive' },
      { key: `zfs:${GTISCSI_POOL_GUID}/images`, mode: 'shared' },
      { key: `zfs:${GTISCSI_POOL_GUID}`, mode: 'shared' },
      { key: `zpool:${GTISCSI_POOL_GUID}`, mode: 'shared' },
      { key: 'zname:gtiscsi', mode: 'shared' },
      { key: 'mount:/gtiscsi/images', mode: 'shared' },
    ])
    t.release()
    assert.equal((await finished(id)).status, 'completed')
  })

  it('a LUN delete holds the volume\'s key exclusive with destroyBacking (a `zfs destroy`) and shared without it', async () => {
    for (const [query, mode] of [['?destroyBacking=true', 'exclusive'], ['', 'shared']] as const) {
      await serve(LIVE)
      const t = hold()
      targetcliHold = t.promise
      const id = await accept({ method: 'DELETE', url: `${targetUrl}/luns/0${query}` })
      await until(() => calls.some(c => c.command === TARGETCLI))
      assert.deepEqual(heldBy(id), [{ key: `iscsi-target:${IQN}`, mode: 'exclusive' }, { key: `iscsi-lun:${LUN0_SERIAL}`, mode: 'exclusive' }, ...vol1Keys(mode)], query)
      t.release()
      assert.equal((await finished(id)).status, 'completed', query)
      await server!.close()
      server = undefined
    }
  })

  // cr.64b1 (B): `pathSourceClaims` fails OPEN on an unreadable mount table
  // (cr.33b: a mover's run door must not 503 over a lock key). Inside a guard
  // door it now fails CLOSED: a mutation that cannot read what its keys derive
  // from answers 503 UNAVAILABLE naming the read. Before, the route locked
  // nothing for the backing, the job read the table fine, and the recompute
  // refused "changed while this run waited" — a sentence that was false.
  //
  // cr.64b2-iii (N): the same rule now reaches the LUN UPDATE too — its
  // backing claims only moved onto the guard spec's `locks` in this story
  // (they used to be computed at the route outside any spec, so the recompute
  // never covered them and a findmnt failure at the route locked nothing).
  describe('cr.64b1 (B) / cr.64b2-iii (N) — the LUN delete and update when the mount table cannot be read', () => {
    /** `findmnt --json` exits 1 (its own unreadable-mountinfo sentence) where `fails(inJob)` says so. */
    function findmntFails(fails: (inJob: boolean) => boolean): void {
      const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
      const inner = mock.exec
      mock.exec = async (command, args, opts) => {
        if (command === '/usr/bin/findmnt' && args.join(' ') === '--json' && fails(currentLane().jobId !== undefined))
          return { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo\n', exitCode: 1 }
        return inner(command, args, opts)
      }
    }
    const UNREADABLE = `the mount table could not be read (findmnt --json exited 1: findmnt: cannot read /proc/self/mountinfo), `
      + `so the filesystem /gtiscsi/images lives on cannot be locked — nothing was done; try again`

    it('failing at the ROUTE only: the delete of the image LUN answers 503 UNAVAILABLE naming the read — no job, no targetcli', async () => {
      await serve(LIVE)
      mountTable = MOUNTS_WITH_GTISCSI
      findmntFails(inJob => !inJob)
      const res = await inject({ method: 'DELETE', url: `${targetUrl}/luns/1` })
      assert.equal(res.statusCode, 503, res.body)
      assert.equal(res.json().error.code, 'UNAVAILABLE')
      assert.ok((res.json().error.message as string).endsWith(`: ${UNREADABLE}`), res.json().error.message)
      assert.deepEqual(queue().list(), [], 'no job was submitted')
      assert.ok(!calls.some(c => c.command === TARGETCLI), 'no targetcli')
    })

    it('failing in the JOB only: the accepted delete refuses UNAVAILABLE naming the read, never a "changed while this run waited" — no targetcli', async () => {
      await serve(LIVE)
      mountTable = MOUNTS_WITH_GTISCSI
      findmntFails(inJob => inJob)
      const id = await accept({ method: 'DELETE', url: `${targetUrl}/luns/1` })
      const job = await finished(id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'UNAVAILABLE')
      assert.ok(job.error!.message.endsWith(`: ${UNREADABLE}`), job.error!.message)
      assert.ok(!calls.some(c => c.command === TARGETCLI), 'no targetcli')
    })

    it('cr.64b2-iii (N) failing at the ROUTE only: the UPDATE of the image LUN answers 503 UNAVAILABLE naming the read — no job, no targetcli', async () => {
      await serve(LIVE)
      mountTable = MOUNTS_WITH_GTISCSI
      findmntFails(inJob => !inJob)
      const res = await inject({ method: 'PUT', url: `${targetUrl}/luns/1`, payload: { writeBack: false } })
      assert.equal(res.statusCode, 503, res.body)
      assert.equal(res.json().error.code, 'UNAVAILABLE')
      assert.ok((res.json().error.message as string).endsWith(`: ${UNREADABLE}`), res.json().error.message)
      assert.deepEqual(queue().list(), [], 'no job was submitted')
      assert.ok(!calls.some(c => c.command === TARGETCLI), 'no targetcli')
    })

    it('cr.64b2-iii (N) failing in the JOB only: the accepted update refuses UNAVAILABLE naming the read — no targetcli', async () => {
      await serve(LIVE)
      mountTable = MOUNTS_WITH_GTISCSI
      findmntFails(inJob => inJob)
      const id = await accept({ method: 'PUT', url: `${targetUrl}/luns/1`, payload: { writeBack: false } })
      const job = await finished(id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'UNAVAILABLE')
      assert.ok(job.error!.message.endsWith(`: ${UNREADABLE}`), job.error!.message)
      assert.ok(!calls.some(c => c.command === TARGETCLI), 'no targetcli')
    })
  })
})
