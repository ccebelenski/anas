import type { AccessEntry, DatasetAccess, Job, JobAccepted } from '@anas/shared'
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
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'
import { AHR_FINDMNT_ARGS } from '../../services/ahr-topology.js'

/**
 * access.2 — the AHR permissions editor runs the SAME writer as the ZFS editor
 * (routes/__tests__/access.test.ts), so this file walks the same scenario
 * matrix against the dev mock's AHR pool `ahr0` (mounted at
 * /mnt/anas-ahr/ahr0, a fresh btrfs directory: mode 755, no extended ACL).
 * Expected argv are written out by hand from the ZFS suite's, with the one
 * difference the filesystem forces: there is NO acltype step — no `zfs get
 * acltype`, no `zfs set` — because btrfs carries POSIX ACLs natively.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const POOL = 'ahr0'
const MP = '/mnt/anas-ahr/ahr0'
const URL = `/v1/ahr/${POOL}/access`

/** A live ACL on the pool's mount with one named user (alice rwx) and a default ACL. */
const GETFACL_WITH_ALICE = [
  'user::rwx',
  'user:alice:rwx',
  'group::r-x',
  'mask::rwx',
  'other::---',
  'default:user::rwx',
  'default:user:alice:rwx',
  'default:group::r-x',
  'default:mask::rwx',
  'default:other::---',
  '',
].join('\n')

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

interface Call { command: string, args: string[] }
interface Stub { command: string, args?: string[], result: ExecResult }

/** Record every command and answer the stubs first (the access.test.ts seam). */
function installExecutor(server: ReturnType<typeof createServer>, stubs: Stub[] = []): Call[] {
  const mock = (server as any).executor as MockExecutor
  const calls: Call[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    const stub = stubs.find(s =>
      s.command === command
      && (s.args === undefined
        || (s.args.length === args.length && s.args.every((a, i) => a === args[i]))),
    )
    if (stub)
      return stub.result
    return orig(command, args)
  }
  return calls
}

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function find(calls: Call[], command: string, pred: (a: string[]) => boolean): string[] | undefined {
  return calls.find(c => c.command === command && pred(c.args))?.args
}

/** The filesystem difference, asserted on every scenario: nothing ZFS ever runs. */
function assertNoAcltypeStep(calls: Call[]): void {
  assert.equal(find(calls, '/usr/sbin/zfs', a => a.includes('acltype') || a.includes('acltype=posixacl')), undefined, 'no zfs acltype get/set on an AHR target')
  assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined, 'never `zfs set` on a non-ZFS target')
}

describe('access.2 — AHR permissions editor (GET/PUT /v1/ahr/:name/access)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  const savedStorage = process.env.ANAS_STORAGE_CFG

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-access-'))
    // No PVE storage by default (the file is absent → a node without PVE).
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (savedStorage === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = savedStorage
  })

  const put = (body: unknown) => server!.inject({ method: 'PUT', url: URL, headers: JSON_HEADERS, payload: JSON.stringify(body) })

  // --- GET ------------------------------------------------------------------
  describe('GET', () => {
    it('ahr GET maps a live POSIX ACL into base + named entries, with no acltype read', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(GETFACL_WITH_ALICE) }])

      const res = await server.inject({ method: 'GET', url: URL, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclSupported, true)
      // btrfs: POSIX ACLs are on by default — enabled without any switch.
      assert.equal(data.aclEnabled, true)
      assert.equal(data.backing, 'ahr')
      assert.equal(data.owner, 'root')
      const byKind = (kind: string, name?: string) => data.entries.find((e: AccessEntry) => e.kind === kind && e.name === name)
      assert.equal(byKind('owner')?.level, 'read-write')
      assert.equal(byKind('owning-group')?.level, 'read')
      assert.equal(byKind('everyone')?.level, 'none')
      assert.equal(byKind('user', 'alice')?.level, 'read-write')
      assertNoAcltypeStep(calls)
    })

    it('ahr GET of a fresh pool reads the base three from its ACL (755 → rw / r / r)', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server)
      const res = await server.inject({ method: 'GET', url: URL, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.entries.length, 3)
      assert.equal(data.entries.find(e => e.kind === 'owner')?.level, 'read-write')
      assert.equal(data.entries.find(e => e.kind === 'owning-group')?.level, 'read')
      assert.equal(data.entries.find(e => e.kind === 'everyone')?.level, 'read')
      assert.ok(data.aclText?.includes('# file: /mnt/anas-ahr/ahr0'))
    })

    it('ahr GET flags a named entry whose uid no longer resolves as unresolved', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok('user::rwx\nuser:1002:r-x\ngroup::r-x\nmask::rwx\nother::---\n') }])
      const { data } = (await server.inject({ method: 'GET', url: URL, headers: IDENTITY_HEADERS })).json() as { data: DatasetAccess }
      const orphan = data.entries.find(e => e.kind === 'user' && e.name === '1002')
      assert.equal(orphan?.unresolved, true)
      assert.equal(orphan?.level, 'read')
    })

    it('ahr GET reports an unreadable ACL as degraded, never as healthy ACLs', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['-pcE', MP], result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } }])
      const { data } = (await server.inject({ method: 'GET', url: URL, headers: IDENTITY_HEADERS })).json() as { data: DatasetAccess }
      assert.equal(data.aclDegraded, true)
      assert.equal(data.aclEnabled, false)
      assert.equal(data.entries.length, 3)
    })

    it('ahr GET 404s for an unknown pool and for an unmounted one', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(JSON.stringify({ filesystems: [] })) }])
      // lsblk is the topology's mount fallback — blank the pool's mountpoint
      // there too, so the pool reads unmounted.
      const mock = (server as any).executor as MockExecutor
      const inner = mock.exec.bind(mock)
      mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
        const r = await inner(command, args)
        return command === '/usr/bin/lsblk' ? { ...r, stdout: r.stdout.split(`"${MP}"`).join('null') } : r
      }
      const unknown = await server.inject({ method: 'GET', url: '/v1/ahr/nope/access', headers: IDENTITY_HEADERS })
      assert.equal(unknown.statusCode, 404)
      const unmounted = await server.inject({ method: 'GET', url: URL, headers: IDENTITY_HEADERS })
      assert.equal(unmounted.statusCode, 404)
      assert.match(unmounted.json().error.message, /not a mounted filesystem/)
    })
  })

  // --- PUT: base only ---------------------------------------------------------
  describe('PUT — base only', () => {
    it('ahr base-only update issues a single chmod and no ACL commands', async () => {
      server = createServer({ mock: true, logger: false })
      // A directory with no extended ACL (the mock's fresh pool).
      const calls = installExecutor(server)
      const res = await put({ entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'owning-group', level: 'read' },
        { kind: 'everyone', level: 'none' },
      ] })
      assert.equal(res.statusCode, 202)
      assert.equal((res.json() as JobAccepted).job.operation, 'fs.setAccess')
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(find(calls, '/usr/bin/chmod', () => true), ['750', MP])
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      assert.deepEqual((job.result as { pool: string, mountpoint: string }).pool, POOL)
      assertNoAcltypeStep(calls)
    })

    it('ahr recursive base-only chmod uses symbolic X, not a blanket numeric +x', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await put({
        entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
        ],
        applyToExisting: true,
      })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a[0] === '-R'), ['-R', 'u=rwX,g=rX,o=rX', MP])
      assertNoAcltypeStep(calls)
    })

    it('ahr: an omitted owning-group falls back to group::, not the ACL mask', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [
        { command: '/usr/bin/stat', args: ['-c', '%U %G %a', MP], result: ok('root root 775\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok('user::rwx\ngroup::r-x\nmask::rwx\nother::---\n') },
      ])
      const res = await put({ entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'everyone', level: 'none' },
        { kind: 'user', name: 'alice', level: 'read-write' },
      ] })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx', MP])
    })
  })

  // --- PUT: named grant ---------------------------------------------------------
  describe('PUT — named grant', () => {
    it('ahr named grant sets the access + default ACL and setgid, with NO acltype step', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await put({ entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'owning-group', level: 'read' },
        { kind: 'everyone', level: 'none' },
        { kind: 'user', name: 'alice', level: 'read-write' },
      ] })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      // Native ACLs: nothing to auto-enable.
      assert.equal((job.result as { aclAutoEnabled: boolean }).aclAutoEnabled, false)
      const spec = 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx'
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', spec, MP])
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-d'), ['-d', '--set', spec, MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g+s')), ['g+s', MP])
      assertNoAcltypeStep(calls)
    })

    it('ahr named grant fails the job clearly when the acl package is absent', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['--version'], result: { stdout: '', stderr: 'not found', exitCode: 127 } }])
      const res = await put({ entries: [{ kind: 'user', name: 'alice', level: 'read-write' }] })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /acl package/)
    })
  })

  // --- PUT: clearNamed + the #37 guard -------------------------------------------
  describe('PUT — remove named / implicit-clear guard', () => {
    it('ahr clearNamed clears the ACL, drops setgid, then chmods', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(GETFACL_WITH_ALICE) }])
      const res = await put({ clearNamed: true, entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'owning-group', level: 'read' },
        { kind: 'everyone', level: 'read' },
      ] })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { clearedNamed: boolean }).clearedNamed, true)
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), ['-b', '-k', MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g-s')), ['g-s', MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('755')), ['755', MP])
    })

    it('ahr recursive clear folds the setgid drop into a single chmod -R', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(GETFACL_WITH_ALICE) }])
      const res = await put({ clearNamed: true, applyToExisting: true, entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'owning-group', level: 'read' },
        { kind: 'everyone', level: 'read' },
      ] })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), ['-R', '-b', '-k', MP])
      const chmodR = calls.filter(c => c.command === '/usr/bin/chmod' && c.args[0] === '-R')
      assert.equal(chmodR.length, 1)
      assert.deepEqual(chmodR[0].args, ['-R', 'u=rwX,g=rX,o=rX,g-s', MP])
    })

    it('ahr base-only update with no named entries LEAVES existing named ACLs alone (#37)', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(GETFACL_WITH_ALICE) }])
      const res = await put({ entries: [
        { kind: 'owner', level: 'read-write' },
        { kind: 'owning-group', level: 'read' },
        { kind: 'everyone', level: 'none' },
      ] })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.equal(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), undefined)
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx', MP])
      assert.equal((job.result as { namedCount: number }).namedCount, 1)
    })

    it('ahr owner-only update touches neither the ACL nor the mode bits', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await put({ owner: 'media' })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(find(calls, '/usr/bin/chown', () => true), ['media', MP])
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      assert.equal(find(calls, '/usr/bin/chmod', () => true), undefined)
    })
  })

  // --- PUT: applyToExisting -------------------------------------------------------
  describe('PUT — applyToExisting', () => {
    it('ahr applyToExisting adds -R to chown, setfacl (access + default) and chmod g+s — the whole @data tree', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await put({
        owner: 'media',
        entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
          { kind: 'user', name: 'alice', level: 'read' },
        ],
        applyToExisting: true,
      })
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(find(calls, '/usr/bin/chown', () => true), ['-R', 'media', MP])
      const spec = 'u::rwx,g::r-X,o::r-X,u:alice:r-X,m::rwx'
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '--set'), ['-R', '--set', spec, MP])
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '-d'), ['-R', '-d', '--set', spec, MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g+s')), ['-R', 'g+s', MP])
      // The walk starts at the mount (@data); @snapshots is a sibling subvolume
      // outside it, so no command ever names a snapshot path.
      assert.equal(calls.some(c => c.args.some(a => a.includes('@snapshots'))), false)
      assertNoAcltypeStep(calls)
    })

    it('ahr applyToExisting is refused when a PVE storage path sits inside the tree; the flat change is not', async () => {
      await writeFile(join(dir, 'storage.cfg'), `dir: ahrvz\n\tpath ${MP}/vz\n\tcontent images\n`, 'utf8')
      process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const refused = await put({ owner: 'media', applyToExisting: true })
      assert.equal(refused.statusCode, 400)
      assert.match(refused.json().error.message, /Recursive permission change of '\/mnt\/anas-ahr\/ahr0' would include \/mnt\/anas-ahr\/ahr0\/vz/)
      assert.match(refused.json().error.message, /ahrvz/)
      assert.equal(find(calls, '/usr/bin/chown', () => true), undefined, 'nothing ran')
      const flat = await put({ owner: 'media' })
      assert.equal(flat.statusCode, 202)
    })

    it('ahr mount at a PVE storage path is PVE\'s to manage → 400, nothing runs', async () => {
      await writeFile(join(dir, 'storage.cfg'), `dir: ahrstore\n\tpath ${MP}\n\tcontent backup\n`, 'utf8')
      process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await put({ owner: 'media' })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /PVE storage 'ahrstore'/)
      assert.equal(find(calls, '/usr/bin/chown', () => true), undefined)
    })
  })

  // --- held-by-LUN ------------------------------------------------------------------
  describe('PUT — held by an iSCSI LUN', () => {
    const saved = {
      configfs: process.env.ANAS_ISCSI_CONFIGFS,
      block: process.env.ANAS_ISCSI_SYS_BLOCK,
      saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    }
    afterEach(() => {
      for (const [key, value] of [['ANAS_ISCSI_CONFIGFS', saved.configfs], ['ANAS_ISCSI_SYS_BLOCK', saved.block], ['ANAS_ISCSI_SAVECONFIG', saved.saveconfig]] as const) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    })

    it('ahr access change on a pool a LUN image lives on → 409 held-by-lun, nothing runs', async () => {
      // The real LIO capture, with its fileio LUN's image moved onto ahr0.
      const manifest = readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8')
        .split('/gtiscsi/images/lun2.raw')
        .join(`${MP}/images/block1.raw`)
      const root = join(dir, 'target')
      await materializeConfigfsManifest(manifest, root)
      process.env.ANAS_ISCSI_CONFIGFS = root
      process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
      process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')

      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)
      const res = await put({ entries: [{ kind: 'everyone', level: 'read' }] })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.reason, 'held-by-lun')
      assert.match(res.json().error.message, /permissions of AHR pool 'ahr0'/)
      assert.match(res.json().error.message, /no confirm bypass/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(find(calls, '/usr/bin/chmod', () => true), undefined)
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      // The read is never gated — the editor opens and shows the state.
      const read = await server.inject({ method: 'GET', url: URL, headers: IDENTITY_HEADERS })
      assert.equal(read.statusCode, 200)
    })
  })

  it('ahr PUT refuses a body that names clearNamed together with named entries (shared schema)', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await put({ clearNamed: true, entries: [{ kind: 'user', name: 'alice', level: 'read' }] })
    assert.equal(res.statusCode, 400)
  })
})
