import type { Job, JobAccepted, NfsExport } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mockFixtures } from '../../fixtures/loader.js'
import { createServer } from '../../server.js'
import { sharePathProbeArgs } from '../../services/share-path.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
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

    it('reports each export\'s path check through the executor: exists, missing, not answering (cr.35)', async () => {
      // The answers are the captured `timeout 2 stat -f` cases
      // (mounts/stat-f-exit-codes.txt); before cr.35 this was a statSync on
      // the daemon's event loop, which a dead hard NFS mount froze.
      const livePath = join(dir, 'live')
      const hungPath = '/mnt/anas-nfs/export'
      await writeFile(exportsPath, [
        `${livePath} 10.0.0.0/24(rw,sync)`,
        '/does/not/exist *(ro,sync)',
        `${hungPath} *(ro,sync)`,
        '',
      ].join('\n'))
      const mock = (server as unknown as { executor: MockExecutor }).executor
      mock.prependFixture({ command: '/usr/bin/timeout', args: sharePathProbeArgs(livePath), result: mockFixtures.statF('ext4 root (healthy local)') })
      mock.prependFixture({ command: '/usr/bin/timeout', args: sharePathProbeArgs('/does/not/exist'), result: mockFixtures.statF('nonexistent path') })
      mock.prependFixture({ command: '/usr/bin/timeout', args: sharePathProbeArgs(hungPath), result: mockFixtures.statF('nfs-server STOPPED; hard mount -> stat hangs -> timeout kills it') })
      const res = await server!.inject({ method: 'GET', url: '/v1/shares/nfs' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport[] }
      const at = (p: string): [unknown, unknown] => {
        const e = data.find(x => x.path === p)!
        return [e.pathState, e.pathExists]
      }
      assert.deepEqual(at(livePath), ['exists', true])
      assert.deepEqual(at('/does/not/exist'), ['missing', false])
      assert.deepEqual(at(hungPath), ['not-answering', undefined])
    })

    it('the detail carries the same check (a hung path is not-answering, never a guess)', async () => {
      const mock = (server as unknown as { executor: MockExecutor }).executor
      mock.prependFixture({ command: '/usr/bin/timeout', args: sharePathProbeArgs('/srv/nfs/media'), timesOut: { abandoned: true } })
      const res = await server!.inject({ method: 'GET', url: `/v1/shares/nfs/${encodeURIComponent('/srv/nfs/media')}` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport }
      assert.equal(data.pathState, 'not-answering')
      assert.equal(data.pathExists, undefined)
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

    // cr.36r: the path is canonicalised ONCE at the door (the lock key's own
    // normaliser), so the exists-gate, the PVE-territory claim, the lock and
    // the written line all see one spelling.
    it('the `/srv//nfs/media` spelling of an exported directory meets the 409 — the file keeps its bytes', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv//nfs/media', clients: [{ spec: '*', options: ['rw'] }] }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      // The refusal names the directory as the file spells it, not the raw body.
      assert.equal(res.json().error.message, `Export '/srv/nfs/media' already exists`)
      assert.equal(await readFile(exportsPath, 'utf8'), before, 'no second line for a directory already exported')
    })

    it('the written exports line carries the canonical spelling — `/srv//nfs/new/` lands as `/srv/nfs/new`', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv//nfs/new/', clients: [{ spec: '10.1.0.0/16', options: ['rw', 'sync'] }] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const after = await readFile(exportsPath, 'utf8')
      assert.ok(after.startsWith(before), 'existing lines preserved verbatim')
      assert.equal(after.slice(before.length), '/srv/nfs/new 10.1.0.0/16(rw,sync)\n')
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

    it('refuses a hostile client spec at the schema — a space would add a client (review H3b)', async () => {
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/x', clients: [{ spec: '10.0.0.0/24 rw', options: [] }] }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.ok(!(await readFile(exportsPath, 'utf8')).includes('/srv/nfs/x'))
    })

    it('a FAILED exportfs -ra rolls the file back byte-identically and fails the job (review H3b)', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const mock = (server! as unknown as { executor: MockExecutor }).executor
      const orig = mock.exec.bind(mock)
      let exportfsCalls = 0
      mock.exec = async (command: string, args: string[]) => {
        if (command === '/usr/sbin/exportfs') {
          exportfsCalls++
          // The pre-edit baseline reload is clean; the change is what fails.
          if (exportfsCalls === 1)
            return { stdout: '', stderr: '', exitCode: 0 }
          return { stdout: '', stderr: 'exportfs: bogus fs type', exitCode: 1 }
        }
        return orig(command, args)
      }
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/rollback', clients: [{ spec: '*', options: ['rw', 'sync'] }] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /exportfs/)
      // The write was applied and then rolled back — the file is the SAME bytes.
      assert.equal(await readFile(exportsPath, 'utf8'), before, 'the failed write must not survive')
      assert.ok(!(await readFile(exportsPath, 'utf8')).includes('/srv/nfs/rollback'))
      // The restored file is reloaded so the kernel's table matches it again.
      assert.equal(exportfsCalls, 3, 'baseline, the failing reload, and a reload of the restored file')
    })

    it('an export elsewhere that already fails the reload does not roll back a good change (node pass R3-D1)', async () => {
      const mock = (server! as unknown as { executor: MockExecutor }).executor
      const orig = mock.exec.bind(mock)
      const stale = 'exportfs: Failed to stat /testpool/share1: No such file or directory'
      mock.exec = async (command: string, args: string[]) => {
        if (command === '/usr/sbin/exportfs')
          return { stdout: '', stderr: `${stale}\n`, exitCode: 1 }
        return orig(command, args)
      }
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/shares/nfs',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '/srv/nfs/fine', clients: [{ spec: '*', options: ['rw', 'sync'] }] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.ok((await readFile(exportsPath, 'utf8')).includes('/srv/nfs/fine'), 'the change stays applied')
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

    it('refuses a URL path the export-path rule refuses, before any lookup (cr.13 review)', async () => {
      for (const bad of ['/srv/a"b', '/srv/a\\b', '/srv/a#b']) {
        const res = await server!.inject({
          method: 'PUT',
          url: `/v1/shares/nfs/${enc(bad)}`,
          headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
          payload: JSON.stringify({ clients: [{ spec: '*', options: ['rw'] }] }),
        })
        assert.equal(res.statusCode, 400, bad)
      }
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
  // A findmnt table that AGREES with that `zfs list` (#85): since the resolver
  // gates the dataset answer on the SERVING filesystem, the server's default
  // sample tree (no testpool mounts at all) would READ "no zfs serves
  // /testpool" and contradict the node this describe models. Wrapped, not
  // re-registered — the first exact fixture wins, and the server registers
  // its own `findmnt --json` before this describe runs.
  const TESTPOOL_MOUNT_TABLE = JSON.stringify({
    filesystems: [
      { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
      { target: '/testpool', source: 'testpool', fstype: 'zfs', options: 'rw' },
      { target: '/testpool/media', source: 'testpool/media', fstype: 'zfs', options: 'rw' },
    ],
  })

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
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/bin/findmnt' && args.join(' ') === '--json')
        return { stdout: TESTPOOL_MOUNT_TABLE, stderr: '', exitCode: 0 }
      return orig(command, args)
    }
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

  it('an export on an OWNED mountpoint is refused 409 PVE_MANAGED with the ownership reason', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/testpool', clients: [{ spec: '192.168.1.0/24', options: ['rw', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PVE_MANAGED')
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
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PVE_MANAGED')
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

// --- #85: the captured ZFS-root node at the create door ----------------------
//
// The SAME backstop on byte-identical captures of a ZFS-root node (ZFS-root
// stunt node, PVE 9.2.2, 2026-11-13): `rpool/ROOT/pve-1` is mounted at `/`,
// so before #85 the mountpoint-only resolution claimed the boot dataset for
// EVERY export path the `zfs list` did not cover more specifically — PVE's own
// ext4 dir storage at `/mnt/pve/virtssd` included — and refused the export
// 409 PVE_MANAGED with the wrong dataset in the sentence. `/root/onboot` must
// keep being refused for real.
describe('NFS export path vs the PVE footprint on the captured ZFS-root node (#85)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let prevCfg: string | undefined

  // The captured node's `zfs list -H -o name,mountpoint`, byte-identical.
  const ZFS_ROOT_LIST = 'rpool\t/rpool\nrpool/ROOT\t/rpool/ROOT\nrpool/ROOT/pve-1\t/\nrpool/data\t/rpool/data\nrpool/var-lib-vz\t/var/lib/vz\n'
  // The captured `storage.cfg`, minus its node-list line (node-specific, and
  // the storage parser does not read it).
  const CAPTURED_CFG = [
    'dir: local',
    '\tpath /var/lib/vz',
    '\tcontent import,iso,backup,vztmpl',
    '',
    'zfspool: local-zfs',
    '\tpool rpool/data',
    '\tcontent rootdir,images',
    '\tsparse 1',
    '',
    'dir: virtssd',
    '\tpath /mnt/pve/virtssd',
    '\tcontent images,backup,iso,snippets,vztmpl,rootdir',
    '\tis_mountpoint 1',
    '',
  ].join('\n')
  // The captured `findmnt --json` — the committed byte-identical fixture.
  const ZFS_ROOT_TABLE = readFileSync(new URL('../../fixtures/mounts/findmnt-zfs-root.json', import.meta.url), 'utf-8')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-nfs-zfsroot-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, CAPTURED_CFG, 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    await writeFile(join(dir, 'exports'), FIXTURE, 'utf8')
    process.env.ANAS_EXPORTS_PATH = join(dir, 'exports')
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: ZFS_ROOT_LIST, stderr: '', exitCode: 0 } })
    // The captured boot facts: the pool's bootfs IS the dataset mounted at `/`.
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'rpool\trpool/ROOT/pve-1\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: 'rpool/ROOT/pve-1\tzfs\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/exportfs', result: { stdout: '', stderr: '', exitCode: 0 } })
    // The captured mount table REPLACES the server's default sample tree
    // (wrapped, not re-registered — the first exact fixture wins).
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/bin/findmnt' && args.join(' ') === '--json')
        return { stdout: ZFS_ROOT_TABLE, stderr: '', exitCode: 0 }
      return orig(command, args)
    }
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

  it('an export on the captured ext4 dir storage is NOT refused PVE_MANAGED (#85)', async () => {
    // `/mnt/pve/virtssd` is ext4 in the captured table: no dataset serves it,
    // the footprint claim is silent (caveat-emptor), and the create reaches
    // the job like any other non-ZFS path. Pre-#85 this was a 409 PVE_MANAGED
    // naming `rpool/ROOT/pve-1` for a path that is not on ZFS at all.
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/mnt/pve/virtssd', clients: [{ spec: '*', options: ['ro', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok((await readFile(join(dir, 'exports'), 'utf8')).includes('/mnt/pve/virtssd '))
  })

  it('an export under the boot dataset is STILL refused 409 PVE_MANAGED naming the boot dataset (#85)', async () => {
    // `/root` has no mount of its own — the serving filesystem is the ZFS `/`,
    // so the gate answers "ZFS", the match resolves `rpool/ROOT/pve-1`, and
    // the boot facts make it PVE's system tree. The gate opens only what the
    // table PROVES non-ZFS; the true refusal stands exactly as strict.
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/shares/nfs',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/root/onboot', clients: [{ spec: '*', options: ['ro', 'sync'] }] }),
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'PVE_MANAGED')
    assert.match(res.json().error.message, /rpool\/ROOT\/pve-1/)
    // Nothing was appended to /etc/exports.
    assert.ok(!(await readFile(join(dir, 'exports'), 'utf8')).includes('/root/onboot '))
  })
})
