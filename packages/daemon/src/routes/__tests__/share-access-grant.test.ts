import type { DatasetAccess, Job, JobAccepted, ShareAccessGrantResult } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { zfsListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { sharePrincipals } from '../../services/access.js'
import { grantRelevantChange } from '../shares-smb.js'

/**
 * access.1 (GitHub #75) — creating or editing an SMB share grants the selected
 * principals access on the share path through the SAME writer the
 * Permissions editor runs. Expected argv are derived by hand from the rule:
 * each `valid users` principal → a named entry at rwx (r-x on a read-only
 * share), guest → Everyone at the same level, owner/group untouched, every
 * existing named entry kept and never lowered, access AND default ACL.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const MP = '/testpool/media'
/** The dev mock's AHR pool mount (a fresh btrfs directory). */
const AHR_MP = '/mnt/anas-ahr/ahr0'
const ISCSI_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/iscsi')
const ACLTYPE_MEDIA = ['get', '-Hp', '-o', 'value', 'acltype', 'testpool/media']
/** The mountpoint table the path resolver reads (the default mock has none). */
const MOUNTPOINTS = 'testpool\t/testpool\ntestpool/media\t/testpool/media\ntestpool/x\t/testpool/x\ntestpool/x/data\t/testpool/x/data\n'

const BASE_CONF = [
  '[global]',
  '\tworkgroup = WORKGROUP',
  '',
].join('\n')

interface Call { command: string, args: string[] }
interface Stub { command: string, args?: string[], result: ExecResult }

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function find(calls: Call[], command: string, pred: (a: string[]) => boolean): string[] | undefined {
  return calls.find(c => c.command === command && pred(c.args))?.args
}

function datasetRow(name: string, type: 'FILESYSTEM' | 'VOLUME'): [string, unknown] {
  return [name, {
    name,
    type,
    pool: 'testpool',
    properties: {
      used: { value: '1M', source: { type: 'NONE', data: '-' } },
      available: { value: '1G', source: { type: 'NONE', data: '-' } },
      referenced: { value: '1M', source: { type: 'NONE', data: '-' } },
      mountpoint: { value: `/${name}`, source: { type: 'DEFAULT', data: '-' } },
      type: { value: type.toLowerCase(), source: { type: 'NONE', data: '-' } },
    },
  }]
}

describe('access.1 — the share-path grant', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined
  let confPath: string
  const savedStorage = process.env.ANAS_STORAGE_CFG

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (dir)
      rmSync(dir, { recursive: true, force: true })
    dir = undefined
    if (savedStorage === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = savedStorage
  })

  /** A mock server over a temp smb.conf, recording every command; stubs answer first. */
  function start(stubs: Stub[] = [], conf = BASE_CONF, storageCfg?: string): { calls: Call[] } {
    dir = mkdtempSync(join(tmpdir(), 'anas-share-grant-'))
    confPath = join(dir, 'smb.conf')
    writeFileSync(confPath, conf, 'utf8')
    if (storageCfg !== undefined) {
      writeFileSync(join(dir, 'storage.cfg'), storageCfg, 'utf8')
      process.env.ANAS_STORAGE_CFG = join(dir, 'storage.cfg')
    }
    else {
      process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    }
    server = createServer({ mock: true, logger: false, smbConfPath: confPath })
    const mock = (server as any).executor as MockExecutor
    const calls: Call[] = []
    const orig = mock.exec.bind(mock)
    const all: Stub[] = [...stubs, { command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: ok(MOUNTPOINTS) }]
    mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      const stub = all.find(s => s.command === command
        && (s.args === undefined || (s.args.length === args.length && s.args.every((a, i) => a === args[i]))))
      return stub ? stub.result : orig(command, args)
    }
    return { calls }
  }

  async function waitForJob(id: string): Promise<Job> {
    for (let i = 0; i < 100; i++) {
      const res = await server!.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
      const { job } = res.json() as { job: Job }
      if (job.status === 'completed' || job.status === 'failed')
        return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Job ${id} did not finish`)
  }

  async function create(body: Record<string, unknown>): Promise<Job> {
    const res = await server!.inject({ method: 'POST', url: '/v1/shares/smb', headers: JSON_HEADERS, payload: JSON.stringify(body) })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob((res.json() as JobAccepted).job.id)
  }

  async function update(name: string, body: Record<string, unknown>): Promise<Job> {
    const res = await server!.inject({ method: 'PUT', url: `/v1/shares/smb/${name}`, headers: JSON_HEADERS, payload: JSON.stringify(body) })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob((res.json() as JobAccepted).job.id)
  }

  /**
   * Operator ruling 2026-10-11: "apply to existing files" is the editor's
   * recursive apply and answers 409 + X-Anas-Confirm-Code first (asserted
   * here, nothing written yet); the resend with the code runs the job.
   */
  async function confirmedJob(method: 'POST' | 'PUT', url: string, body: Record<string, unknown>): Promise<Job> {
    const before = readFileSync(confPath, 'utf8')
    const first = await server!.inject({ method, url, headers: JSON_HEADERS, payload: JSON.stringify(body) })
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code']
    assert.ok(typeof code === 'string' && code.length > 0, 'the 409 carries X-Anas-Confirm-Code')
    assert.equal(readFileSync(confPath, 'utf8'), before, 'nothing written before the confirm')
    const res = await server!.inject({ method, url, headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: JSON.stringify(body) })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob((res.json() as JobAccepted).job.id)
  }

  const createConfirmed = (body: Record<string, unknown>) => confirmedJob('POST', '/v1/shares/smb', body)
  const updateConfirmed = (name: string, body: Record<string, unknown>) => confirmedJob('PUT', `/v1/shares/smb/${name}`, body)

  const grantOf = (job: Job) => (job.result as { grant?: ShareAccessGrantResult }).grant

  // --- create ------------------------------------------------------------------
  it('share create grants a named user Read-Write: access + default ACL, acltype enabled on the dataset', async () => {
    const { calls } = start()
    const job = await create({ name: 'media', path: MP, validUsers: ['media'], grantAccess: {} })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const grant = grantOf(job)!
    assert.equal(grant.status, 'applied', grant.message)
    assert.deepEqual(grant.granted, [{ kind: 'user', name: 'media', level: 'read-write' }])
    // Owner/group untouched (no chown); base levels restated from the mode (755).
    assert.equal(find(calls, '/usr/bin/chown', () => true), undefined)
    const spec = 'u::rwx,g::r-x,o::r-x,u:media:rwx,m::rwx'
    assert.deepEqual(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), ['set', 'acltype=posixacl', 'xattr=sa', 'testpool/media'])
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', spec, MP])
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-d'), ['-d', '--set', spec, MP])
    // The share itself is written first.
    assert.ok(readFileSync(confPath, 'utf8').includes('[media]'))
  })

  it('share create on a read-only share grants Read (r-x), never write', async () => {
    const { calls } = start()
    const job = await create({ name: 'media', path: MP, readOnly: true, validUsers: ['media', '@smbusers'], grantAccess: {} })
    assert.equal(grantOf(job)!.status, 'applied')
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', 'u::rwx,g::r-x,o::r-x,u:media:r-x,g:smbusers:r-x,m::rwx', MP])
  })

  it('share create with guest access gives Everyone the share\'s level (mode bits, no named rows)', async () => {
    const { calls } = start()
    const job = await create({ name: 'pub', path: MP, guestOk: true, grantAccess: {} })
    const grant = grantOf(job)!
    assert.equal(grant.status, 'applied')
    assert.deepEqual(grant.granted, [{ kind: 'everyone', level: 'read-write' }])
    // 755 → owner rw, group r, everyone rw: a single chmod, no ACL commands.
    assert.deepEqual(find(calls, '/usr/bin/chmod', () => true), ['757', MP])
    assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
  })

  it('share grant keeps existing named entries and never lowers one (alice stays rwx on a read-only share)', async () => {
    const { calls } = start([{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])
    const job = await create({ name: 'media', path: MP, readOnly: true, validUsers: ['alice', 'media'], grantAccess: {} })
    assert.equal(grantOf(job)!.status, 'applied')
    // Live ACL (server fixture): u::rwx, u:alice:rwx, g::r-x, o::---.
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', 'u::rwx,g::r-x,o::---,u:alice:rwx,u:media:r-x,m::rwx', MP])
    // Already posixacl: no switch flipped.
    assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
  })

  it('share grant applyToExisting is off by default: no command carries -R', async () => {
    const { calls } = start()
    const job = await create({ name: 'media', path: MP, validUsers: ['media'], grantAccess: {} })
    assert.equal(grantOf(job)!.applyToExisting, false)
    assert.equal(calls.some(c => ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'].includes(c.command) && c.args.includes('-R')), false)
  })

  it('share grant with applyToExisting runs the editor\'s recursive job (-R, capital X)', async () => {
    const { calls } = start()
    const job = await createConfirmed({ name: 'media', path: MP, readOnly: true, validUsers: ['media'], grantAccess: { applyToExisting: true } })
    assert.equal(grantOf(job)!.status, 'applied')
    const spec = 'u::rwx,g::r-X,o::r-X,u:media:r-X,m::rwx'
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '--set'), ['-R', '--set', spec, MP])
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '-d'), ['-R', '-d', '--set', spec, MP])
  })

  it('share grant applyToExisting on ZFS switches ACLs on for a child dataset under the path first, and lists it (ruling 2026-10-11)', async () => {
    const { calls } = start([{
      command: '/usr/sbin/zfs',
      args: ['list', '-r', '-H', '-o', 'name,mountpoint,acltype', 'testpool/media'],
      result: ok('testpool/media\t/testpool/media\toff\ntestpool/media/kids\t/testpool/media/kids\toff\n'),
    }])
    const job = await createConfirmed({ name: 'media', path: MP, validUsers: ['media'], grantAccess: { applyToExisting: true } })
    const grant = grantOf(job)!
    assert.equal(grant.status, 'applied', grant.message)
    assert.deepEqual(grant.childAclEnabled, ['testpool/media/kids'])
    const enable = calls.findIndex(c => c.command === '/usr/sbin/zfs' && c.args.join(' ') === 'set acltype=posixacl xattr=sa testpool/media/kids')
    const walk = calls.findIndex(c => c.command === '/usr/bin/setfacl' && c.args[0] === '-R')
    assert.ok(enable >= 0 && walk > enable, `child enabled (#${enable}) before the walk (#${walk})`)
  })

  it('share create without grantAccess runs no permission command and the result is unchanged', async () => {
    const { calls } = start()
    const job = await create({ name: 'media', path: MP, validUsers: ['media'] })
    assert.deepEqual(job.result, { created: 'media' })
    assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
    assert.equal(find(calls, '/usr/bin/chmod', () => true), undefined)
  })

  it('share grant skips a principal that does not resolve and a %-macro, and says so', async () => {
    const { calls } = start([{ command: '/usr/bin/getent', args: ['passwd', 'ghost'], result: { stdout: '', stderr: '', exitCode: 2 } }])
    const job = await create({ name: 'media', path: MP, validUsers: ['media', 'ghost', '%U'], grantAccess: {} })
    const grant = grantOf(job)!
    assert.equal(grant.status, 'applied')
    assert.deepEqual(grant.skipped.sort(), ['%U', 'ghost'])
    const spec = find(calls, '/usr/bin/setfacl', a => a[0] === '--set')![1]
    assert.ok(!spec.includes('ghost'), spec)
  })

  // --- PVE territory: the share is created, the grant is refused --------------------
  it('share on an AHR mount PVE uses as dir storage → share created, grant refused with the reason', async () => {
    const { calls } = start([], BASE_CONF, 'dir: ahrstore\n\tpath /mnt/anas-ahr/ahr0\n\tcontent backup\n')
    const job = await create({ name: 'bk', path: '/mnt/anas-ahr/ahr0', validUsers: ['media'], grantAccess: {} })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(readFileSync(confPath, 'utf8').includes('[bk]'), 'the share exists')
    const grant = grantOf(job)!
    assert.equal(grant.status, 'refused')
    assert.match(grant.message!, /PVE storage 'ahrstore'/)
    assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
  })

  it('share grant on an AHR pool that holds an iSCSI LUN image is applied (ruling 2026-10-11: no held-by-LUN refusal)', async () => {
    const saved = {
      configfs: process.env.ANAS_ISCSI_CONFIGFS,
      block: process.env.ANAS_ISCSI_SYS_BLOCK,
      saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    }
    // The iSCSI paths are read when the server is built, so the LIO tree
    // goes in its own temp dir before start().
    const lio = mkdtempSync(join(tmpdir(), 'anas-share-grant-lio-'))
    try {
      // The real LIO capture, with its fileio LUN's image moved onto ahr0.
      const manifest = readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8')
        .split('/gtiscsi/images/lun2.raw')
        .join(`${AHR_MP}/images/block1.raw`)
      const root = join(lio, 'target')
      await materializeConfigfsManifest(manifest, root)
      process.env.ANAS_ISCSI_CONFIGFS = root
      process.env.ANAS_ISCSI_SAVECONFIG = join(lio, 'absent-saveconfig.json')
      process.env.ANAS_ISCSI_SYS_BLOCK = join(lio, 'absent-block')
      const { calls } = start()
      // The pool really is held: its row says so.
      const pools = await server!.inject({ method: 'GET', url: '/v1/ahr', headers: IDENTITY_HEADERS })
      const row = (pools.json() as { data: { name: string, heldByLun?: { targetIqn: string } }[] }).data.find(p => p.name === 'ahr0')
      assert.ok(row?.heldByLun?.targetIqn, JSON.stringify(row))

      const job = await create({ name: 'ahrshare', path: AHR_MP, validUsers: ['media'], grantAccess: {} })
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const grant = grantOf(job)!
      assert.equal(grant.status, 'applied', grant.message)
      assert.deepEqual(grant.granted, [{ kind: 'user', name: 'media', level: 'read-write' }])
      // btrfs: native ACLs — the grant is written with no acltype step.
      assert.ok(find(calls, '/usr/bin/setfacl', a => a[0] === '--set' && a[2] === AHR_MP), 'the ACL was written on the pool mount')
      assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
    }
    finally {
      for (const [key, value] of [['ANAS_ISCSI_CONFIGFS', saved.configfs], ['ANAS_ISCSI_SYS_BLOCK', saved.block], ['ANAS_ISCSI_SAVECONFIG', saved.saveconfig]] as const) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
      rmSync(lio, { recursive: true, force: true })
    }
  })

  it('share grant applyToExisting over a PVE-owned descendant → share created, grant refused naming it', async () => {
    const nested = JSON.stringify({
      output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
      datasets: Object.fromEntries([
        datasetRow('testpool', 'FILESYSTEM'),
        datasetRow('testpool/x', 'FILESYSTEM'),
        datasetRow('testpool/x/data', 'FILESYSTEM'),
      ]),
    })
    const { calls } = start(
      [{ command: '/usr/sbin/zfs', args: zfsListArgs('testpool'), result: ok(nested) }],
      BASE_CONF,
      'zfspool: local-zfs\n\tpool testpool/x/data\n\tcontent images,rootdir\n',
    )
    const job = await createConfirmed({ name: 'x', path: '/testpool/x', validUsers: ['media'], grantAccess: { applyToExisting: true } })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(readFileSync(confPath, 'utf8').includes('[x]'))
    const grant = grantOf(job)!
    assert.equal(grant.status, 'refused')
    assert.match(grant.message!, /Recursive permission change of 'testpool\/x' would include testpool\/x\/data/)
    assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
  })

  // --- edit: grant on change, nothing revoked ---------------------------------------
  const MEDIA_SHARE = `${BASE_CONF}\n[media]\n\tpath = ${MP}\n\tread only = no\n\tguest ok = no\n\tvalid users = alice media\n`

  it('share edit that changes no principal runs no grant ("nothing")', async () => {
    const { calls } = start([], MEDIA_SHARE)
    const job = await update('media', { comment: 'Media', grantAccess: {} })
    assert.equal(grantOf(job)!.status, 'nothing')
    assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
  })

  it('share edit with no principal change but an explicit applyToExisting runs the recursive grant', async () => {
    const { calls } = start([], MEDIA_SHARE)
    const job = await updateConfirmed('media', { grantAccess: { applyToExisting: true } })
    assert.equal(grantOf(job)!.status, 'applied')
    assert.ok(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '--set'), 'the -R walk ran')
  })

  it('share edit that removes a principal revokes nothing: the live entry is restated, never stripped', async () => {
    const { calls } = start([{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }], MEDIA_SHARE)
    const job = await update('media', { validUsers: ['media'], grantAccess: {} })
    assert.equal(grantOf(job)!.status, 'applied')
    // alice is no longer selected but keeps her live rwx entry.
    assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', 'u::rwx,g::r-x,o::---,u:alice:rwx,u:media:rwx,m::rwx', MP])
    assert.equal(find(calls, '/usr/bin/setfacl', a => a.includes('-b') || a.includes('-x')), undefined)
  })

  it('share delete never touches the path\'s permissions', async () => {
    const { calls } = start([], MEDIA_SHARE)
    const first = await server!.inject({ method: 'DELETE', url: '/v1/shares/smb/media', headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const res = await server!.inject({ method: 'DELETE', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string } })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.equal(calls.some(c => ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'].includes(c.command)), false)
  })

  // --- the share row's Permissions editor ----------------------------------------------
  it('share access GET reads the share path through the editor (backing zfs)', async () => {
    start([], MEDIA_SHARE)
    const res = await server!.inject({ method: 'GET', url: '/v1/shares/smb/media/access', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: DatasetAccess }
    assert.equal(data.backing, 'zfs')
    assert.equal(data.entries.length, 3)
    const missing = await server!.inject({ method: 'GET', url: '/v1/shares/smb/nope/access', headers: IDENTITY_HEADERS })
    assert.equal(missing.statusCode, 404)
  })

  it('every share door that can carry applyToExisting answers 409 + X-Anas-Confirm-Code with the rewrite headline (ruling 2026-10-11)', async () => {
    const savedExports = process.env.ANAS_EXPORTS_PATH
    const exportsDir = mkdtempSync(join(tmpdir(), 'anas-share-grant-nfs-'))
    const exportsPath = join(exportsDir, 'exports')
    writeFileSync(exportsPath, `${MP} 10.0.0.0/24(rw,sync,no_subtree_check)\n`, 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath
    try {
      const { calls } = start([], MEDIA_SHARE)
      const headline = `Applying to existing files rewrites the permissions of every file and directory under '${MP}'`
      const doors: { method: 'POST' | 'PUT', url: string, body: Record<string, unknown> }[] = [
        { method: 'POST', url: '/v1/shares/smb', body: { name: 'media2', path: MP, validUsers: ['media'], grantAccess: { applyToExisting: true } } },
        { method: 'PUT', url: '/v1/shares/smb/media', body: { grantAccess: { applyToExisting: true } } },
        { method: 'PUT', url: '/v1/shares/smb/media/access', body: { owner: 'media', applyToExisting: true } },
        { method: 'PUT', url: `/v1/shares/nfs/${encodeURIComponent(MP)}/access`, body: { owner: 'media', applyToExisting: true } },
      ]
      for (const door of doors) {
        const res = await server!.inject({ method: door.method, url: door.url, headers: JSON_HEADERS, payload: JSON.stringify(door.body) })
        assert.equal(res.statusCode, 409, `${door.method} ${door.url}: ${res.body}`)
        assert.ok(res.headers['x-anas-confirm-code'], `${door.method} ${door.url}: confirm code`)
        assert.equal(res.json().error.message, headline, `${door.method} ${door.url}`)
        assert.ok((res.json().error.warnings as string[]).some(w => /cannot be undone/.test(w)))
      }
      // Nothing was written or run behind any 409.
      assert.ok(!readFileSync(confPath, 'utf8').includes('[media2]'), 'the create did not happen')
      assert.equal(calls.some(c => ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'].includes(c.command)), false)
      // The same doors without applyToExisting are not gated.
      const flat = await server!.inject({ method: 'PUT', url: '/v1/shares/smb/media/access', headers: JSON_HEADERS, payload: JSON.stringify({ owner: 'media' }) })
      assert.equal(flat.statusCode, 202)
    }
    finally {
      if (savedExports === undefined)
        delete process.env.ANAS_EXPORTS_PATH
      else
        process.env.ANAS_EXPORTS_PATH = savedExports
      rmSync(exportsDir, { recursive: true, force: true })
    }
  })

  it('share access PUT runs fs.setAccess on the share path', async () => {
    const { calls } = start([], MEDIA_SHARE)
    const res = await server!.inject({ method: 'PUT', url: '/v1/shares/smb/media/access', headers: JSON_HEADERS, payload: JSON.stringify({ entries: [{ kind: 'everyone', level: 'none' }] }) })
    assert.equal(res.statusCode, 202)
    assert.equal((res.json() as JobAccepted).job.operation, 'fs.setAccess')
    const job = await waitForJob((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(find(calls, '/usr/bin/chmod', () => true), ['750', MP])
  })

  it('nfs export access GET/PUT open the editor on the export path; unknown export → 404', async () => {
    const savedExports = process.env.ANAS_EXPORTS_PATH
    const exportsDir = mkdtempSync(join(tmpdir(), 'anas-share-grant-nfs-'))
    const exportsPath = join(exportsDir, 'exports')
    writeFileSync(exportsPath, `${MP} 10.0.0.0/24(rw,sync,no_subtree_check)\n`, 'utf8')
    process.env.ANAS_EXPORTS_PATH = exportsPath
    try {
      const { calls } = start()
      const enc = encodeURIComponent(MP)
      const res = await server!.inject({ method: 'GET', url: `/v1/shares/nfs/${enc}/access`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal((res.json() as { data: DatasetAccess }).data.backing, 'zfs')
      const put = await server!.inject({ method: 'PUT', url: `/v1/shares/nfs/${enc}/access`, headers: JSON_HEADERS, payload: JSON.stringify({ owner: 'media' }) })
      assert.equal(put.statusCode, 202)
      const job = await waitForJob((put.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(find(calls, '/usr/bin/chown', () => true), ['media', MP])
      const missing = await server!.inject({ method: 'GET', url: `/v1/shares/nfs/${encodeURIComponent('/nope')}/access`, headers: IDENTITY_HEADERS })
      assert.equal(missing.statusCode, 404)
    }
    finally {
      if (savedExports === undefined)
        delete process.env.ANAS_EXPORTS_PATH
      else
        process.env.ANAS_EXPORTS_PATH = savedExports
      rmSync(exportsDir, { recursive: true, force: true })
    }
  })

  // --- pure helpers ------------------------------------------------------------------
  it('sharePrincipals reads @/+/& as groups, bare names as users, and skips %-macros', () => {
    assert.deepEqual(sharePrincipals(['alice', '@staff', '+ops', '&nis', '+&both', '%U', 'alice']), {
      principals: [
        { kind: 'user', name: 'alice' },
        { kind: 'group', name: 'staff' },
        { kind: 'group', name: 'ops' },
        { kind: 'group', name: 'nis' },
        { kind: 'group', name: 'both' },
      ],
      skipped: ['%U'],
    })
  })

  it('grantRelevantChange: principal set, guest, read-only and path count; order and comment do not', () => {
    const base = { name: 's', path: '/p', comment: null, browseable: true, readOnly: false, guestOk: false, validUsers: ['a', 'b'], hostsAllow: [], hostsDeny: [] }
    assert.equal(grantRelevantChange(base, { ...base, validUsers: ['b', 'a'], comment: 'x' }), false)
    assert.equal(grantRelevantChange(base, { ...base, validUsers: ['a'] }), true)
    assert.equal(grantRelevantChange(base, { ...base, guestOk: true }), true)
    assert.equal(grantRelevantChange(base, { ...base, readOnly: true }), true)
    assert.equal(grantRelevantChange(base, { ...base, path: '/q' }), true)
  })
})
