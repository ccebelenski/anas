import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

/**
 * cr4.tasks — task-unit reads: an unreadable unit is never absent, and a
 * failed timer read is never a stale result (D-20).
 */

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
}
const json = (extra: Record<string, string> = {}) => ({ ...IDENTITY, 'x-anas-request-id': randomUUID(), 'content-type': 'application/json', ...extra })
/** A mutating request with no body (DELETE). */
const mutating = () => ({ ...IDENTITY, 'x-anas-request-id': randomUUID() })

/** A `.service` that is there and carries no `X-ANAS-Task=` line (a hand edit). */
const UNPARSEABLE_UNIT = [
  '[Unit]',
  'Description=hand edited',
  '',
  '[Service]',
  'ExecStart=/bin/true',
  '',
].join('\n')

const TASK = {
  name: 'taken',
  repository: 'pbs-main',
  backupId: 'anas-pve',
  archives: [{ name: 'etc', path: '/etc', excludes: [] }],
  changeDetectionMode: 'metadata',
  schedule: '*-*-* 02:00:00',
  enabled: true,
}

describe('cr4.tasks: an unreadable task unit is never absent (D-20)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved = {
    systemd: process.env.ANAS_SYSTEMD_DIR,
    storage: process.env.ANAS_STORAGE_CFG,
    repos: process.env.ANAS_BACKUP_REPOS_FILE,
    creds: process.env.ANAS_BACKUP_CREDS_DIR,
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'anas-cr4-tasks-'))
    process.env.ANAS_SYSTEMD_DIR = dir
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_BACKUP_REPOS_FILE = join(dir, 'backup-repos.json')
    process.env.ANAS_BACKUP_CREDS_DIR = join(dir, 'creds')
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { addFixture: (f: unknown) => void } }).executor
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    if (saved.systemd === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = saved.systemd
    if (saved.storage === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = saved.storage
    for (const [key, value] of [['ANAS_BACKUP_REPOS_FILE', saved.repos], ['ANAS_BACKUP_CREDS_DIR', saved.creds]] as const) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  it('the create gate refuses 409 over an unparseable unit file and leaves it untouched', async () => {
    const unitPath = join(dir, 'anas-backup-taken.service')
    await writeFile(unitPath, UNPARSEABLE_UNIT)

    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: json(), payload: TASK })
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'CONFLICT')
    assert.match(body.error.message, /A unit file for backup task 'taken' already exists at .*anas-backup-taken\.service and could not be read \(no valid X-ANAS-Task JSON\)\. ANAS will not overwrite it\. Fix or remove that file, then try again\./)
    // The job never ran, so the unit is exactly as the hand edit left it.
    assert.equal(await readFile(unitPath, 'utf-8'), UNPARSEABLE_UNIT)
  })

  it('the single-task read answers 503 over the same unit, never a 404 "not found"', async () => {
    await writeFile(join(dir, 'anas-backup-taken.service'), UNPARSEABLE_UNIT)

    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/taken', headers: IDENTITY })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'UNAVAILABLE')
    assert.match(body.error.message, /A unit file for backup task 'taken' already exists at .*anas-backup-taken\.service and could not be read \(no valid X-ANAS-Task JSON\)\. Fix or remove that file, then try again\./)
  })

  it('an absent unit is still absent: the detail answers 404', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/absent', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('the cloud create gate refuses 409 over an unparseable unit file', async () => {
    const unitPath = join(dir, 'anas-cloud-nightly.service')
    await writeFile(unitPath, UNPARSEABLE_UNIT)

    const payload = {
      name: 'nightly',
      source: '/tank/pictures',
      remote: 'gt',
      path: 'pve1/pictures',
      schedule: 'Tue *-*-* 02:00:00',
    }
    const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks', headers: json(), payload })
    assert.equal(res.statusCode, 409)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'CONFLICT')
    assert.match(body.error.message, /A unit file for cloud sync task 'nightly' already exists at .*anas-cloud-nightly\.service and could not be read/)
    assert.equal(await readFile(unitPath, 'utf-8'), UNPARSEABLE_UNIT)
  })
  it('the repository-removal gate refuses 503 over an unreadable unit instead of removing a repo it may strand', async () => {
    const registry = {
      version: 1,
      updatedBy: 'root@pam',
      updatedAt: '2026-01-01T00:00:00.000Z',
      repos: [{ name: 'pbs-main', host: '127.0.0.1', port: 8007, datastore: 'store1', authType: 'token', tokenId: 'root@pam!anas', fingerprint: 'cc:b8:a0' }],
    }
    await writeFile(join(dir, 'backup-repos.json'), JSON.stringify(registry))
    await writeFile(join(dir, 'anas-backup-handedit.service'), UNPARSEABLE_UNIT)

    const res = await server.inject({ method: 'DELETE', url: '/v1/backup/repos/pbs-main?expectedVersion=1', headers: mutating() })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'UNAVAILABLE')
    assert.match(body.error.message, /Task unit .*anas-backup-handedit\.service could not be read, so ANAS cannot tell whether it uses repository 'pbs-main'\. Fix or remove that file, then try again\./)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'backup-repos.json'), 'utf-8')), registry)
  })

  it('the repository-removal gate still removes a repo when every unit reads', async () => {
    const registry = {
      version: 1,
      updatedBy: 'root@pam',
      updatedAt: '2026-01-01T00:00:00.000Z',
      repos: [{ name: 'pbs-main', host: '127.0.0.1', port: 8007, datastore: 'store1', authType: 'token', tokenId: 'root@pam!anas', fingerprint: 'cc:b8:a0' }],
    }
    await writeFile(join(dir, 'backup-repos.json'), JSON.stringify(registry))

    const res = await server.inject({ method: 'DELETE', url: '/v1/backup/repos/pbs-main?expectedVersion=1', headers: mutating() })
    assert.equal(res.statusCode, 202)
    const { job } = res.json() as { job: { id: string } }
    for (let i = 0; i < 100; i++) {
      const got = await server.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: IDENTITY })
      const j = (got.json() as { job: { status: string, error?: unknown } }).job
      if (j.status === 'completed') {
        assert.equal((JSON.parse(await readFile(join(dir, 'backup-repos.json'), 'utf-8')) as { repos: unknown[] }).repos.length, 0)
        return
      }
      assert.notEqual(j.status, 'failed', JSON.stringify(j.error))
      await new Promise(r => setTimeout(r, 10))
    }
    assert.fail('the removal job did not finish')
  })
})
