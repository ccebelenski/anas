import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../mock.js'
import { ProdExecutor } from '../prod.js'
import type { ExecStreamOptions } from '../types.js'

/**
 * `ProdExecutor.execToStream` — REAL processes, real file descriptors.
 *
 * This is the primitive story backup2.7 rests on, so it is exercised against
 * the actual OS rather than a mock: `proxmox-backup-client restore` REFUSES
 * every existing target (GT-39), and the only way past that is for ANAS to open
 * the destination itself and take the archive on stdout. If the open flags, the
 * byte count or the fsync are wrong here, a LUN restore is wrong on the wire.
 *
 * A block device cannot be created in a test, so the device half is proven by
 * the FLAGS (no `O_CREAT`, no `O_TRUNC`) rather than by a device node.
 */

const PRINTF = '/usr/bin/printf'
const CAT = '/usr/bin/cat'
const FALSE = '/usr/bin/false'
const ENV = '/usr/bin/env'
const SH = '/bin/sh'

describe('ProdExecutor.execToStream (real processes, real fds)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-exec-stream-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('streams stdout into the target file and reports the bytes written', async () => {
    const exec = new ProdExecutor()
    const path = join(dir, 'out.raw')
    const r = await exec.execToStream(PRINTF, ['hello world'], { path, flags: 'w' })
    assert.equal(r.exitCode, 0)
    assert.equal(r.bytesWritten, 11)
    assert.equal(await readFile(path, 'utf-8'), 'hello world')
  })

  it('the child can open /dev/stdout BY PATH — the pbc `-` target (live-proof wave 2)', async () => {
    // `proxmox-backup-client restore … -` does not write to fd 1: it OPENS
    // `/dev/stdout`. libuv backs a `'pipe'` stdio slot with a socketpair(2), and
    // reopening a socket through /proc/self/fd fails with ENXIO — live on the
    // stunt node EVERY image restore died with
    //   Error: unable to open /dev/stdout - No such device or address (os error 6)
    // before a single byte was written. Handing the child our real descriptor as
    // fd 1 is what makes the redirect the ground truth used work here too.
    const exec = new ProdExecutor()
    const path = join(dir, 'viapath.raw')
    const r = await exec.execToStream(SH, ['-c', 'printf IMAGE-BYTES > /dev/stdout'], { path, flags: 'w' })
    assert.equal(r.exitCode, 0)
    assert.equal(r.stderr, '')
    assert.equal(await readFile(path, 'utf-8'), 'IMAGE-BYTES')
    // And the honest consequence: a child that REOPENS /dev/stdout gets its own
    // file description, so the offset of the descriptor ANAS holds never moves.
    // `imageBytesWritten` (services/backup-restore.ts) is what turns the
    // client's own progress into the byte evidence in that case.
    assert.equal(r.bytesWritten, 0)
  })

  it('`w` rewrites an existing file IN PLACE — the inode is kept', async () => {
    // This is the whole reason a file-backed LUN needs no backstore recreate:
    // LIO keeps pointing at the same object, so the serial and the attributes
    // are never at risk (unlike `resizeFileLun`, which must replay both).
    const exec = new ProdExecutor()
    const path = join(dir, 'lun.raw')
    await writeFile(path, 'PREEXISTING-CONTENT-XXXX')
    const before = await stat(path)

    const r = await exec.execToStream(PRINTF, ['NEW-IMAGE-CONTENT-YYYYYY'], { path, flags: 'w' })
    assert.equal(r.exitCode, 0)
    const after = await stat(path)
    assert.equal(after.ino, before.ino, 'the inode changed — the file was replaced, not rewritten')
    assert.equal(await readFile(path, 'utf-8'), 'NEW-IMAGE-CONTENT-YYYYYY')
  })

  it('O_WRONLY (the device flags) does NOT create a missing target', async () => {
    // The device branch's safety property: if the zvol node has gone, the
    // restore must fail loudly, never quietly create a regular file where a
    // block device belonged.
    const exec = new ProdExecutor()
    const path = join(dir, 'absent.raw')
    await assert.rejects(
      exec.execToStream(PRINTF, ['x'], { path, flags: constants.O_WRONLY }),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
    )
  })

  it('O_WRONLY does not truncate — the tail past the written bytes survives', async () => {
    // On a block device a truncate is meaningless; the flags say so, and this
    // proves the flags behave that way on a regular file too. (It is also why
    // the size-equality pre-check is not optional: a short image would leave
    // exactly this kind of stale tail on a real LUN, GT-42.)
    const exec = new ProdExecutor()
    const path = join(dir, 'device-like.raw')
    await writeFile(path, 'AAAAAAAAAABBBBBBBBBB')
    const r = await exec.execToStream(PRINTF, ['ZZZZZ'], { path, flags: constants.O_WRONLY })
    assert.equal(r.exitCode, 0)
    assert.equal(r.bytesWritten, 5)
    assert.equal(await readFile(path, 'utf-8'), 'ZZZZZAAAAABBBBBBBBBB')
  })

  it('captures stderr and streams it to onStderr as it arrives', async () => {
    const exec = new ProdExecutor()
    const path = join(dir, 'out.raw')
    const chunks: string[] = []
    // `cat` of a missing file writes to stderr and exits non-zero.
    const r = await exec.execToStream(CAT, ['/no/such/file/xyz'], { path, flags: 'w' }, {
      onStderr: c => chunks.push(c),
    })
    assert.notEqual(r.exitCode, 0)
    assert.ok(r.stderr.trim().length > 0)
    assert.equal(chunks.join(''), r.stderr)
  })

  it('reports a non-zero exit with zero bytes written — nothing reached the target', async () => {
    const exec = new ProdExecutor()
    const path = join(dir, 'out.raw')
    const r = await exec.execToStream(FALSE, [], { path, flags: 'w' })
    assert.equal(r.exitCode, 1)
    assert.equal(r.bytesWritten, 0)
  })

  it('passes secret env to the child and NEVER to argv', async () => {
    const exec = new ProdExecutor()
    const path = join(dir, 'env.txt')
    const r = await exec.execToStream(ENV, [], { path, flags: 'w' }, {
      env: { PBS_PASSWORD: 'super-secret', PBS_REPOSITORY: 'user@host:8007:store' },
    })
    assert.equal(r.exitCode, 0)
    const seen = await readFile(path, 'utf-8')
    assert.match(seen, /^PBS_PASSWORD=super-secret$/m)
    assert.match(seen, /^PBS_REPOSITORY=user@host:8007:store$/m)
  })

  it('rejects when the command cannot start, rather than reporting a fake exit', async () => {
    const exec = new ProdExecutor()
    await assert.rejects(
      exec.execToStream('/no/such/binary/xyz', [], { path: join(dir, 'out.raw'), flags: 'w' }),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
    )
  })

  it('carries the SIGNAL NAME of a killed child through (D5)', async () => {
    // A signal death has no exit code, so the plain 1 it is reported as says
    // nothing about HOW the child ended. `kill -9 $$` is the honest stand-in
    // for a killed pbc: progress on stderr, no error, SIGKILL.
    const exec = new ProdExecutor()
    const r = await exec.execToStream(SH, ['-c', 'kill -9 $$'], { path: join(dir, 'out.raw'), flags: 'w' })
    assert.equal(r.exitCode, 1)
    assert.equal(r.signal, 'SIGKILL')
    assert.equal(r.bytesWritten, 0)
  })
})

describe('MockExecutor.execToStream (fixture resolution mirrors exec)', () => {
  it('a command-only fixture registered FIRST does not shadow a later specific one', async () => {
    // exec() resolves fixtures in two passes — exact command+args first, then
    // the command-only fallback. execToStream matched in registration order,
    // so a catch-all registered early silently won over a specific fixture
    // registered after it and the test exercised the wrong result. Same
    // two-pass rule now applies here (D8, REMEDIATION-0.3.1).
    const exec = new MockExecutor()
    exec.addStreamFixture({
      command: '/usr/bin/dd',
      result: { stderr: 'catch-all', exitCode: 0, bytesWritten: 0 },
    })
    exec.addStreamFixture({
      command: '/usr/bin/dd',
      args: ['if=image.raw', 'of=/dev/vg0/lun0'],
      result: { stderr: 'specific', exitCode: 0, bytesWritten: 42 },
    })

    const r = await exec.execToStream(
      '/usr/bin/dd',
      ['if=image.raw', 'of=/dev/vg0/lun0'],
      { path: '/tmp/unused', flags: 'w' },
    )
    assert.equal(r.stderr, 'specific')
    assert.equal(r.bytesWritten, 42)
  })

  it('a fixture replaying a KILLED child carries the signal name through (D5)', async () => {
    const exec = new MockExecutor()
    exec.addStreamFixture({
      command: '/usr/bin/pbc',
      result: { stderr: 'progress 22% (55.0 MiB of 250.0 MiB in 16s)\r', exitCode: 1, bytesWritten: 1000, signal: 'SIGKILL' },
    })
    const r = await exec.execToStream('/usr/bin/pbc', [], { path: '/tmp/unused', flags: 'w' })
    assert.equal(r.signal, 'SIGKILL')
  })

  it('stdin is NOT a stream option — a secret-via-stdin caller cannot compile (D6)', async () => {
    // `execToStream` starts the child with `stdio: ['ignore', …]`: nothing can
    // be fed to its stdin, so advertising the inherited option was a lie a
    // future secret-via-stdin caller would have hit silently. The option is
    // omitted from ExecStreamOptions, and the `@ts-expect-error` below is the
    // compile-time proof — on the OLD interface (stdin still inherited) this
    // file does not compile, because the expectation is then unused.
    const exec = new MockExecutor()
    exec.addStreamFixture({
      command: '/usr/bin/dd',
      result: { stderr: '', exitCode: 0, bytesWritten: 0 },
    })
    const opts: ExecStreamOptions = {
      // @ts-expect-error stdin is deliberately omitted from ExecStreamOptions (D6)
      stdin: 'a-secret-that-must-not-be-silently-ignored',
    }
    const r = await exec.execToStream('/usr/bin/dd', [], { path: '/tmp/unused', flags: 'w' }, opts)
    assert.equal(r.exitCode, 0)
  })
})
