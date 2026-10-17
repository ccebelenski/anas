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
 *
 * cr.52s-f F3 adds the ROLLBACK half: a failed create at a leaf THIS JOB
 * created rmdir's it through the opened parent (a pre-existing directory
 * survives untouched; the rmdir itself insists the leaf is empty), and only an
 * rmdir failure makes the sentence name the directory left behind instead of
 * "Nothing else was written". The rmdir fake rides the same `fsp` +
 * `syncBuiltinESMExports` seam the lstat flip uses.
 *
 * cr.52s-f F8 pins the rollback's OWN failure branches: a rollback umount
 * whose EXEC THROWS (spawn ENOENT — the executor rejecting) is a failed
 * rollback like any non-zero exit (STILL MOUNTED with the thrown reason, and
 * the credentials removal + leaf rmdir still run); the credentials `rm`
 * result feeds the sentence (REMOVED only when it was, else the file named
 * and left on disk); a `daemon-reload` failure after the written line names
 * the surviving state (mounted, line kept, units stale, what to run) instead
 * of the raw reload error; and a failed credentials WRITE runs INSIDE the
 * rollback try, so the leaf this job made goes too and the failure reports
 * through the same sentence. The write/rename seams ride the same fsp idiom.
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

  it('(F3) a failed mount at a NEW leaf removes the directory this job created — and the sentence stays exact', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: MOUNT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'newleaf')

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
    // The directory this job created is GONE (rmdir'd through the opened
    // parent, the leaf empty because nothing was ever mounted), so the closing
    // clause stays the exact one — the wrong-password create leaves nothing.
    assert.equal(await fsp.lstat(mp).then(() => true, () => false), false, 'the leaf this job created was removed again')
    assert.ok(job.error!.message.includes(`'${mp}' was created by this job and has been removed again`), job.error!.message)
    assert.ok(job.error!.message.includes('Nothing else was written (no /etc/fstab line)'), job.error!.message)
    assert.equal(await readFile(fstabPath, 'utf8'), '', 'no fstab line')
  })

  it('(F3) the same failure at an EXISTING empty directory leaves the directory standing', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: MOUNT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'preexisting')
    await mkdir(mp) // the operator's own empty directory

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
    // A directory that existed before the job is never the rollback's to
    // remove — the failed create still leaves it exactly as it found it.
    assert.equal(await fsp.lstat(mp).then(() => true, () => false), true, 'the pre-existing directory survives the rollback')
    assert.ok(!job.error!.message.includes('has been removed again'), job.error!.message)
    assert.ok(job.error!.message.includes('Nothing else was written (no /etc/fstab line)'), job.error!.message)
  })

  it('(F3) an rmdir failure names the directory left behind instead of the closing clause', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: MOUNT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'unremovable')

    // The seam: the rollback rmdirs the leaf at `/proc/self/fd/<parentFd>/unremovable`;
    // this fake answers exactly that call with EACCES (the shape a hostile or
    // mis-mounted parent gives). The same `fsp` patch + `syncBuiltinESMExports`
    // idiom the swap-race test above uses for lstat — the service's named
    // `rmdir` import sees it. Nothing else in this job calls rmdir.
    const real = fsp.rmdir
    const faked = async (p: Parameters<typeof fsp.rmdir>[0]): Promise<void> => {
      if (typeof p === 'string' && p.includes('/proc/self/fd/') && p.endsWith('/unremovable'))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      await real(p)
    }
    ;(fsp as unknown as { rmdir: unknown }).rmdir = faked
    syncBuiltinESMExports()
    try {
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
      // Instead of "Nothing else was written", the sentence NAMES the directory
      // left behind, with the failed reason — the operator removes it by hand.
      assert.ok(job.error!.message.includes(`The mountpoint directory '${mp}' was created by this job and its removal failed (EACCES)`), job.error!.message)
      assert.ok(job.error!.message.includes('it is left behind and must be removed by hand'), job.error!.message)
      assert.ok(!job.error!.message.includes('Nothing else was written'), job.error!.message)
      assert.ok(job.error!.message.includes('no /etc/fstab line was written'), job.error!.message)
    }
    finally {
      ;(fsp as unknown as { rmdir: unknown }).rmdir = real
      syncBuiltinESMExports()
    }
    // The real rmdir never ran — the directory is honestly there.
    assert.equal(await fsp.lstat(mp).then(() => true, () => false), true, 'the leaf is left behind, named in the sentence')
  })

  it('(F8a) a rollback umount whose exec THROWS is a failed rollback — STILL MOUNTED with the thrown reason, the removals still run', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // The rollback umount cannot even spawn (the binary absent — the shape of
    // the executor rejecting with spawn ENOENT, exactly the case that used to
    // escape the catch and take the credentials removal and the leaf rmdir
    // down with it).
    mock.prependFixture({ command: UMOUNT, throws: Object.assign(new Error('spawn /usr/bin/umount ENOENT'), { code: 'ENOENT' }) })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'umountthrows')

    // The failure being rolled back: the fstab WRITE after the successful
    // mount — seam: the atomic replace's rename refuses to land on the fstab
    // (the shape a read-only mount or a broken path gives). Nothing else in
    // the job renames onto the fstab path.
    const realRename = fsp.rename
    const fakedRename = async (from: string, to: string): Promise<void> => {
      if (to === fstabPath)
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      await realRename(from, to)
    }
    ;(fsp as unknown as { rename: unknown }).rename = fakedRename
    syncBuiltinESMExports()
    try {
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
      // The EXACT sentence: the failed line-write as the reason, the STILL
      // MOUNTED clause carrying the THROWN message (never the raw spawn error
      // escaping the catch), then the two removals — both still ran.
      assert.equal(job.error!.message, `Mount create '${mp}' failed — EACCES: permission denied; `
      + `'${mp}' was mounted by this job and the rollback unmount FAILED (spawn /usr/bin/umount ENOENT) — it is left MOUNTED and must be unmounted by hand; `
      + 'the credentials file was removed; '
      + `'${mp}' was created by this job and has been removed again. `
      + 'Nothing else was written (no /etc/fstab line)', JSON.stringify(job.error))
      // The argv: the rollback umount was attempted exactly once, on the path.
      const umounts = mock.calls.filter(c => c.command === UMOUNT)
      assert.equal(umounts.length, 1, 'the rollback attempted the umount once')
      assert.deepEqual(umounts[0]!.args, ['--', mp])
      // The state the sentence describes: no line (the rename never landed),
      // no credentials file, no leaf.
      assert.equal(await readFile(fstabPath, 'utf8'), '', 'no fstab line')
      assert.equal(await readFile(credsFilePath(credsDir, mp), 'utf8').catch(() => null), null, 'the credentials removal still ran')
      assert.equal(await fsp.lstat(mp).then(() => true, () => false), false, 'the leaf rmdir still ran')
    }
    finally {
      ;(fsp as unknown as { rename: unknown }).rename = realRename
      syncBuiltinESMExports()
    }
  })

  it('(F8b) a credentials removal that fails names the file left on disk instead of claiming removal', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: MOUNT, result: {
      stdout: '',
      stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (mount.cifs -h)\n',
      exitCode: 32,
    } })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'rmfails')
    const creds = credsFilePath(credsDir, mp)

    // The seam: exactly the rollback's `rm` of the credentials file fails
    // (EPERM — the shape a busy or pinned file gives); every other rm (the
    // atomic-writer temp unlink, the afterEach cleanup) is honest.
    const realRm = fsp.rm
    const fakedRm = async (p: Parameters<typeof fsp.rm>[0], opts?: Parameters<typeof fsp.rm>[1]): Promise<void> => {
      if (p === creds)
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      await realRm(p, opts as never)
    }
    ;(fsp as unknown as { rm: unknown }).rm = fakedRm
    syncBuiltinESMExports()
    try {
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
      // The sentence names the secret LEFT ON DISK with the reason — and never
      // claims it was removed.
      assert.ok(job.error!.message.includes(`the credentials file '${creds}' could not be removed (EPERM) and is left on disk`), job.error!.message)
      assert.ok(!job.error!.message.includes('the credentials file was removed'), job.error!.message)
      // The rest of the rollback still ran: leaf gone, no line, no umount
      // (the mount itself failed, so nothing was mounted).
      assert.ok(job.error!.message.includes(`'${mp}' was created by this job and has been removed again`), job.error!.message)
      assert.ok(job.error!.message.includes('Nothing else was written (no /etc/fstab line)'), job.error!.message)
      assert.equal(await readFile(fstabPath, 'utf8'), '', 'no fstab line')
      assert.equal(await fsp.lstat(mp).then(() => true, () => false), false, 'the leaf was removed')
      assert.ok(!mock.calls.some(c => c.command === UMOUNT), 'no rollback umount for a mount that never happened')
    }
    finally {
      ;(fsp as unknown as { rm: unknown }).rm = realRm
      syncBuiltinESMExports()
    }
    // The file is honestly still there (the fake rm never ran the unlink).
    assert.equal(await readFile(creds, 'utf8').then(() => true, () => false), true, 'the credentials file is left on disk, named in the sentence')
    await realRm(creds, { force: true }) // honest cleanup of the named secret
  })

  it('(F8c) a daemon-reload failure AFTER the written line names the surviving state — nothing rolled back', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // Exact args match — the fixture only answers `daemon-reload`, so the
    // argv is pinned by the match itself.
    mock.prependFixture({ command: '/usr/bin/systemctl', args: ['daemon-reload'], result: {
      stdout: '',
      stderr: 'Failed to reload daemon: too many concurrent reloads',
      exitCode: 1,
    } })
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'reloadfails')

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
    // The EXACT sentence (the documented decision stands — nothing rolls back;
    // only the sentence changes): the reload reason, then the surviving state
    // with what to run, then the no-rollback word. No raw reload error.
    assert.equal(job.error!.message, `Mount create '${mp}' failed — Failed to reload daemon: too many concurrent reloads; `
    + `the mount is up at '${mp}'; the line is written in ${fstabPath}; the credentials file '${credsFilePath(credsDir, mp)}' is in place; `
    + 'systemd\'s units are stale — run \'systemctl daemon-reload\'; nothing was rolled back', JSON.stringify(job.error))
    // The surviving state is honestly what the sentence says: the line IS in
    // the fstab, the credentials file stands, the leaf stands, and NOTHING
    // was unmounted or removed.
    const fstabAfter = await readFile(fstabPath, 'utf8')
    assert.equal(fstabAfter.split('\n').filter(l => l.includes(mp)).length, 1, `the written line survives: ${fstabAfter}`)
    assert.equal(await readFile(credsFilePath(credsDir, mp), 'utf8').then(() => true, () => false), true, 'the credentials file stands')
    assert.equal(await fsp.lstat(mp).then(() => true, () => false), true, 'the leaf stands')
    assert.ok(!mock.calls.some(c => c.command === UMOUNT), 'nothing was rolled back — no umount ran')
  })

  it('(F8d) a failed credentials WRITE still rolls back the leaf it made — same sentence, nothing else was written', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const parent = join(dir, 'parent')
    await mkdir(parent)
    const mp = join(parent, 'credwrite')

    // The seam: the credentials atomic write cannot open its temp in the
    // creds dir (EACCES — the shape a broken/mis-mounted creds dir gives).
    // Every other open (the mount pin, the fstab writer's temp under `dir`)
    // is honest.
    const realOpen = fsp.open
    const fakedOpen = async (p: Parameters<typeof fsp.open>[0], ...rest: unknown[]): Promise<unknown> => {
      if (typeof p === 'string' && p.startsWith(`${credsDir}/`))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return (realOpen as unknown as (...a: unknown[]) => unknown)(p, ...rest)
    }
    ;(fsp as unknown as { open: unknown }).open = fakedOpen
    syncBuiltinESMExports()
    try {
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
      // The write failure reports through the SAME sentence as any other
      // rollback (not a raw error over a stranded leaf): the leaf this job
      // made is gone, and the closing clause is the exact one.
      assert.ok(job.error!.message.includes('EACCES: permission denied'), job.error!.message)
      assert.ok(job.error!.message.includes(`'${mp}' was created by this job and has been removed again`), job.error!.message)
      assert.ok(job.error!.message.includes('Nothing else was written (no /etc/fstab line)'), job.error!.message)
      // The state: leaf gone, no line, no credentials file, and NOTHING ran
      // past the write — no mount attempt, no umount.
      assert.equal(await fsp.lstat(mp).then(() => true, () => false), false, 'the leaf this job created was removed again')
      assert.equal(await readFile(fstabPath, 'utf8'), '', 'no fstab line')
      assert.equal(await readFile(credsFilePath(credsDir, mp), 'utf8').catch(() => null), null, 'no credentials file')
      assert.ok(!mock.calls.some(c => c.command === MOUNT), 'the write failure precedes the mount — no mount argv ran')
      assert.ok(!mock.calls.some(c => c.command === UMOUNT), 'nothing was mounted — no umount ran')
    }
    finally {
      ;(fsp as unknown as { open: unknown }).open = realOpen
      syncBuiltinESMExports()
    }
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
