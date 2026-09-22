import type { Dataset, DatasetDetail, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { zfsListArgs, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

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

/**
 * Record every command the route issues, optionally overriding results. Lets a
 * test assert the exact argument arrays (e.g. that ONE `zfs set` carries the
 * whole property edit) and pose a command as failing.
 */
interface Call { command: string, args: string[] }
function recordCalls(
  server: ReturnType<typeof createServer>,
  override?: (command: string, args: string[]) => ExecResult | undefined,
): Call[] {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const calls: Call[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return override?.(command, args) ?? orig(command, args)
  }
  return calls
}

// smb.conf + /etc/exports whose share paths match testpool/media's mountpoint
// (/testpool/media). `[archive]` and /srv/other are decoys on other paths.
const MEDIA_MOUNTPOINT = '/testpool/media'
const SMB_CONF = [
  '[global]',
  '\tworkgroup = WORKGROUP',
  '',
  '[media]',
  `\tpath = ${MEDIA_MOUNTPOINT}`,
  '\tread only = no',
  '',
  '[archive]',
  '\tpath = /testpool/archive',
  '',
].join('\n')
const EXPORTS = [
  `${MEDIA_MOUNTPOINT}  192.168.1.0/24(rw,sync,no_subtree_check)`,
  '/srv/other  *(ro,sync)',
  '',
].join('\n')

// A recursive name-only snapshot listing for the whole pool: testpool has one
// root snapshot, testpool/media has two, and the zvol has none. This is what
// the enriched flat feed tallies into `snapshotCount`.
const SNAPSHOTS_RECURSIVE = JSON.stringify({
  output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
  datasets: {
    'testpool@rootsnap': { name: 'testpool@rootsnap', type: 'SNAPSHOT', pool: 'testpool', properties: {} },
    'testpool/media@snap1': { name: 'testpool/media@snap1', type: 'SNAPSHOT', pool: 'testpool', properties: {} },
    'testpool/media@snap2': { name: 'testpool/media@snap2', type: 'SNAPSHOT', pool: 'testpool', properties: {} },
  },
})

/** The recursive snapshot-count command the enriched flat list issues. */
const SNAPSHOT_COUNT_ARGS = ['list', '-j', '-o', 'name', '-t', 'snapshot', '-r', 'testpool']

describe('datasets routes', () => {
  let server: ReturnType<typeof createServer> | undefined
  let shareDir: string | undefined

  /**
   * Start a mock server wired to a temp smb.conf + /etc/exports whose share
   * paths point at testpool/media's mountpoint, so associatedShares resolves.
   */
  function startServerWithShares(): ReturnType<typeof createServer> {
    shareDir = mkdtempSync(join(tmpdir(), 'anas-ds-shares-'))
    const smbConfPath = join(shareDir, 'smb.conf')
    const exportsPath = join(shareDir, 'exports')
    writeFileSync(smbConfPath, SMB_CONF, 'utf8')
    writeFileSync(exportsPath, EXPORTS, 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath
    server = createServer({ mock: true, logger: false, smbConfPath })
    return server
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_EXPORTS_PATH
    if (shareDir) {
      rmSync(shareDir, { recursive: true, force: true })
      shareDir = undefined
    }
  })

  // --- GET list ----------------------------------------------------------
  describe('GET /v1/pools/:name/datasets', () => {
    it('returns the flat dataset list (filesystems + volumes)', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      const names = data.map(d => d.name).sort()
      assert.deepEqual(names, ['testpool', 'testpool/media', 'testpool/vm-100-disk-0'])
    })

    it('returns 404 for a pool that does not exist', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/nosuchpool/datasets' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('enriches each dataset with a snapshotCount from ONE recursive pass', async () => {
      server = createServer({ mock: true, logger: false })
      // Register the whole-pool recursive snapshot listing (exact-args fixtures
      // win over the command-only zfs fallback).
      const mock = (server as unknown as { executor: MockExecutor }).executor
      mock.addFixture({ command: '/usr/sbin/zfs', args: SNAPSHOT_COUNT_ARGS, result: { stdout: SNAPSHOTS_RECURSIVE, stderr: '', exitCode: 0 } })

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      const byName = Object.fromEntries(data.map(d => [d.name, d]))
      assert.equal(byName['testpool/media'].snapshotCount, 2)
      assert.equal(byName.testpool.snapshotCount, 1)
      // A dataset with no snapshots simply omits the field (undefined).
      assert.equal(byName['testpool/vm-100-disk-0'].snapshotCount, undefined)
    })

    it('enriches datasets with sharedOver from the SMB/NFS share config (gathered once)', async () => {
      server = startServerWithShares()
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      const byName = Object.fromEntries(data.map(d => [d.name, d]))
      // testpool/media is shared over both protocols (smb.conf [media] + exports).
      assert.deepEqual(byName['testpool/media'].sharedOver, ['smb', 'nfs'])
      // Unshared datasets omit the field entirely.
      assert.equal(byName.testpool.sharedOver, undefined)
      assert.equal(byName['testpool/vm-100-disk-0'].sharedOver, undefined)
    })

    it('omits enrichment fields when nothing matches (no snapshots, no shares on these paths)', async () => {
      // Default mock: the command-only zfs fallback returns empty for the
      // recursive snapshot listing, and the seeded smb.conf/exports share other
      // paths (/tank/*, /srv/nfs/*), none of them a testpool mountpoint — so
      // both optional fields stay absent.
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Dataset[] }
      for (const d of data) {
        assert.equal(d.snapshotCount, undefined)
        assert.equal(d.sharedOver, undefined)
      }
    })
  })

  // --- GET detail --------------------------------------------------------
  describe('GET /v1/pools/:name/datasets/*path', () => {
    it('returns full detail with properties and mountpoint permissions', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetDetail }
      assert.equal(data.name, 'testpool/media')
      assert.equal(data.properties.compression, 'zstd')
      assert.equal(data.properties.recordsize, 128 * 1024)
      assert.deepEqual(data.permissions, { owner: 'root', group: 'root', mode: '755' })
      assert.deepEqual(data.associatedShares, [])
    })

    it('returns 404 for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/nope' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('lists SMB and NFS shares serving the dataset mountpoint (Epic 4.4)', async () => {
      server = startServerWithShares()
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetDetail }
      // Only shares on /testpool/media — [archive] and /srv/other are excluded.
      assert.deepEqual(data.associatedShares, [
        { protocol: 'smb', name: 'media' },
        { protocol: 'nfs', name: MEDIA_MOUNTPOINT },
      ])
    })
  })

  // --- POST create -------------------------------------------------------
  describe('POST /v1/pools/:name/datasets', () => {
    it('returns 202 and completes for a new dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'projects', properties: { compression: 'lz4', quota: 1073741824 } }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.create')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
    })

    it('returns 409 when the dataset already exists', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'media' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('rejects requests without identity headers', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'projects' }),
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- PUT update properties --------------------------------------------
  describe('PUT /v1/pools/:name/datasets/*path', () => {
    it('returns 202 and applies property changes', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'zstd', atime: false, quota: 0 } }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.set')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      const result = job.result as { applied: string[] }
      assert.ok(result.applied.includes('quota=none'))
      assert.ok(result.applied.includes('atime=off'))
    })

    it('returns 404 for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/nope',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'lz4' } }),
      })
      assert.equal(res.statusCode, 404)
    })

    it('rejects an empty property set', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: {} }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- #43: a property edit is all-or-nothing ----------------------------
  //
  // The bug: a blanked "Record size" field sent recordsize=0, ZFS rejected it,
  // and because properties were applied one `zfs set` at a time the failure
  // landed AFTER the earlier properties were already written — a half-applied
  // edit the operator never asked for. Two guards: the value is refused at the
  // API boundary, and the apply is a single command either way.
  describe('PUT /v1/pools/:name/datasets/*path — all-or-nothing apply (#43)', () => {
    it('applies every property in ONE zfs set (no per-property sequence to fail halfway)', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server)

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'zstd', recordsize: 1048576, atime: false, quota: 0 } }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      const sets = calls.filter(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set')
      assert.equal(sets.length, 1, 'exactly one zfs set carries the whole edit')
      assert.deepEqual(sets[0].args, [
        'set',
        'compression=zstd',
        'recordsize=1048576',
        'quota=none',
        'atime=off',
        'testpool/media',
      ])
    })

    it('a rejected zfs set writes nothing — the job fails after a single attempt', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server, (command, args) =>
        command === '/usr/sbin/zfs' && args[0] === 'set'
          ? { stdout: '', stderr: 'cannot set property for \'testpool/media\': invalid property value', exitCode: 1 }
          : undefined)

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'zstd', atime: false } }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /invalid property value/)
      assert.equal(calls.filter(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set').length, 1)
    })

    it('rejects a blanked record size (recordsize=0) at the boundary — nothing is applied', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server)

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { compression: 'zstd', recordsize: 0 } }),
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /recordsize/)
      // The 400 lands before the job exists, so the compression change that
      // would have gone first never happens.
      assert.equal(calls.filter(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set').length, 0)
    })

    it('rejects a recordsize that is not a power of two, and one out of range', async () => {
      server = createServer({ mock: true, logger: false })
      const put = (recordsize: number) => server!.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ properties: { recordsize } }),
      })
      assert.equal((await put(100000)).statusCode, 400) // not a power of two
      assert.equal((await put(256)).statusCode, 400) // below the 512 floor
      assert.equal((await put(32 * 1024 * 1024)).statusCode, 400) // above the 16M ceiling
      assert.equal((await put(131072)).statusCode, 202) // 128K is fine
    })

    it('rejects recordsize=0 on create too (same shared constraint)', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'projects', properties: { recordsize: 0 } }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- PUT permissions ---------------------------------------------------
  describe('PUT /v1/pools/:name/datasets/*path/permissions', () => {
    it('returns 202 and runs chown/chmod on the mountpoint', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/permissions',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ owner: 'media', group: 'media', mode: '2770', recursive: true }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'fs.setPermissions')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      const result = job.result as { mountpoint: string }
      assert.equal(result.mountpoint, '/testpool/media')
    })

    it('rejects an invalid mode', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/permissions',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ mode: '9999' }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- DELETE destroy ----------------------------------------------------
  describe('DELETE /v1/pools/:name/datasets/*path', () => {
    it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
    })

    it('proceeds to 202 when resent with a valid code — and recursive is NOT in the signature', async () => {
      server = createServer({ mock: true, logger: false })
      // Challenge WITHOUT recursive (chosen after the challenge is issued)...
      const first = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      // ...then resend WITH recursive=true. If recursive were bound into the
      // confirm signature this would 409 again (the pool-destroy bug).
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media?recursive=true',
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.destroy')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
    })

    it('returns 404 for a dataset that does not exist', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/nope',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 404)
    })

    it('warns that associated shares will break (Epic 4.4)', async () => {
      server = startServerWithShares()
      const res = await server.inject({
        method: 'DELETE',
        url: '/v1/pools/testpool/datasets/media',
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      const warnings = res.json().error.warnings as string[]
      const shareWarning = warnings.find(w => w.includes('serve this dataset'))
      assert.ok(shareWarning, 'expected a share warning')
      assert.ok(shareWarning!.includes(`'smb:media'`))
      assert.ok(shareWarning!.includes(`'nfs:${MEDIA_MOUNTPOINT}'`))
    })
  })

  // --- POST clone (plain 202, no confirmation) — Epic 5.7 ----------------
  describe('POST …/snapshots/:snap/clone', () => {
    it('returns 202 and issues zfs clone testpool/media@snap1 <target>', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/clone',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: 'testpool/restored' }),
      })
      assert.equal(res.statusCode, 202)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'zfs.clone')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      const result = job.result as { cloned: string, target: string }
      assert.equal(result.cloned, 'testpool/media@snap1')
      assert.equal(result.target, 'testpool/restored')
    })

    it('returns 404 for an unknown snapshot', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/nope/clone',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: 'testpool/restored' }),
      })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('returns 409 when the target dataset already exists', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/clone',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: 'testpool/media' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('returns 400 for an invalid target name', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets/media/snapshots/snap1/clone',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ target: '/bad//name' }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })
  })
})

// --- PVE footprint ownership (story pvepool.1) ---------------------------
// The fixture set: a BARE zfspool storage on `testpool` (the pool root is the
// storage root), so `testpool` itself and `testpool/vm-100-disk-0` are owned
// (storage-root / guest-volume) and `testpool/media` is the sibling this story
// exists to unlock.
describe('PVE footprint ownership (pvepool.1)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevCfg: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ds-pve-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    await writeFile(join(dir, 'storage.cfg'), 'zfspool: local-zfs\n\tpool testpool\n\tcontent images,rootdir\n\n', 'utf8')
    process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (prevCfg === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = prevCfg
  })

  it('GET list stamps `pve` on OWNED rows only — the sibling carries no field', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: Dataset[] }
    const byName = new Map(data.map(d => [d.name, d]))
    assert.equal(byName.get('testpool')?.pve?.kind, 'storage-root')
    assert.match(byName.get('testpool')?.pve?.reason ?? '', /local-zfs/)
    assert.match(byName.get('testpool')?.pve?.reason ?? '', /testpool/)
    assert.equal(byName.get('testpool/vm-100-disk-0')?.pve?.kind, 'guest-volume')
    // The sibling this story exists to unlock: NO field means manageable.
    assert.equal(byName.get('testpool/media')?.pve, undefined)
  })

  it('the naming guard refuses a guest-named child of the storage root (400, backstop)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'vm-101-disk-1' }),
    })
    assert.equal(res.statusCode, 400)
    // The sentence names the storage AND the dataset.
    assert.match(res.json().error.message, /local-zfs/)
    assert.match(res.json().error.message, /testpool\/vm-101-disk-1/)
    assert.match(res.json().error.message, /guest disk/)
  })

  it('a plain child of the storage root IS created — the whole point of the story', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'media2' }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  it('creating INSIDE a guest volume is refused with the ownership reason', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'vm-100-disk-0/inner' }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /owns testpool\/vm-100-disk-0\/inner/)
  })

  it('properties on an OWNED dataset are refused with the ownership reason', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ properties: { compression: 'lz4' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /guest volume/)
  })

  it('destroying an OWNED dataset is refused before the confirm gate', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /guest volume/)
  })

  // pvepool.1 review fixes: chown/chmod -R and setfacl -R are exactly as much
  // PVE's territory as a destroy — an OWNED dataset is view-only for the
  // permissions and access writers too. Asked BEFORE the dataset read (an
  // owned VOLUME would otherwise come back 409 "no mountpoint" / 404 "not a
  // mounted filesystem", not the ownership reason).
  it('setPermissions on an OWNED dataset is refused with the ownership reason', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/permissions',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: '750' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    // The sentence names the storage AND the dataset.
    assert.match(res.json().error.message, /local-zfs/)
    assert.match(res.json().error.message, /testpool\/vm-100-disk-0/)
    assert.match(res.json().error.message, /guest volume/)
  })

  it('setPermissions on the sibling proceeds past the guard', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/media/permissions',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: '750' }),
    })
    // Past the ownership guard: the mountpoint read resolves and the job is
    // accepted (the dev-mock chown/chmod succeed, so it completes).
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  it('setAccess on an OWNED dataset is refused with the ownership reason', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/access',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ entries: [{ kind: 'owner', level: 'read-write' }] }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /local-zfs/)
    assert.match(res.json().error.message, /testpool\/vm-100-disk-0/)
    assert.match(res.json().error.message, /guest volume/)
  })

  it('setAccess on the sibling proceeds past the guard', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/media/access',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
        ],
      }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  // Snapshot verbs under an OWNED dataset. The default mock knows no snapshots
  // under the guest volume, so each case below registers the one it needs.
  const GUEST_SNAP = JSON.stringify({
    datasets: {
      'testpool/vm-100-disk-0@vm-snap': {
        name: 'testpool/vm-100-disk-0@vm-snap',
        type: 'SNAPSHOT',
        pool: 'testpool',
        properties: {},
      },
    },
  })

  function guestVolumeWithSnapshot(): void {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({ command: '/usr/sbin/zfs', args: zfsSnapshotDetailArgs('testpool/vm-100-disk-0'), result: { stdout: GUEST_SNAP, stderr: '', exitCode: 0 } })
  }

  // pvepool.1 review fixes (the missing unit test): snapshot CREATE is a
  // mutation like every other verb — an OWNED dataset refuses with the reason,
  // before the 409 already-exists check has anything to say about it.
  it('creating a snapshot on an OWNED dataset is refused with the ownership reason', async () => {
    guestVolumeWithSnapshot()
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/snapshots',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'pre-upgrade' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /local-zfs/)
    assert.match(res.json().error.message, /testpool\/vm-100-disk-0/)
    assert.match(res.json().error.message, /guest volume/)
  })

  it('renaming a snapshot of an OWNED dataset is refused with the ownership reason', async () => {
    guestVolumeWithSnapshot()
    const res = await server!.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/snapshots/vm-snap',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ newName: 'renamed' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /guest volume/)
  })

  it('rolling back an OWNED dataset is refused before the confirm gate (400, not 409)', async () => {
    guestVolumeWithSnapshot()
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/snapshots/vm-snap/rollback',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /guest volume/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('destroying a snapshot of an OWNED dataset is refused with the ownership reason', async () => {
    guestVolumeWithSnapshot()
    const res = await server!.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/snapshots/vm-snap',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /guest volume/)
  })

  it('cloning OUT of an OWNED dataset is refused with the ownership reason', async () => {
    guestVolumeWithSnapshot()
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/vm-100-disk-0/snapshots/vm-snap/clone',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ target: 'testpool/restored' }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /guest volume/)
  })

  it('the same snapshot verbs on the sibling pass the guard — rename', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/datasets/media/snapshots/snap1',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ newName: 'renamed' }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { to: string }).to, 'testpool/media@renamed')
  })

  it('the same snapshot verbs on the sibling pass the guard — rollback (challenge, then 202)', async () => {
    server = createServer({ mock: true, logger: false })
    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(first.statusCode, 409)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code'] as string
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
  })

  it('the same snapshot verbs on the sibling pass the guard — destroy (plain 202)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool/datasets/media/snapshots/snap1',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 202)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.equal((job.result as { destroyed: string }).destroyed, 'testpool/media@snap1')
  })
})

// --- pvepool.1 review fix 2: recursive verbs vs a NESTED PVE storage -------

/** One `zfs list -j` dataset row — minimal, but everything parseZfsList reads. */
function datasetRow(name: string, type: 'FILESYSTEM' | 'VOLUME'): [string, unknown] {
  return [name, {
    name,
    type,
    pool: 'testpool',
    properties: {
      used: { value: '1M', source: { type: 'NONE', data: '-' } },
      available: { value: '1G', source: { type: 'NONE', data: '-' } },
      referenced: { value: '1M', source: { type: 'NONE', data: '-' } },
      mountpoint: { value: `/${name}`, source: { type: 'DEFAULT', data: '-' } },
      type: { value: type.toLowerCase(), source: { type: 'NONE', data: '-' } },
    },
  }]
}

// The nested-storage shape: the zfspool storage is registered on
// `testpool/x/data`, so `testpool/x` itself is NOT owned — but a recursive
// verb on it would sweep the storage root and its guest disk.
const NESTED_LIST = JSON.stringify({
  output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
  datasets: Object.fromEntries([
    datasetRow('testpool', 'FILESYSTEM'),
    datasetRow('testpool/x', 'FILESYSTEM'),
    datasetRow('testpool/x/data', 'FILESYSTEM'),
    datasetRow('testpool/x/data/vm-100-disk-0', 'VOLUME'),
    datasetRow('testpool/x/media', 'FILESYSTEM'),
  ]),
})

describe('recursive verbs over a NESTED PVE storage (review fix 2)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevCfg: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ds-nested-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    await writeFile(join(dir, 'storage.cfg'), 'zfspool: local-zfs\n\tpool testpool/x/data\n\tcontent images,rootdir\n\n', 'utf8')
    process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
    server = createServer({ mock: true, logger: false })
    // Answer ONLY the pool dataset list with the nested fixture — the
    // first-registered exact fixture (the default zfsList) would otherwise win.
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const listArgs = zfsListArgs('testpool').join(' ')
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/sbin/zfs' && args.join(' ') === listArgs)
        return { stdout: NESTED_LIST, stderr: '', exitCode: 0 }
      return orig(command, args)
    }
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (prevCfg === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = prevCfg
  })

  it('non-recursive destroy of the unowned parent behaves as before (confirm gate, not the ownership refusal)', async () => {
    const res = await server!.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool/datasets/x',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
  })

  it('recursive destroy of the unowned parent is refused, naming the owned descendant', async () => {
    const res = await server!.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool/datasets/x?recursive=true',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 400)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.match(error.message, /Destroy of 'testpool\/x' would include testpool\/x\/data/)
    assert.match(error.message, /local-zfs/)
  })

  it('recursive destroy of the sibling passes the guard (confirm gate)', async () => {
    const res = await server!.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool/datasets/x/media?recursive=true',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
  })

  it('a recursive snapshot of the unowned parent is refused, naming the owned descendant', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/x/snapshots',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'snap1', recursive: true }),
    })
    assert.equal(res.statusCode, 400)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.match(error.message, /Recursive snapshot of 'testpool\/x' would include testpool\/x\/data/)
  })

  it('a recursive snapshot of the sibling passes the guard (202)', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/x/media/snapshots',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'snap1', recursive: true }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })
})

// --- pvepool.1 review fix 1: unreadable storage.cfg fails CLOSED ------------

describe('unreadable storage.cfg fails closed (review fix 1)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevCfg: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ds-eisdir-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    // The env override points at a DIRECTORY: readFile rejects with EISDIR —
    // any non-ENOENT failure stands in for pmxcfs (/etc/pve) being down.
    process.env.ANAS_STORAGE_CFG = dir
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (prevCfg === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = prevCfg
  })

  it('a dataset create is refused with the unreadable reason (400 VALIDATION_ERROR)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'media2' }),
    })
    assert.equal(res.statusCode, 400)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.match(error.message, /PVE storage configuration is unreadable/)
    assert.match(error.message, /pool 'testpool' is treated as PVE's until it can be read/)
  })

  it('the tree stamps `pve` on EVERY node with the unreadable reason — reads work, mutations refuse', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets' })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: Dataset[] }
    assert.ok(data.length > 0)
    for (const d of data) {
      assert.equal(d.pve?.kind, 'system', d.name)
      assert.match(d.pve?.reason ?? '', /unreadable/)
    }
  })
})
