import { request as httpRequest } from 'node:https'
import type { AuthProvider, AuthUser, LoginCredentials } from '../types'

/**
 * PVE auth provider — validates against the local Proxmox API.
 *
 * Two auth paths:
 * 1. Token validation: validates an existing PVEAuthCookie against
 *    localhost:8006 (for users coming from Proxmox UI).
 * 2. Credential auth: authenticates username/password against Proxmox
 *    API (for standalone login when PVE is available).
 */
export class PveAuthProvider implements AuthProvider {
  readonly name = 'pve'

  private pveHost: string
  private pvePort: number

  constructor(opts?: { host?: string; port?: number }) {
    this.pveHost = opts?.host ?? 'localhost'
    this.pvePort = opts?.port ?? 8006
  }

  async authenticate(credentials: LoginCredentials): Promise<AuthUser | null> {
    const { username, password } = credentials

    // Authenticate against PVE API
    const result = await this.pveRequest<{
      data?: { ticket?: string; username?: string }
    }>('POST', '/api2/json/access/ticket', {
      username: username.includes('@') ? username : `${username}@pam`,
      password,
    })

    if (!result?.data?.username) return null

    // Extract the bare username (strip @realm)
    const name = result.data.username.split('@')[0]!
    const uid = await this.resolveUid(name)

    return { name, uid }
  }

  async validateToken(cookie: string): Promise<AuthUser | null> {
    // Use the PVEAuthCookie to query the current user's access permissions.
    // If the cookie is valid, PVE returns the user info.
    const result = await this.pveRequest<{
      data?: { user?: string }
    }>('GET', '/api2/json/access/permissions', undefined, cookie)

    if (!result?.data?.user) return null

    const name = result.data.user.split('@')[0]!
    const uid = await this.resolveUid(name)

    return { name, uid }
  }

  /** Resolve a username to a UID via /etc/passwd. */
  private resolveUid(username: string): Promise<number> {
    return new Promise((resolve) => {
      const { execFile } = require('node:child_process')
      execFile('/usr/bin/id', ['-u', username], (err: Error | null, stdout: string) => {
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

  private pveRequest<T>(
    method: string,
    path: string,
    body?: Record<string, string>,
    cookie?: string,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {
        accept: 'application/json',
      }

      if (cookie) {
        headers.cookie = `PVEAuthCookie=${cookie}`
      }

      let bodyStr: string | undefined
      if (body) {
        bodyStr = new URLSearchParams(body).toString()
        headers['content-type'] = 'application/x-www-form-urlencoded'
        headers['content-length'] = String(Buffer.byteLength(bodyStr))
      }

      const req = httpRequest(
        {
          hostname: this.pveHost,
          port: this.pvePort,
          method,
          path,
          headers,
          rejectUnauthorized: false, // PVE uses self-signed certs
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
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

      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  }

  /** Check if Proxmox API is reachable. Used for auto-detection at startup. */
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
