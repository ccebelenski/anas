import type { BackupBrowseResult, CloudRemoteTestResult, CloudSyncPreviewResult, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AbandonedRegistry, CommandTimeoutError } from '../../executor/deadline.js'
import { ProdExecutor } from '../../executor/prod.js'
import { READ_CANCEL_WAIT_MS } from '../../jobs/child-cancel.js'
import { isReadOnlyOperation, READ_JOB_OPERATIONS, READ_JOB_PREFIX } from '../../jobs/read-jobs.js'
import { createServer } from '../../server.js'
import { CATALOG_SHELL_TIMEOUT_S } from '../../services/backup-catalog.js'
import { PREVIEW_TIMEOUT_S } from '../../services/cloud-preview.js'
import { RCLONE, rcloneBaseArgs } from '../../services/rclone-config.js'
import { PROBE_TIMEOUT_S } from '../../services/rclone-probe.js'
import { RCLONE_NOT_INSTALLED } from '../cloud.js'

/**
 * cr.48 (operator ruling 2026-10-15) — the three slow interactive reads as
 * cancellable READ jobs, end to end through the daemon's own routes:
 *
 *   POST /v1/cloud/tasks/preview      → read.cloud.preview
 *   POST /v1/cloud/remotes/test       → read.cloud.remote.test
 *   POST /v1/backup/restore/browse    → read.backup.catalog
 *
 * Each: accepted (202, the read-only operation), the result shape, a cancel
 * through `POST /v1/jobs/:id/cancel` (no confirm — a read) that stops a REAL
 * child's whole process group, and failed. The real child: the route's own
 * `/usr/bin/timeout <ceiling>` wrapper, kept verbatim, around `/bin/sh -c
 * 'sleep <mark>; true'` in place of rclone / proxmox-backup-client, spawned by
 * the PRODUCTION executor — so the sleep is a GRANDCHILD of the wrapper and
 * only a group signal reaches it once the shell is gone.
 */

const TIMEOUT = '/usr/bin/timeout'
const PBC = '/usr/bin/proxmox-backup-client'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')
const DRY_RUN_DELETE_LOG = join(FIXTURES, 'rclone', 'dry-run-sync-delete-1.60.1.log')

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

type Server = ReturnType<typeof createServer>

function mockOf(server: Server): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

/** A `sleep` duration no other process on the host runs: the marker pgrep looks for. */
function marker(): string {
  return `${700 + Math.floor(Math.random() * 200)}.${process.pid}${Math.floor(Math.random() * 1000)}`
}

/** Pids of `sleep <mark>` still alive. */
function sleepers(mark: string): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', `^sleep ${mark}$`]).toString().trim().split('\n').filter(Boolean)
  }
  catch {
    return []
  }
}

function reap(mark: string): void {
  for (const pid of sleepers(mark)) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    }
    catch {}
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond())
      return true
    await new Promise(r => setTimeout(r, 20))
  }
  return cond()
}

async function waitForJob(server: Server, id: string, attempts = 400): Promise<Job> {
  for (let i = 0; i < attempts; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/**
 * Route `timeout` calls that `match` to a REAL child: the wrapper and its
 * duration exactly as the route built them, the wrapped tool replaced by a
 * shell that sleeps. Every redirected argv is recorded.
 */
function realChild(mock: MockExecutor, match: (args: string[]) => boolean, script: string): string[][] {
  const prod = new ProdExecutor({ registry: new AbandonedRegistry() })
  const seen: string[][] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    if (cmd === TIMEOUT && match(args)) {
      seen.push(args)
      return prod.exec(TIMEOUT, [args[0]!, '/bin/sh', '-c', script], opts?.onSpawn ? { onSpawn: opts.onSpawn } : {})
    }
    return orig(cmd, args, opts)
  }
  return seen
}

/** POST a read door; assert the 202 and the read-only operation; the job id. */
async function accept(server: Server, url: string, payload: unknown, operation: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  assert.equal(res.statusCode, 202, res.body)
  const { job } = res.json() as JobAccepted
  assert.equal(job.operation, operation)
  assert.ok(isReadOnlyOperation(job.operation), 'the job is marked read-only by its operation name')
  return job.id
}

/**
 * Cancel a running read job through the ONE cancel door, and prove it: 202
 * with no confirm code, the job ends `cancelled` naming who, and every
 * process of the child's group is gone.
 */
async function cancelAndProve(server: Server, id: string, mark: string, label: string): Promise<{ job: Job, ms: number }> {
  assert.ok(await until(() => sleepers(mark).length === 1, 5_000), `${label}: the real child is running`)
  const t0 = Date.now()
  const res = await server.inject({ method: 'POST', url: `/v1/jobs/${id}/cancel`, headers: IDENTITY })
  assert.equal(res.statusCode, 202, `${label}: ${res.body}`)
  assert.equal(res.headers['x-anas-confirm-code'], undefined, `${label}: a read is cancelled without a confirm`)
  const job = await waitForJob(server, id)
  const ms = Date.now() - t0
  assert.equal(job.status, 'cancelled', `${label}: ${JSON.stringify(job)}`)
  assert.match((job.result as { reason: string }).reason, /^cancelled by root@pam at /, label)
  assert.equal(job.error, null, label)
  assert.deepEqual(sleepers(mark), [], `${label}: the child's whole process group is gone`)
  return { job, ms }
}

describe('cr.48 read-only jobs: the operation-name convention', () => {
  it('the three reads, and only names with the prefix, are read-only', () => {
    assert.deepEqual(Object.values(READ_JOB_OPERATIONS).sort(), ['read.backup.catalog', 'read.cloud.preview', 'read.cloud.remote.test'])
    for (const op of Object.values(READ_JOB_OPERATIONS))
      assert.ok(isReadOnlyOperation(op), op)
    for (const op of ['cloud.task.run', 'backup.restore.image', 'job.cancel', 'cloud.remote.test', 'preview.read'])
      assert.equal(isReadOnlyOperation(op), false, op)
  })

  it('no daemon source outside jobs/read-jobs.ts spells the prefix — a read-only job can only be declared there', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'fixtures')
            walk(full)
          continue
        }
        if (!e.name.endsWith('.ts') || full.endsWith(join('jobs', 'read-jobs.ts')))
          continue
        if (readFileSync(full, 'utf-8').includes(`'${READ_JOB_PREFIX}`))
          offenders.push(full.slice(src.length + 1))
      }
    }
    walk(src)
    assert.deepEqual(offenders, [])
  })
})

describe('cr.48 the cloud reads as jobs (preview, remote test)', () => {
  let server: Server
  let dir: string
  let configFile: string
  let srcDir: string
  const marks: string[] = []
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-readjobs-'))
    configFile = join(dir, 'rclone.conf')
    await writeFile(configFile, '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = rclonegt\npass = obscured\n', 'utf-8')
    setEnv('ANAS_RCLONE_CONFIG', configFile)
    setEnv('ANAS_SYSTEMD_DIR', dir)
    const fstab = join(dir, 'fstab')
    await writeFile(fstab, 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
    setEnv('ANAS_FSTAB_PATH', fstab)
    srcDir = join(dir, 'src')
    await mkdir(srcDir, { recursive: true })
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: RCLONE, args: [...rcloneBaseArgs(configFile), 'config', 'providers'], result: { stdout: '[]', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    for (const m of marks.splice(0))
      reap(m)
    await server.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  const isRclone = (args: string[]): boolean => args[1] === RCLONE

  it('preview: accepted → the counters ride job.result; the dry run\'s stats are the progress line', async () => {
    mockOf(server).addFixture({ command: TIMEOUT, argsMatch: isRclone, result: { stdout: '', stderr: readFileSync(DRY_RUN_DELETE_LOG, 'utf-8'), exitCode: 0 } })
    const id = await accept(server, '/v1/cloud/tasks/preview', { source: srcDir, remote: 'gt', path: 'dst', mode: 'sync' }, READ_JOB_OPERATIONS.cloudPreview)
    const job = await waitForJob(server, id)
    assert.equal(job.status, 'completed')
    const r = job.result as CloudSyncPreviewResult
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'checks', 'deletedFiles', 'deletedTotal', 'deletes', 'errors', 'transfers', 'truncated'])
    assert.deepEqual(r.deletedFiles, ['b.bin'])
    assert.equal(r.truncated, false)
    assert.match(String(job.progress), /^\d+ checked, \d+ to transfer \(\d+ bytes\), \d+ to delete$/)
    const call = mockOf(server).calls.find(c => c.command === TIMEOUT && isRclone(c.args))
    assert.equal(call?.args[0], String(PREVIEW_TIMEOUT_S), 'the ten-minute ceiling rides the wrapper')
  })

  it('preview: Cancel stops the REAL child\'s process group (the wrapper and its grandchild) and ends the job cancelled', async () => {
    const mark = marker()
    marks.push(mark)
    const seen = realChild(mockOf(server), isRclone, `sleep ${mark}; true`)
    const id = await accept(server, '/v1/cloud/tasks/preview', { source: srcDir, remote: 'gt' }, READ_JOB_OPERATIONS.cloudPreview)
    const { ms } = await cancelAndProve(server, id, mark, 'preview')
    assert.ok(ms < READ_CANCEL_WAIT_MS, `the SIGTERM was enough (${ms} ms)`)
    assert.equal(seen[0]?.[0], String(PREVIEW_TIMEOUT_S))
  })

  it('preview: failed — an internal fault in the dry run fails the job with its message', async () => {
    const mock = mockOf(server)
    const orig = mock.exec.bind(mock)
    mock.exec = async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      if (cmd === TIMEOUT && isRclone(args))
        throw new Error('boom')
      return orig(cmd, args, opts)
    }
    const job = await waitForJob(server, await accept(server, '/v1/cloud/tasks/preview', { source: srcDir, remote: 'gt' }, READ_JOB_OPERATIONS.cloudPreview))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, 'boom')
    assert.equal(job.result, null)
  })

  it('remote test: accepted → the verdict rides job.result', async () => {
    mockOf(server).addFixture({ command: TIMEOUT, argsMatch: isRclone, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    const job = await waitForJob(server, await accept(server, '/v1/cloud/remotes/test', { name: 'gt' }, READ_JOB_OPERATIONS.cloudRemoteTest))
    assert.equal(job.status, 'completed')
    assert.deepEqual(job.result as CloudRemoteTestResult, { verdict: 'ok', message: '' })
    const call = mockOf(server).calls.find(c => c.command === TIMEOUT && isRclone(c.args))
    assert.equal(call?.args[0], String(PROBE_TIMEOUT_S), 'the two-minute ceiling rides the wrapper')
  })

  it('remote test: Cancel stops the REAL child\'s process group and ends the job cancelled', async () => {
    const mark = marker()
    marks.push(mark)
    realChild(mockOf(server), isRclone, `sleep ${mark}; true`)
    const id = await accept(server, '/v1/cloud/remotes/test', { name: 'gt' }, READ_JOB_OPERATIONS.cloudRemoteTest)
    const { job } = await cancelAndProve(server, id, mark, 'remote test')
    assert.equal((job.result as { verdict?: string }).verdict, undefined, 'a cancelled Test carries no verdict')
  })

  it('remote test: an UNSAVED dialog\'s private config copy is removed after a cancel too', async () => {
    const mark = marker()
    marks.push(mark)
    const seen = realChild(mockOf(server), isRclone, `sleep ${mark}; true`)
    const id = await accept(server, '/v1/cloud/remotes/test', { remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1' } } }, READ_JOB_OPERATIONS.cloudRemoteTest)
    await cancelAndProve(server, id, mark, 'unsaved test')
    const probeConfig = seen[0]![seen[0]!.indexOf('--config') + 1]!
    assert.notEqual(probeConfig, configFile)
    assert.ok(await until(() => {
      try {
        readdirSync(dirname(probeConfig))
        return false
      }
      catch {
        return true
      }
    }, 2_000), 'the probe\'s temp directory went with the cancelled job')
  })

  it('remote test: failed — rclone gone after the 202 fails the job with the install sentence', async () => {
    const mock = mockOf(server)
    const orig = mock.exec.bind(mock)
    mock.exec = async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      if (cmd === TIMEOUT && isRclone(args)) {
        const err = new Error(`spawn ${TIMEOUT} ENOENT`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return orig(cmd, args, opts)
    }
    const job = await waitForJob(server, await accept(server, '/v1/cloud/remotes/test', { name: 'gt' }, READ_JOB_OPERATIONS.cloudRemoteTest))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, RCLONE_NOT_INSTALLED)
  })

  it('remote test: an UNSAVED dialog whose stderr echoes its pass value masks it in the verdict message, the verdict unchanged', async () => {
    // The review's proven leak: a backend answers the bad credential with the
    // token verbatim. The whole job record must never carry the plain value.
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      argsMatch: isRclone,
      result: {
        stdout: '[]',
        stderr: 'Failed to create file system for "anastest:": NewFs: couldn\'t connect SSH: ssh: handshake failed: ssh: unable to authenticate: 401 Unauthorized (token gtpass)\n',
        exitCode: 1,
      },
    })
    const job = await waitForJob(server, await accept(server, '/v1/cloud/remotes/test', {
      remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' } },
    }, READ_JOB_OPERATIONS.cloudRemoteTest))
    assert.equal(job.status, 'completed')
    const r = job.result as CloudRemoteTestResult
    assert.equal(r.verdict, 'auth', 'the classifier still read the RAW text')
    assert.ok(r.message.includes('[secret]'), r.message)
    assert.ok(!JSON.stringify(job).includes('gtpass'), 'no plain value anywhere in the job record')
  })

  it('remote test: a hung child fails the job with the TIMEOUT sentence — no stderr, and no secret, ever reaches job.error', async () => {
    // The wrapper's own deadline (the executor's margin above `timeout 120`)
    // threw: the CommandTimeoutError names the command that hung, never its
    // output — a stderr echo of a dialog secret must not ride `job.error`.
    const mock = mockOf(server)
    const orig = mock.exec.bind(mock)
    mock.exec = async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      if (cmd === TIMEOUT && isRclone(args))
        throw new CommandTimeoutError(TIMEOUT, [String(PROBE_TIMEOUT_S), RCLONE], 'job', 125_000, false)
      return orig(cmd, args, opts)
    }
    const job = await waitForJob(server, await accept(server, '/v1/cloud/remotes/test', {
      remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' } },
    }, READ_JOB_OPERATIONS.cloudRemoteTest))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'TIMEOUT')
    assert.match(job.error?.message ?? '', /did not finish within/)
    assert.ok(!JSON.stringify(job).includes('gtpass'), 'the hung-command sentence carries no secret')
  })
})

describe('cr.48 the PBS catalog listing as a job', () => {
  let server: Server
  let dir: string
  const marks: string[] = []
  const saved: Record<string, string | undefined> = {}
  const SNAP = 'host/gtrestore/2026-08-25T19:16:45Z'

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-readjobs-pbs-'))
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_STORAGE_CFG', join(dir, 'storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    await writeFile(join(dir, 'storage.cfg'), '')
    server = createServer({ mock: true, logger: false })
    const repo = {
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
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo, expectedVersion: 0 } })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)
  })

  afterEach(async () => {
    for (const m of marks.splice(0))
      reap(m)
    await server.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  const isShell = (args: string[]): boolean => args[1] === PBC && args[2] === 'catalog'
  const BODY = { repo: 'pbs-main', snapshot: SNAP, archive: 'data.pxar', path: '/' }

  it('accepted → the level rides job.result; the `ls` invocation carries the five-minute ceiling', async () => {
    mockOf(server).addFixture({ command: TIMEOUT, argsMatch: isShell, result: { stdout: '', stderr: 'Starting interactive shell\n', exitCode: 0 } })
    const job = await waitForJob(server, await accept(server, '/v1/backup/restore/browse', BODY, READ_JOB_OPERATIONS.backupCatalog))
    assert.equal(job.status, 'completed')
    const r = job.result as BackupBrowseResult
    assert.equal(r.verdict, 'ok')
    assert.equal(r.archiveKind, 'pxar')
    assert.deepEqual(r.entries, [])
    const call = mockOf(server).calls.find(c => c.command === TIMEOUT && isShell(c.args))
    assert.equal(call?.args[0], String(CATALOG_SHELL_TIMEOUT_S))
  })

  it('Cancel stops the REAL child\'s process group and ends the job cancelled', async () => {
    const mark = marker()
    marks.push(mark)
    const seen = realChild(mockOf(server), isShell, `sleep ${mark}; true`)
    const id = await accept(server, '/v1/backup/restore/browse', BODY, READ_JOB_OPERATIONS.backupCatalog)
    const { ms } = await cancelAndProve(server, id, mark, 'catalog')
    assert.ok(ms < READ_CANCEL_WAIT_MS, `the SIGTERM was enough (${ms} ms)`)
    // The `stat` invocation never ran: the cancel ended the level at its boundary.
    assert.equal(seen.length, 1, 'the `ls` shell is the only one; no `stat` followed')
    assert.equal(seen[0]![0], String(CATALOG_SHELL_TIMEOUT_S))
  })

  it('a cancel accepted while no child runs ends the level at the next boundary — the `stat` shell never starts', async () => {
    // The `ls` answers only after the cancel was accepted (no child to signal
    // in between: the hook accepts at once); its names would need a `stat`.
    const mock = mockOf(server)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scripts: string[] = []
    const orig = mock.exec.bind(mock)
    mock.exec = async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      if (cmd === TIMEOUT && isShell(args)) {
        scripts.push(String(opts?.stdin ?? ''))
        await gate
        return { stdout: 'alpha.txt\n', stderr: 'Starting interactive shell\n', exitCode: 0 }
      }
      return orig(cmd, args, opts)
    }
    const id = await accept(server, '/v1/backup/restore/browse', BODY, READ_JOB_OPERATIONS.backupCatalog)
    assert.ok(await until(() => scripts.length === 1, 2_000), 'the `ls` is in flight')
    const res = await server.inject({ method: 'POST', url: `/v1/jobs/${id}/cancel`, headers: IDENTITY })
    assert.equal(res.statusCode, 202, res.body)
    await new Promise(r => setTimeout(r, 30)) // the cancel job has run the hook
    release()
    const job = await waitForJob(server, id)
    assert.equal(job.status, 'cancelled')
    assert.equal(scripts.length, 1, 'only the `ls` ran; the cancel stopped the level before the `stat`')
    assert.match(scripts[0]!, /^ls /)
  })

  it('a child that IGNORES SIGTERM is ended by the group SIGKILL one wait later', async () => {
    const mark = marker()
    marks.push(mark)
    realChild(mockOf(server), isShell, `trap "" TERM; sleep ${mark}; true`)
    const id = await accept(server, '/v1/backup/restore/browse', BODY, READ_JOB_OPERATIONS.backupCatalog)
    const { ms } = await cancelAndProve(server, id, mark, 'catalog (TERM ignored)')
    assert.ok(ms >= READ_CANCEL_WAIT_MS - 100, `the SIGKILL came after the SIGTERM wait (${ms} ms)`)
  })

  it('failed: a PBS failure is a COMPLETED job carrying the verdict — the listing has no failed state of its own', async () => {
    // browseArchiveLevel reports every PBS-side outcome (and an executor
    // rejection) as a verdict; the read job ends `failed` only on a fault
    // outside it, which no input reaches.
    mockOf(server).addFixture({ command: TIMEOUT, argsMatch: isShell, result: { stdout: '', stderr: 'Error: no permissions on /datastore/anastest-store/gtrestore\n', exitCode: 255 } })
    const job = await waitForJob(server, await accept(server, '/v1/backup/restore/browse', BODY, READ_JOB_OPERATIONS.backupCatalog))
    assert.equal(job.status, 'completed')
    assert.equal((job.result as BackupBrowseResult).verdict, 'permission')
  })

  it('cr.48b: a pbc stderr line echoing the repo secret masks it in the level detail, the verdict unchanged', async () => {
    // The review's second proven leak: pbc echoes the repo password/token
    // secret in a generic failure line. The whole job record must not carry it.
    const mock = mockOf(server)
    mock.addFixture({
      command: TIMEOUT,
      argsMatch: isShell,
      result: { stdout: '', stderr: 'Error: proxmox-backup-client rejected token-secret-value\n', exitCode: 255 },
    })
    const job = await waitForJob(server, await accept(server, '/v1/backup/restore/browse', BODY, READ_JOB_OPERATIONS.backupCatalog))
    assert.equal(job.status, 'completed')
    const r = job.result as BackupBrowseResult
    assert.equal(r.verdict, 'error', 'the classifier still read the RAW text')
    assert.ok(r.detail?.includes('[secret]'), r.detail)
    assert.ok(!JSON.stringify(job).includes('token-secret-value'), 'no plain value anywhere in the job record')
  })
})
