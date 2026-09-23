import type { Job, JobAccepted, NfsExport } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
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

// --- pvepool.1 review fixes: the share-path backstop -----------------------
//
// The SAME longest-prefix resolution + ownership ask the SMB create makes:
// an export whose path resolves onto a PVE-OWNED dataset refuses 400 with
// the ownership reason. A path on the sibling dataset's mountpoint, or on
// no ZFS dataset at all, is unaffected. The PUT cannot move the path (it is
// the URL identity), so create is the one door.
describe('NFS export path vs the PVE footprint (pvepool.1 review fixes)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevCfg: string | undefined

  const CLAIM = 'zfspool: local-zfs\n\tpool testpool\n\tcontent images,rootdir\n\n'
  const MOUNTPOINTS = 'testpool\t/testpool\ntestpool/media\t/testpool/media\n'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-nfs-pve-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, CLAIM, 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    await writeFile(join(dir, 'exports'), FIXTURE, 'utf8')
    process.env.ANAS_EXPORTS_PATH = join(dir, 'exports')
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: MOUNTPOINTS, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '/dev/sda1\text4\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/exportfs', result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (prevCfg === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = prevCfg
    delete process.env.ANAS_EXPORTS_PATH
    await rm(dir, { recursive: true, force: true })
  })

  it('an export on an OWNED mountpoint is refused 400 with the ownership reason', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/testpool', clients: [{ spec: '192.168.1.0/24', options: ['rw', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /'\/testpool'/)
    assert.match(res.json().error.message, /'testpool'/)
    assert.match(res.json().error.message, /local-zfs/)
    assert.match(res.json().error.message, /storage root/)
    // Nothing was appended to /etc/exports.
    assert.ok(!(await readFile(join(dir, 'exports'), 'utf8')).includes('/testpool '))
  })

  it('an export on the SIBLING dataset\'s mountpoint passes the backstop', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/testpool/media', clients: [{ spec: '*', options: ['ro', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  it('an export on a NON-ZFS path is untouched by the backstop', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/srv/elsewhere', clients: [{ spec: '*', options: ['ro', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  it('an export on a dir storage with an UNAVAILABLE mount table is refused against the dir path (review fix 5)', async () => {
    // A `dir` storage on a `legacy` dataset with no live mount, and the
    // findmnt table itself FAILS to read — whether the path sits on ZFS is
    // UNKNOWN, and missing facts may only tighten: the backstop's path rule
    // refuses the export against the storage's CONFIGURED path — the SAME
    // claim the SMB create refuses through (one sharePathClaim answerer for
    // both).
    await writeFile(join(dir, 'storage.cfg'), 'dir: dump\n\tpath /srv/dump\n\tcontent backup,iso\n', 'utf8')
    const mock = (server! as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/sbin/zfs' && args.join(' ') === 'list -H -o name,mountpoint')
        return { stdout: 'tank/dump\tlegacy\n', stderr: '', exitCode: 0 }
      if (command === '/usr/bin/findmnt' && args.join(' ') === '--json')
        return { stdout: '', stderr: 'findmnt: cannot read', exitCode: 1 }
      return orig(command, args)
    }
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/srv/dump', clients: [{ spec: '*', options: ['ro', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    // The path-rule sentence names the storage and its configured path.
    assert.match(res.json().error.message, /'\/srv\/dump'/)
    assert.match(res.json().error.message, /PVE storage 'dump' claims/)
    assert.match(res.json().error.message, /exports cannot serve PVE territory/)
    // Nothing was appended to /etc/exports.
    assert.ok(!(await readFile(join(dir, 'exports'), 'utf8')).includes('/srv/dump '))
  })

  it('an export on a dir-storage path findmnt READS as ext4 is ALLOWED (caveat-emptor ruling)', async () => {
    // The ruling (EPICS §2, 2026-09-22): the path rule claims only what a ZFS
    // filesystem serves. /var/lib/vz is PVE's `local` dir storage, but the
    // readable findmnt table answers ext4 for it — caveat emptor, the export
    // goes through.
    await writeFile(join(dir, 'storage.cfg'), 'dir: local\n\tpath /var/lib/vz\n\tcontent backup,iso\n', 'utf8')
    const mock = (server! as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/sbin/zfs' && args.join(' ') === 'list -H -o name,mountpoint')
        return { stdout: '', stderr: '', exitCode: 0 }
      if (command === '/usr/bin/findmnt' && args.join(' ') === '--json')
        return { stdout: JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }] }), stderr: '', exitCode: 0 }
      return orig(command, args)
    }
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/var/lib/vz/dump', clients: [{ spec: '*', options: ['ro', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok((await readFile(join(dir, 'exports'), 'utf8')).includes('/var/lib/vz/dump '))
  })
})
