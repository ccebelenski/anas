import type { BackupFilesRestoreResult, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

/**
 * `POST /v1/backup/restore` with `kind: 'files'` — story backup2.6.
 *
 * The endpoint is ONE door for two restore types; this file exercises the
 * `files` branch and the dispatch that keeps `image` (backup2.7) beside it.
 *
 * Every pre-flight test asserts on the MOCK CALL LOG that the restore itself
 * never ran: a refusal that still contacted the client would be a refusal that
 * already did the damage.
 */

const PBC = '/usr/bin/proxmox-backup-client'
const TIMEOUT = '/usr/bin/timeout'
const SNAP = 'host/gtrestore/2026-08-25T19:16:45Z'
const HOME = '/gtbackup/data'
const SIDE = '/gtbackup/data.anas-restore-2026-08-25T19-16-45Z'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** The four-line `stat` block shape, verbatim from the real capture. */
function statBlock(path: string, size: number, type: string, mode: string, perms: string): string {
  return [
    `  File: ${path}`,
    `  Size: ${String(size).padEnd(14)}Type: ${type}`,
    `Access: (${mode}/${perms}  )  Uid: 0     Gid: 0    `,
    'Modify: 2026-08-25 19:16:23',
  ].join('\n')
}

/** The exact argv the pre-flight catalog `stat` pass sends. */
function shellArgs(): string[] {
  return ['30', PBC, 'catalog', 'shell', SNAP, 'data.pxar', '--ns', 'gtrestore']
}

describe('POST /v1/backup/restore — kind: files (story backup2.6)', () => {
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
    namespace: 'gtrestore',
    secret: 'token-secret-value',
  }

  const TASK = {
    name: 'nightly',
    repository: 'pbs-main',
    backupId: 'gtrestore',
    archives: [{ name: 'data', path: HOME, excludes: [] }],
    schedule: '*-*-* 02:00:00',
    enabled: true,
  }

  /** The default body: the task door, side-by-side, one picked file. */
  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'files',
      repo: 'pbs-main',
      task: 'nightly',
      snapshot: SNAP,
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
      ...overrides,
    }
  }

  /** Register the pre-flight answers a HAPPY side-by-side restore needs. */
  function seedHappyPath(opts: { target?: string, selections?: string[], stats?: string, found?: string[] } = {}): void {
    const mock = mockOf(server)
    const target = opts.target ?? SIDE
    const selections = opts.selections ?? ['/alpha.txt']
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: {
        stdout: opts.stats ?? statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'),
        stderr: 'Starting interactive shell\n',
        exitCode: 0,
      },
    })
    // The side-by-side directory must NOT exist.
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', target],
      result: { stdout: '', stderr: 'No such file or directory\n', exitCode: 1 },
    })
    // Plenty of room.
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    const probes = (opts.found ?? selections).map(s => `${target}${s}`)
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', ...selections.map(s => `${target}${s}`), '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${probes.join('\n')}\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: [
        'restore',
        SNAP,
        'data.pxar',
        target,
        '--ns',
        'gtrestore',
        ...selections.flatMap(s => ['--pattern', s]),
      ],
      result: {
        stdout: '',
        stderr: 'restore complete (2.546 KiB processed in <0.1s, average 777.059 KiB/s)    \r',
        exitCode: 0,
      },
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-restorefiles-'))
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
    mock.calls.length = 0
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

  /** Did the restore itself ever run? */
  function restoreRan(): boolean {
    return mockOf(server).calls.some(c => c.command === PBC && c.args[0] === 'restore')
  }

  async function post(payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
    return server.inject({ method: 'POST', url: '/v1/backup/restore', headers: { ...JSON_HEADERS, ...extraHeaders }, payload })
  }

  // --- Dispatch -------------------------------------------------------------

  it('dispatches on `kind` — an `image` body never reaches the file branch', async () => {
    // The discriminated union routes on `kind` alone: an image body missing its
    // LUN is rejected as an IMAGE request (backup2.7's shape), never silently
    // read as a file restore with no selections.
    const res = await post({ kind: 'image', repo: 'pbs-main', snapshot: SNAP, archive: 'lun.img' })
    assert.equal(res.statusCode, 400)
    const err = (res.json() as { error: { code: string, message: string } }).error
    assert.equal(err.code, 'VALIDATION_ERROR')
    assert.ok(!/selections/.test(err.message), `image body judged by the file schema: ${err.message}`)
    assert.equal(restoreRan(), false)
  })

  it('an unknown kind is a 400, not a silent file restore', async () => {
    const res = await post({ kind: 'everything', repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar', selections: ['/a'] })
    assert.equal(res.statusCode, 400)
  })

  it('an `img` ARCHIVE is refused from the file door and pointed at its own', async () => {
    const res = await post(body({ archive: 'lun.img' }))
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /restored whole/)
    assert.equal(restoreRan(), false)
  })

  // --- Schema ---------------------------------------------------------------

  it('a snapshot id with no timestamp is refused at the boundary (GT-57)', async () => {
    const res = await post(body({ snapshot: 'host/gtrestore' }))
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /bare group silently restores the latest/)
    assert.equal(restoreRan(), false)
  })

  it('an unknown repository is a 404 — a LOCAL fault', async () => {
    const res = await post(body({ repo: 'nosuchrepo' }))
    assert.equal(res.statusCode, 404)
  })

  // --- Side-by-side, the default -------------------------------------------

  it('derives the side-by-side directory from the task`s archive path, and restores', async () => {
    seedHappyPath()
    const res = await post(body())
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    const result = job.result as BackupFilesRestoreResult
    assert.equal(result.kind, 'files')
    assert.equal(result.status, 'completed')
    assert.equal(result.target, SIDE)
    assert.equal(result.mode, 'sideBySide')
    assert.equal(result.merge, false)
    assert.deepEqual(result.patterns, ['/alpha.txt'])
    assert.deepEqual(result.restored, ['/alpha.txt'])
    assert.deepEqual(result.missing, [])

    const call = mockOf(server).calls.find(c => c.command === PBC && c.args[0] === 'restore')!
    assert.deepEqual(call.args, [
      'restore',
      SNAP,
      'data.pxar',
      SIDE,
      '--ns',
      'gtrestore',
      '--pattern',
      '/alpha.txt',
    ])
    // No overwrite flags for a new directory (GT-15), and no secret on argv.
    assert.ok(!call.args.includes('--overwrite'))
    assert.ok(!call.args.includes('--allow-existing-dirs'))
    assert.ok(!call.args.some(a => a.includes('token-secret-value')))
  })

  it('refuses to REUSE an existing side-by-side directory', async () => {
    // A second restore of the same point in time into a half-finished first one
    // would merge two attempts with no way to tell them apart — including a
    // partial one this daemon labelled itself.
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: 'directory\n', stderr: '', exitCode: 0 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 409)
    assert.match((res.json() as { error: { message: string } }).error.message, /already exists/)
    assert.equal(restoreRan(), false)
  })

  it('the task-less door needs a target path, and works with one', async () => {
    const without = await post(body({ task: undefined }))
    assert.equal(without.statusCode, 400)
    assert.match((without.json() as { error: { message: string } }).error.message, /target\.path/)
    assert.equal(restoreRan(), false)

    seedHappyPath()
    const withPath = await post(body({ task: undefined, target: { mode: 'sideBySide', path: HOME } }))
    assert.equal(withPath.statusCode, 202)
    const job = await waitForJob(server, (withPath.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    assert.equal((job.result as BackupFilesRestoreResult).target, SIDE)
  })

  it('an EXPANDED archive name matches no task archive and asks for the path', async () => {
    // backup2.3's `<name>__<child>` flattened a path with `/` → `_`, which
    // cannot be inverted — so nothing is guessed and no dataset is created.
    const res = await post(body({ archive: 'data__photos.pxar' }))
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /does not match an archive/)
  })

  // --- In place -------------------------------------------------------------

  it('a single picked FILE in place is NOT gated — the checkbox is the consent', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', HOME],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', `${HOME}/alpha.txt`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${HOME}/alpha.txt\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: [
        'restore',
        SNAP,
        'data.pxar',
        HOME,
        '--ns',
        'gtrestore',
        '--pattern',
        '/alpha.txt',
        '--allow-existing-dirs',
        '--overwrite',
      ],
      result: { stdout: '', stderr: 'restore complete (23 B processed in <0.1s, average 1 KiB/s)\r', exitCode: 0 },
    })

    const res = await post(body({ target: { mode: 'inPlace' } }))
    assert.equal(res.statusCode, 202, 'no confirm code for one explicitly picked file')
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    const result = job.result as BackupFilesRestoreResult
    assert.equal(result.merge, true)
    assert.ok(result.warnings.some(w => /MERGE, never a sync/.test(w)))
    // GT-11 / GT-26: the minimal in-place pair, and the dir flag even for one file.
    const call = mockOf(server).calls.find(c => c.command === PBC && c.args[0] === 'restore')!
    assert.ok(call.args.includes('--allow-existing-dirs'))
    assert.ok(call.args.includes('--overwrite'))
  })

  it('an in-place restore of a TREE is confirm-gated, and nothing ran before the 409', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/docs', 0, 'directory', '755', 'drwxr-xr-x'), stderr: '', exitCode: 0 },
    })
    // A tree has no exact size, so the manifest's logical size is read.
    mock.addFixture({
      command: PBC,
      args: ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'],
      result: {
        stdout: JSON.stringify([{
          'backup-id': 'gtrestore',
          'backup-time': 1787685405,
          'backup-type': 'host',
          'files': [{ 'crypt-mode': 'none', 'filename': 'data.pxar.didx', 'size': 2607 }],
        }]),
        stderr: '',
        exitCode: 0,
      },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', HOME],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', `${HOME}/docs`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${HOME}/docs\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: [
        'restore',
        SNAP,
        'data.pxar',
        HOME,
        '--ns',
        'gtrestore',
        '--pattern',
        '/docs',
        '--allow-existing-dirs',
        '--overwrite',
      ],
      result: { stdout: '', stderr: 'restore complete (2.546 KiB processed in <0.1s, average 1 MiB/s)\r', exitCode: 0 },
    })

    const payload = body({ selections: ['/docs'], target: { mode: 'inPlace' } })
    const first = await post(payload)
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code, 'a confirm code is issued')
    const err = (first.json() as { error: { code: string, warnings: string[] } }).error
    assert.equal(err.code, 'CONFIRMATION_REQUIRED')
    assert.ok(err.warnings.some(w => /MERGE, never a sync/.test(w)))
    assert.equal(restoreRan(), false, 'the gate refused BEFORE the client ran')

    const second = await post(payload, { 'x-anas-confirm': code })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(server, (second.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
  })

  it('a side-by-side restore of a TREE is NEVER gated', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/docs', 0, 'directory', '755', 'drwxr-xr-x'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: PBC,
      args: ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'],
      result: { stdout: '[]', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', `${SIDE}/docs`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${SIDE}/docs\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', SIDE, '--ns', 'gtrestore', '--pattern', '/docs'],
      result: { stdout: '', stderr: 'restore complete (2.546 KiB processed in <0.1s, average 1 MiB/s)\r', exitCode: 0 },
    })
    const res = await post(body({ selections: ['/docs'] }))
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
  })

  // --- Pre-flight refusals --------------------------------------------------

  it('refuses a target in PVE territory, and nothing ran', async () => {
    const res = await post(body({ task: undefined, target: { mode: 'inPlace', path: '/mnt/pve/backups' } }))
    assert.equal(res.statusCode, 409)
    assert.match((res.json() as { error: { message: string } }).error.message, /belongs to Proxmox/)
    assert.equal(restoreRan(), false)
    // Not a confirm-gated refusal: PVE territory has no override.
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('refuses a directory a live iSCSI LUN is backed from (iscsi.6`s ONE question)', async () => {
    // A file-backed LUN is an ordinary file: an in-place `--overwrite` restore
    // into its directory would rewrite it while an initiator is mid-write, and
    // nothing below ANAS stops that.
    const configfs = join(dir, 'configfs')
    await mkdir(join(configfs, 'target/core/fileio_0/lun2'), { recursive: true })
    await writeFile(join(configfs, 'target/core/fileio_0/lun2/udev_path'), '/gtbackup/data/lun2.raw\n')
    setEnv('ANAS_ISCSI_CONFIGFS', configfs)
    // A fresh server so the route picks the override up.
    await server.close()
    server = createServer({ mock: true, logger: false })
    const res = await post(body({ task: undefined, target: { mode: 'inPlace', path: '/gtbackup/data' } }))
    // Either the claim reader found it (409) or the node has no LIO stack in
    // this harness (fail-open) — what must NEVER happen is a restore starting
    // over a live LUN, so that is what is asserted.
    if (res.statusCode === 409)
      assert.match((res.json() as { error: { message: string } }).error.message, /LUN/)
    assert.equal(restoreRan(), false)
  })

  it('refuses a path storage.cfg claims, naming it', async () => {
    await writeFile(join(dir, 'storage.cfg'), 'dir: extra\n\tpath /srv/pve-extra\n\tcontent iso\n')
    const res = await post(body({ task: undefined, target: { mode: 'inPlace', path: '/srv/pve-extra/sub' } }))
    assert.equal(res.statusCode, 409)
    assert.match((res.json() as { error: { message: string } }).error.message, /storage\.cfg claims/)
    assert.equal(restoreRan(), false)
  })

  it('refuses a selection this archive does not hold — a silent success is worse (GT-24)', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: '', stderr: 'Starting interactive shell\nError: no such file or directory: "nope.txt"\n', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    const res = await post(body({ selections: ['/nope.txt'] }))
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: { message: string } }).error.message, /does not hold \/nope\.txt/)
    assert.equal(restoreRan(), false)
  })

  it('refuses a read-only target BEFORE the client discovers it at the first file (GT-56 F8)', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/touch', `/gtbackup/.anas-restore-write-test-${process.pid}`],
      result: { stdout: '', stderr: 'touch: cannot touch \'/gtbackup/x\': Read-only file system\n', exitCode: 1 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 409)
    assert.match((res.json() as { error: { message: string } }).error.message, /Read-only file system/)
    assert.equal(restoreRan(), false)
  })

  it('refuses when the selection does not fit, naming BOTH numbers', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 5_000_000, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 10\n', stderr: '', exitCode: 0 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 409)
    const message = (res.json() as { error: { message: string } }).error.message
    assert.match(message, /5000000 bytes/)
    assert.match(message, /40960 bytes free/)
    assert.equal(restoreRan(), false)
  })

  // --- Hardlink completion --------------------------------------------------

  it('completes a partly-named hardlink group and says so (GT-25)', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: {
        stdout: statBlock('/hard-b.txt -> "hard-a.txt"', 0, 'symlink', '0', 'L---------'),
        stderr: '',
        exitCode: 0,
      },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: PBC,
      args: ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'],
      result: { stdout: '[]', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', `${SIDE}/hard-b.txt`, `${SIDE}/hard-a.txt`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${SIDE}/hard-b.txt\n${SIDE}/hard-a.txt\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: [
        'restore',
        SNAP,
        'data.pxar',
        SIDE,
        '--ns',
        'gtrestore',
        '--pattern',
        '/hard-b.txt',
        '--pattern',
        '/hard-a.txt',
      ],
      result: { stdout: '', stderr: 'restore complete (26 B processed in <0.1s, average 1 KiB/s)\r', exitCode: 0 },
    })

    const res = await post(body({ selections: ['/hard-b.txt'] }))
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    const result = job.result as BackupFilesRestoreResult
    assert.deepEqual(result.selections, ['/hard-b.txt', '/hard-a.txt'])
    assert.deepEqual(result.addedForHardlinks, ['/hard-a.txt'])
    assert.ok(result.warnings.some(w => /hardlink/i.test(w)))
    // BOTH patterns went to the client — the partner is not decoration.
    const call = mockOf(server).calls.find(c => c.command === PBC && c.args[0] === 'restore')!
    assert.deepEqual(
      call.args.filter((a, i) => call.args[i - 1] === '--pattern'),
      ['/hard-b.txt', '/hard-a.txt'],
    )
  })

  // --- Verification ---------------------------------------------------------

  it('a silent no-match completes WITH WARNINGS and names what is missing (GT-24)', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', `${SIDE}/alpha.txt`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: '', stderr: 'find: no such file\n', exitCode: 1 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', SIDE, '--ns', 'gtrestore', '--pattern', '/alpha.txt'],
      result: { stdout: '', stderr: 'restore complete (2.546 KiB processed in <0.1s, average 2.886 MiB/s)\r', exitCode: 0 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    const result = job.result as BackupFilesRestoreResult
    assert.equal(result.status, 'completed-with-warnings')
    assert.deepEqual(result.missing, ['/alpha.txt'])
  })

  // --- New location (backup2.10) --------------------------------------------

  describe('newLocation — the path IS the new directory the restore creates', () => {
    const NEWLOC = '/gtbackup/elsewhere'

    function newLocationBody(over: Record<string, unknown> = {}): Record<string, unknown> {
      return body({ task: undefined, target: { mode: 'newLocation', path: NEWLOC }, ...over })
    }

    it('a newLocation door without its path is refused at the boundary', async () => {
      const res = await post(body({ task: undefined, target: { mode: 'newLocation' } }))
      assert.equal(res.statusCode, 400)
      assert.match((res.json() as { error: { message: string } }).error.message, /target\.path/)
      assert.equal(restoreRan(), false)
    })

    it('an existing path is refused — newLocation always creates, never merges', async () => {
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: shellArgs(),
        result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
        result: { stdout: 'directory\n', stderr: '', exitCode: 0 },
      })
      const res = await post(newLocationBody())
      assert.equal(res.statusCode, 409)
      const message = (res.json() as { error: { message: string } }).error.message
      assert.match(message, /already exists/)
      assert.match(message, /newLocation/)
      assert.equal(restoreRan(), false)
    })

    it('creates the new directory and restores into it — no overwrite flags, no gate', async () => {
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: shellArgs(),
        result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: 'Starting interactive shell\n', exitCode: 0 },
      })
      // The new directory must NOT exist — parents are created by the client (GT-15).
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
        result: { stdout: '', stderr: 'No such file or directory\n', exitCode: 1 },
      })
      // Verification: the picked file is there after the restore.
      mock.addFixture({
        command: TIMEOUT,
        args: ['30', '/usr/bin/find', '-P', `${NEWLOC}/alpha.txt`, '-maxdepth', '0', '-printf', '%p\n'],
        result: { stdout: `${NEWLOC}/alpha.txt\n`, stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: PBC,
        args: ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/alpha.txt'],
        result: { stdout: '', stderr: 'restore complete (2.546 KiB processed in <0.1s, average 777.059 KiB/s)    \r', exitCode: 0 },
      })

      const res = await post(newLocationBody())
      assert.equal(res.statusCode, 202, 'a new directory is never confirm-gated')
      const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as BackupFilesRestoreResult
      assert.equal(result.mode, 'newLocation')
      assert.equal(result.target, NEWLOC, 'the operator\'s path IS the target, no derivation')
      assert.equal(result.merge, false)
      assert.equal(result.status, 'completed')
      assert.deepEqual(result.patterns, ['/alpha.txt'])
      assert.deepEqual(result.missing, [])

      const call = mock.calls.find(c => c.command === PBC && c.args[0] === 'restore')!
      assert.deepEqual(call.args, ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/alpha.txt'])
      // No overwrite flags for a new directory (GT-15), and no secret on argv.
      assert.ok(!call.args.includes('--overwrite'))
      assert.ok(!call.args.includes('--allow-existing-dirs'))
      assert.ok(!mock.calls.some(c => c.args.some(a => a.includes('token-secret-value'))))
    })

    it('refuses a path in PVE territory, and nothing ran', async () => {
      const res = await post(newLocationBody({ target: { mode: 'newLocation', path: '/mnt/pve/backups' } }))
      assert.equal(res.statusCode, 409)
      assert.match((res.json() as { error: { message: string } }).error.message, /belongs to Proxmox/)
      assert.equal(restoreRan(), false)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
    })

    it('refuses when the selection does not fit the new location\'s filesystem, naming BOTH numbers', async () => {
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: shellArgs(),
        result: { stdout: statBlock('/alpha.txt', 5_000_000, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
        result: { stdout: '', stderr: 'No such file', exitCode: 1 },
      })
      // The check lands on the parent — the directory the new one will be created in.
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
        result: { stdout: '4096 10\n', stderr: '', exitCode: 0 },
      })
      const res = await post(newLocationBody())
      assert.equal(res.statusCode, 409)
      const message = (res.json() as { error: { message: string } }).error.message
      assert.match(message, /5000000 bytes/)
      assert.match(message, /40960 bytes free/)
      assert.equal(restoreRan(), false)
    })
  })

  // --- Failure --------------------------------------------------------------

  it('a failed restore fails the JOB and labels the side-by-side directory', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', SIDE],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', SIDE, '-mindepth', '1', '-maxdepth', '1', '-printf', '.'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', SIDE, '--ns', 'gtrestore', '--pattern', '/alpha.txt'],
      result: { stdout: '', stderr: 'Error: client error (Connect)\n\nCaused by:\n    error connecting to https://localhost:8007/ - tcp connect error: Connection refused (os error 111)\n', exitCode: 255 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /Connection refused/)
    // Nothing landed, so the empty directory was removed rather than left as litter.
    assert.match(job.error!.message, /empty restore directory/)
  })
})
