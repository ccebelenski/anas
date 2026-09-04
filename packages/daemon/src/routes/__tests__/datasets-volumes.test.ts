/**
 * ZFS VOLUMES in the Datasets resource — story iscsi.3.
 *
 * A volume is a dataset of another TYPE, not another resource, so everything
 * here goes through the same `/v1/pools/:name/datasets` endpoints the
 * filesystem tests drive. What is volume-specific is the argv (`zfs create -V`)
 * and the gate (`assertVolumeMutable`: grow yes, shrink never).
 *
 * The pool this drives is the REAL capture from the stunt node
 * (`fixtures/zfs/zfs-list-volumes.json` + `zfs-get-volume.json`, see
 * `fixtures/zfs/NOTES.md`), replayed verbatim through the mock executor — so
 * the parsing these routes depend on is exercised against what ZFS actually
 * printed, not against a hand-written idea of it.
 */
import type { CreateDatasetRequest, Dataset, DatasetDetail, DatasetListDefaults, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CreateDatasetRequest as CreateDatasetRequestSchema, UpdateDatasetPropertiesRequest } from '@anas/shared'
import { zfsListArgs, zfsSnapshotDetailArgs, zfsSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { assertVolumeMutable } from '../datasets.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/** The captured pool and its real zvol. */
const POOL = 'gtiscsi'
const VOL = 'gtiscsi/vol1'
const VOL_PATH = 'vol1'
/** The captured volume's real volsize — 2 GiB. */
const VOL_SIZE = 2 * GiB

function fixtureText(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/** A minimal `zpool list -j` naming the captured pool, so poolExists passes. */
const ZPOOL_LIST = JSON.stringify({
  output_version: { command: 'zpool list', vers_major: 0, vers_minor: 1 },
  pools: {
    [POOL]: {
      name: POOL,
      type: 'POOL',
      state: 'ONLINE',
      pool_guid: '1',
      properties: {
        size: { value: '8G', source: { type: 'NONE', data: '-' } },
        allocated: { value: '2G', source: { type: 'NONE', data: '-' } },
        free: { value: '6G', source: { type: 'NONE', data: '-' } },
        health: { value: 'ONLINE', source: { type: 'NONE', data: '-' } },
      },
    },
  },
})

/**
 * One snapshot of the captured volume. SYNTHETIC (the captured pool's zvol had
 * none) and only plumbing: it exists to reach the rollback call site. The
 * snapshot PARSING itself is proven against real captures in
 * `parsers/__tests__/zfs-list.test.ts`.
 */
const VOL_SNAPSHOTS = JSON.stringify({
  output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
  datasets: {
    [`${VOL}@before-grow`]: {
      name: `${VOL}@before-grow`,
      type: 'SNAPSHOT',
      pool: POOL,
      dataset: VOL,
      snapshot_name: 'before-grow',
      createtxg: '11',
      properties: {
        creation: { value: 'Tue Aug 25 19:30 2026', source: { type: 'NONE', data: '-' } },
        used: { value: '0B', source: { type: 'NONE', data: '-' } },
        referenced: { value: '60.5K', source: { type: 'NONE', data: '-' } },
      },
    },
  },
})

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('datasets — ZFS volumes (story iscsi.3)', () => {
  let server: ReturnType<typeof createServer> | undefined

  /** Every command the server issued, in order — asserted on for the argv. */
  let calls: { command: string, args: string[] }[] = []

  /**
   * A mock server whose `gtiscsi` pool IS the real stunt-node capture.
   *
   * The reads are wrapped rather than registered as fixtures: the dev-mode
   * server already registers `zpool list -j` for its own sample pool and the
   * MockExecutor answers with the FIRST match, so a later fixture would never
   * be reached. Wrapping also gives an exact call log per server.
   */
  function startServer(): ReturnType<typeof createServer> {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    const listArgs = zfsListArgs(POOL)
    const sameArgs = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
    calls = []
    mock.exec = async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (command === '/usr/sbin/zpool' && sameArgs(args, ['list', '-j']))
        return { stdout: ZPOOL_LIST, stderr: '', exitCode: 0 }
      if (command === '/usr/sbin/zfs' && sameArgs(args, listArgs))
        return { stdout: fixtureText('zfs-list-volumes.json'), stderr: '', exitCode: 0 }
      if (command === '/usr/sbin/zfs' && sameArgs(args, ['get', '-j', 'all', VOL]))
        return { stdout: fixtureText('zfs-get-volume.json'), stderr: '', exitCode: 0 }
      // Only the DETAIL listing (the one carrying `creation`) — the name-only
      // listing must stay empty so the create-snapshot collision check passes.
      if (command === '/usr/sbin/zfs' && sameArgs(args, zfsSnapshotDetailArgs(VOL)))
        return { stdout: VOL_SNAPSHOTS, stderr: '', exitCode: 0 }
      return orig(command, args)
    }
    return server
  }

  /** Every argv the server issued to `zfs`, in order. */
  function zfsCalls(): string[][] {
    return calls.filter(c => c.command === '/usr/sbin/zfs').map(c => c.args)
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // ==========================================================================
  // Schema validation — the boundary, before anything reaches ZFS
  // ==========================================================================
  describe('CreateDatasetRequest validation', () => {
    it('accepts a volume with just a size', () => {
      const parsed = CreateDatasetRequestSchema.safeParse({ path: 'vol2', type: 'volume', volsize: GiB })
      assert.ok(parsed.success, parsed.error?.message)
    })

    it('accepts a volume with block size and sparse', () => {
      const parsed = CreateDatasetRequestSchema.safeParse({
        path: 'vol2',
        type: 'volume',
        volsize: 4 * GiB,
        volblocksize: 8192,
        sparse: true,
      })
      assert.ok(parsed.success, parsed.error?.message)
    })

    it('refuses a volume with no volsize', () => {
      const parsed = CreateDatasetRequestSchema.safeParse({ path: 'vol2', type: 'volume' })
      assert.equal(parsed.success, false)
      assert.match(parsed.error!.issues[0].message, /volsize/)
    })

    it('refuses a volsize below 1 MiB', () => {
      const parsed = CreateDatasetRequestSchema.safeParse({ path: 'vol2', type: 'volume', volsize: 64 * 1024 })
      assert.equal(parsed.success, false)
      assert.match(parsed.error!.issues[0].message, /at least 1 MiB/)
    })

    it('refuses a non-power-of-two block size', () => {
      const parsed = CreateDatasetRequestSchema.safeParse({ path: 'vol2', type: 'volume', volsize: GiB, volblocksize: 12288 })
      assert.equal(parsed.success, false)
      assert.match(parsed.error!.issues[0].message, /power of two/)
    })

    it('refuses a block size outside 512 B … 1 MiB', () => {
      for (const [bad, re] of [[256, /at least 512/], [2 * MiB, /at most 1M/]] as const) {
        const parsed = CreateDatasetRequestSchema.safeParse({ path: 'vol2', type: 'volume', volsize: GiB, volblocksize: bad })
        assert.equal(parsed.success, false)
        assert.match(parsed.error!.issues[0].message, re)
      }
    })

    it('refuses filesystem-only properties on a volume (ZFS has none of them)', () => {
      for (const props of [{ mountpoint: '/mnt/x' }, { recordsize: 131072 }, { quota: GiB }]) {
        const parsed = CreateDatasetRequestSchema.safeParse({ path: 'vol2', type: 'volume', volsize: GiB, properties: props })
        assert.equal(parsed.success, false, `${Object.keys(props)[0]} must be refused on a volume`)
      }
    })

    it('refuses volume fields on a filesystem', () => {
      for (const extra of [{ volsize: GiB }, { volblocksize: 8192 }, { sparse: true }]) {
        const parsed = CreateDatasetRequestSchema.safeParse({ path: 'fs', ...extra })
        assert.equal(parsed.success, false, `${Object.keys(extra)[0]} must be refused on a filesystem`)
      }
    })

    it('still accepts a pre-iscsi.3 filesystem body with no `type` at all (version skew)', () => {
      const parsed = CreateDatasetRequestSchema.safeParse({ path: 'media/movies', properties: { recordsize: 131072, quota: GiB } })
      assert.ok(parsed.success, parsed.error?.message)
      assert.equal((parsed.data as CreateDatasetRequest).type, undefined)
    })
  })

  describe('UpdateDatasetPropertiesRequest validation', () => {
    it('accepts a volsize', () => {
      const parsed = UpdateDatasetPropertiesRequest.safeParse({ properties: { volsize: 4 * GiB } })
      assert.ok(parsed.success, parsed.error?.message)
    })

    it('refuses a volsize below the 1 MiB floor', () => {
      const parsed = UpdateDatasetPropertiesRequest.safeParse({ properties: { volsize: 1024 } })
      assert.equal(parsed.success, false)
      assert.match(parsed.error!.issues[0].message, /at least 1 MiB/)
    })
  })

  // ==========================================================================
  // The one gate
  // ==========================================================================
  describe('assertVolumeMutable — the single seam', () => {
    const volume: Dataset = {
      name: VOL,
      pool: POOL,
      type: 'volume',
      used: VOL_SIZE,
      available: 0,
      referenced: 0,
      mountpoint: null,
      compression: 'on',
      compressratio: 1,
      quota: 0,
      volsize: VOL_SIZE,
    }

    it('permits a grow', () => {
      assert.equal(assertVolumeMutable(VOL, 'grow', volume, { volsize: VOL_SIZE * 2 }), null)
    })

    it('permits an unchanged volsize (an untouched edit is not a shrink)', () => {
      assert.equal(assertVolumeMutable(VOL, 'grow', volume, { volsize: VOL_SIZE }), null)
    })

    it('refuses a shrink, and says what would be lost', () => {
      const refusal = assertVolumeMutable(VOL, 'grow', volume, { volsize: GiB })
      assert.ok(refusal)
      assert.equal(refusal.reason, 'shrink')
      assert.match(refusal.message, /SHRINK/)
      assert.match(refusal.message, /no confirm bypass/)
    })

    it('asserts nothing about a filesystem', () => {
      const fs: Dataset = { ...volume, type: 'filesystem', volsize: undefined }
      assert.equal(assertVolumeMutable('gtiscsi/images', 'grow', fs, { volsize: 1 }), null)
    })

    it('fails open when the current row could not be read', () => {
      assert.equal(assertVolumeMutable(VOL, 'grow', null, { volsize: 1 }), null)
    })

    it('passes rollback / rename / destroy through today (the iscsi.6 seam)', () => {
      // Deliberate: ZFS permits all three under a live LUN and ANAS cannot yet
      // see the LUN. iscsi.6 adds its refusal HERE, so this test is what will
      // change when it does — nothing at the call sites.
      for (const op of ['rollback', 'rename', 'destroy'] as const)
        assert.equal(assertVolumeMutable(VOL, op, volume), null)
    })
  })

  // ==========================================================================
  // Read — list and detail carry the volume fields
  // ==========================================================================
  describe('GET the list and the detail', () => {
    it('lists the real volume with volsize, volblocksize and sparse', async () => {
      server = startServer()
      const res = await server.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      const vol = data.find(d => d.name === VOL)!
      assert.equal(vol.type, 'volume')
      assert.equal(vol.volsize, VOL_SIZE)
      assert.equal(vol.volblocksize, 16 * 1024)
      assert.equal(vol.sparse, false)
      assert.equal(vol.mountpoint, null)
      // A filesystem in the same pool carries none of the three.
      const fs = data.find(d => d.name === 'gtiscsi/images')!
      assert.equal(fs.volsize, undefined)
      assert.equal(fs.sparse, undefined)
    })

    it('reports the ZFS-observed default volblocksize alongside the list', async () => {
      server = startServer()
      const res = await server.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets` })
      const { defaults } = res.json() as { defaults: DatasetListDefaults }
      // Read off the capture's DEFAULT-sourced volblocksize, so the Create
      // dialog states a fact instead of a hard-coded constant.
      assert.equal(defaults.volblocksize, 16 * 1024)
    })

    it('costs no extra command — the default rides the list we already ran', async () => {
      server = startServer()
      await server.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets` })
      const lists = zfsCalls().filter(a => a[0] === 'list' && a.includes('filesystem,volume'))
      assert.equal(lists.length, 1, `expected one dataset list, got ${lists.length}`)
    })

    it('serves the volume detail with the three fields', async () => {
      server = startServer()
      const res = await server.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets/${VOL_PATH}` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetDetail }
      assert.equal(data.type, 'volume')
      assert.equal(data.volsize, VOL_SIZE)
      assert.equal(data.volblocksize, 16 * 1024)
      assert.equal(data.sparse, false)
      // No mountpoint ⇒ no POSIX permissions and no shares, and the daemon must
      // not have gone looking for either.
      assert.equal(data.permissions, null)
      assert.deepEqual(data.associatedShares, [])
    })
  })

  // ==========================================================================
  // Create
  // ==========================================================================
  describe('POST — create a volume', () => {
    async function create(body: unknown): Promise<{ status: number, json: () => unknown }> {
      const res = await server!.inject({ method: 'POST', url: `/v1/pools/${POOL}/datasets`, headers: IDENTITY_HEADERS, payload: body as object })
      return { status: res.statusCode, json: () => res.json() }
    }

    it('builds `zfs create -V <bytes>` for a plain volume', async () => {
      server = startServer()
      const res = await create({ path: 'vol2', type: 'volume', volsize: GiB })
      assert.equal(res.status, 202)
      const { job } = res.json() as JobAccepted
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed')
      const args = zfsCalls().find(a => a[0] === 'create')!
      assert.deepEqual(args, ['create', '-V', String(GiB), 'gtiscsi/vol2'])
    })

    it('builds `-s -b <blocksize> … -V <bytes>` in zfs(8) order for a sparse sized volume', async () => {
      server = startServer()
      const res = await create({ path: 'vol2', type: 'volume', volsize: 4 * GiB, volblocksize: 8192, sparse: true, properties: { compression: 'zstd' } })
      assert.equal(res.status, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const args = zfsCalls().find(a => a[0] === 'create')!
      assert.deepEqual(args, ['create', '-s', '-b', '8192', '-o', 'compression=zstd', '-V', String(4 * GiB), 'gtiscsi/vol2'])
    })

    it('omits -b entirely when no block size was asked for (ZFS owns the default)', async () => {
      server = startServer()
      const res = await create({ path: 'vol2', type: 'volume', volsize: GiB })
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const args = zfsCalls().find(a => a[0] === 'create')!
      assert.ok(!args.includes('-b'), `argv must not carry -b: ${args.join(' ')}`)
    })

    it('leaves a filesystem create byte-identical to before the story', async () => {
      server = startServer()
      const res = await create({ path: 'fs2', properties: { recordsize: 131072 } })
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const args = zfsCalls().find(a => a[0] === 'create')!
      assert.deepEqual(args, ['create', '-o', 'recordsize=131072', 'gtiscsi/fs2'])
    })

    it('400s a volume with no volsize', async () => {
      server = startServer()
      const res = await create({ path: 'vol2', type: 'volume' })
      assert.equal(res.status, 400)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
    })

    it('400s a bad block size before it reaches ZFS', async () => {
      server = startServer()
      const res = await create({ path: 'vol2', type: 'volume', volsize: GiB, volblocksize: 3000 })
      assert.equal(res.status, 400)
      assert.equal(zfsCalls().some(a => a[0] === 'create'), false, 'nothing may reach zfs')
    })

    it('409s when the volume already exists', async () => {
      server = startServer()
      const res = await create({ path: VOL_PATH, type: 'volume', volsize: GiB })
      assert.equal(res.status, 409)
    })
  })

  // ==========================================================================
  // Grow / shrink
  // ==========================================================================
  describe('PUT — grow a volume', () => {
    async function put(path: string, body: unknown) {
      return server!.inject({ method: 'PUT', url: `/v1/pools/${POOL}/datasets/${path}`, headers: IDENTITY_HEADERS, payload: body as object })
    }

    it('grows with a single `zfs set volsize=`', async () => {
      server = startServer()
      const res = await put(VOL_PATH, { properties: { volsize: 4 * GiB } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const args = zfsCalls().find(a => a[0] === 'set')!
      assert.deepEqual(args, ['set', `volsize=${4 * GiB}`, VOL])
    })

    it('a grow of a volume no LUN holds carries no LUN guidance', async () => {
      server = startServer()
      const res = await put(VOL_PATH, { properties: { volsize: 4 * GiB } })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as { warnings?: string[] }
      assert.deepEqual(result.warnings, [])
    })

    it('refuses a shrink with a 409 that has NO confirm code', async () => {
      server = startServer()
      const res = await put(VOL_PATH, { properties: { volsize: GiB } })
      assert.equal(res.statusCode, 409)
      const body = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(body.error.reason, 'shrink')
      assert.match(body.error.message, /SHRINK/)
      // Level 1: there is no override path, so no challenge is minted.
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      // And nothing reached ZFS.
      assert.equal(zfsCalls().some(a => a[0] === 'set'), false)
    })

    it('refuses a volsize on a FILESYSTEM', async () => {
      server = startServer()
      const res = await put('images', { properties: { volsize: 4 * GiB } })
      assert.equal(res.statusCode, 400)
      assert.match((res.json() as { error: { message: string } }).error.message, /volsize applies only to a volume/)
    })

    it('refuses filesystem-only properties on a volume, naming them', async () => {
      server = startServer()
      const res = await put(VOL_PATH, { properties: { recordsize: 131072, quota: GiB } })
      assert.equal(res.statusCode, 400)
      const msg = (res.json() as { error: { message: string } }).error.message
      assert.match(msg, /recordsize/)
      assert.match(msg, /quota/)
      assert.equal(zfsCalls().some(a => a[0] === 'set'), false)
    })

    it('still accepts a compression change on a volume (ZFS does carry it)', async () => {
      server = startServer()
      const res = await put(VOL_PATH, { properties: { compression: 'zstd' } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'set'), ['set', 'compression=zstd', VOL])
    })
  })

  // ==========================================================================
  // A grow rounds the requested volsize UP to a volblocksize multiple (O1
  // follow-up, 0.3.1). `zfs create -V` rounds an unaligned size up silently;
  // `zfs set volsize=` instead REFUSES it with a raw "must be a multiple of
  // volume block size" that surfaced out of a 202 as a failed job. The grow
  // door (like the iSCSI grow door, growZvolLun) now rounds first, using the
  // volblocksize ALREADY on the dataset row (ZFS_LIST_PROPS reads it, exact
  // after #50) — no extra `zfs get`. Fail-open: an unreadable volblocksize
  // applies the size as asked, the pre-fix behaviour.
  // ==========================================================================
  describe('a grow rounds volsize up to a volblocksize multiple (O1)', () => {
    /** 16 KiB — the captured vol1's real volblocksize. */
    const BS = 16384
    /** A small current size so an unaligned request is unambiguously a GROW. */
    const CURRENT = 64 * MiB

    /**
     * The real capture with vol1's current size pinned small and its
     * volblocksize optionally stripped (to exercise the fail-open path). The
     * checked-in capture stays verbatim (fixtures/zfs/NOTES.md); this is derived
     * and named as derived, the same shape the #50 block uses.
     */
    function listBody(withBlocksize: boolean): string {
      const raw = JSON.parse(fixtureText('zfs-list-volumes.json'))
      const props = raw.datasets[VOL].properties
      props.volsize.value = String(CURRENT)
      props.refreservation.value = String(CURRENT)
      if (withBlocksize)
        props.volblocksize.value = String(BS)
      else
        delete props.volblocksize
      return JSON.stringify(raw)
    }

    function startRoundServer(withBlocksize: boolean): ReturnType<typeof createServer> {
      server = createServer({ mock: true, logger: false })
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const orig = mock.exec.bind(mock)
      calls = []
      mock.exec = async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (command === '/usr/sbin/zpool' && args.length === 2 && args[0] === 'list' && args[1] === '-j')
          return { stdout: ZPOOL_LIST, stderr: '', exitCode: 0 }
        if (command === '/usr/sbin/zfs' && args[0] === 'list' && args.includes('filesystem,volume') && args.at(-1) === POOL)
          return { stdout: listBody(withBlocksize), stderr: '', exitCode: 0 }
        return orig(command, args)
      }
      return server
    }

    async function put(body: unknown) {
      return server!.inject({ method: 'PUT', url: `/v1/pools/${POOL}/datasets/${VOL_PATH}`, headers: IDENTITY_HEADERS, payload: body as object })
    }

    /** issue #50's own worked example: 1.3 GB, unaligned to a 16 KiB block. */
    const REQUESTED = 1_300_000_000
    /** 1,300,004,864 — the next 16 KiB multiple at or above the request. */
    const APPLIED = Math.ceil(REQUESTED / BS) * BS

    it('the request really is unaligned and a grow (so the assertion proves something)', () => {
      assert.notEqual(REQUESTED % BS, 0)
      assert.ok(REQUESTED > CURRENT)
      assert.equal(APPLIED, 1_300_004_864)
      assert.ok(APPLIED > REQUESTED && APPLIED - REQUESTED < BS)
    })

    it('rounds an unaligned grow UP to the next multiple in the `zfs set` argv', async () => {
      server = startRoundServer(true)
      const res = await put({ properties: { volsize: REQUESTED } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      // The raw request never reaches ZFS — only the rounded multiple does.
      assert.deepEqual(zfsCalls().find(a => a[0] === 'set'), ['set', `volsize=${APPLIED}`, VOL])
    })

    it('reports the applied (rounded) size on the job result, so read model and filesystem agree', async () => {
      server = startRoundServer(true)
      const res = await put({ properties: { volsize: REQUESTED } })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual((job.result as { applied: string[] }).applied, [`volsize=${APPLIED}`])
    })

    it('leaves an already-aligned grow byte-identical (round-up of a multiple is itself)', async () => {
      server = startRoundServer(true)
      const ALIGNED = 512 * MiB // a 16 KiB multiple and a grow over CURRENT
      assert.equal(ALIGNED % BS, 0)
      const res = await put({ properties: { volsize: ALIGNED } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'set'), ['set', `volsize=${ALIGNED}`, VOL])
    })

    it('fails open — an unreadable volblocksize applies the size exactly as asked', async () => {
      server = startRoundServer(false)
      const res = await put({ properties: { volsize: REQUESTED } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'set'), ['set', `volsize=${REQUESTED}`, VOL])
    })
  })

  // ==========================================================================
  // The never-shrink gate must compare EXACT bytes — issue #50 (D1)
  //
  // `zfs list` WITHOUT `-p` prints three significant digits, so a 1240 GiB
  // zvol reads back as `1.21T` → 1,330,409,069,609 B: ~983 MiB below its true
  // 1,331,439,861,760 B. Every requested volsize inside that window looked
  // like a GROW to `assertVolumeMutable`, and `zfs set volsize=` truncates a
  // possibly-live volume in silence. The gate itself was always right — what
  // was wrong was the number it was handed.
  //
  // So this server answers the dataset list with whichever form the daemon's
  // OWN argv asked for: display when `-p` is absent, exact when it is present.
  // That makes these assertions a statement about the command we issue rather
  // than about a fixture hand-picked to prove a point — drop `-p` from
  // `zfsListArgs` and the 409 below turns straight back into a 202.
  // ==========================================================================
  describe('the shrink gate reads exact bytes, not a rounded display size (#50)', () => {
    /** The volume's true size — 1240 GiB, issue #50's own example. */
    const TRUE_SIZE = 1331439861760
    /** What `1.21T`, the display form of that size, reconstructs as. */
    const ROUNDED_SIZE = 1330409069609
    /** A real shrink that HIDES inside the rounding window. */
    const SNEAKY_SHRINK = 1331000000000

    /**
     * The real capture with vol1 resized to the issue's number, rendered in
     * whichever form the caller asked for. Derived here and named as derived;
     * the checked-in captures stay verbatim (fixtures/zfs/NOTES.md).
     */
    function listBody(exact: boolean): string {
      const raw = JSON.parse(fixtureText('zfs-list-volumes.json'))
      const props = raw.datasets[VOL].properties
      props.volsize.value = exact ? String(TRUE_SIZE) : '1.21T'
      props.refreservation.value = exact ? String(TRUE_SIZE) : '1.21T'
      props.volblocksize.value = exact ? '16384' : '16K'
      return JSON.stringify(raw)
    }

    function startWindowServer(): ReturnType<typeof createServer> {
      server = createServer({ mock: true, logger: false })
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const orig = mock.exec.bind(mock)
      calls = []
      mock.exec = async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (command === '/usr/sbin/zpool' && args.length === 2 && args[0] === 'list' && args[1] === '-j')
          return { stdout: ZPOOL_LIST, stderr: '', exitCode: 0 }
        if (command === '/usr/sbin/zfs' && args[0] === 'list' && args.includes('filesystem,volume') && args.at(-1) === POOL)
          return { stdout: listBody(args.includes('-p')), stderr: '', exitCode: 0 }
        return orig(command, args)
      }
      return server
    }

    async function put(body: unknown) {
      return server!.inject({ method: 'PUT', url: `/v1/pools/${POOL}/datasets/${VOL_PATH}`, headers: IDENTITY_HEADERS, payload: body as object })
    }

    it('asks ZFS for exact bytes in the first place', () => {
      const args = zfsListArgs(POOL)
      assert.ok(args.includes('-p'), `the dataset list must carry -p: ${args.join(' ')}`)
    })

    it('the rounding window is real, and the shrink sits inside it', () => {
      assert.ok(SNEAKY_SHRINK < TRUE_SIZE, 'the request IS a shrink')
      assert.ok(SNEAKY_SHRINK > ROUNDED_SIZE, 'and the display form would have called it a grow')
      assert.ok(TRUE_SIZE - ROUNDED_SIZE > 900 * MiB)
    })

    it('lists the volume at its exact size, not its display size', async () => {
      server = startWindowServer()
      const res = await server.inject({ method: 'GET', url: `/v1/pools/${POOL}/datasets` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      assert.equal(data.find(d => d.name === VOL)!.volsize, TRUE_SIZE)
    })

    it('REFUSES a shrink that hides inside the rounding window', async () => {
      server = startWindowServer()
      const res = await put({ properties: { volsize: SNEAKY_SHRINK } })
      assert.equal(res.statusCode, 409, 'a shrink inside the rounding window must not pass as a grow')
      const body = res.json() as { error: { reason: string, message: string } }
      assert.equal(body.error.reason, 'shrink')
      // The refusal quotes the volume's REAL size, so the operator can see it.
      assert.match(body.error.message, new RegExp(String(TRUE_SIZE)))
      assert.equal(zfsCalls().some(a => a[0] === 'set'), false, 'nothing may reach `zfs set volsize=`')
    })

    it('still lets a genuine grow through', async () => {
      server = startWindowServer()
      const res = await put({ properties: { volsize: TRUE_SIZE + GiB } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'set'), ['set', `volsize=${TRUE_SIZE + GiB}`, VOL])
    })
  })

  // ==========================================================================
  // The verbs a volume shares with every other dataset
  // ==========================================================================
  describe('the existing verbs keep working on a volume', () => {
    it('snapshots a volume through the ordinary snapshot endpoint', async () => {
      server = startServer()
      const res = await server.inject({
        method: 'POST',
        url: `/v1/pools/${POOL}/datasets/${VOL_PATH}/snapshots`,
        headers: IDENTITY_HEADERS,
        payload: { name: 'nightly' },
      })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'snapshot'), ['snapshot', `${VOL}@nightly`])
    })

    it('rolls a volume back — through the gate, which lets it through TODAY', async () => {
      // ZFS permits this even under a live iSCSI session (exit 0, with a
      // filesystem mounted on the initiator), so nothing below ANAS refuses it.
      // What matters here is that the verb ROUTES THROUGH assertVolumeMutable:
      // when iscsi.6 teaches that one function about LUNs, this call site is
      // already covered and this test is the one that flips.
      server = startServer()
      const url = `/v1/pools/${POOL}/datasets/${VOL_PATH}/snapshots/before-grow/rollback`
      const challenge = await server.inject({ method: 'POST', url, headers: IDENTITY_HEADERS })
      assert.equal(challenge.statusCode, 409)
      const code = challenge.headers['x-anas-confirm-code'] as string
      assert.ok(code, 'rollback stays confirm-gated on a volume, exactly as for a filesystem')
      const res = await server.inject({ method: 'POST', url, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'rollback'), ['rollback', `${VOL}@before-grow`])
    })

    /**
     * Live-proof F15. ZFS refuses a non-recursive destroy of a volume that has
     * snapshots, and the refusal used to reach the operator as the bare CLI
     * sentence ("volume has children / use '-r' to destroy the following
     * datasets: …"). Correct, safe, and no help: the standing "guide, don't just
     * warn" ruling wants the counts, the names and the two ways forward, at the
     * confirm door where the decision is actually made.
     */
    it('names the snapshots and BOTH ways forward, instead of the raw ZFS text', async () => {
      server = startServer()
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const wrapped = mock.exec.bind(mock)
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
      mock.exec = async (command: string, args: string[]) => {
        // The name-only snapshot listing the destroy pre-flight uses.
        if (command === '/usr/sbin/zfs' && same(args, zfsSnapshotListArgs(VOL))) {
          return {
            stdout: JSON.stringify({
              output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
              datasets: {
                [`${VOL}@r1`]: { name: `${VOL}@r1`, type: 'SNAPSHOT', pool: POOL },
                [`${VOL}@r2`]: { name: `${VOL}@r2`, type: 'SNAPSHOT', pool: POOL },
              },
            }),
            stderr: '',
            exitCode: 0,
          }
        }
        // …and ZFS's real refusal, verbatim from the live proof.
        if (command === '/usr/sbin/zfs' && same(args, ['destroy', VOL])) {
          return {
            stdout: '',
            stderr: `cannot destroy '${VOL}': volume has children\nuse '-r' to destroy the following datasets:\n${VOL}@r1`,
            exitCode: 1,
          }
        }
        return wrapped(command, args)
      }

      const url = `/v1/pools/${POOL}/datasets/${VOL_PATH}`
      const challenge = await server.inject({ method: 'DELETE', url, headers: IDENTITY_HEADERS })
      assert.equal(challenge.statusCode, 409)
      const body = challenge.json() as { error: { warnings?: string[] } }
      const warnings = body.error.warnings ?? []
      const guide = warnings.find(w => /destroy them first/i.test(w))
      assert.ok(guide, `the confirm door must guide: ${warnings.join(' | ')}`)
      assert.match(guide!, /Volume '.*vol1' has 2 snapshots/)
      assert.match(guide!, /gtiscsi\/vol1@r1, gtiscsi\/vol1@r2/)
      assert.match(guide!, /confirm again with Recursive/i)
      // Never the flag name on its own.
      assert.ok(!warnings.some(w => /use '-r'/.test(w)), warnings.join(' | '))

      // And if they confirm without Recursive anyway, the JOB says the same
      // thing rather than forwarding the CLI sentence.
      const code = challenge.headers['x-anas-confirm-code'] as string
      const res = await server.inject({ method: 'DELETE', url, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /has 2 snapshots/)
      assert.match(job.error!.message, /Destroy them first/i)
      assert.ok(!/use '-r'/.test(job.error!.message), job.error!.message)
    })

    it('destroys a volume through the ordinary confirm-gated destroy', async () => {
      server = startServer()
      const url = `/v1/pools/${POOL}/datasets/${VOL_PATH}`
      const challenge = await server.inject({ method: 'DELETE', url, headers: IDENTITY_HEADERS })
      assert.equal(challenge.statusCode, 409)
      const code = challenge.headers['x-anas-confirm-code'] as string
      assert.ok(code, 'destroy is confirm-gated, exactly as for a filesystem')
      const res = await server.inject({ method: 'DELETE', url, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
      assert.equal(res.statusCode, 202)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.deepEqual(zfsCalls().find(a => a[0] === 'destroy'), ['destroy', VOL])
    })
  })
})
