import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync, symlinkSync } from 'node:fs'
import fsp, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { credsFilePath } from '../../services/mounts.js'

/**
 * Story cr.52s-c (a): the remote-mount CREATE job creates its mountpoint
 * THROUGH THE OPENED PARENT (the O_PATH pin + readlink proof — never
 * `mkdir(recursive)` on a path a non-root user can re-point), and the MOUNT
 * runs before the fstab line is written: a refused or failed mount leaves no
 * line and no credentials file (what the create does write, it removes again
 * when a later step fails).
 *
 * The swap-race test (i) constructs the race deterministically: the job waits
 * in a full queue (the file `cr52-mount-targets.test.ts`'s paused-queue
 * idiom); when it starts, its re-gate walks the path with `lstat` — the test
 * flips the parent to a symlink to another REAL directory on the gate's first
 * lstat of it and hides the swap from exactly the two lstat calls that walk
 * makes (the `realLongestExistingAncestor` probe and the symlink walk — the
 * `fakeRootOwnedChain` idiom, same file), so the gate passes. What must refuse
 * now is the OPEN itself: `O_PATH | O_DIRECTORY | O_NOFOLLOW` cannot follow a
 * symlink, and only a syscall sees the truth — an argv through the fd, not a
 * string mkdir through the link. The fake is undone in a `finally`.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 80; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/**
 * Flip `parent` to a symlink to `victim` the first time the daemon lstats it,
 * and answer the next `hideCalls` lstats of it with the pre-flip directory
 * stat (the gate's walk: 2 calls for a missing leaf — see the file header),
 * then behave honestly again: the job's OPEN (unfakeable from JS) must see
 * the link. Returns the undo.
 */
function flipOnNextLstat(parent: string, victim: string, hideCalls = 2): () => void {
  const real = fsp.lstat
  let hidden = hideCalls
  let captured: Awaited<ReturnType<typeof fsp.lstat>> | undefined
  const faked = async (p: Parameters<typeof fsp.lstat>[0], opts?: Parameters<typeof fsp.lstat>[1]): Promise<unknown> => {
    if (p === parent && hidden > 0) {
      // The FIRST call: capture the real directory stat, then swap the path
      // under it. EVERY call the gate's walk makes answers with the captured
      // stat (a re-stat would read the link and give the gate away).
      if (captured === undefined) {
        captured = await real(p, opts as never)
        rmSync(parent, { recursive: true })
        symlinkSync(victim, parent)
      }
      hidden -= 1
      return captured
    }
    return real(p, opts as never)
  }
  ;(fsp as unknown as { lstat: unknown }).lstat = faked
  syncBuiltinESMExports()
  return () => {
    ;(fsp as unknown as { lstat: unknown }).lstat = real
    syncBuiltinESMExports()
  }
}

describe('cr.52s-c (a) — the create job pins its parent, mounts before the line, leaves nothing behind', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let fstabPath: string
  let credsDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr52c-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, '')
    credsDir = join(dir, 'creds')
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = credsDir
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage.cfg')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    await rm(dir, { recursive: true, force: true })
  })

  const create = (payload: Record<string, unknown>) => server!.inject({
    method: 'POST',
    url: '/v1/mounts',
    headers: JSON_HEADERS,
    payload: JSON.stringify(payload),
  })

  it('(i) a parent swapped for a symlink between the job\'s re-gate and the mkdir creates nothing through the link, no line, no credentials file', async () => {
    server = createServer({ mock: true, logger: false })
    const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
    const parent = join(dir, 'parent')
    const victim = join(dir, 'victim')
    await mkdir(parent)
    await mkdir(victim)
    const mp = join(parent, 'data')

    // Hold the four queue slots so the accepted create sits QUEUED; the route's
    // own gates have already run against the real parent.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

    const res = await create({
      type: 'cifs',
      server: 'nas.example.com',
      remotePath: 'media',
      mountpoint: mp,
      persistent: true,
      mountNow: true,
      credentials: { username: 'smbuser', password: 's3cret' },
    })
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue.get(id)?.status, 'queued', 'the create waits behind the held slots')

    // Arm the flip, then let the job run: its re-gate's FIRST lstat of the
    // parent swaps it for a link to `victim`; the gate (two hidden lstats)
    // passes; the create's OPEN must refuse.
    const undo = flipOnNextLstat(parent, victim)
    release()
    try {
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed', JSON.stringify(job))
      // The refusal sentence, as the job carries it:
      assert.match(job.error!.message, /cannot be created/, JSON.stringify(job.error))
      assert.match(job.error!.message, /is a symlink/)
      assert.ok(job.error!.message.includes(parent), `names the swapped parent: ${job.error!.message}`)

      // NOTHING was created through the link, and nothing was written. (The
      // fake lstat is already undone — these reads see the real filesystem.)
      assert.equal(await fsp.lstat(join(victim, 'data')).then(() => true, () => false), false, 'no leaf through the planted symlink')
      assert.equal(await readFile(fstabPath, 'utf8'), '', 'no fstab line')
      assert.deepEqual(await readFile(credsFilePath(credsDir, mp), 'utf8').catch(() => null), null, 'no credentials file')
    }
    finally {
      undo()
    }
  })

  it('(ii) a failed mount (exit 32) leaves no fstab line and no credentials file', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // The captured stderr shape from this suite's mount probes (mounts.test.ts,
    // the cr.60 probe tests): mount.cifs' Permission denied line + the man-page
    // pointer, exit 32.
    mock.prependFixture({ command: MOUNT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'mountfail-cifs')

    const res = await create({
      type: 'cifs',
      server: 'nas.example.com',
      remotePath: 'media',
      mountpoint: mp,
      persistent: true,
      mountNow: true,
      credentials: { username: 'smbuser', password: 's3cret' },
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.match(job.error!.message, /mount error\(13\): Permission denied/, JSON.stringify(job.error))
    // Nothing that could outlive the failed mount: no line, no secret. The
    // credentials file was written for the mount and the rollback removed it.
    assert.equal(await readFile(fstabPath, 'utf8'), '', 'no fstab line behind the failed mount')
    assert.equal(await readFile(credsFilePath(credsDir, mp), 'utf8').catch(() => null), null, 'no credentials file behind the failed mount')
    // Nothing was unmounted — nothing was ever mounted (the mount itself failed).
    assert.ok(!mock.calls.some(c => c.command === UMOUNT), 'no rollback umount for a mount that never happened')
  })

  it('(iii) the happy path mounts through the fd BEFORE the line exists; then the line is written', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'happy')
    // What the world looked like AT the mount argv: the line must be absent
    // then (mount before the write), the credentials file present (mount.cifs
    // reads it at mount time).
    let fstabAtMount: string | undefined
    let credsAtMount: boolean | undefined
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[], opts?: Parameters<typeof orig>[2]): Promise<ExecResult> => {
      if (command === MOUNT) {
        fstabAtMount = await readFile(fstabPath, 'utf8')
        credsAtMount = await readFile(credsFilePath(credsDir, mp), 'utf8').then(() => true, () => false)
      }
      return orig(command, args, opts)
    }

    const res = await create({
      type: 'cifs',
      server: 'nas.example.com',
      remotePath: 'media',
      mountpoint: mp,
      persistent: true,
      mountNow: true,
      credentials: { username: 'smbuser', password: 's3cret' },
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const mountCall = mock.calls.find(c => c.command === MOUNT)
    assert.ok(mountCall, 'the create ran the mount argv')
    assert.equal(mountCall!.args.at(-1), '/proc/self/fd/3/.', 'the mount targets the fd-pinned directory (argv unchanged)')
    assert.equal(mountCall!.fdPaths?.[0], mp, 'the fd resolves to the created mountpoint')
    assert.equal(fstabAtMount, '', 'the fstab line did not exist when the mount ran — the mount comes FIRST')
    assert.equal(credsAtMount, true, 'the credentials file existed when the mount ran (mount.cifs reads it at mount time)')
    const fstabAfter = await readFile(fstabPath, 'utf8')
    assert.equal(fstabAfter.split('\n').filter(l => l.includes(mp)).length, 1, `exactly one line for the mountpoint: ${fstabAfter}`)
    assert.match(fstabAfter, new RegExp(`//nas\\.example\\.com/media ${mp} cifs`))
    assert.equal(await readFile(credsFilePath(credsDir, mp), 'utf8').then(t => t.includes('username=smbuser')), true, 'the credentials file remains for the completed create')
  })

  it('a missing parent is refused naming it — no chain is created', async () => {
    server = createServer({ mock: true, logger: false })
    const mp = join(dir, 'no-such-parent', 'data')
    const res = await create({
      type: 'nfs',
      server: '127.0.0.1',
      remotePath: '/export',
      mountpoint: mp,
      persistent: false,
      mountNow: true,
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.match(job.error!.message, /parent .* does not exist/, JSON.stringify(job.error))
    const { lstat } = await import('node:fs/promises')
    assert.equal(await lstat(join(dir, 'no-such-parent')).then(() => true, () => false), false, 'the missing parent was NOT created')
  })
})
