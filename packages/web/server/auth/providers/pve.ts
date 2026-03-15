import type { AuthProvider, AuthUser } from '../types'
import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:https'

/** PVEAuthCookie format: PVE:user@realm:hex:... */
const PVE_COOKIE_RE = /^PVE:([^@]+)@[^:]+:/

/** Cache TTL: 2 minutes. The cookie is signed by Proxmox, so a recently validated cookie is still valid. */
const CACHE_TTL_MS = 2 * 60 * 1000

interface CacheEntry {
  user: AuthUser
  expiresAt: number
}

/**
 * PVE auth provider — validates PVEAuthCookie against localhost Proxmox API.
 *
 * ANAS is always accessed through the Proxmox UI, so the user already
 * has a valid PVEAuthCookie. Validated results are cached briefly since
 * the cookie is HMAC-signed by Proxmox and can be trusted for the
 * cache duration.
 */
export class PveAuthProvider implements AuthProvider {
  readonly name = 'pve'

  private pveHost: string
  private pvePort: number
  private cache = new Map<string, CacheEntry>()

  constructor(opts?: { host?: string, port?: number }) {
    this.pveHost = opts?.host ?? 'localhost'
    this.pvePort = opts?.port ?? 8006
  }

  async validateToken(cookie: string): Promise<AuthUser | null> {
    // Check cache first
    const cached = this.cache.get(cookie)
    if (cached && cached.expiresAt > Date.now())
      return cached.user

    // Cache miss or expired — validate against Proxmox API
    const result = await this.pveRequest<{
      data?: Record<string, unknown>
    }>('/api2/json/access/permissions', cookie)

    if (!result?.data)
      return null

    // Extract username from the cookie itself
    const username = this.extractUsername(cookie)
    if (!username)
      return null

    const uid = await this.resolveUid(username)
    const user: AuthUser = { name: username, uid }

    // Cache the validated result
    this.cache.set(cookie, {
      user,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    return user
  }

  /** Extract bare username from PVEAuthCookie value. */
  private extractUsername(cookie: string): string | null {
    const match = cookie.match(PVE_COOKIE_RE)
    return match?.[1] ?? null
  }

  /** Resolve a username to a UID via id(1). Returns -1 for non-PAM realm users. */
  private resolveUid(username: string): Promise<number> {
    return new Promise((resolve) => {
      execFile('/usr/bin/id', ['-u', username], (err, stdout) => {
        if (err) {
          // User authenticated via PVE but has no system account
          // (e.g., @pve or @ldap realm). Use -1 for audit trail.
          console.warn(`[auth] Cannot resolve UID for '${username}' — non-PAM realm user?`)
          resolve(-1)
          return
        }
        const uid = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(uid) ? -1 : uid)
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
            }
            catch {
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
