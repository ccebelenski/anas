import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { sharePathVerdictRefusal } from '../../services/share-path.js'

/**
 * cr3.shares — the share routes' fixes from the 2026-11-14 review, at the
 * route (and job) doors. Parser-level proofs live in parsers/__tests__.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 1000; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

let server: ReturnType<typeof createServer> | undefined
let dir: string | undefined

function start(conf: string, extra: Record<string, unknown> = {}): { s: ReturnType<typeof createServer>, confPath: string } {
  dir = mkdtempSync(join(tmpdir(), 'anas-cr3-shares-'))
  const confPath = join(dir, 'smb.conf')
  writeFileSync(confPath, conf, 'utf8')
  server = createServer({ mock: true, logger: false, smbConfPath: confPath, ...extra })
  return { s: server, confPath }
}

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('H1 — section headers at the share routes', () => {
  // cr3.shares (review): `[pub lic]` and `[public]` are two shares Samba
  // serves (testparm 4.25, each with a path). (Was: the create below was
  // refused CONFLICT, and a `[ public]` beside `[public]` refused edits.)
  it('a create of `public` beside `[pub lic]` is a second share, not a conflict', async () => {
    const { s, confPath } = start('[global]\n\tworkgroup = WG\n\n[pub lic]\n\tpath = /srv/one\n')
    const res = await s.inject({ method: 'POST', url: '/v1/shares/smb', headers: JSON_HEADERS, payload: { name: 'public', path: '/srv/two' } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const after = readFileSync(confPath, 'utf8')
    assert.ok(after.includes('[pub lic]\n\tpath = /srv/one\n') && after.includes('[public]\n\tpath = /srv/two\n'), after)
  })

  it('a PUT on a share whose header carries a comment edits that share only', async () => {
    const conf = '[global]\n\tworkgroup = WG\n\n[a]\n\tpath = /srv/a\n\n[b] ; staff only\n\tpath = /srv/b\n\tvalid users = alice\n'
    const { s, confPath } = start(conf)
    const res = await s.inject({ method: 'PUT', url: '/v1/shares/smb/a', headers: JSON_HEADERS, payload: { validUsers: ['bob'] } })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const after = readFileSync(confPath, 'utf8')
    assert.ok(after.includes('[b] ; staff only\n\tpath = /srv/b\n\tvalid users = alice\n'), after)
    assert.ok(after.includes('[a]\n\tpath = /srv/a\n\tvalid users = bob\n'), after)
  })
})

// --- M4: a footprint that could not see never reads as "no claim" ---------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')
const ZFS_LIST = ['list', '-H', '-o', 'name,mountpoint']
/** The probe's zfs-root node: rpool/data is local-zfs's storage root. */
const ZFS_ROOT_LIST = `${['rpool\t/rpool', 'rpool/ROOT\t/rpool/ROOT', 'rpool/ROOT/pve-1\t/', 'rpool/data\t/rpool/data', 'rpool/var-lib-vz\t/var/lib/vz'].join('\n')}\n`

function withZfsRoot(s: ReturnType<typeof createServer>, zfsOk: boolean): void {
  const mock = (s as unknown as { executor: MockExecutor }).executor
  mock.prependFixture({ command: '/usr/sbin/zfs', args: ZFS_LIST, result: zfsOk ? { stdout: ZFS_ROOT_LIST, stderr: '', exitCode: 0 } : { stdout: '', stderr: 'cannot open: transient', exitCode: 1 } })
  mock.prependFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: readFileSync(join(FIXTURES, 'mounts/findmnt-zfs-root.json'), 'utf8'), stderr: '', exitCode: 0 } })
}

describe('M4 — a share is created only on a positive "no claim"', () => {
  const saved = process.env.ANAS_STORAGE_CFG
  const savedExports = process.env.ANAS_EXPORTS_PATH
  afterEach(() => {
    if (savedExports === undefined)
      delete process.env.ANAS_EXPORTS_PATH
    else
      process.env.ANAS_EXPORTS_PATH = savedExports
    if (saved === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = saved
  })
  const CONF = '[global]\n\tworkgroup = WG\n'

  it('the claim refusal fails closed on any verdict other than a claim or null', () => {
    // The pools area's `cannot-see` verdict (pve.sharePathVerdict).
    const r = sharePathVerdictRefusal({ kind: 'cannot-see', reason: 'zfs list failed' }, 'Share path', '/rpool/data')
    assert.equal(r?.status, 400)
    assert.match(r?.message ?? '', /Could not tell whether share path '\/rpool\/data' is PVE territory — zfs list failed/)
    // An unknown verdict fails closed the same way.
    assert.equal(sharePathVerdictRefusal({ kind: 'later' } as never, 'Share path', '/srv/x')?.status, 400)
    assert.equal(sharePathVerdictRefusal({ kind: 'no-claim' }, 'Share path', '/srv/x'), null)
  })

  it('control: a readable list refuses an SMB share on local-zfs\'s root 409 PVE_MANAGED', async () => {
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage-zfsroot.cfg')
    const { s, confPath } = start(CONF)
    withZfsRoot(s, true)
    const res = await s.inject({ method: 'POST', url: '/v1/shares/smb', headers: JSON_HEADERS, payload: { name: 'vmdata', path: '/rpool/data' } })
    assert.equal(res.statusCode, 409)
    assert.equal(readFileSync(confPath, 'utf8'), CONF)
  })

  it('a failed zfs list refuses the SMB create (never "no claim")', async () => {
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage-zfsroot.cfg')
    const { s, confPath } = start(CONF)
    withZfsRoot(s, false)
    const res = await s.inject({ method: 'POST', url: '/v1/shares/smb', headers: JSON_HEADERS, payload: { name: 'vmdata', path: '/rpool/data' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Could not tell whether share path|could not be read/)
    assert.equal(readFileSync(confPath, 'utf8'), CONF)
  })

  it('a failed zfs list refuses the NFS create (never "no claim")', async () => {
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage-zfsroot.cfg')
    dir = mkdtempSync(join(tmpdir(), 'anas-cr3-shares-'))
    const exportsPath = join(dir, 'exports')
    writeFileSync(exportsPath, '', 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath
    server = createServer({ mock: true, logger: false })
    withZfsRoot(server, false)
    const res = await server.inject({ method: 'POST', url: '/v1/shares/nfs', headers: JSON_HEADERS, payload: { path: '/rpool/data', clients: [{ spec: '10.0.0.0/24', options: ['rw'] }] } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Could not tell whether export path|could not be read/)
    assert.equal(readFileSync(exportsPath, 'utf8'), '')
  })
})

describe('L6 — a share path is the path Samba serves', () => {
  const CONF = '[global]\n\tworkgroup = WG\n'

  it('a path Samba would trim (trailing space) is refused 400 before any gate', async () => {
    const { s, confPath } = start(CONF)
    const res = await s.inject({ method: 'POST', url: '/v1/shares/smb', headers: JSON_HEADERS, payload: { name: 'guests', path: '/rpool/data ' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /exactly the path Samba serves/)
    assert.equal(readFileSync(confPath, 'utf8'), CONF)
  })

  it('an edit to a doubled-space path is refused 400', async () => {
    const { s } = start(`${CONF}\n[a]\n\tpath = /srv/a\n`)
    const res = await s.inject({ method: 'PUT', url: '/v1/shares/smb/a', headers: JSON_HEADERS, payload: { path: '/srv/My  Data' } })
    assert.equal(res.statusCode, 400)
  })

  it('a hand-written `%U` share can still be edited: the panel\'s body sends its path back unchanged (review regression)', async () => {
    const conf = `${CONF}\n[profiles]\n\tpath = /srv/profiles/%U\n\tread only = no\n`
    const { s, confPath } = start(conf)
    const row = ((await s.inject({ method: 'GET', url: '/v1/shares/smb' })).json() as { data: { name: string, path: string, browseable: boolean, readOnly: boolean, guestOk: boolean, validUsers: string[], hostsAllow: string[], hostsDeny: string[] }[] }).data.find(d => d.name === 'profiles')!
    const res = await s.inject({ method: 'PUT', url: '/v1/shares/smb/profiles', headers: JSON_HEADERS, payload: { path: row.path, comment: 'roaming profiles', browseable: row.browseable, readOnly: row.readOnly, guestOk: row.guestOk, validUsers: row.validUsers, hostsAllow: row.hostsAllow, hostsDeny: row.hostsDeny } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const after = readFileSync(confPath, 'utf8')
    assert.ok(after.includes('\tpath = /srv/profiles/%U\n'), 'the path line is kept verbatim')
    assert.ok(after.includes('comment = roaming profiles'))
  })

  it('an edit that MOVES a path to a %-macro is refused 400', async () => {
    const { s } = start(`${CONF}\n[a]\n\tpath = /srv/a\n`)
    const res = await s.inject({ method: 'PUT', url: '/v1/shares/smb/a', headers: JSON_HEADERS, payload: { path: '/srv/%U' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /exactly the path Samba serves/)
  })

  it('a hand-written `%U` path is never probed and reads as unknown, not missing', async () => {
    const { s } = start(`${CONF}\n[homes2]\n\tpath = /home/%U\n`)
    const mock = (s as unknown as { executor: MockExecutor }).executor
    const list = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
    const row = (list.json() as { data: { name: string, pathState?: string, pathExists?: boolean }[] }).data.find(d => d.name === 'homes2')!
    assert.equal(row.pathState, undefined)
    assert.equal(row.pathExists, undefined)
    const detail = await s.inject({ method: 'GET', url: '/v1/shares/smb/homes2' })
    assert.equal((detail.json() as { data: { pathState?: string } }).data.pathState, undefined)
    assert.equal(mock.calls.some(c => c.args.includes('/home/%U') && c.command === '/usr/bin/timeout'), false)
  })
})

describe('L7 — the PVE claim on a share path is asked again in the job (ruling (j))', () => {
  const ENV = ['ANAS_STORAGE_CFG', 'ANAS_EXPORTS_PATH'] as const
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined)
        delete process.env[k]
      else
        process.env[k] = saved[k]
    }
  })

  /** Fill the four job slots; the next accepted job waits `queued` until released. */
  function holdSlots(s: ReturnType<typeof createServer>): () => void {
    const queue = (s as unknown as { jobQueue: { submit: (t: string, o: unknown, f: () => Promise<void>) => unknown } }).jobQueue
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  /**
   * The probe's zfs-root node (captured findmnt table): `rpool/data` is a
   * plain dataset until a storage.cfg registers it as local-zfs's root.
   */
  function rootNode(s: ReturnType<typeof createServer>): { claimed: string, unclaimed: string } {
    withZfsRoot(s, true)
    const unclaimed = join(dir!, 'storage-none.cfg')
    writeFileSync(unclaimed, '')
    return { claimed: join(FIXTURES, 'pve/storage-zfsroot.cfg'), unclaimed }
  }

  it('an SMB create whose path PVE claimed while the job waited fails, smb.conf untouched', async () => {
    for (const k of ENV)
      saved[k] = process.env[k]
    const CONF = '[global]\n\tworkgroup = WG\n'
    const { s, confPath } = start(CONF)
    const cfg = rootNode(s)
    process.env.ANAS_STORAGE_CFG = cfg.unclaimed
    const release = holdSlots(s)
    const res = await s.inject({ method: 'POST', url: '/v1/shares/smb', headers: JSON_HEADERS, payload: { name: 'vm', path: '/rpool/data' } })
    assert.equal(res.statusCode, 202, res.body)
    process.env.ANAS_STORAGE_CFG = cfg.claimed
    release()
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(JSON.stringify(job.error), /PVE/)
    assert.equal(readFileSync(confPath, 'utf8'), CONF)
  })

  it('an NFS create whose path PVE claimed while the job waited fails, exports untouched', async () => {
    for (const k of ENV)
      saved[k] = process.env[k]
    dir = mkdtempSync(join(tmpdir(), 'anas-cr3-shares-'))
    const exportsPath = join(dir, 'exports')
    writeFileSync(exportsPath, '', 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath
    server = createServer({ mock: true, logger: false })
    const cfg = rootNode(server)
    process.env.ANAS_STORAGE_CFG = cfg.unclaimed
    const release = holdSlots(server)
    const res = await server.inject({ method: 'POST', url: '/v1/shares/nfs', headers: JSON_HEADERS, payload: { path: '/rpool/data', clients: [{ spec: '10.0.0.0/24', options: ['rw'] }] } })
    assert.equal(res.statusCode, 202, res.body)
    process.env.ANAS_STORAGE_CFG = cfg.claimed
    release()
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(readFileSync(exportsPath, 'utf8'), '')
  })
})

// --- L8 + INVENTED-STATE-M6 + the core handoff: smbstatus and the binding ---

const SMB_CONF_LIVE = [
  '[global]',
  '\tworkgroup = WG',
  '\tinterfaces = lo eth0',
  '\tbind interfaces only = yes',
  '',
  '[media]',
  '\tpath = /tank/media',
  '',
  '[archive]',
  '\tpath = /tank/archive',
  '',
].join('\n')

/** smbstatus answers with a failure on both forms (exit 1, nothing read). */
function smbstatusFails(s: ReturnType<typeof createServer>): void {
  const mock = (s as unknown as { executor: MockExecutor }).executor
  for (const args of [['--json'], ['-S']])
    mock.prependFixture({ command: '/usr/bin/smbstatus', args, result: { stdout: '', stderr: 'smbstatus: failed to open sessionid.tdb', exitCode: 1 } })
}

/**
 * smbstatus answers nobody connected on its first read, then the dev mock's
 * one client on [media] (its own `--json` reply shape) on every later one.
 */
function smbstatusEmptyThenConnected(s: ReturnType<typeof createServer>): void {
  const mock = (s as unknown as { executor: MockExecutor }).executor
  const reply = (sessions: object, tcons: object) => ({ stdout: JSON.stringify({ sessions, tcons }), stderr: '', exitCode: 0 })
  mock.prependFixture({ command: '/usr/bin/smbstatus', args: ['--json'], results: [
    reply({}, {}),
    reply({ 3410950666: { username: 'media', remote_machine: '10.0.0.50', hostname: 'ipv4:10.0.0.50:49610' } }, { 3813605233: { service: 'media', session_id: '3410950666', machine: '10.0.0.50' } }),
  ] })
}

describe('INVENTED-STATE-M6 — the list carries the real connection count, unknown when unread', () => {
  it('each SMB row carries its live count from one smbstatus read', async () => {
    const { s } = start(SMB_CONF_LIVE)
    const res = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
    const rows = (res.json() as { data: { name: string, activeConnections?: number | null }[] }).data
    // The dev mock's smbstatus capture: one client on media, none on archive.
    assert.equal(rows.find(r => r.name === 'media')?.activeConnections, 1)
    assert.equal(rows.find(r => r.name === 'archive')?.activeConnections, 0)
    const mock = (s as unknown as { executor: MockExecutor }).executor
    assert.equal(mock.calls.filter(c => c.command === '/usr/bin/smbstatus' && c.args[0] === '--json').length, 1)
  })

  it('a failed smbstatus reads null (unknown) on every row, never 0', async () => {
    const { s } = start(SMB_CONF_LIVE)
    smbstatusFails(s)
    const res = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
    for (const row of (res.json() as { data: { activeConnections?: number | null }[] }).data)
      assert.equal(row.activeConnections, null)
  })

  it('a node without samba (smbstatus ENOENT) has nobody connected — 0, not unknown', async () => {
    const { s } = start(SMB_CONF_LIVE)
    const mock = (s as unknown as { executor: MockExecutor }).executor
    for (const args of [['--json'], ['-S']])
      mock.prependFixture({ command: '/usr/bin/smbstatus', args, throws: Object.assign(new Error('spawn /usr/bin/smbstatus ENOENT'), { code: 'ENOENT' }) })
    const res = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
    for (const row of (res.json() as { data: { activeConnections?: number | null }[] }).data)
      assert.equal(row.activeConnections, 0)
  })

  it('the detail says when its empty connection list is unknown', async () => {
    const { s } = start(SMB_CONF_LIVE)
    smbstatusFails(s)
    const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/media' })
    const data = (res.json() as { data: { connections: unknown[], connectionsUnknown?: boolean, activeConnections?: number | null } }).data
    assert.deepEqual(data.connections, [])
    assert.equal(data.connectionsUnknown, true)
    assert.equal(data.activeConnections, null)
  })

  it('the remove confirm says the connections could not be read', async () => {
    const { s } = start(SMB_CONF_LIVE)
    smbstatusFails(s)
    const res = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/media', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    assert.ok((res.json() as { error: { warnings: string[] } }).error.warnings.some(w => w.includes('could not be read')))
  })
})

describe('L8 + core handoff — the interface-binding confirm', () => {
  const put = (s: ReturnType<typeof createServer>, body: unknown, code?: string) => s.inject({
    method: 'PUT',
    url: '/v1/shares/smb/global',
    headers: { ...JSON_HEADERS, ...(code ? { 'x-anas-confirm': code } : {}) },
    payload: body as Record<string, unknown>,
  })

  it('a failed smbstatus read is unknown, and unknown confirms', async () => {
    const { s, confPath } = start(SMB_CONF_LIVE)
    smbstatusFails(s)
    const res = await put(s, { interfaces: ['lo'] })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok((res.json() as { error: { warnings: string[] } }).error.warnings.some(w => w.includes('could not be read')))
    assert.equal(readFileSync(confPath, 'utf8'), SMB_CONF_LIVE)
  })

  it('a code minted for one interface list does not confirm another', async () => {
    const { s, confPath } = start(SMB_CONF_LIVE)
    const first = await put(s, { interfaces: ['lo'] })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    const other = await put(s, { interfaces: ['eth0'] }, code)
    assert.equal(other.statusCode, 409)
    assert.equal(other.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.equal(readFileSync(confPath, 'utf8'), SMB_CONF_LIVE)
  })

  it('the code minted for the list confirms that list', async () => {
    const { s, confPath } = start(SMB_CONF_LIVE)
    const first = await put(s, { interfaces: ['lo'] })
    const res = await put(s, { interfaces: ['lo'] }, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(readFileSync(confPath, 'utf8').includes('\tinterfaces = lo\n'))
  })

  it('clients that connect while an unconfirmed binding change waits refuse the job (ruling (j))', async () => {
    const { s, confPath } = start(SMB_CONF_LIVE)
    smbstatusEmptyThenConnected(s)
    const queue = (s as unknown as { jobQueue: { submit: (t: string, o: unknown, f: () => Promise<void>) => unknown } }).jobQueue
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const res = await put(s, { interfaces: ['lo'] })
    assert.equal(res.statusCode, 202, res.body)
    // Somebody connects while the job waits (smbstatus's next answer).
    release()
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(JSON.stringify(job.error), /appeared after the request was accepted/)
    assert.equal(readFileSync(confPath, 'utf8'), SMB_CONF_LIVE)
  })
})

describe('a share whose name ANAS cannot address is listed, not managed (cr3.shares review)', () => {
  it('[My Space] and [ public] carry unmanagedName; an ordinary share does not', async () => {
    const { s } = start('[global]\n\tworkgroup = WG\n\n[My Space]\n\tpath = /srv/m\n\n[ public]\n\tpath = /srv/p\n\n[media]\n\tpath = /srv/media\n')
    const rows = ((await s.inject({ method: 'GET', url: '/v1/shares/smb' })).json() as { data: { name: string, unmanagedName?: boolean }[] }).data
    assert.deepEqual(rows.map(r => [r.name, r.unmanagedName === true]), [['My Space', true], [' public', true], ['media', false]])
  })
})
