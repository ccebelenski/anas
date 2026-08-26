import type { BackupBrowseResult, BackupGroupList, BackupSnapshotList, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'

/**
 * The three restore READ endpoints (story backup2.5):
 *
 *   GET  /v1/backup/tasks/:name/snapshots
 *   GET  /v1/backup/repos/:name/groups[?ns=&group=]
 *   POST /v1/backup/restore/browse
 *
 * All three are user-initiated PBS contacts on Epic 16's sanctioned list, and
 * all three are READS: 200, never a job, never a poll. A local fault (unknown
 * task / repo / no credential) is a 4xx; a PBS-side outcome is a 200 carrying a
 * verdict, exactly as prune-preview and the repo Test already do.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')
const PBC = '/usr/bin/proxmox-backup-client'
const TIMEOUT = '/usr/bin/timeout'

/**
 * The exact argv `browseArchiveLevel` sends. The mock server pre-seeds a
 * command-only `/usr/bin/timeout` fixture for the mounts liveness probe, and
 * command-only fixtures match in registration order — so a browse fixture must
 * be registered with its exact args to win.
 */
function shellArgs(snapshot: string, archive: string, ns?: string): string[] {
  const args = ['30', PBC, 'catalog', 'shell', snapshot, archive]
  if (ns)
    args.push('--ns', ns)
  return args
}

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** The four-line `stat` block shape, verbatim from the real capture. */
function statBlock(path: string, size: number, type: string, mode: string, perms: string, modify: string): string {
  return [
    `  File: ${path}`,
    `  Size: ${String(size).padEnd(14)}Type: ${type}`,
    `Access: (${mode}/${perms}  )  Uid: 0     Gid: 0    `,
    `Modify: ${modify}`,
  ].join('\n')
}

describe('backup restore reads (story backup2.5)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  const REPO = {
    name: 'pbs-main',
    host: '127.0.0.1',
    port: 8007,
    datastore: 'anastest-store',
    authType: 'token' as const,
    tokenId: 'root@pam!anas-test',
    fingerprint: 'cc:b8:a0',
    namespace: 'gtrestore',
    secret: 'token-secret-value',
  }

  const TASK = {
    name: 'nightly',
    repository: 'pbs-main',
    backupId: 'gtrestore',
    archives: [{ name: 'data', path: '/gtbackup/data', excludes: [] }],
    schedule: '*-*-* 02:00:00',
    enabled: true,
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-restorereads-'))
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
    assert.equal(repoRes.statusCode, 202)
    await waitForJob(server, (repoRes.json() as { job: { id: string } }).job.id)
    const taskRes = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload: TASK })
    assert.equal(taskRes.statusCode, 202)
    await waitForJob(server, (taskRes.json() as { job: { id: string } }).job.id)
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

  // --- GET /backup/tasks/:name/snapshots ------------------------------------

  it('lists the task group`s points in time, newest first, ids composed', async () => {
    mockOf(server).addFixture({ command: PBC, result: { stdout: fixture('snapshot-list-group.json'), stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupSnapshotList }
    assert.equal(data.verdict, 'ok')
    assert.equal(data.repository, 'pbs-main')
    // The task carries no namespace of its own, so the REPO's namespace stands.
    assert.equal(data.namespace, 'gtrestore')
    assert.equal(data.group, 'host/gtrestore')
    assert.equal(data.snapshots.length, 1)
    const s = data.snapshots[0]!
    assert.equal(s.snapshot, `host/gtrestore/${s.backupTimeIso}`)
    assert.ok(s.files.some(f => f.kind === 'pxar' && f.archive === 'data.pxar' && typeof f.size === 'number'))
  })

  it('sends the group form of `snapshot list` with the effective namespace', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly/snapshots', headers: IDENTITY })
    const call = mock.calls.find(c => c.command === PBC && c.args[0] === 'snapshot')
    assert.ok(call)
    assert.deepEqual(call.args, ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'])
    // Never a poll, never a mount, and no secret anywhere on argv.
    assert.ok(!call.args.some(a => a.includes('token-secret-value')))
  })

  it('an unknown task is a 404 — a LOCAL fault, not a PBS verdict', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nosuchtask/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('an invalid task name is a 400', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/Not%20Valid/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 400)
  })

  it('a PBS failure is a 200 carrying the verdict (diagnose, don`t just fail)', async () => {
    mockOf(server).addFixture({
      command: PBC,
      result: { stdout: '', stderr: 'Error: ENOENT: No such file or directory\n', exitCode: 255 },
    })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupSnapshotList }
    assert.equal(data.verdict, 'not-found')
    assert.ok(data.detail?.includes('snapshot, group or namespace'))
    assert.deepEqual(data.snapshots, [])
  })

  it('a repository with no stored credential is a 400 that says what to do', async () => {
    // Remove the secret file behind the repo.
    await rm(join(dir, 'creds'), { recursive: true, force: true })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 400)
    const body = res.json() as { error: { message: string } }
    assert.ok(body.error.message.includes('credentials'))
  })

  // --- GET /backup/repos/:name/groups ---------------------------------------

  it('lists a namespace`s groups (the task-less door)', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: fixture('group-list.json'), stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'GET', url: '/v1/backup/repos/pbs-main/groups?ns=gtrestore', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupGroupList }
    assert.equal(data.verdict, 'ok')
    assert.ok(data.groups.length > 0)
    assert.equal(data.snapshots, undefined, 'no ?group= means no snapshots key at all')
    const call = mock.calls.find(c => c.command === PBC)!
    assert.deepEqual(call.args, ['list', '--ns', 'gtrestore', '--output-format', 'json'])
  })

  it('?group= returns THAT group`s snapshots in the task endpoint`s shape', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: fixture('snapshot-list-group.json'), stderr: '', exitCode: 0 } })
    const res = await server.inject({
      method: 'GET',
      url: '/v1/backup/repos/pbs-main/groups?ns=gtrestore&group=host%2Fgtrestore',
      headers: IDENTITY,
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupGroupList }
    assert.equal(data.verdict, 'ok')
    assert.equal(data.group, 'host/gtrestore')
    assert.deepEqual(data.groups, [])
    assert.equal(data.snapshots?.length, 1)
    assert.equal(data.snapshots![0]!.snapshot, `host/gtrestore/${data.snapshots![0]!.backupTimeIso}`)
    const call = mock.calls.find(c => c.command === PBC)!
    assert.deepEqual(call.args, ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'])
  })

  it('no ?ns= falls back to the repository`s own namespace', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    await server.inject({ method: 'GET', url: '/v1/backup/repos/pbs-main/groups', headers: IDENTITY })
    const call = mock.calls.find(c => c.command === PBC)!
    assert.deepEqual(call.args, ['list', '--ns', 'gtrestore', '--output-format', 'json'])
  })

  it('an unknown repository is a 404', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/backup/repos/nosuchrepo/groups', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  // --- POST /backup/restore/browse ------------------------------------------

  const SNAP = 'host/gtrestore/2026-08-25T19:16:45Z'

  it('browses one level: catalog shell over a pipe, wrapped in timeout', async () => {
    const mock = mockOf(server)
    const rootStat = statBlock('/', 0, 'directory', '755', 'drwxr-xr-x', '2026-08-25 19:16:23')
    const childStats = [
      statBlock('/docs', 0, 'directory', '755', 'drwxr-xr-x', '2026-08-25 19:16:23'),
      statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--', '2026-08-25 19:16:23'),
      statBlock('/hard-b.txt -> "hard-a.txt"', 0, 'symlink', '0', 'L---------', '1970-01-01 00:00:00'),
    ].join('\n')
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(SNAP, 'data.pxar', 'gtrestore'),
      results: [
        { stdout: `alpha.txt\ndocs\nhard-b.txt\n${rootStat}\n`, stderr: 'Starting interactive shell    \n', exitCode: 0 },
        { stdout: `${childStats}\n`, stderr: 'Starting interactive shell    \n', exitCode: 0 },
      ],
    })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore/browse',
      headers: JSON_HEADERS,
      payload: { repo: 'pbs-main', ns: 'gtrestore', snapshot: SNAP, archive: 'data.pxar', path: '/' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupBrowseResult }
    assert.equal(data.verdict, 'ok')
    assert.equal(data.archiveKind, 'pxar')
    assert.deepEqual(data.entries.map(e => e.name), ['docs', 'alpha.txt', 'hard-b.txt'])
    assert.equal(data.entries[2]!.type, 'hardlink')
    assert.equal(data.entries[2]!.target, 'hard-a.txt')

    const shellCalls = mock.calls.filter(c => c.command === TIMEOUT)
    assert.equal(shellCalls.length, 2)
    assert.deepEqual(shellCalls[0]!.args.slice(1, 6), [PBC, 'catalog', 'shell', SNAP, 'data.pxar'])
    // NEVER the FUSE mount — the hang trap with no lever (GT-33).
    assert.ok(!mock.calls.some(c => c.args.includes('mount')))
  })

  it('an .img archive answers with one whole-image entry and NO PBS contact', async () => {
    const mock = mockOf(server)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore/browse',
      headers: JSON_HEADERS,
      payload: { repo: 'pbs-main', snapshot: SNAP, archive: 'lun.img' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupBrowseResult }
    assert.equal(data.archiveKind, 'img')
    assert.deepEqual(data.entries, [{ name: 'lun.img', path: '/', type: 'image' }])
    assert.equal(mock.calls.filter(c => c.command === TIMEOUT).length, 0)
  })

  it('the path defaults to the archive root when omitted', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: TIMEOUT, args: shellArgs(SNAP, 'data.pxar', 'gtrestore'), result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore/browse',
      headers: JSON_HEADERS,
      payload: { repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal((res.json() as { data: BackupBrowseResult }).data.path, '/')
  })

  it('a relative path, a `..` path and a control character are all 400s', async () => {
    for (const path of ['docs', '/a/../b', '/a\nls /etc']) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/backup/restore/browse',
        headers: JSON_HEADERS,
        payload: { repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar', path },
      })
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(path)}`)
    }
  })

  it('a browse against an unknown repository is a 404', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore/browse',
      headers: JSON_HEADERS,
      payload: { repo: 'nosuchrepo', snapshot: SNAP, archive: 'data.pxar' },
    })
    assert.equal(res.statusCode, 404)
  })

  it('a PBS failure during a browse is a 200 with the verdict', async () => {
    mockOf(server).addFixture({
      command: TIMEOUT,
      args: shellArgs(SNAP, 'data.pxar', 'gtrestore'),
      result: { stdout: '', stderr: 'Error: no permissions on /datastore/anastest-store/gtrestore\n', exitCode: 255 },
    })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/restore/browse',
      headers: JSON_HEADERS,
      payload: { repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar' },
    })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: BackupBrowseResult }
    assert.equal(data.verdict, 'permission')
    assert.ok(data.detail?.includes('Datastore.Audit'))
  })

  it('none of the three reads submits a job — they are reads, not mutations', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: TIMEOUT, args: shellArgs(SNAP, 'data.pxar', 'gtrestore'), result: { stdout: '', stderr: '', exitCode: 0 } })
    const jobCount = async (): Promise<number> => {
      const res = await server.inject({ method: 'GET', url: '/v1/jobs', headers: IDENTITY })
      return ((res.json() as { data: unknown[] }).data ?? []).length
    }
    const before = await jobCount()
    await server.inject({ method: 'GET', url: '/v1/backup/tasks/nightly/snapshots', headers: IDENTITY })
    await server.inject({ method: 'GET', url: '/v1/backup/repos/pbs-main/groups', headers: IDENTITY })
    await server.inject({
      method: 'POST',
      url: '/v1/backup/restore/browse',
      headers: JSON_HEADERS,
      payload: { repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar' },
    })
    assert.equal(await jobCount(), before)
  })
})
