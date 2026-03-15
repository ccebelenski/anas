import { execFile } from 'node:child_process'
import type { AuthProvider, AuthUser, LoginCredentials } from '../types'

/**
 * PAM auth provider — authenticates against system credentials.
 *
 * Uses `su -c true <username>` with the provided password to validate
 * credentials via PAM without requiring a native PAM binding.
 * User UID is resolved from /etc/passwd via `id -u`.
 */
export class PamAuthProvider implements AuthProvider {
  readonly name = 'pam'

  async authenticate(credentials: LoginCredentials): Promise<AuthUser | null> {
    const { username, password } = credentials

    const valid = await this.validatePam(username, password)
    if (!valid) return null

    const uid = await this.getUid(username)
    if (uid === null) return null

    return { name: username, uid }
  }

  private validatePam(username: string, password: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Use su to validate credentials via PAM.
      // su reads password from stdin when not on a terminal.
      const child = execFile(
        '/usr/bin/su',
        ['-c', 'true', '--', username],
        { timeout: 5000 },
        (err) => {
          resolve(!err)
        },
      )
      // Write password to stdin and close
      child.stdin?.write(password + '\n')
      child.stdin?.end()
    })
  }

  private getUid(username: string): Promise<number | null> {
    return new Promise((resolve) => {
      execFile('/usr/bin/id', ['-u', username], (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const uid = parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(uid) ? null : uid)
      })
    })
  }
}
