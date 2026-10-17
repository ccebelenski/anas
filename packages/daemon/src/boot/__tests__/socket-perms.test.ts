import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The longest Unix-socket path Linux accepts (sockaddr_un.sun_path ≈ 108 bytes). */
const SOCK_PATH_SLACK = 24
const SOCK_MAX = 108 - SOCK_PATH_SLACK

/**
 * The anasd Unix socket IS the trust boundary (Principle 9): the daemon trusts
 * the X-Anas-* identity headers precisely because only local root can reach the
 * socket. That must not rest on the default umask — index.ts chmods the socket
 * to 0600 right after it starts listening. This boots the real daemon (mock
 * mode) on a throwaway socket and polls the mode until that chmod lands (the
 * socket exists from the moment of the bind, so a single stat races it).
 */
describe('anasd socket permissions', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/boot/__tests__ → src/index.ts
  const indexPath = join(here, '..', '..', 'index.ts')
  let dir: string
  let sockPath: string

  before(() => {
    // The harness runs tests with TMPDIR inside a deep worktree, whose
    // `join(tmpdir(), 'anasd-sock-')` alone would pass the Unix-socket length
    // cap — `listen` then answers EINVAL and the daemon dies before the chmod.
    // Fall back to /tmp (shorter than the cap on every Linux box ANAS runs) so
    // the socket path can never silently exceed it.
    const base = join(tmpdir(), 'anasd-sock-')
    dir = mkdtempSync(join(base.length < SOCK_MAX ? tmpdir() : '/tmp', 'anasd-sock-'))
    sockPath = join(dir, 'anasd.sock')
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is chmod 0600 (root-only) after the daemon starts listening', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', indexPath, '--mock'],
      { env: { ...process.env, ANASD_SOCKET: sockPath }, stdio: 'ignore' },
    )

    try {
      // listen() creates the socket at 0777 & ~umask (0755 under the usual
      // 0022) and the chmod lands a moment later, so waiting only for the path
      // to exist and stat'ing once races the chmod. Poll the MODE instead, to
      // the same ~10s deadline, and report the last mode seen on timeout.
      let st = statSync(sockPath, { throwIfNoEntry: false })
      for (let i = 0; i < 100 && (st === undefined || (st.mode & 0o777) !== 0o600); i++) {
        await new Promise(r => setTimeout(r, 100))
        st = statSync(sockPath, { throwIfNoEntry: false })
      }

      assert.ok(st, 'daemon should have created the socket')
      assert.ok(st.isSocket(), 'the path should be a unix socket')
      assert.equal(
        st.mode & 0o777,
        0o600,
        `socket must be root-only (0600); last observed 0${(st.mode & 0o777).toString(8)}`,
      )
    }
    finally {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => child.on('exit', () => resolve()))
    }
  })
})
