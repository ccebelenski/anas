import type { BackupTask, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { renderServiceUnit as renderBackupService } from '../../services/backup-units.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/**
 * Story cr.24 fixtures — a pool `testpool` (mountpoint `/testpool` in the mock
 * `zfs list`) that really IS referenced. Written to ONE temp dir, wired into
 * `createServer` through the env overrides the wiring honours.
 */
const CR24_SMB = `
[global]
  workgroup = WORKGROUP

[media]
  path = /testpool/media
  read only = no
`

const CR24_EXPORTS = `
/testpool/export  192.168.1.0/24(rw,sync,no_subtree_check)
`

const CR24_BACKUP_TASK: BackupTask = {
  name: 'pool-src',
  repository: 'pve:local',
  backupId: 'pool-src',
  archives: [{ name: 'media', path: '/testpool/media', excludes: [] }],
  changeDetectionMode: 'default',
  notify: 'always',
  schedule: '*-*-* 02:00:00',
  enabled: true,
  limitNofile: 1024,
}

/** One temp reference-source tree; registered for cleanup. */
interface RefFixtures { dir: string, smbConfPath: string, exportsPath: string, systemdDir: string }
const liveRefDirs: RefFixtures[] = []
async function makeRefFixtures(over: { smb?: string, noBackupTask?: boolean } = {}): Promise<RefFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-cr24-export-'))
  const smbConfPath = join(dir, 'smb.conf')
  const exportsPath = join(dir, 'exports')
  const systemdDir = join(dir, 'units')
  await mkdir(systemdDir)
  await writeFile(smbConfPath, over.smb ?? CR24_SMB, 'utf-8')
  await writeFile(exportsPath, CR24_EXPORTS, 'utf-8')
  if (!over.noBackupTask)
    await writeFile(join(systemdDir, 'anas-backup-pool-src.service'), renderBackupService(CR24_BACKUP_TASK), 'utf-8')
  liveRefDirs.push({ dir, smbConfPath, exportsPath, systemdDir })
  return { dir, smbConfPath, exportsPath, systemdDir }
}
async function cleanupRefDirs(): Promise<void> {
  const pending = liveRefDirs.splice(0)
  for (const f of pending)
    await rm(f.dir, { recursive: true, force: true })
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

describe('export endpoint: POST /v1/pools/:name/export', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(Array.isArray(res.json().error.warnings) && res.json().error.warnings.length > 0)
    assert.ok(res.headers['x-anas-confirm-code'])
    assert.ok(res.headers['x-anas-confirm-expires'])
  })

  it('proceeds to 202 when resent with a valid confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.export')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('rejects a wrong confirm code with 409 and a fresh code', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'bogus-code' },
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  it('rejects a reused (single-use) confirm code', async () => {
    server = createServer({ mock: true, logger: false })

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(accepted.statusCode, 202)

    const reused = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(reused.statusCode, 409)
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nosuchpool/export',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })
})

describe('pools.r1 — export disables the pool boot-import unit (review M6 #22)', () => {
  const SYSTEMCTL = '/usr/bin/systemctl'
  const OK = { stdout: '', stderr: '', exitCode: 0 }

  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function attach(): MockExecutor {
    server = createServer({ mock: true, logger: false })
    return (server as unknown as { executor: MockExecutor }).executor
  }

  /** Challenge → confirm → 202, then wait for the job to finish. */
  async function runExport(pool = 'testpool'): Promise<Job> {
    const first = await server!.inject({
      method: 'POST',
      url: `/v1/pools/${pool}/export`,
      headers: IDENTITY_HEADERS,
    })
    const res = await server!.inject({
      method: 'POST',
      url: `/v1/pools/${pool}/export`,
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
    })
    assert.equal(res.statusCode, 202)
    return waitForJob(server!, (res.json() as JobAccepted).job.id)
  }

  it('a successful export disables zfs-import@<pool>.service AFTER the pool is exported', async () => {
    const mock = attach()
    mock.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@testpool.service'], result: OK })

    const job = await runExport()
    assert.equal(job.status, 'completed')
    assert.equal(job.result, null, 'no warnings when the disable succeeded')

    // The order is the point: disabling before the export would leave a pool
    // that IS imported without its unit (the audit #22 bug in the other
    // direction). An export failure returns early and must skip the disable.
    const exportIdx = mock.calls.findIndex(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'export')
    const disableIdx = mock.calls.findIndex(c => c.command === SYSTEMCTL && c.args.join(' ') === 'disable zfs-import@testpool.service')
    assert.ok(exportIdx >= 0, 'zpool export ran')
    assert.ok(disableIdx > exportIdx, 'systemctl disable runs strictly after zpool export')
  })

  it('a failed export disables nothing — no systemctl call at all', async () => {
    const mock = attach()
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) =>
      command === '/usr/sbin/zpool' && args[0] === 'export'
        ? { stdout: '', stderr: 'cannot export \'testpool\': pool is busy\n', exitCode: 1 }
        : orig(command, args)

    const job = await runExport()
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', /pool is busy/)
    assert.equal(mock.calls.find(c => c.command === SYSTEMCTL), undefined, 'no systemctl after a failed export')
  })

  it('a failing disable leaves the job completed with the warning in its result', async () => {
    const mock = attach()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: 'Failed to disable unit: Transaction check failed.\n', exitCode: 1 } })

    const job = await runExport()
    assert.equal(job.status, 'completed', 'the pool is exported — a unit hiccup never fails the job')
    const result = job.result as { warnings?: string[] } | null
    assert.ok(Array.isArray(result?.warnings) && result!.warnings.length === 1)
    assert.match(result!.warnings[0], /Could not disable zfs-import@testpool\.service/)
    assert.match(result!.warnings[0], /Failed to disable unit: Transaction check failed/)
  })

  it('a pool name needing systemd escaping uses zfsImportUnitName\'s escaped unit', async () => {
    const mock = attach()
    // Exact-args fixture: a wrong (unescaped) unit name would not match and
    // the call would hit the default 127, warning the job — caught below.
    mock.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@my\\x2dpool.service'], result: OK })
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      // The mock inventory only knows testpool; give my-pool a listing and a
      // stable guid so the ident.1 gate passes.
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'get -H -o value guid -- my-pool')
        return { stdout: '17897551794000000001\n', stderr: '', exitCode: 0 }
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'list -j') {
        const base = await orig(command, args)
        const json = JSON.parse(base.stdout) as { pools: Record<string, unknown> }
        json.pools['my-pool'] = { name: 'my-pool', state: 'ONLINE', properties: {} }
        return { ...base, stdout: JSON.stringify(json) }
      }
      return orig(command, args)
    }

    const job = await runExport('my-pool')
    assert.equal(job.status, 'completed')
    assert.equal(job.result, null)
    assert.deepEqual(
      mock.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args),
      [['disable', 'zfs-import@my\\x2dpool.service']],
    )
  })
})

describe('ident.1 — pool export binds the pool guid', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Successive guid reads; `null` = the read fails (`zpool get` exits 1). */
  function serveWithGuids(guids: (string | null)[]): { calls: string[][] } {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    const calls: string[][] = []
    mock.exec = async (command: string, args: string[]) => {
      calls.push(args)
      if (command === '/usr/sbin/zpool' && args.join(' ') === 'get -H -o value guid -- testpool') {
        const guid = guids.length > 1 ? guids.shift() : guids[0]
        return guid === null
          ? { stdout: '', stderr: 'cannot open \'testpool\': I/O error', exitCode: 1 }
          : { stdout: `${guid}\n`, stderr: '', exitCode: 0 }
      }
      return orig(command, args)
    }
    return { calls }
  }

  const exportReq = (code?: string) => server!.inject({
    method: 'POST',
    url: '/v1/pools/testpool/export',
    headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', ...(code ? { 'x-anas-confirm': code } : {}) },
    payload: '{}',
  })

  it('a pool swapped under the same name between challenge and resend → 409 IDENTITY_MISMATCH', async () => {
    const { calls } = serveWithGuids(['10', '20'])
    const first = await exportReq()
    assert.equal(first.statusCode, 409)
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'IDENTITY_MISMATCH')
    assert.match(res.json().error.message, /guid 10 at the confirmation, guid 20 now/)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('the guid cannot be read at the gate → 409 CONFLICT, no confirm code, nothing exported', async () => {
    const { calls } = serveWithGuids([null])
    const res = await exportReq()
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /Could not read the guid of pool 'testpool' — refusing an export that cannot be bound to it/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('the guid cannot be read when the job runs → the job fails IDENTITY_MISMATCH and exports nothing', async () => {
    const { calls } = serveWithGuids(['10', '10', null])
    const first = await exportReq()
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.match(job.error?.message ?? '', /guid 10 at the confirmation, unreadable now/)
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })

  it('a swap while the job is queued → the job fails IDENTITY_MISMATCH and exports nothing', async () => {
    const { calls } = serveWithGuids(['10', '10', '30'])
    const first = await exportReq()
    const res = await exportReq(first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.equal(calls.find(a => a[0] === 'export'), undefined)
  })
})

describe('cr.24 — export names what still references the pool', () => {
  let server: ReturnType<typeof createServer> | undefined

  function applyCfg(f: RefFixtures, smbConfPath = f.smbConfPath) {
    process.env.SMB_CONF_PATH = smbConfPath
    process.env.ANAS_EXPORTS_PATH = f.exportsPath
    process.env.ANAS_SYSTEMD_DIR = f.systemdDir
  }
  function clearCfg() {
    delete process.env.SMB_CONF_PATH
    delete process.env.ANAS_EXPORTS_PATH
    delete process.env.ANAS_SYSTEMD_DIR
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
    clearCfg()
    await cleanupRefDirs()
  })

  it('a pool backing an SMB share, an NFS export and a backup task source warns all three by kind and name', async () => {
    const f = await makeRefFixtures()
    applyCfg(f)
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 409)
    const warnings = (res.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(warnings.some(w => /SMB share 'media'/.test(w)), `SMB named: ${warnings.join(' | ')}`)
    assert.ok(warnings.some(w => /NFS export '\/testpool\/export'/.test(w)), `NFS named: ${warnings.join(' | ')}`)
    assert.ok(warnings.some(w => /Backup task 'pool-src'/.test(w)), `backup named: ${warnings.join(' | ')}`)
    // The one-line generic is replaced when something specific was found.
    assert.ok(!warnings.some(w => w.startsWith('Exporting ')), `specific found — generic drops: ${warnings.join(' | ')}`)
  })

  it('an unreadable smb.conf warns that SMB shares could not be checked', async () => {
    const f = await makeRefFixtures()
    // Point SMB_CONF_PATH at a DIRECTORY: readConfig gets EISDIR, not ENOENT.
    const dirAsSmb = join(f.dir, 'smb-is-a-dir')
    await mkdir(dirAsSmb)
    applyCfg(f, dirAsSmb)
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 409)
    const warnings = (res.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(warnings.some(w => /could not read smb\.conf/.test(w)), `smb unreadable disclosed: ${warnings.join(' | ')}`)
    // The NFS export is still readable and still named (fail-open is per source).
    assert.ok(warnings.some(w => /NFS export/.test(w)))
  })

  it('a pool with no references keeps only the generic warning', async () => {
    const f = await makeRefFixtures({ smb: '# empty smb.conf\n', noBackupTask: true })
    await writeFile(f.exportsPath, '# empty exports\n', 'utf-8')
    applyCfg(f)
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(res.statusCode, 409)
    const warnings = (res.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(warnings.some(w => w.startsWith('Exporting ') && w.includes('unavailable until it is re-imported')), `generic kept: ${warnings.join(' | ')}`)
    assert.ok(!warnings.some(w => /SMB share|NFS export|Backup task/.test(w)), `no specific refs: ${warnings.join(' | ')}`)
  })

  it('the export job reports a reference that appeared AFTER the confirm', async () => {
    const f = await makeRefFixtures()
    applyCfg(f)
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor

    // `zfs list -o name,mountpoint,mounted` runs ONCE per pool-reference read:
    // call 1 = the challenge request, call 2 = the confirmed request's route
    // read (before the code is verified), call 3 = the JOB's re-read. Appending
    // the share at call 3 lands it exactly where the job looks — deterministic.
    const ADDED_SECTION = '\n[added-after-confirm]\n  path = /testpool/added\n  read only = no\n'
    let zfsListCalls = 0
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/sbin/zfs' && args.join(' ') === 'list -H -o name,mountpoint,mounted') {
        zfsListCalls++
        if (zfsListCalls === 3) {
          const current = await readFile(f.smbConfPath, 'utf-8')
          await writeFile(f.smbConfPath, current + ADDED_SECTION, 'utf-8')
        }
      }
      return orig(command, args)
    }

    const first = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: IDENTITY_HEADERS,
    })
    const confirmWarnings = (first.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(!confirmWarnings.some(w => /added-after-confirm/.test(w)), 'the confirm did not list the later share')

    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/export',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { warnings?: string[] } | null
    assert.ok(Array.isArray(result?.warnings), 'the job result carries the new reference')
    assert.ok(
      (result!.warnings ?? []).some(w => /SMB share 'added-after-confirm'/.test(w)),
      `job reports the share added after the confirm: ${JSON.stringify(result)}`,
    )
  })
})
