import type { Job, MountDetail, MountSummary } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CreateMountRequest, UpdateMountRequest } from '@anas/shared'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { jobRoutes } from '../jobs.js'
import { mountsRoutes } from '../mounts.js'

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

async function waitForJob(server: { inject: FastifyInstance['inject'] }, id: string): Promise<Job> {
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
      // The edit dialog round-trips these — parsed from the fstab spec.
      assert.equal(data.server, '127.0.0.1')
      assert.equal(data.remotePath, '/srv/nfs/export1')
    })

    it('a CIFS create round-trips server/share + the saved username into detail', async () => {
      const mountpoint = join(dir, 'cifsmnt')
      const cres = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'cifs',
          server: 'nas.example.com',
          remotePath: 'media',
          mountpoint,
          persistent: true,
          options: { uid: 1002, gid: 1002, noatime: true },
          credentials: { username: 'smbuser', password: 's3cret' },
        }),
      })
      assert.equal(cres.statusCode, 202)
      const cjob = await waitForJob(server!, cres.json().job.id)
      assert.equal(cjob.status, 'completed', JSON.stringify(cjob.error))

      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(mountpoint)}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountDetail }
      assert.equal(data.type, 'cifs')
      assert.equal(data.server, 'nas.example.com')
      assert.equal(data.remotePath, 'media')
      assert.equal(data.configuredOptions?.cifs?.uid, 1002)
      assert.equal(data.configuredOptions?.cifs?.gid, 1002)
      assert.equal(data.configuredOptions?.common.noatime, true)
      // The secret is never returned, but the username is (for the edit dialog).
      assert.equal(data.credentials?.set, true)
      assert.equal(data.credentials?.username, 'smbuser')
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

    // Issue #27: persistence is edit-time IDENTITY. A body that still carries it
    // (an older UI) must be harmless — stripped at the schema, never a 400.
    it('ignores a `persistent` field in the update body', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc('/mnt/anas-nfs')}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ persistent: false, options: { ro: true } }) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      // Still persisted — the entry was rewritten, never dropped.
      assert.ok((await readFile(fstabPath, 'utf8')).includes('/mnt/anas-nfs'))
    })
  })

  describe('inline plaintext CIFS credentials — BUG-1 security + migration on save', () => {
    const PASSWORD = 'Xy#zzy!$'
    const INLINE_MP = '/chiapools/chiap2'
    const INLINE_LINE = `//10.0.0.114/chiap2 ${INLINE_MP} cifs ro,nofail,noatime,vers=3.1.1,cache=strict,username=ccebelenski,password=${PASSWORD},uid=1000,forceuid,gid=100 0 0\n`

    beforeEach(async () => {
      await writeFile(fstabPath, FSTAB_FIXTURE + INLINE_LINE)
    })

    it('GET never leaks the password; redacts fstabLine; surfaces creds + warning; parses past the `#`', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      // THE hard invariant: the plaintext password appears NOWHERE in the response body.
      assert.ok(!res.payload.includes(PASSWORD), 'password must be absent from the entire JSON')
      const { data } = res.json() as { data: MountDetail }
      assert.ok(data.fstabLine?.includes('password=*****'), 'fstabLine redacts the password')
      assert.ok(!data.fstabLine?.includes(PASSWORD))
      assert.ok(!data.configuredOptions?.passthrough.includes('password'))
      assert.ok(!data.configuredOptions?.passthrough.includes('username'))
      // uid/gid AFTER the `#`-bearing password survived (BUG-2 no longer truncates).
      assert.equal(data.configuredOptions?.cifs?.uid, 1000)
      assert.equal(data.configuredOptions?.cifs?.gid, 100)
      // Credentials reflect the inline set — presence + username, never the secret.
      assert.equal(data.credentials?.set, true)
      assert.equal(data.credentials?.username, 'ccebelenski')
      // Guide-don't-warn advisory present.
      assert.ok(data.warnings.some(w => w.toLowerCase().includes('inline')))
    })

    it('PUT migrates the inline secret to the 0600 creds file and strips it from fstab', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))

      const fstab = await readFile(fstabPath, 'utf8')
      const line = fstab.split('\n').find(l => l.includes(INLINE_MP))!
      assert.ok(line.includes('credentials='), 'fstab line now references a creds file')
      assert.ok(!line.includes('password='), 'no inline password remains')
      assert.ok(!line.includes('username='), 'no inline username remains')
      assert.ok(!line.includes(PASSWORD), 'plaintext gone from fstab')

      // The creds file holds the EXACT original password, including the `#`.
      const credsPath = join(dir, 'creds', 'chiapools-chiap2.cred')
      const creds = await readFile(credsPath, 'utf8')
      assert.ok(creds.includes(`password=${PASSWORD}`), 'exact special-char password migrated')
      assert.ok(creds.includes('username=ccebelenski'))
      assert.equal((await stat(credsPath)).mode & 0o777, 0o600)

      // A subsequent GET still never leaks the password.
      const g = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: IDENTITY_HEADERS })
      assert.ok(!g.payload.includes(PASSWORD))
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

// AHR pool persistence is hands-off in the Mounts feature: a pinned pool's fstab
// entry must be flagged ahrManaged and every Mounts mutation must refuse it, so
// unmount/delete/edit can never rip a Hybrid RAID pool's persistence out from
// under it (the headline regression).
describe('mount routes — AHR pool persistence is hands-off', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let fstabPath: string
  let mdadmConfPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mounts-ahr-'))
    fstabPath = join(dir, 'fstab')
    mdadmConfPath = join(dir, 'mdadm.conf')
    // A pinned pool `tank` at a CUSTOM mountpoint, plus a look-alike but
    // unpinned LVM mount `/dev/foo/foo-vol` that must NOT be flagged.
    await writeFile(fstabPath, [
      '/dev/tank/tank-vol /srv/tank-data btrfs nofail,subvol=@data 0 0',
      '/dev/foo/foo-vol /mnt/foo btrfs nofail 0 0',
      '',
    ].join('\n'))
    await writeFile(mdadmConfPath, 'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:bbbbbbbb:cccccccc:dddddddd\n')
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = STORAGE_CFG
    process.env.ANAS_MDADM_CONF = mdadmConfPath
    server = createServer({ mock: true, logger: false })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    delete process.env.ANAS_MDADM_CONF
    await rm(dir, { recursive: true, force: true })
  })

  it('flags the pinned pool ahrManaged (custom mountpoint) and leaves the look-alike alone', async () => {
    const res = await server!.inject({ method: 'GET', url: '/v1/mounts' })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: MountSummary[] }
    assert.equal(data.find(r => r.mountpoint === '/srv/tank-data')!.ahrManaged, true)
    assert.equal(data.find(r => r.mountpoint === '/mnt/foo')!.ahrManaged, false)
  })

  it('refuses DELETE / PUT / unmount on the pool with 400 naming the Hybrid RAID view', async () => {
    const calls = [
      { method: 'DELETE' as const, url: `/v1/mounts/${enc('/srv/tank-data')}`, payload: undefined },
      { method: 'PUT' as const, url: `/v1/mounts/${enc('/srv/tank-data')}`, payload: { options: { ro: true } } },
      { method: 'POST' as const, url: `/v1/mounts/${enc('/srv/tank-data')}/state`, payload: { action: 'unmount' } },
    ]
    for (const call of calls) {
      // Only set the JSON content-type when there is a body — Fastify rejects an
      // empty body under application/json before the handler runs.
      const headers = call.payload === undefined ? IDENTITY_HEADERS : { ...IDENTITY_HEADERS, 'content-type': 'application/json' }
      const res = await server!.inject({ method: call.method, url: call.url, headers, payload: call.payload })
      assert.equal(res.statusCode, 400, `${call.method} ${call.url}`)
      assert.match((res.json() as { error: { message: string } }).error.message, /Hybrid RAID/, `${call.method} ${call.url}`)
    }
    // The pool's fstab line is untouched — persistence was never at risk.
    assert.ok((await readFile(fstabPath, 'utf8')).includes('/dev/tank/tank-vol /srv/tank-data'))
  })

  it('does NOT refuse the unpinned look-alike on the AHR guard (its own remote-only guard applies)', async () => {
    const res = await server!.inject({ method: 'DELETE', url: `/v1/mounts/${enc('/mnt/foo')}`, headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 400)
    // Rejected as a LOCAL fs, NOT as AHR — proof the look-alike was not seized.
    assert.match((res.json() as { error: { message: string } }).error.message, /remote shares only/)
  })
})

// ============================================================================
// PUT /v1/mounts/:mountpoint — the edit flow's two live failures (issues #24, #25)
// ============================================================================
//
// These build their own app over a private MockExecutor (the busy-enrichment
// idiom) because both regressions are decided by the EXACT command sequence and
// by the kernel mount table changing — or refusing to change — mid-job, neither
// of which the shared dev-fixture executor can express.

const FINDMNT = '/usr/bin/findmnt'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const TIMEOUT = '/usr/bin/timeout'
const FUSER = '/usr/bin/fuser'
const SYSTEMCTL = '/usr/bin/systemctl'
const OK = { stdout: '', stderr: '', exitCode: 0 }

const CIFS_MP = '/mnt/edit-cifs'
const NFS_MP = '/mnt/edit-nfs'
const OLD_CREDS = 'username=smbuser\npassword=oldpass\n'

/** One `findmnt --json` mount table. */
function findmntJson(rows: Array<{ target: string, source: string, fstype: string, options: string }>): string {
  return JSON.stringify({ filesystems: rows })
}

/** The NFS test mount, live with the given options. */
function nfsTable(options: string): string {
  return findmntJson([{ target: NFS_MP, source: '10.0.0.9:/export', fstype: 'nfs4', options }])
}

interface EditHarness {
  app: FastifyInstance
  executor: MockExecutor
  dir: string
  fstabPath: string
  credsDir: string
}

/**
 * A mounts app over a private executor. `mountTables` is the SEQUENCE of
 * `findmnt --json` answers (the last repeats) — that is how a test scripts the
 * kernel mount table under the job.
 */
async function createEditServer(
  fstab: (credsDir: string) => string,
  mountTables: string[],
): Promise<EditHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-mount-edit-'))
  const fstabPath = join(dir, 'fstab')
  const credsDir = join(dir, 'creds')
  await writeFile(fstabPath, fstab(credsDir))

  const executor = new MockExecutor()
  executor.addFixture({ command: FINDMNT, args: ['--json'], results: mountTables.map(stdout => ({ stdout, stderr: '', exitCode: 0 })) })
  executor.addFixture({ command: SYSTEMCTL, args: ['daemon-reload'], result: OK })
  executor.addFixture({ command: MOUNT, result: OK })
  executor.addFixture({ command: UMOUNT, result: OK })

  const app = Fastify({ logger: false })
  const jobQueue = new JobQueue()
  await app.register(jobRoutes, { prefix: '/v1', jobQueue })
  await app.register(mountsRoutes, {
    prefix: '/v1',
    executor,
    jobQueue,
    confirmStore: new ConfirmStore(),
    fstabPath,
    credsDir,
    storagePath: join(dir, 'no-storage.cfg'),
  })
  return { app, executor, dir, fstabPath, credsDir }
}

/** Was this exact command+argv issued? */
function called(executor: MockExecutor, command: string, args: string[]): boolean {
  return executor.calls.some(c => c.command === command && c.args.length === args.length && c.args.every((a, i) => a === args[i]))
}

describe('PUT /v1/mounts — credentials are proven before anything is committed (issue #24)', () => {
  let h: EditHarness | undefined

  const cifsFstab = (credsDir: string): string =>
    `//10.0.0.9/media ${CIFS_MP} cifs credentials=${join(credsDir, 'mnt-edit-cifs.cred')},vers=3.1.1,nofail 0 0\n`

  beforeEach(async () => {
    h = await createEditServer(cifsFstab, [findmntJson([])])
    await mkdir(h.credsDir, { recursive: true, mode: 0o700 })
    await writeFile(join(h.credsDir, 'mnt-edit-cifs.cred'), OLD_CREDS, { mode: 0o600 })
  })

  afterEach(async () => {
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  async function putCredentials(password: string): Promise<Job> {
    const res = await h!.app.inject({
      method: 'PUT',
      url: `/v1/mounts/${enc(CIFS_MP)}`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ credentials: { username: 'smbuser', password }, options: { ro: true } }),
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(h!.app, (res.json() as { job: Job }).job.id)
  }

  it('a rejected password fails the job and leaves the creds file AND fstab untouched', async () => {
    // The probe mount answers EACCES — the live `mount error(13)` shape.
    h!.executor.addFixture({ command: TIMEOUT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const before = await readFile(h!.fstabPath, 'utf8')

    const job = await putCredentials('wrong')
    assert.equal(job.status, 'failed')
    const msg = job.error!.message
    assert.match(msg, /username or password/, msg)
    assert.match(msg, /mount error\(13\)/, msg)

    // THE regression: nothing was committed on the way to the failure.
    assert.equal(await readFile(join(h!.credsDir, 'mnt-edit-cifs.cred'), 'utf8'), OLD_CREDS)
    assert.equal(await readFile(h!.fstabPath, 'utf8'), before)
    // …and the candidate secret is not left lying in the creds dir.
    assert.deepEqual(await readdir(h!.credsDir), ['mnt-edit-cifs.cred'])
    // The probe authenticated from the CANDIDATE file, never the live one.
    const probe = h!.executor.calls.find(c => c.command === TIMEOUT)!
    assert.match(probe.args.join(' '), /credentials=.*\.mnt-edit-cifs\.cred\.validating/)
    // No fstab rewrite means no reload and no remount attempt either.
    assert.ok(!called(h!.executor, SYSTEMCTL, ['daemon-reload']))
    assert.ok(!called(h!.executor, UMOUNT, [CIFS_MP]))
  })

  it('a proven password is committed, the fstab rewritten and the mount applied', async () => {
    h!.executor.addFixture({ command: TIMEOUT, result: OK }) // the probe mount succeeds

    const job = await putCredentials('n3wp@ss')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const credsPath = join(h!.credsDir, 'mnt-edit-cifs.cred')
    const creds = await readFile(credsPath, 'utf8')
    assert.ok(creds.includes('password=n3wp@ss'), creds)
    assert.equal((await stat(credsPath)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(h!.credsDir), ['mnt-edit-cifs.cred'])

    const line = (await readFile(h!.fstabPath, 'utf8')).split('\n').find(l => l.includes(CIFS_MP))!
    assert.ok(line.includes(`credentials=${credsPath}`), line)
    assert.ok(line.split(/\s+/)[3].split(',').includes('ro'), line)
    assert.ok(called(h!.executor, MOUNT, ['--', CIFS_MP]))
  })
})

describe('PUT /v1/mounts — a completed edit means the new options are LIVE (issue #25)', () => {
  let h: EditHarness | undefined

  const nfsFstab = (): string => `10.0.0.9:/export ${NFS_MP} nfs4 defaults,nofail 0 0\n`
  const RW = 'rw,relatime,vers=4.2,hard,proto=tcp,addr=10.0.0.9'
  const RO = 'ro,relatime,vers=4.2,hard,proto=tcp,addr=10.0.0.9'

  afterEach(async () => {
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  /** A busy mountpoint: the unmount is refused, exactly as util-linux reports it. */
  function refuseUnmount(executor: MockExecutor): void {
    executor.addFixture({ command: UMOUNT, args: [NFS_MP], result: {
      stdout: '',
      stderr: `umount: ${NFS_MP}: target is busy.`,
      exitCode: 32,
    } })
  }

  async function putReadOnly(): Promise<Job> {
    const res = await h!.app.inject({
      method: 'PUT',
      url: `/v1/mounts/${enc(NFS_MP)}`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ options: { ro: true } }),
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(h!.app, (res.json() as { job: Job }).job.id)
  }

  it('a refused unmount falls back to `mount -o remount` and succeeds once the options land', async () => {
    // Mount table: still rw after the refused unmount, ro after the remount.
    h = await createEditServer(nfsFstab, [nfsTable(RW), nfsTable(RO)])
    refuseUnmount(h.executor)

    const job = await putReadOnly()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(called(h.executor, MOUNT, ['-o', 'remount', '--', NFS_MP]))
    // A busy target is NEVER mounted over — `mount <mp>` reports success on an
    // already-mounted target and would have hidden the whole failure.
    assert.ok(!called(h.executor, MOUNT, ['--', NFS_MP]))
  })

  it('options that never land fail the job and name the holders', async () => {
    // The mount table keeps answering rw — the remount changed nothing.
    h = await createEditServer(nfsFstab, [nfsTable(RW)])
    refuseUnmount(h.executor)
    // fuser names THIS test process as the holder → /proc/<pid>/comm is real.
    h.executor.addFixture({ command: FUSER, args: ['-m', NFS_MP], result: { stdout: `${process.pid}\n`, stderr: '', exitCode: 0 } })

    const job = await putReadOnly()
    assert.equal(job.status, 'failed')
    const msg = job.error!.message
    assert.match(msg, /still mounted with previous options/, msg)
    assert.match(msg, /target is busy/, msg)
    assert.match(msg, /held open by:/, msg)
    assert.ok(msg.includes(`(${process.pid})`), msg)
    // The fstab carries the intent (the next mount is ro) — only the LIVE mount
    // could not be changed, and the job says exactly that.
    assert.ok((await readFile(h.fstabPath, 'utf8')).includes('ro,'))
  })

  it('an entry that is not mounted at all is simply mounted from fstab', async () => {
    h = await createEditServer(nfsFstab, [findmntJson([])])
    const job = await putReadOnly()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(called(h.executor, MOUNT, ['--', NFS_MP]))
    assert.ok(!called(h.executor, MOUNT, ['-o', 'remount', '--', NFS_MP]))
  })
})

describe('UpdateMountRequest — persistence is edit-time identity (issue #27)', () => {
  it('strips `persistent` from an update body; create still owns it', () => {
    const parsed = UpdateMountRequest.parse({ persistent: false, options: { ro: true } })
    assert.ok(!('persistent' in parsed))
    assert.equal(parsed.options?.ro, true)
    assert.equal(CreateMountRequest.parse({ type: 'nfs', mountpoint: '/mnt/x', persistent: false }).persistent, false)
  })

  it('does not typecheck a `persistent` update body', () => {
    // @ts-expect-error persistence is identity on an edit — not an updatable field.
    const body: UpdateMountRequest = { persistent: true }
    assert.deepEqual(body, { persistent: true })
  })
})
