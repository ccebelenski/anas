import type { Job, MountDetail, MountSummary } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/mounts')
const FSTAB_FIXTURE = readFileSync(join(fixturesDir, 'fstab-anas-managed'), 'utf-8')
const STORAGE_CFG = join(fixturesDir, 'storage.cfg')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

function enc(path: string): string {
  return encodeURIComponent(path)
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('mount routes (Epic 18)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let fstabPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mounts-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, FSTAB_FIXTURE)
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = STORAGE_CFG
    server = createServer({ mock: true, logger: false })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    await rm(dir, { recursive: true, force: true })
  })

  describe('GET /v1/mounts', () => {
    it('returns the merged inventory with PVE tagging and health', async () => {
      const res = await server!.inject({ method: 'GET', url: '/v1/mounts' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountSummary[] }
      const nfs = data.find(r => r.mountpoint === '/mnt/anas-nfs')!
      assert.equal(nfs.persistent, true)
      assert.equal(nfs.remote, true)
      assert.equal(nfs.state, 'ok') // probed via the mock timeout stat -f
      const pve = data.find(r => r.mountpoint === '/mnt/pve/anastest-nfs')!
      assert.equal(pve.pveManaged, true)
      assert.equal(pve.pveStorage, 'anastest-nfs')
    })
  })

  describe('GET /v1/mounts/:mountpoint (URL-encoded)', () => {
    it('returns detail with fstabLine + configuredOptions for a %2F-encoded path', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc('/mnt/anas-nfs')}` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountDetail }
      assert.equal(data.mountpoint, '/mnt/anas-nfs')
      assert.ok(data.fstabLine?.includes('/mnt/anas-nfs'))
      assert.equal(data.health.state, 'ok')
      assert.ok(data.configuredOptions?.common.nofail)
    })

    it('404 for an unknown mountpoint', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc('/mnt/nope')}` })
      assert.equal(res.statusCode, 404)
    })
  })

  describe('POST /v1/mounts', () => {
    it('creates an NFS mount: 202, appends one fstab line, mounts now', async () => {
      const mountpoint = join(dir, 'newmnt')
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: true }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const after = await readFile(fstabPath, 'utf8')
      assert.ok(after.includes(mountpoint))
      assert.ok(after.startsWith(before.trimEnd())) // original lines preserved
    })

    it('non-empty mountpoint → 409 confirm, then succeeds with the code', async () => {
      const mountpoint = join(dir, 'shadowed')
      await mkdir(mountpoint)
      await writeFile(join(mountpoint, 'existing.txt'), 'data')
      const payload = JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: true })

      const res1 = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload })
      assert.equal(res1.statusCode, 409)
      const code = res1.headers['x-anas-confirm-code'] as string
      assert.ok(code)

      const res2 = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', 'x-anas-confirm': code }, payload })
      assert.equal(res2.statusCode, 202)
      const job = await waitForJob(server!, res2.json().job.id)
      assert.equal(job.status, 'completed')
    })

    it('rejects a PVE-territory mountpoint', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/x', mountpoint: '/mnt/pve/foo' }) })
      assert.equal(res.statusCode, 400)
    })

    it('requires credentials for CIFS', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'share', mountpoint: join(dir, 'c') }) })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('PUT /v1/mounts/:mountpoint', () => {
    it('rewrites options surgically (202)', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc('/mnt/anas-nfs')}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const fstab = await readFile(fstabPath, 'utf8')
      const line = fstab.split('\n').find(l => l.includes('/mnt/anas-nfs'))!
      assert.ok(line.includes('ro'))
    })

    it('rejects a PVE-owned mount', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc('/mnt/pve/anastest-nfs')}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('POST /v1/mounts/:mountpoint/state — disable / enable', () => {
    it('disable comments the line with the marker; enable restores it byte-identically', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const origLine = before.split('\n').find(l => l.includes('/mnt/anas-nfs'))!

      const dres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc('/mnt/anas-nfs')}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'disable' }) })
      assert.equal(dres.statusCode, 202)
      const djob = await waitForJob(server!, dres.json().job.id)
      assert.equal(djob.status, 'completed', JSON.stringify(djob.error))
      const disabled = await readFile(fstabPath, 'utf8')
      assert.ok(disabled.split('\n').includes(`#ANAS ${origLine}`))

      // Inventory now shows it disabled.
      const inv = await server!.inject({ method: 'GET', url: '/v1/mounts' })
      const row = (inv.json() as { data: MountSummary[] }).data.find(r => r.mountpoint === '/mnt/anas-nfs')!
      assert.equal(row.disabled, true)
      assert.equal(row.state, 'disabled')

      const eres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc('/mnt/anas-nfs')}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'enable' }) })
      assert.equal(eres.statusCode, 202)
      const ejob = await waitForJob(server!, eres.json().job.id)
      assert.equal(ejob.status, 'completed')
      assert.equal(await readFile(fstabPath, 'utf8'), before) // exact restore
    })

    it('disable on a non-persisted mount → 400', async () => {
      const res = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc('/mnttest')}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'disable' }) })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('DELETE /v1/mounts/:mountpoint', () => {
    it('unmounts + drops the fstab entry (202)', async () => {
      const res = await server!.inject({ method: 'DELETE', url: `/v1/mounts/${enc('/mnt/anas-nfs')}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const fstab = await readFile(fstabPath, 'utf8')
      assert.ok(!fstab.includes('/mnt/anas-nfs'))
    })

    it('rejects a PVE-owned mount', async () => {
      const res = await server!.inject({ method: 'DELETE', url: `/v1/mounts/${enc('/mnt/pve/anastest-nfs')}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('remote-only guard (local storage is ZFS territory)', () => {
    it('rejects state/PUT/DELETE on a local fstab entry with 400', async () => {
      await writeFile(fstabPath, `${FSTAB_FIXTURE}UUID=abcd-1234 /data ext4 defaults,nofail 0 2\n`)
      const calls = [
        { method: 'POST' as const, url: `/v1/mounts/${enc('/data')}/state`, payload: { action: 'unmount' } },
        { method: 'PUT' as const, url: `/v1/mounts/${enc('/data')}`, payload: {} },
        { method: 'DELETE' as const, url: `/v1/mounts/${enc('/data')}`, payload: undefined },
      ]
      for (const call of calls) {
        const res = await server!.inject({ method: call.method, url: call.url, headers: IDENTITY_HEADERS, payload: call.payload })
        assert.equal(res.statusCode, 400, `${call.method} ${call.url}`)
        assert.match((res.json() as { error: { message: string } }).error.message, /remote shares only/)
      }
    })

    it('rejects a create body with a non-remote type at the schema boundary', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: IDENTITY_HEADERS, payload: { type: 'local', source: '/dev/sdb1', mountpoint: '/data' } })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('POST /v1/mounts/test', () => {
    it('diagnoses an unresolvable host as unreachable at the DNS stage', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts/test', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'nfs', server: 'no-such-host.invalid', remotePath: '/x' }) })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: { verdict: string, stage: string, dnsResolved: boolean } }
      assert.equal(data.verdict, 'unreachable')
      assert.equal(data.stage, 'dns')
      assert.equal(data.dnsResolved, false)
    })
  })
})
