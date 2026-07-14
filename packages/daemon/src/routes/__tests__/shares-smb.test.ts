import type { Job, JobAccepted, SmbGlobalConfig, SmbShare, SmbShareDetail } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const SAMPLE_CONF = [
  '# test smb.conf',
  '',
  '[global]',
  '\tworkgroup = WORKGROUP',
  '\tserver string = ANAS Storage',
  '\tinterfaces = lo eth0',
  '\tbind interfaces only = yes',
  '\tlog level = 1',
  '',
  '[media]',
  '\tcomment = Media library',
  '\tpath = /tank/media',
  '\tbrowseable = yes',
  '\tread only = no',
  '\tvalid users = media @smbusers',
  '',
  '[archive]',
  '\tpath = /tank/archive',
  '\tread only = yes',
  '',
].join('\n')

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

describe('SMB share routes', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined
  let confPath: string | undefined

  function startServer(conf = SAMPLE_CONF): ReturnType<typeof createServer> {
    dir = mkdtempSync(join(tmpdir(), 'anas-smb-test-'))
    confPath = join(dir, 'smb.conf')
    writeFileSync(confPath, conf, 'utf8')
    server = createServer({ mock: true, logger: false, smbConfPath: confPath })
    return server
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
      confPath = undefined
    }
  })

  // --- GET list ----------------------------------------------------------
  describe('GET /v1/shares/smb', () => {
    it('lists ALL shares (Principle 11), excluding [global]', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbShare[] }
      assert.deepEqual(data.map(d => d.name).sort(), ['archive', 'media'])
      const media = data.find(d => d.name === 'media')!
      assert.equal(media.path, '/tank/media')
      assert.equal(media.readOnly, false)
      assert.deepEqual(media.validUsers, ['media', '@smbusers'])
    })

    it('returns an empty list when smb.conf is missing', async () => {
      dir = mkdtempSync(join(tmpdir(), 'anas-smb-test-'))
      confPath = join(dir, 'does-not-exist.conf')
      server = createServer({ mock: true, logger: false, smbConfPath: confPath })
      const res = await server.inject({ method: 'GET', url: '/v1/shares/smb' })
      assert.equal(res.statusCode, 200)
      assert.deepEqual((res.json() as { data: SmbShare[] }).data, [])
    })
  })

  // --- GET global --------------------------------------------------------
  describe('GET /v1/shares/smb/global', () => {
    it('returns the parsed [global] config', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/global' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbGlobalConfig }
      assert.equal(data.workgroup, 'WORKGROUP')
      assert.equal(data.serverString, 'ANAS Storage')
      assert.deepEqual(data.interfaces, ['lo', 'eth0'])
      assert.equal(data.bindInterfacesOnly, true)
    })
  })

  // --- PUT global --------------------------------------------------------
  describe('PUT /v1/shares/smb/global', () => {
    it('202 and surgically updates only the changed key', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ workgroup: 'ANASDOM' }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.includes('\tworkgroup = ANASDOM'))
      // Only that value changed; the unknown directive and shares survive.
      assert.ok(written.includes('\tlog level = 1'))
      assert.ok(written.includes('[media]'))
      assert.equal(written.split('\n').length, SAMPLE_CONF.split('\n').length)
    })

    it('rejects without identity headers', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ workgroup: 'X' }),
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- GET detail --------------------------------------------------------
  describe('GET /v1/shares/smb/:name', () => {
    it('returns the share plus live connections from smbstatus', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/media' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbShareDetail }
      assert.equal(data.name, 'media')
      assert.deepEqual(data.connections, [{ user: 'media', machine: '10.0.0.50' }])
    })

    it('returns [] connections for a share with none', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/archive' })
      assert.equal(res.statusCode, 200)
      assert.deepEqual((res.json() as { data: SmbShareDetail }).data.connections, [])
    })

    it('404 for an unknown share', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/nope' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })
  })

  // --- POST create -------------------------------------------------------
  describe('POST /v1/shares/smb', () => {
    it('202, appends the stanza, and leaves prior content byte-identical', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'POST',
        url: '/v1/shares/smb',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'photos', path: '/tank/photos', comment: 'Photos' }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'smb.share.add')
      const job = await waitForJob(s, body.job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.startsWith(SAMPLE_CONF), 'existing content preserved verbatim')
      assert.ok(written.includes('[photos]'))
      assert.ok(written.includes('\tpath = /tank/photos'))
    })

    it('409 when the share already exists', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'POST',
        url: '/v1/shares/smb',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'media', path: '/tank/media' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('400 on an invalid share name', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'POST',
        url: '/v1/shares/smb',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'bad/name', path: '/tank/x' }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- PUT update --------------------------------------------------------
  describe('PUT /v1/shares/smb/:name', () => {
    it('202 and changes only the targeted key', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ readOnly: true }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.includes('\tread only = yes'))
      // media's other keys and the archive share are intact.
      assert.ok(written.includes('\tvalid users = media @smbusers'))
      assert.ok(written.includes('[archive]'))
    })

    it('404 for an unknown share', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/nope',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ readOnly: true }),
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- DELETE ------------------------------------------------------------
  describe('DELETE /v1/shares/smb/:name', () => {
    it('409 CONFIRMATION_REQUIRED with a code, warning about active connections', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/media', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      const warnings = res.json().error.warnings as string[]
      assert.ok(warnings.some(w => w.includes('active connection')))
    })

    it('proceeds to 202 and removes only the stanza when confirmed', async () => {
      const s = startServer()
      const first = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/archive', headers: IDENTITY_HEADERS })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      const res = await s.inject({
        method: 'DELETE',
        url: '/v1/shares/smb/archive',
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(!written.includes('[archive]'))
      // media + global untouched.
      assert.ok(written.includes('[media]'))
      assert.ok(written.includes('[global]'))
    })

    it('404 for an unknown share', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/nope', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
    })
  })
})
