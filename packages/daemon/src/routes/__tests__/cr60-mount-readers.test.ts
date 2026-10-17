import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'

/**
 * Story cr.60 (review L26) over the REAL routes and the fake executor: the
 * mount-family findmnt readers agree on stacked mounts (the TOP real row
 * wins, everywhere) and every gate honours findmnt's exit status — a table
 * that cannot be read refuses, it is never "nothing mounted".
 *
 * FIXTURES (ruling (l)): fstab is `mounts/fstab-anas-managed`
 * (`127.0.0.1:/srv/nfs/export1 /mnt/anas-nfs nfs4 defaults,nofail`); the
 * stacked table is the captured `findmnt --json /mnt/anas-nfs` row
 * (`mounts/findmnt-nfs.json`) with a second copy stacked over it as its child
 * (the shape `mounts/findmnt-full.json` shows for a stacked mount), its
 * options flipped `rw`→`ro` where the scenario needs the two to differ; the
 * armed automount is `mounts/findmnt-automount-armed.json`. A failed findmnt
 * is exit 1 with the captured full table still on stdout — the exit status,
 * not the bytes, decides.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const FINDMNT = '/usr/bin/findmnt'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const ZPOOL = '/usr/sbin/zpool'
const NFS_MP = '/mnt/anas-nfs'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const NFS_ROW = (JSON.parse(fixture('mounts/findmnt-nfs.json')) as { filesystems: Array<Record<string, string>> }).filesystems[0]
const RO = NFS_ROW.options.replace(/^rw,/, 'ro,')

/** Two NFS mounts stacked at /mnt/anas-nfs; the bottom keeps the captured `rw`. */
function stacked(topOptions: string): string {
  return JSON.stringify({ filesystems: [{ ...NFS_ROW, children: [{ ...NFS_ROW, options: topOptions }] }] })
}

const enc = (p: string): string => encodeURIComponent(p)

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('cr.60 — the mount-family findmnt readers (review L26) and the strict storage.cfg reader', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let calls: { command: string, args: string[] }[]
  /** What `findmnt --json` answers now (a function: a test scripts the table under the job). */
  let table: () => ExecResult

  function serve(): ReturnType<typeof createServer> {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === FINDMNT && args.join(' ') === '--json')
        return table()
      return orig(command, args, opts)
    }
    return server
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr60-'))
    await writeFile(join(dir, 'fstab'), fixture('mounts/fstab-anas-managed'))
    process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage.cfg')
    table = () => ({ stdout: fixture('mounts/findmnt-full.json'), stderr: '', exitCode: 0 })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    await rm(dir, { recursive: true, force: true })
  })

  it('an edit of a STACKED mount proves delivery against the top row the kernel serves (the bottom stays rw)', async () => {
    const s = serve()
    let remounted = false
    table = () => ({ stdout: stacked(remounted ? RO : NFS_ROW.options), stderr: '', exitCode: 0 })
    const mock = (s as unknown as { executor: MockExecutor }).executor
    // A busy target: the unmount is refused, so the job remounts in place and
    // reads the live options back; the remount changes the TOP mount only.
    mock.prependFixture({ command: UMOUNT, args: [NFS_MP], result: { stdout: '', stderr: `umount: ${NFS_MP}: target is busy.`, exitCode: 32 } })
    const realExec = mock.exec
    mock.exec = async (command, args, opts) => {
      if (command === MOUNT && args.join(' ') === `-o remount -- ${NFS_MP}`)
        remounted = true
      return realExec(command, args, opts)
    }
    const res = await s.inject({ method: 'PUT', url: `/v1/mounts/${enc(NFS_MP)}`, headers: JSON_HEADERS, payload: JSON.stringify({ options: { ro: true } }) })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(remounted, 'the busy path remounted in place')
    assert.ok(!calls.some(c => c.command === MOUNT && c.args.join(' ') === `-c -- ${NFS_MP}`), 'never mounted over a busy target')
  })

  it('a findmnt that exits non-zero refuses every target verb 503 at the route — never "not mounted"', async () => {
    const s = serve()
    table = () => ({ stdout: fixture('mounts/findmnt-full.json'), stderr: 'findmnt: failed', exitCode: 1 })
    const reqs = [
      { method: 'POST' as const, url: `/v1/mounts/${enc(NFS_MP)}/state`, payload: { action: 'unmount' } },
      { method: 'POST' as const, url: `/v1/mounts/${enc(NFS_MP)}/state`, payload: { action: 'mount' } },
      { method: 'POST' as const, url: `/v1/mounts/${enc(NFS_MP)}/state`, payload: { action: 'disable' } },
      { method: 'PUT' as const, url: `/v1/mounts/${enc(NFS_MP)}`, payload: { options: { ro: true } } },
      { method: 'DELETE' as const, url: `/v1/mounts/${enc(NFS_MP)}`, payload: undefined },
    ]
    for (const r of reqs) {
      const res = await s.inject({ method: r.method, url: r.url, headers: r.payload ? JSON_HEADERS : IDENTITY_HEADERS, ...(r.payload ? { payload: JSON.stringify(r.payload) } : {}) })
      assert.equal(res.statusCode, 503, `${r.method} ${r.url} ${JSON.stringify(r.payload)}: ${res.body}`)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'UNAVAILABLE')
      assert.match(error.message, /could not read the kernel mount table/)
    }
    assert.ok(!calls.some(c => c.command === UMOUNT || c.command === MOUNT), 'nothing was mounted or unmounted')
  })

  it('enable touches fstab alone and is not refused by an unreadable table', async () => {
    // cr.60r: with no zfspool storage the table decides nothing about PVE
    // territory either — the captured pve/storage.cfg minus its zfspool stanza.
    await writeFile(join(dir, 'storage.cfg'), fixture('pve/storage.cfg').split('\n\n').filter(st => !st.startsWith('zfspool:')).join('\n\n'))
    process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
    const s = serve()
    // Disable the line first (a readable table), then lose the table.
    const disable = async (code?: string) => s.inject({ method: 'POST', url: `/v1/mounts/${enc(NFS_MP)}/state`, headers: { ...JSON_HEADERS, ...(code ? { 'x-anas-confirm': code } : {}) }, payload: JSON.stringify({ action: 'disable' }) })
    let off = await disable()
    if (off.statusCode === 409 && off.headers['x-anas-confirm-code'])
      off = await disable(off.headers['x-anas-confirm-code'] as string)
    assert.equal(off.statusCode, 202, off.body)
    assert.equal((await waitForJob(s, (off.json() as JobAccepted).job.id)).status, 'completed')
    table = () => ({ stdout: '', stderr: 'findmnt: failed', exitCode: 1 })
    const on = await s.inject({ method: 'POST', url: `/v1/mounts/${enc(NFS_MP)}/state`, headers: JSON_HEADERS, payload: JSON.stringify({ action: 'enable' }) })
    assert.equal(on.statusCode, 202, on.body)
    assert.equal((await waitForJob(s, (on.json() as JobAccepted).job.id)).status, 'completed')
  })

  // --- cr.60r (review possible 3): a zfspool dataset's LIVE mountpoint is PVE
  // territory at the mount doors too, read from the verbs' one strict table.

  /** The captured full table plus one zfs row cloned from its `mnttest` row: local-zfs's dataset moved to /mnt/zp2. */
  function movedLocalZfs(): string {
    const t = JSON.parse(fixture('mounts/findmnt-full.json')) as { filesystems: Array<{ children?: Array<Record<string, unknown>> }> }
    const captured = t.filesystems[0].children!.find(c => c.fstype === 'zfs' && c.source === 'mnttest')!
    t.filesystems[0].children!.push({ target: '/mnt/zp2', source: 'rpool/data', fstype: 'zfs', options: captured.options })
    return JSON.stringify(t)
  }

  it('cr.60r: the create door refuses the LIVE path of a zfspool dataset, and a hand-written line there is hands-off', async () => {
    // The mount doors match a claim EXACTLY (pveStorageFor — the inventory's
    // tagging rule); the restore's territory gate is the prefix door.
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage-zfsroot.cfg')
    await writeFile(join(dir, 'fstab'), `${fixture('mounts/fstab-anas-managed')}127.0.0.1:/srv/nfs/export1  /mnt/zp2  nfs4  defaults,nofail  0  0\n`)
    table = () => ({ stdout: movedLocalZfs(), stderr: '', exitCode: 0 })
    const s = serve()
    const create = await s.inject({ method: 'POST', url: '/v1/mounts', headers: JSON_HEADERS, payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: '/mnt/zp2', persistent: false }) })
    assert.equal(create.statusCode, 400, create.body)
    assert.match((create.json() as { error: { message: string } }).error.message, /belongs to a PVE storage/)
    const disable = await s.inject({ method: 'POST', url: `/v1/mounts/${enc('/mnt/zp2')}/state`, headers: JSON_HEADERS, payload: JSON.stringify({ action: 'disable' }) })
    assert.equal(disable.statusCode, 400, disable.body)
    assert.match((disable.json() as { error: { message: string } }).error.message, /PVE-owned \(hands-off\)/)
    // The config default stays claimed beside the live path.
    const atDefault = await s.inject({ method: 'POST', url: '/v1/mounts', headers: JSON_HEADERS, payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: '/rpool/data', persistent: false }) })
    assert.equal(atDefault.statusCode, 400, atDefault.body)
    assert.match((atDefault.json() as { error: { message: string } }).error.message, /belongs to a PVE storage/)
    assert.equal(calls.filter(c => c.command === FINDMNT).length > 0, true, 'the claim came from the table')
    assert.ok(!calls.some(c => c.command === MOUNT || c.command === UMOUNT), 'nothing was mounted or unmounted')
  })

  it('cr.60r: with a zfspool configured, an unreadable table refuses the create door and enable 503 naming the read', async () => {
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage-zfsroot.cfg')
    table = () => ({ stdout: movedLocalZfs(), stderr: 'findmnt: failed', exitCode: 1 })
    const s = serve()
    const reqs = [
      { url: '/v1/mounts', payload: { type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: '/mnt/zp2', persistent: false } },
      { url: `/v1/mounts/${enc(NFS_MP)}/state`, payload: { action: 'enable' } },
    ]
    for (const r of reqs) {
      const res = await s.inject({ method: 'POST', url: r.url, headers: JSON_HEADERS, payload: JSON.stringify(r.payload) })
      assert.equal(res.statusCode, 503, `${r.url}: ${res.body}`)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'UNAVAILABLE')
      assert.match(error.message, /could not read the kernel mount table \(findmnt\).*PVE's ZFS storage datasets/)
    }
    assert.ok(!calls.some(c => c.command === MOUNT || c.command === UMOUNT), 'nothing was mounted or unmounted')
  })

  // --- folded from cr.54's report: the mount verbs' PVE gate reads storage.cfg
  // STRICTLY, and a zfspool with no `mountpoint` claims /<pool dataset>.

  it('an UNREADABLE storage.cfg refuses every mount verb and the create door with the config-unreadable verdict — never "not PVE\'s"', async () => {
    // A directory where the file should be: readFile fails EISDIR, the
    // stand-in for pmxcfs being down. Before cr.60 this read as an empty map.
    process.env.ANAS_STORAGE_CFG = dir
    const s = serve()
    const reqs = [
      { method: 'POST' as const, url: `/v1/mounts/${enc(NFS_MP)}/state`, payload: { action: 'unmount' } },
      { method: 'POST' as const, url: `/v1/mounts/${enc(NFS_MP)}/state`, payload: { action: 'enable' } },
      { method: 'PUT' as const, url: `/v1/mounts/${enc(NFS_MP)}`, payload: { options: { ro: true } } },
      { method: 'DELETE' as const, url: `/v1/mounts/${enc(NFS_MP)}`, payload: undefined },
      { method: 'POST' as const, url: '/v1/mounts', payload: { type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: join(dir, 'new'), persistent: false } },
    ]
    for (const r of reqs) {
      const res = await s.inject({ method: r.method, url: r.url, headers: r.payload ? JSON_HEADERS : IDENTITY_HEADERS, ...(r.payload ? { payload: JSON.stringify(r.payload) } : {}) })
      assert.equal(res.statusCode, 400, `${r.method} ${r.url}: ${res.body}`)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.match(error.message, /PVE storage configuration is unreadable .* cannot be checked against the paths PVE storage claims/)
    }
    assert.ok(!calls.some(c => c.command === UMOUNT || c.command === MOUNT), 'nothing was mounted or unmounted')
  })

  it('local-zfs with no `mountpoint` (the installer default): a mount at /rpool/data is PVE\'s — create refuses, a hand-written line is hands-off', async () => {
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage-zfsroot.cfg')
    await writeFile(join(dir, 'fstab'), `${fixture('mounts/fstab-anas-managed')}127.0.0.1:/srv/nfs/export1  /rpool/data  nfs4  defaults,nofail  0  0\n`)
    const s = serve()
    const create = await s.inject({ method: 'POST', url: '/v1/mounts', headers: JSON_HEADERS, payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: '/rpool/data', persistent: false }) })
    assert.equal(create.statusCode, 400, create.body)
    assert.match((create.json() as { error: { message: string } }).error.message, /belongs to a PVE storage/)
    const unmount = await s.inject({ method: 'POST', url: `/v1/mounts/${enc('/rpool/data')}/state`, headers: JSON_HEADERS, payload: JSON.stringify({ action: 'disable' }) })
    assert.equal(unmount.statusCode, 400, unmount.body)
    assert.match((unmount.json() as { error: { message: string } }).error.message, /PVE-owned \(hands-off\)/)
  })

  it('pool create: an unreadable table refuses 503 and never runs zpool create', async () => {
    const s = serve()
    serveBlankInventoryDisks(s, ['d1', 'd2'])
    table = () => ({ stdout: fixture('mounts/findmnt-full.json'), stderr: 'findmnt: failed', exitCode: 1 })
    const res = await s.inject({ method: 'POST', url: '/v1/pools', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }], mountpoint: '/srv/tank' }) })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'UNAVAILABLE')
    assert.ok(!calls.some(c => c.command === ZPOOL && c.args[0] === 'create'))
  })

  it('pool create: an ARMED automount placeholder at the path is a live mountpoint (`--real` hid it)', async () => {
    const s = serve()
    serveBlankInventoryDisks(s, ['d1', 'd2'])
    table = () => ({ stdout: fixture('mounts/findmnt-automount-armed.json'), stderr: '', exitCode: 0 })
    const res = await s.inject({ method: 'POST', url: '/v1/pools', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }], mountpoint: '/mnt/anas-auto' }) })
    assert.equal(res.statusCode, 409, res.body)
    assert.match((res.json() as { error: { message: string } }).error.message, /'\/mnt\/anas-auto' is already a mountpoint/)
    assert.ok(!calls.some(c => c.command === ZPOOL && c.args[0] === 'create'))
  })
})
