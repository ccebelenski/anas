import { request as httpRequest } from 'node:https'
import { execFile } from 'node:child_process'
import type { AuthProvider, AuthUser } from '../types'

/**
 * PVE auth provider — validates PVEAuthCookie against localhost Proxmox API.
 *
 * ANAS is always accessed through the Proxmox UI, so the user already
 * has a valid PVEAuthCookie. We validate it on each request.
 */
export class PveAuthProvider implements AuthProvider {
  readonly name = 'pve'

  private pveHost: string
  private pvePort: number

  constructor(opts?: { host?: string; port?: number }) {
    this.pveHost = opts?.host ?? 'localhost'
    this.pvePort = opts?.port ?? 8006
  }

  async validateToken(cookie: string): Promise<AuthUser | null> {
    // Use the PVEAuthCookie to query the Proxmox API.
    // If the cookie is valid, PVE authenticates the request.
    const result = await this.pveRequest<{
      data?: Record<string, unknown>
    }>('/api2/json/access/permissions', cookie)

    if (!result?.data) return null

    // Extract username from the cookie itself.
    // PVEAuthCookie format: PVE:username@realm:timestamp::signature
    const username = this.extractUsername(cookie)
    if (!username) return null

    const uid = await this.resolveUid(username)
    return { name: username, uid }
  }

  /** Extract bare username from PVEAuthCookie value. */
  private extractUsername(cookie: string): string | null {
    // Format: PVE:user@realm:hex:...
    const match = cookie.match(/^PVE:([^@]+)@[^:]+:/)
    return match?.[1] ?? null
  }

  /** Resolve a username to a UID via id(1). */
  private resolveUid(username: string): Promise<number> {
    return new Promise((resolve) => {
      execFile('/usr/bin/id', ['-u', username], (err, stdout) => {
        if (err) {
          // Default to 0 (root) if we can't resolve — PVE users are admins
          resolve(0)
          return
        }
        const uid = parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(uid) ? 0 : uid)
      })
    })
  }

  private pveRequest<T>(path: string, cookie: string): Promise<T | null> {
    return new Promise((resolve) => {
      const req = httpRequest(
        {
          hostname: this.pveHost,
          port: this.pvePort,
          method: 'GET',
          path,
          headers: {
            accept: 'application/json',
            cookie: `PVEAuthCookie=${cookie}`,
          },
          rejectUnauthorized: false, // PVE uses self-signed certs
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            try {
              const data = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              ) as T
              resolve(res.statusCode === 200 ? data : null)
            } catch {
              resolve(null)
            }
          })
        },
      )

      req.on('error', () => resolve(null))
      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })
      req.end()
    })
  }

  /** Check if Proxmox API is reachable. */
  static async isAvailable(host = 'localhost', port = 8006): Promise<boolean> {
    return new Promise((resolve) => {
      const req = httpRequest(
        {
          hostname: host,
          port,
          method: 'GET',
          path: '/api2/json/version',
          rejectUnauthorized: false,
          timeout: 2000,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        },
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }
}
