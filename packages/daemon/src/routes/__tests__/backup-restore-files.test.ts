import type { BackupFilesRestoreResult, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { mountClaim } from '../../safety/guard.js'
import { createServer } from '../../server.js'
import { CATALOG_PREFLIGHT_TIMEOUT_S } from '../../services/backup-catalog.js'

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
/** The default body's destination: an operator-named directory that does not exist yet. */
const NEWLOC = '/gtbackup/elsewhere'

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
  return [String(CATALOG_PREFLIGHT_TIMEOUT_S), PBC, 'catalog', 'shell', SNAP, 'data.pxar', '--ns', 'gtrestore']
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

  /**
   * The default body: the task door, one picked file, and the operator's
   * named destination (newLocation) — the default since the beside-the-original
   * mode was dropped (ruling 2026-08-29). The path names a directory that does
   * not exist yet, so the restore creates it with no merge flags.
   */
  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'files',
      repo: 'pbs-main',
      task: 'nightly',
      snapshot: SNAP,
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
      target: { mode: 'newLocation', path: NEWLOC },
      ...overrides,
    }
  }

  /** Register the pre-flight answers a HAPPY newLocation (new directory) restore needs. */
  function seedHappyPath(opts: { target?: string, selections?: string[], stats?: string, found?: string[] } = {}): void {
    const mock = mockOf(server)
    const target = opts.target ?? NEWLOC
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
    // The newLocation directory must NOT exist yet (the restore creates it).
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

  // --- newLocation, the default --------------------------------------------

  it('the default body restores into the operator`s named directory, created by the restore', async () => {
    seedHappyPath()
    const res = await post(body())
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    const result = job.result as BackupFilesRestoreResult
    assert.equal(result.kind, 'files')
    assert.equal(result.status, 'completed')
    assert.equal(result.target, NEWLOC)
    assert.equal(result.mode, 'newLocation')
    assert.equal(result.merge, false)
    assert.deepEqual(result.patterns, ['/alpha.txt'])
    assert.deepEqual(result.restored, ['/alpha.txt'])
    assert.deepEqual(result.missing, [])

    const call = mockOf(server).calls.find(c => c.command === PBC && c.args[0] === 'restore')!
    assert.deepEqual(call.args, [
      'restore',
      SNAP,
      'data.pxar',
      NEWLOC,
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

  // cr.36r: the destination is canonicalised ONCE at the door, so the probe,
  // the confirm signature and the restore argv all carry one spelling.
  it('`/gtbackup//elsewhere/` restores to `/gtbackup/elsewhere` — the argv carries the canonical spelling', async () => {
    // The fixtures answer for the CANONICAL directory only (seeded default):
    // the raw spelling reaching any probe would miss and fail the job.
    seedHappyPath()
    const res = await post(body({ target: { mode: 'newLocation', path: '/gtbackup//elsewhere/' } }))
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    const result = job.result as BackupFilesRestoreResult
    assert.equal(result.target, NEWLOC, 'the job result names the canonical directory')
    const call = mockOf(server).calls.find(c => c.command === PBC && c.args[0] === 'restore')!
    assert.equal(call.args[3], NEWLOC)
    assert.ok(!call.args.some(a => a.includes('//')), 'no doubled slash reaches the client argv')
  })

  it('an EXISTING newLocation directory earns a 409 confirm code — not a plain refusal', async () => {
    // Ruling 2026-08-29: restoring into a directory the operator already has
    // is legitimate — it overwrites live data, so it earns the same gate as an
    // in-place restore (the confirmed leg is in the newLocation describe below).
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
    const res = await post(body())
    assert.equal(res.statusCode, 409)
    const err = (res.json() as { error: { code: string, message: string, warnings: string[] } }).error
    assert.equal(err.code, 'CONFIRMATION_REQUIRED')
    assert.match(err.message, /already exists: restoring into it overwrites files with the same names and keeps everything else/)
    assert.ok(err.warnings.some(w => /already exists/.test(w)), 'the confirm dialog renders the warnings, not the message')
    assert.ok(res.headers['x-anas-confirm-code'], 'a confirm code is issued')
    assert.equal(restoreRan(), false)
  })

  it('a newLocation door without its path is refused at the boundary, and works with one', async () => {
    const without = await post(body({ task: undefined, target: { mode: 'newLocation' } }))
    assert.equal(without.statusCode, 400)
    assert.match((without.json() as { error: { message: string } }).error.message, /target\.path/)
    assert.equal(restoreRan(), false)

    seedHappyPath()
    const withPath = await post(body({ task: undefined }))
    assert.equal(withPath.statusCode, 202)
    const job = await waitForJob(server, (withPath.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed')
    assert.equal((job.result as BackupFilesRestoreResult).target, NEWLOC)
  })

  it('an EXPANDED archive name matches no task archive and asks for the path', async () => {
    // backup2.3's `<name>__<child>` flattened a path with `/` → `_`, which
    // cannot be inverted — so an inPlace restore (which needs the task's home)
    // is refused rather than guessed, and no dataset is created.
    const res = await post(body({ archive: 'data__photos.pxar', target: { mode: 'inPlace' } }))
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

  it('a newLocation restore of a TREE into a directory that does not exist is NEVER gated', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/docs', 0, 'directory', '755', 'drwxr-xr-x'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
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
      args: ['30', '/usr/bin/find', '-P', `${NEWLOC}/docs`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${NEWLOC}/docs\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/docs'],
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

  // cr.36r: the destination is canonicalised ONCE at the door, so the
  // territory check sees one spelling. The old trailing-slash-only strip let
  // `/mnt//pve/…` slip past the `startsWith` in isPathWithin — one directory,
  // two answers.
  it('the `/mnt//pve/backups` spelling of a PVE-territory target is refused too, and nothing ran', async () => {
    const res = await post(body({ task: undefined, target: { mode: 'inPlace', path: '/mnt//pve/backups' } }))
    assert.equal(res.statusCode, 409)
    assert.match((res.json() as { error: { message: string } }).error.message, /belongs to Proxmox/)
    assert.equal(restoreRan(), false)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('refuses a directory a live iSCSI LUN is backed from (iscsi.6`s ONE question)', async () => {
    // A file-backed LUN is an ordinary file: an in-place `--overwrite` restore
    // into its directory would rewrite it while an initiator is mid-write, and
    // nothing below ANAS stops that.
    // The captured live configfs tree (ruling (l)) with its file-backed LUN's
    // backing re-pointed into the restore's destination.
    const configfs = join(dir, 'target')
    const manifest = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/iscsi/configfs-live.manifest'), 'utf8')
    assert.equal(manifest.split('= /gtiscsi/images/lun2.raw\n').length, 2)
    await materializeConfigfsManifest(manifest.replace('= /gtiscsi/images/lun2.raw\n', '= /gtbackup/data/lun2.raw\n'), configfs)
    setEnv('ANAS_ISCSI_CONFIGFS', configfs)
    // A fresh server so the route picks the override up.
    await server.close()
    server = createServer({ mock: true, logger: false })
    const res = await post(body({ task: undefined, target: { mode: 'inPlace', path: '/gtbackup/data' } }))
    // cr.56: the refusal itself is asserted — the 409 used to be checked only
    // `if` it came, and the request was in fact answered 400 by the selection
    // gate (the hand-made configfs above was not a tree the claims reader
    // reads, so the gate never saw a LUN).
    assert.equal(res.statusCode, 409, res.body)
    const err = (res.json() as { error: { code: string, reason?: string, message: string } }).error
    assert.equal(err.code, 'CONFLICT')
    assert.equal(err.reason, 'held-by-lun')
    assert.match(err.message, /LUN/)
    assert.match(err.message, /\/gtbackup\/data\/lun2\.raw/)
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
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
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
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    // The probe name is random (review H7): match the touch by shape.
    mock.addFixture({
      command: TIMEOUT,
      argsMatch: args => args[1] === '/usr/bin/touch',
      result: { stdout: '', stderr: 'touch: cannot touch \'/gtbackup/x\': Read-only file system\n', exitCode: 1 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 409)
    const probe = mock.calls.find(c => c.command === TIMEOUT && c.args[1] === '/usr/bin/touch')
    assert.ok(probe, 'the write probe ran')
    assert.match(probe.args[2], /^\/gtbackup\/\.anas-restore-write-test-[0-9a-f]{16}$/)
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
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
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
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
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
      args: ['30', '/usr/bin/find', '-P', `${NEWLOC}/hard-b.txt`, `${NEWLOC}/hard-a.txt`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: `${NEWLOC}/hard-b.txt\n${NEWLOC}/hard-a.txt\n`, stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: [
        'restore',
        SNAP,
        'data.pxar',
        NEWLOC,
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
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', `${NEWLOC}/alpha.txt`, '-maxdepth', '0', '-printf', '%p\n'],
      result: { stdout: '', stderr: 'find: no such file\n', exitCode: 1 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/alpha.txt'],
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

  describe('newLocation — the path IS the directory the restore writes into', () => {
    function newLocationBody(over: Record<string, unknown> = {}): Record<string, unknown> {
      return body({ task: undefined, target: { mode: 'newLocation', path: NEWLOC }, ...over })
    }

    it('an EXISTING directory: 409 + confirm code, and a CONFIRM runs the in-place merge', async () => {
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: shellArgs(),
        result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
      })
      // The directory EXISTS — this is what makes the first post a gate.
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
        result: { stdout: 'directory\n', stderr: '', exitCode: 0 },
      })
      // Confirmed leg: the write test and the space check land on the directory
      // ITSELF (it exists now, unlike the created-new case), the selection is
      // verified under it, and the client gets the MERGE pair (GT-11).
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', NEWLOC],
        result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: TIMEOUT,
        args: ['30', '/usr/bin/find', '-P', `${NEWLOC}/alpha.txt`, '-maxdepth', '0', '-printf', '%p\n'],
        result: { stdout: `${NEWLOC}/alpha.txt\n`, stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: PBC,
        args: ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/alpha.txt', '--allow-existing-dirs', '--overwrite'],
        result: { stdout: '', stderr: 'restore complete (2.546 KiB processed in <0.1s, average 777.059 KiB/s)    \r', exitCode: 0 },
      })

      const payload = newLocationBody()
      const first = await post(payload)
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code, 'a confirm code is issued')
      const err = (first.json() as { error: { code: string, message: string } }).error
      assert.equal(err.code, 'CONFIRMATION_REQUIRED')
      assert.match(err.message, /already exists: restoring into it overwrites files with the same names and keeps everything else/)
      assert.equal(restoreRan(), false, 'the gate refused BEFORE the client ran')

      const second = await post(payload, { 'x-anas-confirm': code })
      assert.equal(second.statusCode, 202)
      const job = await waitForJob(server, (second.json() as { job: { id: string } }).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const result = job.result as BackupFilesRestoreResult
      assert.equal(result.mode, 'newLocation')
      assert.equal(result.merge, true, 'the record says it MERGED into a pre-existing directory')
      const call = mock.calls.find(c => c.command === PBC && c.args[0] === 'restore')!
      assert.ok(call.args.includes('--allow-existing-dirs'))
      assert.ok(call.args.includes('--overwrite'))
    })

    it('an existing path that is NOT a directory is a plain 400 — no gate, nothing ran', async () => {
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: shellArgs(),
        result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
        result: { stdout: 'regular file\n', stderr: '', exitCode: 0 },
      })
      const res = await post(newLocationBody())
      assert.equal(res.statusCode, 400)
      const err = (res.json() as { error: { code: string, message: string } }).error
      assert.equal(err.code, 'VALIDATION_ERROR')
      assert.match(err.message, /already exists and is not a directory/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
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

  it('a failed restore fails the JOB and removes the EMPTY newLocation directory it created', async () => {
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', NEWLOC, '-mindepth', '1', '-maxdepth', '1', '-printf', '.'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/alpha.txt'],
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

  it('cr.48c: pbc echoing the repo secret on a failed restore leaves only [secret] in the failed job record', async () => {
    // The shared-classifier fallback: the stderr line echoes the repo's token
    // secret, and the whole job record — error message, params, everything the
    // queue persists — must never carry the plain value.
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      args: shellArgs(),
      result: { stdout: statBlock('/alpha.txt', 23, 'file', '644', '-rw-r--r--'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
      result: { stdout: '', stderr: 'No such file', exitCode: 1 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['10', '/usr/bin/stat', '-f', '-c', '%S %a', '/gtbackup'],
      result: { stdout: '4096 1000000\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: TIMEOUT,
      args: ['30', '/usr/bin/find', '-P', NEWLOC, '-mindepth', '1', '-maxdepth', '1', '-printf', '.'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: PBC,
      args: ['restore', SNAP, 'data.pxar', NEWLOC, '--ns', 'gtrestore', '--pattern', '/alpha.txt'],
      result: { stdout: '', stderr: 'Error: proxmox-backup-client rejected token-secret-value\n', exitCode: 255 },
    })
    const res = await post(body())
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error!.message, /\[secret\]/)
    assert.ok(!job.error!.message.includes('token-secret-value'), job.error!.message)
    assert.ok(!JSON.stringify(job).includes('token-secret-value'), 'no plain secret anywhere in the job record')
  })

  // --- cr.54 (review H3): the file restore is on the guard ------------------
  //
  // The confirm signs the whole validated request; the job re-reads its
  // destination and re-runs every route gate when the queue starts it; the
  // territory check refuses on an unreadable storage.cfg; the job holds the
  // destination filesystem's keys shared.

  describe('cr.54 — bound confirm, job-time re-gate, fail-closed territory, destination locks', () => {
    function queue(): JobQueue {
      return (server as unknown as { jobQueue: JobQueue }).jobQueue
    }

    /** One `stat` block per path, the catalog shell's answer for a several-path selection. */
    function treeStats(paths: string[]): string {
      return paths.map(p => statBlock(p, 0, 'directory', '755', 'drwxr-xr-x')).join('\n')
    }

    /** An in-place TREE restore of HOME up to its confirm: catalog, manifest size, space, all answered. */
    function seedInPlaceTree(archive = 'data.pxar', paths = ['/docs', '/etc']): void {
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: [String(CATALOG_PREFLIGHT_TIMEOUT_S), PBC, 'catalog', 'shell', SNAP, archive, '--ns', 'gtrestore'],
        result: { stdout: treeStats(paths), stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: PBC,
        args: ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'],
        result: {
          stdout: JSON.stringify([{
            'backup-id': 'gtrestore',
            'backup-time': 1787685405,
            'backup-type': 'host',
            'files': [
              { 'crypt-mode': 'none', 'filename': 'data.pxar.didx', 'size': 2607 },
              { 'crypt-mode': 'none', 'filename': 'etc.pxar.didx', 'size': 2607 },
            ],
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
    }

    /** Mint a code for `payload` (asserting the first answer is the plain challenge). */
    async function mint(payload: Record<string, unknown>): Promise<string> {
      const first = await post(payload)
      assert.equal(first.statusCode, 409, first.body)
      assert.equal((first.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)
      return code
    }

    function assertScopeChanged(res: Awaited<ReturnType<typeof post>>, field: string): void {
      assert.equal(res.statusCode, 409, res.body)
      const err = (res.json() as { error: { code: string, message: string, changed: string[] } }).error
      assert.equal(err.code, 'CONFIRM_SCOPE_CHANGED')
      assert.ok(err.changed.includes(field), `the 409 names '${field}': ${JSON.stringify(err.changed)}`)
      assert.match(err.message, new RegExp(`You confirmed with ${field} `))
      assert.ok(res.headers['x-anas-confirm-code'], 'a fresh code for the request as it is now')
      assert.equal(restoreRan(), false)
    }

    it('the H3 probe: a code minted for an in-place restore of /docs replayed with /docs AND /etc is 409 CONFIRM_SCOPE_CHANGED naming the selections — no restore argv', async () => {
      seedInPlaceTree()
      const code = await mint(body({ selections: ['/docs'], target: { mode: 'inPlace' } }))
      const res = await post(body({ selections: ['/docs', '/etc'], target: { mode: 'inPlace' } }), { 'x-anas-confirm': code })
      assertScopeChanged(res, 'selections')
    })

    it('a code minted for archive data.pxar replayed with etc.pxar is 409 CONFIRM_SCOPE_CHANGED naming the archive', async () => {
      seedInPlaceTree('data.pxar', ['/docs'])
      seedInPlaceTree('etc.pxar', ['/docs'])
      // The path is named: `etc` is no archive of the task, so its home cannot be looked up.
      const code = await mint(body({ selections: ['/docs'], target: { mode: 'inPlace', path: HOME } }))
      const res = await post(body({ archive: 'etc.pxar', selections: ['/docs'], target: { mode: 'inPlace', path: HOME } }), { 'x-anas-confirm': code })
      assertScopeChanged(res, 'archive')
    })

    it('a code minted without options replayed with --ignore-ownership is 409 CONFIRM_SCOPE_CHANGED naming the options', async () => {
      seedInPlaceTree('data.pxar', ['/docs'])
      const code = await mint(body({ selections: ['/docs'], target: { mode: 'inPlace' } }))
      const res = await post(body({ selections: ['/docs'], target: { mode: 'inPlace' }, options: { ignoreOwnership: true } }), { 'x-anas-confirm': code })
      assertScopeChanged(res, 'options')
    })

    it('a code minted for namespace gtrestore replayed with another namespace is 409 CONFIRM_SCOPE_CHANGED naming ns', async () => {
      seedInPlaceTree('data.pxar', ['/docs'])
      // The other namespace's catalog answers the same tree (the gates pass; only the binding refuses).
      mockOf(server).addFixture({
        command: TIMEOUT,
        args: [String(CATALOG_PREFLIGHT_TIMEOUT_S), PBC, 'catalog', 'shell', SNAP, 'data.pxar', '--ns', 'other'],
        result: { stdout: treeStats(['/docs']), stderr: '', exitCode: 0 },
      })
      const code = await mint(body({ selections: ['/docs'], target: { mode: 'inPlace' } }))
      const res = await post(body({ ns: 'other', selections: ['/docs'], target: { mode: 'inPlace' } }), { 'x-anas-confirm': code })
      assertScopeChanged(res, 'ns')
    })

    it('the exact request replayed with its code still runs — the binding refuses changes, not the confirm', async () => {
      seedInPlaceTree('data.pxar', ['/docs'])
      const mock = mockOf(server)
      mock.addFixture({
        command: TIMEOUT,
        args: ['30', '/usr/bin/find', '-P', `${HOME}/docs`, '-maxdepth', '0', '-printf', '%p\n'],
        result: { stdout: `${HOME}/docs\n`, stderr: '', exitCode: 0 },
      })
      mock.addFixture({
        command: PBC,
        args: ['restore', SNAP, 'data.pxar', HOME, '--ns', 'gtrestore', '--pattern', '/docs', '--allow-existing-dirs', '--overwrite'],
        result: { stdout: '', stderr: 'restore complete (2.546 KiB processed in <0.1s, average 1 MiB/s)\r', exitCode: 0 },
      })
      const payload = body({ selections: ['/docs'], target: { mode: 'inPlace' } })
      const code = await mint(payload)
      const res = await post(payload, { 'x-anas-confirm': code })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    })

    // --- Job time --------------------------------------------------------------

    /**
     * `/gtbackup` as a ZFS filesystem: the captured `findmnt-full.json` with its
     * `mnttest` row re-pointed (ruling (l): a captured line, renamed), and the
     * pool's guid — so the destination resolves to `gtbackup` and the restore
     * claims `zfs:<guid>`, the pool and `mount:/gtbackup`, all shared.
     */
    function seedZfsDestination(): void {
      const findmnt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/mounts/findmnt-full.json'), 'utf8')
      assert.equal(findmnt.split('"/mnttest"').length, 2)
      assert.equal(findmnt.split('"mnttest"').length, 2)
      const mock = mockOf(server)
      mock.prependFixture({
        command: '/usr/bin/findmnt',
        args: ['--json'],
        result: { stdout: findmnt.replace('"/mnttest"', '"/gtbackup"').replace('"mnttest"', '"gtbackup"'), stderr: '', exitCode: 0 },
      })
      mock.prependFixture({
        command: '/usr/sbin/zpool',
        args: ['get', '-H', '-o', 'value', 'guid', '--', 'gtbackup'],
        result: { stdout: '5823146802312415237\n', stderr: '', exitCode: 0 },
      })
    }

    /**
     * A job that holds `mount:/gtbackup` EXCLUSIVE (what an unmount of the
     * destination's filesystem takes) until `release()` — the queue parks the
     * restore behind it, and the node changes while it waits.
     */
    function holdDestinationMount(): { id: string, release: () => void } {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const job = queue().submit('mount.unmount', { user: 'test', uid: 0 }, () => held, { locks: [mountClaim('/gtbackup')] })
      return { id: job.id, release }
    }

    async function waitingBehind(id: string, blocker: string): Promise<void> {
      for (let i = 0; i < 200 && queue().get(id)?.status !== 'queued'; i++)
        await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(queue().get(id)?.status, 'queued', 'the restore waits')
      assert.equal(queue().get(id)?.progress, `waiting for mount.unmount (job ${blocker}) on the mount at /gtbackup`)
    }

    it('a newLocation directory that APPEARS while the job waits fails the job STATE_CHANGED — the fresh restore never becomes an unconfirmed merge, no restore argv', async () => {
      seedHappyPath()
      seedZfsDestination()
      const blocker = holdDestinationMount()
      const res = await post(body())
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      await waitingBehind(id, blocker.id)

      // Someone creates the directory while the restore waits.
      mockOf(server).prependFixture({
        command: TIMEOUT,
        args: ['10', '/usr/bin/stat', '-c', '%F', NEWLOC],
        result: { stdout: 'directory\n', stderr: '', exitCode: 0 },
      })
      blocker.release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'STATE_CHANGED')
      assert.match(job.error!.message, /Restore destination '\/gtbackup\/elsewhere' changed since you confirmed — nothing was done/)
      assert.equal(restoreRan(), false, 'no restore argv')
    })

    it('a destination whose filesystem goes away while the job waits (the dataset unmounted: the path is on / now) fails STATE_CHANGED — no restore argv', async () => {
      seedHappyPath()
      seedZfsDestination()
      const blocker = holdDestinationMount()
      const res = await post(body())
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      await waitingBehind(id, blocker.id)

      // The unmount the blocker stands for ran: the captured table without the gtbackup row.
      mockOf(server).prependFixture({
        command: '/usr/bin/findmnt',
        args: ['--json'],
        result: { stdout: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/mounts/findmnt-full.json'), 'utf8'), stderr: '', exitCode: 0 },
      })
      blocker.release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'STATE_CHANGED')
      assert.equal(restoreRan(), false, 'no restore argv')
    })

    it('cr.56: a credential DELETED while the restore waits fails the job naming it — the job reads the repository and its secret again; no restore argv', async () => {
      seedHappyPath()
      seedZfsDestination()
      const blocker = holdDestinationMount()
      const res = await post(body())
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      await waitingBehind(id, blocker.id)

      await rm(join(dir, 'creds', 'backup-repo-pbs-main.secret'))
      blocker.release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.message, `No secret stored for repository 'pbs-main' — set its credentials first; nothing was restored`)
      assert.equal(restoreRan(), false, 'no restore argv')
    })

    it('a path PVE claims while the job waits fails the job PVE_MANAGED — the route\'s territory gate runs again at its turn', async () => {
      seedHappyPath()
      seedZfsDestination()
      const blocker = holdDestinationMount()
      const res = await post(body())
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      await waitingBehind(id, blocker.id)

      await writeFile(join(dir, 'storage.cfg'), 'dir: extra\n\tpath /gtbackup\n\tcontent iso\n')
      blocker.release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'PVE_MANAGED')
      assert.match(job.error!.message, /storage\.cfg claims/)
      assert.equal(restoreRan(), false, 'no restore argv')
    })

    it('an UNREADABLE storage.cfg refuses the territory check at the route (the config-unreadable verdict) — never passes, nothing ran', async () => {
      await rm(join(dir, 'storage.cfg'))
      await mkdir(join(dir, 'storage.cfg'))
      seedHappyPath()
      const res = await post(body())
      assert.equal(res.statusCode, 400, res.body)
      const err = (res.json() as { error: { code: string, message: string } }).error
      assert.equal(err.code, 'VALIDATION_ERROR')
      assert.match(err.message, /PVE storage configuration is unreadable .* cannot be checked against the paths PVE storage claims/)
      assert.equal(restoreRan(), false)
      // Refused before anything touched the destination.
      assert.ok(!mockOf(server).calls.some(c => c.args.includes(NEWLOC) || c.args.some(a => a.startsWith('/gtbackup'))))
    })

    it('a storage.cfg that becomes unreadable while the job waits fails the job — never passes, no restore argv', async () => {
      seedHappyPath()
      seedZfsDestination()
      const blocker = holdDestinationMount()
      const res = await post(body())
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      await waitingBehind(id, blocker.id)

      await rm(join(dir, 'storage.cfg'))
      await mkdir(join(dir, 'storage.cfg'))
      blocker.release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'VALIDATION_ERROR')
      assert.match(job.error!.message, /PVE storage configuration is unreadable/)
      assert.equal(restoreRan(), false, 'no restore argv')
    })

    it('a path in PVE territory answers cr.47(b)\'s one fact: 409 PVE_MANAGED, reason pve-managed', async () => {
      const res = await post(body({ task: undefined, target: { mode: 'inPlace', path: '/mnt/pve/backups' } }))
      assert.equal(res.statusCode, 409)
      const err = (res.json() as { error: { code: string, reason: string } }).error
      assert.equal(err.code, 'PVE_MANAGED')
      assert.equal(err.reason, 'pve-managed')
    })

    it('the job holds the destination filesystem\'s keys SHARED for the run, and the restore completes once the blocker is done', async () => {
      seedHappyPath()
      seedZfsDestination()
      const blocker = holdDestinationMount()
      const res = await post(body())
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as { job: { id: string } }).job.id
      await waitingBehind(id, blocker.id)
      blocker.release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.ok(restoreRan())
    })
  })
})
