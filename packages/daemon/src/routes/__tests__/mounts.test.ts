import type { Job, MountDetail, MountSummary } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { MountTestStages } from '../../services/mounts.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CreateMountRequest, DeleteMountQuery, MountRequestOptions, UpdateMountRequest } from '@anas/shared'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer, PATH_PARAM_MAX } from '../../server.js'
import { credsFileName, DISABLED_PLACEHOLDER_DETAIL } from '../../services/mounts.js'
import { jobRoutes } from '../jobs.js'
import { mountsRoutes } from '../mounts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/mounts')
const FSTAB_FIXTURE = readFileSync(join(fixturesDir, 'fstab-anas-managed'), 'utf-8')
const STORAGE_CFG = join(fixturesDir, 'storage.cfg')

/**
 * cr.52r D3: a daemon-run mount(8) now opens the mountpoint's final directory
 * O_PATH BEFORE the syscall, so a mount the test EXPECTS to succeed needs a
 * REAL directory. The fixture fstab's fixed `/mnt/…` mountpoints are mapped to
 * a real, writable base under the per-test tmpdir (`mountBase`, set by the
 * shared beforeEach); `/mnt/…` itself is not writable to a non-root test.
 */
let mountBase = ''
/** Map a fixture `/mnt/<x>` mountpoint to `<mountBase>/<x>` (a real directory). */
const MP = (mp: string): string => (mp.startsWith('/mnt/') ? join(mountBase, mp.replace(/^\/mnt\//, '')) : mp)
/** The fixture fstab with its `/mnt/…` mountpoints mapped into the tmpdir. */
function mappedFixture(): string {
  return FSTAB_FIXTURE
    .replaceAll('/mnt/anas-nfs', MP('/mnt/anas-nfs'))
    .replaceAll('/mnt/anas-cifs', MP('/mnt/anas-cifs'))
}

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
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

/**
 * Story cr.39: a Remove ALWAYS confirms (it deletes the line, the credentials
 * file and, opted in, the directory). Challenge, then resend with the code.
 */
async function confirmedDelete(app: { inject: FastifyInstance['inject'] }, url: string): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  const first = await app.inject({ method: 'DELETE', url, headers: IDENTITY_HEADERS })
  assert.equal(first.statusCode, 409, first.payload)
  assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
  return app.inject({ method: 'DELETE', url, headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
}

describe('mount routes (Epic 18)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let fstabPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mounts-'))
    mountBase = join(dir, 'mnt')
    // Real directories for every mapped mountpoint a mocked mount runs through
    // (cr.52r D3's fd-pin opens the mountpoint before the argv).
    await mkdir(MP('/mnt/anas-nfs'), { recursive: true })
    await mkdir(MP('/mnt/anas-cifs'), { recursive: true })
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, mappedFixture())
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = STORAGE_CFG
    server = createServer({ mock: true, logger: false })
    // The dev mock's findmnt reports the RAW fixture paths; the fstab now maps
    // them into the tmpdir (cr.52r D3), so the inventory JOIN needs the same
    // mapping on the live-mount side — prepended ahead of the seeded fixture.
    const findmntFull = readFileSync(join(fixturesDir, 'findmnt-full.json'), 'utf8')
      .replaceAll('/mnt/anas-nfs', MP('/mnt/anas-nfs'))
      .replaceAll('/mnt/anas-cifs', MP('/mnt/anas-cifs'))
    ;(server as unknown as { executor: MockExecutor }).executor.prependFixture({
      command: '/usr/bin/findmnt',
      args: ['--json'],
      result: { stdout: findmntFull, stderr: '', exitCode: 0 },
    })
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
      const nfs = data.find(r => r.mountpoint === MP('/mnt/anas-nfs'))!
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
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountDetail }
      assert.equal(data.mountpoint, MP('/mnt/anas-nfs'))
      assert.ok(data.fstabLine?.includes(MP('/mnt/anas-nfs')))
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

    it('cr.64b2: the non-empty confirm is bound to the line it writes — a replay for another share/server is 409 IDENTITY_MISMATCH', async () => {
      const mountpoint = join(dir, 'shadowed-id')
      await mkdir(mountpoint)
      await writeFile(join(mountpoint, 'existing.txt'), 'data')
      const base = JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: true })

      const first = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: base })
      assert.equal(first.statusCode, 409, first.body)
      const code = first.headers['x-anas-confirm-code'] as string

      // Same mountpoint, another export — the fstab line the code was minted
      // for (source + target + fstype) no longer is the one this request writes.
      const resend = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', 'x-anas-confirm': code },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export2', mountpoint, persistent: true }),
      })
      assert.equal(resend.statusCode, 409, resend.body)
      const err = resend.json() as { error: { code: string, message: string } }
      assert.equal(err.error.code, 'IDENTITY_MISMATCH', resend.body)
      assert.match(err.error.message, /is not the one that was confirmed/)
      assert.ok(resend.headers['x-anas-confirm-code'], 'a fresh code is offered for the real mount the operator means')
    })

    it('cr.64b2: the non-empty confirm signs the whole request — a changed body field is 409 CONFIRM_SCOPE_CHANGED naming it', async () => {
      const mountpoint = join(dir, 'shadowed-scope')
      await mkdir(mountpoint)
      await writeFile(join(mountpoint, 'existing.txt'), 'data')
      const first = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: true }),
      })
      assert.equal(first.statusCode, 409, first.body)
      const code = first.headers['x-anas-confirm-code'] as string

      // Same line, a different persistence flag — the bound identity is
      // unchanged, so the FIELD is named (the code is not portable to a
      // different request, cr.32 §5.2).
      const resend = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', 'x-anas-confirm': code },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: false }),
      })
      assert.equal(resend.statusCode, 409, resend.body)
      const err = resend.json() as { error: { code: string, changed: string[], message: string } }
      assert.equal(err.error.code, 'CONFIRM_SCOPE_CHANGED', resend.body)
      assert.deepEqual(err.error.changed, ['persistent'])
    })

    it('cr.64b2: the happy path resend is byte-unchanged — the mount argv stays the direct mount through /proc/self/fd/3 (cr.52r D3)', async () => {
      const mountpoint = join(dir, 'shadowed-argv')
      await mkdir(mountpoint)
      await writeFile(join(mountpoint, 'existing.txt'), 'data')
      const payload = JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: true })

      const first = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload })
      assert.equal(first.statusCode, 409, first.body)
      const code = first.headers['x-anas-confirm-code'] as string

      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', 'x-anas-confirm': code }, payload })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const mock = (server as unknown as { executor: { calls: Array<{ command: string, args: string[], fdPaths?: (string | null)[] }> } }).executor
      const mountCall = mock.calls.find(c => c.command === '/usr/bin/mount')
      assert.ok(mountCall, 'the mountNow path ran a mount argv')
      assert.equal(mountCall!.args.at(-1), '/proc/self/fd/3', 'the direct-mount argv is byte-identical to cr.52r\'s pin')
      assert.equal(mountCall!.fdPaths?.[0], mountpoint, 'the inherited fd resolves to the opened mountpoint directory')
    })

    it('rejects a PVE-territory mountpoint (cr.52r doc ruling: the ONE 409, PVE sentence)', async () => {
      // `/mnt/pve/*` answers the shared refusal — 409 reason system-mount-target
      // with the PVE-territory sentence (this door's old pre-check answered 400).
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/x', mountpoint: '/mnt/pve/foo' }) })
      assert.equal(res.statusCode, 409)
      const body = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(body.error.code, 'CONFLICT')
      assert.equal(body.error.reason, 'system-mount-target')
      assert.match(body.error.message, /PVE territory/)
    })

    it('a credential-less CIFS create is a GUEST mount: `guest` in fstab, no credentials reference, no creds file', async () => {
      const mountpoint = join(dir, 'guestmnt')
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'share', mountpoint, persistent: true }) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(mountpoint))!
      const tokens = line.trim().split(/\s+/)[3].split(',')
      assert.ok(tokens.includes('guest'), line)
      assert.ok(!tokens.some(tk => tk.startsWith('credentials=')), line)
      // No creds file was written for a guest mount.
      assert.deepEqual(await readdir(join(dir, 'creds')).catch(() => []), [])
    })

    it('a half-filled credentials block is refused with the FIELD named', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'share', mountpoint: join(dir, 'halfcreds'), credentials: { username: 'u' } }) })
      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /^Invalid create mount request: credentials\.password — /)
    })

    it('normalises the typed target: //host + /share land in fstab as //host/share', async () => {
      const mountpoint = join(dir, 'normmnt')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'cifs',
          server: '//127.0.0.1',
          remotePath: '/pictures',
          mountpoint,
          persistent: true,
          credentials: { username: 'smbuser', password: 's3cret' },
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(mountpoint))!
      // The canonical spec — never the typed `//127.0.0.1` + `/pictures` join.
      assert.ok(line.startsWith('//127.0.0.1/pictures'), line)
      // A credentials mount references its creds file and carries NO guest token.
      const tokens = line.trim().split(/\s+/)[3].split(',')
      assert.ok(tokens.some(tk => tk.startsWith('credentials=')), line)
      assert.ok(!tokens.includes('guest'), line)
    })

    it('refuses an empty CIFS share with the guiding 400, before any job', async () => {
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'cifs',
          server: '127.0.0.1/',
          remotePath: '',
          mountpoint: join(dir, 'noshare'),
          credentials: { username: 'smbuser', password: 's3cret' },
        }),
      })
      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /share name is required/)
    })

    // cr.2 (review C2): `extraOptions` is a strict option-TOKEN list, so a
    // newline can never forge an extra fstab line and a credential token can
    // never sneak onto one. The request schema refuses both with a 400 — a
    // job is never submitted and fstab is untouched.
    it('newline in extraOptions → 400, fstab untouched', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint: join(dir, 'newline-inj'), extraOptions: 'nofail\nnofail' }),
      })
      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /extraOptions/)
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('a credential token in extraOptions → 400 (secrets go in the creds fields)', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'share', mountpoint: join(dir, 'cred-inj'), extraOptions: 'credentials=/etc/foo', credentials: { username: 'smbuser', password: 's3cret' } }),
      })
      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.match(error.message, /carries a credential/)
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('cr.60 (M7): the shared list refuses `password2=`, `dom=` and `workgroup=` in extraOptions at the route too', async () => {
      const before = await readFile(fstabPath, 'utf8')
      for (const extraOptions of ['vers=3.0,password2=r0tate', 'dom=CORP', 'WORKGROUP=CORP']) {
        const res = await server!.inject({
          method: 'POST',
          url: '/v1/mounts',
          headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
          payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'share', mountpoint: join(dir, 'cred-inj2'), extraOptions, credentials: { username: 'smbuser', password: 's3cret' } }),
        })
        assert.equal(res.statusCode, 400, extraOptions)
        assert.match((res.json() as { error: { message: string } }).error.message, /carries a credential/, extraOptions)
      }
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('accepted extraOptions are written verbatim as tokens', async () => {
      const mountpoint = join(dir, 'tokmnt')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'nfs',
          server: '127.0.0.1',
          remotePath: '/srv/nfs/export1',
          mountpoint,
          persistent: true,
          mountNow: false,
          extraOptions: 'vers=4.2,x-systemd.requires=/opt',
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(mountpoint))!
      // Written VERBATIM — the passthrough token lands on the line and the file
      // has no forged second line. (`vers=4.2` is a STRUCTURED tier, so it is
      // written from the NFS tier, not from passthrough.)
      assert.ok(line.includes('vers=4.2') && line.includes('x-systemd.requires=/opt'), line)
      assert.ok(!line.includes('\n'))
      // The read side round-trips the passthrough back exactly.
      const detail = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(mountpoint)}`, headers: IDENTITY_HEADERS })
      assert.equal(detail.statusCode, 200)
      const { data } = detail.json() as { data: MountDetail }
      assert.equal(data.configuredOptions?.passthrough, 'x-systemd.requires=/opt')
    })

    // cr.18 (review M7.2): the "already in fstab" refusal used to run only for
    // persistent creates, and the credentials file is named by the MOUNTPOINT —
    // so a non-persistent CIFS mount over a mountpoint an existing fstab line
    // owns silently overwrote that entry's secrets. The check is unconditional
    // now, and it fires at REQUEST time: no job, no creds touched.
    it('a non-persistent CIFS mount over a mountpoint already in fstab is refused; the existing creds file is byte-identical', async () => {
      // The fixture's own CIFS entry: /mnt/anas-cifs, credentials in a file
      // named exactly the way a new request for this mountpoint would name it.
      const mountpoint = MP('/mnt/anas-cifs')
      const credsDir = join(dir, 'creds')
      await mkdir(credsDir, { recursive: true })
      const credFile = join(credsDir, credsFileName(mountpoint))
      const OLD_CREDS_BEFORE = 'username=olduser\npassword=old-s3cret\n'
      await writeFile(credFile, OLD_CREDS_BEFORE, { mode: 0o600 })
      const fstabBefore = await readFile(fstabPath, 'utf8')

      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'cifs',
          server: 'nas.example.com',
          remotePath: 'media',
          mountpoint,
          persistent: false,
          mountNow: true,
          credentials: { username: 'newuser', password: 'new-s3cret' },
        }),
      })
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /already in \/etc\/fstab/)
      // Byte-identical: the refused request never wrote near the file.
      assert.equal(await readFile(credFile, 'utf8'), OLD_CREDS_BEFORE)
      assert.equal(await readFile(fstabPath, 'utf8'), fstabBefore)
    })

    // cr.18 (review M7.3) + cr.52 (review H1): a mount OVER a system path (or
    // an ancestor of one) hides the OS. ONE refusal shared with every door that
    // sets a mountpoint (mountTargetRefusal), 409 CONFLICT — the job is never
    // submitted.
    it('mount over a system path → 409 (equal, at-depth, and normalized shapes)', async () => {
      for (const mountpoint of [
        '/',
        '/etc',
        '/usr',
        '/srv',
        '/var',
        '/boot',
        '/tmp',
        '/root',
        '/dev', // equal to a list entry
        '/usr/local',
        '/etc/anas',
        '/lib64/systemd',
        '/run/samba',
        '/proc/fake', // inside a protected subtree
        '/etc/',
        '/usr//local',
        '/usr/./local',
        '/usr/local/', // normalized to refused
      ]) {
        const res = await server!.inject({
          method: 'POST',
          url: '/v1/mounts',
          headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
          payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: false, mountNow: false }),
        })
        assert.equal(res.statusCode, 409, `${mountpoint} → ${res.statusCode}: ${res.body}`)
        const { error } = res.json() as { error: { code: string, reason: string, message: string } }
        assert.equal(error.code, 'CONFLICT')
        assert.equal(error.reason, 'system-mount-target')
        assert.match(error.message, /system path/, mountpoint)
      }
      // None of them reached fstab.
      assert.equal(await readFile(fstabPath, 'utf8'), mappedFixture())
    })

    it('a mountpoint under a non-protected root passes the system check', async () => {
      // Deep under /tmp (the harness dir IS under /tmp — every passing test
      // here proves /tmp/... stays allowed); a directory named like a system
      // root but living under it must not be refused on a name collision.
      const mountpoint = join(dir, 'srv')
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint, persistent: false, mountNow: false }),
      })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    })
  })

  describe('PUT /v1/mounts/:mountpoint', () => {
    it('rewrites options surgically (202)', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const fstab = await readFile(fstabPath, 'utf8')
      const line = fstab.split('\n').find(l => l.includes(MP('/mnt/anas-nfs')))!
      assert.ok(line.includes('ro'))
    })

    // cr.2 (review C2): the WRITE side re-checks a REQUEST-supplied option list,
    // but the READ side stays lenient — a hand-written token that would NEVER
    // pass the token schema (it needs an fstab escape for a space) parses, and
    // an edit keeps it byte-identical rather than refusing the file's own line.
    it('an edit keeps a hand-written passthrough that would fail the token schema', async () => {
      await mkdir(MP('/mnt/hand'), { recursive: true })
      await writeFile(fstabPath, `${mappedFixture()}10.0.0.7:/hand ${MP('/mnt/hand')} nfs4 nofail,x-systemd.requires=/opt/My\\040Share 0 0\n`)
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/mounts/${enc(MP('/mnt/hand'))}`,
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ options: { noatime: true } }),
      })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(MP('/mnt/hand')))!
      assert.ok(line.includes('x-systemd.requires=/opt/My\\040Share'), line)
      assert.ok(line.includes('noatime'), line)
    })

    it('rejects a PVE-owned mount', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc('/mnt/pve/anastest-nfs')}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 400)
    })

    // Issue #27: persistence is edit-time IDENTITY. A body that still carries it
    // (an older UI) must be harmless — stripped at the schema, never a 400.
    it('ignores a `persistent` field in the update body', async () => {
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ persistent: false, options: { ro: true } }) })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      // Still persisted — the entry was rewritten, never dropped.
      assert.ok((await readFile(fstabPath, 'utf8')).includes(MP('/mnt/anas-nfs')))
    })
  })

  // ==========================================================================
  // THE CLEAR CONTRACT (issue #34)
  //
  // A blanked option field sends `null`, and `null` REMOVES the option from the
  // entry. The class guard below walks EVERY key of MountRequestOptions: set it,
  // clear it, and prove the rendered fstab line gained then lost exactly that
  // token. An option added later without clear semantics fails here — that is
  // the point of iterating the schema rather than a hand-listed subset.
  // ==========================================================================
  describe('PUT /v1/mounts — every option can be CLEARED (class guard, #34)', () => {
    // Real dirs for the fd-pinned remounts these edits run (cr.52r D3). MP maps
    // AFTER the shared beforeEach has set `mountBase` — so the values are per-test.
    let NFS_GUARD = ''
    let CIFS_GUARD = ''

    beforeEach(async () => {
      NFS_GUARD = MP('/mnt/guard-nfs')
      CIFS_GUARD = MP('/mnt/guard-cifs')
      await mkdir(NFS_GUARD, { recursive: true })
      await mkdir(CIFS_GUARD, { recursive: true })
      await writeFile(fstabPath, `${mappedFixture()
      }10.0.0.9:/export ${NFS_GUARD} nfs4 nofail,_netdev 0 0\n`
      + `//10.0.0.9/media ${CIFS_GUARD} cifs credentials=/etc/anas/creds/guard.cred,nofail,_netdev 0 0\n`)
    })

    /** The option TOKENS of a mountpoint's fstab line (field 4), exact — never a substring. */
    async function tokensOf(mountpoint: string): Promise<string[]> {
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(` ${mountpoint} `))
      assert.ok(line, `no fstab line for ${mountpoint}`)
      return line.trim().split(/\s+/)[3].split(',')
    }

    /** PUT one option body and wait for the job to complete. */
    async function put(mountpoint: string, body: object): Promise<void> {
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/mounts/${enc(mountpoint)}`,
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    }

    /**
     * One option's proof: which fstype's entry carries it, a value that renders
     * a token, the value that must make the token go away (`null` for every
     * value-bearing option; `false` for a plain flag, which renders nothing when
     * off), and the exact token the value produces.
     */
    interface OptionProof {
      on: 'nfs' | 'cifs'
      set: unknown
      clear: unknown
      token: string
    }

    const PROOFS: Record<keyof MountRequestOptions, OptionProof> = {
      // common
      ro: { on: 'nfs', set: true, clear: false, token: 'ro' },
      noatime: { on: 'nfs', set: true, clear: false, token: 'noatime' },
      nosuid: { on: 'nfs', set: true, clear: false, token: 'nosuid' },
      nodev: { on: 'nfs', set: true, clear: false, token: 'nodev' },
      noexec: { on: 'nfs', set: true, clear: false, token: 'noexec' },
      netdev: { on: 'nfs', set: true, clear: false, token: '_netdev' },
      idleTimeout: { on: 'nfs', set: 30, clear: null, token: 'x-systemd.idle-timeout=30' },
      // nfs tier
      vers: { on: 'nfs', set: '4.1', clear: null, token: 'vers=4.1' },
      hard: { on: 'nfs', set: true, clear: null, token: 'hard' },
      timeo: { on: 'nfs', set: 150, clear: null, token: 'timeo=150' },
      retrans: { on: 'nfs', set: 4, clear: null, token: 'retrans=4' },
      rsize: { on: 'nfs', set: 32768, clear: null, token: 'rsize=32768' },
      wsize: { on: 'nfs', set: 32768, clear: null, token: 'wsize=32768' },
      proto: { on: 'nfs', set: 'udp', clear: null, token: 'proto=udp' },
      noac: { on: 'nfs', set: true, clear: false, token: 'noac' },
      nconnect: { on: 'nfs', set: 4, clear: null, token: 'nconnect=4' },
      bg: { on: 'nfs', set: true, clear: false, token: 'bg' },
      lookupcache: { on: 'nfs', set: 'none', clear: null, token: 'lookupcache=none' },
      actimeo: { on: 'nfs', set: 30, clear: null, token: 'actimeo=30' },
      // `sec=` is the one union field (NFS and CIFS flavours share it); krb5 is
      // in both vocabularies, so one proof covers the shared boundary.
      sec: { on: 'nfs', set: 'krb5', clear: null, token: 'sec=krb5' },
      // cifs tier
      domain: { on: 'cifs', set: 'WORKGROUP', clear: null, token: 'domain=WORKGROUP' },
      uid: { on: 'cifs', set: 1002, clear: null, token: 'uid=1002' },
      gid: { on: 'cifs', set: 1003, clear: null, token: 'gid=1003' },
      fileMode: { on: 'cifs', set: '0640', clear: null, token: 'file_mode=0640' },
      dirMode: { on: 'cifs', set: '0750', clear: null, token: 'dir_mode=0750' },
      cache: { on: 'cifs', set: 'loose', clear: null, token: 'cache=loose' },
      mfsymlinks: { on: 'cifs', set: true, clear: false, token: 'mfsymlinks' },
      forceuid: { on: 'cifs', set: true, clear: false, token: 'forceuid' },
      forcegid: { on: 'cifs', set: true, clear: false, token: 'forcegid' },
      noserverino: { on: 'cifs', set: true, clear: false, token: 'noserverino' },
      nobrl: { on: 'cifs', set: true, clear: false, token: 'nobrl' },
      iocharset: { on: 'cifs', set: 'utf8', clear: null, token: 'iocharset=utf8' },
    }

    it('covers every MountRequestOptions key (a new option must declare how it CLEARS)', () => {
      assert.deepEqual(
        Object.keys(MountRequestOptions.shape).sort(),
        Object.keys(PROOFS).sort(),
        'a request option was added or renamed without a set/clear proof — give it clear semantics (null) and list it here',
      )
    })

    for (const [key, proof] of Object.entries(PROOFS)) {
      it(`${key}: sets '${proof.token}', and clearing it drops the token`, async () => {
        const mp = proof.on === 'nfs' ? NFS_GUARD : CIFS_GUARD

        await put(mp, { options: { [key]: proof.set } })
        assert.ok((await tokensOf(mp)).includes(proof.token), `expected '${proof.token}' after setting ${key}`)

        await put(mp, { options: { [key]: proof.clear } })
        assert.ok(!(await tokensOf(mp)).includes(proof.token), `'${proof.token}' survived clearing ${key}`)
      })
    }

    it('an omitted option is KEPT — only null clears (the three cases stay distinct)', async () => {
      await put(NFS_GUARD, { options: { timeo: 150, retrans: 4 } })
      await put(NFS_GUARD, { options: { retrans: null } }) // timeo omitted
      const tokens = await tokensOf(NFS_GUARD)
      assert.ok(tokens.includes('timeo=150'), 'an omitted option must survive the edit')
      assert.ok(!tokens.includes('retrans=4'))
    })

    it('a blanked Additional options field clears the stored passthrough', async () => {
      await put(NFS_GUARD, { extraOptions: 'x-anas-note=keepme,local_lock=none' })
      assert.ok((await tokensOf(NFS_GUARD)).includes('x-anas-note=keepme'))

      await put(NFS_GUARD, { extraOptions: '' })
      const tokens = await tokensOf(NFS_GUARD)
      assert.ok(!tokens.includes('x-anas-note=keepme'))
      assert.ok(!tokens.includes('local_lock=none'))
    })

    it('unchecking Automount takes its idle timeout with it', async () => {
      await put(NFS_GUARD, { automount: true, options: { idleTimeout: 60 } })
      let tokens = await tokensOf(NFS_GUARD)
      assert.ok(tokens.includes('x-systemd.automount'))
      assert.ok(tokens.includes('x-systemd.idle-timeout=60'))

      await put(NFS_GUARD, { automount: false })
      tokens = await tokensOf(NFS_GUARD)
      assert.ok(!tokens.includes('x-systemd.automount'))
      assert.ok(!tokens.some(tk => tk.startsWith('x-systemd.idle-timeout')), 'an idle timeout must not outlive the automount')
    })
  })

  // ==========================================================================
  // An UNTOUCHED edit changes nothing (#43 item 3, the silent-default class)
  //
  // The dialog pre-fills from the entry EXACTLY — a field the entry has no
  // value for shows blank — and every blank field is sent as null. So opening
  // an entry and pressing Save must rewrite the line byte-for-byte. Before the
  // fix, field-config defaults the operator never chose (vers=4.2 / 3.1.1,
  // file_mode=0644, dir_mode=0755, idle-timeout=60) rode the save into entries
  // that never had them.
  // ==========================================================================
  describe('PUT /v1/mounts — an untouched save round-trips the line byte-identically', () => {
    let RT_NFS = ''
    let RT_CIFS = ''

    beforeEach(async () => {
      // MP maps after the shared beforeEach sets `mountBase` (cr.52r D3: these
      // real dirs are what the fd-pinned remount of an untouched save opens).
      RT_NFS = MP('/mnt/rt-nfs')
      RT_CIFS = MP('/mnt/rt-cifs')
      await mkdir(RT_NFS, { recursive: true })
      await mkdir(RT_CIFS, { recursive: true })
      // Deliberately LEAN lines: no vers, no hard/soft, no modes, no idle timeout.
      const lines = [
        `10.0.0.9:/export ${RT_NFS} nfs4 nofail,_netdev 0 0`,
        `//10.0.0.9/media ${RT_CIFS} cifs credentials=/etc/anas/creds/rt.cred,nosuid,nodev,nofail,_netdev 0 0`,
      ]
      await writeFile(fstabPath, `${mappedFixture() + lines.join('\n')}\n`)
    })

    function lineOf(fstab: string, mountpoint: string): string {
      return fstab.split('\n').find(l => l.includes(` ${mountpoint} `))!
    }

    /** A value the entry does not carry pre-fills BLANK, and a blank field is sent as null. */
    function orNull<T>(v: T | undefined): T | null {
      return v === undefined ? null : v
    }

    /**
     * The body the dialog sends when an operator opens this entry and saves it
     * untouched — the daemon-side model of the fixed pre-fill + submit contract
     * (every option present: its stored value, or null where the entry has none).
     */
    function bodyFromPrefill(detail: MountDetail): UpdateMountRequest {
      const co = detail.configuredOptions!
      const c = co.common
      const options: MountRequestOptions = {
        ro: c.readOnly,
        noatime: c.noatime,
        nosuid: c.nosuid,
        nodev: c.nodev,
        noexec: c.noexec,
        netdev: c.netdev,
        idleTimeout: c.automount ? orNull(c.automountIdleTimeout) : null,
      }
      if (detail.type === 'nfs') {
        const n = co.nfs ?? {}
        Object.assign(options, {
          vers: orNull(n.vers),
          hard: orNull(n.hard),
          timeo: orNull(n.timeo),
          retrans: orNull(n.retrans),
          rsize: orNull(n.rsize),
          wsize: orNull(n.wsize),
          proto: orNull(n.proto),
          sec: orNull(n.sec),
          nconnect: orNull(n.nconnect),
          actimeo: orNull(n.actimeo),
          lookupcache: orNull(n.lookupcache),
          noac: n.noac === true,
          bg: n.bg === true,
        })
      }
      else {
        const f = co.cifs ?? {}
        Object.assign(options, {
          vers: orNull(f.vers),
          cache: orNull(f.cache),
          domain: orNull(f.domain),
          uid: orNull(f.uid),
          gid: orNull(f.gid),
          fileMode: orNull(f.fileMode),
          dirMode: orNull(f.dirMode),
          sec: orNull(f.sec),
          rsize: orNull(f.rsize),
          wsize: orNull(f.wsize),
          actimeo: orNull(f.actimeo),
          iocharset: orNull(f.iocharset),
          forceuid: f.forceuid === true,
          forcegid: f.forcegid === true,
          mfsymlinks: f.mfsymlinks === true,
          noserverino: f.noserverino === true,
          nobrl: f.nobrl === true,
        })
      }
      return { automount: c.automount, options, extraOptions: co.passthrough }
    }

    for (const which of ['nfs', 'cifs'] as const) {
      // RT_NFS / RT_CIFS are resolved per-test (the shared beforeEach maps
      // them), so the mountpoint is read at RUN time — never at describe load.
      it(`${which === 'nfs' ? 'nfs' : 'cifs'} round-trip: parse → pre-fill → save leaves the line untouched`, async () => {
        const mountpoint = which === 'nfs' ? RT_NFS : RT_CIFS
        const before = lineOf(await readFile(fstabPath, 'utf8'), mountpoint)

        const detail = (await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(mountpoint)}`, headers: IDENTITY_HEADERS })).json() as { data: MountDetail }
        const res = await server!.inject({
          method: 'PUT',
          url: `/v1/mounts/${enc(mountpoint)}`,
          headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
          payload: JSON.stringify(bodyFromPrefill(detail.data)),
        })
        assert.equal(res.statusCode, 202, res.payload)
        const job = await waitForJob(server!, res.json().job.id)
        assert.equal(job.status, 'completed', JSON.stringify(job.error))

        const after = lineOf(await readFile(fstabPath, 'utf8'), mountpoint)
        assert.equal(after, before)
        // Named explicitly: these are the defaults that used to leak in.
        for (const ghost of ['vers=', 'file_mode=', 'dir_mode=', 'x-systemd.idle-timeout='])
          assert.ok(!after.includes(ghost), `an unshown default (${ghost}) was written onto an entry that never had it`)
      })
    }
  })

  describe('inline plaintext CIFS credentials — BUG-1 security + migration on save', () => {
    const PASSWORD = 'Xy#zzy!$'
    // A REAL directory under the tmpdir so the fd-pinned remount of the save
    // can open it (cr.52r D3). Resolved per-test (the shared beforeEach set
    // `mountBase` after this describe body evaluated).
    let INLINE_MP = ''
    let INLINE_LINE = ''

    beforeEach(async () => {
      INLINE_MP = join(mountBase, 'chiapools/chiap2')
      await mkdir(INLINE_MP, { recursive: true })
      const inlineLine = `//10.0.0.114/chiap2 ${INLINE_MP} cifs ro,nofail,noatime,vers=3.1.1,cache=strict,username=ccebelenski,password=${PASSWORD},uid=1000,forceuid,gid=100 0 0\n`
      INLINE_LINE = inlineLine
      await writeFile(fstabPath, mappedFixture() + inlineLine)
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
      // ident.4 (d): the migrated secret lands under the HASHED name.
      const credsPath = join(dir, 'creds', credsFileName(INLINE_MP))
      const creds = await readFile(credsPath, 'utf8')
      assert.ok(creds.includes(`password=${PASSWORD}`), 'exact special-char password migrated')
      assert.ok(creds.includes('username=ccebelenski'))
      assert.equal((await stat(credsPath)).mode & 0o777, 0o600)

      // A subsequent GET still never leaks the password.
      const g = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: IDENTITY_HEADERS })
      assert.ok(!g.payload.includes(PASSWORD))
    })

    // cr.60 (review M7): every spelling of the ONE shared credential-key list,
    // in any case, over the same captured BUG-1 line — `pass=` and `user=`
    // (mount.cifs(8) synonyms), upper case, `password2=`, and the secret on a
    // line of another fstype (`smb3`). The plaintext appears NOWHERE in the
    // GET body — not in `fstabLine`, not in `configuredOptions.passthrough`.
    // The line is a transform of INLINE_LINE, which is built per test (cr.52r
    // D3 made the mountpoint a real directory under the per-test tmpdir).
    const SPELLINGS: Array<{ name: string, line: (base: string) => string, secret: string, redacted: string }> = [
      { name: 'user= / pass= (the review probe)', line: b => b.replace('username=', 'user=').replace('password=', 'pass='), secret: PASSWORD, redacted: 'pass=*****' },
      { name: 'USERNAME= / PASSWORD= (upper case)', line: b => b.replace('username=', 'USERNAME=').replace('password=', 'PASSWORD='), secret: PASSWORD, redacted: 'PASSWORD=*****' },
      { name: 'password2= (the rotation password)', line: b => b.replace(',uid=1000', ',password2=R0tate#2,uid=1000'), secret: 'R0tate#2', redacted: 'password2=*****' },
      { name: 'password= on an smb3 line', line: b => b.replace(' cifs ', ' smb3 '), secret: PASSWORD, redacted: 'password=*****' },
    ]
    for (const s of SPELLINGS) {
      it(`cr.60: GET never returns the secret in plain text — ${s.name}`, async () => {
        await writeFile(fstabPath, mappedFixture() + s.line(INLINE_LINE))
        const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: IDENTITY_HEADERS })
        assert.equal(res.statusCode, 200, res.payload)
        assert.ok(!res.payload.includes(s.secret), `the secret appears nowhere in the body: ${res.payload}`)
        const { data } = res.json() as { data: MountDetail }
        assert.ok(data.fstabLine?.includes(s.redacted), data.fstabLine)
        // No secret key rides the passthrough (a username is metadata: on a line
        // ANAS does not read as CIFS it stays there).
        assert.ok(!/pass/i.test(data.configuredOptions?.passthrough ?? ''), data.configuredOptions?.passthrough)
      })
    }

    it('cr.60: `user=` is the username — the credentials section shows it, never the password', async () => {
      await writeFile(fstabPath, mappedFixture() + SPELLINGS[0].line(INLINE_LINE))
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: IDENTITY_HEADERS })
      const { data } = res.json() as { data: MountDetail }
      assert.equal(data.credentials?.set, true)
      assert.equal(data.credentials?.username, 'ccebelenski')
    })

    it('cr.60: a save migrates `pass=` like `password=`, and writes `password2=` back unchanged', async () => {
      await writeFile(fstabPath, FSTAB_FIXTURE + SPELLINGS[2].line(INLINE_LINE).replace('username=', 'user=').replace('password=', 'pass='))
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(INLINE_MP)}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(INLINE_MP))!
      assert.ok(line.includes('credentials='), line)
      assert.ok(!line.includes(`pass=${PASSWORD}`) && !line.includes('user='), line)
      assert.ok(line.includes('password2=R0tate#2'), `the rotation password stays on the line: ${line}`)
      const creds = await readFile(join(dir, 'creds', credsFileName(INLINE_MP)), 'utf8')
      assert.ok(creds.includes(`password=${PASSWORD}`), creds)
      assert.ok(creds.includes('username=ccebelenski'), creds)
    })

    // cr.60r (the review's DEFECT): a hand-written CIFS line with a username
    // and NO password. There is nothing to migrate, and `guest` is a LIE —
    // the save used to drop bob and write `guest`, silently turning the mount
    // anonymous. The username rides the rewritten line instead.
    // cr.52r D3: the save re-mounts through a directory the daemon opens, so
    // the mountpoints are REAL directories under the per-test tmpdir (MP maps
    // after the shared beforeEach has set `mountBase`).
    const userOnlyMp = (): string => MP('/mnt/q1i')
    const userOnlyLine = (): string => `//h/s ${userOnlyMp()} cifs user=bob,vers=3.0 0 0\n`
    beforeEach(async () => {
      await mkdir(MP('/mnt/q1i'), { recursive: true })
      await mkdir(MP('/mnt/q1g'), { recursive: true })
    })

    it('cr.60r DEFECT: PUT of a username-only line keeps `user=bob` and never writes `guest`', async () => {
      await writeFile(fstabPath, FSTAB_FIXTURE + userOnlyLine())
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(userOnlyMp())}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))

      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(userOnlyMp()))!
      assert.ok(line.includes('user=bob'), `the username must survive the save: ${line}`)
      assert.ok(!line.includes('guest'), `the line must not become a guest mount: ${line}`)
      assert.ok(!line.includes('credentials='), `no creds file exists to name: ${line}`)
      // And no creds file was created for a line with no password.
      const meta = await stat(join(dir, 'creds', credsFileName(userOnlyMp()))).catch(() => null)
      assert.equal(meta, null, 'a username-only save writes no credentials file')
    })

    it('cr.60r item 1b: PUT of a `username=bob` line keeps the LONG spelling — the save never normalizes the operator\'s token', async () => {
      await writeFile(fstabPath, `${FSTAB_FIXTURE}//h/s ${userOnlyMp()} cifs username=bob,vers=3.0 0 0\n`)
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(userOnlyMp())}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(userOnlyMp()))!
      assert.ok(line.includes('username=bob'), `the operator's spelling must survive the save: ${line}`)
      assert.ok(!line.includes('user=bob'), `never normalized to the short alias: ${line}`)
      assert.ok(!line.includes('guest'), line)
    })

    it('cr.60r: PUT with NEW credentials on a username-only line drops the old inline username — the rotated file names the account, the line carries no stale `user=bob`', async () => {
      await writeFile(fstabPath, FSTAB_FIXTURE + userOnlyLine())
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(userOnlyMp())}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ credentials: { username: 'alice', password: 'pw' } }) })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(userOnlyMp()))!
      assert.ok(line.includes('credentials='), `the rotated file is the auth: ${line}`)
      assert.ok(!/(?:^|,)user(?:name)?=/i.test(line.split(/\s+/)[3]), `no stale username token beside the rotated file: ${line}`)
      assert.ok(!line.includes('guest'), line)
      assert.match(await readFile(join(dir, 'creds', credsFileName(userOnlyMp())), 'utf8'), /^username=alice$/m)
    })

    it('cr.60r: the detail of a username-only line shows the username, without a migration advisory', async () => {
      await writeFile(fstabPath, FSTAB_FIXTURE + userOnlyLine())
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(userOnlyMp())}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200, res.payload)
      const { data } = res.json() as { data: MountDetail }
      assert.equal(data.credentials?.set, true)
      assert.equal(data.credentials?.username, 'bob')
      // Nothing migrates (no password), so the "saving migrates them" hint
      // must not stand — and no secret rides any field.
      assert.ok(!data.warnings.some(w => w.includes('migrates')), JSON.stringify(data.warnings))
    })

    // cr.60r (possible 2): the review's probe line `g` — the secret carries an
    // fstab octal escape (`\054` = `,`); the creds file must hold the REAL
    // character, and the rewritten line must name the file.
    it('cr.60r: a `\\054`-escaped secret migrates DECODED to the creds file', async () => {
      await writeFile(fstabPath, `${FSTAB_FIXTURE}//h/s ${MP('/mnt/q1g')} cifs user=bob,pass=wo\\054rds,vers=3.0 0 0\n`)
      const res = await server!.inject({ method: 'PUT', url: `/v1/mounts/${enc(MP('/mnt/q1g'))}`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ options: { ro: true } }) })
      assert.equal(res.statusCode, 202, res.payload)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const creds = await readFile(join(dir, 'creds', credsFileName(MP('/mnt/q1g'))), 'utf8')
      assert.ok(creds.includes('password=wo,rds'), `the escape must decode into the creds file: ${creds}`)
      assert.ok(!creds.includes('\\054'), creds)
      assert.ok(creds.includes('username=bob'), creds)
      const line = (await readFile(fstabPath, 'utf8')).split('\n').find(l => l.includes(MP('/mnt/q1g')))!
      assert.ok(line.includes('credentials='), line)
      assert.ok(!line.includes('pass='), line)
    })
  })

  describe('POST /v1/mounts/:mountpoint/state — disable / enable (cr.6 option form)', () => {
    it('disable writes noauto + x-anas.disabled; enable restores the file byte-identically', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const origLine = before.split('\n').find(l => l.includes(MP('/mnt/anas-nfs')))!

      const dres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'disable' }) })
      assert.equal(dres.statusCode, 202)
      const djob = await waitForJob(server!, dres.json().job.id)
      assert.equal(djob.status, 'completed', JSON.stringify(djob.error))

      // The line is rewritten in the OPTION form — never a marker comment.
      const disabled = await readFile(fstabPath, 'utf8')
      const dLine = disabled.split('\n').find(l => l.includes(MP('/mnt/anas-nfs')))!
      assert.ok(!dLine.startsWith('#'), dLine)
      // Disable appends both tokens after the options column (byte-surgical —
      // the columns and spacing survive).
      assert.equal(dLine, origLine.replace('nofail', 'nofail,noauto,x-anas.disabled'))

      // Inventory now shows it disabled.
      const inv = await server!.inject({ method: 'GET', url: '/v1/mounts' })
      const row = (inv.json() as { data: MountSummary[] }).data.find(r => r.mountpoint === MP('/mnt/anas-nfs'))!
      assert.equal(row.disabled, true)
      assert.equal(row.state, 'disabled')

      const eres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'enable' }) })
      assert.equal(eres.statusCode, 202)
      const ejob = await waitForJob(server!, eres.json().job.id)
      assert.equal(ejob.status, 'completed')
      assert.equal(await readFile(fstabPath, 'utf8'), before) // exact restore
    })

    it('mount is refused on a NEW-FORM disabled entry (400: enable it first)', async () => {
      const dres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'disable' }) })
      assert.equal(dres.statusCode, 202)
      await waitForJob(server!, dres.json().job.id)
      const mres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'mount' }) })
      assert.equal(mres.statusCode, 400)
      assert.match(mres.json().error.message, /disabled — enable it first/)
    })

    it('a hand-written noauto,x-anas.disabled line reads disabled in the inventory, state disabled', async () => {
      const withDisabled = mappedFixture().replace(
        `127.0.0.1:/srv/nfs/export1  ${MP('/mnt/anas-nfs')}  nfs4  defaults,nofail  0  0`,
        `127.0.0.1:/srv/nfs/export1  ${MP('/mnt/anas-nfs')}  nfs4  defaults,nofail,noauto,x-anas.disabled  0  0`,
      )
      await writeFile(fstabPath, withDisabled)
      const inv = await server!.inject({ method: 'GET', url: '/v1/mounts' })
      const row = (inv.json() as { data: MountSummary[] }).data.find(r => r.mountpoint === MP('/mnt/anas-nfs'))!
      assert.equal(row.disabled, true)
      assert.equal(row.state, 'disabled')
      assert.equal(row.mounted, true) // the mount table still has it — state reads disabled regardless
      // And the mount verb is refused by the enclosed entry — not by the mock.
      const mres = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'mount' }) })
      assert.equal(mres.statusCode, 400)
      // The DETAIL health reads disabled too — even though the mount table
      // still has the entry, the fstab disable wins (never armed/unmounted).
      const det = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}`, headers: IDENTITY_HEADERS })
      const detail = det.json() as { data: MountDetail }
      assert.equal(detail.data.health.state, 'disabled')
    })

    it('disable on a non-persisted mount → 400', async () => {
      const res = await server!.inject({ method: 'POST', url: `/v1/mounts/${enc('/mnttest')}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'disable' }) })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('DELETE /v1/mounts/:mountpoint', () => {
    it('unmounts + drops the fstab entry (202)', async () => {
      const res = await confirmedDelete(server!, `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}`)
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const fstab = await readFile(fstabPath, 'utf8')
      assert.ok(!fstab.includes(MP('/mnt/anas-nfs')))
    })

    it('rejects a PVE-owned mount', async () => {
      const res = await server!.inject({ method: 'DELETE', url: `/v1/mounts/${enc('/mnt/pve/anastest-nfs')}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 400)
    })

    // --- the mountpoint directory (18.5 refinement) ---
    //
    // A plain umount leaves the directory behind. The delete now takes an
    // OPT-IN `?removeMountpointDir=true` that rmdirs it — empty only, never
    // recursive — and a directory that will not go is a warning on a COMPLETED
    // job, never a failure.

    /** Create a persisted NFS mount at `mountpoint` (fstab entry + directory). */
    async function createNfsMountAt(mountpoint: string): Promise<void> {
      const res = await server!.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export9', mountpoint }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server!, res.json().job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    }

    /** DELETE the mount, optionally with the flag, and wait for its job. */
    async function deleteMount(mountpoint: string, query = ''): Promise<Job> {
      const res = await confirmedDelete(server!, `/v1/mounts/${enc(mountpoint)}${query}`)
      assert.equal(res.statusCode, 202)
      return waitForJob(server!, res.json().job.id)
    }

    it('?removeMountpointDir=true also removes the now-empty mountpoint directory', async () => {
      const mp = join(dir, 'tidied')
      await createNfsMountAt(mp)
      const job = await deleteMount(mp, '?removeMountpointDir=true')
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal((job.result as { warnings?: string[] }).warnings, undefined)
      await assert.rejects(stat(mp), 'the mountpoint directory is gone')
    })

    it('a NON-EMPTY directory is left in place: the delete still succeeds, carrying a warning', async () => {
      const mp = join(dir, 'not-empty')
      await createNfsMountAt(mp)
      await writeFile(join(mp, 'local-data.txt'), 'left by something else\n')
      const job = await deleteMount(mp, '?removeMountpointDir=1')
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const warnings = (job.result as { warnings?: string[] }).warnings ?? []
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /not empty/)
      // The fstab entry still went — the leftover directory failed nothing.
      assert.ok(!(await readFile(fstabPath, 'utf8')).includes(mp))
      assert.deepEqual(await readdir(mp), ['local-data.txt'])
    })

    it('without the flag the directory is left exactly as before (wire-compatible default)', async () => {
      const mp = join(dir, 'left-behind')
      await createNfsMountAt(mp)
      const job = await deleteMount(mp)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal((job.result as { warnings?: string[] }).warnings, undefined)
      assert.ok((await stat(mp)).isDirectory(), 'the empty directory survives an unflagged delete')
    })

    it('rejects a flag value that is neither true nor false at the schema boundary', async () => {
      const res = await server!.inject({ method: 'DELETE', url: `/v1/mounts/${enc(MP('/mnt/anas-nfs'))}?removeMountpointDir=maybe`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 400)
      assert.match((res.json() as { error: { message: string } }).error.message, /delete mount query/)
    })
  })

  describe('remote-only guard (not an ANAS-managed filesystem)', () => {
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
        assert.match((res.json() as { error: { message: string } }).error.message, /not an ANAS-managed filesystem/)
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

    it('a dirty typed host is normalised BEFORE the DNS stage (the detail quotes the clean host)', async () => {
      // The reproduced failure said "Could not resolve host '//10.0.0.212'".
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts/test', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'cifs', server: '//no-such-host.invalid', remotePath: 'share' }) })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: { verdict: string, stage: string, detail?: string } }
      assert.equal(data.verdict, 'unreachable')
      assert.equal(data.stage, 'dns')
      assert.equal(data.detail, `Could not resolve host 'no-such-host.invalid'`)
    })

    it('refuses an empty CIFS share with the guiding 400, before any stage runs', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts/test', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1/', remotePath: '' }) })
      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /share name is required/)
    })

    it('refuses an unusable server (only slashes) with the guiding 400', async () => {
      const res = await server!.inject({ method: 'POST', url: '/v1/mounts/test', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'cifs', server: '///', remotePath: 'share' }) })
      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /server is required/)
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
    assert.match((res.json() as { error: { message: string } }).error.message, /not an ANAS-managed filesystem/)
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

// cr.52r D3: the edit-harness suites' mountpoints must be REAL directories for
// the fd-pinned remounts (the daemon opens the mountpoint before the argv), so
// they resolve against the harness's tmpdir — never the OS's unwritable /mnt.
let editBase = ''
const CIFS_MP = (): string => join(editBase, 'edit-cifs')
const NFS_MP = (): string => join(editBase, 'edit-nfs')
const OLD_CREDS = 'username=smbuser\npassword=oldpass\n'

/** One `findmnt --json` mount table. */
function findmntJson(rows: Array<{ target: string, source: string, fstype: string, options: string }>): string {
  return JSON.stringify({ filesystems: rows })
}

/** The NFS test mount, live with the given options. */
function nfsTable(options: string): string {
  return findmntJson([{ target: NFS_MP(), source: '10.0.0.9:/export', fstype: 'nfs4', options }])
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
 * kernel mount table under the job. `mountTestStages` is the /test network
 * seam (DNS/TCP overrides) — a test host has no share server on 2049/445.
 */
async function createEditServer(
  fstab: (credsDir: string) => string,
  mountTables: string[],
  mountTestStages?: MountTestStages,
): Promise<EditHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-mount-edit-'))
  // cr.52r D3: real mountpoint dirs for the fd-pinned mounts these suites run.
  editBase = dir
  await mkdir(join(dir, 'edit-nfs'), { recursive: true })
  await mkdir(join(dir, 'edit-cifs'), { recursive: true })
  const fstabPath = join(dir, 'fstab')
  const credsDir = join(dir, 'creds')
  await writeFile(fstabPath, fstab(credsDir))

  // cr.52r D3: the harness's mount-TABLE fixtures are built with `NFS_MP()`
  // / `CIFS_MP()` at their test bodies' start — BEFORE this function set
  // `editBase` — so their targets carry a STALE or relative base (the prior
  // harness's dir, or bare `edit-nfs` on first run). Re-point every row's
  // target to THIS harness's directory, or the live-match gates (`foreignGate`,
  // `readEffectiveOptions`) would never see the rows and the ident.4 (e) /
  // issue #25 suites would pass a "nothing mounted" table the code then qa.
  const retargeted = mountTables.map((table) => {
    if (!table.includes('edit-nfs') && !table.includes('edit-cifs'))
      return table
    try {
      const data = JSON.parse(table) as { filesystems?: Array<{ target?: string }> }
      if (!Array.isArray(data.filesystems))
        return table
      for (const fs of data.filesystems) {
        const basename = fs.target?.split('/').pop()
        if (basename === 'edit-nfs' || basename === 'edit-cifs')
          fs.target = join(dir, basename)
      }
      return JSON.stringify(data)
    }
    catch {
      return table // not a JSON table this helper built — hand it through untouched
    }
  })

  const executor = new MockExecutor()
  executor.addFixture({ command: FINDMNT, args: ['--json'], results: retargeted.map(stdout => ({ stdout, stderr: '', exitCode: 0 })) })
  executor.addFixture({ command: SYSTEMCTL, args: ['daemon-reload'], result: OK })
  executor.addFixture({ command: MOUNT, result: OK })
  executor.addFixture({ command: UMOUNT, result: OK })
  // The busy gate's holder listing on an idle mount: lsof answers nothing
  // holding it (exit 1, empty stdout — the dev mock's answer). Without it the
  // mock's command-not-found reads as "no lsof and no fuser" (nf.2/D3) and an
  // unmount asks to confirm unknown holders.
  executor.addFixture({ command: '/usr/bin/lsof', result: { stdout: '', stderr: '', exitCode: 1 } })

  const app = Fastify({ logger: false, routerOptions: { maxParamLength: PATH_PARAM_MAX } })
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
    ...(mountTestStages !== undefined ? { mountTestStages } : {}),
  })
  return { app, executor, dir, fstabPath, credsDir }
}

/** Was this exact command+argv issued? */
function called(executor: MockExecutor, command: string, args: string[]): boolean {
  return executor.calls.some(c => c.command === command && c.args.length === args.length && c.args.every((a, i) => a === args[i]))
}

// ============================================================================
// POST /v1/mounts/test — the MOUNT stage (the TEST SEAM: a test host has no
// share server on 445, so DNS/TCP are overridden; the mount-stage verdict
// mapping is what the reproduced bug misreported — EINVAL as "unreachable")
// ============================================================================

describe('mount routes — POST /v1/mounts/test reaches the mount stage (seam)', () => {
  let h: EditHarness | undefined

  beforeEach(async () => {
    h = await createEditServer(() => '', [findmntJson([])], {
      resolves: async () => true,
      tcpReachable: async () => true,
    })
    // cr.60 (L8): the probe credentials go under the daemon's runtime dir —
    // a private stand-in for /run/anas, inside the harness directory.
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(h.dir, 'run', 'anas')
  })

  afterEach(async () => {
    delete process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  it('cr.60 (L8): an unsaved CIFS test writes its probe credentials under the runtime dir, never os.tmpdir(), and removes them', async () => {
    const runtime = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR!
    let during: { path: string, mode: number } | undefined
    const orig = h!.executor.exec.bind(h!.executor)
    h!.executor.exec = async (command, args, opts) => {
      if (command === TIMEOUT) {
        const path = /credentials=([^,]+)$/.exec(args[5])![1]
        during = { path, mode: (await stat(path)).mode & 0o777 }
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return orig(command, args, opts)
    }
    const res = await h!.app.inject({
      method: 'POST',
      url: '/v1/mounts/test',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'pictures', credentials: { username: 'u', password: 'p' } }),
    })
    assert.equal(res.statusCode, 200, res.payload)
    assert.equal((res.json() as { data: { verdict: string } }).data.verdict, 'ok')
    assert.ok(during, 'the probe ran')
    assert.ok(during.path.startsWith(`${runtime}/anas-mount-probe-creds-`), during.path)
    assert.equal(during.mode, 0o600)
    assert.deepEqual(await readdir(runtime), [], 'removed after the probe')
  })

  it('EINVAL / "Malformed UNC" comes back `invalid` — never `unreachable`', async () => {
    h!.executor.addFixture({ command: TIMEOUT, result: {
      stdout: '',
      stderr: 'mount error(22): Invalid argument\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const res = await h!.app.inject({
      method: 'POST',
      url: '/v1/mounts/test',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'cifs', server: '//127.0.0.1', remotePath: '/pictures' }),
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { verdict: string, stage: string, detail?: string } }
    assert.equal(data.verdict, 'invalid')
    assert.equal(data.stage, 'mount')
    assert.match(data.detail ?? '', /server or share is malformed/)
  })

  it('a no-credentials CIFS probe passes `guest` (never prompts) and the NORMALISED spec', async () => {
    h!.executor.addFixture({ command: TIMEOUT, result: {
      stdout: '',
      stderr: 'mount error(22): Invalid argument\n',
      exitCode: 32,
    } })
    const res = await h!.app.inject({
      method: 'POST',
      url: '/v1/mounts/test',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'cifs', server: '  127.0.0.1/  ', remotePath: 'pictures/' }),
    })
    assert.equal(res.statusCode, 200)
    const probe = h!.executor.calls.find(c => c.command === TIMEOUT)!
    // argv: timeout 15 /usr/bin/mount -t cifs -o <opts> <spec> <probeDir>
    assert.equal(probe.args[4], '-o')
    assert.equal(probe.args[5], 'vers=3.1.1,guest')
    assert.equal(probe.args[6], '//127.0.0.1/pictures')
  })

  it('a credentials probe still authenticates from a temp file; rejection is auth-failed with its advice', async () => {
    h!.executor.addFixture({ command: TIMEOUT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const res = await h!.app.inject({
      method: 'POST',
      url: '/v1/mounts/test',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'cifs', server: '127.0.0.1', remotePath: 'pictures', credentials: { username: 'u', password: 'p' } }),
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: { verdict: string, detail?: string } }
    assert.equal(data.verdict, 'auth-failed')
    assert.match(data.detail ?? '', /username or password/)
    const probe = h!.executor.calls.find(c => c.command === TIMEOUT)!
    assert.match(probe.args[5], /^vers=3\.1\.1,credentials=\/.+probe\.cred$/)
    assert.ok(!probe.args[5].includes('guest'))
  })
})

describe('PUT /v1/mounts — credentials are proven before anything is committed (issue #24)', () => {
  let h: EditHarness | undefined

  const cifsFstab = (credsDir: string): string =>
    `//10.0.0.9/media ${CIFS_MP()} cifs credentials=${join(credsDir, 'mnt-edit-cifs.cred')},vers=3.1.1,nofail 0 0\n`

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
      url: `/v1/mounts/${enc(CIFS_MP())}`,
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
    assert.match(probe.args.join(' '), new RegExp(`credentials=.*\\.${credsFileName(CIFS_MP()).replace('.', '\\.')}\\.validating`))
    // No fstab rewrite means no reload and no remount attempt either.
    assert.ok(!called(h!.executor, SYSTEMCTL, ['daemon-reload']))
    assert.ok(!called(h!.executor, UMOUNT, [CIFS_MP()]))
  })

  it('a proven password is committed, the fstab rewritten and the mount applied', async () => {
    h!.executor.addFixture({ command: TIMEOUT, result: OK }) // the probe mount succeeds

    const job = await putCredentials('n3wp@ss')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    // ident.4 (d): a rotation writes the HASHED name, and the old
    // flattened-name file the line used to name goes once nothing references it.
    const credsPath = join(h!.credsDir, credsFileName(CIFS_MP()))
    const creds = await readFile(credsPath, 'utf8')
    assert.ok(creds.includes('password=n3wp@ss'), creds)
    assert.equal((await stat(credsPath)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(h!.credsDir), [credsFileName(CIFS_MP())])

    const line = (await readFile(h!.fstabPath, 'utf8')).split('\n').find(l => l.includes(CIFS_MP()))!
    assert.ok(line.includes(`credentials=${credsPath}`), line)
    assert.ok(line.split(/\s+/)[3].split(',').includes('ro'), line)
    // cr.52r D3: mounted DIRECTLY through the daemon-opened dir — the argv
    // carries the rotated spec and `/proc/self/fd/3`, never the old `mount <mp>`.
    const m = h!.executor.calls.find(c => c.command === MOUNT && c.args[0] === '-c')
    assert.ok(m, 'the edit mounted with `-c`')
    assert.equal(m!.args[1], '-t')
    assert.equal(m!.args[2], 'cifs')
    assert.equal(m!.args.at(-1), '/proc/self/fd/3')
    assert.equal(m!.fdPaths?.[0], CIFS_MP())
    // The empty table meant no live entry to remount — never a `-o remount`.
    assert.ok(!called(h!.executor, MOUNT, ['-o', 'remount', '--', CIFS_MP()]))
  })
})

describe('PUT /v1/mounts — a completed edit means the new options are LIVE (issue #25)', () => {
  let h: EditHarness | undefined

  const nfsFstab = (): string => `10.0.0.9:/export ${NFS_MP()} nfs4 defaults,nofail 0 0\n`
  const RW = 'rw,relatime,vers=4.2,hard,proto=tcp,addr=10.0.0.9'
  const RO = 'ro,relatime,vers=4.2,hard,proto=tcp,addr=10.0.0.9'

  afterEach(async () => {
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  /** A busy mountpoint: the unmount is refused, exactly as util-linux reports it. */
  function refuseUnmount(executor: MockExecutor): void {
    executor.addFixture({ command: UMOUNT, args: [NFS_MP()], result: {
      stdout: '',
      stderr: `umount: ${NFS_MP()}: target is busy.`,
      exitCode: 32,
    } })
  }

  async function putReadOnly(): Promise<Job> {
    const res = await h!.app.inject({
      method: 'PUT',
      url: `/v1/mounts/${enc(NFS_MP())}`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ options: { ro: true } }),
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(h!.app, (res.json() as { job: Job }).job.id)
  }

  it('a refused unmount falls back to `mount -o remount` and succeeds once the options land', async () => {
    // Mount table: the two ident.4 (e) live-match reads (request, job start),
    // still rw after the refused unmount, ro after the remount.
    h = await createEditServer(nfsFstab, [nfsTable(RW), nfsTable(RW), nfsTable(RW), nfsTable(RO)])
    refuseUnmount(h.executor)

    const job = await putReadOnly()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // Asserted against the whole argv including the fstab-option `-o`.
    assert.ok(h.executor.calls.some(c => c.command === MOUNT && c.args[0] === '-o' && c.args[1] === 'remount'))
    // A busy target is NEVER mounted over — `mount <mp>` reports success on an
    // already-mounted target and would have hidden the whole failure.
    assert.ok(!called(h.executor, MOUNT, ['--', NFS_MP()]))
  })

  it('options that never land fail the job and name the holders', async () => {
    // The mount table keeps answering rw — the remount changed nothing.
    h = await createEditServer(nfsFstab, [nfsTable(RW)])
    refuseUnmount(h.executor)
    // fuser names THIS test process as the holder → /proc/<pid>/comm is real.
    h.executor.addFixture({ command: FUSER, args: ['-m', NFS_MP()], result: { stdout: `${process.pid}\n`, stderr: '', exitCode: 0 } })

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
    // cr.52r D3: mounted DIRECTLY through the daemon-opened dir (target
    // /proc/self/fd/3), with the entry's own fstab tokens in `-o`.
    const m = h.executor.calls.find(c => c.command === MOUNT && c.args[0] === '-c')
    assert.ok(m, 'the edit mounted with `-c`')
    assert.equal(m!.args[1], '-t')
    assert.equal(m!.args[2], 'nfs4')
    assert.equal(m!.args.at(-1), '/proc/self/fd/3')
    assert.equal(m!.fdPaths?.[0], NFS_MP())
    assert.ok(!called(h.executor, MOUNT, ['-o', 'remount', '--', NFS_MP()]))
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

describe('DeleteMountQuery — the mountpoint-directory flag (18.5 refinement)', () => {
  it('defaults to false: an old client\'s delete keeps today\'s behaviour', () => {
    assert.equal(DeleteMountQuery.parse({}).removeMountpointDir, false)
  })

  it('accepts the query-string vocabulary and a real boolean', () => {
    for (const v of ['true', '1', true])
      assert.equal(DeleteMountQuery.parse({ removeMountpointDir: v }).removeMountpointDir, true, `${String(v)}`)
    for (const v of ['false', '0', false])
      assert.equal(DeleteMountQuery.parse({ removeMountpointDir: v }).removeMountpointDir, false, `${String(v)}`)
  })

  it('rejects anything else rather than guessing', () => {
    assert.equal(DeleteMountQuery.safeParse({ removeMountpointDir: 'yes' }).success, false)
    assert.equal(DeleteMountQuery.safeParse({ removeMountpointDir: 2 }).success, false)
  })
})

// ============================================================================
// ident.4 (e) — act on the target only while what is mounted there is what
// the fstab line names (audit #18); (d) — a credentials file goes only from
// the ANAS creds dir and only when no other line references it (audit #17)
// ============================================================================

describe('mount mutations act only on what is actually there (ident.4 (e))', () => {
  let h: EditHarness | undefined

  /** A CIFS line whose mount failed, and a local disk the operator mounted at its target. */
  const cifsFstab = (credsDir: string): string =>
    `//10.0.0.9/media ${CIFS_MP()} cifs credentials=${join(credsDir, credsFileName(CIFS_MP()))},vers=3.1.1,nofail 0 0\n`
  const LOCAL_DISK = findmntJson([{ target: CIFS_MP(), source: '/dev/loop3', fstype: 'ext4', options: 'rw,relatime' }])
  const THE_SHARE = findmntJson([{ target: CIFS_MP(), source: '//10.0.0.9/media', fstype: 'cifs', options: 'rw,vers=3.1.1' }])

  afterEach(async () => {
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  function assertMismatch(res: { statusCode: number, json: () => any }, verb: string): void {
    assert.equal(res.statusCode, 409)
    const err = res.json().error
    assert.equal(err.code, 'CONFLICT')
    assert.equal(err.reason, 'mount-mismatch')
    assert.match(err.message, new RegExp(`^${verb} refused`))
    // The 409 names what is there AND what the line names.
    assert.ok(err.message.includes('/dev/loop3 (ext4)'), err.message)
    assert.ok(err.message.includes('//10.0.0.9/media (cifs)'), err.message)
  }

  it('Remove → 409 naming the local filesystem; nothing is unmounted, fstab untouched', async () => {
    h = await createEditServer(cifsFstab, [LOCAL_DISK])
    const before = await readFile(h.fstabPath, 'utf8')
    const res = await h.app.inject({ method: 'DELETE', url: `/v1/mounts/${enc(CIFS_MP())}`, headers: IDENTITY_HEADERS })
    assertMismatch(res, 'Removing')
    assert.ok(!h.executor.calls.some(c => c.command === UMOUNT), 'umount never ran')
    assert.equal(await readFile(h.fstabPath, 'utf8'), before)
  })

  it('Unmount, Disable and Mount → 409; Enable (fstab only) is not gated', async () => {
    h = await createEditServer(cifsFstab, [LOCAL_DISK])
    for (const [action, verb] of [['unmount', 'Unmounting'], ['disable', 'Disabling'], ['mount', 'Mounting']]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/mounts/${enc(CIFS_MP())}/state`,
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ action }),
      })
      assertMismatch(res, verb)
    }
    assert.ok(!h.executor.calls.some(c => c.command === UMOUNT || c.command === MOUNT), 'neither umount nor mount ran')
  })

  it('Edit → 409 before anything is written', async () => {
    h = await createEditServer(cifsFstab, [LOCAL_DISK])
    const before = await readFile(h.fstabPath, 'utf8')
    const res = await h.app.inject({
      method: 'PUT',
      url: `/v1/mounts/${enc(CIFS_MP())}`,
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ options: { ro: true } }),
    })
    assertMismatch(res, 'Editing')
    assert.equal(await readFile(h.fstabPath, 'utf8'), before)
  })

  it('the job re-checks: a local disk mounted after the request fails the job, not the disk', async () => {
    // Request time: the share is there. Job time: a local disk sits there instead.
    // cr.39: one read per guard run — the challenge, the confirmed resend, the job.
    h = await createEditServer(cifsFstab, [THE_SHARE, THE_SHARE, LOCAL_DISK])
    const res = await confirmedDelete(h.app, `/v1/mounts/${enc(CIFS_MP())}`)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(h.app, res.json().job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /\/dev\/loop3 \(ext4\)/)
    assert.ok(!h.executor.calls.some(c => c.command === UMOUNT), 'umount never ran')
  })

  it('the configured share itself unmounts and removes as before', async () => {
    h = await createEditServer(cifsFstab, [THE_SHARE, THE_SHARE, THE_SHARE, findmntJson([])])
    const res = await confirmedDelete(h.app, `/v1/mounts/${enc(CIFS_MP())}`)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(h.app, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(called(h.executor, UMOUNT, [CIFS_MP()]))
    assert.ok(!(await readFile(h.fstabPath, 'utf8')).includes(CIFS_MP()))
  })
})

describe('mount Remove — the credentials file (ident.4 (d))', () => {
  let h: EditHarness | undefined

  afterEach(async () => {
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  async function remove(mp: string): Promise<Job> {
    const res = await confirmedDelete(h!.app, `/v1/mounts/${enc(mp)}`)
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(h!.app, res.json().job.id)
  }

  it('a file another line still names is kept (the flattened pre-ident.4 name two mounts shared)', async () => {
    // Audit #17: `/mnt/nas-media` and `/mnt/nas/media` both flattened to one name.
    const shared = (credsDir: string): string => join(credsDir, 'mnt-nas-media.cred')
    h = await createEditServer(credsDir => [
      `//nas/a /mnt/nas-media cifs credentials=${shared(credsDir)},nofail 0 0`,
      `//nas/b /mnt/nas/media cifs credentials=${shared(credsDir)},nofail 0 0`,
      '',
    ].join('\n'), [findmntJson([])])
    await mkdir(h.credsDir, { recursive: true })
    await writeFile(shared(h.credsDir), OLD_CREDS, { mode: 0o600 })

    const job = await remove('/mnt/nas/media')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(await readFile(shared(h.credsDir), 'utf8'), OLD_CREDS, 'the other mount keeps its secret')
    assert.match((job.result as { warnings?: string[] }).warnings?.join(' ') ?? '', /another \/etc\/fstab line still references it/)
  })

  it('an unreferenced file in the creds dir is removed', async () => {
    h = await createEditServer(credsDir => `//nas/a ${CIFS_MP()} cifs credentials=${join(credsDir, credsFileName(CIFS_MP()))},nofail 0 0\n`, [findmntJson([])])
    await mkdir(h.credsDir, { recursive: true })
    await writeFile(join(h.credsDir, credsFileName(CIFS_MP())), OLD_CREDS, { mode: 0o600 })
    const job = await remove(CIFS_MP())
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(await readdir(h.credsDir), [])
  })

  it('a file outside the creds dir is never deleted', async () => {
    let outside = ''
    h = await createEditServer((credsDir) => {
      outside = join(dirname(credsDir), 'operator-own.cred')
      return `//nas/a ${CIFS_MP()} cifs credentials=${outside},nofail 0 0\n`
    }, [findmntJson([])])
    await writeFile(outside, OLD_CREDS, { mode: 0o600 })
    const job = await remove(CIFS_MP())
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(await readFile(outside, 'utf8'), OLD_CREDS)
    assert.match((job.result as { warnings?: string[] }).warnings?.join(' ') ?? '', /not in the ANAS credentials directory/)
  })
})

// cr.18 (review M7.2): for a PERSISTENT mount the credentials file used to be
// written BEFORE the fstab edit that names it — a failed edit left the secret
// on disk with no fstab line referencing it, forever. The job now writes the
// fstab line first; if that edit fails, nothing is left behind.
describe('mount Create — a failed fstab edit leaves no credentials behind (cr.18, review M7.2)', () => {
  // editConfig's atomic write lands its temp file and .bak in the fstab's OWN
  // directory, so a read-only directory fails the edit while reads keep
  // working. Root ignores directory permissions — the test skips there.
  const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let etcDir: string
  let fstabPath: string
  let credsDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mounts-fail-'))
    etcDir = join(dir, 'etc')
    await mkdir(etcDir, { recursive: true })
    fstabPath = join(etcDir, 'fstab')
    await writeFile(fstabPath, '')
    credsDir = join(dir, 'creds')
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = credsDir
    process.env.ANAS_STORAGE_CFG = STORAGE_CFG
    await chmod(etcDir, 0o500)
    server = createServer({ mock: true, logger: false })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await chmod(etcDir, 0o700)
    await rm(dir, { recursive: true, force: true })
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
  })

  it('a persistent CIFS create whose fstab edit fails leaves no credentials file', { skip: AS_ROOT && 'running as root — read-only directories do not stop root' }, async () => {
    const mountpoint = join(dir, 'mnt', 'editfail-cifs')
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/mounts',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        type: 'cifs',
        server: 'nas.example.com',
        remotePath: 'media',
        mountpoint,
        persistent: true,
        mountNow: true,
        credentials: { username: 'smbuser', password: 's3cret' },
      }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, res.json().job.id)
    assert.equal(job.status, 'failed', 'the read-only fstab directory must fail the job')
    // No secret survives the failed edit: the creds dir was never even created.
    const left = await readdir(credsDir).catch(() => [] as string[])
    assert.deepEqual(left, [])
    // And the request-time reads still worked — the failure is the WRITE.
    assert.equal(await readFile(fstabPath, 'utf8'), '')
  })
})

// cr.19 (§2 Mounts automount ruling; node pass R1-D2/D3): the daemon-reload
// alone leaves an ARMED automount armed (D2) and a removed line's autofs
// placeholder orphaned (D3), so Disable and Remove stop the line's `.automount`
// unit — after the fstab edit, before the daemon-reload. A failed stop is a
// warning on a COMPLETED job; a plain line runs no stop.
describe('mount Disable / Remove stop an automount line\'s .automount unit (cr.19)', () => {
  let h: EditHarness | undefined

  const AUTO_MP = '/mnt/edit-auto'
  /** `systemd-escape -p --suffix=automount /mnt/edit-auto` (hyphen → `\x2d`, NOTES §7). */
  const AUTO_UNIT = 'mnt-edit\\x2dauto.automount'
  const SYSTEMD_ESCAPE = '/usr/bin/systemd-escape'
  const AUTO_LINE = `10.0.0.9:/export ${AUTO_MP} nfs4 defaults,nofail,_netdev,x-systemd.automount 0 0`
  const PARKED_LINE = `10.0.0.9:/export ${AUTO_MP} nfs4 defaults,nofail,_netdev,x-anas.disabled-automount,noauto,x-anas.disabled 0 0`
  const PLACEHOLDER = { target: AUTO_MP, source: 'systemd-1', fstype: 'autofs', options: 'rw,relatime,fd=108,pgrp=1,timeout=60,minproto=5,maxproto=5,direct' }
  const ARMED = findmntJson([PLACEHOLDER])
  const ARMED_AND_MOUNTED = findmntJson([PLACEHOLDER, { target: AUTO_MP, source: '10.0.0.9:/export', fstype: 'nfs4', options: 'rw,relatime,vers=4.2' }])

  /** fstab as the `systemctl stop` call saw it (proves the edit came first). */
  let fstabAtStop: string | undefined

  async function harness(
    fstab: string,
    tables: string[],
    stop: { exitCode: number, stderr?: string } = { exitCode: 0 },
    escape: { stdout: string, exitCode: number } = { stdout: `${AUTO_UNIT}\n`, exitCode: 0 },
  ): Promise<EditHarness> {
    const made = await createEditServer(() => `${fstab}\n`, tables)
    made.executor.addFixture({ command: SYSTEMD_ESCAPE, args: ['-p', '--suffix=automount', AUTO_MP], result: { ...escape, stderr: '' } })
    made.executor.addFixture({
      command: SYSTEMCTL,
      argsMatch: (args) => {
        if (args[0] !== 'stop')
          return false
        fstabAtStop = readFileSync(made.fstabPath, 'utf8')
        return true
      },
      result: { stdout: '', stderr: stop.stderr ?? '', exitCode: stop.exitCode },
    })
    return made
  }

  async function act(method: 'POST' | 'DELETE', mp = AUTO_MP): Promise<Job> {
    const res = method === 'POST'
      ? await h!.app.inject({ method, url: `/v1/mounts/${enc(mp)}/state`, headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'disable' }) })
      : await confirmedDelete(h!.app, `/v1/mounts/${enc(mp)}`)
    assert.equal(res.statusCode, 202, res.payload)
    return waitForJob(h!.app, res.json().job.id)
  }

  /** Index of the first call matching command + exact argv (−1 when absent). */
  function callIndex(command: string, args: string[]): number {
    return h!.executor.calls.findIndex(c => c.command === command && c.args.length === args.length && c.args.every((a, i) => a === args[i]))
  }

  /** The ladder this story adds: stop the automount, THEN daemon-reload. */
  function assertStopThenReload(): void {
    const stop = callIndex(SYSTEMCTL, ['stop', AUTO_UNIT])
    const reload = callIndex(SYSTEMCTL, ['daemon-reload'])
    assert.ok(stop !== -1, 'systemctl stop <unit>.automount ran')
    assert.ok(reload !== -1, 'daemon-reload ran')
    assert.ok(stop < reload, `stop (call ${stop}) must come before daemon-reload (call ${reload})`)
    assert.ok(callIndex(SYSTEMD_ESCAPE, ['-p', '--suffix=automount', AUTO_MP]) < stop, 'the unit name came from systemd-escape')
  }

  beforeEach(() => {
    fstabAtStop = undefined
  })

  afterEach(async () => {
    await h?.app.close()
    await rm(h!.dir, { recursive: true, force: true })
    h = undefined
  })

  it('Disable of an armed automount: the line is parked, then the unit is stopped, then daemon-reload (R1-D1/D2)', async () => {
    h = await harness(AUTO_LINE, [ARMED])
    const job = await act('POST')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { disabled: AUTO_MP })
    assertStopThenReload()
    assert.equal(fstabAtStop, `${PARKED_LINE}\n`, 'the fstab edit landed before the stop')
    assert.equal(await readFile(h.fstabPath, 'utf8'), `${PARKED_LINE}\n`)
    assert.ok(callIndex(UMOUNT, [AUTO_MP]) === -1, 'only the placeholder was there — nothing to umount')
  })

  it('Disable of an armed AND mounted automount: umount, fstab edit, stop, daemon-reload', async () => {
    h = await harness(AUTO_LINE, [ARMED_AND_MOUNTED, ARMED_AND_MOUNTED, ARMED_AND_MOUNTED, ARMED])
    const job = await act('POST')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const umount = callIndex(UMOUNT, [AUTO_MP])
    assert.ok(umount !== -1 && umount < callIndex(SYSTEMCTL, ['stop', AUTO_UNIT]), 'the real mount came off first')
    assertStopThenReload()
    assert.equal(fstabAtStop, `${PARKED_LINE}\n`)
  })

  it('Remove of an armed automount: the line is dropped, then the unit is stopped, then daemon-reload (R1-D3)', async () => {
    h = await harness(AUTO_LINE, [ARMED])
    const job = await act('DELETE')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { removed: AUTO_MP })
    assertStopThenReload()
    assert.equal(fstabAtStop, '', 'the line was already gone when the unit was stopped')
  })

  it('Remove of a DISABLED (parked) automount line still stops its unit', async () => {
    h = await harness(PARKED_LINE, [ARMED])
    const job = await act('DELETE')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assertStopThenReload()
  })

  it('repair: Disable of a cr.6-form line with a live automount parks it and stops the unit', async () => {
    h = await harness(`10.0.0.9:/export ${AUTO_MP} nfs4 defaults,nofail,_netdev,x-systemd.automount,noauto,x-anas.disabled 0 0`, [ARMED])
    const job = await act('POST')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(await readFile(h.fstabPath, 'utf8'), `${PARKED_LINE}\n`)
    assertStopThenReload()
  })

  it('a unit the manager has not loaded (systemctl exit 5) is not armed: no warning', async () => {
    h = await harness(PARKED_LINE, [findmntJson([])], { exitCode: 5, stderr: `Failed to stop ${AUTO_UNIT}: Unit ${AUTO_UNIT} not loaded.` })
    const job = await act('POST')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { disabled: AUTO_MP })
    assert.equal(await readFile(h.fstabPath, 'utf8'), `${PARKED_LINE}\n`, 'an already-parked line is left byte-identical')
    assertStopThenReload()
  })

  it('a failed stop on Disable is a warning on a COMPLETED job; the reload still runs', async () => {
    h = await harness(AUTO_LINE, [ARMED], { exitCode: 1, stderr: `Failed to stop ${AUTO_UNIT}: Access denied` })
    const job = await act('POST')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const warnings = (job.result as { warnings?: string[] }).warnings ?? []
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Could not stop the automount unit for '\/mnt\/edit-auto'/)
    assert.ok(warnings[0].includes('Access denied'), warnings[0])
    assertStopThenReload()
    assert.equal(await readFile(h.fstabPath, 'utf8'), `${PARKED_LINE}\n`)
  })

  it('a failed stop on Remove is a warning on a COMPLETED job; the line is still gone', async () => {
    h = await harness(AUTO_LINE, [ARMED], { exitCode: 1, stderr: 'Failed to stop: Transport endpoint is not connected' })
    const job = await act('DELETE')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const warnings = (job.result as { removed: string, warnings?: string[] }).warnings ?? []
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Could not stop the automount unit/)
    assertStopThenReload()
    assert.equal(await readFile(h.fstabPath, 'utf8'), '')
  })

  it('a failed unit-name escape is a warning too, never a silent skip', async () => {
    h = await harness(AUTO_LINE, [ARMED], { exitCode: 0 }, { stdout: '', exitCode: 1 })
    const job = await act('POST')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.match(((job.result as { warnings?: string[] }).warnings ?? []).join(' '), /systemd-escape gave no unit name/)
    assert.equal(callIndex(SYSTEMCTL, ['stop', AUTO_UNIT]), -1)
    assert.ok(callIndex(SYSTEMCTL, ['daemon-reload']) !== -1)
  })

  it('a plain line: Disable and Remove run no automount stop', async () => {
    const plain = `10.0.0.9:/export ${AUTO_MP} nfs4 defaults,nofail,_netdev 0 0`
    h = await harness(plain, [findmntJson([])])
    const djob = await act('POST')
    assert.equal(djob.status, 'completed', JSON.stringify(djob.error))
    assert.deepEqual(djob.result, { disabled: AUTO_MP })
    const rjob = await act('DELETE')
    assert.equal(rjob.status, 'completed', JSON.stringify(rjob.error))
    assert.ok(!h.executor.calls.some(c => c.command === SYSTEMCTL && c.args[0] === 'stop'), 'no systemctl stop')
    assert.ok(!h.executor.calls.some(c => c.command === SYSTEMD_ESCAPE && c.args.includes('--suffix=automount')), 'no automount unit lookup')
    assert.equal(fstabAtStop, undefined)
  })

  it('inventory: a parked disabled line reads disabled over a leftover placeholder, and the detail names the placeholder', async () => {
    for (const table of [ARMED, ARMED_AND_MOUNTED]) {
      h = await harness(PARKED_LINE, [table])
      const inv = await h.app.inject({ method: 'GET', url: '/v1/mounts', headers: IDENTITY_HEADERS })
      const row = (inv.json() as { data: MountSummary[] }).data.find(r => r.mountpoint === AUTO_MP)!
      assert.equal(row.state, 'disabled')
      assert.equal(row.disabled, true)
      assert.equal(row.automount, true)
      assert.equal(row.type, 'nfs') // the fstab line is the identity, never the placeholder
      const det = await h.app.inject({ method: 'GET', url: `/v1/mounts/${enc(AUTO_MP)}`, headers: IDENTITY_HEADERS })
      const detail = (det.json() as { data: MountDetail }).data
      assert.equal(detail.state, 'disabled')
      assert.equal(detail.health.state, 'disabled')
      assert.equal(detail.health.detail, DISABLED_PLACEHOLDER_DETAIL)
      assert.equal(detail.configuredOptions?.common.automount, true)
      assert.ok(!detail.configuredOptions?.passthrough.includes('x-anas'), detail.configuredOptions?.passthrough)
      await h.app.close()
      await rm(h.dir, { recursive: true, force: true })
    }
    // With no placeholder left, the plain disabled sentence.
    h = await harness(PARKED_LINE, [findmntJson([])])
    const det = await h.app.inject({ method: 'GET', url: `/v1/mounts/${enc(AUTO_MP)}`, headers: IDENTITY_HEADERS })
    assert.equal((det.json() as { data: MountDetail }).data.health.detail, 'Disabled in /etc/fstab — will not mount at boot.')
  })
})
