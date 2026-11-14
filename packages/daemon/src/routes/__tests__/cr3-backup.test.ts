import type { BackupGroupList, BackupTaskDetail, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

/**
 * cr3.backup — the route-level pins of the 2026-11-14 review's backup
 * findings (docs/CODE-REVIEW-2026-11-14.md, "Backup (daemon)"). Each `it`
 * names its finding id; each was RED against the pre-fix code.
 */

const PBC = '/usr/bin/proxmox-backup-client'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  // Generous: the suite shares the machine with other suites, and a job
  // that is merely slow must not read as a failure.
  for (let i = 0; i < 1000; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

export const REPO = {
  name: 'pbs-main',
  host: '127.0.0.1',
  port: 8007,
  datastore: 'store',
  authType: 'token' as const,
  tokenId: 'root@pam!anas-test',
  fingerprint: 'cc:b8:a0',
  namespace: 'repo-ns',
  secret: 'token-secret-value',
}

describe('cr3.backup routes', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-backup-'))
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_STORAGE_CFG', join(dir, 'storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    await writeFile(join(dir, 'storage.cfg'), '')
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemd-analyze', result: { stdout: 'Normalized form: *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    const repoRes = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo: REPO, expectedVersion: 0 } })
    assert.equal(repoRes.statusCode, 202, repoRes.body)
    await waitForJob(server, (repoRes.json() as { job: { id: string } }).job.id)
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
    }
  })

  // --- BACKUP-H1 --------------------------------------------------------------

  it('BACKUP-H1: an option-shaped ?group= is a 400 and pbc never runs (the stored secret goes nowhere)', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    for (const group of [
      '--repository=backupuser@pbs@evil.example:8007:x',
      '-repository=backupuser@pbs@evil.example:8007:x',
      'host/-a',
      'host/a<b>',
      'other/foo',
      'host/a/b',
    ]) {
      const res = await server.inject({
        method: 'GET',
        url: `/v1/backup/repos/pbs-main/groups?group=${encodeURIComponent(group)}`,
        headers: IDENTITY,
      })
      assert.equal(res.statusCode, 400, `${group}: ${res.body}`)
    }
    assert.equal(mock.calls.filter(c => c.command === PBC).length, 0, 'no pbc call for any refused group')
  })

  it('BACKUP-H1: a PBS-shaped ?group= still lists (vm, ct and host)', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    for (const group of ['host/gtrestore', 'vm/100', 'ct/101', 'host/_a.b-c']) {
      const res = await server.inject({ method: 'GET', url: `/v1/backup/repos/pbs-main/groups?group=${encodeURIComponent(group)}`, headers: IDENTITY })
      assert.equal(res.statusCode, 200, `${group}: ${res.body}`)
    }
  })

  it('BACKUP-H1: a browse whose snapshot or archive is not PBS-shaped is a 400', async () => {
    const mock = mockOf(server)
    for (const [snapshot, archive] of [
      ['--repository=u@pbs@evil.example:8007:x', 'data.pxar'],
      ['host/x/2026-01-01T00:00:00Z', '--ns'],
      ['host/x/2026-01-01T00:00:00Z', '.hidden.pxar'],
      ['host/x', 'data.pxar'],
      ['other/x/2026-01-01T00:00:00Z', 'data.pxar'],
    ]) {
      const res = await server.inject({ method: 'POST', url: '/v1/backup/restore/browse', headers: JSON_HEADERS, payload: { repo: 'pbs-main', snapshot, archive } })
      assert.equal(res.statusCode, 400, `${snapshot} ${archive}: ${res.body}`)
    }
    assert.equal(mock.calls.filter(c => c.args.includes('catalog')).length, 0)
  })

  it('BACKUP-H1 / backup-panel M5: rows from the server outside PBS`s charset are dropped and said', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: PBC,
      result: {
        stdout: JSON.stringify([
          { 'backup-type': 'host', 'backup-id': 'good', 'last-backup': 2, 'backup-count': 1, 'files': ['data.pxar.didx', '<img src=x onerror=alert(1)>.pxar.didx'] },
          { 'backup-type': 'host', 'backup-id': '<b id=inj>x</b>', 'last-backup': 1, 'files': [] },
          { 'backup-type': '<i>', 'backup-id': 'x', 'last-backup': 1, 'files': [] },
        ]),
        stderr: '',
        exitCode: 0,
      },
    })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/repos/pbs-main/groups', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupGroupList }
    assert.deepEqual(data.groups.map(g => g.group), ['host/good'])
    assert.deepEqual(data.groups[0]!.files.map(f => f.filename), ['data.pxar.didx'])
    assert.equal(data.warnings?.length, 3, JSON.stringify(data.warnings))
    assert.ok(!JSON.stringify(data).includes('<'), 'no refused text is echoed anywhere in the answer')
  })

  // --- BACKUP-M4 / panel M3 / panel L7 ----------------------------------------

  const STORED = {
    name: 'docs',
    repository: 'pbs-main',
    backupId: 'pve1-docs',
    namespace: 'task-ns',
    archives: [{ name: 'docs', path: '/srv/docs', excludes: [] }],
    schedule: '*-*-* 02:00:00',
    enabled: false,
    notify: 'on-failure',
    changeDetectionMode: 'metadata',
    limitNofile: 4096,
    retention: { keepLast: 7 },
  }

  async function submit(method: 'POST' | 'PUT', url: string, payload: unknown): Promise<Job> {
    const res = payload === undefined
      ? await server.inject({ method: method as 'POST', url, headers: IDENTITY })
      : await server.inject({ method, url, headers: JSON_HEADERS, payload: payload as Record<string, unknown> })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob(server, (res.json() as { job: { id: string } }).job.id)
  }

  async function stored(): Promise<BackupTaskDetail['task']> {
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/docs', headers: IDENTITY })
    assert.equal(res.statusCode, 200, res.body)
    return (res.json() as { data: BackupTaskDetail }).data.task
  }

  it('BACKUP-M4: a PUT that names only the schedule keeps every field it omits', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    const job = await submit('PUT', '/v1/backup/tasks/docs', { schedule: '*-*-* 03:00:00' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const t = await stored()
    assert.equal(t.schedule, '*-*-* 03:00:00')
    assert.equal(t.enabled, false, 'a disabled task is not re-enabled by an omission')
    assert.equal(t.notify, 'on-failure')
    assert.equal(t.changeDetectionMode, 'metadata')
    assert.equal(t.limitNofile, 4096)
    // The temporary exceptions (PUT_CLEARS_ON_OMIT: the released panel omits a
    // blank namespace and an all-blank retention and means "none"): cleared.
    assert.equal(t.retention, undefined)
    assert.equal(t.namespace, undefined)
  })

  it('cr3 review (1): the released panel\'s body with retention cleared STOPS pruning (omitted retention clears)', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    // Exactly what the released edit dialog sends when the five keep fields are
    // blank: every field, and no `retention` key.
    const { retention: _r, ...released } = STORED
    const job = await submit('PUT', '/v1/backup/tasks/docs', { ...released, mode: 'metadata' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal((await stored()).retention, undefined, 'a cleared retention must not keep pruning')
  })

  it('BACKUP-M4: a namespace the body names stands; null clears it; \'\' is the datastore root (cr3 review 6)', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    assert.equal((await submit('PUT', '/v1/backup/tasks/docs', { namespace: 'task-ns' })).status, 'completed')
    assert.equal((await stored()).namespace, 'task-ns')
    assert.equal((await submit('PUT', '/v1/backup/tasks/docs', { namespace: '' })).status, 'completed')
    assert.equal((await stored()).namespace, '', '\'\' is stored as the datastore root, never reinterpreted')
    assert.equal((await submit('PUT', '/v1/backup/tasks/docs', { namespace: 'task-ns' })).status, 'completed')
    assert.equal((await submit('PUT', '/v1/backup/tasks/docs', { namespace: null })).status, 'completed')
    assert.equal((await stored()).namespace, undefined)
  })

  it('cr3 review (6): a task stored with namespace \'\' keeps running where it ran — the datastore root, at every door', async () => {
    // A unit written by hand (no released panel ever stored '').
    await writeFile(join(dir, 'anas-backup-rooted.service'), `# X-ANAS-Task=${JSON.stringify({ ...STORED, name: 'rooted', backupId: 'rooted', namespace: '' })}\n[Service]\n`)
    await writeFile(join(dir, 'anas-backup-rooted.timer'), '[Timer]\n')
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/rooted', headers: IDENTITY })
    assert.equal((res.json() as { data: BackupTaskDetail }).data.task.namespace, '', 'read back as stored, not as absent')
    // Its prune preview with the task's namespace sent as stored: the root (no --ns), not the repo's 'repo-ns'.
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const preview = await server.inject({ method: 'POST', url: '/v1/backup/tasks/rooted/prune-preview', headers: JSON_HEADERS, payload: { namespace: '' } })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.ok(!mock.calls.find(c => c.command === PBC && c.args[0] === 'prune')!.args.includes('--ns'))
    // The task's own snapshot listing (the read door the run's effective namespace drives): the root too.
    mock.calls.length = 0
    await server.inject({ method: 'GET', url: '/v1/backup/tasks/rooted/snapshots', headers: IDENTITY })
    assert.ok(!mock.calls.find(c => c.command === PBC && c.args[0] === 'snapshot')!.args.includes('--ns'))
  })

  it('backup-panel M4: revision on the list and the detail; a stale ?expectedRevision= is 409 STATE_CHANGED, a current one saves', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    const detail = await server.inject({ method: 'GET', url: '/v1/backup/tasks/docs', headers: IDENTITY })
    const revision = (detail.json() as { data: { revision?: string } }).data.revision
    assert.match(revision ?? '', /^[0-9a-f]{64}$/)
    const list = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    assert.equal((list.json() as { data: { revision?: string }[] }).data[0]?.revision, revision)
    // Another admin saves first.
    assert.equal((await submit('PUT', `/v1/backup/tasks/docs?expectedRevision=${revision}`, { notify: 'always' })).status, 'completed')
    const stale = await server.inject({ method: 'PUT', url: `/v1/backup/tasks/docs?expectedRevision=${revision}`, headers: JSON_HEADERS, payload: { enabled: true } })
    assert.equal(stale.statusCode, 409, stale.body)
    assert.equal((stale.json() as { error: { code: string } }).error.code, 'STATE_CHANGED')
    // Without the parameter: today's behaviour.
    assert.equal((await submit('PUT', '/v1/backup/tasks/docs', { enabled: true })).status, 'completed')
  })

  it('BACKUP-M4: null clears (an optional field is gone, a defaulted one takes its default)', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    const job = await submit('PUT', '/v1/backup/tasks/docs', { namespace: null, retention: null, limitNofile: null, enabled: true })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const t = await stored()
    assert.equal(t.namespace, undefined)
    assert.equal(t.retention, undefined)
    assert.equal(t.limitNofile, 1024)
    assert.equal(t.enabled, true)
    assert.equal(t.notify, 'on-failure', 'still kept')
  })

  it('BACKUP-M4: the legacy `mode` alias still sets the mode; a raw schedule drops a stored cadence', async () => {
    await submit('POST', '/v1/backup/tasks', { ...STORED, cadence: { kind: 'weekly', days: ['Mon'], time: '02:00' } })
    assert.ok((await stored()).cadence)
    const job = await submit('PUT', '/v1/backup/tasks/docs', { mode: 'default', schedule: '*-*-* 04:00:00' })
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const t = await stored()
    assert.equal(t.changeDetectionMode, 'default')
    assert.equal(t.cadence, undefined)
    assert.equal(t.schedule, '*-*-* 04:00:00')
  })

  it('backup-panel M3: prune-preview reads the namespace as the PUT does (omitted or null = cleared), a present one as given', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    const ns = async (payload: Record<string, unknown>): Promise<string | undefined> => {
      mock.calls.length = 0
      const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks/docs/prune-preview', headers: JSON_HEADERS, payload })
      assert.equal(res.statusCode, 200, res.body)
      const call = mock.calls.find(c => c.command === PBC && c.args[0] === 'prune')!
      const i = call.args.indexOf('--ns')
      return i === -1 ? undefined : call.args[i + 1]
    }
    // Omitted and null: the task's namespace cleared (as the PUT reads both),
    // so the repo's own. A present string is authoritative; '' is the root.
    assert.equal(await ns({}), 'repo-ns')
    assert.equal(await ns({ namespace: null }), 'repo-ns')
    assert.equal(await ns({ namespace: 'other' }), 'other')
    assert.equal(await ns({ namespace: '' }), undefined)
  })

  it('backup-panel L7: an auth-type change without a new secret is refused with a sentence; with one it saves', async () => {
    const list = await server.inject({ method: 'GET', url: '/v1/backup/repos', headers: IDENTITY })
    const version = (list.json() as { data: { version: number } }).data.version
    const { secret: _secret, tokenId: _tokenId, ...rest } = REPO
    const asPassword = { ...rest, authType: 'password', username: 'backup@pbs' }
    const refused = await server.inject({ method: 'PUT', url: '/v1/backup/repos/pbs-main', headers: JSON_HEADERS, payload: { repo: asPassword, expectedVersion: version } })
    assert.equal(refused.statusCode, 400, refused.body)
    assert.match((refused.json() as { error: { message: string } }).error.message, /the authentication type \(token to password\) of repository 'pbs-main' needs the new password/)
    // A token-id change alone is the same refusal.
    const otherToken = await server.inject({ method: 'PUT', url: '/v1/backup/repos/pbs-main', headers: JSON_HEADERS, payload: { repo: { ...rest, authType: 'token', tokenId: 'root@pam!other' }, expectedVersion: version } })
    assert.equal(otherToken.statusCode, 400, otherToken.body)
    assert.match((otherToken.json() as { error: { message: string } }).error.message, /the token id/)
    // R3: a host or port change is the same refusal — the secret would go to another server.
    for (const [edit, field] of [[{ host: '10.9.9.9' }, 'the host'], [{ port: 8008 }, 'the port']] as const) {
      // Nothing has been saved yet in this test, so `version` is still current.
      const moved = await server.inject({ method: 'PUT', url: '/v1/backup/repos/pbs-main', headers: JSON_HEADERS, payload: { repo: { ...rest, tokenId: REPO.tokenId, authType: 'token', ...edit }, expectedVersion: version } })
      assert.equal(moved.statusCode, 400, moved.body)
      assert.match((moved.json() as { error: { message: string } }).error.message, new RegExp(`Changing ${field} of repository 'pbs-main' needs the new token secret`))
    }
    const accepted = await server.inject({ method: 'PUT', url: '/v1/backup/repos/pbs-main', headers: JSON_HEADERS, payload: { repo: { ...asPassword, secret: 'new-password' }, expectedVersion: version } })
    assert.equal(accepted.statusCode, 202, accepted.body)
    // An edit that keeps the type still keeps the stored secret on a blank field.
    const same = await server.inject({ method: 'PUT', url: '/v1/backup/repos/pbs-main', headers: JSON_HEADERS, payload: { repo: { ...rest, tokenId: REPO.tokenId, authType: 'token' }, expectedVersion: version } })
    assert.notEqual(same.statusCode, 400, same.body)
  })

  // --- BACKUP-M7 ------------------------------------------------------------

  it('BACKUP-M7: a file restore into a configured-but-unmounted mount is refused before anything runs', async () => {
    await server.close()
    // A share the system is configured to have at /srv/archive (fstab) and the
    // mock kernel table does not carry: its mountpoint is an empty directory
    // on `/`, and a restore there would vanish under the share when it mounts.
    const fstab = join(dir, 'fstab')
    await writeFile(fstab, 'UUID=x / ext4 defaults 0 1\nnas:/archive /srv/archive nfs4 defaults 0 0\n')
    setEnv('ANAS_FSTAB_PATH', fstab)
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    const repoRes = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo: { ...REPO, name: 'pbs-m7' }, expectedVersion: 1 } })
    assert.equal(repoRes.statusCode, 202, repoRes.body)
    await waitForJob(server, (repoRes.json() as { job: { id: string } }).job.id)
    mock.calls.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore',
      headers: JSON_HEADERS,
      payload: {
        kind: 'files',
        repo: 'pbs-m7',
        snapshot: 'host/x/2026-08-25T19:16:45Z',
        archive: 'data.pxar',
        selections: ['/alpha.txt'],
        target: { mode: 'newLocation', path: '/srv/archive/restored' },
      },
    })
    assert.equal(res.statusCode, 409, res.body)
    const err = (res.json() as { error: { reason?: string, message: string } }).error
    assert.equal(err.reason, 'destination-unmounted')
    assert.match(err.message, /'\/srv\/archive\/restored' is on \/srv\/archive \(nas:\/archive\), which is configured in \/etc\/fstab but not mounted/)
    assert.equal(mock.calls.filter(c => c.args.includes('catalog') || c.args.includes('restore')).length, 0, 'no PBS contact, no restore')
  })

  // --- BACKUP-L9 ------------------------------------------------------------

  it('BACKUP-L9: deleting a task destroys the transients it left anywhere on the node (shallowest, recursive), and only its own', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    const mock = mockOf(server)
    mock.prependFixture({
      command: '/usr/sbin/zfs',
      args: ['list', '-t', 'snapshot', '-H', '-o', 'name'],
      result: {
        stdout: [
          'tank/old@anas-backup-docs-1000000000',
          'tank/old/child@anas-backup-docs-1000000000',
          'tank/moved@anas-backup-docs-1000000500',
          'tank/old@anas-backup-docs2-1000000000',
          'tank/old@anas-backup-other-1000000000',
          'tank/old@manual',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    })
    mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.calls.length = 0
    const job = await submit('DELETE' as 'PUT', '/v1/backup/tasks/docs', undefined)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const destroys = mock.calls.filter(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'destroy').map(c => c.args.join(' '))
    assert.deepEqual(destroys, [
      'destroy -r -- tank/old@anas-backup-docs-1000000000',
      'destroy -r -- tank/moved@anas-backup-docs-1000000500',
    ])
  })

  it('BACKUP-L9: a node snapshot listing that fails is said in the delete result, never read as "none left"', async () => {
    await submit('POST', '/v1/backup/tasks', STORED)
    const mock = mockOf(server)
    mock.prependFixture({ command: '/usr/sbin/zfs', args: ['list', '-t', 'snapshot', '-H', '-o', 'name'], result: { stdout: '', stderr: 'internal error', exitCode: 1 } })
    const job = await submit('DELETE' as 'PUT', '/v1/backup/tasks/docs', undefined)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.match(JSON.stringify(job.result), /could not be listed, so transient snapshots this task may have left/)
  })

  // --- handed by pools: an unreadable storage.cfg is never "no such repository"

  it('cr3.backup (from pools): an unreadable storage.cfg is 503 "could not read PVE\'s PBS storages" at every pve:<id> door, and said on the list', async () => {
    await rm(join(dir, 'storage.cfg'), { force: true })
    await mkdir(join(dir, 'storage.cfg'))
    const list = await server.inject({ method: 'GET', url: '/v1/backup/repos', headers: IDENTITY })
    assert.equal(list.statusCode, 200)
    assert.match((list.json() as { data: { pveUnavailable?: string } }).data.pveUnavailable ?? '', /could not read PVE's PBS storages .*EISDIR/)
    const groups = await server.inject({ method: 'GET', url: '/v1/backup/repos/pve:pbs1/groups', headers: IDENTITY })
    assert.equal(groups.statusCode, 503, groups.body)
    assert.match(groups.body, /could not read PVE's PBS storages/)
    const create = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: { ...STORED, repository: 'pve:pbs1' } })
    assert.equal(create.statusCode, 503, create.body)
    const test = await server.inject({ method: 'POST', url: '/v1/backup/repos/test', headers: JSON_HEADERS, payload: { name: 'pve:pbs1' } })
    assert.equal(test.statusCode, 503, test.body)
    // A registered (tier-2) repository is untouched by it.
    assert.equal((await submit('POST', '/v1/backup/tasks', STORED)).status, 'completed')
  })

  it('cr3 review (2): an unreadable MOUNT TABLE refuses the restore destination with 503 (never passes)', async () => {
    const mock = mockOf(server)
    mock.prependFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 } })
    mock.calls.length = 0
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore',
      headers: JSON_HEADERS,
      payload: { kind: 'files', repo: 'pbs-main', snapshot: 'host/x/2026-08-25T19:16:45Z', archive: 'data.pxar', selections: ['/alpha.txt'], target: { mode: 'newLocation', path: '/srv/restored' } },
    })
    assert.equal(res.statusCode, 503, res.body)
    assert.match(res.body, /mount table could not be read/)
    assert.equal(mock.calls.filter(c => c.args.includes('restore') && c.command.endsWith('proxmox-backup-client')).length, 0)
  })

  it('cr3 review (8b): an archive name or backup-id pbc would refuse is a 400 at create and update; a stored one loads and says so', async () => {
    for (const bad of [
      { archives: [{ name: 'a.b', path: '/srv/docs', excludes: [] }] },
      { archives: [{ name: '-x', path: '/srv/docs', excludes: [] }] },
      { backupId: 'a b' },
      { backupId: '.hidden' },
    ]) {
      const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: { ...STORED, ...bad } })
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)}: ${res.body}`)
    }
    await submit('POST', '/v1/backup/tasks', STORED)
    const put = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/docs', headers: JSON_HEADERS, payload: { backupId: 'a:b' } })
    assert.equal(put.statusCode, 400, put.body)
    // A unit written before this rule still loads, and the problem is on the task.
    await writeFile(join(dir, 'anas-backup-legacy.service'), `# X-ANAS-Task=${JSON.stringify({ ...STORED, name: 'legacy', backupId: 'old id', archives: [{ name: 'my.docs', path: '/srv/docs', excludes: [] }] })}\n[Service]\n`)
    await writeFile(join(dir, 'anas-backup-legacy.timer'), '[Timer]\n')
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/legacy', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const problems = (res.json() as { data: { task: { problems?: string[] } } }).data.task.problems ?? []
    assert.equal(problems.length, 2, JSON.stringify(problems))
    assert.match(problems.join(' '), /backup ID 'old id'/)
    assert.match(problems.join(' '), /archive name 'my\.docs'/)
  })

  // --- cr3 review 2 (1): one namespace per task at every read door ----------

  it('cr3 review2 (1): door x (task named / not) x (ns absent / \'\' / value) — a named task\'s namespace wins, a disagreeing ns is refused', async () => {
    // `rooted`: stored with namespace '' (the datastore root); `plain`: no namespace (the repo's 'repo-ns').
    for (const [name, ns] of [['rooted', ''], ['plain', undefined]] as const) {
      await writeFile(join(dir, `anas-backup-${name}.service`), `# X-ANAS-Task=${JSON.stringify({ ...STORED, name, backupId: name, ...(ns === undefined ? { namespace: undefined } : { namespace: ns }) })}\n[Service]\n`)
      await writeFile(join(dir, `anas-backup-${name}.timer`), '[Timer]\n')
    }
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 1 } })
    // The files door's newLocation does not exist yet (its kind gate runs before the catalog read).
    mock.prependFixture({ command: '/usr/bin/timeout', args: ['10', '/usr/bin/stat', '-c', '%F', '--', '/srv/restored'], result: { stdout: '', stderr: 'stat: cannot statx: No such file or directory\n', exitCode: 1 } })
    const SNAPSHOT = (id: string): string => `host/${id}/2026-08-25T19:16:45Z`
    const nsOf = (args: string[]): string | null => {
      const i = args.indexOf('--ns')
      return i === -1 ? null : args[i + 1]!
    }
    type Door = (task: string | undefined, ns: string | undefined) => Promise<{ status: number, ns?: string | null }>
    const groups: Door = async (task, ns) => {
      mock.calls.length = 0
      const q = new URLSearchParams({ group: `host/${task ?? 'rooted'}`, ...(task ? { task } : {}), ...(ns !== undefined ? { ns } : {}) })
      const res = await server.inject({ method: 'GET', url: `/v1/backup/repos/pbs-main/groups?${q}`, headers: IDENTITY })
      const call = mock.calls.find(c => c.command === PBC && c.args[0] === 'snapshot')
      return { status: res.statusCode, ns: call ? nsOf(call.args) : undefined }
    }
    const browse: Door = async (task, ns) => {
      mock.calls.length = 0
      const res = await server.inject({ method: 'POST', url: '/v1/backup/restore/browse', headers: JSON_HEADERS, payload: { repo: 'pbs-main', snapshot: SNAPSHOT(task ?? 'rooted'), archive: 'data.pxar', ...(task ? { task } : {}), ...(ns !== undefined ? { ns } : {}) } })
      if (res.statusCode === 202)
        await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
      const call = mock.calls.find(c => c.args.includes('catalog'))
      return { status: res.statusCode, ns: call ? nsOf(call.args) : undefined }
    }
    const files: Door = async (task, ns) => {
      mock.calls.length = 0
      const res = await server.inject({ method: 'POST', url: '/v1/backup/restore', headers: JSON_HEADERS, payload: { kind: 'files', repo: 'pbs-main', snapshot: SNAPSHOT(task ?? 'rooted'), archive: 'data.pxar', selections: ['/a.txt'], target: { mode: 'newLocation', path: '/srv/restored' }, ...(task ? { task } : {}), ...(ns !== undefined ? { ns } : {}) } })
      const call = mock.calls.find(c => c.args.includes('catalog'))
      // Past the namespace the restore goes on to its later gates (the mocked
      // catalog holds nothing, so the selection gate answers): what is pinned
      // here is the namespace the catalog was read in.
      if (call)
        return { status: 0, ns: nsOf(call.args) }
      if (res.statusCode === 400 && !/namespace|not found/.test(res.body))
        throw new Error(`files 400 for another reason: ${res.body}`)
      return { status: res.statusCode, ns: undefined }
    }
    // [task, body ns, expected --ns (null = none, the root) or 400]
    const table: [string | undefined, string | undefined, string | null | 400][] = [
      [undefined, undefined, 'repo-ns'],
      [undefined, '', 'repo-ns'], // today's meaning of an empty ns, unchanged
      [undefined, 'other', 'other'],
      ['rooted', undefined, null], // the stored '' is the datastore root
      ['rooted', '', null],
      ['rooted', 'other', 400],
      ['plain', undefined, 'repo-ns'],
      ['plain', '', 'repo-ns'],
      ['plain', 'repo-ns', 'repo-ns'],
      ['plain', 'other', 400],
    ]
    for (const [doorName, door] of [['groups', groups], ['browse', browse], ['files', files]] as const) {
      for (const [task, ns, want] of table) {
        const got = await door(task, ns)
        const label = `${doorName} task=${task ?? '-'} ns=${ns === undefined ? '-' : JSON.stringify(ns)}`
        if (want === 400) {
          assert.equal(got.status, 400, label)
          continue
        }
        assert.notEqual(got.status, 400, label)
        assert.equal(got.ns, want, label)
      }
    }
  })

  // --- cr3 review2 (2)(3): the charset rules bind what a request CHANGES -----

  it('cr3 review2 (2)(3): a stored task pbc would refuse can still be disabled; a PUT that touches the bad field is held to the rule', async () => {
    await writeFile(join(dir, 'anas-backup-legacy.service'), `# X-ANAS-Task=${JSON.stringify({ ...STORED, name: 'legacy', backupId: 'legacy', namespace: 'bad ns', archives: [{ name: 'my.docs', path: '/srv/docs', excludes: [] }] })}\n[Service]\n`)
    await writeFile(join(dir, 'anas-backup-legacy.timer'), '[Timer]\n')
    // A toggle (the released panel sends the whole stored task back).
    const { revision: _r, ...detail } = ((await server.inject({ method: 'GET', url: '/v1/backup/tasks/legacy', headers: IDENTITY })).json() as { data: { task: Record<string, unknown> } }).data.task as Record<string, unknown>
    const { datastore: _d, legacyImgArchives: _l, problems: _p, ...stored } = detail
    const toggle = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/legacy', headers: JSON_HEADERS, payload: { ...stored, enabled: false } })
    assert.equal(toggle.statusCode, 202, toggle.body)
    assert.equal((await waitForJob(server, (toggle.json() as { job: { id: string } }).job.id)).status, 'completed')
    const problems = (toggle.json() as { problems?: string[] }).problems ?? []
    assert.equal(problems.length, 2, JSON.stringify(problems))
    // Touching the archive list or the namespace is held to the rule.
    const archives = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/legacy', headers: JSON_HEADERS, payload: { archives: [{ name: 'my.docs', path: '/srv/other', excludes: [] }] } })
    assert.equal(archives.statusCode, 400, archives.body)
    const ns = await server.inject({ method: 'PUT', url: '/v1/backup/tasks/legacy', headers: JSON_HEADERS, payload: { namespace: '../x' } })
    assert.equal(ns.statusCode, 400, ns.body)
  })

  it('cr3 review2 (3): a namespace pbc refuses is a 400 at create; \'\' (the root) and a 7-deep path pass', async () => {
    for (const namespace of ['bad ns', '../x', ' ', '/a', 'a//b', 'a/', 'a:b', 'a/b/c/d/e/f/g/h']) {
      const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: { ...STORED, name: 'nsbad', namespace } })
      assert.equal(res.statusCode, 400, `${JSON.stringify(namespace)}: ${res.body}`)
      assert.match(res.body, /namespace/)
    }
    for (const [i, namespace] of ['', 'a', 'a/b/c/d/e/f/g', '_x.y-z'].entries()) {
      const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: { ...STORED, name: `nsok${i}`, backupId: `nsok${i}`, namespace } })
      assert.equal(res.statusCode, 202, `${JSON.stringify(namespace)}: ${res.body}`)
      await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    }
  })

  it('cr3 review2 (7): a unit file that cannot be read makes group uniqueness unjudgeable — the create is refused, naming it', async () => {
    await mkdir(join(dir, 'anas-backup-broken.service'))
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: STORED })
    assert.equal(res.statusCode, 503, res.body)
    assert.match(res.body, /backup task 'broken'.*could not be read/)
    assert.match(res.body, /uniqueness/)
  })

  it('cr3 review2 (9): the in-place home lookup matches the archive KIND — a pxar request never takes an image archive\'s device path', async () => {
    const task = { ...STORED, name: 'imgtask', backupId: 'imgtask', namespace: undefined, archives: [{ name: 'disk0', path: '/dev/zvol/tank/vol0', excludes: [], kind: 'img' }] }
    await writeFile(join(dir, 'anas-backup-imgtask.service'), `# X-ANAS-Task=${JSON.stringify(task)}\n[Service]\n`)
    await writeFile(join(dir, 'anas-backup-imgtask.timer'), '[Timer]\n')
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore',
      headers: JSON_HEADERS,
      payload: { kind: 'files', repo: 'pbs-main', task: 'imgtask', snapshot: 'host/imgtask/2026-08-25T19:16:45Z', archive: 'disk0.pxar', selections: ['/a.txt'], target: { mode: 'inPlace' } },
    })
    assert.equal(res.statusCode, 400, res.body)
    assert.match(res.body, /Name the directory to restore into/)
    assert.ok(!res.body.includes('/dev/zvol/tank/vol0'))
  })
})
