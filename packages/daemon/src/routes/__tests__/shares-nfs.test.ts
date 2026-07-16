import type { Job, JobAccepted, NfsExport } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const FIXTURE = [
  '# ANAS-managed NFS exports',
  '',
  '/srv/nfs/media    192.168.1.0/24(rw,sync,no_subtree_check) 10.0.0.5(ro,sync)',
  '/srv/nfs/backups  *(ro,sync,no_subtree_check,root_squash)',
  '',
  '# hand-maintained — leave alone',
  '/export/legacy\t\tnfsclient.example.com(rw,async,no_root_squash)',
  '',
].join('\n')

/** %2F-encode a path so it rides in a single URL segment. */
function enc(path: string): string {
  return encodeURIComponent(path)
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

describe('nfs export routes', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let exportsPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-nfs-'))
    exportsPath = join(dir, 'exports')
    await writeFile(exportsPath, FIXTURE)
    process.env.ANAS_EXPORTS_PATH = exportsPath
    server = createServer({ mock: true, logger: false })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_EXPORTS_PATH
    await rm(dir, { recursive: true, force: true })
  })

  // --- GET list ----------------------------------------------------------
  describe('GET /v1/shares/nfs', () => {
    it('lists all exports in the file (incl. hand-maintained ones)', async () => {
      const res = await server!.inject({ method: 'GET', url: '/v1/shares/nfs' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport[] }
      assert.deepEqual(data.map(e => e.path), ['/srv/nfs/media', '/srv/nfs/backups', '/export/legacy'])
    })

    it('sets pathExists true for a live path and false for a missing one (stale)', async () => {
      const livePath = join(dir, 'live')
      await mkdir(livePath)
      await writeFile(exportsPath, [
        `${livePath} 10.0.0.0/24(rw,sync)`,
        '/does/not/exist *(ro,sync)',
        '',
      ].join('\n'))
      const res = await server!.inject({ method: 'GET', url: '/v1/shares/nfs' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport[] }
      assert.equal(data.find(e => e.path === livePath)!.pathExists, true)
      assert.equal(data.find(e => e.path === '/does/not/exist')!.pathExists, false)
    })

    it('returns an empty list when the file is missing', async () => {
      await rm(exportsPath)
      const res = await server!.inject({ method: 'GET', url: '/v1/shares/nfs' })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json().data, [])
    })
  })

  // --- GET detail --------------------------------------------------------
  describe('GET /v1/shares/nfs/:path', () => {
    it('returns the export for a URL-encoded path', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/shares/nfs/${enc('/srv/nfs/media')}` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport }
      assert.equal(data.path, '/srv/nfs/media')
      assert.deepEqual(data.clients[0], { spec: '192.168.1.0/24', options: ['rw', 'sync', 'no_subtree_check'] })
    })

    it('returns 404 for a path that is not exported', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/shares/nfs/${enc('/nope')}` })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })
  })

  // --- POST create -------------------------------------------------------
  describe('POST /v1/shares/nfs', () => {
    it('creates an export: 202, appends one line, leaves the rest byte-identical', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/new', clients: [{ spec: '10.1.0.0/16', options: ['rw', 'sync'] }] }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'nfs.export.add')
      const job = await waitForJob(server!, body.job.id)
      assert.equal(job.status, 'completed')

      const after = await readFile(exportsPath, 'utf8')
      assert.ok(after.startsWith(before), 'existing lines preserved verbatim')
      assert.equal(after.slice(before.length), '/srv/nfs/new 10.1.0.0/16(rw,sync)\n')
    })

    it('returns 409 when the path is already exported', async () => {
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/media', clients: [{ spec: '*', options: ['rw'] }] }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('rejects an export with no clients (schema min 1)', async () => {
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/x', clients: [] }),
      })
      assert.equal(res.statusCode, 400)
    })

    it('rejects requests without identity headers', async () => {
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/x', clients: [{ spec: '*', options: ['rw'] }] }),
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- PUT update --------------------------------------------------------
  describe('PUT /v1/shares/nfs/:path', () => {
    it('replaces ONLY the target export line', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/shares/nfs/${enc('/srv/nfs/media')}`,
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ clients: [{ spec: '172.16.0.0/12', options: ['rw', 'async'] }] }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'nfs.export.set')
      const job = await waitForJob(server!, body.job.id)
      assert.equal(job.status, 'completed')

      const after = await readFile(exportsPath, 'utf8')
      const beforeLines = before.split('\n')
      const afterLines = after.split('\n')
      assert.equal(beforeLines.length, afterLines.length)
      for (let i = 0; i < beforeLines.length; i++) {
        if (beforeLines[i].startsWith('/srv/nfs/media'))
          assert.equal(afterLines[i], '/srv/nfs/media 172.16.0.0/12(rw,async)')
        else
          assert.equal(afterLines[i], beforeLines[i])
      }
    })

    it('returns 404 for a path that is not exported', async () => {
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/shares/nfs/${enc('/nope')}`,
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ clients: [{ spec: '*', options: ['rw'] }] }),
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- DELETE (confirmation-gated) --------------------------------------
  describe('DELETE /v1/shares/nfs/:path', () => {
    it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/backups')}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
    })

    it('removes ONLY the target line when resent with a valid code', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const first = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/backups')}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string

      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/backups')}`,
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'nfs.export.remove')
      const job = await waitForJob(server!, body.job.id)
      assert.equal(job.status, 'completed')

      const after = await readFile(exportsPath, 'utf8')
      const expected = before.split('\n').filter(l => !l.startsWith('/srv/nfs/backups')).join('\n')
      assert.equal(after, expected)
    })

    it('returns 404 for a path that is not exported', async () => {
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/nope')}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 404)
    })
  })
})
