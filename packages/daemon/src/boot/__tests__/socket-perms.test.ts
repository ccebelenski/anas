import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The anasd Unix socket IS the trust boundary (Principle 9): the daemon trusts
 * the X-Anas-* identity headers precisely because only local root can reach the
 * socket. That must not rest on the default umask — index.ts chmods the socket
 * to 0600 right after it starts listening. This boots the real daemon (mock
 * mode) on a throwaway socket and asserts the mode.
 */
describe('anasd socket permissions', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/boot/__tests__ → src/index.ts
  const indexPath = join(here, '..', '..', 'index.ts')
  let dir: string
  let sockPath: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'anasd-sock-'))
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
      // Wait (up to ~10s) for the socket to appear.
      for (let i = 0; i < 100 && !existsSync(sockPath); i++)
        await new Promise(r => setTimeout(r, 100))

      assert.ok(existsSync(sockPath), 'daemon should have created the socket')
      const st = statSync(sockPath)
      assert.ok(st.isSocket(), 'the path should be a unix socket')
      assert.equal(st.mode & 0o777, 0o600, 'socket must be root-only (0600)')
    }
    finally {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => child.on('exit', () => resolve()))
    }
  })
})
