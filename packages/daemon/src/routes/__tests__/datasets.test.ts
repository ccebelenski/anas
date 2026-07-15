import type { Dataset, DatasetDetail, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
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
