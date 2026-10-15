import type { Job, JobAccepted } from '@anas/shared'
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
  'x-anas-request-id': randomUUID(),
}

/**
 * Story cr.24 destroy fixtures — a pool `testpool` (mountpoint `/testpool` in
 * the mock `zfs list`) referenced by an SMB share and a backup task source.
 */
interface Cr24Dir { dir: string, smbConfPath: string, exportsPath: string, systemdDir: string }
let cr24Dir: Cr24Dir | null = null
async function makeCr24(): Promise<Cr24Dir> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-cr24-destroy-'))
  const smbConfPath = join(dir, 'smb.conf')
  const exportsPath = join(dir, 'exports')
  const systemdDir = join(dir, 'units')
  await mkdir(systemdDir)
  await writeFile(smbConfPath, `
[global]
  workgroup = WORKGROUP

[media]
  path = /testpool/media
  read only = no
`, 'utf-8')
  await writeFile(exportsPath, '\n', 'utf-8')
  await writeFile(join(systemdDir, 'anas-backup-pool-src.service'), renderBackupService({
    name: 'pool-src',
    repository: 'pve:local',
    backupId: 'pool-src',
    archives: [{ name: 'media', path: '/testpool/media', excludes: [] }],
    changeDetectionMode: 'default',
    notify: 'always',
    schedule: '*-*-* 02:00:00',
    enabled: true,
    limitNofile: 1024,
  }), 'utf-8')
  const made = { dir, smbConfPath, exportsPath, systemdDir }
  cr24Dir = made
  return made
}
async function cleanupCr24(): Promise<void> {
  if (cr24Dir)
    await rm(cr24Dir.dir, { recursive: true, force: true })
  cr24Dir = null
}
function applyCr24Cfg(): void {
  const f = cr24Dir!
  process.env.SMB_CONF_PATH = f.smbConfPath
  process.env.ANAS_EXPORTS_PATH = f.exportsPath
  process.env.ANAS_SYSTEMD_DIR = f.systemdDir
}
function clearCr24Cfg(): void {
  delete process.env.SMB_CONF_PATH
  delete process.env.ANAS_EXPORTS_PATH
  delete process.env.ANAS_SYSTEMD_DIR
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

describe('destroy endpoint: DELETE /v1/pools/:name', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns 409 CONFIRMATION_REQUIRED with a confirm code when unconfirmed', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
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
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: IDENTITY_HEADERS,
    })
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })

    assert.equal(res.statusCode, 202)
    const body = res.json() as JobAccepted
    assert.equal(body.job.operation, 'zpool.destroy')
    const job = await waitForJob(server, body.job.id)
    assert.equal(job.status, 'completed')
  })

  it('wipes the freed member disks when cleanup=true', async () => {
    server = createServer({ mock: true, logger: false })

    // The UI challenges WITHOUT cleanup (the checkbox is shown afterward), then
    // resends WITH cleanup=true. cleanup must NOT be part of the confirmation
    // signature, or the resend 409s — the bug this guards against.
    const first = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: IDENTITY_HEADERS,
    })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool?cleanup=true',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    // The job reports the (by-id) disks it wiped — the mock testpool has members.
    const result = job.result as { wiped?: string[] }
    assert.ok(Array.isArray(result.wiped) && result.wiped.length > 0, 'expected wiped disks in result')
  })

  it('rejects a wrong confirm code with 409 and a fresh code', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'bogus-code' },
    })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
  })

  // Story cr.23: the well-known-name block is gone. On this mock — an ext4
  // root node whose boot facts and mount table are readable — a pool merely
  // NAMED rpool is no longer protected by name; it meets the verdict any
  // unknown pool meets. The facts-based refusals live in
  // pools-destroy-system-pool.test.ts (controlled fixtures).
  it('a pool named rpool is no longer blocked by name (cr.23) — same 404 as any unknown pool', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/rpool',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('the name still offers no confirm path even when resent with a code (cr.23)', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/rpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'anything' },
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('rejects requests without identity headers', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
    })

    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  })

  it('returns 404 for a non-root pool that does not exist', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/nosuchpool',
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })
})
describe('cr.24 — destroy names what still references the pool', () => {
  let server: ReturnType<typeof createServer> | undefined

  const SYSTEMCTL = '/usr/bin/systemctl'
  const OK = { stdout: '', stderr: '', exitCode: 0 }

  afterEach(async () => {
    await server?.close()
    server = undefined
    clearCr24Cfg()
    await cleanupCr24()
  })

  it('destroy warns an SMB share and a backup task source by kind and name, on top of the irreversible lines', async () => {
    cr24Dir = await makeCr24()
    applyCr24Cfg()
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    const warnings = (res.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(warnings.some(w => w.includes('irreversible')), 'the inherent warning stays')
    assert.ok(warnings.some(w => /SMB share 'media'/.test(w)), `SMB named: ${warnings.join(' | ')}`)
    assert.ok(warnings.some(w => /Backup task 'pool-src'/.test(w)), `backup named: ${warnings.join(' | ')}`)
  })

  it('the destroy job reports a reference that appeared AFTER the confirm', async () => {
    const fixtures = await makeCr24()
    applyCr24Cfg()
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // A clean disable keeps the only warning the job's new-reference one.
    mock.addFixture({ command: SYSTEMCTL, args: ['disable', 'zfs-import@testpool.service'], result: OK })

    // zfs-list call 1 = challenge, 2 = confirmed request's route read, 3 = the
    // JOB's re-read — the share lands exactly where the job looks.
    const ADDED_SECTION = '\n[added-after-confirm]\n  path = /testpool/added\n  read only = no\n'
    let zfsListCalls = 0
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/sbin/zfs' && args.join(' ') === 'list -H -o name,mountpoint,mounted') {
        zfsListCalls++
        if (zfsListCalls === 3) {
          const current = await readFile(fixtures.smbConfPath, 'utf-8')
          await writeFile(fixtures.smbConfPath, current + ADDED_SECTION, 'utf-8')
        }
      }
      return orig(command, args)
    }

    const first = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: IDENTITY_HEADERS })
    const confirmWarnings = (first.json() as { error: { warnings: string[] } }).error.warnings
    assert.ok(!confirmWarnings.some(w => /added-after-confirm/.test(w)), 'the confirm did not list the later share')

    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/testpool',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server!, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { warnings?: string[] } | null
    assert.ok(Array.isArray(result?.warnings), 'the destroy result carries the new reference')
    assert.ok(
      (result!.warnings ?? []).some(w => /SMB share 'added-after-confirm'/.test(w)),
      `job reports the share added after the confirm: ${JSON.stringify(result)}`,
    )
  })
})
